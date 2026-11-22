# CR-CRU-272: the board UI and the clients take their intervals as settings

**Status:** PENDING. Filed 2026-11-22, from the test-cull survey (`test-reports/work/cull-survey-report.md` §6 item 2,
§6 item 3 and §7 slice 13). User ruling: filed after the cull, ahead of CR-CRU-267. The gap analysis follows this
filing.
**Type:** maintenance
**Points:** 5
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** test-speed, ui, clients
**Design reference:** `test-reports/work/cull-survey-report.md` (§1 "Where the time is", the bun and python top-20
tables, §6, §7 slice 13).

## Problem

About 40 bun tests and a set of python tests wait on real wall-clock time. That time is spent inside production timers
that are hard-coded:

- **`public/app.js`:**
  - the 5 s poll;
  - the 10 s cycle-timer tick;
  - the 5 s watchdog;
  - the SSE keep-alive window.
- **The clients:**
  - the 10 s read timeout against a silent board;
  - the narrator's ≥ 2 s cadence;
  - the relay and ladder windows of about 4 s.

A test that checks behaviour across one tick has to wait out the real interval. The survey measured the cost in the
latest gate:

- **bun:** about 265 s of real waits. The heaviest are `cycle-timers` (four tests of 11–21 s), `shell-final-form`
  (26 s), `v2-stream-paging` (15 s), `plans-read-timeout-envelope` (2 × 10 s), and 22 tests that wait on the real 5 s
  poll through `waitForPollTick`.
- **python:** about 100 s or more of real cadence windows.

These waits also make the tests sensitive to machine load.

## Behaviour

- **S1. The UI's intervals are settings with today's defaults.** The poll, the tick, the watchdog and the keep-alive
  window in `public/app.js` are read from one place, holding today's values. The production values do not change. A
  test page can set them smaller, as the UI's test harness already sets other page state. The gap analysis chooses the
  mechanism.
- **S2. The clients' waits are settings with today's defaults.** The board read timeout and the narrator, relay and
  ladder cadences are read from one place in the shared client modules, holding today's values. A test can set them
  smaller. A user can set none of them: they are not new configuration keys or flags, unless the gap analysis finds a
  user need.
- **S3. The waiting tests run on the short intervals.** Each test that today waits out a real interval sets the short
  one and keeps its assertion about behaviour across a tick. No test is deleted to gain speed.

## Acceptance criteria

- **AC1.** With no setting given, the UI and the clients use exactly today's intervals. A unit test reads the defaults
  from the module that holds them.
- **AC2.** The bun tests named in the survey's real-wait list finish without any wait longer than 1 s. Their summed
  time in a full gate drops by at least 200 s against `test-reports/work/cull-gate.out`.
- **AC3.** The python tests in the survey's cadence list run on short cadences. Python integration time in a full gate
  drops by at least 60 s against the same baseline.
- **AC4.** Every converted test still fails against the regression it guards. A tick that never fires, or a timeout
  that never trips, must still turn the test red. RED proves this for each test.
- **AC5.** No CHANGELOG entry, unless the gap analysis adds a user-visible setting.

## Non-goals

- Changing any production interval value.
- New configuration keys or CLI flags for users.
- The e2e tier.
