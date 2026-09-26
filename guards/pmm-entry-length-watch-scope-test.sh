#!/usr/bin/env bash
# pmm-entry-length-watch-scope-test.sh — isolated red/green probe for the MEDIUM-4 fix to
# pmm-entry-length-watch.sh's scope pre-filter + node scope-helper (2026-09-23,
# guards/audits/OPUS-2026-09-23-codex-final-triage.md #8 /
# guards/audits/OPUS-2026-09-23-fab-delta-triage.md MEDIUM-4). Lives in its OWN file rather than
# guard-canary.sh to avoid a write-surface clash with the A1 builder working guard-canary.sh in the
# same batch (A1 appends this script's line to the roster after both land — see that batch's spec).
#
# Bug this probe exists for: the scope pre-filter used to be a substring match on the LITERAL text
# "/.claude/memory/" against the WHOLE hook-JSON file_path, and the node scope-helper it fell back to
# was silently dead (invoked with `-- "$MEM" "…pmm-core.cjs"`, but the helper read process.argv[1]/[2]
# as MEM/core — the literal `--` landed in argv[2] instead, so `require('--')` threw on every single
# invocation, rc==2 unconditionally, never the "definitely out of scope" rc==1 the caller actually
# checks for). Two independent failures stacked: a path that lexically doesn't contain the substring
# (`./` alias, a junction with a different directory name) skipped the whole five-check body without
# ever asking the helper; and even when the substring DID match, the broken helper could never
# authoritatively say "out of scope" either. Fixed: pre-filter now keys on basename only (lowercased,
# trailing dot/space and `:` stream suffix stripped) against the 7 core.ALL_FILES entries + progress.md;
# the helper's argv indices are corrected and the stray `--` removed; both share pmm-core.cjs's
# isUnderCanonical() (now realpath/UNC/ADS-aware — see that file's own header).
#
# All hook-JSON file_path values below are built as GENUINE Windows backslash paths (via `cygpath -w`),
# JSON-escaped (each backslash doubled) exactly like a real Claude Code hook payload — NOT the POSIX
# `/tmp/...` form this script's own shell variables use internally. Mixing the two would silently
# compare a translated Windows path against an untranslated POSIX one inside the node helper and always
# read as "out of scope" for the wrong reason (confirmed while building this probe — see commit note).
#
# Isolation (this repo's hard rule): HOME/USERPROFILE/PMM_MEM_DIR/PMM_STATE_FILE all point into a
# throwaway mktemp tree for the entire run. This script never reads or writes the real
# ~/.claude/memory, ~/.claude/.pmm-len-baseline, or any other real file — the only real-repo files it
# touches are read-only copies (`cp`) of guards/pmm-core.cjs + its 3 leaf deps, made ONCE at startup so
# the node scope-helper (which pmm-entry-length-watch.sh always resolves via "$HOME/.claude/guards/…")
# has something to require() inside the fake HOME.
#
# ①-④ share ONE fixture: a lessons.md with a deliberately BROKEN Index<->Entries parity (one Index
# line, zero matching Entries blocks). That mismatch is this probe's oracle — "did the five-check body
# actually run against the real fixture" — because pmm-entry-length-watch.sh's checks always read from
# $MEM (the env override), never from the file_path in the hook JSON; file_path only ever decides
# whether to run the checks at all.
#   ① a `.` segment inserted between .claude and memory — lexically/really THE SAME real memory dir —
#     must be judged IN SCOPE → the broken fixture is checked → rc=2.
#   ② a genuine `..` escape out of the memory dir into an unrelated sibling dir — must be judged OUT OF
#     SCOPE → the broken fixture is never touched → rc=0 (proves the scope check is not dead code: a
#     dead/always-in-scope check would give the SAME rc=2 as ①, indistinguishable from "no check at
#     all" — this is the case that makes ① meaningful).
#   ③ an NTFS junction (`mklink /J`, no elevation required) whose LINK sits outside the memory tree but
#     whose REPARSE TARGET is the (broken) memory dir — must be judged IN SCOPE → rc=2. SKIPs (does not
#     silently pass) when mklink /J can't run on this host.
#   ④ a file whose basename does NOT end in `.md` — must never even reach the node helper → rc=0,
#     zero-cost.
#   ⑤ M-1 fix (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md M-1 — a regression THIS batch
#     itself introduced): the candidate set used to be the 8 fixed basenames the five-check body's own
#     A/B/C/C2 checks read by name (core.ALL_FILES + progress.md) — but check D (missing-namespace
#     reference, ALSO blocking) scans EVERY `.md` file directly under $MEM
#     (`grep -rho '\[\[…\]\]' "$MEM"/*.md`), not just those 8; so did the E-graph/redundancy-lint/
#     write-echo calls in the same full-check body. A `.md` file outside the 8-name whitelist (e.g.
#     processes.md, memory.md, timeline.md, preferences.md, config.md — confirmed empirically, all 5)
#     had its OWN D-violating content skip the check entirely. Fixed: the candidate set is now "any
#     basename ending in `.md`" (after the same lowercase/trailing-dot-space/`:`-suffix normalization),
#     matching what check D actually scans. Own fixture (independent of ①-④'s broken-lessons.md one): a
#     processes.md containing `[[foo]]` with no corresponding `[ns:foo]` reference anywhere in $MEM —
#     must be judged IN SCOPE → D fires → rc=2.
#   ⑥ L-5 fix (guards/audits/OPUS-2026-09-23-a2-a5-review.md L-5): re-runs case ①'s payload with
#     MSYS_NO_PATHCONV=1 — under the OLD rc protocol (helper's "confirmed out of scope" sentinel was
#     rc=1, the SAME code node.exe's own startup failure uses when MSYS doesn't translate the helper's
#     own script path), a node crash was misread as a scope verdict and the check was silently skipped
#     on a genuinely in-scope write. Must still be judged IN SCOPE → rc=2.
set -u

