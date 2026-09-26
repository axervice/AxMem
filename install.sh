#!/usr/bin/env bash
# AxMem one-click installer. (P1, 2026-09-13; --hermes/--generic added P1 2026-09-16)
# Idempotent: safe to re-run; never overwrites an existing config or memory.
#   bash install.sh                 init + doctor (no adapter wiring)
#   bash install.sh --claude-code   also wire the Claude Code adapter (backup first)
#   bash install.sh --hermes        also wire the Hermes bridge (config.yaml hooks:, backup first)
#   bash install.sh --generic [--instruction-file <path>]   also wire the generic convention-level adapter
#   bash install.sh --dry-run       show what would happen
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0; WIRE_CC=0; WIRE_HERMES=0; WIRE_GENERIC=0; INSTR_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --claude-code) WIRE_CC=1 ;;
    --hermes) WIRE_HERMES=1 ;;
    --generic) WIRE_GENERIC=1 ;;
    --instruction-file) shift; INSTR_FILE="${1:-}" ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

command -v node >/dev/null || { echo "install: node is required (the only runtime dependency)"; exit 1; }
command -v git  >/dev/null || { echo "install: git is required"; exit 1; }

if [ "$WIRE_GENERIC" -eq 1 ] && [ -z "$INSTR_FILE" ]; then
  INSTR_FILE="$(bash "$ROOT/bin/axmem" config get adapters.generic.instruction_file '' 2>/dev/null)"
fi
if [ "$WIRE_GENERIC" -eq 1 ] && [ -z "$INSTR_FILE" ]; then
  echo "install: --generic requires --instruction-file <path> (or set adapters.generic.instruction_file in config.json first)" >&2
  exit 1
fi

if [ "$DRY" -eq 1 ]; then
  echo "would: axmem init (create \$AXMEM_HOME, config, memory skeleton)"
  [ "$WIRE_CC" -eq 1 ] && node "$ROOT/adapters/claude-code/merge-hooks.cjs" --dry-run
  [ "$WIRE_HERMES" -eq 1 ] && node "$ROOT/adapters/hermes/wire.cjs" --dry-run
  [ "$WIRE_GENERIC" -eq 1 ] && bash "$ROOT/adapters/generic/wire.sh" "$INSTR_FILE" --dry-run
  exit 0
fi

bash "$ROOT/bin/axmem" init
if [ "$WIRE_CC" -eq 1 ]; then
  node "$ROOT/adapters/claude-code/merge-hooks.cjs"
  echo "note: Claude Code loads hooks at session start — restart the session to activate."
fi
if [ "$WIRE_HERMES" -eq 1 ]; then
  node "$ROOT/adapters/hermes/wire.cjs"
  echo "note: enforcement=detect-and-correct, delivery=best-effort (D2/D10) — Hermes reloads config.yaml at next startup, and each hook still needs one-time consent (TTY prompt, or HERMES_ACCEPT_HOOKS=1 / hooks_auto_accept: true — axmem never sets these for you, D3)."
fi
if [ "$WIRE_GENERIC" -eq 1 ]; then
  bash "$ROOT/adapters/generic/wire.sh" "$INSTR_FILE"
  echo "note: enforcement=convention (D4) — nothing here is enforced at runtime; schedule.sh --print has the cron/schtasks lines to add yourself."
  _configured_instr="$(bash "$ROOT/bin/axmem" config get adapters.generic.instruction_file '' 2>/dev/null)"
  if [ "$_configured_instr" != "$INSTR_FILE" ]; then
    echo "note: axmem doctor's generic fence check reads config.json's adapters.generic.instruction_file, which install.sh does NOT write for you (it never edits your config.json). Add \"instruction_file\": \"$INSTR_FILE\" under \"adapters\".\"generic\" yourself so doctor can find it next time."
  fi
fi
bash "$ROOT/bin/axmem" doctor
