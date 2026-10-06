# CR-CRU-158 — a run's detail stays responsive while agents are running

**Type** fix · **Points** 13 (planning game 2026-09-27: 8; re-set at gap analysis 2026-10-06) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-157 · **Status** PENDING — filed 2026-09-27

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

## Gap analysis (2026-10-06) — measured

Measured on the dev board (develop `f032417`) with the user's permission for read-only sampling of the
run view's reads (2026-10-05). A sampler read `?depth=suites` and `?suite=` of an 814-step e2e run
every 250 ms; a headless browser opened that run view and expanded its suites; the board process's
CPU and RSS were sampled every 10 s; the Pi board tab's API requests and stream frames were counted
through the relay (CDP Network). Scripts and raw data: `test-reports/ga158/` (not committed).

| Condition | `?depth=suites` p50 / p95 | board CPU / RSS | run view opens |
|---|---|---|---|
| Idle | 0.9 / 1.1 ms | ~0% / 130 MB | 162 ms |
| A full bun suite run (3052 tests, filed through the client), browser probes too | 1375 / 3434 ms | ~1 core / up to 2 GB | 7–11 s |
| Browser probes only, no run | 0.9 / 1.1 ms (9 stalls of 1–2 s in 748 samples) | low | ~160 ms |
| A full bun suite run, no browser probe | 1.2–2.4 s every minute, and after the run ended | ~1.1 cores / 4–6 GB | — |
| No run, no probe, minutes after a run | 155 ms p50 | ~1.2 cores / 3.7 GB, Chrome the only client | — |

- **G1 — hypothesis 2 (the machine) is refuted.** The one-minute load stayed between 2.6 and 4.6
  on 24 cores while reads took seconds.
- **G2 — hypothesis 1 (the ingest blocks reads) is not the cause.** Reads are slow from the
  first minute of the run, long before its single ingest, and stay slow for minutes after it.
- **G3 — the board's own page floods the board.** The Pi board tab (the roadmap page) sent 597
  API requests in 30 s while the server was pinned: `analytics/velocity` 144, `forecast` 139,
  `burndown` 121, `release-proposals` 114, `releases` 63, `queue` 15. Each analytics read costs
  ~0.3 s of the server's one thread. Every stream frame calls `refetch()` (`connectStream`'s
  `onmessage`), which awaits `refetchCore`, `refetchPlans` and `refetchRoadmap`, which awaits
  `refetchAnalytics` — and nothing stops a second `refetch()` starting while one is in flight.
  During a run the board emits frames every few seconds (narration heartbeats, the open run,
  ingests); once a refetch takes longer than the gap between frames, refetches overlap and
  multiply, and the backlog keeps the server pinned for minutes after the run. Minutes later, with
  the stream quiet, the same tab sent one request in 15 s. **This is the lock the user reported.**
- **G4 — hypothesis 3 (the body rebuilds) is confirmed, and secondary.** In the run view, 2–3 of
  every 6 suite loads replaced the other suites' rows (measured by tagging each row before the
  load). It caused no long task at this size; it is fixed because AC2 asks for it, not because it
  causes the lock.
- **G5 — §S3's duplicate reads are the same defect seen at rest.** One page load fetches the
  analytics and roadmap slices several times for the same reason: overlapping refreshes.

## Scope
## Scope

### §S1 — measure first

Gap analysis measures, during a real agent run, the latency of the run view's reads (sampled every
250 ms) against the board's ingests and the machine's load, and the run view's main-thread time per
suite load. The fix is decided from what that shows and locked with the user before RED.

### §S2 — the fix the measurement calls for

**Locked with the user 2026-10-06 (proposed fix plus a server-side cache):**
- **Single-flight refresh.** At most one `refetch()` is in flight per page; a stream frame that
  arrives during one marks the page stale, and exactly one more refresh runs when it finishes. A
  burst of frames therefore costs at most two refreshes, never a pile-up.
- **Analytics only when they can have changed.** The analytics reads (velocity, burndown,
  forecast) run on load, on a release-focus change, and when a frame announces a change that can
  move them (a merge, a plan or queue change), not on every heartbeat.
- **A loaded suite renders without rebuilding the others** (G4).
- **The server caches the analytics answers** (velocity, burndown, forecast, and the plan-change
  counts) until the store changes in a way that can move them, so even a misbehaving page cannot
  pin the server with repeated analytics reads. The unseeded forecast is therefore fixed for the
  UTC day (until such a change); a seeded (test-only) forecast is computed per read, never held.
- **The projects list reads no whole event history** (C5 FIX, user ruling 2026-10-06). The page
  re-reads the projects list on every heartbeat (each card's agents-online count moves with it),
  and `handleProjectsList` loaded every event of every project to draw each card (~1.3 s on this
  store). Each card's newest event, newest coverage-bearing run and per-day coverage trend come
  from bounded queries instead, with a byte-identical payload.

### §S3 — a page load reads each resource once

The duplicate reads on workspace load are removed: each resource is fetched once per load and once
per poll.

## Acceptance criteria

- [x] During a full run of this project's bun suite, filed through the client, with the board's
      roadmap page open, a run view's `?depth=suites` and `?suite=` reads stay under **50 ms at
      p95**, measured by sampling every 250 ms (the gap analysis's method).
- [x] However many stream frames arrive while a refresh is in flight, a page runs at most one more
      refresh after it, asserted on the requests made.
- [x] A heartbeat-only stream frame triggers no analytics read; a frame announcing a merge, plan or
      queue change does, asserted on the requests made.
- [x] A second analytics read with no intervening store change is answered from the server's
      cache, and a change that can move the figures invalidates it, asserted on the server.
- [x] Loading one suite of a 734-test run does not rebuild the other suites' DOM, asserted in a real
      browser.
- [x] One workspace load issues each of `velocity`, `burndown`, `forecast`, `releases`, `queue` and
      `release-proposals` once, asserted on the requests made.


## Cycles

C1 page: single-flight refresh, analytics reads gated to the frames that can move them, one read
per resource per load (§S3) (AC3–AC5). RED + GREEN.
C2 server: the analytics cache and its invalidation (AC6). RED + GREEN.
C3 run view: a loaded suite renders without rebuilding the others (AC2). RED + GREEN.
C4 VERIFY, including AC1 measured the gap analysis's way during a real full bun run.
