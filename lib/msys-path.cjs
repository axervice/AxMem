#!/usr/bin/env node
// AxMem MSYS/Git-Bash path normalization helper. (P1 fix round, ts M6)
// On Windows, Git Bash / MSYS represents "C:\foo\bar" as "/c/foo/bar" in its
// own shell environment — bin/axmem and every core/*.sh script live entirely
// in that world. But every .cjs component here runs under a native Windows
// Node.js build, whose fs/path APIs do NOT understand that convention:
//   node -e "console.log(require('path').resolve('/c/tmp/foo'))"
//   -> "C:\c\tmp\foo"   (WRONG, and silent — no error is ever thrown)
// Node treats a leading "/" as "absolute from the current drive's root", not
// as an MSYS drive marker. Any AXMEM_* environment variable a user exports
// from a Git Bash session — the documented, expected way to configure this
// tool — is exactly the shape this bites: `AXMEM_STATE_DIR=/c/tmp/axstate`
// would silently put every state file under "C:\c\tmp\axstate" instead of
// "C:\tmp\axstate", with no error anywhere in the chain.
'use strict';

const MSYS_DRIVE_RE = /^\/([A-Za-z])(\/.*)?$/;

// Converts an MSYS-style absolute path ("/c/foo/bar", "/c") to its native
// Windows form ("C:\foo\bar", "C:\"). Returns the input COMPLETELY
// UNCHANGED for: non-Windows platforms (this shape is only ever wrong on
// Windows — on real POSIX systems "/c/foo/bar" already means exactly what
// it says), non-string/empty input, relative paths, already-native paths
// ("C:\..."), and UNC-style paths ("//server/share") — this function only
// ever fixes the one specific, provably-wrong shape; it never guesses at
// anything else.
function normalizeMsysPath(p) {
  if (typeof p !== 'string' || p === '') return p;
  if (process.platform !== 'win32') return p;
  const m = MSYS_DRIVE_RE.exec(p);
  if (!m) return p;
  const drive = m[1].toUpperCase();
  const rest = (m[2] || '').replace(/\//g, '\\');
  return rest ? `${drive}:${rest}` : `${drive}:\\`;
}

module.exports = { normalizeMsysPath };

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function selfTest() {
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  const isWin = process.platform === 'win32';

  check('1 /c/tmp/foo -> C:\\tmp\\foo on Windows (unchanged on non-Windows)',
    isWin ? normalizeMsysPath('/c/tmp/foo') === 'C:\\tmp\\foo' : normalizeMsysPath('/c/tmp/foo') === '/c/tmp/foo');
  check('2 bare drive /c -> C:\\ on Windows (unchanged on non-Windows)',
    isWin ? normalizeMsysPath('/c') === 'C:\\' : normalizeMsysPath('/c') === '/c');
  check('3 already-native C:\\tmp\\foo left byte-for-byte unchanged', normalizeMsysPath('C:\\tmp\\foo') === 'C:\\tmp\\foo');
  check('4 relative path left unchanged', normalizeMsysPath('tmp/foo') === 'tmp/foo');
  check('5 UNC-style //server/share left unchanged (not a single-drive-letter shape)', normalizeMsysPath('//server/share') === '//server/share');
  check('6 non-string / empty input passed through untouched (no throw)', normalizeMsysPath('') === '' && normalizeMsysPath(undefined) === undefined && normalizeMsysPath(null) === null);
  check('7 nested multi-segment path: /c/a/b/c -> C:\\a\\b\\c on Windows (unchanged on non-Windows)',
    isWin ? normalizeMsysPath('/c/a/b/c') === 'C:\\a\\b\\c' : normalizeMsysPath('/c/a/b/c') === '/c/a/b/c');
  check('8 two-letter-looking segment /co/foo is NOT drive-letter shaped, left unchanged', normalizeMsysPath('/co/foo') === '/co/foo');

  console.log(results.join('\n'));
  console.log(`msys-path self-test ${ok}/8`);
  return ok === 8 ? 0 : 1;
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') {
    process.exit(selfTest());
  } else {
    process.stdout.write(normalizeMsysPath(process.argv[2] || ''));
  }
}
