#!/usr/bin/env bash
# AxMem redundancy-lint wrapper. Usage: [--report|--json] | --self-test
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  mk() { printf '%s' "$1" > "$T/lessons.md"; printf '%s' "${2:-}" > "$T/decisions.md"; : > "$T/standinginstructions.md"; }
  run() { AXMEM_MEMORY_DIR="$T" node "$G/redundancy-lint.cjs" >/dev/null 2>&1; echo $?; }
  ok=0
  # 1 red R1: a sole-record entry repeats the same >=12-char Han phrase twice
  mk '**2026-01-01 — a** [a:x] [sole-record]
守卫必须在写入时刻当场拦截错误,然后再说别的;守卫必须在写入时刻当场拦截错误。
'
  [ "$(run)" -eq 2 ] && ok=$((ok+1))
  # 2 green: R1 does not block non-sole-record entries (report only)
  mk '**2026-01-01 — a** [a:x]
守卫必须在写入时刻当场拦截错误,然后再说别的;守卫必须在写入时刻当场拦截错误。
'
  [ "$(run)" -eq 0 ] && ok=$((ok+1))
  # 3 red R2: two entries share >=40 chars of pure prose
  mk '**2026-01-01 — a** [a:x]
并发跑批绝不共用一个库也不共用一棵工作树,共库会出字节级相同的双订,共树会吞掉你的提交。
' '**2026-01-02 — b** [b:y]
并发跑批绝不共用一个库也不共用一棵工作树,共库会出字节级相同的双订,共树会吞掉你的提交。
'
  [ "$(run)" -eq 2 ] && ok=$((ok+1))
  # 4 green: R2 ignores reference lines — the same migration-stamp/path line
  #   reused across entries is the shape rule 3 encourages
  mk '**2026-01-01 — a** [a:x]
全文已迁 `~/Desktop/repo/CLAUDE.md`「PMM standing 迁入(2026-09-13)」节(dream §3,the maintainer 全批;Scope 限该项目,tag 不变可 grep)。
' '**2026-01-02 — b** [b:y]
全文已迁 `~/Desktop/repo/CLAUDE.md`「PMM standing 迁入(2026-09-13)」节(dream §3,the maintainer 全批;Scope 限该项目,tag 不变可 grep)。
'
  [ "$(run)" -eq 0 ] && ok=$((ok+1))
  # 5 red R3: filler word
  mk '**2026-01-01 — a** [a:x]
综上所述,守卫要当场拦。
'
  [ "$(run)" -eq 2 ] && ok=$((ok+1))
  # 6 green escape hatch: [redundancy-ok] downgrades hits to non-blocking (audited monthly)
  mk '**2026-01-01 — a** [a:x] [sole-record] [redundancy-ok]
守卫必须在写入时刻当场拦截错误,然后再说别的;守卫必须在写入时刻当场拦截错误。
'
  [ "$(run)" -eq 0 ] && ok=$((ok+1))
  # 7 green: repeated WORDS != redundancy — terms/contrasts/identifiers recurring must not block
  mk '**2026-01-01 — a** [a:x] [sole-record]
建者≠审者;注入≠生效;闸有用、文字没用。收据由收据脚本落,收据被收据闸拦,`.env.local` 不动,`.env.local` 也不提交。
'
  [ "$(run)" -eq 0 ] && ok=$((ok+1))
  rm -rf "$T"
  if [ "$ok" -eq 7 ]; then echo "redundancy-lint self-test 7/7 (R1/R2/R3 red + reference-line/escape-hatch/repeated-terms green)"; exit 0; fi
  echo "redundancy-lint self-test $ok/7 FAIL"; exit 1
fi
exec node "$G/redundancy-lint.cjs" "$@"
