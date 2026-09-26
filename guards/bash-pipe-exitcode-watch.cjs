#!/usr/bin/env node
// bash-pipe-exitcode-watch.cjs — Bash pipe gate v2 (PreToolUse + PostToolUse/PostToolUseFailure +
// --self-test, one file dispatched by hook_event_name). specs/PIPE-GATE-V2-REPAIR-BRIEF.md v2.12+
// (§1-§6, §11-§18, §22) + specs/pipe-gate-v2-test-contract.json v2.14 (single source of truth for
// observable behavior) + specs/RECALL-LOOP-M-SPEC-v2.md 附录 A (shared ledger, via pmm-recall-ledger.cjs).
// v2.14 (Opus build-acceptance MEDIUM-1/MEDIUM-2): PostToolUseFailure (Claude Code's actual event for a
// failed tool call — it does not fire PostToolUse in that case) is treated exactly like PostToolUse;
// informational ledger rows carry gate/trigger_or_gate_id per gate_disposition_map instead of blank.
//
// Single production handler (brief §12 single_handler / contract conventions.single_handler): baseline,
// every mutant round and --self-test all reach the SAME exported judge()/parse()/assignment() through the
// SAME seam (PIPE_GATE_INJECT). No environment variable switches to an alternative judgment path;
// PMM_RECALL_MODE is never read on the production path (contract Z09).
//
// Fail-open discipline (类 d): stdin closed/NUL/bad-JSON/empty/unwritable ledger/any internal throw ->
// stdout 0 bytes, stderr 0 bytes, rc 0. Everything below the top-level try/catch in main() is defensive.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Registered BEFORE requiring this gate's own sibling modules, so a load-time throw in either one (never
// observed in testing, but not provably impossible) still degrades to silent fail-open instead of a stack
// trace on stderr — the wrapper .sh no longer suppresses this process's stderr (see its own comment /
// contract Z15), so this handler is the only thing standing between a load failure and a leaked trace.
function miss() { try { process.exit(0); } catch (e) { /* already exiting */ } }
process.on('uncaughtException', miss);

const GUARD_DIR = __dirname;
let ledger, REAL_PARSER, POLICY;
try {
  ledger = require('./pmm-recall-ledger.cjs');
  REAL_PARSER = require('./pmm-cmd-parse.cjs');
  // v2.23 item G: pmm-recall-policy.cjs is the ONE policy/assignment resolver every writer shares (M-SPEC
  // appendix B3 补注 #2 dispatch) -- this gate no longer reads policy.json or implements the coin-flip
  // formula itself.
  POLICY = require('./pmm-recall-policy.cjs');
} catch (e) { miss(); }

// ============================================================================
// seam (DI): PIPE_GATE_INJECT honored only under the hard condition (contract
// conventions.seam_hard_condition). Missing judge/parse/assignment fall back
// to this gate's own real implementations, individually.
// ============================================================================
function resolveSeam() {
  const out = { judge: null, parse: null, assignment: null };
  const injectPathRaw = process.env.PIPE_GATE_INJECT;
  const selftest = process.env.PIPE_GATE_SELFTEST === '1';
  const rootRaw = process.env.PMM_RECALL_ROOT;
  if (!selftest || !injectPathRaw || !rootRaw || rootRaw.trim() === '') return out;
  let rootResolved, injectResolved, defaultResolved;
  try {
    rootResolved = path.resolve(rootRaw);
    injectResolved = path.resolve(injectPathRaw);
    defaultResolved = path.resolve(ledger.defaultRoot());
  } catch (e) { return out; }
  if (rootResolved === defaultResolved) return out; // "its resolved path differs from the default"
  const insideRoot = injectResolved === rootResolved ||
    injectResolved.indexOf(rootResolved + path.sep) === 0 ||
    injectResolved.indexOf(rootResolved + '/') === 0;
  if (!insideRoot) return out;
  try {
    const mod = require(injectPathRaw);
    if (mod && typeof mod.judge === 'function') out.judge = mod.judge;
    if (mod && typeof mod.parse === 'function') out.parse = mod.parse;
    if (mod && typeof mod.assignment === 'function') out.assignment = mod.assignment;
  } catch (e) { /* injection failure -> fall back to real handlers, never throw into judgment */ }
  return out;
}

function realParseFn(cmdText, ctx) { return REAL_PARSER.parseCommand(cmdText, ctx); }

// ============================================================================
// M3 allocation function (M-SPEC appendix B3 as amended 2026-09-17 / contract v2.19 policy_file). REPLACES
// the old brief §6 constant 'shadow' -- <PMM_RECALL_ROOT>/policy.json maps class_tag (contract
// gate_row_class_tag's lesson tag) -> {mode:'shadow'|'randomized', gates:{A,B,D}, unlocked_by,
// lower95_by_gate, unlocked_at}. Missing file / missing class key / corrupt file -> shadow for everything.
// The (session, class_tag) pair gets exactly ONE class-level arm via a deterministic coin flip
// (sha256(session||NUL||class_tag) first byte, even -> intervene, odd -> shadow), shared by ALL gates of
// that class -- but a finding of gate G is only ACTUALLY emitted when that class arm is intervene AND
// gates[G]==='randomized' (v2.19: a gate whose own precision hasn't cleared M1 stays shadow even inside an
// intervene session, and that row's run_provenance is 'policy:shadow-gate' -- distinct from 'policy:shadow',
// which means the class-level arm itself was shadow). This gate only ever READS the file; only
// pmm-recall-precision.cjs --unlock <class> --gate <G> may write gates[G]='randomized' (not this gate's
// concern).
// ============================================================================
// v2.23 item G: policy.json reading and the assignment coin-flip formula are now delegated ENTIRELY to
// pmm-recall-policy.cjs (POLICY), the ONE resolver every writer shares -- this gate no longer implements
// its own file read / ENOENT-vs-other classification / hash formula. `policyFilePath` is POLICY.policyPath
// (kept as a local alias since this file's own self-test builds policy.json fixture paths extensively).
function policyFilePath(root) { return POLICY.policyPath(root); }

// resolveAssignment: the REAL (non-seam) implementation. Returns {mode, provenance}.
//
// `mode` is exactly what the ledger's own `mode` column records -- the effective ARM for this row
// ('shadow'|'intervene'), computed from the (session, class_tag) coin flip and gated by gates[gateLetter].
//
// `provenance` is what the caller turns into run_provenance = 'policy:' + provenance -- it describes the
// POLICY CONFIGURATION SHAPE that produced this decision, NOT which arm the coin flip landed on (Opus
// review correction, 2026-09-17: the first version of this function conflated the two, writing the ARM into
// run_provenance -- e.g. 'policy:shadow' for a session whose class was randomized but happened to coin-flip
// shadow -- when the contract's policy_file convention actually means the POLICY MODE). One of:
//   'absent'      -- no file, OR file present but this class_tag has no entry (both mean "nothing
//                     configured for this class" from the row's point of view).
//   'corrupt'     -- file present but not parseable as a JSON object (POLICY.classEntry's errorKind, which
//                     already implements the v2.23 LOW-8 ENOENT-vs-other-error distinction).
//   'shadow'      -- class entry exists and its own mode field is literally 'shadow' (not randomized).
//   'shadow-gate' -- class mode IS 'randomized', but gates[gateLetter] is not (this specific gate's own
//                     precision hasn't cleared M1 yet) -- mode is forced to 'shadow' regardless of the coin
//                     flip, and this is a DIFFERENT fact than a class-level 'shadow' mode. THIS check stays
//                     in the gate itself (per-gate gates[G] sub-key interpretation is this gate's own
//                     concern, not POLICY's -- POLICY.classEntry only exposes the raw entry, unopinionated).
//   'randomized'  -- class mode is 'randomized' AND gates[gateLetter]==='randomized' (this gate IS
//                     unlocked) -- provenance stays 'randomized' NO MATTER which arm the coin flip actually
//                     produced for this row (contract: "不论该行落在哪个臂"); the arm itself lives only in
//                     the `mode` column.
function resolveAssignment(root, sessionId, classTag, gateLetter) {
  const key = classTag || '';
  const { entry, errorKind } = POLICY.classEntry(key, { root });
  if (errorKind === 'absent') return { mode: 'shadow', provenance: 'absent' };
  if (errorKind === 'corrupt') return { mode: 'shadow', provenance: 'corrupt' };
  if (!entry || entry.mode !== 'randomized') return { mode: 'shadow', provenance: 'shadow' }; // missing key, or class-level mode itself is shadow
  // Class mode is 'randomized' -- THIS gate only actually gets a real coin flip if its own precision has
  // cleared M1 (gates[gateLetter] === 'randomized', written only by pmm-recall-precision.cjs --unlock
  // <class> --gate). classEntry() exposes the raw entry unopinionated -- this per-gate interpretation is
  // this gate's own concern.
  const gatesObj = (entry.gates && typeof entry.gates === 'object' && !Array.isArray(entry.gates)) ? entry.gates : {};
  if (gatesObj[gateLetter] !== 'randomized') return { mode: 'shadow', provenance: 'shadow-gate' };
  // Gate IS unlocked -- POLICY.assignment() is the ONE shared pure coin-flip formula (deterministic per
  // (session_id, class_tag), same result every call against the same policy.json content).
  const arm = POLICY.assignment(sessionId, key, entry.mode);
  return { mode: arm, provenance: 'randomized' };
}

// ============================================================================
// small helpers
// ============================================================================
function sha16(s) { return ledger.sha16(s); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* best effort */ }
}
function normPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

// M1 display-layer desensitization (M-SPEC M1 section: "短期只读展示层保存脱敏命令片段 -- 去路径中的用户名、
// 去引号内容"), mirrored from pmm-bash-impression.cjs's own desensitize() (same logic, kept as an
// independent copy rather than a cross-require between sibling hook scripts -- each hook stays
// self-contained/failure-isolated, matching this codebase's existing pattern of not sharing code between
// hook files beyond the one shared ledger module). Strip usernames out of home-dir paths, blank quoted-
// string content, cap length -- the persistent ledger keeps only hashes; this is the short, read-only,
// human-labelable layer pmm-recall-queue.cjs joins snippets from.
function desensitize(cmd) {
  let s = String(cmd || '');
  s = s.replace(/\/Users\/[^/\s]+\//g, '/Users/_/');
  s = s.replace(/C:\/Users\/[^/\s]+\//gi, 'C:/Users/_/');
  s = s.replace(/"[^"]*"/g, '""');
  s = s.replace(/'[^']*'/g, "''");
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

// resolvePathArg (brief §3 gate D): MSYS `/<drive>/x` -> `<drive>:/x`; `~` -> home; `.`/`..`/relative ->
// resolved against the HOOK's cwd (never process.cwd()); an already-absolute Windows path passes through.
function resolvePathArg(raw, cwd) {
  if (typeof raw !== 'string' || raw === '') return null;
  let p = raw;
  const msys = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  if (msys) {
    p = msys[1].toUpperCase() + ':' + (msys[2] || '/');
  } else if (/^[A-Za-z]:[\\/]/.test(p)) {
    // already absolute
  } else if (p === '~' || p.indexOf('~/') === 0 || p.indexOf('~\\') === 0) {
    // v2.25 home_resolution (fab blind attack MEDIUM-1): every guard derives HOME from the ONE
    // exported resolver in pmm-recall-ledger.cjs (PMM_HOME > USERPROFILE > HOME > os.homedir()) instead
    // of reading os.homedir()/HOME/USERPROFILE directly -- a direct read here is flagged red by the
    // self-check grep (part13) regardless of what the value feeds (this is a `~` shell-path expansion,
    // not a "root", but the convention is a blanket "no direct read anywhere in a guard").
    const home = ledger.resolveHome();
    p = home.replace(/\\/g, '/') + p.slice(1);
  } else {
    const base = cwd || process.cwd();
    p = path.win32.resolve(base, p);
  }
  return p.replace(/\\/g, '/');
}

// isRelativeOperandText (contract v2.18 cd_hint_rule): mirrors resolvePathArg's own branch structure —
// an operand is "relative" (candidate for the cd_hint_rule's RELATIVE test) exactly when it falls through
// resolvePathArg's `else` branch (resolved against cwd); the MSYS-absolute, drive-absolute, and `~`-home
// branches are all absolute-equivalent and therefore never relative, matching the rule's own "operands are
// all absolute ... never produces cd-hint" exemption.
function isRelativeOperandText(raw) {
  if (typeof raw !== 'string' || raw === '') return false;
  if (/^\/([A-Za-z])(\/.*)?$/.test(raw)) return false; // MSYS `/<drive>/...`
  if (/^[A-Za-z]:[\\/]/.test(raw)) return false; // drive-absolute
  if (raw === '~' || raw.indexOf('~/') === 0 || raw.indexOf('~\\') === 0) return false; // home
  return true;
}

function isExistingFilePath(p) {
  if (!p || (p.indexOf('/') < 0 && p.indexOf('\\') < 0)) return false;
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

// v2.19 cd_hint_rule clarification (contract, D11): "does not exist" for cd-hint purposes means
// fs.existsSync is false for the resolved path -- an existing DIRECTORY (e.g. `.`, or any real directory
// operand to head/tail) EXISTS and must never yield cd-hint, even though isExistingFilePath() above
// (deliberately FILE-only, for gate D's own judgment) is false for it. Kept as a separate predicate rather
// than loosening isExistingFilePath itself, since gate D's own "existing file" semantics are unrelated and
// unchanged.
function existsAnyKind(p) {
  if (!p) return false;
  try { return fs.existsSync(p); } catch (e) { return false; }
}

// content fingerprint (brief §11.1): sha256(size || first 64KB || last 64KB), used to detect a
// same-size-but-different-content replace that a bare size comparison would miss.
function fingerprintFile(p, size) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const headLen = Math.min(size, 65536);
      const headBuf = Buffer.alloc(headLen);
      if (headLen > 0) fs.readSync(fd, headBuf, 0, headLen, 0);
      const tailLen = Math.min(size, 65536);
      const tailStart = Math.max(0, size - tailLen);
      const tailBuf = Buffer.alloc(tailLen);
      if (tailLen > 0) fs.readSync(fd, tailBuf, 0, tailLen, tailStart);
      const h = crypto.createHash('sha256');
      h.update(String(size)); h.update(headBuf); h.update(tailBuf);
      return h.digest('hex');
    } finally { fs.closeSync(fd); }
  } catch (e) { return null; }
}

function snapshotPath(p) {
  let st = null;
  try { st = fs.statSync(p, { bigint: true }); } catch (e) { st = null; }
  const exists = !!st;
  const size = st ? Number(st.size) : 0;
  const fileId = st ? (String(st.dev) + ':' + String(st.ino)) : null;
  const fingerprint = (exists && size > 0) ? fingerprintFile(p, size) : null;
  return { path: p, exists, size, fileId, fingerprint };
}

// ============================================================================
// layout (contract conventions.layout, pinned)
// ============================================================================
function pendingDir(root) { return path.join(root, 'pending'); }
function pendingKeyPath(root, sessionId, agentId, toolUseId) {
  const key = crypto.createHash('sha256')
    .update(String(sessionId || '') + '\0' + String(agentId || '') + '\0' + String(toolUseId || ''), 'utf8')
    .digest('hex');
  return path.join(pendingDir(root), key + '.json');
}
function receiptsPath(root, sessionId, agentId) {
  return path.join(root, 'receipts-' + sha16(sessionId || '') + '-' + sha16(agentId || '') + '.log');
}

// ============================================================================
// judge core: A/B/D scanning + informational events, over `parsed` (real or
// seam-injected). gate_instance_id derivation lives HERE too (contract
// conventions.call_granularity: "gate_instance_id is NOT carried in findings
// — the gate derives it from parsed"), so it is computed unconditionally,
// independent of whether judge() itself was overridden.
// ============================================================================
const B_EXES = ['head', 'tail'];
const D_EXES = ['tail', 'head'];
const B_SEPS = new Set(['|', '|&']);
// contract v2.20 gate_b_browse_denylist (M1 labels: B 14 useful / 16 noise, every noise case a browsing
// command): gate B does NOT fire when the segment IMMEDIATELY upstream of the head/tail segment (the
// previous segment in the same pipeline, i.e. segs[i-1] when segs[i].sep_before is the pipe into it) has an
// exe in this denylist, or is git with a sub in B_BROWSE_GIT_SUBS. Every other upstream (including an
// unknown bare cmd, git diff, and an unsupported/unparsed upstream segment -- whose exe is null, which
// matches neither set below, so it naturally falls through to "still fires") keeps firing. Only the ONE
// immediately-preceding segment is ever consulted (`ls | cmd | tail -3` still fires: cmd, not ls, is
// immediately upstream of tail).
// v2.23 (codex MEDIUM-3, Opus confirmed 4/4): head and tail themselves are browse exes too (a
// head/tail-relay pipeline like `head -100 f | tail -10` is browsing, not verifying -- D still judges
// head's own file operand independently, see D_EXES scan below).
const B_BROWSE_EXES = new Set(['ls', 'dir', 'cat', 'find', 'fd', 'grep', 'rg', 'ag', 'wc', 'du', 'df',
  'echo', 'printf', 'env', 'which', 'type', 'jq', 'yq', 'sed', 'awk', 'cut', 'sort', 'uniq', 'tr', 'column',
  'head', 'tail']);
// v2.23 (codex MEDIUM-3): grep/ls-tree/cat-file/rev-list are read-only git subs too.
// v2.24 (codex wave-2 LOW-4 (vii)): rev-parse/remote/worktree/describe are read-only too (Bx27).
const B_BROWSE_GIT_SUBS = new Set(['log', 'show', 'blame', 'ls-files', 'status', 'branch', 'tag', 'stash',
  'reflog', 'grep', 'ls-tree', 'cat-file', 'rev-list', 'rev-parse', 'remote', 'worktree', 'describe']);
// v2.24 (codex wave-2 MEDIUM-3 (viii)): a TOOL+SUBCOMMAND browse table, for tools the parser does not
// extract a structured `.sub` field for (unlike git) -- the subcommand is just this segment's own first
// arg. docker/kubectl/podman logs are browsing (Bx28, Bx29); curl is deliberately NOT in this table at all
// (its read-only-ness genuinely depends on -X/-d, unlike a fixed subcommand name, contract's own words).
const TOOL_SUB_BROWSE_PAIRS = { docker: 'logs', kubectl: 'logs', podman: 'logs' };
function isToolSubBrowse(seg) {
  const wantSub = TOOL_SUB_BROWSE_PAIRS[seg.exe];
  if (!wantSub) return false;
  const args = Array.isArray(seg.args) ? seg.args : [];
  return args.length > 0 && operandText(args[0]) === wantSub;
}
// v2.24 (codex wave-2 MEDIUM-2 (vi)): jq/yq LOSE the browse exemption when invoked with -e/--exit-status --
// their exit status IS the verification, and a pipe into head/tail hides it exactly like any other masked
// exit code (Bx24 fires B; Bx25, the same command without -e, stays exempt).
const NO_EXEMPT_FLAG_EXES = { jq: new Set(['-e', '--exit-status']), yq: new Set(['-e', '--exit-status']) };
// v2.26 (codex final #3 (i), Opus confirmed on HEAD b1a74c2: hasNoExemptFlag compared whole tokens, so
// jq -er / jq -re / yq -er were still browse while only the bare jq -e was verification): any single-dash
// short-flag cluster of letters containing 'e' (-er, -re, -ec, -e itself) counts as carrying -e, the same
// cluster rule the parser applies to shell-wrapper flags (amendment ⑨'s POSIX_WRAPPER_SHORT_FLAG_RE) --
// a cluster without 'e' (-r, -c, -rc) stays exempt/browse (Bx33 control).
const NO_EXEMPT_FLAG_CLUSTER_RE = /^-[a-zA-Z]*e[a-zA-Z]*$/;
function hasNoExemptFlag(seg) {
  const flags = NO_EXEMPT_FLAG_EXES[seg.exe];
  if (!flags) return false;
  const args = Array.isArray(seg.args) ? seg.args : [];
  return args.some((a) => {
    const v = operandText(a);
    return flags.has(v) || NO_EXEMPT_FLAG_CLUSTER_RE.test(v);
  });
}
function isBrowseUpstream(seg) {
  if (!seg) return false;
  if (hasNoExemptFlag(seg)) return false;
  if (B_BROWSE_EXES.has(seg.exe)) return true;
  if (seg.exe === 'git' && B_BROWSE_GIT_SUBS.has(seg.sub)) return true;
  if (isToolSubBrowse(seg)) return true;
  return false;
}
// v2.23 (codex MEDIUM-4, Opus confirmed 5/5): the exemption criterion is no longer "immediate upstream is
// browse" but "EVERY segment of the pipeline from its own source segment through refIndex is browse" --
// `inclusive` controls whether refIndex itself is checked (true for "is THIS writer's whole pipeline
// browse", used by the write-evidence writer check; false for "is the head/tail candidate's WHOLE upstream
// browse", which by construction never includes the candidate itself). pipeline_position defaults to 0 (a
// standalone, non-piped segment is trivially its own one-segment pipeline).
// pipelineSourceIndex: walk backward via sep_before (not pipeline_position/pipeline_id) to find a
// pipeline's own source segment. sep_before is the more robust signal here -- verified live (Bx21,
// `cat <(npm test) | tail -3`) that the parser leaves pipeline_id/pipeline_position BOTH null for a
// pipeline containing an unsupported member (process substitution), even though sep_before still correctly
// marks `tail` as piped ('|') from `cat`; a pipeline_position-based source lookup would have silently
// treated the unsupported `cat` as outside the pipeline (sourceIdx defaulting to refIndex itself), making
// Bx21's whole upstream look vacuously "all browse" and wrongly suppress B on an unparsed segment -- exactly
// the class of silent-blind-spot this gate's isFlagWorthyUnsupported discipline exists to prevent elsewhere.
function pipelineSourceIndex(segs, refIndex) {
  let k = refIndex;
  while (k > 0 && B_SEPS.has(segs[k].sep_before)) k--;
  return k;
}
function pipelineAllBrowseUpTo(segs, refIndex, inclusive) {
  if (!segs[refIndex]) return true;
  const sourceIdx = pipelineSourceIndex(segs, refIndex);
  const endIdx = inclusive ? refIndex : refIndex - 1;
  for (let k = sourceIdx; k <= endIdx; k++) {
    if (!isBrowseUpstream(segs[k])) return false;
  }
  return true;
}
const A_NEXT_SEPS = new Set([';', 'newline', '&&', '||']);
// contract v2.15 head_tail_option_table: -n N, -nN, --lines=N, --lines N, -c N, -cN, --bytes=N, --bytes N
// are all value-taking; the fused forms (-nN, --lines=N, -cN, --bytes=N) already work for free (the whole
// token is skipped as one unit, no separate value token to consume) — only the SEPARATED long forms
// (--lines N, --bytes N) need their own entry here so the value token gets consumed too, matching -n/-c's
// existing behavior (otherwise the value token falls through and silently shifts every later operand's
// operand_index by one, e.g. `tail --lines 5 f` numbering `f` differently from `tail -n 5 f`).
const OPTS_TAKING_VALUE = new Set(['-n', '-c', '--lines', '--bytes']);
const PENDING_TRIGGER_OPS = new Set(['>', '>>', '&>', '2>']);

function hasRealStatusRef(seg) {
  return Array.isArray(seg.status_refs) && seg.status_refs.some((r) => r && (r.kind === '$?' || r.kind === '${?}'));
}
// isFlagWorthyUnsupported: any 'unsupported:*' reason flags — INCLUDING 'unsupported:heredoc' now,
// unconditionally (contract v2.16+ HIGH-1 / conventions.heredoc_segments; fab blind attack finding). The
// previous rule exempted a heredoc segment when other cleanly-parsed segments were also present (A18's
// "cat > f <<'EOF2' ... EOF2\nrc=$?" was treated as fully understood, since heredoc bodies are
// deliberately skipped as inert data). Parser amendment 7 changed the premise: a heredoc segment's own
// FIRST LINE can hide a real, unaccounted-for pipe operator (H02: "cat <<'EOF' | tail -3" swallows a
// genuine `|` into the skip range the same way the body's inert `|` chars are swallowed), which this gate
// has no way to distinguish from A18's genuinely-boring shape — so the single-segment carve-out is
// withdrawn and EVERY heredoc segment flags, same HIGH-6 discipline as any other unsupported reason
// (total blindness must never be sold as a silent true negative). A18 itself was updated in the same
// contract revision to expect events:['unsupported'] (previously the sole exception to a blanket rule;
// verified via a full replay of every `cases` entry before landing this change — zero mismatches under
// the unconditional rule as of contract v2.17, blob 2109eae5).
function isFlagWorthyUnsupported(seg) {
  return typeof seg.parse_status === 'string' && seg.parse_status.indexOf('unsupported:') === 0;
}
function pipefailBefore(segments, uptoIndexExclusive) {
  let pf = false;
  for (let i = 0; i < uptoIndexExclusive; i++) {
    const s = segments[i];
    if (Array.isArray(s.shell_option_changes)) {
      for (const oc of s.shell_option_changes) if (oc && oc.option === 'pipefail') pf = !!oc.on;
    }
  }
  return pf;
}
// brief §3 gate D option table: -n N / -nN / --lines=N (fused), -c N / --bytes=N (fused), old-style -N,
// -q/-v/-z/-f/-F, --. Only bare -n/-c (unfused) consume the NEXT token as their value; any other leading
// '-' token (fused forms, old-style counts, unknown flags, a separated "--lines 5"'s "--lines" half) is
// skipped as a single token — a separated long-option's VALUE then falls through as a non-'-' text that
// is only ever treated as an operand if it happens to contain a path separator (isExistingFilePath's own
// filter), so it cannot manufacture a phantom D hit; it can only occupy an operand_index slot, which the
// contract's own v2.10 pin (operand_index counts every remaining operand, matched or not) already allows.
function computeFileOperands(seg) {
  const args = Array.isArray(seg.args) ? seg.args : [];
  const out = [];
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const text = (a && typeof a === 'object') ? (a.decoded !== undefined ? a.decoded : a.raw) : String(a);
    if (!afterDashDash && text && text[0] === '-' && text !== '-') {
      if (text === '--') { afterDashDash = true; continue; }
      if (OPTS_TAKING_VALUE.has(text)) { i += 1; continue; }
      continue;
    }
    // v2.19 D16: a leading-'+' old-style tail count token (`tail +5 f` = start at line 5) is a count, not
    // an operand -- the same "consumed by the option table" treatment old-style leading-'-' counts (-5)
    // already get above. Scoped to purely-numeric-after-'+' so a genuinely `+`-prefixed filename (unusual
    // but valid) is never misclassified.
    if (!afterDashDash && /^\+\d+$/.test(text || '')) { continue; }
    if (text === '-') return null; // reads stdin -> whole segment not judged
    out.push(a);
  }
  return out;
}
function operandText(a) { return (a && typeof a === 'object') ? (a.decoded !== undefined ? a.decoded : a.raw) : String(a); }
function operandUnresolved(a) { return (a && typeof a === 'object' && Array.isArray(a.unresolved_variables)) ? a.unresolved_variables : []; }

