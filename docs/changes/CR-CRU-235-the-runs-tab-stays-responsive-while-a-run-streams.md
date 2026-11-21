# CR-CRU-235 — the Runs tab stays responsive while a run streams

**Type** fix · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE · Pre-review: ran — 8
points; the gap analysis needed user rulings · **Design reference** `docs/research/PRD-crucible-v2.md`, UI stack
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave sequenced after CR-CRU-234, from a defect the
  user has been seeing on the dashboard: with the Runs tab open while a run streams (its running card on top, the
  agent's card in the project pane), the browser locks up and the display slows.
- **Gap analysis 2026-11-07** (user rulings): the cause is measured (below). The fix is targeted: the running cards
  leave the timeline's rendering and no live update replaces a node beside the timeline, and the timeline's rows are
  skipped by the browser while off screen. Windowing the timeline and shrinking the events read are non-goals.
  Re-scored 8 → 5. AC3 is a real-browser bound of 250 ms per main-thread task.
- **Re-scoped 2026-11-07 during RED** (user rulings; folded in rather than filed as a patch CR, by user ruling): RED's
  real-browser test found the first live batch and the run's opening still cost a ~3.4 s task under the targeted
  fix, from the Tailwind browser runtime rewriting its stylesheet when the live card first adds class names. The
  runtime is replaced by a static stylesheet (§S5), and the feed's scroll restore stays exact under §S2 (AC7).
  Re-scored 5 → 8; the gap analysis re-ran for the new scope and the spec pre-review is due.
- **Pre-review 2026-11-07** (`CR-CRU-235-SPEC-REVIEW`, nine findings, all folded; user rulings on three): the home
  timeline is in scope with its own guards (AC9); the opening read is bounded and the close is measured (AC3); the
  empty state lives inside the stable container (AC2, AC8). Also folded: AC6's baseline is a committed fixture recorded
  before the runtime goes; the PRD's UI-stack line is amended (AC10); no new Tailwind utilities, with a guard (AC11);
  two runs at once and an aborted run (AC1, AC2); every row kind named (§S2, AC4).
- **VERIFY 2026-11-07** (cycle 876, fixed in-CR): GREEN's row minimum width stopped a compile card's diagnostic line
  truncating and widened the feed (AC12); home's compact gate row lacked the row rule (AC4 now names home's rows); the
  timeline's unused open-runs parameter, which would let a caller bring the defect back, goes (AC13).
- **VERIFY 2026-11-07** (cycle 877): with rows skipping off-screen work, a long unbreakable agent id can no longer
  spill past its card (paint containment clips it), so the card grew to hold it and pushed its ratio pill off screen.
  User ruling: the id truncates with an ellipsis inside the card (AC12); the sideways-scroll scenario that used a long
  id to force horizontal overflow is updated to force it another way (user-approved test edit, AC5).
- **Done 2026-11-07.** Merged as `93436c37` (plan 238, cycles 875–878). Pre-merge gate 10,950/0 (bun 4868/0, python
  client 6082/0); full e2e 164/0. AC3: no long task from a run's opening through its last batch; the close's longest
  task measured 141–151 ms across runs (recorded figure ≈150 ms, under 250 ms).

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
- **The Tailwind runtime re-styles the document when a class first appears** (RED, 2026-11-07). The page loads
  Tailwind as a browser runtime (`tailwind-browser`, 271 KB), which watches the DOM and regenerates its stylesheet
  when a class name it has not seen enters it. A running card going live adds such names, so on a fresh page the
  first live batch and the run's opening each cost a ~3.4 s task (2,500 settled runs) even with the targeted fix;
  without the runtime that task disappears. What the runtime generates for every tab of the dashboard is 4,583
  bytes: its theme variables, its base reset and two utilities (`.start` and `.end`, which the Roadmap's terminal
  markers carry as class names). Nothing else on the page uses a Tailwind utility; the components come from daisyUI's
  prebuilt stylesheet and the dashboard's own.
