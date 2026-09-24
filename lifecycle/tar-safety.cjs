#!/usr/bin/env node
// AxMem lifecycle — tar member safety validator. (P1 2.3, 2026-09-16)
// A raw USTAR/GNU-tar header parser (NOT a shell-out to `tar -tv` — that
// text format varies across implementations and a symlink target embedded
// in it is exactly the kind of thing a text scrape gets wrong). Reads
// every 512-byte header block directly and REJECTS the archive outright
// (never attempts to interpret/normalize) on anything spec §2.3 lists:
// absolute/drive/UNC/drive-relative paths, `..` components (either slash
// form), symlink/hardlink/chardev/blockdev/fifo entries, PAX extended
// headers (typeflag x/g) or GNU sparse/longname/longlink entries, ADS
// (alternate-data-stream) colons in a name, trailing dot/space, Windows
// reserved device names, path length > 240, member count > 10000, any
// single file > 64MB, total expanded size > 512MB, and case-folded
// (Windows-final-name) duplicate members.
'use strict';
const fs = require('fs');

const BLOCK = 512;
const MAX_MEMBERS = 10000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_PATH_LEN = 240;

const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// [sec M1] A numeric tar header field (we only ever use this for `size`)
// that fails to parse as a well-formed, non-negative, in-range integer is
// a hostile/corrupt header, not a "treat as 0" situation — silently
// coercing NaN/negative/overflowing values to 0 (the old behavior) let a
// crafted header's size field smuggle a negative or absurd number past
// every downstream cap check that assumes `size >= 0`. Thrown (never
// returned) so every call site is forced to either catch it explicitly
// or let it propagate — there is no silent-zero fallback path left.
class TarFieldError extends Error {}

function readOctal(buf, off, len) {
  const raw = buf.toString('latin1', off, off + len).replace(/\0.*$/, '').trim();
  if (raw === '') return 0;
  // GNU base-256 extension: high bit of the first byte set. [LOW] The
  // first byte's remaining 7 bits (after masking off the 0x80 sign/marker
  // bit) are significant magnitude, not padding — the previous version
  // started the shift-accumulate loop at i=1, silently discarding up to 7
  // bits of the encoded value. We do not attempt to interpret a
  // two's-complement-negative base-256 encoding (a real but rare GNU
  // variant): any value that would require it is, by construction here,
  // huge and gets caught by the safe-integer ceiling below instead of
  // being guessed at (D9: unprovable ⇒ refuse).
  if (buf[off] & 0x80) {
    let v = BigInt(buf[off] & 0x7f);
    for (let i = 1; i < len; i++) v = (v << BigInt(8)) | BigInt(buf[off + i]);
    if (v < BigInt(0) || v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TarFieldError(`base-256 field at offset ${off} out of safe-integer range`);
    }
    return Number(v);
  }
  // Plain octal field: require it to be ONLY octal digits. parseInt('-1',
  // 8) === -1 with no error and Number.isFinite(-1) === true, so a header
  // with a leading '-' byte previously sailed straight through as a
  // legitimate-looking negative size.
  if (!/^[0-7]+$/.test(raw)) {
    throw new TarFieldError(`illegal (non-octal-digit) field at offset ${off}: ${JSON.stringify(raw)}`);
  }
  const n = parseInt(raw, 8);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TarFieldError(`octal field at offset ${off} out of range: ${n}`);
  }
  return n;
}

function readStr(buf, off, len) {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return buf.toString('utf8', off, end);
}

function isAllZero(buf, off, len) {
  for (let i = off; i < off + len; i++) if (buf[i] !== 0) return false;
  return true;
}

