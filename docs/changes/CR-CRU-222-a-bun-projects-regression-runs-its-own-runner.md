# CR-CRU-222 — a bun project's regression runs its own runner

**Status:** COMPLETED — merged 2026-11-13 · filed 2026-10-30 (Model B request, Sandesh 1499; user ruling: its own CR in 0.4.0, at the
end of wave 8); gap analysis ran 2026-11-12 · Pre-review: ran — user rulings at design (9 findings folded)
**Type:** feature
**Points:** 8 (5 at filing; 8 after the pre-review's gate rulings, which reach the shared gate composition)
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

## Design

User rulings 2026-11-12, at the gap analysis (F1–F3) and at the pre-review (F4–F6):

- **F1 — what `regression` runs:** the entry marked `"test": true`, run whole: no file paths and no name
  filter. It is the same script `test` runs, read by the same reader with the same refusals. A project that marks
  no entry runs `bun test`, unchanged.
- **F2 — the gate follows it:** the gate's whole-suite step runs what `regression` runs, and the marked entry is
  exempt from the off-template refusal.
- **F3 — the envelope names the script:** a `regression` run through the marked entry names it in its envelope
  as `script`, as `test`'s does.
- **F4 — only the marked script is covered by the whole-suite run.** On a marked project:
  - the whole-suite run is the marked script, and it is never skipped;
  - the marked entry, when it is itself a declared suite, is recorded as covered by it;
  - every other declared own-stack suite, of any framework, runs as a suite of its own, measuring no coverage.

  Nothing guarantees that a marked script collects the other suites, so the gate never assumes it does; this keeps
  CR-CRU-112's rule that the gate never covers less than it did. An unmarked project's gate is unchanged: `bun
  test` covers every `bun-test` suite.
- **F5 — a marked entry the gate excludes is refused by the gate.** When the marked entry's key names a tier
  the gate excludes fleet-wide (`test:e2e`, pending DN-testing-tiers open question 5), `pre-merge-gate` refuses
  before its tsc step. `regression` still runs it.
- **F6 — coverage flags go only to a `bun-test` entry.**
  - A declared script is handed bun's coverage flags only when its entry is `bun-test` with `junit: flag`, or it
    has no entry.
  - Any other declared script run with `--coverage` measures none and carries one `coverage-not-measured`
    warning: an entry of another framework with `junit: flag`, an `env:<VAR>` entry, or a `stream` entry.
  - This holds on every verb that takes `--coverage`: `regression`, the tier verbs and the gate. `test` takes no
    `--coverage`, and gains none.
  - Without `--coverage`, no coverage is measured or filed on any path.

Existing behaviour this CR keeps, stated so it is not mistaken for a gap:

- **A `stream` entry under `--no-lifecycle` files nothing and answers `ok: false`**, the unfiled cause as its
  `error`, as a stream tier run does today. A stream-marked project's `regression --no-lifecycle` therefore answers
  `ok: false` even when every test passed.
- **A codec the board does not list** (`_target_board_refusal`) is checked when the run opens, after the gate's
  tsc step, as for every declared script today.

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

`pre-merge-gate` reads the marked entry where it reads the old keys, before the tsc step. It refuses with one
`target-refused` envelope under `pre-merge-gate`, running and filing nothing, in each of these cases:

- the marker is refused (§S1's cases);
- the marked entry's own table entry is refused by `_declared_target` (a bad `junit`, both or neither of
  `stream` and `junit`, a `coverage` off a `bun-test` flag entry, a bad `console`);
- the marked entry's key names a tier the gate excludes; the detail names the key, the tier, and that
  `regression` runs it.

On a marked project:

- **Both whole-suite callables** (`whole_suite` and `whole_suite_alone`) run the marked entry, filed under
  `regression` with coverage requested. On an unmarked project they run `bun test`, as today.
- **Every declared own-stack suite** other than the marked entry runs through `run_suite`, as a suite of its own
  with no coverage, whatever its framework. The marked entry, when it is a declared suite, is recorded as covered
  by the whole-suite run.
- **The whole-suite run is never skipped.**
- **The shared gate composition** (`run_gate_suites`, through `gate_regression`) takes the marked script's name
  from the client, and decides "covered" and "skipped" from it as above. When no script is passed it behaves
  exactly as today, so the go client and an unmarked bun project are unchanged.
- **The off-template refusal** no longer names the marked entry. Every other non-`bun-test` entry keyed off
  `test:<tier>`, or keyed `test:<tier>` with no script of that name, is still refused, with the same detail.
- **Coverage:** a whole-suite run through a marked entry that is not `bun-test` with `junit: flag` carries the
  `coverage-not-measured` warning in the gate's envelope. A green gate stays `ok: true`.

`_crucible_axi.py` is pinned by `SHARED_MODULE_LINE_BUDGETS` in the arduino, mvn and rust client tests, and
stays within its 9200-line limit. Its new count is re-pinned once, in the cycle that changes it.

### §S3 — coverage flags go only to a `bun-test` entry

`_bun_run_script_cmd` hands bun's coverage flags only to a declared script whose entry is `bun-test` with
`junit: flag`, or that has no entry. Every other declared script run with `--coverage` carries one
`coverage-not-measured` warning naming the script and its framework. This applies on every verb that takes
`--coverage`.

### §S4 — the shipped declaration schema states it

`clients/crucible-declaration.schema.json` changes in three places:

- the bun `entry.key.gate` descriptor states the exemption: `"marked": "exempt"`, beside `template`, `exempt`
  and `in`;
- the bun `marker` descriptor states what reads it: `"read_by": ["test", "regression", "pre-merge-gate"]`;
- the schema's `version` is one more than at the branch's base, because a reader computing the gate rule from
  the earlier version would refuse the marked entry.

The installer's manifest reads `declaration_schema.version` from the packaged copy (`crucible_axi/manifest.py`),
so it follows with no edit.

### §S5 — docs and comments

- **The CHANGELOG `[Unreleased]`:**
  - the marker bullet ("Only `test` reads the marker; the tier verbs and the gate ignore it") says that `test`,
    `regression` and the gate read it, and the tier verbs ignore it;
  - a `### Changed` bullet says three things: a bun project's `regression` and gate whole-suite step run the
    entry marked `"test": true`; the gate runs every other declared suite on its own; and coverage flags go only
    to a `bun-test` entry;
  - under "Stack declaration changes", the installer bullet ships the new version, and a new bullet beside
    "Version 2 adds the `go` stack" says that this version exempts the marked entry from the bun gate's key rule
    and names its readers.
- **DN-crucible-live-test-progress:** the marker sentence and the `test`-refusal bullet after it name
  `regression` and the gate too.
- **`clients/bun-crucible.py`:** the comment above `TEST_MARKER` and the `_entry_framework` docstring no longer
  say that only `test` reads the marker.

### §S6 — tests that change

These pin the old rule and are rewritten in RED to the new one:

- **`TheTestMarkerChangesNothingInTheGateTest`** (`tests/client/test_the_bun_gate_runs_every_declared_frameworks_suite.py`).
  Its three tests (a marked `vitest` entry gates as the unmarked one; two marked entries do not stop the gate; a
  non-`true` marker does not stop the gate) become AC4 and AC7 cases.
- **`test_the_section_states_schema_version_two`** (`tests/client/test_the_declaration_schema_is_documented.py`)
  and the schema-version assertion in `tests/client/test_the_declaration_schema_states_every_stacks_declaration.py`
  follow the new version. `test_the_go_client_is_documented` keeps reading "Version 2 adds the `go` stack".
- **`test_the_gate_refuses_a_non_bun_test_entry_off_the_test_tier_template`**
  (`tests/client/test_the_clients_agree_with_the_declaration_schema.py`) gains the marked cases.
- **The docstrings** of `tests/client/test_bun_test_runs_the_target_its_table_marks.py` that say only `test`
  reads the marker.

## Acceptance criteria

- [x] **AC1 — a declared runner is run.** On a bun project whose `crucible.targets` marks a script
  `"test": true`, `regression` spawns `bun run <that script>` and never `bun test`. The run is filed under the
  `regression` tier with the entry's framework, and the envelope carries `script: <that script>`.
  - This holds for each record kind: a `junit: flag` entry, a `junit: env:<VAR>` entry, and a `stream` entry.
  - A `stream`-marked `regression --no-lifecycle` files nothing and answers `ok: false`, with the same `error`
    and warnings as the tier verb's `--no-lifecycle` run of that entry, and with `script: <that script>`.
  - On a project that marks no entry, `regression` spawns the same `bun test` argv as before, and its envelope
    carries no `script`.
- [x] **AC2 — coverage stays opt-in, and only `bun-test` takes bun's flags.** `regression` without `--coverage`
  hands no coverage flag to its runner and files no coverage, on an unmarked project and on each kind of marked
  entry.
  - With `--coverage`, a `bun-test` `junit: flag` entry is handed bun's coverage flags.
  - With `--coverage`, each of these is handed none and carries exactly one `coverage-not-measured` warning: a
    `vitest` `junit: flag` entry, an `env:<VAR>` entry and a `stream` entry.
  - The same holds for a tier verb run with `--coverage` on a `vitest` `junit: flag` entry.
- [x] **AC3 — a refused marker refuses `regression`.** For each refused marker (two marked entries; a marker of
  `"true"`, `1` or `false`; a marked script missing from `scripts`; a marked script with an empty body),
  `regression` exits non-zero with one `target-refused` envelope whose detail equals `test`'s for the same
  package, spawns nothing and posts nothing.
- [x] **AC4 — the gate's whole-suite step runs it.** On a marked project, `pre-merge-gate` spawns
  `bun run <marked script>` exactly once as its whole-suite run, and never `bun test`. This holds in each case:
  - no declared suite;
  - declared suites alongside;
  - a marked `vitest` entry keyed `test` with only a `playwright` `test:e2e` declared (the run is not skipped).

  An unmarked project's gate spawns the same argv as before.
- [x] **AC5 — only the marked script is covered.** The gate:
  - on a project that marks `test:unit` (`bun-test`, body `bun test tests/unit`) and declares an unentried
    `test:integration`: runs `test:unit` as the whole-suite run, records `test:unit` as covered by it, and runs
    `test:integration` as its own suite with no coverage;
  - on a project whose marked entry is `vitest` and keyed `test`, and which declares a `vitest` `test:unit` and
    a `playwright` `test:client`: runs the marked script once, and `test:unit` and `test:client` each as its own
    suite;
  - on an unmarked project: records every `bun-test` suite as covered by `bun test`, as before.
- [x] **AC6 — the marked entry is not refused as off-template.** A project whose marked entry is `vitest` and
  keyed `test` (not `test:<tier>`) runs the gate past the off-template refusal. An unmarked `vitest` entry keyed
  `build`, and one keyed `test:e2e` with no such script, are still refused, with the same detail as before.
- [x] **AC7 — the gate refuses before its tsc step.** `pre-merge-gate` exits non-zero with one `target-refused`
  envelope under `pre-merge-gate`, spawning no `tsc` and filing nothing, for each of:
  - each refused marker of AC3;
  - a marked entry whose table entry is refused (`junit: "file"`; both `stream` and `junit`);
  - a marked entry keyed `test:e2e`. Here the detail names `test:e2e`, the `e2e` tier, and that `regression`
    runs it, while `regression` on the same project runs it.
- [x] **AC8 — coverage in the gate.** A gate whose whole-suite run goes through an `env:<VAR>` marked entry,
  and one through a `vitest` `junit: flag` marked entry, each answer `ok: true` when green, with exactly one
  `coverage-not-measured` warning and no coverage flag spawned.
- [x] **AC9 — the schema states it.** The shipped schema's `version` is one more than at the branch's base. Its
  bun `entry.key.gate` carries `"marked": "exempt"`, and its bun `marker` carries
  `"read_by": ["test", "regression", "pre-merge-gate"]`.
  - The client's off-template rule agrees with the schema for every framework, marked and unmarked, as the
    clients-agree test reads it.
  - The installed manifest's `declaration_schema.version` equals the shipped schema's.
- [x] **AC10 — docs and hygiene.** The texts of §S1 (help) and §S5 are present. None of these still says that
  only `test` reads the marker: the CHANGELOG `[Unreleased]`, DN-crucible-live-test-progress,
  `clients/bun-crucible.py`, or the tests of §S6. `docs/changes/` is historical and out of scope. The code and
  tests add no CR id literal.

## Non-goals

- `test` and the tier verbs, beyond §S3's coverage flags.
- Every declared `test:<tier>` run as `regression`, and a `test:regression` script as `regression`'s declaration
  (both declined at the gap analysis).
- Running gate-excluded tiers in the gate (DN-testing-tiers open question 5 stays open).
- Model B's hook wording (CR-MDB-066), reworded on their side once this lands.
