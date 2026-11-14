# CR-CRU-255 — a gate whose only run fails answers not ok

**Status:** PENDING · filed 2026-11-14 (user ruling: raise the candidate CR found at CR-CRU-222's VERIFY 928, Sug4)
**Type:** fix
**Points:** 3
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** clients, gate, shared-module
**Design reference:** CR-CRU-112 (the gate covers every declared suite; a composed gate answers `ok: false` and
`gate-suite-failed` on a red suite); CR-CRU-222 (the bun gate's whole-suite step runs the marked entry)

## Problem

A `pre-merge-gate` on a project that declares no suites runs one thing: its stack's whole-suite regression. The
shared composition (`gate_regression`) then returns that run's own envelope as the gate's answer. A run verb's
`ok` says the run was filed, not that it passed. So when that one run is red, the gate answers:

- `ok: true`;
- exit 1;
- the "fix the N failing test(s)" help.

A composed gate (a project that declares suites) answers the same red run `ok: false` with a `gate-suite-failed`
warning. The same failure therefore reads two ways depending on whether the project declares suites, and a reader
that trusts `ok` passes a failing gate.

Measured at CR-CRU-222's VERIFY (`test-reports/work/verify928-report.md`, check 3 and run C2): the bun gate with a
lone red whole-suite run answers `ok: true`, exit 1, identically on develop before CR-CRU-222. The composition is
shared by every client's gate, so every stack whose project declares no suites answers this way.

## Design

- **A gate's verdict is the gate's, not its run's.** When the gate's whole answer is its one whole-suite run, the
  gate answers `ok: false` when that run failed: tests failed, the runner exited non-zero, or the run was not filed.
  A green, filed run answers `ok: true`, as today.
- **The same warning as a composed gate.** A failed lone run carries `gate-suite-failed`, worded as the composed
  gate words it, naming the whole-suite label. A run that was not filed keeps its existing `gate-suite-unreported`
  warning and `error`.
- **Exit and help unchanged.** The exit stays the run's (1 on failure), and the help stays the run's next step.
- **One place.** The fix lives in the shared composition (`gate_regression` and the lone-run path), so all six
  clients' gates change together. No client keeps its own rule.
- **The run verbs are unchanged.** `regression`, `test` and the tier verbs keep `ok` meaning "filed".

## Steps

### §S1 — the lone run's verdict

`gate_regression`'s lone-run path (`whole_suite_alone or whole_suite`) answers through the gate's verdict rule:

- `ok: false` and `gate-suite-failed` when the filed run has failures or the runner's exit is non-zero;
- `ok: false` with the existing unreported warning and `error` when the run was not filed;
- `ok: true` otherwise.

The run's figures, its `events`, its exit and its help are unchanged.

### §S2 — the words

- The CHANGELOG gains an entry: a gate whose only run fails now answers `ok: false` with `gate-suite-failed`, in
  every client.
- The release notes to Model B name it as a gate-contract change, since its stack files read the gate.

## Acceptance criteria

- [ ] **AC1 — a lone red run fails the gate.** In each of the six clients, a gate on a project that declares no
  suites, whose whole-suite run files with one failing test, answers `ok: false`, exits 1, and carries
  `gate-suite-failed` naming the whole-suite label.
- [ ] **AC2 — a lone green run passes.** The same gate with a green run answers `ok: true`, exits 0, and carries no
  `gate-suite-failed`, as today.
- [ ] **AC3 — a lone unfiled run fails the gate.** A lone run the board refuses or never receives answers
  `ok: false` with its existing unreported warning and `error`, as today under `--no-lifecycle`.
- [ ] **AC4 — the composed gate is unchanged.** A gate on a project that declares suites answers exactly as today,
  green and red.
- [ ] **AC5 — the run verbs are unchanged.** `regression` with a red run still answers `ok: true` (filed), exit 1.
- [ ] **AC6 — the words.** The CHANGELOG entry says what §S2 says.

## Non-goals

- Changing what `ok` means on a run verb.
- The gate milestone's outcome. RED checks whether a lone red run records `fail` there; if it does not, that is
  raised with the user before GREEN, not folded in silently.
