# Phase-0 extraction ledger — what is NOT yet portable

Extracted 2026-09-13 from a live single-user deployment (4 months of
production hardening, 22-entry guard canary, all green at extraction time).
**Status update 2026-09-13 (second pass): the governance core is fully ported — six components run prelude-only (zero hardcoded paths), each with red/green self-tests, under an auto-registering canary. The acceptance scenario (fictional user, empty HOME, zero edits, doctor all-green) passes. The tables below now describe the LEGACY extracted copies kept for reference.**

## Hardcoded assumptions to parameterize in Phase 1

| Class | Instances | Plan |
|---|---|---|
| Author home path (`C:/Users/<user>`, `/c/Users/<user>`) | most scripts | `AXMEM_HOME` env + config file, resolved once in a shared prelude |
| Memory dir layout (`~/.claude/memory`, `_local-config/`, `dreams/`) | hooks + retrieval | `AXMEM_MEMORY_DIR`, layout manifest with schema version |
| Project-specific routing (repo names, LESSONS.md paths) | `pmm-entry-length-watch.sh`, `pmm-pointer-lint.cjs` | move to `axmem.config.json` (per-user project map) |
| Semantic backend (gbrain + Ollama bge-m3, Windows bun paths) | `retrieval/pmm-search.sh` fallback chain | pluggable locator interface; ship text-only as default, semantic as optional adapter |
| Canary roster (author's guards + product tests) | not extracted | ship a roster **template** + self-test contract doc instead |
| Windows/git-bash quirks (cmd.exe caret, MSYS path conversion, CRLF) | various comments | keep — they are hard-won documentation, gate them by platform check |

## Deliberately NOT extracted

- Personal memory content, secrets, `_local-config` backups, PERMANENT repo
  machinery (design doc will describe the pattern; the repo itself is private).
- The upstream PMM plugin (PolyForm NC — compatibility documented, never bundled).
- `guard-canary.sh` as-is (roster is personal; the *pattern* ships as template).

## Acceptance bar for Phase 1

A fictional user on a clean VM (Windows + macOS + Linux) runs
`axmem init` against an empty memory dir and gets: write gates active,
pointer lint green, canary template passing its own self-test — with zero
edits to any script. Until that bar is met, this repo stays pre-alpha.
