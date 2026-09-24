#!/usr/bin/env bash
#
# Self-test for guards/agent-model-guard.sh
#
# Covers, per contract:
#   1. Red   -- inputs that MUST be denied
#   2. Green -- inputs that MUST be allowed (silent, exit 0)
#   3. Mutation -- weaken the guard's core check and prove the Red
#                  assertions actually flip (i.e. the test is not a tautology)
#   4. Wiring -- canary check that settings.json actually wires this guard
#                as a PreToolUse hook with matcher "Agent"
#
# Every case prints PASS/FAIL. Any FAIL => the script exits 1.
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_SCRIPT="${SCRIPT_DIR}/agent-model-guard.sh"
# contract v2.26 home_literal_scan (2026-09-23, A5): the default settings.json path used to hardcode
# 'C:/Users/<user>' -- correct only on one machine. settings.json is a git-tracked file at a FIXED
# on-disk location (guards/ is always <repo>/.claude/guards, so two levels up from SCRIPT_DIR IS the
# repo root) -- NOT wherever HOME/USERPROFILE happen to be redirected to for THIS self-test run.
# Measured: deriving this from pmm-home.sh's PMM_HOME_RESOLVED (which follows PMM_HOME > USERPROFILE >
# HOME > os.homedir()) broke the wiring check under a redirected-HOME-only run (15/16, not 16/16) --
# the same class of bug HIGH-1 fixed in the hook itself, just reintroduced one layer up. cygpath -m
# converts to Windows form before handing to native (non-MSYS-aware) node.exe as argv, which never
# translates a POSIX-style path.
REAL_TREE_HOME="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SETTINGS_JSON_DEFAULT="$(cygpath -m "$REAL_TREE_HOME" 2>/dev/null || printf '%s' "$REAL_TREE_HOME")/.claude/settings.json"
SETTINGS_JSON="${CLAUDE_SETTINGS_JSON_OVERRIDE:-$SETTINGS_JSON_DEFAULT}"

PASS_COUNT=0
FAIL_COUNT=0

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

# run_guard <script> <json-input> [env-model-value]
# Sets globals GUARD_OUTPUT / GUARD_EXIT.
run_guard() {
  local script="$1" input="$2" env_model="${3:-}"
  if [ -n "$env_model" ]; then
    GUARD_OUTPUT="$(printf '%s' "$input" | CLAUDE_CODE_SUBAGENT_MODEL="$env_model" bash "$script" 2>&1)"
  else
    GUARD_OUTPUT="$(printf '%s' "$input" | env -u CLAUDE_CODE_SUBAGENT_MODEL bash "$script" 2>&1)"
  fi
  GUARD_EXIT=$?
}

is_deny() {
  [[ "$GUARD_OUTPUT" == *'"permissionDecision":"deny"'* ]]
}

echo "=================================================="
echo "Red cases (must be denied)"
echo "=================================================="

# 1. missing model field
run_guard "$GUARD_SCRIPT" '{"tool_name":"Agent","tool_input":{}}'
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "red: missing model field -> deny" 1
else
  report "red: missing model field -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 2. empty string model
run_guard "$GUARD_SCRIPT" '{"tool_name":"Agent","tool_input":{"model":""}}'
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "red: model=\"\" -> deny" 1
else
  report "red: model=\"\" -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 3. model = "inherit" (lowercase)
run_guard "$GUARD_SCRIPT" '{"tool_name":"Agent","tool_input":{"model":"inherit"}}'
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "red: model=\"inherit\" -> deny" 1
else
  report "red: model=\"inherit\" -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 3b. model = "INHERIT" (case-insensitivity)
run_guard "$GUARD_SCRIPT" '{"tool_name":"Agent","tool_input":{"model":"INHERIT"}}'
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "red: model=\"INHERIT\" (case-insensitive) -> deny" 1
else
  report "red: model=\"INHERIT\" (case-insensitive) -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 3c. non-string model shapes -> deny. Regression cases for a real defect:
# the original negative-condition form (missing || empty || inherit) only ever
# tested `typeof model === 'string'`, so a number/object/array/boolean fell
# through ALL three conditions and was silently ALLOWED. The guard now uses a
# positive validity check, so these must deny.
for bad in '123' '{"a":1}' '["sonnet"]' 'true' 'null'; do
  run_guard "$GUARD_SCRIPT" "{\"tool_name\":\"Agent\",\"tool_input\":{\"model\":${bad}}}"
  if [ "$GUARD_EXIT" = "0" ] && is_deny; then
    report "red: non-string model=${bad} -> deny" 1
  else
    report "red: non-string model=${bad} -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
  fi
done

# 4. valid model but CLAUDE_CODE_SUBAGENT_MODEL env var set -> deny
run_guard "$GUARD_SCRIPT" '{"tool_name":"Agent","tool_input":{"model":"sonnet"}}' "opus"
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "red: valid model + CLAUDE_CODE_SUBAGENT_MODEL set -> deny" 1
else
  report "red: valid model + CLAUDE_CODE_SUBAGENT_MODEL set -> deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

