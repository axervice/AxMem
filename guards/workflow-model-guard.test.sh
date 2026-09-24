#!/usr/bin/env bash
#
# Self-test for guards/workflow-model-guard.sh (REWRITE: real AST parse via
# vendored acorn, replacing the old hand-rolled text/bracket scanner).
#
# Covers, per contract:
#   1. Red   -- inputs that MUST be denied, including the 10 "漏拦"
#               (false-negative) items a cross-model review found in the
#               old text-scanner version, each reproduced verbatim as its
#               own case so this suite is a direct regression test for the
#               rewrite's reason for existing, PLUS 8 more items from a
#               SECOND cross-model review (2026-08-02) that found 3 further
#               semantic defects even in the real-AST rewrite: (#1) spread
#               anywhere-in-object was treated as disqualifying regardless
#               of ORDER, over-blocking a spread that comes before a later
#               explicit `model:` that safely overwrites it; (#2) a
#               *computed* key ({[k]:v}) was unconditionally ignored, even
#               when it could statically resolve to the literal name
#               "model" or sat AFTER a real model key where it might
#               override it at runtime; (#3) only empty-string/"inherit"
#               were treated as bad model values -- a statically-known
#               NON-STRING literal (`null`/`false`/`0`/a bare `undefined`
#               identifier) was passed through as if "unresolvable".
#   2. Green -- inputs that MUST be allowed (silent, exit 0), including the
#               6 "误拦" (false-positive) items the same first review found,
#               PLUS the safe counterparts of the second review's 3 defects
#               (spread/unknown-computed-key BEFORE the final `model:` is
#               harmless; a later explicit `model:` always wins).
#   3. Mutation -- weaken each of the guard's distinct violation-detecting
#                  code paths (missing-model / spread-override /
#                  computed-override / bad-literal / non-string-literal /
#                  undefined-identifier / env / ternary-both-branches /
#                  accessor-or-method / static-invalid-type / void) ONE
#                  AT A TIME and prove the corresponding Red assertion(s)
#                  actually flip to allow -- i.e. the test is not a
#                  tautology, and each branch is independently exercised.
#   4. Wiring -- canary check that settings.json actually wires this guard
#                as a PreToolUse hook with matcher "Workflow".
#   5. Defect #A / #B (2026-08-02 THIRD cross-model review) -- two further
#      defects found by directly running the guard's own code, not just
#      reading it:
#        #A (SECURITY HOLE): named-workflow resolution used to check HOME
#           before the project directory and only a single bare
#           process.cwd() (not an upward walk), so a compliant home-layer
#           file of the same name could mask a noncompliant PROJECT-layer
#           file that Claude Code would actually execute -- the guard would
#           validate the wrong file and allow. Fixed to walk UP from cwd
#           through every .claude/workflows/ layer, nearest-project-first,
#           bounded by (and inclusive of) the git repo root, THEN home.
#           Covered by the "defectA*" cases below, which isolate the HOME
#           layer via a USERPROFILE env override (confirmed empirically to
#           be what os.homedir() honors on this platform) so they never
#           touch the real resolved-home .claude/workflows/.
#        #B (FALSE NEGATIVES): the model VALUE classifier treated several
#           statically-invalid node types as "unresolvable -> allow":
#           ObjectExpression/ArrayExpression/ArrowFunctionExpression/
#           FunctionExpression/ClassExpression/`void 0`, AND it never
#           special-cased a `model` key spelled as an accessor or method
#           (`{ model(){} }` / `{ get model(){} }` / `{ set model(v){} }`).
#           Covered by the "defectB-red-*" / "defectB-green-*" cases below.
#
# Every case prints PASS/FAIL. Any FAIL => the script exits 1.
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./pmm-home.sh
source "${SCRIPT_DIR}/pmm-home.sh"
GUARD_SCRIPT="${SCRIPT_DIR}/workflow-model-guard.sh"
# contract v2.26 home_literal_scan (2026-09-23, A5): the default settings.json path used to hardcode
# 'C:/Users/<user>' -- correct only on one machine. settings.json is a git-tracked file at a FIXED
# on-disk location (guards/ is always <repo>/.claude/guards, so two levels up from SCRIPT_DIR IS the
# repo root) -- NOT wherever HOME/USERPROFILE happen to be redirected to for THIS self-test run.
# Measured: deriving this from pmm-home.sh's PMM_HOME_RESOLVED (which follows PMM_HOME > USERPROFILE >
# HOME > os.homedir(), same as used for MIXSTAMP above -- correct there, since MIXSTAMP genuinely
# tracks the resolved-home stamp file, not a fixed repo-tree file) broke the wiring check under a
# redirected-HOME-only run (84/85, not 85/85) -- the same class of bug HIGH-1 fixed in the guard
# itself, just reintroduced one layer up. cygpath -m converts to Windows form before handing to native
# (non-MSYS-aware) node.exe as argv, which never translates a POSIX-style path.
REAL_TREE_HOME="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SETTINGS_JSON_DEFAULT="$(cygpath -m "$REAL_TREE_HOME" 2>/dev/null || printf '%s' "$REAL_TREE_HOME")/.claude/settings.json"
SETTINGS_JSON="${CLAUDE_SETTINGS_JSON_OVERRIDE:-$SETTINGS_JSON_DEFAULT}"

PASS_COUNT=0
FAIL_COUNT=0

# ---------------------------------------------------------------------------
# 🚨 Temp-dir safety (cross-model review 2026-08-02)
#
# Two real defects were found here and are structurally prevented below:
#  (a) `mktemp -d` was UNCHECKED. When /tmp creation failed, the dir became ""
#      and a later `rm -rf "$(dirname "$MUT_...")"` evaluated to **`rm -rf /`**.
#      Only GNU's root-preservation stopped it.
#  (b) Cleanup arrays were appended inside `$( ... )` command substitutions, so
#      the append happened in a SUBSHELL and never reached the parent -> temp
#      files leaked and the array-based cleanup could never work anyway.
#
# Fix for both: ONE validated temp root created up front; everything lives под
# it; a single trap removes that one directory. No per-call array bookkeeping,
# no re-deriving a cleanup path from a possibly-empty file path, ever.
# ---------------------------------------------------------------------------
TEST_TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/workflow-model-guard-test.XXXXXX")" \
  || { echo "FATAL: mktemp -d failed -- refusing to run (see temp-dir safety note)" >&2; exit 1; }
if [ -z "$TEST_TMP_ROOT" ] || [ ! -d "$TEST_TMP_ROOT" ] || [ "$TEST_TMP_ROOT" = "/" ]; then
  echo "FATAL: unusable temp root ('${TEST_TMP_ROOT}') -- refusing to run" >&2
  exit 1
fi
case "$TEST_TMP_ROOT" in
  */workflow-model-guard-test.*) : ;;
  *) echo "FATAL: temp root '${TEST_TMP_ROOT}' does not match the expected pattern -- refusing" >&2; exit 1 ;;
esac
mkdir -p "$TEST_TMP_ROOT/fixtures" || { echo "FATAL: mkdir fixtures failed" >&2; exit 1; }

cleanup_all() {
  # Only ever remove the ONE directory we created, and only after re-validating
  # it. Never dirname a file path; never rm a variable that could be empty.
  [ -n "${TEST_TMP_ROOT:-}" ] || return 0
  [ -d "$TEST_TMP_ROOT" ] || return 0
  case "$TEST_TMP_ROOT" in
    */workflow-model-guard-test.*) rm -rf "$TEST_TMP_ROOT" ;;
    *) echo "WARN: refusing to clean unexpected temp root '$TEST_TMP_ROOT'" >&2 ;;
  esac
}
trap cleanup_all EXIT

report() {
  # report <name> <ok:1|0> <detail>
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "1" ]; then
    echo "PASS: $name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL: $name -- $detail"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# build_script_input <script-content>