// Parses ALL headers in `tarPath` and returns
// { ok: true, members: [{name, typeflag, size}] } |
// { ok: false, reason }
// `members` only ever includes typeflag '0'/'\0' (regular file) and '5'
// (directory) — anything else present makes the WHOLE parse fail (ok:false)
// per the "reject outright, never partially trust" rule.
function parseTar(tarPath) {
  let fd;
  try {
    fd = fs.openSync(tarPath, 'r');
  } catch (e) {
    return { ok: false, reason: `cannot open tar: ${e.message}` };
  }
  try {
    const stat = fs.fstatSync(fd);
    const totalSize = stat.size;
    let offset = 0;
    const members = [];
    let sawEnd = false;
    const header = Buffer.alloc(BLOCK);

    while (offset + BLOCK <= totalSize) {
      const n = fs.readSync(fd, header, 0, BLOCK, offset);
      if (n < BLOCK) break;
      offset += BLOCK;

      if (isAllZero(header, 0, BLOCK)) {
        sawEnd = true;
        break; // end-of-archive marker (two consecutive zero blocks, but one is enough to stop trusting further data)
      }

      const name = readStr(header, 0, 100);
      const magic = header.toString('latin1', 257, 263);
      const prefix = magic.startsWith('ustar') ? readStr(header, 345, 155) : '';
      const fullName = prefix ? `${prefix}/${name}` : name;
      const typeflag = String.fromCharCode(header[156] || 0);
      let size;
      try {
        size = readOctal(header, 124, 12);
      } catch (e) {
        if (e instanceof TarFieldError) return { ok: false, reason: `size field: ${e.message} (member "${readStr(header, 0, 100)}")` };
        throw e;
      }
      // [Opus L3, 2026-09-17] A second "size must be a non-negative safe
      // integer" check used to sit here as belt-and-suspenders alongside
      // readOctal() — removed as PROVABLY unreachable dead code, not just
      // untested: readOctal() (above) has exactly 3 return paths — empty
      // field -> 0; the GNU base-256 path, which throws unless
      // `0 <= v <= Number.MAX_SAFE_INTEGER` and only ever returns a value
      // inside that range; and the plain-octal path, which requires
      // `/^[0-7]+$/` (no sign, no non-digit byte can survive) and throws
      // unless `Number.isSafeInteger(n) && n >= 0`. Every path that
      // doesn't throw is therefore already a safe, non-negative integer —
      // this exact condition could never evaluate true. Sec M1's own
      // "before use" wording is still fully honored: the guarantee now
      // lives entirely in readOctal()'s own contract (verified above) with
      // no dead code implying a SECOND, independent defense that doesn't
      // actually exist.

      const REJECT_TYPES = {
        '1': 'hardlink', '2': 'symlink', '3': 'character device', '4': 'block device',
        '6': 'FIFO', '7': 'contiguous file (reserved type)',
        'x': 'PAX extended header', 'g': 'PAX global extended header',
        'L': 'GNU longname entry', 'K': 'GNU longlink entry', 'S': 'GNU sparse entry',
      };
      if (REJECT_TYPES[typeflag]) {
        return { ok: false, reason: `rejected member type '${typeflag}' (${REJECT_TYPES[typeflag]}) at name "${fullName}"` };
      }
      if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') {
        return { ok: false, reason: `unrecognized/unsupported tar member typeflag '${typeflag}' at name "${fullName}"` };
      }

      const nameCheck = validateMemberName(fullName);
      if (!nameCheck.ok) return { ok: false, reason: `${nameCheck.reason}: "${fullName}"` };

      members.push({ name: fullName, typeflag, size });

      if (typeflag === '0' || typeflag === '\0') {
        const dataBlocks = Math.ceil(size / BLOCK);
        offset += dataBlocks * BLOCK;
      }
    }

    if (members.length > MAX_MEMBERS) return { ok: false, reason: `member count ${members.length} exceeds ${MAX_MEMBERS}` };

    let totalExpanded = 0;
    const caseFolded = new Map();
    for (const m of members) {
      if (m.typeflag === '5') continue; // directories don't count toward file-size caps
      if (m.size > MAX_FILE_BYTES) return { ok: false, reason: `member "${m.name}" (${m.size} bytes) exceeds per-file cap ${MAX_FILE_BYTES}` };
      totalExpanded += m.size;
      const folded = m.name.toLowerCase();
      if (caseFolded.has(folded) && caseFolded.get(folded) !== m.name) {
        return { ok: false, reason: `case-folded (Windows-final-name) duplicate members: "${caseFolded.get(folded)}" vs "${m.name}"` };
      }
      caseFolded.set(folded, m.name);
    }
    if (totalExpanded > MAX_TOTAL_BYTES) return { ok: false, reason: `total expanded size ${totalExpanded} exceeds ${MAX_TOTAL_BYTES}` };

    return { ok: true, members, totalExpanded, sawEnd };
  } finally {
    fs.closeSync(fd);
  }
}

