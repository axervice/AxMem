#!/usr/bin/env node
// AxMem redundancy-lint — four countable proxies for "this repeats itself,"
// ported from the production guard (P1 port, 2026-09-14).
// Honesty boundary: "repeated meaning" is a judgment call (machine judgment
// is the automation class that gets judged dead) — this gate only asks four
// COUNTING questions:
//   R1 intra-entry repeat: the same >=12-char window recurs >=2x in one body
//      (repeated wording/sentence)
//   R2 corpus copy: prose shares a >=40-char contiguous run with ANOTHER
//      entry's prose (write-discipline rule: a fact that already lives
//      elsewhere gets a [[tag]] reference, not a second copy) — applies to
//      every new entry
//   R3 filler words: locale-specific throat-clearing phrases (see AXMEM_FILLER
//      below)
//   R4 compression ratio: gzip(body)/len below a calibrated threshold =
//      high redundancy (language-agnostic repetition proxy)
// Blocking scope: R2/R3 -> every new entry; R1/R4 -> only entries carrying
// [sole-record] (that marker buys length exemption, so it must first prove
// the wording is already minimal).
// Usage: node redundancy-lint.cjs [--report] [--json]; exit 2 = a blocking
// hit exists (baseline semantics — "block only net-new" — are the caller's
// job, same as write-gate.sh's oversize-entry counter).
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const ctx = require('../lib/prelude.cjs');
const MEM = ctx.MEMORY_DIR;
const R1_MIN = Number(process.env.AXMEM_R1_MIN || 12);
const R1_HAN = Number(process.env.AXMEM_R1_HAN || 8);  // min Han (CJK) chars inside the window to count as a "phrase" (see calibration note below)
const R2_MIN = Number(process.env.AXMEM_R2_MIN || 40);
const R4_MAX = Number(process.env.AXMEM_R4_MAX || 0.62); // see --report for calibration; a gzip ratio above this is normal prose
// Filler-word list is LOCALE-SPECIFIC data, not logic — the default below is
// tuned for the Chinese-language memory corpus this gate was ported from.
// Override with env AXMEM_FILLER as a comma-separated list to match your own
// memory files' language/style (e.g. AXMEM_FILLER="in summary,it should be noted that").
const FILLER = process.env.AXMEM_FILLER
  ? process.env.AXMEM_FILLER.split(',').map(s => s.trim()).filter(Boolean)
  : ['首先,', '其次,', '综上所述', '不难发现', '值得注意的是', '总而言之', '众所周知', '毋庸置疑', '换句话说,', '需要指出的是'];

