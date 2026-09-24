'use strict';
// pipe-gate-v2 acceptance mutant: "null"
// Per contract v2.4 mutants.definitions.null: "judge returns no findings AND
// no informational events (unsupported, path_unresolved, cd-hint are
// produced by judge); parse and receipts unchanged". This module overrides
// ONLY `judge` — it does NOT export `parse`, so the gate (per DI-seam
// contract: "缺省导出的函数由闸用自己的实现") falls back to its own real
// parser for `parse`.
//
// No causal-sentinel nonce is needed for this mutant: its signature is the
// ABSENCE of gate rows/informational events, which the runner verifies
// directly against the ledger (see deriveNullFail in
// pipe-gate-v2-acceptance.cjs) rather than via a planted marker.
//
// This file must never be reachable from the gate's production path: the seam
// (`PIPE_GATE_INJECT` + `PIPE_GATE_SELFTEST=1`) is honored only when
// `PIPE_GATE_INJECT` resolves inside `PMM_RECALL_ROOT`, which only the acceptance
// runner sets, and only from a temp root it owns. See pipe-gate-v2-acceptance.cjs.
//
// Every call is probed: one line appended to `<PMM_RECALL_ROOT>/probe.log` in the
// form `<mutant>\t<function>\t<ts>`, so the runner can assert (probe_rule) that the
// production judgment path actually passed through this file and did not silently
// keep using its own real judge().

const fs = require('fs');
const path = require('path');

function probe(fnName) {
  try {
    const root = process.env.PMM_RECALL_ROOT;
    if (!root) return;
    const line = 'null\t' + fnName + '\t' + Date.now() + '\n';
    fs.appendFileSync(path.join(root, 'probe.log'), line, 'utf8');
  } catch (_e) {
    // Probing must never throw into the gate's judgment path.
  }
}

function judge(parsed, ctx) {
  probe('judge');
  void parsed;
  void ctx;
  // No findings, no informational events -- literal per contract v2.4.
  return { gates: [], events: [] };
}

module.exports = { judge };
