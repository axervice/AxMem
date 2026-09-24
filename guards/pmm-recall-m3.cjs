#!/usr/bin/env node
// pmm-recall-m3.cjs — M3 randomized-intervention analysis: `--report [--json]`.
//
// guards/specs/RECALL-LOOP-M-SPEC-v2.md M3 section + 附录 B3 (2026-09-17):
//   "分析单位 session x class;t0 = 首次 eligible;两臂各自的「窗口内复发」比例与首次复发时间;
//    样本量预注册表(50->25%:58/组;30->15%:121;20->10%:199)未达 => 输出 UNKNOWN,达标才给差值
//    与区间;同会话聚类用 session 层 bootstrap;永不输出「显著有效」四字以外的措辞(只输出数字与
//    区间)。"
// 附录 A: 观察窗终止 = 同 (session, agent) 后续 20 行 'observed',或一行 'session-end'; 两者都没有
// 的会话记为 window-open,不进分析。分析单位仍为 session x class;agent_* 列只做分层与过滤 —— 这里
// 用 t0 那一行的 (sid_sha16, agent_sha16) 决定该单位的观察窗状态（一个 session 内即使有多个 agent,
// 决定"这次曝光的窗口有没有关完"的是曝光发生时那个 agent 的后续事件流）。
//
// READ-ONLY: this tool writes nothing, ever. It does not implement the intervene/shadow assignment
// function (that lives in the Bash pipe gate itself, per 附录 B3's own "分配函数" section — out of
// this tool's file scope) — it only reads whatever `mode` column value the gate already wrote and
// groups by it.
//
// event_kind='recurrence' rows: this build found no current PRODUCTION writer of that exact kind
// (the pipe gate's `confidence` column carries the string 'recurrence' on individual findings, but
// no code path emits a ledger row whose event_kind itself is 'recurrence' yet — grep-verified against
// bash-pipe-exitcode-watch.cjs during this build). Per this build's "spec 不明处...不自行扩大范围"
// discipline, this tool does NOT invent its own heuristic redefinition of "recurrence" (e.g. treating
// a second 'eligible' row as an implicit recurrence) — it reads literally for event_kind='recurrence'
// rows, matching M-SPEC's own B4 status line for M3 ("待建 + 等数据": analysis tool ships now, real
// recurrence rows accumulate later from whichever writer M-SPEC assigns that to). The self-test
// verifies the ANALYSIS is correct by writing synthetic 'recurrence' rows directly.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
// pmm-recall-ledger.cjs (2026-09-17, codex LOW-K2 / Opus reproduction): resolveRoot() is required
// from there, not reimplemented here. The write side already converged onto ledger.resolveRoot() in
// an earlier round (LOW-5); this read side still carried its own un-normalized copy
// (`process.env.PMM_RECALL_ROOT || default`, no trim), so PMM_RECALL_ROOT=' ' made a WRITER land on
// the real default directory while THIS tool's --report read from a literal whitespace-named
// directory -- silently all-zero output, never an error.
const ledger = require('./pmm-recall-ledger.cjs');

// ---------------------------------------------------------------------------------------------
// Shared reading layer (duplicated across the M1/M2/M3 tools, same rationale as
// pmm-recall-queue.cjs's own header comment; resolveRoot() is the one exception -- LOW-K2 requires
// calling the ledger's, not reimplementing it).
// ---------------------------------------------------------------------------------------------

const V3_COLUMNS = ['schema_version', 'ts', 'sid_sha16', 'agent_sha16', 'agent_type', 'prompt_id',
  'tool_use_id', 'impression_id', 'event_id', 'event_kind', 'gate', 'confidence', 'class_tag',
  'trigger_or_gate_id', 'cmd_sha16', 'parser_version', 'mode', 'run_provenance', 'sanitized',
  'id_missing', 'agent_id_missing'];

const WINDOW_OBSERVED_THRESHOLD = 20;

// Pre-registered sample size table (M-SPEC 附录 B3, verbatim). MIN_N_PER_ARM is the smallest row
// (the floor below which even the largest hypothesized effect cannot be resolved); the report always
// prints the full table alongside which row(s), if any, the observed per-arm n actually clears, but
// the UNKNOWN/numeric gate itself uses MIN_N_PER_ARM (documented choice — spec text lists three rows
// without picking one for the go/no-go switch; see build report for the reasoning).
const SAMPLE_SIZE_TABLE = [
  { effect: '50%->25%', n_per_arm: 58 },
  { effect: '30%->15%', n_per_arm: 121 },
  { effect: '20%->10%', n_per_arm: 199 },
];
const MIN_N_PER_ARM = SAMPLE_SIZE_TABLE[0].n_per_arm;

const BOOTSTRAP_ITERATIONS = 2000;
const SEED_SEP = String.fromCharCode(1); // NUL-like join separator for deterministic seed strings

// 2026-09-17 前空值回填规则 (M-SPEC 附录 B3 补注 #2 / 契约 v2.19 gate_row_class_tag, coordinator
// correction): gate rows written before the v2.19 fix carry class_tag='' even though
// trigger_or_gate_id is A/B/D (the production ledger had 1019 such rows) -- all three gates
// implement the single lesson process:pipe-hides-exit-code-and-truncates-evidence. This matters for
// computeUnitOutcome()'s recurrence matching: an M0/B1-eligible-triggered unit whose class IS that
// lesson tag (the M0 shadow-only cmd trigger seeded on it) must still see an OLD, un-backfilled gate
// row as a same-class recurrence signal. Read-side only: the ledger file itself is never rewritten.
const GATE_ROW_KINDS = new Set(['A', 'B', 'D']);
const GATE_ROW_CLASS_TAG = 'process:pipe-hides-exit-code-and-truncates-evidence';
function backfillGateClassTag(row) {
  if (row.class_tag === '' && GATE_ROW_KINDS.has(row.trigger_or_gate_id)) row.class_tag = GATE_ROW_CLASS_TAG;
  return row;
}

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
// the confirmed, empirically-validated marker for the pmm-trigger-recall.sh self-test rows that
// repeatedly leaked into the real production ledger (root-caused and fixed at the source -- that
// script's self-test cases 1-17 never set PMM_RECALL_ROOT nor redirected HOME, so every invocation
// via guard-canary.sh's roster line `run "pmm-trigger-recall 自证" bash ".../pmm-trigger-recall.sh"
// --self-test` landed real 21-column rows in the genuine default ledger across many rounds of this
// conversation's history). Cross-validated against the full real ledger (572 rows, 10 distinct
// synthetic session sids, event_kind breakdown eligible=286/displayed=260/suppressed=26): every
// single id_missing=1 row is a confirmed test:*/class:alpha fixture and every confirmed fixture row
// has id_missing=1 -- zero false positives, zero false negatives; a coincidental 2-row sid the
// coordinator also flagged (would-warn/gate=A, id_missing=0) was investigated and confirmed to be
// unrelated real production data, correctly left OUT of this filter. The blank-sid_sha16 leg is an
// independent, forward-looking net (mirrors the write-side isPoisonedSid() guard in pmm-recall-
// ledger.cjs). This is a HISTORY filter only -- it never rewrites/deletes the ledger file itself
// (append-only, per M-SPEC); it only excludes such rows from THIS tool's analysis, reporting how
// many were excluded via the top-level `excluded_contaminated` field.
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

function tsMs(ts) {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------------------------
// Observation-window index (same construction as pmm-recall-baseline.cjs).
// ---------------------------------------------------------------------------------------------

function sessAgentKey(r) { return (r.sid_sha16 || '') + '' + (r.agent_sha16 || ''); }

function buildSessAgentIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const k = sessAgentKey(r);
    let e = idx.get(k);
    if (!e) { e = { observedMs: [], sessionEndMs: null }; idx.set(k, e); }
    if (r.event_kind === 'observed') { const t = tsMs(r.ts); if (t !== null) e.observedMs.push(t); }
    if (r.event_kind === 'session-end') { const t = tsMs(r.ts); e.sessionEndMs = t !== null ? t : Infinity; }
  }
  for (const e of idx.values()) e.observedMs.sort((a, b) => a - b);
  return idx;
}

// windowInfo(t0Row, idx): { closed: bool, closeMs: number|null } — closeMs is the timestamp at which
// the window is proven closed (the 20th later 'observed' row, or the session-end row's ts), used as
// the upper bound for "did a recurrence happen WITHIN the window".
function windowInfo(t0Row, idx) {
  const e = idx.get(sessAgentKey(t0Row));
  const t0Ms = tsMs(t0Row.ts);
  if (!e || t0Ms === null) return { closed: false, closeMs: null };
  if (e.sessionEndMs !== null) return { closed: true, closeMs: e.sessionEndMs };
  const later = e.observedMs.filter((om) => om > t0Ms);
  if (later.length >= WINDOW_OBSERVED_THRESHOLD) return { closed: true, closeMs: later[WINDOW_OBSERVED_THRESHOLD - 1] };
  return { closed: false, closeMs: null };
}

// ---------------------------------------------------------------------------------------------
// Units: session x class. t0 = earliest 'eligible' row for (sid_sha16, class_tag).
// ---------------------------------------------------------------------------------------------

