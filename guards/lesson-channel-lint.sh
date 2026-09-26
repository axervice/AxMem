#!/usr/bin/env bash
# lesson-channel-lint — 新教训必须标一个通道,否则半年后回到 173 条全量注入。
#
# ―― A3「计数必须带 as-of」的 lint 版:**建前校准,当场砍了**(2026-08-20)。记在这免得重建:
# 候选正则(数量词+同行无日期+排除阈值/单位)对存量语料命中 20 行,逐行核查**几乎全是误报**——
# 「重发 54 次」「8 个 daemon」「diff 的 21 个文件」全是带日期条目里的历史叙事,正是该豁免的类。
# 「会变化的库存计数 vs 历史叙事计数」是语义区分,正则表达不出来;豁免清单是无底洞(与被砍的
# E 检查同病:干净语料上大面积误报的检查,活不过两天,还会拖累整个 lint 被删)。
# A3 可机器判定的那半已落在 DREAM-PROMPT v3 第 6 条:dream **产出**的计数必须带 as-of——
# 那里计数是机器生成的,附日期零判断。人写的条目自带头部日期,body 计数继承它。
#
# 背景:"每条新教训都要标通道"本身是一条执行纪律,而执行纪律靠散文提醒是无效的
# (ecc-trio 全文注入过仍复发两次)。所以这条规矩必须有机械保底,否则它就是自指矛盾。
#
# 只检查**本次新增**的条目,不动存量 —— 存量 98 条都没有元数据,全量校验只会被立刻关掉。
#
# 用法:
#   lesson-channel-lint.sh <file> [<file>...]      # 检查这些文件在 git index 里的新增条目
#   lesson-channel-lint.sh --self-test             # 红/绿自检
# 退出码:0 = 通过 / 1 = 有新条目缺元数据(git hook 会因此阻断提交)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./pmm-home.sh
source "$SCRIPT_DIR/pmm-home.sh"

# 条目头:以 ** 开头的行(LESSONS.md / PMM lessons.md 共用这个格式)
ENTRY_RE='^\+\*\*'
# 元数据行示例:
#   <!-- channel: test | artifact: scripts/itest-foo.ts | severity: incident | verified_at: 2026-08-03 -->
META_RE='channel:[[:space:]]*[a-z-]+'

fail=0
report() { printf '%s\n' "$*" >&2; }

check_file() {
  local f="$1" diff_out
  diff_out="$(git diff --cached -U0 -- "$f" 2>/dev/null)"
  [ -z "$diff_out" ] && return 0

  # **编辑一条旧条目 ≠ 新增条目。** 改个错字在 diff 里也是"整行删除 + 整行新增",
  # 同样命中 ^\+\*\*。第一版会因此拦下"顺手订正一条旧记录"——与本文件自己
  # "存量条目不受影响"的承诺直接矛盾(跨模型审查在空 repo 里实测复现)。
  # 所以先收集被删行里的 tag:同一个 tag 两边都出现 = 编辑,跳过。
  local removed_tags=""
  local l
  while IFS= read -r l; do
    case "$l" in
      -\*\**) removed_tags="$removed_tags $(printf '%s' "$l" | grep -oE '\[[a-z0-9:_-]+\]' | tr -d '[]' | tr '\n' ' ')" ;;
    esac
  done <<< "$diff_out"

  local cur_entry="" cur_meta="" line
  while IFS= read -r line; do
    if [[ "$line" =~ $ENTRY_RE ]]; then
      # 上一条收尾
      verdict "$f" "$cur_entry" "$cur_meta"
      cur_entry="${line:1}"; cur_meta=""
      # 这条的 tag 在被删集合里 → 是编辑不是新增,整条跳过
      local t
      for t in $(printf '%s' "$line" | grep -oE '\[[a-z0-9:_-]+\]' | tr -d '[]'); do
        case " $removed_tags " in *" $t "*) cur_entry=""; break;; esac
      done
    elif [[ "$line" == +* ]] && [ -n "$cur_entry" ]; then
      cur_meta+="${line:1}"$'\n'
    fi
  done <<< "$diff_out"
  verdict "$f" "$cur_entry" "$cur_meta"
}

