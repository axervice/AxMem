#!/usr/bin/env bash
# AxMem codex adapter wiring — idempotent AGENTS.md section. (P1, 2026-09-13;
# migrated to lib/fence.sh in P1 2.0 2026-09-16 — same marker-fenced-section
# mechanism now shared with the generic adapter instead of a hand-rolled awk
# scan, and the section content dropped its embedded "(wired <date>)" stamp
# so a cross-day re-run produces byte-identical output, not just a same-day
# one — required for the "wire twice -> identical bytes, across days too"
# idempotency test.)
# codex has no hooks; governance rides its instruction file. This appends one
# marker-fenced section to the configured AGENTS.md (re-run replaces the
# section in place; nothing else in the file is touched).
# Usage: wire.sh [target-path] [--dry-run]
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

  # 1: clean pre-existing file (unrelated content, no axmem markers) — the
  # bytes OUTSIDE the newly-appended fence must be preserved exactly.
  printf 'unrelated pre-existing AGENTS.md content\nline two\n' > "$T/AGENTS.md"
  bash "${BASH_SOURCE[0]}" "$T/AGENTS.md" >/dev/null 2>&1
  head -2 "$T/AGENTS.md" | diff -q - <(printf 'unrelated pre-existing AGENTS.md content\nline two\n') >/dev/null 2>&1 && ok=$((ok+1))

  # 2: no embedded date anywhere in the fenced section (content-freedom from
  # dates is what makes cross-day re-runs byte-stable).
  sed -n '/<!-- axmem:begin -->/,/<!-- axmem:end -->/p' "$T/AGENTS.md" | grep -Eq '20[0-9]{2}-[0-9]{2}-[0-9]{2}' || ok=$((ok+1))

  # 3: idempotent — running again produces byte-identical output (this run
  # stands in for "across days" too, since the content has no date to drift).
  cp "$T/AGENTS.md" "$T/AGENTS.md.before"
  bash "${BASH_SOURCE[0]}" "$T/AGENTS.md" >/dev/null 2>&1
  cmp -s "$T/AGENTS.md.before" "$T/AGENTS.md" && ok=$((ok+1))

  # 4: torn fence (begin with no end) refused rc 3, file untouched — proves
  # the migration to lib/fence.sh actually wired the guard through, not just
  # a copy-paste of the old awk scan.
  printf 'keep\n<!-- axmem:begin -->\norphan\n' > "$T/torn.md"
  cp "$T/torn.md" "$T/torn.before"
  bash "${BASH_SOURCE[0]}" "$T/torn.md" >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 3 ] && cmp -s "$T/torn.before" "$T/torn.md" && ok=$((ok+1))

  # 5: --dry-run makes no changes to a fresh target.
  bash "${BASH_SOURCE[0]}" "$T/dryrun.md" --dry-run >/dev/null 2>&1
  [ ! -f "$T/dryrun.md" ] && ok=$((ok+1))

  rm -rf "$T"
  if [ "$ok" -eq 5 ]; then echo "codex wire self-test 5/5"; exit 0; else echo "codex wire self-test $ok/5 FAIL"; exit 1; fi
fi

DRYRUN=""
TARGET_ARG=""
for a in "$@"; do
  if [ "$a" = "--dry-run" ]; then DRYRUN="--dry-run"; else TARGET_ARG="$a"; fi
done
TARGET="${TARGET_ARG:-$(axmem_cfg adapters.codex.agents_md "$HOME/.codex/AGENTS.md")}"
TARGET="${TARGET/#\~/$HOME}"
mkdir -p "$(dirname "$TARGET")"

CONTENT_TMP="$(mktemp)"
cat > "$CONTENT_TMP" <<SECEOF
## AxMem memory governance

- Governed memory dir: \`$AXMEM_MEMORY_DIR\` (entry form: docs/DATA-CONTRACT.md in the AxMem repo).
- After ANY edit to a memory file, run: \`bash $ROOT/bin/axmem gate --block < /dev/null\` — exit 2 means fix the flagged debt before continuing.
- When the user makes a ruling, record it verbatim at that moment: \`bash $ROOT/bin/axmem receipt add user-ruling "<topic>" "<verbatim words>"\`.
- Before ending a work session: \`bash $ROOT/bin/axmem receipt pending\` — sediment then \`receipt cover --all\` (or \`--dismiss\` when genuinely disposable).
- Retirement = MOVE: never delete a memory entry without its verbatim text landing in the matching *-archive.md in the same commit (\`axmem precommit\` enforces).
SECEOF

if [ -n "$DRYRUN" ]; then
  fence_apply "$TARGET" "$CONTENT_TMP" axmem --dry-run --adapter codex
else
  fence_apply "$TARGET" "$CONTENT_TMP" axmem --adapter codex
fi
rc=$?
rm -f "$CONTENT_TMP"
if [ $rc -eq 0 ]; then
  [ -z "$DRYRUN" ] && echo "codex adapter: AxMem section written to $TARGET (idempotent; re-run refreshes it)"
else
  echo "codex adapter: refused to write $TARGET (duplicate/incomplete axmem markers — inspect and fix manually)" >&2
fi
exit $rc
