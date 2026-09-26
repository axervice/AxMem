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
//   node scripts/publish-public.cjs             # export + gates 0-5 + commit onto local `public` (no push)
//   node scripts/publish-public.cjs --push       # same, then `git push origin public:main`
//   node scripts/publish-public.cjs --orphan     # commit as a fresh parentless commit (see manifest's
//                                                 # "history" field -- "orphan" is the standing default,
//                                                 # so this flag is rarely needed explicitly)
//   node scripts/publish-public.cjs --allow-dirty-inputs  # proceed even though a publish input (manifest /
//                                                 # publish-overrides/** / an overlay source) has uncommitted
//                                                 # changes -- the export still reads only the last COMMITTED
//                                                 # blob of every input (see checkInputsClean()); noted in the
//                                                 # commit message trailer.
//   node scripts/publish-public.cjs --update-overlay-baseline <target> --review-note "<text>"
//                                                 # ack ONE overlay's drift (GATE0) after reviewing its diff,
//                                                 # no export. Replaces the old batch --update-overlay-baselines
//                                                 # (W22-U2, codex #2): that flag now dies with a pointer here.
//   node scripts/publish-public.cjs --update-path-snapshot --reason "X" # ack a public path-set change (GATE5), no export
//
// Gates: GATE0 overlay-drift, GATE1 residual sanitize-regex scan, GATE2 install-layout self-test,
// GATE3 `npm run selftest`, GATE4 independent final-tree identity/denylist + mode/binary scan (W22-U1,
// codex #1/#11/#13), GATE5 exported path-list snapshot (W22-U1, codex #4/#14).
//
// W22-U2 (Opus defense unit U2 -- codex #2/#3/#5/#6/#7/#8/#12, blind spots 1-2): the source commit is
// resolved to a full OID exactly ONCE, at the top of the real export path, and threaded through every
// subsequent read -- overlay-drift check, keep-list, `git archive`, and every manifest/overlay/patch/
// addFiles read (via `git show <OID>:<path>`, never the working tree). See resolveSourceOid(),
// readFrozenBlob(), and the "跨单元不变量" section of docs/audits/OPUS-2026-09-26-defense-export-pipeline.md
// for why this one change closes #3 (TOCTOU), #6 (CRLF), #7 (path containment), and blind spot 1
// (uncommitted working-tree edits shipping) together. Deliberately NOT fixed with `.gitattributes`
// alone (see that doc's explicit instruction) -- one is added below anyway as belt-and-braces, but the
// actual fix is the frozen-OID blob reads.
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

// ---------------------------------------------------------------------------------------------
// W22-U1 fix (codex #11): every top-level field this script actually reads, kept in sync by hand.
// validateManifestSchema() dies on any OTHER top-level key (typo'd field name, a field renamed here
// but not there, ...) instead of silently ignoring it -- the exact "declared but not consumed" bug
// class finding #11 found in `sourceBranch`/`residualScanPatterns`/etc.
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  '$schema', 'version', 'auto', 'publicRepo', 'publicBranch', 'sourceBranch', 'history',
  'exclude', 'excludeExceptions', 'addFiles', 'overlays', 'overlayBaselines', 'replacements',
  'sanitizeLiteralFallback', 'sanitize', 'denylist', 'binaryAllowlist', 'publicPathSnapshot',
  'gates', 'knownDivergencesFromCurrentOriginMain',
]);

function validateRuleList(list, label, requirePattern) {
  if (list == null) return;
  if (!Array.isArray(list)) die('manifest schema: "' + label + '" must be an array');
  const seen = new Set();
  for (const entry of list) {
    if (isCommentEntry(entry)) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) die('manifest schema: "' + label + '" has a non-object, non-comment entry: ' + JSON.stringify(entry));
    if (typeof entry.id !== 'string' || entry.id.length === 0) die('manifest schema: "' + label + '" entry missing non-empty string "id": ' + JSON.stringify(entry));
    if (seen.has(entry.id)) die('manifest schema: "' + label + '" has duplicate rule id "' + entry.id + '"');
    seen.add(entry.id);
    if (requirePattern === 'required') {
      if (typeof entry.pattern !== 'string' || entry.pattern.length === 0) die('manifest schema: "' + label + '" entry "' + entry.id + '" has empty/missing "pattern"');
    } else if (requirePattern === 'kind-or-pattern') {
      const hasKind = typeof entry.kind === 'string' && entry.kind.length > 0;
      const hasPattern = typeof entry.pattern === 'string' && entry.pattern.length > 0;
      if (!hasKind && !hasPattern) die('manifest schema: "' + label + '" entry "' + entry.id + '" needs either a non-empty "kind" or a non-empty "pattern"');
      if (hasPattern && typeof entry.replace !== 'string') die('manifest schema: "' + label + '" entry "' + entry.id + '" has "pattern" but is missing string "replace"');
    }
  }
}

function validateManifestSchema(manifest) {
  if (!manifest || typeof manifest !== 'object') die('manifest schema: root is not an object');
  for (const key of Object.keys(manifest)) {
    if (key.indexOf('_comment') === 0) continue;
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) die('manifest schema: unknown top-level field "' + key + '" (typo, or a field this script no longer reads -- see ALLOWED_TOP_LEVEL_KEYS)');
  }
  validateRuleList(manifest.sanitize && manifest.sanitize.rules, 'sanitize.rules', 'kind-or-pattern');
  validateRuleList(manifest.denylist && manifest.denylist.identityLiterals, 'denylist.identityLiterals', 'required');
  validateRuleList(manifest.denylist && manifest.denylist.internalNames, 'denylist.internalNames', 'required');
  return manifest;
}

// W22-U2: an optional `sourceOid` reads the manifest from that FROZEN commit's own git blob
// (`git show <sourceOid>:publish.manifest.json`) instead of the working-tree file on disk. The real
// export path (main()) always passes it, so an uncommitted edit to publish.manifest.json can never
// silently change export behavior (Opus blind spot 1). The two maintenance sub-commands
// (--update-overlay-baseline / --update-path-snapshot) and every existing caller that omits the
// argument keep reading the on-disk file, unchanged -- those are deliberate "edit the manifest by
// hand" actions, not the export itself.
function readManifest(sourceOid) {
  const raw = sourceOid
    ? readFrozenBlob(sourceOid, 'publish.manifest.json', 'manifest').toString('utf8')
    : fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw);
  validateManifestSchema(manifest);
  return manifest;
}

