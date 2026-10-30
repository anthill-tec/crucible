# CR-CRU-221 — the shared client module is split, its run emitter is shared, and a reset board is answered

**Type** refactor · **Points** 13 (re-scored at its gap analysis, 8 → 13) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-206, CR-CRU-218 · **Status** PENDING — filed 2026-10-30 (user ruling at CR-CRU-206's spec pre-review, F9:
split `clients/_crucible_axi.py` in its own CR, ahead of CR-CRU-220); widened 2026-10-30 (user ruling at CR-CRU-206's
VERIFY: its F1, a connection reset at the ingest, and its F2, the run emitter written once per client, join this
CR); gap analysis 2026-10-30 (user rulings: the run and ingest pipeline moves; the core re-exports it; the transport
answers connection-level errors); spec pre-review 2026-10-30 (CR-CRU-221-SPEC-REVIEW, F1–F14 folded; user rulings:
the gated-run bookkeeping stays in the core; a run the board may hold says so; a truncated error body is answered;
one CR at 13). The file keeps its first slug.

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
3. **A dropped connection escapes the transport** (CR-CRU-206 VERIFY F1, CR-CRU-219 VERIFY F3; present in every
   client before either). `http_request` answers `HTTPError`, `URLError` and a read `TimeoutError` as
   `{ok: false, error}`. `urllib` wraps only the request's send in a `URLError`; a board that drops the connection
   while answering raises out of `http_request` unwrapped — `http.client.RemoteDisconnected` (a
   `ConnectionResetError`) when it closes after reading, `ConnectionResetError` on a reset, `IncompleteRead` on a
   truncated body, `BadStatusLine` on a garbled status — and so does a truncated body read inside the `HTTPError`
   handler. The verb ends `verb-failed`: no `run:` block, no `ingest:` line, the open run left as it was. A gate
   whose declared suites compose catches `OSError` per suite, so a reset there is already named
   `gate-suite-unreported`, but `IncompleteRead` and `BadStatusLine` (not `OSError`) end that gate too. The exit is
   1, so nothing reads as green, but the envelope does not say what happened.

## Design (user rulings 2026-10-30)

- **The run and ingest pipeline moves** into a new sibling module, `clients/_crucible_run.py`: the block of
  `_crucible_axi.py` from its `unit`-run wall-versus-CPU section (`UNIT_RUN_WALL_EXCEEDS_CPU_CODE`, `ChildRunTiming`)
  through `run_streamed` — narration (`RunNarrator`, `narration_poster`, `close_narration`), the run lifecycle
  (`open_run`, `abort_run` and their warnings), the ingest (`junit_testcase_count`, `junit_non_skipped_count`,
  `ingest_reports`, `_print_ingest_line`, `filed_run`, `coverage_not_measured_warning`, `ran_nothing`,
  `runner_exit_code`, `verb_exit`, `filed_summary`, `emit_ran_nothing`), the abandon trap (`RunAbandoned`,
  `AbandonTrap`, `abandon_trap`, `_emit_abandoned`, `emit_bracket_abandoned`, `emit_run_abandoned`) and the runner
  group (`run_streamed`). Every growth this wave brings — the lifted emitter, CR-CRU-220's `junit_case_sources` —
  lands there.
- **The gated-run bookkeeping stays in the core** (user ruling, pre-review F1): `_gated_trap`, `_gated_open_run`,
  `_gated_held`, `_note_gated_run`, `_settle_gated_run` and `_abort_gated_run` stay beside `gated_run`, which
  rebinds the two globals; the moved `open_run`, `abort_run` and `_emit_abandoned` reach them through the core. The
  rule: module state lives in the same module as every function that rebinds it.
- **The core re-exports it.** `_crucible_axi.py` loads `_crucible_run.py` by path from its own directory, at the moved
  block's place and eagerly, under a name derived from its own (`f"{__name__}_run"`), so each client's core instance
  loads its own run module. After loading, it binds the run module to a live view of its own namespace, through which
  the run module reaches every core name (`post_ingest`, `emit_axi`, `HELP_STEPS`, the gated-run bookkeeping, …) at
  call time, so a test that patches a core name still reaches the moved code. The core assigns explicitly each moved
  name it uses itself, and re-exports the rest by name: no client changes, `_axi().ingest_reports` and a test's
  `axi.<name>` keep working. A call between two moved functions resolves in the run module.
- **The run emitter is lifted once,** into the run module, and the four clients' emitters become one-call delegators,
  as `_file_reports` is (CR-CRU-218); each client still builds its envelope context, so the context's cycle echo stays
  in the client.
