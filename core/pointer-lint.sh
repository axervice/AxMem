#!/usr/bin/env bash
# AxMem pointer-lint wrapper. Usage: pointer-lint.sh [--strict] | --self-test
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  mkdir -p "$T/mem/dreams" "$T/home"
  printf '{}' > "$T/config.json"
  printf '# target\n' > "$T/home/target.md"
  {
    printf '%s\n' '## Index'
    printf '%s\n' '- 2026-01-01 [test:defined] good'
    printf '%s\n' '## Entries'
    printf '%s\n' '**2026-01-01 — good** [test:defined]'
    printf '%s\n' 'ref ok [[test:defined]]; dangling [[test:missing]] must be caught.'
    printf '%s\n' 'good path `~/target.md` must pass; bad path `~/no-such-file.md` must be caught.'
  } > "$T/mem/decisions.md"
  : > "$T/mem/lessons.md"; : > "$T/mem/standinginstructions.md"
  out="$(HOME="$T/home" AXMEM_HOME="$T/home/.axmem" AXMEM_CONFIG="$T/config.json" AXMEM_MEMORY_DIR="$T/mem" node "$D/pointer-lint.cjs")"
  rm -rf "$T"
  a="$(printf '%s' "$out" | grep -o 'DANGLING_TAGS=[0-9]*' | cut -d= -f2)"
  c="$(printf '%s' "$out" | grep -o 'BROKEN_PATHS=[0-9]*' | cut -d= -f2)"
  if [ "$a" = "1" ] && [ "$c" = "1" ]; then echo "pointer-lint self-test 2/2 (good path resolved, both faults caught)"; exit 0
  else echo "pointer-lint self-test FAIL: dangling=$a broken=$c (want 1/1)"; printf '%s\n' "$out"; exit 1; fi
fi
exec node "$D/pointer-lint.cjs" "$@"
