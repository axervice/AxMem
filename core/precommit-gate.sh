#!/usr/bin/env bash
# AxMem precommit-gate — commit-boundary integrity for the memory repo. (P1 port)
# Validates the STAGED final state (covers every write tool, present and future):
#   parity / orphan blocks / new entries must carry [ns:tag]
#   F  retirement = MOVE: a header deleted from a live file must appear verbatim
#      in its archive in the SAME commit — loss becomes structurally impossible.
#      Rewrite detection demands namespaced tags and ALL of them still present
#      (a bare bracket token like a fidelity mark must never pass as identity —
#      the permanent-loss escape sealed 2026-09-13).
# Wire: git pre-commit hook in the repo that contains AXMEM_MEMORY_DIR
#       (`axmem precommit` from the hook), or run standalone before commits.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/../lib/prelude.sh"
# Captured before the `cd "$GDIR"` below rewrites the working directory — a
# relative BASH_SOURCE[0] resolved after that cd would point at the wrong tree.
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  # cygpath -m normalize immediately (M6, 2026-09-17): when TMPDIR/TEMP/TMP
  # is exported pointing at a POSIX-form path ("/c/Users/.../AppData/Local/
  # Temp/...") that ALSO happens to be MSYS's dedicated /tmp mount (Git for
  # Windows mounts %LOCALAPPDATA%\Temp at /tmp — `mount` shows it), `cd`
  # given that literal POSIX text stays on it logically ("/c/Users/..."),
  # while `cd` given the Windows drive-letter spelling of the SAME directory
  # (what `git rev-parse --show-toplevel` always emits, and what this
  # script's own $TOP normalization below does via `cd "$(git rev-parse
  # --show-toplevel)" && pwd`) triggers real getcwd()-based canonicalization
  # and resolves through that /tmp mount alias instead. Two textually
  # different `pwd` results for the identical directory means relmem()'s
  # `${abs_p#"$TOP"/}` prefix-strip below silently no-ops (bash leaves an
  # unmatched `#` pattern unchanged) and hands git a mangled absolute
  # pathspec — observed as green self-test cases #2/#3 (verbatim-archived,
  # title-rewrite) failing deterministically in that environment, unrelated
  # to path length (short and long TMPDIR values reproduce identically).
  # Forcing the native "C:/..." spelling here — the same spelling
  # tests/*.sh already normalizes to (see fresh-home-adapters.sh) and the
  # same spelling `git rev-parse --show-toplevel` emits — makes both sides
  # of every later `cd ... && pwd` route through the SAME canonicalization
  # path, so they agree.
  #
  # [Builder W10, 2026-09-25] `-m` alone isn't enough: it's a syntax
  # conversion (backslash -> forward slash), not a canonicalization — it
  # preserves whatever DOS 8.3 short-name spelling the input already had.
  # GH Actions windows-latest's TEMP/TMP is the short form
  # (C:\Users\RUNNER~1\AppData\Local\Temp), so `mktemp -d` under it and
  # `cygpath -m` on the result stays short-spelled, while `git rev-parse
  # --show-toplevel` (line ~163 below, exercised via the `g()` harness)
  # always resolves to the LONG form — a second, independent path-form
  # trap on top of the MSYS-mount-alias one above, invisible on a normal
  # dev machine (real usernames rarely trigger 8.3 aliasing) and on Ubuntu
  # (no 8.3 short names at all), which is why this reproduced as CI-only
  # 6/8 (run 36097673915's Windows leg) on cases #2/#3 specifically: the
  # first case to touch a `**20...`-header diff after `relmem()`'s
  # `$TOP`-prefix-strip silently no-ops on the short/long mismatch, handing
  # git a mangled pathspec. `-l` (long-name) resolves the short alias back
  # to its long form before the mixed-slash conversion, so this now agrees
  # with git's own spelling regardless of which form TEMP/TMP arrived in.
  T="$(cygpath -ml "$T" 2>/dev/null || printf '%s' "$T")"
  # [Builder W9, 2026-09-24] CI hardening: GH Actions windows-latest reported
  # 6/8 on this self-test (run 36083001021) while every TMPDIR/HOME variant
  # this file's own M6 fix already covers (see the cygpath -m note above)
  # reproduces 8/8 on a normal dev machine. One documented, hosted-runner-
  # specific gap the M6 fix does NOT cover: git >= 2.35.2's "detected
  # dubious ownership in repository at ..." refusal, which some Windows
  # runner ACL/ownership configurations trigger even for a directory the
  # current process itself just mkdir'd (a known class of GH Actions
  # flakiness, unrelated to path-form duplicity). A refusal here would break
  # git config/add/commit/diff for the REST of this fixture, and because
  # this fixture mixes "expect exit 0" (green) and "expect exit != 0" (red)
  # assertions, a blanket git failure does not fail cleanly — some red cases
  # would accidentally read as passing while green cases correctly fail,
  # landing on a partial count instead of 0/8 or 8/8, which matches the
  # observed 6/8 shape. Isolate this fixture's OWN --global config to a
  # scratch file next to $T (GIT_CONFIG_GLOBAL, git >= 2.32) so this can
  # never fire here regardless of host ACLs, without ever touching the real
  # ~/.gitconfig or system git identity.
  export GIT_CONFIG_GLOBAL="$T.selftest-gitconfig"
  git config --global --add safe.directory "$T" 2>/dev/null || true
  M="$T/mem"; mkdir -p "$M"
  # AXMEM_STATE_DIR sandboxed here too (canary-poisoning note, same class as
  # the entry-length guard's documented incident): the E2 block below invokes
  # write-gate.sh, which persists its oversize-entry baseline to
  # AXMEM_STATE_DIR — left unset, self-test fixtures would overwrite the
  # REAL machine's baseline with fixture-derived counts.
  ST="$T/state"; mkdir -p "$ST"
  ( cd "$T" && git init -q && git config user.email t@t && git config user.name t )
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n- 2026-01-02 [a:doomed] d\n\n## Entries\n\n**2026-01-01 — keep** [a:keep]\nb\n\n**2026-01-02 — doomed** [a:doomed]\nb\n' > "$M/lessons.md"
  printf '# archive\n' > "$M/lessons-archive.md"
  printf '## Index\n\n## Entries\n' > "$M/decisions.md"; cp "$M/decisions.md" "$M/standinginstructions.md"
  printf '# a\n' > "$M/decisions-archive.md"; cp "$M/decisions-archive.md" "$M/standinginstructions-archive.md"
  ( cd "$T" && git add -A && git commit -qm base ) >/dev/null 2>&1
  g() { ( cd "$T" && git add -A ) >/dev/null 2>&1; AXMEM_MEMORY_DIR="$M" AXMEM_GIT_DIR="$T" AXMEM_STATE_DIR="$ST" bash "${BASH_SOURCE[0]}" >/dev/null 2>&1; }
  ok=0
  fails=""
  # [Builder W9, 2026-09-24] Per-case labeling (was: a single silent
  # ok=$((ok+1)) per case, giving only a bare N/8 with zero indication of
  # WHICH case(s) failed). GH Actions windows-latest reported 6/8 with no
  # way to tell which 2 of the 8 broke — bin/axmem's driver already dumps
  # this whole self-test's stdout on any nonzero exit (see its `sed`-indent
  # of $_st_out), so labeling failures here makes the NEXT red run
  # (if any) actionable from the CI log alone instead of requiring a
  # from-scratch repro.
  expect() { # $1=case label, $2=nonzero|zero (what `rc` should be)
    if { [ "$2" = "nonzero" ] && [ "$rc" -ne 0 ]; } || { [ "$2" = "zero" ] && [ "$rc" -eq 0 ]; }; then
      ok=$((ok+1))
    else
      fails="${fails}  case failed: $1 (expected rc $2, got $rc)\n"
    fi
  }
  # 1 red: delete without archiving
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep** [a:keep]\nb\n' > "$M/lessons.md"
  g; rc=$?; expect "1 red: delete without archiving" nonzero
  # 2 green: verbatim archived
  printf '# archive\n\n**2026-01-02 — doomed** [a:doomed]\nb\n' > "$M/lessons-archive.md"
  g; rc=$?; expect "2 green: verbatim archived" zero
  ( cd "$T" && git commit -qm step ) >/dev/null 2>&1
  # 3 green: title rewrite (tag still leads an entry) must not be blocked
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep reworded** [a:keep]\nb\n' > "$M/lessons.md"
  g; rc=$?; expect "3 green: title rewrite" zero
  ( cd "$T" && git commit -qm step2 ) >/dev/null 2>&1
  # 4 red (escape 3): deleted title carries a bare [sole-record]-style token that
  #   another live title also carries — must still be treated as retirement
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n- 2026-01-03 [a:vic] v\n\n## Entries\n\n**2026-01-01 — keep [sole-record]** [a:keep]\nb\n\n**2026-01-03 — victim [sole-record] note** [a:vic]\nb\n' > "$M/lessons.md"
  ( cd "$T" && git add -A && git commit -qm base3 ) >/dev/null 2>&1
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep [sole-record]** [a:keep]\nb\n' > "$M/lessons.md"
  g; rc=$?; expect "4 red (escape 3): bare [sole-record] token shared with a live title" nonzero
  # 5 red: title-only placeholder in archive (the body must move too)
  ( cd "$T" && git add -A && git commit -qm b5 ) >/dev/null 2>&1
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n- 2026-01-06 [a:body] v\n\n## Entries\n\n**2026-01-01 — keep [sole-record]** [a:keep]\nb\n\n**2026-01-06 — body entry** [a:body]\nreal body line one\nreal body line two\n' > "$M/lessons.md"
  ( cd "$T" && git add -A && git commit -qm b6 ) >/dev/null 2>&1
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep [sole-record]** [a:keep]\nb\n' > "$M/lessons.md"
  printf '# archive\n\n**2026-01-02 — doomed** [a:doomed]\nb\n\n**2026-01-06 — body entry** [a:body]\n' > "$M/lessons-archive.md"
  ( cd "$T" && git add -A ) >/dev/null 2>&1
  g; rc=$?; expect "5 red: title-only placeholder in archive" nonzero
  # 6 red (escape E1): delete the vic entry while another LIVE title's PROSE
  #   mentions [a:vic] (e.g. a hand-written back-reference) — a substring scan
  #   across header lines would find the tag "present" and wave the deletion
  #   through as a rewrite; identity (tag must HEAD its own live entry) must
  #   still catch this as a real, unarchived retirement.
  ( cd "$T" && git add -A && git commit -qm baseE1 ) >/dev/null 2>&1
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n- 2026-01-07 [a:vic] v\n\n## Entries\n\n**2026-01-01 — keep mentions [a:vic] in the title** [a:keep]\nb\n\n**2026-01-07 — vic** [a:vic]\nvic body\n' > "$M/lessons.md"
  ( cd "$T" && git add -A && git commit -qm baseE1b ) >/dev/null 2>&1
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep mentions [a:vic] in the title** [a:keep]\nb\n' > "$M/lessons.md"
  g; rc=$?; expect "6 red (escape E1): live title's prose mentions the deleted tag" nonzero
  # 7 red (E2): a write that bypasses Edit/Write hooks entirely (a raw file
  #   write, as sed/echo>> would produce) must still be caught at the commit
  #   boundary by running the full write-gate over the staged snapshot —
  #   here an orphan date-list block outside any Index.
  ( cd "$T" && git add -A && git commit -qm baseE2 ) >/dev/null 2>&1
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep mentions [a:vic] in the title** [a:keep]\nb\n\n- 2026-01-09 orphan date-list block, never a proper entry\n' > "$M/lessons.md"
  g; rc=$?; expect "7 red (E2): orphan date-list block bypassing Edit/Write hooks" nonzero
  # 8 green (lesson-class taxonomy, classes.md in the E2 snapshot): a NEW
  #   lessons.md entry references a class defined ONLY in a classes.md
  #   staged in this SAME commit. If the snapshot used a fixed file list
  #   (classes.md not on it), manifest's B6 would see a dangling class
  #   target that, in the real staged content, is not dangling at all.
  ( cd "$T" && git add -A && git commit -qm baseE2b ) >/dev/null 2>&1
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n\n## Entries\n\n**2026-01-01 — keep mentions [a:vic] in the title** [a:keep]\nb\n' > "$M/lessons.md"
  printf '**2026-09-14 — Class: alpha** [class:alpha]\nCriterion: x\n' > "$M/classes.md"
  printf '## Index\n\n- 2026-01-01 [a:keep] k\n- 2026-01-10 [a:classy] c\n\n## Entries\n\n**2026-01-01 — keep mentions [a:vic] in the title** [a:keep]\nb\n\n**2026-01-10 — classy** [a:classy]\nClass: [[class:alpha]]\nb\n' > "$M/lessons.md"
  g; rc=$?; expect "8 green: new entry's class defined in a same-commit classes.md" zero
  rm -rf "$T" "$T.selftest-gitconfig"
  if [ "$ok" -eq 8 ]; then
    echo "precommit-gate self-test 8/8"
    exit 0
  else
    printf '%b' "$fails"
    echo "precommit-gate self-test $ok/8 FAIL"
    exit 1
  fi
