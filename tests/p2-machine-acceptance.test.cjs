#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const runner = require('../scripts/equiv-runner.cjs');
const equiv = require('../scripts/equiv.cjs');
const freezeTool = require('../scripts/p2-freeze.cjs');

if (process.argv[2] !== '--self-test') {
  console.error('usage: p2-machine-acceptance.test.cjs --self-test');
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS ' + name); pass++; }
  else { console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); fail++; }
}
function git(cwd, args) {
  return cp.execFileSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-p20-machine-accept-'));
try {
  // ---- Equiv runner/comparator: temp git repo only, never real HOME hooks. ----
  const repo = path.join(T, 'repo');
  const live = path.join(repo, '.claude');
  fs.mkdirSync(path.join(live, 'guards'), { recursive: true });
  const hookAbs = path.join(live, 'guards', 'hook.cjs');
  fs.writeFileSync(hookAbs, [
    "'use strict';",
    "const fs=require('fs'),path=require('path');",
    "const j=JSON.parse(fs.readFileSync(0,'utf8'));",
    "const d=process.env.PMM_MEM_DIR || path.join(process.env.HOME,'.claude','.state');",
    "fs.mkdirSync(d,{recursive:true});",
    "fs.writeFileSync(path.join(d,'trace.txt'),'event='+j.hook_event_name+'\\n');",
    "if (j.prompt === 'deny') process.exit(2);",
    "",
  ].join('\n'));
  const missingDepAbs = path.join(live, 'guards', 'missing-dependency.cjs');
  fs.writeFileSync(missingDepAbs, "require('axmem_definitely_missing_review_dependency');\n");
  const badSyntaxAbs = path.join(live, 'guards', 'bad-syntax.cjs');
  fs.writeFileSync(badSyntaxAbs, "const = ;\n");
  git(repo, ['init', '-q']);
  git(repo, ['add', '.claude']);
  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'fixture']);
  const commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const treeOid = git(repo, ['rev-parse', 'HEAD:.claude']).trim();
  const hookRel = 'guards/hook.cjs';
  const command = 'node "' + hookAbs.replace(/\\/g, '/') + '"';
  const sourceFiles = [{ path: hookRel, sha256: sha256(fs.readFileSync(hookAbs)), disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'fixture' }];
  const rh = (logicalId, event, matcher, hookIndex) => ({
    logicalId, event, groupIndex: 0, hookIndex, matcher, command, timeout: 5,
    disposition: 'port', files: [hookRel], implementation: null, notes: 'temp fixture runnable', externalDependencies: [],
    businessExitCodes: [2],
    runtimeHealthProbe: { version: 1, innerCommand: command, reliable: true, notes: 'reviewed exact inner command; case-specific branches remain observable to the inner execution' },
  });
  const freeze = {
    schema: 'axmem-p2-freeze/v1',
    source: { commit, liveRelativePath: '.claude', treeOid, clean: true, uncommittedPatch: { empty: true, sha256: null } },
    sourceFiles,
    hooks: [
      rh('tool-pre', 'PreToolUse', 'Bash|Edit|Write', 0),
      rh('tool-post', 'PostToolUse', 'Bash|Edit|Write', 0),
      rh('session-start', 'SessionStart', null, 0),
      rh('session-end', 'SessionEnd', null, 0),
      rh('user-prompt', 'UserPromptSubmit', null, 0),
      {
        logicalId: 'user-prompt-external', event: 'UserPromptSubmit', groupIndex: 0, hookIndex: 1, matcher: null,
        command: 'never-execute-external', timeout: 5, disposition: 'external-prerequisite', files: [],
        implementation: null, notes: 'fixture external prerequisite intentionally skipped', externalDependencies: ['fixture-external'],
      },
      rh('pre-compact', 'PreCompact', null, 0),
    ],
  };
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'p2-equiv', 'events.json'), 'utf8'));

  let emptyFixtureErr = '';
  try { runner.runFreezeReport({ freeze, fixture: { version: 1, events: [] }, repoRoot: repo, sourceRoot: live }); }
  catch (e) { emptyFixtureErr = e.message; }
  check('runner rejects empty fixture', /non-empty events/.test(emptyFixtureErr), emptyFixtureErr);

  let partialFixtureErr = '';
  try { runner.runFreezeReport({ freeze, fixture: { version: 1, events: [{ event: 'Bash', cases: [{ id: 'b1' }] }] }, repoRoot: repo, sourceRoot: live }); }
  catch (e) { partialFixtureErr = e.message; }
  check('runner enforces seven event classes with >=3 cases', /at least 3 cases/.test(partialFixtureErr), partialFixtureErr);

  let dupFixtureErr = '';
  try {
    const dup = clone(fixture);
    dup.events[1].cases[0].id = dup.events[0].cases[0].id;
    runner.validateFixture(dup);
  } catch (e) { dupFixtureErr = e.message; }
  check('runner rejects duplicate/non-unique case ids', /duplicate fixture case id/.test(dupFixtureErr), dupFixtureErr);

  const escape = path.join(T, 'escape-write');
  const prior = process.env.PMM_MEM_DIR;
  process.env.PMM_MEM_DIR = escape;
  const reportA = runner.runFreezeReport({ freeze, fixture, repoRoot: repo, sourceRoot: live });
  const reportB = runner.runFreezeReport({ freeze, fixture, repoRoot: repo, sourceRoot: live });
  if (prior === undefined) delete process.env.PMM_MEM_DIR; else process.env.PMM_MEM_DIR = prior;
  check('runner emits full 21-case baseline', reportA.cases.length === 21 && reportA.fixtureCoverage.caseCount === 21);
  check('runner keeps writes inside temp sandbox despite inherited PMM path', !fs.existsSync(escape));
  check('runner leaves fixture git source clean', git(repo, ['status', '--porcelain', '--', '.claude']).trim() === '');
  const same = equiv.compareReports(reportA, reportB, []);
  check('full baseline compares green', same.equal === true && same.unexpected.length === 0);

  let emptyReportErr = '';
  try { equiv.compareReports({ schema: 'axmem-equiv-report/v1', cases: [] }, { schema: 'axmem-equiv-report/v1', cases: [] }, []); }
  catch (e) { emptyReportErr = e.message; }
  check('comparator rejects empty reports fail-closed before comparison', /invalid source identity|at least one case/.test(emptyReportErr), emptyReportErr);

  const silentA = clone(reportA), silentB = clone(reportA);
  for (const c of silentA.cases.concat(silentB.cases)) { c.stdout = ''; c.stderr = ''; c.stateTree = {}; }
  const bash = silentB.cases.find((c) => c.event === 'Bash');
  bash.hookResults[1] = {
    logicalId: bash.hookResults[1].logicalId, phase: bash.hookResults[1].phase, matcher: bash.hookResults[1].matcher,
    disposition: 'external-prerequisite', status: 'skipped', reason: 'explicit skip mismatch fixture',
    externalDependencies: ['fixture-external'],
  };
  bash.executedHooks -= 1;
  const coverageRed = equiv.compareReports(silentA, silentB, []);
  check('comparator catches 2-runs vs 1-run+1-skip with silent hooks', coverageRed.equal === false && coverageRed.unexpected.some((d) => /hookTrace/.test(d.field)));

  const mappedRight = clone(reportA);
  const mappedCase = mappedRight.cases.find((c) => c.event === 'Bash');
  mappedCase.hookResults[0].logicalId = 'migrated-tool-pre';
  mappedCase.hookResults[0].disposition = 'replace';
  mappedCase.hookResults[0].runtimeHealth.logicalId = 'migrated-tool-pre';
  const implicitMap = equiv.compareReports(reportA, mappedRight, []);
  check('comparator rejects implicit logical hook replacement', implicitMap.equal === false);
  const explicitMap = equiv.compareReports(reportA, mappedRight, { hookMappings: [{
    leftId: 'tool-pre', rightId: 'migrated-tool-pre', leftDisposition: 'port', rightDisposition: 'replace',
    reason: 'explicit migration map; physical implementation path is intentionally not compared',
  }] });
  check('comparator accepts explicit port-to-replace logical mapping', explicitMap.equal === true && explicitMap.hookMappingsApplied.length === 1);

  const focusedGroup = { event: 'UserPromptSubmit', hookEvents: ['UserPromptSubmit'] };
  const focusedCase = { id: 'deny', input: { prompt: 'deny' } };
  const deny = runner.runCase({ freeze, group: focusedGroup, c: focusedCase, repoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  check('runner classifies exit2 as legal business deny', deny.exitCode === 2 && deny.hookResults.some((h) => h.status === 'ran' && h.exitCode === 2 && h.outcome === 'deny'));

  // P2 runtime-health v1: exact reviewed inner command, per-case execution, independent sandbox.
  const branchyRel = 'guards/branchy.cjs';
  const branchyAbs = path.join(live, ...branchyRel.split('/'));
  fs.writeFileSync(branchyAbs, [
    "'use strict';",
    "const fs=require('fs'),path=require('path');",
    "const j=JSON.parse(fs.readFileSync(0,'utf8'));",
    "if(j.prompt==='missing-module') require('axmem_case_only_missing_module');",
    "if(j.prompt==='exit1') process.exit(1);",
    "if(j.prompt==='deny') process.exit(2);",
    "if(j.prompt==='json-deny'){ console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny'}})); process.exit(0); }",
    "if(j.prompt==='side-effect'){ const p=path.join(process.env.HOME,'probe-marker'); if(fs.existsSync(p)) process.exit(1); fs.writeFileSync(p,'once'); }",
    "console.log('ALLOW');",
    "",
  ].join('\n'));
  git(repo, ['add', '.claude/guards/branchy.cjs']);
  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'runtime health branch fixture']);
  const branchCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  const branchTree = git(repo, ['rev-parse', 'HEAD:.claude']).trim();
  const branchSha = sha256(fs.readFileSync(branchyAbs));
  const branchInner = 'node "' + branchyAbs.replace(/\\/g, '/') + '"';
  const mkBranchFreeze = (outer, inner, reliable = true) => ({
    schema: 'axmem-p2-freeze/v1',
    source: { commit: branchCommit, liveRelativePath: '.claude', treeOid: branchTree, clean: true, uncommittedPatch: { empty: true, sha256: null } },
    sourceFiles: [{ path: branchyRel, sha256: branchSha, disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'runtime health branch fixture' }],
    hooks: [{
      logicalId: 'runtime-health-branch', event: 'UserPromptSubmit', groupIndex: 0, hookIndex: 0, matcher: null,
      command: outer, timeout: 5, disposition: 'port', files: [branchyRel], implementation: null,
      notes: 'runtime health branch fixture', externalDependencies: [], businessExitCodes: [2],
      runtimeHealthProbe: { version: 1, innerCommand: inner, reliable, notes: reliable ? 'exact reviewed inner command' : 'inner intentionally swallows failures; health cannot be proven' },
    }],
  });
  const runBranch = (outer, prompt, inner = branchInner, reliable = true) =>
    runner.runCase({ freeze: mkBranchFreeze(outer, inner, reliable), group: focusedGroup, c: { id: 'rh-' + prompt, input: { prompt } }, repoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  const simpleOuter = branchInner + ' || exit 0';
  const braceOuter = branchInner + ' || { echo masked >&2; exit 0; }';
  const silentOuter = branchInner + ' >/dev/null 2>&1 || exit 0';

  for (const [name, outer, prompt, expect] of [
    ['simple wrapper case-only missing module', simpleOuter, 'missing-module', 'unexpected-exit:1'],
    ['brace wrapper undeclared exit1', braceOuter, 'exit1', 'unexpected-exit:1'],
    ['silent redirect case-only missing module', silentOuter, 'missing-module', 'unexpected-exit:1'],
  ]) {
    let err = null;
    try { runBranch(outer, prompt); } catch (e) { err = e; }
    check('runtime health blocks ' + name, err && err.code === 'equiv-infrastructure' && new RegExp(expect).test(err.message), String(err && err.message));
  }

  const missingEntry = 'node "' + path.join(live, 'guards', 'never-there.cjs').replace(/\\/g, '/') + '"';
  let missingEntryErr = null;
  try { runBranch(missingEntry + ' >/dev/null 2>&1 || exit 0', 'allow', missingEntry); } catch (e) { missingEntryErr = e; }
  check('runtime health blocks fully silent missing inner entry despite outer exit0',
    missingEntryErr && missingEntryErr.code === 'equiv-infrastructure' && /unexpected-exit:1/.test(missingEntryErr.message), String(missingEntryErr && missingEntryErr.message));

  const goodAllow = runBranch(simpleOuter, 'allow');
  check('runtime health allows legal allow with structured evidence',
    goodAllow.exitCode === 0 && goodAllow.hookResults[0].runtimeHealth && goodAllow.hookResults[0].runtimeHealth.status === 'healthy');
  const goodDeny = runBranch(branchInner, 'deny');
  check('runtime health preserves legal exit2 deny', goodDeny.exitCode === 2 && goodDeny.hookResults[0].runtimeHealth.probeExitCode === 2);
  const goodJson = runBranch(simpleOuter, 'json-deny');
  check('runtime health preserves JSON deny encoded with exit0', goodJson.exitCode === 0 && /permissionDecision/.test(goodJson.stdout));
  const sideEffect = runBranch(simpleOuter, 'side-effect');
  check('runtime health probe side effect cannot contaminate outer sandbox',
    sideEffect.exitCode === 0 && sideEffect.hookResults[0].runtimeHealth.probeContaminatedOuter === false
      && sideEffect.hookResults[0].runtimeHealth.initialOuterStateSha256 === sideEffect.hookResults[0].runtimeHealth.outerStateAfterProbeSha256);

  let unreliableErr = null;
  try { runBranch(simpleOuter, 'allow', branchInner, false); } catch (e) { unreliableErr = e; }
  check('runtime health explicitly blocks reviewed inner modes that cannot reliably expose internal failures',
    unreliableErr && /explicitly unprovable/.test(unreliableErr.message), String(unreliableErr && unreliableErr.message));

  const syntaxRel = 'guards/runtime-health-bad-syntax.cjs';
  const syntaxAbs = path.join(live, ...syntaxRel.split('/'));
  fs.writeFileSync(syntaxAbs, 'const = ;\n');
  git(repo, ['add', '.claude/guards/runtime-health-bad-syntax.cjs']);
  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'runtime health syntax fixture']);
  const syntaxCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  const syntaxTree = git(repo, ['rev-parse', 'HEAD:.claude']).trim();
  const syntaxCmd = 'node "' + syntaxAbs.replace(/\\/g, '/') + '"';
  const syntaxFreeze = {
    schema: 'axmem-p2-freeze/v1',
    source: { commit: syntaxCommit, liveRelativePath: '.claude', treeOid: syntaxTree, clean: true, uncommittedPatch: { empty: true, sha256: null } },
    sourceFiles: [{ path: syntaxRel, sha256: sha256(fs.readFileSync(syntaxAbs)), disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'syntax fixture' }],
    hooks: [{ logicalId: 'rh-syntax', event: 'UserPromptSubmit', groupIndex: 0, hookIndex: 0, matcher: null,
      command: syntaxCmd + ' >/dev/null 2>&1 || exit 0', timeout: 5, disposition: 'port', files: [syntaxRel],
      implementation: null, notes: 'syntax fixture', externalDependencies: [], businessExitCodes: [2],
      runtimeHealthProbe: { version: 1, innerCommand: syntaxCmd, reliable: true, notes: 'exact reviewed inner' } }],
  };
  let syntaxHealthErr = null;
  try { runner.runCase({ freeze: syntaxFreeze, group: focusedGroup, c: { id: 'rh-syntax', input: {} }, repoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 }); } catch (e) { syntaxHealthErr = e; }
  check('runtime health blocks syntax/startup failure hidden by outer exit0', syntaxHealthErr && /source health preflight failed/.test(syntaxHealthErr.message), String(syntaxHealthErr && syntaxHealthErr.message));

  // Comparator must reject missing/text-only/stale/cross-case health metadata and two equally bad reports.
  const validHealthReportA = runner.runFreezeReport({ freeze, fixture, repoRoot: repo, sourceRoot: live });
  const validHealthReportB = runner.runFreezeReport({ freeze, fixture, repoRoot: repo, sourceRoot: live });

  // Cross-source equivalence: provenance must validate independently on each side,
  // but comment-only source changes and enclosing empty commits are not behavior.
  fs.appendFileSync(hookAbs, '// behavior unchanged comment-only source revision\n');
  git(repo, ['add', '.claude/guards/hook.cjs']);
  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'comment-only hook source revision']);
  const commentFreeze = clone(freeze);
  commentFreeze.source.commit = git(repo, ['rev-parse', 'HEAD']).trim();
  commentFreeze.source.treeOid = git(repo, ['rev-parse', 'HEAD:.claude']).trim();
  commentFreeze.sourceFiles[0].sha256 = sha256(fs.readFileSync(hookAbs));
  const commentReport = runner.runFreezeReport({ freeze: commentFreeze, fixture, repoRoot: repo, sourceRoot: live });
  const commentEquivalent = equiv.compareReports(validHealthReportA, commentReport, []);
  check('comparator accepts behavior-equivalent comment-only source revision',
    commentEquivalent.equal === true && commentEquivalent.unexpected.length === 0);

  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '--allow-empty', '-qm', 'metadata-only empty commit']);
  const emptyCommitFreeze = clone(commentFreeze);
  emptyCommitFreeze.source.commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const emptyCommitReport = runner.runFreezeReport({ freeze: emptyCommitFreeze, fixture, repoRoot: repo, sourceRoot: live });
  const emptyCommitEquivalent = equiv.compareReports(commentReport, emptyCommitReport, []);
  check('comparator accepts identical source tree across different enclosing commits',
    emptyCommitEquivalent.equal === true && emptyCommitEquivalent.unexpected.length === 0
      && commentReport.source.treeOid === emptyCommitReport.source.treeOid
      && commentReport.source.commit !== emptyCommitReport.source.commit);

  const mutateHealthAndReject = (name, mutate) => {
    const x = clone(validHealthReportA);
    mutate(x.cases[0].hookResults.find((h) => h.status === 'ran').runtimeHealth, x.cases[0].hookResults.find((h) => h.status === 'ran'));
    let err = '';
    try { equiv.compareReports(x, validHealthReportB, []); } catch (e) { err = e.message; }
    check(name, !!err, err);
  };
  mutateHealthAndReject('comparator rejects wrong-case runtime health binding', (h) => { h.caseId = 'wrong-case'; });
  mutateHealthAndReject('comparator rejects wrong-input runtime health binding', (h) => { h.inputSha256 = '0'.repeat(64); });
  mutateHealthAndReject('comparator rejects stale/wrong-source runtime health binding', (h) => { h.sourceCommit = '0'.repeat(40); });
  mutateHealthAndReject('comparator rejects sandbox-state runtime health tamper', (h) => { h.outerStateAfterProbeSha256 = '0'.repeat(64); });
  mutateHealthAndReject('comparator rejects command metadata mismatch', (h) => { h.innerCommandSha256 = '0'.repeat(64); });
  const textOnly = clone(validHealthReportA);
  const textHook = textOnly.cases[0].hookResults.find((h) => h.status === 'ran');
  delete textHook.runtimeHealth; textHook.runtimeHealthEvidence = 'text only';
  let textOnlyErr = '';
  try { equiv.compareReports(textOnly, validHealthReportB, []); } catch (e) { textOnlyErr = e.message; }
  check('comparator rejects text-only runtime health evidence', /structured runtime health/.test(textOnlyErr), textOnlyErr);
  const badPairA = clone(validHealthReportA), badPairB = clone(validHealthReportB);
  for (const x of [badPairA, badPairB]) x.cases[0].hookResults.find((h) => h.status === 'ran').runtimeHealth.status = 'broken';
  let badPairErr = '';
  try { equiv.compareReports(badPairA, badPairB, []); } catch (e) { badPairErr = e.message; }
  check('two identically bad structured health results cannot compare green', /runtime health schema\/status/.test(badPairErr), badPairErr);

  let missingErr = null;
  try {
    const bad = clone(freeze);
    bad.hooks = [Object.assign({}, bad.hooks[4], { logicalId: 'missing', command: 'command_that_does_not_exist_axmem_p2' })];
    runner.runCase({ freeze: bad, group: focusedGroup, c: { id: 'missing', input: {} }, repoRoot: repo, sourceRoot: live, defaultTimeoutMs: 1000 });
  } catch (e) { missingErr = e; }
  check('runner classifies command-not-found as infrastructure failure', missingErr && missingErr.code === 'equiv-infrastructure' && /command-start:127/.test(missingErr.message), String(missingErr && missingErr.message));

  let timeoutErr = null;
  try {
    const bad = clone(freeze);
    bad.hooks = [Object.assign({}, bad.hooks[4], { logicalId: 'timeout', command: 'sleep 1', timeout: 0.01 })];
    runner.runCase({ freeze: bad, group: focusedGroup, c: { id: 'timeout', input: {} }, repoRoot: repo, sourceRoot: live, defaultTimeoutMs: 1000 });
  } catch (e) { timeoutErr = e; }
  check('runner classifies timeout as infrastructure failure', timeoutErr && timeoutErr.code === 'equiv-infrastructure' && /timeout/.test(timeoutErr.message), String(timeoutErr && timeoutErr.message));
  // R2: a runtime dependency/startup failure must not become a business deny,
  // even when the hook command redirects stderr away.
  const missingRel = 'guards/missing-dependency.cjs';
  const missingSourceRow = {
    path: missingRel, sha256: sha256(fs.readFileSync(missingDepAbs)),
    disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'R2 missing-runtime-dependency fixture',
  };
  const badRh = (logicalId, event, matcher) => ({
    logicalId, event, groupIndex: 0, hookIndex: 0, matcher,
    command: 'node "' + missingDepAbs.replace(/\\/g, '/') + '" 2>/dev/null',
    timeout: 5, disposition: 'port', files: [missingRel], implementation: null,
    notes: 'R2 stderr-redirection fixture', externalDependencies: [],
    businessExitCodes: [2],
    runtimeHealthProbe: { version: 1, innerCommand: 'node "' + missingDepAbs.replace(/\\/g, '/') + '" 2>/dev/null', reliable: true, notes: 'reviewed exact inner command; exit 1 is not admitted' },
  });
  const missingFreeze = Object.assign({}, freeze, {
    sourceFiles: freeze.sourceFiles.concat([missingSourceRow]),
    hooks: [
      badRh('r2-tool-pre', 'PreToolUse', 'Bash|Edit|Write'),
      badRh('r2-tool-post', 'PostToolUse', 'Bash|Edit|Write'),
      badRh('r2-session-start', 'SessionStart', null),
      badRh('r2-session-end', 'SessionEnd', null),
      badRh('r2-user-prompt', 'UserPromptSubmit', null),
      badRh('r2-pre-compact', 'PreCompact', null),
    ],
  });
  const missingRunErrors = [];
  for (let i = 0; i < 2; i++) {
    try { runner.runFreezeReport({ freeze: missingFreeze, fixture, repoRoot: repo, sourceRoot: live }); }
    catch (e) { missingRunErrors.push(e); }
  }
  check('R2 missing runtime module blocks both full baselines despite stderr redirect',
    missingRunErrors.length === 2 && missingRunErrors.every((e) => e && e.code === 'equiv-infrastructure' && /unexpected-exit:1/.test(e.message)),
    missingRunErrors.map((e) => e && e.message).join(' | '));

  let missingContractErr = null;
  try {
    const bad = clone(freeze);
    bad.hooks = [Object.assign({}, bad.hooks[4], { logicalId: 'missing-contract' })];
    delete bad.hooks[0].businessExitCodes;
    runner.runCase({ freeze: bad, group: focusedGroup, c: { id: 'missing-contract', input: {} }, repoRoot: repo, sourceRoot: live, defaultTimeoutMs: 1000 });
  } catch (e) { missingContractErr = e; }
  check('R2 runnable hook without explicit business exit contract is infrastructure failure',
    missingContractErr && missingContractErr.code === 'equiv-infrastructure' && /businessExitCodes/.test(missingContractErr.message),
    String(missingContractErr && missingContractErr.message));

  let badSyntaxErr = null;
  try {
    const badRel = 'guards/bad-syntax.cjs';
    const bad = clone(freeze);
    bad.sourceFiles.push({ path: badRel, sha256: sha256(fs.readFileSync(badSyntaxAbs)), disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'R2 syntax fixture' });
    bad.hooks = [Object.assign({}, bad.hooks[4], {
      logicalId: 'bad-syntax', command: 'node "' + badSyntaxAbs.replace(/\\/g, '/') + '" 2>/dev/null',
      files: [badRel],
    })];
    runner.runCase({ freeze: bad, group: focusedGroup, c: { id: 'bad-syntax', input: {} }, repoRoot: repo, sourceRoot: live, defaultTimeoutMs: 1000 });
  } catch (e) { badSyntaxErr = e; }
  check('R2 syntax/startup failure is caught before execution despite stderr redirect',
    badSyntaxErr && badSyntaxErr.code === 'equiv-infrastructure' && /source health preflight failed/.test(badSyntaxErr.message),
    String(badSyntaxErr && badSyntaxErr.message));

  const undeclaredA = clone(reportA), undeclaredB = clone(reportA);
  for (const x of [undeclaredA, undeclaredB]) {
    x.cases[0].exitCode = 1;
    x.cases[0].hookResults[0].exitCode = 1;
    x.cases[0].hookResults[0].outcome = 'deny';
  }
  let undeclaredCompareErr = '';
  try { equiv.compareReports(undeclaredA, undeclaredB, []); } catch (e) { undeclaredCompareErr = e.message; }
  check('R2 two identical undeclared exit1 reports cannot compare green',
    /undeclared nonzero hook exit/.test(undeclaredCompareErr), undeclaredCompareErr);



  const infraA = clone(reportA), infraB = clone(reportA);
  for (const x of [infraA, infraB]) {
    x.cases[0].exitCode = 127;
    x.cases[0].hookResults[0].exitCode = 127;
    x.cases[0].hookResults[0].outcome = 'deny';
  }
  let infraCompareErr = '';
  try { equiv.compareReports(infraA, infraB, []); } catch (e) { infraCompareErr = e.message; }
  check('two identical infrastructure failures cannot compare green', /infrastructure/.test(infraCompareErr), infraCompareErr);

  const denyA = clone(reportA), denyB = clone(reportA);
  for (const x of [denyA, denyB]) {
    x.cases[0].exitCode = 2;
    x.cases[0].hookResults[0].exitCode = 2;
    x.cases[0].hookResults[0].outcome = 'deny';
  }
  const denySame = equiv.compareReports(denyA, denyB, []);
  check('two equivalent legal deny outcomes can compare green', denySame.equal === true && denySame.unexpected.length === 0);

  const unexplained = clone(reportA);
  const skipCase = unexplained.cases.find((c) => c.hookResults.some((h) => h.status === 'skipped'));
  skipCase.hookResults.find((h) => h.status === 'skipped').reason = '';
  let skipErr = '';
  try { equiv.compareReports(reportA, unexplained, []); } catch (e) { skipErr = e.message; }
  check('external skip must remain explicit and explained', /unexplained skipped hook/.test(skipErr), skipErr);

  // ---- Dependency closure: temp git repo and static files only. ----
  const depRepo = path.join(T, 'dep-repo');
  const depLive = path.join(depRepo, '.claude');
  fs.mkdirSync(path.join(depLive, 'guards', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(depLive, 'guards', 'helper.sh'), '#!/usr/bin/env bash\ntrue\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'main.sh'), 'G="$HOME/.claude"\nsource "$G/guards/helper.sh"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'helper.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'lib', 'index.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'main.cjs'), "require('./helper');\nrequire('./lib');\n");
  fs.mkdirSync(path.join(depLive, 'guards', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(depLive, 'guards', 'plugins', 'helper.js'), 'module.exports = 3;\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'plugins', 'index.js'), 'module.exports = 4;\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'dynamic-concat.cjs'), "const name='helper';\nrequire('./' + name);\n");
  fs.writeFileSync(path.join(depLive, 'guards', 'static-concat.cjs'), "require('./' + 'helper');\n");
  fs.writeFileSync(path.join(depLive, 'guards', 'dynamic-import.cjs'), "import('./helper.js');\n");
  fs.writeFileSync(path.join(depLive, 'guards', 'mixed-join.cjs'), "const path=require('path'), name='helper.js';\nrequire(path.join(__dirname, 'plugins', name));\n");
  fs.writeFileSync(path.join(depLive, 'guards', 'comments.cjs'), [
    "const text = \"require('./fake')\";",
    "// require('./comment')",
    "/* import('./blocked.js') */",
    "require('./helper');",
    "",
  ].join('\n'));
  fs.writeFileSync(path.join(depLive, 'guards', 'dynamic.sh'), 'G="$HOME/.claude"\nsource "$G/guards/$TARGET.sh"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self.cjs'), "require(__filename);\n");
  fs.writeFileSync(path.join(depLive, 'guards', 'self-reassigned.cjs'), '__filename="./missing.cjs";\nrequire(__filename);\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self-shadowed.cjs'), '(function(__filename){ require(__filename); })("./missing.cjs");\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self-exact.sh'), 'SELF="${BASH_SOURCE[0]}"\nbash "$SELF" --self-test\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self-single-quoted.sh'), "SELF='${BASH_SOURCE[0]}'\nbash \"$SELF\"\n");
  fs.writeFileSync(path.join(depLive, 'guards', 'self-conditional.sh'), 'if false; then\nSELF="${BASH_SOURCE[0]}"\nfi\nbash "$SELF"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self-inline-read.sh'), 'SELF="${BASH_SOURCE[0]}"\ntrue; read SELF\nbash "$SELF"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self.sh'), 'G="$HOME/.claude"\nSELF="$G/$(basename "${BASH_SOURCE[0]}")"\nbash "$SELF" --self-test\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self-suffix.sh'), 'SELF="${BASH_SOURCE[0]}.missing"\nbash "$SELF"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self-reassigned.sh'), 'SELF="${BASH_SOURCE[0]}"\nSELF="./other.sh"\nbash "$SELF"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self-read.sh'), 'SELF="${BASH_SOURCE[0]}"\nread SELF\nbash "$SELF"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'self-export.sh'), 'SELF="${BASH_SOURCE[0]}"\nexport SELF=./other.sh\nbash "$SELF"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'receipt.sh'), 'bash "$0" pending\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'dirname-other.sh'), 'source "$(dirname "$OTHER")/missing.sh"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'relative-entry.sh'), 'source "$(dirname "$0")/helper.sh"\n');
  fs.writeFileSync(path.join(depLive, 'guards', 'escape-entry.sh'), 'source "$(dirname "$0")/../../escape.sh"\n');
  git(depRepo, ['init', '-q']);
  git(depRepo, ['add', '.claude']);
  git(depRepo, ['-c', 'user.name=P2 Dep', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'dep fixture']);
  const depCommit = git(depRepo, ['rev-parse', 'HEAD']).trim();
  const entries = [
    { path: 'guards/main.sh', dependencies: ['guards/helper.sh'], unresolvedDependencies: [] },
    { path: 'guards/helper.sh', dependencies: [], unresolvedDependencies: [] },
    { path: 'guards/main.cjs', dependencies: ['guards/helper.js', 'guards/lib/index.js'], unresolvedDependencies: [] },
    { path: 'guards/helper.js', dependencies: [], unresolvedDependencies: [] },
    { path: 'guards/lib/index.js', dependencies: [], unresolvedDependencies: [] },
    { path: 'guards/plugins/helper.js', dependencies: [], unresolvedDependencies: [] },
    { path: 'guards/plugins/index.js', dependencies: [], unresolvedDependencies: [] },
    { path: 'guards/dynamic-concat.cjs', dependencies: ['guards/helper.js'], unresolvedDependencies: [
      { expression: "require('./' + name)", dependencies: ['guards/helper.js'], reason: 'fixture variable name is manually reviewed to select helper.js' },
    ] },
    { path: 'guards/static-concat.cjs', dependencies: ['guards/helper.js'], unresolvedDependencies: [] },
    { path: 'guards/dynamic-import.cjs', dependencies: ['guards/helper.js'], unresolvedDependencies: [] },
    { path: 'guards/mixed-join.cjs', dependencies: ['guards/plugins/helper.js'], unresolvedDependencies: [
      { expression: "require(path.join(__dirname, 'plugins', name))", dependencies: ['guards/plugins/helper.js'], reason: 'fixture runtime selector is manually reviewed to select plugins/helper.js, not plugins/index.js' },
    ] },
    { path: 'guards/comments.cjs', dependencies: ['guards/helper.js'], unresolvedDependencies: [] },
    { path: 'guards/self.cjs', dependencies: [], unresolvedDependencies: [] },
  ];
  const fileMap = new Map(entries.map((x) => [x.path, x]));
  const blobs = new Map(entries.map((x) => [x.path, fs.readFileSync(path.join(depLive, ...x.path.split('/')))]));
  let closureErr = '';
  try { freezeTool.verifyDependencyClosure({ fileMap, repoRoot: depRepo, commit: depCommit, relLive: '.claude', blobs }); }
  catch (e) { closureErr = e.code + ':' + e.message; }
  check('dependency closure resolves $G root + extensionless file + index module', closureErr === '', closureErr);
  check('$G source resolves to guards/helper.sh not guards/guards/helper.sh',
    freezeTool.detectLiteralDependencies('guards/main.sh', 'source $G/guards/helper.sh').includes('guards/helper.sh') &&
    !freezeTool.detectLiteralDependencies('guards/main.sh', 'source $G/guards/helper.sh').includes('guards/guards/helper.sh'));
  check('extensionless require includes helper.js candidate', freezeTool.detectLiteralDependencies('guards/main.cjs', "require('./helper')").includes('guards/helper.js'));
  check('directory require includes index.js candidate', freezeTool.detectLiteralDependencies('guards/main.cjs', "require('./lib')").includes('guards/lib/index.js'));

  const dynConcat = freezeTool.analyzeDependencyReferences('guards/dynamic-concat.cjs', "require('./' + name)");
  check('R2 dynamic string concat is explicitly unresolved as the whole require expression',
    dynConcat.references.length === 0 && dynConcat.unresolved.length === 1 && dynConcat.unresolved[0].expression === "require('./' + name)",
    JSON.stringify(dynConcat));

  const staticConcat = freezeTool.analyzeDependencyReferences('guards/static-concat.cjs', "require('./' + 'helper')");
  check('R2 provably static string concat resolves real helper dependency',
    staticConcat.unresolved.length === 0 && staticConcat.references.some((x) => x.candidates.includes('guards/helper.js')),
    JSON.stringify(staticConcat));

  const dynImport = freezeTool.analyzeDependencyReferences('guards/dynamic-import.cjs', "import('./helper.js')");
  check('R2 literal dynamic import is recognized as a real local dependency',
    dynImport.unresolved.length === 0 && dynImport.references.some((x) => x.kind === 'node-import' && x.candidates.includes('guards/helper.js')),
    JSON.stringify(dynImport));

  const mixedJoin = freezeTool.analyzeDependencyReferences('guards/mixed-join.cjs', "require(path.join(__dirname, 'plugins', name))");
  check('R2 mixed path.join remains unresolved instead of collapsing to plugins/index',
    mixedJoin.references.length === 0 && mixedJoin.unresolved.length === 1 &&
      mixedJoin.unresolved[0].expression === "require(path.join(__dirname, 'plugins', name))",
    JSON.stringify(mixedJoin));

  const comments = freezeTool.analyzeDependencyReferences('guards/comments.cjs', [
    "const text = \"require('./fake')\";",
    "// require('./comment')",
    "/* import('./blocked.js') */",
    "require('./helper');",
  ].join('\n'));
  check('R2 comments and string literals do not create fake dependencies',
    comments.unresolved.length === 0 && comments.references.length === 1 &&
      comments.references[0].candidates.includes('guards/helper.js') &&
      !JSON.stringify(comments).includes('fake') && !JSON.stringify(comments).includes('comment') && !JSON.stringify(comments).includes('blocked'),
    JSON.stringify(comments));

  const nodeSelf = freezeTool.analyzeDependencyReferences('guards/self.cjs', 'require(__filename);');
  check('dynamic closure binds require(__filename) to current source identity, not dependencies[]',
    nodeSelf.references.length === 0 && nodeSelf.unresolved.length === 0 && nodeSelf.sourceBindings.length === 1 &&
      nodeSelf.sourceBindings[0].target === 'guards/self.cjs' && nodeSelf.sourceBindings[0].expression === 'require(__filename)',
    JSON.stringify(nodeSelf));

  const shellExact = freezeTool.analyzeDependencyReferences('guards/self-exact.sh', 'SELF="${BASH_SOURCE[0]}"\nbash "$SELF" --self-test\n');
  check('dynamic closure conservatively rejects even apparent direct shell self variable without shell syntax/control-flow proof',
    shellExact.sourceBindings.length === 0 && shellExact.unresolved.some((x) => x.expression === '$SELF'),
    JSON.stringify(shellExact));

  const shellSelf = freezeTool.analyzeDependencyReferences('guards/self.sh', 'G="$HOME/.claude"\nSELF="$G/$(basename "${BASH_SOURCE[0]}")"\nbash "$SELF" --self-test\n');
  check('dynamic closure does not infer G-root plus basename equals current source',
    shellSelf.sourceBindings.length === 0 && shellSelf.unresolved.some((x) => x.expression === '$SELF'),
    JSON.stringify(shellSelf));

  const shellSuffix = freezeTool.analyzeDependencyReferences('guards/self-suffix.sh', 'SELF="${BASH_SOURCE[0]}.missing"\nbash "$SELF"\n');
  check('dynamic closure rejects BASH_SOURCE-containing suffix instead of treating substring as self',
    shellSuffix.sourceBindings.length === 0 && shellSuffix.unresolved.some((x) => x.expression === '$SELF'),
    JSON.stringify(shellSuffix));

  const reassignedSelf = freezeTool.analyzeDependencyReferences('guards/self-reassigned.sh', 'SELF="${BASH_SOURCE[0]}"\nSELF="./other.sh"\nbash "$SELF"\n');
  check('dynamic closure rejects reassigned self-like variable instead of guessing source identity',
    reassignedSelf.sourceBindings.length === 0 && reassignedSelf.unresolved.some((x) => x.expression === '$SELF'),
    JSON.stringify(reassignedSelf));

  const readSelf = freezeTool.analyzeDependencyReferences('guards/self-read.sh', 'SELF="${BASH_SOURCE[0]}"\nread SELF\nbash "$SELF"\n');
  const exportSelf = freezeTool.analyzeDependencyReferences('guards/self-export.sh', 'SELF="${BASH_SOURCE[0]}"\nexport SELF=./other.sh\nbash "$SELF"\n');
  check('dynamic closure treats read/export writes as self-binding invalidators',
    readSelf.sourceBindings.length === 0 && readSelf.unresolved.some((x) => x.expression === '$SELF') &&
    exportSelf.sourceBindings.length === 0 && exportSelf.unresolved.some((x) => x.expression === '$SELF'),
    JSON.stringify({ readSelf, exportSelf }));

  const shellZero = freezeTool.analyzeDependencyReferences('guards/receipt.sh', 'bash "$0" pending\n');
  check('dynamic closure keeps bash $0 unresolved without execution-entry proof',
    shellZero.sourceBindings.length === 0 && shellZero.unresolved.some((x) => x.expression === '$0'),
    JSON.stringify(shellZero));

  const dirnameOther = freezeTool.analyzeDependencyReferences('guards/dirname-other.sh', 'source "$(dirname "$OTHER")/missing.sh"\n');
  check('dynamic closure keeps full dirname-$OTHER expression unresolved instead of silently skipping it',
    dirnameOther.references.length === 0 && dirnameOther.sourceBindings.length === 0 &&
      dirnameOther.unresolved.some((x) => x.expression === '$(dirname "$OTHER")/missing.sh'),
    JSON.stringify(dirnameOther));

  const relativeEntry = freezeTool.analyzeDependencyReferences('guards/relative-entry.sh', 'source "$(dirname "$0")/helper.sh"\n');
  check('dynamic closure keeps dirname-$0 unresolved without execution-entry proof',
    relativeEntry.references.length === 0 && relativeEntry.sourceBindings.length === 0 &&
      relativeEntry.unresolved.some((x) => x.expression === '$(dirname "$0")/helper.sh'),
    JSON.stringify(relativeEntry));

  const nodeReassigned = freezeTool.analyzeDependencyReferences('guards/self-reassigned.cjs', '__filename="./missing.cjs";\nrequire(__filename);\n');
  const nodeShadowed = freezeTool.analyzeDependencyReferences('guards/self-shadowed.cjs', '(function(__filename){ require(__filename); })("./missing.cjs");\n');
  check('dynamic closure rejects assigned or scope-shadowed __filename source binding',
    nodeReassigned.sourceBindings.length === 0 && nodeReassigned.unresolved.some((x) => x.expression === 'require(__filename)') &&
    nodeShadowed.sourceBindings.length === 0 && nodeShadowed.unresolved.some((x) => x.expression === 'require(__filename)'),
    JSON.stringify({ nodeReassigned, nodeShadowed }));

  const falseClosureCases = [
    ['guards/dirname-other.sh', 'source "$(dirname "$OTHER")/missing.sh"\n'],
    ['guards/self-exact.sh', 'SELF="${BASH_SOURCE[0]}"\nbash "$SELF" --self-test\n'],
    ['guards/self-single-quoted.sh', "SELF='${BASH_SOURCE[0]}'\nbash \"$SELF\"\n"],
    ['guards/self-conditional.sh', 'if false; then\nSELF="${BASH_SOURCE[0]}"\nfi\nbash "$SELF"\n'],
    ['guards/self-inline-read.sh', 'SELF="${BASH_SOURCE[0]}"\ntrue; read SELF\nbash "$SELF"\n'],
    ['guards/self-suffix.sh', 'SELF="${BASH_SOURCE[0]}.missing"\nbash "$SELF"\n'],
    ['guards/self-reassigned.cjs', '__filename="./missing.cjs";\nrequire(__filename);\n'],
    ['guards/receipt.sh', 'bash "$0" pending\n'],
  ];
  for (const [rel, source] of falseClosureCases) {
    const oneMap = new Map([[rel, { path: rel, dependencies: [], unresolvedDependencies: [] }]]);
    const oneBlobs = new Map([[rel, Buffer.from(source)]]);
    let err = '';
    try { freezeTool.verifyDependencyClosure({ fileMap: oneMap, repoRoot: depRepo, commit: depCommit, relLive: '.claude', blobs: oneBlobs }); }
    catch (e) { err = e.code; }
    check('dynamic closure fail-closes real verifyDependencyClosure case: ' + rel, err === 'dependency-unresolved-dynamic', err);
  }

  const dynamicEntry = {
    path: 'guards/dynamic.sh', dependencies: [], unresolvedDependencies: [
      { expression: '$G/guards/$TARGET.sh', dependencies: [], reason: 'unknown runtime target must remain blocked until a dedicated dynamic schema proves it' },
    ],
  };
  const dynamicBlobs = new Map(blobs);
  dynamicBlobs.set(dynamicEntry.path, fs.readFileSync(path.join(depLive, ...dynamicEntry.path.split('/'))));

  const emptyReview = new Map(entries.concat([dynamicEntry]).map((x) => [x.path, Object.assign({}, x)]));
  let emptyReviewErr = '';
  try { freezeTool.verifyDependencyClosure({ fileMap: emptyReview, repoRoot: depRepo, commit: depCommit, relLive: '.claude', blobs: dynamicBlobs }); }
  catch (e) { emptyReviewErr = e.code; }
  check('dynamic unresolved dependency cannot use empty dependencies plus reason as closure evidence',
    emptyReviewErr === 'dependency-review-empty', emptyReviewErr);

  const noReview = new Map(entries.concat([Object.assign({}, dynamicEntry, { unresolvedDependencies: [] })]).map((x) => [x.path, Object.assign({}, x)]));
  let dynamicErr = '';
  try { freezeTool.verifyDependencyClosure({ fileMap: noReview, repoRoot: depRepo, commit: depCommit, relLive: '.claude', blobs: dynamicBlobs }); }
  catch (e) { dynamicErr = e.code; }
  check('dynamic unresolved dependency without a proven target remains fail-closed', dynamicErr === 'dependency-unresolved-dynamic', dynamicErr);

  const missingDeclared = new Map(entries.map((x) => [x.path, Object.assign({}, x, { dependencies: x.dependencies.slice() })]));
  missingDeclared.get('guards/main.cjs').dependencies = [];
  let edgeErr = '';
  try { freezeTool.verifyDependencyClosure({ fileMap: missingDeclared, repoRoot: depRepo, commit: depCommit, relLive: '.claude', blobs }); }
  catch (e) { edgeErr = e.code; }
  check('resolved dependency must be explicitly declared', edgeErr === 'dependency-edge-missing', edgeErr);


  // ---- G1 generated-artifact evidence: temp git repos only; artifact-verified != execution-closed. ----
  const genRepo = path.join(T, 'generated-repo');
  const genLive = path.join(genRepo, '.claude');
  fs.mkdirSync(path.join(genLive, 'guards'), { recursive: true });
  const genPath = 'guards/gen.sh';
  const helperPath = 'guards/helper.cjs';
  const genSource = [
    '#!/usr/bin/env bash',
    'tmp="$(mktemp)"',
    'cat > "$tmp" <<\'ART_EOF\'',
    "require('./helper.cjs');",
    "process.stdout.write('ok\\\\n');",
    'ART_EOF',
    'node "$tmp" "$1"',
    'rm -f "$tmp"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(genLive, ...genPath.split('/')), genSource);
  fs.writeFileSync(path.join(genLive, ...helperPath.split('/')), "module.exports = 1;\n");
  git(genRepo, ['init', '-q']);
  git(genRepo, ['add', '.claude']);
  git(genRepo, ['-c', 'user.name=G1', '-c', 'user.email=g1@example.invalid', 'commit', '-qm', 'generated fixture']);
  const genCommit = git(genRepo, ['rev-parse', 'HEAD']).trim();
  const genBlob = fs.readFileSync(path.join(genLive, ...genPath.split('/')));
  const helperBlob = fs.readFileSync(path.join(genLive, ...helperPath.split('/')));
  const genMap = new Map([
    [genPath, { path: genPath, dependencies: [], unresolvedDependencies: [] }],
    [helperPath, { path: helperPath, dependencies: [], unresolvedDependencies: [] }],
  ]);
  const genBlobs = new Map([[genPath, genBlob], [helperPath, helperBlob]]);
  const inspected = freezeTool.inspectLiteralGeneratedArtifact(genPath, genBlob, { variable: 'tmp', marker: 'ART_EOF' });
  const genRecord = {
    version: 1,
    id: 'fixture-artifact',
    generatorPath: genPath,
    generatorSha256: inspected.generatorSha256,
    heredoc: clone(inspected.heredoc),
    call: clone(inspected.call),
  };
  const verifiedArtifact = freezeTool.verifyGeneratedArtifactEvidence({
    record: genRecord, fileMap: genMap, repoRoot: genRepo, commit: genCommit, relLive: '.claude', blobs: genBlobs,
  });
  check('G1 literal heredoc artifact evidence verifies exact frozen bytes and generated-body dependency candidate',
    verifiedArtifact.status === 'artifact-verified' && verifiedArtifact.executionClosed === false &&
      verifiedArtifact.heredoc.bodyEndsWithLf === true &&
      verifiedArtifact.candidateSourceGraph.transitiveCandidates.some((x) => x.dependency === helperPath),
    JSON.stringify(verifiedArtifact));


  function g1VerifyCase(caseName, source, expectedError) {
    const slug = caseName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const caseRepo = path.join(T, 'g1r2-' + slug);
    const caseLive = path.join(caseRepo, '.claude');
    fs.mkdirSync(caseLive, { recursive: true });
    const casePath = 'gen.sh';
    fs.writeFileSync(path.join(caseLive, casePath), source);
    git(caseRepo, ['init', '-q']);
    git(caseRepo, ['add', '.claude']);
    git(caseRepo, ['-c', 'user.name=G1R2', '-c', 'user.email=g1r2@example.invalid', 'commit', '-qm', caseName]);
    const caseCommit = git(caseRepo, ['rev-parse', 'HEAD']).trim();
    const blob = fs.readFileSync(path.join(caseLive, casePath));
    const lines = source.split('\n');
    const body = Buffer.from("console.log('ok');\n");
    const callLine = Math.max(1, lines.findIndex((x, i) => i >= 3 && x.includes('node')) + 1);
    const callExpression = lines[callLine - 1] || '';
    const record = {
      version: 1,
      id: slug,
      generatorPath: casePath,
      generatorSha256: sha256(blob),
      heredoc: {
        variable: 'tmp', marker: 'END', startLine: 1, endLine: 3,
        bodyBytes: body.length, bodySha256: sha256(body), bodyEndsWithLf: true,
      },
      call: {
        line: callLine,
        expression: callExpression,
        lineSha256: sha256(Buffer.from(callExpression, 'utf8')),
      },
    };
    let err = '';
    try {
      freezeTool.verifyGeneratedArtifactEvidence({
        record,
        fileMap: new Map([[casePath, { path: casePath, dependencies: [], unresolvedDependencies: [] }]]),
        blobs: new Map([[casePath, blob]]),
        repoRoot: caseRepo, commit: caseCommit, relLive: '.claude',
      });
    } catch (e) { err = e.code || e.message; }
    check(caseName, err === expectedError, err);
  }

  const g1VerifyRejectCases = [
    ['G1-R2 full verify rejects single-quoted literal redirect target',
      ["cat > '$tmp' <<'END'", "console.log('ok');", 'END', 'node "$tmp"', ''].join('\n'),
      'generated-heredoc-not-literal'],
    ['G1-R2 full verify rejects comment-only node call',
      ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', '# node "$tmp"', ''].join('\n'),
      'generated-call-ambiguous'],
    ['G1-R2 full verify rejects generated-body-only node pseudo-call',
      ["cat > \"$tmp\" <<'END'", '// node "$tmp"', "console.log('ok');", 'END', ''].join('\n'),
      'generated-call-ambiguous'],
    ['G1-R2 full verify rejects node pseudo-call inside another heredoc',
      ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', "cat > \"$other\" <<'OTHER'", 'node "$tmp"', 'OTHER', ''].join('\n'),
      'generated-call-ambiguous'],
    ['G1-R2 full verify rejects echo node argument',
      ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'echo node "$tmp"', ''].join('\n'),
      'generated-call-ambiguous'],
    ['G1-R2 full verify rejects printf node argument',
      ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'printf "%s" node "$tmp"', ''].join('\n'),
      'generated-call-ambiguous'],
    ['G1-R2 full verify rejects test node argument',
      ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'test node "$tmp"', ''].join('\n'),
      'generated-call-ambiguous'],
    ['G1-R2 full verify rejects assignment text containing node target',
      ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', "x='node \"$tmp\"'", ''].join('\n'),
      'generated-call-ambiguous'],
    ['G1-R2 full verify rejects node text in redirection operand/argument position',
      ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'echo ok > node "$tmp"', ''].join('\n'),
      'generated-call-ambiguous'],
    ['G1-R6 full verify rejects cross-line quoted node text as non-call',
      ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'echo "node', '$tmp"', ''].join('\n'),
      'generated-call-ambiguous'],
  ];
  for (const [name, source, expected] of g1VerifyRejectCases) g1VerifyCase(name, source, expected);

  function g1VerifyAcceptCase(kind, source) {
    const caseRepo = path.join(T, 'g1r2-ok-' + kind);
    const caseLive = path.join(caseRepo, '.claude');
    fs.mkdirSync(caseLive, { recursive: true });
    const casePath = 'gen.sh';
    fs.writeFileSync(path.join(caseLive, casePath), source);
    git(caseRepo, ['init', '-q']);
    git(caseRepo, ['add', '.claude']);
    git(caseRepo, ['-c', 'user.name=G1R2', '-c', 'user.email=g1r2@example.invalid', 'commit', '-qm', 'ok ' + kind]);
    const commitOk = git(caseRepo, ['rev-parse', 'HEAD']).trim();
    const blob = fs.readFileSync(path.join(caseLive, casePath));
    let verified = null, err = '';
    try {
      const inspectedOk = freezeTool.inspectLiteralGeneratedArtifact(casePath, blob, { variable: 'tmp', marker: 'END' });
      const recordOk = {
        version: 1, id: 'ok-' + kind, generatorPath: casePath, generatorSha256: inspectedOk.generatorSha256,
        heredoc: clone(inspectedOk.heredoc), call: clone(inspectedOk.call),
      };
      verified = freezeTool.verifyGeneratedArtifactEvidence({
        record: recordOk,
        fileMap: new Map([[casePath, { path: casePath, dependencies: [], unresolvedDependencies: [] }]]),
        blobs: new Map([[casePath, blob]]),
        repoRoot: caseRepo, commit: commitOk, relLive: '.claude',
      });
    } catch (e) { err = e.code || e.message; }
    check('G1-R2 full verify accepts supported command-position form: ' + kind,
      !!verified && verified.status === 'artifact-verified' && verified.executionClosed === false,
      err || JSON.stringify(verified));
  }

  const g1LegalCalls = [
    ['plain', ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'node "$tmp" "$1"', ''].join('\n')],
    ['escaped-command', ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', '\\node "$tmp"', ''].join('\n')],
    ['backslash-newline', ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'node \\', '"$tmp"', ''].join('\n')],
    ['pipeline', ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'printf "%s" "$x" | node "$tmp" "$arg"', ''].join('\n')],
    ['command-substitution', ["cat > \"$tmp\" <<'END'", "console.log('ok');", 'END', 'out="$(node "$tmp" "$arg" 2>/dev/null)"', ''].join('\n')],
  ];
  for (const [kind, source] of g1LegalCalls) g1VerifyAcceptCase(kind, source);

  let hashErr = '';
  try {
    const bad = clone(genRecord); bad.generatorSha256 = '0'.repeat(64);
    freezeTool.verifyGeneratedArtifactEvidence({ record: bad, fileMap: genMap, repoRoot: genRepo, commit: genCommit, relLive: '.claude', blobs: genBlobs });
  } catch (e) { hashErr = e.code; }
  check('G1 wrong generator source hash is rejected', hashErr === 'generated-generator-hash-mismatch', hashErr);

  let callErr = '';
  try {
    const bad = clone(genRecord); bad.call.expression += ' --wrong';
    freezeTool.verifyGeneratedArtifactEvidence({ record: bad, fileMap: genMap, repoRoot: genRepo, commit: genCommit, relLive: '.claude', blobs: genBlobs });
  } catch (e) { callErr = e.code; }
  check('G1 call anchor mismatch is rejected', callErr === 'generated-call-evidence-mismatch', callErr);

  const expandedSource = [
    'tmp="$(mktemp)"',
    'cat > "$tmp" <<ART_EOF',
    "process.stdout.write('x');",
    'ART_EOF',
    'node "$tmp"',
    '',
  ].join('\n');
  let expandedErr = '';
  try { freezeTool.inspectLiteralGeneratedArtifact(genPath, Buffer.from(expandedSource), { variable: 'tmp', marker: 'ART_EOF' }); }
  catch (e) { expandedErr = e.code; }
  check('G1 expanding/unquoted heredoc is rejected', expandedErr === 'generated-heredoc-not-literal', expandedErr);

  const duplicateSource = [
    'tmp="$(mktemp)"',
    'cat > "$tmp" <<\'ART_EOF\'',
    "process.stdout.write('a');",
    'ART_EOF',
    'cat > "$tmp" <<\'ART_EOF\'',
    "process.stdout.write('b');",
    'ART_EOF',
    'node "$tmp"',
    '',
  ].join('\n');
  let duplicateErr = '';
  try { freezeTool.inspectLiteralGeneratedArtifact(genPath, Buffer.from(duplicateSource), { variable: 'tmp', marker: 'ART_EOF' }); }
  catch (e) { duplicateErr = e.code; }
  check('G1 duplicate heredoc marker definition is rejected', duplicateErr === 'generated-heredoc-ambiguous', duplicateErr);

  const missingMarkerSource = [
    'tmp="$(mktemp)"',
    'cat > "$tmp" <<\'ART_EOF\'',
    "process.stdout.write('a');",
    'node "$tmp"',
    '',
  ].join('\n');
  let missingMarkerErr = '';
  try { freezeTool.inspectLiteralGeneratedArtifact(genPath, Buffer.from(missingMarkerSource), { variable: 'tmp', marker: 'ART_EOF' }); }
  catch (e) { missingMarkerErr = e.code; }
  check('G1 missing heredoc close marker is rejected', missingMarkerErr === 'generated-heredoc-ambiguous', missingMarkerErr);

  fs.writeFileSync(path.join(genLive, ...genPath.split('/')), genSource.replace("ok\\\\n", "changed\\\\n"));
  git(genRepo, ['add', '.claude']);
  git(genRepo, ['-c', 'user.name=G1', '-c', 'user.email=g1@example.invalid', 'commit', '-qm', 'mutated generated body']);
  const genCommit2 = git(genRepo, ['rev-parse', 'HEAD']).trim();
  const genBlob2 = fs.readFileSync(path.join(genLive, ...genPath.split('/')));
  const genBlobs2 = new Map([[genPath, genBlob2], [helperPath, helperBlob]]);
  let bodyErr = '';
  try {
    const staleBody = clone(genRecord);
    staleBody.generatorSha256 = sha256(genBlob2);
    freezeTool.verifyGeneratedArtifactEvidence({ record: staleBody, fileMap: genMap, repoRoot: genRepo, commit: genCommit2, relLive: '.claude', blobs: genBlobs2 });
  } catch (e) { bodyErr = e.code; }
  check('G1 generated body mutation is rejected even when generator hash field is refreshed',
    bodyErr === 'generated-heredoc-evidence-mismatch', bodyErr);

  const missRepo = path.join(T, 'generated-missing-dep-repo');
  const missLive = path.join(missRepo, '.claude');
  fs.mkdirSync(path.join(missLive, 'guards'), { recursive: true });
  const missSource = [
    'tmp="$(mktemp)"',
    'cat > "$tmp" <<\'MISS_EOF\'',
    "require('./missing.cjs');",
    'MISS_EOF',
    'node "$tmp"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(missLive, 'guards', 'gen.sh'), missSource);
  git(missRepo, ['init', '-q']); git(missRepo, ['add', '.claude']);
  git(missRepo, ['-c', 'user.name=G1', '-c', 'user.email=g1@example.invalid', 'commit', '-qm', 'missing dep fixture']);
  const missCommit = git(missRepo, ['rev-parse', 'HEAD']).trim();
  const missBlob = fs.readFileSync(path.join(missLive, 'guards', 'gen.sh'));
  const missInspected = freezeTool.inspectLiteralGeneratedArtifact('guards/gen.sh', missBlob, { variable: 'tmp', marker: 'MISS_EOF' });
  const missRecord = { version: 1, id: 'missing-dep', generatorPath: 'guards/gen.sh', generatorSha256: missInspected.generatorSha256, heredoc: clone(missInspected.heredoc), call: clone(missInspected.call) };
  let generatedDepErr = '';
  try {
    freezeTool.verifyGeneratedArtifactEvidence({
      record: missRecord,
      fileMap: new Map([['guards/gen.sh', { path: 'guards/gen.sh', dependencies: [], unresolvedDependencies: [] }]]),
      repoRoot: missRepo, commit: missCommit, relLive: '.claude',
      blobs: new Map([['guards/gen.sh', missBlob]]),
    });
  } catch (e) { generatedDepErr = e.code; }
  check('G1 generated content missing static dependency is rejected', generatedDepErr === 'generated-dependency-unresolved', generatedDepErr);

  let escapeErr = '';
  try {
    const bad = clone(genRecord); bad.generatorPath = '../escape.sh';
    freezeTool.verifyGeneratedArtifactEvidence({ record: bad, fileMap: genMap, repoRoot: genRepo, commit: genCommit, relLive: '.claude', blobs: genBlobs });
  } catch (e) { escapeErr = e.code; }
  check('G1 generator path escape is rejected', escapeErr === 'bad-file-path', escapeErr);

  const syRepo = path.join(T, 'generated-symlink-repo');
  fs.mkdirSync(path.join(syRepo, '.claude', 'guards'), { recursive: true });
  git(syRepo, ['init', '-q']);
  const syTarget = 'guards/real.sh\n';
  const syOid = cp.execFileSync('git', ['-C', syRepo, 'hash-object', '-w', '--stdin'], { input: syTarget, encoding: 'utf8' }).trim();
  git(syRepo, ['update-index', '--add', '--cacheinfo', '120000', syOid, '.claude/guards/link.sh']);
  git(syRepo, ['-c', 'user.name=G1', '-c', 'user.email=g1@example.invalid', 'commit', '-qm', 'symlink fixture']);
  const syCommit = git(syRepo, ['rev-parse', 'HEAD']).trim();
  let syErr = '';
  try {
    const bad = clone(genRecord);
    bad.generatorPath = 'guards/link.sh';
    bad.generatorSha256 = sha256(Buffer.from(syTarget));
    freezeTool.verifyGeneratedArtifactEvidence({
      record: bad,
      fileMap: new Map([['guards/link.sh', { path: 'guards/link.sh', dependencies: [], unresolvedDependencies: [] }]]),
      repoRoot: syRepo, commit: syCommit, relLive: '.claude',
      blobs: new Map([['guards/link.sh', Buffer.from(syTarget)]]),
    });
  } catch (e) { syErr = e.code; }
  check('G1 frozen generator symlink is rejected before artifact extraction', syErr === 'generated-generator-symlink', syErr);

  let formalGeneratedErr = '';
  try {
    freezeTool.verifyDependencyClosure({
      fileMap: genMap, repoRoot: genRepo, commit: genCommit, relLive: '.claude', blobs: genBlobs,
      generatedArtifacts: [genRecord],
    });
  } catch (e) { formalGeneratedErr = e.code; }
  check('G1 artifact-verified evidence alone does not mark formal execution dependency closed',
    formalGeneratedErr === 'dependency-unresolved-dynamic', formalGeneratedErr);

  const fixtureCommands = freeze.hooks.map((h) => h.command).join('\n');
  check('machine acceptance executes no network-capable fixture commands',
    !/(?:curl|wget|Invoke-WebRequest|https?:\/\/)/i.test(fixtureCommands), fixtureCommands);
} catch (e) {
  console.error(e && e.stack || e);
  fail++;
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

console.log('P2-MACHINE-ACCEPTANCE ' + JSON.stringify({ pass, fail }));
process.exit(fail ? 1 : 0);
