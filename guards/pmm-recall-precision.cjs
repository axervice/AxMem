#!/usr/bin/env node
// pmm-recall-precision.cjs — M1 precision report: per-trigger / per-class exposure, label, and
// Wilson-lower-bound precision stats, plus noise-rate-per-1000-eligible-tool-events.
//
// guards/specs/RECALL-LOOP-M-SPEC-v2.md M1 section, HIGH-5:
//   "精确率闸用置信区间:单侧 95% Wilson 下界 > 80%(n=30 时约需 ≥28 useful;24/30 仍为 UNKNOWN);
//    未达 = UNKNOWN,不猜。"
//   "报告 pmm-recall-precision.cjs --report:按 trigger、按 class 列曝光/标注/useful 精确率(含区间)/
//    每千 eligible tool events 噪音行(不是「每千回合」,Bash hook 拿不到回合数)。"
//
// "n" for the Wilson bound is the LABELED sample size for that trigger/class (not total exposures);
// "k" is the number labeled useful, where useful-not-followed counts as useful (HIGH-5: it's
// "useful + recurrence", never noise). The gate this tool prints is deliberately conservative: the
// human-facing "precision" column literally prints the string UNKNOWN whenever either (a) fewer
// than 30 labels exist for that group, or (b) the computed one-sided 95% Wilson lower bound does
// not clear 0.80 — "不猜" is read literally: no numeric-looking precision figure is shown unless
// the gate is actually cleared. (--json still includes the raw computed number alongside an
// explicit `status` field, since JSON is for machine consumption and hiding the number there would
// only make a downstream consumer re-derive it worse.)
//
// Stop condition (per trigger, not per total Bash event count): matched exposures >= 30 AND
// labeled >= 30 (`stop_condition_met`).
//
// READ-ONLY: this tool writes nothing, ever.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// pmm-recall-classify.cjs (2026-09-17, MEDIUM-7 Opus review): the SAME class_tag backfill +
// display bucketing pmm-recall-baseline.cjs uses, so old (pre-v2.19) gate rows with class_tag=''
// never silently merge with genuinely-unattributable rows into one flat '(unknown)' bucket that
// could show a false PASS (this tool's whole job is to be conservative about precision claims).
const classify = require('./pmm-recall-classify.cjs');
// pmm-recall-ledger.cjs (2026-09-17, LOW-K2 Opus review): the write side already converged all
// five writers onto ledger's resolveRoot() (round LOW-5); this tool is one of the five read-side
// tools that still carried its own un-normalized `process.env.PMM_RECALL_ROOT || defaultRoot()`
// copy — under PMM_RECALL_ROOT=' ' (whitespace) that returns the literal " " directory while the
// writers fall back to the real default, so this tool would silently analyze an empty directory
// and report all-zero. Reusing ledger's trimming resolveRoot() closes that divergence.
const ledger = require('./pmm-recall-ledger.cjs');

// ---------------------------------------------------------------------------------------------
// Shared reading layer — see pmm-recall-queue.cjs for the extended rationale comment.
// resolveRoot() is ledger's exported implementation (LOW-K2), not a local copy — see comment above.
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
const STOP_N = 30;
const WILSON_Z_ONE_SIDED_95 = 1.6448536269514722; // z_0.95 (one-sided upper-tail critical value)

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
    // this build: 11/1362 rows are missing `event_id` entirely, which would otherwise corrupt both
    // the dedup step and any precision figure built on top of it (see pmm-recall-queue.cjs's
    // readLedgerRows for the fuller rationale, duplicated here since no shared module was
    // authorized by the build brief).
    if (parts.length !== cols.length) { malformed++; continue; }
    const row = {};
    cols.forEach((c, i) => { row[c] = parts[i]; });
    if (source === 'm0') row.trigger_or_gate_id = row.trigger_id;
    // MEDIUM-7: backfill pre-v2.19 gate rows (class_tag='', trigger_or_gate_id in A/B/D) to the real
    // lesson tag, flagged _class_tag_derived so display grouping can bucket them separately (a no-op
    // for m0 rows, whose trigger_or_gate_id is a lesson tag, never the literal A/B/D).
    classify.backfillGateClassTag(row);
    rows.push(row);
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
// the confirmed, cross-validated marker for the pmm-trigger-recall.sh self-test rows that repeatedly
// leaked into the real production ledger (root-caused and fixed at the source -- see pmm-trigger-
// recall.sh's PMM_RECALL_ROOT isolation). id_missing=1 already implies a blank impression_id for
// those specific rows (so isMatchedRow() below was already excluding them structurally); this check
// is kept explicit anyway so (a) the exclusion is counted (excluded_contaminated) rather than a
// silent side effect of an unrelated truthiness check, and (b) the blank-sid_sha16 leg is covered as
// an independent, forward-looking net even for a hypothetical future row with a non-blank
// impression_id but no real session identity.
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

function aggregateImpressions(dedupedRows) {
  const map = new Map();
  for (const r of dedupedRows) {
    if (!isMatchedRow(r)) continue;
    let agg = map.get(r.impression_id);
    if (!agg) {
      agg = { impression_id: r.impression_id, trigger_or_gate_id: r.trigger_or_gate_id,
        class_tag: r.class_tag || '', class_tag_derived: !!r._class_tag_derived, kinds: new Set() };
      map.set(r.impression_id, agg);
    }
    agg.kinds.add(r.event_kind);
    if (!agg.class_tag && r.class_tag) { agg.class_tag = r.class_tag; agg.class_tag_derived = !!r._class_tag_derived; }
  }
  return map;
}

function readLabelsMap(root, host) {
  const file = labelsPath(root, host);
  const { lines, exists } = readLines(file);
  const map = new Map();
  for (const line of lines) {
    const parts = line.split('\t');
    const row = { ts: parts[0] || '', impression_id: parts[1] || '', label: parts[2] || '',
      note: parts[3] || '', labeler: parts[4] || '' };
    if (row.impression_id) map.set(row.impression_id, row); // last write wins
  }
  return { map, file, exists };
}

function currentLabelOf(labelsMap, impressionId) {
  const row = labelsMap.get(impressionId);
  if (!row || !row.label || row.label === UNDO_SENTINEL) return null;
  return row.label;
}

// ---------------------------------------------------------------------------------------------
// Wilson score interval — one-sided 95% LOWER bound, as a pure function (self-tested against two
// known vectors from the spec text: n=30,k=28 must clear 0.80; n=30,k=24 must not).
// Standard form: for phat=k/n, z the one-sided critical value,
//   lower = [ phat + z^2/(2n) - z*sqrt( phat(1-phat)/n + z^2/(4n^2) ) ] / (1 + z^2/n)
// ---------------------------------------------------------------------------------------------
function wilsonLowerBound(k, n, z) {
  z = z == null ? WILSON_Z_ONE_SIDED_95 : z;
  if (!n || n <= 0) return null;
  if (k < 0 || k > n) return null;
  const phat = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  let lb = center - margin;
  if (lb < 0) lb = 0;
  if (lb > 1) lb = 1;
  return lb;
}

