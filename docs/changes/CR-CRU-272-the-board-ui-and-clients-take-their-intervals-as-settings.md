# CR-CRU-272: the board UI and the clients take their intervals as settings

**Status:** PENDING. Filed 2026-11-22 from the test-cull survey (`test-reports/work/cull-survey-report.md` §6 and §7
slice 13), with the user's ruling that it follows the cull and comes ahead of CR-CRU-267. Revised the same day by the
gap analysis (`test-reports/work/cr272-gap-analysis.md`, built on `test-reports/work/cr272-survey-report.md`) and by
the user's rulings R1–R3.
**Type:** maintenance
**Points:** 8. By user ruling R1 this is one CR delivered in two cycles: S1 for the UI and server, S2 for the clients.
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** test-speed, ui, server, clients
**Design reference:** `test-reports/work/cr272-survey-report.md` (§1 timers, §3 waiting tests, §4 mechanisms, §5 cost).

## Problem

Many integration tests wait out real production intervals, because those intervals are fixed in code. A test that
checks behaviour across one tick has to sit through a whole real tick. In the cr273 gate this cost:

- **bun:** 32 tests and 267 s, all in `tests/integration`. They wait on the UI's 5 s poll, the 10 s cycle-timer tick,
  the 5 s watchdog with its 20 s silence window, the server's 15 s SSE keep-alive, and the client's 10 s board read
  timeout.
- **python integration:** about 210 s. Tests wait on the relay and stream-tick cadence (2 s), the narrator throttle
  (2 s) and the gate-run interim-snapshot cadence (2.0 s / 0.4 s). Most of these tests run the real client as an OS
  process, and nothing can reach its timers today.

These waits also make the suites sensitive to machine load.

## Behaviour

### S1: the UI and the server (cycle 1)

- **S1a. The six UI intervals live in one place.** `public/app-logic.mjs` exports them on the existing
  `window.CrucibleLogic` bridge, with today's values:

  | Interval | Value |
  |---|---|
  | poll | 5000 ms |
  | cycle-timer tick | 10 000 ms |
  | run-card tick | 1000 ms |
  | watchdog | 5000 ms |
  | watchdog silence window | 20 000 ms |
  | SSE reconnect | 5000 ms |

  `public/app.js` reads each of them from that one place. The test harness may replace the set after it imports
  `app-logic.mjs` and before it evaluates `app.js`. No new global hook is added.
- **S1b. The server's SSE keep-alive is an option.** `CreateBoardOpts` and `StartServerOpts` gain `keepAliveMs`,
  defaulting to 15 000. `handleStream` uses it. No configuration key or CLI flag reads it.

### S2: the clients (cycle 2)

- **S2a. One settings object for client cadences.** It lives in the shared module (`clients/_crucible_run.py`) and
  is reachable through `_crucible_axi`. It holds, with today's values:

  | Setting | Value |
  |---|---|
  | relay and stream-tick cadence | 2.0 s |
  | narrator throttle | 2.0 s |
  | gate-run poll cadence | 2.0 s |
  | gate-run poll tick | 0.4 s |
  | board read timeout | 10 s |

- **S2b. Settings are read when they are used.** `RunNarrator` and each client's `_get` read the setting when they
  are called, not as default arguments bound when the function is defined. The six copies of `_get` read the one
  setting.
- **S2c. Users set none of these.** There is no environment variable, configuration key or CLI flag for them. Tests
  reach a running client through a **test-only launcher** under `tests/client/` (user ruling R2). The launcher loads
  the client by path, sets short cadences, and runs the client's `main()` in the same process. Production code never
  reads it, and signal and exit-code tests keep their meaning.

### S3: the converted tests

- **S3a. What converts.** Each test that waits out a real interval sets a short one and keeps its assertion about
  behaviour across a tick. No test is deleted to gain speed.
- **S3b. Negative windows scale.** Windows that show something did *not* happen, such as `QUIET_WAIT` and the
  ladder's "held across several windows", scale with the injected cadence, so they still span several ticks.
- **S3c. Timeout bounds shrink.** A timeout test's own subprocess bound shrinks with the cadence, so a timeout that
  never trips turns red quickly.
- **S3d. Shared UI wait.** The poll-tick wait becomes one shared UI test helper, not 12 copies.

## Acceptance criteria

- **AC1. Defaults unchanged, observed on production code.** With no setting given, production code runs with today's
  values. This is observed on the code itself, not read from source:
  - the timers that `app.js` creates on mount, intercepted, carry 5000, 10 000, 1000 and 5000;
  - the watchdog treats 20 s of silence as its threshold;
  - `handleStream` schedules its keep-alive at 15 000;
  - the relay waits 2.0 s;
  - the narrator throttles at 2.0 s;
  - `_get` passes `timeout=10`;
  - the gate-run poll uses 2.0 s and 0.4 s.
- **AC2. The bun waits shrink.** In the bun tests named in the survey's §3 bun table, no timer wait exceeds 1 s. The
  `uv` start-up time in the plans-timeout tests is not a timer wait. These tests' summed time in a full gate drops by
  at least 200 s against `test-reports/work/cr273-gate.out`.
- **AC3. The python waits shrink.** These modules run on short cadences through the launcher:
  - the bun, maven and rust relay modules;
  - `test_a_run_in_flight_streams_its_ladder`;
  - `test_a_streamed_runs_in_run_count_comes_from_its_stream`;
  - `test_a_streamed_python_run_reaches_the_board_while_it_works`;
  - the gate-run identity test and the gate-run test in `test_bun_crucible_gates`.

  Python integration time in a full gate drops by at least 120 s against `test-reports/work/cr273-gate.out`.
- **AC4. Every converted test still catches its regression.** A tick that never fires, a relay that never wakes, or a
  timeout that never trips turns the test red. RED proves this for each converted group.
- **AC5. No CHANGELOG entry.** Nothing user-visible changes.

## Non-goals

- Changing any production interval value.
- Configuration keys, CLI flags or environment variables for users.
- **The go tick tests,** unless the go harness takes the launcher with a few lines (user ruling R3). If it does, they
  join AC3. If not, they stay as they are, and RED or GREEN says which.
- **The bun-side client tests** `clients-narration` and `gate-run-release-inheritance`, by user ruling R3.
- **Timers no test waits on:** the locate-blink timeouts (already intercepted in tests) and `LIVE_FRAME_MS`.
- **Tests bound by a real toolchain:** `test_client_unit_tier_wall_vs_cpu`, the playwright reporters, and the e2e
  tier.
