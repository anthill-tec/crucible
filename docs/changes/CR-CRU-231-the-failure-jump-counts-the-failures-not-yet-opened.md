# CR-CRU-231 — the failure jump counts the failures not yet opened

**Type** fix · **Points** 3 (re-scored at its gap analysis, 2026-11-06) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING · Pre-review: none — no trigger
- **Filed 2026-11-04** by user ruling, from a defect the user found on the run detail of a one-failure run.
- **Gap analysis 2026-11-06**, on develop `7f0eac21`: baseline bun 4676/0 (`evt-1793957921801-2`), python 6082/0 (`evt-1793959306528-3`).

## Problem

- **The label is one short.** The run detail's failure jump (`data-testid="failure-jump"`, the header controls in
  `public/app.js`) reads `▸ ${failed - 1} more failures`. A run with one failure shows "▸ 0 more failures"; a run
  with three shows "▸ 2 more failures". Seen on the DEV board on five runs, bun and python, 5 to 6,057 tests.
- **Why.** The `- 1` dates from the drill-in where a failing run opened with its first failure box showing, so "more"
  meant the failures beyond it. CR-CRU-038 §S1 made a failing run open with its tree minimized and no box open, and
  left the label as it was: nothing is open when the run loads, and the label still subtracts one.
- **It never moves.** The label is computed from the run's `failed` count alone, so it reads the same before the first
  press, after it, and at the last failure. CR-CRU-038 §S3 says the jump "shows the live failure count".
- **The first press skips a failure** (confirmed at the gap analysis). The walk's cursor (`jumpPos` in
  `jumpToNextFailure`) starts at 0 and is advanced before it is read, so with two or more failures the first press
  opens the second failing leaf in walk order, and the first is reached only after the walk wraps. The skip is the
  same leftover as the label: it was right while the first box opened on load.
- **Two tests pin today's behaviour.** `tests/drill-in.test.ts` (the header-controls anatomy test) pins the label
  "▸ 2 more failures" on a three-failure run and its first press on the second leaf; `tests/density.test.ts` (the
  jump from the minimized default) pins the first press on the second of two leaves. No test follows the label as the
  walk moves.

## What the gap analysis measured

- **The run's failed count and the walk's failing leaves agree.** On the DEV store, every one of the 470 failing runs
  filed in cycles 700–859 (bun and python, junit and crucible-events) has `summary.failed` equal to its count of
  failing leaves. Load-error leaves and the runner-exit leaf are leaves of the tree and are counted in `failed`
  (the ingest recounts the tree after reading the raw output).
- **The walk reaches every failing leaf.** Its first press loads every failing suite in full (a suite's leaves are
  never paged), then walks the failing leaves suite by suite, in tree order: the walk order.

## Design

- **§S1 — the label counts the failures the walk has not yet opened.** With N failures and nothing opened, it reads
  "▸ N more failures". Each press opens the next failure in walk order and the count drops by one.
- **§S2 — one and many.** "failure" for a count of one, "failures" for any other: "▸ 1 more failure".
- **§S3 — the first press opens the first failure** in walk order; each later press opens the next.
- **§S4 — once every failure has been opened, the walk keeps cycling** (user ruling 2026-11-04). Each further press
  opens and focuses the next failure in walk order, wrapping from the last to the first. From the press that opens the
  last unopened failure on, the label names the failure the walk has open as its place in walk order:
  "▸ failure k of N". A one-failure run reads "▸ 1 more failure" before its first press and "▸ failure 1 of 1" after.
- **§S5 — N.** Before the first press N is the run's failed count. Once the walk has loaded the failing suites, N is
  the number of failing leaves the walk holds. The two are equal on every stored run measured (above); taking the
  walk's own count after loading keeps "k of N" true to the failures the walk can open.
- **§S6 — the walk counts its own presses.** Opening or closing a failure box by clicking a row does not move the
  walk's cursor or its label, as today: the label speaks for the jump.
- **§S7 — nothing else changes:** the minimized tree, the one-box focus model, the raw toggle and where the controls
  sit.

## Acceptance criteria

- [ ] **AC1 (§S1, §S2).** Before any press, a run with three failures shows "▸ 3 more failures" and a run with one
  shows "▸ 1 more failure"; no failure box is open.
- [ ] **AC2 (§S1, §S3).** On a run with three failing leaves in walk order f1, f2, f3: the first press opens f1's
  failure box and the label reads "▸ 2 more failures"; the second opens f2's box and reads "▸ 1 more failure". Exactly
  one failure box is open after each press.
- [ ] **AC3 (§S4).** On the same run, the third press opens f3's box and the label reads "▸ failure 3 of 3"; the
  fourth opens f1's box and reads "▸ failure 1 of 3"; the fifth opens f2's and reads "▸ failure 2 of 3". On a
  one-failure run, the first press opens its box and reads "▸ failure 1 of 1", and a second press keeps both.
- [ ] **AC4 (§S5).** A run whose failed count (3) is larger than the failing leaves its tree holds (2) reads
  "▸ 3 more failures" before any press; after the first press it reads "▸ 1 more failure", and after the second
  "▸ failure 2 of 2".
- [ ] **AC5 (§S6).** Opening a different failure by clicking its row, after the first press, leaves the label as it
  was; the next press opens the failure after the one the walk last opened.
- [ ] **AC6 (§S7).** The run still opens minimized with no suite fetched; the jump still loads the failing suites on
  its first press; the raw toggle and the controls' place in the header are unchanged. The two tests that pin today's
  label and first-press target (`tests/drill-in.test.ts`, `tests/density.test.ts`) are re-pinned to AC1–AC2, in the
  cycle that changes the cursor; every other existing test passes unchanged.
- [ ] **AC7 (BDD, user ruling 2026-11-04).** A new e2e feature in `tests/e2e/features/` seeds a run with three
  failing leaves, opens its run detail, and checks the label before any press and after each of five presses
  (AC1–AC3's sequence). After each press it checks that exactly one failure box is open and that it belongs to the
  failing leaf the label's place names in walk order.

## Non-goals

- Counting by anything other than the walk's failing leaves and the run's failed count.
- The board's per-tab live connection and the browser's connection limit (a separate concern).
