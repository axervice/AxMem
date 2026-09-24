#!/usr/bin/env node
// h3-verify.cjs (v1.3, migrated 2026-09-24 from scratchpad per C05-BUILD-SPEC.md 补遗三 第27条
// "扰动族" bullet: "生成器放进 guards/fixtures/(h3-verify 同样迁入,不留 scratchpad)"). Originally a
// 5-form ad-hoc probe comparing the live gate to the pre-196d84e (v1.0) gate; expanded here to the
// FULL esc5.json/esc6.json corpus (46 forms total: the H3 escape family + the batch-escape family +
// the basename-normalization family) run against the LIVE wired entry (bash pmm-isolation-gate.sh,
// structured hook JSON on stdin -- never requires/executes the module in-process).
//
// Every form is checked against the expected DECISION derived from the registered
// specs/isolation-gate-contract.json (matched by exact command text where the form became its own
// contract case; the ~15 forms that were never promoted to their own case -- because they already
// denied under every prior gate version via an EXISTING rule, not a v1.3-specific one -- are asserted
// deny directly, per the precheck captured when esc5.json/esc6.json were authored). W24 is the one
// pinned KNOWN-GAP allow (contract A27); V06 is report_only (contract R01, expected allow, never a
// hard failure here either -- printed for visibility only).
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');

const HERE = __dirname;
const GATE_SH = path.join(HERE, '..', '..', 'pmm-isolation-gate.sh');
const esc5 = require(path.join(HERE, 'esc5.json'));
const esc6 = require(path.join(HERE, 'esc6.json'));

// expect[id] = 'deny' | 'allow' | 'report_only'. Built once, by hand, from the registered contract at
// the time this fixture was authored (2026-09-24, contract commit 7d9e8a5 + this task's item-3
// additions) -- kept as a literal table (not re-derived at runtime) so this fixture stays a stable,
// independent cross-check even if the contract's case IDs are renumbered later.
const EXPECT = {
  'H01-redir-before-pipe': 'deny', 'H02-backslash-delim': 'deny', 'H03-hyphen-delim': 'deny',
  'H04-two-heredocs': 'deny', 'H05-filter-then-bash': 'deny', 'H06-bash-s-args': 'deny',
  'H07-bash-devstdin': 'deny', 'H08-xargs-node-body': 'deny', 'H09-pipe-continues-after-terminator': 'deny',
  'H10-write-script-then-run': 'deny', 'H11-env-bash': 'deny', 'H12-bash-o-pipefail': 'deny',
  'H13-node-dash-arg': 'deny', 'H14-tee-then-sh': 'deny', 'H15-source-devstdin': 'deny',
  'H16-sed-to-file-and-run': 'deny', 'H17-bash-exe': 'deny', 'H18-launder-trailing-allowany': 'deny',
  'H19-node-eval-stdin': 'deny',
  'S01-timeout-node-e-cat': 'deny', 'S02-node-pe-cat': 'deny', 'S03-node-eval-eq-cat': 'deny',
  'S04-bash-xc-cat': 'deny', 'S05-env-node-e-cat': 'deny', 'S06-var-then-bash-c': 'deny',
  'S07-ctrl-bash-c-sed': 'deny', 'S08-echo-sub-pipe-bash': 'deny', 'S09-heredoc-sub-then-eval': 'deny',
  'S10-sed-sub-path-pipe-bash': 'deny',
  'L01-for-launder-allowprod-selftest': 'deny', 'L02-subshell-launder-allowprod': 'deny',
  'L03-node-heredoc-comment-launder': 'deny', 'L04-if-launder-allowany': 'deny',
  'L05-brace-launder-allowprod': 'deny',
  'W01-stdbuf': 'deny', 'W02-nice': 'deny', 'W03-exec': 'deny', 'W04-xargs': 'deny',
  'W05-find-exec': 'deny', 'W06-eval': 'deny', 'W07-source-sh': 'deny', 'W08-cat-pipe-bash': 'deny',
  'W09-bash-stdin-redirect': 'deny', 'W10-node-stdin-redirect': 'deny', 'W11-ctrl-node-r': 'deny',
  'W12-node-require-eq': 'deny', 'W13-node-import-eq': 'deny', 'W14-node-pe-require': 'deny',
  'W15-node-eval-eq-require': 'deny', 'W16-node-e-argv': 'deny', 'W17-var-concat-name': 'deny',
  'W18-trailing-dot': 'deny', 'W19-8dot3': 'deny', 'W20-ctrl-unc': 'deny', 'W21-ansi-c-escape': 'deny',
  'W22-ctrl-ansi-c-plain': 'deny', 'W23-ctrl-env-S': 'deny',
  'W24-unset-T-trio': 'allow', // KNOWN-GAP, contract A27
  'W25-ctrl-input-type-module': 'deny', 'W26-npx-node': 'deny', 'W27-winpty': 'deny',
  'W28-cmd-slashslash-c': 'deny', 'W29-ctrl-powershell-command': 'deny',
  'W30-python-subprocess': 'deny', // contract P01, 主脑裁决 2026-09-24
  'W31-bash-o-pipefail-script': 'deny', 'W32-node-r-ts-then-dut': 'deny',
  'W33-ctrl-bash-dashdash': 'deny',
  'W34-git-alias-bang': 'deny', // contract P02, 主脑裁决 2026-09-24
  'W35-ctrl-node-no-warnings': 'deny', 'W36-bash-O-extglob': 'deny',
  'V01-glob-basename': 'deny', 'V02-brace-expansion': 'deny', 'V03-subst-splice': 'deny',
  'V04-quote-splice': 'deny', 'V05-backslash-splice': 'deny',
  'V06-cross-command-var': 'report_only', // contract R01
  'V07-git-editor-dut': 'deny', // contract P03, 主脑裁决 2026-09-24
  'V08-ctrl-dollar-home': 'deny', 'V09-uppercase-ext': 'deny', 'V10-backslash-path': 'deny',
};