GUARDS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LENGTH_WATCH="$GUARDS_DIR/../pmm-entry-length-watch.sh"
if [ ! -f "$LENGTH_WATCH" ]; then
  echo "FATAL: $LENGTH_WATCH not found" >&2
  exit 1
fi

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pmm-length-watch-scope-test.XXXXXX")" \
  || { echo "FATAL: mktemp -d failed -- refusing to run (never fall back to a fixed/predictable path)" >&2; exit 1; }
trap 'rm -rf "$ROOT"' EXIT

TMPHOME="$ROOT/home"
MEM="$TMPHOME/.claude/memory"
NOTMEM="$TMPHOME/.claude/notmem"
OUTSIDE="$ROOT/outside"
mkdir -p "$TMPHOME/.claude/guards/vendor" "$MEM" "$NOTMEM" "$OUTSIDE" \
  || { echo "FATAL: could not create isolated fixture tree under $ROOT" >&2; exit 1; }

# Read-only copies of pmm-core.cjs + its 3 leaf deps (unchanged by this batch) so the node scope-helper
# pmm-entry-length-watch.sh always resolves via "$HOME/.claude/guards/…" has something real to
# require() inside the fake HOME. Never writes back to these copies or to the real originals.
cp "$GUARDS_DIR/pmm-core.cjs" "$TMPHOME/.claude/guards/pmm-core.cjs"
cp "$GUARDS_DIR/pmm-trigger-glob.cjs" "$TMPHOME/.claude/guards/pmm-trigger-glob.cjs"
cp "$GUARDS_DIR/pmm-recall-ledger.cjs" "$TMPHOME/.claude/guards/pmm-recall-ledger.cjs"
cp "$GUARDS_DIR/vendor/path-is-inside.cjs" "$TMPHOME/.claude/guards/vendor/path-is-inside.cjs"

