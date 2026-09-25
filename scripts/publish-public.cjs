#!/usr/bin/env node
// scripts/publish-public.cjs -- zero-dependency exporter: private `main` -> free-tier `public` branch.
//
// AxMem's single source of truth is this private repo (remote `dev`). The free/open-core tier is a
// mechanical export of `main`'s tree, driven entirely by publish.manifest.json (exclude / addFiles /
// overlays / replacements / sanitize). This script never edits the manifest or the overlay/patch
// content it reads -- it only applies them. See publish.manifest.json's own comments for WHY each
// path is excluded or transformed (reverse-engineered from the diff between origin/main @ 592c4c3 and
// pre-cut-release @ b862900, 2026-09-24).
//
// Usage:
//   node scripts/publish-public.cjs             # export + 3 gates + commit onto local `public` (no push)
//   node scripts/publish-public.cjs --push       # same, then `git push origin public:main`
//   node scripts/publish-public.cjs --orphan     # commit as a fresh parentless commit (see manifest's
//                                                 # "history" field -- "orphan" is the standing default,
//                                                 # so this flag is rarely needed explicitly)
//
// Discipline: this script must never read/write the real $HOME/.claude tree. Gate 2 (install-layout
// self-test) always runs under HOME=USERPROFILE=PMM_HOME=<a fresh mkdtemp>, never the real profile.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'publish.manifest.json');

function log(msg) { process.stdout.write('[publish-public] ' + msg + '\n'); }
// MED fix (review OPUS-2026-09-25-c05-w5-w10-review.md §7, crash safety): this used to call
// process.exit(1) directly, which -- unlike throwing -- does NOT run pending try/finally blocks. Every
// gate failure in main() goes through die(), so main()'s own `finally { rmrf(exportDir) }` (now
// rmrfRetrying, see below) was being skipped on every single one of those paths; confirmed in practice
// during this fix (2 of 7 stale `axmem-publish-src-*` directories found on this machine still held the
// full un-excluded `.__archive.tar`, i.e. died before step2 could even run, let alone cleanup).
// die() now throws a tagged Error instead; main() is invoked through a thin wrapper at the bottom of
// this file that lets the throw unwind through main()'s try/finally (running cleanup) before setting
// the process exit code.
function die(msg) {
  process.stderr.write('[publish-public] FATAL: ' + msg + '\n');
  const err = new Error(msg);
  err.__axmemDie = true;
  throw err;
}

function readManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw);
}

function git(args, opts) {
  // -c core.autocrlf=false: git blobs in this repo are stored LF-only; `git archive` (unlike `git
  // show`) otherwise honors a machine-local core.autocrlf=true and would silently convert every line
  // ending to CRLF on export, corrupting every find/replace/overlay byte-comparison against the
  // LF-stored blobs of both this commit and origin/main.
  const fullArgs = ['-c', 'core.autocrlf=false'].concat(args);
  return execFileSync('git', fullArgs, Object.assign({ cwd: REPO_ROOT, encoding: 'utf8' }, opts || {}));
}

// ---------------------------------------------------------------------------------------------
// tiny glob: '**' -> any depth (incl. '/'), '*' -> one path segment (no '/'). Anchored, case-sensitive,
// matched against forward-slash-normalized paths relative to the export root.
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
      if (pattern[i + 1] === '/') i++; // '**/' also matches zero directories
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function isCommentEntry(x) {
  return typeof x === 'string' && x.indexOf('_comment') === 0;
}

function matchesAny(relPath, patterns) {
  return patterns.some((p) => globToRegExp(p).test(relPath));
}

