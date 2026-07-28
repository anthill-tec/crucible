# CR-CRU-047 — Bun gate integrity: narration tests fail deterministically + an unexplained test-count drop

**Status:** PENDING
**Type:** patch (gate correctness — investigation + fix)
**Priority:** P1 — the bun gate is currently red on `develop`, and its TOTAL is unexplained
**Depends on:** CR-CRU-008 (§S2b in-run progress narration — the actual owner), CR-CRU-039 (the zero-discovery precedent)
**Labels:** patch, gate-correctness, bun, client, narration, test-discovery
**Phase:** Wave 4
**Design reference:** found by the CR-CRU-042 C1 orchestrator gate (2026-07-28). CR-CRU-039
established the precedent that a suite silently running FEWER tests than expected is a gate
defect in its own right, independent of any failing assertion.

## Context
Two symptoms, found together. They may share a cause or may not — **establishing that is part of
this CR's work.**

### Symptom A — narration tests fail deterministically
`tests/clients-narration.test.ts` — 2 of 4 tests fail, both on the same precondition:

```
expect(matches.length).toBeGreaterThan(0)   →   Received: 0
```

- `§S2b … a 24-test bun run (120ms sleeps, spans ~2.9s) narrates 'running N/M' heartbeats polled
  via GET /api/v2/agents BEFORE the final ingest, throttled (≥~2s or ≥10 completions apart)`
- `§S2b … narration heartbeats never leak into the script's own stdout, and never journal MORE
  than the one 'registered' lifecycle event however many heartbeats fired`

So `clients/bun-crucible.py` emits **no** `running N/M` narration at all during a run that does
span ~3s (test duration measured at 3014 ms).

**Already ruled out by the orchestrator — do not re-do this work:**
| Hypothesis | Result |
|---|---|
| Caused by CR-CRU-042 | **No** — reproduces identically on `develop` without it |
| Introduced by a recent merge | **No** — fails at `3ac8d6e` (CR-041), `b7a5b87` (CR-045) and `d1e57a8` (CR-043) alike |
| Flaky/timing | **No** — 2 pass / 2 fail deterministically across repeated runs |
| The dog-food server on `:3849` interfering | **No** — still fails with it stopped |
| Client misrouted to the wrong server | **No** — the test injects `CRUCIBLE_URL` at its own `startServer({port:0, dbPath:":memory:"})` instance |

