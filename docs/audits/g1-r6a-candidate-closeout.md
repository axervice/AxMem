# G1-R6a candidate closeout

Status: review candidate only. Product repository remains read-only. Product integration, runner, formal freeze, and P2.1 are not authorized.

## R6 content retained unchanged

R6's mature-AST integration design is retained:
- inspectLiteralGeneratedArtifact uses the private mvdan/sh v3.13.1 helper instead of scanShellHeredocs/findGeneratedNodeCalls;
- no handwritten shell-syntax fallback remains;
- target heredoc ownership is proved through the same AST Stmt as the static cat command and strict output redirection;
- unsupported command words block exact-one target-call analysis;
- body/hash/line evidence is derived from the original frozen Buffer;
- verifyGeneratedArtifactEvidence remains frozen-blob-bound;
- artifact-verified remains distinct from execution-closed and returns executionClosed false;
- helper source, adapter, module lock, build constraints, and pinned executable hash are unchanged from R6.

## R6a new fixes

1. Negative helper-integrity tests are isolated.
   The integration test never renames or rewrites the shared candidate helper.
   Each missing-helper, bad-hash, and malformed-output case creates an independent temporary parser directory with its own adapter/lock/helper copy.
   Missing-helper deletes only that sandbox copy; bad-hash mutates only that sandbox copy.
   The test records and verifies the shared helper SHA-256 before and after all negative cases.

2. Malformed-output fixture is self-contained.
   tests/fixtures/p2-bash-ast/bad-output contains minimal Go source, go.mod, and offline build instructions.
   It writes invalid JSON and does not parse or execute shell input.
   R6a builds it from source using the already-verified portable Go 1.26.1 toolchain/cache; no download or system install is used.

3. Normal helper reproducibility is rechecked.
   A second clean temporary build copies only the locked main.go/go.mod/go.sum and runs the pinned build command.
   The resulting p2-bash-ast.exe must match helper.lock.json before it is copied into the candidate fixed runtime path.
   The lock is not changed to accommodate a build result.

4. Public export disposition is explicit.
   Candidate publish.manifest.json adds exactly tests/p2-generated-ast-integration.test.cjs to exclude[].
   No other manifest policy is changed.
   A throwaway Git fixture invokes the production publish-public.cjs computeKeepList implementation and verifies:
   - the new integration test is excluded;
   - scripts/private/p2-bash-ast/bin/p2-bash-ast.exe is excluded by existing scripts/**;
   - README.md remains retained;
   - a public guard path remains retained.
   This is path-selection validation only, not a formal export.

## Final-test rule

After this document and all candidate source/fixture bytes are finalized, R6a records a pre-test SHA-256 table and runs exactly one final pass of:
- p2-generated-ast-integration.test.cjs;
- p2-machine-acceptance.test.cjs --self-test;
- p2-freeze-equiv.test.cjs --self-test.

After those runs, source bytes are not normalized, reformatted, or edited.
A post-test SHA-256 table must match the pre-test source table exactly.

## Baseline semantics

The final patch is relative to the actual current product worktree bytes captured in PRODUCT-BASELINE.json, not to a clean HEAD reconstruction.
This matters because scripts/p2-freeze.cjs and P2 tests are currently untracked/dirty product-worktree inputs even though HEAD remains 28987fb4c85476c7ea305b8662a204597a2c6831.

## Prohibited operations

No production guard/settings mutation, real HOME hook, parsed shell execution, account/API call, runner, formal freeze, P2.1, push, reset, stash, history rewrite, system Go install, or new network/tool download.