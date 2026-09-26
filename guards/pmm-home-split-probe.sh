#!/usr/bin/env bash
# pmm-home-split-probe.sh — behavior probe for pmm-home.sh's home-directory resolution
# (2026-09-23, Opus fab-delta triage §HIGH-1 修复批 A4; audits/OPUS-2026-09-23-fab-delta-triage.md;
# hardened per audits/OPUS-2026-09-23-a4-review.md, batch A4-尾).
#
# Before this batch's fix, pmm-home.sh embedded a POSIX-style path directly inside a `node -e "..."`
# double-quoted string; on this host node.exe is native Windows node and never translates that
# argument, so the require() call always threw MODULE_NOT_FOUND and pmm-home.sh silently fell
# straight through to `cd ~ && pwd` (=$HOME) on EVERY invocation, ignoring PMM_HOME entirely and
# masking any HOME/USERPROFILE divergence. This script is the "可数 = 分裂的守卫数" behavior probe
# the audit calls for: six checks, each printing its own PASS/FAIL line, run 0 iff every check
# passes.
#
#   ① HOME=A USERPROFILE=B PMM_HOME=P (all fresh temp dirs) -> `source pmm-home.sh` resolves to
#      P (canonicalized), PMM_HOME_RESOLVED_VIA=resolveHome.
#   ② same three dirs, PMM_HOME unset -> resolves to B (canonicalized; USERPROFILE outranks HOME).
#   ③ same three dirs, `node` removed from PATH -> PMM_HOME_RESOLVED_VIA=fallback and a stderr
#      diagnostic line is printed.
#   ④ HOME=USERPROFILE=A4, PMM_HOME=P4 (both fresh temp dirs) -> pmm-trigger-recall.sh --self-test
#      must report N/M with N==M and M>=31 (parsed, not a hardcoded count -- A3 is adding cases to
#      this same self-test, so the total will grow past 31 over time). Measured RED before the A4
#      fix: 13/31 (shell side ignored PMM_HOME, node side honored it -- the two disagreed).
#   ⑤ HOME=A5, USERPROFILE=B5 (fresh temp dirs, .claude/ pre-built under BOTH) ->
#      workflow-model-guard.test.sh must report "N passed, 0 failed" with N>=85 (parsed). Measured
#      RED before the A4 fix: 83/85 (the test's own MIXSTAMP path, resolved via the broken
#      pmm-home.sh fallback, diverged from the guard's own internal resolveHome()-based resolution).
#   ⑥ same A/B/P triple as ①②③, but with MSYS_NO_PATHCONV=1 exported -> still resolves to P
#      (canonicalized), VIA=resolveHome. Regression guard for the LOW-2 defect class: argv-based
#      translation of the ledger path into node is itself an MSYS behavior, and MSYS_NO_PATHCONV=1 /
#      MSYS2_ARG_CONV_EXCL=* both disable it, which would silently reopen the HIGH-1 failure mode if
#      pmm-home.sh ever went back to relying on argv translation alone.
#
# 2026-09-23 (Opus A4 review, MEDIUM-2, CONFIRMED): every invocation below that does NOT intend a
# check-specific PMM_HOME/PMM_RECALL_ROOT value now scrubs the CALLER's own exported PMM_HOME /
# PMM_RECALL_ROOT via `env -u` before setting its own -- a caller (operator shell, CI, another guard)
# that happens to export PMM_HOME for its own reasons must never leak into this probe's isolation.
# Measured before this fix: with PMM_HOME exported by the caller, check ⑤ silently wrote its MIXSTAMP
# into the CALLER's real PMM_HOME/.claude (not this script's temp B5) and reported a false 84/85 red.
# ①③④⑥ also set PMM_HOME explicitly for their own purposes -- audited and confirmed an explicit
# `VAR=value` assignment always wins over an inherited one for that same invocation regardless of
# `env -u`, so those four checks were never actually vulnerable to this leak; `env -u PMM_HOME` is
# still applied there too for a uniform, defense-in-depth invocation style. ② already unset PMM_HOME
# inline inside its subshell (also safe), switched to the same `env -u` style for consistency.
#
# This script only ever creates directories/files under its own mktemp root -- it never touches the
# real HOME/USERPROFILE, the real ~/.claude tree, or any PMM_* real root. Exit codes are taken
# directly from command substitutions, never through a pipe.
set -u

