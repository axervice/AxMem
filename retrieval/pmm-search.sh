#!/usr/bin/env bash
# PMM 融合检索入口(2026-09-13,batch-1 ②,the maintainer 批 [memory:pmm-refine-batch1-approved])
# 病根:旧检索是阶梯(grep 有命中就不跑语义)——两通道各有盲区却互不补位;
#       codex 盲评点名「不要让 grep 有任意结果阻止语义检索」。
# 行为:文本(逐字,含归档,四类全搜)与语义(gbrain 定位器)**每次都跑**;
#       精确命中永远置顶;语义命中只是定位,引用前必 grep 原文([pmm:retrieval-first])。
# 热度:只记一行(file=search),内部 grep 全部 PMM_NO_HEAT——四类扇出若各记一行会稀释真实信号。
# KNOWN-CEILING(v1,声明不迭代):无模糊文本打分、无 entry 级 RRF 合并——语义命中映射回
#   条目 tag 需要 chunk→entry 反查,等 retrieval-misses 台账证明需要再建。
set -u
MEM="$HOME/.claude/memory"
[ $# -ge 1 ] || { echo "usage: pmm-search.sh \"<tag 或关键词或自然语句>\"" >&2; exit 1; }
Q="$1"

[ "${PMM_NO_HEAT:-0}" = "1" ] || printf '%s\t%s\t%s\n' "$(date +%F)" "search" "$Q" >> "$MEM/dreams/access-log.tsv" 2>/dev/null || true

echo "═══ 精确命中(逐字,含归档;置顶通道)═══"
hits=0
for t in decisions lessons standing processes; do
  out=$(PMM_NO_HEAT=1 bash "$MEM/_local-config/pmm-grep.sh" "$t" "$Q" 6 2>/dev/null || true)
  if printf '%s' "$out" | grep -q "来源:"; then
    printf '%s\n' "$out" | head -30
    hits=1
  fi
done
[ "$hits" -eq 0 ] && echo "(文本通道 0 命中)"

echo "═══ 语义定位(gbrain;命中后必 grep 原文确认)═══"
sem=$(PMM_NO_HEAT=1 bash "$MEM/_local-config/pmm-recall.sh" "$Q" 2>/dev/null | grep '^\[' | head -8 || true)
if [ -n "$sem" ]; then printf '%s\n' "$sem"; else echo "(语义通道 0 命中/未就绪)"; fi

if [ "$hits" -eq 0 ] && [ -z "$sem" ]; then
  echo "→ 双通道全空。仍需按 [pmm:retrieval-first] 记 dreams/retrieval-misses.md 才可称「记忆里没有」。"
fi
