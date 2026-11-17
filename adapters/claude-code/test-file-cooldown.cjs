'use strict';
// Synthetic memory/repository/state only; no user configuration or real memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runHandler } = require('./hook.cjs');
const { identity, openStore } = require('../../core/recall-receipt.cjs');
const { sha } = require('../../core/memory-source.cjs');

async function fileCooldownSelfTest() {
  const t = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-file-cooldown-')));
  const mem = path.join(t, 'memory'), repo = path.join(t, 'repo'), stateRoot = path.join(t, 'state');
  fs.mkdirSync(mem); fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, 'src'));
  const config = path.join(t, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ memory_dir: mem, state_dir: stateRoot }));
  const block = (tag, title, body) => `**2026-01-01 — ${title}** [${tag}] [trust:user-ratified]\n${body}\n`;
  const pathEntry = (body) => block('demo:path', 'File reminder', `${body}\n<!-- trigger: tool=Edit|Write|MultiEdit; repo=demo; path=src/* -->`);
  const cmdEntry = block('demo:cmd', 'Command reminder', 'Check command results.\n<!-- trigger: tool=Bash; repo=demo; cmd=pytest -->');
  const lessons = (body = 'Preserve reviewed changes.') => pathEntry(body) + cmdEntry;
  const lessonFile = path.join(mem, 'lessons.md');
  fs.writeFileSync(path.join(mem, 'decisions.md'), '## Entries\n');
  fs.writeFileSync(lessonFile, lessons());
  fs.writeFileSync(path.join(mem, 'standinginstructions.md'), '## Entries\n');
  const runtime = { enabled: true, memoryRoot: mem, stateRoot,
    options: { max_items: 3, max_bytes: 4096, min_topic_terms: 2, kernel_sender: 'external', kernel_max_bytes: 4096 } };
  const ctx = { AXMEM_CONFIG: config, STATE_DIR: stateRoot, resolveRepo(target) {
    const rel = path.relative(repo, target);
    return !rel.startsWith('..') && !path.isAbsolute(rel) ? { repoId: 'demo', rel: rel.split(path.sep).join('/') } : null;
  } };
  let serial = 0;
  const input = (event, session, extra = {}) => ({ hook_event_name: event, session_id: session, agent_id: 'a', cwd: repo, ...extra });
  const pre = (session, tool = 'Edit', toolInput = { file_path: 'src/a.txt' }, extra = {}) => input('PreToolUse', session,
    { tool_name: tool, tool_input: toolInput, tool_use_id: 'action-' + ++serial, ...extra });
  const statePath = (x) => path.join(stateRoot, 'recall', identity(x, '').key, 'state.json');
  const stateFor = (x) => JSON.parse(fs.readFileSync(statePath(x), 'utf8'));
  const legacyState = () => ({ epoch: 0, taskId: null, candidates: [], seen: [], lastSuccessfulRecallAt: null, consecutiveFailures: 0, counts: {} });
  function writeState(x, state) { fs.mkdirSync(path.dirname(statePath(x)), { recursive: true }); fs.writeFileSync(statePath(x), JSON.stringify(state)); }
  async function rawRun(x, deps = {}) {
    let stdout = '', stderr = '';
    const r = await runHandler(x, { ctx, runtime, deadlineMs: 60000, write: async (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, ...deps });
    return { ...r, stdout, stderr };
  }
  async function run(x, deps = {}) {
    const r = await rawRun(x, deps);
    assert.deepEqual(r.errors, []); assert.equal(r.stderr, '');
    return r;
  }
  function delivered(r, tag = 'demo:path') {
    assert.equal(r.receipt.displayed, 1); assert.equal(r.receipt.items[0].tag, tag);
    assert.equal(r.receipt.items[0].visibility, 'whole'); assert(r.stdout.includes(tag));
  }
  function suppressed(r, reason = 'same-file-entry-emitted') {
    assert.equal(r.receipt.displayed, 0); assert.equal(r.stdout, ''); assert.equal(r.receipt.suppression_reason, reason);
  }
  const failures = []; let passed = 0;
  async function check(name, fn) {
    try { await fn(); passed++; console.log('  ok   FILE ' + name); }
    catch (e) { failures.push(name); console.log('  FAIL FILE ' + name + ': ' + e.message.replace(/\s+/g, ' ').trim()); }
  }
  try {
    await check('1 same file across prompt and new action', async () => {
      const first = pre('one', 'Edit', { file_path: 'src/a.txt', new_string: 'first' });
      delivered(await run(first));
      await run(input('UserPromptSubmit', 'one', { prompt: 'continue' }));
      suppressed(await run(pre('one', 'Edit', { file_path: 'src/a.txt', new_string: 'second' })));
    });
    await check('2 different matching file', async () => {
      delivered(await run(pre('two')));
      delivered(await run(pre('two', 'Write', { file_path: 'src/b.txt', content: 'new' })));
    });
    await check('3 different session', async () => {
      delivered(await run(pre('three-a'))); delivered(await run(pre('three-b')));
    });
    await check('4 changed entry text', async () => {
      try {
        delivered(await run(pre('four')));
        fs.writeFileSync(lessonFile, lessons('Preserve reviewed changes and test them.'));
        delivered(await run(pre('four', 'MultiEdit')));
      } finally { fs.writeFileSync(lessonFile, lessons()); }
    });
    await check('5 normalized path spellings', async () => {
      const absolute = path.join(repo, 'src', 'alias.txt');
      delivered(await run(pre('five', 'Edit', { file_path: absolute.split(path.sep).join('/') })));
      const relative = process.platform === 'win32' ? 'src\\alias.txt' : 'src/./alias.txt';
      suppressed(await run(pre('five', 'Write', { file_path: relative })));
      if (process.platform === 'win32') {
        suppressed(await run(pre('five', 'MultiEdit', { file_path: 'src\\ALIAS.TXT' })));
      }
    });
    await check('6 SessionStart resets epoch', async () => {
      delivered(await run(pre('six')));
      const start = await run(input('SessionStart', 'six', { source: 'compact' }));
      assert.equal(start.receipt.context_epoch, 1);
      delivered(await run(pre('six')));
    });
    await check('7 legacy state loads and gains cooldown', async () => {
      const first = pre('seven'); writeState(first, legacyState());
      delivered(await run(first));
      suppressed(await run(pre('seven')));
      assert.equal(stateFor(first).fileSeen.length, 1);
    });
    await check('8 Bash different actions stay independent', async () => {
      delivered(await run(pre('eight', 'Bash', { command: 'pytest' })), 'demo:cmd');
      delivered(await run(pre('eight', 'Bash', { command: 'pytest' })), 'demo:cmd');
    });
    await check('invalid fileSeen follows invalid seen handling', async () => {
      const a = pre('invalid-seen'), b = pre('invalid-fileSeen');
      writeState(a, { ...legacyState(), seen: 'invalid' });
      writeState(b, { ...legacyState(), fileSeen: 'invalid' });
      const first = await rawRun(a), second = await rawRun(b);
      assert.deepEqual(first.errors, ['state-unavailable']);
      assert.deepEqual(second.errors, first.errors); assert.equal(second.receipt, first.receipt);
      assert.match(second.stderr, /state-unavailable/);
      const c = pre('invalid-elements'); writeState(c, { ...legacyState(), fileSeen: ['valid', 3] });
      assert.deepEqual((await rawRun(c)).errors, first.errors);
    });
    await check('exact key and action suppression precedence', async () => {
      const x = pre('key'); const r = await run(x); delivered(r);
      const abs = path.resolve(repo, 'src/a.txt');
      const normalized = process.platform === 'win32' ? abs.toLowerCase() : abs;
      const key = sha(JSON.stringify(['file-cooldown-v1', r.receipt.context_epoch, normalized, r.receipt.items[0].tag, r.receipt.items[0].fullEntrySha256]));
      assert.deepEqual(stateFor(x).fileSeen, [key]);
      suppressed(await run(x), 'same-action-version-emitted');
    });
    await check('failed and omitted deliveries do not mark cooldown', async () => {
      const x = pre('failure');
      const failed = await rawRun(x, { write: async () => { throw new Error('synthetic broken stdout'); } });
      assert(failed.errors.includes('emission-failed')); assert.deepEqual(stateFor(x).fileSeen, []);
      delivered(await run(pre('failure')));
      const y = pre('omitted');
      const omitted = await rawRun(y, { runtime: { ...runtime, options: { ...runtime.options, max_bytes: 100 } } });
      assert(omitted.errors.includes('all-selected-omitted')); assert.equal(omitted.receipt.items[0].visibility, 'omitted');
      assert.deepEqual(stateFor(y).fileSeen, []); delivered(await run(pre('omitted')));
    });
    await check('mixed whole and omitted: only the shown entry is cooled', async () => {
      const trigger = '<!-- trigger: tool=Edit|Write|MultiEdit; repo=demo; path=src/* -->';
      const smallTag = 'demo:small', bigTag = 'demo:big';
      const budgetRuntime = { ...runtime, options: { ...runtime.options, max_bytes: 1400 } };
      try {
        fs.writeFileSync(lessonFile, block(smallTag, 'Small reminder', `Keep this short.\n${trigger}`) +
          block(bigTag, 'Big reminder', `${'Large body. '.repeat(400)}\n${trigger}`));
        const first = pre('mixed');
        const shown = await run(first, { runtime: budgetRuntime });
        assert.equal(shown.receipt.items.length, 2);
        assert.equal(shown.receipt.items.find((p) => p.tag === smallTag)?.visibility, 'whole');
        assert.equal(shown.receipt.items.find((p) => p.tag === bigTag)?.visibility, 'omitted');
        assert.equal(stateFor(first).fileSeen.length, 1);
        const next = pre('mixed', 'Edit', first.tool_input);
        assert.notEqual(next.tool_use_id, first.tool_use_id);
        const again = await rawRun(next, { runtime: budgetRuntime });
        assert(!again.receipt.items.some((p) => p.tag === smallTag));
        assert(!again.stdout.includes(smallTag));
        assert.equal(again.receipt.items.length, 1);
        assert.equal(again.receipt.items[0].tag, bigTag);
        assert.equal(again.receipt.items[0].visibility, 'omitted');
        assert.deepEqual(again.errors, ['all-selected-omitted']);
      } finally { fs.writeFileSync(lessonFile, lessons()); }
    });
    await check('500-key cap and busy legacy snapshot', async () => {
      const x = pre('cap'); writeState(x, { ...legacyState(), fileSeen: Array.from({ length: 500 }, (_, i) => String(i)) });
      delivered(await run(x));
      const list = stateFor(x).fileSeen; assert.equal(list.length, 500); assert.equal(list[0], '1');
      const y = pre('busy-legacy'); writeState(y, legacyState());
      const owner = openStore(stateRoot, identity(y, '').key, 'holder');
      try { delivered(await run(y)); } finally { owner.close(); }
    });
    console.log(`file cooldown self-test ${passed}/${passed + failures.length}`);
    assert.deepEqual(failures, [], 'file cooldown regressions');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}
module.exports = { fileCooldownSelfTest };
if (require.main === module) fileCooldownSelfTest().catch((e) => { console.error(e); process.exitCode = 1; });
