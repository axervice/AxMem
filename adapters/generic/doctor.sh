#!/usr/bin/env bash
# AxMem generic adapter doctor section. (P1 2.2, 2026-09-16)
# Checks: memory dir initialized, the configured instruction file's axmem
# fence is present, most recent canary timestamp, fixed enforcement string.
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$D/../.." && pwd)"
. "$ROOT/lib/prelude.sh"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  export AXMEM_STATE_DIR="$T/state" AXMEM_HOME="$T/home" AXMEM_MEMORY_DIR="$T/mem" AXMEM_CONFIG="$T/config.json"
  mkdir -p "$AXMEM_STATE_DIR" "$AXMEM_HOME"
  ok=0

  # 1: nothing set up -> reports "no" for dir-init and fence, no canary time
  printf '{"$schema_version":1,"adapters":{"generic":{"instruction_file":"%s/AGENT.md"}}}' "$T" > "$AXMEM_CONFIG"
  out1="$(bash "${BASH_SOURCE[0]}")"
  printf '%s' "$out1" | grep -q 'memory dir: not initialized' && printf '%s' "$out1" | grep -q 'fence: absent' && printf '%s' "$out1" | grep -q 'canary: never run' && ok=$((ok+1))

  # 2: after axmem init + wire -> dir-init and fence both present
  bash "$ROOT/bin/axmem" init >/dev/null 2>&1
  bash "$ROOT/adapters/generic/wire.sh" "$T/AGENT.md" >/dev/null 2>&1
  out2="$(bash "${BASH_SOURCE[0]}")"
  printf '%s' "$out2" | grep -q 'memory dir: initialized' && printf '%s' "$out2" | grep -q 'fence: present' && ok=$((ok+1))

  # 3: after a canary run -> most recent canary time reported (today's date)
  # [coordinator 2026-09-17] Previously ran the REAL `axmem canary`, whose
  # roster (core/canary.sh) includes a guard-fingerprint check and a
  # lesson-class-coverage check that both resolve $ROOT from BASH_SOURCE —
  # i.e. the ACTUAL repo checkout, never this test's own isolated
  # AXMEM_STATE_DIR fixture. That made this self-test's outcome depend on
  # the real repo's current guard/fingerprint state (observed transiently
  # red during unrelated concurrent edits to this same checkout) instead
  # of on anything generic/doctor.sh is actually responsible for.
  # generic/doctor.sh only ever READS the stamp file (see below) — it has
  # no dependency on how that stamp got there. core/canary.sh's OWN
  # --self-test already proves the canary MECHANISM in full isolation
  # (synthetic-must-fail/synthetic-must-pass); this test's only remaining
  # job is to prove doctor.sh's OWN stamp-reporting logic, so write the
  # stamp directly (the exact same resolution generic/doctor.sh itself
  # uses) instead of re-running the real canary end-to-end.
  _stamp="${AXMEM_CANARY_STAMP:-$AXMEM_STATE_DIR/canary-stamp}"
  date +%F > "$_stamp"
  out3="$(bash "${BASH_SOURCE[0]}")"
  today="$(date +%F)"
  printf '%s' "$out3" | grep -q "canary: $today" && ok=$((ok+1))

  # 4: fixed enforcement string always present
  printf '%s' "$out3" | grep -q 'enforcement=convention' && ok=$((ok+1))

  rm -rf "$T"
  if [ "$ok" -eq 4 ]; then echo "generic doctor self-test 4/4"; exit 0; else echo "generic doctor self-test $ok/4 FAIL"; exit 1; fi
fi

instr="$(axmem_cfg adapters.generic.instruction_file '')"
instr="${instr/#\~/$HOME}"

if [ -f "$AXMEM_MEMORY_DIR/decisions.md" ] && [ -f "$AXMEM_MEMORY_DIR/lessons.md" ]; then
  echo "generic: memory dir: initialized ($AXMEM_MEMORY_DIR)"
else
  echo "generic: memory dir: not initialized (run: axmem init)"
fi

if [ -n "$instr" ] && [ -f "$instr" ] && grep -q '<!-- axmem:begin -->' "$instr" 2>/dev/null && grep -q '<!-- axmem:end -->' "$instr" 2>/dev/null; then
  echo "generic: fence: present ($instr)"
elif [ -n "$instr" ]; then
  echo "generic: fence: absent ($instr — run: adapters/generic/wire.sh \"$instr\")"
else
  echo "generic: fence: absent (no adapters.generic.instruction_file configured)"
fi

STAMP="${AXMEM_CANARY_STAMP:-$AXMEM_STATE_DIR/canary-stamp}"
if [ -f "$STAMP" ]; then
  echo "generic: canary: $(cat "$STAMP")"
else
  echo "generic: canary: never run (run: axmem canary)"
fi

echo "generic: enforcement=convention"
exit 0
