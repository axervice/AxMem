#!/usr/bin/env bash
# PMM pre-commit 完整性闸(codex R3,2026-07-25):统一写入边界——校验【暂存最终态】,
# 天然覆盖 Edit/bash/sed/脚本/未来任何写入工具;PostToolUse 守卫降级为即时友好提醒。
# 检查: Index↔Entries 奇偶 · 孤儿日期块 · 新增条目标题必须带 [tag]。拒绝=exit1,修完再 commit。
set -u

# --self-test:在临时假 HOME 里造仿真仓库,证明 F/G 两个检查真能红也真能绿。
# 存在理由:守卫的头号死因是静默失效(本周审计挖出 6 件),名册里的每一台都必须能自证。
# 不碰真记忆、不碰真基线;临时仓库用完即删。
if [ "${1:-}" = "--self-test" ]; then
  _t=$(mktemp -d) || exit 1
  case "$_t" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) echo "mktemp 异常路径,拒绝继续"; exit 1;; esac
  _self="$HOME/.claude/pmm-precommit-gate.sh"
  mkdir -p "$_t/.claude/memory/_local-config"
  ( cd "$_t" && git init -q && git config user.email t@t && git config user.name t ) || { rm -rf "$_t"; exit 1; }
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n- 2026-01-02 [a:doomed] d\n\n## Entries\n\n**2026-01-01 — keep** [a:keep]\nb\n\n**2026-01-02 — doomed** [a:doomed]\nb\n' > "$_t/.claude/memory/lessons.md"
  printf '# archive\n' > "$_t/.claude/memory/lessons-archive.md"
  ( cd "$_t" && git add -A && git commit -qm base ) >/dev/null 2>&1
  _rc=0
  # F 红:删条目不入档 → 必须拦
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep** [a:keep]\nb\n' > "$_t/.claude/memory/lessons.md"
  ( cd "$_t" && git add -A ) >/dev/null 2>&1
  HOME="$_t" bash "$_self" >/dev/null 2>&1 && { echo "✖ F 红失败:删了不入档竟放行"; _rc=1; }
  # F 绿:整条 verbatim 入档 → 必须放行
  printf '# archive\n\n**2026-01-02 — doomed** [a:doomed]\nb\n' > "$_t/.claude/memory/lessons-archive.md"
  ( cd "$_t" && git add -A ) >/dev/null 2>&1
  HOME="$_t" bash "$_self" >/dev/null 2>&1 || { echo "✖ F 绿失败:入档了竟被拦"; _rc=1; }
  # G 红:活体 ≠ 备份 → 必须拦
  printf 'v1\n' > "$_t/.claude/memory/_local-config/probe.sh"; printf 'v2\n' > "$_t/.claude/probe.sh"
  ( cd "$_t" && git add -A ) >/dev/null 2>&1
  HOME="$_t" bash "$_self" >/dev/null 2>&1 && { echo "✖ G 红失败:备份漂移竟放行"; _rc=1; }
  # G 绿:同步后 → 必须放行;且「只有备份没活体」不得误拦
  printf 'v2\n' > "$_t/.claude/memory/_local-config/probe.sh"; printf 'x\n' > "$_t/.claude/memory/_local-config/orphan.sh"
  ( cd "$_t" && git add -A ) >/dev/null 2>&1
  HOME="$_t" bash "$_self" >/dev/null 2>&1 || { echo "✖ G 绿失败:同步了竟被拦(或孤儿备份误拦)"; _rc=1; }
  # F 假红回归(复核 2026-08-05):**改写标题**不得误拦 —— tag 还领着 entry 就是改写不是退役
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep 改了措辞** [a:keep]\nb\n' > "$_t/.claude/memory/lessons.md"
  ( cd "$_t" && git add -A ) >/dev/null 2>&1
  HOME="$_t" bash "$_self" >/dev/null 2>&1 || { echo "✖ F 假红回归:改写标题被误判成退役(误拦→检查会被整个关掉)"; _rc=1; }
  # G 假绿回归(复核 2026-08-05):野文件在场时**真活体的漂移**必须仍被抓到
  mkdir -p "$_t/.claude/guards"
  printf 'REAL-DRIFTED\n' > "$_t/.claude/guards/probe.sh"   # 真活体漂移(备份是 v2)
  printf 'v2\n' > "$_t/.claude/probe.sh"                    # 野文件恰好等于备份 → 第一版会在此 break 判绿
  ( cd "$_t" && git add -A ) >/dev/null 2>&1
  HOME="$_t" bash "$_self" >/dev/null 2>&1 && { echo "✖ G 假绿回归:野文件掩盖了真活体漂移(本轮最严重那条)"; _rc=1; }
  rm -rf "$_t"
  [ "$_rc" -eq 0 ] && echo "✅ pmm-precommit-gate 自测:F/G 各红各绿,边界不误拦"
  exit "$_rc"
