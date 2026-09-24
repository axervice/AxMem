#!/usr/bin/env bash
# review-gate — push 到主干前,要求这个 diff 有绑定过的审查戳。
#
# 挡的是 `ecc-trio-skipped-on-ux-waves`:审查被跳过,**已复发两次**,
# 而且今天找到的会员账单 bug 正是"审查范围没覆盖到"才漏的。
# 那条教训已经全文写进全局 CLAUDE.md,照样复发 —— **散文对这类无效,只能上机器。**
#
# 设计上的三个诚实取舍(不粉饰):
#  1. **只挡遗漏,挡不住造假**。builder 和 gate 同账号同机器、无身份隔离,
#     够坚决的人能编一份格式合规的假戳。但实际观测到的失败是忘了跑,不是故意骗。
#  2. **`--no-verify` 能绕过**。对人无解;对 agent 可以在 permissions 里 deny。
#  3. **只在改了实质代码时才拦**。文档/配置放行 —— 误拦会让人把整条 hook 删掉,
#     然后连真正的覆盖也一起没了。
#
# ── 2026-09-16 结构性复审(对抗审查,9 处 finding,见
#    scratchpad/guard-fix-opus-review.md)後的重写 ──
# 结构性原则:**这是 push 安全闸,任何判定环节失败都必须 fail-closed
# (BLOCK,退出非零并打印原因),绝不 exit 0。** 上一版把"SIGPIPE 时 fail-open"
# 换成了"判定链任一环失败都 fail-open"(`|| true` 吞掉 grep 自身的错误、
# `$(...)` 丢掉 git/base_of 的失败、`HEAD~1` 兜底把"解析不出上游"悄悄
# 收窄成"上一个 commit")。本版把三类判定(改了哪些文件 / 是否需要审查 /
# 是否高风险 / base 在哪)全部改成显式检查生产者自己的退出码,失败一律
# BLOCK 且吵。唯一保留的"合法 exit 0"是"不在 git 仓库里"和"没碰到需要
# 审查的路径"——这两个是正确答案,不是判定失败,但现在也会吵一声
# (审计用),不再和"算不出 sha"这种真失败同一副静默嘴脸。
#
# ── 2026-09-16 RE-REVIEW(同一份 scratchpad,4 处需改:1 MED / 3 LOW)后的
#    追加改动 ──
#  ① base_of/changed_files_file/diff sha 计算全部显式 `-C "$root" -c
#     diff.relative=false`,不再靠 cwd 隐式取当前仓库——cwd 在子目录,或
#     调用方全局 `diff.relative=true`,都曾让 `git diff --name-only` 只吐
#     相对 cwd 的路径,needs_review 的 `^(src/|…)` 锚点全部落空,静默放行。
#  ② base_of 补第三档 merge-base(HEAD, @{upstream}),覆盖 remote 不叫
#     origin 但分支自己配了跟踪上游的情形;三档都解析不到才 fail-closed,
#     提示语按当前仓库实际的 remote 列表动态给。
#  ③ changed_files_file() 改为直接调用(不再包进 `$(...)`)——旧写法
#     `cfile="$(changed_files_file "$base")"` 让函数内对全局
#     `CHANGED_FILES_FILE` 的赋值困在子 shell 里,父进程的
#     `trap cleanup_tmp EXIT` 永远看到空串,每次 --check 都在 TMPDIR
#     留一个孤儿临时文件。
#  ④ `unset -f` 名单补齐 `dirname`/`basename`/`bash`/`head`/`chmod`/
#     `mkdir`/`find`——这份名单是纵深防御,真正吃劲的是每个调用点自己的
#     `command` 前缀。
#
# 用法:review-gate.sh --check(默认;pre-push hook 调用同一入口)
#      自检:review-gate.sh --self-test
# 已知局限(LOW,本次未修——.githooks/pre-push 不在本次可改范围内):
#   hook 只 exec 本脚本、不传被推的 ref,本脚本永远判的是当前 HEAD,不是
#   `<remote-sha> <local-sha>` 参数;标准动作 `git push origin HEAD:main`
#   下两者一致,但 `git push origin feat:main`(HEAD 在别处)会漏判。
# 退出:0 放行 / 1 拦下(fail-closed 也是 1)

set -uo pipefail

# ── 注入面防护,必须是脚本的第一批可执行语句 ──
#
# BASH_ENV:bash 以非交互方式跑一个脚本文件时,会先把 $BASH_ENV 指向的文件
# `source` 进*同一个*进程,然后才读我们自己的脚本内容——也就是说,注入者能在
# 我们下面几行"去函数覆盖"跑之前,已经在同一个 shell 里定义好恶意函数
# (`grep(){ printf '0\n'; }`)或把某个变量设成 readonly。这个窗口我们没有
# 办法事后完全补救(木已成舟),能做的只有:一旦发现 BASH_ENV 被设置过,
# 直接拒绝在这个不可信的 shell 里继续跑,而不是假装无事发生。
if [ -n "${BASH_ENV:-}" ]; then
  echo "✖ push BLOCKED: review-gate 检测到 BASH_ENV=${BASH_ENV} 已设置 —— 无法确认当前 shell 有没有被污染,fail-closed 拒绝执行。" >&2
  exit 1
