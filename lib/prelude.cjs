#!/usr/bin/env node
// AxMem prelude (node side) — same contract as prelude.sh, for .cjs components
// and as the JSON accessor the shell prelude delegates to.
// Usage: node prelude.cjs get <dot.path> <default>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeMsysPath } = require('./msys-path.cjs');

function norm(p) { return String(p || '').replace(/\\/g, '/'); }
// Config values may use a leading "~" for portability — expand it here, once.
// (Fresh-user doctor caught the gap: init happily mkdir'ed a literal "~" dir.)
function tilde(p) { p = norm(p); return p === '~' ? HOME_DIR : p.startsWith('~/') ? HOME_DIR + p.slice(1) : p; }

// [ts M6] Every AXMEM_* env var is resolved through normalizeMsysPath()
// BEFORE norm()'s own backslash->forward-slash pass — a user exporting
// e.g. AXMEM_STATE_DIR=/c/tmp/axstate from Git Bash (the documented way to
// configure this tool) would otherwise silently resolve to
// "C:\c\tmp\axstate" once any .cjs component's fs/path calls touch it
// (Windows Node treats a leading "/" as "absolute from the current
// drive's root", not as an MSYS drive marker — see lib/msys-path.cjs).
// This is prelude.cjs's own STATE_DIR/MEMORY_DIR/AXMEM_HOME/AXMEM_CONFIG —
// the single source EVERY other .cjs component in this repo resolves
// these paths through — so fixing it here fixes every downstream reader
// at once, rather than requiring each new component to remember to call
// normalizeMsysPath() itself.
const HOME_DIR = norm(normalizeMsysPath(process.env.HOME) || os.homedir());
const AXMEM_HOME = norm(normalizeMsysPath(process.env.AXMEM_HOME) || path.join(HOME_DIR, '.axmem'));
const AXMEM_CONFIG = norm(normalizeMsysPath(process.env.AXMEM_CONFIG) || AXMEM_HOME + '/config.json');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(AXMEM_CONFIG, 'utf8')); } catch { /* defaults apply */ }

function dotGet(obj, dotPath, dflt) {
  let cur = obj;
  for (const seg of String(dotPath).split('.')) {
    if (cur && typeof cur === 'object' && seg in cur) cur = cur[seg]; else return dflt;
  }
  return cur === undefined ? dflt : cur;
}

function cfgGet(dotPath, dflt) { return dotGet(cfg, dotPath, dflt); }

// [Opus H1] Re-resolves STATE_DIR fresh from CURRENT process.env (and a
// fresh re-read of whatever AXMEM_CONFIG currently points at) — unlike
// ctx.STATE_DIR below (computed ONCE, at module-load time, like every
// other ctx field), this exists for a caller that must recompute per call
// rather than per process. Right now that's only lib/fence.cjs, which
// previously hand-rolled its OWN second implementation of "env >
// config.json > default" (a straight env-only fallback, no config.json,
// no normalizeMsysPath) — the exact anti-pattern this function closes:
// there is now only ONE place that knows how AXMEM_STATE_DIR is resolved,
// env>config>default+normalizeMsysPath, and every caller (cached ctx.
// STATE_DIR for the common case, or this function for a per-call
// resolver) goes through it.
function resolveStateDir() {
  const home = normalizeMsysPath(process.env.AXMEM_HOME) || path.join(HOME_DIR, '.axmem');
  const configPath = normalizeMsysPath(process.env.AXMEM_CONFIG) || home + '/config.json';
  let localCfg = {};
  try { localCfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* defaults apply */ }
  return tilde(normalizeMsysPath(process.env.AXMEM_STATE_DIR) || dotGet(localCfg, 'state_dir', home + '/state'));
}

