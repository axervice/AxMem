# Private Bash AST helper build candidate

Pinned source/runtime:
- Go: go1.26.1 windows/amd64 portable toolchain
- module: mvdan.cc/sh/v3 v3.13.1
- GOTOOLCHAIN=local
- CGO_ENABLED=0
- GOOS=windows
- GOARCH=amd64
- command: go build -trimpath -buildvcs=false -o bin/p2-bash-ast.exe .

The executable is a private runtime dependency. It is intentionally not part of the candidate patch binary payload.
Deployment must build or provision exactly bin/p2-bash-ast.exe and it must match helper.lock.json and the hard-coded adapter SHA-256.
The adapter never searches PATH, never downloads a toolchain or helper, and rejects missing or mismatched files.