# CR-CRU-232 — an agent's card shows its open run's live counts from the first batch

**Type** fix · **Points** 2 (confirmed at its gap analysis, 2026-11-06) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING · Pre-review: none — no trigger
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave, from a defect the user saw on the dashboard
  during a baseline run: the orchestrator's agent card read "gated test run starting" for the whole run.
- **Gap analysis 2026-11-06**, on develop `44839b75`: baseline bun 4683/0 (`evt-1793970764263-1`), python 6082/0
  (`evt-1793972157561-2`).

## Problem

- **The card never shows the run's counts.** While an agent's streamed run is open, its card reads the agent's opening
  message ("gated test run starting") from the run's start to its close, instead of `running N/M · <current file>`.
  Seen by the user on the DEV board during the gap-analysis baseline (a python test run of 6,082 tests), and
  reproduced on two shorter python test runs.
- **The board has the counts.** Its events list serves the open run with `live` filled while the card is stuck: in one
  probe the board served `live` 332/391 for the run at the moment the card read "gated test run starting".
- **The client sends no counts on purpose.** While a streamed run's batches land, the client posts no in-run
  `running N/M` heartbeat (CR-CRU-201 §S4 step 6; the shared relay's `LandingPoster.withhold_ticks`), so the agent's
  message stays the opening one. The card is meant to read the run's counts instead (CR-CRU-200 §S4): the agent row
  reads `agentLiveLine`, the newest open run of the agent that carries `live`, and falls back to the message.
- **Why the card misses them.** A run's first `openRuns` answer carries no `live` key, because no batch has landed yet
  (seen in a probe for the first two seconds of a run). `refetchEvents` puts each answer into `state.openRuns` with
  `vanX.replace`, which updates the array slot by slot. vanX subscribes a binding only to the properties it reads that
  exist; reading the absent `live` subscribes to nothing, so when `live` arrives in a later answer the row's binding
  never re-runs. Measured with the shipped `public/vendor/van-x-0.6.3`: an item first replaced without `live` and then
  with `live` 5 and 9 leaves the derived line on the fallback; an item that carries `live` from its first answer moves
  through "running 5", "running 9".
- **It depends on the tab's history.** A tab opened after the run's first batch shows the counts (seen:
  `running 267/456 · tests/client/test_mvn_crucible_axi.py`). A tab open from before the run's start, the common case,
  stays on the message.
- **The running card shares it (confirmed at the gap analysis).** The Runs tab's running card (`RunningCard`) reads
  `run.live` the same way to show its progress and to become clickable into the live drill-in. With the Runs tab open
  before a python run started, the card stayed plain ("running…", no progress, not clickable) and the agent row stayed
  on "gated test run starting", while the board served the run's `live` at 321/456.
- **A tab switch only masks it.** Switching tabs re-runs the row's binding, which then reads `live` and follows it from
  there; the next run is stuck again. Seen on 2026-11-06: the row was stuck on the Roadmap tab, and a switch to Runs
  made it live.
- **No test covers the transition.** The unit tests that pin the live line and the live card seed an open run that
  carries `live` from the first answer, and the e2e live double (`tests/e2e/steps/run-live-mock.ts`) adds `live` to
  the run in every answer, the first included.

## What the gap analysis measured

- **The board's answer is right and stays as it is.** An open run's brief carries `live` only once a batch has landed;
  six server tests pin that the key is absent before then (the run-live read surface, the run start's total, the
  batch fill, the atomic batch). The defect is the page's alone.
- **One place fills the slice.** `refetchEvents` is the only writer of `state.openRuns`; the agent row
  (`agentLiveLine`), the streaming highlight and the running card all read it.
- **Where the rows live.** The agent rows sit in the workspace's project pane, shown beside every workspace tab
  (Roadmap, Runs, Workflow, Coverage, BDD, Compile). The home page has no agent rows.

## Design

- **§S1 — every open run the page holds has a `live` slot.** As `refetchEvents` puts an answer's open runs into
  `state.openRuns`, a run the board served without `live` is held with `live` empty (null), so a binding that reads
  it subscribes to it and re-runs when the board's first batch fills it. The board's answer is unchanged.
- **§S2 — the agent row follows its run from the first batch.** On the first answer that carries the run's `live`, the
  row moves from the agent's message to `running N/M · <current file>`, without a reload, and moves with each later
  answer, whatever the tab held before.
- **§S3 — on every tab** (user ruling 2026-11-06). The agent row shows what the agent is doing whatever the main panel
  shows: on each workspace tab it reads the same line, and switching tabs never takes it away or brings it back.
- **§S4 — the running card follows its run from the first batch.** A running card on screen when the run's first
  batch lands takes its live progress (failures so far, the bar, done of total, the current file) and becomes the
  clickable live card that opens the live drill-in, without a reload.
- **§S5 — nothing else changes:** the board's answer, the client's withheld heartbeats, the live frame's throttle, and
  what the row and the card show once `live` is there; a run with no batch yet reads as it does today.
- **§S6 — the optional counts inside `live` have their slots too** (VERIFY finding, fixed by user ruling 2026-11-06).
  The board's `live` may omit its run's total and current file (a reader can name a file before any test in it
  finishes). The page holds each of them empty when the board omits it, so an answer that first adds the current file
  or the total, with the done count unchanged, reaches the agent row and the running card on that answer instead of
  waiting for the next count change. What the row and the card show for a given `live` is unchanged.

## Acceptance criteria

- [ ] **AC1 (§S1, §S2).** A workspace page that first receives an open run for an agent without `live` shows the
  agent's message on its row; when a later answer carries the run's `live` (e.g. 5 of 40, current file `a.py`) the row
  reads `running 5/40 · a.py` without a reload, and a further answer (12 of 40, `b.py`) moves it to
  `running 12/40 · b.py`.
- [ ] **AC2 (§S1, §S2).** The same holds for a run that opens in a slot a settled run held before: run A settles,
  run B opens without `live`, then B's `live` arrives and the row reads B's counts.
- [ ] **AC3 (§S4).** With the Runs tab on screen, a running card first rendered without `live` is plain (no progress,
  not clickable); when `live` arrives it shows the progress line with the counts and becomes clickable into the live
  drill-in, without a reload.
- [ ] **AC4 (§S3).** With the run's `live` landed, the agent row reads its `running N/M` line on each workspace tab,
  and still reads it after switching tabs back and forth; a later answer's counts reach the row on whichever tab is
  open.
- [ ] **AC5 (§S5).** A run with no batch yet still reads the agent's message on its row and a plain running card; the
  board's open-run brief still omits `live` before the first batch (the existing server tests pass unchanged); every
  existing test passes unchanged.
- [ ] **AC6 (BDD).** A new e2e feature in `tests/e2e/features/` opens a project's board on the Roadmap tab, opens a run
  for an agent against the real board (no live double), checks the agent row reads the agent's message, then posts
  the run's first stream batch and checks the row reads `running N/M` with that batch's counts without a reload;
  switches to Runs and checks the row still reads it and the running card shows the counts; then, with Runs on screen,
  opens a second run, posts its first batch, and checks the running card turns live and the row follows it.
- [ ] **AC7 (§S6).** A page holding an open run whose `live` carries its done count but no current file (and, in a
  second case, no total) shows the row and the card for those counts; when a later answer adds the current file (or
  the total) with the done count unchanged, the row and the card show it on that answer, without a reload and without
  a further count change. A `live` whose total or current file is absent reads as it does today.

## Non-goals

- The heartbeat the client withholds while its relay lands (by design).
- The board's per-tab live connection and the browser's connection limit (a separate concern).
