#!/usr/bin/env bash
# AxMem generic adapter — scheduling recipe printer. (P1 2.2, 2026-09-16)
# NEVER installs anything on the operator's behalf ("不代执行"): this only
# PRINTS the cron line and the Windows schtasks command for `axmem doctor &&
# axmem canary` on a schedule. Requires --print explicitly so a bare
# invocation can never be mistaken for an action.
# Usage: schedule.sh --print
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$D/../.." && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  ok=0
  out="$(bash "${BASH_SOURCE[0]}" --print 2>&1)"; rc=$?
  [ "$rc" -eq 0 ] && ok=$((ok+1))
  printf '%s' "$out" | grep -q 'axmem doctor && .*axmem canary' && ok=$((ok+1))
  printf '%s' "$out" | grep -q '^0 9 \* \* \*' && ok=$((ok+1))
  printf '%s' "$out" | grep -qi 'schtasks' && ok=$((ok+1))
  bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; [ $? -eq 1 ] && ok=$((ok+1))
  if [ "$ok" -eq 5 ]; then echo "schedule self-test 5/5"; exit 0; else echo "schedule self-test $ok/5 FAIL"; exit 1; fi
fi

if [ "${1:-}" != "--print" ]; then
  echo "usage: schedule.sh --print   (prints cron/schtasks lines only — never installs anything)" >&2
  exit 1
fi

CMD="cd \"$ROOT\" && bash bin/axmem doctor && bash bin/axmem canary"

cat <<EOF
AxMem generic adapter — scheduling recipe (copy the one you need; nothing here is installed automatically)

# cron (POSIX / WSL / Git-Bash-with-cron):
0 9 * * * $CMD >> "$ROOT/.axmem-schedule.log" 2>&1

# Windows Task Scheduler (schtasks — run from an elevated or per-user prompt):
schtasks /Create /SC DAILY /ST 09:00 /TN "AxMem Doctor+Canary" /TR "bash -lc '$CMD'" /F
EOF
exit 0
