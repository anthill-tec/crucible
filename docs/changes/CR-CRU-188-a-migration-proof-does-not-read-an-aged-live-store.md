# CR-CRU-188 — a gate measures the code, a red gate stops the merge, and the clients are lint-clean

**Type** fix (patch CR) · **Points** 13 (re-scored at gap analysis, 2026-10-14; filed at 2) · **Wave** 8 (0.4.0) ·
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
   red, without a word. Nor is a gate run tied to its CR: every run warns `no-cycle — … supply
   --cycle <id> now (nothing backfills a stored run's cycle)` when its agent is unbound and no
   `--cycle` is given, and the orchestrator's summary-only reading of the output dropped that
   warning on every gate of 2026-10-13/14. All of them are stored with no cycle and no branch.
3. **The clients carry blocking static-analysis findings that no gate checks.** pi-lens flags them on
   every edit to these files; they predate this CR's wave and were waved through as "not ours".
   Measured 2026-10-14 (`lens_diagnostics`, session, full):

   | File | Blocking | Kinds |
   |---|---|---|
   | `clients/_crucible_axi.py` | 15 | Pyright: a possibly-`None` value used as a path (L771), as a slice bound (L4455, L4462, L4463), as a dict key (L5998) and in arithmetic (L6332, L6333); a field name outside its `Literal` set (L2811). ast-grep: an unguarded throwing call (L302, L324, L686) |
   | `clients/arduino-crucible.py` | 7 | ast-grep: an unguarded throwing call (L108, L366, L568, L572, L591, L600, L601) |
   | `clients/mvn-crucible.py` | 6 | ast-grep: an unguarded throwing call (L137, L171, L611, L613, L649, L757) |
   | `clients/python-crucible.py` | 6 | ast-grep: an unguarded throwing call (L126, L486, L580, L722, L775, L906) |
   | `clients/rust-crucible.py` | 6 | ast-grep: an unguarded throwing call (L154, L535, L837, L858, L862, L873) |
   | `clients/bun-crucible.py` | 4 | ast-grep: an unguarded throwing call (L145, L880, L1188, L1336) |
   | `clients/toon.py` | 4 | Pyright: a possibly-`None` match or value used (L552, L1109, L1177, L1216) |
   | `tests/client/test_crucible_axi_shared.py` | 1 | Pyright: a possibly-`None` callable called (L1261) |
   | `tests/client/test_cr054_http_core_lift.py` | 2 | Pyright: a `dict` passed as `HTTPError` headers (L186); a zero-argument `read` assigned (L187) |

   Warnings also stand: unguarded `int()`/`float()` parses in `_crucible_axi.py` (L3248, L4683,
   L4692), `arduino-crucible.py` (L369–L375) and `rust-crucible.py` (L480, L538–L544, L662, L663,
   L694, L750, L835).

## Steps

### §S1 — no test asserts over the live store

The live-store case runs only when the copy is at a schema version BEFORE the boundary migration.
When the copy is already past it, the case states that it has nothing to prove and skips, as it
already does when there is no dev store. The synthetic-fixture cases, which build a v18 store and
migrate it, keep proving the migration on every run.

A guard test fails if any test opens or copies the live dev store (`data/crucible.db`), other than
that one case.

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

### §S3 — the clients are clean under pi-lens

Every blocking finding in the table, and every warning named with it, is resolved one of two ways:
- **fixed:** the possibly-`None` value is checked or narrowed; the unguarded parse or call handles its
  failure the way its verb already reports failures (an envelope, never a traceback);
- **kept on purpose:** where the call is meant to raise (a missing file the verb must refuse on, say),
  it is marked in place with the reason, in the suppression form pi-lens honours.

No behaviour a test pins changes.

## Acceptance criteria

- [ ] **No false failure.** With a dev store at the current schema version, the full bun suite passes
      that file, and the live-store case reports that it skipped and why. The synthetic
      v18-to-current cases pass unchanged.
- [ ] **No other live-store test.** The guard fails on a test that copies or opens
      `data/crucible.db` (proved with a planted fixture), and passes on the current tree.
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
- [ ] **Lint-clean.** A pi-lens sweep (`lens_diagnostics`, session, full) over `clients/` and the two
      named test files reports zero blocking findings, and none of the warnings named in the table.
      Each suppression carries its reason. Both full suites pass.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/`, `src/` or test comments,
      and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: one cycle for §S1, two for §S2 (run attribution; the gate milestone and the
close) and one for §S3, RED first (for §S3, the sweep's findings
are the failing check, and a test pins each fixed behaviour), then verify.
