#!/usr/bin/env bash
# pmm-pointer-lint 包装器 — 逻辑在同目录 .cjs(node 解析,免 bash 正则/转义地狱)。
# 用法: pmm-pointer-lint.sh [--strict] | --self-test
set -uo pipefail
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  mkdir -p "$T/mem/dreams" "$T/perm"
  GOOD="$T/mem/target-exists.md"
  printf '# 靶文件\n' > "$GOOD"
  {
    printf '%s\n' '## Index'
    printf '%s\n' '- 2026-01-01 [test:defined-tag] 好定义'
    printf '%s\n' '## Entries'
    printf '%s\n' '**2026-01-01 — 好定义** [test:defined-tag]'
    printf '%s\n' '正文引用 [[test:defined-tag]] 应通过;引用 [[test:missing-tag]] 应报悬空。'
    # 2026-09-13 Opus P2:好路径原用 /tmp 绝对形态,被 PATHISH 白名单直接跳过 → "不误报"半边
    # 从没被测过(自测只证了能红)。改 ~/ 形态,真走 resolveCandidates。
    printf '%s\n' '好路径 `~/mem/target-exists.md` 应通过;坏路径 `~/.claude/no-such-file-xyz.md` 应报断链。'
  } > "$T/mem/decisions.md"
  : > "$T/mem/lessons.md"; : > "$T/mem/standinginstructions.md"
  out="$(PMM_HOME="$T" PMM_MEM_DIR="$T/mem" PMM_PERMANENT_DIR="$T/perm" node "$G/pmm-pointer-lint.cjs")"
  rm -rf "$T"
  a="$(printf '%s' "$out" | grep -o 'DANGLING_TAGS=[0-9]*' | cut -d= -f2)"
  c="$(printf '%s' "$out" | grep -o 'BROKEN_PATHS=[0-9]*' | cut -d= -f2)"
  if [ "$a" = "1" ] && [ "$c" = "1" ]; then
    echo "pmm-pointer-lint 自证 2/2(悬空1/断链1 被捕,好路径经真解析未误报)"; exit 0
  else
    echo "✖ pmm-pointer-lint 自证失败: dangling=$a broken=$c(期望 1/1;broken=2 = 好路径解析回归)"; printf '%s\n' "$out"; exit 1
  fi
fi

exec node "$G/pmm-pointer-lint.cjs" "$@"