- **The whole fix, measured** (re-run 2026-11-07 on a fresh page, a copy of the DEV store with a cycle active and a
  cycle-bound run streaming, the run's opening and first batch inside the 20 s window): the running cards in a stable
  container, the rows' `content-visibility`, scroll anchoring off on the feed's scroll box, and the runtime's output
  as a static stylesheet gave 10 long tasks totalling 0.54 s, the longest 57 ms, and the timeline rendered once.
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
  only its contents change. The Runs tab's empty state lives inside that same container. No live update replaces or
  inserts a node that is a sibling of the timeline. The same holds on the home timeline, which draws its running cards
  and rows through the same rendering.
- **§S2 — off-screen rows cost nothing.** The timeline's rows are skipped by the browser's style and layout while off screen, so a document-wide re-style (a run opening or closing,
  a settled run arriving) costs what is in view. What a row shows (except as AC12 states), its order and its scroll position are unchanged. The rows are every kind the
  timeline draws: event (run) cards, aborted cards, transition markers, milestone entries, gate cards, merge markers,
  open cycle-span rows and declared markers, on the Runs tab and on home (home's compact gate and merge rows
  included). A row kind may be left out only if the spec's AC4 says so and why; a
  declared marker that skips off-screen work still serves the `→ Runs` jump and its blink.
- **§S3 — the live views stay live.** The running card, the agent's card and the live drill-in still follow a
  streaming run batch by batch, on every tab; a run that settles still leaves the running cards and joins the
  timeline in the same read.
- **§S5 — the page's utility styles are static.** The page loads no stylesheet-generating runtime. What the Tailwind
  runtime generates today (its theme variables, base reset and the two utilities) is served as a static stylesheet,
  in the same cascade position (after the dashboard's own stylesheet), so every view looks as it does today and no
  class name entering the DOM rewrites a stylesheet. The vendored runtime is removed. The static file is the runtime's
  output verbatim, `@layer` blocks included (the dashboard's unlayered stylesheet keeps beating the layered reset),
  with a header naming its source (tailwindcss 4.2.4 browser runtime). From here on the dashboard adds no Tailwind
  utility classes: components come from daisyUI and the dashboard's own `app-*` classes. The PRD's UI-stack line is
  amended to match.
- **§S4 — nothing else changes:** what each tab shows, the run cards' content and order, the filters (including the
  release filter, which shows no running cards), the empty state when a project has neither runs nor an open run,
  and the board's reads.

## Acceptance criteria

- [x] **AC1 (§S1, page level).** In the page harness, with the Runs tab open, a settled history and a run streaming:
  across batches that change only the open run, the timeline's element and its first card's element are the same
  nodes before and after, and the running card's count follows each batch. When the run settles, it leaves the
  running cards and its card joins the timeline. When the run is aborted instead (swept as abandoned or its agent
  dead), its running card leaves, its aborted card joins the timeline, and the container is the same node. With two
  runs open, a second opening while one streams, or one closing while the other streams, keeps the container the same
  node, keeps the surviving card following its batches, and keeps the cards in the page's open-runs order.
- [x] **AC2 (§S1, page level).** The running cards' container is the same node from before a run opens to after it
  closes, and no batch adds or removes a child of the pane's runway, including for a project with no settled runs
  (its empty state is inside the container).
- [x] **AC3 (§S1–§S3, real browser, BDD).** A new e2e feature against the real board seeds a project with at least
  2,500 settled runs, opens its Runs tab, and streams a run in at least five batches: no main-thread task from the
  read that opens the run through the last batch exceeds 250 ms (the window starts before the run opens), the running card and the agent's card move with each batch, and the run's card joins the
  timeline when it closes. The longest task during the read that closes the run is measured and reported by the
  feature (not bounded); its value is recorded in this spec at close-out, and above 250 ms it is an accepted limit.
  Recorded at close-out: about 150 ms (141–151 ms across runs).
- [x] **AC4 (§S2).** Every row kind §S2 names, on the Runs tab and on home, carries `content-visibility: auto` with an
  intrinsic size (or is named here as left out, with the reason; running cards are not timeline rows), and the page still scrolls to a run on a `→ Runs` jump and keeps the feed's
  scroll position across a detail.
- [x] **AC12 (§S2, §S4).** No row is wider than the pane, at 1280 px and at the phone band: a compile card's
  diagnostic preview line still ends in an ellipsis inside its card, and a run card whose agent id is wider than the
  card shows the id cut with an ellipsis inside the card, its ratio pill in view at the card's right edge (user
  ruling). The dual-axis scroll scenario still proves the pane's horizontal scroll stays reachable at any vertical
  position, with its horizontal overflow forced by something other than a row's long id.
- [x] **AC13 (§S1).** The timeline's rendering takes no open runs at all, so no caller can make it read them.
- [x] **AC5 (§S4).** Every existing test passes unchanged, except the tests that pin the Tailwind runtime's script
  on the page (the SPA-serving and roadmap visual-grammar tests), which are updated to the static stylesheet, and the
  dual-axis scroll scenario's long-id overflow source, which is replaced as AC12 states (both user-approved).
- [x] **AC6 (§S5).** The page loads no Tailwind runtime script; the static stylesheet is linked after the dashboard's
  own; and in a real browser no stylesheet in the document changes while a run opens, streams and closes, or when
  the Roadmap view first renders, apart from uPlot's own stylesheet link, which the page adds once when a chart first
  loads (uPlot stays off the page load; RED, 2026-11-07). The computed styles of a named set of elements equal a baseline recorded under the
  runtime before it is removed and committed as a test fixture. The fixture names each element's selector, the
  computed properties compared, and the viewport, `data-theme` and density it was taken at. The set covers: a Runs
  timeline card, the running card, the agent's card, the Roadmap's terminal markers (`start`/`end`), a home timeline
  card, a run detail's header, a button and a form control, and the manager drawer.
- [x] **AC7 (§S2).** With the rows' `content-visibility`, closing a run's detail restores the feed's scroll position
  exactly (the existing drill-in scenario that restores it passes unchanged).
- [x] **AC8 (§S4, page level).** The Runs tab's empty state (`no runs yet …`) shows only when the project has neither
  a settled run nor an open run: a project whose first run is still open shows its running card and no empty state,
  and the release filter shows no running cards. When that first run settles, the empty state stays hidden and the
  run's card joins the timeline.
- [x] **AC9 (§S1–§S3, home).** On the home timeline, a streaming run's running card still shows and follows its
  batches, and closing a run's detail opened from home restores the home feed's exact scroll position.
- [x] **AC10 (§S5).** The PRD's UI-stack line names Tailwind 4's generated theme and base reset as a static vendored
  stylesheet, not the browser runtime; "no CDN/build step" and "all UI assets vendored" stay.
- [x] **AC11 (§S5).** A test fails if the dashboard's source (`public/`) uses a Tailwind utility class that the
  static stylesheet does not define (the two it defines, `start` and `end`, stay allowed).
- AC1 and AC2 read "a batch" as the read that opens a run and every streamed batch after it; the read that closes a
  run changes the settled history and may rebuild the timeline once (RED's reading, accepted).

## Non-goals

- Windowing or paging the timeline (its rows stay in the DOM).
- Shrinking the events read or reading only what changed.
- Changing the component stylesheet (daisyUI) or its `:has()` rules.
- Making the read that closes a run cheaper than measured (AC3 records it).
- A CSS build step: the static stylesheet is the runtime's output, committed.
- The board's per-tab live connection and the browser's connection limit.
- The long running-file line in the agent's card (CR-CRU-234).
