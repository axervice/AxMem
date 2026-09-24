#!/usr/bin/env bash
# pmm-manifest-shadow.sh — C0 shadow comparator: v1 (pmm-manifest.cjs) vs v2 (pmm-manifest-v2.cjs)
# on the REAL corpus. Read-only: runs both --json, diffs identity/edge/blocking, and classifies every
# difference against the known allowlist categories (derived from what v1 ACTUALLY parses, not from
# eyeballing — see [[pmm:shadow-allowlist-from-old-parser-not-from-eyeballing]]). Any unexplained
# difference is a red (exit 2).
set -u
G="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$G/pmm-manifest-shadow.cjs" "$@"
