#!/usr/bin/env bash
# pmm-core.sh — golden-corpus self-test wrapper for pmm-core.cjs (PMM v3, C0 build, shadow only).
# Usage: pmm-core.sh --self-test    runs guards/pmm-core-selftest.cjs against guards/fixtures/v3/*.
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--self-test" ]; then
  node "$G/pmm-core-selftest.cjs"
  main_rc=$?
  # HIGH-4b black-box integration probe (2026-09-15, guards/audits/FABLE-2026-09-15-glob-review-
  # triage.md finding 4b): run OUT-OF-PROCESS from the main self-test (its require.cache surgery must
  # never touch that run) — swaps pmm-trigger-recall.cjs's checkTriggerPathB5 export and asserts
  # pmm-core.cjs's own B5 diagnostic pipeline reflects the swap (--fake), plus a control (--real).
  node "$G/pmm-core-high4b-probe.cjs" --fake
  fake_rc=$?
  node "$G/pmm-core-high4b-probe.cjs" --real
  real_rc=$?
  if [ "$main_rc" -eq 0 ] && [ "$fake_rc" -eq 0 ] && [ "$real_rc" -eq 0 ]; then
    echo "pmm-core-high4b-probe: PASS(--fake + --real)"
    exit 0
  fi
  echo "✖ pmm-core --self-test 失败(main_rc=$main_rc fake_rc=$fake_rc real_rc=$real_rc)"
  exit 1
fi

echo "usage: pmm-core.sh --self-test" >&2
exit 1
