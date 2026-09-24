#!/usr/bin/env node
// AxMem trigger-recall — moment-triggered deterministic recall. (P1 port)
// A lesson carrying `<!-- trigger: tool=...; repo=...; path=... -->` gets its
// TITLE pushed when a matching file is edited. Titles only, three per event,
// once per session per tag, staged telemetry, fail-open (this is a reminder,
// not a gate). trigger is its own metadata — artifact stays evidence-location
// (reusing it fakes precision and hides recall holes; cross-model audited).
// Pre-registered stop-loss: judge only after >=30 labeled pushes across >=10
// sessions and >=5 triggers; precision <80% kills the channel.
'use strict';
const fs = require('fs');
const ctx = require('../lib/prelude.cjs');

const MEM = ctx.MEMORY_DIR;
const STATE = process.env.AXMEM_TRIGGER_STATE || ctx.STATE_DIR;
const LOG = (process.env.AXMEM_TRIGGER_LOG || MEM + '/telemetry/trigger-log-' + ctx.MACHINE + '.tsv').replace(/\\/g, '/');
const FORMAT = process.argv.includes('--format=text') ? 'text' : 'claude-code';
const TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function tlog(stage, x) {
  try {
    fs.mkdirSync(require('path').dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, [new Date().toISOString(), x.session || '-', stage, x.tool || '-', x.repo || '-', x.rel || '-', x.tag || '-', x.note || '-'].join('\t') + '\n');
  } catch {}
}

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
let data = {};
try { data = JSON.parse(input); } catch { tlog('error', { note: 'bad-json' }); process.exit(0); }
const tool = data.tool_name || '';
if (!TOOLS.has(tool)) process.exit(0);
const session = String(data.session_id || 'nosess').replace(/[^A-Za-z0-9-]/g, '').slice(0, 16);
const fp = String((data.tool_input && (data.tool_input.file_path || data.tool_input.notebook_path)) || '');
if (!fp) process.exit(0);

const hit = ctx.resolveRepo(fp);
if (!hit) { tlog('event', { session, tool, note: 'no-repo matched=0' }); process.exit(0); }
if (hit.wtStripped) tlog('wt-normalized', { session, tool, repo: hit.repoId, rel: hit.rel });
const relLower = hit.rel.toLowerCase();