# Deliberately broken parity fixture: 1 Index line, 0 matching Entries blocks (see file header).
cat > "$MEM/lessons.md" <<'FIXTURE_EOF'
## Index
- 2026-01-01 — broken parity fixture [test:scope-broken]

## Entries
FIXTURE_EOF
echo 'unrelated file, not the memory dir' > "$NOTMEM/lessons.md"

# Windows-form (backslash) base paths, syntactic only (no resolution of the '.'/'..' this script
# appends afterward as plain string concatenation — those are left for the GATE's own
# path.win32.normalize()/isUnderCanonical() to resolve, which is exactly what is under test).
winpath() { cygpath -w "$1"; }
json_esc() { printf '%s' "$1" | sed 's/\\/\\\\/g'; } # double each backslash for JSON-string embedding
MEM_W="$(winpath "$MEM")"
TMPHOME_W="$(winpath "$TMPHOME")"

pass=0; fail=0; skip=0
result_line() { # $1=PASS/FAIL/SKIP  $2=name  $3=detail
  case "$1" in
    PASS) pass=$((pass+1)); echo "PASS - $2" ;;
    FAIL) fail=$((fail+1)); echo "FAIL - $2 -- $3" ;;
    SKIP) skip=$((skip+1)); echo "SKIP - $2 -- $3" ;;
  esac
}

# run_case: feeds a synthetic hook-JSON payload (Edit, given file_path) to pmm-entry-length-watch.sh
# --block with HOME/USERPROFILE/PMM_MEM_DIR/PMM_STATE_FILE all redirected into the isolated tree, and
# returns its exit code via $CASE_RC. $1 is a genuine Windows backslash path (already JSON-escaped by
# the caller via json_esc), matching real Claude Code hook payload shape (the E7 fixture elsewhere
# covers the backslash-unescaping pipeline itself; this probe targets the scope decision that runs
# after it).
CASE_RC=0
run_case() {
  local fp_json_escaped="$1"
  printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"x","new_string":"y"}}' "$fp_json_escaped" \
    | HOME="$TMPHOME" USERPROFILE="$TMPHOME" PMM_MEM_DIR="$MEM" PMM_STATE_FILE="$ROOT/state" \
      PMM_HOME= PMM_RECALL_ROOT= PMM_TRIGGER_LOG= \
      bash "$LENGTH_WATCH" --block >"$ROOT/last.out" 2>"$ROOT/last.err"
  CASE_RC=$?
}

# ① `.` segment inserted BETWEEN .claude and memory (`…\.claude\.\memory\lessons.md`, the exact shape
#    guards/audits/OPUS-2026-09-23-fab-delta-triage.md MEDIUM-4 reproduced) — same real dir, lexically
#    different text. NOTE: inserting the `.` AFTER "memory" instead (`…\memory\.\lessons.md`) would
#    NOT exercise the old substring-prefilter bug at all — "/.claude/memory/" still appears intact as a
#    literal substring in that form, so the old prefilter would match it "by accident" either way. The
#    insertion point matters; this is the one the audit actually found broken.
run_case "$(json_esc "$TMPHOME_W\\.claude\\.\\memory\\lessons.md")"
if [ "$CASE_RC" -eq 2 ]; then
  result_line PASS "① .claude\\.\\memory 别名(同一份真实 memory 目录)-> rc=2(五检真的跑了,抓到破损奇偶)"
else
  result_line FAIL "① .claude\\.\\memory 别名(同一份真实 memory 目录)-> rc=2" "got rc=$CASE_RC (out=$(cat "$ROOT/last.out" 2>/dev/null | head -c 200) err=$(cat "$ROOT/last.err" 2>/dev/null | head -c 200))"
fi

