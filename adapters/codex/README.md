# Codex adapter

Raw prompt receipt capture was removed on 2026-09-30 by Jax: AxMem should remember a concise, precise meaning instead of permanently storing the plaintext original prompt. For a Codex home that still contains the previously installed capture hooks, run `node adapters/codex/uninstall-hooks.cjs <absolute-CODEX_HOME> [--dry-run]`; the uninstaller removes only the recognizable AxMem raw-capture hook groups, preserves other hooks, and does not read or modify `config.toml` or `auth.json`.