verdict() {
  local f="$1" entry="$2" meta="$3"
  [ -z "$entry" ] && return 0
  local title="${entry:0:70}"

  if ! printf '%s' "$meta" | grep -Eq "$META_RE"; then
    report "❌ $f: 新条目缺 channel 元数据"
    report "   $title"
    report "   加一行:<!-- channel: <test|permission|rule|ci|review|prompt|archive> | artifact: <路径或 -> | severity: <incident|normal> | cost: <run|phase|all,仅 incident 必填> | verified_at: <YYYY-MM-DD 或 -> -->"
    fail=1
    return 0
  fi

  local chan art sev
  chan="$(printf '%s' "$meta" | grep -Eo 'channel:[[:space:]]*[a-z-]+' | head -1 | sed 's/.*:[[:space:]]*//')"
  # 注意末尾 `-->`:artifact 若是注释里最后一个字段,`[^|>]+` 会把 ` --` 一起吃进来。
  # 不剥掉就会把合法产物判成不存在 —— 误拦比漏拦更危险(烦了会把整条 lint 删掉)。
  # LOW-6(2026-09-23,Opus fab-delta triage,CONFIRMED):`s/.*:[[:space:]]*//` 是贪婪匹配,
  # 吃到**最后一个**冒号为止 —— `artifact: C:/Users/<user>/foo.md` 这种带盘符的路径,贪婪匹配会连
  # `C:` 那个冒号也吃掉,截出 `/Users/<user>/foo.md`(缺盘符,不是真路径),把合法产物误判成不存在。
  # 真语料目前全是 `~/` 形所以今天没触发,但这是贪婪匹配对锚点的通病。改成锚定行首的
  # `^artifact:` 前缀 —— 这一步输入已经是 grep -Eo 'artifact:...' 单独截出来的那一段,必然以
  # 字面量 `artifact:` 开头,不会误伤值本身出现的任何后续冒号(含盘符冒号)。
  art="$(printf '%s' "$meta" | grep -Eo 'artifact:[[:space:]]*[^|>]+' | head -1 | sed 's/^artifact:[[:space:]]*//' | sed 's/[[:space:]-]*$//')"
  sev="$(printf '%s' "$meta" | grep -Eo 'severity:[[:space:]]*[a-z-]+' | head -1 | sed 's/.*:[[:space:]]*//')"

  # severity=incident 必须记代价范围(2026-08-06)。
  #
  # 由来:8/06 决定「桶 B 哪几条该建闸」时,我按**复发次数**排序,给
  # `validate-sim-covers-dominant-factor` 报了「1 次、零复发 → 不够格」。the maintainer 当场驳回:
  # 那条最贵 —— 头号不公平驱动从未被测,**之前所有公平数字都答非所问**,不是有偏差。
  # 我自己的文档写着「投资回报 = 次数 × 代价」,当场还是只按次数排了。
  #
  # 根因不是「不知道代价重要」,是**决策那一刻手边只有能数的东西**(tag 出现次数),
  # 代价躺在散文里("连续四轮""整个里程碑"),不能比较、不能排序。
  # 解法不是提醒也不是清单(文本对此已证伪),是 **schema**:把代价写进被排序的那一行本身,
  # 于是 triage 时读教训必然读到它,「去查」这一步被消除 —— 不依赖任何人记得任何事。
  #
  # 只要枚举、不要描述:描述本来就在条目正文,重写一遍既冗余又给误拦留口子。
  #   run   = 一次跑/一轮返工
  #   phase = 多轮或一个工作阶段的产出作废
  #   all   = 此前全部结果作废(测错了东西/答非所问)—— 8/06 那条属此级
  if [ "$sev" = "incident" ]; then
    if ! printf '%s' "$meta" | grep -Eq 'cost:[[:space:]]*(run|phase|all)([[:space:]]|\||-->|$)'; then
      report "❌ $f: severity=incident 缺 cost 代价范围"
      report "   $title"
      report "   加 cost: <run|phase|all> —— run=一轮返工 · phase=一个阶段作废 · all=此前全部作废(测错了东西)"
      report "   为什么必填:排序按「次数 × 代价」,而代价只在写下来的那一刻是已知的。"
      fail=1
    fi
    case "$chan" in
      prompt|review|archive)
        if ! printf '%s' "$meta" | grep -q 'accepted-risk' || ! printf '%s' "$meta" | grep -q 'expiry:'; then
          report "❌ $f: severity=incident 不能只走 channel=$chan"
          report "   $title"
          report "   事故级教训要落到确定性通道(test/permission/rule/ci),"
          report "   或显式写 accepted-risk + expiry: <YYYY-MM-DD> 认领残余风险。"
          fail=1
        fi ;;
    esac
  fi

  # 悬空指针预警(**只警告不阻断**)。2026-08-03 普查:204 个 tag 里 13 个悬空(6.4%),
  # 全部是"叙事末尾甩一个 [[tag]] 承诺拆成独立条目,然后没拆"。不是被删,是从没写过。
  # 不阻断的理由:tag 可能定义在别的库(rag: 命名空间就在 D:\example-project),硬拦会误伤 ——
  # 而误拦比漏拦危险,一条会误报的 lint 最后会被整个删掉。
  local t
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    if ! grep -rqE "^\*\*.*\[${t}\]|^- .*\[${t}\]" "$f" 2>/dev/null; then
      report "⚠ $f: [[${t}]] 在本文件里找不到定义 —— 若不在别的库,它就是个空承诺(不阻断)"
    fi
  done < <(printf '%s' "$meta" | grep -oE '\[\[[^]]+\]\]' | tr -d '[]' | sort -u)

  # 承诺了机器产物就必须真的存在 —— 否则"待修"会伪装成"已处理"。
  case "$chan" in
    test|permission|rule|ci)
      # `~` 不会被 [ -e ] 展开 —— 第一条真实条目就因此被误报,而文件其实存在。
      # 单元测试没覆盖到,是拿它跑真数据才发现的。
      local art_abs="${art/#\~/$PMM_HOME_RESOLVED}"
      if [ -n "$art" ] && [ "$art" != "-" ] && [ ! -e "$art_abs" ]; then
        report "❌ $f: channel=$chan 但 artifact 不存在:$art"
        report "   $title"
        report "   (这正是它该报的:产物没建出来 = 这条还没被真正处理。)"
        fail=1
      elif [ -z "$art" ] || [ "$art" = "-" ]; then
        report "❌ $f: channel=$chan 必须给 artifact 路径"
        report "   $title"
        fail=1
      fi ;;
  esac
}

