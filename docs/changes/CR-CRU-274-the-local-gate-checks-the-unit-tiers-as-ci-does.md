# CR-CRU-274: the local gate checks the unit tiers as CI does

**Status:** PENDING. Filed 2026-11-23 after CI went red twice on develop, on tests that had passed the local pre-merge
gate. The gap analysis and the user's rulings of the same day are recorded below, under "Rulings".
**Type:** maintenance
**Points:** 5
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** client, gate, ci, tiers
**Design reference:** CR-CRU-263 (`scripts/hermetic/`, the CI unit verdict); CR-CRU-254 (the gate's declared lint
stage, the pattern this stage follows); CR-CRU-270 (the hermetic switch, amended the same day to cover the gate).

## Problem

Crucible's CI runs each unit tier, bun and python, with recording hooks loaded
(`scripts/hermetic/hooks/bun-preload.ts`, `hooks/sitecustomize.py`). It then judges the log with
`scripts/hermetic/unit-verdict.py`, which fails on any spawn, connect, bind, serve, fetch or real wait
(`.github/workflows/release.yml`, the "unit tier" and "unit tier verdict" steps of `test-bun` and `test-python`).

The local pre-merge gate does neither. On 2026-11-23, CI run 45182835996 failed that verdict with four real timers in
bun unit tests that had passed the gate, and the fix (`86d77821`) came after the merge.

Two more differences showed up the same day:

- CI installs whatever uv is newest (0.13.9 that day); the workstation runs 0.11.8. The two find a project
  differently, and CI run 45200014350 failed on a test helper that only the newer uv treats as part of the project
  (`e27015d6`).
- An e2e step's route mock (`tests/e2e/steps/run-live-mock.ts:92,107`) still fetches after its scenario ends.
  Playwright fails such a scenario with "route.fetch: Test ended" (CI run 45208090918; it passed on rerun).

## Behaviour

- **S1. A declared unit-check stage.** A project may declare a `[unit-check]` table in its `crucible.toml`, the file
  that already holds `[lint]`:

  ```toml
  [unit-check]
  command = ["scripts/hermetic/unit-check.sh"]
  ```

  - `command` is a non-empty list of non-empty strings.
  - An optional `name` names the stage in the envelope; it defaults to the basename of the command's first word.
  - Any other shape is refused, naming the file and the field, before anything runs. A malformed `[lint]` table is
    refused the same way.
- **S2. Every stack's pre-merge gate runs it.**
  - Where: after the lint stage and before the regression, in the directory the lint stage runs in.
  - The stage lives once, in the shared client modules, and every stack's `pre-merge-gate` calls it, as each
    calls the lint stage.
  - Exit 0: the gate goes on.
  - Any other exit: the gate stops. Its one envelope says `stage: unit-check` with the exit, and carries the warning
    `unit-check-gate-abort` with a `help` line naming the command. The command's output goes to stderr, and the
    regression never runs.
  - `--skip-unit-check` skips the stage, as `--skip-lint` skips lint.
  - With no table declared, the stage is skipped with the warning `unit-check-not-declared`, as lint is.
  - The command runs as declared: the client adds no environment and loads no hook into its own process.
- **S3. Crucible declares it, and CI runs the same script.**
  - `scripts/hermetic/unit-check.sh [bun|python]...` runs each named unit tier (both when none is named):
    - with its recording hooks, as CI does today;
    - with its own event log in a fresh temporary directory;
    - then `unit-verdict.py` over the logs.
  - It exits non-zero when a tier fails or the verdict finds an event.
  - In `.github/workflows/release.yml`, each job's two unit steps become one step: the script, inside
    `scripts/hermetic/run.sh`, naming the job's tier. Recording and judging then have one definition.
  - This checkout's `crucible.toml` (operator state, git-ignored) gains the `[unit-check]` table at the merge. The
    RUNBOOK shows it.
- **S4. CI pins uv.** `release.yml` sets one `UV_VERSION: 0.13.9` beside `BUN_VERSION`, and every `setup-uv` step
  takes it. The workstation's uv is brought to 0.13.9 by the operator at the merge. No installer policy changes.
- **S5. An e2e route mock stops at its scenario's end.** Every scenario's teardown removes the page's routes,
  ignoring errors from those still in flight. The live-run mock's `route.fetch()` can then no longer fail a scenario
  that has already passed. No step's assertion changes.

## Acceptance criteria

- **AC1.** With a declared `[unit-check]` whose command exits 0, `pre-merge-gate` runs it after lint and goes on to
  the regression. Proven for the bun client and the python client. The stage is shared code that the other stacks
  call.
- **AC2.** With a command that exits non-zero, the gate's one envelope has `ok: false`, `stage: unit-check`, the exit
  and the `unit-check-gate-abort` warning. The command's output is on stderr. No regression run is started or filed.
- **AC3.** `--skip-unit-check` skips the stage. With no table, the gate goes on with `unit-check-not-declared`.
- **AC4.** A malformed table (`command` missing, not a list, empty, or holding an empty or non-string entry; `name`
  not a non-empty string) is refused naming the file and the field. Nothing runs.
- **AC5.** On this checkout, with the table declared, a bun unit test that arms a real timer above 0 ms stops the
  gate at `stage: unit-check`. Without that test, the stage passes. This is shown by Mainline at the gate and
  recorded in the close-out. It is not a committed test.
- **AC6.** CI's unit steps call `scripts/hermetic/unit-check.sh` inside `run.sh`, and `UV_VERSION` is pinned.
  Reviewed, not tested; the first green CI run after the merge is the evidence.
- **AC7.** Each scenario's teardown removes its routes (S5). Reviewed, and the e2e suite passes.
- **AC8.** The RUNBOOK describes the `[unit-check]` table and `--skip-unit-check`, and `CHANGELOG.md`'s
  `## [Unreleased]` has an entry.

## Non-goals

- Running the local gate hermetically (no network, empty `HOME`, tripwire). That is CR-CRU-270, amended the same
  day to give `pre-merge-gate` its switch.
- Filing the unit-check stage's result on the board as a run. The gate's envelope carries it.
- Running e2e in the gate.
- Changing `install.sh`'s policy of letting uv choose its version.

## Rulings (2026-11-23)

From the gap analysis of the same day and the user's answers:

- **Q1.** The gate gets the check as a client feature: a declared stage that every project can use. A repo script
  Mainline runs by hand was rejected, because the gate would not enforce it.
- **Q2.** CI pins uv at 0.13.9, the version it ran green on, and the workstation is brought up to match.
- **Q3.** The e2e mock fix goes inside this CR.
- **Q4.** CR-CRU-270 is amended so that `pre-merge-gate` takes the hermetic switch, and a hermetic gate runs its
  unit-check stage inside the namespace too.
- **Design constraints from the survey:**
  - the client process never loads the recording hooks, or its own spawns and its connections to the board would
    count as events (S2's last point);
  - the clients stay project-agnostic, so the hooks and the verdict are the project's declared command, never a path
    the client knows.
