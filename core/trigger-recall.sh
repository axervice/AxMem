#!/usr/bin/env bash
# AxMem trigger-recall wrapper. Hook mode: JSON on stdin. | --self-test
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  mkdir -p "$T/mem" "$T/state"
  printf '{"repos":[{"id":"home","roots":["%s/h"]},{"id":"app","roots":["%s/app"]}]}' "$T" "$T" > "$T/config.json"
  {
    printf '%s\n' '**2026-01-01 — lesson alpha** [test:alpha]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=guards/* -->'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-01-02 — lesson beta (exact path)** [test:beta]'
    printf '%s\n' '<!-- trigger: tool=Write; repo=app; path=.github/workflows/ci.yml -->'
    printf '%s\n' 'body'
  } > "$T/mem/lessons.md"
  : > "$T/mem/decisions.md"; : > "$T/mem/standinginstructions.md"
  run() { printf '%s' "$1" | AXMEM_CONFIG="$T/config.json" AXMEM_MEMORY_DIR="$T/mem" AXMEM_TRIGGER_STATE="$T/state" AXMEM_TRIGGER_LOG="$T/log.tsv" node "$D/trigger-recall.cjs"; }
  ok=0
  out="$(run "{\"session_id\":\"s1\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T/h/guards/x.sh\"}}")"
  printf '%s' "$out" | grep -q 'test:alpha' && ok=$((ok+1))                       # 1 prefix hit
  out="$(run "{\"session_id\":\"s1\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T/h/guards/y.sh\"}}")"
  [ -z "$out" ] && ok=$((ok+1))                                                    # 2 per-session dedupe
  out="$(run "{\"session_id\":\"s2\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$T/app/.claude/worktrees/w1/.github/workflows/ci.yml\"}}")"
  printf '%s' "$out" | grep -q 'test:beta' && ok=$((ok+1))                         # 3 worktree-root strip
  out="$(run "{\"session_id\":\"s3\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$T/elsewhere/.github/workflows/ci.yml\"}}")"
  [ -z "$out" ] && ok=$((ok+1))                                                    # 4 no basename fallback
  out="$(printf 'junk' | AXMEM_CONFIG="$T/config.json" AXMEM_MEMORY_DIR="$T/mem" AXMEM_TRIGGER_STATE="$T/state" AXMEM_TRIGGER_LOG="$T/log.tsv" node "$D/trigger-recall.cjs"; echo "rc=$?")"
  printf '%s' "$out" | grep -q 'rc=0' && ok=$((ok+1))                              # 5 fail-open
  grep -q "$(printf '\t')injected$(printf '\t')" "$T/log.tsv" && grep -q "$(printf '\t')wt-normalized$(printf '\t')" "$T/log.tsv" && ok=$((ok+1))  # 6 staged telemetry
  # 7 linked recall: a hit on alpha also surfaces [[test:gamma]] from its body,
  #   telemetered as injected-linked (separate calibration ledger)
  {
    printf '%s\n' '**2026-01-03 — lesson gamma (linked)** [test:gamma]'
    printf '%s\n' 'gamma body'
  } >> "$T/mem/lessons.md"
  node -e "