const TRIG_RE = /<!--\s*trigger:\s*tool=([^;]+);\s*repo=([^;]+);\s*path=([^>]+?)\s*-->/;
const triggers = [];
// Linked recall (ratified 2026-09-13): subdivided memories that are related
// or causal must surface TOGETHER. The relation substrate is the [[ns:tag]]
// wiki-links authors already write — deterministic link-following, one hop,
// budget-capped, telemetered separately. Writing a link IS wiring the joint
// recall; no inference, ever.
const tagTitle = new Map();     // titles carry YYYY-MM-DD — the timeline rides along
const entryLinks = new Map();
// Supersession awareness (ratified): a superseded memory must never be pushed
// as current. Two deterministic sources: index-row "(superseded→[new])"
// markers and in-entry "Supersedes: [[old]]" lines. Hits follow the chain
// (<=5 hops) to the head; the old tag stays visible as provenance.
const supNext = new Map();
// Archives are IN the scan (redirect entry metadata must outlive the body):
// a faded old entry's trigger/Supersedes/title still route the edit event to
// the live head — archiving can never again kill the push toward a successor.
// Lesson-class taxonomy (porting note): classes.md's hubs are entries like
// any other (they match triggers the same way). A lesson's `Class:
// [[class:x]]` line hangs it on that hub — hitting the hub pushes it plus
// its newest live members; hitting a member reports the class's remaining
// count. classOf/classMembers are built from live entries only (an archived
// member no longer counts toward "N live members").
const classOf = new Map();      // tag -> class:x
const classMembers = new Map(); // class:x -> [live member tag...]
for (const f of ['lessons.md', 'decisions.md', 'standinginstructions.md', 'classes.md',
                 'lessons-archive.md', 'decisions-archive.md', 'standinginstructions-archive.md']) {
  let s; try { s = fs.readFileSync(MEM + '/' + f, 'utf8'); } catch { continue; }
  let curTag = null, curTitle = null;
  for (const line of s.split(/\r?\n/)) {
    const h = line.match(/^\*\*(20[^*]+)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
    if (h) {
      curTitle = h[1].slice(0, 60); curTag = h[2];
      // Trust rides along (porting note): the agent receiving a pushed title
      // should know whether it is a ratified call or a derived inference —
      // carry the header's [trust:...] marker into the title text itself.
      const _tr = (line.match(/\[trust:([a-z-]+)\]/) || [])[1];
      tagTitle.set(curTag, curTitle + (_tr ? ' [trust:' + _tr + ']' : ''));
      if (!entryLinks.has(curTag)) entryLinks.set(curTag, []);
      continue;
    }
    const t = line.match(TRIG_RE);
    if (t && curTag) triggers.push({ tools: t[1].split('|').map(x => x.trim()), repo: t[2].trim(), path: t[3].trim().toLowerCase(), tag: curTag, title: curTitle });
    if (line.startsWith('- 20')) { // index rows: harvest supersession markers only
      const sm = line.match(/^- 20[^[]*\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\].*superseded→\[?([A-Za-z0-9:._-]+?)\]?\)/);
      if (sm) {
        let nx = sm[2];
        if (!nx.includes(':')) nx = sm[1].split(':')[0] + ':' + nx; // corpus shorthand omits the namespace
        supNext.set(sm[1], nx);
      }
      continue;
    }
    if (curTag && /^Supersedes:/.test(line.trim()))
      for (const om of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) supNext.set(om[1], curTag);
    if (curTag && /^Class:\s*\[\[class:[a-z0-9-]+\]\]\s*$/.test(line)) {
      const c = line.match(/\[\[(class:[a-z0-9-]+)\]\]/)[1];
      classOf.set(curTag, c);
      if (!classMembers.has(c)) classMembers.set(c, []);
      if (!f.includes('-archive')) classMembers.get(c).push(curTag);
      continue; // a Class line is not an outgoing link (else every lesson
                // would "link" to its hub and crowd out real relations)
    }
    if (curTag) for (const lm of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) {
      const arr = entryLinks.get(curTag); if (!arr.includes(lm[1])) arr.push(lm[1]);
    }
  }
}
function head(tag) { let t = tag, hops = 0; while (supNext.has(t) && hops++ < 5) t = supNext.get(t); return t; }

const matched = triggers.filter(tr =>
  tr.tools.includes(tool) && tr.repo === hit.repoId &&
  (tr.path.endsWith('*') ? relLower.startsWith(tr.path.slice(0, -1)) : relLower === tr.path));
tlog('event', { session, tool, repo: hit.repoId, rel: hit.rel, note: 'matched=' + matched.length });
if (matched.length === 0) process.exit(0);

const seenF = STATE + '/.axmem-trigger-seen-' + session;
let seen = new Set();
try { seen = new Set(fs.readFileSync(seenF, 'utf8').split('\n').filter(Boolean)); } catch {}
const redirected = [];
{
  const dedup = new Set();
  for (const m of matched) {
    const h2 = head(m.tag);
    if (dedup.has(h2)) continue; dedup.add(h2);
    if (h2 === m.tag) redirected.push(m);
    else { tlog('superseded-redirect', { session, tool, repo: hit.repoId, rel: hit.rel, tag: h2, note: 'from=' + m.tag }); redirected.push({ ...m, tag: h2, title: tagTitle.get(h2) || m.title, from: m.tag }); }
  }
}
const fresh = [], sup = [];
for (const m of redirected) (seen.has(m.tag) ? sup : fresh).push(m);
for (const m of sup) tlog('suppressed-seen', { session, tool, repo: hit.repoId, rel: hit.rel, tag: m.tag });
const inject = fresh.slice(0, 3);
for (const m of fresh.slice(3)) tlog('suppressed-cap', { session, tool, repo: hit.repoId, rel: hit.rel, tag: m.tag });
if (inject.length === 0) process.exit(0);
try { fs.appendFileSync(seenF, inject.map(m => m.tag).join('\n') + '\n'); } catch {}
for (const m of inject) tlog('injected', { session, tool, repo: hit.repoId, rel: hit.rel, tag: m.tag });

