#!/usr/bin/env node
// pmm-recall-label.cjs — M1 three-value labeler for recall exposures.
//
// guards/specs/RECALL-LOOP-M-SPEC-v2.md M1 section, HIGH-5: "相关但没遵守" = useful-not-followed
// (useful + recurrence observed, NOT noise); "不相关" = noise; NOT observing a recurrence never
// auto-promotes an impression to useful (that judgment is a human's, always — this tool refuses to
// infer a label, it only ever records the one a human typed).
//
// Usage:
//   pmm-recall-label.cjs <impression_id> useful|noise|useful-not-followed [note...]
//   pmm-recall-label.cjs --undo <impression_id>
//
// Writes ONE line, O_APPEND, to <PMM_RECALL_ROOT>/labels-<host>.tsv:
//   ts  impression_id  label  note  labeler
// "同 impression 后写覆盖前写,读取端取最后一条" — this file is append-only; the label a reader
// should honor for a given impression_id is whichever row for it appears LAST in the file. --undo
// appends a tombstone row with label="undo" rather than truncating history (labels-*.tsv is never
// rewritten in place, matching the ledger's own O_APPEND discipline).
//
// This tool is read-only against every other file: it reads the ledger (to validate the
// impression_id is real) and never writes to events/queue/pending/receipts, per the build brief's
// hard constraint. Its only write effect anywhere is the single appended line described above.
//
// Exit codes: 0 ok; 1 bad usage / invalid label value; 2 failed to write labels file;
// 3 impression_id not found in the ledger (rejected, per spec: "impression_id 不存在于台账 ⇒ rc 3 拒绝").
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// pmm-recall-ledger.cjs (2026-09-17, codex LOW-K2 / Opus reproduction): resolveRoot() is required
// from there, not reimplemented here. The write side already converged onto ledger.resolveRoot() in
// an earlier round (LOW-5); this read side still carried its own un-normalized copy
// (`process.env.PMM_RECALL_ROOT || default`, no trim), so PMM_RECALL_ROOT=' ' made a WRITER land on
// the real default directory while this tool read from a literal whitespace-named directory --
// silently empty/all-zero output, never an error.
const ledger = require('./pmm-recall-ledger.cjs');

// ---------------------------------------------------------------------------------------------
// Shared reading layer — see pmm-recall-queue.cjs for the extended rationale comment; duplicated
// here verbatim (in behavior, not necessarily byte-for-byte) because the build brief's write
// surface is limited to exactly the three new files and no fourth shared module was authorized
// (resolveRoot() is the one exception -- LOW-K2 requires calling the ledger's, not reimplementing it).
// ---------------------------------------------------------------------------------------------

const M0_COLUMNS = ['schema_version', 'ts', 'sid_sha16', 'tool_use_id', 'agent_id', 'agent_type',
  'prompt_id', 'agent_id_missing', 'event_kind', 'trigger_id', 'class_tag', 'dialect',
  'segment_index', 'exe', 'sub', 'parse_status', 'cmd_sha16', 'parser_version', 'impression_id',
  'event_id', 'id_missing', 'sanitized'];

const V3_COLUMNS = ['schema_version', 'ts', 'sid_sha16', 'agent_sha16', 'agent_type', 'prompt_id',
  'tool_use_id', 'impression_id', 'event_id', 'event_kind', 'gate', 'confidence', 'class_tag',
  'trigger_or_gate_id', 'cmd_sha16', 'parser_version', 'mode', 'run_provenance', 'sanitized',
  'id_missing', 'agent_id_missing'];

const MATCHED_KINDS = new Set(['eligible', 'suppressed', 'displayed', 'would-warn', 'emitted',
  'recurrence-candidate', 'recurrence']);

const VALID_LABELS = new Set(['useful', 'noise', 'useful-not-followed']);
const UNDO_SENTINEL = 'undo';

const resolveRoot = ledger.resolveRoot;
function resolveHost() {
  return process.env.PMM_RECALL_HOST || os.hostname();
}
function v3Path(root, host) { return path.join(root, 'events-v3-' + host + '.tsv'); }
function m0Path(root, host) { return path.join(root, 'impressions-' + host + '.tsv'); }
function labelsPath(root, host) { return path.join(root, 'labels-' + host + '.tsv'); }