fi

cd "$HOME" || exit 0
fail=0; msg=""
check_file(){ # $1=relpath $2=mode(dl|std) $3=label
  git diff --cached --quiet -- "$1" 2>/dev/null && return 0
  tmp=$(mktemp); git show ":$1" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  if [ "$2" = "std" ]; then
    ix=$(awk '/^### Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/{n++} END{print n+0}' "$tmp")
    en=$(awk '/^## Entries/{e=1} e&&/^\*\*20/{n++} END{print n+0}' "$tmp")
  else
    ix=$(awk '/^## Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/{n++} END{print n+0}' "$tmp")
    en=$(grep -c '^\*\*20' "$tmp")
  fi
  [ "$ix" -ne "$en" ] && { fail=1; msg="${msg}  $3: Index ${ix} ≠ Entries ${en} —— 新条目补 Index 行/排查畸形条目\n"; }
  o=$(awk '/^## Index|^### Index/{i=1} /^## Entries/{i=0} !i&&/^- 20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/{n++} END{print n+0}' "$tmp")
  [ "$o" -gt 0 ] && { fail=1; msg="${msg}  $3: ${o} 个孤儿日期列表块(v2.1 事故形态,必须标准条目化)\n"; }
  nt=$(git diff --cached -- "$1" | grep -c '^+\*\*20' 2>/dev/null); nt=${nt:-0}
  ntag=$(git diff --cached -- "$1" | grep '^+\*\*20' 2>/dev/null | grep -c '\[[a-z]'); ntag=${ntag:-0}
  [ "$nt" -gt "$ntag" ] && { fail=1; msg="${msg}  $3: $((nt-ntag)) 条新增条目标题缺 [namespace:tag]\n"; }
  rm -f "$tmp"
}
check_file ".claude/memory/decisions.md" dl decisions
check_file ".claude/memory/lessons.md" dl lessons
check_file ".claude/memory/standinginstructions.md" std standing

# ── F:退役 = 移动,不是删除(2026-08-05 Fable)────────────────────────────────
# 由来:两天内两次差点丢内容,形态都是「声称已被 X 取代」而 X 里其实没有。
# 正确解法不是去 X 里搜内容(模糊匹配 = 又一台文本级守卫,自身缺陷率不低于被守对象),
# 而是**取消「删除」这个动作**:live 删掉一条 → 同 commit 必须在对应 archive 出现同一条标题行。
# 「内容丢失」于是结构上不可能,「X 有没有覆盖到」这个问题直接消失 —— 原文永远在档案里。
# 逐字精确匹配(grep -Fqx),零语义判断:改写正文不触发,真删条目才触发。
#
# 2026-08-05 对抗复核修的假红:第一版只看 diff 的 `-` 行,于是**改写标题**(补 tag、改措辞、
# 修错字)也被判成「删了不入档」。误拦比漏拦危险 —— 拦烦了人会把整个检查关掉(本周已两次
# 亲历这个模式)。判据改为 **tag 是否还领着一条 entry**:tag 还在 = 改写,tag 没了 = 真退役。
# 用 `^\*\*20` 过滤后再找 tag,避免 Index 行里的同名 tag 造成假绿(Index 行也带 tag)。
check_retire(){ # $1=live $2=archive $3=label
  git diff --cached --quiet -- "$1" 2>/dev/null && return 0
  removed=$(git diff --cached -U0 -- "$1" | sed -n 's/^-\(\*\*20.*\)$/\1/p')
  [ -z "$removed" ] && return 0
  ltmp=$(mktemp); git show ":$1" > "$ltmp" 2>/dev/null || : > "$ltmp"
  atmp=$(mktemp)
  git show ":$2" > "$atmp" 2>/dev/null || git show "HEAD:$2" > "$atmp" 2>/dev/null || : > "$atmp"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    tag=$(printf '%s' "$line" | grep -oE '\[[a-z0-9][a-z0-9:._-]*\]' | head -1)
    # tag 仍领着 live 里某条 entry → 这是改写标题,不是退役,放行
    if [ -n "$tag" ] && grep -E '^\*\*20' "$ltmp" | grep -Fq "$tag"; then continue; fi
    grep -Fqx "$line" "$atmp" && continue
    fail=1
    msg="${msg}  $3: 删了条目但 archive 里没有 ——\n       ${line}\n     退役=移动:整条 verbatim 挪进 $(basename "$2") 同 commit 提交(别只留指针,更别只删)\n"
  done <<RETIRE_EOF
$removed
RETIRE_EOF
  rm -f "$atmp" "$ltmp"
}
check_retire ".claude/memory/decisions.md"            ".claude/memory/decisions-archive.md"            decisions
check_retire ".claude/memory/lessons.md"              ".claude/memory/lessons-archive.md"              lessons
check_retire ".claude/memory/standinginstructions.md" ".claude/memory/standinginstructions-archive.md" standing

