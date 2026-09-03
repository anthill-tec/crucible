# CR-CRU-100 — a test asserts an invariant over live data

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: none
- **Status**: PENDING (0.2.0) — filed 2026-09-02, **gap-analysed and corrected 2026-09-03**
- **Found by**: CR-CRU-096's regression gate, then reproduced at the merge base

## Problem

`tests/store-migration.test.ts` — "AC2 — a copy of the REAL dog-food store is stamped from 0 with
identical row counts" — **fails on `develop`**, and has nothing to do with the CR whose gate
surfaced it. Reproduced at HEAD 2026-09-03: `14 pass / 1 fail`.

```
expect(eventRoleCount(dbPath)).toBe(rolesBefore)
Expected: 716
Received: 717
```

**The numbers move every session.** Filing quoted `637 / 638`; the same assertion measured
`716 / 717` a day later with no code change between. That drift is not incidental — it is the
defect, stated by the test itself.

### The failing line is NOT the criterion its test is named for

Corrected by gap analysis. The test makes two before/after comparisons, and only one fails:

- `expect(rowCounts(dbPath)).toEqual(before)` — **PASSES.** This is CR-CRU-071 AC2's actual stated
  criterion ("same row counts for `projects`/`plans`/`plan_cycles`/`events`/`rollups`"), and it is
  data-INDEPENDENT: it compares the same copy before and after migration, so it holds for any store.
- `expect(eventRoleCount(dbPath)).toBe(rolesBefore)` — **FAILS.** An additional assertion defending
  CR-CRU-057's backfill, beyond anything AC2 asks for.

### The invariant is incompatible with CR-CRU-057 by construction, not merely data-dependent

The backfill is `UPDATE events SET role = ?, role_inferred = 1 WHERE id = ? AND role IS NULL`
(`src/store.ts`, `backfillInferredEventRoles`). It can only ever **add** a role; it can never change
or remove one. So an equality-of-count assertion fails on **any** store holding a
classifiable-but-unclassified event — not just ours, and not just today.

This matters for the fix: a synthetic fixture that contains "events whose roles must be backfilled"
would fail the *same* assertion. The invariant has to become **preservation** — no existing role is
changed or lost, and the count never DECREASES — which is what CR-CRU-057 actually guarantees. An
equality assertion forbids the backfill from ever doing its job.

## Why this is the same disease CR-CRU-096 AC29 names

CR-CRU-096 AC29 rules that **no AC fixture may name a real CR of the project running Crucible**,
because a criterion that only holds while our own backlog has a given shape is not a criterion. This
test is the store-side instance: its fixture is our own live, mutable database. CR-CRU-096 fixed the
roadmap-side instances; nobody looked at the store side.

The distinction that keeps this honest, already recorded under CR-CRU-097: a **reproduction** may
use real data — that is what makes it a reproduction. A **contract** may not.

## What this CR SUPERSEDES, and what it deliberately does not

**CR-CRU-071 AC2 is shipped and is not edited.** It states, in bold: *"Proven against a **copy of the
real dog-food store, not a synthetic fixture**: same row counts for
`projects`/`plans`/`plan_cycles`/`events`/`rollups` before and after."*

That choice is honoured. **Ruled 2026-09-03 (option 1): nothing shipped is weakened.** The
real-store check KEEPS its `rowCounts` equality, because it passes and is data-independent. Only the
role-count line — which is not AC2's criterion — is restated as preservation, and it gains a
synthetic fixture so the contract is provable where no dog-food store exists. CR-CRU-071 AC2's proof
obligation survives intact.

## Scope

### §S1 — the role-preservation contract runs against a store the test builds

A store constructed with known synthetic history covering the cases the migration must survive:
events with roles already present, and events whose roles must be backfilled. Against it, the
assertion is CR-CRU-057's real guarantee — **every role present before migration is present and
unchanged after, and no role is re-derived over an existing value** — provable on any machine and in
CI, where the live store is absent.

### §S2 — the real store keeps AC2's equality, and gains nothing weaker

The dog-food store stays exactly as strong as CR-CRU-071 left it: `rowCounts` equality before and
after, `user_version` reaching `SCHEMA_VERSION`, no table dropped. **No count assertion is
loosened.** The only change is that its role assertion moves from equality-of-count to the same
preservation statement §S1 makes, because equality is what contradicts the backfill.

### §S3 — RETRACTED: the snapshot is already consistent

**Withdrawn 2026-09-03 by gap analysis; it described a defect that does not exist.**

The filing claimed the copy was "almost certainly torn" and prescribed "SQLite's own backup API".
`snapshotLiveStore` **already uses it** — `sqlite3 <live> ".backup '<dest>'"`, with a comment
explaining why a file copy would be wrong. Verified by running the identical command: exit 0, a
valid 18 MB SQLite file, `user_version 8`, 766 events.

The `CORRUPT DATABASE … file is not a database` line is **a deliberate fixture**: a passing test
writes `"this is not sqlite"` to a scratch path to prove `Store.open` survives corruption.
`copyOfRealStore` has exactly one consumer — the AC2 test — so no copy this suite makes is invalid.
Nothing here needs fixing, and the original AC4 (*"the log line does not appear in a passing run"*)
would have required muting or deleting legitimate coverage.

## Acceptance criteria

- **AC1** — The role-preservation contract runs against a test-built store with synthetic history
  and passes on a machine with no dog-food store present.
- **AC2** — It FAILS if CR-CRU-057's backfill is made destructive — prove it by scratch-editing
  `backfillInferredEventRoles`'s `AND role IS NULL` guard away so it overwrites an existing role,
  not by assertion alone. Restore byte-identically and show it.
- **AC3** — The contract is satisfied by a fixture that CONTAINS an event needing backfill, so a
  count-equality assertion could not pass it. This is the AC that pins the corrected diagnosis: the
  old invariant forbade the backfill from working.
- **AC4** — CR-CRU-071 AC2's `rowCounts` equality against the real store is **retained unchanged**,
  and the real-store check adds no assertion weaker than the one it shipped with. A diff showing
  that equality still present is the evidence.
- **AC5** — The synthetic contract runs in CI. The live-store check is expected to SKIP there and
  says so with a stated reason — `data/crucible.db` is never committed (`git ls-files data/` is
  empty) and CI declares `CRUCIBLE_DB` only for the e2e job, so it cannot run and must not pretend
  to. A skip that hides a never-executed contract is the defect this CR exists for; §S1 is what
  removes it.
- **AC6** — Regression: `tests/store-migration.test.ts` is green on `develop` with the live store
  present, and green again after ingesting a new role-bearing event — the exact mutation that broke
  it, which today moves the count by one.

## Non-goals

- **Weakening any CR-CRU-071 criterion.** Ruled out explicitly; see §S2.
- **Silencing the `CORRUPT DATABASE` log.** It belongs to a passing test that earns it (§S3).
- **Rewriting `snapshotLiveStore`.** It already takes a consistent snapshot; it is consumed as-is.
- **Editing CR-CRU-071's spec.** Shipped CRs are never edited; the supersession is recorded here.
