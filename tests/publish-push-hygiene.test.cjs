#!/usr/bin/env node
// tests/publish-push-hygiene.test.cjs -- W22-U3 unit tests for scripts/publish-public.cjs's ref/push
// hygiene: orphan idempotence + CAS on `public` (codex #9), strict remote identification + token
// handling (codex #10), credential-free GATE2/GATE3 subprocess env (blind spot 6), and the
// private-remote (`dev/main`) monotonicity check on `--push` (blind spot 5).
//
// EXCLUDED from the public export (see publish.manifest.json's exclude list), same rationale as
// tests/publish-source-freeze.test.cjs and tests/publish-leak-scan.test.cjs: it requires
// scripts/publish-public.cjs and publish.manifest.json, both private-only. Deliberately does NOT
// contain the literal string "--self-test" so bin/axmem's component-selftest auto-discovery never
// sweeps it in.
//
// Every test that touches the real `public` ref of this clone saves its value first and restores it in
// a `finally`, exactly like tests/publish-source-freeze.test.cjs's own convention -- no test here
// leaves `public`/`main` moved, or any extra remote configured, once it finishes. All git operations in
// this file stay entirely local (a disposable mktemp'd bare repo stands in for `dev` and for the token
// push destination) -- nothing here ever contacts a real network remote.
//
// A note on the CAS test (ii): reproducing the EXACT intra-function race ("public` moves between
// commitOntoPublic's read and its update-ref call") deterministically, from a single-threaded test,
// would require either hooking into the production function's internals (not exposed, and not worth
// adding purely for testability) or a timing-based race against a second real process (flaky). Instead,
// like the existing TOCTOU test in publish-source-freeze.test.cjs ("simulates... without actually doing
// so"), this file tests the OBSERVABLE CONTRACT: (ii-a) the literal `git update-ref <ref> <new> <old>`
// command commitOntoPublic relies on refuses a stale <old> (proven directly against the real `public`
// ref), and (ii-b) commitOntoPublic itself, when `public` already holds a same-tree "concurrent winner"
// at the moment of its very first read, reports idempotent rather than creating a duplicate or erroring
// -- never silently overwriting a value it didn't expect.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const pp = require('../scripts/publish-public.cjs');
const REPO_ROOT = pp.REPO_ROOT;

// Belt-and-braces identity for the `git commit-tree` calls this file makes directly (and that
// commitOntoPublic makes internally) -- set as env, never `git config --global`, per the task's clone
// contract. A caller that already exported GIT_AUTHOR_*/GIT_COMMITTER_* keeps those values.
process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'w22u3-test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'w22u3-test@example.invalid';
process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || 'w22u3-test';
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || 'w22u3-test@example.invalid';

let ok = 0;
let total = 0;
const failures = [];

function check(label, cond) {
  total++;
  if (cond) { ok++; console.log('  ok   ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label); }
}

function expectThrows(label, fn) {
  total++;
  try {
    fn();
    failures.push(label + ' (did not throw)');
    console.log('  FAIL ' + label + ' (did not throw)');
  } catch (e) {
    ok++;
    console.log('  ok   ' + label + ' -> ' + String(e.message || e).slice(0, 140));
  }
}

function gitCwd(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd: REPO_ROOT, encoding: 'utf8' }, opts || {}));
}

function currentPublicHead() {
  try { return gitCwd(['rev-parse', 'public']).trim(); } catch { return null; }
}

function restorePublicTo(sha) {
  const cur = currentPublicHead();
  if (cur === sha) return;
  gitCwd(['update-ref', 'refs/heads/public', sha, cur || '']);
}

function listRemotes() {
  try { return gitCwd(['remote']).split('\n').map((s) => s.trim()).filter(Boolean); } catch { return []; }
}

