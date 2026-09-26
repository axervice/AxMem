#!/usr/bin/env node
// pmm-recall-baseline.cjs — M2 recurrence-proxy baseline: `--report [--source v3] [--since <iso>]`.
//
// guards/specs/RECALL-LOOP-M-SPEC-v2.md M2 section + 附录 B2 (2026-09-17):
//   "细分类 gate 信号只记不警(全部 shadow);...此阶段只做描述统计,结论一律命名为
//    「复发动作代理指标」,不宣称测到实际错误或损失。"
//   "只读、只做描述统计,输出前缀固定 DESCRIPTIVE;按 class_tag × trigger_or_gate_id 列:曝光
//    (eligible + would-warn)、displayed、suppressed(seen/cap)、recurrence-candidate、recurrence、
//    每千 eligible tool events 的 would-warn 行、观察窗状态(同 (session, agent) 后续 observed >=20
//    或 session-end => closed,否则 open)。"
//   "不宣称测到实际错误或损失;字段名一律带 proxy_。"
//
// READ-ONLY: this tool writes nothing, ever (same discipline as pmm-recall-precision.cjs).
//
// Design notes (spec is silent on exact aggregation granularity; documented here rather than
// guessed silently, per this build's "spec 不明处...不自行扩大范围" discipline):
//   - Counts are RAW ROW counts per (class_tag, trigger_or_gate_id, event_kind) after event_id
//     dedup (附录 A: "写入端不去重;读取端按 event_id 去重并报告重复率") — not folded by
//     impression_id the way pmm-recall-precision.cjs's precision figure is, because a baseline
//     "how many eligible/displayed/suppressed rows happened" is naturally a row count, and B1's
//     own writer already emits at most one row per (tag, event_kind) per hook event.
//   - "观察窗状态" (窗口 closed/open) is evaluated PER exposure (each event_kind='eligible' row):
//     closed when, for that row's (sid_sha16, agent_sha16) pair, the ledger already carries >=20
//     'observed' rows with a later ts, OR a 'session-end' row for that pair (附录 A verbatim). Per
//     the spec's explicit instruction "未闭合窗口用 UNKNOWN 字面量", an exposure whose window has
//     not closed is reported under the literal status string "UNKNOWN" (not the word "open") —
//     the per-group columns are therefore proxy_window_closed (count) and proxy_window_unknown
//     (count of exposures whose window state is the literal 'UNKNOWN'), plus a group-level
//     proxy_window_status convenience field ('closed' | 'UNKNOWN' | 'n/a') for the text table.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// pmm-recall-classify.cjs (2026-09-17, MEDIUM-7 Opus review): the class_tag backfill + display
// bucketing this file used to keep a private copy of is now the ONE shared module also used by
// pmm-recall-precision.cjs, so both tools bucket old/native/unattributable gate rows identically.
const classify = require('./pmm-recall-classify.cjs');
const { GATE_ROW_CLASS_TAG, backfillGateClassTag, displayClassTag, gateClassTagSwitchoverMs } = classify;
// pmm-recall-ledger.cjs (2026-09-17, codex LOW-K2 / Opus reproduction): resolveRoot() is required
// from there, not reimplemented here. The write side (pmm-trigger-recall.cjs, pmm-bash-impression.cjs,
// pmm-recall-policy.cjs) already converged onto ledger.resolveRoot() in an earlier round (LOW-5); this
// read side still carried its own un-normalized copy (`process.env.PMM_RECALL_ROOT || default`, no
// trim), so PMM_RECALL_ROOT=' ' made the WRITER land on the real default directory while THIS tool's
// --report read from a literal whitespace-named directory -- silently all-zero output, never an error.
const ledger = require('./pmm-recall-ledger.cjs');

// ---------------------------------------------------------------------------------------------
// Shared reading layer (deliberately duplicated across the M1/M2/M3 tools — see
// pmm-recall-queue.cjs's own header comment for the rationale: no fourth/fifth shared module was
// authorized beyond pmm-recall-ledger.cjs itself; resolveRoot() is now the one exception -- LOW-K2
// requires all five read-side tools to call it, not reimplement it, everything else here still
// reads V3_COLUMNS/dedup/etc. independently on purpose).
// ---------------------------------------------------------------------------------------------

const V3_COLUMNS = ['schema_version', 'ts', 'sid_sha16', 'agent_sha16', 'agent_type', 'prompt_id',
  'tool_use_id', 'impression_id', 'event_id', 'event_kind', 'gate', 'confidence', 'class_tag',
  'trigger_or_gate_id', 'cmd_sha16', 'parser_version', 'mode', 'run_provenance', 'sanitized',
  'id_missing', 'agent_id_missing'];

const WINDOW_OBSERVED_THRESHOLD = 20;
const SORT_SEP = String.fromCharCode(1); // NUL-like join separator, used only for a stable sort key

const resolveRoot = ledger.resolveRoot;
function resolveHost() {
  return process.env.PMM_RECALL_HOST || os.hostname();
}
function v3Path(root, host) { return path.join(root, 'events-v3-' + host + '.tsv'); }

function readLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { lines: [], exists: false }; }
  return { lines: raw.split('\n').filter(Boolean), exists: true };
}

function readV3Rows(root, host) {
  const file = v3Path(root, host);
  const { lines, exists } = readLines(file);
  let body = lines;
  if (body.length && body[0].split('\t')[0] === 'schema_version') body = body.slice(1);
  const rows = [];
  let malformed = 0;
  for (const line of body) {
    const parts = line.split('\t');
    if (parts.length !== V3_COLUMNS.length) { malformed++; continue; }
    const row = {};
    V3_COLUMNS.forEach((c, i) => { row[c] = parts[i]; });
    rows.push(backfillGateClassTag(row));
  }
  return { rows, file, exists, totalLines: body.length, malformed };
}

function dedupByEventId(rows) {
  const seen = new Set();
  const out = [];
  let dupeCount = 0;
  for (const r of rows) {
    if (!r.event_id) { out.push(r); continue; }
    if (seen.has(r.event_id)) { dupeCount++; continue; }
    seen.add(r.event_id);
    out.push(r);
  }
  return { rows: out, totalRead: rows.length, distinctCount: out.length, dupeCount,
    dupeRate: rows.length ? dupeCount / rows.length : 0 };
}

