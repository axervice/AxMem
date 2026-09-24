#!/usr/bin/env node
// AxMem classify — bulk-insert `Class: [[class:x]]` lines into lessons.md
// from a tag<TAB>class TSV, for migrating an existing memory dir onto the
// lesson-class taxonomy in one pass. (P1, ported from a one-off migration
// script's insertion logic)
// Idempotent: an entry that already carries a Class: line is left alone —
// running the same map twice is a no-op the second time.
// All-or-nothing: any TSV row naming a tag with no matching lessons.md
// entry, or a class not defined as a hub in classes.md, aborts with NOTHING
// written. A partial pass is worse than none: it looks complete, and
// manifest's B6 will not flag the untouched rows as urgent (they're
// pre-cutoff, so they're only reported, never blocked) — so a silent
// partial run can sit unnoticed indefinitely.
// Usage: classify --map <tag\tclass>.tsv [--dry]
'use strict';
const fs = require('fs');
const ctx = require('../lib/prelude.cjs');
const MEM = ctx.MEMORY_DIR;

const args = process.argv.slice(2);
const mapIdx = args.indexOf('--map');
const MAP = mapIdx >= 0 ? args[mapIdx + 1] : null;
const DRY = args.includes('--dry');
if (!MAP) { console.error('usage: classify --map <tag\\tclass.tsv> [--dry]'); process.exit(1); }

let classesSrc = '';
try { classesSrc = fs.readFileSync(MEM + '/classes.md', 'utf8'); } catch { console.error('classes.md not found in ' + MEM + ' — add classes before classifying'); process.exit(1); }
const known = new Set([...classesSrc.matchAll(/\[(class:[a-z0-9-]+)\]/g)].map(m => m[1]));

let mapSrc;
try { mapSrc = fs.readFileSync(MAP, 'utf8'); } catch { console.error('cannot read map file: ' + MAP); process.exit(1); }
const map = new Map(); // tag -> class:id
for (const line of mapSrc.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [rawTag, rawCls] = line.split('\t');
  const tag = (rawTag || '').trim(), cls0 = (rawCls || '').trim();
  if (!tag || !cls0) { console.error('malformed row (need tag<TAB>class): ' + line); process.exit(2); }
  const cls = cls0.startsWith('class:') ? cls0 : 'class:' + cls0;
  if (!known.has(cls)) { console.error('unknown class ' + cls + ' <- ' + tag + ' (not a hub in classes.md — add the class first)'); process.exit(2); }
  map.set(tag, cls);
}

let src;
try { src = fs.readFileSync(MEM + '/lessons.md', 'utf8'); } catch { console.error('lessons.md not found in ' + MEM); process.exit(1); }
const lines = src.split('\n');
const out = [];
let inEntries = false, added = 0, skipped = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  out.push(line);
  if (/^## Entries/.test(line)) { inEntries = true; continue; }
  if (!inEntries) continue;
  const h = line.match(/^\*\*(20[^*]+)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
  if (!h) continue;
  const tag = h[2];
  // Already classified? Scan the body up to the next header.
  let j = i + 1, has = false;
  while (j < lines.length && !/^\*\*20/.test(lines[j])) { if (/^Class:\s*\[\[class:/.test(lines[j])) has = true; j++; }
  const wanted = map.get(tag);
  // This row is accounted for the moment its tag matches a real entry,
  // whether we act on it or skip it as already-classified — otherwise a
  // second run of the SAME map over an already-classified file would wrongly
  // report those tags as unmatched and refuse to run at all (idempotency
  // would fail its own re-run).
  if (wanted !== undefined) map.delete(tag);
  if (has) { skipped++; continue; }
  if (wanted === undefined) continue; // not in this map — leave untouched, not an error on its own
  // Insert after the header and any metadata comments immediately following
  // it (attribution/trigger), Class line last — same slot apply-classes.cjs
  // used for the original one-off pass.
  let k = i + 1;
  while (k < lines.length && /^<!--/.test(lines[k])) { out.push(lines[k]); k++; }
  out.push(`Class: [[${wanted}]]`);
  added++;
  i = k - 1;
}
if (map.size) {
  console.error('map row(s) with no matching lessons.md entry — nothing written: ' + [...map.keys()].join(', '));
  process.exit(3);
}
console.log(`classify: ${added} Class line(s) added, ${skipped} entr(y|ies) already classified`);
if (!DRY) fs.writeFileSync(MEM + '/lessons.md', out.join('\n'));
