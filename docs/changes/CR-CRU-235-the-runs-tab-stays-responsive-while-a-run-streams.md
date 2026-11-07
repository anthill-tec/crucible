# CR-CRU-235 — the Runs tab stays responsive while a run streams

**Type** fix · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING · Pre-review: none — no
trigger
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave sequenced after CR-CRU-234, from a defect the
  user has been seeing on the dashboard: with the Runs tab open while a run streams (its running card on top, the
  agent's card in the project pane), the browser locks up and the display slows.
- **Gap analysis 2026-11-07** (user rulings): the cause is measured (below). The fix is targeted: the running cards
  leave the timeline's rendering and no live update replaces a node beside the timeline, and the timeline's rows are
  skipped by the browser while off screen. Windowing the timeline and shrinking the events read are non-goals.
  Re-scored 8 → 5. AC3 is a real-browser bound of 250 ms per main-thread task.

## Problem

- **The page is blocked most of the time.** Measured on 2026-11-07 against an isolated board serving a copy of the DEV
  store (project `Crucible v2`, 2,834 run cards, 38,968 DOM nodes), Runs tab open, a real bun client run streaming a
  batch about every 2 s, over 20 s: 23 main-thread long tasks totalling 15.7 s, the longest 1.30 s. With no run open
  the same tab has none. The user sees the stutter as the running card and the agent's card update from the same
  frame: the CPU saturates and even typing freezes.
- **Every batch rebuilds the whole timeline.** The Runs timeline is one rendering that also draws the running cards,
  so it reads the page's open runs; each landed batch replaces that slice and the timeline re-renders all of its
  cards. Instrumented: between frames the settled runs, the plans and the filters were unchanged; only the open runs
  changed.
- **Replacing a node beside the timeline re-styles all of it.** The rebuilt timeline replaces a direct child of the
  pane, and with the dashboard's component stylesheet (daisyUI) loaded the browser then recomputes the style of every
  card: 1,105 ms for one inserted node, against 1 ms without that stylesheet. No single rule does it (hundreds of its
  sibling-combinator rules each add a little). The same insertion inside a stable container costs 36 ms; changing
  text inside a card costs 1 ms.
- **A run's start and close re-style the document once each.** Rules on the root that use `:has()` (the stylesheet's
  theme and modal rules, and two of the dashboard's own) make the browser re-style the whole document when the
  running card appears or goes: about 1.3 s each.
- **Not the cause.** The events read re-reads the project's whole retention window on every frame (1.8 MB), but its
  parse and in-place diff cost about 40 ms per frame and do not re-render the timeline when nothing settled. The
  agent's card is not beside the timeline: a node inserted there costs 37 ms.
- **What fixes it, measured.** Drawing the running cards in their own stable container and letting the browser skip
  off-screen timeline rows (`content-visibility: auto`) brought the same 20 s to 10 long tasks totalling 0.88 s, the
  longest 0.21 s, with the running card and the agent's card following every batch.

## Design

- **§S1 — a batch touches only what is live.** On the Runs tab, a streamed batch (an `events` read that changes only
  the open runs) does not re-render the timeline of settled runs: the timeline's rendering does not read the open
  runs. The running cards are drawn in their own container, which stays in place while runs open, stream and close;
  only its contents change. No live update replaces or inserts a node that is a sibling of the timeline.
- **§S2 — off-screen rows cost nothing.** The timeline's rows (run cards, transition markers, milestone entries) are
  skipped by the browser's style and layout while off screen, so a document-wide re-style (a run opening or closing,
  a settled run arriving) costs what is in view. What a row shows, its order and its scroll position are unchanged.
- **§S3 — the live views stay live.** The running card, the agent's card and the live drill-in still follow a
  streaming run batch by batch, on every tab; a run that settles still leaves the running cards and joins the
  timeline in the same read.
- **§S4 — nothing else changes:** what each tab shows, the run cards' content and order, the filters (including the
  release filter, which shows no running cards), the empty state when a project has neither runs nor an open run,
  and the board's reads.

## Acceptance criteria

- [ ] **AC1 (§S1, page level).** In the page harness, with the Runs tab open, a settled history and a run streaming:
  across batches that change only the open run, the timeline's element and its first card's element are the same
  nodes before and after, and the running card's count follows each batch. When the run settles, it leaves the
  running cards and its card joins the timeline.
- [ ] **AC2 (§S1, page level).** The running cards' container is the same node from before a run opens to after it
  closes, and no batch adds or removes a child of the pane's runway.
- [ ] **AC3 (§S1–§S3, real browser, BDD).** A new e2e feature against the real board seeds a project with at least
  2,500 settled runs, opens its Runs tab, and streams a run in at least five batches: no main-thread task during the
  batches exceeds 250 ms, the running card and the agent's card move with each batch, and the run's card joins the
  timeline when it closes.
- [ ] **AC4 (§S2).** The timeline's rows carry `content-visibility: auto` with an intrinsic size, and the page still
  scrolls to a run on a `→ Runs` jump and keeps the feed's scroll position across a detail.
- [ ] **AC5 (§S4).** Every existing test passes unchanged.

## Non-goals

- Windowing or paging the timeline (its rows stay in the DOM).
- Shrinking the events read or reading only what changed.
- Changing the component stylesheet or its `:has()` rules.
- The board's per-tab live connection and the browser's connection limit.
- The long running-file line in the agent's card (CR-CRU-234).
