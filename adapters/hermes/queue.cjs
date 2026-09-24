#!/usr/bin/env node
// AxMem Hermes bridge — best-effort delivery queue. (P1 2.1, 2026-09-16)
// D10: single-direction stdout, no receipt channel from Hermes back to the
// bridge — "best-effort" is the honest ceiling here, not at-least-once and
// not exactly-once. Every structural operation (publish, drain-rename,
// recovery moves, quarantine moves, TTL sweeps, admission accounting) is
// linearized by ONE admission lock (lib/lock.cjs, D11 protocol) so the
// "never exceed the hard byte ceiling" guarantee holds even under
// concurrent producers/consumers/recovery passes.
//
// Directory layout under queueRoot:
//   .incoming/            durable staging; entries here never get renamed
//                         AWAY from .incoming except by (a) the producer's
//                         own publish step or (b) startup recovery.
//   <key>/                live per-session queue (key = sha256(session_id).slice(0,32))
//   <key>.draining-<u>/   mid-drain (renamed out of <key>/ under the lock,
//                         read/dedup/delete happen lock-free afterward)
//   unrouted/             sessionless records (missing/empty session_id)
//   quarantine/           malformed records found during drain
//   .admission.lock/      the D11 lock directory
//
// Hard limits (spec §2.1): 50 records / 64KB per session; 2MB global;
// quarantine capped at 100 (oldest dropped first). TTL judgment call (the
// spec names `queue-expired` and says unrouted "受 TTL" but does not pin a
// number): this file uses the SAME 10-minute window the spec DOES pin for
// `.incoming/*.tmp` and stale `*.draining-*` recovery, for one consistent
// constant across the whole queue rather than inventing a second number.
// Flagged explicitly in the builder report as a spec gap filled by judgment.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const lock = require('../../lib/lock.cjs');

const PER_SESSION_MAX_COUNT = 50;
const PER_SESSION_MAX_BYTES = 64 * 1024;
const GLOBAL_MAX_BYTES = 2 * 1024 * 1024;
const QUARANTINE_MAX = 100;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const CONTEXT_MAX_BYTES = 16 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 3000;

function keyForSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32);
}

function lockPathFor(queueRoot) {
  return path.join(queueRoot, '.admission.lock');
}

// D11 fencing (spec §1, §2.1; ECC ts/Opus acceptance H1): every entry point
// below holds the admission lock across its ENTIRE critical section, but
// D11 requires a nonce re-check immediately before EACH individual
// structural write/rename, not just once at acquire time — the defense is
// against a reclaim that raced in and republished `.admission.lock/` with a
// DIFFERENT nonce while we were still "inside" our held section (e.g. a
// slow filesystem call, a paused process). Returns true if still safe to
// proceed; false means the caller must abort immediately, write nothing
// more, and record `lock-fenced-abort`.
function fenceOrAbort(queueRoot, nonce, events) {
  if (lock.fenceCheck(lockPathFor(queueRoot), nonce)) return true;
  events.push({ event: 'lock-fenced-abort' });
  return false;
}

// M2 (ECC ts/Opus acceptance): claimLock()/releaseLock() surface their own
// diagnostic events (e.g. `lock-sweep-failed`) in their return value —
// every call site MUST fold those into whatever event list it returns,
// or the event can never reach the caller's ledger. Small helper so this
// isn't hand-rolled (and silently forgotten) at each of the four call sites.
function mergeEvents(target, source) {
  if (source && source.length) target.push(...source);
}

