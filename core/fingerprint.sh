#!/usr/bin/env bash
# AxMem guard-code fingerprint roster. (P1 port, 2026-09-14)
# Root cause this guards against: guard scripts sync alongside memory over
# git, so memory write access is close to cross-machine code persistence
# authority — a drift check that only says "live != backup" never says WHO
# is the truth. Editing a guard with nobody noticing is the cheapest attack.
# Mechanism: the roster records each guard file's sha256; `check` turns any
# fingerprint change / addition / removal into red. The only legal change
# path is `refresh "<reason>"`: rewrite the roster + land one verbatim
# guard-change receipt (who changed it, why — monthly review reads the
# list). An edit that skips refresh = an alarm, by construction.
# Usage: init | check | refresh "<reason>" | --self-test
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FPHOME="${AXMEM_FP_HOME:-$(dirname "$D")}"
ROSTER="${AXMEM_FP_ROSTER:-$FPHOME/FINGERPRINTS.tsv}"

covered() { # guard files relative to FPHOME (the executable memory-channel code)
  ( cd "$FPHOME" && ls core/*.sh core/*.cjs lib/*.sh lib/*.cjs bin/axmem 2>/dev/null ) \
    | grep -v 'FINGERPRINTS' | sort -u
}
sha() { ( cd "$FPHOME" && sha256sum "$1" 2>/dev/null | cut -c1-16 ); }

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  init)
    : > "$ROSTER"
    while IFS= read -r f; do [ -n "$f" ] && printf '%s\t%s\n' "$f" "$(sha "$f")" >> "$ROSTER"; done < <(covered)
    echo "fingerprint roster initialized: $(wc -l < "$ROSTER" | tr -d ' ') file(s)"
    ;;
  check)
    [ -f "$ROSTER" ] || { echo "fingerprint roster missing — run init first"; exit 1; }
    bad=""
    while IFS=$'\t' read -r f h; do
      [ -z "$f" ] && continue
      cur="$(sha "$f")"
      if [ -z "$cur" ]; then bad="$bad
  missing $f"; elif [ "$cur" != "$h" ]; then bad="$bad
  changed $f"; fi
    done < "$ROSTER"
    while IFS= read -r f; do
      [ -n "$f" ] && ! grep -q "^$f	" "$ROSTER" && bad="$bad
  unregistered $f"
    done < <(covered)
    if [ -n "$bad" ]; then
      echo "guard fingerprints changed with no refresh receipt:$bad"
      echo "  legal path: bash core/fingerprint.sh refresh \"<reason>\""
      exit 1
    fi
    echo "fingerprint roster: $(wc -l < "$ROSTER" | tr -d ' ') file(s) all consistent"
    ;;
  refresh)
    reason="${*:-}"
    [ -n "$reason" ] || { echo "refresh requires a reason (lands verbatim on the receipt)" >&2; exit 1; }
    changed=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      cur="$(sha "$f")"; old="$(grep "^$f	" "$ROSTER" 2>/dev/null | cut -f2)"
      [ "$cur" != "$old" ] && changed="$changed $f"
    done < <(covered)
    # a removed file counts as a change too
    while IFS=$'\t' read -r f h; do [ -n "$f" ] && [ -z "$(sha "$f")" ] && changed="$changed $f(removed)"; done < "$ROSTER"
    [ -n "$changed" ] || { echo "no change, roster unchanged"; exit 0; }
    : > "$ROSTER"
    while IFS= read -r f; do [ -n "$f" ] && printf '%s\t%s\n' "$f" "$(sha "$f")" >> "$ROSTER"; done < <(covered)
    if [ -x "$D/receipt.sh" ] || [ -f "$D/receipt.sh" ]; then
      bash "$D/receipt.sh" add guard-change "$(printf '%s' "$changed" | cut -c1-200)" "$reason" >/dev/null 2>&1 || true
    fi
    echo "roster refreshed, changed:$changed (reason: $reason)"
    ;;
  --self-test)
    T="$(mktemp -d)"; mkdir -p "$T/core" "$T/lib" "$T/bin" "$T/r"
    printf 'v1\n' > "$T/core/g.sh"
    ok=0
    e() { AXMEM_FP_HOME="$T" AXMEM_FP_ROSTER="$T/roster.tsv" AXMEM_RECEIPTS_DIR="$T/r" AXMEM_STATE_DIR="$T/r" bash "$D/fingerprint.sh" "$@" >/dev/null 2>&1; }
    e init && e check && ok=$((ok+1))                       # 1 consistent after init
    printf 'v2\n' > "$T/core/g.sh"
    e check; [ $? -eq 1 ] && ok=$((ok+1))                   # 2 changed with no receipt -> red
    e refresh; [ $? -eq 1 ] && ok=$((ok+1))                 # 3 refresh without a reason -> refused
    e refresh "test reason" && e check && ok=$((ok+1))      # 4 refresh with a reason -> green
    printf 'x\n' > "$T/core/new.sh"
    e check; [ $? -eq 1 ] && ok=$((ok+1))                   # 5 new unregistered file -> red
    rm -rf "$T"
    if [ "$ok" -eq 5 ]; then echo "fingerprint self-test 5/5"; exit 0; fi
    echo "fingerprint self-test $ok/5 FAIL"; exit 1
    ;;
  *) echo "usage: fingerprint.sh init|check|refresh \"<reason>\"|--self-test" >&2; exit 1 ;;
esac
