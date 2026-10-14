# CR-CRU-188 — a gate measures the code, and a red gate stops the merge

**Type** fix (patch CR) · **Points** 13 (re-scored 2026-10-14 at RED of its first cycle: the lint-clean section moved to CR-CRU-191) · **Wave** 8 (0.4.0) ·
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
   the data, not with the code, so no gate can hold it.

   It is not alone. Eight more test files copy the live store (`copyFileSync`, or `sqlite3 .backup`)
   and assert over the copy, each skipping when no dev store exists: `store-migration`,
   `run-lifecycle`, `milestone-dates-migration`, `milestone-type-is-definable`,
   `release-unification-migration`, `plan-reads-answer-byte-identically-dev-store-copy`,
   `release-live-total-matches-dev-store-queue` and `commit-boundary-derivation`. They pass today, but
   each makes the gate's verdict depend on whatever the dev store holds, and none of them runs in CI,
   where there is no dev store.
2. **Nothing stops a merge on a red gate.** CR-CRU-186's `pre-merge-gate` reported `ok: false`
   (5868/1) and the CR merged: the failure was reported as pre-existing and the user ruled to merge.
   `git flow feature finish`, `cr-close` and the `cr-merged` milestone all accept a CR whose gate is
   red, without a word. Nor is a gate run tied to its CR: every run warns `no-cycle — … supply
   --cycle <id> now (nothing backfills a stored run's cycle)` when its agent is unbound and no
   `--cycle` is given, and the orchestrator's summary-only reading of the output dropped that
   warning on every gate of 2026-10-13/14. All of them are stored with no cycle and no branch.
## Steps

### §S1 — no gate test reads live data

The gate measures the code only (user ruling, 2026-10-14). Every test case that copies or reads the
live dev store, in the nine files named above, is replaced by a case over a fixture the test builds
itself (through the ordinary `Store` door, downgraded where a migration is under test, as the
synthetic migration cases already do), or dropped where a fixture case already proves the same
claim. A dropped case is named, with the fixture case that covers it, in the commit message.

A guard test fails if any test copies, backs up or opens `data/crucible.db`. It allows none.

### §S2 — a run belongs to a cycle, and a red gate stops the close

**An unattributed run is refused while a cycle is active.** When the project has an active cycle,
every client's run verbs (`test`, `regression`, `pre-merge-gate` and the stack's other run verbs)
refuse a run that would carry no cycle: the agent is bound to no cycle, and neither `--cycle` nor
`--release` is given. The refusal exits non-zero before the runner starts, and its help names the
active cycle (`--cycle <id>`). With no active cycle, today's `no-cycle` warning stands: a run
between CRs (a baseline, say) is project-scoped on purpose.

**A red gate stops the close.** `cr-close` reads the CR's most recent `pre-merge-gate` result. When it is not a pass, `cr-close`
refuses, naming the run, its failed count and the failing tests. It closes anyway only with an
explicit `--accept-failing-gate "<reason>"`. The reason is stored on the plan, and the `cr-merged`
milestone and History both show that the CR closed over a red gate and why.

A CR with no recorded `pre-merge-gate` result is refused the same way, with a help entry naming
`pre-merge-gate`.

Each `pre-merge-gate` ends by posting one milestone of a new type, `pre-merge-gate`, under its
cycle (user ruling, 2026-10-14): the CR, the outcome (pass or fail), the passed and failed counts,
the failing tests and the head commit. It posts it on a failing gate too. `cr-close` reads the CR's
most recent `pre-merge-gate` milestone.

## Acceptance criteria

- [ ] **No gate test reads live data.** None of the nine files copies, backs up or opens
      `data/crucible.db`; each claim they proved over the live store is proved over a fixture, or
      named as already covered. The full bun suite passes, and gives the same result with the dev
      store moved aside.
- [ ] **The guard allows none.** The guard fails on a planted test that copies, backs up or opens
      `data/crucible.db` (each of the three forms), and passes on the tree after the change.
- [ ] **An unattributed run is refused.** For EACH of the five clients, with an active cycle on a
      live in-process board, `test` and `pre-merge-gate` run by an unbound agent with no `--cycle`
      exit non-zero before the runner starts, naming the active cycle id in `help[]`. With
      `--cycle <id>`, the run proceeds and is stored under that cycle. With no active cycle, the run
      proceeds and warns `no-cycle` as today. A `--release` run is never refused.
- [ ] **The gate records its outcome.** For EACH of the five clients, a passing and a failing
      `pre-merge-gate --cycle <id>` each post exactly one `pre-merge-gate` milestone under that
      cycle, carrying the CR, the outcome, the counts, the failing tests (on a failure) and the head
      commit.
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

On a feature branch: one cycle for §S1 and two for §S2 (run attribution; the gate milestone and the
close), RED first, then verify.
