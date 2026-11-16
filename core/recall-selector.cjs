'use strict';
// Phase-1 event policy, sharing the established lexical/graph algorithms rather
// than cloning them. The mature engine stays at its compatibility path for now;
// only source IO is physically extracted in this increment.
const engine = require('../adapters/codex/recall-selector.cjs')._shared;
const { REQUIRED, sha } = require('./memory-source.cjs');
function selectForEvent(corpus, { query = '', action = null, candidateIds = [], maxItems = 3, minTopicTerms = 2 } = {}) {
  const { entries, sources } = corpus;
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
  const proof = engine.verifiedSourceGraph(entries, graph, sources);
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
    const exact = engine.selectByAction(entries, graph, sources, normalized, 3);
    warnings.push(...exact.warnings);
    for (const e of exact.ranked) add(e, 'action-trigger', null, exact.fromTags.get(e.tag),
      sha(JSON.stringify([exact.fromTags.get(e.tag) || e.tag, normalized])));
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
  const cited = engine.selectByCitations(entries, graph, sources, query.slice(0, 8192), 3);
  for (const e of cited.ranked) add(e, 'explicit-tag', null, cited.fromTags.get(e.tag));
  let queryRan = false;
  if (query.trim()) {
    const selected = engine.select(entries, graph, query.slice(0, 8192), query.slice(0, 8192), 3);
    if (selected.topicUnavailable) throw new Error('index-unavailable');
    queryRan = true;
    const topics = engine.topicalQueryTerms(query.replace(/<!--[\s\S]*?-->/g, ' '));
    for (const e of selected.ranked) {
      if (!usable.includes(e)) continue;
      const tokens = new Set(engine.tokenize(e.title + '\n' + engine.searchableProse(e)));
      const support = (topics || []).filter((t) => tokens.has(t));
      if (support.length >= minTopicTerms) add(e, 'lexical-topic-support', support.length);
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
