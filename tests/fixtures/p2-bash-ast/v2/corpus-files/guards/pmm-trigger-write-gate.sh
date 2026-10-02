#!/usr/bin/env bash
# pmm-trigger-write-gate.sh — PreToolUse wrapper for pmm-trigger-write-gate.cjs (HIGH-5, 2026-09-15,
# guards/audits/FABLE-2026-09-15-glob-review-triage.md finding 5). Matcher: Edit|Write|MultiEdit.
# fail-open on any hook-launch failure (settings.json wraps this with `|| exit 0`, matching the
# opus-justification-guard.sh convention — see pmm-trigger-write-gate.cjs's own header for why this
# hook itself fails open on everything except a confirmed illegal trigger).
set -u

# #16 修正(OPUS-2026-09-26 辩护方裁决,CODEX-2026-09-26-w11-w15-home-review.md #16):按字节数量
# tee 行长度,不用 `${#var}`(在 UTF-8 locale 下按字符数算,遇多字节字符会与真实字节数分叉)。定义
# 在文件顶层(不在下面的 tee 条件块里),供该块与 --self-test 的回归例共用同一份实现。
_TEE_MAX_LINE_BYTES=3800
_tee_bytelen() { printf '%s' "$1" | wc -c; }

# ── C05-BUILD-SPEC B2 tee (2026-09-24, read-only; PMM_TEE_LOG unset ⇒ zero behavior change) ──
# This whole hook only records HERE when the env var is set; the block below is a strict no-op
# (never touches stdout/stderr/exit code) whenever PMM_TEE_LOG is unset, which is every production
# invocation today -- every line after this block is therefore byte-identical to before this change.
if [ -n "${PMM_TEE_LOG:-}" ] && [ -z "${_PMM_TEE_INNER:-}" ] && [ "${1:-}" != "--self-test" ] && [ "${1:-}" != "--self-check" ]; then
  _tee_in="$(mktemp)"; _tee_out="$(mktemp)"; _tee_err="$(mktemp)"
  cat > "$_tee_in" 2>/dev/null || true
  _PMM_TEE_INNER=1 "$0" "$@" < "$_tee_in" > "$_tee_out" 2> "$_tee_err"
  _tee_rc=$?
  cat "$_tee_out"
  cat "$_tee_err" >&2
  _tee_tuid="$(grep -o '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$_tee_in" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  [ -z "$_tee_tuid" ] && _tee_tuid="$(grep -o '"toolUseId"[[:space:]]*:[[:space:]]*"[^"]*"' "$_tee_in" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  # M-10 fix (2026-09-24, audit `guards/audits/OPUS-2026-09-24-c05-batch-review.md` §2 / errata E-6):
  # record the hook's IDENTITY and its stdout's ORIGINAL text (spec item 2 says "把自己的 stdout/exit
  # code 追加一行", not a hash of it) instead of just sha256(stdout) with no way to tell which of the
  # four legacy hooks a line came from. base64-encodes stdout so embedded tabs/newlines never break
  # this TSV row; caps at 1200B of RAW stdout (item 20/23's existing payload ceiling, reused here since
  # no separate tee-specific cap exists in spec) before truncating, and always also records sha256 of
  # the FULL untruncated stdout so a truncated line still has something to verify a candidate blob
  # against.
  # E-6b fix (2026-09-24, C05-BUILD-SPEC addendum 3 item 29, main-brain ruling): 7 cols -> 9. stderr is
  # now captured to its own temp file (instead of inheriting fd 2 straight through) so it can be
  # base64-encoded into the tee row for the comparator to decode routing/length failures from; it is
  # still forwarded byte-for-byte to the real caller via `cat >&2` right after stdout, so --block mode's
  # stderr+exit-2 feedback path sees identical bytes as before -- only the timing (buffered vs live)
  # changes, and only while PMM_TEE_LOG is set.
  _tee_hook="$(basename "$0")"
  _tee_out_size="$(wc -c < "$_tee_out" 2>/dev/null | tr -d '[:space:]')"
  _tee_sha="$(sha256sum "$_tee_out" 2>/dev/null | cut -d' ' -f1)"
  if [ -n "$_tee_out_size" ] && [ "$_tee_out_size" -gt 1200 ]; then
    _tee_trunc=1
    _tee_b64="$(head -c 1200 "$_tee_out" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
  else
    _tee_trunc=0
    _tee_b64="$(base64 < "$_tee_out" 2>/dev/null | tr -d '\n')"
  fi
  _tee_err_size="$(wc -c < "$_tee_err" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$_tee_err_size" ] && [ "$_tee_err_size" -gt 1200 ]; then
    _tee_err_trunc=1
    _tee_err_b64="$(head -c 1200 "$_tee_err" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
  else
    _tee_err_trunc=0
    _tee_err_b64="$(base64 < "$_tee_err" 2>/dev/null | tr -d '\n')"
  fi
  # W12-2 (2026-09-25, 组9 tee 并发交织根治,不加锁): 四旧 hook 各写自己的文件(配置值 + "." + 本 hook
  # 基名,如 legacy-<mach>.log.pmm-trigger-write-gate),不再共用同一 $PMM_TEE_LOG——消除跨 hook 交织
  # (`>> "$PMM_TEE_LOG"` 本就是无锁 append,多个不同 hook 并发写*同一*文件才会在行中途切断;各写各的
  # 文件后同一文件只有这一只 hook 的调用会写,交织窗口消失,不需要 flock/mkdir 锁,也不改 settings.json
  # 或 $PMM_TEE_LOG 本身的配置值)。旧的统一文件路径保留只读(历史数据),对照器合并读四个分文件 + 该
  # 历史文件。
  #
  # LOW-2(FAB-2026-09-25 W11+W12 盲攻复核)+ #16 修正(OPUS-2026-09-26 辩护方裁决,CODEX-2026-09-26-
  # w11-w15-home-review.md #16,CONFIRMED):分文件之后同一分文件仍可能被同一 hook 的多个并发实例
  # (同一工具调用事件被并行触发两次)无锁 `>>` 追加。此前这里的依据写的是"整行字节数 < PIPE_BUF(标准
  # 4096)时,单次 write() 对同一 fd 的 O_APPEND 写是原子的"——这条引用是错的:PIPE_BUF 是 POSIX 对
  # pipe/FIFO 单次 write() 的原子性保证,不覆盖对普通文件的 O_APPEND 写,普通文件没有这条保证。真正
  # 兜底的是下游:撕裂行会改变列数,pmm-shadow-compare.cjs 的 parseLegacyLog() 按
  # `f.length !== 7 && f.length !== 9` 把它计入 parseErrors,在对照报告里可见,不会被静默接受为合法
  # 行(辩护方已实测确认)。这里的显式常量 + 写入前实测断言,语义仍是"超限就再截一刀、标 trunc=1"
  # (与两路 1200B 硬顶同款),只是不再需要 PIPE_BUF 撑腰。长度按字节数判断(`_tee_bytelen`,文件顶层
  # 定义,printf+wc -c,不用 `${#var}`——UTF-8 locale 下它按字符数算,tee 行里除 tool_use_id(平台生成
  # 的 ASCII `toolu_…`)外全是 ASCII,但字符数与字节数在含多字节字符时仍会分叉)。正常路径(两路都在
  # 1200B 硬顶内,实测整行约 3.4KB)不会触发这条兜底,行为与改动前逐字节相同。
  _tee_ts="$(date -u +%FT%TZ)"
  _tee_line="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_tee_ts" "$_tee_hook" "${_tee_tuid:--}" "$_tee_trunc" "${_tee_b64:--}" "${_tee_sha:--}" "$_tee_rc" "${_tee_err_b64:--}" "$_tee_err_trunc")"
  if [ "$(_tee_bytelen "$_tee_line")" -gt "$_TEE_MAX_LINE_BYTES" ]; then
    _tee_trunc=1
    _tee_b64="$(head -c 400 "$_tee_out" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
    _tee_line="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_tee_ts" "$_tee_hook" "${_tee_tuid:--}" "$_tee_trunc" "${_tee_b64:--}" "${_tee_sha:--}" "$_tee_rc" "${_tee_err_b64:--}" "$_tee_err_trunc")"
    if [ "$(_tee_bytelen "$_tee_line")" -gt "$_TEE_MAX_LINE_BYTES" ]; then
      _tee_err_trunc=1
      _tee_err_b64="$(head -c 200 "$_tee_err" 2>/dev/null | base64 2>/dev/null | tr -d '\n')"
      _tee_line="$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s' "$_tee_ts" "$_tee_hook" "${_tee_tuid:--}" "$_tee_trunc" "${_tee_b64:--}" "${_tee_sha:--}" "$_tee_rc" "${_tee_err_b64:--}" "$_tee_err_trunc")"
    fi
  fi
  printf '%s\n' "$_tee_line" >> "$PMM_TEE_LOG.${_tee_hook%.sh}" 2>/dev/null || true
  rm -f "$_tee_in" "$_tee_out" "$_tee_err"
  exit "$_tee_rc"
