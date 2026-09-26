#!/usr/bin/env bash
# PMM injection-size watchdog (SessionStart hook).
# MEASURES the PMM session-start injection and, ONLY when it exceeds THRESHOLD,
# prints a one-line reminder into context. It NEVER modifies memory — the actual
# compression stays a careful manual step (see standinginstructions rule 6).
# Tunable: change THRESHOLD below. Baseline at install: ~43,107 tokens (2026-06-07).
# 2026-06-10 condense pass: injection ≈37.7k; threshold lowered 50000→40000.
# 2026-06-12: raised to 50000 to hold the M11 per-phase state block as a
# compaction-resilient anti-drift store for the builder CC window. TEMPORARY.
# 2026-06-13: M11 COMPLETE — 降指针 done (M11 block compressed to a milestone
# summary in progress.md); threshold dropped back 50000→40000.
# 2026-06-14: raised back to 50000 per user instruction.
# 2026-06-19: raised 50000->60000 per user (the maintainer: "进程越来越多记忆也越来越多").
#   M14/M14.5 build detail already pointer-ized (progress.md -61%, @bc87bc3); the
#   remaining ~52k is effective memory (decisions/lessons per standinginstructions
#   2026-06-15 must stay at-hand). 60k = headroom for legitimate multi-project growth.
# 2026-06-24: raised 60000->70000 per user (the maintainer) — M18 commercialization added
#   real billing decisions/lessons that must stay at-hand; condense still deferred.
# 2026-06-28: condense pass done (M18-merged status fix + progress 降指针 + M7
#   lessons/decisions 归档 + timeline 2026-06-01~07 旧事件移 timeline-archive);
#   injection 82.7k->~75k. Raised 70000->80000 per user (the maintainer) — remaining bulk is
#   2026-06-15-protected key decisions + active-project state that must stay resident.
# 2026-07-04: raised 80000->90000 per user (the maintainer, 路2). 现 4 大活跃项目(Axervice 等)
#   +example-project 的活跃决策+状态按治理常驻;本轮已: example-project 段滚动化 / example-project 段压缩(-9.7k) /
#   decisions 完工类压到 invariant 地板 / 装 ≤80词守卫(pmm-entry-length-watch)+监督loop滚动铁律防真回胖。
#   ~85k = 当前合理常驻地板,90k 留头。再撞线 = 先看 pmm-entry-length 站桩数(有没有虚胖)+ 完工里程碑收尾压缩。
# 2026-07-12: lowered 90000->50000 per user (the maintainer) — 检索化改造收官(Index 化+冷热分层
#   +gbrain 定位器+热冷全搜),注入地板 85k→~36k(-58%);50k = 新地板 + ~40% 增长余量。
#   再撞线 = 先跑 dream 提案清积压(1B/1C/Kernel 压缩),而不是直接上调阈值。
THRESHOLD=50000

cd "$HOME/.claude" 2>/dev/null || exit 0
PMM=$(ls -d plugins/cache/claude-community/pmm/*/ 2>/dev/null | tail -1)
[ -z "$PMM" ] && exit 0
export CLAUDE_PLUGIN_ROOT="$HOME/.claude/${PMM%/}"

OUT=$(bash "${PMM}hooks/scripts/session-start.sh" 2>/dev/null) || exit 0
TOTAL=$(printf '%s' "$OUT" | wc -c)
ASCII=$(printf '%s' "$OUT" | LC_ALL=C grep -o '[ -~]' | wc -l)
TOK=$(( ASCII/4 + (TOTAL-ASCII)/3 ))

# ── Kernel canary ─────────────────────────────────────────────────────────────
# 工作流协议必须**每次都真的在注入里**。这不是假设性担忧:2026-07-15~07-25 它就掉出去过
# 十天(挂在 standinginstructions 的无标题列表块里、不入 Kernel、各会话不可见),
# 那是双机「忘工作流」的根因,07-25 才移进 Hot 段修好。
# 后续任何一次瘦身都可能把它再推到 `## Entries(不注入)` 线以下,而**掉下去是静默的**。
# 这里查的是注入器的真实 stdout($OUT,上面已经拿到),不是行号近似,也不额外起进程。
KERNEL_MISS=""
for _k in "process:workflow-current" "建者≠审者" "最高质量优先"; do   # 2026-08-20 A1 合并后 tag 换代;「最高质量优先」缺失曾真抓到合并丢内容
  printf '%s' "$OUT" | grep -q -- "$_k" || KERNEL_MISS="$KERNEL_MISS 「$_k」"
done
if [ -n "$KERNEL_MISS" ]; then
  echo "<!-- pmm-kernel-canary -->"
  echo "🔴 工作流协议**不在本次注入里**,缺:${KERNEL_MISS}"
  echo "   多半是某次瘦身把它推到了 standinginstructions.md 的「## Entries(不注入)」线以下。"
  echo "   这正是 2026-07-15~07-25「忘工作流」十天的根因。**先把它移回 ## Hot(注入段),再继续干活。**"
fi

if [ "$TOK" -gt "$THRESHOLD" ]; then
  echo "<!-- pmm-watchdog -->"
  echo "⚠️ PMM 启动注入 ≈ ${TOK} tokens(超过阈值 ${THRESHOLD})。该做一次里程碑收尾压缩了:"
  echo "对已完工里程碑的 PMM 条目,先 grep Axervice CHANGELOG 确认细节已覆盖,再压成"
  echo "「决策+关键理由+→CHANGELOG@commit」(standinginstructions 规则6);CHANGELOG 没有的、"
  echo "PMM 独有的(反转/教训/风险)原样保留,绝不丢。也可跑 consolidate-memory。"
fi
exit 0
