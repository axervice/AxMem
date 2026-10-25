'use strict';
// REVIEW-ONLY prototype. No CLI, client, hook, model or filesystem activation on import.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HEX64 = /^[a-f0-9]{64}$/;
const FIELDS = ['sessionHash', 'actorHash', 'turnHash', 'taskHash',
  'actionHash', 'sourceHash', 'entryHash'];
const MAX_RECORD_BYTES = 4096;
const MAX_TTL_MS = 120000;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => ({ok: false, code});
function problem(code) { const e = new Error(code); e.code = code; return e; }
function validBinding(b) {
  return b && typeof b === 'object' && !Array.isArray(b) &&
    FIELDS.every(k => typeof b[k] === 'string' && HEX64.test(b[k]));
}
function sameBinding(a, b) {
  return FIELDS.every(k => a[k] === b[k]);
}
function actorKey(b) {
  if (!validBinding(b)) throw problem('INVALID_BINDING');
  return sha(b.sessionHash + '\0' + b.actorHash);
}
function actorPaths(directory, binding) {
  const key = actorKey(binding);
  return {
    state: path.join(directory, 'state-' + key + '.json'),
    lock: path.join(directory, 'state-' + key + '.lock'),
  };
}
function assertRegularStateFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw problem('STATE_LINK');
}
function validateRecord(record) {
  const keys = ['schemaVersion', 'state', 'generation', 'nonceSha256',
    'createdAt', 'expiresAt', ...FIELDS].sort();
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys) ||
      record.schemaVersion !== 1 || !['pending', 'acknowledged'].includes(record.state) ||
      !HEX64.test(record.generation) || !HEX64.test(record.nonceSha256) ||
      !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= record.createdAt ||
      record.expiresAt - record.createdAt > MAX_TTL_MS ||
      !validBinding(record)) throw problem('CORRUPT_STATE');
  return record;
}
function createStateStore(options = {}) {
  const directory = options.directory;
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw problem('INVALID_STATE_DIRECTORY');
  const dir = path.resolve(directory);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const entropy = typeof options.entropy === 'function' ? options.entropy : crypto.randomBytes;
  const ttlMs = options.ttlMs === undefined ? MAX_TTL_MS : options.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS)
    throw problem('INVALID_TTL');
  function checkedDirectory() {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        path.relative(dir, fs.realpathSync(dir)) !== '')
      throw problem('STATE_DIRECTORY_LINK');
  }
  function checkedNow() {
    const n = now();
    if (!Number.isSafeInteger(n) || n < 0) throw problem('INVALID_CLOCK');
    return n;
  }
  function readState(file) {
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);
    assertRegularStateFile(stat);
    if (stat.size > MAX_RECORD_BYTES || stat.size < 2)
      throw problem('STATE_SIZE');
    const data = fs.readFileSync(file);
    if (data.length !== stat.size || data.length > MAX_RECORD_BYTES)
      throw problem('STATE_CHANGED');
    let record;
    try { record = JSON.parse(data.toString('utf8')); }
    catch { throw problem('CORRUPT_STATE'); }
    return validateRecord(record);
  }
  function writeAtomic(file, newRecord, oldRecord) {
    const data = Buffer.from(JSON.stringify(validateRecord(newRecord)) + '\n', 'utf8');
    if (data.length > MAX_RECORD_BYTES) throw problem('STATE_SIZE');
    const partBits = entropy(8);
    if (!Buffer.isBuffer(partBits) || partBits.length !== 8)
      throw problem('ENTROPY_INVALID');
    const part = file + '.tmp-' + partBits.toString('hex');
    let fd = null;
    try {
      fd = fs.openSync(part, 'wx', 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      const found = readState(file);
      if (oldRecord ? !found || found.generation !== oldRecord.generation : !!found)
        throw problem('STATE_CAS_CONFLICT');
      fs.renameSync(part, file);
    } finally {
      if (fd !== null) fs.closeSync(fd);
      if (fs.existsSync(part)) {
        const st = fs.lstatSync(part);
        if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1)
          fs.unlinkSync(part);
      }
    }
  }
  function withActorLock(binding, body) {
    if (!validBinding(binding)) return fail('INVALID_BINDING');
    let paths;
    try { checkedDirectory(); paths = actorPaths(dir, binding); }
    catch (e) { return fail(e.code || 'STATE_IO'); }
    let token = null;
    let fd = null;
    try {
      const bits = entropy(16);
      if (!Buffer.isBuffer(bits) || bits.length !== 16)
        throw problem('ENTROPY_INVALID');
      token = bits.toString('hex');
      fd = fs.openSync(paths.lock, 'wx', 0o600);
      fs.writeFileSync(fd, token);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } catch (e) {
      if (fd !== null) try { fs.closeSync(fd); } catch {}
      return fail(e.code === 'EEXIST' ? 'LOCK_CONFLICT' : 'STATE_IO');
    }
    let result;
    try { result = body(paths.state, checkedNow()); }
    catch (e) { result = fail(e.code || 'STATE_IO'); }
    try {
      const st = fs.lstatSync(paths.lock);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
          fs.readFileSync(paths.lock, 'utf8') !== token)
        throw problem('LOCK_OWNERSHIP');
      fs.unlinkSync(paths.lock);
    } catch { result = fail('LOCK_RELEASE_FAILED'); }
    return result;
  }
  function begin(binding) {
    return withActorLock(binding, (file, at) => {
      let old = readState(file);
      if (old && at >= old.expiresAt) {
        fs.unlinkSync(file);
        old = null;
      }
      if (old) return fail('PENDING_EXISTS');
      const nonce = entropy(32);
      const generationBits = entropy(32);
      if (!Buffer.isBuffer(nonce) || nonce.length !== 32 ||
          !Buffer.isBuffer(generationBits) || generationBits.length !== 32)
        throw problem('ENTROPY_INVALID');
      const record = {
        schemaVersion: 1, state: 'pending',
        generation: sha(generationBits), nonceSha256: sha(nonce),
        createdAt: at, expiresAt: at + ttlMs,
        ...Object.fromEntries(FIELDS.map(k => [k, binding[k]])),
      };
      writeAtomic(file, record, null);
      return {ok: true, code: 'CHALLENGE_RESERVED', challenge: nonce.toString('hex')};
    });
  }
  function acknowledge(binding, nonce) {
    if (typeof nonce !== 'string' || !HEX64.test(nonce))
      return fail('INVALID_CHALLENGE');
    return withActorLock(binding, (file, at) => {
      const old = readState(file);
      if (!old) return fail('MISSING');
      if (at >= old.expiresAt) {
        fs.unlinkSync(file);
        return fail('EXPIRED');
      }
      if (at < old.createdAt) return fail('INVALID_CLOCK');
      if (!sameBinding(old, binding)) return fail('BINDING_MISMATCH');
      if (old.state !== 'pending') return fail('REPLAY');
      const actual = Buffer.from(sha(Buffer.from(nonce, 'hex')), 'hex');
      const expected = Buffer.from(old.nonceSha256, 'hex');
      if (!crypto.timingSafeEqual(actual, expected)) return fail('CHALLENGE_MISMATCH');
      const generationBits = entropy(32);
      if (!Buffer.isBuffer(generationBits) || generationBits.length !== 32)
        throw problem('ENTROPY_INVALID');
      writeAtomic(file, {...old, state: 'acknowledged',
        generation: sha(generationBits)}, old);
      return {ok: true, code: 'ACK_RECORDED'};
    });
  }
  function consume(binding) {
    return withActorLock(binding, (file, at) => {
      const record = readState(file);
      if (!record) return fail('MISSING');
      if (at >= record.expiresAt) {
        fs.unlinkSync(file);
        return fail('EXPIRED');
      }
      if (at < record.createdAt) return fail('INVALID_CLOCK');
      if (!sameBinding(record, binding)) return fail('BINDING_MISMATCH');
      if (record.state !== 'acknowledged') return fail('NOT_ACKNOWLEDGED');
      // One-use authorization is consumed BEFORE the native handler attempt.
      fs.unlinkSync(file);
      return {ok: true, code: 'CONSUMED'};
    });
  }
  function invalidateActor(binding) {
    return withActorLock(binding, file => {
      const record = readState(file);
      if (!record) return {ok: true, code: 'ALREADY_ABSENT'};
      if (record.sessionHash !== binding.sessionHash ||
          record.actorHash !== binding.actorHash)
        return fail('BINDING_MISMATCH');
      fs.unlinkSync(file);
      return {ok: true, code: 'INVALIDATED'};
    });
  }
  return Object.freeze({begin, acknowledge, consume, invalidateActor});
}
module.exports = {createStateStore, actorPaths, assertRegularStateFile,
  MAX_RECORD_BYTES, MAX_TTL_MS};
