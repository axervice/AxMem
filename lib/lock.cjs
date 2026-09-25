#!/usr/bin/env node
// AxMem lock — D11 directory-claim lock protocol. (P1 2.0, 2026-09-16)
// Shared by the Hermes bridge's queue admission lock and the lifecycle
// restore lock (P1-ADAPTERS-SPEC.md §1 D11). Re-derived from first
// principles because there is no cross-platform "flock a directory"
// primitive and Windows renameSync onto an existing directory target fails
// with a platform-dependent error code (empirically EPERM here, NOT EEXIST
// — see the builder report for the reproduction) — so error CODE can never
// be the signal for "did I get the lock", only "did rename throw at all".
//
// Protocol summary (authoritative text is the spec; this is the index):
//   - claim = mkdir a scratch dir `<lock>.claim-<nonce>/`, write owner.json
//     inside it (pid, host, process start time, nonce), THEN rename it onto
//     `<lock>/`. Rename failing (ANY error, any code) = lock not acquired.
//     A lock directory, once it exists, ALWAYS has a valid owner.json inside
//     it (published atomically via that same rename) — there is no window
//     where `<lock>/` exists but is ownerless.
//   - reclaim ONLY when the owner is PROVABLY dead: same host AND (pid does
//     not exist, OR that pid's process-start-time no longer matches the
//     recorded value — i.e. the pid number got recycled by an unrelated
//     process). Different host, or "can't tell" (access denied / timeout /
//     malformed owner.json) => never reclaim, treat as D9 (caller decides
//     the fallback: queue side drops + records, restore side returns rc 3).
//     There is NO time-based reclaim of any kind.
//   - fencing: the holder re-reads `<lock>/owner.json` and compares nonce
//     before every critical write (directory rename, journal write,
//     publish). A mismatch means someone else's reclaim raced ahead of us —
//     abort immediately, write nothing, let the caller record
//     `lock-fenced-abort`.
//   - release = rename `<lock>/` -> `<lock>.released-<nonce>/`, then delete
//     it. Only the nonce that currently owns the lock may do this (the
//     caller must already hold the lock to call release(), so the nonce
//     check here is a defensive fence-before-release, not the primary
//     mutual-exclusion mechanism).
//   - cleanup: a claim that fails to become the lock deletes its OWN
//     `.claim-<nonce>/` immediately (best-effort). Independently, every
//     successful holder — once it holds the lock — sweeps sibling
//     `.claim-*` AND `.released-*` directories next to `<lock>/`, but NOT
//     the same way: `.claim-*` only if OLDER than STALE_CLAIM_MS (2s; see
//     sweepSiblings) — a younger one is left alone, since it may still be
//     a genuinely in-flight concurrent claim (an unpublished claim never
//     owned the lock, so deleting a genuinely-stale one can only ever
//     make some OTHER claimant's rename fail-and-retry, never break
//     exclusivity — v8.1, M4) — while `.released-*` is swept
//     UNCONDITIONALLY regardless of age (release() already fenced on
//     nonce before renaming, so a `.released-*` dir can only exist
//     because ITS claim already legitimately held and released the lock
//     — there is no "in-flight" state for it to race with, unlike
//     `.claim-*`). Only the officially published `<lock>/` gets D9's
//     "can't prove dead, don't touch it" protection; naked `.claim-*` /
//     `.released-*` litter does not. A sweep failure (e.g. read-only dir)
//     is reported via the returned diagnostics as `lock-sweep-failed` and
//     does not affect the mutual-exclusion result already established by
//     the rename.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

// Maximum valid pid on either platform this spec targets: Windows pids are
// 32-bit (max 4294967295 in principle, though in practice far smaller);
// POSIX pid_t is commonly 32-bit signed. Using the wider Windows bound here
// is deliberately permissive — the point isn't to be a strict OS validator,
// it's to reject values that are structurally NOT a pid (fractional, NaN,
// zero, negative, or absurdly large) before they ever reach process.kill().
const MAX_VALID_PID = 4294967295;

function nowNonce() {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function hostId() {
  return os.hostname() || 'unknown-host';
}

// ---------------------------------------------------------------------------
// Process liveness
// ---------------------------------------------------------------------------

// Returns 'alive' | 'dead' | 'unknown' for a pid on this host.
// process.kill(pid, 0) is documented by Node as portable existence-testing
// (it does not actually deliver a signal on Windows — libuv maps signal 0 to
// an OpenProcess existence probe). Throws ESRCH when the pid does not exist.
// SECURITY FIX (ECC security review H1, 2026-09-16): the previous boolean
// version treated ANY non-ESRCH/EPERM error (e.g. a RangeError/EINVAL from
// an out-of-range or non-integer pid) as `false`, which ownerStatus() then
// read as "does not exist" -> DEAD -> reclaimable. That let a MALFORMED
// owner.json (pid: 1.5, NaN, 0, negative, or absurdly large) force a live
// lock to be treated as abandoned. Now: ONLY ESRCH means dead, ONLY EPERM
// means alive, and every other outcome (including a pid value Node itself
// rejects before ever syscalling) is 'unknown' — which ownerStatus() must
// never treat as dead. readOwner() below adds a second, earlier layer of
// defense by rejecting non-integer/out-of-range pids as corrupt (D9).
function pidExists(pid) {
  // Structurally-invalid pids never reach process.kill() at all: some
  // platforms give a negative/zero pid special "process group" broadcast
  // semantics (e.g. this Windows/Node combo's process.kill(-1, 0) throws
  // ESRCH, which would otherwise be misread as "genuinely dead") rather
  // than a clean "invalid argument" error. Reject the input on its face
  // before the OS ever gets a chance to say something misleading about it.
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_VALID_PID) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (e) {
    if (e.code === 'ESRCH') return 'dead';
    if (e.code === 'EPERM') return 'alive'; // process exists, we just can't signal it
    return 'unknown'; // any other unexpected failure
  }
}

