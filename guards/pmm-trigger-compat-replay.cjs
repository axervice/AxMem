#!/usr/bin/env node
// pmm-trigger-compat-replay.cjs — MED-7 fix (2026-09-15, guards/audits/FABLE-2026-09-15-glob-review-
// triage.md finding 7 / CODEX-2026-09-15-glob-spec-review.md finding 7): the build-time compatibility
// claim ("56 条前缀式 trigger 的命中集合逐事件完全相同") was a stale, hardcoded count (真库当时已是 88
// 条:18 精确/68 末尾星/2 复合) computed once, off-script, against a log window where 13 of 52
// trigger-bearing entries never fired even once — for those, "old hit-set == new hit-set" is comparing
// the empty set to the empty set, which is vacuously true and proves nothing. Usage:
//   --check        dynamically classify EVERY current live+archived path trigger, replay it against
//                  every real event in memory/dreams/trigger-log-*.tsv, and report, PER TRIGGER,
//                  whether it has at least one REAL positive hit (backward-compat verified against
//                  real evidence) or none (falls back to one SYNTHETIC example, clearly labeled as
//                  such — never counted as "zero-diff"). Exits non-zero only on an actual detected
//                  regression (a real hit where the legacy prefix/exact semantics and the current
//                  compileTriggerPath semantics disagree) — an all-synthetic run is NOT a failure, it
//                  is an honest coverage gap this script surfaces instead of hiding.
//   --self-test    hermetic, matcher-injectable unit test of the replay/classify logic itself (see
//                  fixtures/v3/trigger-compat-replay-selftest.cjs) — proves the SCRIPT can actually
//                  detect a regression and correctly distinguishes real from synthetic coverage,
//                  independent of whether the current real corpus happens to have zero divergences
//                  (it should, by construction of the HIGH-1 fix — that is not this script's own test).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── pure, matcher-injectable core (exported for --self-test to unit-test in isolation) ────────────
function classifyShape(pattern) {
  const stars = (pattern.match(/\*/g) || []).length;
  if (stars === 0) return 'exact';
  if (stars === 1 && pattern.endsWith('*')) return 'prefix';
  return 'glob';
}

// The ORIGINAL (pre-glob, pre-0ee7541) two-way ternary — kept here ONLY as the backward-compat
// reference oracle for 'exact'/'prefix'-shaped patterns (the 56→68 forms this must never regress).
// 'glob'-shaped patterns are explicitly NOT compared against this — a glob pattern behaving
// differently from this legacy oracle is the entire POINT of the 2026-09-15 feature, not a defect.
function legacyMatch(pattern, relLower) {
  const p = pattern.toLowerCase();
  return p.endsWith('*') ? relLower.startsWith(p.slice(0, -1)) : relLower === p;
}