const linked = [];
const already = new Set(inject.map(m => m.tag));
for (const m of inject) {
  for (const ltRaw of (entryLinks.get(m.tag) || [])) {
    if (inject.length + linked.length >= 3) break;
    const lt = head(ltRaw); // linked memories obey supersession too
    if (already.has(lt) || seen.has(lt)) continue;
    already.add(lt);
    const lTitle = tagTitle.get(lt) || '(defined outside the three live files)';
    const dV = String(m.title || '').slice(0, 10), dL = String(lTitle).slice(0, 10);
    const age = /^20/.test(dL) && /^20/.test(dV) ? (dL > dV ? 'newer' : dL < dV ? 'older' : 'same-day') : '';
    linked.push({ tag: lt, title: lTitle, via: m.tag, age, from: lt !== ltRaw ? ltRaw : null });
  }
}
// Class-member carriage (porting note): hitting a class hub fills whatever
// slots are left (same cap of 3 total) with that class's newest live
// members, sorted by title date (title carries YYYY-MM-DD, newest first).
// Shares the same `linked` array and `seen` constraint as ordinary links —
// telemetered separately below (stage=injected-class-member) so calibration
// can tell the two channels apart.
for (const m of inject) {
  if (!m.tag.startsWith('class:')) continue;
  const mem = (classMembers.get(m.tag) || []).slice().sort((a, b) => String(tagTitle.get(b) || '').localeCompare(String(tagTitle.get(a) || '')));
  for (const t of mem) {
    if (inject.length + linked.length >= 3) break;
    if (already.has(t) || seen.has(t)) continue;
    already.add(t);
    linked.push({ tag: t, title: tagTitle.get(t) || '', via: m.tag, age: '', from: null, cls: true });
  }
}
if (linked.length) {
  try { fs.appendFileSync(seenF, linked.map(l => l.tag).join('\n') + '\n'); } catch {}
  for (const l of linked) tlog(l.cls ? 'injected-class-member' : 'injected-linked', { session, tool, repo: hit.repoId, rel: hit.rel, tag: l.tag, note: 'via=' + l.via });
}
// clsNote: appended to each injected item's own line — a hub gets its live
// member count + how to list them all; a classified lesson gets how many
// OTHER members its class has (no full text, no extra slot spent).
const clsNote = (tag) => {
  if (tag.startsWith('class:')) return ' (' + (classMembers.get(tag) || []).length + ' live members, list: grep -B3 "Class: \\[\\[' + tag + '\\]\\]" "' + MEM + '/lessons.md")';
  const c = classOf.get(tag); if (!c) return '';
  return ' ↳ same class [' + c + '] ' + Math.max(0, (classMembers.get(c) || []).length - 1) + ' more';
};

const body = 'axmem recall (pilot; related to the file just edited: ' + hit.rel + ' — say so if irrelevant, it feeds calibration):\n' +
  inject.map(m => '- [' + m.tag + '] ' + m.title + (m.from ? ' (supersedes [' + m.from + '], head pushed)' : '') + clsNote(m.tag)).join('\n') +
  (linked.length ? '\n' + linked.map(l => (l.cls ? '  ↳ same class' : '  -> linked' + (l.age ? ' (' + l.age + ')' : '')) + ' [' + l.tag + '] ' + l.title + (l.from ? ' (supersedes [' + l.from + '])' : '')).join('\n') : '');
if (FORMAT === 'claude-code') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: body } }));
} else {
  process.stdout.write(body + '\n');
}
