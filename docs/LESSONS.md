# AxMem lessons

This is a repo-local selection from the PMM handoff dated 2026-11-16, checked against the current AxMem tree. It is not the PMM master copy; the entries below retain only rules relevant to this repo.

## 2026-09-17 — Synchronize live guard upgrades into the product with their specifications, tests, and validation fingerprints.
- Why: The P2 port uses a frozen live source as its equivalence reference and requires validation and fingerprint refresh for each batch; adapter work alone does not establish equivalence.
- Points to: `docs/P2-CC-PERFECT-SPEC.md`, `docs/freeze/README.md`
- Source: `axmem:product-repo-must-sync-with-live-guards-each-batch`

## 2026-10-23 — Verify recall source edges, citation boundaries, and display budgets independently.
- Why: A title or index arrow alone cannot prove a successor, and an omitted body is not a delivered one. Edge and citation cases are enforced by `adapters/codex/test-recall-selector.cjs`; whole-or-omitted behavior is enforced by `adapters/claude-code/test-hook.cjs`.
- Points to: `core/recall-source-proof.cjs`, `adapters/claude-code/hook.cjs`
- Source: `process:recall-source-grammar-and-budget-identity`

## 2026-10-23 — Treat integrity, verified source, authorization, and actual execution as separate claims.
- Why: A self-consistent hash does not prove a committed source or permission to execute. Source and inventory bindings are partly enforced by `tests/p2-machine-acceptance.test.cjs`; synthetic results do not establish real-client health.
- Points to: `scripts/equiv-runner.cjs`, `adapters/claude-code/README.md`
- Source: `process:proof-integrity-source-authority-separation`

## 2026-10-31 — Verify real producer bytes through the actual entry before claiming an integration is green.
- Why: Synthetic fixtures can miss the real wire format or transport; keep byte identity and client execution distinct from simulated success. The current Claude Code hook tests remain synthetic and real-client acceptance is still required.
- Points to: `adapters/claude-code/README.md`, `adapters/claude-code/test-hook.cjs`
- Source: `process:real-wire-format-before-green`

## 2026-10-31 — Run delivery tests from the integrated repo layout without relying on task scratch directories.
- Why: Tests need their actual transitive dependencies, fixtures, and source pins after integration; a passing scratch layout alone does not prove delivery. The generated-parser integration test resolves repo-local dependencies and checks source pins.
- Points to: `tests/p2-generated-ast-integration.test.cjs`
- Source: `tooling:delivery-tests-survive-integration-layout`
