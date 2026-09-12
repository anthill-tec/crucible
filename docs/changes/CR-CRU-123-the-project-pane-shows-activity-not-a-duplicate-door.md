# CR-CRU-123 — the Project pane shows activity, not a duplicate door

**Status:** PENDING (0.2.0 — born mid-release, D4)
**Type:** feature
**Priority:** P3
**Depends on:** none
**Labels:** feature, ui, ux, project-pane
**Phase:** Wave 6 (0.2.0 — user-directed, live orchestrator session 2026-09-12)
**Design reference:** `docs/research/PRD-crucible-v2.md` §4.11 *Placement* — AMENDED by this CR's
gap analysis (2026-09-12). The 2026-07-16 user lock read *"the Project pane keeps a 🗺 chip
shortcut"*; the user's 2026-09-12 ruling (*"it is not useful"*) retires it, and the same sentence's
tab order was stale against CR-CRU-076. Both corrected in the PRD before this CR was planned — §S2
implements a design decision now recorded in the PRD, not one taken against it.

**Gap analysis:** run by the orchestrator 2026-09-12, verdict READY after nine findings (DRIFT-1
through DRIFT-9; DRIFT-1 was the PRD conflict above, ruled by the user). Baseline MEASURED at
13:19 IST on clean tree `93da062`: **90 pass / 0 fail / 378 expect() across 5 files**
(`roadmap-pane`, `inpane-liveness`, `agent-runtime-pane`, `shell-final-form`, `app-logic`),
`bun x tsc --noEmit` exit 0.

## Context

Two user findings against the workspace Project pane (the right rail), raised 2026-09-12. Both are
about the pane's signal-to-noise: it carries no indication of the one thing happening most often,
and it carries a control that duplicates the tab strip beside it.

**1. An agent streaming test data is indistinguishable from an idle one.** `AgentRow`
(`public/app.js`, symbol `AgentRow`) computes `busy = agent.liveness === "online" && agent.status
=== "busy"` and renders a **static** red dot for it (the `app-dot` span inside `AgentRow`). Nothing
on the row moves while that agent is actually mid-run, so a pane full of registered agents reads the
same whether work is flowing or nothing is happening. The precise signal already exists client-side
and needs no server work: `state.openRuns` (runs opened via `/runs/start` and not yet settled —
CR-CRU-017 §S3, served additively on the events feed) carries `agentId`, which is exactly "this
agent has a run in flight". It is the same feed `RunningCard` already reads to pulse a run card.

Cited by SYMBOL, not by line: the gap analysis found all four of this spec's original line citations
stale, because CR-CRU-122 merged (+99 lines in `public/app.js`) between writing this spec and
planning it. `AgentRow` moved 621-660 -> 631-670, the busy dot 641 -> 651, the chip 2425-2432 ->
2523-2524. This project's convention is to cite symbols wherever the symbol is unique — which it is
for every construct this CR touches.

**2. The `🗺 roadmap` chip duplicates the tab strip.** `ProjectPane` renders a chip
(symbol `ProjectPane`, `data-testid="roadmap-chip"`) whose `onclick` is
`selectWorkspaceTab("Roadmap")` — the identical route the tab strip's own Roadmap tab performs, and
CR-CRU-079 §S1/AC2 pins the two as byte-identical pathnames on purpose. The chip predates
CR-CRU-076, which made **Roadmap the first tab in the strip**; once the destination became the
leftmost tab, a second door two inches away stopped earning its space. User ruling: remove it.

**Consumers of the chip, enumerated before proposing its removal (2026-09-12):**

| consumer | disposition |
|---|---|
| the chip in `ProjectPane` (`public/app.js`) | the chip itself — deleted |
| the `app-roadmap-chip` CSS class | **no rule exists.** A full-repo census (13 matches in 4 files, 515 scanned) finds the class emitted into the DOM and styled NOWHERE — `public/styles.css` has no `.app-roadmap-chip` rule. There is nothing to delete; §S2's original "and its CSS class" clause resolves to a no-op |
| `tests/roadmap-pane.test.ts:249,259` | assert the chip exists — deleted with it |
| `tests/roadmap-pane.test.ts:349,393` | **click** the chip to drive CR-CRU-079's pathname/pushState assertions — RE-POINTED at the surviving tab-strip door, never deleted: the navigation contract they protect outlives the chip |
| `docs/changes/CR-CRU-079-*.md` | a SHIPPED CR's spec text. NOT edited (standing rule: an implemented CR is never rewritten); this CR's §S2 is the record of the removal instead |

## Scope

### §S1 An agent with a run in flight animates on its Project-pane row

`AgentRow` gains an activity indicator driven by `state.openRuns`: an agent is STREAMING when at
least one open run's `agentId` equals that row's agent id. The predicate is a THIRD sibling over
that slice and must follow the shape of the two that exist rather than invent a fourth:
`visibleOpenRuns()` filters it by project + active filter (and already filters on `agentId`), and
`runningRunsFor(cycleId)` filters it by cycle.

