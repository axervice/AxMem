#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

if (process.argv[2] !== '--self-test') {
  console.error('usage: p2-bash-ast-v2.test.cjs --self-test');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const ADAPTER_REL = path.join('scripts', 'private', 'p2-bash-ast-js');
const ADAPTER_ENTRY = path.join(ADAPTER_REL, 'adapter.cjs');
const LOCK_REL = path.join(ADAPTER_REL, 'parser.lock.json');
const FIXTURE = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'round1-real-shape.json');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-v2-selftest-'));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('PASS ' + name);
    pass++;
  } else {
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
    fail++;
  }
}
function evidence(assertion, expected, actual, falsePassGuard) {
  console.log('EVIDENCE ' + JSON.stringify({ assertion, expected, actual, falsePassGuard }));
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function copyPinnedTree(dst) {
  fs.mkdirSync(path.join(dst, 'guards', 'vendor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'guards', 'vendor', 'unbash'),
    path.join(dst, 'guards', 'vendor', 'unbash'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'guards', 'vendor', 'acorn.js'),
    path.join(dst, 'guards', 'vendor', 'acorn.js'));
  fs.mkdirSync(path.join(dst, 'scripts', 'private'), { recursive: true });
  fs.cpSync(path.join(ROOT, ADAPTER_REL), path.join(dst, ADAPTER_REL), { recursive: true });
  return dst;
}
function sandbox(name) {
  return copyPinnedTree(path.join(T, name));
}
function loadAdapter(root) {
  return require(path.join(root, ADAPTER_ENTRY));
}
function caught(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}
function expectCode(assertion, fn, expectedCode, falsePassGuard) {
  const error = caught(fn);
  const actual = error ? { name: error.name, code: error.code || null, detail: error.detail || error.message } : null;
  evidence(assertion, expectedCode, actual, falsePassGuard);
  check(assertion, !!error && error.code === expectedCode, JSON.stringify(actual));
  return error;
}

try {
  const adapter = loadAdapter(ROOT);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, LOCK_REL), 'utf8'));

  const normal = {
    protocolVersion: adapter.PIN_VERIFICATION.protocolVersion,
    protocolSchema: adapter.PIN_VERIFICATION.protocolSchema,
    fileCount: adapter.PIN_VERIFICATION.fileCount,
    lockedFileCount: lock.files.length,
  };
  check('normal pinned source set verifies on module load',
    normal.protocolVersion === adapter.PROTOCOL_VERSION &&
    normal.protocolSchema === adapter.PROTOCOL_SCHEMA &&
    normal.fileCount === normal.lockedFileCount,
    JSON.stringify(normal));

  const parserMutant = sandbox('parser-byte-mutant');
  fs.appendFileSync(path.join(parserMutant, 'guards', 'vendor', 'unbash', 'parser.js'), '\n');
  expectCode(
    'changed byte in pinned unbash source is refused',
    () => loadAdapter(parserMutant),
    adapter.ERROR_CODES.SOURCE_HASH,
    'Without per-file hash verification the altered parser source would load and this test would pass; SOURCE_HASH excludes that false pass.');

  const acornMutant = sandbox('acorn-byte-mutant');
  fs.appendFileSync(path.join(acornMutant, 'guards', 'vendor', 'acorn.js'), '\n');
  expectCode(
    'changed byte in pinned acorn source is refused',
    () => loadAdapter(acornMutant),
    adapter.ERROR_CODES.SOURCE_HASH,
    'Without Acorn in the pinned source set inline-JS semantics could change unnoticed; SOURCE_HASH excludes that false pass.');

  const adapterMutant = sandbox('adapter-byte-mutant');
  fs.appendFileSync(path.join(adapterMutant, ADAPTER_ENTRY), '\n');
  expectCode(
    'changed byte in pinned adapter source is refused',
    () => loadAdapter(adapterMutant),
    adapter.ERROR_CODES.SOURCE_HASH,
    'Without adapter self-source pinning projector behavior could drift while parser hashes stay green; SOURCE_HASH excludes that false pass.');

  const versionMutant = sandbox('protocol-version-mutant');
  const versionLockPath = path.join(versionMutant, LOCK_REL);
  const versionLock = JSON.parse(fs.readFileSync(versionLockPath, 'utf8'));
  versionLock.protocolVersion = adapter.PROTOCOL_VERSION + 1;
  fs.writeFileSync(versionLockPath, JSON.stringify(versionLock, null, 2) + '\n');
  expectCode(
    'protocol version mismatch is refused',
    () => loadAdapter(versionMutant),
    adapter.ERROR_CODES.PROTOCOL_VERSION,
    'Without an explicit version equality check a lock for a different protocol could be accepted; PROTOCOL_VERSION excludes that false pass.');

  const setMutant = sandbox('source-set-mutant');
  fs.writeFileSync(path.join(setMutant, 'guards', 'vendor', 'unbash', 'unpinned.tmp'), 'extra\n');
  expectCode(
    'unpinned file added to parser directory is refused',
    () => loadAdapter(setMutant),
    adapter.ERROR_CODES.SOURCE_SET,
    'Without exhaustive source-set comparison a new parser-side file could influence future imports without appearing in the lock; SOURCE_SET excludes that false pass.');

  const real = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const raw = Buffer.from(real.original, 'utf8');
  check('real corpus fixture remains byte-bound',
    raw.length === real.protocolSample.sourceBytes &&
    sha256(raw) === real.protocolSample.sourceSha256,
    JSON.stringify({ bytes: raw.length, sha256: sha256(raw) }));

  const success = adapter.makeSuccess(real.protocolSample);
  const validatedSuccess = adapter.validateEnvelope(success);
  check('real-shaped success envelope satisfies fixed v2 schema',
    validatedSuccess.ok === true &&
    validatedSuccess.commands.length === 1 &&
    validatedSuccess.commands[0].words.length === 3,
    JSON.stringify(validatedSuccess));

  const malformedSuccess = JSON.parse(JSON.stringify(success));
  malformedSuccess.commands[0].words[2].resolvedLiteral = 'must-not-resolve';
  expectCode(
    'dynamic word carrying resolvedLiteral is refused by v2 schema',
    () => adapter.validateEnvelope(malformedSuccess),
    adapter.ERROR_CODES.SCHEMA,
    'Without the dynamic/resolvedLiteral invariant a dynamic target could masquerade as a resolved path; SCHEMA excludes that false pass.');

  const errorEnvelope = adapter.makeError(adapter.ERROR_CODES.PARSE, 'synthetic parse failure');
  const validatedError = adapter.validateEnvelope(errorEnvelope);
  check('stable error envelope satisfies fixed v2 schema',
    validatedError.ok === false &&
    validatedError.error.code === adapter.ERROR_CODES.PARSE &&
    validatedError.error.detail === 'synthetic parse failure',
    JSON.stringify(validatedError));

  const malformedError = JSON.parse(JSON.stringify(errorEnvelope));
  malformedError.error.extra = true;
  expectCode(
    'error envelope with extra field is refused by v2 schema',
    () => adapter.validateEnvelope(malformedError),
    adapter.ERROR_CODES.SCHEMA,
    'Without exact error-envelope keys callers could observe unstable ad-hoc error shapes; SCHEMA excludes that false pass.');

  const description = adapter.describeProtocol();
  check('protocol description exposes pinned parser and acorn entries',
    description.protocolVersion === adapter.PROTOCOL_VERSION &&
    typeof description.parserEntry === 'string' &&
    typeof description.acornEntry === 'string' &&
    description.pinnedFileCount === lock.files.length,
    JSON.stringify(description));
} finally {
  fs.rmSync(T, { recursive: true, force: true });
}

console.log('P2-BASH-AST-V2-SELFTEST ' + JSON.stringify({ pass, fail }));
if (fail) process.exit(1);
