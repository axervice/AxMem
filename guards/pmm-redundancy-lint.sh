#!/usr/bin/env bash
# pmm-redundancy-lint 包装器。用法: [--report|--json] | --self-test
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  mk() { printf '%s' "$1" > "$T/lessons.md"; printf '%s' "${2:-}" > "$T/decisions.md"; : > "$T/standinginstructions.md"; }
  run() { PMM_MEM_DIR="$T" node "$G/pmm-redundancy-lint.cjs" >/dev/null 2>&1; echo $?; }
  ok=0
  # 1 红 R1:sole-record 条目内同一 ≥12 字符汉语短语出现两次
  mk '**2026-01-01 — a** [a:x] [sole-record]
守卫必须在写入时刻当场拦截错误,然后再说别的;守卫必须在写入时刻当场拦截错误。
'
  [ "$(run)" -eq 2 ] && ok=$((ok+1))
  # 2 绿 R1 不管非 sole-record 条目(只报不拦)
  mk '**2026-01-01 — a** [a:x]
守卫必须在写入时刻当场拦截错误,然后再说别的;守卫必须在写入时刻当场拦截错误。
'
  [ "$(run)" -eq 0 ] && ok=$((ok+1))
  # 3 红 R2:两条目共享 ≥40 字符纯散文
  mk '**2026-01-01 — a** [a:x]
并发跑批绝不共用一个库也不共用一棵工作树,共库会出字节级相同的双订,共树会吞掉你的提交。
' '**2026-01-02 — b** [b:y]
并发跑批绝不共用一个库也不共用一棵工作树,共库会出字节级相同的双订,共树会吞掉你的提交。
'
  [ "$(run)" -eq 2 ] && ok=$((ok+1))
  # 4 绿 R2 不管引用行:同一枚迁移戳/路径行复用是纪律③鼓励的形态
  mk '**2026-01-01 — a** [a:x]
全文已迁 `~/Desktop/repo/CLAUDE.md`「PMM standing 迁入(2026-09-13)」节(dream §3,the maintainer 全批;Scope 限该项目,tag 不变可 grep)。
' '**2026-01-02 — b** [b:y]
全文已迁 `~/Desktop/repo/CLAUDE.md`「PMM standing 迁入(2026-09-13)」节(dream §3,the maintainer 全批;Scope 限该项目,tag 不变可 grep)。
'
  [ "$(run)" -eq 0 ] && ok=$((ok+1))
  # 5 红 R3:填充词
  mk '**2026-01-01 — a** [a:x]
综上所述,守卫要当场拦。
'
  [ "$(run)" -eq 2 ] && ok=$((ok+1))
  # 6 绿 逃生口:[redundancy-ok] 把命中降为不拦(进月审)
  mk '**2026-01-01 — a** [a:x] [sole-record] [redundancy-ok]
守卫必须在写入时刻当场拦截错误,然后再说别的;守卫必须在写入时刻当场拦截错误。
'
  [ "$(run)" -eq 0 ] && ok=$((ok+1))
  # 7 绿 重复用词≠冗余:术语/对照结构/标识符反复出现不拦(the maintainer 2026-09-14 问)
  mk '**2026-01-01 — a** [a:x] [sole-record]
建者≠审者;注入≠生效;闸有用、文字没用。收据由收据脚本落,收据被收据闸拦,`.env.local` 不动,`.env.local` 也不提交。
'
  [ "$(run)" -eq 0 ] && ok=$((ok+1))
  rm -rf "$T"
  if [ "$ok" -eq 7 ]; then echo "pmm-redundancy-lint 自证 7/7(R1/R2/R3 红 + 引用行/逃生口/重复用词 绿)"; exit 0; fi
  echo "✖ pmm-redundancy-lint 自证 $ok/7"; exit 1
fi
exec node "$G/pmm-redundancy-lint.cjs" "$@"
