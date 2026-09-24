#!/usr/bin/env node
// pmm-recall-ledger.cjs — shared v3 ledger module (共用台账 v3).
//
// specs/RECALL-LOOP-M-SPEC-v2.md 附录 A (schema v3, 21 列, 双 id 公式, 写侧不去
// 重/读侧去重, events-v3-<host>.tsv, session-end) + specs/PIPE-GATE-V2-REPAIR-
// BRIEF.md §5/§11.3 (gate_instance_id 按 gate 种类钉死见 §17, ordinal 公式见
// §11.3 改句). This is the ONE module both pmm-bash-impression.cjs (M0 impression
// hook) and bash-pipe-exitcode-watch.cjs (pipe gate v2, PreToolUse/PostToolUse/
// SessionEnd) write through, so the two hooks can never drift onto two
// different ledger shapes.
//
// Exported surface: COLUMNS, QUEUE_COLUMNS, NUL, sha16, seenKey, resolveHome, defaultRoot,
// resolveRoot, sanitize, impressionId, ordinalOf, eventId, ledgerPath,
// queuePath, writeFailuresPath, quarantinePath, isPoisonedSid, writeEvent,
// writeQueue, writeSessionEnd.
// (seenKey added C05-BUILD-SPEC B1 -- see its own comment above.)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// v3 columns, verbatim, in order (M-SPEC 附录 A / 简报 §5): 21 columns.
const COLUMNS = [
  'schema_version', 'ts', 'sid_sha16', 'agent_sha16', 'agent_type', 'prompt_id',
  'tool_use_id', 'impression_id', 'event_id', 'event_kind', 'gate', 'confidence',
  'class_tag', 'trigger_or_gate_id', 'cmd_sha16', 'parser_version', 'mode',
  'run_provenance', 'sanitized', 'id_missing', 'agent_id_missing',
];

// M1 queue header, verbatim (M-SPEC 附录 A 末行 / 简报 §11.3): the M0 'tag'
// column is renamed trigger_or_gate_id in this same commit.
const QUEUE_COLUMNS = ['impression_id', 'trigger_or_gate_id', 'class_tag', 'exe', 'sub', 'ts', 'snippet'];

// hash-field separator (NUL) — a plain JS expression, matching the sibling
// hooks' own convention of avoiding a literal \u0000 escape sequence in a
// string that tooling sometimes mishandles.
const NUL = String.fromCharCode(0);

function sha16(s) {
  return crypto.createHash('sha256').update(String(s === undefined || s === null ? '' : s), 'utf8').digest('hex').slice(0, 16);
}

// seenKey(sessionId, agentId) — C05-BUILD-SPEC B1 row 1 / M-SPEC 附录 B 补注 #5③: the ONE
// session-scoped dedup key formula, byte-identical to what pmm-trigger-recall.cjs:143 has always
// computed inline (`ledger.sha16((sessionIdRaw || 'nosess') + ledger.NUL + (agentIdRaw || ''))`,
// itself unchanged by this export). Exported here so trigger-recall's 23-R2 repush logic and the
// C0.5 shadow hook's own `.shadow/seen-*` state can share one implementation instead of drifting.
function seenKey(sessionId, agentId) {
  return sha16((sessionId || 'nosess') + NUL + (agentId || ''));
}

// resolveHome() — THE ONE home-directory resolver (2026-09-17, fab blind attack HIGH-1 / Opus
// reproduction): pmm-trigger-recall.cjs used to hardcode `process.env.PMM_HOME || 'C:/Users/<user>'`
// as its home fallback -- on any OTHER machine (or any test harness that redirects HOME/USERPROFILE
// without also setting PMM_HOME) that literal path is simply wrong, and unlike PMM_RECALL_ROOT this
// was never even overridable by the standard env vars a redirected test/CI environment would set.
// Precedence (pinned, do not reimplement elsewhere): PMM_HOME (trimmed, non-empty) > USERPROFILE
// (trimmed, non-empty) > HOME (trimmed, non-empty) > os.homedir(). USERPROFILE is checked before HOME
// because that is the variable Windows/os.homedir() itself prioritizes (Node's os.homedir() reads
// USERPROFILE first on win32), so a caller that redirects both HOME and USERPROFILE together (this
// codebase's own established self-test convention) gets consistent behavior whichever this function
// or a bare os.homedir() call happens to run first.
// stripTrailingSep(s) — LOW-1 fix (2026-09-23, Opus fab-delta triage, CONFIRMED): resolveHome() used
// to return an env-var override VERBATIM, including any trailing path separator the caller's env
// value happened to carry (a common manual-export mistake, e.g. PMM_HOME=/tmp/x/ or PMM_HOME=C:\x\).
// Measured: a trailing `/` or `\` dropped a downstream string-equality-based matcher's hit count to 0
// (pmm-recall-ledger.cjs:54-58 / pmm-trigger-recall.cjs:71,154) even though the path itself still
// resolved to the same directory on disk -- PMM_HOME is a public override entry point, so this is
// worth normalizing at the source rather than in every caller. Strips exactly ONE trailing run of
// `/`/`\` characters, except when doing so would leave a bare drive letter (`C:\` -> `C:`, not a
// valid path) or an empty string (`/` -> ``) -- those two ROOT shapes are returned unchanged.
// Deliberately does NOT translate between MSYS (`/c/...`) and Windows (`C:\...`) path styles -- that
// is a separate concern (pmm-home.sh's own `cygpath -u` step handles it for its shell callers) and
// `/c/...` is a legitimate absolute path in its own right on non-win32 platforms.
function stripTrailingSep(s) {
  const stripped = s.replace(/[\\/]+$/, '');
  if (stripped === '' || /^[A-Za-z]:$/.test(stripped)) return s;
  return stripped;
}

function resolveHome() {
  const candidates = [process.env.PMM_HOME, process.env.USERPROFILE, process.env.HOME];
  for (const c of candidates) if (typeof c === 'string' && c.trim() !== '') return stripTrailingSep(c);
  return stripTrailingSep(os.homedir());
}