// unitKey (2026-09-17, M-SPEC 附录 B 补注 #5 / fab blind attack item 3 / Opus reproduction): a unit
// used to be keyed by (sid_sha16, class_tag) alone. A main session and a sub-agent sharing the SAME
// session_id (Claude Code sub-agent sessions do) produce the SAME sid_sha16, so they collapsed onto
// ONE unit -- whichever of the two had the earlier eligible row "won" t0 and the other's eligible
// row(s) for that class were silently never their own unit at all (not double-counted, just erased).
// Keyed by (sid_sha16, agent_sha16, class_tag) now, aligned with sessAgentKey()'s own window-index
// grouping above (same three-field identity, NUL-joined via ledger.NUL like ledger.impressionId()/
// eventId() already do elsewhere, avoiding a bare-concatenation collision between e.g.
// sid="ab"+cls="c" and sid="a"+cls="bc"). A main-session row with agent_sha16='' (the common case --
// no sub-agent involved) keeps its OLD effective key shape once NUL-joined with an empty agent
// segment, so a class with no sub-agent activity forms the exact same units as before.
function unitKey(sid, agent, cls) { return (sid || '') + ledger.NUL + (agent || '') + ledger.NUL + (cls || ''); }

// isPolicyRandomizedRow (Opus review, 2026-09-17, LOW-H5): a class that was NEVER randomized always
// defaults its eligible rows to mode='intervene' (MEDIUM-6's own "行为不变" default), which is not a
// randomized arm at all -- it never had a chance to land on shadow. Counting those rows into
// n_intervene would silently inflate the intervene arm's denominator with units that were never part
// of the experiment. Only an eligible row whose run_provenance actually contains 'policy:randomized'
// (written by policy.resolve() when the class's policy.json mode==='randomized', regardless of which
// arm the coin-flip picked) may seed a t0/unit.
function isPolicyRandomizedRow(r) {
  return typeof r.run_provenance === 'string' && r.run_provenance.indexOf('policy:randomized') !== -1;
}

function buildUnits(dedupedRows) {
  const t0Map = new Map();
  for (const r of dedupedRows) {
    if (r.event_kind !== 'eligible' || !r.class_tag || !r.sid_sha16) continue;
    if (!isPolicyRandomizedRow(r)) continue; // LOW-H5: never seed a unit from a non-randomized eligible row
    const ms = tsMs(r.ts);
    if (ms === null) continue;
    const k = unitKey(r.sid_sha16, r.agent_sha16, r.class_tag);
    const cur = t0Map.get(k);
    if (!cur || ms < cur.ms) t0Map.set(k, { key: k, sid: r.sid_sha16, agent: r.agent_sha16 || '', cls: r.class_tag, row: r, ms });
  }
  return t0Map;
}

// findUnrandomizedUnits (LOW-H5): (session, class) pairs that have >=1 eligible row but NONE with
// policy:randomized provenance -- these never had a chance at a randomized arm and must never be
// silently dropped without a trace; counted so the report can show them per class as "unrandomized,
// not counted" instead of just vanishing from the numbers.
function findUnrandomizedUnits(dedupedRows, t0Map) {
  const seenClassOf = new Map(); // unit key -> class_tag, for every (session,class) with >=1 eligible row
  for (const r of dedupedRows) {
    if (r.event_kind !== 'eligible' || !r.class_tag || !r.sid_sha16) continue;
    const k = unitKey(r.sid_sha16, r.agent_sha16, r.class_tag);
    if (!seenClassOf.has(k)) seenClassOf.set(k, r.class_tag);
  }
  const out = [];
  for (const [k, cls] of seenClassOf) {
    if (!t0Map.has(k)) out.push({ key: k, cls });
  }
  return out;
}

// isPrimaryRecurrenceSignal / isSecondaryRecurrenceSignal (Opus review, 2026-09-17, "B3 主次结局分开"):
// M-SPEC 附录 B3 补注's original single definition conflated a CONFIRMED recurrence (confidence=
// 'recurrence', from an A hit or a D recurrence with receipt evidence) with a no-evidence D
// CANDIDATE (event_kind/confidence='recurrence-candidate'). Folding the candidate into the headline
// number raises both arms' noise floor equally and compresses the measured effect size -- so the two
// are now reported as separate outcomes: PRIMARY = confirmed only; SECONDARY (sensitivity) = PRIMARY
// union candidate. A literal event_kind='recurrence' row (no production writer emits one yet) counts
// as PRIMARY too (defensive OR branch, same rationale as the original B3 addendum).
function isPrimaryRecurrenceSignal(r) {
  return r.confidence === 'recurrence' || r.event_kind === 'recurrence';
}
function isSecondaryRecurrenceSignal(r) {
  return isPrimaryRecurrenceSignal(r) || r.confidence === 'recurrence-candidate' || r.event_kind === 'recurrence-candidate';
}

function computeUnitOutcome(unit, dedupedRows, idx) {
  const win = windowInfo(unit.row, idx);
  const arm = unit.row.mode || '';
  if (!win.closed) return { key: unit.key, sid: unit.sid, cls: unit.cls, arm, included: false };
  const t0AgentSha = unit.row.agent_sha16 || '';
  const t0ToolUseId = unit.row.tool_use_id || '';
  let recurredPrimary = false, firstPrimaryMs = null;
  let recurredSecondary = false, firstSecondaryMs = null;
  for (const r of dedupedRows) {
    if (r.sid_sha16 !== unit.sid || (r.agent_sha16 || '') !== t0AgentSha || r.class_tag !== unit.cls) continue;
    if ((r.tool_use_id || '') === t0ToolUseId) continue; // 同一 tool event 不算注入后复发 (M-SPEC)
    const ms = tsMs(r.ts);
    if (ms === null) continue;
    if (ms <= unit.ms || ms > win.closeMs) continue; // must be after t0 and within the window
    if (isPrimaryRecurrenceSignal(r) && (!recurredPrimary || ms < firstPrimaryMs)) { recurredPrimary = true; firstPrimaryMs = ms; }
    if (isSecondaryRecurrenceSignal(r) && (!recurredSecondary || ms < firstSecondaryMs)) { recurredSecondary = true; firstSecondaryMs = ms; }
  }
  return { key: unit.key, sid: unit.sid, cls: unit.cls, arm, included: true,
    recurred_primary: recurredPrimary, first_recurrence_delta_ms_primary: recurredPrimary ? (firstPrimaryMs - unit.ms) : null,
    recurred_secondary: recurredSecondary, first_recurrence_delta_ms_secondary: recurredSecondary ? (firstSecondaryMs - unit.ms) : null,
    // backward-compat aliases: the unqualified name always means PRIMARY (the headline outcome).
    recurred: recurredPrimary, first_recurrence_delta_ms: recurredPrimary ? (firstPrimaryMs - unit.ms) : null };
}

// ---------------------------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32) for the session-level bootstrap — same input data always
// yields the same reported interval (reproducibility), without depending on Math.random().
// ---------------------------------------------------------------------------------------------

