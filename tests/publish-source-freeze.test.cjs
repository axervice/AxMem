#!/usr/bin/env node
// tests/publish-source-freeze.test.cjs -- W22-U2 unit tests for scripts/publish-public.cjs's source-OID
// freezing, frozen-blob input reads, per-target overlay baseline updates, the marker-aware stale-temp
// sweep, and cleanup-on-early-failure.
//
// EXCLUDED from the public export (see publish.manifest.json's exclude list): it requires
// scripts/publish-public.cjs and publish.manifest.json, both private-only, same rationale as
// tests/publish-leak-scan.test.cjs (W22-U1). Deliberately does NOT contain the literal string
// "--self-test" so bin/axmem's component-selftest auto-discovery (grep -q -- '--self-test') never
// sweeps it in.
//
// A few of these tests deliberately dirty a REAL tracked file in this repo's own working tree
// (publish-overrides/patches/pmm-size-watch.1.find.txt, publish.manifest.json) to exercise the
// dirty-input gate against real `git status`. Every such test restores the original bytes in a
// try/finally and asserts `git status --porcelain` is clean again afterward -- no test here leaves the
// repo dirty. No test moves the real `main`/`public` refs of this clone; the source-freezing (TOCTOU)
// test instead builds a synthetic, never-referenced commit object (a `git commit-tree` result that no
// branch points at) to prove reads are pinned to an explicit OID rather than a live re-resolution of
// `main`.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pp = require('../scripts/publish-public.cjs');
const REPO_ROOT = pp.REPO_ROOT;

// W22-U2 follow-up: this suite's own TOCTOU test builds a real commit object via `git commit-tree`,
// which -- unlike every other plumbing command this file uses (hash-object/update-index/write-tree/
// ls-tree/rev-parse/status) -- requires a configured author/committer identity. This clone happened to
// have a local `user.name`/`user.email` set, masking that every git call this test makes needs its OWN
// self-sufficient identity: the real repo (and CI) will not have one, and `git commit-tree` fails
// fail-closed with "unable to auto-detect email address" rather than silently using something wrong.
// Every git invocation below (via gitCwd, and the one raw hash-object call) gets this env: fixed
// GIT_AUTHOR_*/GIT_COMMITTER_* identity, GIT_CONFIG_NOSYSTEM=1, and HOME/USERPROFILE pointed at a
// throwaway scratch directory -- so no host-level (or even repo-level, since NOSYSTEM+a fake HOME means
// neither /etc/gitconfig nor ~/.gitconfig are consulted) git config can leak in or be depended on.
const TEST_GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-githome-'));
const GIT_TEST_ENV = Object.assign({}, process.env, {
  HOME: TEST_GIT_HOME,
  USERPROFILE: TEST_GIT_HOME,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'axmem-test',
  GIT_AUTHOR_EMAIL: 'axmem-test@example.invalid',
  GIT_COMMITTER_NAME: 'axmem-test',
  GIT_COMMITTER_EMAIL: 'axmem-test@example.invalid',
});

let ok = 0;
let total = 0;
const failures = [];

