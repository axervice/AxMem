#!/usr/bin/env bash
# pmm-heat-collect.sh — PostToolUse(Bash|Read|Grep) 被动热度采集（2026-07-25 the maintainer 拍板）
# 背景: 主动包装器(pmm-grep)两周零采集——会话检索记忆走的是 Read/Grep 原生工具。
# 本 hook 把热度遥测变成无感被动: 凡工具调用触及 ~/.claude/memory/ 的内容文件即记一行。
# 铁律: 永不阻塞(恒 exit 0)、永不输出(不污染上下文)、有界读 stdin、排除包装器防双计。
# 日志格式(与 dream 报表兼容): date \t file \t key
#   key 语义: Grep 工具=检索 pattern(定点检索,高权重) · READ=整文件读(可能是维护基线,低权重) · bash=shell 检索
set -u
LOG="$HOME/.claude/memory/dreams/access-log.tsv"

IN=$(head -c 20000 2>/dev/null) || exit 0
[ -n "$IN" ] || exit 0

# 排除: 包装器自带日志(防双计)、canary、同步/维护脚本、dreams/ 与 _local-config 自身
case "$IN" in
  *pmm-grep.sh*|*pmm-recall.sh*|*pmm-canary*|*gbrain-sync-pmm*|*access-log*|*DREAM-PROMPT*|*_local-config*|*retrieval-misses*) exit 0;;
esac

# 只关心 memory 内容文件(含归档);路径可能是 /、\\(JSON 转义) 或混合
FILE=$(printf '%s' "$IN" | grep -oE '(decisions|lessons|standinginstructions|timeline|progress|memory|processes|preferences|assets|graph|taxonomies|voices|summaries)(-archive)?\.md' | head -1)
[ -n "$FILE" ] || exit 0
printf '%s' "$IN" | grep -qE '\.claude[/\\]+memory[/\\]' || exit 0

# 2026-07-25 codex R3 瘦身: 只留 Grep pattern 通道——bash/READ 键无定位价值(实测 31 条中 27 条),
# 支撑不了升降决策还稀释信号;包装器(pmm-grep/recall)继续自记明确键。matcher 已同步缩为 Grep。
TOOL=$(printf '%s' "$IN" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ "$TOOL" = "Grep" ] || exit 0
KEY=$(printf '%s' "$IN" | grep -oE '"pattern"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/^"pattern"[[:space:]]*:[[:space:]]*"//; s/"$//' | tr '\t\n' '  ' | cut -c1-60)
[ -n "$KEY" ] || exit 0

FBASE="${FILE%.md}"
printf '%s\t%s\t%s\n' "$(date +%F)" "$FBASE" "$KEY" >> "$LOG" 2>/dev/null || true
exit 0
