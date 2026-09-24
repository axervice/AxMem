#!/usr/bin/env bash
# pmm-shadow-compare.sh — thin shell wrapper for pmm-shadow-compare.cjs (C05-BUILD-SPEC.md 交付物 2).
# ALLOW_PROD member (补遗二 §21):unredirected calls are permitted UNLESS the args carry
# --self-test/--self-check/--selftest, in which case the isolation gate requires the caller to prefix
# HOME=$T USERPROFILE=$T PMM_HOME=$T -- this wrapper does not decide that, it only execs through.
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$G/pmm-shadow-compare.cjs" "$@"
