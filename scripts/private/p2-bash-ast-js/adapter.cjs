'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const protocol = require('./protocol.cjs');

const {
  PROTOCOL_VERSION,
  PROTOCOL_SCHEMA,
  LOCK_SCHEMA,
  ERROR_CODES,
  BashAstV2Error,
  hard,
  makeSuccess,
  makeError,
  validateEnvelope,
  OUTPUT_SHAPE,
} = protocol;

const LOCK_NAME = 'parser.lock.json';
const ADAPTER_DIR_REL = 'scripts/private/p2-bash-ast-js';
const UNBASH_DIR_REL = 'guards/vendor/unbash';
const ACORN_REL = 'guards/vendor/acorn.js';
const PARSER_ENTRY_REL = 'guards/vendor/unbash/parser.js';
const HASH_MODE = 'crlf-to-lf-bytes-v1';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function canonicalSourceBytes(buf) {
  let crlf = 0;
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) crlf++;
  }
  if (crlf === 0) return buf;
  const out = Buffer.allocUnsafe(buf.length - crlf);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 13 && i + 1 < buf.length && buf[i + 1] === 10) continue;
    out[j++] = buf[i];
  }
  return out;
}

function repoRootFor(moduleDir = __dirname) {
  return path.resolve(moduleDir, '..', '..', '..');
}

function rel(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function listFilesRecursive(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    hard(ERROR_CODES.SOURCE_READ, 'cannot list pinned source directory: ' + error.message);
  }
  const out = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function expectedPinnedPaths(root) {
  const unbashDir = path.join(root, ...UNBASH_DIR_REL.split('/'));
  const adapterDir = path.join(root, ...ADAPTER_DIR_REL.split('/'));
  const acorn = path.join(root, ...ACORN_REL.split('/'));
  const unbash = listFilesRecursive(unbashDir).map((file) => rel(root, file));
  let adapterFiles;
  try {
    adapterFiles = fs.readdirSync(adapterDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== LOCK_NAME)
      .map((entry) => rel(root, path.join(adapterDir, entry.name)));
  } catch (error) {
    hard(ERROR_CODES.SOURCE_READ, 'cannot list v2 adapter directory: ' + error.message);
  }
  if (!fs.existsSync(acorn) || !fs.statSync(acorn).isFile()) {
    hard(ERROR_CODES.SOURCE_READ, 'pinned Acorn source is missing');
  }
  return [...unbash, ACORN_REL, ...adapterFiles].sort();
}

function readLock(root) {
  const lockPath = path.join(root, ...ADAPTER_DIR_REL.split('/'), LOCK_NAME);
  let text;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    hard(ERROR_CODES.LOCK_READ, 'cannot read v2 parser lock: ' + error.message);
  }
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    hard(ERROR_CODES.LOCK_SCHEMA, 'v2 parser lock is not valid JSON');
  }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock) ||
      lock.schema !== LOCK_SCHEMA ||
      lock.hashMode !== HASH_MODE ||
      !Number.isSafeInteger(lock.protocolVersion) ||
      lock.protocolSchema !== PROTOCOL_SCHEMA ||
      lock.parserEntry !== PARSER_ENTRY_REL ||
      lock.acornEntry !== ACORN_REL ||
      !Array.isArray(lock.files)) {
    hard(ERROR_CODES.LOCK_SCHEMA, 'v2 parser lock metadata mismatch');
  }
  if (lock.protocolVersion !== PROTOCOL_VERSION) {
    hard(ERROR_CODES.PROTOCOL_VERSION,
      'v2 parser lock protocolVersion ' + lock.protocolVersion +
      ' does not match adapter protocolVersion ' + PROTOCOL_VERSION);
  }
  const seen = new Set();
  for (const item of lock.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).sort().join(',') !== 'bytes,path,role,sha256' ||
        typeof item.path !== 'string' || !item.path ||
        !['unbash', 'acorn', 'adapter'].includes(item.role) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0 ||
        typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
        seen.has(item.path)) {
      hard(ERROR_CODES.LOCK_SCHEMA, 'invalid v2 parser lock file record');
    }
    seen.add(item.path);
  }
  return lock;
}

function verifyPinnedSources(options = {}) {
  const root = options.repoRoot ? path.resolve(options.repoRoot) : repoRootFor();
  const lock = readLock(root);
  const expectedPaths = expectedPinnedPaths(root);
  const lockedPaths = lock.files.map((item) => item.path).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(lockedPaths)) {
    hard(ERROR_CODES.SOURCE_SET,
      'v2 pinned source set mismatch: expected=' +
      JSON.stringify(expectedPaths) + ' locked=' + JSON.stringify(lockedPaths));
  }
  for (const item of lock.files) {
    const file = path.join(root, ...item.path.split('/'));
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (error) {
      hard(ERROR_CODES.SOURCE_READ, 'cannot read pinned source ' + item.path + ': ' + error.message);
    }
    const canonical = canonicalSourceBytes(buf);
    const got = sha256(canonical);
    if (canonical.length !== item.bytes || got !== item.sha256) {
      hard(ERROR_CODES.SOURCE_HASH,
        'v2 pinned source mismatch at ' + item.path +
        ': expected canonical bytes=' + item.bytes + ' sha256=' + item.sha256 +
        ', got canonical bytes=' + canonical.length + ' sha256=' + got);
    }
  }
  return Object.freeze({
    protocolVersion: lock.protocolVersion,
    protocolSchema: lock.protocolSchema,
    hashMode: lock.hashMode,
    fileCount: lock.files.length,
    lock,
  });
}

const PIN_VERIFICATION = verifyPinnedSources();

function describeProtocol() {
  return {
    schema: PROTOCOL_SCHEMA,
    protocolVersion: PROTOCOL_VERSION,
    outputShape: OUTPUT_SHAPE,
    hashMode: PIN_VERIFICATION.hashMode,
    parserEntry: PARSER_ENTRY_REL,
    acornEntry: ACORN_REL,
    pinnedFileCount: PIN_VERIFICATION.fileCount,
  };
}

module.exports = {
  BashAstV2Error,
  ERROR_CODES,
  PROTOCOL_VERSION,
  PROTOCOL_SCHEMA,
  OUTPUT_SHAPE,
  PIN_VERIFICATION,
  describeProtocol,
  verifyPinnedSources,
  makeSuccess,
  makeError,
  validateEnvelope,
};
