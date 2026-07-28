# CR-CRU-047 — Bun gate integrity: narration tests fail deterministically + an unexplained test-count drop

**Status:** PENDING
**Type:** patch (gate correctness — investigation + fix)
**Priority:** P1 — the bun gate is currently red on `develop`, and its TOTAL is unexplained
**Depends on:** CR-CRU-038 (§S2b in-run progress narration), CR-CRU-039 (the zero-discovery precedent)
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

### Symptom B — the bun total dropped by more than the deletions explain
| Gate | Total |
|---|---|
| CR-CRU-043 (green) | **1098** |
| CR-CRU-042 C1 | **1045** |

CR-042 deleted `tests/clients-skills.test.ts` (22 tests) and two `§S3` describes from
`tests/cr009-release-bundle.test.ts` (4 tests) = **26**. Expected ≈ 1072; observed 1045 — about
**11 tests unaccounted for** (allowing a few for the reworked Python-side stage cases, which do
not affect the bun total).

A file that fails to COLLECT drops its tests from the total silently rather than reporting a
failure. That is exactly the CR-CRU-039 defect class, and it is more dangerous than a red test:
a green gate over a shrinking suite reads as success.

## Scope

### §S1 — Account for every test in the bun total
Establish the authoritative per-file test inventory and reconcile it against the gate's reported
total. Identify whether any file fails to collect, is skipped, or silently contributes zero.
The deliverable is a reconciled number, not a guess: deletions + current total must equal the
prior total, or the difference must be named.

### §S2 — Make a shrinking suite impossible to miss
Whatever §S1 finds, the gate must not be able to report success over a suite that quietly stopped
running tests. Surface the collected-file/test count in the client's regression envelope so a
drop is visible in the gate output itself — the CR-CRU-039 treatment, applied to the bun side.

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
- [ ] The bun total is reconciled: a documented per-file inventory whose sum equals the gate's
      reported total, with any previously-missing tests named and restored.
- [ ] A test asserts the collected-test count is surfaced in the regression envelope, so a future
      silent drop fails the gate rather than passing it (§S2).
- [ ] Root cause of the narration failure is stated in the commit message — not merely "fixed".
- [ ] Full bun regression green AND full Python regression green.

## Non-goals
- Weakening or deleting the narration assertions to reach green. The `matches.length > 0`
  precondition exists specifically so the purity/journal invariants below it are non-vacuous;
  removing it would make the remaining assertions trivially true.
- Re-testing the hypotheses already eliminated in the Context table.
- The `§S2c failure-marrying` test that also failed in the same gate run — include it if §S3's
  root cause explains it, otherwise record it as a separate observation.

## Risk
- **The tempting wrong fix is to relax `toBeGreaterThan(0)`.** That converts a real signal into a
  permanently green vacuous test. The AC forbids it.
- Symptoms A and B may be unrelated; forcing a single explanation could leave one unfixed. Treat
  the reconciliation (§S1) as independently completable.
- The environmental trigger may not reproduce after a machine state change, which would make the
  fix unverifiable. If that happens, §S2's count-surfacing is the durable safeguard and should
  land regardless.
