# CR-CRU-188 — a migration proof does not read an aged live store

**Type** fix (patch CR) · **Points** 2 (set at filing, 2026-10-14) · **Wave** 8 (0.4.0) · **Depends
on** — · **Status** PENDING — filed 2026-10-14 (user ruling: a patch CR worked after CR-CRU-186)

## Problem

Found during CR-CRU-186 (cycle 672, 2026-10-14). The full bun suite fails one test, on the feature
branch and on develop alike: `tests/commit-boundary-migrates-to-stored-columns.test.ts`, the "AC1 — a
copy of the dev store, migrated…" case. It passed at 08:34 the same morning and fails every run since.

The case copies the live `data/crucible.db` and compares two answers for every plan's commit boundary:
- the boundary a raw read of the copy DERIVES today from the events it holds (the pre-migration rule,
  frozen in the test);
- the boundary the copy holds in its STORED columns after `Store.open` migrates it.

That comparison proved the v18 → v19 migration once, when the dev store was still at v18. The dev
store has since been migrated (it is at v20), so both copies already carry the boundaries stored on
the day it migrated. The board keeps a fixed number of events (retention), and as the oldest are
pruned, today's derivation drifts away from the value stored then. Measured: plan 99's
`firstRunCommit` derives as `6227ca3…` and is stored as `d2b0e82…`. The stored columns exist
precisely so a boundary survives that pruning. The test asserts over live data that has aged, so it
now fails for a reason that is not a defect.

## Steps

### §S1 — the migration proof runs only on a store it migrates

The live-store case runs only when the copy is at a schema version BEFORE the boundary migration.
When the copy is already past it, the case states that it has nothing to prove and skips, the same
way it already skips when there is no dev store. The synthetic-fixture cases, which build a v18
store and migrate it, keep proving the migration on every run.

(Whether the live-store case is deleted instead, as a one-time proof whose job is done, is settled
at gap analysis.)

## Acceptance criteria

- [ ] **No false failure.** With a dev store at the current schema version, the full bun suite passes
      that file, and the live-store case reports that it skipped and why.
- [ ] **The proof still runs where it applies.** The synthetic v18-to-current cases pass unchanged,
      and a live-store copy downgraded to before the boundary migration is still compared.
- [ ] **No new CR literals.** No CR-shaped literal is added, and the citation tripwire's pins are
      unchanged.

## How it is worked

On a feature branch: RED, GREEN in the test file, then verify.
