# CR-CRU-055 — Patch: bun env-quieting strip misses `AI_AGENT` (narration + failure-marrying die in agent sessions)

**Status:** PENDING
**Type:** patch (client correctness)
**Priority:** P1 — every agent-session gate run today ingests failure-message-less envelopes and posts no narration
**Depends on:** CR-CRU-047 (the env-quieting strip + narration guards), CR-CRU-038 (§S2c failure marrying)
**Labels:** patch, client, bun, narration, env-quieting
**Phase:** Wave 4
**Design reference:** CR-CRU-047 §S3 — the env-quieting strip whose defect class this recurs.

## Context
`bun test` suppresses its per-test result tick lines when it detects an agent session.
`clients/bun-crucible.py` depends on those lines streaming: the §S2b narrator counts them
live for `running N/M` heartbeats, and the §S2c marrying reads the `error:` blocks under
them to attach `failure.message` to failing leaves. CR-CRU-047 therefore strips the known
quieting variables from the wrapped runner's env — `("CLAUDECODE", "AGENT", "REPL_ID")` at
`clients/bun-crucible.py:765` and `:839`.

The harness environment has since grown a NEW quieting variable: **`AI_AGENT`** (present
in Claude-Code sessions as of 2026-08-01; absent when CR-047 closed green on 2026-07-28).
The bun binary is unchanged (1.3.14, May) — its detection set always included `AI_AGENT`;
the variable simply never existed here before. Verified side-by-side on a 2-test fixture:
`(pass)` ticks stream with `AI_AGENT` unset and vanish entirely with it set.

Consequences today, in any agent session:
- 4 narration tests + the §S2c marrying test fail on `develop` — reproduced identically at
  every commit back to the CR-047 merge (`f610653`), proving an environmental recurrence,
  not a code regression in the 07-28 merge window;
- REAL gate runs ingest envelopes whose failing leaves carry no `failure.message`, and the
  dashboard receives no `running N/M` narration heartbeats.

## Scope

### §S1 — Add `AI_AGENT` to both strip tuples
`clients/bun-crucible.py:765` and `:839` become
`("CLAUDECODE", "AGENT", "REPL_ID", "AI_AGENT")`. Only the bun client carries the pattern
— bun is the fleet's only env-quieting runner.

### §S1b — Widen the tick matchers: plain `(pass)`/`(fail)` is a legal wire form (found at C1 GREEN, 2026-08-01)
The strip alone proved necessary but not sufficient. The PATH-resolved runner on this
machine is `bun test v1.3.14-canary.1`, which through an uncoloured pipe emits PLAIN
result lines — `(pass) name [ms]` / `(fail) name` — where the stable binary emitted the
ANSI ✓/✗ family. `_COMPLETION_LINE` (`clients/bun-crucible.py:190`) and the §S2c
result-line family (≈`:533`) match ONLY the ANSI form, so narration and marrying stay
blind even with §S1 in place.

**Fix (decision: widen, not force):** both matcher families accept BOTH wire forms —
ANSI ✓/✗ AND plain `(pass)`/`(fail)`. Rejected alternatives: `FORCE_COLOR=1` in the
wrapped env (re-introduces env coupling, the exact fragility class this CR exists to
fix) and pinning the stable binary (not controllable on consumer machines; the canary
form is the coming stable).

### §S2 — Name `AI_AGENT` in the regression guards
Extend the CR-047 §S3 guard family in `tests/clients-narration.test.ts` with an
`AI_AGENT`-explicitly-SET variant (mirroring the existing CLAUDECODE=1 guard), so the next
new quieting variable is one test + one tuple entry away from being pinned.

## Acceptance criteria
- [ ] A real client-wrapped run with `AI_AGENT=1` in the spawn environment still posts
      `running N/M` heartbeats — asserted by the new §S2 guard.
- [ ] The 5 currently-failing tests (4 narration + §S2c marrying) pass with `AI_AGENT` set
      in the ambient environment (as it is in agent sessions).
- [ ] Narration and §S2c marrying work against BOTH tick forms — asserted with the real
      runner (plain form) while the existing ANSI-fixture tests stay green (§S1b).
- [ ] Full bun regression green AND full Python regression green (client change → both
      gates, CR-CRU-045 §S3).

## Non-goals
- Auditing mvn narration (that is CR-CRU-049).
- Generalizing quieting detection beyond the known-list mechanism CR-047 chose.

## Risk
- The quieting list is reactive by construction — a future harness variable recurs the
  same way. Accepted trade-off (CR-047's design); the §S2 guard pattern keeps each
  recurrence a one-line fix.
