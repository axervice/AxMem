# R16a v2.18 residuals

This file records findings from the two 2026-10-02 reviews that were not converted into a cheap local scanner rule under the v2.18 acceptance decision.

- **Windows CI must build and require the pinned Go v1 helper** (`review-20261002T084541Z-skNPu2.md` finding 11): this is CI wiring in `.github/workflows/ci.yml`, outside the R16a scanner write surface, so it must be supplied and verified by the merge/CI package rather than approximated inside the scanner.
- **The production entry/corpus membership must be re-derived when the frozen hook set changes** (`review-20261002T090109Z-pMDqGY.md` P2/Q5): the v2.18 `corpus-golden.json` pins the current 1616 entries exactly, but discovering newly added or removed hook entrypoints belongs to the freeze/R17 derivation step and cannot be made sound by a few local Bash syntax checks.
- **The `no-exit-function` assumption still needs sourced-closure verification** (`review-20261002T090109Z-pMDqGY.md` Q2): a local `source` statement does not expose the sourced file's function definitions to this scanner, so R17 must independently verify the closure before consuming terminating-arm results.

All Bash-semantic findings in those reviews that have a cheap fail-closed treatment are implemented in `target-rules.cjs`; they are not residuals.
