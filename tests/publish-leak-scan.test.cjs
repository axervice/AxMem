#!/usr/bin/env node
// tests/publish-leak-scan.test.cjs -- W22-U1 unit tests for scripts/publish-public.cjs's manifest
// schema validation and the new GATE4 (independent final-tree identity/denylist scan) and GATE5
// (exported path-list snapshot).
//
// EXCLUDED from the public export (see publish.manifest.json's exclude list,
// "_comment_PUBLISH_LEAK_SCAN_TEST"): it requires scripts/publish-public.cjs and
// publish.manifest.json, both of which are private-only. Deliberately does NOT contain the literal
// string "--self-test" so bin/axmem's component-selftest auto-discovery (grep -q -- '--self-test')
// never sweeps it in even if it were ever run against an unfiltered source tree.
//
// Everything here operates against a git tree/blob built with plumbing commands (hash-object,
// update-index --cacheinfo, write-tree) under a throwaway GIT_INDEX_FILE -- never against any real
// ref/branch of this repo, and never against the real working tree. No file this test writes lands
// outside a mkdtemp'd scratch directory.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pp = require('../scripts/publish-public.cjs');
const REPO_ROOT = pp.REPO_ROOT;

// ---------------------------------------------------------------------------------------------
// W22-U3 follow-up (incident, 2026-09-26): added to all three publish-*.test.cjs files after
// tests/publish-push-hygiene.test.cjs, run directly against a real checkout, moved that repo's actual
// `refs/heads/public` three times before restoring it (see that file's header for the full incident).
// This file never moves a ref and never touches config (its own header above already documents that
// design choice), but its `write-tree` calls DO write loose tree objects into REPO_ROOT's object
// database -- not a pure read, so it is classified as write-capable rather than read-only, and gets the
// same fail-closed gate as publish-push-hygiene.test.cjs rather than a "never writes" exemption.
(function guardAgainstRealRepoCwd() {
  let remotesRaw = '';
  try { remotesRaw = execFileSync('git', ['remote', '-v'], { cwd: REPO_ROOT, encoding: 'utf8' }); } catch { remotesRaw = ''; }
  if (remotesRaw.indexOf('github.com/axervice/') !== -1 && !process.env.AXMEM_TEST_ALLOW_REAL_REPO_CWD) {
    process.stderr.write('tests/publish-leak-scan.test.cjs: refusing to run -- REPO_ROOT (' + REPO_ROOT + ') has a remote pointing at a real axervice/* repo. This suite writes loose objects into the repo it runs against and must run from a disposable clone with `origin` removed. Set AXMEM_TEST_ALLOW_REAL_REPO_CWD=1 to override.\n');
    process.exit(2);
  }
})();

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
    console.log('  ok   ' + label + ' -> ' + String(e.message || e).slice(0, 100));
  }
}

// ---------------------------------------------------------------------------------------------
// git plumbing helpers -- build blobs/trees in THIS repo's own object database without touching any
// ref, branch, or the working tree/index.
function hashObject(buf) {
  return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: REPO_ROOT, input: buf }).toString('utf8').trim();
}

function buildTree(entries) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-idx-'));
  const tmpIndex = path.join(tmpDir, 'index');
  const env = Object.assign({}, process.env, { GIT_INDEX_FILE: tmpIndex, GIT_DIR: path.join(REPO_ROOT, '.git') });
  for (const e of entries) {
    execFileSync('git', ['update-index', '--add', '--cacheinfo', e.mode + ',' + e.sha + ',' + e.testPath], { cwd: REPO_ROOT, env });
  }
  const tree = execFileSync('git', ['write-tree'], { cwd: REPO_ROOT, env, encoding: 'utf8' }).trim();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return tree;
}

function blobEntry(testPath, content, mode) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { testPath, mode: mode || '100644', sha: hashObject(buf) };
}

// A minimal, self-contained fixture manifest -- deliberately NOT the real publish.manifest.json, so
// these tests stay stable even as the real denylist/identity lists evolve.
const fixtureManifest = {
  sanitizeLiteralFallback: { usernames: ['zzz-fixture-user'], hostnames: ['ZZZ-FIXTURE-HOST'] },
  denylist: {
    identityLiterals: [
      { id: 'lan-ip', pattern: '10.99.99.99', match: 'substring', caseSensitive: false },
    ],
    internalNames: [
      { id: 'looprig', pattern: 'looprig', match: 'substring', caseSensitive: false },
      { id: 'dee-project', pattern: 'Dee', match: 'word', caseSensitive: false },
    ],
  },
  binaryAllowlist: ['assets/**'],
};

