# AxMem section for any agent's instruction file
# (Copy or wire this into the agent's own instruction file — AxMem never
#  writes another agent's memory files, only its OWN marker-fenced section
#  in a file you point it at: single-writer rule.)
#
# Enforcement here is convention-level (D4): nothing in this repo enforces
# any of the steps below at runtime for a generic agent. There is no hook
# mechanism to assume, no shared event model, no way to verify a step ran.
# `axmem doctor` reports enforcement=convention for this adapter, always.

## Memory governance (AxMem)
- Governed memory dir: run `axmem config get memory_dir` to locate it.
- After ANY edit to a governed memory file: `axmem gate --block < /dev/null`
  (exit 2 = fix the flagged debt before continuing).
- When the operator makes a ruling, record it verbatim at that moment:
  `axmem receipt add user-ruling "<topic>" "<their exact words>"`.
- Before ending a work session: `axmem receipt pending` → sediment, then
  `axmem receipt cover --all` (or `--dismiss --all` when truly disposable).
- Never delete a memory entry without its verbatim block landing in the
  matching *-archive.md in the same commit (`axmem precommit` enforces).
- On a schedule (see `adapters/generic/schedule.sh --print` for cron/
  schtasks lines to add yourself — AxMem never installs a scheduled task on
  your behalf): `axmem doctor && axmem canary` (exit code is the alarm).
