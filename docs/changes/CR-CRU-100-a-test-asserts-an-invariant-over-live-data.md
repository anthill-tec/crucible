# CR-CRU-100 — a test asserts an invariant over live data

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: none
- **Status**: PENDING (0.2.0) — filed 2026-09-02
- **Found by**: CR-CRU-096's regression gate, then reproduced at the merge base

## Problem

`tests/store-migration.test.ts:538` — "AC2 — a copy of the REAL dog-food store is stamped from 0
with identical row counts" — **fails on `develop`**, and has nothing to do with the CR whose gate
surfaced it. Proven by running the file in a clean worktree at `63f07f5`: byte-identical failure.

```
expect(eventRoleCount(dbPath)).toBe(rolesBefore)
Expected: 637
Received: 638   (tests/store-migration.test.ts:573)
```

The test copies the **live dog-food store** (`data/crucible.db`), counts role-bearing events, opens
the copy through `Store.open` so the migrations run, and asserts the count is unchanged — the
CR-CRU-057 guarantee that backfilled roles are not re-derived destructively.

It now fails because opening the store backfills **one more** role than the copy already had. The
count is a property of *today's data*, not of the code: a role-bearing event ingested during this
session is one the backfill can newly classify. The assertion was true when written and is false
now, with no code change between.

## Why this is the same disease CR-CRU-096 AC29 names

CR-CRU-096 AC29 rules that **no AC fixture may name a real CR of the project running Crucible**,
because a criterion that only holds while our own backlog has a given shape is not a criterion.
This test is the store-side instance of exactly that: its fixture is our own live, mutable database,
so the invariant it states decays every time we dog-food. CR-CRU-096 fixed the roadmap-side
instances; nobody looked at the store side.

The distinction that keeps this honest, already recorded under CR-CRU-097: a **reproduction** may
use real data — that is what makes it a reproduction. A **contract** may not. `AC2` is a contract:
it asserts migration does not lose or re-derive data, which must hold for every store, not for one
snapshot of ours.

## A second defect in the same test

The run emits, every time:

```
[crucible] CORRUPT DATABASE at /tmp/crucible-cr071-XXXX/crucible.db — moving it aside
… and starting with a fresh db (SQLiteError: file is not a database)
```

So one of the copies the test makes is **not a valid database** and the store silently starts a
fresh one. A test that means to exercise migration against a real store is, on that path,
exercising it against an empty file — and passing. The copy is almost certainly torn: the live
server holds the DB open with WAL, and copying only `crucible.db` without its `-wal`/`-shm` yields
an inconsistent file. This is a second, quieter failure mode hiding inside a test whose loud
failure is the row count.

## Scope

### §S1 — the contract runs against a store the test builds

`AC2`'s invariant is restated over a store the test constructs with a known, synthetic history
covering the cases the migration must survive — including events with roles already present and
events whose roles must be backfilled. The assertion becomes a statement about migration, provable
on any machine and in CI, where `copyOfRealStore()` currently returns `null` and the test SKIPS
entirely (so CI has never run this at all).

### §S2 — the real store is still exercised, but as a smoke check

The dog-food store is genuinely valuable: it is the only store with real history. It is retained as
a separate, clearly-labelled check that asserts only what is true of ANY store — migration
completes, `SCHEMA_VERSION` reaches the current value, no table is dropped, and total row count does
not DECREASE. No exact-count equality, because exact counts are a property of the data.

### §S3 — the copy is consistent or the test refuses to run

Copying a live SQLite database means copying its WAL, or using SQLite's own backup API / `VACUUM
INTO`. `copyOfRealStore()` takes a consistent snapshot; if it cannot, it SKIPS with a stated reason
rather than silently handing a torn file to a store that will quietly replace it. The
`CORRUPT DATABASE` path must never be reachable from a passing test.

## Acceptance criteria

- **AC1** — `AC2`'s role-preservation invariant runs against a test-built store with synthetic
  history, and passes on a machine with no dog-food store present.
- **AC2** — The rewritten contract FAILS if CR-CRU-057's backfill is made destructive (prove it by
  reverting that guard in a scratch edit, not by assertion alone).
- **AC3** — The live-store check asserts only data-independent properties; it contains no
  exact-count equality against a live table.
- **AC4** — `copyOfRealStore()` produces a consistent snapshot, or skips with a stated reason. The
  `CORRUPT DATABASE … file is not a database` log line does not appear in a passing run.
- **AC5** — Both checks run in CI. The suite must not be silently skipped there — a skip that hides
  a never-executed contract is the defect this CR exists for.
- **AC6** — Regression: `tests/store-migration.test.ts` is green on `develop` with the live
  dog-food store present, and green again after ingesting a new role-bearing event (the exact
  mutation that broke it).
