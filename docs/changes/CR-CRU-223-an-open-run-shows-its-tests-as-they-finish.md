# CR-CRU-223 — an open run shows its tests as they finish

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-30 (split from
CR-CRU-200 at its gap analysis, user ruling: split by layer, the board's live view first, then the board, CR-CRU-200, then the
client, CR-CRU-224; the view's storyboard frame F25, option A, approved 2026-10-30); spec pre-review 2026-10-30
(CR-CRU-223-SPEC-REVIEW, F1–F11 folded; user rulings: the live drill-in is `/run/<runId>`; `/live` answers a settled run with its
event; the open-run brief carries counts only, with no failure list and no new limit; the drill-in reads `/live` incrementally and
CR-CRU-200 throttles the frames) — 8 points

## Problem

An open run's card on the board is a pulsing "running…" and a timer (CR-CRU-017's `RunningCard`, deliberately not clickable).
The run's progress lives on the agent's card as narration text, `running N/M · <file>`, counted from console lines; no test
name, failure or message reaches the board until the final report. CR-CRU-200 gives the board each test as it finishes (a
stream it keeps per open run); this CR is how the board shows it.

## Design (user rulings 2026-10-30; storyboard F25, option A)

- **The running card shows the run's progress.** Beneath the agent id and tier, one line: a progress bar, done of total, the
  current file, the failures so far as a count, and the timer. With no total it reads `412 done`, with no bar.
- **The card opens a live drill-in** at `/run/<runId>` (an open run's id carries its `run-` prefix; an event id never does).
  The running card becomes clickable when it has a live state, reversing CR-CRU-017's "not clickable" rule: the timeline
  pane's run detail opens on the open run — a header with done of total and the counts, every failure as it happens (name,
  file, the first line of its message, or its type), and the passed tests as a count. The URL deep-links and survives a reload.
- **The view decides what the board serves** (F25, card a). This CR owns the contract's types, the read method's signature
  (`Store.runLive`, answering nothing until CR-CRU-200 fills it), the open-run brief's `live` field and the `/live` route;
  CR-CRU-200 owns the table, the method's body, filling it from the stream, and the change frames. This CR's tests drive the
  view with a stubbed read, never a write path.
- **When the run settles**, the open card resolves in place into the settled run's card, as today; an open live drill-in
  learns the run's event from `/live` and replaces its URL with `/run/<eventId>`, so Back never returns to a dead live view —
  the settled run's run detail, or the aborted run's. A run with no live state keeps today's card, not clickable.

## Steps

### §S1 — the contract

- **The open-run brief** (`openRuns[]` on `GET /api/v2/events`, `openRunBrief` in `src/v2.ts`) carries, when the board holds a
  live state for the run, `live: {completed, total?, passed, failed, pending, currentFile?}` — `completed` the tests finished,
  `total` the runner's own total (absent when it gave none or gave `0`), `passed`/`failed`/`pending` the finished tests by
  status, `currentFile` the file of the last finished test. No other key of the brief changes.
- **`GET /api/v2/runs/<runId>/live[?from=<n>]`** answers:
  - an open run with a live state: `{state: "open", live: {…}, failures: […], failuresFrom: <n>}`, `failures` the failures
    from index `n` (default 0), oldest first, each `{id, name, suite, file, message?, type?}`;
  - a settled run: `{state: "ended" | "aborted", eventId}`;
  - an open run with no live state, or an unknown run id: 404.
- **`RunLive` and `RunLiveFailure`** are typed in `src/types.ts`; `Store.runLive(runId)` answers `RunLive | null` and, in this
  CR, `null`.

### §S2 — the running card

`RunningCard` (`public/app.js`) gains, when the run has `live`:

- the progress bar at `completed / total`, clamped at 100 % (`1300/1280` still reads as such), and no bar without a total;
- `<completed>/<total>` or `<completed> done`; the current file, truncated on one line; `<failed> ✗` in the fail colour when
  `failed` is above zero; the `⏱` timer, as today;
- the pointer cursor and an `onclick` opening `/run/<runId>`, with the phone band's 44 px touch floor (CR-CRU-018).

Without `live` it is today's card, unchanged, with no handler. The card's agent id, file and counts stay on one line at phone
width (≤ 640 px), with the failure count and the timer visible.

### §S3 — the live drill-in

- **Route.** `/run/<runId>` (and `/p/<key>/run/<runId>`) opens the run detail in its live mode on both surfaces the running card
  renders on (home and the workspace).
- **Header.** `← Run detail · live · <completed>/<total> · <passed> ✓ <failed> ✗` (`<completed> done` without a total; `<pending> ⏭`
  when above zero).
