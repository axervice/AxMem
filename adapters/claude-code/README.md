# Claude Code adapter (reference implementation)

Wire: `bash install.sh --claude-code` → idempotent merge into `settings.json`
(timestamped backup first; existing hooks untouched; re-run = no-op).
Hooks wired: write-gate + moment-triggered recall on Edit/Write/MultiEdit ·
receipt capture on AskUserQuestion · receipt stop-check on Stop · receipt
lamp on SessionStart.
Session identity: Claude Code's session env var, surfaced as AXMEM_SESSION_ID.

**Dedup (P1 2.4, 2026-09-17):** an existing hook entry is recognized by its
EXACT `{event, matcher, command}` identity, not by whether some command
string merely contains the substring "axmem" — the old heuristic both
false-positived on an unrelated third-party command that happened to
mention "axmem" (silently skipping our real entry) and could never
distinguish a genuinely-wired entry from stale drift. `axmem doctor`
verifies each of the 5 wanted entries individually and reports an anomaly
(0 or 2+ matches) rather than a single pass/fail for the whole adapter.