fi

# 函数通道:哪怕没有 BASH_ENV,调用方 shell 也可能 `grep(){ ...; } ; export -f grep`
# 后再 `bash review-gate.sh`——`export -f` 是 bash 的正经机制(通过
# BASH_FUNC_*%% 环境变量把函数定义传给子进程),子进程启动时就已经带着这个
# 假函数。下面把本脚本用得到的每个外部命令名先 unset -f 一遍;脚本正文里
# **一律用 `command git` / `command grep` 等**,`command` 本身也会跳过函数/
# 别名直接走 PATH——两道一起上,单独哪一道被绕过另一道仍兜底。**真正吃劲的
# 是每个调用点的 `command` 前缀,这份名单只是纵深防御**:没有 `command` 前缀
# 的调用点(如 `dirname`/`basename`/`bash`,以及 self_test 内建 fixture 用到
# 的几个)完全依赖这份名单才不被函数劫持,`command` 前缀齐全的调用点这份
# 名单只是多一道保险——将来若有人删掉某个调用点的 `command` 前缀,不能指望
# 这份名单单独兜底所有情形,但覆盖面越全,兜住的窗口越大。2026-09-16 复审
# 指出名单漏了脚本里实际会用到、但没有 `command` 前缀保护的 `dirname`/
# `basename`(SELF_SCRIPT 自引用路径计算用)、self_test 里 spawn 子进程用的
# `bash`,以及 review-stamp.sh 里出现过的 `head`——这里一并补齐。
unset -f git grep sed awk cat mktemp sha256sum cut tr sort printf seq rm \
  chmod mkdir dirname basename bash head find 2>/dev/null

# 变量通道:早先设计用 CF_FN 从进程环境切换数据源自检,2026-09-16 复审指出
# 调用方 shell 里任何残留的同名变量(尤其被设成 readonly)都可能造成误判。
# 本版 self_test() 已经改用显式的文件参数(见 run_predicates()),不再有任何
# 代码路径读取 CF_FN/CHANGED_FILES_OVERRIDE/_CF_SOURCE_FILE——但仍然主动清空
# 并断言清空成功:一是防御纵深(万一将来又有人复用这几个名字),二是这三个
# 名字本身就是历史攻击面的活文档。`unset -v` 对 readonly 变量会失败且不报错
# 退出码之外没有别的信号,`${VAR+x}` 才能分辨"真的没设"和"设了但清不掉"。
unset -v CHANGED_FILES_OVERRIDE CF_FN _CF_SOURCE_FILE 2>/dev/null
if [ -n "${CHANGED_FILES_OVERRIDE+x}" ] || [ -n "${CF_FN+x}" ] || [ -n "${_CF_SOURCE_FILE+x}" ]; then
  echo "✖ push BLOCKED: review-gate 无法清除注入变量 CHANGED_FILES_OVERRIDE/CF_FN/_CF_SOURCE_FILE(readonly?)—— fail-closed。" >&2
  exit 1
fi

# 自引用绝对路径,供 self_test() 在子进程里重新执行同一个脚本本身
# ——那些臂会先 cd 进一个临时仓库再调用,这时相对路径的 $0 已经失效。
SELF_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

LEDGER_REL=".codex-reviews/review-ledger.tsv"
# 风险面:碰了这些就要求至少 2 个不同审查者(建者≠审者 + 冗余已被教训证明值)。
#
# **按路径段匹配,不按子串。** 第一版是裸子串,跨模型审查实测它把 206/716(约 29%)
# 的 src 文件判成高风险 —— 因为路由组目录 `(authed)` 里含 `auth`;`promote`/`Promotion`
# 命中 `promo`,`pledge` 命中 `ledger`。系统性抬高三成改动的门槛,最后逼人用 --no-verify,
# 那就等于把关卡整个废掉。误拦比漏拦危险,今天已经现场演示过两次。
# `s?` 不是随手加的:第一版收紧成按段匹配后,`src/lib/payments/` 的段是复数 `payments`,
# 于是钱路核心目录**反而漏判**了 —— 修误拦当场造出漏拦,正是 PMM
# [process:guard-patching-reintroduces-its-own-defect-class] 说的那件事。
# 下面的自检直接拿本仓库真实的钱路文件当回归,不用编造路径。
HIGH_RISK_RE='(^|/)(billing|payments?|payroll|ledgers?|checkouts?|refunds?|promos?|subscriptions?|auth|tenants?|rls)([/.]|$)|(^|/)prisma/schema'

