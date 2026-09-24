#!/usr/bin/env node
// AxMem fence — idempotent marker-fenced section writer. (P1 2.0, 2026-09-16)
// Root cause this guards against: every adapter that appends a governed
// section to someone else's file (codex AGENTS.md, generic instruction
// files) was hand-rolling its own begin/end scan with awk, each with its
// own edge cases (BOM, CRLF, missing trailing newline, a torn marker pair
// from an interrupted previous run). One byte-safe implementation, reused.
//
// Contract (spec P1-ADAPTERS-SPEC.md §2.0):
//   - exactly 0 or 1 complete <begin,end> marker pair is legal; a duplicate
//     or incomplete pair (missing one side, or end-before-begin) is refused
//     with rc 3 and ZERO writes / ZERO backups — never guess which one is
//     real.
//   - fenced content itself must never embed a date (callers' job, not
//     ours) — this file only proves it doesn't add one of its own.
//   - same-directory staging file + atomic rename (same filesystem, so the
//     rename is atomic on both POSIX and NTFS for a plain file — this is
//     NOT the directory-rename case D11 has separate Windows caveats for).
//   - permissions, BOM, existing line-ending convention (CRLF vs LF), and
//     "did the original file end with a trailing newline" are all read
//     from the target before any write and reapplied to the new content.
//   - --dry-run performs every check (so a caller finds out about a torn
//     fence WITHOUT writing anything) but never writes/backs up.
//   - real writes are preceded by a timestamped backup of the pre-existing
//     target under AXMEM_STATE_DIR/backups/ (no backup when the target did
//     not exist yet — there is nothing to back up).
'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./prelude.cjs');

// [Opus H1, 2026-09-17] The commit that fixed the `state/` repo-root leak
// (e1f38eb) replaced `process.cwd()` with a SECOND, hand-rolled
// implementation of "resolve the state dir" (env > os.homedir() default)
// that claimed to match lib/prelude.cjs but didn't: it skipped
// config.json's `state_dir` key entirely and never ran normalizeMsysPath()
// on AXMEM_STATE_DIR. Result: a real `wire.sh` + a real `config.json`
// with `state_dir` SET wrote the fence correctly but recorded
// lifecycle.json somewhere else entirely — `axmem uninstall` could never
// find its own manifest entry (rc 3 "no manifest entry", fence left in
// place). Now calls prelude.cjs's own resolveStateDir() — the SAME
// env > config.json > default (+normalizeMsysPath) chain every other
// consumer (uninstall.cjs, upgrade.cjs, bridge.cjs, ...) already uses —
// instead of a parallel implementation that can silently drift. Exported
// from prelude.cjs as a function (not the cached ctx.STATE_DIR constant)
// specifically so it re-resolves fresh on every call, matching this
// file's own need to be re-testable under different env/config per test
// case within one process.

function usageAndExit(code) {
  console.error('usage: fence.cjs apply <target> <content-file> <marker-name> [--dry-run] [--adapter <name>]');
  process.exit(code);
}

function fail(msg) {
  console.error(msg);
  process.exit(3);
}

