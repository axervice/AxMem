#!/usr/bin/env node
// AxMem lifecycle restore — crash-consistent two-phase directory swap.
// (P1 2.3, 2026-09-16) NOT atomic (D7): the promise is "the next axmem
// command can resume or safely stop", never "concurrent readers never see
// a half state". Journal ALWAYS leads the filesystem by one step (spec
// §2.3 ⑤): write the target phase, THEN perform the rename it describes.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');
const lock = require('../lib/lock.cjs');
const tarSafety = require('./tar-safety.cjs');
const backup = require('./backup.cjs');

const RESTORE_LOCK_TIMEOUT_MS = 3000;

function fail(msg, code = 3) {
  console.error(`restore: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Tree identity: path manifest + per-file content sha256 (spec: "树身份 =
// 路径清单 + 每文件内容sha256"). Deliberately does NOT cover ACL/mode/owner/
// hardlink topology (README says so; see also builder report).
// ---------------------------------------------------------------------------
function computeTreeHash(dir) {
  if (!fs.existsSync(dir)) return null;
  // [LOW] Same warning as backup.cjs's own createBackup(): a symlink
  // inside the tree being hashed (current/prev/staging during a restore)
  // is silently excluded from the identity hash — surface that instead of
  // letting it pass unremarked.
  const rels = backup.listFilesRecursive(dir, dir, (full) => {
    console.error(`restore: warning — skipping symlink "${full}" when computing tree identity (never included in the hash)`);
  }).sort();
  const lines = rels.map((rel) => `${rel}\t${backup.sha256File(path.join(dir, ...rel.split('/')))}`);
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function treeMatches(dir, expectedHash) {
  if (expectedHash === null) return !fs.existsSync(dir);
  if (!fs.existsSync(dir)) return false;
  return computeTreeHash(dir) === expectedHash;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------
function journalDir(stateDir, txn) {
  return path.join(stateDir, 'restore', txn);
}
function journalPath(stateDir, txn) {
  return path.join(journalDir(stateDir, txn), 'journal.json');
}
function readJournal(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.txn && j.phase) return j;
    return null;
  } catch {
    return null; // missing / corrupt / truncated -> treated as "no journal" by callers, or a hard stop where the caller knows one MUST exist
  }
}
function writeJournalAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const staging = `${p}.axmem-staging-${process.pid}-${Date.now()}`;
  fs.writeFileSync(staging, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(staging, p);
}

// ---------------------------------------------------------------------------
// ① tar member validation + manifest presence/hash check
// ---------------------------------------------------------------------------
function validateArchive(tarPath) {
  const parsed = tarSafety.parseTar(tarPath);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const manifestMember = parsed.members.find((m) => m.name === 'manifest.json' && (m.typeflag === '0' || m.typeflag === '\0'));
  if (!manifestMember) return { ok: false, reason: 'archive has no manifest.json member (run migrate --backup first — bare tars predate the manifest requirement)' };
  return { ok: true, members: parsed.members };
}

// [codex(gf) MEDIUM #5, 2026-09-17] The regex for a manifest-declared
// sha256 field — must be exactly 64 lowercase hex chars, matching what
// crypto's 'hex' digest encoding actually produces (backup.cjs's own
// sha256File()). A field that's merely `typeof === 'string'` still lets
// through an empty string, a truncated hash, or arbitrary garbage that
// would never legitimately match a real digest anyway.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// Validates manifest.json's own SCHEMA — shape, version, per-file field
// types, size non-negativity, and no duplicate declared path — entirely
// independent of what's actually in the tar. Returns { ok, reason }.
function validateManifestSchema(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: 'manifest.json is not an object' };
  if (manifest.format_version !== backup.MANIFEST_FORMAT_VERSION) {
    return { ok: false, reason: `manifest.json format_version ${JSON.stringify(manifest.format_version)} != expected ${backup.MANIFEST_FORMAT_VERSION}` };
  }
  if (!Array.isArray(manifest.files)) return { ok: false, reason: 'manifest.json missing files[]' };
  if (!Number.isSafeInteger(manifest.member_count) || manifest.member_count < 0) {
    return { ok: false, reason: `manifest.json member_count is not a non-negative integer (${JSON.stringify(manifest.member_count)})` };
  }
  if (!Number.isSafeInteger(manifest.total_bytes) || manifest.total_bytes < 0) {
    return { ok: false, reason: `manifest.json total_bytes is not a non-negative integer (${JSON.stringify(manifest.total_bytes)})` };
  }
  const seenPaths = new Set();
  for (const f of manifest.files) {
    if (!f || typeof f !== 'object') return { ok: false, reason: 'manifest.json files[] contains a non-object entry' };
    if (typeof f.path !== 'string' || f.path.length === 0) return { ok: false, reason: `manifest.json files[] entry has an invalid path (${JSON.stringify(f.path)})` };
    if (typeof f.sha256 !== 'string' || !SHA256_HEX_RE.test(f.sha256)) return { ok: false, reason: `manifest.json entry "${f.path}" has an invalid sha256 field (${JSON.stringify(f.sha256)})` };
    if (!Number.isSafeInteger(f.size) || f.size < 0) return { ok: false, reason: `manifest.json entry "${f.path}" has an invalid size field (${JSON.stringify(f.size)})` };
    if (seenPaths.has(f.path)) return { ok: false, reason: `manifest.json lists "${f.path}" more than once` };
    seenPaths.add(f.path);
  }
  const recomputedBytes = manifest.files.reduce((n, f) => n + f.size, 0);
  if (manifest.member_count !== manifest.files.length) {
    return { ok: false, reason: `manifest.json member_count (${manifest.member_count}) != files[].length (${manifest.files.length})` };
  }
  if (manifest.total_bytes !== recomputedBytes) {
    return { ok: false, reason: `manifest.json total_bytes (${manifest.total_bytes}) != recomputed sum of files[].size (${recomputedBytes})` };
  }
  return { ok: true };
}

// Extracts the whole archive to `destDir` (already validated safe) using
// the real tar binary, then re-verifies EVERY manifest-listed file's
// sha256 against the extracted bytes before anything is trusted further.
//
// [codex(gf) MEDIUM #5, 2026-09-17] Previously only checked that every
// manifest-LISTED file was present with the right hash — nothing ever
// checked the OTHER direction: a tar containing an UNDECLARED regular
// member (present in the archive, absent from manifest.files) was
// extracted and left on disk right alongside the declared files, with
// zero signal that anything unaccounted-for had been restored.
// Reproduced directly: manifest declares only memory/decisions.md, tar
// also carries memory/extra.md -> {"undeclaredExtracted":true,
// "undeclaredRestored":"UNDECLARED\n"}. `tarMembers` (from
// validateArchive()'s own tarSafety.parseTar() call — already computed,
// never re-parsed here) is now REQUIRED so this function can do a strict
// 1:1 set comparison between the tar's actual regular members and the
// manifest's declared file list, in addition to validateManifestSchema()'s
// independent schema/version/field checks. Default is reject; pass
// `{ allowUnlisted: true }` (CLI: `restore --allow-unlisted <tar>`) to
// explicitly opt into keeping an undeclared file instead.
function extractAndVerify(tarPath, destDir, tarMembers, { allowUnlisted = false } = {}) {
  if (!Array.isArray(tarMembers)) return { ok: false, reason: 'extractAndVerify called without tarMembers (internal error — caller must pass validateArchive()\'s own parsed member list)' };
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync('tar', ['--force-local', '-xf', backup.toPosixTarPath(tarPath), '-C', backup.toPosixTarPath(destDir)], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    return { ok: false, reason: `tar extraction failed: ${e.message}` };
  }
  const manifestPath = path.join(destDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `cannot parse extracted manifest.json: ${e.message}` };
  }
  const schemaR = validateManifestSchema(manifest);
  if (!schemaR.ok) return { ok: false, reason: schemaR.reason };

  // Regular (non-directory) tar members other than manifest.json itself —
  // the actual content the archive is claiming to restore.
  const tarRegularPaths = tarMembers
    .filter((m) => (m.typeflag === '0' || m.typeflag === '\0') && m.name !== 'manifest.json')
    .map((m) => m.name);
  const manifestPathSet = new Set(manifest.files.map((f) => f.path));
  const tarPathSet = new Set(tarRegularPaths);

  const missing = [...manifestPathSet].filter((p) => !tarPathSet.has(p));
  if (missing.length) {
    return { ok: false, reason: `manifest.json declares member(s) not present in the tar: ${missing.join(', ')}` };
  }
  const undeclared = tarRegularPaths.filter((p) => !manifestPathSet.has(p));
  if (undeclared.length && !allowUnlisted) {
    return { ok: false, reason: `tar contains member(s) not listed in manifest.json: ${undeclared.join(', ')} (pass --allow-unlisted to accept anyway)` };
  }
  // With allowUnlisted, an undeclared member is accepted but the sets are
  // now KNOWN to differ (undeclared.length > 0) — count equality is only
  // asserted for the strict (default) path, where "same size, same
  // membership" was already just proven by the two set-difference checks
  // above (empty missing[] + empty undeclared[] already implies equal
  // counts; this exists purely as an explicit, independently-readable
  // assertion of that same fact, not a new constraint).
  if (!undeclared.length && tarRegularPaths.length !== manifest.files.length) {
    return { ok: false, reason: `tar contains ${tarRegularPaths.length} regular member(s) but manifest.json declares ${manifest.files.length} despite identical path sets — internal inconsistency (possible duplicate tar member)` };
  }

  for (const f of manifest.files) {
    const full = path.join(destDir, ...f.path.split('/'));
    let actual;
    try {
      actual = backup.sha256File(full);
    } catch (e) {
      return { ok: false, reason: `manifest lists "${f.path}" but it is missing after extraction: ${e.message}` };
    }
    if (actual !== f.sha256) return { ok: false, reason: `sha256 mismatch for "${f.path}" after extraction (manifest says ${f.sha256}, got ${actual})` };
  }
  return { ok: true, manifest };
}

// ---------------------------------------------------------------------------
// ② layout check
// ---------------------------------------------------------------------------
function isReparsePoint(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function layoutCheck(stateDir, memoryDir) {
  const realMem = (() => { try { return fs.realpathSync(memoryDir).toLowerCase(); } catch { return null; } })();
  const checkNotInsideMemory = (p, label) => {
    if (!realMem) return { ok: true };
    let real;
    try { real = fs.realpathSync(p).toLowerCase(); } catch { real = path.resolve(p).toLowerCase(); }
    if (real === realMem || real.startsWith(realMem + path.sep.toLowerCase()) || real.startsWith(realMem + '/')) {
      return { ok: false, reason: `${label} ("${p}") is inside the memory dir subtree — refusing (rc 3)` };
    }
    return { ok: true };
  };
  // [LOW] `memoryDir` (current_abs) ITSELF being a symlink/junction was
  // never checked here — only stateDir/staging/prev were. The whole
  // recovery matrix's tree-identity comparisons (computeTreeHash,
  // treeMatches) and the OLD_MOVED/NEW_MOVED renames assume current_abs
  // is a real directory whose rename actually moves content; renaming a
  // symlink instead silently relocates the LINK, not the target tree it
  // points at, which would desync every hash comparison this whole file
  // relies on. Checked separately from the "not inside memory dir
  // subtree" loop below (that check is meaningless applied to memoryDir
  // itself — a directory is trivially "inside" its own subtree).
  if (isReparsePoint(memoryDir)) return { ok: false, reason: `memoryDir (current_abs) ("${memoryDir}") is a symlink/junction — refusing (rc 3)` };

  for (const [p, label] of [[stateDir, 'AXMEM_STATE_DIR'], [path.join(stateDir, 'restore-staging'), 'staging'], [path.join(stateDir, 'restore-prev'), 'prev']]) {
    const r = checkNotInsideMemory(p, label);
    if (!r.ok) return r;
    if (isReparsePoint(p)) return { ok: false, reason: `${label} ("${p}") is a symlink/junction — refusing (rc 3)` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main restore flow (spec §2.3 ①-⑤)
// ---------------------------------------------------------------------------
function performRestore(tarPath, { stateDir, memoryDir, dryRun = false, allowUnlisted = false } = {}) {
  const av = validateArchive(tarPath);
  if (!av.ok) fail(`archive validation failed: ${av.reason}`);

  const layoutR = layoutCheck(stateDir, memoryDir);
  if (!layoutR.ok) fail(layoutR.reason);

  const txn = crypto.randomUUID();
  const stagingAbs = path.join(stateDir, 'restore-staging', txn);
  const ex = extractAndVerify(tarPath, stagingAbs, av.members, { allowUnlisted });
  if (!ex.ok) {
    try { fs.rmSync(stagingAbs, { recursive: true, force: true }); } catch { /* best-effort */ }
    fail(`extraction/verification failed: ${ex.reason}`);
  }

  if (dryRun) {
    try { fs.rmSync(stagingAbs, { recursive: true, force: true }); } catch { /* best-effort */ }
    console.log(`restore (dry-run): archive verified (${ex.manifest.member_count} files, ${ex.manifest.total_bytes} bytes) — no changes made`);
    process.exit(0);
  }

  // The archive's staged content sits at stagingAbs/<basename>; that's the
  // NEW memory dir content — move it up one level so stagingAbs IS the new
  // tree root the state machine moves into place.
  const basename = path.basename(memoryDir);
  const stagedMemory = path.join(stagingAbs, basename);
  if (!fs.existsSync(stagedMemory)) fail(`archive's top-level folder "${basename}" not found after extraction (memory dir basename mismatch)`);

  const lockPath = path.join(stateDir, 'restore.lock');
  const claim = lock.claimLock(lockPath, { timeoutMs: RESTORE_LOCK_TIMEOUT_MS });
  if (!claim.acquired) {
    try { fs.rmSync(stagingAbs, { recursive: true, force: true }); } catch { /* best-effort */ }
    fail('could not acquire restore.lock within the timeout — another restore may be in progress, or its owner cannot be proven dead (manual steps: inspect AXMEM_STATE_DIR/restore.lock/owner.json)');
  }

  try {
    const oldTreeHash = computeTreeHash(memoryDir);
    const newTreeHash = computeTreeHash(stagedMemory);
    const prevAbs = path.join(stateDir, 'restore-prev', txn);

    const j = {
      txn, phase: 'PREPARED',
      current_abs: memoryDir, prev_abs: prevAbs, staging_abs: stagedMemory,
      old_tree_hash: oldTreeHash, new_tree_hash: newTreeHash,
      nonce: claim.nonce, ts: new Date().toISOString(),
    };
    writeJournalAtomic(journalPath(stateDir, txn), j);

    const result = advanceStateMachine(stateDir, j, claim.nonce);
    return result;
  } finally {
    // advanceStateMachine releases the lock itself on COMMITTED; if it
    // stopped early (fenced abort, or an intermediate phase left for
    // startup recovery to continue) the lock stays held so the NEXT
    // recovery pass can fence-check it — never release out from under an
    // in-progress transaction just because this call is returning.
  }
}

// Drives PREPARED -> OLD_MOVED -> NEW_MOVED -> COMMITTED from whatever
// phase `j` is currently at, fencing before every critical write.
// onAfterJournalWrite: test-only hook (never passed by any real call site
// below), invoked right after each phase's writeJournalAtomic() call,
// before the second fence check that follows it. Exists solely so a
// self-test can inject an owner.json replacement into the EXACT window
// codex(gf) MEDIUM #4 identified — journal published, rename not yet
// attempted — since that window is otherwise a synchronous, un-hookable
// gap between two statements in the same call stack.
function advanceStateMachine(stateDir, j, nonce, onAfterJournalWrite) {
  const lockPath = path.join(stateDir, 'restore.lock');
  const jPath = journalPath(stateDir, j.txn);
  const afterJournal = typeof onAfterJournalWrite === 'function' ? onAfterJournalWrite : () => {};

  function fenceOrAbort() {
    if (!lock.fenceCheck(lockPath, nonce)) {
      console.error(`restore: lock-fenced-abort — owner.json no longer matches our nonce before a critical write (txn ${j.txn}); journal left in place for manual inspection`);
      return false;
    }
    return true;
  }

  if (j.phase === 'PREPARED') {
    if (!fenceOrAbort()) return { ok: false, reason: 'lock-fenced-abort' };
    j.phase = 'OLD_MOVED';
    writeJournalAtomic(jPath, j); // journal leads: write phase BEFORE the rename
    afterJournal('PREPARED->OLD_MOVED');
    // [codex(gf) MEDIUM #4, 2026-09-17] The single fenceOrAbort() above
    // only proves ownership at PHASE ENTRY — writeJournalAtomic() is a
    // real disk write that takes real time, during which a reclaim can
    // legitimately republish the lock with a different nonce. Without a
    // SECOND check here, immediately before the actual irreversible
    // rename, a holder that lost ownership during that window still
    // performed the rename anyway (reproduced directly: owner replaced
    // right after the journal's atomic rename completed ->
    // {"ownerReplacedImmediatelyAfterJournalRename":true,"oldWasMovedDespiteLostFence":true}).
    // Aborting here WITHOUT renaming is safe even though the journal
    // already claims OLD_MOVED: current_abs is untouched, so a later
    // resumption's own OLD_MOVED block will attempt staging_abs ->
    // current_abs onto a still-non-empty target and fail cleanly via its
    // own try/catch (ENOTEMPTY/EEXIST) rather than silently completing a
    // transition an unfenced holder was never authorized to make.
    if (!fenceOrAbort()) return { ok: false, reason: 'lock-fenced-abort' };
    try {
      fs.mkdirSync(path.dirname(j.prev_abs), { recursive: true });
      fs.renameSync(j.current_abs, j.prev_abs);
    } catch (e) {
      return { ok: false, reason: `OLD_MOVED rename failed: ${e.message}` };
    }
  }

  if (j.phase === 'OLD_MOVED') {
    if (!fenceOrAbort()) return { ok: false, reason: 'lock-fenced-abort' };
    j.phase = 'NEW_MOVED';
    writeJournalAtomic(jPath, j);
    afterJournal('OLD_MOVED->NEW_MOVED');
    // [codex(gf) MEDIUM #4] Same gap, same fix: re-fence immediately
    // before this rename too, not just once at phase entry.
    if (!fenceOrAbort()) return { ok: false, reason: 'lock-fenced-abort' };
    try {
      fs.renameSync(j.staging_abs, j.current_abs);
    } catch (e) {
      return { ok: false, reason: `NEW_MOVED rename failed: ${e.message}` };
    }
  }

  if (j.phase === 'NEW_MOVED') {
    if (!fenceOrAbort()) return { ok: false, reason: 'lock-fenced-abort' };
    j.phase = 'COMMITTED';
    writeJournalAtomic(jPath, j);
  }

  if (j.phase === 'COMMITTED') {
    try { fs.rmSync(path.dirname(jPath), { recursive: true, force: true }); } catch { /* best-effort */ }
    lock.releaseLock(lockPath, nonce);
    console.log(`restore: committed (txn ${j.txn}). Previous tree preserved at ${j.prev_abs} — delete it manually when you're satisfied (D7: prev is never auto-deleted).`);
    return { ok: true };
  }

  return { ok: false, reason: `unexpected terminal phase ${j.phase}` };
}

// ---------------------------------------------------------------------------
// Pure recovery-matrix classifier (spec §2.3 ⑥ table). Takes SYMBOLIC state
// values only — no filesystem access — so it can be exhaustively enumerated
// by a self-test proving "any (phase, current, prev, staging) combination
// hits at most one row" without touching a single real file.
//   cur     ∈ {'old', 'new', 'absent', 'other'}
//   prev    ∈ {'old', 'absent', 'other'}          (prev is never 'new')
//   staging ∈ {'new', 'absent', 'other'}          (staging is never 'old')
// Returns one row id string. This is the SINGLE source of truth for the
// table — recoverOnStartup() below only translates row ids into actions,
// it never re-derives the conditions itself, so the classifier and the
// exhaustiveness proof can never drift from what actually runs.
// ---------------------------------------------------------------------------
function classifyRecoveryRow(phase, cur, prev, staging) {
  // Row 10 (spec table, last row): for the three in-flight phases, "current
  // matches neither old nor new" means the user changed it out from under
  // the restore — stop unconditionally, independent of prev/staging. Named
  // distinctly from the generic OUTSIDE_MATRIX_STOP catch-all (which means
  // "no spec row matches at all") so the two are never conflated: this row
  // DOES exist in the table, it just always means "stop".
  if ((phase === 'PREPARED' || phase === 'OLD_MOVED' || phase === 'NEW_MOVED') && cur === 'other') {
    return 'USER_MODIFIED_STOP';
  }
  if (phase === 'PREPARED') {
    if (cur === 'old' && prev === 'absent' && staging === 'new') return 'PREPARED_CONTINUE';
    if (cur === 'old' && prev === 'absent' && staging !== 'new') return 'PREPARED_ROLLBACK';
    return 'OUTSIDE_MATRIX_STOP';
  }
  if (phase === 'OLD_MOVED') {
    if (cur === 'old' && prev === 'absent' && staging === 'new') return 'OLD_MOVED_AS_PREPARED';
    if (cur === 'absent' && prev === 'old' && staging === 'new') return 'OLD_MOVED_CONTINUE';
    if (cur === 'absent' && prev === 'old' && staging !== 'new') return 'OLD_MOVED_ROLLBACK';
    return 'OUTSIDE_MATRIX_STOP';
  }
  if (phase === 'NEW_MOVED') {
    if (cur === 'absent' && prev === 'old' && staging === 'new') return 'NEW_MOVED_CONTINUE';
    if (cur === 'new' && prev === 'old' && staging === 'absent') return 'NEW_MOVED_FINISH';
    return 'OUTSIDE_MATRIX_STOP';
  }
  if (phase === 'COMMITTED') {
    if (cur === 'new' && staging === 'absent') return 'COMMITTED_CLEANUP'; // prev is "任意" per spec table — deliberately not checked; staging must be 无
    if (cur !== 'new') return 'COMMITTED_STOP'; // row 9: current != new (or absent/other)
    return 'OUTSIDE_MATRIX_STOP'; // cur === new but staging still present — not row 8, not row 9, outside the table
  }
  return 'OUTSIDE_MATRIX_STOP'; // unknown phase string
}

// ---------------------------------------------------------------------------
// ⑥ Startup recovery matrix — call at the start of EVERY axmem command.
// Table rows are mutually exclusive predicates over (phase, current state
// vs old/new, prev state vs old, staging state vs new). Returns:
//   { action: 'none' }                    — no journal, nothing to do
//   { action: 'continued', ok }           — resumed and drove to a result
//   { action: 'rolled-back' }
//   { action: 'stopped', reason }         — rc 3, journal/state left as-is
// ---------------------------------------------------------------------------
function symbolicState(currentPath, oldHash, newHash) {
  if (!fs.existsSync(currentPath)) return 'absent';
  if (treeMatches(currentPath, oldHash)) return 'old';
  if (treeMatches(currentPath, newHash)) return 'new';
  return 'other';
}

function recoverOnStartup(stateDir) {
  const restoreRoot = path.join(stateDir, 'restore');
  let txns = [];
  try { txns = fs.readdirSync(restoreRoot); } catch { return { action: 'none' }; }
  if (txns.length === 0) return { action: 'none' };
  // [LOW] P1 scope is one in-flight restore transaction at a time (the
  // lock already enforces this in the normal path) — but silently picking
  // txns[0] when more than one transaction directory somehow exists on
  // disk (e.g. two restores raced past the lock during a bug, or leftover
  // state was hand-copied between machines) would arbitrarily recover ONE
  // of them and leave the other's journal/staging/prev untouched with no
  // indication anything was skipped. Stop explicitly instead of guessing
  // which one matters.
  if (txns.length > 1) {
    return { action: 'stopped', reason: `${txns.length} in-flight restore transactions found under "${restoreRoot}" (expected at most 1) — refusing to guess which to recover; manual steps: inspect each txn's journal.json and remove/resolve all but one, then retry` };
  }
  const txn = txns[0];
  const jPath = journalPath(stateDir, txn);
  const j = readJournal(jPath);
  if (!j) {
    // Journal directory exists but journal.json is missing/corrupt/
    // truncated — spec: "journal 半写（截断）⇒ 停止 rc 3".
    return { action: 'stopped', reason: `journal for txn ${txn} is missing or unreadable — stop, rc 3, left for manual inspection` };
  }

  const cur = symbolicState(j.current_abs, j.old_tree_hash, j.new_tree_hash);
  const prev = fs.existsSync(j.prev_abs) ? (treeMatches(j.prev_abs, j.old_tree_hash) ? 'old' : 'other') : 'absent';
  const staging = fs.existsSync(j.staging_abs) ? (treeMatches(j.staging_abs, j.new_tree_hash) ? 'new' : 'other') : 'absent';

  const row = classifyRecoveryRow(j.phase, cur, prev, staging);
  const lockPath = path.join(stateDir, 'restore.lock');

  function continueFrom(phaseOverride) {
    const claim = lock.claimLock(lockPath, { timeoutMs: RESTORE_LOCK_TIMEOUT_MS });
    if (!claim.acquired) return { action: 'stopped', reason: `could not reclaim restore.lock to continue ${j.phase} (row ${row})` };
    const r = advanceStateMachine(stateDir, phaseOverride ? { ...j, phase: phaseOverride } : j, claim.nonce);
    return { action: 'continued', ok: r.ok, detail: r.reason };
  }

  switch (row) {
    case 'PREPARED_CONTINUE':
      return continueFrom();
    case 'PREPARED_ROLLBACK':
      try { fs.rmSync(j.staging_abs, { recursive: true, force: true }); } catch { /* best-effort */ }
      try { fs.rmSync(path.dirname(jPath), { recursive: true, force: true }); } catch { /* best-effort */ }
      return { action: 'rolled-back' };
    case 'OLD_MOVED_AS_PREPARED':
      return continueFrom('PREPARED');
    case 'OLD_MOVED_CONTINUE':
      return continueFrom();
    case 'OLD_MOVED_ROLLBACK':
      try { fs.renameSync(j.prev_abs, j.current_abs); } catch (e) { return { action: 'stopped', reason: `rollback rename prev->current failed: ${e.message}` }; }
      try { fs.rmSync(path.dirname(jPath), { recursive: true, force: true }); } catch { /* best-effort */ }
      return { action: 'rolled-back' };
    case 'NEW_MOVED_CONTINUE':
      // [ts H2] The journal claims NEW_MOVED (implying staging->current was
      // already renamed), but the filesystem says otherwise: current is
      // absent and staging still holds the new content, meaning the
      // process crashed AFTER writing phase=NEW_MOVED but BEFORE actually
      // performing that rename (journal-leads-filesystem gap, spec §2.3
      // ⑤). Re-entering at 'OLD_MOVED' (not the unchanged 'NEW_MOVED')
      // makes advanceStateMachine's OLD_MOVED block run and perform the
      // still-pending staging->current rename before falling through to
      // NEW_MOVED/COMMITTED — plain continueFrom() would skip straight to
      // the NEW_MOVED block (which does no renaming, only a phase bump)
      // and silently mark the transaction COMMITTED while current_abs
      // stayed absent: a silent, confirmed-successful data loss.
      return continueFrom('OLD_MOVED');
    case 'NEW_MOVED_FINISH':
      return continueFrom();
    case 'COMMITTED_CLEANUP':
      try { fs.rmSync(path.dirname(jPath), { recursive: true, force: true }); } catch { /* best-effort */ }
      lock.releaseLock(lockPath, j.nonce);
      return { action: 'rolled-back' }; // reusing the shape: "finished cleanup"
    case 'COMMITTED_STOP':
      return { action: 'stopped', reason: 'COMMITTED but current does not match the new tree — stop, rc 3, journal kept for manual inspection (not a silent finish)' };
    case 'USER_MODIFIED_STOP':
      return { action: 'stopped', reason: `${j.phase}: current tree matches neither old nor new — the user changed it mid-restore — stop, rc 3, two-sided preservation` };
    default: // OUTSIDE_MATRIX_STOP
      return { action: 'stopped', reason: `${j.phase}: (current=${cur}, prev=${prev}, staging=${staging}) is outside the recovery matrix — stop, rc 3, two-sided preservation` };
  }
}

// [ts H1] Thin, unit-testable wrapper around performRestore() for the CLI
// `restore` subcommand. Previously the CLI branch called performRestore()
// and threw its return value away entirely: performRestore() itself
// process.exit()s on every validation failure (bad archive, layout,
// lock-timeout), but advanceStateMachine() can also return a plain
// {ok:false, reason} object (a rename failure or a lock-fenced-abort)
// WITHOUT ever calling process.exit — that path silently fell through to
// the end of the script and exited 0, reporting success on a restore that
// actually failed partway through. Extracted to a function (rather than
// inlined in the `require.main` block) specifically so a monkey-patched
// fs.renameSync failure can be asserted against a real return code in the
// self-test below, without spawning a child process.
function cliRestore(tarPath, { stateDir, memoryDir, dryRun, allowUnlisted } = {}) {
  if (!tarPath) {
    console.error('usage: node restore.cjs restore <backup.tar> [--dry-run] [--allow-unlisted]');
    return 1;
  }
  const result = performRestore(tarPath, { stateDir, memoryDir, dryRun, allowUnlisted });
  // dryRun exits(0) from inside performRestore itself and never returns
  // here; every non-dry-run success path returns {ok:true}.
  if (result && result.ok === false) {
    console.error(`restore: ${result.reason}`);
    return 3;
  }
  return 0;
}

module.exports = {
  computeTreeHash,
  treeMatches,
  readJournal,
  writeJournalAtomic,
  journalPath,
  journalDir,
  validateArchive,
  extractAndVerify,
  layoutCheck,
  performRestore,
  advanceStateMachine,
  recoverOnStartup,
  classifyRecoveryRow,
  symbolicState,
  cliRestore,
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function selfTest() {
  let ok = 0;
  const results = [];
  function check(name, cond) { if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); } }

  // ─── Exhaustive matrix mutual-exclusivity proof (spec §2.3, mandatory) ───
  // Independently transcribed row predicates (literal spec table text, NOT
  // the classifyRecoveryRow implementation) — proves the TABLE ITSELF is
  // non-overlapping, not merely that an if/else chain returns one value.
  {
    const PHASES = ['PREPARED', 'OLD_MOVED', 'NEW_MOVED', 'COMMITTED'];
    const CUR = ['old', 'new', 'absent', 'other'];
    const PREV = ['old', 'absent', 'other'];
    const STAGING = ['new', 'absent', 'other'];
    const rowPredicates = [
      (p, c, pr, s) => p === 'PREPARED' && c === 'old' && pr === 'absent' && s === 'new',
      (p, c, pr, s) => p === 'PREPARED' && c === 'old' && pr === 'absent' && s !== 'new',
      (p, c, pr, s) => p === 'OLD_MOVED' && c === 'old' && pr === 'absent' && s === 'new',
      (p, c, pr, s) => p === 'OLD_MOVED' && c === 'absent' && pr === 'old' && s === 'new',
      (p, c, pr, s) => p === 'OLD_MOVED' && c === 'absent' && pr === 'old' && s !== 'new',
      (p, c, pr, s) => p === 'NEW_MOVED' && c === 'absent' && pr === 'old' && s === 'new',
      (p, c, pr, s) => p === 'NEW_MOVED' && c === 'new' && pr === 'old' && s === 'absent',
      (p, c, pr, s) => p === 'COMMITTED' && c === 'new' && s === 'absent', // prev "任意" — deliberately excluded
      (p, c, pr, s) => p === 'COMMITTED' && c !== 'new',
      (p, c, pr, s) => ['PREPARED', 'OLD_MOVED', 'NEW_MOVED'].includes(p) && c === 'other',
    ];
    let combos = 0;
    let maxHits = 0;
    let overlapExamples = [];
    let classifierAgrees = true;
    const namedRows = ['PREPARED_CONTINUE', 'PREPARED_ROLLBACK', 'OLD_MOVED_AS_PREPARED', 'OLD_MOVED_CONTINUE', 'OLD_MOVED_ROLLBACK', 'NEW_MOVED_CONTINUE', 'NEW_MOVED_FINISH', 'COMMITTED_CLEANUP', 'COMMITTED_STOP', 'USER_MODIFIED_STOP'];
    for (const p of PHASES) {
      for (const c of CUR) {
        for (const pr of PREV) {
          for (const s of STAGING) {
            combos++;
            const hits = rowPredicates.map((fn) => fn(p, c, pr, s)).filter(Boolean).length;
            if (hits > maxHits) maxHits = hits;
            if (hits > 1) overlapExamples.push({ p, c, pr, s, hits });
            const row = classifyRecoveryRow(p, c, pr, s);
            const predictedNamed = hits === 1; // exactly one literal row predicate fired
            const classifierNamed = namedRows.includes(row);
            if (predictedNamed !== classifierNamed) classifierAgrees = false;
          }
        }
      }
    }
    check(`matrix exhaustive: ${combos} combinations, max hits per combo = ${maxHits} (must be <= 1)`, combos === 144 && maxHits <= 1 && overlapExamples.length === 0);
    check('matrix exhaustive: classifyRecoveryRow agrees with the independent literal predicates on every combination', classifierAgrees);
  }

  const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-restore-selftest-'));

  function freshMemDir(name, files) {
    const d = path.join(T, name);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(d, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return d;
  }

  // 1. Full round trip: backup -> restore -> current tree matches the backup exactly
  {
    const stateDir = path.join(T, 's1');
    const memDir = freshMemDir('mem1', { 'decisions.md': 'v1\n', 'lessons.md': 'l1\n' });
    const tarPath = path.join(T, 'b1.tar');
    backup.createBackup(memDir, tarPath);
    fs.writeFileSync(path.join(memDir, 'decisions.md'), 'CHANGED AFTER BACKUP\n');
    const before = computeTreeHash(memDir);
    performRestore(tarPath, { stateDir, memoryDir: memDir });
    const restoredContent = fs.readFileSync(path.join(memDir, 'decisions.md'), 'utf8');
    check('1 round trip: backup -> mutate -> restore -> content matches the backup, not the mutation', restoredContent === 'v1\n' && computeTreeHash(memDir) !== before);
  }

  // 2. prev is preserved (never auto-deleted) after a commit
  {
    const stateDir = path.join(T, 's2');
    const memDir = freshMemDir('mem2', { 'decisions.md': 'v1\n' });
    const tarPath = path.join(T, 'b2.tar');
    backup.createBackup(memDir, tarPath);
    fs.writeFileSync(path.join(memDir, 'decisions.md'), 'v2\n');
    performRestore(tarPath, { stateDir, memoryDir: memDir });
    const prevDirs = fs.existsSync(path.join(stateDir, 'restore-prev')) ? fs.readdirSync(path.join(stateDir, 'restore-prev')) : [];
    let prevHasV2 = false;
    for (const d of prevDirs) {
      const f = path.join(stateDir, 'restore-prev', d, 'decisions.md');
      if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === 'v2\n') prevHasV2 = true;
    }
    check('2 prev tree preserved (never auto-deleted), holds the pre-restore content', prevHasV2);
  }

  // 3. rc 3 refusal on a malicious tar (path traversal), current tree unchanged
  {
    const stateDir = path.join(T, 's3');
    const memDir = freshMemDir('mem3', { 'decisions.md': 'safe\n' });
    const evilTar = path.join(T, 'evil.tar');
    // Hand-build a minimal malicious tar reusing tar-safety's own test helper shape.
    const h = Buffer.alloc(512);
    h.write('../../evil.txt', 0, 100, 'utf8');
    h.write('0644000\0', 100, 8, 'latin1');
    h.write('0000000\0', 108, 8, 'latin1');
    h.write('0000000\0', 116, 8, 'latin1');
    h.write('00000000000\0', 124, 12, 'latin1');
    h.write('00000000000\0', 136, 12, 'latin1');
    h.write('        ', 148, 8, 'latin1');
    h.write('0', 156, 1, 'latin1');
    h.write('ustar\0', 257, 6, 'latin1');
    h.write('00', 263, 2, 'latin1');
    fs.writeFileSync(evilTar, Buffer.concat([h, Buffer.alloc(1024)]));
    let threw = false;
    const origExit = process.exit;
    process.exit = (code) => { throw { __exitCode: code }; };
    try { performRestore(evilTar, { stateDir, memoryDir: memDir }); } catch (e) { threw = e && e.__exitCode === 3; }
    process.exit = origExit;
    check('3 malicious tar (path traversal) refused rc 3, current tree unchanged', threw && fs.readFileSync(path.join(memDir, 'decisions.md'), 'utf8') === 'safe\n');
  }

  // 4. no manifest.json in the tar -> refused
  {
    const stateDir = path.join(T, 's4');
    const memDir = freshMemDir('mem4', { 'decisions.md': 'safe\n' });
    const bareTar = path.join(T, 'bare.tar');
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));
    fs.mkdirSync(path.join(stagingDir, 'mem4'));
    fs.writeFileSync(path.join(stagingDir, 'mem4', 'decisions.md'), 'x\n');
    execFileSync('tar', ['--force-local', '-cf', backup.toPosixTarPath(bareTar), '-C', backup.toPosixTarPath(stagingDir), 'mem4']);
    const av = validateArchive(bareTar);
    check('4 bare tar (no manifest.json) refused', av.ok === false && /manifest\.json/.test(av.reason));
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  // 5. layoutCheck rejects a state dir nested inside the memory dir
  {
    const memDir = freshMemDir('mem5', { 'decisions.md': 'x\n' });
    const nestedState = path.join(memDir, 'state');
    const r = layoutCheck(nestedState, memDir);
    check('5 layoutCheck rejects state dir nested inside memory dir', r.ok === false);
  }

  // 6. fencing: advanceStateMachine aborts if owner.json is replaced between phases
  {
    const stateDir = path.join(T, 's6');
    const memDir = freshMemDir('mem6', { 'decisions.md': 'v1\n' });
    const stagingMem = freshMemDir('mem6-staging', { 'decisions.md': 'v2\n' });
    const lockPath = path.join(stateDir, 'restore.lock');
    const claim = lock.claimLock(lockPath, { timeoutMs: 1000 });
    const j = {
      txn: 'fence-test', phase: 'PREPARED',
      current_abs: memDir, prev_abs: path.join(stateDir, 'restore-prev', 'fence-test'), staging_abs: stagingMem,
      old_tree_hash: computeTreeHash(memDir), new_tree_hash: computeTreeHash(stagingMem),
      nonce: claim.nonce, ts: new Date().toISOString(),
    };
    // externally replace the owner (simulating a reclaim racing in)
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999, host: require('os').hostname(), nonce: 'someone-else' }));
    const r = advanceStateMachine(stateDir, j, claim.nonce);
    check('6 fencing aborts advanceStateMachine when owner.json was externally replaced', r.ok === false && r.reason === 'lock-fenced-abort' && fs.readFileSync(path.join(memDir, 'decisions.md'), 'utf8') === 'v1\n');
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 6b (codex(gf) MEDIUM #4). The single fenceOrAbort() test 6 exercises
  // only proves the CHECK AT PHASE ENTRY catches an already-replaced
  // owner — it never puts anything between the journal write and the
  // rename, so it can't prove the gap codex found even exists. Uses the
  // onAfterJournalWrite test hook to replace owner.json in the EXACT
  // window between "journal now says OLD_MOVED" and "the current_abs ->
  // prev_abs rename actually runs", then asserts the rename did NOT
  // happen despite the journal already claiming it should have.
  {
    const stateDir = path.join(T, 's6b');
    const memDir = freshMemDir('mem6b', { 'decisions.md': 'v1\n' });
    const stagingMem = freshMemDir('mem6b-staging', { 'decisions.md': 'v2\n' });
    const lockPath = path.join(stateDir, 'restore.lock');
    const claim = lock.claimLock(lockPath, { timeoutMs: 1000 });
    const j = {
      txn: 'fence-gap-test', phase: 'PREPARED',
      current_abs: memDir, prev_abs: path.join(stateDir, 'restore-prev', 'fence-gap-test'), staging_abs: stagingMem,
      old_tree_hash: computeTreeHash(memDir), new_tree_hash: computeTreeHash(stagingMem),
      nonce: claim.nonce, ts: new Date().toISOString(),
    };
    const r = advanceStateMachine(stateDir, j, claim.nonce, (point) => {
      if (point === 'PREPARED->OLD_MOVED') {
        // Simulating a reclaim that raced in and republished the lock
        // with a DIFFERENT nonce immediately after the journal's own
        // atomic rename completed, but before advanceStateMachine got a
        // chance to attempt the current_abs -> prev_abs rename.
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999, host: require('os').hostname(), nonce: 'someone-else' }));
      }
    });
    const currentUntouched = fs.existsSync(memDir) && fs.readFileSync(path.join(memDir, 'decisions.md'), 'utf8') === 'v1\n';
    const prevNeverCreated = !fs.existsSync(j.prev_abs);
    check(
      '6b (codex(gf) MEDIUM #4) owner replaced in the window between journal write and rename -> aborts BEFORE the rename, current tree untouched (not "oldWasMovedDespiteLostFence")',
      r.ok === false && r.reason === 'lock-fenced-abort' && currentUntouched && prevNeverCreated
    );
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 7. recoverOnStartup with no journal at all -> action 'none'
  {
    const stateDir = path.join(T, 's7-empty');
    fs.mkdirSync(stateDir, { recursive: true });
    const r = recoverOnStartup(stateDir);
    check('7 recoverOnStartup with no journal -> none', r.action === 'none');
  }

  // 8. recoverOnStartup resumes a PREPARED journal left mid-flight (simulating a crash right after journal write, before the OLD_MOVED rename)
  {
    const stateDir = path.join(T, 's8');
    const memDir = freshMemDir('mem8', { 'decisions.md': 'v1\n' });
    const tarPath = path.join(T, 'b8.tar');
    backup.createBackup(memDir, tarPath);
    fs.writeFileSync(path.join(memDir, 'decisions.md'), 'v1\n'); // unchanged, this IS old
    const stagingMem = freshMemDir('mem8-staging', { 'decisions.md': 'v2\n' });
    const claim = lock.claimLock(path.join(stateDir, 'restore.lock'), { timeoutMs: 1000 });
    const j = {
      txn: 'crash-test', phase: 'PREPARED',
      current_abs: memDir, prev_abs: path.join(stateDir, 'restore-prev', 'crash-test'), staging_abs: stagingMem,
      old_tree_hash: computeTreeHash(memDir), new_tree_hash: computeTreeHash(stagingMem),
      nonce: claim.nonce, ts: new Date().toISOString(),
    };
    writeJournalAtomic(journalPath(stateDir, 'crash-test'), j);
    lock.releaseLock(path.join(stateDir, 'restore.lock'), claim.nonce); // simulate the crashed process having released nothing, but for the test we need the lock free for recovery to reclaim it fresh — a REAL crash leaves it held by a dead pid, covered by lock.cjs's own dead-owner tests
    const r = recoverOnStartup(stateDir);
    const finalContent = fs.existsSync(path.join(memDir, 'decisions.md')) ? fs.readFileSync(path.join(memDir, 'decisions.md'), 'utf8') : null;
    check('8 recoverOnStartup resumes a PREPARED journal to completion', r.action === 'continued' && r.ok && finalContent === 'v2\n');
  }

  // 9 (ts H1): cliRestore() must surface a non-exit {ok:false} from
  // performRestore/advanceStateMachine as rc 3, never silently rc 0.
  {
    const stateDir = path.join(T, 's9');
    const memDir = freshMemDir('mem9', { 'decisions.md': 'v1\n' });
    const tarPath = path.join(T, 'b9.tar');
    backup.createBackup(memDir, tarPath);
    const origRename = fs.renameSync;
    // Target specifically the OLD_MOVED rename (current_abs -> prev_abs)
    // inside advanceStateMachine -- NOT the first fs.renameSync call
    // overall, since lock.claimLock() and writeJournalAtomic() both do
    // their own unrelated renames earlier in the same call chain.
    fs.renameSync = (...args) => {
      if (args[0] === memDir) throw new Error('injected rename failure (ts H1 test)');
      return origRename(...args);
    };
    let rc;
    try {
      rc = cliRestore(tarPath, { stateDir, memoryDir: memDir, dryRun: false });
    } finally {
      fs.renameSync = origRename;
    }
    check('9 (ts H1) cliRestore returns rc 3 when advanceStateMachine reports ok:false (injected renameSync failure), never a silent rc 0', rc === 3 && fs.readFileSync(path.join(memDir, 'decisions.md'), 'utf8') === 'v1\n');
  }

  // 10.x (ts H2): every named row of the spec §2.3 recovery matrix gets a
  // REAL filesystem-action assertion — inject that row's exact
  // (phase, current, prev, staging) state as real files + a real journal,
  // run the real recoverOnStartup(), and assert the resulting directory
  // tree (not just the returned action label). The exhaustive-predicate
  // proof at the top of this file only proves the TABLE's cells never
  // overlap; it says nothing about whether recoverOnStartup's actions for
  // a given row actually produce correct bytes on disk — that gap is
  // exactly what let the NEW_MOVED_CONTINUE bug above ship unnoticed.
  {
    const OLD_CONTENT = 'OLD-CONTENT-v1\n';
    const NEW_CONTENT = 'NEW-CONTENT-v2\n';
    const OTHER_CONTENT = 'OTHER-UNEXPECTED-CONTENT\n';

    function mkTree(dir, content) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'decisions.md'), content);
    }
    function readTree(dir) {
      try { return fs.readFileSync(path.join(dir, 'decisions.md'), 'utf8'); } catch { return null; }
    }

    function setupRow(name, { phase, cur, prev, staging }) {
      const stateDir = path.join(T, `row-${name}`);
      const memDir = path.join(T, `row-${name}-mem`);
      fs.mkdirSync(stateDir, { recursive: true });

      const oldRef = path.join(T, `row-${name}-oldref`);
      const newRef = path.join(T, `row-${name}-newref`);
      mkTree(oldRef, OLD_CONTENT);
      mkTree(newRef, NEW_CONTENT);
      const oldHash = computeTreeHash(oldRef);
      const newHash = computeTreeHash(newRef);

      if (cur === 'old') mkTree(memDir, OLD_CONTENT);
      else if (cur === 'new') mkTree(memDir, NEW_CONTENT);
      else if (cur === 'other') mkTree(memDir, OTHER_CONTENT);
      // cur === 'absent' -> leave memDir uncreated

      const prevAbs = path.join(stateDir, 'restore-prev', 'row-txn');
      if (prev === 'old') mkTree(prevAbs, OLD_CONTENT);
      else if (prev === 'other') mkTree(prevAbs, OTHER_CONTENT);

      const stagingAbs = path.join(stateDir, 'restore-staging', 'row-txn');
      if (staging === 'new') mkTree(stagingAbs, NEW_CONTENT);
      else if (staging === 'other') mkTree(stagingAbs, OTHER_CONTENT);

      const claim = lock.claimLock(path.join(stateDir, 'restore.lock'), { timeoutMs: 1000 });
      const j = {
        txn: 'row-txn', phase,
        current_abs: memDir, prev_abs: prevAbs, staging_abs: stagingAbs,
        old_tree_hash: oldHash, new_tree_hash: newHash,
        nonce: claim.nonce, ts: new Date().toISOString(),
      };
      writeJournalAtomic(journalPath(stateDir, 'row-txn'), j);
      return { stateDir, memDir, prevAbs, stagingAbs, claim };
    }

    const rows = [
      {
        name: 'PREPARED_CONTINUE', phase: 'PREPARED', cur: 'old', prev: 'absent', staging: 'new',
        releaseLockFirst: true, expectAction: 'continued', expectOk: true,
        expect: (p) => readTree(p.memDir) === NEW_CONTENT && readTree(p.prevAbs) === OLD_CONTENT && !fs.existsSync(p.stagingAbs),
      },
      {
        name: 'PREPARED_ROLLBACK', phase: 'PREPARED', cur: 'old', prev: 'absent', staging: 'other',
        releaseLockFirst: false, expectAction: 'rolled-back',
        expect: (p) => readTree(p.memDir) === OLD_CONTENT && !fs.existsSync(p.stagingAbs),
      },
      {
        name: 'OLD_MOVED_AS_PREPARED', phase: 'OLD_MOVED', cur: 'old', prev: 'absent', staging: 'new',
        releaseLockFirst: true, expectAction: 'continued', expectOk: true,
        expect: (p) => readTree(p.memDir) === NEW_CONTENT && readTree(p.prevAbs) === OLD_CONTENT && !fs.existsSync(p.stagingAbs),
      },
      {
        name: 'OLD_MOVED_CONTINUE', phase: 'OLD_MOVED', cur: 'absent', prev: 'old', staging: 'new',
        releaseLockFirst: true, expectAction: 'continued', expectOk: true,
        expect: (p) => readTree(p.memDir) === NEW_CONTENT && readTree(p.prevAbs) === OLD_CONTENT && !fs.existsSync(p.stagingAbs),
      },
      {
        name: 'OLD_MOVED_ROLLBACK', phase: 'OLD_MOVED', cur: 'absent', prev: 'old', staging: 'other',
        releaseLockFirst: false, expectAction: 'rolled-back',
        expect: (p) => readTree(p.memDir) === OLD_CONTENT && !fs.existsSync(p.prevAbs),
      },
      {
        // [ts H2] the fixed row: real filesystem proof that the
        // pending staging->current rename actually happens, not just
        // that the journal gets marked COMMITTED.
        name: 'NEW_MOVED_CONTINUE', phase: 'NEW_MOVED', cur: 'absent', prev: 'old', staging: 'new',
        releaseLockFirst: true, expectAction: 'continued', expectOk: true,
        expect: (p) => readTree(p.memDir) === NEW_CONTENT && readTree(p.prevAbs) === OLD_CONTENT && !fs.existsSync(p.stagingAbs),
      },
      {
        name: 'NEW_MOVED_FINISH', phase: 'NEW_MOVED', cur: 'new', prev: 'old', staging: 'absent',
        releaseLockFirst: true, expectAction: 'continued', expectOk: true,
        expect: (p) => readTree(p.memDir) === NEW_CONTENT && readTree(p.prevAbs) === OLD_CONTENT,
      },
      {
        name: 'COMMITTED_CLEANUP', phase: 'COMMITTED', cur: 'new', prev: 'old', staging: 'absent',
        releaseLockFirst: false, expectAction: 'rolled-back',
        expect: (p) => readTree(p.memDir) === NEW_CONTENT && !fs.existsSync(journalPath(p.stateDir, 'row-txn')),
      },
      {
        name: 'COMMITTED_STOP', phase: 'COMMITTED', cur: 'old', prev: 'old', staging: 'absent',
        releaseLockFirst: false, expectAction: 'stopped',
        expect: (p) => readTree(p.memDir) === OLD_CONTENT && fs.existsSync(journalPath(p.stateDir, 'row-txn')),
      },
      {
        name: 'USER_MODIFIED_STOP', phase: 'OLD_MOVED', cur: 'other', prev: 'old', staging: 'new',
        releaseLockFirst: false, expectAction: 'stopped',
        expect: (p) => readTree(p.memDir) === OTHER_CONTENT && fs.existsSync(journalPath(p.stateDir, 'row-txn')) && readTree(p.stagingAbs) === NEW_CONTENT,
      },
    ];

    for (const row of rows) {
      const p = setupRow(row.name, row);
      if (row.releaseLockFirst) lock.releaseLock(path.join(p.stateDir, 'restore.lock'), p.claim.nonce);
      const r = recoverOnStartup(p.stateDir);
      const actionOk = r.action === row.expectAction && (row.expectOk === undefined || r.ok === row.expectOk);
      const fsOk = row.expect(p);
      check(`10 (ts H2) row ${row.name}: action=${row.expectAction}${row.expectOk !== undefined ? '/ok=' + row.expectOk : ''} AND real on-disk end-state matches spec`, actionOk && fsOk);
    }
  }

  // 11 (Opus H3 false-green): a journal with a completely unknown phase
  // string (never written by this code, e.g. a future/foreign version, or
  // on-disk bit rot) must fall into classifyRecoveryRow's final catch-all
  // (line ~295, OUTSIDE_MATRIX_STOP) and STOP — never be silently treated
  // as any known phase, and never touch the filesystem.
  {
    const stateDir = path.join(T, 's11');
    const memDir = freshMemDir('mem11', { 'decisions.md': 'v1\n' });
    const stagingMem = freshMemDir('mem11-staging', { 'decisions.md': 'v2\n' });
    const j = {
      txn: 'unknown-phase-test', phase: 'BOGUS_PHASE_FROM_THE_FUTURE',
      current_abs: memDir, prev_abs: path.join(stateDir, 'restore-prev', 'unknown-phase-test'), staging_abs: stagingMem,
      old_tree_hash: computeTreeHash(memDir), new_tree_hash: computeTreeHash(stagingMem),
      nonce: 'irrelevant', ts: new Date().toISOString(),
    };
    writeJournalAtomic(journalPath(stateDir, 'unknown-phase-test'), j);
    const r = recoverOnStartup(stateDir);
    check('11 (Opus H3) completely unknown journal phase string -> stopped, current tree untouched, journal preserved for manual inspection',
      r.action === 'stopped' && fs.readFileSync(path.join(memDir, 'decisions.md'), 'utf8') === 'v1\n' && fs.existsSync(journalPath(stateDir, 'unknown-phase-test')));
  }

  // 12 (LOW): more than one in-flight restore transaction directory ->
  // recoverOnStartup stops explicitly instead of silently recovering an
  // arbitrary one and ignoring the rest.
  {
    const stateDir = path.join(T, 's12');
    const memDir = freshMemDir('mem12', { 'decisions.md': 'v1\n' });
    const stagingMem = freshMemDir('mem12-staging', { 'decisions.md': 'v2\n' });
    const jBase = {
      current_abs: memDir, staging_abs: stagingMem,
      old_tree_hash: computeTreeHash(memDir), new_tree_hash: computeTreeHash(stagingMem),
      nonce: 'irrelevant', ts: new Date().toISOString(),
    };
    writeJournalAtomic(journalPath(stateDir, 'txn-a'), { ...jBase, txn: 'txn-a', phase: 'PREPARED', prev_abs: path.join(stateDir, 'restore-prev', 'txn-a') });
    writeJournalAtomic(journalPath(stateDir, 'txn-b'), { ...jBase, txn: 'txn-b', phase: 'PREPARED', prev_abs: path.join(stateDir, 'restore-prev', 'txn-b') });
    const r = recoverOnStartup(stateDir);
    check('12 (LOW) multiple in-flight restore transactions -> stopped explicitly, current tree untouched, both journals preserved',
      r.action === 'stopped' && fs.readFileSync(path.join(memDir, 'decisions.md'), 'utf8') === 'v1\n' && fs.existsSync(journalPath(stateDir, 'txn-a')) && fs.existsSync(journalPath(stateDir, 'txn-b')));
  }

  // 13 (LOW): layoutCheck rejects memoryDir (current_abs) ITSELF being a
  // symlink/junction, not just stateDir/staging/prev.
  {
    const realDir = path.join(T, 's13-real');
    fs.mkdirSync(realDir, { recursive: true });
    const linkPath = path.join(T, 's13-mem-link');
    let symlinkOk = true;
    try { fs.symlinkSync(realDir, linkPath, 'junction'); } catch { symlinkOk = false; }
    if (symlinkOk) {
      const r = layoutCheck(path.join(T, 's13-state'), linkPath);
      check('13 (LOW) layoutCheck rejects memoryDir itself being a symlink/junction', r.ok === false && /symlink\/junction/.test(r.reason));
    } else {
      check('13 (LOW) layoutCheck rejects memoryDir itself being a symlink/junction (skipped: could not create a test symlink on this system)', true);
    }
  }

  // 14 (LOW): computeTreeHash warns (via backup.listFilesRecursive's
  // onSkip) when it silently excludes a symlink from the tree-identity
  // hash — same mechanism as backup.cjs's own createBackup(), proven
  // there; this confirms restore.cjs actually wires the callback through.
  {
    const dirWithLink = path.join(T, 's14-tree');
    fs.mkdirSync(dirWithLink, { recursive: true });
    fs.writeFileSync(path.join(dirWithLink, 'decisions.md'), 'x\n');
    const linkTargetDir = path.join(T, 's14-target');
    fs.mkdirSync(linkTargetDir, { recursive: true });
    let symlinkOk = true;
    try { fs.symlinkSync(linkTargetDir, path.join(dirWithLink, 'linked'), 'junction'); } catch { symlinkOk = false; }
    if (symlinkOk) {
      const origErr = console.error;
      let warned = false;
      console.error = (msg) => { if (typeof msg === 'string' && msg.includes('skipping symlink') && msg.includes('linked')) warned = true; };
      try { computeTreeHash(dirWithLink); } finally { console.error = origErr; }
      check('14 (LOW) computeTreeHash warns when a symlink is excluded from the tree-identity hash', warned);
    } else {
      check('14 (LOW) computeTreeHash symlink warning (skipped: could not create a test symlink on this system)', true);
    }
  }

  // 15 (codex(gf) MEDIUM #5). A tar carrying an UNDECLARED regular member
  // (present in the archive, absent from manifest.files) must be refused
  // by default, not silently extracted alongside the declared files.
  // Builds a REAL backup via backup.createBackup() (manifest correctly
  // declares exactly one file), then appends a second, undeclared file
  // into the SAME tar with a real `tar -rf` (append), reproducing the
  // exact repro shape: manifest declares only memory/decisions.md, tar
  // also carries memory/extra.md.
  {
    const memDir15 = freshMemDir('mem15', { 'decisions.md': 'declared\n' });
    const basename15 = path.basename(memDir15);
    const tarPath15 = path.join(T, 'undeclared.tar');
    backup.createBackup(memDir15, tarPath15);
    const stagingExtra = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-restore-undeclared-'));
    fs.mkdirSync(path.join(stagingExtra, basename15), { recursive: true });
    fs.writeFileSync(path.join(stagingExtra, basename15, 'extra.md'), 'UNDECLARED\n');
    execFileSync('tar', ['--force-local', '-rf', backup.toPosixTarPath(tarPath15), '-C', backup.toPosixTarPath(stagingExtra), `${basename15}/extra.md`], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.rmSync(stagingExtra, { recursive: true, force: true });

    const av15 = validateArchive(tarPath15);
    const destDir15 = path.join(T, 's15-extract');
    const rejectedByDefault = av15.ok
      ? (() => {
          const ex = extractAndVerify(tarPath15, destDir15, av15.members);
          return ex.ok === false && /extra\.md/.test(ex.reason) && /not listed in manifest/.test(ex.reason);
        })()
      : false;
    try { fs.rmSync(destDir15, { recursive: true, force: true }); } catch { /* ignore */ }

    // Same archive, --allow-unlisted: the undeclared file is accepted and
    // actually lands on disk instead of being refused.
    const destDir15b = path.join(T, 's15b-extract');
    const exAllowed = av15.ok ? extractAndVerify(tarPath15, destDir15b, av15.members, { allowUnlisted: true }) : { ok: false };
    const allowedAndPresent = exAllowed.ok === true && fs.existsSync(path.join(destDir15b, basename15, 'extra.md'));
    try { fs.rmSync(destDir15b, { recursive: true, force: true }); } catch { /* ignore */ }

    check(
      '15 (codex(gf) MEDIUM #5) tar member not listed in manifest.json refused by default (named in the reason), accepted only with --allow-unlisted',
      rejectedByDefault && allowedAndPresent
    );
  }

  console.log(results.join('\n'));
  console.log(`restore self-test ${ok}/27`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === 27 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI — thin wrapper bin/axmem shells out to.
// ---------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    process.exit(selfTest());
  } else if (argv[0] === '--recover-on-startup') {
    const stateDir = argv[1];
    if (!stateDir) { console.error('usage: restore.cjs --recover-on-startup <stateDir>'); process.exit(1); }
    const r = recoverOnStartup(stateDir);
    if (r.action === 'none') process.exit(0);
    if (r.action === 'stopped') { console.error(`axmem: restore recovery stopped — ${r.reason}`); process.exit(3); }
    console.error(`axmem: restore recovery ${r.action}${r.detail ? ' (' + r.detail + ')' : ''}`);
    process.exit(r.ok === false ? 3 : 0);
  } else if (argv[0] === 'restore') {
    const tarPath = argv[1];
    const dryRun = argv.includes('--dry-run');
    // [codex(gf) MEDIUM #5] Default is reject any tar member not declared
    // in manifest.json — opt IN to keeping one, never opt out of the check.
    const allowUnlisted = argv.includes('--allow-unlisted');
    // Same resolution chain (env > config.json > default) every other .cjs
    // component uses — bin/axmem's shell variables are never `export`ed.
    const ctx = require('../lib/prelude.cjs');
    const stateDir = process.env.AXMEM_STATE_DIR || ctx.STATE_DIR;
    const memoryDir = process.env.AXMEM_MEMORY_DIR || ctx.MEMORY_DIR;
    process.exit(cliRestore(tarPath, { stateDir, memoryDir, dryRun, allowUnlisted }));
  } else {
    console.error('usage: restore.cjs restore <backup.tar> [--dry-run] | --recover-on-startup <stateDir> | --self-test');
    process.exit(1);
  }
}
