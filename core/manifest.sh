#!/usr/bin/env bash
# AxMem manifest wrapper. [--json|--check] | --self-test
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  mk() { printf '%s' "$1" > "$T/lessons.md"; : > "$T/decisions.md"; : > "$T/standinginstructions.md"; }
  run() { AXMEM_MEMORY_DIR="$T" node "$D/manifest.cjs" --check >/dev/null 2>&1; }
  ok=0
  mk '**2026-01-02 — n** [a:new]
b
Supersedes: [[a:ghost]]
'
  run; [ $? -eq 2 ] && ok=$((ok+1))     # B1 dangling
  mk '**2026-01-01 — a** [a:x]
b
Supersedes: [[a:y]]

**2026-01-02 — b** [a:y]
b
Supersedes: [[a:x]]
'
  run; [ $? -eq 2 ] && ok=$((ok+1))     # B2 cycle
  mk '## Index

- 2026-01-01 [a:old] o (superseded→[a:wrong])

## Entries

**2026-01-01 — o** [a:old]
b

**2026-01-02 — n** [a:new]
b
Supersedes: [[a:old]]

**2026-01-03 — w** [a:wrong]
b
'
  run; [ $? -eq 2 ] && ok=$((ok+1))     # B3 contradiction
  mk '## Index

- 2026-01-01 [a:old] o (superseded→[a:new])
- 2026-01-02 [a:new] n

## Entries

**2026-01-01 — o** [a:old]
b

**2026-01-02 — n** [a:new]
b
Supersedes: [[a:old]]
'
  run && ok=$((ok+1))                    # green (Index bijection complete — both entries have their own row)
  # 5 red B4: row count balances (1 Index row, 1 entry) but the SETS don't
  #   match — a phantom Index row plus an unindexed entry must still be caught
  #   (row parity alone would call this even)
  printf '%s' '## Index

- 2026-01-01 [a:phantom] phantom row

## Entries

**2026-01-02 — real entry** [a:real]
b
' > "$T/lessons.md"
  run; [ $? -eq 2 ] && ok=$((ok+1))     # B4 bijection
  # 6 red B5: malformed trigger comment (a `path=...` shorthand missing
  #   tool=/repo=) is a silently dead trigger — the push channel's regex
  #   just never matches it, with no report anywhere else. Index row matches
  #   the entry so this isolates B5 from B4.
  printf '%s' '## Index

- 2026-01-02 [a:real] real entry

## Entries

**2026-01-02 — real entry** [a:real]
<!-- trigger: path=.claude/guards/ -->
b
' > "$T/lessons.md"
  run; [ $? -eq 2 ] && ok=$((ok+1))     # B5 malformed trigger
  # 7 red B6: Class target not defined in classes.md (controlled vocabulary)
  printf '%s' '## Index

- 2026-01-02 [a:real] real entry

## Entries

**2026-01-02 — real entry** [a:real]
Class: [[class:ghost-never-defined]]
b
' > "$T/lessons.md"
  printf '%s' '**2026-09-14 — Class: alpha** [class:alpha]
Criterion: x
' > "$T/classes.md"
  run; [ $? -eq 2 ] && ok=$((ok+1))     # B6 undefined class target
  # 8 red B6: a lesson dated on/after CLASS_REQUIRED_FROM has no Class line
  #   (classes.md from fixture 7 is left in place — not touched by `mk`)
  printf '%s' '## Index

- 2026-09-15 [a:new] new entry

## Entries

**2026-09-15 — new entry** [a:new]
b
' > "$T/lessons.md"
  run; [ $? -eq 2 ] && ok=$((ok+1))     # B6 missing Class on new lesson
  # 9 green B6: new lesson carries a legal Class line pointing at a defined class
  printf '%s' '## Index

- 2026-09-15 [a:new] new entry

## Entries

**2026-09-15 — new entry** [a:new]
Class: [[class:alpha]]
b
' > "$T/lessons.md"
  run && ok=$((ok+1))                    # green with Class satisfied
  rm -rf "$T"
  if [ "$ok" -eq 9 ]; then echo "manifest self-test 9/9 (B1-B6 red + clean green x2)"; exit 0; fi
  echo "manifest self-test $ok/9 FAIL"; exit 1
fi
exec node "$D/manifest.cjs" "$@"
