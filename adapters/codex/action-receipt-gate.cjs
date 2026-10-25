'use strict';
// DEFAULT-OFF, ISOLATED SOURCE CANDIDATE. Never claims authenticated native/model receipt.
const crypto = require('node:crypto');
// Portable injection: the CLI verifies the entire base adapter closure before loading.
// These limits equal pinned recall-context exports, rechecked by the CLI.
const MAX_CONTEXT_BYTES = 4096;
const MAX_OUTPUT_BYTES = 12 * 1024;
const ACK_PATH = '.codex-reviews/axmem-action-ack/receipt.txt';
const ACK_PREFIX = '.codex-reviews/axmem-action-ack/';
const HEX64 = /^[a-f0-9]{64}$/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const finiteString = (value, n) => typeof value === 'string' &&
  value.length > 0 && value.length <= n && !/[\u0000-\u001f\u007f]/.test(value);
function validAction(a) {
  return a && ['Edit', 'Write'].includes(a.tool) &&
    typeof a.repo === 'string' && /^[a-z0-9-]{1,80}$/.test(a.repo) &&
    typeof a.path === 'string' && /^[A-Za-z0-9_./-]{1,180}$/.test(a.path) &&
    !a.path.startsWith('/') &&
    !a.path.split('/').some(part => part === '' || part === '.' || part === '..');
}
function actionHash(action, patchSha256) {
  if (!validAction(action) || !HEX64.test(patchSha256)) return null;
  return sha(JSON.stringify([action.tool, action.repo, action.path, patchSha256]));
}
function ackControl(input) {
  if (!input || input.hook_event_name !== 'PreToolUse' ||
      input.tool_name !== 'apply_patch') return null;
  const patch = input.tool_input && input.tool_input.command;
  if (typeof patch !== 'string') return null;
  if (!patch.includes(ACK_PREFIX)) return null;
  if (Buffer.byteLength(patch, 'utf8') > 1024 || patch.includes('\r'))
    return {kind: 'malformed'};
  const lines = patch.endsWith('\n') ? patch.slice(0, -1).split('\n') : patch.split('\n');
  if (lines.length !== 9 ||
      lines[0] !== '*** Begin Patch' ||
      lines[1] !== '*** Add File: ' + ACK_PATH ||
      lines[2] !== '+AXMEM-ACK-V1' ||
      lines[8] !== '*** End Patch')
    return {kind: 'malformed'};
  const fields = [
    [/^\+challenge=([a-f0-9]{64})$/, lines[3]],
    [/^\+tool=(Edit|Write)$/, lines[4]],
    [/^\+repo=([a-z0-9-]{1,80})$/, lines[5]],
    [/^\+path=([A-Za-z0-9_./-]{1,180})$/, lines[6]],
    [/^\+patchSha256=([a-f0-9]{64})$/, lines[7]],
  ];
  const vals = fields.map(([regex, line]) => regex.exec(line));
  if (vals.some(x => !x)) return {kind: 'malformed'};
  const action = {tool: vals[1][1], repo: vals[2][1], path: vals[3][1]};
  if (!validAction(action)) return {kind: 'malformed'};
  return {kind: 'ack', challenge: vals[0][1], action,
    patchSha256: vals[4][1]};
}
function verifiedWholeProof(result, memoryRoot) {
  const bad = () => ({ok: false, code: 'INCOMPLETE_SOURCE_CONTEXT'});
  const r = result && result.receipt;
  const c = r && r.counts;
  const out = result && result.output && result.output.hookSpecificOutput;
  const context = out && out.additionalContext;
  if (result?.status !== 'ok' || !r || r.event !== 'selector' ||
      r.stage !== 'candidates-selected' || r.query?.method !== 'action-trigger' ||
      !c || !Number.isSafeInteger(c.selected) || c.selected < 1 || c.selected > 3 ||
      !Number.isSafeInteger(c.displayed) || c.displayed < 1 ||
      !Number.isSafeInteger(c.omitted) || c.omitted < 0 ||
      c.displayed + c.omitted !== c.selected ||
      !Array.isArray(r.pointers) || r.pointers.length !== c.selected ||
      (result.items !== undefined && (!Array.isArray(result.items) ||
        result.items.length !== c.displayed)) ||
      !finiteString(memoryRoot, 512) ||
      !out || out.hookEventName !== 'PreToolUse' || typeof context !== 'string' ||
      Buffer.byteLength(context, 'utf8') > MAX_CONTEXT_BYTES || !context.trim())
    return bad();
  // The owned formatter may omit MORE than the selector. Do not reinterpret its
  // header as a new source receipt: mismatch is an honest logical denial.
  const headers = [...context.matchAll(/^召回收据 v1 event=PreToolUse stage=emitted selected=(\d+) displayed=(\d+) omitted=(\d+)$/gm)];
  if (headers.length !== 1 || Number(headers[0][1]) !== c.selected ||
      Number(headers[0][2]) !== c.displayed ||
      Number(headers[0][3]) !== c.omitted) return bad();
  const snapshot = [];
  // The actual existing runPreToolUse adapter returns the VERIFIED receipt and
  // formatted output, but intentionally does not export selector items. Its
  // owned normaliseSelectorResult verified all item hashes before rendering.
  const availableItems = Array.isArray(result.items) ? result.items : null;
  let whole = 0, omitted = 0, nextItem = 0;
  for (let i = 0; i < r.pointers.length; i++) {
    const x = r.pointers[i];
    if (!x || x.rank !== i + 1 || x.sourceRoot !== memoryRoot ||
        !['decisions.md', 'lessons.md', 'standinginstructions.md'].includes(x.file) ||
        !finiteString(x.tag, 512) ||
        !['observed', 'derived', 'user-ratified', 'undeclared'].includes(x.trust) ||
        !HEX64.test(x.sourceFileSha256) || !HEX64.test(x.fullEntrySha256) ||
        !Number.isSafeInteger(x.line) || x.line < 1 ||
        !Number.isSafeInteger(x.endLine) || x.endLine < x.line ||
        x.scope !== 'unknown' ||
        !(x.date === null || typeof x.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(x.date)) ||
        !(x.resolvedFromTag === null || finiteString(x.resolvedFromTag, 512)))
      return bad();
    const pointerLine = '#' + x.rank + ' [' + x.tag + '] ' + x.file +
      ':' + x.line + '-' + x.endLine + ' fullEntrySHA256=' +
      x.fullEntrySha256 + ' trust=' + x.trust + ' date=' +
      (x.date || 'unknown') + ' scope=' + x.scope + ' ' +
      x.visibility + '/' + x.reason;
    if (!context.includes(pointerLine)) return bad();
    const marker = '[' + x.tag + '] 完整正文：\n';
    if (x.visibility === 'whole') {
      if (x.reason !== 'none' ||
          x.displayedTextSha256 !== x.fullEntrySha256 ||
          !context.includes(marker)) return bad();
      // When synthetic source items are present, additionally verify full body.
      // The production-shaped adapter has already done this verification.
      if (availableItems) {
        const item = availableItems[nextItem++];
        if (!item || item.tag !== x.tag || item.file !== x.file ||
            item.line !== x.line || item.endLine !== x.endLine ||
            item.trust !== x.trust || item.hash !== x.fullEntrySha256 ||
            typeof item.text !== 'string' ||
            sha(Buffer.from(item.text, 'utf8')) !== x.fullEntrySha256 ||
            !context.includes(marker + item.text)) return bad();
      }
      whole++;
    } else if (x.visibility === 'omitted') {
      if (!['selector-budget', 'task-budget', 'bridge-budget'].includes(x.reason) ||
          x.displayedTextSha256 !== null || context.includes(marker))
        return bad();
      omitted++;
    } else return bad();
    snapshot.push([x.rank, x.sourceRoot, x.file, x.line, x.endLine,
      x.tag, x.trust, x.sourceFileSha256, x.fullEntrySha256,
      x.displayedTextSha256, x.visibility, x.reason,
      x.date, x.scope, x.resolvedFromTag]);
  }
  if (whole !== c.displayed || omitted !== c.omitted ||
      (availableItems && nextItem !== availableItems.length)) return bad();
  // Hash only: exact emitted context plus all selected source and omission data.
  // The state record never stores source text, prompt or raw nonce.
  const contextHash = sha(Buffer.from(context, 'utf8'));
  return {ok: true, code: 'WHOLE_OR_OMITTED_SOURCE_CONTEXT', context,
    sourceHash: sha(JSON.stringify(['AXMEM/source-context/v2', snapshot, contextHash])),
    entryHash: sha(JSON.stringify(['AXMEM/entries-context/v2',
      snapshot.map(x => [x[8], x[9], x[10], x[11]]), contextHash]))};
}
function nativeBinding(trustedHostContext, input, policy, action, patchSha256, proof) {
  if (typeof trustedHostContext !== 'function') return null;
  let host;
  try { host = trustedHostContext(input); } catch { return null; }
  if (!host || !finiteString(host.sessionId, 128) ||
      !finiteString(host.turnId, 128) || !finiteString(host.actorId, 128) ||
      !HEX64.test(policy?.sourceScope?.taskSpecSha256)) return null;
  const ah = actionHash(action, patchSha256);
  if (!ah || !proof?.ok) return null;
  return {sessionHash: sha(host.sessionId), actorHash: sha(host.actorId),
    turnHash: sha(host.turnId), taskHash: policy.sourceScope.taskSpecSha256,
    actionHash: ah, sourceHash: proof.sourceHash, entryHash: proof.entryHash};
}
function deny(code, context = null) {
  // Raw challenge exists ONLY in the bounded additionalContext ACK protocol.
  const reason = 'AXMEM_GATE_' + code;
  const inner = {hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: reason};
  if (context !== null) inner.additionalContext = context;
  const output = {hookSpecificOutput: inner};
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_OUTPUT_BYTES)
    return {status: 'candidate-denied', code: 'CONTEXT_OUTPUT_LIMIT',
      output: {hookSpecificOutput: {hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'AXMEM_GATE_CONTEXT_OUTPUT_LIMIT'}},
      nativeHostProof: 'UNKNOWN', modelBeforeAction: 'UNKNOWN'};
  return {status: 'candidate-denied', code, output,
    nativeHostProof: 'UNKNOWN', modelBeforeAction: 'UNKNOWN'};
}
// This trailer is generated solely from trusted action/patch bytes, never lesson text.
function challengeDeny(context, action, patchSha256, nonce) {
  if (!validAction(action) || !HEX64.test(patchSha256) || !HEX64.test(nonce))
    return deny('ACTION_INVALID');
  const controlPatch = [
    '*** Begin Patch',
    '*** Add File: ' + ACK_PATH,
    '+AXMEM-ACK-V1',
    '+challenge=' + nonce,
    '+tool=' + action.tool,
    '+repo=' + action.repo,
    '+path=' + action.path,
    '+patchSha256=' + patchSha256,
    '*** End Patch',
  ].join('\n');
  const protocol = [
    'AXMEM_ACK_PROTOCOL_V1_BEGIN',
    'nativeTool=apply_patch',
    'nativeDecision=deny',
    'CONTROL_PATCH_BEGIN',
    controlPatch,
    'CONTROL_PATCH_END',
    'AXMEM_ACK_PROTOCOL_V1_END',
  ].join('\n');
  const complete = context + '\n\n' + protocol;
  if (Buffer.byteLength(complete, 'utf8') > MAX_CONTEXT_BYTES)
    return deny('CONTEXT_OUTPUT_LIMIT');
  return deny('CHALLENGE_RESERVED', complete);
}
const STATE_FAILURES = new Set([
  'STATE_IO', 'INVALID_BINDING', 'LOCK_CONFLICT', 'STATE_DIRECTORY_LINK',
  'STATE_LINK', 'STATE_SIZE', 'STATE_CHANGED', 'CORRUPT_STATE',
  'STATE_CAS_CONFLICT', 'LOCK_RELEASE_FAILED', 'PENDING_EXISTS',
  'EXPIRED', 'INVALID_CLOCK', 'NOT_ACKNOWLEDGED', 'BINDING_MISMATCH',
  'REPLAY', 'CHALLENGE_MISMATCH', 'INVALID_CHALLENGE', 'MISSING',
  'ENTROPY_INVALID',
]);
function stateCall(store, method, args) {
  try {
    const r = store?.[method]?.(...args);
    if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean' ||
        typeof r.code !== 'string') return {ok: false, code: 'STATE_IO'};
    if (!r.ok)
      return {ok: false, code: STATE_FAILURES.has(r.code) ? r.code : 'STATE_IO'};
    const codes = {begin: 'CHALLENGE_RESERVED', acknowledge: 'ACK_RECORDED',
      consume: 'CONSUMED'};
    if (method === 'invalidateActor') {
      if (!['INVALIDATED', 'ALREADY_ABSENT'].includes(r.code))
        return {ok: false, code: 'STATE_IO'};
    } else if (r.code !== codes[method]) return {ok: false, code: 'STATE_IO'};
    if (method === 'begin' && (typeof r.challenge !== 'string' ||
        !HEX64.test(r.challenge))) return {ok: false, code: 'STATE_IO'};
    return r;
  } catch { return {ok: false, code: 'STATE_IO'}; }
}
function createActionReceiptGate(deps = {}) {
  const policy = deps.trustedPolicy || {};
  const baseAdapter = deps.baseAdapter || {};
  const actionFromHook = baseAdapter.actionFromHook;
  const readonlyAdapter = deps.readonlyAdapter || baseAdapter.runPreToolUse;
  const trustedOptions = {memoryRoot: policy.memoryRoot,
    sourceScope: policy.sourceScope, ...(deps.selector ? {selector: deps.selector} : {})};
  async function handle(input) {
    // Only the host/command wiring may supply policy. Ignore any input.policy/flags.
    if (typeof actionFromHook !== 'function' || typeof readonlyAdapter !== 'function')
      return deny('BASE_ADAPTER_UNAVAILABLE');
    if (policy.enabled !== true)
      return readonlyAdapter(input, trustedOptions);
    // Fail closed only in the enabled candidate; preserve default readonly behavior.
    try {
      if (!policy || policy.schemaVersion !== 1 || !deps.store ||
          typeof deps.trustedHostContext !== 'function' ||
          typeof deps.trustedProofForAction !== 'function' ||
          typeof deps.trustedRoutingAssumption !== 'function')
        return deny('ROUTING_UNVERIFIED');
      let routing;
      try { routing = deps.trustedRoutingAssumption(); }
      catch { return deny('ROUTING_UNVERIFIED'); }
      // Exact declared source contract only: this is not native host/model attestation.
      if (routing !== 'SYNTHETIC_ASSUMPTION_ONLY' &&
          routing !== 'DECLARED_ROOT_NATIVE_HOOK_CONTRACT_ONLY')
        return deny('ROUTING_UNVERIFIED');
    if (!input || input.hook_event_name !== 'PreToolUse' ||
        input.tool_name !== 'apply_patch')
      return readonlyAdapter(input, trustedOptions);
    const control = ackControl(input);
    if (control) {
      if (control.kind !== 'ack') return deny('INVALID_ACK_CONTROL');
      const mapped = actionFromHook(input, policy.sourceScope);
      if (mapped.status !== 'ok' || mapped.action.path !== ACK_PATH)
        return deny('ACK_PATH_UNTRUSTED');
      if (control.action.repo !== policy.sourceScope.repo)
        return deny('ACK_ACTION_UNTRUSTED');
      let result;
      try { result = await deps.trustedProofForAction(control.action); }
      catch { return deny('SOURCE_RECHECK_UNAVAILABLE'); }
      const proof = verifiedWholeProof(result, policy.memoryRoot);
      if (!proof.ok) return deny(proof.code);
      const binding = nativeBinding(deps.trustedHostContext, input, policy,
        control.action, control.patchSha256, proof);
      if (!binding) return deny('ACTOR_UNBOUND');
      const recorded = stateCall(deps.store, 'acknowledge', [binding, control.challenge]);
      // Even a successful ACK control is DENIED before the native file handler.
      return deny(recorded.ok ? 'ACK_RECORDED' : recorded.code);
    }
    const mapped = actionFromHook(input, policy.sourceScope);
    if (mapped.status === 'unsupported')
      return readonlyAdapter(input, trustedOptions);
    if (mapped.status !== 'ok') return deny('ACTION_INVALID');
    let result;
    try { result = await readonlyAdapter(input, trustedOptions); }
    catch { return deny('SELECTOR_UNAVAILABLE'); }
    if (result?.status === 'no-match' && result.output &&
        Object.keys(result.output).length === 0)
      return result;
    const proof = verifiedWholeProof(result, policy.memoryRoot);
    if (!proof.ok) return deny(proof.code);
    const patch = input.tool_input && input.tool_input.command;
    if (typeof patch !== 'string') return deny('ACTION_INVALID');
    const patchSha256 = sha(Buffer.from(patch, 'utf8'));
    const binding = nativeBinding(deps.trustedHostContext, input, policy,
      mapped.action, patchSha256, proof);
    if (!binding) return deny('ACTOR_UNBOUND');
    const consumed = stateCall(deps.store, 'consume', [binding]);
    if (consumed.ok) return {status: 'candidate-continue', code: 'ACK_CONSUMED',
      output: {}, nativeHostProof: 'UNKNOWN', modelBeforeAction: 'UNKNOWN'};
    if (!['MISSING', 'EXPIRED'].includes(consumed.code))
      return deny(consumed.code);
    // Preflight BOTH whole-entry+protocol and JSON budgets before minting state.
    const preview = challengeDeny(proof.context, mapped.action, patchSha256, 'f'.repeat(64));
    if (preview.code !== 'CHALLENGE_RESERVED') return preview;
    const reserved = stateCall(deps.store, 'begin', [binding]);
    return reserved.ok ? challengeDeny(proof.context, mapped.action,
      patchSha256, reserved.challenge) : deny(reserved.code);
    } catch { return deny('CANDIDATE_FAULT'); }
  }
  function invalidateBoundary(trustedHost) {
    if (policy.enabled !== true || !deps.store || !trustedHost ||
        !finiteString(trustedHost.sessionId, 128) ||
        !finiteString(trustedHost.actorId, 128))
      return {ok: false, code: 'BOUNDARY_UNAVAILABLE'};
    const zero = '0'.repeat(64);
    return stateCall(deps.store, 'invalidateActor', [{sessionHash: sha(trustedHost.sessionId),
      actorHash: sha(trustedHost.actorId), turnHash: zero, taskHash: zero,
      actionHash: zero, sourceHash: zero, entryHash: zero}]);
  }
  return Object.freeze({handle, invalidateBoundary});
}
module.exports = {createActionReceiptGate, ACK_PATH, ackControl, verifiedWholeProof};
