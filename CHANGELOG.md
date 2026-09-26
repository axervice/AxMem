# AxMem CHANGELOG

## 0.1.0 — 2026-09-24

Initial public (free-tier) release.

- Write gate: a Claude Code hook that blocks edits and shell commands that would repeat a recorded lesson.
- Trigger recall: file-path and tool-keyed push of the matching lesson, with a receipt ledger of every push.
- Canary: self-registering health check across every guard, with an executed-count assertion.
- Pre-commit gate + lints: pointer lint, redundancy lint, entry-length and size caps, fingerprint drift detection.
- Isolation gate: guards self-tests and probes from ever touching a real home directory.
- Lifecycle: `install`, `doctor`, `backup`, `restore` (crash-consistent two-phase swap), `upgrade`, `uninstall`.
- Adapters: Claude Code, Hermes, Codex, and a generic instruction-file adapter.
- Self-tests everywhere: every component ships its own red/green self-test, discovered and run by `npm run selftest`.
