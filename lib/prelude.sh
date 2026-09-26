#!/usr/bin/env bash
# AxMem prelude — every shell component sources this first. (P1, 2026-09-13)
# Contract: NO component may hardcode a user path, repo name, or machine detail.
# Everything user-specific resolves here, from env > config.json > defaults.
#
# Resolution order (highest wins):
#   1. Environment: AXMEM_HOME / AXMEM_MEMORY_DIR / AXMEM_STATE_DIR / AXMEM_CONFIG
#   2. Config file: $AXMEM_CONFIG (default $AXMEM_HOME/config.json)
#   3. Defaults:    ~/.axmem, memory/ + state/ beneath it
#
# Windows note: paths normalize to forward slashes; the cmd.exe caret and MSYS
# path-conversion families of bugs are documented in docs/PORTING-NOTES.md —
# every lesson here was paid for in production (see the 2026-09 audit trail).

# shellcheck disable=SC2034  # consumers use these
AXMEM_HOME="${AXMEM_HOME:-$HOME/.axmem}"
AXMEM_HOME="${AXMEM_HOME//\\//}"
AXMEM_CONFIG="${AXMEM_CONFIG:-$AXMEM_HOME/config.json}"
AXMEM_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AXMEM_ROOT="$(dirname "$AXMEM_LIB")"

# Config accessor — delegates JSON parsing to node (the one runtime AxMem
# already requires); grep-parsing JSON is how guards get lied to.
#   axmem_cfg <dot.path> <default>
axmem_cfg() {
  node "$AXMEM_LIB/prelude.cjs" get "$1" "$2" 2>/dev/null || printf '%s' "$2"
}

AXMEM_MEMORY_DIR="${AXMEM_MEMORY_DIR:-$(axmem_cfg memory_dir "$AXMEM_HOME/memory")}"
AXMEM_MEMORY_DIR="${AXMEM_MEMORY_DIR//\\//}"
AXMEM_STATE_DIR="${AXMEM_STATE_DIR:-$(axmem_cfg state_dir "$AXMEM_HOME/state")}"
AXMEM_STATE_DIR="${AXMEM_STATE_DIR//\\//}"

# Machine identity: shared append-only files are per-machine by design —
# two machines appending one synced file is a merge-conflict bomb that can
# halt the whole memory repo's sync (audited failure, 2026-09-13).
AXMEM_MACHINE="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9-' | cut -c1-12)"
AXMEM_MACHINE="${AXMEM_MACHINE:-unknown}"

# Session identity: harness-provided when running as a hook; per-machine
# manual fallback otherwise. (The env var name is adapter-specific — the
# Claude Code adapter exports AXMEM_SESSION_ID from its own session var.)
axmem_session() {
  printf '%s' "${AXMEM_SESSION_ID:-${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-manual-$AXMEM_MACHINE}}}" \
    | tr -cd 'A-Za-z0-9-' | cut -c1-16
}

# Entry-size law (chars ≈ bytes under LC_ALL=C): default 900 = one retrieval
# window; [sole-record] is the fidelity exemption. Both configurable.
AXMEM_ENTRY_LIMIT="${AXMEM_ENTRY_LIMIT:-$(axmem_cfg gates.entry_limit 900)}"
AXMEM_SOLE_RECORD_MARK="${AXMEM_SOLE_RECORD_MARK:-[sole-record]}"

mkdir -p "$AXMEM_STATE_DIR" 2>/dev/null || true