const MACHINE = (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || 'unknown';

const ctx = {
  HOME_DIR,
  AXMEM_HOME,
  AXMEM_CONFIG,
  MEMORY_DIR: tilde(normalizeMsysPath(process.env.AXMEM_MEMORY_DIR) || cfgGet('memory_dir', AXMEM_HOME + '/memory')),
  STATE_DIR: tilde(normalizeMsysPath(process.env.AXMEM_STATE_DIR) || cfgGet('state_dir', AXMEM_HOME + '/state')),
  MACHINE,
  // repos: [{id, roots:[abs...]}] — repo-relative matching for trigger/pointer
  // components; roots compare case-insensitively (Windows), worktree segments
  // (.claude/worktrees/<name>/) are stripped to repo-relative by consumers.
  repos: cfgGet('repos', []),
  entryLimit: Number(process.env.AXMEM_ENTRY_LIMIT || cfgGet('gates.entry_limit', 900)),
  cfgGet,
  resolveStateDir,
};

// Resolve an absolute file path to {repoId, rel} using ctx.repos.
// Deterministic, no basename fallback (a basename match turns low recall
// into cross-repo false positives — audited rule).
ctx.resolveRepo = function resolveRepo(absPath) {
  let fp = norm(absPath).replace(/^([A-Za-z]):\//, (m, d) => d.toLowerCase() + ':/');
  const lower = fp.toLowerCase();
  for (const r of ctx.repos) {
    for (const rootRaw of (r.roots || [])) {
      const root = norm(rootRaw).replace(/^([A-Za-z]):\//, (m, d) => d.toLowerCase() + ':/').replace(/\/$/, '');
      if (lower.startsWith(root.toLowerCase() + '/')) {
        let rel = fp.slice(root.length + 1);
        const wt = rel.match(/^(?:.*?\/)??\.claude\/worktrees\/[^/]+\/(.*)$/);
        const wtStripped = !!(wt && wt[1]);
        if (wtStripped) rel = wt[1];
        return { repoId: r.id, rel, wtStripped };
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Self-test (ts M6) — prelude.cjs computes HOME_DIR/AXMEM_HOME/STATE_DIR/
// MEMORY_DIR ONCE, at module-load time, from whatever process.env looked
// like at that instant — so the only faithful way to test "does a DIFFERENT
// env produce a DIFFERENT, CORRECT resolution" is to spawn a fresh child
// process per scenario (re-require()'ing this same module in-process, after
// mutating process.env, would still only prove the normalizeMsysPath() unit
// itself, not that prelude.cjs's own top-level const wiring actually calls
// it — which is the specific regression this test guards against).
// ---------------------------------------------------------------------------
function selfTest() {
  const { execFileSync } = require('child_process');
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  function ctxWithEnv(envOverrides) {
    const out = execFileSync(process.execPath, [__filename, 'ctx'], {
      env: { ...process.env, ...envOverrides },
      encoding: 'utf8',
    });
    return JSON.parse(out);
  }

  if (process.platform === 'win32') {
    // 1 (ts M6): AXMEM_STATE_DIR given in MSYS form (as a user's Git Bash
    // session would export it) must resolve to the CORRECT native path,
    // not the silently-wrong "C:\c\tmp\..." shape Windows Node's own
    // path.resolve() would otherwise produce.
    {
      const c = ctxWithEnv({ AXMEM_STATE_DIR: '/c/tmp/axmem-msys-selftest-state', AXMEM_HOME: '', AXMEM_MEMORY_DIR: '', AXMEM_CONFIG: '' });
      check('1 (ts M6) AXMEM_STATE_DIR=/c/tmp/... resolves to C:/tmp/... (forward-slash internal form), never C:/c/tmp/...',
        /^c:\/tmp\/axmem-msys-selftest-state$/i.test(c.STATE_DIR) && !/^c:\/c\//i.test(c.STATE_DIR));
    }
    // 2: same for AXMEM_MEMORY_DIR.
    {
      const c = ctxWithEnv({ AXMEM_MEMORY_DIR: '/c/tmp/axmem-msys-selftest-mem', AXMEM_HOME: '', AXMEM_STATE_DIR: '', AXMEM_CONFIG: '' });
      check('2 (ts M6) AXMEM_MEMORY_DIR=/c/tmp/... resolves correctly, never C:/c/tmp/...',
        /^c:\/tmp\/axmem-msys-selftest-mem$/i.test(c.MEMORY_DIR) && !/^c:\/c\//i.test(c.MEMORY_DIR));
    }
    // 3: same for AXMEM_HOME.
    {
      const c = ctxWithEnv({ AXMEM_HOME: '/c/tmp/axmem-msys-selftest-home', AXMEM_STATE_DIR: '', AXMEM_MEMORY_DIR: '', AXMEM_CONFIG: '' });
      check('3 (ts M6) AXMEM_HOME=/c/tmp/... resolves correctly, never C:/c/tmp/...',
        /^c:\/tmp\/axmem-msys-selftest-home$/i.test(c.AXMEM_HOME) && !/^c:\/c\//i.test(c.AXMEM_HOME));
    }
    // 4: an already-native path given via env is left exactly as-is (no
    // double-conversion / no corruption of the normal, common case).
    {
      const c = ctxWithEnv({ AXMEM_STATE_DIR: 'C:\\Users\\Public\\axmem-native-selftest', AXMEM_HOME: '', AXMEM_MEMORY_DIR: '', AXMEM_CONFIG: '' });
      check('4 an already-native Windows path given via env is passed through unchanged', /^c:\/users\/public\/axmem-native-selftest$/i.test(c.STATE_DIR));
    }
  } else {
    check('1-4 (ts M6) MSYS-path tests skipped: not running on win32 (normalizeMsysPath is a deliberate Windows-only no-op elsewhere)', true);
  }

  console.log(results.join('\n'));
  console.log(`prelude.cjs self-test ${ok}/${process.platform === 'win32' ? 4 : 1}`);
  return ok === (process.platform === 'win32' ? 4 : 1) ? 0 : 1;
}

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'get') { let v = cfgGet(a, b); if (typeof v === 'string') v = tilde(v); process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); }
  if (cmd === 'ctx') { process.stdout.write(JSON.stringify({ ...ctx, cfgGet: undefined, resolveRepo: undefined, resolveStateDir: undefined }, null, 2)); process.exit(0); }
  if (cmd === '--self-test') { process.exit(selfTest()); }
  console.error('usage: prelude.cjs get <dot.path> <default> | ctx | --self-test');
  process.exit(1);
}

module.exports = ctx;
