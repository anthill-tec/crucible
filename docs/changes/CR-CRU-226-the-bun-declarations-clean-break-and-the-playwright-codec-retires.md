# CR-CRU-226 — the bun declaration's clean break, and the gate runs every declared framework

**Type** feature · **Points** 13 (re-scored after its pre-review, user ruling 2026-11-04) ·
**Wave** 8 (0.4.0) · **Depends on** CR-CRU-225, CR-CRU-228 · **Status** PENDING · Pre-review: ran — 8 points; its gap
analysis needed user rulings
- **Filed 2026-10-31.** Split from CR-CRU-201 at its gap analysis. User ruling: three dog-food-safe units —
  CR-CRU-201, CR-CRU-225, then this CR.
- **Split at its gap analysis (user ruling 2026-11-04).** With the rulings below it measured about 19 points. This CR
  keeps the client's half; the playwright codec's retirement, the stored runs' migration and the `junit` readings keyed
  by framework move to CR-CRU-229.
- **CR-CRU-222 keeps its question** (user ruling 2026-11-04): this CR changes only how `test` reaches a declared runner;
  what a bun project's `regression` runs stays CR-CRU-222's.
- **Pre-review ran 2026-11-04** (`CR-CRU-226-SPEC-REVIEW`, FINDINGS(9)); its findings are folded in below, and the
  design choices they opened were ruled by the user the same day.

## Problem

Once a script declares its record in `crucible.targets` (CR-CRU-225), three older keys say the same things in other words:
- `crucible.reportPath`, which `junit` replaces;
- `crucible.rawReport`, whose only use, Playwright's step-keeping JSON, the stream replaces (CR-CRU-228);
- `crucible.testScript`, which names the script `test` runs (CR-CRU-194).

