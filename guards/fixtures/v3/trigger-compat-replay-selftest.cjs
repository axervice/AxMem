'use strict';
// trigger-compat-replay-selftest.cjs — hermetic, matcher-injectable self-test for
// pmm-trigger-compat-replay.cjs (MED-7, 2026-09-15). Never touches the real corpus or real event
// logs — everything here is synthetic so the three categories (real-covered / synthetic-only /
// compat-fail) can each be constructed and asserted deterministically, including a DELIBERATE
// regression that a correct replay must catch.
//
// 2026-09-15 round 2 (Opus O-5, guards/audits/OPUS-2026-09-15-repair-review.md): every case below this
// header comment used to use an INJECTED matcher (correctMatch/regressedMatch/newMatch) — proving only
// that replayOne/replayAll's OWN bookkeeping is correct given SOME matcher, completely decoupled from
// whether the REAL compileTriggerPath (pmm-trigger-recall.cjs) is actually wired in and working. The
// audit broke the real matcher three different ways (classifyTriggerLine→null, compileTriggerPath→
// always-match, HIGH-1 reverted) and this file stayed 19/19 green every time — "造好没通电" on a brand
// new canary. Case E below closes that: it calls the REAL compileTriggerPath, the same way --check's
// own newMatchFn does, against the EXACT HIGH-1 regression shape — so reverting HIGH-1 (or breaking
// compileTriggerPath/classifyTriggerLine any other way) flips it red.
const { classifyShape, replayOne, replayAll, legacyMatch, decideCheckExitCode } = require('../../pmm-trigger-compat-replay.cjs');
const trig = require('../../pmm-trigger-recall.cjs');

