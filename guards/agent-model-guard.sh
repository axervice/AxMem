#!/usr/bin/env bash
#
# guard ID: agent-model-guard
#
# Invariant protected:
#   Every Claude Code `Agent` (subagent dispatch) tool call must carry an
#   explicit, non-empty, non-"inherit" `model` in tool_input, AND the
#   environment variable CLAUDE_CODE_SUBAGENT_MODEL must be unset/empty
#   (it outranks a per-call `model` and would silently override it).
#   Rationale: a subagent dispatched without an explicit model inherits the
#   parent session's (possibly expensive) model. This has already happened
#   3 times; once it burned a 5-hour quota in 30 minutes across 16 light
#   subagent tasks.
#
# Enforcement point:
#   Claude Code PreToolUse hook, matcher = "Agent". Reads the hook input
#   JSON ({"tool_name":"Agent","tool_input":{...}}) from stdin and writes
#   a PreToolUse permission-decision JSON to stdout when denying. On
#   allow, it is completely silent (no stdout) and exits 0.
#
# Fail-closed policy:
#   Any internal failure of this guard itself (stdin unreadable, JSON
#   parse failure, missing `node`, node crashing, unexpected input shape)
#   MUST deny, never silently allow. There is no "on error, exit 0 and
#   let the call through" path in this script by design.
#
# Known bypasses (not fixable from inside this hook — out of scope):
#   - Hooks disabled entirely (e.g. via settings, --no-hooks-equivalent,
#     or the hooks config being removed/renamed).
#   - A different Claude Code config/settings directory that doesn't wire
#     this hook (e.g. a project-local settings.json without the entry, or
#     CLAUDE_CONFIG_DIR pointed elsewhere).
#   - Direct use of the Claude Agent SDK / API, bypassing the CLI's hook
#     pipeline entirely.
#   - `claude --agent` main-session mode: there is no `Agent` tool call
#     for this hook to intercept in that mode.
#
set -u

GUARD_ID="agent-model-guard"

# Emit a PreToolUse deny decision and exit 0 (per the PreToolUse output
# protocol: the JSON on stdout carries the decision; the hook process
# itself is considered to have run successfully).
emit_deny() {
  local reason="$1"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

# Fail-closed helper: any error inside THIS script (not a normal policy
# deny) routes through here so it is unmistakably labeled as a guard
# malfunction rather than a normal policy rejection.
fail_closed() {
  emit_deny "守卫自身故障(${GUARD_ID}): $1 -- 已 fail-closed 拒绝本次 Agent 调用,请检查 hook 环境或联系维护者。"
}

# node is required (no jq dependency per contract; project environment
# guarantees node is present). If it isn't, that's a guard malfunction.
command -v node >/dev/null 2>&1 || fail_closed "找不到 node 可执行文件"

INPUT="$(cat)"

NODE_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/agent-model-guard.XXXXXX.js" 2>/dev/null)" || fail_closed "无法创建临时解析脚本"
trap 'rm -f "$NODE_SCRIPT"' EXIT

cat > "$NODE_SCRIPT" <<'NODE_EOF'
const fs = require('fs');

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

let raw;
try {
  raw = fs.readFileSync(0, 'utf8');
} catch (e) {
  deny('守卫自身故障(agent-model-guard): 读取 stdin 失败(' + e.message + ') -- 已 fail-closed 拒绝本次 Agent 调用。');
}

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  deny('守卫自身故障(agent-model-guard): hook 输入 JSON 解析失败,疑似损坏 -- 已 fail-closed 拒绝本次 Agent 调用。');
}

if (data === null || typeof data !== 'object' || Array.isArray(data)) {
  deny('守卫自身故障(agent-model-guard): hook 输入不是 JSON 对象 -- 已 fail-closed 拒绝本次 Agent 调用。');
}

const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input))
  ? data.tool_input
  : null;

if (toolInput === null) {
  deny('守卫自身故障(agent-model-guard): hook 输入缺少 tool_input 字段 -- 已 fail-closed 拒绝本次 Agent 调用。');
}

// --- core invariant check: model must be explicit, non-empty, non-inherit ---
const model = toolInput.model;
// POSITIVE validity check (fail-closed). Anything that is not a non-empty,
// non-"inherit" STRING is denied — this deliberately also catches non-string
// shapes (number / object / array / boolean) that an earlier negative-condition
// formulation (missing || empty || inherit) silently let through.
const modelValid = (typeof model === 'string')
  && model.trim() !== ''
  && model.trim().toLowerCase() !== 'inherit';

if (!modelValid) {
  deny('子代理必须显式指定 model 字符串(缺失/空/inherit/非字符串 都会继承主会话贵模型,曾 30min 烧光 5h 配额)。请重新派发并加上 model:"sonnet"(机械活)或 model:"opus"(高风险审查)。');
}

// --- env var precedence check: CLAUDE_CODE_SUBAGENT_MODEL outranks tool_input.model ---
const envModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
const envOverrideActive = (typeof envModel === 'string' && envModel.trim().length > 0);

if (envOverrideActive) {
  deny('环境变量 CLAUDE_CODE_SUBAGENT_MODEL="' + envModel + '" 已设置,其优先级高于本次调用显式指定的 model,会让 model:"' + model + '" 失效。请先 unset CLAUDE_CODE_SUBAGENT_MODEL 再重新派发子代理。');
}

// allow: silent, no stdout, exit 0
process.exit(0);
NODE_EOF

# NOTE: stdout ONLY. Do NOT merge stderr (2>&1) into OUTPUT — stdout carries the
# PreToolUse JSON protocol, and any node stderr noise (deprecation warnings,
# ExperimentalWarning, etc.) would be echoed as if it were protocol output and
# corrupt the JSON. stderr flows to the hook's own stderr, which Claude Code
# surfaces separately without parsing it.
OUTPUT="$(printf '%s' "$INPUT" | node "$NODE_SCRIPT")"
NODE_EXIT=$?

if [ "$NODE_EXIT" -ne 0 ]; then
  fail_closed "node 解析脚本异常退出(exit code=${NODE_EXIT})"
fi

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi

exit 0
