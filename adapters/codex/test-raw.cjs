#!/usr/bin/env node
// Isolated acceptance checks; discovered by bin/axmem selftest via --self-test.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

if (process.argv[2] !== '--self-test') process.exit(0);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-codex-'));
const store = path.join(temp, 'raw');
const hook = path.join(__dirname, 'raw-receipts.cjs');
const installer = path.join(__dirname, 'install-hooks.cjs');
const env = { ...process.env, AXMEM_CODEX_RAW_DIR: store };
let ok = 0;
const sid = 'test-session';
const event = (name, turn, extra = {}) => ({ session_id: sid, turn_id: turn, hook_event_name: name, ...extra });
const key = value => crypto.createHash('sha256').update(value).digest('hex');
const scope = (turn, session = sid) => path.join(key(session), key(turn));
const rawIds = (turn, session = sid) => fs.readdirSync(path.join(store, 'raw', scope(turn, session))).filter(name => /^[a-f0-9]{64}$/.test(name));
function countRaw() {
  let count = 0;
  for (const session of fs.readdirSync(path.join(store, 'raw'))) {
    if (!/^[a-f0-9]{64}$/.test(session)) continue;
    for (const turn of fs.readdirSync(path.join(store, 'raw', session)))
      count += fs.readdirSync(path.join(store, 'raw', session, turn)).filter(name => /^[a-f0-9]{64}$/.test(name)).length;
  }
  return count;
}
function run(action, data, override = env) {
  return spawnSync(process.execPath, [hook, action], { input: JSON.stringify(data), env: override, encoding: 'utf8' });
}
function check(condition, label) { assert.ok(condition, label); ok++; }
function parallel(action, data) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, action], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(data));
  });
}

