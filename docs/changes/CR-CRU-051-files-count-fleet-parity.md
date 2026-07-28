# CR-CRU-051 — Propagate the run-envelope `files` count to the other four clients

**Status:** PENDING
**Type:** patch (fleet parity — gate visibility)
**Priority:** P2 — an absent signal, not a wrong one; no client misreports today. Wave 4, i.e.
0.1.0, per the queue's convention (Wave 4 = 0.1.0; only Wave 5 rows carry a 0.2.0 qualifier)
**Depends on:** CR-CRU-047 (§S2 introduced `files` in the bun client), CR-CRU-050 (touches the same envelope builders — land after it to avoid a collision)
**Labels:** patch, client-fleet, gate-correctness, axi-compliance, fleet-parity
**Phase:** Wave 4
**Design reference:** CR-CRU-047 §S2, which added the distinct test-FILE count to the bun run
envelope so *"a shrinking suite is visible in the gate output itself"*. Found 2026-07-28 by a
fleet-drift audit during CR-CRU-050 C2 (user-prompted: which bun changes apply to the other
scripts?).

## Context
CR-CRU-047 §S2 was scoped to the bun client because it was chasing a bun-specific gate break. The
`files` count it introduced is not bun-specific — it is a generic gate-integrity signal — and it
never crossed to the rest of the fleet:

| client | run envelope | `files` |
|---|---|---|
| bun `:1504` | `{passed, failed, pending, total, files}` | ✅ |
| python `:392` | `{passed, failed, total}` | ❌ |
| rust `:366` | `{passed, failed, total}` | ❌ |
| mvn `:380` | `{passed, failed, total}` | ❌ |
| arduino `:302` | `{passed, failed, total}` | ❌ |

**Why it matters.** `total` alone cannot distinguish *"fewer tests ran"* from *"the suite stopped
being discovered"*. That distinction is the entire subject of CR-CRU-039, where
`python-crucible.py regression` discovered **0** tests and the run was misreported as a compile
ingest — silently, because nothing in the envelope described collection breadth. `files` is the
second signal: a suite whose file count drops is visibly shrinking even when `total` looks
plausible. The client where that defect actually bit is one of the four still missing it.

This is an ABSENCE, not a misreport — unlike CR-CRU-050, no client states anything false today.
That is why it is filed at P2 rather than as a blocker.

## Scope

### §S1 — Compute the distinct-source count in each client's parser
Follow `bun-crucible.py:_parse_junit_file` (`:440`), which is the reference. Its fallback chain
exists precisely so the count degrades instead of collapsing to zero:

```python
source = tc.get("file") or tc.get("classname") or suite.get("name")
if source:
    files.add(source.replace("\\", "/"))
```

Per format: surefire and xmlrunner stamp `classname` (per-CLASS granularity — that is the format's
contract, not a defect, exactly as CR-CRU-049 §"Non-goals" records for narration); nextest and the
arduino native harness should be checked for a `file` attribute first. **State the resolved
granularity per client** — "files" that is really "classes" must be labelled honestly rather than
implying per-file precision the format cannot give.

### §S2 — Surface it in the envelope and the plain count lines
Add `files` to each client's `run:` block alongside `passed`/`failed`/`pending`/`total`, and to the
human-readable count lines CR-CRU-050 §S2 swept. Keep the key name `files` — fleet parity with bun
is the whole point of this CR.

### §S3 — Rust has TWO parse sites
`rust-crucible.py:762` and `:1306` (the second is the `pre-merge-gate` path). Both need it. This is
the same trap CR-CRU-050 flagged: fixing only the first looks complete and leaves the merge gate
blind.

## Acceptance criteria
- [ ] Each of python, rust (×2 sites), mvn and arduino computes a distinct-source count and emits
      `files` in its `run:` envelope — asserted per client.
- [ ] The resolved granularity per client (file vs class) is recorded in a comment beside each
      implementation and stated in the CR's Implementation Notes.
- [ ] A report whose testcases carry no `file` attribute still yields a NON-ZERO `files` count via
      the `classname` → suite-name fallback — asserted. Degrading to zero would make a shrinking
      suite look identical to a healthy one, inverting the CR's purpose.
- [ ] `bun-crucible.py` is unchanged (already correct) — confirmed, not assumed.
- [ ] No change to `src/` or `public/`: `files` rides the printed envelope only, never the ingest
      payload (CR-CRU-047 §S2's explicit contract).
- [ ] Full bun regression green AND full Python regression green (client change → both gates, per
      CR-CRU-045 §S3).

## Non-goals
- Sending `files` to the server or modelling it on `RunEvent`. CR-CRU-047 §S2 deliberately kept it
  in the printed gate output only; this CR propagates that design, it does not revisit it.
- Per-file granularity where the report format only carries per-class (surefire, xmlrunner).
- The narration defect class — that is CR-CRU-049, and it applies only to mvn (bun and mvn are the
  only clients with narrators; python, rust and arduino have none — verified).

## Risk
- Landing this concurrently with CR-CRU-050 would collide — both edit the same envelope builders
  and the same parse loops in all four clients. Sequence after 050 merges.
- The `classname` fallback is what keeps the count meaningful for surefire/xmlrunner. Dropping it
  because "there is no `file` attribute" would emit `files: 0` everywhere, which is worse than
  omitting the key: a constant zero reads as a signal and conveys nothing.
