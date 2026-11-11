# CR-CRU-193 — a run's coverage is shown file by file

**Status:** PENDING · Pre-review: ran — 8 points or more, and user rulings at design
**Type:** feature
**Priority:** medium
**Depends on:** CR-CRU-152, CR-CRU-239
**Labels:** server, codecs, storage, api, ui, coverage
**Phase:** design
**Design reference:** storyboard frame F26 (a run's coverage, file by file);
`docs/research/PRD-crucible-v2.md` (the run schema, the coverage codecs, the Coverage tab)

## Context

A coverage run reaches the board as the report's whole text: every client posts
`coverage: {codec, data}`, and the board decodes it (`decodeCoverage`, `src/codecs/coverage.ts`).
Each coverage codec sums the report into one total per axis and discards which file each count
came from:

- `lcov` adds every record's `LF`/`LH` and `FNF`/`FNH`, and reads the `SF:` name only to know a
  record is there;
- `jacoco` adds every CSV row's `LINE_*` and `METHOD_*` columns, and never reads the row's
  `PACKAGE` and `CLASS`;
- `go-coverprofile` adds every block's statements, and keeps the block's file only inside the
  key it removes repeated blocks by.

The board stores the totals on the run (`events.coverage`) and shows them in two places: the
project's Coverage tab (`CoveragePanelBody`, `public/app.js`) shows the lines and functions totals
of the latest green coverage run, and the project card shows a meter. A run's own page
(`RunDetailBody`) shows no coverage at all.

So a project sees that its coverage is 91%, and cannot see which files are the other 9%. It has to
open its coverage tool's own report, outside the board.

The report text is not kept once decoded, and it stays so: the board keeps numbers and, new with
this CR, each file's name.

## Scope

### §S1 — the coverage codecs read each file

In `src/codecs/coverage.ts`, `CoverageCodec.read` returns the text's files beside the counters it
returns today. Each file is a name and its own counters.

- **`lcov`:** one file per `SF:` record. Its name is the `SF:` value as the report writes it,
  absolute or relative. Its lines are the record's `LF`/`LH`, 0 of 0 when the record states
  none; its functions are the record's `FNF`/`FNH`.
- **`jacoco`:** one file per CSV row. Its name is `PACKAGE.CLASS`, or `CLASS` alone when `PACKAGE`
  is empty: the CSV names a class and no source file. Its lines are `LINE_MISSED + LINE_COVERED`
  and its functions `METHOD_MISSED + METHOD_COVERED`. Branches are not kept per file.
- **`go-coverprofile`:** one file per distinct file of the profile's blocks. Its name is the
  block's text before `:startLine.startCol,endLine.endCol`. Its lines are its blocks' statements,
  a repeated block counted once and covered if any copy is, as the total counts it. It has no
  functions.

A file whose functions total is 0, or unstated, has no functions axis, on every codec.

`decodeCoverage` joins the files of every text of the run. A name stated more than once, in one
text or in several, is one file whose counters are added. So on every axis the files' counters sum
to the run's total.

A report can decode to coverage with no file at all: a Go profile of `mode:` alone, or a JaCoCo CSV
of its header alone. Coverage that `assembleRun` takes from the decoded run itself, rather than
from a coverage block, has no files either.

`src/types.ts` gains `CoverageFile`: `path`, `lines` and an optional `functions`, each axis a
`CoverageAxis` whose percent is `coveragePercent`'s. `RunSchema` gains an optional
`coverageFiles`. `assembleRun` (`src/codecs/index.ts`) sets it whenever it sets `coverage` from a
coverage block; coverage that is dropped as undecodable has no files.

### §S2 — the board keeps the files with the run

In `src/store.ts`:

- **The table.** `run_coverage_files` holds one row per file of a run: the run's event id, the
  file's position, its name, its lines total and covered, and its functions total and covered
  (NULL when the file has no functions axis). Percents are not stored; a read computes them with
  `coveragePercent`.
- **A base-pass table.** `createRunDetailTables` creates it. It has no chain step and
  `SCHEMA_VERSION` does not change: a store written before it gains the table when it opens, and
  nothing else in that store changes.
- **The order is fixed and stored.** A run's files are positioned once, at ingest:
  1. lowest lines percent first, the percent as `coveragePercent` rounds it;
  2. then most uncovered lines first;
  3. then by name, ascending in code-unit order (SQLite's `BINARY`), so `B.ts` comes before
     `a.ts`.

  A file with no lines is positioned after every file that has lines.
- **Written with the run.** `writeRunDetailRows` writes the rows in the transaction that writes
  the event. `recordTestEvent` keeps a run's files only when it keeps the run's coverage, so a
  failing run has none.
- **Removed with the run.** `RUN_DETAIL_TABLES` gains `run_coverage_files`, so every path that
  removes a run's detail rows removes these too: `deleteRunDetail` (one event, and retention's
  sweep), `deleteProjectRunDetail` (a project's events cleared, and a project deleted).
- **The old chain step is unchanged.** The chain step that created the run-detail tables decides
  whether an unstamped store already has them by its own six tables, named in the step, no longer
  through `RUN_DETAIL_TABLES`. So `baselineVersion` stamps such a store exactly as before and
  re-runs no retrofit.
- **Nothing else changes.** `events.coverage` stays the run's totals, so the projects list, the
  rollups, the coverage trend and every event brief are unchanged and read no file row.

`handleRunsParsed` (`src/v2.ts`) stores no files: coverage posted already decoded to
`/api/v2/runs/parsed` is totals only, as today.

### §S3 — the ingest answer names the least covered files

`handleRuns` (`src/v2.ts`) answers through `runResponse`. The run's id stays at the answer's
top-level `event`. When the run kept files, the answer's `run` block gains:

- `coverageFileCount`: how many files the run has;
- `coverageFiles`: the first 10 of them in the stored order, each a `CoverageFile`.

A run that kept no files, or kept coverage of 0 files, has neither key. This holds for a single-shot ingest and for the close
of a streamed run, which are the same route.

### §S4 — the run's files are read on their own

`handleEventGet` (`src/v2.ts`). Each read's new keys sit inside its answer's `event`, as
`rawBytes` does:

- **`?depth=suites`** carries `event.coverageFileCount` when the run has files, on both of its
  answers (a run with a tree, and a run without). The count is one aggregate statement; no file
  row is read.
- **`?depth=coverage`** is a new read. It answers the event without its tree and without its raw
  output, and its `event` gains:
  - `coverageFileCount`: the run's file count, 0 when it has none;
  - `coverageFiles`: the files in the stored order, each a `CoverageFile`; an empty list when the
    run has none;
  - `coverageRoot`: the leading directories every file name of the run shares. It is the longest
    prefix common to all the names, cut back so that it ends at a `/`. It is the empty string
    when the names share no directory, as Maven's class names do, and when the run has no files.
    It is computed from the run's least and greatest names in code-unit order (the common prefix
    of the two is the common prefix of all), by aggregate, without loading every row.
- **`&files=<n>`** on that read answers only the first `n` files. `n` is ASCII digits alone with a
  value of at least 1; anything else (`0`, `-1`, `x`, `+3`) is refused with 400. An `n` larger
  than the run's count, however large, answers every file. The count and the root are still the
  whole run's. The read hands back no more file rows than it answers, beside the count and root
  aggregates.
- An event that has no files, whatever its kind, answers the count 0, the empty list and the
  empty root.
- An id the board does not hold answers 404, as the other reads do.

The full read and the `?suite=` read are unchanged. `?suite=` still takes precedence over
`depth`, as it does over `depth=suites` today. `files=` on any read other than
`?depth=coverage` is ignored, as other unknown parameters are.

### §S5 — one file table, on two surfaces

In `public/app.js`, one component renders a run's files. Both surfaces use it and read
`?depth=coverage&files=50`.

- **The table** (`data-testid="coverage-files"`):
  - a heading `Files · N`, N the run's file count;
  - one row per file (`data-testid="coverage-file-row"`), in the order the board answers;
  - each row: the file's name, its lines as `covered/total`, a meter filled to its lines percent,
    the percent, and its functions as `covered/total · percent`.
- **The name.** A row shows the name without the run's `coverageRoot`. A name too long for its
  cell is cut on the left, so its end stays visible. The row's `title` is the whole name. On
  touch media, where there is no hover, the name is not cut: it shows whole, without the root,
  wrapped, breaking after a `/`.
- **The name column's heading** is `class` for a run of stack `mvn`, and `file` otherwise.
- **The functions cell** is empty for a file with no functions axis.
- **More than 50 files.** The table opens on the first 50. One control beneath them
  (`data-testid="coverage-files-show-all"`, reading `show all N`) reads the files without
  `files=` and lists them all. A run of 50 files or fewer shows no control.
- **The phone band.** A row's functions cell moves beneath its name; the rows and the control are
  the same. On touch media `run-coverage` and `coverage-files-show-all` are at least 44px tall,
  as every touch target is.
- **State is the run's.** The table's state (the files read, `show all` taken, a read in flight,
  a failure) is kept per event id. A re-render for the same event id keeps it and sends no read.
  A read that answers for an event id the surface no longer shows is discarded.
- **A failed read is retried** on the next unfold, or the next `show all` click. A failed
  `show all` read keeps the 50 rows and shows the failure line beneath them.

The surfaces:

- **The Coverage tab** (`CoveragePanelBody`). Beneath the totals and `view run`, which stay as
  they are, the tab shows the table for the project's `latestCoverageEventId`.
- **A run's own page** (`RunDetailBody`, in both of its containers). A test run that kept
  coverage shows one line above its test tree (`data-testid="run-coverage"`): the lines percent,
  the functions percent when the run has one, and `N files`. The line is folded when the page
  opens. A click unfolds the table beneath it, reading the files then; a second click folds it.
- **A run with coverage and no files** (filed before this change, filed with totals only, or a
  report of 0 files) shows its totals and `no per-file coverage for this run`, on both surfaces, with no table and
  nothing to unfold.
- **A run with no coverage** shows no coverage line on its page.
- **While the files are read** the table's place shows the pane's loading line. **A read that
  fails** shows `could not read this run's files` there; the totals and `view run` stay.
- **A newer coverage run.** When the project's `latestCoverageEventId` changes while the Coverage
  tab is open, the tab reads the new run's files and shows its first 50.

There are no sort controls and no filter.

### §S6 — docs

- `CHANGELOG.md` `[Unreleased]`: the board keeps and shows a run's coverage file by file; the
  `?depth=coverage` read; the two ingest-answer keys.
- `docs/research/PRD-crucible-v2.md`: the run schema's coverage row names the per-file list; the
  coverage codecs paragraph says what each codec's file is; the API section names
  `?depth=coverage`; its line on what `/runs` adds to the answer names `coverageFileCount` and
  `coverageFiles`; the Coverage tab and the run page name the file table.
- `docs/RUNBOOK.md`: a run's coverage files are kept with the run and removed with it by
  retention; the ingest answer names 10 files and the board's table opens on 50.

## Acceptance criteria

- [ ] **AC1 — each codec reads its files.** On the repository's coverage fixtures, and a
  multi-row `jacoco` fixture this CR adds:
  - every `lcov` fixture decodes to one file per `SF:` record, named as the record writes it,
    with that record's lines and functions; a record that states no counters is a file of 0
    lines and no functions axis;
  - every `jacoco` fixture decodes to one file per row, named `PACKAGE.CLASS`, with lines and
    functions and no branches. The added fixture has a row whose `PACKAGE` is empty, named by its
    `CLASS` alone; a nested class, named as the CSV writes it; and a row of 0 methods, which has
    no functions axis;
  - a `go-coverprofile` fixture decodes to one file per distinct block file with lines only, and
    on the captured `-coverpkg` profile a repeated block counts once in its file;
  - `tests/fixtures/go-coverprofile/contracts-types-only.coverprofile` and a header-only JaCoCo
    CSV decode to coverage with no file.
- [ ] **AC2 — the files sum to the totals.** For every fixture above, and for two texts decoded
  as one run with one name in both, the files' lines total and covered, and their functions total
  and covered, equal the run's totals. The name stated twice is one file. Each file's percent is
  `coveragePercent` of its own counters.
- [ ] **AC3 — a green run keeps its files.** A green run ingested with a coverage block stores
  one row per file, for a single-shot ingest and for a streamed run's close. Its `events.coverage`
  is the totals object it stores today, with no file in it.
- [ ] **AC4 — a run that keeps no coverage keeps no files.** No row is stored for a failing run,
  for a run whose coverage is dropped as undecodable, or for a run posted to `/api/v2/runs/parsed`
  with coverage.
- [ ] **AC5 — the order.** A run whose files include two with the same rounded lines percent and
  different uncovered counts, two equal on both and named `B.ts` and `a.ts`, and one with no lines
  is read back in the §S2 order: the more uncovered of the first pair first, `B.ts` before
  `a.ts`, the file with no lines last.
- [ ] **AC6 — the ingest answer.** A run of 12 files answers `coverageFileCount: 12` and the
  first 10 files in the stored order in its `run` block, with the run's id at the top-level
  `event`; a run of 3 answers all 3; a run that kept no files, or coverage of 0 files, answers
  neither key. A streamed run's close answers as a single-shot ingest does.
- [ ] **AC7 — the reads.**
  - `?depth=suites` carries `event.coverageFileCount` for a run with files and no such key for a
    run without. Its only statement on `run_coverage_files` is one aggregate.
  - `?depth=coverage` answers every file in order in `event.coverageFiles`, with
    `event.coverageFileCount` and `event.coverageRoot`, and no tree or raw output.
  - With `&files=3` it answers 3 files and the whole run's count and root, and its statements on
    `run_coverage_files` hand back exactly 3 file rows beside at most the count and root
    aggregates.
  - `files=500` on a run of 12, and `files=` with twenty digits, answer all 12.
  - A file with no functions axis is answered with no `functions` key.
  - `files=0`, `files=-1`, `files=x` and `files=+3` are refused with 400; an unknown id answers
    404.
  - The full read, the `?suite=` read, `?suite=` with `depth=coverage`, and `?depth=suites` with
    `files=x`, answer a run with files as they do today, with no new key but the count.
  - A run without files, and a compile run, answer `coverageFileCount: 0`, an empty
    `coverageFiles` and the root `""`.
- [ ] **AC8 — the root.** Files named `/home/dev/app/src/a.ts` and `/home/dev/app/src/lib/b.ts`
  answer the root `/home/dev/app/src/`; `src/a.ts` and `srcgen/b.ts` answer the empty string; two
  Maven class names answer the empty string; a run of one file answers that file's directory.
- [ ] **AC9 — the files leave with the run.** After each of: one event deleted, a project's
  events cleared, a project deleted, and a retention sweep that removes the run, no
  `run_coverage_files` row of that run remains, and other runs' rows are untouched.
- [ ] **AC10 — an older store gains the table.** A store at the current schema version without
  `run_coverage_files` opens, gains the table, and changes nothing else: no other table, index or
  row, and the same schema version. An unstamped store that has the six earlier run-detail tables
  and not this one is stamped at the same version as before this change, and no retrofit runs
  again.
- [ ] **AC11 — the lists stay as they are.** `GET /api/v2/projects` and an event brief answer a
  project with a file-bearing coverage run exactly as they answer one without, and read no
  `run_coverage_files` row.
- [ ] **AC12 — the Coverage tab lists the files.** For a project whose latest green coverage run
  has files, the tab shows the totals and `view run` as today, then `coverage-files` with the
  heading `Files · N` and one `coverage-file-row` per file in the board's order, each with its
  name, lines, meter, percent and functions. The tab requests `?depth=coverage&files=50`.
- [ ] **AC13 — a run's page folds its files.** A test run with files shows `run-coverage` above
  its test tree with its percents and `N files`, and no table. A click shows the same table; a
  second click removes it. The files are requested only on the first unfold, with
  `?depth=coverage&files=50`. This holds in the home in-pane container and in the workspace one.
- [ ] **AC14 — more than 50.** A run of 60 files shows 50 rows and `show all 60`; clicking it
  requests the files with no `files=`, shows 60 rows and removes the control. A run of 50 shows 50
  rows and no control.
- [ ] **AC15 — names.** A row shows its name without the root and carries the whole name as its
  `title`. A `mvn` run's name column is headed `class`; another run's is headed `file`. A Go
  run's rows, and a file with no functions axis, have an empty functions cell.
- [ ] **AC16 — runs without files.** A run with coverage and no files shows its totals and
  `no per-file coverage for this run` on both surfaces, with no `coverage-files` and no unfold.
  This holds for a run filed before this change, and for a run whose report decoded to 0 files
  (the types-only Go profile). A run with no coverage shows no `run-coverage`.
- [ ] **AC17 — the phone band and touch.** In real browsers on the `chromium-mobile` and
  `webkit-iphone` projects (WebKit gated on its endpoint, as the other phone-band checks are):
  - a row's functions cell is beneath its name, and the table is no wider than its pane;
  - `run-coverage` and `coverage-files-show-all` are at least 44px tall;
  - a name longer than its cell shows whole, without the root, wrapped.

  On a desktop browser, a name wider than its cell keeps its end visible.
- [ ] **AC18 — loading, failure and retry.** While the files are being read the table's place
  shows the loading line. When the read fails it shows `could not read this run's files`, on both
  surfaces, and the totals stay. On the run page the next unfold reads again. A failed
  `show all` read keeps the 50 rows with the failure line beneath them, and the next click reads
  again.
- [ ] **AC19 — a newer coverage run.** With the Coverage tab open on a run of 60 files and all 60
  shown, a newer green coverage run of 3 files arriving makes the tab show that run's 3 files,
  its totals and no control. A read for the older run that answers after the newer run arrived
  does not replace the newer run's files.
- [ ] **AC20 — the state outlives a refresh.** With the Coverage tab showing all 60 files, a
  frame that leaves `latestCoverageEventId` unchanged keeps the 60 rows and sends no request.
  The same holds for an unfolded run page.
- [ ] **AC21 — docs and hygiene.** The §S6 texts are present. The code and tests carry no CR id
  literal.

## Estimated size

11 points:

- the three codecs' per-file reading and the joined decode (2);
- the table, its order, its write and its removal with the run (2);
- the ingest answer, the count on `?depth=suites` and the `?depth=coverage` read (2);
- the shared table on both surfaces, the fold, `show all` and the phone band (4);
- the table's state per run, the retry and touch (1).

## Risk

- **Storage.** Measured on this repository's own `lcov` report: 25 files, about 108 bytes a
  file. A run's rows grow with its file count and are held for as long as retention holds the
  run; a project of thousands of files stores that many rows per coverage run. No cap is added:
  a capped list would no longer sum to the totals.
- **The run-detail table list.** `RUN_DETAIL_TABLES` is also read by `migrateMilestoneRecords`,
  which deletes only from the tables that exist, and was read by the run-detail chain step's
  `satisfiedBy`, which now names its own six (§S2, AC10).
- **Names are stored whole.** An absolute name carries the directory layout of the machine that
  ran the tests onto the board. The board shows it only as a row's `title`.

## Non-goals

- The clients: a coverage run's envelope, the `run` verb's file list and the gate's envelope are
  CR-CRU-250.
- Uncovered line numbers, and branches per file.
- Per-file thresholds, and files grouped by source root.
- A per-file trend: the coverage trend stays the run totals.
- Sort controls or a filter on the file table.
- Files for a run already stored, and files on `/api/v2/runs/parsed`.
