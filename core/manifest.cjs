#!/usr/bin/env node
// AxMem unified manifest — one parser, every machine eats the same structure.
// (P1 third pass, 2026-09-14; cross-model reviewed design)
// Emits per-entry: tag, file, lines, block hash, date, trust, [sole-record],
// links, triggers, Supersedes edges — plus the supersession graph with heads.
// --check gates six deterministic invariants:
//   B1 dangling Supersedes target · B2 cycle · B3 index-marker contradicts
//   the declared successor · B4 Index tag set != entry identity set (bijection,
//   not row-count parity — a phantom Index row can balance a missing one) ·
//   B5 a `<!-- trigger: -->` comment that doesn't match the one legal
//   tool=;repo=;path= form (a silently dead trigger — the push channel just
//   never fires, with no report anywhere else) · B6 lesson-class taxonomy:
//   a malformed `Class:` line, a Class target not defined in classes.md
//   (controlled vocabulary), more than one Class line on an entry, or (from
//   AXMEM_CLASS_REQUIRED_FROM on) a lessons.md entry with no Class line at
//   all. Corruption blocks at the keystroke, not at recall.
// JS regex trap note: POSIX [^][] means something ELSE in JS — write [^\]\[].
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const ctx = require('../lib/prelude.cjs');
const MEM = ctx.MEMORY_DIR;

const FILES = ['decisions.md', 'lessons.md', 'standinginstructions.md', 'classes.md',
               'decisions-archive.md', 'lessons-archive.md', 'standinginstructions-archive.md'];
const TRIG_RE = /<!--\s*trigger:\s*tool=([^;]+);\s*repo=([^;]+);\s*path=([^>]+?)\s*-->/;
// B6 taxonomy (porting note): every live lesson carries at most one
// `Class: [[class:x]]` line; x must be defined as a hub entry in classes.md.
// The cutoff is configurable so a fresh install can point it at its own
// install date rather than inheriting this default verbatim.
const CLASS_RE = /^Class:\s*\[\[(class:[a-z0-9-]+)\]\]\s*$/;
const CLASS_REQUIRED_FROM = process.env.AXMEM_CLASS_REQUIRED_FROM || '2026-09-15';
const entries = [], byTag = new Map(), idxMarker = new Map();

