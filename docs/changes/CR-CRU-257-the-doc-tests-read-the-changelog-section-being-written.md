# CR-CRU-257 — the doc tests read the changelog section being written

**Status:** PENDING · filed 2026-11-14 (release fix: found by the 0.4.0 release's own doc checks; user ruling: a
release-fix CR, committed on `release/0.4.0`)
**Type:** fix
**Points:** 2
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** tests, docs, release
**Design reference:** RELEASING.md "Cutting a release" (the release's section is `[Unreleased]` moved under its
version heading); git-workflow § Releases (a release fix is a CR, committed on the release branch)

## Problem

Thirteen test modules check that a feature is recorded in `CHANGELOG.md` by reading its `## [Unreleased]` section
by name. On a release branch that section has become `## [0.4.0] - 2026-11-14`, and on `master` there is no
`[Unreleased]` at all. So on `release/0.4.0` (HEAD `b01758c1`) these tests fail although every entry they look for
is present: 50 failures in the ten modules the release's doc fix ran, and three more bun modules read the same
heading the same way. As written they can pass only on `develop`, between releases.

The modules:

- python: `test_a_runs_coverage_files_are_documented`, `test_project_create_is_documented`,
  `test_the_arduino_stream_declaration_is_documented`, `test_the_declaration_schema_is_documented`,
  `test_the_docs_say_regression_and_the_gate_read_the_marker`, `test_the_go_client_is_documented`,
  `test_the_lint_verb_and_gate_stage_are_documented_where_operators_read_them`,
  `test_the_maven_console_declaration_is_documented`, `test_the_rust_targets_declaration_is_documented`;
- bun: `docs-describe-lint-records`, `coverage-file-table-docs`, `coverage-outside-the-runs-tree-docs`,
  `release-flow-names-the-release-notes-verb`.

## Design

- **The section being written.** A doc test reads the changelog's TOPMOST `## [...]` section: `[Unreleased]` on
  `develop`, the release's own `## [X.Y.Z] - YYYY-MM-DD` on a release branch and on `master`. It runs from that
  heading to the next `## [` heading (or the link block at the file's foot).
- **One reader per language.** One python helper under `tests/client/` and one TypeScript helper under
  `tests/helpers/`, each a few lines; every listed module reads the section through it. No module keeps its own
  `[Unreleased]` lookup.
- **Two readings, by what a check asks** (amended at VERIFY 953, user ruling 2026-11-14). The topmost section
  alone goes stale the moment the next release's `## [Unreleased]` is written above it, so:
  - a check that a feature IS recorded searches every release section of the changelog (`[Unreleased]` and every
    dated section, the link block at the foot excluded), so it stays green across releases;
  - a check that stale wording is ABSENT reads only the section being written (the topmost one), so an old
    release's honest record of its day never fails it.

  Each helper gains the second reader; each check uses the one that matches what it asks. A link-definition line
  ends a section only in the link block after the last heading. Failure messages name "the changelog" or "the
  section being written", never `[Unreleased]`.
- **What the tests check is unchanged.** Only where they look moves. No production code, no doc and no fixture
  changes; `release-notes-extractor`'s own `[Unreleased]` fixture is out of scope (it tests the extractor on a
  fixture).

## Acceptance criteria

- [ ] **AC1 — the reader.** Each helper, given a changelog whose topmost section is `## [Unreleased]`, answers that
  section; given one whose topmost section is `## [0.4.0] - 2026-11-14` (no `[Unreleased]`), answers that section;
  each ends at the next `## [` heading or the link block. Proved on small inline changelogs.
- [ ] **AC2 — every listed module reads through it.** No listed module names `[Unreleased]` in a lookup; each reads
  the section through its language's helper.
- [ ] **AC3 — green on the release branch.** On `release/0.4.0` every listed module passes.
- [ ] **AC5 — green across the next release** (amended at VERIFY 953). On a changelog with a new `## [Unreleased]`
  written above `[0.4.0]` (holding no 0.4.0 entry), every listed module still passes against the real entries
  below it. Proved on an inline changelog built from the real one with such a section prepended.
- [ ] **AC4 — nothing else moves.** No file outside `tests/` changes; the doc suites (`tests/docs-*`, the tripwire,
  the citations test) pass.

## Non-goals

- Changing any changelog entry, the release-notes extractor or `finish`'s notes guard.
