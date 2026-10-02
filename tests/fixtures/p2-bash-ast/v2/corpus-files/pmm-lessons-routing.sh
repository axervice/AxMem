#!/usr/bin/env bash
# PMM lessons-routing guard (Jax 2026-06-28).
# Flags when a PROJECT-specific lesson leaked into ~/.claude/memory/lessons.md —
# it belongs in <repo>/LESSONS.md; PMM lessons.md = cross-project / general only.
# Project namespaces are auto-derived from the header pointer list ([xxx:*]) + a fallback,
# so adding a new project to the header auto-extends coverage.
# Modes:
#   (no arg)  SessionStart  → print warning to stdout (injected as context), exit 0
#   --block   PostToolUse   → print warning to stderr + exit 2 (fed back to Claude)
# #16 修正(OPUS-2026-09-26 辩护方裁决,CODEX-2026-09-26-w11-w15-home-review.md #16):按字节数量
# tee 行长度,不用 `${#var}`(在 UTF-8 locale 下按字符数算,遇多字节字符会与真实字节数分叉)。定义
# 在文件顶层(不在下面的 tee 条件块里)。本文件按 selftest-entry-roster.json 记录无 --self-test
# 入口(W13-F 已判定),因此没有内置回归例——同一份判断逻辑已在 pmm-trigger-recall.sh case 35 与
# pmm-trigger-write-gate.sh 的 --self-test 里验证过。
_TEE_MAX_LINE_BYTES=3800
_tee_bytelen() { printf '%s' "$1" | wc -c; }

# ── C05-BUILD-SPEC B2 tee (2026-09-24, read-only; PMM_TEE_LOG unset ⇒ zero behavior change) ──
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
  # 基名,如 legacy-<mach>.log.pmm-lessons-routing),不再共用同一 $PMM_TEE_LOG——消除跨 hook 交织
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

L="$HOME/.claude/memory/lessons.md"
[ -f "$L" ] || exit 0
ns=$(grep -oE '\[[a-z0-9-]+:\*\]' "$L" 2>/dev/null | sed -E 's/^\[([a-z0-9-]+):\*\]$/\1/' | sort -u | paste -sd'|' -)
fb='axervice|rag|cold-email|upwork'
[ -n "$ns" ] && ns="$ns|$fb" || ns="$fb"
ns=$(printf '%s' "$ns" | tr '|' '\n' | sed '/^$/d' | sort -u | paste -sd'|' -)
hits=$(grep -nE "^\*\*.*\[(${ns}):" "$L" 2>/dev/null)
[ -z "$hits" ] && exit 0
msg=$(printf '%s\n' \
  "<!-- pmm-lessons-routing -->" \
  "⚠️ PMM lessons-routing 违规:项目专属教训出现在 ~/.claude/memory/lessons.md。" \
  "   → 移到对应 <repo>/LESSONS.md;PMM lessons.md 只放跨项目通用/工具/流程教训" \
  "   (standinginstructions 2026-06-28 + config.md Write Discipline)。涉及条目:" \
  "$hits")
if [ "$1" = "--block" ]; then
  printf '%s\n' "$msg" >&2
  exit 2
fi
printf '%s\n' "$msg"
exit 0