# ② genuine `..` escape into an unrelated sibling dir (.claude/notmem, sibling of .claude/memory) —
#    must be judged out of scope.
run_case "$(json_esc "$MEM_W\\..\\notmem\\lessons.md")"
if [ "$CASE_RC" -eq 0 ]; then
  result_line PASS "② .. 逃出 canonical(到无关同级目录)-> rc=0(证明 scope 检查不是死代码——死代码会跟①同为 rc=2)"
else
  result_line FAIL "② .. 逃出 canonical(到无关同级目录)-> rc=0" "got rc=$CASE_RC (out=$(cat "$ROOT/last.out" 2>/dev/null | head -c 200) err=$(cat "$ROOT/last.err" 2>/dev/null | head -c 200))"
fi

# ③ NTFS junction: link outside the memory tree, reparse target IS the (broken) memory dir. Uses
# double-slash `//c`/`//J` — Git Bash/MSYS mangles a single-slash `/c`/`/J` into a POSIX-path-lookalike
# before cmd.exe ever sees it (confirmed while building this probe: single-slash silently launches an
# interactive cmd.exe shell instead of running mklink at all, rc=0 but nothing created).
LINK_IN="$OUTSIDE/memlink"
LINK_IN_W="$(winpath "$LINK_IN")"
MK_IN_OUT="$(cmd.exe //c mklink //J "$LINK_IN_W" "$MEM_W" 2>&1)"
MK_IN_RC=$?
if [ "$MK_IN_RC" -ne 0 ] || [ ! -e "$LINK_IN/lessons.md" ]; then
  result_line SKIP "③ canonical 外 junction(reparse 目标在 canonical 内)-> rc=2" "mklink //J 不可用(rc=$MK_IN_RC, $(printf '%s' "$MK_IN_OUT" | head -c 160))"
else
  run_case "$(json_esc "$LINK_IN_W\\lessons.md")"
  if [ "$CASE_RC" -eq 2 ]; then
    result_line PASS "③ canonical 外 junction(reparse 目标在 canonical 内)-> rc=2(realpathForCompare 认出真实落点)"
  else
    result_line FAIL "③ canonical 外 junction(reparse 目标在 canonical 内)-> rc=2" "got rc=$CASE_RC (out=$(cat "$ROOT/last.out" 2>/dev/null | head -c 200) err=$(cat "$ROOT/last.err" 2>/dev/null | head -c 200))"
  fi
fi

# ④ M-1 fix (guards/audits/OPUS-2026-09-23-a2-a5-review.md M-1): a non-.md basename — must never even
#    reach the node helper; zero-cost rc=0. (Previously this case used processes.md as the "obviously
#    out of scope" example — that was WRONG per M-1: processes.md IS a .md file the D check scans, so
#    it must now be IN scope, exercised separately by case ⑤ below.)
echo 'not a corpus file' > "$MEM/notes.txt"
run_case "$(json_esc "$MEM_W\\notes.txt")"
if [ "$CASE_RC" -eq 0 ]; then
  result_line PASS "④ 非 .md 文件(notes.txt,basename 不在候选集)-> rc=0(零成本放行)"
else
  result_line FAIL "④ 非 .md 文件(notes.txt,basename 不在候选集)-> rc=0" "got rc=$CASE_RC (out=$(cat "$ROOT/last.out" 2>/dev/null | head -c 200) err=$(cat "$ROOT/last.err" 2>/dev/null | head -c 200))"
fi

# ⑤ M-1 fix: a `.md` file OUTSIDE the old 8-name whitelist, with content that trips check D (missing-
#    namespace reference: `[[foo]]` with no corresponding `[ns:foo]` anywhere in $MEM) — must be judged
#    IN SCOPE → D fires in the full-check body → rc=2. Own fixture, independent of ①-④'s broken-parity
#    lessons.md (this file's Index/Entries parity is fine on its own; D is what must catch it).
printf '[[foo]]\n[ns:foo]\n' > "$MEM/processes.md"
run_case "$(json_esc "$MEM_W\\processes.md")"
if [ "$CASE_RC" -eq 2 ]; then
  result_line PASS "⑤ M-1 processes.md(D 违规:[[foo]] 缺命名空间)-> rc=2(候选集不再漏掉 8 文件白名单外的 .md)"
