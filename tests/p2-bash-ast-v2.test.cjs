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
const CORPUS_GOLDEN = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'corpus-golden.json');
const CORPUS_WHOLEFILE_GOLDEN = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'corpus-wholefile-golden.json');
const CORPUS_FILES_DIR = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'corpus-files');
const CORPUS_FILES_MANIFEST = path.join(CORPUS_FILES_DIR, 'MANIFEST.json');
const CORPUS_SHA256 = '944a44bce7fb48c83a685d47a2478e669fe81526c5826304cb3cf759baf5945d';
const CORPUS_ARGV1 = Object.freeze({
  'guards/bash-pipe-exitcode-watch.sh': [''],
  'guards/pmm-bash-impression.sh': [''],
  'guards/pmm-home.sh': [''],
  'guards/pmm-shell-memory-watch.sh': [''],
  'guards/pmm-trigger-recall.sh': [''],
  'guards/pmm-trigger-write-gate.sh': [''],
  'memory/_local-config/pmm-receipt.sh': ['from-hook', 'stop-check', 'pending', 'pending-rows'],
  'pmm-dream-pending-watch.sh': [''],
  'pmm-entry-length-watch.sh': ['', '--block'],
  'pmm-heat-collect.sh': [''],
  'pmm-lessons-routing.sh': ['', '--block'],
  'pmm-pre-compact.sh': [''],
  'pmm-size-watch.sh': [''],
});
const CORPUS_SOURCED = new Set(['guards/pmm-home.sh']);

const V1_RECORDED = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'v1-projection-recorded.json');
const V1_RECORDED_SHA256 = '3c87126b6d349241279021a121a884e3a3b27f8f98c3514d6207b9672c81ccc5';
const V1_LIVE_SAMPLE_IDS = Object.freeze(["00001","00053","00105","00157","00209","00261","00314","00366","00418","00470","00522","00574","00626","00678","00730","00782","00835","00887","00939","00991","01043","01095","01147","01199","01251","01303","01356","01408","01460","01512","01564","01616"]);
const GO_V1_EXE = path.join(ROOT, 'scripts', 'private', 'p2-bash-ast', 'bin', 'p2-bash-ast.exe');
const GO_V1_LOCK = path.join(ROOT, 'scripts', 'private', 'p2-bash-ast', 'helper.lock.json');
const ROUND4_CASES = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'round4-defense-cases.json');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-v2-selftest-'));

