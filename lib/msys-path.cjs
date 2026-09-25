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

// Win32 extended-length / device-namespace prefix strip.
// (2026-09-24, guards/audits/BORROW-MATRIX-2026-09-24-full.md group 8 —
// the 09-17 survey's "3-line gap" left unwired: `\\?\C:\...`/`\\.\C:\...`
// never matched MSYS_DRIVE_RE above, so normalizeMsysPath() returned it
// byte-for-byte unchanged. That was never a crash, but it meant this
// already-native path did NOT compare equal to its un-prefixed twin —
// a caller feeding both spellings to vendor/path-is-inside.cjs (plain
// lowercased string-prefix comparison, no prefix-awareness of its own;
// used by guards/pmm-trigger-write-gate.cjs, guards/pmm-core.cjs) would
// silently get two different containment verdicts for the exact same file.
//
// Two shapes, checked in this order (the UNC one MUST run first — it is a
// superset of the generic one below and would otherwise fall into the
// generic branch and get mangled into a bare `UNC\host\share\...` with no
// leading `\\`, which is not a valid path at all):
//   1. `\\?\UNC\<host>\<share>\...` / `\\.\UNC\<host>\...` — the Win32
//      extended-length spelling of a UNC path. Per Microsoft's own
//      "Naming Files, Paths, and Namespaces" docs this is ALWAYS exactly
//      `\\<host>\<share>\...`, regardless of whether <host> is this
//      machine or a remote one — a plain syntactic unwrap, unlike
//      guards/pmm-core.cjs's normalizeWin32UncAdminShare() (business logic
//      answering the DIFFERENT question "is this admin share actually my
//      own local drive", which this generic helper has no need to ask).
//   2. `\\?\C:\...` / `\\.\C:\...` — the plain device-namespace drive form.
//      Detection condition taken from jonschlinkert/normalize-path v3.0.0
//      index.js lines 19-27 (MIT,
//      https://github.com/jonschlinkert/normalize-path/blob/3.0.0/index.js),
//      the same boundary check already landed independently in
//      guards/pmm-core.cjs's stripWin32DeviceNamespacePrefix() (2026-09-17
//      HIGH-2) — reused verbatim here for the same reason: strip the
//      4-char prefix entirely (normalize-path's own upstream behavior
//      instead REWRITES it to a kept `//?/` marker for cross-platform glob
//      use; that is not this function's goal — this one needs a plain
//      native string that compares byte-equal to its un-prefixed twin).
const WIN32_UNC_DEVICE_RE = /^\\\\[?.]\\UNC\\(.+)$/i;
function stripWin32DeviceNamespacePrefix(p) {
  const s = String(p);
  const uncMatch = WIN32_UNC_DEVICE_RE.exec(s);
  if (uncMatch) return '\\\\' + uncMatch[1];
  if (s.length > 4 && s[3] === '\\' && (s[2] === '?' || s[2] === '.') && s.slice(0, 2) === '\\\\') {
    return s.slice(4);
  }
  return s;
}

// Converts an MSYS-style absolute path ("/c/foo/bar", "/c") to its native
// Windows form ("C:\foo\bar", "C:\"). Returns the input COMPLETELY
// UNCHANGED for: non-Windows platforms (this shape is only ever wrong on
// Windows — on real POSIX systems "/c/foo/bar" already means exactly what
// it says), non-string/empty input, relative paths, already-native paths
// ("C:\..."), and UNC-style paths ("//server/share") — this function only
// ever fixes the one specific, provably-wrong shape; it never guesses at
// anything else. A `\\?\`/`\\.\` device-namespace or UNC prefix is
// recognized as ALREADY native (see stripWin32DeviceNamespacePrefix()
// above) and returned immediately, before the MSYS check even runs — such
// a path never matches MSYS_DRIVE_RE (it doesn't start with a single
// leading "/") so there is nothing left for that check to do anyway.
function normalizeMsysPath(p) {
  if (typeof p !== 'string' || p === '') return p;
  if (process.platform !== 'win32') return p;
  const stripped = stripWin32DeviceNamespacePrefix(p);
  if (stripped !== p) return stripped;
  const m = MSYS_DRIVE_RE.exec(p);
  if (!m) return p;
  const drive = m[1].toUpperCase();
  const rest = (m[2] || '').replace(/\//g, '\\');
  return rest ? `${drive}:${rest}` : `${drive}:\\`;
}

module.exports = { normalizeMsysPath, stripWin32DeviceNamespacePrefix };

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

  // Group 8 fix (2026-09-24, guards/audits/BORROW-MATRIX-2026-09-24-full.md
  // group 8): a \\?\ / \\.\ / \\?\UNC\ prefixed path must normalize
  // byte-identical to its unprefixed twin, so that a downstream consumer
  // comparing containment via vendor/path-is-inside.cjs (a plain
  // lowercased string-prefix check with no prefix-awareness of its own)
  // reaches the SAME verdict regardless of which spelling it was handed.
  const pathIsInside = (() => { try { return require('../guards/vendor/path-is-inside.cjs'); } catch { return null; } })();

  check('9 \\\\?\\C:\\... device-namespace drive prefix normalizes byte-identical to its unprefixed twin; vendor/path-is-inside.cjs reports containment=true for both spellings against the same canonical dir',
    isWin
      ? (() => {
          const prefixed = normalizeMsysPath('\\\\?\\C:\\tmp\\canon\\file.txt');
          const plain = normalizeMsysPath('C:\\tmp\\canon\\file.txt');
          const canon = normalizeMsysPath('C:\\tmp\\canon');
          return prefixed === plain && !!pathIsInside && pathIsInside(prefixed, canon) === true && pathIsInside(plain, canon) === true;
        })()
      : normalizeMsysPath('\\\\?\\C:\\tmp\\canon\\file.txt') === '\\\\?\\C:\\tmp\\canon\\file.txt');

  check('10 \\\\?\\UNC\\... device-namespace UNC prefix unwraps to plain \\\\server\\share form byte-identical to its unprefixed twin; vendor/path-is-inside.cjs reports containment=true for both spellings against the same canonical dir',
    isWin
      ? (() => {
          const prefixed = normalizeMsysPath('\\\\?\\UNC\\server\\share\\file.txt');
          const plain = normalizeMsysPath('\\\\server\\share\\file.txt');
          const canon = normalizeMsysPath('\\\\server\\share');
          return prefixed === plain && !!pathIsInside && pathIsInside(prefixed, canon) === true && pathIsInside(plain, canon) === true;
        })()
      : normalizeMsysPath('\\\\?\\UNC\\server\\share\\file.txt') === '\\\\?\\UNC\\server\\share\\file.txt');

  console.log(results.join('\n'));
  console.log(`msys-path self-test ${ok}/10`);
  return ok === 10 ? 0 : 1;
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') {
    process.exit(selfTest());
  } else {
    process.stdout.write(normalizeMsysPath(process.argv[2] || ''));
  }
}