fi

G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  # C05-BUILD-SPEC 第34条 item 1(W13-F):入口门,--self-test 分支的第一个可能写盘动作之前
  # (探针 fixtures/v3/trigger-write-gate-probe.cjs 不在名册里,但它是这个入口唯一的自测逻辑所在,
  # 闸必须挂在这里而不是那个探针文件上)。
  # W15(残余1,fail-closed): source 失败或入口函数缺失都不能静默往下走。
  . "$G/selftest-iso.sh" || exit 2
  declare -F selftest_ensure_isolation >/dev/null || exit 2
  selftest_ensure_isolation "$@"

  # #16 修正(OPUS-2026-09-26 辩护方裁决,CODEX-2026-09-26-w11-w15-home-review.md #16):tee 行长度
  # 改按字节数判断后的回归例——1500 个四字节 UTF-8 字符(😀,U+1F600)拼成一个字符串,证明只有按字节
  # 数量(_tee_bytelen,本文件顶层唯一实现,tee 块调用的正是这同一份函数)才会正确判定超限;按
  # `${#var}` 字符数量(旧写法)在 UTF-8 locale 下会把每个四字节字符算成 2(这个 msys bash 的宽字符
  # 是 UTF-16,四字节字符要拆成代理对),1500 个仍只算 3000,摸不到 3800 的门槛。不经过 hook JSON
  # 全链路,直接单测这一份长度判断逻辑本身;探针(下面的 node 调用)不含这条 bash 专属回归,故放在
  # 这里、探针之前。
  _tee16_ok=1
  emoji1500="$(printf '😀%.0s' $(seq 1 1500))"
  bytelen16=$(_tee_bytelen "$emoji1500")
  charlen16=$(LC_ALL=en_US.UTF-8 bash -c 'printf %s "${#1}"' _ "$emoji1500" 2>/dev/null)
  if [ "$bytelen16" -eq 6000 ] && [ "$charlen16" -eq 3000 ] \
    && [ "$charlen16" -le "$_TEE_MAX_LINE_BYTES" ] && [ "$bytelen16" -gt "$_TEE_MAX_LINE_BYTES" ]; then
    echo "PASS #16 tee-bytelen-vs-charlen (bytelen=$bytelen16 charlen=$charlen16 threshold=$_TEE_MAX_LINE_BYTES)"
  else
    echo "✖ FAIL #16 tee-bytelen-vs-charlen (bytelen=$bytelen16 charlen=$charlen16 threshold=$_TEE_MAX_LINE_BYTES)"
    _tee16_ok=0
  fi

  node "$G/fixtures/v3/trigger-write-gate-probe.cjs"
  _probe_rc=$?

  # W21-a2-hooks-1(C05-BUILD-SPEC 第35条 (a) sub-unit 2b):拒绝台账接线自测,紧接在上面的探针
  # (pre-registered,本次不改)之后串行跑——探针只覆盖 B5/B32/presence 判定本身,从不覆盖这次新增的
  # writeDenial/writeVerdict 接线;该自测逻辑挂在 .cjs 自己新增的 `--self-test` argv 分支里(见该文件
  # 头注),不是第四份探针文件。与上面 _tee16_ok/_probe_rc 同一纪律,折进同一个总退出码。
  node "$G/pmm-trigger-write-gate.cjs" --self-test
  _ledgerwire_rc=$?

  if [ "$_tee16_ok" -eq 1 ] && [ "$_probe_rc" -eq 0 ] && [ "$_ledgerwire_rc" -eq 0 ]; then
    exit 0
  fi
  exit 1
fi

exec node "$G/pmm-trigger-write-gate.cjs"
