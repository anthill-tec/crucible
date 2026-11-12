# CR-CRU-222 — a bun project's regression runs its own runner

**Status:** PENDING — filed 2026-10-30 (Model B request, Sandesh 1499; user ruling: its own CR in 0.4.0, at the
end of wave 8); gap analysis ran 2026-11-12 · Pre-review: pending — user rulings at design
**Type:** feature
**Points:** 5
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-226
**Labels:** clients, bun, gate
**Design reference:** CR-CRU-226 (the `crucible.targets` table and its `"test": true` marker); CR-CRU-112 (the
gate covers every declared suite); CR-CRU-212 (`regression --coverage` is opt-in)

## Problem

Raised by Model B (2026-10-30), from a Bun workspace whose suites run Vitest on the Bun runtime. The bun
client's `regression` verb always builds `bun test` (`cmd_regression` with no `script`), so on such a project it
runs the wrong runner, or nothing.

What already holds:

- `test` runs the `crucible.targets` entry marked `"test": true`, and `bun test` only when no entry is marked.
- The tier verbs run the declared `test:<tier>` scripts.
- `pre-merge-gate` runs every declared suite (CR-CRU-112).

Only `regression` has no declared form, and neither has the gate's whole-suite step, which runs `regression`'s
body. Worse, the gate refuses outright a project whose marked entry is not `bun-test` and whose key is not a
`test:<tier>` script (the off-template refusal), so such a project cannot run the gate at all.

Model B's bun hook (CR-MDB-066) blocks direct Vitest runs in bun projects and says that `test` and `regression`
run `bun test`. Model B rewords that line once this CR lands.

## Design (user rulings 2026-11-12, at the gap analysis)

- **F1 — what `regression` runs:** the entry marked `"test": true`, run whole: no file paths and no name
  filter. It is the same script `test` runs, read by the same reader with the same refusals. A project that marks
  no entry runs `bun test`, unchanged.
- **F2 — the gate follows it:** the gate's whole-suite step runs what `regression` runs.
  - That step's framework is the marked entry's framework. So a declared suite of that framework is covered by the
    whole-suite run, the way a `bun-test` suite is covered by `bun test` today. A suite of any other framework
    still runs as a suite of its own.
  - The marked entry is exempt from the off-template refusal.
- **F3 — the envelope names the script:** a `regression` run through the marked entry names it in its envelope
  as `script`, as `test`'s does.
- **Coverage (mechanical, no new design):** a declared script already takes `--coverage` through its entry.
  - A `bun-test` entry with `junit: flag` is handed bun's coverage flags.
  - An `env:<VAR>` or `stream` entry measures none and carries one `coverage-not-measured` warning.
  - Without `--coverage`, no coverage is measured or filed on any path.

## Steps

### §S1 — `regression` reads the marker

The `regression` verb reads the marked entry before anything is posted, after the old-key refusal.

- **An entry is marked:** `regression` runs it, under the `regression` verb and tier. The run takes no
  passthrough and no name, and its envelope carries `script: <name>`.
- **The marker is refused:** two marked entries, a marker other than `true`, or a marked script that is missing
  or has an empty body. `regression` exits with the same `target-refused` envelope `test` gives, naming the same
  detail, and nothing is run or posted.
- **No entry is marked:** `regression` runs `bun test`, unchanged: the same argv and the same envelope, with no
  `script` field.
- **Help:** the verb's help says it runs the entry marked `"test": true` when one is marked, else the full-suite
  `bun test`, and that `--coverage` adds coverage.

### §S2 — the gate's whole-suite step follows

`pre-merge-gate` reads the marked entry where it reads the old keys, before the tsc step. A refused marker refuses
the gate with the same `target-refused` envelope under `pre-merge-gate`, and nothing is run or filed.

- **The two whole-suite callables** (`whole_suite` and `whole_suite_alone`) each run the marked entry when one is
  marked, and `bun test` otherwise. Each run is filed under `regression` with coverage requested, as today.
- **The whole-suite framework** handed to the gate composition is the marked entry's `framework` when one is
  marked, and `bun-test` otherwise. So:
  - a declared own-stack suite of that framework is recorded as covered by the whole-suite run and is not run
    again;
  - a declared own-stack suite of another framework runs as a suite of its own, measuring no coverage;
  - the whole-suite run is skipped only when every declared own-stack suite is of another framework than the
    whole-suite run's.
- **The off-template refusal** no longer names the marked entry. Every other non-`bun-test` entry keyed off
  `test:<tier>`, or keyed `test:<tier>` with no script of that name, is still refused.
- **Coverage:** a whole-suite run through an `env:<VAR>` or `stream` entry carries the `coverage-not-measured`
  warning in the gate's envelope. A green gate stays `ok: true`.

### §S3 — the shipped declaration schema states the exemption

