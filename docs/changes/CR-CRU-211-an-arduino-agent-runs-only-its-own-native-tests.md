# CR-CRU-211 — an arduino agent runs only its own native tests

**Type** feature · **Points** 3 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(requested by Model B, Sandesh #1489; user ruling 2026-10-28: delivered in 0.4.0, sequenced straight after
CR-CRU-210; gap analysis pending)

## Problem

Model B narrows the test runs its RED, GREEN and FIX agents make (CR-MDB-083, its release 1.0.0): a
phase agent runs its own tests by name, VERIFY the wider net, and only the orchestrator's pre-merge gate
runs the whole suite. Every other client can already narrow a run — python `--tests` down to one
method, rust `--crate` with `--test`/`--filter`, maven `--test Class#method` and `--module`, bun
`--tests <file>` and `--name`.

`arduino-crucible.py` cannot. Its `test` and `unit` verbs take only `--dir`, and run the native host
suite as `make junit` (or `make junit-<tier>`) in that directory, so an arduino agent can only run a
whole tier. Model B's arduino stack therefore ends its GREEN and FIX phases on the full native suite,
and keeps that step until this client gap closes.

The client already hands the project's Makefile one declared variable, `REPORTS_DIR` (the documented
`make` contract), and warns when a Makefile ignores it (`makefile-ignored-reports-dir`).

## Design (proposed — to be settled at gap analysis)

- **A narrowing flag on the arduino run verbs**, named as python's is (`--tests`), taking the test
  files or test names to run.
- **Passed through the `make` contract**: a second declared variable beside `REPORTS_DIR`, documented
  with it, which the project's Makefile uses to build and run only the named tests. The run is ingested
  as today.
- **A Makefile that ignores it is named**: the client warns, as it does for an ignored `REPORTS_DIR`,
  when the run reported tests outside what was asked for.

Open for the gap analysis: the variable's name and value form (file names, Unity test names, or both);
how an ignored filter is detected from the reports; which verbs take the flag (`test`, `unit`, the tier
verbs); and what the gate does (it never narrows).

## Acceptance criteria (draft — fixed at gap analysis)

- [ ] **AC1** `arduino-crucible.py test --tests <name>` and `unit --tests <name>` hand the named tests
  to `make` through the declared variable, and the run filed holds only those tests.
- [ ] **AC2** A Makefile that ignores the variable produces a run holding other tests too, and the
  envelope warns, naming the variable.
- [ ] **AC3** Without `--tests`, the verbs run exactly as today.
- [ ] **AC4** The `make` contract's documentation names the new variable beside `REPORTS_DIR`.

## Non-goals

- Narrowing the pre-merge gate: the gate runs the whole suite.
- Changing how a narrowed run is ingested.

## Release notes

- `arduino-crucible.py test`/`unit --tests` run only the named native tests, through a declared `make`
  variable; a Makefile that ignores it is named in a warning.
