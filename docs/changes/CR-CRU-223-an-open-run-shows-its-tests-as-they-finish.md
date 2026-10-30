# CR-CRU-223 — an open run shows its tests as they finish

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-30
(split from CR-CRU-200 at its gap analysis, user ruling: split by layer, the board's live view first, then the board,
CR-CRU-200, then the client, CR-CRU-224; the view's storyboard frame F25, option A, approved 2026-10-30)

## Problem

An open run's card on the board is a pulsing "running…" and a timer (CR-CRU-017's `RunningCard`, deliberately not
clickable). The run's progress lives on the agent's card as narration text, `running N/M · <file>`, counted from console
lines; no test name, failure or message reaches the board until the final report. CR-CRU-200 gives the board each test as
it finishes (a stream it keeps per open run); this CR is how the board shows it.

## Design (user rulings 2026-10-30; storyboard F25, option A)

- **The running card shows the run's progress.** Beneath the agent id and tier, one line: a progress bar, done of total, the
  current file, and the failures so far as a count. With no total (the runner gave none) it reads `412 done`, with no bar.
- **The card opens a live drill-in.** The running card becomes clickable (reversing CR-CRU-017's "not clickable" rule): it
  opens the timeline pane's run detail on the open run — a header with done of total and the pass and fail counts, the
  failures as they happen (name, file, the first line of the message), and the passed tests as a count. The drill-in fills
  in as the live state changes.
- **The view decides what the board serves** (F25, card a): one live state per open run. CR-CRU-200 serves it; this CR
  builds the view against it, driven by a scripted live state in its tests.
- **When the run settles**, the open card resolves in place into the settled run's card, as today, and an open drill-in
  becomes the settled run's run detail. A run with no live state (it streams nothing, or its stack does not stream yet)
  keeps today's card: "running…" and the timer, not clickable.

## Steps

### §S1 — the live state the view reads

An open run's brief (`openRuns[]` on `GET /api/v2/events`, `openRunBrief` in `src/v2.ts`) carries, when the board holds a
live state for it, a `live` object:

| Field | Meaning |
|---|---|
| `completed` | tests finished so far |
| `total` | the runner's own total, absent when it gave none |
| `passed`, `failed`, `pending` | the finished tests by status |
| `currentFile` | the file of the last finished test, absent before the first |
| `failures` | the failures so far, oldest first, each `{name, suite, file, message}` (`message` the first line), at most `limits.live_failures_shown` |
| `failuresTotal` | the number of failures, however many `failures` holds |

The full failure list of an open run is read from `GET /api/v2/runs/<runId>/live`, which answers the same object with every
failure. A change to an open run's live state emits the existing events change frame on the live feed, so the board
refetches as it does for any change. This CR defines the shape and builds the view; CR-CRU-200 fills it.

### §S2 — the running card

`RunningCard` (`public/app.js`) gains, when the run has `live`: the progress bar (`completed / total`), `<completed>/<total>`
(or `<completed> done`), the current file, and the failure count in the fail colour when it is above zero; and it becomes
clickable, opening the live drill-in. Without `live` it is today's card, unchanged.

### §S3 — the live drill-in

Opening a running card shows the timeline pane's run detail on the open run: a header (`← Run detail · live ·
<completed>/<total> · <passed> ✓ <failed> ✗`), every failure (from `GET /api/v2/runs/<runId>/live`) in order — name, file,
the first message line, one line each — and a collapsed passed row with its count. Each change frame refetches it. When the
run settles, the drill-in becomes the settled run's run detail (`openDrillin` on its event).

### §S4 — the storyboard

F25 in `.lavish/crucible-v2-design.html` is the visual contract; its badge records this CR when it ships.

## Acceptance criteria

- [ ] **AC1 — the card.** With a scripted open run carrying `live` (`completed` 412, `total` 1280, `currentFile`
      `test_relay.py`, `failuresTotal` 3), the running card shows a progress bar at 32 %, `412/1280`, `test_relay.py` and `3 ✗`;
      with `total` absent it shows `412 done` and no bar; with no failures, no failure count; with no `live`, today's card,
      not clickable.
- [ ] **AC2 — the drill-in.** Clicking that card opens the run detail on the open run: its header shows `live`, `412/1280`,
      `409 ✓ 3 ✗`; its rows are the three failures in order, each name, file and first message line; a passed row shows 409.
      A new failure in the scripted live state appears in the open drill-in after the change frame, without a reload.
- [ ] **AC3 — settling.** When the scripted run settles (its open run leaves `openRuns` and its event arrives), the card
      resolves into the settled run's card, and an open drill-in shows the settled run's run detail.
- [ ] **AC4 — bounded.** A failure name or message longer than the row truncates on one line; a live state with more
      failures than `limits.live_failures_shown` shows the count on the card and every failure in the drill-in.
- [ ] **AC5 — the contract.** `openRunBrief`'s `live` field and `GET /api/v2/runs/<runId>/live` are typed in `src/types.ts`
      and answer as §S1 states for a live state the store holds (a store-level fixture, until CR-CRU-200 fills it from a
      stream); `limits.live_failures_shown` is declared in `src/crucible.toml` with its description, recommended value and
      bounds.
- [ ] **AC6 — the storyboard frame.** The e2e storyboard features cover F25 (a live card and its drill-in, at desktop and
      phone widths), and F25 records this CR.

## Non-goals

- Filling the live state from a run's stream (CR-CRU-200) and sending the stream (CR-CRU-224).
- The agent card's narration, which stays until CR-CRU-200 replaces it for a streamed run.
- Playwright's steps in the live view (CR-CRU-201).
