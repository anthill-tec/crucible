# CR-CRU-212 — every client's regression runs the whole suite without coverage unless asked

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(requested by Model B, Sandesh #1492; user rulings 2026-10-28: delivered in 0.4.0, sequenced after
CR-CRU-211; a coverage-only flag given without `--coverage` is refused, python's `--cov-source`
included; rust's coverage-free run never fails fast and keeps its disk guard; settled at gap analysis
and the spec pre-review; re-scored 5 → 8)

## Problem

Model B fixes how wide each phase agent's test runs are (CR-MDB-083, its release 1.0.0): RED, GREEN and
FIX run only their own tests; **VERIFY runs the whole suite without coverage**, as an independent
cross-check; the orchestrator's pre-merge gate stays the only coverage run. Model B writes one VERIFY
verb per stack from what the clients provide, and today the fleet does not give it one uniform answer.

Every client has a `regression` verb (CR-CRU-111's tier registrar gives it to all five), filed as the
`regression` tier:

- **bun, python, arduino** — `regression` adds coverage only with `--coverage`, and each client's
  pre-merge gate asks for it (`coverage=True` in the gate's regression arguments). But python's
  `--cov-source`, given without `--coverage`, is silently ignored.
- **maven** — `regression` has no `--coverage` (the maven `--coverage` that exists is
  `auto-ingest`'s). It applies `--coverage-profile`, else `CRUCIBLE_COVERAGE_PROFILE` from the
  project's `.env`, and whenever the run has no failure it collects and sends `jacoco.csv` regardless
  of either (`_regression_run`). A project whose build runs JaCoCo by itself publishes coverage from
  every regression.
- **rust** — `regression` is `workspace-regression` under another name: it always runs
  `cargo clean` then `cargo llvm-cov … nextest` over the workspace (`cmd_regression` →
  `cmd_workspace_regression`). The only whole-workspace run without coverage is `smoke-test`, a verb
  named for the gate and filed as `integration`.

The help says so: maven's root description reads "full regression with JaCoCo", its `regression` line
"with JaCoCo coverage"; rust's `regression` line names `cargo llvm-cov nextest`.

## Design (user rulings, 2026-10-28; settled at gap analysis and the spec pre-review)

- **One rule for the fleet: `regression` runs the whole suite as the `regression` tier, without
  coverage unless `--coverage` is given.** bun, python and arduino already run that way.
- **`--coverage` is declared once**, in the shared module (`add_regression_coverage_arg`, after
  `add_run_release_arg`'s precedent), with one sentence — the run is coverage-free without it — and the
  stack's coverage tool named; all five clients' `regression` use it.
- **maven:** without `--coverage`, no coverage profile is applied — neither `--coverage-profile` nor
  `CRUCIBLE_COVERAGE_PROFILE` — and no `jacoco.csv` is collected or sent, even where the build writes
  one. With it, today's coverage run: `--coverage-profile`, else `CRUCIBLE_COVERAGE_PROFILE`, else no
  `-P` (the build's own JaCoCo, if any, is collected), and `jacoco.csv` on a run with no failure. The
  new read is `getattr(args, "coverage", False)`, so a namespace built without it stays valid.
- **rust:** `regression` without `--coverage` runs the whole workspace under plain nextest —
  `cargo nextest run --workspace [--all-features | --features X] -P <profile> --no-fail-fast` — with no
  llvm-cov and no `cargo clean`. It is the coverage path with its coverage switched off
  (`_workspace_regression_run` gains the switch), so it keeps everything else that path does: the gate
  lock, the cycle pre-flight, `--cycle`/`--release`/`--reports` through the same gated identity, the
  strict `target/nextest/<profile>/junit.xml`, the ingest through `/api/v2/runs/parsed` with the same
  envelope (`run` and `files`) and no `coverage` key, and `tier="regression"` stated where the tier
  census accepts it. Because there is no `cargo clean`, it clears stale junit for the profile before
  the run. It keeps the disk guard on an `--all-features` build, as `smoke-test` does, so
  `--min-free-g` applies to both paths. With `--coverage`, today's path. `workspace-regression`,
  `smoke-test` and the pre-merge gate are unchanged.
- **A coverage-only flag without `--coverage` is refused** (user rulings) — maven's `--coverage-profile`;
  rust's `--lcov-output`, `--ignore-run-fail` (its nextest effect, `--no-fail-fast`, is always on in
  the plain path) and `--keep-target`; python's `--cov-source`. Rust's three default to `None` on
  `regression` so a given flag is detectable, and the coverage path resolves today's effective values
  (`target/lcov.info`, on, off). One shared refusal in the shared module — a typed hard stop with the
  code `coverage-flag-refused`, handled in `run_verb` — is the verb's first act: no board request of any
  kind, no lock file, no runner (`cargo`, `mvn`, `cargo clean`) launched; one `ok:false` envelope whose
  `error` names the flag and that it applies only with `--coverage`, and whose `help[]` says to add
  `--coverage` or drop the flag; exit non-zero.
- **Every pre-merge gate still measures coverage**: maven's gate asks for it explicitly (`coverage` in
  its regression arguments, beside the profile it already passes); the other four already do.
- **The help tells the truth**: each client's root `regression` line and maven's root description say
  coverage is opt-in; `--coverage-profile`, `CRUCIBLE_COVERAGE_PROFILE`, `--cov-source` and rust's
  coverage-only flags say they apply only with `--coverage` (and in `pre-merge-gate`); the stale "the
  only coverage path" and rust's "the surface of the `workspace-regression` verb" docstrings follow.
- **Model B's skills** describe `regression` as the coverage run for maven and rust; per user ruling,
  the change is announced in the release notes and in the orchestrator's 0.4.0 notice to Model B — with
  the correction that rust's `regression` already exists and changes, rather than being added.

## Steps

### §S1 — one coverage switch and one refusal, shared

`add_regression_coverage_arg` and the `coverage-flag-refused` hard stop in the shared module; python's
`--cov-source` refusal; bun's, python's and arduino's `regression` declare `--coverage` through it
(AC5, AC6, AC7).

### §S2 — maven's regression is coverage-free unless asked

`--coverage` on `regression`; no profile and no JaCoCo without it; the gate asks for it; the
`--coverage-profile` refusal (AC1, AC3, AC4, AC5).

### §S3 — rust's regression is coverage-free unless asked

The coverage switch in `_workspace_regression_run`; the plain nextest run; the three refusals (AC2,
AC3, AC5).

### §S4 — the fleet's help says so

The root lines, maven's description and the flags' help (AC6).

## Acceptance criteria

- [ ] **AC1** maven: `regression` without `--coverage`, over an all-green project whose `.env` sets
  `CRUCIBLE_COVERAGE_PROFILE` and whose build writes `target/jacoco-report/jacoco.csv`, runs maven with
  no `-P` coverage profile and files a `regression` run whose ingest body has no `coverage` key.
- [ ] **AC2** rust: `regression` without `--coverage` runs
  `cargo nextest run --workspace [--all-features|--features X] -P <profile> --no-fail-fast` — no
  `llvm-cov`, no `cargo clean` — clearing stale junit for the profile first, and files through
  `/api/v2/runs/parsed` a `regression` run with `files` and no `coverage` key, under `--cycle` and under
  `--release` alike; an `--all-features` run is disk-guarded by `--min-free-g`.
- [ ] **AC3** For each of maven and rust, `regression --coverage` over a fixture that writes coverage
  files the run with coverage, as today (maven: the profile from `--coverage-profile`, else
  `CRUCIBLE_COVERAGE_PROFILE`, else none with the build's own `jacoco.csv` collected; rust: llvm-cov's
  lcov).
- [ ] **AC4** maven's `pre-merge-gate` still files coverage on a green run; bun's, python's, rust's and
  arduino's still do (GREEN-GUARD).
- [ ] **AC5** Refused with `coverage-flag-refused`, without `--coverage`, on `regression`: maven
  `--coverage-profile X`; rust `--lcov-output X`, `--ignore-run-fail`, `--keep-target`; python
  `--cov-source X` — each: one `ok:false` envelope naming the flag and `--coverage`, exit non-zero, no
  request to the board, no lock file, no runner launched.
- [ ] **AC6** Each of the five clients' `regression --help` lists `--coverage` with the shared
  sentence; each client's root `--help` `regression` line, and maven's root description, say coverage
  is opt-in; `--coverage-profile`, `--cov-source` and rust's coverage-only flags say they apply only
  with `--coverage`.
- [ ] **AC7** bun's, python's and arduino's `regression` without `--coverage` file no coverage, as
  today (GREEN-GUARD).

**Tests re-targeted (sanctioned by this spec):** `clients-rust-mvn-crucible.test.ts`'s maven
"'regression' tier … coverage attached" test passes `--coverage`; `test_a_run_without_agent_files_nothing`'s
rust `regression` case drops the now-refused `--keep-target` combination and its docstring stops calling
`regression` `cmd_workspace_regression`; `test_client_tier_stamping`'s `EARNED_SITES_DRIVEN_ON_THE_WIRE`
gains rust's coverage-free regression site.

## Non-goals

- Narrowing a phase agent's own run (each client's targeted flags; arduino's is CR-CRU-211).
- Coverage of a suite another stack's client runs for a composed gate (bun's gate dispatches the python
  suite's `regression` without `--coverage`, as today).
- maven's `test` and tier verbs: they never apply the profile or collect JaCoCo.
- Role-gating any run verb: the board refuses no run verb by role.

## Release notes

- Every client's `regression` runs the whole suite without coverage unless `--coverage` is given: maven
  gains `--coverage` (and no longer sends JaCoCo coverage or applies `CRUCIBLE_COVERAGE_PROFILE` without
  it); rust's `regression` runs plain nextest (`--no-fail-fast`) without it, llvm-cov with it. A
  coverage-only flag given without `--coverage` is refused (`coverage-flag-refused`). Every pre-merge
  gate still measures coverage.
