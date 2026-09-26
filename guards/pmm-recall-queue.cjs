#!/usr/bin/env node
// pmm-recall-queue.cjs — M1 review queue: lists matched-trigger/gate exposures for human labeling.
//
// guards/specs/RECALL-LOOP-M-SPEC-v2.md M1 section + Appendix A (2026-09-16 "台账契约同步").
// READ-ONLY: this tool never writes any file. It reads three inputs, all under
// <PMM_RECALL_ROOT> (default ~/.claude/.local/pmm-recall/):
//   1. the persistent event ledger — either the v3 unified ledger `events-v3-<host>.tsv`
//      (Appendix A: 21 columns, header row, written by the not-yet-delivered shared module
//      pmm-recall-ledger.cjs) or, as a read-only adapter, the existing M0 ledger
//      `impressions-<host>.tsv` (22 columns, NO header row — column order copied verbatim
//      from pmm-bash-impression.cjs's own header comment, since that file IS the schema of
//      record for M0 today);
//   2. the short-term desensitized display layer `queue-<host>.tsv` (7-day rolling, written by
//      the M0/gate hooks) — either today's 6-column shape (impression_id, trigger_id, exe, sub,
//      ts, snippet — no class_tag) or the Appendix-A-defined 7-column M1 shape (impression_id,
//      trigger_or_gate_id, class_tag, exe, sub, ts, snippet). Both are auto-detected per line by
//      column count so this tool works whether or not the other builder's v3 writer has shipped;
//   3. `labels-<host>.tsv` (written only by pmm-recall-label.cjs) to show the current label, if any.
//
// Appendix A is explicit that the WRITE side does not dedupe (events-v3 rows can repeat) and the
// READ side must dedupe by event_id and then aggregate by impression_id (one impression_id can
// legitimately appear on more than one row — e.g. two command segments matching the same trigger,
// or an eligible+suppressed pair — describing the SAME exposure opportunity twice). This file does
// exactly that: dedupe by event_id first, then fold matching rows into one queue entry per
// impression_id.
//
// "Matched" (i.e. queue-worthy) rows are event_kind values that mean "a trigger/gate actually fired
// against a real command": eligible | suppressed | displayed | would-warn | emitted |
// recurrence-candidate | recurrence. Bookkeeping kinds (observed, session-end, cd-hint,
// path_unresolved, pending-*, receipt-lost, unsupported) never represent an exposure and are
// excluded — this mirrors HIGH-6's "unsupported must never masquerade as matched=0" discipline: a
// non-match must never look like a match, in either direction.
//
// Known spec gap (see build report): the v3 COLUMNS list in Appendix A carries no exe/sub fields
// (only hashes + gate/confidence), so for --source v3 this tool can ONLY get exe/sub/snippet from
// the separate queue display file, never from the ledger itself. For --source m0 the ledger DOES
// carry exe/sub (columns 14/15) and this tool prefers those, falling back to the queue-file join
// when a ledger row lacks them.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// pmm-recall-ledger.cjs (2026-09-17, LOW-K2 Opus review): the write side already converged all
// five writers onto ledger's resolveRoot() (round LOW-5); this tool is one of the five read-side
// tools that still carried its own un-normalized `process.env.PMM_RECALL_ROOT || defaultRoot()`
// copy — under PMM_RECALL_ROOT=' ' (whitespace) that returns the literal " " directory while the
// writers fall back to the real default, so this tool would silently list an empty queue while a
// real writer's data sits in the real default. Reusing ledger's trimming resolveRoot() closes
// that divergence. (This is the one narrow exception to the "no fourth shared module" note below
// — resolveRoot() itself was never one of the three tools' own logic, it's ledger's contract.)
const ledger = require('./pmm-recall-ledger.cjs');

// ---------------------------------------------------------------------------------------------
// Shared reading layer (deliberately duplicated, byte-for-byte in spirit, across the three M1
// tools per the build brief's write-surface restriction to exactly these three new files — no
// fourth shared module was authorized).
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

const UNDO_SENTINEL = 'undo';

const resolveRoot = ledger.resolveRoot;
function resolveHost() {
  return process.env.PMM_RECALL_HOST || os.hostname();
}
function v3Path(root, host) { return path.join(root, 'events-v3-' + host + '.tsv'); }
function m0Path(root, host) { return path.join(root, 'impressions-' + host + '.tsv'); }
function queuePath(root, host) { return path.join(root, 'queue-' + host + '.tsv'); }
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

