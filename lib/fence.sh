#!/usr/bin/env bash
# AxMem fence — bash entry point for the idempotent marker-fenced section
# writer. (P1 2.0, 2026-09-16)
# Byte-precise BOM/CRLF/permission handling lives in fence.cjs (Node's Buffer
# API is the only reliable way to do this without a shell mangling bytes);
# this file is the bash-callable surface adapters source, plus --self-test.
# Usage (sourced):   fence_apply <target> <content-file> <marker-name> [--dry-run]
# Usage (direct):    bash fence.sh apply <target> <content-file> <marker-name> [--dry-run]
#                     bash fence.sh --self-test
set -u
AXMEM_FENCE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fence_apply() {
  node "$AXMEM_FENCE_LIB_DIR/fence.cjs" apply "$@"
}

# Everything below acts on "$@" — it must NEVER fire when this file is
# sourced by another script (source shares the sourcing script's positional
# parameters, so a caller invoked as `wire.sh --self-test` would otherwise
# trip fence.sh's OWN --self-test the moment it sources this file, and never
# reach its own self-test block). Only run when fence.sh is the directly
# executed script.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0 2>/dev/null || exit 0
fi

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  ok=0
  # Every fence_apply call must run under an isolated AXMEM_STATE_DIR/HOME —
  # fence.cjs's backup-dir fallback resolves relative to AXMEM_STATE_DIR (or
  # AXMEM_HOME, or finally cwd()), and this self-test must never touch the
  # real repo working directory or a real AXMEM_HOME regardless of the
  # caller's ambient environment.
  export AXMEM_STATE_DIR="$T/default-state"
  export AXMEM_HOME="$T/default-home"
  mkdir -p "$AXMEM_STATE_DIR" "$AXMEM_HOME"
  run() { fence_apply "$@"; }

  # 1: fresh (nonexistent) target -> append, exit 0
  printf 'hello world\n' > "$T/c1.txt"
  run "$T/target1.md" "$T/c1.txt" axmem >/dev/null 2>&1
  [ $? -eq 0 ] && grep -q '<!-- axmem:begin -->' "$T/target1.md" && grep -q 'hello world' "$T/target1.md" && ok=$((ok+1))

  # 2: idempotent re-run over an already-fenced file -> byte-identical
  cp "$T/target1.md" "$T/target1.before"
  run "$T/target1.md" "$T/c1.txt" axmem >/dev/null 2>&1
  cmp -s "$T/target1.before" "$T/target1.md" && ok=$((ok+1))

  # 3: replace content -> old body gone, new body present, surrounding text preserved
  printf 'PRE-EXISTING HEADER\n' > "$T/target3.md"
  printf 'v1 body\n' > "$T/c3a.txt"
  run "$T/target3.md" "$T/c3a.txt" axmem >/dev/null 2>&1
  printf 'v2 body\n' > "$T/c3b.txt"
  run "$T/target3.md" "$T/c3b.txt" axmem >/dev/null 2>&1
  grep -q 'PRE-EXISTING HEADER' "$T/target3.md" && grep -q 'v2 body' "$T/target3.md" && ! grep -q 'v1 body' "$T/target3.md" && ok=$((ok+1))

  # 4: torn fence (begin with no end) -> rc 3, zero write (file untouched), zero backup
  printf 'keep me\n<!-- axmem:begin -->\norphan begin, no end\n' > "$T/target4.md"
  cp "$T/target4.md" "$T/target4.before"
  mkdir -p "$T/state4/backups"
  AXMEM_STATE_DIR="$T/state4" run "$T/target4.md" "$T/c1.txt" axmem >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 3 ] && cmp -s "$T/target4.before" "$T/target4.md" && [ -z "$(ls -A "$T/state4/backups" 2>/dev/null)" ] && ok=$((ok+1))

  # 5: duplicate begin markers -> rc 3
  printf '<!-- axmem:begin -->\na\n<!-- axmem:end -->\n<!-- axmem:begin -->\nb\n<!-- axmem:end -->\n' > "$T/target5.md"
  run "$T/target5.md" "$T/c1.txt" axmem >/dev/null 2>&1
  [ $? -eq 3 ] && ok=$((ok+1))

  # 6: end-before-begin -> rc 3
  printf '<!-- axmem:end -->\nmiddle\n<!-- axmem:begin -->\n' > "$T/target6.md"
  run "$T/target6.md" "$T/c1.txt" axmem >/dev/null 2>&1
  [ $? -eq 3 ] && ok=$((ok+1))

  # 7: --dry-run performs validation but writes nothing
  printf 'keep me\n<!-- axmem:begin -->\norphan\n' > "$T/target7.md"
  cp "$T/target7.md" "$T/target7.before"
  run "$T/target7.md" "$T/c1.txt" axmem --dry-run >/dev/null 2>&1
  rc7=$?
  printf 'fresh\n' > "$T/target7b.md"
  cp "$T/target7b.md" "$T/target7b.before"
  run "$T/target7b.md" "$T/c1.txt" axmem --dry-run >/dev/null 2>&1
  rc7b=$?
  [ "$rc7" -eq 3 ] && cmp -s "$T/target7.before" "$T/target7.md" \
    && [ "$rc7b" -eq 0 ] && cmp -s "$T/target7b.before" "$T/target7b.md" && ok=$((ok+1))

  # 8: BOM + CRLF + no-trailing-newline preserved through a replace
  printf '\xEF\xBB\xBFline-one\r\n<!-- axmem:begin -->\r\nold\r\n<!-- axmem:end -->\r\nno-trailing-nl' > "$T/target8.md"
  printf 'new-body' > "$T/c8.txt"
  run "$T/target8.md" "$T/c8.txt" axmem >/dev/null 2>&1
  head_bytes="$(head -c 3 "$T/target8.md" | od -An -tx1 | tr -d ' \n')"
  tail_bytes="$(tail -c 1 "$T/target8.md" | od -An -tx1 | tr -d ' \n')"
  crlf_count="$(grep -c $'\r' "$T/target8.md" || true)"
  [ "$head_bytes" = "efbbbf" ] && [ "$tail_bytes" != "0a" ] && [ "$crlf_count" -gt 0 ] && grep -q 'new-body' "$T/target8.md" && ok=$((ok+1))

  # 9: real write backs up the pre-existing target under AXMEM_STATE_DIR/backups/
  printf 'v1\n' > "$T/c9a.txt"
  printf 'orig9\n' > "$T/target9.md"
  mkdir -p "$T/state9"
  AXMEM_STATE_DIR="$T/state9" run "$T/target9.md" "$T/c9a.txt" axmem >/dev/null 2>&1
  printf 'v2\n' > "$T/c9b.txt"
  AXMEM_STATE_DIR="$T/state9" run "$T/target9.md" "$T/c9b.txt" axmem >/dev/null 2>&1
  [ -n "$(ls -A "$T/state9/backups" 2>/dev/null)" ] && ok=$((ok+1))

  rm -rf "$T"
  if [ "$ok" -eq 9 ]; then echo "fence self-test 9/9"; exit 0; else echo "fence self-test $ok/9 FAIL"; exit 1; fi
fi

if [ "${1:-}" = "apply" ]; then
  shift
  fence_apply "$@"
  exit $?
fi

if [ "${1:-}" != "" ] && [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  echo "usage: fence.sh apply <target> <content-file> <marker-name> [--dry-run] | --self-test" >&2
  exit 1
fi