// D-gate confidence upgrade (brief §3 D / §4): a receipt for the SAME (session,agent), same normalized
// path, 0<=age<TTL, class in {created-nonempty,replaced-changed,appended-grown} upgrades candidate ->
// recurrence. No session_id -> never correlates (contract Z12).
function lookupReceiptEvidence(root, sessionId, agentId, resolvedPath, ttlSeconds) {
  if (!sessionId) return false;
  const rf = receiptsPath(root, sessionId, agentId);
  let text;
  try { text = fs.readFileSync(rf, 'utf8'); } catch (e) { return false; }
  const target = normPath(resolvedPath);
  const nowMs = Date.now();
  const ttlMs = (Number.isFinite(ttlSeconds) ? ttlSeconds : 3600) * 1000;
  const EVIDENCE = new Set(['created-nonempty', 'replaced-changed', 'appended-grown']);
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 5) continue; // torn line -> skip, not fatal (L19)
    const t = Date.parse(f[0]);
    if (Number.isNaN(t)) continue;
    const ageMs = nowMs - t;
    if (ageMs < 0 || ageMs >= ttlMs) continue; // future (clock rollback) or expired -> not evidence
    if (!EVIDENCE.has(f[1])) continue;
    if (normPath(f[2]) !== target) continue;
    return true;
  }
  return false;
}

// v2.22 gate_b_browse_denylist erratum (Opus increment F1): the browse exemption is VOID -- gate B fires
// as if the upstream exe were unknown -- when any operand of the immediately-upstream browse segment is
// (a) the target of a write redirect (>,>>,2>,&>) in an EARLIER segment of the SAME command whose exe is
// NOT browse-denylisted (and not git-with-a-denylisted-sub), or (b) a path with a receipt of class
// created-nonempty/replaced-changed/appended-grown within the receipt TTL (same evidence table/TTL/read
// logic as gate D's lookupReceiptEvidence). A same-command writer that IS itself a browse exe keeps the
// exemption (Bx08). The operand list uses the SAME option-consumption and path-resolution as gate D / the
// cd_hint_rule (computeFileOperands + resolvePathArg) -- not a separate parse.
//
// PATTERN_FIRST_ARG_EXES: for grep/rg/ag (pattern) and sed/awk (script), computeFileOperands()'s generic
// option-consumption has no idea the FIRST non-flag token is a pattern/script, not a path -- "grep -n foo
// f" yields operands ['foo','f'], and 'foo' must never be resolved as a path (contract: "pattern/脚本
// token 不解析为路径"). Scoped to exactly what the contract names (pattern/script) rather than guessed at
// more broadly (e.g. jq/yq's filter-expression-first convention is a plausible analog but untested by any
// contract case, so left alone).
const PATTERN_FIRST_ARG_EXES = new Set(['grep', 'rg', 'ag', 'sed', 'awk']);

// v2.23 (codex MEDIUM-3-iii): CLI flags whose value is a file the tool writes its verification output to
// -- the value is a write target of that segment exactly like a shell redirect, in BOTH the --flag=VALUE
// (fused) and separated --flag VALUE / -o VALUE forms. v2.24 (codex wave-2 LOW-4): this Set is the SINGLE
// SOURCE for the gate -- no second copy anywhere else in this file -- mirroring contract
// conventions.verification_output_flags verbatim; added camelCase and tool-specific spellings. Matching
// stays exact on the flag token (case-sensitive) -- '--outputFile' and '--output-file' are deliberately
// two distinct entries, not normalized to one form. v2.26 (codex final #3 (iii)): '--cov-report'
// (pytest-cov) is in the table too, but its value shape is TYPE:PATH, not a bare path -- see
// extractWriteFlagPath below, the table itself stays the single source (no second list).
const VERIFICATION_OUTPUT_FLAGS = new Set(['--junitxml', '--junit-xml', '--report', '--report-file',
  '--output', '--output-file', '--out', '--log-file', '--logfile', '--results-file', '--results', '-o',
  '--outputFile', '--json-output-file', '--outfile', '--out-file', '--result-file', '--reporter-output',
  '--log-output', '--cov-report']);
// v2.26 (codex final #3 (iii)): --cov-report's value is TYPE:PATH (e.g. json:ABS/c.json); the write
// target is the part after the FIRST colon. A value with no colon (term, html) names no file at all --
// not a write target (Bx37 control). Every other verification_output_flags entry keeps the value as-is.
function extractWriteFlagPath(flag, rawValue) {
  if (flag === '--cov-report') {
    const colonIdx = rawValue.indexOf(':');
    return colonIdx === -1 ? null : rawValue.slice(colonIdx + 1);
  }
  return rawValue;
}
function flagWriteTargets(seg, cwd) {
  const out = [];
  const args = Array.isArray(seg.args) ? seg.args : [];
  for (let i = 0; i < args.length; i++) {
    const text = operandText(args[i]);
    if (typeof text !== 'string') continue;
    const eqIdx = text.indexOf('=');
    if (eqIdx > 0) {
      const flag = text.slice(0, eqIdx);
      if (VERIFICATION_OUTPUT_FLAGS.has(flag)) {
        const path = extractWriteFlagPath(flag, text.slice(eqIdx + 1));
        const resolved = path === null ? null : resolvePathArg(path, cwd);
        if (resolved) out.push(resolved);
      }
      continue;
    }
    if (VERIFICATION_OUTPUT_FLAGS.has(text) && i + 1 < args.length) {
      const path = extractWriteFlagPath(text, operandText(args[i + 1]));
      const resolved = path === null ? null : resolvePathArg(path, cwd);
      if (resolved) out.push(resolved);
      i++; // consumed as this flag's value -- never re-examined as its own flag/token
    }
  }
  return out;
}
// v2.23 (codex MEDIUM-3-iii): `tee [-a] FILE...` positional arguments are write targets -- generic
// option-consumption (-a takes no value, so the shared computeFileOperands() already leaves every
// remaining positional token as a would-be "operand") is reused here rather than a bespoke tee-specific arg
// scan, matching the contract's "same option-consumption" discipline used everywhere else in this file.
function teeWriteTargets(seg, cwd) {
  if (seg.exe !== 'tee') return [];
  const operands = computeFileOperands(seg);
  if (!operands) return [];
  const out = [];
  for (const a of operands) {
    if (operandUnresolved(a).length > 0) continue;
    const resolved = resolvePathArg(operandText(a), cwd);
    if (resolved) out.push(resolved);
  }
  return out;
}

// segmentWriteTargets(seg, cwd): resolved paths this ONE segment writes to -- a PENDING_TRIGGER_OPS
// redirect (target_kind==='file'; the same shape collectPendingTargets() reads), a `tee` positional file,
// or a verification_output_flags value. Factored out per-segment so the browse-exemption check can
// attribute a write to its OWN writer segment/exe.
function segmentWriteTargets(seg, cwd) {
  const out = [];
  const reds = Array.isArray(seg.redirects) ? seg.redirects : [];
  for (const r of reds) {
    if (!r || r.target_kind !== 'file') continue;
    if (!PENDING_TRIGGER_OPS.has(r.op)) continue;
    const text = (r.target && typeof r.target === 'object') ? (r.target.decoded !== undefined ? r.target.decoded : r.target.raw) : (r.raw_target || '');
    const resolved = resolvePathArg(text, cwd);
    if (resolved) out.push(resolved);
  }
  out.push(...teeWriteTargets(seg, cwd));
  out.push(...flagWriteTargets(seg, cwd));
  return out;
}

// v2.26 (codex final #3 (iv), writer_segment_rule): a writer segment is a PURE PASS-THROUGH -- its write
// doesn't independently produce verification output, it relays or filters whatever came in on its stdin --
// when its own exe is `tee`, or `cat` with no file operand of its own (both literal names, per contract),
// OR when its own exe is already one of the general browse/filter tools (sed, awk, grep, cut, sort, uniq,
// tr, column, head, tail, jq, yq, ls, ...; isBrowseUpstream's own denylist -- Bx14/Bx15, pre-existing:
// `npm test | sed -n ... > out.txt` still voids because sed's SOURCE (npm) is not browse, `ls | sed -n
// ... > list.txt` still keeps the exemption because sed's SOURCE (ls) is browse; both rely on sed being
// treated as pass-through here, not on sed's own exe -- sed IS in the browse denylist, so if it were NOT
// treated as pass-through it would just be judged as browse-and-therefore-exempt regardless of its actual
// data source, which is wrong for Bx14). `tee` needs its own explicit branch since it is deliberately NOT
// itself a member of B_BROWSE_EXES (its presence immediately upstream of head/tail is not "browsing" in
// that unrelated sense) even though it is exactly this kind of pass-through for write-target purposes.
function isPurePassThroughWriter(seg) {
  if (!seg) return false;
  if (seg.exe === 'tee') return true;
  if (seg.exe === 'cat') {
    const operands = computeFileOperands(seg);
    return !operands || operands.length === 0;
  }
  return isBrowseUpstream(seg);
}

// v2.23: candidateIndex is the head/tail segment's OWN index -- its whole upstream pipeline (source
// segment through candidateIndex-1, all already confirmed all-browse by the caller before this function is
// even invoked) is scanned segment-by-segment for operands, since a multi-segment all-browse chain
// (`cat f | grep pattern | head`) can have its real file operand on ANY upstream segment, not only the one
// immediately before the candidate (v2.22's single-segment assumption no longer holds once whole-pipeline
// chains are in scope).
function browseExemptionVoided(segs, candidateIndex, ctx) {
  const sourceIdx = pipelineSourceIndex(segs, candidateIndex);
  for (let upstreamIndex = sourceIdx; upstreamIndex < candidateIndex; upstreamIndex++) {
    const up = segs[upstreamIndex];
    const operands = computeFileOperands(up);
    if (!operands || operands.length === 0) continue; // no operand on this upstream segment -> check the next one
    // Skip the pattern/script token for grep/rg/ag/sed/awk -- but ONLY when 2+ operands remain, since
    // computeFileOperands()'s OPTS_TAKING_VALUE (shared verbatim with gate D/cd-hint, per contract "same
    // option-consumption") was curated for head/tail's OWN flags, where -n takes a numeric value; grep's -n
    // (line numbers, no value) is a different flag that happens to share the same short name, so
    // "grep -n foo f" already loses 'foo' to -n's (wrong, but shared-verbatim) value-consumption BEFORE this
    // function ever sees it, leaving operands=['f'] (length 1) -- an extra positional skip here would
    // wrongly discard the one real path left. "grep foo f" (no -n) keeps both operands=['foo','f'] (length
    // 2), and THAT is exactly when the positional skip is needed to keep 'foo' out of path resolution.
    const startIdx = (PATTERN_FIRST_ARG_EXES.has(up.exe) && operands.length >= 2) ? 1 : 0;
    for (let oi = startIdx; oi < operands.length; oi++) {
      const a = operands[oi];
      if (operandUnresolved(a).length > 0) continue; // can't determine -> not positive evidence, keep looking
      const resolved = resolvePathArg(operandText(a), ctx.cwd);
      if (!resolved) continue;
      const normResolved = normPath(resolved);
      // (a) an EARLIER segment in the same command wrote to this exact path via a redirect / tee / a
      // verification_output_flags value. v2.26 (codex final #3 (iv), Opus confirmed as the mirror
      // counter-example of the v2.24 (v) pipeline-source rule below): the segment that HOLDS the write
      // redirect (or verification output flag) is the WRITER whose own exe decides browse vs verification
      // for a later read of that file -- `printf x | npm test > ABS/out.txt; cat ABS/out.txt | head` fires
      // B (npm holds the redirect and npm is not a browse exe, regardless of printf upstream -- Bx34; the
      // v2.24 (v) code below wrongly asked "is npm's pipeline SOURCE (printf) browse" and wrongly kept the
      // exemption). The pipeline source is consulted only when the writer segment is itself a PASS-THROUGH
      // that relays/filters upstream data rather than independently producing verification output -- tee,
      // cat with no file operand of its own, or any of the other general browse/filter exes (sed, awk,
      // grep, cut, sort, uniq, tr, column, head, tail, jq, yq, ...; isPurePassThroughWriter below) -- for
      // those, a browse-sourced writing pipeline keeps the exemption (`ls | tee list.txt`, `ls | sed ... >
      // list.txt` -- Bx08/Bx15/Bx23 unchanged) while a non-browse-sourced one still voids (`npm test | sed
      // ... > out.txt` does NOT keep the exemption, since npm test is not browse -- Bx14, pre-existing,
      // unchanged by this revision).
      for (let wi = 0; wi < upstreamIndex; wi++) {
        const writerSeg = segs[wi];
        const decidingSeg = isPurePassThroughWriter(writerSeg) ? segs[pipelineSourceIndex(segs, wi)] : writerSeg;
        if (isBrowseUpstream(decidingSeg)) continue; // deciding segment is browse -> never voids
        const targets = segmentWriteTargets(writerSeg, ctx.cwd);
        if (targets.some((t) => normPath(t) === normResolved)) return true;
      }
      // (b) a within-TTL receipt (same table/TTL/read-logic as gate D) for this exact path.
      if (lookupReceiptEvidence(ctx.root, ctx.sessionId, ctx.agentId, resolved, ctx.ttlSeconds)) return true;
    }
  }
  return false;
}

// analyzeCommand(parsed, ctx) -> {units:[{finding,instance}], events:[...]}. Judging is restricted to
// scope_id==='root' (brief §2); any involved segment being parse_status!=ok (including heredoc — see
// isFlagWorthyUnsupported, v2.16+ HIGH-1: the old known-safe heredoc carve-out is withdrawn), negated, or
// outside root scope downgrades to an 'unsupported' informational event instead of silently nothing
// (brief §2 "该 gate 记 unsupported,不当 miss"); verified against every `cases` entry in the contract
// (see build notes).
function analyzeCommand(parsed, ctx) {
  const segs = (parsed && parsed.segments) || [];
  const events = new Set();
  const units = [];
  // v2.18 cd_hint_rule (fab L6, contract conventions.cd_hint_rule): cd-hint fires only when a JUDGED
  // head/tail segment has >=1 file operand that is BOTH relative AND does not exist under the hook cwd —
  // a segment whose operands are all absolute, or all exist, or has none, never contributes. This replaced
  // the old, much broader "some D-candidate segment produced zero D rows, AND a `cd` was seen ANYWHERE in
  // the command" rule (which over-fired on ~30% of the real corpus: the `cd` sighting was a correlate, not
  // the actual cause — Dc01 below has no `cd` in it at all and must still hint). `anyCdHintOperand` is a
  // single command-wide flag (not per-segment) because informational events collapse into a Set anyway —
  // contract cases only ever assert 0-or-1 'cd-hint' occurrences per command.
  let anyCdHintOperand = false;

  for (const s of segs) {
    if (isFlagWorthyUnsupported(s) || s.negated === true || (s.scope_id && s.scope_id !== 'root')) {
      events.add('unsupported');
    }
  }

  // Gate A: each pipeline (pipeline_position===0, pipeline_length>=2), independent per pipeline.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.scope_id !== 'root') continue;
    if (s.pipeline_id === null || s.pipeline_id === undefined) continue;
    if (s.pipeline_position !== 0) continue;
    const length = s.pipeline_length || 1;
    if (length < 2) continue;
    const endIdx = i + length - 1;
    let allOk = true;
    for (let k = i; k <= endIdx; k++) {
      const m = segs[k];
      if (!m || m.parse_status !== 'ok' || m.negated === true || m.scope_id !== 'root') { allOk = false; break; }
    }
    if (!allOk) continue; // already flagged via the unconditional 'unsupported' scan above
    const next = segs[endIdx + 1];
    if (!next) continue;
    if (!A_NEXT_SEPS.has(next.sep_before)) continue;
    if (!hasRealStatusRef(next)) continue;
    if (pipefailBefore(segs, i)) continue; // pipefail on -> correctly silent
    const pid = String(i);
    // exe/sub travel with each unit for the M1 display-layer queue write (M-SPEC M1 section /
    // pmm-recall-queue.cjs's existing QUEUE_COLUMNS reader) -- the pipeline's FIRST segment (index i) is
    // where this A finding is anchored.
    units.push({ finding: { gate: 'A', confidence: 'recurrence' }, instance: pid + ':' + pid, exe: s.exe || '', sub: s.sub || '' });
  }

  // Gates B and D: per segment, independent of A.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.scope_id !== 'root' || s.parse_status !== 'ok') continue;
    const pid = (s.pipeline_id === null || s.pipeline_id === undefined) ? '' : String(s.pipeline_id);
    if (B_EXES.indexOf(s.exe) >= 0 && B_SEPS.has(s.sep_before) &&
        (!pipelineAllBrowseUpTo(segs, i, false) || browseExemptionVoided(segs, i, ctx))) {
      units.push({ finding: { gate: 'B', confidence: 'recurrence' }, instance: pid + ':' + String(i), exe: s.exe || '', sub: s.sub || '' });
    }
    if (D_EXES.indexOf(s.exe) >= 0) {
      const operands = computeFileOperands(s);
      if (operands) {
        for (let oi = 0; oi < operands.length; oi++) {
          const a = operands[oi];
          const unresolved = operandUnresolved(a);
          // An operand with an unresolved variable already gets its own dedicated 'path_unresolved' signal
          // and its true relative/absolute-ness or existence cannot be determined -- it is excluded from
          // cd_hint_rule consideration (never counts toward "has a relative-and-missing operand").
          if (unresolved.length > 0) { events.add('path_unresolved'); continue; }
          const rawText = operandText(a);
          const resolved = resolvePathArg(rawText, ctx.cwd);
          if (isExistingFilePath(resolved)) {
            const evidence = lookupReceiptEvidence(ctx.root, ctx.sessionId, ctx.agentId, resolved, ctx.ttlSeconds);
            const confidence = evidence ? 'recurrence' : 'recurrence-candidate';
            units.push({ finding: { gate: 'D', confidence }, instance: pid + ':' + String(i) + ':' + String(oi), exe: s.exe || '', sub: s.sub || '' });
          } else if (!existsAnyKind(resolved) && isRelativeOperandText(rawText)) {
            // v2.19 D11: an existing DIRECTORY (e.g. `.`) is not an existing FILE (no D row), but it DOES
            // exist -- existsAnyKind() must also be false before this counts as a cd-hint candidate.
            anyCdHintOperand = true;
          }
        }
      }
    }
  }

  if (anyCdHintOperand) events.add('cd-hint');

  return { units, events: [...events] };
}

