#!/usr/bin/env bash
# AxMem generic adapter wiring — convention-level (D4). (P1 2.2, 2026-09-16)
# Appends one marker-fenced section (SNIPPET.md's content) to ANY
# instruction file via lib/fence.sh — same idempotent mechanism the codex
# adapter uses, byte-safe (BOM/CRLF/trailing-newline/permissions preserved,
# torn-fence refuses rc 3 zero-write zero-backup).
# Usage: wire.sh <instruction-file> [--dry-run]
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$D/../.." && pwd)"
. "$ROOT/lib/prelude.sh"
. "$ROOT/lib/fence.sh"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  export AXMEM_STATE_DIR="$T/state" AXMEM_HOME="$T/home" AXMEM_MEMORY_DIR="$T/mem"
  mkdir -p "$AXMEM_STATE_DIR" "$AXMEM_HOME" "$AXMEM_MEMORY_DIR"
  ok=0

  # 1: no target given -> usage error, nothing written
  bash "${BASH_SOURCE[0]}" >/dev/null 2>&1
  [ $? -eq 1 ] && ok=$((ok+1))

  # 2: clean pre-existing file -> prefix preserved, fence appended
  printf 'my agent instructions\nsecond line\n' > "$T/AGENT.md"
  bash "${BASH_SOURCE[0]}" "$T/AGENT.md" >/dev/null 2>&1
  head -2 "$T/AGENT.md" | diff -q - <(printf 'my agent instructions\nsecond line\n') >/dev/null 2>&1 && grep -q '<!-- axmem:begin -->' "$T/AGENT.md" && ok=$((ok+1))

  # 3: idempotent — no embedded date, byte-identical rerun
  sed -n '/<!-- axmem:begin -->/,/<!-- axmem:end -->/p' "$T/AGENT.md" | grep -Eq '20[0-9]{2}-[0-9]{2}-[0-9]{2}' || ok=$((ok+1))
  cp "$T/AGENT.md" "$T/AGENT.before"
  bash "${BASH_SOURCE[0]}" "$T/AGENT.md" >/dev/null 2>&1
  cmp -s "$T/AGENT.before" "$T/AGENT.md" && ok=$((ok+1))

  # 4: torn fence refused rc 3, file untouched
  printf 'keep\n<!-- axmem:begin -->\norphan\n' > "$T/torn.md"
  cp "$T/torn.md" "$T/torn.before"
  bash "${BASH_SOURCE[0]}" "$T/torn.md" >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 3 ] && cmp -s "$T/torn.before" "$T/torn.md" && ok=$((ok+1))

  # 5: --dry-run makes no changes to a fresh target
  bash "${BASH_SOURCE[0]}" "$T/dryrun.md" --dry-run >/dev/null 2>&1
  [ ! -f "$T/dryrun.md" ] && ok=$((ok+1))

  rm -rf "$T"
  if [ "$ok" -eq 6 ]; then echo "generic wire self-test 6/6"; exit 0; else echo "generic wire self-test $ok/6 FAIL"; exit 1; fi
fi

DRYRUN=""
TARGET_ARG=""
for a in "$@"; do
  if [ "$a" = "--dry-run" ]; then DRYRUN="--dry-run"; else TARGET_ARG="$a"; fi
done
if [ -z "$TARGET_ARG" ]; then
  echo "usage: wire.sh <instruction-file> [--dry-run]" >&2
  exit 1
fi
TARGET="${TARGET_ARG/#\~/$HOME}"
mkdir -p "$(dirname "$TARGET")"

CONTENT_TMP="$(mktemp)"
cat > "$CONTENT_TMP" <<SECEOF
## AxMem memory governance (convention-level; enforcement=convention, D4)

- Governed memory dir: \`$AXMEM_MEMORY_DIR\` (entry form: docs/DATA-CONTRACT.md in the AxMem repo).
- After ANY edit to a memory file, run: \`bash $ROOT/bin/axmem gate --block < /dev/null\` — exit 2 means fix the flagged debt before continuing.
- When the operator makes a ruling, record it verbatim at that moment: \`bash $ROOT/bin/axmem receipt add user-ruling "<topic>" "<verbatim words>"\`.
- Before ending a work session: \`bash $ROOT/bin/axmem receipt pending\` — sediment then \`receipt cover --all\` (or \`--dismiss\` when genuinely disposable).
- Retirement = MOVE: never delete a memory entry without its verbatim text landing in the matching *-archive.md in the same commit (\`axmem precommit\` enforces).
- On a schedule (see \`bash $ROOT/adapters/generic/schedule.sh --print\` for lines to add yourself): \`axmem doctor && axmem canary\`.
SECEOF

if [ -n "$DRYRUN" ]; then
  fence_apply "$TARGET" "$CONTENT_TMP" axmem --dry-run --adapter generic
else
  fence_apply "$TARGET" "$CONTENT_TMP" axmem --adapter generic
fi
rc=$?
rm -f "$CONTENT_TMP"
if [ $rc -eq 0 ]; then
  [ -z "$DRYRUN" ] && echo "generic adapter: AxMem section written to $TARGET (idempotent; re-run refreshes it)"
else
  echo "generic adapter: refused to write $TARGET (duplicate/incomplete axmem markers — inspect and fix manually)" >&2
fi
exit $rc