console.log('== manifest schema validation ==');
{
  const base = { $schema: 'x', version: 1, exclude: [], sanitize: { rules: [{ id: 'r1', pattern: 'a', flags: 'g', replace: 'b' }] } };
  check('valid minimal manifest passes', (() => { try { pp.validateManifestSchema(JSON.parse(JSON.stringify(base))); return true; } catch { return false; } })());

  expectThrows('unknown top-level field is rejected', () => {
    pp.validateManifestSchema(Object.assign({}, base, { totallyUnknownField: 1 }));
  });

  expectThrows('duplicate rule id in sanitize.rules is rejected', () => {
    const m = JSON.parse(JSON.stringify(base));
    m.sanitize.rules.push({ id: 'r1', pattern: 'c', flags: 'g', replace: 'd' });
    pp.validateManifestSchema(m);
  });

  expectThrows('empty pattern in denylist.internalNames is rejected', () => {
    const m = JSON.parse(JSON.stringify(base));
    m.denylist = { internalNames: [{ id: 'x', pattern: '' }] };
    pp.validateManifestSchema(m);
  });

  expectThrows('duplicate id across denylist.identityLiterals is rejected', () => {
    const m = JSON.parse(JSON.stringify(base));
    m.denylist = { identityLiterals: [{ id: 'dup', pattern: 'a' }, { id: 'dup', pattern: 'b' }] };
    pp.validateManifestSchema(m);
  });

  // The real manifest itself must validate cleanly.
  check('real publish.manifest.json passes schema validation', (() => { try { pp.readManifest(); return true; } catch (e) { console.log('    (real manifest error: ' + e.message + ')'); return false; } })());
}

console.log('== GATE4: final-tree scan ==');
{
  const clean = blobEntry('clean.txt', 'nothing interesting here\n');
  const denylistHit = blobEntry('leak.txt', 'internal note: mentions looprig directly\n');
  const tree1 = buildTree([clean, denylistHit]);
  const findings1 = pp.gate4_finalTreeScan(tree1, fixtureManifest);
  check('denylist match found and names the offending path', findings1.some((f) => f.path === 'leak.txt' && /denylist:looprig/.test(f.issue)));
  check('clean file produces no finding', !findings1.some((f) => f.path === 'clean.txt'));

  // UTF-16LE encoded denylist string, with no NUL-detection interference expected (NUL bytes are
  // expected in UTF-16 content, so this file will ALSO be flagged as an unallowlisted binary blob --
  // that is correct, fail-closed behavior; the assertion below just confirms the utf16 pattern match
  // itself also fires independently).
  const utf16Hit = blobEntry('leak-utf16.bin', Buffer.from('secret looprig marker', 'utf16le'));
  const tree2 = buildTree([clean, utf16Hit]);
  const findings2 = pp.gate4_finalTreeScan(tree2, fixtureManifest);
  check('UTF-16LE-encoded denylist string is caught', findings2.some((f) => f.path === 'leak-utf16.bin' && /denylist:looprig.*utf16le/.test(f.issue)));

  // Symlink entry (git mode 120000) must be refused outright.
  const symlinkEntry = { testPath: 'evil-link', mode: '120000', sha: hashObject(Buffer.from('/etc/passwd', 'utf8')) };
  const tree3 = buildTree([clean, symlinkEntry]);
  const findings3 = pp.gate4_finalTreeScan(tree3, fixtureManifest);
  check('symlink entry is refused', findings3.some((f) => f.path === 'evil-link' && /refused: symlink/.test(f.issue)));

  // NUL-containing blob NOT on binaryAllowlist must be refused.
  const nulBlob = blobEntry('stray.bin', Buffer.from('abc\x00def', 'utf8'));
  const tree4 = buildTree([clean, nulBlob]);
  const findings4 = pp.gate4_finalTreeScan(tree4, fixtureManifest);
  check('NUL-containing blob outside binaryAllowlist is refused', findings4.some((f) => f.path === 'stray.bin' && /refused: binary blob/.test(f.issue)));

  // NUL-containing blob ON the binaryAllowlist (assets/**) must NOT get the binary-refusal finding
  // (it is still scanned for identity/denylist byte patterns -- this one carries none).
  const allowedNulBlob = blobEntry('assets/logo.bin', Buffer.from('abc\x00def', 'utf8'));
  const tree5 = buildTree([clean, allowedNulBlob]);
  const findings5 = pp.gate4_finalTreeScan(tree5, fixtureManifest);
  check('NUL-containing blob ON binaryAllowlist is not refused for being binary', !findings5.some((f) => f.path === 'assets/logo.bin' && /refused: binary blob/.test(f.issue)));

  // word-bounded pattern ('Dee') must not fire on an ordinary word that merely contains it as a substring.
  const wordBoundaryNegative = blobEntry('deep.txt', 'this function recurses very deeply\n');
  const tree6 = buildTree([wordBoundaryNegative]);
  const findings6 = pp.gate4_finalTreeScan(tree6, fixtureManifest);
  check('word-bounded pattern does not false-positive on a containing word ("deep" vs "Dee")', !findings6.some((f) => /denylist:dee-project/.test(f.issue)));
  const wordBoundaryPositive = blobEntry('note.txt', 'ping Dee about the invoice\n');
  const tree7 = buildTree([wordBoundaryPositive]);
  const findings7 = pp.gate4_finalTreeScan(tree7, fixtureManifest);
  check('word-bounded pattern DOES fire on the exact word', findings7.some((f) => /denylist:dee-project/.test(f.issue)));

  // gitlink/submodule entries (mode 160000) are refused as non-blob.
  const tree8 = buildTree([clean, { testPath: 'vendor/sub', mode: '160000', sha: '1111111111111111111111111111111111111111' }]);
  const findings8 = pp.gate4_finalTreeScan(tree8, fixtureManifest);
  check('gitlink/submodule entry is refused as non-blob', findings8.some((f) => f.path === 'vendor/sub' && /refused: non-blob/.test(f.issue)));
}

