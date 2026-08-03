# CR-CRU-060 — The e2e harness predates the registered-caller hard stop; 19 scenarios fail against it

**Status:** PENDING
**Type:** patch (test-harness contract drift)
**Priority:** P1 — the e2e suite cannot pass until this is fixed, and it is a release-gate item
**Depends on:** CR-CRU-056 (registration binds the cycle; `requireRegisteredCaller`), CR-CRU-052
(closed the DB leak that had been masking the true failure count)
**Labels:** patch, tests, e2e, harness, agent-identity, release-gate
**Phase:** Wave 4
**Design reference:** CR-CRU-056 made registration the binding act — *"ONLY A REGISTERED AGENT CAN
COMMUNICATE WITH THE SERVER, THAT INCLUDES ALL TYPES OF ORCHESTRATORS"* (user, 2026-07-31).
`requireRegisteredCaller` enforces it on 12 routes. The e2e harness was never updated.

## Context

**This CR exists because CR-CRU-052 corrected a measurement, not because behaviour changed.**

The release gate has carried an item reading *"3 pre-existing e2e failures
(`workspace-plan-scoping.feature`, CR-026 §S0 family)"*. That number was measured against a
**polluted database**. CR-CRU-052 found that every default e2e run since CR-CRU-043 had been
writing to `~/.local/share/crucible/crucible.db` — 79 projects and 259 events of accumulated
fixtures — because `resolveDbPath` fell through to the user-level path whenever the scratch cwd
contained no `data/crucible.db`. Different scenarios failed for different residue-driven reasons on
each run, and the "3" was an artefact of that noise.

**On a genuinely isolated database the figure is 19 failed / 11 passed / 10 blocked**, measured
three times consecutively with identical results, and confirmed independently by CR-052's VERIFY.

**All 19 share ONE cause, and it is not residue.** Every failure is an HTTP call in the harness —
10 in `filePlan`, 5 in `ingestParsed`, 3 in `ingestJunit`, 1 in `ingestCompile`. **Zero UI, layout
or timeline assertions fail.** Reproduced directly against a throwaway server:

```
POST …/plans              → 409  "a registered caller is required — this request carried no agentId"
POST /api/v2/runs/parsed  → 409  "agent a1 is not registered with this project — refused"
```

Two distinct shapes of the same drift, in `tests/e2e/steps/harness.ts`:
- **`filePlan` sends no `agentId` at all** — it predates the field being required.
- **The ingest helpers send an `agentId` that was never registered** (`a1`, and similar fixture
  ids) — the value is present but no registration backs it.

The server is behaving **correctly** in both cases. `requireRegisteredCaller` (CR-CRU-056) is the
guard the user demanded after unregistered callers silently corrupted the live board, and it is
doing exactly its job. The harness is what is out of date. That distinction governs this CR: the
fix belongs entirely in the test harness, and **nothing in `src/` should be relaxed to accommodate
it.**

## Scope

### §S1 — Establish the true failure inventory
Run the e2e suite on a properly isolated DB (CR-CRU-052 made this the default) and record the
failure list. Classify each: identity drift, or something else. The `19 / 11 / 10` split is the
starting measurement, not an assumption — re-derive it, because the blocked 10 may resolve on their
own once the failing 19 stop cascading.

### §S2 — `filePlan` declares an agent
Give `filePlan` a registered caller. Prefer reusing the harness's existing `registerAgent`
(`harness.ts:137`) over inventing a second identity path — one registration idiom, not two.

### §S3 — The ingest helpers use a REGISTERED id
`ingestParsed`, `ingestJunit` and `ingestCompile` pass an `agentId` that no registration backs.
Register it, or route them through a helper that guarantees registration first. The fixture ids
(`a1` etc.) may stay; what must change is that something registers them.

### §S4 — A scenario-level guarantee, not per-call patching
Patching four call sites leaves the next helper free to reintroduce the drift. Prefer a harness-level
guarantee that any call requiring a registered caller has one — mirroring how CR-CRU-052 §S2 wired
teardown as an `auto` fixture in `tests/e2e/steps/world.ts` rather than per-scenario. Decide and
record which shape you take.

### §S5 — Re-baseline the release gate
The queue's release-gate item must be corrected from "3 pre-existing e2e failures" to whatever
remains after §S2–§S4. If genuine product defects remain once the drift is gone, enumerate them —
those are the real gate items, and they have never been visible until now.

## Acceptance criteria
- [ ] The true pre-fix failure inventory is recorded, each failure classified drift vs other (§S1).
- [ ] `filePlan` sends a registered `agentId`; no route rejects it for identity — asserted.
- [ ] `ingestParsed` / `ingestJunit` / `ingestCompile` send registered ids — asserted.
- [ ] The e2e suite's identity-drift failures are ZERO. Any remaining failure is documented as a
      genuine product defect with its cause, not left unexplained.
- [ ] **No file under `src/` is modified.** The server guard is correct; this is harness drift.
      Evidence: `git diff --stat` shows no `src/` path.
- [ ] The release-gate item is re-baselined in `docs/changes/README.md` Notes (§S5).
- [ ] Full bun regression green AND full Python regression green.

## Non-goals
- Weakening, bypassing or special-casing `requireRegisteredCaller`. It is the guard the user
  demanded; the harness conforms to it, never the reverse.
- Changing the registration/binding contract (CR-CRU-056) or agent identity validation
  (CR-CRU-059).
- The DB isolation fix — CR-CRU-052 closed that; this CR only benefits from it.
- Fixing genuine product defects the re-baseline exposes. Enumerate them; fixing them is separate
  scope, and bundling them here would repeat the pattern this queue keeps paying for.

## Risk
- **The 10 "did not run" scenarios are an unknown.** They are blocked by earlier failures, so their
  true state is unmeasured. The inventory may GROW once the 19 stop cascading — that is information,
  not a regression, and it must be reported rather than presented as a surprise at the gate.
- **A per-call-site patch will look like a fix and rot.** §S4 exists because four fixed helpers do
  not stop a fifth from drifting; the harness has now drifted twice (this, and the teardown gap
  CR-052 closed) for the same underlying reason — an ambient guarantee nobody owns.
- **Tempting shortcut to refuse:** registering a fixture agent with a TDD role would bind it to a
  cycle and could attach e2e runs to real plan cycles. Use `report`, the role that exists precisely
  for a registration not exercising a TDD phase.
