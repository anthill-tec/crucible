# CR-CRU-255 — a gate whose only run fails answers not ok

**Status:** PENDING · filed 2026-11-14 (user ruling: raise the candidate CR found at CR-CRU-222's VERIFY 928, Sug4) ·
gap analysis 2026-11-21 (`test-reports/work/cr255-gap-analysis.md`); rulings: mechanism (c), the mvn duplicate folded
in, re-scored 3 → 5 · spec pre-review 2026-11-21 (`test-reports/work/prereview255-report.md`, CHANGES, F1–F12 folded)
**Type:** fix
**Points:** 5
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** clients, gate, shared-module
**Design reference:** CR-CRU-112 (the gate covers every declared suite; a composed gate answers `ok: false` and
`gate-suite-failed` on a red suite); CR-CRU-222 (the bun gate's whole-suite step runs the marked entry);
`test-reports/work/cr255-survey-report.md` (file:line evidence)

## Problem

A `pre-merge-gate` on a project that declares no suites runs one thing: its stack's whole-suite regression. This
"lone" run is the gate's whole answer, and its envelope is the gate's.

- **Where `ok` comes from.** The envelope is written inside the run body, by the shared filed-run emitter
  (`emit_run_axi`), before the shared composition (`gate_regression`) gets control back. On a filed run, its `ok`
  is the board's ingest answer: the run was filed, not that it passed.
- **What a red lone run answers.** When that one run is red, the gate answers:
  - `ok: true`;
  - exit 1;
  - the "fix the N failing test(s)" help.
- **The inconsistency.** A composed gate (a project that declares suites) answers the same red run `ok: false`, with a
  `gate-suite-failed` warning. So the same failure reads two ways, depending on whether the project declares suites.
  A reader that trusts `ok` passes a failing gate.

Measured at CR-CRU-222's VERIFY (`test-reports/work/verify928-report.md`, check 3 and run C2): the bun gate with a lone
red whole-suite run answers `ok: true` and exit 1. Every client's filed run is emitted the same way, so all six gates
answer like this. Python's gate is always lone, because python cannot enumerate declared suites.

The run verbs themselves (`regression`, `test`, the tier verbs) answer `ok` as "filed". Rust's `smoke-test` is the
exception: it uses its exit as its verdict.

## Design

- **A gate's verdict is the gate's, not its run's.** When the gate's whole answer is its one whole-suite run, a filed
  run that failed answers `ok: false`. "Failed" means failed tests, or a stream that was cut short. The board already
  folds a non-zero runner exit into a filed failure. A green, filed run answers `ok: true`, as today.
- **The composed gate's own rule and words.** The lone verdict is the composed gate's rule (`_run_outcome`), worded by
  the composed gate's whole-suite warning, `gate-suite-failed`: "the whole STACK suite this gate ran FAILED: N of M
  test(s) failed (exit E)".
- **Mechanism: shared state; one client edit, mvn's (§S2).**
  - `gate_regression` marks its lone call, the call it makes when the project declares no suite. The mark is a core
    global beside `_gate_suite_results`, carries the stack, is set in a `try/finally` around the lone call, and is also
    cleared by `forget_ingested_run`. It is never an environment variable: a suite dispatched to another stack runs
    in its own process and must not see it.
  - While the mark is set, the shared filed-run emitter (`emit_run_axi`, in `_crucible_run.py`) applies the verdict.
    The verdict helper lives in `_crucible_run.py`, beside the emitter, and keeps the core's headroom.
  - A composed gate never sets the mark, and neither does a run verb, so their answers cannot change.
- **Exit and help unchanged.** The exit stays the run's: 1 on failure. The emitter derives the same exit as
  `verb_exit(0, response)`, because the board folds a non-zero `runnerExit` into a filed failure. The help stays the
  run's next step. It is chosen from the exit, and the only branch that reads `ok` (`emit_axi`'s unknown-project
  swap) fires only on a run that was not filed, a case this CR does not change.
- **The run verbs are unchanged.** `regression`, `test` and the tier verbs keep `ok` as they answer it today.

## Steps

### §S1 — the lone run's verdict

While the mark is set, the emitter applies the rows below in order. The first row that matches decides.

| The filed lone run | `ok` | Warnings |
|---|---|---|
| not filed | `false` (unchanged) | its existing warnings, unchanged (see AC3); never `gate-suite-failed` |
| filed, no counts | `false` | its existing warnings; when they hold no `gate-suite-unreported` (go), one is added, worded by `_run_outcome` ("… reported no run counts (exit E) …") |
| filed, `failed > 0` or `stream-incomplete` | `false` | one `gate-suite-failed`, worded by `_whole_suite_warning`: "the whole STACK suite this gate ran FAILED: F of T test(s) failed (exit 1)" |
| filed, green | `true` (unchanged) | none added |

These are unchanged:

- the run's figures;
- its `events`;
- its exit;
- its help.

A lone run that files nothing emits no envelope, and that stays so: arduino's agentless gate returns the runner's exit
with no envelope.

### §S2 — mvn's gate flag answers only for its own case

The mvn run body adds `gate-suite-unreported` ("RAN, and was not filed…") whenever `verb != "regression"`. That is
also true of a composed mvn gate's whole-suite run. The composition adopts the body's warning and then adds its own,
which is worded differently ("reported no run counts"). So both survive, and the warning appears twice.

The pre-review confirmed this by reading the code (`mvn-crucible.py:1560-1567`; `_crucible_axi.py:7164-7169`,
`:7263`). Only mvn does it: bun, rust and arduino key on `name_unfiled`, python is always lone, and go's body never
adds the warning.

**The fix:**

- mvn's gate passes `whole_suite_alone=lambda: cmd_regression(..., name_unfiled=True)`, as bun, rust and arduino do;
- its body keys `gate-suite-unreported` on `name_unfiled`;
- its `help_steps` stay keyed on the verb.

RED proves the duplicate first. If it is not reproduced, the finding is recorded and §S2 is withdrawn with the user's
ruling.

### §S3 — the words

- **The CHANGELOG.** `CHANGELOG.md` opens `## [Unreleased]` with an `### Upgrading` entry. It says:
  - a gate whose only run fails now answers `ok: false` with `gate-suite-failed`, in every client;
  - its exit and help are unchanged;
  - a stack file that reads the exit sees no difference, and one that reads `ok` now sees the failure.
- **The release notes** to Model B name it as a gate-contract change, in the same words.
- **The docstring.** `gate_regression`'s docstring says six gates, not five.

## Acceptance criteria

- [ ] **AC1 — a lone red run fails the gate.** In each of the six clients, take a gate on a project that declares no
  suites, whose whole-suite run files with one failing test. It answers:
  - `ok: false`;
  - exit 1;
  - the run's own help;
  - exactly one `gate-suite-failed`, reading "the whole STACK suite this gate ran FAILED: 1 of N test(s) failed
    (exit 1)", with the client's whole-suite label.

  The test extends the six-client integration fixture in
  `test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close.py`, with one body per client: each client's
  default lone body. Bun's lone red gate is new there.
- [ ] **AC1b — a lone run cut short fails the gate.** A lone filed run carrying `stream-incomplete` with no failed test
  answers `ok: false` and exit 1, with one `gate-suite-failed` reading "… FAILED: 0 of N test(s) failed (exit 1)".
  This is proven in one streaming client.
- [ ] **AC2 — a lone green run passes.** The same gate with a green run answers `ok: true` and exit 0, with no
  `gate-suite-failed`, as today.
- [ ] **AC3 — a lone unfiled run keeps its answer.** A lone run that the board refuses, or never receives, answers
  `ok: false` with its `error` and its existing warnings, unchanged:

  | Client | Existing warnings |
  |---|---|
  | bun, python, mvn | `gate-suite-unreported` |
  | arduino, rust | `ingest-failed` and `gate-suite-unreported` |
  | go | `ingest-failed` |

  It never carries `gate-suite-failed`.
- [ ] **AC3b — a lone filed run with no counts fails the gate.** It answers `ok: false` with exactly one
  `gate-suite-unreported`. In bun, python, mvn, arduino and rust that is the body's existing warning. In go it is the
  added one, worded by `_run_outcome`. This is proven against a fake board that files with no counts.
- [ ] **AC4 — the composed gate is unchanged.** A gate on a project that declares suites answers exactly as today,
  green and red. A composed red mvn gate carries exactly one `gate-suite-failed`.
- [ ] **AC4b — mvn's composed unfiled run.** A composed mvn gate whose whole-suite run is not filed carries exactly
  one `gate-suite-unreported` (§S2).
- [ ] **AC5 — the run verbs are unchanged.** In each of the six clients, `regression` with a red run still answers
  `ok: true` (filed) and exit 1. These are new pins; none exists today.
- [ ] **AC5b — the mark is scoped.** A unit test, with no process, socket or wait, proves that the mark:
  - is set only during `gate_regression`'s lone call;
  - is unset after that call returns, raises, or raises `SystemExit`;
  - is never set on the composed path;
  - is cleared by `forget_ingested_run`.
- [ ] **AC6 — the shared modules stay within budget.** `_crucible_axi.py` stays at most
  `CORE_LINE_LIMIT − CORE_HEADROOM_LINES` lines. All three `SHARED_MODULE_LINE_BUDGETS` copies (the arduino, mvn and
  rust integration tests) record the new counts of `_crucible_axi.py` and `_crucible_run.py`.
- [ ] **AC7 — the words.** The CHANGELOG entry and the docstring say what §S3 says.

## What the 5 points cover

- the six AC1 pins and the six AC5 pins;
- the AC1b case;
- the AC3b fake-board case;
- the mvn composed-unfiled fixture (AC4b);
- the mark's unit test (AC5b);
- the core helper and mark, and the mvn flag.

## Invariants

- **A lone red run already records `outcome=fail` on the gate milestone in all six clients** (`record_gate_outcome`,
  pinned by `test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close.py`). That stays as it is.
- **An unfiled run never carries `gate-suite-failed`.**

## Non-goals

- Changing what `ok` means on a run verb.
- Changing the gate milestone.