// Build one representative candidate path from a pattern when no real log event ever exercised it —
// substitutes every wildcard run with a short literal token so the synthesized path is guaranteed (by
// construction) to satisfy the pattern's own compiled regex; used ONLY for the SYNTHETIC-coverage
// label, never presented as evidence of real-world behavior.
function synthesizeCandidate(pattern) {
  return pattern.replace(/\*\*\//g, '').replace(/\*\*/g, 'synthetic-dir/inner').replace(/\*/g, 'synthetic');
}

// trigger: {tag, path, repo}. eventsForRepo: [{rel}, ...] (already filtered to trigger.repo).
// newMatchFn(pattern, relLower) -> bool — defaults to the real compileTriggerPath at call sites; the
// self-test injects alternates to exercise the FAIL path deterministically.
function replayOne(trigger, eventsForRepo, newMatchFn) {
  const shape = classifyShape(trigger.path);
  const relsLower = eventsForRepo.map((e) => e.rel.toLowerCase());
  const realHits = relsLower.filter((rel) => newMatchFn(trigger.path, rel));
  const result = { tag: trigger.tag, path: trigger.path, repo: trigger.repo, shape, realHitCount: realHits.length };
  if (shape !== 'glob') {
    const mismatches = [];
    for (const rel of relsLower) {
      const oldV = legacyMatch(trigger.path, rel);
      const newV = newMatchFn(trigger.path, rel);
      if (oldV !== newV) mismatches.push({ rel, oldV, newV });
    }
    result.compatChecked = relsLower.length;
    result.compatMismatches = mismatches;
  } else {
    result.compatChecked = null; // glob shapes are exempt from the legacy-parity requirement by design
    result.compatMismatches = [];
  }
  if (realHits.length > 0) {
    result.coverage = 'real';
  } else {
    const synth = synthesizeCandidate(trigger.path);
    const synthOk = newMatchFn(trigger.path, synth.toLowerCase());
    result.coverage = 'synthetic';
    result.synthesizedExample = synth;
    result.synthesizedExampleMatches = synthOk;
  }
  return result;
}

function replayAll(triggers, events, newMatchFn) {
  const byRepo = new Map();
  for (const e of events) {
    if (!byRepo.has(e.repo)) byRepo.set(e.repo, []);
    byRepo.get(e.repo).push(e);
  }
  const results = triggers.map((t) => replayOne(t, byRepo.get(t.repo) || [], newMatchFn));
  const total = results.length;
  const realCovered = results.filter((r) => r.coverage === 'real').length;
  const syntheticOnly = results.filter((r) => r.coverage === 'synthetic').length;
  const compatFails = results.filter((r) => r.compatMismatches.length > 0);
  return { results, total, realCovered, syntheticOnly, compatFailCount: compatFails.length, compatFails };
}

// Opus O-4 fix (2026-09-15 round 2, guards/audits/OPUS-2026-09-15-repair-review.md "O-4"): the CLI
// used to exit 0 whenever compatFailCount===0, INCLUDING when realCovered===0 — an empty real event
// log makes every trigger's realsLower empty, so every compat comparison is vacuously "consistent"
// (empty set vs empty set) and the run reports "全部一致" with zero actual evidence behind it. Pull the
// pass/fail decision out into its own pure function so --self-test can unit-test it hermetically
// (previously NOTHING tested this decision at all — see the audit's own finding: "全仓 grep 只有一处
// 引用:guard-canary.sh:89,跑的是 --self-test" — --check itself had zero coverage).
// R5-4 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-3 /
// FABLE-2026-09-15-codex-cumulative-triage.md R5-4): report.total===0 (the parser found ZERO path
// triggers anywhere in the corpus) used to be indistinguishable from a legitimate state — zeroRealCoverage
// required `total > 0` to even consider firing, and compatFailCount is trivially 0 when there is
// nothing to compare, so `decideCheckExitCode({total:0,...})` returned `{code:0}`. The real corpus
// currently parses 92 path triggers; total===0 is never a legitimate "empty library", it is the
// parsing/wiring pipeline (core.parseAll()/entries[].triggers, or this script's own extraction loop)
// having come unplugged — the entire compat-replay detection network going dark while still reporting
// green ("全绿" because there was nothing left to check). Treat it as its own distinct failure mode.
function decideCheckExitCode(report) {
  const zeroTriggersParsed = report.total === 0;
  const zeroRealCoverage = report.total > 0 && report.realCovered === 0;
  const fail = report.compatFailCount > 0 || zeroRealCoverage || zeroTriggersParsed;
  return { code: fail ? 1 : 0, zeroRealCoverage, zeroTriggersParsed, compatFail: report.compatFailCount > 0 };
}

// MEDIUM-8 fix (2026-09-23, codex final triage #8 / fab blind delta M-8, 批 A3): --check used to read
// ONLY the FROZEN in-repo memory/dreams/trigger-log-*.tsv archive. Since 9e4f477 moved this hook's live
// telemetry to PMM_RECALL_ROOT (.local/pmm-recall/trigger-log-*.tsv, never committed to the repo),
// "real coverage" evidence stopped growing the moment that move landed -- measured 2026-09-23: 271
// unique (repo,rel) event pairs exist in the live log, 226 of which the frozen archive has never seen.
// Pulled out into its own function (pure aside from the two fs calls) so this file's own --self-test
// can prove the union actually picks up a (repo,rel) pair that exists in only ONE of the two
// directories, without touching fixtures/v3/trigger-compat-replay-selftest.cjs (outside this batch's
// write face). Dedup key/format is UNCHANGED from the pre-fix single-directory version -- only the
// directory list grew from one to two, so the frozen archive's own rows stay IN the union (still real
// evidence, just old) rather than being replaced.
function collectEventsFromDirs(dirs) {
  const events = [];
  const seen = new Set();
  for (const dir of dirs) {
    let logFiles = [];
    try { logFiles = fs.readdirSync(dir).filter((f) => /^trigger-log-.*\.tsv$/.test(f) || f === 'trigger-log.tsv'); } catch { logFiles = []; }
    for (const f of logFiles) {
      let text; try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        const cols = line.split('\t');
        if (cols.length < 6) continue;
        const stage = cols[2], repo = cols[4], rel = cols[5];
        if (stage !== 'event') continue;
        if (!repo || repo === '-' || !rel || rel === '-') continue;
        const key = repo + '' + rel;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({ repo, rel });
      }
    }
  }
  return events;
}

