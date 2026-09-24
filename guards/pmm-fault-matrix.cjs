#!/usr/bin/env node
// pmm-fault-matrix.cjs — C05-BUILD-SPEC.md 交付物 8(故障注入夹具矩阵运行器,B5)。
//
// 只读消费 pmm-hook.cjs(B1,统一影子 hook)、pmm-index-emit.cjs(B4)与 pmm-core.cjs(v3 core)——
// 这三个文件一个字不改;本文件只用夹具(guards/fixtures/v3/faults/<id>/expect.json + 必要时的语料)
// 与环境/参数(isoEnv 重定向根、--dir、构造出的 tool_input.file_path 拼法)做故障注入,不打补丁改
// 被测源码(唯一例外是 --self-test 内部的静默故障变异,那是一份临时的、跑完即删的内存态副本文件,
// 从不覆盖真实的 pmm-index-emit.cjs 本体——与 pmm-hook.cjs 自己 H-1 mutant 自测同款手法)。
//
// 每例目录下的 expect.json 是权威("oracle 字段必须证明被读过"——本文件的每个 case handler 都
// 直接消费 expect.json 里对应的字段做断言,不是摆设);目录本身 = 交付物 8 原文"每例一个目录"。
//
// 矩阵种类(交付物 8 + 补遗一第 10 条① 的既有两例由 B4 已建、只读复用,不在本文件重建):
//   core-throw · single-consumer-throw · stale-lkg · missing-file ·
//   windows-path-variant(/./、/../、8.3 短名、UNC、大小写、正斜杠盘符 六种)·
//   hook-json-double-backslash(E7 形态)
//
// 隔离纪律(补遗二 §22、补遗一第 16 条):每个 DUT 子进程都经 selftest-iso.cjs 的 isoEnv() 起;
// 每个 case 与整趟矩阵跑法首尾都做 footprint 零足迹断言;真根一律由 __dirname 推出,不由环境变量
// 推出。子进程送入的 session_id/tool_use_id 字面量一律带 test:/toolu_selftest_ 前缀并嵌入本趟
// 运行的 nonce,供 markersFromSource() 与 footprint 标记比对(名册字面量前缀纪律,提前对齐)。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const GUARDS_DIR = __dirname;
const HOOK_PATH = path.resolve(GUARDS_DIR, '..', 'pmm-hook.cjs');
const INDEX_EMIT_PATH = path.resolve(GUARDS_DIR, 'pmm-index-emit.cjs');
const FAULTS_DIR = path.resolve(GUARDS_DIR, 'fixtures', 'v3', 'faults');

const core = require('./pmm-core.cjs');
const iso = require('./selftest-iso.cjs');

// ── generic helpers ─────────────────────────────────────────────────────────────────────────────
function mach() { return (os.hostname() || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 12); }
function mkT(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-fault-matrix-' + tag + '-')).replace(/\\/g, '/');
}
function rmT(T) { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }

// runHookEvent(T, filePath, sessionId, toolUseId) — spawns `pmm-hook.cjs --shadow` under isoEnv(T)
// with a synthetic Edit event on stdin, then reads back the shadow log line matching toolUseId
// (search from the end so a T reused across multiple calls in one case still finds ITS OWN line).
function runHookEvent(T, filePath, sessionId, toolUseId, phaseArgs) {
  const env = iso.isoEnv(T, {});
  const payload = {
    tool_name: 'Edit', session_id: sessionId, tool_use_id: toolUseId,
    tool_input: { file_path: filePath },
  };
  const buf = Buffer.from(JSON.stringify(payload));
  const r = cp.spawnSync(process.execPath, [HOOK_PATH].concat(phaseArgs || ['--shadow']), {
    env, input: buf, maxBuffer: 16 * 1024 * 1024, timeout: 15000,
  });
  const logPath = T + '/.claude/.shadow/hook-' + mach() + '.log';
  let lines = [];
  try { lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean); } catch { /* no log yet */ }
  let lastLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let j = null;
    try { j = JSON.parse(lines[i]); } catch { continue; }
    if (j && j.tool_use_id === toolUseId) { lastLine = j; break; }
  }
  return {
    status: r.status,
    stdout: (r.stdout || Buffer.alloc(0)).toString('utf8'),
    stderr: (r.stderr || Buffer.alloc(0)).toString('utf8'),
    lastLine, logLineFound: !!lastLine,
  };
}

