#!/usr/bin/env node
// rollback-verify-success-probe.cjs — round-4 break-test ① (2026-09-15,
// guards/audits/FABLE-2026-09-15-rollback-verify-false-alarm.md): a GENUINE write-phase-exception
// rollback (>=1 file already written, then a later file's write throws EPERM because it was made
// read-only) must be reported as verified/trusted — "...并核实指纹相符,未留下半写状态" — and must
// NEVER print "不得信任". Before the fix, the rollback re-verification fingerprint (`rbFp`) was
// computed via a bare `core.snapshotDir(dir)` while the before-write fingerprint (`plan.
// contentFingerprint`) was computed via `core.snapshotDir(dir)` PLUS a manual banner.md splice —
// banner.md is not one of core.ALL_FILES, so the two fingerprints could never be equal regardless of
// whether the rollback actually succeeded, permanently disabling the `rbFp === plan.contentFingerprint`
// branch. The fix (snapshotForFingerprint, shared by every --dir fingerprint site) makes them
// comparable again. Runs against whatever pmm-migrate-v3.cjs is currently live — no bug injected here,
// this locks in the CORRECT behavior going forward (paired with rollback-verify-corrupted-probe.cjs,
// which locks in that a genuinely-bad rollback is still caught).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REAL_GUARDS = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const FIX = REAL_GUARDS + '/fixtures/v3/migrate-selftest';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'rbfp-ok-')).replace(/\\/g, '/');

const core = require(REAL_GUARDS + '/pmm-core.cjs');
const migrate = require(REAL_GUARDS + '/pmm-migrate-v3.cjs');

const BEFORE = T + '/before';
fs.mkdirSync(BEFORE, { recursive: true });
for (const f of fs.readdirSync(FIX + '/memory')) fs.copyFileSync(FIX + '/memory/' + f, BEFORE + '/' + f);

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
if (pinEntries.some((e) => e.ambiguous)) { console.error('AMBIGUOUS at pin time — fixture unusable'); process.exit(1); }
const pin = { schemaVersion: 1, generatedAt: new Date().toISOString(), treeOid: 'hermetic', sourceD1: FIX + '/D1-NAMING.md', entries: pinEntries };
const d1Stub = { list24: [], sameFileDup: [], crossFileDup: [] };
const { plan, edits, contentFingerprint, contentFingerprintAfter } = migrate.buildFullPlan(snap, d1Stub, { pin });
if (plan.unmatchedD1.length || plan.ambiguousCount > 0 || plan.staleCount > 0) { console.error('plan not clean — fixture unusable'); process.exit(1); }

const uniqueFiles = [...new Set(edits.map((e) => e.file))];
if (uniqueFiles.length < 2) { console.error('fixture only touches ' + uniqueFiles.length + ' file(s) — need >=2 to force a partial write before the lock'); process.exit(1); }
const lockFile = uniqueFiles[uniqueFiles.length - 1]; // last-touched file: guarantees >=1 file already written before applyEditsToDir hits it

const planPath = T + '/plan.json';
fs.writeFileSync(planPath, JSON.stringify({
  schemaVersion: 3, generatedAt: new Date().toISOString(), treeOid: 'hermetic', contentFingerprint, contentFingerprintAfter,
  d1Path: 'inline', groups: plan.groups, actions: plan.actions, edits, unmatchedD1: plan.unmatchedD1,
  oversizedIndexRows: plan.oversizedIndexRows, ambiguousCount: plan.ambiguousCount, staleCount: plan.staleCount,
}, null, 2));

const DIR = T + '/dir';
fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync(BEFORE)) fs.copyFileSync(BEFORE + '/' + f, DIR + '/' + f);
const lockPath = DIR + '/' + lockFile;
fs.chmodSync(lockPath, 0o444);

let out = '', rc = 0;
try {
  out = execFileSync(process.execPath, [REAL_GUARDS + '/pmm-migrate-v3.cjs', '--apply', '--dir', DIR, '--plan', planPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
} catch (e) {
  rc = e.status === undefined || e.status === null ? -1 : e.status;
  out = (e.stdout || '') + (e.stderr || '');
} finally {
  try { fs.chmodSync(lockPath, 0o666); } catch {}
}

console.error(out.trim());
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}

const saysDistrust = /不得信任/.test(out);
const saysTrusted = /核实指纹相符/.test(out);
if (rc === 2 && saysTrusted && !saysDistrust) {
  console.error('PASS: genuine rollback success is reported as verified, never as untrusted.');
  process.exit(0);
}
console.error(`FAIL: expected rc=2 with "核实指纹相符" and no "不得信任" — got rc=${rc}, saysTrusted=${saysTrusted}, saysDistrust=${saysDistrust}`);
process.exit(1);