// Reads the persistent ledger for the given source, returns raw row objects (pre-dedup).
function readLedgerRows(source, root, host) {
  const file = source === 'v3' ? v3Path(root, host) : m0Path(root, host);
  const { lines, exists } = readLines(file);
  const cols = source === 'v3' ? V3_COLUMNS : M0_COLUMNS;
  let body = lines;
  // v3 carries a header row (Appendix A: "表头行 = 共用模块 COLUMNS"); m0's ledger never has one.
  if (source === 'v3' && body.length && body[0].split('\t')[0] === 'schema_version') body = body.slice(1);
  const rows = [];
  let malformed = 0;
  for (const line of body) {
    const parts = line.split('\t');
    // A row whose field count doesn't match the schema is untrustworthy to map positionally: a
    // missing middle field silently right-shifts every later column. CONFIRMED on the real M0
    // ledger during this build: 11/1362 rows are missing `event_id` entirely (21 fields instead of
    // 22), which right-shifts `id_missing`/`sanitized` and produces a bogus literal event_id "0" —
    // an event_id-dedup would then treat unrelated rows as duplicates of each other purely because
    // they share that fake sentinel. Excluding malformed rows from analysis (and counting them) is
    // safer than trusting a corrupted positional mapping — the same "never guess at an unparseable
    // shape" discipline the spec already applies to unsupported command syntax.
    if (parts.length !== cols.length) { malformed++; continue; }
    const row = {};
    cols.forEach((c, i) => { row[c] = parts[i]; });
    if (source === 'm0') row.trigger_or_gate_id = row.trigger_id;
    rows.push(row);
  }
  return { rows, file, exists, totalLines: body.length, malformed };
}

// Appendix A: "写入端不去重;读取端按 event_id 去重并报告重复率".
function dedupByEventId(rows) {
  const seen = new Set();
  const out = [];
  let dupeCount = 0;
  for (const r of rows) {
    if (!r.event_id) { out.push(r); continue; } // id_missing rows: no stable key, can't dedup, kept as-is
    if (seen.has(r.event_id)) { dupeCount++; continue; }
    seen.add(r.event_id);
    out.push(r);
  }
  return { rows: out, totalRead: rows.length, distinctCount: out.length, dupeCount,
    dupeRate: rows.length ? dupeCount / rows.length : 0 };
}

// isContaminatedRow (2026-09-17, coordinator LOW-K2-followup / real-ledger contamination incident):
// the confirmed, cross-validated marker for the pmm-trigger-recall.sh self-test rows that repeatedly
// leaked into the real production ledger (root-caused and fixed at the source -- see pmm-trigger-
// recall.sh's PMM_RECALL_ROOT isolation). id_missing=1 already implies a blank impression_id for
// those specific rows, so isMatchedRow() below was already excluding them structurally; this check
// is kept explicit anyway so the exclusion is counted (excluded_contaminated) rather than a silent
// side effect, and so the blank-sid_sha16 leg is covered as an independent, forward-looking net.
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

// Folds deduped rows into one aggregate per impression_id (Appendix A: "再按 impression_id 聚合").
function aggregateImpressions(dedupedRows) {
  const map = new Map();
  for (const r of dedupedRows) {
    if (!isMatchedRow(r)) continue;
    let agg = map.get(r.impression_id);
    if (!agg) {
      agg = {
        impression_id: r.impression_id,
        trigger_or_gate_id: r.trigger_or_gate_id,
        class_tag: r.class_tag || '',
        kinds: new Set(),
        ts: r.ts || '',
        exe: r.exe || '',
        sub: r.sub || '',
      };
      map.set(r.impression_id, agg);
    }
    agg.kinds.add(r.event_kind);
    if (!agg.class_tag && r.class_tag) agg.class_tag = r.class_tag;
    if (r.ts && (!agg.ts || r.ts < agg.ts)) agg.ts = r.ts; // earliest ts for this opportunity
    if (!agg.exe && r.exe) agg.exe = r.exe;
    if (!agg.sub && r.sub) agg.sub = r.sub;
  }
  return map;
}