// ---------------------------------------------------------------------------------------------
function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walk(abs, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

function rmrf(p) {
  // Best-effort, single-attempt cleanup for this script's OWN internal throwaway temp dirs (gate2's
  // tempHome, gate3's tempHome, treeHashOfDir's index dir) -- none of these ever hold excluded/
  // paid-tier content (gate2/gate3 copy only the ALREADY-filtered exportDir's guards/ or run npm
  // against the already-filtered exportDir tree), so a rare leftover from one of these is not a
  // sensitive-data leak, just tmpdir clutter. The two crash-safety-sensitive sites -- step0's startup
  // sweep and main()'s final cleanup of exportDir itself, the one directory that (pre-fix) briefly
  // held un-excluded content -- use rmrfRetrying below instead.
  fs.rmSync(p, { recursive: true, force: true });
}

const TEMP_PREFIX = 'axmem-publish-';

function syncSleepMs(ms) {
  // Synchronous backoff between cleanup retries. main() is otherwise entirely synchronous (no promises/
  // timers in flight), so a blocking wait here is simpler and safer than restructuring the whole script
  // around async retry logic just for this.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// MED fix (review §7): a bare fs.rmSync({force:true}) swallows ENOENT but NOT a Windows EPERM/EBUSY
// (e.g. an antivirus scanner or another process still has a handle open under the directory just
// extracted here) -- on failure the exportDir, which briefly held the exported tree, was simply left
// on disk with no retry and no clear signal. Retries with a short backoff, and returns a result object
// instead of throwing, so the caller can report cleanup success/failure SEPARATELY from export
// success/failure rather than letting one clobber the other in the exit code / log output.
function rmrfRetrying(p, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      if (!fs.existsSync(p)) return { ok: true, attempts: attempt };
      lastErr = new Error('path still present after rmSync reported success: ' + p);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < maxAttempts) syncSleepMs(attempt * 500); // 500ms, then 1000ms
  }
  return { ok: false, attempts: maxAttempts, error: lastErr };
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// MED fix (review §7): startup crash-safety sweep. An interrupted prior run (killed process, die()'s
// old process.exit() path which used to bypass try/finally entirely -- see die()'s comment above --
// a Windows EPERM on cleanup, ...) can leave an `axmem-publish-*` mkdtemp directory behind under
// os.tmpdir(). Confirmed in practice on this machine while investigating this fix: 7 leftover
// `axmem-publish-src-*` directories, 2 of which still held `.__archive.tar` -- the FULL un-excluded
// private tree (paid-tier source, NORTH-STAR.md, real usernames), because the old step1 archived
// everything and excluded only after extraction. step1 below now archives an already-filtered file
// list so a fresh run's own directory never holds excluded content even transiently, but leftovers
// from OLDER (pre-fix) interrupted runs can still be sitting on disk. Sweep them on every startup so
// they do not accumulate indefinitely. Scope is deliberately narrow: only entries directly under
// os.tmpdir() whose name starts with THIS script's own mkdtemp prefix (never a generic temp wipe), and
// only ones at least 10 minutes old, so a genuinely concurrent sibling invocation's own in-progress
// directory is never touched.
function step0_cleanupStaleTemp() {
  const root = os.tmpdir();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const STALE_MS = 10 * 60 * 1000;
  const now = Date.now();
  let removed = 0, failed = 0;
  for (const entry of entries) {
    if (entry.name.indexOf(TEMP_PREFIX) !== 0) continue;
    const abs = path.join(root, entry.name);
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; } // vanished between readdir and stat -- fine
    if (now - st.mtimeMs < STALE_MS) continue; // too fresh -- may be a sibling run in progress
    const res = rmrfRetrying(abs, 3);
    if (res.ok) removed++;
    else { failed++; log('WARNING: startup cleanup could not remove stale temp entry ' + abs + ' -- ' + (res.error && res.error.message)); }
  }
  if (removed || failed) {
    log('startup cleanup: removed ' + removed + ' stale `' + TEMP_PREFIX + '*` temp entr(ies)' + (failed ? (', ' + failed + ' FAILED (see warnings above -- remove by hand)') : '') + ' from ' + root);
  }
}

function excludeConfig(manifest) {
  return {
    patterns: (manifest.exclude || []).filter((p) => !isCommentEntry(p)),
    exceptions: (manifest.excludeExceptions || []).filter((p) => !isCommentEntry(p)),
  };
}

