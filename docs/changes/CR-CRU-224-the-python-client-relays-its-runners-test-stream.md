# CR-CRU-224 — the python client relays its runner's test stream

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200 · **Status** PENDING — filed 2026-10-30 (split
from CR-CRU-200 at its gap analysis, user ruling: split by layer — the live view, CR-CRU-223, the board, CR-CRU-200, then this
CR, the client; pytest keeps its JUnit record)

## Problem

Once the board takes a test stream on an open run and keeps it as the run's record (CR-CRU-200), something has to write the
stream and send it. `DN-crucible-live-test-progress.md` settles both: the runner writes the Crucible event shape to a file the
client names through an environment variable, and a shared client relay follows the file and sends it, as written, in
throttled batches, to the run the client opened. The python client's own unittest runner (`clients/subtest_runner.py`) is the
runner Crucible owns, so it is where the stream is proven first.

## Design (user rulings 2026-10-20 and 2026-10-30)

- **The relay decodes nothing.** It follows the stream file, sends what was written since the last batch, in throttled
  batches, to the open run, and at close sends whatever the board has not acknowledged before closing the run.
- **The relay is shared**, in the run module (`clients/_crucible_run.py`), for every stack's client to use as its runner
  gains a stream (CR-CRU-201 to CR-CRU-203).
- **The python unittest runner emits the stream**, and a unittest run's record is its stream, not its JUnit report; a pytest
  run keeps its JUnit report and its narration.

## Steps

To be written at this CR's gap analysis when its turn comes, after CR-CRU-200 (Rule 20): the relay (cadence, its limits, the
acknowledgement it follows, its exits), `subtest_runner.py`'s events (every subtest one test, as it counts them today), the
python client's switch from JUnit to the stream for a unittest run, and the narration the stream replaces.

## Acceptance criteria

To be made exact at its gap analysis. These hold under any design:

- [ ] A python unittest run's tests reach the board one by one while it runs, through the real client and the real runner,
      and the open run's live state shows each finished test and each failure before the run ends.
- [ ] A python unittest run's stored result, decoded from its stream, equals the result its JUnit report gave for the same
      tests, asserted on a real run before the JUnit path is removed.
- [ ] A batch the board never received during the run is delivered at close.
- [ ] A run killed before its first test leaves the open run aborted, as today; a pytest run is filed from its JUnit report,
      as today.

## Non-goals

- The board's side (CR-CRU-200) and its view (CR-CRU-223).
- Any other stack's stream (CR-CRU-201 to CR-CRU-203; go with CR-CRU-195), and a pytest stream.
