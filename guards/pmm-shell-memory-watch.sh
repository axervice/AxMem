#!/usr/bin/env bash
# pmm-shell-memory-watch.sh — PostToolUse Bash|PowerShell content-change watch on the 7 PMM memory
# corpus files (report-only; codex 终审 #9,guards/audits/OPUS-2026-09-23-codex-final-triage.md #9 +
# 附录A「选项B」,Opus 验收批准 2026-09-23)。
#
# 问题(见附录A):Edit/Write/MultiEdit 已经有 PreToolUse trigger 语法闸(pmm-trigger-write-gate.cjs)
# + PostToolUse 写入完整性闸(pmm-entry-length-watch.sh --block);Bash/PowerShell 工具直改活体 memory
# (`printf >> lessons.md`、sed -i、PowerShell Add-Content 等)此前只有 `git commit` 时的提交闸兜底——
# 召回在提交之前读到的是未经校验的活体内容。
#
# 方案(选项B):每次 Bash|PowerShell 工具调用后,比对 7 个语料文件(pmm-core.cjs 的 ALL_FILES,不在
# 本文件手写第二份清单)的 size+mtime;有变化就对变化的文件跑 Edit 路径上**同一个** 校验器——
# pmm-entry-length-watch.sh --block(超长/奇偶/孤儿/伪装标题/悬空引用/取代记账/图不变量/冗余)+
# pmm-trigger-write-gate.cjs(B5/B32 trigger 语法 + 新增条目 trigger 在场性)。两者都没有改一行逻辑,
# 只是喂给它们一份「本次 Bash/PowerShell 调用前后」的合成 hook 载荷。
#
# report-only(这一轮):恒 exit 0,从不拦截、也从不自动回滚——共享工作树下自动回滚会吞掉并行会话
# 的合法写入(全局 CLAUDE.md 残余风险 #6 实证过两次)。发现的问题写到 stderr(hook 日志可见)+
# hookSpecificOutput.additionalContext(格式与 pmm-trigger-recall.cjs 的 PostToolUse 输出一致)。
#
# 性能:tool_name 不是 Bash/PowerShell 时,只读 stdin 前 4KB 判断 tool_name 就退出,不 source
# pmm-home.sh、不起 node——不重复 Edit 路径的开销。tool_name 匹配但 7 个语料文件相对上一次快照
# 都没变时,只做 stat 比对,不读文件内容、不跑两个校验器、不起 node(除非需要 resolveRoot()
# 且调用方没有直接给 PMM_MEM_DIR/PMM_TRIGGER_STATE 覆盖)。只有真的检测到变化才付两个校验器的
# 全价(~1.9s,与 Edit 路径的 Post 同一个数量级——两边本就是同一份校验逻辑)。
#
# 快照:每个语料文件在 $SNAP_DIR 下有一份 <basename>.stat(size+mtime 文本)与 <basename>(上一次
# 观测到的完整内容镜像)。本会话/本 snapshot 目录第一次被调用时(没有 .bootstrapped 标记)只建立
# 基线、不判断——避免把「装上这道闸之前就已经存在」的存量内容误判成这一次 Bash 调用改的。之后
# 每次调用:stat 不同 = 变化;变化文件的镜像内容(装闸前/上一次观测到的「旧」)与磁盘活体内容
# (这一次的「新」)一起合成一份 Write 形态的 hook 载荷,喂给 pmm-trigger-write-gate.cjs——
# 这正是它的「新增条目」判据需要的「新旧对照」,不是凭空发明。
set -uo pipefail

G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES="decisions.md lessons.md standinginstructions.md classes.md decisions-archive.md lessons-archive.md standinginstructions-archive.md"
stat_of() { [ -f "$1" ] && stat -c '%s %Y' "$1" 2>/dev/null || printf '0 0'; }

