# codex CLI adapter (contract, P1 scaffold)

codex has no hook system — the adapter is convention-based:
1. `AGENTS.md` include: installer appends a short AxMem section (memory dir
   location, entry form, the write-gate command to run after memory edits).
2. Gates run via `axmem gate --block < /dev/null` invoked by the agent per
   its AGENTS.md instructions; receipts via `axmem receipt add` verbatim.
3. Session identity: `CODEX_HOME` basename + machine id (no session env).
Status: contract fixed, installer wiring lands with the P1 second pass.