function run() {
  let pass = 0, fail = 0;
  const fails = [];
  function ok(name, cond, detail) {
    if (cond) pass++; else { fail++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); }
  }

  ok('classifyShape: no star is exact', classifyShape('foo/bar.md') === 'exact');
  ok('classifyShape: single trailing star is prefix', classifyShape('foo/*') === 'prefix');
  ok('classifyShape: mid-string star is glob', classifyShape('foo/*bar*') === 'glob');
  ok('classifyShape: ** is glob', classifyShape('foo/**/bar') === 'glob');

  // A "correct" matcher for this self-test: mirrors real compileTriggerPath semantics closely enough
  // for these synthetic cases (prefix = startsWith; exact = equality) — used for cases A/B where we
  // want old/new to genuinely AGREE.
  const correctMatch = (pattern, relLower) => {
    const p = pattern.toLowerCase();
    return p.endsWith('*') ? relLower.startsWith(p.slice(0, -1)) : relLower === p;
  };

  // ── Case A: real hit, legacy and new agree → 'real' coverage, zero compat mismatches ───────────
  {
    const trigger = { tag: 'test:has-real-hit', path: 'foo/*', repo: 'home' };
    const events = [{ rel: 'foo/bar.ts' }, { rel: 'unrelated/x.ts' }];
    const r = replayOne(trigger, events, correctMatch);
    ok('Case A: real hit is coverage=real', r.coverage === 'real', JSON.stringify(r));
    ok('Case A: no compat mismatches', r.compatMismatches.length === 0, JSON.stringify(r));
    ok('Case A: realHitCount === 1', r.realHitCount === 1, JSON.stringify(r));
  }

  // ── Case B: zero real hits → 'synthetic' coverage, MUST NOT be reported as real/zero-diff ───────
  {
    const trigger = { tag: 'test:zero-hits', path: 'neverhit/*', repo: 'home' };
    const events = [{ rel: 'foo/bar.ts' }, { rel: 'unrelated/x.ts' }]; // neither touches neverhit/
    const r = replayOne(trigger, events, correctMatch);
    ok('Case B: zero real hits is coverage=synthetic (NOT real)', r.coverage === 'synthetic', JSON.stringify(r));
    ok('Case B: synthesized example is provided and self-consistent', r.synthesizedExampleMatches === true, JSON.stringify(r));
    ok('Case B: realHitCount === 0', r.realHitCount === 0, JSON.stringify(r));
    // the exact defect MED-7 flags: a NAIVE "old hit-count === new hit-count" check would call this
    // a "zero-diff pass" — demonstrate that naive check disagrees with the honest categorization here.
    const naiveOldHits = events.filter((e) => legacyMatch(trigger.path, e.rel.toLowerCase())).length;
    const naiveNewHits = events.filter((e) => correctMatch(trigger.path, e.rel.toLowerCase())).length;
    const naiveWouldClaimZeroDiffPass = naiveOldHits === naiveNewHits; // both 0 here — vacuously "equal"
    ok('Case B: the OLD naive zero-vs-zero methodology would have wrongly called this a covered pass (MED-7\'s actual defect)', naiveWouldClaimZeroDiffPass === true, `naiveOldHits=${naiveOldHits} naiveNewHits=${naiveNewHits}`);
  }

  // ── Case C: a REAL hit where legacy and new DISAGREE → must be flagged as a compat FAIL ─────────
  // (deliberately injects a "new" matcher that regresses on a real logged event — this is the
  // detection path a genuine future regression must trip; it is not a claim that the CURRENT real
  // compileTriggerPath has this bug.)
  {
    const trigger = { tag: 'test:compat-break', path: 'src/lib/*', repo: 'axervice-booking' };
    const events = [{ rel: 'src/lib/a.ts' }];
    const regressedMatch = (pattern, relLower) => false; // pretends nothing ever matches — a regression
    const r = replayOne(trigger, events, regressedMatch);
    ok('Case C: real logged event exists but is now a mismatch → compatMismatches non-empty', r.compatMismatches.length === 1, JSON.stringify(r));
    ok('Case C: (since the injected matcher says false) coverage falls to synthetic, not silently "real"', r.coverage === 'synthetic', JSON.stringify(r));
  }

  // ── Case D: glob-shaped trigger legitimately differs from legacy (expected — the whole point of
  //    the feature) → must NOT be flagged as a compat fail (glob shapes are exempt by design).
  {
    const trigger = { tag: 'test:glob-expected-diff', path: 'src/lib/**/*lock*', repo: 'axervice-booking' };
    const events = [{ rel: 'src/lib/a/b-lock.ts' }]; // legacy could never match this (mid-string star)
    const newMatch = (pattern, relLower) => relLower.includes('lock'); // stand-in "new" behavior: matches
    const r = replayOne(trigger, events, newMatch);
    ok('Case D: glob shape is exempt from compat-mismatch accounting', r.compatMismatches.length === 0 && r.compatChecked === null, JSON.stringify(r));
    ok('Case D: glob shape still gets real coverage credit when it hits', r.coverage === 'real', JSON.stringify(r));
  }

  // ── replayAll aggregation: mixing all four cases, compatFailCount must isolate ONLY case C ──────
  {
    const triggers = [
      { tag: 'test:has-real-hit', path: 'foo/*', repo: 'home' },
      { tag: 'test:zero-hits', path: 'neverhit/*', repo: 'home' },
      { tag: 'test:compat-break', path: 'src/lib/*', repo: 'axervice-booking' },
    ];
    const events = [
      { repo: 'home', rel: 'foo/bar.ts' },
      { repo: 'axervice-booking', rel: 'src/lib/a.ts' },
    ];
    // use correctMatch for everything EXCEPT the axervice-booking repo, where we inject the regression
    const mixedMatch = (pattern, relLower) => {
      if (pattern === 'src/lib/*') return false; // regression, mirrors Case C
      return correctMatch(pattern, relLower);
    };
    const report = replayAll(triggers, events, mixedMatch);
    ok('replayAll: total === 3', report.total === 3, JSON.stringify(report));
    ok('replayAll: realCovered === 1 (only foo/*)', report.realCovered === 1, JSON.stringify({ realCovered: report.realCovered }));
    ok('replayAll: syntheticOnly === 2 (neverhit/* AND the regressed src/lib/*, which now has zero real hits)', report.syntheticOnly === 2, JSON.stringify({ syntheticOnly: report.syntheticOnly }));
    ok('replayAll: compatFailCount === 1 (isolates the injected regression, not the merely-uncovered trigger)', report.compatFailCount === 1, JSON.stringify({ compatFailCount: report.compatFailCount }));
  }

  // ── Case E (Opus O-5): REAL compileTriggerPath, not an injected stand-in — the exact `newMatchFn`
  // shape --check itself builds. Uses the HIGH-1 regression pattern as the discriminator: under the
  // FIXED semantics `src/lib/**/*lock*` must NOT match `src/lib/lock-cache/unrelated.ts` (lock sits in
  // a directory name, not the file name); under the pre-HIGH-1 (reverted) semantics it WOULD match.
  {
    const realMatchFn = (pattern, relLower) => {
      let compiled;
      try { compiled = trig.compileTriggerPath(pattern); } catch { return false; }
      return trig.testTriggerPath(compiled, relLower); // same shape as --check's own newMatchFn (Opus O-9 wrapper included)
    };
    const trigger = { tag: 'test:real-matcher-high1', path: 'src/lib/**/*lock*', repo: 'axervice-booking' };
    const events = [
      { rel: 'src/lib/lock-cache/unrelated.ts' }, // HIGH-1's exact false-positive shape — must NOT hit
      { rel: 'src/lib/a/b-lock.ts' }, // a genuine intended hit (lock in the FILE name) — must hit
    ];
    const r = replayOne(trigger, events, realMatchFn);
    ok('Case E (real compileTriggerPath): HIGH-1 false-positive path does not match', r.realHitCount === 1, JSON.stringify(r));
    const dirNameHit = realMatchFn(trigger.path, 'src/lib/lock-cache/unrelated.ts');
    ok('Case E: directory-name "lock" shape is rejected by the REAL matcher (would pass here if HIGH-1 were reverted or compileTriggerPath/classifyTriggerLine broke)', dirNameHit === false, 'dirNameHit=' + dirNameHit);
    const fileNameHit = realMatchFn(trigger.path, 'src/lib/a/b-lock.ts');
    ok('Case E: file-name "lock" shape still matches via the REAL matcher', fileNameHit === true, 'fileNameHit=' + fileNameHit);
    // also exercise a plain 'exact'-shaped real trigger through the REAL matcher end to end
    const exactTrigger = { tag: 'test:real-matcher-exact', path: 'docs/readme.md', repo: 'home' };
    const exactEvents = [{ rel: 'docs/readme.md' }, { rel: 'docs/other.md' }];
    const rExact = replayOne(exactTrigger, exactEvents, realMatchFn);
    ok('Case E: exact-shaped real trigger via REAL matcher hits exactly the matching event', rExact.realHitCount === 1 && rExact.coverage === 'real', JSON.stringify(rExact));
  }

  // ── Case F (Opus O-4): decideCheckExitCode is a pure function --check's own zero-real-coverage exit
  // path now goes through — unit-test it hermetically so a regression back to "compatFailCount===0 ⇒
  // exit 0 no matter what" is caught without needing a real (or emptied) event log.
  {
    const zeroCoverageReport = { total: 90, realCovered: 0, compatFailCount: 0 };
    const d1 = decideCheckExitCode(zeroCoverageReport);
    ok('Case F: total>0 + realCovered=0 + compatFailCount=0 → non-zero exit (the O-4 repro exactly)', d1.code === 1 && d1.zeroRealCoverage === true, JSON.stringify(d1));

    const healthyReport = { total: 90, realCovered: 70, compatFailCount: 0 };
    const d2 = decideCheckExitCode(healthyReport);
    ok('Case F: realCovered>0 + compatFailCount=0 → exit 0', d2.code === 0, JSON.stringify(d2));

    const compatFailReport = { total: 90, realCovered: 70, compatFailCount: 2 };
    const d3 = decideCheckExitCode(compatFailReport);
    ok('Case F: compatFailCount>0 → non-zero exit regardless of coverage', d3.code === 1 && d3.compatFail === true, JSON.stringify(d3));

    // R5-4 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-3 /
    // FABLE-2026-09-15-codex-cumulative-triage.md R5-4): this case used to assert the OPPOSITE —
    // that total===0 (the parser found ZERO path triggers in the entire corpus) legitimately exits 0
    // ("no triggers at all, not zero coverage of something"). That was the bug itself, locked in as
    // the expected behavior: real corpus parses ~92 path triggers, so total===0 is never a legitimate
    // empty library, it is the parsing pipeline having come unplugged — the whole detection network
    // going dark while still reporting green. Flipped: must now be a non-zero exit, distinct from
    // zeroRealCoverage (which requires total>0).
    const emptyTriggersReport = { total: 0, realCovered: 0, compatFailCount: 0 };
    const d4 = decideCheckExitCode(emptyTriggersReport);
    ok('Case F [R5-4]: total=0 (parsing pipeline unplugged, not a legitimate empty library) → non-zero exit', d4.code === 1 && d4.zeroTriggersParsed === true && d4.zeroRealCoverage === false, JSON.stringify(d4));

    // R5-4 positive control: a healthy non-empty total with real coverage must NOT trip zeroTriggersParsed.
    const healthyNonEmpty = { total: 92, realCovered: 72, compatFailCount: 0 };
    const d5 = decideCheckExitCode(healthyNonEmpty);
    ok('Case F [R5-4 control]: total=92 healthy → zeroTriggersParsed=false, exit 0', d5.code === 0 && d5.zeroTriggersParsed === false, JSON.stringify(d5));
  }

  console.log(`trigger-compat-replay-selftest: ${pass}/${pass + fail}`);
  for (const f of fails) console.log('  ✖ ' + f);
  return fail === 0 ? 0 : 1;
}

module.exports = { run };
if (require.main === module) process.exit(run());
