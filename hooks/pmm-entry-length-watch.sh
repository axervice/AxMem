#!/usr/bin/env bash
# PMM write-integrity guard (v2, 2026-07-25「写入一步到位」— 原 entry-length guard 2026-07-04 扩展)
# 三重校验,对应 Write Discipline v2 第 5 条硬闸:
#   A. 超长净增(原有): decisions/lessons 条目体 > LIMIT 字节,数量较基线增加才拦(不骚扰存量豁免条)。
#   B. Index 奇偶(新): decisions/lessons/standing 的 Index 行数 == Entries 条目数,不平=有条目没建索引(或孤儿)。
#   C. 孤儿形态(新): 三文件非 Index 区出现「^- 20xx-xx-xx」日期列表块 = v2.1 式畸形写入,当场拦。
# 模式: SessionStart(无参)=站桩提醒; PostToolUse(--block)=违规 exit2 反馈 Claude 当场修。
# 2026-09-13 校准(the maintainer [memory:entry-cap-900b-sole-record],起因「壓的指針不失真」):
#   600→900:检索取回窗(标题+grep -A12)≈900B 一次取全 —— 条目再长取回也是截断的;
#   存量实况 超600B=233条 / 超900B=34条,旧线连忠实条目的自然尺寸都容不下,税全落在保真度。
#   [sole-record] 豁免:细节无处可指(无 repo/CHANGELOG/review 落点)→ 禁止强压,全文合法;
#   标记写在标题行或正文任意处,配对闸 = guards/pmm-pointer-lint.sh(能指的必须指得准)。
LIMIT=900
STATE="${PMM_STATE_FILE:-$HOME/.claude/.pmm-len-baseline}"   # 金丝雀红测用 override,防真基线被夹具毒化(2026-07-31 有过毒化事故)
MEM="${PMM_MEM_DIR:-$HOME/.claude/memory}"           # 金丝雀红测用 override:喂夹具目录,不碰真记忆
DEC="$MEM/decisions.md"; LES="$MEM/lessons.md"; STD="$MEM/standinginstructions.md"

count_over(){ [ -f "$1" ] || { echo 0; return; }
  # LC_ALL=C 钉死字节口径:CJK locale 下 awk length() 返回字符数,手动跑会把错误基线写进 STATE(2026-07-31 实测毒化事故)
  # 条目体边界 = `Ratified by:` 行 或 `---` 分隔线(2026-08-02 dream B2):此前一路累加到下个 `**20` 标题,
  # 把条目之后的归档出处注记(`*(…)*` / `*Archived →…` / `*RAG…`)与 PERMANENT 锚点块算进上一条 body,
  # 制造超长假象 —— 实测 m7-strategy 857→真 425(已达标)、codex-plus-backstop 2185→真 667。计数不准 = 分批收错对象。
  LC_ALL=C awk -v L="$LIMIT" '/^\*\*20/{if(h&&sz>L&&!ex)n++; h=$0;sz=0;stop=0;ex=index($0,"[sole-record]")>0;next} stop{next} /^---$/{stop=1;next} h{sz+=length($0); if(index($0,"[sole-record]")>0)ex=1} /^Ratified by:/{stop=1} END{if(h&&sz>L&&!ex)n++; print n+0}' "$1"; }
now=$(( $(count_over "$DEC") + $(count_over "$LES") ))

# B: Index↔Entries 奇偶(decisions/lessons: 全文件;standing: 只数 ## Entries 区条目 vs ### Index 行)
parity=""
p(){ # $1=file $2=label $3=mode(dl|std)
  [ -f "$1" ] || return 0
  if [ "$3" = "std" ]; then
    ix=$(awk '/^### Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/{n++} END{print n+0}' "$1")
    en=$(awk '/^## Entries/{e=1} e&&/^\*\*20/{n++} END{print n+0}' "$1")
  else
    ix=$(awk '/^## Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/{n++} END{print n+0}' "$1")
    en=$(grep -c '^\*\*20' "$1")
  fi
  [ "$ix" -ne "$en" ] && parity="$parity ${2}(Index ${ix}≠Entries ${en})"
}
p "$DEC" decisions dl; p "$LES" lessons dl; p "$STD" standing std