console.log('== GATE5: path snapshot ==');
{
  function makeExportDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-export-'));
    for (const rel of files) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x');
    }
    return dir;
  }
  function makeSnapshotFixture(paths) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-snap-'));
    const file = path.join(dir, 'public-paths.snapshot.txt');
    fs.writeFileSync(file, paths.join('\n') + '\n', 'utf8');
    return { publicPathSnapshot: { file } };
  }

  const baseFiles = ['a.txt', 'b/c.txt'];
  const exportDirOk = makeExportDir(baseFiles);
  const manifestOk = makeSnapshotFixture(baseFiles);
  check('matching path list passes GATE5', (() => { try { pp.gate5_pathSnapshot(exportDirOk, manifestOk); return true; } catch (e) { console.log('    (unexpected: ' + e.message + ')'); return false; } })());

  const exportDirAdded = makeExportDir(baseFiles.concat(['extra-leaked-file.txt']));
  expectThrows('added file trips GATE5', () => pp.gate5_pathSnapshot(exportDirAdded, manifestOk));

  const exportDirCaseRenamed = makeExportDir(['A.txt', 'b/c.txt']); // 'a.txt' -> 'A.txt', same count
  expectThrows('same-count case-variant rename trips GATE5', () => pp.gate5_pathSnapshot(exportDirCaseRenamed, manifestOk));

  const manifestMissingBaseline = { publicPathSnapshot: { file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-nobase-')), 'absent.txt') } };
  expectThrows('missing baseline file trips GATE5', () => pp.gate5_pathSnapshot(exportDirOk, manifestMissingBaseline));
}

console.log('== --update-path-snapshot CLI guard ==');
{
  // main() itself is not invoked here (it would run the full export pipeline against the real repo).
  // Instead this directly re-checks the same argv-parsing rule main() applies, since that logic is a
  // few inline lines in main() rather than its own exported function -- this documents the required
  // behavior and would need updating in lockstep if that inline check is ever refactored out.
  function parseUpdatePathSnapshotArgs(argv) {
    if (!argv.includes('--update-path-snapshot')) return null;
    const reasonIdx = argv.indexOf('--reason');
    const reason = reasonIdx !== -1 ? argv[reasonIdx + 1] : null;
    if (!reason || reason.indexOf('-') === 0) throw new Error('--update-path-snapshot requires a non-empty --reason "<text>"');
    return reason;
  }
  expectThrows('--update-path-snapshot without --reason is refused', () => parseUpdatePathSnapshotArgs(['--update-path-snapshot']));
  expectThrows('--update-path-snapshot with --reason followed by another flag is refused', () => parseUpdatePathSnapshotArgs(['--update-path-snapshot', '--reason', '--push']));
  check('--update-path-snapshot with a real --reason is accepted', parseUpdatePathSnapshotArgs(['--update-path-snapshot', '--reason', 'testing']) === 'testing');
}

console.log('\npublish-leak-scan self-test ' + ok + '/' + total);
if (ok !== total) {
  console.error('FAILED: ' + failures.join('; '));
  process.exitCode = 1;
}
