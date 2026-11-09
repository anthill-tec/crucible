# Go compile failures

Real Go output (`go version go1.27.3-X:nodwarf5 linux/amd64`, `/usr/bin/go`), captured 2026-11-09
from small scratch modules. Each command ran in the module's root with stdout and stderr sent to one
file (`> out.txt 2>&1`), so each file keeps Go's own order. The files are kept byte for byte, with
one exception: Go printed every path relative to the module root except the absolute directory in
`build-two-packages-one-directory.txt`, which reads `/work/twopkg/inv` instead of the scratch path.

Environment for every capture: `GOTOOLCHAIN=local GOPROXY=off GOFLAGS= GOWORK=off GOENV=off`, with
a scratch `GOCACHE` and `GOMODCACHE`. Every command exited 1.

| File | Module | Command | What fails |
|---|---|---|---|
| `build-multi-package-too-many-errors.txt` | `example.com/shop`: `api` (3 errors), `store` (12 undefined names), `util` (clean), the root `main` (1 error) | `go build ./...` | three packages under `# pkg` headers; `store` stops at its tenth error and prints a positioned `too many errors` line; the root package's path reads `./main.go` |
| `build-interface-mismatch.txt` | `example.com/iface`: `shape` (a `Square` whose `Area()` does not match the interface's `Area(int)`), `render` (clean) | `go build ./...` | one diagnostic, then two continuation lines (`have …` and `want …`), each indented by two tabs |
| `build-missing-module.txt` | `example.com/missing`: `main` imports `example.com/nowhere/widgets`, which no module provides | `go build ./...` | one diagnostic with no `# pkg` header, then its tab-indented `go get` hint |
| `build-go-mod-error.txt` | `example.com/gomod`: `go.mod` holds an unknown `bogus` directive on line 5 | `go build ./...` | a `go:` line, then `go.mod:5: …`, a diagnostic with no column |
| `build-import-cycle.txt` | `example.com/cycle`: `orders` imports `billing`, which imports `orders` | `go build ./...` | a load-stage failure with no positioned diagnostic: a `package …` line and two tab-indented `imports …` lines |
| `build-two-packages-one-directory.txt` | `example.com/twopkg`: `inv/x.go` says `package inv`, `inv/y.go` says `package stock` | `go build ./...` | a load-stage failure with no positioned diagnostic and no header: one `found packages …` line naming an absolute directory |
| `test-compile-import-cycle.txt` | `example.com/cycle` (as above) | `go test -count=1 -vet=off -run '^$' -exec /bin/true ./...` | the cycle once per package, each under a `# pkg` header and followed by `FAIL pkg [setup failed]`, then the closing `FAIL` |
| `test-compile-test-file-error.txt` | `example.com/books`: `ledger` (its `_test.go` does not compile), `clock` (no test files), `money` (tests compile) | `go test -count=1 -vet=off -run '^$' -exec /bin/true ./...` | one test-file diagnostic under a `# pkg [pkg.test]` header, with the `?`, `FAIL pkg [build failed]`, `ok` and closing `FAIL` lines around it |
