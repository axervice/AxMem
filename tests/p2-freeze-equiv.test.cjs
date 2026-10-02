#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const freeze = require('../scripts/p2-freeze.cjs');
const equiv = require('../scripts/equiv.cjs');
const runner = require('../scripts/equiv-runner.cjs');

if (process.argv[2] !== '--self-test') {
  console.error('usage: p2-freeze-equiv.test.cjs --self-test');
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('PASS ' + name); pass++; }
  else { console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); fail++; }
}

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-p20-selftest-'));
function git(cwd, args, options = {}) {
  const root = path.resolve(cwd);
  const env = Object.assign({}, process.env, { GIT_CEILING_DIRECTORIES: path.dirname(root) });
  return cp.execFileSync('git', ['-C', root].concat(args), { encoding: 'utf8', input: options.input, env, stdio: ['pipe', 'pipe', 'pipe'] });
}
try {
  const gitNoRepo = path.join(T, 'git-no-repo');
  fs.mkdirSync(gitNoRepo, { recursive: true });
  let gitNoRepoErr = null;
  try { git(gitNoRepo, ['rev-parse', '--show-toplevel']); } catch (e) { gitNoRepoErr = e; }
  check('test git helper fails closed in a directory without .git instead of discovering an ancestor repository',
    gitNoRepoErr && Number(gitNoRepoErr.status) !== 0 && /not a git repository/i.test(String(gitNoRepoErr.stderr || gitNoRepoErr.message || '')),
    String(gitNoRepoErr && (gitNoRepoErr.stderr || gitNoRepoErr.message)));
  const repo = path.join(T, 'repo');
  const live = path.join(repo, '.claude');
  fs.mkdirSync(path.join(live, 'guards'), { recursive: true });
  const gateAbs = path.join(live, 'guards', 'gate.cjs');
  const gateCmdPath = gateAbs.replace(/\\/g, '/');
  const helperAbs = path.join(live, 'guards', 'helper.js');
  fs.writeFileSync(helperAbs, "module.exports = { marker: 'helper' };\n");
  const libDir = path.join(live, 'guards', 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'index.js'), "module.exports = { marker: 'index' };\n");
  fs.writeFileSync(path.join(live, 'guards', 'helper.sh'), '#!/usr/bin/env bash\ntrue\n');
  fs.writeFileSync(path.join(live, 'guards', 'main.sh'), 'G="$HOME/.claude"\nsource "$G/guards/helper.sh"\n');
  fs.writeFileSync(path.join(live, 'guards', 'dynamic.sh'), 'G="$HOME/.claude"\nsource "$G/guards/$TARGET.sh"\n');
  fs.writeFileSync(gateAbs, [
    "'use strict';",
    "require('./helper');",
    "require('./lib');",
    "const fs=require('fs'),path=require('path');",
    "const j=JSON.parse(fs.readFileSync(0,'utf8'));",
    "const d=process.env.PMM_MEM_DIR || path.join(process.env.HOME,'.claude','.local'); fs.mkdirSync(d,{recursive:true});",
    "const ts=new Date().toISOString();",
    "fs.writeFileSync(path.join(d,'equiv-state.txt'),'home='+process.env.HOME+'\\nts='+ts+'\\nevent='+j.hook_event_name+'\\n');",
    "console.log('HOOK '+j.hook_event_name+' '+process.env.HOME+' '+ts);",
    "if (j.prompt === 'deny') process.exit(2);",
    "",
  ].join('\n'));
  const portCommand = 'node "' + gateCmdPath + '"';
  const externalAbs = path.join(live, 'plugins', 'fixture', 'external.sh');
  fs.mkdirSync(path.dirname(externalAbs), { recursive: true });
  fs.writeFileSync(externalAbs, '#!/usr/bin/env bash\necho external\n');
  const externalCommand = 'bash "' + externalAbs.replace(/\\/g, '/') + '"';
  const settings = { hooks: { UserPromptSubmit: [{ matcher: null, hooks: [
    { type: 'command', command: portCommand, timeout: 5 },
    { type: 'command', command: externalCommand, timeout: 5 },
  ] }] } };
  const settingsText = JSON.stringify(settings, null, 2) + '\n';
  fs.writeFileSync(path.join(live, 'settings.json'), settingsText);
  fs.mkdirSync(path.join(live, 'memory', '_local-config'), { recursive: true });
  fs.writeFileSync(path.join(live, 'memory', '_local-config', 'settings.json'), settingsText);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/settings.json\n.claude/plugins/fixture/external.sh\n');
  const inventory = {
    version: 1,
    settingsJson: 'settings.json',
    settingsMirror: 'memory/_local-config/settings.json',
    externalDependencies: [
      { id: 'fixture-external', kind: 'file', path: 'plugins/fixture/external.sh', version: 'test', notes: 'hermetic external-prerequisite fixture' },
    ],
    hooks: [
      { event: 'UserPromptSubmit', groupIndex: 0, hookIndex: 0, matcher: null, command: portCommand, timeout: 5, disposition: 'port', files: ['guards/gate.cjs'], businessExitCodes: [2], runtimeHealthProbe: { version: 1, innerCommand: portCommand, reliable: true, notes: 'reviewed exact inner command; branch-specific failures are exercised per case' } },
      { event: 'UserPromptSubmit', groupIndex: 0, hookIndex: 1, matcher: null, command: externalCommand, timeout: 5, disposition: 'external-prerequisite', files: [], externalDependencies: ['fixture-external'], notes: 'must be skipped by hermetic replay' },
    ],
    files: [
      { path: 'guards/gate.cjs', disposition: 'port', dependencies: ['guards/helper.js', 'guards/lib/index.js'], notes: 'fixture' },
      { path: 'guards/helper.js', disposition: 'port', dependencies: [], notes: 'extensionless require target' },
      { path: 'guards/lib/index.js', disposition: 'port', dependencies: [], notes: 'directory index require target' },
      { path: 'guards/main.sh', disposition: 'port', dependencies: ['guards/helper.sh'], notes: 'known-root shell source fixture' },
      { path: 'guards/helper.sh', disposition: 'port', dependencies: [], notes: 'shell source target' },
      { path: 'memory/_local-config/settings.json', disposition: 'private-exclude', dependencies: [], notes: 'tracked hook mirror used only as freeze evidence' },
    ],
    auditEvidence: ['fixture-audit'],
    allowedDifferences: [],
  };
  const inv = path.join(repo, 'inventory.json');
  const committedInventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2));
  fs.writeFileSync(inv, committedInventoryBytes);
  git(repo, ['init', '-q']);
  git(repo, ['add', '.gitignore', '.claude', 'inventory.json']);
  git(repo, ['-c', 'user.name=P2 Selftest', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'fixture']);
  const commitInventoryFixture = (value, label) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    fs.writeFileSync(inv, bytes);
    git(repo, ['add', '--', 'inventory.json']);
    git(repo, ['-c', 'user.name=P2 Selftest', '-c', 'user.email=p2@example.invalid', 'commit', '-qm', 'inventory fixture: ' + label]);
    return bytes;
  };

  const m = freeze.buildManifest({ liveDir: live, inventoryPath: inv, generatedAt: '2026-09-29T00:00:00Z' });
  check('freeze clean source records commit/tree and empty patch', /^[0-9a-f]{40}$/.test(m.source.commit) && /^[0-9a-f]{40}$/.test(m.source.treeOid) && m.source.clean === true && m.source.uncommittedPatch.empty === true && m.source.uncommittedPatch.sha256 === null);
  check('freeze exact hook inventory + runtime exit contract', m.hooks.length === 2 && m.hooks[0].disposition === 'port' && m.hooks[1].disposition === 'external-prerequisite' && m.hooks[0].files[0] === 'guards/gate.cjs' && JSON.stringify(m.hooks[0].businessExitCodes) === '[2]' && m.hooks[0].runtimeHealthProbe && m.hooks[0].runtimeHealthProbe.innerCommand === portCommand && m.hooks[0].runtimeHealthProbe.reliable === true);
  const settingsHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(live, 'settings.json'))).digest('hex');
  const mirrorHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(live, 'memory', '_local-config', 'settings.json'))).digest('hex');
  const externalHash = crypto.createHash('sha256').update(fs.readFileSync(externalAbs)).digest('hex');
  check('freeze binds ignored live settings hooks to tracked mirror', m.settingsJson === 'settings.json' && m.settingsSha256 === settingsHash && m.settingsEvidence.mirrorPath === 'memory/_local-config/settings.json' && m.settingsEvidence.mirrorSha256 === mirrorHash && /^[0-9a-f]{64}$/.test(m.settingsEvidence.hookIdentitySha256) && git(repo, ['ls-files', '--', '.claude/settings.json']).trim() === '');
  check('freeze fingerprints external prerequisite file without pretending it is tracked source', m.externalDependencies.length === 1 && m.externalDependencies[0].id === 'fixture-external' && m.externalDependencies[0].sha256 === externalHash && git(repo, ['ls-files', '--', '.claude/plugins/fixture/external.sh']).trim() === '');
  check('freeze source file SHA256', m.sourceFiles.length === 6 && m.sourceFiles.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)));

  // R15e H6++: buildManifest must not manufacture a detached commit for uncommitted inventory bytes.
  fs.writeFileSync(inv, Buffer.concat([committedInventoryBytes, Buffer.from('\n')]));
  let r15eUncommittedInventoryErr = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv, generatedAt: '2026-09-29T00:00:00Z' }); }
  catch (e) { r15eUncommittedInventoryErr = e; }
  check('R15e H6++ buildManifest rejects uncommitted inventory instead of creating a detached snapshot commit',
    r15eUncommittedInventoryErr && r15eUncommittedInventoryErr.code === 'inventory-commit-binding',
    JSON.stringify({ code: r15eUncommittedInventoryErr && r15eUncommittedInventoryErr.code, message: r15eUncommittedInventoryErr && r15eUncommittedInventoryErr.message }));
  fs.writeFileSync(inv, committedInventoryBytes);

  // R15e H6++: a readable detached inventory commit is still invalid when AxMem HEAD cannot reach it.
  const r15eDetachedInventoryCommit = git(repo, [
    '-c', 'user.name=P2 Selftest', '-c', 'user.email=p2@example.invalid',
    'commit-tree', m.source.commit + '^{tree}', '-p', m.source.commit,
  ], { input: 'R15e unreachable inventory fixture\n' }).trim();
  const r15eAncestorEnv = Object.assign({}, process.env, { GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(repo)) });
  const r15eAncestorProbe = cp.spawnSync('git', ['-C', path.resolve(repo), 'merge-base', '--is-ancestor', r15eDetachedInventoryCommit, 'HEAD'],
    { env: r15eAncestorEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  const r15eUnreachableFreeze = JSON.parse(JSON.stringify(m));
  r15eUnreachableFreeze.inventoryCommit = r15eDetachedInventoryCommit;
  const r15eUnreachableHome = fs.mkdtempSync(path.join(T, 'r15e-unreachable-inventory-'));
  let r15eUnreachableErr = null;
  try { runner.materializeFreeze(r15eUnreachableFreeze, repo, r15eUnreachableHome, repo); }
  catch (e) { r15eUnreachableErr = e; }
  finally { fs.rmSync(r15eUnreachableHome, { recursive: true, force: true }); }
  check('R15e H6++ runner rejects inventoryCommit not reachable from AxMem HEAD before reading inventory bytes',
    r15eAncestorProbe.status === 1 && r15eUnreachableErr && r15eUnreachableErr.code === 'inventory-commit-unreachable',
    JSON.stringify({ ancestorStatus: r15eAncestorProbe.status, code: r15eUnreachableErr && r15eUnreachableErr.code, detail: r15eUnreachableErr && r15eUnreachableErr.detail }));

  const liveSettingsDrift = JSON.parse(JSON.stringify(settings));
  liveSettingsDrift.hooks.UserPromptSubmit[0].hooks[0].command += ' --drift';
  fs.writeFileSync(path.join(live, 'settings.json'), JSON.stringify(liveSettingsDrift, null, 2) + '\n');
  let mirrorMismatch = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { mirrorMismatch = e.code; }
  check('freeze rejects ignored live settings hook drift from tracked mirror', mirrorMismatch === 'settings-mirror-mismatch', String(mirrorMismatch));
  fs.writeFileSync(path.join(live, 'settings.json'), settingsText);

  fs.rmSync(externalAbs);
  let externalMissing = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { externalMissing = e.code; }
  check('freeze rejects missing external prerequisite file', externalMissing === 'external-dependency-missing', String(externalMissing));
  fs.mkdirSync(path.dirname(externalAbs), { recursive: true });
  fs.writeFileSync(externalAbs, '#!/usr/bin/env bash\necho external\n');

  fs.appendFileSync(path.join(live, 'guards', 'gate.cjs'), '// dirty\n');
  let dirtyCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { dirtyCode = e.code; }
  check('freeze fails closed on dirty live source', dirtyCode === 'dirty-live-source', String(dirtyCode));
  git(repo, ['checkout', '--', '.claude/guards/gate.cjs']);

  const bad = JSON.parse(JSON.stringify(inventory));
  bad.hooks[0].command = 'node "wrong.cjs"';
  bad.hooks[0].runtimeHealthProbe.innerCommand = 'node "wrong.cjs"';
  commitInventoryFixture(bad, 'wrong hook');
  let mismatch = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { mismatch = e.code; }
  check('freeze rejects incomplete/wrong hook inventory', mismatch === 'hook-inventory-mismatch', String(mismatch));

  const missingExcludedRationale = JSON.parse(JSON.stringify(inventory));
  missingExcludedRationale.hooks[1].notes = '';
  commitInventoryFixture(missingExcludedRationale, 'missing excluded rationale');
  let missingExcludedRationaleCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { missingExcludedRationaleCode = e.code; }
  check('freeze requires rationale for excluded/external hook', missingExcludedRationaleCode === 'bad-inventory', String(missingExcludedRationaleCode));

  const missingExitContract = JSON.parse(JSON.stringify(inventory));
  delete missingExitContract.hooks[0].businessExitCodes;
  commitInventoryFixture(missingExitContract, 'missing exit contract');
  let missingExitContractCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { missingExitContractCode = e.code; }
  check('freeze requires explicit runnable-hook business exit contract', missingExitContractCode === 'bad-inventory', String(missingExitContractCode));

  const missingHealthEvidence = JSON.parse(JSON.stringify(inventory));
  delete missingHealthEvidence.hooks[0].runtimeHealthProbe;
  commitInventoryFixture(missingHealthEvidence, 'missing health evidence');
  let missingHealthEvidenceCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { missingHealthEvidenceCode = e.code; }
  check('freeze requires structured runtime health probe contract', missingHealthEvidenceCode === 'bad-inventory', String(missingHealthEvidenceCode));

  const r15bCandidate = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'freeze', 'INVENTORY-V1-CANDIDATE-R12b.json'), 'utf8'));
  const r15bHealthHooks = r15bCandidate.hooks.filter((h) => (h.disposition === 'port' || h.disposition === 'replace') && h.runtimeHealthProbe);
  let r15bCandidateHealthErr = null;
  try { for (const h of r15bHealthHooks) freeze.normalizeRuntimeHealthProbe(h, h.event + '/' + h.groupIndex + '/' + h.hookIndex); }
  catch (e) { r15bCandidateHealthErr = e; }
  check('R15d-B C1 all 19 real port|replace outer/inner pairs still pass the simple-command mechanical gate',
    !r15bCandidateHealthErr && r15bHealthHooks.length === 19 && r15bHealthHooks.filter((h) => h.runtimeHealthProbe.reliable === false).length === 7,
    JSON.stringify({ count: r15bHealthHooks.length, reliableFalse: r15bHealthHooks.filter((h) => h.runtimeHealthProbe.reliable === false).length, error: r15bCandidateHealthErr && { code: r15bCandidateHealthErr.code, detail: r15bCandidateHealthErr.detail } }));

  const c1Reject = (name, commandValue, innerValue, expectedReason, requireToken = false) => {
    let err = null;
    try { freeze.normalizeRuntimeHealthProbe({ command: commandValue, runtimeHealthProbe: { version: 1, innerCommand: innerValue, reliable: true, notes: 'r15d-b c1 negative' } }, 'R15d-B-C1/' + name); }
    catch (e) { err = e; }
    const tokenDetailOk = !requireToken || (Number.isInteger(err && err.detail && err.detail.tokenIndex)
      && typeof err.detail.token === 'string' && err.detail.token.length > 0);
    check('R15d-B C1 rejects ' + name,
      err && err.code === 'bad-inventory' && err.detail && err.detail.field === 'runtimeHealthProbe.innerCommand'
        && err.detail.reason === expectedReason && tokenDetailOk,
      JSON.stringify({ code: err && err.code, detail: err && err.detail }));
  };
  const c1Real = r15bHealthHooks.find((h) => h.event === 'PostToolUse' && h.groupIndex === 6 && h.hookIndex === 0);
  const c1X = c1Real && c1Real.runtimeHealthProbe.innerCommand;
  check('R15d-B C1 rejection matrix fixture is read from the candidate inventory, not hand-copied',
    typeof c1X === 'string' && c1Real.command.startsWith(c1X),
    JSON.stringify({ command: c1Real && c1Real.command, inner: c1X }));

  c1Reject('unrelated inner=true', c1X, 'true', 'interpreter-must-be-bash-or-node', true);
  c1Reject('unapproved outer x || true with stripped inner', c1X + ' || true', c1X, 'inner-command-does-not-match-outer');
  c1Reject('approved || exit 0 outer when inner still contains the mask', c1X + ' || exit 0', c1X + ' || exit 0', 'shell-control-syntax-not-allowed', true);
  c1Reject('more than one approved fail-open tail', c1X + ' || exit 0 || exit 0', c1X + ' || exit 0', 'multiple-approved-fail-open-tails');

  const c1ShellMaskMatrix = [
    ['x || true || exit 0 / inner x || true', c1X + ' || true || exit 0', c1X + ' || true'],
    ['x||exit 0', c1X + '||exit 0', c1X + '||exit 0'],
    ['x || exit 0;', c1X + ' || exit 0;', c1X + ' || exit 0;'],
    ['x || exit 0 # c', c1X + ' || exit 0 # c', c1X + ' || exit 0 # c'],
    ['x || exit 00', c1X + ' || exit 00', c1X + ' || exit 00'],
    ['x || (exit 0)', c1X + ' || (exit 0)', c1X + ' || (exit 0)'],
    ['x || :', c1X + ' || :', c1X + ' || :'],
    ['x; exit 0', c1X + '; exit 0', c1X + '; exit 0'],
    ['x; true', c1X + '; true', c1X + '; true'],
    ['x | cat', c1X + ' | cat', c1X + ' | cat'],
    ['x &', c1X + ' &', c1X + ' &'],
    ['! x', '! ' + c1X, '! ' + c1X],
    ['$(x)', '$(' + c1X + ')', '$(' + c1X + ')'],
    ['backticks around x', String.fromCharCode(96) + c1X + String.fromCharCode(96), String.fromCharCode(96) + c1X + String.fromCharCode(96)],
    ['{ x; }', '{ ' + c1X + '; }', '{ ' + c1X + '; }'],
    ['(x)', '(' + c1X + ')', '(' + c1X + ')'],
    ['x && true', c1X + ' && true', c1X + ' && true'],
  ];
  for (const [name, outerValue, innerValue] of c1ShellMaskMatrix) {
    c1Reject('simple-command whitelist: ' + name, outerValue, innerValue, 'shell-control-syntax-not-allowed', true);
  }

  let c1WhitespaceErr = null;
  const c1WhitespaceOuter = c1X.replace('bash ', 'bash   ') + '   ||   exit   0';
  try { freeze.normalizeRuntimeHealthProbe({ command: c1WhitespaceOuter, runtimeHealthProbe: { version: 1, innerCommand: ' ' + c1X + ' ', reliable: true, notes: 'r15d-b c1 whitespace' } }, 'R15d-B-C1/whitespace'); } catch (e) { c1WhitespaceErr = e; }
  check('R15d-B C1 compares outer and inner after whitespace normalization', !c1WhitespaceErr, JSON.stringify(c1WhitespaceErr && { code: c1WhitespaceErr.code, detail: c1WhitespaceErr.detail }));

  let r15eQuotedPathWhitespaceErr = null;
  try {
    freeze.normalizeRuntimeHealthProbe({
      command: 'node "C:/Users/jax-x/.claude/x  y.cjs" || exit 0',
      runtimeHealthProbe: { version: 1, innerCommand: 'node "C:/Users/jax-x/.claude/x y.cjs"', reliable: true, notes: 'R15e quoted PATH byte-exact fixture' },
    }, 'R15e-H13/quoted-path');
  } catch (e) { r15eQuotedPathWhitespaceErr = e; }
  check('R15e H13 quoted PATH whitespace is byte-exact between outer and inner',
    r15eQuotedPathWhitespaceErr && r15eQuotedPathWhitespaceErr.code === 'bad-inventory'
      && r15eQuotedPathWhitespaceErr.detail && r15eQuotedPathWhitespaceErr.detail.reason === 'inner-command-does-not-match-outer',
    JSON.stringify({ code: r15eQuotedPathWhitespaceErr && r15eQuotedPathWhitespaceErr.code, detail: r15eQuotedPathWhitespaceErr && r15eQuotedPathWhitespaceErr.detail }));

  let r15eQuotedEnvWhitespaceErr = null;
  try {
    freeze.normalizeRuntimeHealthProbe({
      command: 'X="a  b" node "C:/Users/jax-x/.claude/x.cjs" || exit 0',
      runtimeHealthProbe: { version: 1, innerCommand: 'X="a b" node "C:/Users/jax-x/.claude/x.cjs"', reliable: true, notes: 'R15e quoted ENV byte-exact fixture' },
    }, 'R15e-H13/quoted-env');
  } catch (e) { r15eQuotedEnvWhitespaceErr = e; }
  check('R15e H13 quoted ENV whitespace is byte-exact between outer and inner',
    r15eQuotedEnvWhitespaceErr && r15eQuotedEnvWhitespaceErr.code === 'bad-inventory'
      && r15eQuotedEnvWhitespaceErr.detail && r15eQuotedEnvWhitespaceErr.detail.reason === 'inner-command-does-not-match-outer',
    JSON.stringify({ code: r15eQuotedEnvWhitespaceErr && r15eQuotedEnvWhitespaceErr.code, detail: r15eQuotedEnvWhitespaceErr && r15eQuotedEnvWhitespaceErr.detail }));

  let c2UnsupportedMatcherErr = null;
  try { freeze.flattenHooks({ hooks: { UserPromptSubmit: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo never' }] }] } }); }
  catch (e) { c2UnsupportedMatcherErr = e; }
  check('R15b C2 freeze rejects non-empty matcher on event without matcher support as bad-inventory',
    c2UnsupportedMatcherErr && c2UnsupportedMatcherErr.code === 'bad-inventory' && c2UnsupportedMatcherErr.detail && c2UnsupportedMatcherErr.detail.matcherErrorCode === 'hook-matcher-not-supported' && c2UnsupportedMatcherErr.detail.event === 'UserPromptSubmit',
    JSON.stringify({ code: c2UnsupportedMatcherErr && c2UnsupportedMatcherErr.code, detail: c2UnsupportedMatcherErr && c2UnsupportedMatcherErr.detail }));
  let c2SupportedMatcherErr = null;
  try { freeze.flattenHooks({ hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'echo ok' }] }] } }); }
  catch (e) { c2SupportedMatcherErr = e; }
  check('R15b C2 freeze still accepts supported non-empty tool matcher', !c2SupportedMatcherErr, String(c2SupportedMatcherErr && c2SupportedMatcherErr.message));


  const r15dMatcherTypeCases = [
    ['Stop number', 'Stop', 123, {}],
    ['UserPromptSubmit array', 'UserPromptSubmit', [], {}],
    ['Stop object', 'Stop', {}, {}],
    ['unknown event number', 'NoSuchEvent', 1, {}],
  ];
  for (const [name, event, matcher, payload] of r15dMatcherTypeCases) {
    let err = null;
    try { runner.matcherMatches(event, matcher, payload); } catch (e) { err = e; }
    check('R15d-B matcher rejects non-string before event support: ' + name,
      err && err.code === 'hook-matcher-type' && err.detail && err.detail.event === event,
      JSON.stringify({ code: err && err.code, detail: err && err.detail }));
  }

  const r15dEmptyAlternatives = ['|', ',', ' | ', 'Bash|', '|Bash', 'Edit||Write', 'Edit,,Write'];
  for (const matcher of r15dEmptyAlternatives) {
    let err = null;
    try { runner.matcherMatches('PreToolUse', matcher, { tool_name: 'Write' }); } catch (e) { err = e; }
    check('R15d-B matcher rejects empty simple-list alternative: ' + JSON.stringify(matcher),
      err && err.code === 'hook-matcher-empty-alternative' && err.detail
        && err.detail.event === 'PreToolUse' && err.detail.matcher === matcher
        && Number.isInteger(err.detail.alternativeIndex),
      JSON.stringify({ code: err && err.code, detail: err && err.detail }));
  }
  check('R15d-B matcher keeps empty/star/omitted as all-match',
    runner.matcherMatches('PreToolUse', '', { tool_name: 'Anything' })
      && runner.matcherMatches('PreToolUse', '*', { tool_name: 'Anything' })
      && runner.matcherMatches('PreToolUse', undefined, { tool_name: 'Anything' }));
  check('R15d-B matcher keeps valid simple lists exact',
    runner.matcherMatches('PreToolUse', 'Edit|Write', { tool_name: 'Write' })
      && runner.matcherMatches('PreToolUse', 'Edit, Write', { tool_name: 'Write' })
      && !runner.matcherMatches('PreToolUse', 'Edit|Write', { tool_name: 'Bash' }));

  let r15dFreezeEmptyAltErr = null;
  try { freeze.flattenHooks({ hooks: { PreToolUse: [{ matcher: 'Edit||Write', hooks: [{ type: 'command', command: 'echo never' }] }] } }); }
  catch (e) { r15dFreezeEmptyAltErr = e; }
  check('R15d-B matcher freeze entry maps empty alternative to bad-inventory',
    r15dFreezeEmptyAltErr && r15dFreezeEmptyAltErr.code === 'bad-inventory'
      && r15dFreezeEmptyAltErr.detail && r15dFreezeEmptyAltErr.detail.matcherErrorCode === 'hook-matcher-empty-alternative'
      && r15dFreezeEmptyAltErr.detail.event === 'PreToolUse',
    JSON.stringify({ code: r15dFreezeEmptyAltErr && r15dFreezeEmptyAltErr.code, detail: r15dFreezeEmptyAltErr && r15dFreezeEmptyAltErr.detail }));

  const missingManualDependencyList = JSON.parse(JSON.stringify(inventory));
  missingManualDependencyList.files.push({ path: 'guards/dynamic.sh', disposition: 'port', dependencies: [], unresolvedDependencies: [
    { expression: '$G/guards/$TARGET.sh', reason: 'negative fixture intentionally omits dependencies[]' },
  ], notes: 'negative dynamic review schema fixture' });
  commitInventoryFixture(missingManualDependencyList, 'missing manual dependency list');
  let missingManualDependencyListCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { missingManualDependencyListCode = e.code; }
  check('freeze requires dependencies[] on unresolved dynamic review', missingManualDependencyListCode === 'bad-inventory', String(missingManualDependencyListCode));

  const missingEdge = JSON.parse(JSON.stringify(inventory));
  missingEdge.files.find((x) => x.path === 'guards/gate.cjs').dependencies = [];
  commitInventoryFixture(missingEdge, 'missing detected edge');
  let missingEdgeCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { missingEdgeCode = e.code; }
  check('freeze rejects detected dependency omitted from dependencies[]', missingEdgeCode === 'dependency-edge-missing', String(missingEdgeCode));

  const missingClosure = JSON.parse(JSON.stringify(missingEdge));
  missingClosure.files = missingClosure.files.filter((x) => x.path !== 'guards/helper.js');
  commitInventoryFixture(missingClosure, 'missing closure file');
  let missingClosureCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { missingClosureCode = e.code; }
  check('freeze rejects detected tracked dependency absent from inventory', missingClosureCode === 'dependency-closure-missing', String(missingClosureCode));
  check('dependency scanner catches ESM import edges', freeze.detectLiteralDependencies('guards/vendor/unbash/parser.js', 'import { Lexer } from "./lexer.js";').includes('guards/vendor/unbash/lexer.js'));
  check('dependency scanner resolves known $G live-root without duplicating source dir', freeze.detectLiteralDependencies('guards/main.sh', 'source $G/guards/helper.sh').includes('guards/helper.sh') && !freeze.detectLiteralDependencies('guards/main.sh', 'source $G/guards/helper.sh').includes('guards/guards/helper.sh'));
  check('dependency scanner emits extensionless Node resolution candidates', freeze.detectLiteralDependencies('guards/main.cjs', "require('./helper')").includes('guards/helper.js'));
  check('dependency scanner emits common index resolution candidates', freeze.detectLiteralDependencies('guards/main.cjs', "require('./lib')").includes('guards/lib/index.js'));
  const dynamicAnalysis = freeze.analyzeDependencyReferences('guards/dynamic.sh', 'G="$HOME/.claude"\nsource "$G/guards/$TARGET.sh"\n');
  check('dependency scanner marks dynamic local dependency unresolved', dynamicAnalysis.unresolved.some((x) => x.expression === '$G/guards/$TARGET.sh'));

  const emptyDynamicReview = JSON.parse(JSON.stringify(inventory));
  emptyDynamicReview.files.push({ path: 'guards/dynamic.sh', disposition: 'port', dependencies: [], unresolvedDependencies: [
    { expression: '$G/guards/$TARGET.sh', dependencies: [], reason: 'empty dependency list must not count as closure evidence' },
  ], notes: 'negative dynamic dependency fixture' });
  commitInventoryFixture(emptyDynamicReview, 'empty dynamic review');
  let emptyDynamicCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { emptyDynamicCode = e.code; }
  check('freeze refuses empty dependencies plus reason as dynamic closure evidence', emptyDynamicCode === 'bad-inventory', String(emptyDynamicCode));

  const missingDynamicReview = JSON.parse(JSON.stringify(inventory));
  missingDynamicReview.files.push({ path: 'guards/dynamic.sh', disposition: 'port', dependencies: [], notes: 'negative unresolved dynamic fixture' });
  commitInventoryFixture(missingDynamicReview, 'missing dynamic review');
  let missingDynamicCode = null;
  try { freeze.buildManifest({ liveDir: live, inventoryPath: inv }); } catch (e) { missingDynamicCode = e.code; }
  check('freeze refuses unresolved dynamic dependency without a proven target', missingDynamicCode === 'dependency-unresolved-dynamic', String(missingDynamicCode));

  commitInventoryFixture(Buffer.from(JSON.stringify(inventory, null, 2)), 'restore valid inventory');

  const runFixture = {
    version: 1,
    events: [{ event: 'UserPromptSubmit', hookEvents: ['UserPromptSubmit'], cases: [
      { id: 'real-hook-run', input: { session_id: 'test:equiv-run', prompt: 'hello' } },
    ] }],
  };
  const inheritedEscape = path.join(T, 'must-not-write-here');
  const savedPmmMemDir = process.env.PMM_MEM_DIR;
  process.env.PMM_MEM_DIR = inheritedEscape;
  const runGroup = runFixture.events[0];
  const actualCase = runner.runCase({ freeze: m, group: runGroup, c: runGroup.cases[0], repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  const actualCase2 = runner.runCase({ freeze: m, group: runGroup, c: runGroup.cases[0], repoRoot: repo, axmemRepoRoot: repo, sourceRoot: live, defaultTimeoutMs: 5000 });
  if (savedPmmMemDir === undefined) delete process.env.PMM_MEM_DIR; else process.env.PMM_MEM_DIR = savedPmmMemDir;
  check('equiv runner executes frozen hook from materialized commit', actualCase.executedHooks === 1 && actualCase.stdout.includes('HOOK UserPromptSubmit') && Object.keys(actualCase.stateTree).some((k) => k.endsWith('.claude/.local/equiv-state.txt')));
  check('equiv runner skips external-prerequisite hook instead of executing it', actualCase.hookResults.some((h) => h.disposition === 'external-prerequisite' && h.status === 'skipped'));
  check('equiv runner focused frozen-vs-frozen stays deterministic after path/timestamp normalization', JSON.stringify(actualCase) === JSON.stringify(actualCase2));
  check('equiv runner leaves the frozen source repo byte-clean', git(repo, ['status', '--porcelain', '--', '.claude']).trim() === '');
  check('equiv runner scrubs inherited PMM path overrides', !fs.existsSync(inheritedEscape));

  const freezeFile = path.join(T, 'FREEZE-fixture.json');
  const runFixtureFile = path.join(T, 'run-fixture.json');
  const cliReportFile = path.join(T, 'cli-report.json');
  fs.writeFileSync(freezeFile, JSON.stringify(m, null, 2));
  fs.writeFileSync(runFixtureFile, JSON.stringify(runFixture, null, 2));
  const equivCli = path.join(__dirname, '..', 'scripts', 'equiv.cjs');
  const cliRun = cp.spawnSync(process.execPath, [
    equivCli, 'run',
    '--freeze', freezeFile,
    '--fixtures', runFixtureFile,
    '--repo', repo,
    '--axmem-repo', repo,
    '--source-root', live,
    '--out', cliReportFile,
  ], { encoding: 'utf8' });
  check('equiv CLI run rejects partial fixture before writing a baseline report', cliRun.status === 2 && /at least 3 cases/.test(cliRun.stderr || '') && !fs.existsSync(cliReportFile), (cliRun.stderr || cliRun.stdout || '').trim());



  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'p2-equiv', 'events.json'), 'utf8'));
  const counts = new Map(fixture.events.map((e) => [e.event, e.cases.length]));
  const required = ['Bash', 'Edit', 'Write', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreCompact'];
  check('equiv fixture covers seven required events x >=3', required.every((e) => (counts.get(e) || 0) >= 3) && fixture.events.reduce((n, e) => n + e.cases.length, 0) >= 21);
  const phaseMap = new Map(fixture.events.map((e) => [e.event, e.hookEvents]));
  check('equiv fixture pins hook-phase mapping explicitly',
    JSON.stringify(phaseMap.get('Bash')) === JSON.stringify(['PreToolUse', 'PostToolUse']) &&
    JSON.stringify(phaseMap.get('Edit')) === JSON.stringify(['PreToolUse', 'PostToolUse']) &&
    JSON.stringify(phaseMap.get('Write')) === JSON.stringify(['PreToolUse', 'PostToolUse']) &&
    ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreCompact'].every((e) => JSON.stringify(phaseMap.get(e)) === JSON.stringify([e])));


  const synthSourceFiles = [{ path: 'synthetic.cjs', sha256: 'a'.repeat(64) }];
  const synthSource = { commit: '1'.repeat(40), treeOid: '2'.repeat(40), sourceFiles: synthSourceFiles, sourceFilesSha256: runner.hashObject(synthSourceFiles) };
  const synthHealth = (caseId, event) => {
    const inputCanonical = JSON.stringify({ caseId });
    const outerCommand = 'node synthetic.cjs || exit 0';
    const innerCommand = 'node synthetic.cjs';
    const environment = { HOME: '<ROOT>', AXMEM_EQUIV_ACTIVE: '1' };
    return {
      schema: 'axmem-runtime-health/v1', status: 'healthy', caseId, event, phase: event, logicalId: 'synthetic:' + event,
      inputCanonical, inputSha256: crypto.createHash('sha256').update(inputCanonical).digest('hex'),
      sourceCommit: synthSource.commit, sourceTreeOid: synthSource.treeOid,
      sourceFiles: synthSourceFiles, sourceBindingSha256: runner.hashObject(synthSourceFiles),
      outerCommand, outerCommandSha256: crypto.createHash('sha256').update(outerCommand).digest('hex'),
      innerCommand, innerCommandSha256: crypto.createHash('sha256').update(innerCommand).digest('hex'),
      environment, environmentSha256: runner.hashObject(environment),
      initialOuterStateSha256: 'b'.repeat(64), initialProbeStateSha256: 'b'.repeat(64),
      initialStatesEqual: true, outerStateAfterProbeSha256: 'b'.repeat(64), probeContaminatedOuter: false,
      probeExitCode: 0, probeOutcome: 'allow', sourceSyntaxChecked: ['synthetic.cjs'], probeNotes: 'synthetic structured evidence',
    };
  };
  let synthCaseIndex = 0;
  const cases = fixture.events.flatMap((e) => e.cases.map((c) => {
    const inputCanonical = JSON.stringify(equiv.stable(c.input || {}));
    return {
      id: c.id, event: e.event, sandboxRoot: 'C:/tmp/axmem-equiv-case-' + String(synthCaseIndex++).padStart(6, '0'), inputCanonical,
      inputSha256: crypto.createHash('sha256').update(inputCanonical).digest('hex'),
      exitCode: 0,
      stdout: 'root=C:/tmp/frozen ' + '2026-09-29T00:00:00Z',
      stderr: '',
      stateTree: { ['C:/tmp/frozen/state/' + c.id + '.txt']: { sha256: 'a'.repeat(64), size: 3, binary: false } },
      executedHooks: 1,
      hookResults: [{ logicalId: 'synthetic:' + e.event, phase: e.event, matcher: null, disposition: 'port', status: 'ran', exitCode: 0, outcome: 'allow', businessExitCodes: [2], runtimeHealth: synthHealth(c.id, e.event) }],
    };
  }));
  const report = { schema: 'axmem-equiv-report/v1', source: synthSource, normalization: { pathPrefixes: cases.map((c) => c.sandboxRoot) }, cases };
  const same = equiv.compareReports(report, JSON.parse(JSON.stringify(report)), []);
  check('equiv frozen-vs-itself is exact green', same.equal && same.unexpected.length === 0 && same.cases === cases.length);

  const mutated = JSON.parse(JSON.stringify(report));
  mutated.cases[0].stdout += ' changed';
  const red = equiv.compareReports(report, mutated, []);
  check('equiv unexpected mutation goes red', red.equal === false && red.unexpected.some((d) => d.caseId === cases[0].id && d.field === 'stdout'));

  const allowed = equiv.compareReports(report, mutated, [{ caseId: cases[0].id, field: 'stdout', reason: 'self-test explicit allowance' }]);
  check('equiv exact allowed difference is recorded but green', allowed.equal === true && allowed.allowed.length === 1);
  let dupCaseErr = '';
  try {
    const dupReport = JSON.parse(JSON.stringify(report));
    dupReport.cases.push(JSON.parse(JSON.stringify(dupReport.cases[0])));
    dupReport.normalization.pathPrefixes.push(dupReport.cases[0].sandboxRoot);
    equiv.compareReports(report, dupReport, []);
  } catch (e) { dupCaseErr = e.message; }
  check('equiv rejects duplicate report case ids fail-closed', /duplicate case id/.test(dupCaseErr), dupCaseErr);

  let dupAllowErr = '';
  try {
    equiv.compareReports(report, mutated, [
      { caseId: cases[0].id, field: 'stdout', reason: 'a' },
      { caseId: cases[0].id, field: 'stdout', reason: 'b' },
    ]);
  } catch (e) { dupAllowErr = e.message; }
  check('equiv rejects duplicate allowed-difference keys fail-closed', /duplicate allowed difference/.test(dupAllowErr), dupAllowErr);


  const compareClone = (value) => JSON.parse(JSON.stringify(value));
  const compareRebindInput = (c, prompt) => {
    c.inputCanonical = JSON.stringify(equiv.stable({ prompt, event: c.event, index: 0 }));
    c.inputSha256 = crypto.createHash('sha256').update(c.inputCanonical).digest('hex');
  };
  const expectCompareInfraCode = (name, mutate, allowanceRows, expectedCode, expectedReason) => {
    const left = compareClone(report), right = compareClone(report);
    mutate(left, right);
    let err = null, returned = null;
    try { returned = equiv.compareReports(left, right, allowanceRows); } catch (e) { err = e; }
    check(name,
      err instanceof runner.EquivInfrastructureError
        && err.code === expectedCode
        && (!expectedReason || (err.detail && err.detail.reason === expectedReason)),
      JSON.stringify({
        returned,
        error: err && { name: err.constructor && err.constructor.name, code: err.code, detail: err.detail, message: err.message },
      }));
  };

  {
    const left = compareClone(report), right = compareClone(report);
    const result = equiv.compareReports(left, right, []);
    check('R15d-B compare healthy identical reports with runner-shaped stateTree compare green',
      result.equal === true && result.unexpected.length === 0);
  }
  {
    const left = compareClone(report), right = compareClone(report);
    right.cases[0].stdout = 'changed';
    const result = equiv.compareReports(left, right, [{ caseId: left.cases[0].id, field: 'stdout', reason: 'reviewed output allowance' }]);
    check('R15d-B compare healthy non-identity stdout allowance remains available',
      result.equal === true && result.allowed.length === 1 && result.allowed[0].field === 'stdout',
      JSON.stringify(result));
  }
  {
    const left = compareClone(report), right = compareClone(report);
    for (const candidate of [left, right]) {
      for (const c of candidate.cases) {
        c.hookResults[0].disposition = 'private-exclude';
        c.hookResults[0].status = 'skipped';
        c.hookResults[0].reason = 'synthetic comparator contract fixture';
        c.hookResults[0].externalDependencies = [];
        delete c.hookResults[0].exitCode;
        delete c.hookResults[0].outcome;
        delete c.hookResults[0].businessExitCodes;
        delete c.hookResults[0].runtimeHealth;
        candidate.cases.find((x) => x.id === c.id).executedHooks = 0;
      }
    }
    const result = equiv.compareReports(left, right, []);
    check('R15d-B compare healthy skipped private-exclude disposition remains valid',
      result.equal === true, JSON.stringify(result));
  }

  expectCompareInfraCode(
    'R15d-B compare allowance cannot target inputSha256',
    (left, right) => { compareRebindInput(right.cases[0], 'different'); },
    [{ caseId: report.cases[0].id, field: 'inputSha256', reason: 'must never waive input identity' }],
    'allowance-forbidden-field');

  expectCompareInfraCode(
    'R15d-B compare allowance cannot target inputCanonical',
    (left, right) => { compareRebindInput(right.cases[0], 'different'); },
    [{ caseId: report.cases[0].id, field: 'inputCanonical', reason: 'must never waive normalized input identity' }],
    'allowance-forbidden-field');

  expectCompareInfraCode(
    'R15d-B compare unknown hook disposition is rejected',
    (left, right) => {
      left.cases[0].hookResults[0].disposition = 'mystery';
      right.cases[0].hookResults[0].disposition = 'mystery';
    },
    [],
    'report-bad-disposition',
    'unknown-disposition');

  expectCompareInfraCode(
    'R15d-B compare skipped plus port disposition is rejected',
    (left, right) => {
      for (const candidate of [left, right]) {
        candidate.cases[0].hookResults[0].status = 'skipped';
        candidate.cases[0].hookResults[0].reason = 'synthetic comparator contract fixture';
        candidate.cases[0].hookResults[0].externalDependencies = [];
        candidate.cases[0].executedHooks = 0;
      }
    },
    [],
    'report-bad-disposition',
    'skipped-disposition-mismatch');

  expectCompareInfraCode(
    'R15d-B compare null stateTree entry is rejected',
    (left, right) => {
      left.cases[0].stateTree = { 'bad.txt': null };
      right.cases[0].stateTree = { 'bad.txt': null };
    },
    [],
    'report-bad-state-entry',
    'entry-must-be-object');

  expectCompareInfraCode(
    'R15d-B compare stateTree digest missing binary is rejected',
    (left, right) => {
      left.cases[0].stateTree = { 'bad.txt': { sha256: 'c'.repeat(64), size: 1 } };
      right.cases[0].stateTree = { 'bad.txt': { sha256: 'c'.repeat(64), size: 1 } };
    },
    [],
    'report-bad-state-entry',
    'invalid-file-entry');

} catch (e) {
  console.error(e && e.stack || e);
  fail++;
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}

console.log('P2-FREEZE-EQUIV-SELFTEST ' + JSON.stringify({ pass, fail }));
process.exit(fail ? 1 : 0);