// Display-layer queue join: exe/sub/ts/snippet, auto-detecting today's 6-col m0 shape vs the
// Appendix-A 7-col M1 shape (impression_id trigger_or_gate_id class_tag exe sub ts snippet).
function readQueueMap(root, host) {
  const file = queuePath(root, host);
  const { lines, exists } = readLines(file);
  const map = new Map();
  for (const line of lines) {
    const parts = line.split('\t');
    let entry;
    if (parts.length >= 7) {
      entry = { impression_id: parts[0] || '', trigger_or_gate_id: parts[1] || '',
        class_tag: parts[2] || '', exe: parts[3] || '', sub: parts[4] || '', ts: parts[5] || '',
        snippet: parts[6] || '' };
    } else {
      entry = { impression_id: parts[0] || '', trigger_or_gate_id: parts[1] || '', class_tag: '',
        exe: parts[2] || '', sub: parts[3] || '', ts: parts[4] || '', snippet: parts[5] || '' };
    }
    if (entry.impression_id) map.set(entry.impression_id, entry); // last occurrence wins
  }
  return { map, file, exists };
}

function readLabelsMap(root, host) {
  const file = labelsPath(root, host);
  const { lines, exists } = readLines(file);
  const map = new Map();
  for (const line of lines) {
    const parts = line.split('\t');
    const row = { ts: parts[0] || '', impression_id: parts[1] || '', label: parts[2] || '',
      note: parts[3] || '', labeler: parts[4] || '' };
    if (row.impression_id) map.set(row.impression_id, row); // last write wins (append order = chronological)
  }
  return { map, file, exists };
}

function currentLabelOf(labelsMap, impressionId) {
  const row = labelsMap.get(impressionId);
  if (!row || !row.label || row.label === UNDO_SENTINEL) return null;
  return row.label;
}

// ---------------------------------------------------------------------------------------------
// Queue-specific logic
// ---------------------------------------------------------------------------------------------