**The unexplained part:** those same commits gated **GREEN hours earlier the same day** — CR-041
at bun 1081/1082 (the single failure being CR-045's coverage-shadow test) and CR-043 at bun
1098/1098. Same code, same machine, opposite result. So the trigger is environmental/state-based
and is NOT in the commit graph. Finding it is the point.

### Symptom A2 — a third failure, in a different file
`tests/clients-bun-crucible.test.ts` — 1 of 15 fails:

> `§S2c: matched failing leaves carry failure.message married from the console stream`

Established: that file is **byte-identical to `develop`** (`git diff develop..HEAD` empty), and in
the MAIN tree it runs **14 pass / 1 fail** — so it is not caused by CR-CRU-042. It shares the
`clients/bun-crucible.py` console-stream parsing surface with Symptom A, so a common cause is
plausible but NOT established. This CR owns it outright; do not leave it unattributed.

### 🚨 Methodology warning — do NOT bisect with `git worktree`
Fresh worktrees do not contain `node_modules`, `.venv`, `.env` or `data` (all gitignored), and the
client tests spawn the Python client, which needs `.venv` + `.env`. A worktree run of
`tests/clients-bun-crucible.test.ts` reports **43 failures** that are pure environment artifacts.
Any bisect must run in a tree with the full environment present, or its results are noise. The
Symptom-A conclusions in the table above were corroborated by a MAIN-tree run (2 pass / 2 fail)
and stand; anything else derived from worktree runs must be re-established.

### Symptom B — RESOLVED during gap-analysis: not a collection failure
The bun total is fully accounted for. `bun test` reports **1045 tests across 87 files**; there are
**91** `.test.ts` files on disk. The four absent ones are all under `tests/archive/`, excluded
DELIBERATELY by `bunfig.toml` (`[test] pathIgnorePatterns = ["tests/archive/**"]`). Nothing fails
to collect.

My earlier "~11 unaccounted" figure came from comparing a **static `test(` grep against a runtime
total** — an unsound comparison (the grep counts occurrences in comments and strings). No defect
here. §S1 below therefore changes from "reconcile the count" to "delete the dead weight that made
it unreconcilable".

### Symptom C — 2,235 lines of unrunnable dead test code
`tests/archive/` holds four suites pinning the **v1 shim**, which is RETIRED:
- `src/server.ts:222` — *"CR-CRU-008 §S4 — the v1 shim is RETIRED: no legacy /api/\* routes"*; there is no `src/shim*` module at all.
- The archived files test an API that no longer exists, and can never run (excluded from discovery).
- Their own header still declares itself *"the PERMANENT regression gate for the shim's wire contract… forever"* — false since the shim was removed.
- The contract that still matters is already covered by a LIVE test: `tests/shim-retirement.test.ts` asserts legacy `/api/*` returns 404.

"Kept for historical reference" is what git history is for. This is accumulation, and it is what
made the test count unexplainable and cost an investigation.

## Scope

### §S1 — DELETE `tests/archive/` and its exclusion
Remove the four retired-shim suites (2,235 lines) and the now-pointless
`pathIgnorePatterns = ["tests/archive/**"]` from `bunfig.toml`. Git history preserves them; the
working tree should not. After this, on-disk `.test.ts` files and files bun runs must be EQUAL —
no permanently-excluded directory.

### §S2 — Make a shrinking suite impossible to miss
Surface the collected file/test count in the client's regression envelope so a drop is visible in
the gate output itself — the CR-CRU-039 treatment applied to the bun side. With §S1 landed, a
divergence between on-disk test files and files run has no legitimate cause, so it can be
asserted rather than merely reported.

### §S3 — Root-cause and fix the narration failure
Determine why `clients/bun-crucible.py` emits no `running N/M` narration in this environment when
it did hours earlier on identical code. The environmental dimension is the lead — bun's version
(`bun test v1.3.14-canary.1` observed), its reporter/streaming output format, or an interaction
with the throttle window (≥~2s or ≥10 completions). Fix the cause; if the narration contract
itself is wrong, correct the contract and say so explicitly rather than relaxing the assertion.

### §S4 — Cross-stack gate note
`clients/bun-crucible.py` is Python whose observable contract is asserted by bun tests — the
CR-CRU-045 §S3 rule applies: any change here needs BOTH gates before close-out.

## Acceptance criteria
- [ ] `tests/clients-narration.test.ts` is 4/4 green, with the `matches.length > 0` precondition
      INTACT — narration must actually occur, not be asserted away.
- [ ] `tests/clients-bun-crucible.test.ts` is 15/15 green — the `§S2c` failure-marrying test
      passes with its console-stream assertion intact (Symptom A2).
- [ ] `tests/archive/` no longer exists and `bunfig.toml` carries no `pathIgnorePatterns`
      exclusion; the count of on-disk `.test.ts` files EQUALS the file count bun reports —
      asserted, so a future permanently-excluded directory fails the gate.
- [ ] A test asserts the collected-test count is surfaced in the regression envelope, so a future
      silent drop fails the gate rather than passing it (§S2).
- [ ] Root cause of the narration failure is stated in the commit message — not merely "fixed".
- [ ] Full bun regression green AND full Python regression green.

## Non-goals
- Weakening or deleting the narration assertions to reach green. The `matches.length > 0`
  precondition exists specifically so the purity/journal invariants below it are non-vacuous;
  removing it would make the remaining assertions trivially true.
- Re-testing the hypotheses already eliminated in the Context table.
- Nothing outside the three failures and the count reconciliation named above.

## Risk
- **The tempting wrong fix is to relax `toBeGreaterThan(0)`.** That converts a real signal into a
  permanently green vacuous test. The AC forbids it.
- Symptoms A and B may be unrelated; forcing a single explanation could leave one unfixed. Treat
  the reconciliation (§S1) as independently completable.
- The environmental trigger may not reproduce after a machine state change, which would make the
  fix unverifiable. If that happens, §S2's count-surfacing is the durable safeguard and should
  land regardless.
