'use strict';
// Only temporary, synthetic memory, configuration, and state are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCorpus } = require('../../core/memory-source.cjs');
const { selectForEvent } = require('../../core/recall-selector.cjs');
const { runHandler, machineOnly } = require('./hook.cjs');

async function promptQuietSelfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-prompt-quiet-'));
  const mem = path.join(root, 'memory'), state = path.join(root, 'state'), config = path.join(root, 'config.json');
  fs.mkdirSync(mem);
  const env = { ...process.env };
  Object.assign(process.env, { HOME: root, USERPROFILE: root, PMM_HOME: root, AXMEM_HOME: root,
    AXMEM_MEMORY_DIR: mem, AXMEM_STATE_DIR: state, AXMEM_CONFIG: config,
    PMM_MEMORY_DIR: mem, PMM_STATE_DIR: state, AXMEM_TRIGGER_LOG: path.join(root, 'trigger.tsv') });
  const block = (tag, text, comment = '') => `**2026-01-01 — ${text}** [${tag}] [trust:user-ratified]\n${text}\n${comment}\n`;
  function corpus(blocks) {
    fs.writeFileSync(path.join(mem, 'decisions.md'), blocks);
    fs.writeFileSync(path.join(mem, 'lessons.md'), '## Entries\n');
    fs.writeFileSync(path.join(mem, 'standinginstructions.md'), '## Entries\n');
    return loadCorpus(mem);
  }
  function configure(recall = {}) {
    fs.writeFileSync(config, JSON.stringify({ memory_dir: mem, state_dir: state, adapters: { claude_code: { recall } } }));
    delete require.cache[require.resolve('../../lib/prelude.cjs')];
    return require('../../lib/prelude.cjs');
  }
  async function prompt(text, recall = {}) {
    const ctx = configure(recall);
    let stdout = '';
    const result = await runHandler({ hook_event_name: 'UserPromptSubmit', prompt: text, session_id: 'quiet', agent_id: 'a' },
      { ctx, deadlineMs: 60000, write: async (s) => { stdout += s; }, stderr: () => {} });
    return { ...result, stdout };
  }
  const failures = []; let passed = 0;
  async function check(name, fn) {
    try { await fn(); passed++; console.log('  ok   QUIET ' + name); }
    catch (e) { failures.push(name); console.log('  FAIL QUIET ' + name + ': ' + e.message.replace(/\n/g, ' ')); }
  }
  try {
    await check('cross-word-bigrams', () => {
      const c = corpus(block('quiet:cross', '单金额'));
      assert.equal(selectForEvent(c, { query: '账单金额' }).selected.length, 0);
    });
    await check('one-word-two-bigrams', () => {
      const c = corpus(block('quiet:single', '不合格'));
      assert.equal(selectForEvent(c, { query: '不合格' }).selected.length, 0);
    });
    for (const [name, words] of [['simplified', '这个 什么 已经'], ['traditional', '這個 什麼 已經']]) {
      await check('generic-' + name, () => {
        const c = corpus(block('quiet:generic', words));
        assert.equal(selectForEvent(c, { query: words }).selected.length, 0);
        for (const word of words.split(' ')) {
          const one = corpus(block('quiet:generic', word + ' invoice'));
          assert.equal(selectForEvent(one, { query: word + ' invoice' }).selected.length, 0, word);
        }
      });
    }
    await check('path-fragments', () => {
      const c = corpus(block('quiet:path', 'users desktop jax'));
      for (const query of ['C:\\Users\\Jax\\Desktop\\alpha.txt', '/users/jax/desktop', './users/jax/desktop', 'users /users/jax/desktop']) {
        assert.equal(selectForEvent(c, { query }).selected.length, 0, query);
      }
      const short = corpus(block('quiet:shortascii', 'ui invoice'));
      assert.equal(selectForEvent(short, { query: 'ui invoice' }).selected.length, 0);
    });
    await check('document-frequency', async () => {
      const c = corpus(block('quiet:one', 'invoice billing') + block('quiet:two', 'invoice') + block('quiet:three', 'invoice'));
      assert.equal(selectForEvent(c, { query: 'invoice billing', topicMaxDf: 2 }).selected.length, 0);
      assert.equal(selectForEvent(c, { query: 'invoice billing', topicMaxDf: 3 }).selected[0].score, 2);
      const off = await prompt('invoice billing', { topic_max_df: 2 });
      assert.deepEqual(off.errors, []); assert.equal(off.receipt.displayed, 0);
      const on = await prompt('invoice billing', { topic_max_df: 3 });
      assert.deepEqual(on.errors, []); assert.equal(on.receipt.displayed, 1);
    });
    await check('distinct-words-positive-and-score', () => {
      const c = corpus(block('quiet:positive', '不合格 账单'));
      const r = selectForEvent(c, { query: '不合格 账单' });
      assert.equal(r.selected.length, 1); assert.equal(r.selected[0].entry.tag, 'quiet:positive');
      assert.equal(r.selected[0].score, 2);
      assert.equal(selectForEvent(c, { query: '不合格 账单', minTopicTerms: 3 }).selected.length, 0);
      const dominated = corpus(block('quiet:short', '不合格 账单') + block('quiet:long', '不合格 账单 invoice'));
      const ranked = selectForEvent(dominated, { query: '不合格 账单 invoice' });
      assert.deepEqual(ranked.selected.map((s) => [s.entry.tag, s.score]), [['quiet:long', 3]]);
    });
    await check('machine-only-wrappers', async () => {
      corpus(block('quiet:machine', 'invoice billing'));
      const r = await prompt('  <task-notification id="42">invoice billing</task-notification>\n<system-reminder>invoice billing</system-reminder> <cross-session-message>invoice billing</cross-session-message>  ');
      assert.deepEqual(r.errors, []); assert.equal(r.receipt.prompt_machine_only, true);
      assert.equal(r.receipt.prompt_lexical, 'on'); assert.equal(r.receipt.displayed, 0); assert.equal(r.stdout, '');
      for (const tag of ['task-notification', 'system-reminder', 'cross-session-message']) {
        assert.equal(machineOnly(`<${tag}>text\nmore</${tag}>`), true);
        assert.equal(machineOnly(`<${tag}>a</${tag}> human <${tag}>b</${tag}>`), false);
      }
      assert.equal(machineOnly('  '), false);
      assert.equal(machineOnly('<system-reminder>x</task-notification>'), false);
      const cited = await prompt('<system-reminder>[quiet:machine]</system-reminder>');
      assert.equal(cited.receipt.prompt_machine_only, true); assert.equal(cited.receipt.items[0].reason, 'explicit-tag');
    });
    await check('embedded-wrapper-human', async () => {
      corpus(block('quiet:human', 'invoice billing'));
      const r = await prompt('invoice billing <system-reminder>note</system-reminder>');
      assert.deepEqual(r.errors, []); assert.equal(r.receipt.prompt_machine_only, false);
      assert.equal(r.receipt.displayed, 1); assert.equal(r.receipt.items[0].reason, 'lexical-topic-support');
    });
    await check('trigger-none-once-and-history', async () => {
      const c = corpus(block('quiet:once', 'invoice billing', '<!-- trigger: none; 理由=一次性任务 -->') +
        block('quiet:history', 'invoice billing', '<!-- trigger: none; 理由=历史记录 -->'));
      assert.equal(selectForEvent(c, { query: 'invoice billing' }).selected.length, 0);
      for (const tag of ['quiet:once', 'quiet:history']) {
        const r = await prompt(`[${tag}]`);
        assert.deepEqual(r.errors, []); assert.equal(r.receipt.items[0].tag, tag); assert.equal(r.receipt.items[0].reason, 'explicit-tag');
      }
    });
    await check('prompt-lexical-off-and-citation', async () => {
      corpus(block('quiet:off', 'invoice billing'));
      const r = await prompt('invoice billing', { prompt_lexical: 'off' });
      assert.deepEqual(r.errors, []); assert.equal(r.receipt.prompt_lexical, 'off'); assert.equal(r.receipt.displayed, 0); assert.equal(r.stdout, '');
      const cited = await prompt('[quiet:off]', { prompt_lexical: 'off' });
      assert.deepEqual(cited.errors, []); assert.equal(cited.receipt.items[0].reason, 'explicit-tag');
    });
    await check('invalid-config-and-bounds', () => {
      for (const recall of [{ prompt_lexical: 'bad' }, { prompt_lexical: null }, { topic_max_df: 0 }, { topic_max_df: 1001 }, { topic_max_df: 1.5 }]) {
        assert.throws(() => configure(recall).resolveRuntimeConfig(), /invalid-recall-config/);
      }
      assert.equal(configure().resolveRuntimeConfig().options.topic_max_df, 15);
      assert.equal(configure({ topic_max_df: 1 }).resolveRuntimeConfig().options.topic_max_df, 1);
      assert.equal(configure({ topic_max_df: 1000 }).resolveRuntimeConfig().options.topic_max_df, 1000);
    });
    await check('prompt-heading', async () => {
      corpus(block('quiet:heading', 'invoice billing'));
      const r = await prompt('invoice billing');
      assert.deepEqual(r.errors, []); assert.match(r.context, /^\[AxMem 提问召回：仅提醒，不拦截\]/);
    });
    console.log(`prompt quiet self-test ${passed}/${passed + failures.length}`);
    assert.deepEqual(failures, [], 'prompt quiet regressions');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../../lib/prelude.cjs')];
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { promptQuietSelfTest };
if (require.main === module) promptQuietSelfTest().catch((e) => { console.error(e); process.exitCode = 1; });