function check(label, cond) {
  total++;
  if (cond) { ok++; console.log('  ok   ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label); }
}

function expectThrows(label, fn) {
  total++;
  try {
    fn();
    failures.push(label + ' (did not throw)');
    console.log('  FAIL ' + label + ' (did not throw)');
  } catch (e) {
    ok++;
    console.log('  ok   ' + label + ' -> ' + String(e.message || e).slice(0, 120));
  }
}

function gitCwd(args, opts) {
  // GIT_TEST_ENV is always the base env for every git call this file makes; a caller-supplied
  // opts.env (e.g. the TOCTOU test's GIT_INDEX_FILE/GIT_DIR for its throwaway plumbing) is layered on
  // TOP of it (opts.env never itself carries the identity keys, so they always survive the merge).
  const merged = Object.assign({ cwd: REPO_ROOT, encoding: 'utf8' }, opts || {});
  merged.env = Object.assign({}, GIT_TEST_ENV, (opts && opts.env) || {});
  return execFileSync('git', args, merged);
}

// ---------------------------------------------------------------------------------------------
console.log('== assertSafeRepoRelPath / assertTrackedBlobAt: path safety ==');
{
  const sourceOid = pp.resolveSourceOid('main');

  expectThrows('absolute path is refused', () => pp.assertSafeRepoRelPath('/etc/passwd', 'test'));
  expectThrows('Windows drive-absolute path is refused', () => pp.assertSafeRepoRelPath('C:\\Windows\\system.ini', 'test'));
  expectThrows('".." traversal is refused', () => pp.assertSafeRepoRelPath('../outside-secret.txt', 'test'));
  expectThrows('nested ".." traversal is refused', () => pp.assertSafeRepoRelPath('guards/../../outside.txt', 'test'));
  expectThrows('".git" path segment is refused', () => pp.assertSafeRepoRelPath('.git/config', 'test'));
  check('an ordinary relative path passes', (() => { try { pp.assertSafeRepoRelPath('guards/pmm-isolation-gate.cjs', 'test'); return true; } catch { return false; } })());

  expectThrows('addFiles source ".git/config" is refused (does not exist as a tracked blob either way)', () => pp.assertTrackedBlobAt(sourceOid, '.git/config', 'addFiles source'));
  expectThrows('addFiles source "../x" is refused', () => pp.assertTrackedBlobAt(sourceOid, '../x', 'addFiles source'));
  expectThrows('a path that does not exist at the frozen source is refused', () => pp.assertTrackedBlobAt(sourceOid, 'this-file-does-not-exist-anywhere.txt', 'test'));
  check('a real tracked file resolves to a 100644 blob entry', (() => {
    const entry = pp.assertTrackedBlobAt(sourceOid, 'publish.manifest.json', 'test');
    return entry && entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
  })());
}

console.log('== step3_applyAddFiles: bad manifest addFiles sources are refused before any write ==');
{
  const sourceOid = pp.resolveSourceOid('main');
  const exportDirX = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-addfiles-'));
  try {
    expectThrows('addFiles source ".git/config" is refused', () => pp.step3_applyAddFiles(exportDirX, { addFiles: { 'evil.cjs': '.git/config' } }, sourceOid));
    expectThrows('addFiles source "../x" is refused', () => pp.step3_applyAddFiles(exportDirX, { addFiles: { 'evil2.cjs': '../x' } }, sourceOid));
    check('neither refused addFiles entry wrote anything into the export dir', fs.readdirSync(exportDirX).length === 0);
  } finally {
    fs.rmSync(exportDirX, { recursive: true, force: true });
  }
}

console.log('== assertTargetInFrozenTreeAndKeepList: overlay/patch target must exist AND pass the keep-list ==');
{
  const sourceOid = pp.resolveSourceOid('main');
  expectThrows('overlay target not in keep-list is refused', () => {
    // README.md genuinely exists at the frozen source, but this keep-list pretends it was excluded.
    pp.assertTargetInFrozenTreeAndKeepList(sourceOid, new Set(['some/other/file.txt']), 'README.md', 'overlay target');
  });
  expectThrows('overlay target missing from the frozen tree entirely is refused', () => {
    pp.assertTargetInFrozenTreeAndKeepList(sourceOid, new Set(['nonexistent-file.txt']), 'nonexistent-file.txt', 'overlay target');
  });
  check('overlay target that exists AND is in the keep-list passes', (() => {
    try { pp.assertTargetInFrozenTreeAndKeepList(sourceOid, new Set(['README.md']), 'README.md', 'overlay target'); return true; }
    catch (e) { console.log('    (unexpected: ' + e.message + ')'); return false; }
  })());
}

// ---------------------------------------------------------------------------------------------
console.log('== checkInputsClean: dirty publish input is refused; --allow-dirty-inputs still reads the COMMITTED blob ==');
{
  const sourceOid = pp.resolveSourceOid('main');
  const patchRelPath = 'publish-overrides/patches/pmm-size-watch.1.find.txt';
  const patchAbsPath = path.join(REPO_ROOT, patchRelPath);
  const originalBuf = fs.readFileSync(patchAbsPath);
  try {
    fs.writeFileSync(patchAbsPath, Buffer.concat([originalBuf, Buffer.from('\nUNCOMMITTED-EDIT-MARKER\n', 'utf8')]));
    const manifest = pp.readManifest(); // disk manifest -- only used here to enumerate input paths

    expectThrows('dirty patch file blocks the export by default', () => pp.checkInputsClean(manifest, false));

    let result = null;
    check('--allow-dirty-inputs proceeds instead of throwing', (() => {
      try { result = pp.checkInputsClean(manifest, true); return true; }
      catch (e) { console.log('    (unexpected throw: ' + e.message + ')'); return false; }
    })());
    check('the dirty path is named in the result', !!(result && result.dirty.some((l) => l.indexOf('pmm-size-watch.1.find.txt') !== -1)));
    check('the result is marked "allowed"', !!(result && result.allowed === true));

    const frozenBuf = pp.readFrozenBlob(sourceOid, patchRelPath, 'test');
    check('readFrozenBlob returns the COMMITTED content, not the uncommitted edit', frozenBuf.toString('utf8').indexOf('UNCOMMITTED-EDIT-MARKER') === -1);
    check('readFrozenBlob content is byte-identical to the original committed file', Buffer.compare(frozenBuf, originalBuf) === 0);
  } finally {
    fs.writeFileSync(patchAbsPath, originalBuf);
  }
  const statusAfter = gitCwd(['status', '--porcelain', '--', patchRelPath]);
  check('the patch file is restored to a clean state', statusAfter.trim() === '');
}

// ---------------------------------------------------------------------------------------------
console.log('== resolveSourceOid: pinned via env override, never a live re-resolution of `main` (TOCTOU) ==');
{
  const liveMain = gitCwd(['rev-parse', 'main']).trim();

  // Build a synthetic commit whose tree = live main's tree PLUS one marker file. It is created purely
  // via plumbing (hash-object/update-index/write-tree/commit-tree) into this repo's own object
  // database and is NEVER pointed at by any ref/branch -- `main`/`public` of this clone are untouched
  // throughout this test. This simulates "a concurrent process moved `main`" without actually doing so.
  const idxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-toctou-idx-'));
  const tmpIndex = path.join(idxDir, 'index');
  const env = Object.assign({}, process.env, { GIT_INDEX_FILE: tmpIndex, GIT_DIR: path.join(REPO_ROOT, '.git') });
  let syntheticCommit;
  try {
    gitCwd(['read-tree', 'main'], { env });
    const markerSha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: REPO_ROOT, env: GIT_TEST_ENV, input: 'w22-u2 toctou marker\n' }).toString('utf8').trim();
    gitCwd(['update-index', '--add', '--cacheinfo', '100644,' + markerSha + ',MARKER-OID-TEST.txt'], { env });
    const markerTree = gitCwd(['write-tree'], { env }).trim();
    syntheticCommit = gitCwd(['commit-tree', markerTree, '-p', 'main', '-m', 'w22-u2 test: synthetic marker commit (dangling, never referenced by any ref)']).trim();
  } finally {
    fs.rmSync(idxDir, { recursive: true, force: true });
  }

  check('synthetic commit is a real, distinct object from live main', syntheticCommit.length === 40 && syntheticCommit !== liveMain);
  check('live `main` ref itself was not moved by building the synthetic commit', gitCwd(['rev-parse', 'main']).trim() === liveMain);

  process.env.AXMEM_PUBLISH_SOURCE_OID = syntheticCommit;
  try {
    const pinned = pp.resolveSourceOid('main');
    check('resolveSourceOid returns the pinned OID via the env override, not a fresh resolution of "main"', pinned === syntheticCommit);

    const manifestForPinned = pp.readManifest(pinned);
    check('readManifest(pinned) succeeds against the frozen OID', !!manifestForPinned && typeof manifestForPinned === 'object');

    const keepPinned = pp.computeKeepList(pinned, manifestForPinned);
    check('keep-list computed from the PINNED oid includes the marker file (proves ls-tree/archive use the frozen OID, not a live re-resolution of `main`)', keepPinned.includes('MARKER-OID-TEST.txt'));

    const keepLive = pp.computeKeepList(liveMain, manifestForPinned);
    check('the marker file is genuinely absent from live `main` (sanity check that the two trees really differ)', !keepLive.includes('MARKER-OID-TEST.txt'));

    // What main() actually threads into the commit message is `git rev-parse --short <sourceOid>` --
    // computed from the pinned value, never a fresh `git rev-parse --short main`. Confirming these two
    // differ proves a commit built from the pinned OID would name a different sha in its message than
    // one built by re-resolving `main` live -- i.e. "the frozen OID is used everywhere and the commit
    // message names it".
    const shortPinned = gitCwd(['rev-parse', '--short', pinned]).trim();
    const shortLive = gitCwd(['rev-parse', '--short', liveMain]).trim();
    check('short sha derived from the pinned OID differs from live main\'s short sha', shortPinned !== shortLive);
  } finally {
    delete process.env.AXMEM_PUBLISH_SOURCE_OID;
  }
  check('env override cleared: resolveSourceOid("main") now resolves live main again', pp.resolveSourceOid('main') === liveMain);
}