function runOne(command) {
  return new Promise((resolve) => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3v-'));
    const home = path.join(runRoot, 'home'); fs.mkdirSync(home, { recursive: true });
    const nonce = crypto.randomUUID();
    const payload = { session_id: 'test:' + nonce, agent_id: '', agent_type: 'main', prompt_id: 'p1',
      tool_use_id: 'toolu_selftest_' + nonce, cwd: runRoot.split('\\').join('/'), hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command } };
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (k === 'HOME' || k === 'USERPROFILE' || k.startsWith('PMM_')) delete env[k];
    env.HOME = home; env.USERPROFILE = home; env.PMM_HOME = home;
    const child = spawn('bash', [GATE_SH], { env });
    let out = '', err = ''; let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); finish(null); } }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); finish(null); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); finish(code); } });
    child.stdin.on('error', () => {});
    child.stdin.write(payload && JSON.stringify(payload)); child.stdin.end();
    function finish(code) {
      try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
      if (code === 0 && !out && !err) { resolve('allow'); return; }
      try {
        const o = JSON.parse(out.trim());
        if (o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny') { resolve('deny'); return; }
      } catch {}
      resolve('other rc=' + code + ' err=' + JSON.stringify(err).slice(0, 100));
    }
  });
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() { while (next < items.length) { const i = next++; results[i] = await worker(items[i]); } }
  const lanes = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

async function main() {
  const all = [...esc5, ...esc6];
  const results = await runPool(all, (c) => runOne(c.command), 16);
  let pass = 0, fail = 0, reportOnly = 0;
  const failIds = [];
  for (let i = 0; i < all.length; i++) {
    const id = all[i].id;
    const want = EXPECT[id];
    if (!want) { console.log('WARN no EXPECT entry for ' + id); continue; }
    const got = results[i];
    if (want === 'report_only') { reportOnly++; console.log('REPORT_ONLY ' + id + ' observed=' + got); continue; }
    if (got === want) pass++;
    else { fail++; failIds.push(id + ': want=' + want + ' got=' + got); }
  }
  console.log('H3-VERIFY ' + JSON.stringify({ total: all.length, pass, fail, report_only: reportOnly }));
  for (const f of failIds) console.log('FAIL ' + f);
  process.exitCode = fail === 0 ? 0 : 1;
}
main();
