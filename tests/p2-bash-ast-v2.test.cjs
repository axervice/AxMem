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
const V1_RECORDED = path.join(__dirname, 'fixtures', 'p2-bash-ast', 'v2', 'v1-projection-recorded.json');
const V1_RECORDED_SHA256 = '3c87126b6d349241279021a121a884e3a3b27f8f98c3514d6207b9672c81ccc5';
const V1_LIVE_SAMPLE_IDS = Object.freeze(["00001","00053","00105","00157","00209","00261","00314","00366","00418","00470","00522","00574","00626","00678","00730","00782","00835","00887","00939","00991","01043","01095","01147","01199","01251","01303","01356","01408","01460","01512","01564","01616"]);
const GO_V1_EXE = path.join(ROOT, 'scripts', 'private', 'p2-bash-ast', 'bin', 'p2-bash-ast.exe');
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
function runFixedLiveV1Sample(exe, golden, v1FixtureById) {
  if (!fs.existsSync(exe)) {
    return {
      skipped: true,
      reason: 'Go v1 helper is absent (ignored build artifact): ' + exe,
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
  return { skipped: false, reason: null, rows };
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

  const liveSampleResult = runFixedLiveV1Sample(GO_V1_EXE, golden, v1FixtureById);
  if (liveSampleResult.skipped) {
    skipCheck('fixed 32-entry live Go v1 sample equals the recorded fixture', liveSampleResult.reason);
  } else {
    check('fixed 32-entry live Go v1 sample equals the recorded fixture',
      liveSampleResult.rows.length === 32 && liveSampleResult.rows.every((row) => row.ok),
      JSON.stringify(liveSampleResult.rows));
  }
  const missingLiveSample = runFixedLiveV1Sample(path.join(T, 'missing-go-v1-helper.exe'), golden, v1FixtureById);
  check('R16a-fix3 missing Go v1 helper returns a counted SKIP contract instead of throwing or passing',
    missingLiveSample.skipped === true &&
      /Go v1 helper is absent/.test(missingLiveSample.reason) &&
      missingLiveSample.rows.length === 0,
    JSON.stringify(missingLiveSample));

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
  ruleCase(
    'uncalled function body stays candidate while a proven call makes it production',
    !!functionUncalled && functionUncalled.status === 'candidate' && functionUncalled.reachability === 'candidate' &&
      !functionUncalledScan.targets.some((x) => x.expression === './inside.cjs' && x.reachability === 'production'),
    functionUncalled,
    !!functionCalled && functionCalled.status === 'resolved' && functionCalled.reachability === 'production',
    functionCalled,
    'If syntactic presence alone implied reachability, the uncalled body would create a false production edge; candidate reachability until a call is observed excludes that false pass.');

  const caseScan = adapter.scanDependencyTargets(
    'case "$X" in a) node ./case.cjs;; b) source ./case.sh;; esac');
  const caseNode = target(caseScan, (x) => x.expression === './case.cjs');
  const caseSource = target(caseScan, (x) => x.expression === './case.sh');
  const topLevelNode = target(adapter.scanDependencyTargets(
    'node ./case.cjs'), (x) => x.expression === './case.cjs');
  ruleCase(
    'unproven case arms are candidate rather than production',
    !!caseNode && caseNode.status === 'candidate' && !!caseSource && caseSource.status === 'candidate',
    { node: caseNode, source: caseSource },
    !!topLevelNode && topLevelNode.status === 'resolved' && topLevelNode.reachability === 'production',
    topLevelNode,
    'If case arms were treated as unconditionally reachable, both mutually exclusive arms would become false production edges; candidate arm reachability excludes that false pass.');

  const ifScan = adapter.scanDependencyTargets(
    'if test -n "$X"; then node ./yes.cjs; else node ./no.cjs; fi');
  const ifYes = target(ifScan, (x) => x.expression === './yes.cjs');
  const ifNo = target(ifScan, (x) => x.expression === './no.cjs');
  const topLevelYes = target(adapter.scanDependencyTargets(
    'node ./yes.cjs'), (x) => x.expression === './yes.cjs');
  ruleCase(
    'unproven conditional branches are candidate rather than production',
    !!ifYes && ifYes.status === 'candidate' && !!ifNo && ifNo.status === 'candidate',
    { then: ifYes, else: ifNo },
    !!topLevelYes && topLevelYes.status === 'resolved' && topLevelYes.reachability === 'production',
    topLevelYes,
    'If conditional branches were assumed to run, mutually exclusive branch dependencies would both become production edges; candidate branch reachability excludes that false pass.');

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

  const homeHelperPath = path.join(ROOT, 'guards', 'pmm-home.sh');
  const homeHelperSource = fs.readFileSync(homeHelperPath, 'utf8');
  const homeHelperScan = adapter.scanDependencyTargets(homeHelperSource, { fromPath: 'guards/pmm-home.sh' });
  const homeHelperTarget = target(homeHelperScan,
    (x) => x.kind === 'node-inline-require' && x.target === 'guards/pmm-recall-ledger.cjs');
  const homeLines = homeHelperSource.split(/\r?\n/);
  const isolatedNodeLine = homeLines[58] || '';
  const isolatedHomeScan = adapter.scanDependencyTargets(isolatedNodeLine, { fromPath: 'guards/pmm-home.sh' });
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
  check('R16a-fix && right operand is candidate',
    !!andTarget && andTarget.status === 'candidate' && andTarget.reachability === 'candidate',
    JSON.stringify(andTarget));

  const orTarget = target(adapter.scanDependencyTargets(
    'node ./first.cjs || node ./or.cjs'), (x) => x.expression === './or.cjs');
  check('R16a-fix || right operand is candidate',
    !!orTarget && orTarget.status === 'candidate' && orTarget.reachability === 'candidate',
    JSON.stringify(orTarget));

  const whileTarget = target(adapter.scanDependencyTargets(
    'while test x; do node ./while.cjs; done'), (x) => x.expression === './while.cjs');
  check('R16a-fix while body dependency is candidate',
    !!whileTarget && whileTarget.status === 'candidate' && whileTarget.reachability === 'candidate',
    JSON.stringify(whileTarget));

  const forTarget = target(adapter.scanDependencyTargets(
    'for x in a; do node ./for.cjs; done'), (x) => x.expression === './for.cjs');
  check('R16a-fix for body dependency is candidate',
    !!forTarget && forTarget.status === 'candidate' && forTarget.reachability === 'candidate',
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
    const got = target(adapter.scanDependencyTargets(sourceText),
      (x) => x.kind === 'node-script' && x.expression === '"$X"');
    return { source: sourceText, got };
  });
  const f1Candidate = target(adapter.scanDependencyTargets(
    'X=./safe.cjs; if true; then node "$X"; fi'),
    (x) => x.kind === 'node-script' && x.expression === '"$X"');
  check('R16a-fix3 F1 non-linear and shell-writer mutations invalidate outer bindings',
    f1Actual.every((row) => row.got && row.got.status === 'unresolved' && row.got.target === null) &&
      !!f1Candidate && f1Candidate.status === 'candidate' && f1Candidate.target === null,
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
      !!f3Next && f3Next.status === 'candidate' && f3Next.reachability === 'candidate',
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

console.log('P2-BASH-AST-V2-SELFTEST ' + JSON.stringify({ pass, fail, skip, skipReasons }));
if (fail) process.exit(1);