// ---------------------------------------------------------------------------------------------
console.log('== updateOverlayBaseline: per-target ack, surgical one-line manifest edit ==');
{
  const sourceOid = pp.resolveSourceOid('main');
  const target = 'README.md';
  const actualSha = pp.blobShaAtRef(sourceOid, target);
  const staleSha = '0'.repeat(40);

  function makeScratchManifestFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-baseline-'));
    const file = path.join(dir, 'scratch.manifest.json');
    const content = [
      '{',
      '  "overlays": {',
      '    "README.md": "README.public.md",',
      '    "README.zh.md": "README.zh.public.md"',
      '  },',
      '  "overlayBaselines": {',
      '    "README.md": "' + staleSha + '",',
      '    "README.zh.md": "' + staleSha + '"',
      '  }',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }
  const manifestStale = { overlays: { 'README.md': 'README.public.md', 'README.zh.md': 'README.zh.public.md' }, overlayBaselines: { 'README.md': staleSha, 'README.zh.md': staleSha } };
  const manifestUpToDate = { overlays: { 'README.md': 'README.public.md' }, overlayBaselines: { 'README.md': actualSha } };

  expectThrows('empty review note is refused', () => pp.updateOverlayBaseline(manifestStale, target, '', makeScratchManifestFile()));
  expectThrows('missing review note is refused', () => pp.updateOverlayBaseline(manifestStale, target, null, makeScratchManifestFile()));
  expectThrows('flag-like review note is refused', () => pp.updateOverlayBaseline(manifestStale, target, '--push', makeScratchManifestFile()));
  expectThrows('unknown overlay target is refused', () => pp.updateOverlayBaseline(manifestStale, 'not-a-real-overlay.txt', 'reviewed', makeScratchManifestFile()));
  expectThrows('unchanged baseline is refused (nothing to update)', () => pp.updateOverlayBaseline(manifestUpToDate, target, 'reviewed', makeScratchManifestFile()));

  // Happy path: exactly one target acked, exactly one line of the manifest file changes.
  const scratchFile = makeScratchManifestFile();
  const before = fs.readFileSync(scratchFile, 'utf8');
  pp.updateOverlayBaseline(manifestStale, target, 'reviewed the README diff against frozen source', scratchFile);
  const after = fs.readFileSync(scratchFile, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  check('happy-path edit keeps the same total line count (no whole-file reformat)', beforeLines.length === afterLines.length);
  let changedLines = 0;
  for (let i = 0; i < beforeLines.length; i++) if (beforeLines[i] !== afterLines[i]) changedLines++;
  check('happy-path edit changes EXACTLY one line', changedLines === 1);
  check('the changed line now holds the real frozen-source blob sha', after.indexOf('"README.md": "' + actualSha + '"') !== -1);
  check('the OTHER overlay\'s baseline (README.zh.md, not the acked target) is untouched', after.indexOf('"README.zh.md": "' + staleSha + '"') !== -1);
}

console.log('== updateOverlayBaseline: refuses when the real publish.manifest.json is dirty ==');
{
  // NOTE: this repo's publish.manifest.json may ALREADY be legitimately dirty (e.g. mid-development of
  // this very unit, before its own commit) -- so "restored cleanly" is checked as "byte-identical to
  // whatever this test captured at its own start", never as "git shows zero diff overall" (that would
  // wrongly fail/pass depending on unrelated ambient repo state this test does not own).
  const manifestPath = path.join(REPO_ROOT, 'publish.manifest.json');
  const original = fs.readFileSync(manifestPath, 'utf8');
  try {
    fs.writeFileSync(manifestPath, original + '\n', 'utf8'); // trivial, harmless, reversible dirty edit
    const realManifest = pp.readManifest();
    expectThrows('dirty publish.manifest.json blocks --update-overlay-baseline (default manifest path)', () => pp.updateOverlayBaseline(realManifest, 'README.md', 'reviewed'));
  } finally {
    fs.writeFileSync(manifestPath, original, 'utf8');
  }
  const restored = fs.readFileSync(manifestPath, 'utf8');
  check('publish.manifest.json is restored byte-for-byte to this test\'s own starting content', restored === original);
}

console.log('== --update-overlay-baseline CLI guard (argv parsing, mirrors main(), same convention as the --update-path-snapshot guard test) ==');
{
  // main() is not invoked here -- it would run against live argv and could touch `public`. This
  // re-checks the same "exactly one target, non-empty --review-note" argv rule main() applies inline.
  function parseUpdateOverlayBaselineArgs(argv) {
    const idx = argv.indexOf('--update-overlay-baseline');
    if (idx === -1) return null;
    if (argv.indexOf('--update-overlay-baseline', idx + 1) !== -1) {
      throw new Error('--update-overlay-baseline may only be passed once per invocation (exactly one target)');
    }
    const target = argv[idx + 1];
    if (!target || target.indexOf('-') === 0) throw new Error('--update-overlay-baseline requires exactly one target path immediately after the flag');
    const noteIdx = argv.indexOf('--review-note');
    const note = noteIdx !== -1 ? argv[noteIdx + 1] : null;
    return { target: target, note: note };
  }
  expectThrows('flag passed twice ("two targets") is refused', () => parseUpdateOverlayBaselineArgs(['--update-overlay-baseline', 'README.md', '--update-overlay-baseline', 'guards/guard-canary.sh', '--review-note', 'x']));
  check('single target + note parses correctly', (() => {
    const r = parseUpdateOverlayBaselineArgs(['--update-overlay-baseline', 'README.md', '--review-note', 'looks fine']);
    return r.target === 'README.md' && r.note === 'looks fine';
  })());
}

// ---------------------------------------------------------------------------------------------
console.log('== step0_cleanupStaleTemp: marker-aware, symlink-safe sweep ==');
{
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-sweep-root-'));
  const prefix = pp.TEMP_PREFIX;
  let symlinkCreated = false;
  const symlinkPath = path.join(fakeRoot, prefix + 'src-symlink');
  try {
    const liveDir = path.join(fakeRoot, prefix + 'src-live');
    fs.mkdirSync(liveDir);
    fs.writeFileSync(path.join(liveDir, pp.RUN_MARKER_FILENAME), JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }));

    const deadDir = path.join(fakeRoot, prefix + 'src-dead');
    fs.mkdirSync(deadDir);
    fs.writeFileSync(path.join(deadDir, pp.RUN_MARKER_FILENAME), JSON.stringify({ pid: 999999, startedAtMs: Date.now() }));

    const oldAliveDir = path.join(fakeRoot, prefix + 'src-old-alive');
    fs.mkdirSync(oldAliveDir);
    fs.writeFileSync(path.join(oldAliveDir, pp.RUN_MARKER_FILENAME), JSON.stringify({ pid: process.pid, startedAtMs: Date.now() - (pp.STALE_MS + 60000) }));

    const noMarkerDir = path.join(fakeRoot, prefix + 'src-nomark');
    fs.mkdirSync(noMarkerDir);
    fs.writeFileSync(path.join(noMarkerDir, 'somefile.txt'), 'x');

    const symlinkTargetDir = path.join(fakeRoot, 'real-target-dir');
    fs.mkdirSync(symlinkTargetDir);
    fs.writeFileSync(path.join(symlinkTargetDir, 'precious.txt'), 'do-not-delete');
    try {
      fs.symlinkSync(symlinkTargetDir, symlinkPath, 'junction');
      symlinkCreated = true;
    } catch (e) {
      console.log('    (skipping symlink sub-case -- could not create a junction on this system: ' + (e && e.message) + ')');
    }

    check('isPidAlive is true for this test\'s own pid', pp.isPidAlive(process.pid) === true);
    check('isPidAlive is false for an implausible pid', pp.isPidAlive(999999) === false);

    pp.step0_cleanupStaleTemp(fakeRoot);

    check('live-pid, fresh-marker directory survives the sweep', fs.existsSync(liveDir));
    check('dead-pid marker directory is removed', !fs.existsSync(deadDir));
    check('marker older than 24h is removed even though its pid happens to be "alive"', !fs.existsSync(oldAliveDir));
    check('directory with no valid marker is left alone (never removed)', fs.existsSync(noMarkerDir));
    if (symlinkCreated) {
      check('symlink/junction masquerading as a run dir is not followed or removed', fs.existsSync(symlinkPath) || fs.lstatSync(symlinkPath, {}) !== undefined);
      check('the symlink\'s target directory and its contents are untouched by the sweep', fs.existsSync(path.join(symlinkTargetDir, 'precious.txt')));
    }
  } finally {
    if (symlinkCreated) { try { fs.unlinkSync(symlinkPath); } catch {} }
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
console.log('== runExportCore: an early step1 failure leaves no temp dir behind ==');
{
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.indexOf(pp.TEMP_PREFIX) === 0);

  // A syntactically-valid-looking but nonexistent 40-hex-char OID: step1's own `git archive` call
  // throws on it (execFileSync throws on nonzero exit), which is exactly the "step1 fails after the
  // temp dir already exists" scenario codex #12 identified -- git ls-tree/archive fail well after
  // runExportCore's mkdtempMarked() has already created the directory.
  const bogusOid = 'deadbeef'.repeat(5);
  let threw = false;
  try {
    pp.runExportCore({ history: 'orphan' }, bogusOid, ['some/file/that/does/not/matter.txt'], 'deadbee', true, false, false);
  } catch (e) {
    threw = true;
  }
  check('runExportCore actually throws for a bogus/nonexistent source OID', threw);

  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.indexOf(pp.TEMP_PREFIX) === 0);
  const newEntries = after.filter((n) => !before.includes(n));
  check('no new `axmem-publish-*` temp directory is left behind after the early failure', newEntries.length === 0);
  if (newEntries.length > 0) {
    console.log('    (leaked: ' + newEntries.join(', ') + ' -- cleaning up by hand)');
    for (const n of newEntries) fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true });
  }
}

try { fs.rmSync(TEST_GIT_HOME, { recursive: true, force: true }); } catch {}

// ---------------------------------------------------------------------------------------------
console.log('\npublish-source-freeze self-test ' + ok + '/' + total);
if (ok !== total) {
  console.error('FAILED: ' + failures.join('; '));
  process.exitCode = 1;
}
