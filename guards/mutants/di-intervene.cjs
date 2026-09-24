'use strict';
// pipe-gate-v2 acceptance DI helper: "di-intervene" (NOT one of the 3 official
// mutants scored by the mutation round — it is the acceptance runner's own
// mechanism for forcing `mode: "intervene"` test cases deterministically,
// per brief PIPE-GATE-V2-REPAIR-BRIEF.md §6: "intervene 分配函数:
// assignment(full_session_id, class_tag) 在 M0/M1 阶段是常量 shadow ...
// A/D 的输出只看它 ... 自测 DI 强制 intervene". `PMM_RECALL_MODE` is
// explicitly ignored on the production path (contract case Z09), so the
// ONLY sanctioned way to exercise intervene-mode behavior in tests is
// through this same PIPE_GATE_INJECT/PIPE_GATE_SELFTEST seam, injecting an
// `assignment` override.
//
// Exports ONLY `assignment` — never `judge`/`parse` — so it composes cleanly
// with any of the 3 official mutants via the runner's combined shim (the
// runner re-exports `assignment` from this file and `judge`/`parse` from the
// active mutant, if any, into one temporary module passed as
// PIPE_GATE_INJECT).
//
// Probed like the other mutant/DI modules: one line per call to
// `<PMM_RECALL_ROOT>/probe.log`.

const fs = require('fs');
const path = require('path');

function probe(fnName) {
  try {
    const root = process.env.PMM_RECALL_ROOT;
    if (!root) return;
    const line = 'di-intervene\t' + fnName + '\t' + Date.now() + '\n';
    fs.appendFileSync(path.join(root, 'probe.log'), line, 'utf8');
  } catch (_e) {
    // Probing must never throw into the gate's judgment path.
  }
}

function assignment(fullSessionId, classTag) {
  probe('assignment');
  void fullSessionId;
  void classTag;
  return 'intervene';
}

module.exports = { assignment };
