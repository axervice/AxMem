# G1-R6 integration candidate

Status: review candidate only. This does not authorize product integration, formal freeze, runner execution, or P2.1.

## Purpose
Replace the handwritten shell heredoc/call scanner used by inspectLiteralGeneratedArtifact with the pinned mvdan/sh v3.13.1 AST helper proven through G1-R5e.

## Integration boundary
The public inspectLiteralGeneratedArtifact API remains synchronous.
scripts/p2-freeze.cjs loads scripts/private/p2-bash-ast/adapter.cjs.
The adapter runs only the fixed private executable path bin/p2-bash-ast.exe and rejects a missing or hash-mismatched helper. It never searches PATH and never downloads a helper or toolchain.

The candidate deletes the old scanShellHeredocs/findGeneratedNodeCalls tokenizer/scanner path. There is no regex fallback for shell syntax.

## Generated artifact proof
The target marker must identify exactly one parser-bound heredoc.
That heredoc must be associated by AST spans with exactly one heredoc-bearing Stmt.
The owning Stmt must prove all of the following:
- simple CallExpr;
- static command value cat;
- no assignments;
- exactly one command argument;
- exactly two redirections;
- first redirection is fd-empty > to an exact double-quoted short parameter expansion matching the requested variable;
- second redirection is fd-empty << to the requested single-quoted literal marker;
- the parser-bound marker/body/closing spans on the Stmt redirection exactly match the target heredoc record.

No text search is used to reconstruct shell ownership or redirection grammar.

The generated body is sliced from the original frozen Buffer using the parser-provided body span. Body bytes, SHA-256, LF flag, opener line, closing line, and call line are derived from that original Buffer. Line text/hash remain evidence anchors only.

## Node invocation prerequisite
unsupportedCommands must be empty before full-file exact-one analysis can proceed.
The target calls array is then independently filtered for an exact double-quoted short parameter equal to the requested variable and must contain exactly one result.

An empty unsupportedCommands list is only a prerequisite; it is not itself a uniqueness, reachability, execution, or execution-closure proof.

The known real scope source still contains dynamic command word "$0", so it remains blocked. The candidate does not infer its runtime value.

## Frozen source
verifyGeneratedArtifactEvidence is unchanged at the source boundary: it requires the generator in the frozen file map/blobs, reads the matching git commit blob, checks exact bytes and hash, and then calls inspectLiteralGeneratedArtifact with that frozen blob.
No current HOME file is used as a substitute.
No SCOPE evidence record is added by this candidate; missing SCOPE remains missing.

artifact-verified and execution-closed remain separate. Verified generated artifact evidence returns executionClosed: false.

## Private dependency distribution
Source/build materials:
- scripts/private/p2-bash-ast/main.go
- go.mod
- go.sum
- adapter.cjs
- helper.lock.json
- BUILD.md

The executable itself is not part of this candidate patch.
A deployment/integration gate must separately build or provision bin/p2-bash-ast.exe with the pinned portable Go 1.26.1 environment and mvdan/sh v3.13.1 module graph, then verify the exact SHA-256 in helper.lock.json and adapter.cjs.
The runtime does not install Go, download modules, or auto-rebuild the helper.

## Public export impact
Current publish.manifest.json excludes scripts/**, so p2-freeze and all private parser source/build/runtime paths remain private and are not exported.
The existing P2 machine/freeze tests and p2-equiv fixtures are also explicitly excluded.

The new candidate test tests/p2-generated-ast-integration.test.cjs is not covered by the current explicit P2 test exclusion. This R6 unit intentionally does not modify publish.manifest.json or run a formal export. Before committing that new test in a product-integration gate, its public-export disposition must be explicitly decided; the expected private-build treatment is exclusion alongside the existing P2 tests because it depends on excluded scripts/private code.

## Validation
Isolated generated-AST integration test: 21/21 pass.
Final candidate p2-machine-acceptance: 97/97 pass.
Candidate p2-freeze-equiv self-test: 35/35 pass.

The first machine-acceptance run after the AST replacement was 94/97 because three old handwritten-tokenizer expectations no longer matched the mature AST semantics. Candidate tests were corrected only:
- escaped command word \node "$tmp" is a proven literal node command;
- backslash-newline continuation node \ + "$tmp" is a proven node call;
- cross-line quoted pseudo-call remains a non-call and now rejects as generated-call-ambiguous rather than the removed handwritten scanner's generated-shell-unsupported.

The authoritative machine-acceptance result after those expectation updates is 97/97.