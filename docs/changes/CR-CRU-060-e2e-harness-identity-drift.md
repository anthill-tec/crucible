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

Two distinct shapes of the same drift, in `tests/e2e/steps/harness.ts` — **both re-verified at gap
analysis, and the second was stated wrongly on first filing:**
- **`filePlan` (`harness.ts:243-259`) sends no `agentId` at all** — its POST body is
  `{cr, cycles, wave?}`. Confirmed. `handlePlanFile` (`src/v2.ts:1061`) calls
  `requireRegisteredCaller` BEFORE validating `cr` or `cycles`, so identity is the first gate hit.
- **The ingest helpers take `agentId` as a PARAMETER; the unregistered ids come from their
  CALLERS.** ⚠ The original wording ("the ingest helpers send an id that was never registered") was
  wrong. It is caller-dependent: `seeding.steps.ts:24` DOES call `registerAgent` before ingesting at
  `:47`, whereas `cycle-run-navigation.steps.ts:41` generates `crb-filler-${i}` ids that nothing
  registers. So the defect is not "the helper sends a bad id" but "no layer guarantees the id is
  registered before use."

**The fix mechanism already exists — do not build a new one.** `registerAgent`
(`harness.ts:134-144`) already posts `role: "report"`, which is exactly the role this CR's Risk
section says to use. And registration is **idempotent by construction**: `handleAgentTouch`
(`src/v2.ts:499`) branches on `hasAgent` and merely skips the lifecycle-event journal on a repeat
call. So an ensure-registered wrapper over the existing helper is safe to call unconditionally,
whether or not the caller already registered.

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

### §S3 — Every ingest call carries a REGISTERED id
`ingestParsed`, `ingestJunit` and `ingestCompile` must not reach the server with an id nothing
registered. Because the id arrives from the caller (see Context), fixing the helpers alone is not
enough and fixing every call site is not durable. The fixture ids themselves may stay; what must
change is that something guarantees registration.

### §S4 — The guarantee belongs at the HELPER boundary, not the scenario boundary
**Corrected at gap analysis.** This section originally pointed at CR-CRU-052 §S2's `auto`-fixture
pattern in `world.ts`. That shape does not fit: `world.ts` tracks no agent id, and a scenario-level
fixture cannot know which id a step will pass at call time. Following it literally would create a
world-level agent that the ingest steps then ignore, because they pass their own ids.

Put the guarantee where the id is known — an **idempotent ensure-registered** step inside the
helpers that need a registered caller, delegating to the existing `registerAgent`. Safe to call
unconditionally (registration is idempotent), covers callers that already registered and those that
never did, and leaves no per-call-site patching for the next helper to forget.

### §S5 — Re-baseline the release gate
The queue's release-gate item must be corrected from "3 pre-existing e2e failures" to whatever
remains after §S2–§S4. If genuine product defects remain once the drift is gone, enumerate them —
those are the real gate items, and they have never been visible until now.

## Acceptance criteria
- [ ] The true pre-fix failure inventory is recorded, each failure classified drift vs other (§S1).
- [ ] `filePlan` sends a registered `agentId`; no route rejects it for identity — asserted.
- [ ] `ingestParsed` / `ingestJunit` / `ingestCompile` reach the server only with a registered id,
      INCLUDING when the caller supplies its own unregistered id (e.g.
      `cycle-run-navigation.steps.ts`'s generated `crb-filler-*`) — asserted with such an id.
- [ ] The guarantee is idempotent: a caller that ALREADY registered (e.g. `seeding.steps.ts`) still
      works, with no duplicate-registration failure — asserted.
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
  for a registration not exercising a TDD phase. (Gap analysis: the existing `registerAgent` helper
  ALREADY sends `role: "report"`, so reusing it satisfies this by construction — the risk is only
  live if someone writes a second registration path.)