function step1_archiveMainToTemp(manifest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX + 'src-'));
  log('exporting `main` tree via git archive -> ' + tmp);
  // MED fix (review §7): archive ONLY the files that will survive step2's exclude filter -- computed
  // here via `git ls-tree` plus the EXACT SAME matchesAny(exclude)/matchesAny(excludeExceptions) logic
  // step2 applies, via the shared excludeConfig() helper -- instead of archiving the full private tree
  // (including paid-tier/excluded source) and excluding only after extraction. Previously, excluded
  // content existed in plaintext on disk (inside `.__archive.tar`, and then as real extracted files)
  // for the whole window between this function and step2; a process death in that window left the
  // plaintext paid-tier content behind in a leftover temp dir (see step0's comment for the confirmed
  // evidence). Filtering at archive time means the tar this script ever writes to disk never contains
  // excluded content in the first place, so an interruption at ANY point after this function returns
  // cannot leak it. step2 still runs afterward as a redundant safety net (it should now always report
  // removed=0) rather than being deleted outright, so a bug in this filter fails closed -- ships
  // nothing extra rather than silently sending paid-tier files to `public` -- instead of failing open.
  //
  // (Tried first and rejected: `git archive -- . ':(exclude,glob)<pattern>' ...`, i.e. pathspec
  // exclusion at the git-archive call itself. Verified empirically that git pathspec exclude/include
  // sets do NOT support "re-including" a single file inside an otherwise-excluded glob regardless of
  // pathspec order -- manifest.excludeExceptions' one entry, guards/fixtures/v3/trigger-write-gate-
  // probe.cjs, was dropped by every pathspec ordering tried. Resolving the file list in JS first, via
  // the shared exclude/exception matcher, then handing `git archive` a literal list of exact paths
  // (no glob semantics needed at the git layer at all) avoids that gap entirely and was verified
  // byte-for-byte identical to the old archive-then-exclude file set.)
  const { patterns, exceptions } = excludeConfig(manifest);
  const lsOut = git(['ls-tree', '-r', '--name-only', '-z', 'main']);
  const allFiles = lsOut.split('\0').filter(Boolean);
  const keep = allFiles.filter((rel) => !(matchesAny(rel, patterns) && !matchesAny(rel, exceptions)));
  log('archive file list: ' + keep.length + ' of ' + allFiles.length + ' tracked file(s) pass the exclude filter (filtered before archiving, not after)');

  const archiveTar = path.join(tmp, '.__archive.tar');
  const out = git(['archive', '--format=tar', 'main', '--'].concat(keep), { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 });
  fs.writeFileSync(archiveTar, out);
  // --force-local: bsdtar/Windows tar otherwise reads a "C:\..." archive path as a "host:file" remote
  // spec because of the drive-letter colon. Forward-slash form additionally sidesteps MSYS's own
  // backslash-argv mangling when spawning the MSYS-bundled tar.exe without a shell.
  const toPosix = (p) => p.replace(/\\/g, '/');
  const tarRc = spawnSync('tar', ['--force-local', '-xf', toPosix(archiveTar), '-C', toPosix(tmp)], { stdio: 'inherit' });
  if (tarRc.status !== 0) die('tar -xf failed extracting git archive output (status ' + tarRc.status + ')');
  fs.unlinkSync(archiveTar);
  return tmp;
}

function step2_applyExclude(exportDir, manifest) {
  const { patterns, exceptions } = excludeConfig(manifest);
  const files = [];
  walk(exportDir, '', files);
  let removed = 0;
  for (const rel of files) {
    if (matchesAny(rel, patterns) && !matchesAny(rel, exceptions)) {
      fs.unlinkSync(path.join(exportDir, rel));
      removed++;
    }
  }
  // prune now-empty directories
  pruneEmptyDirs(exportDir);
  // step1 now pre-filters at archive time (see its comment), so `removed` should always be 0 here --
  // this pass is kept as a redundant safety net, not the primary exclude mechanism anymore.
  log('exclude: removed ' + removed + ' file(s) matching ' + patterns.length + ' pattern(s)' + (removed > 0 ? ' -- UNEXPECTED: step1 should have pre-filtered these already, investigate the archive file list logic' : ' (expected 0 -- step1 already pre-filtered)'));
}

function pruneEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const abs = path.join(dir, entry.name);
      pruneEmptyDirs(abs);
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    }
  }
}

function step3_applyAddFiles(exportDir, manifest) {
  let n = 0;
  for (const [target, srcRel] of Object.entries(manifest.addFiles || {})) {
    if (target.indexOf('_comment') === 0) continue;
    const src = path.join(REPO_ROOT, srcRel);
    const dst = path.join(exportDir, target);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    n++;
  }
  log('addFiles: added ' + n + ' file(s)');
}

function step4_applyOverlays(exportDir, manifest) {
  let n = 0;
  for (const [target, srcRel] of Object.entries(manifest.overlays || {})) {
    if (target.indexOf('_comment') === 0) continue;
    const src = path.join(REPO_ROOT, srcRel);
    const dst = path.join(exportDir, target);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    n++;
  }
  log('overlays: applied ' + n + ' full-content overlay(s)');
}

function step5_applyReplacements(exportDir, manifest) {
  let n = 0;
  for (const r of manifest.replacements || []) {
    if (typeof r !== 'object' || r === null) continue; // skip "_comment: ..." string entries
    const targetPath = path.join(exportDir, r.file);
    if (!fs.existsSync(targetPath)) die('replacement target missing (excluded upstream of its own transform?): ' + r.file);
    const find = fs.readFileSync(path.join(REPO_ROOT, r.findFile), 'utf8');
    const replace = fs.readFileSync(path.join(REPO_ROOT, r.replaceFile), 'utf8');
    const content = fs.readFileSync(targetPath, 'utf8');
    const required = r.required !== false;
    if (content.indexOf(find) === -1) {
      if (required) die('replacement find-text not found (upstream drift?) in ' + r.file + ' (findFile=' + r.findFile + ')');
      else { log('SKIP (optional, not found): ' + r.file + ' <- ' + r.findFile); continue; }
    }
    const next = content.split(find).join(replace);
    fs.writeFileSync(targetPath, next, 'utf8');
    n++;
  }
  log('replacements: applied ' + n + ' literal patch(es)');
}

