#!/usr/bin/env bash
# bash-pipe-exitcode-watch.sh — thin wrapper for bash-pipe-exitcode-watch.cjs (PreToolUse + PostToolUse,
# matcher=Bash). specs/PIPE-GATE-V2-REPAIR-BRIEF.md §1: does NOT consume stdin itself (that would race the
# .cjs's own read of fd 0); starts nothing but node. `command -v node` failing exits 0 before node is even
# launched (a missing/broken node install degrades silently, without consuming stdin).
#
# Deliberately does NOT redirect the launched node process's own stderr to /dev/null: contract case Z15
# (specs/pipe-gate-v2-test-contract.json) requires this gate's stderr byte-count to reach the acceptance
# runner byte-exactly, including a DELIBERATELY LEAKY injected seam module writing to fd 2 — a blanket
# `2>/dev/null` here would make that assertion permanently unsatisfiable regardless of the .cjs's own
# correctness. The .cjs's own silence discipline (contract Z01-Z06: closed stdin/NUL/bad-JSON/empty/
# unwritable-ledger/PATH-without-node all -> zero stdout AND zero stderr) is enforced INSIDE the .cjs via
# its own top-level try/catch and uncaughtException handler, registered before any other module code runs
# — not by this wrapper suppressing output after the fact.
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  node "$G/bash-pipe-exitcode-watch.cjs" --self-test
  exit $?
fi

command -v node >/dev/null 2>&1 || exit 0
exec node "$G/bash-pipe-exitcode-watch.cjs"
