# CR-CRU-212 — every client's regression runs the whole suite without coverage unless asked

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(requested by Model B, Sandesh #1492; user ruling 2026-10-28: delivered in 0.4.0, sequenced straight after
CR-CRU-211; gap analysis pending)

## Problem

Model B fixes how wide each phase agent's test runs are (CR-MDB-083, its release 1.0.0): RED, GREEN and
FIX run only their own tests; **VERIFY runs the whole suite without coverage**, as an independent
cross-check; the orchestrator's pre-merge gate stays the only coverage run. Model B writes one VERIFY
verb per stack from what the clients provide, and today the fleet does not give it one uniform answer:

- **python, bun, arduino** — `regression` without `--coverage` runs the whole suite as the `regression`
  tier, with no coverage. This is the shape wanted.
- **maven** — `regression` has no `--coverage`; it takes `--coverage-profile`, falls back to
  `CRUCIBLE_COVERAGE_PROFILE` from the project's `.env`, and whenever the run has no failure it collects
  `jacoco.csv` regardless (`_regression_run`). A project whose build always runs JaCoCo publishes
  coverage from every regression, so a VERIFY run cannot be promised coverage-free.
- **rust** — there is no `regression` verb. `workspace-regression` always runs under llvm-cov;
  the whole-workspace run without coverage is `smoke-test`, a verb named for the gate.

## Design (proposed — to be settled at gap analysis)

- **One rule for the fleet: `regression` runs the whole suite without coverage unless `--coverage` is
  given**, filed as the `regression` tier.
- **maven**: `regression` gains `--coverage`; without it, no coverage profile is applied and no
  `jacoco.csv` is collected or sent; with it, today's profile resolution applies (`--coverage-profile`,
  else `CRUCIBLE_COVERAGE_PROFILE`).
- **rust**: gains `regression` — the whole workspace under nextest, without coverage unless `--coverage`
  (then today's `workspace-regression` path). `smoke-test` and `workspace-regression` keep working.
- **The gate is unchanged**: each `pre-merge-gate` still measures coverage, so it asks for it
  explicitly where its regression step relies on a default.

Open for the gap analysis: whether rust's `regression` replaces or wraps `workspace-regression`; maven
projects whose build enables JaCoCo by itself (the client can stop sending coverage, not stop the build
writing it); and the help and docs that describe `regression` as the orchestrator's coverage run.

## Acceptance criteria (draft — fixed at gap analysis)

- [ ] **AC1** For each of the five clients, `regression` without `--coverage` files a `regression` run
  with no coverage, even where the project would produce coverage data.
- [ ] **AC2** For each of the five clients, `regression --coverage` files the run with coverage, as the
  coverage run does today.
- [ ] **AC3** rust's `regression` exists and runs the whole workspace; maven's `regression` takes
  `--coverage`.
- [ ] **AC4** Each client's `pre-merge-gate` still files coverage.

## Non-goals

- Narrowing a phase agent's own run (each client's targeted flags; arduino's is CR-CRU-211).
- Role-gating any run verb: the board refuses no run verb by role.

## Release notes

- Every client's `regression` runs the whole suite without coverage unless `--coverage` is given: maven
  gains `--coverage`, rust gains `regression`. The pre-merge gate still measures coverage.
