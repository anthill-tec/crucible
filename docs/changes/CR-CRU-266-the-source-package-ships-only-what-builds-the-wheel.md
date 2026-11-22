# CR-CRU-266: the source package ships only what builds the wheel

**Status:** COMPLETED — 2026-11-22. Filed 2026-11-21, from the 0.4.0 package smoke (`test-reports/work/rel040-smoke-report.md`,
finding 1) and the 0.4.0 publish's `twine check` warnings. User ruling: filed for 0.5.0 after the release.
Revised 2026-11-22 after the gap analysis (`test-reports/work/cr266-gap-analysis.md`) and the spec pre-review
(`test-reports/work/prereview266-report.md`, F1–F10), with user rulings.
**Type:** maintenance
**Points:** 2
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** packaging, release
**Design reference:** `test-reports/work/cr266-survey-report.md`, `test-reports/work/cr266-gap-analysis.md`,
`test-reports/work/prereview266-report.md`

## Problem

`pyproject.toml` declares what goes into the wheel (`[tool.hatch.build.targets.wheel]`: the `crucible_axi` package,
with the client fleet force-included). It declares nothing for the sdist, so hatchling falls back to its default and
packs the whole project tree: `tests/`, `docs/`, `.lavish/`, `src/`, `public/`, the workflows and the scripts.

The default honours the root `.gitignore` but not the nested ones, and packs any untracked file that the root
`.gitignore` does not name.

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

- **S1. The sdist declares what it contains.** `[tool.hatch.build.targets.sdist]` sets `only-include` to
  `/crucible_axi`, `/clients` and `/CHANGELOG.md`.

  Hatchling adds these files on its own, each under a condition:

  | File | Added because |
  |---|---|
  | `pyproject.toml` | always |
  | the root `.gitignore` | it exists |
  | `README.md` | it is the declared `readme` |
  | `LICENSE` | it matches the default licence-file globs |
  | `PKG-INFO` | it is generated |

  A future root `NOTICE*` or `AUTHORS*` would join them, and that is intended.

  Hatchling walks the disk under the two directories. It skips:

  - its excluded directories (`__pycache__`, `.venv`, `.git`, the tool caches);
  - `.DS_Store` and `*.py[cdo]`;
  - whatever the root `.gitignore` names.

  So the sdist carries:

  - **On a clean checkout (CI):** exactly the tracked files there.
  - **On a working checkout:** also any untracked file there that the root `.gitignore` does not name.

  Nothing outside those paths goes in: no tests, docs, server, UI, CI, scripts or nested build output.
- **S2. A wheel built from the sdist is the wheel.** The wheel built from the unpacked sdist (no `.git`) carries
  exactly the sdist's `crucible_axi/` and `clients/` files, plus its `dist-info`. Where the version comes from:
  - the sdist takes it from hatch-vcs and git;
  - the wheel built from it takes it from the sdist's `PKG-INFO`.

  No `_version.py` file is needed: the package reads its version from `importlib.metadata`.
- **S3. The package has a description.**
  - `pyproject.toml` declares `readme = "README.md"`. The README is the one source of the install commands, and the
    doc tests already guard it (user ruling).
  - Every relative link in the README becomes absolute, so the PyPI page renders it. Today that is one link, to
    `docs/RUNBOOK.md` at `README.md:178`. Its absolute form is
    `https://github.com/anthill-tec/crucible/blob/master/docs/RUNBOOK.md`, the same ref as `pyproject.toml`'s project
    URLs.
  - The release workflow's `build` job runs `twine check --strict dist/*` after `python -m build`, so a metadata
    warning fails the build.

## Acceptance criteria

### The builds

A new integration module runs two offline builds:

- **B1:** `python -m build --no-isolation --outdir <D1>`. This is CI's own command: it builds the sdist, then the
  wheel from the unpacked sdist.
- **B2:** `python -m build --wheel --no-isolation --outdir <D2>`, the wheel built from the checkout.

Both builds:

- run with the suite's own interpreter, in the checkout, which they leave untouched (no `dist/` or `build/` remains);
- write into directories the module owns.

### The criteria

- **AC1 (user ruling: bounded and complete).** Compare B1's sdist as a sorted list of its tar file members, with the
  top-level directory stripped, so that a duplicate shows.
  - Every member is under `crucible_axi/` or `clients/`, or is one of `pyproject.toml`, `README.md`, `LICENSE`,
    `CHANGELOG.md`, `.gitignore` and `PKG-INFO`.
  - Every file `git ls-files crucible_axi clients` lists that exists on disk is a member, exactly once. This holds on
    a dirty tree.
- **AC2.** B1's wheel holds exactly:
  - the sdist's `crucible_axi/` files;
  - its `clients/` files, remapped under `crucible_axi/clients/`;
  - its `crucible_axi-<v>.dist-info/` (`METADATA`, `WHEEL`, `RECORD`, `entry_points.txt`, `licenses/LICENSE`).

  Its `dist-info` directory name equals B2's.
- **AC3a.** B1's wheel `METADATA` carries `Description-Content-Type: text/markdown`, and its body equals `README.md`
  byte for byte.
