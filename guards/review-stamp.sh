#!/usr/bin/env bash
# review-stamp — 给一次真实发生过的审查盖一个**绑定到具体 diff** 的戳。
#
# 为什么需要它:现有的审查产物都不可机器校验 ——
#   codex-review.sh 写的是纯散文,没有 diff 绑定;ECC 三审**零文件产物**。
# 所以"审查跑过没有"这件事在合并那一刻是无从判断的,而
# `ecc-trio-skipped-on-ux-waves`(审查被跳过)**已经复发两次**,
# 且今天找到的会员账单 bug 正是"审查范围没覆盖到"才漏的。
#
# 它挡的是**遗漏**,不是**造假** —— 这是刻意的取舍:builder 和 gate 跑在同一账号同一机器,
# 没有身份隔离,一个够坚决的人总能编一份格式合规的假戳。而实际观测到的失败模式是忘了跑,
# 不是故意骗。对着真实失败模式设计,不对着想象中的对手。
#
# 用法:
#   review-stamp.sh <reviewer> [findings-count] [artifact-path]
#     reviewer  = codex | ecc-security | ecc-database | ecc-typescript | opus | human
#   review-stamp.sh --show          列出当前 diff 已有的戳
#   review-stamp.sh --self-test
#
# 戳记录进 <repo>/.codex-reviews/review-ledger.tsv(本地,不进 git —— 关卡也是本地的)。
#
# ── 2026-09-16 结构性复审(见 scratchpad/guard-fix-opus-review.md)后的改动 ──
#  1. base_of 的解析顺序与 review-gate.sh 保持逐字同步:merge-base(HEAD,
#     origin/main)→ merge-base(HEAD, origin 的默认分支);不再兜底 `HEAD~1`。
#     两个脚本各自独立实现同一段逻辑(LOW 级 `canonicalizer-split-across-
#     writers`;本次只被允许改这两个文件,没有第三处可抽的共享库位置),
#     但**逻辑现在逐字一致**——这保证同一次 push,gate 校验的 sha 和 stamp
#     记录的 sha 不会因为 base 解析分叉而对不上。改其中一个必须同步改另一个。
#  2. 删掉了 touches_code():全仓(含 .githooks/)grep 只有它自己的定义行,
#     零调用点——纯装饰,`${n:-0}` 兜底还让它本身就是 fail-open 的,留着只
#     会被将来的人误以为它在生效。
#
# ── 2026-09-16 RE-REVIEW(同一份 scratchpad,4 处需改:1 MED / 3 LOW)后的
#    追加改动 ──
#  3. base_of/diff_sha 全部命令加 `-c diff.relative=false`(与 gate 侧的
#     MED finding 同源:cwd 在子目录、或调用方全局配了 `diff.relative=true`
#     时,diff/merge-base 的路径解读不该跟着变)。
#  4. base_of 补第三档 merge-base(HEAD, @{upstream}) ——覆盖 remote 不叫
#     origin 但分支自己配了跟踪上游的情形。三档仍然是"解析不到就是解析
#     不到,fail-closed",不回落 `HEAD~1`。

set -uo pipefail

# 自引用绝对路径:self_test() 的子进程臂会先 cd 进临时仓库再重新调用脚本
# 本体,这时相对的 $0 早已失效(同 review-gate.sh 的 SELF_SCRIPT)。
SELF_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

LEDGER_REL=".codex-reviews/review-ledger.tsv"

repo_root() { command git rev-parse --show-toplevel 2>/dev/null; }