// ---------------------------------------------------------------------------------------------
// Sanitize rules for username/hostname are the UNION of two sources:
//  1. DYNAMIC: derived from the machine actually running this script (os.userInfo()/os.hostname())
//     -- correct when the export runs on the author's own machine.
//  2. LITERAL FALLBACK (manifest.sanitizeLiteralFallback): hardcoded username/hostname literals --
//     correct on any OTHER host (e.g. CI), where the running machine's own identity is irrelevant
//     but the author's identity is still baked into private-repo prose/strings/comments.
// LOW-1 fix (review FAB-2026-09-25-w11-w12-review.md LOW-1): before this fix, only (1) existed, so
// gate1_residualScan run from a machine whose os.userInfo()/os.hostname() differ from the author's
// (true of every CI runner) would neither sanitize NOR catch a leftover author-identity literal that
// wasn't already covered by one of the per-file `replacements` patches. See manifest's
// sanitizeLiteralFallback._comment for the full rationale and provenance of the literal values.
function uniqStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function buildSanitizeRules(manifest) {
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fallback = (manifest && manifest.sanitizeLiteralFallback) || {};
  const usernames = uniqStrings([os.userInfo().username].concat(fallback.usernames || []));
  const hostnames = uniqStrings([os.hostname()].concat(fallback.hostnames || []));

  const rules = [];
  for (const u of usernames) {
    const userEsc = escRe(u);
    rules.push({ id: 'home-username-path:' + u, re: new RegExp('((?:[A-Za-z]:[\\\\/]|/)Users[\\\\/])' + userEsc + '([\\\\/])', 'g'), replace: '$1<user>$2' });
    rules.push({ id: 'bare-username:' + u, re: new RegExp('(["\'`\\s(])' + userEsc + '(["\'`\\s).,;])', 'g'), replace: '$1<user>$2' });
  }
  for (const h of hostnames) {
    const hostEsc = escRe(h);
    rules.push({ id: 'hostname:' + h, re: new RegExp('\\b' + hostEsc + '\\b', 'g'), replace: '<mach>' });
  }
  rules.push({ id: 'lan-ip', re: /192\.168\.1\.151/g, replace: '10.0.0.1' });
  rules.push({ id: 'd-rag-path', re: /D:[\\/]RAG/gi, replace: 'D:/example-project' });
  // [Builder W9, 2026-09-25] Blanket rename, ANY occurrence -- not just inside a real absolute
  // path. Supersedes the old narrower 'desktop-axervice-booking-real-path' rule (username-redaction
  // there is already covered by home-username-path above; this rule now handles the project-name
  // half unconditionally, including test-fixture repo= values and comments). The private source
  // fixtures were also renamed directly (guards/pmm-trigger-recall.cjs/.sh, guards/fixtures/v3/
  // trigger-write-gate-probe.cjs), so this is defense-in-depth, not the primary mechanism. KNOWN
  // INTENTIONAL divergence from today's origin/main -- see manifest knownDivergencesFromCurrentOriginMain.
  rules.push({ id: 'axervice-booking-repo-name', re: /axervice-booking/g, replace: 'example-project' });
  // Deliberately a hardcoded literal, unlike the dynamic rules above -- 'Jax' is a personal name
  // embedded in prose/comments across the tree, not derivable from any os.userInfo()/os.hostname()
  // API. Word-boundary match so it never touches an already-mapped compound like a
  // 'JaxStuuu'-style hostname (the hostname rules above already handle that).
  rules.push({ id: 'author-first-name', re: /\bJax\b/g, replace: 'the maintainer' });
  return rules;
}

function step6_sanitize(exportDir, manifest) {
  const rules = buildSanitizeRules(manifest);
  const files = [];
  walk(exportDir, '', files);
  let touched = 0;
  for (const rel of files) {
    const abs = path.join(exportDir, rel);
    const buf = fs.readFileSync(abs);
    if (!isProbablyText(buf)) continue;
    let content = buf.toString('utf8');
    let changed = false;
    for (const rule of rules) {
      if (rule.re.test(content)) { changed = true; }
      rule.re.lastIndex = 0;
      content = content.replace(rule.re, rule.replace);
    }
    if (changed) { fs.writeFileSync(abs, content, 'utf8'); touched++; }
  }
  log('sanitize: touched ' + touched + ' file(s)');
}

// ---------------------------------------------------------------------------------------------
function gate1_residualScan(exportDir, manifest) {
  const rules = buildSanitizeRules(manifest);
  const files = [];
  walk(exportDir, '', files);
  const findings = [];
  for (const rel of files) {
    const abs = path.join(exportDir, rel);
    const buf = fs.readFileSync(abs);
    if (!isProbablyText(buf)) continue;
    const content = buf.toString('utf8');
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      const m = content.match(rule.re);
      if (m && m.length) findings.push({ file: rel, rule: rule.id, count: m.length });
    }
  }
  const total = findings.reduce((a, f) => a + f.count, 0);
  log('GATE1 residual-scan: ' + total + ' match(es)' + (total ? (' -- ' + JSON.stringify(findings)) : ''));
  return total;
}