// isContaminatedRow (2026-09-17, coordinator LOW-K2-followup / real-ledger contamination incident):
// the confirmed marker for the 572 pmm-trigger-recall.sh self-test rows that leaked into the real
// production ledger (root-caused and fixed at the source -- see pmm-trigger-recall.sh's PMM_RECALL_
// ROOT isolation) -- every one of them has id_missing='1' (the self-test JSON omitted tool_use_id,
// so pmm-trigger-recall.cjs's own ledgerIds() returns impressionId=''/eventId='' and id_missing=
// true) alongside a real-but-test-fixture sid_sha16. A blank/missing sid_sha16 is included in the
// same check as an independent, forward-looking net (matches the write-side isPoisonedSid() guard's
// concern in pmm-recall-ledger.cjs, even though it did not fire for this specific incident's rows).
// This is a HISTORY filter only -- it never rewrites or deletes the ledger file itself (append-only,
// per M-SPEC); it only excludes such rows from THIS report's aggregation, and reports how many were
// excluded via the top-level `excluded_contaminated` field so a reader can see the exclusion is
// happening rather than the report silently going quiet.
function isContaminatedRow(r) {
  // M-1 read-side (2026-09-17, fab blind attack item 5 / Opus reproduction): two more pure-count
  // markers found across the real ledger -- run_provenance starting with 'test' (a self-test/harness
  // writer's own literal tag, distinct from the policy:*/seen/cap production vocabulary) and
  // tool_use_id shaped like runner-synthesized ids (tu-<...>, never Claude Code's own toolu_<...>
  // format). Confirmed against the real ledger: 2 rows with run_provenance='test' and a tu-* tool_use_id
  // were previously mis-classified as unrelated real production data; they are actually
  // pipe-gate-v2-acceptance.cjs runner-synthesized rows that leaked the same way this file's own
  // self-test leaked (root cause on that side is out of this write-face -- runner/gate).
  return r.id_missing === '1' || !r.sid_sha16 ||
    (typeof r.run_provenance === 'string' && r.run_provenance.indexOf('test') === 0) ||
    (typeof r.tool_use_id === 'string' && /^tu-/.test(r.tool_use_id));
}

function tsMs(ts) {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function applySince(rows, sinceIso) {
  if (!sinceIso) return rows;
  const sinceMs = tsMs(sinceIso);
  if (sinceMs === null) return rows; // unparsable --since: no-op rather than silently dropping everything
  return rows.filter((r) => { const t = tsMs(r.ts); return t !== null && t >= sinceMs; });
}

// ---------------------------------------------------------------------------------------------
// Observation-window index: per (sid_sha16, agent_sha16) pair, the sorted list of 'observed' row
// timestamps and whether a 'session-end' row exists for that pair (附录 A terminates the window
// there regardless of how many 'observed' rows preceded it).
// ---------------------------------------------------------------------------------------------

function sessAgentKey(r) { return (r.sid_sha16 || '') + '' + (r.agent_sha16 || ''); }

function buildSessAgentIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const k = sessAgentKey(r);
    let e = idx.get(k);
    if (!e) { e = { observedMs: [], sessionEnd: false }; idx.set(k, e); }
    if (r.event_kind === 'observed') { const t = tsMs(r.ts); if (t !== null) e.observedMs.push(t); }
    if (r.event_kind === 'session-end') e.sessionEnd = true;
  }
  for (const e of idx.values()) e.observedMs.sort((a, b) => a - b);
  return idx;
}

// windowStatus(row, idx): 'closed' | 'UNKNOWN' (literal per 附录 B2's "未闭合窗口用 UNKNOWN 字面量").
function windowStatus(row, idx) {
  const e = idx.get(sessAgentKey(row));
  if (!e) return 'UNKNOWN';
  if (e.sessionEnd) return 'closed';
  const rowMs = tsMs(row.ts);
  if (rowMs === null) return 'UNKNOWN'; // can't order observed rows against an unparsable ts -> can't prove closure
  let count = 0;
  for (const om of e.observedMs) if (om > rowMs) count++;
  return count >= WINDOW_OBSERVED_THRESHOLD ? 'closed' : 'UNKNOWN';
}

// ---------------------------------------------------------------------------------------------
// Aggregation: group by (class_tag, trigger_or_gate_id).
// ---------------------------------------------------------------------------------------------

function groupKey(cls, trig) { return (cls || '') + '' + (trig || ''); }

