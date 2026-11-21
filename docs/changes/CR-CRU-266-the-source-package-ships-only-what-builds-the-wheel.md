# CR-CRU-266: the source package ships only what builds the wheel

**Status:** PENDING. Filed 2026-11-21, from the 0.4.0 package smoke (`test-reports/work/rel040-smoke-report.md`,
finding 1) and the 0.4.0 publish's `twine check` warnings. User ruling: filed for 0.5.0 after the release.
Revised 2026-11-22 after the gap analysis (`test-reports/work/cr266-gap-analysis.md`), with user rulings.
**Type:** maintenance
**Points:** 2
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** packaging, release
**Design reference:** `test-reports/work/cr266-survey-report.md`, `test-reports/work/cr266-gap-analysis.md`

## Problem

`pyproject.toml` declares what goes into the wheel (`[tool.hatch.build.targets.wheel]`: the `crucible_axi` package,
with the client fleet force-included). It declares nothing for the sdist, so hatchling falls back to its default and
packs the whole project tree: `tests/`, `docs/`, `.lavish/`, `src/`, `public/`, the workflows and the scripts.

The default honours the root `.gitignore` but not the nested ones. It also packs any untracked file that no
`.gitignore` names.

- **Built from a working checkout,** the 0.4.0 smoke's sdist was 15,043,537 bytes. Most of that was Rust `target/`
  output under `tests/fixtures/nextest/crates/`, which the nested `.gitignore` files name, plus an untracked
  `.claude/settings.local.json`.
- **The wheel** from the same tree was 519,288 bytes.
- **CI** builds from a clean checkout, so the published 0.4.0 sdist (7.3 MB) carried no ignored output. It still
  carried the whole repository.

CI builds with `python -m build`, which builds the wheel *from the sdist*, so the wheel that ships is the one built
from the sdist. No existing test checks that wheel: every packaging test builds its wheel from the checkout.

There is a second problem in the same metadata. The project declares no `readme`. So:

- `twine check` warns that `long_description` and `long_description_content_type` are missing, on every publish
  (TestPyPI and PyPI, 0.4.0);
- the package's PyPI page has no description.

CI's `twine check` does not run with `--strict`, so the warnings never fail the build.

## Behaviour

- **S1. The sdist declares what it contains.** `[tool.hatch.build.targets.sdist]` names its contents with
  `only-include`:
  - `crucible_axi/`;
  - the `clients/` fleet the wheel force-includes, recursively, with every non-`.py` file it holds;
  - `CHANGELOG.md`.

  Hatchling always adds `pyproject.toml`, `README.md`, `LICENSE`, `.gitignore` and the generated `PKG-INFO`. Nothing
  else goes in: no tests, docs, server, UI, CI, scripts, untracked file or git-ignored file.
- **S2. A wheel built from the sdist is the wheel.** Building the wheel from the unpacked sdist gives the same file
  list as building it from the checkout. Where the version comes from:
  - the sdist takes it from hatch-vcs and git;
  - a wheel built from the sdist takes it from the sdist's `PKG-INFO`.

  No `_version.py` file is needed: the package reads its version from `importlib.metadata`.
- **S3. The package has a description.**
  - `pyproject.toml` declares `readme = "README.md"`. The README is the one source of the install commands, and the
    doc tests already guard it (user ruling).
  - Every relative link in the README becomes absolute, so the PyPI page renders it. Today that is one link, to
    `docs/RUNBOOK.md` at `README.md:178`.
  - The release workflow's build job runs `twine check --strict`, so a metadata warning fails the build.

## Acceptance criteria

- **AC1.** An sdist is built offline from the live checkout (the suite's own interpreter, `--no-isolation`) into a
  directory the test owns. Its member names, with the top-level directory stripped, equal exactly:
  - `git ls-files crucible_axi clients`;
  - plus `pyproject.toml`, `README.md`, `LICENSE`, `CHANGELOG.md`, `.gitignore` and `PKG-INFO`.

  This holds whatever ignored or untracked files the checkout holds (user ruling). Nothing is planted in the checkout.
- **AC2.** A wheel built from the unpacked sdist (no `.git`) has the same file list as a wheel built from the
  checkout, `dist-info` names included.
- **AC3.** The built wheel's `METADATA` carries `Description-Content-Type: text/markdown` and a non-empty
  description, and the README it carries has no relative link. `release.yml`'s build job runs
  `twine check --strict` on every artifact (user ruling: this stands in for running twine locally, which is not in
  the `dev` extra).
- **AC4.** The CI release workflow's build job still produces both artifacts under `--strict`. Whether TestPyPI
  accepts them is checked at the 0.5.0 rehearsal: `publish-testpypi` runs only on `release/**` and `hotfix/**`.
- **AC5.** `CHANGELOG.md`'s `## [Unreleased]` section has a `### Changed` entry saying the source package now carries
  only what builds the wheel, and the PyPI page carries the README.
- **AC6.** The new module's offline builds are registered where every wheel builder is:
  - the `BUILDERS` set in `test_wheels_build_offline_with_the_suites_own_interpreter.py`;
  - the `wheel_build_modules.py` docstring;
  - the `pyproject.toml` "Named demanders" comment.

  The offline-build guard accepts the sdist build's shape.

## Non-goals

- Changing what the wheel contains.
- The npm package's file list, which `package.json` `files` already bounds.
- The `publish-testpypi` "Version sanity" step, which never derives a version. That is CR-CRU-271.
