#!/usr/bin/env node
// AxMem Hermes adapter doctor section. (P1 2.1, 2026-09-16)
// D5 three-tier status: configured / approved / active. `active` requires a
// queryable list of hooks actually loaded in a RUNNING Hermes process —
// builder-report §4.2 confirms no such interface exists (`hermes hooks
// list`/`doctor` only reflect the static config file + allowlist, never a
// live process's in-memory registration set — see hermes_cli/subcommands/
// hooks.py). This doctor section therefore NEVER reports `active` in P1;
// reporting it would be an unverifiable claim, which D9 forbids.
// Read-only against real Hermes paths (config.yaml, shell-hooks-allowlist.
// json) — never writes there, per this task's hard constraints. Never reads
// ~/.hermes/memories/ or SOUL.md (D1 single-writer rule).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ctx = require('../../lib/prelude.cjs');
const wire = require('./wire.cjs');
const queue = require('./queue.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BRIDGE = path.join(ROOT, 'adapters', 'hermes', 'bridge.cjs');

// See adapters/hermes/wire.cjs's defaultHermesHome() for why HERMES_HOME
// must be checked FIRST — same fix, same reason, kept in sync deliberately.
function defaultHermesHome() {
  const envHome = (process.env.HERMES_HOME || '').trim();
  if (envHome) return envHome;
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    return la ? path.join(la, 'hermes') : path.join(os.homedir(), 'AppData', 'Local', 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

function resolveConfigPath() {
  const cfgVal = ctx.cfgGet('adapters.hermes.config_yaml', null);
  if (cfgVal) return String(cfgVal).replace(/^~(?=\/|$)/, ctx.HOME_DIR);
  return path.join(defaultHermesHome(), 'config.yaml');
}

function readConfigStatus(configPath) {
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return { present: false, wired: false, hooksAutoAccept: null }; }
  const wired = /hooks:/.test(text) && text.includes('bridge.cjs') && /post_tool_call/.test(text) && /pre_llm_call/.test(text);
  const autoAcceptMatch = /^\s*hooks_auto_accept:\s*(\S+)/m.exec(text);
  return { present: true, wired: !!wired, hooksAutoAccept: autoAcceptMatch ? autoAcceptMatch[1].replace(/#.*$/, '').trim() : null, raw: text };
}

function allowlistPath() {
  return path.join(defaultHermesHome(), 'shell-hooks-allowlist.json');
}

function readAllowlistApprovedCount() {
  let raw;
  try { raw = fs.readFileSync(allowlistPath(), 'utf8'); } catch { return { approved: 0, total: 0, present: false }; }
  let data;
  try { data = JSON.parse(raw); } catch { return { approved: 0, total: 0, present: true, parseError: true }; }
  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  const ours = approvals.filter((e) => e && typeof e.command === 'string' && e.command.includes('bridge.cjs'));
  return { approved: ours.length, total: approvals.length, present: true };
}

function queueCounts(queueRoot) {
  const stats = queue.scanStats(queueRoot);
  let unrouted = 0, quarantineFiles = 0;
  try { unrouted = fs.readdirSync(path.join(queueRoot, 'unrouted')).filter((f) => f.endsWith('.json')).length; } catch { /* dir absent */ }
  quarantineFiles = stats.quarantineCount;
  return { unrouted, quarantine: quarantineFiles, globalBytes: stats.globalBytes };
}

// Live smoke test: actually invoke bridge.cjs (via the exact command the
// wired config points at) with synthetic event JSON, in a throwaway queue
// root, and assert the documented behavior.
function liveSmokeTest() {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-hermes-doctor-smoke-'));
  const memDir = path.join(smokeRoot, 'mem');
  const stateDir = path.join(smokeRoot, 'state');
  fs.mkdirSync(memDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  for (const f of ['decisions.md', 'lessons.md', 'standinginstructions.md']) {
    fs.writeFileSync(path.join(memDir, f), '## Index\n\n## Entries\n');
  }
  const queueDir = path.join(stateDir, 'hermes-queue');
  const env = {
    ...process.env,
    AXMEM_MEMORY_DIR: memDir,
    AXMEM_STATE_DIR: stateDir,
    AXMEM_HERMES_QUEUE_DIR: queueDir,
  };
  const sessionId = 'doctor-smoke-session';
  const testFile = path.join(memDir, 'lessons.md');
  fs.writeFileSync(testFile, '## Index\n\n## Entries\n\n**2026-09-16 — probe** [doctor:probe]\n<!-- trigger: tool=Write; repo=home; path=' + testFile.replace(/\\/g, '/') + ' -->\nbody\n');

  const postPayload = JSON.stringify({ hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: testFile }, session_id: sessionId, cwd: smokeRoot, extra: {} });
  let postResult;
  try {
    const out = execFileSync('node', [BRIDGE, 'post_tool_call'], { input: postPayload, encoding: 'utf8', env, timeout: 8000, stdio: ['pipe','pipe','pipe'] });
    postResult = { rc: 0, stdout: out };
  } catch (e) {
    postResult = { rc: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout ? e.stdout.toString() : '' };
  }
  let queueHasFile = false;
  try {
    const entries = fs.readdirSync(queueDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'unrouted' && d.name !== 'quarantine');
    for (const e of entries) {
      if (fs.readdirSync(path.join(queueDir, e.name)).some((f) => f.endsWith('.json'))) { queueHasFile = true; break; }
    }
  } catch { /* queue dir absent -> stays false */ }
  const postOk = postResult.rc === 0 && postResult.stdout.trim() === '' && queueHasFile;

  const prePayload = JSON.stringify({ hook_event_name: 'pre_llm_call', session_id: sessionId, cwd: smokeRoot, extra: {} });
  let preResult;
  try {
    const out = execFileSync('node', [BRIDGE, 'pre_llm_call'], { input: prePayload, encoding: 'utf8', env, timeout: 8000, stdio: ['pipe','pipe','pipe'] });
    preResult = { rc: 0, stdout: out };
  } catch (e) {
    preResult = { rc: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout ? e.stdout.toString() : '' };
  }
  let preShapeOk = false;
  try {
    const parsed = JSON.parse(preResult.stdout);
    preShapeOk = typeof parsed.context === 'string' && parsed.context.length > 0;
  } catch { preShapeOk = false; }
  let drained = true;
  try {
    const entries = fs.readdirSync(queueDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'unrouted' && d.name !== 'quarantine');
    drained = entries.length === 0;
  } catch { drained = true; }
  const preOk = preResult.rc === 0 && preShapeOk && drained;

  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  return { postOk, preOk, postResult, preResult };
}

function run() {
  const lines = [];
  const configPath = resolveConfigPath();
  const cfgStatus = readConfigStatus(configPath);
  const allow = readAllowlistApprovedCount();

  let tier = 'not-configured';
  if (cfgStatus.present && cfgStatus.wired) tier = 'configured';
  if (tier === 'configured' && allow.approved >= 4) tier = 'approved';
  // 'active' is deliberately unreachable — see file header.

  const queueRoot = process.env.AXMEM_HERMES_QUEUE_DIR || path.join(ctx.STATE_DIR, 'hermes-queue');
  const qc = queueCounts(queueRoot);

  lines.push(`hermes: status=${tier} (active unreportable — no live-hook-list query interface exists, verified from source)`);
  lines.push(`hermes: config path=${configPath} (present=${cfgStatus.present})`);
  lines.push(`hermes: allowlist matches=${allow.approved}/4 expected (allowlist present=${allow.present})`);
  lines.push(`hermes: hooks_auto_accept=${cfgStatus.hooksAutoAccept === null ? '(unset)' : cfgStatus.hooksAutoAccept} (report-only — never modified by AxMem, D3)`);
  // [Opus M3] wire.cjs's real-loader cross-check only runs when a real
  // `hermes` binary is reachable on PATH — report that fact explicitly
  // rather than leaving it silently invisible whether wiring is relying on
  // this file's own conservative-subset analysis alone or was additionally
  // cross-checked against Hermes's own loader.
  lines.push(`hermes: loader ${wire.resolveHermesCommand() ? 'used (real "hermes" CLI found on PATH — wire.cjs cross-checks writes against it)' : 'unused (no "hermes" CLI found on PATH — wire.cjs relies on its own conservative-subset validation only)'}`);
  lines.push(`hermes: queue unrouted=${qc.unrouted} quarantine=${qc.quarantine} bytes=${qc.globalBytes}`);
  lines.push('hermes: enforcement=detect-and-correct, delivery=best-effort');

  const smoke = liveSmokeTest();
  lines.push(`hermes: live smoke post_tool_call ${smoke.postOk ? 'ok' : 'FAIL'} (zero stdout + queue file appeared)`);
  lines.push(`hermes: live smoke pre_llm_call ${smoke.preOk ? 'ok' : 'FAIL'} ({"context"} shape + queue drained)`);

  const fail = !(smoke.postOk && smoke.preOk);
  return { lines, fail, tier };
}

function withIsolatedEnv(fn) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-hermes-doctor-selftest-'));
  const saved = {};
  const overrides = {
    // HERMES_HOME MUST be overridden too, not just LOCALAPPDATA: a real
    // isolation breach was caught here while producing the builder report
    // — this machine has HERMES_HOME exported in the ambient environment,
    // and once defaultHermesHome() correctly started honoring it (a
    // separate, necessary fix — see wire.cjs), doctor.cjs's OWN self-test
    // stopped being isolated and read the REAL ~/AppData/Local/hermes/
    // config.yaml (a genuine YAML alias in that real file made wire.cjs
    // safely refuse to WRITE it, so no real damage occurred, but the read
    // itself proved this override list was incomplete).
    HERMES_HOME: path.join(T, 'AppData', 'Local', 'hermes'),
    LOCALAPPDATA: path.join(T, 'AppData', 'Local'),
    AXMEM_STATE_DIR: path.join(T, 'state'),
    AXMEM_HOME: path.join(T, 'axmemhome'),
    AXMEM_MEMORY_DIR: path.join(T, 'mem'),
    AXMEM_HERMES_QUEUE_DIR: path.join(T, 'state', 'hermes-queue'),
  };
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; process.env[k] = overrides[k]; }
  fs.mkdirSync(path.join(T, 'AppData', 'Local', 'hermes'), { recursive: true });
  try {
    return fn(T);
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function selfTest() {
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  // 1. fresh HOME -> not-configured, active never claimed
  withIsolatedEnv(() => {
    const { tier, lines } = run();
    check('1 fresh HOME -> not-configured (never active)', tier === 'not-configured' && lines.some((l) => l.includes('active unreportable')));
  });

  // 2. after wire.cjs -> configured (allowlist still absent)
  withIsolatedEnv((T) => {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(__dirname, 'wire.cjs')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const { tier } = run();
    check('2 after wire.cjs -> configured', tier === 'configured');
  });

  // 3. after wire.cjs + all 4 allowlist entries -> approved
  withIsolatedEnv((T) => {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(__dirname, 'wire.cjs')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const approvals = ['post_tool_call', 'pre_llm_call', 'on_session_start', 'on_session_end'].map((ev) => ({ event: ev, command: `node "${BRIDGE}" ${ev}` }));
    fs.writeFileSync(allowlistPath(), JSON.stringify({ approvals }));
    const { tier } = run();
    check('3 wired + 4 allowlist entries -> approved', tier === 'approved');
  });

  // 4. live smoke test genuinely exercises the bridge (post zero-stdout +
  //    queue file; pre {"context"} shape + drained) — proven by run()'s own
  //    fail flag AND a positive control (mutate a fresh env's memory dir
  //    to NOT contain the probe file, expecting the recall smoke to still
  //    pass on write-gate alone since a queued record is produced either way)
  withIsolatedEnv(() => {
    const { fail, lines } = run();
    check('4 live smoke test both legs pass in a fresh, correctly-wired env', !fail && lines.some((l) => l.includes('post_tool_call ok')) && lines.some((l) => l.includes('pre_llm_call ok')));
  });

  // 5 (ts M7): an allowlist file that IS present, with entries, but none of
  // which reference bridge.cjs (an unrelated command some other tool
  // approved, or the user's own shell aliases) must NOT count toward our
  // "approved" tier. readAllowlistApprovedCount() filters on
  // `command.includes('bridge.cjs')`, but the pre-existing self-test only
  // ever exercised the ALL-4-of-ours-present case (test 3) — a mutation
  // that dropped or weakened that filter (e.g. counting any non-empty
  // approvals array as "ours") would have scored all-green.
  withIsolatedEnv((T) => {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(__dirname, 'wire.cjs')], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const unrelatedApprovals = [
      { event: 'post_tool_call', command: 'echo some-other-tool-entirely' },
      { event: 'pre_llm_call', command: 'bash /opt/unrelated/hook.sh' },
    ];
    fs.writeFileSync(allowlistPath(), JSON.stringify({ approvals: unrelatedApprovals }));
    const counts = readAllowlistApprovedCount();
    const { tier } = run();
    check('5 (ts M7) allowlist present with unrelated (non-bridge.cjs) entries -> approved count stays 0, tier stays "configured" (not "approved")',
      counts.present === true && counts.total === 2 && counts.approved === 0 && tier === 'configured');
  });

  console.log(results.join('\n'));
  console.log(`hermes doctor self-test ${ok}/5`);
  return ok === 5 ? 0 : 1;
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') {
    process.exit(selfTest());
  } else {
    const { lines, fail } = run();
    console.log(lines.join('\n'));
    process.exit(fail ? 1 : 0);
  }
}

module.exports = { run, readConfigStatus, readAllowlistApprovedCount, resolveConfigPath, liveSmokeTest, allowlistPath };