// MEDIUM-8 self-test (2026-09-23, 批 A3): a (repo,rel) pair that exists ONLY in the live root's log
// (never in the frozen dreams archive) must still count as real coverage -- exactly the gap the fix
// closes. Hermetic temp dirs, independent of the real corpus/logs; also exercises the pre-fix
// single-directory behavior directly (scanning ONLY the frozen dir) to show it structurally cannot see
// the live-only event -- the same 226-pair gap the real corpus measurement found.
function selfTestUnionCoversLiveOnly() {
  const os = require('os');
  const dreamsTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-replay-dreams-'));
  const liveTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-replay-live-'));
  try {
    fs.writeFileSync(path.join(dreamsTmp, 'trigger-log-x.tsv'), ['ts', 'sess', 'event', 'Edit', 'home', 'frozen/only.ts', '-', '-'].join('\t') + '\n');
    fs.writeFileSync(path.join(liveTmp, 'trigger-log-y.tsv'), ['ts', 'sess', 'event', 'Edit', 'home', 'live/only.ts', '-', '-'].join('\t') + '\n');
    const frozenOnlyEvents = collectEventsFromDirs([dreamsTmp]); // pre-fix behavior: frozen dir alone
    const preFixSeesLive = frozenOnlyEvents.some((e) => e.repo === 'home' && e.rel === 'live/only.ts');
    const unionEvents = collectEventsFromDirs([dreamsTmp, liveTmp]); // post-fix behavior: the union
    const hasFrozen = unionEvents.some((e) => e.repo === 'home' && e.rel === 'frozen/only.ts');
    const hasLive = unionEvents.some((e) => e.repo === 'home' && e.rel === 'live/only.ts');
    const pass = !preFixSeesLive && hasFrozen && hasLive;
    console.log(`trigger-compat-replay-selftest [MEDIUM-8 union]: ${pass ? 'pass' : 'FAIL'} (frozen-dir-alone-sees-live=${preFixSeesLive}, union-has-frozen=${hasFrozen}, union-has-live=${hasLive})`);
    return pass ? 0 : 1;
  } finally {
    fs.rmSync(dreamsTmp, { recursive: true, force: true });
    fs.rmSync(liveTmp, { recursive: true, force: true });
  }
}

