# CR-CRU-232 — an agent's card shows its open run's live counts from the first batch

**Type** fix · **Points** 2 (PROPOSED; scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING · Pre-review: due
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave, from a defect the user saw on the dashboard
  during a baseline run: the orchestrator's agent card read "gated test run starting" for the whole run. It gets its
  gap analysis when it comes up in the queue.

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
  `running 267/456 · tests/client/test_mvn_crucible_axi.py`), and a tab whose slot held a `live`-carrying run before
  updates for the next run in that slot. A tab open from before the run's start, the common case, stays on the message.
- **The running card may share it (suspected).** The Runs tab's running card (`RunningCard`) reads `run.live` the same
  way to show its progress and to become clickable into the live drill-in. Confirmed or refuted at the gap analysis.
- **No test covers the transition.** The tests that pin the live line seed an open run that carries `live` from the
  first answer.

## Design (PROPOSED; settled at the gap analysis)

- **An open run's card and agent row follow `live` from the answer that first carries it**, without a reload, whatever
  the tab held before: the agent row moves from its message to `running N/M · <current file>`, and the running card to
  its live progress, on the first answer that carries `live`.
- **Where the fix lives** (decided at the gap analysis): either the board serves `live` on every open run (empty until
  the first batch), or the page gives every open run a `live` slot before it replaces the list.
- **Nothing else changes:** the client's withheld heartbeats, the live frame's throttle, and what the row and the card
  show once `live` is there.

## Acceptance criteria

To be written at the gap analysis. Each pins what the row and the card show after `live` arrives, not only that the
board serves it.
- **A BDD scenario on the UI:** an e2e feature in `tests/e2e/features/` opens a project's board, opens a run for an
  agent with no batch yet, checks the agent row reads the agent's message, then posts the run's first batch and checks
  the row reads `running N/M` with the run's counts, without a reload; and the same for the running card.

## Non-goals

- The heartbeat the client withholds while its relay lands (by design).
- The board's per-tab live connection and the browser's connection limit (a separate concern).