self_test() {
  local tmp; tmp="$(mktemp -d)" || return 1
  case "$tmp" in /tmp/*|/var/*|"$TMPDIR"*) : ;; *) [ -d "$tmp" ] || return 1 ;; esac
  local rc=0

  # RED 1:缺 channel
  fail=0; verdict "t" '**2026-01-01 — x** [tag]' 'What happened: y'
  [ "$fail" = 1 ] && echo "  RED-1 缺 channel .......... 拦下 ✓" || { echo "  RED-1 .......... 漏了 ✗"; rc=1; }

  # RED 2:incident 只走 prompt(带上 cost,好让它只因 prompt 这一条失败,不混因)
  fail=0; verdict "t" '**x**' '<!-- channel: prompt | severity: incident | cost: run -->'
  [ "$fail" = 1 ] && echo "  RED-2 incident→prompt ..... 拦下 ✓" || { echo "  RED-2 ..... 漏了 ✗"; rc=1; }

  # RED 3:artifact 不存在
  fail=0; verdict "t" '**x**' '<!-- channel: test | artifact: nope/does-not-exist.ts -->'
  [ "$fail" = 1 ] && echo "  RED-3 artifact 不存在 ..... 拦下 ✓" || { echo "  RED-3 ..... 漏了 ✗"; rc=1; }

  # RED 4:test 通道没给 artifact
  fail=0; verdict "t" '**x**' '<!-- channel: test -->'
  [ "$fail" = 1 ] && echo "  RED-4 test 无 artifact .... 拦下 ✓" || { echo "  RED-4 .... 漏了 ✗"; rc=1; }

  # GREEN 1:合规(artifact 用本脚本自己,必然存在)
  fail=0; verdict "t" '**x**' "<!-- channel: rule | artifact: ${BASH_SOURCE[0]} | severity: normal -->"
  [ "$fail" = 0 ] && echo "  GREEN-1 合规条目 .......... 放行 ✓" || { echo "  GREEN-1 .......... 误拦 ✗"; rc=1; }

  # GREEN 2:incident 但显式认领残余风险(incident ⇒ cost 也必填)
  fail=0; verdict "t" '**x**' '<!-- channel: prompt | severity: incident | cost: run | accepted-risk | expiry: 2026-12-31 -->'
  [ "$fail" = 0 ] && echo "  GREEN-2 认领残余风险 ...... 放行 ✓" || { echo "  GREEN-2 ...... 误拦 ✗"; rc=1; }

  # RED 5:incident 缺 cost(2026-08-06 新增,防「按次数不按代价排序」重演)
  fail=0; verdict "t" '**x**' "<!-- channel: test | artifact: ${BASH_SOURCE[0]} | severity: incident -->"
  [ "$fail" = 1 ] && echo "  RED-5 incident 缺 cost .... 拦下 ✓" || { echo "  RED-5 .... 漏了 ✗"; rc=1; }

  # RED 6:cost 值不在枚举内(自由文本会让排序回到不可比,等于没记)
  fail=0; verdict "t" '**x**' "<!-- channel: test | artifact: ${BASH_SOURCE[0]} | severity: incident | cost: 很贵 -->"
  [ "$fail" = 1 ] && echo "  RED-6 cost 非枚举值 ....... 拦下 ✓" || { echo "  RED-6 ....... 漏了 ✗"; rc=1; }

  # GREEN 3:incident 带合法 cost,三个枚举值都要放行(误拦=这条 lint 会被整个删掉)
  local cv
  for cv in run phase all; do
    fail=0; verdict "t" '**x**' "<!-- channel: test | artifact: ${BASH_SOURCE[0]} | severity: incident | cost: $cv | verified_at: 2026-08-06 -->"
    [ "$fail" = 0 ] || { echo "  GREEN-3[$cv] ...... 误拦 ✗"; rc=1; }
  done
  [ "$rc" = 0 ] && echo "  GREEN-3 cost run/phase/all  放行 ✓"

  # GREEN 4:normal 级不强制 cost(不给普通教训加负担)
  fail=0; verdict "t" '**x**' "<!-- channel: rule | artifact: ${BASH_SOURCE[0]} | severity: normal -->"
  [ "$fail" = 0 ] && echo "  GREEN-4 normal 免 cost .... 放行 ✓" || { echo "  GREEN-4 .... 误拦 ✗"; rc=1; }

  # GREEN 5:LOW-6(2026-09-23,Opus fab-delta triage,CONFIRMED)—— 带盘符的 `C:/...` 形 artifact,
  # 文件确实存在,不该被误判成不存在。改动前(贪婪 sed 吃到 `C:` 的冒号)这一例是 RED。
  local win_artifact
  win_artifact="$(cygpath -m "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
  fail=0; verdict "t" '**x**' "<!-- channel: rule | artifact: ${win_artifact} | severity: normal -->"
  [ "$fail" = 0 ] && echo "  GREEN-5 C:/ 形 artifact .... 放行 ✓" || { echo "  GREEN-5 .... 误拦 ✗"; rc=1; }

  rmdir "$tmp" 2>/dev/null
  return $rc
}

if [ "${1:-}" = "--self-test" ]; then
  echo "lesson-channel-lint 自检:"
  if self_test; then echo "全部通过"; exit 0; else echo "有用例失败"; exit 1; fi
fi

[ $# -eq 0 ] && { report "用法: $0 <file>... | --self-test"; exit 1; }
for f in "$@"; do check_file "$f"; done
exit "$fail"