# ── --self-test:临时 HOME(只覆盖 PMM_MEM_DIR/PMM_STATE_FILE/PMM_TRIGGER_STATE,不碰真记忆/真基线;
#    不覆盖 HOME,让两个被复用的校验器按各自约定从真实 guards/ 解析它们自己的依赖,只读不写)──────
if [ "${1:-}" = "--self-test" ]; then
  SELF="$G/$(basename "${BASH_SOURCE[0]}")"
  T="$(mktemp -d "${TMPDIR:-/tmp}/pmm-shell-memory-watch-selftest.XXXXXX")" \
    || { echo "FATAL: mktemp -d failed"; exit 1; }
  trap 'rm -rf "$T"' EXIT
  case "$T" in /tmp/*|/var/*|"${TMPDIR:-/nonexistent}"*) : ;; *) echo "mktemp 异常路径 $T,拒绝继续"; exit 1;; esac
  mkdir -p "$T/mem"
  export PMM_MEM_DIR="$T/mem"
  export PMM_STATE_FILE="$T/state"
  export PMM_TRIGGER_STATE="$T/snap"

  pass=0; fail=0
  result_line() { # $1=PASS/FAIL  $2=名字  $3=细节
    if [ "$1" = PASS ]; then pass=$((pass+1)); echo "PASS - $2"
    else fail=$((fail+1)); echo "FAIL - $2 -- $3"; fi
  }
  call() { # $1=tool_name -> 输出脚本 stdout(若有),stderr 落到 $T/last.err,rc 落到 $CALL_RC
    printf '{"session_id":"selftest","tool_name":"%s"}' "$1" | bash "$SELF" >"$T/last.out" 2>"$T/last.err"
    CALL_RC=$?
  }

  cat > "$T/mem/lessons.md" <<'FIXTURE_EOF'
## Index

- 2026-01-01 [selftest:base] base entry

## Entries

**2026-01-01 — base entry** [selftest:base]
<!-- attribution: selftest -->
<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->
body text
FIXTURE_EOF

  # 引导调用(第一次见到这个 PMM_TRIGGER_STATE 目录):只建立快照基线,不判断——不算①,只是前提。
  call Bash
  if [ "$CALL_RC" -ne 0 ] || [ -s "$T/last.err" ] || [ -s "$T/last.out" ]; then
    result_line FAIL "引导调用静默(rc=0/无 stderr/无 stdout)" "rc=$CALL_RC err=$(cat "$T/last.err" 2>/dev/null | head -c 200) out=$(cat "$T/last.out" 2>/dev/null | head -c 200)"
  else
    result_line PASS "引导调用静默(rc=0/无 stderr/无 stdout,只建基线)"
  fi

  # ① 无变化 → 无输出 rc=0(文件相对上一次快照没有任何 stat 变化)
  call Bash
  if [ "$CALL_RC" -eq 0 ] && [ ! -s "$T/last.err" ] && [ ! -s "$T/last.out" ]; then
    result_line PASS "①无变化 -> 无输出 rc=0"
  else
    result_line FAIL "①无变化 -> 无输出 rc=0" "rc=$CALL_RC err=$(cat "$T/last.err" 2>/dev/null | head -c 200) out=$(cat "$T/last.out" 2>/dev/null | head -c 200)"
  fi

  # ② 非法追加(模拟 Bash `>>`:新条目 Index/Entries 奇偶对齐,但缺 trigger 行) → 必须报告,report-only 仍 rc=0
  cat > "$T/mem/lessons.md" <<'FIXTURE_EOF'
## Index

- 2026-01-01 [selftest:base] base entry
- 2026-02-02 [selftest:red] illegal entry

## Entries

**2026-01-01 — base entry** [selftest:base]
<!-- attribution: selftest -->
<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->
body text

**2026-02-02 — illegal entry** [selftest:red]
<!-- attribution: selftest -->
body missing trigger,合法追加对照见下一例
FIXTURE_EOF
  call Bash
  if [ "$CALL_RC" -eq 0 ] && grep -q '⚠' "$T/last.err" 2>/dev/null && grep -q 'pmm-shell-memory-watch' "$T/last.err" 2>/dev/null; then
    result_line PASS "②非法追加(缺 trigger)-> 报告 rc=0(report-only)"
  else
    result_line FAIL "②非法追加(缺 trigger)-> 报告 rc=0(report-only)" "rc=$CALL_RC err=$(cat "$T/last.err" 2>/dev/null | head -c 300)"
  fi

  # ③ 合法追加(带 trigger、奇偶平) → 不报告。②的 illegal entry 此刻已是「存量」(上一轮已刷新进快照),
  #    只有这一条 green 是「新增」,且带合法 trigger——presence 闸不追溯存量,parity 仍然平。
  cat > "$T/mem/lessons.md" <<'FIXTURE_EOF'
## Index

- 2026-01-01 [selftest:base] base entry
- 2026-02-02 [selftest:red] illegal entry
- 2026-03-03 [selftest:green] legal entry

## Entries

**2026-01-01 — base entry** [selftest:base]
<!-- attribution: selftest -->
<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->
body text

**2026-02-02 — illegal entry** [selftest:red]
<!-- attribution: selftest -->
body missing trigger,合法追加对照见下一例

**2026-03-03 — legal entry** [selftest:green]
<!-- attribution: selftest -->
<!-- trigger: tool=Edit; repo=home; path=.claude/guards/* -->
body text,带合法 trigger,不应被报告
FIXTURE_EOF
  call Bash
  if [ "$CALL_RC" -eq 0 ] && [ ! -s "$T/last.err" ]; then
    result_line PASS "③合法追加(带 trigger、奇偶平)-> 不报告"
  else
    result_line FAIL "③合法追加(带 trigger、奇偶平)-> 不报告" "rc=$CALL_RC err=$(cat "$T/last.err" 2>/dev/null | head -c 300)"
  fi

  # ④ PowerShell 工具名同样触发(再追加一条缺 trigger 的条目,tool_name=PowerShell)
  cat >> "$T/mem/lessons.md" <<'FIXTURE_EOF'

**2026-04-04 — red2 entry** [selftest:red2]
<!-- attribution: selftest -->
body missing trigger(PowerShell 路径)
FIXTURE_EOF
  sed -i '/- 2026-03-03 \[selftest:green\] legal entry/a - 2026-04-04 [selftest:red2] red2 entry' "$T/mem/lessons.md"
  call PowerShell
  if [ "$CALL_RC" -eq 0 ] && grep -q '⚠' "$T/last.err" 2>/dev/null && grep -q 'pmm-shell-memory-watch' "$T/last.err" 2>/dev/null; then
    result_line PASS "④PowerShell 工具名同样触发"
  else
    result_line FAIL "④PowerShell 工具名同样触发" "rc=$CALL_RC err=$(cat "$T/last.err" 2>/dev/null | head -c 300)"
  fi

  # ⑤ tool_name=Edit 时直接退出(不重复 Edit 路径):先改出一处会被抓到的违规,再用 Edit 调一次——
  #    必须静默零输出。随后紧跟一次不再改动文件的 Bash 调用:它必须仍然抓到这处违规,证明 Edit
  #    调用真的什么都没做(包括没有偷偷把快照往前推),不是「报告了但我们没看」。
  cat >> "$T/mem/lessons.md" <<'FIXTURE_EOF'

**2026-05-05 — red3 entry** [selftest:red3]
<!-- attribution: selftest -->
body missing trigger(应被 Edit 分支跳过)
FIXTURE_EOF
  sed -i '/- 2026-04-04 \[selftest:red2\] red2 entry/a - 2026-05-05 [selftest:red3] red3 entry' "$T/mem/lessons.md"
  call Edit
  if [ "$CALL_RC" -eq 0 ] && [ ! -s "$T/last.err" ] && [ ! -s "$T/last.out" ]; then
    result_line PASS "⑤tool_name=Edit -> 直接退出(无输出)"
  else
    result_line FAIL "⑤tool_name=Edit -> 直接退出(无输出)" "rc=$CALL_RC err=$(cat "$T/last.err" 2>/dev/null | head -c 300) out=$(cat "$T/last.out" 2>/dev/null | head -c 200)"
  fi
  call Bash
  if [ "$CALL_RC" -eq 0 ] && grep -q '⚠' "$T/last.err" 2>/dev/null; then
    result_line PASS "⑤附加:Edit 调用没有偷偷推进快照(随后的 Bash 复查仍抓到 red3)"
  else
    result_line FAIL "⑤附加:Edit 调用没有偷偷推进快照(随后的 Bash 复查仍抓到 red3)" "rc=$CALL_RC err=$(cat "$T/last.err" 2>/dev/null | head -c 300)"
  fi

  echo "pmm-shell-memory-watch 自证: pass=$pass fail=$fail"
  [ "$fail" -eq 0 ]
  exit $?
fi

# ── 正常 hook 调用:PostToolUse,stdin=hook JSON ──────────────────────────────────────────────
# tool_name 不是 Bash/PowerShell 就立刻退出——不 source pmm-home.sh、不起 node,不重复 Edit 路径。
if command -v timeout >/dev/null 2>&1; then
  _hin="$(timeout 1 head -c 4096 2>/dev/null || true)"
else
  _hin=""   # 拿不到就当没有,不裸 head 阻塞在不闭合管道上(同 pmm-entry-length-watch.sh 的既有教训)
fi
TOOL_NAME="$(printf '%s' "$_hin" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
case "$TOOL_NAME" in
  Bash|PowerShell) : ;;
  *) exit 0 ;;
esac
SID="$(printf '%s' "$_hin" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$SID" ] || SID="nosession"

# part13 收口(runner v2.26,coordinator 2026-09-23 复查):家目录一律经 pmm-home.sh 拿
# $PMM_HOME_RESOLVED,不直读 $HOME/~(哪怕只是兜底分支)——一律 source,不按有没有 PMM_MEM_DIR
# 覆盖来跳过,下面两处默认值都改用 $PMM_HOME_RESOLVED,不再有 ${PMM_HOME_RESOLVED:-$HOME} 这种
# 字面量兜底(pipe-gate-v2-acceptance.cjs self-check part13 逐行扫描,兜底分支也算数)。
source "$G/pmm-home.sh"

# 语料目录:PMM_MEM_DIR 覆盖优先。
MEM="${PMM_MEM_DIR:-$PMM_HOME_RESOLVED/.claude/memory}"

# 快照目录:PMM_TRIGGER_STATE 覆盖优先,否则用 resolveRoot()(pmm-recall-ledger.cjs 的唯一实现,
# 尊重 PMM_RECALL_ROOT)派生,按 session 分目录——不同会话不互相踩快照。
if [ -n "${PMM_TRIGGER_STATE:-}" ]; then
  SNAP_DIR="$PMM_TRIGGER_STATE"
else
  _ledger_arg="$(cygpath -m "$G/pmm-recall-ledger.cjs" 2>/dev/null || printf '%s' "$G/pmm-recall-ledger.cjs")"
  _root="$(node -e 'process.stdout.write(require(process.argv[1]).resolveRoot())' "$_ledger_arg" 2>/dev/null)"
  [ -n "${_root:-}" ] || _root="$PMM_HOME_RESOLVED/.claude/.local/pmm-recall"
  SNAP_DIR="$_root/shell-memory-snapshot-$SID"
fi
mkdir -p "$SNAP_DIR" 2>/dev/null || exit 0

# 批量 stat(一次 stat 调用取 7 个文件的 size+mtime,一次 awk 补齐缺失文件的哨兵值 "0 0")——
# 逐文件 fork stat+cat 共 14 次实测在这台 Windows/MSYS 上要 ~0.9s(每次 fork 几十毫秒累加),
# 批量后只有 2-3 次 fork,是"无变化时开销尽量低、只 stat 不读内容"这条约束下能做到的最快形状
# (bash 没有零 fork 拿文件 mtime 的内建办法)。$FILES 顺序固定,批量结果与之前逐文件版本等价。
stat_all() {
  local _args=() _f
  for _f in $FILES; do _args+=("$MEM/$_f"); done
  stat -c '%n %s %Y' "${_args[@]}" 2>/dev/null | awk -v files="$FILES" '
    BEGIN { n = split(files, order, " ") }
    { path = $1; size = $2; mt = $3; bn = path; sub(/^.*[\/\\]/, "", bn); seen[bn] = size " " mt }
    END { for (i = 1; i <= n; i++) { b = order[i]; print b, (b in seen ? seen[b] : "0 0") } }
  '
}
CUR_ALL="$(stat_all)"

# 引导:snapshot 目录第一次见到就只建基线,不判断——避免把装闸前就已存在的内容误判成这次改的。
if [ ! -e "$SNAP_DIR/.bootstrapped" ]; then
  printf '%s\n' "$CUR_ALL" > "$SNAP_DIR/all.stat" 2>/dev/null
  for f in $FILES; do
    live="$MEM/$f"
    [ -f "$live" ] && cp "$live" "$SNAP_DIR/$f" 2>/dev/null
  done
  : > "$SNAP_DIR/.bootstrapped" 2>/dev/null
  exit 0
fi

PREV_ALL=""
[ -f "$SNAP_DIR/all.stat" ] && PREV_ALL="$(cat "$SNAP_DIR/all.stat" 2>/dev/null)"
[ "$CUR_ALL" = "$PREV_ALL" ] && exit 0   # 无变化的唯一出口:只付了 stat_all() 那 2-3 次 fork

# 哪些文件变了:纯 bash 数组逐行比较(两个数组顺序都固定=$FILES 顺序),零额外 fork。
mapfile -t _cur_lines <<< "$CUR_ALL"
mapfile -t _prev_lines <<< "$PREV_ALL"
changed=""
for _i in "${!_cur_lines[@]}"; do
  if [ "${_cur_lines[$_i]:-}" != "${_prev_lines[$_i]:-}" ]; then
    changed="$changed ${_cur_lines[$_i]%% *}"
  fi
done
[ -z "$changed" ] && exit 0

# ── 有变化:两个校验器各跑一次,都是复用、不复制逻辑 ────────────────────────────────────────
MSG=""

# A. pmm-entry-length-watch.sh --block:与 Edit 路径共用同一份生产 $PMM_STATE_FILE/语料基线
#    (不在这里覆盖 PMM_STATE_FILE,除非调用方——比如 --self-test——已经自己 export 过)。
_elw_out="$(PMM_MEM_DIR="$MEM" bash "$PMM_HOME_RESOLVED/.claude/pmm-entry-length-watch.sh" --block </dev/null 2>&1)"
_elw_rc=$?
if [ "$_elw_rc" -ne 0 ]; then
  MSG="${MSG}⚠️ pmm-entry-length-watch --block 判违规(改动文件:${changed# }):\n${_elw_out}\n"
fi

# B. pmm-trigger-write-gate.cjs:它没有 module.exports(顶层脚本,读 stdin 就跑),按 spec 退化为调它
#    的 CLI——把「上一次观测到的镜像内容(旧)」当 file_path、把「这一次磁盘活体内容(新)」当
#    content,合成一份 Write 形态的 hook 载荷喂给它,判断逻辑与 Edit 路径完全一致,不重新发明。
#    JSON 用 node 现拼(heredoc 落一个临时 .cjs,不是 `node -e` 内联——2026-09-10 的教训:内联脚本
#    落盘会吃掉反斜杠),不是手写字符串拼接,避免语料内容里的引号/反斜杠把 JSON 拼坏。
if command -v node >/dev/null 2>&1; then
  for f in $changed; do
    live="$MEM/$f"
    shadow="$SNAP_DIR/$f"
    [ -f "$shadow" ] || : > "$shadow" 2>/dev/null   # 快照里从未见过这个文件 = 旧内容视为空
    if [ -f "$live" ]; then
      _jh="$(mktemp)" 2>/dev/null || _jh=""
      if [ -n "$_jh" ]; then
        cat > "$_jh" <<'JSON_HELPER_EOF'
const fs = require('fs');
const shadowPath = process.argv[2];
const livePath = process.argv[3];
const sid = process.argv[4];
let content = '';
try { content = fs.readFileSync(livePath, 'utf8'); } catch { content = ''; }
process.stdout.write(JSON.stringify({ session_id: sid, tool_name: 'Write', tool_input: { file_path: shadowPath, content } }));
JSON_HELPER_EOF
        _shadow_win="$(cygpath -m "$shadow" 2>/dev/null || printf '%s' "$shadow")"
        _live_win="$(cygpath -m "$live" 2>/dev/null || printf '%s' "$live")"
        _snap_win="$(cygpath -m "$SNAP_DIR" 2>/dev/null || printf '%s' "$SNAP_DIR")"
        _twg_out="$(node "$_jh" "$_shadow_win" "$_live_win" "$SID" 2>/dev/null | PMM_CANONICAL_MEMORY="$_snap_win" node "$G/pmm-trigger-write-gate.cjs" 2>/dev/null)"
        rm -f "$_jh"
        case "$_twg_out" in
          *'"permissionDecision":"deny"'*)
            MSG="${MSG}⚠️ pmm-shell-memory-watch: ${f} 的 trigger 校验(pmm-trigger-write-gate.cjs)判定 deny:\n${_twg_out}\n"
            ;;
        esac
      fi
    fi
  done
fi

# 刷新快照(不论本轮是否报告——report-only 不回滚,只是把「已看过」的基线往前挪,供下一次调用比对)。
for f in $changed; do
  live="$MEM/$f"
  printf '%s' "$(stat_of "$live")" > "$SNAP_DIR/$f.stat" 2>/dev/null
  if [ -f "$live" ]; then cp "$live" "$SNAP_DIR/$f" 2>/dev/null; else rm -f "$SNAP_DIR/$f" 2>/dev/null; fi
done
# all.stat 是无变化出口(上面 `[ "$CUR_ALL" = "$PREV_ALL" ] && exit 0`)唯一比对的基线;只在 bootstrap 写一次
# 就会让语料改过一次之后的每一次 Bash 调用都重跑校验器、重复同一条警告(Opus 终审 2026-09-23 HIGH,线上复现 5 次)。
printf '%s\n' "$CUR_ALL" > "$SNAP_DIR/all.stat" 2>/dev/null

if [ -n "$MSG" ]; then
  {
    printf '<!-- pmm-shell-memory-watch -->\n'
    printf '%b' "$MSG"
    echo "report-only(exit 0)· 不自动回滚(共享工作树下回滚会吞并行会话的合法写入,残余风险#6)· 规范参考 guards/audits/OPUS-2026-09-23-codex-final-triage.md #9 附录A选项B。"
  } >&2
  if command -v node >/dev/null 2>&1; then
    _ch="$(mktemp)" 2>/dev/null || _ch=""
    if [ -n "$_ch" ]; then
      cat > "$_ch" <<'CTX_HELPER_EOF'
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: process.argv[2] } }));
CTX_HELPER_EOF
      node "$_ch" "$(printf '%b' "$MSG")" 2>/dev/null
      rm -f "$_ch"
    fi
  fi
fi
exit 0