(async () => {
  try {
    const prompt = '用户原文：\n表情😀\t' + '长文本'.repeat(900);
    const user = event('UserPromptSubmit', 'turn-1', { prompt });
    check(run('prompt', user).status === 0, 'prompt accepted after durable write');
    const first = rawIds('turn-1');
    const record = JSON.parse(fs.readFileSync(path.join(store, 'raw', scope('turn-1'), first[0], 'record.json'), 'utf8'));
    check(record.payload.prompt === prompt, 'Unicode and long prompt exact');
    check(run('prompt', user).status === 0 && countRaw() === 1, 'duplicate idempotent');
    const steer = run('prompt', { ...user, prompt: 'different steering text' });
    check(steer.status === 0 && countRaw() === 2, `distinct steering text in one turn retained: rc=${steer.status} ${steer.stderr} count=${countRaw()}`);
    const same = await Promise.all(Array.from({ length: 6 }, () => parallel('prompt', user)));
    check(same.every(r => r.code === 0) && countRaw() === 2, 'same message concurrent delivery idempotent');
    const jobs = Array.from({ length: 12 }, (_, i) => parallel('prompt', event('UserPromptSubmit', `parallel-${i}`, { prompt: `并发 ${i}` })));
    check((await Promise.all(jobs)).every(r => r.code === 0) && countRaw() === 14, 'parallel publishes all records');
    const otherSession = run('prompt', event('UserPromptSubmit', 'turn-1', { session_id: 'other-session', prompt }));
    check(otherSession.status === 0 && countRaw() === 15, 'same turn and text isolated across sessions');
    const badJson = spawnSync(process.execPath, [hook, 'prompt'], { input: '{bad', env, encoding: 'utf8' });
    check(badJson.status === 2, 'malformed hook JSON blocks submission');
    const badRoot = path.join(temp, 'root-is-file');
    fs.writeFileSync(badRoot, 'x');
    check(run('prompt', event('UserPromptSubmit', 'blocked', { prompt: 'secret' }), { ...env, AXMEM_CODEX_RAW_DIR: badRoot }).status === 2, 'storage failure blocks prompt');
    const covered = run('precompact', event('PreCompact', 'turn-1', { trigger: 'auto' }));
    check(covered.status === 0 && covered.stdout === '', 'captured current turn allows compaction');
    const manualCompact = run('precompact', event('PreCompact', 'manual-compact-turn', { trigger: 'manual' }));
    check(manualCompact.status === 0 && manualCompact.stdout === '', 'manual compact in a new turn validates earlier session receipts');
    const laterAuto = run('precompact', event('PreCompact', 'later-auto-turn', { trigger: 'auto' }));
    check(laterAuto.status === 0 && laterAuto.stdout === '', 'automatic compact validates recorded session receipts across turns');
    const secondId = rawIds('turn-1').find(id => id !== first[0]);
    const secondRaw = path.join(store, 'raw', scope('turn-1'), secondId);
    const secondJournal = path.join(store, 'journal', scope('turn-1'), secondId);
    fs.cpSync(secondRaw, path.join(temp, 'saved-raw'), { recursive: true });
    fs.rmSync(secondRaw, { recursive: true });
    check(JSON.parse(run('precompact', event('PreCompact', 'manual-compact-turn', { trigger: 'manual' })).stdout).continue === false, 'missing earlier-turn raw receipt blocks manual compaction');
    fs.cpSync(path.join(temp, 'saved-raw'), secondRaw, { recursive: true });
    fs.cpSync(secondJournal, path.join(temp, 'saved-journal'), { recursive: true });
    fs.rmSync(secondJournal, { recursive: true });
    check(JSON.parse(run('precompact', event('PreCompact', 'later-auto-turn', { trigger: 'auto' })).stdout).continue === false, 'missing earlier-turn journal marker blocks automatic compaction');
    fs.cpSync(path.join(temp, 'saved-journal'), secondJournal, { recursive: true });
    const rawPath = path.join(store, 'raw', scope('turn-1'), first[0], 'record.json');
    const goodBytes = fs.readFileSync(rawPath);
    const altered = JSON.parse(goodBytes);
    altered.payload.prompt = 'tampered but legal JSON';
    fs.writeFileSync(rawPath, JSON.stringify(altered));
    check(JSON.parse(run('precompact', event('PreCompact', 'turn-1', { trigger: 'auto' })).stdout).continue === false, 'legal JSON with bad hash stops compaction');
    fs.writeFileSync(rawPath, goodBytes);
    altered.payload.prompt = prompt;
    altered.schema = 42;
    fs.writeFileSync(rawPath, JSON.stringify(altered));
    check(JSON.parse(run('precompact', event('PreCompact', 'turn-1', { trigger: 'auto' })).stdout).continue === false, 'wrong schema stops compaction');
    fs.writeFileSync(rawPath, goodBytes);
    const missed = run('precompact', event('PreCompact', 'missed-turn', { trigger: 'auto' }));
    check(missed.status === 0 && missed.stdout === '', 'session receipts permit compaction without a prompt in the compaction turn');
    const legacy = run('precompact', event('PreCompact', 'old-turn', { session_id: 'legacy', trigger: 'manual' }));
    check(legacy.status === 0 && JSON.parse(legacy.stdout).continue === false, 'pre-install session fails closed');
    const linkSession = 'junction-case';
    const linkTurn = 'link-turn';
    const linkScope = scope(linkTurn, linkSession);
    const outside = path.join(temp, 'outside-store');
    fs.mkdirSync(outside);
    const junction = path.join(store, 'journal', linkScope);
    fs.mkdirSync(path.dirname(junction), { recursive: true });
    fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedMessage = event('UserPromptSubmit', linkTurn, { session_id: linkSession, prompt: 'must stay local' });
    check(run('prompt', linkedMessage).status === 2 && fs.readdirSync(outside).length === 0, 'managed journal junction refused without external write');
    fs.unlinkSync(junction);
    check(run('prompt', linkedMessage).status === 0 && run('precompact', event('PreCompact', linkTurn, { session_id: linkSession, trigger: 'auto' })).stdout === '', 'retry completes raw-only interrupted pair');
    fs.mkdirSync(path.join(store, 'raw', scope('turn-1'), '.stage-interrupted'));
    fs.writeFileSync(path.join(store, 'raw', scope('turn-1'), '.stage-interrupted', 'record.json'), '{partial');
    check(run('prompt', event('UserPromptSubmit', 'retry', { prompt: 'after interrupted publish' })).status === 0, 'interrupted unpublished stage does not block retry');
    const restart = run('sessionstart', event('SessionStart', undefined, { source: 'resume' }));
    const note = JSON.parse(restart.stdout).hookSpecificOutput.additionalContext;
    check(note.includes('15 local raw prompt') && note.includes('other local Codex sessions') && !note.includes('用户原文'), 'restart restores current plus bounded global pointers');
    const fresh = run('sessionstart', event('SessionStart', undefined, { session_id: 'fresh-session', source: 'startup' }));
    check(JSON.parse(fresh.stdout).hookSpecificOutput.additionalContext.includes('Across other local Codex sessions') && !fresh.stdout.includes('用户原文'), 'new chat sees prior sessions without raw text');
    const stop = run('stop', event('Stop', 'turn-1', { stop_hook_active: false }));
    check(JSON.parse(stop.stdout).systemMessage.includes('local raw prompt') && run('stop', event('Stop', 'turn-1', { stop_hook_active: false })).stdout === '', 'Stop warns once without synthetic prompt');
    const resolve = spawnSync(process.execPath, [hook, 'resolve', first[0], 'no-memory', 'ordinary task message'], { env, encoding: 'utf8' });
    check(resolve.status === 0 && fs.existsSync(rawPath), 'explicit review preserves raw evidence');
    const resolvedFile = path.join(store, 'resolved', first[0], 'record.json');
    const resolvedBytes = fs.readFileSync(resolvedFile);
    fs.unlinkSync(resolvedFile);
    check(JSON.parse(run('sessionstart', event('SessionStart', undefined, { source: 'resume' })).stdout).continue === false, 'empty resolved directory never silently clears pending');
    fs.writeFileSync(resolvedFile, '{"schema":1,"payload":{}}');
    check(JSON.parse(run('sessionstart', event('SessionStart', undefined, { source: 'resume' })).stdout).continue === false, 'corrupt resolution never silently clears pending');
    fs.writeFileSync(resolvedFile, resolvedBytes);
    const memory = path.join(temp, 'memory-note.md');
    fs.writeFileSync(memory, '## anchor\nUnrelated memory text\n');
    const otherId = rawIds('turn-1').find(id => id !== first[0]);
    const unrelated = spawnSync(process.execPath, [hook, 'resolve', otherId, 'memory-saved', memory + '#anchor', 'reviewed'], { env, encoding: 'utf8' });
    check(unrelated.status === 1, 'unrelated memory anchor cannot resolve receipt');
    fs.appendFileSync(memory, `Source: codex-raw:${otherId}\n`);
    const linked = spawnSync(process.execPath, [hook, 'resolve', otherId, 'memory-saved', memory + '#anchor', 'reviewed and matched'], { env, encoding: 'utf8' });
    check(linked.status === 0 && JSON.parse(fs.readFileSync(path.join(store, 'resolved', otherId, 'record.json'), 'utf8')).payload.evidence.sha256.length === 64, `resolution binds source ID, anchor and file hash: ${linked.stderr}`);
    const codexHome = path.join(temp, 'codex-home');
    fs.mkdirSync(codexHome);
    const oldPromptCommand = `"${process.execPath}" "${hook}" prompt`;
    const original = { hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: oldPromptCommand, commandWindows: oldPromptCommand, timeout: 10 }] }],
    }, other: 'retained' };
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify(original));
    const dry = spawnSync(process.execPath, [installer, codexHome, '--dry-run'], { encoding: 'utf8' });
    check(dry.status === 0 && JSON.stringify(JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'))) === JSON.stringify(original), 'dry run changes nothing');
    const install = spawnSync(process.execPath, [installer, codexHome], { encoding: 'utf8' });
    const configured = fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8');
    const merged = JSON.parse(configured);
    check(install.status === 0 && merged.other === 'retained' && merged.hooks.PostToolUse[0].hooks[0].command === 'other' && fs.readdirSync(codexHome).some(name => name.includes('before-axmem')), 'installer preserves config and backup');
    check(merged.hooks.UserPromptSubmit.length === 1 && merged.hooks.UserPromptSubmit[0].hooks[0].commandWindows.startsWith('node.exe '), 'installer replaces only its legacy Windows command');
    if (process.platform === 'win32') {
      const installed = merged.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
      const cmdStore = path.join(temp, 'cmd-store');
      const delivered = spawnSync(process.env.ComSpec || 'cmd.exe', ['/C', `"${installed}"`], {
        windowsVerbatimArguments: true,
        input: JSON.stringify(event('UserPromptSubmit', 'cmd-turn', { session_id: 'cmd-session', prompt: 'cmd wrapper fixture' })),
        env: { ...process.env, AXMEM_CODEX_RAW_DIR: cmdStore },
        encoding: 'utf8',
      });
      check(delivered.status === 0 && fs.existsSync(path.join(cmdStore, 'raw', scope('cmd-turn', 'cmd-session'))), `Codex Windows cmd /C wrapper invokes installed hook: ${delivered.stderr}`);
    }
    spawnSync(process.execPath, [installer, codexHome], { encoding: 'utf8' });
    check(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8') === configured, 'installer idempotent');
    process.stdout.write(`codex raw self-test ${ok}/${ok}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack}\n`);
    process.stdout.write(`codex raw self-test ${ok}/${process.platform === 'win32' ? 34 : 33} FAIL\n`);
    process.exitCode = 1;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})();