While streaming, the row renders a **new, visually distinct animation** — deliberately NOT any of
the three animations the stylesheet already declares: NOT `app-spin` (CR-CRU-122's spinner, "a fetch
you are waiting on"), NOT `app-run-pulse` (the run card's ember border-pulse, so an agent row never
reads as a run card), and NOT `app-locate-blink` (CR-CRU-025's 10s locate marker — the nearest
neighbour of all three, since it too lands on a row). The animation is a data-flow treatment on the
row itself (a travelling shimmer, or an animated flow glyph in the row's existing `⌁` marker slot —
implementation's choice within the pane's existing visual language), with its own `@keyframes` rule
and its own semantic class.

**It adds NO new child element to the row.** The PRD's agent sub-row enumeration is a locked final
form (§4.11, *"final form — round 6, 2026-07-15"*: liveness dot, display name, `message`, relative
last-seen), so the signal rides an EXISTING slot or the row's own box. A fifth child would satisfy
every other criterion here and silently break that lock, which is why AC7 below pins it.

**Where the `@keyframes` goes:** APPEND it after the stylesheet's last cited line
(`public/styles.css:1372`). Eleven informal `styles.css:<line>` citations live in the test tree,
seven of them at ≥1096; inserting beside the existing animation family would shift them, and
appending past them shifts none. Free mitigation, so it is not optional.

The existing static `busy` dot (the `app-dot` span in `AgentRow`) is untouched: `status === "busy"`
is a coarser
liveness fact and keeps its own rendering. This section adds a signal; it removes none.

**The lifecycle this rides on, verified in source 2026-09-12 (asked: does Crucible get a run-finished event, or only test counts?).** There IS a definitive end-of-run signal, and there are NO mid-run counts — so the animation needs no arithmetic over completed-vs-total:

- `POST /api/v2/runs/start` (`src/v2.ts:901`) opens the run and stores NO event — its own comment: *"a start is not an end"*. The open run is persisted in SQLite, so it survives a restart.
- Every ingest route takes an OPTIONAL `runId`; `resolveRunClose` (`src/v2.ts:939-981`) validates it and the SERVER's clock closes it, then `store.endRun(...)` fires AFTER the event write (`src/v2.ts:1020-1024`) — deliberately after, *"so a failed ingest leaves the run OPEN (and sweepable) rather than lost"*.
- What the UI observes is therefore the run LEAVING `listOpenRuns` in the SAME response that carries the new event (CR-CRU-017 §S3: one response carries both, so the two can never disagree).
- Ingest is a single POST of a COMPLETE report (JUnit XML, or a parsed summary+tree). The open-run record carries `runId`/`agentId`/`startedAt`/`context`/`meta` and no progress counts at all, so there is nothing partial to compare against a total.
- A hung or dead run cannot animate forever: `sweepOpenRuns` (`src/store.ts:2536`) settles stale open runs into aborted events and runs BEFORE every events and agents read (`src/v2.ts:697`, `:3473`). A stuck animation is therefore structurally impossible, not merely unlikely.

### §S2 The duplicate roadmap chip is removed from the Project pane

Delete the `roadmap-chip` button from `ProjectPane`. Its `app-roadmap-chip` class has no CSS rule to
remove (see the consumer table above). The Roadmap tab in the workspace tab strip is the surviving
door and is unchanged — the route, the pushState behavior and CR-CRU-079 §S1's pathname contract all
stay exactly as they are, reached through the tab.

### §S3 One stale animation-census comment is corrected

`tests/roadmap-visual-grammar.test.ts` claims, in a comment above its animation assertion, that
*"`app-run-pulse` and `app-locate-blink` are the only keyframes `public/styles.css` declares"*.
That was false before this CR: CR-CRU-122 added `app-spin` and left the comment behind. This CR adds
a fourth, so the comment is corrected to name what the stylesheet actually declares.

The ASSERTION beside it is correct and stays untouched: it is scoped to
`[data-testid="roadmap-zones"] *` and whitelists the two animations the ROADMAP may use, so a new
agent-row animation cannot break it (verified by reading the selector, not by running it). Only the
comment lies, and a stale comment that the next reader would trust is the defect class this project
fixes on discovery.

## Acceptance criteria

**§S1**
- [ ] With one registered agent and one entry in `state.openRuns` whose `agentId` matches it, that
      agent's `[data-testid="agent-row"]` carries the new activity class; with `openRuns` empty, it
      does not.
- [ ] The animation has its own `@keyframes` rule in `styles.css`, referenced by its own class, and
      is NONE of the three the stylesheet already declares — not `app-spin`, not `app-run-pulse`,
      not `app-locate-blink` — asserted by NAME for all three, so the four signals cannot collapse
      into one.
- [ ] With TWO registered agents and an open run for only ONE of them, exactly one row carries the
      activity class — asserted by counting, so a fix that animates the whole list fails.
