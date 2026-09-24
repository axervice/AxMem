#!/usr/bin/env bash
# AxMem E2E — "inherits real environment" mutation arms (spec §3).
# (coordinator 2026-09-17, Opus acceptance report's mutation-arm table:
# these 3 arms were marked "不可验证 / 仓库内无隔离夹具(H4)" — no fixture in
# the repo could prove or disprove them. This file is that fixture.)
#
# Each arm: (1) show that DROPPING the relevant isolation produces a real,
# demonstrably-dangerous resolution (RED) — asserted by STRING COMPARISON
# only, never by an actual write, so this test itself can never touch a
# real ~/.hermes, ~/.claude, or ~/.codex; (2) show that the ACTUAL isolation
# fixture pattern this repo uses prevents it (GREEN).
set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$D")"

if [ "${1:-}" != "--self-test" ]; then
  echo "usage: inherit-real-env-arms.sh --self-test"
  exit 1
fi

ok=0
lines=()
check() { if [ "$2" -eq 0 ]; then ok=$((ok + 1)); lines+=("  ok   $1"); else lines+=("  FAIL $1"); fi; }

# ---------------------------------------------------------------------------
# Arm 1: 继承真实 AXMEM_STATE_DIR
# ---------------------------------------------------------------------------
# RED: with AXMEM_STATE_DIR and AXMEM_HOME both unset (matching a fixture
# that forgot to isolate them), lib/prelude.cjs's STATE_DIR resolves to
# somewhere under the REAL $HOME — read-only string comparison, no write.
# [ECC L1, 2026-09-17] This baseline must resolve HOME the exact same way
# lib/prelude.cjs's own HOME_DIR does (`normalizeMsysPath(process.env.HOME)
# || os.homedir()` — HOME wins when set, os.homedir() only as a fallback),
# not os.homedir() alone: a run where HOME is deliberately set to something
# OTHER than the OS user profile (e.g. this same file's own arm 3, or any
# fixture pinning HOME/USERPROFILE to different temp dirs) would otherwise
# compute the WRONG baseline here and could false-fail this arm.
real_home_state="$(node -e "
  const { normalizeMsysPath } = require(process.argv[1] + '/lib/msys-path.cjs');
  const home = normalizeMsysPath(process.env.HOME) || require('os').homedir();
  console.log(home.replace(/\\\\/g,'/') + '/.axmem/state');
" "$ROOT")"
resolved_state_uniso="$(cd "$ROOT" && env -u AXMEM_STATE_DIR -u AXMEM_HOME -u AXMEM_MEMORY_DIR -u AXMEM_CONFIG node -e "console.log(require('./lib/prelude.cjs').STATE_DIR)")"
if [ "$resolved_state_uniso" = "$real_home_state" ]; then arm1_red=0; else arm1_red=1; fi
check "1a (RED demo, not a defect) with AXMEM_STATE_DIR/AXMEM_HOME both unset, STATE_DIR resolves to the real \$HOME/.axmem/state ($resolved_state_uniso)" "$arm1_red"

# GREEN: the isolation pattern every fixture in this repo uses (export
# AXMEM_HOME to a temp dir) keeps STATE_DIR inside the fixture.
T1="$(mktemp -d)"
# Explicitly unset the other 3 AXMEM_* vars (not just override AXMEM_HOME)
# so this resolution can never be influenced by whatever this script's own
# CALLING environment happens to already export (e.g. when invoked from
# inside `bin/axmem selftest`'s own traversal, which itself runs with
# AXMEM_HOME/STATE_DIR/etc already set for ITS OWN isolated fixture) —
# observed as an intermittent false pass/fail depending on inherited state
# before this was made fully explicit.
resolved_state_iso="$(cd "$ROOT" && env -u AXMEM_STATE_DIR -u AXMEM_MEMORY_DIR -u AXMEM_CONFIG AXMEM_HOME="$T1/home" node -e "console.log(require('./lib/prelude.cjs').STATE_DIR)")"
# Compared by the temp dir's unique basename, not a full-path prefix: this
# script runs under MSYS bash ($T1 is POSIX-spelled, "/c/Users/...") while
# node resolves it through path.join into native Windows form
# ("C:/Users/..." or "C:\Users\..."), depending on the call site — genuinely
# different string SPELLINGS of the identical location, not a real mismatch.
case "$resolved_state_iso" in
  *"$(basename "$T1")"*) arm1_green=0 ;;
  *) arm1_green=1 ;;
