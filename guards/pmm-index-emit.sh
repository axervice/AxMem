#!/usr/bin/env bash
# pmm-index-emit.sh --shadow — C05-BUILD-SPEC.md 交付物 5. 薄壳:所有逻辑在 pmm-index-emit.cjs。
# 不接进 SessionStart(交付物 5 原文);建造期间不得在真根直接跑本脚本(见简报 B4 本波增量①)。
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$G/pmm-index-emit.cjs" "$@"
