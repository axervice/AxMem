#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const uninstall = path.resolve(__dirname, '..', 'adapters', 'codex', 'uninstall-hooks.cjs');
if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--self-test')) {
  process.stderr.write('usage: codex-uninstall-hooks.test.cjs [--self-test]\n');
  process.exit(2);
}
let passed = 0;
let total = 0;

function check(ok, name) {
  total += 1;
  if (!ok) {
    process.stderr.write(`not ok ${total} - ${name}\n`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  process.stdout.write(`ok ${total} - ${name}\n`);
}

function run(home, extra = []) {
  return cp.spawnSync(process.execPath, [uninstall, home, ...extra], { encoding: 'utf8' });
}

function rawGroup(action, bridge = 'C:/src/AxMem/adapters/codex/raw-receipts.cjs', previousWindowsForm = false) {
  const command = `"${process.execPath}" "${bridge}" ${action}`;
  const commandWindows = previousWindowsForm ? command : `node.exe "${bridge}" ${action}`;
  return { hooks: [{ type: 'command', command, commandWindows, timeout: 10 }] };
}

const events = {
  UserPromptSubmit: 'prompt',
  PreCompact: 'precompact',
  SessionStart: 'sessionstart',
  Stop: 'stop',
};

function rawCaptureCount(config) {
  let count = 0;
  for (const event of Object.keys(events)) {
    for (const group of config.hooks?.[event] || []) {
      if (group?.hooks?.some(hook => String(hook.command || '').includes('raw-receipts.cjs'))) count += 1;
    }
  }
  return count;
}

function installedConfig(base = { hooks: {} }, previousWindowsForm = false) {
  const config = structuredClone(base);
  if (config.hooks === undefined) config.hooks = {};
  for (const [event, action] of Object.entries(events)) {
    if (config.hooks[event] === undefined) config.hooks[event] = [];
    config.hooks[event].push(rawGroup(action, 'C:/src/AxMem/adapters/codex/raw-receipts.cjs', previousWindowsForm));
  }
  return config;
}

function installFixture(home, originalBytes) {
  const file = path.join(home, 'hooks.json');
  fs.writeFileSync(file, originalBytes);
  fs.writeFileSync(`${file}.before-axmem-2026-09-28T00-00-00-000Z`, originalBytes);
  const config = JSON.parse(originalBytes);
  if (config.hooks === undefined) config.hooks = {};
  for (const [event, action] of Object.entries(events)) {
    if (config.hooks[event] === undefined) config.hooks[event] = [];
    config.hooks[event].push(rawGroup(action));
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return fs.readFileSync(file, 'utf8');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-codex-uninstall-'));
try {
  {
    const home = path.join(root, 'exact');
    fs.mkdirSync(home);
    const original = `{
    "version": 1,
    "hooks": {
        "UserPromptSubmit": []
    }
}
`;
    const installed = installFixture(home, original);
    const res = run(home);
    check(res.status === 0, 'install -> uninstall exits 0');
    check(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8') === original, 'install -> uninstall restores hooks.json byte-for-byte');
    const backups = fs.readdirSync(home).filter(name => name.startsWith('hooks.json.before-axmem-uninstall-'));
    check(backups.length === 1 && fs.readFileSync(path.join(home, backups[0]), 'utf8') === installed, 'uninstall backup preserves the installed bytes');
  }

  {
    const home = path.join(root, 'preserve');
    fs.mkdirSync(home);
    const other = { matcher: 'x', hooks: [{ type: 'command', command: 'other-tool', commandWindows: 'other-tool', timeout: 99 }] };
    const config = {
      topLevel: { keep: true },
      hooks: {
        UserPromptSubmit: [other, rawGroup('prompt', 'D:/old/AxMem/adapters/codex/raw-receipts.cjs', true)],
        PreCompact: [rawGroup('precompact')],
        SessionStart: [rawGroup('sessionstart')],
        Stop: [rawGroup('stop')],
        CustomEvent: [{ hooks: [{ type: 'command', command: 'custom', commandWindows: 'custom', timeout: 10 }] }],
      },
    };
    fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify(config, null, 2) + '\n');
    const res = run(home);
    const after = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'));
    check(res.status === 0, 'selective uninstall exits 0');
    check(after.topLevel.keep === true && after.hooks.UserPromptSubmit.length === 1 && after.hooks.UserPromptSubmit[0].matcher === 'x' && after.hooks.CustomEvent[0].hooks[0].command === 'custom', 'selective uninstall preserves non-AxMem hooks and top-level data');
    check(Object.entries(events).every(([event]) => !after.hooks[event].some(group => Array.isArray(group.hooks) && group.hooks.some(h => String(h.command || '').includes('raw-receipts.cjs')))), 'selective uninstall removes only AxMem raw-capture groups');
  }

  {
    const home = path.join(root, 'preserve');
    const file = path.join(home, 'hooks.json');
    const before = fs.readFileSync(file, 'utf8');
    const backupCount = fs.readdirSync(home).filter(name => name.startsWith('hooks.json.before-axmem-uninstall-')).length;
    const res = run(home);
    check(res.status === 0 && /not present/.test(res.stdout), 'second uninstall is idempotent and explains no-op');
    check(fs.readFileSync(file, 'utf8') === before && fs.readdirSync(home).filter(name => name.startsWith('hooks.json.before-axmem-uninstall-')).length === backupCount, 'idempotent uninstall writes neither hooks.json nor a new backup');
  }

  {
    const home = path.join(root, 'invalid');
    fs.mkdirSync(home);
    const file = path.join(home, 'hooks.json');
    const bad = '{"hooks": ';
    fs.writeFileSync(file, bad);
    const res = run(home);
    check(res.status !== 0 && /invalid hooks\.json JSON/.test(res.stderr), 'invalid JSON is refused');
    check(fs.readFileSync(file, 'utf8') === bad && !fs.readdirSync(home).some(name => name.startsWith('hooks.json.before-axmem-uninstall-')), 'invalid JSON remains byte-identical and produces no backup');
  }

  {
    const home = path.join(root, 'dry');
    fs.mkdirSync(home);
    const config = { hooks: { UserPromptSubmit: [rawGroup('prompt')] } };
    const file = path.join(home, 'hooks.json');
    const before = JSON.stringify(config, null, 2) + '\n';
    fs.writeFileSync(file, before);
    const res = run(home, ['--dry-run']);
    check(res.status === 0 && /would remove 1/.test(res.stdout), '--dry-run reports the AxMem removal');
    check(fs.readFileSync(file, 'utf8') === before && !fs.readdirSync(home).some(name => name.startsWith('hooks.json.before-axmem-uninstall-')), '--dry-run writes neither hooks.json nor backup');
  }

  {
    const home = path.join(root, 'newer-dirty-backup');
    fs.mkdirSync(home);
    const file = path.join(home, 'hooks.json');
    const cleanBytes = '{\r\n  "hooks": {}\r\n}\r\n';
    const installed = installedConfig({ hooks: {} }, true);
    fs.writeFileSync(file, JSON.stringify(installed, null, 2) + '\n');
    fs.writeFileSync(path.join(home, 'hooks.json.before-axmem-2026-09-28T20-00-00-000Z'), cleanBytes);
    fs.writeFileSync(path.join(home, 'hooks.json.before-axmem-2026-09-28T20-42-43-000Z'), JSON.stringify(installed, null, 2) + '\n');
    const first = run(home);
    const restored = fs.readFileSync(file, 'utf8');
    const second = run(home);
    check(first.status === 0 && restored === cleanBytes && rawCaptureCount(JSON.parse(restored)) === 0, 'newer AxMem-containing backup is skipped in favor of older clean backup and exact clean bytes are restored');
    check(second.status === 0 && /not present/.test(second.stdout) && fs.readFileSync(file, 'utf8') === cleanBytes, 'clean-backup restoration is idempotent on second uninstall');
  }

  {
    const home = path.join(root, 'only-dirty-backup');
    fs.mkdirSync(home);
    const file = path.join(home, 'hooks.json');
    const installed = installedConfig({ hooks: {} }, true);
    fs.writeFileSync(file, JSON.stringify(installed, null, 2) + '\n');
    fs.writeFileSync(path.join(home, 'hooks.json.before-axmem-2026-09-28T20-42-43-000Z'), JSON.stringify(installed, null, 2) + '\n');
    const first = run(home);
    const afterFirst = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(afterFirst);
    const second = run(home);
    check(first.status === 0 && rawCaptureCount(parsed) === 0 && !/restored exact pre-install bytes/.test(first.stdout), 'AxMem-only backup set falls back to JSON cleanup and removes all raw-receipts groups');
    check(second.status === 0 && /not present/.test(second.stdout) && fs.readFileSync(file, 'utf8') === afterFirst, 'JSON-cleanup fallback is idempotent on second uninstall');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`codex uninstall hooks self-test ${passed}/${total}\n`);
if (passed !== total) process.exitCode = 1;