function aggregate(dedupedRows, idx) {
  const groups = new Map();
  function ensure(cls, trig) {
    const k = groupKey(cls, trig);
    let g = groups.get(k);
    if (!g) {
      g = { class_tag: cls || '', trigger_or_gate_id: trig || '',
        eligible: 0, would_warn: 0, displayed: 0, suppressed_seen: 0, suppressed_cap: 0,
        suppressed_other: 0, recurrence_candidate: 0, recurrence: 0, recurrence_secondary: 0,
        window_closed: 0, window_unknown: 0,
        displayed_without_read: new Map(), // (sid, agent) => Set of tags with 'displayed' but no 'read'
        read_events: [] // track {row: ..., class_tag: ..., followed_by_recurrence: ...}
      };
      groups.set(k, g);
    }
    return g;
  }
  for (const r of dedupedRows) {
    const cls = r.class_tag || '', trig = r.trigger_or_gate_id || '';
    if (!cls && !trig) continue; // bookkeeping rows (observed/session-end/...) never key a group
    // MEDIUM-7 (2026-09-17, extracted to the shared pmm-recall-classify.cjs so
    // pmm-recall-precision.cjs buckets identically): a derived-old row groups under a visibly
    // distinct "<tag> (pre-class_tag)" bucket rather than silently merging with native rows that
    // already carried the tag; a row that could never be attributed at all (empty class_tag,
    // non-gate trigger_or_gate_id) displays as the literal "(n/a)" instead of a blank string.
    const displayCls = displayClassTag(r);
    switch (r.event_kind) {
      case 'eligible': {
        const g = ensure(displayCls, trig);
        g.eligible++;
        if (windowStatus(r, idx) === 'closed') g.window_closed++; else g.window_unknown++;
        break;
      }
      case 'would-warn': ensure(displayCls, trig).would_warn++; break;
      case 'displayed': ensure(displayCls, trig).displayed++; break;
      case 'suppressed': {
        const g = ensure(displayCls, trig);
        if (r.run_provenance === 'seen') g.suppressed_seen++;
        else if (r.run_provenance === 'cap') g.suppressed_cap++;
        else g.suppressed_other++;
        break;
      }
      default: break; // observed/session-end/unsupported/... are not exposure-kind rows for B2
    }
    // recurrence / recurrence-candidate signals (M-SPEC 附录 B3 补注, 2026-09-17 coordinator
    // correction, refined by Opus review "B3 主次结局分开"): production NEVER writes event_kind=
    // 'recurrence' (grep-confirmed against bash-pipe-exitcode-watch.cjs) -- a confirmed D recurrence
    // is event_kind would-warn/emitted with confidence='recurrence' (gate_disposition_map), and a
    // no-evidence D candidate is event_kind='recurrence-candidate'. PRIMARY (proxy_recurrence) =
    // confirmed only; SECONDARY/sensitivity (proxy_recurrence_secondary) = PRIMARY union candidate.
    // Folding candidate into primary would raise both arms' apparent noise floor equally and
    // compress the measured intervene-vs-shadow effect size, so the two are kept as separate
    // columns rather than one merged number. Evaluated independently of the switch above (not a
    // `case`) so e.g. a would-warn row with confidence='recurrence' counts toward BOTH
    // proxy_would_warn (via the switch) AND proxy_recurrence (here) -- not mutually exclusive kinds.
    {
      const g = ensure(displayCls, trig);
      const isPrimary = r.confidence === 'recurrence' || r.event_kind === 'recurrence';
      const isCandidate = r.confidence === 'recurrence-candidate' || r.event_kind === 'recurrence-candidate';
      if (isPrimary) g.recurrence++;
      if (isCandidate) g.recurrence_candidate++;
      if (isPrimary || isCandidate) g.recurrence_secondary++;
    }

    // item 24 (读信号): track displayed and read events for proxy_pushed_not_read_via_search
    // and proxy_read_then_recurred metrics
    if (r.event_kind === 'displayed' || r.event_kind === 'read') {
      const g = ensure(displayCls, trig);
      if (r.event_kind === 'displayed') {
        const sesKey = (r.sid_sha16 || '') + '\x00' + (r.agent_sha16 || '');
        if (!g.displayed_without_read.has(sesKey)) {
          g.displayed_without_read.set(sesKey, new Set());
        }
        g.displayed_without_read.get(sesKey).add(trig);
      } else if (r.event_kind === 'read') {
        g.read_events.push({ row: r, class_tag: cls });
      }
    }
  }

  // Post-process to compute the new metrics
  for (const g of groups.values()) {
    // proxy_pushed_not_read_via_search: count (sid, agent) pairs with 'displayed' but no 'read'
    let proxyPushedNotRead = 0;
    for (const sesKey of g.displayed_without_read.keys()) {
      const tags = g.displayed_without_read.get(sesKey);
      // Check if there's a 'read' event for any of these tags from the same (sid, agent) pair
      const hasReadForAnyTag = dedupedRows.some(r =>
        r.event_kind === 'read' &&
        (r.sid_sha16 || '') === sesKey.split('\x00')[0] &&
        (r.agent_sha16 || '') === sesKey.split('\x00')[1] &&
        tags.has(r.trigger_or_gate_id)
      );
      if (!hasReadForAnyTag) {
        proxyPushedNotRead += tags.size; // count each tag as one occurrence
      }
    }
    g.pushed_not_read = proxyPushedNotRead;

    // proxy_read_then_recurred: count 'read' events followed by recurrence in same window
    let proxyReadThenRecurred = 0;
    for (const readEvt of g.read_events) {
      const readRow = readEvt.row;
      const readClass = readEvt.class_tag;
      const readSesKey = (readRow.sid_sha16 || '') + '\x00' + (readRow.agent_sha16 || '');
      const readTs = tsMs(readRow.ts);
      if (readTs === null) continue;

      // Check if there's a recurrence in the same (session, agent, class) window
      const hasRecurrence = dedupedRows.some(r => {
        if (r === readRow) return false; // don't count the same row
        if ((r.sid_sha16 || '') !== readRow.sid_sha16) return false;
        if ((r.agent_sha16 || '') !== readRow.agent_sha16) return false;
        if ((r.class_tag || '') !== readClass) return false;
        const rTs = tsMs(r.ts);
        if (rTs === null || rTs <= readTs) return false; // must be after the read event
        // Check if it's a recurrence (confidence='recurrence' or event_kind='recurrence-candidate')
        const isPrimary = r.confidence === 'recurrence' || r.event_kind === 'recurrence';
        const isCandidate = r.confidence === 'recurrence-candidate' || r.event_kind === 'recurrence-candidate';
        if (!isPrimary && !isCandidate) return false;
        // Check if it's within the observation window
        const e = idx.get(readSesKey);
        if (!e) return false;
        if (e.sessionEnd) return true; // session end closes the window, check if r is before
        let count = 0;
        for (const om of e.observedMs) if (om > readTs) count++;
        return count >= WINDOW_OBSERVED_THRESHOLD;
      });

      if (hasRecurrence) proxyReadThenRecurred++;
    }
    g.read_then_recurred = proxyReadThenRecurred;
  }

  return { groups, gateClassTagSwitchoverMs: gateClassTagSwitchoverMs(dedupedRows, tsMs) };
}

function finalizeGroup(g) {
  const exposure = g.eligible + g.would_warn;
  const proxyWouldWarnPer1000 = g.eligible > 0 ? (g.would_warn / g.eligible) * 1000 : null;
  const status = (g.window_unknown > 0) ? 'UNKNOWN' : (g.window_closed > 0 ? 'closed' : 'n/a');
  return {
    class_tag: g.class_tag, trigger_or_gate_id: g.trigger_or_gate_id,
    proxy_exposure: exposure,
    proxy_displayed: g.displayed,
    proxy_suppressed_seen: g.suppressed_seen,
    proxy_suppressed_cap: g.suppressed_cap,
    proxy_recurrence_candidate: g.recurrence_candidate,
    proxy_recurrence: g.recurrence, // PRIMARY (confirmed only)
    proxy_recurrence_secondary: g.recurrence_secondary, // SECONDARY = primary union candidate
    proxy_would_warn_per_1000_eligible: proxyWouldWarnPer1000,
    proxy_window_closed: g.window_closed,
    proxy_window_unknown: g.window_unknown,
    proxy_window_status: status,
    proxy_pushed_not_read_via_search: g.pushed_not_read || 0, // item 24: displayed but no read
    proxy_read_then_recurred: g.read_then_recurred || 0, // item 24: read followed by recurrence
  };
}