// Resolves a manifest-declared path against REPO_ROOT, except an already-absolute path (used by
// unit tests to point publicPathSnapshot.file at a scratch fixture outside the repo) which passes
// through unchanged -- plain path.join() would otherwise silently concatenate instead of resolving.
function resolveManifestPath(rel) {
  return path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
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
// W22-U2 (codex #3, Opus U2 "冻结源 OID"): resolves `ref` (normally the literal branch name 'main') to
// a full, immutable commit OID exactly ONCE per invocation. Every subsequent read in the real export
// path -- overlay drift, the keep-list, `git archive`, every frozen-blob read, and the commit message
// -- is threaded this SAME oid, never a fresh `git rev-parse main` call, so a concurrent process moving
// `main` between this call and the archive/commit later in the run cannot produce a mixed-source
// publish (codex #3's TOCTOU). `--verify ...^{commit}` fails loudly (execFileSync throws) if `ref` (or
// the override below) does not name an existing commit object, rather than silently resolving to
// something unexpected.
//
// AXMEM_PUBLISH_SOURCE_OID: an explicit-OID override, read ONLY here, for tests that need to pin the
// export to a specific commit without needing to move the real `main` ref (see
// tests/publish-source-freeze.test.cjs's TOCTOU-style tests). Never documented as an end-user flag --
// it exists purely as the "env override" escape hatch the W22-U2 spec asked for.
function resolveSourceOid(ref) {
  const override = process.env.AXMEM_PUBLISH_SOURCE_OID;
  const target = override || ref;
  return git(['rev-parse', '--verify', target + '^{commit}']).trim();
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
// W22-U2 (codex #7, Opus U2): rejects any manifest-declared path that is absolute, escapes its root
// via a `..` segment, points under `.git/`, or contains a NUL byte -- BEFORE it is ever joined onto
// REPO_ROOT or an export dir. Applied to every addFiles/overlays/replacements source AND target path.
// Backslashes are normalized to '/' first so a Windows-style manifest value (or a path.join() result)
// is checked the same way as a POSIX one.
function assertSafeRepoRelPath(relPath, label) {
  const tag = label || 'path';
  if (typeof relPath !== 'string' || relPath.length === 0) die(tag + ': must be a non-empty string');
  if (relPath.indexOf('\0') !== -1) die(tag + ': contains a NUL byte: ' + JSON.stringify(relPath));
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) die(tag + ': absolute paths are not allowed: ' + relPath);
  const norm = relPath.split('\\').join('/');
  const segs = norm.split('/');
  if (segs.some((s) => s === '..')) die(tag + ': ".." path segments are not allowed: ' + relPath);
  if (segs.some((s) => s === '.git')) die(tag + ': paths under/named ".git" are not allowed: ' + relPath);
  return norm;
}

// W22-U2 (codex #6/#7): looks up ONE path inside a frozen tree via `git ls-tree -r <oid> -- <path>`
// (never a working-directory stat/read). Returns null if the path does not exist at that OID at all
// (a missing/renamed/never-tracked file), letting callers give a specific, actionable error rather than
// a raw git failure.
function lsTreeEntryAt(oid, relPath) {
  const norm = relPath.split('\\').join('/');
  let out;
  try {
    out = git(['ls-tree', '-r', oid, '--', norm]);
  } catch (e) {
    return null;
  }
  const line = out.split('\n').find(Boolean);
  if (!line) return null;
  const m = line.match(/^(\d+) (\S+) ([0-9a-f]+)\t(.*)$/);
  if (!m) return null;
  return { mode: m[1], type: m[2], sha: m[3], path: m[4] };
}

// W22-U2: the single "is this a safe, trusted, frozen input" check shared by every addFiles source,
// overlay source, and replacement findFile/replaceFile -- and (via assertTargetInFrozenTreeAndKeepList
// below) every overlay/replacement TARGET too. Refuses anything that is not a tracked REGULAR file
// (mode 100644/100755) at the frozen OID: a missing path, a symlink (120000), a gitlink/submodule
// (160000), or any other unexpected mode all die() here before a single byte is read.
function assertTrackedBlobAt(oid, relPath, label) {
  const norm = assertSafeRepoRelPath(relPath, label);
  const entry = lsTreeEntryAt(oid, norm);
  if (!entry) die((label || 'frozen input') + ': ' + relPath + ' does not exist as a tracked file at frozen source ' + oid);
  if (entry.type !== 'blob') die((label || 'frozen input') + ': ' + relPath + ' is not a regular tracked file (git type=' + entry.type + ', mode=' + entry.mode + ') at frozen source ' + oid + ' -- gitlink/submodule not allowed');
  if (entry.mode !== '100644' && entry.mode !== '100755') die((label || 'frozen input') + ': ' + relPath + ' has unexpected mode ' + entry.mode + ' (symlink not allowed) at frozen source ' + oid);
  return entry;
}

// W22-U2 (codex #5, Opus U2 blind-spot-adjacent finding #5): an overlay/patch TARGET must (a) already
// exist as a tracked regular file at the frozen OID, exactly like any other frozen input, AND (b) be
// present in the archive keep-list -- i.e. NOT excluded by manifest.exclude -- so an overlay/patch can
// never silently re-introduce a path the maintainer just excluded. Both checks run in the pre-flight
// validation pass, before step1 ever archives anything.
function assertTargetInFrozenTreeAndKeepList(oid, keepSet, target, label) {
  const entry = assertTrackedBlobAt(oid, target, label);
  const norm = target.split('\\').join('/');
  if (!keepSet.has(norm)) {
    die((label || 'target') + ': ' + target + ' is excluded by publish.manifest.json\'s exclude list -- an overlay/patch target must pass the keep-list (refusing before any write)');
  }
  return entry;
}

// W22-U2 (codex #6/#7): reads one frozen input's raw bytes via `git cat-file blob <sha>` -- never
// `fs.readFileSync` against the working tree. This is what makes CRLF-vs-LF a non-issue (git blobs are
// exactly the bytes committed, regardless of the checkout's/machine's core.autocrlf) and what makes an
// uncommitted working-tree edit invisible to the export (Opus blind spot 1): the path is only ever
// resolved against the frozen OID's own tree.
function readFrozenBlob(oid, relPath, label) {
  const entry = assertTrackedBlobAt(oid, relPath, label);
  return git(['cat-file', 'blob', entry.sha], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 });
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
  // sensitive-data leak, just tmpdir clutter. The two crash-safety-sensitive sites -- step1's exportDir
  // and main()'s final cleanup of it, the one directory that (pre-fix) briefly held un-excluded
  // content -- use rmrfRetrying below instead, inside a try/finally that now covers step1 itself too
  // (W22-U2, codex #12).
  fs.rmSync(p, { recursive: true, force: true });
}

const TEMP_PREFIX = 'axmem-publish-';
const RUN_MARKER_FILENAME = '.axmem-publish-run.json';
const STALE_MS = 24 * 60 * 60 * 1000; // W22-U2 (codex #8): 10min -> 24h; see step0_cleanupStaleTemp().

// W22-U2 (codex #8, Opus U2): every mkdtemp'd `axmem-publish-*` directory this script creates writes
// one of these alongside its own contents, recording the PID and start time of the process that owns
// it. The startup sweep (step0_cleanupStaleTemp) uses this to tell "a genuinely stale leftover" apart
// from "a sibling invocation currently running" -- age alone (the old 10-minute heuristic) was not
// enough: a real full export takes ~604s, i.e. it can legitimately still be running past the old
// threshold (see the defense doc's finding #8 repro). Best-effort: a failed marker write never aborts
// the run -- worst case that one directory just falls back to being left alone (not removed) by a
// later sweep, same as any other directory without a recognizable marker.
function writeRunMarker(dir) {
  try {
    fs.writeFileSync(path.join(dir, RUN_MARKER_FILENAME), JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }), 'utf8');
  } catch (e) {
    log('WARNING: could not write run marker in ' + dir + ' -- ' + (e && e.message));
  }
}

function mkdtempMarked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  writeRunMarker(dir);
  return dir;
}

// W22-U2 fix: the export tree dir CANNOT itself carry the run marker directly -- treeHashOfDir()/
// computeExportedPathList() walk exportDir's ENTIRE contents to build the committed tree and the GATE5
// path list, so a marker file written straight into exportDir would ship as part of the public export
// (confirmed in practice: GATE5 caught its own marker as an unexpected extra path the first time this
// was tried). Instead, the marker lives on a PARENT "run" directory, one level up from a `tree/`
// subdirectory that is the actual exportDir handed to step1 onward -- the sweep only ever inspects
// direct children of tmpdir() (the run dir), never descends into `tree/`, so this does not change
// step0_cleanupStaleTemp()'s behavior at all. Callers must clean up `runDir` (not just `exportDir`) so
// the marker's own directory does not itself become a marker-less leftover.
function createMarkedExportDir(prefix) {
  const runDir = mkdtempMarked(prefix);
  const treeDir = path.join(runDir, 'tree');
  fs.mkdirSync(treeDir);
  return { runDir: runDir, exportDir: treeDir };
}

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

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we lack permission to signal it -- still alive. Any other
    // error (ESRCH, or an invalid pid) means it is not.
    return !!(e && e.code === 'EPERM');
  }
}

