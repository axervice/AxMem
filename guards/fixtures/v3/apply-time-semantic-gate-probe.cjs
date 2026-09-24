#!/usr/bin/env node
// apply-time-semantic-gate-probe.cjs — round-3 R-2 break-test (2026-09-15,
// guards/audits/OPUS-2026-09-15-round2-review.md "R-2"): proves the NEW pre-write semantic gate in
// pmm-migrate-v3.cjs's cmdApply (added round-3) actually intercepts a buildEditOps bug BEFORE any
// bytes reach disk — for BOTH the kind that had zero semantic coverage before this fix
// (②user-no-colon) and a kind that was already covered (①insert-identity, the control) — per the
// repair brief's explicit requirement: "分别往 ② 和另一个已覆盖 kind 注入错误值,两者都必须在 apply
// 阶段被拦下".
//
// Method (mirrors a2-semantic-independence-probe.cjs's temp-copy-with-injected-bug technique, but
// drives `--apply` end-to-end instead of hand-constructing an after-dir and running `--verify`): build
// a temp copy of the guards directory whose pmm-migrate-v3.cjs has ONE deliberate bug injected into
// buildEditOps, use THAT broken copy to build a self-consistent plan (so plan.edits/
// contentFingerprintAfter already reflect the injected bug — exactly what a real corrupted-upstream
// plan would look like), then invoke the BROKEN copy's own `--apply --dir <copy> --plan <plan>` as a
// real child process and confirm: (a) it exits non-zero, (b) the rejection message names the pre-write
// semantic gate (not some unrelated check), and (c) zero bytes were written to --dir.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REAL_GUARDS = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const FIX = REAL_GUARDS + '/fixtures/v3/migrate-selftest';

