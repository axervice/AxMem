'use strict';

const PROTOCOL_VERSION = 2;
const PROTOCOL_SCHEMA = 'axmem-p2-bash-ast/v2';
const LOCK_SCHEMA = 'axmem-p2-bash-ast-js-lock/v1';

const ERROR_CODES = Object.freeze({
  LOCK_READ: 'p2-bash-ast-v2-lock-read',
  LOCK_SCHEMA: 'p2-bash-ast-v2-lock-schema',
  PROTOCOL_VERSION: 'p2-bash-ast-v2-protocol-version',
  SOURCE_SET: 'p2-bash-ast-v2-source-set',
  SOURCE_READ: 'p2-bash-ast-v2-source-read',
  SOURCE_HASH: 'p2-bash-ast-v2-source-hash',
  INPUT_TYPE: 'p2-bash-ast-v2-input-type',
  PARSE: 'p2-bash-ast-v2-parse',
  SCHEMA: 'p2-bash-ast-v2-schema',
  UNSUPPORTED: 'p2-bash-ast-v2-unsupported',
});

const OUTPUT_SHAPE = Object.freeze({
  successKeys: Object.freeze(['schema', 'protocolVersion', 'ok', 'sourceBytes', 'sourceSha256', 'commands']),
  errorKeys: Object.freeze(['schema', 'protocolVersion', 'ok', 'error']),
  errorRecordKeys: Object.freeze(['code', 'detail']),
  commandKeys: Object.freeze(['span', 'words', 'assignments', 'redirections']),
  wordKeys: Object.freeze(['span', 'source', 'dynamic', 'expansionKinds', 'resolvedLiteral']),
  assignmentKeys: Object.freeze(['span', 'name', 'source', 'value']),
  redirectionKeys: Object.freeze(['span', 'operator', 'fd', 'target', 'heredoc']),
  heredocKeys: Object.freeze(['delimiterSource', 'quoted', 'rawSourceContent']),
  spanKeys: Object.freeze(['start', 'end']),
});

class BashAstV2Error extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'BashAstV2Error';
    this.code = code;
    this.detail = detail || '';
  }
}

function hard(code, detail) {
  throw new BashAstV2Error(code, detail);
}