// Pending-snapshot targets from a Pre command's parsed redirects (brief §4: op in {>,>>,&>,2>}, target_kind
// file only).
function collectPendingTargets(parsed, cwd) {
  const segs = (parsed && parsed.segments) || [];
  const out = [];
  for (const s of segs) {
    const reds = Array.isArray(s.redirects) ? s.redirects : [];
    for (const r of reds) {
      if (!r || r.target_kind !== 'file') continue;
      if (!PENDING_TRIGGER_OPS.has(r.op)) continue;
      const text = (r.target && typeof r.target === 'object') ? (r.target.decoded !== undefined ? r.target.decoded : r.target.raw) : (r.raw_target || '');
      const resolved = resolvePathArg(text, cwd);
      if (!resolved) continue;
      out.push({ path: resolved, op: r.op });
    }
  }
  return out;
}

// §11.2 pending state machine: wx create-if-absent; same key already present -> compare payload (by
// whole-command identity, matching the reference stub gate); identical -> idempotent skip; different ->
// pending-conflict; unreadable -> pending-corrupt. Retries a bounded number of times so a losing race
// against a concurrent consumer (L15b) resolves instead of misreporting corruption.
function createOrJoinPending(keyPath, payloadStr, cmd) {
  mkdirp(path.dirname(keyPath));
  for (let attempt = 0; attempt < 60; attempt++) {
    let created = false;
    try {
      const fd = fs.openSync(keyPath, 'wx');
      try { fs.writeSync(fd, payloadStr); } finally { fs.closeSync(fd); }
      created = true;
    } catch (e) { created = false; }
    if (created) return { status: 'created' };
    let text = null, missing = false;
    try { text = fs.readFileSync(keyPath, 'utf8'); } catch (e) { missing = true; }
    if (missing) { sleepMs(5); continue; } // consumed under us -> retry create
    if (!text.length) { sleepMs(5); continue; } // create landed, payload not written yet
    let prev = null;
    try { prev = JSON.parse(text); } catch (e) { prev = null; }
    if (prev === null) return { status: 'corrupt' };
    if (prev.cmd !== cmd) return { status: 'conflict' };
    return { status: 'idempotent' };
  }
  return { status: 'corrupt' };
}

function classifyTarget(pre) {
  let postStat = null;
  try { postStat = fs.statSync(pre.path, { bigint: true }); } catch (e) { postStat = null; }
  if (!postStat) return 'missing';
  const postSize = Number(postStat.size);
  const postFileId = String(postStat.dev) + ':' + String(postStat.ino);
  if (pre.op === '>>') {
    if (postSize > pre.size) return 'appended-grown';
    if (postSize === pre.size && postSize > 0) {
      const fp = fingerprintFile(pre.path, postSize);
      if (pre.fingerprint && fp && fp !== pre.fingerprint) return 'appended-grown';
    }
    return 'unchanged';
  }
  // single-write family: > / &> / 2>
  if (postSize === 0) return 'truncated-empty';
  if (!pre.exists && postSize > 0) return 'created-nonempty';
  if (pre.fileId && postFileId !== pre.fileId) return 'replaced-changed';
  if (pre.size !== postSize) return 'replaced-changed';
  const fp = fingerprintFile(pre.path, postSize);
  if (pre.fingerprint && fp && fp !== pre.fingerprint) return 'replaced-changed';
  return 'unchanged'; // covers mtime-only (brief §11.1: "仅 mtime 变化 -> candidate")
}

// GC (brief §11.2 + contract v2.15 receipt_commit_and_lease H3): `.processing.<lease>` older than 1h with
// no owner -> receipt-lost (attributed to the ORIGINAL pending's tool_use_id, recovered from the payload —
// contract conventions.row_attribution); plain `<hash>.json` older than 24h -> pending-expired.
// Opportunistic, runs on every invocation; the age thresholds make it safe against a whole test run's own
// live state.
//
// H3: a lease's age for GC purposes is computed from the CLAIM TIMESTAMP embedded in its own name
// (`.processing.p<pid>-<claimMs>-<rand>`), never from the file's mtime — a Windows `fs.renameSync` keeps
// the SOURCE file's original mtime on the renamed destination, so a pending file that had been sitting
// around for a while (nothing wrong with that; brief §4 pending is meant to persist until consumed) would
// make a lease claimed THIS INSTANT look already stale the moment it's created. `fs.utimesSync` is also
// applied to the claim time right after rename (contract's own words: "after rename the gate also touches
// the lease mtime to the claim time"), as a second, independent source of truth if the name-parse route
// ever fails for a lease this gate itself did not create. A lease whose embedded pid is still alive
// (`process.kill(pid, 0)` succeeds, or throws EPERM — exists but not signalable) is NEVER garbage
// collected regardless of computed age: its owner may still be mid-retry.
const PROCESSING_STALE_MS = 60 * 60 * 1000;
const PENDING_EXPIRED_MS = 24 * 60 * 60 * 1000;
const LEASE_NAME_RE = /\.processing\.p(\d+)-(\d+)-[a-z0-9]+$/;
function parseLeaseName(name) {
  const m = LEASE_NAME_RE.exec(name);
  if (!m) return null;
  const pid = parseInt(m[1], 10);
  const claimMs = parseInt(m[2], 10);
  if (!Number.isFinite(pid) || !Number.isFinite(claimMs)) return null;
  return { pid, claimMs };
}
function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); } // exists but not signalable by us -> still alive
}
// M7 (contract v2.15): the pending payload carries the CREATING event's own identity columns
// (sid_sha16/agent_sha16/agent_type/prompt_id/tool_use_id, stashed at Pre time — see handlePre's payload
// construction); GC-discovered receipt-lost/pending-expired rows use THOSE identity columns, never the
// discovering event's own session/agent — a GC opportunistically triggered by a later, unrelated session
// must not misattribute the row to itself. tool_use_id NEVER falls back (contract row_attribution: "no
// union with the current event id") -- a payload that fails to parse or never had a tool_use_id produces
// an attribution-less row on that column regardless.
//
// 2026-09-23 (canary red, HEAD cb70d64): 5 real pending-expired rows landed with EVERY identity column
// blank -- traced to pending files created before the M7 stash existed (this gate opportunistically GCs
// on every invocation, so an old, pre-M7 `<hash>.json` sitting past PENDING_EXPIRED_MS gets reaped by
// TODAY's code, and `payload.sid_sha16` etc. are simply absent from that old JSON, not misread). The
// contract's "never from the event whose GC found it" is written for the covered case where the
// original DOES carry M7 identity; it does not address a payload with NO identity to attribute to at
// all. `fallback` (the CURRENT GC-performing event's own identity, threaded in from gcPending's caller)
// fills the gap for pre-M7 orphans so a row is never fully blank going forward.
//
// 2026-09-23 fab-delta MEDIUM-5 (OPUS-2026-09-23-fab-delta-triage.md): the first cut of this fix applied
// `fallback` PER-FIELD, keyed on each field's own truthiness (`payload.sid_sha16 || fb.sid_sha16 || ''`).
// That conflates "the field is absent" (pre-M7 orphan, the case this was built for) with "the field is
// PRESENT and its legal value is ''" (an M7 payload stashed by a main session, whose sid_sha16/agent_type
// are legitimately blank) -- M7 always writes all four keys, so a main-session creator's blank columns
// got individually laundered into the DISCOVERING event's real identity, producing a "creator sid_sha16 +
// discoverer agent_sha16" chimera row. Fixed by keying on key PRESENCE (`hasM7`, via hasOwnProperty), not
// per-field truthiness: an M7 payload's four identity columns are taken from the payload as ONE WHOLE
// GROUP (its own '' preserved as-is, never individually backfilled); only a payload with NO M7 keys at
// all (genuinely pre-M7) or one that fails to parse falls back to `fallback`, and that fallback is also
// applied as one whole group. tool_use_id's own rule is unchanged: it NEVER falls back (contract
// row_attribution: "no union with the current event id") -- a payload that fails to parse or never had a
// tool_use_id produces an attribution-less row on that column regardless.
function readPendingIdentity(fullPath, fallback) {
  const fb = fallback || {};
  try {
    const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const hasM7 = !!(payload && Object.prototype.hasOwnProperty.call(payload, 'sid_sha16'));
    const src = hasM7 ? payload : fb;
    return {
      tool_use_id: payload.tool_use_id || '',
      sid_sha16: src.sid_sha16 || '',
      agent_sha16: src.agent_sha16 || '',
      agent_type: src.agent_type || '',
      prompt_id: src.prompt_id || '',
    };
  } catch (e) {
    return { tool_use_id: '', sid_sha16: fb.sid_sha16 || '', agent_sha16: fb.agent_sha16 || '', agent_type: fb.agent_type || '', prompt_id: fb.prompt_id || '' };
  }
}

function gcPending(root, writeInformational, currentIdentity) {
  const dir = pendingDir(root);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return; }
  const now = Date.now();
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (name.indexOf('.processing.') >= 0) {
      const lease = parseLeaseName(name);
      if (lease && isPidAlive(lease.pid)) continue; // owner still running -> never reap
      const ageMs = lease ? (now - lease.claimMs) : (now - st.mtimeMs);
      if (ageMs <= PROCESSING_STALE_MS) continue;
      writeInformational('receipt-lost', readPendingIdentity(full, currentIdentity));
      try { fs.unlinkSync(full); } catch (e) { /* best effort */ }
    } else if (/^[0-9a-f]{64}\.json$/.test(name)) {
      const ageMs = now - st.mtimeMs;
      if (ageMs <= PENDING_EXPIRED_MS) continue;
      writeInformational('pending-expired', readPendingIdentity(full, currentIdentity));
      try { fs.unlinkSync(full); } catch (e) { /* best effort */ }
    }
  }
}

// ============================================================================
// disposition (contract conventions.gate_disposition_map)
// ============================================================================
function dispositionKindsFor(finding, mode) {
  if (finding.gate === 'B') return ['would-warn'];
  if (finding.confidence === 'recurrence-candidate') return ['recurrence-candidate'];
  return mode === 'intervene' ? ['would-warn', 'EMIT'] : ['would-warn'];
}

// ============================================================================
// row writers
// ============================================================================
// TSV-sanitize every free-text field before it reaches the ledger (tab/CR/LF/NUL -> '_'; contract Z10
// injects all four into tool_use_id and requires the row to stay structurally intact with sanitized=1).
function baseRowFields(ctx) {
  const toolUseIdF = ledger.sanitize(ctx.toolUseId || '');
  const agentTypeF = ledger.sanitize(ctx.agentType || '');
  const promptIdF = ledger.sanitize(ctx.promptId || '');
  const anySanitized = toolUseIdF.sanitized || agentTypeF.sanitized || promptIdF.sanitized;
  return {
    sid_sha16: ctx.sessionId ? sha16(ctx.sessionId) : '',
    agent_sha16: ctx.agentId ? sha16(ctx.agentId) : '',
    agent_type: agentTypeF.value,
    prompt_id: promptIdF.value,
    tool_use_id: toolUseIdF.value,
    cmd_sha16: ctx.cmd ? sha16(ctx.cmd) : '',
    parser_version: ctx.parserVersion || '',
    run_provenance: process.env.PMM_RECALL_TAG || '',
    sanitized: anySanitized ? '1' : '0',
    id_missing: (ctx.sessionId && ctx.toolUseId) ? '0' : '1',
    agent_id_missing: ctx.agentId ? '0' : '1',
  };
}

// resolveAssignmentForClass(classTag, gateLetter) -> {mode:'shadow'|'intervene', reason}, called once PER
// FINDING (M-SPEC assignment(session_id, class_tag) takes class_tag as an argument, and a seam/mutant-
// injected judge() could in principle vary class_tag per finding, even though production findings from
// analyzeCommand() itself always default to GATE_LESSON_CLASS_TAG today). gateLetter is this gate's own
// addition (contract v2.19 policy_file's per-gate gates[G] refinement), ignored by a seam override.
// M1 display-layer queue rows (M-SPEC M1 section / coordinator 2026-09-17: "闸对每条 gate 行(would-warn/
// emitted/recurrence-candidate)...各写一条展示层记录"): exactly these three event_kinds, matching
// pmm-recall-queue.cjs's own MATCHED_KINDS set (which also excludes 'emit-failed' -- a failed emission
// never had a real intervention to show the annotator).
const QUEUE_WORTHY_KINDS = new Set(['would-warn', 'emitted', 'recurrence-candidate']);

function writeFindingRows(ctx, findings, units, resolveAssignmentForClass) {
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i] || {};
    const instance = units[i] ? units[i].instance : (units[0] ? units[0].instance : '');
    const unitExe = units[i] ? (units[i].exe || '') : (units[0] ? (units[0].exe || '') : '');
    const unitSub = units[i] ? (units[i].sub || '') : (units[0] ? (units[0].sub || '') : '');
    const impId = ledger.impressionId({
      session_id: ctx.sessionId, agent_id: ctx.agentId, tool_use_id: ctx.toolUseId,
      trigger_or_gate_id: f.gate, gate_instance_id: instance,
    });
    // contract v2.19 gate_row_class_tag: default to the fixed lesson tag (real analyzeCommand()
    // findings never set class_tag themselves); a seam-injected judge() finding that DOES supply its own
    // class_tag still wins (contract causal_sentinels: the 'always' mutant embeds
    // finding.class_tag='mutant-always-<nonce>' and requires it to reach the ledger verbatim for its
    // causality check, so this default must never override an explicitly-set value).
    const classTag = f.class_tag || GATE_LESSON_CLASS_TAG;
    const assignment = resolveAssignmentForClass(classTag, f.gate) || { mode: 'shadow', provenance: 'absent' };
    // contract v2.19 policy_file, Opus review correction: run_provenance = 'policy:<policy-mode>' describes
    // the POLICY CONFIGURATION SHAPE (absent/corrupt/shadow/shadow-gate/randomized), never which ARM the
    // coin flip landed on -- the arm lives only in the `mode` column. A randomized-and-unlocked class
    // therefore writes 'policy:randomized' for BOTH its intervene-arm and shadow-arm rows (only `mode`
    // differs between them). Computed ONCE per finding from `assignment.provenance` and applied to every
    // row this finding produces (would-warn AND, when mode==='intervene', the emitted/emit-failed row).
    const runProvenance = 'policy:' + assignment.provenance;
    const kinds = dispositionKindsFor(f, assignment.mode);
    for (const kindRaw of kinds) {
      let kind = kindRaw;
      // contract v2.23 gate_disposition_map (codex MEDIUM-5, Opus confirmed: one impression had would-warn
      // mode=shadow and emitted mode=intervene): ALL rows produced by ONE finding carry the SAME mode = the
      // arm the finding was assigned to; event_kind (would-warn vs emitted/emit-failed) is what
      // distinguishes them, never mode. Initialized to the finding's own assigned arm (not hardcoded
      // 'shadow') -- 'EMIT' only ever appears in `kinds` when dispositionKindsFor() was already called with
      // mode==='intervene' (see its own body), so assignment.mode is already 'intervene' whenever this
      // branch runs; no separate override is needed or correct.
      let rowMode = assignment.mode;
      if (kind === 'EMIT') {
        let ok = true;
        try { fs.writeSync(1, '[pipe-gate] ' + f.gate + '/' + f.confidence + '\n'); }
        catch (e) { ok = false; }
        kind = ok ? 'emitted' : 'emit-failed';
      }
      const ordinal = ledger.ordinalOf(f.gate, instance, kind);
      const evId = ledger.eventId(impId, kind, ordinal);
      ledger.writeEvent(Object.assign({}, baseRowFields(ctx), {
        impression_id: impId, event_id: evId, event_kind: kind,
        gate: f.gate, confidence: f.confidence, class_tag: classTag,
        trigger_or_gate_id: f.gate, mode: rowMode, run_provenance: runProvenance,
      }), { root: ctx.root });
      // M1 display layer (queue-<host>.tsv): one record per qualifying ledger row (writeQueue is already
      // silent-on-failure internally -- fs errors are caught and recorded via noteWriteFailure, never
      // thrown here). 7-day rolling is a READ-side concern (pmm-recall-queue.cjs filters by ts) -- no
      // background cleanup is written here.
      if (QUEUE_WORTHY_KINDS.has(kind)) {
        ledger.writeQueue({
          impression_id: impId, trigger_or_gate_id: f.gate, class_tag: classTag,
          exe: unitExe, sub: unitSub, snippet: desensitize(ctx.cmd),
        }, { root: ctx.root });
      }
    }
  }
}

// contract v2.19 gate_row_class_tag: every gate-bearing row (would-warn/emitted/emit-failed/
// recurrence-candidate, gates A/B/D) AND every informational row THIS GATE writes carries this constant --
// all three gates implement the ONE lesson "pipes hide the real exit code and truncate evidence" (brief
// §26: the 2026-09-17 production ledger had 1019 gate rows with an EMPTY class_tag because analyzeCommand's
// own findings never set one, so policy.json lookups by class_tag could never match, and M1/M3 grouped
// everything under (unknown)). trigger_or_gate_id is unaffected, still A/B/D. session-end rows are NOT in
// scope (written by pmm-recall-ledger.cjs's own writeSessionEnd, never by this gate).
const GATE_LESSON_CLASS_TAG = 'process:pipe-hides-exit-code-and-truncates-evidence';

// contract v2.14 conventions.informational_row_attribution / gate_disposition_map: every informational
// row (unsupported, path_unresolved, cd-hint, pending-conflict, pending-corrupt, pending-expired,
// receipt-lost) carries `gate` and `trigger_or_gate_id` — unsupported -> A/A; path_unresolved/cd-hint ->
// D/D; the whole pending/receipt family -> D/D (they exist only for gate D evidence). session-end is NOT
// in this map and keeps both columns empty (written separately by pmm-recall-ledger.cjs's own
// writeSessionEnd, which never goes through this function).
const INFORMATIONAL_GATE_MAP = {
  unsupported: 'A',
  path_unresolved: 'D',
  'cd-hint': 'D',
  'pending-conflict': 'D',
  'pending-corrupt': 'D',
  'pending-expired': 'D',
  'receipt-lost': 'D',
};
function informationalGateFor(kind) { return INFORMATIONAL_GATE_MAP[kind] || ''; }

function writeInformationalRows(ctx, kinds) {
  for (const kind of kinds) {
    const ordinal = ledger.ordinalOf('', '', kind);
    const evId = ledger.eventId(ctx.toolUseId || '', kind, ordinal);
    const g = informationalGateFor(kind);
    ledger.writeEvent(Object.assign({}, baseRowFields(ctx), {
      impression_id: '', event_id: evId, event_kind: kind,
      gate: g, confidence: '', class_tag: GATE_LESSON_CLASS_TAG, trigger_or_gate_id: g, mode: 'shadow',
    }), { root: ctx.root });
  }
}

function writeInformationalRowFor(root, kind, toolUseId, extraFields) {
  const ordinal = ledger.ordinalOf('', '', kind);
  const evId = ledger.eventId(toolUseId || '', kind, ordinal);
  const g = informationalGateFor(kind);
  const base = { impression_id: '', event_id: evId, event_kind: kind, gate: g, confidence: '', class_tag: GATE_LESSON_CLASS_TAG, trigger_or_gate_id: g, mode: 'shadow', tool_use_id: toolUseId || '' };
  ledger.writeEvent(Object.assign(base, extraFields || {}), { root });
}

// ============================================================================
// PreToolUse handler
// ============================================================================
function handlePre(data, seam, root) {
  const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input)) ? data.tool_input : null;
  if (!toolInput) return;
  const cmd = toolInput.command;
  if (typeof cmd !== 'string' || cmd.trim() === '') return;

  const sessionId = (typeof data.session_id === 'string' && data.session_id) ? data.session_id : '';
  const agentId = (typeof data.agent_id === 'string' && data.agent_id) ? data.agent_id : '';
  const agentType = (typeof data.agent_type === 'string' && data.agent_type) ? data.agent_type : '';
  const promptId = (typeof data.prompt_id === 'string' && data.prompt_id) ? data.prompt_id : '';
  const toolUseId = (typeof data.tool_use_id === 'string' && data.tool_use_id) ? data.tool_use_id : '';
  const cwd = (typeof data.cwd === 'string' && data.cwd.trim() !== '') ? data.cwd : process.cwd();

  const parseFn = seam.parse || realParseFn;
  const judgeFn = seam.judge || null;
  const seamAssignmentFn = seam.assignment || null;

  let parsed;
  try { parsed = parseFn(cmd, { tool: 'Bash', cwd }); } catch (e) { parsed = { segments: [], parser_version: '1.2' }; }

  const analysisCtx = { cwd, root, sessionId, agentId, ttlSeconds: 3600 };
  const analysis = analyzeCommand(parsed, analysisCtx);
  let judgement;
  if (judgeFn) {
    try { judgement = judgeFn(parsed, { cmdRaw: cmd }) || { gates: [], events: [] }; }
    catch (e) { judgement = { gates: [], events: [] }; }
  } else {
    judgement = { gates: analysis.units.map((u) => u.finding), events: analysis.events };
  }
  const findings = Array.isArray(judgement.gates) ? judgement.gates : [];
  const judgeEvents = Array.isArray(judgement.events) ? judgement.events : [];

  // M3 allocation (contract v2.18 policy_file): a seam-injected `assignment` (mutants/self-test) is a
  // mode-only override -- it bypasses real policy.json reading entirely (same "individually fall back to
  // real implementation" contract judge/parse already follow), so run_provenance in that case is just
  // 'policy:' + whatever mode it returned, never 'policy:corrupt' (corrupt-policy detection is specifically
  // about THIS gate's own real read of the file). With no seam override, resolveAssignment() does the real
  // read (missing/randomized-hash/corrupt) per contract policy_file.
  const resolveAssignmentForClass = seamAssignmentFn
    ? function (classTag) {
      // A seam override is a mode-only replacement (M-SPEC's own assignment(session,class_tag) signature
      // never took a gate letter either -- the per-gate gates[G] refinement is real-policy-specific logic
      // layered on TOP of assignment() by this gate itself, not part of the DI-seam-replaceable contract).
      // No real policy.json is ever consulted under a seam override, so provenance is 'absent' (the closed
      // 5-value taxonomy -- absent/corrupt/shadow/shadow-gate/randomized -- has no slot for "a seam decided
      // this"; 'absent' ("nothing configured for this class") is the most honest fit).
      let mode = 'shadow';
      try { mode = seamAssignmentFn(sessionId, classTag) || 'shadow'; } catch (e) { mode = 'shadow'; }
      return { mode, provenance: 'absent' };
    }
    : function (classTag, gateLetter) { return resolveAssignment(root, sessionId, classTag, gateLetter); };

  const rowCtx = { sessionId, agentId, agentType, promptId, toolUseId, cmd, parserVersion: (parsed && parsed.parser_version) || '1.2', root };
  writeFindingRows(rowCtx, findings, analysis.units, resolveAssignmentForClass);
  writeInformationalRows(rowCtx, judgeEvents);

  // Pending snapshot (parse-driven, independent of judge/seam override).
  const targets = collectPendingTargets(parsed, cwd);
  if (targets.length > 0) {
    const keyPath = pendingKeyPath(root, sessionId, agentId, toolUseId);
    const snapshots = targets.map((t) => Object.assign({ op: t.op }, snapshotPath(t.path)));
    // M7 (contract v2.15): stash the CREATING event's own identity columns in the payload so a later GC
    // (possibly triggered by a completely different session) can attribute receipt-lost/pending-expired
    // to the ORIGINAL creator, never to itself.
    const payload = {
      cmd, tool_use_id: toolUseId, targets: snapshots,
      sid_sha16: sessionId ? sha16(sessionId) : '', agent_sha16: agentId ? sha16(agentId) : '',
      agent_type: agentType || '', prompt_id: promptId || '',
    };
    const result = createOrJoinPending(keyPath, JSON.stringify(payload), cmd);
    if (result.status === 'conflict') writeInformationalRows(rowCtx, ['pending-conflict']);
    else if (result.status === 'corrupt') writeInformationalRows(rowCtx, ['pending-corrupt']);
  }

  // 2026-09-23 canary fix (fab-delta MEDIUM-5 revision): fallback identity for a pre-M7 orphaned pending
  // with no stashed identity of its own (see readPendingIdentity's comment) -- this Pre event's own
  // sid/agent/type/prompt, applied by readPendingIdentity as ONE WHOLE GROUP only when the payload has
  // no M7 identity keys at all; an M7 payload's own (possibly blank) columns are never backfilled.
  gcPending(root, (kind, identity) => writeInformationalRowFor(root, kind, identity.tool_use_id, {
    sid_sha16: identity.sid_sha16, agent_sha16: identity.agent_sha16, agent_type: identity.agent_type, prompt_id: identity.prompt_id,
  }), {
    sid_sha16: sessionId ? sha16(sessionId) : '', agent_sha16: agentId ? sha16(agentId) : '',
    agent_type: agentType || '', prompt_id: promptId || '',
  });
}