`clients/crucible-declaration.schema.json` states the exemption in the bun `entry.key.gate` descriptor:
`"marked": "exempt"`, beside `template`, `exempt` and `in`. The bun `marker` descriptor states what reads it:
`"read_by": ["test", "regression", "pre-merge-gate"]`.

The schema's `version` becomes `3`, because a reader computing the gate rule from version 2 would refuse the
marked entry. The installer's manifest reads `declaration_schema.version` from the packaged copy, so it follows with
no edit; the test that pins the version, and the docs that state it, move to 3.

### §S4 — docs

- **The CHANGELOG `[Unreleased]`:**
  - the marker bullet ("Only `test` reads the marker; the tier verbs and the gate ignore it") says that `test`,
    `regression` and the gate's whole-suite step read it, and the tier verbs ignore it;
  - a `### Changed` bullet says that a bun project's `regression` and gate whole-suite step run the entry marked
    `"test": true`;
  - under "Stack declaration changes", the installer bullet ships version 3, and a bullet beside "Version 2 adds
    the `go` stack" says that version 3 exempts the marked entry from the bun gate's key rule and names its
    readers.
- **DN-crucible-live-test-progress:** the sentence that states the marker's readers is updated the same way.

## Acceptance criteria

- [ ] **AC1 — a declared runner is run.** On a bun project whose `crucible.targets` marks a script
  `"test": true`, `regression` spawns `bun run <that script>` and never `bun test`. The run is filed under the
  `regression` tier with the entry's framework, and the envelope carries `script: <that script>`.
  - This holds for each record kind: a `junit: flag` entry, a `junit: env:<VAR>` entry, and a `stream` entry.
  - On a project that marks no entry, `regression` spawns the same `bun test` argv as before, and its envelope
    carries no `script`.
- [ ] **AC2 — coverage stays opt-in.** `regression` without `--coverage` hands no coverage flag to its runner and
  files no coverage, on an unmarked project and on each kind of marked entry.
  - With `--coverage`, a `bun-test` `junit: flag` entry is handed bun's coverage flags.
  - With `--coverage`, an `env:<VAR>` entry and a `stream` entry each carry exactly one `coverage-not-measured`
    warning.
- [ ] **AC3 — a refused marker refuses `regression`.** For each refused marker (two marked entries; a marker of
  `"true"`, `1` or `false`; a marked script missing from `scripts`; a marked script with an empty body),
  `regression` exits non-zero with one `target-refused` envelope whose detail equals `test`'s for the same
  package, spawns nothing and posts nothing.
- [ ] **AC4 — the gate's whole-suite step runs it.** On a marked project, `pre-merge-gate` spawns
  `bun run <marked script>` as its whole-suite run. This holds in both whole-suite paths: no declared suite,
  and declared suites alongside. It never spawns `bun test`. An unmarked project's gate spawns the same argv as
  before.
- [ ] **AC5 — the whole-suite framework is the marked entry's.** On a project whose marked entry is `vitest` and
  which declares a `vitest` `test:unit` and a `playwright` `test:e2e`, the gate:
  - runs the marked script once;
  - records `test:unit` as covered by the whole-suite run, without running it again;
  - runs `test:e2e` as its own suite.

  On a project whose marked entry is `bun-test`, a declared `vitest` suite still runs as its own suite.
- [ ] **AC6 — the marked entry is not refused as off-template.** A project whose marked entry is `vitest` and
  keyed `test` (not `test:<tier>`) runs the gate past the off-template refusal. An unmarked `vitest` entry keyed
  `build`, and one keyed `test:e2e` with no such script, are still refused, with the same detail as before.
- [ ] **AC7 — the gate refuses a refused marker first.** For each refused marker of AC3, `pre-merge-gate`
  exits non-zero with one `target-refused` envelope under `pre-merge-gate`, before the tsc step: no `tsc` is
  spawned and nothing is filed.
- [ ] **AC8 — coverage in the gate.** A gate whose whole-suite run goes through an `env:<VAR>` marked entry and
  is green answers `ok: true`, with exactly one `coverage-not-measured` warning.
- [ ] **AC9 — the schema states it.** The shipped schema is version 3. Its bun `entry.key.gate` carries
  `"marked": "exempt"`, and its bun `marker` carries `"read_by": ["test", "regression", "pre-merge-gate"]`. The
  client's off-template rule agrees with the schema for every framework, marked and unmarked, as the
  clients-agree test reads it. The installed manifest's `declaration_schema.version` is 3, and no doc states the
  shipped schema as version 2.
- [ ] **AC10 — docs and hygiene.** The `regression` help, the CHANGELOG bullets and the DN sentence of §S1 and
  §S4 are present, and no text still says that only `test` reads the marker. Code and tests add no CR id literal.

## Non-goals

- `test` and the tier verbs, which already run the declared scripts.
- Every declared `test:<tier>` run as `regression` (F1 option C), and a `test:regression` script as
  `regression`'s declaration (F1 option B).
- Model B's hook wording (CR-MDB-066), reworded on their side once this lands.
