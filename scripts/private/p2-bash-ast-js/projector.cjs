'use strict';

const path = require('path');
const crypto = require('crypto');
const {
  ERROR_CODES,
  hard,
  makeSuccess,
} = require('./protocol.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PARSER = require(path.join(ROOT, 'guards', 'vendor', 'unbash', 'parser.js'));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function materialize(ast) {
  return JSON.parse(JSON.stringify(ast));
}

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
    return;
  }
  for (const item of Object.values(value)) walk(item, visit, seen);
}

function expansionKinds(word) {
  const kinds = new Set();
  walk(word, (node) => {
    if (node === word || typeof node.type !== 'string') return;
    if (/Expansion$/.test(node.type) || /Substitution$/.test(node.type)) kinds.add(node.type);
  });
  return [...kinds].sort();
}

function hasUnquotedRuntimePattern(source) {
  let state = 'plain';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (state === 'single') {
      if (ch === "'") state = 'plain';
      continue;
    }
    if (state === 'double') {
      if (ch === '\\' && i + 1 < source.length) {
        i++;
        continue;
      }
      if (ch === '"') state = 'plain';
      continue;
    }
    if (state === 'ansi') {
      if (ch === '\\' && i + 1 < source.length) {
        i++;
        continue;
      }
      if (ch === "'") state = 'plain';
      continue;
    }
    if (ch === '\\' && i + 1 < source.length) {
      i++;
      continue;
    }
    if (ch === '$' && source[i + 1] === "'") {
      state = 'ansi';
      i++;
      continue;
    }
    if (ch === '$' && source[i + 1] === '"') {
      state = 'double';
      i++;
      continue;
    }
    if (ch === "'") {
      state = 'single';
      continue;
    }
    if (ch === '"') {
      state = 'double';
      continue;
    }
    if (ch === '*' || ch === '?' || ch === '[') return true;
    if (ch === '~' && (i === 0 || source[i - 1] === ':' || source[i - 1] === '=')) return true;
  }
  return false;
}

function isWord(node) {
  return !!node &&
    typeof node === 'object' &&
    typeof node.text === 'string' &&
    Number.isSafeInteger(node.pos) &&
    Number.isSafeInteger(node.end);
}

function sourceSlice(source, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end > source.length) {
    hard(ERROR_CODES.SCHEMA, 'unbash returned an invalid source span');
  }
  return source.slice(start, end);
}

function projectWord(word, source) {
  if (!isWord(word)) hard(ERROR_CODES.SCHEMA, 'unbash word lacks source span');
  const spelling = sourceSlice(source, word.pos, word.end);
  if (spelling !== word.text) hard(ERROR_CODES.SCHEMA, 'unbash word source does not match input span');
  const kinds = expansionKinds(word);
  const dynamic = kinds.length > 0 || hasUnquotedRuntimePattern(spelling);
  let resolvedLiteral = null;
  if (!dynamic) {
    if (typeof word.value === 'string') resolvedLiteral = word.value;
    else resolvedLiteral = spelling;
  }
  return {
    span: { start: word.pos, end: word.end },
    source: spelling,
    dynamic,
    expansionKinds: kinds,
    resolvedLiteral,
  };
}

function projectArrayAssignmentValue(assignment, source) {
  const array = Array.isArray(assignment.array) ? assignment.array.filter(isWord) : [];
  if (array.length === 0) {
    const eq = assignment.text.indexOf('=');
    const start = assignment.pos + (eq >= 0 ? eq + 1 : assignment.text.length);
    return {
      span: { start, end: assignment.end },
      source: sourceSlice(source, start, assignment.end),
      dynamic: true,
      expansionKinds: [],
      resolvedLiteral: null,
    };
  }
  const start = array[0].pos;
  const end = array[array.length - 1].end;
  const kinds = new Set();
  let dynamic = array.length !== 1;
  for (const item of array) {
    const p = projectWord(item, source);
    if (p.dynamic) dynamic = true;
    for (const kind of p.expansionKinds) kinds.add(kind);
  }
  return {
    span: { start, end },
    source: sourceSlice(source, start, end),
    dynamic: true,
    expansionKinds: [...kinds].sort(),
    resolvedLiteral: null,
  };
}