// ---------------------------------------------------------------------------------------------
console.log('== commitOntoPublic (orphan mode, codex #9): idempotence also requires HEAD to be parentless ==');
{
  const originalPublicHead = currentPublicHead();
  check('precondition: `public` exists', !!originalPublicHead);
  check('precondition: `public` HEAD is already parentless', (() => {
    if (!originalPublicHead) return false;
    try { gitCwd(['rev-parse', originalPublicHead + '^']); return false; } catch { return true; }
  })());
  const T0 = gitCwd(['rev-parse', originalPublicHead + '^{tree}']).trim();
  try {
    // A: same tree + already-parentless HEAD -> idempotent, no new commit, ref unchanged.
    const r1 = pp.commitOntoPublic(null, 'deadbee', true, T0, false, null);
    check('same tree + parentless HEAD -> idempotent (created:false)', r1.created === false);
    check('`public` ref unchanged after the idempotent call', currentPublicHead() === originalPublicHead);

    // B: same tree, but HEAD now has a parent (simulating a chained commit that slipped in) -> must NOT
    // be treated as idempotent; a fresh, still-parentless orphan commit must be created instead.
    const chained = execFileSync('git', ['commit-tree', T0, '-p', originalPublicHead, '-m', 'w22-u3 test: chained same-tree commit'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    gitCwd(['update-ref', 'refs/heads/public', chained, originalPublicHead]);

    const r2 = pp.commitOntoPublic(null, 'deadbee', true, T0, false, null);
    check('same tree but HEAD has a parent -> NOT idempotent (created:true)', r2.created === true);
    check('the new commit is itself parentless (true orphan)', (() => {
      try { gitCwd(['rev-parse', r2.commit + '^']); return false; } catch { return true; }
    })());
    check('the new commit tree is unchanged', gitCwd(['rev-parse', r2.commit + '^{tree}']).trim() === T0);
  } finally {
    restorePublicTo(originalPublicHead);
    check('`public` restored to its original value', currentPublicHead() === originalPublicHead);
  }
}

// ---------------------------------------------------------------------------------------------
console.log('== commitOntoPublic (CAS, codex #9): a stale expected-old is refused, never silently overwritten ==');
{
  const originalPublicHead = currentPublicHead();
  try {
    // (ii-a) the exact primitive commitOntoPublic's update-ref call relies on: a stale/wrong
    // expected-old is refused by git itself, and the ref is left untouched.
    const bogusOld = '0'.repeat(40);
    expectThrows('git update-ref with a stale/wrong expected-old is refused', () => {
      execFileSync('git', ['update-ref', 'refs/heads/public', originalPublicHead, bogusOld], { cwd: REPO_ROOT, encoding: 'utf8' });
    });
    check('`public` unchanged after the refused update-ref attempt', currentPublicHead() === originalPublicHead);

    // (ii-b) if `public` already holds a commit with the SAME target tree at the moment commitOntoPublic
    // makes its very first read (standing in for "a concurrent identical export won the race"), it must
    // report idempotent and leave that commit alone -- never overwrite it with a redundant new commit.
    const raceTree = gitCwd(['rev-parse', originalPublicHead + '^{tree}']).trim();
    const winnerCommit = execFileSync('git', ['commit-tree', raceTree, '-m', 'w22-u3 test: simulated concurrent winner (same tree)'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    gitCwd(['update-ref', 'refs/heads/public', winnerCommit, originalPublicHead]);

    const r = pp.commitOntoPublic(null, 'deadbee', true, raceTree, false, null);
    check('a same-tree "concurrent winner" already in place is treated as idempotent', r.created === false && r.commit === winnerCommit);
    check('`public` still points at the concurrent winner, untouched', currentPublicHead() === winnerCommit);
  } finally {
    restorePublicTo(originalPublicHead);
    check('`public` restored to its original value after the CAS test block', currentPublicHead() === originalPublicHead);
  }
}

// ---------------------------------------------------------------------------------------------
console.log('== parseGithubRemoteUrl (codex #10): exactly the three accepted GitHub URL forms match ==');
{
  const forms = [
    ['https', 'https://github.com/axervice/AxMem.git'],
    ['https, no .git', 'https://github.com/axervice/AxMem'],
    ['ssh://', 'ssh://git@github.com/axervice/AxMem.git'],
    ['scp-like', 'git@github.com:axervice/AxMem.git'],
  ];
  for (const [label, url] of forms) {
    const parsed = pp.parseGithubRemoteUrl(url);
    check('accepted form matches: ' + label, !!parsed && parsed.host === 'github.com' && parsed.owner === 'axervice' && parsed.repo === 'AxMem');
  }
  check('evil host does not match', pp.parseGithubRemoteUrl('https://evil.example/axervice/AxMem.git') === null);
  check('non-github ssh host does not match', pp.parseGithubRemoteUrl('git@gitlab.com:axervice/AxMem.git') === null);
  const wrongOwnerParsed = pp.parseGithubRemoteUrl('https://github.com/otherowner/AxMem.git');
  check('a wrong-owner URL still parses structurally (owner match is ensurePublicRemote\'s job)', !!wrongOwnerParsed && wrongOwnerParsed.owner === 'otherowner' && wrongOwnerParsed.repo === 'AxMem');
}

console.log('== ensurePublicRemote (codex #10): wrong-owner/evil-host never selected; two matches refused ==');
{
  const manifest = pp.readManifest(); // on-disk (working-tree) manifest -- has this unit's publicRemote field
  check('precondition: no remotes configured before this test', listRemotes().length === 0);

  gitCwd(['remote', 'add', 'test-wrong-owner', 'https://github.com/otherowner/AxMem.git']);
  try {
    const r = pp.ensurePublicRemote(manifest);
    check('wrong-owner remote is not selected as the match', r.remote !== 'test-wrong-owner');
    if (r.temporary) { try { gitCwd(['remote', 'remove', r.remote]); } catch {} }
  } finally {
    try { gitCwd(['remote', 'remove', 'test-wrong-owner']); } catch {}
  }

  gitCwd(['remote', 'add', 'test-evil-host', 'https://evil.example/axervice/AxMem.git']);
  try {
    const r = pp.ensurePublicRemote(manifest);
    check('evil-host remote is not selected as the match', r.remote !== 'test-evil-host');
    if (r.temporary) { try { gitCwd(['remote', 'remove', r.remote]); } catch {} }
  } finally {
    try { gitCwd(['remote', 'remove', 'test-evil-host']); } catch {}
  }

  gitCwd(['remote', 'add', 'test-real-match', 'git@github.com:axervice/AxMem.git']);
  try {
    const r = pp.ensurePublicRemote(manifest);
    check('the single real match is selected, not treated as temporary', r.remote === 'test-real-match' && r.temporary === false);
  } finally {
    try { gitCwd(['remote', 'remove', 'test-real-match']); } catch {}
  }

  gitCwd(['remote', 'add', 'test-match-a', 'https://github.com/axervice/AxMem.git']);
  gitCwd(['remote', 'add', 'test-match-b', 'git@github.com:axervice/AxMem.git']);
  try {
    expectThrows('two remotes both matching the public repo -> refused as ambiguous', () => pp.ensurePublicRemote(manifest));
  } finally {
    try { gitCwd(['remote', 'remove', 'test-match-a']); } catch {}
    try { gitCwd(['remote', 'remove', 'test-match-b']); } catch {}
  }

  check('no remotes left configured after all ensurePublicRemote sub-tests', listRemotes().length === 0);
}

console.log('== ensurePublicRemote (codex #10): no existing match -> token-free dedicated remote ==');
{
  const manifest = pp.readManifest();
  check('precondition: no remotes configured before this test', listRemotes().length === 0);
  const prevToken = process.env.PUBLIC_REPO_TOKEN;
  process.env.PUBLIC_REPO_TOKEN = 'FAKE-TEST-TOKEN-ENSURE-REMOTE';
  let result = null;
  try {
    result = pp.ensurePublicRemote(manifest);
    check('created a temporary, dedicated remote (the CI-style no-existing-match path)', result.temporary === true);
    const url = gitCwd(['remote', 'get-url', result.remote]).trim();
    check('dedicated remote URL is the plain https GitHub URL', url === 'https://github.com/axervice/AxMem.git');
    check('dedicated remote URL does NOT embed the token', url.indexOf('FAKE-TEST-TOKEN-ENSURE-REMOTE') === -1);
  } finally {
    if (result && result.temporary) { try { gitCwd(['remote', 'remove', result.remote]); } catch {} }
    if (prevToken === undefined) delete process.env.PUBLIC_REPO_TOKEN; else process.env.PUBLIC_REPO_TOKEN = prevToken;
  }
  check('no remotes left configured after cleanup', listRemotes().length === 0);
}

// ---------------------------------------------------------------------------------------------
console.log('== pushPublicBranch (codex #10): a token push never lands in .git/config; temp remote cleaned up ==');
{
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-bare-'));
  execFileSync('git', ['init', '--bare', '-q', bareDir]);
  const fakeToken = 'FAKE-TEST-TOKEN-DO-NOT-USE-1234567890';
  const remoteName = 'test-push-hygiene-target';
  try { gitCwd(['remote', 'remove', remoteName]); } catch {}
  try {
    gitCwd(['remote', 'add', remoteName, bareDir]);
    pp.pushPublicBranch(remoteName, 'main:refs/heads/test-target', null, fakeToken);

    let cfgOut = '';
    try { cfgOut = gitCwd(['config', '--get-regexp', 'remote\\..*\\.url']); } catch { cfgOut = ''; }
    check('token never appears in .git/config after a token push', cfgOut.indexOf(fakeToken) === -1);

    const bareRef = execFileSync('git', ['--git-dir', bareDir, 'rev-parse', 'refs/heads/test-target'], { encoding: 'utf8' }).trim();
    const localMain = gitCwd(['rev-parse', 'main']).trim();
    check('the push actually landed the expected commit on the (local, file-transport) bare repo', bareRef === localMain);
  } finally {
    try { gitCwd(['remote', 'remove', remoteName]); } catch {}
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
  check('temporary remote removed after push', listRemotes().indexOf(remoteName) === -1);
}

// ---------------------------------------------------------------------------------------------
console.log('== envWithoutCredentials (blind spot 6): stripped for GATE2/GATE3-style subprocesses, present for push ==');
{
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-envdump-'));
  const dumpScript = path.join(dumpDir, 'dump-env.js');
  fs.writeFileSync(dumpScript, "process.stdout.write(JSON.stringify({hasToken:'PUBLIC_REPO_TOKEN' in process.env,hasGithubToken:'GITHUB_TOKEN' in process.env,hasGhToken:'GH_TOKEN' in process.env}));\n");
  const prevToken = process.env.PUBLIC_REPO_TOKEN;
  const prevGithubToken = process.env.GITHUB_TOKEN;
  process.env.PUBLIC_REPO_TOKEN = 'fake-token-for-gate-env-test';
  process.env.GITHUB_TOKEN = 'fake-github-token-for-gate-env-test';
  try {
    check('CREDENTIAL_ENV_KEYS covers PUBLIC_REPO_TOKEN/GITHUB_TOKEN/GH_TOKEN', ['PUBLIC_REPO_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'].every((k) => pp.CREDENTIAL_ENV_KEYS.includes(k)));

    // GATE2/GATE3 build their subprocess env from envWithoutCredentials() -- simulated here with the
    // same env-dumping stub gate2/gate3 would run, to prove the mechanism actually strips the vars from
    // what a real child process sees (not just from a returned object nobody uses).
    const gateEnv = pp.envWithoutCredentials();
    const gateRes = spawnSync(process.execPath, [dumpScript], { env: gateEnv, encoding: 'utf8' });
    const gateParsed = JSON.parse(gateRes.stdout.trim());
    check('gate-style (envWithoutCredentials) subprocess env has PUBLIC_REPO_TOKEN stripped', gateParsed.hasToken === false);
    check('gate-style subprocess env has GITHUB_TOKEN stripped', gateParsed.hasGithubToken === false);

    // The push call, by contrast, never routes through envWithoutCredentials() -- it inherits raw
    // process.env (git() calls execFileSync with no explicit `env`, i.e. the default inherit-parent-env
    // behavior), which is how PUBLIC_REPO_TOKEN reaches pushPublicBranch's own process.env read.
    const pushRes = spawnSync(process.execPath, [dumpScript], { env: process.env, encoding: 'utf8' });
    const pushParsed = JSON.parse(pushRes.stdout.trim());
    check('push-style (raw process.env) subprocess env still has PUBLIC_REPO_TOKEN', pushParsed.hasToken === true);
  } finally {
    if (prevToken === undefined) delete process.env.PUBLIC_REPO_TOKEN; else process.env.PUBLIC_REPO_TOKEN = prevToken;
    if (prevGithubToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevGithubToken;
    fs.rmSync(dumpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
console.log('== checkPrivateMonotonicity (blind spot 5): dev ahead / equal / behind, and --allow-behind-private ==');
{
  const head = gitCwd(['rev-parse', 'main']).trim();
  const parent1 = gitCwd(['rev-parse', 'main~1']).trim();
  check('precondition: main~1 is a real ancestor distinct from main', parent1.length === 40 && parent1 !== head);

  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-devbare-'));
  execFileSync('git', ['init', '--bare', '-q', bareDir]);
  const remoteName = 'test-dev-monotonicity';
  try { gitCwd(['remote', 'remove', remoteName]); } catch {}
  gitCwd(['remote', 'add', remoteName, bareDir]);

  function setDevMainTo(sha) {
    gitCwd(['push', '--quiet', '--force', remoteName, sha + ':refs/heads/main']);
  }

  try {
    check('missing remote is skipped, not refused (the CI-checkout case)', (() => {
      const r = pp.checkPrivateMonotonicity(head, false, 'test-remote-that-does-not-exist');
      return r.checked === false && r.allowedBehind === false;
    })());

    // "ahead": dev/main = HEAD, sourceOid = an ancestor of HEAD -> dev/main is AHEAD of the frozen
    // source (the source is stale relative to the private canonical branch) -> refused.
    setDevMainTo(head);
    expectThrows('dev/main ahead of the frozen source is refused', () => pp.checkPrivateMonotonicity(parent1, false, remoteName));

    // "equal": dev/main == sourceOid -> allowed.
    const rEqual = pp.checkPrivateMonotonicity(head, false, remoteName);
    check('dev/main equal to the frozen source is allowed', rEqual.checked === true && rEqual.allowedBehind === false);

    // "behind": dev/main is an ancestor of sourceOid (the source is ahead of/at dev/main) -> allowed.
    setDevMainTo(parent1);
    const rBehind = pp.checkPrivateMonotonicity(head, false, remoteName);
    check('dev/main behind (an ancestor of) the frozen source is allowed', rBehind.checked === true && rBehind.allowedBehind === false);

    // --allow-behind-private overrides an "ahead" refusal.
    setDevMainTo(head);
    const rOverride = pp.checkPrivateMonotonicity(parent1, true, remoteName);
    check('--allow-behind-private overrides an "ahead" dev/main', rOverride.checked === true && rOverride.allowedBehind === true && rOverride.devMainOid === head);

    // The override is recorded as a commit-message trailer by commitOntoPublic.
    const originalPublicHead = currentPublicHead();
    try {
      const differentTree = gitCwd(['rev-parse', 'main~2^{tree}']).trim();
      check('precondition: the private source tree differs from `public`\'s exported tree', differentTree !== gitCwd(['rev-parse', originalPublicHead + '^{tree}']).trim());
      const r = pp.commitOntoPublic(null, 'deadbee', true, differentTree, false, rOverride);
      check('the override still produces a real commit', r.created === true);
      const commitMsg = gitCwd(['log', '-1', '--format=%B', r.commit]);
      check('commit message trailer records --allow-behind-private and both OIDs', commitMsg.indexOf('--allow-behind-private') !== -1 && commitMsg.indexOf(rOverride.devMainOid) !== -1 && commitMsg.indexOf(rOverride.sourceOid) !== -1);
    } finally {
      restorePublicTo(originalPublicHead);
      check('`public` restored to its original value after the monotonicity/trailer test', currentPublicHead() === originalPublicHead);
    }
  } finally {
    try { gitCwd(['remote', 'remove', remoteName]); } catch {}
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
console.log('\npublish-push-hygiene self-test ' + ok + '/' + total);
if (ok !== total) {
  console.error('FAILED: ' + failures.join('; '));
  process.exitCode = 1;
}
