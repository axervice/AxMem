#!/usr/bin/env bash
# PMM 检索 canary（2026-07-12，codex 审计 Top-2）：固定题库测三层检索召回，
# 把"感觉没漏"变成每周数字。每周 dream 任务自动跑；换机恢复后跑一遍即全链路验收。
# 全程 PMM_NO_HEAT=1 —— canary 查询绝不污染热度日志。
# 2026-07-12 恢复演练修正: 路径 $HOME 派生(原硬编码绝对路径换机全挂);
#   gbrain 未重建的机器(无 Ollama)语义题标 SKIP 不算 FAIL——文本层全过即达标线。
set -u
MEM="$HOME/.claude/memory"
SET="$MEM/_local-config/canary-set.tsv"
export PMM_NO_HEAT=1

GBRAIN_OK=0
[ -d "$HOME/.gbrain-pmm" ] && command -v gbrain >/dev/null 2>&1 && GBRAIN_OK=1

pass=0; fail=0; skip=0; failures=""
while IFS=$'\t' read -r type target query; do
  # 容忍 CRLF checkout(autocrlf=true 机器上尾部 \r 会让 grep 全 0 命中)——与 check-permanent.sh 同法
  type="${type%$'\r'}"; target="${target%$'\r'}"; query="${query%$'\r'}"
  case "$type" in ''|\#*) continue;; esac
  if [ "$type" = "semantic" ] && [ "$GBRAIN_OK" -eq 0 ]; then
    skip=$((skip+1)); continue
  fi
  ok=0
  if [ "$type" = "search" ]; then
    # 融合通道(2026-09-13 batch-1②):pmm-search 双通道输出里含目标 tag 即过。
    # 不因 gbrain 缺席 SKIP——文本半边独立可过,这正是融合的意义。
    out=$(bash "$MEM/_local-config/pmm-search.sh" "$query" 2>/dev/null || true)
    printf '%s' "$out" | grep -qF "$target" && ok=1
  elif [ "$type" = "text" ]; then
    out=$(bash "$MEM/_local-config/pmm-grep.sh" "$target" "$query" 2 2>/dev/null || true)
    printf '%s' "$out" | grep -q "来源:" && ok=1
  else
    # 取前 8 条**结果**(每条以 `[score]` 开头),不是前 8 行 —— 原写法 `head -8` 在结果正文换行时
    # 只覆盖到第 4 条(2026-08-02 dream C3 实测:decisions/lessons 切片后页数变多,目标掉到第 4-5 名
    # 就被截掉,报出两个假 FAIL)。题库注释一直写的是"前 8 行含 target"，实际意图是前 8 条。
    out=$(bash "$MEM/_local-config/pmm-recall.sh" "$query" 2>/dev/null | grep '^\[' | head -8 || true)
    printf '%s' "$out" | grep -q "$target" && ok=1
  fi
  if [ "$ok" -eq 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); failures="${failures}
FAIL[$type] $target ← $query"; fi
done < "$SET"

echo "PMM canary: ${pass} PASS / ${fail} FAIL / ${skip} SKIP (共 $((pass+fail+skip)) 题, $(date +%F))"
[ "$skip" -gt 0 ] && echo "(SKIP=gbrain 语义层未在本机重建——无 Ollama 时按 RESTORE.md 属预期,文本层全过即达标)"
if [ -n "$failures" ]; then
  echo "$failures"
  echo "→ FAIL 项按 [pmm:retrieval-first] 第 4 条调查;确属检索缺口则记 dreams/retrieval-misses.md。"
fi