function projectAssignment(assignment, source) {
  let value;
  if (isWord(assignment.value)) {
    value = projectWord(assignment.value, source);
  } else if (Array.isArray(assignment.array)) {
    value = projectArrayAssignmentValue(assignment, source);
  } else {
    const eq = assignment.text.indexOf('=');
    const start = assignment.pos + (eq >= 0 ? eq + 1 : assignment.text.length);
    value = {
      span: { start, end: assignment.end },
      source: sourceSlice(source, start, assignment.end),
      dynamic: false,
      expansionKinds: [],
      resolvedLiteral: sourceSlice(source, start, assignment.end),
    };
  }
  return {
    span: { start: assignment.pos, end: assignment.end },
    name: assignment.name,
    source: sourceSlice(source, assignment.pos, assignment.end),
    value,
  };
}

function projectHeredoc(redirect) {
  if (redirect.operator !== '<<' && redirect.operator !== '<<-') return null;
  return {
    delimiterSource: redirect.target.text,
    quoted: redirect.heredocQuoted === true,
    rawSourceContent: typeof redirect.content === 'string' ? redirect.content : '',
  };
}

function projectRedirection(redirect, source) {
  if (!redirect || typeof redirect.operator !== 'string' || !isWord(redirect.target)) {
    hard(ERROR_CODES.SCHEMA, 'unbash redirection lacks operator or target');
  }
  return {
    span: { start: redirect.pos, end: redirect.end },
    operator: redirect.operator,
    fd: Number.isSafeInteger(redirect.fileDescriptor) ? redirect.fileDescriptor : null,
    target: projectWord(redirect.target, source),
    heredoc: projectHeredoc(redirect),
  };
}

function projectCommand(command, source) {
  const words = [];
  if (isWord(command.name)) words.push(projectWord(command.name, source));
  for (const word of command.suffix || []) {
    if (isWord(word)) words.push(projectWord(word, source));
  }
  const assignments = (command.prefix || [])
    .filter((node) => node && node.type === 'Assignment')
    .map((node) => projectAssignment(node, source));
  const redirections = (command.redirects || []).map((node) => projectRedirection(node, source));
  return {
    span: { start: command.pos, end: command.end },
    words,
    assignments,
    redirections,
  };
}

function projectCompoundStatementRedirections(statement, source) {
  if (!Array.isArray(statement.redirects) || statement.redirects.length === 0) return null;
  return {
    span: { start: statement.pos, end: statement.end },
    words: [],
    assignments: [],
    redirections: statement.redirects.map((node) => projectRedirection(node, source)),
  };
}

function parseMaterialized(source) {
  try {
    return materialize(PARSER.parse(source));
  } catch (error) {
    hard(ERROR_CODES.PARSE, String(error && error.message || error));
  }
}

function projectCommands(ast, source) {
  const commands = [];
  walk(ast, (node) => {
    if (node.type === 'Statement') {
      const compound = projectCompoundStatementRedirections(node, source);
      if (compound) commands.push(compound);
    }
    if (node.type === 'Command') commands.push(projectCommand(node, source));
  });
  return commands;
}

function parseShellV2(input) {
  if (!(typeof input === 'string' || Buffer.isBuffer(input))) {
    hard(ERROR_CODES.INPUT_TYPE, 'v2 Bash source must be a string or Buffer');
  }
  const source = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  const bytes = Buffer.from(source, 'utf8');
  const ast = parseMaterialized(source);
  return makeSuccess({
    sourceBytes: bytes.length,
    sourceSha256: sha256(bytes),
    commands: projectCommands(ast, source),
  });
}

function wordStaticV1(word) {
  if (!word || typeof word !== 'object' || typeof word.text !== 'string') return { ok: false, value: '' };
  function partOK(part) {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'Literal') return true;
    if (part.type === 'DoubleQuoted') {
      return !Array.isArray(part.parts) || part.parts.every((x) => x && x.type === 'Literal');
    }
    return false;
  }
  const parts = Array.isArray(word.parts) ? word.parts : null;
  const ok = !parts || parts.length === 0 || parts.every(partOK);
  return { ok, value: ok ? (typeof word.value === 'string' ? word.value : word.text) : '' };
}