And `pre-merge-gate` reports every declared bun target as covered by its own `bun test` run, so a table target whose
framework is not `bun-test` (Vitest) is reported covered without running (CR-CRU-225's VERIFY finding 5). The gate
cannot run such a target today: the shared composition (`gate_regression`, the one all five clients' gates run) either
covers an own-stack suite by the whole-suite run or dispatches it to a SIBLING client, and `sibling_client_argv` has no
builder for the bun client itself, so the target would be reported undispatchable.

## Design (user rulings 2026-10-20, 2026-10-31, 2026-11-01 and 2026-11-04; `DN-crucible-live-test-progress.md`)

### The clean break

- A `package.json` declaring `crucible.reportPath`, `crucible.rawReport` or `crucible.testScript` is refused, before
  anything is posted, with a message naming the key and `crucible.targets`, as `--phase` was when it became `--role`.
  It is refused by `test`, `regression`, every tier verb and `pre-merge-gate`; the gate refuses it before its tsc step,
  which already files a result.
- The readers of the old keys go, and so do the paths only they reach: `_report_path_variable`'s declaration lookup,
  `_declared_report_mechanism`, `RAW_REPORT_KEY` / `_declared_raw_report` and `cmd_regression`'s raw-report branch,
  `_TEST_SCRIPT_DECLARATION` / `_declared_test_script` / `_emit_test_script_refused`, and `_declared_target`'s check for
  a script declared both in the table and in an older key. The tests of those paths follow them (among them
  `test_bun_declared_test_script_name_filter_raw_report_and_narration.py`). `STREAM_KEPT_REPORTS` stays for CR-CRU-229.

### `test`'s script is a table field (user ruling 2026-11-04)

- A `crucible.targets` entry marks itself as the script `test` runs. The field is `"test": true` (user ruling 2026-11-04).
- `test` reads the markers across the table and validates only the marked entry. It refuses, naming
  `crucible.targets` and the entry:
  - two marked entries (naming both);
  - a marker that is not `true` (`false` is refused too: an unmarked entry omits the field);
  - a marked entry whose script is not in `scripts`, or whose body is empty (the two refusals `testScript` had).
- Only `test` reads the marker; the tier verbs and the gate ignore it.
- `test` runs the marked script with the files and the name filter as its passthrough, as `testScript` did, and the run
  carries the entry's framework. The filter flag follows the entry's framework (user ruling 2026-11-04) (`-t` for `bun-test` and
  `vitest`, `--grep` for `playwright` and `playwright-bdd`). `test` with no files runs the whole script under the verb
  `test`, with no tier, as `testScript` did. A marked stream entry streams, as it does today.
- With no entry marked, `test` runs `bun test`, unchanged.

### The gate runs every declared framework (user ruling 2026-11-04)

- **Which suites carry a framework.** The gate joins each enumerated `test:` script with its
  `crucible.targets` entry, and each declared suite carries its framework (`bun-test` when it has no entry). A
  non-`bun-test` table entry whose key is not a `test:` script is refused by the gate, naming it, since the gate could
  not otherwise see it.
- **Where it is built** (user ruling 2026-11-04). The shared `GateSuite` gains a `framework` field and `gate_regression` a fourth rule:
  an own-stack suite whose framework is not the stack's whole-suite framework runs IN PROCESS through the surface's own
  run (`cmd_regression(script=<target>)`, captured as the whole-suite run is), never dispatched. Other stacks leave
  the field unset, so their gates are unchanged. The suite's run is filed under the tier its name names, else
  `regression`; its row carries its own counts and outcome and `client` naming this client, and its counts are added to
  the gate's totals.
- **When the whole-suite run runs** (user ruling 2026-11-04). The whole-suite `bun test` runs unless every own-stack declared suite is
  non-`bun-test`, in which case it is skipped and the envelope says so; a project whose `*.test.ts` files are collected
  by both runners is the project's to separate.
- **Scoping (`--suites`).** Naming a non-`bun-test` target runs only that target; naming a `bun-test` target runs the
  whole suite and records the `bun-test` targets it covered.
- **Coverage** (user ruling 2026-11-04). The gate requests no coverage for a non-`bun-test` suite, and reports no
  `coverage_not_measured` warning for it; the gate's coverage covers the `bun-test` code, as before.
- The `e2e` tier stays excluded fleet-wide (`GATE_UNCOVERED_TIERS`), whatever its framework.

### Dog-food and the record

- This repo's `package.json` already declares only `crucible.targets` (CR-CRU-228). The Vitest fixture
  (`tests/fixtures/vitest-project`, which declares `testScript` and `reportPath` today) moves to the table in the same
  commit as the break.
- The DN's §Declaration and §Where it lands, and PRD §4.4, record the break, the `test` marker, the gate rule and the
  split with CR-CRU-229.
- Model B's surfaces that name the refused keys (the bun hook `block-direct-bun-test`, and the bun agent templates)
  are reworded by Model B; this CR sends the CReq.

## Steps

- **§S1 — the break.** The refusal on every reading verb, ahead of the gate's tsc step; the old readers, the raw-report
  branch and their tests removed; the Vitest fixture moved to the table in the same commit.
- **§S2 — the `test` marker.** The marker's reading and refusals, the framework's filter flag, the no-files case.
- **§S3 — the gate.** `GateSuite.framework`, the in-process rule in `gate_regression`, the whole-suite skip, scoping,
  coverage, the totals.
- **§S4 — the record.** The DN, PRD §4.4, and the CReq to Model B.

## Acceptance criteria

- [ ] **AC1 — the clean break.** A `package.json` declaring any of `crucible.reportPath`, `crucible.rawReport` or
      `crucible.testScript`, with or without `crucible.targets`, is refused by `test`, `regression`, every tier verb and
      `pre-merge-gate` before anything is posted (for the gate, before its tsc step). The refusal names the key and
      `crucible.targets`, exits non-zero and files nothing. No reader of the old keys remains in the client.
- [ ] **AC2 — `test` runs the marked entry.** On a project whose table marks one entry for `test`, `test <files>` and
      `test --name <n>` run that script with the files and the framework's filter flag as passthrough, and the run
      carries the entry's framework; `test` with no files runs the whole script. Two marked entries, a marker that is not
      `true`, and a marked script that is missing or empty are each refused before anything is posted. A tier verb on a
      marked entry runs as it does unmarked. No marked entry: `bun test`, unchanged.
- [ ] **AC3 — the gate runs a non-`bun-test` target.** On a fixture declaring a `bun-test` target and a Vitest target,
      `pre-merge-gate` runs the Vitest target as its own suite, its row carrying its own counts and outcome, and its
      counts in the totals. A passing Vitest suite leaves the gate ok; a failing one makes it not ok. The `bun-test`
      target's row is still `coveredBy` the whole-suite run. On a project whose own-stack targets are all
      non-`bun-test`, the whole-suite run is skipped and the envelope says so.
- [ ] **AC4 — scoping and coverage.** `--suites <vitest target>` runs only that target; `--suites <bun-test target>`
      runs the whole suite and no Vitest suite. The Vitest suite's run measures no coverage and adds no warning.
- [ ] **AC5 — other stacks unchanged.** A python, maven, rust and arduino gate's `suites[]` rows are as before.
- [ ] **AC6 — dog-food.** No commit of the CR leaves an old key in this repo or its fixtures, and this repo's own
      runs file at every commit.

## Non-goals

- **The table and the reporters** (CR-CRU-225, CR-CRU-228).
- **bun's console live view** (CR-CRU-201).
- **The playwright codec, its JSON report (`STREAM_KEPT_REPORTS`), the stored runs' migration and the `junit` readings
  keyed by framework** (CR-CRU-229).
- **What `regression` runs** (CR-CRU-222).
- **Model B's hook and template wording**, reworded on their side from this CR's CReq.
