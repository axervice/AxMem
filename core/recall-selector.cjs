'use strict';
// Phase-1 CC policy: share mature graph/tokenization primitives, prepare source
// proof and lexical index once per snapshot instead of reparsing per method.
// The Codex manifest selector and its public/bridge API stay unchanged.
const engine = require('../adapters/codex/recall-selector.cjs')._shared;
const { REQUIRED, sha } = require('./memory-source.cjs');
const { proveCorpus, citations, actionHits } = require('./recall-source-proof.cjs');
function selectForEvent(corpus, { query = '', action = null, candidateIds = [], maxItems = 3, minTopicTerms = 2, lexical = true, checkDeadline, cacheDir } = {}) {
  const { entries } = corpus;
  checkDeadline?.();
  const graph = engine.graphOf(entries, { heads: {}, report: [] });
  // Quarantine a malformed entry AND its replacement component, not the corpus.
  const queue = [...corpus.badTags];
  while (queue.length) {
    const tag = queue.pop();
    if (graph.excluded.has(tag)) continue;
    graph.excluded.add(tag);
    for (const e of entries) {
      if (e.tag === tag) queue.push(...e.supersedes);
      if (e.supersedes.includes(tag)) queue.push(e.tag);
    }
  }
  checkDeadline?.();
  const proof = proveCorpus(corpus, graph, checkDeadline);
  const warnings = corpus.diagnostics.map((d) => `${d.code}:${d.file}:${d.line}`);
  if (graph.excluded.size) warnings.push('graph-excluded:' + graph.excluded.size);
  if (proof.disagreement) warnings.push('boundary-excluded:' + proof.disagreement);
  if (proof.malformed) warnings.push('trigger-excluded:' + proof.malformed);
  const unknownTrust = entries.filter((e) => ![null, 'observed', 'derived', 'user-ratified'].includes(e.trust)).length;
  if (unknownTrust) warnings.push('unknown-trust-excluded:' + unknownTrust);
  const usable = proof.current;
  const inScope = (e) => {
    const repos = e.triggers.map((t) => t.repo).filter((r) => r && r !== '*');
    return !action || !repos.length || !!action.repo && repos.includes(action.repo);
  };
  const chosen = new Map();
  function add(entry, reason, score = null, from = null, triggerId = null) {
    if (!entry || !inScope(entry) || chosen.has(entry.tag)) return;
    chosen.set(entry.tag, { entry, reason, score, resolvedFromTag: from, triggerId });
  }
  if (action?.context) {
    const normalized = engine.normalizeActionContext(action.context);
    if (!normalized) throw new Error('invalid-action-context');
    for (const { entry: e, from } of actionHits(proof, normalized, checkDeadline)) add(e, 'action-trigger', null, from,
      sha(JSON.stringify([from || e.tag, normalized])));
  }
  // Only a deliberately small, proven simple Bash command is eligible for cmd
  // triggers. Compound shells are unknown, never inferred to be file edits.
  if (action?.command) {
    for (const e of entries) {
      for (const t of e.triggers) {
        if (t.kind !== 'cmd' || t.repo !== '*' && t.repo !== action.repo ||
            t.exe !== action.command.exe || t.sub && t.sub !== action.command.sub) continue;
        const head = proof.verifiedHead(e.tag);
        add(proof.byTag.get(head), 'command-trigger', null, head !== e.tag ? e.tag : null,
          sha(JSON.stringify([e.tag, t])));
      }
    }
  }
  checkDeadline?.();
  const citedHeads = new Set();
  for (const tag of citations(query.slice(0, 8192), graph)) {
    const head = proof.verifiedHead(tag);
    if (!proof.byTag.has(head) || citedHeads.has(head)) continue;
    citedHeads.add(head);
    add(proof.byTag.get(head), 'explicit-tag', null, head !== tag ? tag : null);
    if (citedHeads.size === 3) break;
  }
  let queryRan = false;
  // PreToolUse keeps proven triggers/citations/candidates, without even loading
  // the topic index. Prompt callers retain lexical search by default.
  if (lexical && query.trim()) {
    checkDeadline?.();
    const selected = require('./recall-topic-index.cjs').selectTopics(corpus, graph, query.slice(0, 8192), cacheDir, checkDeadline);
    checkDeadline?.();
    queryRan = true;
    for (const { entry: e, support } of selected) {
      if (usable.includes(e) && support >= minTopicTerms) add(e, 'lexical-topic-support', support);
    }
  }
  for (const tag of candidateIds) add(proof.byTag.get(tag), 'task-candidate');
  const ranked = [...chosen.values()];
  return { selected: ranked.slice(0, Math.min(3, maxItems)), matched: ranked.length,
    queryRan, eligible: usable.filter((e) => REQUIRED.has(e.file)).length, warnings };
}
module.exports = { selectForEvent };
if (require.main === module && process.argv.includes('--self-test')) {
  require('../adapters/claude-code/test-hook.cjs').componentSelfTest('selector').catch((e) => { console.error(e); process.exitCode = 1; });
}
