'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const GATE_SH = 'C:/Users/<user>/.claude/guards/pmm-isolation-gate.sh';
const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const CONCURRENCY = 16;

const REALHOME = 'C:/Users/<user>';
const REALHOME_MSYS = '/c/Users/<user>';

function runOne(command, hookEnv) {
  return new Promise((resolve) => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pert-'));
    const home = path.join(runRoot, 'home'); fs.mkdirSync(home, { recursive: true });
    // placeholder substitution matching contract conventions.placeholders (D15/D16/D18/D22-shape cases
    // use REALHOME/REALHOME_MSYS/$T literally in their command text; the self-test harness substitutes
    // them before sending to the gate -- this perturbation runner must do the same or those cases'
    // redirect-completeness checks never trigger, which is a false ALLOW in the runner, not the gate).
    const T = runRoot.replace(/\\/g, '/');
    const sub = (text) => String(text)
      .replace(/\bREALHOME_MSYS\b/g, REALHOME_MSYS)
      .replace(/\bREALHOME\b/g, REALHOME)
      .replace(/\bRUNROOT\b/g, T)
      .replace(/\$T\b/g, T);
    const subbed = sub(command);
    const nonce = crypto.randomUUID();
    const payload = { session_id: 'test:' + nonce, agent_id: '', agent_type: 'main', prompt_id: 'p1',
      tool_use_id: 'toolu_selftest_' + nonce, cwd: runRoot.split('\\').join('/'), hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: subbed } };
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (k === 'HOME' || k === 'USERPROFILE' || k.startsWith('PMM_')) delete env[k];
    env.HOME = home; env.USERPROFILE = home; env.PMM_HOME = home;
    if (hookEnv) for (const k of Object.keys(hookEnv)) env[k] = sub(hookEnv[k]);
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
      if (code === 0 && !out && !err) { resolve('ALLOW'); return; }
      try {
        const o = JSON.parse(out.trim());
        if (o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny') { resolve('DENY'); return; }
      } catch {}
      resolve('OTHER rc=' + code + ' err=' + JSON.stringify(err).slice(0, 100));
    }
  });
}

async function main() {
  const results = new Array(cases.length);
  let next = 0;
  async function lane() {
    while (next < cases.length) {
      const i = next++;
      results[i] = await runOne(cases[i].command, cases[i].hook_env);
    }
  }
  const lanes = [];
  for (let i = 0; i < Math.min(CONCURRENCY, cases.length); i++) lanes.push(lane());
  await Promise.all(lanes);
  let allow = 0, deny = 0, other = 0;
  const failures = [];
  for (let i = 0; i < cases.length; i++) {
    if (results[i] === 'ALLOW') { allow++; failures.push(cases[i].id + ': ' + results[i]); }
    else if (results[i] === 'DENY') deny++;
    else { other++; failures.push(cases[i].id + ': ' + results[i]); }
  }
  console.log(JSON.stringify({ total: cases.length, deny, allow, other }));
  for (const f of failures.slice(0, 60)) console.log('NOT-DENY ' + f);
  if (failures.length > 60) console.log('... and ' + (failures.length - 60) + ' more');
  fs.writeFileSync(process.argv[3] || (process.argv[2] + '.failures.json'), JSON.stringify(failures, null, 1));
}
main();
