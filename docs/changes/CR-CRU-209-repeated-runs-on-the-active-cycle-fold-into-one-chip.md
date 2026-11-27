# CR-CRU-209 — repeated runs on the active cycle fold into one chip

**Type** fix · **Points** 3 · **Wave** 9 (0.5.0) · **Depends on** — · **Status** COMPLETED (shipped 2026-11-27 on develop) — filed 2026-10-28
(user-raised 2026-10-27; design ruling and release 2026-10-28; revised after gap analysis 2026-11-27)

## Problem

The Workflow tab's **Now** pane draws the active cycle's settled runs as one inline line, `🧪 <agent>
<passed>/<total> · 🧪 … · awaiting orchestrator confirm` (`OpenSpan` → `InlineRunEntry` in
`public/app.js`). Each chip carries only the agent and its ratio — the approved F13 design gives the
line no per-run age, and `tests/integration/f13-fidelity.test.ts` pins that. So when one agent runs
the same suite several times on one cycle — a VERIFY agent re-running a module, or an orchestrator's
scoped re-run after a red gate — the line shows identical chips (`14/14 · 14/14 · 14/14`) that read
as one run drawn twice, though each is its own run with its own id.

A done cycle's expanded runs (`LinkedRunRow`) each carry an age, so the defect is the active line
only.

## Design (user ruling, 2026-10-28; rulings after gap analysis, 2026-11-27)

