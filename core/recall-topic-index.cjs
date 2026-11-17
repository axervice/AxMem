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
const GENERIC = new Set('这个 那个 已经 就是 什么 一下 可以 确实 的是 中文 英文 今天 现在 一个 怎么 为什么 没有 还是 问题 结果 时候 东西 直接 不管 变成 不是 需要 知道 不知 看看 看到 得到 同意 会不 不会 有空 一些 这样 那样 我们 你们 他们 自己 进行 使用 处理 這個 那個 已經 什麼 確實 現在 一個 怎麼 為什麼 沒有 還是 問題 結果 時候 東西 變成 一些 這樣 那樣 我們 你們 他們 自己 進行 使用 處理 會不 不會'.split(' '));
function selectTopics(corpus, graph, query, cacheDir, checkDeadline, { maxDf = 15, minWords = 2 } = {}) {
  // loadCorpus intentionally does not copy triggerNone to entries. Consult the
  // already-parsed source block, bound by file and starting line instead.
  const noneByLocation = new Map();
  for (const [file, source] of corpus.sources.files) for (const block of source.parsed?.entries || []) {
    if (block.triggerNone) noneByLocation.set(file + ':' + block.lineRange[0], block.triggerNone);
  }
  const current = corpus.entries.filter((e) => {
    const none = e.triggerNone || noneByLocation.get(e.file + ':' + e.line);
    return REQUIRED.has(e.file) && !e.archived && !graph.excluded.has(e.tag) &&
      graph.byTag.get(e.tag)?.length === 1 && !graph.next.has(e.tag) && [null, 'observed', 'derived', 'user-ratified'].includes(e.trust) &&
      !(none && /^(一次性|历史)/.test(none.reason || ''));
  });
  const text = query.replace(/<!--[\s\S]*?-->/g, ' ');
  const topics = engine.topicalQueryTerms(text);
  if (topics === null) throw new Error('index-unavailable');
  const normalized = text.normalize('NFC').toLowerCase();
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(normalized)]
    .filter((part) => part.isWordLike && part.segment.length >= 2).map((part) => part.segment);
  const paths = normalized.match(/(?:[A-Za-z]:[\\/]|\.{0,2}\/)[^\s，。、；：！？"'<>]+/g) || [];
  const sourceByTerm = new Map();
  for (const term of topics) {
    let word;
    if (/^\p{Script=Han}+$/u.test(term)) word = words.find((w) => w.includes(term));
    else if (/^[\x00-\x7f]+$/.test(term) && term.length >= 3 && !/[:/\\]/.test(term) && !paths.some((p) => p.includes(term))) word = term;
    if (word && !GENERIC.has(term) && !GENERIC.has(word)) sourceByTerm.set(term, word);
  }
  const byTag = new Map(current.map((e) => [e.tag, e])), ranked = [];
  for (const tag of citations(query, graph, false).slice(0, 4)) {
    if (graph.excluded.has(tag) || ![null, 'observed', 'derived', 'user-ratified'].includes(graph.byTag.get(tag)?.[0].trust)) continue;
    const e = byTag.get(graph.headOf(tag));
    if (e && !ranked.includes(e)) ranked.push(e);
  }
  // Neutral prompts need neither an index load nor a corpus-wide tokenize.
  if (!sourceByTerm.size) return ranked.slice(0, 3).map((entry) => ({ entry, support: 0 }));
  const { mini, terms } = prepare(corpus, current, cacheDir, checkDeadline);
  checkDeadline?.();
  for (const term of sourceByTerm.keys()) {
    let df = 0;
    for (const e of current) if (terms.get(e.tag)?.has(term)) df++;
    if (df > maxDf) sourceByTerm.delete(term);
    checkDeadline?.();
  }
  const supportOf = (tokens) => [...new Set([...sourceByTerm].filter(([term]) => tokens?.has(term)).map(([, word]) => word))];
  const candidates = mini.search(text).map((hit) => {
    const entry = byTag.get(hit.id), tokens = terms.get(hit.id);
    return entry && tokens ? { entry, support: supportOf(tokens) } : null;
  }).filter((c) => c && c.support.length >= minWords);
  const strongest = candidates.filter((c) => !candidates.some((other) => other !== c && other.support.length > c.support.length &&
    c.support.every((t) => other.support.includes(t))));
  for (const c of strongest) if (!ranked.includes(c.entry) && ranked.length < 3) ranked.push(c.entry);
  checkDeadline?.();
  return ranked.slice(0, 3).map((entry) => ({ entry, support: supportOf(terms.get(entry.tag)).length }));
}
module.exports = { selectTopics, GENERIC };