let pass = 0;
let fail = 0;
let skip = 0;
const skipReasons = [];
function check(name, ok, detail) {
  if (ok) {
    console.log('PASS ' + name);
    pass++;
  } else {
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
    fail++;
  }
}
function skipCheck(name, reason) {
  console.log('SKIP ' + name + ' :: ' + reason);
  skip++;
  skipReasons.push({ name, reason });
}
function evidence(assertion, expected, actual, falsePassGuard) {
  console.log('EVIDENCE ' + JSON.stringify({ assertion, expected, actual, falsePassGuard }));
}
function ruleCase(name, positiveOk, positiveActual, negativeOk, negativeActual, falsePassGuard) {
  evidence(name, { positive: true, negative: true }, { positive: positiveActual, negative: negativeActual }, falsePassGuard);
  check(name, positiveOk && negativeOk, JSON.stringify({ positive: positiveActual, negative: negativeActual }));
}
function target(scan, predicate) {
  return scan.targets.find(predicate) || null;
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function loadPinnedCorpusFiles() {
  const manifestBytes = fs.readFileSync(CORPUS_FILES_MANIFEST);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const rows = [];
  for (const item of manifest.files || []) {
    const abs = path.join(CORPUS_FILES_DIR, ...item.relativePath.split('/'));
    const bytes = fs.readFileSync(abs);
    rows.push({
      ...item,
      bytesActual: bytes.length,
      sha256Actual: sha256(bytes),
      source: bytes.toString('utf8'),
    });
  }
  return { manifest, manifestBytes, rows };
}
function corpusScanOptions(row) {
  return {
    fromPath: row.relativePath,
    productionArgv1Values: CORPUS_ARGV1[row.relativePath] || [],
    productionInvocationPaths: [row.livePath],
    sourcedOnProductionPath: CORPUS_SOURCED.has(row.relativePath),
    productionSourcePaths: CORPUS_SOURCED.has(row.relativePath) ? [row.livePath] : [],
  };
}
function corpusWholefileScan(adapter, row) {
  return adapter.scanDependencyTargets(Buffer.from(row.source, 'utf8'), corpusScanOptions(row));
}


function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function firstJsonDifference(expected, actual, at = '$') {
  if (Object.is(expected, actual)) return null;
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
    return { path: at, expected, actual };
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return { path: at, expected, actual };
    if (expected.length !== actual.length) {
      return { path: at + '.length', expected: expected.length, actual: actual.length };
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = firstJsonDifference(expected[i], actual[i], at + '[' + i + ']');
      if (diff) return diff;
    }
    return null;
  }
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  if (!sameJson(expectedKeys, actualKeys)) return { path: at + '.keys', expected: expectedKeys, actual: actualKeys };
  for (const key of expectedKeys) {
    const diff = firstJsonDifference(expected[key], actual[key], at + '.' + key);
    if (diff) return diff;
  }
  return null;
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
function runGoV1(source, exe = GO_V1_EXE) {
  const result = cp.spawnSync(exe, [], {
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
function goV1HelperStatus(exe) {
  if (!fs.existsSync(exe)) {
    return {
      state: 'skip',
      reason: 'Go v1 helper is absent (ignored build artifact): ' + exe,
    };
  }
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(GO_V1_LOCK, 'utf8'));
  } catch (error) {
    return { state: 'fail', reason: 'Go v1 helper lock cannot be read: ' + error.message };
  }
  const actualSha256 = sha256(fs.readFileSync(exe));
  const expectedSha256 = lock && lock.executableSha256;
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    return { state: 'fail', reason: 'Go v1 helper lock executableSha256 is invalid' };
  }
  if (actualSha256 !== expectedSha256) {
    return {
      state: 'fail',
      reason: 'Go v1 helper sha256 mismatch: expected ' + expectedSha256 + ', got ' + actualSha256,
    };
  }
  return { state: 'ready', reason: null, sha256: actualSha256 };
}
function runFixedLiveV1Sample(exe, golden, v1FixtureById) {
  const helper = goV1HelperStatus(exe);
  if (helper.state !== 'ready') {
    return {
      skipped: helper.state === 'skip',
      failed: helper.state === 'fail',
      reason: helper.reason,
      rows: [],
    };
  }
  const rows = [];
  for (const id of V1_LIVE_SAMPLE_IDS) {
    const goldenEntry = golden.entries.find((entry) => entry.id === id);
    const recorded = v1FixtureById.get(id);
    const live = goldenEntry ? runGoV1(goldenEntry.original, exe) : null;
    rows.push({
      id,
      ok: !!goldenEntry && !!recorded && sameJson(live, recorded.projection),
    });
  }
  return { skipped: false, failed: false, reason: null, rows, helperSha256: helper.sha256 };
}
function copyPinnedTree(dst) {
  fs.mkdirSync(path.join(dst, 'guards', 'vendor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'guards', 'vendor', 'unbash'),
    path.join(dst, 'guards', 'vendor', 'unbash'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'guards', 'vendor', 'acorn.js'),
    path.join(dst, 'guards', 'vendor', 'acorn.js'));
  fs.mkdirSync(path.join(dst, 'scripts', 'private'), { recursive: true });
  fs.cpSync(path.join(ROOT, ADAPTER_REL), path.join(dst, ADAPTER_REL), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dst, 'package.json'));
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

  const pinnedCorpus = loadPinnedCorpusFiles();
  const pinnedByRel = new Map(pinnedCorpus.rows.map((row) => [row.relativePath, row]));
  const pinnedCorpusPaths = pinnedCorpus.rows.map((row) => row.relativePath).sort();
  const pinnedWholeScans = new Map(pinnedCorpus.rows.map((row) =>
    [row.relativePath, corpusWholefileScan(adapter, row)]));
  check('R16a-fix6 pinned 13-file corpus bytes match reviewed MANIFEST/CORPUS identity',
    pinnedCorpus.manifest.corpusSha256 === CORPUS_SHA256 &&
      pinnedCorpus.rows.length === 13 &&
      pinnedCorpus.rows.every((row) => row.bytesActual === row.bytes && row.sha256Actual === row.sha256) &&
      pinnedCorpusPaths.includes('pmm-lessons-routing.sh'),
    JSON.stringify({
      corpusSha256: pinnedCorpus.manifest.corpusSha256,
      rows: pinnedCorpus.rows.map((row) => ({
        relativePath: row.relativePath, bytes: row.bytesActual, sha256: row.sha256Actual,
      })),
    }));

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

  const v1FixtureBytes = fs.readFileSync(V1_RECORDED);
  const v1FixtureHash = sha256(v1FixtureBytes);
  const v1Fixture = JSON.parse(v1FixtureBytes.toString('utf8'));
  const v1FixtureById = new Map(v1Fixture.entries.map((entry) => [entry.id, entry]));
  check('recorded Go v1 projection fixture is sha256-pinned and covers the 1616-entry golden',
    v1FixtureHash === V1_RECORDED_SHA256 &&
    v1Fixture.schema === 'axmem-p2-bash-ast-v1-projection-recorded/v1' &&
    v1Fixture.sourceGolden.corpusSha256 === golden.corpusSha256 &&
    v1Fixture.sourceGolden.entryCount === 1616 &&
    v1Fixture.entries.length === 1616 &&
    sameJson(v1Fixture.samplePolicy.ids, V1_LIVE_SAMPLE_IDS),
    JSON.stringify({
      fixtureHash: v1FixtureHash,
      entryCount: v1Fixture.entries.length,
      sampleIds: v1Fixture.samplePolicy.ids,
    }));

  let v1Agree = 0;
  const v1Mismatches = [];
  let v1Negative = null;
  for (const entry of golden.entries) {
    const recorded = v1FixtureById.get(entry.id);
    const jsV1 = adapter.projectV1Fields(entry.original);
    if (recorded &&
        recorded.originalSha256 === entry.originalSha256 &&
        sameJson(jsV1, recorded.projection)) v1Agree++;
    else if (v1Mismatches.length < 10) v1Mismatches.push(entry.id);
    if (!v1Negative && recorded && jsV1.calls.length > 0) {
      const mutant = JSON.parse(JSON.stringify(jsV1));
      mutant.calls[0].commandValue = 'mutated-node';
      v1Negative = { id: entry.id, detected: !sameJson(mutant, recorded.projection) };
    }
  }
  check('v1 field projection remains equal to recorded Go v1 fixture on all 1616 corpus entries',
    v1Agree === 1616 && v1Mismatches.length === 0,
    JSON.stringify({ v1Agree, mismatches: v1Mismatches }));

  const corpusGoldenBytes = fs.readFileSync(CORPUS_GOLDEN);
  const corpusGolden = JSON.parse(corpusGoldenBytes.toString('utf8'));
  const corpusGoldenById = new Map(corpusGolden.entries.map((entry) => [entry.id, entry]));
  const corpusScanMismatches = [];
  const corpusScanCounts = {
    records: 0, resolved: 0, unresolved: 0,
    production: 0, conditional: 0, dormant: 0, unsupported: 0,
  };
  for (const entry of golden.entries) {
    const expected = corpusGoldenById.get(entry.id);
    const actual = adapter.scanDependencyTargets(entry.original);
    for (const record of actual.targets) {
      corpusScanCounts.records++;
      if (Object.prototype.hasOwnProperty.call(corpusScanCounts, record.status)) corpusScanCounts[record.status]++;
      if (Object.prototype.hasOwnProperty.call(corpusScanCounts, record.reachability)) corpusScanCounts[record.reachability]++;
      if (record.kind === 'unsupported-construct') corpusScanCounts.unsupported++;
    }
    const metadataOk = !!expected && expected.kind === entry.kind &&
      expected.originalSha256 === entry.originalSha256;
    const diff = expected ? firstJsonDifference(expected.output, actual) :
      { path: '$.entry', expected: 'present', actual: 'missing' };
    if ((!metadataOk || diff) && corpusScanMismatches.length < 20) {
      corpusScanMismatches.push({ id: entry.id, metadataOk, diff });
    }
  }
  const corpusGoldenIds = new Set(corpusGolden.entries.map((entry) => entry.id));
  const corpusExtraIds = corpusGolden.entries.filter((entry) =>
    !golden.entries.some((sourceEntry) => sourceEntry.id === entry.id)).map((entry) => entry.id);
  const parserLockSha256 = sha256(fs.readFileSync(path.join(ROOT, LOCK_REL)));
  check('R16a-fix5 complete dependency-scan output equals reviewed 1616-entry corpus golden',
    corpusGolden.schema === 'axmem-p2-bash-target-corpus-golden/v2' &&
      corpusGolden.sourceGolden.corpusSha256 === golden.corpusSha256 &&
      corpusGolden.sourceGolden.entryCount === 1616 &&
      corpusGolden.scanner.parserLockSha256 === parserLockSha256 &&
      corpusGolden.entries.length === 1616 && corpusGoldenIds.size === 1616 &&
      corpusExtraIds.length === 0 && corpusScanMismatches.length === 0 &&
      sameJson(corpusScanCounts, corpusGolden.counts),
    JSON.stringify({
      parserLockSha256, expectedParserLockSha256: corpusGolden.scanner.parserLockSha256,
      counts: corpusScanCounts, expectedCounts: corpusGolden.counts,
      extraIds: corpusExtraIds, mismatches: corpusScanMismatches,
    }));


  const wholefileGoldenBytes = fs.readFileSync(CORPUS_WHOLEFILE_GOLDEN);
  const wholefileGolden = JSON.parse(wholefileGoldenBytes.toString('utf8'));
  const wholefileByRel = new Map(wholefileGolden.files.map((entry) => [entry.relativePath, entry]));
  const wholefileMismatches = [];
  const wholefileCounts = {
    records: 0, resolved: 0, unresolved: 0,
    production: 0, conditional: 0, dormant: 0, unsupported: 0,
  };
  const wholefileDormantByRule = {
    'rule1-definite-terminator': 0,
    'rule2-argv1-guard-false': 0,
    'rule3-never-called-function': 0,
  };
  for (const row of pinnedCorpus.rows) {
    const expected = wholefileByRel.get(row.relativePath);
    const actual = pinnedWholeScans.get(row.relativePath);
    for (const record of actual.targets) {
      wholefileCounts.records++;
      if (Object.prototype.hasOwnProperty.call(wholefileCounts, record.status)) wholefileCounts[record.status]++;
      if (Object.prototype.hasOwnProperty.call(wholefileCounts, record.reachability)) wholefileCounts[record.reachability]++;
      if (record.kind === 'unsupported-construct') wholefileCounts.unsupported++;
      if (record.reachability === 'dormant' &&
          Object.prototype.hasOwnProperty.call(wholefileDormantByRule, record.dormantRule)) {
        wholefileDormantByRule[record.dormantRule]++;
      }
    }
    const metadataOk = !!expected &&
      expected.bytes === row.bytesActual && expected.sha256 === row.sha256Actual &&
      sameJson(expected.scanContext, corpusScanOptions(row));
    const diff = expected ? firstJsonDifference(expected.output, actual) :
      { path: '$.file', expected: 'present', actual: 'missing' };
    if ((!metadataOk || diff) && wholefileMismatches.length < 20) {
      wholefileMismatches.push({ relativePath: row.relativePath, metadataOk, diff });
    }
  }
  const wholefileExtra = wholefileGolden.files.filter((entry) => !pinnedByRel.has(entry.relativePath))
    .map((entry) => entry.relativePath);
  check('R16a-fix6 complete 13-file whole-source scan equals reviewed wholefile golden',
    wholefileGolden.schema === 'axmem-p2-bash-target-wholefile-golden/v1' &&
      wholefileGolden.corpusSha256 === CORPUS_SHA256 &&
      wholefileGolden.manifestSha256 === sha256(pinnedCorpus.manifestBytes) &&
      wholefileGolden.scanner.parserLockSha256 === parserLockSha256 &&
      wholefileGolden.files.length === 13 && wholefileByRel.size === 13 &&
      wholefileExtra.length === 0 && wholefileMismatches.length === 0 &&
      sameJson(wholefileCounts, wholefileGolden.counts) &&
      sameJson(wholefileDormantByRule, wholefileGolden.dormantByRule),
    JSON.stringify({
      parserLockSha256, expectedParserLockSha256: wholefileGolden.scanner.parserLockSha256,
      counts: wholefileCounts, expectedCounts: wholefileGolden.counts,
      dormantByRule: wholefileDormantByRule, expectedDormantByRule: wholefileGolden.dormantByRule,
      extra: wholefileExtra, mismatches: wholefileMismatches,
    }));

  const liveSampleResult = runFixedLiveV1Sample(GO_V1_EXE, golden, v1FixtureById);
  if (liveSampleResult.failed) {
    check('fixed 32-entry live Go v1 sample equals the recorded fixture', false, liveSampleResult.reason);
  } else if (liveSampleResult.skipped) {
    if (process.env.AXMEM_REQUIRE_GO_HELPER === '1') {
      check('fixed 32-entry live Go v1 sample equals the recorded fixture', false,
        'AXMEM_REQUIRE_GO_HELPER=1: ' + liveSampleResult.reason);
    } else {
      skipCheck('fixed 32-entry live Go v1 sample equals the recorded fixture', liveSampleResult.reason);
    }
  } else {
    check('fixed 32-entry live Go v1 sample equals the recorded fixture',
      liveSampleResult.rows.length === 32 && liveSampleResult.rows.every((row) => row.ok),
      JSON.stringify({ helperSha256: liveSampleResult.helperSha256, rows: liveSampleResult.rows }));
  }
  const missingLiveSample = runFixedLiveV1Sample(path.join(T, 'missing-go-v1-helper.exe'), golden, v1FixtureById);
  check('R16a-fix4 missing Go v1 helper returns a counted SKIP contract instead of throwing or passing',
    missingLiveSample.skipped === true && missingLiveSample.failed === false &&
      /Go v1 helper is absent/.test(missingLiveSample.reason) &&
      missingLiveSample.rows.length === 0,
    JSON.stringify(missingLiveSample));
  const badGoHelper = path.join(T, 'bad-go-v1-helper.exe');
  fs.writeFileSync(badGoHelper, 'not the pinned helper', 'utf8');
  const badGoStatus = runFixedLiveV1Sample(badGoHelper, golden, v1FixtureById);
  check('R16a-fix4 Go v1 helper sha256 mismatch is always FAIL before spawn',
    badGoStatus.failed === true && badGoStatus.skipped === false &&
      /sha256 mismatch/.test(badGoStatus.reason),
    JSON.stringify(badGoStatus));

  evidence(
    'v1 parity negative control detects a mutated projected field',
    true,
    v1Negative,
    'If v1 parity compared only parse success or ignored call fields, mutating commandValue would still pass; exact projected-field equality excludes that false pass.');
  check('v1 parity negative control detects a mutated projected field',
    v1Negative && v1Negative.detected === true,
    JSON.stringify(v1Negative));


  const sourceResolvedScan = adapter.scanDependencyTargets('source ./a.sh');
  const sourceResolvedTarget = target(sourceResolvedScan, (x) => x.kind === 'shell-source');
  const sourceNoSlashScan = adapter.scanDependencyTargets('source lib.sh');
  const sourceNoSlashTarget = target(sourceNoSlashScan, (x) => x.kind === 'shell-source');
  ruleCase(
    'source uses argv[1] and requires slash or search proof',
    !!sourceResolvedTarget && sourceResolvedTarget.status === 'resolved' && sourceResolvedTarget.target === './a.sh',
    sourceResolvedTarget,
    !!sourceNoSlashTarget && sourceNoSlashTarget.status === 'unresolved' && /no slash/.test(sourceNoSlashTarget.reason),
    sourceNoSlashTarget,
    'If source targets were accepted without slash/PATH proof, source lib.sh would falsely look closed; the unresolved status excludes that false pass.');

  const dotProofScan = adapter.scanDependencyTargets('. lib.sh', { sourceSearchProof: { 'lib.sh': './proof/lib.sh' } });
  const dotProofTarget = target(dotProofScan, (x) => x.command === '.');
  const dotNoProofTarget = target(adapter.scanDependencyTargets('. lib.sh'), (x) => x.command === '.');
  ruleCase(
    'dot command uses the same source-search proof rule',
    !!dotProofTarget && dotProofTarget.status === 'resolved' && dotProofTarget.target === './proof/lib.sh',
    dotProofTarget,
    !!dotNoProofTarget && dotNoProofTarget.status === 'unresolved',
    dotNoProofTarget,
    'If dot bypassed source-search proof, the no-proof control would resolve anyway; the shared shell-source rule excludes that false pass.');

  const bashLiteral = adapter.scanDependencyTargets('bash -c "source ./inner.sh"');
  const bashNested = target(bashLiteral, (x) => x.kind === 'shell-source' && x.origin === 'bash-c');
  const bashDynamic = target(adapter.scanDependencyTargets('bash -c "$X"'), (x) => x.kind === 'shell-inline-code');
  ruleCase(
    'bash -c recursively scans literal code but refuses dynamic code',
    !!bashNested && bashNested.status === 'resolved' && bashNested.target === './inner.sh',
    bashNested,
    !!bashDynamic && bashDynamic.status === 'unresolved' && /dynamic -c code/.test(bashDynamic.reason),
    bashDynamic,
    'If bash -c code were not distinguished from a script target, literal nested source edges would be missed and dynamic code could be guessed; recursive scan plus shell-inline-code unresolved excludes both false passes.');

  const shDashDash = target(adapter.scanDependencyTargets('sh -- ./run.sh'), (x) => x.kind === 'shell-script');
  const shUnknown = target(adapter.scanDependencyTargets('sh --mystery ./run.sh'), (x) => x.kind === 'shell-option-sequence');
  ruleCase(
    'sh consumes -- and rejects unknown option consumption',
    !!shDashDash && shDashDash.status === 'resolved' && shDashDash.target === './run.sh',
    shDashDash,
    !!shUnknown && shUnknown.status === 'unresolved',
    shUnknown,
    'If shell option consumption were guessed, an unknown option could shift the script operand unnoticed; explicit option parsing and unresolved unknowns exclude that false pass.');

  const nodeInlineScan = adapter.scanDependencyTargets(
    'node -e \'require("./a.cjs"); import("./b.mjs")\'');
  const nodeInlineRequire = target(nodeInlineScan, (x) => x.kind === 'node-inline-require');
  const nodeInlineImport = target(nodeInlineScan, (x) => x.kind === 'node-inline-import');
  const nodeInvalidCode = target(adapter.scanDependencyTargets("node -e 'require('"), (x) => x.kind === 'node-inline-code');
  ruleCase(
    'node -e uses pinned Acorn for literal require and import targets',
    !!nodeInlineRequire && nodeInlineRequire.target === './a.cjs' &&
      !!nodeInlineImport && nodeInlineImport.target === './b.mjs' &&
      !nodeInlineScan.targets.some((x) => x.kind === 'node-script'),
    { require: nodeInlineRequire, import: nodeInlineImport, scriptTargets: nodeInlineScan.targets.filter((x) => x.kind === 'node-script') },
    !!nodeInvalidCode && nodeInvalidCode.status === 'unresolved' && /Acorn/.test(nodeInvalidCode.reason),
    nodeInvalidCode,
    'If node -e were treated as a script path or inline JavaScript were regex-guessed, code text could be misclassified; Acorn parsing plus node-inline-code unresolved excludes that false pass.');

  const nodePrint = target(adapter.scanDependencyTargets(
    'node -p \'require("./print.cjs")\''), (x) => x.kind === 'node-inline-require');
  const nodePrintDynamic = target(adapter.scanDependencyTargets(
    'node -p "$X"'), (x) => x.kind === 'node-inline-code');
  ruleCase(
    'node -p follows the same literal-code rule as node -e',
    !!nodePrint && nodePrint.status === 'resolved' && nodePrint.target === './print.cjs',
    nodePrint,
    !!nodePrintDynamic && nodePrintDynamic.status === 'unresolved',
    nodePrintDynamic,
    'If -p were omitted from inline-code handling, it could be misread as a script operand; shared inline parsing and dynamic-code refusal exclude that false pass.');

  const argvDashDash = target(adapter.scanDependencyTargets(
    "node -e 'require(process.argv[1])' -- ./x.cjs"),
    (x) => x.kind === 'node-inline-require' && x.argvIndex === 1);
  const argvDynamic = target(adapter.scanDependencyTargets(
    "node -e 'require(process.argv[1])' \"$X\""),
    (x) => x.kind === 'node-inline-require' && x.argvIndex === 1);
  ruleCase(
    'process.argv binds after Node option consumption and --',
    !!argvDashDash && argvDashDash.status === 'resolved' && argvDashDash.target === './x.cjs' && argvDashDash.expression === './x.cjs',
    argvDashDash,
    !!argvDynamic && argvDynamic.status === 'unresolved' && /binding remains dynamic/.test(argvDynamic.reason),
    argvDynamic,
    'If effective argv included Node options or --, process.argv[1] would bind to the wrong token; consuming Node options and then binding the surviving argv word excludes that false pass.');

  const argvSecond = target(adapter.scanDependencyTargets(
    "node -e 'require(process.argv[2])' -- ./one.cjs ./two.cjs"),
    (x) => x.kind === 'node-inline-require' && x.argvIndex === 2);
  const argvMissing = target(adapter.scanDependencyTargets(
    "node -e 'require(process.argv[2])' -- ./one.cjs"),
    (x) => x.kind === 'node-inline-require' && x.argvIndex === 2);
  ruleCase(
    'process.argv index selects the effective argv entry by index',
    !!argvSecond && argvSecond.status === 'resolved' && argvSecond.target === './two.cjs',
    argvSecond,
    !!argvMissing && argvMissing.status === 'unresolved' && /no bound effective argv/.test(argvMissing.reason),
    argvMissing,
    'If argv indexes were collapsed to the first operand, process.argv[2] would falsely bind to ./one.cjs; indexed effective-argv lookup excludes that false pass.');

  const nodeKnownOption = target(adapter.scanDependencyTargets(
    'node --no-warnings ./main.cjs'), (x) => x.kind === 'node-script');
  const nodeUnknownOption = target(adapter.scanDependencyTargets(
    'node --mystery ./main.cjs'), (x) => x.kind === 'node-option-sequence');
  ruleCase(
    'Node option consumption is allow-listed and unknown sequences are unresolved',
    !!nodeKnownOption && nodeKnownOption.status === 'resolved' && nodeKnownOption.target === './main.cjs',
    nodeKnownOption,
    !!nodeUnknownOption && nodeUnknownOption.status === 'unresolved',
    nodeUnknownOption,
    'If unknown Node options were skipped optimistically, an option operand could be mistaken for the script; the node-option-sequence unresolved record excludes that false pass.');

  const nodeRequireScan = adapter.scanDependencyTargets('node -r ./preload.cjs ./main.cjs');
  const nodeRequireOption = target(nodeRequireScan, (x) => x.kind === 'node-require-option');
  const nodeRequireScript = target(nodeRequireScan, (x) => x.kind === 'node-script');
  const nodeRequireMissing = target(adapter.scanDependencyTargets('node -r'), (x) => x.kind === 'node-require-option');
  ruleCase(
    'node -r target is separate from the main script target',
    !!nodeRequireOption && nodeRequireOption.target === './preload.cjs' &&
      !!nodeRequireScript && nodeRequireScript.target === './main.cjs',
    { require: nodeRequireOption, script: nodeRequireScript },
    !!nodeRequireMissing && nodeRequireMissing.status === 'unresolved',
    nodeRequireMissing,
    'If -r consumption were ignored, the preload could be mistaken for the main script; separate require-option handling and a missing-operand unresolved record exclude that false pass.');

  const execBound = target(adapter.scanDependencyTargets(
    'exec -a label -cl node "$G/x.cjs"', { bindings: { G: 'guards' } }),
    (x) => x.kind === 'node-script');
  const execUnknown = target(adapter.scanDependencyTargets(
    'exec -z node ./x.cjs'), (x) => x.kind === 'exec-option-sequence');
  ruleCase(
    'exec consumes its own options then delegates to the nested command rule',
    !!execBound && execBound.status === 'resolved' && execBound.target === 'guards/x.cjs' && execBound.command === 'node',
    execBound,
    !!execUnknown && execUnknown.status === 'unresolved',
    execUnknown,
    'If exec itself were treated as the path target or its options were not consumed, node delegation would be lost; recursive delegated-command classification plus unresolved unknown exec options exclude that false pass.');

  const functionUncalledScan = adapter.scanDependencyTargets(
    'f(){ node ./inside.cjs; }; echo ok');
  const functionUncalled = target(functionUncalledScan, (x) => x.kind === 'node-script' && x.expression === './inside.cjs');
  const functionCalled = target(adapter.scanDependencyTargets(
    'f(){ node ./inside.cjs; }; f'), (x) => x.kind === 'node-script' && x.expression === './inside.cjs');
  const functionNeverCalled = target(adapter.scanDependencyTargets(
    'f(){ node ./inside.cjs; }; echo ok',
    { proveWholeClosureFunctions: true, wholeClosureNeverCalledFunctions: ['f'] }),
    (x) => x.kind === 'node-script' && x.expression === './inside.cjs');
  ruleCase(
    'function bodies are conditional by default and dormant only with whole-closure never-called proof',
    !!functionUncalled && functionUncalled.status === 'resolved' &&
      functionUncalled.reachability === 'conditional',
    functionUncalled,
    !!functionNeverCalled && functionNeverCalled.status === 'resolved' &&
      functionNeverCalled.reachability === 'dormant' &&
      functionNeverCalled.dormantRule === 'rule3-never-called-function' &&
      !!functionCalled && functionCalled.status === 'resolved' &&
      functionCalled.reachability === 'conditional',
    { neverCalled: functionNeverCalled, called: functionCalled },
    'Without a whole-closure proof an uncalled body must stay conditional; an explicit proof may make it dormant, while a real call remains conditional.');

  const caseScan = adapter.scanDependencyTargets(
    'case "$X" in a) node ./case.cjs;; b) source ./case.sh;; esac');
  const caseNode = target(caseScan, (x) => x.expression === './case.cjs');
  const caseSource = target(caseScan, (x) => x.expression === './case.sh');
  const topLevelNode = target(adapter.scanDependencyTargets(
    'node ./case.cjs'), (x) => x.expression === './case.cjs');
  ruleCase(
    'unproven case arms are conditional with status computed independently',
    !!caseNode && caseNode.status === 'resolved' && caseNode.reachability === 'conditional' &&
      !!caseSource && caseSource.status === 'resolved' && caseSource.reachability === 'conditional',
    { node: caseNode, source: caseSource },
    !!topLevelNode && topLevelNode.status === 'resolved' && topLevelNode.reachability === 'production',
    topLevelNode,
    'If case-arm reachability and target resolution were conflated, resolved conditional dependencies would disappear from the closure graph.');

  const ifScan = adapter.scanDependencyTargets(
    'if test -n "$X"; then node ./yes.cjs; else node ./no.cjs; fi');
  const ifYes = target(ifScan, (x) => x.expression === './yes.cjs');
  const ifNo = target(ifScan, (x) => x.expression === './no.cjs');
  const topLevelYes = target(adapter.scanDependencyTargets(
    'node ./yes.cjs'), (x) => x.expression === './yes.cjs');
  ruleCase(
    'unproven conditional branches are conditional with resolved targets retained',
    !!ifYes && ifYes.status === 'resolved' && ifYes.reachability === 'conditional' &&
      !!ifNo && ifNo.status === 'resolved' && ifNo.reachability === 'conditional',
    { then: ifYes, else: ifNo },
    !!topLevelYes && topLevelYes.status === 'resolved' && topLevelYes.reachability === 'production',
    topLevelYes,
    'A conditional branch is still in the production closure; keeping resolved status independent from conditional reachability prevents the old candidate-loss bug.');

  const heredocData = adapter.scanDependencyTargets(
    "cat <<'EOF'\nnode ./fake.cjs\nsource ./fake.sh\nEOF\n");
  const heredocExecutable = adapter.scanDependencyTargets('node ./fake.cjs; source ./fake.sh');
  ruleCase(
    'heredoc data is not scanned as shell execution',
    heredocData.targets.length === 0,
    heredocData.targets,
    heredocExecutable.targets.length === 2 &&
      heredocExecutable.targets.every((x) => x.reachability === 'production'),
    heredocExecutable.targets,
    'If raw heredoc text were recursively parsed as commands, data lines would create fake dependencies; excluding heredoc content while the same text outside a heredoc produces edges excludes that false pass.');

  const tildeTarget = target(adapter.scanDependencyTargets(
    'node ~/secret.cjs'), (x) => x.kind === 'node-script');
  const tildeQuotedTarget = target(adapter.scanDependencyTargets(
    'node "~/secret.cjs"'), (x) => x.kind === 'node-script');
  ruleCase(
    'unquoted tilde target is unresolved but quoted tilde is literal',
    !!tildeTarget && tildeTarget.status === 'unresolved',
    tildeTarget,
    !!tildeQuotedTarget && tildeQuotedTarget.status === 'resolved' && tildeQuotedTarget.target === '~/secret.cjs',
    tildeQuotedTarget,
    'If target rules ignored the projector dynamic flag, an unquoted tilde would be accepted as its lexical spelling; dynamic target refusal excludes that false pass.');

  const globTarget = target(adapter.scanDependencyTargets(
    'node /outside/*.cjs'), (x) => x.kind === 'node-script');
  const globQuotedTarget = target(adapter.scanDependencyTargets(
    'node "/outside/*.cjs"'), (x) => x.kind === 'node-script');
  ruleCase(
    'unquoted glob target is unresolved but quoted glob is literal',
    !!globTarget && globTarget.status === 'unresolved',
    globTarget,
    !!globQuotedTarget && globQuotedTarget.status === 'resolved' && globQuotedTarget.target === '/outside/*.cjs',
    globQuotedTarget,
    'If target rules trusted lexical value despite pathname expansion, an unquoted glob would be falsely resolved; projector dynamic propagation excludes that false pass.');

  const homeCorpusRow = pinnedByRel.get('guards/pmm-home.sh');
  const homeHelperSource = homeCorpusRow.source;
  const homeHelperScan = pinnedWholeScans.get('guards/pmm-home.sh');
  const homeHelperTarget = target(homeHelperScan,
    (x) => x.kind === 'node-inline-require' &&
      /\/guards\/pmm-recall-ledger\.cjs$/.test(String(x.target || '').replace(/\\/g, '/')));
  const homeLines = homeHelperSource.split(/\r?\n/);
  const isolatedNodeLine = homeLines[58] || '';
  const isolatedHomeScan = adapter.scanDependencyTargets(isolatedNodeLine, corpusScanOptions(homeCorpusRow));
  const isolatedHomeTarget = target(isolatedHomeScan, (x) => x.kind === 'node-inline-require');
  ruleCase(
    'real home helper argv binding finds the ledger dependency',
    !!homeHelperTarget && homeHelperTarget.status === 'resolved' && homeHelperTarget.argvIndex === 1,
    homeHelperTarget,
    !!isolatedHomeTarget && isolatedHomeTarget.status === 'unresolved',
    isolatedHomeTarget,
    'If process.argv binding ignored the preceding script-directory and ledger-argument proof, the real call would stay unresolved or be guessed; scanning the real assignment chain resolves it while the isolated call remains unresolved.');


  const parseErrA = caught(() => adapter.scanDependencyTargets('echo "unterminated'));
  const parseErrB = caught(() => adapter.scanDependencyTargets('node ./a.cjs; ( echo'));
  check('R16a-fix parser errors are PARSE failures, never partial target success',
    !!parseErrA && parseErrA.code === adapter.ERROR_CODES.PARSE &&
    !!parseErrB && parseErrB.code === adapter.ERROR_CODES.PARSE,
    JSON.stringify({
      first: parseErrA && { code: parseErrA.code, detail: parseErrA.detail || parseErrA.message },
      second: parseErrB && { code: parseErrB.code, detail: parseErrB.detail || parseErrB.message },
    }));

  const subshellTarget = target(adapter.scanDependencyTargets('( node ./x.cjs )'),
    (x) => x.kind === 'node-script');
  const braceTarget = target(adapter.scanDependencyTargets('{ node ./x.cjs; }'),
    (x) => x.kind === 'node-script');
  check('R16a-fix grouping constructs recurse into subshell and brace-group commands',
    !!subshellTarget && subshellTarget.status === 'resolved' && subshellTarget.target === './x.cjs' &&
    !!braceTarget && braceTarget.status === 'resolved' && braceTarget.target === './x.cjs',
    JSON.stringify({ subshellTarget, braceTarget }));

  const wrapperCases = [
    ['env -i A=1 node ./x.cjs', 'node-script', './x.cjs'],
    ['command node ./x.cjs', 'node-script', './x.cjs'],
    ['builtin source ./x.sh', 'shell-source', './x.sh'],
    ['exec -- node ./x.cjs', 'node-script', './x.cjs'],
    ['nohup node ./x.cjs', 'node-script', './x.cjs'],
    ['time node ./x.cjs', 'node-script', './x.cjs'],
    ['nice -n 5 node ./x.cjs', 'node-script', './x.cjs'],
    ['timeout 5 node ./x.cjs', 'node-script', './x.cjs'],
    ['stdbuf -oL node ./x.cjs', 'node-script', './x.cjs'],
  ];
  const wrapperActual = wrapperCases.map(([sourceText, kind, expectedTarget]) => {
    const got = target(adapter.scanDependencyTargets(sourceText), (x) => x.kind === kind);
    return { source: sourceText, expectedTarget, got };
  });
  check('R16a-fix wrapper commands delegate after consuming their own syntax',
    wrapperActual.every((row) => row.got && row.got.status === 'resolved' && row.got.target === row.expectedTarget),
    JSON.stringify(wrapperActual));

  const evalLiteral = target(adapter.scanDependencyTargets("eval 'node ./x.cjs'"),
    (x) => x.kind === 'node-script');
  const evalDynamic = target(adapter.scanDependencyTargets('eval "$X"'),
    (x) => x.kind === 'unsupported-construct' && x.construct === 'eval');
  check('R16a-fix eval scans resolved literal code and marks dynamic code UNSUPPORTED',
    !!evalLiteral && evalLiteral.status === 'resolved' && evalLiteral.target === './x.cjs' &&
    !!evalDynamic && evalDynamic.status === 'unresolved' &&
      evalDynamic.code === adapter.ERROR_CODES.UNSUPPORTED,
    JSON.stringify({ evalLiteral, evalDynamic }));

  const unsupportedCases = [
    ['xargs node', 'xargs'],
    ['select x in a; do node ./x.cjs; done', 'select'],
    ['coproc node ./x.cjs', 'coproc'],
  ].map(([sourceText, construct]) => ({
    source: sourceText,
    construct,
    got: target(adapter.scanDependencyTargets(sourceText),
      (x) => x.kind === 'unsupported-construct' && x.construct === construct),
  }));
  check('R16a-fix unmodeled command-bearing constructs emit UNSUPPORTED unresolved records',
    unsupportedCases.every((row) => row.got && row.got.status === 'unresolved' &&
      row.got.code === adapter.ERROR_CODES.UNSUPPORTED),
    JSON.stringify(unsupportedCases));


  const sourceDynamic = target(adapter.scanDependencyTargets('source "$X"'),
    (x) => x.kind === 'shell-source');
  check('R16a-fix source "$X" without a binding is unresolved',
    !!sourceDynamic && sourceDynamic.status === 'unresolved' &&
      sourceDynamic.expression === '"$X"' && /binding proof/.test(sourceDynamic.reason),
    JSON.stringify(sourceDynamic));

  const nodeLongEval = target(adapter.scanDependencyTargets(
    'node --eval \'require("./long-eval.cjs")\''), (x) => x.kind === 'node-inline-require');
  check('R16a-fix node --eval is inline code, not a script',
    !!nodeLongEval && nodeLongEval.status === 'resolved' && nodeLongEval.target === './long-eval.cjs',
    JSON.stringify(nodeLongEval));

  const nodeLongPrint = target(adapter.scanDependencyTargets(
    'node --print \'require("./long-print.cjs")\''), (x) => x.kind === 'node-inline-require');
  check('R16a-fix node --print is inline code, not a script',
    !!nodeLongPrint && nodeLongPrint.status === 'resolved' && nodeLongPrint.target === './long-print.cjs',
    JSON.stringify(nodeLongPrint));

  const nodeFusedEval = target(adapter.scanDependencyTargets(
    'node -e\'require("./fused.cjs")\''), (x) => x.kind === 'node-inline-require');
  check('R16a-fix fused node -eCODE is inline code',
    !!nodeFusedEval && nodeFusedEval.status === 'resolved' && nodeFusedEval.target === './fused.cjs',
    JSON.stringify(nodeFusedEval));

  const nodeEqualsEval = target(adapter.scanDependencyTargets(
    'node --eval=\'require("./equals-eval.cjs")\''), (x) => x.kind === 'node-inline-require');
  check('R16a-fix node --eval=CODE is inline code',
    !!nodeEqualsEval && nodeEqualsEval.status === 'resolved' && nodeEqualsEval.target === './equals-eval.cjs',
    JSON.stringify(nodeEqualsEval));

  const nodeLongRequireScan = adapter.scanDependencyTargets(
    'node --require ./pre-long.cjs ./main-long.cjs');
  const nodeLongRequire = target(nodeLongRequireScan, (x) => x.kind === 'node-require-option');
  const nodeLongRequireScript = target(nodeLongRequireScan, (x) => x.kind === 'node-script');
  check('R16a-fix node --require MODULE consumes MODULE before the script',
    !!nodeLongRequire && nodeLongRequire.target === './pre-long.cjs' &&
      !!nodeLongRequireScript && nodeLongRequireScript.target === './main-long.cjs',
    JSON.stringify({ require: nodeLongRequire, script: nodeLongRequireScript }));

  const nodeEqualsRequireScan = adapter.scanDependencyTargets(
    'node --require=./pre-equals.cjs ./main-equals.cjs');
  const nodeEqualsRequire = target(nodeEqualsRequireScan, (x) => x.kind === 'node-require-option');
  const nodeEqualsRequireScript = target(nodeEqualsRequireScan, (x) => x.kind === 'node-script');
  check('R16a-fix node --require=MODULE consumes MODULE before the script',
    !!nodeEqualsRequire && nodeEqualsRequire.target === './pre-equals.cjs' &&
      !!nodeEqualsRequireScript && nodeEqualsRequireScript.target === './main-equals.cjs',
    JSON.stringify({ require: nodeEqualsRequire, script: nodeEqualsRequireScript }));

  const argvZero = target(adapter.scanDependencyTargets(
    "node -e 'require(process.argv[0])' -- ./x.cjs"),
    (x) => x.kind === 'node-inline-require' && x.expression === 'process.argv[0]');
  check('R16a-fix process.argv[0] is not bound to a dependency operand',
    !!argvZero && argvZero.status === 'unresolved' &&
      /Node executable/.test(argvZero.reason),
    JSON.stringify(argvZero));

  const argvWord = target(adapter.scanDependencyTargets(
    "node -e 'require(process.argv[1])' \"$X\""),
    (x) => x.kind === 'node-inline-require' && x.argvIndex === 1);
  check('R16a-fix dynamic process.argv[1] binding preserves the bound word "$X"',
    !!argvWord && argvWord.status === 'unresolved' && argvWord.expression === '"$X"',
    JSON.stringify(argvWord));

  const bashPlain = target(adapter.scanDependencyTargets(
    'bash ./run.sh'), (x) => x.kind === 'shell-script');
  check('R16a-fix plain bash SCRIPT resolves the script operand',
    !!bashPlain && bashPlain.status === 'resolved' && bashPlain.target === './run.sh',
    JSON.stringify(bashPlain));

  const execDashDash = target(adapter.scanDependencyTargets(
    'exec -- node ./x.cjs'), (x) => x.kind === 'node-script');
  check('R16a-fix exec -- delegates to the following command',
    !!execDashDash && execDashDash.status === 'resolved' && execDashDash.target === './x.cjs',
    JSON.stringify(execDashDash));

  const andTarget = target(adapter.scanDependencyTargets(
    'node ./first.cjs && node ./and.cjs'), (x) => x.expression === './and.cjs');
  check('R16a-fix && right operand is conditional/resolved',
    !!andTarget && andTarget.status === 'resolved' && andTarget.reachability === 'conditional',
    JSON.stringify(andTarget));

  const orTarget = target(adapter.scanDependencyTargets(
    'node ./first.cjs || node ./or.cjs'), (x) => x.expression === './or.cjs');
  check('R16a-fix || right operand is conditional/resolved',
    !!orTarget && orTarget.status === 'resolved' && orTarget.reachability === 'conditional',
    JSON.stringify(orTarget));

  const whileTarget = target(adapter.scanDependencyTargets(
    'while test x; do node ./while.cjs; done'), (x) => x.expression === './while.cjs');
  check('R16a-fix while body dependency is conditional/resolved',
    !!whileTarget && whileTarget.status === 'resolved' && whileTarget.reachability === 'conditional',
    JSON.stringify(whileTarget));

  const forTarget = target(adapter.scanDependencyTargets(
    'for x in a; do node ./for.cjs; done'), (x) => x.expression === './for.cjs');
  check('R16a-fix for body dependency is conditional/resolved',
    !!forTarget && forTarget.status === 'resolved' && forTarget.reachability === 'conditional',
    JSON.stringify(forTarget));

  const f1Sources = [
    'X=./safe.cjs; if true; then X=./outside.cjs; fi; node "$X"',
    'X=./safe.cjs; while false; do X=./outside.cjs; done; node "$X"',
    'X=./safe.cjs; for X in a; do :; done; node "$X"',
    'X=./safe.cjs; case x in a) X=./outside.cjs;; esac; node "$X"',
    'X=./safe.cjs; true && X=./outside.cjs; node "$X"',
    'X=./safe.cjs; false || X=./outside.cjs; node "$X"',
    'X=./safe.cjs; f(){ X=./outside.cjs; }; f; node "$X"',
    'X=./safe.cjs; eval "X=./outside.cjs"; node "$X"',
    'X=./safe.cjs; read X; node "$X"',
    'X=./safe.cjs; export X=./outside.cjs; node "$X"',
    'X=./safe.cjs; declare X=./outside.cjs; node "$X"',
    'X=./safe.cjs; local X=./outside.cjs; node "$X"',
    'X=./safe.cjs; typeset X=./outside.cjs; node "$X"',
    'X=./safe.cjs; readonly X=./outside.cjs; node "$X"',
    'X=./safe.cjs; unset X; node "$X"',
    'X=./safe.cjs; printf -v X %s ./outside.cjs; node "$X"',
    'X=./safe.cjs; mapfile X; node "$X"',
    'X=./safe.cjs; getopts ab X; node "$X"',
    'X=./safe.cjs; source ./lib.sh; node "$X"',
    'X=./safe.cjs; . ./lib.sh; node "$X"',
  ];
  const f1Actual = f1Sources.map((sourceText) => {
    const scan = adapter.scanDependencyTargets(sourceText);
    const got = target(scan, (x) => x.kind === 'node-script' && x.expression === '"$X"');
    return { source: sourceText, got, targets: scan.targets };
  });
  const f1Candidate = target(adapter.scanDependencyTargets(
    'X=./safe.cjs; if true; then node "$X"; fi'),
    (x) => x.kind === 'node-script' && x.expression === '"$X"');
  check('R16a-fix3 F1 non-linear and shell-writer mutations invalidate outer bindings',
    f1Actual.every((row) => !row.got || (row.got.status === 'unresolved' && row.got.target === null)) &&
      !!f1Candidate && f1Candidate.status === 'resolved' &&
      f1Candidate.reachability === 'conditional' && f1Candidate.target === './safe.cjs',
    JSON.stringify({ f1Actual, f1Candidate }));

  const f2Direct = target(adapter.scanDependencyTargets(
    'cat <<EOF\n$(node ./heredoc.cjs)\nEOF\n'),
    (x) => x.kind === 'node-script' && x.expression === './heredoc.cjs');
  const f2Statement = target(adapter.scanDependencyTargets(
    '{ cat; } <<EOF\n$(node ./heredoc-stmt.cjs)\nEOF\n'),
    (x) => x.kind === 'node-script' && x.expression === './heredoc-stmt.cjs');
  check('R16a-fix3 F2 unquoted heredoc command substitutions are scanned at Command and Statement redirects',
    !!f2Direct && f2Direct.status === 'resolved' &&
      !!f2Statement && f2Statement.status === 'resolved',
    JSON.stringify({ f2Direct, f2Statement }));

  const f3Scan = adapter.scanDependencyTargets(
    'case x in "$(node ./case-first.cjs)") :;; "$(node ./case-next.cjs)") :;; esac');
  const f3First = target(f3Scan, (x) => x.kind === 'node-script' && x.expression === './case-first.cjs');
  const f3Next = target(f3Scan, (x) => x.kind === 'node-script' && x.expression === './case-next.cjs');
  check('R16a-fix3 F3 case pattern command substitutions are scanned with first-pattern reachability',
    !!f3First && f3First.status === 'resolved' && f3First.reachability === 'production' &&
      !!f3Next && f3Next.status === 'resolved' && f3Next.reachability === 'conditional',
    JSON.stringify({ f3First, f3Next }));

  const f4QuotedEnv = target(adapter.scanDependencyTargets(
    'env "A=1" node ./env-quoted.cjs'), (x) => x.kind === 'node-script');
  const f4QuotedEnvSingle = target(adapter.scanDependencyTargets(
    "env 'A=1' node ./env-single.cjs"), (x) => x.kind === 'node-script');
  check('R16a-fix3 F4 env recognizes resolved quoted NAME=value assignments',
    !!f4QuotedEnv && f4QuotedEnv.target === './env-quoted.cjs' &&
      !!f4QuotedEnvSingle && f4QuotedEnvSingle.target === './env-single.cjs',
    JSON.stringify({ f4QuotedEnv, f4QuotedEnvSingle }));

  const f5DashDash = target(adapter.scanDependencyTargets(
    'eval -- "node ./eval-dashdash.cjs"'), (x) => x.kind === 'node-script');
  const f5BadOption = target(adapter.scanDependencyTargets(
    'eval -x "node ./eval-bad.cjs"'),
    (x) => x.kind === 'unsupported-construct' && x.construct === 'eval');
  check('R16a-fix3 F5 eval skips one leading -- and refuses other leading options',
    !!f5DashDash && f5DashDash.status === 'resolved' && f5DashDash.target === './eval-dashdash.cjs' &&
      !!f5BadOption && f5BadOption.status === 'unresolved' && f5BadOption.code === adapter.ERROR_CODES.UNSUPPORTED,
    JSON.stringify({ f5DashDash, f5BadOption }));

  const f6Scan = adapter.scanDependencyTargets(
    'node --import ./pre.mjs --loader=./loader.mjs ./main.cjs');
  const f6Import = target(f6Scan, (x) => x.kind === 'node-option-module' && x.option === '--import');
  const f6Loader = target(f6Scan, (x) => x.kind === 'node-option-module' && x.option === '--loader');
  const f6Dynamic = target(adapter.scanDependencyTargets(
    'node --import "$X" ./main.cjs'),
    (x) => x.kind === 'node-option-module' && x.option === '--import');
  check('R16a-fix3 F6 node --import/--loader option modules are dependency targets',
    !!f6Import && f6Import.status === 'resolved' && f6Import.target === './pre.mjs' &&
      !!f6Loader && f6Loader.status === 'resolved' && f6Loader.target === './loader.mjs' &&
      !!f6Dynamic && f6Dynamic.status === 'unresolved',
    JSON.stringify({ f6Import, f6Loader, f6Dynamic }));

  const f7BeforeDefinition = adapter.scanDependencyTargets('f; f(){ node ./later.cjs; }');
  const f7BranchDefinition = adapter.scanDependencyTargets(
    'if false; then f(){ node ./inside.cjs; }; fi; f');
  const f7BeforeProd = f7BeforeDefinition.targets.some(
    (x) => x.expression === './later.cjs' && x.reachability === 'production');
  const f7BranchProd = f7BranchDefinition.targets.some(
    (x) => x.expression === './inside.cjs' && x.reachability === 'production');
  check('R16a-fix3 F7 function definitions are registered in reachable source order',
    !f7BeforeProd && !f7BranchProd,
    JSON.stringify({ before: f7BeforeDefinition.targets, branch: f7BranchDefinition.targets }));

  const f8Delegated = [
    'node(){ :; }; command node ./command-real.cjs',
    'node(){ :; }; env node ./env-real.cjs',
    'node(){ :; }; exec node ./exec-real.cjs',
    'node(){ :; }; nohup node ./nohup-real.cjs',
    'node(){ :; }; nice node ./nice-real.cjs',
    'node(){ :; }; timeout 1 node ./timeout-real.cjs',
    'node(){ :; }; stdbuf -oL node ./stdbuf-real.cjs',
  ].map((sourceText) => ({
    source: sourceText,
    got: target(adapter.scanDependencyTargets(sourceText), (x) => x.kind === 'node-script'),
  }));
  const f8Builtin = adapter.scanDependencyTargets('builtin node ./not-a-builtin.cjs');
  check('R16a-fix3 F8 delegated wrappers bypass the shell function table and builtin rejects non-builtins',
    f8Delegated.every((row) => row.got && row.got.status === 'resolved') &&
      !f8Builtin.targets.some((x) => x.expression === './not-a-builtin.cjs'),
    JSON.stringify({ f8Delegated, builtin: f8Builtin.targets }));

  const f9SyntheticFiles = [{
    file: 'guards/synthetic-path-join-projector.cjs',
    text: "require(path.join(__dirname, '..', 'scripts', 'private', 'p2-bash-ast-js', 'projector.cjs'));",
  }, {
    file: 'guards/synthetic-path-join-target-rules.cjs',
    text: "require(path.join(__dirname, '..', 'scripts', 'private', 'p2-bash-ast-js', 'target-rules.cjs'));",
  }];
  const f9PathJoinSynthetic = repositoryPrivateEntryViolations(ROOT, f9SyntheticFiles);
  const f9LegacyRe = /require\s*\(\s*(['"])([^'"]*(?:projector|target-rules)\.cjs)\1\s*\)/g;
  const f9LegacyHits = f9SyntheticFiles.flatMap((item) =>
    [...item.text.matchAll(f9LegacyRe)].map((match) => ({ file: item.file, target: match[2] })));
  check('R16a-fix3 F9 repository entry check catches constructed projector/target-rules paths',
    f9PathJoinSynthetic.length === 2 && f9LegacyHits.length === 0,
    JSON.stringify({ fixed: f9PathJoinSynthetic, legacy: f9LegacyHits }));

  const bracketWord = adapter.parseShellV2('[ -n "$X" ]').commands[0].words[0];
  const bracketScan = adapter.scanDependencyTargets('[ -n "$X" ]');
  check('R16a-fix3 standalone [ does not create a glob-derived command-name unresolved record',
    bracketWord.source === '[' &&
      !bracketScan.targets.some((x) => x.kind === 'command-name' && x.expression === '['),
    JSON.stringify({ bracketWord, targets: bracketScan.targets }));


  const round4Fixture = JSON.parse(fs.readFileSync(ROUND4_CASES, 'utf8'));
  const round4Cases = round4Fixture.groups.flatMap((group) =>
    group.cases.map((entry) => ({ ...entry, group: group.group })));
  const round4Expected = Object.create(null);
  function tagRound4(tag, ids) {
    for (const id of ids) {
      if (round4Expected[id]) throw new Error('duplicate round4 expectation id: ' + id);
      round4Expected[id] = tag;
    }
  }
  tagRound4('x-not-safe', [
    '1 if-source','1b andor-source','1c while-source','1d top-source ctl',
    '1e if-assign ctl','1f fn-source in branch','1g brace-source in branch',
    '2 dyn-cmd read in branch','2b dyn-cmd top-level','2c unknown dyn top-level',
    '2d dyn-cmd andor','2e builtin dyn in branch',
    '3 arith','3b let','3c arith in if clause','3e arith-for',
    '3h arith expansion assign','3i param default assign','3j param default assign over binding',
    '4 time read','4b bang read','4d time source','4e bang fn','4f lastpipe',
    '6d read -a',
    'nameref','read -aX','printf -vX','empty default',
    'command read in branch','builtin read in branch','command read top',
    'let in branch','arith in branch','fn defined+called in branch',
    'wait -p','case pattern arith','time only in branch','top dyn fn call',
    'arith-for in branch','select top','select in branch','coproc name',
    'redirect arith write','for wordlist arith','until loop source',
  ]);
  tagRound4('x-safe', [
    '4g pipeline multi ctl','6 read -p','6b read -r','6c read -d','6e read -pX fused',
    'bg assign','bg source','subshell assign ctl',
  ]);
  tagRound4('x-o', ['4c time assign']);
  tagRound4('edge-a', ['3d arith cmdsub','3f arith-for cmdsub','3g test cmd cmdsub']);
  tagRound4('poison-f', [
    '5 subshell fn','5b pipeline fn','5d cmdsub fn',
    'fn redefined in branch','fn redefined in branch node',
    'eval defines f','bang subshell fn','bg fn redefine','unset -f',
    'fn redefined in taken branch','fn defined only in branch then called',
  ]);
  tagRound4('poison-g', ['5c subshell fn define new']);
  tagRound4('external-wrapper-builtin', [
    '7 env eval','7b env source','7c nohup eval','7d exec eval',
    '7f env command node','7g timeout eval','7h env exec',
  ]);
  tagRound4('edge-x', ['7e command eval','eval f','bash -c exported f','time fn call','bang fn call']);
  tagRound4('source-unknown-f', ['source defines f']);
  tagRound4('unsupported', ['posix special prefix','trap code','mapfile -C']);
  tagRound4('cwd-unresolved', ['cd relative']);
  tagRound4('command-resolution-unresolved', ['alias','hash -p']);
  tagRound4('terminating-arm', ['exit-terminated arm with source (corpus shape)']);
  tagRound4('nonterminating-arm', ['non-terminated arm with source']);

  function round4CaseOk(kind, scan) {
    const prod = scan.targets.filter((x) => x.reachability !== 'dormant');
    const xWord = prod.find((x) => x.expression === '"$X"');
    switch (kind) {
      case 'x-not-safe':
        return !xWord || xWord.status !== 'resolved' || xWord.target !== './safe.cjs';
      case 'x-safe':
        return !!xWord && xWord.status === 'resolved' && xWord.target === './safe.cjs';
      case 'x-o':
        return !!xWord && xWord.status === 'resolved' && xWord.target === './o.cjs';
      case 'edge-a':
        return prod.some((x) => x.status === 'resolved' && x.target === './a.cjs');
      case 'poison-f':
        return prod.some((x) => x.status === 'unresolved' &&
          x.kind === 'function-name' && x.expression === 'f' && x.poisoned === true);
      case 'poison-g':
        return prod.some((x) => x.status === 'unresolved' &&
          x.kind === 'function-name' && x.expression === 'g' && x.poisoned === true);
      case 'external-wrapper-builtin':
        return prod.some((x) => x.status === 'unresolved' &&
          x.kind === 'external-wrapper-command' && /PATH 可执行文件未证明/.test(x.reason || ''));
      case 'edge-x':
        return prod.some((x) => x.status === 'resolved' && x.target === './x.cjs');
      case 'source-unknown-f':
        return prod.some((x) => x.status === 'unresolved' &&
          x.expression === 'f' && /function table is unknown/.test(x.reason || ''));
      case 'unsupported':
        return prod.some((x) => x.kind === 'unsupported-construct' &&
          x.status === 'unresolved' && x.code === adapter.ERROR_CODES.UNSUPPORTED);
      case 'cwd-unresolved':
        return prod.some((x) => x.status === 'unresolved' &&
          (x.expression === './x.cjs' || x.expression === 'node') &&
          /cwd|function table/.test(x.reason || ''));
      case 'command-resolution-unresolved':
        return prod.some((x) => x.status === 'unresolved' &&
          x.expression === 'node' && /command resolution/.test(x.reason || ''));
      case 'terminating-arm':
        return (scan.assumptions || []).includes('no-exit-function') &&
          prod.some((x) => x.status === 'resolved' && x.target === '/g/x.cjs');
      case 'nonterminating-arm':
        return !(scan.assumptions || []).includes('no-exit-function') &&
          !prod.some((x) => x.status === 'resolved' && x.target === '/g/x.cjs');
      default:
        return false;
    }
  }

  const round4CaseRows = [];
  for (const entry of round4Cases) {
    const expectation = round4Expected[entry.id];
    let scan = null;
    let error = null;
    try {
      scan = adapter.scanDependencyTargets(entry.src);
    } catch (caughtError) {
      error = { name: caughtError.name, code: caughtError.code, message: caughtError.message };
    }
    const ok = !!expectation && entry.expectation === expectation && !!scan && round4CaseOk(expectation, scan);
    round4CaseRows.push({
      group: entry.group,
      id: entry.id,
      expectation,
      fixtureExpectation: entry.expectation,
      ok,
      error,
      targets: scan ? scan.targets : null,
      assumptions: scan ? scan.assumptions : null,
    });
  }
  const round4MissingIds = round4Cases.filter((entry) => !round4Expected[entry.id]).map((entry) => entry.id);
  const round4ExtraIds = Object.keys(round4Expected)
    .filter((id) => !round4Cases.some((entry) => entry.id === id));
  check('R16a-fix4 all 91 defender cases have explicit expectations and pass',
    round4Cases.length === 91 && round4MissingIds.length === 0 && round4ExtraIds.length === 0 &&
      round4CaseRows.every((row) => row.ok),
    JSON.stringify({
      count: round4Cases.length,
      missing: round4MissingIds,
      extra: round4ExtraIds,
      failures: round4CaseRows.filter((row) => !row.ok),
    }));

  const readCombined = target(adapter.scanDependencyTargets(
    'X=./safe.cjs; read -ra X <<< ok; node "$X"'), (x) => x.expression === '"$X"');
  check('R16a-fix4 read getopt parses combined -ra X and invalidates array X',
    !!readCombined && readCombined.status === 'unresolved',
    JSON.stringify(readCombined));

  const processSubPoison = adapter.scanDependencyTargets(
    'f(){ node ./real.cjs; }; cat <(f(){ :; }); f');
  check('R16a-fix4 process substitution clones function table and poisons inner redefinition',
    processSubPoison.targets.some((x) => x.kind === 'function-name' &&
      x.expression === 'f' && x.status === 'unresolved' && x.poisoned === true),
    JSON.stringify(processSubPoison));

  const poisonedNestedShellCases = [
    'f(){ node ./real.cjs; }; (f(){ :; }); eval f',
    'f(){ node ./real.cjs; }; (f(){ :; }); bash -c f',
  ].map((sourceText) => ({ sourceText, scan: adapter.scanDependencyTargets(sourceText) }));
  check('R16a-fix4 eval and bash -c carry poisoned function-table state into nested scans',
    poisonedNestedShellCases.every((row) => row.scan.targets.some((x) =>
      x.kind === 'function-name' && x.expression === 'f' &&
      x.status === 'unresolved' && x.poisoned === true)),
    JSON.stringify(poisonedNestedShellCases));

  const wrapperBuiltinCases = [
    "env eval 'node ./never.cjs'",
    "nohup eval 'node ./never.cjs'",
    "timeout 5 eval 'node ./never.cjs'",
    "nice eval 'node ./never.cjs'",
    "stdbuf -oL eval 'node ./never.cjs'",
    "exec eval 'node ./never.cjs'",
  ].map((sourceText) => ({
    sourceText,
    scan: adapter.scanDependencyTargets(sourceText),
  }));
  check('R16a-fix4 every external wrapper refuses delegation to shell builtins without PATH proof',
    wrapperBuiltinCases.every((row) =>
      row.scan.targets.some((x) => x.kind === 'external-wrapper-command' &&
        x.status === 'unresolved' && /PATH 可执行文件未证明/.test(x.reason || ''))),
    JSON.stringify(wrapperBuiltinCases));

  const directProjectorPath = path.join(ROOT, 'scripts', 'private', 'p2-bash-ast-js', 'projector.cjs');
  const directProjectorProbe = cp.spawnSync(process.execPath, ['-e',
    'const p=require(process.argv[1]);try{p.parseShellV2("echo ok");process.exit(9)}catch(e){process.stdout.write(String(e.message||e));}',
    directProjectorPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  check('R16a-fix4 projector refuses parse before adapter verification token',
    directProjectorProbe.status === 0 &&
      /before adapter pinned-source verification/.test(directProjectorProbe.stdout || ''),
    JSON.stringify({ status: directProjectorProbe.status, stdout: directProjectorProbe.stdout,
      stderr: directProjectorProbe.stderr }));

  const forgedTokenProbe = cp.spawnSync(process.execPath, ['-e',
    'const p=require(process.argv[1]);const fake={protocolVersion:2,protocolSchema:"fake",hashMode:"fake",lock:{}};try{p.initializeVerification(fake);process.exit(9)}catch(e){process.stdout.write(String(e.message||e));}',
    directProjectorPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  check('R16a-fix4 projector rejects a forged same-shape verification token',
    forgedTokenProbe.status === 0 &&
      /requires the adapter pinned-source verification token/.test(forgedTokenProbe.stdout || ''),
    JSON.stringify({ status: forgedTokenProbe.status, stdout: forgedTokenProbe.stdout,
      stderr: forgedTokenProbe.stderr }));

  const directRulesPath = path.join(ROOT, 'scripts', 'private', 'p2-bash-ast-js', 'target-rules.cjs');
  const forgedRulesProbe = cp.spawnSync(process.execPath, ['-e',
    'const r=require(process.argv[1]);const fakeToken={};const fakeApi={parseMaterialized(){},projectWord(){},hasUnquotedRuntimePattern(){return false},acceptsVerificationToken(){return true}};try{r.bindProjector(fakeApi,fakeToken);process.exit(9)}catch(e){process.stdout.write(String(e.message||e));}',
    directRulesPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  check('R16a-fix4 target-rules rejects a forged projector/token pair',
    forgedRulesProbe.status === 0 &&
      /requires the adapter-verified projector token/.test(forgedRulesProbe.stdout || ''),
    JSON.stringify({ status: forgedRulesProbe.status, stdout: forgedRulesProbe.stdout,
      stderr: forgedRulesProbe.stderr }));
  check('R16a-fix4 adapter verification token initializes normal parse path',
    adapter.parseShellV2('echo ok').ok === true,
    JSON.stringify(adapter.describeProtocol()));

  for (const terminatorName of ['exit', 'exec']) {
    const sourceText =
      terminatorName + '(){ :; }; G=/g; if true; then source ./lib.sh; ' +
      terminatorName + ' 0; fi; exec node "$G/x.cjs"';
    const scan = adapter.scanDependencyTargets(sourceText);
    check('R16a-fix4 function named ' + terminatorName + ' disables terminating-arm assumption',
      !(scan.assumptions || []).includes('no-exit-function') &&
        !scan.targets.some((x) => x.reachability === 'production' &&
          x.status === 'resolved' && x.target === '/g/x.cjs'),
      JSON.stringify(scan));
  }

  const terminatingSynthetic =
    'G=/g; if [ "$1" = --self-test ]; then . ./lib.sh; exit $?; fi; exec node "$G/x.cjs"';
  const terminatingNormal = adapter.scanDependencyTargets(terminatingSynthetic);
  const terminatingMutant = adapter.scanDependencyTargets(terminatingSynthetic,
    { disableTerminatingArms: true });
  check('R16a-fix5 terminating-arm clause has a red mutation control',
    (terminatingNormal.assumptions || []).includes('no-exit-function') &&
      terminatingNormal.targets.some((x) => x.status === 'resolved' && x.target === '/g/x.cjs') &&
      !terminatingMutant.targets.some((x) => x.reachability === 'production' &&
        x.status === 'resolved' && x.target === '/g/x.cjs') &&
      terminatingMutant.targets.some((x) => x.reachability === 'production' && x.status === 'unresolved'),
    JSON.stringify({ normal: terminatingNormal, mutant: terminatingMutant }));

  function targetEndsWith(targetValue, expectedSuffix) {
    if (typeof targetValue !== 'string') return false;
    const normalized = targetValue.replace(/\\/g, '/');
    return normalized === expectedSuffix || normalized.endsWith('/' + expectedSuffix);
  }
  const productionTargets = [
    ['guards/bash-pipe-exitcode-watch.sh', '"$G/bash-pipe-exitcode-watch.cjs"',
      'guards/bash-pipe-exitcode-watch.cjs', false],
    ['guards/pmm-bash-impression.sh', '"$G/pmm-bash-impression.cjs"',
      'guards/pmm-bash-impression.cjs', false],
    ['guards/pmm-home.sh', '"$LEDGER_ARG"', 'guards/pmm-recall-ledger.cjs', false],
    ['guards/pmm-shell-memory-watch.sh', '"$G/pmm-home.sh"', 'guards/pmm-home.sh', true],
    ['guards/pmm-trigger-recall.sh', '"$G/pmm-trigger-recall.cjs"',
      'guards/pmm-trigger-recall.cjs', true],
    ['guards/pmm-trigger-write-gate.sh', '"$G/pmm-trigger-write-gate.cjs"',
      'guards/pmm-trigger-write-gate.cjs', true],
  ].map(([rel, expression, expectedTarget, mutationMustBreak]) => {
    const corpusRow = pinnedByRel.get(rel);
    if (!corpusRow) throw new Error('missing pinned corpus file for six-chain test: ' + rel);
    const normalOptions = corpusScanOptions(corpusRow);
    const normal = adapter.scanDependencyTargets(Buffer.from(corpusRow.source, 'utf8'), normalOptions);
    const mutant = adapter.scanDependencyTargets(Buffer.from(corpusRow.source, 'utf8'),
      { ...normalOptions, disableTerminatingArms: true });
    const active = (x) => x.reachability === 'production' || x.reachability === 'conditional';
    const normalTarget = normal.targets.find((x) => active(x) && x.expression === expression);
    const mutantTarget = mutant.targets.find((x) => active(x) && x.expression === expression);
    const mutantUnresolved = mutant.targets.filter((x) => active(x) && x.status === 'unresolved');
    const mutantBreaks = !mutantTarget || mutantTarget.status !== 'resolved' ||
      !targetEndsWith(mutantTarget.target, expectedTarget);
    return {
      rel, expression, expectedTarget, mutationMustBreak,
      corpusBytes: corpusRow.bytesActual, corpusSha256: corpusRow.sha256Actual,
      normalTarget, mutantTarget, mutantUnresolved, assumptions: normal.assumptions,
      ok: !!normalTarget && normalTarget.status === 'resolved' &&
        targetEndsWith(normalTarget.target, expectedTarget) &&
        active(normalTarget),
    };
  });
  check('R16a-fix6 pinned-corpus six reviewed chains stay production/conditional resolved 6/6',
    productionTargets.every((row) => row.ok),
    JSON.stringify(productionTargets));

  function r5Resolved(scan, expression, expectedTarget) {
    const hit = scan.targets.find((x) => x.reachability === 'production' && x.expression === expression);
    return !!hit && hit.status === 'resolved' && hit.target === expectedTarget;
  }
  function r5Unresolved(scan, predicate) {
    return scan.targets.some((x) =>
      (x.reachability === 'production' || x.reachability === 'conditional') &&
      x.status === 'unresolved' && predicate(x));
  }
  function r5Unsupported(scan, construct) {
    return r5Unresolved(scan, (x) => x.kind === 'unsupported-construct' &&
      (!construct || x.construct === construct || x.command === construct));
  }

  const r5NestedContinue = adapter.scanDependencyTargets(
    'G=/g; if true; then source ./defs.sh; while true; do continue; done; exit 0; fi; node "$G/x.cjs"');
  check('R16a-fix5 arm-local continue inside one loop preserves terminating-arm proof (k=1,n=1)',
    (r5NestedContinue.assumptions || []).includes('no-exit-function') &&
      r5Resolved(r5NestedContinue, '"$G/x.cjs"', '/g/x.cjs'),
    JSON.stringify(r5NestedContinue));

  const r5TopContinue = adapter.scanDependencyTargets(
    'G=/g; if true; then source ./defs.sh; continue; exit 0; fi; node "$G/x.cjs"');
  check('R16a-fix5 top-level continue escapes the arm and disables its terminating-arm proof (k=0,n=1)',
    !(r5TopContinue.assumptions || []).includes('no-exit-function') &&
      !r5Resolved(r5TopContinue, '"$G/x.cjs"', '/g/x.cjs'),
    JSON.stringify(r5TopContinue));

  const r5ContinueTwo = adapter.scanDependencyTargets(
    'G=/g; if true; then source ./defs.sh; while true; do continue 2; done; exit 0; fi; node "$G/x.cjs"');
  check('R16a-fix5 continue 2 escapes a one-loop arm and disables terminating-arm proof (k=1,n=2)',
    !(r5ContinueTwo.assumptions || []).includes('no-exit-function') &&
      !r5Resolved(r5ContinueTwo, '"$G/x.cjs"', '/g/x.cjs'),
    JSON.stringify(r5ContinueTwo));

  const r5ContinueDynamic = adapter.scanDependencyTargets(
    'G=/g; if true; then source ./defs.sh; while true; do continue "$x"; done; exit 0; fi; node "$G/x.cjs"');
  check('R16a-fix5 dynamic continue level is infinity and disables terminating-arm proof',
    !(r5ContinueDynamic.assumptions || []).includes('no-exit-function') &&
      !r5Resolved(r5ContinueDynamic, '"$G/x.cjs"', '/g/x.cjs'),
    JSON.stringify(r5ContinueDynamic));

  const r5FunctionBreak = adapter.scanDependencyTargets(
    'f(){ break; }; G=/g; if true; then source ./defs.sh; exit 0; fi; node "$G/x.cjs"');
  check('R16a-fix5 function-body top-level break disables all file control-flow shortcuts',
    !(r5FunctionBreak.assumptions || []).includes('no-exit-function') &&
      !r5Resolved(r5FunctionBreak, '"$G/x.cjs"', '/g/x.cjs'),
    JSON.stringify(r5FunctionBreak));

  for (const [label, tail] of [
    ['background exit', 'exit &'],
    ['exec without command operand', 'exec'],
    ['exec with redirects but no command operand', 'exec >/dev/null'],
  ]) {
    const scan = adapter.scanDependencyTargets(
      'G=/g; if true; then source ./defs.sh; ' + tail + '; fi; node "$G/x.cjs"');
    check('R16a-fix5 ' + label + ' is not a terminating arm',
      !(scan.assumptions || []).includes('no-exit-function') &&
        !r5Resolved(scan, '"$G/x.cjs"', '/g/x.cjs'),
      JSON.stringify(scan));
  }

  for (const terminator of ['exit 0 >/dev/null', 'exec node ./x.cjs >/dev/null']) {
    const scan = adapter.scanDependencyTargets(
      'G=/g; if true; then source ./defs.sh; ' + terminator + '; fi; node "$G/x.cjs"');
    check('R16a-fix5 redirected terminal command does not prove arm termination: ' + terminator,
      !(scan.assumptions || []).includes('no-exit-function') &&
        !r5Resolved(scan, '"$G/x.cjs"', '/g/x.cjs'),
      JSON.stringify(scan));
  }

  const r5ShortcutDisablers = [
    ['enable', 'enable -n true'],
    ['shopt extdebug', 'shopt -s extdebug'],
    ['shopt execfail', 'shopt -s execfail'],
    ['set -T', 'set -T'],
    ['set -o functrace', 'set -o functrace'],
    ['function exit', 'exit(){ :; }'],
    ['function exec', 'exec(){ :; }'],
    ['function return', 'return(){ :; }'],
  ].map(([label, extra]) => {
    const src = extra.includes('(){') ?
      extra + '; G=/g; if true; then source ./defs.sh; exit 0; fi; node "$G/x.cjs"' :
      'G=/g; if true; then source ./defs.sh; exit 0; fi; ' + extra + '; node "$G/x.cjs"';
    const scan = adapter.scanDependencyTargets(src);
    return { label, ok: !(scan.assumptions || []).includes('no-exit-function'), scan };
  });
  check('R16a-fix5 enable/extdebug/execfail/functrace and exit-exec-return functions disable shortcuts file-wide',
    r5ShortcutDisablers.every((row) => row.ok), JSON.stringify(r5ShortcutDisablers));

  const r5SourceBuiltin = adapter.scanDependencyTargets('source ./defs.sh; printf hi');
  check('R16a-fix5 source makes later builtin command names unresolved too',
    r5Unresolved(r5SourceBuiltin, (x) => x.kind === 'command-name' && x.expression === 'printf' &&
      /function table is unknown/.test(x.reason || '')),
    JSON.stringify(r5SourceBuiltin));

  const r5Getopts = adapter.scanDependencyTargets(
    'OPTIND=1; OPTARG=./arg.cjs; X=./safe.cjs; getopts a X -a; node "$OPTIND"; node "$OPTARG"; node "$X"');
  check('R16a-fix5 getopts invalidates OPTIND OPTARG and its name operand',
    ['"$OPTIND"', '"$OPTARG"', '"$X"'].every((expr) =>
      r5Unresolved(r5Getopts, (x) => x.kind === 'node-script' && x.expression === expr)),
    JSON.stringify(r5Getopts));

  const r5ReadReply = adapter.scanDependencyTargets('REPLY=./safe.cjs; read; node "$REPLY"');
  const r5Shift = adapter.scanDependencyTargets('shift; node "$1"', { bindings: { '1': './safe.cjs' } });
  check('R16a-fix5 read without names invalidates REPLY and shift invalidates positional parameters',
    r5Unresolved(r5ReadReply, (x) => x.kind === 'node-script' && x.expression === '"$REPLY"') &&
      r5Unresolved(r5Shift, (x) => x.kind === 'node-script' && x.expression === '"$1"'),
    JSON.stringify({ read: r5ReadReply, shift: r5Shift }));

  const r5TrapPlain = adapter.scanDependencyTargets("X=./safe.cjs; trap 'X=./o.cjs' DEBUG; node \"$X\"");
  const r5TrapDash = adapter.scanDependencyTargets("trap -- 'node ./x.cjs' EXIT");
  check('R16a-fix5 every trap form including trap -- is UNSUPPORTED and poisons state',
    r5Unsupported(r5TrapPlain, 'trap') && r5Unsupported(r5TrapDash, 'trap') &&
      !r5Resolved(r5TrapPlain, '"$X"', './safe.cjs'),
    JSON.stringify({ plain: r5TrapPlain, dash: r5TrapDash }));

  const r5Mapfile = adapter.scanDependencyTargets("mapfile -C'node ./cb.cjs' -c 1 arr <<< line");
  const r5Readarray = adapter.scanDependencyTargets("readarray -C'node ./cb.cjs' -c 1 arr <<< line");
  check('R16a-fix5 mapfile/readarray including fused -C callback syntax are UNSUPPORTED',
    r5Unsupported(r5Mapfile, 'mapfile') && r5Unsupported(r5Readarray, 'readarray'),
    JSON.stringify({ mapfile: r5Mapfile, readarray: r5Readarray }));

  const r5Declarations = [
    ['declare', 'declare -n R=X'],
    ['local', 'f(){ local -a A; }; f'],
    ['typeset', 'typeset -A A'],
    ['declare-other-option', 'declare -x X'],
  ].map(([label, src]) => ({ label, scan: adapter.scanDependencyTargets(src) }));
  check('R16a-fix5 declare/local/typeset with -n/-a/-A or other options are UNSUPPORTED',
    r5Declarations.every((row) => r5Unsupported(row.scan,
      row.label === 'declare-other-option' ? 'declare' : row.label)),
    JSON.stringify(r5Declarations));

  const r5Let = adapter.scanDependencyTargets('X=./safe.cjs; let X=1; node "$X"');
  check('R16a-fix5 let is UNSUPPORTED and poisons later bindings',
    r5Unsupported(r5Let, 'let') && !r5Resolved(r5Let, '"$X"', './safe.cjs'),
    JSON.stringify(r5Let));

  const r5ArithmeticCommand = adapter.scanDependencyTargets('X=./safe.cjs; ((X=1)); node "$X"');
  check('R16a-fix5 arithmetic command is UNSUPPORTED and poisons later bindings',
    r5Unsupported(r5ArithmeticCommand, 'ArithmeticCommand') &&
      !r5Resolved(r5ArithmeticCommand, '"$X"', './safe.cjs'),
    JSON.stringify(r5ArithmeticCommand));

  const r5ArithmeticWord = adapter.scanDependencyTargets('X=./safe.cjs; : $((X=1)); node "$X"');
  check('R16a-fix5 any word containing arithmetic expansion is UNSUPPORTED',
    r5Unsupported(r5ArithmeticWord, 'shell-word') &&
      !r5Resolved(r5ArithmeticWord, '"$X"', './safe.cjs'),
    JSON.stringify(r5ArithmeticWord));

  const r5ParameterAssign = [
    adapter.scanDependencyTargets('X=./safe.cjs; : ${X:=./o.cjs}; node "$X"'),
    adapter.scanDependencyTargets('X=./safe.cjs; : ${X=./o.cjs}; node "$X"'),
  ];
  check('R16a-fix5 parameter assignment expansions ${X:=...} and ${X=...} are UNSUPPORTED',
    r5ParameterAssign.every((scan) => r5Unsupported(scan, 'shell-word') &&
      !r5Resolved(scan, '"$X"', './safe.cjs')),
    JSON.stringify(r5ParameterAssign));

  const r5TestAssign = adapter.scanDependencyTargets('X=./safe.cjs; [[ 0 -eq X=1 ]]; node "$X"');
  check('R16a-fix5 assignment inside [[ ... ]] is UNSUPPORTED',
    r5Unsupported(r5TestAssign, 'TestCommand') &&
      !r5Resolved(r5TestAssign, '"$X"', './safe.cjs'),
    JSON.stringify(r5TestAssign));

  const r5ArrayAssign = adapter.scanDependencyTargets('X=./safe.cjs; : "${A[X=1]}"; node "$X"');
  check('R16a-fix5 assignment inside an array subscript is UNSUPPORTED',
    r5Unsupported(r5ArrayAssign, 'shell-word') &&
      !r5Resolved(r5ArrayAssign, '"$X"', './safe.cjs'),
    JSON.stringify(r5ArrayAssign));

  const r5FdAlloc = adapter.scanDependencyTargets('X=./safe.cjs; : {X}>/dev/null; node "$X"');
  check('R16a-fix5 file-descriptor allocation {X}> is UNSUPPORTED',
    r5Unsupported(r5FdAlloc, 'shell-word') &&
      !r5Resolved(r5FdAlloc, '"$X"', './safe.cjs'),
    JSON.stringify(r5FdAlloc));

  const r5CompoundRedirect = adapter.scanDependencyTargets(
    'X=./safe.cjs; if true; then :; fi > /dev/null$((X=1)); node "$X"');
  check('R16a-fix5 compound-command redirect words apply the same UNSUPPORTED fail-closed rule',
    r5Unsupported(r5CompoundRedirect, 'redirect') &&
      !r5Resolved(r5CompoundRedirect, '"$X"', './safe.cjs'),
    JSON.stringify(r5CompoundRedirect));

  const r5BackgroundAssignment = adapter.scanDependencyTargets(
    'X=./safe.cjs; X=./o.cjs & wait; node "$X"');
  check('R16a-fix5 background plain assignments stay isolated from the parent shell',
    r5Resolved(r5BackgroundAssignment, '"$X"', './safe.cjs'),
    JSON.stringify(r5BackgroundAssignment));

  const r5ForVariable = adapter.scanDependencyTargets(
    'X=./safe.cjs; for X in ./o.cjs; do :; done; node "$X"');
  check('R16a-fix5 for-in loop variable is treated as written',
    r5Unresolved(r5ForVariable, (x) => x.kind === 'node-script' && x.expression === '"$X"'),
    JSON.stringify(r5ForVariable));

  const r5LocalScope = adapter.scanDependencyTargets(
    'X=./safe.cjs; f(){ local Y=1; }; f; node "$X"');
  check('R16a-fix5 function calls containing local clear caller binding proof on return',
    r5Unresolved(r5LocalScope, (x) => x.kind === 'node-script' && x.expression === '"$X"'),
    JSON.stringify(r5LocalScope));

  const r5CwdCases = [
    ['source', 'cd /elsewhere; source ./x.sh', 'shell-source'],
    ['bash', 'cd /elsewhere; bash ./x.sh', 'shell-script'],
    ['node', 'cd /elsewhere; node ./x.cjs', 'node-script'],
  ].map(([label, src, kind]) => ({ label, kind, scan: adapter.scanDependencyTargets(src) }));
  check('R16a-fix5 cd makes later relative source/bash/node targets unresolved',
    r5CwdCases.every((row) => r5Unresolved(row.scan,
      (x) => x.kind === row.kind && /cwd|relative/.test(x.reason || ''))),
    JSON.stringify(r5CwdCases));

  const r5BashUnexported = adapter.scanDependencyTargets('f(){ node ./x.cjs; }; bash -c f');
  const r5BashExported = adapter.scanDependencyTargets('f(){ node ./x.cjs; }; export -f f; bash -c f');
  check('R16a-fix5 bash -c sees only functions exported with export -f',
    !r5BashUnexported.targets.some((x) => x.origin === 'bash-c' &&
      x.status === 'resolved' && x.target === './x.cjs') &&
      r5BashExported.targets.some((x) => x.origin === 'bash-c' &&
        x.status === 'resolved' && x.reachability === 'conditional' && x.target === './x.cjs'),
    JSON.stringify({ unexported: r5BashUnexported, exported: r5BashExported }));

  const r5BashEnv = [
    adapter.scanDependencyTargets('export BASH_ENV=./env.sh; bash -c "node ./x.cjs"'),
    adapter.scanDependencyTargets('BASH_ENV=./env.sh bash -c "node ./x.cjs"'),
    adapter.scanDependencyTargets('env BASH_ENV=./env.sh bash -c "node ./x.cjs"'),
  ];
  check('R16a-fix5 BASH_ENV export or command prefix makes bash -c unresolved',
    r5BashEnv.every((scan) => r5Unresolved(scan,
      (x) => x.kind === 'shell-inline-code' && /BASH_ENV/.test(x.reason || ''))),
    JSON.stringify(r5BashEnv));

  const r5Reachability = [
    ['exit', adapter.scanDependencyTargets('exit 0; node ./never-exit.cjs'), './never-exit.cjs'],
    ['exec', adapter.scanDependencyTargets('exec node ./real.cjs; node ./never-exec.cjs'), './never-exec.cjs'],
    ['return', adapter.scanDependencyTargets('f(){ return; node ./never-return.cjs; }; f'), './never-return.cjs'],
  ];
  check('R16a-fix5 definite exit/exec and function return make later same-scope edges dormant/resolved',
    r5Reachability.every(([, scan, targetValue]) =>
      scan.targets.some((x) => x.target === targetValue && x.status === 'resolved' &&
        x.reachability === 'dormant' && x.dormantRule === 'rule1-definite-terminator')),
    JSON.stringify(r5Reachability));

  const r5ShellState = [
    ['set', adapter.scanDependencyTargets('X=./safe.cjs; set -n; node "$X"')],
    ['set', adapter.scanDependencyTargets('X=./safe.cjs; set -o posix; node "$X"')],
    ['readonly', adapter.scanDependencyTargets('X=./safe.cjs; readonly X; node "$X"')],
  ];
  check('R16a-fix5 set -n set -o posix and readonly are UNSUPPORTED and poison state',
    r5ShellState.every(([construct, scan]) => r5Unsupported(scan, construct) &&
      !r5Resolved(scan, '"$X"', './safe.cjs')),
    JSON.stringify(r5ShellState));

  const r5ExternalBuiltin = [
    adapter.scanDependencyTargets('env source ./x.sh'),
    adapter.scanDependencyTargets('exec source ./x.sh'),
  ];
  const r5Pwd = adapter.scanDependencyTargets('pwd; node ./x.cjs');
  check('R16a-fix5 external wrappers still refuse shell builtins while pwd remains supported',
    r5ExternalBuiltin.every((scan) => r5Unresolved(scan,
      (x) => x.kind === 'external-wrapper-command' && /PATH 可执行文件未证明/.test(x.reason || ''))) &&
      !r5Pwd.targets.some((x) => x.kind === 'unsupported-construct' && x.expression === 'pwd') &&
      r5Resolved(r5Pwd, './x.cjs', './x.cjs'),
    JSON.stringify({ wrappers: r5ExternalBuiltin, pwd: r5Pwd }));

  function activeReach(record) {
    return record && (record.reachability === 'production' || record.reachability === 'conditional');
  }
  function findExpr(scan, expression) {
    return scan.targets.find((x) => x.expression === expression) || null;
  }

  const r6Production = findExpr(adapter.scanDependencyTargets('node ./prod.cjs'), './prod.cjs');
  const r6ConditionalResolved = findExpr(adapter.scanDependencyTargets(
    'if test -n "$X"; then node ./conditional.cjs; fi'), './conditional.cjs');
  const r6ConditionalUnresolved = findExpr(adapter.scanDependencyTargets(
    'if test -n "$X"; then node "$DYNAMIC"; fi'), '"$DYNAMIC"');
  const r6Dormant = findExpr(adapter.scanDependencyTargets(
    'exit 0; node ./dormant.cjs'), './dormant.cjs');
  check('R16a-fix6 reachability and status are independent; candidate status is abolished',
    !!r6Production && r6Production.reachability === 'production' && r6Production.status === 'resolved' &&
      !!r6ConditionalResolved && r6ConditionalResolved.reachability === 'conditional' &&
        r6ConditionalResolved.status === 'resolved' &&
      !!r6ConditionalUnresolved && r6ConditionalUnresolved.reachability === 'conditional' &&
        r6ConditionalUnresolved.status === 'unresolved' &&
      !!r6Dormant && r6Dormant.reachability === 'dormant' && r6Dormant.status === 'resolved' &&
      [r6Production, r6ConditionalResolved, r6ConditionalUnresolved, r6Dormant]
        .every((x) => x.status === 'resolved' || x.status === 'unresolved'),
    JSON.stringify({ r6Production, r6ConditionalResolved, r6ConditionalUnresolved, r6Dormant }));

  const r6Rule1Positive = findExpr(adapter.scanDependencyTargets(
    'exit 0; node ./after-exit.cjs'), './after-exit.cjs');
  const r6Rule1Negative = findExpr(adapter.scanDependencyTargets(
    'exit 0 >/definitely/missing/dir/x; node ./still-live.cjs'), './still-live.cjs');
  check('R16a-fix6 dormant rule1 requires a definite top-level terminator',
    !!r6Rule1Positive && r6Rule1Positive.reachability === 'dormant' &&
      r6Rule1Positive.dormantRule === 'rule1-definite-terminator' &&
      !!r6Rule1Negative && r6Rule1Negative.reachability === 'production',
    JSON.stringify({ positive: r6Rule1Positive, negative: r6Rule1Negative }));

  const r6GuardSource = 'if [ "$1" = "--self-test" ]; then node ./guard.cjs; fi';
  const r6Rule2Positive = findExpr(adapter.scanDependencyTargets(r6GuardSource,
    { productionArgv1Values: ['normal'] }), './guard.cjs');
  const r6Rule2Unknown = findExpr(adapter.scanDependencyTargets(r6GuardSource), './guard.cjs');
  const r6Rule2NonliteralInvocation = findExpr(adapter.scanDependencyTargets(r6GuardSource,
    { productionArgv1Values: ['normal'], productionArgv1Unknown: true }), './guard.cjs');
  const r6Rule2Unquoted = findExpr(adapter.scanDependencyTargets(
    'if [ $1 = "--self-test" ]; then node ./guard.cjs; fi',
    { productionArgv1Values: ['normal'] }), './guard.cjs');
  const r6Rule2Shift = findExpr(adapter.scanDependencyTargets(
    'shift; ' + r6GuardSource, { productionArgv1Values: ['normal'] }), './guard.cjs');
  const r6Rule2Set = findExpr(adapter.scanDependencyTargets(
    'set -- normal; ' + r6GuardSource, { productionArgv1Values: ['normal'] }), './guard.cjs');
  const r6Rule2Source = findExpr(adapter.scanDependencyTargets(
    '. ./defs.sh; ' + r6GuardSource, { productionArgv1Values: ['normal'] }), './guard.cjs');
  const r6Rule2FunctionArg = findExpr(adapter.scanDependencyTargets(
    'f(){ if [ "$1" = "--self-test" ]; then node ./guard.cjs; fi; }; f normal',
    { productionArgv1Values: ['normal'] }), './guard.cjs');
  const r6Rule2CompoundFalse = findExpr(adapter.scanDependencyTargets(
    'if [ "$1" = "--self-test" ] && test -n "$X"; then node ./guard.cjs; fi',
    { productionArgv1Values: ['normal'] }), './guard.cjs');
  const r6Rule2CompoundUnknown = findExpr(adapter.scanDependencyTargets(
    'if [ "$1" = "--self-test" ] || test -n "$X"; then node ./guard.cjs; fi',
    { productionArgv1Values: ['normal'] }), './guard.cjs');
  const r6Rule2CasePositive = findExpr(adapter.scanDependencyTargets(
    'case "$1" in --self-test) node ./case-guard.cjs;; esac',
    { productionArgv1Values: ['normal'] }), './case-guard.cjs');
  const r6Rule2CaseGlob = findExpr(adapter.scanDependencyTargets(
    'case "$1" in --self*) node ./case-guard.cjs;; esac',
    { productionArgv1Values: ['normal'] }), './case-guard.cjs');
  check('R16a-fix6 dormant rule2 needs a quoted literal $1 guard false for every production invocation',
    !!r6Rule2Positive && r6Rule2Positive.reachability === 'dormant' &&
      r6Rule2Positive.dormantRule === 'rule2-argv1-guard-false' &&
      [r6Rule2Unknown, r6Rule2NonliteralInvocation, r6Rule2Unquoted, r6Rule2Shift,
        r6Rule2Set, r6Rule2Source, r6Rule2FunctionArg, r6Rule2CompoundUnknown, r6Rule2CaseGlob]
        .every((x) => !!x && x.reachability === 'conditional') &&
      !!r6Rule2CompoundFalse && r6Rule2CompoundFalse.reachability === 'dormant' &&
        r6Rule2CompoundFalse.dormantRule === 'rule2-argv1-guard-false' &&
      !!r6Rule2CasePositive && r6Rule2CasePositive.reachability === 'dormant' &&
        r6Rule2CasePositive.dormantRule === 'rule2-argv1-guard-false',
    JSON.stringify({
      positive: r6Rule2Positive, unknown: r6Rule2Unknown,
      nonliteralInvocation: r6Rule2NonliteralInvocation, unquoted: r6Rule2Unquoted,
      shift: r6Rule2Shift, setDashDash: r6Rule2Set, sourced: r6Rule2Source,
      functionArg: r6Rule2FunctionArg, compoundFalse: r6Rule2CompoundFalse,
      compoundUnknown: r6Rule2CompoundUnknown, casePositive: r6Rule2CasePositive,
      caseGlob: r6Rule2CaseGlob,
    }));

  const r6Rule3Positive = findExpr(adapter.scanDependencyTargets(
    'never_called(){ node ./never-called.cjs; }; echo ok',
    { proveWholeClosureFunctions: true, wholeClosureNeverCalledFunctions: ['never_called'] }),
    './never-called.cjs');
  const r6Rule3NoProof = findExpr(adapter.scanDependencyTargets(
    'never_called(){ node ./never-called.cjs; }; echo ok'), './never-called.cjs');
  const r6Rule3LiteralCall = findExpr(adapter.scanDependencyTargets(
    'never_called(){ node ./never-called.cjs; }; never_called',
    { proveWholeClosureFunctions: true, wholeClosureNeverCalledFunctions: ['never_called'] }),
    './never-called.cjs');
  const r6Rule3DynamicCall = findExpr(adapter.scanDependencyTargets(
    'never_called(){ node ./never-called.cjs; }; "$CALL"',
    { proveWholeClosureFunctions: true, wholeClosureNeverCalledFunctions: ['never_called'] }),
    './never-called.cjs');
  check('R16a-fix6 dormant rule3 requires whole-closure never-called proof and rejects local literal/dynamic call conflicts',
    !!r6Rule3Positive && r6Rule3Positive.reachability === 'dormant' &&
      r6Rule3Positive.dormantRule === 'rule3-never-called-function' &&
      [r6Rule3NoProof, r6Rule3LiteralCall, r6Rule3DynamicCall]
        .every((x) => !!x && x.reachability === 'conditional'),
    JSON.stringify({
      positive: r6Rule3Positive, noProof: r6Rule3NoProof,
      literalCall: r6Rule3LiteralCall, dynamicCall: r6Rule3DynamicCall,
    }));

  const r6M1 = adapter.scanDependencyTargets('. ./a.sh; f(){ X=1; }; . ./b.sh; f');
  const r6M1Mapfile = adapter.scanDependencyTargets('. ./a.sh; mapfile arr < f');
  check('R16a-fix6 M1 function-table-unknown does not suppress later source, function unresolved, or UNSUPPORTED analysis',
    r6M1.targets.some((x) => x.kind === 'shell-source' && x.expression === './b.sh' &&
      x.status === 'resolved' && x.reachability === 'production') &&
      r6M1.targets.some((x) => x.kind === 'command-name' && x.expression === 'f' &&
        x.status === 'unresolved' && /function table is unknown/.test(x.reason || '')) &&
      r6M1Mapfile.targets.some((x) => x.kind === 'unsupported-construct' &&
        x.construct === 'mapfile' && activeReach(x)),
    JSON.stringify({ sourceThenFunction: r6M1, mapfile: r6M1Mapfile }));

  const r6LinkPath = 'C:/links/axmem/pmm-receipt.sh';
  const r6M4Direct = adapter.scanDependencyTargets(
    'node "$(dirname "${BASH_SOURCE[0]}")/dep.cjs"; bash "$0"',
    { productionInvocationPaths: [r6LinkPath], productionArgv1Values: [''] });
  const r6M4Dep = findExpr(r6M4Direct, '"$(dirname "${BASH_SOURCE[0]}")/dep.cjs"');
  const r6M4Self = findExpr(r6M4Direct, '"$0"');
  const r6M4Override = findExpr(adapter.scanDependencyTargets(
    'dirname(){ :; }; node "$(dirname "${BASH_SOURCE[0]}")/dep.cjs"',
    { productionInvocationPaths: [r6LinkPath], productionArgv1Values: [''] }),
    '"$(dirname "${BASH_SOURCE[0]}")/dep.cjs"');
  const r6M4Sourced = adapter.scanDependencyTargets(
    'node "$(dirname "${BASH_SOURCE[0]}")/dep.cjs"; bash "$0"',
    {
      productionInvocationPaths: ['C:/callers/caller.sh'],
      sourcedOnProductionPath: true,
      productionSourcePaths: ['C:/sourced/lib.sh'],
      productionArgv1Values: [''],
    });
  const r6M4SourcedBashSource = findExpr(r6M4Sourced,
    '"$(dirname "${BASH_SOURCE[0]}")/dep.cjs"');
  const r6M4SourcedZero = findExpr(r6M4Sourced, '"$0"');
  check('R16a-fix6 M4 $0/BASH_SOURCE dirname proof uses actual invocation spelling, preserves symlink spelling, and rejects unsafe overrides/source-direct proof',
    !!r6M4Dep && r6M4Dep.status === 'resolved' &&
      r6M4Dep.target === 'C:/links/axmem/dep.cjs' &&
      !!r6M4Self && r6M4Self.status === 'resolved' && r6M4Self.target === r6LinkPath &&
      !!r6M4Override && r6M4Override.status === 'unresolved' &&
      !!r6M4SourcedBashSource && r6M4SourcedBashSource.status === 'resolved' &&
        r6M4SourcedBashSource.target === 'C:/sourced/dep.cjs' &&
      !!r6M4SourcedZero && r6M4SourcedZero.status === 'unresolved',
    JSON.stringify({
      direct: r6M4Direct, override: r6M4Override, sourced: r6M4Sourced,
    }));

  const r6Receipt = pinnedWholeScans.get('memory/_local-config/pmm-receipt.sh');
  const r6ReceiptTarget = r6Receipt.targets.find((x) =>
    /pmm-receipt-fromhook\.cjs$/.test(String(x.target || '')) && activeReach(x));
  const r6Elw = pinnedWholeScans.get('pmm-entry-length-watch.sh');
  const r6ElwNamed = ['pmm-manifest.cjs', 'pmm-redundancy-lint.cjs', 'pmm-write-echo.cjs'].map((name) =>
    r6Elw.targets.find((x) => activeReach(x) &&
      String(x.target || x.expression || '').includes(name)));
  const r6Smw = pinnedWholeScans.get('guards/pmm-shell-memory-watch.sh');
  const r6SmwNamedExpressions = ['"$_ledger_arg"', '"$_jh"', '"$G/pmm-trigger-write-gate.cjs"', '"$_ch"'];
  const r6SmwNamed = r6SmwNamedExpressions.map((expression) =>
    r6Smw.targets.find((x) => activeReach(x) && x.expression === expression));
  const r6SmwMapfile = r6Smw.targets.filter((x) => activeReach(x) &&
    x.kind === 'unsupported-construct' && x.construct === 'mapfile');
  check('R16a-fix6 stop-line named production-reachable dependencies remain production/conditional',
    !!r6ReceiptTarget && r6ReceiptTarget.status === 'resolved' &&
      r6ReceiptTarget.reachability === 'conditional' &&
      r6ElwNamed.every(Boolean) && r6ElwNamed.every(activeReach) &&
      r6SmwNamed.every(Boolean) && r6SmwNamed.every(activeReach) &&
      r6SmwMapfile.length === 2 && r6SmwMapfile.every((x) => x.status === 'unresolved'),
    JSON.stringify({
      receipt: r6ReceiptTarget, entryLengthBlock: r6ElwNamed,
      shellMemoryWatch: r6SmwNamed, shellMemoryMapfile: r6SmwMapfile,
    }));

  const envelopeVersionMutant = JSON.parse(JSON.stringify(success));
  envelopeVersionMutant.protocolVersion++;
  expectCode(
    'R16a-fix envelope protocolVersion mismatch is refused',
    () => adapter.validateEnvelope(envelopeVersionMutant),
    adapter.ERROR_CODES.SCHEMA,
    'Without envelope-header validation a caller could accept a success document from a different protocol version.');

  const envelopeSchemaMutant = JSON.parse(JSON.stringify(success));
  envelopeSchemaMutant.schema = 'axmem-p2-bash-ast/not-v2';
  expectCode(
    'R16a-fix envelope schema mismatch is refused',
    () => adapter.validateEnvelope(envelopeSchemaMutant),
    adapter.ERROR_CODES.SCHEMA,
    'Without envelope-header validation a caller could accept a document under the wrong schema identifier.');

  const lockReadMutant = sandbox('lock-read-mutant');
  fs.rmSync(path.join(lockReadMutant, LOCK_REL), { force: true });
  expectCode(
    'R16a-fix LOCK_READ has a behavioural missing-lock test',
    () => loadAdapter(lockReadMutant),
    adapter.ERROR_CODES.LOCK_READ,
    'If a missing lock were ignored or defaulted, verification could be bypassed instead of failing closed.');

  const lockSchemaMutant = sandbox('lock-schema-mutant');
  fs.writeFileSync(path.join(lockSchemaMutant, LOCK_REL), '{not-json', 'utf8');
  expectCode(
    'R16a-fix LOCK_SCHEMA has a behavioural malformed-lock test',
    () => loadAdapter(lockSchemaMutant),
    adapter.ERROR_CODES.LOCK_SCHEMA,
    'If malformed lock JSON were accepted, pinned-source metadata would not be mechanically defined.');

  const savedReadFileSync = fs.readFileSync;
  let sourceReadError = null;
  try {
    fs.readFileSync = function(file, ...args) {
      const normalized = String(file).replace(/\\/g, '/');
      if (normalized.endsWith('/guards/vendor/unbash/parser.js')) {
        const error = new Error('synthetic pinned-source read failure');
        error.code = 'EACCES';
        throw error;
      }
      return savedReadFileSync.call(fs, file, ...args);
    };
    sourceReadError = caught(() => adapter.verifyPinnedSources({ repoRoot: ROOT }));
  } finally {
    fs.readFileSync = savedReadFileSync;
  }
  check('R16a-fix SOURCE_READ has a behavioural pinned-source read-failure test',
    !!sourceReadError && sourceReadError.code === adapter.ERROR_CODES.SOURCE_READ,
    JSON.stringify(sourceReadError && { code: sourceReadError.code, detail: sourceReadError.detail }));

  expectCode(
    'R16a-fix INPUT_TYPE has a behavioural non-string/non-buffer test',
    () => adapter.parseShellV2({ not: 'bash source' }),
    adapter.ERROR_CODES.INPUT_TYPE,
    'If arbitrary input types were coerced, the byte/source binding contract could change before parsing.');

  function repositoryPrivateEntryViolations(root, syntheticFiles) {
    const files = syntheticFiles || [];
    if (!syntheticFiles) {
      (function walk(dir, relDir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (['.git', '.worktrees', 'node_modules'].includes(entry.name)) continue;
          const rel = relDir ? relDir + '/' + entry.name : entry.name;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(abs, rel);
          else if (entry.isFile() && /\.(?:cjs|mjs|js)$/.test(entry.name)) {
            files.push({ file: rel, text: fs.readFileSync(abs, 'utf8') });
          }
        }
      })(root, '');
    }
    const violations = [];
    const privateNameRe = /(?:projector|target-rules)\.cjs/g;
    for (const item of files) {
      if (item.file === 'scripts/private/p2-bash-ast-js/adapter.cjs' ||
          item.file.startsWith('tests/')) continue;
      let match;
      while ((match = privateNameRe.exec(item.text)) !== null) {
        violations.push({ file: item.file, target: match[0] });
      }
    }
    return violations;
  }

  const entryViolations = repositoryPrivateEntryViolations(ROOT);
  const syntheticEntryViolations = repositoryPrivateEntryViolations(ROOT, [{
    file: 'guards/synthetic-direct-private-entry.cjs',
    text: "require('../scripts/private/p2-bash-ast-js/projector.cjs');",
  }]);
  check('R16a-fix repository check enforces adapter.cjs as the only non-test private entry',
    entryViolations.length === 0 && syntheticEntryViolations.length === 1,
    JSON.stringify({ entryViolations, syntheticEntryViolations }));

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

process.once('beforeExit', () => {
  console.log('P2-BASH-AST-V2-SELFTEST ' + JSON.stringify({ pass, fail, skip, skipReasons }) + ' ' + skip + ' skipped');
  if (fail) process.exitCode = 1;
});