// ---------------------------------------------------------------------------------------------
// W22-U2 rewrite (codex #8, Opus U2 "临时目录生命周期"): startup crash-safety sweep. An interrupted
// prior run (killed process, a Windows EPERM on cleanup, ...) can leave an `axmem-publish-*` mkdtemp
// directory behind under os.tmpdir(). The OLD version of this sweep matched purely on name-prefix +
// mtime > 10 minutes -- confirmed by the defense doc's finding #8 repro to both (a) be too eager, since
// a real full export legitimately takes ~604s and can still be genuinely in progress well past 10
// minutes, and (b) be spoofable, since ANY directory anywhere under os.tmpdir() sharing this script's
// prefix (e.g. a user's own `axmem-publish-important/`) would eventually get swept purely by name+age.
//
// Now: (1) refuses to follow a symlink/junction masquerading as a run dir (`fs.lstatSync` before ever
// stat-ing/reading through it -- Windows directory junctions report as symbolic links to Node's lstat,
// so this covers both); (2) requires the entry's realpath to resolve to a DIRECT child of tmpdir's own
// realpath (defense in depth against any reparse-point trickery lstat alone might miss); (3) requires a
// valid run marker (see writeRunMarker above) naming a pid and start time -- an entry with no marker,
// or an unparseable one, is left alone and merely logged (never removed): under the new convention
// every directory THIS script creates always carries one, so an unmarked entry is either a pre-fix
// leftover or a genuinely foreign directory, and guessing wrong in the destructive direction is exactly
// the failure mode being fixed; (4) removed only if the marker's pid is no longer alive OR the marker's
// age is >= 24h (STALE_MS) -- either condition alone is enough (a dead owner's directory is stale
// immediately regardless of age; a 24h+-old directory is reclaimed even if its pid number happens to
// have been recycled by an unrelated process).
function step0_cleanupStaleTemp(root) {
  root = root || os.tmpdir();
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return; }
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  let removed = 0, failed = 0, skipped = 0;
  for (const entry of entries) {
    if (entry.name.indexOf(TEMP_PREFIX) !== 0) continue;
    const abs = path.join(root, entry.name);
    let lst;
    try { lst = fs.lstatSync(abs); } catch { continue; } // vanished between readdir and lstat -- fine
    if (lst.isSymbolicLink()) {
      skipped++;
      log('NOTE: refusing to follow symlink/junction masquerading as a run dir (leaving it alone): ' + abs);
      continue;
    }
    if (!lst.isDirectory()) continue; // not a directory at all -- ignore, never our own creation
    let realAbs;
    try { realAbs = fs.realpathSync(abs); } catch { continue; }
    if (path.dirname(realAbs) !== realRoot) {
      skipped++;
      log('NOTE: refusing entry whose real path escapes tmpdir (leaving it alone): ' + abs);
      continue;
    }
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(path.join(abs, RUN_MARKER_FILENAME), 'utf8')); } catch { marker = null; }
    if (!marker || typeof marker.pid !== 'number' || typeof marker.startedAtMs !== 'number') {
      skipped++;
      log('NOTE: leaving ' + abs + ' alone -- no valid run marker (pre-marker leftover or a foreign directory); remove by hand if stale');
      continue;
    }
    const dead = !isPidAlive(marker.pid);
    const old = (Date.now() - marker.startedAtMs) >= STALE_MS;
    if (!dead && !old) continue; // owning process still alive and not yet 24h old -- a genuine sibling run
    const res = rmrfRetrying(abs, 3);
    if (res.ok) removed++;
    else { failed++; log('WARNING: startup cleanup could not remove stale temp entry ' + abs + ' -- ' + (res.error && res.error.message)); }
  }
  if (removed || failed || skipped) {
    log('startup cleanup: removed ' + removed + ' stale, left ' + skipped + ' alone (unmarked/unsafe), ' + failed + ' FAILED to remove (of `' + TEMP_PREFIX + '*` entries under ' + root + ')');
  }
}

function excludeConfig(manifest) {
  return {
    patterns: (manifest.exclude || []).filter((p) => !isCommentEntry(p)),
    exceptions: (manifest.excludeExceptions || []).filter((p) => !isCommentEntry(p)),
  };
}

// W22-U2: keep-list computation split out of step1 so it can run in the pre-flight validation pass
// (assertTargetInFrozenTreeAndKeepList) BEFORE step1 archives anything, and so both call sites (main()'s
// real export and buildExportForPathListing()'s throwaway trial export) share one implementation.
// Reads the file list from the FROZEN `sourceOid`, never a live re-resolution of `main`.
function computeKeepList(sourceOid, manifest) {
  const { patterns, exceptions } = excludeConfig(manifest);
  const lsOut = git(['ls-tree', '-r', '--name-only', '-z', sourceOid]);
  const allFiles = lsOut.split('\0').filter(Boolean);
  const keep = allFiles.filter((rel) => !(matchesAny(rel, patterns) && !matchesAny(rel, exceptions)));
  log('archive file list: ' + keep.length + ' of ' + allFiles.length + ' tracked file(s) pass the exclude filter (filtered before archiving, not after)');
  return keep;
}

// W22-U2 (codex #2/#5/#6/#7, "before any write"): validates every addFiles/overlays/replacements entry
// against the frozen source BEFORE step1 archives a single byte. addFiles sources, overlay sources, and
// replacement find/replace sources must all be tracked regular blobs at sourceOid (assertTrackedBlobAt
// -- refuses `.git/config`, `../x`, absolute paths, symlinks, gitlinks, missing paths). Overlay targets
// and replacement targets additionally must exist in the frozen tree AND survive the keep-list (must
// not be excluded) -- addFiles targets are exempt from that second check because addFiles exists
// specifically to ADD a path `main`'s own tree does not have (see publish.manifest.json's addFiles
// comment) -- but every target (addFiles included) still goes through assertSafeRepoRelPath so none of
// them can escape the export dir once joined with path.join().
function validateManifestInputsAgainstFrozenSource(sourceOid, manifest, keepList) {
  const keepSet = new Set(keepList);
  for (const [target, srcRel] of Object.entries(manifest.addFiles || {})) {
    if (target.indexOf('_comment') === 0) continue;
    assertSafeRepoRelPath(target, 'addFiles target');
    assertTrackedBlobAt(sourceOid, srcRel, 'addFiles source');
  }
  for (const [target, srcRel] of Object.entries(manifest.overlays || {})) {
    if (target.indexOf('_comment') === 0) continue;
    assertTrackedBlobAt(sourceOid, srcRel, 'overlay source');
    assertTargetInFrozenTreeAndKeepList(sourceOid, keepSet, target, 'overlay target');
  }
  for (const r of manifest.replacements || []) {
    if (typeof r !== 'object' || r === null) continue; // skip "_comment: ..." string entries
    assertTrackedBlobAt(sourceOid, r.findFile, 'replacement findFile');
    assertTrackedBlobAt(sourceOid, r.replaceFile, 'replacement replaceFile');
    assertTargetInFrozenTreeAndKeepList(sourceOid, keepSet, r.file, 'replacement target');
  }
}

