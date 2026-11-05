# CR-CRU-231 — the failure jump counts the failures not yet opened

**Type** fix · **Points** 2 (PROPOSED; scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING · Pre-review: due
- **Filed 2026-11-04** by user ruling, from a defect the user found on the run detail of a one-failure run. It gets its
  gap analysis when it comes up in the queue.

## Problem

- **The label is one short.** The run detail's failure jump (`data-testid="failure-jump"`, the header controls in
  `public/app.js`) reads `▸ ${failed - 1} more failures`. A run with one failure shows "▸ 0 more failures"; a run
  with three shows "▸ 2 more failures". Seen on the DEV board on five runs, bun and python, 5 to 6,057 tests.
- **Why.** The `- 1` dates from the drill-in where a failing run opened with its first failure box showing, so "more"
  meant the failures beyond it. CR-CRU-038 §S1 made a failing run open with its tree minimized and no box open, and
  left the label as it was: nothing is open when the run loads, and the label still subtracts one.
- **It never moves.** The label is computed from the run's `failed` count alone, so it reads the same before the first
  click, after it, and at the last failure. CR-CRU-038 §S3 says the jump "shows the live failure count".
- **The first click may skip a failure.** The walk's cursor starts at 0 and the first click advances it before
  reading (`jumpPos = (jumpPos + 1) % keys.length`), so with two or more failures the first click opens the second
  failing leaf in walk order. Read from the code; the gap analysis confirms it on a run with several failures.
- **No test reads the label.** The tests find the control by its `data-testid` only (`tests/density.test.ts`), which
  is why none caught it.

## Design (PROPOSED; settled at the gap analysis)

- **The label counts the failures the walk has not yet opened.** Before the first click it is the run's failed
  count: "▸ 1 more failure", "▸ 3 more failures". Each click opens the next failure and the count drops by one.
- **One and many.** "failure" for one, "failures" for any other count.
- **The first click opens the first failure** in walk order, the order the walk uses today.
- **At the end of the walk** (PROPOSED): with every failure opened once, the label says the next click goes back to
  the first, and the click does so, as the walk wraps today.
- **Nothing else changes:** the minimized tree, the one-box focus model, the raw toggle and where the controls sit.

## Acceptance criteria

To be written at the gap analysis, one per Design bullet. Each pins the label's text, not only the control's presence.

## Non-goals

- Counting by anything other than the walk's failing leaves and the run's failed count (how they relate when a run
  holds load errors is a question for the gap analysis, not a redesign).
- The board's per-tab live connection and the browser's connection limit (a separate concern).