else
  result_line FAIL "⑤ M-1 processes.md(D 违规:[[foo]] 缺命名空间)-> rc=2" "got rc=$CASE_RC (out=$(cat "$ROOT/last.out" 2>/dev/null | head -c 200) err=$(cat "$ROOT/last.err" 2>/dev/null | head -c 200))"
fi
rm -f "$MEM/processes.md"

# ⑥ L-5 fix (2026-09-23, guards/audits/OPUS-2026-09-23-a2-a5-review.md L-5; confirmed — under
#    MSYS_NO_PATHCONV=1, Git Bash/MSYS does NOT translate the scope-helper's OWN script path (from
#    `mktemp`, MSYS-form) before spawning node.exe, so node can't even find its entry file and exits
#    with ITS OWN startup-failure code — which collided with the helper's OLD "confirmed out of scope"
#    sentinel (both were 1), so the caller misread "node crashed before it could answer" as "node
#    confirmed this is out of scope" and skipped the check on a GENUINELY in-scope write): re-run case
#    ① (the `.claude\.\memory\lessons.md` alias, broken-parity fixture) with MSYS_NO_PATHCONV=1 in the
#    environment — must still be judged IN SCOPE → rc=2, proving the rc=3-only "confirmed out of scope"
#    sentinel (this batch's L-5 fix) closes the collision: an unrelated node crash no longer masquerades
#    as a scope verdict, so the fail-safe "give up, run the full check" path is what fires instead.
CASE_RC_SAVE=$CASE_RC
printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"x","new_string":"y"}}' "$(json_esc "$TMPHOME_W\\.claude\\.\\memory\\lessons.md")" \
  | MSYS_NO_PATHCONV=1 HOME="$TMPHOME" USERPROFILE="$TMPHOME" PMM_MEM_DIR="$MEM" PMM_STATE_FILE="$ROOT/state" \
    PMM_HOME= PMM_RECALL_ROOT= PMM_TRIGGER_LOG= \
    bash "$LENGTH_WATCH" --block >"$ROOT/last.out" 2>"$ROOT/last.err"
CASE_RC=$?
if [ "$CASE_RC" -eq 2 ]; then
  result_line PASS "⑥ L-5 MSYS_NO_PATHCONV=1 下 .claude\\.\\memory 别名 -> rc=2(node 崩溃不再撞码成'确认域外')"
else
  result_line FAIL "⑥ L-5 MSYS_NO_PATHCONV=1 下 .claude\\.\\memory 别名 -> rc=2" "got rc=$CASE_RC (out=$(cat "$ROOT/last.out" 2>/dev/null | head -c 200) err=$(cat "$ROOT/last.err" 2>/dev/null | head -c 200))"
fi
CASE_RC=$CASE_RC_SAVE

echo "pmm-entry-length-watch-scope-test: pass=$pass fail=$fail skip=$skip"
# L-2 fix (guards/audits/OPUS-2026-09-23-a2-a5-review.md L-2; confirmed — a SKIP (e.g. mklink /J
# unavailable on this host) used to leave the overall exit code at 0, indistinguishable from every case
# having genuinely run and passed — a roster that only checks rc silently reads "coverage gap" as
# "green"). rc=1 for a real assertion failure (unchanged); rc=2 when every assertion that DID run
# passed but at least one was SKIPped, so a roster checking rc alone can no longer mistake incomplete
# coverage for a clean pass — it must also read the `skip=N` in the summary line above, or assert
# SKIP=0 itself, to call this fully green.
if [ "$fail" -gt 0 ]; then
  exit 1
elif [ "$skip" -gt 0 ]; then
  exit 2
else
  exit 0
fi
