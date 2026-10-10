# CR-CRU-174 — 0.3.0's fix list: the page

**Type** fix · **Points** 13 (set at CR-CRU-171's gap analysis, 2026-10-08) · **Wave** 7 (0.3.0) · **Depends on** none ·
**Status** PENDING — split out of CR-CRU-171 at its gap analysis, 2026-10-08 (user ruling)

## Problem

The page and board defects of 0.3.0's fix list, split out of CR-CRU-171 by the user on 2026-10-08;
the issue numbers are kept as filed there (issues 1 and 3, the clients', stay in CR-CRU-171).

### 2 — the release band's total is the points committed at the start, not the release's total

**Observed 2026-10-07:** the release band read `0.3.0 · 13 of 39 pts left`. The 13 is right; the 39 is
the burndown's `committedPoints` — the points in the release at its start (2026-09-09: CR-CRU-015,
018, 022 and 098). 27 of the release's 31 CRs entered after that, so the release's live total was
**217** (204 merged + 13 pending; 8 more voided), and "of 39" beside 204 merged reads as nonsense.
Points and the declaration journal only arrived mid-release (CR-CRU-022, 2026-09-24), which makes the
start-committed figure smaller still.

**User ruling 2026-10-07:** the band shows the remaining points of the release's **total**, and the
total stays current: it changes with replanning — a voided or superseded CR lowers it, a CR added
to the release raises it, a re-point moves it — so it is always the points of the release's live
CRs (merged + pending). DN-crucible-analytics §10 is amended to match at gap analysis.

### 4 — the Velocity card looks clickable and does nothing

**Reported 2026-10-07 (user):** the Velocity card shows a pointer cursor, suggesting a click, yet has
no click function. **Measured 2026-10-07 (scratch board, 1280×800):** the card
(`project-velocity`, `.app-card.app-velocity-card`) takes `cursor: pointer` from the shared
`.app-card` rule in `public/styles.css` (the projects-list card's rule) and has no click handler;
a click changes nothing. **User ruling:** it points to nothing, so it is not clickable — no pointer
cursor, no hover affordance. Any other Project-pane card that inherits the pointer with no click
behaviour (the Vitals cards) is checked at gap analysis and treated the same way.

### 5 — the Velocity card reads per day or per week

**User ruling 2026-10-07:** the Velocity card offers a per-day and a per-week view of the focused
release's pace: the per-day view as shipped (CR-CRU-161: `N pts / day`, one bar per day), and a
per-week view (`N pts / week`, one bar per week since the release started). The control, the week
boundaries and whether the choice is remembered are settled at gap analysis, with the F18 §1
storyboard frame redrawn for your approval first.

### 6 — the projects manager drawer scrolls sideways

**Reported 2026-10-07 (user):** the project-level settings drawer (`/manage`) has a horizontal
scroll by default. **Measured 2026-10-07 (scratch board, 1280×800):** its content box
(`.app-pane-content`) is 660 px wide inside a 531 px pane — the project cards' meta line (sutRoot,
liveness, retention, key) and their edit control, and the add-project row (name, type, sutRoot),
run past the right edge. **User ruling:** lay the cards and the add row out so that the drawer never
scrolls sideways, at every viewport the responsive model covers.

### 7 — Stale after, Tombstone after and Prune after do not explain themselves

**Reported 2026-10-07 (user):** "Stale after", "Tombstone after" and "Prune after" (labelled T1, T2,
T3 on the card) are not self-explanatory — are they event related? **They are not.** They are an
**agent's** liveness thresholds (CR-CRU-011; F13's state diagram): how long an agent may stay
silent — any call it makes counts as a heartbeat — before the board shows it **stale** (T1), then
**tombstoned** (T2: greyed, and its open runs are aborted `agent died`), then **prunes** it from the
rail (T3). The event-related setting is a different one: **retention** (how many runs the project
keeps). **User ruling:** organise the drawer so each parameter makes logical sense: the three
thresholds grouped as the agent's liveness, each named by what happens to the agent and in order,
with a one-line explanation, the T1 < T2 < T3 order enforced; retention apart, as the project's run
history. The card's `liveness T1 … / T2 … / T3 …` summary reads the same way.

### 8 — a project opens on Workflow even when nothing is running

**Reported 2026-10-07 (user):** a project's default view is Workflow. **Measured 2026-10-07
(scratch board):** with no open plan, `/p/<key>` opens on the Workflow tab. **User ruling:** when
there is no active workflow, a project opens on the Roadmap; with one, on Workflow. What counts as an
active workflow (an open plan; an in-flight gate) is pinned at gap analysis. A deep link that names
a tab still opens that tab.

## Design (approved — implement to it)

