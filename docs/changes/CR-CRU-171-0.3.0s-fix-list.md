# CR-CRU-171 — 0.3.0's fix list

**Type** fix · **Points** 13 (provisional, 2026-10-07: issues 4–8 added; re-scored at gap analysis) · **Wave** 7 (0.3.0) · **Depends on** none ·
**Status** PENDING — filed 2026-10-07; held LAST in wave 7 while the user adds issues (user ruling 2026-10-07)

## Problem

A collection of defects in 0.3.0's own features, found while they shipped (renamed from "the client's
fix list" on 2026-10-07, when issue 2 made it more than the clients'). The user is adding
more issues before this CR is analysed; each becomes a step and an AC at gap analysis.

### 1 — an unfiled declared-tier run is refused by the board

**Observed 2026-10-07 (CR-CRU-170 C3 GREEN, cycle 597):** `python3 clients/bun-crucible.py e2e -- --grep
"burndown"`, with no `--agent`, ran 7 scenarios and all 7 passed, but the client still POSTed the
board-decoded report (`crucible.rawReport.test:e2e`) to `/api/v2/runs`. The board refused it (HTTP 409,
"a registered caller is required — this request carried no agentId"), so a passing unfiled run ended
`ok: false` with exit 1. bun `test` without `--agent` does not ingest and exits with the runner's code;
the declared-tier path (`cmd_regression`'s `script` branch) does not follow it. CR-CRU-170 §S3 made
unfiled filtered e2e runs the natural way to work, so this now bites every agent that uses it.

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

### 3 — nine run-opening verbs take no `--cycle`

**Measured 2026-10-07 (CR-CRU-164 C2 RED, cycle 601):** python `test`, mvn `test`, `unit`, `module`,
`integration` and `e2e`, and rust `test`, `smoke-test`, `workspace-regression` and `pre-merge-gate`
open and file a run but accept no `--cycle`; every other client's run-opening verbs do (the shared
`add_gate_cycle_arg`). An agent of those stacks can only bind by `register --cycle` beforehand, so the
five clients do not bind a run the same way. **User ruling 2026-10-07:** into this CR — each of the
nine gains `--cycle` through the shared helper, with the same semantics as everywhere else.

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

### 9 — …

(more to be added by the user)

**Not here:** the Workflow tab's release-history gate (reported 2026-10-07 with the issues above)
goes to its own CR once its storyboard frame (F22) is approved.

## Steps

To be written at gap analysis, one per issue.

## Acceptance criteria

To be written at gap analysis, one or more per issue.