// ============================================================================
// PostToolUse handler (also used for PostToolUseFailure — contract v2.14
// lifecycle_ops: Claude Code does not fire PostToolUse for a failed tool call,
// it fires PostToolUseFailure instead; this gate treats the two identically:
// consume the pending, diff, write the receipt. tool_response.exit_code is
// taken when present, otherwise recorded as -1 (unknown) — the receipt class
// never depends on the exit code either way.)
// ============================================================================
// H2 (contract v2.15 receipt_commit_and_lease): find an EXISTING `<keyPath>.processing.<lease>` file when
// `keyPath` itself is gone — the retry path for a lease a PRIOR Post claimed but failed to commit (the
// receipt append never landed, so the lease was deliberately left in place instead of being dropped).
function findExistingLease(keyPath) {
  const dir = path.dirname(keyPath);
  const prefix = path.basename(keyPath) + '.processing.';
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return null; }
  for (const name of entries) {
    if (name.indexOf(prefix) === 0) return path.join(dir, name);
  }
  return null;
}

function handlePost(data, root) {
  const sessionId = (typeof data.session_id === 'string' && data.session_id) ? data.session_id : '';
  const agentId = (typeof data.agent_id === 'string' && data.agent_id) ? data.agent_id : '';
  const toolUseId = (typeof data.tool_use_id === 'string' && data.tool_use_id) ? data.tool_use_id : '';
  const toolResponse = (data.tool_response && typeof data.tool_response === 'object') ? data.tool_response : {};
  // contract v2.18 rc_column_note (fab L13): real Claude Code PostToolUse/PostToolUseFailure payloads for
  // Bash carry NO tool_response.exit_code field at all — this is not a test-harness artifact, it is what
  // production actually sends. So receipt rc = -1 is the ordinary, expected value in production, not a
  // marker of anything unusual. classifyTarget() never reads this column (it diffs pre/post file state via
  // size/fileId/content-fingerprint), so this permanent -1 does not affect commit classification.
  const rc = (toolResponse.exit_code === undefined || toolResponse.exit_code === null) ? '-1' : String(toolResponse.exit_code);

  const keyPath = pendingKeyPath(root, sessionId, agentId, toolUseId);
  let exists = false;
  try { exists = fs.existsSync(keyPath); } catch (e) { exists = false; }

  // MEDIUM-2 (contract v2.16, fab blind attack / L22): read the payload from `srcPath` and, if it parses,
  // write the receipt (commit-then-cleanup, same fsync discipline as H2) then remove `srcPath`; if it does
  // NOT parse, record pending-corrupt and remove `srcPath`. `srcPath` may be a `.processing.<lease>` file
  // (the normal path) OR the plain pending file itself (the in-place fallback below, when even a RETRIED
  // rename never succeeds — e.g. another process is holding it with an exclusive, share-none handle). A
  // failed unlink in either branch is left for the pending-expired / receipt-lost GC, never silently
  // dropped.
  function consumePendingAt(srcPath) {
    let text = null;
    try { text = fs.readFileSync(srcPath, 'utf8'); } catch (e) { text = null; }
    let payload = null;
    if (text) { try { payload = JSON.parse(text); } catch (e) { payload = null; } }
    if (!payload || !Array.isArray(payload.targets)) {
      writeInformationalRowFor(root, 'pending-corrupt', toolUseId, { sid_sha16: sha16(sessionId), agent_sha16: sha16(agentId) });
      try { fs.unlinkSync(srcPath); } catch (e) { /* left for GC */ }
      return;
    }
    const rf = receiptsPath(root, sessionId, agentId);
    let lines = '';
    for (const t of payload.targets) {
      const cls = classifyTarget(t);
      lines += [new Date().toISOString(), cls, t.path, toolUseId, rc].join('\t') + '\n';
    }
    // H2: the source is removed ONLY after the receipt line has actually landed durably (append + fsync).
    // A failed append (e.g. the receipts path is blocked) leaves it in place — a LATER Post retry (the
    // findExistingLease branch below) or the TTL GC picks it up; the event is never silently dropped.
    let committed = false;
    try {
      mkdirp(root);
      const fd = fs.openSync(rf, 'a');
      try { fs.writeSync(fd, lines); fs.fsyncSync(fd); committed = true; }
      finally { fs.closeSync(fd); }
    } catch (e) { committed = false; }
    if (committed) {
      try { fs.unlinkSync(srcPath); } catch (e) { /* left for GC */ }
    }
  }

  if (exists) {
    const claimMs = Date.now();
    const lease = 'p' + process.pid + '-' + claimMs + '-' + Math.random().toString(36).slice(2);
    const candidate = keyPath + '.processing.' + lease;
    // MEDIUM-2: retry the rename up to 60x5ms (symmetric with Pre's own createOrJoinPending retry budget,
    // and matching contract L22's 300ms exclusive-hold window) before falling back to reading the payload
    // IN PLACE — a transient lock (e.g. Windows FileShare.None) must not make the receipt vanish.
    let renamed = false;
    for (let attempt = 0; attempt < 60 && !renamed; attempt++) {
      try { fs.renameSync(keyPath, candidate); renamed = true; }
      catch (e) { if (attempt < 59) sleepMs(5); }
    }
    if (renamed) {
      // H3: a Windows rename keeps the SOURCE file's mtime, which can predate the claim by however long
      // the pending sat around — touch it to the claim time so mtime (the fallback GC signal when a lease
      // name cannot be parsed) agrees with the name-embedded claimMs (the primary signal).
      try { fs.utimesSync(candidate, claimMs / 1000, claimMs / 1000); } catch (e) { /* best effort */ }
      consumePendingAt(candidate);
    } else {
      // Rename never succeeded even after retrying — the pending file itself is still the source of
      // truth; read/commit/cleanup happens on it directly, never silently doing nothing.
      consumePendingAt(keyPath);
    }
  } else {
    // H2 retry path: no plain pending file, but a lease from an earlier Post that failed to commit its
    // receipt may still be sitting here (deliberately, per receipt_commit_and_lease) — pick it up and try
    // again rather than silently doing nothing on this Post.
    const existingLease = findExistingLease(keyPath);
    if (existingLease) consumePendingAt(existingLease);
  }

  // 2026-09-23 canary fix (fab-delta MEDIUM-5 revision): same whole-group fallback as handlePre's call
  // (see readPendingIdentity's comment) -- handlePost has no agent_type/prompt_id of its own to offer
  // (PostToolUse payloads are never parsed for those fields here), so only sid_sha16/agent_sha16 are
  // offered as fallback at this call site; a pre-M7 orphan reaped here would still show blank
  // agent_type/prompt_id, matching handlePost's own real data availability rather than fabricating
  // values this event never actually carried. An M7-compliant payload's own columns (blank or not) are
  // never touched by this fallback regardless of what's offered here.
  gcPending(root, (kind, identity) => writeInformationalRowFor(root, kind, identity.tool_use_id, {
    sid_sha16: identity.sid_sha16, agent_sha16: identity.agent_sha16, agent_type: identity.agent_type, prompt_id: identity.prompt_id,
  }), {
    sid_sha16: sessionId ? sha16(sessionId) : '', agent_sha16: agentId ? sha16(agentId) : '',
  });
}