// W22-U2: exportDir is now created by the CALLER (main() / buildExportForPathListing()) so it can enter
// a single try/finally that covers this function too (codex #12 -- previously this function's own
// fs.mkdtempSync ran OUTSIDE any try/finally, so a tar/archive failure inside it leaked the directory).
function step1_archiveMainToTemp(exportDir, manifest, sourceOid, keep) {
  log('exporting frozen source ' + sourceOid + ' tree -> ' + exportDir);
  // MED fix (review §7): archive ONLY the files that will survive step2's exclude filter -- computed
  // by computeKeepList() via the EXACT SAME matchesAny(exclude)/matchesAny(excludeExceptions) logic
  // step2 applies -- instead of archiving the full private tree (including paid-tier/excluded source)
  // and excluding only after extraction. Previously, excluded content existed in plaintext on disk
  // (inside `.__archive.tar`, and then as real extracted files) for the whole window between this
  // function and step2; a process death in that window left the plaintext paid-tier content behind in
  // a leftover temp dir (see the historical evidence in step0's comment). Filtering at archive time
  // means the tar this script ever writes to disk never contains excluded content in the first place,
  // so an interruption at ANY point after this function returns cannot leak it. step2 still runs
  // afterward as a redundant safety net (it should now always report removed=0) rather than being
  // deleted outright, so a bug in this filter fails closed -- ships nothing extra rather than silently
  // sending paid-tier files to `public` -- instead of failing open.
  //
  // (Tried first and rejected: `git archive -- . ':(exclude,glob)<pattern>' ...`, i.e. pathspec
  // exclusion at the git-archive call itself. Verified empirically that git pathspec exclude/include
  // sets do NOT support "re-including" a single file inside an otherwise-excluded glob regardless of
  // pathspec order -- manifest.excludeExceptions' one entry, guards/fixtures/v3/trigger-write-gate-
  // probe.cjs, was dropped by every pathspec ordering tried. Resolving the file list in JS first, via
  // the shared exclude/exception matcher, then handing `git archive` a literal list of exact paths
  // (no glob semantics needed at the git layer at all) avoids that gap entirely and was verified
  // byte-for-byte identical to the old archive-then-exclude file set.)
  const archiveTar = path.join(exportDir, '.__archive.tar');
  const out = git(['archive', '--format=tar', sourceOid, '--'].concat(keep), { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 });
  fs.writeFileSync(archiveTar, out);
  // --force-local: bsdtar/Windows tar otherwise reads a "C:\..." archive path as a "host:file" remote
  // spec because of the drive-letter colon. Forward-slash form additionally sidesteps MSYS's own
  // backslash-argv mangling when spawning the MSYS-bundled tar.exe without a shell.
  const toPosix = (p) => p.replace(/\\/g, '/');
  const tarRc = spawnSync('tar', ['--force-local', '-xf', toPosix(archiveTar), '-C', toPosix(exportDir)], { stdio: 'inherit' });
  if (tarRc.status !== 0) die('tar -xf failed extracting git archive output (status ' + tarRc.status + ')');
  fs.unlinkSync(archiveTar);
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

// W22-U2 (codex #6/#7): source content now comes from readFrozenBlob(sourceOid, ...) -- a `git cat-file
// blob` read against the frozen commit -- never fs.readFileSync against the working tree. Target path
// is validated (assertSafeRepoRelPath already ran in the pre-flight pass; re-checked here too since
// this function is independently unit-testable) before being joined onto exportDir.
function step3_applyAddFiles(exportDir, manifest, sourceOid) {
  let n = 0;
  for (const [target, srcRel] of Object.entries(manifest.addFiles || {})) {
    if (target.indexOf('_comment') === 0) continue;
    const safeTarget = assertSafeRepoRelPath(target, 'addFiles target');
    const buf = readFrozenBlob(sourceOid, srcRel, 'addFiles source');
    const dst = path.join(exportDir, safeTarget);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    n++;
  }
  log('addFiles: added ' + n + ' file(s) (read from frozen source ' + sourceOid + ')');
}

function step4_applyOverlays(exportDir, manifest, sourceOid) {
  let n = 0;
  for (const [target, srcRel] of Object.entries(manifest.overlays || {})) {
    if (target.indexOf('_comment') === 0) continue;
    const safeTarget = assertSafeRepoRelPath(target, 'overlay target');
    const buf = readFrozenBlob(sourceOid, srcRel, 'overlay source');
    const dst = path.join(exportDir, safeTarget);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    n++;
  }
  log('overlays: applied ' + n + ' full-content overlay(s) (read from frozen source ' + sourceOid + ')');
}

function step5_applyReplacements(exportDir, manifest, sourceOid) {
  let n = 0;
  for (const r of manifest.replacements || []) {
    if (typeof r !== 'object' || r === null) continue; // skip "_comment: ..." string entries
    const safeTarget = assertSafeRepoRelPath(r.file, 'replacement target');
    const targetPath = path.join(exportDir, safeTarget);
    if (!fs.existsSync(targetPath)) die('replacement target missing (excluded upstream of its own transform?): ' + r.file);
    // W22-U2 (codex #6): find/replace text read from the frozen blob, not fs.readFileSync -- this is
    // the actual fix for the CRLF fail-closed repro (a fresh `core.autocrlf=true` checkout used to
    // check these files out as CRLF, so the exact byte-for-byte find() below never matched).
    const find = readFrozenBlob(sourceOid, r.findFile, 'replacement findFile').toString('utf8');
    const replace = readFrozenBlob(sourceOid, r.replaceFile, 'replacement replaceFile').toString('utf8');
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
  log('replacements: applied ' + n + ' literal patch(es) (find/replace text read from frozen source ' + sourceOid + ')');
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

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// W22-U1 fix (codex #11, CONFIRMED): publish.manifest.json has always DECLARED a `sanitize.rules`
// array (id/description/pattern/flags/replace, plus 3 "kind"-based entries for the machine-derived
// username/hostname rules), but buildSanitizeRules() below never actually read it -- it re-derived an
// independent, hand-duplicated copy of the same 4 literal rules from scratch every time, so editing
// manifest.sanitize.rules (adding, changing, or removing a pattern) was a silent no-op. That is
// exactly the bug class finding #1 depended on staying invisible. compileSanitizeRule() now does the
// actual reading: every entry in manifest.sanitize.rules compiles into one or more live RegExp
// rules, and the 3 "kind"-based entries are where the machine-derived (os.userInfo()/os.hostname())
// + sanitizeLiteralFallback union logic now lives (previously correct in spirit but wired to a
// hardcoded list, not to the manifest's own declared rule ids).
function compileSanitizeRule(entry, manifest) {
  const id = entry.id;
  const fallback = (manifest && manifest.sanitizeLiteralFallback) || {};
  if (entry.kind === 'username-path' || entry.kind === 'username-bare') {
    const usernames = uniqStrings([os.userInfo().username].concat(fallback.usernames || []));
    return usernames.map((u) => {
      const userEsc = escRe(u);
      if (entry.kind === 'username-path') {
        return { id: id + ':' + u, declaredId: id, re: new RegExp('((?:[A-Za-z]:[\\\\/]|/)Users[\\\\/])' + userEsc + '([\\\\/])', 'g'), replace: '$1<user>$2' };
      }
      return { id: id + ':' + u, declaredId: id, re: new RegExp('(["\'`\\s(])' + userEsc + '(["\'`\\s).,;])', 'g'), replace: '$1<user>$2' };
    });
  }
  if (entry.kind === 'hostname') {
    const hostnames = uniqStrings([os.hostname()].concat(fallback.hostnames || []));
    return hostnames.map((h) => ({ id: id + ':' + h, declaredId: id, re: new RegExp('\\b' + escRe(h) + '\\b', 'g'), replace: '<mach>' }));
  }
  // Literal/pattern-based rule -- validateManifestSchema() already guaranteed a non-empty string
  // "pattern" and a string "replace" before this ever runs, so no defensive re-check needed here.
  return [{ id: id, declaredId: id, re: new RegExp(entry.pattern, entry.flags || 'g'), replace: entry.replace }];
}

function buildSanitizeRules(manifest) {
  const entries = (manifest && manifest.sanitize && manifest.sanitize.rules) || [];
  let rules = [];
  for (const entry of entries) {
    if (isCommentEntry(entry)) continue;
    rules = rules.concat(compileSanitizeRule(entry, manifest));
  }
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
  const allRules = buildSanitizeRules(manifest);
  // W22-U1 fix (codex #11): manifest.gates.residualScanPatterns was declared but never read -- GATE1
  // always scanned with the full compiled rule set regardless of what this field said, so removing an
  // id from it (or a maintainer expecting it to narrow the scan) changed nothing. Now an explicit
  // allow-list of declared sanitize.rules ids: present means "GATE1 checks exactly these ids" (each
  // compiled sub-rule carries its parent's declared id via .declaredId, so this filters correctly even
  // for the per-value username/hostname rules); absent/omitted means "check everything compiled".
  const allowedIds = manifest.gates && Array.isArray(manifest.gates.residualScanPatterns) ? new Set(manifest.gates.residualScanPatterns) : null;
  const rules = allowedIds ? allRules.filter((r) => allowedIds.has(r.declaredId)) : allRules;
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
  const tempHome = mkdtempMarked(path.join(os.tmpdir(), TEMP_PREFIX + 'home-'));
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
  const tempHome = mkdtempMarked(path.join(os.tmpdir(), TEMP_PREFIX + 'selftest-'));
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

// W22-U2 (codex #3): now takes the FROZEN sourceOid instead of re-resolving the mutable `main` branch
// name itself -- the whole point of resolveSourceOid() is that this check and the archive later in the
// same run see the exact same commit, even if something else moves `main` in between.
function checkOverlayDrift(manifest, sourceOid) {
  const targets = overlayTargets(manifest);
  const baselines = manifest.overlayBaselines || {};
  const drifted = [];
  for (const target of targets) {
    const expected = Object.prototype.hasOwnProperty.call(baselines, target) ? baselines[target] : null;
    const actual = blobShaAtRef(sourceOid, target);
    if (expected === null || actual === null || expected !== actual) {
      drifted.push({ target: target, expected: expected, actual: actual });
    }
  }
  if (drifted.length) {
    const lines = drifted.map((d) => '  - ' + d.target + ': baseline=' + (d.expected || '(none recorded)') + ' current source=' + (d.actual || '(missing at that path!)'));
    die(
      'GATE0 overlay drift: ' + drifted.length + ' overlay target(s) no longer match the baseline recorded in ' +
      'publish.manifest.json overlayBaselines -- the frozen source\'s own file at that path changed since the overlay ' +
      'content under publish-overrides/ (or README.public.md etc.) was last hand-reviewed against it, so the overlay may ' +
      'now silently ship stale content. Review the diff at each path below, refresh the overlay content if needed, ' +
      'then re-run with --update-overlay-baseline <target> --review-note "<text>" (once per reviewed target) to ' +
      'acknowledge and record the new baseline:\n' + lines.join('\n')
    );
  }
  log('GATE0 overlay drift: 0 drifted overlay target(s) of ' + targets.length + ' -- baselines match frozen source ' + sourceOid);
}

// W22-U2 (codex #2, replaces the old batch updateOverlayBaselines()): re-baselines exactly ONE overlay
// target per invocation, after an explicit, non-empty review note. Unlike the old function -- which
// JSON.stringify()'d and rewrote manifest.overlayBaselines in its entirety (a real +178/-57 diff on a
// 2-target ack, per the defense doc's repro, drowning the actual 2-line change) -- this edits the raw
// manifest TEXT surgically: only the one matched `"target": "sha"` substring changes, so the resulting
// file diff is exactly one line. Refuses: an unknown target, an empty/flag-like review note, an
// unchanged baseline (nothing to ack), a dirty on-disk manifest (unless a manifestPathOverride -- used
// only by tests -- points somewhere outside git entirely), or a manifest whose text does not contain
// exactly one occurrence of the target's baseline key (ambiguous -- refuses rather than risk touching
// the wrong line).
function updateOverlayBaseline(manifest, target, note, manifestPathOverride) {
  if (!note || typeof note !== 'string' || note.indexOf('-') === 0 || note.trim().length === 0) {
    die('--update-overlay-baseline requires a non-empty --review-note "<text>" (why you reviewed and accepted this one overlay\'s drift)');
  }
  const targets = overlayTargets(manifest);
  if (!targets.includes(target)) {
    die('--update-overlay-baseline: "' + target + '" is not a known overlay target in publish.manifest.json overlays (' + targets.join(', ') + ')');
  }
  const manifestPath = manifestPathOverride || MANIFEST_PATH;
  if (!manifestPathOverride) {
    let statusOut = '';
    try { statusOut = git(['status', '--porcelain', '--', 'publish.manifest.json']); } catch { statusOut = ''; }
    if (statusOut.trim().length > 0) {
      die('--update-overlay-baseline refuses to run: publish.manifest.json itself has uncommitted changes -- ' +
        'commit or discard them first so this surgical one-line edit starts from a known, reviewable state:\n' + statusOut);
    }
  }
  const sourceOid = resolveSourceOid('main');
  const actual = blobShaAtRef(sourceOid, target);
  const prev = manifest.overlayBaselines || {};
  const before = Object.prototype.hasOwnProperty.call(prev, target) ? prev[target] : null;
  if (before !== null && before === actual) {
    die('--update-overlay-baseline: "' + target + '" baseline already matches the frozen source (' + actual + ') -- nothing to update');
  }
  if (actual === null) die('--update-overlay-baseline: "' + target + '" does not exist at frozen source ' + sourceOid + ' -- cannot record a baseline for a missing path');

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const escKey = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineRe = new RegExp('("' + escKey + '"\\s*:\\s*")([0-9a-f]+)(")', 'g');
  const matches = raw.match(lineRe) || [];
  if (matches.length !== 1) {
    die('--update-overlay-baseline: expected exactly one occurrence of the "' + target + '" key in ' + manifestPath +
      ', found ' + matches.length + ' -- refusing a surgical edit that could touch the wrong line');
  }
  lineRe.lastIndex = 0;
  const next = raw.replace(lineRe, '$1' + actual + '$3');
  fs.writeFileSync(manifestPath, next, 'utf8');
  log('--update-overlay-baseline: "' + target + '" ' + (before || '(none recorded)') + ' -> ' + actual + ' (review note: ' + note + ')');
  return { target: target, before: before, after: actual, note: note };
}

// ---------------------------------------------------------------------------------------------
function treeHashOfDir(exportDir) {
  // Build a git tree object from exportDir's current on-disk state using a throwaway index file,
  // WITHOUT touching the real working tree/index of the repo (public/main stay untouched on disk).
  const idxDir = mkdtempMarked(path.join(os.tmpdir(), TEMP_PREFIX + 'idx-'));
  const tmpIndex = path.join(idxDir, 'index');
  const env = Object.assign({}, process.env, { GIT_INDEX_FILE: tmpIndex, GIT_WORK_TREE: exportDir, GIT_DIR: path.join(REPO_ROOT, '.git') });
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-A'], { cwd: exportDir, env });
  const tree = execFileSync('git', ['-c', 'core.autocrlf=false', 'write-tree'], { cwd: exportDir, env, encoding: 'utf8' }).trim();
  rmrf(idxDir);
  return tree;
}

// ---------------------------------------------------------------------------------------------
// W22-U1 GATE4 (codex #1/#11/#13, Opus defense unit U1 "独立最终树扫描"): an independently-coded
// scanner over the FINAL COMMITTED git tree object's raw blob bytes (git ls-tree + git cat-file
// against the tree treeHashOfDir() already built, never a working-directory walk), deliberately NOT
// reusing buildSanitizeRules()'s replacement loop -- codex #1's whole finding was that "sanitize and
// GATE1 scan share the same incomplete rule set" let a real leak report GATE1=0 for months. GATE4
// checks two manifest-declared lists (denylist.identityLiterals -- the same identity strings
// sanitize.rules already redacts, re-checked here as independent confirmation the redaction actually
// worked -- and denylist.internalNames -- private codenames/tags that have NO redaction rule at all
// by design, because the files that carried them are fully excluded or literal-patched instead), plus
// machine-derived username/hostname (kept as an ADDITIONAL source per spec, same union pattern as
// sanitize.rules' "kind" entries). It also refuses any non-blob tree entry (gitlink/submodule),
// any symlink (mode 120000), any unexpected file mode, and any NUL-containing blob not explicitly
// named in manifest.binaryAllowlist (codex #13: symlinks and binary/UTF-16 content bypassed
// step6_sanitize/gate1 entirely because walk() only visits fs.Dirent.isFile() and isProbablyText()
// treats any NUL byte as "not text, skip"). Every blob -- text OR binary/allowlisted -- is ALSO
// scanned for each pattern's raw UTF-16LE/BE byte encoding regardless of allowlist status: an
// allowlisted binary asset (e.g. a PDF/font) can still leak identity through UTF-16BE-encoded
// metadata strings (a real PDF /Info convention), so exempting allowlisted binaries from this second
// pass would reopen exactly the gap #13 closes for text files.
function buildGate4Patterns(manifest) {
  const fallback = (manifest && manifest.sanitizeLiteralFallback) || {};
  const usernames = uniqStrings([os.userInfo().username].concat(fallback.usernames || []));
  const hostnames = uniqStrings([os.hostname()].concat(fallback.hostnames || []));
  const patterns = [];
  for (const u of usernames) patterns.push({ id: 'identity:dynamic-username:' + u, text: u, mode: 'substring', caseSensitive: false });
  for (const h of hostnames) patterns.push({ id: 'identity:dynamic-hostname:' + h, text: h, mode: 'substring', caseSensitive: false });
  const identityLiterals = (manifest.denylist && manifest.denylist.identityLiterals) || [];
  for (const entry of identityLiterals) {
    if (isCommentEntry(entry)) continue;
    patterns.push({ id: 'identity:' + entry.id, text: entry.pattern, mode: entry.match || 'substring', caseSensitive: !!entry.caseSensitive });
  }
  const internalNames = (manifest.denylist && manifest.denylist.internalNames) || [];
  for (const entry of internalNames) {
    if (isCommentEntry(entry)) continue;
    patterns.push({ id: 'denylist:' + entry.id, text: entry.pattern, mode: entry.match || 'substring', caseSensitive: !!entry.caseSensitive });
  }
  return patterns;
}

function patternRegex(p) {
  const flags = 'g' + (p.caseSensitive ? '' : 'i');
  const escaped = escRe(p.text);
  return p.mode === 'word' ? new RegExp('\\b' + escaped + '\\b', flags) : new RegExp(escaped, flags);
}

function utf16leBuf(s) { return Buffer.from(s, 'utf16le'); }
function utf16beBuf(s) {
  const le = utf16leBuf(s);
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
  return be;
}

// Byte-level scan of ONE blob's raw content against every pattern: (a) a UTF-8/ASCII text regex pass
// (word-bounded or substring, case-(in)sensitive per pattern) and (b) a raw UTF-16LE/BE byte-substring
// containment pass, run unconditionally on every blob regardless of whether (a) found anything or
// whether the blob is on the binary allowlist -- see this function's caller for why.
function gate4ScanBlob(buf, patterns) {
  const hits = [];
  const utf8Text = buf.toString('utf8');
  for (const p of patterns) {
    if (patternRegex(p).test(utf8Text)) hits.push(p.id + ' (utf8)');
  }
  for (const p of patterns) {
    const le = utf16leBuf(p.text);
    if (le.length && buf.includes(le)) hits.push(p.id + ' (utf16le)');
    const be = utf16beBuf(p.text);
    if (be.length && buf.includes(be)) hits.push(p.id + ' (utf16be)');
  }
  return hits;
}

function gate4_finalTreeScan(treeHash, manifest) {
  const patterns = buildGate4Patterns(manifest);
  const binaryAllowlist = ((manifest.binaryAllowlist || []).filter((p) => !isCommentEntry(p)));
  const lsOut = git(['ls-tree', '-r', treeHash]);
  const lines = lsOut.split('\n').filter(Boolean);
  const findings = [];
  for (const line of lines) {
    const m = line.match(/^(\d+) (\S+) ([0-9a-f]+)\t(.*)$/);
    if (!m) { findings.push({ path: '(unparseable)', issue: 'GATE4 could not parse ls-tree line: ' + line }); continue; }
    const mode = m[1], type = m[2], sha = m[3], filePath = m[4];
    if (type !== 'blob') { findings.push({ path: filePath, issue: 'refused: non-blob tree entry (type=' + type + ', mode=' + mode + ') -- gitlink/submodule not allowed in the public export' }); continue; }
    if (mode === '120000') { findings.push({ path: filePath, issue: 'refused: symlink (mode 120000) not allowed in the public export' }); continue; }
    if (mode !== '100644' && mode !== '100755') { findings.push({ path: filePath, issue: 'refused: unexpected file mode ' + mode }); continue; }
    const buf = git(['cat-file', 'blob', sha], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 });
    if (buf.includes(0) && !matchesAny(filePath, binaryAllowlist)) {
      findings.push({ path: filePath, issue: 'refused: binary blob (contains a NUL byte) not on manifest.binaryAllowlist' });
    }
    for (const hit of gate4ScanBlob(buf, patterns)) findings.push({ path: filePath, issue: 'identity/denylist match: ' + hit });
  }
  log('GATE4 final-tree scan: ' + lines.length + ' tree entr(ies) checked against ' + patterns.length + ' pattern(s), ' + findings.length + ' finding(s)');
  return findings;
}

// ---------------------------------------------------------------------------------------------
// W22-U1 GATE5 (codex #4/#14, Opus U1 "path allowlist快照"): the exported tree's path list must
// exactly match a maintainer-reviewed baseline file (manifest.publicPathSnapshot.file). Both lists
// are ordered with a case-insensitive sort key (so ordering is stable and diffable regardless of a
// platform's own string-sort semantics for mixed-case paths), but the actual pass/fail comparison is
// an EXACT (case-preserving) string match at every position, over the full array (never a
// de-duplicated Set) -- this is what makes both required failure modes fire: an added/removed path
// changes the array length; a same-count CASE-ONLY rename (e.g. `docs/Readme.md` replacing
// `docs/README.md`) changes a string at one position without changing the length, and would be
// invisible to a purely lowercase-folded comparison (folding both sides to the same key makes them
// look identical) -- exact comparison is what actually catches it. This also still closes codex #4's
// case-variant-escape gap (e.g. a stray `Scripts/x.cjs` next to an excluded `scripts/**`): that is
// simply an EXTRA array entry, which the length/content check catches regardless of case.
function pathSortKey(p) { return p.toLowerCase() + '\u0000' + p; } // case-insensitive primary key, exact secondary tie-break

function computeExportedPathList(exportDir) {
  const files = [];
  walk(exportDir, '', files);
  return files.map((p) => p.replace(/\\/g, '/')).sort((a, b) => {
    const ka = pathSortKey(a), kb = pathSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function pathSnapshotFile(manifest) {
  const rel = manifest.publicPathSnapshot && manifest.publicPathSnapshot.file;
  if (!rel) die('publish.manifest.json: publicPathSnapshot.file is not set');
  return resolveManifestPath(rel);
}

function readPathSnapshotFile(manifest) {
  const filePath = pathSnapshotFile(manifest);
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length > 0);
  return lines.sort((a, b) => { const ka = pathSortKey(a), kb = pathSortKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
}

function gate5_pathSnapshot(exportDir, manifest) {
  const filePath = pathSnapshotFile(manifest);
  const expected = readPathSnapshotFile(manifest);
  if (expected === null) die('GATE5 path snapshot: ' + filePath + ' does not exist -- run `node scripts/publish-public.cjs --update-path-snapshot --reason "<text>"` once to establish the baseline');
  const current = computeExportedPathList(exportDir);
  let same = current.length === expected.length;
  if (same) { for (let i = 0; i < current.length; i++) { if (current[i] !== expected[i]) { same = false; break; } } }
  if (!same) {
    die(
      'GATE5 path snapshot mismatch: exported tree has ' + current.length + ' path(s), baseline (' + filePath + ') has ' + expected.length + ' (exact, case-preserving full-list compare over a case-insensitively-sorted order -- catches an added/removed path AND a same-count case-only rename/escape). ' +
      'Review the exported path list, then re-run `node scripts/publish-public.cjs --update-path-snapshot --reason "<text>"` to see the exact +/- diff and record the new baseline.'
    );
  }
  log('GATE5 path snapshot: OK (' + current.length + ' path(s) match baseline ' + filePath + ')');
}

// Builds a throwaway export (steps 1-6 only, no gates/commit) purely to read off the resulting path
// list -- addFiles/overlays can add paths main's own tree never had, so the baseline must reflect the
// FULLY assembled export dir, not just step1's keep-list. W22-U2: now takes the frozen `sourceOid` and
// runs the SAME pre-flight validation pass as the real export, and creates its own exportDir with a
// single try/finally covering step1 onward (same shape as main(), codex #12).
function buildExportForPathListing(manifest, sourceOid) {
  const keepList = computeKeepList(sourceOid, manifest);
  validateManifestInputsAgainstFrozenSource(sourceOid, manifest, keepList);
  const { runDir, exportDir } = createMarkedExportDir(path.join(os.tmpdir(), TEMP_PREFIX + 'src-'));
  try {
    step1_archiveMainToTemp(exportDir, manifest, sourceOid, keepList);
    step2_applyExclude(exportDir, manifest);
    step3_applyAddFiles(exportDir, manifest, sourceOid);
    step4_applyOverlays(exportDir, manifest, sourceOid);
    step5_applyReplacements(exportDir, manifest, sourceOid);
    step6_sanitize(exportDir, manifest);
    return computeExportedPathList(exportDir);
  } finally {
    rmrfRetrying(runDir, 3);
  }
}

function updatePathSnapshot(manifest, reason, sourceOid) {
  const filePath = pathSnapshotFile(manifest);
  const before = readPathSnapshotFile(manifest) || [];
  const after = buildExportForPathListing(manifest, sourceOid);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((p) => !beforeSet.has(p));
  const removed = before.filter((p) => !afterSet.has(p));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, after.join('\n') + '\n', 'utf8');
  log('--update-path-snapshot: wrote ' + after.length + ' path(s) to ' + filePath + ' (reason: ' + reason + ')');
  log('  +' + added.length + ' added, -' + removed.length + ' removed:');
  for (const p of added) log('    + ' + p);
  for (const p of removed) log('    - ' + p);
}

// ---------------------------------------------------------------------------------------------
// W22-U2 (blind spot 1): every publish INPUT the export reads (the manifest itself, all of
// publish-overrides/, and every individual overlay/addFiles/replacement source path even when it lives
// outside publish-overrides/, e.g. README.public.md) is collected here so checkInputsClean() can ask
// git whether any of them has an uncommitted change. Note this collection is used ONLY for the dirty
// check -- the actual read, everywhere else in this file, is always via readFrozenBlob() against the
// frozen OID, so even a --allow-dirty-inputs run never ships an uncommitted edit.
function collectInputPathsForDirtyCheck(manifest) {
  const set = new Set();
  set.add('publish.manifest.json');
  set.add('publish-overrides');
  for (const v of Object.values(manifest.addFiles || {})) { if (typeof v === 'string') set.add(v); }
  for (const v of Object.values(manifest.overlays || {})) { if (typeof v === 'string') set.add(v); }
  for (const r of manifest.replacements || []) {
    if (r && typeof r === 'object') {
      if (r.findFile) set.add(r.findFile);
      if (r.replaceFile) set.add(r.replaceFile);
    }
  }
  return Array.from(set);
}

// W22-U2 (blind spot 1, "working-tree来源(已复现)"): refuses to export while any publish input has an
// uncommitted change, UNLESS --allow-dirty-inputs is passed -- and even then, every actual read in this
// file goes through readFrozenBlob() against the frozen OID, so the uncommitted edit is never what
// ships; --allow-dirty-inputs only downgrades an unrelated-dirty-file annoyance from fatal to a logged
// warning (and a commit-message trailer, added by the caller) instead of silently including the edit.
function checkInputsClean(manifest, allowDirty) {
  const paths = collectInputPathsForDirtyCheck(manifest);
  let out = '';
  try { out = git(['status', '--porcelain', '--'].concat(paths)); } catch (e) { out = ''; }
  const dirtyLines = out.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0);
  if (dirtyLines.length === 0) return { dirty: [], allowed: false };
  const listing = dirtyLines.map((l) => '  ' + l).join('\n');
  if (!allowDirty) {
    die(
      'refusing to export: the working tree has uncommitted changes to one or more publish inputs ' +
      '(manifest / publish-overrides/** / an overlay or addFiles source) -- an export must be built ' +
      'entirely from a committed source, never a mix of committed code and an uncommitted edit:\n' +
      listing + '\nCommit or discard these changes, or re-run with --allow-dirty-inputs to proceed anyway ' +
      '(the export will still read only the last COMMITTED version of every input -- the uncommitted edit(s) ' +
      'will NOT be included, and this exception will be recorded in the commit message).'
    );
  }
  log('WARNING: --allow-dirty-inputs set -- proceeding despite uncommitted changes to these publish input(s) ' +
    '(the COMMITTED blob is what will actually be read, not the working-tree edit):\n' + listing);
  return { dirty: dirtyLines, allowed: true };
}

function commitOntoPublic(exportDir, privateShortSha, orphan, precomputedTree, allowedDirtyInputs) {
  const newTree = precomputedTree || treeHashOfDir(exportDir);
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
  let msg = 'publish: ' + privateShortSha + ' ' + date;
  // W22-U2 (blind spot 1): --allow-dirty-inputs is noted in the commit message trailer, per spec, so the
  // exception is auditable from `git log` alone rather than only from the run's own stdout.
  if (allowedDirtyInputs) {
    msg += '\n\nNote: --allow-dirty-inputs was set for this run -- the working tree had uncommitted ' +
      'changes to one or more publish inputs at run time, but this export was still built entirely from ' +
      'the frozen source commit above (the uncommitted edits were NOT included).';
  }
  // [Builder W9, 2026-09-25] --orphan (Jax ruling): `public`'s prior two commits carried
  // un-sanitized content and must disappear from reachable history entirely, not just from the
  // working tree of a new commit built on top of them. Every export in this mode is therefore a
  // single parentless commit -- `public`'s history is always exactly 1 commit deep, never a chain --
  // so nothing from before this rebuild stays reachable once the ref is force-moved. Non-orphan mode
  // (the default) keeps the normal chained-commit behavior for ordinary republishes.
  const parentArgs = orphan ? [] : (publicHead ? ['-p', publicHead] : []);
  const newCommit = execFileSync('git', ['commit-tree', newTree].concat(parentArgs, ['-m', msg]), { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/public', newCommit]);
  log('created commit ' + newCommit + ' on `public` (tree ' + newTree + (orphan ? ', orphan -- no parent' : (publicHead ? ', parent ' + publicHead : ', first commit')) + '): ' + msg.split('\n')[0]);
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

// W22-U2 (codex #12): the exportDir lifecycle -- create it, then a SINGLE try/finally covering step1
// onward -- extracted out of main() so it is independently unit-testable (see
// tests/publish-source-freeze.test.cjs's "early step1 failure leaves no temp dir behind" test) without
// having to invoke the full argv-driven main() (which would also touch `public`/push). Previously step1
// created (and could fail inside) its own mkdtemp'd dir OUTSIDE any try/finally, so a tar/archive
// failure there leaked the directory; now exportDir is created here, before the try, and step1 is the
// FIRST call inside it, so any failure from step1 onward is guaranteed to reach the finally cleanup.
function runExportCore(frozenManifest, sourceOid, keepList, sourceShortSha, orphan, push, allowedDirtyInputs) {
  const { runDir, exportDir } = createMarkedExportDir(path.join(os.tmpdir(), TEMP_PREFIX + 'src-'));
  try {
    step1_archiveMainToTemp(exportDir, frozenManifest, sourceOid, keepList);
    step2_applyExclude(exportDir, frozenManifest);
    step3_applyAddFiles(exportDir, frozenManifest, sourceOid);
    step4_applyOverlays(exportDir, frozenManifest, sourceOid);
    step5_applyReplacements(exportDir, frozenManifest, sourceOid);
    step6_sanitize(exportDir, frozenManifest);

    const residual = gate1_residualScan(exportDir, frozenManifest);
    if (residual !== 0) die('GATE1 residual scan found ' + residual + ' match(es) -- aborting, no commit made');

    const g2 = gate2_installLayoutSelfTest(exportDir, frozenManifest);
    if (!g2) die('GATE2 install-layout self-test failed -- aborting, no commit made');

    const g3 = gate3_npmSelftest(exportDir);
    if (!g3) die('GATE3 npm run selftest failed -- aborting, no commit made');

    // Tree hash computed ONCE here and threaded through to both GATE4 and commitOntoPublic, so the
    // object GATE4 scans (and GATE5 measures paths from, via exportDir which is what produced it) is
    // provably the exact same tree that gets committed -- not a second, separately-recomputed one.
    const newTree = treeHashOfDir(exportDir);

    const g4 = gate4_finalTreeScan(newTree, frozenManifest);
    if (g4.length) die('GATE4 final-tree scan found ' + g4.length + ' finding(s), aborting, no commit made:\n' + g4.map((f) => '  - ' + f.path + ': ' + f.issue).join('\n'));

    gate5_pathSnapshot(exportDir, frozenManifest);

    const result = commitOntoPublic(exportDir, sourceShortSha, orphan, newTree, allowedDirtyInputs);

    if (push) {
      const remoteName = ensurePublicRemote(frozenManifest);
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
    return result;
  } finally {
    // MED fix (review §7): retry-with-backoff + explicit separate reporting, so a cleanup failure
    // never masquerades as (or gets masked by) the export's own success/failure. This finally block
    // now actually runs on every die() path too -- see die()'s comment -- which it did not before, and
    // (W22-U2, codex #12) now also runs on a failure INSIDE step1 itself, since the run dir is created
    // before this try and step1 is the first call inside it. Cleans up `runDir` (the marker's own
    // parent), not just `exportDir` (its `tree/` subdirectory), so the marker's directory itself never
    // becomes an unmarked leftover.
    const cleanup = rmrfRetrying(runDir, 3);
    if (cleanup.ok) {
      log('cleanup: removed export dir ' + runDir + (cleanup.attempts > 1 ? (' (attempt ' + cleanup.attempts + ')') : ''));
    } else {
      process.stderr.write('[publish-public] CLEANUP FAILED after ' + cleanup.attempts + ' attempt(s): could not remove ' + runDir + ' -- ' + (cleanup.error && cleanup.error.message) + '\n');
      process.stderr.write('[publish-public] Remove this directory by hand. (Contents are the filtered export tree only -- excluded/paid-tier files were never archived into it, per step1 -- but it should not be left on disk.)\n');
      // Reported and flagged separately from EXPORT_TREE/DONE above: if the export itself succeeded,
      // those log lines already printed and remain true. This only marks the OVERALL run non-clean.
      process.exitCode = 1;
    }
  }
}

function main() {
  step0_cleanupStaleTemp();
  const manifest = readManifest();

  // W22-U2 (codex #2): the old batch flag now dies with a pointer to its replacement instead of
  // silently doing something different than a maintainer used to typing it might expect.
  if (process.argv.includes('--update-overlay-baselines')) {
    die('--update-overlay-baselines has been replaced -- it used to rewrite the ENTIRE overlayBaselines ' +
      'block in one shot (a real +178/-57 diff on a 2-target ack, drowning the actual change -- codex #2). ' +
      'Use `node scripts/publish-public.cjs --update-overlay-baseline <target> --review-note "<text>"` once ' +
      'per overlay you have actually reviewed.');
  }

  // MED-3 fix: --update-overlay-baseline is a standalone, explicit "I have reviewed the drift for THIS
  // ONE target, and here is why" action -- it does NOT also run the export in the same invocation.
  if (process.argv.includes('--update-overlay-baseline')) {
    const idx = process.argv.indexOf('--update-overlay-baseline');
    if (process.argv.indexOf('--update-overlay-baseline', idx + 1) !== -1) {
      die('--update-overlay-baseline may only be passed once per invocation (exactly one target) -- run it once per overlay you have reviewed.');
    }
    const target = process.argv[idx + 1];
    if (!target || target.indexOf('-') === 0) die('--update-overlay-baseline requires exactly one target path immediately after the flag');
    const noteIdx = process.argv.indexOf('--review-note');
    const note = noteIdx !== -1 ? process.argv[noteIdx + 1] : null;
    updateOverlayBaseline(manifest, target, note);
    log('DONE (baseline updated for "' + target + '" -- re-run without this flag to export)');
    return;
  }

  // W22-U1: --update-path-snapshot is the GATE5 analogue of --update-overlay-baseline above -- a
  // standalone, explicit "I have reviewed the path-set change" action that does not also run the
  // export. Requires --reason so the manifest.publicPathSnapshot._comment's re-baseline instructions
  // can't be followed reflexively without the operator writing down WHY the path set changed.
  if (process.argv.includes('--update-path-snapshot')) {
    const reasonIdx = process.argv.indexOf('--reason');
    const reason = reasonIdx !== -1 ? process.argv[reasonIdx + 1] : null;
    if (!reason || reason.indexOf('-') === 0) die('--update-path-snapshot requires a non-empty --reason "<text>" (why the public path set changed)');
    const sourceOidForSnapshot = resolveSourceOid('main');
    const frozenManifestForSnapshot = readManifest(sourceOidForSnapshot);
    updatePathSnapshot(frozenManifestForSnapshot, reason, sourceOidForSnapshot);
    log('DONE (path snapshot updated -- re-run without this flag to export)');
    return;
  }

  // ---- Real export from here: everything below reads from ONE frozen source OID (W22-U2). ----
  const sourceOid = resolveSourceOid('main');
  const frozenManifest = readManifest(sourceOid);

  const allowDirtyInputs = process.argv.includes('--allow-dirty-inputs');
  const dirtyResult = checkInputsClean(frozenManifest, allowDirtyInputs);

  // GATE0, runs before anything is archived/exported/committed (see checkOverlayDrift()'s comment).
  checkOverlayDrift(frozenManifest, sourceOid);

  const keepList = computeKeepList(sourceOid, frozenManifest);
  // W22-U2 ("before any write"): every addFiles/overlay/replacement source and target validated against
  // the frozen tree + keep-list BEFORE step1 archives a single byte.
  validateManifestInputsAgainstFrozenSource(sourceOid, frozenManifest, keepList);

  const push = process.argv.includes('--push');
  const orphan = process.argv.includes('--orphan') || frozenManifest.history === 'orphan';
  const sourceShortSha = git(['rev-parse', '--short', sourceOid]).trim();
  log('source: frozen ' + sourceOid + ' (' + sourceShortSha + ')' + (orphan ? ' (orphan history mode)' : ''));

  runExportCore(frozenManifest, sourceOid, keepList, sourceShortSha, orphan, push, dirtyResult.allowed);
}

// Exposed for unit-testing individual pieces (e.g. checkOverlayDrift, buildSanitizeRules,
// gate1_residualScan) via require() against a fixture repo, WITHOUT triggering the auto-run below --
// require.main !== module in that case. Behavior when invoked as `node scripts/publish-public.cjs`
// (require.main === module) is unchanged.
module.exports = {
  REPO_ROOT,
  buildSanitizeRules,
  gate1_residualScan,
  step6_sanitize,
  checkOverlayDrift,
  updateOverlayBaseline,
  overlayTargets,
  blobShaAtRef,
  readManifest,
  validateManifestSchema,
  buildGate4Patterns,
  gate4_finalTreeScan,
  computeExportedPathList,
  pathSnapshotFile,
  gate5_pathSnapshot,
  updatePathSnapshot,
  resolveManifestPath,
  git,
  main,
  // W22-U2 exports, primarily for tests/publish-source-freeze.test.cjs:
  resolveSourceOid,
  assertSafeRepoRelPath,
  lsTreeEntryAt,
  assertTrackedBlobAt,
  assertTargetInFrozenTreeAndKeepList,
  readFrozenBlob,
  computeKeepList,
  validateManifestInputsAgainstFrozenSource,
  checkInputsClean,
  collectInputPathsForDirtyCheck,
  step1_archiveMainToTemp,
  step3_applyAddFiles,
  step4_applyOverlays,
  step5_applyReplacements,
  buildExportForPathListing,
  commitOntoPublic,
  runExportCore,
  step0_cleanupStaleTemp,
  mkdtempMarked,
  createMarkedExportDir,
  writeRunMarker,
  isPidAlive,
  TEMP_PREFIX,
  RUN_MARKER_FILENAME,
  STALE_MS,
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