function validateMemberName(name) {
  if (!name) return { ok: false, reason: 'empty member name' };
  if (name.length > MAX_PATH_LEN) return { ok: false, reason: `path length ${name.length} exceeds ${MAX_PATH_LEN}` };
  // Absolute / drive / UNC / drive-relative rejection.
  if (name.startsWith('/') || name.startsWith('\\')) return { ok: false, reason: 'absolute path' };
  if (/^[A-Za-z]:/.test(name)) return { ok: false, reason: 'drive-letter path' };
  if (name.startsWith('\\\\') || name.startsWith('//')) return { ok: false, reason: 'UNC path' };
  // `..` traversal, either slash form, as a whole path segment. A single
  // TRAILING slash is a legitimate directory-entry convention (tar always
  // names directories this way) — strip exactly one before splitting so it
  // doesn't manifest as a spurious empty final segment; an empty segment
  // ANYWHERE else (a genuine double separator, e.g. "a//b") still rejects.
  const trimmed = name.replace(/[\\/]$/, '');
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'path traversal (..) component' };
  if (segments.some((s) => s === '')) return { ok: false, reason: 'empty path segment (double separator)' };
  // ADS (NTFS alternate data stream) colon anywhere in a path segment.
  if (name.includes(':')) return { ok: false, reason: 'colon in member name (ADS-style stream marker)' };
  // Windows forbids a trailing dot or space on any path segment.
  for (const seg of segments) {
    if (/[. ]$/.test(seg)) return { ok: false, reason: `segment "${seg}" ends with trailing dot/space (Windows-illegal)` };
    const base = seg.split('.')[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(base)) return { ok: false, reason: `segment "${seg}" is a Windows-reserved device name` };
  }
  return { ok: true };
}

module.exports = { parseTar, validateMemberName, MAX_MEMBERS, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_PATH_LEN, WINDOWS_RESERVED_NAMES };

// ---------------------------------------------------------------------------
// Self-test — builds small synthetic tar files BY HAND (raw header bytes),
// since the point of this validator is to catch shapes a well-behaved `tar`
// binary would never produce in the first place (a hostile/corrupted
// archive is the whole threat model).
// ---------------------------------------------------------------------------
function buildHeader(fields) {
  const h = Buffer.alloc(BLOCK);
  const writeStr = (off, len, s) => h.write(s, off, len, 'utf8');
  const writeOctal = (off, len, n) => h.write(n.toString(8).padStart(len - 1, '0'), off, len - 1, 'latin1');
  writeStr(0, 100, fields.name || '');
  writeOctal(100, 8, fields.mode || 0o644);
  writeOctal(108, 8, 0);
  writeOctal(116, 8, 0);
  if (fields.rawSizeField !== undefined) {
    // [sec M1 test support] Raw byte override for the size field so a
    // self-test can inject a byte sequence no legitimate writeOctal()
    // call would ever produce (e.g. a leading '-'), independent of
    // buildHeader's own normal encoding path.
    h.fill(0, 124, 124 + 12);
    Buffer.from(fields.rawSizeField, 'latin1').copy(h, 124, 0, Math.min(12, fields.rawSizeField.length));
  } else {
    writeOctal(124, 12, fields.size || 0);
  }
  writeOctal(136, 12, 0);
  h.write('        ', 148, 8, 'latin1'); // chksum placeholder (spaces) — parser doesn't verify chksum, only shape
  h.write(fields.typeflag || '0', 156, 1, 'latin1');
  writeStr(157, 100, fields.linkname || '');
  writeStr(257, 6, 'ustar\0');
  writeStr(263, 2, '00');
  writeStr(345, 155, fields.prefix || '');
  return h;
}

