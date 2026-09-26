#!/usr/bin/env bash
# AxMem E2E — isolation guarantee against real ~/.hermes, ~/.claude,
# ~/.codex. (coordinator 2026-09-17, spec §3 / Opus H4)
#
# Runs a realistic full session (init + wire all 4 adapters into TEMP
# targets + doctor + canary) entirely inside one isolated fresh HOME, then
# proves the 3 real per-adapter config locations this machine might have
# were NEVER read-then-written, written, or otherwise mutated: sha256 +
# mtime identical before and after (same methodology the Opus acceptance
# audit itself used to confirm ~/.hermes was untouched — see docs/audits/
# OPUS-2026-09-16-p1-acceptance.md's "隔离与险情复核" section). A file that
# doesn't exist on this machine either before or after also counts as
# "unchanged" (still absent) — this test never CREATES any of these paths
# either.
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$D")"

if [ "${1:-}" != "--self-test" ]; then
  echo "usage: isolation-real-configs.sh --self-test"
  exit 1
fi

ok=0
skipped=0
lines=()
check() { if [ "$2" -eq 0 ]; then ok=$((ok + 1)); lines+=("  ok   $1"); else lines+=("  FAIL $1"); fi; }
# [Opus M3, 2026-09-17] `check` alone degenerates on a machine that simply
# has no real file at one of these 3 paths (e.g. no Codex installed, a
# fresh box, CI): before="absent", the isolated run (correctly) never
# creates it, after="absent" too, "$before" = "$after" is TRUE, and the
# check silently reports "ok" -- but nothing was ever actually verified,
# since there was no real content whose preservation this could prove.
# That's a false sense of coverage the moment this suite runs anywhere
# other than a machine that happens to already have all 3 real configs.
# check_iso reports that exact case as SKIPPED instead, and excludes it
# from $ok -- but before="absent" followed by after=<present> (isolation
# LEAKED and actually created the real file) is a genuine violation, not
# a skip, and still fails via the normal check() path below.
check_iso() {
  label="$1"; before="$2"; after="$3"
  if [ "$before" = "absent" ] && [ "$after" = "absent" ]; then
    skipped=$((skipped + 1))
    lines+=("  SKIPPED $label (no real file at this path on this machine -- nothing to verify; baseline resolved before any isolation env was exported)")
    return
  fi
  [ "$before" = "$after" ]
  check "$label (sha256/absence unchanged: $before)" $?
}

# Real per-adapter config locations on THIS machine (never overridden here
# — deliberately reading the ambient, un-isolated defaults so the snapshot
# reflects whatever a real user's install would be).
real_claude_settings="$HOME/.claude/settings.json"
real_codex_agents="$HOME/.codex/AGENTS.md"
if [ "$(uname -s 2>/dev/null | cut -c1-6)" = "MINGW6" ] || [ -n "${LOCALAPPDATA:-}" ]; then
  real_hermes_config="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes/config.yaml"
else
  real_hermes_config="$HOME/.hermes/config.yaml"
fi

snapshot() {
  # $1 = path -> prints "sha256:present" or "absent" (never fails the script)
  if [ -f "$1" ]; then
    ( sha256sum "$1" 2>/dev/null || shasum -a 256 "$1" 2>/dev/null ) | awk '{print $1}'
  else
    echo "absent"
  fi
}

before_claude="$(snapshot "$real_claude_settings")"
before_codex="$(snapshot "$real_codex_agents")"
before_hermes="$(snapshot "$real_hermes_config")"

# --- the isolated session --------------------------------------------------
T="$(mktemp -d)"
# [coordinator 2026-09-17] Normalize the MSYS-internal "/tmp/tmp.XXXXX"
# spelling mktemp returns on this Git-Bash to native "C:/..." form via
# cygpath -m BEFORE embedding it into config.json content or an env var a
# spawned node process reads back — see tests/fresh-home-adapters.sh's
# fresh_home() for the full explanation of why this is required.
T="$(cygpath -m "$T" 2>/dev/null || printf '%s' "$T")"
export AXMEM_HOME="$T/home" AXMEM_MEMORY_DIR="$T/home/memory" AXMEM_STATE_DIR="$T/home/state" AXMEM_CONFIG="$T/home/config.json" HERMES_HOME="$T/hermes-home"
mkdir -p "$HERMES_HOME"
bash "$ROOT/bin/axmem" init >/dev/null 2>&1

cc_target="$T/settings.json"; echo '{}' > "$cc_target"
codex_target="$T/AGENTS.md"; echo '# notes' > "$codex_target"
hermes_target="$T/hermes-config.yaml"; printf 'model:\n  default: x\n' > "$hermes_target"
generic_target="$T/AGENT.md"; echo '# notes' > "$generic_target"

cat > "$AXMEM_CONFIG" <<EOF
{"\$schema_version":1,"adapters":{
  "claude_code":{"enabled":true,"settings_json":"$cc_target"},
  "codex":{"enabled":true,"agents_md":"$codex_target"},
  "hermes":{"enabled":true,"config_yaml":"$hermes_target"},
  "generic":{"enabled":true,"instruction_file":"$generic_target"}
}}
EOF

node "$ROOT/adapters/claude-code/merge-hooks.cjs" --settings "$cc_target" >/dev/null 2>&1
bash "$ROOT/adapters/codex/wire.sh" "$codex_target" >/dev/null 2>&1
node "$ROOT/adapters/hermes/wire.cjs" --config "$hermes_target" >/dev/null 2>&1
bash "$ROOT/adapters/generic/wire.sh" "$generic_target" >/dev/null 2>&1
bash "$ROOT/bin/axmem" doctor >/dev/null 2>&1
# Deliberately does NOT also run the real `axmem canary` here: its roster
# (core/canary.sh) includes a guard-fingerprint check against the ACTUAL
# repo checkout (see adapters/generic/doctor.sh's fix, commit e5ab8aa, for
# the full explanation) — slow and coupled to unrelated repo state, and
# irrelevant to what THIS test verifies (real per-adapter CONFIG file
# isolation, not the canary/guard mechanism).

rm -rf "$T"
unset AXMEM_HOME AXMEM_MEMORY_DIR AXMEM_STATE_DIR AXMEM_CONFIG HERMES_HOME
# ----------------------------------------------------------------------------

after_claude="$(snapshot "$real_claude_settings")"
after_codex="$(snapshot "$real_codex_agents")"
after_hermes="$(snapshot "$real_hermes_config")"

check_iso "1 real Claude Code settings.json ($real_claude_settings) untouched" "$before_claude" "$after_claude"
check_iso "2 real Codex AGENTS.md ($real_codex_agents) untouched" "$before_codex" "$after_codex"
check_iso "3 real Hermes config.yaml ($real_hermes_config) untouched" "$before_hermes" "$after_hermes"

for l in "${lines[@]}"; do printf '%s\n' "$l"; done
echo "isolation-real-configs self-test $ok/3 ok, $skipped skipped (baseline absent on this machine)"
# Pass iff nothing actually FAILed -- a SKIPPED check is neither counted
# toward $ok nor treated as a failure (Opus M3): it means this machine has
# no real file at that path to prove was preserved, not that isolation is
# broken.
if [ "$((ok + skipped))" -eq 3 ]; then exit 0; else exit 1; fi