# C: 孤儿形态(非 Index 区的日期列表块;processes.md 体裁豁免不在此列)
orphans=""
for f in "$DEC" "$LES" "$STD"; do
  [ -f "$f" ] || continue
  o=$(awk '/^## Index|^### Index/{i=1} /^## Entries/{i=0} !i&&/^- 20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/{n++} END{print n+0}' "$f")
  [ "$o" -gt 0 ] && orphans="$orphans $(basename "$f" .md)(${o}块)"
done

# C2: progress.md 的 ## Active 段体积上限(2026-08-06,the maintainer 问「过时内容能不能自动移走」)。
#
# 为什么只卡体积、不判「过时」:机器分不清「试点店 cmrli86k7」是还在用还是早废了;
# 按日期标老行也不行(「生产 LIVE 07-12」又老又当前 → 大面积误报 → 检查被整条删掉)。
# **体积是纯事实,零判断。** 分工:机器只报「太大了」,砍哪几行由人定 —— 与已有的
# 条目超长闸同形状(它也只说「这条太长」,不说怎么压)。
#
# 它治的是一个机制而非一次疏忽:**加是事件触发**(每次干完活都有理由记一笔),
# **删是判断触发**(「这条还当前吗」的时机永远不明确)—— 只进不出的单向棘轮。
# 实测:Active 从「每项目 ≤5 行」的规矩涨到 52 行 / 30.4KB ≈ 1 万 tok/会话,
# 其中三周前的陈旧行 2026-08-06 两次误导判断(据「next M8.3」当主线,而 M20 早已 shipped)。
# 体积压力还**间接治过时**:被逼压缩时最先砍的自然是旧的。
# 上限 3000B ≈ 重写后 1613B 的近两倍裕量:容得下正常增长,拦得住失控。
PROG_LIMIT=3000
PROG="$MEM/progress.md"
active_bytes=0
[ -f "$PROG" ] && active_bytes=$(LC_ALL=C awk '/^## Active/{f=1;next} /^## Ledger/{f=0} f{n+=length($0)+1} END{print n+0}' "$PROG")

