# CR-CRU-200 — an open run takes its test stream and shows it live

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-152, CR-CRU-206 (every stack's reports decoded on the board) · **Status**
PENDING — filed 2026-10-20 (user ruling: live progress designed after CR-CRU-194, split from
CR-CRU-152; design in `DN-crucible-live-test-progress.md`)

## Problem

A run's live progress is a count, not data. While a run works, each client counts console lines
matching one stack-specific pattern and sends `running N/M · <file>` as an agent heartbeat. The board
learns no test name, status or failure until the final report arrives, and a runner the pattern does
not know narrates nothing (a Vitest run, measured).

## Scope

- **§S1 — the Crucible event shape.** Newline-delimited JSON: a run-start event carrying the
  runner's total when it has one, a test-end event per test (id, name, file, status, duration,
  failure), and a run-end event carrying the runner's own totals. A board codec, `crucible-events`,
  decodes it into the canonical RunSchema.
- **§S2 — the stream reaches the open run.** The runner writes its stream to a file the client names
  through an environment variable. The shared client relay follows the file and sends it, as
  written and in throttled batches, to the run the client opened; the board decodes each batch with
  the stream's declared codec. The relay decodes nothing.
- **§S3 — the stream is the record.** At close the client sends whatever the board has not
  acknowledged, so the board holds the whole stream; no final test report is read for a streamed
  run. A run whose tests disagree with the run-end totals is flagged, not trusted. Coverage stays a
  final report.
- **§S4 — the board shows the open run live.** The open run's live state (completed of total,
  current file, every failure as it happens) is kept by the board and pushed over the live feed, and
  the board shows it (a storyboard frame settles where, before RED). It replaces the narration count
  for a streamed run.
- **§S5 — proven on the runner Crucible owns.** The python client's own unittest runner emits the
  stream, and the python client declares and relays it; every unittest run reaches the board as a
  stream. A pytest run (CR-CRU-197) keeps its JUnit record unless this CR's gap analysis settles a
  pytest source.

## Acceptance criteria

To be made exact at gap analysis, against the storyboard frame. These hold under any design:

- [ ] A python run's tests reach the board one by one while it runs, through the real client and the
      real runner, and the open run's state on the board shows each completed test and each failure
      before the run ends.
- [ ] A python run's stored result is decoded from its stream by `crucible-events` and equals the
      result the JUnit report gave for the same tests, asserted on a real run before the JUnit path
      is removed.
- [ ] A batch the board never received during the run is delivered at close; a stream whose tests
      disagree with its run-end totals stores a run that says so.
- [ ] A run that streams nothing (killed before its first test) leaves the open run aborted, as
      today.

## Non-goals

- Any other stack's stream (CR-CRU-201 to CR-CRU-203; go with CR-CRU-195).
- A coverage stream.