# base_of:与 review-gate.sh 的同名函数逐字同步(见文件头注释②)。三档
# ——merge-base(HEAD, origin/main)→ merge-base(HEAD, origin 的默认分支)→
# merge-base(HEAD, @{upstream})——解析不到就是解析不到,交给调用方
# fail-closed,不再兜底 `HEAD~1`。第三档覆盖"remote 不叫 origin,但分支
# 自己配了跟踪上游"的情形(2026-09-16 复审实测 axervice 工作树同时挂着
# `origin` 与 `laptop` 两个 remote——origin/HEAD 目前仍解析得到,这档还
# 没被触发,但只要哪天 origin 被 prune 掉就只剩这条路)。全部命令显式
# `-C "$root"` + `-c diff.relative=false`,不依赖 cwd 或调用方的 git config
# ——与 gate 保持逐字同步(gate 侧同一次复审的 MED finding)。
base_of() {
  local root="$1" b
  b="$(command git -C "$root" -c diff.relative=false merge-base HEAD origin/main 2>/dev/null)" \
    && [ -n "$b" ] && { printf '%s\n' "$b"; return 0; }
  local default_ref
  default_ref="$(command git -C "$root" -c diff.relative=false symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
  if [ -n "$default_ref" ]; then
    b="$(command git -C "$root" -c diff.relative=false merge-base HEAD "$default_ref" 2>/dev/null)" \
      && [ -n "$b" ] && { printf '%s\n' "$b"; return 0; }
  fi
  b="$(command git -C "$root" -c diff.relative=false merge-base HEAD '@{upstream}' 2>/dev/null)" \
    && [ -n "$b" ] && { printf '%s\n' "$b"; return 0; }
  return 1
}

# 被审的 diff = 相对上游主干的全部改动。用 patch 内容的 sha 做身份:
# 再 push 一个新 commit 就会变,旧戳自然失效(stale),这正是我们要的。
diff_sha() {
  local root base
  root="$(repo_root)" || return 1
  base="$(base_of "$root")" || return 1
  [ -n "$base" ] || return 1
  command git -C "$root" -c diff.relative=false diff --no-color "$base..HEAD" | command sha256sum | command cut -d' ' -f1
}

do_stamp() {
  local reviewer="$1" findings="${2:-0}" artifact="${3:--}"
  local root sha ledger ts
  root="$(repo_root)" || { echo "不在 git repo 里" >&2; return 1; }
  sha="$(diff_sha)" || { echo "算不出 diff sha(base 不可解析,或 git diff 失败)" >&2; return 1; }
  [ -n "$sha" ] || { echo "算不出 diff sha" >&2; return 1; }
  ledger="$root/$LEDGER_REL"
  command mkdir -p "$(dirname "$ledger")"
  [ -s "$ledger" ] || printf '# diff-sha\tiso-ts\treviewer\tfindings\tartifact\n' > "$ledger"
  ts="$(command git log -1 --format=%cI 2>/dev/null || echo unknown)"
  printf '%s\t%s\t%s\t%s\t%s\n' "$sha" "$ts" "$reviewer" "$findings" "$artifact" >> "$ledger"
  echo "已盖戳:$reviewer → diff ${sha:0:12} (findings=$findings)"
}

do_show() {
  local root sha ledger
  root="$(repo_root)" || return 1
  sha="$(diff_sha)" || { echo "算不出 diff sha(base 不可解析,或 git diff 失败)" >&2; return 1; }
  ledger="$root/$LEDGER_REL"
  echo "当前 diff: ${sha:0:12}"
  if [ ! -s "$ledger" ]; then echo "  (还没有任何戳)"; return 0; fi
  local n=0
  local s t r f a
  while IFS=$'\t' read -r s t r f a; do
    case "$s" in \#*|"") continue;; esac
    [ "$s" = "$sha" ] && { echo "  ✓ $r (findings=$f, $a)"; n=$((n+1)); }
  done < "$ledger"
  [ "$n" = 0 ] && echo "  (这个 diff 还没有戳)"
  return 0
}