G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pmm-home-split-probe.XXXXXX")" \
  || { echo "FATAL: mktemp -d failed -- refusing to run" >&2; exit 1; }
if [ -z "$TMP_ROOT" ] || [ ! -d "$TMP_ROOT" ] || [ "$TMP_ROOT" = "/" ]; then
  echo "FATAL: unusable temp root ('${TMP_ROOT}') -- refusing to run" >&2
  exit 1
fi
case "$TMP_ROOT" in
  */pmm-home-split-probe.*) : ;;
  *) echo "FATAL: temp root '${TMP_ROOT}' does not match the expected pattern -- refusing" >&2; exit 1 ;;
esac
cleanup_all() {
  [ -n "${TMP_ROOT:-}" ] || return 0
  [ -d "$TMP_ROOT" ] || return 0
  case "$TMP_ROOT" in
    */pmm-home-split-probe.*) rm -rf "$TMP_ROOT" ;;
    *) echo "WARN: refusing to clean unexpected temp root '$TMP_ROOT'" >&2 ;;
  esac
}
trap cleanup_all EXIT

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

command -v cygpath >/dev/null 2>&1 || { echo "FATAL: cygpath not found -- this probe is Windows/MSYS-specific" >&2; exit 1; }

# canon(path) — 2026-09-23 (Opus A4 review, LOW-1, CONFIRMED): a single `cygpath -u` on an
# already-POSIX-style temp path is not always idempotent when that path falls under a directory MSYS
# also has mounted somewhere else (e.g. %TEMP% and /tmp coinciding) -- the ACTUAL resolved value
# round-trips through Windows form inside pmm-home.sh (env-var auto-conversion into node, then this
# script's own `cygpath -u`), so the EXPECTED value must be canonicalized the same way to compare
# apples to apples. Measured before this fix: checks ①② were false-red (3/5) whenever TMPDIR sat
# under `C:\Users\...\AppData\Local\Temp\...` (a real, common shape, not a contrived one).
canon() {
  cygpath -u "$(cygpath -m "$1")"
}

# ---------------------------------------------------------------------------
# ①②③⑥ share one A/B/P triple, all under TMP_ROOT.
# ---------------------------------------------------------------------------
A="$TMP_ROOT/A"; B="$TMP_ROOT/B"; P="$TMP_ROOT/P"
mkdir -p "$A" "$B" "$P" || { echo "FATAL: mkdir A/B/P failed" >&2; exit 1; }

echo "=================================================="
echo "① HOME=A USERPROFILE=B PMM_HOME=P -> resolves to P, VIA=resolveHome"
echo "=================================================="
OUT1="$(env -u PMM_HOME HOME="$A" USERPROFILE="$B" PMM_HOME="$P" bash -c 'source "'"$G"'/pmm-home.sh"; printf "%s\n%s\n" "$PMM_HOME_RESOLVED" "$PMM_HOME_RESOLVED_VIA"')"
RESOLVED1="$(printf '%s\n' "$OUT1" | sed -n '1p')"
VIA1="$(printf '%s\n' "$OUT1" | sed -n '2p')"
EXPECT1="$(canon "$P")"
if [ "$RESOLVED1" = "$EXPECT1" ] && [ "$VIA1" = "resolveHome" ]; then
  report "① PMM_HOME wins over USERPROFILE/HOME, VIA=resolveHome" 1
else
  report "① PMM_HOME wins over USERPROFILE/HOME, VIA=resolveHome" 0 \
    "resolved='$RESOLVED1' (want '$EXPECT1') via='$VIA1' (want resolveHome)"
fi
echo "  PMM_HOME_RESOLVED=$RESOLVED1 VIA=$VIA1"

echo
echo "=================================================="
echo "② HOME=A USERPROFILE=B, PMM_HOME unset -> resolves to B"
echo "=================================================="
OUT2="$(env -u PMM_HOME HOME="$A" USERPROFILE="$B" bash -c 'source "'"$G"'/pmm-home.sh"; printf "%s\n%s\n" "$PMM_HOME_RESOLVED" "$PMM_HOME_RESOLVED_VIA"')"
RESOLVED2="$(printf '%s\n' "$OUT2" | sed -n '1p')"
VIA2="$(printf '%s\n' "$OUT2" | sed -n '2p')"
EXPECT2="$(canon "$B")"
if [ "$RESOLVED2" = "$EXPECT2" ] && [ "$VIA2" = "resolveHome" ]; then
  report "② PMM_HOME unset -> USERPROFILE outranks HOME" 1
