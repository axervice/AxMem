#!/usr/bin/env bash
# E-sup 取代记账夹具(2026-09-13):声明 Supersedes 而旧条 Index 未标 → 必拦;标了 → 必过。
# 供 guard-canary 名册调用;经 env override 跑夹具目录,不碰真记忆/真基线。
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./pmm-home.sh
source "$G/pmm-home.sh"
T="$(mktemp -d)"
printf '## Index\n\n- 2026-01-01 [a:old] o\n- 2026-01-02 [a:new] n\n\n## Entries\n\n**2026-01-01 — o** [a:old]\nb\n\n**2026-01-02 — n** [a:new]\nb\nSupersedes: [[a:old]]\n' > "$T/lessons.md"
printf '## Index\n\n## Entries\n' > "$T/decisions.md"
cp "$T/decisions.md" "$T/standinginstructions.md"
echo 9 > "$T/state"
PMM_MEM_DIR="$T" PMM_STATE_FILE="$T/state" bash "$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh" --block </dev/null >/dev/null 2>&1; r1=$?
sed -i 's/\[a:old\] o$/[a:old] o (superseded→[a:new])/' "$T/lessons.md"
PMM_MEM_DIR="$T" PMM_STATE_FILE="$T/state" bash "$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh" --block </dev/null >/dev/null 2>&1; r2=$?
rm -rf "$T"
if [ "$r1" -eq 2 ] && [ "$r2" -eq 0 ]; then echo "E-sup 红拦绿放 2/2"; exit 0; fi
echo "✖ E-sup 夹具:red=$r1(want 2) green=$r2(want 0)"; exit 1