# base_of:HEAD 相对上游的分叉点。**三档,全部"相对某个真实存在的 ref 算
# merge-base",不再有 `HEAD~1` 兜底**——`HEAD~1` 是"上一个 commit",不是
# "上游";它曾经把"remote 默认分支不叫 main/master、或新 worktree 没
# fetch 过"悄悄收窄成"只看最后一个 commit",在一个分支里混着 docs 尾
# commit + 真实钱路改动时,让 gate 判定"零改动"直接放行。
# 三档都解析不到就是解析不到,交给调用方 fail-closed(见 changed_files_file()/
# diff 部分),不要用一个语义完全不同的近似值顶替。
#   ①merge-base(HEAD, origin/main) ②merge-base(HEAD, origin 的默认分支,
#   即 refs/remotes/origin/HEAD 指向的那个) ③merge-base(HEAD, @{upstream})
#   ——第三档覆盖 origin/main 和 origin/HEAD 都解析不到、但分支自己配了
#   跟踪上游(`git branch --set-upstream-to=...`)的情形;例如 remote 不叫
#   origin(2026-09-16 复审实测 axervice 工作树同时有 `origin` 与 `laptop`
#   两个 remote——origin/HEAD 仍能正常解析,这一档目前没被触发,但同一
#   仓库只要 `git remote prune origin` 或重 clone 掉 origin,origin/main、
#   origin/HEAD 会一起失效,这一档就是唯一还能救回来的路)。
#   **全部命令都显式 `-C "$root"`(不依赖 cwd)+ `-c diff.relative=false`
#   (不依赖调用方全局 git config)**——cwd 在子目录、或 `diff.relative=true`
#   都不该改变"这个仓库的 base 是哪个 commit"这个判断,2026-09-16 复审的
#   MED finding 正是 gate 早先裸用 cwd 相对路径在这两种环境下被绕过。
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

# 把 base..HEAD 的改动文件名单写进一个临时文件。谓词只读这个文件,不再直接
# 管道消费 git 的输出——原先 `changed_files() { git diff --name-only ... ; }`
# 把生产者包在 `$(...)` 里,git 失败(base 解不出来、仓库损坏……)时
# `$(...)` 只留下空字符串,外层判定"零改动"从而"不需要审查",静默放行,
# 连 93 行那种警告都没有。现在单独检查 git 自己的退出码,失败就是失败,
# 不允许被降级成"空清单"。
#
# **必须被直接调用(`changed_files_file "$root" "$base" || …`),绝不能包在
# `$(...)` 里。** 2026-09-16 复审发现:`cfile="$(changed_files_file "$base")"`
# 这种写法会让 `CHANGED_FILES_FILE="$f"` 那一行跑在 `$(...)` 开的子 shell
# 里——子 shell 退出后这个赋值就消失了,父进程(真正持有 `trap … EXIT` 的
# 那个 shell)看到的 `$CHANGED_FILES_FILE` 永远是空串,`cleanup_tmp` 形同
# 摆设,每次 `--check` 都在 TMPDIR 里留一个文件。改成函数直接写全局变量、
# 调用方读该变量,`trap` 才真正够得着它。
CHANGED_FILES_FILE=""
changed_files_file() {  # $1=root $2=base sha;成功时把路径写进全局 CHANGED_FILES_FILE 并 return 0
  local root="$1" base="$2" f
  f="$(command mktemp)"
  if [ -z "$f" ]; then
    echo "review-gate: cannot determine changed files(mktemp 失败)" >&2
    return 1
  fi
  if ! command git -C "$root" -c diff.relative=false diff --name-only "$base..HEAD" > "$f"; then
    local rc=$?
    command rm -f "$f"
    echo "review-gate: cannot determine changed files(git diff 失败,rc=$rc)" >&2
    return 1
  fi
  CHANGED_FILES_FILE="$f"
  return 0
}
cleanup_tmp() { [ -n "$CHANGED_FILES_FILE" ] && command rm -f "$CHANGED_FILES_FILE"; }
trap cleanup_tmp EXIT

# grep -c(不是 grep -q):在 `set -o pipefail` 下,`grep -q` 命中即退出,
# 若生产者还在写大列表会被 SIGPIPE 弄死(rc=141),pipefail 把它当非零返回,
# 把"需要审查/高风险"误判成"不需要/低风险"。`grep -c` 读完全部输入不提前
# 退出,不触发 SIGPIPE。但光换 `-c` 不够:**必须区分 grep 自己的退出码**——
# 0=有命中、1=零命中(合法答案,不是错误)、≥2=grep 出错(参数错/文件读不了/
# 二进制炸了),后者一律当判定失败处理,不能用 `|| true` 一并吞掉。
grep_count() {  # $1=file $2=ERE pattern(大小写敏感)→ 成功时把计数打到 stdout
  local file="$1" pat="$2" n grc
  n="$(command grep -c -E "$pat" -- "$file")"
  grc=$?
  case "$grc" in
    0|1) : ;;
    *) echo "review-gate: grep 判定失败(rc=$grc)" >&2; return 2 ;;
  esac
  case "$n" in
    ''|*[!0-9]*) echo "review-gate: grep 计数非整数($n)" >&2; return 2 ;;
  esac
  printf '%s\n' "$n"
}
grep_count_i() {  # 同上,大小写不敏感
  local file="$1" pat="$2" n grc
  n="$(command grep -ci -E "$pat" -- "$file")"
  grc=$?
  case "$grc" in
    0|1) : ;;
    *) echo "review-gate: grep -i 判定失败(rc=$grc)" >&2; return 2 ;;
  esac
  case "$n" in
    ''|*[!0-9]*) echo "review-gate: grep -i 计数非整数($n)" >&2; return 2 ;;
  esac
  printf '%s\n' "$n"
}

