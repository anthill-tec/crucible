# CR-CRU-212 — every client's regression runs the whole suite without coverage unless asked

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(requested by Model B, Sandesh #1492; user rulings 2026-10-28: delivered in 0.4.0, sequenced after
CR-CRU-211; a coverage-only flag given without `--coverage` is refused; settled at gap analysis)

## Problem

Model B fixes how wide each phase agent's test runs are (CR-MDB-083, its release 1.0.0): RED, GREEN and
FIX run only their own tests; **VERIFY runs the whole suite without coverage**, as an independent
cross-check; the orchestrator's pre-merge gate stays the only coverage run. Model B writes one VERIFY
verb per stack from what the clients provide, and today the fleet does not give it one uniform answer.

Every client has a `regression` verb (CR-CRU-111's tier registrar gives it to all five), filed as the
`regression` tier:

- **bun, python, arduino** — `regression` adds coverage only with `--coverage`, and each client's
  pre-merge gate asks for it (`coverage=True` in the gate's regression arguments). This is the shape
  wanted.
- **maven** — `regression` has no `--coverage`. It applies `--coverage-profile`, else
  `CRUCIBLE_COVERAGE_PROFILE` from the project's `.env`, and whenever the run has no failure it
  collects and sends `jacoco.csv` regardless of either (`_regression_run`). A project whose build runs
  JaCoCo by itself publishes coverage from every regression, so a VERIFY run cannot be promised
  coverage-free.
- **rust** — `regression` is `workspace-regression` under another name: it always runs
  `cargo llvm-cov … nextest` over the workspace (`cmd_workspace_regression`). The only whole-workspace
  run without coverage is `smoke-test`, a verb named for the gate and filed under another tier.

## Design (user rulings, 2026-10-28; settled at gap analysis)

- **One rule for the fleet: `regression` runs the whole suite as the `regression` tier, without
  coverage unless `--coverage` is given.** bun, python and arduino already follow it, unchanged.
- **maven:** `regression` gains `--coverage`. Without it, no coverage profile is applied — neither
  `--coverage-profile` nor `CRUCIBLE_COVERAGE_PROFILE` — and no `jacoco.csv` is collected or sent, even
  where the build writes one. With it, today's coverage run: `--coverage-profile`, else
  `CRUCIBLE_COVERAGE_PROFILE`, and `jacoco.csv` on a run with no failure.
- **rust:** `regression` without `--coverage` runs the whole workspace under nextest with no llvm-cov
  and no `cargo clean` — the same nextest selection the coverage run wraps (`--all-features` /
  `--features`, `--profile`) — filed as `regression`. With `--coverage`, today's
  `workspace-regression` path. `workspace-regression` and `smoke-test` are unchanged.
- **A coverage-only flag without `--coverage` is refused** (user ruling) before anything runs or
  reaches the board — maven's `--coverage-profile`; rust's `--lcov-output`, `--ignore-run-fail`,
  `--min-free-g` and `--keep-target` — with one `ok:false` envelope naming the flag and that it applies
  only with `--coverage`, exit non-zero.
- **Every pre-merge gate still measures coverage**: maven's gate asks for it explicitly (`coverage`
  in its regression arguments, beside the profile it already passes); rust's gate runs
  `workspace-regression`, unchanged; bun's, python's and arduino's already ask.
- **Model B's skills** describe `regression` as the coverage run for maven and rust; per user ruling,
  the change is announced in the release notes and the Model B notice — including the correction that
  rust's `regression` already exists and changes, rather than being added.

## Steps

### §S1 — maven's regression is coverage-free unless asked

`--coverage` on `regression`; no profile and no JaCoCo without it; the gate asks for it; the
`--coverage-profile` refusal (AC1, AC3, AC4, AC5).

### §S2 — rust's regression is coverage-free unless asked

The nextest run without `--coverage`; today's path with it; the refusals (AC2, AC3, AC4, AC5).

### §S3 — the fleet's help says so

Each client's `regression --coverage` help and its root help line state that coverage is opt-in
(AC6).

## Acceptance criteria

- [ ] **AC1** maven: `regression` without `--coverage`, over a project whose `.env` sets
  `CRUCIBLE_COVERAGE_PROFILE` and whose build writes `jacoco.csv`, runs maven with no coverage profile
  and files a `regression` run with no coverage.
- [ ] **AC2** rust: `regression` without `--coverage` runs `cargo nextest run` over the workspace (no
  `llvm-cov`, no `cargo clean`), passing the given `--all-features`/`--features` and `--profile`, and
  files a `regression` run with no coverage.
- [ ] **AC3** For each of maven and rust, `regression --coverage` files the run with coverage, as the
  coverage run does today (maven: the profile from `--coverage-profile`, else
  `CRUCIBLE_COVERAGE_PROFILE`; rust: llvm-cov's lcov).
- [ ] **AC4** For each of the five clients, `pre-merge-gate` still files coverage on a green run.
- [ ] **AC5** maven `regression --coverage-profile X`, and rust `regression` with `--lcov-output`,
  `--ignore-run-fail`, `--min-free-g` or `--keep-target`, each without `--coverage`, are refused before
  anything runs: one `ok:false` envelope naming the flag and `--coverage`, exit non-zero, nothing sent
  to the board.
- [ ] **AC6** Each of the five clients' `regression --help` lists `--coverage` and says the run is
  coverage-free without it; bun's, python's and arduino's `regression` runs without `--coverage`
  file no coverage, as today (GREEN-GUARD).

**Test re-targeted (sanctioned by this spec):** `clients-rust-mvn-crucible.test.ts`'s maven
"'regression' tier … coverage attached" test passes `--coverage`, since a regression without it now
attaches none.

## Non-goals

- Narrowing a phase agent's own run (each client's targeted flags; arduino's is CR-CRU-211).
- Coverage of a suite another stack's client runs for a composed gate (bun's gate dispatches the python
  suite's `regression` without `--coverage`, as today).
- Role-gating any run verb: the board refuses no run verb by role.

## Release notes

- Every client's `regression` runs the whole suite without coverage unless `--coverage` is given:
  maven gains `--coverage` (and no longer sends JaCoCo coverage without it); rust's `regression` runs
  plain nextest without it (llvm-cov with it). A coverage-only flag given without `--coverage` is
  refused. Every pre-merge gate still measures coverage.