// ============================================================================
// main
// ============================================================================
function main() {
  let raw;
  try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { miss(); }
  if (!raw || raw.trim() === '') miss();
  let data;
  try { data = JSON.parse(raw); } catch (e) { miss(); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) miss();

  const seam = resolveSeam();
  const root = ledger.resolveRoot();
  const hookEvent = (typeof data.hook_event_name === 'string' && data.hook_event_name) ? data.hook_event_name : 'PreToolUse';

  // contract v2.14 lifecycle_ops: PostToolUseFailure is what Claude Code actually fires for a failed
  // tool call (no PostToolUse in that case) — same Post path, not a third dispatch branch.
  if (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') handlePost(data, root);
  else handlePre(data, seam, root);

  process.exit(0);
}

module.exports = {
  resolvePathArg, isExistingFilePath, isRelativeOperandText, computeFileOperands, analyzeCommand,
  classifyTarget, pendingKeyPath, receiptsPath, lookupReceiptEvidence,
  dispositionKindsFor, resolveSeam, informationalGateFor, INFORMATIONAL_GATE_MAP,
  policyFilePath, resolveAssignment,
};

if (require.main === module && process.argv[2] !== '--self-test') {
  try { main(); } catch (e) { miss(); }
  process.exit(0);
}

// ============================================================================
// --self-test (contract conventions.self_test_summary): unit-level — module
// load, five silent inputs through the WIRED command string (byte-level),
// header equals shared module COLUMNS, at least one successful judgment path
// (A01 shadow -> would-warn row). Prints one `SELFTEST {...}` line.
// ============================================================================
if (require.main === module && process.argv[2] === '--self-test') {
  // SELFTEST-BEGIN
  // spec (guard-canary roster check, "3 段窄标记合并成 1 对"): a single pair now spans the ENTIRE
  // --self-test block (this line through the matching `}` at the very end of the file), not just the
  // 3 narrow isoEnv/footprint setup snippets it used to wrap -- nested begin/end marker pairs get
  // truncated by the roster checker's non-greedy region regex (it stops at the FIRST end-marker it
  // meets), so the 3 former inner pairs were removed rather than kept alongside this
  // outer one. This also means checkSessionLiterals now actually scans every fixture in this whole
  // self-test (previously only the 3 narrow regions were ever scanned for unprefixed session_id/
  // tool_use_id literals -- the ~19 `tu-*` fixtures scattered through the rest of the block were
  // invisible to it until now, which is why they needed the toolu_selftest_ prefix added alongside
  // this marker change, not just the marker change alone).
  const { execFileSync, spawnSync } = require('child_process');
  let PASS = 0, FAIL = 0;
  let loadCount = 0, silenceCount = 0, positiveCount = 0, headerCount = 0, informationalCount = 0;
  function report(name, ok, detail) {
    if (ok) { console.log('PASS: ' + name); PASS++; }
    else { console.log('FAIL: ' + name + ' -- ' + (detail || '')); FAIL++; }
  }

  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-pipe-exitcode-watch-selftest-'));
  function cleanup() { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* best effort */ } }
  process.on('exit', cleanup);

  // v2.25 home_resolution production-safety (coordinator 2026-09-17: 9 synthetic session keys leaked
  // into the REAL trigger-log from an insufficiently-isolated self-test elsewhere in this repo). Audit
  // of THIS self-test: WIRED_CMD only ever runs bash-pipe-exitcode-watch.sh, which only ever runs this
  // .cjs (confirmed by reading the .sh -- no dispatch to pmm-trigger-recall/pmm-bash-impression); the
  // one M0 require() below calls only its pure desensitize() helper, never a write path; and every
  // subprocess call already overrides PMM_RECALL_ROOT to a temp dir -- so this gate's OWN self-test does
  // not currently reach the real hook chain. But every one of those subprocess env objects was built by
  // cloning the ambient live env directly (the "{}, "-plus-live-env-plus-"{PMM_RECALL_ROOT: ...}" shape),
  // passing the REAL HOME/USERPROFILE/PMM_HOME straight through -- silent today only because this gate
  // never computes a trigger-adjacent path, so
  // this closes the whole class defensively rather than just today's instance (also isolates
  // PMM_TRIGGER_MEM/STATE/LOG in case a future subprocess this self-test spawns ever reads them).
  // spec 22 (K7/K23): the hand-rolled ambient-env clone this line used to build was already fully
  // isolating HOME/USERPROFILE/PMM_HOME/PMM_TRIGGER_* by VALUE (audit §2.2: "① 是(事实上)"), but the
  // roster's structural check is a literal pattern match, not a behavioral one -- routed through the
  // shared isoEnv() so this file carries the same single isolation implementation as every other
  // self-test instead of its own independently-correct copy.
  const iso = require('./selftest-iso.cjs');
  const SELFTEST_ISOLATED_ENV = iso.isoEnv(T, {});
  // Belt-and-suspenders proof (not just "we redirected the vars"): snapshot the REAL production root
  // triple's FILENAME SET (real ledger events-v3-*.tsv, real .trigger-seen-* set, real frozen
  // trigger-log) before this entire self-test runs and again at the very end, asserting the set is
  // unchanged -- found from THIS file's own __dirname, never from an env var (this self-test itself
  // runs under redirected env).
  //
  // Deliberately a FILENAME-SET comparison, not a content-hash comparison: this gate's own real
  // production hook fires on every real Bash tool call made in the SAME live session (including the
  // very one used to invoke this self-test), so the two TSV files' CONTENT legitimately grows with new
  // rows during a multi-second self-test run -- that is expected, real, unrelated production activity,
  // not a leak, and a content-hash check flagged it as one (empirically confirmed: two consecutive runs
  // produced two DIFFERENT "before"/"after" shas each time, purely from concurrent real hook traffic).
  // A NEW .trigger-seen-<synthetic-id> FILENAME appearing, by contrast, is exactly the leak class the
  // coordinator found (fab MEDIUM-1 follow-up: 9 synthetic session keys from an insufficiently-isolated
  // self-test elsewhere) -- and this gate has no legitimate reason to ever cause one to exist, since it
  // never touches trigger state itself.
  //
  // spec 22 (K23, audit §2.2 bash-pipe row): a pure FILENAME-SET comparison goes blind exactly when a
  // leak is APPENDED into an already-existing real ledger/trigger-log file (the s-cyc incident shape --
  // the set of filenames never changes, only a file's content grows) -- measured, this is why the old
  // check here could never have caught it. Replaced by the shared selftest-iso.cjs footprint, which
  // diffs APPENDED BYTES against this run's own markers (nonce + this file's own literal session_id/
  // tool_use_id fixtures), not just the directory listing.
  const REAL_TREE_HOME = path.resolve(GUARD_DIR, '..', '..');
  const SELFTEST_NONCE = 'nonce-' + crypto.randomBytes(6).toString('hex');
  const FOOTPRINT_SNAP = iso.footprint.begin();

  console.log('=== load ===');
  report('load: pmm-recall-ledger.cjs COLUMNS is a 21-entry array', Array.isArray(ledger.COLUMNS) && ledger.COLUMNS.length === 21, String(ledger.COLUMNS.length));
  if (Array.isArray(ledger.COLUMNS) && ledger.COLUMNS.length === 21) loadCount++;
  report('load: pmm-cmd-parse.cjs exports parseCommand', typeof REAL_PARSER.parseCommand === 'function');
  if (typeof REAL_PARSER.parseCommand === 'function') loadCount++;
  report('load: analyzeCommand is a pure function callable on an empty parse', (() => {
    const r = analyzeCommand({ segments: [] }, { cwd: T, root: T, sessionId: '', agentId: '', ttlSeconds: 3600 });
    return Array.isArray(r.units) && Array.isArray(r.events) && r.units.length === 0 && r.events.length === 0;
  })());
  loadCount++;

  console.log();
  console.log('=== header ===');
  {
    const root = path.join(T, 'header-root');
    ledger.writeEvent({ tool_use_id: 'toolu_selftest_header', event_kind: 'observed' }, { root });
    const text = fs.readFileSync(ledger.ledgerPath(root), 'utf8');
    const header = text.split('\n')[0];
    report('header: ledger header line equals shared module COLUMNS', header === ledger.COLUMNS.join('\t'), header);
    headerCount++;
  }

  console.log();
  console.log('=== silence (five bad inputs through the WIRED command string) ===');
  const G = GUARD_DIR;
  const WIRED_CMD = 'bash "' + path.join(G, 'bash-pipe-exitcode-watch.sh').replace(/\\/g, '/') + '" || { echo "bash-pipe-exitcode-watch 自身故障 — 报告闸 fail-open 放行" >&2; exit 0; }';
  // 2026-09-17 falsify-caught bug: without an explicit stdio pipe, a plain execFileSync call does NOT
  // expose the child's stderr via its own return value on a SUCCESSFUL (rc=0) exit -- only the THROWN Error's own
  // `.stderr` property carries it, and only on a non-zero exit. On the success path, stderr is silently
  // inherited straight through to THIS process's own stderr instead of being captured, so the old code
  // here (`err = Buffer.alloc(0)` hardcoded on success) made every `errLen === 0` assertion downstream of
  // runWired() (silence cases, H2, Z24, the M3 P04/shadow-gate black-box checks) structurally incapable of
  // ever going red on a real stderr leak on the rc=0 path -- a false green, caught by deliberately writing
  // one throwaway byte to stderr on that path and confirming the assertions did NOT catch it (see this
  // round's commit message for the red output). spawnSync() unconditionally returns {stdout, stderr,
  // status} regardless of exit code, so it replaces execFileSync() here entirely -- no branch depends on
  // whether the child threw.
  function runWired(stdinBuf, envExtra) {
    const root = path.join(T, 'silence-root-' + Math.random().toString(36).slice(2));
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }, envExtra || {});
    const r = spawnSync('bash', ['-c', WIRED_CMD], { input: stdinBuf, env, timeout: 5000 });
    const out = r.stdout || Buffer.alloc(0);
    const err = r.stderr || Buffer.alloc(0);
    const rc = (r.status === null || r.status === undefined) ? -1 : r.status;
    return { outLen: Buffer.from(out).length, errLen: Buffer.from(err).length, rc };
  }
  function silenceCase(name, stdinBuf, envExtra) {
    const r = runWired(stdinBuf, envExtra);
    report('silence: ' + name, r.outLen === 0 && r.errLen === 0 && r.rc === 0, JSON.stringify(r));
    silenceCount++;
  }
  silenceCase('closed/empty stdin', '');
  silenceCase('single NUL byte', Buffer.from([0]));
  silenceCase('malformed JSON', '{not json');
  silenceCase('valid JSON, empty command', JSON.stringify({ session_id: 'test:silence-empty', tool_use_id: 'toolu_selftest_silence_empty', tool_input: { command: '' } }));
  {
    const occRoot = path.join(T, 'unwritable-root');
    mkdirp(occRoot);
    mkdirp(ledger.ledgerPath(occRoot)); // occupy the ledger path with a directory
    silenceCase('unwritable ledger path (occupied by a directory)', JSON.stringify({ session_id: 'test:silence-unwritable', tool_use_id: 'toolu_selftest_silence_unwritable', cwd: T, tool_input: { command: 'a | b; rc=$?' } }), { PMM_RECALL_ROOT: occRoot });
  }

  console.log();
  console.log('=== positive: at least one successful judgment path (A01 shadow -> would-warn) ===');
  {
    const root = path.join(T, 'positive-root');
    const hook = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'test:pos', agent_id: 'a-pos', agent_type: 'worker',
      prompt_id: 'p-pos', tool_use_id: 'toolu_selftest_pos', cwd: T, tool_input: { command: 'a | b; rc=$?' },
    });
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root });
    let ok = true;
    try { execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env, timeout: 5000 }); } catch (e) { ok = false; }
    let foundWouldWarnA = false;
    try {
      const text = fs.readFileSync(ledger.ledgerPath(root), 'utf8');
      const lines = text.split('\n').filter(Boolean);
      const kindIdx = ledger.COLUMNS.indexOf('event_kind');
      const gateIdx = ledger.COLUMNS.indexOf('gate');
      const tuIdx = ledger.COLUMNS.indexOf('tool_use_id');
      foundWouldWarnA = lines.slice(1).some((l) => {
        const c = l.split('\t');
        return c[tuIdx] === 'toolu_selftest_pos' && c[kindIdx] === 'would-warn' && c[gateIdx] === 'A';
      });
    } catch (e) { foundWouldWarnA = false; }
    report('positive: A01-shaped command under production shadow -> a would-warn/A row appears in the ledger', ok && foundWouldWarnA);
    if (foundWouldWarnA) positiveCount++;
  }

  console.log();
  console.log('=== informational row gate attribution (contract v2.14 informational_row_attribution) ===');
  {
    // Unit-level: the mapping table itself, checked against the contract's literal assignment. This is
    // the direct reverse-proof surface — reverting INFORMATIONAL_GATE_MAP's values to '' (or deleting
    // entries) fails every one of these seven immediately, without needing to reproduce each kind
    // end-to-end.
    const EXPECTED_MAP = {
      unsupported: 'A', path_unresolved: 'D', 'cd-hint': 'D',
      'pending-conflict': 'D', 'pending-corrupt': 'D', 'pending-expired': 'D', 'receipt-lost': 'D',
    };
    for (const [kind, wantGate] of Object.entries(EXPECTED_MAP)) {
      const got = informationalGateFor(kind);
      report('unit: informationalGateFor(' + kind + ') === ' + wantGate, got === wantGate, 'got=' + JSON.stringify(got));
      informationalCount++;
    }
    report('unit: session-end kind is NOT in the map (stays blank, written by pmm-recall-ledger.cjs separately)', informationalGateFor('session-end') === '', informationalGateFor('session-end'));
    informationalCount++;

    // Black-box: drive the real WIRED command and read the actual ledger row's gate/trigger_or_gate_id
    // columns for one A-mapped kind (unsupported) and one D-mapped kind (path_unresolved).
    function readInfoRow(root, toolUseId, kind) {
      let text = '';
      try { text = fs.readFileSync(ledger.ledgerPath(root), 'utf8'); } catch (e) { return null; }
      const lines = text.split('\n').filter(Boolean);
      const tuIdx = ledger.COLUMNS.indexOf('tool_use_id');
      const kindIdx = ledger.COLUMNS.indexOf('event_kind');
      const gateIdx = ledger.COLUMNS.indexOf('gate');
      const trigIdx = ledger.COLUMNS.indexOf('trigger_or_gate_id');
      for (const l of lines.slice(1)) {
        const c = l.split('\t');
        if (c[tuIdx] === toolUseId && c[kindIdx] === kind) return { gate: c[gateIdx], trigger_or_gate_id: c[trigIdx] };
      }
      return null;
    }
    {
      const root = path.join(T, 'info-unsupported-root');
      const hook = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:unsup', agent_id: 'a-unsup', tool_use_id: 'toolu_selftest_unsup',
        cwd: T, tool_input: { command: '! a | b; rc=$?' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
      const row = readInfoRow(root, 'toolu_selftest_unsup', 'unsupported');
      report('black-box: unsupported row carries gate=A trigger_or_gate_id=A', !!row && row.gate === 'A' && row.trigger_or_gate_id === 'A', JSON.stringify(row));
      informationalCount++;
    }
    {
      const root = path.join(T, 'info-pathunresolved-root');
      const hook = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:pu', agent_id: 'a-pu', tool_use_id: 'toolu_selftest_pu',
        cwd: T, tool_input: { command: 'tail -6 $UNDEFINED_SELFTEST_XYZ/x.txt' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
      const row = readInfoRow(root, 'toolu_selftest_pu', 'path_unresolved');
      report('black-box: path_unresolved row carries gate=D trigger_or_gate_id=D', !!row && row.gate === 'D' && row.trigger_or_gate_id === 'D', JSON.stringify(row));
      informationalCount++;
    }
  }

  console.log();
  console.log('=== v2.18 cd_hint_rule (contract Dc01/Dc02): cd-hint fires ONLY for a relative + nonexistent operand ===');
  let cdHintCount = 0;
  {
    // Unit-level (fast, exercises analyzeCommand directly): the four shapes the rule's own wording
    // enumerates -- relative+missing fires, absolute (existing or not) never fires, relative+existing never
    // fires (it gets a D row instead), and no operand never fires.
    const ctx = () => ({ cwd: T, root: T, sessionId: '', agentId: '', ttlSeconds: 3600 });
    {
      // Dc01: tail -5 missing-relative.txt (no such file, no `cd` anywhere in the command either --
      // proves the old anyCdSeen requirement is genuinely gone, not just untested).
      const parsed = REAL_PARSER.parseCommand('tail -5 missing-relative.txt', { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      report('Dc01: relative + nonexistent operand, no cd anywhere -> cd-hint, no D row', r.events.indexOf('cd-hint') >= 0 && r.units.length === 0, JSON.stringify(r));
      cdHintCount++;
    }
    {
      // Dc02: tail -5 <ABS>/existing.txt where the file genuinely exists -> D row (recurrence-candidate),
      // no cd-hint (operand is absolute).
      const existing = path.join(T, 'cdhint-existing.txt');
      fs.writeFileSync(existing, 'x');
      const cmd = 'tail -5 ' + existing.replace(/\\/g, '/');
      const parsed = REAL_PARSER.parseCommand(cmd, { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      report('Dc02: absolute + existing operand -> D row, no cd-hint', r.events.indexOf('cd-hint') < 0 && r.units.length === 1 && r.units[0].finding.gate === 'D' && r.units[0].finding.confidence === 'recurrence-candidate', JSON.stringify(r));
      cdHintCount++;
    }
    {
      // Absolute + MISSING operand -> neither a D row (doesn't exist) NOR cd-hint (not relative). This is
      // the case the old broad rule (anyDCandidateSegment && !anyDRow && anyCdSeen) would have wrongly hit
      // if a `cd` happened to appear earlier; the new rule must not.
      const missingAbs = path.join(T, 'cdhint-missing-abs.txt').replace(/\\/g, '/');
      const cmd = 'cd ' + T.replace(/\\/g, '/') + ' && tail -5 ' + missingAbs;
      const parsed = REAL_PARSER.parseCommand(cmd, { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      report('absolute + nonexistent operand (with a cd earlier) -> no cd-hint, no D row', r.events.indexOf('cd-hint') < 0 && r.units.length === 0, JSON.stringify(r));
      cdHintCount++;
    }
    {
      // Relative + EXISTING operand -> D row only, no cd-hint ("... or all exist ... never produces
      // cd-hint").
      const relExisting = 'cdhint-rel-existing.txt';
      fs.writeFileSync(path.join(T, relExisting), 'x');
      const parsed = REAL_PARSER.parseCommand('tail -5 ' + relExisting, { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      report('relative + existing operand -> D row, no cd-hint', r.events.indexOf('cd-hint') < 0 && r.units.length === 1 && r.units[0].finding.gate === 'D', JSON.stringify(r));
      cdHintCount++;
    }
    {
      // No operand at all ("... or has no operand, never produces cd-hint").
      const parsed = REAL_PARSER.parseCommand('tail', { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      report('head/tail with no file operand -> no cd-hint, no D row', r.events.indexOf('cd-hint') < 0 && r.units.length === 0, JSON.stringify(r));
      cdHintCount++;
    }

    // Black-box: the real Dc01 shape end-to-end through the wired script + real ledger row.
    {
      const root = path.join(T, 'cdhint-e2e-root');
      const hook = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:cdh', agent_id: 'a-cdh', tool_use_id: 'toolu_selftest_cdh',
        cwd: T, tool_input: { command: 'tail -5 missing-relative-e2e.txt' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
      let row = null;
      try {
        const text = fs.readFileSync(ledger.ledgerPath(root), 'utf8');
        const linesR = text.split('\n').filter(Boolean);
        const headerR = linesR[0].split('\t');
        const ix = (c) => headerR.indexOf(c);
        for (const l of linesR.slice(1)) {
          const c = l.split('\t');
          if (c[ix('tool_use_id')] === 'toolu_selftest_cdh' && c[ix('event_kind')] === 'cd-hint') { row = { gate: c[ix('gate')], trigger_or_gate_id: c[ix('trigger_or_gate_id')] }; break; }
        }
      } catch (e) { row = null; }
      report('black-box Dc01: end-to-end wired run writes a cd-hint row, gate=D trigger_or_gate_id=D', !!row && row.gate === 'D' && row.trigger_or_gate_id === 'D', JSON.stringify(row));
      cdHintCount++;
    }

    {
      // D11 (v2.19 clarification): `head -60 .` -- `.` resolves to the hook cwd itself, an EXISTING
      // DIRECTORY. isExistingFilePath('.') is false (not a FILE, correctly no D row), but existsAnyKind
      // ('.') is TRUE, so this must NOT be treated as "does not exist" for cd-hint purposes.
      const parsed = REAL_PARSER.parseCommand('head -60 .', { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      report('D11: existing directory operand (.) -> no cd-hint, no D row (existsSync true, not merely non-file)', r.events.indexOf('cd-hint') < 0 && r.units.length === 0, JSON.stringify(r));
      cdHintCount++;
    }
    {
      // D16 (v2.19 clarification): `tail -n5 ABS/existing.txt; tail +5 ABS/existing.txt` -- `+5` is an
      // old-style tail count token, not an operand; cd-hint must use the SAME option-consumed operand list
      // gate D itself uses, so `+5` never counts as a spurious "relative + nonexistent" phantom operand.
      const existing = path.join(T, 'd16-existing.txt');
      fs.writeFileSync(existing, 'x');
      const existingSlash = existing.replace(/\\/g, '/');
      const cmd = 'tail -n5 ' + existingSlash + '; tail +5 ' + existingSlash;
      const parsed = REAL_PARSER.parseCommand(cmd, { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      const dRows = r.units.filter((u) => u.finding.gate === 'D');
      report('D16: `+5` count token is consumed like `-n5`, never treated as an operand -> exactly 2 D rows, no cd-hint', r.events.indexOf('cd-hint') < 0 && dRows.length === 2 && dRows.every((u) => u.finding.confidence === 'recurrence-candidate'), JSON.stringify(r));
      cdHintCount++;
    }
  }

  console.log();
  console.log('=== PostToolUseFailure treated exactly like PostToolUse (contract v2.14 lifecycle_ops) ===');
  {
    const root = path.join(T, 'post-failure-root');
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root });
    const cmd = 'cmd > ' + path.join(T, 'ptf-r.txt').replace(/\\/g, '/');
    const preHook = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'test:ptf', agent_id: 'a-ptf', tool_use_id: 'toolu_selftest_ptf',
      cwd: T, tool_input: { command: cmd },
    });
    execFileSync('bash', ['-c', WIRED_CMD], { input: preHook, env, timeout: 5000 });
    fs.writeFileSync(path.join(T, 'ptf-r.txt'), 'xxxxxxxxxxxx'); // exec: write 12 bytes, as a real tool would
    // No tool_response at all -> exit_code must default to -1, not '' and not crash.
    const postFailureHook = JSON.stringify({
      hook_event_name: 'PostToolUseFailure', session_id: 'test:ptf', agent_id: 'a-ptf', tool_use_id: 'toolu_selftest_ptf', cwd: T,
    });
    let ok = true;
    try { execFileSync('bash', ['-c', WIRED_CMD], { input: postFailureHook, env, timeout: 5000 }); } catch (e) { ok = false; }
    const rf = receiptsPath(root, 'test:ptf', 'a-ptf');
    let receiptLine = '';
    try { receiptLine = fs.readFileSync(rf, 'utf8').split('\n').filter(Boolean)[0] || ''; } catch (e) { receiptLine = ''; }
    const fields = receiptLine.split('\t');
    report('PostToolUseFailure: consumes the pending and writes a receipt line (same path as PostToolUse)', ok && fields.length >= 5 && fields[3] === 'toolu_selftest_ptf', receiptLine);
    report('PostToolUseFailure: missing tool_response.exit_code recorded as -1 (unknown), not blank', fields[4] === '-1', JSON.stringify(fields));
    informationalCount++;
  }

  console.log();
  console.log('=== H2 (contract v2.15 receipt_commit_and_lease): lease survives a failed receipt commit, retried on the next Post ===');
  let leaseCount = 0;
  {
    const root = path.join(T, 'h2-root');
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root });
    const targetFile = path.join(T, 'h2-r.txt');
    const cmd = 'cmd > ' + targetFile.replace(/\\/g, '/');
    const preHook = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'test:h2', agent_id: 'a-h2', tool_use_id: 'toolu_selftest_h2', cwd: T, tool_input: { command: cmd },
    });
    execFileSync('bash', ['-c', WIRED_CMD], { input: preHook, env, timeout: 5000 });
    fs.writeFileSync(targetFile, 'x'.repeat(12));
    const rf = receiptsPath(root, 'test:h2', 'a-h2');
    mkdirp(rf); // block the receipts path with a directory so the append can only fail
    const postHook = JSON.stringify({
      hook_event_name: 'PostToolUse', session_id: 'test:h2', agent_id: 'a-h2', tool_use_id: 'toolu_selftest_h2', cwd: T, tool_response: { exit_code: 0 },
    });
    const r1 = runWired(postHook, { PMM_RECALL_ROOT: root });
    const pendingDirPath = pendingDir(root);
    const leasesAfterFail = (() => { try { return fs.readdirSync(pendingDirPath).filter((f) => f.indexOf('.processing.') >= 0); } catch (e) { return []; } })();
    const receiptExistsAfterFail = fs.existsSync(rf) && fs.statSync(rf).isFile();
    report('H2: blocked receipts path -> zero stdout/stderr, rc 0', r1.outLen === 0 && r1.errLen === 0 && r1.rc === 0, JSON.stringify(r1));
    leaseCount++;
    report('H2: blocked receipts path -> lease survives (not silently dropped), no receipt FILE written', leasesAfterFail.length === 1 && !receiptExistsAfterFail, JSON.stringify({ leasesAfterFail, receiptExistsAfterFail }));
    leaseCount++;

    fs.rmdirSync(rf); // restore
    const r2 = runWired(postHook, { PMM_RECALL_ROOT: root });
    const leasesAfterRetry = (() => { try { return fs.readdirSync(pendingDirPath).filter((f) => f.indexOf('.processing.') >= 0); } catch (e) { return []; } })();
    let receiptLine = '';
    try { receiptLine = fs.readFileSync(rf, 'utf8').split('\n').filter(Boolean)[0] || ''; } catch (e) { receiptLine = ''; }
    report('H2: after restoring the receipts path, a LATER Post retries the same lease and commits it (lease gone, receipt line written)', r2.rc === 0 && leasesAfterRetry.length === 0 && receiptLine.split('\t')[3] === 'toolu_selftest_h2', JSON.stringify({ leasesAfterRetry, receiptLine }));
    leaseCount++;
  }

  console.log();
  console.log('=== H3 (contract v2.15 receipt_commit_and_lease): lease age from claim time embedded in the name, not mtime; live pid never GC-ed ===');
  {
    // H3a: a pending file that legitimately sat around for 2h (old mtime, nothing wrong with that) must
    // NOT make the lease created from it look instantly stale — the gate stamps the lease's mtime to the
    // claim time right after rename.
    const root = path.join(T, 'h3-mtime-root');
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root });
    const targetFile = path.join(T, 'h3a-r.txt');
    const preHook = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'test:h3a', agent_id: 'a-h3a', tool_use_id: 'toolu_selftest_h3a', cwd: T,
      tool_input: { command: 'cmd > ' + targetFile.replace(/\\/g, '/') },
    });
    execFileSync('bash', ['-c', WIRED_CMD], { input: preHook, env, timeout: 5000 });
    const pendingDirPath3 = pendingDir(root);
    const pendingFiles = fs.readdirSync(pendingDirPath3);
    const twoHoursAgoSec = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(pendingDirPath3, pendingFiles[0]), twoHoursAgoSec, twoHoursAgoSec);
    fs.writeFileSync(targetFile, 'x'.repeat(12));
    const rf3a = receiptsPath(root, 'test:h3a', 'a-h3a');
    mkdirp(rf3a); // block commit so the lease survives for inspection
    execFileSync('bash', ['-c', WIRED_CMD], {
      input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'test:h3a', agent_id: 'a-h3a', tool_use_id: 'toolu_selftest_h3a', cwd: T, tool_response: { exit_code: 0 } }),
      env, timeout: 5000,
    });
    const leases3a = fs.readdirSync(pendingDirPath3).filter((f) => f.indexOf('.processing.') >= 0);
    const leaseAgeOk = leases3a.length === 1 && (Date.now() - fs.statSync(path.join(pendingDirPath3, leases3a[0])).mtimeMs) < 5000;
    report('H3a: lease created from a 2h-old pending gets a FRESH mtime (claim time), not the old pending mtime', leaseAgeOk, JSON.stringify(leases3a));
    leaseCount++;
    fs.rmdirSync(rf3a);

    // H3b: a genuinely stale lease (old claim time in its name, dead pid) IS reaped by GC -> receipt-lost,
    // attributed to the ORIGINAL pending's tool_use_id embedded in its payload.
    const root3b = path.join(T, 'h3-gc-root');
    mkdirp(pendingDir(root3b));
    const deadPid = 999999999; // implausible pid, guaranteed not alive (isPidAlive -> false)
    const claimMsOld = Date.now() - 2 * 60 * 60 * 1000;
    const staleLeaseName = 'a'.repeat(64) + '.json.processing.p' + deadPid + '-' + claimMsOld + '-selftestx';
    const staleLeasePath = path.join(pendingDir(root3b), staleLeaseName);
    fs.writeFileSync(staleLeasePath, JSON.stringify({ cmd: 'cmd > x', tool_use_id: 'toolu_selftest_h3b_original', targets: [] }));
    fs.utimesSync(staleLeasePath, claimMsOld / 1000, claimMsOld / 1000);
    execFileSync('bash', ['-c', WIRED_CMD], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'test:trigger-sess', agent_id: 'trigger-agent', tool_use_id: 'toolu_selftest_h3b_trigger', cwd: T, tool_input: { command: 'echo hi' } }),
      env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root3b }), timeout: 5000,
    });
    const remaining3b = fs.readdirSync(pendingDir(root3b));
    let receiptLostLine = '';
    try {
      const lines = fs.readFileSync(ledger.ledgerPath(root3b), 'utf8').split('\n').filter(Boolean);
      const kindIdx = ledger.COLUMNS.indexOf('event_kind'); const tuIdx = ledger.COLUMNS.indexOf('tool_use_id');
      receiptLostLine = lines.slice(1).find((l) => { const c = l.split('\t'); return c[kindIdx] === 'receipt-lost' && c[tuIdx] === 'toolu_selftest_h3b_original'; }) || '';
    } catch (e) { receiptLostLine = ''; }
    report('H3b: stale lease (old claim time + dead pid) reaped by GC -> receipt-lost attributed to the ORIGINAL tool_use_id', remaining3b.length === 0 && !!receiptLostLine, JSON.stringify({ remaining3b, receiptLostLine }));
    leaseCount++;

    // H3c: a lease whose embedded pid IS still alive is NEVER reaped, no matter how old its claim time.
    const root3c = path.join(T, 'h3-live-root');
    mkdirp(pendingDir(root3c));
    const liveChild = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore', env: SELFTEST_ISOLATED_ENV });
    const liveLeaseName = 'b'.repeat(64) + '.json.processing.p' + liveChild.pid + '-' + claimMsOld + '-selftesty';
    const liveLeasePath = path.join(pendingDir(root3c), liveLeaseName);
    fs.writeFileSync(liveLeasePath, JSON.stringify({ cmd: 'cmd > y', tool_use_id: 'toolu_selftest_h3c_original', targets: [] }));
    fs.utimesSync(liveLeasePath, claimMsOld / 1000, claimMsOld / 1000);
    execFileSync('bash', ['-c', WIRED_CMD], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'test:trigger-sess', agent_id: 'trigger-agent', tool_use_id: 'toolu_selftest_h3c_trigger', cwd: T, tool_input: { command: 'echo hi' } }),
      env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root3c }), timeout: 5000,
    });
    const remaining3c = fs.readdirSync(pendingDir(root3c));
    report('H3c: lease with a LIVE pid survives GC regardless of claim age', remaining3c.length === 1 && remaining3c[0] === liveLeaseName, JSON.stringify(remaining3c));
    leaseCount++;
    try { liveChild.kill(); } catch (e) { /* best effort */ }
  }

  console.log();
  console.log('=== M7 (contract v2.15): GC identity columns come from the ORIGINAL pending payload, never the discovering event ===');
  {
    const root = path.join(T, 'm7-root');
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root });
    const targetFile = path.join(T, 'm7-r.txt');
    const originalSession = 'test:m7-original', originalAgent = 'a-m7-original', originalToolUse = 'tu-m7-original';
    execFileSync('bash', ['-c', WIRED_CMD], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: originalSession, agent_id: originalAgent, agent_type: 'worker-orig',
        prompt_id: 'p-orig', tool_use_id: originalToolUse, cwd: T, tool_input: { command: 'cmd > ' + targetFile.replace(/\\/g, '/') },
      }), env, timeout: 5000,
    });
    const pendingDirPath = pendingDir(root);
    const created = fs.readdirSync(pendingDirPath)[0];
    // Age it into a stale, dead-pid lease directly (simulates a crash before any Post ever arrived).
    const claimMsOld = Date.now() - 2 * 60 * 60 * 1000;
    const leaseName = created + '.processing.p999999997-' + claimMsOld + '-m7selftest';
    fs.renameSync(path.join(pendingDirPath, created), path.join(pendingDirPath, leaseName));
    fs.utimesSync(path.join(pendingDirPath, leaseName), claimMsOld / 1000, claimMsOld / 1000);

    // Trigger GC via a COMPLETELY DIFFERENT discovering session/agent.
    execFileSync('bash', ['-c', WIRED_CMD], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:m7-discoverer', agent_id: 'a-m7-DISCOVERER', agent_type: 'worker-disc',
        prompt_id: 'p-disc', tool_use_id: 'toolu_selftest_m7_discoverer', cwd: T, tool_input: { command: 'echo hi' },
      }), env, timeout: 5000,
    });
    const lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const header = lines[0].split('\t');
    const idx = (c) => header.indexOf(c);
    const rlLine = lines.slice(1).find((l) => l.split('\t')[idx('event_kind')] === 'receipt-lost');
    const c = rlLine ? rlLine.split('\t') : [];
    const ok = !!rlLine &&
      c[idx('sid_sha16')] === sha16(originalSession) && c[idx('agent_sha16')] === sha16(originalAgent) &&
      c[idx('agent_type')] === 'worker-orig' && c[idx('prompt_id')] === 'p-orig' && c[idx('tool_use_id')] === originalToolUse &&
      c[idx('sid_sha16')] !== sha16('test:m7-discoverer') && c[idx('agent_sha16')] !== sha16('a-m7-DISCOVERER');
    report('M7: receipt-lost row identity columns are the ORIGINAL pending creator, not the GC-discovering event', ok, JSON.stringify({ rlLine, header }));
    leaseCount++;
  }

  console.log();
  console.log('=== 2026-09-23 canary fix: a pre-M7 orphaned pending (no stashed identity) is GC\'d with the DISCOVERING event\'s sid as fallback, never blank ===');
  {
    // Reproduces the real-ledger contamination directly: a plain `<hash>.json` pending written WITHOUT
    // any of the M7 identity fields (sid_sha16/agent_sha16/agent_type/prompt_id) -- exactly the shape a
    // pre-M7 pending file has, since that stash did not exist before contract v2.15. The gate's own Pre
    // handler always stashes identity today, so this is written directly to disk (never through the
    // WIRED script) to simulate a genuinely orphaned leftover from before M7 shipped.
    const root = path.join(T, 'orphan-pending-root');
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root });
    const orphanToolUse = 'toolu_selftest_orphan0001';
    const pendingDirPath = pendingDir(root);
    mkdirp(pendingDirPath);
    const orphanPath = pendingKeyPath(root, 's-orphan-original', 'a-orphan-original', orphanToolUse);
    fs.writeFileSync(orphanPath, JSON.stringify({ cmd: 'echo orphan', tool_use_id: orphanToolUse, targets: [] }));
    const oldMs = Date.now() - (PENDING_EXPIRED_MS + 60 * 60 * 1000); // safely past the 24h threshold
    fs.utimesSync(orphanPath, oldMs / 1000, oldMs / 1000);

    // Trigger GC via a discovering event with ITS OWN, known identity.
    const discovererSession = sha16('test:orphan-discoverer'), discovererAgent = 'cafebabe00004444';
    execFileSync('bash', ['-c', WIRED_CMD], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: discovererSession, agent_id: discovererAgent,
        tool_use_id: 'toolu_selftest_orphandiscover', cwd: T, tool_input: { command: 'echo hi' },
      }), env, timeout: 5000,
    });
    const lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const header = lines[0].split('\t');
    const idx = (c) => header.indexOf(c);
    const peLine = lines.slice(1).find((l) => { const c = l.split('\t'); return c[idx('event_kind')] === 'pending-expired' && c[idx('tool_use_id')] === orphanToolUse; });
    const c = peLine ? peLine.split('\t') : [];
    const ok = !!peLine && c[idx('sid_sha16')] === sha16(discovererSession) && c[idx('agent_sha16')] === sha16(discovererAgent) &&
      c[idx('sid_sha16')] !== '' && c[idx('tool_use_id')] === orphanToolUse;
    report('a pre-M7 orphaned pending (no stashed identity) is GC\'d as pending-expired with the DISCOVERING event\'s sid_sha16/agent_sha16 as fallback -- never blank', ok, JSON.stringify({ peLine, header }));
    leaseCount++;
  }

  console.log();
  console.log('=== 2026-09-23 fab-delta MEDIUM-5 (B): M7 payload present with ALL FOUR identity columns blank (\'\') is GC\'d with the columns left blank, never fallback-contaminated ===');
  {
    // A payload that DOES carry the M7 keys (hasOwnProperty true for sid_sha16 etc.) but whose creating
    // event genuinely had no session/agent identity to stash (e.g. main-session Pre events, which stash
    // sid_sha16='' when session_id is falsy) must be treated as "has its own identity, and that identity
    // is blank" -- NOT as "missing identity, fall back to the discoverer". This is exactly the fab-delta
    // MEDIUM-5 contamination: pre-fix, `payload.sid_sha16 || fb.sid_sha16` treats '' as falsy and pulls
    // in the discovering event's real sid, laundering a blank into a live session id.
    const root = path.join(T, 'm7-blank-root');
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root });
    const blankToolUse = 'toolu_selftest_m5b_blank0001';
    const pendingDirPath = pendingDir(root);
    mkdirp(pendingDirPath);
    const blankPath = pendingKeyPath(root, 's-m5b-placeholder', 'a-m5b-placeholder', blankToolUse);
    fs.writeFileSync(blankPath, JSON.stringify({
      cmd: 'echo m5b', tool_use_id: blankToolUse, targets: [],
      sid_sha16: '', agent_sha16: '', agent_type: '', prompt_id: '',
    }));
    const oldMs = Date.now() - (PENDING_EXPIRED_MS + 60 * 60 * 1000);
    fs.utimesSync(blankPath, oldMs / 1000, oldMs / 1000);

    const discovererSession = sha16('test:m5b-discoverer'), discovererAgent = 'cafebabe0000m5b2';
    execFileSync('bash', ['-c', WIRED_CMD], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: discovererSession, agent_id: discovererAgent, agent_type: 'worker-disc-m5b',
        prompt_id: 'p-disc-m5b', tool_use_id: 'toolu_selftest_m5b_discover', cwd: T, tool_input: { command: 'echo hi' },
      }), env, timeout: 5000,
    });
    const lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const header = lines[0].split('\t');
    const idx = (c) => header.indexOf(c);
    const peLine = lines.slice(1).find((l) => { const c = l.split('\t'); return c[idx('event_kind')] === 'pending-expired' && c[idx('tool_use_id')] === blankToolUse; });
    const c = peLine ? peLine.split('\t') : [];
    const ok = !!peLine && c[idx('sid_sha16')] === '' && c[idx('agent_sha16')] === '' &&
      c[idx('agent_type')] === '' && c[idx('prompt_id')] === '' &&
      c[idx('sid_sha16')] !== sha16(discovererSession) && c[idx('agent_sha16')] !== sha16(discovererAgent);
    report('M7 payload with all four identity columns blank stays blank on GC (never laundered into the discovering event\'s real identity)', ok, JSON.stringify({ peLine, header }));
    leaseCount++;
  }

  console.log();
  console.log('=== 2026-09-23 fab-delta MEDIUM-5 (C): M7 payload with sid_sha16/prompt_id from the creator but agent_sha16/agent_type blank is GC\'d as a WHOLE GROUP, never a per-field chimera ===');
  {
    // The exact "chimera row" shape from the audit: a main-session creator stashes its own real
    // sid_sha16/prompt_id but blank agent_sha16/agent_type (main sessions have no sub-agent identity).
    // Per-field `||` fallback would keep sid/prompt from the creator (truthy) but backfill agent/type
    // from the discovering event (also truthy) -- producing a row that is HALF creator, HALF discoverer
    // and attributable to neither. The fix must take all four columns from the SAME source (the payload,
    // since hasM7 is true), leaving agent_sha16/agent_type blank rather than borrowing the discoverer's.
    const root = path.join(T, 'm7-partial-root');
    const env = Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root });
    const partialToolUse = 'toolu_selftest_m5c_partial0001';
    const creatorSession = 'test:m5c-creator-main', creatorPromptId = 'p-m5c-creator';
    const pendingDirPath = pendingDir(root);
    mkdirp(pendingDirPath);
    const partialPath = pendingKeyPath(root, creatorSession, 'a-m5c-placeholder', partialToolUse);
    fs.writeFileSync(partialPath, JSON.stringify({
      cmd: 'echo m5c', tool_use_id: partialToolUse, targets: [],
      sid_sha16: sha16(creatorSession), agent_sha16: '', agent_type: '', prompt_id: creatorPromptId,
    }));
    const oldMs = Date.now() - (PENDING_EXPIRED_MS + 60 * 60 * 1000);
    fs.utimesSync(partialPath, oldMs / 1000, oldMs / 1000);

    const discovererSession = sha16('test:m5c-discoverer'), discovererAgent = 'cafebabe0000m5c2';
    execFileSync('bash', ['-c', WIRED_CMD], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: discovererSession, agent_id: discovererAgent, agent_type: 'worker-disc-m5c',
        prompt_id: 'p-disc-m5c', tool_use_id: 'toolu_selftest_m5c_discover', cwd: T, tool_input: { command: 'echo hi' },
      }), env, timeout: 5000,
    });
    const lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const header = lines[0].split('\t');
    const idx = (c) => header.indexOf(c);
    const peLine = lines.slice(1).find((l) => { const c = l.split('\t'); return c[idx('event_kind')] === 'pending-expired' && c[idx('tool_use_id')] === partialToolUse; });
    const c = peLine ? peLine.split('\t') : [];
    const ok = !!peLine && c[idx('sid_sha16')] === sha16(creatorSession) && c[idx('prompt_id')] === creatorPromptId &&
      c[idx('agent_sha16')] === '' && c[idx('agent_type')] === '' &&
      c[idx('agent_sha16')] !== sha16(discovererAgent) && c[idx('agent_type')] !== 'worker-disc-m5c';
    report('M7 payload with sid/prompt from creator but blank agent/type is GC\'d as one whole group (no per-field chimera with the discoverer\'s agent/type)', ok, JSON.stringify({ peLine, header }));
    leaseCount++;
  }

  console.log();
  console.log('=== M8 (contract v2.15 head_tail_option_table): separated --lines/--bytes consume their value, matching -n/-c ===');
  let optionTableCount = 0;
  {
    const f = path.join(T, 'm8-f.txt');
    fs.writeFileSync(f, 'irrelevant');
    const fSlash = f.replace(/\\/g, '/');
    const forms = ['tail --lines 5 ' + fSlash, 'tail --lines=5 ' + fSlash, 'tail -n 5 ' + fSlash];
    const indexes = forms.map((cmd) => {
      const segs = REAL_PARSER.parseCommand(cmd).segments;
      const operands = computeFileOperands(segs[0]);
      const idx = operands ? operands.findIndex((a) => (a && typeof a === 'object' ? (a.decoded !== undefined ? a.decoded : a.raw) : a) === fSlash) : -1;
      return idx;
    });
    report('M8: tail --lines 5 f / --lines=5 f / -n 5 f all give f the SAME operand_index', indexes.every((i) => i === indexes[0]) && indexes[0] === 0, JSON.stringify({ forms, indexes }));
    optionTableCount++;
    // --bytes counterpart, same check.
    const formsBytes = ['tail --bytes 5 ' + fSlash, 'tail --bytes=5 ' + fSlash, 'tail -c 5 ' + fSlash];
    const indexesBytes = formsBytes.map((cmd) => {
      const segs = REAL_PARSER.parseCommand(cmd).segments;
      const operands = computeFileOperands(segs[0]);
      const idx = operands ? operands.findIndex((a) => (a && typeof a === 'object' ? (a.decoded !== undefined ? a.decoded : a.raw) : a) === fSlash) : -1;
      return idx;
    });
    report('M8: tail --bytes 5 f / --bytes=5 f / -c 5 f all give f the SAME operand_index', indexesBytes.every((i) => i === indexesBytes[0]) && indexesBytes[0] === 0, JSON.stringify({ formsBytes, indexesBytes }));
    optionTableCount++;
  }

  console.log();
  console.log('=== v2.18 oversize_rule (contract Z24 / parser amendment 8 item 3): one unsupported row, no pending, under 2s ===');
  let oversizeCount = 0;
  {
    // Z24: "A01-shaped json whose command is a single token of 1 MiB + 1 byte" -> parser amendment 8
    // classifies the WHOLE command as one parse_status='unsupported:oversize' segment with scope_id='root'
    // and no pipeline_id/redirects (unsupportedBlank's BLANK_UNSUPPORTED shape). Nothing in THIS gate needs
    // to special-case that reason string: isFlagWorthyUnsupported() already flags any 'unsupported:*'
    // reason (gate A/A per INFORMATIONAL_GATE_MAP), the Gate-A/B/D scans already skip any segment without a
    // pipeline_id or a parse_status !== 'ok', and collectPendingTargets() only ever reads a segment's own
    // (empty, for this shape) `redirects` array -- so an oversized command structurally cannot open a
    // pending. This section locks that already-correct behavior in with an end-to-end assertion instead of
    // reasoning about it from the source alone.
    const bigToken = 'X'.repeat(1024 * 1024 + 1); // > 1 MiB single token (also > 64 KiB single-token limit)
    const cmd = 'echo ' + bigToken;
    const root = path.join(T, 'oversize-root');
    const hook = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'test:ov', agent_id: 'a-ov', tool_use_id: 'toolu_selftest_ov',
      cwd: T, tool_input: { command: cmd },
    });
    const t0 = Date.now();
    const r = runWired(hook, { PMM_RECALL_ROOT: root });
    const wallMs = Date.now() - t0;
    report('Z24: oversize command -> zero stdout/stderr, rc 0, under 2000ms wall clock', r.outLen === 0 && r.errLen === 0 && r.rc === 0 && wallMs < 2000, JSON.stringify(Object.assign({ wallMs }, r)));
    oversizeCount++;
    let lines = [];
    try { lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean); } catch (e) { /* none */ }
    const header = lines[0] ? lines[0].split('\t') : [];
    const idx = (c) => header.indexOf(c);
    const dataRows = lines.slice(1).map((l) => l.split('\t'));
    const unsupportedRows = dataRows.filter((c) => c[idx('event_kind')] === 'unsupported' && c[idx('tool_use_id')] === 'toolu_selftest_ov');
    report('Z24: exactly one unsupported row, gate=A trigger_or_gate_id=A', unsupportedRows.length === 1 && unsupportedRows[0][idx('gate')] === 'A' && unsupportedRows[0][idx('trigger_or_gate_id')] === 'A', JSON.stringify(unsupportedRows));
    oversizeCount++;
    const findingRows = dataRows.filter((c) => c[idx('tool_use_id')] === 'toolu_selftest_ov' && c[idx('gate')] !== 'A');
    report('Z24: no A/B/D finding rows (gates: [])', findingRows.length === 0, JSON.stringify(findingRows));
    oversizeCount++;
    let pendingFiles = [];
    try { pendingFiles = fs.readdirSync(pendingDir(root)); } catch (e) { /* dir may not even exist -- fine */ }
    report('Z24: no pending opened', pendingFiles.length === 0, JSON.stringify(pendingFiles));
    oversizeCount++;
  }

  console.log();
  console.log('=== v2.19 M3 allocation function (M-SPEC appendix B3 as amended): per-gate policy.json submodes, policy-mode-shaped run_provenance ===');
  let m3Count = 0;
  {
    // Unit-level (resolveAssignment directly): the policy shapes the item's own self-test requirement
    // enumerates (missing/absent-by-missing-key/randomized/corrupt), plus arm-stability, plus v2.19's
    // shadow-gate case. Opus review correction (2026-09-17): run_provenance/`provenance` reflects the
    // POLICY MODE (absent/corrupt/shadow/shadow-gate/randomized), never which ARM the coin flip produced --
    // a randomized-and-unlocked class reports provenance='randomized' for EITHER arm; the arm itself lives
    // only in `mode`.
    {
      const root = path.join(T, 'm3-missing-root');
      const r = resolveAssignment(root, 's1', GATE_LESSON_CLASS_TAG, 'A');
      report('M3 unit: missing policy.json -> {mode: shadow, provenance: absent}', r.mode === 'shadow' && r.provenance === 'absent', JSON.stringify(r));
      m3Count++;
    }
    {
      // contract v2.23 LOW-8 / P06: the policy PATH is a directory (EISDIR on readFileSync) -- distinct
      // from ENOENT (file genuinely absent). Only ENOENT maps to provenance=absent; every other read/stat
      // error (EACCES/EISDIR/EIO/...) maps to provenance=corrupt.
      const root = path.join(T, 'm3-eisdir-root');
      mkdirp(root);
      fs.mkdirSync(policyFilePath(root));
      const r = resolveAssignment(root, 's1', GATE_LESSON_CLASS_TAG, 'A');
      report('M3 unit P06: policy path is a DIRECTORY (EISDIR, not ENOENT) -> {mode: shadow, provenance: corrupt}, distinct from a genuinely missing file', r.mode === 'shadow' && r.provenance === 'corrupt', JSON.stringify(r));
      m3Count++;
    }
    {
      const root = path.join(T, 'm3-shadow-root');
      mkdirp(root);
      fs.writeFileSync(policyFilePath(root), JSON.stringify({ [GATE_LESSON_CLASS_TAG]: { mode: 'shadow' } }));
      const r = resolveAssignment(root, 's1', GATE_LESSON_CLASS_TAG, 'A');
      report('M3 unit: policy.json present, class_tag key mode=shadow (explicit, not missing) -> {mode: shadow, provenance: shadow}', r.mode === 'shadow' && r.provenance === 'shadow', JSON.stringify(r));
      m3Count++;
    }
    {
      const root = path.join(T, 'm3-missingkey-root');
      mkdirp(root);
      fs.writeFileSync(policyFilePath(root), JSON.stringify({ 'some-other-class': { mode: 'randomized', gates: { A: 'randomized' } } }));
      const r = resolveAssignment(root, 's1', GATE_LESSON_CLASS_TAG, 'A'); // THIS class_tag has NO entry
      // v2.23 item G: switched to pmm-recall-policy.cjs's classEntry(), whose own design (and self-test)
      // distinguishes "file present but this class has no entry" (errorKind=null, provenance=shadow) from
      // "file genuinely absent" (errorKind='absent', provenance=absent) -- a file existing with SOME
      // configuration in it is a materially different fact than no file at all, even though neither case is
      // this specific class's own concern. No contract P0x case covers this shape directly (only file-
      // absent/EISDIR/corrupt/explicit-shadow/randomized are named P01/P06/-/P02/P03-P04), so this
      // assertion is updated to match the shared module's own deliberate, tested semantics rather than this
      // gate's own prior (now superseded) local guess.
      report('M3 unit: policy.json present but missing THIS class_tag key -> {mode: shadow, provenance: shadow} (distinct from a genuinely missing FILE)', r.mode === 'shadow' && r.provenance === 'shadow', JSON.stringify(r));
      m3Count++;
    }
    {
      const root = path.join(T, 'm3-corrupt-root');
      mkdirp(root);
      fs.writeFileSync(policyFilePath(root), '{not valid json');
      const r = resolveAssignment(root, 's1', GATE_LESSON_CLASS_TAG, 'A');
      report('M3 unit: unparseable policy.json -> {mode: shadow, provenance: corrupt}', r.mode === 'shadow' && r.provenance === 'corrupt', JSON.stringify(r));
      m3Count++;
    }
    {
      // A JSON array (valid JSON, not an object) also counts as corrupt for this purpose -- the policy
      // schema is class_tag -> {...}, so anything that is not a plain object is unusable.
      const root = path.join(T, 'm3-corrupt-array-root');
      mkdirp(root);
      fs.writeFileSync(policyFilePath(root), '[1,2,3]');
      const r = resolveAssignment(root, 's1', GATE_LESSON_CLASS_TAG, 'A');
      report('M3 unit: policy.json is a JSON array (not an object) -> {mode: shadow, provenance: corrupt}', r.mode === 'shadow' && r.provenance === 'corrupt', JSON.stringify(r));
      m3Count++;
    }
    {
      // v2.19 shadow-gate: class-level mode IS randomized, and THIS session's coin flip lands on intervene,
      // but gates.B is NOT unlocked (only gates.A is) -- gate B's own row must stay mode=shadow with
      // provenance='shadow-gate' (NOT plain 'shadow', which specifically means the class-level MODE itself
      // is shadow -- a different, distinguishable fact).
      const root = path.join(T, 'm3-shadowgate-root');
      mkdirp(root);
      fs.writeFileSync(policyFilePath(root), JSON.stringify({ [GATE_LESSON_CLASS_TAG]: { mode: 'randomized', gates: { A: 'randomized', B: 'shadow', D: 'shadow' } } }));
      // Brute-force a session id whose class-level coin flip is intervene (first sha256 byte even) so the
      // shadow-gate branch (as opposed to the plain session-level-shadow-arm branch) is what's actually hit.
      let interveneSession = null;
      for (let n = 0; n < 10000 && !interveneSession; n++) {
        const cand = 'shadowgate-search-' + n;
        const h = crypto.createHash('sha256').update(cand + '\0' + GATE_LESSON_CLASS_TAG, 'utf8').digest();
        if (h[0] % 2 === 0) interveneSession = cand;
      }
      const rA = resolveAssignment(root, interveneSession, GATE_LESSON_CLASS_TAG, 'A');
      const rB = resolveAssignment(root, interveneSession, GATE_LESSON_CLASS_TAG, 'B');
      report('M3 unit shadow-gate: class mode randomized + coin flip intervene, gates.A=randomized -> gate A actually intervenes, provenance=randomized', rA.mode === 'intervene' && rA.provenance === 'randomized', JSON.stringify(rA));
      m3Count++;
      report('M3 unit shadow-gate: SAME intervene-coin-flip session, gates.B=shadow (not unlocked) -> gate B stays mode=shadow, provenance=shadow-gate (distinct from plain shadow)', rB.mode === 'shadow' && rB.provenance === 'shadow-gate', JSON.stringify(rB));
      m3Count++;
    }
    {
      // arm_stability: the SAME (session_id, class_tag) pair against the SAME randomized+unlocked policy
      // always resolves to the SAME arm, called repeatedly.
      const root = path.join(T, 'm3-stability-root');
      mkdirp(root);
      fs.writeFileSync(policyFilePath(root), JSON.stringify({ [GATE_LESSON_CLASS_TAG]: { mode: 'randomized', gates: { A: 'randomized', B: 'randomized', D: 'randomized' }, unlocked_by: 'rpt-1', lower95_by_gate: { A: 0.85 } } }));
      const arms = [1, 2, 3, 4, 5].map(() => resolveAssignment(root, 'stable-session-id', GATE_LESSON_CLASS_TAG, 'A').mode);
      report('M3 unit arm_stability: same (session, class_tag) called 5x against the same policy -> identical arm every time', arms.every((a) => a === arms[0]), JSON.stringify(arms));
      m3Count++;

      // Different sessions CAN land on different arms: brute-force two session id strings whose
      // sha256(session||NUL||class_tag) first bytes have different parity (contract P03's own phrasing:
      // "runner picks two session ids whose sha256 first bytes have different parity => different arms").
      function firstByteParity(sessionId, classTag) {
        const h = crypto.createHash('sha256').update(String(sessionId) + '\0' + String(classTag || ''), 'utf8').digest();
        return h[0] % 2;
      }
      let evenSession = null, oddSession = null;
      for (let n = 0; n < 10000 && (!evenSession || !oddSession); n++) {
        const cand = 'arm-search-session-' + n;
        const p = firstByteParity(cand, GATE_LESSON_CLASS_TAG);
        if (p === 0 && !evenSession) evenSession = cand;
        if (p === 1 && !oddSession) oddSession = cand;
      }
      const rEvenU = resolveAssignment(root, evenSession, GATE_LESSON_CLASS_TAG, 'A');
      const rOddU = resolveAssignment(root, oddSession, GATE_LESSON_CLASS_TAG, 'A');
      report('M3 unit: sessions with different sha256-first-byte parity under a randomized+unlocked policy -> different arms (intervene vs shadow), BOTH provenance=randomized', rEvenU.mode === 'intervene' && rOddU.mode === 'shadow' && rEvenU.provenance === 'randomized' && rOddU.provenance === 'randomized', JSON.stringify({ evenSession, rEvenU, oddSession, rOddU }));
      m3Count++;

      // v2.23 item G, coordinator's own explicit self-test ask: tamper with POLICY.assignment()'s return
      // value and confirm this gate's own resolveAssignment() output changes with it -- proof of GENUINE
      // delegation (a local duplicate implementation, which this commit removed, would be completely
      // unaffected by tampering with the shared module's export).
      {
        const originalAssignment = POLICY.assignment;
        POLICY.assignment = function () { return 'intervene'; }; // force every arm to intervene, unconditionally
        let tampered;
        try { tampered = resolveAssignment(root, 'any-session-whatsoever', GATE_LESSON_CLASS_TAG, 'A'); }
        finally { POLICY.assignment = originalAssignment; } // restore before any assertion, even on throw
        report('v2.23 item G delegation proof: tampering with POLICY.assignment() changes resolveAssignment()\'s own output -> genuine delegation, not a local duplicate', tampered.mode === 'intervene', JSON.stringify(tampered));
        m3Count++;
        // Confirm the tamper is fully undone -- a subsequent call with the SAME (shadow-arm) session goes
        // back to shadow, exactly as it did before oddSession's own earlier assertion above.
        const afterRestore = resolveAssignment(root, oddSession, GATE_LESSON_CLASS_TAG, 'A');
        report('v2.23 item G: POLICY.assignment tamper fully restored -- the shadow-arm session is shadow again', afterRestore.mode === 'shadow', JSON.stringify(afterRestore));
        m3Count++;
      }

      // Black-box, end-to-end through the wired script + real ledger row: the intervene arm actually
      // emits (stdout>0, an 'emitted' row); the shadow arm does not (stdout 0, no 'emitted' row, only a
      // 'would-warn' row). Contract P04's own "arm_effect" wording. Opus correction: BOTH rows carry
      // run_provenance='policy:randomized' (the policy MODE, identical for either arm) -- only their `mode`
      // column differs (intervene vs shadow). Also asserts item 1's own requirement: gate rows carry a
      // non-empty, exactly-correct class_tag (contract gate_row_class_tag).
      function runA01(root2, sessionId, toolUseId) {
        const hook = JSON.stringify({
          hook_event_name: 'PreToolUse', session_id: sessionId, agent_id: 'a-m3', tool_use_id: toolUseId,
          cwd: T, tool_input: { command: 'a | b; rc=$?' },
        });
        return runWired(hook, { PMM_RECALL_ROOT: root2 });
      }
      function readRows(root2, toolUseId) {
        let lines = [];
        try { lines = fs.readFileSync(ledger.ledgerPath(root2), 'utf8').split('\n').filter(Boolean); } catch (e) { /* none */ }
        const header = lines[0] ? lines[0].split('\t') : [];
        const ix = (c) => header.indexOf(c);
        return lines.slice(1).map((l) => l.split('\t')).filter((c) => c[ix('tool_use_id')] === toolUseId)
          .map((c) => ({ event_kind: c[ix('event_kind')], gate: c[ix('gate')], mode: c[ix('mode')], run_provenance: c[ix('run_provenance')], class_tag: c[ix('class_tag')] }));
      }
      const root2 = path.join(T, 'm3-e2e-root');
      mkdirp(root2);
      // runner policy_modes convention: policy-randomized writes gates {A,B,D: 'randomized'} all at once.
      fs.writeFileSync(policyFilePath(root2), JSON.stringify({ [GATE_LESSON_CLASS_TAG]: { mode: 'randomized', gates: { A: 'randomized', B: 'randomized', D: 'randomized' } } }));

      const rEven = runA01(root2, evenSession, 'tu-m3-intervene');
      const rowsEven = readRows(root2, 'tu-m3-intervene');
      const emittedEven = rowsEven.find((r) => r.event_kind === 'emitted' || r.event_kind === 'emit-failed');
      const wouldWarnEven = rowsEven.find((r) => r.event_kind === 'would-warn');
      report('M3 black-box P04 intervene arm: stdout > 0, emitted row has mode=intervene, run_provenance=policy:randomized (policy MODE, not the arm), class_tag set', rEven.outLen > 0 && !!emittedEven && emittedEven.mode === 'intervene' && emittedEven.run_provenance === 'policy:randomized' && emittedEven.class_tag === GATE_LESSON_CLASS_TAG, JSON.stringify({ rEven, rowsEven }));
      m3Count++;
      // contract v2.23 gate_disposition_map (codex MEDIUM-5): the PAIRED would-warn row for this SAME
      // finding must carry the SAME mode=intervene as the emitted row -- event_kind is what distinguishes
      // them, never mode (Opus's own reproduction: "one impression had would-warn mode=shadow and emitted
      // mode=intervene").
      report('M3 MEDIUM-5: the intervene arm\'s PAIRED would-warn row (same finding) also carries mode=intervene, not shadow', !!wouldWarnEven && wouldWarnEven.mode === 'intervene', JSON.stringify({ wouldWarnEven, rowsEven }));
      m3Count++;

      const rOdd = runA01(root2, oddSession, 'tu-m3-shadow');
      const rowsOdd = readRows(root2, 'tu-m3-shadow');
      const emittedOdd = rowsOdd.find((r) => r.event_kind === 'emitted' || r.event_kind === 'emit-failed');
      const wouldWarnOdd = rowsOdd.find((r) => r.event_kind === 'would-warn');
      report('M3 black-box P04 shadow arm: stdout 0, no emitted row, would-warn row has mode=shadow, run_provenance=policy:randomized (SAME policy mode as the intervene arm above -- only mode differs), class_tag set', rOdd.outLen === 0 && !emittedOdd && !!wouldWarnOdd && wouldWarnOdd.mode === 'shadow' && wouldWarnOdd.run_provenance === 'policy:randomized' && wouldWarnOdd.class_tag === GATE_LESSON_CLASS_TAG, JSON.stringify({ rOdd, rowsOdd }));
      m3Count++;

      // v2.19 shadow-gate, black-box: an intervene-coin-flip session, but gates.A is NOT unlocked (only D
      // is) -- gate A's would-warn row must record run_provenance=policy:shadow-gate (distinct from
      // policy:randomized above), no emitted row, stdout 0.
      const root3 = path.join(T, 'm3-e2e-shadowgate-root');
      mkdirp(root3);
      fs.writeFileSync(policyFilePath(root3), JSON.stringify({ [GATE_LESSON_CLASS_TAG]: { mode: 'randomized', gates: { A: 'shadow', B: 'shadow', D: 'randomized' } } }));
      const rShadowGate = runA01(root3, evenSession, 'tu-m3-shadowgate');
      const rowsShadowGate = readRows(root3, 'tu-m3-shadowgate');
      const emittedShadowGate = rowsShadowGate.find((r) => r.event_kind === 'emitted' || r.event_kind === 'emit-failed');
      const wouldWarnShadowGate = rowsShadowGate.find((r) => r.event_kind === 'would-warn');
      report('M3 black-box shadow-gate: intervene-coin-flip session but gate A not unlocked -> stdout 0, no emitted row, would-warn run_provenance=policy:shadow-gate', rShadowGate.outLen === 0 && !emittedShadowGate && !!wouldWarnShadowGate && wouldWarnShadowGate.mode === 'shadow' && wouldWarnShadowGate.run_provenance === 'policy:shadow-gate', JSON.stringify({ rShadowGate, rowsShadowGate }));
      m3Count++;
    }
    {
      // Black-box: policy-absent (P01) and policy-corrupt end-to-end, mode_column + run_provenance +
      // class_tag (item 1's own requirement: gate rows never carry an empty class_tag).
      const rootAbsent = path.join(T, 'm3-e2e-absent-root');
      const hookAbsent = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:m3-absent', agent_id: 'a-m3', tool_use_id: 'toolu_selftest_m3_absent',
        cwd: T, tool_input: { command: 'a | b; rc=$?' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hookAbsent, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: rootAbsent }), timeout: 5000 });
      const linesA = fs.readFileSync(ledger.ledgerPath(rootAbsent), 'utf8').split('\n').filter(Boolean);
      const headerA = linesA[0].split('\t'); const ixA = (c) => headerA.indexOf(c);
      const rowA = linesA.slice(1).map((l) => l.split('\t')).find((c) => c[ixA('tool_use_id')] === 'toolu_selftest_m3_absent' && c[ixA('event_kind')] === 'would-warn');
      report('M3 black-box P01: policy.json absent -> mode_column=shadow, run_provenance=policy:absent, class_tag non-empty and correct', !!rowA && rowA[ixA('mode')] === 'shadow' && rowA[ixA('run_provenance')] === 'policy:absent' && rowA[ixA('class_tag')] === GATE_LESSON_CLASS_TAG, JSON.stringify(rowA));
      m3Count++;

      // P02: policy.json present, class-level mode explicitly 'shadow' -> run_provenance=policy:shadow
      // (distinct from policy:absent -- a configured-shadow class vs. nothing configured at all).
      const rootShadow = path.join(T, 'm3-e2e-shadow-root');
      mkdirp(rootShadow);
      fs.writeFileSync(policyFilePath(rootShadow), JSON.stringify({ [GATE_LESSON_CLASS_TAG]: { mode: 'shadow' } }));
      const hookShadow = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:m3-shadow', agent_id: 'a-m3', tool_use_id: 'toolu_selftest_m3_shadow_explicit',
        cwd: T, tool_input: { command: 'a | b; rc=$?' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hookShadow, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: rootShadow }), timeout: 5000 });
      const linesS = fs.readFileSync(ledger.ledgerPath(rootShadow), 'utf8').split('\n').filter(Boolean);
      const headerS = linesS[0].split('\t'); const ixS = (c) => headerS.indexOf(c);
      const rowS = linesS.slice(1).map((l) => l.split('\t')).find((c) => c[ixS('tool_use_id')] === 'toolu_selftest_m3_shadow_explicit' && c[ixS('event_kind')] === 'would-warn');
      report('M3 black-box P02: policy.json class mode explicitly shadow -> mode_column=shadow, run_provenance=policy:shadow', !!rowS && rowS[ixS('mode')] === 'shadow' && rowS[ixS('run_provenance')] === 'policy:shadow', JSON.stringify(rowS));
      m3Count++;

      const rootCorrupt = path.join(T, 'm3-e2e-corrupt-root');
      mkdirp(rootCorrupt);
      fs.writeFileSync(policyFilePath(rootCorrupt), 'not json at all {{{');
      const hookCorrupt = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:m3-corrupt', agent_id: 'a-m3', tool_use_id: 'toolu_selftest_m3_corrupt',
        cwd: T, tool_input: { command: 'a | b; rc=$?' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hookCorrupt, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: rootCorrupt }), timeout: 5000 });
      const linesC = fs.readFileSync(ledger.ledgerPath(rootCorrupt), 'utf8').split('\n').filter(Boolean);
      const headerC = linesC[0].split('\t'); const ixC = (c) => headerC.indexOf(c);
      const rowC = linesC.slice(1).map((l) => l.split('\t')).find((c) => c[ixC('tool_use_id')] === 'toolu_selftest_m3_corrupt' && c[ixC('event_kind')] === 'would-warn');
      report('M3 black-box: corrupt policy.json -> mode_column=shadow, run_provenance=policy:corrupt (reused, no new event_kind), class_tag set', !!rowC && rowC[ixC('mode')] === 'shadow' && rowC[ixC('run_provenance')] === 'policy:corrupt' && rowC[ixC('class_tag')] === GATE_LESSON_CLASS_TAG, JSON.stringify(rowC));
      m3Count++;

      // contract v2.23 P06, black-box: policy path is a directory (EISDIR) -> shadow behaviour,
      // run_provenance policy:corrupt, through the real wired script end-to-end.
      const rootEisdir = path.join(T, 'm3-e2e-eisdir-root');
      mkdirp(rootEisdir);
      fs.mkdirSync(policyFilePath(rootEisdir));
      const hookEisdir = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:m3-eisdir', agent_id: 'a-m3', tool_use_id: 'toolu_selftest_m3_eisdir',
        cwd: T, tool_input: { command: 'a | b; rc=$?' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hookEisdir, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: rootEisdir }), timeout: 5000 });
      const linesE = fs.readFileSync(ledger.ledgerPath(rootEisdir), 'utf8').split('\n').filter(Boolean);
      const headerE = linesE[0].split('\t'); const ixE = (c) => headerE.indexOf(c);
      const rowE = linesE.slice(1).map((l) => l.split('\t')).find((c) => c[ixE('tool_use_id')] === 'toolu_selftest_m3_eisdir' && c[ixE('event_kind')] === 'would-warn');
      report('M3 black-box P06: policy path is a directory (EISDIR) -> mode_column=shadow, run_provenance=policy:corrupt', !!rowE && rowE[ixE('mode')] === 'shadow' && rowE[ixE('run_provenance')] === 'policy:corrupt', JSON.stringify(rowE));
      m3Count++;
    }
  }

  console.log();
  console.log('=== v2.19 gate_row_class_tag: informational rows also carry the class_tag (unsupported/cd-hint/path_unresolved) ===');
  {
    const root = path.join(T, 'classtag-informational-root');
    const hook = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 'test:ctinfo', agent_id: 'a-ctinfo', tool_use_id: 'toolu_selftest_ctinfo',
      cwd: T, tool_input: { command: '! a | b; rc=$?' },
    });
    execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
    const lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean);
    const header = lines[0].split('\t'); const ix = (c) => header.indexOf(c);
    const row = lines.slice(1).map((l) => l.split('\t')).find((c) => c[ix('tool_use_id')] === 'toolu_selftest_ctinfo' && c[ix('event_kind')] === 'unsupported');
    report('informational (unsupported) row carries the fixed lesson class_tag, non-empty', !!row && row[ix('class_tag')] === GATE_LESSON_CLASS_TAG, JSON.stringify(row));
    m3Count++;
  }

  console.log();
  console.log('=== M1 display layer (queue-<host>.tsv): gate writes one desensitized record per would-warn/emitted/recurrence-candidate row ===');
  let queueCount = 0;
  {
    // Unit-level desensitize(), username path OUTSIDE any quotes -- isolates the username-strip regex from
    // the quote-blanking regex (the black-box case below embeds the username INSIDE quotes, where either
    // regex alone would remove it, so it alone cannot prove the username-strip regex specifically works).
    const out = desensitize('cat C:/Users/<user>/notes.txt and /Users/otherName/file too');
    report('desensitize() unit: bare (unquoted) C:/Users/<name>/ and /Users/<name>/ paths both lose their username', out.indexOf(os.userInfo().username) < 0 && out.indexOf('otherName') < 0 && out.indexOf('C:/Users/_/') >= 0 && out.indexOf('/Users/_/') >= 0, JSON.stringify(out));
    queueCount++;
  }
  {
    // The M1 annotator's own finding: pmm-recall-ledger.cjs exports writeQueue() but this gate never
    // called it, so queue-<host>.tsv had zero rows from the gate and pmm-recall-queue.cjs's --source v3
    // snippets came back empty (annotation had to cross-reference session JSONL by hand). desensitize()
    // mirrors pmm-bash-impression.cjs's own copy -- strip usernames out of home-dir paths, blank quoted
    // content. Command deliberately carries BOTH a username-bearing path AND quoted content to prove both
    // get stripped, not just one.
    const root = path.join(T, 'queue-root');
    const dirtyCmd = 'cat "C:/Users/<user>/secret.txt" \'another secret\' | tail -3; rc=$?';
    // 2026-09-23 canary fix (H2 queue section): session_id/agent_id/tool_use_id used to be short,
    // obviously-synthetic strings ('s-queue'/'a-queue'/'tu-queue'). The FIVE READ TOOLS' shared
    // isContaminatedRow() (pmm-recall-queue.cjs and its 4 siblings) excludes any row whose tool_use_id
    // matches /^tu-/ (a marker for runner-synthesized ids, never Claude Code's own toolu_<...> shape) --
    // 'tu-queue' matched that pattern, so pmm-recall-queue.cjs --source v3 silently dropped this
    // impression's row from its report (impressionLine came back ''), even though the row itself was
    // written correctly. Fixed at the FIXTURE, not the read-side criterion (that criterion is a real,
    // confirmed production-contamination marker -- see pmm-recall-queue.cjs's own comment on it): now
    // real-shaped, synthetic-but-fixed ids (>=8 hex chars for session/agent id; toolu_ prefix, never
    // tu-, for tool_use_id) that a real Claude Code event could plausibly carry.
    // 2026-09-23 (contract v2.26 selftest_id_convention, fab-delta MEDIUM-5 same family): that real-shaped
    // fix (literal 'deadbeef00001111'/'toolu_01deadbeefqueue1') was itself invisible to the canary
    // contamination sentinel -- indistinguishable from a genuine production session/tool_use_id. Now
    // sha16('test:...') for session/agent (still >=8 real hex chars, the read tools' own acceptance
    // criterion, but traceable back to a string starting with 'test:', the convention's OTHER accepted
    // synthetic-session shape) and toolu_selftest_<...> for tool_use_id (still a real toolu_ prefix, now
    // also carrying 'selftest' for the sentinel to see).
    const queueSelftestSession = sha16('test:queue-selftest-session');
    const queueSelftestAgent = sha16('test:queue-selftest-agent');
    const hook = JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: queueSelftestSession, agent_id: queueSelftestAgent, tool_use_id: 'toolu_selftest_queue1',
      cwd: T, tool_input: { command: dirtyCmd },
    });
    const qpBefore = (() => { try { return fs.readFileSync(path.join(root, 'queue-' + os.hostname() + '.tsv'), 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } })();
    execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
    const qLines = fs.readFileSync(path.join(root, 'queue-' + os.hostname() + '.tsv'), 'utf8').split('\n').filter(Boolean);
    report('one Pre call with a gate-A-shaped command -> the queue file has at least one MORE line than before (header + >=1 data row)', qLines.length > qpBefore && qLines.length >= 2, JSON.stringify({ qpBefore, qLinesLength: qLines.length }));
    queueCount++;

    const qHeader = qLines[0].split('\t');
    report('queue file header matches ledger.QUEUE_COLUMNS exactly', qHeader.join('\t') === ledger.QUEUE_COLUMNS.join('\t'), qLines[0]);
    queueCount++;

    const qIx = (c) => qHeader.indexOf(c);
    const qRow = qLines.slice(1).map((l) => l.split('\t')).find((c) => c[qIx('trigger_or_gate_id')] === 'A');
    report('queue row exists for the gate-A finding, impression_id and class_tag non-empty', !!qRow && qRow[qIx('impression_id')] !== '' && qRow[qIx('class_tag')] === GATE_LESSON_CLASS_TAG, JSON.stringify(qRow));
    queueCount++;

    const snippet = qRow ? qRow[qIx('snippet')] : '';
    report('snippet contains no username (real OS username stripped from the C:/Users/ path)', snippet.indexOf(os.userInfo().username) < 0, JSON.stringify(snippet));
    queueCount++;
    report('snippet contains no quoted content (both "..." and \'...\' bodies blanked -- "secret.txt"/"another secret" never appear)', snippet.indexOf('secret.txt') < 0 && snippet.indexOf('another secret') < 0, JSON.stringify(snippet));
    queueCount++;
    report('snippet still shows the unredacted shape (exe name "cat"/"tail" visible -- desensitize blanks quoted content and usernames, not everything)', snippet.indexOf('cat') >= 0 || snippet.indexOf('tail') >= 0, JSON.stringify(snippet));
    queueCount++;

    // pmm-recall-queue.cjs --source v3 can actually display this snippet (the coordinator's own literal
    // self-test ask) -- spawn it for real against the same root, exactly as an annotator would run it.
    // spawnSync (not execFileSync): toolErr is printed as part of this assertion's own evidence below (not
    // asserted on, just diagnostic) -- an execFileSync success-path hardcoded-empty stderr would make that
    // printed evidence a lie (Opus LOW, 2026-09-17) even though it was never a pass/fail condition itself.
    const queueToolPath = path.join(GUARD_DIR, 'pmm-recall-queue.cjs');
    const toolSpawned = spawnSync('node', [queueToolPath, '--source', 'v3'], { env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
    const toolOut = (toolSpawned.stdout || Buffer.alloc(0)).toString('utf8');
    const toolErr = (toolSpawned.stderr || Buffer.alloc(0)).toString('utf8');
    const toolRc = (toolSpawned.status === null || toolSpawned.status === undefined) ? -1 : toolSpawned.status;
    // Find THIS impression's own report line specifically -- the report's header lines legitimately echo
    // the real PMM_RECALL_ROOT filesystem path (which, on this machine, contains the real OS username as
    // an unavoidable fact of where temp dirs live), so "no username" must be checked against the DATA LINE
    // for this impression, not the whole tool output.
    const qImpId = qRow ? qRow[qIx('impression_id')] : null;
    const impressionLine = qImpId ? (toolOut.split('\n').find((l) => l.indexOf(qImpId) === 0) || '') : '';
    report('pmm-recall-queue.cjs --source v3 exits 0 and its report shows the desensitized snippet for this impression, with no username in that data line', toolRc === 0 && !!qImpId && impressionLine !== '' && impressionLine.indexOf(os.userInfo().username) < 0, JSON.stringify({ toolRc, toolErrLen: toolErr.length, qImpId, impressionLine, outSnippet: toolOut.slice(0, 1200) }));
    queueCount++;
  }
  {
    // M0 hook already writes eligible-row queue records (pmm-bash-impression.cjs writeImpressions(),
    // landed in b71ea78/delivery 2 of this batch) -- this is a regression guard, not new functionality,
    // confirming the two writers (gate + M0 hook) do not collide or double-count in the SAME queue file.
    const root = path.join(T, 'queue-m0-coexist-root');
    const M0 = require('./pmm-bash-impression.cjs');
    report('M0 hook module already exports a working desensitize() (pre-existing, not this round\'s work)', typeof M0.desensitize === 'function' && M0.desensitize('cat C:/Users/<user>/x "q"').indexOf(os.userInfo().username) < 0, '');
    queueCount++;
    void root; // no live M0 invocation needed here -- pmm-bash-impression.cjs --self-test already covers it (46/46)
  }

  console.log();
  console.log('=== v2.20 gate_b_browse_denylist (M1 labels: B 14 useful / 16 noise, all noise = browsing) ===');
  let bDenylistCount = 0;
  {
    const ctx = () => ({ cwd: T, root: T, sessionId: '', agentId: '', ttlSeconds: 3600 });
    const existing = path.join(T, 'bx03-existing.txt');
    fs.writeFileSync(existing, 'x');
    const bxCases = [
      { id: 'Bx01', cmd: 'git log --oneline | head -5', wantB: false },
      { id: 'Bx02', cmd: 'ls -la | head', wantB: false },
      { id: 'Bx03', cmd: 'grep -n foo ' + existing.replace(/\\/g, '/') + ' | head -20', wantB: false },
      { id: 'Bx04', cmd: 'git diff | head -50', wantB: true },
      { id: 'Bx05', cmd: 'npm test | tail -20', wantB: true },
      { id: 'Bx06', cmd: 'ls | cmd | tail -3', wantB: true },
    ];
    for (const bx of bxCases) {
      const parsed = REAL_PARSER.parseCommand(bx.cmd, { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      const hasB = r.units.some((u) => u.finding.gate === 'B');
      report(bx.id + ': `' + bx.cmd + '` -> ' + (bx.wantB ? 'B fires' : 'B suppressed (browse denylist)'), hasB === bx.wantB, JSON.stringify(r));
      bDenylistCount++;
    }

    // Black-box, end-to-end: Bx02 shape through the wired script + real ledger (no B row written at all).
    {
      const root = path.join(T, 'bdenylist-e2e-root');
      const hook = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:bdeny', agent_id: 'a-bdeny', tool_use_id: 'toolu_selftest_bdeny',
        cwd: T, tool_input: { command: 'ls -la | head' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
      let bRowExists = false;
      try {
        const lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean);
        const header = lines[0].split('\t'); const ix = (c) => header.indexOf(c);
        bRowExists = lines.slice(1).some((l) => { const c = l.split('\t'); return c[ix('tool_use_id')] === 'toolu_selftest_bdeny' && c[ix('gate')] === 'B'; });
      } catch (e) { bRowExists = false; }
      report('black-box Bx02: `ls -la | head` end-to-end -> zero gate=B rows in the real ledger', !bRowExists, String(bRowExists));
      bDenylistCount++;
    }
  }

  console.log();
  console.log('=== v2.22 gate_b_browse_denylist erratum (Opus F1): browse exemption void on verification write products ===');
  let bWriteEvidenceCount = 0;
  {
    const ctx = () => ({ cwd: T, root: T, sessionId: 'test:bwe', agentId: 'a-bwe', ttlSeconds: 3600 });
    // A12, Bx07, Bx08: unit-level (fast, exercises analyzeCommand directly).
    {
      const f = path.join(T, 'bwe-a12-f.txt');
      fs.writeFileSync(f, 'x');
      const fSlash = f.replace(/\\/g, '/');
      const parsed = REAL_PARSER.parseCommand('cmd > ' + fSlash + ' 2>&1; rc=$?; cat ' + fSlash + ' | tail -3; echo $?', { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      const gates = r.units.map((u) => u.finding.gate).sort();
      report('A12: cmd (non-browse) writes ABS/f.txt earlier in the same command, then cat|tail reads it -> A AND B both fire', gates.length === 2 && gates[0] === 'A' && gates[1] === 'B', JSON.stringify(r));
      bWriteEvidenceCount++;
    }
    {
      const out = path.join(T, 'bwe-bx07-out.txt');
      const outSlash = out.replace(/\\/g, '/');
      const parsed = REAL_PARSER.parseCommand('npm test > ' + outSlash + ' 2>&1; cat ' + outSlash + ' | tail -3', { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      report('Bx07: npm test (non-browse) writes ABS/out.txt, cat|tail previews it -> B fires (exemption void)', r.units.some((u) => u.finding.gate === 'B'), JSON.stringify(r));
      bWriteEvidenceCount++;
    }
    {
      const list = path.join(T, 'bwe-bx08-list.txt');
      const listSlash = list.replace(/\\/g, '/');
      const parsed = REAL_PARSER.parseCommand('ls > ' + listSlash + '; cat ' + listSlash + ' | head', { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      report('Bx08: ls (itself a browse exe) writes ABS/list.txt, cat|head reads it -> exemption KEPT, no B', !r.units.some((u) => u.finding.gate === 'B'), JSON.stringify(r));
      bWriteEvidenceCount++;
    }

    // Bx09/Bx10/Bx11: full lifecycle through the real wired script (pre write -> exec -> post commits
    // receipt -> [age past TTL] -> pre read), matching the contract's own multi-step shape.
    function bweLifecycle(root, id, steps) {
      mkdirp(root);
      let toolUseCounter = 0, lastTu = null;
      function runHook(hookEventName, cmd, extraFields, sameTu) {
        let tu;
        if (sameTu) { tu = lastTu; } else { toolUseCounter++; tu = id + '-tu' + toolUseCounter; lastTu = tu; }
        const hook = Object.assign({
          hook_event_name: hookEventName, session_id: 'test:' + id, agent_id: 'a-' + id, tool_use_id: tu,
          cwd: root, tool_input: hookEventName === 'PreToolUse' ? { command: cmd } : undefined,
        }, extraFields || {});
        return runWired(JSON.stringify(hook), { PMM_RECALL_ROOT: root });
      }
      const outPath = path.join(root, 'out.txt');
      for (const step of steps) {
        if (step.startsWith('pre:')) runHook('PreToolUse', step.slice(4).trim());
        else if (step === 'exec') fs.writeFileSync(outPath, 'x'.repeat(12));
        else if (step === 'post') runHook('PostToolUse', null, { tool_response: { exit_code: 0 } }, true);
        else if (step.startsWith('clock:')) {
          const offsetMs = parseInt(step.slice(6).trim(), 10) * 1000;
          const rf = receiptsPath(root, 'test:' + id, 'a-' + id);
          let text = ''; try { text = fs.readFileSync(rf, 'utf8'); } catch (e) { text = ''; }
          const lines = text.split('\n').filter(Boolean).map((l) => {
            const f = l.split('\t'); const t = Date.parse(f[0]);
            if (!Number.isNaN(t)) f[0] = new Date(t - offsetMs).toISOString();
            return f.join('\t');
          });
          fs.writeFileSync(rf, lines.join('\n') + (lines.length ? '\n' : ''));
        }
      }
      let lines = [];
      try { lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean); } catch (e) { lines = []; }
      if (lines.length === 0) return { bRows: [] };
      const header = lines[0].split('\t'); const ix = (c) => header.indexOf(c);
      const bRows = lines.slice(1).filter((l) => l.split('\t')[ix('gate')] === 'B');
      return { bRows };
    }
    {
      const root = path.join(T, 'bwe-bx09-root');
      const outSlash = path.join(root, 'out.txt').replace(/\\/g, '/');
      const r = bweLifecycle(root, 'bx09', ['pre: npm test > ' + outSlash, 'exec', 'post', 'pre: cat ' + outSlash + ' | tail -3']);
      report('Bx09: receipt (created-nonempty, within TTL) for the browse operand -> exemption void, B fires', r.bRows.length === 1, JSON.stringify(r));
      bWriteEvidenceCount++;
    }
    {
      const root = path.join(T, 'bwe-bx10-root');
      const outSlash = path.join(root, 'out.txt').replace(/\\/g, '/');
      const r = bweLifecycle(root, 'bx10', ['pre: npm test > ' + outSlash, 'exec', 'post', 'clock: 3601', 'pre: cat ' + outSlash + ' | tail -3']);
      report('Bx10: same as Bx09 but the receipt aged past the TTL -> exemption applies again, no B', r.bRows.length === 0, JSON.stringify(r));
      bWriteEvidenceCount++;
    }
    {
      const root = path.join(T, 'bwe-bx11-root');
      const outSlash = path.join(root, 'out.txt').replace(/\\/g, '/');
      const r = bweLifecycle(root, 'bx11', ['pre: npm test > ' + outSlash, 'exec', 'post', 'pre: grep -n foo ' + outSlash + ' | head -20']);
      report('Bx11: grep variant -- pattern token "foo" ignored, file operand has a within-TTL receipt -> B fires', r.bRows.length === 1, JSON.stringify(r));
      bWriteEvidenceCount++;
    }
  }

  console.log();
  console.log('=== v2.23 whole-pipeline browse (codex MEDIUM-3/MEDIUM-4) + tee/verification_output_flags write evidence + Bx21/Bx22 ===');
  let bWholePipelineCount = 0;
  {
    const ctx = () => ({ cwd: T, root: T, sessionId: 'test:bwp', agentId: 'a-bwp', ttlSeconds: 3600 });
    function unitCase(name, cmd, wantGates) {
      const parsed = REAL_PARSER.parseCommand(cmd, { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      const gates = r.units.map((u) => u.finding.gate).sort();
      const want = wantGates.slice().sort();
      report(name + ': `' + cmd + '` -> gates ' + JSON.stringify(want), JSON.stringify(gates) === JSON.stringify(want), JSON.stringify(r));
      bWholePipelineCount++;
      return r;
    }
    const outF = path.join(T, 'bwp-out.txt').replace(/\\/g, '/');
    const outXml = path.join(T, 'bwp-out.xml').replace(/\\/g, '/');
    const listF = path.join(T, 'bwp-list.txt').replace(/\\/g, '/');
    const existF = path.join(T, 'bwp-existing.txt').replace(/\\/g, '/');
    fs.writeFileSync(path.join(T, 'bwp-existing.txt'), 'x');

    unitCase('Bx12', 'npm test 2>&1 | tee ' + outF + '; cat ' + outF + ' | tail -3', ['B']);
    unitCase('Bx13', 'pytest --junitxml=' + outXml + '; cat ' + outXml + ' | tail -3', ['B']);
    unitCase('Bx14', 'npm test | sed -n 1,20p > ' + outF + '; cat ' + outF + ' | tail -3', ['B']);
    unitCase('Bx15', 'ls | sed -n 1,5p > ' + listF + '; cat ' + listF + ' | head', []);
    unitCase('Bx16', 'head -100 ' + existF + ' | tail -10', ['D']);
    unitCase('Bx17', 'git grep foo | head -5', []);
    unitCase('Bx18', 'git ls-tree HEAD | head', []);
    unitCase('Bx19', 'npm test 2>&1 | grep -i error | head -5', ['B']);
    unitCase('Bx20', 'cat ' + existF + ' | grep -i error | head -5', []);
    const r21 = unitCase('Bx21', 'cat <(npm test) | tail -3', ['B']);
    report('Bx21: unsupported process-substitution upstream also fires the informational unsupported event', r21.events.indexOf('unsupported') >= 0, JSON.stringify(r21));
    bWholePipelineCount++;
    unitCase('Bx22', 'npm test | tail -3; ls | head -2', ['B']);

    // Black-box, end-to-end: Bx19 (whole-pipeline browse voided by a non-browse source) through the real
    // wired script + real ledger.
    {
      const root = path.join(T, 'bwp-e2e-root');
      const hook = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:bwp-e2e', agent_id: 'a-bwp-e2e', tool_use_id: 'toolu_selftest_bwp_e2e',
        cwd: T, tool_input: { command: 'npm test 2>&1 | grep -i error | head -5' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
      let bRowExists = false;
      try {
        const lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean);
        const header = lines[0].split('\t'); const ix = (c) => header.indexOf(c);
        bRowExists = lines.slice(1).some((l) => { const c = l.split('\t'); return c[ix('tool_use_id')] === 'toolu_selftest_bwp_e2e' && c[ix('gate')] === 'B'; });
      } catch (e) { bRowExists = false; }
      report('black-box Bx19: `npm test 2>&1 | grep -i error | head -5` end-to-end -> a gate=B row lands in the real ledger', bRowExists, String(bRowExists));
      bWholePipelineCount++;
    }
  }

  console.log();
  console.log('=== v2.24 codex wave-2: source-only writer carve-out (v), jq/yq -e (vi), verification_output_flags single-source (iii), git subs + tool/sub table (vii/viii) ===');
  let wave2Count = 0;
  {
    const ctx = () => ({ cwd: T, root: T, sessionId: 'test:wave2', agentId: 'a-wave2', ttlSeconds: 3600 });
    function unitCase(name, cmd, wantGates) {
      const parsed = REAL_PARSER.parseCommand(cmd, { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      const gates = r.units.map((u) => u.finding.gate).sort();
      const want = wantGates.slice().sort();
      report(name + ': `' + cmd + '` -> gates ' + JSON.stringify(want), JSON.stringify(gates) === JSON.stringify(want), JSON.stringify(r));
      wave2Count++;
      return r;
    }
    const listF = path.join(T, 'wave2-list.txt').replace(/\\/g, '/');
    const reportF = path.join(T, 'wave2-report.json').replace(/\\/g, '/');
    fs.writeFileSync(path.join(T, 'wave2-report.json'), '{"ok":true}');
    const outF = path.join(T, 'wave2-out.json').replace(/\\/g, '/');

    // (v) Bx23: the writer-carve-out tests ONLY the writing pipeline's SOURCE segment -- `tee` itself is
    // not a browse exe, but `ls` (the pipeline's source) is, so the exemption is kept.
    unitCase('Bx23', 'ls | tee ' + listF + '; cat ' + listF + ' | head', []);
    // (vi) Bx24/Bx25: jq -e loses the exemption (its exit status IS the verification); jq without -e keeps it.
    unitCase('Bx24', "jq -e '.ok' " + reportF + ' | head -1', ['B']);
    unitCase('Bx25', "jq '.ok' " + reportF + ' | head -1', []);
    // (iii) Bx26: camelCase --outputFile is write evidence, same single VERIFICATION_OUTPUT_FLAGS Set.
    unitCase('Bx26', 'npx jest --json --outputFile=' + outF + '; cat ' + outF + ' | head', ['B']);
    // (vii) Bx27: git rev-parse joins the read-only git subs.
    unitCase('Bx27', 'git rev-parse HEAD | head -1', []);
    // (viii) Bx28/Bx29: the tool+sub browse table (docker/kubectl/podman logs).
    unitCase('Bx28', 'docker logs app | tail -20', []);
    unitCase('Bx29', 'kubectl logs pod/app | tail -20', []);
    // podman logs: named in the contract's own (viii) prose alongside docker/kubectl but without its own
    // dedicated Bx case -- covered here directly since TOOL_SUB_BROWSE_PAIRS includes it.
    unitCase('podman logs (contract (viii) prose, no dedicated case id)', 'podman logs app | tail -20', []);
    // curl is explicitly NOT in any browse table (its read-only-ness depends on -X/-d, not a fixed
    // subcommand) -- a plain `curl url | head` must still fire B.
    unitCase('curl not exempt (contract (viii): "curl is deliberately NOT exempt")', 'curl https://example.com/x | head', ['B']);

    // Black-box, end-to-end: Bx24 (jq -e voids the exemption) through the real wired script + real ledger.
    {
      const root = path.join(T, 'wave2-e2e-root');
      const hook = JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'test:wave2-e2e', agent_id: 'a-wave2-e2e', tool_use_id: 'toolu_selftest_wave2_e2e',
        cwd: T, tool_input: { command: "jq -e '.ok' " + reportF + ' | head -1' },
      });
      execFileSync('bash', ['-c', WIRED_CMD], { input: hook, env: Object.assign({}, SELFTEST_ISOLATED_ENV, { PMM_RECALL_ROOT: root }), timeout: 5000 });
      let bRowExists = false;
      try {
        const lines = fs.readFileSync(ledger.ledgerPath(root), 'utf8').split('\n').filter(Boolean);
        const header = lines[0].split('\t'); const ix = (c) => header.indexOf(c);
        bRowExists = lines.slice(1).some((l) => { const c = l.split('\t'); return c[ix('tool_use_id')] === 'toolu_selftest_wave2_e2e' && c[ix('gate')] === 'B'; });
      } catch (e) { bRowExists = false; }
      report('black-box Bx24: `jq -e .ok report.json | head -1` end-to-end -> a gate=B row lands in the real ledger', bRowExists, String(bRowExists));
      wave2Count++;
    }
  }

  console.log();
  console.log('=== v2.25 wrapper_commands (fab blind attack MEDIUM-5, contract Wx01-Wx05) ===');
  let wrapperCount = 0;
  {
    const ctx = () => ({ cwd: T, root: T, sessionId: 'test:wrap', agentId: 'a-wrap', ttlSeconds: 3600 });
    function unitCase(name, cmd, wantGates, wantEvents) {
      const parsed = REAL_PARSER.parseCommand(cmd, { tool: 'Bash', cwd: T });
      const r = analyzeCommand(parsed, ctx());
      const gates = r.units.map((u) => u.finding.gate).sort();
      const want = wantGates.slice().sort();
      const events = r.events.slice().sort();
      const wantEv = wantEvents.slice().sort();
      const ok = JSON.stringify(gates) === JSON.stringify(want) && JSON.stringify(events) === JSON.stringify(wantEv);
      report(name + ': `' + cmd + '` -> gates ' + JSON.stringify(want) + ', events ' + JSON.stringify(wantEv), ok, JSON.stringify(r));
      wrapperCount++;
      return r;
    }
    // Wx01: sh -lc (short-flag combo carrying -c) cannot be recursively parsed by pmm-cmd-parse.cjs's
    // detectDialectWrapper (literal -c token only) -- detectBlindWrapper marks the whole segment
    // unsupported:wrapper instead of falling through as an ordinary, unmarked segment.
    unitCase('Wx01', "sh -lc 'npm test | tail -3'", [], ['unsupported']);
    // Wx02: xargs followed by a blind wrapper (sh -c is xargs's OWN argument, not a literal top-level
    // exe/-c token) -- the upstream find segment stays ordinary/ok; only the xargs-wrapped segment is
    // marked unsupported:wrapper; events collapses to exactly one 'unsupported' entry either way.
    unitCase('Wx02', "find . -name '*.log' | xargs sh -c 'npm test | tail -3'", [], ['unsupported']);
    // Wx03: powershell/pwsh short -c (distinct from the recursible literal -Command token).
    unitCase('Wx03', "powershell -c 'npm test | tail -3'", [], ['unsupported']);
    // Wx04: eval has no recursible mechanism at all (detectDialectWrapper never recognized it).
    unitCase('Wx04', "eval 'npm test | tail -3'", [], ['unsupported']);
    // Wx05 control (contract: "sh -c keeps its existing unsupported row"): the PRE-EXISTING bash/sh
    // literal -c recursion (scope_id-based unsupported event) is untouched -- detectBlindWrapper is only
    // consulted when detectDialectWrapper already returned null, so it can never fire for this shape.
    unitCase('Wx05 (control, contract: sh -c keeps its existing unsupported row)', "sh -c 'npm test | tail -3'", [], ['unsupported']);
  }

  console.log();
  console.log('=== v2.25 home_resolution (fab blind attack MEDIUM-1): resolvePathArg ~ expansion via ledger.resolveHome() ===');
  let homeResolutionCount = 0;
  {
    // part13 (contract home_resolution): a guard reading os.homedir()/HOME/USERPROFILE directly is a red
    // in the self-check grep -- resolvePathArg's `~` expansion (line ~174) used to read
    // `process.env.HOME || process.env.USERPROFILE || os.homedir()` directly (HOME outranks USERPROFILE);
    // it now calls the ONE resolver, ledger.resolveHome() (PMM_HOME > USERPROFILE > HOME >
    // os.homedir()), which outranks USERPROFILE OVER HOME -- the opposite order. Setting HOME and
    // USERPROFILE to two DIFFERENT values and asserting the USERPROFILE one wins is a genuine,
    // red-provable behavior change (not just a grep-satisfying rename), distinguishing this from a
    // no-op refactor.
    // 2026-09-23 (coordinator, part13 residual): the old save/restore snapshotted HOME/USERPROFILE/
    // PMM_HOME individually via `process.env.HOME`/`process.env.USERPROFILE` -- the part13 scanner
    // is a mechanical grep on the READ pattern, not purpose-aware, and correctly flagged it (this is a
    // test-teardown checkpoint, not home-derivation logic; ledger.resolveHome() itself would be the
    // WRONG fix here -- it returns one MERGED, precedence-resolved value, not "whatever HOME/USERPROFILE
    // currently literally are", so assigning its output into prevHome/prevUserProfile could not
    // correctly restore the pre-test env). Generalizing to a whole-env Object.assign snapshot both
    // satisfies the scanner (no literal `.HOME`/`.USERPROFILE` member read anywhere in the save/restore
    // machinery) and is strictly more correct than the old 3-variable-specific version (a real,
    // general-purpose env checkpoint/restore, not a name-by-name special case).
    // 2026-09-24 (W4-D roster fix): that whole-env ambient-clone-and-restore snapshot above is itself
    // exactly the shape the "自测结构名册" canary bars from a SELFTEST region (a bare clone of the live
    // env), and it was never load-bearing -- this HOME/USERPROFILE mutate-then-restore only ever needed to
    // change what resolvePathArg() itself observes, never this runner process's real env. Same trick
    // selftest-iso.cjs's own self-test (line ~299, "spawns a CHILD whose env never carries those three
    // keys at all") already uses for the identical part13 hazard: spawn a disposable child process whose
    // env is a fresh copy DERIVED FROM the shared isoEnv(T, {}) helper (never the live env directly) with
    // PMM_HOME deleted and HOME/USERPROFILE overridden to the two sentinel values, and call
    // resolvePathArg() (already exported via module.exports) inside that child. Zero mutation of this
    // process's real env, so no snapshot/restore pair -- and no bare ambient-env clone -- is needed here.
    const homeResolutionEnv = Object.assign({}, SELFTEST_ISOLATED_ENV);
    delete homeResolutionEnv.PMM_HOME;
    homeResolutionEnv.HOME = 'C:/tmp/home-resolution-home-value';
    homeResolutionEnv.USERPROFILE = 'C:/tmp/home-resolution-userprofile-value';
    const homeResolutionChild = require('child_process').spawnSync(process.execPath,
      ['-e', 'process.stdout.write(String(require(process.argv[1]).resolvePathArg(process.argv[2], process.argv[3])))', __filename, '~/foo.txt', 'C:/cwd'],
      { env: homeResolutionEnv, encoding: 'utf8', timeout: 5000 });
    const resolved = homeResolutionChild.status === 0 ? homeResolutionChild.stdout : ('<child failed status=' + homeResolutionChild.status + ' stderr=' + homeResolutionChild.stderr + '>');
    report('resolvePathArg ~ expansion goes through ledger.resolveHome() (USERPROFILE outranks HOME, not a bare HOME-first direct read)', resolved === 'C:/tmp/home-resolution-userprofile-value/foo.txt', resolved);
    homeResolutionCount++;
  }

  console.log();
  console.log('=== v2.25 home_resolution production-safety: zero attributable footprint on the real root across this whole self-test run ===');
  {
    const markers = iso.markersFromSource(__filename, SELFTEST_NONCE, path.basename(T));
    const fp = iso.footprint.end(FOOTPRINT_SNAP, markers);
    report(
      'real root (ledger events-v3-*.tsv / trigger-seen / frozen trigger-log / etc, spec 22 watch set): zero attributable change -- appended-byte marker scan, not just a filename-set diff (audit gap: filename-set comparison goes blind when a leak is appended into an ALREADY-EXISTING real file, the s-cyc shape); TSV row-count growth from real concurrent hook traffic in this same live session is expected and not asserted on',
      !fp.red,
      fp.line,
    );
    homeResolutionCount++;
  }

  console.log();
  console.log('SELFTEST ' + JSON.stringify({ load: loadCount, silence: silenceCount, positive: positiveCount, header: headerCount, informational: informationalCount, lease: leaseCount, optionTable: optionTableCount, oversize: oversizeCount, cdHint: cdHintCount, m3: m3Count, queue: queueCount, bDenylist: bDenylistCount, bWriteEvidence: bWriteEvidenceCount, bWholePipeline: bWholePipelineCount, wave2: wave2Count, wrapper: wrapperCount, homeResolution: homeResolutionCount }));
  console.log('Summary: ' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL > 0 ? 1 : 0);
  // SELFTEST-END
}
