#!/usr/bin/env bash
# pmm-search-v2.sh — thin bash wrapper for pmm-search-v2.cjs (C05-BUILD-SPEC.md 交付物 6).
# 不改现有 pmm-search.sh(v1,融合通道);这是并行的 §3.2 影子排名引擎入口。
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/pmm-search-v2.cjs" "$@"
