# CR-CRU-158 — a run's detail stays responsive while agents are running

**Type** fix · **Points** 8 (planning game 2026-09-27) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-09-27

## Problem

**User defect (2026-09-27):** opening a BDD run is at times very slow, and the view locks. When
nothing is running it is fast; it locks while agents are running.

**Measured 2026-09-27, on the dev board, with no agent running:**

| Read | Time |
|---|---|
| `GET /api/v2/events?project=…&limit=500` (the workspace poll) | 72 ms, 173 KiB |
| `GET /api/v2/events/<id>?depth=suites` (a 734-test e2e run, 66 suites) | 1–25 ms, 21 KiB |
| `GET /api/v2/events/<id>?suite=…` (one suite's scenarios) | ~1–4 ms |
| Browser: click a BDD run to its features rendered | 71–83 ms, no long tasks |

**Reproduced 2026-09-27 in the real browser (relay):** a probe agent posting 15 `running N/M`
heartbeats, 2 s apart, against an open BDD run: the run view was never rebuilt, no re-fetch, no
long task. **Heartbeats alone do not cause the lock.**

**Hypotheses, unmeasured, for this CR's gap analysis to settle:**

1. **The server blocks.** Every store query runs through `bun:sqlite`, which is synchronous, on the
   server's one thread. A large ingest (a 2936-test bun run, a 734-test e2e run with its tree) holds
   that thread, and the run view's `?depth=suites` and `?suite=` reads queue behind it.
2. **The machine is saturated.** The agents' own suites (a ten-minute bun run, Playwright browsers)
   compete with the board and the browser for CPU.
3. **The body rebuilds as a whole.** `TestBody` and `HeatStrip` (`RunDetailBody`, `public/app.js`)
   read `suiteLeaves` synchronously, so every suite that finishes loading, including those loaded
   on scroll (`loadScrolledScenarios`), rebuilds the whole body: every heat cell and the whole tree.
   Cheap when idle; its cost grows with the run and may compound with 1 and 2.

**Also found:** one workspace load fetches `analytics/velocity`, `burndown` and `forecast` three
times each, and `releases`, `queue` and `release-proposals` three to four times each.

## Scope

### §S1 — measure first

Gap analysis measures, during a real agent run, the latency of the run view's reads (sampled every
250 ms) against the board's ingests and the machine's load, and the run view's main-thread time per
suite load. The fix is decided from what that shows and locked with the user before RED.

### §S2 — the fix the measurement calls for

To be written at gap analysis: e.g. keeping ingest work off the read path, rendering a loaded suite
without rebuilding the whole body, or both.

### §S3 — a page load reads each resource once

The duplicate reads on workspace load are removed: each resource is fetched once per load and once
per poll.

## Acceptance criteria

- [ ] With an ingest of at least the size of this project's bun suite in progress, a run view's
      `?depth=suites` and `?suite=` reads stay under a bound the gap analysis sets, measured.
- [ ] Loading one suite of a 734-test run does not rebuild the other suites' DOM, asserted in a real
      browser.
- [ ] One workspace load issues each of `velocity`, `burndown`, `forecast`, `releases`, `queue` and
      `release-proposals` once, asserted on the requests made.
