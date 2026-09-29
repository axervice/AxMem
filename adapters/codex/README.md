# Codex adapter: local raw prompt receipts

Codex command hooks are supported in current local Codex runtimes. This adapter
uses the documented `UserPromptSubmit`, `PreCompact`, `SessionStart`, and `Stop`
events. The earlier AGENTS.md-only contract in `wire.sh` still supplies memory
governance instructions; it does not install or trust hooks.

## Storage and meaning

`UserPromptSubmit` synchronously saves the exact `prompt` string in a local
receipt under `%LOCALAPPDATA%/AxMem/codex-raw/raw/<session-key>/<turn-key>/<id>/record.json` on Windows
(or `$XDG_STATE_HOME/axmem/codex-raw` on other systems). The override
`AXMEM_CODEX_RAW_DIR` is intended for isolated tests or deliberate relocation.
The ID is a hash of session ID, turn ID, and prompt bytes. An identical event
is idempotent; distinct steering text in the same turn gets a separate ID.
The Codex event schema does not provide a unique message-event ID, so repeated
identical text in the same turn cannot be distinguished.

This directory is outside the governed PMM and AxMem memory trees. Receipts are
local evidence, not authoritative memory, and are never added to Git by this
adapter. Prompts can contain secrets. The adapter does not upload, summarize,
classify, or automatically promote their text. It does not expire receipts;
review and retention are explicit local operations. Its default root is outside
Git; root and lower managed directories reject links/junctions. OS parent
directory redirection or third-party sync software is an environment boundary.

`node adapters/codex/raw-receipts.cjs status` lists unresolved IDs and the local
store path without printing prompt text. Inspect a specific `record.json`
locally. Mark an ordinary message reviewed with:

`node adapters/codex/raw-receipts.cjs resolve <id> no-memory "why no durable memory is needed"`

To mark a ruled decision saved, the memory file must contain both a specific
anchor and `codex-raw:<id>` as a source pointer. Then run:

`node adapters/codex/raw-receipts.cjs resolve <id> memory-saved "C:/absolute/memory.md#anchor" "how this entry covers the ruling"`

The resolution records the file's content hash, anchor, receipt ID, and review
reason. This is an auditable human assertion; the script cannot prove semantic
equivalence. The existing AxMem `receipt cover` command has a different,
commit-timing contract and is not used to clear these local receipts.

## Hook behavior and limits

`UserPromptSubmit` exits 2 with a reason if it cannot publish the prompt, so
Codex blocks that submission when the hook is running. Each published raw
receipt has a separate journal marker. `PreCompact` checks all currently
recorded IDs in both sets for the current session and returns `continue:false`
if a pair is missing or corrupt. Manual `/compact` creates a new turn, so its
turn ID need not match a captured prompt turn. A session with no confirmed
receipt still blocks compaction, including sessions started before hooks were
installed: send a new prompt after hook activation, or start a new chat. Do
not treat an older session's uncaptured text as recovered. A captured prompt
is enough for the session check even if `SessionStart` was missed. Checking
work scales with the number of recorded prompts in that session. `SessionStart` on startup,
resume, and compact returns a count and at most eight current-session receipt
IDs, plus bounded counts and session keys for older unresolved sessions, before the next model
request. `Stop` shows one warning per session; it does not create a synthetic
user prompt or automatically resolve receipts.

These guarantees apply only when the configured command hooks actually run.
Codex skips untrusted hooks; command startup failure, timeout, client-specific
gaps, and the absence of a `UserPromptSubmit` event cannot be detected from a
hook that never ran. `PreCompact` proves that all currently recorded IDs for
its session have matching raw and journal data. It cannot prove that every message
in that session fired a hook, or detect simultaneous removal of both local copies. Ordinary
Chat does not run Codex hooks. The raw text is never injected into developer
context on restore; only generated counts and IDs are returned.

## Installation

For each actual `CODEX_HOME`, run `node adapters/codex/install-hooks.cjs
"C:/absolute/CODEX_HOME" --dry-run`, then omit `--dry-run` to merge the four
handlers into `hooks.json`. The installer preserves other hook groups, makes
a timestamped backup of an existing file, and is idempotent. It does not edit
`config.toml`, change security policy, or grant hook trust. Inspect the new
definitions and trust them through Codex `/hooks`; changed definitions require
fresh review. Do not use the trust-bypass flag. Validate desktop Codex and each
CLI account separately, since this machine's CLI shim can select different
`CODEX_HOME` directories. A configured but untrusted hook is inactive. On
Windows, `commandWindows` starts with `node.exe`, so Node must be on the PATH
inherited by Codex. Codex's Windows `cmd.exe /C` wrapper does not run a command
whose first token is a quoted executable path containing spaces.

Test the bridge without touching real memory or config with:

`node adapters/codex/test-raw.cjs --self-test`

Hook event and trust semantics: <https://developers.openai.com/codex/hooks>.
