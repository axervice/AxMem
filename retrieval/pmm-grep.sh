#!/usr/bin/env bash
# PMM 检索包装器（2026-07-12 热度机制 + 热冷全搜，the maintainer 提议）
# 用法: pmm-grep.sh <decisions|lessons|standing|timeline|progress> "<tag 或标题关键词>" [N]
#   N = 上下文行数,默认 12。
# 行为: 逐字 grep 条目原文——**自动同时搜活跃文件 + 对应归档**（归档≠遗忘）,
#       命中标注来源;零命中时强制提示升级到 pmm-recall 语义全库查。
#       每次调用追加热度日志（dream 周报据此出冷热升降候选）。
set -u
[ $# -ge 2 ] || { echo "usage: pmm-grep.sh <decisions|lessons|standing|timeline|progress> \"<key>\" [N]" >&2; exit 1; }
MEM="$HOME/.claude/memory"  # $HOME 派生,跨机可移植(2026-07-12 恢复演练修正,原硬编码绝对路径)
case "$1" in
  decisions) FILES=("$MEM/decisions.md" "$MEM/decisions-archive.md") ;;
  lessons)   FILES=("$MEM/lessons.md" "$MEM/lessons-archive.md") ;;
  standing)  FILES=("$MEM/standinginstructions.md" "$MEM/standinginstructions-archive.md") ;;
  timeline)  FILES=("$MEM/timeline.md" "$MEM/timeline-archive.md") ;;
  progress)  FILES=("$MEM/progress.md") ;;
  *)         FILES=("$MEM/$1.md"); [ -f "$MEM/$1-archive.md" ] && FILES+=("$MEM/$1-archive.md") ;;
esac
KEY="$2"; N="${3:-12}"
# PMM_NO_HEAT=1 时不记热度(canary 每周 20 题跑测,绝不能污染真实调用信号)
[ "${PMM_NO_HEAT:-0}" = "1" ] || printf '%s\t%s\t%s\n' "$(date +%F)" "$1" "$KEY" >> "$MEM/dreams/access-log.tsv" 2>/dev/null || true

hits=0
for F in "${FILES[@]}"; do
  [ -f "$F" ] || continue
  # 优先锚定条目标题行(避开 Index 噪音);无命中退化为普通 grep
  out=$(grep -A"$N" "^\*\*.*${KEY}" "$F" 2>/dev/null | grep -v '^--$')
  [ -z "$out" ] && out=$(grep -B1 -A"$N" -- "$KEY" "$F" 2>/dev/null)
  if [ -n "$out" ]; then
    echo "===== 来源: $(basename "$F") ====="
    printf '%s\n' "$out"
    hits=1
  fi
done

if [ "$hits" -eq 0 ]; then
  echo "(0 hits in ${FILES[*]##*/})"
  echo "→ 下一步【必须】跑语义全库查(含全部归档): bash $MEM/_local-config/pmm-recall.sh \"用自然语言描述要找的内容\""
  echo "  仍无命中才允许称「记忆里没有」,并按 [pmm:retrieval-first] 第4条记 retrieval-misses。"
fi
