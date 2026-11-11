# CR-CRU-251 — a run's coverage keeps only the files inside its tree

**Status:** PENDING · Pre-review: due — user rulings at design
**Type:** feature
**Priority:** medium
**Depends on:** CR-CRU-193
**Labels:** server, codecs, coverage
**Phase:** design
**Design reference:** CR-CRU-193 (the board keeps a run's coverage file by file); CR-CRU-250 (a
coverage run's envelope names its least covered files)

## Context

The board keeps a run's coverage as the runner reported it. `decodeCoverageWithFiles`
(`src/codecs/coverage.ts`) sums every text of a coverage block into the run's totals, and keeps
every file the texts name, whatever its name.

A runner can report a file that is not part of the project. A test that writes a module to the
system's temporary directory and imports it is enough: bun's lcov names such a file by its path
relative to the run's working directory, which climbs out of the tree, for example
`../../../../../tmp/<dir>/app-logic.mjs`. This board's own suite does so in
`tests/roadmap-visual-grammar.test.ts`, which renders an earlier `public/app-logic.mjs` from a
temporary copy. Its pre-merge gate then states that copy as the second least covered file of the
whole bun suite, at 37% of 622 lines.

Such a file is wrong in three places:

- the run's totals count its lines and functions;
- the file list, the run page and the Coverage tab show it, and the `coverage` block of a client's
  envelope names it;
- the shared directory that `getEventCoverage` (`src/store.ts`) answers as `coverageRoot` is taken
  from the least and greatest names, so one climbing name makes the root empty.

## Scope

### §S1 — a file outside the run's tree is not the run's

- **The rule.** A file name climbs out of the run's tree when it is relative and, read with `/`
  and `\` both as separators, `.` segments dropped and each `<name>/..` pair cancelled, its first
  segment is `..`.
  - A name that starts with `/`, or with a drive letter and `:`, is absolute, and is kept as
    today: the board does not know the project's root.
  - `src/../lib/a.ts` stays inside the tree; `src/../../x.ts` and `./../x.ts` climb out.
- **Where.** `decodeCoverageWithFiles` leaves such a file out after the texts are joined, so a
  name stated more than once is judged once. It is the one place a coverage block is decoded, so
  the rule holds for every codec and every stack.
- **The totals.** The run's `lines` and `functions` totals are the sums the texts state, less the
  counters of every file left out; each percent is taken from what remains, by `coveragePercent`.
  The `branches` axis is unchanged: no codec keeps a file's branches, and only `jacoco` states
  branches, whose names are package paths that never climb.
- **No file left.** A block whose every file climbs out keeps no coverage. It is dropped as an
  undecodable block is (`decodeCoverageBlock` in `src/codecs/index.ts`): one `coverage-dropped`
  warning, its detail naming the block and saying that every file it names lies outside the run's
  tree. A block that names no file at all is unchanged.
- **No warning otherwise.** A block that keeps at least one file leaves the others out silently.

### §S2 — docs

- The CHANGELOG `[Unreleased]` says that a run's coverage keeps only the files inside its tree, and
  how the totals are then counted.
- `docs/RUNBOOK.md`, where it says how a run's coverage files are kept, says the same.
- The PRD's coverage-ingest text (`docs/research/PRD-crucible-v2.md`, the codec translation layer)
  states the rule of §S1.

## Acceptance criteria

- [ ] **AC1 — a climbing file is left out.** An lcov text naming `src/a.ts`, `lib/b.ts` and
  `../../tmp/x/c.mjs` decodes to two files, `src/a.ts` and `lib/b.ts`; its `lines` and `functions`
  totals are the three records' sums less `c.mjs`'s counters, with their percents taken from what
  remains.
- [ ] **AC2 — the rule's cases.** Each of `../x.ts`, `./../x.ts`, `src/../../x.ts` and
  `..\\x.ts` is left out. Each of `src/../lib/a.ts`, `./src/a.ts`, `/abs/path/a.ts`,
  `C:\\work\\a.ts` and `..x/a.ts` is kept.
- [ ] **AC3 — one name stated twice.** A climbing name stated in two texts of one block is left
  out once, and both statements' counters leave the totals.
- [ ] **AC4 — no file left.** A block whose every file climbs out keeps no coverage and no files,
  and the ingest answers exactly one `coverage-dropped` warning whose detail says its files lie
  outside the run's tree. A block that names no file decodes as today.
- [ ] **AC5 — through the ingest.** A green bun run posted to `POST /api/v2/runs` whose lcov names
  a climbing file answers `run.coverage`, `run.coverageFileCount` and `run.coverageFiles` without
  it, and `?depth=coverage` answers the same count and files, with `coverageRoot` the shared
  directory of the kept names.
- [ ] **AC6 — the other codecs.** A `jacoco` report and a `go-coverprofile` profile keep the
  files and totals they keep today: none of their names climbs.
- [ ] **AC7 — docs and hygiene.** The texts of §S2 are present. The code and tests add no CR id
  literal.

## Estimated size

3 points:

- one name rule and one pass over the joined files in the decoder, with the totals reduced;
- the all-left-out case through the existing dropped-block warning;
- tests at the codec and through the ingest; three docs.

## Risk

- A project that keeps its sources beside its checkout and reports them by a climbing name, for
  example a monorepo package run from one level down, loses those files and their counters. The
  run's tree is the runner's working directory; such a project runs its coverage from the root it
  wants measured.
- Totals that no longer equal what the runner printed. The board states only the files that are
  the project's, and its totals agree with its files.

## Non-goals

- Whether files under a project's test tree (test helpers, step files) count toward its coverage.
- Absolute names outside the project: the board does not know the project's root.
- Runs stored before this change keep their files and totals as stored.
- How a test writes its temporary modules; this board's own suite is left as it is.
