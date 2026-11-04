# CR-CRU-226 — the bun declaration's clean break, and the gate runs every declared framework

**Type** feature · **Points** 8 (re-scored at its gap analysis, 2026-11-04) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-225, CR-CRU-228 · **Status** PENDING · Pre-review: due — 8 points; its gap analysis needed user rulings
- **Filed 2026-10-31.** Split from CR-CRU-201 at its gap analysis. User ruling: three dog-food-safe units —
  CR-CRU-201, CR-CRU-225, then this CR.
- **Split at its gap analysis (user ruling 2026-11-04).** With the rulings below it measured about 19 points. This CR
  keeps the client's half; the playwright codec's retirement, the stored runs' migration and the `junit` readings keyed
  by framework move to CR-CRU-229.
- **CR-CRU-222 keeps its question** (user ruling 2026-11-04): this CR changes only how `test` reaches a declared runner;
  what a bun project's `regression` runs stays CR-CRU-222's.

## Problem

Once a script declares its record in `crucible.targets` (CR-CRU-225), three older keys say the same things in other words:
- `crucible.reportPath`, which `junit` replaces;
- `crucible.rawReport`, whose only use, Playwright's step-keeping JSON, the stream replaces (CR-CRU-228);
- `crucible.testScript`, which names the script `test` runs (CR-CRU-194).

And `pre-merge-gate` reports every declared bun target as covered by its own `bun test` run, so a table target whose
framework is not `bun-test` (Vitest) is reported covered without running (CR-CRU-225's VERIFY finding 5).

## Design (user rulings 2026-10-20, 2026-10-31, 2026-11-01 and 2026-11-04; `DN-crucible-live-test-progress.md`)

- **The clean break.** A `package.json` declaring `crucible.reportPath`, `crucible.rawReport` or `crucible.testScript`
  is refused by every verb that reads the declaration, before anything is posted, with a message naming the key and
  `crucible.targets`, as `--phase` was when it became `--role`. The check that refuses a script declared both in the
  table and in an older key goes with them.
- **`test`'s script is a table field** (user ruling 2026-11-04). A `crucible.targets` entry marks itself as the script
  `test` runs. PROPOSED: the field is `"test": true`; at most one entry carries it, and a second is refused naming both.
  `test` runs that script with the files and the name filter as its passthrough, as `testScript` did. PROPOSED: the
  filter flag follows the entry's framework (`-t` for `bun-test` and `vitest`, `--grep` for `playwright` and
  `playwright-bdd`). With no entry marked, `test` runs `bun test`, unchanged.
- **Migration.** This repo's `package.json` and the Vitest fixture (`tests/fixtures/vitest-project`, which declares
  `testScript` and `reportPath` today) move to the table in the same unit as the break: this repo dog-foods its own
  client.
- **The gate runs every declared framework** (user ruling 2026-11-04). A declared own-stack target whose framework is
  `bun-test` (or with no entry) stays covered by the whole-suite `bun test` run, unchanged. A declared target whose
  framework is anything else runs as its own suite, through its own script, and its `suites[]` row carries its own
  counts and outcome, never `coveredBy`. The `e2e` tier stays excluded fleet-wide (`GATE_UNCOVERED_TIERS`).

## Steps

Written after the pre-review.

## Acceptance criteria

- [ ] **AC1 — the clean break.** A `package.json` declaring any of `crucible.reportPath`, `crucible.rawReport` or
      `crucible.testScript` is refused by `test`, `regression`, every tier verb and `pre-merge-gate` before anything is
      posted. The refusal names the key and `crucible.targets`, exits non-zero and files nothing.
- [ ] **AC2 — `test` runs the marked entry.** On a project whose table marks one entry for `test`, `test <files>` and
      `test --name <n>` run that script with the files and the framework's filter flag as passthrough, and the run
      carries the entry's framework. Two marked entries are refused, naming both. No marked entry: `bun test`, unchanged.
- [ ] **AC3 — the gate runs a non-`bun-test` target.** On a project declaring a Vitest target, `pre-merge-gate` runs it
      as its own suite and its row carries its own counts; a failing Vitest test makes the gate not ok. A `bun-test`
      target's row is still `coveredBy` the whole-suite run.
- [ ] **AC4 — dog-food.** This repo's own runs file through the table at every commit of the CR, and the Vitest fixture
      declares only `crucible.targets`.

## Non-goals

- **The table and the reporters** (CR-CRU-225, CR-CRU-228).
- **bun's console live view** (CR-CRU-201).
- **The playwright codec, its JSON report, the stored runs' migration and the `junit` readings keyed by framework**
  (CR-CRU-229).
- **What `regression` runs** (CR-CRU-222).