esac
check "1b (GREEN) with AXMEM_HOME isolated to a temp dir, STATE_DIR resolves inside it ($resolved_state_iso)" "$arm1_green"
rm -rf "$T1"

# ---------------------------------------------------------------------------
# Arm 2: 继承真实 XDG_CONFIG_HOME
# ---------------------------------------------------------------------------
# AxMem's OWN resolution (lib/prelude.cjs, adapters/hermes/wire.cjs's
# defaultHermesHome()) never reads XDG_CONFIG_HOME at all — grep-verified
# below as the GREEN half of this arm. The RED half demonstrates the
# hazard this class of bug would look like (a hypothetical resolver that
# DID fall back to XDG_CONFIG_HOME), so the absence is a deliberate,
# tested property, not an untested blind spot.
if grep -rq "XDG" "$ROOT/lib" "$ROOT/adapters" "$ROOT/lifecycle" 2>/dev/null; then
  arm2a=1  # found a reference -> bad
else
  arm2a=0  # no reference at all -> good
fi
check "2a (GREEN) no AxMem source file (lib/adapters/lifecycle) references XDG_CONFIG_HOME at all" "$arm2a"

# RED demo (not a defect — a hypothetical mistake this arm guards against):
# a resolver shaped like `path.join(process.env.XDG_CONFIG_HOME || os.homedir(), '.axmem')`
# WOULD silently retarget a real user's XDG_CONFIG_HOME if one existed.
fake_xdg_parent="$(mktemp -d)"
fake_xdg="$fake_xdg_parent/a-real-users-xdg-config-home"
hypothetical_leak="$(XDG_CONFIG_HOME="$fake_xdg" node -e "
  const path = require('path');
  const os = require('os');
  // The exact shape a naive port of a Linux-XDG-aware tool might use —
  // AxMem's real code does NOT do this (see 2a); this is illustrating
  // what 'inheriting real XDG_CONFIG_HOME' would look like if it did.
  console.log(path.join(process.env.XDG_CONFIG_HOME || os.homedir(), '.axmem'));
")"
# Same POSIX-vs-native spelling caveat as arm 1b: compare by the unique
# marker directory name, not a literal path prefix.
case "$hypothetical_leak" in
  *"a-real-users-xdg-config-home"*) arm2_red=0 ;;
  *) arm2_red=1 ;;
esac
check "2b (RED demo, illustrative — not exercising real AxMem code) a hypothetical XDG_CONFIG_HOME-aware resolver would leak into it ($hypothetical_leak)" "$arm2_red"

