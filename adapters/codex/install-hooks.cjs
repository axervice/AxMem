#!/usr/bin/env node
// Merge AxMem command hooks into one explicit CODEX_HOME; never alter trust.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const home = process.argv[2];
const dryRun = process.argv[3] === '--dry-run';
if (!home || !path.isAbsolute(home) || (process.argv[3] && !dryRun)) {
  process.stderr.write('usage: node install-hooks.cjs <absolute-CODEX_HOME> [--dry-run]\n');
  process.exit(2);
}

const configFile = path.join(home, 'hooks.json');
const bridge = path.join(__dirname, 'raw-receipts.cjs');
const quotedNode = `"${process.execPath.replace(/"/g, '\\"')}"`;
const quotedBridge = `"${bridge.replace(/"/g, '\\"')}"`;
// Codex wraps the entire command in quotes for cmd.exe /C on Windows. A
// quoted executable path in the first position becomes a broken double quote.
// Resolve node.exe through the inherited PATH, which is also what invoked this
// installer; the script path remains absolute.
const windowsNode = 'node.exe';
const events = {
  UserPromptSubmit: 'prompt',
  PreCompact: 'precompact',
  SessionStart: 'sessionstart',
  Stop: 'stop',
};

try {
  const original = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  const config = original === null ? { hooks: {} } : JSON.parse(original);
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('hooks.json must be an object');
  if (config.hooks === undefined) config.hooks = {};
  if (!config.hooks || Array.isArray(config.hooks) || typeof config.hooks !== 'object') throw new Error('hooks must be an object');
  for (const [event, action] of Object.entries(events)) {
    if (config.hooks[event] === undefined) config.hooks[event] = [];
    if (!Array.isArray(config.hooks[event])) throw new Error(`${event} must be an array`);
    const command = `${quotedNode} ${quotedBridge} ${action}`;
    const commandWindows = `${windowsNode} ${quotedBridge} ${action}`;
    // Replace only the exact command emitted by the previous AxMem installer.
    // Other handlers, including handlers in the same event, are untouched.
    config.hooks[event] = config.hooks[event].filter(group =>
      !(Array.isArray(group.hooks) && group.hooks.length === 1 &&
        group.hooks[0].type === 'command' &&
        group.hooks[0].command === command &&
        group.hooks[0].commandWindows === command &&
        group.hooks[0].timeout === 10));
    const already = config.hooks[event].some(group =>
      Array.isArray(group.hooks) && group.hooks.some(hook => hook.type === 'command' && hook.command === command && hook.commandWindows === commandWindows));
    if (!already) config.hooks[event].push({ hooks: [{ type: 'command', command, commandWindows, timeout: 10 }] });
  }
  const output = JSON.stringify(config, null, 2) + '\n';
  if (original === output) {
    process.stdout.write(`unchanged: ${configFile}\n`);
    process.exit(0);
  }
  if (dryRun) {
    process.stdout.write(`would update: ${configFile}; existing hook groups are retained\n`);
    process.exit(0);
  }
  fs.mkdirSync(home, { recursive: true });
  if (original !== null) {
    const backup = `${configFile}.before-axmem-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, original, { flag: 'wx' });
  }
  const stage = `${configFile}.axmem-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(stage, output, { flag: 'wx' });
    fs.renameSync(stage, configFile);
  } finally { if (fs.existsSync(stage)) fs.unlinkSync(stage); }
  process.stdout.write(`updated: ${configFile}; review and trust these hook definitions in Codex /hooks\n`);
} catch (error) {
  process.stderr.write(`refused: ${error.message}\n`);
  process.exitCode = 1;
}
