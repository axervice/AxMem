#!/usr/bin/env bash
# AxMem — proves bin/axmem's `selftest` fail-closed self-isolation guard
# (Builder W9, 2026-09-24). A prior round (W8) silently wrote into the real
# ~/.claude-equivalent home because a selftest run forgot to export
# isolation env vars. bin/axmem now self-detects that case (see the guard
# block right before it sources lib/prelude.sh) and re-execs itself under a
# freshly minted temp HOME instead of proceeding — this test proves that
# holds by simulating exactly the forgotten-isolation scenario and checking
# that the stand-in "home" is never touched.
#
# Deliberately uses a FAKE stand-in home (a throwaway mktemp'd dir passed
# as HOME/USERPROFILE), never this machine's real $HOME/.axmem, even though
# tests/isolation-real-configs.sh's convention is to check real per-adapter
# paths directly: THIS test's whole job is to prove the guard protects
# against a bug class in code that has not yet earned that trust on a real
# machine, so it never bets the operator's actual home on the guard being
# correct — see the builder report for this reasoning.
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$D")"

if [ "${1:-}" != "--self-test" ]; then
  echo "usage: selftest-fail-closed.sh --self-test"
  exit 1
fi

ok=0
total=2
lines=()
check() { if [ "$2" -eq 0 ]; then ok=$((ok + 1)); lines+=("  ok   $1"); else lines+=("  FAIL $1"); fi; }

FAKE_HOME="$(mktemp -d)"
FAKE_HOME="$(cygpath -m "$FAKE_HOME" 2>/dev/null || printf '%s' "$FAKE_HOME")"
mkdir -p "$FAKE_HOME/.axmem"
printf 'pre-existing sentinel file — must survive byte-identical\n' > "$FAKE_HOME/.axmem/sentinel.txt"
hash_before="$(find "$FAKE_HOME" -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum)"

# Simulate a bare, forgot-to-isolate invocation: a cleared environment
# (env -i) with ONLY PATH plus HOME/USERPROFILE pointed at the fake
# stand-in — no AXMEM_* override, no AXMEM_SELFTEST_ISOLATED. If the guard
# works, it self-redirects to a DIFFERENT, freshly-made temp home almost
# immediately (before any real work), so bounding this to a few seconds is
# enough to observe the outcome without paying for a full nested selftest
# run (which the guard's success would otherwise kick off for real, inside
# its OWN isolated home — that's the correct behavior, just not something
# this proof needs to sit through).
out_file="$(mktemp)"
env -i PATH="$PATH" HOME="$FAKE_HOME" USERPROFILE="$FAKE_HOME" \
  timeout 5 bash "$ROOT/bin/axmem" selftest >"$out_file" 2>&1
out="$(cat "$out_file")"
rm -f "$out_file"

hash_after="$(find "$FAKE_HOME" -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum)"

[ "$hash_before" = "$hash_after" ]
check "fake stand-in home byte-identical (sha256 of every file, sorted) before vs after a bare invocation" $?

printf '%s' "$out" | grep -q 'self-isolating'
check "guard actually fired (stderr announced self-isolating under a fresh temp home)" $?

rm -rf "$FAKE_HOME"

printf '%s\n' "${lines[@]}"
if [ "$ok" -eq "$total" ]; then
  echo "selftest-fail-closed self-test $ok/$total"
  exit 0
else
  echo "selftest-fail-closed self-test $ok/$total FAIL"
  exit 1
fi
