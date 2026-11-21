# CR-CRU-152 — each stack's reports are decoded on the server

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-151, CR-CRU-205 (every gate is red
until it lands) · **Status**
DONE — merged 2026-10-27 (plan 208, cycles 741–746, gate 8387/0); filed 2026-09-24; designed at gap analysis 2026-10-27 (split: the bounds are CR-CRU-207; the
clients' side is CR-CRU-204 for bun and python, CR-CRU-206 for maven, rust and arduino)

## Problem

**User direction (2026-09-24):** *"We have specific test runner and reporting strategies per Stack we
support, and the backend codec on the server is supposed to support that. If there are any gaps in
this support it has to be addressed as separate features."*

PRD §4.4 (design revision 2026-07-14) replaced client-side parsers with a **server codec registry**
that translates each tool's native output into one canonical RunSchema: *"Adding a stack = adding a
codec; no core changes."* The events it stores are stamped with the codec that normalised them.

**Measured 2026-09-24, re-read 2026-10-27:**

- **Two test codecs exist:** `junit` and `playwright` (`src/codecs/index.ts`). No coverage codec exists.
- **Every client parses its own JUnit and coverage** and posts the result to `/api/v2/runs/parsed`,
  which stores it as `codec: "parsed"`. The rust and maven clients send a report to the server's
  `junit` codec on a few verbs (as `dataPath`), but fall back to their own parse whenever coverage
  or more than one report directory is involved: `POST /api/v2/runs` carries no coverage and no
  captured output.

  | Client | Runner | Test report | Coverage report |
  |---|---|---|---|
  | bun | `bun test --reporter=junit` | one JUnit file; a failure's detail is mostly on the console | lcov |
  | python | `clients/subtest_runner.py` (xmlrunner), or `pytest` | one `TEST-*.xml` per module; pytest one file, one `pytest` suite | coverage.py, converted by `coverage lcov` |
  | mvn | `mvn` / surefire and failsafe | one `TEST-*.xml` per class, one directory per module | JaCoCo CSV |
  | arduino | native host g++ harness (`make junit`) | one `TEST-*.xml` per native test binary | lcov |
  | rust | `cargo nextest` (+ `cargo llvm-cov`) | one JUnit file | lcov |

- **The five client parses differ from each other and from the server's `junit` codec:** only the
  bun client keeps failure text (taking it from bun's console, since bun's `<failure/>` is mostly
  bare); the python, mvn, rust and arduino clients keep none. A missing name is `?` in the clients
  and empty on the server (arduino's suite `native`, mvn's the file name). bun and python drop empty
  suites, the others keep them; mvn and arduino read one level of nesting, the rest recurse. arduino
  stores every duration as 0 and sums `files` across reports. The clients round coverage percents
  with Python's `round`, which a naive JavaScript rounding differs from (1/80 → 1.2 vs 1.3).
- **Stored codec distribution (2026-09-24):** Crucible v2 dev board 278 `parsed`, 17 `playwright`,
  5 unknown; Sandesh 18 `parsed`; Model B (prod) 238 `parsed`.

## Design (user rulings, 2026-10-27)

- **Split.** This CR is the board's decode. CR-CRU-207 bounds what an ingest may carry. CR-CRU-204
  moves the bun and python clients onto both, CR-CRU-206 the maven, rust and arduino clients.
- **The clients parse nothing** beyond the runner's exit code and counts of testcases (CR-CRU-204,
  CR-CRU-206). The board answers every figure a client's envelope reports.
- **Reports travel inline**, in the request body.
- **Figures exact, tree unified.** A run's counts, verdicts and coverage figures equal what that
  stack's client computes today, exactly. The tree follows one rule for every stack, and each way it
  differs from a client's today is listed below as a deliberate change.
- **A malformed report in a list is skipped with a warning; an undecodable coverage text is dropped
  with a warning**, and the test results are stored.
- **CR-CRU-193 follows this CR:** per-file coverage is decoded by this CR's coverage codecs.

## Steps

### §S1 — `POST /api/v2/runs` takes a run's whole report set

Beside today's `codec`, `data` / `dataPath`, `tier`, `context`, `runId`, `stack` and `release`:

- **`data` as a list.** `data` is one report text or a non-empty list of them, decoded in list order
  and merged into one run. An empty list is refused with 400, nothing stored. A text that cannot be
  decoded is skipped and named in the response's `warnings[]`; when no text decodes, the run is
  refused with 400 and nothing is stored.
- **`coverage`** — optional `{ "codec": "<name>", "data": <text or non-empty list of texts> }` (an
  empty list is refused with 400, nothing stored),
  decoded by the named coverage codec (§S3). An unknown coverage codec is refused with 400, nothing
  stored. A coverage text the codec cannot decode drops the coverage, stores the run and warns. A
  failing run's coverage is discarded as it is on the parsed route, with the same `coverageDropped`
  hint.
