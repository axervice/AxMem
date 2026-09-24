#!/usr/bin/env node
// rollback-verify-corrupted-probe.cjs — round-4 break-test ② (2026-09-15,
// guards/audits/FABLE-2026-09-15-rollback-verify-false-alarm.md, repair-brief-round4.md requirement
// 4②): the companion lock to rollback-verify-success-probe.cjs — proves the fix did NOT just flip an
// always-"不得信任" bug into an always-"trusted" one. Builds a temp copy of guards/ whose
// pmm-migrate-v3.cjs has ONE deliberate bug injected into restoreFiles: the restore write appends
// garbage after the true pre-write bytes (so it reports `ok: true` / pushes the file into `restored`
// exactly like a real success) but the bytes on disk are NOT actually restored correctly. --apply must
// still detect this via the (now-shared, now-correct) fingerprint re-verification and print
// "不得信任" — never "核实指纹相符". Mirrors the existing apply-time-semantic-gate-probe.cjs /
// a2-semantic-independence-probe.cjs technique (temp copy + verbatim-text NEEDLE injection).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REAL_GUARDS = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
const FIX = REAL_GUARDS + '/fixtures/v3/migrate-selftest';
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'rbfp-bad-')).replace(/\\/g, '/');

const RESTORE_NEEDLE = "      const restoreBuf = info.hadBOM ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), info.raw]) : info.raw;\n      fs.writeFileSync(dir.replace(/\\\\/g, '/') + '/' + f, restoreBuf);\n      restored.push(f);";
const RESTORE_CORRUPT = "      let restoreBuf = info.hadBOM ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), info.raw]) : info.raw;\n      restoreBuf = Buffer.concat([restoreBuf, Buffer.from('\\n<!-- INJECTED BUG (rollback-verify-corrupted-probe): rollback writes WRONG bytes but still reports success -->\\n')]);\n      fs.writeFileSync(dir.replace(/\\\\/g, '/') + '/' + f, restoreBuf);\n      restored.push(f);";

const TG = T + '/guards';
fs.mkdirSync(TG, { recursive: true });
for (const f of ['pmm-core.cjs', 'pmm-trigger-recall.cjs', 'pmm-trigger-glob.cjs', 'pmm-verify-assertions.cjs']) {
  fs.copyFileSync(REAL_GUARDS + '/' + f, TG + '/' + f);
}
let migrateSrc = fs.readFileSync(REAL_GUARDS + '/pmm-migrate-v3.cjs', 'utf8');
if (migrateSrc.indexOf(RESTORE_NEEDLE) === -1) { console.error('FIXTURE STALE: restoreFiles NEEDLE not found verbatim in pmm-migrate-v3.cjs — update RESTORE_NEEDLE'); process.exit(1); }
migrateSrc = migrateSrc.replace(RESTORE_NEEDLE, RESTORE_CORRUPT);
fs.writeFileSync(TG + '/pmm-migrate-v3.cjs', migrateSrc);

const core = require(TG + '/pmm-core.cjs');
const migrate = require(TG + '/pmm-migrate-v3.cjs');

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
const lockFile = uniqueFiles[uniqueFiles.length - 1];

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
  out = execFileSync(process.execPath, [TG + '/pmm-migrate-v3.cjs', '--apply', '--dir', DIR, '--plan', planPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
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
if (rc === 2 && saysDistrust && !saysTrusted) {
  console.error('PASS: a genuinely corrupted rollback (restoreFiles writes wrong bytes but reports success) is still correctly distrusted.');
  process.exit(0);
}
console.error(`FAIL: expected rc=2 with "不得信任" and no "核实指纹相符" — got rc=${rc}, saysTrusted=${saysTrusted}, saysDistrust=${saysDistrust}`);
process.exit(1);
