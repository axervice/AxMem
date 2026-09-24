#!/usr/bin/env node
// AxMem write-echo — related memories surface AT WRITE TIME. (P1 third pass)
// After a memory edit passes the gate, every [[link]] and Supersedes target
// in the written text echoes back with title, date and currency (a link to a
// superseded tag names its head). Writing IS maintaining: the writer sees the
// old memory while shaping the new one. Deterministic link-following only;
// scans archives too, so a faded tag still answers with name and successor.
'use strict';
const fs = require('fs');
const ctx = require('../lib/prelude.cjs');
const MEM = ctx.MEMORY_DIR;

let data = {};
try { data = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
const ti = data.tool_input || {};
let text = String(ti.new_string || ti.content || '');
if (Array.isArray(ti.edits)) text += '\n' + ti.edits.map(e => String((e && e.new_string) || '')).join('\n');
if (!text.trim()) process.exit(0);

const refs = new Set();
for (const m of text.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) refs.add(m[1]);
const supTargets = new Set();
for (const line of text.split(/\r?\n/)) if (/^\s*Supersedes:/.test(line))
  for (const m of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) supTargets.add(m[1]);
if (refs.size === 0 && supTargets.size === 0) process.exit(0);

const tagTitle = new Map(), supNext = new Map(), idxMarked = new Set();
for (const f of ['lessons.md', 'decisions.md', 'standinginstructions.md',
                 'lessons-archive.md', 'decisions-archive.md', 'standinginstructions-archive.md']) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  let curTag = null;
  for (const line of s.split(/\r?\n/)) {
    const h = line.match(/^\*\*(20[^*]+)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
    if (h) { curTag = h[2]; if (!tagTitle.has(curTag)) tagTitle.set(curTag, h[1].slice(0, 56)); continue; }
    if (line.startsWith('- 20')) {
      const im = line.match(/^- 20[^\]\[]*\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
      if (im && /superseded→/.test(line)) idxMarked.add(im[1]);
      continue;
    }
    if (curTag && /^\s*Supersedes:/.test(line))
      for (const om of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) supNext.set(om[1], curTag);
  }
}
function head(t) { let x = t, h = 0; while (supNext.has(x) && h++ < 5) x = supNext.get(x); return x; }

const out = [];
for (const r of refs) {
  if (supTargets.has(r)) continue;
  const hd = head(r), t = tagTitle.get(r);
  if (!t) { out.push(`- [[${r}]] not found in memory (project file or typo — pointer lint will verify)`); continue; }
  out.push(hd !== r
    ? `- [[${r}]] ${t} !! superseded by [${hd}] — consider linking the head`
    : `- [[${r}]] ${t} (current)`);
}
for (const s of supTargets) {
  out.push(`- you declare superseding [${s}] ${tagTitle.get(s) || ''} — old index marker ${idxMarked.has(s) ? 'OK (same-stroke bookkeeping done)' : 'MISSING (gate will block: add (superseded->...) )'}`);
}
if (!out.length) process.exit(0);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
  additionalContext: 'axmem write-echo (the old memories you just touched; dates in titles are the timeline):\n' + out.join('\n') } }));
