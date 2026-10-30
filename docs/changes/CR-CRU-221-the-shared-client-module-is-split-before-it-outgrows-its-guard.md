# CR-CRU-221 — the shared client module is split, its run emitter is shared, and a reset board is answered

**Type** refactor · **Points** 13 (re-scored at its gap analysis, 8 → 13) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-206, CR-CRU-218 · **Status** PENDING — filed 2026-10-30 (user ruling at CR-CRU-206's spec pre-review, F9:
split `clients/_crucible_axi.py` in its own CR, ahead of CR-CRU-220); widened 2026-10-30 (user ruling at CR-CRU-206's
VERIFY: its F1, a connection reset at the ingest, and its F2, the run emitter written once per client, join this
CR); gap analysis 2026-10-30 (user rulings: the run and ingest pipeline moves; the core re-exports it; the transport
answers connection-level errors). The file keeps its first slug.

## Problem

1. **The module has outgrown its guard.** `clients/_crucible_axi.py`, the module all five clients load, is 9,997
   lines. `tests/citations-cite-by-symbol.test.ts` reads any bare number of five digits or more as a port, never a
   line, and a self-test fails the day an in-scope file reaches 10,000 lines (`BARE_LINE_IMPLAUSIBLE_THRESHOLD`).
   CR-CRU-220 adds `junit_case_sources` (about 25–30 lines, user ruling: the reader is shared), and every later
   shared helper would cross the guard too.
2. **The run emitter is written four times** (CR-CRU-206 VERIFY F2; CR-CRU-219's pre-review). The envelope emitter
   that reads the board's ingest answer — the `run:` block from `filed_run` with each figure null when absent, the
   answer's `warnings[]` joined, the answer's `error` — is bun's and python's `_emit_ingest_axi` and maven's and
   rust's `_emit_run_axi`, one copy per client, differing only in what each adds (bun: `runId`, `name`, `script`;
   rust: `coverage`).
3. **A connection the board drops escapes the transport** (CR-CRU-206 VERIFY F1, CR-CRU-219 VERIFY F3; present in
   every client before either). `http_request` answers `HTTPError`, `URLError` and a read `TimeoutError` as
   `{ok: false, error}`; a board that resets or drops the connection after taking the request raises
   `http.client.RemoteDisconnected` (a `ConnectionResetError`) out of it: the verb ends `verb-failed` with no
   `run:` block, no `ingest:` line and an open run left as it was, and a gate's suite carries no
   `gate-suite-unreported`. The exit is 1, so nothing reads as green, but the envelope does not say what happened.

## Design (user rulings 2026-10-30)

- **The run and ingest pipeline moves** into a new sibling module, `clients/_crucible_run.py`: the block of
  `_crucible_axi.py` from its `unit`-run wall-versus-CPU section (`UNIT_RUN_WALL_EXCEEDS_CPU_CODE`, `ChildRunTiming`)
  through `run_streamed` — narration (`RunNarrator`, `narration_poster`, `close_narration`), the run lifecycle
  (`open_run`, `abort_run` and their warnings), the ingest (`junit_testcase_count`, `junit_non_skipped_count`,
  `ingest_reports`, `_print_ingest_line`, `filed_run`, `coverage_not_measured_warning`, `ran_nothing`,
  `runner_exit_code`, `verb_exit`, `filed_summary`, `emit_ran_nothing`), the abandon trap (`RunAbandoned`,
  `AbandonTrap`, `abandon_trap`, the gated-run bookkeeping, `emit_run_abandoned`) and the runner group
  (`run_streamed`). Every growth this wave brings — the lifted emitter, CR-CRU-220's `junit_case_sources` — lands
  there. No line citation points into the moved range (every `_crucible_axi.py:<line>` citation in the repo is
  below it), so none moves.
- **The core re-exports it.** `_crucible_axi.py` loads `_crucible_run.py` by path from its own directory, as the
  clients load the core, and every name the run module defines is reachable as an attribute of the core module:
  no client changes, `_axi().ingest_reports` and a test's `axi.<name>` keep working. The run module reaches the
  core's names (`post_ingest`, `emit_axi`, `HELP_STEPS`, …) through the core module object it is bound to, at call
  time, so a test that patches a core name still reaches the moved code; each client's core instance binds its own
  run-module instance. The few tests that patch a moved function on the core so that a moved caller sees it are
  re-pointed at the run module.
- **The run emitter is lifted once,** into the run module, and the four clients' emitters become one-call
  delegators, as `_file_reports` is (CR-CRU-218).
