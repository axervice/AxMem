'use strict';
// CC source proof over memory-source's already-parsed, stat-bound snapshot.
// Codex's manifest/buffer proof is intentionally unchanged. Never reparse a
// file per selection method (topic/citation/action) in the CC event path.
const { REQUIRED } = require('./memory-source.cjs');
const { compileTriggerPath, testTriggerPath } = require('../guards/pmm-trigger-glob.cjs');
const TRUST = new Set([null, 'observed', 'derived', 'user-ratified']);
const blockText = (s) => s.replace(/\r\n?/g, '\n').replace(/[ \t\n]+$/, '');
function proveCorpus(corpus, graph, checkDeadline) {
  const { entries, sources } = corpus;
  const byLocation = new Map(entries.map((e) => [e.file + ':' + e.line, e]));
  const bound = new Map(), triggerRoots = [];
  let disagreement = 0, malformed = 0;
  for (const [file, source] of sources.files) {
    checkDeadline?.();
    const parsed = source.parsed;
    if (!parsed) throw new Error('source-proof-unavailable');
    const invalid = parsed.diagnostics.filter((d) => d.code === 'B5').map((d) => d.line);
    malformed += new Set(invalid).size;
    for (const block of parsed.entries) {
      const e = byLocation.get(file + ':' + block.titleLineNo);
      if (!e || e.tag !== block.id || e.archived !== block.archived || e.trust !== block.trust || e.date !== block.dateISO ||
          blockText(e.text) !== blockText(block.body)) { disagreement++; continue; }
      if (invalid.some((n) => n >= block.lineRange[0] && n <= block.lineRange[1]) ||
          !TRUST.has(e.trust) || graph.excluded.has(e.tag) || graph.byTag.get(e.tag)?.length !== 1 || bound.has(e.tag)) continue;
      bound.set(e.tag, { entry: e, block });
      if (block.triggers.some((t) => t.kind === 'path')) triggerRoots.push(e);
    }
  }
  const current = entries.filter((e) => REQUIRED.has(e.file) && !e.archived &&
    !graph.excluded.has(e.tag) && graph.byTag.get(e.tag)?.length === 1 && !graph.next.has(e.tag) && bound.get(e.tag)?.entry === e);
  const byTag = new Map(current.map((e) => [e.tag, e]));
  function verifiedHead(tag) {
    const seen = new Set(); let cursor = tag;
    for (let depth = 0; depth <= 8; depth++) {
      if (!bound.has(cursor) || seen.has(cursor) || graph.excluded.has(cursor)) return null;
      seen.add(cursor);
      const next = graph.next.get(cursor);
      if (!next || !next.size) return cursor;
      if (next.size !== 1 || depth === 8) return null;
      const successor = [...next][0];
      if (!bound.get(successor)?.block.supersedes.includes(cursor)) return null;
      cursor = successor;
    }
    return null;
  }
  return { current, byTag, triggerRoots, verifiedHead, disagreement, malformed };
}
function citations(scan, graph, strict = true) {
  const found = [];
  scan = scan.replace(/<!--[\s\S]*?-->/g, (s) => ' '.repeat(s.length));
  const left = (ch) => ch === undefined || /[\s"'([{,;，。；、\p{Script=Han}]/u.test(ch);
  const right = (ch) => ch === undefined || /[\s"')\]},;!?，。；、\p{Script=Han}]/u.test(ch);
  for (const m of scan.matchAll(/[a-z][a-z0-9-]*:[A-Za-z0-9._-]+/g)) {
    const end = m.index + m[0].length;
    if (!left(scan[m.index - 1]) || !right(scan[end])) continue;
    const suffix = scan.slice(end + 1);
    if (strict && (scan[end] === ']' || scan[end] === ')') &&
        (/^[A-Za-z0-9_\/\\]/.test(suffix) || /^\.[\p{L}\p{N}_-]/u.test(suffix) || /^\.\.[\/\\]/.test(suffix))) continue;
    let tag = m[0];
    if (!graph.byTag.has(tag) && /\.$/.test(tag)) {
      const stripped = tag.replace(/\.+$/, '');
      if (graph.byTag.get(stripped)?.length === 1 && !graph.excluded.has(stripped)) tag = stripped;
    }
    if (graph.byTag.has(tag) && !found.includes(tag)) found.push(tag);
  }
  return found;
}
function actionHits(proof, action, checkDeadline) {
  const hits = [];
  for (const e of proof.triggerRoots) {
    checkDeadline?.();
    const fired = e.triggers.some((t) => {
      if (t.kind !== 'path' || t.repo !== action.repo || !t.tools.includes(action.tool)) return false;
      try { return testTriggerPath(compileTriggerPath(t.path), action.path); } catch { return false; }
    });
    const head = fired && proof.verifiedHead(e.tag);
    if (head && proof.byTag.has(head)) hits.push({ entry: proof.byTag.get(head), from: head !== e.tag ? e.tag : null });
  }
  return hits;
}
module.exports = { proveCorpus, citations, actionHits };
