# CR-CRU-272: the board UI and the clients take their intervals as settings

**Status:** PENDING. Filed 2026-11-22 from the test-cull survey (`test-reports/work/cull-survey-report.md` §6 and §7
slice 13). User ruling: it follows the cull and comes ahead of CR-CRU-267.

It was revised the same day three times:
- by the gap analysis (`test-reports/work/cr272-gap-analysis.md`, built on `test-reports/work/cr272-survey-report.md`);
- by the user's rulings R1–R3;
- by the spec pre-review (`test-reports/work/prereview272-report.md`, B1–B2, S1–S9 and Sug1–3, all folded in).

**Type:** maintenance
**Points:** 8. One CR in two cycles, by user ruling R1: S1 (the UI and the server), then S2 (the clients).
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** test-speed, ui, server, clients
**Design reference:** `test-reports/work/cr272-survey-report.md` §1–§5; `test-reports/work/prereview272-report.md`.

## Problem

Many integration tests wait out real production intervals, because those intervals are fixed in code. A test that
checks behaviour across one tick has to sit through a whole real tick. In the cr273 gate this cost:

- **bun:** 30 UI and server tests, about 247 s, all in `tests/integration`. They wait on the UI's 5 s poll, the 10 s
  cycle-timer tick, the 5 s watchdog with its 20 s silence window, and the server's 15 s SSE keep-alive. Two more bun
  tests, about 20 s, wait on the client's 10 s board read timeout.
- **python integration:** about 200 s in the modules named in AC3. They wait on the relay and stream-tick cadence
  (2 s), the narrator throttle (2 s) and the gate-run poll (2.0 s / 0.4 s). Most of these tests run the real client as
  an OS process, and nothing can reach its timers today.

These waits also make the suites sensitive to machine load.

## Behaviour

### S1: the UI and the server (cycle 1)

- **S1a. The six UI intervals live in one place.** `public/app-logic.mjs` builds a fresh plain object,
  `window.CrucibleLogic.intervals`, every time the module evaluates. Its values are today's:

  | Interval | Value | `app.js` site |
  |---|---|---|
  | `pollMs` | 5000 | `:863` |
  | `cycleTickMs` | 10 000 | `:1223–1225` |
  | `runTickMs` | 1000 | `:1234–1236` |
  | `watchdogMs` | 5000 | `:9311` |
  | `silenceMs` | 20 000 | `:874` |
  | `reconnectMs` | 5000 | `:845` |

  `public/app.js` reads `L.intervals.<name>` at each of these timer sites. No new global hook is added, and no
  exported constant is mutated.
- **S1b. The server's SSE keep-alive is an option.** `CreateBoardOpts` and `StartServerOpts` gain `keepAliveMs`,
  default 15 000, and `handleStream` uses it. No configuration key or CLI flag reads it.
- **S1c. Short intervals are opt-in per mount.**
  - The shared UI mount helper takes an optional `intervals` for one mount. It assigns a new object to
    `window.CrucibleLogic.intervals` after the `app-logic.mjs` import and before the `app.js` eval.
  - With none given, nothing changes and the production values run.
  - Only a test that waits on a timer passes short values, and only for its own mount, never for its whole file.
  - Tests that rely on no poll firing (for example `plan-scoping`'s single plans GET) keep the defaults.

### S2: the clients (cycle 2)

- **S2a. One mutable settings instance.** `clients/_crucible_run.py` holds one mutable settings instance, which
  `_crucible_axi` re-exports by identity. It holds today's values:

  | Setting | Value |
  |---|---|
  | relay and stream tick | 2.0 s |
  | narrator throttle | 2.0 s |
  | gate-run poll cadence | 2.0 s |
  | gate-run poll tick | 0.4 s |
  | board read timeout | 10 s |

  Readers read `SETTINGS.<attr>` at the point of use. Tests and the launcher set attributes on
  `client._axi().SETTINGS` and never rebind the name.
- **S2b. The old names go, and settings are read late.**
  - `RELAY_SECONDS`, `_GATE_POLL_CADENCE_S` and `_GATE_POLL_TICK_S` are removed, so a stale patch fails loudly.
  - The tests that patch them move to the settings object. That includes the "relay never wakes" patch of 60.0 s.
  - `RunNarrator(min_seconds=None)` reads the setting when it is constructed, and an explicit `min_seconds` still
    wins.
  - Each client's `_get(path, timeout=None)` reads the setting when it is called, and all six copies read the one
    setting.
- **S2c. A test-only launcher; users set nothing.**
  - There is no environment variable, configuration key or CLI flag for these settings.
  - Subprocess tests reach a running client through `tests/client/` (user ruling R2). The launcher is run by path,
    and its file is not named `test_*.py`, so test discovery never collects it.
  - It imports nothing from `tests.client`. It takes the client path the harness already spawns (`client_script` /
    `clientScript`, the test install) and loads that exact file. It never loads the repository's `clients/`, which
    would resolve the development board's `crucible.toml`.
  - It sets `sys.argv` to `[client path, *verb args]` and `sys.path[0]` to the client's directory, then sets short
    settings on `module._axi().SETTINGS`.
  - It calls `module.main()` on the main thread. It catches nothing and installs no signal handler, so signal tests
    and exit codes, including `128 + SIGINT`, keep their meaning.

### S3: the converted tests

- **S3a. Tests keep their assertions.** Each test that waits out a real interval sets a short one and keeps its
  assertion about behaviour across a tick. No test is deleted to gain speed.
  - A test whose assertion is about displayed elapsed time moves the clock with `setSystemTime`, then waits one short
    tick. This covers the `cycle-timers` badge, which renders whole seconds from `Date.now()`. Its cadence bounds
    (≥ 9 s, ≤ 15 s) are asserted on the clock it moved.
  - A real-clock wait that no production timer drives, such as `agent-runtime-pane`'s 1.2 s, is replaced the same
    way.
- **S3b. Windows and durations scale with the cadence.**
  - Negative windows, such as `QUIET_WAIT` and the ladder's "held across several windows", still span several ticks.
  - Fixture drive durations (`RUN_SECONDS`, `SHORT_RUN_SECONDS`, `LONG_RUN_SECONDS`, `FAKE_AFTER_DELAY`, `RELAY_WAIT`)
    scale with it.
  - Count bounds that depend on the cadence-to-run ratio (for example `len(gate_calls) ≤ 5`) still hold.
- **S3c. Timeout bounds shrink.** A test's own subprocess bound and its per-test timeout (bun's 20 000 and 35 000)
  shrink with the cadence, so a stalled tick fails fast.
