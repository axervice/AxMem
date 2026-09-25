#!/usr/bin/env node
// pmm-win32-path-safety.cjs — Windows filename-safety utilities (2026-09-24 open-core cut extraction).
// Pure, side-effect-free leaf module — no require() of anything but the two functions below need.
//
// These two functions used to live inside guards/pmm-core.cjs (the causal shadow-memory engine, which
// moved to AxMem Pro / a commercial license and is not part of this open-core repo). They are plain
// Windows path-string hygiene, unrelated to that engine's own graph/analysis logic, and
// guards/pmm-isolation-gate.cjs (kept, base tier) needs them for its own DUT-basename normalization —
// so they were extracted verbatim (byte-identical function bodies, no behavior change) into this small
// standalone module rather than removed along with the rest of guards/pmm-core.cjs.
'use strict';

// Windows Alternate Data Stream (ADS) suffix strip: `lessons.md:$DATA` / `lessons.md::$DATA` (both the
// default-stream spellings CreateFile accepts) resolve to the exact same bytes as the bare `lessons.md`
// file on disk. A genuinely different named stream (`lessons.md:evil`) is left untouched — that is a
// distinct file's data, not an alias for the default stream.
function stripWin32AdsSuffix(p) {
  const s = String(p);
  const lastSep = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const dir = lastSep === -1 ? '' : s.slice(0, lastSep + 1);
  const last = lastSep === -1 ? s : s.slice(lastSep + 1);
  const ci = last.indexOf(':');
  if (ci === -1) return s;
  const base = last.slice(0, ci);
  const stream = last.slice(ci); // includes the leading ':' (":$DATA" or "::$DATA" or a genuine ":name")
  if (!/^:?:\$data$/i.test(stream)) return s; // a genuinely different named stream — leave untouched
  return dir + base; // default data stream — same bytes as the bare file, strip the suffix entirely
}

// Windows silently strips trailing '.' and ' ' characters from the FINAL path component when resolving
// a file/directory for real I/O (a legacy DOS/CreateFile compatibility quirk) — `lessons.md.` and
// `lessons.md ` (and any mix, `lessons.md. . `) on disk are both literally `lessons.md`.
// path.win32.normalize() does NOT implement this (it leaves a trailing `.`/space on the last segment
// untouched). Only the LAST segment is touched — a segment that IS ENTIRELY `.`/`..`/empty keeps its
// traversal meaning and is left alone (stripping it would corrupt `..` into nothing).
function stripWin32TrailingDotSpace(p) {
  const s = String(p);
  const lastSep = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const dir = lastSep === -1 ? '' : s.slice(0, lastSep + 1);
  const last = lastSep === -1 ? s : s.slice(lastSep + 1);
  if (last === '.' || last === '..' || last === '') return s;
  const stripped = last.replace(/[. ]+$/, '');
  return stripped === '' ? s : dir + stripped;
}

module.exports = { stripWin32AdsSuffix, stripWin32TrailingDotSpace };