function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// key: which outcome field to resample on ('recurred_primary' | 'recurred_secondary'); defaults to
// 'recurred' (= primary) for any caller that predates the primary/secondary split.
function bootstrapDiffCI(interveneOutcomes, shadowOutcomes, iterations, seed, key) {
  const k = key || 'recurred';
  const rng = mulberry32(seed);
  function resampleRate(arr) {
    const n = arr.length;
    let hits = 0;
    for (let i = 0; i < n; i++) { const idx = Math.floor(rng() * n); if (arr[idx][k]) hits++; }
    return hits / n;
  }
  const diffs = [];
  for (let i = 0; i < iterations; i++) {
    diffs.push(resampleRate(interveneOutcomes) - resampleRate(shadowOutcomes));
  }
  diffs.sort((a, b) => a - b);
  const lo = diffs[Math.floor(0.025 * diffs.length)];
  const hi = diffs[Math.min(diffs.length - 1, Math.ceil(0.975 * diffs.length) - 1)];
  return { lower: lo, upper: hi };
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

function rate(outcomes, key) {
  const k = key || 'recurred';
  if (!outcomes.length) return null;
  return outcomes.filter((o) => o[k]).length / outcomes.length;
}

function buildReport() {
  const root = resolveRoot();
  const host = resolveHost();
  const ledger = readV3Rows(root, host);
  const dedup = dedupByEventId(ledger.rows);
  const cleanRows = [], excludedRows = [];
  for (const r of dedup.rows) (isContaminatedRow(r) ? excludedRows : cleanRows).push(r);
  const idx = buildSessAgentIndex(cleanRows);
  const t0Map = buildUnits(cleanRows);
  const outcomes = Array.from(t0Map.values()).map((u) => computeUnitOutcome(u, cleanRows, idx));

  // LOW-H5: units whose only eligible row(s) were never policy:randomized (absent/shadow/corrupt)
  // never made it into t0Map/outcomes at all -- counted here so they show up per class instead of
  // silently vanishing.
  const unrandomizedByClass = new Map();
  for (const u of findUnrandomizedUnits(cleanRows, t0Map)) {
    unrandomizedByClass.set(u.cls, (unrandomizedByClass.get(u.cls) || 0) + 1);
  }

  const byClass = new Map();
  for (const o of outcomes) {
    if (!byClass.has(o.cls)) byClass.set(o.cls, []);
    byClass.get(o.cls).push(o);
  }

  const classes = Array.from(new Set(Array.from(byClass.keys()).concat(Array.from(unrandomizedByClass.keys())))).sort();
  const classReports = classes.map((cls) => {
    const all = byClass.get(cls) || []; // LOW-H5: a class with ONLY unrandomized units has no entry here
    const included = all.filter((o) => o.included);
    const windowOpen = all.length - included.length;
    const intervene = included.filter((o) => o.arm === 'intervene');
    const shadow = included.filter((o) => o.arm === 'shadow');
    const otherArm = included.filter((o) => o.arm !== 'intervene' && o.arm !== 'shadow');
    const n_intervene = intervene.length, n_shadow = shadow.length;
    const sampleSizeCleared = SAMPLE_SIZE_TABLE.filter((s) => n_intervene >= s.n_per_arm && n_shadow >= s.n_per_arm).map((s) => s.effect);
    const meetsMin = n_intervene >= MIN_N_PER_ARM && n_shadow >= MIN_N_PER_ARM;
    const status = meetsMin ? 'PASS' : 'UNKNOWN';
    // Opus review "B3 zhu ci jie ju fen kai": primary (confirmed-only) and secondary (primary union
    // candidate, a sensitivity check) are computed and reported SEPARATELY -- folding candidate into
    // primary would raise both arms' noise floor equally and compress the measured effect size.
    function outcomeBlock(key, label) {
      let diff = null, ci95 = null, rate_intervene = null, rate_shadow = null;
      if (meetsMin) {
        rate_intervene = rate(intervene, key);
        rate_shadow = rate(shadow, key);
        diff = rate_intervene - rate_shadow;
        const seed = seedFromString([cls, label, n_intervene, n_shadow].join(SEED_SEP));
        ci95 = bootstrapDiffCI(intervene, shadow, BOOTSTRAP_ITERATIONS, seed, key);
      }
      return { status, rate_intervene, rate_shadow, diff, ci95 };
    }
    const primary = outcomeBlock('recurred_primary', 'primary');
    const secondary = outcomeBlock('recurred_secondary', 'secondary');
    return {
      class_tag: cls,
      units_total: all.length, units_window_open_excluded: windowOpen,
      n_intervene, n_shadow, n_other_arm: otherArm.length,
      // LOW-H5: units that only ever had non-randomized eligible rows (absent/shadow/corrupt
      // provenance) -- never counted into n_intervene/n_shadow, reported separately so they never
      // just silently vanish from the numbers.
      units_unrandomized_excluded: unrandomizedByClass.get(cls) || 0,
      sample_size_table_cleared: sampleSizeCleared,
      status,
      primary, secondary,
      rate_intervene: primary.rate_intervene, rate_shadow: primary.rate_shadow, diff: primary.diff, ci95: primary.ci95,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    root, host,
    // LOW-K2-followup: history rows excluded as contaminated (id_missing=1 or blank sid_sha16) --
    // never deleted from the ledger itself, only excluded from THIS report's analysis.
    excluded_contaminated: excludedRows.length,
    sample_size_table: SAMPLE_SIZE_TABLE,
    min_n_per_arm: MIN_N_PER_ARM,
    ledger: { file: ledger.file, exists: ledger.exists, rows_read: dedup.totalRead,
      distinct_event_id: dedup.distinctCount, dupe_rate: dedup.dupeRate,
      malformed_rows_excluded: ledger.malformed },
    by_class: classReports,
  };
}

function fmtNum(v) { return v === null || v === undefined ? 'n/a' : v.toFixed(4); }

function formatText(report) {
  const lines = [];
  lines.push('pmm-recall-m3 report (unit = session x class; numbers and intervals only)');
  lines.push(`generated_at=${report.generated_at} root=${report.root} host=${report.host}`);
  lines.push(`excluded_contaminated=${report.excluded_contaminated}`);
  lines.push(`ledger: file=${report.ledger.file} exists=${report.ledger.exists} rows_read=${report.ledger.rows_read} distinct_event_id=${report.ledger.distinct_event_id} dupe_rate=${(report.ledger.dupe_rate * 100).toFixed(2)}% malformed_rows_excluded=${report.ledger.malformed_rows_excluded}`);
  lines.push(`min_n_per_arm=${report.min_n_per_arm} (pre-registered table: ${report.sample_size_table.map((s) => s.effect + '=' + s.n_per_arm).join(', ')})`);
  lines.push('');
  if (!report.by_class.length) { lines.push('(no session x class units)'); return lines.join('\n') + '\n'; }
  for (const c of report.by_class) {
    lines.push(`== ${c.class_tag} ==`);
    lines.push(`units_total=${c.units_total} window_open_excluded=${c.units_window_open_excluded} n_intervene=${c.n_intervene} n_shadow=${c.n_shadow} n_other_arm=${c.n_other_arm} units_unrandomized_excluded=${c.units_unrandomized_excluded}`);
    lines.push(`status=${c.status} sample_size_table_cleared=[${c.sample_size_table_cleared.join(',')}]`);
    // Opus review "B3 主次结局分开": always print BOTH outcome rows, explicitly labeled.
    if (c.primary.status === 'PASS') {
      lines.push(`primary:   rate_intervene=${fmtNum(c.primary.rate_intervene)} rate_shadow=${fmtNum(c.primary.rate_shadow)} diff=${fmtNum(c.primary.diff)} ci95=[${fmtNum(c.primary.ci95.lower)}, ${fmtNum(c.primary.ci95.upper)}]`);
    } else {
      lines.push('primary:   diff=UNKNOWN ci95=UNKNOWN');
    }
    if (c.secondary.status === 'PASS') {
      lines.push(`secondary: rate_intervene=${fmtNum(c.secondary.rate_intervene)} rate_shadow=${fmtNum(c.secondary.rate_shadow)} diff=${fmtNum(c.secondary.diff)} ci95=[${fmtNum(c.secondary.ci95.lower)}, ${fmtNum(c.secondary.ci95.upper)}]`);
    } else {
      lines.push('secondary: diff=UNKNOWN ci95=UNKNOWN');
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function parseArgs(argv) {
  const opts = { report: false, json: false, selfTest: false };
  for (const a of argv) {
    if (a === '--self-test') opts.selfTest = true;
    else if (a === '--report') opts.report = true;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// Self-test
// --self-test 必须在两种环境下都全绿(2026-09-23, Opus 复现;见 REAL_HOME_FOR_SELFTEST 注释详述):
//   (a) 正常调用,真实环境 HOME:          node pmm-recall-m3.cjs --self-test
//   (b) 只重定向 HOME+USERPROFILE(不设任何 PMM_*):
//       HOME=<tmp> USERPROFILE=<tmp> node pmm-recall-m3.cjs --self-test
// ---------------------------------------------------------------------------------------------

const iso = require('./selftest-iso.cjs');

// SELFTEST-BEGIN
// spec 22 (C05-BUILD-SPEC 补遗二 §22): every DUT subprocess this self-test spawns must get its
// environment from selftest-iso.cjs's isoEnv() (no bare ambient-env clone of any shape), and
// the whole run must prove zero attributable change on the REAL root (footprint.begin/end), not on
// whichever redirected root a given test case happens to use -- see selftest-iso.cjs's header re K8.
function runSelfTest() {
  const results = [];
  function report(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (ok ? '' : '  (' + detail + ')'));
  }

  const nonce = 'nonce-' + crypto.randomBytes(6).toString('hex');
  const fpSnap = iso.footprint.begin();
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'pmm-recall-m3-selftest-'));
  // LOW-3 (2026-09-17, fab blind attack / Opus reproduction): a process.on('exit') safety net in
  // ADDITION to the try/finally cleanup below -- defense in depth against any exit path that bypasses
  // the finally block (C:\tmp accumulated 25 leftover v1-shaped self-test directories in production,
  // a hygiene issue this guards against going forward without claiming to have root-caused every one
  // of those 25 -- see this round's report for the exact listing, left undeleted per instruction).
  process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  const HOST = 'test-host';
  function freshRoot(tag) { return path.join(T, 'root-' + tag); }
  function run(root, args) {
    const env = iso.isoEnv(root, { PMM_RECALL_ROOT: root, PMM_RECALL_HOST: HOST });
    return spawnSync(process.execPath, [__filename].concat(args), { env, encoding: 'utf8' });
  }
  function writeLedger(root, rows) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'events-v3-' + HOST + '.tsv'), [V3_COLUMNS.join('\t')].concat(rows).join('\n') + '\n');
  }
  function row(fields) {
    // LOW-H5 (2026-09-17, Opus review): default run_provenance is 'policy:randomized' so every
    // EXISTING synthetic eligible-row fixture below keeps forming a unit unchanged (buildUnits() now
    // requires it); the one test that specifically exercises non-randomized exclusion overrides this
    // explicitly.
    const f = Object.assign({ schema_version: '3', ts: '2026-01-01T00:00:00.000Z', sid_sha16: 's',
      agent_sha16: 'a', agent_type: '', prompt_id: '', tool_use_id: 'toolu_selftest_tu', impression_id: 'imp',
      event_id: 'ev', event_kind: 'eligible', gate: '', confidence: '', class_tag: 'class:x',
      trigger_or_gate_id: 'trigX', cmd_sha16: '', parser_version: '', mode: 'intervene',
      run_provenance: 'policy:randomized', sanitized: '0', id_missing: '0', agent_id_missing: '0' }, fields);
    return V3_COLUMNS.map((c) => f[c]).join('\t');
  }
  // deterministic timestamp helper: base + n seconds
  function tsAt(n) { return new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 1000).toISOString(); }

  try {
    // ---- 1. empty root: no crash, empty by_class -------------------------------------------------
    {
      const root = freshRoot('empty');
      const r = run(root, ['--report', '--json']);
      report('1. empty root: rc=0', r.status === 0, 'status=' + r.status + ' stderr=' + r.stderr);
      const out = JSON.parse(r.stdout || '{}');
      report('2. empty root: by_class=[]', Array.isArray(out.by_class) && out.by_class.length === 0, JSON.stringify(out.by_class));
    }

    // ---- helper: build a unit (session,class) with N intervene + N shadow sessions, K of the
    // intervene arm and M of the shadow arm recurring, all windows closed via session-end -----------
    function buildPopulation(root, cls, nIntervene, kRecurIntervene, nShadow, mRecurShadow) {
      const rows = [];
      let t = 0;
      for (let i = 0; i < nIntervene; i++) {
        const sid = 'si' + i, agent = 'ag';
        const t0 = tsAt(t); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: agent, class_tag: cls, event_kind: 'eligible',
          event_id: 'eli-' + sid, impression_id: 'impeli-' + sid, tool_use_id: 'toolu_selftest_tX-elig-' + sid, mode: 'intervene', ts: t0 }));
        if (i < kRecurIntervene) {
          // real recurrence signal shape (M-SPEC 附录 B3 补注): would-warn + confidence=recurrence,
          // NEVER event_kind='recurrence' (production never writes that kind); distinct tool_use_id
          // from t0's own event, per the spec's "同一 tool event 不算" exclusion.
          rows.push(row({ sid_sha16: sid, agent_sha16: agent, class_tag: cls, event_kind: 'would-warn',
            confidence: 'recurrence', gate: 'D', event_id: 'rec-' + sid, impression_id: 'imprec-' + sid,
            tool_use_id: 'toolu_selftest_tX-recur-' + sid, mode: 'intervene', ts: tsAt(t) }));
          t += 1;
        }
        rows.push(row({ sid_sha16: sid, agent_sha16: agent, class_tag: '', trigger_or_gate_id: '',
          event_kind: 'session-end', event_id: 'se-' + sid, impression_id: 'impse-' + sid, mode: '', ts: tsAt(t) }));
        t += 1;
      }
      for (let i = 0; i < nShadow; i++) {
        const sid = 'ss' + i, agent = 'ag';
        const t0 = tsAt(t); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: agent, class_tag: cls, event_kind: 'eligible',
          event_id: 'els-' + sid, impression_id: 'impels-' + sid, tool_use_id: 'toolu_selftest_tX-elig-' + sid, mode: 'shadow', ts: t0 }));
        if (i < mRecurShadow) {
          rows.push(row({ sid_sha16: sid, agent_sha16: agent, class_tag: cls, event_kind: 'would-warn',
            confidence: 'recurrence', gate: 'D', event_id: 'recs-' + sid, impression_id: 'imprecs-' + sid,
            tool_use_id: 'toolu_selftest_tX-recur-' + sid, mode: 'shadow', ts: tsAt(t) }));
          t += 1;
        }
        rows.push(row({ sid_sha16: sid, agent_sha16: agent, class_tag: '', trigger_or_gate_id: '',
          event_kind: 'session-end', event_id: 'ses-' + sid, impression_id: 'impses-' + sid, mode: '', ts: tsAt(t) }));
        t += 1;
      }
      writeLedger(root, rows);
    }

    // ---- 2. below MIN_N_PER_ARM (58) -> status UNKNOWN, diff/ci95 UNKNOWN in text -----------------
    {
      const root = freshRoot('below-threshold');
      buildPopulation(root, 'class:small', 10, 5, 10, 2);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const c = out.by_class.find((x) => x.class_tag === 'class:small');
      report('3. below threshold: status=UNKNOWN', !!c && c.status === 'UNKNOWN', JSON.stringify(c));
      report('4. below threshold: diff=null, ci95=null', !!c && c.diff === null && c.ci95 === null, JSON.stringify(c));
      const textOut = run(root, ['--report']).stdout;
      report('5. below threshold: text says UNKNOWN, never "显著有效"', /class:small[\s\S]*?status=UNKNOWN/.test(textOut) && !/显著有效/.test(textOut), textOut);
    }

    // ---- 3. at/above MIN_N_PER_ARM (58 per arm) -> status PASS, numeric diff + ci95 ----------------
    {
      const root = freshRoot('above-threshold');
      // 60 per arm, intervene recurs 6/60=10%, shadow recurs 30/60=50% -> diff should be strongly negative
      buildPopulation(root, 'class:big', 60, 6, 60, 30);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const c = out.by_class.find((x) => x.class_tag === 'class:big');
      report('6. at/above threshold: status=PASS', !!c && c.status === 'PASS', JSON.stringify(c));
      report('7. n_intervene=60, n_shadow=60', !!c && c.n_intervene === 60 && c.n_shadow === 60, JSON.stringify(c));
      report('8. rate_intervene=0.10, rate_shadow=0.50', !!c && Math.abs(c.rate_intervene - 0.10) < 1e-9 && Math.abs(c.rate_shadow - 0.50) < 1e-9, JSON.stringify(c));
      report('9. diff = rate_intervene - rate_shadow = -0.40', !!c && Math.abs(c.diff - (-0.40)) < 1e-9, JSON.stringify(c));
      report('10. ci95 is a [lower,upper] pair with lower<=diff<=upper', !!c && c.ci95 && c.ci95.lower <= c.diff + 1e-9 && c.ci95.upper >= c.diff - 1e-9, JSON.stringify(c.ci95));
      report('11. sample_size_table_cleared includes 50%->25% (58/group)', !!c && c.sample_size_table_cleared.indexOf('50%->25%') !== -1, JSON.stringify(c.sample_size_table_cleared));
      const textOut = run(root, ['--report']).stdout;
      report('12. text output never contains the phrase 显著有效', !/显著有效/.test(textOut), textOut);
      report('12b. text output contains numeric diff/ci95 for class:big', /class:big[\s\S]*?diff=-0\.4000/.test(textOut), textOut);
      report('12c. report prints BOTH primary and secondary blocks, explicitly labeled', /primary:/.test(textOut) && /secondary:/.test(textOut), textOut);
    }

    // ---- 3b. Opus review "B3 主次结局分开": a unit whose ONLY in-window signal is a no-evidence
    // recurrence-candidate (never confidence='recurrence') must NOT count toward primary, but MUST
    // count toward secondary -- proving the two outcomes are genuinely independent, not aliases. -----
    {
      const root = freshRoot('primary-secondary-split');
      const rows = [];
      let t = 0;
      // 58 intervene + 58 shadow filler units, all with confirmed recurrence-candidate=false (no
      // signal at all) to clear MIN_N_PER_ARM cleanly for BOTH outcomes with a known baseline (0%).
      for (let i = 0; i < 58; i++) {
        const sid = 'pi' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:split', event_kind: 'eligible', event_id: 'e' + sid, impression_id: 'i' + sid, tool_use_id: 'toolu_selftest_tX-elig-' + sid, mode: 'intervene', ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      for (let i = 0; i < 58; i++) {
        const sid = 'ps' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:split', event_kind: 'eligible', event_id: 'e' + sid, impression_id: 'i' + sid, tool_use_id: 'toolu_selftest_tX-elig-' + sid, mode: 'shadow', ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      // one PROBE intervene unit: its only in-window signal is a bare recurrence-candidate (no
      // confidence='recurrence' anywhere) -- must flip secondary but leave primary at 0%.
      const probeSid = 'probe-split';
      rows.push(row({ sid_sha16: probeSid, agent_sha16: 'ag', class_tag: 'class:split', event_kind: 'eligible', event_id: 'ep', impression_id: 'ip', tool_use_id: 'toolu_selftest_tX-probe-elig', mode: 'intervene', ts: tsAt(t) }));
      t += 1;
      rows.push(row({ sid_sha16: probeSid, agent_sha16: 'ag', class_tag: 'class:split', event_kind: 'recurrence-candidate', confidence: 'recurrence-candidate', gate: 'D', event_id: 'ec', impression_id: 'ic', tool_use_id: 'toolu_selftest_tX-probe-cand', mode: 'intervene', ts: tsAt(t) }));
      t += 1;
      rows.push(row({ sid_sha16: probeSid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'sep', impression_id: 'isep', mode: '', ts: tsAt(t) }));
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const c = out.by_class.find((x) => x.class_tag === 'class:split');
      report('13a. n_intervene=59 (58 filler + 1 probe), n_shadow=58', !!c && c.n_intervene === 59 && c.n_shadow === 58, JSON.stringify(c));
      report('13b. primary.status=PASS, primary.rate_intervene=0 (candidate-only signal does NOT count as primary)', !!c && c.primary.status === 'PASS' && Math.abs(c.primary.rate_intervene - 0) < 1e-9, JSON.stringify(c.primary));
      report('13c. secondary.status=PASS, secondary.rate_intervene=1/59 (candidate DOES count as secondary)', !!c && c.secondary.status === 'PASS' && Math.abs(c.secondary.rate_intervene - (1 / 59)) < 1e-9, JSON.stringify(c.secondary));
      report('13d. primary and secondary produce DIFFERENT diff values for the same class (not aliases)', !!c && c.primary.diff !== c.secondary.diff, JSON.stringify({ primary: c.primary.diff, secondary: c.secondary.diff }));
    }

    // ---- 3c. LOW-H5 (2026-09-17, Opus review): a class that was never randomized always defaults
    // eligible rows to mode='intervene' (MEDIUM-6's own "行为不变"); those rows must NOT be counted
    // into n_intervene (would silently inflate the denominator with units that never had a chance at
    // shadow). Mix 60 properly policy:randomized units (both arms) with 10 policy:absent units (the
    // "never randomized" case) in ONE class and confirm the absent ones are excluded from both arms
    // and show up in units_unrandomized_excluded instead. -------------------------------------------
    {
      const root = freshRoot('low-h5-mixed');
      const rows = [];
      let t = 0;
      for (let i = 0; i < 30; i++) {
        const sid = 'h5i' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:h5mix', event_kind: 'eligible',
          event_id: 'e' + sid, impression_id: 'i' + sid, tool_use_id: 'toolu_selftest_tX-' + sid, mode: 'intervene',
          run_provenance: 'policy:randomized', ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '',
          event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      for (let i = 0; i < 30; i++) {
        const sid = 'h5s' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:h5mix', event_kind: 'eligible',
          event_id: 'e' + sid, impression_id: 'i' + sid, tool_use_id: 'toolu_selftest_tX-' + sid, mode: 'shadow',
          run_provenance: 'policy:randomized', ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '',
          event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      // "never randomized" units: eligible rows carry mode='intervene' (the legacy default) but
      // run_provenance is policy:absent/shadow/corrupt -- must NEVER count into n_intervene.
      const absentProvenances = ['policy:absent', 'policy:shadow', 'policy:corrupt'];
      for (let i = 0; i < 10; i++) {
        const sid = 'h5u' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:h5mix', event_kind: 'eligible',
          event_id: 'e' + sid, impression_id: 'i' + sid, tool_use_id: 'toolu_selftest_tX-' + sid, mode: 'intervene',
          run_provenance: absentProvenances[i % 3], ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '',
          event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const c = out.by_class.find((x) => x.class_tag === 'class:h5mix');
      report('14a. LOW-H5 mixed: n_intervene=30, n_shadow=30 (unrandomized units excluded from BOTH)', !!c && c.n_intervene === 30 && c.n_shadow === 30, JSON.stringify(c));
      report('14b. LOW-H5 mixed: units_unrandomized_excluded=10 (absent/shadow/corrupt provenance units)', !!c && c.units_unrandomized_excluded === 10, JSON.stringify(c));
      report('14c. LOW-H5 mixed: units_total=60 (does NOT include the 10 unrandomized units)', !!c && c.units_total === 60, JSON.stringify(c));
      const textOut = run(root, ['--report']).stdout;
      report('14d. LOW-H5 mixed: text output shows units_unrandomized_excluded=10 for class:h5mix', /class:h5mix[\s\S]*?units_unrandomized_excluded=10/.test(textOut), textOut);
    }

    // ---- 4. determinism: same input -> identical ci95 across independent invocations --------------
    {
      const root = freshRoot('determinism');
      buildPopulation(root, 'class:det', 60, 12, 60, 12);
      const r1 = JSON.parse(run(root, ['--report', '--json']).stdout || '{}');
      const r2 = JSON.parse(run(root, ['--report', '--json']).stdout || '{}');
      const c1 = r1.by_class.find((x) => x.class_tag === 'class:det');
      const c2 = r2.by_class.find((x) => x.class_tag === 'class:det');
      report('13. bootstrap CI is deterministic across independent process runs on identical data',
        !!c1 && !!c2 && c1.ci95.lower === c2.ci95.lower && c1.ci95.upper === c2.ci95.upper, JSON.stringify({ c1: c1 && c1.ci95, c2: c2 && c2.ci95 }));
    }

    // ---- 5. window-open units excluded from n and from status gating -------------------------------
    {
      const root = freshRoot('window-open');
      const rows = [];
      // 60 closed-window intervene units (recurrence never, via session-end) + 5 OPEN-window intervene
      // units (no session-end, <20 observed) that must NOT count toward n_intervene.
      let t = 0;
      for (let i = 0; i < 60; i++) {
        const sid = 'wi' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:win', event_kind: 'eligible', event_id: 'e' + sid, impression_id: 'i' + sid, mode: 'intervene', ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      for (let i = 0; i < 60; i++) {
        const sid = 'ws' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:win', event_kind: 'eligible', event_id: 'e' + sid, impression_id: 'i' + sid, mode: 'shadow', ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      for (let i = 0; i < 5; i++) {
        const sid = 'wopen' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:win', event_kind: 'eligible', event_id: 'eo' + sid, impression_id: 'io' + sid, mode: 'intervene', ts: tsAt(t) })); t += 1;
        // no session-end, no 20 observed rows -> window stays open
      }
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const c = out.by_class.find((x) => x.class_tag === 'class:win');
      report('14. window-open units excluded: n_intervene=60 (not 65)', !!c && c.n_intervene === 60, JSON.stringify(c));
      report('15. window-open units counted separately: units_window_open_excluded=5', !!c && c.units_window_open_excluded === 5, JSON.stringify(c));
      report('16. units_total=125 (60+60+5)', !!c && c.units_total === 125, JSON.stringify(c));
    }

    // ---- 6. recurrence AFTER the window closes does not count (must be <= closeMs) ------------------
    {
      const root = freshRoot('after-window');
      const rows = [];
      let t = 0;
      // build 58 filler intervene + 58 filler shadow units (no recurrence) to clear MIN_N_PER_ARM,
      // then one probe intervene unit whose 'recurrence' row lands AFTER its session-end (must be excluded).
      for (let i = 0; i < 58; i++) {
        const sid = 'fi' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:late', event_kind: 'eligible', event_id: 'e' + sid, impression_id: 'i' + sid, mode: 'intervene', ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      for (let i = 0; i < 58; i++) {
        const sid = 'fs' + i;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: 'class:late', event_kind: 'eligible', event_id: 'e' + sid, impression_id: 'i' + sid, mode: 'shadow', ts: tsAt(t) })); t += 1;
        rows.push(row({ sid_sha16: sid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'se' + sid, impression_id: 'ise' + sid, mode: '', ts: tsAt(t) })); t += 1;
      }
      const probeSid = 'probe1';
      rows.push(row({ sid_sha16: probeSid, agent_sha16: 'ag', class_tag: 'class:late', event_kind: 'eligible', event_id: 'ep', impression_id: 'ip', tool_use_id: 'toolu_selftest_tX-probe-elig', mode: 'intervene', ts: tsAt(t) }));
      const t0 = t; t += 1;
      rows.push(row({ sid_sha16: probeSid, agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'sep', impression_id: 'isep', mode: '', ts: tsAt(t) }));
      const closeT = t; t += 1;
      rows.push(row({ sid_sha16: probeSid, agent_sha16: 'ag', class_tag: 'class:late', event_kind: 'would-warn',
        confidence: 'recurrence', gate: 'D', event_id: 'recp', impression_id: 'irecp', tool_use_id: 'toolu_selftest_tX-probe-recur', mode: 'intervene', ts: tsAt(t) })); // AFTER close
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const c = out.by_class.find((x) => x.class_tag === 'class:late');
      report('17. status=PASS (59 per arm clears 58)', !!c && c.status === 'PASS', JSON.stringify(c));
      report('18. post-window recurrence excluded: rate_intervene = 0/59', !!c && Math.abs(c.rate_intervene - 0) < 1e-9, JSON.stringify(c));
    }

    // ---- 7. first_recurrence delta is computed internally (checked via a direct module call, not CLI).
    // Deliberately uses a literal event_kind='recurrence' row (the defensive OR-branch in
    // isRecurrenceSignal, kept in case a future writer ever emits that kind) with a DISTINCT
    // tool_use_id from t0's own event, per M-SPEC's "同一 tool event 不算" exclusion. ------------------
    {
      const mod = require('./pmm-recall-m3.cjs');
      const rows = [
        row({ sid_sha16: 'du1', agent_sha16: 'ag', class_tag: 'class:delta', event_kind: 'eligible', event_id: 'e1', impression_id: 'i1', tool_use_id: 'toolu_selftest_tX-du-elig', mode: 'intervene', ts: tsAt(0) }),
        row({ sid_sha16: 'du1', agent_sha16: 'ag', class_tag: 'class:delta', event_kind: 'recurrence', event_id: 'e2', impression_id: 'i2', tool_use_id: 'toolu_selftest_tX-du-recur', mode: 'intervene', ts: tsAt(5) }),
        row({ sid_sha16: 'du1', agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'e3', impression_id: 'i3', mode: '', ts: tsAt(10) }),
      ];
      const parsedRows = rows.map((line) => { const parts = line.split('\t'); const o = {}; V3_COLUMNS.forEach((c, i) => { o[c] = parts[i]; }); return o; });
      const dedup = mod.dedupByEventId(parsedRows);
      const idx = mod.buildSessAgentIndex(dedup.rows);
      const units = mod.buildUnits(dedup.rows);
      const unit = units.get(mod.unitKey('du1', 'ag', 'class:delta'));
      const outcome = mod.computeUnitOutcome(unit, dedup.rows, idx);
      report('19. computeUnitOutcome: recurred=true, first_recurrence_delta_ms=5000', outcome.recurred === true && outcome.first_recurrence_delta_ms === 5000, JSON.stringify(outcome));
    }

    // ---- coordinator correction (2026-09-17, M-SPEC 附录 B3 补注): two new self-test cases -----------
    // (a) "confidence=recurrence 的 would-warn 行被计为复发": the realistic production shape (D
    //     recurrence per gate_disposition_map) must be recognized, with NO literal
    //     event_kind='recurrence' row anywhere in the ledger.
    {
      const mod = require('./pmm-recall-m3.cjs');
      const rows = [
        row({ sid_sha16: 'wc1', agent_sha16: 'ag', class_tag: 'class:wc', event_kind: 'eligible', event_id: 'e1', impression_id: 'i1', tool_use_id: 'toolu_selftest_tX-wc-elig', mode: 'intervene', ts: tsAt(0) }),
        row({ sid_sha16: 'wc1', agent_sha16: 'ag', class_tag: 'class:wc', event_kind: 'would-warn', confidence: 'recurrence', gate: 'D', event_id: 'e2', impression_id: 'i2', tool_use_id: 'toolu_selftest_tX-wc-recur', mode: 'intervene', ts: tsAt(5) }),
        row({ sid_sha16: 'wc1', agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'e3', impression_id: 'i3', mode: '', ts: tsAt(10) }),
      ];
      const parsedRows = rows.map((line) => { const parts = line.split('\t'); const o = {}; V3_COLUMNS.forEach((c, i) => { o[c] = parts[i]; }); return o; });
      report('20. no row anywhere has event_kind=recurrence in this fixture (sanity check on the fixture itself)',
        parsedRows.every((r) => r.event_kind !== 'recurrence'), JSON.stringify(parsedRows.map((r) => r.event_kind)));
      const dedup = mod.dedupByEventId(parsedRows);
      const idx = mod.buildSessAgentIndex(dedup.rows);
      const units = mod.buildUnits(dedup.rows);
      const unit = units.get(mod.unitKey('wc1', 'ag', 'class:wc'));
      const outcome = mod.computeUnitOutcome(unit, dedup.rows, idx);
      report('21. confidence=recurrence would-warn row counted as recurrence (recurred=true, delta=5000ms)',
        outcome.recurred === true && outcome.first_recurrence_delta_ms === 5000, JSON.stringify(outcome));
    }
    // (b) "event_kind=recurrence 行不存在也能计": end-to-end via --report (not just the direct module
    //     call above) over a whole population, no literal event_kind='recurrence' row anywhere,
    //     status still reaches PASS and rate_intervene reflects the would-warn/confidence signal.
    {
      const root = freshRoot('no-literal-recurrence-kind');
      buildPopulation(root, 'class:noliteral', 60, 9, 60, 3); // buildPopulation already emits the realistic would-warn+confidence shape, never event_kind='recurrence'
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      const c = out.by_class.find((x) => x.class_tag === 'class:noliteral');
      const kindIdx = V3_COLUMNS.indexOf('event_kind');
      const ledgerLines = fs.readFileSync(path.join(root, 'events-v3-' + HOST + '.tsv'), 'utf8').split('\n').filter(Boolean).slice(1);
      report('22. ledger for this class contains zero literal event_kind=recurrence rows (fixture sanity)',
        ledgerLines.every((l) => l.split('\t')[kindIdx] !== 'recurrence'), 'checked event_kind column index ' + kindIdx);
      report('23. end-to-end via --report: status=PASS and rate_intervene=9/60 without any event_kind=recurrence row',
        !!c && c.status === 'PASS' && Math.abs(c.rate_intervene - (9 / 60)) < 1e-9, JSON.stringify(c));
    }

    // ---- coordinator correction #2 (2026-09-17 11:10, 契约 v2.19 gate_row_class_tag): an OLD gate
    // row with class_tag='' and trigger_or_gate_id='A' must still be recognized as a same-class
    // recurrence signal for a unit whose t0 'eligible' row's class_tag IS the backfilled lesson tag
    // (the real-world scenario: M0's shadow-only cmd trigger seeded on
    // process:pipe-hides-exit-code-and-truncates-evidence produces the 'eligible' row; the Bash gate
    // implementing that same lesson produced an old, pre-v2.19 gate row with an empty class_tag). ---
    {
      const mod = require('./pmm-recall-m3.cjs');
      const cls = 'process:pipe-hides-exit-code-and-truncates-evidence';
      const rows = [
        row({ sid_sha16: 'bf1', agent_sha16: 'ag', class_tag: cls, event_kind: 'eligible', event_id: 'e1', impression_id: 'i1', tool_use_id: 'toolu_selftest_tX-bf-elig', mode: 'intervene', ts: tsAt(0) }),
        // OLD gate row: empty class_tag on disk, trigger_or_gate_id='A', confidence='recurrence'.
        row({ sid_sha16: 'bf1', agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: 'A', event_kind: 'would-warn', confidence: 'recurrence', gate: 'A', event_id: 'e2', impression_id: 'i2', tool_use_id: 'toolu_selftest_tX-bf-gate', mode: 'intervene', ts: tsAt(5) }),
        row({ sid_sha16: 'bf1', agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'e3', impression_id: 'i3', mode: '', ts: tsAt(10) }),
      ];
      const parsedRows = rows.map((line) => { const parts = line.split('\t'); const o = {}; V3_COLUMNS.forEach((c, i) => { o[c] = parts[i]; }); return backfillGateClassTag(o); });
      report('24. fixture sanity: the raw gate row was written with class_tag empty (pre-backfill)', rows[1].split('\t')[V3_COLUMNS.indexOf('class_tag')] === '', rows[1]);
      report('25. readV3Rows-equivalent backfill applied: parsed gate row class_tag now equals the lesson tag', parsedRows[1].class_tag === cls, JSON.stringify(parsedRows[1]));
      const dedup = mod.dedupByEventId(parsedRows);
      const idx = mod.buildSessAgentIndex(dedup.rows);
      const units = mod.buildUnits(dedup.rows);
      const unit = units.get(mod.unitKey('bf1', 'ag', cls));
      const outcome = mod.computeUnitOutcome(unit, dedup.rows, idx);
      report('26. old (pre-backfill) gate-A row now recognized as a same-class recurrence for the M0-eligible unit', outcome.recurred === true && outcome.first_recurrence_delta_ms === 5000, JSON.stringify(outcome));
    }

    // ---- 8. malformed row excluded and reported ------------------------------------------------------
    {
      const root = freshRoot('malformed');
      fs.mkdirSync(root, { recursive: true });
      const good = row({ event_id: 'e1', impression_id: 'i1' });
      const bad = 'too\tfew\tcolumns';
      fs.writeFileSync(path.join(root, 'events-v3-' + HOST + '.tsv'), [V3_COLUMNS.join('\t'), good, bad].join('\n') + '\n');
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      report('20. malformed row excluded and counted', out.ledger.malformed_rows_excluded === 1, JSON.stringify(out.ledger));
    }

    // ---- 9. read-only guarantee -----------------------------------------------------------------------
    {
      const root = freshRoot('readonly');
      writeLedger(root, [row({ event_id: 'e1', impression_id: 'i1' })]);
      const before = fs.readdirSync(root).sort();
      run(root, ['--report', '--json']);
      const after = fs.readdirSync(root).sort();
      report('21. read-only: directory listing unchanged', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
    }

    // ---- 10. usage error: no --report flag -> rc 1 ------------------------------------------------------
    {
      const root = freshRoot('usage');
      const r = run(root, []);
      report('22. no flags -> rc 1', r.status === 1, 'status=' + r.status);
    }

    // ---- 11. MEDIUM-6 (2026-09-17, coordinator dispatch): samples generated by the REAL production
    // writers (pmm-trigger-recall.cjs for Edit/Write, pmm-bash-impression.cjs for Bash cmd triggers),
    // not hand-built TSV rows, against a synthetic policy.json marking one class randomized. Proves
    // both arms actually form and closed-window units can be computed from real writer output.
    // Red<->green control built INTO this test (not a separate manual step): the SAME real-writer
    // flow run with NO policy.json (policy:absent -- exactly what the OLD hardcoded mode='intervene'
    // writer always produced) must show n_shadow=0 for that class; only the policy.json-randomized
    // run may show n_shadow>0. If a future regression reverts either writer back to a constant
    // 'intervene' mode, the policy.json-randomized run's own n_shadow will collapse to 0 too, and
    // this test's core assertion (both arms present) goes red. ---------------------------------------
    {
      const G = __dirname;
      // HIGH-1 followup (2026-09-23, Opus reproduction): runTriggerRecall()/runTriggerRecallNoPolicy()
      // below used to hardcode 'C:/Users/<user>' into the spawned Edit-hook's file_path -- correct only
      // when this self-test's own ambient HOME happens to equal the real machine home. Under a
      // self-test run with ONLY HOME+USERPROFILE redirected (no PMM_*), the spawned pmm-trigger-
      // recall.cjs child (which inherits this same env, per the HIGH-1 contract's resolveHome()) no
      // longer sees that literal as repo='home', so its dual-write silently produces ZERO rows. 11a-d
      // happened to still pass because runBashImpression()'s OWN trigger uses repo=* (a wildcard,
      // never HOME-dependent) and masked the Edit-hook's failure; 11e (the NO-policy control group)
      // has no such fallback and went red (measured before this fix: 56/57). spec 22 (K8) supersedes
      // the original HIGH-1 followup fix here: every spawned child now gets FULL isolation via
      // iso.isoEnv(root, ...) (HOME=USERPROFILE=PMM_HOME=root), so "home" for repo=home glob matching
      // is simply `root` itself -- no dependency on ledger.resolveHome() (which reads ambient env and
      // would silently resolve to the temp HOME this whole self-test happens to be invoked under,
      // rather than the isolated per-case root) survives here at all.
      const cls = 'class:m6-real-writers';
      const root = freshRoot('medium6-real-writers');
      fs.mkdirSync(root, { recursive: true });

      // ---- fixture memory corpus for pmm-trigger-recall.cjs (Edit/Write path trigger) ----
      const memDir = path.join(root, 'mem');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(path.join(memDir, 'lessons.md'),
        '**2026-01-01 — M6 real-writer trigger** [test:m6-real]\n' +
        '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/m6probe*.sh -->\n' +
        'Class: [[' + cls + ']]\n' + 'body\n');
      fs.writeFileSync(path.join(memDir, 'decisions.md'), '');
      fs.writeFileSync(path.join(memDir, 'standinginstructions.md'), '');
      const stateDir = path.join(root, 'state');
      fs.mkdirSync(stateDir, { recursive: true });

      // ---- fixture memory corpus for pmm-bash-impression.cjs (Bash cmd trigger), SAME class ----
      const cmdMemDir = path.join(root, 'cmdmem');
      fs.mkdirSync(cmdMemDir, { recursive: true });
      fs.writeFileSync(path.join(cmdMemDir, 'lessons.md'),
        '## Index\n\n## Entries\n\n' +
        '**2026-01-01 — M6 real-writer cmd trigger** [test:m6-real-cmd]\n' +
        '<!-- trigger: tool=Bash; repo=*; cmd=m6probetool -->\n' +
        'Class: [[' + cls + ']]\n' + 'body\n');
      fs.writeFileSync(path.join(cmdMemDir, 'decisions.md'), '## Index\n\n## Entries\n');
      fs.writeFileSync(path.join(cmdMemDir, 'standinginstructions.md'), '## Index\n\n## Entries\n');
      fs.writeFileSync(path.join(cmdMemDir, 'classes.md'), '## Index\n\n## Entries\n');

      // policy.json: this class is randomized.
      fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ [cls]: { mode: 'randomized' } }));

      // find session ids landing on each arm via the production assignment() formula itself.
      const polMod = require('./pmm-recall-policy.cjs');
      const shadowSids = [], intervSids = [];
      for (let i = 0; i < 1000 && (shadowSids.length < 3 || intervSids.length < 3); i++) {
        const sid = 'm6w' + i + 'zzzzzzzzzzzzzz';
        const arm = polMod.assignment(sid, cls, 'randomized');
        if (arm === 'shadow' && shadowSids.length < 3) shadowSids.push(sid);
        if (arm === 'intervene' && intervSids.length < 3) intervSids.push(sid);
      }
      report('11a. setup: found >=3 shadow-arm and >=3 intervene-arm session ids for the real-writer class', shadowSids.length >= 3 && intervSids.length >= 3, JSON.stringify({ shadowSids, intervSids }));

      // NOTE: pmm-recall-ledger.cjs's ledgerPath() always uses os.hostname() directly (it does NOT
      // honor PMM_RECALL_HOST -- only this self-test's own resolveHost() does), so every real writer
      // below (which all go through that shared module) writes to events-v3-<REAL hostname>.tsv
      // regardless of PMM_RECALL_HOST. runReal() (defined after these) omits PMM_RECALL_HOST for
      // exactly that reason, so the report-reading step looks at the SAME file the writers used.
      function runTriggerRecall(sid, tu, fileBase) {
        const hookJson = JSON.stringify({ session_id: sid, tool_use_id: tu, agent_id: 'm6-agent', tool_name: 'Edit',
          tool_input: { file_path: root + '/.claude/guards/' + fileBase + '.sh' } });
        const env = iso.isoEnv(root, { PMM_TRIGGER_MEM: memDir, PMM_TRIGGER_STATE: stateDir,
          PMM_TRIGGER_LOG: path.join(root, 'dream-log.tsv'), PMM_RECALL_ROOT: root });
        spawnSync(process.execPath, [path.join(G, 'pmm-trigger-recall.cjs')], { input: hookJson, env, encoding: 'utf8' });
      }
      function runBashImpression(sid, tu) {
        const hookJson = JSON.stringify({ session_id: sid, tool_use_id: tu, agent_id: 'm6-agent',
          cwd: 'C:/Windows/Temp', tool_input: { command: 'm6probetool arg' } });
        const env = iso.isoEnv(root, { PMM_MEM_DIR: cmdMemDir, PMM_RECALL_ROOT: root,
          PMM_IMPRESSION_HOME: root });
        spawnSync(process.execPath, [path.join(G, 'pmm-bash-impression.cjs')], { input: hookJson, env, encoding: 'utf8' });
      }
      function closeWindow(sid) {
        // writeSessionEnd via the shared ledger module's own CLI entry (--session-end reads JSON from stdin).
        const env = iso.isoEnv(root, { PMM_RECALL_ROOT: root });
        spawnSync(process.execPath, [path.join(G, 'pmm-recall-ledger.cjs'), '--session-end'],
          { input: JSON.stringify({ session_id: sid, agent_id: 'm6-agent', agent_type: 'builder' }), env, encoding: 'utf8' });
      }
      function runReal(rootArg, args) {
        const env = iso.isoEnv(rootArg, { PMM_RECALL_ROOT: rootArg });
        return spawnSync(process.execPath, [__filename].concat(args), { env, encoding: 'utf8' });
      }

      let i = 0;
      for (const sid of shadowSids) { runTriggerRecall(sid, 'm6-tu-' + (i++), 'm6probe' + i); runBashImpression(sid, 'm6-tu-' + (i++)); closeWindow(sid); }
      for (const sid of intervSids) { runTriggerRecall(sid, 'm6-tu-' + (i++), 'm6probe' + i); runBashImpression(sid, 'm6-tu-' + (i++)); closeWindow(sid); }

      const realReport = JSON.parse(runReal(root, ['--report', '--json']).stdout || '{}');
      const realClass = (realReport.by_class || []).find((c) => c.class_tag === cls);
      report('11b. real-writer report: unit formed for the class at all', !!realClass, JSON.stringify(realReport.by_class));
      report('11c. real-writer report: BOTH arms present (n_intervene>0 AND n_shadow>0) -- the MEDIUM-6 fix itself',
        !!realClass && realClass.n_intervene > 0 && realClass.n_shadow > 0, JSON.stringify(realClass));
      report('11d. real-writer report: every session-ended unit is closed (units_window_open_excluded=0)',
        !!realClass && realClass.units_window_open_excluded === 0, JSON.stringify(realClass));

      // ---- red<->green control: SAME real-writer flow, NO policy.json (= what the OLD hardcoded
      // mode='intervene' writer always produced) -> n_shadow MUST be 0. This is what would happen if
      // either writer regressed back to a constant arm: the assertion above (11c) would go red. -----
      const rootNoPolicy = freshRoot('medium6-control-no-policy');
      fs.mkdirSync(rootNoPolicy, { recursive: true });
      function runTriggerRecallNoPolicy(sid, tu, fileBase) {
        const hookJson = JSON.stringify({ session_id: sid, tool_use_id: tu, agent_id: 'm6-agent', tool_name: 'Edit',
          tool_input: { file_path: rootNoPolicy + '/.claude/guards/' + fileBase + '.sh' } });
        const env = iso.isoEnv(rootNoPolicy, { PMM_TRIGGER_MEM: memDir, PMM_TRIGGER_STATE: path.join(rootNoPolicy, 'state'),
          PMM_TRIGGER_LOG: path.join(rootNoPolicy, 'dream-log.tsv'), PMM_RECALL_ROOT: rootNoPolicy });
        fs.mkdirSync(path.join(rootNoPolicy, 'state'), { recursive: true });
        spawnSync(process.execPath, [path.join(G, 'pmm-trigger-recall.cjs')], { input: hookJson, env, encoding: 'utf8' });
      }
      let j = 0;
      for (const sid of shadowSids.concat(intervSids)) {
        runTriggerRecallNoPolicy(sid, 'ctl-tu-' + (j++), 'm6probe' + (100 + j)); // must match the trigger glob .claude/guards/m6probe*.sh
        const env = iso.isoEnv(rootNoPolicy, { PMM_RECALL_ROOT: rootNoPolicy });
        spawnSync(process.execPath, [path.join(G, 'pmm-recall-ledger.cjs'), '--session-end'],
          { input: JSON.stringify({ session_id: sid, agent_id: 'm6-agent', agent_type: 'builder' }), env, encoding: 'utf8' });
      }
      const ctlReport = JSON.parse(runReal(rootNoPolicy, ['--report', '--json']).stdout || '{}');
      const ctlClass = (ctlReport.by_class || []).find((c) => c.class_tag === cls);
      // LOW-H5 (2026-09-17, Opus review): with no policy.json, every eligible row is provenance
      // policy:absent (never policy:randomized) -- under the LOW-H5 fix these units are excluded
      // from BOTH arms entirely (not just n_shadow=0; n_intervene must ALSO be 0), and show up in
      // units_unrandomized_excluded instead. This is a STRONGER control than the pre-LOW-H5 version
      // (which expected n_intervene>0): it now proves the LOW-H5 exclusion is live too.
      report('11e. RED CONTROL: same real writer, NO policy.json -> BOTH arms 0, units_unrandomized_excluded>0 (LOW-H5)',
        !!ctlClass && ctlClass.n_shadow === 0 && ctlClass.n_intervene === 0 && ctlClass.units_unrandomized_excluded > 0, JSON.stringify(ctlClass));
    }

    // ---- 12. LOW-K2 (2026-09-17, codex second wave / Opus reproduction): PMM_RECALL_ROOT=' ' must
    // resolve to the SAME directory a writer (ledger.resolveRoot()) would use -- never a literal ' '
    // path, which would make --report read an empty directory and report all-zero SILENTLY. Verified
    // two ways: (a) pure computation; (b) end-to-end -- HOME/USERPROFILE redirected to a temp dir, a
    // ledger row placed exactly where a real writer would leave it, --report with PMM_RECALL_ROOT=' '
    // actually finds it. ---------------------------------------------------------------------------
    {
      const before = process.env.PMM_RECALL_ROOT;
      process.env.PMM_RECALL_ROOT = ' ';
      try {
        const fromHere = resolveRoot();
        const fromLedger = ledger.resolveRoot();
        report('23a. LOW-K2: PMM_RECALL_ROOT=\' \' -> resolveRoot() here is never the literal whitespace', fromHere !== ' ', JSON.stringify(fromHere));
        report('23b. LOW-K2: PMM_RECALL_ROOT=\' \' -> resolveRoot() here === ledger.resolveRoot() (same resolver)', fromHere === fromLedger, JSON.stringify({ fromHere, fromLedger }));
      } finally {
        if (before === undefined) delete process.env.PMM_RECALL_ROOT; else process.env.PMM_RECALL_ROOT = before;
      }
    }
    {
      const fakeHome = path.join(T, 'lowk2-fakehome-' + Date.now());
      fs.mkdirSync(fakeHome, { recursive: true });
      const expectedDefaultRoot = path.join(fakeHome, '.claude', '.local', 'pmm-recall');
      fs.mkdirSync(expectedDefaultRoot, { recursive: true });
      const rows = [
        row({ sid_sha16: 'lowk2sid', agent_sha16: 'ag', class_tag: 'class:lowk2', event_kind: 'eligible',
          event_id: 'e1', impression_id: 'i1', tool_use_id: 'toolu_selftest_tu1', mode: 'intervene', run_provenance: 'policy:randomized', ts: tsAt(0) }),
        row({ sid_sha16: 'lowk2sid', agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '',
          event_kind: 'session-end', event_id: 'se1', impression_id: 'ise1', mode: '', ts: tsAt(1) }),
      ];
      fs.writeFileSync(path.join(expectedDefaultRoot, 'events-v3-' + os.hostname() + '.tsv'), [V3_COLUMNS.join('\t')].concat(rows).join('\n') + '\n');
      const env = iso.isoEnv(fakeHome, { PMM_RECALL_ROOT: ' ' });
      const r = spawnSync(process.execPath, [__filename, '--report', '--json'], { env, encoding: 'utf8' });
      const out = JSON.parse(r.stdout || '{}');
      const c = (out.by_class || []).find((x) => x.class_tag === 'class:lowk2');
      report('23c. LOW-K2 end-to-end: --report with whitespace root + redirected HOME finds the writer\'s data (NOT silently empty)', !!c && c.units_total + c.units_unrandomized_excluded >= 1, JSON.stringify(out.by_class));
    }

    // ---- 24. LOW-K2-followup (2026-09-17, coordinator: real-ledger contamination incident):
    // history rows with id_missing='1' or blank sid_sha16 (the confirmed, cross-validated marker for
    // the real pmm-trigger-recall.sh leak) must never seed a unit or contribute to an outcome, and the
    // top-level excluded_contaminated field must report how many were excluded.
    {
      const root = freshRoot('contaminated');
      const rows = [
        // clean unit: forms normally
        row({ sid_sha16: 'sClean', agent_sha16: 'ag', class_tag: 'class:clean', trigger_or_gate_id: 'trigClean',
          event_kind: 'eligible', event_id: 'e1', impression_id: 'i1', tool_use_id: 'toolu_selftest_tu1', mode: 'intervene', ts: tsAt(0) }),
        row({ sid_sha16: 'sClean', agent_sha16: 'ag', class_tag: '', trigger_or_gate_id: '',
          event_kind: 'session-end', event_id: 'se1', impression_id: 'ise1', mode: '', ts: tsAt(1) }),
        // contaminated: id_missing=1 (the actual real-incident marker), shaped exactly like the leaked
        // pmm-trigger-recall.sh fixture rows (class_tag/trigger_or_gate_id='test:trig-alpha')
        row({ sid_sha16: 'sContamA', agent_sha16: 'ag', class_tag: 'test:trig-alpha', trigger_or_gate_id: 'test:trig-alpha',
          event_kind: 'eligible', event_id: 'e2', impression_id: '', id_missing: '1', ts: tsAt(2) }),
        // contaminated: blank sid_sha16 (independent forward-looking marker)
        row({ sid_sha16: '', agent_sha16: 'ag', class_tag: 'class:blanksid', trigger_or_gate_id: 'trigBlank',
          event_kind: 'eligible', event_id: 'e3', impression_id: 'i3', ts: tsAt(3) }),
      ];
      writeLedger(root, rows);
      const r = run(root, ['--report', '--json']);
      const out = JSON.parse(r.stdout || '{}');
      report('24a. excluded_contaminated=2 (1 id_missing=1 row + 1 blank-sid row)', out.excluded_contaminated === 2, JSON.stringify(out.excluded_contaminated));
      const contamClass = (out.by_class || []).find((c2) => c2.class_tag === 'test:trig-alpha');
      report('24b. the contaminated test:trig-alpha class never appears in by_class at all', !contamClass, JSON.stringify(out.by_class));
      const blankSidClass = (out.by_class || []).find((c2) => c2.class_tag === 'class:blanksid');
      report('24c. the blank-sid class:blanksid class never appears in by_class either', !blankSidClass, JSON.stringify(out.by_class));
      const cleanClass = (out.by_class || []).find((c2) => c2.class_tag === 'class:clean');
      report('24d. the clean class:clean unit is unaffected (still forms a unit)', !!cleanClass && (cleanClass.units_total >= 1 || cleanClass.units_unrandomized_excluded >= 1), JSON.stringify(cleanClass));
      const rText = run(root, ['--report']);
      report('24e. text mode also prints excluded_contaminated=2 near the top', /excluded_contaminated=2/.test(rText.stdout), rText.stdout.slice(0, 200));
    }

    // ---- 27. M-SPEC 附录 B 补注 #5 (2026-09-17, fab blind attack item 3 / Opus reproduction): a main
    // session (agent_sha16='') and a sub-agent SHARING that same session_id (so identical sid_sha16 --
    // Claude Code sub-agent sessions do this) must each be able to independently seed and recur their
    // OWN unit for the same class, without one starving the other. Before this fix, unitKey(sid, cls)
    // collapsed both onto ONE map entry keyed purely by sid+cls -- whichever eligible row had the
    // earlier ts "won" t0 and the other agent's eligible row for that class silently never became a
    // unit of its own at all (not double-counted, just erased from the analysis entirely). ------------
    {
      const mod = require('./pmm-recall-m3.cjs');
      const sid = 'shared-sess-1';
      const rows = [
        // main session (agent_sha16='') -- eligible at t=0, recurs at t=5.
        row({ sid_sha16: sid, agent_sha16: '', class_tag: 'class:shared', event_kind: 'eligible', event_id: 'em1', impression_id: 'im1', tool_use_id: 'toolu_selftest_tX-main-elig', mode: 'intervene', ts: tsAt(0) }),
        row({ sid_sha16: sid, agent_sha16: '', class_tag: 'class:shared', event_kind: 'would-warn', confidence: 'recurrence', gate: 'A', event_id: 'em2', impression_id: 'im2', tool_use_id: 'toolu_selftest_tX-main-recur', mode: 'intervene', ts: tsAt(5) }),
        row({ sid_sha16: sid, agent_sha16: '', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'em3', impression_id: 'im3', mode: '', ts: tsAt(10) }),
        // sub-agent (agent_sha16='sub-ag'), SAME sid_sha16 -- eligible at t=1 (would have "won" t0
        // under the old bug since it's later than the main session's t=0 but still gets checked first
        // if map iteration order favored it), never recurs within its own window.
        row({ sid_sha16: sid, agent_sha16: 'sub-ag', class_tag: 'class:shared', event_kind: 'eligible', event_id: 'es1', impression_id: 'is1', tool_use_id: 'toolu_selftest_tX-sub-elig', mode: 'intervene', ts: tsAt(1) }),
        row({ sid_sha16: sid, agent_sha16: 'sub-ag', class_tag: '', trigger_or_gate_id: '', event_kind: 'session-end', event_id: 'es2', impression_id: 'is2', mode: '', ts: tsAt(11) }),
      ];
      const parsedRows = rows.map((line) => { const parts = line.split('\t'); const o = {}; V3_COLUMNS.forEach((c, i) => { o[c] = parts[i]; }); return o; });
      const dedup = mod.dedupByEventId(parsedRows);
      const idx = mod.buildSessAgentIndex(dedup.rows);
      const units = mod.buildUnits(dedup.rows);
      report('27a. TWO distinct units formed for the same (sid,class) -- one per agent, not collapsed into one', units.size === 2, 'size=' + units.size);
      const mainUnit = units.get(mod.unitKey(sid, '', 'class:shared'));
      const subUnit = units.get(mod.unitKey(sid, 'sub-ag', 'class:shared'));
      report('27b. main-session unit (agent_sha16=\'\') found independently', !!mainUnit, JSON.stringify(Array.from(units.keys())));
      report('27c. sub-agent unit (agent_sha16=\'sub-ag\') found independently', !!subUnit, JSON.stringify(Array.from(units.keys())));
      const mainOutcome = mainUnit && mod.computeUnitOutcome(mainUnit, dedup.rows, idx);
      const subOutcome = subUnit && mod.computeUnitOutcome(subUnit, dedup.rows, idx);
      report('27d. main-session unit recurs (its own would-warn/confidence=recurrence row, not stolen from the sub-agent)', !!mainOutcome && mainOutcome.included && mainOutcome.recurred === true, JSON.stringify(mainOutcome));
      report('27e. sub-agent unit does NOT recur (it has no recurrence row of its own; main session\'s recurrence never leaks into it)', !!subOutcome && subOutcome.included && subOutcome.recurred === false, JSON.stringify(subOutcome));
    }
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  const markers = iso.markersFromSource(__filename, nonce, path.basename(T));
  const fp = iso.footprint.end(fpSnap, markers);
  report('footprint: zero attributable change on the real root', !fp.red, fp.line);
  console.log(fp.line);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0 ? 0 : 1;
}
// SELFTEST-END

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return runSelfTest();
  const opts = parseArgs(argv);
  if (!opts.report) { console.error('usage: pmm-recall-m3.cjs --report [--json]'); return 1; }
  const rep = buildReport();
  if (opts.json) console.log(JSON.stringify(rep, null, 2));
  else process.stdout.write(formatText(rep));
  return 0;
}

module.exports = { resolveRoot, resolveHost, readV3Rows, dedupByEventId, buildSessAgentIndex,
  windowInfo, unitKey, buildUnits, findUnrandomizedUnits, isPolicyRandomizedRow, computeUnitOutcome,
  isPrimaryRecurrenceSignal, isSecondaryRecurrenceSignal,
  bootstrapDiffCI, buildReport, SAMPLE_SIZE_TABLE, MIN_N_PER_ARM, backfillGateClassTag, GATE_ROW_CLASS_TAG };

if (require.main === module) {
  process.exitCode = main();
}