fi

GDIR="${AXMEM_GIT_DIR:-$AXMEM_MEMORY_DIR}"
cd "$GDIR" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
# Path-form trap (porting note #1): `git rev-parse --show-toplevel` emits
# Windows-form (C:/...) while mktemp/cwd may be MSYS-form (/tmp/...) — a raw
# prefix strip silently fails BOTH ways (greens refused, reds right for the
# wrong reason). Normalize both sides through `cd && pwd` before stripping.
TOP="$(cd "$(git rev-parse --show-toplevel)" && pwd)"
relmem() { # repo-relative path of a memory file
  local dir base abs_p
  dir="$(cd "$(dirname "$AXMEM_MEMORY_DIR/$1")" 2>/dev/null && pwd)" || { printf '%s' "$1"; return; }
  base="$(basename "$AXMEM_MEMORY_DIR/$1")"
  abs_p="$dir/$base"
  printf '%s' "${abs_p#"$TOP"/}"
}

fail=0; msg=""
check_file() { # $1=name $2=mode
  local rp; rp="$(relmem "$1.md")"
  git diff --cached --quiet -- "$rp" 2>/dev/null && return 0
  local tmp; tmp=$(mktemp); git show ":$rp" > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 0; }
  local ix en
  if [ "$2" = "std" ]; then
    ix=$(awk '/^### Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/{n++} END{print n+0}' "$tmp")
    en=$(awk '/^## Entries/{e=1} e&&/^\*\*20/{n++} END{print n+0}' "$tmp")
  else
    ix=$(awk '/^## Index/{i=1;next} /^## Entries/{i=0} i&&/^- 20/{n++} END{print n+0}' "$tmp")
    en=$(grep -c '^\*\*20' "$tmp")
  fi
  [ "$ix" -ne "$en" ] && { fail=1; msg="${msg}  $1: Index ${ix} != Entries ${en}\n"; }
  local nt ntag
  nt=$(git diff --cached -- "$rp" | grep -c '^+\*\*20' 2>/dev/null); nt=${nt:-0}
  ntag=$(git diff --cached -- "$rp" | grep '^+\*\*20' 2>/dev/null | grep -c '\[[a-z][a-z0-9-]*:'); ntag=${ntag:-0}
  [ "$nt" -gt "$ntag" ] && { fail=1; msg="${msg}  $1: $((nt-ntag)) new entr(y|ies) missing [ns:tag]\n"; }
  rm -f "$tmp"
}
check_retire() { # $1=name
  local rp ap; rp="$(relmem "$1.md")"; ap="$(relmem "$1-archive.md")"
  git diff --cached --quiet -- "$rp" 2>/dev/null && return 0
  local removed; removed=$(git diff --cached -U0 -- "$rp" | sed -n 's/^-\(\*\*20.*\)$/\1/p')
  [ -z "$removed" ] && return 0
  local ltmp atmp; ltmp=$(mktemp); atmp=$(mktemp)
  git show ":$rp" > "$ltmp" 2>/dev/null || : > "$ltmp"
  git show ":$ap" > "$atmp" 2>/dev/null || git show "HEAD:$ap" > "$atmp" 2>/dev/null || : > "$atmp"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local ns_tags all_present live_ids
    # Identity, not substring (porting note, E1): a bare substring search
    # across header lines lets another live title's PROSE MENTION of the tag
    # (e.g. a "(superseded->[x])" back-reference, or the tag spelled out in a
    # neighboring title) count as "still present" and wave through a real
    # deletion. The tag must still HEAD its own live entry — the first
    # ns:tag right after the closing ** of a `**20...` header line, same
    # identity rule manifest.cjs uses.
    ns_tags=$(printf '%s' "$line" | grep -oE '\[[a-z][a-z0-9-]*:[A-Za-z0-9._-]+\]')
    all_present=0
    if [ -n "$ns_tags" ]; then
      live_ids=$(awk '/^\*\*20/{s=$0; sub(/.*\*\*/,"",s); if (match(s,/\[[a-z][a-z0-9-]*:[A-Za-z0-9._-]+\]/)) print substr(s,RSTART+1,RLENGTH-2)}' "$ltmp")
      all_present=1
      while IFS= read -r _t; do
        [ -z "$_t" ] && continue
        _tt="${_t#[}"; _tt="${_tt%]}"
        printf '%s\n' "$live_ids" | grep -Fqx "$_tt" || { all_present=0; break; }
      done <<NSEOF
$ns_tags
NSEOF
    fi
    [ "$all_present" -eq 1 ] && continue
    if grep -Fqx "$line" "$atmp"; then
      # Headline-in-archive is NOT body-in-archive (adversarial escape: a
      # title-only placeholder passed the old gate while the body vanished).
      # Pull the full block from HEAD and demand verbatim containment.
      blk=$(git show "HEAD:$rp" 2>/dev/null | awk -v h="$line" '
        $0==h{f=1} f{print; nx++} f&&nx>1&&/^\*\*20|^## /{exit}' | sed '$d' | sed -e ':a' -e '/^\s*$/{$d;N;ba' -e '}')
      acontent=$(cat "$atmp")
      case "$acontent" in
        *"$blk"*) continue ;;
        *) fail=1
           msg="${msg}  $1: headline archived but the BODY block is incomplete —\n    ${line}\n    retirement moves whole blocks verbatim, not title placeholders\n"
           continue ;;
      esac
    fi
    fail=1
    msg="${msg}  $1: deleted entry not archived —\n    ${line}\n    retirement = MOVE: the verbatim entry must land in $1-archive.md in this commit\n"
  done <<RETIRE_EOF