function ensureLayout(queueRoot) {
  for (const d of ['.incoming', 'unrouted', 'quarantine']) {
    fs.mkdirSync(path.join(queueRoot, d), { recursive: true });
  }
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function byteLenOfFile(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// Scan every counted location for a byte-exact snapshot (must run WHILE
// holding the admission lock — this is what makes it a snapshot rather than
// a race-prone estimate). Counted locations: live <key>/ dirs + .incoming +
// draining-* + unrouted + quarantine (spec: "统计集合 = live + incoming +
// draining + unrouted + quarantine").
function scanStats(queueRoot) {
  let entries;
  try {
    entries = fs.readdirSync(queueRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const perKey = new Map(); // key -> {count, bytes}
  let globalBytes = 0;
  // Reporting-only (Opus acceptance L2): quarantine has its OWN independent
  // cap enforced by dropOldestFromQuarantineIfOverCap(), so produce()'s
  // admission decision deliberately never reads this field — it exists so
  // doctor.cjs can report a quarantine count without a second directory
  // scan. Not dead code; just not an admission input.
  let quarantineCount = 0;

  function addDir(dir, keyName) {
    for (const f of listJsonFiles(dir)) {
      const sz = byteLenOfFile(path.join(dir, f));
      globalBytes += sz;
      if (keyName) {
        const cur = perKey.get(keyName) || { count: 0, bytes: 0 };
        cur.count += 1;
        cur.bytes += sz;
        perKey.set(keyName, cur);
      }
    }
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (name === '.incoming') { addDir(path.join(queueRoot, name), null); continue; }
    if (name === 'unrouted') { addDir(path.join(queueRoot, name), null); continue; }
    if (name === 'quarantine') {
      const qDir = path.join(queueRoot, name);
      quarantineCount = listJsonFiles(qDir).length;
      addDir(qDir, null);
      continue;
    }
    if (name.startsWith('.admission.lock')) continue; // the lock dir itself + its claim/released litter
    if (name.includes('.draining-')) {
      const key = name.split('.draining-')[0];
      addDir(path.join(queueRoot, name), key);
      continue;
    }
    // a plain <key>/ live directory
    addDir(path.join(queueRoot, name), name);
  }

  return { perKey, globalBytes, quarantineCount };
}

function dropOldestFromQuarantineIfOverCap(queueRoot, events) {
  const qDir = path.join(queueRoot, 'quarantine');
  const files = listJsonFiles(qDir).map((f) => {
    const full = path.join(qDir, f);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
    return { full, mtime };
  });
  if (files.length <= QUARANTINE_MAX) return;
  files.sort((a, b) => a.mtime - b.mtime);
  const excess = files.length - QUARANTINE_MAX;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(files[i].full); events.push({ event: 'quarantine-dropped', target: files[i].full }); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Produce (post_tool_call / on_session_start emit records here)
// ---------------------------------------------------------------------------

// record: { sessionId: string|null|undefined, kind: string, data: object }
// Returns { status: 'published', recordId } | { status: 'dropped', event }
function produce(queueRoot, record, opts = {}) {
  ensureLayout(queueRoot);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const key = keyForSession(record.sessionId);
  const lp = lockPathFor(queueRoot);
  const events = [];
  const claim = lock.claimLock(lp, { timeoutMs });
  mergeEvents(events, claim.events); // M2: surface e.g. lock-sweep-failed from the claim itself
  if (!claim.acquired) {
    return { status: 'dropped', event: 'queue-lock-timeout', events };
  }
  try {
    const recordId = crypto.randomUUID();
    // LOW (Opus acceptance, "produce() 展开顺序固定字段优先"): spread
    // record.data FIRST so our own protocol fields (record_id/key/kind/ts)
    // always win if the caller's data object happens to contain a
    // same-named key — a caller-supplied `key` or `record_id` must never be
    // able to override the ones this function computed.
    const payload = JSON.stringify({
      ...record.data,
      record_id: recordId,
      key: key || 'unrouted',
      kind: record.kind,
      ts: new Date().toISOString(),
    });
    const bytes = Buffer.byteLength(payload, 'utf8');

    const stats = scanStats(queueRoot);
    if (bytes > PER_SESSION_MAX_BYTES) {
      return { status: 'dropped', event: 'queue-admission-dropped', reason: 'record-exceeds-per-session-cap', events };
    }
    if (key) {
      const cur = stats.perKey.get(key) || { count: 0, bytes: 0 };
      if (cur.count + 1 > PER_SESSION_MAX_COUNT || cur.bytes + bytes > PER_SESSION_MAX_BYTES) {
        return { status: 'dropped', event: 'queue-admission-dropped', reason: 'per-session-cap', events };
      }
    }
    if (stats.globalBytes + bytes > GLOBAL_MAX_BYTES) {
      return { status: 'dropped', event: 'queue-admission-dropped', reason: 'global-cap', events };
    }

    if (!fenceOrAbort(queueRoot, claim.nonce, events)) return { status: 'dropped', event: 'lock-fenced-abort', events };

    // Admitted: write .incoming/<uuid>.tmp -> close -> read back verify -> rename to .json -> publish
    const tmpPath = path.join(queueRoot, '.incoming', `${recordId}.tmp`);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    const readBack = fs.readFileSync(tmpPath, 'utf8');
    if (readBack.length !== payload.length || readBack !== payload) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      return { status: 'dropped', event: 'queue-admission-dropped', reason: 'readback-mismatch', events };
    }

    if (!fenceOrAbort(queueRoot, claim.nonce, events)) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      return { status: 'dropped', event: 'lock-fenced-abort', events };
    }
    const incomingJson = path.join(queueRoot, '.incoming', `${recordId}.json`);
    fs.renameSync(tmpPath, incomingJson);

    if (!fenceOrAbort(queueRoot, claim.nonce, events)) {
      // Leave it in .incoming/*.json — startup recovery will republish it
      // once a legitimate holder is back in control; we must not touch the
      // destination directory after losing the fence.
      return { status: 'dropped', event: 'lock-fenced-abort', events };
    }
    const destDirName = key || 'unrouted';
    const destDir = path.join(queueRoot, destDirName);
    let published = true;
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(incomingJson, path.join(destDir, `${recordId}.json`));
    } catch {
      // Left behind in .incoming/ — startup recovery will republish it.
      published = false;
    }

    return {
      status: 'published',
      recordId,
      unrouted: !key,
      leftInIncoming: !published,
      events,
    };
  } finally {
    const rel = lock.releaseLock(lp, claim.nonce);
    mergeEvents(events, rel.events); // M2: e.g. lock-sweep-failed from the release-time sweep
  }
}

// ---------------------------------------------------------------------------
// Drain (pre_llm_call consumer)
// ---------------------------------------------------------------------------

function buildContextText(records) {
  // [codex(gf) LOW #7, 2026-09-17] The truncation marker used to be
  // appended AFTER the per-record loop had already spent the FULL
  // CONTEXT_MAX_BYTES budget, with zero bytes reserved for the marker
  // itself — reproduced directly: 2000 tiny 1-char records ->
  // {"contextBytes":16406,"cap":16384,"overCap":22}, 22 bytes over the
  // declared cap. Reserve headroom for the marker's own worst-case size
  // BEFORE deciding what fits, so the marker (when one turns out to be
  // needed) is guaranteed to land inside CONTEXT_MAX_BYTES too. A cheap
  // pre-pass over the already-formatted lines (no I/O, just
  // Buffer.byteLength) decides whether truncation will happen at all; if
  // it will, `records.length` is the correct worst-case `dropped` count
  // for sizing the reserve (the actual per-record loop below can only
  // ever drop at most that many).
  const lines = records.map((r) => formatRecordForContext(r));
  const totalIfUnbounded = lines.reduce((n, line) => n + Buffer.byteLength(line, 'utf8') + 1, 0);
  const willTruncate = totalIfUnbounded > CONTEXT_MAX_BYTES;
  const markerReserve = willTruncate ? Buffer.byteLength(JSON.stringify({ kind: 'truncated', dropped: records.length }), 'utf8') + 1 : 0;
  const budget = CONTEXT_MAX_BYTES - markerReserve;

  const parts = [];
  let usedBytes = 0;
  let truncatedCount = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (usedBytes + lineBytes > budget) { truncatedCount++; continue; }
    parts.push(line);
    usedBytes += lineBytes;
  }
  if (truncatedCount > 0) parts.push(JSON.stringify({ kind: 'truncated', dropped: truncatedCount }));
  return parts.join('\n');
}

function formatRecordForContext(r) {
  if (r.kind === 'write-gate') return `[axmem write-gate] ${r.file || ''}: ${r.excerpt || ''}`;
  if (r.kind === 'recall') return `[axmem recall] ${r.text || ''}`;
  if (r.kind === 'lamp') return `[axmem] ${r.text || ''}`;
  return `[axmem ${r.kind || 'unknown'}] ${JSON.stringify(r)}`;
}

// Moves a malformed file into quarantine/ — MUST run under the admission
// lock per spec ("malformed ⇒ 锁内移 quarantine/"). Caller passes an
// already-held claim's nonce is NOT reused here on purpose: the drain
// function releases the drain lock before reading file contents (spec:
// "锁外读取"), so quarantining a bad file found during that lock-free read
// re-acquires its own short-lived lock hold.
function quarantineMalformed(queueRoot, srcPath, basename, opts = {}) {
  const lp = lockPathFor(queueRoot);
  const events = [];
  const claim = lock.claimLock(lp, { timeoutMs: opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS });
  mergeEvents(events, claim.events);
  if (!claim.acquired) { events.push({ event: 'queue-lock-timeout' }); return events; }
  try {
    if (!fenceOrAbort(queueRoot, claim.nonce, events)) return events;
    const qDir = path.join(queueRoot, 'quarantine');
    fs.mkdirSync(qDir, { recursive: true });
    try {
      fs.renameSync(srcPath, path.join(qDir, basename));
      events.push({ event: 'record-malformed', target: basename });
    } catch { /* already gone — fine */ }
    dropOldestFromQuarantineIfOverCap(queueRoot, events);
  } finally {
    const rel = lock.releaseLock(lp, claim.nonce);
    mergeEvents(events, rel.events);
  }
  return events;
}

// Returns { context: string|null, events: [...] }
// M1 (spec §2.1 v8.1, ECC ts/Opus acceptance M1): returns { context, events,
// commit } — commit() deletes the draining directory and MUST be called by
// the caller only AFTER it has written stdout and that write has been
// flushed. Deleting the draining dir before stdout is written turns a
// crash between the two steps from "possibly re-delivered" (the draining
// dir is still there for startup recovery's draining-recovered path) into
// "silently lost forever" (nothing left to recover) — the opposite of
// D10's documented failure mode. drain() itself never deletes anything.
function drain(queueRoot, sessionId, opts = {}) {
  ensureLayout(queueRoot);
  const events = [];
  const key = keyForSession(sessionId);
  const noopCommit = () => {};
  if (!key) return { context: null, events, commit: noopCommit }; // nothing to drain without a routable key

  const lp = lockPathFor(queueRoot);
  const claim = lock.claimLock(lp, { timeoutMs: opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS });
  mergeEvents(events, claim.events);
  if (!claim.acquired) { events.push({ event: 'queue-lock-timeout' }); return { context: null, events, commit: noopCommit }; }

  let drainingDir = null;
  try {
    if (!fenceOrAbort(queueRoot, claim.nonce, events)) return { context: null, events, commit: noopCommit };
    const liveDir = path.join(queueRoot, key);
    if (!fs.existsSync(liveDir)) return { context: null, events, commit: noopCommit };
    const uuid = crypto.randomUUID();
    drainingDir = path.join(queueRoot, `${key}.draining-${uuid}`);
    try {
      fs.renameSync(liveDir, drainingDir);
    } catch {
      drainingDir = null; // rename failed (handle occupied / dir vanished) -> zero output, no retry
      return { context: null, events, commit: noopCommit };
    }
  } finally {
    const rel = lock.releaseLock(lp, claim.nonce);
    mergeEvents(events, rel.events);
  }

  if (!drainingDir) return { context: null, events, commit: noopCommit };

  // Lock-free read + in-process (same-drain) dedup by record_id.
  const files = listJsonFiles(drainingDir);
  const seen = new Set();
  const records = [];
  for (const f of files) {
    const full = path.join(drainingDir, f);
    let raw;
    try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
    let rec;
    try { rec = JSON.parse(raw); } catch { events.push(...quarantineMalformed(queueRoot, full, f, opts)); continue; }
    if (!rec || typeof rec !== 'object' || !rec.record_id) { events.push(...quarantineMalformed(queueRoot, full, f, opts)); continue; }
    if (seen.has(rec.record_id)) continue;
    seen.add(rec.record_id);
    records.push(rec);
  }

  const context = records.length ? buildContextText(records) : null;
  const finalDrainingDir = drainingDir;
  let committed = false;
  const commit = () => {
    if (committed) return; // idempotent — a caller calling commit() twice must not throw
    committed = true;
    // Draining dir belongs solely to this drain call — delete without the lock.
    try { fs.rmSync(finalDrainingDir, { recursive: true, force: true }); } catch { /* best-effort; startup recovery mops up stale draining-* */ }
  };

  return { context, events, commit };
}

// ---------------------------------------------------------------------------
// Startup recovery (every bridge process invocation, before dispatching)
// ---------------------------------------------------------------------------

function recoverOnStartup(queueRoot, opts = {}) {
  ensureLayout(queueRoot);
  const events = [];
  const lp = lockPathFor(queueRoot);
  const claim = lock.claimLock(lp, { timeoutMs: opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS });
  mergeEvents(events, claim.events);
  if (!claim.acquired) { events.push({ event: 'queue-lock-timeout' }); return events; }
  try {
    const now = Date.now();
    const incomingDir = path.join(queueRoot, '.incoming');

    // .incoming/*.json -> republish through the same admission accounting.
    let incomingEntries = [];
    try { incomingEntries = fs.readdirSync(incomingDir); } catch { /* ignore */ }
    for (const f of incomingEntries) {
      if (!fenceOrAbort(queueRoot, claim.nonce, events)) return events; // H1: re-check before every file's structural move
      const full = path.join(incomingDir, f);
      if (f.endsWith('.tmp')) {
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        if (now - mtime > TEN_MINUTES_MS) {
          try { fs.unlinkSync(full); events.push({ event: 'queue-tmp-dropped', target: f }); } catch { /* best-effort */ }
        }
        continue;
      }
      if (!f.endsWith('.json')) continue;
      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
      let rec;
      try { rec = JSON.parse(raw); } catch {
        const qDir = path.join(queueRoot, 'quarantine');
        fs.mkdirSync(qDir, { recursive: true });
        try { fs.renameSync(full, path.join(qDir, f)); events.push({ event: 'record-malformed', target: f }); } catch { /* ignore */ }
        dropOldestFromQuarantineIfOverCap(queueRoot, events);
        continue;
      }
      const bytes = Buffer.byteLength(raw, 'utf8');
      const stats = scanStats(queueRoot);
      const key = rec.key && rec.key !== 'unrouted' ? rec.key : null;
      let admit = true;
      if (key) {
        // perKey NEVER includes .incoming/ (scanStats' addDir call for
        // .incoming passes keyName=null) — this file, still sitting in
        // .incoming right now, has not yet been counted under `key`, so
        // adding `bytes` on top of the live <key>/ dir's current total is
        // correct here: it's the first time this byte count would land
        // under this key.
        const cur = stats.perKey.get(key) || { count: 0, bytes: 0 };
        if (cur.count + 1 > PER_SESSION_MAX_COUNT || cur.bytes + bytes > PER_SESSION_MAX_BYTES) admit = false;
      }
      // [codex HIGH #1, 2026-09-17] globalBytes, unlike perKey, DOES
      // already include every .incoming/*.json file (scanStats' addDir
      // call for .incoming passes null but still accumulates into
      // globalBytes) — this exact file is already counted once in
      // `stats.globalBytes`. Recovery only MOVES a record between two
      // counted locations (.incoming -> <key>/); it never adds new bytes
      // to the queue's total footprint. Adding `bytes` again here double
      // counted this file, and at/near the global cap that silently
      // unlinkSync()'d a legitimate, already-durable record forever.
      // Reproduced directly: 31 live 64KB records + 1 in .incoming (32 *
      // 65536 = exactly GLOBAL_MAX_BYTES) -> old code computed
      // 2097152 + 65536 = 2162688 > 2097152 and dropped the orphan;
      // fixed code correctly checks 2097152 > 2097152 = false, admits it.
      if (stats.globalBytes > GLOBAL_MAX_BYTES) admit = false;
      if (!admit) {
        try { fs.unlinkSync(full); } catch { /* best-effort */ }
        events.push({ event: 'queue-admission-dropped', target: f, reason: 'recovery-republish' });
        continue;
      }
      const destDir = path.join(queueRoot, key || 'unrouted');
      fs.mkdirSync(destDir, { recursive: true });
      try { fs.renameSync(full, path.join(destDir, f)); } catch { /* leave for next pass */ }
    }

    // Stale *.draining-*/ (mtime > 10min) -> move its .json files back to <key>/, record draining-recovered.
    let rootEntries = [];
    try { rootEntries = fs.readdirSync(queueRoot, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of rootEntries) {
      if (!e.isDirectory() || !e.name.includes('.draining-')) continue;
      if (!fenceOrAbort(queueRoot, claim.nonce, events)) return events;
      const drDir = path.join(queueRoot, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(drDir).mtimeMs; } catch { continue; }
      if (now - mtime <= TEN_MINUTES_MS) continue;
      const key = e.name.split('.draining-')[0];
      const destDir = path.join(queueRoot, key);
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of listJsonFiles(drDir)) {
        try {
          fs.renameSync(path.join(drDir, f), path.join(destDir, f));
          events.push({ event: 'draining-recovered', target: f, from: e.name });
        } catch { /* best-effort */ }
      }
      try { fs.rmSync(drDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    // unrouted/ TTL sweep (judgment call — see file header comment).
    const unroutedDir = path.join(queueRoot, 'unrouted');
    for (const f of listJsonFiles(unroutedDir)) {
      if (!fenceOrAbort(queueRoot, claim.nonce, events)) return events;
      const full = path.join(unroutedDir, f);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
      if (now - mtime > TEN_MINUTES_MS) {
        try { fs.unlinkSync(full); events.push({ event: 'queue-expired', target: f }); } catch { /* best-effort */ }
      }
    }
  } finally {
    const rel = lock.releaseLock(lp, claim.nonce);
    mergeEvents(events, rel.events);
  }
  return events;
}

module.exports = {
  keyForSession,
  scanStats,
  produce,
  drain,
  recoverOnStartup,
  quarantineMalformed,
  PER_SESSION_MAX_COUNT,
  PER_SESSION_MAX_BYTES,
  GLOBAL_MAX_BYTES,
  QUARANTINE_MAX,
  TEN_MINUTES_MS,
  CONTEXT_MAX_BYTES,
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------
function totalOnDiskBytes(queueRoot) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(queueRoot, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.admission.lock')) continue;
    const dir = path.join(queueRoot, e.name);
    for (const f of listJsonFiles(dir)) total += byteLenOfFile(path.join(dir, f));
    // .incoming also holds *.tmp — count those too for a true on-disk total
    if (e.name === '.incoming') {
      let inc = [];
      try { inc = fs.readdirSync(dir); } catch { /* ignore */ }
      for (const f of inc) if (f.endsWith('.tmp')) total += byteLenOfFile(path.join(dir, f));
    }
  }
  return total;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function selfTest() {
  const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'axmem-queue-selftest-'));
  let ok = 0;
  const results = [];
  function check(name, cond) {
    if (cond) { ok++; results.push(`  ok   ${name}`); } else { results.push(`  FAIL ${name}`); }
  }

  // 0 (mutation-arm coverage gap closed): the queue key must be a sha256
  // digest, never the raw session_id — a raw session_id landing in a
  // directory NAME would leak session identifiers into filesystem
  // listings/paths and, more importantly, this specific check is what a
  // "队列键改用原始sid" mutation must turn red (an earlier manual mutation
  // test proved the FUNCTIONAL round-trip tests below don't care whether
  // the key is hashed or raw, since they only ever compare a key against
  // itself — this assertion is the one that actually distinguishes them).
  {
    const k = keyForSession('some-session-id');
    check('0 queue key is a 32-hex-char sha256 prefix, never the raw session_id', /^[0-9a-f]{32}$/.test(k) && k !== 'some-session-id');
  }

  // 1. basic produce -> drain round trip. Also proves M1 (spec v8.1): the
  // draining directory MUST survive until commit() is explicitly called —
  // drain() itself must never delete it (that was the bug: deleting BEFORE
  // the caller's stdout write turns a recoverable "possible duplicate"
  // crash window into an unrecoverable "silent loss" one).
  {
    const qr = path.join(T, 'q1');
    const p = produce(qr, { sessionId: 'sess-a', kind: 'recall', data: { text: 'hello' } });
    const d = drain(qr, 'sess-a');
    const key = keyForSession('sess-a');
    const drainingDirsBeforeCommit = fs.readdirSync(qr).filter((n) => n.startsWith(`${key}.draining-`));
    const survivedBeforeCommit = drainingDirsBeforeCommit.length === 1 && fs.existsSync(path.join(qr, drainingDirsBeforeCommit[0]));
    d.commit();
    const goneAfterCommit = drainingDirsBeforeCommit.length === 1 && !fs.existsSync(path.join(qr, drainingDirsBeforeCommit[0]));
    check(
      '1 basic produce->drain round trip; M1: draining dir survives until commit() is called, then is removed',
      p.status === 'published' && d.context && d.context.includes('hello') && typeof d.commit === 'function' && survivedBeforeCommit && goneAfterCommit
    );
  }

  // 2. pre before post -> zero output, record stays for the NEXT drain
  {
    const qr = path.join(T, 'q2');
    const d1 = drain(qr, 'sess-b'); // nothing produced yet
    d1.commit();
    const p = produce(qr, { sessionId: 'sess-b', kind: 'recall', data: { text: 'later' } });
    const d2 = drain(qr, 'sess-b');
    d2.commit();
    check('2 pre-before-post is zero output; record survives to next drain', d1.context === null && p.status === 'published' && d2.context && d2.context.includes('later'));
  }

  // 3. dedup by record_id within one drain (two files, same record_id)
  {
    const qr = path.join(T, 'q3');
    const key = keyForSession('sess-c');
    fs.mkdirSync(path.join(qr, key), { recursive: true });
    const rec = { record_id: 'dup-1', key, kind: 'recall', ts: new Date().toISOString(), text: 'once' };
    fs.writeFileSync(path.join(qr, key, 'a.json'), JSON.stringify(rec));
    fs.writeFileSync(path.join(qr, key, 'b.json'), JSON.stringify(rec));
    const d = drain(qr, 'sess-c');
    d.commit();
    const onceCount = (d.context.match(/once/g) || []).length;
    check('3 same-drain dedup by record_id', onceCount === 1);
  }

  // 4. empty/missing session_id -> unrouted, no <key> dir
  {
    const qr = path.join(T, 'q4');
    const p1 = produce(qr, { sessionId: '', kind: 'recall', data: { text: 'x' } });
    const p2 = produce(qr, { sessionId: undefined, kind: 'recall', data: { text: 'y' } });
    const unroutedCount = listJsonFiles(path.join(qr, 'unrouted')).length;
    check('4 empty/missing session_id -> unrouted, never a shared key dir', p1.unrouted && p2.unrouted && unroutedCount === 2);
  }

  // 5. malformed record found during drain -> quarantined
  {
    const qr = path.join(T, 'q5');
    const key = keyForSession('sess-e');
    fs.mkdirSync(path.join(qr, key), { recursive: true });
    fs.writeFileSync(path.join(qr, key, 'bad.json'), '{not json');
    const d = drain(qr, 'sess-e');
    d.commit();
    const quarantined = listJsonFiles(path.join(qr, 'quarantine'));
    check('5 malformed record -> quarantined, drain still zero-output for it', d.context === null && quarantined.length === 1);
  }

  // 6. lock-timeout on the producer side: hold the lock externally, verify
  // produce() drops with queue-lock-timeout and leaves nothing durable.
  {
    const qr = path.join(T, 'q6');
    ensureLayout(qr);
    const lp = lockPathFor(qr);
    const claim = lock.claimLock(lp, { timeoutMs: 1000 });
    const p = produce(qr, { sessionId: 'sess-f', kind: 'recall', data: { text: 'never' } }, { timeoutMs: 300 });
    lock.releaseLock(lp, claim.nonce);
    const leftovers = fs.existsSync(path.join(qr, '.incoming')) ? fs.readdirSync(path.join(qr, '.incoming')).length : 0;
    check('6 producer lock-timeout drops with queue-lock-timeout, nothing left durable', claim.acquired && p.status === 'dropped' && p.event === 'queue-lock-timeout' && leftovers === 0);
  }

  // 7. .incoming/*.json leftover (simulating a crash between publish-write
  //    and the destination rename) is republished on startup recovery.
  {
    const qr = path.join(T, 'q7');
    ensureLayout(qr);
    const key = keyForSession('sess-g');
    const rec = { record_id: 'orphan-1', key, kind: 'recall', ts: new Date().toISOString(), text: 'orphaned' };
    fs.writeFileSync(path.join(qr, '.incoming', 'orphan-1.json'), JSON.stringify(rec));
    const events = recoverOnStartup(qr);
    const republished = fs.existsSync(path.join(qr, key, 'orphan-1.json'));
    check('7 .incoming/*.json leftover republished by startup recovery', republished);
  }

  // 8. .incoming/*.tmp older than 10min -> deleted + queue-tmp-dropped
  {
    const qr = path.join(T, 'q8');
    ensureLayout(qr);
    const tmpPath = path.join(qr, '.incoming', 'stale.tmp');
    fs.writeFileSync(tmpPath, 'partial');
    const old = (Date.now() - 11 * 60 * 1000) / 1000;
    fs.utimesSync(tmpPath, old, old);
    const events = recoverOnStartup(qr);
    check('8 stale .tmp (>10min) dropped with queue-tmp-dropped', !fs.existsSync(tmpPath) && events.some((e) => e.event === 'queue-tmp-dropped'));
  }

  // 9. stale *.draining-*/ (mtime > 10min) recovered back to <key>/, draining-recovered recorded
  {
    const qr = path.join(T, 'q9');
    ensureLayout(qr);
    const key = keyForSession('sess-i');
    const drDir = path.join(qr, `${key}.draining-stale-uuid`);
    fs.mkdirSync(drDir, { recursive: true });
    const rec = { record_id: 'stuck-1', key, kind: 'recall', ts: new Date().toISOString(), text: 'stuck' };
    fs.writeFileSync(path.join(drDir, 'stuck-1.json'), JSON.stringify(rec));
    const old = (Date.now() - 11 * 60 * 1000) / 1000;
    fs.utimesSync(drDir, old, old);
    const events = recoverOnStartup(qr);
    const recovered = fs.existsSync(path.join(qr, key, 'stuck-1.json'));
    check('9 stale draining-* recovered to <key>/ with draining-recovered event', recovered && events.some((e) => e.event === 'draining-recovered') && !fs.existsSync(drDir));
  }

  // 10. context truncation at 16KB with a trailing {kind:'truncated', dropped:n}
  {
    const qr = path.join(T, 'q10');
    const key = keyForSession('sess-j');
    fs.mkdirSync(path.join(qr, key), { recursive: true });
    const bigText = 'x'.repeat(2000);
    for (let i = 0; i < 20; i++) {
      const rec = { record_id: `big-${i}`, key, kind: 'recall', ts: new Date().toISOString(), text: bigText };
      fs.writeFileSync(path.join(qr, key, `big-${i}.json`), JSON.stringify(rec));
    }
    const d = drain(qr, 'sess-j');
    d.commit();
    const withinCap = Buffer.byteLength(d.context, 'utf8') <= CONTEXT_MAX_BYTES;
    const hasTruncMarker = /"kind":"truncated"/.test(d.context);
    check('10 context capped at 16KB with a truncated marker', withinCap && hasTruncMarker);
  }

  // 10b (codex(gf) LOW #7). Test 10's fixed 2000-byte records happen to
  // leave enough headroom that the marker always fit even before this fix
  // — a real blind spot codex named directly. MANY tiny (1-char) records
  // let usedBytes land much closer to CONTEXT_MAX_BYTES before the loop
  // stops accepting more, leaving far less slack for the marker itself.
  // Reproduced directly against the pre-fix logic: 2000 1-char records ->
  // {"contextBytes":16406,"cap":16384,"overCap":22}.
  {
    const qr = path.join(T, 'q10b');
    const key = keyForSession('sess-j2');
    fs.mkdirSync(path.join(qr, key), { recursive: true });
    for (let i = 0; i < 2000; i++) {
      const rec = { record_id: `tiny-${i}`, key, kind: 'recall', ts: new Date().toISOString(), text: 'x' };
      fs.writeFileSync(path.join(qr, key, `tiny-${i}.json`), JSON.stringify(rec));
    }
    const d = drain(qr, 'sess-j2');
    d.commit();
    const withinCap = Buffer.byteLength(d.context, 'utf8') <= CONTEXT_MAX_BYTES;
    const hasTruncMarker = /"kind":"truncated"/.test(d.context);
    check('10b (codex(gf) LOW #7) many tiny records: context (INCLUDING the truncated marker) still stays within CONTEXT_MAX_BYTES', withinCap && hasTruncMarker);
  }

  // 11. quarantine cap at 100 -> oldest dropped first, quarantine-dropped recorded
  {
    const qr = path.join(T, 'q11');
    ensureLayout(qr);
    const qDir = path.join(qr, 'quarantine');
    for (let i = 0; i < 100; i++) {
      const f = path.join(qDir, `q-${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(f, '{}');
      const t = (Date.now() - (100 - i) * 1000) / 1000; // ascending mtimes, i=0 oldest
      fs.utimesSync(f, t, t);
    }
    const events = [];
    dropOldestFromQuarantineIfOverCap(qr, events); // exactly at cap: no-op
    const atCapNoop = events.length === 0 && listJsonFiles(qDir).length === 100;
    fs.writeFileSync(path.join(qDir, 'q-101.json'), '{}'); // now 101, over cap by 1
    const events2 = [];
    dropOldestFromQuarantineIfOverCap(qr, events2);
    const oldestGone = !fs.existsSync(path.join(qDir, 'q-000.json'));
    check('11 quarantine cap at 100, oldest dropped first', atCapNoop && oldestGone && listJsonFiles(qDir).length === 100 && events2.some((e) => e.event === 'quarantine-dropped'));
  }

  // 11b (H1, ECC ts/Opus acceptance): fencing in produce() — externally
  // replace the admission lock's owner.json mid-hold, immediately before
  // the record would be written, and confirm produce() aborts with
  // lock-fenced-abort rather than writing anything. This is the specific
  // gap Opus's acceptance review found: fenceCheck existed in lib/lock.cjs
  // and was used by restore.cjs, but had ZERO call sites anywhere in this
  // file — meaning `lock-fenced-abort` could never actually be emitted by
  // the queue side, regardless of what the ledger event list claimed.
  // Since produce() holds the lock for its whole critical section (we
  // can't inject a replacement WHILE it's running without a second
  // process), this proves the mechanism by monkey-patching fenceCheck for
  // the duration of one call — a legitimate way to unit-test a guard whose
  // real trigger condition (a second process's reclaim racing in during
  // our OWN held section) is only reachable via true multi-process timing.
  {
    const qr = path.join(T, 'q11b');
    const originalFenceCheck = lock.fenceCheck;
    let calls = 0;
    lock.fenceCheck = (...args) => { calls++; return false; }; // simulate "someone else now owns this lock"
    let p;
    try {
      p = produce(qr, { sessionId: 'sess-fence', kind: 'recall', data: { text: 'must-not-land' } });
    } finally {
      lock.fenceCheck = originalFenceCheck;
    }
    const key = keyForSession('sess-fence');
    const nothingPublished = !fs.existsSync(path.join(qr, key));
    const incomingEmpty = !fs.existsSync(path.join(qr, '.incoming')) || fs.readdirSync(path.join(qr, '.incoming')).length === 0;
    check(
      '11b (H1) produce() aborts with lock-fenced-abort when fenceCheck fails, writes nothing',
      calls > 0 && p.status === 'dropped' && p.event === 'lock-fenced-abort' && nothingPublished && incomingEmpty
    );
  }

  // 11c (H1). Same proof for drain(): fencing must gate the live-dir ->
  // draining-dir rename too.
  {
    const qr = path.join(T, 'q11c');
    const key = keyForSession('sess-fence2');
    fs.mkdirSync(path.join(qr, key), { recursive: true });
    fs.writeFileSync(path.join(qr, key, 'x.json'), JSON.stringify({ record_id: 'x', key, kind: 'recall', ts: new Date().toISOString(), text: 'hi' }));
    const originalFenceCheck = lock.fenceCheck;
    lock.fenceCheck = () => false;
    let d;
    try {
      d = drain(qr, 'sess-fence2');
    } finally {
      lock.fenceCheck = originalFenceCheck;
    }
    const liveDirUntouched = fs.existsSync(path.join(qr, key)) && fs.readdirSync(path.join(qr, key)).length === 1;
    check(
      '11c (H1) drain() aborts with lock-fenced-abort when fenceCheck fails, live dir untouched',
      d.context === null && d.events.some((e) => e.event === 'lock-fenced-abort') && liveDirUntouched
    );
  }

  // 11d (H1). Same proof for recoverOnStartup(): must abort mid-batch and
  // stop touching further files the instant fencing fails.
  {
    const qr = path.join(T, 'q11d');
    ensureLayout(qr);
    const key = keyForSession('sess-fence3');
    fs.writeFileSync(path.join(qr, '.incoming', 'orphan-fence.json'), JSON.stringify({ record_id: 'orphan-fence', key, kind: 'recall', ts: new Date().toISOString(), text: 'x' }));
    const originalFenceCheck = lock.fenceCheck;
    lock.fenceCheck = () => false;
    let events;
    try {
      events = recoverOnStartup(qr);
    } finally {
      lock.fenceCheck = originalFenceCheck;
    }
    const stillInIncoming = fs.existsSync(path.join(qr, '.incoming', 'orphan-fence.json'));
    check(
      '11d (H1) recoverOnStartup() aborts with lock-fenced-abort, leaves the batch untouched',
      events.some((e) => e.event === 'lock-fenced-abort') && stillInIncoming
    );
  }

  // 11e (H3/L5, ECC ts/Opus acceptance mutation-arm fix: "准入检查移到落盘之后").
  // Directly asserts the ordering invariant the earlier mutation test
  // exposed as untested: a record refused by admission (here, forced via a
  // record larger than the per-session cap) must leave ZERO residue in
  // .incoming/ — no .tmp, no .json. If the admission check ever moved to
  // AFTER a provisional write (the mutation Opus applied), this specific
  // assertion is what would catch it; the old suite had no such check.
  {
    const qr = path.join(T, 'q11e');
    const oversized = 'y'.repeat(PER_SESSION_MAX_BYTES + 1000);
    const p = produce(qr, { sessionId: 'sess-oversized', kind: 'recall', data: { text: oversized } });
    const incomingResidue = fs.existsSync(path.join(qr, '.incoming')) ? fs.readdirSync(path.join(qr, '.incoming')) : [];
    check(
      '11e (H3/L5) a record rejected by admission leaves zero residue in .incoming/',
      p.status === 'dropped' && p.event === 'queue-admission-dropped' && incomingResidue.length === 0
    );
  }

  // 12 (§9.6). 40 concurrent producers x 64KB each, barrier-released; report
  // actual peak (10ms sampling), success/drop/timeout counts, assert peak <=
  // 2MB + 64KB (spec's explicit ceiling: the hard global cap plus at most
  // one in-flight record's worth of slack for the sampler's granularity).
  {
    const qr = path.join(T, 'q12');
    ensureLayout(qr);
    const N = 40;
    const barrier = path.join(T, 'q12-go');
    const perRecordPayloadBytes = 64 * 1024 - 200; // leave room for JSON wrapper keys so the on-disk record lands close to 64KB
    const children = [];
    for (let i = 0; i < N; i++) {
      const resultFile = path.join(T, `q12-result-${i}.json`);
      const child = require('child_process').spawn(
        process.execPath,
        [__filename, '__produce-once', qr, resultFile, barrier, String(i), String(perRecordPayloadBytes)],
        { stdio: 'ignore' }
      );
      children.push({ child, resultFile });
    }
    let peak = 0;
    const sampleStart = Date.now();
    const samples = [];
    const samplerTimer = setInterval(() => {
      const cur = totalOnDiskBytes(qr);
      samples.push(cur);
      if (cur > peak) peak = cur;
    }, 10);
    fs.writeFileSync(barrier, 'go');
    const deadline = Date.now() + 20000;
    // Async polling (NOT a synchronous busy-wait): a blocking loop here
    // would starve the Node event loop, so BOTH the setInterval sampler
    // above and the children's 'exit' notifications would never fire until
    // the loop exited — silently producing a "0 samples, everyone timed
    // out" false reading (caught empirically while building this test: the
    // very first run showed exactly that failure mode).
    while (children.some((c) => c.child.exitCode === null && !c.child.killed) && Date.now() < deadline) {
      await delay(15);
    }
    clearInterval(samplerTimer);
    // one more sample after all children have exited, in case the peak
    // landed in the gap between the last interval tick and process exit
    const finalOnDisk = totalOnDiskBytes(qr);
    if (finalOnDisk > peak) peak = finalOnDisk;

    let successes = 0, drops = 0, timeouts = 0, unknown = 0;
    for (const c of children) {
      try {
        const r = JSON.parse(fs.readFileSync(c.resultFile, 'utf8'));
        if (r.status === 'published') successes++;
        else if (r.event === 'queue-lock-timeout') timeouts++;
        else if (r.status === 'dropped') drops++;
        else unknown++;
      } catch { unknown++; }
    }
    const ceiling = GLOBAL_MAX_BYTES + PER_SESSION_MAX_BYTES;
    const ratioPct = ((peak / ceiling) * 100).toFixed(1);
    // spec v8.1 §10 / Opus lesson 1: every boundary/ceiling assertion must
    // report how close it actually came to the limit it claims to guard —
    // a peak/ceiling ratio under 10% means the run proved almost nothing
    // about the ceiling itself (this exact test scored 6% before the M4
    // lock-contention fix; H2 was opened specifically because of that).
    results.push(`  -- §9.6 40x64KB barrier: peak=${peak}B ceiling=${ceiling}B ratio=${ratioPct}% (>=10% required to count as a real ceiling test) samples=${samples.length} (10ms interval) success=${successes} dropped=${drops} lock-timeout=${timeouts} unparsed=${unknown} elapsed=${Date.now() - sampleStart}ms`);
    check('12 (§9.6) peak on-disk bytes under 40x64KB barrier stays <= 2MB + 64KB, AND ratio >= 10% (ceiling genuinely approached, not a vacuous pass)', peak <= ceiling && successes + drops + timeouts + unknown === N && peak / ceiling >= 0.10);
  }

  // 13 (codex HIGH #1, 2026-09-17). recoverOnStartup()'s global-cap check
  // used to double-count a .incoming/*.json file's bytes (scanStats()
  // already includes .incoming in globalBytes; the old code then added
  // `bytes` again before comparing to GLOBAL_MAX_BYTES) -- at/near the
  // global cap this permanently unlinkSync()'d a legitimate, durable
  // record instead of republishing it. 31 live records (one per distinct
  // key, each exactly PER_SESSION_MAX_BYTES) + 1 more sitting in
  // .incoming (also exactly PER_SESSION_MAX_BYTES) sums to EXACTLY
  // GLOBAL_MAX_BYTES (32 * 65536 = 2097152) -- admissible under the
  // correct single-count check, but tips over under the old
  // double-counted one. Asserts the full record SET and total bytes are
  // identical before and after recovery (a pure move, nothing lost,
  // nothing gained), not just that this one record survived.
  {
    const qr = path.join(T, 'q13');
    fs.mkdirSync(path.join(qr, '.incoming'), { recursive: true });
    const mkExactPayload = (key, size) => {
      const base = { key, kind: 'recall', record_id: 'r', ts: '2026-01-01T00:00:00.000Z', text: '' };
      const baseLen = Buffer.byteLength(JSON.stringify(base), 'utf8');
      base.text = 'x'.repeat(Math.max(0, size - baseLen));
      return JSON.stringify(base);
    };
    // Recursive *.json count across the whole queue tree (excluding the
    // lock dir), independent of WHICH location each record currently
    // sits in -- a record legitimately MOVES during recovery (.incoming
    // -> <key>/), so counting by location would conflate "moved" with
    // "lost"/"gained". This is the real "record set size identical"
    // check the earlier, buggy version of this test never actually did.
    const countAllRecords = (dir) => {
      let count = 0;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
      for (const e of entries) {
        if (e.name.startsWith('.admission.lock')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) count += countAllRecords(full);
        else if (e.name.endsWith('.json')) count += 1;
      }
      return count;
    };
    const keys = [];
    for (let i = 0; i < 31; i++) {
      const key = `q13key-${i}`;
      keys.push(key);
      const dir = path.join(qr, key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'rec.json'), mkExactPayload(key, PER_SESSION_MAX_BYTES));
    }
    const lastKey = 'q13key-31';
    fs.writeFileSync(path.join(qr, '.incoming', 'orphan-32.json'), mkExactPayload(lastKey, PER_SESSION_MAX_BYTES));

    const before = scanStats(qr);
    const beforeRecordCount = countAllRecords(qr);
    recoverOnStartup(qr);
    const after = scanStats(qr);
    const afterRecordCount = countAllRecords(qr);
    const orphanRepublished = fs.existsSync(path.join(qr, lastKey, 'orphan-32.json'));
    const nothingElseLost = keys.every((k) => fs.existsSync(path.join(qr, k, 'rec.json')));
    check(
      '13 (codex HIGH #1) 31 live + 1 .incoming, all exactly at GLOBAL_MAX_BYTES combined -> recovery republishes the orphan (not dropped), byte total and record count identical before/after',
      before.globalBytes === GLOBAL_MAX_BYTES && after.globalBytes === before.globalBytes
        && beforeRecordCount === 32 && afterRecordCount === 32
        && orphanRepublished && nothingElseLost
    );
  }

  console.log(results.join('\n'));
  console.log(`queue self-test ${ok}/19`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok === 19 ? 0 : 1;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    selfTest().then((rc) => process.exit(rc));
  } else if (argv[0] === '__produce-once') {
    const [, qr, resultFile, barrier, idx, payloadBytes] = argv;
    const start = Date.now();
    while (!fs.existsSync(barrier) && Date.now() - start < 5000) { /* spin-wait */ }
    const data = { text: 'X'.repeat(Number(payloadBytes)) };
    let result;
    try {
      result = produce(qr, { sessionId: `race-sess-${idx}`, kind: 'recall', data }, { timeoutMs: 8000 });
    } catch (e) {
      result = { status: 'error', error: e.message };
    }
    fs.writeFileSync(resultFile, JSON.stringify(result));
    process.exit(0);
  } else {
    console.error('usage: queue.cjs --self-test');
    process.exit(1);
  }
}