# needs_review / is_high_risk 现在都是"改动文件清单文件"的纯函数——不再有
# CF_FN 间接层,self_test() 直接喂合成文件(见 run_predicates())。任何一步
# 判定失败(grep_count 返回非 0)都 fail-closed:needs_review 判"需要审查",
# is_high_risk 判"高风险"(把 need 从 1 提到 2,而不是原来那样悄悄降级)。
needs_review() {  # $1 = changed-files-list 文件
  local file="$1" n
  n="$(grep_count "$file" '^(src/|prisma/|scripts/|app/|lib/|\.github/workflows/)')" || {
    echo "review-gate: needs_review 判定失败 —— fail-closed 判需要审查" >&2
    return 0
  }
  [ "$n" -gt 0 ]
}
is_high_risk() {  # $1 = changed-files-list 文件
  local file="$1" n
  n="$(grep_count_i "$file" "$HIGH_RISK_RE")" || {
    echo "review-gate: is_high_risk 判定失败 —— fail-closed 判高风险" >&2
    return 0
  }
  [ "$n" -gt 0 ]
}
run_predicates() {  # $1 = changed-files-list 文件;self_test() 用的便捷入口
  local file="$1" nr hr
  needs_review "$file" && nr=1 || nr=0
  is_high_risk "$file" && hr=1 || hr=0
  printf 'needs=%s risk=%s\n' "$nr" "$hr"
}

stamps_for() {  # $1=repo root $2=diff sha
  local root="$1" sha="$2" ledger="$root/$LEDGER_REL"
  [ -s "$ledger" ] || return 0
  local s t r f a
  while IFS=$'\t' read -r s t r f a; do
    case "$s" in \#*|"") continue;; esac
    [ "$s" = "$sha" ] && printf '%s\n' "$r"
  done < "$ledger" | command sort -u
}

check() {
  local root
  root="$(command git rev-parse --show-toplevel 2>/dev/null)"
  if [ -z "$root" ]; then
    # 合法答案(这个 hook 不该在非 git 目录里拦任何东西),不是判定失败——
    # 但和其它两处"合法 exit 0"(未触及需要审查的路径)一样,现在会吵一声,
    # 不再是纯静默。
    echo "review-gate: 不在 git 仓库内,跳过(exit 0)。" >&2
    exit 0
  fi

  local base
  base="$(base_of "$root")"
  if [ $? -ne 0 ] || [ -z "$base" ]; then
    echo "✖ push BLOCKED: review-gate 无法确定 base —— merge-base(HEAD, origin/main)、origin 的默认分支(refs/remotes/origin/HEAD)、以及上游跟踪分支(@{upstream})三档全部解析不到。fail-closed。" >&2
    local remotes
    remotes="$(command git -C "$root" -c diff.relative=false remote 2>/dev/null)"
    if [ -n "$remotes" ]; then
      echo "  已配置的 remote: $(printf '%s' "$remotes" | command tr '\n' ' ')" >&2
      echo "  试试: git fetch <上面某个 remote> <它的默认分支>,或 git branch --set-upstream-to=<remote>/<branch>" >&2
    else
      echo "  这个仓库还没有任何 remote —— 试试: git remote add origin <url> && git fetch origin main" >&2
    fi
    exit 1
  fi

  # 直接调用,不包 `$(...)`——CHANGED_FILES_FILE 是全局变量,包一层子 shell
  # 会让下面的赋值对父进程的 `trap cleanup_tmp EXIT` 隐身(见函数定义处注释)。
  changed_files_file "$root" "$base"
  if [ $? -ne 0 ]; then
    # changed_files_file 已经把具体原因打到 stderr 了
    echo "✖ push BLOCKED: review-gate 无法确定这次改了哪些文件。fail-closed。" >&2
    exit 1
  fi
  local cfile="$CHANGED_FILES_FILE"

  if ! needs_review "$cfile"; then
    echo "✓ review-gate: 未触及需要审查的路径(src/prisma/scripts/app/lib/.github/workflows 均未改),放行。" >&2
    exit 0
  fi

  local sha
  sha="$(command git -C "$root" -c diff.relative=false diff --no-color "$base..HEAD" | command sha256sum | command cut -d' ' -f1)"
  if [ $? -ne 0 ] || [ -z "$sha" ]; then
    # 2026-09-16 复审前这里是刻意的 fail-open("attack surface 等价于
    # --no-verify,所以放行的取舍合理")——但那个论证只覆盖了"sha256sum
    # 缺失"这一种窄情形,实际能走到这里的还包括"git diff 本身失败"这种
    # 更值得拦的情形。本次结构性原则不再允许"判定环节失败就默认放行",
    # 哪怕是这种低概率的环境级故障。
    echo "✖ push BLOCKED: review-gate 算不出 diff sha(sha256sum 缺失,或 git diff 失败)。fail-closed。" >&2
    exit 1
  fi

  local high=0
  is_high_risk "$cfile" && high=1
  local need=1
  [ "$high" = 1 ] && need=2

  local got n grc
  got="$(stamps_for "$root" "$sha")"
  n="$(printf '%s\n' "$got" | command grep -c .)"
  grc=$?
  case "$grc" in
    0|1) : ;;
    *) echo "✖ push BLOCKED: review-gate 无法统计已有审查戳(grep rc=$grc)。fail-closed。" >&2; exit 1 ;;
  esac
  case "$n" in
    ''|*[!0-9]*) echo "✖ push BLOCKED: review-gate 戳计数非整数($n)。fail-closed。" >&2; exit 1 ;;
  esac

  if [ "$n" -ge "$need" ]; then
    echo "✓ review-gate: diff ${sha:0:12} 有 $n 个审查戳($(printf '%s' "$got" | command tr '\n' ' '))"
    exit 0
  fi

  {
    echo ""
    echo "✖ push BLOCKED: 这个 diff 没有足够的审查戳。"
    echo "  diff  = ${sha:0:12}"
    echo "  已有  = ${n} 个${got:+($(printf '%s' "$got" | command tr '\n' ' '))}"
    echo "  需要  = ${need} 个$([ "$high" = 1 ] && echo '(碰到钱路/租户/鉴权/schema → 按风险分级要 ≥2 个不同审查者)')"
    echo ""
    echo "  跑完审查后盖戳:"
    echo "    bash ~/.claude/guards/review-stamp.sh codex <findings数> <产物路径>"
    echo "    bash ~/.claude/guards/review-stamp.sh ecc-security 0"
    echo "  查看当前戳: bash ~/.claude/guards/review-stamp.sh --show"
    echo ""
    echo "  注意:再加一个 commit 会改变 diff,旧戳自动失效 —— 这是刻意的。"
    echo "  (override: git push --no-verify)"
    echo ""
  } >&2
  exit 1
}