// runIndexEmit(T, args, dutPath) — dutPath override exists ONLY for --self-test's silent-mutation
// case (a throwaway ephemeral copy, never the checked-in file) — every normal matrix case uses the
// default (real, unmodified) INDEX_EMIT_PATH.
function runIndexEmit(T, args, dutPath) {
  const env = iso.isoEnv(T, {});
  const r = cp.spawnSync(process.execPath, [dutPath || INDEX_EMIT_PATH].concat(args || []), {
    env, maxBuffer: 16 * 1024 * 1024, timeout: 20000,
  });
  return {
    status: r.status,
    stdout: (r.stdout || Buffer.alloc(0)).toString('utf8'),
    stderr: (r.stderr || Buffer.alloc(0)).toString('utf8'),
  };
}

// indexEmitSilent(stdout, status) — the brief's OWN literal definition of "silent" for the
// index-emit consumer: "空输出且 rc 0 = 红".
function indexEmitSilent(stdout, status) { return stdout.length === 0 && status === 0; }

function writeEmptyCorpus(memDir, omitSet) {
  fs.mkdirSync(memDir, { recursive: true });
  for (const f of core.ALL_FILES) {
    if (omitSet && omitSet.has(f)) continue;
    fs.writeFileSync(path.join(memDir, f), '');
  }
}

function fpBegin() { return iso.footprint.begin(); }
function fpEndFor(snap, nonce, T) { return iso.footprint.end(snap, iso.markersFromSource(__filename, nonce, path.basename(T))); }

