#!/usr/bin/env node
'use strict';
/*
 * pipe-gate-v2-acceptance.cjs — external acceptance runner for the Bash pipe
 * gate v2 (specs/PIPE-GATE-V2-REPAIR-BRIEF.md, specs/pipe-gate-v2-test-contract.json
 * v2.7, specs/pmm-cmd-parse-conformance.json v1.2.2).
 *
 * AUTHORSHIP / TRUST BOUNDARY: this file, together with mutants/{null,always,
 * blind-parser,di-intervene}.cjs, is written by a non-builder agent and
 * committed BEFORE any v2 gate implementation exists. The builder must not
 * edit this file or the mutants; the dispatch prompt pins their git blobs
 * (see --pins).
 *
 * v2.4 revision notes (codex round 3, review-20260916T231428Z, 6H/2M/1L):
 *   - Executes the pinned parser conformance fixture (118 cases at 1.2.8)
 *     against the
 *     PRODUCTION pmm-cmd-parse.cjs (HIGH-1/HIGH-6), not just the gate
 *     contract.
 *   - lifecycle executors fixed to match the contract's literal recipes:
 *     clock rewrites the receipt file's `ts` column (not mtime), receipts
 *     live at <root>/receipts-*.log (no subdirectory), L09 uses a genuinely
 *     closed stdout fd, L15/L15b use real async-spawn + barrier-file
 *     concurrency (HIGH-2).
 *   - Mutant modules are pure transforms of the real parse/judge output,
 *     carrying a per-run nonce the runner verifies actually reached the
 *     ledger/stdout — not just that the injected function was CALLED
 *     (HIGH-4/HIGH-6 causal_sentinels).
 *   - Derivation functions operate on the case's EXPECTATION STRUCTURE, not
 *     command-text regex (HIGH-4).
 *   - Ledger read-side aggregation: dedupe by event_id first (report
 *     duplicate rate), then require each impression_id's gate-bearing rows
 *     to agree on {gate,confidence} (conflict = red), then compare the
 *     distinct-impression multiset (HIGH-5/LOW-1).
 *   - session_id/agent_id/prompt_id/tool_use_id are crypto.randomUUID()
 *     every run, never containing the case id (HIGH-6 conventions.ids).
 *     (v2.26 erratum 2: tool ids toolu_selftest_<uuid>, sessions test:<uuid>.)
 *   - Runner also invokes the production gate's own --self-test, checks
 *     settings.json wiring, guard-canary roster, and git-blob pins
 *     (HIGH-6 runner_duties / G05-G08).
 *   - Runner refuses any contract whose `version` is not exactly "2.4".
 *
 * v2.7 revision notes (Opus round 6, OPUS-2026-09-16-pipe-gate-v2.6-round6.md,
 * 6H/11M/6L — the runner-side items):
 *   - HIGH-1 transformForAlways maps ANY gates array to EXACTLY ONE
 *     {A,recurrence} (mutants/always.cjs returns exactly one finding per
 *     judge call), so A29 is derived-red in the always round, matching
 *     actual. judge's return shape is {gates,events} everywhere (contract
 *     conventions.call_granularity / parse-contract 修订 ⑥ item 2);
 *     gate_instance_id is derived by the gate from `parsed`, never read
 *     off a finding.
 *   - HIGH-2 the closed-stdout executor is selected from the STEP HEADER
 *     ("pre(closed-stdout): ..."), not from prose that v2.5 deleted from
 *     the contract; --self-check asserts L09 actually took that path.
 *   - HIGH-4 transformForBlindParser now transforms the four row-count keys
 *     as well (they counted gate rows that blind-parser deletes).
 *   - HIGH-5 pending_files / pending_files_after are THIS case's own key
 *     (conventions.pending_files_semantics), never a global count of the
 *     shared state dir.
 *   - HIGH-6 the blind-parser round's sentinel predicate uses the MUTATED
 *     expectation (conventions.causal_sentinels / mutants.probe_rule).
 *   - MEDIUM-2 Z14 is report_only (excluded from allPass) and no longer
 *     spawns a gate-less bash of its own.
 *   - MEDIUM-4 lifecycle cases materialize their declared `files`; the
 *     "touch mtime only" op no longer creates the file it is supposed to
 *     only touch.
 *   - MEDIUM-7 receipt-lost / pending-expired are looked up ONLY under the
 *     original pending's tool_use_id, and asserted absent under the GC
 *     event's id (conventions.row_attribution).
 *   - MEDIUM-9 the conformance fixture's version / parser_version_required
 *     are hard-rejected like the contract version.
 *   - MEDIUM-11 G04 asserts that duplicate event_id rows are genuinely
 *     TOLERABLE (identical outside `ts`), not just counted.
 *   - Runner refuses any contract whose `version` is not exactly "2.7".
 *
 * v2.8 sync (contract 00c5244, blob a7a0fce7; brief §16). The spec owner
 * reproduced and accepted all three defects this runner reported:
 *   - lifecycle_executors["closed stdout"] now pins
 *     `bash -c "exec 1</dev/null; exec bash <gate.sh>"` -- fd 1 OPEN
 *     READ-ONLY, so every write(1,...) fails with EBADF. The old
 *     `exec 1>&-` recipe cannot work against a Node gate (Node reopens
 *     closed fds 0-2 onto the null device at startup), and the contract now
 *     also REQUIRES the self-check to preflight the recipe with a `node -e`
 *     write before executing L09.
 *   - mutants.derivation withdrew the always clause "intervene cases
 *     expecting stdout 0 fail", so L09 stays GREEN under always and must not
 *     be derived red.
 *   - conventions.causal_sentinels now states the skip rule in the same
 *     words as mutants.probe_rule (MUTATED expectation).
 *   - Runner refuses any contract whose `version` is not exactly "2.8".
 *
 * v2.9 sync (contract 26bd8f2, blob 971b86ae; brief §17), after Opus round 7
 * (audits/OPUS-2026-09-16-pipe-gate-v2.8-round7.md, NO-GO, 3H/5M/6L):
 *   - HIGH-1/HIGH-3 conventions.impression_id now pins gate_instance_id PER
 *     GATE KIND (A = <pid>:<pid>, B = <pid>:<seg>, D = <pid>:<seg>:<operand>)
 *     and conventions.ordinal keys the ordinal off it, so D17's two operands
 *     and A12's A-and-B-in-one-segment no longer collide into one impression.
 *     The self-check stub implements that, and D17/A12 joined the subset.
 *   - HIGH-2 L15b's concurrent Pre re-enters the ORIGINAL tool_use_id and the
 *     ORIGINAL redirecting command, so it really races the consuming Post;
 *     new expect key pending_files_after_in (0 or 1 both legal).
 *   - MEDIUM-1 the fd preflights run in the production and mutant rounds too.
 *   - MEDIUM-2 dispositionOk asserts conventions.gate_disposition_map.
 *   - MEDIUM-3 lifecycle actual always carries stderr_size and rc.
 *   - MEDIUM-4 transformForAlways recomputes the row-count keys.
 *   - MEDIUM-5 silence cases get a known-key gate and an exact informational
 *     event-set comparison.
 *   - Runner refuses any contract whose `version` is not exactly "2.9".
 *
 * v2.10 sync (contract f135dcd, blob 21176b77; brief §18), after Opus round 8
 * (GO-WITH-CHANGES, 0H/2M/6L -- every round-7 item verified closed):
 *   - LOW-2 row_column_shape was asserted in allPass with no contract clause
 *     behind it; it is now ledger case G10 and reports under that id.
 *   - MEDIUM-2 execSilenceCase falls back to silenceEventsCheck for every
 *     silence case whose handler produced no events evidence, so "no events
 *     key means events: []" finally binds all of them; the cases that cannot
 *     supply a tool_use_id (no parseable hook) are exempt BY NAME in the
 *     report instead of silently skipped.
 *   - LOW-1 dispositionOk reaches the three silence handlers that check gates.
 *   - LOW-3 the always round's sentinel predicate also uses the MUTATED
 *     expectation, as conventions.causal_sentinels says.
 *   - LOW-4 L15b's interleaved processes report stderr/rc.
 *   - LOW-6 the four broad English words are report-only per
 *     conventions.inference_wording_scan.
 *   - Runner refuses any contract whose `version` is not exactly "2.10".
 *
 * v2.11 sync (contract 1c0a9cd, blob af54654c; fixture 1.2.3, blob 515615b1;
 * brief §19). Builder-1's stop report -- zero code written -- showed fixture
 * 1.2.2 was internally contradictory: the M series carried v1.1-shaped
 * `args` (plain strings) and v1.1-shaped `redirects` ({op,target}) next to
 * the C/R series' v1.2 objects, and compareParserExpectation deep-compares
 * every asserted key, so NO parser could ever score 104/104. Eight review
 * rounds, this one included, checked that each case was individually
 * well-formed and never checked that the families agreed with each other.
 *   - The fixture dropped those 14 v1.1-shaped keys (1.2.3).
 *   - conventions.fixture_shape_consistency makes the cross-family shape a
 *     LOAD-TIME assertion here, so the same contradiction cannot be
 *     reintroduced silently: a violating fixture aborts the run (rc 2) and
 *     names the case id and field.
 *   - Runner refuses any contract that is not "2.11" or any fixture that is
 *     not "1.2.3".
 *
 * v2.12 sync (contract e3530f2, blob 37105f30; fixture 1.2.4, blob c5b9bbbc;
 * brief §20), from builder-1's delivery report on parser 1.2 (2bc8d85,
 * 103/104). The one red, C-scope-root, was a third fixture/runner defect of
 * the same family as the last two:
 *   - the case carried expect.scopes and NO expect.segments, and
 *     compareParserExpectation read a missing segments key as "expect zero
 *     segments", so a 3-segment command was judged against 0;
 *   - no version of this runner had EVER read .scopes, so C-A30's scopes
 *     assertion was dead too -- a whole asserted field that nothing compared.
 * Fixed here per contract: scopes are compared (conventions.
 * parser_scopes_comparison) and a case without expect.segments is a
 * load-time violation instead of an implicit zero.
 *   - Runner refuses any contract that is not "2.12" or any fixture that is
 *     not "1.2.4".
 *
 * v2.13 sync (contract 9a9274d, blob 8d15704b; brief §21), from builders 2-4's
 * delivery evidence. All three remaining reds were on this side of the seam:
 *   - conventions.lifecycle_ops: every "write N bytes" / "append N bytes" the
 *     runner performs must be UNIQUE to that case and step. L19b was writing
 *     the same twelve 'w' bytes to the same shared r.txt that L16/L17 had
 *     already written, so its "write" was a byte-identical rewrite -- the
 *     distinct "unchanged" scenario -- and the receipt could only be a
 *     candidate, never the recurrence L19b asserts.
 *   - conventions.lifecycle_executors["restricted PATH ..."]: resolve the
 *     interpreter's absolute path BEFORE restricting the environment. The old
 *     PATH=/usr/bin:/bin spawn of "bash" is ENOENT on this host (MSYS-virtual
 *     paths are not resolvable by spawnSync), so Z06 proved nothing: the gate
 *     never started.
 *   - mutants.derivation: a pending the RUNNER synthesizes (L18 truncates the
 *     pending file, creating one if absent) is not redirect-driven, so it must
 *     not put the case in the blind-parser derived set.
 *   - Runner refuses any contract that is not "2.13".
 *
 * v2.14 sync (contract de93345, blob e590cd0d; brief §22), from the Opus build
 * acceptance (GO-WITH-CHANGES, 1H/3M/5L):
 *   - MEDIUM-2 conventions.informational_row_attribution: every informational
 *     row carries gate and trigger_or_gate_id per gate_disposition_map
 *     (unsupported -> A/A, the rest -> D/D, session-end both empty). Nothing
 *     read those columns on informational rows, so they could be -- and are --
 *     written empty and no case noticed (lesson
 *     process:oracle-field-must-be-proven-read).
 *   - LOW-4 the disposition report lists each impression so brief §15's
 *     instance evidence is reviewable from the report.
 *   - conventions.g02_note: G02 now says whether the default production root
 *     it compared was itself inside a temp HOME (in which case it compared
 *     0 files with 0 and proves only the homedir-fallback property).
 *   - Runner refuses any contract that is not "2.14".
 *
 * v2.15 sync (contract 01d7659, blob efeba457; brief §23), from codex gf's
 * final wave (6H/2M, all accepted):
 *   - H1 G07: the pins file's key set is now exact and validated BEFORE any
 *     case runs (an empty {} used to pass G07 vacuously), and the contract and
 *     conformance blobs hashed are the ones this run is ACTUALLY executing,
 *     not the defaults.
 *   - H5 conventions.parser_mandatory_fields: the parser's ACTUAL output is
 *     schema-checked on every conformance case, independently of what each
 *     fixture expectation happens to list (source_span was missing from every
 *     segment and pure-assignment segments kept the raw string in args, while
 *     104/104 stayed green).
 *   - H6 G05: five exact wiring instances, each parsed into argv, required to
 *     name an absolute path that EQUALS the guards file (substring matching
 *     let `echo bash-pipe-exitcode-watch.sh` pass), and each launched once
 *     from a temp copy whose path contains a space.
 *   - M7 conventions.row_attribution: receipt-lost / pending-expired rows must
 *     carry the ORIGINAL pending's identity columns, not the GC event's.
 *   - Runner refuses any contract that is not "2.15".
 *
 * v2.16 sync (contract 4543c9b, blob b13cc658, 125 cases; fixture 1.2.5, blob
 * 3b7e4f45, 108 cases; parse-contract amendment 7), from the fab blind attack
 * (1H/4M, all accepted):
 *   - H01/H02/H03 heredoc: the FIRST line of a heredoc carries real redirects
 *     and a real pipe, so a heredoc write opens a pending and a heredoc pipe
 *     followed by $? must be counted; the segment is an unsupported
 *     informational row (gate A/A) and is never judged for A/B.
 *   - A31: a function definition body is one unsupported:function-def segment
 *     (no false A from the pipeline inside it, no pipefail leak out of it).
 *   - Z23: PMM_CMD_PARSE_MUTANT=flat in the environment must not change
 *     production judgment -- the parser must stop reading that variable, and
 *     the runner must stop setting it (G08's flat round now calls
 *     applyFlatMutant directly).
 *   - L22: a pending held with FileShare.None while the Post runs must not
 *     lose the receipt.
 *   - G05 v2.16: every Pre/Post/PostToolUseFailure wiring instance is also
 *     launched under a PATH without node, and must be byte-silent there.
 *   - Runner refuses any contract that is not "2.16" or any fixture that is
 *     not "1.2.5".
 *
 * v2.17 / fixture 1.2.6 (17dc66f; contract blob 2109eae5, fixture blob
 * d326bf2a): parser amendment 7 landed (1dc9e58) and caught two fixture
 * mistakes -- kind "simple" where the contract only has command|assignment,
 * and C-A18 asserting redirects [] while being the same shape as C-H01. A18
 * now expects events ["unsupported"], because a heredoc segment is counted as
 * an unsupported informational row (conventions.heredoc_segments). Constants
 * only on this side.
 *   - Runner refuses any contract that is not "2.17" or any fixture that is
 *     not "1.2.6".
 *
 * v2.26 / fixture 1.2.9 (f3120ce; contract blob 38070b6d, fixture blob
 * 3bcd5d0e; brief s33, Opus codex-final triage #1/#5 + Opus acceptance
 * MEDIUM-P1/LOW-P2). Three self-check segments could not turn red; this
 * revision gives each one a constructed bad state that it must red on:
 *   - part13 (conventions.home_literal_scan): hard-coded home literals
 *     (the class of 9e4f477^ pmm-trigger-recall.cjs:65 and 5521f82^
 *     pmm-bash-impression.cjs:110, both hit=false before) and four cheap read
 *     forms (cd ~ / ~/ in shell code, require(os).homedir, process.env[..],
 *     destructuring from process.env); per-LINE allowlist only.
 *   - part14 (conventions.home_only_proof a-f): runs by default including the
 *     G11 trigger-recall sub-case (--home-only-ledger is a no-op alias), the
 *     watched set follows the .local/pmm-recall migration, every id is a
 *     run-nonce id, markers include the computed seen file NAME and are also
 *     matched against file names, and the gate sub-cases run the PRODUCTION
 *     gate (the reference stub cannot reach any root without PMM_*).
 *   - part15 (home_only_proof g): an env-echo reference stub proves children
 *     see no PMM_HOME/PMM_RECALL_ROOT under childEnvBase(); the no-strip
 *     mutation is carried as a negative fixture that must red.
 *   - part16 (conventions.selftest_id_convention): static scan of guards/*.cjs
 *     for tool_use_id literals carrying neither selftest nor tu-.
 *   - Runner refuses any contract that is not "2.26" or any fixture that is
 *     not "1.2.9".
 *
 * v2.26 erratum 2 / fixture 1.2.10 (acfcfb0; contract blob f6eb5252, fixture
 * blob 7a176504; Opus B1+B2 review OPUS-2026-09-23-b1-b2-review.md):
 *   - ids (B1 MEDIUM-1): randId(kind) mints toolu_selftest_<uuid> tool ids and
 *     test:<uuid> session ids everywhere (part14: toolu_selftest_<nonce>_<n> /
 *     test:g11-<nonce>-<n>); the Z10 family's dirty ids start tu- before the
 *     injected characters; part16 also scans session literals and asserts the
 *     runner's own ids by execution.
 *   - part14 (B1 LOW-1): receipts-*.log and pending/* are watched, the run
 *     root basename is a marker, and a created MACHINE-NAMED watched file
 *     (events-v3/queue/quarantine/trigger-log-*.tsv, policy.json) is
 *     attributable without a marker (erratum 3, 0422c9e: pending/receipts and
 *     seen files are attributed by marker only -- production creates them).
 *   - part13 (B1 LOW-2/LOW-3/INFO): allowlist entries match exact text ONCE
 *     per file, comment lines follow the file type (.sh: # and *; .cjs: //
 *     and slash-star blocks only), Users matches case-insensitively.
 *   - writer_segment_rule (erratum 2): pure pass-through = tee, cat without a
 *     file operand, or a browse-denylist exe -- the reading B1-tail already
 *     implemented, now the contract's text.
 *   - Runner refuses any contract that is not "2.26" or any fixture that is
 *     not "1.2.10".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn, execFileSync } = require('child_process');

const GUARDS_DIR = __dirname;
const DEFAULT_CONTRACT = path.join(GUARDS_DIR, 'specs', 'pipe-gate-v2-test-contract.json');
const DEFAULT_CONFORMANCE = path.join(GUARDS_DIR, 'specs', 'pmm-cmd-parse-conformance.json');
const DEFAULT_GATE_CMD = 'bash ' + path.join(GUARDS_DIR, 'bash-pipe-exitcode-watch.sh');
const DEFAULT_PARSER_MODULE = path.join(GUARDS_DIR, 'pmm-cmd-parse.cjs');
const DEFAULT_PRODUCTION_ROOT = path.join(os.homedir(), '.claude', '.local', 'pmm-recall');
const LEDGER_MODULE_PATH = path.join(GUARDS_DIR, 'pmm-recall-ledger.cjs');
const SETTINGS_JSON_PATH = path.join(GUARDS_DIR, '..', 'settings.json');
const GUARD_CANARY_PATH = path.join(GUARDS_DIR, 'guard-canary.sh');
const REQUIRED_CONTRACT_VERSION = '2.26';
// MEDIUM-9 (Opus r6): the contract version was hard-rejected but the
// conformance fixture's own version was not -- fixture drift was only
// caught by G07's blob pins, which are absent on any hand run. Both the
// fixture `version` and its `parser_version_required` are now hard
// failures, exactly like the contract version.
const REQUIRED_FIXTURE_VERSION = '1.2.10';
const REQUIRED_FIXTURE_PARSER_VERSION = '1.2';

const MUTANT_PATHS = {
  null: path.join(GUARDS_DIR, 'mutants', 'null.cjs'),
  always: path.join(GUARDS_DIR, 'mutants', 'always.cjs'),
  'blind-parser': path.join(GUARDS_DIR, 'mutants', 'blind-parser.cjs'),
};
const DI_INTERVENE_PATH = path.join(GUARDS_DIR, 'mutants', 'di-intervene.cjs');

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = {
    contract: DEFAULT_CONTRACT,
    conformance: DEFAULT_CONFORMANCE,
    parserModule: DEFAULT_PARSER_MODULE,
    gate: DEFAULT_GATE_CMD,
    root: null,
    mutant: 'none',
    report: null,
    selfCheck: false,
    nonInteractive: false,
    pins: null,
    skipG09: false,
    alwaysReport: null,
    nullReport: null,
    homeOnlyLedgerAlias: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--contract') out.contract = argv[++i];
    else if (a === '--conformance') out.conformance = argv[++i];
    else if (a === '--parser-module') out.parserModule = argv[++i];
    else if (a === '--gate') out.gate = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--mutant') out.mutant = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--self-check') out.selfCheck = true;
    else if (a === '--non-interactive') out.nonInteractive = true;
    else if (a === '--pins') out.pins = argv[++i];
    else if (a === '--skip-g09') out.skipG09 = true;
    else if (a === '--always-report') out.alwaysReport = argv[++i];
    else if (a === '--null-report') out.nullReport = argv[++i];
    // contract v2.26 home_only_proof (a): part14 (ledger sub-case included)
    // now runs by default inside --self-check; the old opt-in flag is kept as
    // a no-op alias for one release so existing invocations do not exit 2.
    else if (a === '--home-only-ledger') out.homeOnlyLedgerAlias = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { process.stderr.write('unknown argument: ' + a + '\n'); process.exit(2); }
  }
  if (!['none', 'null', 'always', 'blind-parser'].includes(out.mutant)) {
    process.stderr.write('--mutant must be one of null|always|blind-parser|none\n');
    process.exit(2);
  }
  // G09 contract text: "--skip-g09 is not allowed in --non-interactive".
  // Rather than a hard exit (which would break an otherwise-valid canary
  // invocation over one flag), the flag is silently overridden and the
  // override is surfaced in the report (ledger.G09.skip_g09_overridden).
  if (out.skipG09 && out.nonInteractive) out.skipG09 = false;
  return out;
}

// Counted, never asserted: a help line must not be able to fail a run, so a
// fixture that cannot be read simply says so.
function describeConformanceFixture() {
  let n = null;
  try { n = (JSON.parse(fs.readFileSync(DEFAULT_CONFORMANCE, 'utf8')).cases || []).length; } catch (_e) { n = null; }
  return (n === null ? 'parser fixture' : n + '-case parser fixture') +
    ', version "' + REQUIRED_FIXTURE_VERSION + '"';
}
function printHelp() {
  process.stdout.write([
    'pipe-gate-v2-acceptance.cjs [options]',
    '  --contract <path>      default: specs/pipe-gate-v2-test-contract.json (must be version "' + REQUIRED_CONTRACT_VERSION + '")',
    '  --conformance <path>   default: specs/pmm-cmd-parse-conformance.json (' + describeConformanceFixture() + ')',
    '  --parser-module <path> default: pmm-cmd-parse.cjs (production parser, required to export parseCommand)',
    '  --gate <cmd>           default: "bash bash-pipe-exitcode-watch.sh" (production entry)',
    '  --root <dir>           default: a fresh temp dir this run owns',
    '  --mutant <name>        null|always|blind-parser|none (default none)',
    '  --report <path>        write JSON report here (also printed to stdout)',
    '  --self-check           prove the runner mechanics against a throwaway stub gate + the real parser',
    '                         (part14 also runs the --gate and pmm-trigger-recall under a HOME-only redirect)',
    '  --non-interactive      assert G02 (production root byte-identical); omit it to only report G02',
    '  --pins <json>          {"contract":sha,"conformance":sha,"runner":sha,"mutants":{"null":sha,...}}',
    '                         checked against `git hash-object` of each file (G07)',
    '  --always-report <path> a JSON report already produced by --mutant always --report <path>;',
    '                         when given (with --null-report), G09 reuses it instead of re-running',
    '  --null-report <path>   same, for --mutant null',
    '  --skip-g09             skip the G09 spy assertion for faster iteration (ignored under --non-interactive)',
    '  --home-only-ledger     no-op alias (contract v2.26): the HOME-only proof incl. its G11 sub-case always runs in --self-check',
    '',
  ].join('\n'));
}

// ===========================================================================
// small utilities
// ===========================================================================

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function writeFileAtomicText(p, text) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, text, 'utf8');
}

function writeJsonFile(dir, name, obj) {
  mkdirp(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

function sha256HexOfFile(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function hashTreeManifest(rootDir) {
  const out = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) {
        let size = -1, sha = null;
        try { size = fs.statSync(abs).size; sha = sha256HexOfFile(abs); } catch (_e) { /* unreadable -> null */ }
        out.push({ relPath: r, size, sha256: sha });
      }
    }
  }
  walk(rootDir, '');
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

function manifestsEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!deepEqual(a[k], b[k])) return false; }
    return true;
  }
  return false;
}

// conventions.ids: random UUIDs every run, one per id and never containing the
// case id. contract v2.26 erratum 2 (selftest_id_convention, Opus B1+B2 review
// B1 MEDIUM-1): the runner obeys its own id rule -- randId() yields
// toolu_selftest_<uuid> for TOOL ids and test:<uuid> for SESSION ids
// everywhere, not only in part14. Before this erratum randId() returned a bare
// UUID for both (and part14 minted toolu_selftest_ SESSION ids, which the
// convention forbids: "never a toolu_ string").
// Every call names what it mints, and an unknown or missing kind throws, so no
// call site can silently get a shape meant for another column:
//   tool    -> toolu_selftest_<uuid>
//   session -> test:<uuid>
//   agent   -> <uuid>        (conventions.ids; the convention names no prefix)
//   prompt  -> <uuid>        (same)
//   token   -> <uuid>        (NOT an id: file names, labels, state dirs and
//                             other uniqueness seeds -- filename-safe, so it
//                             must never carry the session form's colon)
// part14 (home_only_proof (c): "every part14 invocation uses run-nonce ids"):
// while ID_NONCE is active every value carries the nonce, so any byte a leaking
// guard writes into the real tree is attributable whichever column it came
// from: toolu_selftest_<nonce>_<n>, test:g11-<nonce>-<n> (session),
// test:g11-agent-<nonce>-<n>, test:g11-prompt-<nonce>-<n>,
// selftest-<nonce>-<n> (token). part16 asserts the tool/session prefixes by
// EXECUTION (runnerIdSelfAssertion), since ids held in variables are
// invisible to its static scan.
const ID_KINDS = ['tool', 'session', 'agent', 'prompt', 'token'];
const ID_NONCE = { active: false, nonce: null, n: 0 };
function randId(kind) {
  if (ID_KINDS.indexOf(kind) < 0) {
    throw new Error('randId(kind): kind must be one of ' + ID_KINDS.join('|') + ', got ' + JSON.stringify(kind));
  }
  if (ID_NONCE.active) {
    ID_NONCE.n += 1;
    const tail = ID_NONCE.nonce + '-' + ID_NONCE.n;
    if (kind === 'tool') return 'toolu_selftest_' + ID_NONCE.nonce + '_' + ID_NONCE.n;
    if (kind === 'session') return 'test:g11-' + tail;
    if (kind === 'agent') return 'test:g11-agent-' + tail;
    if (kind === 'prompt') return 'test:g11-prompt-' + tail;
    return 'selftest-' + tail;
  }
  const u = crypto.randomUUID();
  if (kind === 'tool') return 'toolu_selftest_' + u;
  if (kind === 'session') return 'test:' + u;
  return u;
}

function sha16(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16); }

// ===========================================================================
// path variants (ABS / MSYS / ABS_UPPER) and command substitution
// ===========================================================================

function computePathVariants(filesDir) {
  const abs = filesDir.replace(/\\/g, '/').replace(/\/$/, '');
  const msys = abs.replace(/^([A-Za-z]):\//, (m, d) => '/' + d.toLowerCase() + '/');
  const absUpper = abs.toUpperCase();
  return { ABS: abs, MSYS: msys, ABS_UPPER: absUpper };
}

function substituteCmd(cmdTemplate, variants) {
  return cmdTemplate
    .replace(/\bABS_UPPER\b/g, variants.ABS_UPPER)
    .replace(/\bMSYS\b/g, variants.MSYS)
    .replace(/\bABS\b/g, variants.ABS);
}

const FIXTURE_CONTENT = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\n';

function ensureFixtures(fileNames, filesDir) {
  mkdirp(filesDir);
  for (const name of fileNames || []) {
    const p = path.join(filesDir, name);
    mkdirp(path.dirname(p));
    if (!fs.existsSync(p)) fs.writeFileSync(p, FIXTURE_CONTENT, 'utf8');
  }
}

// ===========================================================================
// hook JSON construction (conventions.ids: random UUIDs, never the case id)
// ===========================================================================

function buildHookJson(fields) {
  const obj = { tool_name: 'Bash', tool_input: { command: fields.command } };
  if (fields.hookEventName !== undefined) obj.hook_event_name = fields.hookEventName;
  if (fields.sessionId !== undefined) obj.session_id = fields.sessionId;
  if (fields.agentId !== undefined) obj.agent_id = fields.agentId;
  if (fields.agentType !== undefined) obj.agent_type = fields.agentType;
  if (fields.promptId !== undefined) obj.prompt_id = fields.promptId;
  if (fields.toolUseId !== undefined) obj.tool_use_id = fields.toolUseId;
  if (fields.cwd !== undefined) obj.cwd = fields.cwd;
  if (fields.toolResponse !== undefined) obj.tool_response = fields.toolResponse;
  return obj;
}

// ===========================================================================
// DI shim (seam) construction, with causal-sentinel nonce
// ===========================================================================

function writeCombinedShim(stateDir, { mutantPath, forceIntervene }) {
  mkdirp(path.join(stateDir, 'inject'));
  const shimPath = path.join(stateDir, 'inject', 'shim-' + crypto.randomBytes(6).toString('hex') + '.cjs');
  const lines = ["'use strict';"];
  if (mutantPath) lines.push('const __mutant = require(' + JSON.stringify(mutantPath) + ');');
  if (forceIntervene) lines.push('const __di = require(' + JSON.stringify(DI_INTERVENE_PATH) + ');');
  lines.push('module.exports = {');
  if (mutantPath) {
    lines.push('  judge: __mutant.judge,');
    lines.push('  parse: __mutant.parse,');
  }
  if (forceIntervene) lines.push('  assignment: __di.assignment,');
  lines.push('};');
  fs.writeFileSync(shimPath, lines.join('\n') + '\n', 'utf8');
  return shimPath;
}

// v2.24 (part9 targeted proof): a concurrent child and a sequential pre are
// the same argv with the same hook JSON shape, so a stub cannot tell them
// apart and "only the concurrent sub-call dies" cannot be staged. The runner
// therefore labels every invocation it makes with the KIND of call it is.
// The marker is test-only and inert for the gate; self-check part11 proves
// it changes nothing by comparing a full round with and without it
// (PIPE_GATE_NO_CALL_KIND=1 suppresses it).
function callKindMarkerEnabled() { return process.env.PIPE_GATE_NO_CALL_KIND !== '1'; }
// contract v2.25 erratum 2 (N2): "the runner also strips every PMM_* variable
// from the environment it hands to every invocation, so an operator shell
// that exports PMM_HOME cannot turn Z22/G02 red". resolveHome() gives
// PMM_HOME precedence over USERPROFILE/HOME, so an inherited PMM_HOME would
// silently move every default root the runner computes from a temp HOME.
// Every child env starts here and then sets only what the runner itself
// means to set.
function childEnvBase(extra) {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^PMM_/.test(k)) delete env[k];
  return extra ? Object.assign(env, extra) : env;
}
const HOME_ONLY = { active: false, homeDir: null };
function buildEnv({ stateDir, mutant, forceIntervene, nonce, extra, callKind }) {
  const env = childEnvBase();
  delete env.PIPE_GATE_RUNNER_CALL_KIND;
  if (callKindMarkerEnabled()) env.PIPE_GATE_RUNNER_CALL_KIND = callKind || 'sequential';
  env.PMM_RECALL_ROOT = stateDir;
  env.PMM_RECALL_TAG = 'test';
  delete env.PMM_RECALL_MODE;
  delete env.PIPE_GATE_INJECT;
  delete env.PIPE_GATE_SELFTEST;
  delete env.PIPE_GATE_INJECT_NONCE;
  // v2.16: the production parser must not have an env-driven judgment switch,
  // so the runner never hands one down either (Z23 sets it deliberately, ONE
  // case, to prove it is ignored).
  delete env.PMM_CMD_PARSE_MUTANT;
  if ((mutant && MUTANT_PATHS[mutant]) || forceIntervene) {
    const shimPath = writeCombinedShim(stateDir, {
      mutantPath: mutant && MUTANT_PATHS[mutant] ? MUTANT_PATHS[mutant] : null,
      forceIntervene: !!forceIntervene,
    });
    env.PIPE_GATE_INJECT = shimPath;
    env.PIPE_GATE_SELFTEST = '1';
    if (nonce) env.PIPE_GATE_INJECT_NONCE = nonce;
  }
  if (extra) Object.assign(env, extra);
  // conventions.home_resolution (v2.25): "the runner asserts, for one case
  // per section, that redirecting only HOME+USERPROFILE (no PMM_* vars)
  // leaves the real roots byte-identical". In that mode every PMM_* variable
  // is stripped, so the guard has nothing but HOME to resolve from -- which
  // is exactly the condition under which a guard that reads os.homedir() or
  // a hardcoded path would write into the REAL tree.
  if (HOME_ONLY.active) {
    for (const k of Object.keys(env)) if (/^PMM_/.test(k)) delete env[k];
    env.HOME = HOME_ONLY.homeDir;
    env.USERPROFILE = HOME_ONLY.homeDir;
  }
  return env;
}

// ===========================================================================
// process execution (files, never pipes / command substitution)
// ===========================================================================

function splitArgv(cmdString) { return cmdString.trim().split(/\s+/); }

// conventions.process_liveness (v2.24, codex wave-2 HIGH-1): "the liveness
// aggregate is COUNTED, not listed -- every hook invocation the runner
// performs (sequential, concurrent, interleaved, policy bRun, Z12 positive
// control, self-check stubs) produces a liveness record, the per-case
// aggregate must satisfy liveness.steps === number of invocations actually
// spawned for that case, and an aggregate with checked === 0 or steps <
// invocations is red by itself". An all-green run reported L15 liveness
// {checked:false, steps:0, ok:true} while it had spawned two concurrent gate
// processes, because the concurrent and interleaved executors never pushed
// into state.log and mergeLiveness([]) said ok.
//
// Rather than ask twenty call sites to remember, the SPAWN HELPERS record:
// every gate process that is started increments the active scope's counter
// and pushes its own raw record, so an executor that forgets to report is
// caught by steps < invocations instead of disappearing.
const LIVENESS = { active: null };
function beginLivenessScope() {
  const scope = { records: [], spawns: 0 };
  LIVENESS.active = scope;
  return scope;
}
function endLivenessScope(scope) {
  if (LIVENESS.active === scope) LIVENESS.active = null;
  return scope;
}
function recordGateSpawn(label, res, nonHook) {
  const scope = LIVENESS.active;
  if (!scope) return;
  scope.spawns += 1;
  if (nonHook) return; // a TOOL invocation (P05 --unlock, G11 trigger script), not a hook
  scope.records.push({
    label: label || '', rc: res.rc, stderrSize: res.stderrSize,
    spawnError: res.spawnError === undefined ? null : res.spawnError, stderrPath: res.stderrPath,
  });
}
function runGateProcess(gateArgv, { stdinPath, closedStdin, cwd, env, ioDir, label, nonHook }) {
  mkdirp(ioDir);
  const stdoutPath = path.join(ioDir, label + '.stdout');
  const stderrPath = path.join(ioDir, label + '.stderr');
  fs.writeFileSync(stdoutPath, '');
  fs.writeFileSync(stderrPath, '');
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  let inFd = 'ignore';
  if (!closedStdin) inFd = fs.openSync(stdinPath, 'r');
  let res;
  try {
    res = spawnSync(gateArgv[0], gateArgv.slice(1), { cwd, env, stdio: [inFd, outFd, errFd] });
  } finally {
    if (inFd !== 'ignore') fs.closeSync(inFd);
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdoutSize = fs.statSync(stdoutPath).size;
  const stderrSize = fs.statSync(stderrPath).size;
  const out = {
    rc: res.status === null || res.status === undefined ? -1 : res.status,
    stdoutSize, stderrSize, stdoutPath, stderrPath,
    spawnError: res.error ? String(res.error) : null,
  };
  recordGateSpawn(label, out, nonHook);
  return out;
}

// self_test_summary (v2.6 item 6): the production gate's own --self-test
// must print exactly one line starting with "SELFTEST" followed by JSON
// {load,silence,positive,header} counts; asserts rc 0 AND each count meets
// its floor (load>=1, silence>=5, positive>=1, header>=1). This does NOT
// treat "did the self-test find a problem" as an oracle (brief §12/13) --
// it only checks that the self-test ACTUALLY EXERCISED the minimum surface
// its own summary line claims to, which a two-line fake self-test (HIGH-9's
// documented residual risk) cannot satisfy without also faking the counts.
const SELFTEST_SUMMARY_MINIMUMS = { load: 1, silence: 5, positive: 1, header: 1 };
function evaluateSelfTestSummary(result) {
  const rcOk = result.rc === 0;
  let stdoutText = '';
  try { stdoutText = fs.readFileSync(result.stdoutPath, 'utf8'); } catch (_e) { /* absent */ }
  const line = stdoutText.split('\n').find((l) => l.startsWith('SELFTEST'));
  let summary = null, parseOk = false;
  if (line) {
    try { summary = JSON.parse(line.slice('SELFTEST'.length).trim()); parseOk = true; } catch (_e) { parseOk = false; }
  }
  const countsOk = parseOk && summary && Object.entries(SELFTEST_SUMMARY_MINIMUMS)
    .every(([k, min]) => Number.isFinite(summary[k]) && summary[k] >= min);
  return {
    pass: rcOk && countsOk,
    rc: result.rc, selftest_line_found: !!line, selftest_line: line || null, summary,
    reason: !rcOk ? 'production --self-test exited non-zero'
      : (!line ? 'no line starting with SELFTEST found in --self-test stdout (expected pre-builder)'
        : (!parseOk ? 'SELFTEST line is not valid JSON'
          : (!countsOk ? 'SELFTEST counts below minimum ' + JSON.stringify(SELFTEST_SUMMARY_MINIMUMS) : 'ok'))),
  };
}

// L09 lifecycle_executors["closed stdout"] (contract v2.8): fd 1 is opened
// READ-ONLY on the null device (`exec 1</dev/null`) inside the child shell
// BEFORE it execs the real gate, so every write(1,...) the gate performs
// fails with EBADF. The v2.7 recipe (`exec 1>&-`, a genuinely closed fd) is
// NOT usable here: measured on this host, a Node child's write to fd 1
// succeeds under it, because Node reopens closed fds 0-2 onto the null
// device at startup -- fstatSync(1) then reports a character device. A
// read-only fd survives that startup check (it is a valid fd) and still
// rejects every write, which is the observable the case actually needs.
// The self-check preflights this recipe before running L09.
function runGateProcessClosedStdout(gateArgv, { stdinPath, cwd, env, ioDir, label }) {
  mkdirp(ioDir);
  const stderrPath = path.join(ioDir, label + '.stderr');
  fs.writeFileSync(stderrPath, '');
  const errFd = fs.openSync(stderrPath, 'w');
  const inFd = fs.openSync(stdinPath, 'r');
  const gateCmd = gateArgv.map((a) => "'" + String(a).replace(/'/g, "'\\''") + "'").join(' ');
  let res;
  try {
    res = spawnSync('bash', ['-c', CLOSED_STDOUT_RECIPE_PREFIX + '; exec ' + gateCmd], { cwd, env, stdio: [inFd, 'ignore', errFd] });
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(errFd);
  }
  const stderrSize = fs.statSync(stderrPath).size;
  const out = {
    rc: res.status === null || res.status === undefined ? -1 : res.status,
    stdoutSize: 0, // fd 1 was read-only on the null device; nothing could have been captured
    stderrSize, stderrPath,
    spawnError: res.error ? String(res.error) : null,
  };
  recordGateSpawn(label, out, false);
  return out;
}

// The two "the gate's std fd is unusable" recipes. Both live here as single
// constants that BOTH the executor and its preflight read, so the recipe and
// the thing that verifies the recipe can never drift apart -- that split is
// exactly what made runGateProcessClosedStdout dead code for two rounds.
//
// Measured on this host (win32 + Git Bash + node.exe), and the reason neither
// uses the obvious `exec N<&-` / `exec N>&-` form: Node reopens fds 0-2 onto
// the null device at startup when it finds them CLOSED, so a closed fd is
// silently replaced by a working one -- write(1) succeeds, read(0) returns
// EOF. A fd left open in the WRONG DIRECTION survives that startup check (it
// is a valid fd) and still fails every operation it was not opened for.
//   exec 1>&-        + node write(1) -> WROTE-OK   (useless)
//   exec 1</dev/null + node write(1) -> EBADF      (contract v2.8 recipe)
//   exec 0<&-        + node read(0)  -> READ-OK    (useless; Z01 == Z04)
//   exec 0>/dev/null + node read(0)  -> EBADF      (used below)
// Non-Node children fail under the closed form too (/usr/bin/printf, cat),
// which is why the defect hid: the recipe looks right against a shell probe.
const CLOSED_STDOUT_RECIPE_PREFIX = 'exec 1</dev/null';
const CLOSED_STDIN_RECIPE_PREFIX = 'exec 0>/dev/null';
// Only used when the preflight says the write-only-fd-0 trick does not work
// on this host: fall back to the previous behavior (fd 0 closed, hence
// reopened on the null device, hence read -> EOF) and SAY SO in the report.
const CLOSED_STDIN_FALLBACK_PREFIX = 'exec 0<&-';

// conventions.lifecycle_executors["closed stdout"] (v2.8) REQUIRES the first
// of these: "The runner self-check MUST preflight the recipe with a `node -e`
// write to fd 1 and assert it throws EBADF/EPIPE before executing L09; if the
// preflight fails on the host, L09 is reported unscored with the reason
// instead of red." Z01's recipe is not pinned by the contract (its `input` is
// just "closed stdin"), so the same treatment is applied by choice: prove the
// condition is real, or report that it is not.
//
// The probe child is Node, because the gate is Node and Node is precisely the
// runtime whose startup fd handling defeats the naive recipes. The child's
// observation is returned verbatim so a failure is reported as text, never as
// a silent downgrade.
const FD_PREFLIGHT_PROBES = {
  closed_stdout: 'const fs=require("fs");let r;try{fs.writeSync(1,"X");r="WROTE-OK";}catch(e){r="THREW:"+e.code;}' +
    'try{fs.writeSync(2,r);}catch(e){}',
  closed_stdin: 'const fs=require("fs");let r;try{fs.readFileSync(0);r="READ-OK";}catch(e){r="THREW:"+e.code;}' +
    'try{fs.writeSync(2,r);}catch(e){}',
};

function preflightFdRecipe(name, prefix, env) {
  const recipe = prefix + '; exec node -e ' + "'" + FD_PREFLIGHT_PROBES[name] + "'";
  const res = spawnSync('bash', ['-c', recipe], { env, encoding: 'utf8' });
  const observed = String((res.stderr === undefined || res.stderr === null ? '' : res.stderr)).trim();
  const pass = observed === 'THREW:EBADF' || observed === 'THREW:EPIPE';
  return {
    name,
    pass,
    recipe: 'bash -c "' + recipe + '"',
    child_observation: observed || '(no stderr from the preflight child)',
    child_rc: res.status === null || res.status === undefined ? -1 : res.status,
    required: 'THREW:EBADF or THREW:EPIPE',
  };
}

// The answer is a property of the host and of node, not of the caller's env,
// so it is computed at most once per process; every caller therefore sees the
// same verdict as the executor that acts on it.
const FD_PREFLIGHT_CACHE = {};
let PREFLIGHT_TMPDIR = null;
function preflightEnvFrom(baseEnv) {
  if (!PREFLIGHT_TMPDIR) PREFLIGHT_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pgv2-preflight-'));
  const stripped = Object.assign({}, baseEnv || process.env);
  for (const k of Object.keys(stripped)) if (/^PMM_/.test(k)) delete stripped[k];
  const env = Object.assign(stripped, {
    HOME: PREFLIGHT_TMPDIR, USERPROFILE: PREFLIGHT_TMPDIR,
    PMM_RECALL_ROOT: path.join(PREFLIGHT_TMPDIR, 'state'),
  });
  delete env.PIPE_GATE_INJECT;
  delete env.PIPE_GATE_SELFTEST;
  delete env.PIPE_GATE_INJECT_NONCE;
  return env;
}
function preflightClosedStdoutRecipe(env) {
  if (!FD_PREFLIGHT_CACHE.closed_stdout) {
    FD_PREFLIGHT_CACHE.closed_stdout = preflightFdRecipe('closed_stdout', CLOSED_STDOUT_RECIPE_PREFIX, preflightEnvFrom(env));
  }
  return FD_PREFLIGHT_CACHE.closed_stdout;
}
function preflightClosedStdinRecipe(env) {
  if (!FD_PREFLIGHT_CACHE.closed_stdin) {
    FD_PREFLIGHT_CACHE.closed_stdin = preflightFdRecipe('closed_stdin', CLOSED_STDIN_RECIPE_PREFIX, preflightEnvFrom(env));
  }
  return FD_PREFLIGHT_CACHE.closed_stdin;
}

// Z01 "closed stdin". v2.5 MEDIUM-7 replaced Node's 'ignore' stdio (which
// wires fd 0 to the null device, so reads return EOF -- the same observable
// as Z04's empty stdin, making the two cases indistinguishable) with
// `exec 0<&-`. Measured on this host, that fix does not hold either: a Node
// child under `exec 0<&-` reads fd 0 successfully, because Node reopens
// closed fds 0-2 onto the null device at startup -- i.e. Z01 was still
// testing Z04. The contract pins only the INPUT ("closed stdin"), not the
// recipe, so the runner uses a write-only fd 0 (`exec 0>/dev/null`), which
// survives Node's startup check and makes every read(0,...) fail with EBADF.
// Same preflight-or-report discipline as the closed-stdout recipe: if the
// host does not produce a read failure, fall back to the old behavior and
// report z01_read_failure_verified:false with the observation, rather than
// claiming a condition that was never exercised. Z01's assertion (stdout,
// stderr and rc all 0) is unchanged and holds in both worlds.
function runGateProcessClosedStdin(gateArgv, { cwd, env, ioDir, label }) {
  mkdirp(ioDir);
  const stdoutPath = path.join(ioDir, label + '.stdout');
  const stderrPath = path.join(ioDir, label + '.stderr');
  fs.writeFileSync(stdoutPath, ''); fs.writeFileSync(stderrPath, '');
  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  const gateCmd = gateArgv.map((a) => "'" + String(a).replace(/'/g, "'\\''") + "'").join(' ');
  const preflight = preflightClosedStdinRecipe(env);
  const prefix = preflight.pass ? CLOSED_STDIN_RECIPE_PREFIX : CLOSED_STDIN_FALLBACK_PREFIX;
  let res;
  try {
    res = spawnSync('bash', ['-c', prefix + '; exec ' + gateCmd], { cwd, env, stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const out = {
    rc: res.status === null || res.status === undefined ? -1 : res.status,
    stdoutSize: fs.statSync(stdoutPath).size,
    stderrSize: fs.statSync(stderrPath).size,
    stderrPath,
    spawnError: res.error ? String(res.error) : null,
    read_failure_verified: preflight.pass,
    recipe_used: prefix,
    preflight,
  };
  recordGateSpawn(label, out, false);
  return out;
}

// L15/L15b lifecycle_executors["concurrent pre"]: real async-spawned
// processes, each blocked on a barrier file it polls; the runner creates the
// barrier file to release them together. Uses child_process.spawn (async)
// wrapped in a Promise so the OS actually schedules both concurrently, not
// child_process.spawnSync called twice in a row.
// LOW-3 (v2.5): replaced the fixed 200ms pre-release delay (a timing
// assumption) with polling for a `<label>.started` marker file from EVERY
// child before writing the barrier -- each child touches its own marker
// the instant it enters the poll loop, so the runner releases the barrier
// only once it has positive evidence every child is actually waiting.
function runBarrierConcurrent(invocations, { root }) {
  const barrierPath = path.join(root, 'barrier-' + crypto.randomBytes(6).toString('hex'));
  const children = invocations.map((inv) => {
    mkdirp(inv.ioDir);
    const startedPath = path.join(root, inv.label + '.started');
    const stdoutPath = path.join(inv.ioDir, inv.label + '.stdout');
    const stderrPath = path.join(inv.ioDir, inv.label + '.stderr');
    fs.writeFileSync(stdoutPath, ''); fs.writeFileSync(stderrPath, '');
    const outFd = fs.openSync(stdoutPath, 'w');
    const errFd = fs.openSync(stderrPath, 'w');
    const inFd = fs.openSync(inv.stdinPath, 'r');
    const waitScript = 'touch ' + JSON.stringify(startedPath) +
      '; while [ ! -f ' + JSON.stringify(barrierPath) + ' ]; do sleep 0.005; done; exec "$@"';
    const child = spawn('bash', ['-c', waitScript, 'barrier-wrapper', ...inv.gateArgv], {
      cwd: inv.cwd, env: inv.env, stdio: [inFd, outFd, errFd],
    });
    return { startedPath, promise: new Promise((resolve) => {
      child.on('close', (code) => {
        fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);
        const out = {
          label: inv.label,
          rc: code === null ? -1 : code,
          stdoutSize: fs.statSync(stdoutPath).size,
          stderrSize: fs.statSync(stderrPath).size,
          stderrPath,
          spawnError: null,
        };
        // v2.24: the concurrent children are hook invocations like any other
        recordGateSpawn(inv.label, out, false);
        resolve(out);
      });
    }) };
  });
  const allStarted = () => children.every((c) => fs.existsSync(c.startedPath));
  return new Promise((resolve) => {
    const pollStarted = () => {
      if (allStarted()) {
        fs.writeFileSync(barrierPath, '1');
        Promise.all(children.map((c) => c.promise)).then((results) => {
          try { fs.unlinkSync(barrierPath); } catch (_e) { /* best effort */ }
          for (const c of children) { try { fs.unlinkSync(c.startedPath); } catch (_e) { /* best effort */ } }
          resolve(results);
        });
      } else {
        setTimeout(pollStarted, 5);
      }
    };
    pollStarted();
  });
}

// ===========================================================================
// ledger reading + read-side aggregation (HIGH-5 / LOW-1)
// ===========================================================================

function listLedgerFiles(stateDir) {
  let entries;
  try { entries = fs.readdirSync(stateDir); } catch (_e) { return []; }
  return entries.filter((f) => /^events-v3-.*\.tsv$/.test(f)).map((f) => path.join(stateDir, f));
}

function readLedgerRows(stateDir) {
  const files = listLedgerFiles(stateDir);
  let header = null;
  const rows = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_e) { continue; }
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const cols = lines[0].split('\t');
    if (!header) header = cols;
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split('\t');
      const row = { __raw: lines[i], __file: f, __colCount: vals.length };
      for (let c = 0; c < cols.length; c++) row[cols[c]] = vals[c];
      rows.push(row);
    }
  }
  return { header, rows, headerColCount: header ? header.length : 0 };
}

const GATE_BEARING_EVENT_KINDS = new Set(['would-warn', 'emitted', 'recurrence-candidate', 'recurrence']);

// MEDIUM-2 (Opus r7): conventions.gate_disposition_map pins, per finding, the
// event_kind SEQUENCE and the row count -- "B is shadow-only forever",
// "D candidate ... event_kind recurrence-candidate ... never emitted",
// "A hit, intervene -> would-warn then emitted", "emit failure -> would-warn
// then emit-failed". Nothing asserted any of it: the aggregation only ever
// read `gate` and `confidence`, so a gate that wrote every finding as
// would-warn passed the whole package. These are the row kinds that take part
// in a disposition sequence.
const DISPOSITION_ROW_KINDS = new Set(['would-warn', 'emitted', 'emit-failed', 'recurrence-candidate', 'recurrence']);

// v2.23: conventions.gate_disposition_map must be the OBJECT that maps
// "A hit, shadow" / "A hit, intervene" / "B hit, any mode" / "D candidate"
// ... to their event_kind sequences. Contract v2.23 appended its MEDIUM-5
// amendment by string concatenation, so the value is now the string
// "[object Object]. v2.23 (codex MEDIUM-5 ...)" and the table is GONE. The
// runner must not quietly turn that into "every sequence is []", which
// reddens every case with a mismatch that blames the gate; it names the
// defect instead, once, on every case that asks for the rule.
function dispositionMapDefect(map) {
  if (map && typeof map === 'object' && !Array.isArray(map)) return null;
  return 'conventions.gate_disposition_map is ' + (typeof map) + ' (' +
    JSON.stringify(String(map).slice(0, 60)) + '...), not the event-kind sequence table the ' +
    'clause defines; the runner cannot assert gate_disposition_map until the contract restores the object';
}
function buildDispositionRules(map) {
  const seq = (s) => String(s === undefined || s === null ? '' : s).split(' then ').map((x) => x.trim()).filter(Boolean);
  const defect = dispositionMapDefect(map);
  if (defect) return { available: false, defect };
  const m = map || {};
  const rules = {
    available: !!map,
    B: seq((m['B hit, any mode'] || {}).event_kind),
    candidate: seq((m['D candidate (no receipt evidence)'] || {}).event_kind),
    recurrenceShadow: seq((m['A hit, shadow'] || {}).event_kind),
    recurrenceIntervene: seq((m['A hit, intervene'] || {}).event_kind),
    emitFailure: seq((m['emit failure'] || {}).event_kind),
  };
  // The D recurrence rows must follow the same shapes as the A recurrence
  // rows. If the contract ever makes them differ, say so loudly instead of
  // quietly applying the A shape to D.
  rules.consistent = JSON.stringify(seq((m['D recurrence, shadow'] || {}).event_kind)) === JSON.stringify(rules.recurrenceShadow) &&
    JSON.stringify(seq((m['D recurrence, intervene'] || {}).event_kind)) === JSON.stringify(rules.recurrenceIntervene);
  return rules;
}

// `rows` must already be filtered to this case's tool_use_id. `mode` is the
// case's declared mode, or undefined for a case whose steps carry their own
// (L10's shadow-then-intervene pair shares one impression, so both the shadow
// and the intervene shape are legal for it).
function checkDisposition(rows, mode, rules, opts) {
  if (rules && rules.defect) {
    return { checked: false, ok: false, contract_defect: rules.defect, violations: [] };
  }
  if (!rules || !rules.available) return { checked: false, ok: true, violations: [] };
  const violations = [];
  if (!rules.consistent) {
    violations.push({ reason: 'gate_disposition_map: the A and D recurrence entries disagree on their event_kind sequence' });
  }
  const agg = aggregateLedgerRows(rows);
  const byImpression = new Map();
  for (const r of agg.deduped) {
    if (!r.impression_id || !r.gate) continue;
    if (!DISPOSITION_ROW_KINDS.has(r.event_kind)) continue;
    if (!byImpression.has(r.impression_id)) byImpression.set(r.impression_id, []);
    byImpression.get(r.impression_id).push(r);
  }
  const sameSeq = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
  // conventions.gate_disposition_map_note (v2.23 erratum 8775e0d moved the
  // MEDIUM-5 clause to this sibling key so the sequence table stayed an
  // object), codex MEDIUM-5: "ALL rows
  // produced by one finding (would-warn, emitted, emit-failed,
  // recurrence-candidate, queue rows) carry the SAME mode = the arm the
  // finding was assigned to; what distinguishes would-warn from emitted is
  // event_kind, never mode". Asserted per finding (= per impression), so a
  // would-warn/shadow + emitted/intervene pair is red wherever it appears,
  // not only in the policy cases.
  // Scope: ONE hook invocation. A multi-step lifecycle case may legitimately
  // put two arms on one impression -- L10 is literally "pre(shadow) then
  // pre(intervene, same tool_use_id) share the impression_id" -- so the
  // per-finding rule is asserted where the runner knows all the rows came
  // from a single judgment, and the fact that it was NOT asserted is
  // reported rather than left to be assumed.
  // LOW-H6 (Opus increment): the relaxation belongs to the cases that
  // DECLARE a shared impression across arms (the L10 shape), not to the
  // lifecycle family as a whole -- every other multi-step case must still
  // show one arm per finding.
  const singleInvocation = !!(opts && opts.singleInvocation) && !(opts && opts.sharedImpressionAcrossArms);
  if (singleInvocation) {
    for (const [impressionId, group] of byImpression) {
      const modes = [...new Set(group.map((r) => String(r.mode === undefined || r.mode === null ? '' : r.mode)))];
      if (modes.length > 1) {
        violations.push({
          impression_id: impressionId, gate: group[0].gate, reason: 'rows of one finding disagree on mode',
          rows: group.map((r) => ({ event_kind: r.event_kind, mode: r.mode })),
        });
      }
    }
  }
  for (const [impressionId, group] of byImpression) {
    const kinds = group.map((r) => r.event_kind);
    const gate = group[0].gate;
    const confidence = group[0].confidence;
    let allowed;
    if (gate === 'B') allowed = [rules.B];
    else if (confidence === 'recurrence-candidate') allowed = [rules.candidate];
    else if (mode === 'shadow') allowed = [rules.recurrenceShadow];
    else if (mode === 'intervene') allowed = [rules.recurrenceIntervene, rules.emitFailure];
    else allowed = [rules.recurrenceShadow, rules.recurrenceIntervene, rules.emitFailure];
    if (!allowed.some((s) => sameSeq(s, kinds))) {
      violations.push({
        impression_id: impressionId, gate, confidence, mode: mode || '(per-step)',
        observed_event_kinds: kinds, allowed_sequences: allowed,
      });
    }
  }
  // LOW-4 (Opus build acceptance): brief §15 asks for the per-impression
  // instance evidence ("0:0" / "3:3"), which was not reviewable from the
  // report. The 21-column ledger has no gate_instance_id column, so what is
  // OBSERVABLE here is the impression_id each finding landed on (two distinct
  // ids is exactly the property the instance rule exists to produce). If a
  // gate_instance_id column is ever added, it is picked up automatically.
  const instances = [...byImpression.entries()].map(([impressionId, group]) => ({
    impression_id: impressionId,
    gate: group[0].gate,
    confidence: group[0].confidence,
    event_kinds: group.map((r) => r.event_kind),
    gate_instance_id: group[0].gate_instance_id !== undefined ? group[0].gate_instance_id : null,
  }));
  return {
    checked: true, ok: violations.length === 0, violations,
    mode_uniformity_asserted: singleInvocation,
    mode_uniformity_note: singleInvocation ? undefined
      : 'not asserted: this case DECLARES a shared impression across arms (pre(shadow) + pre(intervene, same tool_use_id)), so two arms on one impression are its subject, not a defect',
    impressions: byImpression.size, instances,
    gate_instance_id_column_present: instances.some((i) => i.gate_instance_id !== null),
  };
}

// runner_duties: "aggregate ledger rows by event_id first (dedupe, report
// duplicate rate), then require every impression_id to carry exactly one
// {gate, confidence} across its gate-bearing rows (conflict = red), then
// compare the distinct-impression multiset".
function aggregateLedgerRows(rows) {
  const byEventId = new Map();
  let totalRaw = 0;
  for (const r of rows) {
    totalRaw += 1;
    const key = r.event_id !== undefined && r.event_id !== '' ? r.event_id : Symbol('no-event-id-' + totalRaw);
    if (!byEventId.has(key)) byEventId.set(key, r);
  }
  const deduped = [...byEventId.values()];
  const duplicateCount = totalRaw - deduped.length;

  const byImpression = new Map();
  const conflicts = [];
  for (const r of deduped) {
    // Informational rows are not gate-bearing and have no impression, so they
    // are skipped HERE by design -- but they are no longer unasserted: their
    // gate / trigger_or_gate_id columns are checked by
    // checkInformationalAttribution on every case (v2.14 MEDIUM-2). The
    // `!r.gate` clause below must never be read as "informational rows are
    // exempt from assertion"; it only keeps a column-less row out of the
    // impression map.
    if (!GATE_BEARING_EVENT_KINDS.has(r.event_kind) || !r.gate) continue;
    const key = r.impression_id;
    const val = { gate: r.gate, confidence: r.confidence };
    if (!byImpression.has(key)) byImpression.set(key, val);
    else {
      const existing = byImpression.get(key);
      if (existing.gate !== val.gate || existing.confidence !== val.confidence) {
        conflicts.push({ impression_id: key, existing, found: val });
      }
    }
  }
  const distinctGates = [...byImpression.values()];
  return {
    rawCount: totalRaw, dedupedCount: deduped.length, duplicateCount,
    deduped, distinctGates, distinctImpressionCount: byImpression.size, conflicts,
  };
}

function extractActualGates(rows) { return aggregateLedgerRows(rows).distinctGates; }

function gateKey(g) { return g.gate + ':' + g.confidence; }

function multisetEqual(a, b) {
  const ak = (a || []).map(gateKey).sort();
  const bk = (b || []).map(gateKey).sort();
  return JSON.stringify(ak) === JSON.stringify(bk);
}

function stdoutRuleOk(rule, size) {
  if (rule === undefined || rule === null) return true;
  if (rule === '0' || rule === 0) return size === 0;
  if (rule === '>0') return size > 0;
  return false;
}

// ===========================================================================
// layout (conventions.layout, pinned in v2.4 -- no more guessing)
// ===========================================================================

function pendingKeyPath(stateDir, sessionId, agentId, toolUseId) {
  // sha256(session_id + NUL + agent_id + NUL + tool_use_id)
  const key = crypto.createHash('sha256')
    .update(String(sessionId) + '\0' + String(agentId) + '\0' + String(toolUseId), 'utf8')
    .digest('hex');
  return path.join(stateDir, 'pending', key + '.json');
}

function receiptsPath(stateDir, sessionId, agentId) {
  // AT THE ROOT, not in a subdirectory.
  return path.join(stateDir, 'receipts-' + sha16(sessionId) + '-' + sha16(agentId) + '.log');
}

// layout.pending (v2.5 LOW-4): the literal shape is
// `<sha256-hex>.json` (outstanding) vs `<sha256-hex>.json.processing.<lease>`
// (being consumed) -- match the exact hex-then-.json pattern rather than a
// loose "ends with .json and doesn't mention .processing" heuristic, which
// would miscount an implementation that puts ".processing" before ".json".
const PENDING_OUTSTANDING_RE = /^[0-9a-f]{64}\.json$/;
function pendingFileCount(stateDir) {
  const dir = path.join(stateDir, 'pending');
  try { return fs.readdirSync(dir).filter((f) => PENDING_OUTSTANDING_RE.test(f)).length; } catch (_e) { return 0; }
}

// ===========================================================================
// run context
// ===========================================================================

function makeRunRoot(rootArg) {
  const root = rootArg || fs.mkdtempSync(path.join(os.tmpdir(), 'pgv2-accept-'));
  mkdirp(root);
  const stateDir = path.join(root, 'state');
  const filesDir = path.join(root, 'files');
  const cwdDir = path.join(root, 'cwd');
  const ioDir = path.join(root, 'io');
  mkdirp(stateDir); mkdirp(filesDir); mkdirp(cwdDir); mkdirp(ioDir);
  return { root, stateDir, filesDir, cwdDir, ioDir };
}

// v2.6 HIGH-3/MEDIUM-11: the informational-event universe used for
// expect.events exact-set comparisons is READ FROM THE CONTRACT
// (conventions.informational_events), not hardcoded -- the fallback list
// here is only a defensive default if an older contract lacks the field.
const FALLBACK_INFORMATIONAL_EVENTS = [
  'unsupported', 'path_unresolved', 'cd-hint', 'pending-conflict', 'pending-corrupt',
  'pending-expired', 'receipt-lost', 'emit-failed',
];

function makeCtx(opts) {
  const dirs = makeRunRoot(opts.root);
  const conventions = opts.conventions || {};
  const ttlSeconds = Number.isFinite(conventions.ttl_seconds) ? conventions.ttl_seconds : 3600;
  const informationalEvents = new Set(
    Array.isArray(conventions.informational_events) ? conventions.informational_events : FALLBACK_INFORMATIONAL_EVENTS,
  );
  return {
    ...dirs,
    gateArgv: splitArgv(opts.gate),
    mutant: opts.mutant === 'none' ? null : opts.mutant,
    pathVariants: computePathVariants(dirs.filesDir),
    ttlSeconds,
    nonce: opts.nonce || null,
    informationalEvents,
    dispositionRules: buildDispositionRules(conventions.gate_disposition_map),
  };
}

// ===========================================================================
// normal `cases` executor
// ===========================================================================

function describeMismatch(flags, extra) {
  const bad = Object.keys(flags).filter((k) => !flags[k]);
  return (bad.length ? bad.join(',') + ' mismatch' : 'ok') + (extra ? ' | ' + extra : '');
}

function execNormalCase(tc, ctx) {
  const livenessScope = beginLivenessScope();
  const cmd = substituteCmd(tc.cmd, ctx.pathVariants);
  ensureFixtures(tc.files, ctx.filesDir);
  const sessionId = randId('session'), agentId = randId('agent'), promptId = randId('prompt'), toolUseId = randId('tool');
  const hook = buildHookJson({
    hookEventName: 'PreToolUse',
    sessionId, agentId, agentType: 'worker', promptId,
    toolUseId, cwd: ctx.cwdDir, command: cmd,
  });
  const stdinPath = writeJsonFile(ctx.ioDir, 'io-' + randId('token') + '.pre.stdin.json', hook);
  const forceIntervene = tc.mode === 'intervene';
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: ctx.mutant, forceIntervene, nonce: ctx.nonce });
  const result = runGateProcess(ctx.gateArgv, {
    stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'run-' + randId('token'),
  });
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const stdoutOk = stdoutRuleOk(tc.expect.stdout, result.stdoutSize);
  // MEDIUM-11/HIGH-3 (v2.6): exact-set comparison against
  // conventions.informational_events (read from the contract, not
  // hardcoded); a case with no `events` key is treated as `events: []`.
  // Gate-lifecycle rows (would-warn/emitted/recurrence[-candidate]) are
  // governed by expect.gates + gate_disposition_map, never by expect.events.
  const presentInformational = new Set(
    caseRows.filter((r) => ctx.informationalEvents.has(r.event_kind)).map((r) => r.event_kind),
  );
  const expectedEventsSet = new Set(tc.expect.events || []);
  const eventsOk = presentInformational.size === expectedEventsSet.size &&
    [...expectedEventsSet].every((e) => presentInformational.has(e));
  const disposition = checkDisposition(caseRows, tc.mode, ctx.dispositionRules, { singleInvocation: true });
  const dispositionOk = disposition.ok;
  const informationalAttribution = checkInformationalAttribution(caseRows);
  const informationalAttributionOk = informationalAttribution.ok;
  const classTagCheck = checkGateRowClassTag(caseRows, ctx.mutant);
  const classTagOk = classTagCheck.ok;
  const provenanceCheck = checkGateRowRunProvenance(caseRows);
  const runProvenanceOk = provenanceCheck.ok;
  const liveness = aggregateLivenessScope(livenessScope, tc.expect);
  endLivenessScope(livenessScope);
  const livenessOk = liveness.ok;
  const pass = gatesOk && stdoutOk && eventsOk && dispositionOk && informationalAttributionOk &&
    classTagOk && runProvenanceOk && livenessOk;
  return {
    id: tc.id,
    pass,
    expected: tc.expect,
    actual: {
      gates: agg.distinctGates,
      conflicts: agg.conflicts,
      disposition,
      informational_attribution: informationalAttribution,
      gate_row_class_tag: classTagCheck,
      gate_row_run_provenance: provenanceCheck,
      process_liveness: liveness,
      stdout_size: result.stdoutSize,
      stderr_size: result.stderrSize,
      rc: result.rc,
      events: [...new Set(caseRows.map((r) => r.event_kind))],
      raw_rows: agg.rawCount, deduped_rows: agg.dedupedCount,
      tool_use_id: toolUseId,
    },
    reason: describeMismatch({ gatesOk, stdoutOk, eventsOk, dispositionOk, informationalAttributionOk, classTagOk, runProvenanceOk, livenessOk }) +
      (livenessOk ? '' : ' [' + describeLivenessViolations(liveness) + ']') +
      (classTagOk ? '' : ' [' + describeClassTagViolations(classTagCheck) + ']') +
      (runProvenanceOk ? '' : ' [' + describeProvenanceViolations(provenanceCheck) + ']'),
  };
}

// ===========================================================================
// lifecycle_cases step interpreter (async: L15/L15b need real concurrency)
// ===========================================================================

function extractRedirectTarget(cmdSubstituted) {
  const re = /(?:\d*|&)(>>|>\||&>>|&>|>)\s*(\S+)/g;
  let m, last = null;
  while ((m = re.exec(cmdSubstituted)) !== null) last = m[2];
  return last;
}

function parseStepHeader(step) {
  const m = /^([\w -]+?)(\(([^)]*)\))?:\s*(.*)$/s.exec(step);
  if (!m) return { kind: step.trim(), args: '', rest: '' };
  return { kind: m[1].trim(), args: m[3] || '', rest: m[4] || '' };
}

// clock_steps (v2.5): "+X means the wall clock ADVANCES by X, which the
// runner realizes by SUBTRACTING X from the ts ... (receipts become
// older); -X means receipts become newer (add X)." The caller passes
// `advanceSeconds` (the wall-clock advance, sign as written in the step
// text: +TTL etc. are positive advances, "-3600s" is a negative advance =
// clock rolled BACK = receipts become newer). The ts delta applied is
// therefore always `-advanceSeconds`.
function rewriteReceiptTimestamps(receiptsFile, advanceSeconds) {
  const tsDelta = -advanceSeconds;
  let text;
  try { text = fs.readFileSync(receiptsFile, 'utf8'); } catch (_e) { return { rewritten: 0, before: [], after: [] }; }
  const lines = text.split('\n');
  let rewritten = 0;
  const before = [];
  const after = [];
  const out = lines.map((line) => {
    if (!line) return line;
    const fields = line.split('\t');
    const ts = fields[0];
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return line; // torn/corrupt line -- leave untouched
    before.push(ts);
    fields[0] = new Date(d.getTime() + tsDelta * 1000).toISOString();
    after.push(fields[0]);
    rewritten += 1;
    return fields.join('\t');
  });
  fs.writeFileSync(receiptsFile, out.join('\n'));
  return { rewritten, before, after };
}

async function execLifecycleCase(tc, ctx) {
  // MEDIUM-4 (Opus r6): lifecycle cases declare `files` exactly like normal
  // cases (L02/L03/L04/L12/L13/L14/L19 all do) but execLifecycleCase never
  // created them -- they existed only as a side effect of an earlier case in
  // the same run (D01 created existing.txt, L01 created r.txt), so running a
  // lifecycle subset alone, or reordering, silently changed their meaning.
  ensureFixtures(tc.files, ctx.filesDir);
  const livenessScope = beginLivenessScope();
  const state = {
    livenessScope,
    caseId: tc.id,
    uniqueTag: randId('token'),
    sessionId: randId('session'),
    lastAgentId: randId('agent'),
    agentIdByLabel: {},
    lastToolUseId: randId('tool'),
    lastRedirectTarget: null,
    stepCounter: 0,
    clockOffsetSeconds: 0,
    closedStdoutSteps: [],
    failedExecOps: [],
    log: [],
    lastRc: 0,
    lastCmd: '',
  };
  state.agentIdByLabel.__default__ = state.lastAgentId;
  const forceIntervene = tc.mode === 'intervene';

  function agentIdFor(label) {
    if (!label) return state.lastAgentId;
    if (!state.agentIdByLabel[label]) state.agentIdByLabel[label] = randId('agent');
    return state.agentIdByLabel[label];
  }

  for (const rawStep of tc.steps) {
    const { kind, args, rest } = parseStepHeader(rawStep);
    state.stepCounter += 1;
    const label = 'step-' + randId('token');
    const argsLower = args.toLowerCase();
    const agentMatch = /agent=([A-Za-z0-9_]+)/.exec(args);
    const agentId = agentMatch ? agentIdFor(agentMatch[1]) : state.lastAgentId;
    state.lastAgentId = agentId;
    const wantsSameToolUseId = /same tool_use_id|identical payload/.test(argsLower);
    const modeOverride = argsLower.includes('intervene') ? 'intervene'
      : argsLower.includes('shadow') ? 'shadow' : null;

    if (kind === 'pre') {
      // lifecycle_executors["cross-session pre (L23)"]: "a pre step tagged
      // (session B, agent B) uses a fresh session_id and agent_id for that hook
      // event only". state.sessionId / state.lastAgentId keep session A, so the
      // pending, the receipts path and the identity assertions all stay on the
      // ORIGINAL owner.
      const crossSession = /session\s*B/i.test(args);
      if (crossSession && state.sessionB === undefined) {
        state.sessionB = randId('session');
        state.agentB = randId('agent');
      }
      const eventSessionId = crossSession ? state.sessionB : state.sessionId;
      const eventAgentId = crossSession ? state.agentB : null; // null => use agentId below
      const cmd = substituteCmd(rest.trim(), ctx.pathVariants);
      state.lastCmd = cmd;
      // HIGH-2 (Opus r6): this used to match the PROSE
      // "with stdout replaced by a closed fd", which v2.5 deleted from the
      // contract when it cleaned L09's step down to
      // "pre(closed-stdout): a | b; rc=$?". Neither the command nor the step
      // contained that sentence any more, so runGateProcessClosedStdout was
      // dead code and L09 ran with an OPEN stdout (making its
      // events:['emit-failed'] + stdout:'0' expectation unsatisfiable for a
      // correct gate). Match the step header's own parenthesised argument --
      // which is what conventions.step_grammar actually defines.
      const closedStdout = /closed[- ]stdout/i.test(args) || /closed[- ]stdout/i.test(rawStep);
      state.lastRedirectTarget = extractRedirectTarget(cmd) || state.lastRedirectTarget;
      const toolUseId = wantsSameToolUseId ? state.lastToolUseId : randId('tool');
      state.lastToolUseId = toolUseId;
      // row_attribution / HIGH-6: receipt-lost and pending-expired rows a
      // later GC produces are attributed to the ORIGINAL (crashed/expired)
      // pending's tool_use_id, i.e. the FIRST pre step of the case -- track
      // it separately from state.lastToolUseId (which the LAST pre keeps
      // overwriting, e.g. L16's final read-back pre).
      if (state.firstPreToolUseId === undefined) {
        // conventions.row_attribution (v2.15): the pending stores the CREATING
        // event's identity, and receipt-lost / pending-expired rows copy it --
        // never the identity of the event whose GC found them.
        state.firstPreToolUseId = toolUseId;
        state.firstPreAgentId = agentId;
        state.firstPreSessionId = state.sessionId;
      }
      const useIntervene = modeOverride ? modeOverride === 'intervene' : forceIntervene;
      const promptId = randId('prompt');
      if (state.firstPrePromptId === undefined) {
        state.firstPrePromptId = promptId;
        state.firstPreAgentType = 'worker';
      }
      const hook = buildHookJson({
        hookEventName: 'PreToolUse', sessionId: eventSessionId,
        agentId: eventAgentId || agentId, agentType: 'worker',
        promptId, toolUseId, cwd: ctx.cwdDir, command: cmd,
      });
      if (crossSession) state.crossSessionEventToolUseId = toolUseId;
      // MEDIUM-H3: the receipts file this event can create belongs to
      // (event session, event agent); the clock step ages exactly this set.
      if (!(state.receiptOwnerFiles instanceof Set)) state.receiptOwnerFiles = new Set();
      state.receiptOwnerFiles.add(receiptsPath(ctx.stateDir, eventSessionId, eventAgentId || agentId));
      const stdinPath = writeJsonFile(ctx.ioDir, label + '.stdin.json', hook);
      const env = buildEnv({ stateDir: ctx.stateDir, mutant: ctx.mutant, forceIntervene: useIntervene, nonce: ctx.nonce });
      const result = closedStdout
        ? runGateProcessClosedStdout(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label })
        : runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label });
      if (closedStdout) state.closedStdoutSteps.push(rawStep);
      // conventions.pending_files_semantics offers two measures ("the count of
      // pending files whose name equals this case's key hash (0 or 1), OR the
      // before/after delta for this case"). A case whose Post consumes the
      // pending (H01/H03) is 0 at the END while its expectation is 1, so the
      // measure that means "this case's key held a pending" is the peak, not
      // the final state. `pending_files_after_in` keeps the end-state reading --
      // that is what its name says, and L15b/L22 assert it that way.
      {
        const ownKey = pendingKeyPath(ctx.stateDir, state.sessionId, state.lastAgentId,
          state.firstPreToolUseId !== undefined ? state.firstPreToolUseId : toolUseId);
        if (fs.existsSync(ownKey)) state.pendingKeyEverHeld = true;
      }
      state.log.push({ step: rawStep, toolUseId, stdoutSize: result.stdoutSize, stderrSize: result.stderrSize, rc: result.rc, spawnError: result.spawnError === undefined ? null : result.spawnError, closed_stdout: closedStdout });
    } else if (kind === 'exec') {
      execFilesystemOp(rest.trim(), state, ctx);
    } else if (kind === 'post' || kind === 'post-crash') {
      const toolUseId = state.lastToolUseId;
      if (kind === 'post-crash') {
        simulatePostCrash(ctx, state);
        state.log.push({ step: rawStep, note: 'post-crash: renamed pending to .processing.<lease> aged >1h (lease ts and mtime), no receipt written' });
      } else {
        // HIGH-11: use `rest` as the command when the step supplies one
        // (e.g. L18's "post: cmd > ABS/r.txt"); fall back to whatever the
        // most recent `pre` established (L06's "post(agent=X):" with an
        // empty rest) only when rest is empty.
        const postCmdRaw = rest.trim();
        const postCmd = postCmdRaw ? substituteCmd(postCmdRaw, ctx.pathVariants) : state.lastCmd;
        if (postCmdRaw) state.lastCmd = postCmd;
        const hook = buildHookJson({
          hookEventName: 'PostToolUse', sessionId: state.sessionId, agentId,
          agentType: 'worker', promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir,
          command: postCmd, toolResponse: { exit_code: state.lastRc },
        });
        const stdinPath = writeJsonFile(ctx.ioDir, label + '.stdin.json', hook);
        const env = buildEnv({ stateDir: ctx.stateDir, mutant: ctx.mutant, forceIntervene: false, nonce: ctx.nonce });
        const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label });
        state.log.push({ step: rawStep, toolUseId, stdoutSize: result.stdoutSize, stderrSize: result.stderrSize, rc: result.rc, spawnError: result.spawnError === undefined ? null : result.spawnError });
      }
    } else if (kind === 'clock') {
      applyClockStepV2(rest.trim(), ctx, state);
    } else if (/^runner occupies the receipts file path/.test(rawStep)) {
      await execReceiptsUnwritable(rawStep, tc, ctx, state, agentId, label);
    } else if (/^runner holds the pending file/.test(rawStep)) {
      await execExclusiveShareNoneHold(rawStep, tc, ctx, state, agentId, label);
    } else if (/^runner writes/.test(rawStep) || /^runner appends/.test(rawStep) || /^runner truncates/.test(rawStep)) {
      simulateCorruption(rawStep, ctx, state);
    } else if (/^pre x2 truly concurrent/.test(rawStep)) {
      await execTrueConcurrentPre(rawStep, tc, ctx, state);
    } else if (/^concurrently: post and a second pre/i.test(rawStep) || /^concurrently:/i.test(rawStep)) {
      await execPostPreInterleave(rawStep, tc, ctx, state);
    } else {
      // step_grammar (v2.5): unrecognized step shape -> the case is RED,
      // never silently skipped.
      state.unrecognizedStep = rawStep;
      state.log.push({ step: rawStep, note: 'UNRECOGNIZED step shape -> case forced red' });
    }
  }

  const { rows } = readLedgerRows(ctx.stateDir);
  return evaluateLifecycleExpectation(tc, rows, state, ctx);
}

// conventions.lifecycle_ops (v2.13): "every 'write N bytes' / 'append N bytes'
// the runner performs MUST produce bytes unique to that case and step (e.g.
// case id + step index + nonce padded to N), never a byte-identical rewrite of
// what an earlier case left in the shared files dir - a byte-identical rewrite
// is the distinct 'unchanged' scenario, which no lifecycle case intends".
// Derived from (case id, step index, per-case nonce) so it is unique across
// cases AND across steps of one case, and stable within a step.
function uniqueExecBytes(state, n) {
  if (n <= 0) return '';
  const seed = String(state.caseId || 'case') + '\u0000' + String(state.stepCounter) +
    '\u0000' + String(state.uniqueTag || '');
  const block = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
  let out = '';
  while (out.length < n) out += block;
  return out.slice(0, n);
}

// v2.22: an exec step may NAME its target ("exec: write 12 bytes to
// ABS/out.txt", Bx09-Bx11). The path in the step text wins; only a step
// that names none falls back to the last pre's redirect target, and only a
// case with neither falls back to r.txt. Before v2.22 every exec step was
// silently applied to the last redirect target -- which happened to agree
// with the named path in every case written so far, so a step that named a
// DIFFERENT file would have been applied to the wrong one without a word.
function execTargetFromDesc(desc, ctx) {
  const m = /\bto\s+(\S+)\s*$/.exec(String(desc).trim());
  if (!m) return null;
  const p = substituteCmd(m[1], ctx.pathVariants);
  if (!/[\\/]/.test(p)) return null; // "to 0 bytes" and friends are not paths
  return path.isAbsolute(p) ? p : path.join(ctx.filesDir, p);
}
function execFilesystemOp(desc, state, ctx) {
  const named = execTargetFromDesc(desc, ctx);
  const target = named || (state.lastRedirectTarget && path.isAbsolute(state.lastRedirectTarget)
    ? state.lastRedirectTarget
    : (state.lastRedirectTarget ? path.join(ctx.filesDir, state.lastRedirectTarget) : null));
  mkdirp(path.dirname(target || path.join(ctx.filesDir, 'r.txt')));
  const p = target || path.join(ctx.filesDir, 'r.txt');
  const descLower = desc.toLowerCase();
  const nMatch = /(\d+)\s*byte/.exec(desc);
  const n = nMatch ? parseInt(nMatch[1], 10) : 0;

  if (/truncate/.test(descLower)) {
    fs.writeFileSync(p, '');
    const rcMatch = /rc\s*=\s*(\d+)/.exec(desc);
    state.lastRc = rcMatch ? parseInt(rcMatch[1], 10) : 0;
  } else if (/write tmp then rename/.test(descLower)) {
    const tmp = path.join(ctx.filesDir, 'tmp.txt');
    fs.writeFileSync(tmp, uniqueExecBytes(state, Math.max(n, 12)));
    fs.renameSync(tmp, p);
    state.lastRc = 0;
  } else if (/touch mtime only|external process touches mtime only/.test(descLower)) {
    // MEDIUM-4 (Opus r6): the old fallback CREATED the file when it was
    // missing, quietly turning "touch mtime only" (L12/L14's whole point --
    // mtime moves, size and bytes do not) into "create a brand new file",
    // which a gate that does not implement mtime-only discrimination at all
    // could still answer correctly. The declared `files` are materialized by
    // execLifecycleCase now; a missing target is a red case, not a silent fix.
    if (!fs.existsSync(p)) {
      state.failedExecOps.push('exec: ' + desc + ' -- target does not exist: ' + p);
      return;
    }
    const now = new Date();
    fs.utimesSync(p, now, now);
    state.lastRc = 0;
  } else if (/overwrite with same byte length, different bytes/.test(descLower)) {
    let prevLen = 0;
    try { prevLen = fs.statSync(p).size; } catch (_e) { /* not present yet */ }
    const len = prevLen || Math.max(n, 12);
    // "same byte length, different bytes" -- unique filler satisfies both.
    fs.writeFileSync(p, uniqueExecBytes(state, len));
    state.lastRc = 0;
  } else if (/append/.test(descLower)) {
    fs.appendFileSync(p, uniqueExecBytes(state, n));
    state.lastRc = 0;
  } else if (/write/.test(descLower)) {
    fs.writeFileSync(p, uniqueExecBytes(state, Math.max(n, 1)));
    state.lastRc = 0;
  }
}

// clock_steps (v2.5): `desc` is parsed into an ADVANCE (positive = wall
// clock moves forward = receipts age; negative = clock rolled back =
// receipts get newer). rewriteReceiptTimestamps() owns the actual sign
// flip onto the ts column (ts -= advance).
function applyClockStepV2(desc, ctx, state) {
  const ttlSeconds = Number.isFinite(ctx.ttlSeconds) ? ctx.ttlSeconds : 3600;
  let advanceSeconds = 0;
  if (/ttl\s*\+\s*1s/i.test(desc)) advanceSeconds = ttlSeconds + 1;
  else if (/ttl exactly|^\s*\+ttl\s*$/i.test(desc)) advanceSeconds = ttlSeconds;
  else if (/ttl/i.test(desc)) advanceSeconds = ttlSeconds;
  else {
    const m = /([+-]\d+)s/.exec(desc);
    if (m) advanceSeconds = parseInt(m[1], 10);
  }
  state.clockOffsetSeconds += advanceSeconds;
  // v2.23: the clock is the WALL clock, so it is not enough to age the
  // receipt of (this session, the last agent) -- L23 ages a receipt that
  // belongs to session A while the step is reached with session B's agent in
  // hand, and the single-file form rewrote nothing at all.
  // MEDIUM-H3 (Opus increment): globbing every receipts-*.log in the state
  // dir was the other extreme -- normal and lifecycle cases SHARE
  // root/state, so one case's clock aged other cases' receipts and the suite
  // became order-dependent. The set aged here is exactly the receipts files
  // of the (session, agent) pairs THIS case has driven a hook event with,
  // which still covers L23's cross-session owner.
  const primary = receiptsPath(ctx.stateDir, state.sessionId, state.lastAgentId);
  const owned = state.receiptOwnerFiles instanceof Set ? [...state.receiptOwnerFiles] : [];
  const files = owned.length ? owned.slice() : [primary];
  if (files.indexOf(primary) < 0) files.push(primary);
  const foreign = [];
  try {
    for (const name of fs.readdirSync(ctx.stateDir)) {
      if (!/^receipts-.*\.log$/.test(name)) continue;
      const p = path.join(ctx.stateDir, name);
      if (files.indexOf(p) < 0) foreign.push(p);
    }
  } catch (_e) { /* no state dir yet */ }
  state.clockForeignReceipts = foreign;
  let rewrittenTotal = 0;
  let before = null;
  let after = null;
  const perFile = [];
  for (const f of files) {
    const r = rewriteReceiptTimestamps(f, advanceSeconds);
    rewrittenTotal += r.rewritten;
    perFile.push({ file: f, rewritten: r.rewritten });
    if (r.rewritten > 0 && before === null) { before = r.before; after = r.after; }
  }
  state.clockRewroteLines = rewrittenTotal;
  state.clockRewroteFiles = perFile;
  state.clockTsBefore = before;
  state.clockTsAfter = after;
  state.clockAdvanceSeconds = advanceSeconds;
}

// lifecycle_executors["post-crash"] (v2.5): rename to <same>.processing.<lease>
// where the lease embeds a timestamp older than 1h AND the file mtime is
// ALSO set older than 1h, so a correct GC (brief §11.2: ".processing.* >1h
// with no owner") actually finds this file eligible and writes
// `receipt-lost` on the next gate call (HIGH-6).
const AGE_PAST_TTL_MS = 65 * 60 * 1000; // 1h5m, safely past the 1h GC threshold
function simulatePostCrash(ctx, state) {
  const pendingDir = path.join(ctx.stateDir, 'pending');
  const exactPath = pendingKeyPath(ctx.stateDir, state.sessionId, state.lastAgentId, state.lastToolUseId);
  const agedMs = Date.now() - AGE_PAST_TTL_MS;
  const lease = 'crash-' + process.pid + '-' + agedMs;
  const agedDate = new Date(agedMs);
  let renamed = 0;
  const finish = (dst) => {
    try { fs.utimesSync(dst, agedDate, agedDate); } catch (_e) { /* best effort */ }
  };
  if (fs.existsSync(exactPath)) {
    try {
      const dst = exactPath + '.processing.' + lease;
      fs.renameSync(exactPath, dst);
      finish(dst);
      renamed = 1;
    } catch (_e) { /* best effort */ }
  } else {
    let entries;
    try { entries = fs.readdirSync(pendingDir); } catch (_e) { entries = []; }
    const candidates = entries.filter((f) => f.endsWith('.json') && !f.includes('.processing'));
    for (const f of candidates) {
      try {
        const dst = path.join(pendingDir, f + '.processing.' + lease);
        fs.renameSync(path.join(pendingDir, f), dst);
        finish(dst);
        renamed += 1;
      } catch (_e) { /* best effort */ }
    }
  }
  state.crashedPendingCount = renamed;
  state.crashedPendingAgedTo = agedDate.toISOString();
}

function simulateCorruption(rawStep, ctx, state) {
  if (/runner truncates the pending file for the key to half its bytes/.test(rawStep)) {
    // L18 (v2.5): a real `pre` step precedes this, so the exact key path is
    // computable; truncate whatever the (real, if it exists) gate wrote
    // there to half its byte length. If nothing exists yet (e.g. against a
    // pre-v2 gate that never created a pending file), synthesize a
    // plausibly-shaped one first so there is something to corrupt.
    const p = pendingKeyPath(ctx.stateDir, state.sessionId, state.lastAgentId, state.lastToolUseId);
    mkdirp(path.dirname(p));
    let buf;
    try { buf = fs.readFileSync(p); } catch (_e) {
      buf = Buffer.from('{"path":"r.txt","payload_len":12,"payload_sha":"deadbeefdeadbeef"}');
      fs.writeFileSync(p, buf);
    }
    const half = buf.subarray(0, Math.floor(buf.length / 2));
    fs.writeFileSync(p, half);
    state.corruptPendingPath = p;
    state.corruptPendingOriginalLen = buf.length;
    state.corruptPendingTruncatedLen = half.length;
  } else if (/runner writes a truncated pending file for the key/.test(rawStep)) {
    const p = pendingKeyPath(ctx.stateDir, state.sessionId, state.lastAgentId, state.lastToolUseId);
    mkdirp(path.dirname(p));
    fs.writeFileSync(p, '{"path":"r.txt","payload_len":999,"payload_sha":"dead');
    state.corruptPendingPath = p;
  } else if (/runner appends a torn line then re-appends the last valid receipt line/.test(rawStep)) {
    const p = receiptsPath(ctx.stateDir, state.sessionId, state.lastAgentId);
    mkdirp(path.dirname(p));
    let lastValidLine = null;
    try {
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.length > 0);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].split('\t').length >= 5) { lastValidLine = lines[i]; break; }
      }
    } catch (_e) { /* no prior receipts */ }
    fs.appendFileSync(p, 'TORN_LINE_NOT_ENOUGH_FIELDS\t\n');
    if (lastValidLine) fs.appendFileSync(p, lastValidLine + '\n');
    state.tornReceiptPath = p;
    state.reappendedValidLine = !!lastValidLine;
  } else if (/runner appends a torn line to the receipt/.test(rawStep)) {
    const p = receiptsPath(ctx.stateDir, state.sessionId, state.lastAgentId);
    mkdirp(path.dirname(p));
    fs.appendFileSync(p, 'TORN_LINE_NOT_ENOUGH_FIELDS\t\n');
    state.tornReceiptPath = p;
  }
}

// lifecycle_executors["exclusive share-none hold" (L22)]: "the runner opens the
// pending file with FileShare.None (PowerShell [IO.File]::Open(path, Open,
// Read, None)) in a helper process, sends the Post while the handle is held
// (for at least 300ms), then releases; the gate must retry the rename (<= 60 x
// 5ms like Pre) and, if it still cannot rename, read the pending in place,
// write the receipt, and try to unlink it (unlink failure is left to GC) --
// never drop the receipt."
//
// The helper touches a marker file the instant it HAS the handle, so the Post
// is sent against a genuinely held file rather than after a hopeful sleep; if
// the handle can never be taken (no pending file at all) the case is red with
// the reason, never silently "held for 0ms".
const SHARE_NONE_HOLD_MS = 300;
function waitMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function execExclusiveShareNoneHold(rawStep, tc, ctx, state, agentId, label) {
  const keyPath = pendingKeyPath(ctx.stateDir, state.sessionId, state.lastAgentId, state.lastToolUseId);
  const markerPath = path.join(ctx.root, 'held-' + randId('token'));
  const q = (s) => String(s).replace(/'/g, "''");
  const script = "$ErrorActionPreference='Stop'; $f=[IO.File]::Open('" + q(keyPath) + "','Open','Read','None'); " +
    "New-Item -ItemType File -Force -Path '" + q(markerPath) + "' | Out-Null; " +
    'Start-Sleep -Milliseconds ' + SHARE_NONE_HOLD_MS + '; $f.Close()';
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(markerPath) && Date.now() < deadline) await waitMs(5);
  const held = fs.existsSync(markerPath);
  state.shareNoneHoldObserved = held;
  state.shareNoneHoldPath = keyPath;
  if (!held) {
    state.failedExecOps.push('exclusive share-none hold: could not take a FileShare.None handle on ' + keyPath +
      ' (no pending file there?) -- the Post would not have raced anything');
  }
  // the Post goes out WHILE the handle is held
  const toolUseId = state.lastToolUseId;
  const hook = buildHookJson({
    hookEventName: 'PostToolUse', sessionId: state.sessionId, agentId,
    agentType: 'worker', promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir,
    command: state.lastCmd, toolResponse: { exit_code: state.lastRc },
  });
  const stdinPath = writeJsonFile(ctx.ioDir, label + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: ctx.mutant, forceIntervene: false, nonce: ctx.nonce });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label });
  state.log.push({
    step: rawStep, toolUseId, stdoutSize: result.stdoutSize, stderrSize: result.stderrSize, rc: result.rc,
    note: 'post sent while the pending was held with FileShare.None',
  });
  state.shareNoneHoldExitCode = await exited;
  try { fs.unlinkSync(markerPath); } catch (_e) { /* best effort */ }
}

// lifecycle_executors["receipts unwritable (L21)"]: "the runner creates a
// directory at the exact receipts-<sid>-<agent>.log path before sending the
// post, so every append fails; the gate must keep the .processing lease
// (expect.lease_kept: a .processing file for this key still exists after the
// post) and write nothing else; after the runner removes the directory the
// following pre finds no receipt and judges D as recurrence-candidate."
// The lease is observed BEFORE the directory is removed -- that is the whole
// point of the case (conventions.receipt_commit_and_lease: the lease is
// deleted only after the receipt line is appended successfully).
async function execReceiptsUnwritable(rawStep, tc, ctx, state, agentId, label) {
  const receiptsFile = receiptsPath(ctx.stateDir, state.sessionId, state.lastAgentId);
  let occupied = false;
  try { fs.rmSync(receiptsFile, { force: true }); } catch (_e) { /* not there */ }
  try { mkdirp(receiptsFile); occupied = fs.statSync(receiptsFile).isDirectory(); } catch (_e) { occupied = false; }
  if (!occupied) {
    state.failedExecOps.push('receipts unwritable: could not occupy ' + receiptsFile + ' with a directory');
  }
  const toolUseId = state.lastToolUseId;
  const hook = buildHookJson({
    hookEventName: 'PostToolUse', sessionId: state.sessionId, agentId,
    agentType: 'worker', promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir,
    command: state.lastCmd, toolResponse: { exit_code: state.lastRc },
  });
  const stdinPath = writeJsonFile(ctx.ioDir, label + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: ctx.mutant, forceIntervene: false, nonce: ctx.nonce });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label });
  // observe the lease while the receipts path is still unwritable
  const keyHash = path.basename(pendingKeyPath(ctx.stateDir, state.sessionId, state.lastAgentId, toolUseId), '.json');
  let leaseFiles = [];
  try {
    leaseFiles = fs.readdirSync(path.join(ctx.stateDir, 'pending'))
      .filter((f) => f.indexOf(keyHash + '.json.processing') === 0);
  } catch (_e) { leaseFiles = []; }
  state.leaseKept = leaseFiles.length > 0;
  state.leaseFiles = leaseFiles;
  state.receiptsOccupiedPath = receiptsFile;
  state.log.push({
    step: rawStep, toolUseId, stdoutSize: result.stdoutSize, stderrSize: result.stderrSize, rc: result.rc,
    note: 'post sent while the receipts path was occupied by a directory',
  });
  try { fs.rmSync(receiptsFile, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
}

// L15: lifecycle_executors["concurrent pre"] -- real async spawn + barrier.
async function execTrueConcurrentPre(rawStep, tc, ctx, state) {
  const m = /concurrent[^:]*:\s*(.*?)(\s*\(same session.*\))?$/.exec(rawStep);
  const cmdRaw = m ? m[1].trim() : rawStep;
  const cmd = substituteCmd(cmdRaw, ctx.pathVariants);
  const toolUseId = randId('tool');
  state.lastToolUseId = toolUseId;
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId: state.sessionId, agentId: state.lastAgentId, agentType: 'worker',
    promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir, command: cmd,
  });
  const stdinA = writeJsonFile(ctx.ioDir, 'concA-' + randId('token') + '.stdin.json', hook);
  const stdinB = writeJsonFile(ctx.ioDir, 'concB-' + randId('token') + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: ctx.mutant, forceIntervene: tc.mode === 'intervene', nonce: ctx.nonce, callKind: 'concurrent' });
  const results = await runBarrierConcurrent([
    { stdinPath: stdinA, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'concA-' + randId('token'), gateArgv: ctx.gateArgv },
    { stdinPath: stdinB, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'concB-' + randId('token'), gateArgv: ctx.gateArgv },
  ], { root: ctx.root });
  state.concurrentResults = results;
  state.concurrentStderrTotal = results.reduce((s, r) => s + r.stderrSize, 0);
}

// L15b: Pre/Post interleaved on the same key via the same barrier mechanism.
async function execPostPreInterleave(rawStep, tc, ctx, state) {
  const toolUseId = state.lastToolUseId;
  const postHook = buildHookJson({
    hookEventName: 'PostToolUse', sessionId: state.sessionId, agentId: state.lastAgentId,
    agentType: 'worker', promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir,
    command: state.lastCmd, toolResponse: { exit_code: state.lastRc },
  });
  // HIGH-2 (Opus r7): the concurrent Pre used to get a FRESH tool_use_id and a
  // different, non-redirecting command (`tail -5 ...`). Both defeat the case:
  // a fresh tool_use_id hashes to a DIFFERENT pending key, and a command with
  // no redirect never touches the pending layer at all -- so "a Pre reads the
  // key while a Post is consuming it" never happened, and L15b's
  // events_not_contain / pending_files assertions were structurally true for
  // any implementation. Contract v2.9 L15b pins it: "a second pre with the
  // SAME tool_use_id and the SAME command (a re-entry of the redirecting
  // command, so it computes the same pending key and the same payload)".
  const preHook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId: state.sessionId, agentId: state.lastAgentId, agentType: 'worker',
    promptId: randId('prompt'), toolUseId: toolUseId, cwd: ctx.cwdDir, command: state.lastCmd,
  });
  const stdinPost = writeJsonFile(ctx.ioDir, 'ilv-post-' + randId('token') + '.stdin.json', postHook);
  const stdinPre = writeJsonFile(ctx.ioDir, 'ilv-pre-' + randId('token') + '.stdin.json', preHook);
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: ctx.mutant, forceIntervene: false, nonce: ctx.nonce, callKind: 'interleave' });
  const results = await runBarrierConcurrent([
    { stdinPath: stdinPost, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'ilv-post-' + randId('token'), gateArgv: ctx.gateArgv },
    { stdinPath: stdinPre, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'ilv-pre-' + randId('token'), gateArgv: ctx.gateArgv },
  ], { root: ctx.root });
  state.interleaveResults = results;
  // LOW-4 (Opus r8): L15b's two interleaved processes had no stderr/rc in the
  // report at all -- `state.log` only holds the earlier pre step, and unlike
  // L15 there was no concurrent fallback. The case does not assert stderr, so
  // this is evidence, not a new judgement.
  state.interleaveStderrTotal = results.reduce((s, r) => s + r.stderrSize, 0);
  state.interleaveRcs = results.map((r) => ({ label: r.label, rc: r.rc, stderr: r.stderrSize }));
}

// conventions.informational_row_attribution + gate_disposition_map (v2.14):
// "every informational row (unsupported, path_unresolved, cd-hint,
// pending-conflict, pending-corrupt, pending-expired, receipt-lost) carries
// gate and trigger_or_gate_id per gate_disposition_map: unsupported -> A/A;
// path_unresolved and cd-hint -> D/D; the pending/receipt family -> D/D (they
// exist only for gate D evidence); session-end rows keep both columns empty.
// The runner asserts this on every case".
const INFORMATIONAL_ROW_ATTRIBUTION = {
  unsupported: { gate: 'A', trigger_or_gate_id: 'A' },
  path_unresolved: { gate: 'D', trigger_or_gate_id: 'D' },
  'cd-hint': { gate: 'D', trigger_or_gate_id: 'D' },
  'pending-conflict': { gate: 'D', trigger_or_gate_id: 'D' },
  'pending-corrupt': { gate: 'D', trigger_or_gate_id: 'D' },
  'pending-expired': { gate: 'D', trigger_or_gate_id: 'D' },
  'receipt-lost': { gate: 'D', trigger_or_gate_id: 'D' },
};

// conventions.gate_row_class_tag (v2.19): "every gate-bearing row
// (would-warn / emitted / emit-failed / recurrence-candidate, gates A, B
// and D) and every informational row the gate writes carries class_tag =
// the lesson tag the gate implements ... (all three gates implement that
// one lesson); trigger_or_gate_id stays A/B/D. Empty class_tag on a gate
// row is a red (the 2026-09-17 production ledger had 1019 gate rows with
// an empty class_tag, so policy lookups keyed by class_tag could never
// match and M1/M3 grouped them under (unknown)). The runner asserts the
// column on every gate row of every case".
const GATE_ROW_CLASS_TAG = 'process:pipe-hides-exit-code-and-truncates-evidence';
const CLASS_TAG_REQUIRED_EVENT_KINDS = new Set([
  'would-warn', 'emitted', 'emit-failed', 'recurrence-candidate', 'recurrence',
]);
// The `always` mutant's causal sentinel IS a class_tag: mutants.derivation
// makes the injected judge return {A, recurrence, class_tag:
// "mutant-always-<nonce>"} and sentinelPresent() then proves the nonce
// reached the ledger. Asserting the lesson tag in that round would assert
// against the runner's own probe, so the round is skipped BY NAME (and the
// skip is reported) instead of being quietly weakened. null writes no rows
// and blind-parser touches only parse output, so both stay asserted.
function checkGateRowClassTag(rows, mutant) {
  if (mutant === 'always') {
    return { checked: 0, ok: true, violations: [], skipped: 'always mutant writes the causal-sentinel nonce into class_tag' };
  }
  const violations = [];
  let checked = 0;
  for (const r of rows || []) {
    const kind = String(r.event_kind === undefined || r.event_kind === null ? '' : r.event_kind);
    const gateWritten = CLASS_TAG_REQUIRED_EVENT_KINDS.has(kind) ||
      Object.prototype.hasOwnProperty.call(INFORMATIONAL_ROW_ATTRIBUTION, kind);
    if (!gateWritten) continue; // session-end (both columns empty) and M0-only kinds
    checked += 1;
    const tag = String(r.class_tag === undefined || r.class_tag === null ? '' : r.class_tag);
    if (tag !== GATE_ROW_CLASS_TAG) {
      violations.push({
        event_kind: kind, event_id: r.event_id, gate: r.gate, class_tag: tag,
        expected: GATE_ROW_CLASS_TAG, raw: String(r.__raw || '').slice(0, 200),
      });
    }
  }
  return { checked, ok: violations.length === 0, violations };
}
// conventions.run_provenance_policy (v2.20): "run_provenance on gate rows =
// policy:<policy-mode> where policy-mode is absent | shadow | randomized |
// corrupt | shadow-gate (the CLASS policy state for that row, never the
// arm); the arm (intervene|shadow) is only the mode column. P01/P02 expect
// policy:shadow or policy:absent; P03/P04 expect policy:randomized on BOTH
// arms". v2.19 left the string undefined for randomized+intervene, the gate
// wrote the ARM there (policy:intervene) and the runner expected the MODE --
// that collision is what this table closes, so the membership assertion runs
// on every gate row of every case, not only on P01-P04.
const POLICY_RUN_PROVENANCE_VALUES = new Set([
  'policy:absent', 'policy:shadow', 'policy:randomized', 'policy:corrupt', 'policy:shadow-gate',
]);
const POLICY_PROVENANCE_FOR_CASE_MODE = {
  'policy-absent': 'policy:absent', 'policy-shadow': 'policy:shadow',
  'policy-randomized': 'policy:randomized', 'policy-corrupt-eisdir': 'policy:corrupt',
};
function checkGateRowRunProvenance(rows) {
  const violations = [];
  let checked = 0;
  for (const r of rows || []) {
    const kind = String(r.event_kind === undefined || r.event_kind === null ? '' : r.event_kind);
    if (!CLASS_TAG_REQUIRED_EVENT_KINDS.has(kind)) continue; // gate rows only
    checked += 1;
    const v = String(r.run_provenance === undefined || r.run_provenance === null ? '' : r.run_provenance);
    if (!POLICY_RUN_PROVENANCE_VALUES.has(v)) {
      violations.push({
        event_kind: kind, event_id: r.event_id, gate: r.gate, mode: r.mode,
        run_provenance: v, expected_one_of: [...POLICY_RUN_PROVENANCE_VALUES],
      });
    }
  }
  return { checked, ok: violations.length === 0, violations };
}
function describeProvenanceViolations(v) {
  return v.violations.map((x) => x.event_kind + '/' + JSON.stringify(x.gate) +
    ' run_provenance=' + JSON.stringify(x.run_provenance)).join('; ');
}
function describeClassTagViolations(v) {
  return v.violations.map((x) => x.event_kind + '/' + JSON.stringify(x.gate) +
    ' class_tag=' + JSON.stringify(x.class_tag)).join('; ');
}

// `rows` must already be filtered to this case. Every informational row is
// named individually when it is wrong, so "which row" never has to be guessed
// from a boolean.
function checkInformationalAttribution(rows) {
  const violations = [];
  let checked = 0;
  for (const r of rows || []) {
    const kind = r.event_kind;
    const gate = String(r.gate === undefined || r.gate === null ? '' : r.gate);
    const trigger = String(r.trigger_or_gate_id === undefined || r.trigger_or_gate_id === null ? '' : r.trigger_or_gate_id);
    if (kind === 'session-end') {
      checked += 1;
      if (gate !== '' || trigger !== '') {
        violations.push({
          event_kind: kind, event_id: r.event_id, gate, trigger_or_gate_id: trigger,
          expected: { gate: '', trigger_or_gate_id: '' }, raw: String(r.__raw || '').slice(0, 200),
        });
      }
      continue;
    }
    const want = INFORMATIONAL_ROW_ATTRIBUTION[kind];
    if (!want) continue;
    checked += 1;
    if (gate !== want.gate || trigger !== want.trigger_or_gate_id) {
      violations.push({
        event_kind: kind, event_id: r.event_id, gate, trigger_or_gate_id: trigger,
        expected: want, raw: String(r.__raw || '').slice(0, 200),
      });
    }
  }
  return { checked, ok: violations.length === 0, violations };
}

// conventions.row_attribution: these two row kinds are recorded against the
// ORIGINAL pending's tool_use_id, never against the GC event that found them.
const ORIGINAL_PENDING_EVENT_KINDS = new Set(['receipt-lost', 'pending-expired']);

// conventions.lifecycle_expect_keys.note (v2.9): "the runner's known-key set
// for lifecycle and silence cases MUST be built from the keys actually used in
// this contract plus this table; an expect key the runner does not evaluate is
// a red (part8 coverage gate)". These three sets are the runner's side of that
// contract -- the keys it genuinely EVALUATES, one entry per implemented
// check. part8 cross-checks them against both sources (the keys the contract
// uses, and the keys conventions.lifecycle_expect_keys names), so a key added
// to either without an implementation here is red rather than ignored.
const NORMAL_EVALUATED_EXPECT_KEYS = new Set(['gates', 'stdout', 'events', 'arm_stability', 'arm_effect']);
const LIFECYCLE_EVALUATED_EXPECT_KEYS = new Set([
  'gates', 'stdout', 'stderr', 'raw_rows_for_tool_use', 'deduped_rows_for_tool_use',
  'distinct_event_ids', 'distinct_impression_ids', 'pending_files', 'pending_files_after',
  'pending_files_after_in', 'receipt_lines_for_tool_use', 'events', 'events_not_contain',
  // v2.18
  'lease_kept', 'gc_row_identity',
]);
const SILENCE_EVALUATED_EXPECT_KEYS = new Set([
  'stdout', 'stderr', 'rc', 'gates', 'events', 'files_created', 'files_created_glob',
  'write_failures_count_delta', 'row_intact', 'sanitized', 'id_missing', 'no_correlation',
  'agent_id_missing', 'probe_growth', 'sentinel_absent', 'runner_detects_leak',
  // v2.18
  'ledger_rows_for_case', 'wall_clock_under_ms', 'mode_column',
]);
// `note` is prose the case carries for the reader; there is nothing to assert.
// It is declared here rather than silently tolerated, so "not evaluated" is a
// deliberate, visible decision instead of an oversight.
const DOCUMENTATION_ONLY_EXPECT_KEYS = new Set(['note']);
const KNOWN_LIFECYCLE_EXPECT_KEYS = LIFECYCLE_EVALUATED_EXPECT_KEYS;

function evaluateLifecycleExpectation(tc, rows, state, ctx) {
  const exp = tc.expect || {};
  const checks = {};
  const actual = {};
  const rowsForKey = rows.filter((r) => r.tool_use_id === state.lastToolUseId);
  const agg = aggregateLedgerRows(rowsForKey);
  // conventions.row_attribution (MEDIUM-7, Opus r6): receipt-lost and
  // pending-expired belong to the ORIGINAL (crashed/expired) pending's
  // tool_use_id -- the case's FIRST pre step -- and NOT to the event whose
  // GC found them (L16's final read-back pre). v2.6 scanned the UNION of
  // both ids, which made BOTH attributions pass and left the ruling without
  // an assertion. Now each row kind is looked up under exactly one id, and
  // the forbidden attribution is asserted absent.
  const originalPendingToolUseId = state.firstPreToolUseId || state.lastToolUseId;
  const rowsForOriginalPending = rows.filter((r) => r.tool_use_id === originalPendingToolUseId);
  const attributionIds = new Set([state.lastToolUseId, originalPendingToolUseId].filter(Boolean));
  const rowsForAttribution = rows.filter((r) => attributionIds.has(r.tool_use_id));

  // step_grammar (v2.5): any unrecognized step, or any expect key this
  // evaluator does not know how to check, makes the case RED -- never
  // silently skipped.
  checks.noUnrecognizedStep = !state.unrecognizedStep;
  if (state.unrecognizedStep) actual.unrecognized_step = state.unrecognizedStep;
  // MEDIUM-4: an exec step whose precondition is absent makes the case red,
  // instead of being silently repaired by the executor.
  checks.execOpsOk = !(state.failedExecOps && state.failedExecOps.length);
  if (state.failedExecOps && state.failedExecOps.length) actual.failed_exec_ops = state.failedExecOps;
  if (state.closedStdoutSteps && state.closedStdoutSteps.length) actual.closed_stdout_steps = state.closedStdoutSteps;
  const unknownKeys = Object.keys(exp).filter((k) => !KNOWN_LIFECYCLE_EXPECT_KEYS.has(k));
  checks.noUnknownExpectKeys = unknownKeys.length === 0;
  if (unknownKeys.length) actual.unknown_expect_keys = unknownKeys;

  if (exp.gates !== undefined) {
    checks.gatesOk = multisetEqual(exp.gates, agg.distinctGates) && agg.conflicts.length === 0;
    actual.gates = agg.distinctGates;
    actual.conflicts = agg.conflicts;
  }
  if (exp.stdout !== undefined) {
    const lastLog = state.log.length ? state.log[state.log.length - 1] : null;
    checks.stdoutOk = lastLog ? stdoutRuleOk(exp.stdout, lastLog.stdoutSize) : false;
    actual.stdout_size = lastLog ? lastLog.stdoutSize : null;
  }
  // MEDIUM-3 (Opus r7): brief §15 asks the builder to quote L09's stderr byte
  // count, but L09's expect block has no `stderr` key, so the old
  // conditional never wrote one. stderr_size and rc are now ALWAYS reported
  // (report-only unless the case asserts them).
  {
    const lastLog = state.log.length ? state.log[state.log.length - 1] : null;
    const stderrVal = lastLog ? lastLog.stderrSize
      : (state.concurrentStderrTotal !== undefined ? state.concurrentStderrTotal : null);
    actual.stderr_size = stderrVal;
    actual.rc = lastLog ? lastLog.rc : null;
    if (state.concurrentStderrTotal !== undefined) actual.concurrent_stderr_total = state.concurrentStderrTotal;
    if (state.interleaveStderrTotal !== undefined) {
      actual.interleave_stderr_total = state.interleaveStderrTotal;
      actual.interleave_processes = state.interleaveRcs;
    }
    if (exp.stderr !== undefined) checks.stderrOk = stderrVal === exp.stderr;
  }
  // HIGH-5/L11: raw vs deduped vs distinct-event vs distinct-impression, all
  // computed from the SAME event_id-first aggregation.
  if (exp.raw_rows_for_tool_use !== undefined) {
    checks.rawRowsOk = agg.rawCount === exp.raw_rows_for_tool_use;
    actual.raw_rows_for_tool_use = agg.rawCount;
  }
  if (exp.deduped_rows_for_tool_use !== undefined) {
    checks.dedupedRowsOk = agg.dedupedCount === exp.deduped_rows_for_tool_use;
    actual.deduped_rows_for_tool_use = agg.dedupedCount;
  }
  if (exp.distinct_event_ids !== undefined) {
    const distinct = new Set(agg.deduped.map((r) => r.event_id)).size;
    checks.distinctEventIdsOk = distinct === exp.distinct_event_ids;
    actual.distinct_event_ids = distinct;
  }
  if (exp.distinct_impression_ids !== undefined) {
    const distinct = new Set(agg.deduped.map((r) => r.impression_id)).size;
    checks.distinctImpressionIdsOk = distinct === exp.distinct_impression_ids;
    actual.distinct_impression_ids = distinct;
  }
  // conventions.pending_files_semantics (HIGH-5, Opus r6): "evaluated per
  // case: the count of pending files whose name equals this case's key hash
  // (0 or 1) ... never a global count of the shared state dir". v2.6 counted
  // every outstanding pending file under the ONE stateDir a whole round
  // shares, so the six redirect-bearing cases that have no Post step
  // (A12/A18/D08/D09/D10/D20) left an un-reaped pending each and made
  // L15/L15b/L20 unsatisfiable for any correct gate. The raw directory
  // listing is reported (never asserted) as the evidence for that count.
  // v2.16: a case whose last step is a read-back `pre` (H01/H03/L22) has TWO
  // tool_use_ids, and the pending / receipt keys are about the one that OPENED
  // the pending -- the read-back pre has no redirect and never creates one.
  // conventions.pending_files_semantics' "this case's key" is therefore the
  // original pending's key; for every single-id case (L15/L15b/L20) the two are
  // the same value and nothing changes.
  if (exp.pending_files !== undefined || exp.pending_files_after !== undefined ||
      exp.pending_files_after_in !== undefined) {
    const keyPath = pendingKeyPath(ctx.stateDir, state.sessionId, state.lastAgentId, originalPendingToolUseId);
    const own = fs.existsSync(keyPath) ? 1 : 0;
    actual.pending_key_path = keyPath;
    actual.pending_dir_entries = (() => {
      try { return fs.readdirSync(path.join(ctx.stateDir, 'pending')).sort(); } catch (_e) { return []; }
    })();
    actual.pending_dir_outstanding_total = pendingFileCount(ctx.stateDir); // reported, never asserted
    if (exp.pending_files !== undefined) {
      const everHeld = state.pendingKeyEverHeld ? 1 : own;
      checks.pendingFilesOk = everHeld === exp.pending_files;
      actual.pending_files = everHeld;
      actual.pending_files_at_end = own;
    }
    if (exp.pending_files_after !== undefined) {
      checks.pendingFilesAfterOk = own === exp.pending_files_after;
      actual.pending_files_after = own;
    }
    // conventions.lifecycle_expect_keys.pending_files_after_in (v2.9):
    // "race-tolerant form of pending_files_after ... must be one of the listed
    // values". L15b's Pre re-entry and its Post race for the same key, so both
    // 0 (Post consumed last) and 1 (the re-entering Pre re-created it) are
    // legal outcomes; what must NOT happen is a conflict or corrupt event,
    // which events_not_contain asserts separately.
    if (exp.pending_files_after_in !== undefined) {
      const allowed = Array.isArray(exp.pending_files_after_in) ? exp.pending_files_after_in : [];
      checks.pendingFilesAfterInOk = allowed.indexOf(own) >= 0;
      actual.pending_files_after_in = own;
      actual.pending_files_after_in_allowed = allowed;
    }
  }
  // lifecycle_executors["receipts unwritable (L21)"]: the lease must still be
  // there after a post whose receipt append could not succeed.
  if (exp.lease_kept !== undefined) {
    checks.leaseKeptOk = !!state.leaseKept === !!exp.lease_kept;
    actual.lease_kept = !!state.leaseKept;
    actual.lease_files = state.leaseFiles || [];
    actual.receipts_occupied_path = state.receiptsOccupiedPath || null;
  }
  if (exp.receipt_lines_for_tool_use !== undefined) {
    const rf = receiptsPath(ctx.stateDir, state.sessionId, state.lastAgentId);
    let lineCount = 0;
    try { lineCount = fs.readFileSync(rf, 'utf8').split('\n').filter((l) => l.includes(originalPendingToolUseId)).length; } catch (_e) { /* file absent */ }
    checks.receiptLinesOk = lineCount === exp.receipt_lines_for_tool_use;
    actual.receipt_lines_for_tool_use = lineCount;
  }
  {
    // HIGH-3/MEDIUM-11 (v2.6): ALWAYS runs, even with no `events` key at
    // all (treated as `events: []`) -- exact-set comparison against
    // conventions.informational_events (read from the contract). Gate rows
    // (would-warn/emitted/recurrence[-candidate]) are governed by
    // expect.gates + gate_disposition_map, never by this check.
    // conventions.row_attribution: unsupported / path_unresolved / cd-hint
    // belong to "the judging event", which in a multi-event case (H01's heredoc
    // pre, then a read-back pre) is not necessarily the LAST one -- so those
    // kinds are collected over every tool_use_id this case owns. The two GC
    // kinds keep the strict rule: read ONLY under the original pending's id,
    // and asserted absent under the id that discovered them (below).
    const presentInformational = new Set([
      ...rowsForAttribution
        .filter((r) => ctx.informationalEvents.has(r.event_kind) && !ORIGINAL_PENDING_EVENT_KINDS.has(r.event_kind))
        .map((r) => r.event_kind),
      ...rowsForOriginalPending
        .filter((r) => ORIGINAL_PENDING_EVENT_KINDS.has(r.event_kind))
        .map((r) => r.event_kind),
    ]);
    const expectedSet = new Set(exp.events || []);
    checks.eventsOk = presentInformational.size === expectedSet.size &&
      [...expectedSet].every((e) => presentInformational.has(e));
    actual.events = [...new Set(rowsForAttribution.map((r) => r.event_kind))];
    actual.informational_events_present = [...presentInformational];
    // v2.15 M7: the same ruling extended to the identity columns -- a
    // receipt-lost / pending-expired row must carry the ORIGINAL pending's
    // sid_sha16 and agent_sha16.
    const identityViolations = [];
    if (state.firstPreSessionId !== undefined && state.firstPreAgentId !== undefined) {
      const wantSid = sha16(state.firstPreSessionId);
      const wantAgent = sha16(state.firstPreAgentId);
      for (const r of rowsForOriginalPending) {
        if (!ORIGINAL_PENDING_EVENT_KINDS.has(r.event_kind)) continue;
        const sid = String(r.sid_sha16 === undefined || r.sid_sha16 === null ? '' : r.sid_sha16);
        const agent = String(r.agent_sha16 === undefined || r.agent_sha16 === null ? '' : r.agent_sha16);
        if (sid !== wantSid || agent !== wantAgent) {
          identityViolations.push({
            event_kind: r.event_kind, event_id: r.event_id,
            sid_sha16: sid, agent_sha16: agent,
            expected_sid_sha16: wantSid, expected_agent_sha16: wantAgent,
          });
        }
      }
      checks.pendingIdentityOk = identityViolations.length === 0;
      actual.pending_identity = {
        checked: rowsForOriginalPending.filter((r) => ORIGINAL_PENDING_EVENT_KINDS.has(r.event_kind)).length,
        ok: identityViolations.length === 0, violations: identityViolations,
        expected_sid_sha16: wantSid, expected_agent_sha16: wantAgent,
      };
    }
    // The forbidden half of the ruling: those two kinds must NOT be recorded
    // against the event that merely discovered them.
    const misattributed = originalPendingToolUseId === state.lastToolUseId ? []
      : [...new Set(rowsForKey.filter((r) => ORIGINAL_PENDING_EVENT_KINDS.has(r.event_kind)).map((r) => r.event_kind))];
    // lifecycle_executors["cross-session pre (L23)"]: expect.gc_row_identity
    // "original" means the receipt-lost row carries sid_sha16 / agent_sha16 /
    // agent_type / prompt_id AND tool_use_id of the ORIGINAL pending, while the
    // D row of the session-B event carries session B. The first three columns
    // are already covered by pending_identity above; this adds agent_type,
    // prompt_id and the explicit cross-session contrast.
    if (exp.gc_row_identity !== undefined) {
      const gcRows = rowsForOriginalPending.filter((r) => ORIGINAL_PENDING_EVENT_KINDS.has(r.event_kind));
      const wantAgentType = state.firstPreAgentType === undefined ? 'worker' : state.firstPreAgentType;
      const wantPromptId = state.firstPrePromptId;
      const idViolations = [];
      for (const r of gcRows) {
        if (String(r.agent_type || '') !== String(wantAgentType)) {
          idViolations.push({ column: 'agent_type', got: r.agent_type, want: wantAgentType, event_kind: r.event_kind });
        }
        if (wantPromptId !== undefined && String(r.prompt_id || '') !== String(wantPromptId)) {
          idViolations.push({ column: 'prompt_id', got: r.prompt_id, want: wantPromptId, event_kind: r.event_kind });
        }
        if (String(r.tool_use_id || '') !== String(originalPendingToolUseId)) {
          idViolations.push({ column: 'tool_use_id', got: r.tool_use_id, want: originalPendingToolUseId, event_kind: r.event_kind });
        }
      }
      checks.gcRowIdentityOk = gcRows.length > 0 && idViolations.length === 0 &&
        (checks.pendingIdentityOk === undefined || checks.pendingIdentityOk);
      actual.gc_row_identity = {
        rows_checked: gcRows.length, violations: idViolations,
        cross_session_event_tool_use_id: state.crossSessionEventToolUseId || null,
        original_tool_use_id: originalPendingToolUseId,
        expected_agent_type: wantAgentType, expected_prompt_id: wantPromptId === undefined ? null : wantPromptId,
      };
    }
    checks.attributionOk = misattributed.length === 0;
    if (misattributed.length) actual.misattributed_to_gc_event = misattributed;
    actual.original_pending_tool_use_id = originalPendingToolUseId;
  }
  if (exp.events_not_contain !== undefined) {
    const present = new Set(rowsForAttribution.map((r) => r.event_kind));
    checks.eventsNotContainOk = exp.events_not_contain.every((e) => !present.has(e));
    actual.events_seen = [...present];
  }
  // MEDIUM-2: the same disposition assertion for lifecycle cases.
  {
    const disposition = checkDisposition(rowsForKey, tc.mode, ctx.dispositionRules, {
      singleInvocation: true,
      sharedImpressionAcrossArms: caseDeclaresSharedImpressionAcrossArms(tc),
    });
    checks.dispositionOk = disposition.ok;
    actual.disposition = disposition;
    // v2.14: informational rows are checked over BOTH attribution ids, so the
    // receipt-lost / pending-expired rows that belong to the original pending
    // are included.
    const infoAttribution = checkInformationalAttribution(rowsForAttribution);
    checks.informationalAttributionOk = infoAttribution.ok;
    actual.informational_attribution = infoAttribution;
    // v2.19 gate_row_class_tag, same row set as the attribution assertion.
    const classTagCheck = checkGateRowClassTag(rowsForAttribution, ctx.mutant);
    checks.classTagOk = classTagCheck.ok;
    actual.gate_row_class_tag = classTagCheck;
    // v2.20 run_provenance_policy, same row set.
    const provenanceCheck = checkGateRowRunProvenance(rowsForAttribution);
    checks.runProvenanceOk = provenanceCheck.ok;
    actual.gate_row_run_provenance = provenanceCheck;
    // v2.23 process_liveness, aggregated over EVERY step that spawned the
    // gate -- not only the last one, which is the step the stdout/stderr/rc
    // expectations look at. Only the LAST step may carry a declared rc or
    // stderr; an intermediate step that returns anything but rc 0 / 0 bytes
    // is a dead or noisy DUT and the case is red.
    // v2.24: the aggregate comes from the SPAWN SCOPE, so the concurrent and
    // interleaved executors -- which never push into state.log -- are counted
    // like every other invocation, and a case that spawned more processes
    // than it recorded is red on steps < invocations.
    const liveness = aggregateLivenessScope(state.livenessScope, exp);
    endLivenessScope(state.livenessScope);
    checks.livenessOk = liveness.ok;
    actual.process_liveness = liveness;
    // v2.23: "a clock: step must assert that the receipts file named by
    // layout.receipts exists and that at least one line was rewritten".
    if ((tc.steps || []).some((s) => parseStepHeader(s).kind === 'clock')) {
      const rf = receiptsPath(ctx.stateDir, state.sessionId, state.lastAgentId);
      const files = state.clockRewroteFiles || [];
      const exists = files.some((f) => fs.existsSync(f.file));
      // The clause says a clock: step must age at least one receipt line.
      // L23 is a counterexample the clause does not cover: its post-crash
      // step aborts BEFORE any receipt is written (it ages the lease name
      // itself), so at clock time the case owns no receipts file at all.
      // Until v2.23's wording is amended the runner asserts the
      // anti-vacuity property where it can be true -- a case that owns a
      // receipts file must have aged a line in it -- and reports the
      // no-receipts-yet situation by name instead of passing silently or
      // reddening a case whose clock legitimately has nothing to rewrite.
      // (Before MEDIUM-H3 this looked satisfied for L23 only because the
      // glob aged ANOTHER case's receipts in the shared state dir.)
      const ownsNoReceiptsYet = !exists;
      // MEDIUM-H3: name the receipts files the clock deliberately did NOT
      // touch, so "only this case's receipts" is auditable per case and not
      // only in the self-check segment that proves it.
      actual.clock_foreign_receipts_untouched = (state.clockForeignReceipts || []).length;
      checks.clockRewroteOk = ownsNoReceiptsYet || (state.clockRewroteLines || 0) >= 1;
      actual.clock_receipts = {
        receipts_file_for_last_agent: rf, files, exists,
        lines_rewritten: state.clockRewroteLines || 0,
        owns_no_receipts_yet: ownsNoReceiptsYet,
      };
    }
  }
  if (state.clockTsBefore !== undefined) {
    actual.clock_ts_before = state.clockTsBefore;
    actual.clock_ts_after = state.clockTsAfter;
    actual.clock_advance_seconds = state.clockAdvanceSeconds;
  }
  actual.tool_use_id = state.lastToolUseId;

  const pass = Object.values(checks).every(Boolean) && Object.keys(checks).length > 0;
  return { id: tc.id, pass, expected: exp, actual, reason: describeMismatch(checks) };
}

// conventions.policy_file (M-SPEC appendix B3 as amended 2026-09-17, v2.19):
// "<PMM_RECALL_ROOT>/policy.json maps class_tag (the lesson tag, see
// gate_row_class_tag) -> {mode, gates: {A,B,D}, unlocked_by,
// lower95_by_gate, unlocked_at}; missing file / missing class key / corrupt
// file => shadow for everything (run_provenance policy:shadow or
// policy:corrupt); assignment(full_session_id, class_tag) = mode randomized
// ? (first byte of sha256(session||NUL||class_tag) even ? intervene :
// shadow) : shadow -- ONE arm per (session, class) shared by all gates of
// the class; a finding of gate G is actually emitted only when the arm is
// intervene AND gates[G] is randomized ... its rows record mode=shadow and
// run_provenance policy:shadow-gate".
// conventions.policy_modes (v2.19): the three runner modes key the file by
// the class_tag of gate_row_class_tag, with gates {A,B,D} all randomized
// for policy-randomized.
// v2.18 keyed this by a per-gate class tag (exit-status-masked etc.); v2.19
// replaced the key with the ONE lesson tag all three gates implement, which
// is also why P03/P04's expected arm is now sha256(session||NUL||lesson).
const POLICY_GATES = ['A', 'B', 'D'];
const POLICY_MODE_FOR_CASE_MODE = {
  'policy-absent': null, 'policy-shadow': 'shadow', 'policy-randomized': 'randomized',
  // v2.23 policy_modes: "runner mode policy-corrupt-eisdir creates a
  // DIRECTORY at the policy.json path before the event and asserts shadow
  // behaviour with run_provenance policy:corrupt on every gate row".
  'policy-corrupt-eisdir': 'corrupt-eisdir',
};
function isPolicyCaseMode(mode) {
  return Object.prototype.hasOwnProperty.call(POLICY_MODE_FOR_CASE_MODE, String(mode));
}
function policyFilePath(stateDir) { return path.join(stateDir, 'policy.json'); }
function writePolicyFile(stateDir, caseMode, overrides) {
  const p = policyFilePath(stateDir);
  const mode = POLICY_MODE_FOR_CASE_MODE[caseMode];
  try { fs.rmSync(p, { force: true }); } catch (_e) { /* absent */ }
  if (mode === 'corrupt-eisdir') {
    // A directory at the policy path: every read of it fails with EISDIR, so
    // the class policy state is corrupt, not absent.
    mkdirp(p);
    return { corrupt_eisdir: true, path: p };
  }
  if (!mode) return null; // policy-absent: the file must NOT be there
  const gates = {};
  for (const g of POLICY_GATES) gates[g] = mode;
  if (overrides && overrides.gates) {
    for (const g of Object.keys(overrides.gates)) gates[g] = overrides.gates[g];
  }
  const entry = { mode, gates };
  if (mode === 'randomized') {
    entry.unlocked_by = 'acceptance-runner-synthetic';
    entry.lower95_by_gate = {};
    for (const g of POLICY_GATES) if (gates[g] === 'randomized') entry.lower95_by_gate[g] = 0.91;
    entry.unlocked_at = new Date().toISOString();
  }
  const policy = {};
  policy[GATE_ROW_CLASS_TAG] = entry;
  writeFileAtomicText(p, JSON.stringify(policy, null, 2));
  return policy;
}
function clearPolicyFile(stateDir) {
  // recursive: policy-corrupt-eisdir leaves a DIRECTORY at that path
  try { fs.rmSync(policyFilePath(stateDir), { force: true, recursive: true }); } catch (_e) { /* absent */ }
}
// The contract's arm formula, implemented here so the runner can CHOOSE the
// session ids it needs instead of hoping a random one lands on the arm it wants.
function policyArmFor(sessionId, classTag) {
  const tag = classTag === undefined ? GATE_ROW_CLASS_TAG : classTag;
  const first = crypto.createHash('sha256').update(String(sessionId) + '\0' + String(tag), 'utf8').digest()[0];
  return (first % 2 === 0) ? 'intervene' : 'shadow';
}
function sessionIdForArm(classTag, wantArm) {
  for (let i = 0; i < 2000; i++) {
    const s = randId('session');
    if (policyArmFor(s, classTag) === wantArm) return s;
  }
  return null;
}

// One policy event: A01-shaped, no DI (the gate's own assignment must decide).
function runPolicyEvent(tc, ctx, sessionId, label, opts) {
  const cmd = substituteCmd((opts && opts.cmd) || tc.cmd || 'a | b; rc=$?', ctx.pathVariants);
  ensureFixtures(tc.files, ctx.filesDir);
  const toolUseId = randId('tool');
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId, agentId: randId('agent'), agentType: 'worker',
    promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir, command: cmd,
  });
  const stdinPath = writeJsonFile(ctx.ioDir, label + '-' + randId('token') + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: ctx.mutant, forceIntervene: false, nonce: ctx.nonce, callKind: (opts && opts.callKind) || 'sequential' });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: label + '-' + randId('token') });
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  return {
    session_id: sessionId, tool_use_id: toolUseId,
    stdout_size: result.stdoutSize, stderr_size: result.stderrSize, rc: result.rc,
    gates: agg.distinctGates, conflicts: agg.conflicts,
    rows: caseRows.length,
    modes: [...new Set(caseRows.map((r) => String(r.mode || '')))],
    run_provenance: [...new Set(caseRows.map((r) => String(r.run_provenance || '')))],
    event_kinds: [...new Set(caseRows.map((r) => String(r.event_kind || '')))],
    has_emitted: caseRows.some((r) => r.event_kind === 'emitted'),
    informational: [...new Set(caseRows.filter((r) => ctx.informationalEvents.has(r.event_kind)).map((r) => r.event_kind))],
    gate_row_class_tag: checkGateRowClassTag(caseRows, ctx.mutant),
    process_liveness: livenessOf(tc.expect, result, label),
    rows_detail: caseRows.map((r) => ({
      gate: String(r.gate || ''), event_kind: String(r.event_kind || ''),
      mode: String(r.mode || ''), run_provenance: String(r.run_provenance || ''),
      class_tag: String(r.class_tag || ''),
    })),
  };
}

// P03 (arm_stability) and P04 (arm_effect) both need THREE events: the same
// session twice (same arm) and a session whose sha256 parity differs (other
// arm). One executor serves both; each asserts only its own key.
function execPolicyRandomizedCase(tc, ctx) {
  const livenessScope = beginLivenessScope();
  const classTag = GATE_ROW_CLASS_TAG; // v2.19: one lesson tag for all three gates
  writePolicyFile(ctx.stateDir, tc.mode);
  const sessionIntervene = sessionIdForArm(classTag, 'intervene');
  const sessionShadow = sessionIdForArm(classTag, 'shadow');
  const checks = {};
  const actual = { class_tag: classTag, policy_mode: POLICY_MODE_FOR_CASE_MODE[tc.mode] };
  if (!sessionIntervene || !sessionShadow) {
    clearPolicyFile(ctx.stateDir);
    return {
      id: tc.id, pass: false, expected: tc.expect,
      actual: { error: 'could not find session ids for both arms' }, reason: 'arm selection failed',
    };
  }
  const runA1 = runPolicyEvent(tc, ctx, sessionIntervene, 'p-' + tc.id + '-a1');
  const runA2 = runPolicyEvent(tc, ctx, sessionIntervene, 'p-' + tc.id + '-a2');
  const runB = runPolicyEvent(tc, ctx, sessionShadow, 'p-' + tc.id + '-b');
  clearPolicyFile(ctx.stateDir);
  actual.expected_arms = { session_a: 'intervene', session_b: 'shadow' };
  actual.runs = { a1: runA1, a2: runA2, b: runB };

  // every run must still produce the case's gates and no informational event
  const gatesOk = [runA1, runA2, runB].every((r) =>
    multisetEqual(tc.expect.gates || [], r.gates) && r.conflicts.length === 0);
  checks.gatesOk = gatesOk;
  const expectedEvents = new Set(tc.expect.events || []);
  checks.eventsOk = [runA1, runA2, runB].every((r) =>
    r.informational.length === expectedEvents.size && r.informational.every((e) => expectedEvents.has(e)));
  // run_provenance must carry policy:<mode> on every row
  const wantProvenance = POLICY_PROVENANCE_FOR_CASE_MODE[tc.mode];
  checks.runProvenanceOk = [runA1, runA2, runB].every((r) =>
    r.run_provenance.length === 1 && r.run_provenance[0] === wantProvenance);
  actual.expected_run_provenance = wantProvenance;

  // v2.23 (codex MEDIUM-5): the arm of a run is the mode EVERY row carries.
  // The old form asked whether 'intervene' appeared anywhere in the run's
  // modes, which passed a run whose would-warn row said shadow and whose
  // emitted row said intervene -- exactly the bug the clause was written
  // for. A run whose rows disagree is 'mixed' and can never equal an
  // expected arm.
  const armOf = (r) => (r.modes.length === 1 ? r.modes[0] : (r.modes.length ? 'mixed' : 'none'));
  actual.observed_arms = { a1: armOf(runA1), a2: armOf(runA2), b: armOf(runB) };
  if (tc.expect.arm_stability !== undefined) {
    checks.armStabilityOk = armOf(runA1) !== 'none' && armOf(runA1) === armOf(runA2) &&
      armOf(runB) !== 'none' && armOf(runB) !== armOf(runA1);
  }
  if (tc.expect.arm_effect !== undefined) {
    const interveneRun = armOf(runA1) === 'intervene' ? runA1 : (armOf(runB) === 'intervene' ? runB : null);
    const shadowRun = armOf(runA1) === 'shadow' ? runA1 : (armOf(runB) === 'shadow' ? runB : null);
    checks.armEffectOk = !!interveneRun && !!shadowRun &&
      interveneRun.stdout_size > 0 && interveneRun.has_emitted &&
      shadowRun.stdout_size === 0 && !shadowRun.has_emitted;
    actual.arm_effect = {
      intervene: interveneRun ? { stdout: interveneRun.stdout_size, emitted: interveneRun.has_emitted } : null,
      shadow: shadowRun ? { stdout: shadowRun.stdout_size, emitted: shadowRun.has_emitted } : null,
    };
  }
  checks.classTagOk = [runA1, runA2, runB].every((r) => r.gate_row_class_tag.ok);
  // v2.24: one aggregate over EVERY invocation this case spawned -- the three
  // arm runs AND the shadow-gate sub-case's bRun.
  actual.process_liveness_per_run = [runA1, runA2, runB].map((r) => r.process_liveness);
  actual.gate_row_class_tag = [runA1, runA2, runB].map((r) => r.gate_row_class_tag);

  // v2.19 policy_file: "a finding of gate G is actually emitted only when the
  // arm is intervene AND gates[G] is randomized (a gate whose own precision
  // has not cleared M1 stays shadow even inside an intervene session; its
  // rows record mode=shadow and run_provenance policy:shadow-gate)". No
  // contract case carries that clause, so it is asserted here, inside every
  // policy-randomized case, and it is SCORED (report_only:false) -- the
  // assertion's authority is the contract's policy_file text, quoted above.
  {
    writePolicyFile(ctx.stateDir, tc.mode, { gates: { A: 'randomized', B: 'shadow', D: 'randomized' } });
    const bRun = runPolicyEvent(tc, ctx, sessionIntervene, 'p-' + tc.id + '-bshadow', { cmd: 'cmd | head', callKind: 'policy-b' });
    clearPolicyFile(ctx.stateDir);
    const bRows = bRun.rows_detail.filter((r) => r.gate === 'B');
    const modes = [...new Set(bRows.map((r) => r.mode))];
    const prov = [...new Set(bRows.map((r) => r.run_provenance))];
    checks.shadowGateOk = bRows.length > 0 && modes.length === 1 && modes[0] === 'shadow' &&
      prov.length === 1 && prov[0] === 'policy:shadow-gate' && !bRun.has_emitted &&
      bRun.stdout_size === 0 && bRun.gate_row_class_tag.ok;
    actual.shadow_gate_sub_case = {
      report_only: false,
      src: 'conventions.policy_file (v2.19): gates[B]=shadow inside an intervene session',
      session_arm: 'intervene', cmd: 'cmd | head', b_rows: bRows.length,
      mode_column: modes, run_provenance: prov, emitted: bRun.has_emitted,
      stdout_size: bRun.stdout_size, gate_row_class_tag: bRun.gate_row_class_tag,
      rows_detail: bRun.rows_detail,
    };
  }
  const liveness = aggregateLivenessScope(livenessScope, tc.expect);
  endLivenessScope(livenessScope);
  checks.livenessOk = liveness.ok;
  actual.process_liveness = liveness;
  actual.tool_use_id = runB.tool_use_id; // the mutant rounds' sentinel filters on this
  const pass = Object.values(checks).every(Boolean) && Object.keys(checks).length > 0;
  return { id: tc.id, pass, expected: tc.expect, actual, reason: describeMismatch(checks) };
}

// ===========================================================================
// silence_cases (per-id handlers)
// ===========================================================================

function execSilenceCase(tc, ctx, contractCasesById) {
  const handlers = {
    Z01: handleClosedStdin, Z02: handleSingleNul, Z03: handleBadJson, Z04: handleEmptyStdin,
    Z05: handleLedgerUnwritable, Z05b: handleParentIsFile, Z06: handlePathWithoutNode,
    Z07: handleMissNoRedirect, Z08: handleMissWithRedirect, Z09: handleEnvUnlockIgnored,
    Z10: handleTabCrLfNulInToolUseId, Z11: handleUnsupportedRecorded, Z12: handleNoSessionNoCorrelation,
    Z13: handleNoAgentId, Z14: handleNewlineLeak, Z15: handleProductionSelfTestLeak,
    Z16: handleQuotedRedirectNotRedirect, Z17: handleCommentRedirectNotRedirect, Z18: handleHeredocProseRedirectNotRedirect,
    Z19: handleSeamNegativeNoSelftest, Z20: handleSeamNegativeOutsideRoot, Z21: handlePureProductionPositive,
    Z22: handleSeamRejectsDefaultRootStatic, Z23: handleFlatMutantEnvIgnored,
    Z10b: handleUnicodeSeparatorsInToolUseId, Z24: handleOversizeCommand,
    Z10c: handleSanitizeCommandChar, Z10d: handleSanitizeCommandChar,
    Z24b: handleOversizeCommand,
    P01: handlePolicyModeColumn, P02: handlePolicyModeColumn, P06: handlePolicyModeColumn,
  };
  const fn = handlers[tc.id];
  if (!fn) return { id: tc.id, pass: false, expected: tc.expect, actual: null, reason: 'no handler implemented' };
  // conventions.lifecycle_expect_keys.note: an expect key the runner does not
  // evaluate is red -- the same gate lifecycle cases have had since v2.5,
  // which the silence family never got (each handler hand-picked its keys, so
  // a key nobody read was silently ignored).
  const unevaluated = Object.keys(tc.expect || {})
    .filter((k) => !SILENCE_EVALUATED_EXPECT_KEYS.has(k) && !DOCUMENTATION_ONLY_EXPECT_KEYS.has(k));
  if (unevaluated.length) {
    return {
      id: tc.id, pass: false, expected: tc.expect, actual: { unevaluated_expect_keys: unevaluated },
      reason: 'expect key(s) this runner does not evaluate: ' + unevaluated.join(', '),
    };
  }
  const livenessScope = beginLivenessScope();
  let result;
  try { result = fn(tc, ctx, contractCasesById); }
  catch (e) { return { id: tc.id, pass: false, expected: tc.expect, actual: { error: String(e && e.stack || e) }, reason: 'handler threw' }; }

  // MEDIUM-2 (Opus r8): conventions['expect.events'] -- "A case WITHOUT an
  // events key is treated as events: [] (no informational event may be written
  // for that tool_use_id)". Four handlers checked that; the other nineteen did
  // not, so writing an extra cd-hint / pending-conflict / pending-expired was
  // free in those cases. Any handler that did not already produce events
  // evidence gets the same check applied here, against the rows of ITS OWN
  // tool_use_id in ITS OWN state dir. A case with no parseable hook (Z01/Z02
  // send no JSON, Z03 sends broken JSON, Z14 is report_only and executes
  // nothing) has no tool_use_id to filter by and is exempt BY NAME -- listed
  // in the report rather than quietly skipped.
  // v2.14 MEDIUM-2: the informational-row attribution assertion applies to
  // every case, silence cases included, whenever the case can name its own
  // rows. Run before the events fallback so both verdicts are recorded.
  if (result && result.actual && result.actual.tool_use_id) {
    const dir = result.actual.state_dir || ctx.stateDir;
    const rows = readLedgerRows(dir).rows.filter((r) => r.tool_use_id === result.actual.tool_use_id);
    const infoAttribution = checkInformationalAttribution(rows);
    result.actual.informational_attribution = infoAttribution;
    // v2.19 gate_row_class_tag: asserted centrally for the same reason the
    // attribution assertion is -- one place, every handler, no opt-out.
    const classTagCheck = checkGateRowClassTag(rows, ctx.mutant);
    result.actual.gate_row_class_tag = classTagCheck;
    const provenanceCheck = checkGateRowRunProvenance(rows);
    result.actual.gate_row_run_provenance = provenanceCheck;
    if (!provenanceCheck.ok) {
      result.pass = false;
      result.reason = (result.reason && result.reason !== 'ok' ? result.reason + ' | ' : '') +
        'runProvenanceOk mismatch (' + provenanceCheck.violations.length + ' row(s): ' +
        describeProvenanceViolations(provenanceCheck) + ')';
    }
    if (!classTagCheck.ok) {
      result.pass = false;
      result.reason = (result.reason && result.reason !== 'ok' ? result.reason + ' | ' : '') +
        'classTagOk mismatch (' + classTagCheck.violations.length + ' row(s): ' +
        describeClassTagViolations(classTagCheck) + ')';
    }
    if (!infoAttribution.ok) {
      result.pass = false;
      result.reason = (result.reason && result.reason !== 'ok' ? result.reason + ' | ' : '') +
        'informationalAttributionOk mismatch (' + infoAttribution.violations.length + ' row(s): ' +
        infoAttribution.violations.map((v) => v.event_kind + ' gate=' + JSON.stringify(v.gate) +
          ' trigger_or_gate_id=' + JSON.stringify(v.trigger_or_gate_id)).join('; ') + ')';
    }
  }
  // v2.23 process_liveness for the silence/ledger family: the handlers all
  // report rc / stderr_size / spawn_error through finishZ, so the default
  // assertion is applied centrally here and a handler that reports none of
  // them says so in the record instead of passing silently.
  // v2.24: counted over the scope, so Z12's positive control (a second
  // invocation the handler never reported) and any other extra spawn are in
  // the aggregate; a handler that spawns nothing at all is red on checked===0.
  // A report_only case (Z14: "no gate-independent self-spawn") performs no
  // hook invocation by contract, so there is nothing for the counted
  // aggregate to be about; it is recorded as such rather than reddened.
  if (result && result.report_only) {
    endLivenessScope(livenessScope);
    if (!result.actual) result.actual = {};
    result.actual.process_liveness = { checked: false, steps: 0, invocations: livenessScope.spawns, ok: true,
      violations: [], note: 'report_only case: the contract gives it no hook invocation to make' };
  } else if (result) {
    const liveness = aggregateLivenessScope(livenessScope, tc.expect);
    endLivenessScope(livenessScope);
    if (!result.actual) result.actual = {};
    result.actual.process_liveness = liveness;
    if (!liveness.ok) {
      result.pass = false;
      result.reason = (result.reason && result.reason !== 'ok' ? result.reason + ' | ' : '') +
        'livenessOk mismatch (' + describeLivenessViolations(liveness) + ')';
    }
  }
  if (result && result.actual && result.actual.events === undefined) {
    const toolUseId = result.actual.tool_use_id;
    if (!toolUseId) {
      result.silence_events_exempt = true;
      result.silence_events_exempt_reason = 'no parseable hook, so no tool_use_id to attribute rows to';
    } else {
      const dir = result.actual.state_dir || ctx.stateDir;
      const rows = readLedgerRows(dir).rows.filter((r) => r.tool_use_id === toolUseId);
      const ev = silenceEventsCheck(rows, tc.expect.events, ctx.informationalEvents);
      result.actual.events = ev;
      if (!ev.ok) {
        result.pass = false;
        result.reason = (result.reason && result.reason !== 'ok' ? result.reason + ' | ' : '') +
          'eventsOk mismatch (silence fallback: ' + JSON.stringify(ev.unexpected_informational) + ' unasked, ' +
          JSON.stringify(ev.missing) + ' missing)';
      }
    }
  }
  return result;
}

// MEDIUM-5 (Opus r7): four silence handlers checked expect.events with
// `every(e => rows.some(...))` -- a SUBSET test, so Z09/Z11/Z18/Z21 could
// write any number of extra informational events for free, the exact hole
// v2.6 closed for the normal cases.
//
// A literal port of execNormalCase's rule (present informational set ==
// expected set) cannot be used as-is: Z09 and Z21 list "would-warn" in their
// events, which is a GATE-LIFECYCLE kind, not one of
// conventions.informational_events -- so the exact-set comparison would find
// {} != {would-warn} and redden both cases for a correct gate. (That is a
// contract wart: conventions['expect.events'] itself says gate-lifecycle rows
// "are governed by expect.gates + gate_disposition_map, not by expect.events".
// Reported, not worked around.) The rule implemented here is the same
// assertion minus that collision: every named kind must be PRESENT, and no
// informational kind outside the named set may appear -- which is exactly the
// exact-set comparison whenever the named kinds are all informational.
function silenceEventsCheck(caseRows, expectedEvents, informationalEvents) {
  const expected = new Set(expectedEvents || []);
  const present = new Set(caseRows.map((r) => r.event_kind));
  const missing = [...expected].filter((e) => !present.has(e));
  const unexpectedInformational = [...present]
    .filter((k) => informationalEvents.has(k) && !expected.has(k));
  return {
    ok: missing.length === 0 && unexpectedInformational.length === 0,
    missing, unexpected_informational: unexpectedInformational, present: [...present],
  };
}

function baseHookFor(refCaseId, ctx, contractCasesById, overrides) {
  const refCase = contractCasesById[refCaseId];
  const cmd = substituteCmd(refCase.cmd, ctx.pathVariants);
  ensureFixtures(refCase.files, ctx.filesDir);
  return Object.assign({
    hookEventName: 'PreToolUse',
    sessionId: randId('session'), agentId: randId('agent'), agentType: 'worker',
    promptId: randId('prompt'), toolUseId: randId('tool'), cwd: ctx.cwdDir, command: cmd,
  }, overrides || {});
}

function runAndCheckZero(tc, ctx, stdinPath, env, closedStdin) {
  const result = runGateProcess(ctx.gateArgv, {
    stdinPath, closedStdin, cwd: ctx.cwdDir, env: env || buildEnv({ stateDir: ctx.stateDir }),
    ioDir: ctx.ioDir, label: 'z-' + randId('token'),
  });
  const exp = tc.expect;
  const stdoutOk = exp.stdout === undefined || result.stdoutSize === exp.stdout;
  const stderrOk = exp.stderr === undefined || result.stderrSize === exp.stderr;
  const rcOk = exp.rc === undefined || result.rc === exp.rc;
  return { result, stdoutOk, stderrOk, rcOk };
}

function handleClosedStdin(tc, ctx) {
  const env = buildEnv({ stateDir: ctx.stateDir });
  const result = runGateProcessClosedStdin(ctx.gateArgv, { cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z01-' + randId('token') });
  const exp = tc.expect;
  const stdoutOk = exp.stdout === undefined || result.stdoutSize === exp.stdout;
  const stderrOk = exp.stderr === undefined || result.stderrSize === exp.stderr;
  const rcOk = exp.rc === undefined || result.rc === exp.rc;
  // The preflight NEVER makes Z01 red: it records whether the harder
  // condition (every read(0,...) fails) was actually exercised, or whether
  // the host degraded it to the old EOF behavior.
  return finishZ(tc, { stdoutOk, stderrOk, rcOk }, result, {
    z01_read_failure_verified: result.read_failure_verified,
    recipe_used: 'bash -c "' + result.recipe_used + '; exec <gate>"',
    closed_stdin_preflight: result.preflight,
  });
}

function handleSingleNul(tc, ctx) {
  const p = path.join(ctx.ioDir, 'z-' + randId('token') + '.stdin.bin');
  mkdirp(ctx.ioDir);
  fs.writeFileSync(p, Buffer.from([0]));
  const { result, stdoutOk, stderrOk, rcOk } = runAndCheckZero(tc, ctx, p);
  return finishZ(tc, { stdoutOk, stderrOk, rcOk }, result);
}

function handleBadJson(tc, ctx) {
  const p = path.join(ctx.ioDir, 'z-' + randId('token') + '.stdin.txt');
  writeFileAtomicText(p, '{not json');
  const { result, stdoutOk, stderrOk, rcOk } = runAndCheckZero(tc, ctx, p);
  return finishZ(tc, { stdoutOk, stderrOk, rcOk }, result);
}

function handleEmptyStdin(tc, ctx) {
  const p = path.join(ctx.ioDir, 'z-' + randId('token') + '.stdin.txt');
  writeFileAtomicText(p, '');
  const { result, stdoutOk, stderrOk, rcOk } = runAndCheckZero(tc, ctx, p);
  return finishZ(tc, { stdoutOk, stderrOk, rcOk }, result);
}

function handleLedgerUnwritable(tc, ctx, contractCasesById) {
  const stateDir = path.join(ctx.root, 'state-z05-' + randId('token'));
  mkdirp(stateDir);
  const blockedPath = path.join(stateDir, 'events-v3-' + os.hostname() + '.tsv');
  mkdirp(blockedPath);
  const wfPath = path.join(stateDir, 'write-failures.count');
  const before = fs.existsSync(wfPath) ? fs.statSync(wfPath).size : 0;
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z05-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir, mutant: null, forceIntervene: false });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z05-' + randId('token') });
  const after = fs.existsSync(wfPath) ? fs.statSync(wfPath).size : 0;
  const delta = after - before;
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const deltaOk = delta === tc.expect.write_failures_count_delta;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, deltaOk }, result, {
    write_failures_count_delta: delta, tool_use_id: hook.toolUseId, state_dir: stateDir,
  });
}

function handleParentIsFile(tc, ctx, contractCasesById) {
  const stateDirParent = path.join(ctx.root, 'state-z05b-' + randId('token'));
  fs.writeFileSync(stateDirParent, 'not a directory');
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z05b-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: stateDirParent, mutant: null, forceIntervene: false });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z05b-' + randId('token') });
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk }, result, { tool_use_id: hook.toolUseId, state_dir: stateDirParent });
}

// conventions.lifecycle_executors["restricted PATH (Z06 and any env 'PATH
// without <tool>')"]: "the runner resolves the absolute path of the production
// entry interpreter (bash) BEFORE restricting the environment, then spawns that
// absolute path with the restricted PATH in the child env; the case tests that
// the gate stays byte-silent when <tool> (node) is not on PATH, not that bash
// itself is unreachable."
function resolveInterpreterAbsolutePath(exe) {
  // Ask the interpreter itself where it lives, in the CURRENT (unrestricted)
  // environment, and translate to a path the OS spawner can use.
  try {
    const r = spawnSync(exe, ['-c', 'cygpath -w "$(command -v ' + exe + ')" 2>/dev/null || command -v ' + exe],
      { encoding: 'utf8' });
    const p = String((r && r.stdout) || '').trim();
    if (p && fs.existsSync(p)) return p;
  } catch (_e) { /* fall through */ }
  // Git for Windows exports EXEPATH pointing at the directory holding bash.exe.
  const exePath = process.env.EXEPATH;
  if (exePath) {
    for (const rel of [exe + '.exe', path.join('bin', exe + '.exe'), path.join('usr', 'bin', exe + '.exe')]) {
      const p = path.join(exePath, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8' });
    const first = String((r && r.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_e) { /* give up */ }
  return null;
}

// A PATH that still lets the pre-resolved interpreter run (its own directory,
// plus the Windows system dirs) but from which the named tool cannot resolve.
function restrictedPathFor(absInterpreter) {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return [path.dirname(absInterpreter), path.join(sysRoot, 'system32'), sysRoot].join(path.delimiter);
}

function toolResolvableUnderPath(absInterpreter, pathValue, tool) {
  const env = childEnvBase({ PATH: pathValue });
  delete env.Path;
  const r = spawnSync(absInterpreter, ['-c', 'command -v ' + tool], { env, encoding: 'utf8' });
  return r.status === 0 && String((r && r.stdout) || '').trim().length > 0;
}

function handlePathWithoutNode(tc, ctx, contractCasesById) {
  const absInterpreter = resolveInterpreterAbsolutePath(ctx.gateArgv[0]);
  if (!absInterpreter) {
    return {
      id: tc.id, pass: false, expected: tc.expect,
      actual: { interpreter: ctx.gateArgv[0], resolved: null },
      reason: 'could not resolve the absolute path of the entry interpreter before restricting PATH',
    };
  }
  const restrictedPath = restrictedPathFor(absInterpreter);
  // The case only means something if the tool really is unreachable under the
  // restricted PATH -- v2.12 spawned "bash" with PATH=/usr/bin:/bin, which is
  // ENOENT on this host, so the gate never started and the case passed for the
  // wrong reason. Both probes are recorded; the negative one is asserted.
  const nodeUnderRestricted = toolResolvableUnderPath(absInterpreter, restrictedPath, 'node');
  const nodeUnderFull = toolResolvableUnderPath(absInterpreter, process.env.PATH || '', 'node');
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z06-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: null, forceIntervene: false });
  env.PATH = restrictedPath;
  delete env.Path;
  const gateArgv = [absInterpreter].concat(ctx.gateArgv.slice(1));
  const result = runGateProcess(gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z06-' + randId('token') });
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const toolAbsentOk = !nodeUnderRestricted;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, toolAbsentOk }, result, {
    tool_use_id: hook.toolUseId,
    resolved_interpreter: absInterpreter,
    restricted_path: restrictedPath,
    node_resolvable_under_restricted_path: nodeUnderRestricted,
    node_resolvable_under_full_path: nodeUnderFull, // report-only positive control
  });
}

function handleMissNoRedirect(tc, ctx) {
  const before = pendingFileCount(ctx.stateDir);
  const toolUseId = randId('tool');
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId: randId('session'), agentId: randId('agent'),
    agentType: 'worker', promptId: randId('prompt'), toolUseId,
    cwd: ctx.cwdDir, command: 'echo ok',
  });
  const stdinPath = writeJsonFile(ctx.ioDir, 'z07-' + randId('token') + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z07-' + randId('token') });
  const after = pendingFileCount(ctx.stateDir);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const createdOk = (after - before) === tc.expect.files_created;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, createdOk }, result, { files_created: after - before, tool_use_id: toolUseId });
}

// A one-level glob over the state dir ("pending/*"), enough for the only
// value the contract uses. Evaluated rather than left to coincide with
// pendingFileCount()'s regex, which is what made Z08's files_created_glob a
// key nobody checked (Opus r7 MEDIUM-5).
function countStateFilesMatchingGlob(stateDir, glob) {
  const slash = String(glob || '').lastIndexOf('/');
  const dir = slash >= 0 ? glob.slice(0, slash) : '';
  const pattern = slash >= 0 ? glob.slice(slash + 1) : String(glob || '');
  let entries;
  try { entries = fs.readdirSync(path.join(stateDir, dir)); } catch (_e) { return 0; }
  if (pattern === '*') return entries.length;
  const parts = pattern.split('*');
  return entries.filter((name) => {
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue;
      const at = name.indexOf(parts[i], pos);
      if (at < 0) return false;
      if (i === 0 && at !== 0) return false;
      pos = at + parts[i].length;
    }
    return true;
  }).length;
}

function handleMissWithRedirect(tc, ctx) {
  const before = pendingFileCount(ctx.stateDir);
  const globBefore = tc.expect.files_created_glob === undefined ? 0
    : countStateFilesMatchingGlob(ctx.stateDir, tc.expect.files_created_glob);
  const cmd = substituteCmd('echo ok > ABS/p.txt', ctx.pathVariants);
  const toolUseId = randId('tool');
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId: randId('session'), agentId: randId('agent'),
    agentType: 'worker', promptId: randId('prompt'), toolUseId,
    cwd: ctx.cwdDir, command: cmd,
  });
  const stdinPath = writeJsonFile(ctx.ioDir, 'z08-' + randId('token') + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z08-' + randId('token') });
  const after = pendingFileCount(ctx.stateDir);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const createdOk = (after - before) === tc.expect.files_created;
  // files_created_glob pins WHERE the created file must appear, not just that
  // one appeared: "pending/*".
  const checks = { stdoutOk, stderrOk, rcOk, createdOk };
  const extra = { files_created: after - before, tool_use_id: toolUseId };
  if (tc.expect.files_created_glob !== undefined) {
    const globAfter = countStateFilesMatchingGlob(ctx.stateDir, tc.expect.files_created_glob);
    checks.createdUnderGlobOk = (globAfter - globBefore) === tc.expect.files_created;
    extra.files_created_glob = tc.expect.files_created_glob;
    extra.files_created_under_glob = globAfter - globBefore;
  }
  return finishZ(tc, checks, result, extra);
}

function handleEnvUnlockIgnored(tc, ctx, contractCasesById) {
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z09-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: null, forceIntervene: false });
  env.PMM_RECALL_MODE = 'intervene';
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z09-' + randId('token') });
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === hook.toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const ev = silenceEventsCheck(caseRows, tc.expect.events, ctx.informationalEvents);
  const disposition = checkDisposition(caseRows, tc.mode, ctx.dispositionRules, { singleInvocation: true });
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, gatesOk, eventsOk: ev.ok, dispositionOk: disposition.ok }, result, {
    gates: agg.distinctGates, events: ev, disposition, tool_use_id: hook.toolUseId,
  });
}

function handleTabCrLfNulInToolUseId(tc, ctx, contractCasesById) {
  // contract ledger_cases.G10: this case deliberately injects TAB/CR/LF/NUL
  // into a field, so it runs against its OWN state dir -- a gate that does
  // NOT sanitize would otherwise leave torn rows in the SHARED ledger and
  // corrupt every other case's read-side aggregation. The dir is registered
  // on ctx so G10 still scans it (a non-sanitizing gate fails Z10 and G10).
  const stateDir = path.join(ctx.root, 'state-z10-' + randId('token'));
  mkdirp(stateDir);
  if (!ctx.auxStateDirs) ctx.auxStateDirs = [];
  ctx.auxStateDirs.push(stateDir);
  const sessionId = randId('session');
  // TAB, CR, LF and NUL embedded in the tool_use_id -- the row must still be
  // written intact (sanitized) rather than corrupting the TSV structure.
  const dirtyToolUseId = z10DirtyToolUseId('Z10');
  const hook = baseHookFor('A01', ctx, contractCasesById, { toolUseId: dirtyToolUseId, sessionId });
  const stdinPath = writeJsonFile(ctx.ioDir, 'z10-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z10-' + randId('token') });
  const { rows, headerColCount } = readLedgerRows(stateDir);
  const sidSha = sha16(sessionId);
  const caseRows = rows.filter((r) => r.sid_sha16 === sidSha);
  const rowIntact = caseRows.length > 0 && caseRows.every((r) => r.__colCount === headerColCount);
  const sanitizedOk = caseRows.some((r) => String(r.sanitized) === '1');
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, rowIntact, sanitizedOk }, result, {
    row_intact: rowIntact, sanitized_rows: caseRows.filter((r) => String(r.sanitized) === '1').length,
    state_dir: stateDir, tool_use_id: dirtyToolUseId,
  });
}

// Z10b (fab L4 / conventions.sanitize_set): the sanitize set gained VT, FF,
// NEL, LS and PS. A row torn by any of them would be invisible to a reader that
// splits on LF only, so the assertion is on the PHYSICAL rows: each one has
// exactly 21 columns and sanitized=1. Runs against its own state dir for the
// same reason Z10 does (contract G10).
// conventions.sanitize_set (v2.23, codex LOW-9): "the writer-boundary
// sanitize set is the whole C0 range U+0000-U+001F, DEL U+007F, the whole C1
// range U+0080-U+009F, plus LS U+2028 and PS U+2029; sanitized=1 means 'some
// column of this row was rewritten', independent of whether the raw bytes
// would have torn the TSV row". The membership test is per COLUMN VALUE, not
// per raw line -- the line legitimately contains TABs as separators.
const SANITIZE_FORBIDDEN_RE = /[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/;
function firstForbiddenCodepoint(s) {
  const m = SANITIZE_FORBIDDEN_RE.exec(String(s === undefined || s === null ? '' : s));
  return m ? 'U+' + m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0') : null;
}
function checkSanitizedRows(rows, columns) {
  const violations = [];
  for (const r of rows || []) {
    for (const c of columns) {
      const bad = firstForbiddenCodepoint(r[c]);
      if (bad) violations.push({ column: c, codepoint: bad, event_kind: r.event_kind });
    }
    if (String(r.sanitized) !== '1') violations.push({ column: 'sanitized', value: r.sanitized, expected: '1', event_kind: r.event_kind });
  }
  return { checked: (rows || []).length, ok: violations.length === 0, violations };
}
// Z10c (BEL) / Z10d (DEL), contract erratum 2026-09-17: the character sits
// in the TOOL_USE_ID -- the same injection point as Z10/Z10b -- because the
// command string is never stored as a column (only cmd_sha16 is), so a
// command-string injection could never make the writer rewrite a column and
// the case was unsatisfiable for a correct gate.
const SANITIZE_CASE_CHARS = { Z10c: '\u0007', Z10d: '\u007F' };
// contract v2.26 erratum 2 (selftest_id_convention, B1 MEDIUM-1): the Z10
// family's dirty tool_use_ids keep a tu- prefix BEFORE the injected
// characters, so the canary contamination sentinel (^tu-) still counts the
// rows they write. They used to start 'tu' + <char>, which the sentinel could
// not see. One builder for all four cases so part16 can assert the prefix by
// execution (the ids are built at run time and invisible to a static scan).
const Z10_DIRTY_BODIES = {
  Z10: () => '\t' + 'a' + '\r' + 'b' + '\n' + 'c' + '\0' + 'd', // TAB, CR, LF, NUL
  Z10b: () => '\u2028a\u2029b\u0085c\u000Bd\u000Ce', // LS, PS, NEL, VT, FF
  Z10c: () => SANITIZE_CASE_CHARS.Z10c + randId('token'), // BEL
  Z10d: () => SANITIZE_CASE_CHARS.Z10d + randId('token'), // DEL
};
function z10DirtyToolUseId(caseId) {
  const body = Z10_DIRTY_BODIES[caseId];
  if (!body) throw new Error('z10DirtyToolUseId: no dirty id for ' + caseId);
  return 'tu-' + body();
}
function handleSanitizeCommandChar(tc, ctx, contractCasesById) {
  const stateDir = path.join(ctx.root, 'state-' + tc.id.toLowerCase() + '-' + randId('token'));
  mkdirp(stateDir);
  if (!ctx.auxStateDirs) ctx.auxStateDirs = [];
  ctx.auxStateDirs.push(stateDir);
  const ch = SANITIZE_CASE_CHARS[tc.id];
  const sessionId = randId('session');
  const dirtyToolUseId = z10DirtyToolUseId(tc.id);
  const hook = baseHookFor('A01', ctx, contractCasesById, { toolUseId: dirtyToolUseId, sessionId });
  const stdinPath = writeJsonFile(ctx.ioDir, tc.id.toLowerCase() + '-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: tc.id.toLowerCase() + '-' + randId('token') });
  const { rows, headerColCount } = readLedgerRows(stateDir);
  const sidSha = sha16(sessionId);
  const caseRows = rows.filter((r) => r.sid_sha16 === sidSha);
  const rowShapeOk = caseRows.length > 0 && caseRows.every((r) => r.__colCount === headerColCount && headerColCount === 21);
  const sanitize = checkSanitizedRows(caseRows, LEDGER_V3_COLUMNS);
  const sanitizedOk = caseRows.length > 0 && sanitize.ok;
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, rowShapeOk, sanitizedOk }, result, {
    state_dir: stateDir, tool_use_id: dirtyToolUseId,
    injected_codepoint: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
    injected_into: 'tool_use_id',
    ledger_rows_for_case: {
      rows: caseRows.length, header_col_count: headerColCount,
      col_counts: [...new Set(caseRows.map((r) => r.__colCount))],
      sanitized_values: [...new Set(caseRows.map((r) => String(r.sanitized)))],
      sanitize_violations: sanitize.violations.slice(0, 8),
    },
  });
}
function handleUnicodeSeparatorsInToolUseId(tc, ctx, contractCasesById) {
  const stateDir = path.join(ctx.root, 'state-z10b-' + randId('token'));
  mkdirp(stateDir);
  if (!ctx.auxStateDirs) ctx.auxStateDirs = [];
  ctx.auxStateDirs.push(stateDir);
  const sessionId = randId('session');
  const dirtyToolUseId = z10DirtyToolUseId('Z10b');
  const hook = baseHookFor('A01', ctx, contractCasesById, { toolUseId: dirtyToolUseId, sessionId });
  const stdinPath = writeJsonFile(ctx.ioDir, 'z10b-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z10b-' + randId('token') });
  const { rows, headerColCount } = readLedgerRows(stateDir);
  const sidSha = sha16(sessionId);
  const caseRows = rows.filter((r) => r.sid_sha16 === sidSha);
  const rowShapeOk = caseRows.length > 0 && caseRows.every((r) => r.__colCount === headerColCount && headerColCount === 21);
  const sanitizeZ10b = checkSanitizedRows(caseRows, LEDGER_V3_COLUMNS);
  const sanitizedOk = caseRows.length > 0 && sanitizeZ10b.ok;
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, rowShapeOk, sanitizedOk }, result, {
    state_dir: stateDir, tool_use_id: dirtyToolUseId,
    ledger_rows_for_case: {
      rows: caseRows.length, header_col_count: headerColCount,
      col_counts: [...new Set(caseRows.map((r) => r.__colCount))],
      sanitized_values: [...new Set(caseRows.map((r) => String(r.sanitized)))],
    },
  });
}

// Z24 (fab L12 / conventions.oversize_rule): "a command over 1 MiB or a single
// token over 64 KiB is parsed as one unsupported:oversize segment in constant
// time; the gate writes one unsupported row (gate A/A) and returns within 2
// seconds; no pending is opened". The wall clock is measured around the child.
// Z24b (v2.20, Opus increment LOW-E4): "the single-token cap must be
// exercised separately from the whole-input cap" -- an input whose TOTAL
// length is 200 bytes plus one token of 64 KiB + 1 can only trip the
// per-token rule, so a gate that only checks the whole-input length goes red
// here while staying green on Z24.
function oversizeCommandFor(id) {
  if (id !== 'Z24b') return { cmd: 'x'.repeat(1024 * 1024 + 1), single_token_bytes: 1024 * 1024 + 1 };
  const big = 'y'.repeat(64 * 1024 + 1);
  const pre = 'echo ';
  const post = ' | cat';
  const pad = 200 - pre.length - post.length - 1; // 1 for the space before the token
  return {
    cmd: pre + 'a'.repeat(pad) + ' ' + big + post,
    single_token_bytes: big.length, non_token_bytes: 200,
  };
}
function handleOversizeCommand(tc, ctx) {
  const sessionId = randId('session');
  const toolUseId = randId('tool');
  const shape = oversizeCommandFor(tc.id);
  const oversize = shape.cmd;
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId, agentId: randId('agent'), agentType: 'worker',
    promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir, command: oversize,
  });
  const stdinPath = writeJsonFile(ctx.ioDir, tc.id.toLowerCase() + '-' + randId('token') + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir });
  const pendingBefore = pendingFileCount(ctx.stateDir);
  const t0 = Date.now();
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: tc.id.toLowerCase() + '-' + randId('token') });
  const elapsed = Date.now() - t0;
  const pendingAfter = pendingFileCount(ctx.stateDir);
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const ev = silenceEventsCheck(caseRows, tc.expect.events, ctx.informationalEvents);
  const wallOk = tc.expect.wall_clock_under_ms === undefined || elapsed < tc.expect.wall_clock_under_ms;
  const noPendingOk = pendingAfter === pendingBefore;
  return finishZ(tc, {
    stdoutOk, stderrOk, rcOk, gatesOk, eventsOk: ev.ok, wallOk, noPendingOk,
  }, result, {
    tool_use_id: toolUseId, command_bytes: oversize.length,
    single_token_bytes: shape.single_token_bytes, non_token_bytes: shape.non_token_bytes,
    wall_clock_ms: elapsed,
    wall_clock_under_ms: tc.expect.wall_clock_under_ms, gates: agg.distinctGates, events: ev,
    pending_created: pendingAfter - pendingBefore,
  });
}

// P01 (policy absent) and P02 (policy shadow): the ledger mode column must read
// shadow and run_provenance must carry policy:<mode>.
function handlePolicyModeColumn(tc, ctx, contractCasesById) {
  writePolicyFile(ctx.stateDir, tc.mode);
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'p-' + tc.id + '-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: null, forceIntervene: false });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'p-' + tc.id + '-' + randId('token') });
  clearPolicyFile(ctx.stateDir);
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === hook.toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const ev = silenceEventsCheck(caseRows, tc.expect.events, ctx.informationalEvents);
  const modes = [...new Set(caseRows.map((r) => String(r.mode || '')))];
  const provenance = [...new Set(caseRows.map((r) => String(r.run_provenance || '')))];
  const wantProvenance = POLICY_PROVENANCE_FOR_CASE_MODE[tc.mode] || 'policy:shadow';
  const modeColumnOk = tc.expect.mode_column === undefined ||
    (modes.length === 1 && modes[0] === tc.expect.mode_column);
  const gateRows = caseRows.filter((r) => CLASS_TAG_REQUIRED_EVENT_KINDS.has(String(r.event_kind || '')));
  const provenanceOk = gateRows.length > 0 &&
    gateRows.every((r) => String(r.run_provenance || '') === wantProvenance);
  return finishZ(tc, {
    stdoutOk, stderrOk, rcOk, gatesOk, eventsOk: ev.ok, modeColumnOk, provenanceOk,
  }, result, {
    tool_use_id: hook.toolUseId, gates: agg.distinctGates, events: ev,
    mode_column: modes, run_provenance: provenance, expected_run_provenance: wantProvenance,
    policy_mode: POLICY_MODE_FOR_CASE_MODE[tc.mode],
  });
}

function handleUnsupportedRecorded(tc, ctx) {
  const sessionId = randId('session');
  const toolUseId = randId('tool');
  const cmd = 'if a | b; then rc=$?; fi';
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId, agentId: randId('agent'), agentType: 'worker',
    promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir, command: cmd,
  });
  const stdinPath = writeJsonFile(ctx.ioDir, 'z11-' + randId('token') + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z11-' + randId('token') });
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const ev = silenceEventsCheck(caseRows, tc.expect.events, ctx.informationalEvents);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, eventsOk: ev.ok }, result, { events: ev });
}

// Z12 (v2.4): a receipt for ABS/r.txt exists for session S; a D-read WITHOUT
// session_id must NOT correlate to it (stays recurrence-candidate, not
// recurrence), and must mark id_missing.
// Z12 (v2.5 MEDIUM-9): positive control added. The SAME manufactured
// receipt is read twice: once WITH the matching session (must correlate to
// {D,recurrence}), once WITHOUT session_id (must NOT correlate, staying
// {D,recurrence-candidate} + id_missing=1). Without the positive read, a
// "never correlates" implementation would pass the negative half for the
// wrong reason.
function handleNoSessionNoCorrelation(tc, ctx) {
  ensureFixtures(['r.txt'], ctx.filesDir);
  const sessionS = randId('session');
  const agentS = randId('agent');
  const rf = receiptsPath(ctx.stateDir, sessionS, agentS);
  mkdirp(path.dirname(rf));
  const nowIso = new Date().toISOString();
  fs.appendFileSync(rf, [nowIso, 'created-nonempty', path.join(ctx.filesDir, 'r.txt'), randId('tool'), '0'].join('\t') + '\n');
  const cmd = substituteCmd('tail -6 ABS/r.txt', ctx.pathVariants);

  // Positive control: same session S, same agent -> expect {D,recurrence}.
  const toolUseIdPos = randId('tool');
  const hookPos = buildHookJson({
    hookEventName: 'PreToolUse', sessionId: sessionS, agentId: agentS, agentType: 'worker',
    promptId: randId('prompt'), toolUseId: toolUseIdPos, cwd: ctx.cwdDir, command: cmd,
  });
  const stdinPos = writeJsonFile(ctx.ioDir, 'z12pos-' + randId('token') + '.stdin.json', hookPos);
  const envPos = buildEnv({ stateDir: ctx.stateDir });
  runGateProcess(ctx.gateArgv, { stdinPath: stdinPos, cwd: ctx.cwdDir, env: envPos, ioDir: ctx.ioDir, label: 'z12pos-' + randId('token') });
  const { rows: rowsAfterPos } = readLedgerRows(ctx.stateDir);
  const posRows = rowsAfterPos.filter((r) => r.tool_use_id === toolUseIdPos);
  const posAgg = aggregateLedgerRows(posRows);
  const positiveOk = multisetEqual([{ gate: 'D', confidence: 'recurrence' }], posAgg.distinctGates) && posAgg.conflicts.length === 0;

  // Negative half (the contract's literal case): no session_id -> must NOT
  // correlate, stays {D,recurrence-candidate}.
  const toolUseId = randId('tool');
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId: undefined, agentId: agentS, agentType: 'worker',
    promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir, command: cmd,
  });
  const stdinPath = writeJsonFile(ctx.ioDir, 'z12-' + randId('token') + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z12-' + randId('token') });
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const idMissingOk = caseRows.some((r) => String(r.id_missing) === '1');
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  // no_correlation was computed and REPORTED but never asserted (Opus r7
  // MEDIUM-5): a gate that correlated anyway still passed as long as the
  // gates multiset matched.
  const noCorrelation = agg.distinctGates.length > 0 && agg.distinctGates.every((g) => g.confidence !== 'recurrence');
  const noCorrelationOk = tc.expect.no_correlation === undefined || noCorrelation === tc.expect.no_correlation;
  // LOW-1 (Opus r8): the positive half asserts a {D,recurrence} finding, so it
  // is exactly a case where a gate could write the wrong event_kind sequence
  // and nothing would notice.
  const positiveDisposition = checkDisposition(posRows, tc.mode, ctx.dispositionRules, { singleInvocation: true });
  return finishZ(tc, {
    stdoutOk, stderrOk, rcOk, gatesOk, idMissingOk, positiveOk, noCorrelationOk,
    dispositionOk: positiveDisposition.ok,
  }, result, {
    gates: agg.distinctGates, positive_control_gates: posAgg.distinctGates,
    no_correlation: noCorrelation, tool_use_id: toolUseId,
    positive_control_disposition: positiveDisposition,
  });
}

function handleNoAgentId(tc, ctx, contractCasesById) {
  const toolUseId = randId('tool');
  const hook = baseHookFor('A01', ctx, contractCasesById, { toolUseId, agentId: undefined });
  const stdinPath = writeJsonFile(ctx.ioDir, 'z13-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z13-' + randId('token') });
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const agentIdMissingOk = caseRows.some((r) => String(r.agent_id_missing) === '1');
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, agentIdMissingOk }, result, {
    agent_id_missing_rows: caseRows.filter((r) => String(r.agent_id_missing) === '1').length,
    tool_use_id: toolUseId,
  });
}

// Z14 (MEDIUM-2, Opus r6): the contract now labels this case
// "tests the runner's own capture, not the gate -- report_only, not in
// allPass". v2.6 spawned `bash -c 'printf ok; echo >&2'` -- a process that
// has nothing to do with the gate under test -- and counted the resulting
// "yes, one byte of stderr was captured" toward allPass, so a gate that did
// not exist at all still scored a green here. The self-spawn is gone; the
// claim it was making (this runner's file capture is byte-accurate on the
// gate's OWN stderr channel) is made, and asserted, by Z15, which drives the
// real gate through the real seam. This handler now only records the
// delegation.
function handleNewlineLeak(tc, ctx) {
  void ctx;
  return {
    id: tc.id,
    pass: true,
    report_only: true,
    expected: tc.expect,
    actual: {
      executed: false,
      runner_detects_leak: 'asserted by Z15 (leaky module through the real seam, stderr == 1 byte)',
    },
    reason: 'report_only per contract silence_cases.Z14 (not counted in allPass); no gate-independent self-spawn',
  };
}

// Z15 (v2.5 HIGH-9 fix): dropped the impossible-to-verify claim about the
// PRODUCTION gate's OWN --self-test internals. Now: inject a leaky module
// (judge writes exactly one newline to stderr) through the real seam
// (SELFTEST=1, root redirected, path inside root) for A01's ordinary hook
// JSON through the PRODUCTION entry point, and assert THIS RUNNER's own
// byte-accurate file capture sees stderr size == 1. This proves the gate's
// stderr channel reaches the runner byte-exactly -- the separate, weaker
// claim about --self-test's internal behavior is left to brief §12 /
// runner_duties[2]'s rc==0 check, not to this case.
// MEDIUM-5 (v2.6): Z15's contract text is explicit -- "exports ONLY judge"
// and "one judge call per event -> exactly one byte". Exporting `parse`
// too would leak a SECOND byte on a normal call sequence (parse then
// judge), wrongly reddening a correct implementation. `parse` is left
// unexported so the gate's real parser (unaffected by this seam) still
// runs.
function writeLeakyModule(dir) {
  mkdirp(dir);
  const p = path.join(dir, 'leak-' + randId('token') + '.cjs');
  fs.writeFileSync(p, [
    "'use strict';",
    "const fs = require('fs');",
    'function leak() {',
    "  try { fs.writeSync(2, '\\n'); } catch (e) {}",
    '  return { gates: [], events: [] };',
    '}',
    'module.exports = { judge: leak };',
  ].join('\n'), 'utf8');
  return p;
}
function handleProductionSelfTestLeak(tc, ctx, contractCasesById) {
  const leakModulePath = writeLeakyModule(path.join(ctx.stateDir, 'inject'));
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z15-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: null, forceIntervene: false });
  env.PIPE_GATE_INJECT = leakModulePath;
  env.PIPE_GATE_SELFTEST = '1';
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z15-' + randId('token') });
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  return {
    id: tc.id, pass: stdoutOk && stderrOk && rcOk,
    expected: tc.expect,
    actual: { stdout_size: result.stdoutSize, stderr_size: result.stderrSize, rc: result.rc, tool_use_id: hook.toolUseId },
    reason: describeMismatch({ stdoutOk, stderrOk, rcOk }),
  };
}

// Z19 (v2.5 MEDIUM-5 negative #1): PIPE_GATE_INJECT set but
// PIPE_GATE_SELFTEST NOT set -> seam_hard_condition fails -> gate must
// ignore the injection entirely (no load, no probe, no sentinel) and judge
// with its own real handler.
function handleSeamNegativeNoSelftest(tc, ctx, contractCasesById) {
  const alwaysModulePath = path.join(ctx.stateDir, 'inject', 'always-copy-' + randId('token') + '.cjs');
  mkdirp(path.dirname(alwaysModulePath));
  fs.copyFileSync(MUTANT_PATHS.always, alwaysModulePath);
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z19-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: null, forceIntervene: false });
  env.PIPE_GATE_INJECT = alwaysModulePath; // set...
  delete env.PIPE_GATE_SELFTEST;           // ...but SELFTEST unset
  const before = probeLineCount(ctx.stateDir);
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z19-' + randId('token') });
  const after = probeLineCount(ctx.stateDir);
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === hook.toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const probeGrowthOk = (after - before) === tc.expect.probe_growth;
  const sentinelAbsentOk = !caseRows.some((r) => String(r.class_tag || '').includes('mutant-always-'));
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, gatesOk, probeGrowthOk, sentinelAbsentOk }, result, {
    gates: agg.distinctGates, probe_growth: after - before, tool_use_id: hook.toolUseId,
  });
}

// Z20 (v2.5 MEDIUM-5 negative #2): PIPE_GATE_SELFTEST=1 but the injected
// module path resolves OUTSIDE PMM_RECALL_ROOT -> seam_hard_condition
// fails -> same expectation as Z19.
function handleSeamNegativeOutsideRoot(tc, ctx, contractCasesById) {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgv2-outside-root-'));
  const alwaysModulePath = path.join(outsideDir, 'always-copy-' + randId('token') + '.cjs');
  fs.copyFileSync(MUTANT_PATHS.always, alwaysModulePath);
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z20-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: null, forceIntervene: false });
  env.PIPE_GATE_INJECT = alwaysModulePath; // outside PMM_RECALL_ROOT
  env.PIPE_GATE_SELFTEST = '1';
  const before = probeLineCount(ctx.stateDir);
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z20-' + randId('token') });
  const after = probeLineCount(ctx.stateDir);
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === hook.toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const probeGrowthOk = (after - before) === tc.expect.probe_growth;
  const sentinelAbsentOk = !caseRows.some((r) => String(r.class_tag || '').includes('mutant-always-'));
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, gatesOk, probeGrowthOk, sentinelAbsentOk }, result, {
    gates: agg.distinctGates, probe_growth: after - before, tool_use_id: hook.toolUseId,
  });
}

// Z21 (v2.5 MEDIUM-12 positive control): NO PIPE_GATE_INJECT, NO
// PIPE_GATE_SELFTEST at all -- pure production environment (only
// PMM_RECALL_ROOT set, as every case needs for isolation). A01's real
// finding must still surface via the gate's own real handler, in shadow
// (no DI => no forced intervene => the gate's own default disposition,
// which per brief §6 is the constant `shadow` at this stage).
function handlePureProductionPositive(tc, ctx, contractCasesById) {
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z21-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: null, forceIntervene: false }); // no seam vars at all
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z21-' + randId('token') });
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === hook.toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const ev = silenceEventsCheck(caseRows, tc.expect.events, ctx.informationalEvents);
  const sentinelAbsentOk = !caseRows.some((r) => String(r.class_tag || '').includes('mutant-always-'));
  const disposition = checkDisposition(caseRows, tc.mode, ctx.dispositionRules, { singleInvocation: true });
  return finishZ(tc, {
    stdoutOk, stderrOk, rcOk, gatesOk, eventsOk: ev.ok, sentinelAbsentOk, dispositionOk: disposition.ok,
  }, result, { gates: agg.distinctGates, events: ev, disposition, tool_use_id: hook.toolUseId });
}

// Z22 (v2.5 MEDIUM-5, seam_hard_condition's 3rd clause): STATIC assertion
// only -- per the case's own text, the runner must NOT execute this against
// the real default production root. Instead, grep the gate source for
// evidence it rejects the seam when PMM_RECALL_ROOT is unset or equals the
// default. This can only be a best-effort text-pattern check; a genuine
// negative here is unverifiable without either running against the real
// default root (explicitly forbidden by the case) or the gate exposing a
// dedicated self-test hook for it.
// Z22 (v2.6 MEDIUM-7): a static grep is not acceptable for a case that
// gates `allPass`. Made BEHAVIORAL instead, without ever touching the real
// default production root: HOME/USERPROFILE are redirected to a runner-
// owned temp dir for the CHILD PROCESS ONLY, so the gate's own
// `os.homedir()`-based default-root computation resolves inside that temp
// dir. PMM_RECALL_ROOT is left UNSET (the case's literal premise), so
// seam_hard_condition's first clause ("PMM_RECALL_ROOT is set") already
// fails regardless of where the computed default lands -- the injected
// `always` module (placed inside that computed default, satisfying the
// OTHER two clauses in isolation) must still be ignored.
function handleSeamRejectsDefaultRootStatic(tc, ctx) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pgv2-fakehome-'));
  const computedDefaultRoot = path.join(fakeHome, '.claude', '.local', 'pmm-recall');
  mkdirp(computedDefaultRoot);
  const alwaysModulePath = path.join(computedDefaultRoot, 'always-copy-' + randId('token') + '.cjs');
  fs.copyFileSync(MUTANT_PATHS.always, alwaysModulePath);

  const cmd = substituteCmd('a | b; rc=$?', ctx.pathVariants);
  const toolUseId = randId('tool');
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId: randId('session'), agentId: randId('agent'), agentType: 'worker',
    promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir, command: cmd,
  });
  const stdinPath = writeJsonFile(ctx.ioDir, 'z22-' + randId('token') + '.stdin.json', hook);
  const env = childEnvBase();
  env.PMM_RECALL_TAG = 'test';
  delete env.PMM_RECALL_ROOT; // literal premise: unset
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;
  env.PIPE_GATE_SELFTEST = '1';
  env.PIPE_GATE_INJECT = alwaysModulePath;
  const before = probeLineCount(computedDefaultRoot);
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z22-' + randId('token') });
  const after = probeLineCount(computedDefaultRoot);
  const { rows } = readLedgerRows(computedDefaultRoot);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const probeGrowthOk = (after - before) === tc.expect.probe_growth;
  const sentinelAbsentOk = !caseRows.some((r) => String(r.class_tag || '').includes('mutant-always-'));
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, gatesOk, probeGrowthOk, sentinelAbsentOk }, result, {
    gates: agg.distinctGates, probe_growth: after - before, computed_default_root: computedDefaultRoot,
    tool_use_id: toolUseId, state_dir: computedDefaultRoot,
  });
}

// Z23 (fab blind attack MEDIUM-1): PMM_CMD_PARSE_MUTANT=flat in the
// environment must not change production judgment. The runner no longer sets
// that variable anywhere (buildEnv deletes it and G08's flat round calls
// applyFlatMutant directly), so this case is the behavioural half of "the
// production parser does not read it": A01 through the real handler, with the
// variable present, must still produce the A/recurrence would-warn row.
function handleFlatMutantEnvIgnored(tc, ctx, contractCasesById) {
  const hook = baseHookFor('A01', ctx, contractCasesById);
  const stdinPath = writeJsonFile(ctx.ioDir, 'z23-' + randId('token') + '.stdin.json', buildHookJson(hook));
  const env = buildEnv({ stateDir: ctx.stateDir, mutant: null, forceIntervene: false });
  env.PMM_CMD_PARSE_MUTANT = 'flat';
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'z23-' + randId('token') });
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === hook.toolUseId);
  const agg = aggregateLedgerRows(caseRows);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const gatesOk = multisetEqual(tc.expect.gates || [], agg.distinctGates) && agg.conflicts.length === 0;
  const ev = silenceEventsCheck(caseRows, tc.expect.events, ctx.informationalEvents);
  const disposition = checkDisposition(caseRows, tc.mode, ctx.dispositionRules, { singleInvocation: true });
  return finishZ(tc, {
    stdoutOk, stderrOk, rcOk, gatesOk, eventsOk: ev.ok, dispositionOk: disposition.ok,
  }, result, { gates: agg.distinctGates, events: ev, disposition, tool_use_id: hook.toolUseId });
}

function handleQuotedOrCommentOrHeredoc(tc, ctx, cmd) {
  const before = pendingFileCount(ctx.stateDir);
  const substituted = substituteCmd(cmd, ctx.pathVariants);
  const toolUseId = randId('tool');
  const hook = buildHookJson({
    hookEventName: 'PreToolUse', sessionId: randId('session'), agentId: randId('agent'),
    agentType: 'worker', promptId: randId('prompt'), toolUseId, cwd: ctx.cwdDir, command: substituted,
  });
  const stdinPath = writeJsonFile(ctx.ioDir, 'zqc-' + randId('token') + '.stdin.json', hook);
  const env = buildEnv({ stateDir: ctx.stateDir });
  const result = runGateProcess(ctx.gateArgv, { stdinPath, cwd: ctx.cwdDir, env, ioDir: ctx.ioDir, label: 'zqc-' + randId('token') });
  const after = pendingFileCount(ctx.stateDir);
  const stdoutOk = result.stdoutSize === tc.expect.stdout;
  const stderrOk = result.stderrSize === tc.expect.stderr;
  const rcOk = result.rc === tc.expect.rc;
  const createdOk = tc.expect.files_created === undefined || (after - before) === tc.expect.files_created;
  const { rows } = readLedgerRows(ctx.stateDir);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const ev = silenceEventsCheck(caseRows, tc.expect.events, ctx.informationalEvents);
  return finishZ(tc, { stdoutOk, stderrOk, rcOk, createdOk, eventsOk: ev.ok }, result, {
    files_created: after - before, files_created_glob: tc.expect.files_created_glob || null, events: ev,
  });
}

function handleQuotedRedirectNotRedirect(tc, ctx) { return handleQuotedOrCommentOrHeredoc(tc, ctx, "echo '>' ABS/x.txt"); }
function handleCommentRedirectNotRedirect(tc, ctx) { return handleQuotedOrCommentOrHeredoc(tc, ctx, 'echo hi # > ABS/x.txt'); }
function handleHeredocProseRedirectNotRedirect(tc, ctx) { return handleQuotedOrCommentOrHeredoc(tc, ctx, "cat <<'EOF'\nsee > ABS/x.txt\nEOF"); }

// conventions.process_liveness (v2.23, codex HIGH-1): "EVERY hook
// invocation the runner performs -- every case in cases, every pre/post step
// of every lifecycle case, every silence and ledger case -- asserts
// spawnError === null AND rc === 0 AND stderrSize === 0 by default, in
// addition to the case expectations; ... a case may relax rc or stderr ONLY
// by declaring a different value explicitly in its own expect". Without this
// a gate that dies at start is indistinguishable from correct silence,
// because uncaughtException -> exit(0) is the gate's own crash handler.
function livenessOf(expect, result, label) {
  const exp = expect || {};
  const wantRc = exp.rc !== undefined ? exp.rc : 0;
  const wantStderr = exp.stderr !== undefined ? exp.stderr : 0;
  const violations = [];
  if (result.spawnError) violations.push({ where: label || '', spawn_error: result.spawnError });
  if (result.rc !== wantRc) violations.push({ where: label || '', rc: result.rc, expected_rc: wantRc });
  if (result.stderrSize !== wantStderr) {
    violations.push({
      where: label || '', stderr_size: result.stderrSize, expected_stderr: wantStderr,
      stderr_head: (readTextSafe(result.stderrPath) || '').slice(0, 200),
    });
  }
  return { checked: true, ok: violations.length === 0, violations };
}
function mergeLiveness(parts) {
  const violations = [];
  let checked = 0;
  for (const p of parts || []) { if (!p) continue; if (p.checked) checked += 1; for (const v of p.violations || []) violations.push(v); }
  // v2.24: an aggregate that checked NOTHING is red by itself -- the old
  // form returned ok:true for an empty list, which is how a case that
  // spawned two concurrent gates reported {checked:false, steps:0, ok:true}.
  if (checked === 0) violations.push({ reason: 'no liveness record for this case: nothing was checked' });
  return { checked: checked > 0, steps: checked, ok: violations.length === 0, violations };
}
// The per-case aggregate: every record the spawn helpers collected in this
// case's scope, scored against the case's own expect for the LAST invocation
// only, plus the count check that makes a forgotten executor impossible to
// hide (steps < invocations).
function aggregateLivenessScope(scope, expect) {
  const records = (scope && scope.records) || [];
  const parts = records.map((r, i) => livenessOf(i === records.length - 1 ? expect : {}, r,
    r.label || ('invocation[' + i + ']')));
  const agg = mergeLiveness(parts);
  agg.invocations = (scope && scope.spawns) || 0;
  if (agg.steps < agg.invocations) {
    agg.ok = false;
    agg.violations.push({
      reason: 'liveness records (' + agg.steps + ') < gate invocations actually spawned (' + agg.invocations + ')',
    });
  }
  return agg;
}
function describeLivenessViolations(l) {
  return (l.violations || []).map((v) => (v.where ? v.where + ': ' : '') +
    (v.reason ? v.reason
      : v.spawn_error ? 'spawn error ' + v.spawn_error
        : v.rc !== undefined ? 'rc ' + v.rc + ' (expected ' + v.expected_rc + ')'
          : 'stderr ' + v.stderr_size + ' bytes (expected ' + v.expected_stderr + ') ' + JSON.stringify(v.stderr_head))).join('; ');
}
function finishZ(tc, checks, result, extraActual) {
  const pass = Object.values(checks).every(Boolean);
  const actual = Object.assign({ stdout_size: result.stdoutSize, stderr_size: result.stderrSize, rc: result.rc,
    spawn_error: result.spawnError === undefined ? null : result.spawnError }, extraActual || {});
  return { id: tc.id, pass, expected: tc.expect, actual, reason: describeMismatch(checks) };
}

// ===========================================================================
// parser conformance fixture (whatever the pinned fixture holds -- 118 cases
// at fixture 1.2.8) against the PRODUCTION pmm-cmd-parse.cjs
// ===========================================================================

// v1.2 修订 ⑤ item 7 (v2.6 item 6): "notes 里不得出现『my own construction /
// by analogy / inference / 契约未述 / contract-unstated』等措辞——runner 启动
// 时机器扫描,命中即红". Scanned once per run against whatever conformance
// fixture is loaded; a hit means some fixture case's expectation is
// self-admittedly inferred rather than contract-derived.
// LOW-5 (Opus r6 MEDIUM-5, still open at r7): five literals are trivially
// paraphrased. Extended to the round-7 list. This is still a blacklist and
// still cannot be complete -- the durable fix is the positive requirement
// ("every note cites a contract clause id"), which belongs to the fixture
// author, not here. Verified against fixture 1.2.2: 0 hits, so extending it
// costs no correct case today.
// conventions.inference_wording_scan (v2.10): the scan "is red only for the
// specific patterns ... the four broad English words (assume/assumes/assumed,
// probably, likely, seems) are REPORT-ONLY hits listed in the report but never
// red, because legitimate notes such as \"assumes UTF-8\" must not fail the
// fixture". The red list below is the contract's ten plus the four literals
// the parse contract's 修订 ⑤ item 7 banned by name (my own construction /
// by analogy / 契约未述 / contract-unstated) -- each of those is a verbatim
// English or Chinese twin of one the contract lists, so keeping them cannot
// widen the intent, only spell it out.
const INFERENCE_WORDING_PATTERNS = [
  /my own construction/i, /by analogy/i, /\binference\b/i, /契约未述/, /contract-unstated/i,
  /\binferred\b/i, /推断/, /自拟/, /类比/, /judgment call/i, /never defines/i,
  /contract does not define/i, /\bguess(es|ed)?\b/i, /猜/,
];
const INFERENCE_WORDING_REPORT_ONLY_PATTERNS = [
  /\bassume[sd]?\b/i, /\bprobably\b/i, /\blikely\b/i, /\bseems\b/i,
];
function scanFixtureNotesForInferenceWording(conformancePath) {
  // A missing, unparseable or wrong-version fixture throws out of
  // loadConformanceFixture and aborts the run (rc 2) rather than being
  // downgraded to a red scan result: the fixture is a pre-registered,
  // blob-pinned oracle, so there is no meaningful run without the right one.
  const fixture = loadConformanceFixture(conformancePath);
  const hits = [];
  const reportOnlyHits = [];
  for (const tc of fixture.cases || []) {
    const notes = String(tc.notes || '');
    for (const re of INFERENCE_WORDING_PATTERNS) {
      if (re.test(notes)) { hits.push({ id: tc.id, pattern: re.source, notes }); break; }
    }
    for (const re of INFERENCE_WORDING_REPORT_ONLY_PATTERNS) {
      if (re.test(notes)) { reportOnlyHits.push({ id: tc.id, pattern: re.source, notes: notes.slice(0, 200) }); break; }
    }
  }
  return {
    pass: hits.length === 0, hits, report_only_hits: reportOnlyHits,
    reason: hits.length === 0
      ? 'ok' + (reportOnlyHits.length ? ' (' + reportOnlyHits.length + ' report-only broad-word hit(s), never red per conventions.inference_wording_scan)' : '')
      : hits.length + ' case(s) with inference wording in notes',
  };
}

// MEDIUM-9 (Opus r6): every read of the conformance fixture goes through
// this loader, which hard-rejects a fixture whose `version` or
// `parser_version_required` is not the one this runner was written against
// -- the same treatment loadContract() already gave the contract version.
// Before this, fixture drift was caught only by G07's blob pins, which are
// absent on any run that does not pass --pins.
// conventions.fixture_shape_consistency (contract v2.11), verbatim: "every
// segments[].args element is an object with keys
// raw/decoded/quote/expansion_refs/unresolved_variables, every
// segments[].redirects entry is an object with keys
// op/fd/raw_target/target/target_kind/order (target itself an object), every
// assignments entry has name/raw_value/decoded_value/kind/unresolved_variables,
// every status_refs entry has kind/position/context, every
// shell_option_changes entry has option/on/position."
//
// This is a CROSS-FAMILY check, which is the whole point: every 1.2.2 case was
// well-formed on its own terms, and the fixture was still unsatisfiable
// because the M series spoke v1.1 and the C/R series spoke v1.2. Only a rule
// that quantifies over ALL cases at once can see that.
const FIXTURE_ELEMENT_SHAPES = {
  args: ['raw', 'decoded', 'quote', 'expansion_refs', 'unresolved_variables'],
  redirects: ['op', 'fd', 'raw_target', 'target', 'target_kind', 'order'],
  assignments: ['name', 'raw_value', 'decoded_value', 'kind', 'unresolved_variables'],
  status_refs: ['kind', 'position', 'context'],
  shell_option_changes: ['option', 'on', 'position'],
};

function assertFixtureShapeConsistency(fixture) {
  const problems = [];
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const tc of fixture.cases || []) {
    // conventions.fixture_shape_consistency (v2.12): "every case MUST carry
    // expect.segments (an array); a case whose expectation has no segments key
    // is a load-time violation (rc 2), never an implicit 'expect zero
    // segments'". C-scope-root was exactly that: no segments key, and
    // compareParserExpectation dutifully compared a 3-segment parse against
    // zero expected segments.
    if (!tc.expect || !Object.prototype.hasOwnProperty.call(tc.expect, 'segments')) {
      problems.push(tc.id + '.expect.segments: missing -- every case must carry a segments array');
      continue;
    }
    if (!Array.isArray(tc.expect.segments)) {
      problems.push(tc.id + '.expect.segments: not an array');
      continue;
    }
    const segs = tc.expect.segments;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i] || {};
      const at = tc.id + '.expect.segments[' + i + ']';
      for (const field of Object.keys(FIXTURE_ELEMENT_SHAPES)) {
        const list = seg[field];
        if (list === undefined) continue;          // the case simply does not assert it
        if (!Array.isArray(list)) { problems.push(at + '.' + field + ': not an array'); continue; }
        for (let j = 0; j < list.length; j++) {
          const el = list[j];
          const where = at + '.' + field + '[' + j + ']';
          if (!isPlainObject(el)) {
            problems.push(where + ': expected an object with ' +
              FIXTURE_ELEMENT_SHAPES[field].join('/') + ', got ' + JSON.stringify(el));
            continue;
          }
          const missing = FIXTURE_ELEMENT_SHAPES[field]
            .filter((k) => !Object.prototype.hasOwnProperty.call(el, k));
          if (missing.length) problems.push(where + ': missing key(s) ' + missing.join(', ') + ' -- has ' + Object.keys(el).join(','));
          if (field === 'redirects' && Object.prototype.hasOwnProperty.call(el, 'target') && !isPlainObject(el.target)) {
            problems.push(where + '.target: expected an object, got ' + JSON.stringify(el.target));
          }
        }
      }
    }
  }
  if (problems.length) {
    const shown = problems.slice(0, 12).join('\n  ');
    throw new Error('conformance fixture violates contract conventions.fixture_shape_consistency (' +
      problems.length + ' violation(s)):\n  ' + shown +
      (problems.length > 12 ? '\n  ...and ' + (problems.length - 12) + ' more' : ''));
  }
}

function loadConformanceFixture(conformancePath) {
  const raw = fs.readFileSync(conformancePath, 'utf8');
  const fixture = JSON.parse(raw);
  if (fixture.version !== REQUIRED_FIXTURE_VERSION) {
    throw new Error('conformance fixture version mismatch: runner requires exactly "' +
      REQUIRED_FIXTURE_VERSION + '", got "' + fixture.version + '"');
  }
  if (fixture.parser_version_required !== REQUIRED_FIXTURE_PARSER_VERSION) {
    throw new Error('conformance fixture parser_version_required mismatch: runner requires exactly "' +
      REQUIRED_FIXTURE_PARSER_VERSION + '", got "' + fixture.parser_version_required + '"');
  }
  assertFixtureShapeConsistency(fixture);
  return fixture;
}

// conventions.parser_mandatory_fields (contract v2.15), verbatim: "every
// segment of parseCommand() output MUST carry all of: index, dialect, kind,
// exe, sub, args (array of v1.2 operand objects), assignments (array),
// redirects (array), status_refs (array), shell_option_changes (array),
// has_exit_status_ref, sep_before, parse_status, scope_id, source_span {line,
// col, end_line, end_col}, pipeline_id, pipeline_position, pipeline_length,
// negated, group; top level MUST carry parser_version, segments, scopes,
// unresolved_variables. The runner asserts this schema on the ACTUAL output of
// every conformance case (red on any missing key or wrong type) INDEPENDENTLY
// of which keys the fixture expectation happens to list ... Pure-assignment
// segments (kind assignment) MUST have args [] once the assignment is moved
// into assignments."
//
// This is the codex H5 lesson in one sentence: a field nothing reads is a
// field that does not exist. 104/104 was green while source_span was absent
// from every segment, because no expectation happened to name it.
const PARSER_SEGMENT_ARRAY_KEYS = ['args', 'assignments', 'redirects', 'status_refs', 'shell_option_changes'];
const PARSER_SEGMENT_PRESENT_KEYS = [
  'index', 'dialect', 'kind', 'exe', 'sub', 'args', 'assignments', 'redirects', 'status_refs',
  'shell_option_changes', 'has_exit_status_ref', 'sep_before', 'parse_status', 'scope_id',
  'source_span', 'pipeline_id', 'pipeline_position', 'pipeline_length', 'negated', 'group',
];
const PARSER_TOP_LEVEL_KEYS = ['parser_version', 'segments', 'scopes', 'unresolved_variables'];
const PARSER_SOURCE_SPAN_KEYS = ['line', 'col', 'end_line', 'end_col'];
const PARSER_OPERAND_KEYS = ['raw', 'decoded', 'quote', 'expansion_refs', 'unresolved_variables'];

function checkParserMandatoryFields(caseId, actual) {
  const problems = [];
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
  if (!actual || typeof actual !== 'object') {
    return [caseId + ': parseCommand did not return an object'];
  }
  for (const k of PARSER_TOP_LEVEL_KEYS) {
    if (!has(actual, k)) problems.push(caseId + '.' + k + ': missing top-level key');
  }
  if (!Array.isArray(actual.segments)) problems.push(caseId + '.segments: not an array');
  if (actual.scopes !== undefined && !Array.isArray(actual.scopes)) problems.push(caseId + '.scopes: not an array');
  if (actual.unresolved_variables !== undefined && !Array.isArray(actual.unresolved_variables)) {
    problems.push(caseId + '.unresolved_variables: not an array');
  }
  const segs = Array.isArray(actual.segments) ? actual.segments : [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] || {};
    const at = caseId + '.segments[' + i + ']';
    for (const k of PARSER_SEGMENT_PRESENT_KEYS) {
      if (!has(seg, k)) problems.push(at + '.' + k + ': missing');
    }
    for (const k of PARSER_SEGMENT_ARRAY_KEYS) {
      if (has(seg, k) && !Array.isArray(seg[k])) problems.push(at + '.' + k + ': not an array');
    }
    if (has(seg, 'source_span')) {
      const sp = seg.source_span;
      if (!sp || typeof sp !== 'object' || Array.isArray(sp)) problems.push(at + '.source_span: not an object');
      else for (const k of PARSER_SOURCE_SPAN_KEYS) {
        if (!has(sp, k)) problems.push(at + '.source_span.' + k + ': missing');
        else if (typeof sp[k] !== 'number') problems.push(at + '.source_span.' + k + ': not a number (' + JSON.stringify(sp[k]) + ')');
      }
    }
    if (Array.isArray(seg.args)) {
      for (let j = 0; j < seg.args.length; j++) {
        const a = seg.args[j];
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
          problems.push(at + '.args[' + j + ']: not a v1.2 operand object (' + JSON.stringify(a) + ')');
          continue;
        }
        for (const k of PARSER_OPERAND_KEYS) if (!has(a, k)) problems.push(at + '.args[' + j + '].' + k + ': missing');
      }
      if (seg.kind === 'assignment' && seg.args.length > 0) {
        problems.push(at + '.args: a pure-assignment segment must have args [] once the assignment is in assignments, got ' +
          JSON.stringify(seg.args).slice(0, 120));
      }
    }
    if (has(seg, 'has_exit_status_ref') && typeof seg.has_exit_status_ref !== 'boolean') {
      problems.push(at + '.has_exit_status_ref: not a boolean');
    }
    if (has(seg, 'negated') && typeof seg.negated !== 'boolean') problems.push(at + '.negated: not a boolean');
  }
  return problems;
}

function runConformanceWithParse(fixture, parseFn, source) {
  const results = [];
  for (const tc of fixture.cases) {
    let actual;
    try { actual = parseFn(tc.cmd, { tool: 'Bash' }); }
    catch (e) { results.push({ id: tc.id, pass: false, reason: 'parse threw: ' + e.message }); continue; }
    results.push(compareParserExpectation(tc, actual));
  }
  return { fixture, results, source };
}

function runParserConformance(conformancePath, parserModulePath) {
  const fixture = loadConformanceFixture(conformancePath);
  delete require.cache[require.resolve(parserModulePath)];
  let parseCommand;
  try { ({ parseCommand } = require(parserModulePath)); } catch (e) {
    return { fixture, results: fixture.cases.map((c) => ({ id: c.id, pass: false, reason: 'parser module failed to load: ' + e.message })), loadError: String(e) };
  }
  const out = runConformanceWithParse(fixture, parseCommand, 'production parser: ' + parserModulePath);
  // H5: the mandatory-field schema is asserted on the PRODUCTION parser's own
  // output, separately from the per-case fixture comparison, so "the fixture
  // agrees" and "the output is well-formed" stay two distinct verdicts.
  const violations = [];
  const offendingCases = [];
  for (const tc of fixture.cases) {
    let actual = null;
    try { actual = parseCommand(tc.cmd, { tool: 'Bash' }); } catch (e) { actual = null; }
    const p = checkParserMandatoryFields(tc.id, actual);
    if (p.length) { offendingCases.push(tc.id); for (const one of p) violations.push(one); }
  }
  out.schema = {
    ok: violations.length === 0,
    cases_checked: fixture.cases.length,
    offending_case_count: offendingCases.length,
    offending_cases: offendingCases.slice(0, 20),
    violation_count: violations.length,
    violations: violations.slice(0, 20),
    reason: violations.length === 0 ? 'ok (every case satisfies conventions.parser_mandatory_fields)'
      : offendingCases.length + ' case(s) violate conventions.parser_mandatory_fields (' + violations.length + ' field problem(s))',
  };
  return out;
}

// The self-check needs to prove the conformance INTERPRETER discriminates --
// that it genuinely compares fields instead of passing everything. v2.9 proved
// that by requiring the PRODUCTION parser to fail some cases, which is a time
// bomb: the moment delivery (1) lands a correct v1.2 parser, 104/104 go green,
// redCount becomes 0, part4 turns false and the canary-registered self-check is
// red forever, for the one reason that is supposed to be success. The oracle is
// now the PRE-REGISTERED blind-parser mutant -- a known-bad parse that blanks
// status_refs/redirects/assignments/expansions, so it fails most of the fixture
// and passes the rest no matter which parser version it wraps.
function runConformanceUnderBlindMutant(conformancePath, selfCheckRoot) {
  const fixture = loadConformanceFixture(conformancePath);
  // mutants/blind-parser.cjs appends a probe line to <PMM_RECALL_ROOT>/probe.log
  // on every call. This runs IN THIS PROCESS, so the env must never point at a
  // real production root while it does (production_isolation: the runner only
  // ever writes under a temp root it owns).
  const prevRoot = process.env.PMM_RECALL_ROOT;
  process.env.PMM_RECALL_ROOT = path.join(selfCheckRoot, 'blind-parse-probe');
  mkdirp(process.env.PMM_RECALL_ROOT);
  try {
    delete require.cache[require.resolve(MUTANT_PATHS['blind-parser'])];
    const mod = require(MUTANT_PATHS['blind-parser']);
    return runConformanceWithParse(fixture, mod.parse, 'pre-registered mutants/blind-parser.cjs (known-bad parse)');
  } finally {
    if (prevRoot === undefined) delete process.env.PMM_RECALL_ROOT;
    else process.env.PMM_RECALL_ROOT = prevRoot;
  }
}

function compareParserExpectation(tc, actual) {
  const expSegs = (tc.expect && tc.expect.segments) || [];
  const actSegs = (actual && actual.segments) || [];
  if (actSegs.length !== expSegs.length) {
    return { id: tc.id, pass: false, reason: 'segment count mismatch (expected ' + expSegs.length + ', got ' + actSegs.length + ')' };
  }
  const mismatches = [];
  for (let i = 0; i < expSegs.length; i++) {
    const exp = expSegs[i], act = actSegs[i] || {};
    for (const key of Object.keys(exp)) {
      if (!deepEqual(exp[key], act[key])) mismatches.push('segments[' + i + '].' + key);
    }
  }
  // conventions.parser_scopes_comparison (contract v2.12), verbatim: "the
  // number of scopes must equal the actual parseCommand().scopes length, and
  // for each expected scope object only the keys PRESENT in that expected
  // object are deepEqual-compared against the actual scope (keys absent from
  // the expectation, e.g. dialect/parent_segment_index, are not asserted); a
  // mismatch is reported as scopes[i].<key> exactly like segment field
  // mismatches". Until v2.12 nothing here read .scopes at all, so every scopes
  // assertion in the fixture was decoration.
  if (tc.expect && tc.expect.scopes !== undefined) {
    const expScopes = tc.expect.scopes || [];
    const actScopes = (actual && actual.scopes) || [];
    if (actScopes.length !== expScopes.length) {
      mismatches.push('scopes length (expected ' + expScopes.length + ', got ' + actScopes.length + ')');
    } else {
      for (let i = 0; i < expScopes.length; i++) {
        const exp = expScopes[i] || {};
        const act = actScopes[i] || {};
        for (const key of Object.keys(exp)) {
          if (!deepEqual(exp[key], act[key])) mismatches.push('scopes[' + i + '].' + key);
        }
      }
    }
  }
  if (tc.expect && tc.expect.unresolved_variables !== undefined) {
    if (!deepEqual(tc.expect.unresolved_variables, actual.unresolved_variables)) mismatches.push('unresolved_variables');
  }
  if (tc.expect && tc.expect.parser_version !== undefined) {
    if (!deepEqual(tc.expect.parser_version, actual.parser_version)) mismatches.push('parser_version');
  }
  return { id: tc.id, pass: mismatches.length === 0, reason: mismatches.length ? 'field mismatch: ' + mismatches.join(', ') : 'ok' };
}

// flat mutant: mechanically derive the failing set from each fixture case's
// OWN expectation structure (per fixture.mutant_flat's literal criteria),
// then compare to the actual failing set when the parser is run with
// PMM_CMD_PARSE_MUTANT=flat set (today's v1.1 module does not read this env
// var at all, so the actual set will equal the baseline set until the
// builder adds v1.2 + flat-mode support -- that mismatch is expected, not a
// runner bug, and is reported as such).
// v2.5 HIGH-7 fix: (d) any NON-EMPTY `redirects` assertion now puts the
// case in the red set outright (flat clears redirects to [] unconditionally
// -- even a v1.1-shaped non-empty {op,target} array no longer matches);
// (e) the `quote !== 'none'` condition is DROPPED per the fixture's own
// mutant_flat text amendment (flat's definition does not claim to normalize
// quote, so a quote-only assertion does NOT by itself demand a red case).
// v2.6 item 7: the SOLE source for this criterion is
// PMM-CMD-PARSE-CONTRACT.md v1.2 修订 ⑤ item 5 ("flat 变异推导判据正文...
// 夹具 mutant_flat 与 runner 共同引用本条,不得各自改写"). LOW-1 (Opus r6):
// the fixture's own `mutant_flat` prose is no longer stale -- fixture 1.2.2
// quotes 修订 ⑤ item 5 verbatim -- but it is still not read here, because
// the ruling says both sides reference the CONTRACT clause rather than each
// other.
// Verbatim per 修订 ⑤ item 5: fails under flat iff any of: non-empty
// status_refs; non-empty redirects; non-empty assignments; any arg's
// expansion_refs non-empty, or unresolved_variables non-empty, or
// decoded!==raw; non-empty shell_option_changes. `quote` is explicitly NOT
// a criterion (flat does not touch it).
function deriveFlatFailForParserCase(tc) {
  // LOW-4 (Opus r6 LOW-6, r7 LOW-4): every fixture case is expect_status
  // "exact", so this branch is dead code today. It is kept because the
  // fixture schema still allows "ambiguous" and silently treating such a case
  // as ordinary would put it in the red set for the wrong reason; recorded
  // here rather than removed.
  if (tc.expect_status === 'ambiguous') return null; // excluded entirely
  const segs = (tc.expect && tc.expect.segments) || [];
  for (const s of segs) {
    if (Array.isArray(s.status_refs) && s.status_refs.length > 0) return true;
    if (Array.isArray(s.assignments) && s.assignments.length > 0) return true;
    if (Array.isArray(s.redirects) && s.redirects.length > 0) return true;
    if (Array.isArray(s.shell_option_changes) && s.shell_option_changes.length > 0) return true;
    if (Array.isArray(s.args)) {
      for (const a of s.args) {
        if (a && typeof a === 'object') {
          if (a.expansion_refs && a.expansion_refs.length > 0) return true;
          if (a.unresolved_variables && a.unresolved_variables.length > 0) return true;
          if (a.raw !== undefined && a.decoded !== undefined && a.raw !== a.decoded) return true;
        }
      }
    }
  }
  // MEDIUM-8 (Opus r6): a top-level `unresolved_variables` criterion used to
  // live here. 修订 ⑤ item 5 lists five criteria and none of them is the
  // top-level array -- flat "不改其他字段", so that key is unchanged under
  // flat and cannot by itself put a case in the red set. It happened to
  // change no membership today (both sides had the same 44 ids), which is
  // exactly why a second, undocumented criterion is worth deleting before it
  // does.
  return false;
}

// v2.16 (fab blind attack MEDIUM-1): the flat round used to set
// PMM_CMD_PARSE_MUTANT in this process, which required the PRODUCTION parser to
// read that variable -- an environment variable that changes judgment is a
// production hazard (Z23 is its behavioural counter-test). The round now calls
// the parser's own exported transform instead, and nothing anywhere sets the
// variable.
function runParserFlatMutantRound(conformancePath, parserModulePath) {
  const fixture = loadConformanceFixture(conformancePath);
  delete require.cache[require.resolve(parserModulePath)];
  let parserModule;
  try { parserModule = require(parserModulePath); }
  catch (e) {
    return { derived_fail_ids: [], actual_fail_ids: [], sets_equal: false, error: String(e) };
  }
  const parseCommand = parserModule.parseCommand;
  const applyFlatMutant = parserModule.applyFlatMutant;
  if (typeof applyFlatMutant !== 'function') {
    return {
      derived_fail_ids: [], actual_fail_ids: [], sets_equal: false,
      error: 'parser module does not export applyFlatMutant(result); contract v2.16 requires the flat round to call it ' +
        'directly instead of setting PMM_CMD_PARSE_MUTANT (see Z23)',
    };
  }
  const derivedFailIds = [];
  const actualFailIds = [];
  for (const tc of fixture.cases) {
    const derived = deriveFlatFailForParserCase(tc);
    if (derived === null) continue; // ambiguous, excluded
    if (derived) derivedFailIds.push(tc.id);
    let actual;
    try { actual = applyFlatMutant(parseCommand(tc.cmd, { tool: 'Bash' })); }
    catch (e) { actualFailIds.push(tc.id); continue; }
    const cmp = compareParserExpectation(tc, actual);
    if (!cmp.pass) actualFailIds.push(tc.id);
  }
  const dSet = new Set(derivedFailIds), aSet = new Set(actualFailIds);
  const setsEqual = dSet.size === aSet.size && [...dSet].every((id) => aSet.has(id));
  return { derived_fail_ids: derivedFailIds.sort(), actual_fail_ids: actualFailIds.sort(), sets_equal: setsEqual };
}

// ===========================================================================
// ledger_cases (G01-G08)
// ===========================================================================

function runLedgerChecks(ctx, allRows, opts) {
  const out = {};
  const agg = aggregateLedgerRows(allRows);

  try {
    delete require.cache[require.resolve(LEDGER_MODULE_PATH)];
    const mod = require(LEDGER_MODULE_PATH);
    const { header } = readLedgerRows(ctx.stateDir);
    const columnsMatch = header && Array.isArray(mod.COLUMNS) && JSON.stringify(header) === JSON.stringify(mod.COLUMNS);
    out.G01 = { pass: !!columnsMatch, reason: columnsMatch ? 'ok' : 'header does not match ledger module COLUMNS (or module/header missing)', header, moduleColumns: mod.COLUMNS };
  } catch (e) {
    out.G01 = { pass: false, reason: 'pmm-recall-ledger.cjs not found or unreadable (expected pre-builder): ' + String(e && e.message || e) };
  }

  out.G02 = { pending: true, reason: 'computed by caller around the full run (before/after manifest of default production root)' };

  out.G03 = (() => {
    const byImpressionKind = new Map();
    for (const r of agg.deduped) {
      if (!r.impression_id) continue;
      if (!byImpressionKind.has(r.impression_id)) byImpressionKind.set(r.impression_id, []);
      byImpressionKind.get(r.impression_id).push(r);
    }
    let checked = 0, violations = 0;
    for (const [, rowsForImpression] of byImpressionKind) {
      const emitted = rowsForImpression.filter((r) => r.event_kind === 'emitted');
      for (const em of emitted) {
        checked += 1;
        const hasWouldWarn = rowsForImpression.some((r) => r.event_kind === 'would-warn' && r.event_id !== em.event_id);
        if (!hasWouldWarn) violations += 1;
      }
    }
    return { pass: violations === 0, checked, violations, reason: violations === 0 ? 'ok' : violations + ' emitted row(s) without a matching would-warn' };
  })();

  // G04 (MEDIUM-11, Opus r6): "duplicate event_id rows are tolerated by
  // readers (dedupe at read) and their count is reported". v2.6 hard-coded
  // pass:true, which made the check unfalsifiable. Read-side dedupe keeps
  // the FIRST row of each event_id and drops every later one, so it is
  // lossless exactly when the dropped rows agree with the kept one on the
  // columns the read side CONSUMES -- the identity the rows are filtered by
  // and the judgment aggregateLedgerRows derives from them. Columns that
  // legitimately differ between two hook events which produce the same
  // event_id (`ts`, and `prompt_id` -- L10's shadow Pre and intervene Pre
  // are two different prompts writing the same would-warn event_id, as are
  // L11's two identical re-entries) are NOT compared: reddening those would
  // fail a correct gate, which is the defect class this round exists to
  // remove, not to add. A duplicate that disagrees on the consumed columns
  // IS information silently lost at read time, and is red. The duplicate
  // count and rate stay reported either way.
  out.G04 = (() => {
    const CONSUMED_COLUMNS = [
      'impression_id', 'event_kind', 'gate', 'confidence',
      'tool_use_id', 'sid_sha16', 'agent_sha16', 'trigger_or_gate_id',
    ];
    const groups = new Map();
    for (const r of allRows) {
      if (!r.event_id) continue;
      if (!groups.has(r.event_id)) groups.set(r.event_id, []);
      groups.get(r.event_id).push(r);
    }
    const divergent = [];
    for (const [eventId, groupRows] of groups) {
      if (groupRows.length < 2) continue;
      const shape = (r) => JSON.stringify(CONSUMED_COLUMNS.map((k) => r[k]));
      const first = shape(groupRows[0]);
      if (groupRows.slice(1).some((r) => shape(r) !== first)) divergent.push(eventId);
    }
    const pass = divergent.length === 0;
    return {
      pass,
      raw_count: agg.rawCount, deduped_count: agg.dedupedCount,
      duplicate_row_count: agg.duplicateCount,
      duplicate_rate: agg.rawCount ? Number((agg.duplicateCount / agg.rawCount).toFixed(4)) : 0,
      duplicate_event_id_groups: [...groups.values()].filter((g) => g.length > 1).length,
      divergent_duplicate_event_ids: divergent,
      conflicts: agg.conflicts.length,
      consumed_columns: CONSUMED_COLUMNS,
      reason: pass
        ? 'ok (duplicates tolerable: rows sharing an event_id agree on every column the read side consumes; count reported)'
        : divergent.length + ' event_id(s) have duplicate rows that DISAGREE on a consumed column -- read-side dedupe would drop information',
    };
  })();

  // G10 (contract v2.10, from Opus r7 LOW-3 / r8 LOW-2): "every data row of
  // the shared ledger file, parsed read-side by TAB, has exactly
  // COLUMNS.length (21) fields". v2.9 asserted this under a runner-invented
  // key that no contract clause backed; it is a ledger case now. The clause
  // also pins that the case which deliberately injects control characters
  // (Z10) runs against its OWN state dir, so the shared ledger never carries
  // torn rows -- and a non-sanitizing gate therefore fails Z10 and G10 (its
  // torn rows are still scanned, in the dir that case owns).
  out.G10 = (() => {
    const dirs = [ctx.stateDir].concat(ctx.auxStateDirs || []);
    const offending = [];
    let rowsChecked = 0;
    let headerColCount = null;
    for (const dir of dirs) {
      const read = readLedgerRows(dir);
      if (read.headerColCount) headerColCount = read.headerColCount;
      for (const r of read.rows) {
        rowsChecked += 1;
        if (r.__colCount !== read.headerColCount) {
          if (offending.length < 10) {
            offending.push({
              state_dir: dir, cols: r.__colCount, expected: read.headerColCount,
              raw: String(r.__raw).slice(0, 160),
            });
          }
        }
      }
    }
    const pass = offending.length === 0;
    return {
      pass, row_column_shape: pass, header_col_count: headerColCount,
      rows_checked: rowsChecked, state_dirs_scanned: dirs.length, offending_rows: offending,
      reason: pass ? 'ok (every ledger row has exactly the header column count)'
        : offending.length + '+ row(s) do not match the header column count -- fields were mis-mapped',
    };
  })();

  out.G11 = checkTriggerRecallDualWrite(ctx);
  out.P05 = checkUnlockPrecisionGate(ctx);

  out.G05 = checkSettingsWiring((ctx.toolOverrides && ctx.toolOverrides.g05) || null);
  out.G06 = checkCanaryRoster();
  out.G07 = checkBlobPins(opts);
  out.G08 = { pending: true, reason: 'computed by caller (parser conformance + flat mutant round)' };
  out.G09 = { pending: true, reason: 'computed by caller (single-handler spy: always+null rounds filtered to gate-row-expecting cases)' };

  return out;
}

function readTextSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; } }

const LEDGER_V3_COLUMNS = [
  'schema_version', 'ts', 'sid_sha16', 'agent_sha16', 'agent_type', 'prompt_id', 'tool_use_id',
  'impression_id', 'event_id', 'event_kind', 'gate', 'confidence', 'class_tag', 'trigger_or_gate_id',
  'cmd_sha16', 'parser_version', 'mode', 'run_provenance', 'sanitized', 'id_missing', 'agent_id_missing',
];

// G11 (M-SPEC appendix B1): run pmm-trigger-recall.sh once under a temp root
// with a synthetic PostToolUse Edit event whose path matches TWO lesson
// triggers, one of which is already in the seen file, and assert the v3 rows it
// must dual-write next to the legacy dreams/trigger-log line. Everything the
// tool reads is env-driven (PMM_TRIGGER_MEM / PMM_TRIGGER_STATE /
// PMM_TRIGGER_LOG), exactly as its own --self-test does, so nothing here
// touches a real memory directory.
function checkTriggerRecallDualWrite(ctx) {
  // conventions.process_liveness v2.24 erratum 1: this is a NON-hook tool
  // invocation, and its spawnError / exit code are assertions, not payload.
  // `toolOverrides` is test-only (self-check part12) and undefined in a real
  // run, so the production path is the plain script under GUARDS_DIR.
  const override = (ctx.toolOverrides && ctx.toolOverrides.g11) || {};
  const script = override.script || path.join(GUARDS_DIR, 'pmm-trigger-recall.sh');
  if (!override.argv0 && !fs.existsSync(script)) return { pass: false, reason: 'pmm-trigger-recall.sh not found' };
  // contract v2.26 home_only_proof (part14): in HOME-only mode the tool is
  // handed NOTHING but HOME/USERPROFILE, so the fixture is laid out at exactly
  // the paths the tool derives from HOME alone (<home>/.claude/memory,
  // <home>/.claude/.trigger-seen-*, <home>/.claude/.local/pmm-recall). Before
  // v2.26 the HOME-only branch kept the env-var layout (mem/, state/, root/)
  // while handing the tool no env vars, so a correct tool matched nothing and
  // wrote nothing -- the "no real-root change" it was meant to prove was
  // vacuous. `ids` (part14 only) pins run-nonce ids, tags and rel so every
  // byte a leaking tool could write carries the nonce.
  const homeOnly = !!override.homeOnly;
  const ids = override.ids || null;
  const base = path.join(ctx.root, 'g11-' + randId('token'));
  const mem = homeOnly ? path.join(base, '.claude', 'memory') : path.join(base, 'mem');
  const state = homeOnly ? path.join(base, '.claude') : path.join(base, 'state');
  const root = homeOnly ? path.join(base, '.claude', '.local', 'pmm-recall') : path.join(base, 'root');
  mkdirp(path.join(mem, 'dreams')); mkdirp(state); mkdirp(root);
  // HOME-only: the tool names its log trigger-log-<host>.tsv under the recall
  // root; it is found by listing rather than by re-deriving the host name.
  const logPath = homeOnly ? null : path.join(base, 'trigger-log.tsv');
  const tagSuffix = ids && ids.tagSuffix ? '-' + ids.tagSuffix : '';
  const tagSeen = 'test:g11-alpha' + tagSuffix;
  const tagFresh = 'test:g11-beta' + tagSuffix;
  const lessonClass = 'class:g11-synthetic';
  writeFileAtomicText(path.join(mem, 'lessons.md'), [
    '**2026-01-01 — G11 alpha** [' + tagSeen + ']',
    'Class: [[' + lessonClass + ']]',
    '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->',
    'body alpha',
    '**2026-01-02 — G11 beta** [' + tagFresh + ']',
    'Class: [[' + lessonClass + ']]',
    '<!-- trigger: tool=Edit|Write; repo=home; path=.claude/guards/* -->',
    'body beta',
    '',
  ].join('\n'));
  writeFileAtomicText(path.join(mem, 'decisions.md'), '');
  writeFileAtomicText(path.join(mem, 'standinginstructions.md'), '');
  const sessionId = ids ? ids.sessionId : randId('session');
  const agentId = ids ? ids.agentId : randId('agent');
  const toolUseId = ids ? ids.toolUseId : randId('tool');
  // one tag already seen in THIS (session, agent) -> must be suppressed with
  // run_provenance seen. Contract v2.25 erratum 2 / M-SPEC appendix B note 5:
  // the tool keys its seen file by sha16(session_id || NUL || agent_id), so a
  // main session and a same-session sub-agent no longer share (and silently
  // use up) one seen-once budget. Seeding any other file name would create a
  // file the tool never reads, and the suppression would silently not happen
  // (the retired 8-character session key is what made the expectation
  // eligible=2 / displayed=1 / suppressed=1 unreachable).
  const sessionKey = sha16(String(sessionId) + '\0' + String(agentId));
  writeFileAtomicText(path.join(state, '.trigger-seen-' + sessionKey), tagSeen + '\n');
  // rel matches the fixture trigger path=.claude/guards/*; part14 makes it
  // nonce-bearing so a leaked telemetry line is attributable by its rel column.
  const rel = ids && ids.rel ? ids.rel : '.claude/guards/x.sh';
  // Contract v2.25 erratum 2: the edited file lives UNDER THE FIXTURE HOME.
  // trigger-recall resolves repo=home by the HOME prefix since resolveHome()
  // landed, so the old hardcoded C:SERS<USER>\... path stopped matching
  // the moment HOME was redirected and the tool (correctly) wrote 0 rows.
  // rel is still the path relative to that repo root, forward slashes.
  const editedFile = path.join(base, rel);
  mkdirp(path.dirname(editedFile));
  const event = {
    hook_event_name: 'PostToolUse', session_id: sessionId, agent_id: agentId, tool_use_id: toolUseId,
    tool_name: 'Edit', tool_input: { file_path: editedFile },
  };
  const stdinPath = writeJsonFile(base, 'event.json', event);
  // v2.25: in HOME-only mode the trigger tool gets nothing but HOME, which is
  // the condition the real-root proof needs (part14).
  const env = homeOnly
    ? (() => {
      const e = childEnvBase();
      e.HOME = base; e.USERPROFILE = base;
      return e;
    })()
    : childEnvBase({
      PMM_TRIGGER_MEM: mem, PMM_TRIGGER_STATE: state, PMM_TRIGGER_LOG: logPath,
      PMM_RECALL_ROOT: root, PMM_RECALL_TAG: 'test', HOME: base, USERPROFILE: base,
    });
  const result = runGateProcess([override.argv0 || 'bash', script], {
    nonHook: true, // the trigger-recall script, not the Bash gate
    stdinPath, cwd: ctx.cwdDir, env, ioDir: path.join(base, 'io'), label: 'g11',
  });
  const { rows, headerColCount } = readLedgerRows(root);
  const caseRows = rows.filter((r) => r.tool_use_id === toolUseId);
  const byKind = (k) => caseRows.filter((r) => r.event_kind === k);
  const triggerRepo = 'home'; // the trigger engine's repo name for this fixture
  const impressionFor = (tag) => crypto.createHash('sha256')
    .update(String(sessionId) + '\0' + String(agentId) + '\0' + String(toolUseId) + '\0' + String(tag) +
      '\0' + sha16(triggerRepo + '\0' + rel), 'utf8').digest('hex');
  const problems = [];
  if (caseRows.length === 0) problems.push('no v3 rows written for the trigger event');
  if (byKind('eligible').length !== 2) problems.push('expected one eligible row per matched tag (2), got ' + byKind('eligible').length);
  if (byKind('displayed').length !== 1) problems.push('expected one displayed row for the injected tag, got ' + byKind('displayed').length);
  if (byKind('suppressed').length !== 1) problems.push('expected one suppressed row for the seen tag, got ' + byKind('suppressed').length);
  // v2.20: run_provenance still says WHY a tag was suppressed (seen | cap),
  // but it now also carries inst:<sha16> so the instance is auditable, so the
  // reason is matched as a token inside the string rather than as the whole
  // string.
  const PROVENANCE_REASON_RE = /(^|[^a-z])(seen|cap)([^a-z]|$)/;
  for (const r of byKind('suppressed')) {
    if (!PROVENANCE_REASON_RE.test(String(r.run_provenance || ''))) {
      problems.push('suppressed row run_provenance must say seen or cap, got ' + JSON.stringify(r.run_provenance));
    }
  }
  // v2.20: "the row run_provenance carries inst:<sha16> so the instance is
  // auditable" -- every trigger row, not just the suppressed ones.
  // v2.23 (codex LOW-10): the inst must be EXACTLY the runner-recomputed
  // sha16(repo || NUL || rel). A well-formed-but-wrong value (inst:0000...)
  // used to pass the shape test.
  const INSTANCE_RE = /(^|[^a-z0-9])inst:([0-9a-f]{16})([^0-9a-f]|$)/;
  const wantInst = sha16(triggerRepo + '\0' + rel);
  for (const r of caseRows) {
    const m = INSTANCE_RE.exec(String(r.run_provenance || ''));
    if (!m) {
      problems.push(r.event_kind + ' row: run_provenance must carry inst:<sha16>, got ' + JSON.stringify(r.run_provenance));
    } else if (m[2] !== wantInst) {
      problems.push(r.event_kind + ' row: inst:' + m[2] + ' != recomputed sha16(' + JSON.stringify(triggerRepo) +
        ' || NUL || ' + JSON.stringify(rel) + ') = ' + wantInst);
    }
  }
  for (const r of caseRows) {
    if (String(r.gate || '') !== '') problems.push(r.event_kind + ' row: gate column must be empty, got ' + JSON.stringify(r.gate));
    if (String(r.confidence || '') !== '') problems.push(r.event_kind + ' row: confidence column must be empty, got ' + JSON.stringify(r.confidence));
    if (String(r.mode || '') !== 'intervene') problems.push(r.event_kind + ' row: mode must be intervene, got ' + JSON.stringify(r.mode));
    if (r.__colCount !== LEDGER_V3_COLUMNS.length) problems.push(r.event_kind + ' row: ' + r.__colCount + ' columns, expected 21');
    const tag = String(r.trigger_or_gate_id || '');
    if (tag !== tagSeen && tag !== tagFresh) {
      problems.push(r.event_kind + ' row: trigger_or_gate_id must be the lesson tag, got ' + JSON.stringify(tag));
    } else {
      // the lesson class is the one the entry's own `Class: [[class:x]]` line
      // declares, which is what the tool reads -- the fixture declares it, so
      // the assertion is against a known value rather than a guess
      if (String(r.class_tag || '') !== lessonClass) {
        problems.push(r.event_kind + ' row: class_tag expected ' + JSON.stringify(lessonClass) + ', got ' + JSON.stringify(r.class_tag));
      }
      // v2.20: recomputed from (session, agent, tool_use_id, tag,
      // sha16(repo||NUL||rel)) where repo is the trigger engine repo name and
      // rel is the path relative to that repo root, forward slashes, no
      // leading ./ -- the fixture's rel is written that way on purpose, so a
      // tool that hashes the absolute Windows path cannot match.
      // v2.23 (codex LOW-10): EXACT equality with the first 16 hex of the
      // recomputed value. A prefix test accepted a one-character
      // impression_id, which is what the production ledger actually had.
      const wantImpression = impressionFor(tag).slice(0, 16);
      if (String(r.impression_id || '') !== wantImpression) {
        problems.push(r.event_kind + ' row: impression_id ' + JSON.stringify(String(r.impression_id || '')) +
          ' != recomputed sha256(session||agent||tool_use_id||tag||sha16(' +
          JSON.stringify(triggerRepo) + '||' + JSON.stringify(rel) + ')).slice(0,16) = ' + wantImpression);
      }
    }
  }
  const legacyLog = logPath !== null ? readTextSafe(logPath) : (() => {
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => /^trigger-log-.*\.tsv$/.test(n)).sort(); } catch (_e) { names = []; }
    if (names.length === 0) return null;
    return names.map((n) => readTextSafe(path.join(root, n)) || '').join('');
  })();
  if (legacyLog === null || legacyLog.length === 0) problems.push('the legacy dreams/trigger-log line was not written');
  // HOME-only mode (part14): what the tool left in the fixture HOME's seen
  // file. part14 uses it as liveness -- a tool that wrote nothing under the
  // redirected HOME makes "the real tree did not change" prove nothing.
  let seenLinesAfter = null;
  if (homeOnly) {
    const seenText = readTextSafe(path.join(state, '.trigger-seen-' + sessionKey));
    seenLinesAfter = seenText === null ? 0 : seenText.split('\n').filter((l) => l.length).length;
  }
  // v2.24 erratum 1: a tool that wrote every row correctly and then died is
  // still a dead tool -- rc and spawnError are problems, not decoration.
  if (result.spawnError) problems.push('pmm-trigger-recall could not be spawned: ' + result.spawnError);
  if (result.rc !== 0) problems.push('pmm-trigger-recall exited rc ' + result.rc + ', expected 0');
  if (result.stderrSize !== 0) problems.push('pmm-trigger-recall wrote ' + result.stderrSize + ' bytes of stderr, expected 0');
  return {
    pass: problems.length === 0,
    trigger_rows_ok: problems.length === 0,
    rc: result.rc, stdout: result.stdoutSize, stderr: result.stderrSize,
    rows_written: caseRows.length,
    kinds: [...new Set(caseRows.map((r) => r.event_kind))],
    header_col_count: headerColCount,
    legacy_log_lines: legacyLog === null ? 0 : legacyLog.split('\n').filter((l) => l.length).length,
    class_tag_reading: 'the lesson class is the entry Class: [[class:x]] line; the fixture declares ' + lessonClass,
    seen_session_key: sessionKey,
    seen_key_formula: 'sha16(session_id || NUL || agent_id)',
    edited_file: editedFile,
    recomputed_from: { repo: triggerRepo, rel, fields: 'session||agent||tool_use_id||tag||sha16(repo||rel)' },
    run_provenance_seen: [...new Set(caseRows.map((r) => String(r.run_provenance || '')))],
    // contract v2.26 home_only_proof (c): the identities this invocation used,
    // so part14 can put them (and the seen file NAME the tool derives from
    // them) into its attribution markers. tlog_session is the tool's own
    // telemetry session column (non [A-Za-z0-9-] stripped, first 8 chars) --
    // the only identifier on a "no-repo" telemetry line.
    actual: {
      tool_use_id: toolUseId, session_id: sessionId, agent_id: agentId,
      seen_file: '.trigger-seen-' + sessionKey,
      tlog_session: String(sessionId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 8),
      rel, tags: [tagSeen, tagFresh],
    },
    home_only: homeOnly ? {
      fixture_home: base, recall_root: root,
      rows_written_under_fixture_home: caseRows.length,
      seen_lines_under_fixture_home: seenLinesAfter,
      log_lines_under_fixture_home: legacyLog === null ? 0 : legacyLog.split('\n').filter((l) => l.length).length,
    } : null,
    problems: problems.slice(0, 12),
    reason: problems.length === 0 ? 'ok' : problems.length + ' problem(s): ' + problems.slice(0, 3).join(' | '),
  };
}

// P05 (contract v2.19): "pmm-recall-precision.cjs --unlock <class_tag> --gate A
// against a synthetic labels file with 24/30 useful for (class_tag, A) exits 2
// and leaves policy.json unchanged; with 29/30 useful it writes
// gates.A=randomized, mode=randomized, unlocked_by and lower95_by_gate.A;
// gates B and D stay shadow". The ledger and labels are synthesized under a
// temp root: 30 gate-A impressions of the lesson class, N of them labelled
// useful, PLUS 30 gate-B impressions of the SAME class at 5/30 -- so a tool
// that pools the class across gates (34/60) can never clear the bound and the
// per-(class, gate) wording is actually tested. "Leaves policy.json unchanged"
// is asserted against a pre-seeded all-shadow file, byte for byte, because an
// absent file cannot distinguish "refused" from "wrote and then failed".
function checkUnlockPrecisionGate(ctx) {
  const tool = path.join(GUARDS_DIR, 'pmm-recall-precision.cjs');
  if (!fs.existsSync(tool)) return { pass: false, reason: 'pmm-recall-precision.cjs not found' };
  const classTag = GATE_ROW_CLASS_TAG;
  const host = 'acceptance';
  // test-only (self-check part12); undefined in a real run
  const p05Argv0 = ((ctx.toolOverrides && ctx.toolOverrides.p05) || {}).argv0 || 'node';
  const seedPolicy = JSON.stringify({
    [classTag]: { mode: 'shadow', gates: { A: 'shadow', B: 'shadow', D: 'shadow' } },
  }, null, 2);
  const results = {};
  const problems = [];
  for (const scenario of [{ name: 'below_gate', useful: 24, wantRc: 2, wantPolicy: false },
    { name: 'above_gate', useful: 29, wantRc: 0, wantPolicy: true }]) {
    const root = path.join(ctx.root, 'p05-' + scenario.name + '-' + randId('token'));
    mkdirp(root);
    const rows = [LEDGER_V3_COLUMNS.join('\t')];
    const labels = [];
    const addGroup = (gate, useful, prefix) => {
      for (let i = 0; i < 30; i++) {
        const impression = sha16('p05-' + scenario.name + '-' + prefix + '-' + i);
        const row = {
          // selftest_id_convention (erratum 2): a synthetic session is test:<...>
          // or the sha16 of such a string -- the runner obeys its own rule
          schema_version: 1, ts: new Date().toISOString(), sid_sha16: sha16('test:p05-' + prefix + i), agent_sha16: sha16('a'),
          // conventions.selftest_id_convention (v2.26): toolu_selftest_<...>, a
          // real-shaped id for the read tools (their isContaminatedRow() drops
          // ^tu- rows, which would silently empty this fixture) that the canary
          // contamination sentinel can still count by /selftest/.
          agent_type: 'worker', prompt_id: '', tool_use_id: 'toolu_selftest_p05_' + prefix + i, impression_id: impression,
          event_id: sha16('e' + prefix + i), event_kind: 'would-warn', gate, confidence: 'recurrence',
          class_tag: classTag, trigger_or_gate_id: gate, cmd_sha16: sha16('c'), parser_version: '1.2',
          mode: 'shadow', run_provenance: 'policy:shadow', sanitized: '0', id_missing: '0', agent_id_missing: '0',
        };
        rows.push(LEDGER_V3_COLUMNS.map((c) => String(row[c] === undefined ? '' : row[c])).join('\t'));
        labels.push([new Date().toISOString(), impression, i < useful ? 'useful' : 'noise', 'synthetic'].join('\t'));
      }
    };
    addGroup('A', scenario.useful, 'a');
    addGroup('B', 5, 'b'); // same class, bad precision: pooling across gates must not unlock A
    writeFileAtomicText(path.join(root, 'events-v3-' + host + '.tsv'), rows.join('\n') + '\n');
    writeFileAtomicText(path.join(root, 'labels-' + host + '.tsv'), labels.join('\n') + '\n');
    const policyPath = path.join(root, 'policy.json');
    writeFileAtomicText(policyPath, seedPolicy);
    const env = childEnvBase({
      PMM_RECALL_ROOT: root, PMM_RECALL_HOST: host, HOME: root, USERPROFILE: root,
    });
    const ioDir = path.join(root, 'io');
    const res = runGateProcess([p05Argv0, tool, '--unlock', classTag, '--gate', 'A'], {
      nonHook: true, // the precision tool, not the Bash gate
      stdinPath: null, closedStdin: true, cwd: ctx.cwdDir, env, ioDir, label: 'p05-' + scenario.name,
    });
    let policy = null;
    const policyText = readTextSafe(policyPath);
    try { policy = JSON.parse(policyText); } catch (_e) { policy = null; }
    const entry = policy && policy[classTag] ? policy[classTag] : null;
    const gates = (entry && entry.gates) || {};
    results[scenario.name] = {
      rc: res.rc, useful_for_class_gate_A: scenario.useful, useful_for_class_gate_B: 5,
      policy_unchanged: policyText === seedPolicy, policy_entry: entry,
      stderr_head: (readTextSafe(res.stderrPath) || '').split('\n')[0].slice(0, 160),
    };
    // v2.24 erratum 1: spawnError is a named problem of this case.
    if (res.spawnError) {
      problems.push(scenario.name + ': pmm-recall-precision could not be spawned: ' + res.spawnError);
    }
    if (res.rc !== scenario.wantRc) {
      problems.push(scenario.name + ': rc ' + res.rc + ', expected ' + scenario.wantRc +
        (scenario.wantRc === 0 ? ' (29/30 useful for (class, A); a tool pooling gate B in would see 34/60)' : ''));
    }
    if (scenario.wantPolicy) {
      if (!entry) problems.push(scenario.name + ': policy.json has no entry for ' + classTag);
      else {
        if (gates.A !== 'randomized') problems.push(scenario.name + ': gates.A ' + JSON.stringify(gates.A) + ', expected randomized');
        if (entry.mode !== 'randomized') problems.push(scenario.name + ': policy mode ' + JSON.stringify(entry.mode) + ', expected randomized');
        if (!entry.unlocked_by) problems.push(scenario.name + ': policy entry has no unlocked_by');
        const lb = entry.lower95_by_gate && entry.lower95_by_gate.A;
        if (typeof lb !== 'number') problems.push(scenario.name + ': policy entry has no numeric lower95_by_gate.A');
        else if (!(lb > 0.80)) problems.push(scenario.name + ': lower95_by_gate.A ' + lb + ' does not clear 0.80');
        if (gates.B !== 'shadow') problems.push(scenario.name + ': gates.B ' + JSON.stringify(gates.B) + ', expected shadow');
        if (gates.D !== 'shadow') problems.push(scenario.name + ': gates.D ' + JSON.stringify(gates.D) + ', expected shadow');
      }
    } else if (policyText !== seedPolicy) {
      problems.push(scenario.name + ': policy.json changed although the gate should have refused (' +
        JSON.stringify(String(policyText).slice(0, 120)) + ')');
    }
  }
  return {
    pass: problems.length === 0, unlock_gate_ok: problems.length === 0,
    scenarios: results, problems,
    reason: problems.length === 0 ? 'ok' : problems.length + ' problem(s): ' + problems.slice(0, 3).join(' | '),
  };
}

// G05 (contract v2.15): "exactly five wiring instances must be present and
// correct: PreToolUse(Bash) -> bash-pipe-exitcode-watch.sh, PreToolUse(Bash) ->
// pmm-bash-impression.sh, PostToolUse(Bash) -> bash-pipe-exitcode-watch.sh,
// PostToolUseFailure(Bash) -> bash-pipe-exitcode-watch.sh, SessionEnd ->
// pmm-recall-ledger.cjs --session-end; for each the runner parses the command
// string into argv, requires the first word to be bash or node, requires the
// script argument to be an absolute path that exists and equals the guards
// file (not a substring match: echo bash-pipe-exitcode-watch.sh must be red),
// and launches that argv once from a temp copy path containing a space with an
// empty JSON on stdin expecting rc 0 and zero output; hook timeout is either
// absent (default) or >= 10 seconds."
// `nodeless: true` marks the instances contract v2.16 also launches under a
// PATH from which node cannot be resolved: "the launch-once check is repeated
// under a PATH without node for EVERY wiring instance of the PreToolUse Bash
// group ... and for PostToolUse / PostToolUseFailure: stdout and stderr must
// both be 0 bytes and rc 0 (the M0 wrapper used to emit 149 bytes of stderr
// when node was absent)". SessionEnd is the node entry itself, so a node-less
// PATH says nothing about it.
const REQUIRED_WIRING_INSTANCES = [
  { event: 'PreToolUse', matcher: 'Bash', exe: 'bash', file: 'bash-pipe-exitcode-watch.sh', args: [], nodeless: true },
  { event: 'PreToolUse', matcher: 'Bash', exe: 'bash', file: 'pmm-bash-impression.sh', args: [], nodeless: true },
  { event: 'PostToolUse', matcher: 'Bash', exe: 'bash', file: 'bash-pipe-exitcode-watch.sh', args: [], nodeless: true },
  { event: 'PostToolUseFailure', matcher: 'Bash', exe: 'bash', file: 'bash-pipe-exitcode-watch.sh', args: [], nodeless: true },
  { event: 'SessionEnd', matcher: null, exe: 'node', file: 'pmm-recall-ledger.cjs', args: ['--session-end'], nodeless: false },
];
const SHELL_OPERATOR_TOKENS = ['||', '&&', ';', '|', '>', '>>', '2>', '1>', '&>', '<', '&'];
const MIN_HOOK_TIMEOUT_SECONDS = 10;

// Tokenize a hook command into the argv of its FIRST command, honouring quotes
// and stopping at the first shell operator. The wiring is written as
//     bash "<abs path>" || { echo ...; exit 0; }
// and everything after the || is the fail-open tail, not part of the argv the
// hook actually launches.
function hookCommandToArgv(command) {
  const argv = [];
  let cur = '';
  let quote = null;
  let started = false;
  const push = () => { if (started) { argv.push(cur); cur = ''; started = false; } };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else { cur += ch; started = true; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t') { push(); continue; }
    if (ch === '\\' && command[i + 1] === '"') { cur += '"'; started = true; i += 1; continue; }
    // a shell operator ends the first command
    const two = command.slice(i, i + 2);
    if (SHELL_OPERATOR_TOKENS.indexOf(two) >= 0) { push(); return argv; }
    if (SHELL_OPERATOR_TOKENS.indexOf(ch) >= 0) { push(); return argv; }
    cur += ch; started = true;
  }
  push();
  return argv;
}

// A copy of the guards scripts under a path that CONTAINS A SPACE. The sibling
// .sh/.cjs files come along because every entry script resolves its own
// directory (dirname of BASH_SOURCE) to find them -- copying the entry alone would
// prove only that a lone script cannot find its siblings.
function makeSpacedGuardsCopy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pgv2-g05-'));
  const dir = path.join(base, 'with space', 'guards');
  mkdirp(dir);
  let copied = 0;
  for (const f of fs.readdirSync(GUARDS_DIR)) {
    if (!/\.(sh|cjs)$/.test(f)) continue;
    try { fs.copyFileSync(path.join(GUARDS_DIR, f), path.join(dir, f)); copied += 1; } catch (_e) { /* skip */ }
  }
  return { base, dir, copied };
}

function launchWiringInstance(copyDir, base, exe, file, args, pathOverride) {
  const stdinPath = path.join(base, 'empty.json');
  fs.writeFileSync(stdinPath, '{}');
  const outPath = path.join(base, 'launch.out');
  const errPath = path.join(base, 'launch.err');
  fs.writeFileSync(outPath, ''); fs.writeFileSync(errPath, '');
  const inFd = fs.openSync(stdinPath, 'r');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const home = path.join(base, 'with space');
  const env = childEnvBase({
    PMM_RECALL_ROOT: path.join(home, 'root'), HOME: home, USERPROFILE: home, PMM_RECALL_TAG: 'test',
  });
  delete env.PIPE_GATE_INJECT;
  delete env.PIPE_GATE_SELFTEST;
  if (pathOverride) { env.PATH = pathOverride; delete env.Path; }
  mkdirp(env.PMM_RECALL_ROOT);
  let res;
  try {
    res = spawnSync(exe, [path.join(copyDir, file)].concat(args || []), { env, stdio: [inFd, outFd, errFd] });
  } finally {
    fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);
  }
  return {
    rc: res.status === null || res.status === undefined ? -1 : res.status,
    stdout: fs.statSync(outPath).size,
    stderr: fs.statSync(errPath).size,
    // v2.24 erratum 1: a launch that could not be spawned at all must be
    // distinguishable from one that ran and returned rc -1.
    spawn_error: res.error ? String(res.error) : null,
    stderr_head: fs.readFileSync(errPath, 'utf8').split('\n')[0].slice(0, 160),
  };
}

function checkSettingsWiring(opts) {
  // test-only (self-check part12); undefined in a real run
  const exeOverride = (opts && opts.exeOverride) || null;
  const text = readTextSafe(SETTINGS_JSON_PATH);
  if (text === null) return { pass: false, reason: 'settings.json not found at ' + SETTINGS_JSON_PATH };
  let settings;
  try { settings = JSON.parse(text); } catch (e) { return { pass: false, reason: 'settings.json is not valid JSON: ' + e.message }; }
  const hooks = settings.hooks || {};
  const copy = makeSpacedGuardsCopy();
  const instances = [];
  let pass = true;
  for (const want of REQUIRED_WIRING_INSTANCES) {
    const target = path.resolve(GUARDS_DIR, want.file);
    const groups = (hooks[want.event] || []).filter((g) => want.matcher === null || g.matcher === want.matcher);
    let found = null;
    for (const g of groups) {
      for (const h of (g.hooks || [])) {
        const argv = hookCommandToArgv(String(h.command || ''));
        if (argv.length < 2) continue;
        let resolved = null;
        try { resolved = path.resolve(argv[1]); } catch (_e) { resolved = null; }
        if (resolved && resolved.toLowerCase() === target.toLowerCase()) { found = { hook: h, argv }; break; }
      }
      if (found) break;
    }
    const detail = {
      event: want.event, matcher: want.matcher, expects: want.exe + ' ' + want.file +
        (want.args.length ? ' ' + want.args.join(' ') : ''),
    };
    if (!found) {
      detail.found = false;
      detail.reason = 'no hook under ' + want.event + (want.matcher ? '(' + want.matcher + ')' : '') +
        ' whose argv[1] resolves to ' + target;
      pass = false;
      instances.push(detail);
      continue;
    }
    detail.found = true;
    detail.command = String(found.hook.command || '');
    detail.argv = found.argv;
    detail.exe_ok = found.argv[0] === want.exe || found.argv[0] === 'bash' || found.argv[0] === 'node';
    detail.exe_is_expected = found.argv[0] === want.exe;
    detail.absolute_ok = path.isAbsolute(found.argv[1]);
    detail.exists_ok = fs.existsSync(found.argv[1]);
    detail.equals_guards_file_ok = path.resolve(found.argv[1]).toLowerCase() === target.toLowerCase();
    detail.args_ok = (want.args || []).every((a) => found.argv.slice(2).indexOf(a) >= 0);
    const timeout = found.hook.timeout;
    detail.timeout = timeout === undefined ? null : timeout;
    detail.timeout_ok = timeout === undefined || timeout === null || Number(timeout) >= MIN_HOOK_TIMEOUT_SECONDS;
    const launch = launchWiringInstance(copy.dir, copy.base, exeOverride || found.argv[0], want.file, want.args);
    detail.launch = launch;
    detail.launch_ok = !launch.spawn_error && launch.rc === 0 && launch.stdout === 0 && launch.stderr === 0;
    // v2.16: the same launch again, with node unreachable.
    let nodelessOk = true;
    if (want.nodeless) {
      const absInterpreter = resolveInterpreterAbsolutePath(found.argv[0]);
      if (!absInterpreter) {
        detail.nodeless_launch = { error: 'could not resolve the interpreter before restricting PATH' };
        nodelessOk = false;
      } else {
        const restricted = restrictedPathFor(absInterpreter);
        detail.nodeless_path = restricted;
        detail.node_resolvable_under_restricted_path = toolResolvableUnderPath(absInterpreter, restricted, 'node');
        const nl = launchWiringInstance(copy.dir, copy.base, absInterpreter, want.file, want.args, restricted);
        detail.nodeless_launch = nl;
        nodelessOk = !detail.node_resolvable_under_restricted_path && !nl.spawn_error &&
          nl.rc === 0 && nl.stdout === 0 && nl.stderr === 0;
      }
      detail.nodeless_launch_ok = nodelessOk;
    }
    const ok = detail.exe_is_expected && detail.absolute_ok && detail.exists_ok &&
      detail.equals_guards_file_ok && detail.args_ok && detail.timeout_ok && detail.launch_ok && nodelessOk;
    detail.ok = ok;
    if (!ok) pass = false;
    instances.push(detail);
  }
  return {
    pass,
    reason: pass ? 'ok (five wiring instances present, argv-exact, and each launched from a spaced temp copy with rc 0 and no output)'
      : 'wiring instance(s) missing or wrong: ' + instances.filter((i) => !i.ok).map((i) => i.event + '/' + i.expects).join('; '),
    spaced_copy: copy.dir, files_copied: copy.copied,
    instances,
  };
}

function checkCanaryRoster() {
  const text = readTextSafe(GUARD_CANARY_PATH);
  if (text === null) return { pass: false, reason: 'guard-canary.sh not found' };
  const needles = {
    runner: 'pipe-gate-v2-acceptance',
    mutant_null: 'mutants/null.cjs',
    mutant_always: 'mutants/always.cjs',
    mutant_blind_parser: 'mutants/blind-parser.cjs',
    parser_conformance_selftest: 'pmm-cmd-parse-conformance',
  };
  const present = {};
  for (const [k, needle] of Object.entries(needles)) present[k] = text.includes(needle);
  const pass = Object.values(present).every(Boolean);
  return { pass, reason: pass ? 'ok' : 'roster missing entries (expected pre-builder: not registered until delivery ④)', detail: present };
}

function gitHashObject(filePath) {
  try { return execFileSync('git', ['hash-object', filePath], { cwd: GUARDS_DIR }).toString('utf8').trim(); }
  catch (e) { return null; }
}

// G07 (contract v2.15): "the pins file MUST contain exactly the keys contract,
// conformance, runner and mutants.{null,always,blind-parser,di-intervene}; a
// missing or extra key, an empty object, or a non-40-hex value is rc 2 before
// any case runs (an empty pins file {} used to pass G07 vacuously)". Every
// clause below is that sentence; the structural half throws, because a pins
// file that does not pin is not a weaker run, it is an unpinned one.
const PINS_TOP_LEVEL_KEYS = ['contract', 'conformance', 'runner', 'mutants'];
const PINS_MUTANT_KEYS = ['null', 'always', 'blind-parser', 'di-intervene'];
const GIT_BLOB_RE = /^[0-9a-f]{40}$/;

function validatePinsFileStructure(pinsPath) {
  if (!pinsPath) return; // absence is a red G07, handled below, not a throw
  let pins;
  try { pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8')); }
  catch (e) { throw new Error('--pins file unreadable or not JSON: ' + e.message); }
  const problems = [];
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) problems.push('pins is not an object');
  else {
    const top = Object.keys(pins);
    for (const k of PINS_TOP_LEVEL_KEYS) if (top.indexOf(k) < 0) problems.push('missing top-level key "' + k + '"');
    for (const k of top) if (PINS_TOP_LEVEL_KEYS.indexOf(k) < 0) problems.push('extra top-level key "' + k + '"');
    for (const k of ['contract', 'conformance', 'runner']) {
      if (pins[k] !== undefined && !GIT_BLOB_RE.test(String(pins[k]))) problems.push(k + ' is not a 40-hex git blob: ' + JSON.stringify(pins[k]));
    }
    const m = pins.mutants;
    if (m === undefined) { /* already reported as missing */ }
    else if (!m || typeof m !== 'object' || Array.isArray(m)) problems.push('mutants is not an object');
    else {
      const mk = Object.keys(m);
      if (mk.length === 0) problems.push('mutants is an empty object');
      for (const k of PINS_MUTANT_KEYS) if (mk.indexOf(k) < 0) problems.push('missing mutants."' + k + '"');
      for (const k of mk) if (PINS_MUTANT_KEYS.indexOf(k) < 0) problems.push('extra mutants."' + k + '"');
      for (const k of mk) if (!GIT_BLOB_RE.test(String(m[k]))) problems.push('mutants."' + k + '" is not a 40-hex git blob: ' + JSON.stringify(m[k]));
    }
  }
  if (problems.length) {
    throw new Error('--pins file violates contract ledger_cases.G07 (' + problems.length + ' problem(s)):\n  ' + problems.join('\n  '));
  }
}

function checkBlobPins(opts) {
  const pinsPath = opts && opts.pinsPath;
  // MEDIUM-11: G05-G09 are asserted in every mode; a missing --pins is a red
  // G07, since it is the only signal that this run actually pinned the
  // pre-registered files.
  if (!pinsPath) return { pass: false, asserted: true, reason: 'no --pins given -- G07 cannot be asserted without it (v2.5: this is now red, not a silent skip)' };
  let pins;
  try { pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8')); }
  catch (e) { return { pass: false, asserted: true, reason: 'could not read/parse --pins file: ' + e.message }; }
  // v2.15: hash the files this run is ACTUALLY executing. Hashing the defaults
  // meant that --contract <copy> ran the copy while G07 blessed the original.
  const contractPath = (opts && opts.contractPath) || DEFAULT_CONTRACT;
  const conformancePath = (opts && opts.conformancePath) || DEFAULT_CONFORMANCE;
  const checks = {};
  const detail = { contract_path: contractPath, conformance_path: conformancePath, runner_path: __filename };
  checks.contract = gitHashObject(contractPath) === pins.contract;
  checks.conformance = gitHashObject(conformancePath) === pins.conformance;
  checks.runner = gitHashObject(__filename) === pins.runner;
  for (const name of PINS_MUTANT_KEYS) {
    const p = name === 'di-intervene' ? DI_INTERVENE_PATH : MUTANT_PATHS[name];
    checks['mutant:' + name] = gitHashObject(p) === (pins.mutants || {})[name];
  }
  const pass = Object.values(checks).every(Boolean);
  return { pass, asserted: true, reason: pass ? 'ok' : 'blob mismatch', detail: Object.assign(detail, checks) };
}

// single_handler duty: defense-in-depth REPORT only, never gates the run.
// conventions.single_handler keeps this a REPORT (the asserting half is G09 for
// the handler and Z23 for the env switch). v2.16 widens it to the production
// dependencies the gate pulls in, because that is where the env-driven parser
// switch actually lived.
const PRODUCTION_DEPENDENCY_FILES = [
  'bash-pipe-exitcode-watch.sh', 'bash-pipe-exitcode-watch.cjs',
  'pmm-cmd-parse.cjs', 'pmm-recall-ledger.cjs',
];
function grepSecondJudgeImplementation() {
  let combined = '';
  const perFile = {};
  for (const name of PRODUCTION_DEPENDENCY_FILES) {
    const text = readTextSafe(path.join(GUARDS_DIR, name));
    if (text === null) { perFile[name] = { present: false }; continue; }
    combined += text + '\n';
    const envMutantReads = (text.match(/PMM_CMD_PARSE_MUTANT/g) || []).length;
    perFile[name] = {
      present: true,
      judge_definitions: (text.match(/function\s+judge\s*\(/g) || []).length,
      parse_definitions: (text.match(/function\s+parse\s*\(/g) || []).length,
      env_mutant_mentions: envMutantReads,
    };
  }
  const judgeDefs = (combined.match(/function\s+judge\s*\(/g) || []).length;
  const parseDefs = (combined.match(/function\s+parse\s*\(/g) || []).length;
  const envSwitchedImpl = /process\.env\.\w+\s*===?\s*['"]\w+['"][^\n]*judge/i.test(combined);
  const envMutantFiles = Object.keys(perFile).filter((k) => (perFile[k].env_mutant_mentions || 0) > 0);
  return {
    report_only: true,
    files: perFile,
    judge_definitions_found: judgeDefs, parse_definitions_found: parseDefs,
    possible_env_switched_implementation: envSwitchedImpl,
    env_mutant_reading_files: envMutantFiles,
    env_mutant_note: envMutantFiles.length
      ? 'PMM_CMD_PARSE_MUTANT is mentioned in ' + envMutantFiles.join(', ') +
        ' -- a production dependency must not read it (contract v2.16); the ASSERTING half of this is silence case Z23'
      : 'no production dependency mentions PMM_CMD_PARSE_MUTANT',
    note: judgeDefs > 1 || parseDefs > 1 ? 'MORE THAN ONE judge/parse definition found -- investigate manually' : 'single or zero definitions found',
  };
}

// ===========================================================================
// mutant derivation functions (operate on expectation STRUCTURE, not text)
// ===========================================================================

const JUDGE_PRODUCED_EVENTS = ['unsupported', 'path_unresolved', 'cd-hint', 'emitted'];

// Opus r6 lesson 4 ("推导器按键清单逐个写,就一定会漏键"): the four keys that
// count GATE ROWS live in ONE list that every transform below reads, instead
// of each transform carrying its own copy -- that divergence is exactly how
// transformForNull came to handle them and transformForBlindParser did not
// (HIGH-4). MUTANT_TRANSFORM_KEY_COVERAGE below declares, for every expect
// key the contract can use, which mutant transforms may change it; the
// --self-check fails if the contract grows a key that is not declared there.
const GATE_ROW_COUNT_KEYS = [
  'raw_rows_for_tool_use', 'deduped_rows_for_tool_use', 'distinct_event_ids', 'distinct_impression_ids',
];

const MUTANT_TRANSFORM_KEY_COVERAGE = {
  gates: 'null: []; always: exactly one {A,recurrence}; blind-parser: A / D-recurrence / expansion-dependent entries removed',
  events: 'null + always: judge-produced kinds removed; blind-parser: path_unresolved always, receipt-lost/pending-corrupt when the case creates state through a redirect',
  stdout: 'null: 0 when the rows came from judge; always: unchanged (mutants.derivation v2.8 withdrew the stdout clause); blind-parser: 0 when the intervene-mode finding disappears',
  stderr: 'orthogonal to all three mutants (byte channel, not a judgment)',
  raw_rows_for_tool_use: 'null + blind-parser: 0 when the rows came from a finding the mutant deletes; always: unchanged (one A finding still writes the same row shape)',
  deduped_rows_for_tool_use: 'same as raw_rows_for_tool_use',
  distinct_event_ids: 'same as raw_rows_for_tool_use',
  distinct_impression_ids: 'same as raw_rows_for_tool_use',
  pending_files: 'null + always: unchanged (pending is parse-driven, not judge-driven); blind-parser: changed when the pending was created through a redirect',
  pending_files_after: 'same as pending_files',
  pending_files_after_in: 'same as pending_files_after (contract lifecycle_expect_keys: parse-driven, unchanged under null/always, re-derived under blind-parser)',
  receipt_lines_for_tool_use: 'same as pending_files',
  events_not_contain: 'orthogonal: a negative assertion no mutant can satisfy by deleting rows',
  runner_detects_leak: 'Z-case key; silence cases do not run under mutants',
  // v2.18
  lease_kept: 'null + always: unchanged (the lease is receipt-layer, not judge-driven); blind-parser: changed when the pending was created through a redirect',
  gc_row_identity: 'null + always: unchanged (identity columns are copied from the pending, not produced by judge); blind-parser: changed when the pending was created through a redirect',
  arm_stability: 'null: no rows at all, so no arm; always: the class_tag becomes the mutant nonce so no policy entry matches; blind-parser: the A finding disappears',
  arm_effect: 'same as arm_stability',
};

function commandsOf(tc) {
  if (tc.cmd) return [tc.cmd];
  if (tc.steps) return tc.steps.map((s) => s.replace(/^[\w -]+(\([^)]*\))?:\s*/, ''));
  return [];
}
function referencesExitStatusOutsidePipestatus(text) {
  if (/PIPESTATUS/.test(text)) {
    const withoutPipestatus = text.replace(/\$\{?PIPESTATUS(\[[^\]]*\])?\}?/g, '');
    return /\$\?|\$\{\?\}/.test(withoutPipestatus);
  }
  return /\$\?|\$\{\?\}/.test(text);
}
function usesSameCommandAssignmentExpansion(text) {
  return /(^|;|\n)\s*[A-Za-z_][A-Za-z0-9_]*=\S+\s*;.*\$\{?[A-Za-z_]\w*\}?/.test(text);
}
// v2.6 HIGH-1/HIGH-2 fix: all three derivers apply their mutant's TRANSFORM
// to the case's WHOLE expectation block (gates AND events AND the lifecycle
// row-count/pending/receipt keys), then diff against the original -- not a
// hand-picked subset of keys, and not a command-text heuristic guessing at
// "is this command already A/recurrence-shaped" (removed per HIGH-2:
// commandIsPlainARecurrence deleted outright). This is still a mechanical
// approximation (see report): it reasons about which *keys* a mutant's
// definition can possibly change, rather than literally re-executing a
// second gate-rule interpreter end-to-end.

// null: judge produces NO gate rows and NO judge-informational events
// (unsupported/path_unresolved/cd-hint/emitted) for ANY event; parse and
// the receipt/pending layer are untouched (they do not go through judge).
function transformForNull(tc) {
  const exp = tc.expect || {};
  const out = Object.assign({}, exp);
  const judgeDependent = commandsOf(tc).some(referencesExitStatusOutsidePipestatus) ||
    (exp.gates || []).length > 0 || (exp.events || []).some((e) => JUDGE_PRODUCED_EVENTS.includes(e));
  if (out.gates !== undefined) out.gates = [];
  if (out.events !== undefined) out.events = out.events.filter((e) => !JUDGE_PRODUCED_EVENTS.includes(e));
  if (judgeDependent) {
    // contract mutants.derivation, null clause: "would-warn/emitted rows
    // absent, so row-count keys that count gate rows ... become 0;
    // pending_files/receipt keys unchanged (parse-driven)".
    for (const k of GATE_ROW_COUNT_KEYS) if (out[k] !== undefined) out[k] = 0;
    if (out.stdout !== undefined) out.stdout = '0';
  }
  // pending_files / pending_files_after / receipt_lines_for_tool_use /
  // events_not_contain / stderr are receipt-layer or purely structural --
  // untouched by a judge-only mutant.
  return out;
}
function deriveNullFail(tc) {
  return !deepEqual(tc.expect || {}, transformForNull(tc));
}

// always (HIGH-1, Opus r6): contract mutants.derivation, verbatim --
// "gates:= exactly one {A, recurrence} regardless of the original count (so
// any case expecting 0 or >=2 gate entries, or any non-A entry, fails)".
// v2.6 mapped entry-for-entry, which PRESERVED the count and therefore
// derived A29 (two independent pipelines, two A findings) as GREEN -- while
// mutants/always.cjs returns "exactly one finding ... for every event"
// regardless of what was parsed, so A29's actual result under always is ONE
// impression and the case is red. One finding in, one impression out: the
// transform now says so.
// contract mutants.derivation (v2.9 ruling): the always clause "row-count keys
// recomputed for exactly one A finding" STANDS and must be implemented -- "one
// impression per hook event; would-warn only under shadow, would-warn +
// emitted under intervene; raw rows = sum over events, deduped rows and
// distinct_event_ids per event_id rule, distinct_impression_ids = number of
// hook events sharing the tool_use_id collapse to 1 for identical re-entry".
// v2.8 left the keys unchanged and happened to agree with this for L10/L11;
// now it is computed, and L11 is in the mutant self-check subset so the
// agreement is measured rather than assumed.
function alwaysRowCountsFor(tc) {
  const steps = tc.steps || [];
  const preSteps = [];
  for (const s of steps) {
    const h = parseStepHeader(s);
    if (h.kind === 'pre' || /^pre x2/.test(s)) preSteps.push(h);
  }
  if (!preSteps.length) return null;
  let raw = 0;
  const kinds = new Set();
  let sharesToolUseId = true;
  for (let i = 0; i < preSteps.length; i++) {
    const args = String(preSteps[i].args || '').toLowerCase();
    const intervene = args.indexOf('intervene') >= 0 ? true
      : (args.indexOf('shadow') >= 0 ? false : tc.mode === 'intervene');
    raw += intervene ? 2 : 1;
    kinds.add('would-warn');
    if (intervene) kinds.add('emitted');
    if (i > 0 && !/same tool_use_id|identical payload/.test(args)) sharesToolUseId = false;
  }
  const impressions = sharesToolUseId ? 1 : preSteps.length;
  return {
    raw_rows_for_tool_use: raw,
    deduped_rows_for_tool_use: kinds.size * impressions,
    distinct_event_ids: kinds.size * impressions,
    distinct_impression_ids: impressions,
  };
}

function transformForAlways(tc) {
  const exp = tc.expect || {};
  const out = Object.assign({}, exp);
  if (out.gates !== undefined) {
    out.gates = [{ gate: 'A', confidence: 'recurrence' }];
  }
  if (out.events !== undefined && out.events.some((e) => JUDGE_PRODUCED_EVENTS.includes(e))) {
    out.events = ['__always_cannot_reproduce_informational_events__'];
  }
  // The always mutant replaces every finding with {A, recurrence, class_tag:
  // "mutant-always-<nonce>"}, and the policy is keyed BY CLASS TAG -- so under
  // always no policy entry matches, both sessions fall back to shadow, and the
  // arm keys cannot hold. Marking them changed keeps derived == actual.
  for (const k of ['arm_stability', 'arm_effect']) {
    if (out[k] !== undefined) out[k] = '__always_replaces_the_class_tag_so_no_policy_arm_applies__';
  }
  const alwaysCounts = alwaysRowCountsFor(tc);
  if (alwaysCounts) {
    for (const k of GATE_ROW_COUNT_KEYS) if (out[k] !== undefined) out[k] = alwaysCounts[k];
  }
  // stdout is NOT transformed under always. mutants.derivation v2.8,
  // verbatim: "the former always-clause 'intervene cases expecting stdout 0
  // fail' is withdrawn -- every other intervene case expecting stdout 0
  // already turns red through its gates, and a closed-stdout case (L09)
  // keeps its expectation under always (the single A finding is still
  // attempted and fails, events stay [emit-failed], stdout stays 0), so it
  // stays GREEN and must not be derived red." (This runner reported the
  // contradiction in round 6; v2.8 withdrew the clause rather than the case.)
  // pending/receipt/row-count keys: UNCHANGED -- always only replaces
  // judge's findings, never the receipt/pending layer.
  return out;
}
function deriveAlwaysFail(tc) {
  return !deepEqual(tc.expect || {}, transformForAlways(tc));
}

const REDIRECT_OPERATOR_RE = /(?:\d*|&)(>>|>\||&>>|&>|>)\s*(\S+)/;
// row_attribution / HIGH-1 fix: pending_files/pending_files_after/
// receipt_lines_for_tool_use and the receipt-lost/pending-corrupt events
// only depend on blind-parser's blanking when SOME step of THIS case
// actually creates a pending/receipt record through a redirect (equivalent
// to "Pre would fall to snapshot a redirect target") -- not on whether the
// case's gate confidence happens to be D/recurrence, which several
// pending/receipt-only lifecycle cases (L15/L15b/L16/L18) don't even have.
function caseHasRedirectStep(tc) {
  return commandsOf(tc).some((c) => REDIRECT_OPERATOR_RE.test(c));
}

// mutants.derivation (v2.13): "a lifecycle step the RUNNER performs on the
// pending store (e.g. L18 'runner truncates the pending file for the key',
// which synthesizes a pending when none exists and then corrupts it) is not
// redirect-driven, so the case does not join the blind-parser derived set on
// account of that step; only pendings the GATE must create through parsed
// redirects count as 'created through redirects'". L18's pending-corrupt
// therefore survives blind-parser -- the runner put that file there, blanked
// redirects or not -- and deriving it red made derived != actual by one id.
// LOW-H6: the L10 shape, read off the steps the contract wrote --
// "pre(shadow): ..." followed by "pre(intervene, same tool_use_id): ...".
// A case that does not say both things gets the ordinary per-finding
// assertion.
function caseDeclaresSharedImpressionAcrossArms(tc) {
  const steps = (tc.steps || []).map((s) => String(s).toLowerCase());
  const tagged = steps.map((s) => parseStepHeader(s).args || '');
  const hasShadow = tagged.some((a) => a.includes('shadow'));
  const hasIntervene = tagged.some((a) => a.includes('intervene'));
  const sameToolUseId = steps.some((s) => s.includes('same tool_use_id'));
  return hasShadow && hasIntervene && sameToolUseId;
}
function caseHasRunnerSynthesizedPendingStep(tc) {
  return (tc.steps || []).some((s) => /^runner\s+(truncates|writes)\b/.test(String(s)) && /pending/.test(String(s)));
}

// conventions.gate_b_browse_denylist (v2.20, amended v2.22): gate B is
// suppressed when the segment immediately upstream of head/tail is a browse
// exe, and that exemption is VOID when the operand was written earlier by a
// non-browse command (same command, or an earlier command with a receipt
// inside the TTL). The exe list is quoted verbatim from the convention.
// v2.23 (i) added head and tail themselves; v2.24 (vii) added rev-parse,
// remote, worktree and describe to the read-only git subs and (viii) a
// tool+sub table (docker/kubectl/podman logs). curl is deliberately absent.
const BROWSE_DENYLIST_EXES = new Set(['ls', 'dir', 'cat', 'find', 'fd', 'grep', 'rg', 'ag',
  'wc', 'du', 'df', 'echo', 'printf', 'env', 'which', 'type', 'jq', 'yq', 'sed', 'awk',
  'cut', 'sort', 'uniq', 'tr', 'column', 'head', 'tail']);
const BROWSE_DENYLIST_GIT_SUBS = new Set(['log', 'show', 'blame', 'ls-files', 'status',
  'branch', 'tag', 'stash', 'reflog', 'grep', 'ls-tree', 'cat-file', 'rev-list',
  'rev-parse', 'remote', 'worktree', 'describe']);
const BROWSE_TOOL_SUBS = { docker: new Set(['logs']), kubectl: new Set(['logs']), podman: new Set(['logs']) };
// v2.24 (vi): jq / yq LOSE the exemption when invoked with -e / --exit-status
// -- their exit status IS the verification and the pipe hides it.
// v2.26 conventions.gate_b_exempt_flag_clusters: "any single-dash cluster of
// letters containing e (-er, -re, -ec, -e) counts as -e ... a cluster without
// e (-r, -c, -rc) stays browse". The derivation read whole tokens only, so
// Bx30/Bx31/Bx32 (jq -er / jq -re / yq -er) were derived exempt -> B derived
// away under blind-parser -> derived red against an actual green (B is judged
// from exe+args, which the mutant does not touch).
const EXIT_STATUS_FLAGS = new Set(['-e', '--exit-status']);
const EXIT_STATUS_FLAG_CLUSTER_RE = /^-[a-zA-Z]*e[a-zA-Z]*$/;
function isExitStatusFlag(a) { return EXIT_STATUS_FLAGS.has(a) || EXIT_STATUS_FLAG_CLUSTER_RE.test(a); }
const HEAD_TAIL_EXES = new Set(['head', 'tail']);
function exeAndSubOf(segmentText) {
  const toks = String(segmentText).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i += 1; // env prefix
  return { exe: String(toks[i] || '').replace(/^.*[\\/]/, ''), sub: String(toks[i + 1] || '') };
}
// Every (head|tail) segment's IMMEDIATE upstream segment -- the convention
// consults nothing else, not even an earlier ;-separated command (v2.21).
function headTailUpstreamsOf(cmd) {
  const out = [];
  for (const pipeline of String(cmd).split(/(?:\|\||&&|;|\n)/)) {
    const segs = pipeline.split(/\|&|\|/);
    for (let i = 1; i < segs.length; i++) {
      if (!HEAD_TAIL_EXES.has(exeAndSubOf(segs[i]).exe)) continue;
      out.push(exeAndSubOf(segs[i - 1]));
    }
  }
  return out;
}
function isBrowseUpstream(u) {
  return u.exe === 'git' ? BROWSE_DENYLIST_GIT_SUBS.has(u.sub) : BROWSE_DENYLIST_EXES.has(u.exe);
}
// v2.22: a B finding whose head/tail segment sits directly downstream of a
// browse exe can ONLY exist because the exemption was voided, and every void
// condition is evidence blind-parser destroys -- the same-command writer is a
// REDIRECT (A12, Bx07), and the earlier-command receipt exists only because a
// redirect opened a pending (Bx09, Bx11). Such a B disappears under
// blind-parser. A B whose upstream is NOT on the denylist (B01-B12, Bx04-Bx06)
// never depended on a blanked field and survives, so the case must have NO
// non-browse head/tail upstream for the finding to be derived away.
// conventions.mutants_derivation (v2.23, codex LOW-11): "the blind-parser
// round derives the expected fate of every gate B instance from the
// TRANSFORMED parse and that instance's actual evidence (its upstream
// segments after the mutant erased redirects/status refs; its receipts),
// never from an every()-style heuristic over the raw command text". v2.22's
// heuristic could not see an unsupported upstream (Bx21 reads as "cat ..."
// in raw text but parses as unsupported:subshell) and could not see a
// pipeline with one firing and one exempt instance (Bx22).
//
// The transform is the PRE-REGISTERED mutant module itself, so the
// derivation and the round under test cannot drift apart. Its probe writes
// to PMM_RECALL_ROOT, which would pollute the probe.log accounting of the
// round, so the variable is removed for the duration of the call.
// conventions.verification_output_flags (v2.24): "the table is the single
// source for the gate (no second list in code); added camelCase and
// tool-specific spellings ... matching is exact on the flag token
// (case-sensitive), value given as =VALUE or the next token".
// v2.26 (codex final #3 (iii)): "--cov-report (pytest-cov) is in the table;
// its value is TYPE:PATH and the write target is the part after the first
// colon; a value without a colon (term, html) names no file and is not a
// write target" (Bx36 fires, Bx37 control stays exempt).
const VERIFICATION_OUTPUT_FLAGS = new Set(['--junitxml', '--junit-xml', '--report', '--report-file',
  '--output', '--output-file', '--out', '--log-file', '--logfile', '--results-file', '--results', '-o',
  '--outputFile', '--json-output-file', '--outfile', '--out-file', '--result-file',
  '--reporter-output', '--log-output', '--cov-report']);
function verificationFlagTarget(flag, value) {
  if (value === undefined || value === null) return null;
  const v = String(value);
  if (flag === '--cov-report') {
    const colon = v.indexOf(':');
    return colon < 0 ? null : v.slice(colon + 1);
  }
  return v;
}
function blindParseOf(cmd) {
  let mod;
  try { mod = require(MUTANT_PATHS['blind-parser']); } catch (_e) { return null; }
  if (!mod || typeof mod.parse !== 'function') return null;
  const saved = process.env.PMM_RECALL_ROOT;
  delete process.env.PMM_RECALL_ROOT;
  try { return mod.parse(String(cmd)); }
  catch (_e) { return null; }
  finally { if (saved !== undefined) process.env.PMM_RECALL_ROOT = saved; }
}
function segExe(s) { return String((s && s.exe) || '').replace(/^.*[\\/]/, ''); }
function segIsBrowse(s) {
  const exe = segExe(s);
  const sub = String((s && s.sub) || '');
  if (exe === 'git') return BROWSE_DENYLIST_GIT_SUBS.has(sub);
  if (BROWSE_TOOL_SUBS[exe]) return BROWSE_TOOL_SUBS[exe].has(sub);
  if ((exe === 'jq' || exe === 'yq') && argTextsOf(s).some(isExitStatusFlag)) return false;
  return BROWSE_DENYLIST_EXES.has(exe);
}
// conventions.writer_segment_rule (v2.26): "the segment that HOLDS the write
// redirect (or the verification output flag) is the writer whose exe decides
// browse vs verification for a later read of that file; the pipeline source
// is consulted only when the holding segment is a pure pass-through (tee, or
// cat with no file operand)". Mirrors the gate's isPurePassThroughWriter()
// exactly, including its reading that a browse/filter exe holding the write
// (sed/grep/sort ... > f) relays its source rather than producing output of
// its own -- without that, v2.23 (iv)'s `npm test | sed -n 1,20p > out.txt`
// (a verification write) would be decided by sed and become a browse write.
// contract v2.26 erratum 2 made that reading the contract's own text: "PURE
// PASS-THROUGH means tee, cat without a file operand, OR any command in the
// browse denylist ... the runner derivation and the gate share this
// definition" -- checked against this function in B1-tail-2, no change.
function segIsPurePassThroughWriter(s) {
  const exe = segExe(s);
  if (exe === 'tee') return true;
  if (exe === 'cat') return !argTextsOf(s).some((a) => !/^-/.test(a));
  return segIsBrowse(s);
}
function segIsUnsupported(s) { return /^unsupported/.test(String((s && (s.status || s.parse_status)) || '')); }
function argTextsOf(s) {
  return ((s && s.args) || []).map((a) => (typeof a === 'string' ? a : String((a && (a.decoded !== undefined ? a.decoded : a.raw)) || '')));
}
// A token that could name a file: it has a path separator, so a grep pattern
// or a sed program never resolves to one (the convention says exactly that).
function looksLikePath(tok) { return /[\\/]/.test(String(tok)); }
// Write targets of ONE segment, as the convention defines them: shell
// redirects (erased by the mutant, which is the whole point), tee's
// positional files, and verification_output_flags values (both survive,
// because they are ARGS).
function writeTargetsOfSegment(s) {
  const out = [];
  for (const r of (s && s.redirects) || []) {
    const tgt = typeof r === 'string' ? r : (r && (r.target || r.path || r.file));
    if (tgt) out.push(String(tgt));
  }
  const args = argTextsOf(s);
  if (segExe(s) === 'tee') for (const a of args) { if (!/^-/.test(a)) out.push(a); }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    let t = null;
    if (/^-/.test(a) && eq > 0 && VERIFICATION_OUTPUT_FLAGS.has(a.slice(0, eq))) t = verificationFlagTarget(a.slice(0, eq), a.slice(eq + 1));
    else if (VERIFICATION_OUTPUT_FLAGS.has(a) && args[i + 1] !== undefined && !/^-/.test(args[i + 1])) t = verificationFlagTarget(a, args[i + 1]);
    if (t !== null) out.push(t);
  }
  return out.filter(looksLikePath);
}
function pipelinesOf(parsed) {
  const pipelines = [];
  let cur = [];
  for (const s of (parsed && parsed.segments) || []) {
    if (String((s && s.sep_before) || '') !== '|' && String((s && s.sep_before) || '') !== '|&') {
      if (cur.length) pipelines.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length) pipelines.push(cur);
  return pipelines;
}
// Every gate B instance of the case (one per head/tail segment), with the
// fate the TRANSFORMED parse implies for it.
function blindGateBInstances(tc) {
  const instances = [];
  const writes = new Set(); // verification writes that SURVIVE the transform
  const parses = [];
  for (const cmd of commandsOf(tc)) {
    const parsed = blindParseOf(cmd);
    if (!parsed) return null; // cannot derive -> caller keeps the conservative answer
    parses.push({ cmd, pipelines: pipelinesOf(parsed) });
  }
  // (iv)+(v) as amended by v2.26 writer_segment_rule: a write counts as
  // VERIFICATION output when the segment HOLDING it is not a browse exe, or,
  // when that segment is a pure pass-through, when the SOURCE of its pipeline
  // is not a browse exe (`ls | sed ... > list.txt` and `ls | tee list.txt`
  // are browse writes; `printf x | npm test > out.txt` is a verification
  // write -- Bx34). Collected across every command of the case because the
  // receipt form of the evidence (b) is cross-command by construction.
  for (const p of parses) {
    for (const pl of p.pipelines) {
      for (const s of pl) {
        const deciding = segIsPurePassThroughWriter(s) ? pl[0] : s;
        if (segIsBrowse(deciding)) continue;
        for (const w of writeTargetsOfSegment(s)) writes.add(w);
      }
    }
  }
  for (const p of parses) {
    for (const pl of p.pipelines) {
      for (let i = 1; i < pl.length; i++) {
        if (!HEAD_TAIL_EXES.has(segExe(pl[i]))) continue;
        const upstream = pl.slice(0, i);
        let fires; let why;
        if (upstream.some(segIsUnsupported)) { fires = true; why = 'unsupported upstream: the gate never exempts on an unparsed segment'; }
        else if (!upstream.every(segIsBrowse)) { fires = true; why = 'a segment upstream of head/tail is not a browse exe'; }
        else {
          const operands = [];
          for (const u of upstream) for (const a of argTextsOf(u)) if (!/^-/.test(a) && looksLikePath(a)) operands.push(a);
          const hit = operands.find((o) => writes.has(o));
          fires = !!hit;
          why = hit ? 'exemption void: ' + hit + ' is a surviving verification write target'
            : 'all-browse upstream and no write evidence survives the transform';
        }
        instances.push({ cmd: p.cmd, head_tail: segExe(pl[i]), fires, why });
      }
    }
  }
  return instances;
}
// B survives blind-parser iff at least one of its instances still fires.
function bFindingOnlySurvivesExemptionVoid(tc) {
  const instances = blindGateBInstances(tc);
  if (instances === null) return false; // parse unavailable: keep B (conservative)
  if (!instances.length) return false;
  return !instances.some((i) => i.fires);
}

// blind-parser: parse's status_refs/redirects/assignments/expansions are
// zeroed; judge is untouched, so gate B (exe+sep_before only) and D-
// candidate (plain args + statSync) are unaffected, while gate A (needs
// status_refs), D-recurrence (needs redirects for the receipt/pending
// mechanism), path_unresolved (needs unresolved_variables), and
// same-command assignment-expansion path resolution all lose their only
// signal.
function transformForBlindParser(tc) {
  const exp = tc.expect || {};
  const out = Object.assign({}, exp);
  const hasGateA = (exp.gates || []).some((g) => g.gate === 'A');
  const hasDRecurrence = (exp.gates || []).some((g) => g.gate === 'D' && g.confidence === 'recurrence');
  const needsAssignmentExpansion = commandsOf(tc).some(usesSameCommandAssignmentExpansion);
  // v2.22: B is normally blanking-proof, but a B that exists only because a
  // browse exemption was voided is not (see bFindingOnlySurvivesExemptionVoid).
  const bNeedsVoidEvidence = bFindingOnlySurvivesExemptionVoid(tc);
  if (out.gates !== undefined && (hasGateA || hasDRecurrence || needsAssignmentExpansion || bNeedsVoidEvidence)) {
    out.gates = (exp.gates || []).filter((g) => {
      if (g.gate === 'B') return !bNeedsVoidEvidence;
      // A same-command assignment-expansion dependency means the D finding
      // (candidate OR recurrence) needed the expanded path to resolve the
      // operand at all -- it vanishes entirely under blind-parser, not just
      // downgrades. Only a D-candidate that does NOT depend on expansion
      // survives (e.g. a literal ABS/... path with no $VAR involved).
      if (needsAssignmentExpansion) return false;
      return g.gate === 'D' && g.confidence === 'recurrence-candidate';
    });
  }
  // HIGH-4 (Opus r6): the four row-count keys COUNT GATE ROWS, so a case
  // whose findings disappear under blind-parser writes no rows at all --
  // L10 (3/2/2/1) and L11 (4/2/2/1) are pure A-gate cases and go to 0/0/0/0.
  // v2.6's transform never touched these keys (transformForNull did), so
  // both cases derived GREEN against an actual RED. When the case states its
  // gates explicitly, the surviving-gates array computed just above decides;
  // when it states only row counts (L10/L11 have no `gates` key at all),
  // the rows came from gate A iff the command references $? outside
  // PIPESTATUS -- the same signal blind-parser blanks.
  if (GATE_ROW_COUNT_KEYS.some((k) => out[k] !== undefined)) {
    const losesAllGateRows = out.gates !== undefined
      ? out.gates.length === 0
      : commandsOf(tc).some(referencesExitStatusOutsidePipestatus);
    if (losesAllGateRows) {
      for (const k of GATE_ROW_COUNT_KEYS) if (out[k] !== undefined) out[k] = 0;
    }
  }
  const createsViaRedirect = caseHasRedirectStep(tc);
  const runnerOwnsThePending = caseHasRunnerSynthesizedPendingStep(tc);
  if (out.events !== undefined) {
    out.events = out.events.filter((e) => {
      if (e === 'path_unresolved') return false; // unresolved_variables always cleared
      if ((e === 'receipt-lost' || e === 'pending-corrupt') && createsViaRedirect && !runnerOwnsThePending) return false;
      return true;
    });
  }
  if (createsViaRedirect) {
    for (const k of ['pending_files', 'pending_files_after', 'pending_files_after_in', 'receipt_lines_for_tool_use']) {
      if (out[k] !== undefined) out[k] = '__changed_by_blind_parser__';
    }
  }
  if ((hasGateA || hasDRecurrence) && out.stdout !== undefined && tc.mode === 'intervene') out.stdout = '0';
  return out;
}
// v2.23 made a clock: step prove it aged something. While that assertion
// required a receipts file to EXIST, a clock case was red under blind-parser
// (the mutant erases the redirect that opens the pending, so no receipt is
// ever written) and the derivation had to say so for L07/L08/L17/Bx10. The
// L23 counterexample then forced the honest form -- the assertion fires only
// when the case owns a receipts file -- and under blind-parser it owns none,
// so the clock step no longer decides the case's fate and the derivation is
// back to the expectation transform alone. Recorded because the pair of
// changes has to move together: an assertion that can fire only sometimes
// needs a derivation that knows when.
function deriveBlindParserFail(tc) {
  return !deepEqual(tc.expect || {}, transformForBlindParser(tc));
}

const DERIVERS = { null: deriveNullFail, always: deriveAlwaysFail, 'blind-parser': deriveBlindParserFail };

// ===========================================================================
// causal sentinel assertion (replaces probe-line-count as PRIMARY criterion)
// ===========================================================================

function probeLineCount(stateDir) {
  const p = path.join(stateDir, 'probe.log');
  try { return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.length > 0).length; } catch (_e) { return 0; }
}

// causal_sentinels (v2.5 MEDIUM-3): `rows` MUST already be filtered to this
// ONE case's tool_use_id by the caller -- never the whole ledger, or one
// case going through the seam makes every later case's sentinel vacuously
// true. `expectsGateRows` (does THIS case's expectation include >=1 gate
// row) gates whether the check applies at all: "cases expecting zero gate
// rows are skipped for the sentinel check".
function sentinelPresent(mutant, nonce, rows, expectsGateRows) {
  if (!nonce || !expectsGateRows) return { checked: false };
  if (mutant === 'always') {
    const inLedger = rows.some((r) => String(r.class_tag || '').includes(nonce));
    return { checked: true, present: inLedger, where: inLedger ? 'ledger.class_tag' : 'nowhere' };
  }
  if (mutant === 'blind-parser') {
    const inLedger = rows.some((r) => String(r.parser_version || '').includes(nonce));
    return { checked: true, present: inLedger, where: inLedger ? 'ledger.parser_version' : 'nowhere' };
  }
  return { checked: false };
}

// A case "expects gate rows" if its expect block asserts >=1 {gate,...}
// entry, OR (lifecycle cases without a `gates` field) its row-count
// expectations are themselves evidence of a real judge finding.
function caseExpectsGateRows(tc) {
  const gates = (tc.expect && tc.expect.gates) || [];
  if (gates.length >= 1) return true;
  if (tc.expect && ((tc.expect.deduped_rows_for_tool_use || 0) > 0 || (tc.expect.distinct_impression_ids || 0) > 0)) {
    return commandsOf(tc).some(referencesExitStatusOutsidePipestatus);
  }
  return false;
}

// HIGH-6 (Opus r6): mutants.probe_rule / conventions.causal_sentinels --
// "sentinel presence is evaluated per case ... using the MUTATED expectation
// (under blind-parser a case whose transformed expectation has no gate rows
// is skipped)". v2.6 asked the BASELINE expectation, so every A-gate case
// (A01..A29, L09, L10, L11 -- 17+ of them) was required to show a sentinel
// row under the one mutant whose entire definition is "these cases write no
// row at all": sentinel_ok was structurally false and the blind-parser round
// exited 1 no matter what the gate did. The always round keeps the baseline
// predicate: always ADDS a finding to every event, so a case skipped there
// is skipped conservatively, never impossibly.
function caseExpectsGateRowsUnderMutant(tc, mutant) {
  // LOW-3 (Opus r8): the always round used the BASELINE expectation, so a case
  // like A08 (expects no gates at all) was skipped -- but under always every
  // hook event gets exactly one A finding, so the contract's rule ("cases
  // whose MUTATED expectation ... has zero gate rows are skipped") demands
  // that it IS checked. The predicate is one implementation over both rounds
  // now, always reading the block that round's transform produced.
  const mutated = mutant === 'always' ? transformForAlways(tc)
    : mutant === 'blind-parser' ? transformForBlindParser(tc)
      : null;
  if (!mutated) return caseExpectsGateRows(tc);
  if (Array.isArray(mutated.gates)) return mutated.gates.length >= 1;
  if ((mutated.deduped_rows_for_tool_use || 0) > 0 || (mutated.distinct_impression_ids || 0) > 0) {
    return commandsOf(tc).some(referencesExitStatusOutsidePipestatus);
  }
  return false;
}

// step_grammar / probe_rule (v2.5): a lifecycle case with NO `pre` step at
// all never reaches judge/parse through a fresh Pre call (only exec/post/
// clock/runner-* steps run), so probe.log cannot be expected to grow for it
// -- exempt it from the probe_rule requirement rather than forcing the
// whole mutant round red over a structurally unreachable assertion.
function caseExemptFromProbeRule(tc) {
  if (!tc.steps) return false;
  return !tc.steps.some((s) => parseStepHeader(s).kind === 'pre' || /^pre[\s(:]/.test(s) || /^pre x2/.test(s));
}

// ===========================================================================
// contract loading + normalization
// ===========================================================================

function loadContract(contractPath) {
  const raw = fs.readFileSync(contractPath, 'utf8');
  const contract = JSON.parse(raw);
  if (contract.version !== REQUIRED_CONTRACT_VERSION) {
    throw new Error('contract version mismatch: runner requires exactly "' + REQUIRED_CONTRACT_VERSION + '", got "' + contract.version + '"');
  }
  // conventions.required_fixture_version names the fixture this contract
  // expects; REQUIRED_FIXTURE_VERSION is what this runner was written
  // against. If they ever diverge, one of the two was bumped alone.
  const contractFixtureVersion = contract.conventions && contract.conventions.required_fixture_version;
  if (contractFixtureVersion !== undefined && contractFixtureVersion !== REQUIRED_FIXTURE_VERSION) {
    throw new Error('contract conventions.required_fixture_version is "' + contractFixtureVersion +
      '" but this runner requires fixture version "' + REQUIRED_FIXTURE_VERSION + '"');
  }
  const byId = {};
  for (const c of contract.cases || []) byId[c.id] = c;
  for (const c of contract.lifecycle_cases || []) byId[c.id] = c;
  for (const c of contract.silence_cases || []) byId[c.id] = c;
  for (const c of contract.ledger_cases || []) byId[c.id] = c;
  return { contract, byId, contractPath, contractSha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

// ===========================================================================
// main run (production or single-mutant round)
// ===========================================================================

async function runBaselineOrProduction(opts) {
  // G07 v2.15: structural violations are rc 2 BEFORE any case runs.
  validatePinsFileStructure(opts.pins);
  const { contract } = loadContract(opts.contract);
  const ctx = makeCtx({ ...opts, conventions: contract.conventions });
  const caseResults = [];

  // MEDIUM-1 (Opus r7): the fd preflights ran ONLY in --self-check, so the
  // "preflight fails -> L09 is unscored with the reason, not red" rule that
  // conventions.lifecycle_executors["closed stdout"] mandates did not apply to
  // the round that actually decides anything. A different node build or host
  // would have reddened L09 in the production round with no clue why.
  const closedStdoutPreflight = preflightClosedStdoutRecipe(process.env);
  const closedStdinPreflight = preflightClosedStdinRecipe(process.env);
  const l09UnscoredReason = closedStdoutPreflight.pass ? null
    : 'closed-stdout preflight failed on this host: ' + closedStdoutPreflight.recipe +
      ' -> child reported ' + closedStdoutPreflight.child_observation +
      ' (required ' + closedStdoutPreflight.required + '). L09 reported report_only per contract' +
      ' conventions.lifecycle_executors["closed stdout"].';

  const prodManifestBefore = hashTreeManifest(DEFAULT_PRODUCTION_ROOT);

  const casesById = {};
  for (const c of contract.cases) casesById[c.id] = c;

  for (const tc of contract.cases) {
    caseResults.push(isPolicyCaseMode(tc.mode) ? execPolicyRandomizedCase(tc, ctx) : execNormalCase(tc, ctx));
  }
  for (const tc of contract.lifecycle_cases) caseResults.push(await execLifecycleCase(tc, ctx));
  for (const tc of contract.silence_cases) caseResults.push(execSilenceCase(tc, ctx, casesById));

  // MEDIUM-2 (Opus r6): a contract case carrying `report_only: true` (Z14
  // today) is executed and reported but MUST NOT gate allPass -- the flag
  // lives in the contract, so adding or removing one never needs a runner
  // edit. Driven off the contract, not off the handler's own say-so.
  const reportOnlyIds = new Set(
    [...contract.cases, ...contract.lifecycle_cases, ...contract.silence_cases, ...contract.ledger_cases]
      .filter((c) => c.report_only === true).map((c) => c.id),
  );
  if (!closedStdoutPreflight.pass) reportOnlyIds.add('L09');
  for (const r of caseResults) if (reportOnlyIds.has(r.id)) r.report_only = true;
  const silenceEventsExemptIds = caseResults.filter((r) => r.silence_events_exempt).map((r) => r.id);

  const selfTestResult = runGateProcess(ctx.gateArgv.concat(['--self-test']), {
    stdinPath: null, closedStdin: true, cwd: ctx.cwdDir, env: buildEnv({ stateDir: ctx.stateDir }), ioDir: ctx.ioDir, label: 'self-test-' + randId('token'),
  });
  const selfTestCheck = evaluateSelfTestSummary(selfTestResult);

  const { rows: allRows } = readLedgerRows(ctx.stateDir);
  const ledger = runLedgerChecks(ctx, allRows, {
    pinsPath: opts.pins, contractPath: opts.contract, conformancePath: opts.conformance,
  });

  const prodManifestAfter = hashTreeManifest(DEFAULT_PRODUCTION_ROOT);
  const manifestsMatch = manifestsEqual(prodManifestBefore, prodManifestAfter);
  ledger.G02 = {
    pass: opts.nonInteractive ? manifestsMatch : true,
    asserted: !!opts.nonInteractive,
    manifests_match: manifestsMatch,
    reason: manifestsMatch ? 'ok' : (opts.nonInteractive
      ? 'default production root changed during run (ASSERTED, --non-interactive)'
      : 'default production root changed during run (REPORT ONLY: interactive session, not asserted per conventions.g02_mode)'),
    files_before: prodManifestBefore.length, files_after: prodManifestAfter.length,
    // conventions.g02_note (v2.14): under the prescribed temp-HOME run,
    // DEFAULT_PRODUCTION_ROOT resolves INSIDE that temp HOME, so G02 compares
    // 0 files with 0 and proves only that a gate ignoring PMM_RECALL_ROOT and
    // falling back to homedir would have created files there -- NOT that the
    // real production root was untouched. Reported, never asserted.
    production_root: DEFAULT_PRODUCTION_ROOT,
    production_root_under_temp_home: String(DEFAULT_PRODUCTION_ROOT).toLowerCase()
      .startsWith(String(os.tmpdir()).toLowerCase()),
  };

  const conformance = runParserConformance(opts.conformance, opts.parserModule);
  const flatRound = runParserFlatMutantRound(opts.conformance, opts.parserModule);
  const conformancePassed = conformance.results.filter((r) => r.pass).length;
  const notesScan = scanFixtureNotesForInferenceWording(opts.conformance);
  ledger.G08 = {
    pass: conformancePassed === conformance.results.length && flatRound.sets_equal && notesScan.pass &&
      !!(conformance.schema && conformance.schema.ok),
    parser_mandatory_fields: conformance.schema,
    conformance_total: conformance.results.length, conformance_passed: conformancePassed,
    conformance_failed: conformance.results.length - conformancePassed,
    flat_mutant: flatRound,
    inference_wording_scan: notesScan,
    reason: (conformance.schema && !conformance.schema.ok) ? conformance.schema.reason
      : !notesScan.pass ? 'fixture notes contain inference wording: ' + notesScan.reason
      : (conformancePassed === conformance.results.length)
        ? (flatRound.sets_equal ? 'ok' : 'flat mutant derived/actual sets differ')
        : 'production parser fails ' + (conformance.results.length - conformancePassed) + '/' + conformance.results.length + ' conformance cases (expected pre-v1.2-upgrade)',
  };

  const singleHandlerReport = grepSecondJudgeImplementation();

  // G09 (v2.6 MEDIUM-12): "reuses the always and null mutant-round results
  // already produced in the same run (no extra rounds)". Preferred source:
  // --always-report/--null-report pointing at JSON files a canary already
  // produced via separate `--mutant always --report ...` / `--mutant null
  // --report ...` invocations. Only if neither is given does this fall back
  // to running the two rounds in-process (the old, 3x-slower behavior) --
  // unless --skip-g09 was given (and it is NOT --non-interactive, enforced
  // in parseArgs), in which case G09 is skipped outright for fast iteration.
  let g09;
  if (opts.skipG09) {
    g09 = { pass: true, skipped: true, reason: 'skipped via --skip-g09 (not honored under --non-interactive)' };
  } else {
    let alwaysPerCase, nullPerCase, source;
    if (opts.alwaysReport && opts.nullReport) {
      try {
        alwaysPerCase = JSON.parse(fs.readFileSync(opts.alwaysReport, 'utf8')).mutant_round.per_case;
        nullPerCase = JSON.parse(fs.readFileSync(opts.nullReport, 'utf8')).mutant_round.per_case;
        source = 'reused --always-report/--null-report';
      } catch (e) {
        alwaysPerCase = null; nullPerCase = null;
      }
    }
    if (!alwaysPerCase || !nullPerCase) {
      const alwaysForG09 = await runMutantRound({ ...opts, mutant: 'always' });
      const nullForG09 = await runMutantRound({ ...opts, mutant: 'null' });
      alwaysPerCase = alwaysForG09.mutant_round.per_case;
      nullPerCase = nullForG09.mutant_round.per_case;
      source = (opts.alwaysReport || opts.nullReport)
        ? 'fallback in-process run (--always-report/--null-report incomplete or unreadable)'
        : 'in-process run (no --always-report/--null-report given)';
    }
    const gateRowCaseIds = new Set(
      [...contract.cases, ...contract.lifecycle_cases].filter(caseExpectsGateRows).map((c) => c.id),
    );
    const spyRecordsMissing = alwaysPerCase
      .filter((c) => gateRowCaseIds.has(c.id) && !(c.sentinel && c.sentinel.checked && c.sentinel.present))
      .map((c) => c.id);
    const droppedReturnStillGreen = nullPerCase
      .filter((c) => gateRowCaseIds.has(c.id) && c.actual_pass !== false)
      .map((c) => c.id);
    g09 = {
      pass: spyRecordsMissing.length === 0 && droppedReturnStillGreen.length === 0,
      source, gate_row_case_count: gateRowCaseIds.size,
      spy_records_missing: spyRecordsMissing,
      dropped_return_still_green: droppedReturnStillGreen,
      reason: (spyRecordsMissing.length === 0 && droppedReturnStillGreen.length === 0)
        ? 'ok'
        : 'spy_records_missing: ' + spyRecordsMissing.length + ', dropped_return_still_green: ' + droppedReturnStillGreen.length,
    };
  }
  ledger.G09 = g09;

  return {
    ctx, caseResults, ledger, contract, selfTestCheck, conformance, flatRound, singleHandlerReport,
    hostRecipePreflights: { closed_stdout: closedStdoutPreflight, closed_stdin: closedStdinPreflight },
    l09UnscoredReason, silenceEventsExemptIds,
  };
}

async function runMutantRound(opts) {
  const { contract } = loadContract(opts.contract);
  const nonce = crypto.randomBytes(12).toString('hex');
  const ctx = makeCtx({ ...opts, conventions: contract.conventions, nonce });
  // MEDIUM-1: same preflight discipline in the mutant rounds. A host that
  // cannot produce the closed-stdout condition would otherwise make L09 an
  // actual-red the derivation never predicts, breaking sets_equal for a reason
  // that has nothing to do with the gate.
  const closedStdoutPreflight = preflightClosedStdoutRecipe(process.env);
  const closedStdinPreflight = preflightClosedStdinRecipe(process.env);
  const excludedIds = closedStdoutPreflight.pass ? [] : ['L09'];
  const executable = [...contract.cases, ...contract.lifecycle_cases]
    .filter((c) => excludedIds.indexOf(c.id) < 0);
  const actualFailIds = [];
  const derivedFailIds = [];
  const probeOkByCase = {};
  const sentinelOkByCase = {};
  const deriver = DERIVERS[opts.mutant];
  const perCase = [];

  for (const tc of executable) {
    const before = probeLineCount(ctx.stateDir);
    const result = tc.steps ? await execLifecycleCase(tc, ctx)
      : (isPolicyCaseMode(tc.mode) ? execPolicyRandomizedCase(tc, ctx) : execNormalCase(tc, ctx));
    const after = probeLineCount(ctx.stateDir);
    const grew = after > before;
    // probe_rule (v2.5): cases with no `pre` step at all cannot reach
    // judge/parse through this test and are exempt from the growth
    // requirement (vacuously satisfied) rather than reddening the whole
    // mutant round over a structurally unreachable assertion.
    probeOkByCase[tc.id] = grew || caseExemptFromProbeRule(tc);
    if (!result.pass) actualFailIds.push(tc.id);
    const derivedFail = deriver(tc);
    if (derivedFail) derivedFailIds.push(tc.id);

    // MEDIUM-3: sentinel is evaluated PER CASE, on rows filtered to THIS
    // case's own tool_use_id -- never the whole ledger.
    const { rows } = readLedgerRows(ctx.stateDir);
    const caseToolUseId = result.actual && result.actual.tool_use_id;
    const caseRows = caseToolUseId ? rows.filter((r) => r.tool_use_id === caseToolUseId) : [];
    const sentinel = sentinelPresent(opts.mutant, nonce, caseRows, caseExpectsGateRowsUnderMutant(tc, opts.mutant));
    sentinelOkByCase[tc.id] = sentinel.checked ? sentinel.present : true;

    perCase.push({ id: tc.id, actual_pass: result.pass, derived_fail: derivedFail, probe_grew: grew, probe_exempt: caseExemptFromProbeRule(tc), sentinel, reason: result.reason });
  }

  const probeOk = Object.values(probeOkByCase).every(Boolean);
  const actualSet = new Set(actualFailIds);
  const derivedSet = new Set(derivedFailIds);
  const setsEqual = actualSet.size === derivedSet.size && [...actualSet].every((id) => derivedSet.has(id));
  const sentinelOk = opts.mutant === 'null' ? true : Object.values(sentinelOkByCase).every(Boolean);

  return {
    ctx, nonce,
    mutant_round: {
      mutant: opts.mutant,
      host_recipe_preflights: { closed_stdout: closedStdoutPreflight, closed_stdin: closedStdinPreflight },
      report_only_excluded: excludedIds,
      report_only_excluded_reason: excludedIds.length
        ? 'closed-stdout preflight failed on this host (' + closedStdoutPreflight.child_observation +
          '); L09 excluded from this round per conventions.lifecycle_executors["closed stdout"]'
        : null,
      derived_fail_ids: derivedFailIds.sort(),
      actual_fail_ids: actualFailIds.sort(),
      probe_ok: probeOk,
      sentinel_ok: sentinelOk,
      sets_equal: setsEqual,
      per_case: perCase,
    },
  };
}

// ===========================================================================
// --self-check: stub gate + threefold proof + real-parser conformance smoke
// ===========================================================================

function generateStubGate(dir, opts) {
  mkdirp(dir);
  const dieKind = opts && opts.dieOnCallKind;
  const suffix = dieKind ? '-die-' + dieKind : '';
  const cjsPath = path.join(dir, 'stub-gate' + suffix + '.cjs');
  const shPath = path.join(dir, 'stub-gate' + suffix + '.sh');
  const cjsBody = `'use strict';
// Throwaway stub gate generated by --self-check. It is NOT the gate under
// test: its only job is to be a known-correct implementation of the parts of
// the contract the runner's own machinery depends on, so a green self-check
// means "the runner measures what it claims", not "some gate passed".
// It therefore implements, per contract v2.7:
//   - the DI seam (PIPE_GATE_INJECT + PIPE_GATE_SELFTEST=1, path inside
//     PMM_RECALL_ROOT) for judge / parse / assignment;
//   - conventions.call_granularity: parse once, judge once per hook event,
//     judge returning {gates: Finding[], events: string[]} with
//     Finding = {gate, confidence, class_tag?} -- gate_instance_id is NOT
//     read off the finding, the gate derives it from \`parsed\` itself;
//   - conventions.impression_id including that derived gate_instance_id, so
//     A29's two pipelines yield two impressions from one judge call;
//   - gate_disposition_map: would-warn (+ emitted, or emit-failed when the
//     stdout write throws) under intervene; B and D-candidate never emit;
//   - conventions.layout pending/receipt handling: a Pre with a redirect
//     creates exactly one pending file at the key path (atomically, so two
//     concurrent Pres with the same key produce ONE file and no event), a
//     Pre that finds the key held by a DIFFERENT command records
//     pending-conflict, a Post consumes the pending into one receipt line
//     and removes it, and an unparseable pending records pending-corrupt.
// Judgment is driven ONLY by \`parsed\` (never by the raw command text), so
// injecting blind-parser really does change what this gate finds.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function miss() { process.exit(0); }
process.on('uncaughtException', miss);

function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function sha16(s) { return sha256hex(s).slice(0, 16); }
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* best effort */ }
}

let raw;
try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { miss(); }
if (!raw || raw.trim() === '') miss();
let data;
try { data = JSON.parse(raw); } catch (e) { miss(); }
if (!data || typeof data !== 'object') miss();
const cmd = data.tool_input && data.tool_input.command;
if (typeof cmd !== 'string' || cmd.trim() === '') miss();

const toolUseId = data.tool_use_id || '-';
const sessionId = data.session_id || '';
const agentId = data.agent_id || '';
const hookEvent = data.hook_event_name || 'PreToolUse';
const root = process.env.PMM_RECALL_ROOT || '';

// --------------------------------------------------------------- seam ----
let judge = null, parseFn = null, assignmentFn = null;
const injectPath = process.env.PIPE_GATE_INJECT;
const selftest = process.env.PIPE_GATE_SELFTEST === '1';
if (selftest && injectPath && root) {
  const norm = path.resolve(injectPath);
  if (norm.indexOf(path.resolve(root)) === 0) {
    try {
      const mod = require(injectPath);
      judge = mod.judge || null;
      parseFn = mod.parse || null;
      assignmentFn = mod.assignment || null;
    } catch (e) { /* injection failure -> fall back to the real handlers */ }
  }
}

// -------------------------------------------------------------- parse ----
// brief section 3: B is exe in {head,tail} with sep_before in {'|','|&'} --
// ANY segment of a pipeline, not only the last one; D is exe in {tail,head}
// with a file operand left after option consumption. cat/less/more are not
// gate D subjects (that mistake made A12's \`cat ABS/f.txt\` a phantom D).
const B_EXES = ['head', 'tail'];
const D_EXES = ['tail', 'head'];
const B_SEPARATORS = ['|', '|&'];
const REDIRECT_OPS = ['>', '>>', '>|', '&>', '&>>', '2>', '1>', '2>>'];

function splitTop(text) {
  const out = [];
  let buf = '', sep = 'start';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isPipe = ch === '|' && text[i + 1] !== '|' && text[i - 1] !== '|';
    if (ch === ';' || isPipe) { out.push({ text: buf, sep: sep }); sep = ch; buf = ''; }
    else buf += ch;
  }
  out.push({ text: buf, sep: sep });
  return out;
}

function isAssignmentToken(tok) {
  const eq = tok.indexOf('=');
  if (eq <= 0) return false;
  for (let i = 0; i < eq; i++) {
    const c = tok[i];
    const ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
    if (!ok) return false;
  }
  return true;
}

function makeArg(tok) {
  return { raw: tok, decoded: tok, quote: 'none', expansion_refs: [], unresolved_variables: [] };
}

// contract conventions.heredoc_segments: "the gate reads redirects from every
// segment including parse_status unsupported:heredoc (parser amendment 7 fills
// them from the first line), so a heredoc write opens a pending and yields a
// receipt; a heredoc segment is counted as an unsupported informational row
// (gate A/A) and never judged for A/B". A function definition body is one
// unsupported:function-def segment (contract A31).
function isUnsupportedStatus(seg) {
  return typeof seg.parse_status === 'string' && seg.parse_status.indexOf('unsupported') === 0;
}

function realParse(text) {
  // A function definition swallows the whole command into one segment.
  if (text.indexOf('() {') >= 0 || text.indexOf('()  {') >= 0) {
    const seg = {
      exe: null, sub: null, kind: 'function-def', parse_status: 'unsupported:function-def',
      sep_before: 'start', args: [], redirects: [], status_refs: [], assignments: [],
      shell_option_changes: [], index: 0, pipeline_id: 0,
    };
    return { segments: [seg], parser_version: '1.2', unresolved_variables: [] };
  }
  const parts = splitTop(text);
  const segments = [];
  for (let i = 0; i < parts.length; i++) {
    const trimmed = parts[i].text.trim();
    const toks = trimmed.length ? trimmed.split(' ').filter(function (x) { return x.length > 0; }) : [];
    const seg = {
      exe: null, sub: null, kind: 'command', parse_status: 'ok', sep_before: parts[i].sep,
      args: [], redirects: [], status_refs: [], assignments: [], shell_option_changes: [],
      index: i,
    };
    let start = 0;
    if (toks.length && isAssignmentToken(toks[0])) {
      seg.kind = 'assignment';
      seg.assignments = [{ name: toks[0].slice(0, toks[0].indexOf('=')), raw_value: toks[0].slice(toks[0].indexOf('=') + 1), unresolved_variables: [] }];
      start = 0;
    } else if (toks.length) {
      seg.exe = toks[0];
      start = 1;
    }
    for (let j = start; j < toks.length; j++) {
      const tok = toks[j];
      if (REDIRECT_OPS.indexOf(tok) >= 0 && j + 1 < toks.length) {
        const target = toks[j + 1];
        seg.redirects.push({
          op: tok, fd: null, raw_target: target, target: makeArg(target),
          target_kind: target === '/dev/null' ? 'devnull' : 'file', order: seg.redirects.length,
        });
        j += 1;
        continue;
      }
      seg.args.push(makeArg(tok));
    }
    if (trimmed.indexOf('$?') >= 0) {
      seg.status_refs.push({ kind: '?', context: seg.kind === 'assignment' ? 'assignment-rhs' : 'arg', position: 0 });
    }
    // A heredoc segment keeps the redirects of its FIRST line (amendment 7)
    // but is never judged for A or B.
    if (trimmed.indexOf('<<') >= 0) seg.parse_status = 'unsupported:heredoc';
    if (seg.exe === 'set') {
      for (let j = 0; j < seg.args.length; j++) {
        if (seg.args[j].decoded === 'pipefail' || seg.args[j].decoded.indexOf('pipefail') >= 0) seg.shell_option_changes.push('pipefail');
      }
    }
    segments.push(seg);
  }
  for (let i = 0; i < segments.length; i++) {
    segments[i].pipeline_id = (i === 0 || segments[i].sep_before !== '|')
      ? i : segments[i - 1].pipeline_id;
  }
  return { segments: segments, parser_version: '1.2', unresolved_variables: [] };
}

// ------------------------------------------------------------- judging ---
// One scan shared by the gate's own judge and by the gate's gate_instance_id
// derivation, so the instance ids exist even when judge itself is injected.
function argTexts(seg) {
  const out = [];
  const args = seg.args || [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string') out.push(a);
    else if (a && typeof a === 'object') out.push(a.decoded !== undefined ? a.decoded : a.raw);
  }
  return out;
}
function hasStatusRef(seg) { return Array.isArray(seg.status_refs) && seg.status_refs.length > 0; }
function groupsOf(segs) {
  const groups = [];
  let cur = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (cur === null || s.sep_before !== '|') { cur = { members: [], indexes: [] }; groups.push(cur); }
    cur.members.push(s);
    cur.indexes.push(s.index !== undefined ? s.index : i);
  }
  return groups;
}
// brief section 3, gate D: "file operand = args 经 head/tail 选项表消费后剩余的
// 非 \`-\` token(选项表:-n N/-nN/--lines=N、-c N/--bytes=N、旧式 -N、
// -q/-v/-z/-f/-F、--;\`-\` 或无 operand ⇒ 不判)". The 0-based index of an
// operand in THIS list is the operand_index component of a D row's
// gate_instance_id (contract v2.9 conventions.impression_id), so the list
// must be built before filtering by existence -- otherwise a missing first
// operand would renumber the second one.
const OPTS_TAKING_A_VALUE = ['-n', '-c'];
function fileOperands(seg) {
  const texts = argTexts(seg);
  const out = [];
  let afterDashDash = false;
  for (let i = 0; i < texts.length; i++) {
    const a = texts[i];
    if (!afterDashDash && a && a[0] === '-' && a !== '-') {
      if (a === '--') { afterDashDash = true; continue; }
      if (OPTS_TAKING_A_VALUE.indexOf(a) >= 0) { i += 1; continue; }
      continue; // -n3, -c10, --lines=N, --bytes=N, -6, -q/-v/-z/-f/-F, anything else
    }
    if (a === '-') return null; // reads stdin -> not judged at all
    out.push(a);
  }
  return out;
}
function isExistingFile(p) {
  if (!p || (p.indexOf('/') < 0 && p.indexOf('\\\\') < 0)) return false;
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

// brief section 3, gate D: confidence is \`recurrence\` only when the receipt log
// holds a record for the same (session, agent), the same normalized path, a
// class in {created-nonempty, replaced-changed, appended-grown} and an age
// inside the TTL; otherwise \`recurrence-candidate\`. Anything else -- including
// an \`unchanged\` receipt, which is what a byte-identical rewrite produces --
// stays a candidate.
const RECEIPT_RECURRENCE_CLASSES = ['created-nonempty', 'replaced-changed', 'appended-grown'];
const RECEIPT_TTL_MS = 3600 * 1000;
function normalizePathForReceipt(p) { return String(p).replace(/\\\\/g, '/').toLowerCase(); }
function receiptSaysRecurrence(target) {
  let text = null;
  try { text = fs.readFileSync(receiptsFilePath(), 'utf8'); } catch (e) { return false; }
  const want = normalizePathForReceipt(target);
  const lines = String(text).split('\\n').filter(function (l) { return l.length > 0; });
  for (let i = lines.length - 1; i >= 0; i--) {
    const f = lines[i].split('\\t');
    if (f.length < 4) continue; // torn line: skip, never abort
    const ts = Date.parse(f[0]);
    if (!ts) continue;
    if (normalizePathForReceipt(f[2]) !== want) continue;
    if (RECEIPT_RECURRENCE_CLASSES.indexOf(f[1]) < 0) return false;
    return (Date.now() - ts) >= 0 && (Date.now() - ts) < RECEIPT_TTL_MS;
  }
  return false;
}
// contract v2.9 conventions.impression_id pins gate_instance_id per gate kind:
//   A rows = <pipeline_id>:<pipeline_id>   (the judged PIPELINE, identified by
//                                           its first segment index)
//   B rows = <pipeline_id>:<segment_index> (the judged SEGMENT)
//   D rows = <pipeline_id>:<segment_index>:<operand_index>
// pipeline_id is empty for a segment that is not part of a pipeline (D17 is
// one segment, so its pipeline_id is null). The pinned consequences this
// encodes: a segment may yield BOTH a B row and its pipeline's A row with
// different impression_ids (A12 -- so the A branch must NOT skip the B scan),
// and several file operands of one segment yield one D row each (D17).
function scanUnits(parsed) {
  const segs = (parsed && parsed.segments) || [];
  const groups = groupsOf(segs);
  let pipefail = false;
  for (let i = 0; i < segs.length; i++) {
    const so = segs[i].shell_option_changes;
    if (Array.isArray(so) && so.indexOf('pipefail') >= 0) pipefail = true;
    if (segs[i].exe === 'set' && argTexts(segs[i]).indexOf('pipefail') >= 0) pipefail = true;
  }
  const units = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const isPipeline = g.members.length > 1;
    const pid = isPipeline ? String(g.indexes[0]) : '';
    if (g.members.some(isUnsupportedStatus)) continue; // never judged for A/B/D
    // gate A: one per PIPELINE whose next statement references $?.
    if (isPipeline && !pipefail) {
      const next = groups[i + 1];
      let nextHasStatus = false;
      if (next) for (let k = 0; k < next.members.length; k++) if (hasStatusRef(next.members[k])) nextHasStatus = true;
      if (nextHasStatus) units.push({ finding: { gate: 'A', confidence: 'recurrence' }, instance: pid + ':' + pid });
    }
    // gates B and D are per SEGMENT and independent of the A verdict.
    for (let m = 0; m < g.members.length; m++) {
      const s = g.members[m];
      const si = String(g.indexes[m]);
      if (B_EXES.indexOf(s.exe) >= 0 && B_SEPARATORS.indexOf(s.sep_before) >= 0) {
        units.push({ finding: { gate: 'B', confidence: 'recurrence' }, instance: pid + ':' + si });
      }
      if (D_EXES.indexOf(s.exe) >= 0) {
        const operands = fileOperands(s);
        if (operands) {
          for (let oi = 0; oi < operands.length; oi++) {
            if (!isExistingFile(operands[oi])) continue;
            const conf = receiptSaysRecurrence(operands[oi]) ? 'recurrence' : 'recurrence-candidate';
            units.push({ finding: { gate: 'D', confidence: conf }, instance: pid + ':' + si + ':' + String(oi) });
          }
        }
      }
    }
  }
  return units;
}
function realJudge(parsed) {
  const units = scanUnits(parsed);
  const gates = [];
  for (let i = 0; i < units.length; i++) gates.push(units[i].finding);
  const events = [];
  const segs = (parsed && parsed.segments) || [];
  if (segs.some(isUnsupportedStatus)) events.push('unsupported');
  return { gates: gates, events: events };
}
// conventions.policy_file (M-SPEC B3): policy.json maps class_tag ->
// {mode: shadow|randomized}; missing file or key => shadow;
// assignment(full_session_id, class_tag) = randomized ? (first byte of
// sha256(session||NUL||class_tag) even ? intervene : shadow) : shadow.
// v2.19 gate_row_class_tag: all three gates implement ONE lesson, so every
// gate row and every informational row this gate writes carries this tag.
const STUB_CLASS_TAG = 'process:pipe-hides-exit-code-and-truncates-evidence';
function classTagForGate(gate) { return gate ? STUB_CLASS_TAG : STUB_CLASS_TAG; }
// v2.20 run_provenance_policy: the CLASS policy state, never the arm --
// absent (no file) | corrupt (unparseable) | shadow (no key, or mode shadow)
// | randomized | shadow-gate (this gate has not cleared M1).
function policyStateFor(classTag) {
  if (!root || !classTag) return { state: 'absent', entry: null };
  let text = null;
  // v2.23: only ENOENT is 'absent'. A directory at that path (EISDIR, P06),
  // or any other read failure, is a CORRUPT policy -- shadow everything and
  // say policy:corrupt.
  try { text = fs.readFileSync(path.join(root, 'policy.json'), 'utf8'); }
  catch (e) { return { state: (e && e.code === 'ENOENT') ? 'absent' : 'corrupt', entry: null }; }
  let policy = null;
  try { policy = JSON.parse(text); } catch (e) { return { state: 'corrupt', entry: null }; }
  const entry = (policy && policy[classTag]) || null;
  if (!entry) return { state: 'shadow', entry: null };
  return { state: entry.mode === 'randomized' ? 'randomized' : 'shadow', entry: entry };
}
function policyEntryFor(classTag) { return policyStateFor(classTag).entry; }
function policyModeFor(classTag) {
  const st = policyStateFor(classTag).state;
  return st === 'randomized' ? 'randomized' : 'shadow';
}
// a gate whose own precision has not cleared M1 stays shadow even inside an
// intervene session (policy_file, v2.19)
function gateModeFor(classTag, gate) {
  const entry = policyEntryFor(classTag);
  const gates = entry && entry.gates;
  return gates && gates[gate] === 'randomized' ? 'randomized' : 'shadow';
}
function realAssignment(fullSessionId, classTag) {
  if (policyModeFor(classTag) !== 'randomized') return 'shadow';
  const first = crypto.createHash('sha256').update(String(fullSessionId) + '\\0' + String(classTag), 'utf8').digest()[0];
  return (first % 2 === 0) ? 'intervene' : 'shadow';
}

// ------------------------------------------------------- pending layer ---
function pendingKeyPath() {
  const key = sha256hex(String(sessionId) + '\\0' + String(agentId) + '\\0' + String(toolUseId));
  return path.join(root, 'pending', key + '.json');
}
function receiptsFilePath() {
  return path.join(root, 'receipts-' + sha16(sessionId) + '-' + sha16(agentId) + '.log');
}
function readPendingWithRetry(p) {
  for (let attempt = 0; attempt < 40; attempt++) {
    let text = null;
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { text = null; }
    if (text && text.length) {
      try { return JSON.parse(text); } catch (e) { /* torn or corrupt */ }
    }
    sleepMs(5);
  }
  return null;
}
function redirectTargetOf(parsed) {
  const segs = (parsed && parsed.segments) || [];
  let last = null;
  for (let i = 0; i < segs.length; i++) {
    const reds = segs[i].redirects || [];
    for (let j = 0; j < reds.length; j++) {
      const r = reds[j];
      const tgt = r && r.target;
      if (typeof tgt === 'string') last = tgt;
      else if (tgt && typeof tgt === 'object') last = tgt.decoded !== undefined ? tgt.decoded : tgt.raw;
      else if (r && r.raw_target) last = r.raw_target;
    }
  }
  return last;
}

// ------------------------------------------------------------- ledger ----
const COLUMNS = ['schema_version', 'ts', 'sid_sha16', 'agent_sha16', 'agent_type', 'prompt_id', 'tool_use_id', 'impression_id', 'event_id', 'event_kind', 'gate', 'confidence', 'class_tag', 'trigger_or_gate_id', 'cmd_sha16', 'parser_version', 'mode', 'run_provenance', 'sanitized', 'id_missing', 'agent_id_missing'];

const parsed = (parseFn || realParse)(cmd, { tool: 'Bash' });
const judgement = hookEvent === 'PostToolUse'
  ? { gates: [], events: [] }
  : ((judge || realJudge)(parsed, { cmdRaw: cmd }) || { gates: [], events: [] });
const findings = Array.isArray(judgement.gates) ? judgement.gates : [];
const judgeEvents = Array.isArray(judgement.events) ? judgement.events : [];
const instances = [];
{
  const units = scanUnits(parsed);
  for (let i = 0; i < units.length; i++) instances.push(units[i].instance);
}

const rows = [];
const baseRow = {
  schema_version: 1,
  sid_sha16: sessionId ? sha16(sessionId) : '',
  agent_sha16: agentId ? sha16(agentId) : '',
  agent_type: data.agent_type || 'worker',
  prompt_id: data.prompt_id || '',
  tool_use_id: toolUseId,
  trigger_or_gate_id: '',
  cmd_sha16: sha16(cmd),
  parser_version: (parsed && parsed.parser_version) || '1.2',
  run_provenance: 'test',
  sanitized: '0',
  id_missing: sessionId ? '0' : '1',
  agent_id_missing: agentId ? '0' : '1',
};
function pushRow(extra) {
  const r = {};
  for (const k in baseRow) r[k] = baseRow[k];
  r.ts = new Date().toISOString();
  for (const k in extra) r[k] = extra[k];
  rows.push(r);
}
function impressionFor(instance) {
  return sha256hex(String(sessionId) + '\\0' + String(agentId) + '\\0' + String(toolUseId) + '\\0' + '' + '\\0' + String(instance)).slice(0, 16);
}
// conventions.ordinal (v2.9): "the ordinalisation of H(gate_id ||
// gate_instance_id || event_kind) ... gate_instance_id replaces the former
// pipeline_id || segment_index so that operand-level D rows and
// pipeline-level A rows never collide"; never a process-local counter. The
// stub uses the gate letter as gate_id (it writes no trigger_or_gate_id).
function ordinalFor(gateId, instance, kind) {
  return sha16(String(gateId) + '\\0' + String(instance) + '\\0' + String(kind));
}
function eventIdFor(impression, gateId, instance, kind) {
  return sha16(String(impression) + '\\0' + String(kind) + '\\0' + ordinalFor(gateId, instance, kind));
}
// conventions.gate_disposition_map: B is shadow-only (one would-warn); a D
// candidate writes ONE row whose event_kind is recurrence-candidate (NOT
// would-warn); a recurrence finding writes would-warn, plus emitted (or
// emit-failed) under intervene.
function dispositionKindsFor(finding, mode) {
  if (finding.gate === 'B') return ['would-warn'];
  if (finding.confidence === 'recurrence-candidate') return ['recurrence-candidate'];
  if (mode === 'intervene') return ['would-warn', 'EMIT'];
  return ['would-warn'];
}
// conventions.informational_row_attribution (v2.14): unsupported -> A/A, the
// rest of the informational family -> D/D; session-end keeps both columns
// empty. The stub writes them so the runner's assertion has something true to
// find -- this is the self-check's reference gate, not the production one.
const INFORMATIONAL_ATTRIBUTION = {
  unsupported: 'A', path_unresolved: 'D', 'cd-hint': 'D',
  'pending-conflict': 'D', 'pending-corrupt': 'D', 'pending-expired': 'D', 'receipt-lost': 'D',
};
function pushInformational(kind) {
  const g = INFORMATIONAL_ATTRIBUTION[kind] || '';
  pushRow({
    impression_id: '', event_id: sha16(String(toolUseId) + '\\0' + kind), event_kind: kind,
    gate: g, confidence: '', class_tag: STUB_CLASS_TAG, trigger_or_gate_id: g, mode: 'shadow',
  });
}
// conventions.row_attribution (v2.15/v2.18): a receipt-lost / pending-expired
// row carries the identity of the ORIGINAL pending -- sid_sha16, agent_sha16,
// agent_type, prompt_id and tool_use_id -- never the identity of the event
// whose GC found it, which may be a different session entirely (L23).
function pushInformationalForPending(kind, rec) {
  const g = INFORMATIONAL_ATTRIBUTION[kind] || '';
  const owner = rec || {};
  pushRow({
    impression_id: '', event_kind: kind, gate: g, confidence: '', class_tag: STUB_CLASS_TAG,
    trigger_or_gate_id: g, mode: 'shadow',
    tool_use_id: owner.tool_use_id || toolUseId,
    sid_sha16: owner.sid_sha16 === undefined ? baseRow.sid_sha16 : owner.sid_sha16,
    agent_sha16: owner.agent_sha16 === undefined ? baseRow.agent_sha16 : owner.agent_sha16,
    agent_type: owner.agent_type || 'worker',
    prompt_id: owner.prompt_id === undefined ? '' : owner.prompt_id,
    event_id: sha16(String(owner.tool_use_id || toolUseId) + '\\0' + kind),
  });
}

const informational = [];
if (root) {
  try { fs.mkdirSync(path.join(root, 'pending'), { recursive: true }); } catch (e) { /* best effort */ }
  const keyPath = pendingKeyPath();
  if (hookEvent === 'PostToolUse') {
    if (fs.existsSync(keyPath)) {
      // conventions.receipt_commit_and_lease: claim by renaming to
      // <key>.json.processing.<claim-ts>-<pid>, retrying like Pre; on
      // persistent failure (a share-none handle, L22) read the pending IN
      // PLACE; and delete the lease ONLY after the receipt line is appended.
      let claimed = null;
      const leaseName = keyPath + '.processing.p' + process.pid + '-' + Date.now() + '-' +
        crypto.randomBytes(3).toString('hex');
      for (let attempt = 0; attempt < 60 && !claimed; attempt++) {
        try { fs.renameSync(keyPath, leaseName); claimed = leaseName; }
        catch (e) { sleepMs(5); }
      }
      const readFrom = claimed || keyPath;
      const rec = readPendingWithRetry(readFrom);
      if (rec === null) { informational.push('pending-corrupt'); try { fs.unlinkSync(readFrom); } catch (e) {} }
      else {
        // Post diff: classify what happened to the snapshotted target.
        let nowSize = -1, nowSha = '';
        try { const st = fs.statSync(rec.path); nowSize = st.size; nowSha = sha16(fs.readFileSync(rec.path)); }
        catch (e) { nowSize = -1; }
        let cls = 'unchanged';
        if (nowSize < 0) cls = 'missing';
        else if (!rec.existed) cls = nowSize > 0 ? 'created-nonempty' : 'created-empty';
        else if (nowSize > (rec.size || 0)) cls = 'appended-grown';
        else if (nowSize === (rec.size || 0) && nowSha !== (rec.sha || '')) cls = 'replaced-changed';
        const line = [new Date().toISOString(), cls, String(rec.path || ''), toolUseId, '0'].join('\\t') + '\\n';
        let appended = false;
        try { fs.appendFileSync(receiptsFilePath(), line, 'utf8'); appended = true; } catch (e) { appended = false; }
        // The lease is the retry ticket: if the receipt could not be written,
        // KEEP it (L21). Only a successful append may retire it.
        if (appended) { try { fs.unlinkSync(readFrom); } catch (e) {} }
      }
    }
  } else {
    // conventions.receipt_commit_and_lease + row_attribution: a lease older
    // than the TTL whose owning pid is gone is garbage-collected into a
    // receipt-lost row that carries the ORIGINAL pending's identity. Lease age
    // comes from the claim timestamp embedded in the NAME, never the mtime
    // (a Windows rename keeps the pending mtime).
    try {
      const pendingDir = path.join(root, 'pending');
      const entries = fs.readdirSync(pendingDir);
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i];
        const at = name.indexOf('.json.processing.');
        if (at < 0) continue;
        const full = path.join(pendingDir, name);
        const m = /.processing.p(d+)-(d+)-/.exec(name);
        if (m) {
          const ownerPid = parseInt(m[1], 10);
          let alive = false;
          try { process.kill(ownerPid, 0); alive = true; } catch (e) { alive = !!(e && e.code === 'EPERM'); }
          if (alive) continue; // the owner is still running -- never reap
        }
        let ageMs = 0;
        if (m) ageMs = Date.now() - parseInt(m[2], 10);
        else { try { ageMs = Date.now() - fs.statSync(full).mtimeMs; } catch (e) { ageMs = 0; } }
        if (ageMs < RECEIPT_TTL_MS) continue;
        let rec = null;
        try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { rec = null; }
        pushInformationalForPending('receipt-lost', rec || {});
        try { fs.unlinkSync(full); } catch (e) {}
      }
    } catch (e) { /* no pending dir yet */ }
    const target = redirectTargetOf(parsed);
    if (target) {
      // brief section 11.4: same key already present -> compare payload;
      // identical -> idempotent skip (no event); different -> pending-conflict;
      // unreadable -> pending-corrupt. L15b races this Pre against a Post that
      // is CONSUMING the same key, so "the key vanished between our failed
      // create and our read" is a legitimate interleaving, not corruption --
      // it must retry the create, or an idempotent re-entry would be reported
      // as pending-corrupt purely because it lost a race.
      // The pending carries a snapshot of the target so the Post can classify
      // what the command actually did, and the creating event's identity so a
      // receipt-lost row can copy it (contract row_attribution v2.15).
      let existed = false, prevSize = 0, prevSha = '';
      try {
        const st = fs.statSync(target);
        existed = st.isFile();
        prevSize = st.size;
        prevSha = sha16(fs.readFileSync(target));
      } catch (e) { existed = false; }
      const payload = JSON.stringify({
        cmd: cmd, path: target, existed: existed, size: prevSize, sha: prevSha,
        sid_sha16: sessionId ? sha16(sessionId) : '', agent_sha16: agentId ? sha16(agentId) : '',
        agent_type: data.agent_type || 'worker', prompt_id: data.prompt_id || '',
        tool_use_id: toolUseId, claimed_at: new Date().toISOString(),
      });
      for (let attempt = 0; attempt < 60; attempt++) {
        let created = false;
        try {
          const fd = fs.openSync(keyPath, 'wx');
          try { fs.writeSync(fd, payload); } finally { fs.closeSync(fd); }
          created = true;
        } catch (e) { created = false; }
        if (created) break;
        let text = null, missing = false;
        try { text = fs.readFileSync(keyPath, 'utf8'); } catch (e) { missing = true; }
        if (missing) { sleepMs(5); continue; }        // consumed under us -> retry create
        if (!text.length) { sleepMs(5); continue; }   // create landed, payload not yet written
        let prev = null;
        try { prev = JSON.parse(text); } catch (e) { prev = null; }
        if (prev === null) { informational.push('pending-corrupt'); break; }
        if (prev.cmd !== cmd) { informational.push('pending-conflict'); break; }
        break;                                        // identical payload -> idempotent skip
      }
    }
  }
}

for (let i = 0; i < findings.length; i++) {
  const f = findings[i] || {};
  const instance = instances[i] !== undefined ? instances[i] : (instances[0] !== undefined ? instances[0] : '');
  const impression = impressionFor(instance);
  // A finding's class tag is its gate's class unless the injected judge
  // supplied one (the always mutant's nonce).
  const classTag = f.class_tag || classTagForGate(f.gate);
  const policyMode = policyModeFor(classTag);
  const sessionArm = (assignmentFn || realAssignment)(sessionId, classTag);
  // one arm per (session, class), but a gate that has not cleared M1 stays
  // shadow inside it: mode=shadow, run_provenance=policy:shadow-gate.
  const gateShadowed = policyMode === 'randomized' && sessionArm === 'intervene' &&
    gateModeFor(classTag, f.gate) !== 'randomized';
  const assignmentMode = gateShadowed ? 'shadow' : sessionArm;
  const provenance = gateShadowed ? 'policy:shadow-gate' : 'policy:' + policyStateFor(classTag).state;
  const kinds = dispositionKindsFor(f, assignmentMode);
  for (let k = 0; k < kinds.length; k++) {
    let kind = kinds[k];
    let rowMode = 'shadow';
    if (kind === 'EMIT') {
      let emitted = true;
      try { fs.writeSync(1, '[stub gate finding: ' + f.gate + '/' + f.confidence + ']\\n'); }
      catch (e) { emitted = false; }
      kind = emitted ? 'emitted' : 'emit-failed';
      rowMode = 'intervene';
    }
    pushRow({
      impression_id: impression, event_id: eventIdFor(impression, f.gate, instance, kind),
      event_kind: kind, gate: f.gate, confidence: f.confidence, class_tag: classTag,
      // "the ledger mode column records the effective arm for that row"
      // (conventions.policy_file, v2.19)
      mode: assignmentMode, run_provenance: provenance,
    });
  }
}
for (let i = 0; i < judgeEvents.length; i++) pushInformational(judgeEvents[i]);
for (let i = 0; i < informational.length; i++) pushInformational(informational[i]);

if (root && rows.length) {
  try {
    fs.mkdirSync(root, { recursive: true });
    const hostFile = path.join(root, 'events-v3-' + os.hostname() + '.tsv');
    let out = '';
    if (!fs.existsSync(hostFile)) out += COLUMNS.join('\\t') + '\\n';
    for (let i = 0; i < rows.length; i++) {
      const vals = [];
      for (let c = 0; c < COLUMNS.length; c++) {
        const v = rows[i][COLUMNS[c]];
        vals.push(v === undefined || v === null ? '' : String(v));
      }
      out += vals.join('\\t') + '\\n';
    }
    fs.appendFileSync(hostFile, out);
  } catch (e) { /* best effort */ }
}
process.exit(0);
`;
  // v2.24 part11: the ONLY difference from the reference stub is a preamble
  // that dies for one call kind, so "the concurrent children are counted"
  // can be staged without changing anything else about the gate under test.
  const body = dieKind
    ? cjsBody.replace("'use strict';", "'use strict';\nif (process.env.PIPE_GATE_RUNNER_CALL_KIND === " + JSON.stringify(dieKind) + ") process.exit(9);")
    : cjsBody;
  fs.writeFileSync(cjsPath, body, 'utf8');
  fs.writeFileSync(shPath, '#!/usr/bin/env bash\ncommand -v node >/dev/null 2>&1 || exit 0\nexec node "' + cjsPath.replace(/\\/g, '/') + '"\n', 'utf8');
  return { cjsPath, shPath };
}

function generateNoSeamStubGate(dir) {
  mkdirp(dir);
  const cjsPath = path.join(dir, 'stub-gate-noseam.cjs');
  const shPath = path.join(dir, 'stub-gate-noseam.sh');
  const cjsBody = `'use strict';
const fs = require('fs');
function miss() { process.exit(0); }
process.on('uncaughtException', miss);
let raw;
try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { miss(); }
if (!raw || raw.trim() === '') miss();
let data;
try { data = JSON.parse(raw); } catch (e) { miss(); }
process.exit(0);
`;
  fs.writeFileSync(cjsPath, cjsBody, 'utf8');
  fs.writeFileSync(shPath, '#!/usr/bin/env bash\ncommand -v node >/dev/null 2>&1 || exit 0\nexec node "' + cjsPath.replace(/\\/g, '/') + '"\n', 'utf8');
  return { cjsPath, shPath };
}

// MEDIUM-10 (Opus r6): "七段全绿" carried no information about the four
// HIGHs of that round, because L09 / L15 / L15b / L20 / L10-under-blind /
// A29-under-always were all OUTSIDE the six cases the self-check ran. The
// subset now contains one case per structural mechanism the runner owns:
// A29 (two impressions from one judge call), L09 (closed-stdout routing),
// L10/L11 (row-count aggregation), L15 (concurrent same-key pending), L15b
// (Pre/Post interleave, receipt + pending consumption), L20 (pending
// conflict on a re-used key). Anything that can be red for a CORRECT gate
// must be reachable from here, or this self-check cannot see that class of
// defect at all.
// D17 and A12 are the round-7 HIGH-1/HIGH-3 cases: two file operands in ONE
// segment (two D rows that must land on different impressions) and one segment
// that is simultaneously gate B and the last segment of the gate-A pipeline
// (two findings that must land on different impressions instead of colliding
// into a conflict). Neither was reachable from the old subset.
// A31 is the fab-attack function-definition case: one unsupported segment, no
// false A from the pipeline inside the body.
// P03 is the M3 policy case: the same session twice must land on the same arm
// and a session with the other sha256 parity on the other arm.
const SELF_CHECK_CASE_IDS = ['A01', 'A08', 'B01', 'D01', 'A29', 'D17', 'A12', 'A31', 'P03'];
// L12/L14 run FIRST, in a files dir nothing has touched yet: that is the
// only order in which MEDIUM-4 is observable -- their declared files must
// be materialized by execLifecycleCase itself rather than by an earlier
// case's side effect, and 'touch mtime only' must NOT create the file it
// is supposed to only touch. Run them last and the subset's own residue
// hides the defect, which is exactly how it survived five rounds.
// H01 is the heredoc-write case: the first line's redirect must open a pending,
// the Post must classify it, and the read-back must come out D/recurrence --
// the whole receipt chain in one case.
// L21 (receipts unwritable -> lease kept) and L23 (cross-session GC identity)
// are the two v2.18 lifecycle mechanisms the runner itself owns.
const SELF_CHECK_LIFECYCLE_IDS = ['L12', 'L14', 'L09', 'L10', 'L11', 'L15', 'L15b', 'L20', 'H01', 'L21', 'L23'];
// L09 is in the mutant subset too: with the v2.8 recipe its emit genuinely
// fails, so under always it is GREEN/GREEN (one A finding, emit fails,
// events ["emit-failed"], stdout 0 -- exactly what mutants.derivation v2.8
// says must NOT be derived red) and under blind-parser RED/RED (no
// status_refs -> no A finding -> no rows at all). It is dropped from the
// subset if the closed-stdout preflight fails on this host.
// L11 joins per contract mutants.derivation's v2.9 ruling: the always clause
// recomputes the row-count keys, and L11 (4/2/2/1 from two identical intervene
// re-entries) is the case that measures the recomputation rather than assuming
// it coincides with "unchanged".
const SELF_CHECK_MUTANT_LIFECYCLE_IDS = ['L09', 'L10', 'L11'];

function selfCheckSubset(contract) {
  return contract.cases.filter((c) => SELF_CHECK_CASE_IDS.includes(c.id));
}

function selfCheckLifecycleSubset(contract, ids) {
  return ids.map((id) => contract.lifecycle_cases.find((c) => c.id === id)).filter(Boolean);
}

// Opus r6 lesson 4: every expect key the contract actually uses must be
// declared in MUTANT_TRANSFORM_KEY_COVERAGE, i.e. somebody had to decide,
// in writing, what each of the three transforms does with it. A key that
// appears in the contract and nowhere in that table is exactly how
// transformForBlindParser came to ignore the row-count keys.
function checkMutantTransformKeyCoverage(contract) {
  const seen = new Set();
  for (const c of [...contract.cases, ...contract.lifecycle_cases]) {
    for (const k of Object.keys(c.expect || {})) seen.add(k);
  }
  const missing = [...seen].filter((k) => !Object.prototype.hasOwnProperty.call(MUTANT_TRANSFORM_KEY_COVERAGE, k)).sort();
  return {
    pass: missing.length === 0,
    expect_keys_in_contract: [...seen].sort(),
    undeclared_keys: missing,
    reason: missing.length === 0 ? 'ok' : 'expect key(s) with no declared mutant-transform behavior: ' + missing.join(', '),
  };
}

// conventions.lifecycle_expect_keys.note (v2.9): the known-key set is built
// from BOTH sources -- the keys this contract actually uses, and the keys that
// table names -- and any of them the runner does not evaluate is red. This is
// the gate that makes an expect key impossible to add without an
// implementation (Z08's files_created_glob got in that way and was carried for
// four rounds by a coincidence).
function checkExpectKeyEvaluationCoverage(contract) {
  const families = [
    { name: 'cases', cases: contract.cases || [], evaluated: NORMAL_EVALUATED_EXPECT_KEYS },
    { name: 'lifecycle_cases', cases: contract.lifecycle_cases || [], evaluated: LIFECYCLE_EVALUATED_EXPECT_KEYS },
    { name: 'silence_cases', cases: contract.silence_cases || [], evaluated: SILENCE_EVALUATED_EXPECT_KEYS },
  ];
  const detail = {};
  let pass = true;
  for (const fam of families) {
    const used = new Set();
    for (const c of fam.cases) for (const k of Object.keys(c.expect || {})) used.add(k);
    const unevaluated = [...used]
      .filter((k) => !fam.evaluated.has(k) && !DOCUMENTATION_ONLY_EXPECT_KEYS.has(k)).sort();
    const documentationOnly = [...used].filter((k) => DOCUMENTATION_ONLY_EXPECT_KEYS.has(k)).sort();
    if (unevaluated.length) pass = false;
    detail[fam.name] = {
      used_keys: [...used].sort(), unevaluated_keys: unevaluated, documentation_only_keys: documentationOnly,
    };
  }
  // The table's own keys must be implemented even before a case uses them.
  const tableKeys = Object.keys((contract.conventions || {}).lifecycle_expect_keys || {})
    .filter((k) => k !== 'note');
  const tableUnevaluated = tableKeys.filter((k) => !LIFECYCLE_EVALUATED_EXPECT_KEYS.has(k)).sort();
  if (tableUnevaluated.length) pass = false;
  detail.lifecycle_expect_keys_table = { keys: tableKeys, unevaluated_keys: tableUnevaluated };
  return {
    pass, detail,
    reason: pass ? 'ok (every expect key the contract uses or names is evaluated by this runner)'
      : 'expect key(s) the runner does not evaluate: ' + JSON.stringify(detail),
  };
}

// One mutant round over the self-check subset against the stub gate. Mirrors
// runMutantRound's scoring (derived vs actual failing ids, per-case sentinel
// on rows filtered to that case's tool_use_id, probe growth) on a set small
// enough to run in a few seconds.
async function runSelfCheckMutantRound(opts) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const ctx = makeCtx({
    gate: opts.gate, root: opts.root, mutant: opts.mutant,
    nonce, conventions: opts.conventions,
  });
  const perCase = [];
  for (const tc of opts.cases) {
    const before = probeLineCount(ctx.stateDir);
    const result = tc.steps ? await execLifecycleCase(tc, ctx)
      : (isPolicyCaseMode(tc.mode) ? execPolicyRandomizedCase(tc, ctx) : execNormalCase(tc, ctx));
    const after = probeLineCount(ctx.stateDir);
    const derivedFail = DERIVERS[opts.mutant](tc);
    const { rows } = readLedgerRows(ctx.stateDir);
    const caseToolUseId = result.actual && result.actual.tool_use_id;
    const caseRows = caseToolUseId ? rows.filter((r) => r.tool_use_id === caseToolUseId) : [];
    const sentinel = sentinelPresent(opts.mutant, nonce, caseRows, caseExpectsGateRowsUnderMutant(tc, opts.mutant));
    perCase.push({
      id: tc.id, actual_pass: result.pass, derived_fail: derivedFail,
      probe_grew: after > before, probe_exempt: caseExemptFromProbeRule(tc),
      sentinel, reason: result.reason,
    });
  }
  const setsEqual = perCase.every((p) => (!p.actual_pass) === p.derived_fail);
  const sentinelOk = opts.mutant === 'null' ? true
    : perCase.every((p) => !p.sentinel.checked || p.sentinel.present);
  const probeOk = perCase.every((p) => p.probe_grew || p.probe_exempt);
  return {
    mutant: opts.mutant, nonce, sets_equal: setsEqual, sentinel_ok: sentinelOk, probe_ok: probeOk,
    derived_fail_ids: perCase.filter((p) => p.derived_fail).map((p) => p.id).sort(),
    actual_fail_ids: perCase.filter((p) => !p.actual_pass).map((p) => p.id).sort(),
    per_case: perCase,
  };
}

// v2.6 item 1: "任何推导/判定函数改动后必须 grep 同名定义只出现一次" made
// mechanical -- scans THIS FILE's own source for top-level `function NAME(`
// declarations (module.exports assignment can only ever bind the LAST one,
// per JS "later declaration wins" semantics, which is exactly the HIGH-1
// bug: a rewritten deriveBlindParserFail was silently shadowed by a stale
// duplicate). Any name appearing more than once is a hard self-check
// failure -- this is the actual guard against that class of regression
// recurring, not just documentation of the fix.
function scanForDuplicateTopLevelFunctionNames() {
  let text;
  try { text = fs.readFileSync(__filename, 'utf8'); } catch (e) { return { pass: false, reason: 'could not read own source: ' + e.message, duplicates: [] }; }
  // Strip backtick template literals first (e.g. the generated stub-gate
  // .cjs bodies embedded as strings) so a `function miss(` INSIDE a
  // generated-file template does not false-positive as a second real
  // top-level declaration of this module.
  text = text.replace(/`(?:\\.|[^`\\])*`/gs, '');
  // LOW-5 (Opus r6): `const NAME = function ...` / `const NAME = (...) =>`
  // binds a top-level name exactly like a function declaration does (and a
  // duplicate const binding is a hard TDZ/redeclaration error rather than a
  // silent shadow), so both forms are scanned. There is no such binding in
  // this file today; the point is that the guard is complete before one
  // appears.
  const counts = new Map();
  const patterns = [
    /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
    /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm,
  ];
  let m;
  for (const re of patterns) {
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([name, n]) => ({ name, count: n }));
  return { pass: duplicates.length === 0, duplicates, reason: duplicates.length === 0 ? 'ok' : duplicates.length + ' duplicate top-level function name(s)' };
}

// conventions.process_liveness (v2.23): "The self-check must contain a
// dead-DUT proof: with a stub that exits 9 immediately, every case that
// previously passed with empty expectations must now be red (part9)". The
// named survivors of the old runner were Bx08/Bx10/A08/A11/D11 -- a case
// whose whole expectation is "no gate rows, no stdout" is satisfied by a
// process that never ran.
// v2.24: part9 iterates EVERY case of every executed section instead of a
// fixed id list. The ledger section is reported separately: no ledger check
// performs a Bash-gate hook invocation (G11 runs the trigger script, P05 the
// precision tool, G05 the wiring argv), so "red for liveness" has nothing to
// attach to there -- said by name rather than silently skipped.
function part9Sections(contract) {
  return [
    { name: 'cases', cases: contract.cases || [] },
    { name: 'lifecycle_cases', cases: contract.lifecycle_cases || [] },
    { name: 'silence_cases', cases: contract.silence_cases || [] },
  ];
}
function generateDeadStubGate(dir) {
  mkdirp(dir);
  const cjsPath = path.join(dir, 'stub-gate-dead.cjs');
  const shPath = path.join(dir, 'stub-gate-dead.sh');
  fs.writeFileSync(cjsPath, "'use strict';\n// dies before reading stdin: the DUT is dead\nprocess.exit(9);\n", 'utf8');
  fs.writeFileSync(shPath, '#!/usr/bin/env bash\nexec node "' + cjsPath.replace(/\\/g, '/') + '"\n', 'utf8');
  return { cjsPath, shPath };
}
async function runDeadDutProof(contract, root, contractCasesById) {
  const { shPath } = generateDeadStubGate(path.join(root, 'deadstub'));
  const ctx9 = makeCtx({ gate: 'bash ' + shPath, root: path.join(root, 'part9'), mutant: 'none', conventions: contract.conventions });
  const results = [];
  for (const section of part9Sections(contract)) {
    for (const tc of section.cases) {
      let r;
      try {
        r = tc.steps ? await execLifecycleCase(tc, ctx9)
          : section.name === 'silence_cases' ? await execSilenceCase(tc, ctx9, contractCasesById)
            : (isPolicyCaseMode(tc.mode) ? execPolicyRandomizedCase(tc, ctx9) : execNormalCase(tc, ctx9));
      } catch (e) { r = { pass: false, reason: 'executor threw: ' + String(e && e.message || e) }; }
      const live = (r && r.actual && r.actual.process_liveness) || null;
      results.push({
        id: tc.id, section: section.name, report_only: !!(r && r.report_only),
        red: r.pass === false,
        liveness_red: !!(live && live.ok === false),
        liveness: live ? { steps: live.steps, invocations: live.invocations, ok: live.ok } : null,
        reason: r.reason,
      });
    }
  }
  const scored = results.filter((r) => !r.report_only);
  const notRed = scored.filter((r) => !r.red);
  const redButNotForLiveness = scored.filter((r) => r.red && !r.liveness_red);
  return {
    pass: scored.length > 0 && notRed.length === 0 && redButNotForLiveness.length === 0,
    gate: 'node stub-gate-dead.cjs (process.exit(9) before reading stdin)',
    sections: part9Sections(contract).map((s) => ({ name: s.name, cases: s.cases.length })),
    scored: scored.length,
    still_green: notRed.map((r) => r.id),
    red_but_not_for_liveness: redButNotForLiveness.map((r) => r.id),
    report_only_excluded: results.filter((r) => r.report_only).map((r) => r.id),
    ledger_section: 'not iterated: no ledger check performs a Bash-gate hook invocation (G11 runs the trigger script, P05 the precision tool, G05 the wiring argv), so a dead gate cannot make them red for liveness',
    sample: results.slice(0, 6),
  };
}
// The targeted half: only ONE kind of invocation dies. A stub that is the
// reference stub plus `if (PIPE_GATE_RUNNER_CALL_KIND === kind) exit(9)`
// proves the aggregate really counts the concurrent children, because the
// case that spawns them goes red while a purely sequential case stays green.
async function runTargetedLivenessProof(contract, root, stubDir) {
  const kind = 'concurrent';
  const { shPath } = generateStubGate(stubDir, { dieOnCallKind: kind });
  const ctx = makeCtx({ gate: 'bash ' + shPath, root: path.join(root, 'part11'), mutant: 'none', conventions: contract.conventions });
  const target = (contract.lifecycle_cases || []).find((c) => (c.steps || []).some((s) => /^pre x2 truly concurrent/.test(String(s))));
  const control = (contract.cases || []).find((c) => c.id === 'A01');
  if (!target || !control) return { pass: false, reason: 'no concurrent lifecycle case or no A01 in this contract' };
  const targetResult = await execLifecycleCase(target, ctx);
  const controlResult = execNormalCase(control, ctx);
  const tLive = (targetResult.actual && targetResult.actual.process_liveness) || {};
  const cLive = (controlResult.actual && controlResult.actual.process_liveness) || {};
  return {
    pass: targetResult.pass === false && tLive.ok === false && controlResult.pass === true && cLive.ok === true,
    killed_call_kind: kind,
    target: { id: target.id, pass: targetResult.pass, liveness: tLive, reason: targetResult.reason },
    control: { id: control.id, pass: controlResult.pass, liveness: cLive, reason: controlResult.reason },
    note: 'the control case makes only sequential calls, so the same stub must leave it green',
  };
}

// MEDIUM-H3 (Opus increment): normal and lifecycle cases share root/state,
// so a clock: step that ages every receipts-*.log in that directory makes
// the suite order-dependent -- one case's clock decides another case's TTL
// verdict. The scope fix is asserted here rather than trusted: a foreign
// receipts file is seeded next to the case's own, the case runs, and the
// foreign file must come back byte-identical while the case's own receipt
// really was aged.
async function runClockScopeProof(contract, root, gateSh) {
  const lifecycle = contract.lifecycle_cases || [];
  const tc = lifecycle.find((c) => c.id === 'Bx10') ||
    lifecycle.find((c) => (c.steps || []).some((s) => parseStepHeader(s).kind === 'clock'));
  if (!tc) return { pass: false, reason: 'no lifecycle case with a clock: step in this contract' };
  const ctx = makeCtx({ gate: 'bash ' + gateSh, root: path.join(root, 'part10'), mutant: 'none', conventions: contract.conventions });
  mkdirp(ctx.stateDir);
  const foreign = path.join(ctx.stateDir, 'receipts-' + sha16('part10-foreign-session') + '-' + sha16('part10-foreign-agent') + '.log');
  const foreignLine = [new Date().toISOString(), 'created-nonempty', path.join(ctx.filesDir, 'foreign.txt'), 'deadbeefdeadbeef', '0'].join('\t') + '\n';
  writeFileAtomicText(foreign, foreignLine);
  const before = readTextSafe(foreign);
  let result;
  try { result = await execLifecycleCase(tc, ctx); }
  catch (e) { return { pass: false, reason: 'executor threw: ' + String((e && e.message) || e) }; }
  const after = readTextSafe(foreign);
  const own = (result.actual && result.actual.clock_receipts) || {};
  const foreignUnchanged = after === before;
  const ownAged = (own.lines_rewritten || 0) >= 1;
  return {
    pass: foreignUnchanged && ownAged,
    case_id: tc.id,
    foreign_receipts_file: foreign,
    foreign_unchanged: foreignUnchanged,
    own_lines_rewritten: own.lines_rewritten || 0,
    own_files: own.files || [],
    case_verdict: { pass: result.pass, reason: result.reason },
    note: 'the case verdict itself is NOT what this segment asserts -- only that the clock aged this case receipts set and nothing else',
  };
}

// conventions.process_liveness v2.24 erratum 1: "every NON-hook tool
// invocation the runner performs in the ledger section asserts spawnError
// === null and the conventional exit code of that tool ... and a mismatch is
// a red of that case by name, never only a value in the actual payload; the
// self-check proves it with a stub that writes every expected row correctly
// and then exits 9 (G11 must be red)".
//
// The 'writes every row correctly' stub is the REAL tool with `exit 9` after
// it, so the rows are genuinely the ones the runner accepts and the only
// thing wrong is that the process died -- exactly the case that used to
// report {pass:true, rc:9}.
const PART12_MISSING_EXE = 'pgv2-no-such-binary-xyz';
function runLedgerToolAssertionProof(contract, root, gateSh) {
  const dir = path.join(root, 'part12');
  mkdirp(dir);
  const realScript = path.join(GUARDS_DIR, 'pmm-trigger-recall.sh');
  const wrapper = path.join(dir, 'trigger-then-die.sh');
  writeFileAtomicText(wrapper, '#!/usr/bin/env bash\nbash "' + realScript.replace(/\\/g, '/') + '"\nexit 9\n');
  const mkCtx = (name, overrides) => {
    const c = makeCtx({ gate: 'bash ' + gateSh, root: path.join(dir, name), mutant: 'none', conventions: contract.conventions });
    c.toolOverrides = overrides;
    return c;
  };
  const out = {};
  // (a) every row correct, then exit 9
  const g11Dead = checkTriggerRecallDualWrite(mkCtx('a', { g11: { script: wrapper } }));
  const rcProblem = (g11Dead.problems || []).some((p) => /exited rc 9/.test(String(p)));
  out.rows_correct_then_exit_9 = {
    pass: g11Dead.pass === false && rcProblem,
    g11_pass: g11Dead.pass, g11_rc: g11Dead.rc,
    problems: (g11Dead.problems || []).slice(0, 4),
  };
  // (b) the tool cannot be spawned at all
  const ctxB = mkCtx('b', {
    g11: { argv0: PART12_MISSING_EXE }, p05: { argv0: PART12_MISSING_EXE },
    g05: { exeOverride: PART12_MISSING_EXE },
  });
  const g11NoSpawn = checkTriggerRecallDualWrite(ctxB);
  const p05NoSpawn = checkUnlockPrecisionGate(ctxB);
  const g05NoSpawn = checkSettingsWiring(ctxB.toolOverrides.g05);
  const named = (res, re) => (res.problems || []).some((p) => re.test(String(p)));
  const g05SpawnErrorSeen = (g05NoSpawn.instances || []).some((i) => i.launch && i.launch.spawn_error);
  out.spawn_failure = {
    pass: g11NoSpawn.pass === false && named(g11NoSpawn, /could not be spawned/) &&
      p05NoSpawn.pass === false && named(p05NoSpawn, /could not be spawned/) &&
      g05NoSpawn.pass === false && g05SpawnErrorSeen,
    exe: PART12_MISSING_EXE,
    g11: { pass: g11NoSpawn.pass, problems: (g11NoSpawn.problems || []).slice(0, 2) },
    p05: { pass: p05NoSpawn.pass, problems: (p05NoSpawn.problems || []).slice(0, 2) },
    g05: { pass: g05NoSpawn.pass, spawn_error_seen: g05SpawnErrorSeen,
      first_launch: ((g05NoSpawn.instances || [])[0] || {}).launch || null },
  };
  out.pass = out.rows_correct_then_exit_9.pass && out.spawn_failure.pass;
  return out;
}

// conventions.home_resolution (v2.25, fab MEDIUM-1): "every guard derives
// HOME from one exported resolver in pmm-recall-ledger.cjs -- resolveHome()
// = PMM_HOME (trimmed non-empty) else USERPROFILE else HOME else
// os.homedir() -- and every root ... is derived from
// resolveHome()/resolveRoot() only; a guard reading os.homedir() or
// HOME/USERPROFILE directly is a red in the self-check grep (part13)".
//
// conventions.home_literal_scan (v2.26, codex final #1 + fab MEDIUM-6, Opus):
// part13 "additionally scans every non-comment line of every roster file for
// /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/ and /\/[cC]\/Users\/[A-Za-z0-9._-]+/;
// a hit is red unless that exact line is on a per-line allowlist held inside
// the runner (desensitize fixtures only; no per-file exemption; snapshotFiles()
// derives the real tree from __dirname instead of being allowlisted)", plus four
// cheap read forms "with the same per-line allowlist". Before v2.26 both
// historical leak lines (9e4f477^ pmm-trigger-recall.cjs:65, 5521f82^
// pmm-bash-impression.cjs:110) scanned hit=false.
//
// The criterion implemented here, stated so it can be argued with:
//  * scanned (the roster): every *.cjs and *.sh directly under guards/ EXCEPT
//    this runner -- the acceptance harness is not a guard, it must set HOME
//    for its children by construction, and it embeds the historical leak
//    lines verbatim as fixtures (mutants/ and fixtures/ are subdirectories and
//    were never scanned);
//  * a READ hit (kind 'read') is, on the raw line, os.homedir() /
//    process.env.HOME / process.env.USERPROFILE / $HOME / $USERPROFILE /
//    %USERPROFILE% (v2.25) and, since v2.26, require(os).homedir (any
//    quoting), process.env[<quoted HOME|USERPROFILE>], and destructuring
//    {.. HOME|USERPROFILE ..} = process.env; in *.sh files also `cd ~` and
//    `~/` in shell CODE -- bash expands a tilde only in an unquoted word, so
//    shellCodeLines() first blanks single-quoted text, double-quoted literal
//    text (keeping any $( ) / `` inside it), comments and heredoc bodies;
//  * a line that only ASSIGNS or FORWARDS the variable is not a read (the
//    v2.25 HOME_WRITE_RE for the v2.25 forms, HOME_BRACKET_WRITE_RE for the
//    bracket form; require/destructuring/tilde are reads by construction), a
//    comment line is not code;
//  * a LITERAL hit (kind 'literal') is either contract regex on a
//    non-comment line;
//  * allowed: a READ hit in pmm-recall-ledger.cjs (the one resolver
//    conventions.home_resolution names -- a v2.25 file allowance, reads
//    only), or a hit whose EXACT line text is on HOME_SCAN_LINE_ALLOWLIST for
//    that file and kind. Literals have no file allowance, the resolver
//    included.
const HOME_READ_PATTERNS = [
  { name: 'os.homedir()', re: /\bos\.homedir\s*\(/, notIf: 'v225-write' },
  { name: 'process.env.HOME', re: /process\.env\.HOME\b/, notIf: 'v225-write' },
  { name: 'process.env.USERPROFILE', re: /process\.env\.USERPROFILE\b/, notIf: 'v225-write' },
  { name: '$HOME', re: /\$\{?HOME\b/, notIf: 'v225-write' },
  { name: '$USERPROFILE', re: /\$\{?USERPROFILE\b|%USERPROFILE%/, notIf: 'v225-write' },
  // v2.26 (fab MEDIUM-6): the four cheap forms. No further arms race -- the
  // behavioural probe (pmm-home-split-probe.sh), not this grep, is the line
  // of defence (contract home_literal_scan).
  { name: 'require(os).homedir', re: /\brequire\s*\(\s*(['"`])(?:node:)?os\1\s*\)\s*\.\s*homedir\b/ },
  { name: 'process.env[HOME|USERPROFILE]', re: /process\.env\s*\[\s*(['"`])(?:HOME|USERPROFILE)\1\s*\]/, notIf: 'bracket-write' },
  { name: '{HOME|USERPROFILE} = process.env', re: /\{[^}]*\b(?:HOME|USERPROFILE)\b[^}]*\}\s*=\s*process\.env\b/ },
  { name: 'cd ~', re: /(^|[\s;&|(])cd\s+~(?=$|[\s/;&|)])/, shellCode: true },
  { name: '~/', re: /(^|[\s=:(])~\//, shellCode: true },
];
const HOME_WRITE_RE = /(^|[;&|\s({])(export\s+)?(HOME|USERPROFILE)\s*=|\.(HOME|USERPROFILE)\s*=[^=]|['\"](HOME|USERPROFILE)['\"]\s*:|delete\s+env\.(HOME|USERPROFILE)/;
const HOME_BRACKET_WRITE_RE = /process\.env\s*\[\s*(['"`])(?:HOME|USERPROFILE)\1\s*\]\s*=(?!=)|delete\s+process\.env\s*\[/;
// contract v2.26 erratum 2 (home_literal_scan): "the literal patterns match
// Users case-insensitively (Windows paths are case-insensitive)" -- c:/users/x
// and C:\USERS\x name the same home as C:/Users/x (Opus B1 INFO).
const HOME_LITERAL_PATTERNS = [
  { name: 'home-literal', re: /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/i },
  { name: 'home-literal-msys', re: /\/[cC]\/Users\/[A-Za-z0-9._-]+/i },
];
const HOME_RESOLVER_FILE = 'pmm-recall-ledger.cjs';
// The per-line allowlist: matched by EXACT TEXT, ONCE PER FILE. `line` is the
// exact line text (trailing CR dropped): an edit to an allowlisted line
// un-allows it, which is the point. contract v2.26 erratum 2 (Opus B1 LOW-2:
// a copy of the pmm-home.sh `cd ~` line pasted into the primary resolution
// path stayed green, because the entry matched every line with that text):
// an entry covers the FIRST line in the file carrying its text; a second copy
// anywhere in the same file is a disallowed hit.
// Desensitize fixtures per the contract; the two desensitize() implementation
// lines are here because their only hit is the scrub placeholder C:/Users/_/
// the function WRITES (a builder judgment, named in the B1 report -- remove
// them and those two lines red until the placeholder changes). The pmm-home.sh
// fallback is allowlisted only while its behaviour probe exists
// (home_literal_scan: "once its behaviour probe pmm-home-split-probe.sh
// exists").
const HOME_SCAN_LINE_ALLOWLIST = [
  { file: 'bash-pipe-exitcode-watch.cjs', kind: 'literal', why: 'desensitize() implementation: C:/Users/_/ is the scrub placeholder it writes, not a home',
    line: "  s = s.replace(/C:\\/Users\\/[^/\\s]+\\//gi, 'C:/Users/_/');" },
  { file: 'bash-pipe-exitcode-watch.cjs', kind: 'literal', why: 'desensitize fixture (unit, bare username path)',
    line: "    const out = desensitize('cat C:/Users/<user>/notes.txt and /Users/otherName/file too');" },
  { file: 'bash-pipe-exitcode-watch.cjs', kind: 'literal', why: 'desensitize fixture (unit assertion)',
    line: "    report('desensitize() unit: bare (unquoted) C:/Users/<name>/ and /Users/<name>/ paths both lose their username', out.indexOf(os.userInfo().username) < 0 && out.indexOf('otherName') < 0 && out.indexOf('C:/Users/_/') >= 0 && out.indexOf('/Users/_/') >= 0, JSON.stringify(out));" },
  { file: 'bash-pipe-exitcode-watch.cjs', kind: 'literal', why: 'desensitize fixture (queue black-box command)',
    line: "    const dirtyCmd = 'cat \"C:/Users/<user>/secret.txt\" \\'another secret\\' | tail -3; rc=$?';" },
  { file: 'bash-pipe-exitcode-watch.cjs', kind: 'literal', why: 'desensitize fixture (M0 export check)',
    line: "    report('M0 hook module already exports a working desensitize() (pre-existing, not this round\\'s work)', typeof M0.desensitize === 'function' && M0.desensitize('cat C:/Users/<user>/x \"q\"').indexOf(os.userInfo().username) < 0, '');" },
  { file: 'pmm-bash-impression.cjs', kind: 'literal', why: 'desensitize() implementation: C:/Users/_/ is the scrub placeholder it writes, not a home',
    line: "  s = s.replace(/C:\\/Users\\/[^/\\s]+\\//gi, 'C:/Users/_/');" },
  { file: 'pmm-bash-impression.cjs', kind: 'literal', why: 'desensitize fixture',
    line: "    const s = desensitize('cat C:/Users/<user>/secret/file.txt \"quoted content here\" ' + 'x'.repeat(150));" },
  { file: 'pmm-home.sh', kind: 'read', pattern: 'cd ~', requires: 'pmm-home-split-probe.sh',
    why: 'pmm-home.sh fallback (node unavailable): the one line that may resolve home without resolveHome(); its divergence is caught by the behaviour probe',
    line: '  PMM_HOME_RESOLVED="$(cd ~ 2>/dev/null && pwd)"' },
  // contract v2.26 erratum 5 (Opus 09-24 batch review M-1 / E-7): rule (1) of the isolation gate
  // compares a command's assignment VALUE against the home-reference spellings a builder might
  // write ($HOME, ${HOME}, $USERPROFILE, ~). The spellings are DATA the gate matches against, not
  // a read of the environment; the gate never dereferences them. Obfuscating the strings to dodge
  // this scan was refused (auto-mode: bypass); the honest fix is this one exact-line entry.
  { file: 'pmm-isolation-gate.cjs', kind: 'read',
    why: 'isolation gate rule (1) pattern table: literal home-reference spellings the gate REJECTS in redirect values; data, not a read (contract v2.26 erratum 5)',
    line: "  const refs = ['${HOME}', '${USERPROFILE}', '$HOME', '$USERPROFILE', '~'];" },
];

// Shell CODE per line: what bash would subject to tilde expansion. Unquoted
// text and the inside of $( ) / `` (also within double quotes) are kept;
// single-quoted text, double-quoted literal text, comments and heredoc bodies
// become blanks (so word boundaries survive). Quoting state carries across
// lines (multi-line '...' fixtures are common in the guards' self-tests).
// Deliberately small: it only has to be right for the two tilde forms.
function shellCodeLines(text) {
  const lines = text.split('\n');
  const out = [];
  const stack = [{ k: 'top' }]; // top | sub ($( )) | bt (``) | dq | sq
  const pendingHeredocs = [];
  let heredoc = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\r$/, '');
    if (heredoc) {
      const cmp = heredoc.strip ? line.replace(/^\t+/, '') : line;
      if (cmp === heredoc.delim) heredoc = pendingHeredocs.shift() || null;
      out.push('');
      continue;
    }
    let buf = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const top = stack[stack.length - 1];
      if (top.k === 'sq') {
        if (ch === "'") stack.pop();
        buf += ' ';
        continue;
      }
      if (top.k === 'dq') {
        if (ch === '\\') { buf += '  '; i += 1; continue; }
        if (ch === '"') { stack.pop(); buf += ' '; continue; }
        if (ch === '$' && line[i + 1] === '(') { stack.push({ k: 'sub', depth: 1 }); buf += '  '; i += 1; continue; }
        if (ch === '`') { stack.push({ k: 'bt' }); buf += ' '; continue; }
        buf += ' ';
        continue;
      }
      // code contexts: top, sub, bt
      if (ch === '\\') { buf += '  '; i += 1; continue; } // an escaped char is literal (\~ is not expanded)
      if (ch === "'") { stack.push({ k: 'sq' }); buf += ' '; continue; }
      if (ch === '"') { stack.push({ k: 'dq' }); buf += ' '; continue; }
      if (ch === '`') {
        if (top.k === 'bt') stack.pop(); else stack.push({ k: 'bt' });
        buf += ' ';
        continue;
      }
      if (ch === '#' && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) break; // comment to end of line
      if (ch === '$' && line[i + 1] === '(') { stack.push({ k: 'sub', depth: 1 }); buf += '  '; i += 1; continue; }
      if (top.k === 'sub') {
        if (ch === '(') top.depth += 1;
        else if (ch === ')') {
          top.depth -= 1;
          if (top.depth === 0) { stack.pop(); buf += ' '; continue; }
        }
      }
      if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        const m = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(i));
        if (m) {
          pendingHeredocs.push({ delim: m[3], strip: m[1] === '-' });
          buf += ' '.repeat(m[0].length);
          i += m[0].length - 1;
          continue;
        }
      }
      buf += ch;
    }
    out.push(buf);
    if (!heredoc && pendingHeredocs.length && stack.length === 1) heredoc = pendingHeredocs.shift();
  }
  return out;
}

// Which allowance (if any) covers one hit. Returns a label or null.
// `usedAt` (per file, owned by scanHomeText) records the line number each
// allowlist entry was first used on: contract v2.26 erratum 2 -- "an allowlist
// entry matches EXACTLY ONCE per file (a second copy of an allowlisted line is
// a hit)". Several hits on the SAME line (e.g. two literal patterns) share one
// use; the same text on another line is the second copy and is not allowed.
function homeScanAllowance(name, line, hit, dirNames, usedAt, lineNo) {
  if (hit.kind === 'read' && name === HOME_RESOLVER_FILE) return 'file:' + HOME_RESOLVER_FILE + ' (resolveHome(), reads only)';
  for (let k = 0; k < HOME_SCAN_LINE_ALLOWLIST.length; k++) {
    const e = HOME_SCAN_LINE_ALLOWLIST[k];
    if (e.file !== name || e.kind !== hit.kind || e.line !== line) continue;
    if (e.pattern && e.pattern !== hit.pattern) continue;
    if (e.requires && !(dirNames && dirNames.has(e.requires))) continue;
    if (usedAt) {
      if (usedAt.has(k) && usedAt.get(k) !== lineNo) {
        hit.second_copy_of = 'line#' + k + ' (first used at line ' + usedAt.get(k) + ')';
        continue;
      }
      usedAt.set(k, lineNo);
    }
    return 'line#' + k + ': ' + e.why;
  }
  return null;
}

// Comment lines per file type. contract v2.26 erratum 2 (home_literal_scan,
// Opus B1 LOW-3): "the leading-comment skip (# and *) applies to .sh files
// only -- in .cjs files only // and /* ... */ are comments, so #private fields
// and *-led continuation lines are scanned". Before this erratum
// ^(//|#|\*) was applied to every file, so a .cjs `#private = 'C:/Users/..'`
// field or a `* 'C:/Users/..'` continuation line was skipped as a comment.
// For .cjs a block comment is tracked only when the line STARTS with /*
// (JSDoc and banner blocks always do): a /* inside code or a string -- e.g.
// the glob '.claude/guards/*' -- never opens one, so the tracker can only err
// toward scanning a line, never toward hiding code. A line that closes a block
// and carries code after the */ is scanned whole. Returns one boolean per line
// (true = comment, skip).
// .sh keeps the pre-erratum skip set (#, * and //): the erratum narrows .cjs
// only, and the shell guards embed node programs in heredocs whose // comment
// lines (e.g. workflow-model-guard.sh explaining WHY it does not read
// os.homedir()) are not code.
function commentLineMask(name, lines) {
  const mask = new Array(lines.length).fill(false);
  if (/\.sh$/.test(name)) {
    for (let i = 0; i < lines.length; i++) mask[i] = /^(\/\/|#|\*)/.test(lines[i].trim());
    return mask;
  }
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlock) {
      const close = t.indexOf('*/');
      if (close < 0) { mask[i] = true; continue; }
      inBlock = false;
      mask[i] = t.slice(close + 2).trim() === '';
      continue;
    }
    if (t.startsWith('//')) { mask[i] = true; continue; }
    if (t.startsWith('/*')) {
      const close = t.indexOf('*/', 2);
      if (close < 0) { inBlock = true; mask[i] = true; continue; }
      mask[i] = t.slice(close + 2).trim() === '';
    }
  }
  return mask;
}

// One file's hits; pure, so the self-check can feed it fixtures. dirNames is
// the set of names in the scanned directory (an allowance may require a
// sibling file to exist).
function scanHomeText(name, text, dirNames) {
  const isShell = /\.sh$/.test(name);
  const lines = String(text).split('\n').map((l) => l.replace(/\r$/, ''));
  const code = isShell ? shellCodeLines(String(text)) : null;
  const isComment = commentLineMask(name, lines);
  const usedAt = new Map(); // allowlist entry index -> the one line it may cover in this file
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (isComment[i]) continue;
    const found = [];
    for (const pat of HOME_READ_PATTERNS) {
      if (pat.shellCode) {
        if (!isShell || !pat.re.test(code[i] || '')) continue;
      } else {
        if (!pat.re.test(line)) continue;
        if (pat.notIf === 'v225-write' && HOME_WRITE_RE.test(line)) continue; // assignment / forward, not a read
        if (pat.notIf === 'bracket-write' && HOME_BRACKET_WRITE_RE.test(line)) continue;
      }
      found.push({ kind: 'read', pattern: pat.name });
    }
    for (const pat of HOME_LITERAL_PATTERNS) {
      if (pat.re.test(line)) found.push({ kind: 'literal', pattern: pat.name });
    }
    for (const f of found) {
      const allowedBy = homeScanAllowance(name, line, f, dirNames, usedAt, i + 1);
      const h = {
        file: name, line: i + 1, kind: f.kind, pattern: f.pattern, text: trimmed.slice(0, 140),
        allowed: allowedBy !== null, allowed_by: allowedBy,
      };
      if (allowedBy === null && f.second_copy_of) h.why = 'second copy of allowlisted text, ' + f.second_copy_of;
      hits.push(h);
    }
  }
  return hits;
}

function scanHomeResolution(opts) {
  const dir = (opts && opts.dir) || GUARDS_DIR;
  const hits = [];
  let scanned = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_e) { names = []; }
  const dirNames = new Set(names);
  for (const name of names.sort()) {
    if (!/\.(cjs|sh)$/.test(name)) continue;
    if (name === path.basename(__filename)) continue; // the harness, not a guard
    const p = path.join(dir, name);
    let text;
    try { if (!fs.statSync(p).isFile()) continue; text = fs.readFileSync(p, 'utf8'); } catch (_e) { continue; }
    scanned += 1;
    for (const h of scanHomeText(name, text, dirNames)) hits.push(h);
  }
  const disallowed = hits.filter((h) => !h.allowed);
  const usedLines = new Set(hits.map((h) => h.allowed_by).filter((a) => a && a.indexOf('line#') === 0)
    .map((a) => Number(a.slice(5, a.indexOf(':')))));
  return {
    pass: disallowed.length === 0,
    scanned_dir: dir,
    scanned_files: scanned,
    allowlist: [HOME_RESOLVER_FILE + ' (resolveHome(), the one resolver conventions.home_resolution names; READ hits only)']
      .concat(HOME_SCAN_LINE_ALLOWLIST.map((e, k) => 'line#' + k + ' ' + e.file + ' [' + e.kind + (e.pattern ? ' ' + e.pattern : '') + ']' +
        (e.requires ? ' while ' + e.requires + ' exists' : '') + ': ' + e.why)),
    // hygiene, not scored: an entry that matched nothing is stale (its line
    // was edited or removed) and should be dropped from the runner.
    allowlist_entries_unused: HOME_SCAN_LINE_ALLOWLIST.map((e, k) => ({ k, file: e.file, requires: e.requires || null }))
      .filter((e) => !usedLines.has(e.k)),
    criterion: 'READ of HOME/USERPROFILE/os.homedir outside the resolver (v2.25 forms + v2.26 require(os).homedir, process.env[..], destructuring, shell-code cd ~ and ~/), or a home LITERAL (contract home_literal_scan regexes) on a non-comment line; allowed only by the resolver file (reads) or an exact-line allowlist entry; this runner is excluded as the harness',
    allowed_hits: hits.filter((h) => h.allowed).length,
    disallowed_hit_count: disallowed.length,
    disallowed_hits: disallowed,
  };
}

// The self-check's own evidence that part13 can go red: the two historical
// leak lines verbatim (codex final #1 / home_literal_scan), a commented copy
// of each, every v2.26 read form with a non-read control, and the allowlist's
// exact-line / per-file / requires semantics.
const HISTORICAL_HOME_LEAK_LINES = [
  { ref: '9e4f477^ pmm-trigger-recall.cjs:65 (the 294-row leak, fab HIGH-1)', file: 'pmm-trigger-recall.cjs',
    line: "const HOME = (process.env.PMM_HOME || 'C:/Users/<user>').replace(/\\\\/g, '/');" },
  { ref: '5521f82^ pmm-bash-impression.cjs:110 (the resolveRepo fallback)', file: 'pmm-bash-impression.cjs',
    line: "  const home = (process.env.PMM_IMPRESSION_HOME || 'C:/Users/<user>').replace(/\\\\/g, '/');" },
];
// contract v2.26 erratum 2 (home_literal_scan) fixtures, one constructed bad
// state per clause next to a control. Exported so a reviewer can run the same
// texts against an older scanHomeText and watch each red one turn from
// "missed" to "hit". Literals are assembled from pieces so this runner's own
// source holds none (the runner is excluded from part13 anyway).
function homeScanErratum2Fixtures() {
  const U = 'Us' + 'ers';
  const lit = 'C:/' + U + '/exampleuser/.claude';
  const fb = HOME_SCAN_LINE_ALLOWLIST.find((e) => e.file === 'pmm-home.sh');
  const des = HOME_SCAN_LINE_ALLOWLIST.find((e) => e.kind === 'literal' && e.file === 'pmm-bash-impression.cjs' && /desensitize\('cat/.test(e.line));
  const withProbe = new Set([fb.file, fb.requires]);
  return [
    // once per file (B1 LOW-2): the reproduced attack pasted the allowlisted
    // fallback line into the primary resolution path of the same file
    { id: 'e2 once-per-file: pmm-home.sh fallback line present TWICE (probe present)', file: fb.file,
      text: 'G="$(pwd)"\n' + fb.line + '\nX=1\n' + fb.line, want: 'red', pattern: 'cd ~', dirNames: withProbe },
    { id: 'e2 once-per-file: allowlisted desensitize fixture line present twice', file: des.file,
      text: des.line + '\n' + des.line, want: 'red', pattern: 'home-literal' },
    { id: 'e2 once-per-file control: the fallback line once among other code', file: fb.file,
      text: 'G="$(pwd)"\n' + fb.line + '\nX=1', want: 'allowed', pattern: null, dirNames: withProbe },
    // .cjs comment rule (B1 LOW-3)
    { id: 'e2 .cjs: #private field holding a home literal is code', file: 'x.cjs',
      text: 'class K {\n  #private = \'' + lit + '\';\n}', want: 'red', pattern: 'home-literal' },
    { id: 'e2 .cjs: *-led continuation line outside a block comment is code', file: 'x.cjs',
      text: 'const n = 2\n  * f(\'' + lit + '\');', want: 'red', pattern: 'home-literal' },
    { id: 'e2 .cjs: a /* inside a string does not open a block comment', file: 'x.cjs',
      text: "const g = '.claude/guards/*';\nconst h = '" + lit + "';", want: 'red', pattern: 'home-literal' },
    { id: 'e2 .cjs: code after a closing */ on the same line is scanned', file: 'x.cjs',
      text: "/* note */ const h = '" + lit + "';", want: 'red', pattern: 'home-literal' },
    { id: 'e2 .cjs control: JSDoc block with *-led lines', file: 'x.cjs',
      text: '/**\n * example: ' + lit + '\n */\nconst ok = 1;', want: 'clean' },
    { id: 'e2 .cjs control: // line comment', file: 'x.cjs', text: '// ' + lit, want: 'clean' },
    { id: 'e2 .sh control: # comment line', file: 'x.sh', text: '# ' + lit, want: 'clean' },
    // Users case-insensitive
    { id: 'e2 case: lowercase c:/users/<name>', file: 'x.cjs', text: "const h = 'c:/" + U.toLowerCase() + "/exampleuser/x';", want: 'red', pattern: 'home-literal' },
    { id: 'e2 case: upper-case C:\\USERS\\<name>', file: 'x.sh', text: 'H="C:\\' + U.toUpperCase() + '\\exampleuser"', want: 'red', pattern: 'home-literal' },
    { id: 'e2 case: msys /c/users/<name>', file: 'x.sh', text: 'H=/c/' + U.toLowerCase() + '/exampleuser', want: 'red', pattern: 'home-literal-msys' },
  ];
}
function runHomeScanFixtures() {
  const cases = [];
  // want: 'red' = at least one DISALLOWED hit (of `pattern` when given);
  // 'clean' = no hit at all; 'allowed' = at least one hit and all allowed.
  const add = (id, file, text, want, pattern, dirNames) => cases.push({ id, file, text, want, pattern: pattern || null, dirNames: dirNames || null });
  for (const h of HISTORICAL_HOME_LEAK_LINES) {
    add('historical ' + h.ref, h.file, h.line, 'red', 'home-literal');
    add('commented copy of ' + h.ref, h.file, '// ' + h.line, 'clean');
  }
  add('msys literal /c/Users/<name>', 'x.sh', 'ROOT=/c/Users/someone/.claude', 'red', 'home-literal-msys');
  add('cd ~', 'x.sh', 'cd ~', 'red', 'cd ~');
  add('cd ~ inside "$( )" (the pmm-home.sh form)', 'x.sh', 'H="$(cd ~ 2>/dev/null && pwd)"', 'red', 'cd ~');
  add('~/ unquoted', 'x.sh', 'cp ~/.bashrc /tmp/x', 'red', '~/');
  add('~/ after =', 'x.sh', 'P=~/bin', 'red', '~/');
  add('control: ~/ inside double quotes (no tilde expansion)', 'x.sh', 'echo "run bash ~/.claude/guards/x.sh"', 'clean');
  add('control: ~/ inside single quotes', 'x.sh', "printf '%s' '~/x'", 'clean');
  add('control: escaped \\~/', 'x.sh', 'ls \\~/x', 'clean');
  add('control: multi-line single-quoted fixture', 'x.sh', "mk 'a\n~/Desktop/repo/CLAUDE.md\n'", 'clean');
  add('control: heredoc body', 'x.sh', "cat <<'EOF'\ncd ~\n~/x\nEOF\necho done", 'clean');
  add('control: <<- heredoc body, tab-indented terminator', 'x.sh', 'cat <<-EOF\n\tcd ~\n\tEOF\necho done', 'clean');
  add('control: shell comment', 'x.sh', 'x=1 # cd ~', 'clean');
  add('require(os).homedir', 'x.cjs', "const h = require('os').homedir();", 'red', 'require(os).homedir');
  add('require("node:os").homedir', 'x.cjs', 'const h = require("node:os").homedir();', 'red', 'require(os).homedir');
  add('process.env[USERPROFILE]', 'x.cjs', "const u = process.env['USERPROFILE'];", 'red', 'process.env[HOME|USERPROFILE]');
  add('control: process.env[HOME] assignment', 'x.cjs', 'process.env["HOME"] = tmp;', 'clean');
  add('destructuring from process.env', 'x.cjs', 'const { HOME, PATH } = process.env;', 'red', '{HOME|USERPROFILE} = process.env');
  add('v2.25 control: os.homedir()', 'x.cjs', 'const h = os.homedir();', 'red', 'os.homedir()');
  const des = HOME_SCAN_LINE_ALLOWLIST.find((e) => e.kind === 'literal' && e.file === 'pmm-bash-impression.cjs' && /desensitize\('cat/.test(e.line));
  add('allowlisted desensitize line in its own file', des.file, des.line, 'allowed');
  add('same desensitize line in another file (no per-file / cross-file allowance)', 'x.cjs', des.line, 'red', 'home-literal');
  add('same desensitize line re-indented (exact line only)', des.file, ' ' + des.line, 'red', 'home-literal');
  add('literal in the resolver file (no file allowance for literals)', HOME_RESOLVER_FILE, "const H = 'C:/Users/<user>';", 'red', 'home-literal');
  add('read in the resolver file (v2.25 allowance)', HOME_RESOLVER_FILE, '  return stripTrailingSep(os.homedir());', 'allowed');
  const fb = HOME_SCAN_LINE_ALLOWLIST.find((e) => e.file === 'pmm-home.sh');
  add('pmm-home.sh fallback WITHOUT its probe', fb.file, fb.line, 'red', 'cd ~', new Set([fb.file]));
  add('pmm-home.sh fallback WITH its probe', fb.file, fb.line, 'allowed', null, new Set([fb.file, fb.requires]));
  for (const f of homeScanErratum2Fixtures()) add(f.id, f.file, f.text, f.want, f.pattern, f.dirNames);
  const results = cases.map((c) => {
    const hits = scanHomeText(c.file, c.text, c.dirNames || new Set([c.file]));
    const bad = hits.filter((h) => !h.allowed && (!c.pattern || h.pattern === c.pattern));
    const ok = c.want === 'red' ? bad.length > 0
      : c.want === 'clean' ? hits.length === 0
        : hits.length > 0 && hits.every((h) => h.allowed);
    return { id: c.id, want: c.want, pass: ok, hit: hits.length > 0, hits: hits.map((h) => h.kind + ':' + h.pattern + (h.allowed ? '(allowed)' : '')) };
  });
  return { pass: results.every((r) => r.pass), cases: results.length, failed: results.filter((r) => !r.pass), results };
}

// conventions.selftest_id_convention (v2.26, codex final #6 + Opus: bac617a
// introduced real-shaped synthetic ids no contamination sentinel can see):
// "the runner self-check statically scans guards/*.cjs self-test code and
// reds any tool_use_id: literal that contains neither selftest nor tu-".
// The criterion implemented here, stated so it can be argued with:
//  * scanned: every non-comment line of every *.cjs directly under guards/,
//    THIS RUNNER INCLUDED (it writes synthetic ids too; its own fixtures below
//    are assembled at run time so its source carries no matching literal).
//    Self-test code is not delimited by file region: a string-literal id in a
//    production path is just as synthetic;
//  * a literal is the value of a tool_use_id key -- bare, quoted, or JSON
//    inside a string (backslash-quoted) -- that starts with a quote; a value
//    that starts with an identifier is a variable, not a literal, and a
//    concatenation is judged by its leading literal ('tu' + i is 'tu');
//  * the empty literal is the documented no-id value (id_missing), not a
//    synthetic id, and is not counted;
//  * red: a counted literal containing neither `selftest` nor `tu-`.
// contract v2.26 erratum 2 (selftest_id_convention, Opus B1 MEDIUM-1 + B2
// LOW-3):
//  * comment lines follow the .cjs rule of commentLineMask() (only // and
//    /* */ are comments; a `#x = { tool_use_id: .. }` private-field line is
//    code -- B1 LOW-3 demonstrated it being skipped);
//  * SESSION literals are scanned too: "part16 also scans session_id:
//    literals in self-test code (must be test:<...> or a sha16(...) of such a
//    string; real-looking 16-hex literals such as deadbeef00003333 are red)".
//    Counted: the value of a session_id key (same key forms as tool_use_id),
//    and -- a builder reading, stated so it can be argued with -- the same
//    value under the camelCase sessionId key and a string assigned to an
//    identifier ending in Session/SessionId/session_id. The contract's own
//    example deadbeef00003333 exists in the tree ONLY in the assignment form
//    (`const discovererSession = 'deadbeef00003333'`), so a key-only scan
//    could never red it. A literal wrapped in sha16( ) is judged by the
//    wrapped literal. OK = starts with test:. The empty literal (no session,
//    the id_missing path) and non-literal values (variables, calls) are not
//    counted;
//  * ids held in VARIABLES are invisible to a static scan, so the runner's
//    own ids are asserted by execution (runnerIdSelfAssertion).
const SELFTEST_ID_LITERAL_RE = /tool_use[_]id\\?['"]?\s*:\s*\\?(['"`])(.*?)\\?\1/g;
const SELFTEST_SESSION_LITERAL_RES = [
  { form: 'session_id key', re: /session[_]id\\?['"]?\s*:\s*(sha16\s*\(\s*)?\\?(['"`])(.*?)\\?\2/g },
  { form: 'sessionId key', re: /\bsession[I]d\s*:\s*(sha16\s*\(\s*)?(['"`])(.*?)\2/g },
  { form: 'session-named assignment', re: /\b\w*[sS]ession(?:[I]d|_id)?\s*=(?!=)\s*(sha16\s*\(\s*)?(['"`])(.*?)\2/g },
];
function scanSelftestIdText(name, text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\r$/, ''));
  const isComment = commentLineMask(/\.sh$/.test(name) ? name : 'scan.cjs', lines);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isComment[i]) continue;
    SELFTEST_ID_LITERAL_RE.lastIndex = 0;
    let m;
    while ((m = SELFTEST_ID_LITERAL_RE.exec(line)) !== null) {
      const value = m[2];
      if (value === '') continue;
      found.push({ file: name, line: i + 1, kind: 'tool_use_id', value, ok: /selftest|tu-/.test(value) });
    }
  }
  return found;
}
function scanSelftestSessionText(name, text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\r$/, ''));
  const isComment = commentLineMask(/\.sh$/.test(name) ? name : 'scan.cjs', lines);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (isComment[i]) continue;
    const seen = new Set(); // one literal per (line, column) even when two forms overlap
    for (const f of SELFTEST_SESSION_LITERAL_RES) {
      f.re.lastIndex = 0;
      let m;
      while ((m = f.re.exec(lines[i])) !== null) {
        const value = m[3];
        if (value === '') continue;
        const at = m.index + m[0].length - value.length - 1;
        if (seen.has(at)) continue;
        seen.add(at);
        found.push({ file: name, line: i + 1, kind: 'session', form: f.form + (m[1] ? ' via sha16()' : ''), value, ok: /^test:/.test(value) });
      }
    }
  }
  return found;
}
// The runner's own ids, by EXECUTION (erratum 2: "for the runner itself,
// asserts by execution that randId() output carries the prefixes"). The shape
// predicate is run on what the runner actually mints -- outside part14, inside
// a simulated part14 nonce window, homeOnlyG11Ids() and the four Z10-family
// dirty ids -- and, as its own negative fixture, on the pre-erratum shapes,
// which it must red (a predicate that passes everything proves nothing).
function idShapeProblems(sample) {
  const problems = [];
  const FORBIDDEN = /[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/;
  for (const v of sample.tool || []) if (!/^toolu_selftest_/.test(String(v))) problems.push('tool id without toolu_selftest_: ' + JSON.stringify(v));
  for (const v of sample.session || []) {
    if (!/^test:/.test(String(v))) problems.push('session id without test:: ' + JSON.stringify(v));
    if (/^toolu_/.test(String(v))) problems.push('session id is a toolu_ string: ' + JSON.stringify(v));
  }
  for (const v of sample.token || []) if (/[:\\/]/.test(String(v))) problems.push('token is not filename-safe: ' + JSON.stringify(v));
  for (const v of sample.dirty || []) {
    const s = String(v);
    if (!s.startsWith('tu-') || !FORBIDDEN.test(s.charAt(3))) problems.push('dirty id without tu- immediately before its control character: ' + JSON.stringify(v));
  }
  for (const k of ['tool', 'session', 'token']) {
    const vs = sample[k] || [];
    if (new Set(vs).size !== vs.length) problems.push(k + ' values are not unique');
  }
  return problems;
}
function runnerIdSelfAssertion() {
  const N = 5;
  const mint = (kind) => Array.from({ length: N }, () => randId(kind));
  const plain = { tool: mint('tool'), session: mint('session'), token: mint('token') };
  // part14 window, simulated exactly as runHomeOnlyRealRootProof opens it
  const saved = Object.assign({}, ID_NONCE);
  const nonce = 'idfx' + crypto.randomBytes(4).toString('hex');
  let inNonce;
  ID_NONCE.active = true; ID_NONCE.nonce = nonce; ID_NONCE.n = 0;
  try {
    inNonce = { tool: mint('tool'), session: mint('session'), token: mint('token'), agent: mint('agent'), prompt: mint('prompt') };
  } finally {
    Object.assign(ID_NONCE, saved);
  }
  const g11 = homeOnlyG11Ids(nonce);
  const dirty = ['Z10', 'Z10b', 'Z10c', 'Z10d'].map((id) => z10DirtyToolUseId(id));
  const actual = {
    tool: plain.tool.concat(inNonce.tool, [g11.toolUseId]),
    session: plain.session.concat(inNonce.session, [g11.sessionId]),
    token: plain.token.concat(inNonce.token),
    dirty,
  };
  const problems = idShapeProblems(actual);
  const noNonce = [].concat(inNonce.tool, inNonce.session, inNonce.token, inNonce.agent, inNonce.prompt).filter((v) => String(v).indexOf(nonce) < 0);
  if (noNonce.length) problems.push('ids minted in the part14 window without the nonce: ' + JSON.stringify(noNonce.slice(0, 3)));
  const throwsOn = (arg) => { try { randId(arg); return false; } catch (_e) { return true; } };
  const kindless = { no_kind_throws: throwsOn(undefined), unknown_kind_throws: throwsOn('uuid') };
  if (!kindless.no_kind_throws || !kindless.unknown_kind_throws) problems.push('randId() without a known kind did not throw');
  // negative fixtures: the shapes this erratum retires, each of which must red
  const retired = [
    { id: 'pre-erratum tool id: bare UUID', sample: { tool: [crypto.randomUUID()] } },
    { id: 'pre-erratum session id: bare UUID', sample: { session: [crypto.randomUUID()] } },
    { id: 'pre-erratum part14 session id: toolu_selftest_<nonce>_<n>', sample: { session: ['toolu_selftest_' + nonce + '_1'] } },
    { id: 'pre-erratum Z10c dirty id: tu<BEL>...', sample: { dirty: ['tu' + '\u0007' + crypto.randomUUID()] } },
    { id: 'pre-erratum Z10 dirty id: tu<TAB>...', sample: { dirty: ['tu' + '\t' + 'a'] } },
    { id: 'session-form colon in a file-name token', sample: { token: ['test:' + crypto.randomUUID()] } },
  ].map((f) => ({ id: f.id, red: idShapeProblems(f.sample).length > 0 }));
  const retiredOk = retired.every((f) => f.red);
  return {
    pass: problems.length === 0 && retiredOk,
    problems,
    kind_guard: kindless,
    retired_shapes_red: retiredOk,
    retired_shapes: retired,
    examples: { tool: actual.tool[0], session: actual.session[0], part14_tool: inNonce.tool[0], part14_session: inNonce.session[0],
      part14_agent: inNonce.agent[0], token: actual.token[0], dirty: dirty.map((d) => JSON.stringify(d).slice(0, 14)) },
  };
}
function scanSelftestIds(opts) {
  const dir = (opts && opts.dir) || GUARDS_DIR;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_e) { names = []; }
  const literals = [];
  const sessionLiterals = [];
  let scanned = 0;
  for (const name of names.sort()) {
    if (!/\.cjs$/.test(name)) continue;
    const p = path.join(dir, name);
    let text;
    try { if (!fs.statSync(p).isFile()) continue; text = fs.readFileSync(p, 'utf8'); } catch (_e) { continue; }
    scanned += 1;
    for (const f of scanSelftestIdText(name, text)) literals.push(f);
    for (const f of scanSelftestSessionText(name, text)) sessionLiterals.push(f);
  }
  // fixtures: built from pieces so that this file's own source never holds a
  // matching literal (the scan above covers this file too)
  const K = 'tool_use' + '_id';
  const BS = String.fromCharCode(92);
  const fx = [
    { id: 'bac617a shape (real-shaped, no marker)', text: '{ ' + K + ": 'toolu_01deadbeefqueue1' }", red: true },
    { id: 'short synthetic', text: 'x({ ' + K + ": 't' })", red: true },
    { id: 'concatenation judged by its leading literal', text: 'rows.push({ ' + K + ": 'tu' + i })", red: true },
    { id: 'quoted key', text: '{ "' + K + '": "toolu_01abc" }', red: true },
    { id: 'JSON inside a string', text: "const j = '{" + BS + '"' + K + BS + '":' + BS + '"toolu_01abc' + BS + '"}' + "';", red: true },
    { id: 'control: toolu_selftest_ prefix', text: '{ ' + K + ": 'toolu_selftest_q1' }", red: false },
    { id: 'control: tu- prefix', text: '{ ' + K + ": 'tu-m3-absent' }", red: false },
    { id: 'control: empty literal (no id)', text: '{ ' + K + ": '' }", red: false },
    { id: 'control: variable, not a literal', text: '{ ' + K + ': toolUseId }', red: false },
    { id: 'control: comment line', text: '// { ' + K + ": 'toolu_01abc' }", red: false },
    // erratum 2 (B1 LOW-3): in .cjs only // and /* */ are comments
    { id: 'e2 .cjs: #private field line is code', text: '#x = { ' + K + ": 'toolu_01abc' };", red: true },
    { id: 'e2 .cjs: *-led continuation line outside a block is code', text: 'const a = 1\n  * f({ ' + K + ": 'toolu_01abc' });", red: true },
    { id: 'e2 control: inside a /* */ block', text: '/*\n * { ' + K + ": 'toolu_01abc' }\n */", red: false },
  ].map((c) => {
    const f = scanSelftestIdText('fixture.cjs', c.text);
    const isRed = f.some((x) => !x.ok);
    return { id: c.id, want_red: c.red, red: isRed, pass: isRed === c.red };
  });
  // erratum 2: session literals (pieces again, so this source holds none)
  const S = 'session' + '_id';
  const SC = 'session' + 'Id';
  const sfx = [
    { id: 'short synthetic session', text: 'x({ ' + S + ": 's-h2' })", red: true },
    { id: 'real-looking 16-hex session (deadbeef00003333 class)', text: '{ ' + S + ": 'deadbeef00003333' }", red: true },
    { id: 'toolu_ string as a session', text: '{ ' + S + ": 'toolu_selftest_x_1' }", red: true },
    { id: 'JSON inside a string', text: "const j = '{" + BS + '"' + S + BS + '":' + BS + '"s1' + BS + '"}' + "';", red: true },
    { id: 'sha16() of a non-test string', text: '{ ' + S + ": sha16('prod-session') }", red: true },
    { id: 'camelCase key', text: 'ctx({ ' + SC + ": 's-bwe' })", red: true },
    { id: 'session-named assignment (the tree form of deadbeef00003333)', text: 'const discovererSess' + 'ion = ' + "'deadbeef00003333';", red: true },
    { id: 'control: test: literal', text: '{ ' + S + ": 'test:h2' }", red: false },
    { id: 'control: sha16() of a test: string', text: '{ ' + S + ": sha16('test:m5b') }", red: false },
    { id: 'control: empty literal (no session)', text: '{ ' + S + ": '' }", red: false },
    { id: 'control: variable', text: '{ ' + S + ': sessionS }', red: false },
    { id: 'control: comparison, not an assignment', text: 'if (x.' + 'session === ' + "'s') y();", red: false },
    { id: 'control: comment line', text: '// { ' + S + ": 's-h2' }", red: false },
  ].map((c) => {
    const f = scanSelftestSessionText('fixture.cjs', c.text);
    const isRed = f.some((x) => !x.ok);
    return { id: c.id, want_red: c.red, red: isRed, pass: isRed === c.red };
  });
  const bad = literals.filter((l) => !l.ok);
  const byFile = {};
  for (const b of bad) byFile[b.file] = (byFile[b.file] || 0) + 1;
  const sBad = sessionLiterals.filter((l) => !l.ok);
  const sByFile = {};
  for (const b of sBad) sByFile[b.file] = (sByFile[b.file] || 0) + 1;
  const execution = runnerIdSelfAssertion();
  const fixturesOk = fx.every((c) => c.pass) && sfx.every((c) => c.pass);
  return {
    pass: bad.length === 0 && sBad.length === 0 && fixturesOk && execution.pass,
    fixtures_ok: fixturesOk,
    fixtures: fx,
    session_fixtures: sfx,
    scanned_dir: dir,
    scanned_files: scanned,
    literals_counted: literals.length,
    offending_count: bad.length,
    offending_by_file: byFile,
    offending: bad.map((b) => ({ file: b.file, line: b.line, value: b.value })),
    session_literals: {
      counted: sessionLiterals.length,
      offending_count: sBad.length,
      offending_by_file: sByFile,
      offending: sBad.map((b) => ({ file: b.file, line: b.line, form: b.form, value: b.value })),
    },
    runner_ids_by_execution: execution,
    criterion: 'non-empty tool_use_id string literal (bare, quoted or backslash-quoted key; leading literal of a concatenation) on a non-comment line of guards/*.cjs, this runner included, containing neither selftest nor tu-; ' +
      'non-empty session literal (session_id key, sessionId key, or a string assigned to a *Session/*SessionId identifier; sha16(<literal>) judged by the literal) not starting with test:; ' +
      'comment lines per commentLineMask (.cjs: // and /* */ only); the runner\'s own ids asserted by execution (runnerIdSelfAssertion)',
  };
}

// The real tree is found from THIS FILE, never from the environment: the
// self-check itself runs under a redirected HOME, so os.homedir() is the temp
// one and would prove nothing.
const REAL_TREE_HOME = path.resolve(GUARDS_DIR, '..', '..');
// contract v2.26 home_only_proof (b): "the monitored real-root set is
// events-v3-*.tsv, quarantine-*.tsv, queue-*.tsv, policy.json and
// trigger-log-*.tsv under .local/pmm-recall, every .trigger-seen-*, and the
// frozen memory/dreams/trigger-log-*.tsv". Until v2.26 the migrated live
// trigger-log (9e4f477 moved it under .local/pmm-recall) was not watched, so
// the one file a HOME-only G11 leak writes first was invisible. The home is a
// parameter so the self-check can prove the set against a temp tree (f).
// contract v2.26 erratum 2 (home_only_proof (b), Opus B1 LOW-1): "the watched
// set also includes receipts-*.log and pending/* under the recall root" --
// both are live gate outputs, and the reviewer's L2 leak tree wrote both
// while part14 stayed green.
const REAL_ROOT_WATCH = [
  { sub: ['.claude', '.local', 'pmm-recall'], re: /^(?:(?:events-v3|quarantine|queue|trigger-log)-.*\.tsv|policy\.json|receipts-.*\.log)$/ },
  { sub: ['.claude', '.local', 'pmm-recall', 'pending'], re: /^/ },
  { sub: ['.claude'], re: /^\.trigger-seen-/ },
  { sub: ['.claude', 'memory', 'dreams'], re: /^trigger-log-.*\.tsv$/ },
];
// (k), as narrowed by contract v2.26 erratum 3: the created-file rule applies
// ONLY to MACHINE-NAMED watched files -- "events-v3-*.tsv, queue-*.tsv,
// quarantine-*.tsv, trigger-log-*.tsv, policy.json" (the frozen
// memory/dreams/trigger-log-<mach>.tsv included; it is machine-named too).
// Production creates the other watched names by itself inside any proof
// window: seen files, pending/<key>.json (created at Pre, consumed at Post)
// and receipts-<sid>-<agent>.log (first write of a new session/agent). The
// B1-tail-2 real-tree run measured exactly that: a concurrent session's
// pending file was created and consumed during part14 with no marker, and
// (k) as first written turned it into a red, contradicting (e). Those names
// stay attributable by marker -- pending and receipts content always carries
// the verbatim tool_use_id -- and a markerless creation of one is ambient.
const MACHINE_NAMED_WATCH_RE = /^(?:(?:events-v3|queue|quarantine|trigger-log)-.*\.tsv|policy\.json)$/;
function realRootTripleFiles(homeDir) {
  const home = homeDir || REAL_TREE_HOME;
  const out = [];
  for (const w of REAL_ROOT_WATCH) {
    const dir = path.join(home, ...w.sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_e) { continue; }
    for (const n of names) {
      if (!w.re.test(n)) continue;
      const p = path.join(dir, n);
      try { if (!fs.statSync(p).isFile()) continue; } catch (_e) { continue; }
      out.push(p);
    }
  }
  return out.sort();
}
function realRootTripleSnapshot(homeDir) {
  const map = {};
  for (const f of realRootTripleFiles(homeDir)) {
    let buf = null;
    try { buf = fs.readFileSync(f); } catch (_e) { buf = null; }
    map[f] = buf === null ? { sha: 'unreadable', size: -1, text: '' }
      : { sha: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, text: buf.toString('utf8') };
  }
  return map;
}
// This host's OWN session writes the real ledger while the proof runs (an
// ambient modification was measured at ~1 per 45 s), so a bare before/after
// comparison would flake. Every change is therefore ATTRIBUTED: the bytes
// this run added must be searched for the proof's own markers. A change with
// none of them is ambient and is reported separately instead of being
// counted as a leak -- and a change that carries one is a leak no matter how
// busy the host is.
// contract v2.26 home_only_proof (d): markers are matched against the file
// NAME as well as the added bytes. A leaked .trigger-seen-<sha16> holds only
// tag names, so content matching alone classed exactly the HIGH-1 leak as
// ambient; its name is computable from the proof's own ids. A deletion has no
// added bytes, so it is attributable by name only: production deletes stale
// seen files by itself (pmm-autopull.sh `-name .trigger-seen-* -mtime +2
// -delete` at SessionStart), and an unmarked deletion is therefore ambient
// (reported, not a red) -- unlike v2.25, which counted every deletion a leak.
// contract v2.26 erratum 2 (home_only_proof (k), Opus B1 LOW-1: in the L2 leak
// tree a created queue-<mach>.tsv holding only desensitized paths and hashes
// was classed ambient): "a CREATED watched file other than a seen file is
// attributable (red) even without a content marker", narrowed by erratum 3 to
// MACHINE-NAMED files (MACHINE_NAMED_WATCH_RE). The marker it carries is
// `created:<basename>`. Seen, pending and receipts files stay by-marker only
// (production creates them by itself), deletions stay by-name only.
function attributeChanges(before, after, markers) {
  const attributable = [];
  const ambient = [];
  const ms = [...new Set((markers || []).filter((m) => typeof m === 'string' && m.length > 0))];
  const hitText = (text) => ms.filter((m) => text.indexOf(m) >= 0);
  const hitName = (f) => {
    const base = path.basename(f);
    return ms.filter((m) => base.indexOf(m) >= 0).map((m) => 'name:' + m);
  };
  for (const f of Object.keys(after)) {
    const b = before[f];
    const a = after[f];
    if (b && b.sha === a.sha) continue;
    const added = b && a.text.startsWith(b.text) ? a.text.slice(b.text.length) : a.text;
    const marks = hitText(added).concat(hitName(f));
    if (!b && MACHINE_NAMED_WATCH_RE.test(path.basename(f))) marks.push('created:' + path.basename(f));
    const entry = { file: f, change: b ? 'modified' : 'created', added_bytes: added.length, markers: marks };
    if (marks.length) attributable.push(entry); else ambient.push(entry);
  }
  for (const f of Object.keys(before)) {
    if (after[f] !== undefined) continue;
    const marks = hitName(f);
    const entry = { file: f, change: 'deleted', added_bytes: 0, markers: marks };
    if (marks.length) attributable.push(entry); else ambient.push(entry);
  }
  return { attributable, ambient };
}

// contract v2.26 home_only_proof (c): run-nonce identities for part14. The
// session must start with test: (selftest_id_convention); the tool's own
// 8-character telemetry session column therefore reads "testg11-", which is
// why the markers carry that column as the tool computes it.
function homeOnlyG11Ids(nonce) {
  return {
    toolUseId: 'toolu_selftest_' + nonce + '_g11',
    sessionId: 'test:g11-' + nonce,
    agentId: 'test:g11-agent-' + nonce,
    tagSuffix: nonce,
    rel: '.claude/guards/x-' + nonce + '.sh',
  };
}
function homeOnlyMarkers({ nonce, homeDir, root, g11 }) {
  const noDrive = (p) => String(p).replace(/^[A-Za-z]:/, '');
  const m = [nonce];
  if (homeDir) m.push(homeDir, homeDir.replace(/\\/g, '/'), noDrive(homeDir.replace(/\\/g, '/')));
  if (root) {
    const p14 = path.join(root, 'part14');
    m.push(p14, p14.replace(/\\/g, '/'), noDrive(p14.replace(/\\/g, '/')));
    // contract v2.26 erratum 2 (home_only_proof (c)): the run root's basename
    // (the mkdtemp name, pgv2-selfcheck-XXXXXX) -- the one piece of a path
    // that survives desensitize() (C:/Users/_/.../pgv2-selfcheck-X/part14-..),
    // which is all a leaked queue row carries besides hashes (Opus B1 LOW-1).
    m.push(path.basename(root));
  }
  if (g11) {
    m.push(g11.tool_use_id, g11.session_id, g11.agent_id, g11.seen_file, g11.tlog_session, g11.rel);
    for (const t of g11.tags || []) m.push(t);
  }
  // the fallback a tool falls into when it loses the session id: the seen key
  // of sha16('nosess' || NUL || '') (pmm-trigger-recall.cjs seenKey)
  m.push('.trigger-seen-' + sha16('nosess' + '\0' + ''));
  return [...new Set(m.filter((x) => typeof x === 'string' && x.length > 0))];
}

// contract v2.26 home_only_proof (f) + (a): the constructed bad states part14
// must attribute, each next to a control that must stay ambient, plus the
// parseArgs alias and the watched set against a temp tree.
function probeParseArgs(argv) {
  const savedExit = process.exit;
  const savedErr = process.stderr.write;
  let code = null;
  process.exit = (c) => { code = c; throw new Error('parseArgs-exit-probe'); };
  process.stderr.write = () => true;
  try {
    const o = parseArgs(argv);
    return { exited: false, self_check: o.selfCheck, home_only_ledger_alias: o.homeOnlyLedgerAlias };
  } catch (e) {
    if (code !== null) return { exited: true, code };
    return { exited: true, code: null, threw: String((e && e.message) || e) };
  } finally {
    process.exit = savedExit;
    process.stderr.write = savedErr;
  }
}
function runHomeOnlyProofFixtures(root) {
  const out = {};
  // (a)
  const alias = probeParseArgs(['--self-check', '--home-only-ledger']);
  const unknown = probeParseArgs(['--self-check', '--no-such-flag-part14']);
  out.parse_args_alias = {
    pass: alias.exited === false && alias.self_check === true && alias.home_only_ledger_alias === true,
    alias, control_unknown_flag_exits_2: unknown,
  };
  out.parse_args_alias.pass = out.parse_args_alias.pass && unknown.exited === true && unknown.code === 2;
  // (b)-(e): synthetic snapshots, pure
  const nonce = 'fx' + crypto.randomBytes(5).toString('hex');
  const ids = homeOnlyG11Ids(nonce);
  const g11 = {
    tool_use_id: ids.toolUseId, session_id: ids.sessionId, agent_id: ids.agentId,
    seen_file: '.trigger-seen-' + sha16(ids.sessionId + '\0' + ids.agentId),
    tlog_session: ids.sessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8),
    rel: ids.rel, tags: ['test:g11-alpha-' + nonce, 'test:g11-beta-' + nonce],
  };
  const fxHome = path.join(root, 'part14-fixture-home');
  const markers = homeOnlyMarkers({ nonce, homeDir: path.join(root, 'part14-home'), root, g11 });
  const snap = (text) => ({ sha: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), size: Buffer.byteLength(text), text });
  const seenDir = path.join(fxHome, '.claude');
  const local = path.join(fxHome, '.claude', '.local', 'pmm-recall');
  const ledgerF = path.join(local, 'events-v3-fixture.tsv');
  const tlogF = path.join(local, 'trigger-log-fixture.tsv');
  const oldSeen = path.join(seenDir, '.trigger-seen-' + sha16('fixture-production-session' + '\0'));
  const rowWith = (tu) => LEDGER_V3_COLUMNS.map((c) => ({
    schema_version: '1', ts: '2026-09-23T00:00:00.000Z', sid_sha16: sha16('prod'), agent_sha16: sha16(''),
    tool_use_id: tu, event_kind: 'eligible', trigger_or_gate_id: 'lesson:production-tag', mode: 'intervene',
  }[c] || '')).join('\t');
  const tlogLine = (sess, note) => ['2026-09-23T00:00:00.000Z', sess, 'event', 'Edit', '-', '-', '-', note].join('\t');
  // erratum 2 scaffolding: an existing production queue, and the names a leak
  // would CREATE (queue, receipts, pending). A queue row as the gate writes it
  // carries desensitized paths and hashes only.
  const U = 'Us' + 'ers';
  const queueF = path.join(local, 'queue-Prod.tsv');
  const queueNewF = path.join(local, 'queue-X.tsv');
  const receiptsNewF = path.join(local, 'receipts-' + sha16('another-production-session') + '-' + sha16('') + '.log');
  const pendingNewF = path.join(local, 'pending', crypto.createHash('sha256').update('production-key', 'utf8').digest('hex') + '.json');
  const queueLine = (p) => ['2026-09-23T00:00:00.000Z', 'B', sha16('cmd'), p, 'would-warn'].join('\t');
  // the gate's receipt line (ts, class, path, tool_use_id, rc) and pending
  // payload (verbatim tool_use_id) -- the content erratum 3 relies on
  const receiptLine = (tu) => ['2026-09-23T00:00:00.000Z', 'created-nonempty', 'C:/' + U + '/_/elsewhere/r.txt', tu, '0'].join('\t');
  const pendingPayload = (tu) => Object.assign({ cmd: 'npm test > out.txt', targets: [] }, { ['tool_use' + '_id']: tu });
  const baseSnap = {
    [ledgerF]: snap(LEDGER_V3_COLUMNS.join('\t') + '\n' + rowWith('toolu_01productionrow') + '\n'),
    [tlogF]: snap(tlogLine('a1b2c3d4', 'matched=1') + '\n'),
    [oldSeen]: snap('lesson:production-tag\n'),
    [queueF]: snap(queueLine('C:/' + U + '/_/Desktop/X/a.txt') + '\n'),
  };
  const withChange = (f, text) => Object.assign({}, baseSnap, { [f]: snap(text) });
  const one = (label, after, wantAttributable, before) => {
    const r = attributeChanges(before || baseSnap, after, markers);
    const pass = wantAttributable ? r.attributable.length === 1 && r.ambient.length === 0
      : r.attributable.length === 0 && r.ambient.length === 1;
    return { label, want: wantAttributable ? 'attributable' : 'ambient', pass,
      attributable: r.attributable.map((e) => e.change + ' ' + path.basename(e.file) + ' ' + e.markers.join(',')),
      ambient: r.ambient.map((e) => e.change + ' ' + path.basename(e.file)) };
  };
  const newSeen = path.join(seenDir, g11.seen_file);
  const otherSeen = path.join(seenDir, '.trigger-seen-' + sha16('another-production-session' + '\0'));
  const nosessSeen = path.join(seenDir, '.trigger-seen-' + sha16('nosess' + '\0' + ''));
  const leaks = [
    // (f) 1: a new seen file named by the computed hash, holding a tag with no marker in it
    one('new seen file named sha16(sid||NUL||agent) (content carries no marker)', withChange(newSeen, 'lesson:production-tag\n'), true),
    one('control: same content under a production-shaped seen name', withChange(otherSeen, 'lesson:production-tag\n'), false),
    one('new seen file under the nosess fallback name', withChange(nosessSeen, 'lesson:production-tag\n'), true),
    // (f) 2: a ledger row carrying the G11 tool_use_id
    one('real ledger + one row carrying the G11 tool_use_id',
      withChange(ledgerF, baseSnap[ledgerF].text + rowWith(g11.tool_use_id) + '\n'), true),
    one('control: real ledger + one production row',
      withChange(ledgerF, baseSnap[ledgerF].text + rowWith('toolu_01anotherproductionrow') + '\n'), false),
    // (f) 3: a new line in the .local trigger-log -- the no-repo form, whose
    // only identifier is the tool's 8-character session column
    one('.local trigger-log + a no-repo line from the G11 session',
      withChange(tlogF, baseSnap[tlogF].text + tlogLine(g11.tlog_session, 'no-repo matched=0') + '\n'), true),
    one('control: .local trigger-log + a production no-repo line',
      withChange(tlogF, baseSnap[tlogF].text + tlogLine('9f8e7d6c', 'no-repo matched=0') + '\n'), false),
    // deletions: by name only (production deletes stale seen files itself)
    one('deletion of the computed seen file', Object.assign({}, baseSnap), true,
      Object.assign({}, baseSnap, { [newSeen]: snap('x\n') })),
    one('control: deletion of a production seen file', (() => { const a = Object.assign({}, baseSnap); delete a[oldSeen]; return a; })(), false),
    // erratum 2 (k) (Opus B1 LOW-1, the L2 leak) as narrowed by erratum 3: a
    // CREATED MACHINE-NAMED watched file is attributable without any content
    // marker; a created pending/receipts file is attributable by marker only
    one('e2 (k): only a new queue-X.tsv is created (production-shaped content, no marker)',
      withChange(queueNewF, queueLine('C:/' + U + '/_/elsewhere/r.txt') + '\n'), true),
    one('e3 (k): a new policy.json is created (no marker)',
      withChange(path.join(local, 'policy.json'), '{}\n'), true),
    one('e3 control: a new receipts-<sid>-<agent>.log without a marker (production creates these) is ambient',
      withChange(receiptsNewF, receiptLine('toolu_01productionrow') + '\n'), false),
    one('e3 control: a new pending/<key>.json without a marker (created at Pre, consumed at Post) is ambient',
      withChange(pendingNewF, JSON.stringify({ cmd: 'npm test > out.txt', targets: [] })), false),
    one('e3: a new receipts-<sid>-<agent>.log carrying the G11 tool_use_id is attributable',
      withChange(receiptsNewF, receiptLine(g11.tool_use_id) + '\n'), true),
    one('e3: a new pending/<key>.json carrying the G11 tool_use_id is attributable',
      withChange(pendingNewF, JSON.stringify(pendingPayload(g11.tool_use_id))), true),
    // erratum 2 (c): the run root basename survives desensitize() -- a row in
    // an EXISTING queue whose only trace of the proof is that path segment
    one('e2 (c): existing queue + a row carrying only the desensitized run-root path',
      withChange(queueF, baseSnap[queueF].text + queueLine('C:/' + U + '/_/AppData/Local/Temp/' + path.basename(root) + '/part14-cases/files/r.txt') + '\n'), true),
    one('control: existing queue + a production row (desensitized foreign path)',
      withChange(queueF, baseSnap[queueF].text + queueLine('C:/' + U + '/_/Desktop/X/r.txt') + '\n'), false),
  ];
  out.attribution = { pass: leaks.every((l) => l.pass), markers_used: markers.length, cases: leaks };
  // (f) realRootTripleFiles(homeDir) in a temp tree
  const tree = path.join(root, 'part14-watch-tree');
  const tl = path.join(tree, '.claude', '.local', 'pmm-recall');
  const want = [
    path.join(tl, 'events-v3-X.tsv'), path.join(tl, 'quarantine-X.tsv'), path.join(tl, 'queue-X.tsv'),
    path.join(tl, 'policy.json'), path.join(tl, 'trigger-log-X.tsv'),
    path.join(tree, '.claude', '.trigger-seen-0123456789abcdef'),
    path.join(tree, '.claude', 'memory', 'dreams', 'trigger-log-X.tsv'),
    // erratum 2 (b): receipts-*.log and pending/* under the recall root
    path.join(tl, 'receipts-a-b.log'), path.join(tl, 'pending', '0123abcd.json'),
    path.join(tl, 'pending', '0123abcd.json.processing.lease1'),
  ];
  const notWanted = [
    path.join(tl, 'labels-X.tsv'), path.join(tl, 'queue-X.tsv.discarded-20260917'),
    path.join(tl, 'receipts-a-b.log.bak'), path.join(tree, '.claude', 'memory', 'dreams', 'trigger-log.tsv'),
  ];
  for (const f of want.concat(notWanted)) writeFileAtomicText(f, 'x\n');
  const listed = realRootTripleFiles(tree);
  const missing = want.filter((f) => listed.indexOf(f) < 0);
  const extra = listed.filter((f) => want.indexOf(f) < 0);
  out.watched_set = {
    pass: missing.length === 0 && extra.length === 0,
    local_trigger_log_listed: listed.indexOf(path.join(tl, 'trigger-log-X.tsv')) >= 0,
    missing: missing.map((f) => path.relative(tree, f)), extra: extra.map((f) => path.relative(tree, f)),
  };
  out.pass = out.parse_args_alias.pass && out.attribution.pass && out.watched_set.pass;
  return out;
}
function diffSnapshots(before, after) {
  const changed = [];
  for (const f of Object.keys(after)) {
    if (before[f] === undefined) changed.push({ file: f, change: 'created' });
    else if (before[f] !== after[f]) changed.push({ file: f, change: 'modified' });
  }
  for (const f of Object.keys(before)) if (after[f] === undefined) changed.push({ file: f, change: 'deleted' });
  return changed;
}
// contract v2.26 home_only_proof (a)-(e). v2.25's part14 could not turn red:
// its G11 sub-case sat behind a flag parseArgs rejected (rc 2), the watched
// set missed the migrated .local trigger-log, and G11's ids were not markers.
// Now: one case per section runs with ONLY HOME+USERPROFILE redirected (no
// PMM_*), every id is a run-nonce id, and a real-tree change is red exactly
// when it carries a marker (in its added bytes or its file name).
//  * The gate sub-cases run the PRODUCTION gate (opts.gate): the reference
//    stub resolves no root at all without PMM_RECALL_ROOT, so a stub run could
//    never have written anywhere and proved nothing about the guards.
//  * Liveness is asserted, not assumed: G11 must have written its rows, seen
//    lines and telemetry under its fixture HOME, and the gate must have
//    written at least one nonce-bearing row under the temp HOME -- a proof
//    whose subjects wrote nothing cannot show that they wrote to the right
//    place. The case VERDICTS stay unasserted (with no PMM_* the gate writes
//    under the temp HOME, not the per-case state dir the executors read).
//  * Ambient changes (this host's own hooks writing the real ledger during
//    the proof) are reported, never a red (home_only_proof (e)).
async function runHomeOnlyRealRootProof(contract, root, gateCmd, casesById) {
  const pick = (list, id) => (list || []).find((c) => c.id === id) || (list || [])[0];
  const fixtures = runHomeOnlyProofFixtures(root);
  const nonce = crypto.randomBytes(6).toString('hex');
  const g11Ids = homeOnlyG11Ids(nonce);
  const chosen = [
    { section: 'cases', tc: pick(contract.cases, 'A01') },
    { section: 'lifecycle_cases', tc: pick(contract.lifecycle_cases, 'L01') },
    { section: 'silence_cases', tc: pick(contract.silence_cases, 'Z11') },
    { section: 'ledger_cases', tc: { id: 'G11', ledger: true } },
  ];
  const homeDir = path.join(root, 'part14-home');
  mkdirp(homeDir);
  const before = realRootTripleSnapshot();
  const ran = [];
  let g11 = null;
  HOME_ONLY.active = true;
  HOME_ONLY.homeDir = homeDir;
  ID_NONCE.active = true;
  ID_NONCE.nonce = nonce;
  ID_NONCE.n = 0;
  try {
    for (const entry of chosen) {
      if (!entry.tc) { ran.push({ section: entry.section, id: null, note: 'no case in this section' }); continue; }
      const ctx = makeCtx({ gate: gateCmd, root: path.join(root, 'part14-' + entry.section), mutant: 'none', conventions: contract.conventions });
      let r;
      try {
        if (entry.tc.ledger) {
          ctx.toolOverrides = { g11: { homeOnly: true, ids: g11Ids } };
          r = checkTriggerRecallDualWrite(ctx);
          g11 = r;
        } else if (entry.section === 'lifecycle_cases') r = await execLifecycleCase(entry.tc, ctx);
        else if (entry.section === 'silence_cases') r = await execSilenceCase(entry.tc, ctx, casesById);
        else r = execNormalCase(entry.tc, ctx);
      } catch (e) { r = { pass: false, reason: 'executor threw: ' + String((e && e.message) || e) }; }
      ran.push({ section: entry.section, id: entry.tc.id, tool_use_id: (r.actual && r.actual.tool_use_id) || null,
        case_verdict: { pass: r.pass, reason: String(r.reason || '').slice(0, 80) } });
    }
  } finally {
    HOME_ONLY.active = false;
    HOME_ONLY.homeDir = null;
    ID_NONCE.active = false;
    ID_NONCE.nonce = null;
  }
  const after = realRootTripleSnapshot();
  const markers = homeOnlyMarkers({ nonce, homeDir, root, g11: g11 && g11.actual })
    .concat(ran.map((x) => x.tool_use_id).filter(Boolean));
  const { attributable, ambient } = attributeChanges(before, after, markers);
  const g11Home = (g11 && g11.home_only) || {};
  const g11Live = !!g11 && g11Home.rows_written_under_fixture_home > 0 &&
    g11Home.seen_lines_under_fixture_home > 1 && g11Home.log_lines_under_fixture_home > 0;
  const tempRoot = path.join(homeDir, '.claude', '.local', 'pmm-recall');
  const gateRows = readLedgerRows(tempRoot).rows.filter((r) => String(r.tool_use_id || '').indexOf(nonce) >= 0);
  const allRan = ran.filter((x) => x.id).length === chosen.length;
  return {
    pass: fixtures.pass && attributable.length === 0 && allRan && g11Live && gateRows.length > 0,
    fixtures,
    real_tree_home: REAL_TREE_HOME,
    files_watched: Object.keys(before).length,
    watched_set: REAL_ROOT_WATCH.map((w) => w.sub.join('/') + ' ' + String(w.re)),
    attributable_changes: attributable,
    ambient_changes: ambient,
    ledger_sub_case: 'run by default (contract v2.26 home_only_proof (a)); --home-only-ledger is a no-op alias',
    nonce,
    gate: gateCmd,
    liveness: {
      g11_wrote_under_fixture_home: g11Live,
      g11_home_only: g11Home,
      g11_verdict_under_home_only: g11 ? { pass: g11.pass, reason: String(g11.reason || '').slice(0, 160) } : null,
      gate_nonce_rows_under_temp_home: gateRows.length,
      gate_nonce_row_kinds: [...new Set(gateRows.map((r) => r.event_kind))],
    },
    markers,
    sections_run: ran,
    note: 'asserted: fixtures (parseArgs alias, attribution of the three constructed leaks, watched set), no attributable change in the real tree, every section ran, and both subjects wrote under the temp HOME; the gate case verdicts are NOT asserted (with no PMM_* the gate writes under the temp HOME, not the per-case state dir the executors read)',
  };
}

// Contract v2.25 erratum 2 (N2) asks the self-check to prove that an
// operator shell exporting PMM_HOME cannot turn Z22/G02 red. The proof is
// differential and direct at once: Z22 is run twice -- once clean, once with
// PMM_HOME pointing at a garbage directory in the RUNNER's own environment --
// and must give the same verdict; G02's property (the default production
// root under the runner's HOME is unchanged) is measured around the
// poisoned run; and the garbage directory must stay empty, because a child
// that inherited PMM_HOME would have resolved every root into it.
async function runPmmEnvStripProof(contract, root, gateSh, casesById) {
  const z22 = (contract.silence_cases || []).find((c) => c.id === 'Z22');
  const a01 = (contract.cases || []).find((c) => c.id === 'A01');
  if (!z22 || !a01) return { pass: false, reason: 'Z22 or A01 missing from this contract' };
  const garbage = path.join(root, 'part15-garbage-pmm-home');
  mkdirp(garbage);
  const mk = (name) => makeCtx({ gate: 'bash ' + gateSh, root: path.join(root, 'part15-' + name), mutant: 'none', conventions: contract.conventions });
  const clean = await execSilenceCase(z22, mk('clean'), casesById);
  const saved = Object.prototype.hasOwnProperty.call(process.env, 'PMM_HOME') ? process.env.PMM_HOME : undefined;
  process.env.PMM_HOME = garbage;
  const manifestBefore = hashTreeManifest(DEFAULT_PRODUCTION_ROOT);
  let poisoned; let a01Poisoned;
  try {
    const ctx = mk('poisoned');
    poisoned = await execSilenceCase(z22, ctx, casesById);
    a01Poisoned = execNormalCase(a01, ctx);
  } finally {
    if (saved === undefined) delete process.env.PMM_HOME; else process.env.PMM_HOME = saved;
  }
  const manifestAfter = hashTreeManifest(DEFAULT_PRODUCTION_ROOT);
  const garbageFiles = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_e) { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else garbageFiles.push(p); } };
  walk(garbage);
  const g02Ok = manifestsEqual(manifestBefore, manifestAfter);
  // contract v2.26 home_only_proof (g) (Opus acceptance MEDIUM-P1: the Z22
  // differential above is vacuous -- the reference gate stub never reads
  // PMM_HOME, so a childEnvBase() that stops stripping PMM_* still passed):
  // an env-echo reference stub reports what a child actually sees while the
  // RUNNER's environment carries PMM_HOME and PMM_RECALL_ROOT. The real env
  // builders must hand it neither; the no-strip mutation of childEnvBase()
  // is carried as a negative fixture and must turn the same check red.
  const echo = runEnvEchoProbes(path.join(root, 'part15-echo'));
  return {
    pass: echo.pass && clean.pass === poisoned.pass && a01Poisoned.pass === true && g02Ok && garbageFiles.length === 0,
    env_echo_stub: echo,
    // Z22's ABSOLUTE verdict depends on the gate (the reference stub does not
    // implement the default-root seam rejection, so it is red here with or
    // without PMM_HOME); kept as a report, the teeth are env_echo_stub above.
    z22_verdict_unchanged_by_pmm_home: clean.pass === poisoned.pass,
    pmm_home_preset_to: garbage,
    z22_clean: { pass: clean.pass, reason: clean.reason },
    z22_with_pmm_home: { pass: poisoned.pass, reason: poisoned.reason },
    a01_with_pmm_home: { pass: a01Poisoned.pass, reason: a01Poisoned.reason },
    g02_default_root_unchanged: g02Ok,
    files_written_under_garbage_pmm_home: garbageFiles.slice(0, 8),
  };
}

function writeEnvEchoStub(dir) {
  mkdirp(dir);
  const cjsPath = path.join(dir, 'env-echo-stub.cjs');
  const shPath = path.join(dir, 'env-echo-stub.sh');
  fs.writeFileSync(cjsPath, [
    "'use strict';",
    '// Reference stub generated by --self-check part15: reports the PMM_* view',
    '// of its own environment and nothing else.',
    'const e = process.env;',
    "const keys = Object.keys(e).filter((k) => /^PMM_/.test(k)).sort();",
    'process.stdout.write(JSON.stringify({',
    '  PMM_HOME: e.PMM_HOME === undefined ? null : e.PMM_HOME,',
    '  PMM_RECALL_ROOT: e.PMM_RECALL_ROOT === undefined ? null : e.PMM_RECALL_ROOT,',
    '  pmm_keys: keys,',
    '}));',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(shPath, '#!/usr/bin/env bash\nexec node "' + cjsPath.replace(/\\/g, '/') + '"\n', 'utf8');
  return { cjsPath, shPath };
}
// Runs the echo stub once per env builder while the runner's OWN environment
// exports PMM_HOME / PMM_RECALL_ROOT pointing at garbage directories.
function runEnvEchoProbes(dir) {
  const stub = writeEnvEchoStub(dir);
  const garbageHome = path.join(dir, 'garbage-pmm-home');
  const garbageRoot = path.join(dir, 'garbage-pmm-recall-root');
  const stateDir = path.join(dir, 'state');
  mkdirp(garbageHome); mkdirp(garbageRoot); mkdirp(stateDir);
  const stdinPath = path.join(dir, 'empty.stdin');
  fs.writeFileSync(stdinPath, '');
  const saved = {};
  for (const k of ['PMM_HOME', 'PMM_RECALL_ROOT']) saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
  const see = (label, builder) => {
    const r = runGateProcess(['bash', stub.shPath], {
      stdinPath, cwd: dir, env: builder(), ioDir: path.join(dir, 'io'), label: 'echo-' + label, nonHook: true,
    });
    let seen = null;
    try { seen = JSON.parse(fs.readFileSync(r.stdoutPath, 'utf8')); } catch (_e) { seen = null; }
    return { rc: r.rc, spawn_error: r.spawnError, seen };
  };
  let viaChild; let viaBuild; let viaMutant;
  process.env.PMM_HOME = garbageHome;
  process.env.PMM_RECALL_ROOT = garbageRoot;
  try {
    viaChild = see('childEnvBase', () => childEnvBase());
    viaBuild = see('buildEnv', () => buildEnv({ stateDir, mutant: 'none' }));
    // negative fixture: the no-strip mutation of childEnvBase()
    viaMutant = see('no-strip-mutation', () => Object.assign({}, process.env));
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  const ran = (p) => p.rc === 0 && !p.spawn_error && p.seen !== null;
  // the check applied to the real childEnvBase AND to the mutation
  const sawNothing = (p) => ran(p) && p.seen.PMM_HOME === null && p.seen.PMM_RECALL_ROOT === null && p.seen.pmm_keys.length === 0;
  const buildOk = ran(viaBuild) && viaBuild.seen.PMM_HOME === null &&
    path.resolve(String(viaBuild.seen.PMM_RECALL_ROOT)) === path.resolve(stateDir) &&
    viaBuild.seen.pmm_keys.every((k) => k === 'PMM_RECALL_ROOT' || k === 'PMM_RECALL_TAG');
  const mutantRed = ran(viaMutant) && !sawNothing(viaMutant) && viaMutant.seen.PMM_HOME === garbageHome;
  return {
    pass: sawNothing(viaChild) && buildOk && mutantRed,
    runner_env_preset: { PMM_HOME: garbageHome, PMM_RECALL_ROOT: garbageRoot },
    child_env_base: { pass: sawNothing(viaChild), ...viaChild },
    build_env: { pass: buildOk, expected_recall_root: stateDir, ...viaBuild },
    negative_no_strip_mutation: { must_be_red: true, red: mutantRed, ...viaMutant },
  };
}

async function runSelfCheck(opts) {
  const { contract, contractPath } = loadContract(opts.contract);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgv2-selfcheck-'));
  const stubDir = path.join(root, 'stub');
  const { shPath } = generateStubGate(stubDir);
  const { shPath: noSeamSh } = generateNoSeamStubGate(stubDir);
  const subset = selfCheckSubset(contract);

  // conventions.lifecycle_executors["closed stdout"] (v2.8) mandates the
  // first of these BEFORE L09 runs; the Z01 one is run here too so a single
  // --self-check reports both host verdicts, even though the silence cases
  // themselves only execute in a full run. preflightEnvFrom() points
  // HOME/USERPROFILE/PMM_RECALL_ROOT at a runner-owned temp dir, so neither
  // probe can reach a real production root.
  const closedStdoutPreflight = preflightClosedStdoutRecipe(process.env);
  const closedStdinPreflight = preflightClosedStdinRecipe(process.env);
  const l09Scored = closedStdoutPreflight.pass;

  const part1Root = path.join(root, 'part1');
  const ctx1 = makeCtx({ gate: 'bash ' + shPath, root: part1Root, mutant: 'none', conventions: contract.conventions });
  // v2.19: part1 is the segment that proves the reference stub is GREEN, so a
  // case must run through the SAME executor it gets in a real round. P03 used
  // to be routed to execNormalCase here (every other dispatch site already
  // asked isPolicyCaseMode first), so its policy assertions -- arm stability,
  // run_provenance, and now the gates[B]=shadow sub-case -- were exercised
  // only in the mutant rounds, where every case is expected to be red anyway:
  // a green that could not go red. Found while falsifying the v2.19
  // shadow-gate rule against the stub.
  const part1Results = subset.map((tc) => (isPolicyCaseMode(tc.mode)
    ? execPolicyRandomizedCase(tc, ctx1) : execNormalCase(tc, ctx1)));
  const part1AllGreen = part1Results.every((r) => r.pass);

  // Item 8 (v2.5) + MEDIUM-10 (Opus r6): the lifecycle subset runs in ONE
  // shared state dir, in order, so the residue of the earlier cases is
  // present when the later ones are evaluated -- that is precisely the
  // condition under which v2.6's GLOBAL pending count made L15/L15b/L20
  // unsatisfiable (HIGH-5). L10/L11 additionally prove the row-count
  // machinery (aggregateLedgerRows + evaluateLifecycleExpectation) with a
  // stub that has no lifecycle-specific code for them at all.
  const part1bCases = selfCheckLifecycleSubset(contract, SELF_CHECK_LIFECYCLE_IDS);
  const part1bRoot = path.join(root, 'part1b-lifecycle');
  const ctx1b = makeCtx({ gate: 'bash ' + shPath, root: part1bRoot, mutant: 'none', conventions: contract.conventions });
  const part1bResults = [];
  for (const tc of part1bCases) part1bResults.push(await execLifecycleCase(tc, ctx1b));
  const l09Result = part1bResults.find((r) => r.id === 'L09');
  // HIGH-2's actual assertion: L09 must have been executed through
  // runGateProcessClosedStdout (one step, recorded by the executor), not
  // through the ordinary path. This is the half that v2.5's "cleaned the
  // prose" fix silently lost.
  const l09Routed = !!(l09Result && l09Result.actual && Array.isArray(l09Result.actual.closed_stdout_steps) &&
    l09Result.actual.closed_stdout_steps.length === 1);
  // L09's EXPECTATION is scored exactly when the preflight proved the recipe
  // makes writes to fd 1 fail on this host; otherwise the case is reported
  // unscored, carrying the preflight's verbatim observation, rather than
  // being counted red for an environment defect (contract
  // lifecycle_executors["closed stdout"], v2.8).
  const part1bScored = l09Scored ? part1bResults : part1bResults.filter((r) => r.id !== 'L09');
  const part1bAllGreen = part1bScored.every((r) => r.pass) && l09Routed;

  const part1MutRoot = path.join(root, 'part1-mutant-null');
  const ctx1m = makeCtx({ gate: 'bash ' + shPath, root: part1MutRoot, mutant: 'null', conventions: contract.conventions });
  const part1MutResults = [];
  for (const tc of subset) {
    const before = probeLineCount(ctx1m.stateDir);
    const r = execNormalCase(tc, ctx1m);
    const after = probeLineCount(ctx1m.stateDir);
    const derivedFail = deriveNullFail(tc);
    part1MutResults.push({ id: tc.id, pass: r.pass, derivedFail, probeGrew: after > before });
  }
  const part1MutSetsEqual = part1MutResults.every((r) => (!r.pass) === r.derivedFail);
  const part1ProbeOk = part1MutResults.every((r) => r.probeGrew);

  const part2Root = path.join(root, 'part2-noseam');
  const ctx2 = makeCtx({ gate: 'bash ' + noSeamSh, root: part2Root, mutant: 'null', conventions: contract.conventions });
  const part2ProbeCounts = subset.map((tc) => {
    const before = probeLineCount(ctx2.stateDir);
    execNormalCase(tc, ctx2);
    const after = probeLineCount(ctx2.stateDir);
    return after > before;
  });
  const part2ProbeAllGrew = part2ProbeCounts.every(Boolean);
  const part2CorrectlyRed = !part2ProbeAllGrew;

  const tamperedContract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const a01 = tamperedContract.cases.find((c) => c.id === 'A01');
  a01.expect.gates = [{ gate: 'A', confidence: 'recurrence-candidate' }];
  const tamperedPath = path.join(root, 'tampered-contract.json');
  fs.writeFileSync(tamperedPath, JSON.stringify(tamperedContract), 'utf8');
  const part3Root = path.join(root, 'part3-tampered');
  const ctx3 = makeCtx({ gate: 'bash ' + shPath, root: part3Root, mutant: 'none', conventions: contract.conventions });
  const tamperedSubset = tamperedContract.cases.filter((c) => selfCheckSubset(contract).some((s) => s.id === c.id));
  const part3Results = tamperedSubset.map((tc) => execNormalCase(tc, ctx3));
  const a01Result = part3Results.find((r) => r.id === 'A01');
  const othersStillGreen = part3Results.filter((r) => r.id !== 'A01').every((r) => r.pass);
  const part3Correct = a01Result && a01Result.pass === false && othersStillGreen;

  // Part 4: prove the conformance interpreter discriminates, using the
  // pre-registered blind-parser mutant as the known-bad oracle (see
  // runConformanceUnderBlindMutant for why the production parser cannot be
  // that oracle). The production parser is still run, but only REPORTED --
  // its 104/104 verdict is asserted by runner_duties/G08 in the production
  // round, not here.
  const blindConformance = runConformanceUnderBlindMutant(opts.conformance, root);
  const blindRed = blindConformance.results.filter((r) => !r.pass).length;
  const conformance = runParserConformance(opts.conformance, opts.parserModule);
  const realGreen = conformance.results.filter((r) => r.pass).length;
  // Discriminating means BOTH halves: the interpreter reds a known-bad parse
  // (so it is not vacuously passing everything) AND something somewhere passes
  // (so it is not vacuously failing everything). The second half deliberately
  // accepts EITHER a green under the blind oracle OR a green under the real
  // parser -- keying it on "blind must leave some case green" would be the
  // mirror image of the v2.9 time bomb, red on any fixture whose every case
  // asserts a field the blind transform touches.
  const part4Discriminates = blindRed > 0 &&
    (blindRed < blindConformance.results.length || realGreen > 0);

  // Part 5 (v2.6 item 1): duplicate top-level function name scan -- the
  // actual guard against the HIGH-1 class of regression (a rewritten
  // deriveBlindParserFail silently shadowed by a stale duplicate).
  const dupScan = scanForDuplicateTopLevelFunctionNames();

  // Part 6/7 (MEDIUM-10, Opus r6): full mutant rounds -- derived vs actual
  // failing ids, per-case sentinels, probe growth -- against the stub, over
  // a subset that contains A29 (the always round's HIGH-1 case) and L10 (the
  // blind round's HIGH-4/HIGH-6 case). v2.6 ran the null mutant only, over
  // four normal cases, so neither HIGH could have shown up here.
  const mutantLifecycleIds = l09Scored
    ? SELF_CHECK_MUTANT_LIFECYCLE_IDS
    : SELF_CHECK_MUTANT_LIFECYCLE_IDS.filter((id) => id !== 'L09');
  const mutantSubset = [...selfCheckSubset(contract), ...selfCheckLifecycleSubset(contract, mutantLifecycleIds)];
  const alwaysRound = await runSelfCheckMutantRound({
    gate: 'bash ' + shPath, root: path.join(root, 'part6-mutant-always'),
    mutant: 'always', cases: mutantSubset, conventions: contract.conventions,
  });
  const blindRound = await runSelfCheckMutantRound({
    gate: 'bash ' + shPath, root: path.join(root, 'part7-mutant-blind-parser'),
    mutant: 'blind-parser', cases: mutantSubset, conventions: contract.conventions,
  });
  const part6Ok = alwaysRound.sets_equal && alwaysRound.sentinel_ok && alwaysRound.probe_ok;
  const part7Ok = blindRound.sets_equal && blindRound.sentinel_ok && blindRound.probe_ok;

  // Part 8 (lesson 4 + Opus r7 MEDIUM-5): every expect key the contract uses
  // has a declared behavior under each mutant transform AND an implemented
  // evaluation in the family that uses it.
  const mutantKeyCoverage = checkMutantTransformKeyCoverage(contract);
  const expectKeyCoverage = checkExpectKeyEvaluationCoverage(contract);
  const keyCoverage = {
    pass: mutantKeyCoverage.pass && expectKeyCoverage.pass,
    mutant_transform_keys: mutantKeyCoverage,
    expect_key_evaluation: expectKeyCoverage,
  };

  const selfCheckCasesById = {};
  for (const c of contract.cases || []) selfCheckCasesById[c.id] = c;
  const deadDut = await runDeadDutProof(contract, root, selfCheckCasesById);
  const targetedLiveness = await runTargetedLivenessProof(contract, root, stubDir);
  const ledgerToolAssertions = runLedgerToolAssertionProof(contract, root, shPath);
  // part13 (v2.26): the tree scan AND the fixtures that prove the scanner
  // reds the two historical leak lines; either failing is a red.
  const homeScanTree = scanHomeResolution();
  const homeScanFixtures = runHomeScanFixtures();
  const homeResolution = Object.assign({}, homeScanTree, {
    pass: homeScanTree.pass && homeScanFixtures.pass, tree_clean: homeScanTree.pass, fixtures: homeScanFixtures,
  });
  // part14 (v2.26): HOME-only proof against the PRODUCTION gate (opts.gate)
  // and the real pmm-trigger-recall; see runHomeOnlyRealRootProof.
  const homeOnlyRealRoot = await runHomeOnlyRealRootProof(contract, root, opts.gate, selfCheckCasesById);
  const pmmEnvStrip = await runPmmEnvStripProof(contract, root, shPath, selfCheckCasesById);
  // part16 (v2.26): conventions.selftest_id_convention static scan.
  const selftestIds = scanSelftestIds();
  const clockScope = await runClockScopeProof(contract, root, shPath);
  const overallOk = part1AllGreen && part1bAllGreen && part1MutSetsEqual && part1ProbeOk &&
    part2CorrectlyRed && part3Correct && part4Discriminates && dupScan.pass &&
    part6Ok && part7Ok && keyCoverage.pass && deadDut.pass && clockScope.pass && targetedLiveness.pass &&
    ledgerToolAssertions.pass && homeResolution.pass && homeOnlyRealRoot.pass && pmmEnvStrip.pass &&
    selftestIds.pass;

  return {
    self_check: {
      root,
      // Not a scored segment: the two host verdicts the fd recipes depend on,
      // reported verbatim so "all green" can never hide a recipe that silently
      // stopped producing the condition it names.
      host_recipe_preflights: {
        closed_stdout: closedStdoutPreflight,
        closed_stdin: closedStdinPreflight,
        note: 'closed_stdout gates whether L09 is scored (contract v2.8); closed_stdin gates whether Z01 really exercises a failing read(0) or falls back to the old EOF behavior (runner-internal: the contract pins Z01 input, not its recipe)',
      },
      part1_stub_all_green: { pass: part1AllGreen, results: part1Results.map((r) => ({ id: r.id, pass: r.pass, reason: r.reason })) },
      part1b_lifecycle_subset: {
        pass: part1bAllGreen,
        scored_ids: part1bScored.map((r) => r.id),
        l09_closed_stdout_routing_asserted: l09Routed,
        l09_scored: l09Scored,
        closed_stdout_preflight: closedStdoutPreflight,
        l09_expectation_unscored_reason: l09Scored ? null
          : 'closed-stdout preflight failed on this host: ' + closedStdoutPreflight.recipe +
            ' -> child reported ' + closedStdoutPreflight.child_observation +
            ' (required ' + closedStdoutPreflight.required + '). L09 reported unscored per contract' +
            ' conventions.lifecycle_executors["closed stdout"].',
        results: part1bResults.map((r) => ({
          id: r.id, pass: r.pass, scored: part1bScored.some((s) => s.id === r.id), reason: r.reason,
          expected: r.expected, actual: r.actual,
        })),
      },
      part1_null_mutant_over_subset: { sets_equal: part1MutSetsEqual, probe_ok: part1ProbeOk, per_case: part1MutResults },
      part2_no_seam_probe_goes_red: { correctly_red: part2CorrectlyRed, per_case_probe_grew: subset.map((tc, i) => ({ id: tc.id, probe_grew: part2ProbeCounts[i] })) },
      part3_tampered_case_goes_red: { correct: part3Correct, a01: a01Result, others_still_green: othersStillGreen },
      part4_conformance_interpreter_discriminates: {
        pass: part4Discriminates,
        oracle: blindConformance.source,
        total: blindConformance.results.length,
        red: blindRed,
        green: blindConformance.results.length - blindRed,
        sample_reds: blindConformance.results.filter((r) => !r.pass).slice(0, 5),
        // Report-only: whatever the production parser scores today. It must be
        // all of them once the parser matches the pinned fixture; either way it does NOT
        // gate this segment (that assertion lives in ledger G08).
        real_parser_green: realGreen,
        real_parser_total: conformance.results.length,
        note: 'the discriminate proof uses the pre-registered known-bad parse so that a CORRECT production parser can never turn this segment red',
      },
      part5_no_duplicate_function_names: dupScan,
      part6_always_mutant_over_subset: { pass: part6Ok, ...alwaysRound },
      part7_blind_parser_mutant_over_subset: { pass: part7Ok, ...blindRound },
      part8_mutant_transform_key_coverage: keyCoverage,
      part9_dead_dut_proof: deadDut,
      part10_clock_scope_proof: clockScope,
      part11_targeted_liveness_proof: targetedLiveness,
      part12_ledger_tool_assertion_proof: ledgerToolAssertions,
      part13_home_resolution_scan: homeResolution,
      part14_home_only_real_root_proof: homeOnlyRealRoot,
      part15_pmm_env_strip_proof: pmmEnvStrip,
      part16_selftest_id_scan: selftestIds,
      // one line per scored segment, so a red is findable without reading
      // every nested report above
      segment_verdicts: {
        part1: part1AllGreen, part1b: part1bAllGreen, part1_null: part1MutSetsEqual && part1ProbeOk,
        part2: part2CorrectlyRed, part3: part3Correct, part4: part4Discriminates, part5: dupScan.pass,
        part6: part6Ok, part7: part7Ok, part8: keyCoverage.pass, part9: deadDut.pass, part10: clockScope.pass,
        part11: targetedLiveness.pass, part12: ledgerToolAssertions.pass, part13: homeResolution.pass,
        part14: homeOnlyRealRoot.pass, part15: pmmEnvStrip.pass, part16: selftestIds.pass,
      },
      overall_ok: overallOk,
    },
  };
}

// ===========================================================================
// main
// ===========================================================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let report;
  let exitCode = 0;

  try {
    if (opts.selfCheck) {
      const sc = await runSelfCheck(opts);
      report = sc;
      exitCode = sc.self_check.overall_ok ? 0 : 1;
    } else if (opts.mutant !== 'none') {
      const mr = await runMutantRound(opts);
      report = { run: { contract: opts.contract, gate: opts.gate, root: mr.ctx.root, mutant: opts.mutant, nonce: mr.nonce }, mutant_round: mr.mutant_round };
      exitCode = (mr.mutant_round.sets_equal && mr.mutant_round.probe_ok && mr.mutant_round.sentinel_ok) ? 0 : 1;
    } else {
      const br = await runBaselineOrProduction(opts);
      const scoredResults = br.caseResults.filter((r) => !r.report_only);
      const allPass = scoredResults.every((r) => r.pass) &&
        Object.keys(br.ledger).every((k) => br.ledger[k].pass !== false) &&
        br.selfTestCheck.pass;
      const z01Result = br.caseResults.find((r) => r.id === 'Z01');
      report = {
        run: { contract: opts.contract, gate: opts.gate, root: br.ctx.root, mutant: 'none' },
        host_recipe_preflights: br.hostRecipePreflights,
        l09_expectation_unscored_reason: br.l09UnscoredReason,
        silence_events_exempt_ids: br.silenceEventsExemptIds,
        cases: br.caseResults.map((r) => ({ id: r.id, pass: r.pass, report_only: !!r.report_only, expected: r.expected, actual: r.actual, reason: r.reason })),
        ledger: br.ledger,
        production_self_test: br.selfTestCheck,
        single_handler_report: br.singleHandlerReport,
        // A contract artefact the runner cannot read is named ONCE at the top
        // of the report, so a reader does not have to infer it from N cases
        // that all say the same thing.
        contract_defects: (br.ctx && br.ctx.dispositionRules && br.ctx.dispositionRules.defect)
          ? [br.ctx.dispositionRules.defect] : [],
        summary: {
          // LOW-1 (Opus r7): Z01 silently degrades to the old EOF condition if
          // the host cannot produce a failing read(0). That verdict belongs
          // where a reader of "all green" will see it.
          z01_read_failure_verified: z01Result && z01Result.actual
            ? z01Result.actual.z01_read_failure_verified : null,
          closed_stdout_recipe_verified: br.hostRecipePreflights.closed_stdout.pass,
          closed_stdin_recipe_verified: br.hostRecipePreflights.closed_stdin.pass,
          total: br.caseResults.length,
          scored: scoredResults.length,
          report_only: br.caseResults.length - scoredResults.length,
          report_only_ids: br.caseResults.filter((r) => r.report_only).map((r) => r.id),
          passed: scoredResults.filter((r) => r.pass).length,
          failed: scoredResults.filter((r) => !r.pass).length,
        },
      };
      exitCode = allPass ? 0 : 1;
    }
  } catch (e) {
    process.stderr.write('fatal: ' + (e && e.stack || e) + '\n');
    process.exit(2);
  }

  const text = JSON.stringify(report, null, 2);
  if (opts.report) writeFileAtomicText(opts.report, text);
  process.stdout.write(text + '\n');
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = {
  loadContract, computePathVariants, substituteCmd, multisetEqual, extractActualGates,
  aggregateLedgerRows, deriveNullFail, deriveAlwaysFail, deriveBlindParserFail,
  readLedgerRows, runParserConformance, deriveFlatFailForParserCase, deepEqual,
  // v2.26 self-check building blocks, exported so a reviewer can falsify them directly
  parseArgs, scanHomeText, shellCodeLines, scanSelftestIdText, attributeChanges, realRootTripleFiles,
  homeOnlyMarkers, homeOnlyG11Ids,
  // v2.26 erratum 2 building blocks
  randId, z10DirtyToolUseId, idShapeProblems, runnerIdSelfAssertion, scanSelftestSessionText,
  commentLineMask, homeScanErratum2Fixtures, scanSelftestIds, scanHomeResolution,
};