$removed
RETIRE_EOF
  rm -f "$ltmp" "$atmp"
}
for f in decisions lessons; do check_file "$f" dl; check_retire "$f"; done
check_file standinginstructions std; check_retire standinginstructions

# E2 (sink the five checks to the commit boundary, porting note): PostToolUse
# only intercepts the Edit/Write tool family — a sed/echo>> write to a memory
# file goes straight through untouched. Commit is the last boundary every
# write must cross, so run the FULL write-gate (size/parity/orphans/C3/
# E-sup/E-graph/D/R/B6, all of it) over the STAGED snapshot, not just the
# structural checks above.
#
# The snapshot copies EVERY staged *.md under the memory dir — not a fixed
# file list. A fixed list silently drops any file added later: classes.md
# was the first casualty (missing from the snapshot made manifest's B6 see a
# dangling class reference that, in the actual staged content, was not
# dangling at all — the live gate rejected a legitimate commit over this).
MEMDIR_ABS="$(cd "$AXMEM_MEMORY_DIR" 2>/dev/null && pwd)" || MEMDIR_ABS="$AXMEM_MEMORY_DIR"
MEMREL="${MEMDIR_ABS#"$TOP"/}"
_changed_md="$(git diff --cached --name-only -- "$MEMREL" 2>/dev/null | grep '\.md$' || true)"
if [ -n "$_changed_md" ]; then
  _snap="$(mktemp -d)"
  # Every TRACKED *.md under the memory dir, changed or not — an unchanged
  # file's staged content still has to be in the snapshot for cross-file
  # checks (B1 dangling Supersedes, B6 class definitions, …) to see the full
  # picture, exactly as the fixed-list version did for its seven names.
  _all_md="$(git ls-files -- "$MEMREL" 2>/dev/null | grep '\.md$' || true)"
  while IFS= read -r _rp; do
    [ -z "$_rp" ] && continue
    _base="$(basename "$_rp")"
    git show ":$_rp" > "$_snap/$_base" 2>/dev/null || rm -f "$_snap/$_base"
  done <<MDEOF
$_all_md
MDEOF
  # AXMEM_STATE_DIR (and therefore the baseline file) is left pointing at the
  # real state dir on purpose: the net-new-oversize check must compare
  # against the same persisted baseline a normal --block invocation uses, not
  # a fresh empty one (a temp baseline would silently disable that check).
  if ! _wout=$(AXMEM_MEMORY_DIR="$_snap" bash "$D/write-gate.sh" --block </dev/null 2>&1); then
    fail=1
    msg="${msg}  write-gate (staged snapshot) refused — writes that bypass the hook are caught at the commit boundary:\n$(printf '%s' "$_wout" | sed 's/^/    /')\n"
  fi
  rm -rf "$_snap"
fi

if [ "$fail" -eq 1 ]; then
  { echo "axmem precommit-gate REFUSED:"; printf "%b" "$msg"; } >&2
  exit 1
fi
exit 0
