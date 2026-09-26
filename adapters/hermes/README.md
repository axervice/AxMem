# Hermes bridge adapter (P1 2.1, 2026-09-16)

**Enforcement: `detect-and-correct` — there is NO real blocking in P1.** The
bridge wires `post_tool_call`, `pre_llm_call`, `on_session_start`, and
`on_session_end` only. It never wires `pre_tool_call`, so nothing this
adapter does can stop a write before it happens; it can only detect a
violation *after* the write landed and queue a correction for the next LLM
turn. `axmem doctor` and this README and `SNIPPET.md` all say the same thing
on purpose (D2) — if any of the three drifts, that's a bug.

**Delivery: `best-effort`.** The wire from the bridge to Hermes is a single
stdout write with no receipt channel back (D10) — Hermes reads the bridge's
whole stdout only after the subprocess exits (`communicate()`), so there is
no way for the bridge to know the injection actually landed. This adapter
never claims at-least-once or exactly-once delivery. A crash between writing
stdout and clearing the queue can duplicate a correction; a crash on the
Hermes side between reading stdout and using it can lose one. Both are
accepted and recorded honestly (`draining-recovered` in the ledger marks the
"possibly duplicated" case).

## Single-writer rule (D1)

AxMem never reads or writes `~/.hermes/memories/MEMORY.md`, `USER.md`, or
`SOUL.md`. The retired `adapters.hermes.memory_md` config key gets an
explicit deprecation diagnostic (every `axmem` invocation, plus `axmem
doctor`) if a legacy config still sets it. The only Hermes file this adapter
writes is `config.yaml`'s `hooks:` block (via `wire.cjs`, always backed up
first) — and it refuses (rc 3, zero write) rather than guess whenever the
existing YAML isn't in the narrow, provably-safe shape it understands.

## Status tiers (D5)

- `configured` — the `hooks:` block is wired into `config.yaml`.
- `approved` — additionally, all 4 hook commands are present in Hermes's own
  `shell-hooks-allowlist.json` (first-use consent already granted).
- `active` — **never reported.** Hermes has no CLI or API to list the hooks
  actually loaded in a *running* process (`hermes hooks list`/`doctor` only
  reflect the static config file and the allowlist — verified from
  `hermes_cli/subcommands/hooks.py` and `agent/shell_hooks.py`). Claiming
  `active` would be an unverifiable claim (D9 forbids that), so `axmem
  doctor` never prints it.

## Consent (D3)

AxMem never sets `hooks_auto_accept: true` and never touches
`shell-hooks-allowlist.json`. Approve the 4 wired commands yourself: answer
the TTY prompt the first time each fires, or set `HERMES_ACCEPT_HOOKS=1` /
`hooks_auto_accept: true` in your own `config.yaml` if you want it
unattended. `axmem doctor` reports whichever you chose; it never changes it.

## Wiring

```
bash install.sh --hermes     # or: node adapters/hermes/wire.cjs [--dry-run]
```

Writes a `hooks:` block pointing `post_tool_call` / `pre_llm_call` /
`on_session_start` / `on_session_end` at `adapters/hermes/bridge.cjs`.
`post_tool_call`'s matcher is `^(write_file|patch)$` (Hermes's actual write
tools, verified from `tools/file_tools.py` — NOT Claude Code's `Edit|Write|
MultiEdit`). Restart Hermes (CLI or gateway) to pick up the new config.

## What it does per event

- `post_tool_call`: normalizes the tool's path field to canonical
  `{tool_name: "Write", tool_input: {file_path}}`, runs `axmem gate --block`
  and `axmem trigger` against it, and queues any hit (best-effort, D10).
- `pre_llm_call`: drains this session's queue into `{"context": "..."}`.
- `on_session_start`: queues the session-lamp text (pending-receipts nudge).
- `on_session_end`: runs `axmem receipt stop-check --no-block` — same
  determination as Claude Code's Stop hook, but the exit code is always 0
  (this bridge has no blocking channel on this event regardless).