// PMM_RECALL_ROOT (简报 §11.3): "可注入 root:PMM_RECALL_ROOT 决定 ledger/
// pending/receipts/queue 的根目录(只改位置不改行为),缺省 ~/.claude/.local/
// pmm-recall/". resolveHome() is read at call time (not cached), so a child
// process whose HOME/USERPROFILE/PMM_HOME were redirected before this module loads
// (contract Z22) computes the correct redirected default -- HIGH-1: this used to call
// os.homedir() directly, which (unlike resolveHome()) never honors a plain HOME-only redirect on
// win32 (os.homedir() there reads USERPROFILE first, same as resolveHome(), but a caller that only
// set HOME and not USERPROFILE would previously see no effect at all here).
function defaultRoot() {
  return path.join(resolveHome(), '.claude', '.local', 'pmm-recall');
}

// resolveRoot() — THE ONE root resolver (2026-09-17, codex LOW-5 / Opus reproduction): every other
// module that ever computed its own copy of this function (pmm-recall-policy.cjs did; before that
// fix its version returned the literal PMM_RECALL_ROOT string unchecked) must require() this file
// and call THIS function instead of re-implementing it -- a second implementation is exactly how
// pmm-bash-impression.cjs's ledger writes (via this function, correctly normalized) and its policy
// lookups (via policy.cjs's own un-normalized copy) silently disagreed about which directory
// "root" meant for the SAME PMM_RECALL_ROOT value, corrupting a session×class unit's assignment
// consistency across writers.
// Normalization rule (pinned, do not reimplement elsewhere): PMM_RECALL_ROOT falls back to
// defaultRoot() unless it is a string AND, after trimming leading/trailing whitespace, non-empty
// (so unset, `''`, and whitespace-only values like `' '` all fall back identically) -- the
// ORIGINAL (untrimmed) value is used verbatim when it passes that check, so a root path that
// legitimately starts or ends with whitespace is never mangled.
function resolveRoot() {
  const r = process.env.PMM_RECALL_ROOT;
  return (typeof r === 'string' && r.trim() !== '') ? r : defaultRoot();
}

// sanitize(field): the writer-boundary control/separator hygiene pass (contract sanitize_set). NUL is
// included (contract Z10 injects a NUL byte into tool_use_id alongside TAB/CR/LF and requires the row to
// stay structurally intact; the M0 hook's original sanitizeField only covered \t\r\n, which is why this
// module also handles \0). v2.18 (fab L4, contract Z10b) added VT/FF/NEL/LS/PS individually.
// v2.23 (codex LOW-9): superseded by a RANGE definition -- the whole C0 control range (U+0000-U+001F,
// which already subsumes TAB/CR/LF/NUL/VT/FF and every other C0 control byte, e.g. BEL U+0007 / Z10c), DEL
// (U+007F, Z10d), the whole C1 control range (U+0080-U+009F, which already subsumes NEL U+0085), plus LS
// (U+2028) and PS (U+2029) (outside both C0/C1, kept as their own two code points). sanitized=1 means "some
// column of this row was rewritten", independent of whether the raw bytes would have torn the TSV row.
// Built from charCodes (not a regex literal with unicode escapes) so none of these code points can be
// silently mangled by any text-layer tooling that treats them as actual line terminators while this source
// is edited -- fitting, since that is exactly the class of failure this function exists to guard the
// LEDGER FILE against.
function buildSanitizeCharClass() {
  const chars = [];
  for (let c = 0x00; c <= 0x1f; c++) chars.push(String.fromCharCode(c)); // C0
  chars.push(String.fromCharCode(0x7f)); // DEL
  for (let c = 0x80; c <= 0x9f; c++) chars.push(String.fromCharCode(c)); // C1
  chars.push(String.fromCharCode(0x2028)); // LS
  chars.push(String.fromCharCode(0x2029)); // PS
  return chars.join('');
}
const SANITIZE_CHARCLASS = buildSanitizeCharClass();
const SANITIZE_RE = new RegExp('[' + SANITIZE_CHARCLASS + ']');
const SANITIZE_RE_G = new RegExp('[' + SANITIZE_CHARCLASS + ']', 'g');
function sanitize(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  if (SANITIZE_RE.test(s)) return { value: s.replace(SANITIZE_RE_G, '_'), sanitized: true };
  return { value: s, sanitized: false };
}

// impressionId({session_id, agent_id, tool_use_id, trigger_or_gate_id,
// gate_instance_id}): 附录 A 双 id 公式 (v2.9 pins gate_instance_id per gate
// kind — caller derives that value; this function only hashes the five
// NUL-joined components, never guesses gate_instance_id itself).
function impressionId(fields) {
  const f = fields || {};
  const parts = [f.session_id, f.agent_id, f.tool_use_id, f.trigger_or_gate_id, f.gate_instance_id]
    .map((x) => (x === undefined || x === null) ? '' : String(x));
  return sha16(parts.join(NUL));
}

// ordinal = H(gate_id || gate_instance_id || event_kind) (简报 §11.3 改句,
// v2.9: gate_instance_id 取代 pipeline_id||segment_index); never a
// process-local counter, so identical re-entries (same gate/instance/kind)
// always derive the SAME ordinal and therefore the SAME event_id — the
// mechanism L10/L11 rely on for write-side non-dedup + read-side collapse.
function ordinalOf(gateId, gateInstanceId, eventKind) {
  const parts = [gateId, gateInstanceId, eventKind].map((x) => (x === undefined || x === null) ? '' : String(x));
  return sha16(parts.join(NUL));
}

function eventId(impressionIdVal, eventKind, ordinal) {
  const parts = [impressionIdVal, eventKind, ordinal].map((x) => (x === undefined || x === null) ? '' : String(x));
  return sha16(parts.join(NUL));
}

function ledgerPath(root) { return path.join(root, 'events-v3-' + os.hostname() + '.tsv'); }
function queuePath(root) { return path.join(root, 'queue-' + os.hostname() + '.tsv'); }
function writeFailuresPath(root) { return path.join(root, 'write-failures.count'); }
function quarantinePath(root) { return path.join(root, 'quarantine-' + os.hostname() + '.tsv'); }