function buildQueue(opts) {
  const root = resolveRoot();
  const host = resolveHost();
  const source = opts.source || detectSource(root, host);
  const ledger = readLedgerRows(source, root, host);
  const dedup = dedupByEventId(ledger.rows);
  // LOW-K2-followup: count contaminated rows that otherwise look like a matched exposure (a
  // trigger_or_gate_id + a matched event_kind) but are excluded by isContaminatedRow(). See that
  // function's comment for why r.impression_id is deliberately not also required here.
  const excludedContaminatedCount = dedup.rows.filter((r) =>
    r.trigger_or_gate_id && MATCHED_KINDS.has(r.event_kind) && isContaminatedRow(r)).length;
  const impressions = aggregateImpressions(dedup.rows);
  const queueLayer = readQueueMap(root, host);
  const labelsLayer = readLabelsMap(root, host);

  // Join display fields; prefer ledger exe/sub (m0 has them), fall back to queue-file join.
  const items = [];
  for (const imp of impressions.values()) {
    const q = queueLayer.map.get(imp.impression_id);
    const exe = imp.exe || (q && q.exe) || '';
    const sub = imp.sub || (q && q.sub) || '';
    const ts = (q && q.ts) || imp.ts || '';
    let snippet = (q && q.snippet) || '';
    if (snippet.length > 120) snippet = snippet.slice(0, 120);
    const classTag = imp.class_tag || (q && q.class_tag) || '';
    const label = currentLabelOf(labelsLayer.map, imp.impression_id);
    items.push({
      impression_id: imp.impression_id,
      trigger_or_gate_id: imp.trigger_or_gate_id,
      class_tag: classTag,
      exe, sub, ts, snippet,
      label: label || null,
    });
  }

  // Stratified sampling by trigger_or_gate_id.
  const byTrigger = new Map();
  for (const it of items) {
    if (!byTrigger.has(it.trigger_or_gate_id)) byTrigger.set(it.trigger_or_gate_id, []);
    byTrigger.get(it.trigger_or_gate_id).push(it);
  }
  const perTrigger = opts.perTrigger || 30;
  const triggerReports = [];
  for (const [tag, list] of Array.from(byTrigger.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    const matched = list.length;
    const labeled = list.filter((it) => it.label).length;
    let pool = list;
    if (opts.unlabeledOnly) pool = pool.filter((it) => !it.label);
    const sampled = pool.slice(0, perTrigger);
    triggerReports.push({ trigger_or_gate_id: tag, matched, labeled, sampled: sampled.length, items: sampled });
  }

  return {
    source, root, host,
    // LOW-K2-followup: history rows excluded as contaminated (id_missing=1 or blank sid_sha16) --
    // never deleted from the ledger itself, only excluded from THIS listing's aggregation.
    excluded_contaminated: excludedContaminatedCount,
    ledger: { file: ledger.file, exists: ledger.exists, rows_read: dedup.totalRead,
      distinct_event_id: dedup.distinctCount, dupe_rate: dedup.dupeRate,
      malformed_rows_excluded: ledger.malformed },
    queue_file: { file: queueLayer.file, exists: queueLayer.exists },
    labels_file: { file: labelsLayer.file, exists: labelsLayer.exists },
    triggers: triggerReports,
  };
}

function formatText(report) {
  const lines = [];
  lines.push(`source=${report.source} root=${report.root} host=${report.host}`);
  lines.push(`excluded_contaminated=${report.excluded_contaminated}`);
  lines.push(`ledger: file=${report.ledger.file} exists=${report.ledger.exists} rows_read=${report.ledger.rows_read} distinct_event_id=${report.ledger.distinct_event_id} dupe_rate=${(report.ledger.dupe_rate * 100).toFixed(2)}% malformed_rows_excluded=${report.ledger.malformed_rows_excluded}`);
  lines.push(`queue display: file=${report.queue_file.file} exists=${report.queue_file.exists}`);
  lines.push(`labels: file=${report.labels_file.file} exists=${report.labels_file.exists}`);
  lines.push('');
  if (!report.triggers.length) {
    lines.push('(no matched impressions found)');
    return lines.join('\n');
  }
  for (const tr of report.triggers) {
    lines.push(`== ${tr.trigger_or_gate_id} == matched=${tr.matched} labeled=${tr.labeled} sampled=${tr.sampled}`);
    for (const it of tr.items) {
      lines.push([it.impression_id, it.trigger_or_gate_id, `${it.exe} ${it.sub}`.trim(), it.ts,
        it.snippet, it.label || '-'].join(' | '));
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function parseQueueArgs(argv) {
  const opts = { source: null, perTrigger: 30, unlabeledOnly: false, json: false, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') opts.selfTest = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--unlabeled-only') opts.unlabeledOnly = true;
    else if (a === '--source') opts.source = argv[++i];
    else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length);
    else if (a === '--per-trigger') opts.perTrigger = parseInt(argv[++i], 10);
    else if (a.startsWith('--per-trigger=')) opts.perTrigger = parseInt(a.slice('--per-trigger='.length), 10);
  }
  if (!Number.isFinite(opts.perTrigger) || opts.perTrigger <= 0) opts.perTrigger = 30;
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Self-test (fixture-based, entirely under a temp PMM_RECALL_ROOT — never touches real data)
// ---------------------------------------------------------------------------------------------

function runSelfTest() {
  const results = [];
  function report(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (ok ? '' : '  (' + detail + ')'));
  }

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-queue-selftest-'));
  // LOW-3 (2026-09-17, fab blind attack): process.on('exit') safety net in ADDITION to the try/finally
  // cleanup below -- see pmm-recall-m3.cjs's copy of this comment for the full rationale.
  process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  const HOST = 'test-host';
  const env = Object.assign({}, process.env, { PMM_RECALL_ROOT: T, PMM_RECALL_HOST: HOST });

  function run(args) {
    return spawnSync(process.execPath, [__filename].concat(args), { env, encoding: 'utf8' });
  }

  try {
    // ---- Fixture 1: m0-style ledger + legacy 6-col queue file -----------------------------------
    const m0LedgerLines = [];
    function m0Row(kind, sid, tool, trig, cls, exe, sub, impId, evId, ts) {
      const cols = ['1', ts, sid, tool, '', '', '', '0', kind, trig, cls, 'posix', '0', exe, sub,
        'ok', 'aaaa', '1.1', impId, evId, '0', '0'];
      return cols.join('\t');
    }
    // Trigger A: 3 matched impressions (2 eligible-kind, 1 suppressed), one duplicate event_id row.
    m0LedgerLines.push(m0Row('observed', 's1', 't1', '', '', 'tail', '', 'impA1', 'evObsA1', '2026-01-01T00:00:00Z'));
    m0LedgerLines.push(m0Row('eligible', 's1', 't1', 'triggerA', 'class:x', 'tail', '', 'impA1', 'evA1', '2026-01-01T00:00:00Z'));
    m0LedgerLines.push(m0Row('eligible', 's1', 't1', 'triggerA', 'class:x', 'tail', '', 'impA1', 'evA1', '2026-01-01T00:00:00Z')); // exact duplicate row (dupe event_id)
    m0LedgerLines.push(m0Row('eligible', 's2', 't2', 'triggerA', 'class:x', 'tail', '', 'impA2', 'evA2', '2026-01-01T00:01:00Z'));
    m0LedgerLines.push(m0Row('suppressed', 's3', 't3', 'triggerA', 'class:x', 'tail', '', 'impA3', 'evA3', '2026-01-01T00:02:00Z'));
    // Trigger B: 1 matched impression.
    m0LedgerLines.push(m0Row('eligible', 's4', 't4', 'triggerB', 'class:y', 'head', '', 'impB1', 'evB1', '2026-01-01T00:03:00Z'));
    // Unsupported-parse row must never count as matched (HIGH-6 discipline carried into the reader).
    m0LedgerLines.push(m0Row('observed', 's5', 't5', '', '', '', '', 'impC1', 'evC1', '2026-01-01T00:04:00Z'));

    fs.writeFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), m0LedgerLines.join('\n') + '\n');
    // legacy 6-col queue display file (today's real shape: no class_tag)
    fs.writeFileSync(path.join(T, 'queue-' + HOST + '.tsv'), [
      ['impA1', 'triggerA', 'tail', '', '2026-01-01T00:00:00Z', 'tail -1 foo'].join('\t'),
      ['impA2', 'triggerA', 'tail', '', '2026-01-01T00:01:00Z', 'tail -2 bar'].join('\t'),
      ['impA3', 'triggerA', 'tail', '', '2026-01-01T00:02:00Z', 'tail -3 baz'].join('\t'),
      ['impB1', 'triggerB', 'head', '', '2026-01-01T00:03:00Z', 'head -1 qux'].join('\t'),
    ].join('\n') + '\n');

    let r = run(['--json']);
    report('m0 source: exits 0', r.status === 0, 'status=' + r.status + ' stderr=' + r.stderr);
    let out = {};
    try { out = JSON.parse(r.stdout); } catch (e) { /* leave {} */ }
    report('m0 source: auto-detected as m0', out.source === 'm0', JSON.stringify(out.source));
    report('m0 source: dedup drops exact-duplicate event_id row (7 raw rows -> 6 distinct)', out.ledger && out.ledger.rows_read === 7 && out.ledger.distinct_event_id === 6, JSON.stringify(out.ledger));
    const trigA = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'triggerA');
    const trigB = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'triggerB');
    report('m0 source: triggerA has 3 matched impressions (dupe row folded, observed row excluded)', !!trigA && trigA.matched === 3, JSON.stringify(trigA));
    report('m0 source: triggerB has 1 matched impression', !!trigB && trigB.matched === 1, JSON.stringify(trigB));
    report('m0 source: snippet joined from queue file', !!trigA && trigA.items.some((it) => it.snippet === 'tail -1 foo'), JSON.stringify(trigA && trigA.items));
    report('m0 source: unsupported/observed-only impression never appears', !(out.triggers || []).some((t) => t.items.some((it) => it.impression_id === 'impC1')), '');

    // ---- Malformed-row hardening: a row with a missing middle field (real-world case: event_id
    // ---- dropped entirely, right-shifting id_missing/sanitized) must be EXCLUDED, never silently
    // ---- positionally mis-mapped into a fake shared sentinel that would corrupt dedup. -----------
    const malformedLine = ['1', '2026-01-01T00:05:00Z', 's9', 't9', '', '', '', '0', 'eligible',
      'triggerA', 'class:x', 'posix', '0', 'tail', '', 'ok', 'aaaa', '1.1', 'impMalformed', '0']
      .join('\t'); // 20 fields: missing event_id AND one more vs the 22-col schema (intentionally short)
    fs.appendFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), malformedLine + '\n');
    r = run(['--json']);
    out = JSON.parse(r.stdout || '{}');
    report('malformed row (wrong field count) is excluded, not silently mis-mapped', out.ledger && out.ledger.malformed_rows_excluded === 1, JSON.stringify(out.ledger));
    const trigAAfterMalformed = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'triggerA');
    report('malformed row never contributes a phantom impression', !!trigAAfterMalformed && trigAAfterMalformed.matched === 3 && !trigAAfterMalformed.items.some((it) => it.impression_id === 'impMalformed'), JSON.stringify(trigAAfterMalformed));

    // --per-trigger cap
    r = run(['--json', '--per-trigger', '2']);
    out = JSON.parse(r.stdout);
    const trigA2 = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'triggerA');
    report('--per-trigger 2 caps sampled to 2 while matched stays 3', !!trigA2 && trigA2.matched === 3 && trigA2.sampled === 2, JSON.stringify(trigA2));

    // --unlabeled-only: label impA1, then verify it drops out
    fs.writeFileSync(path.join(T, 'labels-' + HOST + '.tsv'), ['2026-01-02T00:00:00Z\timpA1\tuseful\t\ttester'].join('') + '\n');
    r = run(['--json']);
    out = JSON.parse(r.stdout);
    const trigAWithLabel = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'triggerA');
    report('label is joined and shown', !!trigAWithLabel && trigAWithLabel.items.find((it) => it.impression_id === 'impA1').label === 'useful', JSON.stringify(trigAWithLabel));
    report('labeled count reflects 1 for triggerA', !!trigAWithLabel && trigAWithLabel.labeled === 1, JSON.stringify(trigAWithLabel));
    r = run(['--json', '--unlabeled-only']);
    out = JSON.parse(r.stdout);
    const trigAUnlabeled = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'triggerA');
    report('--unlabeled-only excludes the labeled impA1 but keeps matched=3', !!trigAUnlabeled && trigAUnlabeled.sampled === 2 && trigAUnlabeled.matched === 3 && !trigAUnlabeled.items.some((it) => it.impression_id === 'impA1'), JSON.stringify(trigAUnlabeled));

    // text mode smoke test (non-json)
    r = run([]);
    report('text mode: exits 0 and mentions both triggers', r.status === 0 && r.stdout.includes('triggerA') && r.stdout.includes('triggerB'), r.stdout);

    // ---- Fixture 2: synthetic v3-style ledger (this builder's own fixture; the real shared v3 ----
    // ---- writer module has not shipped yet — Appendix A column order used verbatim) -------------
    const T2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-queue-v3-'));
    const env2 = Object.assign({}, process.env, { PMM_RECALL_ROOT: T2, PMM_RECALL_HOST: HOST });
    function run2(args) { return spawnSync(process.execPath, [__filename].concat(args), { env: env2, encoding: 'utf8' }); }
    function v3Row(kind, sid, tool, trig, cls, impId, evId, ts) {
      // schema_version ts sid_sha16 agent_sha16 agent_type prompt_id tool_use_id impression_id
      // event_id event_kind gate confidence class_tag trigger_or_gate_id cmd_sha16 parser_version
      // mode run_provenance sanitized id_missing agent_id_missing
      return ['3', ts, sid, 'agentA', 'sonnet-builder', 'promptA', tool, impId, evId, kind, '',
        '', cls, trig, 'aaaa', '1.1', 'shadow', '', '0', '0', '0'].join('\t');
    }
    const v3Header = V3_COLUMNS.join('\t');
    const v3Lines = [v3Header,
      v3Row('eligible', 'sv1', 'tv1', 'gateX', 'class:z', 'impV1', 'evV1', '2026-02-01T00:00:00Z'),
      v3Row('recurrence-candidate', 'sv1', 'tv1', 'gateX', 'class:z', 'impV1', 'evV2', '2026-02-01T00:00:01Z'),
      v3Row('would-warn', 'sv2', 'tv2', 'gateX', 'class:z', 'impV2', 'evV3', '2026-02-01T00:00:02Z'),
    ];
    fs.writeFileSync(path.join(T2, 'events-v3-' + HOST + '.tsv'), v3Lines.join('\n') + '\n');
    // v3-shape 7-col queue file (Appendix A M1 header)
    fs.writeFileSync(path.join(T2, 'queue-' + HOST + '.tsv'), [
      ['impV1', 'gateX', 'class:z', 'npm', 'test', '2026-02-01T00:00:00Z', 'npm test | tail -5'].join('\t'),
      ['impV2', 'gateX', 'class:z', 'npm', 'test', '2026-02-01T00:00:02Z', 'npm test | head -5'].join('\t'),
    ].join('\n') + '\n');

    r = run2(['--json']);
    report('v3 source: auto-detected when events-v3 file exists', r.status === 0, 'status=' + r.status + ' stderr=' + r.stderr);
    out = JSON.parse(r.stdout || '{}');
    report('v3 source: source==v3', out.source === 'v3', JSON.stringify(out.source));
    const gateX = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'gateX');
    report('v3 source: header row skipped, 2 distinct impressions aggregated from 3 rows', !!gateX && gateX.matched === 2, JSON.stringify(gateX));
    report('v3 source: exe/sub/snippet joined from queue file (ledger itself has none)', !!gateX && gateX.items.some((it) => it.snippet === 'npm test | tail -5' && it.exe === 'npm'), JSON.stringify(gateX && gateX.items));
    report('v3 source: class_tag carried from ledger', !!gateX && gateX.items.every((it) => it.class_tag === 'class:z'), JSON.stringify(gateX && gateX.items));

    // ---- explicit --source override forces m0 reading path even if a v3 file exists -------------
    fs.copyFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), path.join(T2, 'impressions-' + HOST + '.tsv'));
    r = run2(['--json', '--source', 'm0']);
    out = JSON.parse(r.stdout || '{}');
    report('--source m0 override wins even when a v3 ledger file is present', out.source === 'm0', JSON.stringify(out.source));

    // ---- empty root: no crash, clean "no matched impressions" report -----------------------------
    const T3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-queue-empty-'));
    const env3 = Object.assign({}, process.env, { PMM_RECALL_ROOT: T3, PMM_RECALL_HOST: HOST });
    r = spawnSync(process.execPath, [__filename, '--json'], { env: env3, encoding: 'utf8' });
    out = JSON.parse(r.stdout || '{}');
    report('empty root: exits 0 with zero triggers, no crash', r.status === 0 && Array.isArray(out.triggers) && out.triggers.length === 0, JSON.stringify(out));

    // ---- read-only guarantee: this tool must never write into PMM_RECALL_ROOT ---------------------
    const before = fs.readdirSync(T).sort();
    run(['--json']);
    run(['--unlabeled-only']);
    const after = fs.readdirSync(T).sort();
    report('read-only: directory listing unchanged after multiple invocations', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));

    // ---- LOW-K2 (2026-09-17, codex second wave / Opus reproduction): PMM_RECALL_ROOT=' '
    // (whitespace-only) must resolve to the SAME directory a WRITER (via ledger.resolveRoot())
    // would use -- never a literal ' ' path, which would make this tool list an empty queue
    // SILENTLY (no error) even though the writer's data is sitting right there in the real
    // default. Verified two ways: (a) this module's own resolveRoot() is a direct re-export of
    // the ledger's, so a pure computation check proves they agree; (b) end-to-end: HOME/
    // USERPROFILE redirected to a temp dir, a ledger row placed at the resulting default root
    // exactly as a real writer would leave it, run with PMM_RECALL_ROOT=' ' actually finds it.
    {
      const beforeEnv = process.env.PMM_RECALL_ROOT;
      process.env.PMM_RECALL_ROOT = ' ';
      try {
        const fromHere = resolveRoot();
        const fromLedger = ledger.resolveRoot();
        report('LOW-K2a: PMM_RECALL_ROOT=\' \' -> resolveRoot() here is never the literal whitespace', fromHere !== ' ', JSON.stringify(fromHere));
        report('LOW-K2b: PMM_RECALL_ROOT=\' \' -> resolveRoot() here === ledger.resolveRoot() (same resolver)', fromHere === fromLedger, JSON.stringify({ fromHere, fromLedger }));
      } finally {
        if (beforeEnv === undefined) delete process.env.PMM_RECALL_ROOT; else process.env.PMM_RECALL_ROOT = beforeEnv;
      }
    }
    {
      const fakeHome = path.join(T, 'lowk2-fakehome-' + Date.now());
      fs.mkdirSync(fakeHome, { recursive: true });
      const expectedDefaultRoot = path.join(fakeHome, '.claude', '.local', 'pmm-recall');
      fs.mkdirSync(expectedDefaultRoot, { recursive: true });
      // a row placed exactly as a real writer (going through ledger.writeEvent) would leave it.
      const dataRow = ['1', '2026-01-01T00:00:00.000Z', 's', 'a', '', '', 'tu', 'impLowk2', 'evLowk2', 'eligible',
        '', '', 'class:lowk2', 'trigLowk2', '', '', 'intervene', 'policy:absent', '0', '0', '0'].join('\t');
      fs.writeFileSync(path.join(expectedDefaultRoot, 'events-v3-' + os.hostname() + '.tsv'), V3_COLUMNS.join('\t') + '\n' + dataRow + '\n');
      const envLowk2 = Object.assign({}, process.env, { PMM_RECALL_ROOT: ' ', HOME: fakeHome, USERPROFILE: fakeHome });
      delete envLowk2.PMM_RECALL_HOST; // force this tool's own resolveHost() to fall back to the real os.hostname(), matching the file name written above
      const rLowk2 = spawnSync(process.execPath, [__filename, '--json'], { env: envLowk2, encoding: 'utf8' });
      const outLowk2 = JSON.parse(rLowk2.stdout || '{}');
      const trigLowk2 = (outLowk2.triggers || []).find((t) => t.trigger_or_gate_id === 'trigLowk2');
      report('LOW-K2c end-to-end: whitespace root + redirected HOME finds the writer\'s data (NOT silently empty)', !!trigLowk2 && trigLowk2.matched === 1, JSON.stringify(outLowk2.triggers));
    }

    // ---- LOW-K2-followup (2026-09-17, coordinator: real-ledger contamination incident): history
    // rows with id_missing='1' or blank sid_sha16 (the confirmed, cross-validated marker for the real
    // pmm-trigger-recall.sh leak) must never appear as a queue-worthy exposure, and excluded_
    // contaminated must report how many such rows were excluded.
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-queue-contam-'));
      const contamHost = 'contam-host';
      function m0RowRaw(sid, tool, trig, cls, exe, sub, impId, evId, ts, idMissing) {
        return ['1', ts, sid, tool, '', '', '', '0', 'eligible', trig, cls, 'posix', '0', exe, sub,
          'ok', 'aaaa', '1.1', impId, evId, idMissing, '0'].join('\t');
      }
      const rows = [
        m0RowRaw('sClean', 'tClean', 'triggerClean', 'class:clean', 'tail', '', 'impClean', 'evClean', '2026-04-01T00:00:00Z', '0'),
        // contaminated: id_missing=1, shaped exactly like the leaked pmm-trigger-recall.sh fixture rows
        m0RowRaw('sContam', 'tContam', 'test:trig-alpha', 'test:trig-alpha', 'tail', '', '', 'evContam1', '2026-04-01T00:00:01Z', '1'),
        // contaminated: blank sid_sha16 (independent forward-looking marker)
        m0RowRaw('', 'tBlank', 'triggerBlankSid', 'class:blanksid', 'tail', '', 'impBlank', 'evContam2', '2026-04-01T00:00:02Z', '0'),
      ];
      fs.writeFileSync(path.join(root, 'impressions-' + contamHost + '.tsv'), rows.join('\n') + '\n');
      const contamEnv = Object.assign({}, process.env, { PMM_RECALL_ROOT: root, PMM_RECALL_HOST: contamHost });
      const r = spawnSync(process.execPath, [__filename, '--json'], { env: contamEnv, encoding: 'utf8' });
      const out = JSON.parse(r.stdout || '{}');
      report('LOW-K2-followup: excluded_contaminated=2 (1 id_missing=1 row + 1 blank-sid row)', out.excluded_contaminated === 2, JSON.stringify(out.excluded_contaminated));
      const contamTrig = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'test:trig-alpha');
      report('LOW-K2-followup: the contaminated test:trig-alpha trigger never appears in triggers at all', !contamTrig, JSON.stringify(out.triggers));
      const blankSidTrig = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'triggerBlankSid');
      report('LOW-K2-followup: the blank-sid triggerBlankSid trigger never appears in triggers either', !blankSidTrig, JSON.stringify(out.triggers));
      const cleanTrig = (out.triggers || []).find((t) => t.trigger_or_gate_id === 'triggerClean');
      report('LOW-K2-followup: the clean triggerClean trigger is unaffected, matched=1', !!cleanTrig && cleanTrig.matched === 1, JSON.stringify(cleanTrig));
      const rText = spawnSync(process.execPath, [__filename], { env: contamEnv, encoding: 'utf8' });
      report('LOW-K2-followup: text mode also prints excluded_contaminated=2 near the top', /excluded_contaminated=2/.test(rText.stdout), rText.stdout.slice(0, 200));
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort cleanup */ }
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
  const opts = parseQueueArgs(argv);
  const report_ = buildQueue(opts);
  if (opts.json) {
    console.log(JSON.stringify(report_, null, 2));
  } else {
    console.log(formatText(report_));
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { resolveRoot, resolveHost, detectSource, readLedgerRows, dedupByEventId,
  aggregateImpressions, isMatchedRow, readQueueMap, readLabelsMap, currentLabelOf, buildQueue,
  M0_COLUMNS, V3_COLUMNS, MATCHED_KINDS, UNDO_SENTINEL };
