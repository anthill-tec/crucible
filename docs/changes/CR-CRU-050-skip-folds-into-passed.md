# CR-CRU-050 — Skipped/todo tests are counted as PASSED in the ingest envelope

**Status:** PENDING
**Type:** patch (gate correctness — reporting fidelity)
**Priority:** P1 — a green gate over-reports what actually ran
**Depends on:** CR-CRU-039 (the zero-discovery precedent), CR-CRU-047 (found it)
**Labels:** patch, client, bun, gate-correctness, reporting
**Phase:** Wave 4
**Design reference:** found by the CR-CRU-047 C3 VERIFY (2026-07-28) and **reproduced live in that
verification run**. Same defect family as CR-CRU-039: the gate must not silently misrepresent what
ran.

## Context
`_parse_junit_file` (`clients/bun-crucible.py`) classifies a testcase by checking only
`tc.find("failure")` and `tc.find("error")`. It never checks `<skipped/>`. bun 1.3.14 emits a
skipped test as `<testcase …><skipped/></testcase>` — no `failure`, no `error` — so **every skipped
or todo test is counted as PASSED**.

**Observed live during the CR-047 verification**, which is what makes this concrete rather than
theoretical:

| Source | Reported |
|---|---|
| bun's own output | `29 pass / 1 skip / 0 fail` |
| the client's ingest envelope | `passed=30 total=30` |

The skipped test was folded into `passed`. Ironically the skipped test was
`suite-integrity.test.ts`'s own corroboration case.

**Why it matters.** The whole premise of CR-CRU-039 — and of CR-CRU-047 which found this — is that
a gate reporting success over a suite that did not fully run is worse than a red gate, because
nothing contradicts it. A suite carrying `test.skip`/`test.todo` today reports an inflated green
`passed` count, and the dashboard, the coverage-on-green rule, and every close-out decision consume
that number. A test quietly skipped is indistinguishable from a test that passed.

## Scope

### §S1 — Classify skipped/todo separately in the bun client
`_parse_junit_file` must detect `<skipped/>` and count those testcases as skipped, not passed.
`passed + failed + skipped` must equal `total`.

### §S2 — Surface the skip count in the envelope
Add `skipped` to the `run:` block alongside `passed`/`failed`/`total`/`files`, so a skip is visible
where the orchestrator already reads. A count that exists but is not shown does not prevent the
misreading this CR is about.

### §S3 — Audit the other four clients
`python`, `rust`, `mvn` and `arduino` clients parse their own report formats (surefire, nextest,
xmlrunner). Determine whether each folds skips into passes and fix any that do. State the verdict
per client — an unaudited client is not a pass. Note the formats differ: surefire uses
`<skipped/>`, xmlrunner similar; do not assume one shape fits all.

### §S4 — Does the SERVER need the distinction?
Decide and record whether the skipped count should reach `/api/v2/runs/parsed` and be modelled on
`RunEvent`, or stay a client-side display concern. If it stays client-side, the dashboard will keep
showing skips as passes — say so explicitly rather than leaving it implied.

## Acceptance criteria
- [ ] A JUnit fixture containing a `<skipped/>` testcase parses to `skipped=1`, and that testcase
      is NOT counted in `passed` — asserted.
- [ ] `passed + failed + skipped == total` for every parsed report — asserted as an invariant, not
      only on the fixture.
- [ ] The `run:` envelope carries `skipped` alongside `passed`/`failed`/`total`/`files` — asserted.
- [ ] The reproduction case is covered: a suite whose bun output reads `N pass / 1 skip / 0 fail`
      produces an envelope reading `passed=N`, not `passed=N+1` — asserted end-to-end.
- [ ] Per-client verdicts from §S3 recorded, with fixes where needed.
- [ ] The §S4 decision recorded in the CR's implementation notes.
- [ ] Full bun regression green AND full Python regression green (client change → both gates, per
      CR-CRU-045 §S3).

## Non-goals
- Changing which tests are skipped, or removing skips from the suite.
- The `files` count (CR-CRU-047 §S2, already landed).
- Coverage-on-green policy — this CR makes the number honest; what the policy does with it is
  separate.

## Risk
- **Fixing the count will make some gates report fewer passes than before.** That is the point, but
  it may look like a regression at a glance — the commit message must say so plainly, or someone
  will "fix" it back.
- The four other clients parse different report formats; a single assumed shape will silently miss
  one. §S3's per-client verdict exists to prevent exactly that.