// isPoisonedSid(v) (2026-09-17, coordinator LOW-K2-followup / real-ledger contamination incident):
// a defense-in-depth write-boundary check, narrowly scoped to the ONE pathological shape this was
// written for -- a caller bug that stringifies a missing/undefined session id directly (e.g.
// `` `${sessionIdRaw}` `` or `String(sessionIdRaw)` on a JS `undefined`/`null`) instead of routing
// it through this module's own sha16() (which already coerces undefined/null to '' at line ~39,
// so a CORRECT caller never produces this value). Deliberately NOT triggered by plain '' -- empty
// string is the long-established, intentional "no session" representation used throughout this file
// (writeSessionEnd's own `f.session_id ? sha16(...) : ''`) and by dozens of pre-existing self-test
// rows in THIS file that build a row without any session context to test unrelated behavior
// (sanitize, header-once, write-failures, H4, Z10b/c/d, run_provenance) -- rejecting blank sid_sha16
// outright would quarantine all of those and silently change behavior for the gate's own writer
// (bash-pipe-exitcode-watch.cjs, out of this round's write-face, so its rows can't be re-verified
// here). Note: the actual 2026-09-17 real-ledger contamination incident this round responds to did
// NOT have a poisoned sid_sha16 (the leaked pmm-trigger-recall.sh self-test rows hashed real test
// session ids like "s1"; their tell was id_missing=1 / blank impression_id from a missing
// tool_use_id, not sid) -- that incident's root cause is fixed at the source (self-test isolation,
// see pmm-trigger-recall.sh) and covered on the read side by the id_missing/sid-missing exclusion
// in the five M1/M2/M3 read tools. This check exists as an independent, forward-looking guard
// against the DIFFERENT failure shape the coordinator named explicitly ("sid 为空/undefined").
// POISONED_SIDS (2026-09-23, close-out CO / A1-尾 13:55 handoff, CHANGELOG same timestamp): an
// explicit, named blocklist of specific sid_sha16 values already CONFIRMED to be probe/test leakage
// into the real production root -- distinct from isPoisonedSid()'s malformed-value check above (the
// literal strings "undefined"/"null" a buggy caller can stringify). First entry: b62105393532ca93 =
// sha16("s-cyc") -- the 2026-09-23T16:46:02Z incident where a replaced-loop probe payload (repo=home,
// rel=.claude/guards/cycprobe.sh, tool_use_id empty) landed 34 rows in the real ledger. Those 34
// already-written rows are NOT retroactively touched by this list (append-only per M-SPEC; the
// read-side five tools' isContaminatedRow() already excludes them via id_missing='1' -- see
// guard-canary.sh's check_recall_ledger_not_recontaminated() baseline-613 comment). This list is
// purely a forward-looking write-boundary net: it refuses any FUTURE row carrying the SAME named
// probe session hash, the same way the guard below already refuses "undefined"/"null".
const POISONED_SIDS = new Set(['b62105393532ca93']);

function isPoisonedSid(v) {
  return v === 'undefined' || v === 'null' || POISONED_SIDS.has(v);
}

function noteWriteFailure(root) {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(writeFailuresPath(root), '.', { flag: 'a' });
  } catch (e) { /* fully swallow: must never affect the caller's stdout/stderr/exit */ }
}

// writeEvent(row, opts): row is a plain object keyed by (a subset of)
// COLUMNS; missing columns default to ''. schema_version/ts are filled when
// absent. Single-line O_APPEND, write side never dedupes and never builds
// claims (简报 §11.3 "写入端不做任何去重、不建 claims"). Header is written by
// the FIRST creator via O_CREAT|O_EXCL ('wx'); a losing race on that open
// falls straight through to append — no error surfaced, no header rewritten.
//
// H4 (codex gf final wave, contract v2.15): EVERY column is sanitized HERE, unconditionally — a caller
// that already ran its own sanitize() (e.g. the gate's baseRowFields()) is only defense in depth, never
// the sole layer. `sanitized` is self-derived from what THIS function actually observes needing cleaning,
// OR'd with whatever the caller already flagged (a caller may have pre-cleaned a value in place, so by the
// time it reaches here it looks clean even though it originally wasn't — its own sanitized='1' is not
// discarded). The `sanitized` column's own incoming value is never itself run through the loop (it is a
// derived flag, not free text); it is fully recomputed at the end instead.
function writeEvent(row, opts) {
  const o = opts || {};
  const root = o.root || resolveRoot();
  const r = row || {};
  const full = {};
  let anySanitizedHere = false;
  const callerFlaggedSanitized = r.sanitized === '1' || r.sanitized === 1 || r.sanitized === true;
  for (const c of COLUMNS) {
    if (c === 'sanitized') continue;
    let v = r[c];
    if (v === undefined || v === null) v = '';
    const s = sanitize(v);
    full[c] = s.value;
    if (s.sanitized) anySanitizedHere = true;
  }
  full.sanitized = (anySanitizedHere || callerFlaggedSanitized) ? '1' : '0';
  if (full.schema_version === '') full.schema_version = '1';
  if (full.ts === '') full.ts = new Date().toISOString();
  const line = COLUMNS.map((c) => String(full[c])).join('\t') + '\n';

  // Write-boundary poisoned-sid guard (see isPoisonedSid() comment above): a row whose sid_sha16 is
  // the literal string "undefined"/"null" never reaches the main ledger -- append-only quarantine
  // instead, one stderr diagnostic line, function returns false (did not land in the main ledger).
  if (isPoisonedSid(full.sid_sha16)) {
    const qp = quarantinePath(root);
    try {
      fs.mkdirSync(root, { recursive: true });
      try {
        const fd = fs.openSync(qp, 'wx');
        try { fs.writeSync(fd, COLUMNS.join('\t') + '\n'); } finally { fs.closeSync(fd); }
      } catch (e) { /* already exists -> append only */ }
      fs.appendFileSync(qp, line, { flag: 'a' });
    } catch (e) { noteWriteFailure(root); }
    try {
      process.stderr.write('pmm-recall-ledger: refused write with poisoned sid_sha16=' + JSON.stringify(full.sid_sha16) + ' (event_kind=' + full.event_kind + ') -- quarantined, not appended to the main ledger\n');
    } catch (e) { /* stderr write itself must never throw past this guard */ }
    return false;
  }

  const p = ledgerPath(root);
  try {
    fs.mkdirSync(root, { recursive: true });
    try {
      const fd = fs.openSync(p, 'wx');
      try { fs.writeSync(fd, COLUMNS.join('\t') + '\n'); } finally { fs.closeSync(fd); }
    } catch (e) { /* already exists (or lost the create race) -> append only */ }
    fs.appendFileSync(p, line, { flag: 'a' });
    return true;
  } catch (e) {
    noteWriteFailure(root);
    return false;
  }
}

