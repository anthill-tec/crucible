# Captured nextest runs

Each directory under `runs/` holds what one real cargo-nextest 0.9.130 run
wrote (cargo 1.97.1), on one of the scratch crates under `crates/`:

- `stream.jsonl` — the run's `libtest-json-plus` stream (message-format
  version 0.1), stdout only;
- `list.json` — `cargo nextest list --message-format json` with the run's
  filter, the test list a client posts to the open run;
- `junit.xml` — the JUnit report the same run wrote.

`capture.sh` regenerates every run: it copies the crates to a scratch directory
under `/tmp`, builds them there with their own `CARGO_TARGET_DIR`, and writes
the three files back here. Its header states the exact commands.

| Run | Crate | Filter, retries | What it holds |
|---|---|---|---|
| `all-pass` | `nxpass` | — | a lib and an integration test, every test passing |
| `a-failure` | `nxshapes` | `test(=passes) \| test(=prints_then_panics)` | a pass, and a failure that prints before its two-line panic |
| `distinct-targets` | `nx-targets` | — | a lib, a bin (`tool`) and an integration test (`it`) with distinct names, a hyphenated package, a failure and an `#[ignore]` test |
| `same-name` | `nxsame` | — | a lib, a bin and an integration test all named `nxsame` |
| `spawned-thread-panic` | `nxshapes` | `test(=child_panic)` | a panic in a spawned thread, then the test's own |
| `should-panic-without-a-panic` | `nxshapes` | `test(=never_panics)` | a `#[should_panic]` test that does not panic |
| `err-return` | `nxshapes` | `test(=returns_err)` | a test returning `Err` |
| `flaky-retries` | `nxflaky` | `--retries 2` | a test failing its first attempt and passing its second, and one failing every attempt |
| `timeout` | `nxslow` | — | a test past its `slow-timeout` (the `ci` profile terminates it after 2 s) |

Rewritten: the toolchain's home directory in `list.json`, to `/home/user/`.
Everything else is nextest's own bytes.