**Consecutive repeats fold into one chip, with a count and the latest run's time.** In the active
cycle's line, consecutive settled runs that *repeat* fold into one chip: `🧪 <agent> <passed>/<total>
×<n> <time>`, where `<time>` is the latest run's `clockTime` (the board's one clock formatter, so it
reads as every other time on the board does). The folded chip is the latest run: its run id, its
colour, its click (opening that run's detail). The earlier runs stay reachable through the cycle's
`→ Runs` badge, which renders on an active cycle.

Two consecutive settled runs **repeat** when they have the same agent and either:

- **neither is aborted**, and their `passed`, `failed` and `total` are equal; or
- **both are aborted** (`status: "aborted"`), whatever their figures — an aborted chip shows no ratio.

An aborted run never folds with a run that is not aborted (ruling 2026-11-27): an aborted run with
no stream reads `0/0/0`, as does an undecodable finished one, and a streamed aborted run keeps its
partial figures, so figures alone cannot tell them apart. A folded aborted chip reads `🧪 <agent>
aborted ×<n> <time>`.

- A run that does not repeat its predecessor breaks the fold; a later repeat starts a new one
  (`A · B · A` stays three chips). The line stays chronological.
- A single run renders exactly as today — no count, no time, no `data-run-count` — so the F13 line is
  unchanged wherever nothing repeats.
- Running entries (`InlineRunningEntry`) are never folded; they keep their place at the end.
- A clock time is not an age: the F13 rule against per-run "…ago" stamps holds.
- `now` for `clockTime` is read when the line renders (`Date.now()`, as the gate decisions list does;
  ruling 2026-11-27). `clockTime` dates a time from another UTC day than `now`
  (`YYYY-MM-DD HH:MM`); the line does not subscribe to the board's 10-second tick.

## Steps

### §S1 — the fold is a pure function

`public/app-logic.mjs` gains a function that takes a cycle's settled runs in time order and returns
the chips to draw: each the latest run of a sequence of consecutive repeats (as defined above), with
its count. It is exported, declared in `public/app-logic.d.mts`, and listed on the
`window.CrucibleLogic` bridge that `public/app.js` reads.

### §S2 — the active line draws the folded chips

`OpenSpan` draws one entry per chip from §S1, called through `window.CrucibleLogic`. A chip with a
count of two or more appends ` ×<n> <clockTime(latest.timestamp, Date.now())>` after its ratio (or
after `aborted`) and carries the count on the element (`data-run-count`); its `data-run-id` is the
latest run's.

## Acceptance criteria

- [ ] **AC1 (§S1)** Three consecutive runs by one agent with equal figures, none aborted, fold to one
  chip whose run is the latest of the three and whose count is 3.
- [ ] **AC2 (§S1)** No fold across a difference: `A · B · A` (same figures, two agents) stays three
  chips; one agent with `14/14` then `13/14` stays two; a later repeat after a break starts its own
  chip; an empty list gives no chips and a single run gives one chip with count 1.
- [ ] **AC3 (§S1)** Aborted runs: two consecutive aborted runs by one agent with different figures
  fold to one chip (count 2, the latest run); an aborted run and a finished run by one agent with
  equal figures (`0/0/0`, and `14/14`) stay two chips, in either order.
- [ ] **AC4 (§S1)** The function is reached by `public/app.js` through `window.CrucibleLogic`, and
  its unit test imports it by name from `public/app-logic.mjs`, so the type check fails if
  `public/app-logic.d.mts` does not declare it.
- [ ] **AC5 (§S2)** With the clock pinned, an active cycle with three equal settled runs renders one
  `linked-run-row` reading `<agent> 14/14 ×3 <clockTime>` — `HH:MM` when the latest run is from the
  pinned day, `YYYY-MM-DD HH:MM` when it is from an earlier UTC day — with `data-run-id` the latest
  run's and `data-run-count="3"`; clicking it opens the latest run's detail.
- [ ] **AC6 (§S2)** Two equal settled runs followed by a running run render one folded chip (`×2`)
  and the running entry after it, unfolded.
- [ ] **AC7 (§S2)** Two consecutive aborted runs by one agent render one chip reading `<agent>
  aborted ×2 <clockTime>`, uncoloured as an aborted chip is today, with `data-run-count="2"`.
- [ ] **AC8 (§S2)** A chip with a count of one carries no `×`, no time and no `data-run-count`
  attribute.

Standing invariant (not a new criterion): `tests/integration/f13-fidelity.test.ts`'s exact line,
with its distinct runs, renders unchanged and with no "ago".

## Test plan

| What | Tier | ACs |
| --- | --- | --- |
| The fold function over in-memory run lists (named import from `public/app-logic.mjs`) | bun unit (`tests/unit`) | AC1–AC4 |
| The Now pane's active line in the happy-dom app shell, clock pinned with `setSystemTime` | bun integration (`tests/integration`) | AC4–AC8 |

No existing test renders two consecutive repeats on an active line (gap analysis, 2026-11-27), so
no existing assertion changes.

## Non-goals

- A done cycle's expanded run rows — they already carry an age.
- Folding on the Runs tab or its timeline cards.
- Changing the F13 design file (an untracked storyboard): a line with no repeats is the design's
  line, unchanged.
- The chip's icon tint, which follows the agent's live or stamped role as today; two folded runs
  whose stamped roles differ show the latest run's.

## Release notes

- The Now pane's active cycle folds a run repeated back-to-back into one chip with a count and the
  latest run's time, so a re-run no longer reads as a duplicate. Back-to-back aborted runs by one
  agent fold the same way.

## Close-out (2026-11-27)

Plan 279.

- **Gap analysis:** the five active-line test files were green at 56/56 before any change, and no existing test
  drew two back-to-back repeats on the line. Two user rulings followed: aborted runs fold only with aborted runs,
  and the chip's clock reads `Date.now()` at render. Points were raised from 2 to 3.
- **Cycle 1035, RED/GREEN (§S1):** 17 unit tests, imported by name, so the type check holds the declaration.
  `foldRepeatedRuns` is in `public/app-logic.mjs`, declared generic in `public/app-logic.d.mts`, and listed on
  the `window.CrucibleLogic` bridge.
- **Cycle 1036, RED/GREEN (§S2):** 9 integration tests on the app shell with the clock pinned; 6 failed for the
  spec's reasons and 3 pinned what it keeps. `OpenSpan` draws one entry per chip, and `InlineRunEntry` appends
  ` ×<n> <clockTime>` and `data-run-count` only for a count of two or more.
- **Cycle 1037, VERIFY:** PASS, with no must-fix or should-fix findings and four notes.
- **Cycle 1038, FIX (user-chosen notes):** a live re-fold over the stream (`×2` to `×3`), the phone layout, and
  epoch-ms times in the unit fixtures. Each new test was shown to catch a break no earlier test catches.
- **Pre-merge gate (cycle 1038):** 13,690 passed and 0 failed in about 24 minutes. By suite: bun 5,170, python
  unit 2,723, python integration 5,797.
- **CHANGELOG:** a `Changed` entry under `[Unreleased]`, added in this close-out by user ruling.
