# CR-CRU-243 — the fleet installs, declares and counts the eda client

**Status:** PENDING · Pre-review: due — 8 points, user rulings, another project's surface
**Type:** feature
**Priority:** high. Model B's writer reads the schema at run time.
**Depends on:** CR-CRU-242
**Labels:** installer, schema, census, docs
**Phase:** design
**Design reference:** CR-CRU-238 (the declaration schema and its writer rule); CR-CRU-195 §S5–§S6 (how a stack joins the fleet); `docs/research/DN-testing-tiers-in-crucible-projects.md`

## Context

`clients/eda-crucible.py` (CR-CRU-242) runs and files an EDA project's pytest tiers. It is not installed yet,
the declaration schema does not name it, and the fleet's closed lists do not count it.

- **Model B's scaffold writes a project's declaration** from `crucible-declaration.schema.json`, and its
  agents read the tier mapping from the docs.
- **The other `[targets]` readers must skip eda's entries.** Rust, arduino and maven share the flat
  `[targets.<key>]` namespace.

## Scope

- **The schema describes what the client accepts, and nothing more.** In particular it carries no
  Model-B-only `tools` list.
- **The L0–L3 mapping is documentation:**
  - L0 → `check`;
  - L1 → `unit`;
  - L1b → `module`;
  - L2 → `integration`;
  - L3 → `e2e`, which is excluded from the gate fleet-wide;
  - `bdd` is unused.
- **The schema change is versioned.** It bumps `version` by one from its value at merge, and the
  CHANGELOG lists it under "Stack declaration changes".

### §S1 — the installer and the manifest

- `install.FLEET_FILES` gains `eda-crucible.py`, so `crucible-axi install` lays it down beside the
  other clients.
- `manifest.CLIENT_STACKS` gains `eda`, so `crucible-clients.json` names
  `clients.eda: <clients>/eda-crucible.py`.

### §S2 — the schema names eda

`clients/crucible-declaration.schema.json` gains:

- **`stacks.eda`** with:
  - `location {file: crucible.toml, table: "targets.<key>"}`;
  - an entry whose `key` is `{form: "tier[/label]", description: "the tier, optionally followed by / and
    a label; the tier is one of unit, module, integration, e2e, bdd"}`;
  - `open: true` and `other_stacks: "skipped"`;
  - `fields`:
    - `framework` `{values: ["eda-pytest"], required: true}`;
    - `paths` `{description: "pytest paths or path::node ids relative to the project dir", required:
      true}`;
  - the shape rules: targets not a table → undeclared; entry not a table → refused; file does not parse
    → refused;
  - a `stack_table` `eda` with `python` `{values: {path: {holds: "an executable interpreter"}}, default:
    null, required: false, overridden_by: "--python"}`.
- **`reserved_frameworks.eda`** = `["eda-pytest"]`.
- **`version`** + 1.

### §S3 — every `[targets]` reader skips eda

`eda-pytest` joins the other-stack skip set of each client that reads `[targets]`:

- arduino's `_OTHER_STACKS_FRAMEWORKS`;
- maven's skip set;
- rust's skip set.

The agreement test (`tests/client/test_the_clients_agree_with_the_declaration_schema.py`, with
`declaration_schema_harness.py`) drives two directions:

- eda's declaration check, with entries generated from the schema;
- the skip of a complete valid eda entry, in each of rust, arduino and maven.

### §S4 — the [6] census

Every closed list that names all six current clients names eda too, and every count pin tied to those
lists moves by one. The lists are:

- **Installer and manifest:**
  - `CLIENT_STACKS`, `FLEET_FILES`;
  - `manifest_contract.py` `EXPECTED_MANIFEST_KEYS`;
  - `test_crucible_axi_install.py` `EXPECTED_CLIENT_STACKS`;
  - `test_cr090_fleet_stage.py`: `EXPECTED_FLEET_FILES`, `EXPECTED_CLIENT_STACKS`,
    `COPIED_CLIENT_STACKS`, and the shared-module loader list;
  - `test_cr090_cli_install_integration.py`: `EXPECTED_FLEET_FILES`, `CLIENT_STACKS`;
  - `test_cr046_uv_env_gate.py` `CLIENT_STACKS`;
  - `test_crucible_axi_wheel_packaging.py` `EXPECTED_CLIENT_PAYLOAD`.
- **The schema:**
  - `declaration_schema_harness.py`: `STACKS`, `_CLIENT_FILES`;
  - `test_the_declaration_schema_states_every_stacks_declaration.py`;
  - the per-stack classes of the agreement test.
- **`CLIENT_FILES` / `CLIENT_KEYS`** in:
  - `test_client_tier_surface.py`;
  - `test_client_fleet_envelope_census.py`, with its fake-body map;
  - `test_the_gate_step_carries_the_no_mistakes_findings_count.py`;
  - `test_cr097_cr_help_namespace_neutral.py`;
  - `test_gate_run_declared_skip_defaults.py`;
  - `test_cr061_gate_run_skip_passthrough.py`;
  - `test_cr022_points_declaration.py`;
  - `test_cr091_roadmap_verbs.py`;
  - `test_gate_respond_argv_and_flag_surface.py`;
  - `test_plan_file_cycle_flag_help.py`;
  - `test_every_verb_that_runs_a_test_runner_is_classified.py`, with its verb tables;
  - `test_the_close_judges_each_suite_by_its_latest_gate_result.py`;
  - `test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close.py`.
