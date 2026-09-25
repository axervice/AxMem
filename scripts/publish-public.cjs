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
function die(msg) { process.stderr.write('[publish-public] FATAL: ' + msg + '\n'); process.exit(1); }

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
  fs.rmSync(p, { recursive: true, force: true });
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
function step1_archiveMainToTemp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-publish-src-'));
  log('exporting `main` tree via git archive -> ' + tmp);
  // git archive main | tar -x -C tmp   (no shell:true -- pipe two spawnSync'd processes ourselves)
  const archiveTar = path.join(tmp, '.__archive.tar');
  const out = git(['archive', '--format=tar', 'main'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 });
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
  const patterns = (manifest.exclude || []).filter((p) => !isCommentEntry(p));
  const exceptions = (manifest.excludeExceptions || []).filter((p) => !isCommentEntry(p));
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
  log('exclude: removed ' + removed + ' file(s) matching ' + patterns.length + ' pattern(s)');
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
// Sanitize rules are DYNAMIC: derived from the machine actually running this script, never a
// hardcoded literal, so the same script stays correct if run from a different machine/user.
function buildSanitizeRules() {
  const realUser = os.userInfo().username;
  const realHost = os.hostname();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const userEsc = escRe(realUser);
  const hostEsc = escRe(realHost);
  return [
    { id: 'home-username-path', re: new RegExp('((?:[A-Za-z]:[\\\\/]|/)Users[\\\\/])' + userEsc + '([\\\\/])', 'g'), replace: '$1<user>$2' },
    { id: 'bare-username', re: new RegExp('(["\'`\\s(])' + userEsc + '(["\'`\\s).,;])', 'g'), replace: '$1<user>$2' },
    { id: 'hostname', re: new RegExp('\\b' + hostEsc + '\\b', 'g'), replace: '<mach>' },
    { id: 'lan-ip', re: /192\.168\.1\.151/g, replace: '10.0.0.1' },
    { id: 'd-rag-path', re: /D:[\\/]RAG/gi, replace: 'D:/example-project' },
    // Scoped: only a REAL absolute path (drive letter or /c/ mount) with the REAL username segment
    // right before Desktop -- never touches $HOMEW-style shell vars or already-<user> placeholder text
    // that origin/main already ships byte-identical (see manifest sanitize.rules comment).
    { id: 'desktop-axervice-booking-real-path', re: new RegExp('((?:[A-Za-z]:[\\\\/]|/[a-z]/)Users[\\\\/])' + userEsc + '([\\\\/]Desktop[\\\\/])axervice-booking', 'g'), replace: '$1<user>$2example-project' },
  ];
}

function step6_sanitize(exportDir) {
  const rules = buildSanitizeRules();
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
function gate1_residualScan(exportDir) {
  const rules = buildSanitizeRules();
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
  const res = spawnSync('npm', ['run', 'selftest'], { cwd: exportDir, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = (res.stdout || '') + '\n' + (res.stderr || '');
  const ok = res.status === 0;
  log('GATE3 npm run selftest: exit=' + res.status + (ok ? ' -- PASS' : ' -- FAIL'));
  if (!ok) log('GATE3 raw output tail:\n' + out.split('\n').slice(-40).join('\n'));
  return ok;
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

function commitOntoPublic(exportDir, privateShortSha) {
  const newTree = treeHashOfDir(exportDir);
  let publicHead = null;
  try { publicHead = git(['rev-parse', 'public']).trim(); } catch { publicHead = null; }
  let publicTree = null;
  if (publicHead) { try { publicTree = git(['rev-parse', publicHead + '^{tree}']).trim(); } catch {} }
  if (publicTree === newTree) {
    log('IDEMPOTENT: exported tree (' + newTree + ') matches public HEAD tree already -- no new commit');
    return { created: false, tree: newTree, commit: publicHead };
  }
  const date = new Date().toISOString().slice(0, 10);
  const msg = 'publish: ' + privateShortSha + ' ' + date;
  const parentArgs = publicHead ? ['-p', publicHead] : [];
  const newCommit = execFileSync('git', ['commit-tree', newTree].concat(parentArgs, ['-m', msg]), { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/public', newCommit]);
  log('created commit ' + newCommit + ' on `public` (tree ' + newTree + '): ' + msg);
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

function main() {
  const push = process.argv.includes('--push');
  const manifest = readManifest();
  const privateShortSha = git(['rev-parse', '--short', 'main']).trim();
  log('source: main @ ' + privateShortSha);

  const exportDir = step1_archiveMainToTemp();
  try {
    step2_applyExclude(exportDir, manifest);
    step3_applyAddFiles(exportDir, manifest);
    step4_applyOverlays(exportDir, manifest);
    step5_applyReplacements(exportDir, manifest);
    step6_sanitize(exportDir);

    const residual = gate1_residualScan(exportDir);
    if (residual !== 0) die('GATE1 residual scan found ' + residual + ' match(es) -- aborting, no commit made');

    const g2 = gate2_installLayoutSelfTest(exportDir, manifest);
    if (!g2) die('GATE2 install-layout self-test failed -- aborting, no commit made');

    const g3 = gate3_npmSelftest(exportDir);
    if (!g3) die('GATE3 npm run selftest failed -- aborting, no commit made');

    const result = commitOntoPublic(exportDir, privateShortSha);

    if (push) {
      const remoteName = ensurePublicRemote(manifest);
      log('pushing public -> ' + remoteName + ' main');
      git(['push', remoteName, 'public:main'], { stdio: 'inherit' });
    } else {
      log('--push not set: local `public` branch updated, origin NOT touched');
    }
    log('EXPORT_TREE=' + result.tree);
    log('DONE');
  } finally {
    rmrf(exportDir);
  }
}

main();
