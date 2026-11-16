'use strict';
// Option 1 regressions: synthetic memory/repo/state only; no user configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { runHandler } = require('./hook.cjs');
const { identity } = require('../../core/recall-receipt.cjs');
const { loadCorpus } = require('../../core/memory-source.cjs');
const { selectForEvent } = require('../../core/recall-selector.cjs');

async function opt1SelfTest() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-opt1-pre-'));
  const mem = path.join(t, 'memory'), repo = path.join(t, 'repo'), stateRoot = path.join(t, 'state');
  fs.mkdirSync(mem); fs.mkdirSync(repo);
  const config = path.join(t, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ memory_dir: mem, state_dir: stateRoot }));
  const block = (tag, title, body) => `**2026-01-01 — ${title}** [${tag}] [trust:user-ratified]\n${body}\n`;
  fs.writeFileSync(path.join(mem, 'decisions.md'), block('demo:billing', '账单金额复核 Invoice billing reconciliation',
    '账单金额必须双重核对。Invoice billing reconciliation requires checking totals.\n<!-- trigger: none; 理由=仅任务主题规则 -->'));
  fs.writeFileSync(path.join(mem, 'lessons.md'),
    block('demo:path', 'Exact file reminder', 'Preserve reviewed changes.\n<!-- trigger: tool=Edit|Write|MultiEdit; repo=demo; path=guarded.txt -->') +
    block('demo:cmd', 'Exact command reminder', 'Inspect results before continuing.\n<!-- trigger: tool=Bash; repo=demo; cmd=pytest -->'));
  fs.writeFileSync(path.join(mem, 'standinginstructions.md'), '## Entries\n');
  const runtime = { enabled: true, memoryRoot: mem, stateRoot,
    options: { max_items: 3, max_bytes: 4096, min_topic_terms: 2, kernel_sender: 'external', kernel_max_bytes: 4096 } };
  const ctx = { AXMEM_CONFIG: config, STATE_DIR: stateRoot, resolveRepo(target) {
    const rel = path.relative(repo, target);
    return !rel.startsWith('..') && !path.isAbsolute(rel) ? { repoId: 'demo', rel: rel.split(path.sep).join('/') } : null;
  } };
  let serial = 0;
  const input = (event, session, extra = {}) => ({ hook_event_name: event, session_id: session, agent_id: 'a', cwd: repo, ...extra });
  const pre = (session, tool, toolInput) => input('PreToolUse', session,
    { tool_name: tool, tool_input: toolInput, tool_use_id: 'action-' + ++serial });
  const dirFor = (x) => path.join(stateRoot, 'recall', identity(x, '').key);
  const stateFor = (x) => JSON.parse(fs.readFileSync(path.join(dirFor(x), 'state.json'), 'utf8'));
  async function run(x, deps = {}) {
    let stdout = '', stderr = '';
    const r = await runHandler(x, { ctx, runtime, write: async (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, ...deps });
    assert.deepEqual(r.errors, []); assert.equal(stderr, '');
    if (stdout) assert(!Object.hasOwn(JSON.parse(stdout).hookSpecificOutput, 'permissionDecision'));
    return { ...r, stdout };
  }
  function assertPreAudit(x, r) {
    assert.equal(r.receipt.lexical_skipped, true);
    const rows = fs.readFileSync(path.join(dirFor(x), r.receipt.invocation_id + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert(rows.length >= 4);
    assert(rows.every((row) => row.event === 'PreToolUse' && row.lexical_skipped === true));
    assert.equal(r.receipt.decision, 'allow'); assert(r.receipt.displayed <= 3);
  }
  const failures = []; let passed = 0;
  async function check(name, fn) {
    try { await fn(); passed++; console.log('  ok   OPT1 ' + name); }
    catch (e) { failures.push(name); console.log('  FAIL OPT1 ' + name + ': ' + e.message); }
  }
  try {
    await check('lexical-only-path-not-delivered', async () => {
      const query = '账单金额复核.txt';
      const control = selectForEvent(loadCorpus(mem), { query });
      assert(control.selected.some((s) => s.entry.tag === 'demo:billing' && s.reason === 'lexical-topic-support'));
      const results = [];
      for (const tool of ['Edit', 'Write', 'MultiEdit']) {
        const x = pre('lexical-path-' + tool, tool, { file_path: path.join(repo, query) });
        results.push({ x, r: await run(x) });
      }
      console.log('OPT1 lexical-path observed ' + JSON.stringify(results.map(({ x, r }) => ({ tool: x.tool_name,
        displayed: r.receipt.displayed, reasons: r.receipt.items.map((p) => p.reason), lexical_skipped: r.receipt.lexical_skipped ?? null }))));
      for (const { x, r } of results) {
        assert.equal(r.receipt.displayed, 0); assert.deepEqual(r.receipt.items, []); assert.equal(r.stdout, '');
        assert.equal(r.outputAttempted, false); assert.equal(r.receipt.matched, 0);
        assert.deepEqual(stateFor(x).candidates, []); assertPreAudit(x, r);
      }
      assert(!fs.existsSync(path.join(stateRoot, 'recall-topic')), 'Pre must not create an index cache');
    });
    await check('lexical-only-command-not-delivered', async () => {
      const command = 'echo invoice billing reconciliation';
      assert(selectForEvent(loadCorpus(mem), { query: command }).selected.some((s) => s.reason === 'lexical-topic-support'));
      const x = pre('lexical-command', 'Bash', { command }), r = await run(x);
      console.log('OPT1 lexical-command observed ' + JSON.stringify({ displayed: r.receipt.displayed,
        reasons: r.receipt.items.map((p) => p.reason), lexical_skipped: r.receipt.lexical_skipped ?? null }));
      assert.equal(r.receipt.displayed, 0); assert.deepEqual(r.receipt.items, []); assert.equal(r.stdout, '');
      assert.equal(r.outputAttempted, false); assert.deepEqual(stateFor(x).candidates, []); assertPreAudit(x, r);
    });
    await check('explicit-path-triggers-still-delivered', async () => {
      for (const tool of ['Edit', 'Write', 'MultiEdit']) {
        const x = pre('explicit-path-' + tool, tool, { file_path: path.join(repo, 'guarded.txt') }), r = await run(x);
        assert.equal(r.receipt.displayed, 1);
        assert.deepEqual(r.receipt.items.map((p) => [p.tag, p.reason, p.visibility]), [['demo:path', 'action-trigger', 'whole']]);
        assert(r.stdout.includes('demo:path'));
      }
    });
    await check('explicit-command-trigger-still-delivered', async () => {
      const r = await run(pre('explicit-command', 'Bash', { command: 'pytest' }));
      assert.equal(r.receipt.displayed, 1);
      assert.deepEqual(r.receipt.items.map((p) => [p.tag, p.reason]), [['demo:cmd', 'command-trigger']]);
    });
    await check('prompt-candidate-survives-following-pre', async () => {
      for (const tool of ['Edit', 'Write', 'MultiEdit', 'Bash']) {
        const session = 'candidate-' + tool;
        const prompt = input('UserPromptSubmit', session, { prompt: 'invoice billing reconciliation' });
        const picked = await run(prompt);
        assert.equal(picked.receipt.displayed, 1);
        assert.equal(picked.receipt.items[0].reason, 'lexical-topic-support');
        assert(!Object.hasOwn(picked.receipt, 'lexical_skipped'));
        assert.deepEqual(stateFor(prompt).candidates.map((p) => p.tag), ['demo:billing']);
        const x = pre(session, tool, tool === 'Bash' ? { command: 'pwd' } : { file_path: path.join(repo, 'unrelated.txt') });
        const r = await run(x);
        assert.equal(r.receipt.task_id, picked.receipt.task_id); assert.equal(r.receipt.displayed, 1);
        assert.deepEqual(r.receipt.items.map((p) => [p.tag, p.reason, p.visibility]), [['demo:billing', 'task-candidate', 'whole']]);
      }
    });
    await check('explicit-tag-citation-still-delivered', async () => {
      const r = await run(pre('citation', 'Bash', { command: 'echo demo:billing' }));
      assert.equal(r.receipt.displayed, 1);
      assert.deepEqual(r.receipt.items.map((p) => [p.tag, p.reason]), [['demo:billing', 'explicit-tag']]);
    });
    await check('pre-never-loads-or-calls-topic-index', async () => {
      const topicPath = require.resolve('../../core/recall-topic-index.cjs');
      const cached = require.cache[topicPath], originalLoad = Module._load;
      let loads = 0, calls = 0, promptLoads = 0, promptCalls = 0;
      delete require.cache[topicPath];
      Module._load = function(request, parent, isMain) {
        if (Module._resolveFilename(request, parent, isMain) === topicPath) {
          loads++;
          return { selectTopics(...args) { calls++; return originalLoad.call(Module, topicPath, parent, false).selectTopics(...args); } };
        }
        return originalLoad.apply(this, arguments);
      };
      try {
        // Positive control: the same spy observes the unchanged prompt path.
        const prompt = await run(input('UserPromptSubmit', 'spy-prompt', { prompt: 'invoice billing reconciliation' }));
        assert.equal(prompt.receipt.displayed, 1); assert.equal(loads, 1); assert.equal(calls, 1);
        promptLoads = loads; promptCalls = calls; loads = 0; calls = 0;
        delete require.cache[topicPath];
        for (const tool of ['Edit', 'Write', 'MultiEdit', 'Bash']) {
          const x = pre('spy-' + tool, tool, tool === 'Bash' ? { command: 'echo invoice billing reconciliation' } :
            { file_path: path.join(repo, '账单金额复核.txt') });
          await run(x);
        }
        console.log('OPT1 topic-index spy observed ' + JSON.stringify({ promptLoads, promptCalls, preLoads: loads, preCalls: calls }));
        assert.equal(loads, 0, 'Pre must not require recall-topic-index');
        assert.equal(calls, 0, 'Pre must not call selectTopics');
        assert.equal(require.cache[topicPath], undefined, 'Pre must leave the topic module unloaded');
      } finally {
        Module._load = originalLoad;
        if (cached) require.cache[topicPath] = cached; else delete require.cache[topicPath];
      }
    });
    await check('query-ran-and-receipt-event-scope-are-honest', async () => {
      const corpus = loadCorpus(mem), query = 'invoice billing reconciliation';
      const disabled = selectForEvent(corpus, { query, lexical: false });
      assert.equal(disabled.queryRan, false); assert.deepEqual(disabled.selected, []);
      const enabled = selectForEvent(corpus, { query });
      assert.equal(enabled.queryRan, true); assert.equal(enabled.selected[0].reason, 'lexical-topic-support');
      const session = 'query-accounting';
      const prompt = input('UserPromptSubmit', session, { prompt: query });
      const options = [], choices = [];
      const deps = { selectForEvent(c, o) { options.push(o); const choice = selectForEvent(c, o); choices.push(choice); return choice; } };
      const picked = await run(prompt, deps);
      const before = stateFor(prompt);
      const x = pre(session, 'Bash', { command: 'pwd' }), r = await run(x, deps);
      assert.equal(options[0].lexical, true); assert.equal(options[1].lexical, false);
      assert.equal(choices[0].queryRan, true); assert.equal(choices[1].queryRan, false);
      assert.equal(stateFor(x).counts.query_ran, before.counts.query_ran);
      assert.equal(stateFor(x).lastSuccessfulRecallAt, before.lastSuccessfulRecallAt);
      assert.equal(r.receipt.items[0].reason, 'task-candidate'); assertPreAudit(x, r);
      assert(!Object.hasOwn(picked.receipt, 'lexical_skipped'));
      const start = await run(input('SessionStart', 'audit-start'));
      assert(!Object.hasOwn(start.receipt, 'lexical_skipped'));
      const unknown = pre('audit-unknown', 'Bash', { command: 'pytest | tail -5' });
      assertPreAudit(unknown, await run(unknown));
      const off = pre('audit-disabled', 'Bash', { command: 'pytest' });
      assertPreAudit(off, await run(off, { runtime: { enabled: false } }));
    });
    console.log(`OPT1 Pre no-lexical self-test ${passed}/${passed + failures.length}`);
    assert.deepEqual(failures, [], 'OPT1 regressions');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}
module.exports = { opt1SelfTest };
if (require.main === module) opt1SelfTest().catch((e) => { console.error(e); process.exitCode = 1; });