function quotedParamV1(text) {
  const match = /^"\$([A-Za-z_][A-Za-z0-9_]*)"$/.exec(text || '');
  return match ? { exactQuotedParam: true, paramName: match[1] } :
    { exactQuotedParam: false, paramName: '' };
}

function redirectionsForStatementV1(statement) {
  const out = [];
  if (statement && statement.command && Array.isArray(statement.command.redirects)) {
    out.push(...statement.command.redirects);
  }
  if (statement && Array.isArray(statement.redirects)) out.push(...statement.redirects);
  return out;
}

function heredocV1(redirect) {
  return {
    op: redirect.operator,
    marker: redirect.target && typeof redirect.target.value === 'string' ? redirect.target.value : '',
    wordSource: redirect.target && redirect.target.text || '',
    body: typeof redirect.content === 'string' ? redirect.content : '',
  };
}

function redirectionV1(redirect) {
  const quoted = quotedParamV1(redirect.target && redirect.target.text || '');
  return {
    op: redirect.operator,
    fd: redirect.fileDescriptor === undefined ? '' : String(redirect.fileDescriptor),
    wordSource: redirect.target && redirect.target.text || '',
    exactQuotedParam: quoted.exactQuotedParam,
    paramName: quoted.paramName,
    hdoc: (redirect.operator === '<<' || redirect.operator === '<<-') ? heredocV1(redirect) : null,
  };
}

function projectV1Fields(input) {
  if (!(typeof input === 'string' || Buffer.isBuffer(input))) {
    hard(ERROR_CODES.INPUT_TYPE, 'v1 projection source must be a string or Buffer');
  }
  const source = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  const ast = parseMaterialized(source);
  const calls = [];
  const unsupportedCommands = [];
  const heredocs = [];
  const heredocStatements = [];
  walk(ast, (node) => {
    if (node.type === 'Command' && node.name) {
      const staticWord = wordStaticV1(node.name);
      if (!staticWord.ok) {
        unsupportedCommands.push({ source: node.name.text, reason: 'dynamic-or-unsupported-word' });
      } else if (staticWord.value === 'node') {
        const args = (node.suffix || []).filter(isWord);
        const first = args[0];
        const q = quotedParamV1(first && first.text || '');
        calls.push({
          commandValue: 'node',
          firstArgPresent: !!first,
          firstArgSource: first ? first.text : '',
          exactQuotedParam: q.exactQuotedParam,
          paramName: q.paramName,
        });
      }
    }
    if (node && typeof node.operator === 'string' &&
        (node.operator === '<<' || node.operator === '<<-') && node.target) {
      heredocs.push(heredocV1(node));
    }
    if (node.type === 'Statement') {
      const redirs = redirectionsForStatementV1(node);
      if (!redirs.some((r) => r && (r.operator === '<<' || r.operator === '<<-'))) return;
      const simple = !!(node.command && node.command.type === 'Command');
      const name = simple && node.command.name ? wordStaticV1(node.command.name) : { ok: false, value: '' };
      const args = simple && node.command.name ?
        [node.command.name, ...(node.command.suffix || []).filter(isWord)] : [];
      const assignments = simple ?
        (node.command.prefix || []).filter((x) => x && x.type === 'Assignment') : [];
      heredocStatements.push({
        simpleCall: simple,
        commandStatic: simple && !!node.command.name && name.ok,
        commandValue: simple && name.ok ? name.value : '',
        argCount: args.length,
        assignCount: assignments.length,
        redirs: redirs.map(redirectionV1),
      });
    }
  });
  return { calls, unsupportedCommands, heredocs, heredocStatements };
}

module.exports = {
  hasUnquotedRuntimePattern,
  expansionKinds,
  parseMaterialized,
  projectWord,
  parseShellV2,
  projectV1Fields,
};