- **`test_cr128_flag_help_census.py`:**
  - `FLAG_HELP_CLIENTS` / `CENSUS_SOURCES`;
  - an `eda` entry in `FLAG_COUNT_FLOOR`;
  - `FLEET_FLAG_COUNT_FLOOR`;
  - `PRE_CR128_PARTIAL_HELP_RESIDUE` / `_TOTAL`.
- **The other fleet tests:**
  - `test_the_run_read_verbs_register_once_for_the_fleet.py`;
  - `test_every_clients_help_names_where_its_board_comes_from.py`;
  - `test_every_ingest_states_its_stack.py` `CLIENT_STACKS`;
  - `test_a_run_signalled_during_its_ingest_still_gets_filed.py`, where eda joins
    `INLINE_REPORT_CLIENTS`, and its set assertion;
  - `test_client_unit_tier_wall_vs_cpu.py`: `_TOOLCHAIN_ALIASES`, `_PROBED_CLIENTS`;
  - the [6] sites of `test_client_tier_run_envelope.py`;
  - the tier map of `test_client_tier_declaration_detection.py`;
  - `test_a_scoped_gate_refuses_what_it_cannot_run.py`;
  - `test_the_client_suite_cannot_reach_the_live_project.py`, with `EDA_CRUCIBLE_PROJECT_DIR`;
  - `test_an_escaping_os_or_value_error_becomes_an_envelope.py`;
  - `test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active.py`;
  - `test_verification_runs_declare_their_release.py`;
  - `test_suite_run_verbs_gain_a_cycle_flag.py`;
  - `test_a_release_gate_files_every_suite_it_runs_under_the_release.py`;
  - `test_a_client_parses_no_report.py`, which gains a test that the eda client parses no report;
  - `test_import_order_suppressions_name_their_real_cause.py`;
  - the three sites of `test_crucible_axi_shared.py`;
  - `OTHER_STACKS` in `test_a_maven_run_reads_its_projects_console_declaration.py` and
    `test_an_arduino_run_reads_its_projects_stream_declaration.py`.

### §S5 — the docs

- **README:** the client list, and the eda client's verbs, its project dir, key and interpreter order, and
  its refusals.
- **`docs/RUNBOOK.md`:** an eda section covering the declaration, the venv, and SKIP.
- **CHANGELOG `[Unreleased]` "Stack declaration changes":** the schema version, the `eda` stack, and
  `eda-pytest` joining the rust, arduino and maven skip sets. It also states that no board field carries
  ERC, DRC or LVS counts: the gates assert them, and a failure's message names them.
- **`docs/research/PRD-crucible-v2.md`:** the eda client in the client diagram.
- **`docs/research/DN-testing-tiers-in-crucible-projects.md`:** an `eda` row in the per-stack table, with
  the L0–L3 mapping and the reason for each tier (from `TIER_MEANINGS`).

## Acceptance criteria

- [ ] **AC1 — installed.** Build the wheel, install it into a scratch target dir, and inspect the result:
  - `clients/eda-crucible.py` is laid down with its mode;
  - `crucible-clients.json` has `clients.eda` naming it.
- [ ] **AC2 — the schema states eda.**
  - The schema's `version` is one more than at the branch's base.
  - `stacks.eda` and `reserved_frameworks.eda` hold exactly the §S2 content.
  - The manifest's `declaration_schema.version` equals it.
- [ ] **AC3 — the client and the schema agree.** Driven by entries generated from the schema:
  - eda accepts every valid entry, for both key forms and every tier;
  - eda refuses each refused shape, a bad tier, an empty `paths` and a missing path;
  - eda accepts an unlisted field;
  - eda skips every other stack's complete valid entry;
  - `[eda] python` is validated as the schema states.
- [ ] **AC4 — every reader skips eda (three call sites).** A complete valid `eda-pytest` entry beside each
  client's own entry is skipped, and nothing in it is refused, by each of:
  - `rust-crucible.py`;
  - `arduino-crucible.py`;
  - `mvn-crucible.py`.

  Each client's skip-set constant contains `eda-pytest`.
- [ ] **AC5 — the census.**
  - Each list in §S4 contains eda, or `eda-crucible.py`.
  - Each count pin there equals its value at the base plus one, or for `FLEET_FLAG_COUNT_FLOOR`, plus
    eda's measured flag count.
  - The full python client suite passes.
- [ ] **AC6 — the docs follow.**
  - The CHANGELOG entry names the schema version, `eda`, and the three skip sets.
  - README and RUNBOOK name `eda-crucible.py`, `EDA_CRUCIBLE_PROJECT_DIR`, `EDA_CRUCIBLE_PYTHON` and
    `[eda] python`.
  - The DN's table has an `eda` row giving L1 → `unit`, L1b → `module`, L2 → `integration` and L3 → `e2e`.
- [ ] **AC7 — invariants.**
  - The shared modules keep their pinned sizes.
  - The code and tests this CR adds carry no CR id literal.
  - `PROSE_CITATIONS` is re-recorded at close-out only if the measured `clients` head moved.

## Estimated size

8 points: the installer and manifest (1), the schema with three skip sets and the agreement test (3),
about 45 census lists with their pins (3), and the docs (1).

## Risk

- **The census is found by grep.** A list spelled another way can be missed, so RED re-runs the grep for
  `"go"`, `go-crucible.py` and `CLIENT_FILES|CLIENTS|STACKS` before pinning anything.

## Non-goals

- The lists that name only the five pre-Go clients (CR-CRU-247).
- The frameworks of CR-CRU-244 (`eda-gate`) and CR-CRU-249 (`eda-sim`), and the `[eda]` fields of CR-CRU-245 and CR-CRU-248.
  Each of those CRs adds its own.
- A `tools` list.
- Model B's writer and skill.