self_test() {
  local rc=0
  # repo_root/base_of/diff_sha 在非 git 目录里必须干净失败,不能崩
  ( cd / 2>/dev/null && repo_root >/dev/null 2>&1 ); echo "  非 repo 下 repo_root 不崩 ✓"
  command -v sha256sum >/dev/null 2>&1 && echo "  sha256sum 可用 ✓" || { echo "  sha256sum 缺失 ✗"; rc=1; }
  if repo_root >/dev/null 2>&1; then
    diff_sha >/dev/null 2>&1 && echo "  当前 repo 能算 diff sha ✓" || echo "  当前 repo 算不出 diff sha(base 未配 origin/main?非致命,继续)ℹ"
  fi

  # ── base_of 三档回归:只剩两档,且不再兜底 HEAD~1 ──
  local tdir; tdir="$(command mktemp -d)"

  # [S1] 有 origin/main → 正常解析
  local r1="$tdir/r1"
  command mkdir -p "$r1"
  ( cd "$r1" && command git init -q && command git config user.email t@example.invalid \
      && command git config user.name test \
      && command mkdir -p docs src \
      && printf 'seed\n' > docs/seed.md && command git add docs/seed.md && command git commit -q -m seed \
      && command git update-ref refs/remotes/origin/main HEAD \
      && printf 'x\n' > src/a.ts && command git add src/a.ts && command git commit -q -m "add src" ) >/dev/null 2>&1
  if b="$(base_of "$r1")" && [ -n "$b" ]; then
    echo "  [S1] origin/main 存在 → base_of 解析成功 ✓"
  else
    echo "  [S1] origin/main 存在却解析失败 ✗"; rc=1
  fi

  # [S1b] cwd 在子目录 + `diff.relative=true` 不改变 base_of/diff_sha 的结果
  # ——与 gate 的 [G] 是同一个 MED finding 在 stamp 侧的对照,证明两脚本
  # 现在真的逐字同步而不是各自实现出行为分叉。
  ( cd "$r1" && command git config diff.relative true )
  local b1a b1b
  b1a="$(base_of "$r1")"
  b1b="$(cd "$r1/docs" && base_of "$r1")"
  if [ -n "$b1a" ] && [ "$b1a" = "$b1b" ]; then
    echo "  [S1b] diff.relative=true + cwd 在子目录 → base_of 结果不变 ✓"
  else
    echo "  [S1b] diff.relative/cwd 影响了 base_of(root=$b1a, subdir=$b1b)✗"; rc=1
  fi
  ( cd "$r1" && command git config --unset diff.relative )

  # [S2] 没有 origin/main,但 origin/HEAD 指向另一个默认分支(如 develop)
  local r2="$tdir/r2"
  command mkdir -p "$r2"
  ( cd "$r2" && command git init -q && command git config user.email t@example.invalid \
      && command git config user.name test \
      && printf 'seed\n' > seed.md && command git add seed.md && command git commit -q -m seed \
      && command git update-ref refs/remotes/origin/develop HEAD \
      && command git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop \
      && printf 'x\n' > a.ts && command git add a.ts && command git commit -q -m "add a" ) >/dev/null 2>&1
  if b="$(base_of "$r2")" && [ -n "$b" ]; then
    echo "  [S2] 无 origin/main,origin/HEAD→origin/develop → base_of 仍解析成功 ✓"
  else
    echo "  [S2] origin 默认分支档失效 ✗"; rc=1
  fi

  # [S3] 既无 origin/main,也无 origin/HEAD → 必须 fail-closed(空输出、非 0),
  # **不得**回落到 HEAD~1 悄悄给出一个上一个 commit 当 base。
  local r3="$tdir/r3"
  command mkdir -p "$r3"
  ( cd "$r3" && command git init -q && command git config user.email t@example.invalid \
      && command git config user.name test \
      && printf 'a\n' > a.txt && command git add a.txt && command git commit -q -m a \
      && printf 'b\n' > b.txt && command git add b.txt && command git commit -q -m b ) >/dev/null 2>&1
  local b3 rc3
  b3="$(base_of "$r3")"; rc3=$?
  if [ "$rc3" -ne 0 ] && [ -z "$b3" ]; then
    echo "  [S3] base 完全不可解析 → base_of fail-closed(不回落 HEAD~1)✓"
  else
    echo "  [S3] base_of 在无 origin 时仍给出了一个值(HEAD~1 兜底复发?got=$b3)✗"; rc=1
  fi

  # [S4] 第三档:既无 origin/main 也无 origin/HEAD,但分支自己配了跟踪
  # 上游(`git branch --set-upstream-to`,remote 不叫 origin——对照
  # 2026-09-16 复审在 axervice 工作树实测到的 `laptop` 这个真实 remote 名)。
  # 必须能通过 @{upstream} 这一档解析出 base,不再像旧版本那样直接 fail-closed。
  local r4="$tdir/r4"
  command mkdir -p "$r4"
  ( cd "$r4" && command git init -q && command git config user.email t@example.invalid \
      && command git config user.name test \
      && command mkdir -p docs src \
      && printf 'seed\n' > docs/seed.md && command git add docs/seed.md && command git commit -q -m seed \
      && command git remote add laptop ssh://example.invalid/repo.git \
      && command git update-ref refs/remotes/laptop/feature HEAD \
      && command git branch --set-upstream-to=laptop/feature \
      && printf 'x\n' > src/a.ts && command git add src/a.ts && command git commit -q -m "add src" ) >/dev/null 2>&1
  local b4 rc4
  b4="$(base_of "$r4")"; rc4=$?
  if [ "$rc4" -eq 0 ] && [ -n "$b4" ]; then
    echo "  [S4] 无 origin/main、无 origin/HEAD,但 @{upstream}=laptop/feature 已配 → base_of 第三档解析成功 ✓"
  else
    echo "  [S4] @{upstream} 第三档未生效(rc=$rc4, got=$b4)✗"; rc=1
  fi
  # do_stamp/do_show 在这种仓库里必须干净地拒绝,不能崩、不能悄悄盖上一个
  # 语义错误的戳。
  local outS3 rcS3
  outS3="$(cd "$r3" && bash "$SELF_SCRIPT" codex 0 x 2>&1)"; rcS3=$?
  if [ "$rcS3" -ne 0 ] && printf '%s' "$outS3" | command grep -qi 'diff sha'; then
    echo "  [S3] do_stamp 在 base 不可解析时干净拒绝(rc=$rcS3)✓"
  else
    echo "  [S3] do_stamp 在 base 不可解析时未拒绝(rc=$rcS3)✗"; rc=1
  fi

  # ── [G] 与 review-gate.sh 对同一 diff 算出同一个 sha(LOW 项:base 解析
  # 分叉会让盖戳的 sha 和 check 校验的 sha 对不上)。只在同目录能找到
  # review-gate.sh 时跑(自检环境限制,不是脚本本身的缺陷)。
  local gate_script; gate_script="$(dirname "$SELF_SCRIPT")/review-gate.sh"
  if [ -f "$gate_script" ]; then
    local sha_stamp sha_gate
    sha_stamp="$(cd "$r1" && diff_sha 2>/dev/null || true)"
    # review-gate.sh 没有单独暴露 diff_sha 的 CLI,借它 --check 的输出里
    # 的 sha 前缀来对照(未触及审查路径会直接放行,不打印 sha;所以这里
    # 换一个真的会打印 sha 的场景:先盖 1 个戳,再跑 --check 看回显的 sha)。
    ( cd "$r1" && bash "$SELF_SCRIPT" codex 0 x >/dev/null 2>&1 )
    local gate_out; gate_out="$(cd "$r1" && bash "$gate_script" --check 2>&1)"
    sha_gate="$(printf '%s\n' "$gate_out" | command grep -oE '[0-9a-f]{12}' | head -1)"
    if [ -n "$sha_stamp" ] && [ -n "$sha_gate" ] && [ "${sha_stamp:0:12}" = "$sha_gate" ]; then
      echo "  [G] review-stamp 与 review-gate 对同一 diff 算出同一个 sha ✓"
    else
      echo "  [G] sha 分叉:stamp=${sha_stamp:0:12} gate=$sha_gate ✗"; rc=1
    fi
  else
    echo "  [G] 跳过(review-gate.sh 不在同目录,仅本次自检环境限制)"
  fi

  command rm -rf "$tdir"
  return $rc
}

case "${1:---help}" in
  --show)      do_show ;;
  --self-test) echo "review-stamp 自检:"; self_test && echo "通过" || { echo "有失败"; exit 1; } ;;
  --help|-h)   command sed -n '2,25p' "$0" ;;
  *)           do_stamp "$@" ;;
esac
