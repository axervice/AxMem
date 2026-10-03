#!/usr/bin/env bash
# pmm-bash-impression.sh — PreToolUse wrapper for pmm-bash-impression.cjs (matcher=Bash).
# Thin wrapper, same shape as pmm-trigger-write-gate.sh: settings.json wraps the invocation with the
# bash-pipe-exitcode-watch.sh fail-open style (`|| { echo ...>&2; exit 0; }`), so any failure to even
# launch this script degrades to silent shadow, never a hard failure of the Bash tool call.
#
# MEDIUM-3 (fab blind attack, contract v2.16 G05): `command -v node` guard, same line as
# bash-pipe-exitcode-watch.sh's own wrapper — without it, a PATH with no `node` on it makes the bare
# `exec node ...` below fail to even launch (spawn ENOENT), which is still fail-open at the settings.json
# level (the `|| { ...; exit 0; }` there catches it) but does so one layer further out than necessary, and
# inconsistently with the gate's own wrapper. Guarded the same way here for symmetry across all four wired
# launches (Pre gate / Pre M0 / Post / PostToolUseFailure all route through one of these two .sh files).
command -v node >/dev/null 2>&1 || exit 0
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  node "$G/pmm-bash-impression.cjs" --self-test
  exit $?
fi

exec node "$G/pmm-bash-impression.cjs"
