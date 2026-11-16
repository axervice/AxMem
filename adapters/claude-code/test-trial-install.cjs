#!/usr/bin/env node
'use strict';
// All fixtures, fake roots, mutation copies, crash probes and child HOMEs are
// beneath one mkdtemp. Prelude probes run ONLY in isolated children with an
// explicit temporary config; never reads a user's configuration.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildWant, countIdentityMatches } = require('./merge-hooks.cjs');
const tool = path.join(__dirname, 'trial-install.cjs');
const source = fs.readFileSync(tool, 'utf8');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-trial-test-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cp = (v) => JSON.parse(JSON.stringify(v));
const command = (s) => ({ type: 'command', command: s });
const pmm = (s) => command(`bash "C:/synthetic-pmm/.claude/${s}"`);
const group = (hooks, matcher) => matcher ? { matcher, hooks } : { hooks };
function fixture() {
  return {
    permissions: { allow: ['Bash(node *)'], deny: [] }, unrelated: ['do not reorder', { z: 1, a: 2 }],
    hooks: {
      SessionStart: [
        { hooks: [pmm('pmm-session-start.sh'), pmm('pmm-permanent-inject.sh'), pmm('pmm-banner.sh')], note: 'keep metadata/key order' },
        group(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => pmm(`pmm-session-${n}.sh`))),
      ],
      UserPromptSubmit: [group([pmm('pmm-prompt-pull.sh')]), group([pmm('pmm-banner.sh')])],
      PreToolUse: [
        group([pmm('pmm-agent-workflow.sh')], 'Agent|Workflow'), group([pmm('pmm-agent.sh')], 'Agent'),
        group([pmm('pmm-edit.sh')], 'Edit|Write|MultiEdit'),
        { hooks: [command('node "C:/synthetic-pmm/.claude/pmm-hook.cjs" --shadow --pre')], matcher: 'Edit|Write|MultiEdit', timeout: 9 },
        ...['a', 'b', 'c'].map((n) => group([pmm(`pmm-bash-${n}.sh`)], 'Bash')),
      ],
      PostToolUse: [group([pmm('pmm-trigger-recall.sh'), pmm('pmm-write-gate.sh')], 'Edit|Write|MultiEdit'), group([pmm('pmm-receipt.sh from-hook')], 'AskUserQuestion')],
      Stop: [group([pmm('pmm-receipt.sh stop-check')])],
    }, tail: 'last key',
  };
}
let seq = 0;
function context(candidate) {
  const dir = path.join(T, 'case-' + ++seq);
  fs.mkdirSync(dir);
  const root = path.join(dir, 'fake root');
  fs.mkdirSync(path.join(root, 'adapters/claude-code'), { recursive: true });
  fs.writeFileSync(path.join(root, 'adapters/claude-code/hook.cjs'), '// never executed\n');
  const settings = path.join(dir, 'settings.json');
  const record = path.join(dir, 'install-record.json');
  const config = path.join(dir, 'trial config.json'); fs.writeFileSync(config, '{}');
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), '{}');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PMM_HOME: home,
    AXMEM_HOME: home, AXMEM_CONFIG: path.join(home, 'config.json'),
    AXMEM_STATE_DIR: path.join(home, 'state'), AXMEM_MEMORY_DIR: path.join(home, 'memory'), NODE_OPTIONS: '' };
  const bareWant = buildWant(root.replace(/\\/g, '/')).slice(5);
  const c = { dir, root, settings, record, config, bareWant,
    want: bareWant.map((w) => ({ ...w, command: `AXMEM_CONFIG="${config.replace(/\\/g, '/')}" ${w.command}` })) };
  c.runtime = (overrides = {}) => {
    const cleanEnv = { ...env };
    for (const key of Object.keys(cleanEnv)) if (/^AXMEM_/i.test(key)) delete cleanEnv[key];
    const r = spawnSync(process.execPath, ['-e', `const c=require(process.argv[1]); console.log(JSON.stringify({config:c.AXMEM_CONFIG,env:Object.keys(process.env).filter(k=>/^AXMEM_/i.test(k)).sort(),...c.resolveRuntimeConfig()}));`, path.resolve(__dirname, '../../lib/prelude.cjs')],
      { env: { ...cleanEnv, AXMEM_CONFIG: config, ...overrides }, cwd: dir, encoding: 'utf8', timeout: 10000 });
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  c.set = (s = fixture()) => { fs.writeFileSync(settings, JSON.stringify(s, null, '\t').replace(/\n/g, '\r\n') + '\r\n'); return fs.readFileSync(settings); };
  c.args = (mode) => ['--settings', settings, '--root', root, '--config', config, '--record', record, ...(mode ? ['--' + mode] : [])];
  c.runArgs = (args, preload) => {
    const r = spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), candidate, ...args], { env, cwd: dir, encoding: 'utf8', timeout: 10000 });
    assert.ifError(r.error);
    assert.equal(r.signal, null);
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  c.run = (mode) => c.runArgs(c.args(mode));
  c.ok = (mode) => { const r = c.run(mode); assert.equal(r.code, 0, r.err); return r; };
  c.set();
  return c;
}
function snapshot(dir) {
  const result = {};
  function visit(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n), s = fs.statSync(f), rel = path.relative(dir, f);
      if (s.isDirectory()) { result[rel + '/'] = 'directory'; visit(f); }
      else result[rel] = [fs.readFileSync(f).toString('hex'), s.mtimeMs];
    }
  }
  visit(dir); return result;
}
function checkCounts(c, count) {
  const s = json(c.settings);
  for (const w of c.want) assert.equal(countIdentityMatches(s, { event: w.event, matcher: w.matcher, normalized_command: w.command }), count);
}
function total(s) { return Object.values(s.hooks || {}).reduce((n, gs) => n + gs.reduce((v, g) => v + g.hooks.length, 0), 0); }
function expectedApply(s, want) {
  const expected = cp(s);
  expected.hooks.SessionStart.push(group([command(want[0].command)]));
  expected.hooks.UserPromptSubmit.push(group([command(want[1].command)]));
  expected.hooks.PreToolUse.push(group([command(want[2].command)], want[2].matcher));
  return expected;
}
function crashProbe(c) {
  const file = path.join(c.dir, 'crash.cjs');
  fs.writeFileSync(file, `const fs = require('node:fs'); const rename = fs.renameSync;
fs.renameSync = function(a,b) {
  if (b === ${JSON.stringify(c.settings)}) {
    const r = JSON.parse(fs.readFileSync(${JSON.stringify(c.record)}, 'utf8'));
    if (!fs.readFileSync(r.backup).equals(fs.readFileSync(b))) throw new Error('backup not first');
    throw new Error('injected-before-settings-publish');
  }
  return rename.apply(this, arguments);
};\n`);
  return file;
}
const cases = [
  {
    name: 'config-command-exact-identity-and-config-only-runtime',
    mutate: ['return want.map((w) => ({ ...w, command: `AXMEM_CONFIG="${config}" ${w.command}` })); // config-command-guard', 'return want; // removed config command prefix'],
    test(c) {
      const norm = (p) => p.replace(/\\/g, '/');
      const memory = path.join(c.dir, 'memory source'), state = path.join(c.dir, 'state target');
      fs.writeFileSync(c.config, JSON.stringify({ memory_dir: norm(memory), state_dir: norm(state),
        adapters: { claude_code: { enabled: true, recall: { kernel_sender: 'external' } } } }));
      let before = snapshot(c.dir);
      const runtime = c.runtime();
      assert.deepEqual(runtime.env, ['AXMEM_CONFIG'], 'no other AXMEM_* is needed');
      assert.equal(runtime.config, norm(c.config));
      assert.equal(runtime.memoryRoot, norm(memory)); assert.equal(runtime.stateRoot, norm(state));
      assert.equal(runtime.enabled, true); assert.equal(runtime.options.kernel_sender, 'external');
      const overrideMemory = path.join(c.dir, 'override memory'), overrideState = path.join(c.dir, 'override state');
      const overridden = c.runtime({ AXMEM_MEMORY_DIR: overrideMemory, AXMEM_STATE_DIR: overrideState });
      assert.equal(overridden.memoryRoot, norm(overrideMemory)); assert.equal(overridden.stateRoot, norm(overrideState));
      assert.deepEqual(snapshot(c.dir), before, 'runtime resolution is read-only');
      const initial = json(c.settings);
      // Bare commands and another config with the SAME hook path are NOT ours.
      for (const w of c.bareWant) initial.hooks[w.event].push(group([
        command(w.command), command(`AXMEM_CONFIG="${norm(path.join(c.dir, 'other config.json'))}" ${w.command}`),
      ], w.matcher));
      c.set(initial); before = snapshot(c.dir);
      const dry = c.ok('dry-run');
      assert.deepEqual(dry.out.trim().split('\n').slice(1).map((s) => JSON.parse(s)),
        c.want.map((w) => ({ event: w.event, matcher: w.matcher, normalized_command: w.command })));
      assert.deepEqual(snapshot(c.dir), before);
      c.ok('apply'); checkCounts(c, 1);
      assert.equal(JSON.stringify(json(c.settings)), JSON.stringify(expectedApply(initial, c.want)));
      const record = json(c.record);
      assert.equal(record.config, norm(c.config));
      assert.deepEqual(record.added, c.want.map((w) => ({ event: w.event, matcher: w.matcher, normalized_command: w.command })));
      assert.ok(c.ok('status').out.includes('command: ' + c.want[0].command));
      const edit = json(c.settings); edit.keepEdit = true; c.set(edit);
      assert.match(c.ok('rollback').out, /identity-only/); checkCounts(c, 0);
      assert.equal(JSON.stringify(json(c.settings)), JSON.stringify({ ...initial, keepEdit: true }), 'bare/other-config identities must survive');
    },
  },
  {
    name: 'config-required-all-modes-zero-writes',
    mutate: ['!out.config || ', ''],
    test(c) {
      const before = snapshot(c.dir);
      for (const m of ['dry-run', 'apply', 'rollback', 'status']) {
        const a = c.args(m); a.splice(a.indexOf('--config'), 2);
        const r = c.runArgs(a); assert.notEqual(r.code, 0); assert.match(r.err, /required:.*--config/);
        assert.deepEqual(snapshot(c.dir), before);
      }
      for (const tail of [['--config'], ['--config', c.config]]) {
        assert.notEqual(c.runArgs([...c.args('apply'), ...tail]).code, 0); assert.deepEqual(snapshot(c.dir), before);
      }
    },
  },
  {
    name: 'relative-config-refused-all-modes-zero-writes',
    mutate: ["if (!path.isAbsolute(out.config)) throw new Error('config must be an absolute path'); // config-absolute-guard", '// removed absolute config guard'],
    test(c) {
      const before = snapshot(c.dir);
      for (const m of ['dry-run', 'apply', 'rollback', 'status']) {
        const a = c.args(m); a[a.indexOf('--config') + 1] = path.basename(c.config); // EXISTS relative to child cwd
        const r = c.runArgs(a); assert.notEqual(r.code, 0); assert.match(r.err, /config must be an absolute path/);
        assert.deepEqual(snapshot(c.dir), before);
      }
    },
  },
  {
    name: 'missing-or-directory-config-refused-all-modes-zero-writes',
    mutate: ["if (!fs.statSync(out.config).isFile()) throw new Error('config must be an existing file'); // config-file-guard", '// removed config file guard'],
    test(c) {
      const before = snapshot(c.dir);
      for (const value of [path.join(c.dir, 'missing config.json'), c.dir]) {
        for (const m of ['dry-run', 'apply', 'rollback', 'status']) {
          const a = c.args(m); a[a.indexOf('--config') + 1] = value;
          assert.notEqual(c.runArgs(a).code, 0); assert.deepEqual(snapshot(c.dir), before);
        }
      }
    },
  },
  {
    name: 'unsafe-config-quote-dollar-backtick-newline-refused-all-modes',
    mutate: ['if (/["$`%!\\u0000-\\u001f\\u007f]/.test(out.config))', 'if (false)'],
    test(c) {
      // These two names are legal on Windows too: removing the guard must not
      // merely trade the intended rejection for ENOENT on an impossible name.
      for (const ch of ['$', '`']) fs.writeFileSync(path.join(c.dir, 'unsafe' + ch + 'config.json'), '{}');
      const before = snapshot(c.dir);
      for (const ch of ['$', '`', '"', '\n', '\r']) {
        for (const m of ['dry-run', 'apply', 'rollback', 'status']) {
          const a = c.args(m); a[a.indexOf('--config') + 1] = path.join(c.dir, 'unsafe' + ch + 'config.json');
          const r = c.runArgs(a); assert.notEqual(r.code, 0); assert.match(r.err, /config must be a shell-safe path/);
          assert.deepEqual(snapshot(c.dir), before);
        }
      }
    },
  },
  {
    name: 'record-bound-to-original-config-all-modes-zero-writes',
    mutate: [' || record.config !== opt.config', ''],
    test(c) {
      c.ok('apply'); const record = json(c.record);
      record.config = path.join(c.dir, 'another config.json').replace(/\\/g, '/');
      fs.writeFileSync(c.record, JSON.stringify(record)); const before = snapshot(c.dir);
      for (const m of ['dry-run', 'apply', 'rollback', 'status']) {
        const r = c.run(m); assert.notEqual(r.code, 0); assert.match(r.err, /original root\/config\/settings\/record/);
        assert.deepEqual(snapshot(c.dir), before);
      }
    },
  },
  {
    name: 'config-cannot-be-settings-or-record-zero-writes',
    mutate: ['out.settings === configPath || out.record === configPath || ', ''],
    test(c) {
      const before = snapshot(c.dir);
      for (const flag of ['--settings', '--record']) {
        for (const m of ['dry-run', 'apply', 'rollback', 'status']) {
          const a = c.args(m); a[a.indexOf(flag) + 1] = c.config;
          const r = c.runArgs(a); assert.notEqual(r.code, 0); assert.match(r.err, /path conflicts with input/);
          assert.deepEqual(snapshot(c.dir), before);
        }
      }
    },
  },
  {
    name: 'dry-run-zero-writes',
    mutate: ["if (opt.mode === 'dry-run') { // dry-run-guard", "if (false) { // removed dry-run guard"],
    test(c) { const before = snapshot(c.dir); const r = c.ok('dry-run'); assert.match(r.out, /would add 3/); assert.deepEqual(snapshot(c.dir), before); },
  },
  {
    name: 'apply-only-three-preserves-all-pmm-order-and-content',
    mutate: ['const want = buildWant(root).slice(5); // phase-1-only', 'const want = buildWant(root); // removed phase-1-only guard'],
    test(c) {
      const before = json(c.settings), raw = fs.readFileSync(c.settings);
      // A same command under a DIFFERENT matcher is not our identity.
      before.hooks.PreToolUse[1].hooks.push(command(c.want[2].command)); c.set(before);
      const original = fs.readFileSync(c.settings);
      c.ok('apply'); const after = json(c.settings);
      assert.equal(total(after) - total(before), 3);
      assert.equal(JSON.stringify(after), JSON.stringify(expectedApply(before, c.want)), 'all unrelated values, key order and array order must survive');
      checkCounts(c, 1);
      const rec = json(c.record);
      assert.equal(rec.added.length, 3);
      assert.equal(rec.backup_sha256, sha(original));
      assert.equal(rec.applied_sha256, sha(fs.readFileSync(c.settings)));
      assert.ok(fs.readFileSync(rec.backup).equals(original));
      assert.ok(path.basename(rec.backup).match(/\.axmem-trial-backup-\d{4}-\d\d-\d\dT/));
      assert.equal(path.dirname(rec.backup), c.dir);
      assert.notEqual(sha(raw), rec.backup_sha256);
    },
  },
  {
    name: 'second-apply-is-byte-and-mtime-noop',
    mutate: ['if (matches(next, w) > 0) continue; // identity-guard', '// removed identity guard'],
    test(c) { c.ok('apply'); const before = snapshot(c.dir); assert.match(c.ok('apply').out, /no-op/); assert.deepEqual(snapshot(c.dir), before); },
  },
  {
    name: 'unchanged-rollback-restores-original-sha-and-bytes',
    mutate: ["branch = 'exact-restore (backup bytes restored)'; target = b.bytes;", "branch = 'exact-restore (backup bytes restored)'; target = Buffer.from(encode(before));"],
    test(c) { const raw = fs.readFileSync(c.settings); c.ok('apply'); assert.match(c.ok('rollback').out, /exact-restore/); assert.equal(sha(fs.readFileSync(c.settings)), sha(raw)); assert.ok(fs.readFileSync(c.settings).equals(raw)); checkCounts(c, 0); const s = snapshot(c.dir); c.ok('rollback'); assert.deepEqual(snapshot(c.dir), s); },
  },
  {
    name: 'edited-rollback-removes-identities-keeps-others',
    mutate: ['if (JSON.stringify(settings) === JSON.stringify(p.next)) { // restore-guard', 'if (true) { // removed no-other-edits guard'],
    test(c) {
      const before = json(c.settings); c.ok('apply');
      const edited = json(c.settings); edited.otherPersonsEdit = { z: true, a: 7 };
      edited.hooks.SessionStart[1].hooks.unshift(command('echo another owner'));
      edited.hooks.PreToolUse.at(-1).timeout = 11;
      edited.hooks.PreToolUse.at(-1).hooks.push(command('echo keep same matcher'));
      edited.hooks.PreToolUse[1].hooks.push(command(c.want[2].command));
      c.set(edited); assert.match(c.ok('rollback').out, /identity-only/);
      const expected = cp(before); expected.otherPersonsEdit = edited.otherPersonsEdit;
      expected.hooks.SessionStart[1].hooks.unshift(command('echo another owner'));
      expected.hooks.PreToolUse.push({ matcher: c.want[2].matcher, hooks: [command('echo keep same matcher')], timeout: 11 });
      expected.hooks.PreToolUse[1].hooks.push(command(c.want[2].command));
      assert.equal(JSON.stringify(json(c.settings)), JSON.stringify(expected)); checkCounts(c, 0);
    },
  },
  {
    name: 'bad-json-refused-with-zero-changes-all-modes',
    mutate: ["const s = JSON.parse(raw.toString('utf8')); // json-guard", "const s = (() => { try { return JSON.parse(raw.toString('utf8')); } catch { return {}; } })(); // removed JSON guard"],
    test(c) { fs.writeFileSync(c.settings, '{ broken JSON\r\n'); const before = snapshot(c.dir); for (const m of ['dry-run', 'apply', 'rollback', 'status']) { assert.notEqual(c.run(m).code, 0); assert.deepEqual(snapshot(c.dir), before); } },
  },
  {
    name: 'bad-root-refused-with-zero-changes-all-modes',
    mutate: ["if (!fs.statSync(path.join(out.root, 'adapters/claude-code/hook.cjs')).isFile()) throw new Error('root has no hook.cjs'); // root-guard", '// removed hook existence guard'],
    test(c) {
      const empty = path.join(c.dir, 'empty-root'); fs.mkdirSync(empty); const before = snapshot(c.dir);
      for (const m of ['dry-run', 'apply', 'rollback', 'status']) { const a = c.args(m); a[a.indexOf('--root') + 1] = empty; assert.notEqual(c.runArgs(a).code, 0); assert.deepEqual(snapshot(c.dir), before); }
    },
  },
  {
    name: 'missing-arguments-and-conflicting-modes-refused',
    mutate: ['if (!out.settings || !out.root || !out.config || !out.mode)', 'if (!out.settings || !out.root || !out.config)'],
    test(c) {
      const before = snapshot(c.dir);
      for (const a of [c.args(null), ['--settings', c.settings, '--config', c.config, '--apply'], ['--root', c.root, '--config', c.config, '--apply'], ['--settings'], [...c.args('apply'), '--status'], [...c.args('apply'), '--bogus']]) {
        assert.notEqual(c.runArgs(a).code, 0); assert.deepEqual(snapshot(c.dir), before);
      }
    },
  },
  {
    name: 'normalized-identity-found-in-later-same-matcher-group',
    mutate: ['if (matches(next, w) > 0) continue; // identity-guard', "if (matches({ hooks: { [w.event]: (next.hooks?.[w.event] || []).slice(0, 1) } }, w) > 0) continue; // first group only"],
    test(c) {
      const s = json(c.settings);
      for (const w of c.want) s.hooks[w.event].push(group([command(' \t' + w.command + '  ')], w.matcher));
      c.set(s); const before = snapshot(c.dir); c.ok('apply'); checkCounts(c, 1); assert.deepEqual(snapshot(c.dir), before);
    },
  },
  {
    name: 'edited-rollback-cleans-only-created-empty-containers',
    mutate: ['if (candidates.length === 1) groups.splice(groups.indexOf(candidates[0]), 1); // cleanup-guard', '// removed created-group cleanup guard'],
    test(c) {
      for (const initial of [{ x: 1 }, { x: 1, hooks: {} }, { x: 1, hooks: { SessionStart: [], PreToolUse: [group([], 'Bash')], Stop: [] } }]) {
        // Fresh install cycle; rolled-back record can be replaced on next apply.
        c.set(initial); c.ok('apply'); const edited = json(c.settings); edited.userEdit = 'keep'; c.set(edited);
        assert.match(c.ok('rollback').out, /identity-only/);
        assert.equal(JSON.stringify(json(c.settings)), JSON.stringify({ ...initial, userEdit: 'keep' }));
      }
    },
  },
  {
    name: 'rollback-keeps-new-empty-group-before-moved-created-group',
    mutate: ['const candidates = ownedEmpty.length ? ownedEmpty : empty;', 'const candidates = empty; // removed touched-group ownership guard'],
    test(c) {
      const initial = json(c.settings); c.ok('apply'); const edited = json(c.settings);
      const own = edited.hooks.PreToolUse.pop();
      edited.hooks.PreToolUse.push({ hooks: own.hooks, matcher: own.matcher });
      edited.hooks.PreToolUse.unshift(group([], c.want[2].matcher));
      c.set(edited); c.ok('rollback');
      initial.hooks.PreToolUse.unshift(group([], c.want[2].matcher));
      assert.equal(JSON.stringify(json(c.settings)), JSON.stringify(initial));
    },
  },
  {
    name: 'rollback-does-not-own-preexisting-phase1-entry',
    mutate: ['const removed = removeOwned(settings, owned, p);', 'const removed = removeOwned(settings, want, p); // removed ownership restriction'],
    test(c) {
      const initial = json(c.settings); initial.hooks.SessionStart[1].hooks.push(command(' ' + c.want[0].command + ' ')); c.set(initial);
      c.ok('apply'); assert.equal(json(c.record).added.length, 2);
      const edit = json(c.settings); edit.userEdit = true; c.set(edit); c.ok('rollback');
      assert.equal(JSON.stringify(json(c.settings)), JSON.stringify({ ...initial, userEdit: true }));
      assert.match(c.ok('status').out, /1\/3 present/);
    },
  },
  {
    name: 'backup-sha-mismatch-reported-and-rollback-refused',
    mutate: ["if (!b.exists || !b.shaMatches) throw new Error('backup missing or SHA256 mismatch; rollback refused'); // backup-guard", "if (!b.exists) throw new Error('backup missing'); // removed SHA guard"],
    test(c) {
      c.ok('apply'); fs.appendFileSync(json(c.record).backup, ' ');
      const before = snapshot(c.dir); assert.match(c.ok('status').out, /exists=true; sha256_matches=false/);
      assert.notEqual(c.run('rollback').code, 0); assert.deepEqual(snapshot(c.dir), before);
    },
  },
  {
    name: 'atomic-publish-crash-keeps-original-and-recoverable-record',
    mutate: ['writeFileAtomicSync(opt.settings, nextRaw, { mode: fs.statSync(opt.settings).mode }); // atomic-publish', 'fs.writeFileSync(opt.settings, nextRaw); // removed atomic publish'],
    test(c) {
      const original = fs.readFileSync(c.settings), preload = crashProbe(c);
      const r = c.runArgs(c.args('apply'), preload); assert.notEqual(r.code, 0); assert.match(r.err, /injected-before-settings-publish/);
      assert.ok(fs.readFileSync(c.settings).equals(original));
      const rec = json(c.record); assert.ok(fs.readFileSync(rec.backup).equals(original));
      assert.equal(fs.readdirSync(c.dir).filter((f) => f.includes('.axmem-staging-')).length, 0);
      c.ok('rollback'); assert.ok(fs.readFileSync(c.settings).equals(original));
    },
  },
  {
    name: 'status-count-backup-sha-and-readonly',
    mutate: ["}/3 present; counts=", "}/8 present; counts="],
    test(c) {
      let before = snapshot(c.dir); let r = c.ok('status'); assert.match(r.out, /0\/3 present; counts=0,0,0/); assert.match(r.out, /exists=false; sha256_matches=n\/a/); assert.deepEqual(snapshot(c.dir), before);
      c.ok('apply'); before = snapshot(c.dir); r = c.ok('status'); assert.match(r.out, /3\/3 present; counts=1,1,1/); assert.match(r.out, /exists=true; sha256_matches=true/); assert.deepEqual(snapshot(c.dir), before);
      fs.unlinkSync(json(c.record).backup); before = snapshot(c.dir); assert.match(c.ok('status').out, /exists=false; sha256_matches=false/); assert.deepEqual(snapshot(c.dir), before);
    },
  },
  {
    name: 'record-persisted-before-settings-publish',
    mutate: ["writeFileAtomicSync(opt.record, encode(nextRecord), { mode: 0o600 }); // journal-before-publish", '// removed journal-before-publish guard'],
    test(c) {
      const raw = fs.readFileSync(c.settings), preload = crashProbe(c);
      const r = c.runArgs(c.args('apply'), preload); assert.notEqual(r.code, 0);
      assert.ok(fs.existsSync(c.record), 'recoverable install record must precede settings publish');
      const rec = json(c.record); assert.equal(rec.backup_sha256, sha(raw)); assert.ok(fs.readFileSync(rec.backup).equals(raw));
      assert.match(r.err, /injected-before-settings-publish/);
    },
  },
];
function mutantFile(testCase, index) {
  const [from, to] = testCase.mutate;
  assert.equal(source.split(from).length, 2, 'mutation must match exactly one guard: ' + testCase.name);
  const mutated = source.replace(from, to)
    .replace("require('./merge-hooks.cjs')", `require(${JSON.stringify(path.join(__dirname, 'merge-hooks.cjs'))})`)
    .replace("require('../../lib/atomic-write.cjs')", `require(${JSON.stringify(path.resolve(__dirname, '../../lib/atomic-write.cjs'))})`);
  const f = path.join(T, 'mutant-' + index + '.cjs'); fs.writeFileSync(f, mutated); return f;
}
let green = 0, red = 0;
try {
  for (const [i, t] of cases.entries()) {
    try { t.test(context(tool)); green++; console.log('  ok   ' + t.name); }
    catch (e) { console.error('  FAIL ' + t.name + '\n' + e.stack); }
    try {
      let caught;
      try { t.test(context(mutantFile(t, i))); } catch (e) { caught = e; }
      assert.ok(caught instanceof assert.AssertionError, 'mutant must fail a real assertion, not a harness/require error');
      red++; console.log('  EXPECTED-RED guard removed: ' + t.name + ' [' + caught.message.split('\n')[0] + ']');
    } catch (e) { console.error('  FAIL mutation ' + t.name + '\n' + e.stack); }
  }
  console.log(`trial-install self-test ${green}/${cases.length}; guard-removal red evidence ${red}/${cases.length}`);
  if (green !== cases.length || red !== cases.length) process.exitCode = 1;
} finally { fs.rmSync(T, { recursive: true, force: true }); }
