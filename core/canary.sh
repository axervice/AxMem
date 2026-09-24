#!/usr/bin/env bash
# AxMem guard-canary — the meta-guard. (P1 template, 2026-09-13)
# A guard's #1 cause of death is silent death — a dead guard is worse than
# none, because it reads as coverage. The canary feeds every registered guard
# a known input on a schedule and turns silence into noise.
# Contract:
#   - the roster IS the registry: a guard not listed here does not exist
#   - a guard cannot enter the roster without a --self-test that proves it
#     can go red AND green (unproven invariants are wallpaper)
#   - all green -> stamp; any red -> exit 1, no stamp (freshness lamp stays lit)
#   - the executed count is asserted against the roster length, so a gutted
#     roster can never report green (audited failure mode)
# Roster source: config `canary.roster` = [{name, cmd}] — cmd runs via bash -c
# with AXMEM_* env exported. Default roster = every core self-test.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib/prelude.sh"
ROOT="$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")"
STAMP="${AXMEM_CANARY_STAMP:-$AXMEM_STATE_DIR/canary-stamp}"

pass=0; fail=0; report=""
run() {
  local name="$1"; shift
  local t0=$SECONDS
  if bash -c "$*" >/dev/null 2>&1; then
    pass=$((pass+1)); report="${report}  ok   ${name} ($((SECONDS-t0))s)\n"
  else
    fail=$((fail+1)); report="${report}  FAIL ${name} <- guard dead or self-test red, investigate now\n"
  fi
}

if [ "${1:-}" = "--self-test" ]; then
  run "synthetic-must-fail" false
  run "synthetic-must-pass" true
  printf "%b" "$report"
  if [ "$fail" -eq 1 ] && [ "$pass" -eq 1 ]; then echo "canary runner can go red and green"; exit 0
  else echo "canary runner BROKEN: fail=$fail pass=$pass (want 1/1)"; exit 1; fi
fi

# default roster: every core component that carries a self-test
declare -a NAMES CMDS
n=0
for s in "$ROOT"/core/*.sh; do
  grep -q -- '--self-test' "$s" || continue
  NAMES[$n]="$(basename "$s" .sh) self-test"; CMDS[$n]="bash '$s' --self-test"
  n=$((n+1))
done
# Guard-code fingerprint check: distinct from fingerprint.sh's own --self-test
# above (which only proves the roster MECHANISM can go red/green on synthetic
# fixtures) — this runs `check` against the REAL roster committed at
# FINGERPRINTS.tsv, so an undocumented edit to any guard file goes red here
# instead of shipping silently. Registered the same way core/*.sh --self-test
# entries are (an absolute path baked into CMDS at array-build time, so it
# works with no config.json and no exported env for the bash -c subshell).
NAMES[$n]="guard-fingerprint check"; CMDS[$n]="bash '$ROOT/core/fingerprint.sh' check"
n=$((n+1))
# Lesson-class coverage: asserts on manifest --json's COUNTS (unclassifiedLessons
# === 0 and classes >= 1), never by counting lines — a line count is exactly
# what a two-Class-lines-on-one-entry plus a zero-Class-lines-on-another pair
# would balance out to a false green on.
NAMES[$n]="lesson-class coverage (classes.md controlled vocabulary)"; CMDS[$n]="node '$ROOT/core/manifest.cjs' --json | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);process.exit(j.counts.unclassifiedLessons===0&&j.counts.classes>=1?0:1)})'"
n=$((n+1))
# config roster extends (not replaces) the default
extra="$(node "$ROOT/lib/prelude.cjs" get canary.roster '[]')"
if [ "$extra" != "[]" ] && [ -n "$extra" ]; then
  while IFS=$'\t' read -r nm cm; do
    [ -z "$nm" ] && continue
    NAMES[$n]="$nm"; CMDS[$n]="$cm"; n=$((n+1))
  done < <(printf '%s' "$extra" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{for(const r of JSON.parse(s)) if(r&&r.name&&r.cmd) console.log(r.name+"\t"+r.cmd);}catch{}
    });')
fi
EXPECTED=$n

echo "axmem canary $(date +%F): roster=$EXPECTED"
i=0
while [ $i -lt $n ]; do run "${NAMES[$i]}" "${CMDS[$i]}"; i=$((i+1)); done
printf "%b" "$report"
if [ "$((pass+fail))" -ne "$EXPECTED" ]; then
  fail=$((fail+1)); echo "  FAIL executed $((pass+fail-1)) != roster $EXPECTED (gutted roster?)"
fi
if [ "$fail" -gt 0 ]; then
  echo "canary: ${fail} FAILURE(S) — stamp NOT written; the freshness lamp stays lit until green."
  exit 1
fi
date +%F > "$STAMP"
echo "canary: ${pass}/${EXPECTED} all green — stamp updated"