# ── mk_test_repo:self_test() 用的一次性仓库夹具 ──
# $1=目录 $2=money(1 则改动落在 src/lib/payments/ 下,触发高风险)
mk_test_repo() {
  local dir="$1" money="${2:-0}"
  command mkdir -p "$dir"
  (
    cd "$dir" \
      && command git init -q \
      && command git config user.email t@example.invalid \
      && command git config user.name test \
      && command mkdir -p docs \
      && printf 'seed\n' > docs/seed.md \
      && command git add docs/seed.md \
      && command git commit -q -m seed \
      && command git update-ref refs/remotes/origin/main HEAD \
      && { if [ "$money" = "1" ]; then
             command mkdir -p src/lib/payments
             printf 'export const a = 1;\n' > src/lib/payments/a.ts
             command git add src/lib/payments/a.ts
           else
             command mkdir -p src
             printf 'export const a = 1;\n' > src/a.ts
             command git add src/a.ts
           fi ; } \
      && command git commit -q -m "add src file"
  ) >/dev/null 2>&1
}

self_test() {
  local rc=0

  command -v sha256sum >/dev/null 2>&1 && echo "  sha256sum 可用 ✓" || { echo "  sha256sum 缺失 ✗"; rc=1; }

  # 高风险正则回归(未改动的既有检查,继续保留)——全部取自 axervice 真实钱路
  # 文件;payments/ 是复数,曾因按段匹配漏判过。
  for p in src/lib/payments/memberships.ts src/lib/billing/verification.ts \
           src/lib/checkout/sale.ts src/lib/marketing/promo.ts \
           prisma/schema.prisma src/lib/auth/guard.ts; do
    printf '%s\n' "$p" | command grep -qiE "$HIGH_RISK_RE" || { echo "  高风险正则漏了 $p ✗"; rc=1; }
  done
  echo "  高风险路径全部命中 ✓"
  for p in 'src/components/Button.tsx' 'src/app/[locale]/(authed)/admin/help/page.tsx' \
           'src/lib/marketing/promote.ts' 'src/lib/pledge/x.ts'; do
    printf '%s\n' "$p" | command grep -qiE "$HIGH_RISK_RE" && { echo "  误伤 $p ✗"; rc=1; }
  done
  echo "  (authed)/promote/pledge/普通组件 均不误判 ✓"
  printf 'docs/README.md\n' | command grep -qE '^(src/|prisma/|scripts/|app/|lib/|\.github/workflows/)' \
    && { echo "  文档被误判需审 ✗"; rc=1; } || echo "  纯文档不需审 ✓"

  local tdir; tdir="$(command mktemp -d)"

  # ── [P1]/[P2] 30 万行 SIGPIPE 形状:run_predicates 直接吃合成文件,不再
  # 靠 CF_FN 间接层。文件参数 + grep -c(不提前退出)从根上消灭了原来
  # "producer 还没写完就被 grep -q 判定提前关闭读端"的那种 SIGPIPE 面。
  { printf 'src/components/Button.tsx\n'; command seq 1 300000 | command sed 's#^#docs/pad-#'; } > "$tdir/p1"
  local out1; out1="$(run_predicates "$tdir/p1")"
  [ "$out1" = "needs=1 risk=0" ] \
    && echo "  [P1] 30万行大清单(非钱路首行命中)needs=1/risk=0 ✓" \
    || { echo "  [P1] 判定错误(got: $out1)✗"; rc=1; }

  { printf 'src/lib/payments/x.ts\n'; command seq 1 300000 | command sed 's#^#docs/pad-#'; } > "$tdir/p2"
  local out2; out2="$(run_predicates "$tdir/p2")"
  [ "$out2" = "needs=1 risk=1" ] \
    && echo "  [P2] 30万行大清单(钱路首行命中)needs=1/risk=1 ✓" \
    || { echo "  [P2] 判定错误(got: $out2)✗"; rc=1; }

  # ── [P3] grep rc=2:PATH 前置一个必炸的假 grep 可执行文件,断言两个谓词
  # 都 fail-closed 判真(needs_review 判需要审查、is_high_risk 判高风险,
  # need 从 1 升到 2,不是原来那样悄悄降级)。全程同进程内做,靠临时改写
  # PATH(bash 的前缀赋值对函数调用同样生效,函数体内的嵌套调用也看得到)。
  local stub_dir="$tdir/badgrep"
  command mkdir -p "$stub_dir"
  printf '#!/usr/bin/env bash\nexit 2\n' > "$stub_dir/grep"
  command chmod +x "$stub_dir/grep"
  printf 'src/components/Button.tsx\n' > "$tdir/p3"
  local out3
  out3="$(PATH="$stub_dir:$PATH" run_predicates "$tdir/p3" 2>/dev/null)"
  [ "$out3" = "needs=1 risk=1" ] \
    && echo "  [P3] grep rc=2(外部 grep 可执行文件损坏)fail-closed 判真 ✓" \
    || { echo "  [P3] grep rc=2 未 fail-closed(got: $out3)✗"; rc=1; }

  # ── [A] git 失败(changed_files_file 的 git diff --name-only 步骤):
  # 造一个只在 `diff --name-only` 上装死、其它子命令透传真实 git 的 stub,
  # 前置到 PATH 后跑真实 --check 子进程,断言 BLOCKED 且带上具体原因。
  # **按"参数集合里同时出现 diff 和 --name-only"判断,不按固定位置**——
  # 真实调用现在是 `git -C "$root" -c diff.relative=false diff --name-only
  # ...`(item①的 -C/-c 修复),`diff`/`--name-only` 不再是 $1/$2。
  local git_stub_dir="$tdir/badgit" real_git
  real_git="$(command -v git)"
  command mkdir -p "$git_stub_dir"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'is_diff=0; is_nameonly=0\n'
    printf 'for a in "$@"; do [ "$a" = "diff" ] && is_diff=1; [ "$a" = "--name-only" ] && is_nameonly=1; done\n'
    printf 'if [ "$is_diff" = 1 ] && [ "$is_nameonly" = 1 ]; then\n'
    printf '  echo "stub-git: forced failure" >&2\n'
    printf '  exit 17\n'
    printf 'fi\n'
    printf 'exec "%s" "$@"\n' "$real_git"
  } > "$git_stub_dir/git"
  command chmod +x "$git_stub_dir/git"
  mk_test_repo "$tdir/repoA" 0
  local outA rcA
  outA="$(cd "$tdir/repoA" && PATH="$git_stub_dir:$PATH" bash "$SELF_SCRIPT" --check 2>&1)"; rcA=$?
  if [ "$rcA" -ne 0 ] && printf '%s' "$outA" | command grep -q 'cannot determine changed files'; then
    echo "  [A] git diff --name-only 失败 → BLOCKED(rc=$rcA)✓"
  else
    echo "  [A] git 失败未被 fail-closed(rc=$rcA)✗"; rc=1
  fi

  # ── [B] base 不可解析,且专门踩中"HEAD~1 兜底会怎么错"的原始 repro 形状
  # (scratchpad finding ③):没有任何 origin 远端,三个 commit ——
  #   1) docs seed  2) 真实钱路改动 src/lib/payments/a.ts  3) 又一次纯 docs 改动(=HEAD)。
  # 如果还兜底 HEAD~1,base 会解析成 commit②(payments.ts 已经"在" base 里),
  # diff base..HEAD 就只剩 commit③的 docs 改动——needs_review 判假,直接
  # exit 0 放行,commit②的钱路改动全程没被任何人看到。现在必须 fail-closed:
  # 解析不到上游就是解析不到,不能用"上一个 commit"这种语义不同的近似值
  # 顶替,把"这个分支到底有没有审查过"这件事悄悄猜成"没有"。
  local repoC="$tdir/repoC"
  command mkdir -p "$repoC"
  ( cd "$repoC" && command git init -q && command git config user.email t@example.invalid \
      && command git config user.name test \
      && command mkdir -p docs src/lib/payments \
      && printf 'seed\n' > docs/seed.md && command git add docs/seed.md && command git commit -q -m seed \
      && printf 'export const a=1;\n' > src/lib/payments/a.ts && command git add src/lib/payments/a.ts \
      && command git commit -q -m "add payments" \
      && printf 'seed2\n' > docs/seed.md && command git add docs/seed.md && command git commit -q -m "docs tweak" \
  ) >/dev/null 2>&1
  local outB rcB
  outB="$(cd "$repoC" && bash "$SELF_SCRIPT" --check 2>&1)"; rcB=$?
  if [ "$rcB" -ne 0 ] && printf '%s' "$outB" | command grep -q '无法确定 base'; then
    echo "  [B] base 不可解析(无 origin,HEAD~1 会误藏更早的钱路 commit)→ BLOCKED(rc=$rcB)✓"
  else
    echo "  [B] base 不可解析未被 fail-closed,或 HEAD~1 式误判复发(rc=$rcB)✗"; rc=1
    printf '%s\n' "$outB" | command sed 's/^/    /'
  fi

  # ── [C] BASH_ENV 投毒(伪造 grep,声称零命中)→ 必须在脚本第一行前就被拦下。
  mk_test_repo "$tdir/repoGood" 0
  printf 'grep() { printf "0\\n"; }\nexport -f grep\n' > "$tdir/poison_grep.sh"
  local outC rcC
  outC="$(cd "$tdir/repoGood" && BASH_ENV="$tdir/poison_grep.sh" bash "$SELF_SCRIPT" --check 2>&1)"; rcC=$?
  if [ "$rcC" -ne 0 ] && printf '%s' "$outC" | command grep -q 'BASH_ENV'; then
    echo "  [C] BASH_ENV 投毒(伪造 grep)→ BLOCKED(rc=$rcC)✓"
  else
    echo "  [C] BASH_ENV 投毒未被拦下(rc=$rcC)✗"; rc=1
  fi

  # ── [D] readonly CF_FN 投毒,独立于 [C] 的 BASH_ENV 通道单测 unset -v 断言
  # 这一层本身。纯 `export`(不带 BASH_ENV)不会跨进程携带 readonly 属性
  # ——子进程里重新 `bash script.sh` 拿到的只是一个普通变量,`unset -v` 照样
  # 能清掉,测不出这一层;`source` 才会在*当前*进程里跑脚本正文,能真正
  # 让 CF_FN 带着 readonly 属性撞上我们的 unset -v。用 `source` 而不是走
  # BASH_ENV,这一臂就不会被 [C] 已经验证过的第一层检测顺带罩住,是对
  # unset -v 断言的独立验证,不是重复测试。
  local outD rcD
  outD="$( (cd "$tdir/repoGood" && readonly CF_FN=evil && source "$SELF_SCRIPT" --check) 2>&1 )"; rcD=$?
  if [ "$rcD" -ne 0 ] && printf '%s' "$outD" | command grep -q '无法清除注入变量'; then
    echo "  [D] readonly CF_FN 投毒(source,不经 BASH_ENV)→ unset -v 断言独立拦下(rc=$rcD)✓"
  else
    echo "  [D] readonly CF_FN 投毒未被拦下(rc=$rcD)✗"; rc=1
  fi

  # ── [E] export -f grep 覆盖(不经 BASH_ENV,纯 `export -f` 传给子进程):
  # 恶意 grep 谎称零命中,想把钱路改动的 is_high_risk 拉低、need 从 2 降到 1。
  # 用真实钱路仓库(repoB,2 个 stamp 都不盖)跑,断言 BLOCKED 消息里仍然
  # 写着"需要 = 2 个"——证明 `command grep` 确实绕过了这个覆盖,不是"反正
  # 零戳总会 BLOCKED"这种不区分原因的弱断言。
  mk_test_repo "$tdir/repoE" 1
  local outE rcE
  outE="$(
    grep() { printf '0\n'; }
    export -f grep
    cd "$tdir/repoE" && bash "$SELF_SCRIPT" --check 2>&1
  )"; rcE=$?
  if [ "$rcE" -ne 0 ] && printf '%s' "$outE" | command grep -q '需要  = 2 个'; then
    echo "  [E] export -f grep 覆盖(伪造零命中)未能降低 need,仍判 2 个 ✓"
  else
    echo "  [E] export -f grep 覆盖生效,need 被拉低(rc=$rcE)✗"; rc=1
    printf '%s\n' "$outE" | command sed 's/^/    /'
  fi

  # ── [F] 正常路径回归(未改动过的逻辑没被这次重写坏):零戳必 BLOCKED,
  # 盖够戳后必放行,need 按是否钱路正确切到 1/2。
  mk_test_repo "$tdir/repoF1" 0
  local outF1 rcF1
  outF1="$(cd "$tdir/repoF1" && bash "$SELF_SCRIPT" --check 2>&1)"; rcF1=$?
  [ "$rcF1" -ne 0 ] && printf '%s' "$outF1" | command grep -q 'BLOCKED' \
    && echo "  [F1] 普通改动 · 零戳 → BLOCKED ✓" \
    || { echo "  [F1] 零戳未 BLOCKED(rc=$rcF1)✗"; rc=1; }
  # 盖一个戳应当放行(need=1,非钱路)
  local stamp_script="$(dirname "$SELF_SCRIPT")/review-stamp.sh"
  if [ -f "$stamp_script" ]; then
    ( cd "$tdir/repoF1" && bash "$stamp_script" codex 0 test >/dev/null 2>&1 )
    local outF1b rcF1b
    outF1b="$(cd "$tdir/repoF1" && bash "$SELF_SCRIPT" --check 2>&1)"; rcF1b=$?
    [ "$rcF1b" -eq 0 ] && printf '%s' "$outF1b" | command grep -q '✓' \
      && echo "  [F1] 补 1 个戳(非钱路,need=1)→ 放行 ✓" \
      || { echo "  [F1] 补戳后仍未放行(rc=$rcF1b)✗"; rc=1; }
  else
    echo "  [F1] 跳过(review-stamp.sh 不在同目录,仅本次自检环境限制)"
  fi

  mk_test_repo "$tdir/repoF2" 1
  local outF2a rcF2a
  outF2a="$(cd "$tdir/repoF2" && bash "$SELF_SCRIPT" --check 2>&1)"; rcF2a=$?
  [ "$rcF2a" -ne 0 ] && printf '%s' "$outF2a" | command grep -q '需要  = 2 个' \
    && echo "  [F2] 钱路改动 · 零戳 → BLOCKED,need=2 ✓" \
    || { echo "  [F2] 钱路零戳判定错误(rc=$rcF2a)✗"; rc=1; }
  if [ -f "$stamp_script" ]; then
    ( cd "$tdir/repoF2" && bash "$stamp_script" codex 0 test >/dev/null 2>&1 )
    local outF2b rcF2b
    outF2b="$(cd "$tdir/repoF2" && bash "$SELF_SCRIPT" --check 2>&1)"; rcF2b=$?
    [ "$rcF2b" -ne 0 ] && printf '%s' "$outF2b" | command grep -q '已有  = 1 个' \
      && echo "  [F2] 钱路改动 · 1 个戳(need=2)仍 BLOCKED ✓" \
      || { echo "  [F2] 钱路 1 戳判定错误(rc=$rcF2b)✗"; rc=1; }
    ( cd "$tdir/repoF2" && bash "$stamp_script" ecc-security 0 >/dev/null 2>&1 )
    local outF2c rcF2c
    outF2c="$(cd "$tdir/repoF2" && bash "$SELF_SCRIPT" --check 2>&1)"; rcF2c=$?
    [ "$rcF2c" -eq 0 ] \
      && echo "  [F2] 钱路改动 · 2 个不同戳 → 放行 ✓" \
      || { echo "  [F2] 钱路 2 戳仍未放行(rc=$rcF2c)✗"; rc=1; }
  fi

  # ── [G] cwd 在子目录 + `diff.relative=true`:2026-09-16 复审的 MED finding
  # ——早先 gate 裸用 cwd 相对路径跑 git,`diff --name-only` 在 `diff.relative=
  # true` 下只输出相对 cwd 的路径,`^(src/|prisma/|…)` 锚点在 cwd 不是仓库
  # 根时全部落空,needs_review 判假、直接放行。现在 base_of/changed_files_file/
  # sha 计算全部显式 `-C "$root" -c diff.relative=false`,cwd 和调用方的
  # git config 都不该再影响判定。用真实改动落在 src/ 的仓库,打开
  # `diff.relative=true`,cd 进 docs/ 子目录再跑 --check——必须仍判需要审查
  # 并 BLOCKED(零戳),不能走"未触及需要审查的路径"那条放行分支。
  mk_test_repo "$tdir/repoG" 0
  ( cd "$tdir/repoG" && command git config diff.relative true )
  local outG rcG
  outG="$(cd "$tdir/repoG/docs" && bash "$SELF_SCRIPT" --check 2>&1)"; rcG=$?
  if [ "$rcG" -ne 0 ] && printf '%s' "$outG" | command grep -q 'BLOCKED' \
     && ! printf '%s' "$outG" | command grep -q '未触及需要审查的路径'; then
    echo "  [G] diff.relative=true + cwd 在子目录(docs/)→ 仍判需要审查、BLOCKED(rc=$rcG)✓"
  else
    echo "  [G] diff.relative=true + 子目录 cwd 绕过判定(rc=$rcG)✗"; rc=1
    printf '%s\n' "$outG" | command sed 's/^/    /'
  fi

  # ── [H] CHANGED_FILES_FILE 临时文件不泄漏:2026-09-16 复审发现旧版本
  # `cfile="$(changed_files_file "$base")"` 把赋值关进了 `$(...)` 子 shell,
  # `trap cleanup_tmp EXIT` 在父进程里永远看到空串,每次 --check 都在
  # TMPDIR 留一个文件。改成直接调用(不经命令替换)后,连跑 3 次必须
  # 0 残留。
  local htdir; htdir="$(command mktemp -d)"
  mk_test_repo "$tdir/repoH" 0
  ( cd "$tdir/repoH" && TMPDIR="$htdir" bash "$SELF_SCRIPT" --check >/dev/null 2>&1 )
  ( cd "$tdir/repoH" && TMPDIR="$htdir" bash "$SELF_SCRIPT" --check >/dev/null 2>&1 )
  ( cd "$tdir/repoH" && TMPDIR="$htdir" bash "$SELF_SCRIPT" --check >/dev/null 2>&1 )
  local leaked
  leaked="$(command find "$htdir" -type f 2>/dev/null | command grep -c .)"
  if [ "$leaked" = "0" ]; then
    echo "  [H] 连跑 3 次 --check 后 TMPDIR 无残留临时文件(trap 真正生效)✓"
  else
    echo "  [H] TMPDIR 残留 $leaked 个临时文件(子 shell 泄漏复发)✗"; rc=1
  fi
  command rm -rf "$htdir"

  command rm -rf "$tdir"
  return $rc
}

case "${1:---check}" in
  --self-test) echo "review-gate 自检:"; self_test && echo "通过" || { echo "有失败"; exit 1; } ;;
  *)           check ;;
esac