function gate2_installLayoutSelfTest(exportDir, manifest) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-publish-home-'));
  const guardsDst = path.join(tempHome, '.claude', 'guards');
  fs.mkdirSync(guardsDst, { recursive: true });
  copyDir(path.join(exportDir, 'guards'), guardsDst);
  const cfg = manifest.gates.installLayoutSelfTest;
  const gatePath = path.join(guardsDst, cfg.guard);
  // Resolve the --contract path argument against guardsDst regardless of how it was spelled in the
  // manifest (the manifest's copy is relative to the guard's own dir at authoring time).
  const resolvedArgs = cfg.args.map((a, i) => (cfg.args[i - 1] === '--contract') ? path.join(guardsDst, 'specs', 'isolation-gate-contract.json') : a);
  const env = Object.assign({}, process.env, { HOME: tempHome, USERPROFILE: tempHome, PMM_HOME: tempHome });
  for (const k of Object.keys(env)) { if (/^PMM_/.test(k) && !['PMM_HOME'].includes(k)) delete env[k]; }
  const res = spawnSync(process.execPath, [gatePath].concat(resolvedArgs), { env, encoding: 'utf8', cwd: guardsDst });
  const out = (res.stdout || '') + '\n' + (res.stderr || '');
  let fail = null, mutants = [];
  for (const line of out.split('\n')) {
    const cIdx = line.indexOf('ISOGATE-CONTRACT ');
    if (cIdx !== -1) { try { fail = JSON.parse(line.slice(cIdx + 'ISOGATE-CONTRACT '.length)).fail; } catch {} }
    const mIdx = line.indexOf('ISOGATE-MUTANT ');
    if (mIdx !== -1) { try { mutants.push(JSON.parse(line.slice(mIdx + 'ISOGATE-MUTANT '.length))); } catch {} }
  }
  const allMatch = mutants.length > 0 && mutants.every((m) => m.matches === true);
  const ok = res.status === 0 && fail === 0 && mutants.length === (cfg.expectMutants || 2) && allMatch;
  log('GATE2 install-layout self-test: exit=' + res.status + ' fail=' + fail + ' mutants=' + mutants.length + ' allMatch=' + allMatch + (ok ? ' -- PASS' : ' -- FAIL'));
  if (!ok) log('GATE2 raw output tail:\n' + out.split('\n').slice(-25).join('\n'));
  rmrf(tempHome);
  return ok;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function gate3_npmSelftest(exportDir) {
  // MUST be isolated exactly like gate2 -- `bin/axmem selftest` falls back to $HOME/.axmem (and, via
  // some components' own compat/legacy path, the real $HOME/.claude PMM tree) whenever AXMEM_* is
  // unset. Running it under the ambient real environment previously caused a real, live, git-tracked
  // ~/.claude/memory/dreams/receipts/*.tsv to pick up stray uncommitted lines during development of
  // this script -- never repeat that. Every var below is one this codebase's OWN test suite
  // (tests/full-env-isolation.sh) sets for the identical reason.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-publish-selftest-'));
  const axmemHome = path.join(tempHome, '.axmem');
  const env = Object.assign({}, process.env, {
    HOME: tempHome,
    USERPROFILE: tempHome,
    PMM_HOME: tempHome,
    AXMEM_HOME: axmemHome,
    AXMEM_MEMORY_DIR: path.join(axmemHome, 'memory'),
    AXMEM_STATE_DIR: path.join(axmemHome, 'state'),
    AXMEM_CONFIG: path.join(axmemHome, 'config.json'),
  });
  for (const k of Object.keys(env)) { if (/^PMM_/.test(k) && k !== 'PMM_HOME') delete env[k]; }
  // npm has no argv-exec form on Windows (it's a .cmd shim) so this needs shell:true there; pass a
  // single fixed string (no interpolated data) rather than an args array to avoid Node's
  // shell-arg-escaping deprecation warning.
  const res = process.platform === 'win32'
    ? spawnSync('npm run selftest', { cwd: exportDir, env, encoding: 'utf8', shell: true })
    : spawnSync('npm', ['run', 'selftest'], { cwd: exportDir, env, encoding: 'utf8' });
  const out = (res.stdout || '') + '\n' + (res.stderr || '');
  const ok = res.status === 0;
  log('GATE3 npm run selftest: exit=' + res.status + (ok ? ' -- PASS' : ' -- FAIL'));
  if (!ok) log('GATE3 raw output tail:\n' + out.split('\n').slice(-40).join('\n'));
  rmrf(tempHome);
  return ok;
}