- **AC3b (unit, on the file).** `README.md` has no relative link target in any of these forms:
  - inline links, `[t](u)` and `[t](u "title")`;
  - images, `![a](u)`;
  - reference definitions;
  - HTML `href=` and `src=`;
  - autolinks, `<u>`.

  A target is relative when it has no URI scheme. A target that is only a `#fragment` counts as relative too, since
  PyPI has no GitHub heading anchors. Text inside fenced or inline code is skipped.
- **AC4.**
  - A bun unit test on `release.yml`'s `jobs.build.steps` pins that `twine check --strict dist/*` runs after
    `python -m build`.
  - The CI run of the push that carries this CR proves that the `build` job still produces both artifacts under
    `--strict`. That push happens only with the user's OK.
  - TestPyPI acceptance is checked at the 0.5.0 rehearsal, because `publish-testpypi` runs only on `release/**` and
    `hotfix/**`.
- **AC5.** `CHANGELOG.md`'s `## [Unreleased]` section has a `### Changed` entry, placed between `### Upgrading` and
  `### Fixed`. It says the source package now carries only what builds the wheel, and the PyPI page carries the
  README. This is reviewed, not tested.
- **AC6.** The offline-build guard takes the new module.
  - In `test_wheels_build_offline_with_the_suites_own_interpreter.py`, each entry in the `BUILDERS` tuple carries its
    expected selectors: `("--wheel",)` for the existing three, and `(None, "--wheel")` for the new module. The guard
    then checks every build for:
    - `argv[:3] == [exe, "-m", "build"]`;
    - `--no-isolation`;
    - an `--outdir` outside the checkout;
    - `cwd` set to the checkout.

    A builder whose faked build produces no artifact must not raise. The missing-module checks stay as they are.
  - Both module docstrings ("Three modules … `--wheel`") are updated: `wheel_build_modules.py:3-7` and the guard's.
  - The `build` entry's "Named demanders" comment in `pyproject.toml` (about lines 36–50) is updated, including its
    stale helper name `_build_modules_gap`, which is now `build_modules_gap`.

## Non-goals

- Changing what the wheel contains.
- The npm package's file list, which `package.json` `files` already bounds.
- The `publish-testpypi` "Version sanity" step, which never derives a version. That is CR-CRU-271.

## Close-out (2026-11-22)

- **S1.** `[tool.hatch.build.targets.sdist]` declares `only-include = ["/crucible_axi", "/clients", "/CHANGELOG.md"]`,
  with a comment naming what hatchling adds itself and the walk's root-`.gitignore`-only scope.
- **S3.** The package now has a readme:
  - `readme = "README.md"`;
  - the one relative README link is now absolute (`README.md:178`, `docs/RUNBOOK.md`);
  - `release.yml`'s build job runs `twine check --strict dist/*`.
- **AC1, AC2, AC3a:** `tests/client/integration/test_the_source_package_ships_only_what_builds_the_wheel.py`. It runs
  two offline builds into its own temporary directories: CI's own sdist-then-wheel build, and a `--wheel` build from
  the checkout. It proves:
  - the sdist is bounded;
  - the sdist is complete against `git ls-files`, and holds on a dirty tree;
  - the shipped wheel is exactly what the sdist holds, with the same `dist-info` name;
  - the `METADATA` description is `README.md` byte for byte;
  - the builds leave nothing in the checkout.
- **AC3b:** `tests/client/unit/test_the_readme_links_only_absolute_targets.py`. It scans paragraphs, so wrapped links
  are found, and covers every link form; code is skipped. One synthetic case pins the scanner.
- **AC4:**
  - The bun unit test `tests/unit/release-build-checks-its-artifacts-strictly.test.ts` pins that
    `twine check --strict dist/*` runs after `python -m build`.
  - The CI half rides the next push of develop, with the user's OK.
  - TestPyPI acceptance is checked at the 0.5.0 rehearsal.
- **AC5:** `### Changed` under `## [Unreleased]`, between Upgrading and Fixed.
- **AC6:** the offline-build guard's `BUILDERS` carries each builder's selectors, and checks every build's
  interpreter, `--no-isolation`, an `--outdir` outside the checkout resolved against the build's cwd, and the cwd. The
  three wheel builders are unchanged; a missing module still fails. The docstrings and the `pyproject.toml` comments
  name the new builds.
- **Gate:** `pre-merge-gate` cycle 999, 5 suites, 14845/0.
- **Cycles:**
  - 996 red-green: python and bun RED, then GREEN.
  - 997 verify: READY, S1/S2 and Sug1–4.
  - 998 fix, by user ruling: S1, S2, Sug1–Sug3. Sug4 (two loud edge cases in the AC4 parser) is noted only.
  - 999 fix: the cycle-998 gate's one failure. The existing guard
    `test_no_test_builds_its_own_path_to_the_client_source` flagged a relative `clients` spawn argument, and the
    module now lists every tracked file and filters by prefix.
- **Found on the way:** the 0.4.0 sdist carried the tracked `.envrc` (`dotenv` only, no secret). It is gone from
  every sdist after this CR.
- **Merge:** the user pre-approved it once the gate was green.
