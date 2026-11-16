'use strict';
// Delta-review regressions. All children use synthetic, isolated HOME/state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const hook = require('./hook.cjs');
const receipt = require('../../core/recall-receipt.cjs');

async function worker(kind, data) {
  if (kind === 'stress') {
    const mkdir = fs.mkdirSync, codes = ['EPERM', 'EACCES', 'EBUSY'];
    const stats = { attempts: 240, owned: 0, busy: 0, errors: [], injected: {} };
    let calls = 0, acquiring = false;
    // Run native races as well as deterministic Windows mkdir-vs-delete errors
    // on every OS. Inject only acquisition, not release, so locks keep cycling.
    fs.mkdirSync = (file, ...args) => {
      if (data.inject && acquiring && String(file).endsWith('lock.claim') && ++calls % 5 === 1) {
        const code = codes[Math.floor(calls / 5) % codes.length];
        stats.injected[code] = (stats.injected[code] || 0) + 1;
        throw Object.assign(new Error('synthetic Windows claim race'), { code });
      }
      return mkdir(file, ...args);
    };
    process.send({ ready: true });
    process.once('message', () => {
      for (let i = 0; i < stats.attempts; i++) {
        try {
          acquiring = true;
          const s = receipt.openStore(data.stateRoot, data.key, 'stress-' + process.pid + '-' + i, { skipBusy: true });
          acquiring = false;
          if (s.busy) stats.busy++; else stats.owned++;
          s.close();
        } catch (e) { acquiring = false; stats.errors.push(e.code || e.message); }
      }
      fs.mkdirSync = mkdir;
      process.send({ result: stats }, () => process.disconnect());
    });
  } else if (kind === 'holder') {
    const s = receipt.openStore(data.stateRoot, data.key, 'holder');
    process.send({ ready: true });
    process.once('message', () => { s.close(); process.send({ result: 'closed' }, () => process.disconnect()); });
  } else if (kind === 'replay') {
    const ctx = { AXMEM_CONFIG: data.config, STATE_DIR: data.stateRoot,
      resolveRepo: () => ({ repoId: 'demo', rel: 'x' }) };
    const view = receipt.openStore(data.stateRoot, data.key, 'readonly-probe', { skipBusy: true });
    const snapshot = JSON.parse(JSON.stringify(view.state));
    view.append({ mustNotPersist: true }); view.save(); view.mark('probe', {}); view.close();
    const rows = [];
    for (let i = 0; i < 12; i++) {
      let stdout = '', stderr = '';
      const r = await hook.runHandler(data.input, { ctx, runtime: data.runtime,
        write: async (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
      rows.push({ errors: r.errors, receipt: r.receipt, stdout, stderr });
    }
    process.send({ result: { busy: view.busy, snapshot, rows } }, () => process.disconnect());
  } else throw new Error('unknown worker');
}

async function round2SelfTest() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-a1-delta-'));
  const mem = path.join(t, 'memory'), stateRoot = path.join(t, 'state'), config = path.join(t, 'config.json');
  fs.mkdirSync(mem);
  fs.writeFileSync(config, JSON.stringify({ memory_dir: mem, state_dir: stateRoot }));
  fs.writeFileSync(path.join(mem, 'decisions.md'), '**2026-01-01 — 账单金额复核** [demo:billing] [trust:user-ratified]\n账单金额必须双重核对。\n');
  for (const f of ['lessons.md', 'standinginstructions.md']) fs.writeFileSync(path.join(mem, f), '## Entries\n');
  const env = { ...process.env, HOME: t, USERPROFILE: t, PMM_HOME: t, AXMEM_HOME: t,
    AXMEM_CONFIG: config, AXMEM_MEMORY_DIR: mem, PMM_MEMORY_DIR: mem, AXMEM_STATE_DIR: stateRoot, PMM_STATE_DIR: stateRoot };
  const runtime = { enabled: true, memoryRoot: mem, stateRoot,
    options: { max_items: 3, max_bytes: 4096, min_topic_terms: 2, kernel_sender: 'external', kernel_max_bytes: 4096 } };
  const ctx = { AXMEM_CONFIG: config, STATE_DIR: stateRoot, resolveRepo: () => ({ repoId: 'demo', rel: 'x' }) };
  const input = (session, extra = {}) => ({ hook_event_name: 'UserPromptSubmit', session_id: session,
    agent_id: 'a', prompt: '复核账单金额', cwd: t, ...extra });
  const dirFor = (x) => path.join(stateRoot, 'recall', receipt.identity(x, '').key);
  async function run(x, deps = {}) {
    let stdout = '', stderr = '';
    const r = await hook.runHandler(x, { ctx, runtime, write: async (s) => { stdout += s; },
      stderr: (s) => { stderr += s; }, ...deps });
    return { ...r, stdout, stderr, output: stdout ? JSON.parse(stdout) : null };
  }
  function startWorker(kind, data) {
    const p = spawn(process.execPath, [__filename, '--worker', kind, JSON.stringify(data)], {
      env, cwd: t, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '', result, readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // A worker can fail before its ready promise is awaited.
    ready.catch(() => {});
    p.stderr.on('data', (s) => { stderr += s; }); p.stdout.resume();
    const timer = setTimeout(() => p.kill(), 20000);
    const done = new Promise((resolve, reject) => {
      p.on('message', (m) => { if (m.ready) readyResolve(); if ('result' in m) result = m.result; });
      p.on('error', (e) => { readyReject(e); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 || result === undefined) {
          const e = new Error('worker ' + kind + ' exit=' + code + ': ' + stderr);
          readyReject(e); reject(e);
        } else resolve(result);
      });
    });
    done.catch(() => {});
    return { p, ready, done };
  }
  const failures = []; let passed = 0;
  async function check(name, fn) {
    try { await fn(); passed++; console.log('  ok   A1 delta ' + name); }
    catch (e) { failures.push(name); console.log('  FAIL A1 delta ' + name + ': ' + e.message.slice(0, 900)); }
  }
  try {
    await check('persistent-claim-access-denied-visible-accounted', async () => {
      const x = input('persistent-claim'), dir = dirFor(x), claim = path.join(dir, 'lock.claim');
      const mkdir = fs.mkdirSync; let attempts = 0, r;
      fs.mkdirSync = (f, ...args) => {
        if (f === claim) { attempts++; throw Object.assign(new Error('synthetic unwritable claim'), { code: 'EACCES' }); }
        return mkdir(f, ...args);
      };
      try { r = await run(x); } finally { fs.mkdirSync = mkdir; }
      const stateFile = path.join(dir, 'state.json');
      console.log('A1 R3 persistent observed ' + JSON.stringify({ attempts, errors: r.errors,
        stderr: r.stderr, systemMessage: r.output?.systemMessage || null, stateExists: fs.existsSync(stateFile) }));
      assert.deepEqual(r.errors, ['state-unavailable']);
      assert.match(r.stderr, /state-unavailable/); assert.match(r.output.systemMessage, /工作继续/);
      assert.equal(attempts >= 3, true);
      assert.equal(r.receipt, undefined); assert.match(r.context, /本次失败=1/);
      assert.equal(fs.existsSync(stateFile), false);
      // Continued denial with no leftover lock must remain visibly unavailable.
      fs.mkdirSync = (f, ...args) => {
        if (f === claim) throw Object.assign(new Error('synthetic unwritable claim'), { code: 'EACCES' });
        return mkdir(f, ...args);
      };
      try {
        for (let n = 2; n <= 4; n++) {
          const next = await run(x);
          assert.deepEqual(next.errors, ['state-unavailable']); assert.match(next.stderr, /state-unavailable/);
          assert.match(next.output.systemMessage, /工作继续/); assert.match(next.context, /本次失败=1/);
          assert.equal(next.receipt, undefined); assert.equal(fs.existsSync(stateFile), false);
        }
      } finally { fs.mkdirSync = mkdir; }
    });
    await check('transient-claim-eperm-retries-and-owns', async () => {
      const x = input('transient-claim'), dir = dirFor(x), claim = path.join(dir, 'lock.claim');
      const mkdir = fs.mkdirSync; let attempts = 0, r;
      fs.mkdirSync = (f, ...args) => {
        if (f === claim && ++attempts === 1) throw Object.assign(new Error('synthetic transient race'), { code: 'EPERM' });
        return mkdir(f, ...args);
      };
      try { r = await run(x); } finally { fs.mkdirSync = mkdir; }
      const stateFile = path.join(dir, 'state.json');
      console.log('A1 R3 transient observed ' + JSON.stringify({ attempts, errors: r.errors,
        stderr: r.stderr, stateExists: fs.existsSync(stateFile) }));
      assert(attempts >= 2); assert.deepEqual(r.errors, []); assert.equal(r.stderr, '');
      assert.equal(r.receipt.displayed, 1);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(state.consecutiveFailures, 0); assert.equal(state.counts.errors, 0);
      const rows = fs.readFileSync(path.join(dir, r.receipt.invocation_id + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert(rows.some((row) => row.stage === 'completed' && row.error_codes.length === 0));
    });
    await check('windows-claim-eight-process-tight-loop', async () => {
      const rounds = [];
      for (const inject of [false, true]) {
        const x = input('stress-' + inject), key = receipt.identity(x, '').key;
        const children = Array.from({ length: 8 }, () => startWorker('stress', { stateRoot, key, inject }));
        try {
          await Promise.all(children.map((c) => c.ready));
          children.forEach((c) => c.p.send('go'));
          const stats = await Promise.all(children.map((c) => c.done));
          const summary = { mode: inject ? 'injected' : 'native', processes: stats.length,
            attempts: stats.reduce((n, s) => n + s.attempts, 0),
            owned: stats.reduce((n, s) => n + s.owned, 0), busy: stats.reduce((n, s) => n + s.busy, 0),
            errors: stats.flatMap((s) => s.errors) };
          console.log('A1 DELTA CLAIM ' + JSON.stringify({ ...summary, errors: summary.errors.reduce((m, c) => ({ ...m, [c]: (m[c] || 0) + 1 }), {}) }));
          assert.equal(stats.length, 8); assert.equal(summary.attempts, 1920);
          if (inject) for (const s of stats) for (const code of ['EPERM', 'EACCES', 'EBUSY']) assert(s.injected[code] > 0);
          rounds.push(summary);
        } finally {
          for (const c of children) if (c.p.exitCode === null) c.p.kill();
          await Promise.allSettled(children.map((c) => c.done));
        }
      }
      for (const summary of rounds) {
        assert.deepEqual(summary.errors, [], summary.mode + ': ordinary Windows claim races must not fail openStore');
        assert(summary.owned > 0); assert(summary.busy > 0);
      }
    });
    await check('busy-readonly-two-process-same-task-action-replay', async () => {
      const prompt = input('readonly');
      const first = await run(prompt); assert.deepEqual(first.errors, []); assert.equal(first.receipt.displayed, 1);
      const pre = { ...prompt, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'same-action', tool_input: { command: 'npm test' } };
      const emitted = await run(pre); assert.deepEqual(emitted.errors, []); assert.equal(emitted.receipt.displayed, 1);
      const dir = dirFor(pre), key = receipt.identity(pre, '').key;
      const holder = startWorker('holder', { stateRoot, key });
      try {
        await holder.ready;
        const snapshot = () => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'hex')]));
        const before = snapshot();
        const requester = startWorker('replay', { stateRoot, key, config, runtime, input: pre });
        const replay = await requester.done;
        assert.equal(replay.busy, true); assert.equal(replay.snapshot.taskId, first.receipt.task_id);
        assert.deepEqual(replay.snapshot.candidates.map((p) => p.tag), ['demo:billing']);
        assert(replay.snapshot.seen.length >= 2);
        for (const r of replay.rows) {
          assert.deepEqual(r.errors, []); assert.equal(r.stderr, ''); assert.equal(r.stdout, '');
          assert.equal(r.receipt.task_id, first.receipt.task_id); assert.equal(r.receipt.displayed, 0);
          assert.equal(r.receipt.suppression_reason, 'same-action-version-emitted');
        }
        assert.deepEqual(snapshot(), before, 'busy reads, no-op accounting and replay must not change any store bytes');
        // A distinct action may remind again (existing product policy). It must
        // still have the same task and candidate even while accounting is busy.
        const candidate = await run({ ...pre, tool_use_id: 'new-action' });
        assert.deepEqual(candidate.errors, []); assert.equal(candidate.receipt.task_id, first.receipt.task_id);
        assert.equal(candidate.receipt.displayed, 1); assert.equal(candidate.receipt.items[0].reason, 'task-candidate');
        assert.deepEqual(snapshot(), before);
        assert.deepEqual([...receipt.suppressPost(pre, runtime)], ['demo:billing'], 'persisted Pre marker still suppresses Post');
      } finally {
        if (holder.p.connected) holder.p.send('close');
        await holder.done;
      }
    });
    await check('busy-torn-invalid-or-unreadable-state-falls-back', async () => {
      const x = input('torn', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'torn', tool_input: { command: 'npm test' } });
      const dir = dirFor(x), holder = receipt.openStore(stateRoot, receipt.identity(x, '').key, 'torn-holder');
      try {
        for (const text of ['{"epoch":', 'null', '[]', '{"epoch":0,"candidates":"bad"}']) {
          fs.writeFileSync(path.join(dir, 'state.json'), text);
          const r = await run(x); assert.deepEqual(r.errors, []); assert.equal(r.stdout, '');
          assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), text);
        }
        const read = fs.readFileSync;
        fs.readFileSync = (f, ...args) => {
          if (f === path.join(dir, 'state.json')) throw Object.assign(new Error('synthetic read failure'), { code: 'EACCES' });
          return read(f, ...args);
        };
        try { const r = await run(x); assert.deepEqual(r.errors, []); assert.equal(r.stdout, ''); }
        finally { fs.readFileSync = read; }
      } finally { holder.close(); }
    });
    await check('session-prune-mkdir-claim-race-retries', async () => {
      const x = input('prune-race'), dir = dirFor(x), mkdir = fs.mkdirSync;
      let injected = false;
      fs.mkdirSync = (f, ...args) => {
        if (!injected && f === path.join(dir, 'lock.claim')) {
          injected = true;
          // A pruning process removed the still-empty session just after the
          // opener's recursive mkdir, before its first claim mkdir.
          fs.rmdirSync(dir);
        }
        return mkdir(f, ...args);
      };
      let r;
      try { r = await run(x); } finally { fs.mkdirSync = mkdir; }
      assert(injected); assert.deepEqual(r.errors, []); assert.equal(r.stderr, '');
      assert.equal(r.receipt.displayed, 1); assert(fs.existsSync(path.join(dir, 'state.json')));
    });
    await check('session-prune-preserves-refreshed-state', async () => {
      const root = path.join(t, 'refresh-state'), oldKey = 'd'.repeat(64);
      const old = receipt.openStore(root, oldKey, 'old'); old.save(); old.close();
      const ago = new Date(Date.now() - 9 * 86400000); fs.utimesSync(old.dir, ago, ago);
      const mkdir = fs.mkdirSync; let injected = false, refreshed;
      fs.mkdirSync = (f, ...args) => {
        if (!injected && f === path.join(old.dir, 'lock.claim')) {
          injected = true;
          // Another invocation refreshes this previously old session after
          // enumeration but before the cleaner claims it.
          const active = receipt.openStore(root, oldKey, 'refreshed');
          active.state.taskId = 'newly-refreshed'; active.save(); active.close();
          refreshed = fs.readFileSync(path.join(old.dir, 'state.json'), 'utf8');
        }
        return mkdir(f, ...args);
      };
      let r;
      try { r = await run(input('refresh-current'), { ctx: { ...ctx, STATE_DIR: root }, runtime: { ...runtime, stateRoot: root } }); }
      finally { fs.mkdirSync = mkdir; }
      assert(injected); assert.deepEqual(r.errors, []); assert.deepEqual(r.receipt.maintenance_errors, []);
      assert.equal(fs.readFileSync(path.join(old.dir, 'state.json'), 'utf8'), refreshed, 'maintenance must revalidate the committed state after acquiring its lease');
    });
    await check('unknown-event-top-level-message-only', async () => {
      for (const event of ['unknown', 'FutureEvent', undefined]) {
        const r = await run(input('unknown-' + event, { hook_event_name: event }));
        assert.deepEqual(r.errors, ['invalid-event']); assert.match(r.stderr, /invalid-event/);
        assert.deepEqual(r.output, { systemMessage: 'AxMem 召回暂不可用；工作继续。' });
        assert(!Object.hasOwn(r.output, 'hookSpecificOutput'));
      }
      for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse']) {
        const out = JSON.parse(hook.renderHookOutput(event, 'diagnostic', true));
        assert.equal(out.hookSpecificOutput.hookEventName, event);
        assert.equal(out.hookSpecificOutput.additionalContext, 'diagnostic'); assert.match(out.systemMessage, /继续/);
      }
    });
    await check('cleanup-failure-receipt-not-recall-failure', async () => {
      for (const method of ['readdirSync', 'lstatSync', 'unlinkSync']) {
        const x = input('cleanup-' + method), dir = dirFor(x); fs.mkdirSync(dir, { recursive: true });
        const old = path.join(dir, 'pre-' + 'a'.repeat(64) + '.json'); fs.writeFileSync(old, '{}');
        const ago = new Date(Date.now() - 9 * 86400000); fs.utimesSync(old, ago, ago);
        const original = fs[method]; let injected = false;
        fs[method] = (f, ...args) => {
          if (f === (method === 'readdirSync' ? dir : old)) {
            injected = true; throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
          }
          return original(f, ...args);
        };
        let r;
        try { r = await run(x); } finally { fs[method] = original; }
        assert(injected); assert.deepEqual(r.errors, []); assert.equal(r.stderr, ''); assert.equal(r.receipt.displayed, 1);
        assert(r.receipt.maintenance_errors.includes('store-cleanup-failed'));
        const rows = fs.readFileSync(path.join(dir, r.receipt.invocation_id + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert(rows.every((row) => row.maintenance_errors.includes('store-cleanup-failed')));
        assert(!r.stdout.includes('degraded'));
      }
    });
    await check('session-and-cache-staging-retention', async () => {
      const root = path.join(t, 'retention-state'), recall = path.join(root, 'recall'); fs.mkdirSync(recall, { recursive: true });
      const ago = new Date(Date.now() - 9 * 86400000), recent = new Date(Date.now() - 60000);
      const current = input('retain-current'), key = receipt.identity(current, '').key;
      const liveKey = 'f'.repeat(64), live = receipt.openStore(root, liveKey, 'live');
      const liveState = path.join(live.dir, 'state.json'); live.save();
      for (let i = 0; i < 140; i++) {
        const dir = path.join(recall, i.toString(16).padStart(64, '0')); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'state.json'), '{}'); fs.utimesSync(dir, i < 2 ? ago : recent, i < 2 ? ago : recent);
      }
      fs.utimesSync(live.dir, ago, ago);
      const foreign = path.join(recall, 'foreign-directory'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep'), 'foreign'); fs.utimesSync(foreign, ago, ago);
      const cacheDirs = [path.join(root, 'recall-topic'), path.join(root, 'recall-source', 'e'.repeat(64))];
      for (const dir of cacheDirs) {
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'cache.json'), 'keep');
        for (let i = 0; i < 140; i++) {
          const file = path.join(dir, '.cache.json.axmem-staging-123-1-' + i); fs.writeFileSync(file, 'staging');
          fs.utimesSync(file, i < 2 ? ago : recent, i < 2 ? ago : recent);
        }
        fs.writeFileSync(path.join(dir, '.cache.json.axmem-staging-live'), 'active');
      }
      try {
        const r = await run(current, { ctx: { ...ctx, STATE_DIR: root }, runtime: { ...runtime, stateRoot: root } });
        assert.deepEqual(r.errors, []); assert.deepEqual(r.receipt.maintenance_errors, []);
        const sessions = fs.readdirSync(recall).filter((f) => /^[a-f0-9]{64}$/.test(f));
        assert(sessions.length <= 128, 'inactive sessions must be bounded, got ' + sessions.length);
        assert(sessions.includes(key)); assert(sessions.includes(liveKey)); assert(fs.existsSync(liveState));
        assert(!fs.existsSync(path.join(recall, '0'.repeat(64)))); assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign');
        for (const dir of cacheDirs) {
          const stages = fs.readdirSync(dir).filter((f) => f.includes('.axmem-staging-'));
          assert(stages.length <= 128, 'cache staging must be bounded');
          assert(!stages.includes('.cache.json.axmem-staging-123-1-0'));
          assert(stages.includes('.cache.json.axmem-staging-live'), 'fresh potential writer must not be cleaned');
          assert.equal(fs.readFileSync(path.join(dir, 'cache.json'), 'utf8'), 'keep');
        }
      } finally { live.close(); }
    });
    console.log(`A1 delta self-test ${passed}/${passed + failures.length}`);
    assert.deepEqual(failures, [], 'A1 delta regressions');
    await require('./test-review-round3.cjs').round3SelfTest();
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}
module.exports = { round2SelfTest };
if (require.main === module && process.argv[2] === '--worker') {
  worker(process.argv[3], JSON.parse(process.argv[4])).catch((e) => { console.error(e); process.exitCode = 1; process.disconnect(); });
} else if (require.main === module) {
  round2SelfTest().catch((e) => { console.error(e); process.exitCode = 1; });
}