else
  report "② PMM_HOME unset -> USERPROFILE outranks HOME" 0 \
    "resolved='$RESOLVED2' (want '$EXPECT2') via='$VIA2'"
fi
echo "  PMM_HOME_RESOLVED=$RESOLVED2 VIA=$VIA2"

echo
echo "=================================================="
echo "③ node removed from PATH -> VIA=fallback + one stderr diagnostic line"
echo "=================================================="
# Build a PATH with every directory that currently resolves 'node' removed. Loop (bounded) in case
# more than one node lives on PATH, re-checking after each removal.
CUR_PATH="$PATH"
ITER=0
while command -v node >/dev/null 2>&1 && [ "$ITER" -lt 10 ]; do
  NODE_BIN="$(PATH="$CUR_PATH" command -v node 2>/dev/null || true)"
  [ -n "$NODE_BIN" ] || break
  NODE_DIR="$(cd "$(dirname "$NODE_BIN")" 2>/dev/null && pwd || true)"
  [ -n "$NODE_DIR" ] || break
  NEW_PATH=""
  OLDIFS="$IFS"; IFS=':'
  for d in $CUR_PATH; do
    [ -n "$d" ] || continue
    rd="$(cd "$d" 2>/dev/null && pwd || printf '%s' "$d")"
    [ "$rd" = "$NODE_DIR" ] && continue
    NEW_PATH="${NEW_PATH:+$NEW_PATH:}$d"
  done
  IFS="$OLDIFS"
  # re-check with the trimmed PATH in a subshell (command -v honors the PATH we pass it)
  if PATH="$NEW_PATH" command -v node >/dev/null 2>&1; then
    CUR_PATH="$NEW_PATH"
    ITER=$((ITER + 1))
    continue
  fi
  CUR_PATH="$NEW_PATH"
  break
done
NO_NODE_PATH="$CUR_PATH"
if PATH="$NO_NODE_PATH" command -v node >/dev/null 2>&1; then
  report "③ node removed from PATH -> VIA=fallback + stderr diagnostic" 0 \
    "could not construct a node-free PATH (node still resolves) -- probe setup inconclusive"
else
  ERRFILE="$TMP_ROOT/stderr3.txt"
  OUT3="$(env -u PMM_HOME HOME="$A" USERPROFILE="$B" PMM_HOME="$P" PATH="$NO_NODE_PATH" bash -c 'source "'"$G"'/pmm-home.sh"; printf "%s\n%s\n" "$PMM_HOME_RESOLVED" "$PMM_HOME_RESOLVED_VIA"' 2>"$ERRFILE")"
  RESOLVED3="$(printf '%s\n' "$OUT3" | sed -n '1p')"
  VIA3="$(printf '%s\n' "$OUT3" | sed -n '2p')"
  STDERR3="$(cat "$ERRFILE" 2>/dev/null)"
  rm -f "$ERRFILE"
  if [ "$VIA3" = "fallback" ] && [ -n "$STDERR3" ]; then
    report "③ node removed from PATH -> VIA=fallback + stderr diagnostic" 1
  else
    report "③ node removed from PATH -> VIA=fallback + stderr diagnostic" 0 \
      "via='$VIA3' (want fallback) stderr='$STDERR3' (want non-empty)"
  fi
  echo "  PMM_HOME_RESOLVED=$RESOLVED3 VIA=$VIA3 stderr=[$STDERR3]"
fi

# ---------------------------------------------------------------------------
# ④ pmm-trigger-recall.sh --self-test, HOME=USERPROFILE=A4, PMM_HOME=P4
# ---------------------------------------------------------------------------
echo
echo "=================================================="
echo "④ pmm-trigger-recall.sh --self-test under HOME=USERPROFILE=A4, PMM_HOME=P4 -> N/M, N==M, M>=31"
echo "=================================================="
A4="$TMP_ROOT/A4"; P4="$TMP_ROOT/P4"
mkdir -p "$A4" "$P4" || { echo "FATAL: mkdir A4/P4 failed" >&2; exit 1; }
OUT4="$(env -u PMM_HOME -u PMM_RECALL_ROOT HOME="$A4" USERPROFILE="$A4" PMM_HOME="$P4" bash "$G/pmm-trigger-recall.sh" --self-test 2>&1)"
RC4=$?
N4=""; M4=""
if [[ "$OUT4" =~ 自证\ ([0-9]+)/([0-9]+) ]]; then
  N4="${BASH_REMATCH[1]}"; M4="${BASH_REMATCH[2]}"