# D: 引用缺命名空间(阻断)。写 [[example-tag]] 而定义是 [example-project:example-tag] —— 两种写法并存,
# 任何"找悬空指针"的扫描都会大面积误报。2026-08-03 实测:107 个 tag 带前缀、34 个不带,
# 那 34 个直接制造了一轮 91 疑似 / 78 假阳性的普查浪费。纯正则、零判断,所以阻断。
noprefix=""
for _t in $(grep -rho '\[\[[a-z0-9][a-z0-9._-]*\]\]' "$MEM"/*.md 2>/dev/null | tr -d '[]' | sort -u); do
  case "$_t" in *:*) continue;; esac
  grep -rqh "\[[a-z]\{1,\}:${_t}\]" "$MEM"/*.md 2>/dev/null && noprefix="$noprefix [[${_t}]]"
done

# E(悬空引用检查)—— **建过,跑过,砍了。** 记在这里免得有人再造一遍:
# 设想是警告"[[tag]] 指向从没写过的条目"(2026-08-03 普查确有 13 处)。实现后在干净仓库上
# 一次报 48 条,里面是 [[0.4.0]] [[true]] [[index.ts]] [[qwen3:14b]],还有格式模板里的
# [[namespace:tag]] —— `[[...]]` 在代码示例、版本号、文件名里天然会出现,而真正的悬空
# 引用埋在这堆噪声里。再窄化也甩不掉跨库定义(ns1:/ns2: 在 D:\example-project 等)这一类真假阳性。
# 一个在干净仓库上就报 48 次的警告,第二天就没人看 —— 那比没有更糟,因为它读起来像有覆盖。
# 审查者(Fable)批准了这条,但它没跑过;**跑一次就废了。证据高于预测。**
# 真要做,正确形态不是"事后扫",是让漏写在结构上不可能 —— 见下方 F 的思路。

if [ "${1:-}" = "--block" ]; then
  prev=$(cat "$STATE" 2>/dev/null || echo -1)
  fail=0; msg=""
  if [ "$prev" -ge 0 ] 2>/dev/null && [ "$now" -gt "$prev" ]; then
    fail=1; msg="${msg}⚠️ 新增超长条目(${prev}→${now},上限 ${LIMIT}B): 压成「本体+WHY+→指针」,或——细节无处可指(PMM 是唯一档)时标 [sole-record] 全文保留(禁止失真强压)。\n"
  fi
  [ -n "$parity" ] && { fail=1; msg="${msg}⚠️ Index 奇偶不平:${parity} —— 新条目忘加 Index 行(或条目畸形没被计数),当场补齐。\n"; }
  [ -n "$orphans" ] && { fail=1; msg="${msg}⚠️ 孤儿日期列表块:${orphans} —— 规则性内容必须是标准条目(标题+tag+Ratified),禁止裸列表/挂尾(v2.1 事故形态)。\n"; }
  [ -n "$noprefix" ] && { fail=1; msg="${msg}⚠️ 引用缺命名空间:${noprefix} —— 定义带前缀、引用不带,会让悬空扫描大面积误报(2026-08-03: 34 处 → 一轮 78 个假阳性)。补成 [[ns:tag]]。\n"; }
  [ "$active_bytes" -gt "$PROG_LIMIT" ] && { fail=1; msg="${msg}⚠️ progress.md 的 ## Active 涨到 ${active_bytes}B(上限 ${PROG_LIMIT})——它每次开工全文注入,长了就不是仪表盘是日志。\n   压法:**整段原文先搬进 ## Ledger(退役=移动,别删),再重写 Active 为当前状态**。规矩:每项目 ≤5 行、只留状态与指针。\n   实测过的后果:上一版 30.4KB ≈ 1 万 tok/会话,且陈旧行两次误导判断(据「next M8.3」当主线,而 M20 早已 shipped)。\n"; }
  # F(未做,记在这里):"声称已被 X 取代但 X 里没有" 这类丢内容,正确解法不是去搜 X 的内容
  # (那是模糊匹配,会变成又一个自身缺陷不低于被守对象的文本级守卫),而是**取消"删除"这个动作**:
  # 退役 = 移动。live 文件删掉一条 → 同一 commit 必须在对应 *-archive.md 出现同一条标题行(逐字精确匹配)。
  # 这样"内容丢失"结构上不可能,"X 有没有覆盖到"这个问题直接消失 —— 原文永远在档案里。
  # 属 commit 级检查,归 pmm-precommit-gate.sh,不是这个 PostToolUse hook。(Fable 2026-08-03)
  if [ "$fail" -eq 1 ]; then
    # 基线不更新(codex R3 抓的粘性 bug:先写基线会让下一次调用 now==prev 放行)——修完超长回落后基线才随 pass 路径刷新
    { echo "<!-- pmm-write-integrity -->"; printf "%b" "$msg"; echo "   规范全文 → config.md Write Discipline v2。修完再继续。"; } >&2
    exit 2
  fi
  echo "$now" > "$STATE"
  exit 0
fi

# SessionStart: 刷新基线 + 站桩
echo "$now" > "$STATE"
out=""
[ "$now" -gt 0 ] && out="${out}ℹ️ decisions/lessons 有 ${now} 条超 ≤80 词纪律(>${LIMIT}B),dream 分批收。\n"
[ -n "$parity" ] && out="${out}⚠️ Index 奇偶不平:${parity}(立刻补齐)。\n"
[ -n "$orphans" ] && out="${out}⚠️ 孤儿块:${orphans}(按 Write Discipline v2 第2条重整)。\n"
[ -n "$out" ] && { echo "<!-- pmm-write-integrity -->"; printf "%b" "$out"; }
exit 0