# Builds a well-formed {"tool_name":"Workflow","tool_input":{"script": ...}}
# JSON payload via `node -e`, passing the raw content as argv so we never
# have to hand-escape quotes/backticks/newlines/unicode-escapes/regex
# literals for bash or for JSON ourselves.
build_script_input() {
  node -e '
    const content = process.argv[1];
    process.stdout.write(JSON.stringify({ tool_name: "Workflow", tool_input: { script: content } }));
  ' "$1"
}

# build_scriptpath_input <path>
build_scriptpath_input() {
  node -e '
    const p = process.argv[1];
    process.stdout.write(JSON.stringify({ tool_name: "Workflow", tool_input: { scriptPath: p } }));
  ' "$1"
}

# build_name_input <name>
build_name_input() {
  node -e '
    const n = process.argv[1];
    process.stdout.write(JSON.stringify({ tool_name: "Workflow", tool_input: { name: n } }));
  ' "$1"
}

# write_fixture <content> -> prints path of a temp .js file holding content
# Fixtures live under the single validated temp root, so no per-call array
# bookkeeping is needed (which would be lost in the `$( ... )` subshell anyway).
write_fixture() {
  local f
  f="$(mktemp "${TEST_TMP_ROOT}/fixtures/fixture.XXXXXX.js")" || return 1
  printf '%s' "$1" > "$f"
  echo "$f"
}

# run_guard <script> <json-input> [env-assignment ...]
# Sets globals GUARD_OUTPUT / GUARD_EXIT. Extra args are passed through as
# leading `VAR=val` env assignments for the invocation (used by the env-var
# gate tests), same as writing `VAR=val bash "$script"` inline.
# 2026-08-06:stdout 与 stderr 分开捕获(原来合并 2>&1)。
# 守卫本体的注释早就写明:**stdout 独占 PreToolUse JSON 协议,stderr 由 Claude Code
# 单独呈现、不参与解析**。合并捕获与那个契约本就不一致,只是此前守卫在 allow 路径上
# 完全静默,冲突没显形。派工配比报账开始往 stderr 写之后,32 个「allow 应静默」的用例
# 一次性全红 —— 它们断言的是「stdout 空」,却读到了 stderr。
# 修在助手(一处),不是改 32 条断言(会顺手削弱它们)。
run_guard() {
  local script="$1" input="$2"
  shift 2
  local errfile; errfile="$(mktemp)"
  GUARD_OUTPUT="$(printf '%s' "$input" | env "$@" bash "$script" 2>"$errfile")"
  GUARD_EXIT=$?
  GUARD_STDERR="$(cat "$errfile" 2>/dev/null)"
  rm -f "$errfile"
}

is_deny() {
  [[ "$GUARD_OUTPUT" == *'"permissionDecision":"deny"'* ]]
}

# 2026-08-06:把「原有用例」与「派工配比层」隔离。
# 原有 78 条测的是另一个不变量(agent() 有没有显式写 model),它们的夹具大量使用
# 单个 opus/字面量,而配比层的模糊判据是「整个 workflow 零便宜档」—— 于是这些夹具
# 会命中提问,把 allow 变 deny。表现为**套件结果依赖外部状态文件是否存在**:
# 有状态 85/0、无状态 84/1,金丝雀里两次报红而单跑复现不出。
# 偶发的金丝雀项会训练出忽视,所以根治而不是重跑。
# 做法:开头就把「本窗口已问过」置位,让模糊层对原有用例全程静默;
# 配比自己的 mix-* 用例在末尾显式管理这个状态(先备份、用完复原)。
MIXSTAMP="${PMM_HOME_RESOLVED}/.claude/.wf-model-asked"
MIX_STAMP_BAK=""
[ -f "$MIXSTAMP" ] && MIX_STAMP_BAK="$(cat "$MIXSTAMP" 2>/dev/null)"
mix_reset() { rm -f "$MIXSTAMP" 2>/dev/null; }
# MEDIUM-7 (2026-09-23, Opus fab-delta triage, CONFIRMED): under a redirected HOME/USERPROFILE whose
# .claude/ subtree doesn't already exist, this printf silently failed (its own `2>/dev/null || true`
# swallowed the ENOENT) and the whole suite-isolation stamp was never written -- measured 82/85 (later
# 83/85 once HIGH-1's pmm-home.sh fix made the test and the guard converge on the SAME resolved home)
# before this mkdir, 85/85 after. Not added to the guard's own resolution path (workflow-model-
# guard.sh itself) -- see that decision's rationale in the audit: production ~/.claude always exists,
# so a PreToolUse hook building a home subtree on the fly would be the wrong place for this.
mkdir -p "$(dirname "$MIXSTAMP")" 2>/dev/null || true
printf 'suite-isolation' > "$MIXSTAMP" 2>/dev/null || true

echo "=================================================="
echo "RED: the 10 '漏拦' (false-negative) items from cross-model review"
echo "=================================================="

# leak1: model nested inside a sub-object is NOT a top-level model key.
INPUT="$(build_script_input "agent('x', { metadata: { model: 'sonnet' } });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak1: nested metadata.model not counted as top-level -> deny" 1
else
  report "leak1: nested metadata.model not counted as top-level -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak2: ternary where only ONE branch has model -> both branches must qualify.
