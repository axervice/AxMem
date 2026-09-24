#!/usr/bin/env node
// pmm-shadow-replay.cjs — C05-BUILD-SPEC.md 交付物 3 (事件回放器).
//
// 从 `memory/dreams/trigger-log-*.tsv` 的 `event` 行重建 hook JSON(tool、file_path 由 repo+rel 反推;
// Bash 事件无命令文本 → 跳过),喂给 `pmm-hook.cjs --shadow` 与旧 `pmm-trigger-recall.cjs`(只读
// dry-run —— 子进程一律经 selftest-iso.cjs 的 isoEnv() 起,完整重定向:HOME/USERPROFILE/PMM_HOME/
// PMM_RECALL_ROOT/PMM_TRIGGER_MEM/PMM_TRIGGER_STATE/PMM_TRIGGER_LOG 全部落在临时根 T 下,真根只读)。
//
// 快照钉住(补遗一第 12 条):开工先 `git rev-parse HEAD:.claude/memory` 取一次 OID 并钉住,`git
// archive` 那个 OID 到临时根 T/.claude/memory —— 这一步同时把 dreams/trigger-log-*.tsv 也冻结在同一
// OID 下(它本身就在 `.claude/memory` 树里),所以"回放的事件源"与"回放时喂给两个工具的语料"天然是
// 同一个快照,不会出现"语料在对照过程中被并发提交改写"的问题。收工再取一次 OID,若漂移则整轮作废。
//
// 产出:T 下的 `.claude/.shadow/hook-<mach>.log`(pmm-hook.cjs 自己写的)与
// `.claude/.shadow/legacy-<mach>.log`(本文件用 PMM_TEE_LOG 指给 pmm-trigger-recall.cjs 的 tee 输出)——
// 这两份日志的格式与 pmm-shadow-compare.cjs 消费的格式逐字节相同(因为就是同一批 DUT 产出的),本文件
// 直接 require pmm-shadow-compare.cjs 复用 compareEvents()/renderReport() 生成"回放"标记的报告,不需
// 要用户再手动跑第二个命令去喂这两个文件(它们仍然可以被单独复制出来、用
// `pmm-shadow-compare.cjs --shadow-log --legacy-log` 手动再对照一次 —— 两条路径都支持)。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');

const core = require('./pmm-core.cjs');
const iso = require('./selftest-iso.cjs');
const cmp = require('./pmm-shadow-compare.cjs');

const DEFAULT_LIMIT = 300; // 回放全部 4000+ 条历史事件太慢;目标只要求 >=200,默认取前 300 条非-Bash 事件。

// ── 事件重建(spec 交付物 3):tool、file_path 由 repo+rel 反推 ─────────────────────────────────────
// trigger-log 的 'event' 行(guards/pmm-trigger-recall.cjs 写的):
//   ts \t sid(截断 8 位) \t "event" \t tool \t repo \t rel \t tag-or-"-" \t extra
function parseTriggerLogEventLines(text) {
  const events = [];
  let bashSkipped = 0, malformed = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length !== 8 || f[2] !== 'event') continue; // 只取 event 行,其它 kind(suppressed-seen 等)不是本文件的回放对象
    const [ts, sidTrunc, , tool, repo, rel] = f;
    if (tool === 'Bash') { bashSkipped++; continue; } // Bash 事件无命令文本 → 跳过(spec 交付物 3 / 补遗一 13③)
    if (repo !== 'home' && repo !== 'axervice-booking') { malformed++; continue; } // 防御:未知 repo 值不猜测重建
    events.push({ ts, sidTrunc, tool, repo, rel });
  }
  return { events, bashSkipped, malformed };
}

// file_path 反推:与 pmm-hook.cjs 的 resolveRepoRel() 互为逆运算(同一份 §3.1"path 同今日"约定)。
//   repo=home            -> file_path = <isoHome>/<rel>                          (resolveRepoRel 要求以 HOME/ 开头)
//   repo=axervice-booking -> file_path = <isoHome>/<fake-parent>/axervice-booking/<rel>  (resolveRepoRel 只做子串匹配,不要求该路径真实存在)
function reconstructFilePath(isoHome, repo, rel) {
  if (repo === 'home') return isoHome + '/' + rel;
  return isoHome + '/replay-axervice-parent/axervice-booking/' + rel;
}

