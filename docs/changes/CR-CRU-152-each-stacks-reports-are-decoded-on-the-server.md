# CR-CRU-152 — each stack's reports are decoded on the server

**Type** feature · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-151 · **Status** PENDING — filed
2026-09-24; live test progress folded in 2026-10-20 (user ruling, `DN-crucible-live-test-progress.md`)

## Problem

**User direction (2026-09-24):** *"We have specific test runner and reporting strategies per Stack we
support, and the backend codec on the server is supposed to support that. If there are any gaps in
this support it has to be addressed as separate features."*

PRD §4.4 (design revision 2026-07-14) replaced client-side parsers with a **server codec registry**
that translates each tool's native output into one canonical RunSchema: *"Adding a stack = adding a
codec; no core changes."* The events it stores are stamped with the codec that normalised them.

**Measured 2026-09-24:**

- **Only two test codecs exist:** `junit` and `playwright` (`src/codecs/index.ts`).
- **Four of five clients parse their own reports** and post the result to `/api/v2/runs/parsed`,
  which stores it as `codec: "parsed"`:

  | Client | Runner | Report it produces | Where it is parsed |
  |---|---|---|---|
  | bun | `bun test --reporter=junit` | JUnit XML; lcov coverage | client |
  | python | `unittest` + `xmlrunner` | JUnit XML; coverage.py | client |
  | mvn | `mvn` / surefire | `TEST-*.xml` JUnit; JaCoCo CSV | client |
  | arduino | native host g++ harness (`make`) | JUnit XML; lcov | client |
  | rust | `cargo nextest` (+ `cargo llvm-cov`) | JUnit XML; lcov | **server `junit` codec** on its main path, client on others |

- **Stored codec distribution:** Crucible v2 dev board 278 `parsed`, 17 `playwright`, 5 unknown;
  Sandesh 18 `parsed`; Model B (prod) 238 `parsed`. The real format is not recorded on any of them.
- **Coverage** (lcov, coverage.py, JaCoCo, llvm-cov) is summarised client-side in every client and
  posted as percentages. No coverage format has a server codec.

So the same JUnit semantics live in four client parsers and one server codec, and they can drift.
The PRD's own parity clause ("`junit` with exactly the client parsers' semantics") exists because
of that risk. The board cannot say which tool a run came from.

**Live progress is a count, not data (2026-10-20).** While a run works, each client counts console
lines matching one stack-specific pattern and sends `running N/M · <file>` as a heartbeat. The board
learns no test name, status or failure until the final report. A runner the pattern does not know
narrates nothing (a Vitest run, measured). `crucible.rawReport` misnames the runner's full report the
board decodes.

## Scope — the design is this CR's gap analysis to settle, with the user

- **§S1 — raw reports reach the server.** Each client sends its runner's native report(s) to a
  server codec, test results and coverage alike, instead of a client-computed summary.
- **§S2 — a codec per strategy, not per client.** Reuse is expected: bun, python, maven, arduino and
  rust all emit JUnit, so `junit` may already serve them all, with measured dialect differences (bun
  nests suites; surefire writes one file per class; xmlrunner writes one file per module; nextest
  adds `flaky`/`rerun` elements). Coverage needs codecs: lcov (bun, rust, arduino), coverage.py
  (python), JaCoCo (maven).
- **§S3 — the stored event names the codec that decoded it**, never `parsed`.
- **§S4 — the parsed path.** The PRD keeps it ("accept summary/tree/coverage as-is"). This CR decides
  whether it stays as a documented fallback or is retired for the five clients, and says why.
- **§S5 — a run streams its tests to the board.** While the runner works, an event stream is written
  to a file the client names through an environment variable; the client relays it, as written and
  in throttled batches, to the run it opened; the board decodes it with the stream's declared codec
  and pushes the open run's live state (completed of total, current file, failures as they happen,
  Playwright's steps) over the live feed. The narration count is superseded.
- **§S6 — the stream codecs.** One Crucible event shape (newline-delimited JSON: a run-start event
  with the runner's total, a test-end event per test, a run-end event with the runner's totals),
  decoded by a `crucible-events` codec; native streams keep their own codecs: nextest's libtest
  JSON, bun's console result lines (`bun-console`); go's `test2json` lands with its client.
- **§S7 — the stream is the record.** Where a runner streams structured events (Vitest and
  Playwright through the reporters Crucible ships, nextest, the python and arduino runners Crucible
  owns), the stream file is the run's record and no final test report is read: the client sends
  what the board has not acknowledged at close, and a run whose tests disagree with the run-end
  totals is flagged. Where the stream is console only (`bun test`, maven), the JUnit report stays
  the record. Coverage stays a final report on every stack. Playwright's JSON report and the
  `playwright` codec retire once nothing declares them.
- **§S8 — the reporters ship with the clients.** The Vitest and Playwright reporters that emit the
  Crucible shape ship in the client install; the client hands their location to the runner through
  a variable Crucible fixes, so a project's config names no machine path and runs unchanged without
  a client.
- **§S9 — one declaration per target, clean break.** A bun project declares per script
  `crucible.targets.<script>`: either a `stream` (codec and path) or a `junit` report (`flag` or
  `env:<VAR>`) with an optional `console` codec. `crucible.reportPath` and `crucible.rawReport` are
  refused, naming the table that replaces them. The other stacks declare the same facts in
  `crucible.toml`.

## Acceptance criteria

To be written at gap analysis, per the design settled there. Two constraints survive any design:

- [ ] For each of the five stacks, a run ingested by that stack's client is decoded by a server codec
      and stored with that codec's name. Asserted per stack from a REAL report that stack's runner
      produced, checked in as a fixture.
- [ ] No summary, verdict or coverage figure changes for the same report. The server decode equals
      today's client decode on every fixture, asserted before the client parser is removed.

## Non-goals

- New stacks. Only the five supported ones.
- `vitest` and `tap` as codecs: Vitest streams the Crucible shape through the shipped reporter. The
  PRD is corrected separately.
- Go's stream codec; it lands with the go client.