// LOW-1 fix (2026-09-23, Opus A3 review `audits/OPUS-2026-09-23-a1-a3-review.md`): the union self-test
// above only proved collectEventsFromDirs() itself unions two directories -- it never proved --check's
// OWN CLI wiring actually calls that helper with (dreamsDir, ledger.resolveRoot()). The reviewer's
// repro: revert the CLI back to `collectEventsFromDirs([dreamsDir])` (i.e. undo the MEDIUM-8 fix) and
// BOTH the old self-test AND `--check` itself stayed green -- "改前"/"改后" were comparing the SAME
// helper called two different ways by the TEST, never exercising the CLI's actual argument list, so
// the required "撤掉修法必须红" property never held. This spawns the REAL `--check` CLI as a child
// process (the exact code path a production run takes), with an isolated PMM_MEM_DIR carrying exactly
// ONE path trigger and an isolated PMM_RECALL_ROOT carrying ONLY a live trigger-log event for that
// trigger -- PMM_MEM_DIR has no dreams/ subdirectory at all, so frozen coverage is structurally 0 and
// the ONLY way this trigger can show real coverage is if the CLI actually reads PMM_RECALL_ROOT.
// Reverting the CLI's dreamsDir/liveRoot union back to dreamsDir-only makes this fail (0/1 real
// coverage, non-zero exit) because the event genuinely only exists in the live root this test controls.
// SELFTEST-BEGIN
function selfTestCheckWiredToLiveRoot() {
  const os = require('os');
  const cp = require('child_process');
  const memTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-replay-check-mem-'));
  const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-replay-check-root-'));
  try {
    for (const f of ['decisions.md', 'standinginstructions.md', 'classes.md', 'decisions-archive.md', 'lessons-archive.md', 'standinginstructions-archive.md']) {
      fs.writeFileSync(path.join(memTmp, f), '');
    }
    fs.writeFileSync(path.join(memTmp, 'lessons.md'), [
      '**2026-01-01 — compat-replay wiring probe** [test:compatwire-probe]',
      '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/checkwire-probe.sh -->',
      'body',
      '',
    ].join('\n'));
    // deliberately NO memTmp/dreams directory -- frozen coverage for this trigger is structurally 0;
    // the one matching event exists ONLY under rootTmp (the live root).
    fs.writeFileSync(path.join(rootTmp, 'trigger-log-selftest.tsv'),
      ['ts', 'sess', 'event', 'Edit', 'home', '.claude/guards/checkwire-probe.sh', '-', '-'].join('\t') + '\n');
    const iso = require('./selftest-iso.cjs');
    const res = cp.spawnSync(process.execPath, [__filename, '--check'], {
      env: iso.isoEnv(rootTmp, { PMM_MEM_DIR: memTmp, PMM_RECALL_ROOT: rootTmp }),
      encoding: 'utf8',
    });
    const out = res.stdout || '';
    const m = out.match(/正例覆盖\(真实命中过至少一次\): (\d+)\/(\d+)/);
    const realCovered = m ? parseInt(m[1], 10) : -1;
    const total = m ? parseInt(m[2], 10) : -1;
    const pass = res.status === 0 && total === 1 && realCovered === 1;
    console.log(`trigger-compat-replay-selftest [LOW-1 --check wiring]: ${pass ? 'pass' : 'FAIL'} (exit=${res.status}, realCovered=${realCovered}/${total})`);
    return pass ? 0 : 1;
  } finally {
    fs.rmSync(memTmp, { recursive: true, force: true });
    fs.rmSync(rootTmp, { recursive: true, force: true });
  }
}

// A3-尾-3 (2026-09-23, Opus 指令第3条,复现 [tooling:selftest-must-redirect-every-root-the-tool-writes]);
// superseded 2026-09-23 by spec 22 (K8): the ORIGINAL version of this function derived "real root" via
// ledgerMod.resolveRoot()/core.memDir() -- both env-dependent, so once this self-test itself is invoked
// under a redirected HOME (which 21's isolation gate will require), "real root" silently resolved to
// the REDIRECTED temp root instead of the true machine home, and the whole check watched the wrong
// directory. Replaced by the shared selftest-iso.cjs footprint (realHome() is __dirname-derived, never
// env-derived) plus its markersFromSource() static scan (this file's own MARKERS list below still feeds
// in as extra literal substrings via footprint.end()'s marker set).
function selfTestZeroFootprint(runSelfTests) {
  const iso = require('./selftest-iso.cjs');
  const nonce = 'nonce-' + crypto.randomBytes(6).toString('hex');
  const extraMarkers = ['frozen/only.ts', 'live/only.ts', 'checkwire-probe', 'compatwire-probe'];
  const snap = iso.footprint.begin();
  const rc = runSelfTests();
  const markers = iso.markersFromSource(__filename, nonce, '').concat(extraMarkers);
  const fp = iso.footprint.end(snap, markers);
  console.log(`trigger-compat-replay-selftest [zero-footprint]: ${fp.red ? 'FAIL' : 'pass'} ${fp.line}`);
  return { rc, leak: fp.red };
}
// SELFTEST-END

