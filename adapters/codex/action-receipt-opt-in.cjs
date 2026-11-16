'use strict';
// DEFAULT-OFF CLI. Declared root-native contract is future validation, never host attestation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HEX = /^[a-f0-9]{64}$/;
const EXPECTED_BASE = [
  'adapters/codex/action-receipt-gate.cjs',
  'adapters/codex/action-receipt-state.cjs',
  'adapters/codex/action-receipt-opt-in.cjs',
  'adapters/codex/pre-tool-recall.cjs',
  'adapters/codex/recall-context.cjs',
  'adapters/codex/recall-selector.cjs',
  'core/memory-source.cjs',
  'guards/pmm-core.cjs',
  'guards/pmm-trigger-glob.cjs',
  'guards/pmm-trigger-recall.cjs',
  'guards/pmm-recall-ledger.cjs',
  'guards/pmm-recall-policy.cjs',
  'guards/vendor/minisearch/index.cjs',
  'guards/vendor/path-is-inside.cjs',
].sort();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const fail = code => { const e = new Error('AXMEM_CLI_' + code); e.code = code; return e; };
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
const atom = (s, limit = 128) => typeof s === 'string' && s.length > 0 &&
  s.length <= limit && !/[\u0000-\u001f\u007f]/.test(s);
const inside = (root, target) => {
  const r = path.relative(root, target);
  return r !== '' && !path.isAbsolute(r) && r !== '..' &&
    !r.startsWith('..' + path.sep);
};
const deny = code => ({hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: 'AXMEM_CLI_' + code,
}});
function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length > 32 || argv.length % 2 !== 0)
    throw fail('ARGS');
  const allowed = new Set(['base-root', 'base-manifest-file', 'base-manifest-sha256',
    'scope-file', 'scope-sha256', 'memory-root', 'policy-file', 'policy-sha256',
    'state-dir', 'mode', 'operation', 'session-id', 'actor-id']);
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!/^--[a-z0-9-]+$/.test(flag) || !allowed.has(flag.slice(2)) ||
        Object.hasOwn(out, flag.slice(2)) || !atom(value, 1024)) throw fail('ARGS');
    out[flag.slice(2)] = value;
  }
  for (const k of ['base-root', 'base-manifest-file', 'base-manifest-sha256',
    'scope-file', 'scope-sha256', 'memory-root', 'mode', 'operation'])
    if (!Object.hasOwn(out, k)) throw fail('ARGS');
  if ((out['policy-file'] === undefined) !== (out['policy-sha256'] === undefined))
    throw fail('ARGS');
  if (!['normal', 'synthetic-validation-only', 'scoped-native-validation'].includes(out.mode) ||
      !['hook', 'invalidate'].includes(out.operation)) throw fail('ARGS');
  for (const k of ['base-manifest-sha256','scope-sha256'])
    if (!HEX.test(out[k])) throw fail('ARGS');
  if (out['policy-sha256'] !== undefined && !HEX.test(out['policy-sha256']))
    throw fail('ARGS');
  return out;
}
function canonicalDirectory(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw fail('PATH');
  const resolved = path.resolve(p), st = fs.lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink() ||
      fs.realpathSync(resolved) !== resolved) throw fail('PATH');
  return resolved;
}
function regularBytes(p, expectedHash, maxBytes) {
  if (!path.isAbsolute(p) || !HEX.test(expectedHash)) throw fail('PIN');
  const resolved = path.resolve(p), stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.size < 1 || stat.size > maxBytes ||
      fs.realpathSync(resolved) !== resolved) throw fail('PIN');
  const bytes = fs.readFileSync(resolved);
  if (bytes.length !== stat.size || sha(bytes) !== expectedHash) throw fail('PIN');
  return bytes;
}
function pinnedJson(p, expectedHash, maxBytes) {
  return JSON.parse(regularBytes(p, expectedHash, maxBytes).toString('utf8'));
}
function validateBase(root, manifest) {
  if (!plain(manifest) || manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.files) || manifest.files.length !== EXPECTED_BASE.length ||
      JSON.stringify(manifest.files.map(x => x.path).sort()) !==
        JSON.stringify(EXPECTED_BASE)) throw fail('MANIFEST');
  for (const entry of manifest.files) {
    if (!plain(entry) || !HEX.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 200000)
      throw fail('MANIFEST');
    const filename = path.resolve(root, entry.path);
    if (!inside(root, filename)) throw fail('MANIFEST');
    const bytes = regularBytes(filename, entry.sha256, 200000);
    if (bytes.length !== entry.bytes) throw fail('MANIFEST');
  }
}
function validateEnabled(policy, config, scope) {
  const rootNative = config.mode === 'scoped-native-validation';
  const synthetic = config.mode === 'synthetic-validation-only';
  if (!plain(policy) || policy.schemaVersion !== 1 || policy.enabled !== true ||
      policy.validationOnly !== true || !(rootNative || synthetic) ||
      !atom(policy.allowedTarget, 180) || policy.allowedTarget.startsWith('/') ||
      !/^[A-Za-z0-9_./-]+$/.test(policy.allowedTarget) ||
      policy.allowedTarget.split('/').some(x => !x || x === '.' || x === '..') ||
      !HEX.test(policy.scopeSha256) || policy.scopeSha256 !== config['scope-sha256'] ||
      typeof policy.memoryRoot !== 'string' || policy.memoryRoot !== config['memory-root'] ||
      typeof policy.stateDir !== 'string' || policy.stateDir !== config['state-dir'])
    throw fail('POLICY_SCOPE');
  if (rootNative) {
    if (policy.route !== 'ROOT_NATIVE_HOOK_CONTRACT_V1' ||
        policy.nativeSourceVersion !== 'rust-v0.160.0' ||
        policy.declaredCodeMode !== false ||
        policy.hostBindingMode !== 'REGISTERED_NATIVE_ROOT_EVENT' ||
        Object.hasOwn(policy, 'host')) throw fail('POLICY_SCOPE');
  } else if (!plain(policy.host) || !atom(policy.host.sessionId) ||
             !atom(policy.host.turnId) || !atom(policy.host.actorId))
    throw fail('POLICY_SCOPE');
  // Repo and memory are separately pinned READONLY roots. Only metadata state
  // must reside beneath the trusted declared validation root.
  const validationRoot = canonicalDirectory(policy.validationRoot);
  const repoRoot = canonicalDirectory(scope.repoRoot);
  const memoryRoot = canonicalDirectory(config['memory-root']);
  const stateDir = canonicalDirectory(config['state-dir']);
  if (!inside(validationRoot, stateDir) ||
      !inside(repoRoot, path.resolve(repoRoot, policy.allowedTarget)))
    throw fail('POLICY_SCOPE');
  return {...policy, validationRoot, repoRoot, stateDir, memoryRoot};
}
const ROOT_ACTOR_DOMAIN = 'AXMEM/root-native-actor/v1\0';
function rootActorFromSession(sessionId) {
  if (!atom(sessionId)) return null;
  return 'root:' + sha(Buffer.from(ROOT_ACTOR_DOMAIN + sessionId, 'utf8'));
}
function nativeRootEnvelope(input) {
  if (!plain(input) ||
      input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'apply_patch' ||
      !atom(input.session_id) || !atom(input.turn_id) || !atom(input.tool_use_id))
    return {ok:false,code:'ENVELOPE_INVALID'};
  // rust-v0.160.0 serializes no agent_id key for root; null is NOT omission.
  if ('agent_id' in input)
    return {ok:false,code:atom(input.agent_id) ?
      'CHILD_OUT_OF_SCOPE' : 'AGENT_FIELD_MALFORMED'};
  // Session/turn are runtime BINDINGS from the normally registered host event.
  // JSON alone is not origin authentication; no guessed policy host IDs exist.
  return {ok:true,host:{sessionId:input.session_id,turnId:input.turn_id,
    actorId:rootActorFromSession(input.session_id)}};
}
function hostFromInput(input, expected) {
  if (!plain(input) || !plain(expected) ||
      !atom(input.session_id) || !atom(input.turn_id) || !atom(input.agent_id) ||
      input.session_id !== expected.sessionId ||
      input.turn_id !== expected.turnId || input.agent_id !== expected.actorId)
    return null;
  // Legacy synthetic actor field is not native root proof.
  return {sessionId:input.session_id, turnId:input.turn_id, actorId:input.agent_id};
}
function resultWith(output, code = 'OUTPUT') {
  if (!plain(output) || Buffer.byteLength(JSON.stringify(output),'utf8') > 12288)
    return {output:deny('OUTPUT_LIMIT'),code:'OUTPUT_LIMIT'};
  return {output,code};
}
async function run(argv, stream = process.stdin) {
  // The explicit trusted argv mode makes malformed/bootstrap failures finite DENY.
  let opt, knownEnabled = Array.isArray(argv) && argv.some((v,i) =>
    v === '--mode' && ['synthetic-validation-only','scoped-native-validation'].includes(argv[i+1]));
  try {
    opt = parseArgs(argv);
    knownEnabled = knownEnabled || opt.mode !== 'normal';
    const root = canonicalDirectory(opt['base-root']);
    const manifest = pinnedJson(opt['base-manifest-file'], opt['base-manifest-sha256'], 8192);
    validateBase(root, manifest);
    const scope = pinnedJson(opt['scope-file'], opt['scope-sha256'], 8192);
    if (!plain(scope) || scope.schemaVersion !== 1 || !atom(scope.repo, 80) ||
        !HEX.test(scope.taskSpecSha256) || typeof scope.repoRoot !== 'string')
      throw fail('SCOPE');
    const policy = opt['policy-file'] ?
      pinnedJson(opt['policy-file'], opt['policy-sha256'], 4096) : {schemaVersion:1,enabled:false};
    if (!plain(policy) || policy.schemaVersion !== 1 || typeof policy.enabled !== 'boolean')
      throw fail('POLICY');
    knownEnabled = knownEnabled || policy.enabled;
    const base = require(path.join(root, 'adapters/codex/pre-tool-recall.cjs'));
    const context = require(path.join(root, 'adapters/codex/recall-context.cjs'));
    const selectorModule = require(path.join(root, 'adapters/codex/recall-selector.cjs'));
    if (typeof base.runPreToolUse !== 'function' ||
        typeof base.actionFromHook !== 'function' ||
        typeof selectorModule.recall !== 'function' ||
        typeof context.readStdinLimited !== 'function' ||
        typeof context.renderActionHookOutput !== 'function' ||
        context.MAX_CONTEXT_BYTES !== 4096 || context.MAX_OUTPUT_BYTES !== 12288)
      throw fail('BASE_API');
    if (!context.isAbsoluteMemoryRoot(opt['memory-root'])) throw fail('MEMORY_ROOT');
    // No policy -> precise current readonly adapter semantics; no metadata mkdir/open.
    if (!policy.enabled) {
      if (opt.operation === 'invalidate') return resultWith({},'DISABLED_NOOP');
      const incoming = await context.readStdinLimited(stream);
      if (!incoming.ok) throw fail('INPUT');
      const input = JSON.parse(incoming.text);
      const readonly = await base.runPreToolUse(input,{memoryRoot:opt['memory-root'],
        sourceScope:scope,selector:selectorModule.recall});
      return resultWith(readonly.output || {},'READONLY_DELEGATED');
    }
    // Normal arbitrary enabled policy is still not a scoped validation contract.
    if (opt.mode === 'normal')
      return resultWith(deny('ROUTING_UNVERIFIED'),'ROUTING_UNVERIFIED');
    const validation = validateEnabled(policy,opt,scope);
    const rootNative = opt.mode === 'scoped-native-validation';
    if (opt.operation === 'invalidate') {
      // Invalidation remains an uninstalled trusted-command API, not discovery.
      if (rootNative ? (!atom(opt['session-id']) || opt['actor-id'] !== undefined) :
          (opt['session-id'] !== validation.host.sessionId ||
           opt['actor-id'] !== validation.host.actorId))
        return resultWith(deny('BOUNDARY_UNAVAILABLE'),'BOUNDARY_UNAVAILABLE');
    }
    const {createStateStore} = require('./action-receipt-state.cjs');
    const {createActionReceiptGate,ackControl} = require('./action-receipt-gate.cjs');
    const store = createStateStore({directory:validation.stateDir,ttlMs:120000});
    const sourceProof = async action => {
      const selected = await selectorModule.recall({memoryRoot:validation.memoryRoot,
        query:'',actionContext:action,limit:context.SELECTOR_LIMIT,
        maxChars:context.SELECTOR_MAX_CHARS});
      return {status:selected.status,receipt:selected.receipt,
        output:context.renderActionHookOutput(selected,validation.memoryRoot)};
    };
    const gate = createActionReceiptGate({
      trustedPolicy:{schemaVersion:1,enabled:true,memoryRoot:validation.memoryRoot,
        sourceScope:scope},
      baseAdapter:base,store,selector:selectorModule.recall,
      readonlyAdapter:base.runPreToolUse,
      trustedProofForAction:sourceProof,
      trustedRoutingAssumption:()=>rootNative ?
        'DECLARED_ROOT_NATIVE_HOOK_CONTRACT_ONLY' : 'SYNTHETIC_ASSUMPTION_ONLY',
      trustedHostContext:input=>rootNative ?
        (nativeRootEnvelope(input).host || null) :
        hostFromInput(input,validation.host),
    });
    if (opt.operation === 'invalidate') {
      const r = gate.invalidateBoundary({
        sessionId:opt['session-id'],
        actorId:rootNative ? rootActorFromSession(opt['session-id']) : opt['actor-id']});
      return resultWith({systemMessage:r.ok?'AXMEM_BOUNDARY_'+r.code:
        'AXMEM_BOUNDARY_DENIED'},r.ok?r.code:'BOUNDARY_UNAVAILABLE');
    }
    const incoming = await context.readStdinLimited(stream);
    if (!incoming.ok) return resultWith(deny('INPUT_INVALID'),'INPUT_INVALID');
    let input;
    try { input = JSON.parse(incoming.text); }
    catch { return resultWith(deny('INPUT_INVALID'),'INPUT_INVALID'); }
    if (rootNative) {
      const check = nativeRootEnvelope(input);
      if (!check.ok) return resultWith(deny(check.code),check.code);
    } else if (!hostFromInput(input,validation.host)) {
      return resultWith(deny('HOST_BINDING_MISMATCH'),'HOST_BINDING_MISMATCH');
    }
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'apply_patch')
      return resultWith(deny('TOOL_OUT_OF_SCOPE'),'TOOL_OUT_OF_SCOPE');
    const control = ackControl(input);
    const mapped = base.actionFromHook(input,scope);
    if (control) {
      if (control.kind !== 'ack' || mapped.status !== 'ok' ||
          control.action.path !== validation.allowedTarget ||
          control.action.repo !== scope.repo)
        return resultWith(deny('CONTROL_OUT_OF_SCOPE'),'CONTROL_OUT_OF_SCOPE');
    } else if (mapped.status !== 'ok' || mapped.action.path !== validation.allowedTarget ||
        mapped.action.repo !== scope.repo) {
      return resultWith(deny('TARGET_OUT_OF_SCOPE'),'TARGET_OUT_OF_SCOPE');
    }
    const outcome = await gate.handle(input);
    return resultWith(outcome.output || {},outcome.code);
  } catch {
    // Catch logical IO/JSON/selector/own-cli errors, never turn them into Continue.
    if (knownEnabled) return resultWith(deny('CLI_FAULT'),'CLI_FAULT');
    return {output:{},code:'UNAVAILABLE',exitCode:1};
  }
}
async function main() {
  const result = await run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.output));
  if (result.exitCode) process.exitCode = result.exitCode;
}
if (require.main === module) main().catch(() => {
  process.stdout.write(JSON.stringify(deny('CLI_FAULT')));
  process.exitCode = 1;
});
module.exports = {run,parseArgs,canonicalDirectory,regularBytes,validateEnabled,
  hostFromInput,nativeRootEnvelope,rootActorFromSession,deny};
