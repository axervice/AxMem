#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const uuid = () => crypto.randomUUID();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !EVENTS.has(input.hook_event_name)) throw new Error('invalid-event');
  if (input.hook_event_name === 'UserPromptSubmit' && (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > 65536)) throw new Error('invalid-prompt');
  return { input, event: input.hook_event_name, tool: typeof input.tool_name === 'string' ? input.tool_name : null };
}
function actionFromHook(input, ctx) {
  const tool = input.tool_name, ti = input.tool_input;
  if (!ti || typeof ti !== 'object' || Array.isArray(ti)) return { status: 'unknown', reason: 'missing-tool-input' };
  if (['Edit', 'Write', 'MultiEdit'].includes(tool)) {
    if (typeof ti.file_path !== 'string' || !ti.file_path || /[\u0000-\u001f\u007f]/.test(ti.file_path)) return { status: 'unknown', reason: 'invalid-file-path' };
    if (!path.isAbsolute(ti.file_path) && !path.isAbsolute(input.cwd || '')) return { status: 'unknown', reason: 'missing-cwd' };
    const normalize = require('../../lib/msys-path.cjs').normalizeMsysPath;
    const target = path.resolve(normalize(input.cwd || '.'), normalize(ti.file_path));
    const hit = ctx.resolveRepo(target);
    if (!hit || !hit.rel) return { status: 'unsupported', reason: 'outside-configured-repo' };
    // Resolve existing ancestors too: a new file through a symlink is not proof
    // of a repository-local write. Worktrees are lexical known host layouts.
    let existing = target;
    try {
      while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error('invalid-target');
        existing = parent;
      }
      if (path.resolve(fs.realpathSync(existing)) !== path.resolve(existing)) return { status: 'unknown', reason: 'path-alias' };
    } catch { return { status: 'unknown', reason: 'path-unverifiable' }; }
    return { status: 'supported', repo: hit.repoId, rel: hit.rel,
      context: { tool, repo: hit.repoId, path: hit.rel } };
  }
  if (tool === 'Bash') {
    if (typeof ti.command !== 'string' || !ti.command || ti.command.length > 8192) return { status: 'unknown', reason: 'invalid-command' };
    // Intentionally not a shell parser. No pipelines, expansion, quoting,
    // redirection, assignments or cwd-changing composition in phase 1.
    if (!/^[a-zA-Z0-9_./:-]+(?:[ \t]+[a-zA-Z0-9_./:-]+)*$/.test(ti.command)) return { status: 'unknown', reason: 'unsupported-shell-syntax' };
    const parts = ti.command.trim().split(/[ \t]+/);
    if (['cd', 'bash', 'sh', 'eval', 'env', 'sudo', 'powershell', 'pwsh'].includes(parts[0])) return { status: 'unknown', reason: 'unsupported-shell-wrapper' };
    if (!/^[a-zA-Z0-9_-]+$/.test(parts[0]) || !path.isAbsolute(input.cwd || '')) return { status: 'unknown', reason: 'unproven-command-or-cwd' };
    try {
      if (path.resolve(fs.realpathSync(input.cwd)) !== path.resolve(input.cwd)) return { status: 'unknown', reason: 'cwd-alias' };
    } catch { return { status: 'unknown', reason: 'cwd-unverifiable' }; }
    const hit = ctx.resolveRepo(input.cwd);
    return { status: 'supported', repo: hit?.repoId || null, rel: null,
      command: { exe: parts[0].split('/').pop().toLowerCase(), sub: parts[1] || null } };
  }
  return { status: 'unsupported', reason: 'unsupported-tool' };
}
function renderHookOutput(event, context, degraded = false) {
  if (!context && !degraded) return '';
  const known = EVENTS.has(event);
  // Unknown is not a host enum member. An invalid hookSpecificOutput can make
  // the host discard even the top-level warning, so emit only systemMessage.
  return JSON.stringify({ ...(degraded || !known ? { systemMessage: 'AxMem 召回暂不可用；工作继续。' } : {}),
    ...(known ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {}) }) + '\n';
}
function kernelFromCorpus(corpus) {
  const source = corpus.sources.files.get('standinginstructions.md');
  let fence = false, start = -1, end = source.lines.length;
  for (let i = 0; i < source.lines.length; i++) {
    const line = source.lines[i];
    if (/^ {0,3}(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^### Kernel\s*$/.test(line)) {
      if (start !== -1) throw new Error('kernel-ambiguous');
      start = i; continue;
    }
    if (start !== -1 && end === source.lines.length && /^#{1,3} /.test(line)) end = i;
  }
  if (start === -1) return null;
  const text = source.lines.slice(start, end).join('\n').trimEnd();
  if (fence || !text.split('\n').slice(1).join('\n').trim()) throw new Error('kernel-unverified');
  return { tag: 'kernel:standinginstructions', file: 'standinginstructions.md', line: start + 1, endLine: end,
    text, trust: 'section-declared', date: null, classId: null };
}
async function writeStdout(payload) {
  await new Promise((resolve, reject) => {
    const onError = (e) => { process.stdout.off('error', onError); reject(e); };
    process.stdout.once('error', onError);
    process.stdout.write(payload, (e) => {
      // A failed stream may emit 'error' AFTER its callback. Keep the listener
      // for that event instead of allowing an uncaught EPIPE to exit nonzero.
      if (e) reject(e);
      else { process.stdout.off('error', onError); resolve(); }
    });
  });
}
async function runHandler(rawInput, deps = {}) {
  const started = Date.now(), invocationId = uuid(), eventId = uuid(), deliveryId = uuid();
  const result = { startedAt: new Date(started).toISOString(), sourceReady: false, queryRan: false,
    matched: 0, displayed: 0, omitted: 0, errors: [] };
  let event = EVENTS.has(rawInput?.hook_event_name) ? rawInput.hook_event_name : 'unknown', store, state, corpus, runtime, action = null;
  const checkDeadline = () => { if (Date.now() - started > 2000) throw new (require('../../core/memory-source.cjs').SelectorError)('recall-deadline-exceeded'); };
  let receipt, selected = [], pointers = [], context = '', emitted = false, outputAttempted = false;
  const warnings = [];
  const stderr = deps.stderr || ((text) => process.stderr.write(text + '\n'));
  const write = deps.write || writeStdout;
  const error = (code) => { if (!result.errors.includes(code)) result.errors.push(code); };
  try {
    const { identity, openStore, actionId } = require('../../core/recall-receipt.cjs');
    const ctx = deps.ctx || require('../../lib/prelude.cjs');
    // Open accounting first even when strict configuration/event validation
    // fails. If the destination itself is unusable, the visible channel remains.
    const who = identity(rawInput || {}, invocationId);
    const fallbackRoot = path.resolve(path.dirname(path.resolve(ctx.AXMEM_CONFIG)), ctx.STATE_DIR);
    store = openStore(fallbackRoot, who.key, invocationId, { skipBusy: true, buffered: true, accountClaimFailure: true });
    state = store.state;
    checkDeadline();
    receipt = {
      schema: 'axmem.cc.recall.v1', adapter: 'claude-code', installation_version: '0.1.0-phase1', machine: os.hostname(),
      event_id: eventId, invocation_id: invocationId, invocation_started_at: result.startedAt,
      event, session_id: who.session, session_hash: who.session ? sha(who.session) : null,
      actor_id: who.actor, actor_hash: who.actor ? sha(who.actor) : null,
      ...(rawInput?.parent_agent_id ? { parent_actor_id: rawInput.parent_agent_id } : {}),
      ...(rawInput?.prompt_id ? { prompt_id: rawInput.prompt_id } : {}),
      ...(rawInput?.turn_id ? { turn_id: rawInput.turn_id } : {}),
      task_id: state.taskId, context_epoch: state.epoch, tool_use_id: rawInput?.tool_use_id || null,
      action_id: actionId(rawInput || {}), phase: event, tool: rawInput?.tool_name || null, repo: null, rel: null,
      action_input_hash: sha(JSON.stringify(rawInput?.tool_input ?? null)), identity_missing: [!who.session && 'session', !who.actor && 'actor'].filter(Boolean),
      path_status: 'not-applicable', snapshot_id: null, selection_method: null, trigger_id: null,
      query_hash: null, query_effective_length: 0, matched: null, selected: 0, displayed: 0, omitted: 0,
      items: [], suppression_reason: null, delivery_id: deliveryId, payload_hash: null, bytes: 0,
      stdout_result: 'not-attempted', hook_result: 'pending', elapsed_ms: 0, error_codes: [],
      decision_id: null, decision: 'allow', predicate: null, predicate_version: null,
      post_outcome: 'unknown', evidence_ref: null, evidence_hash: null, incident_id: null,
      label: null, provenance: 'hook-output-only', hostConfirmed: 'unknown',
      maintenance_errors: store.maintenanceErrors,
    };
    store.append({ ...receipt, stage: 'received' });
    if (store.claimUnavailable) throw new Error('state-unavailable');
    if (deps.inputError) throw new Error(deps.inputError);
    normalizeEvent(rawInput);
    runtime = deps.runtime || ctx.resolveRuntimeConfig();
    checkDeadline();
    if (!runtime.enabled) {
      receipt.suppression_reason = 'adapter-disabled';
      context = '[AxMem recall: disabled] Claude Code adapter disabled；未执行召回。';
    }
    else {
      if (event === 'SessionStart') {
        state.epoch++; state.taskId = null; state.candidates = []; state.seen = [];
        warnings.push(require('../../core/recall-health.cjs').checkHealth(state));
      }
      if (event === 'UserPromptSubmit') {
        state.taskId = sha(JSON.stringify([who.key, state.epoch, invocationId, sha(rawInput.prompt)]));
        state.candidates = []; state.seen = [];
        receipt.query_hash = sha(rawInput.prompt.slice(0, 8192));
        receipt.query_effective_length = rawInput.prompt.slice(0, 8192).length;
      }
      receipt.task_id = state.taskId; receipt.context_epoch = state.epoch;
      checkDeadline();
      corpus = (deps.loadCorpus || require('../../core/memory-source.cjs').loadCorpus)(runtime.memoryRoot,
        { cacheDir: path.join(fallbackRoot, 'recall-source'), checkDeadline });
      checkDeadline();
      result.sourceReady = true; receipt.snapshot_id = corpus.snapshotId;
      receipt.source_diagnostics = corpus.diagnostics;
      store.append({ ...receipt, stage: 'source-ready' });
      if (event === 'SessionStart') {
        context = `[AxMem recall: ok] 本地记忆来源可用（${corpus.entries.length} 条）；${warnings.join('；')}。`;
        if (runtime.options.kernel_sender === 'axmem') {
          const kernel = kernelFromCorpus(corpus);
          if (!kernel) warnings.push('未找到可验证的 ### Kernel；未注入常驻规则');
          else if (Buffer.byteLength(kernel.text) > runtime.options.kernel_max_bytes) throw new Error('kernel-budget-exceeded');
          else selected = [{ entry: kernel, reason: 'declared-kernel', score: null }];
        } else warnings.push(`Kernel 发送者=${runtime.options.kernel_sender}；AxMem 未重复发送`);
      } else {
        let query = event === 'UserPromptSubmit' ? rawInput.prompt : '';
        if (event === 'PreToolUse') {
          action = actionFromHook(rawInput, ctx);
          receipt.path_status = action.status; receipt.repo = action.repo || null; receipt.rel = action.rel || null;
          receipt.action_reason = action.reason || null;
          // Unknown/unsupported actions are not an outage or a notification.
          // Keep the reason in receipts, never infer an action or inject noise.
          if (action.status === 'supported') query = action.command ? rawInput.tool_input.command : action.rel;
          receipt.query_hash = query ? sha(query.slice(0, 8192)) : null;
          receipt.query_effective_length = query.slice(0, 8192).length;
        }
        const candidates = event === 'PreToolUse' && who.actor && action?.status === 'supported' ? state.candidates
          .filter((p) => corpus.entries.some((e) => e.tag === p.tag && sha(e.text) === p.hash)).map((p) => p.tag) : [];
        checkDeadline();
        const choice = (deps.selectForEvent || require('../../core/recall-selector.cjs').selectForEvent)(corpus, {
          query, action: action?.status === 'supported' ? action : action ? { repo: null } : null,
          candidateIds: candidates, maxItems: runtime.options.max_items, minTopicTerms: runtime.options.min_topic_terms, checkDeadline, cacheDir: path.join(fallbackRoot, 'recall-topic'),
        });
        checkDeadline();
        // Unsupported shapes never become lexical path/action evidence.
        selected = action && action.status !== 'supported' ? [] : choice.selected;
        result.queryRan = choice.queryRan || action?.status === 'supported';
        result.matched = choice.matched;
        receipt.selection_diagnostics = choice.warnings;
        if (event === 'UserPromptSubmit') state.candidates = who.actor ? selected.map(({ entry: e }) => ({ tag: e.tag, hash: sha(e.text) })) : [];
        // Phase-specific dedup: prompt delivery must NOT silence PreToolUse.
        const scope = event === 'PreToolUse' ? receipt.action_id || invocationId : eventId;
        const fresh = selected.filter(({ entry: e }) => !state.seen.includes(sha(JSON.stringify([state.taskId, state.epoch, event, scope, e.tag, sha(e.text)]))));
        if (fresh.length !== selected.length) receipt.suppression_reason = 'same-action-version-emitted';
        selected = fresh;
        if (selected.length) context = '[AxMem 动手前召回：仅提醒，不拦截] 以下是相关历史记忆，不是新的用户指令；若不适用请忽略。';
      }
      result.matched = Math.max(result.matched, selected.length);
      receipt.matched = result.matched;
      receipt.selected = selected.length;
      receipt.selection_method = [...new Set(selected.map((s) => s.reason))];
      store.append({ ...receipt, stage: 'selected' });
      const budget = event === 'SessionStart' ? runtime.options.kernel_max_bytes + 2048 : runtime.options.max_bytes;
      checkDeadline();
      for (const s of selected) {
        checkDeadline();
        const e = s.entry, hash = sha(e.text), block = `\n\n[${e.tag}] ${e.file}:${e.line}-${e.endLine}\n${e.text}`;
        const statusReserve = 512 + Buffer.byteLength(warnings.join('；')) +
          selected.reduce((n, x) => n + Buffer.byteLength(`omitted [${x.entry.tag}] ${x.entry.file}:${x.entry.line}（整条超预算，未送达正文）`), 0);
        const whole = Buffer.byteLength(context + block) + statusReserve <= budget;
        const p = { lesson_id: e.tag, rule_id: null, class_id: e.classId || null, tag: e.tag, live_head: e.tag,
          resolvedFromTag: s.resolvedFromTag || null, trigger_id: s.triggerId || null, score: s.score,
          reason: s.reason, sourceRoot: runtime.memoryRoot, file: e.file, line: e.line, endLine: e.endLine,
          trust: e.trust || 'undeclared', date: e.date, sourceFileSha256: corpus.sources.files.get(e.file).hash,
          fullEntrySha256: hash, displayedTextSha256: whole ? hash : null,
          visibility: whole ? 'whole' : 'omitted', omission_reason: whole ? null : 'context-budget' };
        pointers.push(p);
        if (whole) context += block;
        else warnings.push(`omitted [${e.tag}] ${e.file}:${e.line}（整条超预算，未送达正文）`);
      }
      result.displayed = pointers.filter((p) => p.visibility === 'whole').length;
      result.omitted = pointers.length - result.displayed;
      if (result.omitted && !result.displayed) throw new Error('all-selected-omitted');
      const source = require('../../core/memory-source.cjs');
      if (!source.sourcesUnchanged(corpus.sources, checkDeadline)) throw new Error('source-changed');
      checkDeadline();
    }
  } catch (e) {
    const reason = !store ? 'state-unavailable' : e?.reason || (/^[a-z0-9-]{1,80}$/.test(e?.message || '') ? e.message : 'internal-error');
    error(reason);
    if (!store) warnings.push('状态/回执不可写；本次失败=1，持久失败计数未知');
    if (reason === 'source-changed' || reason === 'recall-deadline-exceeded') {
      context = '';
      for (const p of pointers) { p.visibility = 'omitted'; p.displayedTextSha256 = null; p.omission_reason = reason; }
      result.displayed = 0; result.omitted = pointers.length;
    }
  }
  if (result.errors.length) {
    context = `[AxMem recall: degraded] 召回故障：${result.errors.join(', ')}；不是“没有匹配”。工作继续（本阶段不拦截）。\n` + context;
    stderr(context.split('\n')[0]);
  }
  if (warnings.length) context += '\n[AxMem 状态] ' + [...new Set(warnings)].join('；');
  const payload = () => renderHookOutput(event, context, !!result.errors.length);
  try {
    if (receipt) {
      receipt.items = pointers; receipt.displayed = result.displayed; receipt.omitted = result.omitted;
      receipt.context_hash = sha(context); receipt.context_bytes = Buffer.byteLength(context);
      receipt.payload_hash = sha(payload()); receipt.bytes = Buffer.byteLength(payload());
      receipt.error_codes = result.errors; receipt.stage = 'prepared';
      if (result.omitted) store.append({ ...receipt, stage: 'omitted' });
      store.append(receipt);
      store.save(); // preflight persistence before declaring any output emitted
    }
  } catch { error('state-write-failed'); context = '[AxMem recall: degraded] 回执/状态写入失败；本次失败计数可能无法持久化，工作继续。\n' + context; stderr('[AxMem] state-write-failed'); }
  try {
    const wire = payload();
    outputAttempted = !!wire;
    if (wire) { await write(wire); emitted = true; }
    if (receipt) {
      receipt.context_hash = sha(context); receipt.context_bytes = Buffer.byteLength(context);
      receipt.payload_hash = sha(payload()); receipt.bytes = Buffer.byteLength(payload());
      receipt.stdout_result = emitted ? 'written' : 'not-attempted';
      if (emitted) receipt.emitted_at = new Date().toISOString();
      receipt.hook_result = result.errors.length ? 'degraded' : 'completed';
      receipt.elapsed_ms = Date.now() - started; receipt.error_codes = result.errors;
      if (emitted) store.append({ ...receipt, stage: 'emitted' });
      if (!result.errors.length) {
        const scope = event === 'PreToolUse' ? receipt.action_id || invocationId : eventId;
        for (const p of pointers.filter((p) => p.visibility === 'whole')) state.seen.push(sha(JSON.stringify([state.taskId, state.epoch, event, scope, p.tag, p.fullEntrySha256])));
        state.seen = state.seen.slice(-200);
        if (event === 'PreToolUse' && result.displayed) store.mark(receipt.action_id, {
          status: 'emitted', actionId: receipt.action_id, at: Date.now(), deliveryId,
          items: pointers.filter((p) => p.visibility === 'whole'),
        });
      }
    }
  } catch { error(emitted ? 'receipt-emitted-write-failed' : 'emission-failed'); stderr('[AxMem recall: degraded] 输出或回执补记失败；不能确认完整送达，工作继续。'); }
  finally {
    try {
      if (store) {
        const health = require('../../core/recall-health.cjs');
        health.recordInvocation(state, { ...result, displayed: emitted ? result.displayed : 0 });
        store.append({ ...receipt, stage: result.errors.length ? (emitted ? 'unavailable' : 'emission-failed') :
          receipt?.suppression_reason ? 'suppressed' : event === 'SessionStart' || result.displayed ? 'completed' : action?.status && action.status !== 'supported' ? 'unsupported' : 'no-match',
          displayed: emitted ? result.displayed : 0,
          stdout_result: emitted ? 'written' : outputAttempted ? 'failed' : 'not-attempted', hook_result: result.errors.length ? 'degraded' : 'completed',
          elapsed_ms: Date.now() - started, error_codes: result.errors, health: { lastSuccessfulRecallAt: state.lastSuccessfulRecallAt, consecutiveFailures: state.consecutiveFailures } });
        store.save();
      }
    } catch { error('health-write-failed'); stderr('[AxMem recall: degraded] 健康计数写入失败；本次失败=1，持久计数未知。'); }
    try { store?.close(); } catch { stderr('[AxMem recall: degraded] 状态锁释放失败。'); }
  }
  return { errors: result.errors, receipt, emitted, outputAttempted, context };
}
function partialEvent(text) {
  // Read only a complete, top-level JSON string property. A quoted occurrence
  // inside prompt/tool_input is not evidence of the host event.
  let depth = 0, previous = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) continue;
    if (ch === '"') {
      const start = i++;
      for (; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') break; }
      if (i >= text.length) break;
      if (depth === 1 && (previous === '{' || previous === ',')) {
        try {
          if (JSON.parse(text.slice(start, i + 1)) === 'hook_event_name') {
            const value = /^\s*:\s*("(?:\\.|[^"\\])*")/.exec(text.slice(i + 1));
            const event = value && JSON.parse(value[1]);
            if (EVENTS.has(event)) return event;
          }
        } catch { /* incomplete property */ }
      }
      previous = 'string'; continue;
    }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    previous = ch;
  }
  return 'unknown';
}
async function readHookInput(stream = process.stdin) {
  const chunks = []; let size = 0;
  return new Promise((resolve) => {
    let done = false;
    const finish = (input, error) => {
      if (done) return;
      done = true; clearTimeout(timer); stream.pause();
      stream.off('data', data); stream.off('end', end); stream.off('error', failed);
      if (error) input = { hook_event_name: partialEvent(Buffer.concat(chunks).toString('utf8')) };
      resolve({ input, error });
    };
    const data = (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      chunks.push(b.subarray(0, Math.max(0, 256 * 1024 - size))); size += b.length;
      if (size > 256 * 1024) finish(null, 'stdin-too-large');
    };
    const end = () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(null, 'stdin-invalid-json'); } };
    const failed = () => finish(null, 'stdin-read-failed');
    const timer = setTimeout(() => finish(null, 'stdin-timeout'), 1000);
    stream.on('data', data); stream.on('end', end); stream.on('error', failed);
  });
}
async function main() {
  if (process.argv.includes('--self-test')) return require('./test-hook.cjs').selfTest();
  const { input, error } = await readHookInput();
  await runHandler(input, { inputError: error });
}
module.exports = { normalizeEvent, actionFromHook, renderHookOutput, runHandler, kernelFromCorpus, readHookInput, partialEvent };
if (require.main === module) main().catch((e) => {
  process.stderr.write('[AxMem recall: degraded] 内部故障；本次失败=1，工作继续。\n');
  if (!process.argv.includes('--self-test')) {
    try { process.stdout.write(renderHookOutput('unknown', '[AxMem recall: degraded] 内部故障；来源/送达未验证，工作继续。', true)); } catch { /* broken transport; stderr above */ }
    process.exitCode = 0;
  } else { console.error(e); process.exitCode = 1; }
});
