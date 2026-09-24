#!/usr/bin/env node
// pmm-hook.cjs --shadow [--pre] — C0.5 unified hook, runtime shadow mode.
//
// INVARIANT: old (legacy) behavior stays authoritative; this new implementation only records and
// compares, never blocks, never injects. This file NEVER writes to stdout in normal operation, NEVER
// exits non-zero for a hook-shaped reason, and NEVER touches any file the live legacy hooks (lessons
// routing / entry-length-watch / trigger-recall) or the v3 ledger read/write. It only appends one JSON
// line per invocation to <resolveHome()>/.claude/.shadow/hook-<mach>.log recording what the
// (still-unbuilt) authoritative C1 hook WOULD have done.
//
// Wiring (settings.json):
//   PostToolUse  matcher "Edit|Write|MultiEdit|NotebookEdit" -> node pmm-hook.cjs --shadow
//   PreToolUse   matcher "Edit|Write|MultiEdit"               -> node pmm-hook.cjs --shadow --pre
// Both wired ADDITIONALLY (the pre-existing legacy hooks' own settings.json entries are untouched).
//
// Scope boundaries this file must never cross:
//   - never calls ledger.writeEvent()/writeQueue()/writeSessionEnd() (no v3 ledger row, ever);
//   - never reads or writes .trigger-seen-*, memory/dreams/trigger-log-*.tsv, .pmm-len-baseline*;
//   - its OWN seen state lives at <resolveHome()>/.claude/.shadow/seen-<seenKey> only;
//   - all other shadow artifacts live under <resolveHome()>/.claude/.shadow/ or
//     <resolveHome()>/.claude/.pmm-index-lkg/ (this file writes none of the latter).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const core = require('./guards/pmm-core.cjs');
const ledger = require('./guards/pmm-recall-ledger.cjs');
const policy = require('./guards/pmm-recall-policy.cjs');
const glob = require('./guards/pmm-trigger-glob.cjs');