// ── Windows path-variant construction (category: windows-path-variant) ────────────────────────────
// See guards/fixtures/v3/faults/winpath-*/expect.json for the per-variant rationale and the
// documented 8.3-generation-disabled limitation on this machine (read-only probes only — never
// enables 8dot3name, that would be a system-setting change this builder must not make).
function variantFilePath(kind, memDir) {
  const target = memDir + '/decisions.md';
  if (kind === 'dot-segment') return memDir + '/./decisions.md';
  if (kind === 'dotdot-segment') return memDir + '/../memory/decisions.md';
  if (kind === 'short-name-synthetic') return memDir + '/DECISI~1.MD';
  if (kind === 'unc-admin-share') {
    const win = target.replace(/\//g, '\\');
    const drive = win[0];
    const rest = win.slice(2); // "\Users\...\decisions.md" (leading backslash retained)
    return '\\\\localhost\\' + drive + '$' + rest;
  }
  if (kind === 'case-variant') return target.toUpperCase();
  if (kind === 'forward-slash-drive') return target;
  throw new Error('unknown windows-path-variant kind: ' + kind);
}

// buildE7FilePath(memDir) — E7 形态(hook JSON 双反斜杠):按 hook-json-double-backslash-e7/
// expect.json 的 escapingDiscipline 字段所记的教训([tooling:hook-fixture-must-carry-producer-
// escaping] 2026-09-14 事故:夹具经 Bash 手打,反斜杠被折半,从未喂过生产形态),这条路径值全程
// 只在本 .cjs 文件内部用 JS 字符串操作构造(.replace 产出运行时真的带两个反斜杠字符的字符串),
// 再交给 JSON.stringify()/spawnSync 的 stdin Buffer——中间不经过任何 shell 层。
function buildE7FilePath(memDir) {
  const nativeTarget = (memDir + '/decisions.md').replace(/\//g, '\\'); // single-backslash native form
  return nativeTarget.replace(/\\/g, '\\\\'); // each backslash -> two backslashes (real runtime bytes)
}

// ── fixture discovery ───────────────────────────────────────────────────────────────────────────
// Only picks up directories that carry an expect.json — the two pre-existing B4 fixtures
// (index-emit-file-empty / index-emit-file-truncated) deliberately have none (B4 already
// self-validates them inside pmm-index-emit.cjs's own --self-test); this matrix READS their
// content read-only via corpusRef/primeDir/degradeCorpusRef in two of the cases below, but never
// re-lists them as their own top-level matrix rows.
function discoverFixtures() {
  const ids = [];
  for (const name of fs.readdirSync(FAULTS_DIR).sort()) {
    const dir = path.join(FAULTS_DIR, name);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (fs.existsSync(path.join(dir, 'expect.json'))) ids.push(name);
  }
  return ids;
}
function readExpect(id) { return JSON.parse(fs.readFileSync(path.join(FAULTS_DIR, id, 'expect.json'), 'utf8')); }

// ── per-category case handlers — each returns { ok, details[] }; details carry enough to diagnose
// a FAIL without re-running (guard-runner-must-not-discard-output-on-red discipline). ─────────────

function caseCoreThrow(id, expect, ctx) {
  const details = []; let ok = true;

  // hook: no .claude/memory directory at all under a fresh T -> core.snapshot('worktree')
  // (requireAll=true, hook.cjs never overrides it) has all 7 ALL_FILES unreadable -> throws.
  {
    const T = mkT(id + '-hook');
    const fp = fpBegin();
    const toolUseId = 'toolu_selftest_' + ctx.nonce + '_' + id + '_hook';
    const r = runHookEvent(T, T + '/.claude/memory/decisions.md', 'test:' + ctx.nonce + '-' + id, toolUseId);
    const partOk = r.logLineFound && !!(r.lastLine && r.lastLine.degraded)
      && String(r.lastLine.degraded).indexOf(expect.hook.expectDegradedContains) !== -1;
    details.push({ part: 'hook', ok: partOk, lastLine: r.lastLine, status: r.status });
    ok = ok && partOk;
    const fpr = fpEndFor(fp, ctx.nonce, T);
    details.push({ part: 'hook-footprint', ok: !fpr.red, line: fpr.line });
    ok = ok && !fpr.red;
    rmT(T);
  }

  // index-emit: default (no --dir) path calls core.snapshot('HEAD'); an isolated T has no git
  // repository under it at all, so treeOid() fails and snapshot() itself throws.
  {
    const T = mkT(id + '-idx');
    const fp = fpBegin();
    const r = runIndexEmit(T, []);
    const partOk = r.status !== 0 && r.stdout.indexOf(expect.indexEmit.expectStdoutContains) !== -1
      && !indexEmitSilent(r.stdout, r.status);
    details.push({ part: 'index-emit', ok: partOk, stdout: r.stdout.slice(0, 300), status: r.status });
    ok = ok && partOk;
    const fpr = fpEndFor(fp, ctx.nonce, T);
    details.push({ part: 'index-emit-footprint', ok: !fpr.red, line: fpr.line });
    ok = ok && !fpr.red;
    rmT(T);
  }

  return { ok, details };
}

function caseSingleConsumerThrow(id, expect, ctx) {
  const details = []; let ok = true;
  const corpusDir = path.resolve(FAULTS_DIR, id, expect.corpusRef);
  const T = mkT(id);
  const fp = fpBegin();

  const memDir = T + '/.claude/memory';
  fs.mkdirSync(memDir, { recursive: true });
  for (const f of fs.readdirSync(corpusDir)) fs.copyFileSync(path.join(corpusDir, f), path.join(memDir, f));

  const toolUseId = 'toolu_selftest_' + ctx.nonce + '_' + id + '_hook';
  const hookRes = runHookEvent(T, memDir + '/' + expect.targetFile, 'test:' + ctx.nonce + '-' + id, toolUseId);
  const hookDegradedOk = expect.hook.expectDegraded === false ? !hookRes.lastLine || !hookRes.lastLine.degraded
    : !!(hookRes.lastLine && hookRes.lastLine.degraded);
  const hookIsMemOk = expect.hook.expectIsMemory === undefined
    || (hookRes.lastLine && hookRes.lastLine.isMemory === expect.hook.expectIsMemory);
  const hookOk = hookRes.logLineFound && hookDegradedOk && hookIsMemOk;
  details.push({ part: 'hook', ok: hookOk, lastLine: hookRes.lastLine });
  ok = ok && hookOk;

  // index-emit: --dir points DIRECTLY at the read-only existing fixture (no copy needed — reading
  // is safe; only the LKG/index writes, which land under isoEnv T, ever touch a write path).
  const idxRes = runIndexEmit(T, ['--dir', corpusDir]);
  const idxOk = idxRes.status !== 0 && idxRes.stdout.indexOf(expect.indexEmit.expectStdoutContains) !== -1
    && !indexEmitSilent(idxRes.stdout, idxRes.status);
  details.push({ part: 'index-emit', ok: idxOk, stdout: idxRes.stdout.slice(0, 300) });
  ok = ok && idxOk;

  const fpr = fpEndFor(fp, ctx.nonce, T);
  details.push({ part: 'footprint', ok: !fpr.red, line: fpr.line });
  ok = ok && !fpr.red;
  rmT(T);
  return { ok, details };
}

function caseStaleLkg(id, expect, ctx) {
  const details = []; let ok = true;
  const primeDir = path.resolve(FAULTS_DIR, id, expect.primeDir);
  const degradeDir = path.resolve(FAULTS_DIR, id, expect.degradeCorpusRef);
  const T = mkT(id);
  const fp = fpBegin();

  const r1 = runIndexEmit(T, ['--dir', primeDir, '--as-of', expect.asOf]);
  let j1 = null;
  try { const m = /PMM-INDEX-EMIT (\{.*\})/.exec(r1.stdout); if (m) j1 = JSON.parse(m[1]); } catch { /* leave j1 null */ }
  const primeOk = (expect.indexEmit.primeExpectRcZero ? r1.status === 0 : true)
    && r1.stdout.indexOf(expect.indexEmit.primeExpectStdoutContains) !== -1
    && (expect.indexEmit.primeExpectLkgHitFalse ? (!!j1 && j1.lkgHit === false) : true);
  details.push({ part: 'prime', ok: primeOk, stdout: r1.stdout.slice(0, 300), parsed: j1 && { lkgHit: j1.lkgHit, lkgKey: j1.lkgKey } });
  ok = ok && primeOk;

  const r2 = runIndexEmit(T, ['--dir', degradeDir, '--as-of', expect.asOf]);
  // W3-F (2026-09-24): f9a8acf / M3 removed the mtime-latest LKG bucket fallback (FINAL-SPEC §4 —
  // "LKG 只在 key 命中才用"); on a key miss, degraded() now goes straight to the title-only dead end
  // and never emits an "LKG-FALLBACK" line at all (see pmm-index-emit.cjs:200-231's degraded()).
  // expect.json's degradeExpectLkgFallbackContains (which asserted PRESENCE of a stale-LKG fallback
  // line) is therefore replaced by degradeExpectNoLkgFallback (asserts ABSENCE) -- the old field is
  // read only if the new one isn't set, so this stays backward-compatible with any other fixture that
  // still legitimately expects a fallback line to be present.
  const noFallbackOk = expect.indexEmit.degradeExpectNoLkgFallback
    ? r2.stdout.indexOf('LKG-FALLBACK') === -1
    : (expect.indexEmit.degradeExpectLkgFallbackContains
        ? r2.stdout.indexOf(expect.indexEmit.degradeExpectLkgFallbackContains) !== -1
        : true);
  const degradeOk = (expect.indexEmit.degradeExpectRcNonZero ? r2.status !== 0 : true)
    && r2.stdout.indexOf(expect.indexEmit.degradeExpectStdoutContains) !== -1
    && noFallbackOk
    && !indexEmitSilent(r2.stdout, r2.status);
  details.push({ part: 'degrade', ok: degradeOk, stdout: r2.stdout.slice(0, 400) });
  ok = ok && degradeOk;

  const fpr = fpEndFor(fp, ctx.nonce, T);
  details.push({ part: 'footprint', ok: !fpr.red, line: fpr.line });
  ok = ok && !fpr.red;
  rmT(T);
  return { ok, details };
}

function caseMissingFile(id, expect, ctx) {
  const details = []; let ok = true;
  const T = mkT(id);
  const fp = fpBegin();
  const memDir = T + '/.claude/memory';
  const omit = new Set(expect.corpus.omit);
  writeEmptyCorpus(memDir, omit);

  const toolUseId = 'toolu_selftest_' + ctx.nonce + '_' + id + '_hook';
  const hookRes = runHookEvent(T, memDir + '/' + expect.targetFile, 'test:' + ctx.nonce + '-' + id, toolUseId);
  const hookOk = hookRes.logLineFound && !!(hookRes.lastLine && hookRes.lastLine.degraded)
    && String(hookRes.lastLine.degraded).indexOf(expect.hook.expectDegradedContains) !== -1;
  details.push({ part: 'hook', ok: hookOk, lastLine: hookRes.lastLine });
  ok = ok && hookOk;

  const idxRes = runIndexEmit(T, ['--dir', memDir]);
  const idxOk = idxRes.status !== 0 && idxRes.stdout.indexOf(expect.indexEmit.expectStdoutContains) !== -1
    && !indexEmitSilent(idxRes.stdout, idxRes.status);
  details.push({ part: 'index-emit', ok: idxOk, stdout: idxRes.stdout.slice(0, 300) });
  ok = ok && idxOk;

  const fpr = fpEndFor(fp, ctx.nonce, T);
  details.push({ part: 'footprint', ok: !fpr.red, line: fpr.line });
  ok = ok && !fpr.red;
  rmT(T);
  return { ok, details };
}

function caseWindowsPathVariant(id, expect, ctx) {
  const details = []; let ok = true;
  const T = mkT(id);
  const fp = fpBegin();
  const memDir = T + '/.claude/memory';
  writeEmptyCorpus(memDir, null);

  const filePath = variantFilePath(expect.variant, memDir);
  const toolUseId = 'toolu_selftest_' + ctx.nonce + '_' + id;
  const r = runHookEvent(T, filePath, 'test:' + ctx.nonce + '-' + id, toolUseId);
  const noCrash = r.status === 0 && r.stderr.length === 0;
  const isMemOk = r.lastLine && r.lastLine.isMemory === expect.hook.expectIsMemory;
  const partOk = r.logLineFound && noCrash && isMemOk;
  details.push({ part: 'hook', ok: partOk, filePath, lastLine: r.lastLine, status: r.status, stderr: r.stderr.slice(0, 200) });
  ok = ok && partOk;

  const fpr = fpEndFor(fp, ctx.nonce, T);
  details.push({ part: 'footprint', ok: !fpr.red, line: fpr.line });
  ok = ok && !fpr.red;
  rmT(T);
  return { ok, details };
}

function caseE7DoubleBackslash(id, expect, ctx) {
  const details = []; let ok = true;
  const T = mkT(id);
  const fp = fpBegin();
  const memDir = T + '/.claude/memory';
  writeEmptyCorpus(memDir, null);

  const filePath = buildE7FilePath(memDir);
  const doubledSepCount = (filePath.match(/\\\\/g) || []).length;
  const toolUseId = 'toolu_selftest_' + ctx.nonce + '_' + id;
  const r = runHookEvent(T, filePath, 'test:' + ctx.nonce + '-' + id, toolUseId);
  const noCrash = r.status === 0 && r.stderr.length === 0;
  const isMemOk = r.lastLine && r.lastLine.isMemory === expect.hook.expectIsMemory;
  // sanity: the fixture is only meaningful if the double-backslash bytes actually survived the
  // JSON round trip intact (>=2 doubled separators expected in a temp path this deep).
  const escapingSurvived = doubledSepCount >= 2;
  const partOk = r.logLineFound && noCrash && isMemOk && escapingSurvived;
  details.push({
    part: 'hook', ok: partOk, doubledSepCount, lastLine: r.lastLine, status: r.status, stderr: r.stderr.slice(0, 200),
  });
  ok = ok && partOk;

  const fpr = fpEndFor(fp, ctx.nonce, T);
  details.push({ part: 'footprint', ok: !fpr.red, line: fpr.line });
  ok = ok && !fpr.red;
  rmT(T);
  return { ok, details };
}

const CASE_HANDLERS = {
  'core-throw': caseCoreThrow,
  'single-consumer-throw': caseSingleConsumerThrow,
  'stale-lkg': caseStaleLkg,
  'missing-file': caseMissingFile,
  'windows-path-variant': caseWindowsPathVariant,
  'hook-json-double-backslash': caseE7DoubleBackslash,
};

// ── matrix engine ───────────────────────────────────────────────────────────────────────────────
function runMatrix(nonce) {
  const ctx = { nonce };
  const ids = discoverFixtures();
  let pass = 0, fail = 0;
  const lines = [];
  for (const id of ids) {
    let expect;
    try { expect = readExpect(id); }
    catch (e) { fail++; lines.push('FAIL ' + id + ' :: expect.json parse error :: ' + (e && e.message)); continue; }
    const handler = CASE_HANDLERS[expect.category];
    if (!handler) { fail++; lines.push('FAIL ' + id + ' :: unknown category ' + expect.category); continue; }
    let result;
    try { result = handler(id, expect, ctx); }
    catch (e) { result = { ok: false, details: [{ part: 'exception', ok: false, error: String((e && e.stack) || e) }] }; }
    if (result.ok) { pass++; lines.push('PASS ' + id); }
    else { fail++; lines.push('FAIL ' + id + ' :: ' + JSON.stringify(result.details).slice(0, 1500)); }
  }
  return { pass, fail, total: ids.length, lines };
}

function newNonce() { return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'); }

// ── default mode: run the real matrix once, report to stdout (spec: "报告...默认 stdout") ────────
function mainRun() {
  const nonce = newNonce();
  const fpSnap = iso.footprint.begin();
  const res = runMatrix(nonce);
  const fpr = iso.footprint.end(fpSnap, iso.markersFromSource(__filename, nonce, ''));
  for (const l of res.lines) console.log(l);
  console.log('footprint: ' + (fpr.red ? ('FAIL :: ' + fpr.line) : 'pass'));
  const overallFail = res.fail + (fpr.red ? 1 : 0);
  console.log('PMM-FAULT-MATRIX {"total":' + res.total + ',"pass":' + res.pass + ',"fail":' + overallFail + '}');
  process.exitCode = overallFail > 0 ? 1 : 0;
}

// SELFTEST-BEGIN
// --self-test / --self-check (补遗二 §22 名册纪律预对齐;不改 guard-canary.sh,登记名单交给收口者):
// (1) 把 runMatrix() 的 N 例真实跑一遍,当作本文件自身的自测内容(isoEnv 贯穿、footprint 首尾）；
// (2) 交付物 8 原文要求的"至少一例「静默故障」变异必红"——对 pmm-index-emit.cjs 的 degraded()
//     函数做一次临时的、内存构造/跑完即删的文本替换(同 pmm-hook.cjs 自己 H-1 mutant 自测同款手法,
//     绝不覆盖真实文件),把它的 stdout 输出与 exitCode 设置整段替换成空操作,断言矩阵引擎的
//     "从不静默"判据(indexEmitSilent)在这个变异体上正确判红;并反向断言真实(未变异)文件在同一
//     场景下不判红,证明这不是一个恒红的伪判据。
function selfTest() {
  const nonce = newNonce();
  const fpSnap = iso.footprint.begin();
  let pass = 0, fail = 0;
  const lines = [];
  function report(name, ok, detail) {
    if (ok) { pass++; lines.push('PASS ' + name); }
    else { fail++; lines.push('FAIL ' + name + (detail !== undefined ? (' :: ' + JSON.stringify(detail)) : '')); }
  }

  // (1) real matrix run, folded into this self-test's own pass/fail ledger.
  const matrixRes = runMatrix(nonce);
  for (const l of matrixRes.lines) {
    if (l.indexOf('PASS ') === 0) { report('matrix:' + l.slice(5), true); }
    else { report('matrix:' + l.slice(5).split(' :: ')[0], false, l.slice(5)); }
  }

  // (2) silent-fault mutation must go RED.
  const MARKER = "  console.log(header);\n  if (fallbackSource) console.log('LKG-FALLBACK ' + fallbackSource);\n  process.exitCode = 1;";
  const indexEmitSrc = fs.readFileSync(INDEX_EMIT_PATH, 'utf8');
  if (indexEmitSrc.indexOf(MARKER) === -1) {
    report('silent-mutation: degraded() output block found to mutate', false, 'marker not found -- pmm-index-emit.cjs source drifted, update MARKER');
  } else {
    const mutantSrc = indexEmitSrc.replace(MARKER, '  /* MUTANT: silenced degraded() stdout+exitCode for pmm-fault-matrix --self-test */');
    const mutantPath = path.join(GUARDS_DIR, '.pmm-fault-matrix.selftest-mutant-' + crypto.randomBytes(4).toString('hex') + '.cjs');
    fs.writeFileSync(mutantPath, mutantSrc);
    try {
      // W3-F (roster fix, spec 22): these two ad-hoc subprocess launches are self-test-only (the
      // dutPath override on runIndexEmit exists ONLY for this mutant scenario -- see that function's
      // header comment), and the structural canary requires `isoEnv(` to appear literally inside this
      // SELFTEST-BEGIN..END region (not just inside a helper defined outside it). Inlined here instead
      // of going back through the runIndexEmit() wrapper -- same iso.isoEnv()/spawnSync body, called
      // directly, so the self-test's own subprocess dispatch visibly goes through the shared isolation
      // helper rather than hand-rolling an env object.
      const Tm = mkT('mutant');
      const envM = iso.isoEnv(Tm, {});
      const rmRaw = cp.spawnSync(process.execPath, [mutantPath], { env: envM, maxBuffer: 16 * 1024 * 1024, timeout: 20000 }); // no --dir -> core-throw scenario, same as caseCoreThrow's index-emit half
      const rm = {
        status: rmRaw.status,
        stdout: (rmRaw.stdout || Buffer.alloc(0)).toString('utf8'),
        stderr: (rmRaw.stderr || Buffer.alloc(0)).toString('utf8'),
      };
      const mutantIsSilent = indexEmitSilent(rm.stdout, rm.status);
      report('silent-mutation: mutant (silenced degraded()) IS detected as silent by indexEmitSilent()', mutantIsSilent, { status: rm.status, stdoutLen: rm.stdout.length });
      rmT(Tm);

      const Tb = mkT('mutant-baseline');
      const envB = iso.isoEnv(Tb, {});
      const rbRaw = cp.spawnSync(process.execPath, [INDEX_EMIT_PATH], { env: envB, maxBuffer: 16 * 1024 * 1024, timeout: 20000 }); // real, unmutated INDEX_EMIT_PATH, same scenario
      const rb = {
        status: rbRaw.status,
        stdout: (rbRaw.stdout || Buffer.alloc(0)).toString('utf8'),
        stderr: (rbRaw.stderr || Buffer.alloc(0)).toString('utf8'),
      };
      const baselineNotSilent = !indexEmitSilent(rb.stdout, rb.status);
      report('silent-mutation: baseline (real, unmutated) DUT is NOT flagged silent for the same scenario (detector is not vacuously always-red)', baselineNotSilent, { status: rb.status, stdoutLen: rb.stdout.length, stdout: rb.stdout.slice(0, 200) });
      rmT(Tb);
    } finally {
      try { fs.rmSync(mutantPath, { force: true }); } catch { /* best-effort */ }
    }
  }

  const fpr = iso.footprint.end(fpSnap, iso.markersFromSource(__filename, nonce, ''));
  report('footprint: zero attributable change on the real root', !fpr.red, fpr.line);

  for (const l of lines) console.log(l);
  console.log('SELFTEST-FAULT-MATRIX {"pass":' + pass + ',"fail":' + fail + '}');
  process.exitCode = fail > 0 ? 1 : 0;
}
// SELFTEST-END

module.exports = {
  discoverFixtures, readExpect, runMatrix, variantFilePath, buildE7FilePath, indexEmitSilent, CASE_HANDLERS,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test') || argv.includes('--self-check')) selfTest();
  else mainRun();
}
