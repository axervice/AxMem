#!/usr/bin/env bash
# AxMem E2E — full env-var isolation checklist (Opus M5, coordinator
# 2026-09-17: scoped-down landing set for spec §3's full isolation
# checklist; full spec scope tracked separately by the coordinator).
#
# Complements the narrower existing fixtures:
#   - tests/fresh-home-adapters.sh   -- 4 AXMEM_* vars only, per-adapter wire
#   - tests/inherit-real-env-arms.sh -- string-comparison-only RED/GREEN arms
#   - tests/isolation-real-configs.sh -- sha256 spot-check of 3 KNOWN target
#     files (settings.json / AGENTS.md / config.yaml)
# by widening the overridden env-var surface to everything spec §3 calls
# out (HOME/USERPROFILE/HOMEDRIVE+HOMEPATH/APPDATA+LOCALAPPDATA/
# XDG_CONFIG_HOME+XDG_DATA_HOME/HERMES_HOME, GIT_CONFIG_NOSYSTEM/
# GIT_CONFIG_GLOBAL, a temp cwd + temp git repo) and by asserting, with
# side-effect-free commands, that Node/Git/Hermes each ACTUALLY resolve
# inside the temp root BEFORE the E2E proceeds (fail fast, before any
# adapter write can happen) rather than only inferring isolation after the
# fact from unchanged real files.
#
# Deliberately does NOT use `env -i`: under Git-Bash on Windows, env -i
# wipes PATH entirely, which breaks every git/node exec this test itself
# needs to run. The vars below are exported/overridden individually
# instead, with $PATH left exactly as inherited.
#
# [Opus M5 scope note, honest limitation] The literal ask was a full-tree
# SHA256 hash-listing comparison of real ~/.claude, ~/.codex, ~/.hermes at
# both ends. Measured on this machine: ~/.claude has 54,949 files and
# ~/.codex has 48,510 files, AND both are under verified live concurrent
# write from this exact machine's own already-running background tooling
# during a normal work session (evidence: `.pmm-push.log`, `.last-cleanup`,
# several `.receipt-nag-*` files under ~/.claude all carry timestamps from
# within the current session window, unrelated to anything this test does).
# Hashing the full content of ~100k files is both impractically slow for a
# self-test suite and, more importantly, GUARANTEED to produce false FAILs
# from that unrelated concurrent churn, independent of whether AxMem itself
# ever touches these trees — the exact "concurrent runs mutate shared state"
# hazard class. First landed here as a fast (`find`, no content read),
# NEW-PATH-ONLY diff — but even that turned out to be insufficient, EMPIRICALLY
# (not just theoretically): a real run of this exact test caught Claude
# Code's own `.claude.json.backup.<timestamp>` rotation under ~/.claude/backups
# and a real Hermes cron job's `.../cron/output/<id>/<timestamp>.md` under
# the real Hermes home, BOTH created by already-running background
# automation on this machine during the ~2 minutes this test's E2E leg
# took, neither anything to do with AxMem. So the diff is filtered down
# (axmem_signal(), below) to only paths that plausibly indicate an
# AxMem-caused change: AxMem's own footprint (anything containing "axmem",
# a lifecycle.json) or one of the 3 concrete adapter-target basenames
# AxMem's adapters are capable of writing in production (settings.json /
# AGENTS.md / config.yaml) — still a real, still a full-tree scan, but no
# longer alarms on unrelated legitimate background writers this same
# machine already runs. This does not catch an in-place content mutation
# of a pre-existing file with no new path created — that narrower,
# sha256-based case is exactly what tests/isolation-real-configs.sh already
# covers for those same 3 concrete known adapter target files.
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$D")"

if [ "${1:-}" != "--self-test" ]; then
  echo "usage: full-env-isolation.sh --self-test"
  exit 1
fi