- **The transport answers connection-level errors:** `ConnectionError` (reset, aborted, refused, broken pipe —
  `RemoteDisconnected` among them) and `http.client.HTTPException` (`IncompleteRead`, `BadStatusLine`) become the
  fleet's `{ok: false, error}` naming the board, as a `URLError` does. A bare `OSError` is still not caught
  (CR-CRU-126's ruling), and a non-empty body that is not JSON still raises.
- Apart from the reset's answer, behaviour does not change: every client verb, envelope and exit reads as before.

## Steps

### §S1 — the split

- `clients/_crucible_run.py` holds the block the Design names, unchanged in body except where it reaches a core
  name, which it does through the bound core module. It is stdlib-only, as the clients are, and lint-clean under
  the fleet's checks.
- `_crucible_axi.py` loses the block and gains the loader and re-export; it shrinks by about 1,000 lines.
- `crucible_axi/install.py`'s list of the files laid down beside the clients gains `_crucible_run.py`, and its
  comment says why (the core reads it by file path from its own directory); the wheel already ships `clients/`
  whole.
- The tests that read `_crucible_axi.py`'s source for a definition or a call shape (the shared-helper scans of
  `test_a_runs_ingest_helpers_live_once_in_the_shared_module.py`, `test_mvn_client_sends_its_runners_reports.py`,
  `test_rust_client_sends_its_runners_reports.py`, `test_gated_run_bracket_lives_once_and_refused_runs_post_nothing.py`,
  `test_cr054_fleet_inventory.py` and the others a census at RED lists) read the shared modules — `_crucible_axi.py`
  and `_crucible_run.py` — extended, never exempted. The tests that patch a moved function on the core so that a
  moved caller sees it are re-pointed at the run module. Each such test change is its own commit.

### §S2 — one run emitter

`_crucible_run.py` gains `emit_run_axi`: the `run:` block from `filed_run(resp)` (`passed`, `failed`, `pending`,
`total`, `files`, each an int or null), the answer's `error`, the answer's `warnings[]` joined after the caller's,
`help` from the caller's steps or the verb's `HELP_STEPS` entry, the caller's extra result fields, and, when asked,
the answer's coverage percents — emitted through the caller's envelope context and emit function. Each client's
emitter is one call of it: bun's and python's `_emit_ingest_axi`, maven's and rust's `_emit_run_axi`, each keeping
its name and its callers.

### §S3 — the transport answers a dropped connection

`http_request` answers `ConnectionError` and `http.client.HTTPException` as `{ok: false, error}`, the error naming
the failure and the board (`connection lost: <kind> … (is Crucible at <board> reachable? …)`), after the handlers it
has. The shared ingest then reports the run as any unreachable board: one `ingest:` line with no figures, the open
run's abort attempted (and `run-left-open` when the abort cannot reach the board either), and a gate names the
suite `gate-suite-unreported`.

### §S4 — close-out

The provenance floor `PROSE_CITATIONS.clients.head` (`tests/project-namespace-tripwire.test.ts`) moves by the CR
literals the clients' replaced emitter docstrings carried (moving a block between two files under `clients/` moves
none): one re-record, in its own commit at the close-out.

## Acceptance criteria

- [ ] **AC1 — headroom.** `_crucible_axi.py` and `_crucible_run.py` are each under 10,000 lines by the guard's count,
      `_crucible_axi.py` no longer than 9,100, and `tests/citations-cite-by-symbol.test.ts` passes.
- [ ] **AC2 — the split is invisible.** Every name `_crucible_run.py` defines is an attribute of the loaded core
      module; a census asserts that each client calls none of them except through `_axi()`; a test that patches a
      core name the moved code uses (`post_ingest`) sees the moved caller (`ingest_reports`) reach the patch; two
      clients loaded in one process each get their own run-module instance.
- [ ] **AC3 — it ships.** `crucible_axi/install.py` lays `_crucible_run.py` down beside the clients, and an installed
      client runs a verb that reaches the run module (`test_crucible_axi_wheel_packaging.py` extended).
- [ ] **AC4 — one emitter.** `_crucible_run.py` defines `emit_run_axi`; bun's and python's `_emit_ingest_axi` and
      maven's and rust's `_emit_run_axi` each have one statement besides an optional docstring, a call of
      `_axi().emit_run_axi`; their envelopes are unchanged (each client's existing envelope tests pass unedited).
- [ ] **AC5 — a dropped connection is answered.** `http_request` against a server that closes the connection after
      reading the request, and against one that sends a truncated body, answers `{ok: false, error}` naming the
      board, with no exception; a non-JSON body still raises. Through each client against a board that drops the
      connection at the ingest POST: bun, python, maven and rust print one `ingest:` line with no figures, an
      envelope with null figures and the error, exit 1, no traceback; arduino (still on `/api/v2/runs/parsed` until
      CR-CRU-220) prints its envelope `ok: false` naming the board, exit 1, no traceback; and a `pre-merge-gate`
      whose suite's POST was dropped names it `gate-suite-unreported` and is not green.
- [ ] **AC6 — nothing else changes.** The full gate (bun and python suites) passes with no test's assertion edited
      beyond what reads a moved definition's file or patches a moved function.
- [ ] **AC7 — the citation floor (close-out).** `PROSE_CITATIONS.clients.head` is re-measured at the close-out and
      re-recorded once, in its own commit, by exactly the measured delta.

## Non-goals

- Raising `BARE_LINE_IMPLAUSIBLE_THRESHOLD`.
- Moving any other block of `_crucible_axi.py`.
- Moving the arduino client onto the shared ingest, and `junit_case_sources` (CR-CRU-220).
- Catching a bare `OSError`, or a non-JSON response body.