function buildReport(opts) {
  const root = resolveRoot();
  const host = resolveHost();
  const ledger = readV3Rows(root, host);
  const sinced = applySince(ledger.rows, opts.since);
  const dedup = dedupByEventId(sinced);
  const cleanRows = [], excludedRows = [];
  for (const r of dedup.rows) (isContaminatedRow(r) ? excludedRows : cleanRows).push(r);
  const idx = buildSessAgentIndex(cleanRows);
  const { groups, gateClassTagSwitchoverMs } = aggregate(cleanRows, idx);
  const table = Array.from(groups.values())
    .map(finalizeGroup)
    .sort((a, b) => (a.class_tag + SORT_SEP + a.trigger_or_gate_id).localeCompare(b.class_tag + SORT_SEP + b.trigger_or_gate_id));
  return {
    label: 'DESCRIPTIVE',
    generated_at: new Date().toISOString(),
    source: 'v3', root, host, since: opts.since || null,
    // LOW-K2-followup: history rows excluded as contaminated (id_missing=1 or blank sid_sha16) --
    // never deleted from the ledger itself, only excluded from THIS report's aggregation.
    excluded_contaminated: excludedRows.length,
    ledger: { file: ledger.file, exists: ledger.exists, rows_read: dedup.totalRead,
      distinct_event_id: dedup.distinctCount, dupe_rate: dedup.dupeRate,
      malformed_rows_excluded: ledger.malformed },
    note: 'proxy metrics only; not a claim of measured error or loss (M-SPEC M2)',
    gate_class_tag_switchover_ts: gateClassTagSwitchoverMs !== null ? new Date(gateClassTagSwitchoverMs).toISOString() : null,
    groups: table,
  };
}

function fmtRate(v) { return v === null ? 'n/a' : v.toFixed(2); }