# ---------------------------------------------------------------------------
# Arm 3: cwd 指向真实仓库
# ---------------------------------------------------------------------------
# This is a REAL bug this fix round found and fixed (lib/fence.cjs, commit
# e1f38eb): when neither AXMEM_STATE_DIR nor AXMEM_HOME was set, fence.cjs's
# state-dir fallback used to end in `process.cwd()` — invoking any fence.cjs
# operation FROM the repo root (this test's own $ROOT) landed real writes at
# "$ROOT/state/backups/...".
#
# [codex(gf) MEDIUM #3, 2026-09-17] The previous version of this arm cleared
# ALL 4 AXMEM_* vars before the real fence.cjs call below — the repo itself
# stayed clean (arm 3a's own git-status assertion still holds), but with
# AXMEM_HOME/AXMEM_STATE_DIR both unset, fence.cjs's resolution
# (ctx.resolveStateDir(), via lib/prelude.cjs's HOME_DIR) falls through to
# the REAL, un-redirected $HOME of whatever machine runs this test — a
# normal user's actual ~/.axmem/state/backups/, entirely outside this
# script's own git-status-only view. codex reproduced this directly; so did
# re-running the exact pre-fix snippet here: it left 20 real
# `AGENTS.md.<timestamp>.bak` files under this machine's own real
# ~/.axmem/state/backups/, silently accumulated across this whole session's
# many earlier `tests/inherit-real-env-arms.sh` runs. Split into two checks:
#   3a (write, but safe): same real fence.cjs call, same cwd=repo root, but
#      AXMEM_STATE_DIR now points at THIS test's own fixture dir — still
#      proves cwd doesn't leak into resolution even when a real write
#      happens, without ever touching a real user's home.
#   3b (read-only, no write at all): a plain string check — WITH
#      AXMEM_HOME/AXMEM_STATE_DIR genuinely unset, the resolved state dir
#      must be "$HOME/.axmem/state", never "$(pwd)/state" — proves e1f38eb's
#      actual claim (cwd plays no part in the resolution formula) without
#      ever calling fence.cjs's real write path unprotected.
T3="$(mktemp -d)"
T3="$(cygpath -m "$T3" 2>/dev/null || printf '%s' "$T3")"
target3="$T3/AGENTS.md"
echo 'pre-existing content' > "$target3"
content3="$T3/content.txt"
echo 'fenced body' > "$content3"
state3="$T3/state"
before3="$(cd "$ROOT" && git status --porcelain 2>/dev/null)"
(cd "$ROOT" && env -u AXMEM_HOME -u AXMEM_MEMORY_DIR -u AXMEM_CONFIG AXMEM_STATE_DIR="$state3" node lib/fence.cjs apply "$target3" "$content3" axmem >/dev/null 2>&1)
after3="$(cd "$ROOT" && git status --porcelain 2>/dev/null)"
if [ "$before3" = "$after3" ]; then arm3a_green=0; else arm3a_green=1; fi
check "3a (GREEN, was RED before commit e1f38eb) running a real fence.cjs call with cwd=repo root, AXMEM_STATE_DIR pointed at a fixture, touches nothing in the repo (git status --porcelain unchanged)" "$arm3a_green"

resolved_default_from_repo_cwd="$(cd "$ROOT" && env -u AXMEM_STATE_DIR -u AXMEM_HOME -u AXMEM_MEMORY_DIR -u AXMEM_CONFIG node -e "console.log(require('./lib/prelude.cjs').STATE_DIR)")"
real_home_state_default="$(node -e "
  const { normalizeMsysPath } = require(process.argv[1] + '/lib/msys-path.cjs');
  const home = normalizeMsysPath(process.env.HOME) || require('os').homedir();
  console.log(home.replace(/\\\\/g,'/') + '/.axmem/state');
" "$ROOT")"
if [ "$resolved_default_from_repo_cwd" = "$real_home_state_default" ]; then arm3b_green=0; else arm3b_green=1; fi
check "3b (GREEN, read-only string check, no write) with AXMEM_HOME/AXMEM_STATE_DIR both unset and cwd=repo root, resolution is \$HOME/.axmem/state ($resolved_default_from_repo_cwd), never \$(pwd)/state" "$arm3b_green"
rm -rf "$T3"
# [Opus H2, 2026-09-17] This used to end with an unconditional
# `rm -rf "$ROOT/state"` here, as a "belt-and-suspenders" cleanup in case
# this arm ever regressed and wrote into the repo again. That cleanup was
# exactly backwards: it silently erased the ONE piece of evidence
# bin/axmem selftest's own repo-cleanliness trip-wire (added in e1f38eb)
# needs to catch a real regression — before/after `git status --porcelain`
# is compared at the END of the whole traversal, and `tests/` runs LAST
# (bin/axmem's directory list is `core lib adapters lifecycle tests`),
# so a real `state/` leak earlier in the run would be wiped clean by this
# line before the trip-wire ever saw it. Opus reproduced this exactly: a
# real leak injected upstream scored a clean "repo-cleanliness" pass with
# this line in place. The `before3`/`after3` comparison two lines above is
# the actual assertion for this arm — it needs no cleanup crutch after it,
# and must never silently absorb a real regression's evidence again.

for l in "${lines[@]}"; do printf '%s\n' "$l"; done
echo "inherit-real-env-arms self-test $ok/6"
if [ "$ok" -eq 6 ]; then exit 0; else exit 1; fi
