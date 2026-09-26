#!/usr/bin/env node
// AxMem Hermes bridge — detect-and-correct enforcement (D2). (P1 2.1, 2026-09-16)
// Hermes shell-hooks are single-direction stdout with no receipt channel
// (D10, best-effort delivery) and P1 wires ONLY post_tool_call / pre_llm_call
// / on_session_start / on_session_end — never pre_tool_call, so there is NO
// real blocking here, only detection queued for the next LLM turn.
//
// Usage: bridge.cjs <event>   (event JSON on stdin, per shell_hooks.py's
//        _serialize_payload: {hook_event_name, tool_name, tool_input,
//        session_id, cwd, extra})
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ctx = require('../../lib/prelude.cjs');
const queue = require('./queue.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const AXMEM_BIN = path.join(ROOT, 'bin', 'axmem');
const QUEUE_ROOT = process.env.AXMEM_HERMES_QUEUE_DIR || path.join(ctx.STATE_DIR, 'hermes-queue');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function parseInput(raw) {
  try {
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

// Normalizes a Hermes tool_input to a single file path, or null when the
// shape can't be identified (multi-file `patch` mode='patch', an unknown
// tool, etc). Hermes write tools (verified from source, see builder
// report §4.1): write_file {path, content}; patch mode='replace' {path,
// old_string, new_string}; patch mode='patch' has NO single path (a
// multi-file V4A patch body) — that shape is deliberately unmapped.
// file_path is also accepted directly for forward-compat with any
// CC-shaped tool_input a future Hermes tool might emit.
function extractPath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (typeof toolInput.path === 'string' && toolInput.path) return toolInput.path;
  if (typeof toolInput.file_path === 'string' && toolInput.file_path) return toolInput.file_path;
  return null;
}

// realpath-after-boundary check: rejects the leaf itself being a symlink,
// then resolves the full chain (junctions included — Node's realpath walks
// reparse points on Windows) and requires the result to sit strictly inside
// the memory dir's own real path (case-insensitive, this is Windows).
// Walks every ancestor directory of `p` up to the filesystem root and
// returns true the instant any of them is itself a symlink/junction
// (Node's lstat reports Windows directory junctions as isSymbolicLink()
// too — verified empirically, see builder report). This catches a
// reparse point ANYWHERE in the chain, not just at the leaf: a junction
// whose target happens to resolve back inside memory_dir is still
// rejected, since we cannot cheaply prove that ancestor hasn't been
// re-pointed between checks (D9 — can't prove, refuse rather than guess).
function hasReparsePointAncestor(p) {
  let dir = path.dirname(p);
  for (;;) {
    let st;
    try { st = fs.lstatSync(dir); } catch { return false; } // can't stat further up -> nothing more to find
    if (st.isSymbolicLink()) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false; // reached the root
    dir = parent;
  }
}

function isWithinMemoryDir(rawPath, memoryDir) {
  if (!rawPath) return { within: false, real: null };
  let real;
  try {
    const st = fs.lstatSync(rawPath);
    if (st.isSymbolicLink()) return { within: false, real: null }; // leaf itself a symlink -> reject outright
    if (hasReparsePointAncestor(rawPath)) return { within: false, real: null }; // an ancestor dir is a symlink/junction -> reject outright
    real = fs.realpathSync(rawPath);
  } catch {
    return { within: false, real: null }; // file gone / unreadable -> can't prove membership, refuse (D9 spirit)
  }
  let realMem;
  try {
    realMem = fs.realpathSync(memoryDir);
  } catch {
    return { within: false, real: null };
  }
  const a = real.toLowerCase();
  const b = realMem.toLowerCase().replace(/[\\/]+$/, '');
  const within = a === b || a.startsWith(b + path.sep.toLowerCase()) || a.startsWith(b + '/');
  return { within, real };
}

function runCapture(cmd, args, input) {
  try {
    const out = execFileSync(cmd, args, {
      input: input || '',
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], // explicit: default 'pipe' still echoes to an inherited TTY on this platform/Node combo when `input` is set — observed empirically while building the doctor smoke test
    });
    return { rc: 0, stdout: out, stderr: '' };
  } catch (e) {
    return {
      rc: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? e.stdout.toString('utf8') : '',
      stderr: e.stderr ? e.stderr.toString('utf8') : '',
    };
  }
}

function ledger(events) {
  // Append-only, best-effort ledger of queue/lock events (spec's台账). One
  // line of JSON per event; never fatal if this fails.
  if (!events || !events.length) return;
  try {
    const p = path.join(ctx.STATE_DIR, 'hermes-bridge-ledger-' + ctx.MACHINE + '.tsv');
    const rows = events.map((e) => [new Date().toISOString(), e.event || 'unknown', e.target || '', e.reason || ''].join('\t')).join('\n') + '\n';
    fs.appendFileSync(p, rows);
  } catch { /* best-effort telemetry only */ }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handlePostToolCall(input) {
  const sessionId = input.session_id || '';
  const toolName = input.tool_name || '';
  const rawPath = extractPath(input.tool_input);
  if (!rawPath) {
    ledger([{ event: 'unmapped-tool', reason: toolName }]);
    return; // no stdout either way
  }
  const { within, real } = isWithinMemoryDir(rawPath, ctx.MEMORY_DIR);
  if (!within) return; // outside the governed dir — nothing guarded changed, silent exit

  // ② axmem gate --block against the REAL directory (the write already
  // landed on disk by the time post_tool_call fires).
  // [coordinator 2026-09-17, bridge.cjs:145 false-green] `gate.rc === 2`
  // alone is not proof that write-gate.sh's OWN violation path fired —
  // core/write-gate.sh (D8, never touched) happens to only ever exit 2
  // via that one path today, which is exactly why a mutation removing
  // the `.includes('<!-- axmem-write-gate -->')` marker check scored
  // all-green against the real script: nothing in the fixture set could
  // produce rc=2 any other way to disprove it. The marker check is what
  // actually distinguishes "our specific violation" from "any other
  // process that happens to share exit code 2" — kept as defense in
  // depth against exactly that kind of coincidental-code collision, not
  // dead weight. AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE (read nowhere
  // else, unset in all normal operation) lets the self-test inject a
  // real script that returns rc=2 WITHOUT the marker, to prove this.
  // [Opus L4, 2026-09-17] Double-gated behind AXMEM_SELFTEST=1 as well:
  // a single env var alone (AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE) being
  // set by accident (misconfiguration) or by an attacker who can only
  // influence this process's environment (not its argv/invocation) must
  // never be enough, on its own, to redirect which script is actually
  // run for a real write-gate check — both vars now have to agree this
  // is a self-test run before the override takes effect.
  const gateScript = (process.env.AXMEM_SELFTEST === '1' && process.env.AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE) || path.join(ROOT, 'core', 'write-gate.sh');
  const gate = runCapture('bash', [gateScript, '--block'], '');
  if (gate.rc === 2 && gate.stderr.includes('<!-- axmem-write-gate -->')) {
    const excerpt = gate.stderr.slice(0, 2048);
    const r = queue.produce(QUEUE_ROOT, {
      sessionId,
      kind: 'write-gate',
      data: { file: real, excerpt },
    });
    // [Opus M1, 2026-09-17] queue.cjs's four entry points already merge
    // claim.events/rel.events (e.g. lock-sweep-failed) into the object
    // they return — but every produce() call SITE in this file used to
    // throw that away, only ever ledgering its OWN status/event/reason
    // fields. Spec v8.1 D11 requires those events reach the CALLER's
    // ledger, not just be present on the return value: the queue-side
    // "half" was closed, this product-layer half wasn't. Reproduced:
    // forcing sweepSiblings() to report a failure and running a real
    // post_tool_call produced a queue record but ZERO ledger lines.
    ledger(r.events);
    if (r.status === 'dropped') ledger([{ event: r.event, reason: r.reason }]);
  } else if (gate.rc === 2) {
    // rc=2 WITHOUT the marker: something else exited with the same code
    // as our gate's violation path, coincidentally or otherwise — never
    // treat it as a real write-gate hit.
    ledger([{ event: 'gate-rc2-without-marker', reason: gate.stderr.slice(0, 512) }]);
  } else if (gate.rc !== 0) {
    ledger([{ event: 'gate-unexpected-rc', reason: String(gate.rc) }]);
  }

  // ③ axmem trigger (CC-shaped stdin) — normalize tool_name -> Write so
  // core/trigger-recall.cjs's fixed TOOLS set (Edit|Write|MultiEdit|
  // NotebookEdit, unchanged — D8 core zero-change) recognizes it.
  const ccShape = JSON.stringify({ session_id: sessionId, tool_name: 'Write', tool_input: { file_path: real } });
  const trig = runCapture('node', [path.join(ROOT, 'core', 'trigger-recall.cjs')], ccShape);
  if (trig.rc === 0 && trig.stdout && trig.stdout.trim()) {
    let text = null;
    try {
      const parsed = JSON.parse(trig.stdout);
      text = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext;
    } catch {
      ledger([{ event: 'bridge-parse-error' }]);
    }
    if (text) {
      const r = queue.produce(QUEUE_ROOT, { sessionId, kind: 'recall', data: { text } });
      ledger(r.events); // [Opus M1] see the write-gate produce() call above for why
      if (r.status === 'dropped') ledger([{ event: r.event, reason: r.reason }]);
    }
  }
}

function handlePreLlmCall(input) {
  const sessionId = input.session_id || '';
  const recovered = queue.recoverOnStartup(QUEUE_ROOT);
  ledger(recovered);
  const { context, events, commit } = queue.drain(QUEUE_ROOT, sessionId);
  ledger(events);
  // [Opus M2, 2026-09-17] Test-only observability hook (env var read
  // nowhere else, unset in all normal operation): when set, appends one
  // line per call-sequence point to a plain text file, so a self-test
  // spawning this file as a real child process can, AFTER it exits,
  // read the file back and assert the WRITE actually happened before
  // COMMIT — not just trust that the code is shaped that way. Without
  // this, "stdout written before commit()" had zero assertion able to
  // fail: a mutation swapping the two calls scored all-green (Opus
  // reproduced this exactly).
  // [Opus incremental-closure LOW-b, 2026-09-17] Double-gated behind
  // AXMEM_SELFTEST=1 as well, same reasoning and same pattern as L4's fix
  // to AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE just above in this file: a
  // single env var alone (AXMEM_TEST_SEQUENCE_LOG) being set by accident
  // or by anything that can only influence this process's environment
  // must never be enough, on its own, to make real production hook calls
  // start appending to an arbitrary file path.
  const _seqLog = process.env.AXMEM_SELFTEST === '1' ? process.env.AXMEM_TEST_SEQUENCE_LOG : undefined;
  const _logSeq = (label) => { if (_seqLog) { try { fs.appendFileSync(_seqLog, label + '\n'); } catch { /* best-effort only */ } } };
  if (context) {
    // M1 (spec §2.1 v8.1, ECC ts/Opus acceptance M1): commit() — which
    // deletes the draining directory — must run ONLY after stdout has been
    // written AND actually delivered. Deleting first (the old behavior)
    // turned a crash between the two steps from "possibly re-delivered"
    // (the draining dir is still there for startup recovery's
    // draining-recovered path) into "silently lost forever" (nothing left
    // to recover), the opposite of D10's documented acceptable failure
    // mode.
    // [codex(gf) MEDIUM #6, 2026-09-17] The PREVIOUS version of this fix
    // treated `process.stdout.write()`'s own boolean RETURN VALUE as proof
    // of delivery ("true means it already reached the OS") — wrong per
    // Node's own docs: that boolean is a backpressure signal only (is the
    // internal buffer below highWaterMark), never a flush guarantee.
    // Windows pipes to a file/console happen to write synchronously, so
    // this repo's own Hermes pipe never reproduced a real loss — but a
    // POSIX pipe is asynchronous, and `write()` can legitimately return
    // `true` while the bytes are still sitting in libuv's queue, not yet
    // actually transmitted. A crash right after committing on that `true`
    // return (queue-side reproduction: write() returns true, draining dir
    // already deleted, but the write is still only
    // "pending in userland" — never reached the reader) permanently loses
    // context that was supposedly delivered. Fixed by using the WRITE
    // CALLBACK — Node's actual completion signal — as the only thing that
    // gates commit(): commit() now lives structurally inside the
    // callback, so it can never run before Node confirms the write
    // finished (successfully or not), and can never run at all if the
    // process dies before that callback fires — exactly the "keep
    // draining on a write error or process interruption" behavior D10
    // requires. The old boolean return is no longer read as a proof of
    // anything.
    process.stdout.write(JSON.stringify({ context }), (err) => {
      _logSeq(err ? 'stdout-write-callback-error' : 'stdout-write-callback-ok');
      if (!err) {
        commit();
        _logSeq('commit-called');
      }
      // on a write error: deliberately do NOT commit — the draining dir
      // stays in place, and the next process's recoverOnStartup() picks
      // it back up via its own stale-draining-dir sweep (same recovery
      // path a mid-write crash already relies on).
    });
    _logSeq('stdout-write-returned');
  }
  // else: zero output, per spec ("无记录 ⇒ 零输出") — nothing to commit either.
}

function handleOnSessionStart(input) {
  const sessionId = input.session_id || '';
  const recovered = queue.recoverOnStartup(QUEUE_ROOT);
  ledger(recovered);
  const lamp = runCapture('bash', [path.join(ROOT, 'core', 'receipt.sh'), 'session-lamp'], '');
  const text = (lamp.stdout || '').trim();
  if (text) {
    const r = queue.produce(QUEUE_ROOT, { sessionId, kind: 'lamp', data: { text } });
    ledger(r.events); // [Opus M1] see the write-gate produce() call above for why
    if (r.status === 'dropped') ledger([{ event: r.event, reason: r.reason }]);
  }
}

function handleOnSessionEnd(input) {
  const sessionId = input.session_id || '';
  // D8's one allowed core change: `receipt stop-check --no-block` — same
  // determination as CC's Stop hook, exit code forced to 0 either way (this
  // bridge has no blocking channel to use it on regardless; the ledger is
  // what's real here).
  const stdinJson = JSON.stringify({ session_id: sessionId, stop_hook_active: false });
  const res = runCapture('bash', [path.join(ROOT, 'core', 'receipt.sh'), 'stop-check', '--no-block'], stdinJson);
  ledger([{ event: 'session-end-stop-check', reason: `rc=${res.rc}` }]);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function main(argv) {
  const event = argv[0];
  const raw = readStdin();
  const input = parseInput(raw);
  switch (event) {
    case 'post_tool_call': handlePostToolCall(input); break;
    case 'pre_llm_call': handlePreLlmCall(input); break;
    case 'on_session_start': handleOnSessionStart(input); break;
    case 'on_session_end': handleOnSessionEnd(input); break;
    default:
      console.error(`bridge.cjs: unknown event ${event} (expected post_tool_call|pre_llm_call|on_session_start|on_session_end)`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Self-test — end-to-end through the real CLI (stdin -> stdout), not the
// handler functions directly, so it proves the exact wire shape a real
// Hermes shell-hook invocation would see.
// ---------------------------------------------------------------------------
function selfTest() {
  const { spawnSync, spawn } = require('child_process');
  const os = require('os');

  function freshEnv(T, { repos } = {}) {
    const memDir = path.join(T, 'mem');
    const stateDir = path.join(T, 'state');
    const homeDir = path.join(T, 'axmemhome');
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    for (const f of ['decisions.md', 'lessons.md', 'standinginstructions.md']) {
      fs.writeFileSync(path.join(memDir, f), '## Index\n\n## Entries\n');
    }
    // Isolation fix (found while adding trigger-recall coverage, see test 2b
    // below): this previously did NOT override AXMEM_HOME/AXMEM_CONFIG, so
    // trigger-recall.cjs's repo resolution (ctx.repos, read from
    // AXMEM_CONFIG) silently fell through to whatever the AMBIENT shell's
    // real ~/.axmem/config.json happens to declare — harmless for the
    // existing tests (none of them plant a trigger comment that could
    // match anything either way), but exactly the kind of "inherits real
    // environment" gap spec §3's isolation variants exist to catch.
    const configPath = path.join(homeDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ $schema_version: 1, repos: repos || [] }));
    const env = { ...process.env, AXMEM_HOME: homeDir, AXMEM_CONFIG: configPath, AXMEM_MEMORY_DIR: memDir, AXMEM_STATE_DIR: stateDir, AXMEM_HERMES_QUEUE_DIR: path.join(stateDir, 'hermes-queue') };
    // Establish write-gate's baseline at 0 BEFORE the fixture under test
    // introduces any oversize entry — write-gate.sh treats pre-existing debt
    // as grandfathered (baseline tolerance is documented, existing core
    // behavior, untouched by this task's D8 zero-core-change rule) and only
    // flags GROWTH past a previously observed count. Without this priming
    // call, a fresh AXMEM_STATE_DIR's first-ever --block run would silently
    // adopt the fixture's violation as its baseline instead of catching it
    // — caught empirically while building this very test.
    spawnSync('bash', [path.join(ROOT, 'core', 'write-gate.sh'), '--block'], { input: '', env, timeout: 8000 });
    return { env, memDir, stateDir };
  }

  function runBridge(event, inputObj, env) {
    const r = spawnSync(process.execPath, [__filename, event], {
      input: JSON.stringify(inputObj),
      encoding: 'utf8',
      env,
      timeout: 8000,
    });
    return { rc: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }
  const total = 16;

  // 1. post_tool_call with a genuine write-gate violation -> zero stdout,
  //    queue gets a write-gate record whose excerpt equals gate's stderr.
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir, stateDir } = freshEnv(T);
    const bigBody = 'x'.repeat(2000);
    const lessonsFile = path.join(memDir, 'lessons.md');
    fs.writeFileSync(lessonsFile, `## Index\n\n- 2026-01-01 [a:b] t\n\n## Entries\n\n**2026-01-01 — t** [a:b]\n${bigBody}\n`);
    const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: lessonsFile }, session_id: 'sess1' }, env);
    const key = queue.keyForSession('sess1');
    const files = fs.existsSync(path.join(stateDir, 'hermes-queue', key)) ? fs.readdirSync(path.join(stateDir, 'hermes-queue', key)) : [];
    let excerptMatches = false;
    if (files.length) {
      const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'hermes-queue', key, files[0]), 'utf8'));
      excerptMatches = rec.kind === 'write-gate' && rec.excerpt && rec.excerpt.includes('axmem-write-gate') && rec.excerpt.includes('oversize entries grew');
    }
    check('1 post_tool_call violation: zero stdout, queued write-gate record with real gate excerpt', r.rc === 0 && r.stdout.trim() === '' && files.length === 1 && excerptMatches);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 2. immediately followed by pre_llm_call -> context includes it, queue drained
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir, stateDir } = freshEnv(T);
    const bigBody = 'x'.repeat(2000);
    const lessonsFile = path.join(memDir, 'lessons.md');
    fs.writeFileSync(lessonsFile, `## Index\n\n- 2026-01-01 [a:b] t\n\n## Entries\n\n**2026-01-01 — t** [a:b]\n${bigBody}\n`);
    runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: lessonsFile }, session_id: 'sess2' }, env);
    const r2 = runBridge('pre_llm_call', { hook_event_name: 'pre_llm_call', session_id: 'sess2' }, env);
    let contextOk = false;
    try { contextOk = JSON.parse(r2.stdout).context.includes('write-gate'); } catch { /* leave false */ }
    const key = queue.keyForSession('sess2');
    const drained = !fs.existsSync(path.join(stateDir, 'hermes-queue', key));
    check('2 pre_llm_call right after: context includes it, live dir drained', r2.rc === 0 && contextOk && drained);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 2b (H3/L5, ECC ts/Opus acceptance mutation-arm fix: "matcher 改错" and
  // "正规化映射删除" were both found to be FALSE GREENS — none of the
  // existing 9 tests ever planted a trigger comment, so the entire
  // normalize-tool_input -> call trigger-recall.cjs -> parse recall
  // support (spec §2.1 table row ③) had ZERO coverage; a matcher rewired
  // to never match Hermes's real tools, or the tool_name/file_path
  // normalization deleted outright, both left every other test green.
  // This plants a REAL trigger comment and end-to-end proves: (a) a
  // kind:'recall' record reaches the queue, (b) its text is the actual
  // pushed title (proving trigger-recall.cjs's own matching succeeded,
  // which REQUIRES the exact tool_name:'Write'/tool_input.file_path shape
  // bridge.cjs must have sent it — Hermes's real tool_name is "write_file",
  // never "Write", so this could only pass if the normalization ran).
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const repoRoot = path.join(T, 'mem').split(path.sep).join('/');
    const { env, memDir, stateDir } = freshEnv(T, { repos: [{ id: 'home', roots: [repoRoot] }] });
    fs.writeFileSync(
      path.join(memDir, 'lessons.md'),
      '## Index\n\n- 2026-01-01 [test:trig] probe lesson for bridge trigger coverage\n\n## Entries\n\n**2026-01-01 — probe lesson for bridge trigger coverage** [test:trig]\n<!-- trigger: tool=Write; repo=home; path=probe.md -->\nbody\n'
    );
    const probeFile = path.join(memDir, 'probe.md');
    fs.writeFileSync(probeFile, 'hello\n');
    const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: probeFile }, session_id: 'sess2b' }, env);
    const key = queue.keyForSession('sess2b');
    const queueDir = path.join(stateDir, 'hermes-queue', key);
    let sawRecallRecord = false;
    if (fs.existsSync(queueDir)) {
      for (const f of fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'))) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8'));
          if (rec.kind === 'recall' && typeof rec.text === 'string' && rec.text.includes('test:trig')) sawRecallRecord = true;
        } catch { /* ignore unparsable */ }
      }
    }
    check(
      "2b (H3/L5) a real trigger comment produces a kind:'recall' queue record (proves tool_name->Write + path->file_path normalization actually ran)",
      r.rc === 0 && r.stdout.trim() === '' && sawRecallRecord
    );
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 3. pre_llm_call BEFORE post_tool_call -> zero output, record survives for the next drain
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir } = freshEnv(T);
    const r1 = runBridge('pre_llm_call', { hook_event_name: 'pre_llm_call', session_id: 'sess3' }, env);
    const bigBody = 'x'.repeat(2000);
    const lessonsFile = path.join(memDir, 'lessons.md');
    fs.writeFileSync(lessonsFile, `## Index\n\n- 2026-01-01 [a:b] t\n\n## Entries\n\n**2026-01-01 — t** [a:b]\n${bigBody}\n`);
    runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: lessonsFile }, session_id: 'sess3' }, env);
    const r3 = runBridge('pre_llm_call', { hook_event_name: 'pre_llm_call', session_id: 'sess3' }, env);
    let contextOk = false;
    try { contextOk = JSON.parse(r3.stdout).context.includes('write-gate'); } catch { /* leave false */ }
    check('3 pre before post -> zero output; record survives to the NEXT drain', r1.rc === 0 && r1.stdout.trim() === '' && contextOk);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 4. empty session_id -> unrouted, no per-session queue dir created
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir, stateDir } = freshEnv(T);
    const bigBody = 'x'.repeat(2000);
    const lessonsFile = path.join(memDir, 'lessons.md');
    fs.writeFileSync(lessonsFile, `## Index\n\n- 2026-01-01 [a:b] t\n\n## Entries\n\n**2026-01-01 — t** [a:b]\n${bigBody}\n`);
    runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: lessonsFile }, session_id: '' }, env);
    const unroutedFiles = fs.existsSync(path.join(stateDir, 'hermes-queue', 'unrouted')) ? fs.readdirSync(path.join(stateDir, 'hermes-queue', 'unrouted')).filter((f) => f.endsWith('.json')) : [];
    check('4 empty session_id -> unrouted, never a shared per-session dir', unroutedFiles.length === 1);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 5. unmapped tool shape (patch mode='patch', no single path) -> no stdout, no queue entry
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, stateDir } = freshEnv(T);
    const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'patch', tool_input: { mode: 'patch', patch: '*** Begin Patch\n*** End Patch' }, session_id: 'sess5' }, env);
    const queueRoot = path.join(stateDir, 'hermes-queue');
    const anyFiles = fs.existsSync(queueRoot) ? fs.readdirSync(queueRoot, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.') && fs.readdirSync(path.join(queueRoot, e.name)).some((f) => f.endsWith('.json'))) : false;
    check('5 unmapped tool_input shape (patch mode=patch) -> zero stdout, nothing queued', r.rc === 0 && r.stdout.trim() === '' && !anyFiles);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 6b (§2.1 "拒绝 symlink/junction"). A junction whose TARGET resolves back
  // inside memory_dir is still rejected — an ancestor directory being a
  // reparse point is refused regardless of where it points (D9: can't
  // cheaply prove it wasn't re-pointed between check and use). Windows
  // directory junctions don't need admin rights to create, unlike symlinks.
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir, stateDir } = freshEnv(T);
    const junctionPath = path.join(T, 'junction-into-mem');
    let junctionOk = true;
    try { fs.symlinkSync(memDir, junctionPath, 'junction'); } catch { junctionOk = false; }
    if (junctionOk) {
      const viaJunction = path.join(junctionPath, 'lessons.md');
      const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: viaJunction }, session_id: 'sess6b' }, env);
      const queueRoot = path.join(stateDir, 'hermes-queue');
      const anyFiles = fs.existsSync(queueRoot) ? fs.readdirSync(queueRoot, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.') && fs.readdirSync(path.join(queueRoot, e.name)).some((f) => f.endsWith('.json'))) : false;
      check('6b junction ancestor rejected even when its target resolves inside memory_dir', r.rc === 0 && r.stdout.trim() === '' && !anyFiles);
    } else {
      check('6b junction ancestor rejected (SKIPPED — junction creation not permitted in this environment)', true);
    }
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 6. path outside memory_dir -> silent exit, nothing queued
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, stateDir } = freshEnv(T);
    const outsideFile = path.join(T, 'outside.txt');
    fs.writeFileSync(outsideFile, 'not memory');
    const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: outsideFile }, session_id: 'sess6' }, env);
    const queueRoot = path.join(stateDir, 'hermes-queue');
    const anyFiles = fs.existsSync(queueRoot) ? fs.readdirSync(queueRoot, { withFileTypes: true }).some((e) => e.isDirectory() && !e.name.startsWith('.') && fs.readdirSync(path.join(queueRoot, e.name)).some((f) => f.endsWith('.json'))) : false;
    check('6 path outside memory_dir -> silent exit, nothing queued', r.rc === 0 && r.stdout.trim() === '' && !anyFiles);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 7. on_session_start queues the session-lamp text when receipts are pending
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, stateDir } = freshEnv(T);
    spawnSync('bash', [path.join(ROOT, 'core', 'receipt.sh'), 'add', 'test-kind', 'ref', 'a pending fact'], { env: { ...env, AXMEM_SESSION_ID: 'seed' } });
    const r = runBridge('on_session_start', { hook_event_name: 'on_session_start', session_id: 'sess7' }, env);
    const key = queue.keyForSession('sess7');
    const files = fs.existsSync(path.join(stateDir, 'hermes-queue', key)) ? fs.readdirSync(path.join(stateDir, 'hermes-queue', key)) : [];
    let isLamp = false;
    if (files.length) { const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'hermes-queue', key, files[0]), 'utf8')); isLamp = rec.kind === 'lamp'; }
    check('7 on_session_start queues a lamp record when receipts are pending', r.rc === 0 && isLamp);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 8. on_session_end always exits 0 regardless of pending receipts (D8's
  //    one allowed core change: stop-check --no-block)
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env } = freshEnv(T);
    spawnSync('bash', [path.join(ROOT, 'core', 'receipt.sh'), 'add', 'test-kind', 'ref', 'a pending fact'], { env: { ...env, AXMEM_SESSION_ID: 'seed8' } });
    const r = runBridge('on_session_end', { hook_event_name: 'on_session_end', session_id: 'sess8' }, env);
    check('8 on_session_end never blocks (rc 0) even with pending receipts', r.rc === 0);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 9 (ts M6): AXMEM_STATE_DIR given in MSYS form (exactly as a user's Git
  // Bash session would export it, e.g. "/c/Users/x/AppData/Local/Temp/...")
  // must produce a queue file at the CORRECT native path — not silently
  // under the wrong "C:\c\..." location Windows Node's own path.resolve()
  // would produce without lib/prelude.cjs's normalizeMsysPath() fix (see
  // lib/msys-path.cjs). Deliberately does NOT set AXMEM_HERMES_QUEUE_DIR
  // directly (unlike freshEnv()'s other tests) so bridge.cjs is forced to
  // derive QUEUE_ROOT from ctx.STATE_DIR — the exact code path this fix
  // targets.
  if (process.platform === 'win32') {
    const T = fs.mkdtempSync(fs.realpathSync(os.tmpdir()) + path.sep + 'axmem-bridge-st-msys-' + Date.now());
    fs.mkdirSync(T, { recursive: true });
    const memDir = path.join(T, 'mem');
    const nativeStateDir = path.join(T, 'state');
    const homeDir = path.join(T, 'axmemhome');
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(nativeStateDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    for (const f of ['decisions.md', 'lessons.md', 'standinginstructions.md']) {
      fs.writeFileSync(path.join(memDir, f), '## Index\n\n## Entries\n');
    }
    fs.writeFileSync(path.join(homeDir, 'config.json'), JSON.stringify({ $schema_version: 1, repos: [] }));
    // Native -> MSYS form ("C:\a\b" -> "/c/a/b") — the INVERSE of what
    // normalizeMsysPath() converts back; this is what `export
    // AXMEM_STATE_DIR=...` looks like from an actual Git Bash session.
    const msysStateDir = path.resolve(nativeStateDir).replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');
    const env = { ...process.env, AXMEM_HOME: homeDir, AXMEM_CONFIG: path.join(homeDir, 'config.json'), AXMEM_MEMORY_DIR: memDir, AXMEM_STATE_DIR: msysStateDir };
    delete env.AXMEM_HERMES_QUEUE_DIR;
    spawnSync('bash', [path.join(ROOT, 'core', 'write-gate.sh'), '--block'], { input: '', env, timeout: 8000 }); // same baseline-priming freshEnv() does
    const bigBody = 'x'.repeat(2000);
    const lessonsFile = path.join(memDir, 'lessons.md');
    fs.writeFileSync(lessonsFile, `## Index\n\n- 2026-01-01 [a:b] t\n\n## Entries\n\n**2026-01-01 — t** [a:b]\n${bigBody}\n`);
    const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: lessonsFile }, session_id: 'sess-msys' }, env);
    const key = queue.keyForSession('sess-msys');
    const nativeRecordDir = path.join(nativeStateDir, 'hermes-queue', key);
    let landedCorrectly = false;
    try { landedCorrectly = fs.readdirSync(nativeRecordDir).some((f) => f.endsWith('.json')); } catch { landedCorrectly = false; }
    // The wrong shape Windows Node's path.resolve('/c/...') alone would
    // produce: "C:\c\<rest-of-the-native-path-without-its-own-drive>".
    const wrongDir = path.join('C:\\c', nativeStateDir.replace(/^[A-Za-z]:\\?/, ''), 'hermes-queue', key);
    check('9 (ts M6) AXMEM_STATE_DIR in MSYS form (/c/...) -> bridge/queue record lands at the correct native path, never C:\\c\\...',
      r.rc === 0 && landedCorrectly && !fs.existsSync(wrongDir));
    fs.rmSync(T, { recursive: true, force: true });
  } else {
    check('9 (ts M6) MSYS-path bridge/queue integration test skipped: not running on win32', true);
  }

  // 10 (coordinator 2026-09-17, bridge.cjs:145 false-green): a "gate" that
  // exits 2 WITHOUT the '<!-- axmem-write-gate -->' marker must never be
  // treated as a real write-gate violation — core/write-gate.sh itself
  // (D8, untouched) only ever exits 2 via that one marked path today, so
  // this can only be exercised by injecting a fake gate script through
  // the test-only AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE seam.
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir, stateDir } = freshEnv(T);
    const fakeGate = path.join(T, 'fake-gate-rc2-no-marker.sh');
    fs.writeFileSync(fakeGate, '#!/usr/bin/env bash\necho "unrelated tool also exits 2" >&2\nexit 2\n');
    const targetFile = path.join(memDir, 'decisions.md');
    fs.writeFileSync(targetFile, 'some real content\n');
    const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: targetFile }, session_id: 'sess10' }, { ...env, AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE: fakeGate, AXMEM_SELFTEST: '1' });
    const key = queue.keyForSession('sess10');
    const queueDir = path.join(stateDir, 'hermes-queue', key);
    let hasWriteGateRecord = false;
    try {
      for (const f of fs.readdirSync(queueDir)) {
        const rec = JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8'));
        if (rec.kind === 'write-gate') hasWriteGateRecord = true;
      }
    } catch { /* no queue dir at all is also a pass */ }
    check('10 (bridge.cjs:145) a fake gate that exits 2 WITHOUT the axmem-write-gate marker never produces a write-gate queue record', r.rc === 0 && r.stdout.trim() === '' && !hasWriteGateRecord);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 11 (Opus M1): queue.cjs's four entry points already merge
  // claim.events/rel.events (e.g. lock-sweep-failed) into whatever they
  // return, but every produce() call SITE in this file used to throw
  // that value away — only ever ledgering its own status/event/reason
  // fields, never `r.events`. Forces a REAL sweep failure the same way
  // lib/lock.cjs's own §9.7 test does (a still-running child process
  // with its CWD pinned inside a stale sibling `.claim-*` directory,
  // which reliably makes rmSync fail with EPERM on Windows), then runs a
  // real post_tool_call that hits a real produce() call, and asserts the
  // ledger TSV file actually contains a lock-sweep-failed line — not
  // just that produce()'s return value technically carried one.
  if (process.platform === 'win32') {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir, stateDir } = freshEnv(T);
    const queueRoot = path.join(stateDir, 'hermes-queue');
    fs.mkdirSync(queueRoot, { recursive: true });
    const lockPath = path.join(queueRoot, '.admission.lock');
    const staleClaimDir = `${lockPath}.claim-stale-forced-m1`;
    fs.mkdirSync(staleClaimDir, { recursive: true });
    fs.writeFileSync(path.join(staleClaimDir, 'owner.json'), '{}');
    const oldTime = (Date.now() - 2500) / 1000; // older than lib/lock.cjs's STALE_CLAIM_MS (2000ms)
    fs.utimesSync(staleClaimDir, oldTime, oldTime);
    const blocker = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 8000)'], { cwd: staleClaimDir, stdio: 'ignore' });
    // Synchronous pause (execFileSync -> spawnSync internally, no event
    // loop involved, so no risk of the busy-wait/event-loop-starvation
    // class of bug) so the blocker has actually started with that CWD
    // before produce() tries to sweep it.
    try { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 300)']); } catch { /* best-effort pacing only */ }

    const targetFile = path.join(memDir, 'decisions.md');
    const bigBody = 'x'.repeat(2000);
    fs.writeFileSync(targetFile, `## Index\n\n- 2026-01-01 [a:b] t\n\n## Entries\n\n**2026-01-01 — t** [a:b]\n${bigBody}\n`);
    const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: targetFile }, session_id: 'sess11' }, env);

    blocker.kill();
    try { fs.rmSync(staleClaimDir, { recursive: true, force: true }); } catch { /* best-effort cleanup now that the blocker is dead */ }

    const ledgerPath = fs.existsSync(stateDir)
      ? fs.readdirSync(stateDir).map((f) => path.join(stateDir, f)).find((f) => /hermes-bridge-ledger-.*\.tsv$/.test(f))
      : null;
    let ledgerHasSweepFailed = false;
    if (ledgerPath) {
      try { ledgerHasSweepFailed = fs.readFileSync(ledgerPath, 'utf8').includes('lock-sweep-failed'); } catch { /* leave false */ }
    }
    check('11 (Opus M1) a real sweep failure during a real post_tool_call produces a lock-sweep-failed line in the ledger TSV (not just on produce()\'s return value)', r.rc === 0 && ledgerHasSweepFailed);
    fs.rmSync(T, { recursive: true, force: true });
  } else {
    check('11 (Opus M1) lock-sweep-failed ledger test skipped: not running on win32 (the CWD-pinning failure mode is Windows-specific)', true);
  }

  // 12 (Opus M2, strengthened by codex(gf) MEDIUM #6): "stdout written
  // before commit()" had NO assertion that could actually fail — queue.cjs's
  // own test 1 only proves drain() itself never deletes the draining dir,
  // which stays true regardless of what ORDER bridge.cjs calls
  // stdout.write() vs commit() in. Uses the AXMEM_TEST_SEQUENCE_LOG hook
  // (see handlePreLlmCall) to spawn a real pre_llm_call and assert the
  // sequence log shows the write CALLBACK firing before commit — not just
  // that stdout.write() was CALLED before commit, which the old
  // return-value-gated code already satisfied even though it was wrong.
  //
  // codex's own ask was to simulate a payload larger than typical stream
  // highWaterMark thresholds ("自测里模拟大载荷(> highWaterMark)"), so a
  // trivially small write couldn't mask a regression. Accumulates several
  // REAL write-gate violations across several real post_tool_call
  // invocations for the same session (each contributing its own queued
  // record) rather than one giant entry: a single oversized entry's own
  // violation MESSAGE is a short, constant-shape diagnostic line
  // (write-gate.sh deliberately reports "oversize entries grew N->M", not
  // a full dump of the offending content) regardless of how oversized the
  // entry itself is, so growing ONE entry does not grow the resulting
  // queued record — empirically confirmed while building this test.
  // Capped at 10 accumulated violations (~2.9KB combined context,
  // meaningfully larger than a single record's ~300 bytes) as a practical
  // balance: each extra violation costs a full subprocess spawn, and
  // pushing all the way to CONTEXT_MAX_BYTES (16KB) would need ~50+ of
  // them, adding minutes to this one test alone. The property under test
  // (commit() living structurally INSIDE the write callback) does not
  // depend on payload size to be correct or to be provably tested by a
  // real async write+callback round trip — this scale is a genuine,
  // non-trivial multi-record accumulation, not a single toy record.
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir } = freshEnv(T);
    const lessonsFile = path.join(memDir, 'lessons.md');
    for (let i = 0; i < 10; i++) {
      const growingBody = 'x'.repeat(2000 + i * 500);
      fs.writeFileSync(lessonsFile, `## Index\n\n- 2026-01-01 [a:b${i}] t${i}\n\n## Entries\n\n**2026-01-01 — t${i}** [a:b${i}]\n${growingBody}\n`);
      runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: lessonsFile }, session_id: 'sess12' }, env);
    }
    const seqLog = path.join(T, 'sequence.log');
    const r = runBridge('pre_llm_call', { hook_event_name: 'pre_llm_call', session_id: 'sess12' }, { ...env, AXMEM_TEST_SEQUENCE_LOG: seqLog, AXMEM_SELFTEST: '1' });
    let sequenceOk = false;
    let sawAccumulatedContext = false;
    try {
      sawAccumulatedContext = r.stdout.length > 2500; // confirms multiple records really did accumulate, not just one
      const lines = fs.readFileSync(seqLog, 'utf8').trim().split('\n');
      sequenceOk = lines.length === 3 && lines[0] === 'stdout-write-returned' && lines[1] === 'stdout-write-callback-ok' && lines[2] === 'commit-called';
    } catch { /* leave false — no sequence log means nothing was observed */ }
    check('12 (Opus M2 / codex(gf) MEDIUM #6) real pre_llm_call with several accumulated records: commit() only runs from inside the write callback, never gated by write()\'s boolean return alone', r.rc === 0 && sawAccumulatedContext && sequenceOk);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 13 (Opus L4). AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE alone, WITHOUT
  // AXMEM_SELFTEST=1 also set, must be completely inert — a single env
  // var being set by accident (misconfiguration) or by anything that can
  // only influence this process's environment must never redirect which
  // gate script actually runs. Fake gate's OWN side effect (writing a
  // marker file nothing else in this test touches) is checked directly,
  // rather than inferring through the write-gate queue's content-dependent
  // judgment — unambiguous regardless of whether the REAL core/write-
  // gate.sh happens to fire on this fixture's content or not.
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir } = freshEnv(T);
    const markerFile = path.join(T, 'fake-gate-was-invoked.marker');
    const fakeGate = path.join(T, 'fake-gate-rc2-marker-writer.sh');
    fs.writeFileSync(fakeGate, `#!/usr/bin/env bash\ntouch '${markerFile}'\necho "<!-- axmem-write-gate -->fake block" >&2\nexit 2\n`);
    const targetFile = path.join(memDir, 'decisions.md');
    fs.writeFileSync(targetFile, 'some real content\n');
    // Deliberately NOT setting AXMEM_SELFTEST here — this is the exact
    // scenario the double-gate must reject.
    const r = runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: targetFile }, session_id: 'sess13' }, { ...env, AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE: fakeGate });
    check('13 (Opus L4) AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE without AXMEM_SELFTEST=1 is inert (fake gate script never invoked)', r.rc === 0 && !fs.existsSync(markerFile));
    fs.rmSync(T, { recursive: true, force: true });
  }

  // 14 (Opus incremental-closure LOW-b). AXMEM_TEST_SEQUENCE_LOG alone,
  // WITHOUT AXMEM_SELFTEST=1 also set, must be completely inert — same
  // double-gate reasoning as test 13's AXMEM_TEST_WRITE_GATE_SCRIPT_OVERRIDE
  // check, applied to the OTHER test-only observability hook in this file.
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-bridge-st-'));
    const { env, memDir } = freshEnv(T);
    const bigBody = 'x'.repeat(2000);
    const lessonsFile = path.join(memDir, 'lessons.md');
    fs.writeFileSync(lessonsFile, `## Index\n\n- 2026-01-01 [a:b] t\n\n## Entries\n\n**2026-01-01 — t** [a:b]\n${bigBody}\n`);
    runBridge('post_tool_call', { hook_event_name: 'post_tool_call', tool_name: 'write_file', tool_input: { path: lessonsFile }, session_id: 'sess14' }, env);
    const seqLog14 = path.join(T, 'sequence14.log');
    // Deliberately NOT setting AXMEM_SELFTEST here — this is the exact
    // scenario the double-gate must reject.
    const r = runBridge('pre_llm_call', { hook_event_name: 'pre_llm_call', session_id: 'sess14' }, { ...env, AXMEM_TEST_SEQUENCE_LOG: seqLog14 });
    check('14 (Opus incremental-closure LOW-b) AXMEM_TEST_SEQUENCE_LOG without AXMEM_SELFTEST=1 is inert (no sequence log written)', r.rc === 0 && !fs.existsSync(seqLog14));
    fs.rmSync(T, { recursive: true, force: true });
  }

  console.log(results.join('\n'));
  console.log(`bridge self-test ${ok}/${total}`);
  return ok === total ? 0 : 1;
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') {
    process.exit(selfTest());
  } else {
    main(process.argv.slice(2));
  }
}

module.exports = { extractPath, isWithinMemoryDir, handlePostToolCall, handlePreLlmCall, handleOnSessionStart, handleOnSessionEnd };
