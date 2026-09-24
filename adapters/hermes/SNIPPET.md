# AxMem section for a Hermes-style agent's SOUL/system prompt
# (Copy this into the agent's own instruction file YOURSELF — AxMem never
#  writes another agent's memory or soul files: single-writer rule.)
#
# P1 2.1 (2026-09-16): if you've run `install.sh --hermes`, the checks below
# ALSO run automatically via the wired bridge (adapters/hermes/bridge.cjs) —
# enforcement=detect-and-correct, delivery=best-effort (D2/D10). There is no
# real pre-write blocking in P1 (Hermes wires post_tool_call, not
# pre_tool_call): a violation is detected AFTER the write lands and queued as
# a correction for the next LLM turn, on a single-direction, no-receipt
# stdout channel. The manual steps below are still worth keeping in the SOUL/
# system prompt as a backstop for anything the bridge's best-effort queue
# drops (see adapters/hermes/README.md for the full delivery-loss cases).

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
- Weekly: `axmem canary` (exit code is the alarm); monthly: `axmem fade`
  (report-only forgetting shadow window) and `axmem manifest --check`.
