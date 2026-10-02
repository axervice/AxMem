# CI malformed parser-output helper

This helper is the committed source for the CI-only negative fixture used by
`tests/p2-generated-ast-integration.test.cjs`.

It is intentionally minimal: it writes the non-JSON bytes `{bad` and exits
successfully. On the Windows CI job it is built with the same pinned Go 1.26.1
toolchain and `-trimpath -buildvcs=false`, then passed through
`AXMEM_R6A_BAD_OUTPUT_HELPER`. The integration test must observe
`generated-parser-output-json`; merely building or setting the path is not
considered sufficient coverage.

The source is an LF-normalized copy of the previously validated G1-R7 bad-output fixture.