- **`raw`** — optional captured runner output. It is stored as the run's raw output: the parts are
  the body's `raw`, then each report's `<testsuites>`- and `<testsuite>`-level `<system-out>` /
  `<system-err>` text in report order (testcase-level output is not collected, as today); each part
  is trimmed, empty parts are dropped, and the rest are joined by `"\n"`. A codec reads it (§S2).
  CR-CRU-207 caps what is stored.
- **`warnings[]`** — each entry `{code, detail}`, the shape the client envelopes use:
  `report-skipped` (detail names the list index and the decode error) and `coverage-dropped`
  (detail names the coverage codec and the error).
- **`dataPath`** stays accepted and is read by the same rules (§S2, §S4).
- **Decode order.** The run's effective stack (§S2) is resolved before the codec runs.

### §S2 — one JUnit reading for every stack

- **Counts and verdicts:** a case is failed when it has a `<failure>` or `<error>`, else pending
  when it has `<skipped>`, else passed; every case found at any depth counts. Unchanged.
- **The tree:** one node per `<testsuite>` that holds testcases directly, at any depth; a suite
  holding none is not a node; a missing or empty suite or case name is `?`. (Deliberate: mvn, rust
  and arduino kept empty suites; mvn and arduino read one level; arduino named a nameless suite
  `native` and mvn its file.)
- **python / pytest:** when the run's stack is `python` and a report's only suite is named
  `pytest`, its cases are grouped into one node per non-empty `classname` (a case with none joins
  the node `pytest`), in first-seen order. (Deliberate: the python client's `auto-ingest` never
  grouped.)
- **Failure text, every stack:** a failure's `message` is its non-empty `message` attribute, else
  the first non-empty line of its text; its `trace` is its text; its `type` is its `type` attribute.
  Each part is present only when non-empty; message cut at 1000 characters, trace at 8000.
  (Deliberate: python, mvn, rust and arduino kept no failure text; the server's `"test failed"`
  default goes.)
- **bun's console:** when the run's stack is `bun`, a failing case whose message is empty takes its
  message and trace from bun's console output in `raw`, by the rules the bun client applies today.
  The reading lives in its own module (`src/codecs/bun-console.ts`), which CR-CRU-201's live view
  reuses. A case the console does not explain keeps its type-only failure.
- **Durations:** a case's `time` in milliseconds, `Math.round(seconds * 1000)`. (Deliberate: the clients truncated;
  arduino sent 0.)
- **The stack:** the ingest's `stack`, else the stack its run's start stated. With none, or an
  unknown one, the report is read with no stack-specific rule.
- **The distinct-file count:** a case's non-empty `file`, else its non-empty `classname`, else its
  suite's name, with `\` read as `/`, counted once across the whole run. (Deliberate: arduino summed
  per report.)

### §S3 — coverage codecs

- **`lcov`**: sums `LF`/`LH` into lines and `FNF`/`FNH` into functions.
- **`jacoco`**: sums the JaCoCo CSV's `LINE_*`, `METHOD_*` and `BRANCH_*` columns into lines,
  functions and branches.
- Each axis is `{total, covered, percent}`. `percent` is the double `covered / total * 100` rounded
  to one decimal by its **exact decimal value, ties to even** (the result Python's `round(x, 1)`
  gives today), and 0 when `total` is 0. Several texts are summed as one. A text is undecodable when
  it carries none of the codec's records (lcov: no `SF:` record; jacoco: no header row with those
  columns). (Deliberate: an lcov file with no `SF:` record was stored as 0/0 coverage; it is now
  dropped with a warning.)

### §S4 — the response says what a client's envelope needs

The `/api/v2/runs` response's `run` block carries `passed`, `failed`, `pending`, `total`, `files`,
and, on a run that kept coverage, `coverage: {lines, functions, branches?}` with each axis as
`{total, covered, percent}`. `files` is computed per response and never stored. A `playwright`
run's `files` is its count of distinct spec files. The response's `warnings[]` (§S1) is present
when non-empty.

Health (`/api/health`, `/api/v2/health`) carries `codecs: {test: [...], coverage: [...]}`, the names
this board decodes, so a client can tell a board that predates this CR before it sends.

### §S5 — the parsed route stays, for older clients

`POST /api/v2/runs/parsed` keeps its decode and response unchanged. Installed clients in other
projects post to it until they are upgraded.

### §S6 — the design documents follow

- PRD §4.4: `junit` reads every stack by §S2's rules (no longer "the client parsers' semantics");
  the coverage codecs; both routes answer with `run`; the parsed path is older clients' route; tool
  version is not stamped (a non-goal).
- `DN-crucible-live-test-progress.md`: its "Open for CR-CRU-152's gap analysis" section becomes
  CR-CRU-200's.
- CR-CRU-193: its "where is it decoded" question is settled (here); it and its index row depend on
  this CR.
- CR-CRU-201: its console view reuses `src/codecs/bun-console.ts`.

