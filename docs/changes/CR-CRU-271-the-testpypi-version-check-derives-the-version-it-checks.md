# CR-CRU-271: the TestPyPI version check derives the version it checks

**Status:** PENDING.

- **Filed** 2026-11-22, from the CR-CRU-266 gap analysis (`test-reports/work/cr266-gap-analysis.md`, adjacent
  defect). User ruling: its own CR, in wave 9, after CR-CRU-266.
- **Revised** 2026-11-22, after its gap analysis (`test-reports/work/cr271-gap-analysis.md`, with user rulings) and
  its spec pre-review (`test-reports/work/prereview271-report.md`, F1–F12).

**Type:** maintenance
**Points:** 1
**Wave:** 9 (0.5.0)
**Depends on:** CR-CRU-266
**Labels:** release, ci
**Design lineage:** this reverses CR-CRU-198's addition of `actions/setup-python` to `publish-testpypi`. Python leaves
the job. `publish-pypi` already runs the same publish action without `setup-python`: the action finds its own
python (`rel040-publish-pypi.log:232`). Unlike this job after the change, `publish-pypi` still checks out the
repository.

## Problem

`publish-testpypi` in `.github/workflows/release.yml` has a step named "Version sanity — reject PEP 440 local segment
('+')". TestPyPI rejects local versions, so the step exists to fail early and clearly. It never checks anything:

1. It installs only `build`, then runs `python -m build --sdist --no-isolation`. Without isolation the build backend
   (`hatchling`, `hatch-vcs`) is not installed, so the build fails.
2. `>/dev/null 2>&1 || true` hides the failure.
3. `ls dist/*.tar.gz` then finds nothing, so `VER` is empty. An empty version holds no `+`, so the step passes.

The 0.4.0 TestPyPI log printed `derived version:` with nothing after it (`test-reports/work/rel040-testpypi3.log:181`).
A local version would reach the upload and fail there, with a less clear error.

The step also runs before the job downloads the `dist` artifact. Even with a working build, it could not check the
files the job uploads: those come from the `build` job, which builds and checks them.

## Behaviour

- **S1. The check reads the version of the artifacts it uploads.**
  - **Name.** The step keeps the name `Version sanity — reject PEP 440 local segment ('+')`. The AC2 test finds
    exactly one step by that name.
  - **Position.** It runs after the `actions/download-artifact` step and before the `pypa/gh-action-pypi-publish`
    step.
  - **Contents.**
    - It reads the downloaded `dist/` file names and never rebuilds them.
    - Its `run` holds no `${{ … }}` expression, so a test can run it verbatim.
    - A comment above it says it reads the downloaded file names.
  - **Collecting the files.** The step runs `shopt -s nullglob`, then collects `wheels=(dist/*.whl)` and
    `sdists=(dist/*.tar.gz)` as arrays and counts them with `${#…[@]}`. It never uses `failglob`.
  - **The wheel's version.** For a name that matches `crucible_axi-*.whl`, the version is the text after
    `crucible_axi-` up to the next `-`. The binary distribution format escapes `-` to `_` in every other field, so the
    split is unambiguous. A wheel with any other name yields the empty version.
  - **The sdist's version.** For a name that matches `crucible_axi-*.tar.gz` (PEP 625), the version is the text
    between `crucible_axi-` and `.tar.gz`. An sdist with any other name yields the empty version.
- **S2. Exactly one wheel and one sdist, with one version (user ruling).** The checks run in this order:
  1. **Counts.** The wheel count and the sdist count are each checked. A count other than one emits its own
     `::error::`, naming the count and the files found. If either count is wrong, the step exits 1 after both are
     reported.
  2. **Empty versions.** A wheel or sdist with an empty version emits an `::error::` naming that file, then the step
     exits 1.
  3. **Agreement.** A wheel version and an sdist version that differ emit an `::error::` naming both, then the step
     exits 1.
  4. **The `+` check.** The agreed version containing `+` emits the existing message, word for word:
     `::error::version '<v>' contains a '+' local segment — TestPyPI rejects PEP 440 local versions`. The step then
     exits 1.
  5. **Success.** The step prints `derived version: <v>`.

  Under GitHub's `bash -e`, every check is an `if` block, never a bare `[ … ] && …` or a `((n++))`.