ok=0
skipped=0
lines=()
check() { if [ "$2" -eq 0 ]; then ok=$((ok + 1)); lines+=("  ok   $1"); else lines+=("  FAIL $1"); fi; }
# [Opus incremental-closure, 2026-09-17] check() alone reproduces exactly
# the bug tests/isolation-real-configs.sh's own check_iso() was added to
# fix (M3): this script's baseline (real_claude_dir/real_codex_dir, below)
# is resolved from `$HOME` as read at THIS script's own start -- which is
# already the wrong value whenever an OUTER caller remapped HOME before
# this script even started. That is exactly what happens under the
# coordinator's own mandated final-verification run shape (`bin/axmem
# selftest` invoked with HOME/USERPROFILE/HERMES_HOME/TMPDIR all pointed
# at one shared temp dir): before_claude/before_codex both resolve to
# "__AXMEM_ABSENT__" (nothing at that already-fake path), the isolated
# run correctly never creates anything there either, and a plain
# before/after diff is trivially empty -- reported "ok" though nothing
# was ever actually exercised. check_new_path_or_skip mirrors check_iso():
# a baseline that's "__AXMEM_ABSENT__" is reported SKIPPED and excluded
# from $ok, never silently counted as a verified pass. A baseline that IS
# resolvable (this script run standalone, or LOCALAPPDATA-based Hermes,
# whose var the mandated methodology does NOT override) still gets a real
# comparison as before.
check_new_path_or_skip() {
  label="$1"; before="$2"; new_paths="$3"
  # [Opus incremental-closure LOW-c, 2026-09-17] SKIP only when the
  # baseline was absent AND nothing new appeared — the other half
  # check_iso() also preserves (tests/isolation-real-configs.sh): a
  # baseline that's absent but a new path DID appear is not "nothing to
  # verify", it's isolation genuinely leaking into a path this script
  # couldn't even see existed before, and must still FAIL, not be
  # silently absorbed into the skip count.
  if [ "$before" = "__AXMEM_ABSENT__" ] && [ -z "$new_paths" ]; then
    skipped=$((skipped + 1))
    lines+=("  SKIPPED $label (no real directory visible to this script at this path -- nothing to verify; likely because an outer caller already remapped HOME before this script started)")
    return
  fi
  [ -z "$new_paths" ]
  check "$label" $?
}

# --- baseline path listings, BEFORE any override ----------------------------
listpaths() {
  # $1 = real dir. Full recursive path listing (files + dirs, names only,
  # no content read -- fast even at 50k+ entries), or "absent" if the dir
  # doesn't exist yet on this machine.
  if [ -d "$1" ]; then find "$1" 2>/dev/null | sort; else echo "__AXMEM_ABSENT__"; fi
}
real_claude_dir="$HOME/.claude"
real_codex_dir="$HOME/.codex"
# Same win32-vs-POSIX resolution tests/isolation-real-configs.sh already
# uses, matching adapters/hermes/wire.cjs's own defaultHermesHome().
if [ "$(uname -s 2>/dev/null | cut -c1-6)" = "MINGW6" ] || [ -n "${LOCALAPPDATA:-}" ]; then
  real_hermes_dir="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes"
else
  real_hermes_dir="$HOME/.hermes"
fi
before_claude="$(listpaths "$real_claude_dir")"
before_codex="$(listpaths "$real_codex_dir")"
before_hermes="$(listpaths "$real_hermes_dir")"

# --- build the isolated fixture ---------------------------------------------
T="$(mktemp -d)"
T="$(cygpath -m "$T" 2>/dev/null || printf '%s' "$T")"
mkdir -p "$T/home" "$T/cwd"
( cd "$T/cwd" && git init -q )

export HOME="$T/home"
export USERPROFILE="$T/home"
export HOMEDRIVE="$(printf '%s' "$T" | sed -n 's#^\([A-Za-z]:\).*#\1#p')"
export HOMEPATH="/$(printf '%s' "$T/home" | sed -n 's#^[A-Za-z]:/##p')"
export APPDATA="$T/home/AppData/Roaming"
export LOCALAPPDATA="$T/home/AppData/Local"
export XDG_CONFIG_HOME="$T/home/.config"
export XDG_DATA_HOME="$T/home/.local/share"
export HERMES_HOME="$T/home/.hermes"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export AXMEM_HOME="$T/home/.axmem" AXMEM_MEMORY_DIR="$T/home/.axmem/memory" AXMEM_STATE_DIR="$T/home/.axmem/state" AXMEM_CONFIG="$T/home/.axmem/config.json"
mkdir -p "$APPDATA" "$LOCALAPPDATA" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$HERMES_HOME"
cd "$T/cwd"

# --- pre-flight: Node/Git/Hermes must each resolve INSIDE temp before the
# E2E is allowed to proceed at all -- every command here is read-only /
# side-effect-free (no file is written by any of these 3 probes).
node_home="$(node -e "console.log(require('os').homedir())" 2>&1)"
case "$node_home" in
  "$T"*) node_home_ok=0 ;;
  *) node_home_ok=1 ;;
esac
check "pre-flight: Node os.homedir() resolves inside temp ($node_home)" "$node_home_ok"

git_origin="$(git config --show-origin --get user.name 2>&1)"
# With GIT_CONFIG_NOSYSTEM=1 + GIT_CONFIG_GLOBAL=/dev/null and no local
# repo-level user.name set, this must find NOTHING (git config --get exits
# 1, empty stdout) -- any non-empty result, or one whose origin path isn't
# inside temp, means a real identity/config leaked through.
case "$git_origin" in
  "") git_origin_ok=0 ;;
  "file:$T"*) git_origin_ok=0 ;;
  *) git_origin_ok=1 ;;
esac
check "pre-flight: git config --show-origin --get user.name finds nothing outside temp (result: '${git_origin}')" "$git_origin_ok"

