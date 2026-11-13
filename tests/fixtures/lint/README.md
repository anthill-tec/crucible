# Linter output

Real linter runs, captured 2026-11-14 from small scratch sources. Each command ran in the directory named
below with stdout and stderr sent to one file (`> out.txt 2>&1`), so each file keeps the tool's own order.
The files are kept byte for byte (trailing spaces included), with one exception: an absolute scratch path
the tool printed was rewritten to a relative one. That touched only cargo's `Checking … (<dir>)` lines,
which now read `(clippy-mixed/broken)`, `(clippy-mixed/shop)`, `(clippy-deny-warnings)` and
`(clippy-clean)`, and clang-tidy's two file paths, which now read `a.c`.

| Tool | Version |
|---|---|
| ruff | `ruff 0.16.10`, run as `.venv/bin/python -m ruff` |
| cargo clippy | `clippy 0.1.97 (8bab26f4f6 2026-07-14)`, `cargo 1.97.1 (c980f4866 2026-06-30)`, `rustc 1.97.1 (8bab26f4f 2026-07-14)` |
| clang-tidy | `LLVM version 23.1.4` (`/usr/bin/clang-tidy`) |
| go vet | `go version go1.27.3-X:nodwarf5 linux/amd64` (`/usr/bin/go`) |

## The captures

| File | Ran in | Command | Exit |
|---|---|---|---|
| `ruff-mixed.txt` | `ruff/` | `python -m ruff check --isolated --no-cache --select F,E902 --output-format concise a.py b.py c.py missing.py` | 1 |
| `ruff-clean.txt` | `ruff-clean/` | `python -m ruff check --isolated --no-cache --select F --output-format concise ok.py` | 0 |
| `clippy-mixed.txt` | `clippy-mixed/` (a two-member workspace) | `cargo clippy --offline --keep-going -j 1` | 101 |
| `clippy-deny-warnings.txt` | `clippy-deny-warnings/` | `cargo clippy --offline -- -D warnings` | 101 |
| `clippy-clean.txt` | `clippy-clean/` | `cargo clippy --offline` | 0 |
| `clang-tidy-warnings.txt` | `clang-tidy/` | `clang-tidy -checks='-*,readability-braces-around-statements' a.c --` | 0 |
| `clang-tidy-warnings-as-errors.txt` | `clang-tidy/` | `clang-tidy -checks='-*,readability-braces-around-statements' --warnings-as-errors='readability-braces-around-statements' a.c --` | 1 |
| `go-vet.txt` | `go-vet/` | `go vet ./...` | 1 |

Every cargo run had `CARGO_TARGET_DIR` inside the scratch directory and used crates with no dependencies.
`go vet` ran with `GOFLAGS=-mod=mod GOTOOLCHAIN=local GOPROXY=off GOWORK=off`, and a scratch `GOCACHE` and
`GOPATH`.

## The scratch sources

### `ruff/` — for `ruff-mixed.txt`

`missing.py` does not exist; ruff reports it as `E902`.

`a.py` (a fixable `F401`):

```python
import os


def greet(name):
    return f"hello {name}"
```

`b.py` (an unfixable `F821`):

```python
def total(items):
    return sum(items) + missing_offset
```

`c.py` (two `invalid-syntax` findings):

```python
def broken(:
    pass
```

### `ruff-clean/` — for `ruff-clean.txt`

`ok.py`:

```python
def greet(name):
    return f"hello {name}"
```

### `clippy-mixed/` — for `clippy-mixed.txt`

`Cargo.toml`:

```toml
[workspace]
members = ["shop", "broken"]
resolver = "2"
```

`broken/Cargo.toml` and `shop/Cargo.toml` are each a bare `[package]` (`name = "broken"` / `"shop"`,
`version = "0.1.0"`, `edition = "2021"`) with an empty `[dependencies]`.

`broken/src/lib.rs` (an `E0308` error; a crate that fails type-checking runs no clippy lint, so the error
lives in its own crate):

```rust
pub fn count() -> i32 {
    let count: i32 = "three";
    count
}
```

`shop/src/main.rs` (a lint denied through `#![deny(clippy::all)]`, the warn lint `clippy::ptr_arg`, and
rustc's own `unused_variables`):

```rust
mod strict {
    #![deny(clippy::all)]

    pub fn add(a: i32, b: i32) -> i32 {
        return a + b;
    }
}

fn label(n: &String) -> usize {
    n.len()
}

fn main() {
    let unused = 5;
    println!("{} {}", strict::add(1, 2), label(&String::from("x")));
}
```

### `clippy-deny-warnings/` — for `clippy-deny-warnings.txt`

`Cargo.toml` is a bare `[package]` (`name = "ledger"`, `version = "0.1.0"`, `edition = "2021"`) with an
empty `[dependencies]`. `src/main.rs` (the default-warn `clippy::needless_return`, denied by `-D warnings`):

```rust
fn double(n: i32) -> i32 {
    return n * 2;
}

fn main() {
    println!("{}", double(21));
}
```

### `clippy-clean/` — for `clippy-clean.txt`

`Cargo.toml` is a bare `[package]` (`name = "tidy"`, `version = "0.1.0"`, `edition = "2021"`) with an
empty `[dependencies]`. `src/main.rs`:

```rust
fn double(n: i32) -> i32 {
    n * 2
}

fn main() {
    println!("{}", double(21));
}
```

### `clang-tidy/` — for both clang-tidy captures

`a.c`:

```c
int sign(int x) {
  if (x > 0)
    return 1;
  if (x < 0)
    return -1;
  return 0;
}
```

### `go-vet/` — for `go-vet.txt`

`go.mod`:

```text
module example.com/vetme

go 1.22
```

`report/report.go` (two printf-verb findings):

```go
package report

import "fmt"

func Summary(name string, count int) string {
	return fmt.Sprintf("%d items for %d", name, count)
}

func Total(a, b int) int {
	fmt.Printf("total %s\n", a+b)
	return a + b
}
```
