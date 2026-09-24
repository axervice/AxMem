#!/usr/bin/env bash
# plugin-cache-instruction-scan.sh — thin wrapper for plugin-cache-instruction-scan.cjs
# (same shape as pmm-bash-impression.sh / pmm-trigger-write-gate.sh).
#
# 只报不拦:插件缓存(~/.claude/plugins/cache/**/*.md)里可能夹带对 agent 下达的条件指令
# (如「if encounter X, run `cmd`」)。这台守卫不改缓存文件(插件更新即覆盖,改了也没用),
# 只做可见性——扫描 + 打印命中 + 与上次快照比对的新增/消失计数。默认模式退出码恒 0,
# 无论命中多少条都不算失败;--self-test 才是真正会变红的那条(证明探测逻辑没坏,供
# guard-canary 名册接线,标 [report-only] 以示与拦截型守卫的区别)。
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  node "$G/plugin-cache-instruction-scan.cjs" --self-test
  exit $?
fi

node "$G/plugin-cache-instruction-scan.cjs" "$@"
exit 0
