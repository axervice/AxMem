#!/usr/bin/env node
// AxMem lifecycle upgrade. (P1 2.3, 2026-09-16)
// Re-runs idempotent wiring for every adapter already present in the
// lifecycle manifest, backing up the memory dir first (migrate --backup).
// Never wires an adapter that was never installed — upgrade only refreshes
// what's already there.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lm = require('./install-manifest.cjs');
const backup = require('./backup.cjs');

const ROOT = path.resolve(__dirname, '..');

function rewireCommand(adapterName, targetPath) {
  switch (adapterName) {
    case 'claude_code':
      return { cmd: 'node', args: [path.join(ROOT, 'adapters', 'claude-code', 'merge-hooks.cjs'), '--settings', targetPath] };
    case 'hermes':
      return { cmd: 'node', args: [path.join(ROOT, 'adapters', 'hermes', 'wire.cjs'), '--config', targetPath] };
    case 'codex':
      return { cmd: 'bash', args: [path.join(ROOT, 'adapters', 'codex', 'wire.sh'), targetPath] };
    case 'generic':
      return { cmd: 'bash', args: [path.join(ROOT, 'adapters', 'generic', 'wire.sh'), targetPath] };
    default:
      return null;
  }
}

// Returns { ok, backupPath, results: [{adapter, ok, output}] }
function upgradeAll({ stateDir, memoryDir, dryRun = false } = {}) {
  let manifest;
  try {
    manifest = lm.readManifest(stateDir);
  } catch (e) {
    // [ts M5] A corrupt manifest must never look like "nothing installed,
    // nothing to upgrade" (manifestCorrupt distinguishes this from the
    // genuine empty-manifest early-return two lines below, so the CLI can
    // exit 3 instead of the generic per-adapter-failure exit 1).
    if (e instanceof lm.ManifestCorruptError) return { ok: false, manifestCorrupt: true, backupPath: null, results: [], reason: e.message };
    throw e;
  }
  const adapterNames = Object.keys(manifest.adapters);
  if (adapterNames.length === 0) {
    return { ok: true, backupPath: null, results: [], note: 'no adapters installed — nothing to upgrade' };
  }

  let backupPath = null;
  if (!dryRun) {
    backupPath = path.join(stateDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar`);
    backup.createBackup(memoryDir, backupPath);
  }

  const results = [];
  for (const name of adapterNames) {
    const entry = manifest.adapters[name];
    const targetPath = entry.targets[0] && entry.targets[0].path;
    if (!targetPath) { results.push({ adapter: name, ok: false, output: 'no target path recorded' }); continue; }
    const rc = rewireCommand(name, targetPath);
    if (!rc) { results.push({ adapter: name, ok: false, output: `unknown adapter kind "${name}"` }); continue; }
    if (dryRun) { results.push({ adapter: name, ok: true, output: `would run: ${rc.cmd} ${rc.args.join(' ')}` }); continue; }
    try {
      const out = execFileSync(rc.cmd, rc.args, { encoding: 'utf8', env: { ...process.env, AXMEM_STATE_DIR: stateDir, AXMEM_MEMORY_DIR: memoryDir } });
      results.push({ adapter: name, ok: true, output: out.trim() });
    } catch (e) {
      results.push({ adapter: name, ok: false, output: (e.stderr ? e.stderr.toString() : e.message).trim() });
    }
  }

  return { ok: results.every((r) => r.ok), backupPath, results };
}

module.exports = { upgradeAll, rewireCommand };

// ---------------------------------------------------------------------------
// CLI + self-test
// ---------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    process.exit(selfTest());
  } else {
    const dryRun = argv.includes('--dry-run');
    // Same resolution chain (env > config.json > default) every other .cjs
    // component uses — bin/axmem's shell variables are never `export`ed.
    const ctx = require('../lib/prelude.cjs');
    const stateDir = process.env.AXMEM_STATE_DIR || ctx.STATE_DIR;
    const memoryDir = process.env.AXMEM_MEMORY_DIR || ctx.MEMORY_DIR;
    const r = upgradeAll({ stateDir, memoryDir, dryRun });
    if (r.manifestCorrupt) {
      console.error(`upgrade: ${r.reason}`);
      process.exit(3);
    }
    for (const res of r.results) console.log(`upgrade: ${res.adapter}: ${res.ok ? 'ok' : 'FAIL'} — ${res.output}`);
    if (r.backupPath) console.log(`upgrade: backup written to ${r.backupPath}`);
    process.exit(r.ok ? 0 : 1);
  }
}

function selfTest() {
  const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-upgrade-selftest-'));
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  // 1. no adapters installed -> ok, no-op, no backup taken
  {
    const stateDir = path.join(T, 's1');
    const memDir = path.join(T, 'mem1');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'decisions.md'), 'x\n');
    const r = upgradeAll({ stateDir, memoryDir: memDir });
    check('1 no adapters installed -> no-op, no backup', r.ok && r.backupPath === null && r.results.length === 0);
  }

  // 2. codex adapter installed -> upgrade re-runs wire.sh idempotently and takes a backup first
  {
    const stateDir = path.join(T, 's2');
    const memDir = path.join(T, 'mem2');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'decisions.md'), 'x\n');
    const target = path.join(T, 'AGENTS.md');
    fs.writeFileSync(target, 'pre-existing\n');
    // simulate a prior install by actually wiring once, then recording it
    execFileSync('bash', [path.join(ROOT, 'adapters', 'codex', 'wire.sh'), target], { env: { ...process.env, AXMEM_STATE_DIR: stateDir, AXMEM_MEMORY_DIR: memDir } });
    const before = fs.readFileSync(target, 'utf8');
    const r = upgradeAll({ stateDir, memoryDir: memDir });
    const after = fs.readFileSync(target, 'utf8');
    check('2 upgrade re-runs codex wiring idempotently and writes a backup', r.ok && before === after && r.backupPath && fs.existsSync(r.backupPath));
  }

  // 3. --dry-run makes no changes and takes no backup
  {
    const stateDir = path.join(T, 's3');
    const memDir = path.join(T, 'mem3');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'decisions.md'), 'x\n');
    const target = path.join(T, 'AGENTS3.md');
    fs.writeFileSync(target, 'pre-existing\n');
    execFileSync('bash', [path.join(ROOT, 'adapters', 'codex', 'wire.sh'), target], { env: { ...process.env, AXMEM_STATE_DIR: stateDir, AXMEM_MEMORY_DIR: memDir } });
    const before = fs.readFileSync(target);
    const r = upgradeAll({ stateDir, memoryDir: memDir, dryRun: true });
    const after = fs.readFileSync(target);
    check('3 --dry-run makes no file changes and takes no backup', r.ok && Buffer.compare(before, after) === 0 && r.backupPath === null);
  }

  // 4 (ts M5): a corrupt manifest (adapters:null) must be reported as
  // manifestCorrupt:true (ok:false), never silently treated as "no
  // adapters installed" (test 1's shape) — those two situations must be
  // distinguishable so the CLI can rc 3 with a repair message instead of
  // reporting a no-op success.
  {
    const stateDir = path.join(T, 's4');
    const memDir = path.join(T, 'mem4');
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lm.manifestPath(stateDir), JSON.stringify({ version: lm.MANIFEST_VERSION, adapters: null }));
    const r = upgradeAll({ stateDir, memoryDir: memDir });
    check('4 (ts M5) corrupt manifest (adapters:null) -> ok:false, manifestCorrupt:true, distinct from "no adapters installed"', r.ok === false && r.manifestCorrupt === true && /malformed "adapters" field/.test(r.reason));
  }

  console.log(results.join('\n'));
  console.log(`upgrade self-test ${ok}/4`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === 4 ? 0 : 1;
}