// writeQueue(row, opts): M1 review-queue row, desensitized snippet capped at
// 120 chars (already-desensitized text is the caller's job — this only caps
// length and strips TSV-hostile bytes); same wx-header / append discipline.
function writeQueue(row, opts) {
  const o = opts || {};
  const root = o.root || resolveRoot();
  const r = row || {};
  const full = {};
  for (const c of QUEUE_COLUMNS) {
    let v = r[c];
    if (v === undefined || v === null) v = '';
    full[c] = v;
  }
  if (full.ts === '') full.ts = new Date().toISOString();
  let snippet = String(full.snippet || '');
  if (snippet.length > 120) snippet = snippet.slice(0, 120);
  full.snippet = snippet;
  const line = QUEUE_COLUMNS.map((c) => String(full[c]).replace(/[\t\r\n\0]/g, '_')).join('\t') + '\n';
  const p = queuePath(root);
  try {
    fs.mkdirSync(root, { recursive: true });
    try {
      const fd = fs.openSync(p, 'wx');
      try { fs.writeSync(fd, QUEUE_COLUMNS.join('\t') + '\n'); } finally { fs.closeSync(fd); }
    } catch (e) { /* exists -> append only */ }
    fs.appendFileSync(p, line, { flag: 'a' });
    return true;
  } catch (e) {
    noteWriteFailure(root);
    return false;
  }
}

// writeSessionEnd({session_id, agent_id, agent_type}, opts): one
// event_kind='session-end' row per M-SPEC 附录 A ("观察窗终止...或一行
// session-end, 由共用模块的 writeSessionEnd() 在 Claude Code SessionEnd hook
// 写入"). gate_instance_id is empty for this row kind (附录 A: "M0 trigger
// 曝光=<segment_index>;observed/session-end 为空"); impression_id is still
// computed through the normal formula (tool_use_id='', trigger_or_gate_id=
// 'session-end', gate_instance_id='') so it still varies per session/agent —
// only the gate_instance_id COMPONENT is blank, not the whole column.
function writeSessionEnd(fields, opts) {
  const f = fields || {};
  const sidSha = f.session_id ? sha16(f.session_id) : '';
  const agentSha = f.agent_id ? sha16(f.agent_id) : '';
  const impId = impressionId({
    session_id: f.session_id, agent_id: f.agent_id, tool_use_id: '',
    trigger_or_gate_id: 'session-end', gate_instance_id: '',
  });
  const ord = ordinalOf('', '', 'session-end');
  const evId = eventId(impId, 'session-end', ord);
  return writeEvent({
    sid_sha16: sidSha, agent_sha16: agentSha, agent_type: f.agent_type || '',
    tool_use_id: '', impression_id: impId, event_id: evId, event_kind: 'session-end',
    gate: '', confidence: '', class_tag: '', trigger_or_gate_id: '',
    cmd_sha16: '', parser_version: '', mode: '',
    run_provenance: process.env.PMM_RECALL_TAG || '',
    sanitized: '0', id_missing: f.session_id ? '0' : '1', agent_id_missing: f.agent_id ? '0' : '1',
  }, opts);
}

module.exports = {
  COLUMNS, QUEUE_COLUMNS, NUL, sha16, seenKey, resolveHome, defaultRoot, resolveRoot,
  sanitize, impressionId, ordinalOf, eventId,
  ledgerPath, queuePath, writeFailuresPath, quarantinePath, isPoisonedSid,
  writeEvent, writeQueue, writeSessionEnd,
};

// ============================================================================
// CLI: `node pmm-recall-ledger.cjs --session-end` — SessionEnd hook entry.
// Reads the SessionEnd hook JSON from stdin and writes one session-end row.
// Fail-open: any error anywhere still exits 0, never blocks session teardown.
// ============================================================================
if (require.main === module && process.argv[2] === '--session-end') {
  process.on('uncaughtException', () => { try { process.exit(0); } catch (e) { /* */ } });
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      writeSessionEnd({ session_id: data.session_id, agent_id: data.agent_id, agent_type: data.agent_type });
    }
  } catch (e) { /* swallow: malformed/absent stdin is a silent no-op */ }
  process.exit(0);
}

