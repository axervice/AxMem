'use strict';
// Delivery ledger, distinct from receipt.sh's AskUserQuestion/spool receipts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sha } = require('./memory-source.cjs');
const { writeFileAtomicSync } = require('../lib/atomic-write.cjs');
function identity(input, invocationId) {
  const session = typeof input.session_id === 'string' && input.session_id ? input.session_id : null;
  const actor = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null;
  return { session, actor, key: sha(JSON.stringify([os.hostname(), session || invocationId, actor])) };
}
function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function actionId(input) {
  // No input-hash-only fallback: identical reattempts are distinct actions.
  if (typeof input.session_id !== 'string' || typeof input.tool_use_id !== 'string' || !input.tool_use_id) return null;
  return sha(canonicalJSON(['cc-action-v1', input.session_id, input.agent_id || null, input.tool_use_id,
    input.tool_name, input.tool_input]));
}
function readJSON(file, fallback) {
  try {
    if (fs.statSync(file).size > 256 * 1024) throw new Error('state-too-large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error('state-unreadable'); }
}
const LOCK_TTL_MS = 30000, RETAIN_FILES = 128, RETAIN_MS = 7 * 86400000;
function emptyState() {
  return { epoch: 0, taskId: null, candidates: [], seen: [], lastSuccessfulRecallAt: null, consecutiveFailures: 0, counts: {} };
}
function validState(state) {
  return state && Number.isInteger(state.epoch) && state.epoch >= 0 &&
    (state.taskId === null || typeof state.taskId === 'string') &&
    Array.isArray(state.candidates) && state.candidates.every((p) => p && typeof p.tag === 'string' && typeof p.hash === 'string') &&
    Array.isArray(state.seen) && state.seen.every((s) => typeof s === 'string') &&
    Number.isInteger(state.consecutiveFailures) && state.consecutiveFailures >= 0 &&
    state.counts && typeof state.counts === 'object' && !Array.isArray(state.counts);
}
function sameLock(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size; }
// Serialize lock-file creation/reclamation/release, not the whole recall. This
// avoids two stale-lock reclaimers unlinking a successor between stat/unlink.
// A killed short mutation also expires; neither lock has an infinite lease.
const FILE_CLAIM = 'axmem-file-claim-v1';
// Alternate claim for the rare case where directory creation is denied but
// regular file creation still works. Both claim kinds occupy the SAME path.
function fileMutateLock(lock, fn) {
  const claim = lock + '.claim';
  let fd;
  try { fd = fs.openSync(claim, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { fs.writeFileSync(fd, FILE_CLAIM); return fn(); }
  finally {
    try {
      const owned = fs.fstatSync(fd);
      try { if (sameLock(owned, fs.lstatSync(claim))) fs.unlinkSync(claim); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    } finally { fs.closeSync(fd); }
  }
}
function mutateLock(lock, fn) {
  const claim = lock + '.claim';
  let permissionFailures = 0;
  for (let attempt = 0; attempt < 2;) {
    try { fs.mkdirSync(claim, { mode: 0o700 }); }
    catch (e) {
      if (e.code === 'EBUSY') return null;
      if (['EPERM', 'EACCES'].includes(e.code)) {
        // A delete-pending directory can also make lstat fail on Windows.
        // Only three consecutive failures with BOTH entities verifiably absent
        // indicate an unavailable claim. Never reclaim an unowned claim here.
        for (const file of [claim, lock]) {
          try { fs.lstatSync(file); return null; }
          catch (statError) {
            if (['EPERM', 'EACCES', 'EBUSY'].includes(statError.code)) return null;
            if (statError.code !== 'ENOENT') throw statError;
          }
        }
        if (++permissionFailures < 3) continue; // no sleeps; failure path only
        throw Object.assign(new Error('state-claim-unavailable'), { code: 'state-claim-unavailable' });
      }
      if (e.code !== 'EEXIST') throw e;
      permissionFailures = 0; // An observed claim breaks the consecutive sequence.
      attempt++;
      try {
        const s = fs.lstatSync(claim);
        if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error('unsafe-lock');
        if (s.isFile()) {
          // Empty or a marker prefix can be an in-flight or crashed write.
          if (s.size > Buffer.byteLength(FILE_CLAIM) || !FILE_CLAIM.startsWith(fs.readFileSync(claim, 'utf8'))) throw new Error('unsafe-lock');
        }
        if (Date.now() - s.mtimeMs <= LOCK_TTL_MS) return null;
        if (s.isFile()) fs.unlinkSync(claim); else fs.rmdirSync(claim);
        continue;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) return null;
        throw error;
      }
    }
    const owned = fs.lstatSync(claim);
    try { return fn(); }
    finally {
      try { if (sameLock(owned, fs.lstatSync(claim))) fs.rmdirSync(claim); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  return null;
}
function createLock(lock) {
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token: require('node:crypto').randomUUID() })); }
  catch (e) { fs.closeSync(fd); fs.unlinkSync(lock); throw e; }
  return fd;
}
function acquireLock(lock, fileClaim = false) {
  return (fileClaim ? fileMutateLock : mutateLock)(lock, () => {
    try {
      const before = fs.lstatSync(lock);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('unsafe-lock');
      let owner;
      if (before.size <= 1024) { try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* legacy/torn lock: use mtime */ } }
      const at = Number.isFinite(owner?.at) ? owner.at : before.mtimeMs;
      let dead = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      }
      // Empty/legacy locks get a grace period. EPERM is NOT a dead process.
      if (!dead && Date.now() - at <= LOCK_TTL_MS) return null;
      fs.unlinkSync(lock);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return createLock(lock);
  });
}
function releaseLock(lock, fd, fileClaim = false) {
  const owned = fs.fstatSync(fd);
  try {
    (fileClaim ? fileMutateLock : mutateLock)(lock, () => {
      try { if (sameLock(owned, fs.lstatSync(lock))) fs.unlinkSync(lock); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    });
    // A busy mutation leaves a finite lease, never an unsafe unlink.
  } finally { fs.closeSync(fd); }
}
const STAGING_NAME = /^\..+\.axmem-staging-.+$/;
const STORE_FILE = /^(?:[a-zA-Z0-9-]+\.jsonl|(?:pre|post)-[a-f0-9]{64}\.(?:json|jsonl))$/;
function ownFile(name) { return name === 'state.json' || STORE_FILE.test(name) || STAGING_NAME.test(name); }
function stateVersion(dir) {
  try {
    const s = fs.lstatSync(path.join(dir, 'state.json'));
    return JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function cleanSessions(stateRoot, currentKey) {
  const root = path.join(stateRoot, 'recall'), inactive = [];
  let protectedCount = 1; // Current session is never a maintenance target.
  for (const name of fs.readdirSync(root)) {
    if (name === currentKey || !/^[a-f0-9]{64}$/.test(name)) continue;
    const dir = path.join(root, name);
    let s;
    try { s = fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!s.isDirectory() || s.isSymbolicLink()) continue;
    // Maintenance never reclaims a session with any lease/claim. Active or
    // abandoned leases can temporarily exceed the cap; normal open recovers them.
    if (fs.existsSync(path.join(dir, 'lock')) || fs.existsSync(path.join(dir, 'lock.claim'))) protectedCount++;
    else {
      // Sample state before directory age: a refresh during enumeration must
      // either make the directory recent or fail the post-acquisition check.
      const version = stateVersion(dir), current = fs.lstatSync(dir);
      if (current.isDirectory() && !current.isSymbolicLink()) inactive.push({ dir, at: current.mtimeMs, version });
    }
  }
  inactive.sort((a, b) => b.at - a.at);
  for (const [i, item] of inactive.entries()) {
    if (i < Math.max(0, RETAIN_FILES - protectedCount) && Date.now() - item.at <= RETAIN_MS) continue;
    const lock = path.join(item.dir, 'lock');
    let fd;
    try { fd = acquireLock(lock); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (fd === null) continue;
    try {
      // An invocation may have refreshed and released this session after our
      // scan. Claim/lock creation changes the directory mtime itself, so compare
      // the committed state version instead before deleting any session files.
      if (stateVersion(item.dir) !== item.version) continue;
      const files = fs.readdirSync(item.dir).filter((f) => f !== 'lock' && f !== 'lock.claim');
      // Do not recurse into or remove unknown user files/symlinks.
      if (files.some((f) => {
        if (!ownFile(f)) return true;
        const s = fs.lstatSync(path.join(item.dir, f));
        return !s.isFile() || s.isSymbolicLink();
      })) continue;
      for (const f of files) fs.unlinkSync(path.join(item.dir, f));
    } finally { releaseLock(lock, fd); }
    try { fs.rmdirSync(item.dir); }
    catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
    // A new opener may have made its claim after release. rmdir then leaves
    // its nonempty directory alone; if rmdir won, openStore retries ENOENT.
  }
}
function cleanStaging(dir) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (!STAGING_NAME.test(name)) continue;
    const file = path.join(dir, name);
    let s;
    try { s = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (s.isFile() && !s.isSymbolicLink()) files.push({ file, at: s.mtimeMs });
  }
  files.sort((a, b) => b.at - a.at);
  for (const [i, f] of files.entries()) {
    const age = Date.now() - f.at;
    // Caches have concurrent writers: never unlink a fresh in-flight staging
    // file merely to meet the count. Completed cache JSON is not a target.
    if (age > LOCK_TTL_MS && (i >= RETAIN_FILES || age > RETAIN_MS)) {
      try { fs.unlinkSync(f.file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
}
function cleanCaches(stateRoot) {
  cleanStaging(path.join(stateRoot, 'recall-topic'));
  const source = path.join(stateRoot, 'recall-source');
  let s;
  try { s = fs.lstatSync(source); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!s.isDirectory() || s.isSymbolicLink()) return;
  cleanStaging(source);
  for (const name of fs.readdirSync(source)) if (/^[a-f0-9]{64}$/.test(name)) cleanStaging(path.join(source, name));
}
function cleanStore(dir) {
  const old = [];
  for (const name of fs.readdirSync(dir)) {
    // Only our own per-invocation/action files; never config or other state.
    if (!STORE_FILE.test(name) && !STAGING_NAME.test(name)) continue;
    const file = path.join(dir, name), s = fs.lstatSync(file);
    if (s.isFile()) old.push({ file, at: s.mtimeMs });
  }
  old.sort((a, b) => b.at - a.at);
  // Reserve room for this invocation's ledger and optional Pre marker.
  old.forEach((f, i) => { if (i >= RETAIN_FILES - 2 || Date.now() - f.at > RETAIN_MS) fs.unlinkSync(f.file); });
}
function openStore(stateRoot, key, invocationId, options = {}) {
  const dir = path.join(stateRoot, 'recall', key);
  const lock = path.join(dir, 'lock');
  let fd, claimUnavailable = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fd = acquireLock(lock); break; }
    catch (e) {
      if (e.code === 'state-claim-unavailable' && options.accountClaimFailure) {
        // Serialize with normal directory claims at the same pathname. If a
        // rival wins, remain busy; if file creation is denied too, propagate
        // the failure so the hook can still warn via stdout/stderr.
        fd = acquireLock(lock, true);
        claimUnavailable = fd !== null;
        break;
      }
      // Inactive-session maintenance can win between mkdir and claim mkdir.
      if (e.code !== 'ENOENT' || attempt === 1) throw e;
    }
  }
  if (fd === null) {
    if (!options.skipBusy) throw new Error('state-busy');
    // A live concurrent invocation owns accounting. Use the last committed
    // snapshot for task candidates and replay suppression, but never persist
    // this invocation's mutations. Atomic replacement normally makes this a
    // complete old/new snapshot; torn, missing or unreadable state is optional.
    let snapshot = emptyState();
    try {
      const current = readJSON(path.join(dir, 'state.json'), snapshot);
      if (validState(current)) snapshot = current;
    } catch { /* Read-only contention must not become state-unavailable. */ }
    return { state: snapshot, dir, busy: true, maintenanceErrors: [], append() {}, save() {}, mark() {}, close() {} };
  }
  const release = () => releaseLock(lock, fd, claimUnavailable);
  const maintenanceErrors = [];
  // Housekeeping is never a source/recall availability gate. Keep failures in
  // the receipt, separate from degraded/error_codes and health failure counts.
  for (const [code, clean] of [
    ['store-cleanup-failed', () => cleanStore(dir)],
    ['session-cleanup-failed', () => cleanSessions(stateRoot, key)],
    ['cache-cleanup-failed', () => cleanCaches(stateRoot)],
  ]) {
    try { clean(); } catch { maintenanceErrors.push(code); }
  }
  let state;
  try {
    const stateFile = path.join(dir, 'state.json');
    // Rebuild oversized state under the lock instead of trapping every future
    // invocation. Do not rotate indefinitely and create another growth source.
    let oversized = false;
    try { oversized = fs.statSync(stateFile).size > 256 * 1024; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    state = oversized ? emptyState() : readJSON(stateFile, emptyState());
    if (!validState(state)) throw new Error('state-invalid');
  } catch (e) { release(); throw e; }
  const ledger = path.join(dir, invocationId + '.jsonl');
  let pending = '';
  function flush() { if (pending) { fs.appendFileSync(ledger, pending, { mode: 0o600 }); pending = ''; } }
  return { state, dir, maintenanceErrors, claimUnavailable,
    append(row) {
      if (options.buffered) pending += JSON.stringify(row) + '\n';
      else fs.appendFileSync(ledger, JSON.stringify(row) + '\n', { mode: 0o600 });
    },
    save() { flush(); writeFileAtomicSync(path.join(dir, 'state.json'), JSON.stringify(state), { mode: 0o600 }); },
    mark(action, marker) {
      if (action) writeFileAtomicSync(path.join(dir, 'pre-' + action + '.json'), JSON.stringify(marker), { mode: 0o600 });
    },
    close() { try { flush(); } finally { release(); } },
  };
}
function suppressPost(input, runtime) {
  const id = actionId(input);
  if (!id) return new Set();
  const key = identity(input, '').key;
  const dir = path.join(runtime.stateRoot, 'recall', key);
  const marker = readJSON(path.join(dir, 'pre-' + id + '.json'), null);
  if (!marker || marker.actionId !== id || marker.status !== 'emitted' ||
      !Number.isFinite(marker.at) || marker.at > Date.now() || !Array.isArray(marker.items)) return new Set();
  const tags = new Set();
  for (const p of marker.items) {
    if (!['decisions.md', 'lessons.md', 'standinginstructions.md'].includes(p.file)) throw new Error('state-invalid');
    if (sha(fs.readFileSync(path.join(runtime.memoryRoot, p.file))) === p.sourceFileSha256) tags.add(p.tag);
  }
  fs.appendFileSync(path.join(dir, 'post-' + id + '.jsonl'), JSON.stringify({
    schema: 'axmem.cc.recall.v1', adapter: 'claude-code', event: 'PostToolUse', action_id: id,
    tool_use_id: input.tool_use_id, delivery_id: marker.deliveryId, post_outcome: 'observed-unverified',
    evidence_hash: sha(JSON.stringify(input.tool_response ?? null)),
    suppressed: [...tags], hostConfirmed: 'unknown', at: new Date().toISOString(),
  }) + '\n', { mode: 0o600 });
  return tags;
}
// Compatibility fallback still emits only legacy titles. Give those an
// explicit pointer-only receipt; never count them as complete lesson bodies.
function prepareLegacyPost(input, ctx, payload, tags, priorFailure = false) {
  const invocation = require('node:crypto').randomUUID(), who = identity(input, invocation);
  const store = openStore(path.resolve(ctx.STATE_DIR), who.key, invocation, { skipBusy: true });
  const startedAt = new Date().toISOString();
  let corpus = null;
  try { corpus = require('./memory-source.cjs').loadCorpus(path.resolve(ctx.MEMORY_DIR)); }
  catch (e) { if (!priorFailure) { store.close(); throw e; } }
  const hit = ctx.resolveRepo(input.tool_input?.file_path || '');
  const row = {
    schema: 'axmem.cc.recall.v1', adapter: 'claude-code', installation_version: '0.1.0-phase1', machine: os.hostname(),
    event_id: require('node:crypto').randomUUID(), invocation_id: invocation, invocation_started_at: startedAt,
    event: 'PostToolUse', phase: 'PostToolUse',
    session_id: who.session, session_hash: who.session ? sha(who.session) : null, actor_id: who.actor,
    ...(input.parent_agent_id ? { parent_actor_id: input.parent_agent_id } : {}),
    ...(input.prompt_id ? { prompt_id: input.prompt_id } : {}), ...(input.turn_id ? { turn_id: input.turn_id } : {}),
    actor_hash: who.actor ? sha(who.actor) : null, task_id: store.state.taskId, context_epoch: store.state.epoch,
    tool_use_id: input.tool_use_id || null, action_id: actionId(input), tool: input.tool_name,
    repo: hit?.repoId || null, rel: hit?.rel || null, action_input_hash: sha(canonicalJSON(input.tool_input ?? null)),
    identity_missing: [!who.session && 'session', !who.actor && 'actor'].filter(Boolean), path_status: hit ? 'legacy-lexical' : 'unknown',
    snapshot_id: corpus?.snapshotId || null, selection_method: ['legacy-post-pointer'], trigger_id: null,
    query_hash: null, query_effective_length: 0, matched: tags.length, selected: tags.length,
    displayed: 0, omitted: 0, pointer_only: tags.length, suppression_reason: null,
    delivery_id: require('node:crypto').randomUUID(), payload_hash: sha(payload), bytes: Buffer.byteLength(payload),
    stdout_result: 'not-attempted', hook_result: 'pending', elapsed_ms: 0,
    error_codes: priorFailure ? ['post-source-or-state-failed'] : corpus ? [] : ['legacy-source-unverified'],
    decision_id: null, decision: 'warn', predicate: null, predicate_version: null, post_outcome: 'observed-unverified',
    evidence_ref: null, evidence_hash: sha(JSON.stringify(input.tool_response ?? null)), incident_id: null,
    label: null, provenance: 'legacy-pointer-output-only', hostConfirmed: 'unknown',
    maintenance_errors: store.maintenanceErrors,
    items: tags.map((tag) => {
      const found = corpus?.entries.filter((e) => e.tag === tag) || [], e = found.length === 1 ? found[0] : null;
      return { lesson_id: tag, rule_id: null, class_id: e?.classId || null, tag, live_head: tag,
        resolvedFromTag: null, trigger_id: null, score: null, reason: 'legacy-post-pointer',
        sourceRoot: path.resolve(ctx.MEMORY_DIR), file: e?.file || null, line: e?.line || null, endLine: e?.endLine || null,
        trust: e?.trust || 'undeclared', date: e?.date || null, sourceFileSha256: e ? corpus.sources.files.get(e.file).hash : null,
        fullEntrySha256: e ? sha(e.text) : null, displayedTextSha256: null, visibility: 'pointer-only', omission_reason: 'legacy-title-only' };
    }),
  };
  try { store.append({ ...row, stage: 'prepared' }); store.save(); }
  catch (e) { store.close(); throw e; }
  return function complete(error) {
    try {
      store.append({ ...row, stage: error ? 'emission-failed' : 'emitted', stdout_result: error ? 'failed' : 'written',
        hook_result: error || row.error_codes.length ? 'degraded' : 'completed',
        error_codes: error ? [...row.error_codes, 'emission-failed'] : row.error_codes,
        elapsed_ms: Date.now() - Date.parse(startedAt) });
      if (!priorFailure) require('./recall-health.cjs').recordInvocation(store.state, { startedAt,
        errors: error ? ['emission-failed'] : row.error_codes, sourceReady: !!corpus, queryRan: !!corpus,
        matched: tags.length, displayed: 0, omitted: 0 });
      store.state.counts.pointer_only = (store.state.counts.pointer_only || 0) + (error ? 0 : tags.length);
      store.save();
    } catch { console.error('[AxMem recall: degraded] Post 送达回执或失败计数补记失败；持久状态未知。'); }
    finally { try { store.close(); } catch { console.error('[AxMem recall: degraded] Post 状态锁释放失败。'); } }
  };
}
module.exports = { identity, actionId, openStore, suppressPost, prepareLegacyPost };
if (require.main === module && process.argv.includes('--self-test')) {
  require('../adapters/claude-code/test-hook.cjs').componentSelfTest('receipt').catch((e) => { console.error(e); process.exitCode = 1; });
}
