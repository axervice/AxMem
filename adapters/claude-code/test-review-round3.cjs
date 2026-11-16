'use strict';
// Claim failure edge cases use only synthetic temporary state and injected I/O.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const receipt = require('../../core/recall-receipt.cjs');
const hook = require('./hook.cjs');

async function round3SelfTest() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-a1-r3-'));
  const root = path.join(t, 'state');
  let passed = 0; const failures = [];
  async function check(name, fn) {
    try { await fn(); passed++; console.log('  ok   A1 R3 ' + name); }
    catch (e) { failures.push(name); console.log('  FAIL A1 R3 ' + name + ': ' + e.message); }
  }
  const denied = (code) => Object.assign(new Error('synthetic ' + code), { code });
  try {
    await check('mkdir-and-lstat-eacces-visible-not-busy', async () => {
      const input = { hook_event_name: 'UserPromptSubmit', session_id: 'stat-denied', agent_id: 'a', prompt: 'test' };
      const dir = path.join(root, 'recall', receipt.identity(input, '').key);
      const claim = path.join(dir, 'lock.claim'), lock = path.join(dir, 'lock');
      const mkdir = fs.mkdirSync, stat = fs.lstatSync, wait = Atomics.wait;
      let attempts = 0, stats = 0, waits = [], stdout = '', stderr = '';
      Atomics.wait = (...args) => { waits.push(args[3]); return wait(...args); };
      fs.mkdirSync = (f, ...args) => { if (f === claim) { attempts++; throw denied('EACCES'); } return mkdir(f, ...args); };
      fs.lstatSync = (f, ...args) => { if (f === claim || f === lock) { stats++; throw denied('EACCES'); } return stat(f, ...args); };
      try {
        const r = await hook.runHandler(input, { ctx: { AXMEM_CONFIG: path.join(t, 'config.json'), STATE_DIR: root },
          write: async (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
        console.log('A1 R3 stat-denied observed ' + JSON.stringify({ attempts, stats, errors: r.errors, stderr, stdout }));
        assert.deepEqual(r.errors, ['state-unavailable']); assert.equal(r.receipt, undefined);
        assert.equal(attempts, 3); assert.equal(stats, 6); assert.deepEqual(waits, [5, 5]);
        assert.match(stderr, /state-unavailable/);
        assert.match(JSON.parse(stdout).systemMessage, /工作继续/);
        assert.match(r.context, /本次失败=1/);
      } finally { fs.mkdirSync = mkdir; fs.lstatSync = stat; Atomics.wait = wait; }
    });
    for (const phase of ['acquire', 'release']) {
      await check('session-cleanup-continues-after-claim-denial-' + phase, async () => {
        const stateRoot = path.join(t, 'cleanup-' + phase), recall = path.join(stateRoot, 'recall');
        fs.mkdirSync(recall, { recursive: true });
        const dirs = ['a', 'b', 'c'].map((c) => path.join(recall, c.repeat(64)));
        dirs.forEach((dir, i) => {
          fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'state.json'), '{}');
          const age = new Date(Date.now() - (9 + i) * 86400000); fs.utimesSync(dir, age, age);
        });
        const claim = path.join(dirs[0], 'lock.claim'), lock = path.join(dirs[0], 'lock');
        const mkdir = fs.mkdirSync, stat = fs.lstatSync; let calls = 0, deniedCalls = 0;
        fs.lstatSync = (f, ...args) => {
          if (phase === 'release' && deniedCalls && f === lock) throw denied('ENOENT');
          return stat(f, ...args);
        };
        fs.mkdirSync = (f, ...args) => {
          if (f === claim && (++calls > (phase === 'acquire' ? 0 : 1))) { deniedCalls++; throw denied('EACCES'); }
          return mkdir(f, ...args);
        };
        let r, stderr = '';
        try {
          r = await hook.runHandler({ hook_event_name: 'UserPromptSubmit', session_id: 'clean-' + phase, prompt: 'test' }, {
            ctx: { AXMEM_CONFIG: path.join(t, 'config.json'), STATE_DIR: stateRoot }, runtime: { enabled: false },
            write: async () => {}, stderr: (s) => { stderr += s; },
          });
        } finally { fs.mkdirSync = mkdir; fs.lstatSync = stat; }
        console.log('A1 R3 cleanup-denied observed ' + JSON.stringify({ phase, calls, deniedCalls, errors: r.errors,
          maintenance: r.receipt?.maintenance_errors, remaining: dirs.map((dir) => fs.existsSync(dir)), stderr }));
        assert.equal(deniedCalls, 3); assert.deepEqual(r.errors, []); assert.equal(stderr, '');
        assert.deepEqual(r.receipt.maintenance_errors, []);
        assert(fs.existsSync(dirs[0]));
        assert(!fs.existsSync(dirs[1])); assert(!fs.existsSync(dirs[2]));
      });
    }
    await check('delete-pending-and-real-lock-remain-busy', async () => {
      for (const mode of ['pending', 'pending-ebusy', 'main', 'main-stat-eacces', 'ebusy']) {
        const key = 'pending-' + mode, dir = path.join(root, 'recall', key), claim = path.join(dir, 'lock.claim');
        fs.mkdirSync(dir, { recursive: true });
        if (mode === 'main' || mode === 'main-stat-eacces') fs.writeFileSync(path.join(dir, 'lock'), '{}');
        const mkdir = fs.mkdirSync, stat = fs.lstatSync; let attempts = 0;
        fs.mkdirSync = (f, ...args) => { if (f === claim) { attempts++; throw denied(mode === 'ebusy' ? 'EBUSY' : 'EPERM'); } return mkdir(f, ...args); };
        fs.lstatSync = (f, ...args) => {
          if (f === claim && mode === 'pending') throw denied('EPERM');
          if (f === claim && mode === 'pending-ebusy') throw denied('EBUSY');
          if (f === claim && mode === 'main-stat-eacces') throw denied('EACCES');
          return stat(f, ...args);
        };
        try {
          const store = receipt.openStore(root, key, 'pending', { skipBusy: true });
          assert.equal(store.busy, true); assert.equal(attempts, 1); store.close();
          assert(!fs.existsSync(path.join(dir, 'state.json')));
        } finally { fs.mkdirSync = mkdir; fs.lstatSync = stat; }
      }
    });
    await check('observed-stale-claim-resets-permission-sequence', async () => {
      const key = 'reset', claim = path.join(root, 'recall', key, 'lock.claim');
      const mkdir = fs.mkdirSync; let attempts = 0;
      fs.mkdirSync = (f, ...args) => {
        if (f === claim) {
          attempts++;
          if (attempts === 2) {
            mkdir(f, ...args);
            const old = new Date(Date.now() - 60000); fs.utimesSync(f, old, old);
            throw denied('EEXIST');
          }
          throw denied('EACCES');
        }
        return mkdir(f, ...args);
      };
      try {
        assert.throws(() => receipt.openStore(root, key, 'reset', { skipBusy: true }), { code: 'state-claim-unavailable' });
        assert.equal(attempts, 5);
      } finally { fs.mkdirSync = mkdir; }
    });
    await check('claim-files-are-unsafe-even-when-stale', async () => {
      const key = 'file-claim', dir = path.join(root, 'recall', key), claim = path.join(dir, 'lock.claim');
      fs.mkdirSync(dir, { recursive: true });
      const old = new Date(Date.now() - 60000);
      for (const text of ['axmem-file-', 'not-an-axmem-claim']) {
        fs.writeFileSync(claim, text); fs.utimesSync(claim, old, old);
        assert.throws(() => receipt.openStore(root, key, 'unsafe'), /unsafe-lock/);
        assert.equal(fs.readFileSync(claim, 'utf8'), text);
      }
      fs.unlinkSync(claim);
    });
    await check('unwritable-claim-warns-without-receipt', async () => {
      const input = { hook_event_name: 'UserPromptSubmit', session_id: 'unwritable', agent_id: 'a', prompt: 'test' };
      const dir = path.join(root, 'recall', receipt.identity(input, '').key), claim = path.join(dir, 'lock.claim');
      const mkdir = fs.mkdirSync, open = fs.openSync; let attempts = 0, stdout = '', stderr = '';
      fs.mkdirSync = (f, ...args) => { if (f === claim) { attempts++; throw denied('EACCES'); } return mkdir(f, ...args); };
      fs.openSync = (f, ...args) => { if (f === claim) throw denied('EACCES'); return open(f, ...args); };
      try {
        const r = await hook.runHandler(input, { ctx: { AXMEM_CONFIG: path.join(t, 'config.json'), STATE_DIR: root },
          write: async (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
        assert.deepEqual(r.errors, ['state-unavailable']); assert.equal(r.receipt, undefined);
        assert.equal(attempts, 3); assert.match(stderr, /state-unavailable/);
        assert.match(JSON.parse(stdout).systemMessage, /工作继续/); assert.match(r.context, /本次失败=1/);
        assert(!fs.existsSync(path.join(dir, 'state.json')));
      } finally { fs.mkdirSync = mkdir; fs.openSync = open; }
    });
    await check('normal-acquisition-adds-no-claim-io', async () => {
      const key = 'hot', claim = path.join(root, 'recall', key, 'lock.claim');
      const mkdir = fs.mkdirSync, stat = fs.lstatSync, open = fs.openSync, wait = Atomics.wait;
      let mkdirs = 0, stats = 0, fileOpens = 0, waits = 0;
      Atomics.wait = (...args) => { waits++; return wait(...args); };
      fs.mkdirSync = (f, ...args) => { if (f === claim) mkdirs++; return mkdir(f, ...args); };
      fs.lstatSync = (f, ...args) => { if (f === claim) stats++; return stat(f, ...args); };
      fs.openSync = (f, ...args) => { if (f === claim) fileOpens++; return open(f, ...args); };
      try {
        const store = receipt.openStore(root, key, 'hot');
        assert.notEqual(store.busy, true);
        assert.equal(mkdirs, 1); assert.equal(stats, 2); assert.equal(fileOpens, 0); assert.equal(waits, 0);
        store.close(); assert.equal(waits, 0);
      } finally { fs.mkdirSync = mkdir; fs.lstatSync = stat; fs.openSync = open; Atomics.wait = wait; }
    });
    console.log(`A1 R3 edge self-test ${passed}/${passed + failures.length}`);
    assert.deepEqual(failures, [], 'A1 R3 edge regressions');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}
module.exports = { round3SelfTest };
if (require.main === module) round3SelfTest().catch((e) => { console.error(e); process.exitCode = 1; });