// ============================================================================
// --self-test
// ============================================================================
if (require.main === module && process.argv[2] === '--self-test') {
  let PASS = 0, FAIL = 0;
  function report(name, ok, detail) {
    if (ok) { console.log('PASS: ' + name); PASS++; }
    else { console.log('FAIL: ' + name + ' -- ' + (detail || '')); FAIL++; }
  }
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-ledger-selftest-'));
  function cleanup() { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  process.on('exit', cleanup);

  report('COLUMNS has exactly 21 entries', COLUMNS.length === 21, String(COLUMNS.length));
  report('QUEUE_COLUMNS has exactly 7 entries', QUEUE_COLUMNS.length === 7, String(QUEUE_COLUMNS.length));

  report('sanitize: tab/CR/LF/NUL all replaced, sanitized=true', (() => {
    const r = sanitize('a\tb\rc\nd' + String.fromCharCode(0) + 'e');
    return r.value === 'a_b_c_d_e' && r.sanitized === true;
  })());
  report('sanitize: clean value passes through, sanitized=false', (() => {
    const r = sanitize('clean-value');
    return r.value === 'clean-value' && r.sanitized === false;
  })());
  report('v2.18 sanitize_set: VT/FF/NEL/LS/PS all replaced, sanitized=true', (() => {
    const dirty = 'a' + String.fromCharCode(0x0B) + 'b' + String.fromCharCode(0x0C) + 'c' + String.fromCharCode(0x85) + 'd' + String.fromCharCode(0x2028) + 'e' + String.fromCharCode(0x2029) + 'f';
    const r = sanitize(dirty);
    return r.value === 'a_b_c_d_e_f' && r.sanitized === true;
  })());
  report('v2.23 sanitize_set: the WHOLE C0 range (0x00-0x1F) is replaced, not just the previously-named subset', (() => {
    let allC0 = true;
    for (let c = 0x00; c <= 0x1f; c++) {
      const r = sanitize('x' + String.fromCharCode(c) + 'y');
      if (r.value !== 'x_y' || r.sanitized !== true) { allC0 = false; break; }
    }
    return allC0;
  })());
  report('v2.23 sanitize_set: DEL (0x7F) replaced', (() => {
    const r = sanitize('x' + String.fromCharCode(0x7f) + 'y');
    return r.value === 'x_y' && r.sanitized === true;
  })());
  report('v2.23 sanitize_set: the WHOLE C1 range (0x80-0x9F) is replaced, not just NEL alone', (() => {
    let allC1 = true;
    for (let c = 0x80; c <= 0x9f; c++) {
      const r = sanitize('x' + String.fromCharCode(c) + 'y');
      if (r.value !== 'x_y' || r.sanitized !== true) { allC1 = false; break; }
    }
    return allC1;
  })());
  report('v2.23 sanitize_set: a genuinely clean value with no control/C1/LS/PS bytes stays untouched, sanitized=false', (() => {
    const r = sanitize('exe --flag=value/path.txt');
    return r.value === 'exe --flag=value/path.txt' && r.sanitized === false;
  })());

  report('impressionId: deterministic, differs when any component differs', (() => {
    const a = impressionId({ session_id: 'test:s1', agent_id: 'a1', tool_use_id: 'toolu_selftest_t1', trigger_or_gate_id: 'trig', gate_instance_id: '0:0' });
    const a2 = impressionId({ session_id: 'test:s1', agent_id: 'a1', tool_use_id: 'toolu_selftest_t1', trigger_or_gate_id: 'trig', gate_instance_id: '0:0' });
    const b = impressionId({ session_id: 'test:s1', agent_id: 'a1', tool_use_id: 'toolu_selftest_t1', trigger_or_gate_id: 'trig', gate_instance_id: '0:1' });
    return a === a2 && a !== b && /^[0-9a-f]{16}$/.test(a);
  })());

  report('ordinalOf/eventId: same triple -> same ordinal/event_id; different event_kind -> different event_id', (() => {
    const imp = impressionId({ session_id: 'test:s1', agent_id: 'a1', tool_use_id: 'toolu_selftest_t1', trigger_or_gate_id: 'A', gate_instance_id: '0:0' });
    const o1 = ordinalOf('A', '0:0', 'would-warn');
    const o1b = ordinalOf('A', '0:0', 'would-warn');
    const o2 = ordinalOf('A', '0:0', 'emitted');
    const e1 = eventId(imp, 'would-warn', o1);
    const e1b = eventId(imp, 'would-warn', o1b);
    const e2 = eventId(imp, 'emitted', o2);
    return o1 === o1b && e1 === e1b && e1 !== e2;
  })());

  report('defaultRoot/resolveRoot: PMM_RECALL_ROOT overrides default', (() => {
    const before = process.env.PMM_RECALL_ROOT;
    delete process.env.PMM_RECALL_ROOT;
    const def = resolveRoot();
    process.env.PMM_RECALL_ROOT = path.join(T, 'custom-root');
    const custom = resolveRoot();
    if (before === undefined) delete process.env.PMM_RECALL_ROOT; else process.env.PMM_RECALL_ROOT = before;
    return def === defaultRoot() && custom === path.join(T, 'custom-root');
  })());

  // resolveHome() precedence (2026-09-17, fab blind attack HIGH-1): PMM_HOME > USERPROFILE > HOME >
  // os.homedir(), each checked for non-blank-after-trim (mirrors resolveRoot()'s own normalization
  // rule so a whitespace-only override never silently "wins" over a real one further down the chain).
  {
    const before = { PMM_HOME: process.env.PMM_HOME, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    function restore() {
      for (const k of ['PMM_HOME', 'USERPROFILE', 'HOME']) {
        if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
      }
    }
    try {
      delete process.env.PMM_HOME; delete process.env.USERPROFILE; delete process.env.HOME;
      report('resolveHome: with none of PMM_HOME/USERPROFILE/HOME set, falls back to os.homedir()', resolveHome() === os.homedir(), resolveHome());

      process.env.HOME = path.join(T, 'home-only');
      report('resolveHome: HOME alone is honored when PMM_HOME/USERPROFILE are unset', resolveHome() === path.join(T, 'home-only'), resolveHome());

      process.env.USERPROFILE = path.join(T, 'userprofile-wins');
      report('resolveHome: USERPROFILE outranks HOME', resolveHome() === path.join(T, 'userprofile-wins'), resolveHome());

      process.env.PMM_HOME = path.join(T, 'pmm-home-wins');
      report('resolveHome: PMM_HOME outranks USERPROFILE and HOME', resolveHome() === path.join(T, 'pmm-home-wins'), resolveHome());

      process.env.PMM_HOME = '   ';
      report('resolveHome: whitespace-only PMM_HOME is treated as unset, falls through to USERPROFILE', resolveHome() === path.join(T, 'userprofile-wins'), resolveHome());

      // LOW-1 (2026-09-17 fab blind attack / 2026-09-23 Opus fab-delta triage, CONFIRMED): a trailing
      // path separator on an env override used to be returned verbatim, silently doubling up against
      // path.join() downstream and dropping a string-equality-based matcher's hit count to 0. RED
      // before this fix (measured): both cases below returned the untrimmed value with the trailing
      // separator still attached.
      delete process.env.USERPROFILE; delete process.env.HOME;
      process.env.PMM_HOME = path.join(T, 'trailing-sep-wins') + '/';
      report('resolveHome: LOW-1 trailing "/" on PMM_HOME is stripped', resolveHome() === path.join(T, 'trailing-sep-wins'), resolveHome());

      process.env.PMM_HOME = path.join(T, 'trailing-sep-wins') + '\\';
      report('resolveHome: LOW-1 trailing "\\" on PMM_HOME is stripped', resolveHome() === path.join(T, 'trailing-sep-wins'), resolveHome());
    } finally { restore(); }
  }
  report('defaultRoot() now derives from resolveHome(), not a bare os.homedir() call', (() => {
    const before = { PMM_HOME: process.env.PMM_HOME };
    try {
      process.env.PMM_HOME = path.join(T, 'defaultroot-via-resolvehome');
      return defaultRoot() === path.join(T, 'defaultroot-via-resolvehome', '.claude', '.local', 'pmm-recall');
    } finally {
      if (before.PMM_HOME === undefined) delete process.env.PMM_HOME; else process.env.PMM_HOME = before.PMM_HOME;
    }
  })());

  console.log();
  console.log('==================================================');
  console.log('Black-box: writeEvent header-once / append / write-failures');
  console.log('==================================================');
  {
    const root = path.join(T, 'root-a');
    const row1 = { tool_use_id: 'toolu_selftest_tu1', impression_id: 'imp1', event_id: 'ev1', event_kind: 'observed', parser_version: '1.2' };
    const ok1 = writeEvent(row1, { root });
    const row2 = { tool_use_id: 'toolu_selftest_tu2', impression_id: 'imp2', event_id: 'ev2', event_kind: 'observed', parser_version: '1.2' };
    const ok2 = writeEvent(row2, { root });
    report('writeEvent: both writes report success', ok1 === true && ok2 === true);
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    report('writeEvent: header written once, two data rows follow', lines.length === 3 && lines[0] === COLUMNS.join('\t'), JSON.stringify(lines));
    report('writeEvent: row has exactly COLUMNS.length fields', lines[1].split('\t').length === COLUMNS.length, String(lines[1].split('\t').length));
  }
  {
    const root = path.join(T, 'root-b-unwritable');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(ledgerPath(root)); // occupy the ledger path with a directory -> EISDIR on append
    const before = fs.existsSync(writeFailuresPath(root)) ? fs.statSync(writeFailuresPath(root)).size : 0;
    const ok = writeEvent({ tool_use_id: 'toolu_selftest_tu3', event_kind: 'observed' }, { root });
    const after = fs.existsSync(writeFailuresPath(root)) ? fs.statSync(writeFailuresPath(root)).size : 0;
    report('writeEvent: unwritable ledger path -> reports false, write-failures.count grows', ok === false && after > before, 'before=' + before + ' after=' + after);
  }
  {
    const root = path.join(T, 'root-c-queue');
    const ok = writeQueue({ impression_id: 'imp1', trigger_or_gate_id: 'trig1', class_tag: 'c', exe: 'tail', sub: '', snippet: 'a\tb\rc\nd' }, { root });
    const lines = fs.readFileSync(queuePath(root), 'utf8').split('\n').filter(Boolean);
    report('writeQueue: header + one sanitized row', ok === true && lines.length === 2 && lines[0] === QUEUE_COLUMNS.join('\t') && lines[1].indexOf('\t') === lines[1].split('\t')[0].length, JSON.stringify(lines));
    report('writeQueue: embedded control bytes sanitized in the snippet', lines[1].split('\t')[6] === 'a_b_c_d', JSON.stringify(lines));
  }
  {
    const root = path.join(T, 'root-d-sessionend');
    const ok = writeSessionEnd({ session_id: 'test:s1', agent_id: 'a1', agent_type: 'worker' }, { root });
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const dataRow = lines[1].split('\t');
    const kindIdx = COLUMNS.indexOf('event_kind');
    const impIdx = COLUMNS.indexOf('impression_id');
    report('writeSessionEnd: one session-end row with a non-empty impression_id', ok === true && lines.length === 2 && dataRow[kindIdx] === 'session-end' && dataRow[impIdx] !== '', JSON.stringify(lines));
    const ok2 = writeSessionEnd({ session_id: 'test:s1', agent_id: 'a1', agent_type: 'worker' }, { root });
    const lines2 = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    report('writeSessionEnd: identical re-entry writes another raw row (write side never dedupes) but the SAME event_id (read-side collapsible)', ok2 === true && lines2.length === 3 && lines2[1].split('\t')[COLUMNS.indexOf('event_id')] === lines2[2].split('\t')[COLUMNS.indexOf('event_id')], JSON.stringify(lines2));
  }
  console.log();
  console.log('==================================================');
  console.log('Black-box: H4 (codex gf final wave) -- writeEvent sanitizes EVERY column itself, self-derives sanitized');
  console.log('==================================================');
  {
    // A raw writeEvent() call the caller did NOT pre-sanitize at all (unlike the gate's own baseRowFields,
    // which is defense in depth, not the only layer) -- this is exactly the shape H4 exists for.
    const root = path.join(T, 'root-e-h4-writeevent');
    const dirty = 'tu\ta\rb\nc' + String.fromCharCode(0) + 'd';
    const ok = writeEvent({ tool_use_id: dirty, event_kind: 'observed', agent_type: 'x\ty' }, { root });
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const row = lines[1].split('\t');
    const tuIdx = COLUMNS.indexOf('tool_use_id'), atIdx = COLUMNS.indexOf('agent_type'), sIdx = COLUMNS.indexOf('sanitized');
    report('H4: writeEvent() sanitizes tool_use_id even when the CALLER never touched it (no sanitize() call before this)',
      ok === true && lines.length === 2 && row.length === COLUMNS.length && row[tuIdx] === 'tu_a_b_c_d' && row[atIdx] === 'x_y' && row[sIdx] === '1',
      JSON.stringify(lines));
  }
  {
    // writeSessionEnd's agent_type goes through the exact same writeEvent() path -- no special-casing needed.
    const root = path.join(T, 'root-f-h4-sessionend');
    const ok = writeSessionEnd({ session_id: 'test:s1', agent_id: 'a1', agent_type: 'worker\tbreak\nnext' }, { root });
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const row = lines[1] ? lines[1].split('\t') : [];
    const atIdx = COLUMNS.indexOf('agent_type'), sIdx = COLUMNS.indexOf('sanitized');
    report('H4: writeSessionEnd agent_type="worker<TAB>break<LF>next" -> file stays ONE data line, 21 columns, sanitized=1',
      ok === true && lines.length === 2 && row.length === 21 && row[atIdx] === 'worker_break_next' && row[sIdx] === '1',
      JSON.stringify(lines));
  }
  {
    // A caller that pre-sanitized a value (so by the time writeEvent sees it, it is ALREADY clean) must not
    // lose its own sanitized='1' signal just because writeEvent's own pass finds nothing left to clean.
    const root = path.join(T, 'root-g-h4-callerflag');
    const ok = writeEvent({ tool_use_id: 'toolu_selftest_already_clean', event_kind: 'observed', sanitized: '1' }, { root });
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const row = lines[1].split('\t');
    const sIdx = COLUMNS.indexOf('sanitized');
    report('H4: caller-flagged sanitized=1 is preserved even when writeEvent finds nothing dirty on its own pass',
      ok === true && row[sIdx] === '1', JSON.stringify(lines));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: v2.18 Z10b -- unicode line separators in tool_use_id must not tear the row');
  console.log('==================================================');
  {
    // contract Z10b: "A01 json with tool_use_id containing U+2028, U+2029, U+0085, VT and FF" -> the ledger
    // must stay ONE physical row per event, 21 columns, sanitized=1. Every char in this set is a line- or
    // paragraph-separator-shaped control character in at least one common reader (terminal, editor, or the
    // JS/JSON string grammar itself for U+2028/U+2029) -- none of them are LF, so before this item's
    // sanitize_set extension, writeEvent's own line-count invariant (assert further down) would have failed:
    // a naive '\n'-split of the ledger file would have seen more than one line for what should be one event.
    const root = path.join(T, 'root-h-z10b');
    const dirtyToolUseId = 'tu' + String.fromCharCode(0x2028) + 'A' + String.fromCharCode(0x2029) + 'B' + String.fromCharCode(0x85) + 'C' + String.fromCharCode(0x0B) + 'D' + String.fromCharCode(0x0C) + 'E';
    const ok = writeEvent({ tool_use_id: dirtyToolUseId, event_kind: 'observed' }, { root });
    const raw = fs.readFileSync(ledgerPath(root), 'utf8');
    const physicalLines = raw.split('\n').filter(Boolean); // LF is the ONLY row delimiter (conventions.sanitize_set)
    const dataRow = physicalLines[1] ? physicalLines[1].split('\t') : [];
    const tuIdx = COLUMNS.indexOf('tool_use_id'), sIdx = COLUMNS.indexOf('sanitized');
    report('Z10b: tool_use_id with U+2028/U+2029/U+0085/VT/FF -> exactly one physical row, 21 columns, sanitized=1',
      ok === true && physicalLines.length === 2 && dataRow.length === 21 && dataRow[sIdx] === '1' &&
      dataRow[tuIdx] === 'tu_A_B_C_D_E' && [0x2028, 0x2029, 0x85, 0x0B, 0x0C].every((c) => dataRow[tuIdx].indexOf(String.fromCharCode(c)) < 0),
      JSON.stringify({ physicalLines, dataRow }));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: v2.23 Z10c/Z10d -- BEL and DEL sanitized at the writer boundary, never reach the ledger raw');
  console.log('==================================================');
  {
    // Z10c: BEL (U+0007) is a C0 control byte the OLD enumerated set never covered.
    const root = path.join(T, 'root-j-z10c-bel');
    const dirty = 'tu' + String.fromCharCode(0x07) + 'bell';
    const ok = writeEvent({ tool_use_id: dirty, event_kind: 'observed' }, { root });
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const row = lines[1] ? lines[1].split('\t') : [];
    const tuIdx = COLUMNS.indexOf('tool_use_id'), sIdx = COLUMNS.indexOf('sanitized');
    report('Z10c: BEL (U+0007) in tool_use_id -> exactly one physical row, 21 columns, sanitized=1, no raw BEL byte',
      ok === true && lines.length === 2 && row.length === 21 && row[sIdx] === '1' && row[tuIdx] === 'tu_bell' && row[tuIdx].indexOf(String.fromCharCode(0x07)) < 0,
      JSON.stringify({ lines, row }));
  }
  {
    // Z10d: DEL (U+007F) sits between C0 and C1, its own single code point.
    const root = path.join(T, 'root-k-z10d-del');
    const dirty = 'tu' + String.fromCharCode(0x7f) + 'del';
    const ok = writeEvent({ tool_use_id: dirty, event_kind: 'observed' }, { root });
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const row = lines[1] ? lines[1].split('\t') : [];
    const tuIdx = COLUMNS.indexOf('tool_use_id'), sIdx = COLUMNS.indexOf('sanitized');
    report('Z10d: DEL (U+007F) in tool_use_id -> exactly one physical row, 21 columns, sanitized=1, no raw DEL byte',
      ok === true && lines.length === 2 && row.length === 21 && row[sIdx] === '1' && row[tuIdx] === 'tu_del' && row[tuIdx].indexOf(String.fromCharCode(0x7f)) < 0,
      JSON.stringify({ lines, row }));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: v2.18 run_provenance_sanitized -- PMM_RECALL_TAG with TAB/LF stays one row (writer-boundary sanitize, H4 path)');
  console.log('==================================================');
  {
    // conventions.run_provenance_sanitized: run_provenance is a ledger column like any other and passes
    // through writeEvent()'s own generic per-column sanitize loop (H4) -- no special-casing needed in the
    // gate. This exercises that column specifically (the gate's baseRowFields() reads it from
    // process.env.PMM_RECALL_TAG; here we call writeEvent() directly with a dirty value, the same contract
    // writeEvent() itself makes to EVERY caller regardless of which column it is).
    const root = path.join(T, 'root-i-run-provenance');
    const dirtyTag = 'ci-run\tbatch-3\nretry';
    const ok = writeEvent({ tool_use_id: 'tu-rp', event_kind: 'would-warn', run_provenance: dirtyTag }, { root });
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const row = lines[1] ? lines[1].split('\t') : [];
    const rpIdx = COLUMNS.indexOf('run_provenance'), sIdx = COLUMNS.indexOf('sanitized');
    report('run_provenance_sanitized: PMM_RECALL_TAG-shaped value with TAB/LF -> still one 21-column row, sanitized=1',
      ok === true && lines.length === 2 && row.length === 21 && row[rpIdx] === 'ci-run_batch-3_retry' && row[sIdx] === '1',
      JSON.stringify(lines));
  }

  console.log();
  console.log('==================================================');
  console.log('Black-box: write-boundary poisoned-sid guard (2026-09-17, coordinator LOW-K2-followup / real-ledger contamination)');
  console.log('==================================================');
  {
    report('isPoisonedSid: literal "undefined" -> true', isPoisonedSid('undefined') === true);
    report('isPoisonedSid: literal "null" -> true', isPoisonedSid('null') === true);
    report('isPoisonedSid: plain empty string -> false (legitimate "no session" representation, NOT poisoned)', isPoisonedSid('') === false);
    report('isPoisonedSid: a real 16-hex sid_sha16 -> false', isPoisonedSid(sha16('s1')) === false);
  }
  {
    // A row whose sid_sha16 is the literal poisoned string never reaches the main ledger.
    const root = path.join(T, 'root-l-poisoned-undefined');
    const ok = writeEvent({ sid_sha16: 'undefined', tool_use_id: 'tu-poison1', event_kind: 'eligible', trigger_or_gate_id: 'test:poison' }, { root });
    const mainExists = fs.existsSync(ledgerPath(root));
    const qLines = fs.existsSync(quarantinePath(root)) ? fs.readFileSync(quarantinePath(root), 'utf8').split('\n').filter(Boolean) : [];
    const sidIdx = COLUMNS.indexOf('sid_sha16');
    report('poisoned-sid guard: sid_sha16="undefined" -> writeEvent returns false, main ledger file never created, row lands in quarantine instead',
      ok === false && mainExists === false && qLines.length === 2 && qLines[0] === COLUMNS.join('\t') && qLines[1].split('\t')[sidIdx] === 'undefined',
      JSON.stringify({ ok, mainExists, qLines }));
  }
  {
    const root = path.join(T, 'root-m-poisoned-null');
    const ok = writeEvent({ sid_sha16: 'null', tool_use_id: 'tu-poison2', event_kind: 'displayed' }, { root });
    const qLines = fs.existsSync(quarantinePath(root)) ? fs.readFileSync(quarantinePath(root), 'utf8').split('\n').filter(Boolean) : [];
    report('poisoned-sid guard: sid_sha16="null" -> also quarantined, not appended to the main ledger',
      ok === false && qLines.length === 2, JSON.stringify(qLines));
  }
  {
    // Control: a row with a LEGITIMATE blank sid_sha16 (the established "no session" representation
    // writeSessionEnd itself uses, and dozens of pre-existing self-test rows above rely on) must still
    // land in the MAIN ledger exactly as before this guard existed -- proving the guard did not widen
    // its net past the literal "undefined"/"null" strings.
    const root = path.join(T, 'root-n-blank-sid-not-poisoned');
    const ok = writeEvent({ tool_use_id: 'tu-blank-sid', event_kind: 'observed' }, { root }); // no sid_sha16 at all -> defaults to ''
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    report('poisoned-sid guard control: a row with no sid_sha16 at all (blank, the pre-existing legitimate case) still writes to the main ledger, unaffected by this guard',
      ok === true && lines.length === 2 && fs.existsSync(quarantinePath(root)) === false,
      JSON.stringify(lines));
  }
  {
    // A real (non-poisoned) sid_sha16 must never be misrouted to quarantine -- the guard's net must
    // not accidentally catch legitimate hashed session ids.
    const root = path.join(T, 'root-o-real-sid-not-poisoned');
    const ok = writeEvent({ sid_sha16: sha16('s1'), tool_use_id: 'tu-real-sid', event_kind: 'eligible' }, { root });
    const lines = fs.readFileSync(ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    report('poisoned-sid guard control: a real hashed sid_sha16 (e.g. sha16("s1")) writes to the main ledger normally, never quarantined',
      ok === true && lines.length === 2 && fs.existsSync(quarantinePath(root)) === false,
      JSON.stringify(lines));
  }
  {
    // 2026-09-23 (close-out CO, named blocklist entry above): the confirmed s-cyc probe-leak sid is
    // now on POISONED_SIDS -- a row carrying it must be quarantined exactly like the "undefined"/
    // "null" literals, proving the new list entry actually wires into the write-boundary guard (not
    // just isPoisonedSid() returning true in isolation).
    const root = path.join(T, 'root-p-poisoned-named-scyc');
    const ok = writeEvent({ sid_sha16: 'b62105393532ca93', tool_use_id: 'tu-poison3', event_kind: 'eligible', trigger_or_gate_id: 'test:poison' }, { root });
    const qLines = fs.existsSync(quarantinePath(root)) ? fs.readFileSync(quarantinePath(root), 'utf8').split('\n').filter(Boolean) : [];
    report('poisoned-sid guard: named blocklist entry sid_sha16="b62105393532ca93" (sha16("s-cyc")) -> quarantined, not appended to the main ledger',
      ok === false && qLines.length === 2, JSON.stringify(qLines));
  }

  console.log();
  console.log('==================================================');
  console.log('Summary: ' + PASS + ' passed, ' + FAIL + ' failed');
  console.log('==================================================');
  process.exit(FAIL > 0 ? 1 : 0);
}