- [ ] When the open run settles (the same tick the event enters `state.events` and leaves
      `state.openRuns`, per CR-CRU-017 §S3), the animation stops — driven by re-rendering the real
      state transition, not by a timer.
- [ ] The existing static `busy` dot still renders for `status === "busy"` regardless of whether the
      agent is streaming — regression pin, the two signals are independent.
- [ ] A tombstoned agent never renders the activity animation even if a stale open run names it.
- [ ] **AC7 — the row gains no new child element.** The streaming agent's `[data-testid="agent-row"]`
      has the same child-element count as a non-streaming one; the signal is carried by a class on
      an existing node or on the row itself. Pins the PRD's locked sub-row final form.

**§S2**
- [ ] `[data-testid="roadmap-chip"]` renders nowhere in the workspace Project pane.
- [ ] The workspace tab strip's Roadmap tab still routes to `/p/<key>/roadmap` with pushState, and
      the tab still FOLLOWS the route on Back/Forward — CR-CRU-079 §S1's existing assertions, now
      driven through the tab door, passing unchanged.
- [ ] The two tests that previously clicked the chip (`tests/roadmap-pane.test.ts:349,393`) assert
      the SAME pathname/pushState contract through the tab-strip door — re-pointed, not deleted, and
      their assertions not weakened.
- [ ] A grep for `roadmap-chip` and `app-roadmap-chip` returns hits only in shipped CR docs and this
      CR's own spec (the historical record), never in `public/` or `tests/`.

**§S3**
- [ ] The corrected comment names every `@keyframes` `public/styles.css` declares as of this CR, and
      the roadmap-scoped assertion beside it is byte-unchanged and still passing.

## Estimated size

S — one cycle. One new CSS animation plus a derived per-row predicate (§S1), one deletion with two
tests re-pointed (§S2), and one comment correction (§S3). The gap analysis's own estimate stands at
one cycle: §S3 is a sentence, and §S2 is net-negative code.

## Risk

- **§S1's trigger is a client-side join** between `state.agents` and `state.openRuns` on `agentId`.
  The two slices arrive in ONE response (CR-CRU-017 §S3's deliberate design: "one response carries
  both", so they can never disagree about a run), so no staleness window is introduced.
- **§S1's predicate must be read INSIDE `AgentRow`'s reactive `class: () => …` binding**, not
  hoisted beside `busy` (which is computed once per render). Both satisfy AC4 today because the rows
  rebuild on each poll, but only the binding makes the signal react to the slice that actually
  changed.
- **§S2 removes a public testid.** Consumers are enumerated above; the only behavioural consumers
  are two navigation tests whose contract survives through the tab door.
- **No test pins the agent row's exact structure** — `shell-final-form.test.ts` counts rows and uses
  `toContain`, never an exact child count or full-text equality. Measured before the branch cut, so
  §S1's DOM addition has no hidden blast radius. AC7 is what keeps it that way deliberately.

## Close-out steps (orchestrator, performed ONCE — not per cycle)

- **Re-record `PROSE_CITATIONS.public.head`** in `tests/project-namespace-tripwire.test.ts`. It is
  **469** at the branch cut; §S1–§S3's prose naming CR-CRU-123 will raise it. Measured at close-out,
  never transcribed from a mid-cycle note.
- **Run `test:e2e` manually and state its result in the merge note.** `e2e/steps/workspace.steps.ts`
  and `e2e/steps/cards.steps.ts` read `agent-row`, and `test:e2e` is excluded from `pre-merge-gate`
  fleet-wide (DN open question 5) — so a green gate says nothing about them. CR-CRU-118 shipped an
  e2e break the gate could not see; this is that lesson applied in advance.
- **Do NOT re-pin the 53 informal `public/app.js:<line>` citations** that §S1's insertion shifts.
  Measured: 73 such citations across 33 test files, 53 of them below `AgentRow`'s line. They are
  informal comments, not machine-checked pins, and CR-CRU-120's VERIFY already found 14 of them
  inaccurate — the corpus is stale independently of this CR. Re-pinning 53 across 33 files is
  disproportionate to what it protects (the standing "citation-guard generalisation" candidate is
  the right home for it). Recorded as a measurement, deliberately not as work.

## Non-goals

- Changing `RunningCard`'s `app-run-pulse`, CR-CRU-122's `app-spin`, or CR-CRU-025's
  `app-locate-blink` — four distinct signals after this CR, each keeping its own meaning and its own
  animation.
- Changing the static `busy` dot's meaning, the liveness dot palette, or any liveness threshold.
- Any server change: `openRuns` is already served on the events feed.
- Editing `docs/changes/CR-CRU-079-*.md` — a shipped CR is never rewritten; this CR is the record.
- Adding an activity indicator anywhere other than the Project pane's agent rows (the home projects
  row keeps its existing liveness dot).
