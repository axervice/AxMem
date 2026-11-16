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
  let passed = 0;
  async function check(name, fn) { await fn(); passed++; console.log('  ok   A1 R3 ' + name); }
  const denied = (code) => Object.assign(new Error('synthetic ' + code), { code });
  try {
    await check('delete-pending-and-real-lock-remain-busy', async () => {
      for (const mode of ['pending', 'main', 'ebusy']) {
        const key = 'pending-' + mode, dir = path.join(root, 'recall', key), claim = path.join(dir, 'lock.claim');
        fs.mkdirSync(dir, { recursive: true });
        if (mode === 'main') fs.writeFileSync(path.join(dir, 'lock'), '{}');
        const mkdir = fs.mkdirSync, stat = fs.lstatSync; let attempts = 0;
        fs.mkdirSync = (f, ...args) => { if (f === claim) { attempts++; throw denied(mode === 'ebusy' ? 'EBUSY' : 'EPERM'); } return mkdir(f, ...args); };
        fs.lstatSync = (f, ...args) => { if (mode === 'pending' && f === claim) throw denied('EPERM'); return stat(f, ...args); };
        try {
          const store = receipt.openStore(root, key, 'pending', { skipBusy: true, accountClaimFailure: true });
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
        const store = receipt.openStore(root, key, 'reset', { skipBusy: true, accountClaimFailure: true });
        assert.equal(store.claimUnavailable, true); assert.equal(attempts, 5); store.close();
      } finally { fs.mkdirSync = mkdir; }
    });
    await check('file-claim-serializes-and-expired-file-recovers', async () => {
      const key = 'file-claim', dir = path.join(root, 'recall', key), claim = path.join(dir, 'lock.claim');
      const mkdir = fs.mkdirSync, open = fs.openSync, write = fs.writeFileSync;
      let injecting = true, claimFd, rivalBusy = false;
      fs.mkdirSync = (f, ...args) => { if (injecting && f === claim) throw denied('EACCES'); return mkdir(f, ...args); };
      fs.openSync = (f, ...args) => { const fd = open(f, ...args); if (f === claim && args[0] === 'wx') claimFd = fd; return fd; };
      fs.writeFileSync = (f, ...args) => {
        const result = write(f, ...args);
        if (f === claimFd && injecting) {
          injecting = false;
          try {
            assert(fs.lstatSync(claim).isFile());
            const rival = receipt.openStore(root, key, 'rival', { skipBusy: true });
            rivalBusy = rival.busy; rival.close();
          } finally { injecting = true; }
        }
        return result;
      };
      try {
        const owner = receipt.openStore(root, key, 'owner', { skipBusy: true, accountClaimFailure: true });
        assert.equal(owner.claimUnavailable, true); assert.equal(rivalBusy, true);
        owner.save(); owner.close();
        assert(!fs.existsSync(claim)); assert(!fs.existsSync(path.join(dir, 'lock')));
      } finally { fs.mkdirSync = mkdir; fs.openSync = open; fs.writeFileSync = write; }
      // Crash during marker writing leaves a prefix; after the finite lease a
      // normal directory claimant can recover it, but not an arbitrary file.
      fs.writeFileSync(claim, 'axmem-file-');
      const old = new Date(Date.now() - 60000); fs.utimesSync(claim, old, old);
      const recovered = receipt.openStore(root, key, 'recovered'); recovered.close();
      fs.writeFileSync(claim, 'not-an-axmem-claim'); fs.utimesSync(claim, old, old);
      assert.throws(() => receipt.openStore(root, key, 'unsafe'), /unsafe-lock/);
      fs.unlinkSync(claim);
    });
    await check('unwritable-file-claim-still-warns', async () => {
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
        assert.match(JSON.parse(stdout).systemMessage, /工作继续/);
        assert(!fs.existsSync(path.join(dir, 'state.json')));
      } finally { fs.mkdirSync = mkdir; fs.openSync = open; }
    });
    await check('normal-acquisition-adds-no-claim-io', async () => {
      const key = 'hot', claim = path.join(root, 'recall', key, 'lock.claim');
      const mkdir = fs.mkdirSync, stat = fs.lstatSync, open = fs.openSync;
      let mkdirs = 0, stats = 0, fileOpens = 0;
      fs.mkdirSync = (f, ...args) => { if (f === claim) mkdirs++; return mkdir(f, ...args); };
      fs.lstatSync = (f, ...args) => { if (f === claim) stats++; return stat(f, ...args); };
      fs.openSync = (f, ...args) => { if (f === claim) fileOpens++; return open(f, ...args); };
      try {
        const store = receipt.openStore(root, key, 'hot', { accountClaimFailure: true });
        assert.equal(store.claimUnavailable, false);
        assert.equal(mkdirs, 1); assert.equal(stats, 2); assert.equal(fileOpens, 0);
        store.close();
      } finally { fs.mkdirSync = mkdir; fs.lstatSync = stat; fs.openSync = open; }
    });
    console.log(`A1 R3 edge self-test ${passed}/5`);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
}
module.exports = { round3SelfTest };
if (require.main === module) round3SelfTest().catch((e) => { console.error(e); process.exitCode = 1; });