function detectSource(root, host) {
  try { if (fs.statSync(v3Path(root, host)).isFile()) return 'v3'; } catch (e) { /* fall through */ }
  return 'm0';
}

function readLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { lines: [], exists: false }; }
  return { lines: raw.split('\n').filter(Boolean), exists: true };
}

function readLedgerRows(source, root, host) {
  const file = source === 'v3' ? v3Path(root, host) : m0Path(root, host);
  const { lines, exists } = readLines(file);
  const cols = source === 'v3' ? V3_COLUMNS : M0_COLUMNS;
  let body = lines;
  if (source === 'v3' && body.length && body[0].split('\t')[0] === 'schema_version') body = body.slice(1);
  const rows = [];
  let malformed = 0;
  for (const line of body) {
    const parts = line.split('\t');
    // A row whose field count doesn't match the schema is untrustworthy to map positionally — a
    // missing middle field right-shifts every later column. CONFIRMED on the real M0 ledger during
    // this build: 11/1362 rows are missing `event_id` entirely. Never trust such a row enough to
    // authorize labeling against it (see pmm-recall-queue.cjs's readLedgerRows for the fuller
    // rationale, duplicated here since no shared module was authorized by the build brief).
    if (parts.length !== cols.length) { malformed++; continue; }
    const row = {};
    cols.forEach((c, i) => { row[c] = parts[i]; });
    if (source === 'm0') row.trigger_or_gate_id = row.trigger_id;
    rows.push(row);
  }
  return { rows, file, exists, malformed };
}

function dedupByEventId(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r.event_id) { out.push(r); continue; }
    if (seen.has(r.event_id)) continue;
    seen.add(r.event_id);
    out.push(r);
  }
  return out;
}

// isContaminatedRow (2026-09-17, coordinator LOW-K2-followup / real-ledger contamination incident):
// the confirmed marker for the 572 pmm-trigger-recall.sh self-test rows that leaked into the real
// production ledger (root-caused and fixed at the source -- see pmm-trigger-recall.sh's PMM_RECALL_
// ROOT isolation). For THIS tool the id_missing=1 leg is already a structural no-op today -- those
// rows also have a blank impression_id (pmm-trigger-recall.cjs's ledgerIds() returns impression_id=
// '' whenever id_missing is true), and isMatchedRow() below already requires a non-empty
// impression_id, so they were never labelable in the first place. The blank-sid_sha16 leg is kept as
// an independent, forward-looking net (matches the write-side isPoisonedSid() guard's concern in
// pmm-recall-ledger.cjs and the same check in baseline/m3/precision/queue) in case a future
// contamination pattern has a non-blank impression_id but no real session identity.
function isContaminatedRow(r) {
  // M-1 read-side (2026-09-17, fab blind attack item 5 / Opus reproduction): two more pure-count
  // markers found across the real ledger -- run_provenance starting with 'test' and tool_use_id
  // shaped like runner-synthesized ids (tu-<...>, never Claude Code's own toolu_<...> format). See
  // pmm-recall-baseline.cjs's copy of this function for the full rationale (identical across all
  // five read tools).
  return r.id_missing === '1' || !r.sid_sha16 ||
    (typeof r.run_provenance === 'string' && r.run_provenance.indexOf('test') === 0) ||
    (typeof r.tool_use_id === 'string' && /^tu-/.test(r.tool_use_id));
}

function isMatchedRow(r) {
  return !!(r.impression_id && r.trigger_or_gate_id && MATCHED_KINDS.has(r.event_kind) && !isContaminatedRow(r));
}

// Only impression_ids that surfaced as a genuine matched exposure (the same universe
// pmm-recall-queue.cjs lists) are labelable — an id that only ever appears on a bookkeeping row
// (event_kind='observed', no trigger match) was never something a human could have judged
// relevant/irrelevant, so it is treated as "not in the ledger" for labeling purposes. This is a
// judgment call the spec text does not spell out explicitly (see build report).
function matchedImpressionIds(dedupedRows) {
  const set = new Set();
  for (const r of dedupedRows) if (isMatchedRow(r)) set.add(r.impression_id);
  return set;
}

function tsvSafe(s) { return String(s == null ? '' : s).replace(/[\t\r\n]/g, ' '); }

function safeUsername() {
  try { return os.userInfo().username || 'unknown'; } catch (e) { return 'unknown'; }
}