- **S3. Shell only, and no failure is hidden (user ruling).**
  - **The step.**
    - It is plain shell: no `python` or `pip`, and no `python -m build`.
    - No `|| true` and no redirect to `/dev/null` remain.
  - **The job.**
    - It drops its `actions/setup-python` step. Python no longer runs in it.
    - It drops its `actions/checkout` step, with its "hatch-vcs needs tags" comment. No step reads the repository,
      so a job holding `id-token: write` runs no repository code.
  - **The python-floor test.**
    - `ci-every-python-job-sets-up-the-python-floor.test.ts` drops `publish-testpypi` from `JOBS_THAT_RUN_PYTHON`.
    - Its header comment names three jobs, not four, and no longer describes `publish-testpypi`.
  - **The job's header comment.** It still says the version carries no "'+' local segment for the sanity step below
    to reject". It stays accurate, because the step keeps "sanity" in its name.

## Acceptance criteria

- **AC1. The job's shape is reviewed, not tested** (user ruling, 2026-11-22: a test's subject is production code that
  runs, never configuration text). VERIFY confirms by reading the job:
  - the step comes after the `actions/download-artifact` step and before the `pypa/gh-action-pypi-publish` step;
  - its code holds no `|| true`, no `/dev/null`, no `python` or `pip`, and no `${{`;
  - the job carries no `actions/setup-python` step and no `actions/checkout` step.
- **AC2. A bun integration test runs the step itself.**
  - **File:** `tests/integration/release-testpypi-version-check.test.ts`.
  - **Harness:** modelled on `tests/integration/release-notes-extractor.test.ts:326-414`. The test extracts the
    step's `run` text from `release.yml`, writes it to a file, and runs `bash -e <file>` in a scratch directory with
    only `PATH` and `HOME` set. Each case plants empty files under `dist/`.
  - **Assertions:** each failing case asserts a non-zero exit and exactly one `::error::` line naming what it found.
    The `+` case's line is the existing message. The passing case asserts exit 0, no `::error::`, and
    `derived version: <v>`.

  | Case | Planted `dist/` | Expect |
  |---|---|---|
  | normal | `crucible_axi-0.5.0.dev3-py3-none-any.whl`, `crucible_axi-0.5.0.dev3.tar.gz` | pass, `derived version: 0.5.0.dev3` |
  | empty | nothing (the 0.4.0 state) | fail: no wheel, no sdist (both counts reported) |
  | no wheel | the sdist only | fail: wheel count |
  | two wheels | two `crucible_axi-*.whl`, one sdist | fail: wheel count |
  | no sdist | the wheel only | fail: sdist count |
  | two sdists | one wheel, two `crucible_axi-*.tar.gz` | fail: sdist count |
  | foreign sdist | the wheel, `other-0.5.0.dev3.tar.gz` | fail: empty version |
  | mismatch | `…-0.5.0.dev3-…whl`, `…-0.5.0.dev4.tar.gz` | fail: versions differ |
  | local | both at `0.5.0+g1` | fail: the existing `+` message |

  The "empty" case reports both counts, so its two `::error::` lines are the one stated exception to "exactly one".
- **AC3.** `ci-every-python-job-sets-up-the-python-floor.test.ts` lists three jobs, its header says three, and it
  passes.
- **AC4.** On the 0.5.0 rehearsal's CI run on `release/0.5.0`:
  - the `publish-testpypi` log prints a non-empty `derived version: 0.5.0.devN`, equal to the version in the uploaded
    file names;
  - TestPyPI accepts the upload.

  The log is saved under `test-reports/work/`. This is checked at the rehearsal.
- **AC5. No CHANGELOG entry.** `CHANGELOG.md:3-4` scopes the changelog to the npm package and the PyPI package, and
  this CR changes neither. Precedent: 0.4.0 carries no CI-only entry, and CI-only CRs CR-263 and CR-137 earned none.

## Non-goals

- The `build` job's own version handling.
- The `publish-pypi` and `publish-npm` jobs.
