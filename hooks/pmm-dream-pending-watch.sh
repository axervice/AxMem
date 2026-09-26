#!/usr/bin/env bash
# PMM dream 提案待审看门狗（2026-07-12，记忆迭代收尾）
# SessionStart 注入:dreams/ 下存在【没有「## 应用记录」段】的提案 = 待 the maintainer 审批,
# 提醒本会话的 agent 主动整理成选择题向 the maintainer 发起审批,别等人想起来。
# 约定:提案被处理(应用或明确否决)后必须在文件尾追加「## 应用记录」段 → 本看门狗即静默。
# 2026-08-02 dream C1:标题层级放宽到 #/##/### —— 07-28 提案的完结章写成 `# 应用记录`(H1),
# 而这里只认 `^## `,导致已闭环的提案每次开局仍被报「待审批」(误报了整整两天)。
DIR="$HOME/.claude/memory/dreams"
[ -d "$DIR" ] || exit 0
pending=""
for f in "$DIR"/20??-??-??-proposal.md; do
  [ -f "$f" ] || continue
  grep -qE '^#{1,3} 应用记录' "$f" || pending="$pending $(basename "$f")"
done
if [ -n "$pending" ]; then
  echo "<!-- pmm-dream-pending -->"
  echo "⏳ 有未审批的 dream 记忆压缩提案:$pending"
  echo "   → 本会话 agent 应主动向 the maintainer 发起审批:读提案、按风险分档整理成选择题(AskUserQuestion)、批准后应用并在提案尾部追加「## 应用记录」段。不要等 the maintainer 自己想起来。"
fi

# dream 停摆检测。2026-08-19 codex 终审 A4:dream 从 weekly cron 降为**月度手动、headless、只跑计数类**
# (判断类 10 项错 5 已实证;计数类字节级全对)。阈值随节奏 8→35 天。
# 注意:双机 git 会重写 mtime,故此灯只作提醒,绝不当「完成证明」用(codex 终审点名的坑)。
newest=$(ls -t "$DIR"/20??-??-??-proposal.md 2>/dev/null | head -1)
if [ -n "$newest" ]; then
  age_days=$(( ( $(date +%s) - $(stat -c %Y "$newest" 2>/dev/null || echo 0) ) / 86400 ))
  if [ "$age_days" -gt 35 ]; then
    echo "<!-- pmm-dream-stale -->"
    echo "⚠️ 最新 dream 提案已 ${age_days} 天(>35):月度 dream 该跑了 —— 手动 headless 跑一次(只出计数类提案)。"
  fi
fi
exit 0
