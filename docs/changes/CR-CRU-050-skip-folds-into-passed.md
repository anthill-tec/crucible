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

**Gap-analysis correction (2026-07-28) — this CR REUSES `pending`; it introduces nothing.**
The original draft proposed a new `skipped` envelope field. That would have forked terminology
against a contract that already exists at every layer:

- **PRD §"summary"** (`docs/research/PRD-crucible-v2.md:121`) fixes the shape as
  `{total, passed, failed, pending, duration_ms}`, and PRD:179 states the JUnit mapping verbatim —
  *"fail, skipped → pending"*. The mapping this CR implements is already the design contract; the
  clients drifted from it.
- **Server**: `src/types.ts:49` (`pending: number`), the tree-node enum
  `status: "pass" | "fail" | "pending"` (`:55`, `:66`), the `pending INTEGER` column
  (`src/store.ts:299`), persist (`:1014`) and read-back (`:1065`).
- **Dashboard**: `public/app.js:3324` renders `⏭ pending <n>`, `:3310` synthesises pending heat
  cells, `:3251` applies `app-heat-pending`, `:3347` shows per-suite pending chips, `:3026` maps a
  pending leaf to `⏭`.
- **`mvn-crucible.py:641` already does it correctly** (`<skipped>` → `status="pending"`, `pending`
  incremented). It is the in-repo reference implementation for this fix.

So the whole stack is built and waiting; four of the five clients simply hardcode `"pending": 0`.
The fix is client-side only — no server, schema, or UI change.

**Do not confuse with `map_axi_step_status`** (`clients/_crucible_axi.py:404`,
`clients/bun-crucible.py:1574`), whose `"skipped": "skipped"` entry maps a *no-mistakes gate step*
status. It is an unrelated concept and is the first hit when grepping the fleet for "skipped".

**Observed live during the CR-047 verification**, which is what makes this concrete rather than
theoretical:

| Source | Reported |
|---|---|
| bun's own output | `29 pass / 1 skip / 0 fail` |
| the client's ingest envelope | `passed=30 total=30` |

The skipped test was folded into `passed`. Ironically the skipped test was
`suite-integrity.test.ts`'s own corroboration case.

**Reproduced again during the gap analysis (2026-07-28), on BOTH stacks, from artifacts already
in the tree** — 2 of the 99 reports under `test-reports/` carry `<skipped`:

| artifact | JUnit attributes | ingested as | truth |
|---|---|---|---|
| `junit.xml` (bun, whole suite) | `tests="1061" skipped="1"` | `passed=1061` | 1060 ran, 1 skipped |
| `TEST-…RunContextHelperContractTest…xml` (python) | `tests="2" skipped="2"` | `passed=2` | **0 ran**, an entire test class skipped |

The python case is the sharper one: a test class in which *nothing executed* is indistinguishable
from one that fully passed. This also means the "1061/1061" and "412/412" figures quoted in this
project's own close-out reports are inflated — the defect contaminates the gate numbers this
project publishes about itself, which is the exact failure mode CR-CRU-039 and CR-CRU-047 exist to
prevent.

**Why it matters.** The whole premise of CR-CRU-039 — and of CR-CRU-047 which found this — is that
a gate reporting success over a suite that did not fully run is worse than a red gate, because
nothing contradicts it. A suite carrying `test.skip`/`test.todo` today reports an inflated green
`passed` count, and the dashboard, the coverage-on-green rule, and every close-out decision consume
that number. A test quietly skipped is indistinguishable from a test that passed.

## Scope

### §S1 — Populate `pending` in the four defective clients
Each defective parser must detect `<skipped/>` and classify that testcase as **pending** — never
as passed. Follow `mvn-crucible.py:641` exactly; it is the correct precedent:

```python
if tc.find("failure") is not None or tc.find("error") is not None:
    status = "fail";    failed += 1;  suite_fail = True
elif tc.find("skipped") is not None:
    status = "pending"; pending += 1
else:
    status = "pass";    passed += 1
```

The invariant is `passed + failed + pending == total`.

**The gap-analysis audit is complete — these are the sites** (§S3's verdict, established before
implementation rather than during it):

| client | parse site | `<skipped>` checked | current `pending` |
|---|---|---|---|
| mvn | `_parse_junit:641` | ✅ yes | real count — **the reference, no change** |
| bun | `_parse_junit_file:506` | ❌ no | hardcoded `0` |
| python | `_parse_junit_dir:518` | ❌ no | hardcoded `0` |
| arduino | `_parse_junit:357` | ❌ no | hardcoded `0` |
| rust | `:762` **and** `:1306` | ❌ no | hardcoded `0` (**two** parse sites — both must be fixed) |

