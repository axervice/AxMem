#!/usr/bin/env bash
# AxMem E2E — fresh-HOME wiring, one full isolated HOME per adapter.
# (coordinator 2026-09-17, Opus H4 / ts M4)
#
# Gap this closes: each adapter's own self-test proves ITS wiring logic in
# isolation, but nothing in the repo drove the REAL end-to-end path — a
# genuinely fresh HOME (nothing pre-existing, matching what a brand-new
# `axmem init` user sees) -> wire ONE adapter -> `axmem doctor` reports it
# correctly — for all 4 adapters (claude_code, codex, hermes, generic).
#
# NEVER touches real ~/.hermes, ~/.claude, ~/.codex: every adapter target
# here is a fresh file inside this test's own mktemp -d, and AXMEM_HOME/
# AXMEM_STATE_DIR/AXMEM_MEMORY_DIR/AXMEM_CONFIG are all redirected into it
# before anything runs. HERMES_HOME is also redirected for the hermes case
# so adapters/hermes/doctor.cjs's own live-smoke-test leg (which shells out
# to the real bridge.cjs) never resolves to a real Hermes install either.
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$D")"

if [ "${1:-}" != "--self-test" ]; then
  echo "usage: fresh-home-adapters.sh --self-test"
  exit 1
fi

ok=0
lines=()
check() { if [ "$2" -eq 0 ]; then ok=$((ok + 1)); lines+=("  ok   $1"); else lines+=("  FAIL $1"); fi; }

# Runs `axmem init` in a brand-new isolated HOME and exports the 4 AXMEM_*
# env vars for the CURRENT shell (sets the global $T, not a subshell) — must
# be called as a plain statement (`fresh_home`), never as
# `T="$(fresh_home)"`, since command substitution runs in a subshell and
# `export` there would never reach back into this script's own environment.
fresh_home() {
  T="$(mktemp -d)"
  # [coordinator 2026-09-17] mktemp -d on this Git-Bash resolves to the
  # MSYS-internal "/tmp/tmp.XXXXX" spelling, NOT the native
  # "C:/Users/.../AppData/Local/Temp/..." path — MSYS auto-translates a
  # POSIX-looking path when it's passed as a direct argv to a native .exe
  # (which is why e.g. `node "$T/x"` on the command line works fine), but
  # that translation does NOT happen for a path embedded in FILE CONTENT
  # (like a value written into config.json here) or read back from an env
  # var by a native binary — Node then sees the literal string "/tmp/..."
  # and fails to resolve it (observed: doctor.cjs reporting
  # config_yaml "present=false" for a file that demonstrably existed).
  # Normalize once, immediately, to the native "C:/..." spelling via
  # cygpath -m so every later use (bash path tests, JSON file content,
  # env vars a spawned node process reads back) is consistent.
  T="$(cygpath -m "$T" 2>/dev/null || printf '%s' "$T")"
  mkdir -p "$T/home"
  export AXMEM_HOME="$T/home" AXMEM_MEMORY_DIR="$T/home/memory" AXMEM_STATE_DIR="$T/home/state" AXMEM_CONFIG="$T/home/config.json"
  bash "$ROOT/bin/axmem" init >/dev/null 2>&1
}

write_config() {
  # $1 = temp root, $2..$n = raw adapters-object JSON body (no braces)
  cat > "$AXMEM_CONFIG" <<EOF
{"\$schema_version":1,"adapters":{$2}}
EOF
}

# --- 1: claude_code -------------------------------------------------------
# Calls the SAME per-entry identity check `axmem doctor` itself uses (see
# bin/axmem's `doctor)` case) directly, rather than the whole `axmem
# doctor` command — that command also re-runs 5 unrelated core self-tests
# plus hermes's own live smoke test every time, which made this fixture
# needlessly slow (4 adapters x full doctor). Verifying the exact same
# check bin/axmem doctor performs is equally faithful to "doctor reports
# wired", just without the unrelated overhead.
{
  fresh_home
  target="$T/settings.json"
  echo '{}' > "$target"
  write_config "$T" "\"claude_code\":{\"enabled\":true,\"settings_json\":\"$target\"}"
  node "$ROOT/adapters/claude-code/merge-hooks.cjs" --settings "$target" >/dev/null 2>&1
  node -e "
    const m = require(process.argv[1]);
    const rows = m.verifyWiring(process.argv[2]);
    process.exit(rows.every(r => r.ok) ? 0 : 1);
  " "$ROOT/adapters/claude-code/merge-hooks.cjs" "$target"
  check "1 claude_code: fresh HOME -> wire -> per-entry identity check reports wired" $?
  rm -rf "$T"
  unset AXMEM_HOME AXMEM_MEMORY_DIR AXMEM_STATE_DIR AXMEM_CONFIG
}

# --- 2: codex ---------------------------------------------------------------
# codex has no dedicated doctor.cjs/doctor.sh — `axmem doctor` itself just
# greps the target file for both fence markers (see bin/axmem's `doctor)`
# case); replicated directly here for the same reason as test 1 above.
{
  fresh_home
  target="$T/AGENTS.md"
  echo '# pre-existing agent notes' > "$target"
  write_config "$T" "\"codex\":{\"enabled\":true,\"agents_md\":\"$target\"}"
  bash "$ROOT/adapters/codex/wire.sh" "$target" >/dev/null 2>&1
  grep -q '<!-- axmem:begin -->' "$target" 2>/dev/null && grep -q '<!-- axmem:end -->' "$target" 2>/dev/null
  check "2 codex: fresh HOME -> wire -> fence markers present" $?
  rm -rf "$T"
  unset AXMEM_HOME AXMEM_MEMORY_DIR AXMEM_STATE_DIR AXMEM_CONFIG
}