## Acceptance criteria

- [x] **AC1 — a real report per stack.** `tests/fixtures/reports/<stack>/` holds, for bun, python
      (the subtest runner's xmlrunner reports, and a pytest report), mvn (surefire and failsafe),
      rust and arduino, the test report(s) and coverage report(s) that stack's runner wrote on a
      real run with at least one passing, one failing and one skipped case; bun's captured console
      output; several report files for mvn, python and arduino, and the JaCoCo CSV the maven client
      selects. Paths are neutral; a README names the tool versions.
- [x] **AC2 — figures exact.** Beside each fixture, `expected.json` holds that stack's client parse
      of it at this CR's base (summary, coverage). Each fixture decoded through `POST /api/v2/runs`
      stores the same `total`, `passed`, `failed`, `pending`, every case's status, and the same
      coverage object, percents included.
- [x] **AC3 — the unified tree.** Each fixture's stored tree follows §S2: node per suite holding
      cases, empty suites absent, `?` for a missing or empty name, failure text present and cut as
      stated, durations rounded. A case for each deliberate change asserts the new reading.
- [x] **AC4 — bun's console.** Every bun console-matching case the bun client's tests pin today
      (the CR-CRU-087 and CR-CRU-088 cases and the console cases in
      `tests/clients-bun-crucible.test.ts`, including the plain wire form, a timeout detail printed
      after its result line, and an unresolvable echo) holds through the server, from `raw`, in
      `src/codecs/bun-console.ts`.
- [x] **AC5 — pytest grouping.** The pytest fixture under stack `python` decodes to one node per
      `classname` in first-seen order, a case with none in `pytest`; under another stack, or an
      xmlrunner report, it is grouped by suite.
- [x] **AC6 — the stack rule.** A run with no `stack`, and one with an unknown stack, decode with
      no stack-specific rule; a run whose ingest omits `stack` uses its start's, at decode time.
- [x] **AC7 — a list of reports.** Several texts decode to one run, in order, counts summed; one
      malformed text among good ones is skipped with a `report-skipped` warning whose detail names
      its list index and the decode error, and the rest stored;
      all malformed is 400 with nothing stored; `data: []` is 400. `dataPath` reads by the same
      rules.
- [x] **AC8 — coverage.** `lcov` and `jacoco` each yield AC2's coverage; an unknown coverage codec
      is 400 with nothing stored; an undecodable coverage text stores the run without coverage with a
      `coverage-dropped` warning; a failing run with coverage stores none and carries the
      `coverageDropped` hint; two coverage texts sum into one object; an empty coverage list is 400;
      a total of 0 gives percent 0; and over every (covered, total) pair with
      total below 1500 the percent equals Python's `round(covered / total * 100, 1)` (a generated
      oracle table).
- [x] **AC9 — raw.** The body's `raw` and the reports' wrapper- and suite-level output are stored
      as §S1 states (asserted string: trimmed parts, empty parts dropped, an absent or empty body
      `raw` adding no separator, joined by `"\n"`); bun's console match reads it.
- [x] **AC10 — the response.** The `run` block carries the five counts with `files` by §S2's chain
      (asserted on cases carrying `file`, only `classname`, an empty `classname`, and neither, and
      across two reports sharing a file), and on a run that kept coverage each axis as `{total,
      covered, percent}`; nothing named `files` is stored; a `playwright` run carries its spec-file
      count; both health routes carry `codecs: {test: ["junit", "playwright"], coverage: ["jacoco",
      "lcov"]}`.
- [x] **AC11 — older clients keep working.** A `/api/v2/runs/parsed` ingest stores and reads back
      as at this CR's base; the existing tests that pin it pass unchanged.
- [x] **AC12 — the documents.** PRD §4.4, the DN, CR-CRU-193 and its index row, and CR-CRU-201 say
      what §S6 states.

- *Recorded at merge:* the rust fixture holds no skipped case — nextest 0.9.130 writes no testcase for
  an `#[ignore]`d test (its README says so); AC1's skipped case is met by the other five fixtures. Three
  nits stand: `parseJunitPath` keeps a `console.warn` fallback its one caller never reaches, and
  `parseRunBody` a coverage fallback no test codec feeds; `bun-console.ts`'s `\s` and lcov's integer
  reading differ from Python's on characters real output does not carry; `Codec.readRaw` amends the
  tree in place.

## Non-goals

- Bounding an ingest (body size, stored raw output): CR-CRU-207.
- Changing any client: CR-CRU-204 (bun, python) and CR-CRU-206 (maven, rust, arduino).
- Per-file coverage: CR-CRU-193, which builds on this CR's coverage codecs.
- Stamping a tool version on a run.
- New stacks, and `vitest`, `tap` or `nextest` report codecs: no supported stack's final report
  needs one.
- A run's live test stream: CR-CRU-200 to CR-CRU-203 (`DN-crucible-live-test-progress.md`).