# 5. corrupted JSON -> fail-closed deny (never silently allow)
run_guard "$GUARD_SCRIPT" '{"tool_name":"Agent","tool_input":{'
if [ "$GUARD_EXIT" = "0" ] && is_deny; then
  report "red: corrupted JSON -> fail-closed deny" 1
else
  report "red: corrupted JSON -> fail-closed deny" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
fi

echo
echo "=================================================="
echo "Green cases (must be allowed: silent stdout, exit 0)"
echo "=================================================="

for m in sonnet opus haiku; do
  run_guard "$GUARD_SCRIPT" "{\"tool_name\":\"Agent\",\"tool_input\":{\"model\":\"${m}\"}}"
  if [ "$GUARD_EXIT" = "0" ] && [ -z "$GUARD_OUTPUT" ]; then
    report "green: model=\"$m\" -> allow (silent)" 1
  else
    report "green: model=\"$m\" -> allow (silent)" 0 "exit=$GUARD_EXIT output=$GUARD_OUTPUT"
  fi
done

echo
echo "=================================================="
echo "Mutation test (canary: prove the Red assertions can actually fail)"
echo "=================================================="

MUTANT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-model-guard-mutant.XXXXXX")"
MUTANT_SCRIPT="${MUTANT_DIR}/agent-model-guard.mutant.sh"
cp "$GUARD_SCRIPT" "$MUTANT_SCRIPT"

# Weaken the guard's core invariant check: disable the model-validity branch
# entirely (`if (false) {`).
# ⚠️ COUPLING: this sed must match the guard's actual `if (...)` line verbatim.
# If the guard's core check is ever reworded, update this pattern IN THE SAME
# CHANGE — otherwise the mutation silently no-ops and this canary degrades into
# "mutation setup broken" (an instance of [process:guard-is-also-a-defect-instance]).
sed -i 's/if (!modelValid) {/if (false) {/' "$MUTANT_SCRIPT"

if grep -qF 'if (false) {' "$MUTANT_SCRIPT"; then
  # Re-run two of the Red cases against the mutant. If the mutation is
  # real, these MUST now come back as allow (not deny) -- i.e. the
  # original Red assertion would flip from PASS to FAIL against this
  # mutant, proving the test suite is actually sensitive to the guard's
  # behavior and not a tautology.
  run_guard "$MUTANT_SCRIPT" '{"tool_name":"Agent","tool_input":{}}'
  MUTANT_MISSING_STILL_DENIES=$( [ "$GUARD_EXIT" = "0" ] && is_deny && echo 1 || echo 0 )

  run_guard "$MUTANT_SCRIPT" '{"tool_name":"Agent","tool_input":{"model":"inherit"}}'
  MUTANT_INHERIT_STILL_DENIES=$( [ "$GUARD_EXIT" = "0" ] && is_deny && echo 1 || echo 0 )

  if [ "$MUTANT_MISSING_STILL_DENIES" = "0" ] && [ "$MUTANT_INHERIT_STILL_DENIES" = "0" ]; then
    report "mutation: weakened guard flips Red cases to allow (test is sensitive)" 1
  else
    report "mutation: weakened guard flips Red cases to allow (test is sensitive)" 0 \
      "mutant still denied at least one case (missing_denies=$MUTANT_MISSING_STILL_DENIES inherit_denies=$MUTANT_INHERIT_STILL_DENIES) -- mutation had no effect, test may be tautological"
  fi
else
  report "mutation: sed successfully patched mutant script" 0 "sed pattern not found in $MUTANT_SCRIPT -- mutation setup itself is broken"
fi

rm -rf "$MUTANT_DIR"

echo
echo "=================================================="
echo "Wiring check (canary: is this guard actually hooked up?)"
echo "=================================================="

if [ ! -f "$SETTINGS_JSON" ]; then
  report "wiring: settings.json exists and wires PreToolUse matcher=Agent -> this guard" 0 \
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
      if (!entry || String(entry.matcher || "").split("|").indexOf("Agent") === -1 || !Array.isArray(entry.hooks)) continue; // A6 2026-08-20: matcher 可为单独或 "Agent|Workflow"(经 model-guard.sh 分发)
      for (const h of entry.hooks) {
        const cmd = (h && typeof h.command === "string") ? h.command : "";
        if (cmd.replace(/\\\\/g, "/").toLowerCase().match(/agent-model-guard.sh|(^|[/])model-guard.sh/)) { // A6: 直连或经分发器都算接线
          found = true;
        }
      }
    }
    console.log(found ? "WIRED" : "NOT_WIRED: no hooks.PreToolUse entry with matcher=\"Agent\" pointing at agent-model-guard.sh");
  ' "$SETTINGS_JSON")"

  if [[ "$WIRING_CHECK" == WIRED* ]]; then
    report "wiring: settings.json wires PreToolUse matcher=Agent -> this guard" 1
  else
    report "wiring: settings.json wires PreToolUse matcher=Agent -> this guard" 0 "$WIRING_CHECK"
  fi
fi

echo
echo "=================================================="
echo "Summary: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "=================================================="

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
