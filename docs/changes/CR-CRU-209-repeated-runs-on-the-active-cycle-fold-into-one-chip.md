# CR-CRU-209 — repeated runs on the active cycle fold into one chip

**Type** fix · **Points** 2 · **Wave** 9 (0.5.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(user-raised 2026-10-27; design ruling and release 2026-10-28)

## Problem

The Workflow tab's **Now** pane draws the active cycle's settled runs as one inline line, `🧪 <agent>
<passed>/<total> · 🧪 … · awaiting orchestrator confirm` (`OpenSpan` → `InlineRunEntry` in
`public/app.js`). Each chip carries only the agent and its ratio — the approved F13 design gives the
line no per-run age, and `tests/f13-fidelity.test.ts` pins that. So when one agent runs the same suite
several times on one cycle — a VERIFY agent re-running a module, or an orchestrator's scoped re-run
after a red gate — the line shows identical chips (`14/14 · 14/14 · 14/14`) that read as one run
drawn twice, though each is its own run with its own id.

A done cycle's expanded runs (`LinkedRunRow`) each carry an age, so the defect is the active line
only.

## Design (user ruling, 2026-10-28)

**Consecutive repeats fold into one chip, with a count and the latest run's time.** In the active
cycle's line, consecutive settled runs by the same agent with the same `passed`, `failed` and `total`
fold into one chip: `🧪 <agent> <passed>/<total> ×<n> <time>`, where `<time>` is the latest run's
`clockTime` (the board's one clock formatter, so it reads as every other time on the board does). The
folded chip is the latest run: its run id, its colour, its click (opening that run's detail). The
earlier runs stay reachable through the cycle's `→ Runs` badge.

- A run that differs in agent or in any figure breaks the fold; a later identical run starts a new
  one (`A · B · A` stays three chips). The line stays chronological.
- A single run renders exactly as today — no count, no time — so the F13 line is unchanged wherever
  nothing repeats.
- Running entries (`InlineRunningEntry`) are never folded; they keep their place at the end.
- A clock time is not an age: the F13 rule against per-run "…ago" stamps holds.

## Steps

### §S1 — the fold is a pure function

`public/app-logic.mjs` gains a function that takes a cycle's settled runs in time order and returns
the chips to draw: each the latest run of a run of consecutive repeats, with its count.

### §S2 — the active line draws the folded chips

`OpenSpan` draws one entry per chip from §S1. A chip with a count of two or more appends ` ×<n>
<clockTime>` after its ratio and carries the count on the element (`data-run-count`); its run id is
the latest run's.

## Acceptance criteria

- [ ] **AC1 (§S1)** Three consecutive runs by one agent with equal figures fold to one chip whose run
  is the latest of the three and whose count is 3.
- [ ] **AC2 (§S1)** No fold across a difference: `A · B · A` (same figures, two agents) stays three
  chips; one agent with `14/14` then `13/14` stays two; a later repeat after a break starts its own
  chip.
- [ ] **AC3 (§S2)** An active cycle with three equal settled runs renders one `linked-run-row` reading
  `<agent> 14/14 ×3 <HH:MM>` with `data-run-id` the latest run's and `data-run-count="3"`; clicking it
  opens the latest run's detail.
- [ ] **AC4 (§S2)** Two equal settled runs followed by a running run render one folded chip (`×2`) and
  the running entry after it, unfolded.

Standing invariant (not a new criterion): the F13 fidelity test's exact line, with its distinct runs,
renders unchanged and with no "ago".

## Non-goals

- A done cycle's expanded run rows — they already carry an age.
- Folding on the Runs tab or its timeline cards.
- Changing the F13 design file: a line with no repeats is the design's line, unchanged.

## Release notes

- The Now pane's active cycle folds a run repeated back-to-back into one chip with a count and the
  latest run's time, so a re-run no longer reads as a duplicate.
