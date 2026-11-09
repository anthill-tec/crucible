# Captured Go coverprofiles

Real `go test -coverprofile` output from `go version go1.27.3-X:nodwarf5 linux/amd64`
(`/usr/bin/go`), captured 2026-11-09. The modules they ran on are kept under `testdata/` (Go skips a
`testdata` directory), so every capture can be made again. Every file is kept byte for byte.

Environment for every capture: `GOTOOLCHAIN=local GOPROXY=off GOFLAGS= GOWORK=off GOENV=off`, with
a scratch `GOCACHE` and `GOMODCACHE`. Every command ran in the module's root and exited 0. The
`*.go-test.txt` files are the `go test` command's console (stdout and stderr to one file). The
`*.cover-func.txt` files are `go tool cover -func=<profile>` run in the same module root.

## The modules

- `testdata/shop` — `example.com/shop`, three packages:
  - `price` (`Discount`, `Round`), tested by `price_test.go`, which calls `Discount` only;
  - `stock` (`Shelf.Value`, `Shelf.Take`), tested by `stock_test.go`, which calls `Value` — and
    through it `price.Round`, so under `-coverpkg=./...` the `Round` blocks are covered only in
    `stock`'s copy, while the `Discount` blocks are covered only in `price`'s copy;
  - `report` (`Line`), with no test file: Go lists its blocks at 0.
  No package-level function literal anywhere.
- `testdata/contracts` — `example.com/contracts`, one package `terms` of types and constants only,
  with a test: `go test` prints `coverage: [no statements]` and the profile is the `mode:` line alone.
- `testdata/ledger` — `example.com/ledger`, one package with no package-level function literal (its
  one function literal is declared inside `Debits`, so `go tool cover -func` counts it), one test.

## The captures

| File | Module | Command | What it holds |
|---|---|---|---|
| `shop-plain.coverprofile` | `shop` | `go test -count=1 -coverprofile=<file> ./...` | `mode: set`, each block once, `report`'s blocks at 0; 4 of 18 statements covered |
| `shop-coverpkg.coverprofile` | `shop` | `go test -count=1 -coverpkg=./... -coverprofile=<file> ./...` | the same blocks repeated: once per test package (`price`, `stock`) and `report`'s once more; each block's copies disagree on whether it ran |
| `contracts-types-only.coverprofile` | `contracts` | `go test -count=1 -coverprofile=<file> ./...` | `mode: set` and no block |
| `ledger.coverprofile` | `ledger` | `go test -count=1 -coverprofile=<file> ./...` | `mode: set`, 13 blocks |
| `ledger-count.coverprofile` | `ledger` | `go test -count=1 -covermode=count -coverprofile=<file> ./...` | `mode: count`: the same blocks, counts above 1 |
| `shop-plain.cover-func.txt`, `shop-coverpkg.cover-func.txt`, `ledger.cover-func.txt`, `ledger-count.cover-func.txt` | as their profile | `go tool cover -func=<profile>` | per-function lines and the `total: (statements) N%` line |

Go's own figures: `shop-plain` — `cover -func` total 22.2% (the per-package `go test` lines read
30.0%, 0.0% and 20.0%); `shop-coverpkg` — `cover -func` total 44.4%; `ledger` and `ledger-count` —
`go test` and `cover -func` both 75.0%. With no package-level function literal in any module, the
`cover -func` total is the profile's own figure: covered statements over all statements, each block
counted once and covered if any copy of it has a count above 0.
