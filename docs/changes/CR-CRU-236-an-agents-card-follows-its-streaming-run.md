# CR-CRU-236 — an agent's card follows its streaming run, and its runtime is never negative

**Type** fix · **Points** 3 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING · Pre-review: none — no
trigger
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave sequenced after CR-CRU-234 (the same card),
  from a defect the user reported on the DEV board: the tests of a streaming run move in the Runs view but not in the
  active agent's card.

## Problem

- **The card stops at the run's start.** While an agent's run streams, its card in the project pane should read
  `running <done>/<total> · <current file>`. On the DEV board (2026-11-06, seven reproductions with a 40-file bun run
  under `vidushi`) the card read the agent's message `gated test run starting` for the whole run, also after a full
  page reload, while the board served the live counts (`running 258/335 · …`) and the page held them in its open-run
  slice. The Runs view's running card moved with every batch.
- **Why, as far as measured.** The card's line is a reactive binding (`agentLiveLine` in the agent row). At the
  evaluation when the run first appears, it read the run's agent and project but not its `live` slot, so it is
  subscribed to nothing that a landed batch changes and never re-runs. Forcing it to re-run (changing a state it does
  read) showed the right line at once (`running 2/335 · tests/inpane-liveness.test.ts`). In one reproduction the
  run's `live` key was absent from the reactive record at that first evaluation and was added later as a new key,
  which a field read never subscribes to; why the key was absent, given the page sets an empty `live` slot on every
  open run, was not found. A probe also found the page holding an open run the board no longer served.
- **The tests do not see it.** `agent-row-reads-the-live-count` passes: the harness (`live-run-harness`) drives the
  same frames and the line moves. Replaying the real records and frame orders through the harness also passes. Only
  the browser shows the defect.
- **A negative runtime.** The agents read served `vidushi` tombstoned with `runtime_ms: -3519049`. A tombstoned
  agent's runtime is `(last run, else last seen) − first seen`, and re-registering resets `firstSeen`, so an agent
  whose last run predates its latest registration reads a negative runtime.

## Design

- **§S1 — the card follows every batch.** While an agent's newest live-carrying open run streams, its card's line moves
  with every `events` frame that changes that run's live state — the count, the total and the current file — from the
  run's opening to its close, whatever the order in which the run's records and its first batch reach the page, and
  without a reload. When the run settles the card reads its own line again. How the binding is made robust is GREEN's
  choice; the gap analysis settles the root cause first.
- **§S2 — the page drops a settled run.** When the board no longer serves an open run, the page's open-run slice no
  longer holds it after the next read.
- **§S3 — a runtime is never negative.** A tombstoned agent's runtime is measured from its latest registration to its
  last run since then, else to its last seen; it is never below 0.
- **§S4 — nothing else changes:** what the card says (CR-CRU-200 §S4's line, CR-CRU-234's cut), the Runs view's
  running card, and a live agent's runtime.

## Acceptance criteria

- [ ] **AC1 (§S1, BDD).** A new e2e feature, in a real browser against the real board: an agent opens a run, the run's
  stream lands in at least three batches, and after each batch the agent's card reads `running <done>/<total> ·
  <current file>` with that batch's figures; after the close it reads the agent's own line. It runs once with the
  run's first batch landing before the page first reads the open run, and once after.
- [ ] **AC2 (§S1).** The same feature with the page reloaded mid-run: the card reads the live line within one frame.
- [ ] **AC3 (§S2).** A page holding an open run the board no longer serves drops it on its next read; the agent's card
  reads its own line and the Runs view shows no running card for it.
- [ ] **AC4 (§S3).** An agent that ran, re-registered, and then tombstoned without a new run reads a runtime ≥ 0 from
  its latest registration; one with a run since reads from that registration to that run.
- [ ] **AC5 (§S4).** Every existing test passes unchanged.

## Non-goals

- The card's layout (CR-CRU-234).
- The Runs tab's responsiveness (CR-CRU-235).
