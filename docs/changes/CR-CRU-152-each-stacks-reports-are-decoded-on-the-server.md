# CR-CRU-152 — each stack's reports are decoded on the server

**Type** feature · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-151 · **Status** PENDING — filed
2026-09-24

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

## Acceptance criteria

To be written at gap analysis, per the design settled there. Two constraints survive any design:

- [ ] For each of the five stacks, a run ingested by that stack's client is decoded by a server codec
      and stored with that codec's name. Asserted per stack from a REAL report that stack's runner
      produced, checked in as a fixture.
- [ ] No summary, verdict or coverage figure changes for the same report. The server decode equals
      today's client decode on every fixture, asserted before the client parser is removed.

## Non-goals

- New stacks. Only the five supported ones.
- `vitest`, `tap`, `nextest` as separate codecs. The PRD lists them, but no supported stack emits a
  format that needs one (nextest writes JUnit). The PRD is corrected separately.