const files = ['decisions.md', 'lessons.md', 'standinginstructions.md'];
const entries = [];
for (const f of files) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  let cur = null;
  const flush = () => { if (cur) { entries.push(cur); cur = null; } };
  for (const line of s.split(/\r?\n/)) {
    const h = line.match(/^\*\*(20[^*]+)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
    if (h) { flush(); cur = { tag: h[2], file: f, sole: line.includes('[sole-record]'), ok: line.includes('[redundancy-ok]'), body: [] }; continue; }
    if (/^## /.test(line)) flush();
    if (!cur) continue;
    if (/^\s*(<!--|Ratified by:|Supersedes:|Superseded by:|Scope:|Reason:)/.test(line)) continue;
    if (line.startsWith('- 20')) continue;
    cur.body.push(line);
  }
  flush();
}
// Calibration (first live run, 82 hits): R2's "shared fragment" was almost
// entirely pointers/tags/paths/backticks — that's a REFERENCE, exactly the
// shape write-discipline rule 3 wants. R1's "repeated fragment" was mostly a
// technical term appearing twice. Strip reference-shaped text before
// comparing; only prose is left standing.
function prose(t) {
  return t
    .replace(/\[\[[^\]]+\]\]/g, ' ')            // wiki-links
    .replace(/\[[a-z][a-z0-9-]*:[A-Za-z0-9._-]+\]/g, ' ') // bracket tags
    .replace(/`[^`]*`/g, ' ')                   // backtick spans
    .replace(/https?:\/\/\S+/g, ' ')            // URLs
    .replace(/[→←][^。;;\n]*/g, ' ')            // arrow-pointer clauses (-> docs/x.md@sha etc.)
    .replace(/[~\w./\\-]*\/[\w./\\-]+/g, ' ')   // path-shaped tokens
    .replace(/\b[A-Za-z_][A-Za-z0-9_.]{5,}\b/g, ' ') // long ASCII identifiers
    .replace(/\s+/g, ' ').trim();
}
// R2 only compares "pure prose" lines: a line carrying pointer shapes
// (backtick paths / [[links]] / arrows / URLs / migration stamps) is a
// reference line, and reference lines being reused verbatim is exactly what
// rule 3 wants (second calibration pass: the remaining 4 hits were all the
// same "fully migrated to `...`" stamp).
const POINTERISH = /`[^`]*[\/\\.][^`]*`|\[\[|→|https?:\/\/|全文已迁/;
for (const e of entries) {
  e.text = prose(e.body.join('\n'));
  e.proseOnly = prose(e.body.filter(l => !POINTERISH.test(l)).join('\n'));
}

// R1: intra-entry repeat (sliding n-gram, report only the longest hit)
function selfRepeat(t) {
  if (t.length < R1_MIN * 2) return null;
  const seen = new Map();
  for (let i = 0; i + R1_MIN <= t.length; i++) {
    const g = t.slice(i, i + R1_MIN);
    if (/^[\s\p{P}]+$/u.test(g)) continue;
    // Only count windows with >=R1_HAN Han (CJK) characters as a repeated
    // PHRASE — a bare identifier/English word recurring is not redundancy.
    if ((g.match(/\p{Script=Han}/gu) || []).length < R1_HAN) continue;
    if (seen.has(g) && i - seen.get(g) >= R1_MIN) return g;
    if (!seen.has(g)) seen.set(g, i);
  }
  return null;
}
// R2: corpus copy (shares a >=R2_MIN window with another entry) — index every
// other entry's R2_MIN-grams first.
const gramOwner = new Map();
for (const e of entries) {
  const t = e.proseOnly;
  for (let i = 0; i + R2_MIN <= t.length; i += 8) { // stride 8: coarse pre-filter
    const g = t.slice(i, i + R2_MIN);
    if (!gramOwner.has(g)) gramOwner.set(g, e.tag);
  }
}
function corpusCopy(e) {
  const t = e.proseOnly;
  for (let i = 0; i + R2_MIN <= t.length; i++) {
    const g = t.slice(i, i + R2_MIN);
    const o = gramOwner.get(g);
    if (o && o !== e.tag) return { owner: o, frag: g };
  }
  return null;
}
const gz = (t) => t.length ? zlib.gzipSync(Buffer.from(t, 'utf8')).length / Buffer.byteLength(t, 'utf8') : 1;

const hits = [], ratios = [];
for (const e of entries) {
  if (!e.text) continue;
  const r = gz(e.text); ratios.push(r);
  const f1 = selfRepeat(e.text), f2 = corpusCopy(e), f3 = FILLER.find(w => e.text.includes(w)), f4 = r < R4_MAX && Buffer.byteLength(e.text, 'utf8') > 300;
  const items = [];
  if (f2) items.push({ rule: 'R2', block: true, note: `shares >=${R2_MIN} chars verbatim with [${f2.owner}]: "${f2.frag.slice(0, 24)}..." -> reference it, don't recopy it` });
  if (f3) items.push({ rule: 'R3', block: true, note: `filler word "${f3}"` });
  if (f1) items.push({ rule: 'R1', block: e.sole, note: `intra-entry repeated fragment "${f1}"` });
  if (f4) items.push({ rule: 'R4', block: e.sole, note: `gzip ratio ${r.toFixed(2)} < ${R4_MAX} (high redundancy)` });
  // Escape hatch (the maintainer 2026-09-14, "allow an exemption, but only once wording
  // is already minimal"): a title carrying [redundancy-ok] downgrades hits to
  // informational; the marker itself feeds the monthly exemption audit
  // (same treatment as [sole-record]). The gate must never deadlock.
  if (e.ok) for (const i of items) i.block = false;
  if (items.length) hits.push({ tag: e.tag, file: e.file, sole: e.sole, ok: e.ok, items });
}
const blocking = hits.filter(h => h.items.some(i => i.block));
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify({ hits, blocking: blocking.length, entries: entries.length })); process.exit(blocking.length ? 2 : 0); }
const sorted = [...ratios].sort((a, b) => a - b);
const pct = (p) => sorted.length ? sorted[Math.floor(p * (sorted.length - 1))].toFixed(2) : '-';
console.log(`axmem redundancy-lint: entries=${entries.length} (sole-record ${entries.filter(e => e.sole).length}); gzip ratio p5=${pct(0.05)} p50=${pct(0.5)} p95=${pct(0.95)}; hits=${hits.length} blocking=${blocking.length}`);
for (const h of hits.slice(0, 40)) for (const i of h.items) console.log(`  ${i.block ? 'BLOCK' : 'info'} ${i.rule} ${h.file} [${h.tag}]${h.sole ? ' (sole-record)' : ''}${h.ok ? ' (redundancy-ok)' : ''} ${i.note}`);
if (blocking.length) console.log('  Three fixes, none lossy: delete the second copy / replace with "as above"/"see above" / replace with a [[tag]] reference. Never synonym-swap. If repetition is genuinely unavoidable: add [redundancy-ok] to the title (goes to monthly audit).');
if (!process.argv.includes('--report')) process.exit(blocking.length ? 2 : 0);
