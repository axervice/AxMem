#!/usr/bin/env bash
# AxMem E2E — `axmem doctor` must work when AXMEM_MEMORY_DIR/AXMEM_STATE_DIR
# contain a literal single quote. (codex(gf) LOW #8, coordinator 2026-09-17)
#
# Real repro: doctor's `chk()` used to string-concatenate each path into a
# single-quoted shell command string handed to `bash -c "$2"` — a path
# containing a literal single quote (a legal, if unusual, filesystem path
# on both Windows and POSIX) prematurely closed that quoting and broke the
# check. tests/fresh-home-adapters.sh and every other component test's own
# `mktemp -d` path never happens to contain a quote, so this exact
# character class was a genuine blind spot none of the existing fixtures
# could have caught (init/config/migrate/restore/uninstall/upgrade were
# all unaffected — none of them build a command STRING this way; only
# doctor's chk() did).
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$D")"

if [ "${1:-}" != "--self-test" ]; then
  echo "usage: doctor-quoted-path.sh --self-test"
  exit 1
fi

ok=0
lines=()
check() { if [ "$2" -eq 0 ]; then ok=$((ok + 1)); lines+=("  ok   $1"); else lines+=("  FAIL $1"); fi; }

T="$(mktemp -d)"
T="$(cygpath -m "$T" 2>/dev/null || printf '%s' "$T")"
QT="$T/it's a quote"
mkdir -p "$QT/home" "$QT/home/memory" "$QT/home/state"
for f in decisions lessons standinginstructions; do
  printf '## Index\n\n## Entries\n' > "$QT/home/memory/$f.md"
done

out="$(AXMEM_HOME="$QT/home" AXMEM_MEMORY_DIR="$QT/home/memory" AXMEM_STATE_DIR="$QT/home/state" AXMEM_CONFIG="$QT/home/config.json" bash "$ROOT/bin/axmem" doctor 2>&1)"
rm -rf "$T"

printf '%s\n' "$out" | grep -qE '^ *ok +memory skeleton$'
check "1 (codex(gf) LOW #8) doctor's memory-skeleton check passes when AXMEM_MEMORY_DIR contains a single quote" $?

printf '%s\n' "$out" | grep -qE '^ *ok +state dir writable$'
check "2 (codex(gf) LOW #8) doctor's state-dir-writable check passes when AXMEM_STATE_DIR contains a single quote" $?

for l in "${lines[@]}"; do printf '%s\n' "$l"; done
[ "$ok" -lt 2 ] && { echo "  --- full doctor output for diagnosis ---"; printf '%s\n' "$out" | sed 's/^/      /'; }
echo "doctor-quoted-path self-test $ok/2"
if [ "$ok" -eq 2 ]; then exit 0; else exit 1; fi