# ── G:活体脚本改了,备份必须同 commit 跟上(2026-08-05 Fable)──────────────────
# 由来:2026-08-05 我自己重复犯了 5 次——活体 hook 改完、_local-config 备份没跟上,
# 每次都靠「提交后读回实际内容」才发现。根因不是「忘了 cp」,是 `cp && git add` 串一条命令时
# cp 失败被后面的退出码盖住,没人读。活体在 .gitignore 里(不入库),备份是它唯一的云端副本
# —— 漂移 = 换机恢复拿到旧版本 = 静默失效,正是本周审计挖出 6 件的同一种病。
# 只查「已有备份」的脚本(不强迫给新脚本建备份),且只在本次 commit 已经在动 PMM 时才跑(hook 前置条件)。
#
# 2026-08-05 对抗复核抓到的**假绿**(本轮最严重):第一版按路径顺序找到第一个存在的候选就
# `break`,于是 `~/.claude/` 下有同名**野文件**时,它比的是野文件、真活体(guards/ 里那个)
# 的漂移完全查不到 —— 而这事今天真发生过(一条写错的 cp 造出 `~/.claude/guard-canary.sh`,
# 内容其实是 pmm-autopull 的副本)。修法:**三处全查**,任一漂移即拦;同名出现在多处本身
# 也拦(野文件是隐患:谁按名字跑就跑错脚本)。
for _bk in "$HOME/.claude/memory/_local-config"/*.sh; do
  [ -e "$_bk" ] || continue
  _bn=$(basename "$_bk"); _n=0; _where=""
  for _live in "$HOME/.claude/$_bn" "$HOME/.claude/hooks/$_bn" "$HOME/.claude/guards/$_bn"; do
    [ -f "$_live" ] || continue
    _n=$((_n+1)); _where="$_where ${_live#"$HOME"/}"
    diff -q "$_live" "$_bk" >/dev/null 2>&1 || {
      fail=1
      msg="${msg}  备份漂移: ${_bn} 活体 ≠ _local-config 副本(可能与本次改动无关,但漂移=换机拿到旧版本,顺手修掉)\n     cp \"${_live#"$HOME"/}\" .claude/memory/_local-config/ 然后一起 add(活体 gitignore,备份是唯一云端副本)\n"
    }
  done
  [ "$_n" -gt 1 ] && {
    fail=1
    msg="${msg}  同名活体出现在多处:${_bn} →${_where}\n     野文件会让漂移检查比错对象(2026-08-05 真出过),也会让人按名字跑错脚本。删掉多余的那个。\n"
  }
done

if [ "$fail" -eq 1 ]; then
  printf '⛔ PMM pre-commit 完整性闸(Write Discipline v2 第5条):\n%b   修复后重新 add + commit。\n' "$msg" >&2
  exit 1
fi
exit 0