# --- 3: hermes ---------------------------------------------------------------
# Calls adapters/hermes/doctor.cjs directly (what `axmem doctor` itself
# shells out to for the hermes section) instead of the whole `axmem
# doctor` — same reasoning as test 1. This still exercises doctor.cjs's
# own live-smoke-test leg (a real bridge.cjs child process), just without
# also re-running the 5 core self-tests + the other 3 adapters' checks.
{
  fresh_home
  target="$T/hermes-config.yaml"
  printf 'model:\n  default: x\n' > "$target"
  write_config "$T" "\"hermes\":{\"enabled\":true,\"config_yaml\":\"$target\"}"
  # HERMES_HOME redirected too: adapters/hermes/doctor.cjs's live-smoke-test
  # leg shells out to bridge.cjs regardless of config_yaml, and must never
  # be able to resolve a real ~/.hermes even transitively.
  export HERMES_HOME="$T/hermes-home"
  mkdir -p "$HERMES_HOME"
  node "$ROOT/adapters/hermes/wire.cjs" --config "$target" >/dev/null 2>&1
  out="$(node "$ROOT/adapters/hermes/doctor.cjs" 2>&1)"
  printf '%s' "$out" | grep -q 'hermes: status=configured\|hermes: status=approved'
  check "3 hermes: fresh HOME -> wire -> doctor.cjs reports configured/approved" $?
  rm -rf "$T"
  unset AXMEM_HOME AXMEM_MEMORY_DIR AXMEM_STATE_DIR AXMEM_CONFIG HERMES_HOME
}

# --- 4: generic ---------------------------------------------------------------
{
  fresh_home
  target="$T/AGENT.md"
  echo '# pre-existing instructions' > "$target"
  write_config "$T" "\"generic\":{\"enabled\":true,\"instruction_file\":\"$target\"}"
  bash "$ROOT/adapters/generic/wire.sh" "$target" >/dev/null 2>&1
  out="$(bash "$ROOT/adapters/generic/doctor.sh" 2>&1)"
  printf '%s' "$out" | grep -q "fence: present ($target)"
  check "4 generic: fresh HOME -> wire -> doctor reports fence present" $?
  rm -rf "$T"
  unset AXMEM_HOME AXMEM_MEMORY_DIR AXMEM_STATE_DIR AXMEM_CONFIG
}

# --- 5: configured (non-default) state_dir must be honored end-to-end ------
# (Opus H1) lib/fence.cjs used to hand-roll its OWN state-dir resolution
# (env-only, no config.json, no MSYS normalization) instead of reusing
# lib/prelude.cjs's resolveStateDir(). A config.json with `state_dir` SET
# to a non-default location wrote the fence correctly but recorded
# lifecycle.json at the WRONG (default) location — `axmem uninstall`
# could never find its own manifest entry (rc 3 "no manifest entry"),
# permanently stranding the fence with no documented way to remove it.
{
  fresh_home
  # fresh_home() exports AXMEM_STATE_DIR itself (env wins over
  # config.json in the resolution chain, by design) — must unset it here
  # so this test actually exercises config.json's `state_dir` key, the
  # thing it's meant to prove, rather than trivially passing because the
  # env var happened to already point somewhere consistent.
  unset AXMEM_STATE_DIR
  configured_state_dir="$T/custom-state-dir"
  target="$T/AGENTS5.md"
  echo '# pre-existing agent notes' > "$target"
  cat > "$AXMEM_CONFIG" <<EOF
{"\$schema_version":1,"state_dir":"$configured_state_dir","adapters":{"codex":{"enabled":true,"agents_md":"$target"}}}
EOF
  bash "$ROOT/adapters/codex/wire.sh" "$target" >/dev/null 2>&1
  manifest_at_configured=1
  [ -f "$configured_state_dir/lifecycle.json" ] || manifest_at_configured=0
  bash "$ROOT/bin/axmem" uninstall --adapter codex >/dev/null 2>&1
  uninstall_rc=$?
  fence_removed=1
  grep -q '<!-- axmem:begin -->' "$target" 2>/dev/null && fence_removed=0
  [ "$manifest_at_configured" -eq 1 ] && [ "$uninstall_rc" -eq 0 ] && [ "$fence_removed" -eq 1 ]
  check "5 (Opus H1) config.json state_dir honored by fence.cjs -> lifecycle.json at configured dir -> axmem uninstall succeeds, fence removed" $?
  rm -rf "$T"
  unset AXMEM_HOME AXMEM_MEMORY_DIR AXMEM_STATE_DIR AXMEM_CONFIG
}

for l in "${lines[@]}"; do printf '%s\n' "$l"; done
echo "fresh-home-adapters self-test $ok/5"
if [ "$ok" -eq 5 ]; then exit 0; else exit 1; fi
