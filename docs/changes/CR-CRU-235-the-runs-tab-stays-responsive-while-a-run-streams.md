# CR-CRU-235 — the Runs tab stays responsive while a run streams

**Type** fix · **Points** 8 (to be confirmed at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING · Pre-review: to be decided at its gap analysis
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave sequenced after CR-CRU-234, from a defect the
  user has been seeing on the dashboard: with the Runs tab open while a run streams (its running card on top, the
  agent's card in the project pane), the browser locks up and the display slows.

## Problem

- **The page is blocked most of the time.** Measured on the DEV board on 2026-11-06, project `Crucible v2`, Runs tab
  open, one GREEN run streaming, over 10 s: 26 main-thread long tasks totalling 7.5 s, the longest 1.36 s; 39,009 DOM
  nodes; only 18 DOM mutations in the window. The page spends its time computing, not changing the DOM.
- **Only the Runs tab, only while a run is open** (user report 2026-11-06). The other tabs stay responsive during
  the same run, and the Runs tab does too when no run is open.
- **It reads every run on every update.** In the same window the page fetched
  `/api/v2/events?project=<key>&limit=5000` ten times: 1.86 MB each, the project's whole run history. It also read
  `plans` (219 KB), `queue` (45 KB), `releases`, `release-proposals`, the three analytics reads and `projects`
  about every 2 s. While a run streams, each landed batch emits an `events` frame, and each `events` frame re-reads
  all of them. That read is the same on every workspace tab (the events slice does not depend on the tab), so it is
  not on its own what blocks the page.
- **The Runs timeline redoes all of it on every update.** The timeline holds all 2,844 of the project's runs as
  cards (2,844 `[data-run-id]` nodes, 8,945 pills, 428 transition markers, 193 milestones), with no paging or
  windowing, and the replaced events slice re-runs its derivations over all of them. With a run open, the frames
  come about once a second, faster than one pass (up to 1.36 s) finishes, so the passes queue back to back. The exact
  hot spot is profiled at the gap analysis.
- **It grows with the project.** The cost scales with the run history, not with what changed: a project with a long
  history is slowest exactly when a run is live.

## Design (outcomes; the mechanism is settled at the gap analysis)

- **§S1 — an update costs what changed.** On the Runs tab, a streamed batch, or any `events` frame, makes the page
  process what changed since its last answer, not the project's whole history; whether the read itself also shrinks
  is settled at the gap analysis.
- **§S2 — the Runs tab shows a bounded window of runs.** The timeline renders the runs in view (and a bounded
  margin), loading older ones as the user reaches them; what a run's card shows is unchanged.
- **§S3 — the live views stay live.** The running card, the agent's card and the live drill-in still follow a
  streaming run batch by batch, on every tab.
- **§S4 — nothing else changes:** what each tab shows, the run cards' content and order, the filters, and the board's
  existing reads for other callers.

## Acceptance criteria (to be made exact at the gap analysis)

- [ ] **AC1 (§S1).** With a run streaming, an `events` frame no longer re-fetches the project's whole run history; the
  bytes read per update are bounded by what changed.
- [ ] **AC2 (§S2).** On a project with thousands of runs the Runs tab holds a bounded number of run cards, and older
  runs appear as the user scrolls to them, in the same order and with the same content.
- [ ] **AC3 (§S1–§S3, measured).** With the Runs tab open on a project of at least 2,500 runs and a run streaming,
  the page has no main-thread task over a bound set at the gap analysis, and the running card and agent card still
  move with each batch.
- [ ] **AC4 (BDD).** A new e2e feature, against the real board, opens the Runs tab of a project seeded with a long run
  history, streams a run, and checks the running card moves with its batches and that older runs load on scroll.
- [ ] **AC5 (§S4).** Every existing test passes unchanged.

## Non-goals

- The board's per-tab live connection and the browser's connection limit.
- The long running-file line in the agent's card (CR-CRU-234).
