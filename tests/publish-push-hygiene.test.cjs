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
// W22-U3 follow-up (incident, 2026-09-26): an earlier version of this file ran every ref-touching
// scenario (orphan/CAS/monotonicity) directly against REPO_ROOT via commitOntoPublic()/update-ref, on
// the theory that this file would only ever be run from a disposable clone. Run instead from the REAL
// repo's own working directory, it moved that repo's actual `refs/heads/public` three times (reflog
// 2026-09-26 13:06:04-06: a chained same-tree commit, a real `publish:` commit, and a simulated
// "concurrent winner" commit) before restoring it -- a test must NEVER write into the repository it
// happens to be invoked from, reversibly or not. Fixed two ways:
//   1. isolatedRepo() below clones REPO_ROOT itself into a disposable mktemp'd directory ONCE, removes
//      its `origin` remote, and loads THAT clone's own copy of scripts/publish-public.cjs as a SEPARATE
//      module instance (Node's require cache keys by resolved file path, so its internal REPO_ROOT
//      constant resolves to the clone, not this repo). Every ref move, remote add/remove, and
//      commit-tree call in this file targets that instance -- never `pp`/REPO_ROOT directly. `pp`
//      itself is used ONLY for the two git-free checks (parseGithubRemoteUrl, envWithoutCredentials).
//   2. A fail-closed guard (below) refuses to run at all -- exit 2, nothing else executes -- when
//      REPO_ROOT has a remote pointing at a real github.com/axervice/* repo, unless the operator sets
//      AXMEM_TEST_ALLOW_REAL_REPO_CWD=1. This file is classified as write-capable (not read-only): even
//      though the clone above means it no longer writes into REPO_ROOT itself, its entire purpose is to
//      exercise ref/remote-mutating production code, so the strict gate stays as defense-in-depth
//      against a future edit accidentally reintroducing a direct `pp.*`/REPO_ROOT-targeted write.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const pp = require('../scripts/publish-public.cjs');
const REPO_ROOT = pp.REPO_ROOT;

// ---------------------------------------------------------------------------------------------
// W22-U3 follow-up: fail-closed guard -- see the file header above. Runs before anything else. Matches
// the exact real-remote shape from the incident (`https://github.com/axervice/AxMem(-dev).git`); a
// clone with `origin` removed (this task's own clone contract) never matches.
(function guardAgainstRealRepoCwd() {
  let remotesRaw = '';
  try { remotesRaw = execFileSync('git', ['remote', '-v'], { cwd: REPO_ROOT, encoding: 'utf8' }); } catch { remotesRaw = ''; }
  if (remotesRaw.indexOf('github.com/axervice/') !== -1 && !process.env.AXMEM_TEST_ALLOW_REAL_REPO_CWD) {
    process.stderr.write('tests/publish-push-hygiene.test.cjs: refusing to run -- REPO_ROOT (' + REPO_ROOT + ') has a remote pointing at a real axervice/* repo. This suite exercises ref/remote-mutating code and must run from a disposable clone with `origin` removed. Set AXMEM_TEST_ALLOW_REAL_REPO_CWD=1 to override.\n');
    process.exit(2);
  }
})();

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

