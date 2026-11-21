# CR-CRU-255 — a gate whose only run fails answers not ok

**Status:** PENDING · filed 2026-11-14 (user ruling: raise the candidate CR found at CR-CRU-222's VERIFY 928, Sug4) ·
gap analysis 2026-11-21 (`test-reports/work/cr255-gap-analysis.md`); rulings: mechanism (c), the mvn duplicate folded
in, re-scored 3 → 5
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
- **Mechanism: shared state, no client edits.**
  - `gate_regression` marks its lone call: the call it makes when the project declares no suite.
  - While the mark is set, the shared filed-run emitter applies that verdict to the envelope it writes.
  - A composed gate never sets the mark, and neither does a run verb. So their answers cannot change.
- **Exit and help unchanged.** The exit stays the run's (1 on failure), and the help stays the run's next step. The
  help is chosen from the exit, not from `ok`.
- **The run verbs are unchanged.** `regression`, `test` and the tier verbs keep `ok` as they answer it today.

## Steps

### §S1 — the lone run's verdict

`gate_regression` marks the call it makes when the project declares no suite. While the mark is set, the shared
filed-run emitter applies the rows below, in order. The first row that matches decides.

| The filed lone run | `ok` | Warning |
|---|---|---|
| not filed | `false` (unchanged) | its existing unfiled warning, unchanged: `gate-suite-unreported` where it carries one today (go carries `ingest-failed`). Never `gate-suite-failed`. |
| filed, no counts | `false` | its existing `gate-suite-unreported` ("reported no run counts") |
| filed, failed > 0 or `stream-incomplete` | `false` | one `gate-suite-failed`, naming the whole-suite label and the counts |
| filed, green | `true` (unchanged) | none added |

These do not change:

- the run's figures;
- its `events`;
- its exit;
- its help.

The mark is cleared when the lone call returns or raises.

### §S2 — mvn's gate flag answers only for its own case

The mvn run body keys its gate-only warning on `verb != "regression"`. That condition is true for a composed mvn gate's
whole-suite run too, so a composed unfiled mvn run probably carries `gate-suite-unreported` twice: once from the body,
and once from the composition.

- RED proves or disproves this.
- If it is confirmed, the body's warning is scoped to the lone call, which the composition already names itself.
- If it is not reproduced, the finding is recorded and nothing changes.

### §S3 — the words

- **The CHANGELOG.** `CHANGELOG.md` opens `## [Unreleased]` with an `### Upgrading` entry: a gate whose only run
  fails now answers `ok: false` with `gate-suite-failed`, in every client. A stack file that reads the gate's `ok`
  sees the failure.
- **The release notes.** The release notes to Model B name it as a gate-contract change.
- **The docstring.** `gate_regression`'s docstring says six gates, not five.

## Acceptance criteria

- [ ] **AC1 — a lone red run fails the gate.** In each of the six clients, take a gate on a project that declares no
  suites, whose whole-suite run files with one failing test. It answers:
  - `ok: false`;
  - exit 1;
  - exactly one `gate-suite-failed` warning, reading "the whole STACK suite this gate ran FAILED: 1 of N test(s)
    failed (exit …)".

  The help is the run's own. A bun lone red gate gets its own test, which does not exist today.
- [ ] **AC2 — a lone green run passes.** The same gate with a green run answers `ok: true` and exits 0, with no
  `gate-suite-failed`, as today.
- [ ] **AC3 — a lone unfiled run keeps its answer.** A lone run that the board refuses, or never receives, keeps its
  existing unfiled answer and never carries `gate-suite-failed`:
  - `ok: false`;
  - `error`;
  - `gate-suite-unreported`, where it carries one today. Go carries `ingest-failed`.
- [ ] **AC3b — a lone filed run with no counts fails the gate.** It answers `ok: false` with its
  `gate-suite-unreported` warning.
- [ ] **AC4 — the composed gate is unchanged.** A gate on a project that declares suites answers exactly as today,
  green and red. A composed red mvn gate carries exactly one `gate-suite-failed`.
- [ ] **AC4b — mvn's composed unfiled run.** A composed mvn gate whose whole-suite run is not filed carries exactly
  one `gate-suite-unreported`. This applies if RED reproduces the duplicate (§S2). If not, the finding is recorded and
  this AC is withdrawn with the user's ruling.
- [ ] **AC5 — the run verbs are unchanged.** In each of the six clients, `regression` with a red run still answers
  `ok: true` (filed) and exit 1. These are new pins; none exists today.
- [ ] **AC6 — the core stays within its headroom.** `_crucible_axi.py` stays at most
  `CORE_LINE_LIMIT − CORE_HEADROOM_LINES` lines. Every `SHARED_MODULE_LINE_BUDGETS` copy records the new counts.
- [ ] **AC7 — the words.** The CHANGELOG entry and the docstring say what §S3 says.

## Invariants

- **A lone red run already records `outcome=fail` on the gate milestone in all six clients** (`record_gate_outcome`,
  pinned by `test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close.py`). That stays as it is.
- **An unfiled run never carries `gate-suite-failed`.**

## Non-goals

- Changing what `ok` means on a run verb.
- Changing the gate milestone.
