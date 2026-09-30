#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const home = process.argv[2];
const dryRun = process.argv[3] === '--dry-run';
if (!home || !path.isAbsolute(home) || (process.argv[3] && !dryRun)) {
  process.stderr.write('usage: node uninstall-hooks.cjs <absolute-CODEX_HOME> [--dry-run]\n');
  process.exit(2);
}

const configFile = path.join(home, 'hooks.json');
const EVENTS = {
  UserPromptSubmit: 'prompt',
  PreCompact: 'precompact',
  SessionStart: 'sessionstart',
  Stop: 'stop',
};

function plainObject(value) {
  return !!value && !Array.isArray(value) && typeof value === 'object';
}

function normalizedScriptPath(value) {
  return String(value).replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`);
}

function parseRawCommand(command, expectedAction) {
  if (typeof command !== 'string') return null;
  const match = command.match(/^("[^"]+"|node(?:\.exe)?)\s+"([^"]+[\\/]+adapters[\\/]+codex[\\/]+raw-receipts\.cjs)"\s+([a-z]+)$/i);
  if (!match || match[3] !== expectedAction) return null;
  const exe = match[1];
  if (!(exe.toLowerCase() === 'node' || exe.toLowerCase() === 'node.exe' || /node(?:\.exe)?"$/i.test(exe))) return null;
  return { script: normalizedScriptPath(match[2]), action: match[3] };
}

function isAxMemGroup(group, expectedAction) {
  if (!plainObject(group) || Object.keys(group).length !== 1 || !Array.isArray(group.hooks) || group.hooks.length !== 1) return false;
  const hook = group.hooks[0];
  if (!plainObject(hook)) return false;
  const keys = Object.keys(hook).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['command', 'commandWindows', 'timeout', 'type'])) return false;
  if (hook.type !== 'command' || hook.timeout !== 10) return false;
  const a = parseRawCommand(hook.command, expectedAction);
  const b = parseRawCommand(hook.commandWindows, expectedAction);
  return !!a && !!b && a.script === b.script;
}

function validateConfig(config) {
  if (!plainObject(config)) throw new Error('hooks.json must be an object');
  if (config.hooks === undefined) return;
  if (!plainObject(config.hooks)) throw new Error('hooks must be an object');
  for (const event of Object.keys(EVENTS)) {
    if (config.hooks[event] !== undefined && !Array.isArray(config.hooks[event])) {
      throw new Error(`${event} must be an array`);
    }
  }
}

function findMatches(config) {
  const found = [];
  if (!plainObject(config.hooks)) return found;
  for (const [event, action] of Object.entries(EVENTS)) {
    const groups = config.hooks[event];
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, index) => {
      if (isAxMemGroup(group, action)) found.push({ event, index, group });
    });
  }
  return found;
}

function cleanedConfig(config) {
  const out = structuredClone(config);
  if (!plainObject(out.hooks)) return out;
  for (const [event, action] of Object.entries(EVENTS)) {
    if (!Array.isArray(out.hooks[event])) continue;
    out.hooks[event] = out.hooks[event].filter(group => !isAxMemGroup(group, action));
  }
  return out;
}

function projectBackup(backupConfig, currentMatches) {
  const out = structuredClone(backupConfig);
  validateConfig(out);
  if (out.hooks === undefined) out.hooks = {};
  for (const event of Object.keys(EVENTS)) {
    if (out.hooks[event] === undefined) out.hooks[event] = [];
  }
  for (const [event, action] of Object.entries(EVENTS)) {
    out.hooks[event] = out.hooks[event].filter(group => !isAxMemGroup(group, action));
    const groups = currentMatches.filter(match => match.event === event).map(match => structuredClone(match.group));
    out.hooks[event].push(...groups);
  }
  return out;
}

function findExactPreinstallBytes(currentConfig, currentMatches) {
  let names;
  try { names = fs.readdirSync(home); } catch { return null; }
  const candidates = names
    .filter(name => name.startsWith('hooks.json.before-axmem-') && !name.startsWith('hooks.json.before-axmem-uninstall-'))
    .sort()
    .reverse();
  for (const name of candidates) {
    const candidatePath = path.join(home, name);
    let bytes;
    let parsed;
    try {
      bytes = fs.readFileSync(candidatePath, 'utf8');
      parsed = JSON.parse(bytes);
      validateConfig(parsed);
      if (JSON.stringify(projectBackup(parsed, currentMatches)) === JSON.stringify(currentConfig)) {
        return { path: candidatePath, bytes };
      }
    } catch {
      // Ignore stale/corrupt backups; only a proved projection is eligible.
    }
  }
  return null;
}

function nextBackupPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${configFile}.before-axmem-uninstall-${stamp}`;
  let n = 1;
  while (fs.existsSync(candidate)) candidate = `${configFile}.before-axmem-uninstall-${stamp}-${n++}`;
  return candidate;
}

try {
  if (!fs.existsSync(configFile)) {
    process.stdout.write(`unchanged: ${configFile}; AxMem raw-capture hooks are not present\n`);
    process.exit(0);
  }

  const original = fs.readFileSync(configFile, 'utf8');
  let config;
  try { config = JSON.parse(original); }
  catch (error) { throw new Error(`invalid hooks.json JSON: ${error.message}`); }
  validateConfig(config);

  const matches = findMatches(config);
  if (matches.length === 0) {
    process.stdout.write(`unchanged: ${configFile}; AxMem raw-capture hooks are not present\n`);
    process.exit(0);
  }

  const exact = findExactPreinstallBytes(config, matches);
  const cleaned = cleanedConfig(config);
  const output = exact ? exact.bytes : JSON.stringify(cleaned, null, 2) + '\n';

  if (dryRun) {
    process.stdout.write(`would remove ${matches.length} AxMem raw-capture hook group(s) from ${configFile}; other hooks are retained${exact ? '; exact pre-install bytes are provably restorable' : ''}\n`);
    process.exit(0);
  }

  const backup = nextBackupPath();
  fs.writeFileSync(backup, original, { flag: 'wx' });
  const stage = `${configFile}.axmem-uninstall-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(stage, output, { flag: 'wx' });
    fs.renameSync(stage, configFile);
  } finally {
    if (fs.existsSync(stage)) fs.unlinkSync(stage);
  }
  process.stdout.write(`removed ${matches.length} AxMem raw-capture hook group(s): ${configFile}; backup: ${backup}${exact ? '; restored exact pre-install bytes' : ''}\n`);
} catch (error) {
  process.stderr.write(`refused: ${error.message}\n`);
  process.exitCode = 1;
}