- **The transport answers connection-level errors:** `ConnectionError` (reset, aborted, refused, broken pipe —
  `RemoteDisconnected` among them) and `http.client.HTTPException` (`IncompleteRead`, `BadStatusLine`) become the
  fleet's `{ok: false, error}` naming the board, as a `URLError` does, and so does an `HTTPError` whose body cannot
  be read in full (user ruling, F8). A bare `OSError` is still not caught (CR-CRU-126's ruling), and a non-empty body
  that is not JSON still raises.
- **A run the board may hold says so** (user ruling, F7). A dropped connection is ambiguous: the board may have filed
  the run before the connection dropped. When an ingest whose connection was lost tries to abort the open run and the
  board refuses the abort because the run is already settled, the envelope says the board filed the run before the
  connection dropped and names how to read it back (`run <id>`, `runs --cycle <id>`); the figures stay null, since
  the client never saw the answer.
- Apart from the dropped connection's answer, behaviour does not change: every client verb, envelope and exit reads as
  before.

## Steps

### §S1 — the split

- `clients/_crucible_run.py` holds the block the Design names, less the gated-run bookkeeping, unchanged in body except
  where it reaches a core name, which it does through its bound view of the core. It imports only the standard
  library.
- `_crucible_axi.py` loses the block (about 1,000 lines) and gains the loader, the binding and the re-export; it drops
  the imports only the moved code used (`resource`, `xml.etree.ElementTree`).
- `crucible_axi/install.py`'s list of the files laid down beside the clients gains `_crucible_run.py`, with its reason
  (the core reads it by file path from its own directory); the wheel already ships `clients/` whole.
- The tests that read `_crucible_axi.py`'s source for a definition that moves read the shared modules —
  `_crucible_axi.py` and `_crucible_run.py` — extended, never exempted
  (`test_a_runs_ingest_helpers_live_once_in_the_shared_module.py`'s defined-once scan among them). The tests that copy
  part of the fleet to run it copy the run module too (`test_a_clients_board_is_its_projects_configuration.py`,
  `test_no_suite_resolves_the_checkout_configuration.py`, `test_client_limits_resolve_from_configuration.py`,
  `test_client_fleet_envelope_census.py`). The fleet's file-set tests name it (`test_cr090_fleet_stage.py`'s
  `EXPECTED_FLEET_FILES` and `SHARED_MODULE_LOADERS`, `test_cr090_cli_install_integration.py`,
  `test_crucible_axi_wheel_packaging.py`'s `EXPECTED_CLIENT_PAYLOAD`, and the TS
  `clients-never-self-register-a-project.test.ts` and `milestone-vocabulary-has-one-source.test.ts` reading sites).
  `test_cr054_drift_guard.py`'s client sources exclude both shared modules. The maven and rust `SHARED_MODULE_LINE_BUDGET`
  pins become one budget per shared module, each its module's size at the close of this CR, re-recorded once. Each such
  test change is its own commit, and a census at RED lists them.

### §S2 — one run emitter

`_crucible_run.py` gains `emit_run_axi(verb, resp, context, emit_fn, *, ok, help_steps, warnings, fields, coverage)`:
the `run:` block from `filed_run(resp)` (`passed`, `failed`, `pending`, `total`, `files`, each an int or null), `help`
from the caller's steps or the verb's `HELP_STEPS` entry, the caller's extra fields after `help`, the answer's coverage
percents when asked, the answer's `error`, and the answer's `warnings[]` joined after the caller's — emitted through the
caller's context and emit function, key for key as the four emitters emit today (bun's `runId` and `script` when
truthy, its `name` when not `None`). Each client's emitter is one statement besides its docstring, `return
_axi().emit_run_axi(verb, resp, _axi_context(project_dir, agent_id=agent, cycle_id=_axi().echoed_cycle_id(resp)),
_emit_axi, …)`: bun's and python's `_emit_ingest_axi`, maven's and rust's `_emit_run_axi`, each keeping its name and
its callers (maven's `_emit_tier_run_axi` wrapper stays).

### §S3 — the transport answers a dropped connection

`http_request` answers `ConnectionError` and `http.client.HTTPException` as `{ok: false, error}` after the handlers it
has, the error naming the failure by its type and `repr` and the board (`connection lost: <Type>(…) (is Crucible at
<board> reachable? …)`); the `HTTPError` handler reads its body under the same guard, an unreadable body giving
`HTTP <code>: <body unreadable: <Type>>`. The shared ingest then reports the run as any unreachable board: one `ingest:`
line with no figures, and the open run's abort attempted — `run-aborted` when the board takes it; when the board refuses
it because the run is already settled, the Design's warning that the board may hold the run; `run-left-open` when the
abort cannot reach the board either.

### §S4 — close-out

The provenance floor `PROSE_CITATIONS.clients.head` (`tests/project-namespace-tripwire.test.ts`) is re-measured at the
close-out (moving a block between two files under `clients/` moves nothing; the replaced emitter docstrings and the new
module's prose may) and re-recorded once, in its own commit.

## Acceptance criteria

- [ ] **AC1 — headroom.** `_crucible_axi.py` is no longer than 9,200 lines and `_crucible_run.py` under 10,000 by the
      guard's count, and `tests/citations-cite-by-symbol.test.ts` passes.
- [ ] **AC2 — the split is invisible.** Every top-level name `_crucible_run.py` defines (its imports and its core view
      aside) is an attribute of the loaded core, and `RunAbandoned` is the same class on both; a census asserts that each
      client calls none of them except through `_axi()`; a patch of the core's `post_ingest` is reached by the moved
      `ingest_reports`; two clients loaded in one process each get their own run module; `crucible_axi/cli.py` loads the
      core and reaches the run module.
- [ ] **AC3 — the gated run still files.** A run signalled while its ingest is held inside `gated_run` is still filed
      (`test_a_run_signalled_during_its_ingest_still_gets_filed.py` passes unedited), and the gated-run bookkeeping
      (`_gated_trap`, `_gated_open_run` and the four functions) is defined in `_crucible_axi.py` and nowhere else.
- [ ] **AC4 — it ships.** `crucible_axi/install.py` lays `_crucible_run.py` down beside the clients
      (`test_cr090_fleet_stage.py`, `test_cr090_cli_install_integration.py`), the wheel carries it
      (`test_crucible_axi_wheel_packaging.py`), and a copied client loads its run module from the copy
      (`CopiedClientsActuallyRunTest` gains the probe).
- [ ] **AC5 — clean.** `ruff check --select F` is clean on both shared modules, and `_crucible_run.py` imports only the
      standard library.
- [ ] **AC6 — one emitter.** `_crucible_run.py` defines `emit_run_axi`; bun's and python's `_emit_ingest_axi` and maven's
      and rust's `_emit_run_axi` each have one statement besides an optional docstring, a `return` of
      `_axi().emit_run_axi(...)` passing the context built with `cycle_id=_axi().echoed_cycle_id(resp)`; each client's
      existing envelope tests pass unedited.
- [ ] **AC7 — a dropped connection is answered.** `http_request` against a server that closes after reading the request,
      one that resets, one that sends a truncated body, one that sends a garbled status line, and one that answers an
      HTTP error with a truncated body, answers `{ok: false, error}` naming the board, with no exception; a non-JSON body
      and a bare `OSError` still raise. Through the bun, python, maven and rust clients against a board that drops the
      connection at the ingest POST: one `ingest:` line with no figures, an envelope with null figures and the error,
      exit 1, no traceback; against a board that filed the run and then dropped the connection: the envelope says the
      board may hold the run and names `run <id>`, never `run-left-open`; through the arduino client (still on
      `/api/v2/runs/parsed` until CR-CRU-220): its envelope `ok: false` naming the board, exit 1, no traceback. A
      `pre-merge-gate` whose project declares suites (bun, python), when one suite's POST is dropped by a truncated body,
      names that suite `gate-suite-unreported` and is not green.
- [ ] **AC8 — nothing else changes.** The full gate (bun and python suites) passes with no test's assertion edited beyond
      what reads a moved definition's file, copies or lists the fleet's files, pins a shared module's line budget, or pins
      the call shape of the four emitters AC6 rewrites.
- [ ] **AC9 — the citation floor (close-out).** `PROSE_CITATIONS.clients.head` is re-measured at the close-out and
      re-recorded once, in its own commit, by exactly the measured delta.

## Non-goals

- Raising `BARE_LINE_IMPLAUSIBLE_THRESHOLD`.
- Moving any other block of `_crucible_axi.py`, or the gated-run bookkeeping.
- A patch of a moved function on the core reaching another moved function (calls between moved functions resolve in the
  run module; no test relies on it).
- Moving the arduino client onto the shared ingest, and `junit_case_sources` (CR-CRU-220).
- Catching a bare `OSError`, or a non-JSON response body.