function isObj(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObj(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safeInt(value) {
  return Number.isSafeInteger(value);
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validateSpan(span) {
  return exactKeys(span, OUTPUT_SHAPE.spanKeys) &&
    safeInt(span.start) && safeInt(span.end) &&
    span.start >= 0 && span.end >= span.start;
}

function validateWord(word) {
  if (!exactKeys(word, OUTPUT_SHAPE.wordKeys) ||
      !validateSpan(word.span) ||
      typeof word.source !== 'string' ||
      typeof word.dynamic !== 'boolean' ||
      !Array.isArray(word.expansionKinds) ||
      word.expansionKinds.some((x) => typeof x !== 'string' || !x) ||
      !(word.resolvedLiteral === null || typeof word.resolvedLiteral === 'string')) {
    hard(ERROR_CODES.SCHEMA, 'invalid v2 word record');
  }
  if (word.dynamic && word.resolvedLiteral !== null) {
    hard(ERROR_CODES.SCHEMA, 'dynamic v2 word cannot carry resolvedLiteral');
  }
  if (!word.dynamic && word.resolvedLiteral === null) {
    hard(ERROR_CODES.SCHEMA, 'resolved v2 word must carry resolvedLiteral');
  }
  return word;
}

function validateAssignment(record) {
  if (!exactKeys(record, OUTPUT_SHAPE.assignmentKeys) ||
      !validateSpan(record.span) ||
      typeof record.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(record.name) ||
      typeof record.source !== 'string' || !isObj(record.value)) {
    hard(ERROR_CODES.SCHEMA, 'invalid v2 assignment record');
  }
  validateWord(record.value);
  return record;
}

function validateRedirection(record) {
  if (!exactKeys(record, OUTPUT_SHAPE.redirectionKeys) ||
      !validateSpan(record.span) ||
      typeof record.operator !== 'string' || !record.operator ||
      !(record.fd === null || (safeInt(record.fd) && record.fd >= 0)) ||
      !isObj(record.target) ||
      !(record.heredoc === null || isObj(record.heredoc))) {
    hard(ERROR_CODES.SCHEMA, 'invalid v2 redirection record');
  }
  validateWord(record.target);
  if (record.heredoc !== null) {
    if (!exactKeys(record.heredoc, OUTPUT_SHAPE.heredocKeys) ||
        typeof record.heredoc.delimiterSource !== 'string' ||
        typeof record.heredoc.quoted !== 'boolean' ||
        typeof record.heredoc.rawSourceContent !== 'string') {
      hard(ERROR_CODES.SCHEMA, 'invalid v2 heredoc record');
    }
  }
  return record;
}

function validateCommand(record) {
  if (!exactKeys(record, OUTPUT_SHAPE.commandKeys) ||
      !validateSpan(record.span) ||
      !Array.isArray(record.words) ||
      !Array.isArray(record.assignments) ||
      !Array.isArray(record.redirections)) {
    hard(ERROR_CODES.SCHEMA, 'invalid v2 command record');
  }
  record.words.forEach(validateWord);
  record.assignments.forEach(validateAssignment);
  record.redirections.forEach(validateRedirection);
  return record;
}

function makeSuccess(input) {
  if (!isObj(input) ||
      !safeInt(input.sourceBytes) || input.sourceBytes < 0 ||
      !validSha256(input.sourceSha256) ||
      !Array.isArray(input.commands)) {
    hard(ERROR_CODES.SCHEMA, 'invalid v2 success input');
  }
  input.commands.forEach(validateCommand);
  return {
    schema: PROTOCOL_SCHEMA,
    protocolVersion: PROTOCOL_VERSION,
    ok: true,
    sourceBytes: input.sourceBytes,
    sourceSha256: input.sourceSha256,
    commands: input.commands,
  };
}

function makeError(code, detail) {
  if (typeof code !== 'string' || !code ||
      typeof detail !== 'string') {
    hard(ERROR_CODES.SCHEMA, 'invalid v2 error input');
  }
  return {
    schema: PROTOCOL_SCHEMA,
    protocolVersion: PROTOCOL_VERSION,
    ok: false,
    error: { code, detail },
  };
}

function validateEnvelope(doc) {
  if (!isObj(doc) ||
      doc.schema !== PROTOCOL_SCHEMA ||
      doc.protocolVersion !== PROTOCOL_VERSION ||
      typeof doc.ok !== 'boolean') {
    hard(ERROR_CODES.SCHEMA, 'invalid v2 envelope header');
  }
  if (doc.ok) {
    if (!exactKeys(doc, OUTPUT_SHAPE.successKeys)) {
      hard(ERROR_CODES.SCHEMA, 'invalid v2 success envelope keys');
    }
    return makeSuccess(doc);
  }
  if (!exactKeys(doc, OUTPUT_SHAPE.errorKeys) ||
      !exactKeys(doc.error, OUTPUT_SHAPE.errorRecordKeys) ||
      typeof doc.error.code !== 'string' || !doc.error.code ||
      typeof doc.error.detail !== 'string') {
    hard(ERROR_CODES.SCHEMA, 'invalid v2 error envelope');
  }
  return doc;
}

module.exports = {
  PROTOCOL_VERSION,
  PROTOCOL_SCHEMA,
  LOCK_SCHEMA,
  ERROR_CODES,
  OUTPUT_SHAPE,
  BashAstV2Error,
  hard,
  makeSuccess,
  makeError,
  validateEnvelope,
  validateCommand,
  validateWord,
  validateAssignment,
  validateRedirection,
};