function buildBrokenCopy(kind) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'applysem-' + kind + '-')).replace(/\\/g, '/');
  const TG = T + '/guards';
  fs.mkdirSync(TG, { recursive: true });
  for (const f of ['pmm-core.cjs', 'pmm-trigger-recall.cjs', 'pmm-trigger-glob.cjs', 'pmm-verify-assertions.cjs']) {
    fs.copyFileSync(REAL_GUARDS + '/' + f, TG + '/' + f);
  }
  let migrateSrc = fs.readFileSync(REAL_GUARDS + '/pmm-migrate-v3.cjs', 'utf8');
  if (kind === '②') {
    // ②user-no-colon: buildEditOps writes the replacement text via the shared USER_RATIFIED_BRACKET
    // constant (R7-5 fix, 2026-09-15 round 7, guards/audits/OPUS-2026-09-15-round6-review.md LOW-2 —
    // extracted so pmm-verify-assertions.cjs's checkA2Semantic references the SAME literal rather than
    // a hand-typed copy, closing the "both sides independently drift onto the same new wrong value"
    // risk). Deliberately inject the bug at the CALL SITE (bypassing the constant with a hardcoded
    // wrong literal), NOT by corrupting the constant's own definition — corrupting the shared constant
    // would ALSO corrupt checkA2Semantic's expectation (it imports the SAME constant from this SAME
    // file), making the check tautological for that one specific shape; this probe exists to prove
    // independence for the REALISTIC bug shape (a maintainer editing this one branch and typing a
    // literal instead of using the constant — exactly how R5-3's real historical ④ bug looked), which a
    // shared constant does not and cannot protect against by construction. That narrower blind spot
    // (the constant's own definition being corrupted) is a known, accepted, documented tradeoff of the
    // R7-5 fix — see its comment in pmm-migrate-v3.cjs — not a regression this probe claims to close.
    const NEEDLE = "push(a.file, byteOff, Buffer.byteLength('[user]', 'utf8'), USER_RATIFIED_BRACKET, a, a.titleLineNo, buf);";
    if (migrateSrc.indexOf(NEEDLE) === -1) { console.error('FIXTURE STALE: ②user-no-colon push() call text not found verbatim — update NEEDLE'); process.exit(1); }
    migrateSrc = migrateSrc.replace(NEEDLE, "push(a.file, byteOff, Buffer.byteLength('[user]', 'utf8'), '[user:INJECTED-WRONG-VALUE]', a, a.titleLineNo, buf); // INJECTED BUG (apply-time-semantic-gate-probe, kind ②)");
  } else if (kind === '①') {
    // ①insert-identity (control, already covered by checkA2Semantic before this fix): reuse the exact
    // injection a2-semantic-independence-probe.cjs uses — insert the identity tag at the raw LINE START
    // instead of right after the title's closing `**`, which corrupts the title-line grammar entirely.
    const NEEDLE = "if (a.kind === '①insert-identity') {\n      const buf = byFileBuf[a.file]; if (!buf) continue;";
    if (migrateSrc.indexOf(NEEDLE) === -1) { console.error('FIXTURE STALE: kind ① branch text not found verbatim — update NEEDLE'); process.exit(1); }
    migrateSrc = migrateSrc.replace(NEEDLE, NEEDLE + "\n      { const _insertByteOffset = a.byteOffset; push(a.file, _insertByteOffset, 0, ` [${a.newId}]`, a, a.titleLineNo, buf); continue; } // INJECTED BUG (apply-time-semantic-gate-probe, kind ①, control)");
  } else if (kind === '④') {
    // R5-3 fix (2026-09-15 round 5, guards/audits/CODEX-2026-09-15-cumulative-review.md HIGH-3 /
    // FABLE-2026-09-15-codex-cumulative-triage.md R5-3): the confirmed repro — buildEditOps still
    // renames the id correctly (`[${a.tag}]` → `[${a.newId}]`), but the mutual-link line it inserts
    // right after the title carries WRONG PROSE instead of "规则版 → " — `[[${a.tag}]]` is still
    // present in the body (checkA2Semantic's OLD `linkRe.test(after.body)` only checked existence
    // anywhere in the body text), but the line does not read what the action promised. buildEditOps
    // now builds this prose from the shared CROSS_FILE_LINK_PREFIX constant (R7-5 fix, same rationale
    // and same "inject at the call site, not the constant" caveat as kind ② above) — corrupt ONLY the
    // second push() call's insertText (the mutual-link line) by bypassing the constant with a hardcoded
    // literal, leaving the id-rename push() untouched — exactly the audit's original construction,
    // retargeted at the new call-site shape.
    const NEEDLE = "push('decisions.md', afterTitle, 0, `${CROSS_FILE_LINK_PREFIX}[[${a.tag}]]\\n`, a, a.decisionsTitleLineNo, buf);";
    if (migrateSrc.indexOf(NEEDLE) === -1) { console.error('FIXTURE STALE: kind ④ mutual-link push() call text not found verbatim — update NEEDLE'); process.exit(1); }
    migrateSrc = migrateSrc.replace(NEEDLE, "push('decisions.md', afterTitle, 0, `WRONG PROSE [[${a.tag}]]\\n`, a, a.decisionsTitleLineNo, buf); // INJECTED BUG (apply-time-semantic-gate-probe, kind ④)");
  } else {
    throw new Error('unknown kind: ' + kind);
  }
  fs.writeFileSync(TG + '/pmm-migrate-v3.cjs', migrateSrc);
  return { T, TG };
}

function loadSnap(core, dir) {
  const snap = core.snapshotDir(dir);
  const bannerRaw = fs.readFileSync(dir + '/banner.md');
  const { buf, hadBOM } = core.stripBOM(bannerRaw);
  snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
  return snap;
}