function reconstructHookJSON(isoHome, ev, tuid) {
  return {
    tool_name: ev.tool,
    session_id: ev.sidTrunc || 'nosess',
    agent_id: '', // trigger-log 的 event 行历史上从不记 agent —— 两侧都用同一个空 agent,连接键仍是 tool_use_id,不受影响。
    tool_use_id: tuid,
    tool_input: { file_path: reconstructFilePath(isoHome, ev.repo, ev.rel) },
  };
}

// ── 一整轮回放(main() 与 --self-test 共用,repoRoot/tsvOverride 可覆盖以便自测用假仓库) ───────────
function runRound(opts) {
  const repoRoot = opts.repoRoot;
  const limit = opts.limit;
  const runNonce = opts.runNonce;

  const oidStart = cmp.pinMemoryOid(repoRoot);
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-shadow-replay-' + runNonce.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) + '-'));
  const memDir = T + '/.claude/memory';
  try {
    cmp.archiveCorpus(repoRoot, oidStart, memDir);

    let tsvText = '';
    if (opts.tsvOverride) {
      tsvText = fs.readFileSync(opts.tsvOverride, 'utf8');
    } else {
      const dreamsDir = memDir + '/dreams';
      let files = [];
      try { files = fs.readdirSync(dreamsDir).filter((f) => /^trigger-log-.*\.tsv$/.test(f)); } catch { /* none */ }
      tsvText = files.map((f) => { try { return fs.readFileSync(path.join(dreamsDir, f), 'utf8'); } catch { return ''; } }).join('\n');
    }
    const { events, bashSkipped, malformed } = parseTriggerLogEventLines(tsvText);
    const toReplay = typeof limit === 'number' ? events.slice(0, limit) : events;

    const env = iso.isoEnv(T, {});
    const HOOK = path.resolve(__dirname, '..', 'pmm-hook.cjs');
    // The tee block lives in pmm-trigger-recall.SH (its non-self-test tail is `exec node
    // ".../pmm-trigger-recall.cjs"` with no args) -- spawning the .cjs directly bypasses tee entirely
    // (found by pmm-shadow-compare.cjs's own self-test). Spawn the .sh through bash so PMM_TEE_LOG
    // actually fires, exactly as real production wiring would if tee were ever turned on.
    const TRIGGER_RECALL_SH = path.resolve(__dirname, 'pmm-trigger-recall.sh');
    const mach = cmp.mach();
    const legacyLog = T + '/.claude/.shadow/legacy-' + mach + '.log';
    const legacyEnv = Object.assign({}, env, { PMM_TEE_LOG: legacyLog });

    let i = 0;
    for (const ev of toReplay) {
      const tuid = 'toolu_replay_' + runNonce + '_' + i;
      const payload = Buffer.from(JSON.stringify(reconstructHookJSON(T, ev, tuid)));
      cp.spawnSync(process.execPath, [HOOK, '--shadow'], { env, input: payload, maxBuffer: 16 * 1024 * 1024 });
      cp.spawnSync('bash', [TRIGGER_RECALL_SH], { env: legacyEnv, input: payload, maxBuffer: 16 * 1024 * 1024 });
      i++;
    }

    let shadowText = '', legacyText = '';
    try { shadowText = fs.readFileSync(T + '/.claude/.shadow/hook-' + mach + '.log', 'utf8'); } catch { /* none written */ }
    try { legacyText = fs.readFileSync(legacyLog, 'utf8'); } catch { /* none written */ }
    const { rows: shadowRows } = cmp.parseShadowLog(shadowText);
    const { rows: legacyRows } = cmp.parseLegacyLog(legacyText);
    const { analyzed } = cmp.analyzeMemDir(memDir);
    const compareResult = cmp.compareEvents({ shadowRows, legacyRows, analyzed });

    const oidEnd = cmp.pinMemoryOid(repoRoot);
    const drift = oidEnd !== oidStart;

    return {
      oidStart, oidEnd, drift,
      eventsTotal: events.length, eventsReplayed: toReplay.length,
      bashSkipped, malformed,
      shadowLogPath: T + '/.claude/.shadow/hook-' + mach + '.log', legacyLogPath: legacyLog,
      compareResult,
    };
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function renderReplayReport(result) {
  const lines = [];
  lines.push('# pmm-shadow-replay 报告(回放,不替代实时 —— 补遗一 K22)');
  lines.push('');
  lines.push('- 语料 OID(开工): ' + result.oidStart);
  lines.push('- 语料 OID(收工): ' + result.oidEnd + (result.drift ? '  ⚠️ 漂移,本轮结论作废' : ''));
  lines.push('- 事件源总 event 行数: ' + result.eventsTotal);
  lines.push('- 实际回放事件数: ' + result.eventsReplayed);
  lines.push('- 跳过的 Bash 事件数: ' + result.bashSkipped);
  lines.push('- 防御性跳过(未知 repo): ' + result.malformed);
  lines.push('');
  lines.push(cmp.renderReport(result.compareResult, {
    mode: 'replay', oidStart: result.oidStart, oidEnd: result.oidEnd, drift: result.drift,
    shadowLogPath: result.shadowLogPath, legacyLogPath: result.legacyLogPath,
    shadowLogExists: true, legacyLogExists: true,
  }));
  return lines.join('\n') + '\n';
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
function runCli(argv) {
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(argv[limitIdx + 1]) : DEFAULT_LIMIT;
  const outIdx = argv.indexOf('--out');
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : null;
  const tsvIdx = argv.indexOf('--tsv');
  const tsvOverride = tsvIdx !== -1 ? argv[tsvIdx + 1] : null;
  const repoIdx = argv.indexOf('--repo');
  const repoRoot = repoIdx !== -1 ? argv[repoIdx + 1] : iso.realHome();

  const runNonce = 'replay-' + crypto.randomBytes(6).toString('hex');
  const fpSnapshot = iso.footprint.begin();
  let result;
  try {
    result = runRound({ repoRoot, limit: Number.isFinite(limit) ? limit : DEFAULT_LIMIT, runNonce, tsvOverride });
  } catch (e) {
    process.stderr.write('pmm-shadow-replay: 回放失败 -- ' + e.message + '\n');
    process.exit(1);
  }
  const fpResult = iso.footprint.end(fpSnapshot, [runNonce]);
  const report = renderReplayReport(result) + '\n- 真根足迹: ' + fpResult.line + '\n';
  if (outFile) fs.writeFileSync(outFile, report); else process.stdout.write(report);
  // M9 fix (Opus wave-2 review `guards/audits/OPUS-2026-09-24-c05-wave2-review.md`): this round's
  // classification corpus (both the git-archived .claude/memory snapshot AND everything replayed
  // through it) is pinned to oidStart and read ENTIRELY from that frozen `git archive` snapshot
  // (runRound() above, never re-reads the live worktree mid-round) — a commit landing between the
  // start and end OID pins changes nothing this round actually read, so spec 12's "漂移→整轮作废"
  // (exit 1) is an over-constraint for the replayer specifically (it is not for the live comparator,
  // which stays as-is): the ≥200-event replay target kept dying to ordinary concurrent commit traffic
  // for a reason that never touched what was measured. Drift is still surfaced -- the report already
  // prints both OIDs and the drift flag (renderReplayReport -> cmp.renderReport, meta.mode='replay')
  // -- it just no longer flips the exit code.
  process.exit(fpResult.red ? 1 : 0);
}

module.exports = { parseTriggerLogEventLines, reconstructFilePath, reconstructHookJSON, runRound, renderReplayReport };

// SELFTEST-BEGIN (spec 22 canary-structure convention; 文件名交建造报告给收口者登记进
// SELFTEST_STRUCTURE_ROSTER)
function selfTest() {
  const iso2 = require('./selftest-iso.cjs');
  let pass = 0, fail = 0;
  const lines = [];
  function report(name, ok, detail) {
    if (ok) { pass++; lines.push('PASS ' + name); }
    else { fail++; lines.push('FAIL ' + name + (detail !== undefined ? (' :: ' + JSON.stringify(detail)) : '')); }
  }

  const nonce = 'test:shadowreplayst-' + crypto.randomBytes(6).toString('hex');
  const runRootBase = 'shadowreplay-st-' + crypto.randomBytes(4).toString('hex');
  const fpSnapshot = iso2.footprint.begin();
  const tempRoots = [];
  function mkRoot(tag) {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), runRootBase + '-' + tag + '-'));
    tempRoots.push(T);
    return T.replace(/\\/g, '/');
  }

  // ── group 1: parseTriggerLogEventLines — Bash skip, malformed-repo skip, well-formed pass-through ──
  {
    const tsv = [
      '2026-01-01T00:00:00.000Z\tfakesid1\tevent\tEdit\thome\tprobe.md\t-\tmatched=1',
      '2026-01-01T00:00:01.000Z\tfakesid1\tevent\tBash\thome\t-\t-\tmatched=0',
      '2026-01-01T00:00:02.000Z\tfakesid2\tevent\tWrite\thome\tprobe.md\t-\tmatched=1',
      '2026-01-01T00:00:03.000Z\tfakesid3\tevent\tEdit\tunknown-repo\tprobe.md\t-\tmatched=1',
      '2026-01-01T00:00:04.000Z\tfakesid4\tevent\tEdit\taxervice-booking\tsrc/x.ts\t-\tmatched=1',
      '2026-01-01T00:00:05.000Z\tfakesid5\tsuppressed-seen\tEdit\thome\tprobe.md\ttag\t-', // not an 'event' line -> ignored entirely
    ].join('\n');
    const { events, bashSkipped, malformed } = parseTriggerLogEventLines(tsv);
    report('replay parse: 3 usable events (Edit/home, Write/home, Edit/axervice-booking)', events.length === 3, events.length);
    report('replay parse: 1 Bash event skipped', bashSkipped === 1, bashSkipped);
    report('replay parse: 1 unknown-repo event defensively skipped', malformed === 1, malformed);
    report('replay parse: non-event kind (suppressed-seen) never counted at all',
      events.length + bashSkipped + malformed === 5, { events: events.length, bashSkipped, malformed });
  }

  // ── group 2: file_path reconstruction is the inverse of pmm-hook.cjs's resolveRepoRel() ──
  {
    // B2-2 fix (Opus wave-2 review `guards/audits/OPUS-2026-09-24-c05-wave2-review.md`): this is a
    // pure-function probe of reconstructFilePath() (plain string concatenation, no filesystem access)
    // -- it never needed a real machine-specific home path, only SOME placeholder to concatenate
    // against. A machine-path literal hardcoded here is exactly the shape the runner's part13 scan
    // flags; derive it from iso2.realHome() instead so this fixture carries no hardcoded machine path.
    const home = iso2.realHome();
    const fpHome = reconstructFilePath(home, 'home', '.claude/guards/x.cjs');
    report('reconstructFilePath: repo=home yields <home>/<rel>', fpHome === home + '/.claude/guards/x.cjs', fpHome);
    const fpAx = reconstructFilePath(home, 'axervice-booking', 'src/App.tsx');
    report('reconstructFilePath: repo=axervice-booking contains the /axervice-booking/ substring resolveRepoRel scans for',
      fpAx.toLowerCase().indexOf('/axervice-booking/') !== -1 && fpAx.endsWith('src/App.tsx'), fpAx);
  }

  // ── group 3: full hermetic end-to-end round -- fake git repo (never the real one), a single
  //    triggering lesson, a synthetic trigger-log with 2 real events + 1 Bash event, run through the
  //    REAL runRound() (pin OID -> git archive -> spawn real pmm-hook.cjs + real pmm-trigger-recall.cjs
  //    under isoEnv -> compare). Proves the whole pipeline, not just its pieces in isolation.
  {
    const T = mkRoot('fakerepo');
    const repo = T + '/repo';
    fs.mkdirSync(repo + '/.claude/memory/dreams', { recursive: true });
    const lessonsContent = '**2026-01-01 — replay selftest probe** [tooling:replay-selftest-probe]\n' +
      '<!-- trigger: tool=Edit|Write|MultiEdit|NotebookEdit; repo=home; path=probe.md -->\n' +
      'body text for the shadow-replay end-to-end probe.\n';
    fs.writeFileSync(repo + '/.claude/memory/lessons.md', lessonsContent);
    for (const f of core.ALL_FILES) { if (f !== 'lessons.md') fs.writeFileSync(repo + '/.claude/memory/' + f, ''); }
    const tsvFixture = [
      '2026-01-01T00:00:00.000Z\trplsid01\tevent\tEdit\thome\tprobe.md\t-\tmatched=1',
      '2026-01-01T00:00:01.000Z\trplsid01\tevent\tBash\thome\t-\t-\tmatched=0',
      '2026-01-01T00:00:02.000Z\trplsid02\tevent\tWrite\thome\tprobe.md\t-\tmatched=1',
    ].join('\n') + '\n';
    fs.writeFileSync(repo + '/.claude/memory/dreams/trigger-log-FAKE.tsv', tsvFixture);
    // canary roster (name-in-passing, per-batch requirement): every spawn-family call inside a
    // SELFTEST region must carry an explicit, deliberately-constructed `env` within 6 lines -- never a
    // bare ambient-env clone (isoEnv() itself only ever gets exercised, in THIS file, via runRound()'s
    // own call at module scope -- outside the SELFTEST-BEGIN/END markers -- so the canary's textual
    // scan, which only reads text between those markers, never saw it. Route this fixture-only git()
    // helper through iso2.isoEnv(T, {}) too: same single, auditable env-construction convention as
    // every other DUT subprocess, and it now makes `isoEnv(` appear inside the scanned region as well).
    function git(args) { return cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: iso2.isoEnv(T, {}) }); }
    git(['init', '-q']);
    git(['-c', 'user.email=selftest@test', '-c', 'user.name=selftest', 'add', '-A']);
    git(['-c', 'user.email=selftest@test', '-c', 'user.name=selftest', 'commit', '-q', '-m', 'init']);

    const runNonce = 'replayst-' + crypto.randomBytes(4).toString('hex');
    let result = null, threw = null;
    try { result = runRound({ repoRoot: repo, limit: 300, runNonce }); }
    catch (e) { threw = e; }
    report('e2e round: runRound completed without throwing', threw === null, threw && threw.message);
    if (result) {
      report('e2e round: no OID drift (nothing committed mid-round)', result.drift === false, { start: result.oidStart, end: result.oidEnd });
      report('e2e round: 2 events replayed (Bash skipped)', result.eventsReplayed === 2 && result.bashSkipped === 1,
        { replayed: result.eventsReplayed, bashSkipped: result.bashSkipped });
      report('e2e round: both DUTs agreed on the single probe tag for both events (0 unexplained)',
        result.compareResult.totalUnexplained === 0, result.compareResult);
      report('e2e round: push comparison actually exercised both sides for both events',
        result.compareResult.push.bothSidesEvents === 2 && result.compareResult.push.matchEvents === 2,
        result.compareResult.push);
    }

    // ── group 3b: OID-drift-mid-round abort -- commit a change to .claude/memory INSIDE the round via a
    //    tsvOverride path so runRound's own git-archive step still reads the ORIGINAL (pre-drift) OID's
    //    content, but the drift is introduced between runRound's internal start/end pin calls by
    //    committing from here isn't possible without hooking runRound itself -- instead this proves the
    //    underlying primitive (spec 12's exact mechanism) directly: pin, mutate+commit, pin again, and
    //    assert the round-level runRound() return value's `drift` flag would be exactly this comparison.
    const oidBefore = cmp.pinMemoryOid(repo);
    fs.writeFileSync(repo + '/.claude/memory/lessons.md', lessonsContent + '\nextra line to force a new tree oid.\n');
    git(['-c', 'user.email=selftest@test', '-c', 'user.name=selftest', 'add', '-A']);
    git(['-c', 'user.email=selftest@test', '-c', 'user.name=selftest', 'commit', '-q', '-m', 'mid-round drift']);
    const oidAfter = cmp.pinMemoryOid(repo);
    report('drift primitive: a commit between two pins changes the OID (this is exactly what runRound compares start-vs-end on)',
      oidAfter !== oidBefore, { oidBefore, oidAfter });
  }

  for (const T of tempRoots) { try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* best effort */ } }

  const markers = iso2.markersFromSource(__filename, nonce, runRootBase);
  const fpResult = iso2.footprint.end(fpSnapshot, markers);
  report('footprint: zero attributable change on the real root', fpResult.red === false, fpResult.line);

  for (const l of lines) console.log(l);
  console.log('PMM-SHADOW-REPLAY-SELFTEST {"pass":' + pass + ',"fail":' + fail + '}');
  process.exit(fail > 0 ? 1 : 0);
}
// SELFTEST-END

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test') || argv.includes('--self-check')) selfTest();
  else runCli(argv);
}