module.exports = { classifyShape, legacyMatch, synthesizeCandidate, replayOne, replayAll, decideCheckExitCode, collectEventsFromDirs };

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--self-test') {
    // A3-尾-3: the whole self-test run (fixtures + union + wiring) is wrapped by the zero-footprint
    // snapshot so a leak anywhere in it -- not just in the two helpers already reviewed -- gets caught.
    const { rc: combinedRc, leak } = selfTestZeroFootprint(() => {
      const rc1 = require('./fixtures/v3/trigger-compat-replay-selftest.cjs').run();
      // MEDIUM-8 (2026-09-23, 批 A3): the fixtures self-test file is outside this batch's write face, so
      // the union-of-two-directories case lives here instead and is combined into the same exit code.
      const rc2 = selfTestUnionCoversLiveOnly();
      // LOW-1 (2026-09-23, Opus A3 review): rc2 alone proves the HELPER unions two dirs; rc3 proves
      // --check's CLI ACTUALLY calls that helper with (dreamsDir, ledger.resolveRoot()) by spawning the
      // real CLI and reading its own reported coverage -- see selfTestCheckWiredToLiveRoot's own comment.
      const rc3 = selfTestCheckWiredToLiveRoot();
      return (rc1 !== 0 || rc2 !== 0 || rc3 !== 0) ? 1 : 0;
    });
    process.exit((combinedRc !== 0 || leak) ? 1 : 0);
  }
  if (args[0] !== '--check') {
    console.error('用法: pmm-trigger-compat-replay.cjs --check | --self-test');
    process.exit(2);
  }
  const core = require('./pmm-core.cjs');
  const trig = require('./pmm-trigger-recall.cjs');
  const ledger = require('./pmm-recall-ledger.cjs');
  const snap = core.snapshot('worktree');
  const parsed = core.parseAll(snap);
  const triggers = [];
  for (const e of parsed.entries) {
    for (const tr of e.triggers) {
      if (tr.kind === 'path') triggers.push({ tag: e.id || e.rawIdentity || `${e.file}:${e.titleLineNo}`, path: tr.path, repo: tr.repo });
    }
  }
  const memDir = core.memDir();
  const dreamsDir = memDir + '/dreams';
  // MEDIUM-8: union of the frozen in-repo archive and the live PMM_RECALL_ROOT log -- see
  // collectEventsFromDirs's own header comment for why the frozen-only version undercounts today.
  const liveRoot = ledger.resolveRoot();
  const events = collectEventsFromDirs([dreamsDir, liveRoot]);
  const newMatchFn = (pattern, relLower) => {
    let compiled;
    try { compiled = trig.compileTriggerPath(pattern); } catch { return false; }
    return trig.testTriggerPath(compiled, relLower); // Opus O-9: candidate-length cap, same as production
  };
  const report = replayAll(triggers, events, newMatchFn);
  console.log(`pmm-trigger-compat-replay --check: ${report.total} 条 path trigger,真实日志 ${events.length} 条去重事件`);
  console.log(`  正例覆盖(真实命中过至少一次): ${report.realCovered}/${report.total}`);
  console.log(`  仅合成覆盖(真实日志从未命中,用构造样例验证可编译可命中,不计入零差异): ${report.syntheticOnly}/${report.total}`);
  if (report.syntheticOnly > 0) {
    console.log('  仅合成覆盖清单:');
    for (const r of report.results) if (r.coverage === 'synthetic') console.log(`    [${r.tag}] path=${r.path} repo=${r.repo} → 合成样例=${r.synthesizedExample}(${r.synthesizedExampleMatches ? '合成样例本身可命中' : '⚠️ 合成样例竟不命中,pattern 可能有问题'})`);
  }
  console.log(`  向后兼容(exact/prefix 形态,逐事件 legacy==new): ${report.compatFailCount === 0 ? '全部一致' : report.compatFailCount + ' 条不一致'}`);
  if (report.compatFailCount > 0) {
    for (const r of report.compatFails) {
      console.log(`    ✖ [${r.tag}] path=${r.path} repo=${r.repo} 形态=${r.shape}`);
      for (const mm of r.compatMismatches.slice(0, 3)) console.log(`        rel=${mm.rel} legacy=${mm.oldV} new=${mm.newV}`);
    }
  }
  const decision = decideCheckExitCode(report);
  if (decision.zeroTriggersParsed) {
    console.log(`  ✖ 解析出 0 条 path trigger:这不是合法的空库(真库现解析约 92 条),是解析接线断了 —— 整张检测网断电却报告"全部一致"(R5-4)。`);
    console.log(`    常见成因:core.parseAll()/entries[].triggers 取值方式变了、语料路径(PMM_MEM_DIR)指错、或本脚本自己的抽取循环出错 —— 检查后重跑。`);
  } else if (decision.zeroRealCoverage) {
    console.log(`  ✖ 真实覆盖为 0/${report.total}:没有一条 trigger 命中过真实事件日志 —— "向后兼容全部一致"在此是空集对空集的恒真,不构成证据(Opus O-4)。`);
    console.log(`    常见成因:PMM_MEM_DIR 指向的语料没有 dreams/trigger-log-*.tsv,或事件日志本身为空 —— 检查环境后重跑。`);
  }
  process.exit(decision.code);
}
