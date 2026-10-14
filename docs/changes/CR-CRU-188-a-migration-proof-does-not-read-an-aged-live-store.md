# CR-CRU-188 — a gate measures the code, and a red gate stops the merge

**Type** fix (patch CR) · **Points** 5 (re-scoped 2026-10-14; filed at 2) · **Wave** 8 (0.4.0) ·
**Depends on** — · **Status** PENDING — filed 2026-10-14; re-scoped the same day (user ruling: a
patch CR, worked immediately, for the failure that got past the gates)

## Problem

Found during CR-CRU-186 (cycle 672, 2026-10-14). Two defects together let a failing test through the
gates and onto develop.

1. **A test asserts over the live dev store.** `tests/commit-boundary-migrates-to-stored-columns.test.ts`,
   the "AC1 — a copy of the dev store, migrated…" case, copies the live `data/crucible.db` and
   compares two answers for every plan's commit boundary:
   - the boundary a raw read of the copy DERIVES today from the events it holds (the pre-migration
     rule, frozen in the test);
   - the boundary the copy holds in its STORED columns after `Store.open` migrates it.

   That comparison proved the v18 → v19 migration once, when the dev store was still at v18. The dev
   store is now at v20, so both copies carry the boundaries stored on the day it migrated. The board
   keeps a fixed number of events (retention). As new runs arrive, the oldest events are pruned and
   today's derivation drifts away from the stored value. Measured: plan 99's `firstRunCommit`
   derives as `6227ca3…` and is stored as `d2b0e82…`.

   The test passed every gate through CR-CRU-185's (2026-10-14, 5813/0), then failed from the next
   day's runs onward, on the feature branch and on develop alike. It fails or passes with the age of
   the data, not with the code, so no gate can hold it. It is the only test that reads the live store;
   the other suites that name `data/crucible.db` say they never open it.
2. **Nothing stops a merge on a red gate.** CR-CRU-186's `pre-merge-gate` reported `ok: false`
   (5868/1) and the CR merged: the failure was reported as pre-existing and the user ruled to merge.
   `git flow feature finish`, `cr-close` and the `cr-merged` milestone all accept a CR whose gate is
   red, without a word.

## Steps

### §S1 — no test asserts over the live store

The live-store case runs only when the copy is at a schema version BEFORE the boundary migration.
When the copy is already past it, the case states that it has nothing to prove and skips, as it
already does when there is no dev store. The synthetic-fixture cases, which build a v18 store and
migrate it, keep proving the migration on every run.

A guard test fails if any test opens or copies the live dev store (`data/crucible.db`), other than
that one case.

### §S2 — a red gate stops the close

`cr-close` reads the CR's most recent `pre-merge-gate` result. When it is not a pass, `cr-close`
refuses, naming the run, its failed count and the failing tests. It closes anyway only with an
explicit `--accept-failing-gate "<reason>"`. The reason is stored on the plan, and the `cr-merged`
milestone and History both show that the CR closed over a red gate and why.

A CR with no recorded `pre-merge-gate` result is refused the same way, with a help entry naming
`pre-merge-gate`.

(How a gate run is tied to its CR — the active verify cycle, or the branch — is settled at gap
analysis.)

## Acceptance criteria

- [ ] **No false failure.** With a dev store at the current schema version, the full bun suite passes
      that file, and the live-store case reports that it skipped and why. The synthetic
      v18-to-current cases pass unchanged.
- [ ] **No other live-store test.** The guard fails on a test that copies or opens
      `data/crucible.db` (proved with a planted fixture), and passes on the current tree.
- [ ] **A red gate refuses the close.** For EACH of the five clients, against a live in-process board,
      `cr-close` on a CR whose last `pre-merge-gate` failed exits non-zero, closes nothing, and names
      the run and its failing count. The same holds for a CR with no gate result.
- [ ] **An accepted failure is recorded.** `cr-close --accept-failing-gate "<reason>"` closes the CR,
      and the plan, the `cr-merged` milestone and History each carry the reason.
- [ ] **A green gate closes as today.** `cr-close` on a CR whose last `pre-merge-gate` passed closes
      exactly as it does now.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/`, `src/` or test comments,
      and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: one cycle for §S1 and one for §S2, RED first, then verify.