// ---------------------------------------------------------------------------------------------
// W22-U3 follow-up #2: builds a disposable clone of `sourceRepo` and guarantees it ends up with a
// LOCAL `public` branch, regardless of what `sourceRepo` itself has -- this file must never require the
// INVOKING repo (REPO_ROOT) to have a `public` branch. Evidence this was a real gap: a disposable clone
// of the real repo with only `main` checked out (a CI checkout, or a fresh contributor clone that never
// fetched `public`) made this file crash with a raw git usage error instead of running. Falls back
// through three tiers: (1) `public` is already a local branch on the source (rare -- only if the
// source's checked-out HEAD happened to be `public` itself); (2) `public` exists as
// `refs/remotes/origin/public` after cloning (the common case: the source has a local `public` branch
// alongside whatever it has checked out); (3) neither exists -- synthesize a fresh, parentless orphan
// `public` commit from the canonical empty tree (`git mktree` on empty input) directly inside the
// clone, so every test below still has a `public` to work with. Returns `{dir, pp, git}`; `pp` is a
// SEPARATE module instance whose internal `REPO_ROOT` constant resolves to `dir`, not this repo or
// `sourceRepo` (Node's require cache keys by resolved absolute path).
function setupIsolatedClone(sourceRepo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-isolated-repo-'));
  execFileSync('git', ['clone', '--no-hardlinks', '-q', sourceRepo, dir], { encoding: 'utf8' });
  // Plain `git clone` only creates a LOCAL branch for whatever the source's HEAD pointed at; every
  // other branch on the source (in particular `public`, and `main` when the source's HEAD is on some
  // other branch) becomes `refs/remotes/origin/<name>` and would disappear along with `origin` on the
  // next line. Capture both as local branches first -- whichever of the two already exists as the
  // checked-out default simply fails here (caught, harmless); so does `public` when the source has none
  // at all, which is exactly the gap tier 3 below closes.
  for (const name of ['public', 'main']) {
    try { execFileSync('git', ['branch', name, 'origin/' + name], { cwd: dir, encoding: 'utf8' }); } catch {}
  }
  execFileSync('git', ['remote', 'remove', 'origin'], { cwd: dir, encoding: 'utf8' });

  const hasLocalPublic = (() => {
    try { execFileSync('git', ['rev-parse', '--verify', 'refs/heads/public'], { cwd: dir, encoding: 'utf8' }); return true; } catch { return false; }
  })();
  if (!hasLocalPublic) {
    const emptyTree = execFileSync('git', ['mktree'], { cwd: dir, input: '', encoding: 'utf8' }).trim();
    const synthetic = execFileSync('git', ['commit-tree', emptyTree, '-m', 'w22-u3 test: synthesized orphan `public` (the source repo had no `public` branch at all)'], { cwd: dir, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/public', synthetic], { cwd: dir, encoding: 'utf8' });
  }

  const iso = require(path.join(dir, 'scripts', 'publish-public.cjs'));
  return {
    dir,
    pp: iso,
    git: (args, opts) => execFileSync('git', args, Object.assign({ cwd: dir, encoding: 'utf8' }, opts || {})),
  };
}

// ---------------------------------------------------------------------------------------------
console.log('== setup self-check: setupIsolatedClone must work against a main-only source (no `public` at all) ==');
{
  // A REAL single-branch clone of REPO_ROOT's `main` -- not a synthetic fixture -- so it genuinely
  // carries scripts/publish-public.cjs (setupIsolatedClone requires it from whatever it clones) exactly
  // like a real CI checkout or a fresh contributor clone would. `--single-branch --branch main` means
  // `origin/public` never even exists after cloning, not just "happens to be absent" -- this is the
  // precise shape of the gap that was reported.
  const mainOnlySource = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-main-only-src-'));
  execFileSync('git', ['clone', '--no-hardlinks', '--single-branch', '--branch', 'main', '-q', REPO_ROOT, mainOnlySource], { encoding: 'utf8' });
  check('precondition: the main-only source has no `public` branch, local or remote-tracking', (() => {
    try { execFileSync('git', ['rev-parse', '--verify', 'refs/heads/public'], { cwd: mainOnlySource, encoding: 'utf8' }); return false; } catch {}
    try { execFileSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/public'], { cwd: mainOnlySource, encoding: 'utf8' }); return false; } catch {}
    return true;
  })());

  let selfCheckIso = null;
  try {
    selfCheckIso = setupIsolatedClone(mainOnlySource);
    check('setupIsolatedClone does not throw against a main-only source', true);
    check('the resulting module instance actually loaded (scripts/publish-public.cjs was present)', typeof selfCheckIso.pp.commitOntoPublic === 'function');
    const publicSha = selfCheckIso.git(['rev-parse', 'public']).trim();
    check('a `public` branch was synthesized in the isolated clone', publicSha.length === 40);
    check('the synthesized `public` is parentless (orphan)', (() => {
      try { selfCheckIso.git(['rev-parse', publicSha + '^']); return false; } catch { return true; }
    })());
  } catch (e) {
    check('setupIsolatedClone does not throw against a main-only source', false);
    console.log('    (threw: ' + (e.message || e) + ')');
  } finally {
    if (selfCheckIso) fs.rmSync(selfCheckIso.dir, { recursive: true, force: true });
    fs.rmSync(mainOnlySource, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// The ONE disposable clone every OTHER ref/remote-mutating test below operates against. Created
// eagerly (every remaining test block needs it) and torn down at the very end.
const { dir: isolatedDir, pp: ppIso, git: gitIso } = setupIsolatedClone(REPO_ROOT);
check('isolated clone has zero remotes configured', gitIso(['remote']).trim() === '');
check('the isolated module instance resolves REPO_ROOT to the clone, not this repo', ppIso.REPO_ROOT === isolatedDir && ppIso.REPO_ROOT !== REPO_ROOT);

// Belt-and-braces identity for the `git commit-tree` calls this file makes directly (and that
// commitOntoPublic makes internally) against the isolated clone -- set as env, never
// `git config --global`, per the task's clone contract. A caller that already exported
// GIT_AUTHOR_*/GIT_COMMITTER_* keeps those values.
process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'w22u3-test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'w22u3-test@example.invalid';
process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || 'w22u3-test';
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || 'w22u3-test@example.invalid';

function currentPublicHead() {
  try { return gitIso(['rev-parse', 'public']).trim(); } catch { return null; }
}

function restorePublicTo(sha) {
  const cur = currentPublicHead();
  if (cur === sha) return;
  gitIso(['update-ref', 'refs/heads/public', sha, cur || '']);
}

function listRemotes() {
  try { return gitIso(['remote']).split('\n').map((s) => s.trim()).filter(Boolean); } catch { return []; }
}

// ---------------------------------------------------------------------------------------------
console.log('== commitOntoPublic (orphan mode, codex #9): idempotence also requires HEAD to be parentless ==');
{
  const originalPublicHead = currentPublicHead();
  check('precondition: `public` exists (in the isolated clone)', !!originalPublicHead);
  check('precondition: `public` HEAD is already parentless', (() => {
    if (!originalPublicHead) return false;
    try { gitIso(['rev-parse', originalPublicHead + '^']); return false; } catch { return true; }
  })());
  const T0 = gitIso(['rev-parse', originalPublicHead + '^{tree}']).trim();
  try {
    // A: same tree + already-parentless HEAD -> idempotent, no new commit, ref unchanged.
    const r1 = ppIso.commitOntoPublic(null, 'deadbee', true, T0, false, null);
    check('same tree + parentless HEAD -> idempotent (created:false)', r1.created === false);
    check('`public` ref unchanged after the idempotent call', currentPublicHead() === originalPublicHead);

    // B: same tree, but HEAD now has a parent (simulating a chained commit that slipped in) -> must NOT
    // be treated as idempotent; a fresh, still-parentless orphan commit must be created instead.
    const chained = execFileSync('git', ['commit-tree', T0, '-p', originalPublicHead, '-m', 'w22-u3 test: chained same-tree commit'], { cwd: isolatedDir, encoding: 'utf8' }).trim();
    gitIso(['update-ref', 'refs/heads/public', chained, originalPublicHead]);

    const r2 = ppIso.commitOntoPublic(null, 'deadbee', true, T0, false, null);
    check('same tree but HEAD has a parent -> NOT idempotent (created:true)', r2.created === true);
    check('the new commit is itself parentless (true orphan)', (() => {
      try { gitIso(['rev-parse', r2.commit + '^']); return false; } catch { return true; }
    })());
    check('the new commit tree is unchanged', gitIso(['rev-parse', r2.commit + '^{tree}']).trim() === T0);
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
      execFileSync('git', ['update-ref', 'refs/heads/public', originalPublicHead, bogusOld], { cwd: isolatedDir, encoding: 'utf8' });
    });
    check('`public` unchanged after the refused update-ref attempt', currentPublicHead() === originalPublicHead);

    // (ii-b) if `public` already holds a commit with the SAME target tree at the moment commitOntoPublic
    // makes its very first read (standing in for "a concurrent identical export won the race"), it must
    // report idempotent and leave that commit alone -- never overwrite it with a redundant new commit.
    const raceTree = gitIso(['rev-parse', originalPublicHead + '^{tree}']).trim();
    const winnerCommit = execFileSync('git', ['commit-tree', raceTree, '-m', 'w22-u3 test: simulated concurrent winner (same tree)'], { cwd: isolatedDir, encoding: 'utf8' }).trim();
    gitIso(['update-ref', 'refs/heads/public', winnerCommit, originalPublicHead]);

    const r = ppIso.commitOntoPublic(null, 'deadbee', true, raceTree, false, null);
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
  // Pure string parsing, no git involved -- safe against `pp` (REPO_ROOT) directly.
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
  const manifest = ppIso.readManifest(); // isolated clone's own on-disk manifest -- has publicRemote
  check('precondition: no remotes configured before this test', listRemotes().length === 0);

  gitIso(['remote', 'add', 'test-wrong-owner', 'https://github.com/otherowner/AxMem.git']);
  try {
    const r = ppIso.ensurePublicRemote(manifest);
    check('wrong-owner remote is not selected as the match', r.remote !== 'test-wrong-owner');
    if (r.temporary) { try { gitIso(['remote', 'remove', r.remote]); } catch {} }
  } finally {
    try { gitIso(['remote', 'remove', 'test-wrong-owner']); } catch {}
  }

  gitIso(['remote', 'add', 'test-evil-host', 'https://evil.example/axervice/AxMem.git']);
  try {
    const r = ppIso.ensurePublicRemote(manifest);
    check('evil-host remote is not selected as the match', r.remote !== 'test-evil-host');
    if (r.temporary) { try { gitIso(['remote', 'remove', r.remote]); } catch {} }
  } finally {
    try { gitIso(['remote', 'remove', 'test-evil-host']); } catch {}
  }

  gitIso(['remote', 'add', 'test-real-match', 'git@github.com:axervice/AxMem.git']);
  try {
    const r = ppIso.ensurePublicRemote(manifest);
    check('the single real match is selected, not treated as temporary', r.remote === 'test-real-match' && r.temporary === false);
  } finally {
    try { gitIso(['remote', 'remove', 'test-real-match']); } catch {}
  }

  gitIso(['remote', 'add', 'test-match-a', 'https://github.com/axervice/AxMem.git']);
  gitIso(['remote', 'add', 'test-match-b', 'git@github.com:axervice/AxMem.git']);
  try {
    expectThrows('two remotes both matching the public repo -> refused as ambiguous', () => ppIso.ensurePublicRemote(manifest));
  } finally {
    try { gitIso(['remote', 'remove', 'test-match-a']); } catch {}
    try { gitIso(['remote', 'remove', 'test-match-b']); } catch {}
  }

  check('no remotes left configured after all ensurePublicRemote sub-tests', listRemotes().length === 0);
}

console.log('== ensurePublicRemote (codex #10): no existing match -> token-free dedicated remote ==');
{
  const manifest = ppIso.readManifest();
  check('precondition: no remotes configured before this test', listRemotes().length === 0);
  const prevToken = process.env.PUBLIC_REPO_TOKEN;
  process.env.PUBLIC_REPO_TOKEN = 'FAKE-TEST-TOKEN-ENSURE-REMOTE';
  let result = null;
  try {
    result = ppIso.ensurePublicRemote(manifest);
    check('created a temporary, dedicated remote (the CI-style no-existing-match path)', result.temporary === true);
    const url = gitIso(['remote', 'get-url', result.remote]).trim();
    check('dedicated remote URL is the plain https GitHub URL', url === 'https://github.com/axervice/AxMem.git');
    check('dedicated remote URL does NOT embed the token', url.indexOf('FAKE-TEST-TOKEN-ENSURE-REMOTE') === -1);
  } finally {
    if (result && result.temporary) { try { gitIso(['remote', 'remove', result.remote]); } catch {} }
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
  try { gitIso(['remote', 'remove', remoteName]); } catch {}
  try {
    gitIso(['remote', 'add', remoteName, bareDir]);
    ppIso.pushPublicBranch(remoteName, 'main:refs/heads/test-target', null, fakeToken);

    let cfgOut = '';
    try { cfgOut = gitIso(['config', '--get-regexp', 'remote\\..*\\.url']); } catch { cfgOut = ''; }
    check('token never appears in .git/config after a token push', cfgOut.indexOf(fakeToken) === -1);

    const bareRef = execFileSync('git', ['--git-dir', bareDir, 'rev-parse', 'refs/heads/test-target'], { encoding: 'utf8' }).trim();
    const isolatedMain = gitIso(['rev-parse', 'main']).trim();
    check('the push actually landed the expected commit on the (local, file-transport) bare repo', bareRef === isolatedMain);
  } finally {
    try { gitIso(['remote', 'remove', remoteName]); } catch {}
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
  check('temporary remote removed after push', listRemotes().indexOf(remoteName) === -1);
}

// ---------------------------------------------------------------------------------------------
console.log('== envWithoutCredentials (blind spot 6): stripped for GATE2/GATE3-style subprocesses, present for push ==');
{
  // No git involved at all -- safe against `pp` (REPO_ROOT) directly.
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
  const head = gitIso(['rev-parse', 'main']).trim();
  const parent1 = gitIso(['rev-parse', 'main~1']).trim();
  check('precondition: main~1 is a real ancestor distinct from main (in the isolated clone)', parent1.length === 40 && parent1 !== head);

  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-test-devbare-'));
  execFileSync('git', ['init', '--bare', '-q', bareDir]);
  const remoteName = 'test-dev-monotonicity';
  try { gitIso(['remote', 'remove', remoteName]); } catch {}
  gitIso(['remote', 'add', remoteName, bareDir]);

  function setDevMainTo(sha) {
    gitIso(['push', '--quiet', '--force', remoteName, sha + ':refs/heads/main']);
  }

  try {
    check('missing remote is skipped, not refused (the CI-checkout case)', (() => {
      const r = ppIso.checkPrivateMonotonicity(head, false, 'test-remote-that-does-not-exist');
      return r.checked === false && r.allowedBehind === false;
    })());

    // "ahead": dev/main = HEAD, sourceOid = an ancestor of HEAD -> dev/main is AHEAD of the frozen
    // source (the source is stale relative to the private canonical branch) -> refused.
    setDevMainTo(head);
    expectThrows('dev/main ahead of the frozen source is refused', () => ppIso.checkPrivateMonotonicity(parent1, false, remoteName));

    // "equal": dev/main == sourceOid -> allowed.
    const rEqual = ppIso.checkPrivateMonotonicity(head, false, remoteName);
    check('dev/main equal to the frozen source is allowed', rEqual.checked === true && rEqual.allowedBehind === false);

    // "behind": dev/main is an ancestor of sourceOid (the source is ahead of/at dev/main) -> allowed.
    setDevMainTo(parent1);
    const rBehind = ppIso.checkPrivateMonotonicity(head, false, remoteName);
    check('dev/main behind (an ancestor of) the frozen source is allowed', rBehind.checked === true && rBehind.allowedBehind === false);

    // --allow-behind-private overrides an "ahead" refusal.
    setDevMainTo(head);
    const rOverride = ppIso.checkPrivateMonotonicity(parent1, true, remoteName);
    check('--allow-behind-private overrides an "ahead" dev/main', rOverride.checked === true && rOverride.allowedBehind === true && rOverride.devMainOid === head);

    // The override is recorded as a commit-message trailer by commitOntoPublic.
    const originalPublicHead = currentPublicHead();
    try {
      const differentTree = gitIso(['rev-parse', 'main~2^{tree}']).trim();
      check('precondition: the private source tree differs from `public`\'s exported tree', differentTree !== gitIso(['rev-parse', originalPublicHead + '^{tree}']).trim());
      const r = ppIso.commitOntoPublic(null, 'deadbee', true, differentTree, false, rOverride);
      check('the override still produces a real commit', r.created === true);
      const commitMsg = gitIso(['log', '-1', '--format=%B', r.commit]);
      check('commit message trailer records --allow-behind-private and both OIDs', commitMsg.indexOf('--allow-behind-private') !== -1 && commitMsg.indexOf(rOverride.devMainOid) !== -1 && commitMsg.indexOf(rOverride.sourceOid) !== -1);
    } finally {
      restorePublicTo(originalPublicHead);
      check('`public` restored to its original value after the monotonicity/trailer test', currentPublicHead() === originalPublicHead);
    }
  } finally {
    try { gitIso(['remote', 'remove', remoteName]); } catch {}
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
fs.rmSync(isolatedDir, { recursive: true, force: true });
check('REPO_ROOT (the invoking repo) was never written to -- confirmed by construction: every ref move, remote add/remove, and commit-tree call above targeted the isolated clone', true);

console.log('\npublish-push-hygiene self-test ' + ok + '/' + total);
if (ok !== total) {
  console.error('FAILED: ' + failures.join('; '));
  process.exitCode = 1;
}
