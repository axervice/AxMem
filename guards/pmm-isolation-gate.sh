#!/usr/bin/env bash
# pmm-isolation-gate.sh — thin shell wrapper for pmm-isolation-gate.cjs (C05-BUILD-SPEC 补遗二 §21).
# Wired as settings.json's PreToolUse Bash matcher: `bash "<abs>/guards/pmm-isolation-gate.sh" ||
# { echo "...fail-open" >&2; exit 0; }` -- the OUTER `||` fail-open wrapper lives in settings.json
# itself, not here; this file only execs the real judgment logic and passes stdin/argv through
# unmodified ($@ lets --self-test's own contract executor append `--mutant <name>` when it needs to,
# something the fixed settings.json string never does, so a mutant can never take effect in production).
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$G/pmm-isolation-gate.cjs" "$@"
