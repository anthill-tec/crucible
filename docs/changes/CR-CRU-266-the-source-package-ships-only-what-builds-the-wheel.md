# CR-CRU-266: the source package ships only what builds the wheel

**Status:** PENDING. Filed 2026-11-21, from the 0.4.0 package smoke (`test-reports/work/rel040-smoke-report.md`,
finding 1) and the 0.4.0 publish's `twine check` warnings. User ruling: filed for 0.5.0 after the release.
**Type:** maintenance
**Points:** 2
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** packaging, release
**Design reference:** the gap analysis follows this filing.

## Problem

`pyproject.toml` declares what goes into the wheel (`[tool.hatch.build.targets.wheel]`: the `crucible_axi` package,
with the client fleet force-included). It declares nothing for the sdist, so hatchling falls back to its default and
packs the whole project tree: `tests/`, `docs/`, `.lavish/`, `src/`, `public/`, the workflows and the scripts.

Built from a working checkout, the sdist also picks up git-ignored build output. The 0.4.0 smoke's sdist was
15,043,537 bytes, mostly Rust `target/` directories under `tests/fixtures/nextest/crates/`. A wheel built from the
same tree was 519,288 bytes.

CI builds from a clean checkout, so the published 0.4.0 sdist does not carry the ignored files. It still carries the
whole repository, though, and a release built by hand would carry the ignored files too.

There is a second problem in the same metadata. The project declares no `readme`. So `twine check` warns that
`long_description` and `long_description_content_type` are missing on every publish (TestPyPI and PyPI, 0.4.0), and
the package's PyPI page has no description.

## Behaviour

- **S1. The sdist declares what it contains.** It contains:
  - the sources the wheel is built from: `crucible_axi/` and the `clients/` fleet the wheel force-includes;
  - the project metadata: `pyproject.toml`, `README.md`, `LICENSE` and `CHANGELOG.md`.

  Nothing else goes in: no tests, docs, server, UI, CI, scripts or git-ignored file.
- **S2. A wheel built from the sdist is the wheel.** Building the wheel from the unpacked sdist gives the same file
  list as building it from the checkout. The version comes from hatch-vcs in both cases.
- **S3. The package has a description.** `pyproject.toml` declares the readme. The gap analysis decides which file
  (the README, or a short package-facing one), so that `twine check` passes with no warning and the PyPI page shows
  it.

## Acceptance criteria

- **AC1.** An sdist built from a checkout that holds git-ignored build output under `tests/fixtures/` lists only the
  S1 paths.
- **AC2.** A wheel built from that sdist has the same file list as a wheel built from the checkout.
- **AC3.** `twine check` on the built sdist and wheel reports `PASSED` with no warning.
- **AC4.** The CI release workflow's build job still produces both artifacts, and `publish-testpypi` accepts them.
- **AC5.** `CHANGELOG.md`'s `## [Unreleased]` section has a `### Changed` entry saying the source package now carries
  only what builds the wheel.

## Non-goals

- Changing what the wheel contains.
- The npm package's file list, which `package.json` `files` already bounds.