// ── constants ────────────────────────────────────────────────────────────────────────────────────
// HOME/MACH/SHADOW_DIR follow the SAME resolution discipline the trigger-recall guard uses:
// ledger.resolveHome() is the ONE allowed direct reader of PMM_HOME/USERPROFILE/HOME.
const HOME = ledger.resolveHome().replace(/\\/g, '/');
const MACH = (require('os').hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
const SHADOW_DIR = HOME + '/.claude/.shadow';
const SHADOW_LOG = SHADOW_DIR + '/hook-' + MACH + '.log';
const RECALL_ROOT = ledger.resolveRoot(); // read-only: only used to look up policy.json, never to write the ledger.
const TOOLS_POST = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOOLS_PRE = new Set(['Edit', 'Write', 'MultiEdit']);
const QUOTA_BYTES = 1200; // additionalContext-equivalent packed payload cap.
const MAX_DIRECT_SLOTS = 3; // direct hits only, before neighborhood expansion.
const NUL = ledger.NUL;

// ── silent-append helper: NEVER throws, NEVER touches stdout/stderr ───────────────────────────────
function appendShadowLine(obj) {
  try {
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    fs.appendFileSync(SHADOW_LOG, JSON.stringify(obj) + '\n');
  } catch {
    // silent by design: shadow mode must never surface an I/O failure to the caller ("unwritable
    // root" is one of the self-test input shapes and must still exit 0 with 0 stdout/stderr).
  }
}

function utf8Len(s) { return Buffer.byteLength(String(s), 'utf8'); }

// truncate a UTF-8 string to at most `max` bytes on a code-point boundary (never split a surrogate
// pair / multi-byte sequence), reusing the same truncation rule for the overall packed-payload quota.
function truncateUtf8(s, max) {
  s = String(s);
  if (utf8Len(s) <= max) return { text: s, truncated: false };
  let out = '';
  for (const ch of s) {
    const cand = out + ch;
    if (utf8Len(cand) > max) break;
    out = cand;
  }
  return { text: out, truncated: true };
}

// ── repo/rel resolution — kept byte-for-byte identical to the authoritative trigger-recall guard's
// own repo resolution (an optional second-repo special-case, controlled by PMM_SECOND_REPO_NAME, plus
// a home-tree fallback) so a shadow/legacy comparison never disagrees on repo resolution alone.
// PMM_SECOND_REPO_NAME lets a deployment name ONE extra always-scanned repo besides $HOME (e.g. a
// second working tree checked out elsewhere); unset by default (feature is a no-op unless configured).
const SECOND_REPO_NAME = process.env.PMM_SECOND_REPO_NAME || '';
function resolveRepoRel(fpRaw) {
  // Run core.normalizeWin32PathForCompare() — the SAME pipeline matchCanonical() itself uses (UNC-
  // admin-share rewrite, device-namespace strip, ADS-suffix strip, trailing dot/space strip, doubled-
  // separator collapse via path.win32.normalize) — FIRST, then do the second-repo / HOME prefix
  // matching on that canonical form, never on the raw string.
  const normalized = core.normalizeWin32PathForCompare(String(fpRaw || ''));
  let fp = normalized.replace(/\\/g, '/');
  fp = fp.replace(/^([A-Za-z]):\//, (m, d) => d.toLowerCase() + ':/');
  const lower = fp.toLowerCase();
  let repo = null, rel = null;
  const secondIdx = SECOND_REPO_NAME ? lower.lastIndexOf('/' + SECOND_REPO_NAME.toLowerCase() + '/') : -1;
  if (secondIdx >= 0) {
    repo = SECOND_REPO_NAME;
    rel = fp.slice(secondIdx + SECOND_REPO_NAME.length + 2);
  } else if (lower.startsWith(HOME.toLowerCase() + '/')) {
    repo = 'home';
    rel = fp.slice(HOME.length + 1);
  }
  if (rel) {
    const wt = rel.match(/^(?:.*?\/)??\.claude\/worktrees\/[^/]+\/(.*)$/);
    if (wt && wt[1]) rel = wt[1];
  }
  return { repo, rel, normalizedFp: fp };
}

// ── isMemory ────────────────────────────────────────────────────────────────────────────────────
// core.matchCanonical() is the ONE canonical-containment implementation (the trigger-write-gate guard
// already uses it the same way) — realpath-based, UNC/8.3/device-namespace/ADS aware. A second, explicit
// default-failure direction is layered on top of it: "raw string contains memory/claude~ but realpath
// failed ⇒ treat as memory". matchCanonical() itself fails CLOSED (inScope=false) whenever realpath
// resolution throws — so that direction has to be layered on here, not inside core.
function classifyMemory(normalizedFp) {
  const canonical = process.env.PMM_CANONICAL_MEMORY || (core.homeDir() + '/.claude/memory');
  let match;
  try { match = core.matchCanonical(normalizedFp, canonical); }
  catch { match = { inScope: false, basename: null, resolvedPath: null, via: null }; }
  if (match.inScope) return { isMemory: true, via: match.via || 'realpath', match };
  // default-failure direction: the raw (pre-realpath) string looks memory-shaped but matchCanonical
  // could not confirm it (realpath threw, or the resolved path fell outside canonical for a reason
  // that could itself be a broken/absent realpath). Approximated by: raw string contains 'memory' or
  // 'claude~', AND matchCanonical did not already succeed above.
  const lower = String(normalizedFp || '').toLowerCase();
  if (lower.indexOf('memory') !== -1 || lower.indexOf('claude~') !== -1) {
    return { isMemory: true, via: 'default-failure-direction', match };
  }
  return { isMemory: false, via: null, match };
}

// "canonical-home" check: "path contains /.claude/memory/ but realpath is not under $HOME/.claude/memory/
// ⇒ would deny" (authoritative); in shadow mode this is never enforced — only recorded into the
// gate-blocking list.
function checkB30(normalizedFp, memInfo) {
  const lower = String(normalizedFp || '').toLowerCase();
  const looksLikeMemoryPath = lower.indexOf('/.claude/memory/') !== -1;
  if (!looksLikeMemoryPath) return null;
  if (memInfo.match && memInfo.match.inScope) return null; // realpath confirmed canonical — fine.
  return 'B30 canonical-home: path contains /.claude/memory/ but did not resolve inside ' +
    (process.env.PMM_CANONICAL_MEMORY || (core.homeDir() + '/.claude/memory'));
}

// ── ①②③④ neighborhood (fixed emission order: direct hits, then cause/effect, then follows/precedes,
// then class-hub pointers) ─────────────────────────────────────────────────────────────────────────
// This is the ONLY function that may be mutated/removed to produce the "delete the Cause branch" red
// mutant (see --self-test's causeMutationTest). It consumes ONLY core.analyze()'s already-parsed graph
// (entries[].cause/.effects/.follows/.precedes/.head/.class) — it re-derives nothing from raw file text.
function computeNeighborhood(analyzed, directTags, opts) {
  opts = opts || {};
  const byId = new Map(analyzed.entries.map((e) => [e.id, e]));
  const seq = []; // candidate sequence, never sliced/capped inside this function.
  const seenTags = new Set();

  // ① direct hits, resolved along the supersedes chain to head (analyze() already resolved
  // entries[].head = graph.headOf(id) — no separate chain-walk needed here).
  const directResolved = [];
  const dedupHeads = new Set();
  for (const tag of directTags) {
    const e = byId.get(tag);
    const headTag = (e && e.head) ? e.head : tag;
    if (dedupHeads.has(headTag)) continue;
    dedupHeads.add(headTag);
    directResolved.push({ tag: headTag, from: headTag !== tag ? tag : null });
  }
  for (const d of directResolved) {
    if (seenTags.has(d.tag)) continue;
    seenTags.add(d.tag);
    seq.push({ tag: d.tag, source: 'direct', from: d.from });
  }

  // ② Cause targets (this entry's own Cause: targets) ∪ effects (entries that cite this one as their
  // Cause), each sub-group sorted by dateISO ascending (earliest first), causes emitted before effects
  // for a given direct hit, in direct-hit order.
  const dateOf = (t) => { const e = byId.get(t); return (e && e.dateISO) || ''; };
  const byDateThenTag = (a, b) => {
    const da = dateOf(a.tag), db = dateOf(b.tag);
    if (da !== db) return da < db ? -1 : 1;
    return String(a.tag).localeCompare(String(b.tag));
  };
  // CAUSE-BRANCH-BEGIN (mutation target — --self-test's causeMutationTest strips exactly the block
  // between these two markers via textual regex; do not reformat the markers themselves).
  for (const d of directResolved) {
    const e = byId.get(d.tag);
    if (!e) continue;
    const causes = (e.cause || []).map((t) => ({ tag: t, label: '因' })).sort(byDateThenTag);
    const effects = (e.effects || []).map((t) => ({ tag: t, label: '果' })).sort(byDateThenTag);
    for (const c of causes.concat(effects)) {
      if (seenTags.has(c.tag)) continue;
      seenTags.add(c.tag);
      const cd = byId.get(c.tag);
      const selfDate = e.dateISO || '';
      const otherDate = (cd && cd.dateISO) || '';
      let age = '';
      if (selfDate && otherDate) age = otherDate < selfDate ? '较早' : otherDate > selfDate ? '较晚' : '同期';
      seq.push({ tag: c.tag, source: c.label === '因' ? 'cause' : 'effect', via: d.tag, label: c.label, age });
    }
  }
  // CAUSE-BRANCH-END

  // FOLLOWS-BRANCH-BEGIN (mutation target — --self-test's orderSwapMutationTest swaps this block
  // bodily with the CAUSE-BRANCH block above via textual splice; do not reformat the markers
  // themselves). ③ Follows (this entry's own Follows: targets) ∪ precedes (entries that Follow this
  // one), same sort/emission convention as ②.
  for (const d of directResolved) {
    const e = byId.get(d.tag);
    if (!e) continue;
    const follows = (e.follows || []).map((t) => ({ tag: t, label: '先' })).sort(byDateThenTag);
    const precedes = (e.precedes || []).map((t) => ({ tag: t, label: '后' })).sort(byDateThenTag);
    for (const c of follows.concat(precedes)) {
      if (seenTags.has(c.tag)) continue;
      seenTags.add(c.tag);
      seq.push({ tag: c.tag, source: c.label === '先' ? 'follows' : 'precedes', via: d.tag, label: c.label });
    }
  }
  // FOLLOWS-BRANCH-END

  // ④ class-hub hit → member count + a pmm-search "class:x" pointer only, never the members themselves.
  for (const d of directResolved) {
    if (!String(d.tag).startsWith('class:')) continue;
    const memberCount = analyzed.entries.filter((e) => e.class === d.tag && !e.archived).length;
    seq.push({ tag: null, source: 'class-count', via: d.tag, classTag: d.tag, memberCount, pointer: 'pmm-search "' + d.tag + '"' });
  }

  return seq;
}

// pack a candidate sequence into a simulated additionalContext-equivalent string and enforce the
// 1.2KB quota. Returns { text, truncated, droppedFrom } — never actually written to stdout; this is
// purely what the shadow log records "would have been sent".
function packCandidates(seq, byId) {
  const lines = [];
  for (const c of seq) {
    if (c.source === 'class-count') {
      lines.push('  ↳ [' + c.classTag + '] ' + c.memberCount + ' 条 → ' + c.pointer);
      continue;
    }
    const e = byId.get(c.tag);
    const title = e ? e.title : '(unresolved)';
    const tagLine = '[' + c.tag + '] ' + title +
      (c.label ? ('(' + c.label + (c.age ? ' ' + c.age : '') + ')') : '') +
      (c.from ? ('(⚠️ 取代了 [' + c.from + '])') : '');
    lines.push((c.source === 'direct' ? '- ' : '  ↳ ') + tagLine);
  }
  let text = lines.join('\n');
  let truncated = false;
  let droppedFrom = -1;
  if (utf8Len(text) > QUOTA_BYTES) {
    // drop trailing lines one at a time until under quota, then hard-truncate what remains on a
    // code-point boundary (same discipline as truncateUtf8 / the overall payload rule).
    let kept = lines.slice();
    while (kept.length > 0 && utf8Len(kept.join('\n')) > QUOTA_BYTES) {
      kept.pop();
      droppedFrom = kept.length;
      truncated = true;
    }
    let joined = kept.join('\n');
    if (utf8Len(joined) > QUOTA_BYTES) {
      const t = truncateUtf8(joined, QUOTA_BYTES - 1);
      joined = t.text + '…';
      truncated = true;
    }
    text = joined;
  }
  return { text, truncated, droppedFrom };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// hook four dimensions: writer / echo / routing / length.
// These four are ADDITIVE to the shadow log row; they never affect gateBlocking/push/exit code, and
// every function below follows the same "never throw past this hook" discipline the rest of the file
// already has (individual fs reads are try/catch'd; regexes never throw on well-formed string input).
// ══════════════════════════════════════════════════════════════════════════════════════════════════

// ── writer dimension — same judgment the trigger-write-gate guard makes, recomputed here for the
// SHADOW log instead of enforced. reconstructProspective/titleKey below are LOCAL COPIES of that
// guard's own logic (kept separate rather than moved into core, since core's write surface here is
// deliberately just the two new exports below and moving shared logic into core would touch a file
// outside this component's boundary).
function reconstructProspectiveShadow(currentRaw, ti) {
  if (typeof ti.content === 'string') return Buffer.from(ti.content, 'utf8'); // Write: replaces the whole file
  let text = currentRaw.toString('utf8');
  const editList = Array.isArray(ti.edits) ? ti.edits
    : (typeof ti.old_string === 'string' ? [{ old_string: ti.old_string, new_string: ti.new_string, replace_all: ti.replace_all }] : []);
  for (const e of editList) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || e.old_string === '') continue;
    if (e.replace_all) { text = text.split(e.old_string).join(e.new_string); continue; }
    const idx = text.indexOf(e.old_string);
    if (idx === -1) continue; // matches the real tool's own failure mode — nothing to reconstruct here
    text = text.slice(0, idx) + e.new_string + text.slice(idx + e.old_string.length);
  }
  return Buffer.from(text, 'utf8');
}
function titleKeyShadow(e) { return [e.dateISO, e.dateRaw, e.title, e.tail].join('\u0000'); }
const WRITER_PRESENCE_FILES = new Set(['lessons.md', 'decisions.md', 'standinginstructions.md']);

// computeWriterDimension(basename, currentRaw, prospective) — key format: code|basename|L<line> for
// code-level diagnostics; presence|basename|<dateISO><dateRaw> — <title> for a missing-trigger entry.
// Each list is truncated to the first 5; `xxxTotal` carries the true count. A non-empty code-level
// diagnostics list short-circuits the presence check (mirrors the live write-gate's own control flow —
// its deny() calls process.exit(0) immediately, so the presence-gate code after it never runs once a
// code-level diagnostic fired; reproduced here as an explicit early return rather than relying on
// incidental ordering).
function computeWriterDimension(basename, currentRaw, prospective) {
  let parsed;
  try { parsed = core.parseFile(basename, prospective); }
  catch { return { b5b32Keys: [], b5b32Total: 0, presenceKeys: [], presenceTotal: 0, parseFailed: true }; }
  const bad = (parsed.diagnostics || []).filter((d) => d.code === 'B5' || d.code === 'B32');
  const b5b32Keys = bad.map((d) => `${d.code}|${basename}|L${d.line}`);
  if (b5b32Keys.length > 0) {
    return { b5b32Keys: b5b32Keys.slice(0, 5), b5b32Total: b5b32Keys.length, presenceKeys: [], presenceTotal: 0 };
  }
  let presenceKeys = [];
  if (WRITER_PRESENCE_FILES.has(basename)) {
    try {
      const currentParsed = core.parseFile(basename, currentRaw);
      const existingKeys = new Set(currentParsed.entries.map(titleKeyShadow));
      const missing = parsed.entries.filter((e) => {
        if (existingKeys.has(titleKeyShadow(e))) return false; // pre-existing entry, not retroactively checked
        const hasLegal = Array.isArray(e.triggers) && e.triggers.length > 0;
        const hasNone = !!e.triggerNone;
        return !hasLegal && !hasNone;
      });
      presenceKeys = missing.map((e) => `presence|${basename}|${e.dateISO}${e.dateRaw} — ${e.title}`);
    } catch { presenceKeys = []; } // on-disk current parse failed — fail-open, both sides empty (matches the legacy gate)
  }
  return { b5b32Keys: [], b5b32Total: 0, presenceKeys: presenceKeys.slice(0, 5), presenceTotal: presenceKeys.length };
}

// ── echo dimension — verbatim port of the legacy write-echo guard's own regex + scan order (does not
// use core.analyze()). Scoped to that guard's own body only — NOT also replicating the entry-length
// guard's front-filter that legacy gates write-echo behind at runtime; the shadow row records "what
// write-echo's own logic would produce given this event's text", and the rc-gating half ("legacy rc as
// a gate") is the comparator's job at COMPARE time, not this hook's.
const ECHO_SCAN_ORDER = ['lessons.md', 'decisions.md', 'standinginstructions.md', 'classes.md',
  'lessons-archive.md', 'decisions-archive.md', 'standinginstructions-archive.md'];
function computeEchoDimension(memDirPath, ti) {
  let text = String(ti.new_string || ti.content || '');
  if (Array.isArray(ti.edits)) text += '\n' + ti.edits.map((e) => String((e && e.new_string) || '')).join('\n');
  if (!text.trim()) return [];
  const refs = new Set();
  for (const m of text.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) refs.add(m[1]);
  const supTargets = new Set();
  for (const line of text.split(/\r?\n/)) if (/^\s*Supersedes:/.test(line))
    for (const m of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) supTargets.add(m[1]);
  if (refs.size === 0 && supTargets.size === 0) return [];

  const tagTitle = new Map();
  const supNext = new Map();
  const idxMarked = new Set();
  for (const f of ECHO_SCAN_ORDER) {
    let s; try { s = fs.readFileSync(memDirPath + '/' + f, 'utf8'); } catch { continue; }
    let curTag = null;
    for (const line of s.split(/\r?\n/)) {
      const h = line.match(/^\*\*(20[^*]+)\*\*.*?\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
      if (h) { curTag = h[2]; tagTitle.set(curTag, h[1].slice(0, 56)); continue; }
      if (line.startsWith('- 20')) {
        const im = line.match(/\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]/);
        if (im && /superseded→/.test(line)) idxMarked.add(im[1]);
        continue;
      }
      if (curTag && /^\s*Supersedes:/.test(line))
        for (const om of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) supNext.set(om[1], curTag);
    }
  }
  function head(t) { let x = t, h = 0; while (supNext.has(x) && h++ < 5) x = supNext.get(x); return x; }

  // status enum: {not in memory, superseded by [X], live, marked, unmarked}
  const out = [];
  for (const r of refs) {
    if (supTargets.has(r)) continue;
    const hd = head(r);
    const t = tagTitle.get(r);
    if (!t) { out.push({ tag: r, status: '未在记忆库' }); continue; }
    out.push(hd !== r ? { tag: r, status: '已被[' + hd + ']取代' } : { tag: r, status: '现行' });
  }
  for (const s of supTargets) {
    const marked = idxMarked.has(s);
    out.push({ tag: s, status: marked ? '已标记' : '未标记' });
  }
  return out;
}

// ── routing dimension — port of the legacy lessons-routing guard's own regex; that guard reads
// lessons.md unconditionally and never looks at the event at all, so this is computed for every Post
// Edit/Write/MultiEdit event in domain, independent of which file was actually touched.
// ROUTING_FALLBACK_NS is an example set of project namespaces that should NOT appear in the
// cross-project lessons file; override via PMM_ROUTING_FALLBACK_NS (comma-separated) per deployment.
const ROUTING_FALLBACK_NS = (process.env.PMM_ROUTING_FALLBACK_NS || 'example-project')
  .split(',').map((s) => s.trim()).filter(Boolean);
function computeRoutingDimension(memDirPath) {
  let text;
  try { text = fs.readFileSync(memDirPath + '/lessons.md', 'utf8'); } catch { return { rc: 0, hits: [] }; }
  const nsSet = new Set();
  for (const m of text.matchAll(/\[([a-z0-9-]+):\*\]/g)) nsSet.add(m[1]);
  for (const fb of ROUTING_FALLBACK_NS) nsSet.add(fb);
  const nsAlt = Array.from(nsSet).sort().join('|');
  const hitRe = new RegExp('^\\*\\*.*\\[(' + nsAlt + '):');
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (hitRe.test(lines[i])) hits.push((i + 1) + ':' + lines[i]);
  return { rc: hits.length ? 2 : 0, hits };
}

// ── length dimension — port of the legacy entry-length-watch guard's check classes. Two classes are
// NOT computed here: supersede-graph check and redundancy lint — both require their own read-only
// admission proof first (out of scope for this component); both are listed in `notComputed` rather
// than silently omitted.
const LEN_LIMIT = 900, IDX_LIMIT = 320, PROG_LIMIT = 3000;

function countOverLimitShadow(text, limit) {
  if (text == null) return 0;
  let n = 0, h = false, sz = 0, sk = 0, ex = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\*\*20/.test(line)) {
      if (h && sz > limit && !ex) n++;
      h = true; sz = 0; sk = 0; ex = line.indexOf('[sole-record]') !== -1;
      continue;
    }
    if (/^Class: \[\[class:[a-z0-9-]+\]\]$/.test(line)) continue;
    if (/^\*\(|^\*Archived|^\*RAG/.test(line)) { sk++; if (sk > 3) sz += utf8Len(line); continue; }
    if (h) { sz += utf8Len(line); if (line.indexOf('[sole-record]') !== -1) ex = true; }
  }
  if (h && sz > limit && !ex) n++;
  return n;
}
function countIdxOverShadow(text, limit) {
  if (text == null) return 0;
  let n = 0, i = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^## Index|^### Index/.test(line)) { i = true; continue; }
    if (/^## Entries/.test(line)) i = false;
    if (i && /^- 20/.test(line) && utf8Len(line) > limit) n++;
  }
  return n;
}
function countQuotesShadow(text) {
  if (text == null) return 0;
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!/<!-- attribution:/.test(line)) continue;
    if (/原话|逐字|verbatim/.test(line)) { n++; continue; }
    const sIdx = line.indexOf('「');
    if (sIdx === -1) continue;
    const s = utf8Len(line.slice(0, sIdx)) + 1;
    let lastCloseIdx = -1, from = 0;
    for (;;) { const k = line.indexOf('」', from); if (k === -1) break; lastCloseIdx = k; from = k + 1; }
    if (lastCloseIdx === -1) continue;
    const e = utf8Len(line.slice(0, lastCloseIdx)) + 1;
    if (e && (e - s) >= 120) n++;
  }
  return n;
}
function countIndexRegionLines(text, headingRe) {
  if (text == null) return 0;
  let n = 0, i = false;
  for (const line of text.split(/\r?\n/)) {
    if (headingRe.test(line)) { i = true; continue; }
    if (/^## Entries/.test(line)) i = false;
    if (i && /^- 20/.test(line)) n++;
  }
  return n;
}
function countEntriesDLShadow(text) {
  if (text == null) return 0;
  let n = 0; for (const line of text.split(/\r?\n/)) if (/^\*\*20/.test(line)) n++;
  return n;
}
function countEntriesStdShadow(text) {
  if (text == null) return 0;
  let n = 0, e = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^## Entries/.test(line)) { e = true; continue; }
    if (e && /^\*\*20/.test(line)) n++;
  }
  return n;
}
function countOrphansShadow(text) {
  if (text == null) return 0;
  let n = 0, i = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^## Index|^### Index/.test(line)) i = true;
    if (/^## Entries/.test(line)) i = false;
    if (!i && /^- 20\d\d-\d\d-\d\d/.test(line)) n++;
  }
  return n;
}
const GHOST_RE1 = /^[^*\s].*\*\*20\d\d-\d\d-\d\d[^*]*\*\*.*\[[a-z][a-z0-9-]*:/;
const GHOST_RE2 = /^\s+\*\*20\d\d-\d\d-\d\d[^*]*\*\*.*\[[a-z][a-z0-9-]*:/;
function countGhostsShadow(text) {
  if (text == null) return 0;
  let n = 0;
  for (const line of text.split(/\r?\n/)) { if (GHOST_RE1.test(line)) n++; if (GHOST_RE2.test(line)) n++; }
  return n;
}
function activeBytesShadow(progText) {
  if (progText == null) return 0;
  let n = 0, f = false;
  for (const line of progText.split(/\r?\n/)) {
    if (/^## Active/.test(line)) { f = true; continue; }
    if (/^## Ledger/.test(line)) f = false;
    if (f) n += utf8Len(line) + 1;
  }
  return n;
}
function countNoPrefixShadow(memFilesText) {
  const bareTags = new Set();
  for (const m of memFilesText.matchAll(/\[\[([a-z0-9][a-z0-9._-]*)\]\]/g)) bareTags.add(m[1]);
  const issues = [];
  for (const t of Array.from(bareTags).sort()) {
    const defRe = new RegExp('\\[[a-z]+:' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]');
    if (defRe.test(memFilesText)) issues.push('[[' + t + ']]');
  }
  return issues;
}
function countSupViolShadow(decText, lesText, stdText) {
  const combined = [decText, lesText, stdText].filter((x) => x != null).join('\n');
  const supTargets = new Set();
  for (const line of combined.split(/\r?\n/)) {
    if (/^\s*Supersedes:/.test(line))
      for (const m of line.matchAll(/\[\[([a-z][a-z0-9-]*:[A-Za-z0-9._-]+)\]\]/g)) supTargets.add(m[1]);
  }
  const lines = combined.split(/\r?\n/);
  const issues = [];
  for (const t of Array.from(supTargets).sort()) {
    const re = new RegExp('^- 20[^\\]\\[]*\\[' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]');
    let row = null;
    for (const line of lines) { if (re.test(line)) { row = line; break; } }
    if (row && row.indexOf('superseded→') === -1) issues.push('[' + t + ']');
  }
  return issues;
}
function readTextOrNull(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// Pre-phase-only baseline read: read-only snapshot of the two baseline state files the legacy hook only
// ever WRITES at Post/SessionStart — reading them at Pre cannot race that writer for THIS SAME event,
// since Pre always runs strictly before Post for one tool_use_id.
function readLenBaseline() {
  const stateFile = process.env.PMM_STATE_FILE || (core.homeDir() + '/.claude/.pmm-len-baseline');
  function readInt(p) { try { const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10); return Number.isFinite(n) ? n : -1; } catch { return -1; } }
  return { prev: readInt(stateFile), prevIdx: readInt(stateFile + '.idx') };
}

// computeLengthDimension(memDirPath, baseline) — baseline is {prev,prevIdx} read at Pre (see
// readLenBaseline / .shadow/pre-<tuid>.json), or null when unavailable — the two baseline-relative
// classes are then simply never emitted (the whole-dimension "not comparable" bookkeeping is the
// comparator's job; this function stays best-effort per-event).
function computeLengthDimension(memDirPath, baseline) {
  const dec = readTextOrNull(memDirPath + '/decisions.md');
  const les = readTextOrNull(memDirPath + '/lessons.md');
  const std = readTextOrNull(memDirPath + '/standinginstructions.md');
  const prog = readTextOrNull(memDirPath + '/progress.md');

  const now = countOverLimitShadow(dec, LEN_LIMIT) + countOverLimitShadow(les, LEN_LIMIT);
  const nowI = countIdxOverShadow(dec, IDX_LIMIT) + countIdxOverShadow(les, IDX_LIMIT) + countIdxOverShadow(std, IDX_LIMIT);
  const nowQ = countQuotesShadow(dec) + countQuotesShadow(les) + countQuotesShadow(std);

  const parity = [];
  if (dec != null) { const ix = countIndexRegionLines(dec, /^## Index/), en = countEntriesDLShadow(dec); if (ix !== en) parity.push(`decisions(Index ${ix}≠Entries ${en})`); }
  if (les != null) { const ix = countIndexRegionLines(les, /^## Index/), en = countEntriesDLShadow(les); if (ix !== en) parity.push(`lessons(Index ${ix}≠Entries ${en})`); }
  if (std != null) { const ix = countIndexRegionLines(std, /^### Index/), en = countEntriesStdShadow(std); if (ix !== en) parity.push(`standing(Index ${ix}≠Entries ${en})`); }

  const orphans = [];
  for (const [label, text] of [['decisions', dec], ['lessons', les], ['standinginstructions', std]]) {
    if (text == null) continue;
    const o = countOrphansShadow(text);
    if (o > 0) orphans.push(`${label}(${o}块)`);
  }
  const ghosts = [];
  for (const [label, text] of [['decisions', dec], ['lessons', les], ['standinginstructions', std]]) {
    if (text == null) continue;
    const g = countGhostsShadow(text);
    if (g > 0) ghosts.push(`${label}(${g}行)`);
  }

  let mdFilesText = '';
  try {
    const names = fs.readdirSync(memDirPath).filter((f) => f.endsWith('.md'));
    mdFilesText = names.map((f) => { try { return fs.readFileSync(path.join(memDirPath, f), 'utf8'); } catch { return ''; } }).join('\n');
  } catch { mdFilesText = ''; }
  const noPrefix = countNoPrefixShadow(mdFilesText);
  const supViol = countSupViolShadow(dec, les, std);
  const activeBytes = activeBytesShadow(prog);

  const classes = [];
  if (baseline && baseline.prev >= 0 && now > baseline.prev) classes.push('超长净增');
  if (baseline && baseline.prevIdx >= 0 && nowI > baseline.prevIdx) classes.push('Index 超长净增');
  if (nowQ > 0) classes.push('原话引用');
  if (parity.length) classes.push('Index 奇偶');
  if (orphans.length) classes.push('孤儿块');
  if (ghosts.length) classes.push('伪装标题');
  if (noPrefix.length) classes.push('缺命名空间');
  if (supViol.length) classes.push('取代记账');
  if (activeBytes > PROG_LIMIT) classes.push('Active 体积');

  return {
    classes,
    notComputed: ['取代图', '冗余'],
    detail: { now, nowI, nowQ, parity, orphans, ghosts, noPrefix, supViol, activeBytes },
    baselineAvailable: !!baseline,
    rc: classes.length ? 2 : 0,
  };
}

// ── main hook body ──────────────────────────────────────────────────────────────────────────────
// A blocking fs.readFileSync(0) inside THIS process cannot itself be interrupted by a timer — Node has
// no portable non-blocking-stdin primitive that behaves identically on a POSIX pipe and a Windows
// named pipe. Delegate the actual blocking read to a CHILD node process (process.execPath itself —
// never an external `cat`/`timeout` binary this hook cannot assume is on PATH when Claude Code spawns
// it directly, not through a shell) that inherits this process's stdin, and let
// child_process.spawnSync's own `timeout` option — which kills the child and hands back whatever
// partial stdout it already produced — enforce a 1s bound.
function readStdinSync() {
  try {
    const cp = require('child_process');
    const r = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(0))'], {
      stdio: ['inherit', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) return null;
    return r.stdout || Buffer.alloc(0);
  } catch { return null; }
}

function runHook(argv) {
  const isPre = argv.includes('--pre');
  const allowedTools = isPre ? TOOLS_PRE : TOOLS_POST;
  const phase = isPre ? 'pre' : 'post';
  const ts = new Date().toISOString();

  const inputBuf = readStdinSync();
  if (inputBuf === null) { appendShadowLine({ ts, phase, note: 'stdin-read-failed' }); process.exit(0); }
  if (inputBuf.length === 0) { appendShadowLine({ ts, phase, note: 'empty-stdin' }); process.exit(0); }

  let data;
  try {
    data = JSON.parse(inputBuf.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('non-object JSON root');
  }
  catch (e) {
    const head64 = inputBuf.slice(0, 64);
    const head64Sha16 = crypto.createHash('sha256').update(head64).digest('hex').slice(0, 16);
    appendShadowLine({ ts, phase, note: 'bad-json', len: inputBuf.length, head64sha16: head64Sha16, reason: e.message });
    process.exit(0);
  }

  const toolUseId = (typeof data.tool_use_id === 'string' && data.tool_use_id) ? data.tool_use_id :
    (typeof data.toolUseId === 'string' && data.toolUseId) ? data.toolUseId :
    (typeof data.tool_call_id === 'string' && data.tool_call_id) ? data.tool_call_id : '';
  const sessionIdRaw = (typeof data.session_id === 'string' && data.session_id) ? data.session_id : '';
  const agentIdRaw = (typeof data.agent_id === 'string' && data.agent_id) ? data.agent_id :
    (typeof data.agentId === 'string' && data.agentId) ? data.agentId : '';
  const tool = data.tool_name || '';

  if (!allowedTools.has(tool)) { appendShadowLine({ ts, phase, sid: sessionIdRaw, tool_use_id: toolUseId, tool, note: 'tool-not-in-scope' }); process.exit(0); }

  const fpRaw = String((data.tool_input && data.tool_input.file_path) || (data.tool_input && data.tool_input.notebook_path) || '');
  if (!fpRaw) { appendShadowLine({ ts, phase, sid: sessionIdRaw, tool_use_id: toolUseId, tool, note: 'no-file-path' }); process.exit(0); }

  const { repo, rel, normalizedFp } = resolveRepoRel(fpRaw);
  const memInfo = classifyMemory(normalizedFp);
  const b30 = checkB30(normalizedFp, memInfo);

  let snap = null;
  let analyzed = null;
  let degraded = null;
  try {
    snap = core.snapshot('worktree');
    analyzed = core.analyze(snap, {});
  } catch (e) {
    degraded = 'PMM-DEGRADED ' + (e && e.message ? e.message : String(e));
  }

  const row = {
    ts, phase, sid: sessionIdRaw, agent: agentIdRaw, tool_use_id: toolUseId, tool,
    rel: rel || null, repo: repo || null, isMemory: memInfo.isMemory,
    gateBlocking: [], echo: null, routing: null, pushCandidatesPreTruncation: [], pushSelected: [],
    quotaTruncated: false,
    // writer/v3Pre only filled in Pre; echo/routing/length only filled in Post for Edit|Write|MultiEdit
    // (NotebookEdit is out of domain for those three). Left null to mean "not in this dimension's
    // domain for this event" — distinct from an empty result, which the dimension's own function
    // returns as an empty array/classes list.
    writer: null, v3Pre: null, length: null,
  };
  if (b30) row.gateBlocking.push(b30);
  if (degraded) { row.degraded = degraded; appendShadowLine(row); process.exit(0); }

  // gate blocking list (only meaningful for isMemory events; informational shadow logging only, never
  // enforced): analyze().blocking already covers the WHOLE snapshot, filtered here to lines that name
  // this entry's file when isMemory.
  if (memInfo.isMemory && rel) {
    const relBase = path.basename(rel);
    for (const b of analyzed.blocking || []) {
      if (typeof b === 'string' && b.indexOf(relBase) !== -1) row.gateBlocking.push(b);
    }
  }

  // ── writer + v3Pre dimension — Pre-phase ONLY (mirrors the authoritative write-gate being wired at
  // PreToolUse only; Post rows never carry writer fields).
  if (isPre) {
    if (process.env.PMM_TRIGGER_WRITE_GATE_DISABLE === '1') {
      row.writer = { disabled: true };
    } else if (memInfo.isMemory && memInfo.match && memInfo.match.inScope && core.ALL_FILES.includes(memInfo.match.basename)) {
      const basename = memInfo.match.basename;
      const ti = data.tool_input || {};
      const hasEditableInput = typeof ti.content === 'string' || typeof ti.old_string === 'string' || Array.isArray(ti.edits);
      if (hasEditableInput) {
        let currentRaw;
        try { currentRaw = core.stripBOM(fs.readFileSync(memInfo.match.resolvedPath)).buf; }
        catch { currentRaw = Buffer.alloc(0); } // file doesn't exist yet (Write creating it) — same fail-open as the live gate
        let prospective = null;
        try { prospective = reconstructProspectiveShadow(currentRaw, ti); } catch { prospective = null; }
        if (prospective != null) {
          try { row.writer = computeWriterDimension(basename, currentRaw, prospective); }
          catch (e) { row.writer = { error: String((e && e.message) || e) }; }

          // v3 pre-observation: B30 + core.check on before/after snapshots — only when target ∈
          // core.ALL_FILES (already guaranteed above) and only in Pre (never doubles the
          // snapshot+analyze cost on a non-ALL_FILES edit).
          if (!degraded && snap) {
            try {
              const afterSnap = core.snapshotWithOverrides(snap, { [basename]: prospective });
              const afterAnalyzed = core.analyze(afterSnap, {});
              const diff = core.diffBlocking(analyzed.blocking || [], afterAnalyzed.blocking || []);
              row.v3Pre = { b30: b30 ? [b30] : [], diff };
            } catch (e) {
              row.v3Pre = { error: String((e && e.message) || e) };
            }
          }
        }
      }
    }

    // length dimension's baseline snapshot: read-only, Pre-only, stored keyed by tool_use_id for Post
    // to consume. Never gated on isMemory/ALL_FILES — the legacy hook's own domain is broader, and this
    // read is cheap.
    if (toolUseId) {
      try {
        const baseline = readLenBaseline();
        fs.mkdirSync(SHADOW_DIR, { recursive: true });
        fs.writeFileSync(SHADOW_DIR + '/pre-' + toolUseId + '.json', JSON.stringify(baseline));
      } catch { /* best-effort — Post falls back to baselineAvailable=false, matching "missing snapshot -> not comparable" */ }
    }
  }

  // ── echo/routing/length dimensions — Post-phase ONLY, domain = Edit|Write|MultiEdit (NotebookEdit
  // is Post-domain-restricted to push-only). Independent of isMemory — the legacy write-echo/
  // lessons-routing/entry-length-watch guards all run unconditionally within this tool domain, never
  // looking at isMemory themselves.
  if (!isPre && (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit')) {
    const memDirPath = core.memDir();
    const ti = data.tool_input || {};
    try { row.echo = computeEchoDimension(memDirPath, ti); } catch (e) { row.echo = { error: String((e && e.message) || e) }; }
    try { row.routing = computeRoutingDimension(memDirPath); } catch (e) { row.routing = { error: String((e && e.message) || e) }; }

    let baseline = null;
    if (toolUseId) {
      const preFile = SHADOW_DIR + '/pre-' + toolUseId + '.json';
      try { baseline = JSON.parse(fs.readFileSync(preFile, 'utf8')); } catch { baseline = null; }
      try { fs.unlinkSync(preFile); } catch {} // best-effort cleanup; never blocks on failure
    }
    try { row.length = computeLengthDimension(memDirPath, baseline); } catch (e) { row.length = { error: String((e && e.message) || e) }; }
  }

  // ── push candidates (all tools — not gated on isMemory) — POST-ONLY: seen-budget consumption
  // (read+write of SHADOW_DIR/seen-<key>) must happen in exactly the SAME phase the authoritative
  // trigger-recall guard runs in — PostToolUse. Pre stays strictly observational — it still records
  // gateBlocking/isMemory above, but never computes or reports push candidates and never touches the
  // seen file at all (an earlier revision that ran this block at BOTH phases double-consumed the seen
  // budget and silently starved Post's own push for the same event).
  if (repo && rel && !isPre) {
    const relLower = rel.toLowerCase();
    // The direct-hit scan must walk the memory files in the SAME order the authoritative trigger-recall
    // guard does (lessons.md first, decisions.md second — NOT core.ALL_FILES' decisions-first order),
    // and must NOT skip archived entries (an archived entry's own trigger still matches and gets
    // redirected to its live head below).
    const AUTH_FILE_ORDER = ['lessons.md', 'decisions.md', 'standinginstructions.md', 'classes.md',
      'lessons-archive.md', 'decisions-archive.md', 'standinginstructions-archive.md'];
    const entriesByFile = new Map();
    for (const e of analyzed.entries) {
      if (!entriesByFile.has(e.file)) entriesByFile.set(e.file, []);
      entriesByFile.get(e.file).push(e);
    }
    const directTagsRaw = [];
    for (const f of AUTH_FILE_ORDER) {
      for (const e of (entriesByFile.get(f) || [])) {
        if (!e.id) continue;
        for (const tr of (e.triggers || [])) {
          if (tr.kind !== 'path') continue;
          if (!tr.tools || !tr.tools.includes(tool) || tr.repo !== repo) continue;
          let compiled;
          try { compiled = glob.compileTriggerPath(tr.path); } catch { continue; }
          if (glob.testTriggerPath(compiled, relLower)) { directTagsRaw.push(e.id); break; }
        }
      }
    }
    if (directTagsRaw.length) {
      const byId = new Map(analyzed.entries.map((e) => [e.id, e]));

      // seen filtering — shadow's OWN seen state only (never .trigger-seen-*), keyed by
      // seenKey(session_id, agent_id). Read ONCE, here, BEFORE the head-redirect/dedup/cap steps
      // below — authority filters already-seen tags BEFORE the ≤3 cap, so an already-pushed direct hit
      // occupying an early cap slot must not silently starve out a fresh, not-yet-seen 4th/5th direct
      // hit that authority would still have pushed.
      const skey = ledger.seenKey(sessionIdRaw, agentIdRaw);
      const seenFile = SHADOW_DIR + '/seen-' + skey;
      let seenSet = new Set();
      try { seenSet = new Set(fs.readFileSync(seenFile, 'utf8').split('\n').filter(Boolean)); } catch {}

      // head-resolve (for dedup/seen purposes only — the RAW tag is what's kept, so computeNeighborhood
      // below still sees the original pre-redirect tag and can still annotate a redirect's `from`) +
      // dedup-by-head in scan order (mirrors the authoritative guard's own `redirected` step), THEN
      // drop already-seen heads (mirrors its own fresh/sup split), THEN cap to MAX_DIRECT_SLOTS
      // (mirrors its own slice(0,3)) — all BEFORE computeNeighborhood ever runs, so a dropped (seen or
      // capped) direct hit never gets its own ②③④ neighborhood computed or emitted either.
      const dedupHeads = new Set();
      const freshDirectRawTags = [];
      for (const tag of directTagsRaw) {
        const e = byId.get(tag);
        const headTag = (e && e.head) ? e.head : tag;
        if (dedupHeads.has(headTag)) continue;
        dedupHeads.add(headTag);
        if (seenSet.has(headTag)) continue;
        freshDirectRawTags.push(tag);
      }
      const cappedDirectRawTags = freshDirectRawTags.slice(0, MAX_DIRECT_SLOTS);

      const seq = computeNeighborhood(analyzed, cappedDirectRawTags, {});
      row.pushCandidatesPreTruncation = seq;

      // seq's direct-source count is already ≤ MAX_DIRECT_SLOTS by construction (cappedDirectRawTags
      // above) — no separate post-hoc cap pass needed.
      const selected = seq;

      const withArm = [];
      const newlySeen = [];
      for (const c of selected) {
        if (c.source === 'class-count') { withArm.push(c); continue; }
        if (seenSet.has(c.tag)) continue; // shadow-seen suppression (own state only)
        const cls = (byId.get(c.tag) || {}).class || '';
        let pol;
        try { pol = policy.resolve(sessionIdRaw || '', cls, { root: RECALL_ROOT }); }
        catch { pol = { arm: 'shadow', provenance: 'policy:corrupt' }; }
        withArm.push(Object.assign({}, c, { arm: pol.arm, provenance: pol.provenance }));
        newlySeen.push(c.tag);
      }
      // SHADOW_DIR was previously only created by appendShadowLine() at the very END of runHook(), so a
      // root's FIRST ever hook invocation reached this appendFileSync before the directory existed and
      // the write silently no-op'd (caught by the empty catch), losing that event's seen-budget entry
      // for good. mkdir here (idempotent, recursive) before the write so the very first call already
      // lands.
      if (newlySeen.length) {
        try { fs.mkdirSync(SHADOW_DIR, { recursive: true }); fs.appendFileSync(seenFile, newlySeen.join('\n') + '\n'); } catch {}
      }

      const packed = packCandidates(withArm.filter((c) => !(c.provenance === 'policy:randomized' && c.arm === 'shadow')), byId);
      row.pushSelected = withArm;
      row.quotaTruncated = packed.truncated;
      row.packedPreview = packed.text;
    }
  }

  appendShadowLine(row);
  process.exit(0);
}

module.exports = {
  computeNeighborhood, packCandidates, resolveRepoRel, classifyMemory, checkB30, truncateUtf8,
  computeWriterDimension, computeEchoDimension, computeRoutingDimension, computeLengthDimension,
  reconstructProspectiveShadow, titleKeyShadow, readLenBaseline,
};

// ── --self-test ─────────────────────────────────────────────────────────────────────────────────
// SELFTEST-BEGIN
function selfTest() {
  const os = require('os');
  const cp = require('child_process');
  const iso = require('./guards/selftest-iso.cjs');
  let pass = 0, fail = 0;
  const lines = [];
  function report(name, ok, detail) {
    if (ok) { pass++; lines.push('PASS ' + name); }
    else { fail++; lines.push('FAIL ' + name + (detail !== undefined ? (' :: ' + JSON.stringify(detail)) : '')); }
  }

  const nonce = 'test:pmmhookst-' + crypto.randomBytes(6).toString('hex');
  const runRootBase = 'pmmhook-st-' + crypto.randomBytes(4).toString('hex');
  // zero-footprint proof on the REAL root (iso.realHome(), derived from __dirname — never from
  // HOME/USERPROFILE/PMM_HOME, which every subprocess below has redirected to a temp T via
  // iso.isoEnv()). Every DUT subprocess this self-test spawns is launched with isoEnv(T, ...); this
  // file itself must therefore leave the real root's watch set untouched.
  const fpSnapshot = iso.footprint.begin();
  const tempRoots = [];
  function mkRoot(tag) {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), runRootBase + '-' + tag + '-'));
    tempRoots.push(T);
    return T.replace(/\\/g, '/');
  }
  function writeMemCorpus(T, lessonsContent) {
    fs.mkdirSync(T + '/.claude/memory', { recursive: true });
    fs.writeFileSync(T + '/.claude/memory/lessons.md', lessonsContent || '');
    // core.snapshot('worktree') defaults to requireAll=true (ALL_FILES = LIVE_FILES ∪ ARCHIVE_FILES)
    // — every fixture root needs all 7 files present (empty archives are fine) or snapshot() throws.
    for (const f of core.ALL_FILES) {
      if (f === 'lessons.md') continue;
      fs.writeFileSync(T + '/.claude/memory/' + f, '');
    }
  }
  function mach() { return (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12); }
  function runNode(scriptPath, args, env, stdinBuf) {
    const r = cp.spawnSync(process.execPath, [scriptPath].concat(args || []), {
      env, input: stdinBuf === undefined ? Buffer.alloc(0) : stdinBuf, maxBuffer: 16 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout || Buffer.alloc(0), stderr: r.stderr || Buffer.alloc(0) };
  }
  function readShadowLog(T) {
    try { return fs.readFileSync(T + '/.claude/.shadow/hook-' + mach() + '.log', 'utf8'); } catch { return ''; }
  }
  function lastJsonLine(text) {
    const ls = text.split('\n').filter(Boolean);
    if (!ls.length) return null;
    try { return JSON.parse(ls[ls.length - 1]); } catch { return null; }
  }
  function ledgerRowCount(T) {
    let n = 0;
    try {
      const dir = T + '/.claude/.local/pmm-recall';
      for (const f of fs.readdirSync(dir)) {
        if (/^events-v3-.*\.tsv$/.test(f)) n += fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).length;
      }
    } catch {}
    return n;
  }

  // ── group 1: silence — Post + --pre, 5 input shapes each ──
  {
    const T = mkRoot('silence');
    writeMemCorpus(T);
    const env = iso.isoEnv(T, {});
    const normalBuf = Buffer.from(JSON.stringify({
      tool_name: 'Edit', session_id: nonce + '-normal', tool_use_id: 'toolu_selftest_' + nonce,
      tool_input: { file_path: T + '/.claude/memory/probe.md' },
    }));
    const shapes = [
      ['normal', normalBuf],
      ['bad-json', Buffer.from('{ this is not json')],
      ['empty-stdin', Buffer.alloc(0)],
      ['null-root', Buffer.from('null')],
    ];
    for (const phaseArgs of [['--shadow'], ['--shadow', '--pre']]) {
      for (const [shapeName, buf] of shapes) {
        const r = runNode(__filename, phaseArgs, env, buf);
        report('silence[' + phaseArgs.join(' ') + '][' + shapeName + '] stdout=0B', r.stdout.length === 0, r.stdout.toString('utf8').slice(0, 80));
        report('silence[' + phaseArgs.join(' ') + '][' + shapeName + '] stderr=0B', r.stderr.length === 0, r.stderr.toString('utf8').slice(0, 80));
        report('silence[' + phaseArgs.join(' ') + '][' + shapeName + '] rc=0', r.status === 0, r.status);
      }
    }
    // unwritable root: a SEPARATE root whose .claude path is a plain FILE (mkdirSync(.claude/.shadow) fails).
    const T2 = mkRoot('unwritable');
    fs.writeFileSync(T2 + '/.claude', 'blocker-not-a-directory');
    const env2 = iso.isoEnv(T2, {});
    const r2 = runNode(__filename, ['--shadow'], env2, normalBuf);
    report('silence[--shadow][root-unwritable] stdout=0B', r2.stdout.length === 0);
    report('silence[--shadow][root-unwritable] stderr=0B', r2.stderr.length === 0);
    report('silence[--shadow][root-unwritable] rc=0', r2.status === 0, r2.status);

    report('silence: temp-root ledger has 0 rows after all silence runs', ledgerRowCount(T) === 0, ledgerRowCount(T));
    const shadowLogText = readShadowLog(T);
    const shadowLines = shadowLogText.split('\n').filter(Boolean);
    // 8 Post/Pre normal+bad-json+empty-stdin+null-root combinations = 8 lines expected (root-unwritable
    // writes to a DIFFERENT temp root T2 and cannot land here at all, by construction).
    report('silence: shadow log has exactly one line per (phase,shape) on T, each with tool_use_id where applicable',
      shadowLines.length === 8, shadowLines.length);
  }

  // ── group 2: shadow-attached vs shadow-not-attached parity for the AUTHORITATIVE trigger-recall
  //    guard; then a mutant that writes shadow state into the LIVE .trigger-seen-* file must break this
  //    parity (proving the test has teeth).
  {
    const TRIGGER_RECALL = path.resolve(__dirname, 'guards', 'pmm-trigger-recall.cjs');
    const lessonsK17 = '**2026-01-01 — K17 probe lesson** [tooling:k17-probe]\n' +
      '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=probe.md -->\n' +
      'body text for the K17 shadow/live parity probe.\n';
    function runK17(withShadow, hookPathOverride) {
      const T = mkRoot('k17-' + (withShadow ? 'with' : 'without'));
      writeMemCorpus(T, lessonsK17);
      const env = iso.isoEnv(T, {});
      const evt = Buffer.from(JSON.stringify({
        tool_name: 'Edit', session_id: nonce + '-k17', tool_use_id: 'toolu_selftest_' + nonce + '_k17',
        tool_input: { file_path: T + '/probe.md' },
      }));
      if (withShadow) runNode(hookPathOverride || __filename, ['--shadow'], env, evt);
      const tr = runNode(TRIGGER_RECALL, [], env, evt);
      const seenKeyVal = ledger.seenKey(nonce + '-k17', '');
      let seenContent = '';
      try { seenContent = fs.readFileSync(T + '/.claude/.trigger-seen-' + seenKeyVal, 'utf8'); } catch {}
      return { stdout: tr.stdout.toString('utf8'), seenContent };
    }
    const withoutShadow = runK17(false);
    const withShadow = runK17(true);
    report('K17: authoritative trigger-recall stdout identical with/without shadow attached',
      withShadow.stdout === withoutShadow.stdout,
      { withLen: withShadow.stdout.length, withoutLen: withoutShadow.stdout.length });
    report('K17: .trigger-seen-* content identical with/without shadow attached',
      withShadow.seenContent === withoutShadow.seenContent);

    // mutant: shadow hook writes its "own seen" state into the LIVE .trigger-seen-<key> file instead
    // of .shadow/seen-<key> — this must suppress trigger-recall's push and break the parity above.
    const src = fs.readFileSync(__filename, 'utf8');
    const marker = "const seenFile = SHADOW_DIR + '/seen-' + skey;";
    if (src.indexOf(marker) === -1) {
      report('K17 mutant: found the seen-file line to mutate', false, 'marker not found — source drifted');
    } else {
      const mutantSrc = src.replace(marker, "const seenFile = HOME + '/.claude/.trigger-seen-' + skey; // MUTANT: writes LIVE seen file");
      const mutantPath = path.join(__dirname, '.pmm-hook.selftest-mutant-k17-' + crypto.randomBytes(4).toString('hex') + '.cjs');
      fs.writeFileSync(mutantPath, mutantSrc);
      try {
        const withoutShadowM = runK17(false);
        const withShadowMutant = runK17(true, mutantPath);
        const broke = withShadowMutant.stdout !== withoutShadowM.stdout;
        report('K17 mutant "shadow writes live seen" turns parity RED', broke,
          { withLen: withShadowMutant.stdout.length, withoutLen: withoutShadowM.stdout.length });
      } finally {
        try { fs.rmSync(mutantPath, { force: true }); } catch {}
      }
    }
  }

  // ── group 3: Cause candidate order vs an independently-derived oracle; mutation must redden ──
  {
    const fixturePath = path.resolve(__dirname, 'guards', 'fixtures', 'v3', 'supersedes-cause-follows.md');
    let fixtureText = '';
    try { fixtureText = fs.readFileSync(fixturePath, 'utf8'); } catch (e) {
      report('K19: golden fixture supersedes-cause-follows.md is readable', false, e.message);
    }
    if (fixtureText) {
      const titleLine = '**2026-01-01 — supersedes target (will be superseded)** [fx:scf-old]';
      const idx = fixtureText.indexOf(titleLine);
      report('K19: fx:scf-old title line found in fixture', idx !== -1);
      if (idx !== -1) {
        const insertAt = idx + titleLine.length;
        const triggerLine = '\n<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=k19-probe.md -->';
        const patched = fixtureText.slice(0, insertAt) + triggerLine + fixtureText.slice(insertAt);

        function runK19(hookPath) {
          const T = mkRoot('k19');
          writeMemCorpus(T, patched);
          const env = iso.isoEnv(T, {});
          const evt = Buffer.from(JSON.stringify({
            tool_name: 'Edit', session_id: nonce + '-k19', tool_use_id: 'toolu_selftest_' + nonce + '_k19',
            tool_input: { file_path: T + '/k19-probe.md' },
          }));
          runNode(hookPath, ['--shadow'], env, evt);
          const row = lastJsonLine(readShadowLog(T));
          return row;
        }
        function computeOracle() {
          // INDEPENDENT path — re-derives the expected sequence directly from core.analyze()'s
          // causeEdges/effectsOf/follows/precedes-backed entry fields, with its own separately-written
          // traversal (never calls computeNeighborhood()). Covers BOTH ② (cause+effect) and ③
          // (follows+precedes) so an order-swap between them, or a narrower "drop only effect"
          // mutation, both produce a sequence this oracle can catch.
          const T = mkRoot('k19-oracle');
          writeMemCorpus(T, patched);
          const savedMemDir = process.env.PMM_MEM_DIR;
          process.env.PMM_MEM_DIR = T + '/.claude/memory';
          let out;
          try {
            const snap = core.snapshot('worktree');
            const analyzed = core.analyze(snap, {});
            const byId = new Map(analyzed.entries.map((e) => [e.id, e]));
            // fx:scf-new supersedes fx:scf-old, so ① head-resolution (computeNeighborhood()'s
            // directResolved step, driven by core.analyze()'s precomputed entries[].head — read here as
            // a plain graph field, not re-derived) walks the direct hit fx:scf-old to its head
            // fx:scf-new BEFORE ② ③ ever look up cause/effects/follows/precedes. The oracle must
            // resolve the same head or it queries the wrong node.
            const directRaw = 'fx:scf-old';
            const direct = ((byId.get(directRaw) || {}).head) || directRaw;
            const e = byId.get(direct);
            const rows = [{ tag: direct, source: 'direct' }];
            const withDates = (arr, label) => arr.map((t) => ({ tag: t, label, dateISO: (byId.get(t) || {}).dateISO || '' }))
              .sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.tag.localeCompare(b.tag)));
            const causeRows = withDates(e.cause || [], '因');
            const effectRows = withDates(e.effects || [], '果');
            for (const c of causeRows.concat(effectRows)) rows.push({ tag: c.tag, source: c.label === '因' ? 'cause' : 'effect' });
            const followRows = withDates(e.follows || [], '先');
            const precedeRows = withDates(e.precedes || [], '后');
            for (const c of followRows.concat(precedeRows)) rows.push({ tag: c.tag, source: c.label === '先' ? 'follows' : 'precedes' });
            out = rows;
          } finally {
            if (savedMemDir === undefined) delete process.env.PMM_MEM_DIR; else process.env.PMM_MEM_DIR = savedMemDir;
          }
          return out;
        }
        function simplify(row) {
          if (!row || !row.pushCandidatesPreTruncation) return null;
          return row.pushCandidatesPreTruncation.map((c) => ({ tag: c.tag, source: c.source }));
        }
        const oracle = computeOracle();
        report('K19: oracle has both an effect row and a precedes row (fixture choice has teeth)',
          oracle.some((r) => r.source === 'effect') && oracle.some((r) => r.source === 'precedes'), oracle);
        const actualRow = runK19(__filename);
        const actual = simplify(actualRow);
        report('K19: hook candidate sequence (pre-truncation) equals independent oracle',
          JSON.stringify(actual) === JSON.stringify(oracle), { actual, oracle });

        function mutateAndCheck(label, mutantSrc) {
          const mutantPath = path.join(__dirname, '.pmm-hook.selftest-mutant-k19-' + crypto.randomBytes(4).toString('hex') + '.cjs');
          fs.writeFileSync(mutantPath, mutantSrc);
          try {
            const mutantRow = runK19(mutantPath);
            const mutantActual = simplify(mutantRow);
            const stillMatches = JSON.stringify(mutantActual) === JSON.stringify(oracle);
            report(label, !stillMatches, { mutantActual, oracle });
          } finally {
            try { fs.rmSync(mutantPath, { force: true }); } catch {}
          }
        }

        const hookSrc = fs.readFileSync(__filename, 'utf8');

        // mutation 1: strip the whole CAUSE-BRANCH block (cause+effect together) and confirm the
        // comparison goes red.
        {
          const beginTag = '// CAUSE-BRANCH-BEGIN';
          const endTag = '// CAUSE-BRANCH-END';
          const bi = hookSrc.indexOf(beginTag), ei = hookSrc.indexOf(endTag);
          if (bi === -1 || ei === -1 || ei < bi) {
            report('K19 mutant: CAUSE-BRANCH markers found', false, { bi, ei });
          } else {
            const mutantSrc = hookSrc.slice(0, bi) + '// CAUSE-BRANCH-REMOVED-BY-MUTATION-TEST' + hookSrc.slice(ei + endTag.length);
            mutateAndCheck('K19 mutant "delete Cause branch" turns the comparison RED', mutantSrc);
          }
        }

        // mutation 2: swap the ②(CAUSE-BRANCH) and ③(FOLLOWS-BRANCH) blocks' bodies — a pure
        // reordering, same set of tags, only sequence position changes — and confirm the comparison
        // goes red (proves the oracle's fixed ②-then-③ emission order is actually checked).
        {
          function extractBlock(src, beginTag, endTag) {
            const bi = src.indexOf(beginTag), ei = src.indexOf(endTag);
            if (bi === -1 || ei === -1 || ei < bi) return null;
            return { start: bi, end: ei + endTag.length, text: src.slice(bi, ei + endTag.length) };
          }
          const causeBlock = extractBlock(hookSrc, '// CAUSE-BRANCH-BEGIN', '// CAUSE-BRANCH-END');
          const followsBlock = extractBlock(hookSrc, '// FOLLOWS-BRANCH-BEGIN', '// FOLLOWS-BRANCH-END');
          if (!causeBlock || !followsBlock || causeBlock.start > followsBlock.start) {
            report('K19 mutant: CAUSE-BRANCH/FOLLOWS-BRANCH markers found in ②-before-③ order', false, { causeBlock: !!causeBlock, followsBlock: !!followsBlock });
          } else {
            const mutantSrc = hookSrc.slice(0, causeBlock.start) + followsBlock.text +
              hookSrc.slice(causeBlock.end, followsBlock.start) + causeBlock.text +
              hookSrc.slice(followsBlock.end);
            mutateAndCheck('K19 mutant "swap ②③ order" turns the comparison RED', mutantSrc);
          }
        }

        // mutation 3: drop only the effect sub-branch inside ②, leaving cause untouched — narrower than
        // mutation 1, and confirms the comparison goes red even when the whole CAUSE-BRANCH block is
        // otherwise intact.
        {
          const effectLine = "const effects = (e.effects || []).map((t) => ({ tag: t, label: '果' })).sort(byDateThenTag);";
          if (hookSrc.indexOf(effectLine) === -1) {
            report('K19 mutant: effects-line found to mutate', false, 'marker not found — source drifted');
          } else {
            const mutantSrc = hookSrc.replace(effectLine, "const effects = []; // MUTANT: 果 branch dropped, 因 untouched");
            mutateAndCheck('K19 mutant "delete only 果 branch" turns the comparison RED', mutantSrc);
          }
        }
      }
    }
  }

  // ── group 4: 1.2KB quota packing ──
  {
    const analyzedStub = {
      entries: [
        { id: 'a:one', title: 'X'.repeat(700), dateISO: '2026-01-01' },
        { id: 'a:two', title: 'Y'.repeat(700), dateISO: '2026-01-02' },
        { id: 'a:three', title: 'Z'.repeat(700), dateISO: '2026-01-03' },
      ],
    };
    const byId = new Map(analyzedStub.entries.map((e) => [e.id, e]));
    // three ~732B candidate lines (title padded so "- [tag] TITLE" totals ~732 bytes each).
    const seq = analyzedStub.entries.map((e, i) => ({ tag: e.id, source: i === 0 ? 'direct' : 'cause', label: i === 0 ? undefined : '因' }));
    const packed = packCandidates(seq, byId);
    report('quota: 3x~732B candidates pack to <=1200B', utf8Len(packed.text) <= QUOTA_BYTES, utf8Len(packed.text));
    report('quota: truncation flagged', packed.truncated === true);
  }

  // ── group 5: settings.json wiring (exact matcher strings) ──
  {
    let settingsRaw = '';
    try { settingsRaw = fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'); } catch (e) {}
    let settings = null;
    try { settings = JSON.parse(settingsRaw); } catch (e) {}
    function findHook(eventName, matcher, cmdSubstr) {
      if (!settings || !settings.hooks || !settings.hooks[eventName]) return false;
      for (const block of settings.hooks[eventName]) {
        if (block.matcher !== matcher) continue;
        for (const h of block.hooks || []) {
          if (typeof h.command === 'string' && h.command.indexOf(cmdSubstr) !== -1) return true;
        }
      }
      return false;
    }
    report('wiring: PostToolUse matcher "Edit|Write|MultiEdit|NotebookEdit" runs pmm-hook.cjs --shadow (no --pre)',
      findHook('PostToolUse', 'Edit|Write|MultiEdit|NotebookEdit', 'pmm-hook.cjs" --shadow') &&
      !findHook('PostToolUse', 'Edit|Write|MultiEdit|NotebookEdit', 'pmm-hook.cjs" --shadow --pre'));
    report('wiring: PreToolUse matcher "Edit|Write|MultiEdit" runs pmm-hook.cjs --shadow --pre',
      findHook('PreToolUse', 'Edit|Write|MultiEdit', 'pmm-hook.cjs" --shadow --pre'));
  }

  // ── group 6: Pre must never consume the shadow seen-budget; only Post (the SAME phase the
  //    authoritative trigger-recall guard runs in) may. Replays a 16-event Edit stream (3 matching
  //    files x 2 (session,agent) pairs, interleaved with 6 non-matching fillers) through Pre-then-Post
  //    on a FRESH root — exercising the mkdir-before-seen-write ordering fix too, since a fresh root's
  //    very first call is exactly where that bug hid — and separately through the authoritative
  //    trigger-recall guard on an identically-seeded root.
  {
    const TRIGGER_RECALL = path.resolve(__dirname, 'guards', 'pmm-trigger-recall.cjs');
    const lessonsH1 =
      '**2026-01-01 — H1 stream lesson A** [tooling:h1-stream-a]\n' +
      '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=alpha.md -->\n' +
      'body A.\n\n' +
      '**2026-01-02 — H1 stream lesson B** [tooling:h1-stream-b]\n' +
      '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=beta.md -->\n' +
      'body B.\n\n' +
      '**2026-01-03 — H1 stream lesson C** [tooling:h1-stream-c]\n' +
      '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=gamma.md -->\n' +
      'body C.\n';
    const files16 = ['alpha.md', 'other-1.md', 'beta.md', 'other-2.md', 'gamma.md', 'alpha.md', 'other-3.md', 'beta.md',
      'gamma.md', 'other-4.md', 'alpha.md', 'beta.md', 'other-5.md', 'gamma.md', 'other-6.md', 'alpha.md'];
    const sessAgent16 = [[nonce + '-h1s1', 'h1-agent-1'], [nonce + '-h1s2', 'h1-agent-2']];

    function runH1Stream(hookForPre, hookForPost, tag) {
      const T = mkRoot('h1stream-' + tag);
      writeMemCorpus(T, lessonsH1);
      const env = iso.isoEnv(T, {});
      for (let i = 0; i < files16.length; i++) {
        const [sid, agent] = sessAgent16[i % sessAgent16.length];
        const evt = Buffer.from(JSON.stringify({
          tool_name: 'Edit', session_id: sid, agent_id: agent,
          tool_use_id: 'toolu_selftest_' + nonce + '_h1s_' + i,
          tool_input: { file_path: T + '/' + files16[i] },
        }));
        runNode(hookForPre, ['--shadow', '--pre'], env, evt);
        runNode(hookForPost, ['--shadow'], env, evt);
      }
      const rows = readShadowLog(T).split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const prePush = rows.filter((r) => r.phase === 'pre').reduce((n, r) => n + (r.pushSelected || []).length, 0);
      const postRowsWithPush = rows.filter((r) => r.phase === 'post' && (r.pushSelected || []).length > 0).length;
      return { prePush, postRowsWithPush, rows };
    }

    const stream = runH1Stream(__filename, __filename, 'fixed');
    report('H-1: 16-event stream — Pre push count is 0 across every event', stream.prePush === 0, stream.prePush);
    report('H-1: 16-event stream — Post has at least one row with a non-empty push', stream.postRowsWithPush > 0, stream.postRowsWithPush);

    // authoritative comparison, same 16-event stream, on an identically-seeded SEPARATE root (Post-only
    // — trigger-recall is only ever wired at PostToolUse, per settings.json).
    const authT = mkRoot('h1stream-auth');
    writeMemCorpus(authT, lessonsH1);
    const authEnv = iso.isoEnv(authT, {});
    let authPushRows = 0;
    for (let i = 0; i < files16.length; i++) {
      const [sid, agent] = sessAgent16[i % sessAgent16.length];
      const evt = Buffer.from(JSON.stringify({
        tool_name: 'Edit', session_id: sid, agent_id: agent,
        tool_use_id: 'toolu_selftest_' + nonce + '_h1s_' + i,
        tool_input: { file_path: authT + '/' + files16[i] },
      }));
      const r = runNode(TRIGGER_RECALL, [], authEnv, evt);
      if (r.stdout && r.stdout.length > 0) authPushRows++;
    }
    report('H-1: shadow Post push-row count >= authoritative push-row count on the same 16-event stream',
      stream.postRowsWithPush >= authPushRows, { shadowPostRows: stream.postRowsWithPush, authPushRows });

    // mutation: reintroduce H-1 (Pre also runs the push/seen block) — "Pre push count is 0" must redden.
    const h1Src = fs.readFileSync(__filename, 'utf8');
    const h1Marker = 'if (repo && rel && !isPre) {';
    if (h1Src.indexOf(h1Marker) === -1) {
      report('H-1 mutant: found the Post-only guard to mutate', false, 'marker not found — source drifted');
    } else {
      const h1MutantSrc = h1Src.replace(h1Marker, 'if (repo && rel) { // MUTANT: H-1 reintroduced -- Pre also runs push/seen');
      const h1MutantPath = path.join(__dirname, '.pmm-hook.selftest-mutant-h1-' + crypto.randomBytes(4).toString('hex') + '.cjs');
      fs.writeFileSync(h1MutantPath, h1MutantSrc);
      try {
        const mutantStream = runH1Stream(h1MutantPath, h1MutantPath, 'mutant');
        report('H-1 mutant "Pre also consumes seen" turns Pre-push-is-0 RED', mutantStream.prePush > 0, mutantStream.prePush);
      } finally {
        try { fs.rmSync(h1MutantPath, { force: true }); } catch {}
      }
    }
  }

  // ── group 7: direct-hit scan order matches authority's per-file order (lessons.md before
  //    decisions.md, NOT core.ALL_FILES' decisions-first order) and seen-suppression is applied BEFORE
  //    the ≤3 cap, not after. One entry lives in decisions.md ([tooling:h1o-d]), three in lessons.md
  //    ([tooling:h1o-l1/l2/l3]), all four sharing the SAME path trigger so a single edit event matches
  //    all four. Event 1 (fresh session, nothing seen yet): lessons-first order means the cap keeps the
  //    three lessons.md tags and drops the decisions.md one — an ALL_FILES (decisions-first) order
  //    would instead keep decisions.md + only 2 of the 3 lessons.md tags. Event 2 (same session, same
  //    file — after event 1 already marked the three lessons.md tags "seen"): seen-then-cap means the
  //    now-fresh decisions.md tag (never pushed, never marked seen, because it was cap-dropped not
  //    seen-dropped in event 1) gets its OWN turn and is pushed; cap-then-seen (the pre-fix order)
  //    would instead have capped to the three already-seen lessons.md tags FIRST and only then
  //    discovered all three are seen, pushing nothing.
  {
    function runH1Order(hookPath, T, tuidSuffix) {
      const env = iso.isoEnv(T, {});
      const evt = Buffer.from(JSON.stringify({
        tool_name: 'Edit', session_id: nonce + '-h1order', agent_id: 'h1o-agent',
        tool_use_id: 'toolu_selftest_' + nonce + '_h1o_' + tuidSuffix,
        tool_input: { file_path: T + '/h1order.md' },
      }));
      runNode(hookPath, ['--shadow'], env, evt);
      return lastJsonLine(readShadowLog(T));
    }
    function mkH1OrderRoot(tag) {
      const T = mkRoot('h1order-' + tag);
      fs.mkdirSync(T + '/.claude/memory', { recursive: true });
      fs.writeFileSync(T + '/.claude/memory/decisions.md',
        '**2026-01-01 — H1 order/cap probe (decisions)** [tooling:h1o-d]\n' +
        '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=h1order.md -->\n' +
        'body d.\n');
      fs.writeFileSync(T + '/.claude/memory/lessons.md',
        '**2026-01-01 — H1 order/cap probe (lessons 1)** [tooling:h1o-l1]\n' +
        '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=h1order.md -->\n' +
        'body l1.\n\n' +
        '**2026-01-02 — H1 order/cap probe (lessons 2)** [tooling:h1o-l2]\n' +
        '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=h1order.md -->\n' +
        'body l2.\n\n' +
        '**2026-01-03 — H1 order/cap probe (lessons 3)** [tooling:h1o-l3]\n' +
        '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=h1order.md -->\n' +
        'body l3.\n');
      for (const f of core.ALL_FILES) { if (f !== 'decisions.md' && f !== 'lessons.md') fs.writeFileSync(T + '/.claude/memory/' + f, ''); }
      return T;
    }
    function directTagsOf(row) {
      return ((row && row.pushCandidatesPreTruncation) || []).filter((c) => c.source === 'direct').map((c) => c.tag);
    }
    function runH1OrderScenario(hookPath) {
      const T = mkH1OrderRoot(path.basename(hookPath).replace(/[^A-Za-z0-9]/g, '').slice(-8));
      const row1 = runH1Order(hookPath, T, 'e1');
      const row2 = runH1Order(hookPath, T, 'e2');
      return { event1Direct: directTagsOf(row1), event2Direct: directTagsOf(row2) };
    }

    const real = runH1OrderScenario(__filename);
    report('H1 order: event 1 (fresh session) keeps the 3 lessons.md tags, drops decisions.md (lessons-first order)',
      JSON.stringify(real.event1Direct) === JSON.stringify(['tooling:h1o-l1', 'tooling:h1o-l2', 'tooling:h1o-l3']), real.event1Direct);
    report('H1 seen-then-cap: event 2 (same session) pushes the now-fresh decisions.md tag, not empty',
      JSON.stringify(real.event2Direct) === JSON.stringify(['tooling:h1o-d']), real.event2Direct);

    const h1oSrc = fs.readFileSync(__filename, 'utf8');

    // mutation 1 (order): scan in core.ALL_FILES order (decisions.md before lessons.md) instead of the
    // authoritative lessons-first order — event 1 must then keep decisions.md + only 2/3 lessons.md
    // tags, breaking the "3 lessons.md tags survive" assertion above.
    {
      const orderMarker = "const AUTH_FILE_ORDER = ['lessons.md', 'decisions.md', 'standinginstructions.md', 'classes.md',\n      'lessons-archive.md', 'decisions-archive.md', 'standinginstructions-archive.md'];";
      if (h1oSrc.indexOf(orderMarker) === -1) {
        report('H1 order mutant: found AUTH_FILE_ORDER literal to mutate', false, 'marker not found — source drifted');
      } else {
        const mutantSrc = h1oSrc.replace(orderMarker, 'const AUTH_FILE_ORDER = core.ALL_FILES; // MUTANT: decisions-first order reintroduced');
        const mutantPath = path.join(__dirname, '.pmm-hook.selftest-mutant-h1order-' + crypto.randomBytes(4).toString('hex') + '.cjs');
        fs.writeFileSync(mutantPath, mutantSrc);
        try {
          const mutantResult = runH1OrderScenario(mutantPath);
          const stillMatches = JSON.stringify(mutantResult.event1Direct) === JSON.stringify(['tooling:h1o-l1', 'tooling:h1o-l2', 'tooling:h1o-l3']);
          report('H1 order mutant "decisions-first scan order" turns the event-1 assertion RED', !stillMatches, mutantResult.event1Direct);
        } finally {
          try { fs.rmSync(mutantPath, { force: true }); } catch {}
        }
      }
    }

    // mutation 2 (cap-before-seen): drop the seen check from the dedup loop and instead cap first, THEN
    // filter seen — event 2 must then push nothing (the 3 already-seen lessons.md tags fill the cap
    // before the fresh decisions.md tag is ever considered, then all 3 get seen-filtered away), breaking
    // the "event 2 pushes tooling:h1o-d" assertion above.
    {
      const capMarker =
        '        if (dedupHeads.has(headTag)) continue;\n' +
        '        dedupHeads.add(headTag);\n' +
        '        if (seenSet.has(headTag)) continue;\n' +
        '        freshDirectRawTags.push(tag);\n' +
        '      }\n' +
        '      const cappedDirectRawTags = freshDirectRawTags.slice(0, MAX_DIRECT_SLOTS);';
      if (h1oSrc.indexOf(capMarker) === -1) {
        report('H1 cap mutant: found the seen-then-cap block to mutate', false, 'marker not found — source drifted');
      } else {
        const mutantCapSrc =
          '        if (dedupHeads.has(headTag)) continue;\n' +
          '        dedupHeads.add(headTag);\n' +
          '        freshDirectRawTags.push(tag); // MUTANT: seen check removed here (H1 regression)\n' +
          '      }\n' +
          '      const cappedDirectRawTags = freshDirectRawTags.slice(0, MAX_DIRECT_SLOTS).filter((tag) => {\n' +
          '        const e = byId.get(tag); const headTag2 = (e && e.head) ? e.head : tag; return !seenSet.has(headTag2);\n' +
          '      }); // MUTANT: cap BEFORE seen-filter (H1 regression)';
        const mutantSrc = h1oSrc.replace(capMarker, mutantCapSrc);
        const mutantPath = path.join(__dirname, '.pmm-hook.selftest-mutant-h1cap-' + crypto.randomBytes(4).toString('hex') + '.cjs');
        fs.writeFileSync(mutantPath, mutantSrc);
        try {
          const mutantResult = runH1OrderScenario(mutantPath);
          const stillMatches = JSON.stringify(mutantResult.event2Direct) === JSON.stringify(['tooling:h1o-d']);
          report('H1 cap mutant "cap-before-seen" turns the event-2 assertion RED', !stillMatches, mutantResult.event2Direct);
        } finally {
          try { fs.rmSync(mutantPath, { force: true }); } catch {}
        }
      }
    }
  }

  // ── group 8: writer dimension — one red→green case: rewriting an entry's legal trigger comment into
  //    a bogus one must surface a B5 key in row.writer on the Pre-phase row.
  {
    const T = mkRoot('writer');
    fs.mkdirSync(T + '/.claude/memory', { recursive: true });
    fs.writeFileSync(T + '/.claude/memory/lessons.md',
      '## Index\n- 2026-01-01 [tooling:writer-probe]\n\n## Entries\n' +
      '**2026-01-01 — writer probe entry** [tooling:writer-probe]\n' +
      '<!-- trigger: tool=Edit; repo=home; path=writer-probe.md -->\nbody.\n');
    for (const f of core.ALL_FILES) { if (f !== 'lessons.md') fs.writeFileSync(T + '/.claude/memory/' + f, ''); }
    const env = iso.isoEnv(T, {});
    const evt = Buffer.from(JSON.stringify({
      tool_name: 'Edit', session_id: nonce + '-writer', tool_use_id: 'toolu_selftest_' + nonce + '_writer',
      tool_input: {
        file_path: T + '/.claude/memory/lessons.md',
        old_string: '<!-- trigger: tool=Edit; repo=home; path=writer-probe.md -->',
        new_string: '<!-- trigger: bogus -->',
      },
    }));
    runNode(__filename, ['--shadow', '--pre'], env, evt);
    const row = lastJsonLine(readShadowLog(T));
    report('writer: row.writer carries a B5 key (code|basename|L<line>) for an illegal trigger rewrite',
      !!(row && row.writer && row.writer.b5b32Total > 0 && row.writer.b5b32Keys.some((k) => /^B5\|lessons\.md\|L\d+$/.test(k))),
      row && row.writer);
  }

  // ── group 9: echo dimension — one red→green case: referencing a live tag in the new text must
  //    surface it as (tag, 现行) on the Post-phase row.
  {
    const T = mkRoot('echo');
    fs.mkdirSync(T + '/.claude/memory', { recursive: true });
    fs.writeFileSync(T + '/.claude/memory/lessons.md', '**2026-01-01 — echo probe entry** [tooling:echo-probe]\nbody.\n');
    for (const f of core.ALL_FILES) { if (f !== 'lessons.md') fs.writeFileSync(T + '/.claude/memory/' + f, ''); }
    const env = iso.isoEnv(T, {});
    const evt = Buffer.from(JSON.stringify({
      tool_name: 'Edit', session_id: nonce + '-echo', tool_use_id: 'toolu_selftest_' + nonce + '_echo',
      tool_input: { file_path: T + '/.claude/memory/decisions.md', old_string: 'x', new_string: 'see [[tooling:echo-probe]] for context' },
    }));
    runNode(__filename, ['--shadow'], env, evt);
    const row = lastJsonLine(readShadowLog(T));
    report('echo: row.echo reports the referenced live tag as 现行',
      !!(row && Array.isArray(row.echo) && row.echo.some((e) => e.tag === 'tooling:echo-probe' && e.status === '现行')),
      row && row.echo);
  }

  // ── group 10: routing dimension — one red→green case: a project-namespaced (fallback-list) identity
  //    title in lessons.md must surface as an rc=2 hit line regardless of which file the event actually
  //    touched (the legacy hook never looks at the event).
  {
    const T = mkRoot('routing');
    fs.mkdirSync(T + '/.claude/memory', { recursive: true });
    fs.writeFileSync(T + '/.claude/memory/lessons.md', '**2026-01-01 — leaked project lesson** [example-project:routing-probe]\nbody.\n');
    for (const f of core.ALL_FILES) { if (f !== 'lessons.md') fs.writeFileSync(T + '/.claude/memory/' + f, ''); }
    const env = iso.isoEnv(T, {});
    const evt = Buffer.from(JSON.stringify({
      tool_name: 'Edit', session_id: nonce + '-routing', tool_use_id: 'toolu_selftest_' + nonce + '_routing',
      tool_input: { file_path: T + '/.claude/memory/decisions.md', old_string: 'x', new_string: 'y' },
    }));
    runNode(__filename, ['--shadow'], env, evt);
    const row = lastJsonLine(readShadowLog(T));
    report('routing: row.routing flags the example-project-namespaced lessons.md line (fallback ns list), rc=2',
      !!(row && row.routing && row.routing.rc === 2 && row.routing.hits.some((h) => h.indexOf('example-project:routing-probe') !== -1)),
      row && row.routing);
  }

  // ── group 11: length dimension — one red→green case: an attribution line declaring a verbatim quote
  //    (原话) must surface the absolute 原话引用 class (no baseline needed).
  {
    const T = mkRoot('length');
    fs.mkdirSync(T + '/.claude/memory', { recursive: true });
    fs.writeFileSync(T + '/.claude/memory/decisions.md',
      '**2026-01-01 — length probe entry** [tooling:length-probe]\n<!-- attribution: 用户原话, 2026-01-01 -->\nbody.\n');
    for (const f of core.ALL_FILES) { if (f !== 'decisions.md') fs.writeFileSync(T + '/.claude/memory/' + f, ''); }
    const env = iso.isoEnv(T, {});
    const evt = Buffer.from(JSON.stringify({
      tool_name: 'Edit', session_id: nonce + '-length', tool_use_id: 'toolu_selftest_' + nonce + '_length',
      tool_input: { file_path: T + '/.claude/memory/decisions.md', old_string: 'x', new_string: 'y' },
    }));
    runNode(__filename, ['--shadow'], env, evt);
    const row = lastJsonLine(readShadowLog(T));
    report('length: row.length.classes includes 原话引用 for an attribution line containing 原话',
      !!(row && row.length && Array.isArray(row.length.classes) && row.length.classes.includes('原话引用')),
      row && row.length);
    report('length: row.length.notComputed lists 取代图/冗余 (not silently dropped)',
      !!(row && row.length && row.length.notComputed && row.length.notComputed.includes('取代图') && row.length.notComputed.includes('冗余')));
  }

  for (const T of tempRoots) { try { fs.rmSync(T, { recursive: true, force: true }); } catch {} }

  const markers = iso.markersFromSource(__filename, nonce, runRootBase);
  const fpResult = iso.footprint.end(fpSnapshot, markers);
  report('footprint: zero attributable change on the real root', fpResult.red === false, fpResult.line);

  for (const l of lines) console.log(l);
  console.log('PMM-HOOK-SELFTEST {"pass":' + pass + ',"fail":' + fail + '}');
  process.exit(fail > 0 ? 1 : 0);
}
// SELFTEST-END

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    selfTest();
  } else if (argv.includes('--shadow')) {
    runHook(argv);
  } else {
    process.exit(0); // no-op outside --shadow: never a live/authoritative code path in C0.5.
  }
}
