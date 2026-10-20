# CR-CRU-202 — a rust run streams its tests through nextest

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200 · **Status**
PENDING — filed 2026-10-20 (user rulings 2026-10-20; design in `DN-crucible-live-test-progress.md`)

## Problem

A rust run's live progress is a count read from nextest's human result lines; its record is the
JUnit report nextest writes at exit. cargo-nextest (0.9.130, measured) can stream each test as JSON
(`--message-format libtest-json` / `libtest-json-plus`), marked experimental in its help.

## Scope

- **§S1 — nextest streams to the board.** The rust client runs nextest with its JSON message format
  writing to the stream file, relays it to the open run, and a board codec decodes nextest's
  libtest JSON.
- **§S2 — the stream is the rust run's record.** A streamed rust run is recorded from its stream;
  llvm-cov's coverage stays a final report.
- **§S3 — the declaration.** A rust project declares its stream in `crucible.toml`, in the same
  vocabulary as a bun target's.

## Acceptance criteria

To be made exact at gap analysis, after measuring what nextest's JSON format needs to run and how
stable it is. These hold under any design:

- [ ] A rust run's tests reach the open run one by one while it runs, through the real client and
      real nextest.
- [ ] The stored result equals the JUnit report's for the same run, on every tier verb, asserted
      before the JUnit path is removed.

## Non-goals

- `cargo test` without nextest.
