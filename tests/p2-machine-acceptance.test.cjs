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
function localHookIdentity(h) {
  return JSON.stringify([h.event, h.groupIndex, h.hookIndex, h.matcher === undefined ? null : h.matcher, h.command, h.timeout === undefined ? null : h.timeout]);
}
function settingsForHooks(hooks) {
  const events = {};
  for (const h of hooks) {
    if (!events[h.event]) events[h.event] = [];
    if (!events[h.event][h.groupIndex]) events[h.event][h.groupIndex] = { matcher: h.matcher === undefined ? null : h.matcher, hooks: [] };
    events[h.event][h.groupIndex].hooks[h.hookIndex] = { type: 'command', command: h.command, timeout: h.timeout };
  }
  for (const [event, groups] of Object.entries(events)) {
    if (groups.some((x) => !x) || groups.some((g) => g.hooks.some((x) => !x))) throw new Error('sparse synthetic hook settings for ' + event);
  }
  return { hooks: events };
}

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
  const badSyntaxShAbs = path.join(live, 'guards', 'bad-syntax.sh');
  fs.writeFileSync(badSyntaxShAbs, '#!/usr/bin/env bash\nif then\n');
  git(repo, ['init', '-q']);
  git(repo, ['add', '.claude']);
  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'fixture']);
  const commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const treeOid = git(repo, ['rev-parse', 'HEAD:.claude']).trim();
  const hookRel = 'guards/hook.cjs';
  const command = 'node "' + hookAbs.replace(/\\/g, '/') + '"';
  const sourceFiles = [{ path: hookRel, sha256: sha256(fs.readFileSync(hookAbs)), disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'fixture' }];
  let bindSeq = 0;
  function bindFreeze(raw, label) {
    const out = clone(raw);
    out.hooks = (out.hooks || []).map((h) => Object.assign({}, h, {
      files: clone(h.files || []), implementation: h.implementation || null, notes: h.notes || '',
      externalDependencies: clone(h.externalDependencies || []), businessExitCodes: clone(h.businessExitCodes || []),
      runtimeHealthProbe: h.runtimeHealthProbe ? clone(h.runtimeHealthProbe) : null,
    }));
    const seq = ++bindSeq;
    const mirrorRel = 'memory/_local-config/r15b-' + String(seq).padStart(3, '0') + '-' + label + '.json';
    const mirrorAbs = path.join(live, ...mirrorRel.split('/'));
    const settings = settingsForHooks(out.hooks || []);
    const mirrorBytes = Buffer.from(JSON.stringify(settings, null, 2) + '\n');
    fs.mkdirSync(path.dirname(mirrorAbs), { recursive: true });
    fs.writeFileSync(mirrorAbs, mirrorBytes);
    out.sourceFiles = (out.sourceFiles || []).filter((x) => x.path !== mirrorRel).map((x) => {
      const abs = path.join(live, ...x.path.split('/'));
      return fs.existsSync(abs) ? Object.assign({}, x, { sha256: sha256(fs.readFileSync(abs)) }) : x;
    });
    out.sourceFiles.push({ path: mirrorRel, sha256: sha256(mirrorBytes), disposition: 'private-exclude', dependencies: [], unresolvedDependencies: [], notes: 'synthetic tracked settings mirror' });
    const externalIds = [...new Set((out.hooks || []).flatMap((h) => Array.isArray(h.externalDependencies) ? h.externalDependencies : []))];
    const inventory = {
      version: 1,
      hooks: (out.hooks || []).map((h) => ({
        event: h.event, groupIndex: h.groupIndex, hookIndex: h.hookIndex,
        matcher: h.matcher === undefined ? null : h.matcher, command: h.command,
        timeout: h.timeout === undefined ? null : h.timeout,
        disposition: h.disposition, files: clone(h.files || []), implementation: h.implementation || null,
        notes: h.notes || '', externalDependencies: clone(h.externalDependencies || []),
        businessExitCodes: clone(h.businessExitCodes || []), runtimeHealthProbe: h.runtimeHealthProbe ? clone(h.runtimeHealthProbe) : null,
      })),
      files: (out.sourceFiles || []).map((f) => ({ path: f.path, disposition: f.disposition || 'port', dependencies: clone(f.dependencies || []), unresolvedDependencies: clone(f.unresolvedDependencies || []), notes: f.notes || 'synthetic source file' })),
      externalDependencies: externalIds.map((id) => ({ id, kind: 'command', command: 'synthetic-external-' + id, notes: 'machine-acceptance external prerequisite fixture' })),
      generatedArtifacts: [],
      allowedDifferences: [],
      auditEvidence: ['machine-acceptance synthetic inventory'],
    };
    const inventoryRel = 'r15b-inventory-' + String(seq).padStart(3, '0') + '-' + label + '.json';
    const inventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2) + '\n');
    fs.writeFileSync(path.join(repo, inventoryRel), inventoryBytes);
    git(repo, ['add', '--', '.claude/' + mirrorRel, inventoryRel]);
    git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'bind freeze ' + label + ' ' + seq]);
    out.source.commit = git(repo, ['rev-parse', 'HEAD']).trim();
    out.source.treeOid = git(repo, ['rev-parse', 'HEAD:.claude']).trim();
    out.inventoryCommit = out.source.commit;
    out.inventoryPath = inventoryRel;
    out.inventorySha256 = sha256(inventoryBytes);
    out.settingsEvidence = {
      livePath: 'settings.json', liveSha256: sha256(mirrorBytes), mirrorPath: mirrorRel,
      mirrorSha256: sha256(mirrorBytes), hookIdentitySha256: sha256(Buffer.from((out.hooks || []).map(localHookIdentity).join('\n'), 'utf8')),
    };
    return out;
  }
  const rh = (logicalId, event, matcher, hookIndex) => ({
    logicalId, event, groupIndex: 0, hookIndex, matcher, command, timeout: 5,
    disposition: 'port', files: [hookRel], implementation: null, notes: 'temp fixture runnable', externalDependencies: [],
    businessExitCodes: [2],
    runtimeHealthProbe: { version: 1, innerCommand: command, reliable: true, notes: 'reviewed exact inner command; case-specific branches remain observable to the inner execution' },
  });
  const freeze = bindFreeze({
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
  }, 'base');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'p2-equiv', 'events.json'), 'utf8'));

  let emptyFixtureErr = '';
  try { runner.runFreezeReport({ freeze, fixture: { version: 1, events: [] }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live }); }
  catch (e) { emptyFixtureErr = e.message; }
  check('runner rejects empty fixture', /non-empty events/.test(emptyFixtureErr), emptyFixtureErr);

  let partialFixtureErr = '';
  try { runner.runFreezeReport({ freeze, fixture: { version: 1, events: [{ event: 'Bash', cases: [{ id: 'b1' }] }] }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live }); }
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
  const reportA = runner.runFreezeReport({ freeze, fixture, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live });
  const reportB = runner.runFreezeReport({ freeze, fixture, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live });
  if (prior === undefined) delete process.env.PMM_MEM_DIR; else process.env.PMM_MEM_DIR = prior;
  check('runner emits full 21-case baseline', reportA.cases.length === 21 && reportA.fixtureCoverage.caseCount === 21);
  check('runner keeps writes inside temp sandbox despite inherited PMM path', !fs.existsSync(escape));
  check('runner leaves fixture git source clean', git(repo, ['status', '--porcelain', '--', '.claude']).trim() === '');
  const same = equiv.compareReports(reportA, reportB, []);
  check('full baseline compares green', same.equal === true && same.unexpected.length === 0);

  // R15d S1: report-declared normalization prefixes must be bound to runner-recorded sandboxes.
  const s1PrefixLeft = clone(reportA);
  const s1PrefixRight = clone(reportA);
  s1PrefixLeft.cases[0].stdout = 'DENY';
  s1PrefixRight.cases[0].stdout = 'ALLOW';
  s1PrefixRight.normalization.pathPrefixes = ['DENY', 'ALLOW'];
  let s1PrefixErr = null, s1PrefixCompare = null;
  try { s1PrefixCompare = equiv.compareReports(s1PrefixLeft, s1PrefixRight, []); } catch (e) { s1PrefixErr = e; }
  check('R15d S1 rejects report-declared non-sandbox normalization prefixes before comparison',
    s1PrefixErr && s1PrefixErr.code === 'report-normalization-path-prefix-invalid' && s1PrefixErr.detail && s1PrefixErr.detail.prefix === 'DENY',
    JSON.stringify({ errorCode: s1PrefixErr && s1PrefixErr.code, detail: s1PrefixErr && s1PrefixErr.detail, compareEqual: s1PrefixCompare && s1PrefixCompare.equal, prefixes: s1PrefixRight.normalization.pathPrefixes }));

  // R15b B1: bind each report case to the original fixture input, not a hook payload.
  const fixtureInputs = new Map();
  for (const eventGroup of fixture.events) for (const fixtureCase of eventGroup.cases) fixtureInputs.set(fixtureCase.id, fixtureCase.input || {});
  const b1AllBound = reportA.cases.every((c) => {
    const canonical = JSON.stringify(equiv.stable(fixtureInputs.get(c.id) || {}));
    return c.inputCanonical === canonical && c.inputSha256 === sha256(Buffer.from(canonical, 'utf8'));
  });
  check('R15b B1 report cases bind canonical original fixture input with SHA-256', b1AllBound);

  const b1Different = clone(reportA);
  const b1Target = b1Different.cases.find((c) => c.event === 'UserPromptSubmit') || b1Different.cases[0];
  b1Target.inputCanonical = JSON.stringify(equiv.stable({ prompt: 'r15b-b1-different-prompt' }));
  b1Target.inputSha256 = sha256(Buffer.from(b1Target.inputCanonical, 'utf8'));
  const b1Compare = equiv.compareReports(reportA, b1Different, []);
  check('R15b B1 same case id with different fixture input cannot compare green',
    b1Compare.equal === false && b1Compare.unexpected.some((d) => d.caseId === b1Target.id && d.field === 'inputSha256'),
    JSON.stringify(b1Compare.unexpected));

  let b1MissingHashErr = null;
  try {
    const l = clone(reportA), r = clone(reportA);
    delete l.cases[0].inputSha256; delete r.cases[0].inputSha256;
    equiv.compareReports(l, r, []);
  } catch (e) { b1MissingHashErr = e; }
  check('R15b B1 deleting inputSha256 on both sides is rejected',
    b1MissingHashErr && b1MissingHashErr.code === 'report-case-input-binding' && b1MissingHashErr.detail && b1MissingHashErr.detail.field === 'inputSha256',
    String(b1MissingHashErr && b1MissingHashErr.message));

  let b1TamperErr = null;
  try {
    const l = clone(reportA), r = clone(reportA);
    l.cases[0].inputCanonical = '{"tampered":true}';
    r.cases[0].inputCanonical = '{"tampered":true}';
    equiv.compareReports(l, r, []);
  } catch (e) { b1TamperErr = e; }
  check('R15b B1 canonical input tamper without matching hash is rejected',
    b1TamperErr && b1TamperErr.code === 'report-case-input-binding' && b1TamperErr.detail && b1TamperErr.detail.field === 'inputSha256',
    String(b1TamperErr && b1TamperErr.message));

  // R15b B2: raw types are validated before normalizeCase can coerce them.
  const b2Reject = (label, mutate, expectedCode, expectedField) => {
    const l = clone(reportA), r = clone(reportA);
    mutate(l.cases[0]); mutate(r.cases[0]);
    let err = null;
    try { equiv.compareReports(l, r, []); } catch (e) { err = e; }
    check('R15b B2 rejects ' + label,
      err && err.code === expectedCode && err.detail && err.detail.field === expectedField,
      JSON.stringify({ code: err && err.code, detail: err && err.detail }));
  };
  for (const [name, value] of [['null', null], ['empty-string', ''], ['false', false], ['array', []], ['string-zero', '0']]) {
    b2Reject('case.exitCode=' + name, (c) => { c.exitCode = value; }, 'report-case-field-type', 'exitCode');
    b2Reject('executedHooks=' + name, (c) => { c.executedHooks = value; }, 'report-case-field-type', 'executedHooks');
    b2Reject('hook.exitCode=' + name, (c) => { c.hookResults.find((h) => h.status === 'ran').exitCode = value; }, 'report-hook-field-type', 'exitCode');
  }
  b2Reject('missing stdout field', (c) => { delete c.stdout; }, 'report-case-field-type', 'stdout');
  b2Reject('renamed stderr field', (c) => { c.stderrRenamed = c.stderr; delete c.stderr; }, 'report-case-field-type', 'stderr');
  b2Reject('case exit inconsistent with first nonzero hook', (c) => { c.exitCode = 2; }, 'report-case-exit-mismatch', 'exitCode');

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
  const deny = runner.runCase({ freeze, group: focusedGroup, c: focusedCase, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  check('runner classifies exit2 as legal business deny', deny.exitCode === 2 && deny.hookResults.some((h) => h.status === 'ran' && h.exitCode === 2 && h.outcome === 'deny'));

  // R15b A1/A3/A4/A5/A8 hardening. These cases use the pre-existing runCase/rewriteSourceRoot API
  // so the same tests exercise 765c159 behavior instead of failing on a missing new export.
  const toMsys = (p) => {
    const s = String(p).replace(/\\/g, '/');
    const m = /^([A-Za-z]):\/(.*)$/.exec(s);
    return m ? '/' + m[1].toLowerCase() + '/' + m[2] : s;
  };
  const a1Rel = 'guards/r15b-a1-marker.cjs';
  const a2Rel = 'guards/r15b-a2-env.cjs';
  const a3Rel = 'guards/r15b-a3-marker.cjs';
  const a5Rel = 'guards/r15b-a5-state.cjs';
  const a7Rel = 'guards/r15b-a7-output.cjs';
  const a1Abs = path.join(live, ...a1Rel.split('/'));
  const a2Abs = path.join(live, ...a2Rel.split('/'));
  const a3Abs = path.join(live, ...a3Rel.split('/'));
  const a5Abs = path.join(live, ...a5Rel.split('/'));
  const a7Abs = path.join(live, ...a7Rel.split('/'));
  const a3Marker = path.join(T, 'r15b-a3-hook-executed.marker');
  fs.writeFileSync(a1Abs, "'use strict';const fs=require('fs'),path=require('path');fs.writeFileSync(path.join(__dirname,'r15b-a1.marker'),'sandbox-only');\n");
  fs.writeFileSync(a2Abs, [
    "'use strict';",
    "const cp=require('child_process');",
    "const run=(args)=>{const r=cp.spawnSync('git',args,{encoding:'utf8'});return {status:r.status,stdout:String(r.stdout||'').trim(),stderr:String(r.stderr||'').trim()};};",
    "const env=process.env;",
    "console.log(JSON.stringify({",
    "  HOME:env.HOME,USERPROFILE:env.USERPROFILE,HOMEDRIVE:env.HOMEDRIVE,HOMEPATH:env.HOMEPATH,",
    "  APPDATA:env.APPDATA,LOCALAPPDATA:env.LOCALAPPDATA,XDG_CONFIG_HOME:env.XDG_CONFIG_HOME,XDG_DATA_HOME:env.XDG_DATA_HOME,",
    "  XDG_STATE_HOME:env.XDG_STATE_HOME,XDG_CACHE_HOME:env.XDG_CACHE_HOME,HERMES_HOME:env.HERMES_HOME,TEMP:env.TEMP,TMP:env.TMP,TMPDIR:env.TMPDIR,",
    "  CLAUDE_CONFIG_DIR:env.CLAUDE_CONFIG_DIR,CLAUDE_SESSION_ID:env.CLAUDE_SESSION_ID,CLAUDE_CODE_SESSION_ID:env.CLAUDE_CODE_SESSION_ID,",
    "  BASH_ENV:Object.keys(env).find(k=>k.toLowerCase()==='bash_env')||null,NODE_OPTIONS:env.NODE_OPTIONS||null,NODE_PATH:env.NODE_PATH||null,",
    "  inherited:Object.fromEntries(['CLAUDE_HOME','CLAUDE_PROJECT_DIR','CLAUDE_CONFIG_DIR','CLAUDECODE','OneDrive','HERMES_CONFIG_PATH','GIT_TRACE2_EVENT','NODE_V8_COVERAGE','NODE_COMPILE_CACHE','NODE_PATH'].map(n=>{const k=Object.keys(env).find(x=>x.toLowerCase()===n.toLowerCase());return [n,k?env[k]:null];})),",
    "  gitVersion:run(['--version']),hooksPath:run(['config','core.hooksPath']),gitTop:run(['rev-parse','--show-toplevel']),",
    "  pathKeys:Object.keys(env).filter(k=>k.toLowerCase()==='path'),PATH:env.PATH||''",
    "}));",
    '',
  ].join('\n'));
  fs.writeFileSync(a3Abs, "'use strict';require('fs').writeFileSync(" + JSON.stringify(a3Marker.replace(/\\/g, '/')) + ",'executed');\n");
  fs.writeFileSync(a5Abs, [
    "'use strict';",
    "const fs=require('fs'),path=require('path');",
    "const j=JSON.parse(fs.readFileSync(0,'utf8'));",
    "let b;",
    "if(j.prompt==='b80') b=Buffer.from([0x80]);",
    "else if(j.prompt==='b81') b=Buffer.from([0x81]);",
    "else if(j.prompt==='bom') b=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('same','utf8')]);",
    "else if(j.prompt==='nobom') b=Buffer.from('same','utf8');",
    "else b=Buffer.concat([Buffer.from(String(process.env.HOME).replace(/\\\\/g,'/')+'\\n','latin1'),Buffer.from([0x80])]);",
    "fs.writeFileSync(path.join(process.env.HOME,'r15b-a5-state.bin'),b);",
    '',
  ].join('\n'));
  fs.writeFileSync(a7Abs, "'use strict';process.stdout.write(process.argv[2]==='crlf'?'x\\r\\n':'x\\n');\n");
  git(repo, ['add', '--', '.claude/' + a1Rel, '.claude/' + a2Rel, '.claude/' + a3Rel, '.claude/' + a5Rel, '.claude/' + a7Rel]);
  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'r15b hardening fixtures']);
  const sourceRow = (rel) => ({ path: rel, sha256: sha256(fs.readFileSync(path.join(live, ...rel.split('/')))), disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'R15b hardening fixture' });
  const bindSingle = (baseIndex, label, command, files, extra) => {
    const raw = clone(freeze);
    const h = Object.assign({}, raw.hooks[baseIndex], extra || {}, { command, files: clone(files) });
    h.runtimeHealthProbe = Object.assign({}, h.runtimeHealthProbe || { version: 1, reliable: true, notes: 'R15b exact inner' }, { version: 1, innerCommand: command, reliable: true, notes: 'R15b exact inner' });
    raw.hooks = [h];
    raw.sourceFiles = files.map(sourceRow);
    return bindFreeze(raw, label);
  };

  const a1Sandbox = path.join(T, 'r15b-a1-sandbox', '.claude');
  const liveLower = live.replace(/\\/g, '/').toLowerCase();
  const rewrittenCase = runner.rewriteSourceRoot('node "' + liveLower + '/guards/hook.cjs"', live, a1Sandbox);
  check('R15b A1 rewrites case-different spelling of the same source root', rewrittenCase.toLowerCase().includes(a1Sandbox.replace(/\\/g, '/').toLowerCase()) && !rewrittenCase.toLowerCase().includes(liveLower));
  const msysLive = toMsys(live);
  const rewrittenMsys = runner.rewriteSourceRoot('node "' + msysLive + '/guards/hook.cjs"', live, a1Sandbox);
  check('R15b A1 rewrites /c/ source-root spelling', !rewrittenMsys.includes(msysLive) && /guards\/hook\.cjs/.test(rewrittenMsys.replace(/\\/g, '/')));
  let zeroRewriteErr = null;
  try { runner.rewriteSourceRoot('printf no-reviewed-root', live, a1Sandbox); } catch (e) { zeroRewriteErr = e; }
  check('R15b A1 rejects commands with zero source-root replacements', zeroRewriteErr && zeroRewriteErr.code === 'source-root-rewrite-zero' && zeroRewriteErr.detail && zeroRewriteErr.detail.sourceRoot === live, String(zeroRewriteErr && zeroRewriteErr.message));
  const residualHealth = typeof runner.sourceRootResidual === 'function' && runner.sourceRootResidual('x ' + msysLive + '/guards/hook.cjs', live) === true;
  check('R15b A1 independent residual detector recognizes /c/ spelling', residualHealth);
  const cygLive = msysLive.replace(/^\/([A-Za-z])\//, '/cygdrive/$1/');
  const rewrittenCyg = runner.rewriteSourceRoot('node "' + cygLive + '/guards/hook.cjs"', live, a1Sandbox);
  check('R15b A1 rewrites /cygdrive/c/ source-root spelling', !rewrittenCyg.includes(cygLive) && /guards\/hook\.cjs/.test(rewrittenCyg.replace(/\\/g, '/')));
  check('R15b A1 residual detector handles cygdrive and mixed slash spellings', runner.sourceRootResidual('x ' + cygLive.replace(/\//g, '//') + '/guards/hook.cjs', live) === true);
  const a1Command = 'node "' + toMsys(a1Abs) + '"';
  const a1Freeze = bindSingle(4, 'a1-msys-marker', a1Command, [a1Rel]);
  const a1LiveMarker = path.join(path.dirname(a1Abs), 'r15b-a1.marker');
  try { fs.rmSync(a1LiveMarker, { force: true }); } catch {}
  const a1Run = runner.runCase({ freeze: a1Freeze, group: focusedGroup, c: { id: 'a1-marker', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  check('R15b A1 end-to-end hook executes only materialized sandbox copy', !fs.existsSync(a1LiveMarker) && Object.keys(a1Run.stateTree).some((k) => /guards\/r15b-a1\.marker$/.test(k.replace(/\\/g, '/'))));
  let sourceRootErr = null;
  try { runner.runCase({ freeze: a1Freeze, group: focusedGroup, c: { id: 'a1-root-mismatch', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: path.dirname(live), defaultTimeoutMs: 5000 }); } catch (e) { sourceRootErr = e; }
  check('R15b A1 --source-root must equal frozen liveRelativePath root', sourceRootErr && sourceRootErr.code === 'source-root-mismatch' && sourceRootErr.detail && sourceRootErr.detail.expected, String(sourceRootErr && sourceRootErr.message));

  const s1BashFuncKey = 'BASH_FUNC_node%%';
  const s1BashFuncBefore = process.env[s1BashFuncKey];
  const s1BashFuncHome = fs.mkdtempSync(path.join(T, 'r15d-s1-bash-func-home-'));
  let s1BashFuncRun = null;
  try {
    process.env[s1BashFuncKey] = '() { printf INHERITED_FUNCTION; }';
    const s1BashFuncEnv = runner.isolatedEnv(s1BashFuncHome, null);
    s1BashFuncRun = runner.runHook('node --version', {}, s1BashFuncEnv, s1BashFuncHome, 5000, []);
  } finally {
    if (s1BashFuncBefore === undefined) delete process.env[s1BashFuncKey]; else process.env[s1BashFuncKey] = s1BashFuncBefore;
    fs.rmSync(s1BashFuncHome, { recursive: true, force: true });
  }
  check('R15d S1 scrubs inherited BASH_FUNC_node%% before sandbox node --version executes',
    s1BashFuncRun && s1BashFuncRun.exitCode === 0 && /^v\d+\./.test(String(s1BashFuncRun.stdout || '').trim()) && !String(s1BashFuncRun.stdout || '').includes('INHERITED_FUNCTION'),
    JSON.stringify(s1BashFuncRun));

  const a2BashMarker = path.join(T, 'r15b-a2-bash-env.marker');
  const a2NodeMarker = path.join(T, 'r15b-a2-node-options.marker');
  const a2BashEnv = path.join(T, 'r15b-a2-bash-env.sh');
  const a2NodeRequire = path.join(T, 'r15b-a2-node-require.cjs');
  const a2GitConfig = path.join(T, 'r15b-a2-gitconfig');
  const a2Hooks = path.join(T, 'r15b-a2-hooks');
  const a2App = path.join(T, 'r15b-a2-appdata');
  fs.mkdirSync(a2Hooks, { recursive: true });
  fs.writeFileSync(a2BashEnv, 'printf touched > "' + a2BashMarker.replace(/\\/g, '/') + '"\n');
  fs.writeFileSync(a2NodeRequire, "require('fs').writeFileSync(" + JSON.stringify(a2NodeMarker.replace(/\\/g, '/')) + ",'loaded');\n");
  fs.writeFileSync(a2GitConfig, '[core]\n\thooksPath = ' + a2Hooks.replace(/\\/g, '/') + '\n');
  const a2LureRepo = path.join(T, 'r15b-a2-lure-repo');
  fs.mkdirSync(a2LureRepo, { recursive: true });
  git(a2LureRepo, ['init', '-q']);
  const r15dParentHome = path.join(T, 'r15d-s2a-parent-home');
  const r15dFakeBin = path.join(live, 'r15d-s2a-fake-bin');
  const r15dFakeCmd = path.join(r15dFakeBin, 'r15d-fakecmd');
  fs.mkdirSync(r15dParentHome, { recursive: true });
  fs.mkdirSync(r15dFakeBin, { recursive: true });
  fs.writeFileSync(r15dFakeCmd, '#!/usr/bin/env sh\\nprintf inherited-live-path\\n');
  try { fs.chmodSync(r15dFakeCmd, 0o755); } catch {}
  const parentEnvKeys = ['BASH_ENV','Bash_Env','NODE_OPTIONS','NODE_PATH','NODE_V8_COVERAGE','NODE_COMPILE_CACHE','APPDATA','LOCALAPPDATA','GIT_CONFIG_GLOBAL','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_TRACE2_EVENT','CLAUDE_CODE_FAKE','CLAUDE_HOME','CLAUDE_PROJECT_DIR','CLAUDE_CONFIG_DIR','CLAUDECODE','OneDrive','HERMES_CONFIG_PATH','PIPE_GATE_FAKE','HOME','USERPROFILE','PATH','TEMP','TMP'];
  const parentEnvBefore = Object.fromEntries(parentEnvKeys.map((k) => [k, process.env[k]]));
  process.env.Bash_Env = a2BashEnv;
  process.env.NODE_OPTIONS = '--require=' + a2NodeRequire;
  process.env.NODE_PATH = path.join(live, 'r15d-node-path');
  process.env.NODE_V8_COVERAGE = path.join(r15dParentHome, 'coverage');
  process.env.NODE_COMPILE_CACHE = path.join(repo, 'r15d-node-cache');
  process.env.APPDATA = a2App;
  process.env.LOCALAPPDATA = path.join(T, 'r15b-a2-localapp');
  process.env.GIT_CONFIG_GLOBAL = a2GitConfig;
  process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  process.env.GIT_CONFIG_VALUE_0 = a2Hooks;
  process.env.GIT_TRACE2_EVENT = path.join(repo, 'r15d-git-trace.json');
  process.env.CLAUDE_CODE_FAKE = 'must-be-removed';
  process.env.CLAUDE_HOME = r15dParentHome;
  process.env.CLAUDE_PROJECT_DIR = live;
  process.env.CLAUDE_CONFIG_DIR = path.join(repo, 'r15d-parent-claude-config');
  process.env.CLAUDECODE = path.join(live, 'r15d-claudecode');
  process.env.OneDrive = path.join(r15dParentHome, 'OneDrive');
  process.env.HERMES_CONFIG_PATH = path.join(live, 'r15d-hermes-config');
  process.env.PIPE_GATE_FAKE = 'must-be-removed';
  process.env.HOME = r15dParentHome;
  process.env.USERPROFILE = r15dParentHome;
  process.env.PATH = r15dFakeBin + ';' + String(parentEnvBefore.PATH || '');
  process.env.TEMP = a2LureRepo;
  process.env.TMP = a2LureRepo;
  const a2Command = 'command -v r15d-fakecmd || true; node "' + a2Abs.replace(/\\/g, '/') + '"';
  const a2Freeze = bindSingle(4, 'a2-env', a2Command, [a2Rel]);
  let a2Run;
  try {
    a2Run = runner.runCase({ freeze: a2Freeze, group: focusedGroup, c: { id: 'a2-env', input: { session_id: 'r15b-session' } }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  } finally {
    for (const k of parentEnvKeys) { if (parentEnvBefore[k] === undefined) delete process.env[k]; else process.env[k] = parentEnvBefore[k]; }
  }
  const a2JsonLine = a2Run.stdout.split(/\r?\n/).find((line) => line.startsWith('{') && line.endsWith('}'));
  const a2Observed = JSON.parse(a2JsonLine);
  check('R15b A2 scrubs mixed-case BASH_ENV and NODE_OPTIONS before real child processes execute', !fs.existsSync(a2BashMarker) && !fs.existsSync(a2NodeMarker) && a2Observed.BASH_ENV === null && a2Observed.NODE_OPTIONS === null && a2Observed.NODE_PATH === null, JSON.stringify(a2Observed));
  check('R15b A2 overwrites app/home/temp/XDG paths into the sandbox and preserves explicit session ids',
    [a2Observed.HOME,a2Observed.USERPROFILE,a2Observed.APPDATA,a2Observed.LOCALAPPDATA,a2Observed.XDG_CONFIG_HOME,a2Observed.XDG_DATA_HOME,a2Observed.XDG_STATE_HOME,a2Observed.XDG_CACHE_HOME,a2Observed.HERMES_HOME,a2Observed.TEMP,a2Observed.TMP,a2Observed.TMPDIR,a2Observed.CLAUDE_CONFIG_DIR].every((v) => typeof v === 'string' && v.includes('<ROOT>')) &&
    a2Observed.CLAUDE_SESSION_ID === 'r15b-session' && a2Observed.CLAUDE_CODE_SESSION_ID === 'r15b-session', JSON.stringify(a2Observed));
  check('R15b A2 preserves executable PATH, dedupes Path/PATH case-insensitively, and scrubs inherited Git config',
    a2Observed.gitVersion.status === 0 && /^git version /.test(a2Observed.gitVersion.stdout) && a2Observed.hooksPath.stdout === '' && Array.isArray(a2Observed.pathKeys) && a2Observed.pathKeys.length === 1, JSON.stringify(a2Observed));
  check('R15b A2 GIT_CEILING blocks discovery of the parent lure repository', a2Observed.gitTop.status !== 0 && a2Observed.gitTop.stdout === '' && /not a git repository/i.test(a2Observed.gitTop.stderr), JSON.stringify(a2Observed.gitTop));
  const r15dInjectedAbsent = ['CLAUDE_HOME','CLAUDE_PROJECT_DIR','CLAUDECODE','OneDrive','HERMES_CONFIG_PATH','GIT_TRACE2_EVENT','NODE_V8_COVERAGE','NODE_COMPILE_CACHE','NODE_PATH']
    .every((k) => a2Observed.inherited[k] === null);
  const r15dManagedSafe = typeof a2Observed.inherited.CLAUDE_CONFIG_DIR === 'string' && a2Observed.inherited.CLAUDE_CONFIG_DIR.includes('<ROOT>')
    && [a2Observed.HOME,a2Observed.USERPROFILE,a2Observed.TEMP,a2Observed.TMP,a2Observed.TMPDIR].every((v) => typeof v === 'string' && v.includes('<ROOT>'));
  check('R15d S2a N3 scrubs inherited CLAUDE/GIT_TRACE/NODE families and sensitive-root fallback values while preserving runner sandbox env',
    r15dInjectedAbsent && r15dManagedSafe,
    JSON.stringify({ inherited: a2Observed.inherited, HOME: a2Observed.HOME, USERPROFILE: a2Observed.USERPROFILE, TEMP: a2Observed.TEMP, TMP: a2Observed.TMP, TMPDIR: a2Observed.TMPDIR }));
  check('R15d S2a N3 PATH removes live-source entries so inherited fake command is not resolvable',
    !a2Run.stdout.split(/\r?\n/).some((line) => /r15d-fakecmd/.test(line)) && !String(a2Observed.PATH || '').toLowerCase().includes(r15dFakeBin.replace(/\\/g, '/').toLowerCase()),
    JSON.stringify({ stdout: a2Run.stdout, PATH: a2Observed.PATH }));
  const r15dExpectedScrubbed = ['CLAUDE_HOME','CLAUDE_PROJECT_DIR','CLAUDECODE','OneDrive','HERMES_CONFIG_PATH','GIT_TRACE2_EVENT','NODE_V8_COVERAGE','NODE_COMPILE_CACHE','NODE_PATH'];
  check('R15d S2a N3 reports scrubbed inherited key names without values',
    Array.isArray(a2Run.environmentScrubbedKeys) && r15dExpectedScrubbed.every((k) => a2Run.environmentScrubbedKeys.some((x) => x.toLowerCase() === k.toLowerCase())) && a2Run.environmentScrubbedKeys.every((x) => typeof x === 'string' && !/[\\/=:]/.test(x)),
    JSON.stringify(a2Run.environmentScrubbedKeys));

  const r15dNodeRestoreKey = 'NODE_V8_COVERAGE';
  const r15dNodeRestoreBefore = process.env[r15dNodeRestoreKey];
  const r15dNodeRestoreSentinel = 'C:/r15d-parent-node-v8-coverage-sentinel';
  const r15dNodeRestoreHome = fs.mkdtempSync(path.join(T, 'r15d-node-restore-'));
  let r15dNodeNormal = null, r15dNodeThrow = null;
  try {
    process.env[r15dNodeRestoreKey] = r15dNodeRestoreSentinel;
    const env = runner.isolatedEnv(r15dNodeRestoreHome, null);
    const rr = runner.runHook('printf ok', {}, env, r15dNodeRestoreHome, 5000, []);
    r15dNodeNormal = { exitCode: rr.exitCode, stdout: rr.stdout, parentAfter: process.env[r15dNodeRestoreKey] };
    const originalSpawnSync = cp.spawnSync;
    try {
      cp.spawnSync = () => { throw new Error('r15d-forced-spawn-throw'); };
      try { runner.runHook('printf never', {}, env, r15dNodeRestoreHome, 5000, []); }
      catch (e) { r15dNodeThrow = { message: String(e && e.message || e), parentAfter: process.env[r15dNodeRestoreKey] }; }
    } finally { cp.spawnSync = originalSpawnSync; }
  } finally {
    if (r15dNodeRestoreBefore === undefined) delete process.env[r15dNodeRestoreKey]; else process.env[r15dNodeRestoreKey] = r15dNodeRestoreBefore;
    fs.rmSync(r15dNodeRestoreHome, { recursive: true, force: true });
  }
  check('R15d S2b sandbox spawn restores parent NODE_V8_COVERAGE after normal return',
    r15dNodeNormal && r15dNodeNormal.exitCode === 0 && r15dNodeNormal.stdout === 'ok' && r15dNodeNormal.parentAfter === r15dNodeRestoreSentinel,
    JSON.stringify(r15dNodeNormal));
  check('R15d S2b sandbox spawn restores parent NODE_V8_COVERAGE when spawnSync throws',
    r15dNodeThrow && r15dNodeThrow.message === 'r15d-forced-spawn-throw' && r15dNodeThrow.parentAfter === r15dNodeRestoreSentinel,
    JSON.stringify(r15dNodeThrow));

  const a3Command = 'node "' + a3Abs.replace(/\\/g, '/') + '"';
  const a3Freeze = bindSingle(4, 'a3-path-guard', a3Command, [a3Rel]);
  const a3WinRootBackslash = '\\Users\\axmem-r15d-outside.txt';
  const a3WinRootSlash = '/Users/axmem-r15d-outside.txt';
  check('R15d S1 win32 treats single-backslash and single-slash root-relative spellings as absolute',
    path.win32.isAbsolute(a3WinRootBackslash) && path.win32.isAbsolute(a3WinRootSlash),
    JSON.stringify({ backslash: path.win32.resolve('C:\\sandbox', a3WinRootBackslash), slash: path.win32.resolve('C:\\sandbox', a3WinRootSlash) }));
  const a3Cases = [
    ['drive', path.join(T, 'outside-drive.txt')],
    ['msys', toMsys(path.join(T, 'outside-msys.txt'))],
    ['unc', '\\\\server\\share\\outside.txt'],
    ['win-root-backslash', a3WinRootBackslash],
    ['win-root-slash', a3WinRootSlash],
  ];
  for (const [kind, outside] of a3Cases) {
    try { fs.rmSync(a3Marker, { force: true }); } catch {}
    let err = null;
    try { runner.runCase({ freeze: a3Freeze, group: focusedGroup, c: { id: 'a3-' + kind, input: { transcript_path: outside } }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 }); } catch (e) { err = e; }
    check('R15b A3 rejects ' + kind + ' absolute payload path before any hook executes', err && err.code === 'payload-path-outside-sandbox' && err.detail && err.detail.field === '$.transcript_path' && !fs.existsSync(a3Marker), String(err && err.message));
    try { fs.rmSync(a3Marker, { force: true }); } catch {}
  }

  const n2Sandbox = fs.mkdtempSync(path.join(T, 'r15d-n2-sandbox-'));
  const n2Cwd = path.join(n2Sandbox, 'work', 'deep');
  fs.mkdirSync(n2Cwd, { recursive: true });
  const n2Reject = (label, input, code, field) => {
    let err = null;
    try { runner.prepareCaseInput(input, n2Sandbox); } catch (e) { err = e; }
    check('R15d S2b N2 rejects ' + label, err && err.code === code && err.detail && err.detail.field === field, JSON.stringify({ code: err && err.code, detail: err && err.detail }));
  };
  n2Reject('relative cwd ../../../..', { cwd: '../../../..' }, 'payload-path-not-absolute', '$.cwd');
  n2Reject('relative transcript_path', { transcript_path: '../transcript.json' }, 'payload-path-not-absolute', '$.transcript_path');
  n2Reject('relative tool_input.file_path escaping cwd', { cwd: n2Cwd, tool_input: { file_path: '../../../../.claude/memory/decisions.md' } }, 'payload-path-outside-sandbox', '$.tool_input.file_path');
  n2Reject('nested edits[].file_path escaping cwd', { cwd: n2Cwd, tool_input: { edits: [{ file_path: '../../../../outside.txt' }] } }, 'payload-path-outside-sandbox', '$.tool_input.edits[0].file_path');
  const n2Inside = runner.prepareCaseInput({ cwd: n2Cwd, tool_input: { file_path: '../ok.txt', edits: [{ file_path: './also-ok.txt' }] } }, n2Sandbox);
  check('R15d S2b N2 resolves relative tool paths against case cwd before sandbox check',
    path.isAbsolute(n2Inside.tool_input.file_path) && runner.prepareCaseInput(n2Inside, n2Sandbox).tool_input.file_path === n2Inside.tool_input.file_path && /\/work\/ok\.txt$/.test(n2Inside.tool_input.file_path.replace(/\\/g, '/')),
    JSON.stringify(n2Inside.tool_input));
  fs.rmSync(n2Sandbox, { recursive: true, force: true });

  let tmpDangerErr = null;
  try { runner.scanLiteralTmpSource('guards/r15d-tmp-fixture.sh', 'if false; then echo x > /tmp/r15d-probe; fi\n'); } catch (e) { tmpDangerErr = e; }
  check('R15d S2b literal /tmp preflight rejects executable source use', tmpDangerErr && tmpDangerErr.code === 'sandbox-literal-tmp', JSON.stringify(tmpDangerErr && tmpDangerErr.detail));
  let tmpSafe = null, tmpSafeErr = null;
  try { tmpSafe = runner.scanLiteralTmpSource('guards/r15d-tmp-safe.sh', '# /tmp/comment only\nT="${TMPDIR:-/tmp}"\nU="${TMPDIR-/tmp}"\n'); } catch (e) { tmpSafeErr = e; }
  check('R15d S2b literal /tmp preflight permits whole-line comments and exact TMPDIR defaults', !tmpSafeErr && tmpSafe && tmpSafe.exceptionsUsed.length === 0, String(tmpSafeErr && tmpSafeErr.message));
  const tmpExceptionLine = '  case "$T" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) echo "mktemp 异常路径 $T,拒绝继续"; exit 1;; esac';
  const tmpException = runner.scanLiteralTmpSource('guards/pmm-shell-memory-watch.sh', tmpExceptionLine + '\n');
  check('R15d S2b literal /tmp preflight accepts exactly the reviewed line-hash exception', tmpException.exceptionsUsed.length === 1 && tmpException.exceptionsUsed[0].lineSha256 === sha256(Buffer.from(tmpExceptionLine)), JSON.stringify(tmpException));
  let tmpMutatedErr = null;
  try { runner.scanLiteralTmpSource('guards/pmm-shell-memory-watch.sh', tmpExceptionLine.replace('异常路径', '异常路经') + '\n'); } catch (e) { tmpMutatedErr = e; }
  check('R15d S2b literal /tmp exception fails closed when approved line changes', tmpMutatedErr && tmpMutatedErr.code === 'sandbox-literal-tmp', JSON.stringify(tmpMutatedErr && tmpMutatedErr.detail));
  let tmpShebangErr = null, tmpUnknownExecErr = null;
  try { runner.scanLiteralTmpSource('guards/r15d-noext-shell', '#!/usr/bin/env bash\necho x > /tmp/r15d-shebang-probe\n', { executableHint: true }); } catch (e) { tmpShebangErr = e; }
  check('R15d S2c literal /tmp preflight classifies extensionless executable by shell shebang', tmpShebangErr && tmpShebangErr.code === 'sandbox-literal-tmp', JSON.stringify(tmpShebangErr && tmpShebangErr.detail));
  const tmpJsonData = runner.scanLiteralTmpSource('memory/_local-config/settings.json', '{"path":"/tmp/data-only"}\n', { executableHint: true });
  check('R15d S2c literal /tmp preflight marks pure JSON data not-applicable', tmpJsonData.checked === false && tmpJsonData.notApplicable === true && tmpJsonData.reason === 'pure-data-json', JSON.stringify(tmpJsonData));
  try { runner.scanLiteralTmpSource('guards/r15d-unknown-exec', '#!/usr/bin/env python3\nprint("/tmp/r15d")\n', { executableHint: true }); } catch (e) { tmpUnknownExecErr = e; }
  check('R15d S2c literal /tmp preflight rejects executable files with unsupported shebang type', tmpUnknownExecErr && tmpUnknownExecErr.code === 'sandbox-source-type-unknown', JSON.stringify(tmpUnknownExecErr && tmpUnknownExecErr.detail));
  const tmpEnvHome = fs.mkdtempSync(path.join(T, 'r15d-tmpdir-env-'));
  const tmpEnv = runner.isolatedEnv(tmpEnvHome, null);
  const tmpMissing = Object.assign({}, tmpEnv); delete tmpMissing.TMPDIR;
  let tmpMissingErr = null, tmpOutsideErr = null;
  try { runner.runHook('printf never', {}, tmpMissing, tmpEnvHome, 5000, []); } catch (e) { tmpMissingErr = e; }
  const tmpOutside = Object.assign({}, tmpEnv, { TMPDIR: path.join(T, 'r15d-outside-tmpdir') });
  try { runner.runHook('printf never', {}, tmpOutside, tmpEnvHome, 5000, []); } catch (e) { tmpOutsideErr = e; }
  check('R15d S2b hook launch rejects missing TMPDIR before spawn', tmpMissingErr && tmpMissingErr.code === 'sandbox-tmpdir-invalid', String(tmpMissingErr && tmpMissingErr.message));
  check('R15d S2b hook launch rejects TMPDIR outside case sandbox before spawn', tmpOutsideErr && tmpOutsideErr.code === 'sandbox-tmpdir-invalid', String(tmpOutsideErr && tmpOutsideErr.message));
  fs.rmSync(tmpEnvHome, { recursive: true, force: true });

  const unknownRaw = clone(freeze);
  unknownRaw.hooks.push({
    logicalId: 'r15b-untriggered-unknown-disposition', event: 'PostToolUseFailure', groupIndex: 0, hookIndex: 0, matcher: 'Bash',
    command: command, timeout: 5, disposition: 'mystery', files: [hookRel], implementation: null,
    notes: 'must be rejected even though focused UserPromptSubmit cannot trigger it', externalDependencies: [], businessExitCodes: [2],
    runtimeHealthProbe: { version: 1, innerCommand: command, reliable: true, notes: 'unused' },
  });
  const unknownFreeze = bindFreeze(unknownRaw, 'a4-unknown-disposition');
  let unknownDispositionErr = null;
  try { runner.runCase({ freeze: unknownFreeze, group: focusedGroup, c: { id: 'a4-unknown', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 }); } catch (e) { unknownDispositionErr = e; }
  check('R15b A4 rejects unknown disposition on an untriggered freeze hook at entry', unknownDispositionErr && unknownDispositionErr.code === 'freeze-hook-disposition-invalid' && unknownDispositionErr.detail && unknownDispositionErr.detail.disposition === 'mystery', String(unknownDispositionErr && unknownDispositionErr.message));
  const triggeredUnknownRaw = clone(freeze);
  triggeredUnknownRaw.hooks[4].disposition = 'mystery';
  const triggeredUnknownFreeze = bindFreeze(triggeredUnknownRaw, 'a4-triggered-unknown-disposition');
  let triggeredUnknownErr = null;
  try { runner.runCase({ freeze: triggeredUnknownFreeze, group: focusedGroup, c: { id: 'a4-triggered-unknown', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 }); } catch (e) { triggeredUnknownErr = e; }
  check('R15b A4 rejects unknown disposition on a triggered freeze hook', triggeredUnknownErr && triggeredUnknownErr.code === 'freeze-hook-disposition-invalid' && triggeredUnknownErr.detail && triggeredUnknownErr.detail.disposition === 'mystery', String(triggeredUnknownErr && triggeredUnknownErr.message));

  const a5Command = 'node "' + a5Abs.replace(/\\/g, '/') + '"';
  const a5Freeze = bindSingle(4, 'a5-invalid-utf8', a5Command, [a5Rel]);
  const a5Run = (id, prompt) => runner.runCase({ freeze: a5Freeze, group: focusedGroup, c: { id, input: { prompt } }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  const stateRec = (r) => Object.entries(r.stateTree).find(([k]) => /r15b-a5-state\.bin$/.test(k.replace(/\\/g, '/')))?.[1];
  const a580 = stateRec(a5Run('a5-b80', 'b80'));
  const a581 = stateRec(a5Run('a5-b81', 'b81'));
  check('R15b A5 invalid UTF-8 bytes 0x80 and 0x81 keep distinct state digests', a580 && a581 && a580.sha256 !== a581.sha256, JSON.stringify({ a580, a581 }));
  const a5Path1 = stateRec(a5Run('a5-path-1', 'path'));
  const a5Path2 = stateRec(a5Run('a5-path-2', 'path'));
  check('R15b A5 invalid UTF-8 state still normalizes sandbox path deterministically', a5Path1 && a5Path2 && a5Path1.sha256 === a5Path2.sha256, JSON.stringify({ a5Path1, a5Path2 }));
  const r15dBomRun = a5Run('r15d-s2a-bom', 'bom');
  const r15dNoBomRun = a5Run('r15d-s2a-nobom', 'nobom');
  const r15dBomRec = stateRec(r15dBomRun);
  const r15dNoBomRec = stateRec(r15dNoBomRun);
  check('R15d S2a B-1 state digest preserves leading UTF-8 BOM bytes',
    r15dBomRec && r15dNoBomRec && r15dBomRec.sha256 !== r15dNoBomRec.sha256 && r15dBomRec.size === r15dNoBomRec.size + 3,
    JSON.stringify({ bom: r15dBomRec, noBom: r15dNoBomRec }));
  const r15dBomLeft = clone(reportA), r15dBomRight = clone(reportA);
  r15dBomLeft.cases[0].stateTree = clone(r15dBomRun.stateTree);
  r15dBomRight.cases[0].stateTree = clone(r15dNoBomRun.stateTree);
  const r15dBomCompare = equiv.compareReports(r15dBomLeft, r15dBomRight, []);
  check('R15d S2a B-1 compareReports detects state files differing only by leading UTF-8 BOM',
    r15dBomCompare.equal === false && r15dBomCompare.unexpected.some((d) => d.caseId === reportA.cases[0].id && d.field === 'stateTree'),
    JSON.stringify(r15dBomCompare.unexpected));

  // R15b A6: materialization gate bound to the real candidate inventory hook identities/derived fields.
  const a6CandidateRoot = path.join(__dirname, '..');
  const a6InventoryRel = 'docs/freeze/INVENTORY-V1-CANDIDATE-R12b.json';
  const a6CandidateCommit = git(a6CandidateRoot, ['rev-parse', 'HEAD']).trim();
  const a6CandidateBytes = Buffer.from(git(a6CandidateRoot, ['show', a6CandidateCommit + ':' + a6InventoryRel]), 'utf8');
  const a6Inventory = JSON.parse(a6CandidateBytes.toString('utf8'));
  a6Inventory.generatedArtifacts = [];
  const a6AxmemRoot = path.join(T, 'r15d-a6-inventory-repo');
  const a6InventoryAbs = path.join(a6AxmemRoot, ...a6InventoryRel.split('/'));
  fs.mkdirSync(path.dirname(a6InventoryAbs), { recursive: true });
  const a6InventoryBytes = Buffer.from(JSON.stringify(a6Inventory, null, 2) + '\n');
  fs.writeFileSync(a6InventoryAbs, a6InventoryBytes);
  git(a6AxmemRoot, ['init', '-q']);
  git(a6AxmemRoot, ['add', '--', a6InventoryRel]);
  git(a6AxmemRoot, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'r15d a6 pinned real-candidate inventory shape']);
  const a6InventoryCommit = git(a6AxmemRoot, ['rev-parse', 'HEAD']).trim();
  const a6Hooks = a6Inventory.hooks.map((h) => {
    const runnable = h.disposition === 'port' || h.disposition === 'replace';
    return {
      event: h.event, groupIndex: h.groupIndex, hookIndex: h.hookIndex,
      matcher: h.matcher === undefined ? null : h.matcher, command: h.command,
      timeout: h.timeout === undefined ? null : h.timeout,
      disposition: h.disposition, files: clone(h.files || []), implementation: h.implementation || null,
      notes: h.notes || '', externalDependencies: clone(h.externalDependencies || []),
      businessExitCodes: runnable ? clone(h.businessExitCodes || []) : [],
      runtimeHealthProbe: runnable ? clone(h.runtimeHealthProbe) : null,
    };
  });
  const a6Repo = path.join(T, 'r15b-a6-real-inventory-repo');
  const a6Live = path.join(a6Repo, '.claude');
  const a6MirrorRel = a6Inventory.settingsMirror;
  const a6MirrorBytes = Buffer.from(JSON.stringify(settingsForHooks(a6Hooks), null, 2) + '\n');
  const a6SourceFiles = [];
  for (const f of a6Inventory.files) {
    const abs = path.join(a6Live, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let bytes;
    if (f.path === a6MirrorRel) bytes = a6MirrorBytes;
    else if (/\.(?:c?js|mjs)$/i.test(f.path)) bytes = Buffer.from("'use strict';\n", 'utf8');
    else if (/\.(?:sh|bash)$/i.test(f.path)) bytes = Buffer.from('#!/usr/bin/env bash\ntrue\n', 'utf8');
    else if (/\.json$/i.test(f.path)) bytes = Buffer.from('{}\n', 'utf8');
    else bytes = Buffer.from('', 'utf8');
    fs.writeFileSync(abs, bytes);
    a6SourceFiles.push({ path: f.path, sha256: sha256(bytes), disposition: f.disposition, dependencies: clone(f.dependencies || []), unresolvedDependencies: clone(f.unresolvedDependencies || []), notes: f.notes || 'real candidate inventory-shape fixture' });
  }
  git(a6Repo, ['init', '-q']);
  git(a6Repo, ['add', '--', '.claude']);
  git(a6Repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'r15b a6 full real inventory shape']);
  const a6Freeze = {
    schema: 'axmem-p2-freeze/v1',
    source: { commit: git(a6Repo, ['rev-parse', 'HEAD']).trim(), liveRelativePath: '.claude', treeOid: git(a6Repo, ['rev-parse', 'HEAD:.claude']).trim(), clean: true, uncommittedPatch: { empty: true, sha256: null } },
    inventoryCommit: a6InventoryCommit,
    inventoryPath: a6InventoryRel,
    inventorySha256: sha256(a6InventoryBytes),
    settingsEvidence: {
      mirrorPath: a6MirrorRel,
      mirrorSha256: sha256(a6MirrorBytes),
      hookIdentitySha256: sha256(Buffer.from(a6Hooks.map(localHookIdentity).join('\n'), 'utf8')),
    },
    hooks: a6Hooks,
    sourceFiles: a6SourceFiles,
  };
  const a6GoodHome = fs.mkdtempSync(path.join(T, 'r15b-a6-good-'));
  let a6GoodDir = null, a6GoodErr = null;
  try { a6GoodDir = runner.materializeFreeze(a6Freeze, a6Repo, a6GoodHome, a6AxmemRoot); } catch (e) { a6GoodErr = e; }
  check('R15b A6 real candidate inventory shape passes materialization provenance gate', !a6GoodErr && a6GoodDir && fs.existsSync(path.join(a6GoodDir, ...a6MirrorRel.split('/'))), String(a6GoodErr && a6GoodErr.message));
  check('R15d S2c real-candidate-shape fixture freezes every inventory file, not only settings mirror', a6Freeze.sourceFiles.length === a6Inventory.files.length && a6Inventory.files.every((f) => a6Freeze.sourceFiles.some((x) => x.path === f.path)), JSON.stringify({ sourceFiles: a6Freeze.sourceFiles.length, inventoryFiles: a6Inventory.files.length }));
  fs.rmSync(a6GoodHome, { recursive: true, force: true });
  const a6RejectBeforeExecution = (label, mutate, expectedCode, expectedField) => {
    const bad = clone(a6Freeze);
    mutate(bad);
    const home = fs.mkdtempSync(path.join(T, 'r15b-a6-bad-'));
    const marker = path.join(T, 'r15b-a6-would-execute-' + label + '.marker');
    try { fs.rmSync(marker, { force: true }); } catch {}
    let err = null;
    try {
      runner.materializeFreeze(bad, a6Repo, home, a6AxmemRoot);
      fs.writeFileSync(marker, 'materialization returned; hook execution boundary reached');
    } catch (e) { err = e; }
    const fieldOK = expectedField === undefined || (err && err.detail && err.detail.field === expectedField);
    check('R15b A6 rejects ' + label + ' before hook execution boundary', err && err.code === expectedCode && fieldOK && !fs.existsSync(marker), JSON.stringify({ code: err && err.code, detail: err && err.detail }));
    fs.rmSync(home, { recursive: true, force: true });
    try { fs.rmSync(marker, { force: true }); } catch {}
  };
  a6RejectBeforeExecution('missing sourceFile sha256', (x) => { delete x.sourceFiles[0].sha256; }, 'freeze-source-hash-missing');
  a6RejectBeforeExecution('missing inventorySha256', (x) => { delete x.inventorySha256; }, 'freeze-inventory-binding-missing');
  a6RejectBeforeExecution('missing inventoryCommit', (x) => { delete x.inventoryCommit; }, 'freeze-inventory-binding-missing');
  a6RejectBeforeExecution('nonexistent inventory commit', (x) => { x.inventoryCommit = 'f'.repeat(40); }, 'freeze-inventory-blob-read-failed');
  a6RejectBeforeExecution('nonexistent inventory path at pinned commit', (x) => { x.inventoryPath = 'docs/freeze/DOES-NOT-EXIST.json'; }, 'freeze-inventory-blob-read-failed');
  a6RejectBeforeExecution('deleted sourceFiles dependency declaration', (x) => { const row = x.sourceFiles.find((v) => Array.isArray(v.dependencies) && v.dependencies.length > 0); row.dependencies = row.dependencies.slice(1); }, 'freeze-source-dependencies-mismatch');
  a6RejectBeforeExecution('missing settingsEvidence', (x) => { delete x.settingsEvidence; }, 'freeze-settings-evidence-missing');
  a6RejectBeforeExecution('tampered source treeOid', (x) => { x.source.treeOid = '0'.repeat(40); }, 'freeze-tree-oid-mismatch');
  a6RejectBeforeExecution('deleted hook', (x) => { x.hooks.splice(1, 1); }, 'freeze-settings-hook-mismatch');
  a6RejectBeforeExecution('swapped hook order', (x) => { [x.hooks[0], x.hooks[1]] = [x.hooks[1], x.hooks[0]]; }, 'freeze-settings-hook-mismatch');
  a6RejectBeforeExecution('mutated disposition', (x) => { const h = x.hooks.find((v) => v.disposition === 'port'); h.disposition = 'private-exclude'; }, 'freeze-inventory-derived-mismatch', 'disposition');
  a6RejectBeforeExecution('mutated runtimeHealthProbe.innerCommand', (x) => { const h = x.hooks.find((v) => v.runtimeHealthProbe); h.runtimeHealthProbe.innerCommand += ' --tampered'; }, 'freeze-inventory-derived-mismatch', 'runtimeHealthProbe');

  const s2cPinOriginalBytes = fs.readFileSync(path.join(repo, freeze.inventoryPath));
  const s2cPinInventory = JSON.parse(s2cPinOriginalBytes.toString('utf8'));
  const s2cPinTamperedInventory = clone(s2cPinInventory);
  const s2cPinTarget = s2cPinTamperedInventory.hooks.find((h) => h.disposition === 'port');
  s2cPinTarget.disposition = 'private-exclude';
  const s2cPinTamperedBytes = Buffer.from(JSON.stringify(s2cPinTamperedInventory, null, 2) + '\n');
  const s2cPinTamperedFreeze = clone(freeze);
  s2cPinTamperedFreeze.hooks.find((h) => h.event === s2cPinTarget.event && h.groupIndex === s2cPinTarget.groupIndex && h.hookIndex === s2cPinTarget.hookIndex).disposition = 'private-exclude';
  s2cPinTamperedFreeze.inventorySha256 = sha256(s2cPinTamperedBytes);
  let s2cPinTamperErr = null;
  try {
    fs.writeFileSync(path.join(repo, freeze.inventoryPath), s2cPinTamperedBytes);
    const home = fs.mkdtempSync(path.join(T, 'r15d-s2c-pin-tamper-'));
    try { runner.materializeFreeze(s2cPinTamperedFreeze, repo, home, repo); } catch (e) { s2cPinTamperErr = e; }
    finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally { fs.writeFileSync(path.join(repo, freeze.inventoryPath), s2cPinOriginalBytes); }
  check('R15d S2c workspace inventory plus FREEZE hash tamper cannot override pinned inventory commit', s2cPinTamperErr && s2cPinTamperErr.code === 'freeze-inventory-hash-mismatch', JSON.stringify({ code: s2cPinTamperErr && s2cPinTamperErr.code, detail: s2cPinTamperErr && s2cPinTamperErr.detail }));

  try { fs.rmSync(a3Marker, { force: true }); } catch {}
  const s2cOriginalValidateInventory = freezeTool.validateInventory;
  let s2cN4Err = null;
  try {
    freezeTool.validateInventory = () => { throw new freezeTool.FreezeError('r15d-n4-sentinel', 'forced validateInventory sentinel'); };
    runner.runCase({ freeze: a3Freeze, group: focusedGroup, c: { id: 'r15d-s2c-n4', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  } catch (e) { s2cN4Err = e; }
  finally { freezeTool.validateInventory = s2cOriginalValidateInventory; }
  check('R15d S2c runner calls exported p2-freeze validateInventory before any hook executes', s2cN4Err && s2cN4Err.code === 'freeze-inventory-validation-failed' && s2cN4Err.detail && s2cN4Err.detail.freezeCode === 'r15d-n4-sentinel' && !fs.existsSync(a3Marker), JSON.stringify({ code: s2cN4Err && s2cN4Err.code, detail: s2cN4Err && s2cN4Err.detail }));

  const s2cGenRepo = path.join(T, 'r15d-s2c-generate-repo');
  const s2cGenLive = path.join(s2cGenRepo, '.claude');
  fs.mkdirSync(s2cGenLive, { recursive: true });
  const s2cGenSettings = { hooks: {} };
  const s2cGenSettingsText = JSON.stringify(s2cGenSettings, null, 2) + '\n';
  fs.writeFileSync(path.join(s2cGenLive, 'settings.json'), s2cGenSettingsText);
  fs.writeFileSync(path.join(s2cGenLive, 'settings-mirror.json'), s2cGenSettingsText);
  const s2cGenInventory = {
    version: 1, settingsJson: 'settings.json', settingsMirror: 'settings-mirror.json', hooks: [],
    files: [{ path: 'settings-mirror.json', disposition: 'private-exclude', dependencies: [], unresolvedDependencies: [], notes: 'formal generator fixture mirror' }],
    externalDependencies: [], generatedArtifacts: [], allowedDifferences: [], auditEvidence: ['formal inventory commit binding fixture'],
  };
  const s2cGenInventoryPath = path.join(s2cGenRepo, 'inventory.json');
  const s2cGenInventoryText = JSON.stringify(s2cGenInventory, null, 2) + '\n';
  fs.writeFileSync(s2cGenInventoryPath, s2cGenInventoryText);
  git(s2cGenRepo, ['init', '-q']);
  git(s2cGenRepo, ['add', '--', '.claude', 'inventory.json']);
  git(s2cGenRepo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'formal inventory binding fixture']);
  const s2cGenHead = git(s2cGenRepo, ['rev-parse', 'HEAD']).trim();
  const s2cGenOut = path.join(T, 'r15d-s2c-generated-freeze.json');
  const s2cGenerated = freezeTool.generate({ liveDir: s2cGenLive, inventoryPath: s2cGenInventoryPath, out: s2cGenOut, generatedAt: '2026-10-01T00:00:00.000Z' });
  check('R15d S2c formal FREEZE records inventory commit/path and committed blob hash', s2cGenerated.inventoryCommit === s2cGenHead && s2cGenerated.inventoryPath === 'inventory.json' && s2cGenerated.inventorySha256 === sha256(Buffer.from(s2cGenInventoryText)), JSON.stringify({ inventoryCommit: s2cGenerated.inventoryCommit, inventoryPath: s2cGenerated.inventoryPath, inventorySha256: s2cGenerated.inventorySha256 }));
  const s2cGenDirty = clone(s2cGenInventory); s2cGenDirty.auditEvidence.push('uncommitted inventory mutation');
  fs.writeFileSync(s2cGenInventoryPath, JSON.stringify(s2cGenDirty, null, 2) + '\n');
  let s2cGenDirtyErr = null;
  try { freezeTool.generate({ liveDir: s2cGenLive, inventoryPath: s2cGenInventoryPath, out: path.join(T, 'r15d-s2c-should-not-write.json') }); } catch (e) { s2cGenDirtyErr = e; }
  check('R15d S2c formal FREEZE generation rejects uncommitted inventory bytes', s2cGenDirtyErr && s2cGenDirtyErr.code === 'inventory-commit-binding', String(s2cGenDirtyErr && s2cGenDirtyErr.message));

  const a7CrlfCommand = 'node "' + a7Abs.replace(/\\/g, '/') + '" crlf';
  const a7LfCommand = 'node "' + a7Abs.replace(/\\/g, '/') + '" lf';
  const a7CrlfFreeze = bindSingle(4, 'a7-crlf', a7CrlfCommand, [a7Rel]);
  const a7LfFreeze = bindSingle(4, 'a7-lf', a7LfCommand, [a7Rel]);
  const a7Crlf = runner.runCase({ freeze: a7CrlfFreeze, group: focusedGroup, c: { id: 'a7-line', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  const a7Lf = runner.runCase({ freeze: a7LfFreeze, group: focusedGroup, c: { id: 'a7-line', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  const a7LeftReport = clone(reportA), a7RightReport = clone(reportA);
  a7LeftReport.cases[0].stdout = a7Crlf.stdout;
  a7RightReport.cases[0].stdout = a7Lf.stdout;
  const a7Compared = equiv.compareReports(a7LeftReport, a7RightReport, []);
  check('R15b A7 runCase preserves CRLF-vs-LF stdout so compareReports differs', a7Crlf.stdout !== a7Lf.stdout && a7Compared.equal === false && a7Compared.unexpected.some((x) => x.field === 'stdout'), JSON.stringify(a7Compared.unexpected));

  const matcherGroup = { event: 'Write', hookEvents: ['PreToolUse'] };
  const matcherRun = (label, matcher, toolName) => {
    const raw = clone(freeze);
    const h = Object.assign({}, raw.hooks[0], { logicalId: 'r15b-matcher-' + label, matcher });
    raw.hooks = [h]; raw.sourceFiles = [sourceRow(hookRel)];
    const f = bindFreeze(raw, 'a8-' + label);
    return runner.runCase({ freeze: f, group: matcherGroup, c: { id: 'a8-' + label, input: toolName ? { tool_name: toolName } : {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  };
  let badRegex = null;
  try { matcherRun('bad-regex', 'Bash[', 'Write'); } catch (e) { badRegex = e; }
  check('R15b A8 invalid regex matcher is a stable infrastructure error', badRegex && badRegex.code === 'hook-matcher-regex' && badRegex.detail && badRegex.detail.matcher === 'Bash[', String(badRegex && badRegex.message));
  check('R15b A8 star matcher matches any tool', matcherRun('star', '*', 'Write').executedHooks === 1);
  check('R15b A8 pipe exact-list matcher matches Write', matcherRun('pipe-list', 'Edit|Write', 'Write').executedHooks === 1);
  check('R15b A8 comma exact-list matcher matches Write', matcherRun('comma-list', 'Edit, Write', 'Write').executedHooks === 1);
  let notebookNoMatch = null;
  try { matcherRun('notebook-exact', 'Notebook', 'NotebookEdit'); } catch (e) { notebookNoMatch = e; }
  check('R15b A8 simple matcher is exact, so Notebook does not match NotebookEdit', notebookNoMatch && notebookNoMatch.code === 'fixture-no-matching-hooks' && notebookNoMatch.detail && notebookNoMatch.detail.caseId === 'a8-notebook-exact', String(notebookNoMatch && notebookNoMatch.message));
  check('R15b A8 regex matcher is unanchored, so Note. matches NotebookEdit', matcherRun('unanchored-regex', 'Note.', 'NotebookEdit').executedHooks === 1);
  let numericMatcher = null;
  try { matcherRun('numeric', 123, 'Write'); } catch (e) { numericMatcher = e; }
  check('R15b A8 non-string matcher is rejected', numericMatcher && numericMatcher.code === 'hook-matcher-type' && numericMatcher.detail && numericMatcher.detail.matcherType === 'number', String(numericMatcher && numericMatcher.message));
  const a8CandidateInventory = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'freeze', 'INVENTORY-V1-CANDIDATE-R12b.json'), 'utf8'));
  const a8CandidateMatchers = a8CandidateInventory.hooks.filter((h) => ['PreToolUse','PostToolUse','PostToolUseFailure'].includes(h.event) && typeof h.matcher === 'string' && h.matcher.trim());
  const a8Counts = a8CandidateMatchers.reduce((m, h) => { m[h.event] = (m[h.event] || 0) + 1; return m; }, {});
  const a8ReverseGuard = a8CandidateMatchers.every((h) => {
    const expectedTool = h.matcher.split(/[|,]/).map((x) => x.trim()).find(Boolean);
    return !!expectedTool && runner.matcherMatches(h.event, h.matcher, { tool_name: expectedTool });
  });
  check('R15b A8 all 17 non-empty candidate tool matchers match their expected tool under new semantics', a8CandidateMatchers.length === 17 && a8Counts.PreToolUse === 7 && a8Counts.PostToolUse === 9 && a8Counts.PostToolUseFailure === 1 && a8ReverseGuard, JSON.stringify(a8Counts));

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
  const mkBranchFreeze = (outer, inner, reliable = true) => bindFreeze({
    schema: 'axmem-p2-freeze/v1',
    source: { commit: branchCommit, liveRelativePath: '.claude', treeOid: branchTree, clean: true, uncommittedPatch: { empty: true, sha256: null } },
    sourceFiles: [{ path: branchyRel, sha256: branchSha, disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'runtime health branch fixture' }],
    hooks: [{
      logicalId: 'runtime-health-branch', event: 'UserPromptSubmit', groupIndex: 0, hookIndex: 0, matcher: null,
      command: outer, timeout: 5, disposition: 'port', files: [branchyRel], implementation: null,
      notes: 'runtime health branch fixture', externalDependencies: [], businessExitCodes: [2],
      runtimeHealthProbe: { version: 1, innerCommand: inner, reliable, notes: reliable ? 'exact reviewed inner command' : 'inner intentionally swallows failures; health cannot be proven' },
    }],
  }, 'branch');
  const runBranch = (outer, prompt, inner = branchInner, reliable = true) =>
    runner.runCase({ freeze: mkBranchFreeze(outer, inner, reliable), group: focusedGroup, c: { id: 'rh-' + prompt, input: { prompt } }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  const simpleOuter = branchInner + ' || exit 0';
  const braceOuter = branchInner + ' || { echo masked >&2; exit 0; }';
  const silentOuter = branchInner + ' >/dev/null 2>&1 || exit 0';

  for (const [name, outer, prompt, expect, inner = branchInner] of [
    ['simple wrapper case-only missing module', simpleOuter, 'missing-module', 'unexpected-exit:1'],
    ['brace wrapper undeclared exit1', braceOuter, 'exit1', 'unexpected-exit:1'],
    ['silent redirect case-only missing module', silentOuter, 'missing-module', 'unexpected-exit:1', branchInner + ' >/dev/null 2>&1'],
  ]) {
    let err = null;
    try { runBranch(outer, prompt, inner); } catch (e) { err = e; }
    check('runtime health blocks ' + name, err && err.code === 'equiv-infrastructure' && new RegExp(expect).test(err.message), String(err && err.message));
  }

  const missingEntry = 'node "' + path.join(live, 'guards', 'never-there.cjs').replace(/\\/g, '/') + '"';
  let missingEntryErr = null;
  try { runBranch(missingEntry + ' >/dev/null 2>&1 || exit 0', 'allow', missingEntry + ' >/dev/null 2>&1'); } catch (e) { missingEntryErr = e; }
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

  const syntaxRel = 'guards/runtime-health-bad-syntax.sh';
  const syntaxAbs = path.join(live, ...syntaxRel.split('/'));
  fs.writeFileSync(syntaxAbs, '#!/usr/bin/env bash\nif then\n');
  git(repo, ['add', '.claude/guards/runtime-health-bad-syntax.sh']);
  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'runtime health syntax fixture']);
  const syntaxCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  const syntaxTree = git(repo, ['rev-parse', 'HEAD:.claude']).trim();
  const syntaxCmd = 'bash "' + syntaxAbs.replace(/\\/g, '/') + '"';
  const syntaxFreeze = bindFreeze({
    schema: 'axmem-p2-freeze/v1',
    source: { commit: syntaxCommit, liveRelativePath: '.claude', treeOid: syntaxTree, clean: true, uncommittedPatch: { empty: true, sha256: null } },
    sourceFiles: [{ path: syntaxRel, sha256: sha256(fs.readFileSync(syntaxAbs)), disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'syntax fixture' }],
    hooks: [{ logicalId: 'rh-syntax', event: 'UserPromptSubmit', groupIndex: 0, hookIndex: 0, matcher: null,
      command: syntaxCmd + ' >/dev/null 2>&1 || exit 0', timeout: 5, disposition: 'port', files: [syntaxRel],
      implementation: null, notes: 'syntax fixture', externalDependencies: [], businessExitCodes: [2],
      runtimeHealthProbe: { version: 1, innerCommand: syntaxCmd + ' >/dev/null 2>&1', reliable: true, notes: 'exact reviewed inner including stderr redirection' } }],
  }, 'syntax');
  let syntaxHealthErr = null;
  try { runner.runCase({ freeze: syntaxFreeze, group: focusedGroup, c: { id: 'rh-syntax', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 }); } catch (e) { syntaxHealthErr = e; }
  check('runtime health blocks syntax/startup failure hidden by outer exit0', syntaxHealthErr && /source health preflight failed/.test(syntaxHealthErr.message), String(syntaxHealthErr && syntaxHealthErr.message));

  // Comparator must reject missing/text-only/stale/cross-case health metadata and two equally bad reports.
  const validHealthReportA = runner.runFreezeReport({ freeze, fixture, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live });
  const validHealthReportB = runner.runFreezeReport({ freeze, fixture, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live });

  // Cross-source equivalence: provenance must validate independently on each side,
  // but comment-only source changes and enclosing empty commits are not behavior.
  fs.appendFileSync(hookAbs, '// behavior unchanged comment-only source revision\n');
  git(repo, ['add', '.claude/guards/hook.cjs']);
  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'comment-only hook source revision']);
  const commentFreeze = clone(freeze);
  commentFreeze.source.commit = git(repo, ['rev-parse', 'HEAD']).trim();
  commentFreeze.source.treeOid = git(repo, ['rev-parse', 'HEAD:.claude']).trim();
  commentFreeze.sourceFiles[0].sha256 = sha256(fs.readFileSync(hookAbs));
  const commentReport = runner.runFreezeReport({ freeze: commentFreeze, fixture, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live });
  const commentEquivalent = equiv.compareReports(validHealthReportA, commentReport, []);
  check('comparator accepts behavior-equivalent comment-only source revision',
    commentEquivalent.equal === true && commentEquivalent.unexpected.length === 0);

  git(repo, ['-c', 'user.name=P2 Machine', '-c', 'user.email=p2@example.invalid', 'commit', '--allow-empty', '-qm', 'metadata-only empty commit']);
  const emptyCommitFreeze = clone(commentFreeze);
  emptyCommitFreeze.source.commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const emptyCommitReport = runner.runFreezeReport({ freeze: emptyCommitFreeze, fixture, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live });
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
    const raw = clone(freeze);
    const missingCommand = '"' + path.join(live, 'guards', 'command_that_does_not_exist_axmem_p2').replace(/\\/g, '/') + '"';
    raw.hooks = [Object.assign({}, raw.hooks[4], { logicalId: 'missing', command: missingCommand,
      runtimeHealthProbe: Object.assign({}, raw.hooks[4].runtimeHealthProbe, { innerCommand: missingCommand }) })];
    const bad = bindFreeze(raw, 'missing-command');
    runner.runCase({ freeze: bad, group: focusedGroup, c: { id: 'missing', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 1000 });
  } catch (e) { missingErr = e; }
  check('runner classifies command-not-found as infrastructure failure', missingErr && missingErr.code === 'equiv-infrastructure' && /command-start:127/.test(missingErr.message), String(missingErr && missingErr.message));

  let timeoutErr = null;
  try {
    const raw = clone(freeze);
    const timeoutCommand = 'cd "' + live.replace(/\\/g, '/') + '" && sleep 1';
    raw.hooks = [Object.assign({}, raw.hooks[4], { logicalId: 'timeout', command: timeoutCommand, timeout: 0.01,
      runtimeHealthProbe: Object.assign({}, raw.hooks[4].runtimeHealthProbe, { innerCommand: timeoutCommand }) })];
    const bad = bindFreeze(raw, 'timeout-command');
    runner.runCase({ freeze: bad, group: focusedGroup, c: { id: 'timeout', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 1000 });
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
  const missingFreeze = bindFreeze(Object.assign({}, freeze, {
    sourceFiles: freeze.sourceFiles.concat([missingSourceRow]),
    hooks: [
      badRh('r2-tool-pre', 'PreToolUse', 'Bash|Edit|Write'),
      badRh('r2-tool-post', 'PostToolUse', 'Bash|Edit|Write'),
      badRh('r2-session-start', 'SessionStart', null),
      badRh('r2-session-end', 'SessionEnd', null),
      badRh('r2-user-prompt', 'UserPromptSubmit', null),
      badRh('r2-pre-compact', 'PreCompact', null),
    ],
  }), 'missing-runtime');
  const missingRunErrors = [];
  for (let i = 0; i < 2; i++) {
    try { runner.runFreezeReport({ freeze: missingFreeze, fixture, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live }); }
    catch (e) { missingRunErrors.push(e); }
  }
  check('R2 missing runtime module blocks both full baselines despite stderr redirect',
    missingRunErrors.length === 2 && missingRunErrors.every((e) => e && e.code === 'equiv-infrastructure' && /unexpected-exit:1/.test(e.message)),
    missingRunErrors.map((e) => e && e.message).join(' | '));

  let missingContractErr = null;
  try {
    const bad = clone(freeze);
    delete bad.hooks[4].businessExitCodes;
    runner.runCase({ freeze: bad, group: focusedGroup, c: { id: 'missing-contract', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 1000 });
  } catch (e) { missingContractErr = e; }
  check('R2 runnable hook without explicit business exit contract is infrastructure failure',
    missingContractErr && missingContractErr.code === 'freeze-inventory-derived-mismatch' && missingContractErr.detail && missingContractErr.detail.field === 'businessExitCodes',
    String(missingContractErr && missingContractErr.message));

  let badSyntaxErr = null;
  try {
    const badRel = 'guards/bad-syntax.sh';
    const raw = clone(freeze);
    raw.sourceFiles.push({ path: badRel, sha256: sha256(fs.readFileSync(badSyntaxShAbs)), disposition: 'port', dependencies: [], unresolvedDependencies: [], notes: 'R2 shell syntax fixture so dependency closure can bind before bash -n rejects it' });
    const badSyntaxCommand = 'bash "' + badSyntaxShAbs.replace(/\\/g, '/') + '" 2>/dev/null';
    raw.hooks = [Object.assign({}, raw.hooks[4], {
      logicalId: 'bad-syntax', command: badSyntaxCommand, files: [badRel],
      runtimeHealthProbe: Object.assign({}, raw.hooks[4].runtimeHealthProbe, { innerCommand: badSyntaxCommand }),
    })];
    const bad = bindFreeze(raw, 'bad-syntax');
    runner.runCase({ freeze: bad, group: focusedGroup, c: { id: 'bad-syntax', input: {} }, repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 1000 });
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