The storyboard `.lavish/crucible-v2-design.html` (local to this checkout, gitignored) holds the
approved frames; every RED, GREEN and VERIFY agent reads them and matches layout, exact wording and
phone behaviour. Where this spec and a frame disagree, the frame wins and the disagreement is raised
with the orchestrator.

- **F18 · "1b · per day or per week"** (APPROVED 2026-10-08) — issues 4 and 5.
- **F12 · "Redrawn for CR-CRU-171 issues 6 + 7"** (APPROVED 2026-10-08) — issues 6 and 7.
- **F14¾ / F16** — the release band, whose remaining-of-total text issue 2 changes.

## Tests this CR knowingly re-pins (measured 2026-10-08, gap analysis)

These assert what the user's rulings replace; RED re-pins them in their own commit, marked approved,
keeping every other assertion:

- the liveness and retention wording: `tests/manager-settings-labels.test.ts`,
  `tests/manager-edit-params.test.ts`, `tests/projects-manager.test.ts` (and any test pinning the
  card's `liveness T1 … / T2 … / T3 …` summary);
- the landing tab: `tests/roadmap-first-tab.test.ts` ("cold /p/<key> still lands on Workflow",
  CR-CRU-021 §S1 AC2 — superseded by the user's ruling of 2026-10-07 for a project with nothing
  running), and every test that opens a project with no open plan and expects the Workflow pane
  without choosing it — RED counts them first and reports the list before re-pinning.

## Steps

### §S1 — the release band reads remaining of the release's total (issue 2)

The burndown answer gains the release's live total — the points of its live CRs (merged + pending;
voided and superseded excluded; current points, so a re-point moves it) — and the release band reads
`<release> · <remaining> of <total> pts left`. `committedPoints` keeps its meaning (the start total
the chart's ideal line starts from). DN-crucible-analytics §9 and §10 are amended.

### §S2 — the Velocity card reads per day or per week, and only its switch is clickable (issues 4, 5)

As F18 · 1b: a **day | week** switch on the card. Per week = the release's points merged since it
started ÷ the weeks since (days ÷ 7), one bar per week, weeks counted from the release's first day
(not the calendar), the last partial week drawn hollow; the caption `<release> so far · <n> weeks ·
<points> pts`. The choice is remembered in this browser and changes the card only — the phone foot
strip, the release band and the forecast stay per day. Neither the Velocity card nor the Vitals
cards (no click behaviour) take a pointer cursor or a hover state; the switch's two options do.

### §S3 — the projects manager never scrolls sideways, and its settings say what they do (issues 6, 7)

As F12's redraw: each project card's facts on their own lines (a long path or key wraps); the add
row stacks; no horizontal scroll at any viewport the responsive model covers. The edit form groups
**Project** (name, type, SUT root), **Agent liveness** ("Shown as stale after", "Tombstoned after",
"Removed after", each in seconds with what it does, in that order; a field left empty keeps its current value — footnote reworded 2026-10-08, user ruling) and
**Run history** ("Keep the last N runs"); the card's summary reads the same words; T1/T2/T3 appear
nowhere on the page. The server refuses a liveness patch whose effective thresholds are not strictly
increasing (stale < tombstoned < removed, after merging with the project's existing override and
the defaults), naming the order — nothing stored.

### §S4 — a project with nothing running opens on the Roadmap (issue 8)

Opening a project (`/p/<key>`, from the projects list or the home page) lands on the **Roadmap** when
the project has no open plan and no gate in flight, and on **Workflow** when it has either. A URL
that names a tab (`/p/<key>/roadmap`, a run, a cycle, `?release=`) still opens that tab, and
leaving the Roadmap's URL segment follows the same rule.

## Acceptance criteria

- [x] The burndown answer carries the release's live total, and on fixed fixtures adding a CR raises
      it, voiding or superseding one lowers it, and a re-point moves it, while `committedPoints` is
      unchanged; the band reads `<remaining> of <total> pts left` — asserted on the server and on the
      page; on a copy of the dev store, 0.3.0's total equals the sum of its live CRs' points.
- [x] The Velocity card's switch shows the per-week view as F18 · 1b (figure, caption, one bar per
      week from the release's first day, hollow partial week), remembers the choice across reloads,
      and leaves the phone strip, the band and the forecast per day; the Velocity and Vitals cards
      have no pointer cursor — asserted on the page and in a real browser.
- [x] `/manage` has no horizontal scroll at the desktop, tablet and phone viewports, its edit form
      shows the three groups and their wording as F12's redraw, and T1/T2/T3 appear nowhere — asserted
      in a real browser; a non-increasing liveness patch is refused with a 400 naming the order and
      stores nothing — asserted on the server.
- [x] A project with no open plan and no gate in flight opens on the Roadmap, one with either opens on
      Workflow, and a URL naming a tab opens that tab — asserted on the page with fixed fixtures and in
      a real browser.
