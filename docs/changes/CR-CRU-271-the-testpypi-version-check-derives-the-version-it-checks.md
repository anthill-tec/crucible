# CR-CRU-271: the TestPyPI version check derives the version it checks

**Status:** PENDING. Filed 2026-11-22, from the CR-CRU-266 gap analysis (`test-reports/work/cr266-gap-analysis.md`,
adjacent defect). User ruling: its own CR, in wave 9 after CR-CRU-266.
**Type:** maintenance
**Points:** 1
**Wave:** 9 (0.5.0)
**Depends on:** CR-CRU-266
**Labels:** release, ci

## Problem

`publish-testpypi` in `.github/workflows/release.yml` has a step named "Version sanity — reject PEP 440 local segment
('+')". TestPyPI rejects a local version, so the step exists to fail early and clearly. It never checks anything.

Here is how the step goes wrong:

1. It installs only `build`, then runs `python -m build --sdist --no-isolation`. Without isolation, the build backend
   (`hatchling`, `hatch-vcs`) is not installed, so the build fails.
2. `>/dev/null 2>&1 || true` hides the failure.
3. `ls dist/*.tar.gz` then finds nothing, so `VER` is empty. An empty version holds no `+`, so the step passes.

The 0.4.0 TestPyPI log printed `derived version:` with nothing after it (`test-reports/work/rel040-testpypi3.log:181`). A local version
would reach the upload, and fail there with a less clear error.

## Behaviour

- **S1. The check reads the version of the artifacts it uploads.** It reads the version from the `dist` artifacts
  that the `build` job produced and that this job downloads. It does not rebuild them.
- **S2. A version the step cannot derive fails the step.** An empty or missing version is an error with its own
  message, never a pass.
- **S3. No failure is hidden.** No `|| true` and no redirect to `/dev/null` remain in the step.

## Acceptance criteria

- **AC1.** The step derives the version from the downloaded `dist/*.whl` or `dist/*.tar.gz` file names. It runs after
  the artifact download.
- **AC2.** An empty version fails the step with an `::error::` that names it.
- **AC3.** A version with `+` still fails with the existing message.
- **AC4.** A doc or workflow test pins:
  - the step's order after the download;
  - that the step has no `|| true` and no `/dev/null`.
- **AC5.** The CI run on a `release/**` push prints the derived version. This is checked at the 0.5.0 rehearsal.

## Non-goals

- The build job's own version handling.