// Windows: no native binding for process start time in core Node, so shell
// out to PowerShell. Returns:
//   { status: 'dead' }                     — Get-Process found no such pid
//   { status: 'alive', startTime: '<dec>' } — FILETIME as a DECIMAL STRING
//                                             (never parsed into a JS Number
//                                             — FILETIME exceeds 2^53 and
//                                             would silently lose precision)
//   { status: 'unknown' }                  — access denied / bad output /
//                                             process launch failure
// Timeout or an unexpected thrown error also collapse to 'unknown' — per
// D11, "can't tell" must never be treated as dead.
function windowsProcessStartTime(pid, { timeoutMs = 3000 } = {}) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return { status: 'unknown' };
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `try { $p = Get-Process -Id ${p} -ErrorAction Stop } catch { Write-Output 'DEAD'; exit 0 }`,
    `try { Write-Output ('OK:' + $p.StartTime.ToFileTimeUtc()) } catch { Write-Output 'UNKNOWN' }`,
  ].join('; ');
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
    });
  } catch {
    return { status: 'unknown' };
  }
  const line = String(out || '').trim().split(/\r?\n/).pop() || '';
  if (line === 'DEAD') return { status: 'dead' };
  if (line === 'UNKNOWN') return { status: 'unknown' };
  const m = /^OK:(\d+)$/.exec(line);
  if (m) return { status: 'alive', startTime: m[1] };
  return { status: 'unknown' };
}

// POSIX equivalent used only for parity in tests on a POSIX box; Windows is
// the platform of record for this spec (D11 is written Windows-first) and
// this repo's runtime is Windows, so this path is best-effort only.
function posixProcessStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rparen = stat.lastIndexOf(')');
    const fields = stat.slice(rparen + 2).split(' ');
    const startticks = fields[19]; // field 22 overall, 0-indexed after comm
    if (startticks === undefined) return { status: 'unknown' };
    return { status: 'alive', startTime: String(startticks) };
  } catch {
    return { status: 'unknown' };
  }
}

function processStartTime(pid, opts) {
  return IS_WINDOWS ? windowsProcessStartTime(pid, opts) : posixProcessStartTime(pid);
}

// v8.1 D11 revision (Opus acceptance M4): THIS process's own start time is
// constant for its entire lifetime, so recomputing it on every claim
// attempt (a ~300ms+ PowerShell shell-out on Windows) only widens the
// mkdir->write-owner.json->rename critical window during which a concurrent
// holder's sibling sweep could delete our still-unpublished claim dir.
// Computed once, lazily, and cached for the life of the process.
let _ownStartTimeCache;
let _ownStartTimeCached = false;
function ownStartTimeCached(opts) {
  if (!_ownStartTimeCached) {
    const st = processStartTime(process.pid, opts);
    _ownStartTimeCache = st.status === 'alive' ? st.startTime : null;
    _ownStartTimeCached = true;
  }
  return _ownStartTimeCache;
}
// Test-only: clears the cache so a test can force recomputation (e.g. after
// changing `opts.timeoutMs` to probe a different code path).
function resetOwnStartTimeCacheForTests() {
  _ownStartTimeCached = false;
  _ownStartTimeCache = undefined;
}

// ---------------------------------------------------------------------------
// owner.json
// ---------------------------------------------------------------------------

function readOwner(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8');
  } catch {
    return null; // missing / unreadable — D9: permanently un-reclaimable, never a time-based fallback
  }
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    if (typeof o.pid !== 'number' || typeof o.host !== 'string' || typeof o.nonce !== 'string') return null;
    // SECURITY FIX (ECC security review H1): a structurally-invalid pid
    // (non-integer, <=0, or out of range) makes this owner record corrupt,
    // not merely "hard to check" — treat it exactly like a missing/truncated
    // owner.json (D9: permanent, never a time-based or best-effort reclaim).
    if (!Number.isInteger(o.pid) || o.pid <= 0 || o.pid > MAX_VALID_PID) return null;
    // startTime may legitimately be absent on platforms where we couldn't
    // determine it at claim time (treated as 'unknown' forever for THIS
    // owner record — see isOwnerDead).
    return o;
  } catch {
    return null; // corrupt / truncated JSON — same D9 treatment as missing
  }
}

function writeOwnerAtomically(dir, owner) {
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
}

// Returns 'dead' | 'alive' | 'unknown'. Only 'dead' authorizes reclaim.
function ownerStatus(owner, opts) {
  if (!owner) return 'unknown'; // missing/corrupt handled by caller as permanent D9
  if (owner.host !== hostId()) return 'unknown'; // different host: can't check, never reclaim
  const pidState = pidExists(owner.pid);
  if (pidState === 'unknown') return 'unknown'; // can't tell -> never dead (ECC security H1)
  if (pidState === 'dead') return 'dead'; // host matches, pid flat-out gone
  // pidState === 'alive': must confirm it's still the SAME process (not a
  // recycled pid) via start time; can't tell -> unknown, never dead.
  if (typeof owner.startTime !== 'string' || !owner.startTime) return 'unknown';
  const cur = processStartTime(owner.pid, opts);
  if (cur.status !== 'alive') return 'unknown'; // couldn't determine current start time
  return cur.startTime === owner.startTime ? 'alive' : 'dead'; // mismatch = pid recycled = old owner is dead
}