Five parse sites across four clients. All four carry the identical unguarded
`status = "fail" if fail else "pass"` with a bare `else: passed += 1`.

### §S1b — The tree LEAF status, not only the counts
Each skipped testcase's tree node must carry `status: "pending"`. `src/types.ts:55`/`:66` already
permit it and the dashboard already renders it (`⏭` via `public/app.js:3026`, `app-heat-pending`
via `:3251`). Today a skipped leaf is emitted as `"pass"`, so the run drill-in paints it green.
**Counts alone leave this visible defect in place** — a fix that only touches the summary would
satisfy a naive count assertion while the drill-in stays wrong.

### §S2 — Surface `pending` in the printed run envelope
Add `pending` to the `run:` block alongside `passed`/`failed`/`total`/`files`
(`clients/bun-crucible.py:1495-1496`, and the equivalent in each other client), so a skip is
visible where the orchestrator already reads. A count that exists but is never shown does not
prevent the misreading this CR is about. Use the name `pending` — matching the PRD, the DB column
and the dashboard label — not `skipped`.

### §S3 — Per-client audit: DONE (see the §S1 table)
Recorded above rather than deferred into implementation. The formats do differ (surefire,
xmlrunner, nextest, the arduino native harness) but all four emit the `<skipped/>` child element,
so one guard shape does fit — this is an empirical finding from the audit, not an assumption.
RED must still prove it per client with a real fixture for each format.

### §S4 — Server: DECIDED ALREADY, no change required
Not an open question. PRD:121 and PRD:179 mandate `pending` in `summary` and the
`skipped → pending` mapping; `/api/v2/runs/parsed` already accepts it, `src/store.ts:299` has the
column, `:1014` persists `event.summary?.pending`, `:1065` reads it back. The dashboard renders it.
**No server, schema, migration or UI work is in scope.** A client that omits `pending` stores
`NULL` and reads back `0` (`:1014` / `:1065`), which is precisely why the defect was invisible.

## Acceptance criteria
- [ ] For EACH of the five parse sites in §S1, a report fixture in that client's own format
      containing a `<skipped/>` testcase parses to `pending=1`, and that testcase is NOT counted
      in `passed` — asserted per client (bun, python, arduino, rust ×2).
- [ ] `passed + failed + pending == total` for every parsed report — asserted as an invariant, not
      only on the fixtures.
- [ ] **§S1b** — the skipped testcase's tree leaf carries `status: "pending"` (not `"pass"`) —
      asserted per client. An assertion on counts alone does NOT satisfy this criterion.
- [ ] The `run:` envelope carries `pending` alongside `passed`/`failed`/`total`/`files` — asserted.
- [ ] The bun reproduction is covered end-to-end: a suite whose output reads `N pass / 1 skip /
      0 fail` produces an envelope reading `passed=N pending=1`, not `passed=N+1`.
- [ ] The python reproduction is covered: an xmlrunner report with `tests="2" skipped="2"` produces
      `passed=0 pending=2`, not `passed=2`.
- [ ] `mvn-crucible.py` is UNCHANGED (it was already correct) — confirmed, not assumed.
- [ ] No change to `src/` or `public/` — the server and dashboard already model and render
      `pending` (§S4). A diff touching them means the fix went the wrong way.
- [ ] Full bun regression green AND full Python regression green (client change → both gates, per
      CR-CRU-045 §S3). Expect the reported totals to DROP — see Risk.

## Non-goals
- Changing which tests are skipped, or removing skips from the suite.
- The `files` count (CR-CRU-047 §S2, already landed).
- Coverage-on-green policy — this CR makes the number honest; what the policy does with it is
  separate.

## Risk
- **Fixing the count will make some gates report fewer passes than before.** That is the point, but
  it may look like a regression at a glance — the commit message must say so plainly, or someone
  will "fix" it back. Concretely: the bun gate becomes `passed=1060 pending=1 total=1061` where it
  read `passed=1061`. Nothing got worse; the number got honest.
- Any test asserting a hardcoded expected `passed` total will now fail and must be re-pointed to
  the true figure — NOT by relaxing the assertion. Sweep for such assertions during RED.
- The four clients parse different report formats; the audit found `<skipped/>` common to all, but
  RED must still prove it with a real fixture per format rather than reusing one shape.
- **rust has TWO parse sites** (`:762`, `:1306`). Fixing only the first is the likely partial fix,
  and the second is the `pre-merge-gate` path — i.e. the one that gates merges.
- Grepping the fleet for "skipped" hits `map_axi_step_status` first (`_crucible_axi.py:404`,
  `bun-crucible.py:1574`) — an unrelated no-mistakes GATE step status. Do not modify it.