// ---------------------------------------------------------------------------------------------
// Label-specific logic
// ---------------------------------------------------------------------------------------------

function parseLabelArgs(argv) {
  const opts = { selfTest: false, undo: false, source: null, impressionId: null, label: null, note: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') { opts.selfTest = true; continue; }
    if (a === '--undo') { opts.undo = true; continue; }
    if (a === '--source') { opts.source = argv[++i]; continue; }
    if (a.startsWith('--source=')) { opts.source = a.slice('--source='.length); continue; }
    rest.push(a);
  }
  if (opts.selfTest) return opts;
  opts.impressionId = rest[0] || null;
  if (opts.undo) return opts;
  opts.label = rest[1] || null;
  opts.note = rest.slice(2).join(' ');
  return opts;
}

function doLabel(opts) {
  if (!opts.impressionId) {
    console.error('usage: pmm-recall-label.cjs <impression_id> useful|noise|useful-not-followed [note...]');
    console.error('       pmm-recall-label.cjs --undo <impression_id>');
    return 1;
  }
  if (!opts.undo) {
    if (!opts.label) {
      console.error('usage: pmm-recall-label.cjs <impression_id> useful|noise|useful-not-followed [note...]');
      return 1;
    }
    if (!VALID_LABELS.has(opts.label)) {
      console.error(`invalid label '${opts.label}' — must be one of: useful | noise | useful-not-followed`);
      return 1;
    }
  }

  const root = resolveRoot();
  const host = resolveHost();
  const source = opts.source || detectSource(root, host);
  const { rows } = readLedgerRows(source, root, host);
  const deduped = dedupByEventId(rows);
  const known = matchedImpressionIds(deduped);
  if (!known.has(opts.impressionId)) {
    console.error(`impression_id not found in ledger (source=${source}, root=${root}): ${opts.impressionId}`);
    return 3;
  }

  const file = labelsPath(root, host);
  const ts = new Date().toISOString();
  const labeler = process.env.PMM_RECALL_LABELER || safeUsername();
  const finalLabel = opts.undo ? UNDO_SENTINEL : opts.label;
  const line = [ts, opts.impressionId, finalLabel, tsvSafe(opts.note), tsvSafe(labeler)].join('\t') + '\n';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, { flag: 'a' });
  } catch (e) {
    console.error('failed to write labels file: ' + e.message);
    return 2;
  }
  console.log(`${opts.undo ? 'undone' : 'labeled'} ${opts.impressionId} -> ${finalLabel} (${file})`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------------------------

function runSelfTest() {
  const results = [];
  function report(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (ok ? '' : '  (' + detail + ')'));
  }

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-label-selftest-'));
  // LOW-3 (2026-09-17, fab blind attack): process.on('exit') safety net in ADDITION to the try/finally
  // cleanup below -- see pmm-recall-m3.cjs's copy of this comment for the full rationale.
  process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  const HOST = 'test-host';
  const env = Object.assign({}, process.env, { PMM_RECALL_ROOT: T, PMM_RECALL_HOST: HOST });
  function run(args, extraEnv) {
    return spawnSync(process.execPath, [__filename].concat(args), { env: Object.assign({}, env, extraEnv || {}), encoding: 'utf8' });
  }
  function labelsLines() {
    try { return fs.readFileSync(path.join(T, 'labels-' + HOST + '.tsv'), 'utf8').split('\n').filter(Boolean); }
    catch (e) { return []; }
  }

  try {
    // m0-style ledger with one matched impression + one observed-only (non-matched) impression.
    function m0Row(kind, sid, tool, trig, cls, impId, evId, ts) {
      const cols = ['1', ts, sid, tool, '', '', '', '0', kind, trig, cls, 'posix', '0', 'tail', '',
        'ok', 'aaaa', '1.1', impId, evId, '0', '0'];
      return cols.join('\t');
    }
    fs.writeFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), [
      m0Row('eligible', 's1', 't1', 'triggerA', 'class:x', 'impA1', 'evA1', '2026-01-01T00:00:00Z'),
      m0Row('observed', 's2', 't2', '', '', 'impObsOnly', 'evObs1', '2026-01-01T00:00:01Z'),
    ].join('\n') + '\n');

    // 1. unknown impression_id -> rc 3, no file written
    let r = run(['does-not-exist', 'useful']);
    report('unknown impression_id -> rc 3', r.status === 3, 'status=' + r.status + ' stderr=' + r.stderr);
    report('unknown impression_id -> no labels file created', !fs.existsSync(path.join(T, 'labels-' + HOST + '.tsv')), '');

    // 2. observed-only (never matched) impression_id -> also rc 3
    r = run(['impObsOnly', 'useful']);
    report('observed-only (non-matched) impression_id -> rc 3', r.status === 3, 'status=' + r.status);

    // 2b. malformed row (real-world case: event_id field missing, field count mismatch) must never
    // authorize a label — its impression_id is untrustworthy even though it looks parseable by luck.
    const malformedLine = ['1', '2026-01-01T00:05:00Z', 's9', 't9', '', '', '', '0', 'eligible',
      'triggerA', 'class:x', 'posix', '0', 'tail', '', 'ok', 'aaaa', '1.1', 'impMalformed', '0'].join('\t');
    fs.appendFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), malformedLine + '\n');
    r = run(['impMalformed', 'useful']);
    report('malformed-row impression_id -> rc 3 (never trusted for labeling)', r.status === 3, 'status=' + r.status);

    // 3. invalid label value -> rc 1
    r = run(['impA1', 'sort-of-useful']);
    report('invalid label value -> rc 1', r.status === 1, 'status=' + r.status);

    // 4. missing args -> rc 1
    r = run(['impA1']);
    report('missing label arg -> rc 1', r.status === 1, 'status=' + r.status);
    r = run([]);
    report('no args at all -> rc 1', r.status === 1, 'status=' + r.status);

    // 5. valid label -> rc 0, one line appended with correct columns
    r = run(['impA1', 'noise', 'looked', 'unrelated']);
    report('valid label -> rc 0', r.status === 0, 'status=' + r.status + ' stderr=' + r.stderr);
    let lines = labelsLines();
    report('exactly 1 line written', lines.length === 1, JSON.stringify(lines));
    let cols = (lines[0] || '').split('\t');
    report('columns are ts,impression_id,label,note,labeler (5 cols)', cols.length === 5, JSON.stringify(cols));
    report('impression_id column correct', cols[1] === 'impA1', cols[1]);
    report('label column correct', cols[2] === 'noise', cols[2]);
    report('note joined from remaining args', cols[3] === 'looked unrelated', cols[3]);

    // 6. useful-not-followed is a valid third value (HIGH-5: distinct from both useful and noise)
    r = run(['impA1', 'useful-not-followed']);
    report('useful-not-followed accepted -> rc 0', r.status === 0, 'status=' + r.status);
    lines = labelsLines();
    report('2 lines now (append-only, no rewrite)', lines.length === 2, JSON.stringify(lines));
    report('"last write wins" semantics: last line is the useful-not-followed one', lines[1].split('\t')[2] === 'useful-not-followed', lines[1]);

    // 7. relabel again with useful -> 3rd append, last-wins would now read 'useful'
    r = run(['impA1', 'useful']);
    lines = labelsLines();
    report('relabeling appends rather than overwrites (3 lines total)', lines.length === 3, JSON.stringify(lines));

    // 8. --undo appends a tombstone row rather than deleting history
    r = run(['--undo', 'impA1']);
    report('--undo -> rc 0', r.status === 0, 'status=' + r.status);
    lines = labelsLines();
    report('--undo appends a 4th line (history preserved)', lines.length === 4, JSON.stringify(lines));
    report('--undo tombstone label is the sentinel value', lines[3].split('\t')[2] === UNDO_SENTINEL, lines[3]);

    // 9. --undo on a nonexistent id is still validated against the ledger (rc 3)
    r = run(['--undo', 'does-not-exist']);
    report('--undo on unknown impression_id -> rc 3', r.status === 3, 'status=' + r.status);

    // 10. labeler defaults to something non-empty and PMM_RECALL_LABELER overrides it
    r = run(['impA1', 'noise'], { PMM_RECALL_LABELER: 'jax-test-labeler' });
    lines = labelsLines();
    const lastCols = lines[lines.length - 1].split('\t');
    report('PMM_RECALL_LABELER env overrides labeler column', lastCols[4] === 'jax-test-labeler', lastCols[4]);

    // 11. tabs/newlines in the note never corrupt the TSV row shape
    r = run(['impA1', 'useful', 'note\twith\ttabs\nand a newline']);
    lines = labelsLines();
    const sanitizedCols = lines[lines.length - 1].split('\t');
    report('note with embedded tab/newline sanitized to keep exactly 5 columns', sanitizedCols.length === 5, JSON.stringify(sanitizedCols));

    // ---- v3-style ledger adapter (this builder's own synthetic fixture) --------------------------
    const T2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-label-v3-'));
    const env2 = Object.assign({}, process.env, { PMM_RECALL_ROOT: T2, PMM_RECALL_HOST: HOST });
    function run2(args) { return spawnSync(process.execPath, [__filename].concat(args), { env: env2, encoding: 'utf8' }); }
    function v3Row(kind, sid, tool, trig, cls, impId, evId, ts) {
      return ['3', ts, sid, 'agentA', 'sonnet-builder', 'promptA', tool, impId, evId, kind, '',
        '', cls, trig, 'aaaa', '1.1', 'shadow', '', '0', '0', '0'].join('\t');
    }
    fs.writeFileSync(path.join(T2, 'events-v3-' + HOST + '.tsv'), [
      V3_COLUMNS.join('\t'),
      v3Row('would-warn', 'sv1', 'tv1', 'gateX', 'class:z', 'impV1', 'evV1', '2026-02-01T00:00:00Z'),
    ].join('\n') + '\n');
    r = run2(['impV1', 'useful']);
    report('v3 source: known matched impression_id -> rc 0', r.status === 0, 'status=' + r.status + ' stderr=' + r.stderr);
    r = run2(['not-in-v3-ledger', 'useful']);
    report('v3 source: unknown impression_id -> rc 3', r.status === 3, 'status=' + r.status);

    // ---- read-only against everything except labels-<host>.tsv -----------------------------------
    const ledgerBefore = fs.readFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), 'utf8');
    run(['impA1', 'noise']);
    const ledgerAfter = fs.readFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), 'utf8');
    report('ledger file byte-identical after labeling (never mutated)', ledgerBefore === ledgerAfter, '');

    // ---- LOW-K2 (2026-09-17, codex second wave / Opus reproduction): PMM_RECALL_ROOT=' ' must
    // resolve to the SAME directory a writer (ledger.resolveRoot()) would use -- never a literal ' '
    // path, which would make this tool look for the ledger/labels file in an empty directory and
    // reject every impression_id as "not found" (rc 3) even though the real data is sitting in the
    // actual default. Verified two ways: (a) pure computation -- this module's resolveRoot() is a
    // direct re-export of the ledger's; (b) end-to-end -- HOME/USERPROFILE redirected to a temp dir,
    // a v3 ledger placed exactly where a real writer would leave it, label a real impression_id with
    // PMM_RECALL_ROOT=' ' and confirm rc=0 + the labels file lands in that SAME default directory. --
    {
      const before = process.env.PMM_RECALL_ROOT;
      process.env.PMM_RECALL_ROOT = ' ';
      try {
        const fromHere = resolveRoot();
        const fromLedger = ledger.resolveRoot();
        report('LOW-K2a: PMM_RECALL_ROOT=\' \' -> resolveRoot() here is never the literal whitespace', fromHere !== ' ', JSON.stringify(fromHere));
        report('LOW-K2b: PMM_RECALL_ROOT=\' \' -> resolveRoot() here === ledger.resolveRoot() (same resolver)', fromHere === fromLedger, JSON.stringify({ fromHere, fromLedger }));
      } finally {
        if (before === undefined) delete process.env.PMM_RECALL_ROOT; else process.env.PMM_RECALL_ROOT = before;
      }
    }
    {
      const fakeHome = path.join(T, 'lowk2-fakehome-' + Date.now());
      fs.mkdirSync(fakeHome, { recursive: true });
      const expectedDefaultRoot = path.join(fakeHome, '.claude', '.local', 'pmm-recall');
      fs.mkdirSync(expectedDefaultRoot, { recursive: true });
      const dataRow = ['1', '2026-01-01T00:00:00.000Z', 's', 'a', '', '', 'tu', 'impLowk2', 'ev', 'eligible',
        '', '', 'class:lowk2', 'trigLowk2', '', '', 'intervene', 'policy:absent', '0', '0', '0'].join('\t');
      fs.writeFileSync(path.join(expectedDefaultRoot, 'events-v3-' + os.hostname() + '.tsv'), V3_COLUMNS.join('\t') + '\n' + dataRow + '\n');
      const env2 = Object.assign({}, process.env, { PMM_RECALL_ROOT: ' ', HOME: fakeHome, USERPROFILE: fakeHome });
      delete env2.PMM_RECALL_HOST;
      const r = spawnSync(process.execPath, [__filename, 'impLowk2', 'useful'], { env: env2, encoding: 'utf8' });
      report('LOW-K2c end-to-end: labeling a real impression_id with whitespace root + redirected HOME -> rc 0 (found the writer\'s data, NOT rc 3)', r.status === 0, 'status=' + r.status + ' stderr=' + r.stderr);
      const labelsFile = path.join(expectedDefaultRoot, 'labels-' + os.hostname() + '.tsv');
      report('LOW-K2d end-to-end: labels file landed in the SAME default-root directory the ledger was read from', fs.existsSync(labelsFile) && fs.readFileSync(labelsFile, 'utf8').indexOf('impLowk2') !== -1, labelsFile);
    }

    // ---- LOW-K2-followup (2026-09-17, coordinator: real-ledger contamination incident): a row that
    // WOULD otherwise satisfy isMatchedRow() (non-empty impression_id, trigger, matched event_kind)
    // but is contaminated (id_missing=1 or blank sid_sha16) must still be rc=3 "not found" -- never
    // labelable, even if some future write path produces a non-blank impression_id for such a row
    // (unlike THIS incident's real rows, which already had a blank impression_id and so were already
    // structurally unreachable here before this change; see the isContaminatedRow() comment).
    {
      const contamRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-label-contam-'));
      const contamHost = 'contam-host';
      // id_missing=1 row (columns: ...,'aaaa','1.1',impId,evId, id_missing='1', sanitized='0')
      const idMissingRow = ['1', '2026-01-01T00:00:00Z', 'sXX', 'tXX', '', '', '', '0', 'eligible',
        'test:trig-alpha', 'test:trig-alpha', 'posix', '0', 'tail', '', 'ok', 'aaaa', '1.1',
        'impContamIdMissing', 'evContamIdMissing', '1', '0'].join('\t');
      // blank sid_sha16 row, id_missing=0 (independent marker)
      const blankSidRow = ['1', '2026-01-01T00:00:01Z', '', 'tYY', '', '', '', '0', 'eligible',
        'triggerBlankSid', 'class:blanksid', 'posix', '0', 'tail', '', 'ok', 'aaaa', '1.1',
        'impContamBlankSid', 'evContamBlankSid', '0', '0'].join('\t');
      fs.writeFileSync(path.join(contamRoot, 'impressions-' + contamHost + '.tsv'), [idMissingRow, blankSidRow].join('\n') + '\n');
      const contamEnv = Object.assign({}, process.env, { PMM_RECALL_ROOT: contamRoot, PMM_RECALL_HOST: contamHost });
      const r1 = spawnSync(process.execPath, [__filename, 'impContamIdMissing', 'useful'], { env: contamEnv, encoding: 'utf8' });
      report('LOW-K2-followup: id_missing=1 row -> rc 3, never labelable despite a non-empty impression_id', r1.status === 3, 'status=' + r1.status + ' stderr=' + r1.stderr);
      const r2 = spawnSync(process.execPath, [__filename, 'impContamBlankSid', 'useful'], { env: contamEnv, encoding: 'utf8' });
      report('LOW-K2-followup: blank sid_sha16 row -> rc 3, never labelable', r2.status === 3, 'status=' + r2.status + ' stderr=' + r2.stderr);
      report('LOW-K2-followup: no labels file was created for either contaminated attempt', !fs.existsSync(path.join(contamRoot, 'labels-' + contamHost + '.tsv')), '');
      fs.rmSync(contamRoot, { recursive: true, force: true });
    }
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return runSelfTest();
  const opts = parseLabelArgs(argv);
  return doLabel(opts);
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { resolveRoot, resolveHost, detectSource, readLedgerRows, dedupByEventId,
  isMatchedRow, matchedImpressionIds, VALID_LABELS, UNDO_SENTINEL };
