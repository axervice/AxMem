#!/usr/bin/env bash
# pmm-migrate-v3.sh — self-test wrapper for pmm-migrate-v3.cjs (PMM v3, C0 build, shadow only).
# Usage: pmm-migrate-v3.sh --self-test
#   Hermetic: uses guards/fixtures/v3/migrate-selftest/ only, never touches ~/.claude/memory.
#   1. plan (computePlan, same code --plan uses) → apply --dir <copy> → verify --stage c0: all green.
#   2. idempotent second --apply on the same dir: zero further diff.
#   3. one "break it → red" fixture per assertion in {A1,A2,A3,A5,A6,A7,A8,A9,A12,A15,A16,A17}
#      (A1/A2/A5/A7/A12/A15 are the FINAL-SPEC-mandated minimum; the rest are extra coverage).
#   4. B-1′ hardening break-tests (2026-09-15, guards/audits/FABLE-2026-09-15-b1prime-confirmed.md):
#      B1P (whole-snapshot post-write fingerprint must reject a shifted-offset plan and leave --dir
#      byte-identical to before), B1P2 (offset↔titleLineNo binding must reject it EVEN when the
#      declared contentFingerprintAfter is doctored to match the bad write — isolates this check from
#      B1P's), OVERLAP (applyEditsToBuffer must refuse overlapping edit ranges), A2IND (--verify's A2
#      must independently re-derive edits from actions+before bytes, not replay plan.edits itself).
#   5. round-2 hardening (2026-09-15, guards/audits/OPUS-2026-09-15-repair-review.md, Opus NO-GO on
#      the B-1′ fix — the published repro was closed but the DEFECT CLASS was not): B1P3 (THE blind-
#      spot intersection O-1 named — an offset shift that stays INSIDE its anchor line's own byte range
#      AND a correctly-recomputed contentFingerprintAfter, which both B1P and B1P2 individually miss —
#      --apply must now reject via an offset recompute that is independent of plan.edits[].offset
#      itself), HALFWRITE (a write-time exception mid-`applyEditsToDir` — e.g. a read-only file — must
#      roll every already-written file back to its pre-write bytes, verified by fingerprint, never
#      leaving half-migrated corpus on disk), A2SEM (--verify's A2 must ALSO have a check that is
#      independent of buildEditOps the FUNCTION, not just of plan.edits' own numbers — proven by
#      injecting a bug into a temp copy of buildEditOps and confirming only the semantic check catches
#      it), SAMEOFF (regression-lock: two different actions legitimately inserting at the exact same
#      offset — 5 real occurrences in the C1 plan — must NOT be rejected).
#   6. round-4 hardening (2026-09-15, guards/audits/FABLE-2026-09-15-rollback-verify-false-alarm.md):
#      RBFP-OK/RBFP-CORRUPT — the O-3 rollback re-verification fingerprint used a DIFFERENT snapshot
#      construction than the before-write fingerprint (missing banner.md's manual splice), making them
#      mathematically unequal regardless of whether the rollback actually succeeded — HALFWRITE above
#      never caught this because it only greps for the substring "回滚", present in both the correct
#      and the (bug-era) always-wrong wording. RBFP-OK proves a genuine rollback success is now
#      reported as trusted; RBFP-CORRUPT proves a genuinely-corrupted rollback (restoreFiles writes
#      wrong bytes but reports ok:true) is still reported as untrusted — two-sided, so a "fix" that
#      just always trusts the rollback (worse than the original bug) cannot silently pass.
#   7. round-7 hardening (2026-09-15, guards/audits/OPUS-2026-09-15-round6-review.md HIGH-1, "R7-1"):
#      IDEMFP-V2 — the idempotency short-circuit's corroboration loop only ever proved a NEGATIVE
#      ("old bytes gone"), which is vacuously true for every deleteLen=0 pure insertion; setting
#      contentFingerprintAfter to the UNMIGRATED dir's own real fingerprint (≠contentFingerprint, so
#      IDEMFP-STRUCT's self-consistency check doesn't fire) and compressing every deleteLen>0 edit into
#      a pure insertion silenced that loop entirely and reported success on a byte-for-byte unmigrated
#      corpus. Fixed by findEditsNotReflectedInSnap: a POSITIVE requirement that every edit's insertText
#      actually be found at its (purely-arithmetically-predicted) after-position in --dir's current
#      bytes. A5DEPFAIL-EXEC extends round-5's A5DEPFAIL to the "dependency present but throws" branch
#      (only "dependency file missing" had a break-test before).
#   8. round-8 hardening (2026-09-15, guards/audits/OPUS-2026-09-15-round8-review.md HIGH-1 — the SAME
#      defect surviving a THIRD repair round): round 7's IDEMFP-V2 flattened deleteLen>0 edits to pure
#      inserts but left insertText untouched, so findEditsNotReflectedInSnap (added that same round)
#      still fired for all 291 edits against a genuinely-unmigrated dir — IDEMFP-V2 does NOT reach rc=0.
#      The actual round-8 bypass needs insertText ALSO emptied on every edit, so BOTH per-edit checks go
#      silent simultaneously. IDEMFP-V5/V6/V7 are three field-shapes that all collapse to that identical
#      "neither side ever fires" condition (missing keys / explicit null / empty-array type confusion) —
#      closed by one explicit `uncoveredEdits` invariant in cmdApply, not a shape-specific patch. IDEMFP-V8
#      is orthogonal: exactly ONE edit downgraded inside an otherwise fully genuine plan+already-migrated-
#      dir pairing, proving the invariant is a per-edit filter, not an aggregate check a single corrupted
#      record could hide inside 290 good ones.
set -u
G="$(cygpath -m "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
FIX="$G/fixtures/v3/migrate-selftest"

if [ "${1:-}" != "--self-test" ]; then
  exec node "$G/pmm-migrate-v3.cjs" "$@"
fi

_T_RAW="$(mktemp -d)"
case "$_T_RAW" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) echo "mktemp 异常路径 $_T_RAW,拒绝继续"; exit 1;; esac
# node.exe is a native Windows binary — a bare POSIX path like /tmp/xxx embedded INSIDE a larger
# `node -e "..."` string does NOT get MSYS's argv path translation (that only fires for argv
# elements that themselves start with /<driveletter>/), so node resolves it as "current-drive-root"
# (C:\tmp\xxx) instead of the real mktemp location — silent ENOENT. cygpath -m gives the one path
# form (C:/Users/.../Temp/xxx) that both bash and node.exe agree on; use it everywhere below.
T="$(cygpath -m "$_T_RAW")"
ok=0; total=0
check() { total=$((total+1)); if [ "$1" -eq 0 ]; then ok=$((ok+1)); else echo "  ✖ 失败: $2"; fi; }

BEFORE="$T/before"; AFTER="$T/after"
mkdir -p "$BEFORE" "$AFTER"
cp "$FIX/memory/"* "$BEFORE/"
cp -r "$BEFORE/." "$AFTER/"

# 1a-i. pin (buildD1PinEntries over a fuzzy-matched computePlan — the ONLY place bestMatch runs,
#       exactly like --pin-d1; done inline so this never writes into the real guards/specs/).
PIN_JSON="$T/d1-pinned.json"
node -e "
const core = require('$G/pmm-core.cjs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const fs = require('fs');
const dir = '$BEFORE';
const snap = core.snapshotDir(dir);
const bannerRaw = fs.readFileSync(dir + '/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const d1 = migrate.parseD1Naming(fs.readFileSync('$FIX/D1-NAMING.md', 'utf8'));
const plan = migrate.computePlan(snap, d1, {});
const entries = migrate.buildD1PinEntries(plan, snap);
fs.writeFileSync('$PIN_JSON', JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), treeOid: 'hermetic-selftest', sourceD1: '$FIX/D1-NAMING.md', entries }, null, 2));
if (entries.some(e => e.ambiguous)) { console.error('AMBIGUOUS at pin time', JSON.stringify(entries.filter(e=>e.ambiguous))); process.exit(1); }
" >/dev/null 2>"$T/pin.err"
check $? "pin 阶段(buildD1PinEntries,唯一跑模糊匹配之处)零 AMBIGUOUS,$(cat "$T/pin.err" 2>/dev/null | head -1)"