// ---------------------------------------------------------------------------------------------
// MED-3 fix (review FAB-2026-09-25-w11-w12-review.md MED-3): overlay drift detection. `overlays` in
// the manifest is a full-content snapshot copy (step4_applyOverlays) of a hand-curated file that
// stands in for `main`'s OWN tracked file at the same path. If `main`'s file at that path changes
// (e.g. a kept, non-excluded guard's canary roster grows) after the overlay snapshot was last
// reviewed, the overlay silently ships stale content with zero warning -- unlike `replacements`,
// whose required=true find-text check already fails closed on upstream drift. This gives overlays
// the same fail-closed guarantee: manifest.overlayBaselines records the git blob sha of main's file
// at each overlay target path as of the last human review; this function recomputes it now and dies
// if it no longer matches, BEFORE anything is archived/exported/committed.
function overlayTargets(manifest) {
  return Object.keys(manifest.overlays || {}).filter((k) => k.indexOf('_comment') !== 0);
}

function blobShaAtRef(ref, relPath) {
  try {
    return git(['rev-parse', ref + ':' + relPath]).trim();
  } catch (e) {
    return null; // path does not exist at that ref
  }
}

function checkOverlayDrift(manifest) {
  const targets = overlayTargets(manifest);
  const baselines = manifest.overlayBaselines || {};
  const drifted = [];
  for (const target of targets) {
    const expected = Object.prototype.hasOwnProperty.call(baselines, target) ? baselines[target] : null;
    const actual = blobShaAtRef('main', target);
    if (expected === null || actual === null || expected !== actual) {
      drifted.push({ target: target, expected: expected, actual: actual });
    }
  }
  if (drifted.length) {
    const lines = drifted.map((d) => '  - ' + d.target + ': baseline=' + (d.expected || '(none recorded)') + ' current main=' + (d.actual || '(missing at that path in main!)'));
    die(
      'GATE0 overlay drift: ' + drifted.length + ' overlay target(s) no longer match the baseline recorded in ' +
      'publish.manifest.json overlayBaselines -- main\'s own file at that path changed since the overlay content ' +
      'under publish-overrides/ (or README.public.md etc.) was last hand-reviewed against it, so the overlay may ' +
      'now silently ship stale content. Review the diff at each path below, refresh the overlay content if needed, ' +
      'then re-run with --update-overlay-baselines to acknowledge and record the new baseline:\n' + lines.join('\n')
    );
  }
  log('GATE0 overlay drift: 0 drifted overlay target(s) of ' + targets.length + ' -- baselines match main');
}

function updateOverlayBaselines(manifest) {
  const targets = overlayTargets(manifest);
  const prev = manifest.overlayBaselines || {};
  const next = { _comment: prev._comment };
  const changes = [];
  for (const target of targets) {
    const actual = blobShaAtRef('main', target);
    const before = Object.prototype.hasOwnProperty.call(prev, target) ? prev[target] : null;
    next[target] = actual;
    changes.push({ target: target, before: before, after: actual, changed: before !== actual });
  }
  manifest.overlayBaselines = next;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const changedCount = changes.filter((c) => c.changed).length;
  log('--update-overlay-baselines: wrote ' + targets.length + ' baseline(s) to ' + MANIFEST_PATH + ' (' + changedCount + ' changed, ' + (targets.length - changedCount) + ' unchanged):');
  for (const c of changes) {
    log('  - ' + c.target + ': ' + (c.changed ? ((c.before || '(none)') + ' -> ' + c.after) : (c.after + ' (unchanged)')));
  }
}

// ---------------------------------------------------------------------------------------------
function treeHashOfDir(exportDir) {
  // Build a git tree object from exportDir's current on-disk state using a throwaway index file,
  // WITHOUT touching the real working tree/index of the repo (public/main stay untouched on disk).
  const tmpIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-publish-idx-')), 'index');
  const env = Object.assign({}, process.env, { GIT_INDEX_FILE: tmpIndex, GIT_WORK_TREE: exportDir, GIT_DIR: path.join(REPO_ROOT, '.git') });
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-A'], { cwd: exportDir, env });
  const tree = execFileSync('git', ['-c', 'core.autocrlf=false', 'write-tree'], { cwd: exportDir, env, encoding: 'utf8' }).trim();
  rmrf(path.dirname(tmpIndex));
  return tree;
}

