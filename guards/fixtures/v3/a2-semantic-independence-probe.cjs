#!/usr/bin/env node
// a2-semantic-independence-probe.cjs — Opus O-1 fix requirement 3 (2026-09-15 round 2,
// guards/audits/OPUS-2026-09-15-repair-review.md "O-1"): proves --verify's A2 has a check that is
// GENUINELY independent of buildEditOps — not just independent of plan.edits' own offset numbers
// (rebuildIndependentEdits already gave A2 that in the B-1' round), but independent of buildEditOps
// the FUNCTION itself, so a latent bug living INSIDE its byte-offset arithmetic cannot hide behind the
// fact that both "what got written" and "what A2 recomputes" go through the very same buggy code.
//
// Method (mirrors the HIGH-4b require.cache-replacement gold standard cited in the audit): build a
// temp copy of the guards directory whose pmm-migrate-v3.cjs has ONE deliberate bug injected into
// buildEditOps's kind-①insert-identity branch — insert the identity tag at the raw LINE START instead
// of right after the title's closing `**` (this corrupts the title-line grammar entirely: the tag ends
// up glued onto the front of `**2026-...`, so TITLE_RE no longer matches that line as a title at all).
// Use THIS BROKEN COPY to both (a) construct the after-dir's bytes (simulating what --apply would have
// written had buildEditOps had this bug) and (b) run --verify (so its own rebuildIndependentEdits also
// goes through the SAME broken buildEditOps) — byte-replay is then tautologically self-consistent and
// MUST pass; only the semantic check (core.parseFile()-based, no buildEditOps call) can catch it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REAL_GUARDS = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const FIX = REAL_GUARDS + '/fixtures/v3/migrate-selftest';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'a2sem-')).replace(/\\/g, '/');

// 1. temp guards dir: copy the files pmm-verify-assertions.cjs/pmm-migrate-v3.cjs/pmm-core.cjs need,
//    with the bug injected into pmm-migrate-v3.cjs's kind-①/⑬ insertion point.
const TG = T + '/guards';
fs.mkdirSync(TG, { recursive: true });
for (const f of ['pmm-core.cjs', 'pmm-trigger-recall.cjs', 'pmm-trigger-glob.cjs', 'pmm-verify-assertions.cjs']) {
  fs.copyFileSync(REAL_GUARDS + '/' + f, TG + '/' + f);
}
let migrateSrc = fs.readFileSync(REAL_GUARDS + '/pmm-migrate-v3.cjs', 'utf8');
const NEEDLE = "if (a.kind === '①insert-identity') {\n      const buf = byFileBuf[a.file]; if (!buf) continue;";
if (migrateSrc.indexOf(NEEDLE) === -1) { console.error('FIXTURE STALE: kind ① branch text not found verbatim in pmm-migrate-v3.cjs — update NEEDLE'); process.exit(1); }
const BROKEN = NEEDLE + "\n      { const _insertByteOffset = a.byteOffset; push(a.file, _insertByteOffset, 0, ` [${a.newId}]`, a, a.titleLineNo, buf); continue; } // INJECTED BUG (a2-semantic-independence-probe): insert at raw line start, not after **";
migrateSrc = migrateSrc.replace(NEEDLE, BROKEN);
fs.writeFileSync(TG + '/pmm-migrate-v3.cjs', migrateSrc);

// 2. build BEFORE dir + a pin-consuming plan using the BROKEN module (so the after-dir this produces
//    and the plan's own edits[] are self-consistent with the injected bug from the start).
const core = require(TG + '/pmm-core.cjs');
const migrate = require(TG + '/pmm-migrate-v3.cjs');
const BEFORE = T + '/before';
const AFTER = T + '/after';
fs.mkdirSync(BEFORE, { recursive: true });
fs.mkdirSync(AFTER, { recursive: true });
for (const f of fs.readdirSync(FIX + '/memory')) {
  fs.copyFileSync(FIX + '/memory/' + f, BEFORE + '/' + f);
  fs.copyFileSync(FIX + '/memory/' + f, AFTER + '/' + f);
}
function loadSnap(dir) {
  const snap = core.snapshotDir(dir);
  const bannerRaw = fs.readFileSync(dir + '/banner.md');
  const { buf, hadBOM } = core.stripBOM(bannerRaw);
  snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
  return snap;
}
const snap = loadSnap(BEFORE);
const d1 = migrate.parseD1Naming(fs.readFileSync(FIX + '/D1-NAMING.md', 'utf8'));
const pinPlan = migrate.computePlan(snap, d1, {});
const pinEntries = migrate.buildD1PinEntries(pinPlan, snap);
if (pinEntries.some((e) => e.ambiguous)) { console.error('AMBIGUOUS at pin time'); process.exit(1); }
const pin = { schemaVersion: 1, generatedAt: new Date().toISOString(), treeOid: 'hermetic', sourceD1: FIX + '/D1-NAMING.md', entries: pinEntries };
const d1Stub = { list24: [], sameFileDup: [], crossFileDup: [] };
const { plan, edits, contentFingerprint, contentFingerprintAfter } = migrate.buildFullPlan(snap, d1Stub, { pin });
if (plan.unmatchedD1.length || plan.ambiguousCount > 0 || plan.staleCount > 0) { console.error('plan not clean'); process.exit(1); }
if (!plan.actions.some((a) => a.kind === '①insert-identity')) { console.error('fixture has no ①insert-identity action — nothing to corrupt'); process.exit(1); }

// 3. write the after-dir using the BROKEN applyEditsToDir (so the bug's effect is really on disk).
migrate.applyEditsToDir(AFTER, snap, edits);
const planApplied = {
  schemaVersion: 3, appliedAt: new Date().toISOString(), sourcePlan: 'inline', treeOid: null,
  contentFingerprint, contentFingerprintAfter, groups: plan.groups, actions: plan.actions, edits,
  oversizedIndexRows: plan.oversizedIndexRows, unmatchedD1: plan.unmatchedD1, d1Path: 'inline',
};
fs.writeFileSync(AFTER + '/PLAN-applied.json', JSON.stringify(planApplied, null, 2));

// 4. run --verify using the SAME broken copy (so rebuildIndependentEdits' buildEditOps call shares the
//    bug with whatever wrote the bytes above) and check A2's status/detail.
let out = '', rc = 0;
try {
  out = execFileSync(process.execPath, [TG + '/pmm-migrate-v3.cjs', '--verify', '--stage', 'c0', '--before', BEFORE, '--after', AFTER], { encoding: 'utf8' });
} catch (e) { rc = e.status === undefined ? -1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }

const a2Line = (out.split('\n').find((l) => / A2 /.test(l)) || '(no A2 line found)');
console.log('verify rc=' + rc);
console.log(a2Line);

const byteReplayLooksClean = / A2 / .test(a2Line) && !/字节重放不一致/.test(a2Line);
const semanticCaughtIt = /语义核验.*不一致/.test(a2Line) || /找不到按标题配对的条目/.test(a2Line);
fs.rmSync(T, { recursive: true, force: true });

if (byteReplayLooksClean && semanticCaughtIt) {
  console.log('PASS: byte-replay stayed tautologically clean (shared the injected buildEditOps bug) while the buildEditOps-independent semantic check caught it.');
  process.exit(0);
}
console.log('FAIL: expected byte-replay clean + semantic check catching the injected buildEditOps bug; did not see that shape.');
process.exit(1);
