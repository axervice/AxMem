# Generic adapter (P1 2.2, 2026-09-16)

**Enforcement: `convention` (D4) — always.** There is no hook mechanism to
assume for an arbitrary agent, so nothing here runs automatically. This
adapter is a wiring convenience plus a doctor check, not a runtime guard.

Any agent that can run a CLI can be governed:
- `axmem init` — create/point `AXMEM_MEMORY_DIR` at a markdown memory dir.
- `bash adapters/generic/wire.sh <instruction-file>` (or `install.sh
  --generic --instruction-file <path>`) — append `SNIPPET.md`'s governance
  section into that agent's own instruction file, via `lib/fence.sh`
  (idempotent, byte-safe, backs up first, refuses rc 3 on a torn fence
  rather than guessing).
- Have the agent run `axmem gate --block` after memory writes (exit 2 = fix
  before continuing) and `axmem receipt add <kind> <ref> "<verbatim>"` for
  rulings — see `SNIPPET.md` for the exact text to wire into the agent's
  own prompt.
- `bash adapters/generic/schedule.sh --print` — prints the cron line and the
  Windows `schtasks` command for `axmem doctor && axmem canary` on a
  schedule. Never installs anything on your behalf ("不代执行") — copy the
  line yourself.
- `axmem doctor` reports a `generic` section: whether the memory dir is
  initialized, whether the configured instruction file's fence is present,
  the most recent `axmem canary` timestamp, and the fixed
  `enforcement=convention` string.

Doctor's fence check reads `adapters.generic.instruction_file` from
`config.json` — `install.sh --generic --instruction-file <path>` does NOT
write that back into your config for you (it never edits config.json), so
set it yourself if you want `axmem doctor` to keep tracking that file.
