'use strict';
// pipe-gate-v2 acceptance mutant: "blind-parser"
// Per contract v2.4 mutants.definitions.blind-parser: "parse(cmd) =
// deepClone(realParse(cmd)) then: for every segment set status_refs=[],
// redirects=[], assignments=[], and for every arg set expansion_refs=[],
// unresolved_variables=[], decoded=raw (unexpanded); set
// parser_version="1.2-blind-<nonce>"; every other field (including
// scope_id, groups, scopes, source_span, negated, group,
// shell_option_changes) is untouched."
//
// This module is now a PURE TRANSFORM of whatever the real, committed
// parser (`pmm-cmd-parse.cjs`) actually returns -- it deep-clones the real
// output and zeroes out only the four named fields (plus per-arg
// sub-fields), never reshaping, never inventing scope_id/groups/source_span
// values, never wrapping args in a second layer beyond what's needed to
// carry the per-arg zeroed sub-fields. Today's real parser is v1.1, whose
// `args` are plain strings; since the definition requires PER-ARG
// expansion_refs/unresolved_variables/decoded fields to exist (zeroed), a
// plain string arg is lifted into `{raw, decoded: raw, quote: 'none',
// expansion_refs: [], unresolved_variables: []}` -- the minimal shape that
// can carry those required sub-fields. An arg that is ALREADY an object
// (once the real parser is upgraded to true v1.2) has its OWN raw/quote/etc.
// preserved and only expansion_refs/unresolved_variables/decoded touched.
//
// causal_sentinels (v2.4): parser_version becomes "1.2-blind-<nonce>" (nonce
// from PIPE_GATE_INJECT_NONCE), which the gate must propagate into the
// ledger's parser_version column. The runner asserts the nonce actually
// reached the ledger, not just that this function was called.

const fs = require('fs');
const path = require('path');

function probe(fnName) {
  try {
    const root = process.env.PMM_RECALL_ROOT;
    if (!root) return;
    const line = 'blind-parser\t' + fnName + '\t' + Date.now() + '\n';
    fs.appendFileSync(path.join(root, 'probe.log'), line, 'utf8');
  } catch (_e) {
    // Probing must never throw into the gate's judgment path.
  }
}

const REAL_PARSER_PATH = path.join(__dirname, '..', 'pmm-cmd-parse.cjs');
let realParseCommand = null;
try {
  realParseCommand = require(REAL_PARSER_PATH).parseCommand;
} catch (_e) {
  realParseCommand = null;
}

function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

function blindArg(a) {
  if (a && typeof a === 'object') {
    const out = deepClone(a);
    out.expansion_refs = [];
    out.unresolved_variables = [];
    out.decoded = out.raw;
    return out;
  }
  // Plain string (today's real v1.1 shape) -- lifted to the minimal object
  // shape needed to carry the required zeroed per-arg sub-fields.
  return { raw: a, decoded: a, quote: 'none', expansion_refs: [], unresolved_variables: [] };
}

function parse(cmdText, ctx) {
  probe('parse');
  const nonce = process.env.PIPE_GATE_INJECT_NONCE || 'no-nonce';
  if (!realParseCommand) {
    return { parser_version: '1.2-blind-' + nonce, segments: [] };
  }
  const real = realParseCommand(cmdText, ctx);
  const cloned = deepClone(real);
  for (const seg of cloned.segments || []) {
    seg.status_refs = [];
    seg.redirects = [];
    seg.assignments = [];
    if (Array.isArray(seg.args)) seg.args = seg.args.map(blindArg);
    // Every other field on the segment (exe, sub, sep_before, pipeline_*,
    // parse_status, kind, negated, group, shell_option_changes, scope_id,
    // etc.) is left exactly as the real parser produced it.
  }
  cloned.parser_version = '1.2-blind-' + nonce;
  // groups[]/scopes[]/unresolved_variables (top-level) are untouched --
  // whatever the real parser did or did not produce for them is preserved
  // verbatim by deepClone; this mutant does not add or remove top-level keys.
  return cloned;
}

module.exports = { parse };
