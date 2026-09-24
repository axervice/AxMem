#!/usr/bin/env node
// pmm-recall-classify.cjs — shared read-side class_tag backfill + display bucketing for the Bash
// pipe gate's A/B/D rows (M-SPEC RECALL-LOOP-M-SPEC-v2.md 附录 B3 补注 #2, 契约 v2.19
// conventions.gate_row_class_tag; refined by two Opus reviews, 2026-09-17: "读侧归组" and
// MEDIUM-7). Extracted out of pmm-recall-baseline.cjs (which had its own private copy) so
// pmm-recall-precision.cjs can use the EXACT same bucketing instead of its old flat '(unknown)'
// fallback, which could silently mix pre-fix gate rows with genuinely unattributable rows into one
// group and (worst case) show that mixed group as a false PASS.
//
// Problem this fixes (MEDIUM-7): gate rows written before the v2.19 fix carry class_tag='' even
// though trigger_or_gate_id is A/B/D -- all three gates implement the single lesson
// process:pipe-hides-exit-code-and-truncates-evidence. backfillGateClassTag() still sets
// row.class_tag to the real tag (so MATCHING logic -- M3's unit.cls comparison, precision's
// --unlock class filter -- keeps working transparently), but flags the row `_class_tag_derived`
// so DISPLAY grouping (baseline's aggregate(), precision's groupBy()) can keep derived-old and
// native-new rows in visibly distinct buckets instead of silently merging them, and can label a
// truly-unattributable row (empty class_tag, non-gate trigger_or_gate_id) as the literal "(n/a)"
// rather than a blank string that used to fall into a catch-all "(unknown)".
//
// READ-ONLY: nothing in this module writes anything; the ledger file is never rewritten.
//
// Exported surface: GATE_ROW_KINDS, GATE_ROW_CLASS_TAG, backfillGateClassTag(row),
// displayClassTag(row), gateClassTagSwitchoverMs(rows, tsMsFn).
'use strict';

const GATE_ROW_KINDS = new Set(['A', 'B', 'D']);
const GATE_ROW_CLASS_TAG = 'process:pipe-hides-exit-code-and-truncates-evidence';

// backfillGateClassTag(row): mutates and returns `row`. Functional backfill (matching/counting
// still works transparently) PLUS a provenance flag for display bucketing.
function backfillGateClassTag(row) {
  if (row.class_tag === '' && GATE_ROW_KINDS.has(row.trigger_or_gate_id)) {
    row.class_tag = GATE_ROW_CLASS_TAG;
    row._class_tag_derived = true;
  }
  return row;
}

// displayClassTag(row): the class_tag to use for GROUPING/DISPLAY purposes only -- never for
// matching (matching always reads row.class_tag directly, which backfillGateClassTag already set
// to the real functional tag). A derived-old row displays in a visibly distinct
// "<tag> (pre-class_tag)" bucket; a row that could never be attributed at all (empty class_tag,
// non-gate trigger_or_gate_id) displays as the literal "(n/a)" instead of a blank string.
function displayClassTag(row) {
  const cls = row.class_tag || '';
  if (row._class_tag_derived) return cls + ' (pre-class_tag)';
  if (!cls) return '(n/a)';
  return cls;
}

// gateClassTagSwitchoverMs(rows, tsMsFn): earliest ts (as epoch ms) among NATIVE (non-derived) rows
// carrying GATE_ROW_CLASS_TAG; null if none observed yet (every row for that lesson is still
// derived). `tsMsFn` is a caller-supplied ts parser (e.g. `(ts) => { const n = Date.parse(ts);
// return Number.isNaN(n) ? null : n; }`) so this module never hardcodes one caller's date convention.
function gateClassTagSwitchoverMs(rows, tsMsFn) {
  let switchoverMs = null;
  for (const r of rows) {
    if (r._class_tag_derived) continue;
    if (r.class_tag !== GATE_ROW_CLASS_TAG) continue;
    const ms = tsMsFn(r.ts);
    if (ms !== null && ms !== undefined && (switchoverMs === null || ms < switchoverMs)) switchoverMs = ms;
  }
  return switchoverMs;
}

module.exports = { GATE_ROW_KINDS, GATE_ROW_CLASS_TAG, backfillGateClassTag, displayClassTag, gateClassTagSwitchoverMs };