hermes_target="$(node -e "console.log(require(process.argv[1]).resolveTargetPath([]))" "$ROOT/adapters/hermes/wire.cjs" 2>&1)"
# Compared with backslashes normalized to forward slashes on both sides --
# node returns native "C:\Users\..." spelling here while $T (built via
# cygpath -m) is forward-slash "C:/Users/..." -- same location, different
# separator spelling (same caveat tests/inherit-real-env-arms.sh's arm 1b
# documents), not a real isolation failure.
hermes_target_fwd="$(printf '%s' "$hermes_target" | tr '\\' '/')"
T_fwd="$(printf '%s' "$T" | tr '\\' '/')"
case "$hermes_target_fwd" in
  "$T_fwd"*) hermes_ok=0 ;;
  *) hermes_ok=1 ;;
esac
check "pre-flight: Hermes adapter's resolved config path is inside temp ($hermes_target)" "$hermes_ok"

# --- the E2E itself (init + wire one representative adapter + doctor) ------
bash "$ROOT/bin/axmem" init >/dev/null 2>&1
codex_target="$T/AGENTS.md"; echo '# notes' > "$codex_target"
bash "$ROOT/adapters/codex/wire.sh" "$codex_target" >/dev/null 2>&1
node "$ROOT/adapters/hermes/wire.cjs" --config "$T/home/hermes-config.yaml" >/dev/null 2>&1
bash "$ROOT/bin/axmem" doctor >/dev/null 2>&1

# --- tear down the fixture, restore cwd, before taking the after listing ---
cd "$D"
rm -rf "$T"
unset HOMEDRIVE HOMEPATH GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL
unset AXMEM_HOME AXMEM_MEMORY_DIR AXMEM_STATE_DIR AXMEM_CONFIG
# HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_CONFIG_HOME/XDG_DATA_HOME/
# HERMES_HOME are restored below via the real-path re-resolution itself
# needing the REAL values back — this test process exits right after, but
# every other fixture in this repo unsets/restores explicitly too, so this
# one does the same instead of relying on process exit alone.
export HOME="$(cd "$D/.." && node -e "console.log(require('os').homedir())" 2>/dev/null || printf '%s' "$HOME")"

# --- after listings, new-path-only diff -------------------------------------
after_claude="$(listpaths "$real_claude_dir")"
after_codex="$(listpaths "$real_codex_dir")"
after_hermes="$(listpaths "$real_hermes_dir")"

axmem_signal() {
  # Keeps only lines that plausibly indicate an AxMem-caused change; drops
  # everything else (confirmed, empirically, to include unrelated live
  # background writers on this machine -- see the file header note).
  grep -iE '(^|[/\\])(\.?axmem[^/\\]*|lifecycle\.json|settings\.json|AGENTS\.md|config\.yaml)$' 2>/dev/null
}

new_in_claude="$(comm -13 <(printf '%s\n' "$before_claude") <(printf '%s\n' "$after_claude") | axmem_signal)"
check_new_path_or_skip "no AxMem-shaped new path appeared under real ~/.claude ($real_claude_dir) during the isolated run" "$before_claude" "$new_in_claude"

new_in_codex="$(comm -13 <(printf '%s\n' "$before_codex") <(printf '%s\n' "$after_codex") | axmem_signal)"
check_new_path_or_skip "no AxMem-shaped new path appeared under real ~/.codex ($real_codex_dir) during the isolated run" "$before_codex" "$new_in_codex"

new_in_hermes="$(comm -13 <(printf '%s\n' "$before_hermes") <(printf '%s\n' "$after_hermes") | axmem_signal)"
check_new_path_or_skip "no AxMem-shaped new path appeared under real Hermes home ($real_hermes_dir) during the isolated run" "$before_hermes" "$new_in_hermes"

for l in "${lines[@]}"; do printf '%s\n' "$l"; done
[ -n "$new_in_claude" ] && { echo "  --- AxMem-shaped new paths under $real_claude_dir ---"; printf '%s\n' "$new_in_claude" | sed 's/^/      /'; }
[ -n "$new_in_codex" ] && { echo "  --- AxMem-shaped new paths under $real_codex_dir ---"; printf '%s\n' "$new_in_codex" | sed 's/^/      /'; }
[ -n "$new_in_hermes" ] && { echo "  --- AxMem-shaped new paths under $real_hermes_dir ---"; printf '%s\n' "$new_in_hermes" | sed 's/^/      /'; }
echo "full-env-isolation self-test $ok/6 ok, $skipped skipped (baseline absent visible to this script)"
# Pass iff nothing actually FAILed -- a SKIPPED check is neither a
# verified pass nor a defect (same gate shape as tests/isolation-real-
# configs.sh's own M3 fix).
if [ "$((ok + skipped))" -eq 6 ]; then exit 0; else exit 1; fi
