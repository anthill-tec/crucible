# CR-CRU-271: the TestPyPI version check derives the version it checks

**Status:** PENDING.

- **Filed** 2026-11-22, from the CR-CRU-266 gap analysis (`test-reports/work/cr266-gap-analysis.md`, adjacent
  defect). User ruling: it is its own CR, in wave 9, after CR-CRU-266.
- **Revised** 2026-11-22 after its own gap analysis (`test-reports/work/cr271-gap-analysis.md`), with user rulings.

**Type:** maintenance
**Points:** 1
**Wave:** 9 (0.5.0)
**Depends on:** CR-CRU-266
**Labels:** release, ci

## Problem

`publish-testpypi` in `.github/workflows/release.yml` has a step named "Version sanity — reject PEP 440 local segment
('+')". TestPyPI rejects a local version, so the step exists to fail early and clearly. It never checks anything.

1. It installs only `build`, then runs `python -m build --sdist --no-isolation`. Without isolation, the build backend
   (`hatchling`, `hatch-vcs`) is not installed, so the build fails.
2. `>/dev/null 2>&1 || true` hides the failure.
3. `ls dist/*.tar.gz` then finds nothing, so `VER` is empty. An empty version holds no `+`, so the step passes.

The 0.4.0 TestPyPI log printed `derived version:` with nothing after it (`test-reports/work/rel040-testpypi3.log:181`).
A local version would still reach the upload, and fail there with a less clear error.

The step also runs before the job downloads the `dist` artifact. It could not check the files the job uploads even if
its build worked. Those files are the ones the `build` job built and checked.

## Behaviour

- **S1. The check reads the version of the artifacts it uploads.** The step runs after the `download-artifact` step
  and before the publish step, and reads the downloaded `dist/` file names. It never rebuilds them.
  - **The wheel's version** is the second `-`-separated field of its file name. The binary distribution format
    escapes `-` to `_` in every other field, so this split is unambiguous.
  - **The sdist's version** is what follows the normalised name `crucible_axi-` in `crucible_axi-<version>.tar.gz`
    (PEP 625).
- **S2. Exactly one wheel and one sdist, with one version (user ruling).** Each of these fails the step with its own
  `::error::` naming what it found:
  - no wheel, or more than one;
  - no sdist, or more than one;
  - an empty version;
  - a wheel and an sdist whose versions differ;
  - a `+` local segment. This failure keeps the existing message.
- **S3. Shell only, and no failure is hidden (user ruling).**
  - The step is plain shell. It runs no `python -m build` and installs nothing.
  - No `|| true` and no redirect to `/dev/null` remain.
  - The job no longer runs python, so it drops its `actions/setup-python` step.
  - `ci-every-python-job-sets-up-the-python-floor.test.ts` drops `publish-testpypi` from its `JOBS_THAT_RUN_PYTHON`,
    and its header comment no longer names it.
  - The job keeps its `actions/checkout`, unless the publish step does not need it. The pre-review decides.

## Acceptance criteria

- **AC1.** A bun unit test on `release.yml`'s `jobs.publish-testpypi.steps` pins:
  - the version step's order: after the `actions/download-artifact` step, and before the
    `pypa/gh-action-pypi-publish` step;
  - that its `run` holds no `|| true`, no `/dev/null`, no `python -m build` and no `pip install`;
  - that the job carries no `actions/setup-python` step.
- **AC2.** The step's shell, given a scratch `dist/`, behaves as S2 says. A bun integration test runs the step's own
  `run` text, read from `release.yml`, under `bash -e` in a temporary directory. It covers these cases:
  - **one wheel and one sdist, same version:** passes and prints `derived version: <v>`;
  - **no wheel:** fails;
  - **two sdists:** fails;
  - **mismatched versions:** fails;
  - **`+` in the version:** fails with the existing message.

  The integration test runs the shell, so it is integration. The pre-review confirms that a bun integration test may
  spawn `bash`, and names the harness.
- **AC3.** `ci-every-python-job-sets-up-the-python-floor.test.ts` no longer lists `publish-testpypi`, and passes.
- **AC4.** The 0.5.0 rehearsal's CI run on `release/0.5.0` prints the derived version and publishes to TestPyPI. This
  is checked at the rehearsal.
- **AC5.** No CHANGELOG entry: this changes CI only, and nothing a user installs. The pre-review confirms against the
  CHANGELOG's own rules.

## Non-goals

- The `build` job's own version handling.
- The publish-pypi and publish-npm jobs.