// ---------------------------------------------------------------------------
// Sweep: unconditionally clear sibling .claim-* / .released-* next to <lock>
// ---------------------------------------------------------------------------

// v8.1 D11 revision (Opus acceptance M4): sweeping EVERY sibling `.claim-*`
// unconditionally raced with concurrent claimants on NTFS — 40 processes
// mkdir-ing into the same parent directory means a holder's sweep could
// delete another claimant's `.claim-<nonce>/` between its mkdir and its
// rename-to-publish, forcing a retry (measured: 38/40 failures were
// `claim-dir-lost-to-concurrent-sweep`, not real contention). A legitimate
// in-flight claim lives for at most a few filesystem operations — low
// single-digit milliseconds — so anything OLDER than 2 seconds is
// unambiguously abandoned (crashed before publishing), never an in-flight
// competitor. `.released-*` dirs are still swept unconditionally: release()
// already fenced on nonce before renaming, so a `.released-*` dir can only
// exist because ITS claim already legitimately held and released the lock —
// there's no "in-flight" state for it to race with.
const STALE_CLAIM_MS = 2000;

function sweepSiblings(lockPath) {
  const dir = path.dirname(lockPath);
  const base = path.basename(lockPath);
  const events = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return events; // parent unreadable — nothing we can do, not a sweep failure per se
  }
  const claimPrefix = `${base}.claim-`;
  const releasedPrefix = `${base}.released-`;
  const now = Date.now();
  for (const name of entries) {
    const isClaim = name.startsWith(claimPrefix);
    const isReleased = name.startsWith(releasedPrefix);
    if (!isClaim && !isReleased) continue;
    const full = path.join(dir, name);
    if (isClaim) {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue; // vanished between readdir and stat (another sweeper got it) — not a failure
      }
      if (now - mtimeMs < STALE_CLAIM_MS) continue; // young enough to be a real in-flight claim — leave it alone
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch (e) {
      events.push({ event: 'lock-sweep-failed', target: full, error: e.message });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

// Shared "we did not win the rename" path: clean up our own scratch claim
// dir, then decide whether the CURRENT holder is provably dead so a caller
// retrying in a loop can reclaim promptly instead of waiting out the whole
// timeout budget. Factored out so both the pre-rename existence check and
// an actual rename failure evaluate contention identically (see the
// existsSync short-circuit in tryClaimOnce for why a pre-check is needed at
// all on POSIX).
function handleContended(lockPath, claimDir, opts, events) {
  try { fs.rmSync(claimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  const existingOwner = readOwner(lockPath);
  const status = existingOwner ? ownerStatus(existingOwner, opts) : 'unknown';
  if (status === 'dead') {
    // Reclaim: forcibly remove the dead lock dir, then let the caller's
    // retry loop attempt a fresh claim. This is the only place a lock
    // directory can go from "exists" to "does not exist" without its
    // current nonce authorizing it — legal ONLY because ownerStatus just
    // proved the recorded owner cannot still be alive to contest it.
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch { /* another reclaimer may have already removed it — fine */ }
    return { acquired: false, reason: 'reclaimable', events };
  }
  return { acquired: false, reason: status === 'alive' ? 'owner-alive' : 'owner-unknown', events };
}

// Single non-blocking attempt. Returns:
//   { acquired: true, nonce, events }
//   { acquired: false, reason: 'contended'|'owner-alive'|'owner-unknown', events }
function tryClaimOnce(lockPath, opts = {}) {
  const events = [];
  const nonce = nowNonce();
  const dir = path.dirname(lockPath);
  const base = path.basename(lockPath);
  const claimDir = path.join(dir, `${base}.claim-${nonce}`);

  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.mkdirSync(claimDir, { recursive: true });
    const owner = {
      pid: process.pid,
      host: hostId(),
      nonce,
      startTime: ownStartTimeCached(opts),
      claimedAt: new Date().toISOString(),
    };
    if (opts.injectCrashAfterClaimDir) {
      // Test-only hook (§9.2 "claim mkdir 后、owner 缺失或截断时崩溃"): leave the
      // claim directory behind with no/partial owner.json and stop, simulating
      // a crash between mkdir and the rename-to-publish step.
      if (opts.injectCrashAfterClaimDir === 'missing-owner') {
        return { acquired: false, reason: 'injected-crash', events, claimDir };
      }
      if (opts.injectCrashAfterClaimDir === 'truncated-owner') {
        fs.writeFileSync(path.join(claimDir, 'owner.json'), '{"pid":'); // truncated JSON
        return { acquired: false, reason: 'injected-crash', events, claimDir };
      }
    }
    writeOwnerAtomically(claimDir, owner);
  } catch {
    // Our OWN scratch claim dir can vanish before we finish populating it —
    // not a hypothetical: reproduced under the §9.6 40-concurrent-producer
    // barrier test. A published lock holder sweeps sibling `.claim-*` dirs
    // OLDER THAN STALE_CLAIM_MS (2s; spec-mandated, see sweepSiblings — not
    // unconditionally all of them), and if THIS claim hadn't been renamed
    // onto <lock> yet and has aged past that threshold, a concurrent
    // holder's sweep can delete it out from under a `mkdir` that just
    // barely won a race with that same sweep, or an owner.json write
    // immediately after. This is
    // exactly the "unpublished claim never owned the lock" case the spec
    // calls out — the safe response is "not acquired this round, retry",
    // never an uncaught crash.
    try { fs.rmSync(claimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { acquired: false, reason: 'claim-dir-lost-to-concurrent-sweep', events };
  }

  // Publish (rename claim dir onto the lock path). D11 relies on "ANY rename
  // onto an existing <lock>/ target fails" — true on Windows for EVERY
  // existing directory target, empty or not, but NOT true on POSIX: POSIX
  // rename(2) explicitly permits replacing an already-existing EMPTY
  // directory. A fabricated/anomalous empty `<lock>/` (e.g. missing
  // owner.json — D9 says this must be PERMANENTLY un-reclaimable, same as a
  // corrupt owner.json) would therefore be silently adopted by the very next
  // claimant on Linux/macOS without ever being run through the owner-status
  // check below — reproduced by lib/lock.cjs --self-test's "§9.1 missing
  // owner.json never reclaimed" case, which only failed on ubuntu-latest CI,
  // never on Windows (the corrupt-owner.json sibling case never hit this,
  // since a NON-empty lock dir already fails POSIX rename with ENOTEMPTY).
  // Fix: check existence first, on every platform, so an existing lockPath
  // — empty or not — is ALWAYS routed through the same contended/ownerStatus
  // evaluation as an explicit rename failure, never through a bare rename
  // that POSIX might let slide through on a technicality.
  if (fs.existsSync(lockPath)) {
    return handleContended(lockPath, claimDir, opts, events);
  }
  try {
    fs.renameSync(claimDir, lockPath);
  } catch {
    // ANY rename error = not acquired, regardless of code (D11 Windows
    // fact) — also covers the race where another claimant published between
    // our existsSync check above and this renameSync call.
    return handleContended(lockPath, claimDir, opts, events);
  }

  // [Opus L1, 2026-09-17] Acquired. Sweep sibling claim/released litter
  // while holding the lock — but the two prefixes are NOT treated the
  // same, despite the spec's shorthand phrasing ("持锁者在锁内无条件清扫
  // 全部 sibling"): sweepSiblings() (below) only removes a `.claim-*`
  // entry that's OLDER than STALE_CLAIM_MS (2s), leaving a younger one
  // alone since it may still be a genuinely in-flight concurrent claim
  // (v8.1, M4) — a `.released-*` entry, by contrast, IS removed
  // unconditionally regardless of age (see sweepSiblings' own header
  // comment for why that one has no in-flight state to protect).
  events.push(...sweepSiblings(lockPath));
  return { acquired: true, nonce, events };
}

// Blocking claim with a wall-clock budget. Busy-retries with a short
// synchronous backoff (Atomics.wait works on the Node main thread — this is
// intentionally blocking; callers with a 10s hook timeout budget accordingly
// per spec's "3 秒等待上限，与 hook 10 秒 timeout 留余量").
// v8.1 D11 revision (Opus acceptance M4): exponential backoff + jitter
// instead of a fixed 25ms poll — spreads concurrent retriers' next attempts
// apart in time, reducing how often many of them land in the same mkdir
// window together. Base 25ms, doubling, capped at 250ms; jitter is
// full-range random within [0, currentBackoff) added on top (a standard
// "decorrelated-ish" jitter shape, cheap to reason about).
const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 250;

function claimLock(lockPath, { timeoutMs = 3000, pollMs = BACKOFF_BASE_MS, ...rest } = {}) {
  const deadline = Date.now() + timeoutMs;
  const allEvents = [];
  let backoff = pollMs;
  for (;;) {
    const r = tryClaimOnce(lockPath, rest);
    allEvents.push(...r.events);
    if (r.acquired) return { acquired: true, nonce: r.nonce, events: allEvents };
    if (r.reason === 'reclaimable') continue; // retry immediately, no need to sleep
    if (Date.now() >= deadline) return { acquired: false, reason: 'timeout', events: allEvents };
    const jitter = Math.random() * backoff;
    const wait = Math.min(backoff + jitter, Math.max(1, deadline - Date.now()));
    sleepMs(wait);
    backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
  }
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Fencing + release
// ---------------------------------------------------------------------------

// Returns true iff `nonce` still matches the published owner.json — call
// this immediately before every critical write. False means abort: do not
// write, let the caller record lock-fenced-abort.
function fenceCheck(lockPath, nonce) {
  const owner = readOwner(lockPath);
  return !!owner && owner.nonce === nonce;
}

// Releases the lock. Returns { released: boolean, events }.
function releaseLock(lockPath, nonce) {
  const events = [];
  if (!fenceCheck(lockPath, nonce)) {
    return { released: false, events, reason: 'fence-mismatch' };
  }
  const dir = path.dirname(lockPath);
  const base = path.basename(lockPath);
  const releasedDir = path.join(dir, `${base}.released-${nonce}`);
  try {
    fs.renameSync(lockPath, releasedDir);
  } catch (e) {
    return { released: false, events, reason: `rename-failed: ${e.message}` };
  }
  try {
    fs.rmSync(releasedDir, { recursive: true, force: true });
  } catch (e) {
    events.push({ event: 'lock-sweep-failed', target: releasedDir, error: e.message });
  }
  return { released: true, events };
}

// ---------------------------------------------------------------------------
// Self-test — proves the D11 invariants the builder report must evidence
// (spec §9). Each numbered block below corresponds to a §9 item.
// ---------------------------------------------------------------------------
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function selfTest() {
  const os2 = require('os');
  const T = fs.mkdtempSync(path.join(os2.tmpdir(), 'axmem-lock-selftest-'));
  let ok = 0;
  let total = 0;
  let skipped = 0;
  const results = [];
  function check(name, cond) {
    total++;
    if (cond) { ok++; results.push(`  ok   ${name}`); }
    else { results.push(`  FAIL ${name}`); }
  }
  // A genuinely platform-specific check that cannot be exercised on this
  // platform at all (not merely "didn't reproduce this run" — see §9.7
  // below) — counted separately so it neither inflates a pass nor
  // masquerades a real failure as green.
  function skip(name) {
    skipped++;
    results.push(`  --   SKIP ${name}`);
  }

  // 1. Basic claim -> fence-check ok -> release -> lock dir gone, released-* swept.
  {
    const lp = path.join(T, 'basic.lock');
    const r = claimLock(lp, { timeoutMs: 1000 });
    const fenceOk = r.acquired && fenceCheck(lp, r.nonce);
    const rel = r.acquired ? releaseLock(lp, r.nonce) : { released: false };
    check('basic claim/fence/release round trip', r.acquired && fenceOk && rel.released && !fs.existsSync(lp));
  }

  // 2 (§9.1). Missing owner.json inside a manually-fabricated lock dir is
  // NEVER reclaimed, even though the "owner" pid is trivially dead (0 is
  // never a real pid) — because D9 says missing/corrupt owner.json is
  // permanent, not a dead-owner case.
  {
    const lp = path.join(T, 'missing-owner.lock');
    fs.mkdirSync(lp);
    // no owner.json written at all
    const r = tryClaimOnce(lp, {});
    check('§9.1 missing owner.json never reclaimed', !r.acquired && fs.existsSync(lp) && fs.existsSync(path.join(lp, 'owner.json')) === false);
  }

  // 3 (§9.1). A corrupt/truncated owner.json is likewise never reclaimed.
  {
    const lp = path.join(T, 'corrupt-owner.lock');
    fs.mkdirSync(lp);
    fs.writeFileSync(path.join(lp, 'owner.json'), '{"pid":1,"host":'); // truncated
    const r = tryClaimOnce(lp, {});
    check('§9.1 corrupt owner.json never reclaimed', !r.acquired && fs.existsSync(lp));
  }

  // 4 (§9.1). A LIVE owner (this very process, matching real start time) is
  // never reclaimed by a second party, even repeatedly.
  {
    const lp = path.join(T, 'alive-owner.lock');
    const first = claimLock(lp, { timeoutMs: 1000 });
    let stillBlocked = true;
    if (first.acquired) {
      const second = tryClaimOnce(lp, {});
      stillBlocked = !second.acquired && second.reason === 'owner-alive';
      releaseLock(lp, first.nonce);
    }
    check('§9.1 live owner blocks a second claimant (no reclaim while alive)', first.acquired && stillBlocked);
  }

  // 5 (§9.2). Unpublished claim (mkdir'd but never renamed onto <lock>) does
  // not block another party from claiming the real lock name.
  {
    const lp = path.join(T, 'unpublished.lock');
    const strayClaim = `${lp}.claim-stray-nonce`;
    fs.mkdirSync(strayClaim, { recursive: true });
    fs.writeFileSync(path.join(strayClaim, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostId(), nonce: 'stray-nonce' }));
    const r = tryClaimOnce(lp, {});
    check('§9.2 unpublished claim never blocks a real claim', r.acquired && fs.existsSync(lp));
    if (r.acquired) releaseLock(lp, r.nonce);
  }

  // 6 (§9.2). Injected "claim mkdir succeeded, then crashed before owner.json
  // was written / while truncated" leaves `.claim-*` litter with no owner.
  // The NEXT successful holder of the SAME lock name sweeps it to zero, and
  // there is never a double-hold (only one nonce ever owns `<lock>/`).
  // v8.1: sweep only removes `.claim-*` older than STALE_CLAIM_MS (M4) — a
  // genuinely fresh crash artifact is indistinguishable from a legitimate
  // in-flight claim for the first couple seconds, by design. Backdate the
  // injected artifacts' mtime to simulate "this crashed a while ago",
  // which is the realistic case this sweep exists to clean up.
  {
    const lp = path.join(T, 'crash-claim.lock');
    const dir = path.dirname(lp);
    const c1 = tryClaimOnce(lp, { injectCrashAfterClaimDir: 'missing-owner' });
    const c2 = tryClaimOnce(lp, { injectCrashAfterClaimDir: 'truncated-owner' });
    const strayBefore = fs.readdirSync(dir).filter(n => n.startsWith(path.basename(lp) + '.claim-'));
    const oldTime = (Date.now() - (STALE_CLAIM_MS + 500)) / 1000;
    for (const n of strayBefore) { try { fs.utimesSync(path.join(dir, n), oldTime, oldTime); } catch { /* best-effort */ } }
    const real = claimLock(lp, { timeoutMs: 1000 });
    const strayAfter = fs.readdirSync(dir).filter(n => n.startsWith(path.basename(lp) + '.claim-'));
    const noDoubleHold = real.acquired && fs.existsSync(lp) && readOwner(lp) && readOwner(lp).nonce === real.nonce;
    check(
      '§9.2 crashed claim (missing/truncated owner, backdated >2s) swept to zero by next holder, no double-hold',
      !c1.acquired && !c2.acquired && strayBefore.length === 2 && strayAfter.length === 0 && noDoubleHold
    );
    if (real.acquired) releaseLock(lp, real.nonce);
  }

  // 6b (M4 new behavior). A FRESH `.claim-*` (younger than STALE_CLAIM_MS)
  // must survive another holder's sweep — only genuinely stale litter is
  // swept. This is the direct fix for the NTFS concurrent-sweep race Opus
  // measured (a real in-flight competitor's claim dir getting deleted out
  // from under it before it could publish).
  {
    const lp = path.join(T, 'fresh-claim.lock');
    const dir = path.dirname(lp);
    const freshClaim = `${path.basename(lp)}.claim-freshly-born`;
    fs.mkdirSync(path.join(dir, freshClaim), { recursive: true });
    fs.writeFileSync(path.join(dir, freshClaim, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostId(), nonce: 'freshly-born' }));
    // mtime is "now" (default from mkdirSync/writeFileSync) — well under STALE_CLAIM_MS old.
    const real = claimLock(lp, { timeoutMs: 1000 });
    const stillThere = fs.existsSync(path.join(dir, freshClaim));
    check('6b a fresh (<2s old) sibling .claim-* survives another holder\'s sweep', real.acquired && stillThere);
    try { fs.rmSync(path.join(dir, freshClaim), { recursive: true, force: true }); } catch { /* cleanup */ }
    if (real.acquired) releaseLock(lp, real.nonce);
  }

  // 7 (§9.3 fencing). Claim, then simulate the owner being externally
  // replaced (another nonce written into owner.json) while we "paused" —
  // the NEXT fence-check before a critical op must detect the mismatch and
  // the holder must abort (never proceed to write).
  {
    const lp = path.join(T, 'fenced.lock');
    const r = claimLock(lp, { timeoutMs: 1000 });
    let fencedCorrectly = false;
    if (r.acquired) {
      // externally replace owner.json (simulating a reclaim that raced in)
      fs.writeFileSync(path.join(lp, 'owner.json'), JSON.stringify({ pid: 999999, host: hostId(), nonce: 'someone-else' }));
      fencedCorrectly = fenceCheck(lp, r.nonce) === false;
    }
    check('§9.3 fencing detects owner replaced under us and aborts', r.acquired && fencedCorrectly);
    try { fs.rmSync(lp, { recursive: true, force: true }); } catch {}
  }

  // 8 (§9.4). Windows: N concurrent processes race a single tryClaimOnce
  // against the SAME lock path — at most one may succeed.
  {
    const lp = path.join(T, 'concurrent.lock');
    const barrier = path.join(T, 'go');
    const N = 8;
    const children = [];
    for (let i = 0; i < N; i++) {
      const resultFile = path.join(T, `race-result-${i}.json`);
      const child = require('child_process').spawn(
        process.execPath,
        [__filename, '__race-once', lp, resultFile, barrier],
        { stdio: 'ignore' }
      );
      children.push({ child, resultFile });
    }
    // release the barrier so all children attempt at roughly the same time
    fs.writeFileSync(barrier, 'go');
    const start = Date.now();
    // LOW L1 fix (Opus acceptance): a synchronous busy-wait here (the
    // previous version called spawnSync in a tight loop as a "yield")
    // blocks the Node event loop entirely, so `child.exitCode` — which is
    // only updated when libuv's async wait callback runs on a live event
    // loop tick — never actually changes. The old loop therefore ALWAYS
    // ran the full 10-second timeout regardless of how fast the children
    // actually finished (measured: made the whole --self-test run ~14s
    // instead of ~4s). `await delay()` keeps the event loop turning so
    // 'exit' notifications are delivered as soon as children finish.
    while (children.some(c => c.child.exitCode === null && !c.child.killed) && Date.now() - start < 10000) {
      await delay(15);
    }
    let successes = 0;
    for (const c of children) {
      try {
        const r = JSON.parse(fs.readFileSync(c.resultFile, 'utf8'));
        if (r.acquired) successes++;
      } catch { /* child may have failed to write — counts as not-acquired */ }
    }
    check(`§9.4 exactly one of ${N} concurrent claimants succeeds (got ${successes})`, successes === 1);
  }

  // 9 (§9.5 partial). FILETIME stays a decimal string end-to-end.
  {
    const lp = path.join(T, 'filetimefmt.lock');
    const r = claimLock(lp, { timeoutMs: 1000 });
    check('§9.5 FILETIME format is a decimal string', r.acquired && /^\d+$/.test((readOwner(lp) || {}).startTime || ''));
    if (r.acquired) releaseLock(lp, r.nonce);
  }

  // 9b (§9.7, fixed per ECC ts/Opus M2/9.7: the old assertion had `|| true`
  // baked in, making it unconditionally pass — removed). A REAL sweep
  // failure on Windows needs something that actually blocks rmSync: a
  // chmod 0o444 does NOT (NTFS ACLs, not POSIX mode bits, gate deletion —
  // confirmed empirically while fixing this). What DOES reliably block it:
  // a still-running child process whose CWD is inside the directory
  // (Windows refuses to remove a directory that is another process's
  // current working directory). This is a real, reproducible failure mode,
  // not a synthetic permission bit that happens to be a no-op here — but it
  // is fundamentally a Windows filesystem/OS semantic: POSIX explicitly
  // allows removing a directory that is another (still-running) process's
  // cwd (the process keeps its fd; the dentry is simply unlinked), so this
  // exact technique can never reproduce the failure on Linux/macOS. Ran on
  // ubuntu-latest CI it reliably came back with sawSweepFailedEvent===false
  // (the "inconclusive" branch below) — that's not a real bug, it's this
  // test's Windows-only premise, so it's skipped outright on non-Windows
  // rather than executed-and-treated-as-a-false-FAIL (a genuine sweep-
  // failure regression on Windows would still fail loudly here, since that
  // platform still runs the real check() below).
  if (IS_WINDOWS) {
    const lp = path.join(T, 'sweepfail.lock');
    const dir = path.dirname(lp);
    const staleClaimName = `${path.basename(lp)}.claim-stale-locked`;
    const staleClaimDir = path.join(dir, staleClaimName);
    fs.mkdirSync(staleClaimDir, { recursive: true });
    fs.writeFileSync(path.join(staleClaimDir, 'owner.json'), '{}');
    const oldTime = (Date.now() - (STALE_CLAIM_MS + 500)) / 1000;
    fs.utimesSync(staleClaimDir, oldTime, oldTime); // must be stale to even be attempted (M4)

    const blocker = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 8000)'], { cwd: staleClaimDir, stdio: 'ignore' });
    await delay(300); // give the child a moment to actually start with that cwd

    const r = tryClaimOnce(lp, {});
    const sawSweepFailedEvent = r.events.some((e) => e.event === 'lock-sweep-failed');
    const mutexUnaffected = r.acquired && fs.existsSync(lp);
    const stillThereWhileBlocked = fs.existsSync(staleClaimDir);

    blocker.kill();
    await delay(200);
    try { fs.rmSync(staleClaimDir, { recursive: true, force: true }); } catch { /* best-effort cleanup now that the blocker is dead */ }

    if (!sawSweepFailedEvent) {
      results.push('  --   §9.7 note: this platform/filesystem did not reproduce a sweep failure this run (child-cwd-lock trick did not block rmSync) — treated as inconclusive, NOT counted as a pass');
    }
    check(
      '§9.7 sweep failure (real, reproduced via child-process CWD lock) reports lock-sweep-failed and mutex is unaffected',
      mutexUnaffected && sawSweepFailedEvent && stillThereWhileBlocked
    );
    if (r.acquired) releaseLock(lp, r.nonce);
  } else {
    skip('§9.7 sweep failure (child-process CWD lock) — Windows-only semantic: POSIX permits rmdir/unlink on a directory that is another live process\'s cwd, so this reproduction technique cannot fire here');
  }

  // 10 (ECC security H1). Structurally-invalid pid values in owner.json
  // (non-integer, zero, negative, absurdly large, NaN) make the whole
  // record corrupt — D9 permanent, NEVER treated as a provably-dead owner
  // even though process.kill() might throw something other than ESRCH for
  // some of them. This is the exact bug class the review found: the old
  // pidExists() collapsed any non-ESRCH/EPERM error to "dead".
  {
    const badPids = [1.5, NaN, 0, -1, 1e14, Infinity, -Infinity];
    let allRejected = true;
    for (const badPid of badPids) {
      const lp2 = path.join(T, `badpid-${String(badPid).replace(/[^a-z0-9]/gi, '_')}.lock`);
      fs.mkdirSync(lp2);
      // Bypass readOwner's own validation to hand ownerStatus a raw record
      // directly (readOwner would already reject these — this test proves
      // ownerStatus() ALSO never calls a bad pid dead, as defense in depth).
      const fakeOwner = { pid: badPid, host: hostId(), nonce: 'x' };
      const status = ownerStatus(fakeOwner, {});
      if (status === 'dead') allRejected = false;
      // Also prove readOwner() itself refuses to hand back a record with
      // this pid at all (the first, earlier layer of defense).
      fs.writeFileSync(path.join(lp2, 'owner.json'), JSON.stringify({ pid: badPid, host: hostId(), nonce: 'x' }));
      const parsed = readOwner(lp2);
      if (parsed !== null) allRejected = false;
      try { fs.rmSync(lp2, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    check('10 (§sec H1) malformed pid values (1.5/NaN/0/-1/1e14/±Infinity) never read back and never judged dead', allRejected);
  }

  // 11 (ECC security H1). pidExists() itself: ESRCH -> dead, EPERM -> alive,
  // anything else -> unknown (never dead). Probing an out-of-range pid
  // value that Node's process.kill() itself rejects (not ESRCH/EPERM)
  // must NOT collapse to 'dead'.
  {
    const outOfRangeStatus = pidExists(99999999999); // larger than any real pid on this platform
    check('11 (§sec H1) pidExists() on an out-of-range pid returns unknown, never dead', outOfRangeStatus !== 'dead');
  }

  // 12 (ts M2): a REAL dead-owner reclaim, end-to-end. Every other "dead
  // owner" test in this file uses either a missing/truncated owner.json
  // (§9.2) or a synthetically-fabricated pid+startTime that was never an
  // actually-live process (§sec H1's malformed-pid tests) — neither
  // exercises the exact path a genuine crash recovery takes: a real
  // child process that really claimed the lock (real pid, real FILETIME
  // startTime recorded by this same module's own processStartTime()),
  // then really exited without ever calling releaseLock (the CLI's
  // `claim` subcommand has no release step) — simulating a crash and
  // leaving a live-looking owner.json a NEW claimant must be able to
  // reclaim via the ordinary "pid genuinely no longer exists" path.
  {
    const lp = path.join(T, 'dead-owner-e2e.lock');
    let childOk = true;
    try {
      require('child_process').execFileSync(process.execPath, [__filename, 'claim', lp, '3000'], { stdio: 'ignore' });
    } catch {
      childOk = false; // child failed to claim at all — test can't proceed meaningfully
    }
    const deadOwnerRecorded = childOk && readOwner(lp) !== null;
    const r2 = childOk ? claimLock(lp, { timeoutMs: 3000 }) : { acquired: false };
    check('12 (ts M2) a real child process that claimed the lock and exited without releasing (simulated crash) is reclaimed by a new claimant', deadOwnerRecorded && r2.acquired === true);
    if (r2.acquired) releaseLock(lp, r2.nonce);
  }

  // 13 (ECC ts M1). pidExists()'s catch-all branch ("any other unexpected
  // failure" -> 'unknown') is only actually exercised by something that
  // forces process.kill() to throw a code OTHER than ESRCH/EPERM. Test 11
  // above (an out-of-range pid) never reaches process.kill() at all — it's
  // rejected earlier by pidExists()'s own !Number.isInteger/range guard.
  // No other test in this file drives process.kill() into a 3rd, genuinely
  // unexpected error code either. Monkeypatches process.kill for the
  // duration of one direct pidExists() call (never routed through
  // readOwner()/ownerStatus()'s own filtering layers, which is what makes
  // this a direct unit test of pidExists() itself, not an indirect one),
  // then restores it immediately, even on throw.
  {
    const realKill = process.kill;
    process.kill = () => { const e = new Error('mocked non-ESRCH/EPERM failure'); e.code = 'EINVAL'; throw e; };
    let mockedStatus;
    try {
      mockedStatus = pidExists(1234);
    } finally {
      process.kill = realKill;
    }
    check('13 (ECC ts M1) pidExists() returns unknown when process.kill() throws a non-ESRCH/EPERM error (mocked EINVAL)', mockedStatus === 'unknown');
  }

  console.log(results.join('\n'));
  console.log(skipped > 0
    ? `lock self-test ${ok}/${total} ok, ${skipped} skipped (non-Windows: §9.7's child-cwd-lock technique is Windows-only)`
    : `lock self-test ${ok}/${total}`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  return ok === total ? 0 : 1;
}

// Internal helper invoked as a child process by selfTest()'s concurrency
// race (#8) — not part of the public CLI surface.
function raceOnceChildMain(lockPath, resultFile, barrierFile) {
  const start = Date.now();
  while (!fs.existsSync(barrierFile) && Date.now() - start < 5000) { /* spin-wait for the barrier */ }
  let result;
  try {
    result = tryClaimOnce(lockPath, {});
  } catch (e) {
    result = { acquired: false, error: e.message };
  }
  fs.writeFileSync(resultFile, JSON.stringify(result));
  // If this child won, hold the lock alive for the rest of the observation
  // window instead of exiting immediately. Exiting right away would make
  // this pid genuinely dead within milliseconds, letting a STRAGGLER
  // sibling (delayed by process-spawn/scheduler jitter, still mid-attempt)
  // legitimately reclaim a now-actually-abandoned lock and also "win" —
  // that's correct dead-owner-recovery behavior, not a double-hold, but it
  // would make THIS test (which is specifically about concurrent claims,
  // not sequential dead-owner recovery — that's covered by test 6) report
  // more than one success. Holding the win for a couple seconds gives every
  // sibling time to finish its own single attempt while the winner is
  // unambiguously still alive.
  if (result.acquired) {
    sleepMs(3000);
  }
}

module.exports = {
  IS_WINDOWS,
  hostId,
  pidExists,
  processStartTime,
  windowsProcessStartTime,
  readOwner,
  ownerStatus,
  sweepSiblings,
  tryClaimOnce,
  claimLock,
  fenceCheck,
  releaseLock,
  sleepMs,
  ownStartTimeCached,
  resetOwnStartTimeCacheForTests,
  STALE_CLAIM_MS,
  MAX_VALID_PID,
};

// ---------------------------------------------------------------------------
// CLI (thin — mainly for bash callers / manual probing; tests mostly require()
// this module directly since Node fixtures need fine-grained control over
// timing between claim/fence/release steps).
// ---------------------------------------------------------------------------
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'claim') {
    const lockPath = rest[0];
    const timeoutMs = Number(rest[1] || 3000);
    const r = claimLock(lockPath, { timeoutMs });
    console.log(JSON.stringify(r));
    process.exit(r.acquired ? 0 : 1);
  } else if (cmd === 'release') {
    const [lockPath, nonce] = rest;
    const r = releaseLock(lockPath, nonce);
    console.log(JSON.stringify(r));
    process.exit(r.released ? 0 : 1);
  } else if (cmd === 'fence-check') {
    const [lockPath, nonce] = rest;
    const ok = fenceCheck(lockPath, nonce);
    console.log(ok ? 'ok' : 'fenced');
    process.exit(ok ? 0 : 1);
  } else if (cmd === '--self-test') {
    selfTest().then((rc) => process.exit(rc)).catch((e) => { console.error(e); process.exit(1); });
  } else if (cmd === '__race-once') {
    raceOnceChildMain(rest[0], rest[1], rest[2]);
    process.exit(0);
  } else {
    console.error('usage: lock.cjs claim <lockPath> [timeoutMs] | release <lockPath> <nonce> | fence-check <lockPath> <nonce> | --self-test');
    process.exit(1);
  }
}
