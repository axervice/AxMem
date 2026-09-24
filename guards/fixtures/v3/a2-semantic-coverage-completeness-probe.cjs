#!/usr/bin/env node
// a2-semantic-coverage-completeness-probe.cjs — round-3 R-2 break-test (2026-09-15,
// guards/audits/OPUS-2026-09-15-round2-review.md "R-2" requirement 3): "加一条覆盖率断言:产编辑的
// kind 集合必须从单一真相源枚举,任何一种没有语义分支即自测失败". Two halves:
//   (A) POSITIVE: every kind in the real PRODUCING_KINDS (pmm-migrate-v3.cjs's KIND_ORDER, the single
//       source of truth) must have a real branch in checkA2Semantic — calling it with one synthetic
//       action of each kind must never produce a "coverage gap" failure (it may produce OTHER,
//       legitimate failures from the synthetic action's minimal/empty data — that's fine and expected;
//       only the coverage-gap message specifically must never appear).
//   (B) NEGATIVE (the "synthetic-must-fail" arm — C1 硬前置 item 8's philosophy applied here): a kind
//       that IS in PRODUCING_KINDS but has NO branch in checkA2Semantic must produce a coverage-gap
//       failure. Proven by injecting a fake extra kind into a temp copy of KIND_ORDER (so it becomes
//       part of PRODUCING_KINDS) without adding a matching branch to checkA2Semantic — if the catch-all
//       were dead code (e.g. mistyped, or short-circuited), this half would silently pass and the
//       positive half alone would prove nothing about whether the completeness check actually works.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_GUARDS = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const core = require(REAL_GUARDS + '/pmm-core.cjs');
const migrate = require(REAL_GUARDS + '/pmm-migrate-v3.cjs');
const { checkA2Semantic } = require(REAL_GUARDS + '/pmm-verify-assertions.cjs');

const emptyParsed = { entries: [] };
const synthByKind = {
  '①insert-identity': { kind: '①insert-identity', file: 'decisions.md', titleLineNo: 1, newId: 'x:y' },
  '②user-no-colon': { kind: '②user-no-colon', file: 'decisions.md', titleLineNo: 1 },
  '③rename-same-file-dup': { kind: '③rename-same-file-dup', matched: true, file: 'decisions.md', renameTitleLineNo: 1, newId: 'x:y' },
  '④cross-file-decided': { kind: '④cross-file-decided', decisionsTitleLineNo: 1, newId: 'x:y', tag: 'x:z' },
  '⑤hook-from-index-rest': { kind: '⑤hook-from-index-rest', file: 'decisions.md', titleLineNo: 1, hookText: 'h' },
  '⑦add-supersedes-to-target': { kind: '⑦add-supersedes-to-target', newSupersededBy: 'x:z', sourceTag: 'x:y' },
  '⑬add-trust-flag': { kind: '⑬add-trust-flag', file: 'decisions.md', titleLineNo: 1 },
};

// (A) positive: every REAL producing kind must be covered.
const gapRe = /coverage gap|覆盖率缺口/;
const missing = [];
for (const k of migrate.PRODUCING_KINDS) {
  const synth = synthByKind[k];
  if (!synth) { console.error('FIXTURE STALE: no synthetic action authored for kind ' + k + ' — update synthByKind'); process.exit(1); }
  const fails = checkA2Semantic(core, { actions: [synth] }, emptyParsed, emptyParsed);
  if (fails.some((f) => gapRe.test(f))) missing.push(k);
}
if (missing.length) {
  console.error('(A) FAIL: checkA2Semantic has a coverage gap for real producing kind(s): ' + missing.join(', '));
  process.exit(1);
}
console.log('(A) PASS: all ' + migrate.PRODUCING_KINDS.length + ' real producing kinds (' + migrate.PRODUCING_KINDS.join(',') + ') have a checkA2Semantic branch.');

// non-producing kinds (⑥⑧⑨⑩⑪⑫, C0 informational-only) must NOT be flagged as gaps — they are
// correctly out of PRODUCING_KINDS' scope, not a missing branch.
const outOfScope = checkA2Semantic(core, { actions: [{ kind: '⑥normalize-supersedes-brackets' }] }, emptyParsed, emptyParsed);
if (outOfScope.some((f) => gapRe.test(f))) {
  console.error('(A) FAIL: a non-producing kind (⑥, correctly out of PRODUCING_KINDS scope) was wrongly flagged as a coverage gap.');
  process.exit(1);
}

// (B) negative / synthetic-must-fail: inject a FAKE extra kind into a temp copy of KIND_ORDER (hence
// PRODUCING_KINDS) with no matching checkA2Semantic branch, and confirm the catch-all actually fires.
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'a2covgap-')).replace(/\\/g, '/');
const TG = T + '/guards';
fs.mkdirSync(TG, { recursive: true });
for (const f of ['pmm-core.cjs', 'pmm-trigger-recall.cjs', 'pmm-trigger-glob.cjs', 'pmm-verify-assertions.cjs']) {
  fs.copyFileSync(REAL_GUARDS + '/' + f, TG + '/' + f);
}
let migrateSrc = fs.readFileSync(REAL_GUARDS + '/pmm-migrate-v3.cjs', 'utf8');
const NEEDLE = "'⑬add-trust-flag': 7,\n});";
if (migrateSrc.indexOf(NEEDLE) === -1) { console.error('FIXTURE STALE: KIND_ORDER closing brace text not found verbatim — update NEEDLE'); process.exit(1); }
migrateSrc = migrateSrc.replace(NEEDLE, "'⑬add-trust-flag': 7,\n  'ⓧfake-injected-kind-no-branch': 8, // INJECTED (a2-semantic-coverage-completeness-probe, negative arm)\n});");
fs.writeFileSync(TG + '/pmm-migrate-v3.cjs', migrateSrc);

const tgMigrate = require(TG + '/pmm-migrate-v3.cjs');
const tgVerify = require(TG + '/pmm-verify-assertions.cjs');
if (!tgMigrate.PRODUCING_KINDS.includes('ⓧfake-injected-kind-no-branch')) {
  console.error('(B) setup FAIL: injected fake kind did not make it into the temp copy\'s PRODUCING_KINDS');
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(1);
}
const fakeFails = tgVerify.checkA2Semantic(core, { actions: [{ kind: 'ⓧfake-injected-kind-no-branch', file: 'decisions.md', titleLineNo: 1 }] }, emptyParsed, emptyParsed);
fs.rmSync(T, { recursive: true, force: true });
if (!fakeFails.some((f) => gapRe.test(f))) {
  console.error('(B) FAIL: a kind present in PRODUCING_KINDS but absent from checkA2Semantic\'s branches was NOT flagged as a coverage gap — the completeness catch-all is dead code. Got: ' + JSON.stringify(fakeFails));
  process.exit(1);
}
console.log('(B) PASS: a kind injected into PRODUCING_KINDS with no matching branch WAS correctly flagged as a coverage gap — the catch-all has teeth.');
process.exit(0);
