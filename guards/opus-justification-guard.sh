#!/usr/bin/env bash
#
# guard ID: opus-justification-guard(2026-08-24 上线,起因:杀虫专家一阶段 17 个整波 opus
#   派单零拦截,the maintainer 问「守卫有没有提醒你」—— 答案是守卫在但只查「显式」不查「档位」)
#
# 不变量:
#   Agent 派发若用贵模型(model 不是 sonnet/haiku),prompt 或 description 里必须带
#   [OPUS:一句话理由] 标记 —— 强迫派发者在派发时刻说清这一项为什么配贵模型。
#   依据: 记忆 feedback-no-wave-level-model-inflation(the maintainer 2026-08-24「能不能贯彻执行
#   我们省token的方针?」)+ 档位表 feedback-report-the-model-and-route-per-stage。
#   判定单位是**项**不是**波**; 机械活默认 sonnet。
#
# 与冻结的 model-guard 家族的关系(并列,零改动):
#   model-guard.sh / agent-model-guard.sh / workflow-model-guard.sh 冻结至 2026-10-14,
#   本守卫是 settings.json 里独立的第二个 PreToolUse:Agent 条目,不经过那个分发器。
#   那一家管「model 必须显式」; 本守卫管「贵模型必须有理由」。model 缺失时本守卫沉默
#   (那一家已 deny,避免双重报错)。
#
# fail-OPEN(与那一家的 fail-closed 刻意相反,理由要留在这):
#   这是成本闸不是安全闸。守卫自身故障时放行 + stderr 报警 —— 那一家历史 6 次过拦
#   差点整族退役; 宁可漏放一次贵派发,不可把全部派发挡死。
#
# 已知逸出面(记录,不修):
#   - Workflow 脚本里的 opts.model:'opus'(JS 语法,非 JSON 键,本 grep 不匹配)——
#     由冻结的 workflow-model-guard 管显式性,档位面等解冻再议。
#   - hooks 被禁用 / 别的 CLAUDE_CONFIG_DIR / SDK 直连 —— 与那一家相同,闸外。
set -u

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

# --self-test(供 guard-canary 名册调用)
if [ "${1:-}" = "--self-test" ]; then
  ok=0
  printf '%s' '{"tool_name":"Agent","tool_input":{"model":"opus","prompt":"x"}}' | bash "$0" | grep -q '"deny"' && ok=$((ok+1))
  [ -z "$(printf '%s' '{"tool_name":"Agent","tool_input":{"model":"opus","prompt":"[OPUS:钱路状态机判断活] x"}}' | bash "$0")" ] && ok=$((ok+1))
  [ -z "$(printf '%s' '{"tool_name":"Agent","tool_input":{"model":"sonnet","prompt":"x"}}' | bash "$0")" ] && ok=$((ok+1))
  [ "$ok" -eq 3 ] && { echo "opus-justification-guard 自证 3/3"; exit 0; } || { echo "opus-justification-guard 自证 ${ok}/3 ✗"; exit 1; }
fi

INPUT="$(cat 2>/dev/null)" || { echo "opus-justification-guard: stdin 读取失败,fail-open 放行" >&2; exit 0; }
[ -n "$INPUT" ] || { echo "opus-justification-guard: stdin 为空,fail-open 放行" >&2; exit 0; }

# model 提取: 只有真 JSON 键能命中 —— prompt 字符串值内部的引号被转义为 \",不会匹配本模式
MODEL="$(printf '%s' "$INPUT" | grep -o '"model"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"

# model 缺失 → agent-model-guard 已 deny,本守卫沉默
[ -n "$MODEL" ] || exit 0

case "$MODEL" in
  sonnet|haiku|claude-sonnet-*|claude-haiku-*) exit 0 ;;
esac

# 贵模型(opus/fable/其余显式 ID): 要求理由标记(大小写不敏感,prompt 或 description 均可)
printf '%s' "$INPUT" | grep -qi '\[OPUS:' && exit 0

deny "省token方针(feedback-no-wave-level-model-inflation): model=「${MODEL}」属贵档,派发时必须在 prompt 里带 [OPUS:一句话理由] 标记(例: [OPUS:钱路状态机判断活])。机械活(照模式抄/注册/i18n key/一行修/文档)请改 model:「sonnet」。判定单位是项不是波。"
