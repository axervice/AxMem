'use strict';
// Persistent CC search preparation. Same MiniSearch options, tokenization and
// strict-support dominance policy as the mature selector; Codex stays read-only.
// No query, prompt, command or user text is ever written to this derived cache.
const fs = require('node:fs');
const path = require('node:path');
const MiniSearch = require('../guards/vendor/minisearch/index.cjs');
const engine = require('../adapters/codex/recall-selector.cjs')._shared;
const { REQUIRED, sha } = require('./memory-source.cjs');
const { citations } = require('./recall-source-proof.cjs');
const { writeFileAtomicSync } = require('../lib/atomic-write.cjs');
const VERSION = 'cc-topic-v2:' + sha(Buffer.concat([fs.readFileSync(__filename),
  fs.readFileSync(require.resolve('../adapters/codex/recall-selector.cjs')),
  fs.readFileSync(require.resolve('../guards/vendor/minisearch/index.cjs'))]));
const OPTIONS = { idField: 'id', fields: ['title', 'body'], storeFields: [],
  tokenize: engine.tokenize, processTerm: (term) => term,
  searchOptions: { combineWith: 'OR', prefix: false, fuzzy: false } };
function prepare(corpus, current, cacheDir, checkDeadline) {
  const signature = sha(JSON.stringify([VERSION, corpus.snapshotId, current.map((e) => e.tag)]));
  const file = cacheDir && path.join(cacheDir, sha(corpus.sources.root) + '.json');
  if (file) {
    try {
      if (fs.statSync(file).size <= 32 * 1024 * 1024) {
        const c = JSON.parse(fs.readFileSync(file, 'utf8'));
        checkDeadline?.();
        if (c.signature === signature && Array.isArray(c.terms)) {
          const mini = MiniSearch.loadJS(c.index, OPTIONS);
          const terms = new Map(c.terms.map(([id, tokens]) => [id, new Set(tokens)]));
          return { mini, terms };
        }
      }
    } catch (e) { if (e.reason === 'recall-deadline-exceeded') throw e; /* rebuild derived cache */ }
  }
  checkDeadline?.();
  const docs = current.map((e) => ({ id: e.tag, title: e.title || '', body: engine.searchableProse(e) }));
  const mini = new MiniSearch(OPTIONS);
  if (docs.length) mini.addAll(docs);
  checkDeadline?.();
  const terms = new Map(docs.map((d) => [d.id, new Set(engine.tokenize(d.title + '\n' + d.body))]));
  if (file) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      writeFileAtomicSync(file, JSON.stringify({ signature, index: mini.toJSON(),
        terms: [...terms].map(([id, tokens]) => [id, [...tokens]]) }), { mode: 0o600 });
    } catch { /* read-only/full cache does not disable source-backed recall */ }
  }
  checkDeadline?.();
  return { mini, terms };
}
function selectTopics(corpus, graph, query, cacheDir, checkDeadline) {
  const current = corpus.entries.filter((e) => REQUIRED.has(e.file) && !e.archived && !graph.excluded.has(e.tag) &&
    graph.byTag.get(e.tag)?.length === 1 && !graph.next.has(e.tag) && [null, 'observed', 'derived', 'user-ratified'].includes(e.trust));
  const text = query.replace(/<!--[\s\S]*?-->/g, ' ');
  const topics = engine.topicalQueryTerms(text);
  if (topics === null) throw new Error('index-unavailable');
  const byTag = new Map(current.map((e) => [e.tag, e])), ranked = [];
  for (const tag of citations(query, graph, false).slice(0, 4)) {
    if (graph.excluded.has(tag) || ![null, 'observed', 'derived', 'user-ratified'].includes(graph.byTag.get(tag)?.[0].trust)) continue;
    const e = byTag.get(graph.headOf(tag));
    if (e && !ranked.includes(e)) ranked.push(e);
  }
  // Neutral prompts need neither an index load nor a corpus-wide tokenize.
  if (!topics.length) return ranked.slice(0, 3).map((entry) => ({ entry, support: 0 }));
  const { mini, terms } = prepare(corpus, current, cacheDir, checkDeadline);
  checkDeadline?.();
  const candidates = mini.search(text).map((hit) => {
    const entry = byTag.get(hit.id), tokens = terms.get(hit.id);
    return entry && tokens ? { entry, support: topics.filter((t) => tokens.has(t)) } : null;
  }).filter((c) => c && c.support.length);
  const strongest = candidates.filter((c) => !candidates.some((other) => other !== c && other.support.length > c.support.length &&
    c.support.every((t) => other.support.includes(t))));
  for (const c of strongest) if (!ranked.includes(c.entry) && ranked.length < 3) ranked.push(c.entry);
  checkDeadline?.();
  return ranked.slice(0, 3).map((entry) => ({ entry, support: topics.filter((t) => terms.get(entry.tag)?.has(t)).length }));
}
module.exports = { selectTopics };
