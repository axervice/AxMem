#!/usr/bin/env bash
# model-guard — 模型路由守卫的统一入口(A6,2026-08-20,v3 方案 the maintainer 全批)。
#
# 合并了 agent-model-guard(PreToolUse:Agent)与 workflow-model-guard(PreToolUse:Workflow)
# 的接线:同一个不变量(子代理派发必须显式带合法 model)在两个表面各有一套必然不同的
# 机械(JSON 字段检查 vs 脚本 AST 解析),**实现保持两个文件不动**,这里只做按 tool_name
# 的分发 —— 行为保持式合并(codex 终审 A6:2h 上限,禁止扩语法/解析器/判断规则)。
#
# ❄️ 冻结(试用期至 2026-10-14,= 八周观察终点):不再投入任何改造;试用期内再出一次
# 过拦或自修 → 直接进退役评估(codex:今天的一次成功不抵销历史 10 漏 6 过拦)。
#
# fail-closed:读不到 stdin / 认不出 tool_name = deny,与两个实现的既有哲学一致。
set -uo pipefail
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

# --self-test(供 guard-canary 名册调用;引号全部原生,不经任何外层转义)
if [ "${1:-}" = "--self-test" ]; then
  ok=0
  printf '%s' '{"tool_name":"Mystery","tool_input":{}}' | bash "$0" | grep -q "无法识别 tool_name" && ok=$((ok+1))
  printf '%s' '{"tool_name":"Agent","tool_input":{"prompt":"x"}}' | bash "$0" | grep -q '"deny"' && ok=$((ok+1))
  printf '%s' '{"tool_name":"Agent","tool_input":{"prompt":"x","model":"sonnet"}}' | bash "$0" | grep -q '"deny"' || ok=$((ok+1))
  [ "$ok" -eq 3 ] && { echo "model-guard 分发器自证 3/3"; exit 0; } || { echo "model-guard 分发器自证 ${ok}/3 ✗"; exit 1; }
fi

INPUT="$(cat)" || deny "守卫自身故障(model-guard 分发器): 读取 stdin 失败 -- fail-closed"
[ -n "$INPUT" ] || deny "守卫自身故障(model-guard 分发器): stdin 为空 -- fail-closed"

# tool_name 提取:只认最外层第一个 "tool_name":"..."(两种事件的 JSON 都由 Claude Code 生成,
# 形状稳定;提取失败按 fail-closed 处理,不猜)
TOOL="$(printf '%s' "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"

case "$TOOL" in
  Agent)    printf '%s' "$INPUT" | exec bash "$G/agent-model-guard.sh" ;;
  Workflow) printf '%s' "$INPUT" | exec bash "$G/workflow-model-guard.sh" ;;
  *)        deny "守卫自身故障(model-guard 分发器): 无法识别 tool_name(得到「${TOOL:-空}」)-- fail-closed 拒绝本次调用" ;;
esac
