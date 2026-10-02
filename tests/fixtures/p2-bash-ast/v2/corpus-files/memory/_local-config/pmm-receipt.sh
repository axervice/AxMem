#!/usr/bin/env bash
# 写前记忆收据(WAMR,2026-09-13,codex 评审 P0,Jax 批[memory:push-sediment-design-v2])
# 不变量:值得考虑沉淀的原始事实,在发生的那一刻落不可变收据——**逐字/指针,零概括**;
#         save 之后 cover 记水位;Stop 只数「未清收据」,数>0 就拦一次停机(每会话最多拦一次)。
# 为什么不是"会话结束时判断":Stop 是逐回合停止点不是会话结束事件([tooling:stop-hook-is-per-turn-not-session-end]);
# 为什么不做句子分类:判断题机器做不好(判断类审计 5/10 错)——收据只收确定性事件。
# 并发:每会话独立 spool 文件,append-only,无共享标量读改写。
set -u
RDIR="${PMM_RECEIPTS_DIR:-$HOME/.claude/memory/dreams/receipts}"
SDIR="${PMM_RECEIPT_STATE_DIR:-$HOME/.claude}"
mkdir -p "$RDIR" 2>/dev/null || true
# 2026-09-13 Opus 审计 P0-3:covered 按机器分文件——receipts/ 入库同步,双机 append 同一文件
# 会合并冲突 → autopull ff 失败 → PMM 整体停更。读侧聚合 covered-*.tsv。
MACH="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9-' | cut -c1-12)"; MACH="${MACH:-unknown}"
COVERED="$RDIR/covered-$MACH.tsv"