// ---------------------------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------------------------

function groupBy(impArray, keyFn) {
  const map = new Map();
  for (const imp of impArray) {
    const k = keyFn(imp) || '(n/a)'; // MEDIUM-7: unified with pmm-recall-classify.cjs's literal
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(imp);
  }
  return map;
}

function computeGroupStats(impArray, labelsMap) {
  const exposures = impArray.length;
  let labeled = 0, useful = 0, usefulNotFollowed = 0, noise = 0;
  for (const imp of impArray) {
    const lab = currentLabelOf(labelsMap, imp.impression_id);
    if (!lab) continue;
    labeled++;
    if (lab === 'useful') useful++;
    else if (lab === 'useful-not-followed') { useful++; usefulNotFollowed++; }
    else if (lab === 'noise') noise++;
  }
  const lowerBound = labeled > 0 ? wilsonLowerBound(useful, labeled) : null;
  const gateCleared = labeled >= STOP_N && lowerBound !== null && lowerBound > 0.8;
  const status = gateCleared ? 'PASS' : 'UNKNOWN';
  let eligibleToolEvents = 0;
  for (const imp of impArray) if (imp.kinds.has('eligible')) eligibleToolEvents++;
  const noisePer1000 = eligibleToolEvents > 0 ? (noise / eligibleToolEvents) * 1000 : null;
  const stopConditionMet = exposures >= STOP_N && labeled >= STOP_N;
  return { exposures, labeled, useful, useful_not_followed: usefulNotFollowed, noise,
    lower_bound: lowerBound, status, eligible_tool_events: eligibleToolEvents,
    noise_per_1000_eligible: noisePer1000, stop_condition_met: stopConditionMet };
}

function buildReport(opts) {
  const root = resolveRoot();
  const host = resolveHost();
  const source = opts.source || detectSource(root, host);
  const ledger = readLedgerRows(source, root, host);
  const dedup = dedupByEventId(ledger.rows);
  // LOW-K2-followup: count contaminated rows that otherwise LOOK LIKE a matched exposure (a
  // trigger_or_gate_id + a matched event_kind -- exactly the shape the leaked pmm-trigger-recall.sh
  // fixture rows have) but are excluded by isContaminatedRow(). Deliberately does NOT also require
  // r.impression_id here: for the confirmed real incident (id_missing=1), a blank impression_id is
  // itself a SYMPTOM of the same contamination, not an independent reason those rows were already
  // going to be skipped -- counting them under "just an ordinary non-match" would hide the exclusion
  // this field exists to surface. Bookkeeping kinds (observed/session-end/...) never match this
  // filter at all (MATCHED_KINDS excludes them), so this stays scoped to the matched-exposure universe.
  const excludedContaminatedCount = dedup.rows.filter((r) =>
    r.trigger_or_gate_id && MATCHED_KINDS.has(r.event_kind) && isContaminatedRow(r)).length;
  const impressionsMap = aggregateImpressions(dedup.rows);
  const impArray = Array.from(impressionsMap.values());
  const labelsLayer = readLabelsMap(root, host);

  const byTrigger = groupBy(impArray, (imp) => imp.trigger_or_gate_id);
  // MEDIUM-7: by_class buckets through the SAME displayClassTag() pmm-recall-baseline.cjs uses --
  // a derived-old row never silently merges with a native row into one flat group (which could show
  // a false PASS mixing pre-fix and post-fix data); a genuinely unattributable row shows as (n/a).
  const byClass = groupBy(impArray, (imp) => classify.displayClassTag({ class_tag: imp.class_tag, _class_tag_derived: imp.class_tag_derived }));

  function toRows(groupMap) {
    return Array.from(groupMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, list]) => Object.assign({ key }, computeGroupStats(list, labelsLayer.map)));
  }

  return {
    generated_at: new Date().toISOString(),
    source, root, host,
    // LOW-K2-followup: history rows excluded as contaminated (id_missing=1 or blank sid_sha16) --
    // never deleted from the ledger itself, only excluded from THIS report's aggregation.
    excluded_contaminated: excludedContaminatedCount,
    ledger: { file: ledger.file, exists: ledger.exists, rows_read: dedup.totalRead,
      distinct_event_id: dedup.distinctCount, dupe_rate: dedup.dupeRate,
      malformed_rows_excluded: ledger.malformed },
    labels_file: { file: labelsLayer.file, exists: labelsLayer.exists },
    by_trigger: toRows(byTrigger),
    by_class: toRows(byClass),
  };
}

// Opus review (2026-09-17, unified wording): --unlock's refusal message prints the actual computed
// lower95 number (e.g. "lower95=0.6575") while the human-facing --report table printed a bare
// "UNKNOWN" with no number -- same underlying figure, two different presentations. Unified: the
// text table now prints "UNKNOWN(lower95=0.66)" (2 decimals, matching --unlock's own message style)
// whenever the number IS computable (labeled>0); a group with zero labels has no number to show, so
// it stays the bare literal "UNKNOWN". --json is untouched (it already carries the raw lower_bound).
function fmtPrecision(row) {
  if (row.status === 'PASS') return row.lower_bound.toFixed(4);
  if (row.lower_bound === null) return 'UNKNOWN';
  return 'UNKNOWN(lower95=' + row.lower_bound.toFixed(2) + ')';
}
function fmtNoise(row) {
  return row.noise_per_1000_eligible === null ? 'n/a' : row.noise_per_1000_eligible.toFixed(2);
}

function formatText(report) {
  const lines = [];
  lines.push(`generated_at=${report.generated_at} source=${report.source} root=${report.root} host=${report.host}`);
  lines.push(`excluded_contaminated=${report.excluded_contaminated}`);
  lines.push(`ledger: file=${report.ledger.file} exists=${report.ledger.exists} rows_read=${report.ledger.rows_read} distinct_event_id=${report.ledger.distinct_event_id} dupe_rate=${(report.ledger.dupe_rate * 100).toFixed(2)}% malformed_rows_excluded=${report.ledger.malformed_rows_excluded}`);
  lines.push(`labels: file=${report.labels_file.file} exists=${report.labels_file.exists}`);
  lines.push('');

  function table(title, rows) {
    lines.push(`== ${title} ==`);
    if (!rows.length) { lines.push('(none)'); lines.push(''); return; }
    const header = ['key', 'exposures', 'labeled', 'useful', 'noise', 'precision(lower95)',
      'noise/1k-eligible', 'stop_condition_met'];
    lines.push(header.join('\t'));
    for (const r of rows) {
      lines.push([r.key, r.exposures, r.labeled, r.useful, r.noise, fmtPrecision(r), fmtNoise(r),
        r.stop_condition_met ? 'yes' : 'no'].join('\t'));
    }
    lines.push('');
  }
  table('by trigger_or_gate_id', report.by_trigger);
  table('by class_tag', report.by_class);
  return lines.join('\n').replace(/\n+$/, '\n');
}