// ============================================================================
// --self-test
// ============================================================================
if (require.main === module && process.argv[2] === '--self-test') {
  let PASS = 0, FAIL = 0;
  function report(name, ok, detail) {
    if (ok) { console.log('PASS: ' + name); PASS++; }
    else { console.log('FAIL: ' + name + ' -- ' + (detail || '')); FAIL++; }
  }

  report('backfillGateClassTag: empty class_tag + trigger A -> backfilled + flagged derived', (() => {
    const r = backfillGateClassTag({ class_tag: '', trigger_or_gate_id: 'A' });
    return r.class_tag === GATE_ROW_CLASS_TAG && r._class_tag_derived === true;
  })());
  report('backfillGateClassTag: empty class_tag + trigger B/D also backfilled', (() => {
    const rb = backfillGateClassTag({ class_tag: '', trigger_or_gate_id: 'B' });
    const rd = backfillGateClassTag({ class_tag: '', trigger_or_gate_id: 'D' });
    return rb.class_tag === GATE_ROW_CLASS_TAG && rd.class_tag === GATE_ROW_CLASS_TAG;
  })());
  report('backfillGateClassTag: empty class_tag + non-gate trigger_or_gate_id -> UNCHANGED, not flagged', (() => {
    const r = backfillGateClassTag({ class_tag: '', trigger_or_gate_id: 'not-a-gate' });
    return r.class_tag === '' && !r._class_tag_derived;
  })());
  report('backfillGateClassTag: already-populated class_tag -> untouched even with gate trigger_or_gate_id', (() => {
    const r = backfillGateClassTag({ class_tag: 'class:already', trigger_or_gate_id: 'A' });
    return r.class_tag === 'class:already' && !r._class_tag_derived;
  })());

  report('displayClassTag: derived row -> "<tag> (pre-class_tag)"', displayClassTag({ class_tag: GATE_ROW_CLASS_TAG, _class_tag_derived: true }) === GATE_ROW_CLASS_TAG + ' (pre-class_tag)');
  report('displayClassTag: native row with the same tag -> plain tag, no suffix', displayClassTag({ class_tag: GATE_ROW_CLASS_TAG }) === GATE_ROW_CLASS_TAG);
  report('displayClassTag: truly empty class_tag -> literal "(n/a)"', displayClassTag({ class_tag: '' }) === '(n/a)');
  report('displayClassTag: ordinary trigger-lesson class_tag -> passthrough unchanged', displayClassTag({ class_tag: 'class:ordinary' }) === 'class:ordinary');

  function tsMs(ts) { const n = Date.parse(ts); return Number.isNaN(n) ? null : n; }
  report('gateClassTagSwitchoverMs: earliest NATIVE row wins, derived rows ignored even if earlier', (() => {
    const rows = [
      { class_tag: GATE_ROW_CLASS_TAG, _class_tag_derived: true, ts: '2026-01-01T00:00:00.000Z' }, // derived, earlier -- must be ignored
      { class_tag: GATE_ROW_CLASS_TAG, ts: '2026-03-01T00:00:00.000Z' }, // native, later
      { class_tag: GATE_ROW_CLASS_TAG, ts: '2026-02-01T00:00:00.000Z' }, // native, earliest of the natives
    ];
    return gateClassTagSwitchoverMs(rows, tsMs) === Date.parse('2026-02-01T00:00:00.000Z');
  })());
  report('gateClassTagSwitchoverMs: no native rows at all -> null', gateClassTagSwitchoverMs([{ class_tag: GATE_ROW_CLASS_TAG, _class_tag_derived: true, ts: '2026-01-01T00:00:00.000Z' }], tsMs) === null);
  report('gateClassTagSwitchoverMs: empty rows -> null', gateClassTagSwitchoverMs([], tsMs) === null);
  report('gateClassTagSwitchoverMs: unparsable ts on the only native row -> null (never a bogus number)', gateClassTagSwitchoverMs([{ class_tag: GATE_ROW_CLASS_TAG, ts: 'not-a-date' }], tsMs) === null);
  report('gateClassTagSwitchoverMs: rows of a DIFFERENT class_tag never count', gateClassTagSwitchoverMs([{ class_tag: 'class:other', ts: '2026-01-01T00:00:00.000Z' }], tsMs) === null);

  console.log();
  console.log('==================================================');
  console.log('Summary: ' + PASS + ' passed, ' + FAIL + ' failed');
  console.log('==================================================');
  process.exit(FAIL > 0 ? 1 : 0);
}