- **Rows.** Every failure from `/live`, in order — name, file, the first line of its message (its type when it has no message),
  each on one line — rendered through the run detail's existing windowed virtualisation, then one passed row with its count,
  which does not expand.
- **Refresh.** While a live drill-in is open, each refresh (`runRefresh`, under its single flight) reads `/live?from=<n>`, `n` the
  failures already shown, and appends what it answers; an answer that arrives after the route has moved is discarded.
- **Settle.** When `/live` answers `ended` or `aborted`, the drill-in replaces its history entry with `/run/<eventId>`.

### §S4 — the design record

- F25 in `.lavish/crucible-v2-design.html` is the visual contract; its badge records this CR when it ships.
- The text that states the old rule follows: the header prose of `tests/e2e/features/run-lifecycle.feature`, the `RunningCard`
  comment in `public/app.js`, and `.app-evt-running`'s `cursor` in `public/styles.css`.
- `docs/research/DN-crucible-live-test-progress.md`'s "Where it lands" names CR-CRU-223, CR-CRU-200 and CR-CRU-224 as split, and
  its "Open for CR-CRU-200's gap analysis" records the live view as settled (F25, option A), citing by symbol.
- The provenance floors `PROSE_CITATIONS` pins for `src` and `public` (`tests/project-namespace-tripwire.test.ts`) are re-measured
  at the close-out and re-recorded once, in their own commit, by exactly the measured delta.

## Acceptance criteria

- [ ] **AC1 — the card.** With an open run whose brief carries `live` (`completed` 412, `total` 1280, `currentFile`
      `test_relay.py`, `failed` 3), the running card shows a bar at 32 %, `412/1280`, `test_relay.py`, `3 ✗` and the timer, and
      has the pointer cursor; with `total` absent or `0`, `412 done` and no bar; with `completed` 1300 of 1280, a full bar and
      `1300/1280`; with `failed` 0, no failure count; with no `live`, today's card, with no click handler.
- [ ] **AC2 — the drill-in.** Clicking that card navigates to `/run/<runId>` and shows the live run detail: the header `live`,
      `412/1280`, `409 ✓ 3 ✗`; three failure rows in order, each name, file and first message line (the type for a failure with
      no message); a passed row reading 409 that does not expand. After an `events` change frame, a refresh reads
      `/live?from=3` and a fourth failure appears without a reload; reloading `/run/<runId>` shows the same live view.
- [ ] **AC3 — settling.** When the run settles, the card resolves into the settled run's card; an open live drill-in, on `/live`
      answering `ended`, replaces its URL with `/run/<eventId>` and shows that run's detail, and Back leaves the run detail; on
      `aborted`, it shows the aborted run's detail.
- [ ] **AC4 — the route.** `GET /api/v2/runs/<runId>/live` answers §S1's three shapes: open with a live state (honouring `from`),
      settled (`state` and `eventId`), and 404 for an open run with no live state or an unknown id; the brief's `live` holds only
      §S1's keys, and `run-lifecycle-read-surface.test.ts` (no top-level counts on an open-run brief) passes unchanged.
- [ ] **AC5 — bounded.** A failure name or message longer than its row truncates on one line; with 5,000 failures the drill-in
      mounts no more rows than its virtualisation window; at 390 px wide the card's failure count and timer stay visible and its
      file truncates.
- [ ] **AC6 — on the page.** Scenarios in `tests/e2e/features/run-lifecycle.feature` (desktop) cover the live card, the drill-in,
      a new failure after a change frame, and settling; one scenario in `tests/e2e/features/mobile-viewport-responsive.feature`
      (phone) covers the live card and the drill-in filling the viewport. Each opens a real run with `POST /api/v2/runs/start` and
      stubs only the two live reads (`page.route`, as `burndown-analytics-mock.ts` does).
- [ ] **AC7 — the design record.** F25 records this CR; `run-lifecycle.feature`'s header, the `RunningCard` comment and
      `.app-evt-running`'s cursor no longer state "not clickable" for a card with a live state; the DN names the split and the
      settled live view; `tests/citations-cite-by-symbol.test.ts` passes.
- [ ] **AC8 — the citation floors (close-out).** `PROSE_CITATIONS`' `src` and `public` heads are re-measured and re-recorded once,
      in their own commit, by exactly the measured deltas.

## Non-goals

- Filling the live state, its table and the change frames (CR-CRU-200), and sending the stream (CR-CRU-224).
- A configured limit on failures shown (none is needed: the card shows a count, the drill-in virtualises).
- The agent card's narration, which stays until CR-CRU-200 replaces it for a streamed run.
- The Workflow tab's running entry (`InlineRunningEntry`), which keeps today's look.
- Playwright's steps in the live view (CR-CRU-201).