function main(argv) {
  if (argv[0] !== 'apply') usageAndExit(1);
  const target = argv[1];
  const contentFile = argv[2];
  const markerName = argv[3];
  if (!target || !contentFile || !markerName) usageAndExit(1);
  const dryRun = argv.includes('--dry-run');
  const adapterIdx = argv.indexOf('--adapter');
  const adapterName = adapterIdx >= 0 ? argv[adapterIdx + 1] : null;

  const B = `<!-- ${markerName}:begin -->`;
  const E = `<!-- ${markerName}:end -->`;

  let orig = Buffer.alloc(0);
  let existed = false;
  try {
    orig = fs.readFileSync(target);
    existed = true;
  } catch (e) {
    if (e.code !== 'ENOENT') fail(`fence: cannot read ${target}: ${e.message}`);
  }

  // BOM detection (UTF-8 BOM only — the memory/instruction files this tool
  // touches are UTF-8 by contract; a non-UTF-8 BOM would corrupt the file
  // in far more places than this tool, so it's out of scope).
  let bom = Buffer.alloc(0);
  let body = orig;
  if (orig.length >= 3 && orig[0] === 0xEF && orig[1] === 0xBB && orig[2] === 0xBF) {
    bom = orig.slice(0, 3);
    body = orig.slice(3);
  }

  const text = body.toString('utf8');
  const isEmpty = text.length === 0;
  const useCRLF = /\r\n/.test(text);
  const hadTrailingNewline = isEmpty ? true : /\n$/.test(text.replace(/\r\n/g, '\n'));

  const normalized = text.replace(/\r\n/g, '\n');
  let srcLines;
  if (isEmpty) {
    srcLines = [];
  } else {
    srcLines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
  }

  const beginIdx = [];
  const endIdx = [];
  srcLines.forEach((l, i) => {
    if (l === B) beginIdx.push(i);
    if (l === E) endIdx.push(i);
  });

  if (beginIdx.length > 1 || endIdx.length > 1 || beginIdx.length !== endIdx.length) {
    fail(
      `fence: duplicate or incomplete ${markerName} marker pair in ${target} ` +
      `(begin=${beginIdx.length} end=${endIdx.length}) — refusing (rc 3, zero write, zero backup)`
    );
  }
  if (beginIdx.length === 1 && beginIdx[0] > endIdx[0]) {
    fail(`fence: ${markerName} begin marker appears after end marker in ${target} — refusing (rc 3, zero write, zero backup)`);
  }
  const hasExisting = beginIdx.length === 1;

  let contentRaw;
  try {
    contentRaw = fs.readFileSync(contentFile, 'utf8');
  } catch (e) {
    fail(`fence: cannot read content file ${contentFile}: ${e.message}`);
  }
  // The content file is the INNER body only — never the markers themselves.
  if (contentRaw.includes(B) || contentRaw.includes(E)) {
    fail(`fence: content file ${contentFile} must not itself contain the ${markerName} markers`);
  }
  let contentBody = contentRaw.replace(/\r\n/g, '\n');
  if (contentBody.endsWith('\n')) contentBody = contentBody.slice(0, -1);
  const contentLines = contentBody.length ? contentBody.split('\n') : [];

  const fenceLines = [B, ...contentLines, E];

  let newLines;
  if (hasExisting) {
    newLines = [...srcLines.slice(0, beginIdx[0]), ...fenceLines, ...srcLines.slice(endIdx[0] + 1)];
  } else if (isEmpty) {
    newLines = fenceLines;
  } else {
    newLines = [...srcLines, ...fenceLines];
  }

  let newText = newLines.join('\n');
  if (hadTrailingNewline) newText += '\n';
  if (useCRLF) newText = newText.replace(/\n/g, '\r\n');

  const newBuf = Buffer.concat([bom, Buffer.from(newText, 'utf8')]);

  function recordLifecycleTarget(preSha, postSha) {
    if (!adapterName) return;
    try {
      const lm = require('../lifecycle/install-manifest.cjs');
      const stateDir = ctx.resolveStateDir();
      lm.recordTarget(stateDir, adapterName, {
        path: path.resolve(target),
        kind: 'fence',
        identity: { begin: B, end: E },
        expected_count: 1,
        pre_sha256: preSha,
        post_sha256: postSha,
      });
    } catch (e) {
      console.error(`fence: warning — could not record lifecycle manifest entry: ${e.message}`);
    }
  }

  if (existed && Buffer.compare(newBuf, orig) === 0) {
    recordLifecycleTarget(
      require('crypto').createHash('sha256').update(orig).digest('hex'),
      require('crypto').createHash('sha256').update(newBuf).digest('hex')
    );
    console.log(`fence: ${target} already up to date (no change)`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(`fence (dry-run): would ${hasExisting ? 'replace' : 'append'} the ${markerName} section in ${target} (no write, no backup)`);
    process.exit(0);
  }

  if (existed) {
    const stateDir = ctx.resolveStateDir();
    const backupDir = path.join(stateDir, 'backups');
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, path.basename(target) + '.' + ts + '.bak');
      fs.copyFileSync(target, backupPath);
    } catch (e) {
      fail(`fence: refusing to write — backup failed: ${e.message}`);
    }
  }

  let mode = null;
  if (existed) {
    try { mode = fs.statSync(target).mode; } catch { /* best-effort */ }
  }

  const dir = path.dirname(path.resolve(target));
  fs.mkdirSync(dir, { recursive: true });
  const stagingPath = path.join(dir, `.${path.basename(target)}.axmem-staging-${process.pid}-${Date.now()}`);
  fs.writeFileSync(stagingPath, newBuf);
  if (mode !== null) {
    try { fs.chmodSync(stagingPath, mode); } catch { /* best-effort, e.g. no-op on some Windows configs */ }
  }
  fs.renameSync(stagingPath, target); // same-directory rename: atomic on POSIX and NTFS for a plain file

  recordLifecycleTarget(
    existed ? require('crypto').createHash('sha256').update(orig).digest('hex') : null,
    require('crypto').createHash('sha256').update(newBuf).digest('hex')
  );

  console.log(`fence: ${hasExisting ? 'replaced' : 'appended'} ${markerName} section in ${target}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Self-test (ts M3 / Opus M5): this file previously shipped with NO
// --self-test at all — every other component in lib/adapters/lifecycle has
// one, but fence.cjs's recordLifecycleTarget() (the ONLY place a fence
// write's pre/post sha256 gets recorded into the lifecycle manifest for
// later uninstall) had zero direct coverage. main() exits directly on every
// path (success and failure alike), so the self-test monkey-patches
// process.exit the same way this repo's other self-tests do (e.g.
// lifecycle/restore.cjs's malicious-tar test) to capture the exit code
// without actually terminating the test process.
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  const crypto = require('crypto');
  const lm = require('../lifecycle/install-manifest.cjs');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-fence-cjs-selftest-'));
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  function runApply(argv) {
    const origExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw { __fenceSelfTestExit: true }; };
    try {
      main(argv);
    } catch (e) {
      if (!(e && e.__fenceSelfTestExit)) throw e;
    } finally {
      process.exit = origExit;
    }
    return exitCode;
  }

  // withStateDir: recordLifecycleTarget reads AXMEM_STATE_DIR straight from
  // process.env — save/restore around each test so this never leaks into
  // (or clobbers) whatever the real ambient environment has set.
  function withStateDir(dir, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'AXMEM_STATE_DIR');
    const prev = process.env.AXMEM_STATE_DIR;
    process.env.AXMEM_STATE_DIR = dir;
    try { return fn(); } finally {
      if (had) process.env.AXMEM_STATE_DIR = prev; else delete process.env.AXMEM_STATE_DIR;
    }
  }

  // 1. basic apply: fence appended to a fresh target, rc 0
  // [coordinator 2026-09-17] The target already EXISTS before this call
  // (fs.writeFileSync above), so main()'s `if (existed)` backup branch
  // runs and computes a state dir — explicitly isolated via withStateDir
  // (belt-and-suspenders alongside resolveStateDir() itself never
  // defaulting to cwd) so this test can never again depend on, or leak
  // into, the ambient CWD.
  {
    const stateDir1 = path.join(T, 'state1');
    const target = path.join(T, 'AGENTS.md');
    fs.writeFileSync(target, 'hello\n');
    const contentFile = path.join(T, 'content1.txt');
    fs.writeFileSync(contentFile, 'body line\n');
    const rc = withStateDir(stateDir1, () => runApply(['apply', target, contentFile, 'axmem']));
    const finalText = fs.readFileSync(target, 'utf8');
    check('1 basic apply: fence appended, surrounding content preserved, rc 0', rc === 0 && finalText.startsWith('hello\n') && finalText.includes('<!-- axmem:begin -->') && finalText.includes('body line'));
  }

  // 2 (ts M3/Opus M5): recordLifecycleTarget bookkeeping on a file that
  // already existed (no prior fence) — pre_sha256 must be the ORIGINAL
  // file's real sha256, post_sha256 must be the FINAL written file's real
  // sha256, not e.g. swapped, hardcoded, or of the fence body alone.
  {
    const stateDir = path.join(T, 'state2');
    const target = path.join(T, 'AGENTS2.md');
    const origContent = 'keep me\n';
    fs.writeFileSync(target, origContent);
    const contentFile = path.join(T, 'content2.txt');
    fs.writeFileSync(contentFile, 'fenced body\n');
    withStateDir(stateDir, () => runApply(['apply', target, contentFile, 'axmem', '--adapter', 'codex']));
    const finalBuf = fs.readFileSync(target);
    const manifest = lm.readManifest(stateDir);
    const entry = manifest.adapters.codex;
    const t = entry && entry.targets.find((tt) => tt.path === path.resolve(target));
    const expectedPre = crypto.createHash('sha256').update(Buffer.from(origContent, 'utf8')).digest('hex');
    const expectedPost = crypto.createHash('sha256').update(finalBuf).digest('hex');
    check('2 (ts M3) recordLifecycleTarget records the ORIGINAL file\'s real sha256 as pre_sha256 and the FINAL written file\'s real sha256 as post_sha256', !!t && t.pre_sha256 === expectedPre && t.post_sha256 === expectedPost && expectedPre !== expectedPost);
  }

  // 3. recordLifecycleTarget on a brand-new file (target did not exist) ->
  // pre_sha256 must be null (D9-adjacent: "nothing existed before" is a
  // distinct, honest state from "existed and we hashed empty content").
  {
    const stateDir = path.join(T, 'state3');
    const target = path.join(T, 'NEWFILE.md'); // never created
    const contentFile = path.join(T, 'content3.txt');
    fs.writeFileSync(contentFile, 'new body\n');
    withStateDir(stateDir, () => runApply(['apply', target, contentFile, 'axmem', '--adapter', 'generic']));
    const manifest = lm.readManifest(stateDir);
    const entry = manifest.adapters.generic;
    const t = entry && entry.targets.find((tt) => tt.path === path.resolve(target));
    check('3 (ts M3) recordLifecycleTarget on a brand-new file records pre_sha256 === null (not a hash of empty content)', !!t && t.pre_sha256 === null);
  }

  // 4. a no-op re-apply (content already up to date, the early-return
  // branch at line ~153) STILL calls recordLifecycleTarget with correct
  // pre===post sha256 — that branch has its own separate call site and had
  // no coverage distinguishing it from the write-path call site.
  {
    const stateDir = path.join(T, 'state4');
    const target = path.join(T, 'AGENTS4.md');
    fs.writeFileSync(target, 'x\n');
    const contentFile = path.join(T, 'content4.txt');
    fs.writeFileSync(contentFile, 'body\n');
    withStateDir(stateDir, () => {
      runApply(['apply', target, contentFile, 'axmem', '--adapter', 'codex']);
      runApply(['apply', target, contentFile, 'axmem', '--adapter', 'codex']); // second call: no-op branch
    });
    const afterFirst = fs.readFileSync(target);
    const manifest = lm.readManifest(stateDir);
    const t = manifest.adapters.codex.targets.find((tt) => tt.path === path.resolve(target));
    const expectedSha = crypto.createHash('sha256').update(afterFirst).digest('hex');
    check('4 (ts M3) no-op re-apply (already up to date) still records via recordLifecycleTarget, pre===post===current file sha256', !!t && t.pre_sha256 === expectedSha && t.post_sha256 === expectedSha);
  }

  // 5. no --adapter given -> recordLifecycleTarget's own early return means
  // NO manifest file is ever created at all (not an empty adapters entry).
  {
    const stateDir = path.join(T, 'state5');
    const target = path.join(T, 'AGENTS5.md');
    fs.writeFileSync(target, 'x\n');
    const contentFile = path.join(T, 'content5.txt');
    fs.writeFileSync(contentFile, 'body\n');
    withStateDir(stateDir, () => runApply(['apply', target, contentFile, 'axmem']));
    check('5 no --adapter given -> no lifecycle manifest file written at all', !fs.existsSync(lm.manifestPath(stateDir)));
  }

  // 6. duplicate marker pair -> refuses rc 3 via fail(), which exits BEFORE
  // recordLifecycleTarget is ever reached -> no manifest entry recorded.
  {
    const stateDir = path.join(T, 'state6');
    const target = path.join(T, 'AGENTS6.md');
    fs.writeFileSync(target, '<!-- axmem:begin -->\na\n<!-- axmem:end -->\n<!-- axmem:begin -->\nb\n<!-- axmem:end -->\n');
    const contentFile = path.join(T, 'content6.txt');
    fs.writeFileSync(contentFile, 'body\n');
    const rc = withStateDir(stateDir, () => runApply(['apply', target, contentFile, 'axmem', '--adapter', 'codex']));
    check('6 duplicate marker pair -> rc 3, no manifest file written (fail() exits before recordLifecycleTarget runs)', rc === 3 && !fs.existsSync(lm.manifestPath(stateDir)));
  }

  console.log(results.join('\n'));
  console.log(`fence.cjs self-test ${ok}/6`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === 6 ? 0 : 1;
}

if (require.main === module) {
  if (process.argv[2] === '--self-test') {
    process.exit(selfTest());
  } else {
    main(process.argv.slice(2));
  }
}

module.exports = { main };
