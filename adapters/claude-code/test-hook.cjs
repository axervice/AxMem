'use strict';
// Small synthetic fixtures, discovered by the existing --self-test scan.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runHandler } = require('./hook.cjs');
const { identity } = require('../../core/recall-receipt.cjs');
const ROOT = path.resolve(__dirname, '../..');
async function selfTest() {
  await require('./test-review-round2.cjs').round2SelfTest();
  await require('./test-review.cjs').reviewSelfTest();
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-cc-hook-'));
  const savedEnv = { ...process.env };
  let passed = 0;
  const names = [];
  async function check(name, fn) { await fn(); passed++; names.push(name); }
  try {
    Object.assign(process.env, { HOME: t, USERPROFILE: t, PMM_HOME: t, AXMEM_HOME: t,
      AXMEM_MEMORY_DIR: path.join(t, 'memory'), AXMEM_STATE_DIR: path.join(t, 'state'),
      AXMEM_CONFIG: path.join(t, 'config.json'), AXMEM_TRIGGER_LOG: path.join(t, 'trigger.tsv'),
      PMM_MEMORY_DIR: path.join(t, 'memory'), PMM_STATE_DIR: path.join(t, 'state') });
    const mem = process.env.AXMEM_MEMORY_DIR, repo = path.join(t, 'repo');
    fs.mkdirSync(mem); fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, 'nested'));
    const config = { memory_dir: mem, state_dir: process.env.AXMEM_STATE_DIR,
      repos: [{ id: 'home', roots: ['~'] }, { id: 'demo', roots: ['~/repo'] }, { id: 'nested', roots: ['~/repo/nested'] }],
      adapters: { claude_code: { enabled: true, settings_json: path.join(t, 'settings.json') } } };
    fs.writeFileSync(process.env.AXMEM_CONFIG, JSON.stringify(config));
    fs.writeFileSync(path.join(t, 'settings.json'), '{}');
    delete require.cache[require.resolve('../../lib/prelude.cjs')];
    const ctx = require('../../lib/prelude.cjs');
    const runtime = ctx.resolveRuntimeConfig();
    const block = (tag, title, body) => `**2026-01-01 — ${title}** [${tag}] [trust:user-ratified]\n${body}\n`;
    const decisions = block('demo:hidden', '测试失败必须如实报告', '测试失败不能藏起来，不得隐藏失败退出码。\n<!-- trigger: none; 理由=任务语义规则 -->') +
      block('demo:old', '过往部署裁定', '历史部署规则。') +
      block('demo:live', '现行部署裁定', '最新部署方式。\nSupersedes: [[demo:old]]');
    const lessons = block('demo:script', '脚本写入纪律', '编辑脚本时保留测试失败退出码。\n<!-- trigger: tool=Edit|Write|MultiEdit; repo=demo; path=script.sh -->') +
      block('demo:pytest', '运行 pytest 的教训', 'pytest 失败必须完整报告。\n<!-- trigger: tool=Bash; repo=demo; cmd=pytest -->');
    const standing = '### Kernel\n不能用未经批准的推断覆盖用户裁定。\n\n## Entries\n';
    fs.writeFileSync(path.join(mem, 'decisions.md'), decisions);
    fs.writeFileSync(path.join(mem, 'lessons.md'), lessons);
    fs.writeFileSync(path.join(mem, 'standinginstructions.md'), standing);
    let serial = 0;
    const input = (event, extra = {}) => ({ hook_event_name: event, session_id: 'session-complete-not-truncated', agent_id: 'actor-a', cwd: repo, ...extra });
    const pre = (tool, ti = {}, extra = {}) => input('PreToolUse', { tool_name: tool,
      tool_use_id: 'tool-' + ++serial, tool_input: ti, ...extra });
    const statePath = (x) => path.join(runtime.stateRoot, 'recall', identity(x, '').key, 'state.json');
    async function run(x, overrides = {}) {
      let stdout = '', stderr = '';
      const r = await runHandler(x, { ctx, runtime, write: async (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, ...overrides });
      const output = stdout ? JSON.parse(stdout) : null;
      if (output) { assert(!('decision' in output)); assert(!('permissionDecision' in output.hookSpecificOutput)); }
      return { ...r, stdout, stderr, output };
    }
    function post(x, env = {}) {
      return spawnSync(process.execPath, [path.join(ROOT, 'core/trigger-recall.cjs')], {
        input: JSON.stringify({ ...x, hook_event_name: 'PostToolUse', tool_response: { ok: true } }),
        env: { ...process.env, ...env }, encoding: 'utf8', cwd: t,
      });
    }
    await check('SessionStart normal: source status and whole Kernel', async () => {
      const r = await run(input('SessionStart'));
      assert.deepEqual(r.errors, []); assert.match(r.context, /来源可用/); assert.match(r.context, /不能用未经批准/);
      assert.equal(r.receipt.items[0].visibility, 'whole'); assert.equal(r.receipt.hostConfirmed, 'unknown');
    });
    await check('SessionStart boundary: resume/compact new epoch can resend Kernel', async () => {
      const a = await run(input('SessionStart', { source: 'resume' }));
      const b = await run(input('SessionStart', { source: 'compact' }));
      assert(b.receipt.context_epoch > a.receipt.context_epoch); assert.match(b.context, /不能用未经批准/);
    });
    await check('SessionStart fault: missing source is degraded, counted, never no-match', async () => {
      const r = await run(input('SessionStart'), { runtime: { ...runtime, memoryRoot: path.join(t, 'absent') } });
      assert.match(r.context, /degraded/); assert.match(r.context, /不是“没有匹配”/);
      assert.equal(JSON.parse(fs.readFileSync(statePath(input('SessionStart')))).consecutiveFailures, 1);
    });
    await check('SessionStart boundary: missing/external Kernel is explicit, not invented', async () => {
      fs.writeFileSync(path.join(mem, 'standinginstructions.md'), '## Entries\n');
      assert.match((await run(input('SessionStart'))).context, /未找到可验证/);
      fs.writeFileSync(path.join(mem, 'standinginstructions.md'), standing);
      const r = await run(input('SessionStart'), { runtime: { ...runtime, options: { ...runtime.options, kernel_sender: 'external' } } });
      assert.match(r.context, /external/); assert.equal(r.receipt.displayed, 0);
    });
    await check('Prompt normal: natural Chinese finds a trigger-none rule, no raw prompt retained', async () => {
      const prompt = '别再把测试失败藏起来，帮我改这个脚本。unique-private-suffix-483';
      const r = await run(input('UserPromptSubmit', { prompt }));
      assert.deepEqual(r.errors, []); assert(r.receipt.items.some((p) => p.tag === 'demo:hidden' && p.visibility === 'whole'));
      const dir = path.dirname(statePath(input('UserPromptSubmit')));
      for (const f of fs.readdirSync(dir)) assert(!fs.readFileSync(path.join(dir, f), 'utf8').includes(prompt));
      const state = JSON.parse(fs.readFileSync(statePath(input('UserPromptSubmit'))));
      assert(state.lastSuccessfulRecallAt); assert.equal(state.consecutiveFailures, 0);
    });
    await check('Prompt boundary: continue alone and generic test do not push rules', async () => {
      for (const prompt of ['继续', 'continue please', 'check test']) {
        const r = await run(input('UserPromptSubmit', { prompt })); assert.equal(r.receipt.displayed, 0);
      }
    });
    await check('Prompt boundary: archived/old citation resolves to verified live head', async () => {
      const r = await run(input('UserPromptSubmit', { prompt: '按 [demo:old] 执行' }));
      assert.equal(r.receipt.items[0].tag, 'demo:live'); assert.equal(r.receipt.items[0].resolvedFromTag, 'demo:old');
    });
    await check('Prompt fault: index failure is unavailable, never successful no-match', async () => {
      const r = await run(input('UserPromptSubmit', { prompt: '测试失败' }), { selectForEvent() { throw new Error('index-failed'); } });
      assert.match(r.context, /index-failed/); assert.match(r.stderr, /degraded/);
      assert.equal(JSON.parse(fs.readFileSync(statePath(input('UserPromptSubmit')))).consecutiveFailures, 1);
    });
    await check('Prompt source debt: isolate bad replacement component, keep independent rule', async () => {
      fs.writeFileSync(path.join(mem, 'decisions.md'), decisions + block('demo:fork', '分叉裁定', 'Supersedes: [[demo:old]]'));
      const r = await run(input('UserPromptSubmit', { prompt: '测试失败藏起来' }));
      assert(r.receipt.items.some((p) => p.tag === 'demo:hidden')); assert(!r.receipt.items.some((p) => p.tag === 'demo:live'));
      fs.writeFileSync(path.join(mem, 'decisions.md'), decisions);
    });
    await check('Repo resolution: tilde, longest nested root, boundaries, worktree', async () => {
      assert.equal(ctx.resolveRepo(path.join(repo, 'script.sh')).repoId, 'demo');
      assert.equal(ctx.resolveRepo(path.join(repo, 'nested', 'x')).repoId, 'nested');
      assert.notEqual(ctx.resolveRepo(repo + '-other/x').repoId, 'demo');
      assert.equal(ctx.resolveRepo(path.join(repo, '.claude/worktrees/w/script.sh')).rel, 'script.sh');
      assert.equal(ctx.resolveRepo('relative/path'), null);
    });
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      await check(`Pre ${tool} normal: exact action reminder before tool, prompt does not silence it`, async () => {
        await run(input('UserPromptSubmit', { prompt: '测试失败脚本' }));
        const r = await run(pre(tool, { file_path: path.join(repo, 'script.sh'), content: 'new', old_string: 'x', new_string: 'y' }));
        assert.deepEqual(r.errors, []); assert(r.receipt.items.some((p) => p.tag === 'demo:script' && p.reason === 'action-trigger'));
        assert(r.receipt.displayed <= 3);
      });
      await check(`Pre ${tool} nonmatch: unrelated target and cross-repo do not push`, async () => {
        await run(input('UserPromptSubmit', { prompt: '继续' }));
        const a = await run(pre(tool, { file_path: path.join(repo, 'unrelated.txt') }));
        const b = await run(pre(tool, { file_path: path.join(repo, 'nested', 'script.sh') }));
        assert.equal(a.receipt.displayed, 0); assert(!b.receipt.items.some((p) => p.tag === 'demo:script'));
      });
      await check(`Pre ${tool} fault: missing path is receipt unknown, never deny or inject`, async () => {
        const r = await run(pre(tool, {})); assert.equal(r.receipt.path_status, 'unknown'); assert.equal(r.receipt.displayed, 0);
        assert.equal(r.receipt.action_reason, 'invalid-file-path'); assert.equal(r.context, ''); assert.equal(r.stdout, '');
      });
    }
    await check('Pre Bash normal: proven simple command trigger', async () => {
      const r = await run(pre('Bash', { command: 'pytest' }));
      assert(r.receipt.items.some((p) => p.tag === 'demo:pytest' && p.reason === 'command-trigger'));
    });
    await check('Pre Bash boundary: unrelated/cross-repo command does not push', async () => {
      await run(input('UserPromptSubmit', { prompt: '继续' }));
      assert.equal((await run(pre('Bash', { command: 'pwd' }))).receipt.displayed, 0);
      assert.equal((await run(pre('Bash', { command: 'pytest' }, { cwd: path.join(repo, 'nested') }))).receipt.displayed, 0);
    });
    await check('Pre Bash fault: compound shell/missing input is receipt unknown, no injection', async () => {
      for (const command of ['npm test | tail -5', 'cd /tmp && pytest', 'env pytest', 'pytest\n']) {
        const r = await run(pre('Bash', { command })); assert.equal(r.receipt.path_status, 'unknown'); assert.equal(r.receipt.displayed, 0);
        assert.equal(r.context, ''); assert.equal(r.stdout, ''); assert.match(r.receipt.action_reason, /unsupported-shell-/);
      }
      const missing = await run(pre('Bash', {})); assert.equal(missing.receipt.path_status, 'unknown');
      assert.equal(missing.receipt.action_reason, 'invalid-command'); assert.equal(missing.stdout, '');
    });
    await check('Pre boundary: task candidates fallback for supported simple Bash', async () => {
      await run(input('UserPromptSubmit', { prompt: '不要把测试失败藏起来' }));
      const r = await run(pre('Bash', { command: 'npm test' }));
      assert(r.receipt.items.some((p) => p.tag === 'demo:hidden' && p.reason === 'task-candidate'));
    });
    await check('Pre boundary: replay same action suppresses, a new action can resend', async () => {
      const x = pre('Write', { file_path: path.join(repo, 'script.sh') });
      const first = await run(x), again = await run(x);
      assert(first.receipt.displayed > 0); assert.equal(again.receipt.displayed, 0); assert(again.receipt.suppression_reason);
      assert((await run(pre('Write', x.tool_input))).receipt.displayed > 0);
    });
    await check('Pre fault: stdout failure leaves prepared orphan, no emitted or suppression marker', async () => {
      const x = pre('Write', { file_path: path.join(repo, 'script.sh') });
      const r = await run(x, { write: async () => { throw new Error('broken stdout'); } });
      assert(r.errors.includes('emission-failed'));
      const dir = path.dirname(statePath(x));
      const ledger = fs.readFileSync(path.join(dir, r.receipt.invocation_id + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert(ledger.some((l) => l.stage === 'prepared')); assert(!ledger.some((l) => l.stage === 'emitted'));
      assert((await run(x)).receipt.displayed > 0);
    });
    await check('Budget boundary: whole body or omitted, no partial delivery', async () => {
      fs.appendFileSync(path.join(mem, 'decisions.md'), block('demo:huge', '巨长规则', '巨长正文'.repeat(3000)));
      const r = await run(input('UserPromptSubmit', { prompt: '[demo:huge]' }));
      assert(r.errors.includes('all-selected-omitted')); assert.equal(r.receipt.displayed, 0);
      assert.equal(r.receipt.items[0].visibility, 'omitted'); assert.equal(r.receipt.items[0].displayedTextSha256, null);
      assert(!r.context.includes('巨长正文巨长正文'));
      fs.writeFileSync(path.join(mem, 'decisions.md'), decisions);
    });
    await check('Post normal: no Pre keeps legacy recall; result of actual event is unverified', async () => {
      const x = pre('Edit', { file_path: path.join(repo, 'script.sh') }, { session_id: 'post-no-pre' });
      const p = post(x); assert.equal(p.status, 0); assert.match(p.stdout, /demo:script/);
      const dir = path.dirname(statePath(x));
      const rows = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map(JSON.parse));
      const emitted = rows.find((r) => r.stage === 'emitted');
      assert(emitted); assert.equal(emitted.displayed, 0); assert(emitted.pointer_only > 0);
      assert.equal(emitted.payload_hash, require('../../core/memory-source.cjs').sha(p.stdout));
    });
    await check('Post boundary: Pre-emitted same action is not repeated, result linked', async () => {
      const x = pre('Edit', { file_path: path.join(repo, 'script.sh') }, { session_id: 'post-with-pre' });
      const r = await run(x); assert(r.receipt.items.some((p) => p.tag === 'demo:script'));
      const p = post(x); assert.equal(p.status, 0); assert(!p.stdout.includes('demo:script'));
      const dir = path.dirname(statePath(x));
      const linked = fs.readdirSync(dir).filter((f) => f.startsWith('post-'));
      assert.equal(linked.length, 1); assert.match(fs.readFileSync(path.join(dir, linked[0]), 'utf8'), /observed-unverified/);
    });
    await check('Post fault: source missing and state write failure both visible, exit zero', async () => {
      const x = pre('Edit', { file_path: path.join(repo, 'script.sh') }, { session_id: 'post-fault' });
      const missing = post(x, { AXMEM_MEMORY_DIR: path.join(t, 'absent') });
      assert.equal(missing.status, 0); assert.match(missing.stdout, /degraded/);
      await run(x);
      const blocked = path.join(t, 'blocked-state'); fs.writeFileSync(blocked, 'file');
      // Preserve the marker lookup but make its outcome ledger unwritable.
      const dir = path.dirname(statePath(x));
      const marker = fs.readdirSync(dir).find((f) => f.startsWith('pre-'));
      fs.mkdirSync(path.join(dir, marker.replace('pre-', 'post-').replace('.json', '.jsonl')));
      const bad = post(x); assert.equal(bad.status, 0); assert.match(bad.stdout, /degraded/);
    });
    await check('State fault: cannot create ledger is visible without killing the hook', async () => {
      const old = ctx.STATE_DIR, blocked = path.join(t, 'state-file'); fs.writeFileSync(blocked, 'x'); ctx.STATE_DIR = blocked;
      try { const r = await run(input('SessionStart')); assert.match(r.context, /degraded/); assert(r.emitted); }
      finally { ctx.STATE_DIR = old; }
    });
    await check('Transport/accounting: exact output hash and received-prepared-emitted order', async () => {
      const r = await run(input('UserPromptSubmit', { prompt: '测试失败藏起来' }));
      const dir = path.dirname(statePath(input('UserPromptSubmit')));
      const rows = fs.readFileSync(path.join(dir, r.receipt.invocation_id + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(rows.slice(0, 5).map((x) => x.stage), ['received', 'source-ready', 'selected', 'prepared', 'emitted']);
      const e = rows.find((x) => x.stage === 'emitted');
      assert.equal(e.bytes, Buffer.byteLength(r.stdout));
      assert.equal(e.payload_hash, require('../../core/memory-source.cjs').sha(r.stdout));
      assert.equal(e.context_bytes, Buffer.byteLength(r.output.hookSpecificOutput.additionalContext));
      assert.equal(e.displayed, e.items.filter((p) => p.visibility === 'whole').length);
    });
    await check('CLI fault: malformed and oversized stdin remain protocol-visible exit zero', async () => {
      for (const text of ['{broken', 'x'.repeat(270000)]) {
        const p = spawnSync(process.execPath, [path.join(__dirname, 'hook.cjs')], { input: text, env: process.env, encoding: 'utf8', cwd: t });
        assert.equal(p.status, 0);
        // Unknown is not a host enum member: keep the visible top-level warning
        // without an invalid hookSpecificOutput that could discard the whole JSON.
        const out = JSON.parse(p.stdout);
        assert.deepEqual(out, { systemMessage: 'AxMem 召回暂不可用；工作继续。' });
        assert(!Object.hasOwn(out, 'hookSpecificOutput')); assert.match(p.stderr, /degraded/);
        assert.match(p.stderr, /stdin-(invalid-json|too-large)/);
      }
    });
    await check('Prompt normal: standing rule with no trigger comment is independently searchable', async () => {
      fs.writeFileSync(path.join(mem, 'standinginstructions.md'), standing + block('demo:billing', '账单金额复核', '账单金额必须双重核对。'));
      const r = await run(input('UserPromptSubmit', { prompt: '帮我复核账单金额' }));
      assert(r.receipt.items.some((p) => p.tag === 'demo:billing' && p.visibility === 'whole'));
      fs.writeFileSync(path.join(mem, 'standinginstructions.md'), standing);
    });
    await check('Prompt boundary: unproved Index-only redirect never serves the stale rule', async () => {
      fs.writeFileSync(path.join(mem, 'decisions.md'), '## Index\n- 2026-01-01 old [demo:retired] superseded→[demo:replacement]\n## Entries\n' +
        block('demo:retired', '过期裁定', '不能当现行规则推送。') + block('demo:replacement', '新裁定', '没有真实 Supersedes 边。'));
      const r = await run(input('UserPromptSubmit', { prompt: '[demo:retired]' }));
      assert.equal(r.receipt.displayed, 0); assert(r.receipt.selection_diagnostics.some((d) => d.startsWith('unverified-index-redirect:')));
      assert.equal(r.context, ''); assert.equal(r.stdout, '');
      fs.writeFileSync(path.join(mem, 'decisions.md'), decisions);
    });
    await check('Identity boundary: actors isolated; missing actor never shares task candidates', async () => {
      await run(input('UserPromptSubmit', { prompt: '别把测试失败藏起来' }));
      assert.equal((await run(pre('Bash', { command: 'npm test' }, { agent_id: 'actor-b' }))).receipt.displayed, 0);
      await run(input('UserPromptSubmit', { prompt: '别把测试失败藏起来', agent_id: undefined }));
      const r = await run(pre('Bash', { command: 'npm test' }, { agent_id: undefined }));
      assert.equal(r.receipt.displayed, 0); assert(r.receipt.identity_missing.includes('actor'));
    });
    await check('State fault: preflight write error is visible and increments failures exactly once', async () => {
      await run(input('UserPromptSubmit', { prompt: '继续' }));
      const rename = fs.renameSync; let injected = false;
      fs.renameSync = (from, to) => {
        if (!injected && to === statePath(input('SessionStart'))) { injected = true; throw new Error('synthetic write failure'); }
        return rename(from, to);
      };
      let r;
      try { r = await run(input('UserPromptSubmit', { prompt: '测试失败藏起来' })); }
      finally { fs.renameSync = rename; }
      assert(injected); assert.match(r.context, /回执\/状态写入失败/);
      assert.equal(JSON.parse(fs.readFileSync(statePath(input('SessionStart')))).consecutiveFailures, 1);
    });
    await check('Source fault: source changes during selection, stale body is never emitted', async () => {
      const realSelect = require('../../core/recall-selector.cjs').selectForEvent;
      const r = await run(input('UserPromptSubmit', { prompt: '[demo:hidden]' }), { selectForEvent(corpus, options) {
        const selected = realSelect(corpus, options);
        fs.appendFileSync(path.join(mem, 'decisions.md'), '\nsource-changed\n'); return selected;
      } });
      assert(r.errors.includes('source-changed')); assert.equal(r.receipt.displayed, 0); assert(!r.context.includes('不得隐藏失败退出码'));
      fs.writeFileSync(path.join(mem, 'decisions.md'), decisions);
    });
    await check('Post boundary: JSON key order stable, updated rule version is not suppressed', async () => {
      const x = pre('Edit', { file_path: path.join(repo, 'script.sh'), old_string: 'x', new_string: 'y' }, { session_id: 'post-key-order' });
      await run(x);
      const reordered = { ...x, tool_input: { new_string: 'y', file_path: path.join(repo, 'script.sh'), old_string: 'x' } };
      assert(!post(reordered).stdout.includes('demo:script'));
      fs.writeFileSync(path.join(mem, 'lessons.md'), lessons.replace('保留测试失败退出码', '完整保留测试失败退出码'));
      assert.match(post(reordered).stdout, /demo:script/);
      fs.writeFileSync(path.join(mem, 'lessons.md'), lessons);
    });
    await check('CLI fault: malformed configuration is visible and counted', async () => {
      const file = path.join(t, 'broken-config.json'); fs.writeFileSync(file, '{broken');
      const x = input('SessionStart', { session_id: 'bad-config' });
      const p = spawnSync(process.execPath, [path.join(__dirname, 'hook.cjs')], { input: JSON.stringify(x),
        env: { ...process.env, AXMEM_CONFIG: file }, encoding: 'utf8', cwd: t });
      assert.equal(p.status, 0); assert.match(p.stdout, /config-unavailable/);
      assert.equal(JSON.parse(fs.readFileSync(statePath(x))).consecutiveFailures, 1);
    });
    await check('CLI boundary: relative config memory/state roots resolve beside config, not tool cwd', async () => {
      const relativeMem = path.join(t, 'relative-memory'); fs.mkdirSync(relativeMem);
      for (const f of ['decisions.md', 'lessons.md', 'standinginstructions.md']) fs.writeFileSync(path.join(relativeMem, f), '## Entries\n');
      const file = path.join(t, 'relative-config.json');
      fs.writeFileSync(file, JSON.stringify({ memory_dir: 'relative-memory', state_dir: 'relative-state' }));
      const p = spawnSync(process.execPath, [path.join(__dirname, 'hook.cjs')], { input: JSON.stringify(input('SessionStart')),
        env: { ...process.env, AXMEM_CONFIG: file, AXMEM_MEMORY_DIR: '', AXMEM_STATE_DIR: '' }, encoding: 'utf8', cwd: repo });
      assert.equal(p.status, 0); assert.match(p.stdout, /来源可用/);
      assert(fs.existsSync(path.join(t, 'relative-state', 'recall'))); assert(!fs.existsSync(path.join(repo, 'relative-state')));
    });
    console.log(names.map((n) => '  ok   ' + n).join('\n'));
    console.log(`claude-code hook self-test ${passed}/${names.length}`);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    delete require.cache[require.resolve('../../lib/prelude.cjs')];
    fs.rmSync(t, { recursive: true, force: true });
  }
}
async function componentSelfTest(kind) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-cc-component-'));
  const env = { ...process.env };
  try {
    Object.assign(process.env, { HOME: t, USERPROFILE: t, PMM_HOME: t, AXMEM_HOME: t,
      AXMEM_MEMORY_DIR: t, AXMEM_STATE_DIR: path.join(t, 'state'), AXMEM_CONFIG: path.join(t, 'config.json') });
    fs.writeFileSync(path.join(t, 'config.json'), '{}');
    fs.writeFileSync(path.join(t, 'settings.json'), '{}');
    fs.writeFileSync(path.join(t, 'decisions.md'), '**2026-01-01 — 测试失败如实报告** [demo:rule]\n测试失败不能隐藏。\n');
    fs.writeFileSync(path.join(t, 'lessons.md'), '## Entries\n');
    fs.writeFileSync(path.join(t, 'standinginstructions.md'), '## Entries\n');
    const source = require('../../core/memory-source.cjs');
    if (kind === 'source') {
      const corpus = source.loadCorpus(t); assert.equal(corpus.entries.length, 1);
      assert(source.sameSources(corpus.sources, source.readSources(t)));
      fs.appendFileSync(path.join(t, 'decisions.md'), 'changed');
      assert(!source.sameSources(corpus.sources, source.readSources(t)));
      fs.unlinkSync(path.join(t, 'lessons.md'));
      assert.throws(() => source.loadCorpus(t), /missing-required-source/);
    } else if (kind === 'selector') {
      const select = require('../../core/recall-selector.cjs').selectForEvent;
      const corpus = source.loadCorpus(t);
      assert.equal(select(corpus, { query: '不要隐藏测试失败' }).selected[0].entry.tag, 'demo:rule');
      assert.equal(select(corpus, { query: '继续' }).selected.length, 0);
      corpus.badTags.add('demo:rule');
      assert.equal(select(corpus, { query: '[demo:rule]' }).selected.length, 0);
    } else if (kind === 'receipt') {
      const receipt = require('../../core/recall-receipt.cjs');
      const store = receipt.openStore(path.join(t, 'state'), 'synthetic', 'one');
      try {
        store.append({ stage: 'prepared' }); store.save();
        assert(fs.existsSync(path.join(store.dir, 'state.json')));
        assert.throws(() => receipt.openStore(path.join(t, 'state'), 'synthetic', 'two'));
        assert.equal(receipt.actionId({ session_id: 's' }), null);
      } finally { store.close(); }
    } else throw new Error('unknown test component');
    console.log(`recall-${kind} self-test 3/3`);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env); fs.rmSync(t, { recursive: true, force: true });
  }
}
module.exports = { selfTest, componentSelfTest };
if (require.main === module) selfTest().catch((e) => { console.error(e); process.exitCode = 1; });