function buildTar(entries) {
  const parts = [];
  for (const e of entries) {
    parts.push(buildHeader(e));
    if (e.data) {
      const dataBuf = Buffer.from(e.data, 'utf8');
      parts.push(dataBuf);
      const pad = BLOCK - (dataBuf.length % BLOCK || BLOCK);
      if (pad > 0 && pad < BLOCK) parts.push(Buffer.alloc(pad));
    } else if (e.dataLen) {
      // [Opus L3 test support] Real zero-filled backing bytes of the
      // declared length, without building a dataLen-character JS string
      // first (e.data above) — used by the total-expanded-size-cap test,
      // where several members each need tens of MB of REAL backing data
      // so the parser's own offset tracking correctly lands on each
      // subsequent header (a declared-but-unbacked size, as the
      // single-oversized-file test below uses, only works for the LAST
      // entry in an archive — nothing needs to be read past it).
      parts.push(Buffer.alloc(e.dataLen));
      const pad = BLOCK - (e.dataLen % BLOCK || BLOCK);
      if (pad > 0 && pad < BLOCK) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}

function selfTest() {
  const os = require('os');
  const path = require('path');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-tar-safety-selftest-'));
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }
  function writeAndParse(entries) {
    const p = path.join(T, `t-${Math.random().toString(36).slice(2)}.tar`);
    fs.writeFileSync(p, buildTar(entries));
    return parseTar(p);
  }

  // 1. accept: a normal, well-formed small archive
  {
    const r = writeAndParse([
      { name: 'memory/', typeflag: '5', size: 0 },
      { name: 'memory/decisions.md', typeflag: '0', size: 5, data: 'hello' },
    ]);
    check('1 accept: well-formed archive', r.ok && r.members.length === 2);
  }

  // 2. reject: absolute path
  check('2 reject: absolute path', writeAndParse([{ name: '/etc/passwd', typeflag: '0', size: 0 }]).ok === false);

  // 3. reject: drive-letter path
  check('3 reject: drive-letter path', writeAndParse([{ name: 'C:/evil.txt', typeflag: '0', size: 0 }]).ok === false);

  // 4. reject: UNC path
  check('4 reject: UNC path', writeAndParse([{ name: '\\\\server\\share\\f.txt', typeflag: '0', size: 0 }]).ok === false);

  // 5. reject: path traversal (..)
  check('5 reject: path traversal ..', writeAndParse([{ name: 'memory/../../etc/passwd', typeflag: '0', size: 0 }]).ok === false);
  check('5b reject: path traversal .. (backslash form)', writeAndParse([{ name: 'memory\\..\\..\\evil', typeflag: '0', size: 0 }]).ok === false);

  // 6. reject: symlink
  check('6 reject: symlink', writeAndParse([{ name: 'memory/link', typeflag: '2', linkname: '/etc/passwd', size: 0 }]).ok === false);

  // 7. reject: hardlink
  check('7 reject: hardlink', writeAndParse([{ name: 'memory/hard', typeflag: '1', linkname: 'memory/decisions.md', size: 0 }]).ok === false);

  // 8. reject: device / FIFO
  check('8 reject: char device', writeAndParse([{ name: 'memory/dev', typeflag: '3', size: 0 }]).ok === false);
  check('8b reject: FIFO', writeAndParse([{ name: 'memory/fifo', typeflag: '6', size: 0 }]).ok === false);

  // 9. reject: PAX extended header / GNU longname
  check('9 reject: PAX extended header', writeAndParse([{ name: 'PaxHeaders/x', typeflag: 'x', size: 10, data: '10 path=x\n' }]).ok === false);
  check('9b reject: GNU longname', writeAndParse([{ name: '././@LongLink', typeflag: 'L', size: 10, data: 'long/name\0' }]).ok === false);

  // 10. reject: ADS colon
  check('10 reject: ADS colon', writeAndParse([{ name: 'memory/decisions.md:hidden', typeflag: '0', size: 0 }]).ok === false);

  // 11. reject: trailing dot/space, Windows reserved name
  check('11 reject: trailing dot', writeAndParse([{ name: 'memory/evil.', typeflag: '0', size: 0 }]).ok === false);
  check('11b reject: Windows reserved name', writeAndParse([{ name: 'memory/CON', typeflag: '0', size: 0 }]).ok === false);
  check('11c reject: Windows reserved name with extension', writeAndParse([{ name: 'memory/CON.txt', typeflag: '0', size: 0 }]).ok === false);

  // 12. reject: case-folded duplicate members
  check('12 reject: case-folded duplicate', writeAndParse([
    { name: 'memory/Decisions.md', typeflag: '0', size: 1, data: 'a' },
    { name: 'memory/decisions.md', typeflag: '0', size: 1, data: 'b' },
  ]).ok === false);

  // 13. reject: member count over cap
  {
    const entries = [];
    for (let i = 0; i < MAX_MEMBERS + 1; i++) entries.push({ name: `memory/f${i}`, typeflag: '0', size: 0 });
    check('13 reject: member count over cap', writeAndParse(entries).ok === false);
  }

  // 14. reject: single file over per-file cap (declared size, no real data needed for the header-shape check)
  check('14 reject: single file over 64MB cap', writeAndParse([{ name: 'memory/huge', typeflag: '0', size: MAX_FILE_BYTES + 1 }]).ok === false);

  // 15 (sec M1): a negative-looking size field ({ok:false}, no throw)
  {
    let threw = false;
    let r;
    try {
      r = writeAndParse([{ name: 'memory/evil-size', typeflag: '0', rawSizeField: '-1\0' }]);
    } catch (e) {
      threw = true;
    }
    check('15 (sec M1) negative-size header ("-1") -> {ok:false}, parseTar never throws', !threw && r && r.ok === false);
  }

  // 15b (sec M1): garbage (non-octal-digit) size field also rejected, not silently coerced to 0
  {
    let threw = false;
    let r;
    try {
      r = writeAndParse([{ name: 'memory/garbage-size', typeflag: '0', rawSizeField: 'garbage999\0' }]);
    } catch (e) {
      threw = true;
    }
    check('15b (sec M1) illegal non-octal size field -> {ok:false}, parseTar never throws', !threw && r && r.ok === false);
  }

  // 16 (Opus L3): total expanded size cap (512MB) — reached across SEVERAL
  // members each individually UNDER the 64MB per-file cap (test 14 only
  // covers a single oversized file; this cap has its own independent check
  // at a different point in parseTar and was never exercised on its own).
  // 8 members carry REAL 60MB backing data each (so the parser's offset
  // tracking correctly lands on every subsequent header); the 9th and
  // final member's size is declared only (no real backing data needed,
  // same trick test 14 uses, since nothing is read past the last entry).
  // 8*60 + 60 = 540MB > the 512MB cap, while every single member stays
  // under the 64MB per-file cap.
  {
    const bigLen = 60 * 1024 * 1024;
    const entries = [];
    for (let i = 0; i < 8; i++) entries.push({ name: `memory/big${i}`, typeflag: '0', size: bigLen, dataLen: bigLen });
    entries.push({ name: 'memory/big8', typeflag: '0', size: bigLen });
    const r = writeAndParse(entries);
    check('16 (Opus L3) total expanded size over 512MB cap (reached across several under-64MB-cap members)', r.ok === false && /total expanded size/.test(r.reason));
  }

  // 17 (Opus L3): path length cap (240 chars) — via the ustar prefix+name
  // split (prefix up to 155 bytes + '/' + name up to 100 bytes), since a
  // single header's raw `name` field alone caps at 100 bytes and can never
  // reach 240 on its own.
  {
    const prefix = 'p'.repeat(150);
    const name = 'n'.repeat(95); // fullName = 150 + 1 + 95 = 246 > 240
    const r = writeAndParse([{ name, prefix, typeflag: '0', size: 0 }]);
    check('17 (Opus L3) path length over the 240-char cap rejected', r.ok === false && /path length/.test(r.reason));
  }

  // 18 (Opus L3): GNU sparse entry (typeflag 'S') explicitly rejected —
  // REJECT_TYPES lists it alongside PAX/longname/longlink (test 9/9b
  // cover those), but 'S' itself was never independently exercised.
  // Asserts the SPECIFIC "GNU sparse" reason text (not just ok:false),
  // since the generic unrecognized-typeflag fallback a few lines down
  // would also reject typeflag 'S' if it were ever removed from
  // REJECT_TYPES — the reason-text check is what actually makes this
  // test provably red against that specific removal, not just against
  // the archive being accepted.
  {
    const r18 = writeAndParse([{ name: 'memory/sparse', typeflag: 'S', size: 0 }]);
    check("18 (Opus L3) reject: GNU sparse entry (typeflag 'S'), named specifically in the reason", r18.ok === false && /GNU sparse/.test(r18.reason));
  }

  console.log(results.join('\n'));
  console.log(`tar-safety self-test ${ok}/24`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === 24 ? 0 : 1;
}

if (require.main === module && process.argv[2] === '--self-test') {
  process.exit(selfTest());
}