function commitOntoPublic(exportDir, privateShortSha, orphan) {
  const newTree = treeHashOfDir(exportDir);
  let publicHead = null;
  try { publicHead = git(['rev-parse', 'public']).trim(); } catch { publicHead = null; }
  let publicTree = null;
  if (publicHead) { try { publicTree = git(['rev-parse', publicHead + '^{tree}']).trim(); } catch {} }
  // Idempotency is ALWAYS tree-hash-only (never parent/history-shape-dependent), in both modes: a
  // second run against the same private commit must be a true no-op regardless of whether `public`'s
  // history is a normal chain or a fresh orphan lineage.
  if (publicTree === newTree) {
    log('IDEMPOTENT: exported tree (' + newTree + ') matches public HEAD tree already -- no new commit');
    return { created: false, tree: newTree, commit: publicHead };
  }
  const date = new Date().toISOString().slice(0, 10);
  const msg = 'publish: ' + privateShortSha + ' ' + date;
  // [Builder W9, 2026-09-25] --orphan (Jax ruling): `public`'s prior two commits carried
  // un-sanitized content and must disappear from reachable history entirely, not just from the
  // working tree of a new commit built on top of them. Every export in this mode is therefore a
  // single parentless commit -- `public`'s history is always exactly 1 commit deep, never a chain --
  // so nothing from before this rebuild stays reachable once the ref is force-moved. Non-orphan mode
  // (the default) keeps the normal chained-commit behavior for ordinary republishes.
  const parentArgs = orphan ? [] : (publicHead ? ['-p', publicHead] : []);
  const newCommit = execFileSync('git', ['commit-tree', newTree].concat(parentArgs, ['-m', msg]), { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/public', newCommit]);
  log('created commit ' + newCommit + ' on `public` (tree ' + newTree + (orphan ? ', orphan -- no parent' : (publicHead ? ', parent ' + publicHead : ', first commit')) + '): ' + msg);
  return { created: true, tree: newTree, commit: newCommit };
}

// ---------------------------------------------------------------------------------------------
// Finds an existing remote already pointed at manifest.publicRepo (the normal case in a local clone
// set up per the task: `origin` = the public repo) so `--push` reuses it verbatim. Falls back to
// creating a dedicated remote authenticated with $PUBLIC_REPO_TOKEN when none exists (the CI case:
// actions/checkout's `origin` is THIS private repo, not the public one).
function ensurePublicRemote(manifest) {
  const target = manifest.publicRepo; // e.g. "axervice/AxMem"
  let remotesRaw = '';
  try { remotesRaw = git(['remote', '-v']); } catch { remotesRaw = ''; }
  for (const line of remotesRaw.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(push\)$/);
    if (!m) continue;
    const [, name, url] = m;
    if (url.replace(/\.git$/i, '').toLowerCase().endsWith('/' + target.toLowerCase())) return name;
  }
  const dedicated = 'publish-public-target';
  const token = process.env.PUBLIC_REPO_TOKEN;
  const url = token
    ? ('https://x-access-token:' + token + '@github.com/' + target + '.git')
    : ('https://github.com/' + target + '.git');
  try { git(['remote', 'remove', dedicated]); } catch {}
  git(['remote', 'add', dedicated, url]);
  log('no existing remote points at ' + target + ' -- created `' + dedicated + '`' + (token ? ' (token-authenticated)' : ''));
  return dedicated;
}

// Fresh `git ls-remote <remote> <ref>` lookup, used ONLY to build a --force-with-lease expected-value
// argument immediately before the push call (never cached/reused across a run) so the lease is checked
// against the remote's actual current state, not a value that may have gone stale earlier in the run.
// Returns '' when the ref does not exist on the remote yet (first-ever publish to a brand-new repo) --
// git's own --force-with-lease=<ref>:<expect> syntax treats an empty <expect> as "must not already
// exist", so callers can pass this straight through without a separate branch.
function getRemoteRefSha(remoteName, ref) {
  let out = '';
  try { out = git(['ls-remote', '--exit-code', remoteName, ref]); } catch { out = ''; }
  const line = out.split('\n').find((l) => l.trim().length > 0);
  return line ? line.split('\t')[0].trim() : '';
}

function main() {
  step0_cleanupStaleTemp();
  const manifest = readManifest();

  // MED-3 fix: --update-overlay-baselines is a standalone, explicit "I have reviewed the drift,
  // record the new baseline" action -- it does NOT also run the export in the same invocation, so
  // acknowledging drift is a distinct, deliberate step from publishing. See updateOverlayBaselines()'s
  // comment.
  if (process.argv.includes('--update-overlay-baselines')) {
    updateOverlayBaselines(manifest);
    log('DONE (baselines updated -- re-run without this flag to export)');
    return;
  }

  // GATE0, runs before anything is archived/exported/committed (see checkOverlayDrift()'s comment).
  checkOverlayDrift(manifest);

  const push = process.argv.includes('--push');
  const orphan = process.argv.includes('--orphan') || manifest.history === 'orphan';
  const privateShortSha = git(['rev-parse', '--short', 'main']).trim();
  log('source: main @ ' + privateShortSha + (orphan ? ' (orphan history mode)' : ''));

  const exportDir = step1_archiveMainToTemp(manifest);
  try {
    step2_applyExclude(exportDir, manifest);
    step3_applyAddFiles(exportDir, manifest);
    step4_applyOverlays(exportDir, manifest);
    step5_applyReplacements(exportDir, manifest);
    step6_sanitize(exportDir, manifest);

    const residual = gate1_residualScan(exportDir, manifest);
    if (residual !== 0) die('GATE1 residual scan found ' + residual + ' match(es) -- aborting, no commit made');

    const g2 = gate2_installLayoutSelfTest(exportDir, manifest);
    if (!g2) die('GATE2 install-layout self-test failed -- aborting, no commit made');

    const g3 = gate3_npmSelftest(exportDir);
    if (!g3) die('GATE3 npm run selftest failed -- aborting, no commit made');

    const result = commitOntoPublic(exportDir, privateShortSha, orphan);

    if (push) {
      const remoteName = ensurePublicRemote(manifest);
      if (orphan) {
        // HIGH fix (review OPUS-2026-09-25-c05-w5-w10-review.md §7): orphan mode makes a fresh,
        // parentless commit on EVERY run (see commitOntoPublic's `orphan` branch above), so the
        // remote's current `main` is never an ancestor of the commit we are about to push -- a plain
        // `git push` would be rejected as non-fast-forward on every publish after the first. A blind
        // `--force` would "fix" that but would also silently blow away a genuine concurrent push (CI
        // and a manual dispatch racing, or a third party with push access). `--force-with-lease`
        // instead pins the push to the remote ref's value we just observed via ls-remote (fetched
        // fresh, immediately before the push -- never a cached/earlier-in-the-run value) and lets git
        // itself atomically re-check that value at push time: if anything else moved `main` in
        // between, the push is rejected instead of clobbering it.
        const expect = getRemoteRefSha(remoteName, 'main');
        const leaseArg = '--force-with-lease=main:' + expect;
        log('pushing public -> ' + remoteName + ' main (orphan mode, ' + leaseArg + (expect ? '' : ' -- expecting remote main to not exist yet') + ')');
        git(['push', leaseArg, remoteName, 'public:main'], { stdio: 'inherit' });
      } else {
        log('pushing public -> ' + remoteName + ' main');
        git(['push', remoteName, 'public:main'], { stdio: 'inherit' });
      }
    } else {
      log('--push not set: local `public` branch updated, origin NOT touched');
    }
    log('EXPORT_TREE=' + result.tree);
    log('DONE');
  } finally {
    // MED fix (review §7): retry-with-backoff + explicit separate reporting, so a cleanup failure
    // never masquerades as (or gets masked by) the export's own success/failure. This finally block
    // now actually runs on every die() path too -- see die()'s comment -- which it did not before.
    const cleanup = rmrfRetrying(exportDir, 3);
    if (cleanup.ok) {
      log('cleanup: removed export dir ' + exportDir + (cleanup.attempts > 1 ? (' (attempt ' + cleanup.attempts + ')') : ''));
    } else {
      process.stderr.write('[publish-public] CLEANUP FAILED after ' + cleanup.attempts + ' attempt(s): could not remove ' + exportDir + ' -- ' + (cleanup.error && cleanup.error.message) + '\n');
      process.stderr.write('[publish-public] Remove this directory by hand. (Contents are the filtered export tree only -- excluded/paid-tier files were never archived into it, per step1 -- but it should not be left on disk.)\n');
      // Reported and flagged separately from EXPORT_TREE/DONE above: if the export itself succeeded,
      // those log lines already printed and remain true. This only marks the OVERALL run non-clean.
      process.exitCode = 1;
    }
  }
}

// Exposed for unit-testing individual pieces (e.g. checkOverlayDrift, buildSanitizeRules,
// gate1_residualScan) via require() against a fixture repo, WITHOUT triggering the auto-run below --
// require.main !== module in that case. Behavior when invoked as `node scripts/publish-public.cjs`
// (require.main === module) is unchanged.
module.exports = {
  buildSanitizeRules,
  gate1_residualScan,
  step6_sanitize,
  checkOverlayDrift,
  updateOverlayBaselines,
  overlayTargets,
  blobShaAtRef,
  readManifest,
  main,
};

// Thin wrapper so die()'s throw unwinds through main()'s try/finally (running the cleanup above)
// before the process exit code is set, instead of die() calling process.exit() directly and skipping
// that finally block entirely (see die()'s comment). A non-die() exception (a real bug) is also caught
// here so it gets the same treatment rather than an unhandled-rejection-style crash that bypasses
// cleanup.
if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (!err || !err.__axmemDie) {
      process.stderr.write('[publish-public] UNCAUGHT: ' + ((err && err.stack) || err) + '\n');
    }
    process.exitCode = 1;
  }
}
