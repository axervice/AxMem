# G1-R6a malformed parser-output fixture

Purpose: deterministic private-adapter negative test only. It emits invalid JSON bytes {bad and does not parse or execute shell input.

Offline build, using the already-verified portable Go 1.26.1 toolchain/cache:
- set GOTOOLCHAIN=local
- set CGO_ENABLED=0
- set GOOS=windows
- set GOARCH=amd64
- isolate GOPATH/GOMODCACHE/GOCACHE/GOTMPDIR/TMP under the G1-R6a temp root
- run: go build -trimpath -buildvcs=false -o bad-output.exe .

No download, PATH installation, or system install is required.
The integration test receives the freshly built executable path via AXMEM_R6A_BAD_OUTPUT_HELPER and copies it into a per-case private parser sandbox.