const fs=require('fs');const p=process.argv[1];
let s=fs.readFileSync(p,'utf8');
s=s.replace('body\n**2026-01-02','body linked [[test:gamma]]\n**2026-01-02');
fs.writeFileSync(p,s);" "$T/mem/lessons.md"
  out="$(run "{\"session_id\":\"s7\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T/h/guards/link.sh\"}}")"
  printf '%s' "$out" | grep -q 'test:alpha' && printf '%s' "$out" | grep -q 'linked.*\[test:gamma\]' && grep -q "injected-linked" "$T/log.tsv" && ok=$((ok+1))
  # 8 supersession + timeline: a trigger planted on an old entry pushes the
  #   chain head with provenance; telemetry stage superseded-redirect
  T2="$(mktemp -d)"; mkdir -p "$T2/mem" "$T2/state"
  printf '{"repos":[{"id":"home","roots":["%s/h"]}]}' "$T2" > "$T2/config.json"
  {
    printf '%s\n' '**2026-01-01 — lesson old** [test:old]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=guards/* -->'
    printf '%s\n' 'old body'
    printf '%s\n' '**2026-02-01 — lesson new (replaces old)** [test:new]'
    printf '%s\n' 'new body'
    printf '%s\n' 'Supersedes: [[test:old]]'
  } > "$T2/mem/lessons.md"
  : > "$T2/mem/decisions.md"; : > "$T2/mem/standinginstructions.md"
  out="$(printf '%s' "{\"session_id\":\"s8\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T2/h/guards/s.sh\"}}" | AXMEM_CONFIG="$T2/config.json" AXMEM_MEMORY_DIR="$T2/mem" AXMEM_TRIGGER_STATE="$T2/state" AXMEM_TRIGGER_LOG="$T2/log.tsv" node "$D/trigger-recall.cjs")"
  printf '%s' "$out" | grep -q 'test:new' && printf '%s' "$out" | grep -q 'supersedes \[test:old\]' && grep -q "superseded-redirect" "$T2/log.tsv" && ok=$((ok+1))
  # 9 archived trigger still redirects: old entry (with trigger) lives only in
  #   the archive; live holds its successor — the edit must push the successor
  T3="$(mktemp -d)"; mkdir -p "$T3/mem" "$T3/state"
  printf '{"repos":[{"id":"home","roots":["%s/h"]}]}' "$T3" > "$T3/config.json"
  {
    printf '%s\n' '**2026-01-01 — old (archived)** [test:aold]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=guards/* -->'
    printf '%s\n' 'archived body'
  } > "$T3/mem/lessons-archive.md"
  {
    printf '%s\n' '**2026-02-01 — new (live)** [test:anew]'
    printf '%s\n' 'live body'
    printf '%s\n' 'Supersedes: [[test:aold]]'
  } > "$T3/mem/lessons.md"
  : > "$T3/mem/decisions.md"; : > "$T3/mem/standinginstructions.md"
  out="$(printf '%s' "{\"session_id\":\"s9\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T3/h/guards/a.sh\"}}" | AXMEM_CONFIG="$T3/config.json" AXMEM_MEMORY_DIR="$T3/mem" AXMEM_TRIGGER_STATE="$T3/state" AXMEM_TRIGGER_LOG="$T3/log.tsv" node "$D/trigger-recall.cjs")"
  printf '%s' "$out" | grep -q 'test:anew' && grep -q "superseded-redirect" "$T3/log.tsv" && ok=$((ok+1))
  # 10 trust suffix: a header's [trust:...] marker (ratified vs. derived) must
  #   ride along in a REDIRECTED push (the tagTitle lookup path) — the
  #   receiving agent needs to know which kind of claim the chain head is.
  T4="$(mktemp -d)"; mkdir -p "$T4/mem" "$T4/state"
  printf '{"repos":[{"id":"home","roots":["%s/h"]}]}' "$T4" > "$T4/config.json"
  {
    printf '%s\n' '**2026-01-01 — lesson old** [test:told]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=guards/* -->'
    printf '%s\n' 'old body'
    printf '%s\n' '**2026-02-01 — lesson new (replaces old)** [test:tnew] [trust:user-ratified]'
    printf '%s\n' 'new body'
    printf '%s\n' 'Supersedes: [[test:told]]'
  } > "$T4/mem/lessons.md"
  : > "$T4/mem/decisions.md"; : > "$T4/mem/standinginstructions.md"
  out="$(printf '%s' "{\"session_id\":\"s10\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T4/h/guards/t.sh\"}}" | AXMEM_CONFIG="$T4/config.json" AXMEM_MEMORY_DIR="$T4/mem" AXMEM_TRIGGER_STATE="$T4/state" AXMEM_TRIGGER_LOG="$T4/log.tsv" node "$D/trigger-recall.cjs")"
  printf '%s' "$out" | grep -q 'test:tnew' && printf '%s' "$out" | grep -q '\[trust:user-ratified\]' && ok=$((ok+1))
  # 11 lesson-class taxonomy (hub hit): hitting a class hub's trigger pushes
  #   the hub plus its newest live members (stage=injected-class-member),
  #   filling whatever slots are left after the hub itself (cap 3 total).
  T5="$(mktemp -d)"; mkdir -p "$T5/mem" "$T5/state"
  printf '{"repos":[{"id":"home","roots":["%s/h"]}]}' "$T5" > "$T5/config.json"
  {
    printf '%s\n' '**2026-09-14 — Class: alpha** [class:alpha]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=hooks/* -->'
    printf '%s\n' 'Criterion: x'
  } > "$T5/mem/classes.md"
  {
    printf '%s\n' '**2026-01-01 — member old** [test:mem-old]'
    printf '%s\n' 'Class: [[class:alpha]]'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-02-01 — member new** [test:mem-new]'
    printf '%s\n' 'Class: [[class:alpha]]'
    printf '%s\n' 'body'
    printf '%s\n' '**2026-03-01 — member with own trigger** [test:mem-trig]'
    printf '%s\n' '<!-- trigger: tool=Edit|Write; repo=home; path=pmm-x.sh -->'
    printf '%s\n' 'Class: [[class:alpha]]'
    printf '%s\n' 'body'
  } > "$T5/mem/lessons.md"
  : > "$T5/mem/decisions.md"; : > "$T5/mem/standinginstructions.md"
  run5() { printf '%s' "$1" | AXMEM_CONFIG="$T5/config.json" AXMEM_MEMORY_DIR="$T5/mem" AXMEM_TRIGGER_STATE="$T5/state" AXMEM_TRIGGER_LOG="$T5/log.tsv" node "$D/trigger-recall.cjs"; }
  out="$(run5 "{\"session_id\":\"s11\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T5/h/hooks/h.sh\"}}")"
  printf '%s' "$out" | grep -q 'class:alpha' && printf '%s' "$out" | grep -q 'same class.*\[test:mem-trig\]' && grep -q "injected-class-member" "$T5/log.tsv" && ok=$((ok+1))
  # 12 lesson-class taxonomy (member hit): hitting a MEMBER's own trigger must
  #   only report "same class N more" on its own line — no extra slot spent,
  #   no full class text pushed.
  out="$(run5 "{\"session_id\":\"s12\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$T5/h/pmm-x.sh\"}}")"
  printf '%s' "$out" | grep -q 'test:mem-trig.*same class \[class:alpha\] 2 more' && ok=$((ok+1))
  rm -rf "$T5" "$T4" "$T3" "$T2" "$T"
  if [ "$ok" -eq 12 ]; then echo "trigger-recall self-test 12/12"; exit 0; else echo "trigger-recall self-test $ok/12 FAIL"; exit 1; fi
fi
exec node "$D/trigger-recall.cjs" "$@"
