#!/usr/bin/env bash
# pmm-trigger-write-gate.sh — PreToolUse wrapper for pmm-trigger-write-gate.cjs (HIGH-5, 2026-09-15,
# guards/audits/FABLE-2026-09-15-glob-review-triage.md finding 5). Matcher: Edit|Write|MultiEdit.
# fail-open on any hook-launch failure (settings.json wraps this with `|| exit 0`, matching the
# opus-justification-guard.sh convention — see pmm-trigger-write-gate.cjs's own header for why this
# hook itself fails open on everything except a confirmed illegal trigger).
set -u

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
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$_tee_hook" "${_tee_tuid:--}" "$_tee_trunc" "${_tee_b64:--}" "${_tee_sha:--}" "$_tee_rc" "${_tee_err_b64:--}" "$_tee_err_trunc" >> "$PMM_TEE_LOG" 2>/dev/null || true
  rm -f "$_tee_in" "$_tee_out" "$_tee_err"
  exit "$_tee_rc"
fi

G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  node "$G/fixtures/v3/trigger-write-gate-probe.cjs"
  exit $?
fi

exec node "$G/pmm-trigger-write-gate.cjs"
