#!/usr/bin/env bash
# AxMem receipts — write-ahead memory receipts (WAMR). (P1 port, 2026-09-13)
# The auto-sedimentation core: deterministic facts (a structured user choice,
# a guard registration, a verbatim ruling) land as immutable per-session spool
# rows THE MOMENT they happen; saving covers them by watermark; the Stop hook
# blocks exactly one shutdown per session while receipts are pending. Stop is
# a per-turn point, not a session end — crash recovery rides the session-start
# lamp, not any end-of-session event.
# Design invariants (cross-model reviewed):
#   - receipts are verbatim/pointer only, never model summaries
#   - covering claims "sedimented" and needs a memory commit as evidence;
#     deliberate dismissal is its own honest lane (--dismiss)
#   - every shared append file is per-machine (synced-repo merge safety)
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib/prelude.sh"

RDIR="${AXMEM_RECEIPTS_DIR:-$AXMEM_MEMORY_DIR/receipts}"
SDIR="${AXMEM_RECEIPT_STATE_DIR:-$AXMEM_STATE_DIR}"
mkdir -p "$RDIR" 2>/dev/null || true
COVERED="$RDIR/covered-$AXMEM_MACHINE.tsv"

sid() { printf '%s' "${1:-$(axmem_session)}" | tr -cd 'A-Za-z0-9-' | cut -c1-16; }
esc() { printf '%s' "$1" | tr '\t\r\n' '   ' | cut -c1-800; }
esc_or_blob() { # $1=id $2=raw
  local raw="$2"
  if [ "${#raw}" -le 800 ]; then esc "$raw"; return; fi
  mkdir -p "$RDIR/blobs" 2>/dev/null || true
  printf '%s' "$raw" > "$RDIR/blobs/$1.txt" 2>/dev/null || true
  printf '%s ...[truncated->blobs/%s.txt]' "$(printf '%s' "$raw" | tr '\t\r\n' '   ' | cut -c1-720)" "$1"
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  add)  # add <kind> <ref> <note...>  — note stored verbatim (blob overflow)
    kind="${1:?kind}"; ref="${2:-"-"}"; shift 2 2>/dev/null || true
    s="$(sid)"; id="r$(date +%s)$RANDOM"
    note="$(esc_or_blob "$id" "${*:-}")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$(date +%FT%T)" "$s" "$kind" "$(esc "$ref")" "$note" >> "$RDIR/spool-$s.tsv"
    echo "$id"
    ;;
  from-hook)  # PostToolUse(AskUserQuestion): structured user choice, verbatim
    AXMEM_RECEIPTS_DIR_RESOLVED="$RDIR" AXMEM_RECEIPT_MACH="$AXMEM_MACHINE" \
      exec node "$(dirname "${BASH_SOURCE[0]}")/receipt-fromhook.cjs"
    ;;
  pending-rows)  # pure data, never truncated — the only source cover may use
    tmp_all="$(cat "$RDIR"/spool-*.tsv 2>/dev/null || true)"
    [ -z "$tmp_all" ] && exit 0
    cov="$(cat "$RDIR"/covered-*.tsv 2>/dev/null | cut -f1 || true)"
    printf '%s\n' "$tmp_all" | awk -F'\t' -v c="$cov" 'BEGIN{n=split(c,a,"\n");for(i=1;i<=n;i++)k[a[i]]=1} NF&&!k[$1]{print}'
    ;;
  pending)  # human display (count + first 20)
    n="$(bash "$0" pending-rows | grep -c . || true)"
    echo "$n"
    [ "$n" -gt 0 ] && bash "$0" pending-rows | cut -f1,4,5,6 | head -20
    ;;
  cover)  # cover --all | cover --dismiss --all|<id...> | cover <id...>
    mode="save"
    [ "${1:-}" = "--dismiss" ] && { mode="dismissed"; shift; }
    if [ "${1:-}" = "--all" ]; then ids="$(bash "$0" pending-rows | cut -f1)"; else ids="$*"; fi
    [ -z "$ids" ] && { echo "covered: 0"; exit 0; }
    if [ "$mode" = "save" ] && [ -z "${AXMEM_RECEIPTS_DIR:-}" ]; then
      oldest="$(bash "$0" pending-rows | cut -f2 | sort | head -1)"
      # Evidence must touch CONTENT files — a commit of the receipts spool
      # itself (or any unrelated memory path) must not satisfy the watermark.
      if ! git -C "$AXMEM_MEMORY_DIR" log -1 --since="$oldest" --format=%h -- \
           decisions.md lessons.md standinginstructions.md progress.md 2>/dev/null | grep -q .; then
        echo "REFUSED: no memory commit since the oldest pending receipt ($oldest). Save first, or use cover --dismiss for receipts that genuinely need no sedimentation." >&2
        exit 1
      fi
      via="save-$(git -C "$AXMEM_MEMORY_DIR" rev-parse --short HEAD 2>/dev/null || date +%F)"
    else
      via="$mode-$(date +%F)"
    fi
    for i in $ids; do printf '%s\t%s\t%s\n' "$i" "$(date +%FT%T)" "$via" >> "$COVERED"; done
    echo "covered: $(printf '%s' "$ids" | wc -w | tr -d ' ')"
    ;;
  stop-check)  # Stop hook: pending>0 -> block one shutdown per session
    # --no-block (P1 2.1, Hermes bridge, D8's ONE allowed core change): the
    # bridge has no blocking channel on on_session_end regardless (P1 wires
    # detect-and-correct only, never pre_tool_call-style blocking), so this
    # flag changes ONLY the final exit code below (2 -> 0) — every other
    # line, every determination (pending count, per-session nag stamp,
    # stop_hook_active short-circuit), and the stderr text are byte-for-byte
    # identical to the CC path. A caller that never passes --no-block sees
    # no behavior change whatsoever.
    no_block=0
    for a in "$@"; do [ "$a" = "--no-block" ] && no_block=1; done
    IN="$(cat 2>/dev/null || true)"
    printf '%s' "$IN" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0
    s="$(sid "$(printf '%s' "$IN" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')")"
    stamp="$SDIR/.axmem-receipt-nag-$s"
    [ -f "$stamp" ] && exit 0
    n="$(bash "$0" pending | head -1)"
    [ "${n:-0}" -gt 0 ] || exit 0
    date +%FT%T > "$stamp"
    echo "axmem: ${n} pending memory receipt(s) — raw facts recorded but not yet sedimented. Save them to memory then 'axmem receipt cover --all'; genuinely disposable ones: 'cover --dismiss --all'. (This session will only be interrupted once.)" >&2
    [ "$no_block" -eq 1 ] && exit 0
    exit 2
    ;;
  session-lamp)
    n="$(bash "$0" pending | head -1)"
    [ "${n:-0}" -gt 0 ] && echo "axmem: ${n} pending memory receipt(s) (possibly from earlier sessions) — 'axmem receipt pending' to inspect."
    exit 0
    ;;
  --self-test)
    T="$(mktemp -d)"
    export AXMEM_RECEIPTS_DIR="$T/r" AXMEM_RECEIPT_STATE_DIR="$T/s"
    mkdir -p "$T/s"
    ok=0
    id="$(AXMEM_SESSION_ID=selftest bash "$0" add test-kind ref1 "a test receipt")" || true
    [ "$(bash "$0" pending | head -1)" = "1" ] && ok=$((ok+1))
    printf '{"session_id":"selftest","stop_hook_active":false}' | bash "$0" stop-check 2>/dev/null; [ $? -eq 2 ] && ok=$((ok+1))
    printf '{"session_id":"selftest","stop_hook_active":false}' | bash "$0" stop-check 2>/dev/null; [ $? -eq 0 ] && ok=$((ok+1))
    bash "$0" cover "$id" >/dev/null
    [ "$(bash "$0" pending | head -1)" = "0" ] && ok=$((ok+1))
    printf '{"session_id":"x","stop_hook_active":true}' | bash "$0" stop-check; [ $? -eq 0 ] && ok=$((ok+1))
    # --no-block (P1 2.1, D8's one allowed core change): same determination
    # (pending>0, message on stderr, nag stamp written), exit code forced 0.
    id2="$(AXMEM_SESSION_ID=noblock bash "$0" add test-kind ref1 "a test receipt")" || true
    msg_block="$(printf '{"session_id":"noblock-a","stop_hook_active":false}' | bash "$0" stop-check 2>&1 >/dev/null)"
    rm -f "$T/s/.axmem-receipt-nag-noblock-a" 2>/dev/null
    msg_noblock="$(printf '{"session_id":"noblock-a","stop_hook_active":false}' | bash "$0" stop-check --no-block 2>&1 >/dev/null)"
    printf '{"session_id":"noblock-b","stop_hook_active":false}' | bash "$0" stop-check --no-block >/dev/null 2>&1; rc_noblock=$?
    [ "$rc_noblock" -eq 0 ] && [ "$msg_block" = "$msg_noblock" ] && [ -n "$msg_noblock" ] && ok=$((ok+1))
    bash "$0" cover "$id2" >/dev/null 2>&1
    for i in $(seq 1 25); do AXMEM_SESSION_ID=bulk bash "$0" add k r "n$i" >/dev/null; done
    bash "$0" cover --all >/dev/null
    [ "$(bash "$0" pending | head -1)" = "0" ] && ok=$((ok+1))
    rm -rf "$T"
    if [ "$ok" -eq 7 ]; then echo "receipt self-test 7/7"; exit 0; else echo "receipt self-test $ok/7 FAIL"; exit 1; fi
    ;;
  *)
    echo "usage: receipt.sh add|from-hook|pending|pending-rows|cover|stop-check|session-lamp|--self-test" >&2
    exit 1
    ;;
esac