# 1a-ii. plan — consumes the pinned file only (Opus coordinator follow-up: --plan never runs bestMatch;
#        computePlan(snap, d1Stub, {pin}) verifies each ①③④⑬ pin's titleLineSha256 against $BEFORE).
PLAN_JSON="$T/plan.json"
node -e "
const core = require('$G/pmm-core.cjs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const fs = require('fs');
const dir = '$BEFORE';
const snap = core.snapshotDir(dir);
const bannerRaw = fs.readFileSync(dir + '/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const pin = JSON.parse(fs.readFileSync('$PIN_JSON', 'utf8'));
const d1Stub = { list24: [], sameFileDup: [], crossFileDup: [] };
const { plan, edits, contentFingerprint, contentFingerprintAfter } = migrate.buildFullPlan(snap, d1Stub, { pin });
const out = {
  schemaVersion: 3, generatedAt: new Date().toISOString(), treeOid: null,
  contentFingerprint, contentFingerprintAfter, d1Path: '$PIN_JSON',
  groups: plan.groups, actions: plan.actions, edits,
  unmatchedD1: plan.unmatchedD1, oversizedIndexRows: plan.oversizedIndexRows, ambiguousCount: plan.ambiguousCount, staleCount: plan.staleCount,
};
fs.writeFileSync('$PLAN_JSON', JSON.stringify(out, null, 2));
if (plan.unmatchedD1.length) { console.error('UNMATCHED', JSON.stringify(plan.unmatchedD1)); process.exit(1); }
if (plan.ambiguousCount > 0) { console.error('AMBIGUOUS', plan.ambiguousCount); process.exit(1); }
if (plan.staleCount > 0) { console.error('STALE', plan.staleCount); process.exit(1); }
" >/dev/null 2>"$T/plan.err"
check $? "plan 阶段(pin-consuming buildFullPlan,零 bestMatch 调用)零 UNMATCHED/AMBIGUOUS/STALE,$(cat "$T/plan.err" 2>/dev/null | head -1)"

# 1a-iii. STALE PIN: a title changed after pinning → --plan-equivalent (pin-consuming computePlan)
#         must refuse that ①-kind action with a clear "stale pin" reason, and must NEVER re-match it
#         (i.e. it must not silently succeed by falling back to bestMatch against the new title).
node -e "
const core = require('$G/pmm-core.cjs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const fs = require('fs');
const dir = '$BEFORE';
const snap = core.snapshotDir(dir);
const bannerRaw = fs.readFileSync(dir + '/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const pin = JSON.parse(fs.readFileSync('$PIN_JSON', 'utf8'));
const oneEntry = pin.entries.find(e => e.kind === '①insert-identity' && !e.ambiguous);
if (!oneEntry) { console.error('fixture has no ①-kind pin entry to stale-test'); process.exit(1); }
// mutate the corpus AFTER pinning: change the title text at the pinned line (still a valid, still
// identity-less title — so if staleness were NOT caught, a re-match would silently succeed).
const buf2 = Buffer.from(snap.files[oneEntry.file].raw);
const text = buf2.toString('utf8');
const lines = text.split('\n');
const idx = oneEntry.titleLineNo - 1;
if (!/plain identity-less title/.test(lines[idx])) { console.error('fixture title text assumption broke:', lines[idx]); process.exit(1); }
lines[idx] = lines[idx].replace('plain identity-less title with no ns:tag bracket at all', 'RETITLED AFTER PINNING — must never re-match');
const mutated = Buffer.from(lines.join('\n'), 'utf8');
snap.files[oneEntry.file] = Object.assign({}, snap.files[oneEntry.file], { raw: mutated, rawWithBOM: mutated });
const d1Stub = { list24: [], sameFileDup: [], crossFileDup: [] };
const plan = migrate.computePlan(snap, d1Stub, { pin });
const staleUnmatched = plan.unmatchedD1.find(u => u.group === '①' && /STALE PIN/.test(u.reason || ''));
if (plan.staleCount !== 1 || !staleUnmatched) { console.error('expected staleCount=1 with a STALE PIN reason, got', plan.staleCount, JSON.stringify(plan.unmatchedD1)); process.exit(1); }
if (plan.actions.some(a => a.kind === '①insert-identity' && a.newId === oneEntry.newTag)) { console.error('BUG: stale pin was silently re-matched into an action'); process.exit(1); }
" >"$T/stale-pin.out" 2>&1
check $? "STALE PIN:标题改名后 pin 消费方拒绝该 ① 动作、给出清楚原因、绝不重新匹配(见 $T/stale-pin.out)"

# 1b. apply — consumes the plan file only (Opus B-1: --apply never re-matches/re-derives)
node "$G/pmm-migrate-v3.cjs" --apply --dir "$AFTER" --plan "$PLAN_JSON" >"$T/apply.out" 2>&1
check $? "apply 阶段($(tail -1 "$T/apply.out"))"

# 1c. verify --stage c0 must be all green (this also exercises A10's REAL re-apply, and A20's
#     NOT-RUN-on-no-treeOid path, since $PLAN_JSON.treeOid is null for this hermetic fixture)
node "$G/pmm-migrate-v3.cjs" --verify --stage c0 --before "$BEFORE" --after "$AFTER" --plan "$AFTER/PLAN-applied.json" >"$T/verify.out" 2>&1
check $? "verify --stage c0 全绿(exit 0);实际输出见 $T/verify.out"

# 1d. A5DEPFAIL (round-5, R5-6 fix, guards/audits/CODEX-2026-09-15-cumulative-review.md MEDIUM-4 /
#     FABLE-2026-09-15-codex-cumulative-triage.md R5-6): the exact audit repro — isolate a guards copy
#     with pmm-manifest.cjs (A5's dependency) MISSING, run --verify --stage c0 against the SAME
#     otherwise-fully-green $BEFORE/$AFTER from step 1c above. Before the fix: A5 reported NOT-RUN and
#     the overall command still exited 0 (cmdVerify's anyFail only trips on FAIL) — the edge-
#     conservation check silently never ran while --verify reported success. Must now: A5 reports FAIL
#     (not NOT-RUN) AND the overall exit code is non-zero.
A5DEP_GUARDS="$T/a5depfail-guards"; rm -rf "$A5DEP_GUARDS"; mkdir -p "$A5DEP_GUARDS"
for f in pmm-core.cjs pmm-trigger-recall.cjs pmm-trigger-glob.cjs pmm-verify-assertions.cjs pmm-migrate-v3.cjs; do
  cp "$G/$f" "$A5DEP_GUARDS/$f"
done
# deliberately DO NOT copy pmm-manifest.cjs — simulates "依赖缺失"
node "$A5DEP_GUARDS/pmm-migrate-v3.cjs" --verify --stage c0 --before "$BEFORE" --after "$AFTER" --plan "$AFTER/PLAN-applied.json" >"$T/a5depfail.out" 2>&1
a5depfail_rc=$?
grep -q '^❌ A5 ' "$T/a5depfail.out"; a5_is_fail=$?
grep -q '^⏭️ A5 ' "$T/a5depfail.out"; a5_is_notrun=$?
[ "$a5depfail_rc" -ne 0 ] && [ "$a5_is_fail" -eq 0 ] && [ "$a5_is_notrun" -ne 0 ]
check $? "A5DEPFAIL:pmm-manifest.cjs 缺失时 A5 必须报 FAIL(不是 NOT-RUN)且整体 --verify 非零退出(实际 rc=$a5depfail_rc;见 $T/a5depfail.out)"
rm -rf "$A5DEP_GUARDS"

# 1e. A5DEPFAIL-EXEC (round-7, guards/audits/OPUS-2026-09-15-round6-review.md LOW-3 aka R7-6):
#     A5DEPFAIL above only ever exercised the "依赖文件缺失"(pmm-manifest.cjs itself absent) branch —
#     pmm-verify-assertions.cjs's A5 code has a SECOND FAIL branch (the outer `catch (e)`) for "依赖
#     执行异常": pmm-manifest.cjs is PRESENT (fs.existsSync true) but the `execFileSync('node', [v1Path,
#     '--json'], ...)` child process crashes before printing any --json output, so execFileSync throws
#     with an empty `e.stdout` and the inner try/catch (which only swallows "non-zero exit WITH stdout",
#     e.g. v1's own legitimate blocking-exit-2) re-throws to the outer catch. R5-6 changed both branches
#     (dependency missing AND dependency execution exception) from NOT-RUN to FAIL, but only the first
#     ever got a break-test. Reproduce the second: keep pmm-manifest.cjs itself present but omit ITS OWN
#     dependency pmm-trigger-recall.cjs (which it requires at module top level) — spawning it then
#     crashes immediately with MODULE_NOT_FOUND on stderr and zero stdout, before it can ever reach its
#     own --json write.
A5DEPEXEC_GUARDS="$T/a5depfail-exec-guards"; rm -rf "$A5DEPEXEC_GUARDS"; mkdir -p "$A5DEPEXEC_GUARDS"
for f in pmm-core.cjs pmm-trigger-glob.cjs pmm-verify-assertions.cjs pmm-migrate-v3.cjs pmm-manifest.cjs; do
  cp "$G/$f" "$A5DEPEXEC_GUARDS/$f"
done
# deliberately DO NOT copy pmm-trigger-recall.cjs — pmm-manifest.cjs itself is present (existsSync
# true) but crashes the instant node loads it, simulating "依赖执行异常" rather than "依赖缺失".
node "$A5DEPEXEC_GUARDS/pmm-migrate-v3.cjs" --verify --stage c0 --before "$BEFORE" --after "$AFTER" --plan "$AFTER/PLAN-applied.json" >"$T/a5depfail-exec.out" 2>&1
a5depfailexec_rc=$?
grep -q '^❌ A5 ' "$T/a5depfail-exec.out"; a5exec_is_fail=$?
grep -q '^⏭️ A5 ' "$T/a5depfail-exec.out"; a5exec_is_notrun=$?
grep -q '运行失败' "$T/a5depfail-exec.out"; a5exec_is_execbranch=$?
[ "$a5depfailexec_rc" -ne 0 ] && [ "$a5exec_is_fail" -eq 0 ] && [ "$a5exec_is_notrun" -ne 0 ] && [ "$a5exec_is_execbranch" -eq 0 ]
check $? "A5DEPFAIL-EXEC:pmm-manifest.cjs 存在但其自身依赖(pmm-trigger-recall.cjs)缺失致执行异常时,A5 必须报 FAIL(走「v1 运行失败」分支,不是 NOT-RUN)且整体 --verify 非零退出(实际 rc=$a5depfailexec_rc;见 $T/a5depfail-exec.out)"
rm -rf "$A5DEPEXEC_GUARDS"

# 2. idempotency: a second --apply with the SAME plan on a copy of the after-dir must write zero
#    files/edits (Opus B-3/A10: real idempotency via the plan's own contentFingerprintAfter match —
#    not a hardcoded PASS; this is the top-level, black-box proof, independent of A10's in-process copy)
#    R10-2 fix (2026-09-15 round 10, guards/audits/CODEX-2026-09-15-round9-review.md MEDIUM-1): this
#    step used to `diff --exclude=PLAN-applied.json`, i.e. deliberately blind itself to the one file the
#    idempotent branch actually touched — exactly how the round-9 audit's finding survived this self-test
#    undetected ("the gate excludes from its own view the thing it's supposed to be watching"). Since the
#    R10-2 fix (see cmdApply's comment on `manifestNote`) makes the idempotent branch NOT touch
#    PLAN-applied.json at all when one already exists, the diff no longer needs — or gets — an exclude:
#    AFTER and AFTER2 must now be COMPLETELY byte-identical, manifest included, and that is asserted
#    directly via sha256 rather than merely "still parses as JSON".
AFTER2="$T/after2"
cp -r "$AFTER" "$AFTER2"
manifest_before_sha_2ndrun="$(sha256sum "$AFTER2/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$AFTER2" --plan "$PLAN_JSON" >"$T/apply2.out" 2>&1
apply2_rc=$?
grep -q "编辑 0 处" "$T/apply2.out"
grep_rc=$?
[ "$apply2_rc" -eq 0 ] && [ "$grep_rc" -eq 0 ]
check $? "幂等:二次 --apply(同一 plan)编辑数必须为 0 且 exit 0(实际 rc=$apply2_rc,$(tail -1 "$T/apply2.out"))"
diff -rq "$AFTER" "$AFTER2" >"$T/after-diff.out" 2>&1
check $? "幂等:二跑后 --dir 内容(含 PLAN-applied.json,不再 --exclude)与一跑后逐字节相同(见 $T/after-diff.out)"
manifest_after_sha_2ndrun="$(sha256sum "$AFTER2/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
[ -n "$manifest_before_sha_2ndrun" ] && [ "$manifest_before_sha_2ndrun" = "$manifest_after_sha_2ndrun" ]
check $? "幂等:二跑前后 manifest sha256 关系按 R10-2 选择①(幂等分支不写/不改 manifest)明确规定为『不变』,实测须相等(前=$manifest_before_sha_2ndrun 后=$manifest_after_sha_2ndrun)"
rm -rf "$AFTER2"

# 2a. IDEMFP-STRUCT (round-5 fix, guards/audits/CODEX-2026-09-15-cumulative-review.md HIGH-1 /
#     FABLE-2026-09-15-codex-cumulative-triage.md R5-1, requirement 1 + 4): the confirmed cross-model
#     repro — take a real plan with non-empty edits, change ONLY contentFingerprintAfter to equal
#     contentFingerprint (edits/actions untouched), apply it against a --dir that is genuinely
#     UNMIGRATED (a fresh copy of $BEFORE, never $AFTER). Before the fix this hit the idempotency
#     short-circuit and exited 0 having written nothing — the corpus stayed unmigrated while the
#     command reported success. Must now be refused before --dir's own fingerprint is even computed.
IDEMFP_DIR="$T/idemfp-struct"; rm -rf "$IDEMFP_DIR"; cp -r "$BEFORE" "$IDEMFP_DIR"
PLAN_IDEMFP_STRUCT="$T/plan-idemfp-struct.json"
node -e "
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.length > 0)) { console.error('fixture plan 的 edits 为空,IDEMFP-STRUCT 构造前提不成立'); process.exit(1); }
plan.contentFingerprintAfter = plan.contentFingerprint; // the ONE field the round-5 repro changes
fs.writeFileSync('$PLAN_IDEMFP_STRUCT', JSON.stringify(plan, null, 2));
"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFP_DIR" --plan "$PLAN_IDEMFP_STRUCT" >"$T/idemfp-struct.out" 2>&1
idemfp_struct_rc=$?
[ "$idemfp_struct_rc" -ne 0 ] && [ ! -f "$IDEMFP_DIR/PLAN-applied.json" ]
check $? "IDEMFP-STRUCT:非空 edits 却声称 contentFingerprintAfter==contentFingerprint 的自相矛盾 plan,对未迁移副本 --apply 必须非零退出且不写 manifest(实际 rc=$idemfp_struct_rc;见 $T/idemfp-struct.out)"
diff -rq "$BEFORE" "$IDEMFP_DIR" >"$T/idemfp-struct-diff.out" 2>&1
check $? "IDEMFP-STRUCT:拒绝后语料必须逐字节保持未迁移状态(见 $T/idemfp-struct-diff.out)"
rm -rf "$IDEMFP_DIR"

# 2b. IDEMFP-BYTES (round-5 fix requirement 2): the self-consistency check above closes the ONE
#     concrete repro, but requirement 2 asks for corroboration beyond a bare whole-snapshot hash
#     match too. Take the LEGITIMATE plan (contentFingerprintAfter genuinely computed, untouched) and
#     smuggle in one EXTRA edit whose oldBytesBase64 is crafted from bytes that are still actually
#     present in the (real, already-migrated) $AFTER dir at the recorded offset — i.e. an edit that
#     claims to be part of this plan but has demonstrably NOT been applied, even though the whole-file
#     fingerprint still matches (the dir itself is untouched; only the JSON's edits[] array gained an
#     entry). Before the corroboration loop existed, the idempotent branch trusted the hash alone and
#     would have declared this idempotent (rc=0) despite a smuggled-in pending edit.
IDEMFPB_DIR="$T/idemfp-bytes"; rm -rf "$IDEMFPB_DIR"; cp -r "$AFTER" "$IDEMFPB_DIR"
# $AFTER already carries its own PLAN-applied.json from step 1b's genuine apply, and cp -r copies it
# along — so "manifest absent" is the wrong post-condition here (it was never absent). Hash it BEFORE
# this run and require it UNCHANGED after, proving a rejected idempotent-branch attempt never
# overwrites the pre-existing manifest with a bogus "success" one.
manifest_before_sha="$(sha256sum "$IDEMFPB_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
PLAN_IDEMFP_BYTES="$T/plan-idemfp-bytes.json"
node -e "
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
const afterBuf = fs.readFileSync('$AFTER/decisions.md');
const deleteLen = Math.min(16, afterBuf.length);
const oldBytesBase64 = afterBuf.slice(0, deleteLen).toString('base64');
plan.edits.push({ file: 'decisions.md', offset: 0, deleteLen, insertText: '', oldBytesBase64, kind: '⑤hook-from-index-rest' });
fs.writeFileSync('$PLAN_IDEMFP_BYTES', JSON.stringify(plan, null, 2));
"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPB_DIR" --plan "$PLAN_IDEMFP_BYTES" >"$T/idemfp-bytes.out" 2>&1
idemfp_bytes_rc=$?
manifest_after_sha="$(sha256sum "$IDEMFPB_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
[ "$idemfp_bytes_rc" -ne 0 ] && [ -n "$manifest_before_sha" ] && [ "$manifest_before_sha" = "$manifest_after_sha" ]
check $? "IDEMFP-BYTES:整份指纹匹配的 idempotent 分支下,若逐条核验发现有编辑的旧字节仍在其偏移处出现(仍未应用),必须拒绝而非只信快照哈希,且不得改写既有 manifest(实际 rc=$idemfp_bytes_rc,manifest sha 前=$manifest_before_sha 后=$manifest_after_sha;见 $T/idemfp-bytes.out)"
rm -rf "$IDEMFPB_DIR"

# 2c. IDEMFP-V2 (round-7 fix, guards/audits/OPUS-2026-09-15-round6-review.md HIGH-1, the "V2" repro
#     independently confirmed via scratchpad/verify-r7-1-v2.cjs against the REAL 291-edit committed
#     plan): IDEMFP-STRUCT above only closes the shape where contentFingerprintAfter is set literally
#     EQUAL to contentFingerprint. A narrower shape still reaches the idempotency short-circuit: set
#     contentFingerprintAfter to the UNMIGRATED dir's OWN real fingerprint (a value DIFFERENT from
#     contentFingerprint, so the self-consistency check does not fire) AND compress every deleteLen>0
#     edit into a pure insertion (deleteLen=0, oldBytesBase64='') so the old-bytes-absence loop's
#     per-edit check can never fail either (an empty expected string "matches" any offset — the same
#     blind spot IDEMFP-BYTES exploits from the opposite direction). Before the R7-1 fix
#     (findEditsNotReflectedInSnap did not exist), this combination reached the short-circuit and
#     reported idempotentSkip success against a --dir that is genuinely, byte-for-byte UNMIGRATED.
IDEMFPV2_DIR="$T/idemfp-v2"; rm -rf "$IDEMFPV2_DIR"; cp -r "$BEFORE" "$IDEMFPV2_DIR"
PLAN_IDEMFP_V2="$T/plan-idemfp-v2.json"
node -e "
const fs = require('fs');
const core = require('$G/pmm-core.cjs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.filter(e => e.deleteLen > 0).length > 0)) { console.error('fixture plan 没有 deleteLen>0 的编辑,IDEMFP-V2 构造前提不成立'); process.exit(1); }
const snap = core.snapshotDir('$BEFORE');
const bannerRaw = fs.readFileSync('$BEFORE/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const pristineFp = core.contentFingerprint(snap, core.ALL_FILES.concat(['banner.md']));
plan.contentFingerprintAfter = pristineFp; // real fingerprint of the STILL-UNMIGRATED \$BEFORE dir
plan.contentFingerprint = 'f'.repeat(64); // 任意其他值,只需与 contentFingerprintAfter 不同(否则撞 IDEMFP-STRUCT 那道闸)
if (plan.contentFingerprint === plan.contentFingerprintAfter) { console.error('倒霉撞车:任意值恰好等于 pristineFp,换一个'); process.exit(1); }
for (const e of plan.edits) { if (e.deleteLen > 0) { e.deleteLen = 0; e.oldBytesBase64 = ''; } }
fs.writeFileSync('$PLAN_IDEMFP_V2', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v2-setup.out" 2>&1
setup_rc=$?
check $setup_rc "IDEMFP-V2:构造前提(fixture 含 deleteLen>0 编辑)成立,fixture 写入成功(见 $T/idemfp-v2-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV2_DIR" --plan "$PLAN_IDEMFP_V2" >"$T/idemfp-v2.out" 2>&1
idemfp_v2_rc=$?
[ "$setup_rc" -eq 0 ] && [ "$idemfp_v2_rc" -ne 0 ] && [ ! -f "$IDEMFPV2_DIR/PLAN-applied.json" ]
check $? "IDEMFP-V2:contentFingerprintAfter 设为未迁移目录自身真实指纹(≠contentFingerprint)+ 全部 deleteLen>0 编辑压平为纯插入,对未迁移副本 --apply 必须非零退出且不写 manifest(实际 rc=$idemfp_v2_rc;见 $T/idemfp-v2.out)"
diff -rq "$BEFORE" "$IDEMFPV2_DIR" >"$T/idemfp-v2-diff.out" 2>&1
check $? "IDEMFP-V2:拒绝后语料必须逐字节保持未迁移状态(见 $T/idemfp-v2-diff.out)"
rm -rf "$IDEMFPV2_DIR"

# 2d. IDEMFP-V5/V6/V7/V8 (round-8 fix, guards/audits/OPUS-2026-09-15-round8-review.md HIGH-1 — the SAME
#     defect surviving a THIRD repair round: round 5 closed "contentFingerprintAfter==contentFingerprint",
#     round 7 (IDEMFP-V2 above) closed "flatten deleteLen>0 to pure inserts while leaving insertText
#     alone" — IDEMFP-V2's own transform does NOT reach rc=0 (findEditsNotReflectedInSnap still fires for
#     all 291 edits, since their insertText is untouched and the dir is genuinely unmigrated). The round-8
#     audit's real bypass needs ONE more step IDEMFP-V2 never took: insertText must ALSO become empty/
#     absent, on EVERY edit (not just the ones that had deleteLen>0), so BOTH the old-bytes-absence loop
#     (fires only when deleteLen is truthy) AND findEditsNotReflectedInSnap (fires only when insertText is
#     non-empty) go silent for the SAME edit simultaneously. V5/V6/V7 below are three different field-
#     shapes that all collapse to that identical "neither side ever fires" condition — proving the round-8
#     fix (an explicit `uncoveredEdits` invariant in cmdApply, not a shape-specific pattern match) closes
#     the underlying CLASS, not one more literal reproduction:
#       V5 — delete the three keys outright (no value is forged at all; a truncated JSON/older-schema/
#            falsy-omitting serializer produces this with zero attacker intent — the audit's actual
#            "not an attack shape" repro, and the one explicitly required by the round-8 repair brief).
#       V6 — set the three keys to explicit JSON `null` (a plan that WAS written by a schema expecting
#            these fields but has them nulled out — different bytes on the wire than V5, same semantics).
#       V7 — set insertText to an empty ARRAY (`[]`) instead of an empty string: `[] || ''` evaluates to
#            `[]` (a non-empty-string type is still truthy in JS), and `[].length === 0` still trips the
#            `(e.insertText || '').length === 0` guard in both the fix and the pre-existing filter at
#            :856 — proving the invariant is closed over VALUE-EMPTINESS, not over `typeof === 'string'`,
#            without needing to special-case types anywhere.
#     V8 is a fourth, orthogonal shape none of V2/V5/V6/V7 exercise: EVERY prior repro degrades ALL 291
#     edits uniformly. V8 downgrades EXACTLY ONE edit (to the V5 missing-keys shape) inside an otherwise
#     completely genuine, already-correctly-migrated plan+dir pairing (the real committed plan against
#     $AFTER, the actual output of step 1's genuine --apply) — proving the invariant is a per-edit filter,
#     not an aggregate/majority check that a single corrupted record could hide inside 290 good ones.
#
# round-10 addenda (guards/audits/CODEX-2026-09-15-round9-review.md MEDIUM-2 + this round's own R10-1
# fix, EDIT_TYPE_DIAG below):
#   (i) Honest bookkeeping correction: of V5/V6/V7's 3 checks and V8's 2 checks (11 total), the FIRST
#       check in each block ("构造前提...成立") only asserts the FIXTURE is well-formed — it stays green
#       even if the round-8/round-10 fix under test were reverted, so it is not evidence the fix works.
#       Only the remaining 7 checks (V5/V6/V7's 2nd+3rd, V8's 2nd) actually go red on a revert. Both
#       counts are real and both are now labelled explicitly at every `check` call and in the final
#       summary line, instead of the previous "11 项加固测试" phrasing that let a reader mistake a
#       precondition assertion for revert-red evidence.
#   (ii) V5/V6/V7/V8's fixture construction calls this file's OWN `core.contentFingerprint` (to compute
#       `pristineFp`) and V8 additionally calls this file's OWN `sortAndValidateEdits` (to pick the
#       victim edit) — both PRODUCTION functions, not independent re-implementations. A defect living
#       inside either of those two functions themselves (as opposed to in the idempotency short-circuit
#       these tests target) would be invisible to these tests, because the fixture-construction step and
#       the code under test would share the same bug. This is a real, disclosed blind spot, not something
#       this round changes — recorded here per the round-9 audit's request that the repo's practice of
#       writing down its own honest limits stay visible rather than silently assumed away.
#   (iii) V9/V10 below extend this same family with the round-9 audit's actual HIGH-1 finding: an
#       array-like OBJECT for insertText (as opposed to V7's array, V6's null, V5's missing key) makes
#       `Buffer.from(x, 'utf8')` (the byte-gate) and `(x || '').length === 0` (the round-8 coverage
#       invariant) DISAGREE about whether the field is "empty" — the byte-gate says yes (array-like →
#       zero-length buffer) while the coverage invariant says no (`{length:'0'}.length` is the STRING
#       '0', and `'0' === 0` is false), so the byte-gate's silence gets misread as "already independently
#       verified" rather than "never actually ran". The R10-1 fix closes this by validating field TYPES
#       before either check ever runs (see pmm-migrate-v3.cjs's validateEditFieldTypes), which is also
#       why V5/V6/V7/V8's rejection below is now asserted against `rc=2` AND a specific diagnostic
#       substring, not just `rc != 0` (round-9 audit MEDIUM-2's other complaint: any unrelated crash
#       could previously have made these checks pass for the wrong reason).
# R12-1 fix (2026-09-16 round 12, guards/audits/CODEX-2026-09-16-round11-review.md MEDIUM-1): the
# producing function was renamed validateEditFieldTypes -> validateEditRecords and its rejection message
# changed from "...类型校验..." to "...契约校验..." (now covers file/offset/kind too, not just
# deleteLen/insertText/oldBytesBase64) — updated here so V5-V10's existing diagnostic-substring greps
# below keep matching. A test suite whose own pass/fail depends on a message string that drifted out from
# under it, silently, is exactly the "gate and engine diverge" pattern this file's own comments warn
# about elsewhere — caught here by actually reading this script before reusing it, per this round's brief.
EDIT_TYPE_DIAG='未通过消费前的契约校验'
IDEMFPV5_DIR="$T/idemfp-v5"; rm -rf "$IDEMFPV5_DIR"; cp -r "$BEFORE" "$IDEMFPV5_DIR"
PLAN_IDEMFP_V5="$T/plan-idemfp-v5.json"
node -e "
const fs = require('fs');
const core = require('$G/pmm-core.cjs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.length > 0)) { console.error('fixture plan 的 edits 为空,IDEMFP-V5 构造前提不成立'); process.exit(1); }
const snap = core.snapshotDir('$BEFORE');
const bannerRaw = fs.readFileSync('$BEFORE/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const pristineFp = core.contentFingerprint(snap, core.ALL_FILES.concat(['banner.md']));
plan.contentFingerprintAfter = pristineFp; // real fingerprint of the STILL-UNMIGRATED \$BEFORE dir
plan.contentFingerprint = 'f'.repeat(64);
if (plan.contentFingerprint === plan.contentFingerprintAfter) { console.error('倒霉撞车:任意值恰好等于 pristineFp,换一个'); process.exit(1); }
for (const e of plan.edits) { delete e.insertText; delete e.deleteLen; delete e.oldBytesBase64; }
fs.writeFileSync('$PLAN_IDEMFP_V5', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v5-setup.out" 2>&1
setup_v5_rc=$?
check $setup_v5_rc "[夹具前提,回退后仍绿] IDEMFP-V5:构造前提(非空 edits)成立,fixture 写入成功(见 $T/idemfp-v5-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV5_DIR" --plan "$PLAN_IDEMFP_V5" >"$T/idemfp-v5.out" 2>&1
idemfp_v5_rc=$?
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v5.out"; idemfp_v5_diag=$?
[ "$setup_v5_rc" -eq 0 ] && [ "$idemfp_v5_rc" -eq 2 ] && [ "$idemfp_v5_diag" -eq 0 ] && [ ! -f "$IDEMFPV5_DIR/PLAN-applied.json" ]
check $? "[回退必红] IDEMFP-V5:全部编辑删除 insertText/deleteLen/oldBytesBase64 三键(缺键,非伪造值)+ contentFingerprintAfter 设为未迁移目录自身真实指纹,对未迁移副本 --apply 必须 rc=2 且命中类型校验诊断(不只是非零退出)且不写 manifest(实际 rc=$idemfp_v5_rc;见 $T/idemfp-v5.out)"
diff -rq "$BEFORE" "$IDEMFPV5_DIR" >"$T/idemfp-v5-diff.out" 2>&1
check $? "[回退必红] IDEMFP-V5:拒绝后语料必须逐字节保持未迁移状态(见 $T/idemfp-v5-diff.out)"
rm -rf "$IDEMFPV5_DIR"

IDEMFPV6_DIR="$T/idemfp-v6"; rm -rf "$IDEMFPV6_DIR"; cp -r "$BEFORE" "$IDEMFPV6_DIR"
PLAN_IDEMFP_V6="$T/plan-idemfp-v6.json"
node -e "
const fs = require('fs');
const core = require('$G/pmm-core.cjs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.length > 0)) { console.error('fixture plan 的 edits 为空,IDEMFP-V6 构造前提不成立'); process.exit(1); }
const snap = core.snapshotDir('$BEFORE');
const bannerRaw = fs.readFileSync('$BEFORE/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const pristineFp = core.contentFingerprint(snap, core.ALL_FILES.concat(['banner.md']));
plan.contentFingerprintAfter = pristineFp;
plan.contentFingerprint = 'f'.repeat(64);
if (plan.contentFingerprint === plan.contentFingerprintAfter) { console.error('倒霉撞车:任意值恰好等于 pristineFp,换一个'); process.exit(1); }
for (const e of plan.edits) { e.insertText = null; e.deleteLen = null; e.oldBytesBase64 = null; }
fs.writeFileSync('$PLAN_IDEMFP_V6', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v6-setup.out" 2>&1
setup_v6_rc=$?
check $setup_v6_rc "[夹具前提,回退后仍绿] IDEMFP-V6:构造前提(非空 edits)成立,fixture 写入成功(见 $T/idemfp-v6-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV6_DIR" --plan "$PLAN_IDEMFP_V6" >"$T/idemfp-v6.out" 2>&1
idemfp_v6_rc=$?
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v6.out"; idemfp_v6_diag=$?
[ "$setup_v6_rc" -eq 0 ] && [ "$idemfp_v6_rc" -eq 2 ] && [ "$idemfp_v6_diag" -eq 0 ] && [ ! -f "$IDEMFPV6_DIR/PLAN-applied.json" ]
check $? "[回退必红] IDEMFP-V6:全部编辑的 insertText/deleteLen/oldBytesBase64 三字段显式设为 JSON null(键仍在,值为 null)+ contentFingerprintAfter 设为未迁移目录自身真实指纹,对未迁移副本 --apply 必须 rc=2 且命中类型校验诊断(不只是非零退出)且不写 manifest(实际 rc=$idemfp_v6_rc;见 $T/idemfp-v6.out)"
diff -rq "$BEFORE" "$IDEMFPV6_DIR" >"$T/idemfp-v6-diff.out" 2>&1
check $? "[回退必红] IDEMFP-V6:拒绝后语料必须逐字节保持未迁移状态(见 $T/idemfp-v6-diff.out)"
rm -rf "$IDEMFPV6_DIR"

IDEMFPV7_DIR="$T/idemfp-v7"; rm -rf "$IDEMFPV7_DIR"; cp -r "$BEFORE" "$IDEMFPV7_DIR"
PLAN_IDEMFP_V7="$T/plan-idemfp-v7.json"
node -e "
const fs = require('fs');
const core = require('$G/pmm-core.cjs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.length > 0)) { console.error('fixture plan 的 edits 为空,IDEMFP-V7 构造前提不成立'); process.exit(1); }
const snap = core.snapshotDir('$BEFORE');
const bannerRaw = fs.readFileSync('$BEFORE/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const pristineFp = core.contentFingerprint(snap, core.ALL_FILES.concat(['banner.md']));
plan.contentFingerprintAfter = pristineFp;
plan.contentFingerprint = 'f'.repeat(64);
if (plan.contentFingerprint === plan.contentFingerprintAfter) { console.error('倒霉撞车:任意值恰好等于 pristineFp,换一个'); process.exit(1); }
for (const e of plan.edits) { e.insertText = []; e.deleteLen = 0; e.oldBytesBase64 = ''; }
fs.writeFileSync('$PLAN_IDEMFP_V7', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v7-setup.out" 2>&1
setup_v7_rc=$?
check $setup_v7_rc "[夹具前提,回退后仍绿] IDEMFP-V7:构造前提(非空 edits)成立,fixture 写入成功(见 $T/idemfp-v7-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV7_DIR" --plan "$PLAN_IDEMFP_V7" >"$T/idemfp-v7.out" 2>&1
idemfp_v7_rc=$?
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v7.out"; idemfp_v7_diag=$?
[ "$setup_v7_rc" -eq 0 ] && [ "$idemfp_v7_rc" -eq 2 ] && [ "$idemfp_v7_diag" -eq 0 ] && [ ! -f "$IDEMFPV7_DIR/PLAN-applied.json" ]
check $? "[回退必红] IDEMFP-V7:全部编辑的 insertText 类型混淆为空数组([],而非空字符串)+ deleteLen=0 + contentFingerprintAfter 设为未迁移目录自身真实指纹,对未迁移副本 --apply 必须 rc=2 且命中类型校验诊断(不只是非零退出)且不写 manifest(实际 rc=$idemfp_v7_rc;见 $T/idemfp-v7.out)"
diff -rq "$BEFORE" "$IDEMFPV7_DIR" >"$T/idemfp-v7-diff.out" 2>&1
check $? "[回退必红] IDEMFP-V7:拒绝后语料必须逐字节保持未迁移状态(见 $T/idemfp-v7-diff.out)"
rm -rf "$IDEMFPV7_DIR"

IDEMFPV8_DIR="$T/idemfp-v8"; rm -rf "$IDEMFPV8_DIR"; cp -r "$AFTER" "$IDEMFPV8_DIR"
manifest_v8_before_sha="$(sha256sum "$IDEMFPV8_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
PLAN_IDEMFP_V8="$T/plan-idemfp-v8.json"
node -e "
const fs = require('fs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.length > 1)) { console.error('fixture plan 编辑数不足,IDEMFP-V8 构造前提不成立'); process.exit(1); }
// Pick the victim so its corruption CANNOT cascade into a different, pre-existing failure: it must be
// the LAST edit (by the real (offset,kindRank) sort order sortAndValidateEdits/computeAfterPositions
// actually use) within its file's own edit list, so no sibling edit's delta bookkeeping depends on it.
// (An earlier draft of this test used plan.edits[0] and the round-8 repair found — by first watching it
// PASS even against the pre-fix binary — that corrupting a NON-last edit lets findEditsNotReflectedInSnap
// catch it as a side effect of delta drift on its later siblings, which would prove nothing about the
// round-8 invariant specifically. This selection is what actually isolates it.)
const byFile = {};
for (const e of plan.edits) { (byFile[e.file] = byFile[e.file] || []).push(e); }
let victimFile = null, victimList = null;
for (const [file, list] of Object.entries(byFile)) {
  if (!victimList || list.length > victimList.length) { victimFile = file; victimList = list; }
}
const sorted = migrate.sortAndValidateEdits(victimList);
const victim = sorted[sorted.length - 1]; // last-sorted edit in the file with the most edits
delete victim.insertText; delete victim.deleteLen; delete victim.oldBytesBase64;
fs.writeFileSync('$PLAN_IDEMFP_V8', JSON.stringify(plan, null, 2));
console.error('victim file=' + victimFile + ' offset=' + victim.offset + ' kind=' + victim.kind + ' of ' + plan.edits.length + ' total edits');
" >"$T/idemfp-v8-setup.out" 2>&1
setup_v8_rc=$?
check $setup_v8_rc "[夹具前提,回退后仍绿] IDEMFP-V8:构造前提(edits.length>1)成立,victim 已选为其文件排序后最后一条编辑(隔离,不牵连同文件其余编辑),fixture 写入成功(见 $T/idemfp-v8-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV8_DIR" --plan "$PLAN_IDEMFP_V8" >"$T/idemfp-v8.out" 2>&1
idemfp_v8_rc=$?
manifest_v8_after_sha="$(sha256sum "$IDEMFPV8_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v8.out"; idemfp_v8_diag=$?
[ "$setup_v8_rc" -eq 0 ] && [ "$idemfp_v8_rc" -eq 2 ] && [ "$idemfp_v8_diag" -eq 0 ] && [ -n "$manifest_v8_before_sha" ] && [ "$manifest_v8_before_sha" = "$manifest_v8_after_sha" ]
check $? "[回退必红] IDEMFP-V8:otherwise 真实已迁移的 --dir(真实 plan 对真实 \$AFTER)上仅将其文件内排序后最后一条编辑(其余编辑原样不动、且该选择使其无法牵连任何同文件后续编辑)降格为 V5 缺键形状,仍必须整体 rc=2 且命中类型校验诊断且不得改写既有 manifest(实际 rc=$idemfp_v8_rc,manifest sha 前=$manifest_v8_before_sha 后=$manifest_v8_after_sha;见 $T/idemfp-v8.out $T/idemfp-v8-setup.out)"
rm -rf "$IDEMFPV8_DIR"

# 2e. IDEMFP-V9/V10 (round-10 fix, guards/audits/CODEX-2026-09-15-round9-review.md HIGH-1 — the SAME
#     defect surviving a FOURTH repair round after round-8's V5/V6/V7 above): the round-9 cross-model
#     re-review took round-8's own enumerate-and-exclude reasoning at face value, then found a member of
#     the SAME class the enumeration missed — an array-LIKE OBJECT for insertText, as opposed to V7's
#     array, V6's null, or V5's missing key. `Buffer.from({length:'0'}, 'utf8')` treats the object as
#     array-like input and yields a zero-length buffer (byte-gate says "empty, skip"), while
#     `({length:'0'} || '').length` is the STRING '0' (an array-like object is truthy, so `||` never
#     falls through to the empty-string default) and `'0' === 0` is false under strict equality
#     (round-8's coverage invariant says "non-empty, must have been independently verified" — but it
#     never was). V9 uses `{length:'0'}`; V10 uses `{type:'Buffer',data:[]}` (Node's own JSON
#     serialization of a Buffer) — a second, independently-plausible member of the same shape family,
#     confirming the fix must be type-based (validateEditFieldTypes: `typeof insertText === 'string'`)
#     rather than yet another value-based exclusion for one more literal.
IDEMFPV9_DIR="$T/idemfp-v9"; rm -rf "$IDEMFPV9_DIR"; cp -r "$BEFORE" "$IDEMFPV9_DIR"
PLAN_IDEMFP_V9="$T/plan-idemfp-v9.json"
node -e "
const fs = require('fs');
const core = require('$G/pmm-core.cjs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.length > 0)) { console.error('fixture plan 的 edits 为空,IDEMFP-V9 构造前提不成立'); process.exit(1); }
const snap = core.snapshotDir('$BEFORE');
const bannerRaw = fs.readFileSync('$BEFORE/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const pristineFp = core.contentFingerprint(snap, core.ALL_FILES.concat(['banner.md']));
plan.contentFingerprintAfter = pristineFp; // real fingerprint of the STILL-UNMIGRATED \$BEFORE dir
plan.contentFingerprint = 'f'.repeat(64);
if (plan.contentFingerprint === plan.contentFingerprintAfter) { console.error('倒霉撞车:任意值恰好等于 pristineFp,换一个'); process.exit(1); }
for (const e of plan.edits) { e.deleteLen = 0; e.oldBytesBase64 = ''; e.insertText = { length: '0' }; }
fs.writeFileSync('$PLAN_IDEMFP_V9', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v9-setup.out" 2>&1
setup_v9_rc=$?
check $setup_v9_rc "[夹具前提,回退后仍绿] IDEMFP-V9:构造前提(非空 edits)成立,fixture 写入成功(见 $T/idemfp-v9-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV9_DIR" --plan "$PLAN_IDEMFP_V9" >"$T/idemfp-v9.out" 2>&1
idemfp_v9_rc=$?
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v9.out"; idemfp_v9_diag=$?
[ "$setup_v9_rc" -eq 0 ] && [ "$idemfp_v9_rc" -eq 2 ] && [ "$idemfp_v9_diag" -eq 0 ] && [ ! -f "$IDEMFPV9_DIR/PLAN-applied.json" ]
check $? "[回退必红] IDEMFP-V9:全部编辑 deleteLen=0/oldBytesBase64='' + insertText 混淆为 array-like 对象 {length:'0'}(Buffer.from 视为长度 0,但 (x||'').length 是字符串 '0' 不等于数字 0)+ contentFingerprintAfter 设为未迁移目录自身真实指纹,对未迁移副本 --apply 必须 rc=2 且命中类型校验诊断且不写 manifest(实际 rc=$idemfp_v9_rc;见 $T/idemfp-v9.out)"
diff -rq "$BEFORE" "$IDEMFPV9_DIR" >"$T/idemfp-v9-diff.out" 2>&1
check $? "[回退必红] IDEMFP-V9:拒绝后语料必须逐字节保持未迁移状态(见 $T/idemfp-v9-diff.out)"
rm -rf "$IDEMFPV9_DIR"

IDEMFPV10_DIR="$T/idemfp-v10"; rm -rf "$IDEMFPV10_DIR"; cp -r "$BEFORE" "$IDEMFPV10_DIR"
PLAN_IDEMFP_V10="$T/plan-idemfp-v10.json"
node -e "
const fs = require('fs');
const core = require('$G/pmm-core.cjs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.length > 0)) { console.error('fixture plan 的 edits 为空,IDEMFP-V10 构造前提不成立'); process.exit(1); }
const snap = core.snapshotDir('$BEFORE');
const bannerRaw = fs.readFileSync('$BEFORE/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const pristineFp = core.contentFingerprint(snap, core.ALL_FILES.concat(['banner.md']));
plan.contentFingerprintAfter = pristineFp;
plan.contentFingerprint = 'f'.repeat(64);
if (plan.contentFingerprint === plan.contentFingerprintAfter) { console.error('倒霉撞车:任意值恰好等于 pristineFp,换一个'); process.exit(1); }
for (const e of plan.edits) { e.deleteLen = 0; e.oldBytesBase64 = ''; e.insertText = { type: 'Buffer', data: [] }; }
fs.writeFileSync('$PLAN_IDEMFP_V10', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v10-setup.out" 2>&1
setup_v10_rc=$?
check $setup_v10_rc "[夹具前提,回退后仍绿] IDEMFP-V10:构造前提(非空 edits)成立,fixture 写入成功(见 $T/idemfp-v10-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV10_DIR" --plan "$PLAN_IDEMFP_V10" >"$T/idemfp-v10.out" 2>&1
idemfp_v10_rc=$?
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v10.out"; idemfp_v10_diag=$?
[ "$setup_v10_rc" -eq 0 ] && [ "$idemfp_v10_rc" -eq 2 ] && [ "$idemfp_v10_diag" -eq 0 ] && [ ! -f "$IDEMFPV10_DIR/PLAN-applied.json" ]
check $? "[回退必红] IDEMFP-V10:全部编辑 deleteLen=0/oldBytesBase64='' + insertText 混淆为 Node Buffer 的 JSON 序列化形状 {type:'Buffer',data:[]}(同族另一 array-like 成员)+ contentFingerprintAfter 设为未迁移目录自身真实指纹,对未迁移副本 --apply 必须 rc=2 且命中类型校验诊断且不写 manifest(实际 rc=$idemfp_v10_rc;见 $T/idemfp-v10.out)"
diff -rq "$BEFORE" "$IDEMFPV10_DIR" >"$T/idemfp-v10-diff.out" 2>&1
check $? "[回退必红] IDEMFP-V10:拒绝后语料必须逐字节保持未迁移状态(见 $T/idemfp-v10-diff.out)"
rm -rf "$IDEMFPV10_DIR"

# round-12 addenda (2026-09-16, guards/audits/CODEX-2026-09-16-round11-review.md MEDIUM-1/LOW-2, R12-1/
# R12-2 fix): V5-V10 above are all shapes of `insertText`. The round-11 audit's own confirmed repro moves
# to `file`/`kind`/`offset` instead — and unlike V5-V10, it needs NO pristineFp trickery to reach the
# idempotency short-circuit: $AFTER is ALREADY the real post-apply dir from step 1b above, and
# $PLAN_JSON's contentFingerprintAfter GENUINELY equals $AFTER's own current fingerprint (this is the
# actual "second --apply of an already-migrated dir" scenario, not a fabricated one — matching the
# round-11 audit's own "ARRAY"/"PROTO" table rows more directly than V5-V10's worst-case construction
# does). validateEditRecords (the renamed, extended validateEditFieldTypes) now runs unconditionally
# before EITHER branch of cmdApply is even reached, so these three break-tests target ANY --dir; V8's
# established $AFTER-copy + manifest-sha convention is reused for all three.
IDEMFPV11_DIR="$T/idemfp-v11"; rm -rf "$IDEMFPV11_DIR"; cp -r "$AFTER" "$IDEMFPV11_DIR"
manifest_v11_before_sha="$(sha256sum "$IDEMFPV11_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
PLAN_IDEMFP_V11="$T/plan-idemfp-v11.json"
node -e "
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
if (!(plan.edits.length > 0)) { console.error('fixture plan 的 edits 为空,IDEMFP-V11 构造前提不成立'); process.exit(1); }
// R12-1 repro: every edit's file/kind wrapped in a single-element array. Old KIND_ORDER[kind] and
// snap.files[e.file]/byFile[e.file] object-key lookups coerce ['x'] to 'x' via ToPropertyKey and
// silently accept it as if it were the plain string — the round-11 audit's confirmed vector.
for (const e of plan.edits) { e.file = [e.file]; e.kind = [e.kind]; }
fs.writeFileSync('$PLAN_IDEMFP_V11', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v11-setup.out" 2>&1
setup_v11_rc=$?
check $setup_v11_rc "[夹具前提,回退后仍绿] IDEMFP-V11:构造前提(非空 edits)成立,fixture 写入成功(见 $T/idemfp-v11-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV11_DIR" --plan "$PLAN_IDEMFP_V11" >"$T/idemfp-v11.out" 2>&1
idemfp_v11_rc=$?
manifest_v11_after_sha="$(sha256sum "$IDEMFPV11_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v11.out"; idemfp_v11_diag=$?
grep -q 'kind 必须是字符串且属于 KIND_ORDER' "$T/idemfp-v11.out"; idemfp_v11_kinddiag=$?
[ "$setup_v11_rc" -eq 0 ] && [ "$idemfp_v11_rc" -eq 2 ] && [ "$idemfp_v11_diag" -eq 0 ] && [ "$idemfp_v11_kinddiag" -eq 0 ] && [ -n "$manifest_v11_before_sha" ] && [ "$manifest_v11_before_sha" = "$manifest_v11_after_sha" ]
check $? "[回退必红] IDEMFP-V11(R12-1):对真实已迁移的 \$AFTER 副本重放真实 --apply(幂等短路的真实入口,非伪造指纹),plan 每条编辑的 file/kind 各被包成单元素数组 —— 必须在消费前的契约校验处即拒绝,rc=2 且同时命中 file/offset/kind/insertText/oldBytesBase64/kind 统一诊断与 kind 专属诊断,且不得改写既有 manifest(实际 rc=$idemfp_v11_rc,manifest sha 前=$manifest_v11_before_sha 后=$manifest_v11_after_sha;见 $T/idemfp-v11.out)"
diff -rq "$AFTER" "$IDEMFPV11_DIR" >"$T/idemfp-v11-diff.out" 2>&1
check $? "[回退必红] IDEMFP-V11:拒绝后语料必须与真实 \$AFTER 逐字节保持一致,不被二次改写(见 $T/idemfp-v11-diff.out)"
rm -rf "$IDEMFPV11_DIR"

IDEMFPV12_DIR="$T/idemfp-v12"; rm -rf "$IDEMFPV12_DIR"; cp -r "$AFTER" "$IDEMFPV12_DIR"
manifest_v12_before_sha="$(sha256sum "$IDEMFPV12_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
PLAN_IDEMFP_V12="$T/plan-idemfp-v12.json"
node -e "
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
const pureInserts = plan.edits.filter(e => !(e.deleteLen > 0));
if (!(pureInserts.length > 0)) { console.error('fixture plan 无 deleteLen=0 的纯插入编辑,IDEMFP-V12 构造前提不成立'); process.exit(1); }
// R12-2 repro (the round-11 audit's own confirmed PROTO row): a pure-insertion edit's file renamed to
// '__proto__' — before this round's Object.create(null) hardening, findEditsNotReflectedInSnap's plain
// {}-literal byFile made 'byFile[\"__proto__\"]' read the object's OWN PROTOTYPE (truthy, not a real
// entry), so '.push' on it threw an UNCAUGHT TypeError (rc=1, bare stack, no diagnostic) instead of a
// clean contract rejection.
for (const e of pureInserts) e.file = '__proto__';
fs.writeFileSync('$PLAN_IDEMFP_V12', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v12-setup.out" 2>&1
setup_v12_rc=$?
check $setup_v12_rc "[夹具前提,回退后仍绿] IDEMFP-V12:构造前提(存在 deleteLen=0 的纯插入编辑)成立,fixture 写入成功(见 $T/idemfp-v12-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV12_DIR" --plan "$PLAN_IDEMFP_V12" >"$T/idemfp-v12.out" 2>&1
idemfp_v12_rc=$?
manifest_v12_after_sha="$(sha256sum "$IDEMFPV12_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v12.out"; idemfp_v12_diag=$?
grep -qi 'is not a function' "$T/idemfp-v12.out"; idemfp_v12_hasstack=$?
[ "$setup_v12_rc" -eq 0 ] && [ "$idemfp_v12_rc" -eq 2 ] && [ "$idemfp_v12_diag" -eq 0 ] && [ "$idemfp_v12_hasstack" -ne 0 ] && [ -n "$manifest_v12_before_sha" ] && [ "$manifest_v12_before_sha" = "$manifest_v12_after_sha" ]
check $? "[回退必红] IDEMFP-V12(R12-2):对真实已迁移的 \$AFTER 副本重放真实 --apply,一条纯插入编辑的 file 改为 '__proto__' —— 必须在消费前的契约校验处即以 rc=2+诊断拒绝(不是 \`.push is not a function\` 之类未捕获栈),且不得改写既有 manifest(实际 rc=$idemfp_v12_rc;见 $T/idemfp-v12.out)"
diff -rq "$AFTER" "$IDEMFPV12_DIR" >"$T/idemfp-v12-diff.out" 2>&1
check $? "[回退必红] IDEMFP-V12:拒绝后语料必须与真实 \$AFTER 逐字节保持一致(见 $T/idemfp-v12-diff.out)"
rm -rf "$IDEMFPV12_DIR"

IDEMFPV13_DIR="$T/idemfp-v13"; rm -rf "$IDEMFPV13_DIR"; cp -r "$AFTER" "$IDEMFPV13_DIR"
manifest_v13_before_sha="$(sha256sum "$IDEMFPV13_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
PLAN_IDEMFP_V13="$T/plan-idemfp-v13.json"
node -e "
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON', 'utf8'));
const victim = plan.edits.find(e => !(e.deleteLen > 0));
if (!victim) { console.error('fixture plan 无 deleteLen=0 编辑可选作 IDEMFP-V13 的目标,构造前提不成立'); process.exit(1); }
// R12-1 repro (audit's :1509 note): offset as its own decimal-string form. computeAfterPositions' old
// \`e.offset + delta\` is STRING CONCATENATION whenever offset is a string (delta is always a plain JS
// number) — not arithmetic — silently producing a wrong afterOffset instead of throwing or being caught
// by a type check.
victim.offset = String(victim.offset);
fs.writeFileSync('$PLAN_IDEMFP_V13', JSON.stringify(plan, null, 2));
" >"$T/idemfp-v13-setup.out" 2>&1
setup_v13_rc=$?
check $setup_v13_rc "[夹具前提,回退后仍绿] IDEMFP-V13:构造前提(存在 deleteLen=0 编辑可选作目标)成立,fixture 写入成功(见 $T/idemfp-v13-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$IDEMFPV13_DIR" --plan "$PLAN_IDEMFP_V13" >"$T/idemfp-v13.out" 2>&1
idemfp_v13_rc=$?
manifest_v13_after_sha="$(sha256sum "$IDEMFPV13_DIR/PLAN-applied.json" 2>/dev/null | awk '{print $1}')"
grep -q "$EDIT_TYPE_DIAG" "$T/idemfp-v13.out"; idemfp_v13_diag=$?
grep -q 'offset 必须是 >=0 的安全整数' "$T/idemfp-v13.out"; idemfp_v13_offsetdiag=$?
[ "$setup_v13_rc" -eq 0 ] && [ "$idemfp_v13_rc" -eq 2 ] && [ "$idemfp_v13_diag" -eq 0 ] && [ "$idemfp_v13_offsetdiag" -eq 0 ] && [ -n "$manifest_v13_before_sha" ] && [ "$manifest_v13_before_sha" = "$manifest_v13_after_sha" ]
check $? "[回退必红] IDEMFP-V13(R12-1):对真实已迁移的 \$AFTER 副本重放真实 --apply,一条 deleteLen=0 编辑的 offset 改为其十进制字符串形式 —— 必须在消费前的契约校验处即拒绝,rc=2 且命中 offset 专属诊断,且不得改写既有 manifest(实际 rc=$idemfp_v13_rc;见 $T/idemfp-v13.out)"
diff -rq "$AFTER" "$IDEMFPV13_DIR" >"$T/idemfp-v13-diff.out" 2>&1
check $? "[回退必红] IDEMFP-V13:拒绝后语料必须与真实 \$AFTER 逐字节保持一致(见 $T/idemfp-v13-diff.out)"
rm -rf "$IDEMFPV13_DIR"

# KINDRANK-STRICT (R12-1 unit-level, isolates kindRank's own Set-membership fix from the front gate):
# call the exported kindRank directly with a single-element-array-wrapped LEGAL kind, bypassing cmdApply
# entirely. Before this round, KIND_ORDER[[kind]] silently returned the same rank as KIND_ORDER[kind]
# (object-key ToPropertyKey coercion); kindRank must now throw regardless of any caller's own validation.
node -e "
const migrate = require('$G/pmm-migrate-v3.cjs');
const legalKind = migrate.PRODUCING_KINDS[0];
let threw = false, msg = '';
try { migrate.kindRank([legalKind]); } catch (e) { threw = true; msg = String(e.message || e); }
if (!threw) { console.error('kindRank([legalKind]) 未抛出 —— 对象键强转回归'); process.exit(1); }
if (!/未知的 action kind/.test(msg)) { console.error('kindRank 抛出了,但诊断文案不含预期子串:', msg); process.exit(1); }
" >"$T/kindrank-strict.out" 2>&1
check $? "[回退必红] KINDRANK-STRICT(R12-1 单元级):kindRank 对单元素数组包装的合法 kind 必须抛出(Set.has 不做 ToPropertyKey 强转),绕开 cmdApply 前置闸单独验证(见 $T/kindrank-strict.out)"

# PROTOUNIT (R12-2 unit-level, isolates findEditsNotReflectedInSnap's own Object.create(null) hardening
# from the front gate): call it directly with a hand-built file='__proto__' edit, bypassing cmdApply's
# validateEditRecords entirely. This does not claim the residual is unreachable via any shipped command
# (cmdApply's front gate already rejects file='__proto__' before this function is ever reached) — it
# proves the byFile grouping itself, in isolation, no longer throws \`.push is not a function\` the way
# a plain {} literal did.
node -e "
const core = require('$G/pmm-core.cjs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const snap = core.snapshotDir('$AFTER');
const bannerRaw = require('fs').readFileSync('$AFTER/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
let threw = false, msg = '';
try {
  migrate.findEditsNotReflectedInSnap(snap, [{ file: '__proto__', offset: 0, deleteLen: 0, insertText: 'x', oldBytesBase64: '', kind: migrate.PRODUCING_KINDS[0] }]);
} catch (e) { threw = true; msg = String(e.message || e); }
if (threw && /is not a function/.test(msg)) { console.error('byFile[\"__proto__\"].push 仍是未捕获栈:', msg); process.exit(1); }
" >"$T/protounit.out" 2>&1
check $? "[回退必红] PROTOUNIT(R12-2 单元级):findEditsNotReflectedInSnap 直接吃 file='__proto__' 不得再现 \`.push is not a function\`(绕开前置闸单独验证 byFile 的 Object.create(null) 加固;见 $T/protounit.out)"

# VERIFYBAD (R12-3, LOW, guards/audits/CODEX-2026-09-16-round11-review.md LOW-2): pmm-verify-assertions.
# cjs's OWN readPlan() used to hand a malformed plan straight to every assertion with ZERO schema
# checking — A1's insertedLineTextsFor (:208/:213) and A11 (:572) both call `.includes`/`.match`/
# `.endsWith` directly on `e.insertText` for every plan.edits entry, and cmdVerify (pmm-migrate-v3.cjs)
# never wraps its call into runAll in try/catch, so a plan whose edits carry a non-string insertText
# crashed the WHOLE --verify run (uncaught TypeError, bare stack, every OTHER assertion's result lost
# too) instead of producing a readable FAIL for just the two assertions that actually need it. Uses the
# REAL $AFTER/PLAN-applied.json (the honest apply from step 1b already wrote it) — tampers a COPY only.
VERIFYBAD_DIR="$T/verifybad"; rm -rf "$VERIFYBAD_DIR"; cp -r "$AFTER" "$VERIFYBAD_DIR"
node -e "
const fs = require('fs');
const p = '$VERIFYBAD_DIR/PLAN-applied.json'.replace(/\\\\/g,'/');
const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!(plan.edits.length > 0)) { console.error('VERIFYBAD 构造前提不成立:manifest 里 edits 为空'); process.exit(1); }
plan.edits[0].insertText = null; // the exact A1/A11 crash vector named in the round-11 audit
fs.writeFileSync(p, JSON.stringify(plan, null, 2));
" >"$T/verifybad-setup.out" 2>&1
setup_verifybad_rc=$?
check $setup_verifybad_rc "[夹具前提,回退后仍绿] VERIFYBAD:构造前提(非空 edits)成立,manifest 改写成功(见 $T/verifybad-setup.out)"
node "$G/pmm-migrate-v3.cjs" --verify --stage c0 --before "$BEFORE" --after "$VERIFYBAD_DIR" >"$T/verifybad.out" 2>&1
verifybad_rc=$?
grep -q 'TypeError' "$T/verifybad.out"; verifybad_hastypeerror=$?
grep -q '^❌ A1 ' "$T/verifybad.out"; verifybad_a1fail=$?
grep -q '^❌ A11 ' "$T/verifybad.out"; verifybad_a11fail=$?
grep -q '未通过消费前的契约校验' "$T/verifybad.out"; verifybad_diag=$?
[ "$setup_verifybad_rc" -eq 0 ] && [ "$verifybad_rc" -eq 2 ] && [ "$verifybad_hastypeerror" -ne 0 ] && [ "$verifybad_a1fail" -eq 0 ] && [ "$verifybad_a11fail" -eq 0 ] && [ "$verifybad_diag" -eq 0 ]
check $? "[回退必红] VERIFYBAD(R12-3):真实 manifest 的 plan.edits[0].insertText 改为 null 时,--verify 必须给出结构化 A1/A11 FAIL(命中契约诊断)而不是未捕获 TypeError 栈,整体 rc=2(实际 rc=$verifybad_rc;见 $T/verifybad.out)"
rm -rf "$VERIFYBAD_DIR"

verify_expect() { # $1=label $2=assertion-id  (runs verify on $T/broken vs $BEFORE, expects that ID to FAIL)
  local label="$1" id="$2"
  node "$G/pmm-migrate-v3.cjs" --verify --stage c0 --before "$BEFORE" --after "$T/broken" >"$T/broken.out" 2>&1
  local rc=$?
  if grep -q "^❌ ${id} " "$T/broken.out"; then check 0 "$label"; else check 1 "$label(未见 ❌ ${id};rc=$rc;$(grep "^.* ${id} " "$T/broken.out")"; fi
}

mk_broken() { rm -rf "$T/broken"; cp -r "$AFTER" "$T/broken"; }

# A1 red: corrupt a migrated entry's BODY prose (not its title)
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('D1-NAMING designates this one (by title-gist match) as the one that keeps ms:dup-tag.', 'CORRUPTED BODY TEXT — A1 must catch this.');
fs.writeFileSync(p, s);
"
verify_expect "A1 red(块正文被改必须报 A1)" "A1"

# A2 red: corrupt bytes OUTSIDE any plan edit region (lessons.md, never touched by any action)
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/lessons.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('nothing needs fixing here.', 'nothing needs fixing here BUT SOMEONE EDITED IT ANYWAY.');
fs.writeFileSync(p, s);
"
verify_expect "A2 red(plan 外字节被改必须报 A2)" "A2"

# A3 red: corrupt a title-line TAIL (bracket flags, not the title text itself — must keep the same
# title so before/after pairing-by-title still succeeds) on an entry no allowed action touches.
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/classes.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('[class:ms-fixture]', '[class:ms-fixture] [trust:user-ratified]');
fs.writeFileSync(p, s);
"
verify_expect "A3 red(未受权标题行被改必须报 A3)" "A3"

# A5 red: delete the real Supersedes edge (ms:supersede-new -> ms:supersede-old) from `after`
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('Supersedes: [[ms:supersede-old]]\n', '');
fs.writeFileSync(p, s);
"
verify_expect "A5 red(丢失既有 Supersedes 边必须报 A5)" "A5"

# A5 red (coordinator follow-up, "one edge is silently retargeted"): keep the Supersedes FIELD LINE
# present (so a naive "did the line disappear" check would miss this) but point it at a DIFFERENT,
# still-valid live tag — the old edge (ms:supersede-new=>ms:supersede-old) silently becomes
# (ms:supersede-new=>ms:hookmove). A count-only comparison could miss this if some other change
# happened to keep the total edge COUNT the same; the identity-mapped SET comparison must not.
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('Supersedes: [[ms:supersede-old]]\n', 'Supersedes: [[ms:hookmove]]\n');
fs.writeFileSync(p, s);
"
verify_expect "A5 red(边被静默改向 —— 旧目标消失+新目标出现 —— 必须报 A5)" "A5"

# A6 red: corrupt an entry's dateISO
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('2026-01-06 — a decision later superseded', '2026-03-03 — a decision later superseded');
fs.writeFileSync(p, s);
"
verify_expect "A6 red(dateISO 被改必须报 A6)" "A6"

# A7 red: corrupt the Hook value ⑤ moved in (breaks Index-REST alignment)
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('Hook: REST text differs from title, should become a Hook line', 'Hook: WRONG TEXT');
fs.writeFileSync(p, s);
"
verify_expect "A7 red(Hook/Index 对齐被破坏必须报 A7)" "A7"

# A8 red: corrupt classes.md (must stay byte-identical in C0)
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/classes.md'.replace(/\\\\/g,'/');
fs.appendFileSync(p, '\nextra line that must not be here\n');
"
verify_expect "A8 red(classes.md 改动必须报 A8)" "A8"

# A9 red: introduce a fresh same-file duplicate id that no plan action resolves (post-migration B7)
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/lessons.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s += '\n**2026-02-01 — a brand new duplicate of process:ms-lesson** [process:ms-lesson]\nboom.\n';
fs.writeFileSync(p, s);
"
verify_expect "A9 red(新增未处理重复身份必须报 A9)" "A9"

# A12 red: delete the prose link [[ms:supersede-old]] that ms:hookmove's body carried in \`before\`
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('References [[ms:supersede-old]] as a prose link (A12 fixture material).', 'References nothing now (A12 fixture material).');
fs.writeFileSync(p, s);
"
verify_expect "A12 red(丢失既有 link 必须报 A12)" "A12"

# A15 red: corrupt an entry's body that NO plan action touches (ms:supersede-old)
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('body, untouched by any migration action — pure A5/A15 material.', 'CORRUPTED — untouched block must not change.');
fs.writeFileSync(p, s);
"
verify_expect "A15 red(plan 未触及的块被改必须报 A15)" "A15"

# A16 red: introduce a Cause self-edge on an untouched entry (B10 graph invariant)
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
s = s.replace('body, untouched by any migration action — pure A5/A15 material.', 'body.\nCause: [[ms:supersede-old]]');
fs.writeFileSync(p, s);
"
verify_expect "A16 red(引入 Cause 自边必须报 A16)" "A16"

# A17 red: append an oversized Hook line to an entry that already has one (also triggers a fresh
# violation, since \`before\` never had this Hook at all)
mk_broken
node -e "
const fs=require('fs'); const p='$T/broken/decisions.md'.replace(/\\\\/g,'/');
let s = fs.readFileSync(p,'utf8');
const bigHook = 'Hook: ' + 'a'.repeat(400) + '\n';
s = s.replace('**2026-01-04 — decisions-side record of a cross-file duplicate tag** [ms:cross-tag-decided]\n', '**2026-01-04 — decisions-side record of a cross-file duplicate tag** [ms:cross-tag-decided]\n' + bigHook);
fs.writeFileSync(p, s);
"
verify_expect "A17 red(新增超长 Hook 必须报 A17)" "A17"

# ── B-1′ hardening break-tests (2026-09-15) ───────────────────────────────────────────────────────
# B1P: the EXACT FABLE-2026-09-15-b1prime-confirmed.md repro — shift one pure-insertion edit's
# offset (+7 bytes, deleteLen=0 so oldBytesBase64 is empty and "matches" at any offset), leave
# contentFingerprintAfter UNCHANGED (as the real exploit did — nobody recomputed it). --apply must
# reject (non-zero exit) AND leave --dir byte-identical to its pre-apply state (no half-write).
B1P_DIR="$T/b1p"; rm -rf "$B1P_DIR"; mkdir -p "$B1P_DIR"; cp "$BEFORE/"* "$B1P_DIR/"
SHIFTED_PLAN="$T/plan-shifted.json"
node -e "
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON','utf8'));
const idx = plan.edits.findIndex(e => e.deleteLen === 0 && e.titleLineNo != null);
if (idx === -1) { console.error('fixture 没有可用的纯插入编辑(deleteLen=0)'); process.exit(1); }
plan.edits[idx] = Object.assign({}, plan.edits[idx], { offset: plan.edits[idx].offset + 7 });
fs.writeFileSync('$SHIFTED_PLAN', JSON.stringify(plan, null, 2));
" >"$T/b1p-shift.out" 2>&1
check $? "B1P:构造偏移+7 的 plan(见 $T/b1p-shift.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$B1P_DIR" --plan "$SHIFTED_PLAN" >"$T/b1p-apply.out" 2>&1
b1p_rc=$?
diff -rq "$BEFORE" "$B1P_DIR" >"$T/b1p-diff.out" 2>&1
b1p_diff_rc=$?
[ "$b1p_rc" -ne 0 ] && [ "$b1p_diff_rc" -eq 0 ]
check $? "B1P red→green:偏移被挪动的 plan 必须被 --apply 拒绝且不留半写状态(rc=$b1p_rc;$(tail -1 "$T/b1p-apply.out");diff见 $T/b1p-diff.out)"

# B1P2: isolate the offset↔titleLineNo binding (item 2) from the whole-snapshot fingerprint check
# (item 1) — move the SAME pure-insertion edit's offset to byte 0 (nowhere near its anchor title
# line), but this time RECOMPUTE contentFingerprintAfter correctly for that exact (bad) edit set via
# the same simulateAfterSnap() --plan itself uses, so item 1's check is satisfied and only item 2 can
# catch it. Must still be rejected.
B1P2_DIR="$T/b1p2"; rm -rf "$B1P2_DIR"; mkdir -p "$B1P2_DIR"; cp "$BEFORE/"* "$B1P2_DIR/"
SHIFTED_PLAN2="$T/plan-shifted2.json"
node -e "
const core = require('$G/pmm-core.cjs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const fs = require('fs');
const dir = '$BEFORE';
const snap = core.snapshotDir(dir);
const bannerRaw = fs.readFileSync(dir + '/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON','utf8'));
const idx = plan.edits.findIndex(e => e.deleteLen === 0 && e.titleLineNo != null && e.titleLineNo > 1);
if (idx === -1) { console.error('fixture 没有 titleLineNo>1 的纯插入编辑'); process.exit(1); }
const tampered = plan.edits.slice();
tampered[idx] = Object.assign({}, tampered[idx], { offset: 0 });
const afterSnap = migrate.simulateAfterSnap(snap, tampered);
const correctedAfterFp = core.contentFingerprint(afterSnap, migrate.FINGERPRINT_FILES);
const out = Object.assign({}, plan, { edits: tampered, contentFingerprintAfter: correctedAfterFp });
fs.writeFileSync('$SHIFTED_PLAN2', JSON.stringify(out, null, 2));
" >"$T/b1p2-shift.out" 2>&1
check $? "B1P2:构造偏移=0 且 contentFingerprintAfter 已正确重算的 plan(见 $T/b1p2-shift.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$B1P2_DIR" --plan "$SHIFTED_PLAN2" >"$T/b1p2-apply.out" 2>&1
b1p2_rc=$?
diff -rq "$BEFORE" "$B1P2_DIR" >"$T/b1p2-diff.out" 2>&1
b1p2_diff_rc=$?
grep -q "不落在该标题行的块内" "$T/b1p2-apply.out"
b1p2_msg_rc=$?
[ "$b1p2_rc" -ne 0 ] && [ "$b1p2_diff_rc" -eq 0 ] && [ "$b1p2_msg_rc" -eq 0 ]
check $? "B1P2 red→green:即使整份指纹已被正确重算,offset↔titleLineNo 绑定仍必须单独拒绝(rc=$b1p2_rc;$(tail -1 "$T/b1p2-apply.out");diff见 $T/b1p2-diff.out)"

# OVERLAP: two edits whose [offset, offset+deleteLen) ranges intersect must make applyEditsToBuffer
# throw (exercised directly — this is the shared function --apply and --verify's A2 both call).
node -e "
const migrate = require('$G/pmm-migrate-v3.cjs');
const before = Buffer.from('0123456789abcdefghij', 'utf8');
const edits = [
  { file: 'x', offset: 2, deleteLen: 5, insertText: 'AAA', kind: '⑤hook-from-index-rest' },
  { file: 'x', offset: 4, deleteLen: 2, insertText: 'BBB', kind: '⑦add-supersedes-to-target' },
];
try {
  migrate.applyEditsToBuffer(before, edits);
  console.error('BUG: 重叠编辑区间未被拒绝');
  process.exit(1);
} catch (e) {
  if (!/重叠/.test(e.message)) { console.error('抛出了异常但消息不含“重叠”:', e.message); process.exit(1); }
  process.exit(0);
}
" >"$T/overlap.out" 2>&1
check $? "OVERLAP red→green:applyEditsToBuffer 必须拒绝重叠编辑区间(见 $T/overlap.out)"

# A2IND: --verify's A2 must independently re-derive edits from plan.actions + beforeDir bytes, not
# replay plan.edits itself (which the OLD A2 did — self ↔ self, a tautology on a tampered plan). We
# hand-author a $T/a2broken dir whose bytes were produced with the SAME shifted (+7) pure-insertion
# edit as B1P — bypassing --apply entirely (simulating "if apply had wrongly accepted it") — and a
# self-consistent PLAN-applied.json whose `edits` array matches those (now-wrong) written bytes but
# whose `actions` array is the ORIGINAL, untampered one. The OLD A2 (replay plan.edits) would PASS
# (it's checking its own edits against bytes it itself predicts). The NEW A2 must FAIL, because
# re-deriving edits from actions+beforeDir recomputes the correct (unshifted) offset.
A2BROKEN_DIR="$T/a2broken"; rm -rf "$A2BROKEN_DIR"
node -e "
const core = require('$G/pmm-core.cjs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const fs = require('fs');
const dir = '$BEFORE';
const snap = core.snapshotDir(dir);
const bannerRaw = fs.readFileSync(dir + '/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON','utf8'));
const idx = plan.edits.findIndex(e => e.deleteLen === 0 && e.titleLineNo != null);
if (idx === -1) { console.error('fixture 没有可用的纯插入编辑'); process.exit(1); }
const tampered = plan.edits.slice();
tampered[idx] = Object.assign({}, tampered[idx], { offset: tampered[idx].offset + 7 });
fs.mkdirSync('$A2BROKEN_DIR', { recursive: true });
for (const f of core.ALL_FILES) {
  const info = snap.files[f];
  if (!info || info.missing) continue;
  const list = tampered.filter(e => e.file === f);
  const outBuf = list.length ? migrate.applyEditsToBuffer(Buffer.from(info.raw), list) : info.raw;
  const final = info.hadBOM ? Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), outBuf]) : outBuf;
  fs.writeFileSync('$A2BROKEN_DIR/' + f, final);
}
fs.writeFileSync('$A2BROKEN_DIR/banner.md', bannerRaw);
fs.writeFileSync('$A2BROKEN_DIR/PLAN-applied.json', JSON.stringify({
  schemaVersion: 3, appliedAt: new Date().toISOString(), sourcePlan: '$PLAN_JSON', treeOid: plan.treeOid,
  contentFingerprint: plan.contentFingerprint, contentFingerprintAfter: plan.contentFingerprintAfter,
  groups: plan.groups, actions: plan.actions, edits: tampered,
  oversizedIndexRows: plan.oversizedIndexRows, unmatchedD1: plan.unmatchedD1, d1Path: plan.d1Path,
}, null, 2));
" >"$T/a2ind-setup.out" 2>&1
check $? "A2IND:手工构造自洽但偏移被挪动的 broken 目录(见 $T/a2ind-setup.out)"
node "$G/pmm-migrate-v3.cjs" --verify --stage c0 --before "$BEFORE" --after "$A2BROKEN_DIR" >"$T/a2ind-verify.out" 2>&1
grep -q "^❌ A2 " "$T/a2ind-verify.out"
check $? "A2IND red→green:独立重导必须让 A2 对自洽但错误的 plan 报 FAIL(旧实现在此恒真通过;见 $T/a2ind-verify.out)"

# ── round-2 hardening break-tests (2026-09-15, guards/audits/OPUS-2026-09-15-repair-review.md) ─────
# B1P3: THE blind-spot intersection O-1 named (item 4) — B1P moves an offset WITHOUT recomputing
# contentFingerprintAfter (item 1's check alone catches it); B1P2 moves it to byte 0, far outside the
# anchor line (item 2's check alone catches it). Neither lands in the intersection: a SMALL shift that
# stays INSIDE [lineStart, lineEnd) of the very anchor line titleLineSha256 already verified unchanged,
# combined with a CORRECTLY recomputed contentFingerprintAfter for that (still-wrong) edit set. This is
# exactly the round-2 brief's confirmed repro (PLAN-8eacd35d…, edits[0], offset 118714→118717 inside a
# 611-byte-wide anchor line) — before the O-1 fix this was ACCEPTED (rc=0, 3 files written).
B1P3_DIR="$T/b1p3"; rm -rf "$B1P3_DIR"; mkdir -p "$B1P3_DIR"; cp "$BEFORE/"* "$B1P3_DIR/"
SHIFTED_PLAN3="$T/plan-shifted3.json"
node -e "
const core = require('$G/pmm-core.cjs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const fs = require('fs');
const dir = '$BEFORE';
const snap = core.snapshotDir(dir);
const bannerRaw = fs.readFileSync(dir + '/banner.md');
const { buf, hadBOM } = core.stripBOM(bannerRaw);
snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON','utf8'));
const idx = plan.edits.findIndex(e => e.deleteLen === 0 && e.titleLineNo != null);
if (idx === -1) { console.error('fixture 没有可用的纯插入编辑'); process.exit(1); }
const target = plan.edits[idx];
const fbuf = snap.files[target.file].raw;
const lineStart = migrate.findLineStartByTitleLineNo(fbuf, target.titleLineNo);
const lineEnd = migrate.lineEndByte(fbuf, lineStart);
let shift = 3;
if (target.offset + shift >= lineEnd) shift = -3;
if (target.offset + shift < lineStart) { console.error('fixture 锚点行太窄,无法在盲区交集内构造位移(lineStart=' + lineStart + ' lineEnd=' + lineEnd + ' offset=' + target.offset + ')'); process.exit(1); }
const tampered = plan.edits.slice();
tampered[idx] = Object.assign({}, tampered[idx], { offset: target.offset + shift });
const afterSnap = migrate.simulateAfterSnap(snap, tampered);
const correctedAfterFp = core.contentFingerprint(afterSnap, migrate.FINGERPRINT_FILES);
const out = Object.assign({}, plan, { edits: tampered, contentFingerprintAfter: correctedAfterFp });
fs.writeFileSync('$SHIFTED_PLAN3', JSON.stringify(out, null, 2));
console.error('shift=' + shift + ' lineStart=' + lineStart + ' lineEnd=' + lineEnd + ' oldOffset=' + target.offset + ' newOffset=' + (target.offset + shift));
" >"$T/b1p3-shift.out" 2>&1
check $? "B1P3:构造锚点行内小幅位移 + 已正确重算 contentFingerprintAfter 的 plan(盲区交集;见 $T/b1p3-shift.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$B1P3_DIR" --plan "$SHIFTED_PLAN3" >"$T/b1p3-apply.out" 2>&1
b1p3_rc=$?
diff -rq "$BEFORE" "$B1P3_DIR" >"$T/b1p3-diff.out" 2>&1
b1p3_diff_rc=$?
grep -q "独立重导" "$T/b1p3-apply.out"
b1p3_msg_rc=$?
[ "$b1p3_rc" -ne 0 ] && [ "$b1p3_diff_rc" -eq 0 ] && [ "$b1p3_msg_rc" -eq 0 ]
check $? "B1P3 red→green:锚点行内位移+指纹已重算(B1P/B1P2 的盲区交集)必须被独立重导闭合(rc=$b1p3_rc;$(tail -3 "$T/b1p3-apply.out" | tr '\n' ' ');diff见 $T/b1p3-diff.out)"

# HALFWRITE: O-2/O-3 — a fully LEGITIMATE plan (no tampering at all) but the SECOND file --apply would
# write is made read-only before the run. applyEditsToDir must roll the FIRST (already-written) file
# back to its pre-write bytes, cmdApply must report the rollback honestly, and --dir must end up
# byte-identical to BEFORE (no half-write state) — Opus's exact probe-halfwrite.cjs repro.
HALF_DIR="$T/halfwrite"; rm -rf "$HALF_DIR"; mkdir -p "$HALF_DIR"; cp "$BEFORE/"* "$HALF_DIR/"
node -e "
const fs = require('fs');
const plan = JSON.parse(fs.readFileSync('$PLAN_JSON','utf8'));
const order = [];
for (const e of plan.edits) if (!order.includes(e.file)) order.push(e.file);
if (order.length < 2) { console.error('fixture 只涉及 <2 个文件,无法构造中途失败'); process.exit(1); }
const second = order[1];
fs.chmodSync('$HALF_DIR/' + second, 0o444);
console.error('write order=' + order.join(' -> ') + '; made read-only: ' + second);
" >"$T/halfwrite-setup.out" 2>&1
check $? "HALFWRITE:把写入序列第二个文件设只读(见 $T/halfwrite-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$HALF_DIR" --plan "$PLAN_JSON" >"$T/halfwrite-apply.out" 2>&1
half_rc=$?
# restore write perms before diffing/cleanup regardless of outcome (avoid leaking a read-only temp file)
node -e "
const fs = require('fs');
for (const f of fs.readdirSync('$HALF_DIR')) { try { fs.chmodSync('$HALF_DIR/' + f, 0o644); } catch {} }
" >/dev/null 2>&1
diff -rq "$BEFORE" "$HALF_DIR" --exclude=PLAN-applied.json >"$T/halfwrite-diff.out" 2>&1
half_diff_rc=$?
grep -q "回滚" "$T/halfwrite-apply.out"
half_msg_rc=$?
[ "$half_rc" -ne 0 ] && [ "$half_diff_rc" -eq 0 ] && [ "$half_msg_rc" -eq 0 ]
check $? "HALFWRITE red→green:写入阶段中途异常必须回滚且 --dir 与 BEFORE 逐字节相同,不留半写状态(rc=$half_rc;$(tail -3 "$T/halfwrite-apply.out" | tr '\n' ' ');diff见 $T/halfwrite-diff.out)"
if [ -f "$HALF_DIR/PLAN-applied.json" ]; then half_manifest_rc=1; else half_manifest_rc=0; fi
check "$half_manifest_rc" "HALFWRITE:回滚路径必须不写 PLAN-applied.json(却写了)"

# ── round-4 hardening break-tests (2026-09-15, guards/audits/FABLE-2026-09-15-rollback-verify-
# false-alarm.md): the O-3 rollback re-verification fingerprint used to be computed via a bare
# core.snapshotDir(dir), while the before-write fingerprint it must match was computed via
# core.snapshotDir(dir) PLUS a manual banner.md splice — banner.md is not one of core.ALL_FILES, so
# the two fingerprints could never be equal regardless of whether the rollback actually succeeded,
# permanently disabling the "已核实指纹相符" branch and making HALFWRITE above (which only greps for
# the substring "回滚", present in BOTH the trusted and untrusted wordings) blind to this. Fixed by
# routing every --dir fingerprint site through one shared snapshotForFingerprint(dir). Two-sided lock:
# RBFP-OK proves a genuine rollback success is reported as trusted (never "不得信任"); RBFP-CORRUPT
# proves a GENUINELY corrupted rollback (restoreFiles writes wrong bytes but reports ok:true) is still
# reported as untrusted — without this second half, a "fix" that just always trusts the rollback would
# silently pass RBFP-OK while being strictly worse than the original bug.
node "$G/fixtures/v3/rollback-verify-success-probe.cjs" >"$T/rbfp-ok.out" 2>&1
check $? "RBFP-OK red→green:回滚成功时必须报「核实指纹相符」,绝不报「不得信任」(见 $T/rbfp-ok.out)"
node "$G/fixtures/v3/rollback-verify-corrupted-probe.cjs" >"$T/rbfp-corrupt.out" 2>&1
check $? "RBFP-CORRUPT red→green:回滚被人为写坏(还原成错误字节但仍报 ok)时必须仍报「不得信任」(见 $T/rbfp-corrupt.out)"

# A2SEM: O-1 requirement 3 — A2 must have a check that is independent of buildEditOps the FUNCTION,
# not just independent of plan.edits' own offset numbers. Runs the standalone probe that injects a bug
# into a temp copy of buildEditOps, uses THAT broken copy to both write the after-dir and re-derive
# (so byte-replay is tautologically self-consistent), and asserts only the semantic check catches it.
node "$G/fixtures/v3/a2-semantic-independence-probe.cjs" >"$T/a2sem.out" 2>&1
check $? "A2SEM red→green:注入 buildEditOps 自身的位置计算 bug 后,byte-replay 必须保持自洽(绿)而语义核验必须单独抓住它(见 $T/a2sem.out)"

# APPLYSEM: round-3 R-2 (2026-09-15, OPUS-2026-09-15-round2-review.md "R-2") — the semantic check used
# to live ONLY inside --verify's A2; --apply itself never called it, so a buildEditOps bug sailed
# through --apply (rc=0, bytes written) and could only be caught by a SEPARATE, easy-to-skip --verify
# run. Proves the NEW pre-write gate in cmdApply catches an injected buildEditOps bug BEFORE any bytes
# are written, for BOTH the kind that had zero semantic coverage before this fix (②user-no-colon) and
# an already-covered control kind (①insert-identity) — exactly the brief's "分别往 ② 和另一个已覆盖
# kind 注入错误值,两者都必须在 apply 阶段被拦下". Round-5 (R5-3, guards/audits/
# CODEX-2026-09-15-cumulative-review.md HIGH-3): also injects a ④cross-file-decided bug (correct id
# rename, WRONG mutual-link prose) — the exact construction that proved checkA2Semantic's old
# `linkRe.test(after.body)` only checked bracket existence, not the action's precise promised semantics.
node "$G/fixtures/v3/apply-time-semantic-gate-probe.cjs" >"$T/applysem.out" 2>&1
check $? "APPLYSEM red→green:--apply 必须在写入前用语义核验拦下 buildEditOps 的 bug(②①④ 三个 kind 均需被拦,④ 为 R5-3 新增;见 $T/applysem.out)"

# A2COVERAGE: round-3 R-2 requirement 3 — checkA2Semantic must have a branch for every real producing
# kind (PRODUCING_KINDS, single source of truth), and a kind that's in PRODUCING_KINDS but lacks a
# branch must be flagged as a coverage gap (proven via a synthetic-must-fail injection, not just by
# observing today's 7 kinds all happen to be covered).
node "$G/fixtures/v3/a2-semantic-coverage-completeness-probe.cjs" >"$T/a2coverage.out" 2>&1
check $? "A2COVERAGE:checkA2Semantic 覆盖 PRODUCING_KINDS 的全部 7 个 kind,且缺分支的 kind 必须被判为覆盖率缺口(见 $T/a2coverage.out)"

# SAMEOFF: O-8 (round-2 corrected 2026-09-15 round 3, R-1 in OPUS-2026-09-15-round2-review.md) — two
# DIFFERENT actions inserting (deleteLen=0) at the EXACT SAME offset in the same file is a REAL,
# legitimate shape in the C1 plan (5 occurrences: ④+⑤ and ⑤+⑦ sharing a title line's lineEnd byte) —
# applyEditsToBuffer must NOT throw. CORRECTED regression lock (the round-2 version of this test
# asserted concatenation followed "the input list's order" — round2-review.md's R-1 named this as
# exactly the bug: it locked the FORBIDDEN array-order dependency in as expected behavior). The fix
# is KIND_ORDER (pmm-migrate-v3.cjs): concatenation order must be determined SOLELY by the two edits'
# `kind` rank, regardless of which order they appear in the input array — assert BOTH orderings of the
# same two edits produce the IDENTICAL, KIND_ORDER-predicted output.
node -e "
const migrate = require('$G/pmm-migrate-v3.cjs');
const before = Buffer.from('0123456789', 'utf8');
const e5 = { file: 'x', offset: 5, deleteLen: 0, insertText: 'HOOK-', kind: '⑤hook-from-index-rest' };
const e7 = { file: 'x', offset: 5, deleteLen: 0, insertText: 'SUP-', kind: '⑦add-supersedes-to-target' };
const outA = migrate.applyEditsToBuffer(before, [e5, e7]).toString('utf8'); // input order: ⑤ then ⑦
const outB = migrate.applyEditsToBuffer(before, [e7, e5]).toString('utf8'); // input order: ⑦ then ⑤ (swapped)
const want = '01234SUP-HOOK-56789'; // KIND_ORDER: ⑦(4) < ⑤(5) — Supersedes before Hook, §1.2 field order
if (outA !== want) { console.error('BUG: kind-order concat (input order ⑤,⑦) got=' + JSON.stringify(outA) + ' want=' + JSON.stringify(want)); process.exit(1); }
if (outB !== want) { console.error('BUG: kind-order concat (input order ⑦,⑤ — SWAPPED) got=' + JSON.stringify(outB) + ' want=' + JSON.stringify(want) + ' —— 若与 outA 不同,说明拼接顺序仍依赖输入数组序(R-1 未关闭)'); process.exit(1); }
if (outA !== outB) { console.error('BUG: swapping input order changed the output — array-order dependency is back'); process.exit(1); }
process.exit(0);
" >"$T/sameoff.out" 2>&1
check $? "SAMEOFF:同偏移双纯插入(真实 C1 plan 的合法形态)必须不抛异常,且拼接顺序由 KIND_ORDER 决定、与输入数组序无关(见 $T/sameoff.out)"

# KINDORDER-GAP: kindRank() must FAIL CLOSED (throw, refuse) for an unknown/unranked kind at a genuine
# tie — never silently fall back to stable/input order (that would just re-open R-1 for any future kind
# someone forgets to add to KIND_ORDER).
node -e "
const migrate = require('$G/pmm-migrate-v3.cjs');
const before = Buffer.from('0123456789', 'utf8');
const edits = [
  { file: 'x', offset: 5, deleteLen: 0, insertText: 'A-', kind: '⑤hook-from-index-rest' },
  { file: 'x', offset: 5, deleteLen: 0, insertText: 'B-', kind: '⑨totally-unranked-kind' },
];
try {
  migrate.applyEditsToBuffer(before, edits);
  console.error('BUG: 未知 kind 在同偏移处未被拒绝(应 throw,不应静默定序)');
  process.exit(1);
} catch (e) {
  if (!/未知的 action kind|KIND_ORDER/.test(e.message)) { console.error('抛出了异常但消息不含预期文案: ' + e.message); process.exit(1); }
  process.exit(0);
}
" >"$T/kindorder-gap.out" 2>&1
check $? "KINDORDER-GAP:同偏移处遇到 KIND_ORDER 里没有的 kind 必须 throw、拒绝写入,不得静默回退到输入序(见 $T/kindorder-gap.out)"

# KINDGAP-NOCOLLIDE (round-5, R5-5 requirement ①, guards/audits/CODEX-2026-09-15-cumulative-review.md
# MEDIUM-2 / FABLE-2026-09-15-codex-cumulative-triage.md R5-5): KINDORDER-GAP above only proves an
# unknown kind is caught when it TIES on offset with something else (kindRank is only reached inside
# the comparator's `||` short-circuit). The audit's actual construction is a SINGLE non-colliding edit
# with an unregistered kind — Array.prototype.sort never even calls its comparator for an array of
# length 1, so the old code let this straight through (confirmed pre-fix: applyEditsToBuffer('ab',
# [{offset:1,deleteLen:0,insertText:'Z',kind:'NEW'}]) returned 'aZb', no exception). Must now throw
# unconditionally, regardless of array length or offset collisions.
node -e "
const migrate = require('$G/pmm-migrate-v3.cjs');
const before = Buffer.from('ab', 'utf8');
const edits = [ { file: 'x', offset: 1, deleteLen: 0, insertText: 'Z', kind: 'NEW' } ];
try {
  const r = migrate.applyEditsToBuffer(before, edits);
  console.error('BUG: 未登记 kind 的单条非碰撞编辑未被拒绝,结果=' + JSON.stringify(r.toString('utf8')));
  process.exit(1);
} catch (e) {
  if (!/未知的 action kind|KIND_ORDER/.test(e.message)) { console.error('抛出了异常但消息不含预期文案: ' + e.message); process.exit(1); }
  process.exit(0);
}
" >"$T/kindgap-nocollide.out" 2>&1
check $? "KINDGAP-NOCOLLIDE:未登记 kind 的单条(不与任何编辑同偏移碰撞的)编辑必须无条件被拒绝,不得因数组长度≤1或从不触发 tie-break 而放行(见 $T/kindgap-nocollide.out)"

# SAMEOFF-SAMEKIND (round-5, R5-5 requirement ②, guards/audits/CODEX-2026-09-15-cumulative-review.md
# MEDIUM-1 / FABLE-2026-09-15-codex-cumulative-triage.md R5-5): two edits sharing BOTH the same offset
# AND the same kind tie on (offset, kindRank) — Array.prototype.sort's guaranteed stability then falls
# back to the INCOMING array's own order, which is exactly the array-order dependency spec §9② forbids
# (confirmed pre-fix: [X,Y] input -> 'aXYb', [Y,X] input -> 'aYXb', same two edits, only the array order
# differs). Must now refuse deterministically regardless of input order — proven by feeding BOTH orders
# and requiring BOTH to reject identically (not just one).
node -e "
const migrate = require('$G/pmm-migrate-v3.cjs');
const before = Buffer.from('ab', 'utf8');
const eX = { file: 'x', offset: 1, deleteLen: 0, insertText: 'X', kind: '⑤hook-from-index-rest' };
const eY = { file: 'x', offset: 1, deleteLen: 0, insertText: 'Y', kind: '⑤hook-from-index-rest' };
function tryOrder(edits) {
  try { return { ok: true, value: migrate.applyEditsToBuffer(before, edits).toString('utf8') }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
const rXY = tryOrder([eX, eY]);
const rYX = tryOrder([eY, eX]);
console.error('[X,Y] => ' + JSON.stringify(rXY));
console.error('[Y,X] => ' + JSON.stringify(rYX));
if (rXY.ok || rYX.ok) { console.error('BUG: 同偏移同 kind 的两条编辑应被拒绝,却至少一个方向被放行'); process.exit(1); }
if (!/同偏移同 kind|无确定性次序/.test(rXY.msg) || !/同偏移同 kind|无确定性次序/.test(rYX.msg)) { console.error('两个方向都被拒绝,但消息不含预期文案'); process.exit(1); }
process.exit(0);
" >"$T/sameoff-samekind.out" 2>&1
check $? "SAMEOFF-SAMEKIND:同偏移同 kind 的两条编辑,不论输入数组顺序(X,Y 或 Y,X)均须被拒绝、不得产出因数组序而异的字节(见 $T/sameoff-samekind.out)"

# SAMEOFF-SWAP-FULLPLAN: R-1 requirement — swap the two REAL same-offset actions (④+⑤ at
# decisions.md, the migrate-selftest fixture now legitimately produces this collision, mirroring the
# true 291-edit C1 plan's shape) in a FULL plan.actions array, regenerate edits/contentFingerprintAfter
# the exact way --plan does, and confirm --apply on BOTH the honest and the swapped plan produce
# byte-identical decisions.md. This is the literal round-2 audit repro (scratchpad/e2-swap.cjs),
# re-run against the fixed KIND_ORDER-based applyEditsToBuffer — before the fix this would (correctly)
# have shown the SWAPPED plan produces different bytes; after the fix it must not.
SWAP_BEFORE="$T/swap-before"; SWAP_A="$T/swap-a"; SWAP_B="$T/swap-b"
rm -rf "$SWAP_BEFORE" "$SWAP_A" "$SWAP_B"; mkdir -p "$SWAP_BEFORE" "$SWAP_A" "$SWAP_B"
cp "$FIX/memory/"* "$SWAP_BEFORE/"; cp -r "$SWAP_BEFORE/." "$SWAP_A/"; cp -r "$SWAP_BEFORE/." "$SWAP_B/"
PLAN_HONEST="$T/plan-honest.json"; PLAN_SWAPPED="$T/plan-swapped.json"
node -e "
const core = require('$G/pmm-core.cjs');
const migrate = require('$G/pmm-migrate-v3.cjs');
const fs = require('fs');
function loadSnap(dir) {
  const snap = core.snapshotDir(dir);
  const bannerRaw = fs.readFileSync(dir + '/banner.md');
  const { buf, hadBOM } = core.stripBOM(bannerRaw);
  snap.files['banner.md'] = { raw: buf, hadBOM, missing: false, rawWithBOM: bannerRaw };
  return snap;
}
const snap = loadSnap('$SWAP_BEFORE');
const d1 = migrate.parseD1Naming(fs.readFileSync('$FIX/D1-NAMING.md', 'utf8'));
const pinPlan = migrate.computePlan(snap, d1, {});
const pinEntries = migrate.buildD1PinEntries(pinPlan, snap);
if (pinEntries.some(e => e.ambiguous)) { console.error('AMBIGUOUS at pin time'); process.exit(1); }
const pin = { schemaVersion: 1, generatedAt: new Date().toISOString(), treeOid: 'hermetic-swap', sourceD1: '$FIX/D1-NAMING.md', entries: pinEntries };
const d1Stub = { list24: [], sameFileDup: [], crossFileDup: [] };
function buildOut(actions) {
  const edits = migrate.buildEditOps({ actions }, snap);
  const contentFingerprint = core.contentFingerprint(snap, migrate.FINGERPRINT_FILES);
  const afterSnap = migrate.simulateAfterSnap(snap, edits);
  const contentFingerprintAfter = core.contentFingerprint(afterSnap, migrate.FINGERPRINT_FILES);
  return { schemaVersion: 3, generatedAt: new Date().toISOString(), treeOid: null, contentFingerprint, contentFingerprintAfter, d1Path: 'inline', groups: {}, actions, edits, unmatchedD1: [], oversizedIndexRows: [], ambiguousCount: 0, staleCount: 0 };
}
const { plan } = migrate.buildFullPlan(snap, d1Stub, { pin });
if (plan.unmatchedD1.length || plan.ambiguousCount > 0 || plan.staleCount > 0) { console.error('plan not clean'); process.exit(1); }
const edits0 = migrate.buildEditOps(plan, snap);
const byOffset = new Map();
edits0.forEach((e, i) => { const k = e.file + '@' + e.offset; if (!byOffset.has(k)) byOffset.set(k, []); byOffset.get(k).push(i); });
let pairIdx = null;
for (const [k, idxs] of byOffset) if (idxs.length === 2) { pairIdx = idxs; break; }
if (!pairIdx) { console.error('fixture 没有产生真实的同偏移双插入(需要 ④+⑤ 碰撞)'); process.exit(1); }
const a0 = edits0[pairIdx[0]].action, a1 = edits0[pairIdx[1]].action;
console.error('same-offset pair kinds:', a0.kind, a1.kind, 'at', edits0[pairIdx[0]].file + '@' + edits0[pairIdx[0]].offset);
const idx0 = plan.actions.indexOf(a0), idx1 = plan.actions.indexOf(a1);
if (idx0 === -1 || idx1 === -1) { console.error('无法在 plan.actions 里定位这两条 action'); process.exit(1); }
const honestActions = plan.actions.slice();
const swappedActions = plan.actions.slice();
[swappedActions[idx0], swappedActions[idx1]] = [swappedActions[idx1], swappedActions[idx0]];
fs.writeFileSync('$PLAN_HONEST', JSON.stringify(buildOut(honestActions), null, 2));
fs.writeFileSync('$PLAN_SWAPPED', JSON.stringify(buildOut(swappedActions), null, 2));
" >"$T/swap-setup.out" 2>&1
check $? "SAMEOFF-SWAP-FULLPLAN:构造 honest/swapped 两份自洽 plan(见 $T/swap-setup.out)"
node "$G/pmm-migrate-v3.cjs" --apply --dir "$SWAP_A" --plan "$PLAN_HONEST" >"$T/swap-apply-a.out" 2>&1
swap_a_rc=$?
node "$G/pmm-migrate-v3.cjs" --apply --dir "$SWAP_B" --plan "$PLAN_SWAPPED" >"$T/swap-apply-b.out" 2>&1
swap_b_rc=$?
diff -q "$SWAP_A/decisions.md" "$SWAP_B/decisions.md" >"$T/swap-diff.out" 2>&1
swap_diff_rc=$?
[ "$swap_a_rc" -eq 0 ] && [ "$swap_b_rc" -eq 0 ] && [ "$swap_diff_rc" -eq 0 ]
check $? "SAMEOFF-SWAP-FULLPLAN red→green:交换 plan.actions 里同偏移两条 action 的先后,重新走 --plan 同款流程生成的 plan 经 --apply 后产物必须逐字节不变(honest rc=$swap_a_rc swapped rc=$swap_b_rc diff rc=$swap_diff_rc;见 $T/swap-apply-*.out $T/swap-diff.out)"
rm -rf "$SWAP_BEFORE" "$SWAP_A" "$SWAP_B"

rm -rf "$T"
echo "pmm-migrate-v3 self-test: ${ok}/${total}"
if [ "$ok" -eq "$total" ]; then echo "✅ 全绿(plan→apply→verify c0 + 幂等[含 R10-2 manifest sha256 不变断言] + 13 项 break-测试 + 4 项 B-1′ 加固测试 + 7 项 round-2 加固测试[B1P3/HALFWRITE×3/A2SEM/SAMEOFF] + 3 项 round-3 加固测试[SAMEOFF-kind-order/KINDORDER-GAP/SAMEOFF-SWAP-FULLPLAN] + 2 项 round-4 加固测试[RBFP-OK/RBFP-CORRUPT] + 5 项 round-5 加固测试[IDEMFP-STRUCT×2/IDEMFP-BYTES/KINDGAP-NOCOLLIDE/SAMEOFF-SAMEKIND/A5DEPFAIL] + 4 项 round-7 加固测试[IDEMFP-V2×3/A5DEPFAIL-EXEC] + 11 项 round-8 加固测试(其中 4 项为夹具前提断言、回退后仍绿,7 项为回退必红断言,不要把前者当证据)[IDEMFP-V5×3(前提×1+回退必红×2)/IDEMFP-V6×3(前提×1+回退必红×2)/IDEMFP-V7×3(前提×1+回退必红×2)/IDEMFP-V8×2(前提×1+回退必红×1)] + 6 项 round-10 加固测试(其中 2 项为夹具前提断言、4 项为回退必红断言;V5/V6/V7/V8 的回退必红断言同步收紧为 rc=2+诊断文案匹配)[IDEMFP-V9×3(前提×1+回退必红×2)/IDEMFP-V10×3(前提×1+回退必红×2)] + 13 项 round-12 加固测试(guards/audits/CODEX-2026-09-16-round11-review.md MEDIUM-1/LOW-2;其中 4 项为夹具前提断言、回退后仍绿,9 项为回退必红断言,不要把前者当证据)[IDEMFP-V11×3(前提×1+回退必红×2,file/kind 单元素数组)/IDEMFP-V12×3(前提×1+回退必红×2,file='__proto__')/IDEMFP-V13×3(前提×1+回退必红×2,offset 数字字符串)/KINDRANK-STRICT×1(回退必红,单元级绕开前置闸)/PROTOUNIT×1(回退必红,单元级绕开前置闸)/VERIFYBAD×2(前提×1+回退必红×1,--verify 侧))"; exit 0; fi
echo "✖ pmm-migrate-v3 自测 ${ok}/${total}"
exit 1
