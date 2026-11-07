# CR-CRU-236 — an agent's card follows its streaming run, and its runtime is never negative

**Type** fix · **Points** 3 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING · Pre-review: none — no
trigger
- **Filed 2026-11-06** by user ruling, as a bug fix in the current wave sequenced after CR-CRU-234 (the same card),
  from a defect the user reported on the DEV board: the tests of a streaming run move in the Runs view but not in the
  active agent's card.
- **Gap analysis 2026-11-07** (user ruling): the stuck card is not reproduced outside the user's own Chrome tab (below);
  §S1 is a robust fix that removes the defect's class, checked live by the user on the DEV board after merge (AC6),
  since no automated test fails for it today. The negative runtime's cause is confirmed and is fixed test-first.

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
- **Nothing else reproduces it** (gap analysis 2026-11-07). The page harness with the real records in every arrival
  order; the real-browser feature `agent-row-follows-its-runs-first-batch`; a headless browser against an isolated
  board driven through the routes (the e2e's order, the client's re-register and prior run, no wait for the streaming
  mark, a cycle-bound ORCHESTRATOR with cycle-linked runs, on the default, Runs and Workflow tabs); the real bun client
  against that board; and the real client against a copy of the DEV store, observed on the same page — every one
  follows every batch. Only the user's long-lived tab stuck, and there one run followed and the next, in the same page,
  stuck from its opening.
- **What the code allows.** The project pane builds the agent rows inside one binding, rebuilt only when an agent
  field it reads changes; the card's line and its streaming mark are bindings that iterate the open-run slice. The
  agents and events reads run in parallel and each replaces its slice as it lands. A line whose last evaluation read
  nothing that a later replacement changes — an absent key, or a run list that did not yet hold the run — is never
  re-run while the agent's own fields stay still, which they do for a whole run.
- **A negative runtime.** The agents read served `vidushi` tombstoned with `runtime_ms: -3519049`. A tombstoned
  agent's runtime is `(last run, else last seen) − first seen`. Unregistering deletes the agent's row and registering
  again creates a new one, with a new `firstSeen`, while the last run read is the agent's last of all time — so an
  agent whose last run predates its latest registration reads a negative runtime.

## Design

- **§S1 — the card follows every batch** (user ruling 2026-11-07: the robust fix). While an agent's newest
  live-carrying open run streams, its card's line moves with every `events` read that changes that run's live state —
  the count, the total and the current file — from the run's opening to its close, whatever the order in which the
  agents and events reads land, and without a reload. When the run settles the card reads its own line again. The
  card's line and its streaming mark are re-evaluated on every replacement of the page's open-run slice, whatever they
  read when they last ran, so neither can be left subscribed to nothing. The same holds for the agents slice (user
  ruling 2026-11-07, from RED's finding): the card's line is re-evaluated on every replacement of the page's agents,
  so an idle line that arrives as a key the agent's record did not hold is read even when no other field of the agent
  changes. How is GREEN's choice.
- **§S2 — the page drops a settled run.** When the board no longer serves an open run, the page's open-run slice no
  longer holds it after the next read.
- **§S3 — a runtime is never negative.** A tombstoned agent's runtime is measured from its latest registration to its
  last run since that registration, else to its last seen; a run from before the registration is not its last run.
  It is never below 0.
- **§S4 — nothing else changes:** what the card says (CR-CRU-200 §S4's line, CR-CRU-234's cut), the Runs view's
  running card, and a live agent's runtime.

## Acceptance criteria

- [ ] **AC1 (§S1, BDD — a regression guard; passes today).** A new e2e feature, in a real browser against the real
  board: an agent re-registered with a new message as its run opens (as a client does), the run's stream landing in at
  least three batches, and after each batch the agent's card reads `running <done>/<total> · <current file>` with
  that batch's figures; after the close it reads the agent's own line. It runs once with the run's first batch landing
  before the page first reads the open run, once after, and once with the page reloaded mid-run.
- [ ] **AC2 (§S1 — page level).** In the page harness: an agent's card built while the page holds no open run for the
  agent, and whose agent's fields do not change again, follows the run's batches once the run arrives — in both
  orders of the agents and events reads, and for a run whose first read carries no live state.
- [ ] **AC3 (§S2 — a regression guard).** A page holding an open run the board no longer serves drops it on its next
  read; the agent's card reads its own line and the Runs view shows no running card for it.
- [ ] **AC4 (§S3 — fails today).** An agent that ran, was unregistered and registered again, and then tombstoned
  without a new run reads a runtime ≥ 0, measured from its latest registration; one with a run since reads from that
  registration to that run.
- [ ] **AC5 (§S4).** Every existing test passes unchanged.
- [ ] **AC7 (§S1 — fails today).** In the page harness: a card reading its agent's message, whose agents read then
  serves an idle line for the agent with no other field of the agent changed, reads that idle line.
- [ ] **AC6 (§S1 — checked live by the user).** After the merge and a board restart, the user watches at least two
  consecutive real client runs in their own long-lived tab on the DEV board, and the agent's card follows every batch
  of each.

## Non-goals

- The card's layout (CR-CRU-234).
- The Runs tab's responsiveness (CR-CRU-235).