INPUT="$(build_script_input "agent('x', ok ? { model:'sonnet' } : { prompt:'p' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak2 / extra-red: ternary only one branch has model -> deny" 1
else
  report "leak2 / extra-red: ternary only one branch has model -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak3: "model:" text living inside a regex literal must not be mistaken
# for a real object key (the call also has no real model key, so it must
# deny -- proving the regex text was NOT treated as satisfying the check).
INPUT="$(build_script_input "agent('x', { prompt: /model:/ });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak3: 'model:' text inside regex literal not treated as real key -> deny" 1
else
  report "leak3: 'model:' text inside regex literal not treated as real key -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak4: a comment between `agent` and `(` must not defeat call-site detection.
INPUT="$(build_script_input "agent /* c */ ('x', { prompt:'p' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak4: comment between agent and ( still detected as call -> deny" 1
else
  report "leak4: comment between agent and ( still detected as call -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak5: optional call agent?.(...) must be detected.
INPUT="$(build_script_input "agent?.('x', { prompt:'p' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak5: agent?.(...) optional call detected -> deny" 1
else
  report "leak5: agent?.(...) optional call detected -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak6: duplicate model keys -> the LAST one (JS semantics) must be used.
INPUT="$(build_script_input "agent('x', { model:'sonnet', model:'inherit' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak6: duplicate model keys, last ('inherit') wins -> deny" 1
else
  report "leak6: duplicate model keys, last ('inherit') wins -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak7: a comment INSIDE the model value must not hide a bad literal.
INPUT="$(build_script_input "agent('x', { model: /* c */ 'inherit' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak7: comment inside model value doesn't hide 'inherit' -> deny" 1
else
  report "leak7: comment inside model value doesn't hide 'inherit' -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak8: an escaped string that DECODES to "inherit" must not slip through.
INPUT="$(build_script_input "agent('x', { model: '\u0069nherit' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak8: unicode-escaped 'inherit' literal decoded and caught -> deny" 1
else
  report "leak8: unicode-escaped 'inherit' literal decoded and caught -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak9: parenthesized model value ('inherit') must still be read through.
INPUT="$(build_script_input "agent('x', { model: ('inherit') });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak9: parenthesized ('inherit') value still caught -> deny" 1
else
  report "leak9: parenthesized ('inherit') value still caught -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# leak10: template-literal model value with no interpolation must be read.
INPUT="$(build_script_input 'agent("x", { model: `inherit` });')"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "leak10: template-literal \`inherit\` value still caught -> deny" 1
else
  report "leak10: template-literal \`inherit\` value still caught -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

echo
echo "=================================================="
echo "GREEN: the 6 '误拦' (false-positive) items from cross-model review"
echo "=================================================="

# fp1: a FunctionDeclaration named agent is not a call site.
INPUT="$(build_script_input "function agent(options) { return options; }")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "fp1: function agent(options){...} declaration not a call -> allow" 1
else
  report "fp1: function agent(options){...} declaration not a call -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# fp2: shorthand { model } property must be recognized as the model key.
INPUT="$(build_script_input "const model='sonnet'; agent('x', { model });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "fp2: shorthand { model } recognized as model key -> allow" 1
else
  report "fp2: shorthand { model } recognized as model key -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# fp3: quoted key { 'model': ... } must be recognized as the model key.
INPUT="$(build_script_input "agent('x', { 'model': 'sonnet' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "fp3: quoted key {'model': ...} recognized -> allow" 1
else
  report "fp3: quoted key {'model': ...} recognized -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# fp4: an unrelated array spread inside another property's value must not
# be mistaken for a top-level object spread.
INPUT="$(build_script_input "agent('x', { model:'sonnet', tools:[...tools] });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "fp4: tools:[...tools] array spread not a top-level object spread -> allow" 1
else
  report "fp4: tools:[...tools] array spread not a top-level object spread -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# fp5: a newline right after `obj.` must not defeat member-access detection
# and get misread as a bare global agent() call.
FP5_SCRIPT=$'obj.\nagent(\'x\');\n'
INPUT="$(build_script_input "$FP5_SCRIPT")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "fp5: obj.<newline>agent('x') is member access, not a bare call -> allow" 1
else
  report "fp5: obj.<newline>agent('x') is member access, not a bare call -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# fp6: a regex literal containing a paren must not desync argument-list detection.
INPUT="$(build_script_input 'agent("x", { pattern: /\)/, model:"sonnet" });')"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "fp6: regex literal /\\)/ with paren doesn't desync parsing -> allow" 1
else
  report "fp6: regex literal /\\)/ with paren doesn't desync parsing -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

echo
echo "=================================================="
echo "Additional RED cases"
echo "=================================================="

# extra-red: top-level object spread, no model at all.
INPUT="$(build_script_input "agent('x', {...opts});")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red: agent('x', {...opts}) top-level spread -> deny" 1
else
  report "extra-red: agent('x', {...opts}) top-level spread -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-red: agent('x') with no options argument at all.
INPUT="$(build_script_input "agent('x');")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red: agent('x') no 2nd arg at all -> deny" 1
else
  report "extra-red: agent('x') no 2nd arg at all -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-red: a genuine JS syntax error must fail-closed deny (both
# sourceType attempts fail).
INPUT="$(build_script_input '))) invalid javascript ((( +++ ---')"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red: script with genuine syntax error -> fail-closed deny" 1
else
  report "extra-red: script with genuine syntax error -> fail-closed deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-red: corrupted JSON on stdin -> fail-closed deny.
run_guard "$GUARD_SCRIPT" '{"tool_name":"Workflow","tool_input":{'
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red: corrupted JSON -> fail-closed deny" 1
else
  report "extra-red: corrupted JSON -> fail-closed deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-red: tool_input has none of script/scriptPath/name.
run_guard "$GUARD_SCRIPT" '{"tool_name":"Workflow","tool_input":{}}'
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red: tool_input missing script/scriptPath/name -> deny" 1
else
  report "extra-red: tool_input missing script/scriptPath/name -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-red: CLAUDE_CODE_SUBAGENT_MODEL set -> deny even though the script
# itself is otherwise perfectly valid (explicit model, no other issues).
INPUT="$(build_script_input "agent('x', { model: 'sonnet' });")"
run_guard "$GUARD_SCRIPT" "$INPUT" "CLAUDE_CODE_SUBAGENT_MODEL=haiku"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red: CLAUDE_CODE_SUBAGENT_MODEL set -> deny (outranks per-call model)" 1
else
  report "extra-red: CLAUDE_CODE_SUBAGENT_MODEL set -> deny (outranks per-call model)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-red (bonus, script-resolution contract unchanged): scriptPath ->
# nonexistent file.
INPUT="$(build_scriptpath_input "/definitely/does/not/exist/workflow-model-guard-xyz-12345.js")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red (bonus): scriptPath -> nonexistent file -> deny" 1
else
  report "extra-red (bonus): scriptPath -> nonexistent file -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-red (bonus): name refers to a workflow that doesn't exist under
# the resolved-home .claude/workflows/ or <cwd>/.claude/workflows/.
INPUT="$(build_name_input "workflow-model-guard-test-name-that-should-not-exist-xyz")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red (bonus): name -> unresolvable saved workflow -> deny" 1
else
  report "extra-red (bonus): name -> unresolvable saved workflow -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-red (bonus, regression): bad-literal variants (empty / inherit,
# case-insensitive, whitespace-only).
for badlit in "''" "'inherit'" "'INHERIT'" "'  '" '""'; do
  INPUT="$(build_script_input "agent('x', { model: ${badlit} });")"
  run_guard "$GUARD_SCRIPT" "$INPUT"
  if [ "$GUARD_EXIT" = "0" ] && is_deny; then
    report "extra-red (bonus): model literal ${badlit} (empty/inherit) -> deny" 1
  else
    report "extra-red (bonus): model literal ${badlit} (empty/inherit) -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
  fi
done

# extra-red (bonus, regression): a top-level spread that comes AFTER the
# object's final `model:` still denies, because it might override that
# value at runtime -- the spread-ORDER semantics (see defect1 section below)
# still treat this exact ordering as disqualifying; only a spread BEFORE a
# later explicit model is safe.
INPUT="$(build_script_input "agent('x', { model: 'sonnet', ...opts });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "extra-red (bonus): spread coexisting with a valid model literal still denies" 1
else
  report "extra-red (bonus): spread coexisting with a valid model literal still denies" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

echo
echo "=================================================="
echo "RED: 2026-08-02 SECOND cross-model review -- 3 semantic defects"
echo "(#1 spread-order / #2 computed-key override / #3 static non-string"
echo "model literals)"
echo "=================================================="

# defect1-red-a: spread comes AFTER the final model key -> may override it
# at runtime -> deny. (Same case as the "extra-red (bonus)" above, restated
# here under its proper defect name since it's the direct regression test
# for defect #1.)
INPUT="$(build_script_input "agent('x', { model: 'sonnet', ...defaults });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "defect1-red-a: spread AFTER model ({model:'sonnet', ...defaults}) -> deny" 1
else
  report "defect1-red-a: spread AFTER model ({model:'sonnet', ...defaults}) -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# defect1-red-b: spread-only, no model key at all -> deny (missing-model;
# the spread flag alone never counts as "having" a model).
INPUT="$(build_script_input "agent('x', { ...defaults });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "defect1-red-b: spread only, no model at all ({...defaults}) -> deny" 1
else
  report "defect1-red-b: spread only, no model at all ({...defaults}) -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# defect2-red-a: a computed key that statically resolves to the literal
# name "model" ([\`'model'\`]) and is written AFTER the real `model:` key --
# real JS "last one wins" semantics mean IT is the final source, and its
# value ('inherit') is bad -> deny.
INPUT="$(build_script_input "agent('x', { model: 'sonnet', ['model']: 'inherit' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "defect2-red-a: computed ['model'] after model resolves & overrides with 'inherit' -> deny" 1
else
  report "defect2-red-a: computed ['model'] after model resolves & overrides with 'inherit' -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# defect2-red-b: an UNKNOWN computed key (its expression is a variable, not
# statically resolvable) written AFTER the real model key -> might override
# it at runtime -> deny.
INPUT="$(build_script_input "agent('x', { model: 'sonnet', [key]: value });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "defect2-red-b: unknown computed key after model ([key]: value) -> deny" 1
else
  report "defect2-red-b: unknown computed key after model ([key]: value) -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# defect3-red: statically-known NON-STRING model values (null / false / 0 /
# a bare `undefined` identifier) must all deny -- these are definitively
# invalid, not "unresolvable".
for badval in "null" "false" "0" "undefined"; do
  INPUT="$(build_script_input "agent('x', { model: ${badval} });")"
  run_guard "$GUARD_SCRIPT" "$INPUT"
  if [ "$GUARD_EXIT" = "0" ] && is_deny; then
    report "defect3-red: model: ${badval} (statically non-string) -> deny" 1
  else
    report "defect3-red: model: ${badval} (statically non-string) -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
  fi
done

echo
echo "=================================================="
echo "Additional GREEN cases"
echo "=================================================="

# extra-green: baseline, every call has an explicit model.
INPUT="$(build_script_input "agent('x',{model:'sonnet'})")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "extra-green: agent('x',{model:'sonnet'}) -> allow (silent)" 1
else
  report "extra-green: agent('x',{model:'sonnet'}) -> allow (silent)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-green: model appears after other options.
INPUT="$(build_script_input "agent('x', { label: 'a', model: 'opus' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "extra-green: model after other opts -> allow (silent)" 1
else
  report "extra-green: model after other opts -> allow (silent)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-green: script has no agent( calls at all.
NO_AGENT_SCRIPT=$'function helper(x) {\n  return x + 1;\n}\nmodule.exports = { helper };\n'
INPUT="$(build_script_input "$NO_AGENT_SCRIPT")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "extra-green: no agent() calls at all -> allow (silent)" 1
else
  report "extra-green: no agent() calls at all -> allow (silent)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-green: model: <variable> is statically unresolvable -> must allow
# (denying every computed model would over-block legitimate code).
INPUT="$(build_script_input "const m = 'sonnet'; agent('x', { model: m });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "extra-green: model: <variable> (unresolvable) -> allow (no over-block)" 1
else
  report "extra-green: model: <variable> (unresolvable) -> allow (no over-block)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-green: ternary where BOTH branches have a valid model.
INPUT="$(build_script_input "agent('x', ok ? { model:'sonnet' } : { model:'opus' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "extra-green: ternary, both branches have valid model -> allow" 1
else
  report "extra-green: ternary, both branches have valid model -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-green (bonus): multiple agent() calls, all with model, mixed with
# one that legitimately relies on a variable.
MULTI_GREEN=$'agent(\'a\', { model: \'sonnet\' });\nagent(\'b\', { model: \'opus\' });\n'
INPUT="$(build_script_input "$MULTI_GREEN")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "extra-green (bonus): multiple agent() calls, all have model -> allow" 1
else
  report "extra-green (bonus): multiple agent() calls, all have model -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# extra-green (bonus): scriptPath to a real file with all calls carrying
# model -> exercises the scriptPath resolution path end-to-end. Uses a
# real embedded newline ($'...' ANSI-C quoting), NOT a literal backslash-n
# inside a plain double-quoted string -- the latter would write a literal
# "\n" (backslash + n) into the fixture file, which is not valid JS
# whitespace and would make the real AST parser reject the fixture with a
# genuine syntax error.
G_FIXTURE="$(write_fixture $'agent(\'a\', { model: \'sonnet\' });\nagent(\'b\', { model: \'opus\' });\n')"
INPUT="$(build_scriptpath_input "$G_FIXTURE")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "extra-green (bonus): scriptPath to real file, all calls have model -> allow" 1
else
  report "extra-green (bonus): scriptPath to real file, all calls have model -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

echo
echo "=================================================="
echo "GREEN: 2026-08-02 SECOND cross-model review -- safe counterparts of"
echo "the 3 semantic defects (order-sensitivity means these must NOT deny)"
echo "=================================================="

# defect1-green-a: spread BEFORE a later explicit model -> harmless, the
# explicit key overwrites it at construction time -> allow.
INPUT="$(build_script_input "agent('x', { ...defaults, model: 'sonnet' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "defect1-green-a: spread BEFORE model ({...defaults, model:'sonnet'}) -> allow" 1
else
  report "defect1-green-a: spread BEFORE model ({...defaults, model:'sonnet'}) -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# defect1-green-b: model, then a spread, then model AGAIN -- the spread is
# sandwiched but the FINAL key in source order is still an explicit,
# valid `model:` -> allow (spread's pending-override flag gets cleared by
# the second model key).
INPUT="$(build_script_input "agent('x', { model: 'opus', ...defaults, model: 'sonnet' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "defect1-green-b: model, ...defaults, model again -> final explicit model wins -> allow" 1
else
  report "defect1-green-b: model, ...defaults, model again -> final explicit model wins -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# defect2-green: an unknown computed key BEFORE the real model key ->
# harmless, the later explicit model key wins -> allow.
INPUT="$(build_script_input "agent('x', { [key]: v, model: 'sonnet' });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "defect2-green: unknown computed key BEFORE model ([key]:v, model:'sonnet') -> allow" 1
else
  report "defect2-green: unknown computed key BEFORE model ([key]:v, model:'sonnet') -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# defect-regression-green: re-assert fp4's invariant (nested array spread
# inside another property's VALUE is not a top-level object spread) still
# holds under the new order-sensitive scan.
INPUT="$(build_script_input "agent('x', { model: 'sonnet', tools: [...tools] });")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "defect-regression-green: tools:[...tools] still not a top-level spread -> allow" 1
else
  report "defect-regression-green: tools:[...tools] still not a top-level spread -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

echo
echo "=================================================="
echo "RED: 2026-08-02 THIRD cross-model review -- defect #B (model-value AST"
echo "classification: statically-invalid non-literal types + accessor/method)"
echo "=================================================="

# All 8 defect-#B RED samples from the review: object/array literals, an
# arrow function, a plain function expression (via method shorthand), a
# class expression, `void 0`, and the getter/setter accessor forms. Every
# one of these used to fall through into the "unresolvable -> allow"
# catch-all.
DEFECTB_RED_EXPRS=(
  "{ model: {} }"
  "{ model: [] }"
  "{ model() {} }"
  "{ model: () => 'sonnet' }"
  "{ model: class X {} }"
  "{ model: void 0 }"
  "{ set model(v) {} }"
  "{ get model() { return 'inherit' } }"
)
DEFECTB_RED_LABELS=(
  "object-literal"
  "array-literal"
  "method-shorthand"
  "arrow-function"
  "class-expression"
  "void-zero"
  "setter"
  "getter"
)
for i in "${!DEFECTB_RED_EXPRS[@]}"; do
  expr="${DEFECTB_RED_EXPRS[$i]}"
  label="${DEFECTB_RED_LABELS[$i]}"
  INPUT="$(build_script_input "agent('x', ${expr});")"
  run_guard "$GUARD_SCRIPT" "$INPUT"
  if [ "$GUARD_EXIT" = "0" ] && is_deny; then
    report "defectB-red-${label}: agent('x', ${expr}) -> deny" 1
  else
    report "defectB-red-${label}: agent('x', ${expr}) -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
  fi
done

echo
echo "=================================================="
echo "GREEN: 2026-08-02 THIRD cross-model review -- defect #B safe"
echo "counterparts (genuinely unresolvable model values must still allow)"
echo "=================================================="

DEFECTB_GREEN_EXPRS=(
  "{ model: someVar }"
  "{ model: obj.m }"
  "{ model: pick() }"
  '{ model: `${a}` }'
  "{ model }"
)
DEFECTB_GREEN_LABELS=(
  "bare-identifier"
  "member-expression"
  "call-expression"
  "interpolated-template"
  "shorthand"
)
for i in "${!DEFECTB_GREEN_EXPRS[@]}"; do
  expr="${DEFECTB_GREEN_EXPRS[$i]}"
  label="${DEFECTB_GREEN_LABELS[$i]}"
  INPUT="$(build_script_input "agent('x', ${expr});")"
  run_guard "$GUARD_SCRIPT" "$INPUT"
  if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
    report "defectB-green-${label}: agent('x', ${expr}) -> allow" 1
  else
    report "defectB-green-${label}: agent('x', ${expr}) -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
  fi
done

echo
echo "=================================================="
echo "RED/GREEN: 2026-08-02 THIRD cross-model review -- defect #A"
echo "(named-workflow resolution: project-over-home, git-repo-root-bounded"
echo "upward walk, matching Claude Code 2.1.178+'s real resolution order)"
echo "=================================================="

# All defect-#A cases isolate BOTH the project layer (via `cd`) and the home
# layer (via a USERPROFILE override -- confirmed empirically that this
# platform's node/os.homedir() honors USERPROFILE, not HOME) so they never
# read or write the real resolved-home .claude/workflows/. Directories/files live under
# TEST_TMP_ROOT (single trap cleanup, per this file's temp-dir safety rule);
# `cd` is always paired with a `cd "$ORIG_PWD"` restore so later tests in
# this same script are unaffected.
DEFECTA_ROOT="${TEST_TMP_ROOT}/defectA"
mkdir -p "$DEFECTA_ROOT" || { echo "FATAL: mkdir defectA root failed" >&2; exit 1; }
ORIG_PWD="$(pwd)"

# --- A1 (THE security-hole regression test): a project-layer workflow file
# is missing `model:` (noncompliant); a HOME-layer file of the exact same
# name is fully compliant. The guard MUST resolve and validate the PROJECT
# file (matching what the Workflow tool would actually execute) and deny --
# proving it no longer silently reads the "wrong" (home) copy just because
# home used to be checked first.
mkdir -p "$DEFECTA_ROOT/a1-project/.git" || { echo "FATAL: mkdir a1 .git failed" >&2; exit 1; }
mkdir -p "$DEFECTA_ROOT/a1-project/.claude/workflows" || { echo "FATAL: mkdir a1 project workflows failed" >&2; exit 1; }
mkdir -p "$DEFECTA_ROOT/a1-home/.claude/workflows" || { echo "FATAL: mkdir a1 home workflows failed" >&2; exit 1; }
printf '%s' "agent('x', { label: 'no model here' });" > "$DEFECTA_ROOT/a1-project/.claude/workflows/wmgtest_a1.js"
printf '%s' "agent('x', { model: 'sonnet' });" > "$DEFECTA_ROOT/a1-home/.claude/workflows/wmgtest_a1.js"

cd "$DEFECTA_ROOT/a1-project" || { echo "FATAL: cd a1-project failed" >&2; exit 1; }
INPUT="$(build_name_input "wmgtest_a1")"
run_guard "$GUARD_SCRIPT" "$INPUT" "USERPROFILE=$DEFECTA_ROOT/a1-home"
cd "$ORIG_PWD" || exit 1
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "defectA1 (SECURITY): noncompliant project file + compliant same-name home file -> guard reads PROJECT, denies" 1
else
  report "defectA1 (SECURITY): noncompliant project file + compliant same-name home file -> guard reads PROJECT, denies" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# --- A2: no project-layer file exists anywhere between cwd and the repo
# root -- only HOME has a (compliant) file of this name. The guard must
# still fall back to home and allow.
mkdir -p "$DEFECTA_ROOT/a2-project/.git" || { echo "FATAL: mkdir a2 .git failed" >&2; exit 1; }
mkdir -p "$DEFECTA_ROOT/a2-home/.claude/workflows" || { echo "FATAL: mkdir a2 home workflows failed" >&2; exit 1; }
printf '%s' "agent('x', { model: 'sonnet' });" > "$DEFECTA_ROOT/a2-home/.claude/workflows/wmgtest_a2.js"

cd "$DEFECTA_ROOT/a2-project" || { echo "FATAL: cd a2-project failed" >&2; exit 1; }
INPUT="$(build_name_input "wmgtest_a2")"
run_guard "$GUARD_SCRIPT" "$INPUT" "USERPROFILE=$DEFECTA_ROOT/a2-home"
cd "$ORIG_PWD" || exit 1
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "defectA2: only HOME has the file -> guard falls back to home, allows" 1
else
  report "defectA2: only HOME has the file -> guard falls back to home, allows" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# --- A3 (boundary): a NESTED git repo's own root must stop the upward walk
# right there -- it must NOT climb past its own `.git` into an ANCESTOR
# repo's .claude/workflows/, even though a same-named file exists there.
# cwd = outer/inner (inner HAS ITS OWN .git); the target file only exists at
# outer/.claude/workflows/ (one level ABOVE inner's own repo root). Home is
# pointed at an empty dir with nothing matching either, so the only way this
# could resolve to "found" is by incorrectly climbing past inner's own repo
# root, which must not happen.
mkdir -p "$DEFECTA_ROOT/a3-outer/.git" || { echo "FATAL: mkdir a3 outer .git failed" >&2; exit 1; }
mkdir -p "$DEFECTA_ROOT/a3-outer/.claude/workflows" || { echo "FATAL: mkdir a3 outer workflows failed" >&2; exit 1; }
printf '%s' "agent('x', { model: 'sonnet' });" > "$DEFECTA_ROOT/a3-outer/.claude/workflows/wmgtest_a3.js"
mkdir -p "$DEFECTA_ROOT/a3-outer/inner/.git" || { echo "FATAL: mkdir a3 inner .git failed" >&2; exit 1; }
mkdir -p "$DEFECTA_ROOT/a3-empty-home/.claude/workflows" || { echo "FATAL: mkdir a3 empty home failed" >&2; exit 1; }

cd "$DEFECTA_ROOT/a3-outer/inner" || { echo "FATAL: cd a3-outer/inner failed" >&2; exit 1; }
INPUT="$(build_name_input "wmgtest_a3")"
run_guard "$GUARD_SCRIPT" "$INPUT" "USERPROFILE=$DEFECTA_ROOT/a3-empty-home"
cd "$ORIG_PWD" || exit 1
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "defectA3 (boundary): nested repo root stops the climb, does not leak into ancestor repo -> deny (not found)" 1
else
  report "defectA3 (boundary): nested repo root stops the climb, does not leak into ancestor repo -> deny (not found)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# --- A4: a plain subdirectory WITHOUT its own .git climbs multiple levels
# up to find the nearest ancestor repo root's .claude/workflows/ file
# (proving multi-level climbing actually works, not just a single parent
# hop).
mkdir -p "$DEFECTA_ROOT/a4-repo/.git" || { echo "FATAL: mkdir a4 .git failed" >&2; exit 1; }
mkdir -p "$DEFECTA_ROOT/a4-repo/.claude/workflows" || { echo "FATAL: mkdir a4 workflows failed" >&2; exit 1; }
printf '%s' "agent('x', { model: 'sonnet' });" > "$DEFECTA_ROOT/a4-repo/.claude/workflows/wmgtest_a4.js"
mkdir -p "$DEFECTA_ROOT/a4-repo/deep/nested/subdir" || { echo "FATAL: mkdir a4 deep subdir failed" >&2; exit 1; }
mkdir -p "$DEFECTA_ROOT/a4-empty-home/.claude/workflows" || { echo "FATAL: mkdir a4 empty home failed" >&2; exit 1; }

cd "$DEFECTA_ROOT/a4-repo/deep/nested/subdir" || { echo "FATAL: cd a4 deep subdir failed" >&2; exit 1; }
INPUT="$(build_name_input "wmgtest_a4")"
run_guard "$GUARD_SCRIPT" "$INPUT" "USERPROFILE=$DEFECTA_ROOT/a4-empty-home"
cd "$ORIG_PWD" || exit 1
if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
  report "defectA4: multi-level climb from a subdir with no own .git finds the repo-root file -> allow" 1
else
  report "defectA4: multi-level climb from a subdir with no own .git finds the repo-root file -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

echo
echo "=================================================="
echo "Mutation tests (canary: prove each violation branch can actually flip"
echo "Red cases to allow -- missing-model / spread-override /"
echo "computed-override / bad-literal / non-string-literal /"
echo "undefined-identifier / env / ternary-both-branches)"
echo "=================================================="
echo
echo "⚠️  COUPLING WARNING: each sed pattern below matches the guard's"
echo "    embedded Node script by the exact source text of that check"
echo "    (tagged with a // MUTATION-TARGET:<name> comment in the guard)."
echo "    If workflow-model-guard.sh's core checks are ever reworded, the"
echo "    corresponding sed pattern here (and its MUTATION-TARGET comment"
echo "    in the guard) MUST be updated in the SAME change -- otherwise the"
echo "    sed silently no-ops and this canary degrades into 'mutation setup"
echo "    broken' instead of proving test sensitivity. Same trap documented"
echo "    in agent-model-guard.test.sh as [process:guard-is-also-a-defect-instance]."

make_mutant() {
  # make_mutant <suffix> -> prints path to a fresh copy of the guard script.
  # Also copies vendor/acorn.js alongside it in the SAME temp dir, because
  # the guard resolves its acorn dependency relative to its own
  # BASH_SOURCE[0] location (so it works no matter the caller's cwd) --
  # without this, every mutant would fail-closed on "acorn not found"
  # regardless of which check was mutated, masking the real mutation
  # entirely behind an unrelated guard-malfunction deny.
  # 🚨 SAFETY (cross-model review 2026-08-02): every step below MUST be checked.
  # Previously `mktemp -d` was unchecked; when /tmp creation failed, `dir` became
  # "" -> the mutant path degraded to "/workflow-model-guard.mutant.sh" -> the
  # later `rm -rf "$(dirname "$MUT_...")"` evaluated to **`rm -rf /`**. Only GNU's
  # root-preservation stopped it. Never re-derive a cleanup dir from a possibly
  # empty path, and never continue past a failed mktemp/cp/mkdir.
  # Mutants live UNDER the single validated temp root (see the temp-dir safety
  # note at the top). No separate mktemp, no array bookkeeping (which would be
  # lost in this function's `$( ... )` subshell), no cleanup path re-derived
  # from a file path -- the one trap on TEST_TMP_ROOT removes everything.
  local suffix="$1"
  local dir="${TEST_TMP_ROOT}/mutant-${suffix}"
  mkdir -p "${dir}/vendor" || { echo "FATAL: mkdir mutant dir failed (${dir})" >&2; exit 1; }
  local dest="${dir}/workflow-model-guard.mutant.sh"
  cp "$GUARD_SCRIPT" "$dest" || { echo "FATAL: cp guard -> mutant failed" >&2; exit 1; }
  # acorn MUST accompany the mutant: the guard resolves it relative to its own
  # BASH_SOURCE, so without this every mutant fail-closes on "parser not found"
  # and EVERY MUTATION PASSES VACUOUSLY (this actually happened once).
  cp "${SCRIPT_DIR}/vendor/acorn.js" "${dir}/vendor/acorn.js" \
    || { echo "FATAL: cp acorn -> mutant failed (mutations would vacuously pass)" >&2; exit 1; }
  # pmm-recall-ledger.cjs MUST accompany the mutant too, for the same reason
  # as acorn above: the guard's embedded node script now requires it (via
  # process.argv[3] = its own GUARD_DIR) to resolve HOME through the single
  # canonical resolveHome() instead of reading os.homedir()/HOME/USERPROFILE
  # directly (part13_home_resolution_scan). Without a copy here, every mutant
  # fail-closes on "module not found" regardless of which check was mutated,
  # masking the real mutation the exact same way a missing acorn.js would.
  cp "${SCRIPT_DIR}/pmm-recall-ledger.cjs" "${dir}/pmm-recall-ledger.cjs" \
    || { echo "FATAL: cp pmm-recall-ledger.cjs -> mutant failed (mutations would vacuously pass)" >&2; exit 1; }
  echo "$dest"
}

run_mutation_case() {
  # run_mutation_case <mutant-script> <red-json-input>
  # Prints "1" = the mutant STILL denies (mutation had no effect -> BAD),
  #        "0" = the mutant cleanly ALLOWS (mutation flipped it -> GOOD).
  #
  # ⚠️ STRICT ORACLE (tightened after cross-model review 2026-08-02):
  # "flipped green" must mean a REAL silent allow -- exit 0 AND completely
  # empty output. The previous oracle treated *anything that wasn't an exit-0
  # deny* as a successful flip, so a bash-level crash, a non-zero exit, or
  # garbage output all counted as "the mutation worked" — which is exactly how
  # the earlier acorn-missing bug made every mutation pass vacuously (mutants
  # died on "parser not found" and that was scored as success).
  local mutant="$1" input="$2"
  run_guard "$mutant" "$input"
  if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
    echo "0"            # clean silent allow -> genuine flip
  else
    echo "1"            # still denied, crashed, or noisy -> NOT a genuine flip
  fi
}

# --- Mutation 1: missing-model (ObjectExpression path: no final model key) ---
# NOTE: the mutation flips the RETURN VALUE to { ok: true } rather than
# just neutering the `if` condition to `false`. Neutering the condition
# alone would let execution fall through to `finalModelProp.value` with
# `finalModelProp` still null, throwing (not cleanly allowing) -- which the
# guard's own catch-all correctly turns into ANOTHER deny, masking whether
# the mutation had any effect at all. Flipping the return value is the
# mutation that actually corresponds to "this check doesn't matter".
MUT_MISSING="$(make_mutant missing-model)"
sed -i "s#if (!finalModelProp) return { ok: false, kind: 'missing-model' }; // MUTATION-TARGET:missing-model-check-object#if (!finalModelProp) return { ok: true }; // MUTATION-TARGET:missing-model-check-object#" "$MUT_MISSING"
sed -i "s#if (!argNode) return { ok: false, kind: 'missing-model' }; // MUTATION-TARGET:missing-model-check-arity#if (!argNode) return { ok: true }; // MUTATION-TARGET:missing-model-check-arity#" "$MUT_MISSING"
if grep -qF "if (!finalModelProp) return { ok: true }; // MUTATION-TARGET:missing-model-check-object" "$MUT_MISSING" && \
   grep -qF "if (!argNode) return { ok: true }; // MUTATION-TARGET:missing-model-check-arity" "$MUT_MISSING"; then
  INPUT="$(build_script_input "agent('x', { label: 'y' });")"
  R1="$(run_mutation_case "$MUT_MISSING" "$INPUT")"
  INPUT="$(build_script_input "agent('x');")"
  R2="$(run_mutation_case "$MUT_MISSING" "$INPUT")"
  if [ "$R1" = "0" ] && [ "$R2" = "0" ]; then
    report "mutation: missing-model check disabled -> Red cases flip to allow" 1
  else
    report "mutation: missing-model check disabled -> Red cases flip to allow" 0 \
      "mutant still denied at least one case (object-path=$R1 arity-path=$R2) -- mutation had no effect"
  fi
else
  report "mutation: missing-model sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap (never re-derive dir from a file path)

# --- Mutation 2: spread-order (spread AFTER the final model source) ---
# This is the direct mutation regression test for cross-model-review defect
# #1: the guard used to deny ANY top-level spread regardless of order,
# which over-blocked `{...defaults, model:'sonnet'}`. The fix made the
# check ORDER-SENSITIVE (only a spread AFTER the final model source is
# disqualifying), so the mutation target is now the post-scan
# `spreadPending` check, not a "hasSpread anywhere" flag. The Red input
# here DELIBERATELY combines the spread (AFTER) with an otherwise-valid
# `model: 'sonnet'` literal (not a bare `{...opts}`), because a bare
# spread-only object would still correctly deny via the SEPARATE
# missing-model branch even with this check fully disabled, which would
# prove nothing about whether THIS check specifically matters.
MUT_SPREAD="$(make_mutant spread-override)"
sed -i "s#if (spreadPending) return { ok: false, kind: 'spread-override' }; // MUTATION-TARGET:spread-override-check#if (false) return { ok: false, kind: 'spread-override' }; // MUTATION-TARGET:spread-override-check#" "$MUT_SPREAD"
if grep -qF "if (false) return { ok: false, kind: 'spread-override' }; // MUTATION-TARGET:spread-override-check" "$MUT_SPREAD"; then
  INPUT="$(build_script_input "agent('x', { model: 'sonnet', ...opts });")"
  R="$(run_mutation_case "$MUT_SPREAD" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: spread-order check disabled -> Red case flips to allow" 1
  else
    report "mutation: spread-order check disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: spread-order sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 3: bad-literal (empty / "inherit" string value) ---
MUT_BADLIT="$(make_mutant bad-literal)"
sed -i "s#if (norm === '' || norm === 'inherit') return { ok: false, kind: 'bad-model-literal' }; // MUTATION-TARGET:bad-literal-check#if (false) return { ok: false, kind: 'bad-model-literal' }; // MUTATION-TARGET:bad-literal-check#" "$MUT_BADLIT"
if grep -qF "if (false) return { ok: false, kind: 'bad-model-literal' }; // MUTATION-TARGET:bad-literal-check" "$MUT_BADLIT"; then
  INPUT="$(build_script_input "agent('x', { model: 'inherit' });")"
  R="$(run_mutation_case "$MUT_BADLIT" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: bad-literal check disabled -> Red case flips to allow" 1
  else
    report "mutation: bad-literal check disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: bad-literal sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 6: computed-override (unknown computed key AFTER the final
# model source) --- Direct mutation regression test for cross-model-review
# defect #2's "override" half: an unresolvable computed key ([key]:value)
# written after a real `model:` might overwrite it at runtime.
MUT_COMPUTED="$(make_mutant computed-override)"
sed -i "s#if (computedPending) return { ok: false, kind: 'computed-override' }; // MUTATION-TARGET:computed-override-check#if (false) return { ok: false, kind: 'computed-override' }; // MUTATION-TARGET:computed-override-check#" "$MUT_COMPUTED"
if grep -qF "if (false) return { ok: false, kind: 'computed-override' }; // MUTATION-TARGET:computed-override-check" "$MUT_COMPUTED"; then
  INPUT="$(build_script_input "agent('x', { model: 'sonnet', [key]: value });")"
  R="$(run_mutation_case "$MUT_COMPUTED" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: computed-override check disabled -> Red case flips to allow" 1
  else
    report "mutation: computed-override check disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: computed-override sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 7: non-string-literal (statically-known null/false/0/regex/
# bigint model value) --- Direct mutation regression test for cross-model-
# review defect #3: these are definitively invalid, not "unresolvable".
MUT_NONSTRING="$(make_mutant non-string-literal)"
sed -i "s#return { ok: false, kind: 'non-string-literal' }; // MUTATION-TARGET:non-string-literal-check#return { ok: true }; // MUTATION-TARGET:non-string-literal-check#" "$MUT_NONSTRING"
if grep -qF "return { ok: true }; // MUTATION-TARGET:non-string-literal-check" "$MUT_NONSTRING"; then
  INPUT="$(build_script_input "agent('x', { model: null });")"
  R="$(run_mutation_case "$MUT_NONSTRING" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: non-string-literal check disabled -> Red case flips to allow" 1
  else
    report "mutation: non-string-literal check disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: non-string-literal sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 8: undefined-identifier (bare `undefined` as model value) ---
# Separate branch from Mutation 7 because `undefined` is NOT a Literal node
# in JS grammar (it's an Identifier referencing the global) -- it has its
# own dedicated check in the guard, tagged separately, so it needs its own
# independent mutation proof.
MUT_UNDEF="$(make_mutant undefined-identifier)"
sed -i "s#return { ok: false, kind: 'non-string-literal' }; // MUTATION-TARGET:undefined-identifier-check#return { ok: true }; // MUTATION-TARGET:undefined-identifier-check#" "$MUT_UNDEF"
if grep -qF "return { ok: true }; // MUTATION-TARGET:undefined-identifier-check" "$MUT_UNDEF"; then
  INPUT="$(build_script_input "agent('x', { model: undefined });")"
  R="$(run_mutation_case "$MUT_UNDEF" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: undefined-identifier check disabled -> Red case flips to allow" 1
  else
    report "mutation: undefined-identifier check disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: undefined-identifier sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 9: accessor-or-method (get/set/method-shorthand `model` key) ---
# Direct mutation regression test for 2026-08-02 THIRD cross-model review
# defect #B's accessor/method special case: this check must fire BEFORE
# value validation even runs, so its own dedicated MUTATION-TARGET has to be
# proven independently of Mutations 7/8/10/11 below.
MUT_ACCESSOR="$(make_mutant accessor-or-method)"
sed -i "s#return { ok: false, kind: 'accessor-or-method' }; // MUTATION-TARGET:accessor-or-method-check#return { ok: true }; // MUTATION-TARGET:accessor-or-method-check#" "$MUT_ACCESSOR"
if grep -qF "return { ok: true }; // MUTATION-TARGET:accessor-or-method-check" "$MUT_ACCESSOR"; then
  INPUT="$(build_script_input "agent('x', { model() {} });")"
  R="$(run_mutation_case "$MUT_ACCESSOR" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: accessor-or-method check disabled -> Red case flips to allow" 1
  else
    report "mutation: accessor-or-method check disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: accessor-or-method sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 10: static-invalid-type ({}/[]/arrow/function/class as the
# `model` value) --- Direct mutation regression test for 2026-08-02 THIRD
# cross-model review defect #B's STATIC_INVALID_VALUE_TYPES branch.
MUT_STATICTYPE="$(make_mutant static-invalid-type)"
sed -i "s#return { ok: false, kind: 'static-invalid-value' }; // MUTATION-TARGET:static-invalid-type-check#return { ok: true }; // MUTATION-TARGET:static-invalid-type-check#" "$MUT_STATICTYPE"
if grep -qF "return { ok: true }; // MUTATION-TARGET:static-invalid-type-check" "$MUT_STATICTYPE"; then
  INPUT="$(build_script_input "agent('x', { model: {} });")"
  R="$(run_mutation_case "$MUT_STATICTYPE" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: static-invalid-type check disabled -> Red case flips to allow" 1
  else
    report "mutation: static-invalid-type check disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: static-invalid-type sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 11: void (`model: void 0`) --- Separate branch from Mutation
# 10 because `void <expr>` is a UnaryExpression, not one of the
# STATIC_INVALID_VALUE_TYPES node types, and has its own dedicated check +
# MUTATION-TARGET tag, so it needs its own independent mutation proof (both
# lines return the same `kind: 'static-invalid-value'` string but are
# distinguished by their trailing MUTATION-TARGET comment, so the sed
# patterns below only ever match their own single line each).
MUT_VOID="$(make_mutant void-check)"
sed -i "s#return { ok: false, kind: 'static-invalid-value' }; // MUTATION-TARGET:void-check#return { ok: true }; // MUTATION-TARGET:void-check#" "$MUT_VOID"
if grep -qF "return { ok: true }; // MUTATION-TARGET:void-check" "$MUT_VOID"; then
  INPUT="$(build_script_input "agent('x', { model: void 0 });")"
  R="$(run_mutation_case "$MUT_VOID" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: void check disabled -> Red case flips to allow" 1
  else
    report "mutation: void check disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: void sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 4: env (CLAUDE_CODE_SUBAGENT_MODEL gate) ---
MUT_ENV="$(make_mutant env)"
sed -i "s#const envOverrideActive = (typeof envModel === 'string' \&\& envModel.trim().length > 0); // MUTATION-TARGET:env-check#const envOverrideActive = false; // MUTATION-TARGET:env-check#" "$MUT_ENV"
if grep -qF "const envOverrideActive = false; // MUTATION-TARGET:env-check" "$MUT_ENV"; then
  INPUT="$(build_script_input "agent('x', { model: 'sonnet' });")"
  run_guard "$MUT_ENV" "$INPUT" "CLAUDE_CODE_SUBAGENT_MODEL=haiku"
  if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
    report "mutation: env-var gate disabled -> Red case flips to allow" 1
  else
    report "mutation: env-var gate disabled -> Red case flips to allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT -- mutation had no effect"
  fi
else
  report "mutation: env sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

# --- Mutation 5: ternary (both branches must qualify) ---
MUT_TERNARY="$(make_mutant ternary)"
sed -i "s#if (!consequentResult.ok) return consequentResult; // MUTATION-TARGET:ternary-consequent-check#if (false) return consequentResult; // MUTATION-TARGET:ternary-consequent-check#" "$MUT_TERNARY"
sed -i "s#if (!alternateResult.ok) return alternateResult; // MUTATION-TARGET:ternary-alternate-check#if (false) return alternateResult; // MUTATION-TARGET:ternary-alternate-check#" "$MUT_TERNARY"
if grep -qF "if (false) return consequentResult; // MUTATION-TARGET:ternary-consequent-check" "$MUT_TERNARY" && \
   grep -qF "if (false) return alternateResult; // MUTATION-TARGET:ternary-alternate-check" "$MUT_TERNARY"; then
  INPUT="$(build_script_input "agent('x', ok ? { model:'sonnet' } : { prompt:'p' });")"
  R="$(run_mutation_case "$MUT_TERNARY" "$INPUT")"
  if [ "$R" = "0" ]; then
    report "mutation: ternary both-branches-must-qualify disabled -> Red case flips to allow" 1
  else
    report "mutation: ternary both-branches-must-qualify disabled -> Red case flips to allow" 0 "mutant still denied -- mutation had no effect"
  fi
else
  report "mutation: ternary sed patched mutant script" 0 "sed pattern not found -- mutation setup itself is broken"
fi
# cleanup handled by cleanup_mutants() trap

echo
echo "=================================================="
echo "Wiring check (canary: is this guard actually hooked up?)"
echo "=================================================="

if [ ! -f "$SETTINGS_JSON" ]; then
  report "wiring: settings.json exists and wires PreToolUse matcher=Workflow -> this guard" 0 \
    "settings.json not found at $SETTINGS_JSON"
else
  WIRING_CHECK="$(node -e '
    const fs = require("fs");
    const path = process.argv[1];
    let raw;
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch (e) {
      console.log("NOT_WIRED: cannot read settings.json (" + e.message + ")");
      process.exit(0);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.log("NOT_WIRED: settings.json is not valid JSON (" + e.message + ")");
      process.exit(0);
    }
    const preToolUse = (data && data.hooks && Array.isArray(data.hooks.PreToolUse)) ? data.hooks.PreToolUse : [];
    let found = false;
    for (const entry of preToolUse) {
      if (!entry || String(entry.matcher || "").split("|").indexOf("Workflow") === -1 || !Array.isArray(entry.hooks)) continue; // A6 2026-08-20: matcher 可为单独或 "Agent|Workflow"(经 model-guard.sh 分发)
      for (const h of entry.hooks) {
        const cmd = (h && typeof h.command === "string") ? h.command : "";
        if (cmd.replace(/\\\\/g, "/").toLowerCase().match(/workflow-model-guard.sh|(^|[/])model-guard.sh/)) { // A6: 直连或经分发器都算接线
          found = true;
        }
      }
    }
    console.log(found ? "WIRED" : "NOT_WIRED: no hooks.PreToolUse entry with matcher=\"Workflow\" pointing at workflow-model-guard.sh");
  ' "$SETTINGS_JSON")"

  if [[ "$WIRING_CHECK" == WIRED* ]]; then
    report "wiring: settings.json wires PreToolUse matcher=Workflow -> this guard" 1
  else
    report "wiring: settings.json wires PreToolUse matcher=Workflow -> this guard" 0 "$WIRING_CHECK"
  fi
fi

echo
echo "=================================================="
echo "派工配比(2026-08-06):精确层每次拦 · 模糊层每窗口一次 · 报账无条件"
echo "=================================================="

# 这一节测的不是「有没有写 model」,是「写了但选错档」。
# 由来:一个会话 15 个 agent 全 opus+high、零 sonnet,而 model: 全写了 ——
# 本守卫原有的不变量它全满足。堵住了「静默继承」,没堵住「显式选错」。
# 两层强弱不同:精确层(标签是机械活却派贵档)有唯一正确修法 → 每次都拦,每犯一次就重读一遍表;
# 模糊层(整体零便宜档)是判断题 → 限次,免得误拦纯判断工作流后被整条删掉。
# 模糊层的真实职责是**遗忘探测器**:内化了就很少响,一响说明开始滑回去了。


# 精确层 RED:标签是机械活(勘察)却派 opus
mix_reset
INPUT="$(build_script_input "agent('a',{label:'勘察',model:'opus'}); agent('b',{label:'judge',model:'fable'});")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny && [[ "$GUARD_OUTPUT" == *"机械活派了贵档"* ]]; then
  report "mix-1: 机械标签+贵档 -> deny(点名)" 1
else
  report "mix-1: 机械标签+贵档 -> deny(点名)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 精确层不限次:同窗口第二次仍必须拦(与模糊层的关键差别)
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny && [[ "$GUARD_OUTPUT" == *"机械活派了贵档"* ]]; then
  report "mix-2: 精确层同窗口第二次仍拦(不受限次)" 1
else
  report "mix-2: 精确层同窗口第二次仍拦(不受限次)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 精确层 GREEN:同标签改 sonnet 就放行(证明拦的是档位,不是标签本身)
mix_reset
INPUT="$(build_script_input "agent('a',{label:'勘察',model:'sonnet'}); agent('b',{label:'judge',model:'fable'});")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && ! is_deny; then
  report "mix-3: 机械标签+sonnet -> allow" 1
else
  report "mix-3: 机械标签+sonnet -> allow" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 模糊层 RED:纯判断标签但零便宜档 -> 首次问
mix_reset
INPUT="$(build_script_input "agent('a',{label:'critique',model:'fable'}); agent('b',{label:'judge',model:'fable'});")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && is_deny && [[ "$GUARD_OUTPUT" == *"全无便宜档"* ]]; then
  report "mix-4: 零便宜档 -> 首次 deny" 1
else
  report "mix-4: 零便宜档 -> 首次 deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 模糊层限次:同窗口第二次必须放行(每次都问 = 墙纸 = 无脑点头)
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && ! is_deny; then
  report "mix-5: 零便宜档同窗口第二次 -> allow(限次生效)" 1
else
  report "mix-5: 零便宜档同窗口第二次 -> allow(限次生效)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 报账:放行时也必须打印(run_guard 合并 2>&1,故在 GUARD_OUTPUT 里)
mix_reset
INPUT="$(build_script_input "agent('a',{label:'scout',model:'sonnet',effort:'xhigh'});")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && ! is_deny && [[ "$GUARD_STDERR" == *"派工配比"* && "$GUARD_STDERR" == *"sonnet / xhigh"* ]]; then
  report "mix-6: 放行时仍打印配比报账(含 effort)" 1
else
  report "mix-6: 放行时仍打印配比报账(含 effort)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 回归(2026-08-06):静态解不出的 model 不得触发提问。
# 第一版把 '?' 当「非便宜档」,让既有用例 fp2(shorthand `{ model }`)从 allow 变 deny ——
# 违反本守卫开头写死的哲学「unresolvable 按设计放行;over-blocking gets guards disabled」。
# 更糟的是它让**整个套件的结果依赖外部状态文件是否存在**:有状态=84/0、无状态=83/1,
# 于是金丝雀里两次报红、单跑又复现不出 —— 一个会偶发的金丝雀项会训练出忽视,必须根治。
mix_reset
INPUT="$(build_script_input "const m='opus'; agent('a',{label:'judge',model:m});")"
run_guard "$GUARD_SCRIPT" "$INPUT"
if [ "$GUARD_EXIT" = "0" ] && ! is_deny; then
  report "mix-7: model 静态解不出 -> 不问(不 over-block)" 1
else
  report "mix-7: model 静态解不出 -> 不问(不 over-block)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

mix_reset
[ -n "$MIX_STAMP_BAK" ] && printf '%s' "$MIX_STAMP_BAK" > "$MIXSTAMP"

echo
echo "=================================================="
echo "Summary: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "=================================================="

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
