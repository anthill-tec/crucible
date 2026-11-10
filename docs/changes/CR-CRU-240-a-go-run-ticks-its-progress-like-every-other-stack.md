# CR-CRU-240 — a Go run ticks its progress like every other stack

**Status:** PENDING · Pre-review: none — no trigger
**Type:** feature
**Priority:** medium
**Depends on:** CR-CRU-195, CR-CRU-196
**Labels:** clients, go, shared-modules
**Phase:** design
**Design reference:** `docs/research/DN-crucible-live-test-progress.md` (in-run ticks while the relay
lands no batch); CR-CRU-233 (the `nextest` branch of the shared stream reading)

## Context

Every client except the Go one shows a running run's progress in two ways:

- the relay lands the stream's batches on the board;
- between those batches, the shared narrator prints and posts `running N[/M]` ticks.

The narrator reads a stream through the shared run module's one reading of a stream line,
`_counted_event` (`clients/_crucible_run.py`). That reading knows only the `crucible-events` and
`nextest` codecs, and counts no `go-test` event. So `_go_test_run` (`clients/go-crucible.py`) hands
the relay a no-op tick sender. While `go test -json` runs, an agent watching its console sees no
count, and a long build or a slow package that lands no batch posts nothing to keep the run's agent
alive.

`go test -json` writes one JSON object per line, keyed on `Action` and `Test`. Measured on go1.27.3:

- a test's terminal action is `pass`, `fail` or `skip`;
- a subtest's `Test` is `Parent/child`;
- package-level actions carry no `Test`: `start`, `output`, `fail`, and since go1.24 `build-output`
  and `build-fail`;
- `go test -list` names only top-level tests. On a module with 6 top-level tests and 4 subtests, the
  stream holds 10 terminal events with a `Test`.

The stream states no total. The Go client already takes the run's total from `go test -list`.

## Scope

### §S1 — the shared stream reading learns `go-test`

- **The constant.** `clients/_crucible_run.py` gains `GO_TEST_STREAM_CODEC = "go-test"`, beside
  `NEXTEST_STREAM_CODEC`.
- **The reading.** Under that codec, `_counted_event` reads `Action` and `Test`:
  - `pass` or `fail` with a top-level `Test` (one holding no `/`) is `("result", True)`;
  - `skip` with a top-level `Test` is `("result", False)`;
  - everything else is `(None, None)`: subtests, package-level actions, `run`, `output`, `pause`,
    `cont`, `start`, `bench`, `build-output` and `build-fail`.

  Counting top-level tests only keeps N against the listed total M, which `go test -list` gives at
  the same granularity. The closing count stays the board's own decode.
- **No change elsewhere.** The `crucible-events` and `nextest` readings are unchanged.

### §S2 — the Go client posts its ticks

In `_go_test_run` (`clients/go-crucible.py`), the `start_stream_relay` call:

- passes `_axi().narration_poster(_post, key, agent, identity)` as its tick sender, in place of
  the no-op;
- passes `GO_TEST_CODEC` as the codec, as today;
- passes `listed_total=total`, the listed total the run already opened with. When a listing failed,
  `total` is None, and the tick then reads `running N`.

### §S3 — the gated identity reaches the ticks

- `_gated_go_run` binds the gated bracket's identity (`with _axi().gated_run(...) as identity`) and
  passes it to `_go_test_run`.
- `_go_test_run` takes `identity=None` and hands it to `narration_poster`.

A tick under a gated run is then observed by the identity, as on every other stack.

### §S4 — the shared module's size budget

`_crucible_run.py`'s pinned line budget is raised by exactly the lines §S1 adds.
`SHARED_MODULE_LINE_BUDGETS` is re-seeded at that value in the three modules that pin it:

- `tests/client/test_arduino_client_sends_its_runners_reports.py`;
- `tests/client/test_rust_client_sends_its_runners_reports.py`;
- `tests/client/test_mvn_client_sends_its_runners_reports.py`.

`_crucible_axi.py`'s budget is unchanged.

### §S5 — docs

The CHANGELOG `[Unreleased]` says that a Go run ticks `running N/M` against its listed total, while
the relay lands no batch.

## Acceptance criteria

- [ ] **AC1 — the reading counts top-level Go results.** On a captured `go test -json` stream from a
  module with a passing, a failing and a skipped test, a parent with nested subtests, a parent whose
  subtest fails, and an `Example` with output, `_counted_event` under `go-test` counts:
  - 6 results: one per top-level test;
  - with `ran` True for 5 and False for the skip;
  - nothing for any subtest, any package-level action, or any `run`, `output`, `pause` or `cont`
    line.
- [ ] **AC2 — a Go run ticks.** With the relay landing no batch for longer than the tick interval:
  - a Go `test` run prints and posts `running N/M`, with M the run's listed total;
  - a run whose listing failed posts `running N`;
  - a run whose relay lands batches posts no in-run tick.
- [ ] **AC3 — every streaming verb ticks.** `regression` over two modules, a declared tier verb, and
  a gate's per-tier suite each post ticks through the same tick sender. The single `_go_test_run`
  call site carries them all.
- [ ] **AC4 — a gated run's ticks are observed.** Under a gated run, the tick poster is
  `narration_poster` built with the bracket's identity, and the identity observes each tick's
  response.
- [ ] **AC5 — the budget is re-recorded.**
  - `_crucible_run.py`'s line count equals the re-seeded `SHARED_MODULE_LINE_BUDGETS` value in all
    three pinning modules, and those pass.
  - `_crucible_axi.py` is unchanged against the base.
- [ ] **AC6 — the other codecs are unchanged.** `test_the_shared_run_path_reads_every_stack_as_before`
  and `test_a_streamed_runs_in_run_count_comes_from_its_stream` pass unchanged.
- [ ] **AC7 — docs and hygiene.**
  - The CHANGELOG line of §S5 is present.
  - The code and tests carry no CR id literal.

## Estimated size

3 points:

- one codec branch and a constant in the shared module;
- the Go call site's tick sender, listed total and identity;
- the budget re-seed.

## Risk

- A future go release adding a terminal action. The reading counts only `pass`, `fail` and `skip`
  with a top-level `Test`, so an unknown action counts nothing.

## Non-goals

- Tier verbs (CR-CRU-196), and compile errors or coverage (CR-CRU-239).
- Any change to how the board decodes `go test -json`.
- The closing `ran N/M` line of a Go run: it keeps today's close.