# 2026-09-13 Opus 审计 P0-1:本环境真实变量是 CLAUDE_CODE_SESSION_ID(CLAUDE_SESSION_ID 不存在,
# 原写法让全部收据落 spool-manual.tsv,并发不变量作废)。manual 兜底也按机器分,避免双机同文件。
sid() { printf '%s' "${1:-${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-manual-$MACH}}}" | tr -cd 'A-Za-z0-9-' | cut -c1-16; }
# esc:控制字符压平;>800B 时全文落 blobs/<id>.json,TSV 存截断标记+指针(「逐字零概括」不变量
# 在最高价值载荷上不许静默失守 —— Opus 审计 P2)。
esc() { printf '%s' "$1" | tr '\t\r\n' '   ' | cut -c1-800; }
esc_or_blob() { # $1=id $2=raw → stdout=入 TSV 的 note
  local raw="$2"
  if [ "${#raw}" -le 800 ]; then esc "$raw"; return; fi
  mkdir -p "$RDIR/blobs" 2>/dev/null || true
  printf '%s' "$raw" > "$RDIR/blobs/$1.txt" 2>/dev/null || true
  printf '%s …[truncated→blobs/%s.txt]' "$(printf '%s' "$raw" | tr '\t\r\n' '   ' | cut -c1-720)" "$1"
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  add)  # add <kind> <ref> <note...>
    kind="${1:?kind}"; ref="${2:-"-"}"; shift 2 2>/dev/null || true
    s="$(sid)"; id="r$(date +%s)$RANDOM"
    note="$(esc_or_blob "$id" "${*:-}")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$(date +%FT%T)" "$s" "$kind" "$(esc "$ref")" "$note" >> "$RDIR/spool-$s.tsv"
    echo "$id"
    ;;
  from-hook)  # PostToolUse(AskUserQuestion):结构化用户拍板 = 最高精度收据源,逐字入账
    # 2026-09-14 codex 修:真 JSON 解析 + 长答案 blob 保真(原 {[^}]*} 正则遇嵌套 } 截断)
    PMM_RECEIPTS_DIR_RESOLVED="$RDIR" PMM_RECEIPT_MACH="$MACH" \
      exec node "$(dirname "${BASH_SOURCE[0]}")/pmm-receipt-fromhook.cjs"
    ;;
  pending)  # 人读展示(截断);机器取数用 pending --ids
    n="$(bash "$0" pending-rows | grep -c . || true)"
    echo "$n"
    [ "$n" -gt 0 ] && bash "$0" pending-rows | cut -f1,4,5,6 | head -20
    ;;
  pending-rows)  # 纯数据:全部未清收据整行(无截断)。cover 只准用这个(Opus 审计 P0-2:
    # 原 cover 复用带 head -20 的展示输出 → 25 张只盖 20,灯从此撒谎)。
    tmp_all="$(cat "$RDIR"/spool-*.tsv 2>/dev/null || true)"
    [ -z "$tmp_all" ] && exit 0
    cov="$(cat "$RDIR"/covered-*.tsv 2>/dev/null | cut -f1 || true)"
    printf '%s\n' "$tmp_all" | awk -F'\t' -v c="$cov" 'BEGIN{n=split(c,a,"\n");for(i=1;i<=n;i++)k[a[i]]=1} NF&&!k[$1]{print}'
    ;;
  cover)  # cover --all | cover --dismiss --all|<id…> | cover <id...>
    # 凭证水位(Opus 审计 P1):cover=声称"已沉淀",必须有最早未清收据之后的 memory commit 作凭证;
    # 确属无需沉淀的走 --dismiss(显式弃单,via 如实记 dismissed,不冒充 save)。
    mode="save"
    [ "${1:-}" = "--dismiss" ] && { mode="dismissed"; shift; }
    if [ "${1:-}" = "--all" ]; then
      ids="$(bash "$0" pending-rows | cut -f1)"
    else
      ids="$*"
    fi
    [ -z "$ids" ] && { echo "covered: 0"; exit 0; }
    if [ "$mode" = "save" ] && [ -z "${PMM_RECEIPTS_DIR:-}" ]; then  # 自测夹具环境免验凭证
      oldest="$(bash "$0" pending-rows | cut -f2 | sort | head -1)"
      # 凭证只认内容文件(2026-09-14 codex 修):原来 -- .claude/memory 连收据 spool 自己的
      # commit 都算凭证 = 水位自我满足;拼写修正类无关提交也能错误结清——收窄到七个内容文件。
      if ! git -C "$HOME" log -1 --since="$oldest" --format=%h -- \
           .claude/memory/decisions.md .claude/memory/lessons.md .claude/memory/standinginstructions.md \
           .claude/memory/progress.md .claude/memory/processes.md .claude/memory/memory.md .claude/memory/timeline.md \
           2>/dev/null | grep -q .; then
        echo "⛔ 无凭证:最早未清收据($oldest)之后没有任何 memory commit——先 pmm:save,或确属无需沉淀用 cover --dismiss" >&2
        exit 1
      fi
      via="save-$(git -C "$HOME" rev-parse --short HEAD 2>/dev/null || date +%F)"
    else
      via="$mode-$(date +%F)"
    fi
    for i in $ids; do printf '%s\t%s\t%s\n' "$i" "$(date +%FT%T)" "$via" >> "$COVERED"; done
    echo "covered: $(printf '%s' "$ids" | wc -w | tr -d ' ')"
    ;;
  stop-check)  # Stop hook:未清收据>0 → 拦一次停机(exit2 反馈);每会话最多拦一次;递归防护
    IN="$(cat 2>/dev/null || true)"
    printf '%s' "$IN" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0
    s="$(sid "$(printf '%s' "$IN" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')")"
    stamp="$SDIR/.receipt-nag-$s"
    [ -f "$stamp" ] && exit 0
    n="$(bash "$0" pending | head -1)"
    [ "${n:-0}" -gt 0 ] || exit 0
    date +%FT%T > "$stamp"
    echo "🧾 有 ${n} 张未清记忆收据(用户拍板/守卫变更等原始事实已落盘但未沉淀)。停机前处理:跑 pmm:save 把它们写成正式记忆,然后 bash ~/.claude/memory/_local-config/pmm-receipt.sh cover --all;确属无需沉淀的,直接 cover。本会话只提醒这一次。" >&2
    exit 2
    ;;
  session-lamp)  # SessionStart 灯(autopull 调用):跨会话/崩溃后的接力提示
    n="$(bash "$0" pending | head -1)"
    [ "${n:-0}" -gt 0 ] && echo "🧾 未清记忆收据 ${n} 张(含此前会话遗留)—— pmm-receipt.sh pending 查看;save 后 cover。"
    exit 0
    ;;
  --self-test)
    T="$(mktemp -d)"; export PMM_RECEIPTS_DIR="$T/r" PMM_RECEIPT_STATE_DIR="$T/s"; mkdir -p "$T/s"
    ok=0
    id="$(CLAUDE_SESSION_ID=selftest bash "$0" add test-kind ref1 一条测试收据)" || true
    [ "$(bash "$0" pending | head -1)" = "1" ] && ok=$((ok+1))
    printf '{"session_id":"selftest","stop_hook_active":false}' | bash "$0" stop-check 2>/dev/null; [ $? -eq 2 ] && ok=$((ok+1))
    printf '{"session_id":"selftest","stop_hook_active":false}' | bash "$0" stop-check 2>/dev/null; [ $? -eq 0 ] && ok=$((ok+1))  # 二次不拦
    bash "$0" cover "$id" >/dev/null
    [ "$(bash "$0" pending | head -1)" = "0" ] && ok=$((ok+1))
    printf '{"session_id":"x","stop_hook_active":true}' | bash "$0" stop-check; [ $? -eq 0 ] && ok=$((ok+1))  # 递归防护
    # 逃逸回归(Opus P0-2):25 张 cover --all 必须全盖(原版复用 head -20 展示只盖 20)
    for i in $(seq 1 25); do CLAUDE_SESSION_ID=bulk bash "$0" add k r "n$i" >/dev/null; done
    bash "$0" cover --all >/dev/null
    [ "$(bash "$0" pending | head -1)" = "0" ] && ok=$((ok+1))
    rm -rf "$T"
    if [ "$ok" -eq 6 ]; then echo "pmm-receipt 自证 6/6"; exit 0; else echo "✖ pmm-receipt 自证 $ok/6"; exit 1; fi
    ;;
  *)
    echo "usage: pmm-receipt.sh add <kind> <ref> <note…> | from-hook | pending | cover --all|<id…> | stop-check | session-lamp | --self-test" >&2
    exit 1
    ;;
esac