- **S3d. One shared poll-tick wait.** `waitForPollTick` becomes one shared UI test helper. It waits until the next
  poll's fetch is observed, with a 1 s deadline, then settles. It waits on a condition, never on a duration.
- **S3e. Safe minimums.** Tests use no interval shorter than these:

  | Interval | Minimum |
  |---|---|
  | poll | 200 ms |
  | cycle-timer tick | 200 ms |
  | run-card tick | 200 ms |
  | watchdog | 100 ms, with a silence window of at least 300 ms (or the default window plus `setSystemTime`) |
  | keep-alive | 200 ms |
  | relay and stream tick | 0.2 s |
  | narrator throttle | 0.2 s |
  | gate poll cadence / tick | 0.3 s / 0.05 s |
  | read timeout | 1.0 s |

## Acceptance criteria

- **AC1. With no setting given, production code runs today's values.** Each value is observed on running production
  code, never read from source:
  - **UI timers.** Spy `setInterval` after happy-dom registers and before the eval, then mount with no override. The
    recorded intervals are the poll at 5000, then 10 000, 1000, and the watchdog at 5000.
  - **Reconnect.** A fake `EventSource` errors with `readyState = CLOSED`. A `setTimeout` spy records
    `connectStream` at 5000.
  - **Silence window.** Pin the clock at T0 before mount. At T0 + 20 000 the watchdog fetches nothing; at
    T0 + 20 001 it fetches `/api/v2/health`.
  - **Keep-alive.** In-process `createBoard`, then GET `/api/stream`. A `setInterval` spy records 15 000.
  - **Relay.** The relay's halt event records a wait of 2.0 s.
  - **Narrator.** With the clock patched, a completion at t + 1.999 s posts nothing and one at t + 2.0 s posts.
  - **`_get`.** For each of the six clients, `_get` passes `timeout=10`.
  - **Gate-run poll.** The ladder sleeps 0.4 s and polls 2.0 s apart.
- **AC2. The UI and server tests run in under 2 s each** in the gate's JUnit. Their summed time drops by at least
  180 s against `test-reports/work/cr273-gate.out`. The tests:
  - `cycle-timers`: the four tick tests;
  - `shell-final-form`: "server unreachable";
  - `v2-stream-paging`: the keep-alive test;
  - `agent-card-idle-and-refusal` and `gate-decision-trail`: the two-tick poll tests;
  - the 22 one-tick poll and watchdog tests:
    - `agent-runtime-pane` ×2;
    - `home-marker-parity`;
    - `inpane-liveness` ×5;
    - `plan-scoping`;
    - `roadmap-selection-durability` ×2;
    - `run-timeline-accordion`;
    - `workflow-gate-widget` ×2;
    - `workflow-history-refinements`;
    - `workflow-now-pane` ×3;
    - `workflow-tab`;
    - `workspace-rail-collapse` ×2;
    - `bdd-section`.
- **AC3. The client tests run on short cadences**, with a summed drop of at least 120 s against
  `test-reports/work/cr273-gate.out`. Subprocess modules use the launcher; in-process modules set
  `_axi().SETTINGS` on their loaded client. The modules:
  - `test_a_bun_run_relays_its_console_to_the_board`;
  - `test_a_declared_maven_run_relays_its_surefire_console`;
  - `test_a_rust_run_streams_its_tests_through_nextest`;
  - `test_a_run_in_flight_streams_its_ladder`;
  - `test_a_streamed_runs_in_run_count_comes_from_its_stream`;
  - `test_a_streamed_python_run_reaches_the_board_while_it_works`;
  - `test_each_gate_run_has_an_identity_of_its_own`;
  - the gate-run test in `test_bun_crucible_gates`.

  Two more join if their harness takes the launcher in a few lines (user ruling R3):
  - **`plans-read-timeout-envelope` (bun).** It spawns the launcher with a 1 s read timeout and asserts a read phase
    of at least 0.8 × the timeout and under the timeout + 2 s.
  - **The go tick module.** Its client starts from one builder, `go_client_harness.py` `drive`.

  RED or GREEN says which of the two joined.
- **AC4. Every converted test still catches its regression.** For each converted group, RED shows:
  - a tick that never fires, a relay that never wakes, or a timeout that never trips turns the test red;
  - for negative-window tests, a tick that does change state turns it red.
- **AC5. No CHANGELOG entry.** Nothing user-visible changes.

## Non-goals

- Changing any production interval value.
- Configuration keys, CLI flags or environment variables for users.
- **Bun tests that spawn clients:** `clients-narration` and `gate-run-release-inheritance`, by user ruling R3.
- **Timers no test waits on:** the locate-blink timeouts, already intercepted in tests, and `LIVE_FRAME_MS`.
- **Tests bound by a real toolchain:** `test_client_unit_tier_wall_vs_cpu`, the playwright reporters, and the e2e
  tier.
