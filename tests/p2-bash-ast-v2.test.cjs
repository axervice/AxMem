#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

if (process.argv[2] !== '--self-test') {
  console.error('usage: p2-bash-ast-v2.test.cjs --self-test');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const ADAPTER_REL = path.join('scripts', 'private', 'p2-bash-ast-js');
const ADAPTER_ENTRY = path.join(ADAPTER_REL, 'adapter.cjs');
const LOCK_REL = path.join(ADAPTER_REL, 'parser.lock.json');
const FIXTURE = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'round1-real-shape.json');
const GOLDEN = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'golden.json');
const GO_V1_EXE = path.join(ROOT, 'scripts', 'private', 'p2-bash-ast', 'bin', 'p2-bash-ast.exe');
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

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function goHeredoc(h, input) {
  return {
    op: h.op,
    marker: h.marker,
    wordSource: input.subarray(h.word.start, h.word.end).toString('utf8'),
    body: input.subarray(h.body.start, h.body.end).toString('utf8'),
  };
}
function goV1Projection(doc, source) {
  const input = Buffer.from(source, 'utf8');
  return {
    calls: (doc.calls || []).map((x) => ({
      commandValue: x.commandValue,
      firstArgPresent: x.firstArgPresent,
      firstArgSource: x.firstArgSource,
      exactQuotedParam: x.exactQuotedParam,
      paramName: x.paramName,
    })),
    unsupportedCommands: (doc.unsupportedCommands || []).map((x) => ({
      source: x.source,
      reason: x.reason,
    })),
    heredocs: (doc.heredocs || []).map((x) => goHeredoc(x, input)),
    heredocStatements: (doc.heredocStatements || []).map((x) => ({
      simpleCall: x.simpleCall,
      commandStatic: x.commandStatic,
      commandValue: x.commandValue,
      argCount: x.argCount,
      assignCount: x.assignCount,
      redirs: (x.redirs || []).map((r) => ({
        op: r.op,
        fd: r.fd,
        wordSource: r.wordSource,
        exactQuotedParam: r.exactQuotedParam,
        paramName: r.paramName,
        hdoc: r.hdoc ? goHeredoc(r.hdoc, input) : null,
      })),
    })),
  };
}
function runGoV1(source) {
  const result = cp.spawnSync(GO_V1_EXE, [], {
    input: Buffer.from(source, 'utf8'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 8 << 20,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Go v1 helper failed: ' +
      JSON.stringify({ status: result.status, signal: result.signal, error: result.error && result.error.message, stderr: result.stderr }));
  }
  const doc = JSON.parse(String(result.stdout || '').trim());
  if (!doc || doc.ok !== true) throw new Error('Go v1 helper returned non-success JSON');
  return goV1Projection(doc, source);
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


  const nonEolMutant = sandbox('parser-non-eol-byte-mutant');
  const nonEolParser = path.join(nonEolMutant, 'guards', 'vendor', 'unbash', 'parser.js');
  const nonEolBytes = fs.readFileSync(nonEolParser);
  const nonEolIndex = nonEolBytes.findIndex((byte) => byte !== 10 && byte !== 13);
  if (nonEolIndex < 0) throw new Error('parser fixture has no non-EOL byte to mutate');
  nonEolBytes[nonEolIndex] = nonEolBytes[nonEolIndex] === 32 ? 33 : (nonEolBytes[nonEolIndex] ^ 1);
  fs.writeFileSync(nonEolParser, nonEolBytes);
  expectCode(
    'non-EOL single-byte change remains refused after canonicalization',
    () => loadAdapter(nonEolMutant),
    adapter.ERROR_CODES.SOURCE_HASH,
    'If canonicalization altered bytes other than CRLF pairs, a semantic byte mutation could normalize away and falsely pass; SOURCE_HASH over CRLF-to-LF-only canonical bytes excludes that false pass.');

  const eolOnly = sandbox('parser-eol-only-mutant');
  const eolParser = path.join(eolOnly, 'guards', 'vendor', 'unbash', 'parser.js');
  const lfParser = fs.readFileSync(eolParser, 'utf8').replace(/\r\n/g, '\n');
  fs.writeFileSync(eolParser, lfParser.replace(/\n/g, '\r\n'), 'utf8');
  const eolAdapter = loadAdapter(eolOnly);
  check('CRLF-only source difference is accepted by declared canonical hash mode',
    eolAdapter.PIN_VERIFICATION.hashMode === 'crlf-to-lf-bytes-v1',
    JSON.stringify(eolAdapter.PIN_VERIFICATION));

  const dynamicCases = [
    ['brace expansion', 'printf %s x{a,b}', 2, 'BraceExpansion'],
    ['process substitution', 'cat <(printf x)', 1, 'ProcessSubstitution'],
    ['command substitution', 'echo $(printf x)', 1, 'CommandExpansion'],
  ];
  for (const [label, source, wordIndex, kind] of dynamicCases) {
    const doc = adapter.parseShellV2(source);
    const word = doc.commands[0].words[wordIndex];
    check(label + ' is dynamic and unresolved',
      word.dynamic === true && word.resolvedLiteral === null && word.expansionKinds.includes(kind),
      JSON.stringify(word));
  }
  for (const [label, source, kind] of [
    ['arithmetic expansion', 'x=$((1+1))', 'ArithmeticExpansion'],
    ['parameter default expansion', 'x=${V:-d}', 'ParameterExpansion'],
  ]) {
    const doc = adapter.parseShellV2(source);
    const value = doc.commands[0].assignments[0].value;
    check(label + ' assignment is dynamic and unresolved',
      value.dynamic === true && value.resolvedLiteral === null && value.expansionKinds.includes(kind),
      JSON.stringify(value));
  }

  const tildeDynamic = adapter.parseShellV2('node ~/secret.cjs').commands[0].words[1];
  const tildeQuoted = adapter.parseShellV2('node "~/secret.cjs"').commands[0].words[1];
  check('unquoted tilde prefix is dynamic while quoted tilde is resolved',
    tildeDynamic.dynamic === true && tildeDynamic.resolvedLiteral === null &&
    tildeQuoted.dynamic === false && tildeQuoted.resolvedLiteral === '~/secret.cjs',
    JSON.stringify({ tildeDynamic, tildeQuoted }));

  const globDynamic = adapter.parseShellV2('node /outside/*.cjs').commands[0].words[1];
  const globQuoted = adapter.parseShellV2('node "/outside/*.cjs"').commands[0].words[1];
  check('unquoted pathname glob is dynamic while quoted glob is resolved',
    globDynamic.dynamic === true && globDynamic.resolvedLiteral === null &&
    globQuoted.dynamic === false && globQuoted.resolvedLiteral === '/outside/*.cjs',
    JSON.stringify({ globDynamic, globQuoted }));

  const quotedHeredoc = adapter.parseShellV2("cat <<'EOF'\n$X\nEOF\n");
  const unquotedHeredoc = adapter.parseShellV2("cat <<EOF\n$X\nEOF\n");
  const qh = quotedHeredoc.commands[0].redirections[0].heredoc;
  const uh = unquotedHeredoc.commands[0].redirections[0].heredoc;
  check('heredoc facts preserve delimiter quoting and raw source content',
    qh && qh.quoted === true && qh.delimiterSource === "'EOF'" && qh.rawSourceContent === '$X\n' &&
    uh && uh.quoted === false && uh.delimiterSource === 'EOF' && uh.rawSourceContent === '$X\n',
    JSON.stringify({ qh, uh }));

  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const goldenMismatches = [];
  let goldenWords = 0, goldenAssignments = 0, goldenRedirections = 0;
  for (const entry of golden.entries) {
    const actual = adapter.parseShellV2(entry.original);
    if (!sameJson(actual, entry.output) && goldenMismatches.length < 10) goldenMismatches.push(entry.id);
    for (const command of actual.commands) {
      goldenWords += command.words.length;
      goldenAssignments += command.assignments.length;
      goldenRedirections += command.redirections.length;
    }
  }
  check('1616-entry v2 projection equals reviewed golden',
    golden.entryCount === 1616 && golden.entries.length === 1616 &&
    goldenMismatches.length === 0 &&
    goldenWords === 12222 && goldenAssignments === 1117 && goldenRedirections === 937,
    JSON.stringify({ entryCount: golden.entries.length, mismatches: goldenMismatches, goldenWords, goldenAssignments, goldenRedirections }));

  const goldenNegativeActual = adapter.parseShellV2(golden.entries[0].original);
  const goldenNegativeExpected = JSON.parse(JSON.stringify(golden.entries[0].output));
  goldenNegativeExpected.sourceSha256 = '0'.repeat(64);
  evidence(
    'golden comparator negative control detects a mutated expected digest',
    'sameJson(actual, mutatedExpected) === false',
    sameJson(goldenNegativeActual, goldenNegativeExpected),
    'If the golden assertion ignored output bytes or always returned true, a mutated golden entry would still pass; exact JSON equality excludes that false pass.');
  check('golden comparator negative control detects a mutated expected digest',
    sameJson(goldenNegativeActual, goldenNegativeExpected) === false,
    JSON.stringify({ corpusId: golden.entries[0].id }));

  if (!fs.existsSync(GO_V1_EXE)) throw new Error('Go v1 helper fixture is required for round-2 parity');
  let v1Agree = 0;
  const v1Mismatches = [];
  let v1Negative = null;
  for (const entry of golden.entries) {
    const jsV1 = adapter.projectV1Fields(entry.original);
    const goV1 = runGoV1(entry.original);
    if (sameJson(jsV1, goV1)) v1Agree++;
    else if (v1Mismatches.length < 10) v1Mismatches.push(entry.id);
    if (!v1Negative && jsV1.calls.length > 0) {
      const mutant = JSON.parse(JSON.stringify(jsV1));
      mutant.calls[0].commandValue = 'mutated-node';
      v1Negative = { id: entry.id, detected: !sameJson(mutant, goV1) };
    }
  }
  check('v1 field projection remains equal to Go v1 on all 1616 corpus entries',
    v1Agree === 1616 && v1Mismatches.length === 0,
    JSON.stringify({ v1Agree, mismatches: v1Mismatches }));
  evidence(
    'v1 parity negative control detects a mutated projected field',
    true,
    v1Negative,
    'If v1 parity compared only parse success or ignored call fields, mutating commandValue would still pass; exact projected-field equality excludes that false pass.');
  check('v1 parity negative control detects a mutated projected field',
    v1Negative && v1Negative.detected === true,
    JSON.stringify(v1Negative));

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