fi
if [ "$RC4" = "0" ] && [ -n "$N4" ] && [ "$N4" = "$M4" ] && [ "$M4" -ge 31 ]; then
  report "④ pmm-trigger-recall.sh --self-test N==M, M>=31 (HOME=USERPROFILE=A4, PMM_HOME=P4)" 1
else
  report "④ pmm-trigger-recall.sh --self-test N==M, M>=31 (HOME=USERPROFILE=A4, PMM_HOME=P4)" 0 \
    "rc=$RC4 parsed N=${N4:-<none>} M=${M4:-<none>} tail=$(printf '%s' "$OUT4" | tail -3 | tr '\n' ' ')"
fi
echo "  parsed: $N4/$M4"

# ---------------------------------------------------------------------------
# ⑤ workflow-model-guard.test.sh, HOME=A5 USERPROFILE=B5, .claude/ pre-built under both
# ---------------------------------------------------------------------------
echo
echo "=================================================="
echo "⑤ workflow-model-guard.test.sh under HOME=A5 USERPROFILE=B5 (.claude pre-built both) -> N passed, 0 failed, N>=85"
echo "=================================================="
A5="$TMP_ROOT/A5"; B5="$TMP_ROOT/B5"
mkdir -p "$A5/.claude" "$B5/.claude" || { echo "FATAL: mkdir A5/B5 .claude failed" >&2; exit 1; }
OUT5="$(env -u PMM_HOME -u PMM_RECALL_ROOT HOME="$A5" USERPROFILE="$B5" bash "$G/workflow-model-guard.test.sh" 2>&1)"
RC5=$?
PASS5=""; FAIL5=""
if [[ "$OUT5" =~ Summary:\ ([0-9]+)\ passed,\ ([0-9]+)\ failed ]]; then
  PASS5="${BASH_REMATCH[1]}"; FAIL5="${BASH_REMATCH[2]}"
fi
if [ "$RC5" = "0" ] && [ -n "$PASS5" ] && [ "$FAIL5" = "0" ] && [ "$PASS5" -ge 85 ]; then
  report "⑤ workflow-model-guard.test.sh N passed 0 failed, N>=85 (HOME=A5, USERPROFILE=B5)" 1
else
  report "⑤ workflow-model-guard.test.sh N passed 0 failed, N>=85 (HOME=A5, USERPROFILE=B5)" 0 \
    "rc=$RC5 parsed passed=${PASS5:-<none>} failed=${FAIL5:-<none>} tail=$(printf '%s' "$OUT5" | tail -5 | tr '\n' ' ')"
fi
echo "  parsed: $PASS5 passed, $FAIL5 failed"

# ---------------------------------------------------------------------------
# ⑥ MSYS_NO_PATHCONV=1 -> the argv-translation path must not be the ONLY thing keeping this working
# ---------------------------------------------------------------------------
echo
echo "=================================================="
echo "⑥ MSYS_NO_PATHCONV=1 -> still resolves to P, VIA=resolveHome (LOW-2 regression guard)"
echo "=================================================="
OUT6="$(env -u PMM_HOME HOME="$A" USERPROFILE="$B" PMM_HOME="$P" MSYS_NO_PATHCONV=1 bash -c 'source "'"$G"'/pmm-home.sh"; printf "%s\n%s\n" "$PMM_HOME_RESOLVED" "$PMM_HOME_RESOLVED_VIA"')"
RESOLVED6="$(printf '%s\n' "$OUT6" | sed -n '1p')"
VIA6="$(printf '%s\n' "$OUT6" | sed -n '2p')"
EXPECT6="$(canon "$P")"
if [ "$RESOLVED6" = "$EXPECT6" ] && [ "$VIA6" = "resolveHome" ]; then
  report "⑥ MSYS_NO_PATHCONV=1 -> VIA still resolveHome" 1
else
  report "⑥ MSYS_NO_PATHCONV=1 -> VIA still resolveHome" 0 \
    "resolved='$RESOLVED6' (want '$EXPECT6') via='$VIA6' (want resolveHome)"
fi
echo "  PMM_HOME_RESOLVED=$RESOLVED6 VIA=$VIA6"

echo
echo "=================================================="
echo "Summary: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "=================================================="

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
