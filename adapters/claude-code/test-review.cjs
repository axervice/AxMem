'use strict';
// A1 regression/benchmark: every child and every fixture uses an isolated HOME.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const hook = require('./hook.cjs');
const receipt = require('../../core/recall-receipt.cjs');
async function reviewSelfTest() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-a1-'));
  const mem = path.join(t, 'memory'), stateRoot = path.join(t, 'state'), config = path.join(t, 'config.json');
  fs.mkdirSync(mem);
  const env = { ...process.env, HOME: t, USERPROFILE: t, PMM_HOME: t, AXMEM_HOME: t,
    AXMEM_MEMORY_DIR: mem, PMM_MEMORY_DIR: mem, AXMEM_STATE_DIR: stateRoot, PMM_STATE_DIR: stateRoot, AXMEM_CONFIG: config };
  fs.writeFileSync(config, JSON.stringify({ memory_dir: mem, state_dir: stateRoot }));
  const body = '**2026-01-01 — 账单金额复核** [demo:billing] [trust:user-ratified]\n账单金额必须双重核对。\n';
  fs.writeFileSync(path.join(mem, 'decisions.md'), body);
  fs.writeFileSync(path.join(mem, 'lessons.md'), '## Entries\n');
  fs.writeFileSync(path.join(mem, 'standinginstructions.md'), '## Entries\n');
  const options = { max_items: 3, max_bytes: 4096, min_topic_terms: 2, kernel_sender: 'external', kernel_max_bytes: 4096 };
  const runtime = { enabled: true, memoryRoot: mem, stateRoot, options };
  const ctx = { AXMEM_CONFIG: config, STATE_DIR: stateRoot, resolveRepo: () => ({ repoId: 'demo', rel: 'x' }) };
  const input = (session, extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: session, agent_id: 'a', prompt: '复核账单金额', ...extra });
  const dirFor = (x) => path.join(stateRoot, 'recall', receipt.identity(x, '').key);
  async function run(x, deps = {}) {
    let stdout = '', stderr = '';
    const r = await hook.runHandler(x, { ctx, runtime, write: async (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, ...deps });
    return { ...r, stdout, stderr, output: stdout ? JSON.parse(stdout) : null };
  }
  const cli = (x) => spawnSync(process.execPath, [path.join(__dirname, 'hook.cjs')], {
    input: JSON.stringify(x), encoding: 'utf8', env, cwd: t, timeout: 10000,
  });
  const failures = [];
  let passed = 0;
  async function check(name, fn) {
    try { await fn(); passed++; console.log('  ok   A1 ' + name); }
    catch (e) { failures.push(name); console.log('  FAIL A1 ' + name + ': ' + e.message); }
  }
  try {
    await check('live-lock-two-processes', async () => {
      const x = input('contended');
      const worker = spawn(process.execPath, ['-e', `
        const r = require(process.argv[1]);
        const s = r.openStore(process.argv[2], process.argv[3], 'holder');
        process.stdout.write('ready\\n');
        process.stdin.resume(); process.stdin.on('end', () => { s.close(); });
      `, require.resolve('../../core/recall-receipt.cjs'), stateRoot, receipt.identity(x, '').key], { env, cwd: t, stdio: ['pipe', 'pipe', 'pipe'] });
      const ended = once(worker, 'close');
      try {
        let timer;
        try {
          await Promise.race([once(worker.stdout, 'data'), ended.then(() => { throw new Error('holder-exited-before-ready'); }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('holder-ready-timeout')), 5000); })]);
        } finally { clearTimeout(timer); }
        const lock = path.join(dirFor(x), 'lock'), before = fs.readFileSync(lock, 'utf8');
        const p = cli(x);
        assert.equal(p.status, 0); assert.equal(p.stderr, '');
        assert(!p.stdout.includes('degraded')); assert(p.stdout.includes('demo:billing'));
        assert.equal(fs.readFileSync(lock, 'utf8'), before, 'live holder lock must not be replaced');
        const owner = JSON.parse(before); assert.equal(owner.pid, worker.pid); assert(Number.isFinite(owner.at));
        assert(!fs.existsSync(path.join(dirFor(x), 'state.json')), 'busy invocation must not write accounting');
      } finally { worker.stdin.end(); await ended; }
    });
    for (const kind of ['dead-pid', 'expired']) await check('stale-lock-' + kind, async () => {
      const x = input(kind), dir = dirFor(x); fs.mkdirSync(dir, { recursive: true });
      let pid = process.pid;
      if (kind === 'dead-pid') {
        const p = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { env, encoding: 'utf8' });
        assert.equal(p.status, 0); pid = Number(p.stdout);
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      }
      fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid, at: Date.now() - (kind === 'expired' ? 120000 : 0) }));
      const r = await run(x); assert.deepEqual(r.errors, []); assert(r.stdout.includes('demo:billing'));
      assert(!fs.existsSync(path.join(dir, 'lock'))); assert(fs.existsSync(path.join(dir, 'state.json')));
    });
    await check('no-match-empty-output', async () => {
      const r = await run(input('no-match', { prompt: '继续' }));
      assert.deepEqual(r.errors, []); assert.equal(r.receipt.displayed, 0); assert.equal(r.context, ''); assert.equal(r.stdout, '');
      assert.equal(r.outputAttempted, false); assert.equal(r.emitted, false);
    });
    await check('pipeline-empty-output', async () => {
      const r = await run(input('pipeline', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'p', tool_input: { command: 'pytest | tail -5' }, cwd: t }));
      assert.deepEqual(r.errors, []); assert.equal(r.stdout, ''); assert.equal(r.receipt.path_status, 'unknown');
      assert.equal(r.receipt.action_reason, 'unsupported-shell-syntax');
    });
    await check('source-diagnostics-receipt-only', async () => {
      fs.appendFileSync(path.join(mem, 'decisions.md'), '\n## Index\n- 2026-01-01 old [demo:gone] superseded→[demo:missing]\n');
      try {
        for (let i = 0; i < 2; i++) {
          const r = await run(input('diagnostics-' + i, { prompt: '[demo:billing]' }));
          assert(r.receipt.source_diagnostics.length); assert(!r.context.includes('unverified-index-redirect')); assert(!r.context.includes('AxMem 状态'));
        }
      } finally { fs.writeFileSync(path.join(mem, 'decisions.md'), body); }
    });
    await check('failure-system-message', async () => {
      const r = await run(input('source-failure'), { runtime: { ...runtime, memoryRoot: path.join(t, 'absent') } });
      assert(r.errors.length); assert.match(r.output.systemMessage, /AxMem.*继续/); assert(r.output.systemMessage.length < 100);
    });
    await check('state-file-retention', async () => {
      const x = input('retention'), dir = dirFor(x); fs.mkdirSync(dir, { recursive: true });
      const old = new Date(Date.now() - 9 * 86400000);
      for (let i = 0; i < 180; i++) {
        const stem = i.toString(16).padStart(64, '0');
        const f = path.join(dir, 'pre-' + stem + '.json'); fs.writeFileSync(f, '{}');
        if (i < 2) fs.utimesSync(f, old, old);
      }
      const r = await run(x); assert.deepEqual(r.errors, []);
      assert(fs.readdirSync(dir).filter((f) => /\.(jsonl|json)$/.test(f) && f !== 'state.json').length <= 128);
      assert(!fs.existsSync(path.join(dir, 'pre-' + '0'.repeat(64) + '.json')));
    });
    await check('oversize-state-rebuild', async () => {
      const x = input('oversize'), dir = dirFor(x); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'state.json'), ' '.repeat(256 * 1024 + 1));
      const r = await run(x); assert.deepEqual(r.errors, []); assert(r.stdout.includes('demo:billing'));
      assert(fs.statSync(path.join(dir, 'state.json')).size < 256 * 1024);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).consecutiveFailures, 0);
    });
    await check('stdin-timeout-event-and-unknown', async () => {
      assert.equal(hook.partialEvent('{"tool_input":{"hook_event_name":"PreToolUse"},"prompt":"unfinished'), 'unknown');
      assert.equal(hook.partialEvent('{"prompt":"\\\"hook_event_name\\\":\\\"PreToolUse\\\"","hook_event_name":"SessionStart",'), 'SessionStart');
      for (const [text, event] of [['{"hook_event_name":"UserPromptSubmit",', 'UserPromptSubmit'], ['', 'unknown']]) {
        const child = spawn(process.execPath, [path.join(__dirname, 'hook.cjs')], { env, cwd: t, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
        const ended = once(child, 'close'); child.stdin.write(text);
        const watchdog = setTimeout(() => child.kill(), 5000);
        try {
          const [code] = await ended; assert.equal(code, 0);
          const out = JSON.parse(stdout);
          assert.match(out.systemMessage, /AxMem/); assert.match(stderr, /stdin-timeout/);
          if (event === 'unknown') {
            // Requirement change: unknown must not poison host enum validation.
            assert(!Object.hasOwn(out, 'hookSpecificOutput'));
            assert.deepEqual(Object.keys(out), ['systemMessage']);
          } else {
            assert.equal(out.hookSpecificOutput.hookEventName, event);
            assert.match(out.hookSpecificOutput.additionalContext, /stdin-timeout/);
          }
        } finally { clearTimeout(watchdog); child.stdin.destroy(); }
      }
    });
    await check('stdin-limit-event', async () => {
      const p = spawnSync(process.execPath, [path.join(__dirname, 'hook.cjs')], { env, cwd: t, encoding: 'utf8',
        input: '{"hook_event_name":"SessionStart","prompt":"' + 'x'.repeat(270000) });
      assert.equal(p.status, 0); const out = JSON.parse(p.stdout);
      assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart'); assert.match(out.hookSpecificOutput.additionalContext, /stdin-too-large/);
    });
    await check('deadline-stops-before-selection', async () => {
      const now = Date.now; let elapsed = 0, selected = false;
      Date.now = () => now() + elapsed;
      let r;
      try {
        r = await run(input('deadline'), {
          loadCorpus() { const c = require('../../core/memory-source.cjs').loadCorpus(mem); elapsed = 2100; return c; },
          selectForEvent() { selected = true; throw new Error('selection-should-not-run'); },
        });
      } finally { Date.now = now; }
      assert(!selected); assert(r.errors.includes('recall-deadline-exceeded')); assert(!r.context.includes('demo:billing'));
    });
    await check('mtime-size-cache-and-one-read', async () => {
      await run(input('cache-warm'));
      const read = fs.readFileSync, counts = new Map();
      fs.readFileSync = (f, ...args) => {
        if (typeof f === 'string' && path.dirname(f) === mem) counts.set(f, (counts.get(f) || 0) + 1);
        return read(f, ...args);
      };
      try { assert.deepEqual((await run(input('cache-hit'))).errors, []); }
      finally { fs.readFileSync = read; }
      assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 0, 'unchanged files should use the persistent cache');
      fs.writeFileSync(path.join(mem, 'decisions.md'), body.replace('双重核对', '重新复核'));
      counts.clear(); fs.readFileSync = (f, ...args) => {
        if (typeof f === 'string' && path.dirname(f) === mem) counts.set(f, (counts.get(f) || 0) + 1);
        return read(f, ...args);
      };
      try {
        const r = await run(input('cache-changed')); assert.deepEqual(r.errors, []); assert(r.context.includes('重新复核'));
        assert.equal(counts.get(path.join(mem, 'decisions.md')), 1);
        assert([...counts.values()].every((n) => n <= 1));
      } finally { fs.readFileSync = read; fs.writeFileSync(path.join(mem, 'decisions.md'), body); }
    });
    // Same fixture + command is retained for both red baseline and repaired run.
    const blocks = [];
    for (let i = 0; i < 180; i++) blocks.push(`**2026-01-01 — 部署核对 ${i}** [demo:bench${i}] [trust:user-ratified]\n` + '部署之前核对账单金额，测试失败必须完整报告。'.repeat(82) + '\n');
    fs.writeFileSync(path.join(mem, 'decisions.md'), body + blocks.join(''));
    const samples = [];
    for (let i = 0; i < 4; i++) {
      const start = performance.now(), p = cli(input('benchmark', { prompt: '复核账单金额' }));
      assert.equal(p.status, 0); assert(!p.stdout.includes('degraded'), p.stdout); samples.push(Math.round((performance.now() - start) * 10) / 10);
    }
    console.log('A1 BENCH ' + JSON.stringify({ bytes: fs.statSync(path.join(mem, 'decisions.md')).size, cli_ms: samples, warm_median_ms: [...samples.slice(1)].sort((a, b) => a - b)[1] }));
    const profile = spawnSync(process.execPath, ['-e', `
      const { performance: p } = require('node:perf_hooks'), started = p.now(), phases = {};
      const hook = require(process.argv[1]);
      const source = require(process.argv[2]), selector = require(process.argv[3]);
      phases.require_ms = p.now() - started;
      hook.runHandler(JSON.parse(process.argv[4]), {
        loadCorpus(...args) { const s = p.now(); const c = source.loadCorpus(...args); phases.source_ms = p.now() - s; return c; },
        selectForEvent(...args) { const s = p.now(); const c = selector.selectForEvent(...args); phases.select_ms = p.now() - s; return c; },
        write: async () => {}, stderr: () => {},
      }).then((r) => { phases.total_ms = p.now() - started; phases.errors = r.errors; console.log(JSON.stringify(phases)); });
    `, require.resolve('./hook.cjs'), require.resolve('../../core/memory-source.cjs'), require.resolve('../../core/recall-selector.cjs'), JSON.stringify(input('profile'))], { env, cwd: t, encoding: 'utf8' });
    assert.equal(profile.status, 0); const phases = JSON.parse(profile.stdout); assert.deepEqual(phases.errors, []);
    console.log('A1 PROFILE ' + JSON.stringify(phases));
    console.log(`A1 review self-test ${passed}/${passed + failures.length}`);
    assert.deepEqual(failures, [], 'A1 regressions');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}
module.exports = { reviewSelfTest };
