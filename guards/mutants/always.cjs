'use strict';
// pipe-gate-v2 acceptance mutant: "always"
// Per contract v2.4 mutants.definitions.always: "judge returns exactly one
// finding {gate:A, confidence:recurrence, class_tag:"mutant-always-<nonce>"}
// for every event; parse unchanged." Only `judge` is overridden; `parse` is
// left for the gate's own real implementation (contract:
// "缺省导出的函数由闸用自己的实现").
//
// causal_sentinels (v2.4): the nonce is passed by the runner via
// PIPE_GATE_INJECT_NONCE and MUST be written verbatim into the finding's
// class_tag, which the gate is required to propagate into the ledger's
// class_tag column. The runner asserts the nonce actually reached the
// ledger for every case that produced a row -- proving the RETURN VALUE
// drove the result, not merely that this function was called (probe.log
// growth alone is insufficient per codex HIGH-6).
//
// Probing: same contract as null.cjs / blind-parser.cjs / di-intervene.cjs —
// one line per call to `<PMM_RECALL_ROOT>/probe.log` (secondary evidence
// only).

const fs = require('fs');
const path = require('path');

function probe(fnName) {
  try {
    const root = process.env.PMM_RECALL_ROOT;
    if (!root) return;
    const line = 'always\t' + fnName + '\t' + Date.now() + '\n';
    fs.appendFileSync(path.join(root, 'probe.log'), line, 'utf8');
  } catch (_e) {
    // Probing must never throw into the gate's judgment path.
  }
}

function judge(parsed, ctx) {
  probe('judge');
  void parsed;
  void ctx;
  const nonce = process.env.PIPE_GATE_INJECT_NONCE || 'no-nonce';
  // Exactly one finding, every time, regardless of what was actually parsed.
  // The real disposition logic downstream of judge() (mode/assignment-driven
  // would-warn vs emitted, and gate B's permanent-shadow carve-out — which does
  // NOT apply here since this mutant only ever reports gate 'A') is untouched.
  return { gates: [{ gate: 'A', confidence: 'recurrence', class_tag: 'mutant-always-' + nonce }], events: [] };
}

module.exports = { judge };