for (const f of FILES) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  const lines = s.split(/\r?\n/);
  let cur = null;
  const flush = (endIdx) => {
    if (!cur) return;
    cur.endLine = endIdx;
    cur.blockHash = crypto.createHash('sha256').update(cur._body.join('\n')).digest('hex').slice(0, 16);
    delete cur._body;
    entries.push(cur);
    if (!byTag.has(cur.tag)) byTag.set(cur.tag, []);
    byTag.get(cur.tag).push(cur);
    cur = null;
  };
  lines.forEach((line, i) => {
    const h = line.match(/^\*\*((20[0-9-]{8})[^*]*)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
    if (h) {
      flush(i);
      cur = { tag: h[3], file: f, line: i + 1, endLine: null, title: h[1].slice(0, 60), date: h[2],
              soleRecord: line.includes('[sole-record]'),
              trust: (line.match(/\[trust:([a-z-]+)\]/) || [])[1] || null,
              links: [], triggers: [], badTriggers: [], classes: [], badClass: [], supersedes: [], archived: f.includes('-archive'), _body: [line] };
      return;
    }
    if (/^## /.test(line)) flush(i);
    if (line.startsWith('- 20')) {
      const own = line.match(/^- 20[^\]\[]*\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
      if (own && /superseded→/.test(line)) {
        const std = line.match(/superseded→\[([A-Za-z0-9:._-]+)\]/);
        if (std) {
          let to = std[1];
          if (!to.includes(':')) to = own[1].split(':')[0] + ':' + to;
          idxMarker.set(own[1], { to, nonstandard: false });
        } else idxMarker.set(own[1], { to: null, nonstandard: true, raw: line.slice(0, 80) });
      }
      return;
    }
    if (!cur) return;
    cur._body.push(line);
    const t = line.match(TRIG_RE);
    if (t) cur.triggers.push({ tools: t[1].trim(), repo: t[2].trim(), path: t[3].trim() });
    // B5 (porting note): a malformed trigger comment is a SILENTLY dead
    // trigger — the push channel's TRIG_RE only accepts the exact
    // tool=...;repo=...;path=... form, and anything else (e.g. a `path=...`
    // shorthand with no tool=/repo=) is ignored with no report anywhere.
    // Four freshly planted triggers were lost this way in one day. Record
    // any `<!-- trigger:` line that didn't match TRIG_RE so --check can flag it.
    else if (/<!--\s*trigger:/i.test(line)) cur.badTriggers.push(line.trim().slice(0, 80));
    const cm = line.match(CLASS_RE);
    if (cm) cur.classes.push(cm[1]);
    else if (/^\s*Class:/i.test(line)) cur.badClass.push(line.trim().slice(0, 80));
    if (/^\s*Supersedes:/.test(line))
      for (const m of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) cur.supersedes.push(m[1]);
    else
      for (const m of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) if (!cur.links.includes(m[1])) cur.links.push(m[1]);
  });
  flush(lines.length);
}

const supDecl = new Map();
for (const e of entries) for (const old of e.supersedes) {
  if (!supDecl.has(old)) supDecl.set(old, new Set());
  supDecl.get(old).add(e.tag);
}
const supNext = new Map();
for (const [k, v] of supDecl) supNext.set(k, new Set(v));
for (const [old, m] of idxMarker) if (m.to) {
  if (!supNext.has(old)) supNext.set(old, new Set());
  supNext.get(old).add(m.to);
}

const blocking = [], report = [];
for (const e of entries) for (const old of e.supersedes)
  if (!byTag.has(old)) blocking.push(`B1 ${e.file}:${e.line} [${e.tag}] Supersedes dangling target [[${old}]]`);
for (const [old, mk] of idxMarker) {
  if (!mk.to) continue;
  const decl = supDecl.get(old);
  if (decl && decl.size > 0 && !decl.has(mk.to))
    blocking.push(`B3 [${old}] index marker points to [${mk.to}] but declared successor is [${[...decl].join(',')}]`);
}
function headOf(tag) {
  let t = tag; const seen = new Set();
  for (let i = 0; i < 8; i++) {
    if (seen.has(t)) return { head: null, cycle: true };
    seen.add(t);
    const nx = supNext.get(t);
    if (!nx || nx.size === 0) return { head: t, cycle: false };
    if (nx.size > 1) report.push(`FORK [${t}] has multiple successors: ${[...nx].join(',')}`);
    t = [...nx].sort().pop();
  }
  return { head: t, cycle: false };
}
const heads = {};
for (const old of supNext.keys()) {
  const r = headOf(old);
  if (r.cycle) blocking.push(`B2 [${old}] supersession cycle`);
  else heads[old] = r.head;
}
// B4 bijection (porting note): parity alone only counts ROWS — pairing a new
// entry with any `- 20` line balances the count without proving it's THAT
// entry's own row. Upgrade to set equality: the Index own-tag set must equal
// the live entries' identity-tag set, for decisions.md and lessons.md each.
for (const f of ['decisions.md', 'lessons.md']) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  const idxTags = new Set(), entTags = new Set();
  let inIdx = false;
  for (const line of s.split(/\r?\n/)) {
    if (/^## Index/.test(line)) { inIdx = true; continue; }
    if (/^## Entries/.test(line)) { inIdx = false; continue; }
    if (inIdx) {
      const m = line.match(/^- 20[^\]\[]*\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
      if (m) idxTags.add(m[1]);
    }
  }
  for (const e of entries) if (e.file === f) entTags.add(e.tag);
  const missIdx = [...entTags].filter(t => !idxTags.has(t));
  const missEnt = [...idxTags].filter(t => !entTags.has(t));
  for (const t of missIdx) blocking.push(`B4 ${f} entry [${t}] has no Index row of its own (row count balancing != bijection)`);
  for (const t of missEnt) blocking.push(`B4 ${f} Index row [${t}] has no matching entry`);
}
// B5 trigger form: the only legal shape is
// `<!-- trigger: tool=Edit|Write; repo=<repo-id>; path=<repo-relative-posix
// or prefix*> -->`, one trigger per line. Archived entries are exempt (a
// faded trigger firing is harmless; a live one silently not firing is not).
for (const e of entries) if (!e.archived) for (const raw of e.badTriggers)
  blocking.push(`B5 ${e.file} [${e.tag}] trigger comment does not match the tool=;repo=;path= form — the push channel silently ignores it: ${raw}`);
// B6 lesson-class taxonomy: Class form is strict, the target must be defined
// in classes.md (controlled vocabulary, not a free-form tag), and an entry
// carries at most one. lessons.md entries dated >= CLASS_REQUIRED_FROM must
// have a Class line; older unclassified entries are reported, not blocked.
const classDefs = new Set(entries.filter(e => e.file === 'classes.md').map(e => e.tag));
let unclassifiedLessons = 0;
for (const e of entries) {
  if (e.archived || e.file === 'classes.md') continue;
  for (const raw of e.badClass) blocking.push(`B6 ${e.file} [${e.tag}] Class line does not match the sole legal form (Class: [[class:<id>]]): ${raw}`);
  for (const c of e.classes) if (!classDefs.has(c)) blocking.push(`B6 ${e.file} [${e.tag}] Class target [${c}] is not defined in classes.md (controlled vocabulary — add the class there first)`);
  if (e.classes.length > 1) blocking.push(`B6 ${e.file} [${e.tag}] more than one Class line (one entry, one primary class — secondary relations go through [[links]])`);
  if (e.file === 'lessons.md' && e.classes.length === 0) {
    unclassifiedLessons++;
    if (e.date >= CLASS_REQUIRED_FROM) blocking.push(`B6 lessons.md [${e.tag}] new lesson missing a Class: line (pick one from classes.md, or add a class in the same change if none fits)`);
    else report.push(`UNCLASSIFIED lessons.md [${e.tag}] pre-cutoff lesson not yet classified`);
  }
}

const ATTR_NS = new Set(['system', 'user', 'agent']);
for (const [tag, arr] of byTag) {
  if (ATTR_NS.has(tag.split(':')[0])) continue;
  if (arr.length > 1 && new Set(arr.map(a => a.file.replace('-archive', ''))).size > 1)
    report.push(`DUP [${tag}] defined in ${arr.map(a => a.file + ':' + a.line).join(' & ')}`);
}
for (const [tag, m] of idxMarker) if (m.nonstandard) report.push(`NONSTD [${tag}] marker: ${m.raw}`);

const out = {
  asOf: new Date().toISOString().slice(0, 10),
  counts: { entries: entries.length, live: entries.filter(e => !e.archived).length, archived: entries.filter(e => e.archived).length, supersedeEdges: supNext.size,
            classes: classDefs.size, unclassifiedLessons },
  heads, blocking, report, entries,
};
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(out)); process.exit(blocking.length ? 2 : 0); }
console.log(`axmem manifest as-of ${out.asOf}: entries=${out.counts.entries} (live ${out.counts.live}/arch ${out.counts.archived}) edges=${out.counts.supersedeEdges}`);
for (const b of blocking) console.log('  BLOCK ' + b);
for (const r of report.slice(0, 20)) console.log('  info  ' + r);
if (process.argv.includes('--check')) process.exit(blocking.length ? 2 : 0);
