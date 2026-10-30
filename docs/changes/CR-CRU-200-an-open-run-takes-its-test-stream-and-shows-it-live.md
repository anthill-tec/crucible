# CR-CRU-200 — an open run takes its test stream, and the board keeps it as the run's record

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-223 · **Status** PENDING — filed
2026-10-20 (user ruling: live progress designed after CR-CRU-194, split from CR-CRU-152; design in
`DN-crucible-live-test-progress.md`); re-scoped 2026-10-30 at its gap analysis (user rulings: split by layer — the live view
first, CR-CRU-223, then this CR, the board, then the client, CR-CRU-224; a stream's batches persist and the run is decoded
from the stored stream at close; pytest keeps its JUnit record). The file keeps its first slug.

## Problem

A run's live progress is a count, not data. While a run works, each client counts console lines matching one stack-specific
pattern and sends `running N/M · <file>` as an agent heartbeat; the board learns no test name, status or failure until the
final report arrives, and a runner the pattern does not know narrates nothing. `DN-crucible-live-test-progress.md` settles
the answer: the runner writes a structured event stream, the client relays it to the run it opened, and the board decodes it
as it arrives and keeps it as the run's record. This CR is the board's part: the route the stream reaches, where it is kept,
the codec that reads it, the record made from it at close, and the live state CR-CRU-223 shows.

## Design (user rulings 2026-10-20 and 2026-10-30)

- **One Crucible event shape**, newline-delimited JSON: a run-start event carrying the runner's total when it has one, a
  test-end event per test (id, name, suite, file, status, duration, failure), and a run-end event carrying the runner's own
  totals. The board's `crucible-events` codec decodes it into the canonical run.
- **The stream reaches the open run** in batches the client sends as written; the board decodes each batch with the stream's
  declared codec and acknowledges how much of the stream it holds.
- **The batches persist** (a new table, a versioned migration), so a board restart loses nothing it acknowledged; at close the
  run is decoded from the stored stream, and the stream is kept as the run's raw report within the ingest bounds.
- **The stream is the record.** No final test report is read for a streamed run. A run whose tests disagree with the run-end
  totals is stored flagged, not trusted. Coverage stays a final report.
- **The live state** CR-CRU-223 defines (`openRunBrief`'s `live`, `GET /api/v2/runs/<runId>/live`) is filled from the stream
  as it arrives and pushed over the live feed; for a streamed run it replaces the narration count.

## Steps

### §S1 — the event shape and the `crucible-events` codec

To be written at this CR's re-run gap analysis (Rule 20), when its turn comes after CR-CRU-223, against `DN-crucible-live-test-progress.md` §Event format and the
canonical run (`src/types.ts`).

### §S2 — the stream route and its storage

To be written at this CR's re-run gap analysis (Rule 20), when its turn comes after CR-CRU-223: the route an open run takes a batch on, its acknowledgement, the table and
migration that keep the batches, and the bounds (`limits`) on a batch and a stream.

### §S3 — the record at close

To be written at this CR's re-run gap analysis (Rule 20), when its turn comes after CR-CRU-223: how a streamed run closes (the batches not yet acknowledged, then the
close), the run decoded from the stored stream, the completeness flag, the final coverage report, and a run that streamed
nothing (aborted, as today).

### §S4 — the live state

To be written at this CR's re-run gap analysis (Rule 20), when its turn comes after CR-CRU-223: the live state filled from each batch, as CR-CRU-223 §S1 defines it, the
change frame it emits, and the narration it replaces for a streamed run.

## Acceptance criteria

To be made exact at its re-run gap analysis. These hold under any design:

- [ ] A stream sent in batches to an open run is decoded batch by batch, and the open run's live state (CR-CRU-223 §S1) shows
      each finished test and each failure before the run closes.
- [ ] A streamed run's stored result is decoded from its stream by `crucible-events` and equals the result a JUnit report of
      the same tests gives (the CR-CRU-152 fixtures, re-expressed as streams).
- [ ] A batch the board acknowledged survives a board restart; a stream whose tests disagree with its run-end totals stores a
      run that says so.
- [ ] A run that streams nothing leaves the open run aborted, as today.

## Non-goals

- The live view (CR-CRU-223) and the client's relay and the python runner's stream (CR-CRU-224).
- Any other stack's stream (CR-CRU-201 to CR-CRU-203; go with CR-CRU-195), and a pytest stream.
- A coverage stream.