function runOne(kind) {
  const { T, TG } = buildBrokenCopy(kind);
  const core = require(TG + '/pmm-core.cjs');
  const migrate = require(TG + '/pmm-migrate-v3.cjs');
  const BEFORE = T + '/before';
  const DIR = T + '/applydir';
  fs.mkdirSync(BEFORE, { recursive: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of fs.readdirSync(FIX + '/memory')) {
    fs.copyFileSync(FIX + '/memory/' + f, BEFORE + '/' + f);
    fs.copyFileSync(FIX + '/memory/' + f, DIR + '/' + f);
  }
  const snap = loadSnap(core, BEFORE);
  const d1 = migrate.parseD1Naming(fs.readFileSync(FIX + '/D1-NAMING.md', 'utf8'));
  const pinPlan = migrate.computePlan(snap, d1, {});
  const pinEntries = migrate.buildD1PinEntries(pinPlan, snap);
  if (pinEntries.some((e) => e.ambiguous)) { console.error('[' + kind + '] AMBIGUOUS at pin time'); process.exit(1); }
  const pin = { schemaVersion: 1, generatedAt: new Date().toISOString(), treeOid: 'hermetic', sourceD1: FIX + '/D1-NAMING.md', entries: pinEntries };
  const d1Stub = { list24: [], sameFileDup: [], crossFileDup: [] };
  // Build the plan using the BROKEN buildEditOps (via buildFullPlan) so plan.edits/
  // contentFingerprintAfter are self-consistent with the injected bug from the start — exactly what a
  // real corrupted-upstream --plan run would hand to --apply.
  const { plan, edits, contentFingerprint, contentFingerprintAfter } = migrate.buildFullPlan(snap, d1Stub, { pin });
  if (plan.unmatchedD1.length || plan.ambiguousCount > 0 || plan.staleCount > 0) { console.error('[' + kind + '] plan not clean'); process.exit(1); }
  const wantKindFull = kind === '②' ? '②user-no-colon' : (kind === '④' ? '④cross-file-decided' : '①insert-identity');
  if (!plan.actions.some((a) => a.kind === wantKindFull)) { console.error('[' + kind + '] fixture has no ' + wantKindFull + ' action — nothing to corrupt'); process.exit(1); }
  const planPath = T + '/plan.json';
  fs.writeFileSync(planPath, JSON.stringify({
    schemaVersion: 3, generatedAt: new Date().toISOString(), treeOid: null,
    contentFingerprint, contentFingerprintAfter, d1Path: 'inline',
    groups: plan.groups, actions: plan.actions, edits,
    unmatchedD1: plan.unmatchedD1, oversizedIndexRows: plan.oversizedIndexRows,
    ambiguousCount: plan.ambiguousCount, staleCount: plan.staleCount,
  }, null, 2));

  // Snapshot --dir's bytes BEFORE invoking --apply so we can prove zero bytes changed.
  const beforeBytes = {};
  for (const f of fs.readdirSync(DIR)) beforeBytes[f] = fs.readFileSync(path.join(DIR, f));

  let out = '', rc = 0;
  try {
    out = execFileSync(process.execPath, [TG + '/pmm-migrate-v3.cjs', '--apply', '--dir', DIR, '--plan', planPath], { encoding: 'utf8' });
  } catch (e) { rc = e.status === undefined ? -1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }

  let anyChanged = false;
  for (const f of Object.keys(beforeBytes)) {
    if (!fs.existsSync(path.join(DIR, f)) || !fs.readFileSync(path.join(DIR, f)).equals(beforeBytes[f])) anyChanged = true;
  }
  fs.rmSync(T, { recursive: true, force: true });

  const gateHit = /写入前语义核验/.test(out);
  const rejected = rc !== 0;
  console.log('[' + kind + '] apply rc=' + rc + ' gate-message-present=' + gateHit + ' any-bytes-changed=' + anyChanged);
  if (rejected && gateHit && !anyChanged) {
    console.log('[' + kind + '] PASS: pre-write semantic gate caught the injected buildEditOps bug for ' + wantKindFull + ' — --apply rejected before writing.');
    return true;
  }
  console.log('[' + kind + '] FAIL: expected --apply to reject via the pre-write semantic gate with zero bytes written; output was:\n' + out.slice(0, 2000));
  return false;
}

let allOk = true;
for (const kind of ['②', '①', '④']) {
  if (!runOne(kind)) allOk = false;
}
process.exit(allOk ? 0 : 1);