function formatText(report) {
  const lines = [];
  lines.push('DESCRIPTIVE pmm-recall-baseline report');
  lines.push(`generated_at=${report.generated_at} source=${report.source} root=${report.root} host=${report.host} since=${report.since || '(none)'}`);
  lines.push(`excluded_contaminated=${report.excluded_contaminated}`);
  lines.push(`ledger: file=${report.ledger.file} exists=${report.ledger.exists} rows_read=${report.ledger.rows_read} distinct_event_id=${report.ledger.distinct_event_id} dupe_rate=${(report.ledger.dupe_rate * 100).toFixed(2)}% malformed_rows_excluded=${report.ledger.malformed_rows_excluded}`);
  lines.push(`note: ${report.note}`);
  lines.push(`gate_class_tag_switchover_ts: ${report.gate_class_tag_switchover_ts || 'n/a (no native-tagged gate row observed yet)'}`);
  lines.push('');
  if (!report.groups.length) { lines.push('(no groups)'); return lines.join('\n') + '\n'; }
  // Opus review "B3 主次结局分开": baseline lists both criteria as separate columns --
  // proxy_recurrence (PRIMARY, confirmed only) and proxy_recurrence_secondary (SECONDARY = primary
  // union candidate) -- never a single merged count.
  const header = ['class_tag', 'trigger_or_gate_id', 'proxy_exposure', 'proxy_displayed',
    'proxy_suppressed_seen', 'proxy_suppressed_cap', 'proxy_recurrence_candidate', 'proxy_recurrence',
    'proxy_recurrence_secondary', 'proxy_would_warn_per_1000_eligible', 'proxy_window_closed',
    'proxy_window_unknown', 'proxy_window_status', 'proxy_pushed_not_read_via_search',
    'proxy_read_then_recurred'];
  lines.push(header.join('\t'));
  for (const g of report.groups) {
    lines.push([g.class_tag, g.trigger_or_gate_id, g.proxy_exposure, g.proxy_displayed,
      g.proxy_suppressed_seen, g.proxy_suppressed_cap, g.proxy_recurrence_candidate, g.proxy_recurrence,
      g.proxy_recurrence_secondary, fmtRate(g.proxy_would_warn_per_1000_eligible), g.proxy_window_closed,
      g.proxy_window_unknown, g.proxy_window_status, g.proxy_pushed_not_read_via_search,
      g.proxy_read_then_recurred].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const opts = { report: false, json: false, since: null, source: null, selfTest: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') opts.selfTest = true;
    else if (a === '--report') opts.report = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--since') opts.since = argv[++i];
    else if (a.startsWith('--since=')) opts.since = a.slice('--since='.length);
    else if (a === '--source') opts.source = argv[++i];
    else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length);
    else opts.error = 'unrecognized argument: ' + a;
  }
  if (opts.source !== null && opts.source !== 'v3') opts.error = opts.error || ('unsupported --source (only v3): ' + opts.source);
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Self-test (>=12 synthetic-ledger cases per 附录 B2: duplicate event_id, window open/closed,
// cross-session, malformed rows).
// ---------------------------------------------------------------------------------------------

function runSelfTest() {
  const results = [];
  function report(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (ok ? '' : '  (' + detail + ')'));
  }

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-baseline-selftest-'));
  // LOW-3 (2026-09-17, fab blind attack): process.on('exit') safety net in ADDITION to the try/finally
  // cleanup below -- see pmm-recall-m3.cjs's copy of this comment for the full rationale.
  process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  const HOST = 'test-host';
  function freshRoot(tag) { return path.join(T, 'root-' + tag); }
  function run(root, args) {
    const env = Object.assign({}, process.env, { PMM_RECALL_ROOT: root, PMM_RECALL_HOST: HOST });
    return spawnSync(process.execPath, [__filename].concat(args), { env, encoding: 'utf8' });
  }
  function writeLedger(root, rows) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'events-v3-' + HOST + '.tsv'), [V3_COLUMNS.join('\t')].concat(rows).join('\n') + '\n');
  }
  function row(fields) {
    const f = Object.assign({ schema_version: '3', ts: '2026-01-01T00:00:00.000Z', sid_sha16: 's',
      agent_sha16: 'a', agent_type: '', prompt_id: '', tool_use_id: 'toolu_selftest_tu', impression_id: 'imp',
      event_id: 'ev', event_kind: 'eligible', gate: '', confidence: '', class_tag: 'class:x',
      trigger_or_gate_id: 'trigX', cmd_sha16: '', parser_version: '', mode: 'intervene',
      run_provenance: '', sanitized: '0', id_missing: '0', agent_id_missing: '0' }, fields);
    return V3_COLUMNS.map((c) => f[c]).join('\t');
  }

  try {
    // ---- 1. Basic report exits 0, DESCRIPTIVE-prefixed, empty root doesn't crash ----------------
    {
      const root = freshRoot('empty');
      const r = run(root, ['--report']);
      report('1. empty root: rc=0', r.status === 0, 'status=' + r.status + ' stderr=' + r.stderr);
      report('2. empty root: text output starts with DESCRIPTIVE', /^DESCRIPTIVE/.test(r.stdout), r.stdout.slice(0, 40));
    }

    // ---- 2. Basic aggregation: exposure = eligible + would-warn ---------------------------------
    {
      const root = freshRoot('basic');
      writeLedger(root, [
        row({ event_kind: 'eligible', event_id: 'e1', impression_id: 'i1' }),
        row({ event_kind: 'eligible', event_id: 'e2', impression_id: 'i2' }),
        row({ event_kind: 'would-warn', event_id: 'e3', impression_id: 'i1' }),
        row({ event_kind: 'displayed', event_id: 'e4', impression_id: 'i1' }),
      ]);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const g = (out.groups || [])[0];
      report('3. exposure = eligible(2) + would-warn(1) = 3', !!g && g.proxy_exposure === 3, JSON.stringify(g));
      report('4. displayed = 1', !!g && g.proxy_displayed === 1, JSON.stringify(g));
    }

    // ---- 3. Suppressed seen/cap split by run_provenance ------------------------------------------
    {
      const root = freshRoot('suppressed');
      writeLedger(root, [
        row({ event_kind: 'suppressed', event_id: 'e1', impression_id: 'i1', run_provenance: 'seen' }),
        row({ event_kind: 'suppressed', event_id: 'e2', impression_id: 'i2', run_provenance: 'seen' }),
        row({ event_kind: 'suppressed', event_id: 'e3', impression_id: 'i3', run_provenance: 'cap' }),
      ]);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('5. suppressed_seen=2, suppressed_cap=1', !!g && g.proxy_suppressed_seen === 2 && g.proxy_suppressed_cap === 1, JSON.stringify(g));
    }

    // ---- 4. recurrence-candidate / recurrence counts ----------------------------------------------
    {
      const root = freshRoot('recurrence');
      writeLedger(root, [
        row({ event_kind: 'recurrence-candidate', event_id: 'e1', impression_id: 'i1' }),
        row({ event_kind: 'recurrence-candidate', event_id: 'e2', impression_id: 'i2' }),
        row({ event_kind: 'recurrence', event_id: 'e3', impression_id: 'i3' }),
      ]);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('6. recurrence_candidate=2, recurrence=1', !!g && g.proxy_recurrence_candidate === 2 && g.proxy_recurrence === 1, JSON.stringify(g));
    }

    // ---- 4b. coordinator correction (2026-09-17, M-SPEC 附录 B3 补注): a confidence='recurrence'
    // would-warn row (the REAL production shape per gate_disposition_map -- event_kind='recurrence'
    // is never written) must be counted as recurrence, AND simultaneously as a would-warn exposure
    // (the two are not mutually exclusive kinds). --------------------------------------------------
    {
      const root = freshRoot('recurrence-confidence-wouldwarn');
      writeLedger(root, [
        row({ event_kind: 'would-warn', confidence: 'recurrence', gate: 'D', event_id: 'e1', impression_id: 'i1' }),
        row({ event_kind: 'would-warn', confidence: '', gate: '', event_id: 'e2', impression_id: 'i2' }), // plain would-warn, no confidence -> NOT a recurrence
      ]);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('6b. confidence=recurrence would-warn row counted as recurrence (proxy_recurrence=1)', !!g && g.proxy_recurrence === 1, JSON.stringify(g));
      report('6c. same row also counted toward proxy_exposure via would_warn (not mutually exclusive with recurrence)', !!g && g.proxy_exposure === 2, JSON.stringify(g));
      report('6d. plain would-warn without confidence is NOT counted as recurrence', !!g && g.proxy_recurrence === 1 /* only the one WITH confidence counted */, JSON.stringify(g));
    }

    // ---- 4c. coordinator correction: recurrence must be countable with ZERO literal
    // event_kind='recurrence' rows anywhere in the ledger (production never writes that kind). ------
    {
      const root = freshRoot('recurrence-no-literal-kind');
      const rows = [
        row({ event_kind: 'would-warn', confidence: 'recurrence', gate: 'D', event_id: 'e1', impression_id: 'i1' }),
        row({ event_kind: 'recurrence-candidate', event_id: 'e2', impression_id: 'i2' }),
        row({ event_kind: 'eligible', event_id: 'e3', impression_id: 'i3' }),
      ];
      writeLedger(root, rows);
      const kindIdx = V3_COLUMNS.indexOf('event_kind');
      report('6e. fixture sanity: zero rows carry literal event_kind=recurrence',
        rows.every((line) => line.split('\t')[kindIdx] !== 'recurrence'), JSON.stringify(rows.map((l) => l.split('\t')[kindIdx])));
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('6f. recurrence=1 and recurrence_candidate=1 computed with no literal event_kind=recurrence row', !!g && g.proxy_recurrence === 1 && g.proxy_recurrence_candidate === 1, JSON.stringify(g));
    }

    // ---- 4h. Opus review "B3 主次结局分开": PRIMARY (proxy_recurrence) counts confirmed-only rows;
    // SECONDARY (proxy_recurrence_secondary) counts primary union candidate -- a candidate-only row
    // (no confidence='recurrence' anywhere) must move secondary but leave primary untouched. -------
    {
      const root = freshRoot('recurrence-primary-secondary');
      writeLedger(root, [
        row({ event_kind: 'would-warn', confidence: 'recurrence', gate: 'D', event_id: 'e1', impression_id: 'i1' }), // confirmed -> primary AND secondary
        row({ event_kind: 'recurrence-candidate', confidence: 'recurrence-candidate', gate: 'D', event_id: 'e2', impression_id: 'i2' }), // candidate-only -> secondary ONLY
      ]);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('6m. proxy_recurrence (primary) = 1 (only the confirmed row)', !!g && g.proxy_recurrence === 1, JSON.stringify(g));
      report('6n. proxy_recurrence_candidate = 1 (only the candidate-only row)', !!g && g.proxy_recurrence_candidate === 1, JSON.stringify(g));
      report('6o. proxy_recurrence_secondary = 2 (primary union candidate, both rows)', !!g && g.proxy_recurrence_secondary === 2, JSON.stringify(g));
      const textOut = run(root, ['--report']).stdout;
      report('6p. text header lists proxy_recurrence_secondary as its own column', /proxy_recurrence_secondary/.test(textOut), textOut);
    }

    // ---- 4g. coordinator correction (2026-09-17 11:10, 契约 v2.19 gate_row_class_tag) + Opus review
    // "读侧归组": an OLD gate row with class_tag='' and trigger_or_gate_id in {A,B,D} is functionally
    // backfilled to the lesson tag process:pipe-hides-exit-code-and-truncates-evidence, BUT displays
    // in a visibly DISTINCT "<tag> (pre-class_tag)" group -- never silently merged with a NEW row
    // that already carries the tag natively. A row with an empty class_tag but a non-gate
    // trigger_or_gate_id displays as the literal "(n/a)" (genuinely unrecoverable), not a blank
    // string. gate_class_tag_switchover_ts is the native row's own ts (the derived row's ts is
    // NEVER used for it, even though it is earlier -- switchover means "when native data started"). -
    {
      const root = freshRoot('gate-class-tag-backfill');
      writeLedger(root, [
        row({ event_kind: 'would-warn', class_tag: '', trigger_or_gate_id: 'A', event_id: 'old1', impression_id: 'iold1', ts: '2026-01-01T00:00:00.000Z' }), // pre-v2.19 old row (derived)
        row({ event_kind: 'would-warn', class_tag: 'process:pipe-hides-exit-code-and-truncates-evidence', trigger_or_gate_id: 'A', event_id: 'new1', impression_id: 'inew1', ts: '2026-02-01T00:00:00.000Z' }), // post-v2.19 new row (native), same gate
        row({ event_kind: 'would-warn', class_tag: '', trigger_or_gate_id: 'nottheletterABD', event_id: 'noise1', impression_id: 'inoise1' }), // NOT a gate row -> not backfilled, displays as (n/a)
      ]);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const derivedGroup = out.groups.find((x) => x.class_tag === 'process:pipe-hides-exit-code-and-truncates-evidence (pre-class_tag)' && x.trigger_or_gate_id === 'A');
      const nativeGroup = out.groups.find((x) => x.class_tag === 'process:pipe-hides-exit-code-and-truncates-evidence' && x.trigger_or_gate_id === 'A');
      report('6g. derived-old gate-A row and native-new gate-A row land in DISTINCT display groups (never silently merged)',
        !!derivedGroup && derivedGroup.proxy_exposure === 1 && !!nativeGroup && nativeGroup.proxy_exposure === 1, JSON.stringify(out.groups));
      const noiseGroup = out.groups.find((x) => x.trigger_or_gate_id === 'nottheletterABD');
      report('6h. non-gate trigger_or_gate_id is NEVER backfilled: displays as literal (n/a), not blank', !!noiseGroup && noiseGroup.class_tag === '(n/a)', JSON.stringify(out.groups));
      report('6i. exactly three groups total (derived + native + n/a)', out.groups.length === 3, JSON.stringify(out.groups));
      report('6i2. gate_class_tag_switchover_ts = the NATIVE row\'s own ts (2026-02-01), not the earlier derived row\'s', out.gate_class_tag_switchover_ts === '2026-02-01T00:00:00.000Z', String(out.gate_class_tag_switchover_ts));
    }

    // ---- 4g2. no native gate row observed at all -> gate_class_tag_switchover_ts is null -----------
    {
      const root = freshRoot('gate-class-tag-no-native');
      writeLedger(root, [
        row({ event_kind: 'would-warn', class_tag: '', trigger_or_gate_id: 'A', event_id: 'old1', impression_id: 'iold1' }),
      ]);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      report('6i3. no native-tagged gate row anywhere -> gate_class_tag_switchover_ts is null', out.gate_class_tag_switchover_ts === null, String(out.gate_class_tag_switchover_ts));
      const textOut = run(root, ['--report']).stdout;
      report('6i4. text output mentions gate_class_tag_switchover_ts', /gate_class_tag_switchover_ts/.test(textOut), textOut);
    }

    // ---- 5. would-warn per 1000 eligible -----------------------------------------------------------
    {
      const root = freshRoot('rate');
      const rows = [];
      for (let i = 0; i < 4; i++) rows.push(row({ event_kind: 'eligible', event_id: 'el' + i, impression_id: 'iel' + i }));
      rows.push(row({ event_kind: 'would-warn', event_id: 'ww1', impression_id: 'iww1' }));
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('7. would_warn_per_1000_eligible = 1/4*1000 = 250', !!g && Math.abs(g.proxy_would_warn_per_1000_eligible - 250) < 1e-9, JSON.stringify(g));
    }

    // ---- 6. Window CLOSED via >=20 later 'observed' rows for the SAME (session, agent) -----------
    {
      const root = freshRoot('window-closed-observed');
      const rows = [row({ event_kind: 'eligible', event_id: 'e1', impression_id: 'i1', ts: '2026-01-01T00:00:00.000Z' })];
      for (let i = 0; i < 20; i++) {
        rows.push(row({ event_kind: 'observed', event_id: 'obs' + i, impression_id: '', trigger_or_gate_id: '', class_tag: '',
          ts: '2026-01-01T00:0' + Math.floor((i + 1) / 10) + ':' + String((i + 1) % 60).padStart(2, '0') + '.000Z' }));
      }
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('8. window closed via >=20 later observed rows: window_closed=1, window_unknown=0, status=closed',
        !!g && g.proxy_window_closed === 1 && g.proxy_window_unknown === 0 && g.proxy_window_status === 'closed', JSON.stringify(g));
    }

    // ---- 7. Window CLOSED via a session-end row ----------------------------------------------------
    {
      const root = freshRoot('window-closed-sessend');
      writeLedger(root, [
        row({ event_kind: 'eligible', event_id: 'e1', impression_id: 'i1' }),
        row({ event_kind: 'session-end', event_id: 'se1', impression_id: '', trigger_or_gate_id: '', class_tag: '' }),
      ]);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('9. window closed via session-end row', !!g && g.proxy_window_closed === 1 && g.proxy_window_status === 'closed', JSON.stringify(g));
    }

    // ---- 8. Window OPEN (literal UNKNOWN): fewer than 20 observed rows, no session-end -----------
    {
      const root = freshRoot('window-open');
      const rows = [row({ event_kind: 'eligible', event_id: 'e1', impression_id: 'i1', ts: '2026-01-01T00:00:00.000Z' })];
      for (let i = 0; i < 5; i++) rows.push(row({ event_kind: 'observed', event_id: 'obs' + i, impression_id: '', trigger_or_gate_id: '', class_tag: '', ts: '2026-01-01T00:00:0' + (i + 1) + '.000Z' }));
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('10. unclosed window: window_unknown=1, status literal UNKNOWN', !!g && g.proxy_window_unknown === 1 && g.proxy_window_status === 'UNKNOWN', JSON.stringify(g));
      const textOut = run(root, ['--report']).stdout;
      report('10b. text table literally contains the UNKNOWN status word', /\bUNKNOWN\b/.test(textOut.split('\n').slice(6).join('\n')), textOut);
    }

    // ---- 9. Cross-session: two sessions, same class/trigger, independent window state -------------
    {
      const root = freshRoot('cross-session');
      const rows = [
        row({ event_kind: 'eligible', event_id: 'eA', impression_id: 'iA', sid_sha16: 'sA', agent_sha16: 'agA', ts: '2026-01-01T00:00:00.000Z' }),
        row({ event_kind: 'session-end', event_id: 'seA', impression_id: '', trigger_or_gate_id: '', class_tag: '', sid_sha16: 'sA', agent_sha16: 'agA' }),
        row({ event_kind: 'eligible', event_id: 'eB', impression_id: 'iB', sid_sha16: 'sB', agent_sha16: 'agB', ts: '2026-01-01T00:00:00.000Z' }),
      ];
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('11. cross-session: session A closed (session-end), session B unknown (no window evidence) -> 1 closed + 1 unknown',
        !!g && g.proxy_window_closed === 1 && g.proxy_window_unknown === 1,
        JSON.stringify(g));
    }

    // ---- 10. Duplicate event_id: written twice, counted once (write-side never dedupes; read-side does) ----
    {
      const root = freshRoot('dupe-eventid');
      writeLedger(root, [
        row({ event_kind: 'eligible', event_id: 'dup1', impression_id: 'i1' }),
        row({ event_kind: 'eligible', event_id: 'dup1', impression_id: 'i1' }), // identical re-entry
        row({ event_kind: 'eligible', event_id: 'dup2', impression_id: 'i2' }),
      ]);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const g = out.groups[0];
      report('12. duplicate event_id collapsed: eligible count = 2 (not 3)', !!g && g.proxy_exposure === 2, JSON.stringify(g));
      report('12b. ledger.distinct_event_id = 2, dupe_rate = 1/3', out.ledger.distinct_event_id === 2 && Math.abs(out.ledger.dupe_rate - (1 / 3)) < 1e-9, JSON.stringify(out.ledger));
    }

    // ---- 11. Malformed row (wrong column count) excluded and reported -----------------------------
    {
      const root = freshRoot('malformed');
      fs.mkdirSync(root, { recursive: true });
      const good = row({ event_kind: 'eligible', event_id: 'e1', impression_id: 'i1' });
      const bad = 'too\tfew\tcolumns';
      fs.writeFileSync(path.join(root, 'events-v3-' + HOST + '.tsv'), [V3_COLUMNS.join('\t'), good, bad].join('\n') + '\n');
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      report('13. malformed row excluded and counted', out.ledger.malformed_rows_excluded === 1, JSON.stringify(out.ledger));
      report('13b. malformed row does not corrupt the good row', out.groups.length === 1 && out.groups[0].proxy_exposure === 1, JSON.stringify(out.groups));
    }

    // ---- 12. --since filters out older rows --------------------------------------------------------
    {
      const root = freshRoot('since');
      writeLedger(root, [
        row({ event_kind: 'eligible', event_id: 'old1', impression_id: 'iold', ts: '2025-01-01T00:00:00.000Z' }),
        row({ event_kind: 'eligible', event_id: 'new1', impression_id: 'inew', ts: '2027-01-01T00:00:00.000Z' }),
      ]);
      const r = run(root, ['--report', '--json', '--since', '2026-01-01T00:00:00.000Z']);
      const g = (JSON.parse(r.stdout || '{}').groups || [])[0];
      report('14. --since excludes the older row: exposure=1', !!g && g.proxy_exposure === 1, JSON.stringify(g));
    }

    // ---- 13. read-only guarantee -------------------------------------------------------------------
    {
      const root = freshRoot('readonly');
      writeLedger(root, [row({ event_kind: 'eligible', event_id: 'e1', impression_id: 'i1' })]);
      const before = fs.readdirSync(root).sort();
      run(root, ['--report', '--json']);
      const after = fs.readdirSync(root).sort();
      report('15. read-only: directory listing unchanged', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    }

    // ---- 14. usage error: no --report flag -> rc 1 --------------------------------------------------
    {
      const root = freshRoot('usage');
      const r = run(root, []);
      report('16. no flags -> rc 1', r.status === 1, 'status=' + r.status);
    }

    // ---- 15. --source rejects anything but v3 --------------------------------------------------------
    {
      const root = freshRoot('badsource');
      const r = run(root, ['--report', '--source', 'm0']);
      report('17. --source m0 (unsupported) -> rc 1', r.status === 1, 'status=' + r.status + ' stderr=' + r.stderr);
      const r2 = run(root, ['--report', '--source', 'v3']);
      report('18. --source v3 (explicit) -> rc 0', r2.status === 0, 'status=' + r2.status);
    }

    // ---- 19. LOW-K2 (2026-09-17, codex second wave / Opus reproduction): PMM_RECALL_ROOT=' '
    // (whitespace-only) must resolve to the SAME directory a WRITER (via ledger.resolveRoot()) would
    // use -- never a literal ' ' path, which would make --report read an empty directory and report
    // all-zero SILENTLY (no error) even though the writer's data is sitting right there in the real
    // default. Verified two ways: (a) this module's own resolveRoot() is a direct re-export of the
    // ledger's, so a pure computation check proves they agree; (b) end-to-end: HOME/USERPROFILE
    // redirected to a temp dir, a ledger row placed at the resulting default root exactly as a real
    // writer would leave it, --report run with PMM_RECALL_ROOT=' ' actually finds it (not all-zero). -
    {
      const before = process.env.PMM_RECALL_ROOT;
      process.env.PMM_RECALL_ROOT = ' ';
      try {
        const fromHere = resolveRoot();
        const fromLedger = ledger.resolveRoot();
        report('19a. LOW-K2: PMM_RECALL_ROOT=\' \' -> resolveRoot() here is never the literal whitespace', fromHere !== ' ', JSON.stringify(fromHere));
        report('19b. LOW-K2: PMM_RECALL_ROOT=\' \' -> resolveRoot() here === ledger.resolveRoot() (same resolver)', fromHere === fromLedger, JSON.stringify({ fromHere, fromLedger }));
      } finally {
        if (before === undefined) delete process.env.PMM_RECALL_ROOT; else process.env.PMM_RECALL_ROOT = before;
      }
    }
    {
      const fakeHome = path.join(T, 'lowk2-fakehome-' + Date.now());
      fs.mkdirSync(fakeHome, { recursive: true });
      const expectedDefaultRoot = path.join(fakeHome, '.claude', '.local', 'pmm-recall');
      fs.mkdirSync(expectedDefaultRoot, { recursive: true });
      // a row placed exactly as a real writer (going through ledger.writeEvent) would leave it.
      const dataRow = ['1', '2026-01-01T00:00:00.000Z', 's', 'a', '', '', 'tu', 'imp', 'ev', 'eligible',
        '', '', 'class:lowk2', 'trigLowk2', '', '', 'intervene', 'policy:absent', '0', '0', '0'].join('\t');
      fs.writeFileSync(path.join(expectedDefaultRoot, 'events-v3-' + os.hostname() + '.tsv'), V3_COLUMNS.join('\t') + '\n' + dataRow + '\n');
      const env = Object.assign({}, process.env, { PMM_RECALL_ROOT: ' ', HOME: fakeHome, USERPROFILE: fakeHome });
      delete env.PMM_RECALL_HOST; // force this tool's own resolveHost() to fall back to the real os.hostname(), matching the file name written above
      const r = spawnSync(process.execPath, [__filename, '--report', '--json'], { env, encoding: 'utf8' });
      const out = JSON.parse(r.stdout || '{}');
      report('19c. LOW-K2 end-to-end: --report with whitespace root + redirected HOME finds the writer\'s data (NOT silently all-zero)', (out.groups || []).length === 1 && out.groups[0].class_tag === 'class:lowk2' && out.groups[0].proxy_exposure === 1, JSON.stringify(out.groups));
    }

    // ---- 20. LOW-K2-followup (2026-09-17, coordinator: real-ledger contamination incident):
    // history rows with id_missing='1' or blank sid_sha16 (the confirmed marker for the 572 leaked
    // pmm-trigger-recall.sh self-test rows found in the real production ledger) must be excluded
    // from the aggregation and counted in the top-level excluded_contaminated field -- never silently
    // folded into a class/trigger group as if they were real exposures.
    {
      const root = freshRoot('contaminated');
      writeLedger(root, [
        row({ event_kind: 'eligible', event_id: 'e1', impression_id: 'i1', class_tag: 'class:clean', trigger_or_gate_id: 'trigClean' }),
        row({ event_kind: 'eligible', event_id: 'e2', impression_id: 'i2', class_tag: 'class:clean', trigger_or_gate_id: 'trigClean' }),
        // contaminated: id_missing=1 (the actual real-incident marker -- missing tool_use_id upstream)
        row({ event_kind: 'eligible', event_id: 'e3', impression_id: '', class_tag: 'test:trig-alpha', trigger_or_gate_id: 'test:trig-alpha', id_missing: '1' }),
        row({ event_kind: 'displayed', event_id: 'e4', impression_id: '', class_tag: 'test:trig-alpha', trigger_or_gate_id: 'test:trig-alpha', id_missing: '1' }),
        // contaminated: blank sid_sha16 (independent forward-looking marker)
        row({ event_kind: 'eligible', event_id: 'e5', impression_id: 'i5', class_tag: 'class:blanksid', trigger_or_gate_id: 'trigBlank', sid_sha16: '' }),
        // M-1 item 5 (2026-09-17, fab blind attack / Opus reproduction): run_provenance starting with
        // 'test' -- the confirmed marker for 2 real-ledger rows previously mis-classified as unrelated
        // production data (they are pipe-gate-v2-acceptance.cjs runner-synthesized rows).
        row({ event_kind: 'would-warn', event_id: 'e6', impression_id: 'i6', class_tag: 'class:runnerprov', trigger_or_gate_id: 'trigRunnerProv', run_provenance: 'test' }),
        // M-1 item 5: tool_use_id shaped like a runner-synthesized id (tu-<...>, never Claude Code's
        // own toolu_<...> format).
        row({ event_kind: 'eligible', event_id: 'e7', impression_id: 'i7', class_tag: 'class:runnertool', trigger_or_gate_id: 'trigRunnerTool', tool_use_id: 'tu-vpmxaobr0nh' }),
      ]);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      report('20a. excluded_contaminated=5 (2 id_missing=1 + 1 blank-sid + 1 run_provenance=test + 1 tool_use_id=tu-*)', out.excluded_contaminated === 5, JSON.stringify(out.excluded_contaminated));
      const clean = (out.groups || []).find((g) => g.trigger_or_gate_id === 'trigClean');
      report('20b. the clean class:clean/trigClean group is unaffected, exposure=2', !!clean && clean.proxy_exposure === 2, JSON.stringify(clean));
      const contaminated = (out.groups || []).find((g) => g.trigger_or_gate_id === 'test:trig-alpha');
      report('20c. the contaminated test:trig-alpha group never appears in the report at all', !contaminated, JSON.stringify(out.groups));
      const blankSid = (out.groups || []).find((g) => g.trigger_or_gate_id === 'trigBlank');
      report('20d. the blank-sid class:blanksid/trigBlank group never appears in the report either', !blankSid, JSON.stringify(out.groups));
      const runnerProv = (out.groups || []).find((g) => g.trigger_or_gate_id === 'trigRunnerProv');
      report('20f. the run_provenance=test trigRunnerProv group never appears in the report', !runnerProv, JSON.stringify(out.groups));
      const runnerTool = (out.groups || []).find((g) => g.trigger_or_gate_id === 'trigRunnerTool');
      report('20g. the tool_use_id=tu-* trigRunnerTool group never appears in the report', !runnerTool, JSON.stringify(out.groups));
      const rText = run(root, ['--report']);
      report('20e. text mode also prints excluded_contaminated=5 near the top', /excluded_contaminated=5/.test(rText.stdout), rText.stdout.slice(0, 200));
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
  const opts = parseArgs(argv);
  if (opts.error) { console.error('usage: pmm-recall-baseline.cjs --report [--source v3] [--since <iso>] [--json]\n' + opts.error); return 1; }
  if (!opts.report) { console.error('usage: pmm-recall-baseline.cjs --report [--source v3] [--since <iso>] [--json]'); return 1; }
  const rep = buildReport(opts);
  if (opts.json) console.log(JSON.stringify(rep, null, 2));
  else process.stdout.write(formatText(rep));
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { resolveRoot, resolveHost, readV3Rows, dedupByEventId, applySince,
  buildSessAgentIndex, windowStatus, aggregate, finalizeGroup, buildReport,
  backfillGateClassTag, GATE_ROW_CLASS_TAG };
