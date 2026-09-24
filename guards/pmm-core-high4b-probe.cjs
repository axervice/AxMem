#!/usr/bin/env node
// pmm-core-high4b-probe.cjs — HIGH-4b black-box integration probe (2026-09-15; updated round 5,
// guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-5 leaf-module extraction).
// guards/audits/FABLE-2026-09-15-glob-review-triage.md finding 4b / CODEX-2026-09-15-glob-spec-
// review.md finding 4: an anti-drift assertion that just calls compileTriggerPath/checkTriggerPathB5
// directly only proves the SHARED FUNCTION works — it can never prove a CONSUMER (pmm-core.cjs's B5
// diagnostic pipeline) actually calls through it instead of a silently-reforked local judgment that
// currently happens to behave the same. The only way to prove real delegation is to swap the shared
// module's implementation and watch the consumer's own output change in lockstep.
//
// Round-5 update: checkTriggerPathB5 moved out of pmm-trigger-recall.cjs into the leaf module
// pmm-trigger-glob.cjs (R5-7 fix, guards/audits/FABLE-2026-09-15-codex-cumulative-triage.md) so that
// pmm-trigger-recall.cjs could itself require pmm-core.cjs (for classifyTriggerLine/FENCE_RE) without
// a require() cycle. pmm-core.cjs's own checkTriggerPathB5 import now comes from pmm-trigger-glob.cjs
// — this probe patches THAT module's cached export now, not pmm-trigger-recall.cjs's.
//
// Run in TWO SEPARATE fresh processes (`--fake` / `--real`) — this require.cache surgery must NEVER
// leak into the main self-test process or any other module load in this run:
//   --fake  Before pmm-core.cjs is ever required, replace pmm-trigger-glob.cjs's cached
//           checkTriggerPathB5 export with a wrapper that forces one specific B5 rejection for ONE
//           canary pattern (everything else delegates to the real function). Requiring pmm-core.cjs
//           AFTER that swap means its own top-level `const { checkTriggerPathB5 } =
//           require('./pmm-trigger-glob.cjs')` captures the FAKE binding, not the real one — so if
//           pmm-core.cjs's parseFile() B5 diagnostic for the canary pattern reflects the fake's
//           forced reason, that is direct proof the real code path truly flows through this shared
//           export, not a local duplicate.
//   --real  Same fixture, unpatched module, as a control: the canary pattern must be legal (no B5)
//           under the real implementation — proving --fake's rejection was genuinely caused by the
//           swap, not a coincidental pre-existing B5 hit on that pattern.
// If pmm-core.cjs's gate ever stops truly delegating, --fake will fail to observe the forced reason
// (prints FAKE-FAIL) even though every other self-test (which only exercises the real function
// directly) stays green — that is exactly the blind spot this probe exists to close.
'use strict';
const path = require('path');

const mode = process.argv[2];
if (mode !== '--fake' && mode !== '--real') {
  console.error('usage: pmm-core-high4b-probe.cjs --fake|--real');
  process.exit(2);
}

const triggerPath = path.resolve(__dirname, 'pmm-trigger-glob.cjs');
const corePath = path.resolve(__dirname, 'pmm-core.cjs');
const CANARY_PATTERN = 'zzzh4bcanary/legal-real-pattern*';
const FAKE_REASON = 'HIGH4B-CANARY-FORCED-REJECT';

if (mode === '--fake') {
  const real = require(triggerPath); // populates require.cache[triggerPath] with the real exports
  const realCheck = real.checkTriggerPathB5;
  require.cache[triggerPath].exports = Object.assign({}, real, {
    checkTriggerPathB5(pattern) {
      if (pattern === CANARY_PATTERN) return { ok: false, reason: FAKE_REASON };
      return realCheck(pattern);
    },
  });
}

const core = require(corePath); // in --fake mode: core.cjs's own require() now resolves to the swap
const buf = Buffer.from(
  '**2026-01-01 — h4b probe entry** [test:h4b-probe]\n' +
  '<!-- trigger: tool=Edit; repo=home; path=' + CANARY_PATTERN + ' -->\n' +
  'body\n', 'utf8');
const r = core.parseFile('lessons.md', buf);
const b5 = r.diagnostics.find((d) => d.code === 'B5' && d.tag === 'test:h4b-probe');

if (mode === '--fake') {
  if (b5 && b5.reason === FAKE_REASON) {
    console.log('FAKE-OK: pmm-core.cjs B5 diagnostic reflected the swapped checkTriggerPathB5 — real delegation confirmed');
    process.exit(0);
  }
  console.error('FAKE-FAIL: pmm-core.cjs did NOT reflect the swapped implementation — diagnostics=' + JSON.stringify(r.diagnostics));
  process.exit(1);
} else {
  if (!b5) {
    console.log('REAL-OK: canary pattern is legal under the real (unpatched) implementation (control)');
    process.exit(0);
  }
  console.error('REAL-FAIL: canary pattern unexpectedly flagged B5 under the REAL implementation — diagnostics=' + JSON.stringify(r.diagnostics));
  process.exit(1);
}