const GATE_NAMES = ['A', 'B', 'D'];

function parseArgs(argv) {
  const opts = { report: false, json: false, source: null, selfTest: false, unlock: null, gate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') opts.selfTest = true;
    else if (a === '--report') opts.report = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--source') opts.source = argv[++i];
    else if (a.startsWith('--source=')) opts.source = a.slice('--source='.length);
    else if (a === '--unlock') opts.unlock = argv[++i];
    else if (a.startsWith('--unlock=')) opts.unlock = a.slice('--unlock='.length);
    else if (a === '--gate') opts.gate = argv[++i];
    else if (a.startsWith('--gate=')) opts.gate = a.slice('--gate='.length);
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// B3 · pmm-recall-precision.cjs --unlock <class_tag> --gate <A|B|D> (M-SPEC RECALL-LOOP-M-SPEC-
// v2.md 附录 B3 补注 #2, 契约 v2.19 conventions.policy_file, 2026-09-17 11:10): policy.json is now
// keyed by class_tag with a PER-GATE `gates` sub-object -- "class + 每 gate 子键". The Wilson bound
// is computed over the (class_tag, trigger_or_gate_id=gate) INTERSECTION (not the class-wide
// marginal the v1 schema used), because a class's three gates (A/B/D) can clear the M1 bar at very
// different rates. This tool is the ONLY writer of policy.json's `gates[G]='randomized'` value
// (contract: "Only pmm-recall-precision.cjs --unlock <class_tag> --gate <G> may write
// gates[G]=randomized"); it re-derives the (class,gate) precision figure itself (never trusts a
// caller-supplied number) and refuses (rc 2, file left byte-unchanged) unless that (class,gate)'s
// own `status` is 'PASS' (labeled>=30 AND lower95>0.80). class-level `mode` becomes 'randomized'
// as soon as AT LEAST ONE gate is unlocked (other gates of the same class may still be shadow;
// their own ledger rows record mode=shadow, run_provenance=policy:shadow-gate -- that reading is
// the Bash gate's own responsibility, out of this file's scope). Missing/invalid --gate is a usage
// error, rc 2 (the v1 class-only --unlock <class_tag> form is retired by v2.19).
// ---------------------------------------------------------------------------------------------

function policyPath(root) { return path.join(root, 'policy.json'); }

function readPolicy(root) {
  try {
    const raw = fs.readFileSync(policyPath(root), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch (e) { /* missing file or malformed JSON -> treat as empty policy, never throw */ }
  return {};
}

// computeGateStats(classTag, gate, opts): the Wilson precision figure for the (class_tag, gate)
// INTERSECTION -- filters buildReport()'s own impression aggregation (never re-implements it) down
// to impressions whose trigger_or_gate_id is exactly `gate` AND whose class_tag is exactly
// `classTag`, then reuses computeGroupStats() (the same gate PASS/UNKNOWN + Wilson logic the
// human-facing report already uses) unchanged.
function computeGateStats(classTag, gate, opts) {
  const root = resolveRoot();
  const host = resolveHost();
  const source = (opts && opts.source) || detectSource(root, host);
  const ledger = readLedgerRows(source, root, host);
  const dedup = dedupByEventId(ledger.rows);
  const impressionsMap = aggregateImpressions(dedup.rows);
  const impArray = Array.from(impressionsMap.values())
    .filter((imp) => imp.trigger_or_gate_id === gate && imp.class_tag === classTag);
  const labelsLayer = readLabelsMap(root, host);
  const stats = computeGroupStats(impArray, labelsLayer.map);
  return Object.assign({ class_tag: classTag, gate, generated_at: new Date().toISOString() }, stats);
}

function doUnlock(classTag, gate, opts) {
  if (!gate || GATE_NAMES.indexOf(gate) === -1) {
    console.error('USAGE ERROR: --unlock <class_tag> requires --gate <A|B|D>; got: ' + JSON.stringify(gate));
    return 2;
  }
  const root = resolveRoot();
  const stats = computeGateStats(classTag, gate, opts || {});
  if (stats.status !== 'PASS') {
    const lb = stats.lower_bound !== null ? stats.lower_bound.toFixed(4) : 'n/a';
    console.error('REFUSED: (class_tag="' + classTag + '", gate=' + gate + ') has not cleared the M1 gate ' +
      '(labeled=' + stats.labeled + ' need>=' + STOP_N + ', lower95=' + lb + ' need>0.80); policy.json left unchanged.');
    return 2;
  }
  const policy = readPolicy(root);
  const reportId = 'pmm-recall-precision@' + stats.generated_at;
  const prevEntry = (policy[classTag] && typeof policy[classTag] === 'object' && !Array.isArray(policy[classTag])) ? policy[classTag] : {};
  const prevGates = (prevEntry.gates && typeof prevEntry.gates === 'object' && !Array.isArray(prevEntry.gates)) ? prevEntry.gates : {};
  const prevLowerByGate = (prevEntry.lower95_by_gate && typeof prevEntry.lower95_by_gate === 'object' && !Array.isArray(prevEntry.lower95_by_gate)) ? prevEntry.lower95_by_gate : {};
  const gates = Object.assign({}, prevGates, { [gate]: 'randomized' });
  const lower95ByGate = Object.assign({}, prevLowerByGate, { [gate]: stats.lower_bound });
  policy[classTag] = {
    mode: 'randomized', // at least one gate of this class is now randomized
    gates,
    lower95_by_gate: lower95ByGate,
    unlocked_by: reportId,
    unlocked_at: new Date().toISOString(),
  };
  // LOW-2 (2026-09-17, fab blind attack / Opus reproduction): write via a temp file + rename instead
  // of a direct writeFileSync -- a reader (any of the recall tools, or a concurrent --unlock) that
  // opens policy.json mid-write used to be able to observe a truncated/partial JSON document (the
  // exact corrupt-input shape pmm-recall-policy.cjs's own resolve() already has to defend against
  // and report as provenance='policy:corrupt'). fs.renameSync on the SAME filesystem/volume is
  // atomic on both POSIX and Windows -- readers only ever see the old complete file or the new
  // complete file, never a partial write.
  const finalPath = policyPath(root);
  const tmpPath = finalPath + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(policy, null, 2) + '\n');
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (e2) { /* best effort cleanup of a failed write's temp file */ }
    console.error('failed to write policy.json: ' + e.message);
    return 2;
  }
  console.log('UNLOCKED: ' + classTag + ' gate=' + gate + ' -> randomized (lower95=' + stats.lower_bound.toFixed(4) + ', unlocked_by=' + reportId + ')');
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

  // ---- 1. Pure-function Wilson vectors, straight from the spec text --------------------------
  const lb28 = wilsonLowerBound(28, 30);
  report('wilsonLowerBound(28,30) clears 0.80 (spec: "约需 >=28 useful")', lb28 > 0.80, String(lb28));
  report('wilsonLowerBound(28,30) is in a sane neighborhood of the spec\'s "~0.80" note', lb28 > 0.80 && lb28 < 0.85, String(lb28));
  const lb27 = wilsonLowerBound(27, 30);
  report('wilsonLowerBound(27,30) does NOT clear 0.80 (one useful short of the spec\'s threshold)', lb27 < 0.80, String(lb27));
  const lb24 = wilsonLowerBound(24, 30);
  report('wilsonLowerBound(24,30) well below 0.80 (spec: "24/30 仍为 UNKNOWN")', lb24 < 0.80, String(lb24));
  report('wilsonLowerBound(0,0) returns null (no crash on empty sample)', wilsonLowerBound(0, 0) === null, '');
  report('wilsonLowerBound is monotonic in k for fixed n', wilsonLowerBound(29, 30) > wilsonLowerBound(28, 30) && wilsonLowerBound(28, 30) > wilsonLowerBound(27, 30), '');
  report('wilsonLowerBound(30,30) is close to but below 1', wilsonLowerBound(30, 30) < 1 && wilsonLowerBound(30, 30) > 0.85, String(wilsonLowerBound(30, 30)));

  // ---- 2. End-to-end report over a synthetic m0 ledger ----------------------------------------
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-selftest-'));
  // LOW-3 (2026-09-17, fab blind attack): process.on('exit') safety net in ADDITION to the try/finally
  // cleanup below -- see pmm-recall-m3.cjs's copy of this comment for the full rationale.
  process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  const HOST = 'test-host';
  const env = Object.assign({}, process.env, { PMM_RECALL_ROOT: T, PMM_RECALL_HOST: HOST });
  function run(args) { return spawnSync(process.execPath, [__filename].concat(args), { env, encoding: 'utf8' }); }

  try {
    function m0Row(kind, sid, tool, trig, cls, impId, evId, ts) {
      return ['1', ts, sid, tool, '', '', '', '0', kind, trig, cls, 'posix', '0', 'tail', '',
        'ok', 'aaaa', '1.1', impId, evId, '0', '0'].join('\t');
    }
    const rows = [];
    // triggerA / class:x: 35 matched impressions, all event_kind='eligible' (so eligible_tool_events=35).
    for (let i = 0; i < 35; i++) {
      rows.push(m0Row('eligible', 's' + i, 't' + i, 'triggerA', 'class:x', 'impA' + i, 'evA' + i,
        '2026-01-01T00:00:' + String(i).padStart(2, '0') + 'Z'));
    }
    // triggerB / class:y: 10 matched impressions.
    for (let i = 0; i < 10; i++) {
      rows.push(m0Row('eligible', 'sb' + i, 'tb' + i, 'triggerB', 'class:y', 'impB' + i, 'evB' + i,
        '2026-01-01T01:00:' + String(i).padStart(2, '0') + 'Z'));
    }
    fs.writeFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), rows.join('\n') + '\n');

    // Label triggerA: 30 labeled, 28 useful (1 of which useful-not-followed), 2 noise -> should PASS.
    const labelLines = [];
    for (let i = 0; i < 27; i++) labelLines.push(['2026-01-02T00:00:00Z', 'impA' + i, 'useful', '', 't'].join('\t'));
    labelLines.push(['2026-01-02T00:00:00Z', 'impA27', 'useful-not-followed', 'recurred once', 't'].join('\t'));
    labelLines.push(['2026-01-02T00:00:00Z', 'impA28', 'noise', '', 't'].join('\t'));
    labelLines.push(['2026-01-02T00:00:00Z', 'impA29', 'noise', '', 't'].join('\t'));
    // triggerB: label all 10, 5 noise / 5 useful -> labeled(10) < 30 -> must be UNKNOWN regardless of ratio.
    for (let i = 0; i < 5; i++) labelLines.push(['2026-01-02T00:00:00Z', 'impB' + i, 'useful', '', 't'].join('\t'));
    for (let i = 5; i < 10; i++) labelLines.push(['2026-01-02T00:00:00Z', 'impB' + i, 'noise', '', 't'].join('\t'));
    fs.writeFileSync(path.join(T, 'labels-' + HOST + '.tsv'), labelLines.join('\n') + '\n');

    let r = run(['--report', '--json']);
    report('report --json exits 0', r.status === 0, 'status=' + r.status + ' stderr=' + r.stderr);
    let out = {};
    try { out = JSON.parse(r.stdout); } catch (e) { /* leave {} */ }
    const trigA = (out.by_trigger || []).find((t) => t.key === 'triggerA');
    const trigB = (out.by_trigger || []).find((t) => t.key === 'triggerB');
    report('triggerA: exposures=35', !!trigA && trigA.exposures === 35, JSON.stringify(trigA));
    report('triggerA: labeled=30', !!trigA && trigA.labeled === 30, JSON.stringify(trigA));
    report('triggerA: useful=28 (27 useful + 1 useful-not-followed)', !!trigA && trigA.useful === 28, JSON.stringify(trigA));
    report('triggerA: useful_not_followed=1', !!trigA && trigA.useful_not_followed === 1, JSON.stringify(trigA));
    report('triggerA: noise=2', !!trigA && trigA.noise === 2, JSON.stringify(trigA));
    report('triggerA: status=PASS (28/30 clears the Wilson gate)', !!trigA && trigA.status === 'PASS', JSON.stringify(trigA));
    report('triggerA: stop_condition_met=true (matched>=30 and labeled>=30)', !!trigA && trigA.stop_condition_met === true, JSON.stringify(trigA));
    report('triggerA: eligible_tool_events=35', !!trigA && trigA.eligible_tool_events === 35, JSON.stringify(trigA));
    report('triggerA: noise_per_1000_eligible = 2/35*1000', !!trigA && Math.abs(trigA.noise_per_1000_eligible - (2 / 35 * 1000)) < 1e-6, JSON.stringify(trigA));

    report('triggerB: exposures=10, labeled=10', !!trigB && trigB.exposures === 10 && trigB.labeled === 10, JSON.stringify(trigB));
    report('triggerB: status=UNKNOWN despite 50% "useful" ratio (labeled<30, insufficient sample)', !!trigB && trigB.status === 'UNKNOWN', JSON.stringify(trigB));
    report('triggerB: stop_condition_met=false (labeled<30)', !!trigB && trigB.stop_condition_met === false, JSON.stringify(trigB));

    // by_class mirrors by_trigger here since each class maps 1:1 to a trigger in this fixture.
    const classX = (out.by_class || []).find((c) => c.key === 'class:x');
    report('by_class: class:x aggregates the same 35 exposures as triggerA', !!classX && classX.exposures === 35 && classX.status === 'PASS', JSON.stringify(classX));

    // ---- Malformed-row hardening: a field-count-mismatched row must be excluded and reported,
    // ---- never silently mis-mapped into a fake shared sentinel that would corrupt the dedup step
    // ---- or the resulting precision figures. -----------------------------------------------------
    const malformedLine = ['1', '2026-01-01T02:00:00Z', 'sm', 'tm', '', '', '', '0', 'eligible',
      'triggerA', 'class:x', 'posix', '0', 'tail', '', 'ok', 'aaaa', '1.1', 'impMalformed', '0'].join('\t');
    fs.appendFileSync(path.join(T, 'impressions-' + HOST + '.tsv'), malformedLine + '\n');
    r = run(['--report', '--json']);
    out = JSON.parse(r.stdout || '{}');
    report('malformed row reported and excluded (does not corrupt triggerA exposures)', out.ledger && out.ledger.malformed_rows_excluded === 1, JSON.stringify(out.ledger));
    const trigAAfterMalformed = (out.by_trigger || []).find((t) => t.key === 'triggerA');
    report('triggerA exposures still exactly 35 after a malformed row is appended', !!trigAAfterMalformed && trigAAfterMalformed.exposures === 35, JSON.stringify(trigAAfterMalformed));

    // ---- text-mode UNKNOWN literal check: the human-facing table must print the string UNKNOWN --
    r = run(['--report']);
    const textOut = r.stdout;
    report('text report prints UNKNOWN(lower95=X.XX) for triggerB (unified wording, Opus review)', /triggerB[^\n]*\tUNKNOWN\(lower95=0\.\d\d\)\t/.test(textOut), textOut);
    // bare "UNKNOWN" (no number) is reserved for a group with zero labels -- lower_bound is null there.
    {
      const T5 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-unknown-nonumber-'));
      const env5 = Object.assign({}, process.env, { PMM_RECALL_ROOT: T5, PMM_RECALL_HOST: HOST });
      const rows5 = [];
      for (let i = 0; i < 3; i++) rows5.push(m0Row('eligible', 'sz' + i, 'tz' + i, 'triggerZ', 'class:z', 'impZ' + i, 'evZ' + i, '2026-01-01T00:00:00Z'));
      fs.writeFileSync(path.join(T5, 'impressions-' + HOST + '.tsv'), rows5.join('\n') + '\n'); // zero labels for triggerZ
      const r5 = spawnSync(process.execPath, [__filename, '--report'], { env: env5, encoding: 'utf8' });
      report('bare UNKNOWN (no number) for a group with zero labels', /triggerZ[^\n]*\tUNKNOWN\t/.test(r5.stdout), r5.stdout);
      fs.rmSync(T5, { recursive: true, force: true });
    }
    report('text report prints a real number for triggerA (gate cleared)', new RegExp('triggerA\\t35\\t30\\t28\\t2\\t0\\.8').test(textOut), textOut);

    // ---- missing --report and missing --self-test -> usage error, rc 1 ---------------------------
    r = run([]);
    report('no flags at all -> rc 1 (usage error, not a silent empty report)', r.status === 1, 'status=' + r.status);

    // ---- empty root: no crash -------------------------------------------------------------------
    const T2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-empty-'));
    const env2 = Object.assign({}, process.env, { PMM_RECALL_ROOT: T2, PMM_RECALL_HOST: HOST });
    r = spawnSync(process.execPath, [__filename, '--report', '--json'], { env: env2, encoding: 'utf8' });
    out = JSON.parse(r.stdout || '{}');
    report('empty root: exits 0 with empty by_trigger/by_class, no crash', r.status === 0 && (out.by_trigger || []).length === 0 && (out.by_class || []).length === 0, JSON.stringify(out));

    // ---- synthetic v3 ledger adapter ---------------------------------------------------------------
    const T3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-v3-'));
    const env3 = Object.assign({}, process.env, { PMM_RECALL_ROOT: T3, PMM_RECALL_HOST: HOST });
    function run3(args) { return spawnSync(process.execPath, [__filename].concat(args), { env: env3, encoding: 'utf8' }); }
    function v3Row(kind, sid, tool, trig, cls, impId, evId, ts) {
      return ['3', ts, sid, 'agentA', 'sonnet-builder', 'promptA', tool, impId, evId, kind, '',
        '', cls, trig, 'aaaa', '1.1', 'shadow', '', '0', '0', '0'].join('\t');
    }
    const v3Rows = [V3_COLUMNS.join('\t')];
    for (let i = 0; i < 5; i++) v3Rows.push(v3Row('eligible', 'sv' + i, 'tv' + i, 'gateX', 'class:z', 'impV' + i, 'evV' + i, '2026-02-01T00:00:00Z'));
    fs.writeFileSync(path.join(T3, 'events-v3-' + HOST + '.tsv'), v3Rows.join('\n') + '\n');
    const v3Labels = [];
    for (let i = 0; i < 5; i++) v3Labels.push(['2026-02-02T00:00:00Z', 'impV' + i, 'noise', '', 't'].join('\t'));
    fs.writeFileSync(path.join(T3, 'labels-' + HOST + '.tsv'), v3Labels.join('\n') + '\n');
    r = run3(['--report', '--json']);
    out = JSON.parse(r.stdout || '{}');
    const gateX = (out.by_trigger || []).find((t) => t.key === 'gateX');
    report('v3 source auto-detected', out.source === 'v3', JSON.stringify(out.source));
    report('v3 source: gateX exposures=5, labeled=5, noise=5, status=UNKNOWN (n<30)', !!gateX && gateX.exposures === 5 && gateX.labeled === 5 && gateX.noise === 5 && gateX.status === 'UNKNOWN', JSON.stringify(gateX));

    // ---- MEDIUM-7 (2026-09-17, Opus review): old (pre-v2.19) gate-A rows with class_tag='' must
    // NOT silently merge into a flat '(unknown)' bucket that could show a false PASS mixing pre-fix
    // and post-fix (or genuinely unattributable) data. 30 old empty-class_tag gate-A rows, 29/30
    // labeled useful (clears the Wilson gate) -> the report must bucket them under
    // "<lesson tag> (pre-class_tag)", NEVER under a literal "(unknown)" key. -----------------------
    {
      const T6 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-medium7-'));
      const env6 = Object.assign({}, process.env, { PMM_RECALL_ROOT: T6, PMM_RECALL_HOST: HOST });
      function run6(args) { return spawnSync(process.execPath, [__filename].concat(args), { env: env6, encoding: 'utf8' }); }
      const rows6 = [V3_COLUMNS.join('\t')];
      for (let i = 0; i < 30; i++) rows6.push(v3Row('would-warn', 'sm7-' + i, 'tm7-' + i, 'A', '', 'impM7-' + i, 'evM7-' + i, '2026-04-01T00:00:00Z'));
      // also add a genuinely-unattributable row (empty class_tag, non-gate trigger_or_gate_id) that
      // must land in a SEPARATE (n/a) bucket, never merged with the (pre-class_tag) one.
      rows6.push(v3Row('would-warn', 'sm7-noise', 'tm7-noise', 'not-a-gate', '', 'impM7-noise', 'evM7-noise', '2026-04-01T00:00:00Z'));
      fs.writeFileSync(path.join(T6, 'events-v3-' + HOST + '.tsv'), rows6.join('\n') + '\n');
      const labels6 = [];
      for (let i = 0; i < 29; i++) labels6.push(['2026-04-02T00:00:00Z', 'impM7-' + i, 'useful', '', 't'].join('\t'));
      labels6.push(['2026-04-02T00:00:00Z', 'impM7-29', 'noise', '', 't'].join('\t'));
      fs.writeFileSync(path.join(T6, 'labels-' + HOST + '.tsv'), labels6.join('\n') + '\n');
      r = run6(['--report', '--json']);
      out = JSON.parse(r.stdout || '{}');
      const unknownGroup = (out.by_class || []).find((c) => c.key === '(unknown)');
      report('MEDIUM-7: report never contains a literal "(unknown)" by_class key', !unknownGroup, JSON.stringify((out.by_class || []).map((c) => c.key)));
      const derivedGroup = (out.by_class || []).find((c) => c.key === 'process:pipe-hides-exit-code-and-truncates-evidence (pre-class_tag)');
      report('MEDIUM-7: 30 old empty-class_tag gate-A rows bucket under "<tag> (pre-class_tag)"', !!derivedGroup && derivedGroup.exposures === 30, JSON.stringify(derivedGroup));
      report('MEDIUM-7: that bucket clears the Wilson gate (29/30 useful) -> status=PASS', !!derivedGroup && derivedGroup.status === 'PASS', JSON.stringify(derivedGroup));
      const naGroup = (out.by_class || []).find((c) => c.key === '(n/a)');
      report('MEDIUM-7: the genuinely-unattributable row lands in a SEPARATE (n/a) bucket, not merged with (pre-class_tag)', !!naGroup && naGroup.exposures === 1, JSON.stringify(naGroup));
      const textOut6 = run6(['--report']).stdout;
      report('MEDIUM-7: text report never prints the literal "(unknown)" anywhere', !/\(unknown\)/.test(textOut6), textOut6);
      fs.rmSync(T6, { recursive: true, force: true });
    }

    // ---- read-only guarantee -----------------------------------------------------------------------
    const before = fs.readdirSync(T).sort();
    run(['--report', '--json']);
    const after = fs.readdirSync(T).sort();
    report('read-only: directory listing unchanged after report runs', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));

    // ---- B3 / P05: --unlock <class_tag> --gate <A|B|D> (v2.19, 契约 conventions.policy_file /
    // M-SPEC 附录 B3 补注 #2) --------------------------------------------------------------------
    // "against a synthetic labels file with 24/30 useful exits 2 and leaves policy.json unchanged;
    //  with 29/30 useful it writes randomized with unlocked_by and lower95" (test-contract P05),
    // now scoped to a (class_tag, gate) pair rather than the class-wide marginal.
    function m0RowFor(kind, sid, tool, trig, cls, impId, evId, ts) {
      return ['1', ts, sid, tool, '', '', '', '0', kind, trig, cls, 'posix', '0', 'tail', '',
        'ok', 'aaaa', '1.1', impId, evId, '0', '0'].join('\t');
    }
    function runIn(root, args) {
      const env = Object.assign({}, process.env, { PMM_RECALL_ROOT: root, PMM_RECALL_HOST: HOST });
      return spawnSync(process.execPath, [__filename].concat(args), { env, encoding: 'utf8' });
    }

    // 24/30 useful, gate A -> below the Wilson gate -> refused, rc 2, policy.json untouched.
    {
      const U1 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-unlock24-'));
      const rows = [];
      for (let i = 0; i < 30; i++) rows.push(m0RowFor('would-warn', 'su' + i, 'tu' + i, 'A', 'class:unlock24', 'impU24-' + i, 'evU24-' + i, '2026-03-01T00:00:00Z'));
      fs.writeFileSync(path.join(U1, 'impressions-' + HOST + '.tsv'), rows.join('\n') + '\n');
      const labelLines = [];
      for (let i = 0; i < 24; i++) labelLines.push(['2026-03-02T00:00:00Z', 'impU24-' + i, 'useful', '', 't'].join('\t'));
      for (let i = 24; i < 30; i++) labelLines.push(['2026-03-02T00:00:00Z', 'impU24-' + i, 'noise', '', 't'].join('\t'));
      fs.writeFileSync(path.join(U1, 'labels-' + HOST + '.tsv'), labelLines.join('\n') + '\n');
      const policyFileBefore = fs.existsSync(path.join(U1, 'policy.json'));
      const r24 = runIn(U1, ['--unlock', 'class:unlock24', '--gate', 'A']);
      report('P05: --unlock --gate A with 24/30 useful exits rc 2', r24.status === 2, 'status=' + r24.status + ' stderr=' + r24.stderr);
      const policyFileAfter = fs.existsSync(path.join(U1, 'policy.json'));
      report('P05: --unlock --gate A with 24/30 useful leaves policy.json unwritten (still absent)', policyFileBefore === false && policyFileAfter === false, 'before=' + policyFileBefore + ' after=' + policyFileAfter);
      fs.rmSync(U1, { recursive: true, force: true });
    }

    // 29/30 useful, gate A -> clears the Wilson gate -> writes gates.A=randomized + lower95_by_gate.A.
    {
      const U2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-unlock29-'));
      const rows = [];
      for (let i = 0; i < 30; i++) rows.push(m0RowFor('would-warn', 'sv' + i, 'tv' + i, 'A', 'class:unlock29', 'impU29-' + i, 'evU29-' + i, '2026-03-01T00:00:00Z'));
      fs.writeFileSync(path.join(U2, 'impressions-' + HOST + '.tsv'), rows.join('\n') + '\n');
      const labelLines = [];
      for (let i = 0; i < 29; i++) labelLines.push(['2026-03-02T00:00:00Z', 'impU29-' + i, 'useful', '', 't'].join('\t'));
      labelLines.push(['2026-03-02T00:00:00Z', 'impU29-29', 'noise', '', 't'].join('\t'));
      fs.writeFileSync(path.join(U2, 'labels-' + HOST + '.tsv'), labelLines.join('\n') + '\n');
      const r29 = runIn(U2, ['--unlock', 'class:unlock29', '--gate', 'A']);
      report('P05: --unlock --gate A with 29/30 useful exits rc 0', r29.status === 0, 'status=' + r29.status + ' stdout=' + r29.stdout + ' stderr=' + r29.stderr);
      // LOW-2 (2026-09-17, fab blind attack): the write is temp-file + rename, never a direct
      // writeFileSync onto policy.json itself -- after a successful --unlock, no .tmp-* sibling file
      // should remain in the root (rename either lands the finished write or the whole op fails
      // before ever reaching policy.json's own path).
      const rootEntries = fs.readdirSync(U2);
      report('LOW-2: no leftover .tmp-* file after a successful --unlock write', !rootEntries.some((f) => /^policy\.json\.tmp-/.test(f)), JSON.stringify(rootEntries));
      let policy = null;
      try { policy = JSON.parse(fs.readFileSync(path.join(U2, 'policy.json'), 'utf8')); } catch (e) { /* leave null */ }
      const entry29 = policy && policy['class:unlock29'];
      report('P05: policy.json written with mode=randomized for class:unlock29', !!entry29 && entry29.mode === 'randomized', JSON.stringify(policy));
      report('P05: policy.json gates.A=randomized', !!entry29 && entry29.gates && entry29.gates.A === 'randomized', JSON.stringify(policy));
      report('P05: policy.json carries unlocked_by (non-empty string)', !!entry29 && typeof entry29.unlocked_by === 'string' && entry29.unlocked_by.length > 0, JSON.stringify(policy));
      report('P05: policy.json carries lower95_by_gate.A > 0.80', !!entry29 && entry29.lower95_by_gate && typeof entry29.lower95_by_gate.A === 'number' && entry29.lower95_by_gate.A > 0.80, JSON.stringify(policy));
      report('P05: policy.json carries unlocked_at (non-empty string)', !!entry29 && typeof entry29.unlocked_at === 'string' && entry29.unlocked_at.length > 0, JSON.stringify(policy));

      // second unlock, SAME class but gate B -> gates accumulate (A stays randomized, B added), does
      // not clobber gate A's own lower95_by_gate.A.
      const rowsB = [];
      for (let i = 0; i < 30; i++) rowsB.push(m0RowFor('would-warn', 'sb' + i, 'tb' + i, 'B', 'class:unlock29', 'impU29B-' + i, 'evU29B-' + i, '2026-03-01T00:00:00Z'));
      fs.appendFileSync(path.join(U2, 'impressions-' + HOST + '.tsv'), rowsB.join('\n') + '\n');
      const labelLinesB = [];
      for (let i = 0; i < 29; i++) labelLinesB.push(['2026-03-02T00:00:00Z', 'impU29B-' + i, 'useful', '', 't'].join('\t'));
      labelLinesB.push(['2026-03-02T00:00:00Z', 'impU29B-29', 'noise', '', 't'].join('\t'));
      fs.appendFileSync(path.join(U2, 'labels-' + HOST + '.tsv'), labelLinesB.join('\n') + '\n');
      runIn(U2, ['--unlock', 'class:unlock29', '--gate', 'B']);
      let policyAfterB = null;
      try { policyAfterB = JSON.parse(fs.readFileSync(path.join(U2, 'policy.json'), 'utf8')); } catch (e) { /* leave null */ }
      const entryAfterB = policyAfterB && policyAfterB['class:unlock29'];
      report('P05: unlocking gate B of the SAME class accumulates (gates.A AND gates.B both randomized)',
        !!entryAfterB && entryAfterB.gates && entryAfterB.gates.A === 'randomized' && entryAfterB.gates.B === 'randomized', JSON.stringify(policyAfterB));
      report('P05: gate A\'s own lower95_by_gate.A is preserved (not clobbered by the gate B unlock)',
        !!entryAfterB && entryAfterB.lower95_by_gate && typeof entryAfterB.lower95_by_gate.A === 'number' && entryAfterB.lower95_by_gate.A > 0.80, JSON.stringify(policyAfterB));

      // idempotent unlock of a DIFFERENT class must not disturb class:unlock29's existing entry
      const rows2 = [];
      for (let i = 0; i < 30; i++) rows2.push(m0RowFor('would-warn', 'sw' + i, 'tw' + i, 'A', 'class:unlock29b', 'impU29b-' + i, 'evU29b-' + i, '2026-03-01T00:00:00Z'));
      fs.appendFileSync(path.join(U2, 'impressions-' + HOST + '.tsv'), rows2.join('\n') + '\n');
      const labelLines2 = [];
      for (let i = 0; i < 29; i++) labelLines2.push(['2026-03-02T00:00:00Z', 'impU29b-' + i, 'useful', '', 't'].join('\t'));
      labelLines2.push(['2026-03-02T00:00:00Z', 'impU29b-29', 'noise', '', 't'].join('\t'));
      fs.appendFileSync(path.join(U2, 'labels-' + HOST + '.tsv'), labelLines2.join('\n') + '\n');
      runIn(U2, ['--unlock', 'class:unlock29b', '--gate', 'A']);
      let policy2 = null;
      try { policy2 = JSON.parse(fs.readFileSync(path.join(U2, 'policy.json'), 'utf8')); } catch (e) { /* leave null */ }
      report('P05: unlocking a second class preserves the first class\'s existing entry',
        !!policy2 && policy2['class:unlock29'] && policy2['class:unlock29'].mode === 'randomized' &&
        policy2['class:unlock29b'] && policy2['class:unlock29b'].mode === 'randomized', JSON.stringify(policy2));

      fs.rmSync(U2, { recursive: true, force: true });
    }

    // unknown class_tag (zero exposures at all), gate A -> refused, rc 2
    {
      const U3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-unlock-unknown-'));
      const r = runIn(U3, ['--unlock', 'class:never-seen', '--gate', 'A']);
      report('P05: --unlock --gate A on a class with zero exposures -> rc 2', r.status === 2, 'status=' + r.status);
      fs.rmSync(U3, { recursive: true, force: true });
    }

    // coordinator correction (2026-09-17 11:10, 契约 v2.19): missing --gate -> rc 2 usage error,
    // policy.json untouched, even when the class itself would otherwise clear the gate.
    {
      const U4 = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-unlock-nogate-'));
      const rows = [];
      for (let i = 0; i < 30; i++) rows.push(m0RowFor('would-warn', 'sn' + i, 'tn' + i, 'A', 'class:nogate', 'impNG-' + i, 'evNG-' + i, '2026-03-01T00:00:00Z'));
      fs.writeFileSync(path.join(U4, 'impressions-' + HOST + '.tsv'), rows.join('\n') + '\n');
      const labelLines = [];
      for (let i = 0; i < 30; i++) labelLines.push(['2026-03-02T00:00:00Z', 'impNG-' + i, 'useful', '', 't'].join('\t'));
      fs.writeFileSync(path.join(U4, 'labels-' + HOST + '.tsv'), labelLines.join('\n') + '\n');
      const policyFileBefore = fs.existsSync(path.join(U4, 'policy.json'));
      const rNoGate = runIn(U4, ['--unlock', 'class:nogate']); // no --gate at all
      report('v2.19: --unlock without --gate -> rc 2 usage error (even though 30/30 useful would otherwise pass)',
        rNoGate.status === 2, 'status=' + rNoGate.status + ' stderr=' + rNoGate.stderr);
      const rBadGate = runIn(U4, ['--unlock', 'class:nogate', '--gate', 'Z']); // invalid gate name
      report('v2.19: --unlock --gate Z (not A/B/D) -> rc 2 usage error', rBadGate.status === 2, 'status=' + rBadGate.status);
      const policyFileAfter = fs.existsSync(path.join(U4, 'policy.json'));
      report('v2.19: missing/invalid --gate never writes policy.json', policyFileBefore === false && policyFileAfter === false, 'before=' + policyFileBefore + ' after=' + policyFileAfter);
      fs.rmSync(U4, { recursive: true, force: true });
    }

    // ---- 20. LOW-K2 (2026-09-17, codex second wave / Opus reproduction): PMM_RECALL_ROOT=' '
    // (whitespace-only) must resolve to the SAME directory a WRITER (via ledger.resolveRoot()) would
    // use -- never a literal ' ' path, which would make --report read an empty directory and report
    // all-zero SILENTLY (no error) even though the writer's data is sitting right there in the real
    // default. Verified two ways: (a) this module's own resolveRoot() is a direct re-export of the
    // ledger's, so a pure computation check proves they agree; (b) end-to-end: HOME/USERPROFILE
    // redirected to a temp dir, a ledger row placed at the resulting default root exactly as a real
    // writer would leave it, --report run with PMM_RECALL_ROOT=' ' actually finds it (not all-zero).
    {
      const before = process.env.PMM_RECALL_ROOT;
      process.env.PMM_RECALL_ROOT = ' ';
      try {
        const fromHere = resolveRoot();
        const fromLedger = ledger.resolveRoot();
        report('20a. LOW-K2: PMM_RECALL_ROOT=\' \' -> resolveRoot() here is never the literal whitespace', fromHere !== ' ', JSON.stringify(fromHere));
        report('20b. LOW-K2: PMM_RECALL_ROOT=\' \' -> resolveRoot() here === ledger.resolveRoot() (same resolver)', fromHere === fromLedger, JSON.stringify({ fromHere, fromLedger }));
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
      const dataRow = ['1', '2026-01-01T00:00:00.000Z', 's', 'a', '', '', 'tu', 'impLowk2', 'evLowk2', 'eligible',
        '', '', 'class:lowk2', 'trigLowk2', '', '', 'intervene', 'policy:absent', '0', '0', '0'].join('\t');
      fs.writeFileSync(path.join(expectedDefaultRoot, 'events-v3-' + os.hostname() + '.tsv'), V3_COLUMNS.join('\t') + '\n' + dataRow + '\n');
      const env2 = Object.assign({}, process.env, { PMM_RECALL_ROOT: ' ', HOME: fakeHome, USERPROFILE: fakeHome });
      delete env2.PMM_RECALL_HOST; // force this tool's own resolveHost() to fall back to the real os.hostname(), matching the file name written above
      const r = spawnSync(process.execPath, [__filename, '--report', '--json'], { env: env2, encoding: 'utf8' });
      const out = JSON.parse(r.stdout || '{}');
      const classLowk2 = (out.by_class || []).find((c) => c.key === 'class:lowk2');
      report('20c. LOW-K2 end-to-end: --report with whitespace root + redirected HOME finds the writer\'s data (NOT silently all-zero)', !!classLowk2 && classLowk2.exposures === 1, JSON.stringify(out.by_class));
    }

    // ---- 21. LOW-K2-followup (2026-09-17, coordinator: real-ledger contamination incident):
    // history rows with id_missing='1' or blank sid_sha16 (the confirmed, cross-validated marker for
    // the real pmm-trigger-recall.sh leak) must never count as an exposure, and excluded_contaminated
    // must report how many such rows were excluded.
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-precision-contam-'));
      function m0RowRaw(sid, tool, trig, cls, impId, evId, ts, idMissing) {
        return ['1', ts, sid, tool, '', '', '', '0', 'eligible', trig, cls, 'posix', '0', 'tail', '',
          'ok', 'aaaa', '1.1', impId, evId, idMissing, '0'].join('\t');
      }
      const rows = [
        m0RowFor('eligible', 'sClean', 'tClean', 'triggerClean', 'class:clean', 'impClean', 'evClean', '2026-04-01T00:00:00Z'),
        // contaminated: id_missing=1, shaped exactly like the leaked pmm-trigger-recall.sh fixture rows
        m0RowRaw('sContam', 'tContam', 'test:trig-alpha', 'test:trig-alpha', '', 'evContam1', '2026-04-01T00:00:01Z', '1'),
        // contaminated: blank sid_sha16 (independent forward-looking marker)
        m0RowRaw('', 'tBlank', 'triggerBlankSid', 'class:blanksid', 'impBlank', 'evContam2', '2026-04-01T00:00:02Z', '0'),
      ];
      fs.writeFileSync(path.join(root, 'impressions-' + HOST + '.tsv'), rows.join('\n') + '\n');
      const r = runIn(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      report('21a. excluded_contaminated=2 (1 id_missing=1 row + 1 blank-sid row)', out.excluded_contaminated === 2, JSON.stringify(out.excluded_contaminated));
      const contamTrig = (out.by_trigger || []).find((t) => t.key === 'test:trig-alpha');
      report('21b. the contaminated test:trig-alpha trigger never appears in by_trigger at all', !contamTrig, JSON.stringify(out.by_trigger));
      const blankSidTrig = (out.by_trigger || []).find((t) => t.key === 'triggerBlankSid');
      report('21c. the blank-sid triggerBlankSid trigger never appears in by_trigger either', !blankSidTrig, JSON.stringify(out.by_trigger));
      const cleanTrig = (out.by_trigger || []).find((t) => t.key === 'triggerClean');
      report('21d. the clean triggerClean trigger is unaffected, exposures=1', !!cleanTrig && cleanTrig.exposures === 1, JSON.stringify(cleanTrig));
      const rText = runIn(root, ['--report']);
      report('21e. text mode also prints excluded_contaminated=2 near the top', /excluded_contaminated=2/.test(rText.stdout), rText.stdout.slice(0, 200));
      fs.rmSync(root, { recursive: true, force: true });
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
  if (opts.unlock) return doUnlock(opts.unlock, opts.gate, opts);
  if (!opts.report) {
    console.error('usage: pmm-recall-precision.cjs --report [--json] [--source v3|m0] | --unlock <class_tag> --gate <A|B|D>');
    return 1;
  }
  const rep = buildReport(opts);
  if (opts.json) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    console.log(formatText(rep));
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { wilsonLowerBound, resolveRoot, resolveHost, detectSource, readLedgerRows,
  dedupByEventId, aggregateImpressions, isMatchedRow, readLabelsMap, currentLabelOf,
  computeGroupStats, buildReport, WILSON_Z_ONE_SIDED_95, STOP_N, policyPath, readPolicy, doUnlock,
  computeGateStats, GATE_NAMES };
