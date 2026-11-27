# CR-CRU-243 — the fleet installs, declares and counts the eda client

**Status:** COMPLETED (shipped 2026-11-28 on develop)
**Type:** feature
**Priority:** high. Model B's writer reads the schema at run time.
**Depends on:** CR-CRU-242
**Labels:** installer, schema, census, docs
**Phase:** design
**Design reference:** CR-CRU-238 (the declaration schema and its writer rule); CR-CRU-195 §S5–§S6 (how a stack joins the fleet); `docs/research/DN-testing-tiers-in-crucible-projects.md`

## Context

`clients/eda-crucible.py` (CR-CRU-242) runs and files an EDA project's pytest tiers. It is not installed yet,
the declaration schema does not name it, and the fleet's closed lists do not count it.

- **Model B's scaffold writes a project's declaration** from `crucible-declaration.schema.json`, writing only what it
  can check (CR-CRU-238's writer rule). Its agents read the tier mapping from the docs.
- **The other `[targets]` readers must skip eda's entries.** Rust, arduino and maven share the flat
  `[targets.<key>]` namespace.
- **The schema's vocabulary cannot yet say what eda accepts.** It has no value form for a list of paths, none for
  an executable file, no machine-readable tier list or label rule for a key, and no way to say that an entry with
  no `framework` is skipped. This CR adds them (user ruling, 2026-11-27), so the schema states eda exactly and a
  writer can check every eda field.

## Scope

- **The schema describes what the client accepts, and nothing more.** In particular it carries no
  Model-B-only `tools` list.
- **The schema change is versioned.** `version` goes from 3 to 4. The CHANGELOG lists it under "Stack declaration
  changes", including the new vocabulary.
- **The census reaches eda wherever a fleet contract applies to it**, and records an exclusion with its reason
  where one does not (CR-CRU-247's exclusion rule).
- **`clients/eda-crucible.py` is committed with mode 0644,** like every other client.

### §S1 — the installer and the manifest

- `install.FLEET_FILES` gains `eda-crucible.py`, so `crucible-axi install` lays it down beside the
  other clients.
- `manifest.CLIENT_STACKS` gains `eda`, so `crucible-clients.json` names
  `clients.eda: <clients>/eda-crucible.py`.
- The "six" and "three executable clients" comments in `crucible_axi/install.py`, `crucible_axi/manifest.py` and the
  fleet-stage test are brought up to date.

### §S2 — the schema names eda, in a vocabulary that can say it

**New vocabulary** (each stated in the schema's own description of its forms):

- **A list value form:** `{"list": {"min": <n>, "items": <value form>}}` — a list of at least `n` items, each of
  the item form.
- **A path item that may carry a node id:** `{"path": {"exists": true, "node_id": "::"}}` — a path relative to the
  project dir that exists, optionally followed by `::<node id>`, where the part before `::` must exist.
- **An executable-file path form:** `{"path": {"is": "executable"}}` — a path relative to the project dir naming an
  executable file.
- **A key with tiers and a label:** `key` may carry `"tiers": [...]` (the allowed first segment) and
  `"label": "non-empty"` (the `/<label>` part, when present, is non-empty).
- **An entry-level `frameworkless`:** `"skipped"` when the reader skips an entry with no `framework`. A stack that
  omits it keeps today's meaning (such an entry is rust's).

**`stacks.eda`:**

- a stack-level `description`;
- `location {file: crucible.toml, table: "targets.<key>"}`;
- `entry`:
  - `key` `{form: "tier[/label]", tiers: ["unit", "module", "integration", "e2e", "bdd"], label: "non-empty",
    description}`;
  - `open: true`, `other_stacks: "skipped"`, `frameworkless: "skipped"`, `refused: []`;
  - `fields`:
    - `framework` `{values: ["eda-pytest"], default: null, required: true}`;
    - `paths` `{description: "pytest paths or path::node ids relative to the project dir", values: {list: {min:
      1, items: {path: {exists: true, node_id: "::"}}}}, default: null, required: true}`;
  - `shape`: targets not a table → undeclared; entry not a table → **skipped**; file does not parse → refused;
- a stack table `eda` in the form the python and go stack tables use: `{file: "crucible.toml", table: "eda",
  fields: {python: {description, values: {path: {is: "executable"}}, default: null, required: false,
  overridden_by: "--python, then $EDA_CRUCIBLE_PYTHON"}}, shape: {table_not_a_table: refused, file_does_not_parse:
  refused}}`.

**Also:**

- **`reserved_frameworks.eda`** = `["eda-pytest"]`.
- **`skip_rule.readers`** gains `eda`, and its description names it.
- **`version`** = 4.

### §S3 — every `[targets]` reader skips eda

`eda-pytest` joins `_OTHER_STACKS_FRAMEWORKS` in `rust-crucible.py`, `arduino-crucible.py` and `mvn-crucible.py`.

The agreement test (`tests/client/unit/test_the_clients_agree_with_the_declaration_schema.py`, with
`declaration_schema_harness.py`) learns the new vocabulary and drives eda in both directions:

- eda's declaration check, with entries generated from the schema: both key forms and every tier, every valid
  `paths` shape (a path, a directory, a node id), every refused shape the schema states;
- the skip of a complete valid eda entry by rust, arduino and maven, and of every other stack's entry by eda;
- the frameworkless and entry-not-a-table rules as eda states them;
- the `[eda] python` stack table.

### §S4 — the census

**The shared fleet list.** `client_fleet_envelope_census_helpers.CLIENT_FILES` (read by about 25 modules) and
`client_tier_surface_helpers.CLIENT_FILES` (the help-text census) gain eda. Each module the shared list drives runs
its contract on eda, or records an exclusion naming why it does not apply (no `lint` verb, no coverage, no
unit-check stage yet).

**Every live six-client list** gains eda, or a recorded exclusion, and every count pin tied to it moves by one:

- **Installer and manifest:** `test_crucible_axi_install.py` `EXPECTED_CLIENT_STACKS` and its count;
  `test_cr090_fleet_stage.py` `EXPECTED_FLEET_FILES`, `EXPECTED_CLIENT_STACKS`, `COPIED_CLIENT_STACKS` and the
  shared-module loader lists; `test_cr090_cli_install_integration.py` `EXPECTED_FLEET_FILES` and `CLIENT_STACKS`;
  `test_cr046_uv_env_gate.py` `CLIENT_STACKS`; `test_crucible_axi_wheel_packaging.py` `EXPECTED_CLIENT_PAYLOAD`.
- **The schema:** `declaration_schema_harness.py` `STACKS`, `TARGETS_READERS`, `READER_KEYS`, `_CLIENT_FILES`;
  `test_the_declaration_schema_states_every_stacks_declaration.py` (the version, the stack count, the locations,
  `skip_rule.readers`).
- **The fleet's per-client lists:** `test_the_gate_step_carries_the_no_mistakes_findings_count.py`
  `CLIENT_SCRIPTS`; the `CLIENT_FILES` of `test_gate_run_declared_skip_defaults.py`,
  `test_cr061_gate_run_skip_passthrough.py`, `test_cr022_points_declaration.py`, `test_cr091_roadmap_verbs.py`,
  `test_gate_respond_argv_and_flag_surface.py`, `test_plan_file_cycle_flag_help.py` and
  `test_a_client_with_no_board_declared_refuses.py`; the `CLIENT_KEYS` of
  `test_the_close_judges_each_suite_by_its_latest_gate_result.py` and
  `test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close.py`;
  `test_every_clients_help_names_where_its_board_comes_from.py`; `test_every_ingest_states_its_stack.py`
  `CLIENT_STACKS`; `test_a_run_signalled_during_its_ingest_still_gets_filed.py` (`INGEST_HELD_SITES`,
  `INLINE_REPORT_CLIENTS` and its count); `test_client_tier_run_envelope.py`;
  `test_client_tier_declaration_detection.py` `DECLARED_CELLS`; the scoped-gate helpers' tier map;
  `test_an_escaping_os_or_value_error_becomes_an_envelope.py`; `test_verification_runs_declare_their_release.py`;
  `test_suite_run_verbs_gain_a_cycle_flag.py`; `test_a_release_gate_files_every_suite_it_runs_under_the_release.py`;
  `project_create_harness.py` `CLIENT_SCRIPTS`; `release_notes_board.py` and
  `test_release_notes_drafts_the_section_in_every_client.py`; `test_hermetic_runs.py` and
  `test_the_hermetic_modules_ship_with_the_fleet.py` `CLIENT_SCRIPTS`; `test_the_lint_module_ships_with_the_fleet.py`;
  the `CLIENT_NAMES` of `test_the_clients_read_their_intervals_from_one_settings_instance.py` and
  `test_the_clients_run_todays_intervals_when_no_setting_is_given.py`; `test_runs_and_run_word_a_lint_record_as_lint.py`;
  `test_client_tier_run_modality.py`.
- **Recorded exclusions** (the contract does not apply to eda today): `lint_verb_harness.CLIENTS` and the lint-verb
  and lint-order tests; the unit-check stage tests; the coverage-envelope and stored-coverage lists.
- **Not repeated:** eda's own CR-242 suites already prove wall-vs-CPU, refused-while-a-cycle-is-active and the
  signalled run; those fleet lists gain eda only where the module's shape makes it free.
- **Shipped doc:** `clients/STATUS-CONTRACT.md` names seven clients.

The list is re-derived by grep at RED (`"go"`, `go-crucible.py`, `CLIENT_FILES|CLIENTS|STACKS|CLIENT_SCRIPTS|CLIENT_NAMES|CLIENT_KEYS`)
before anything is pinned; a list found then is handled the same way. Lists naming only the five pre-Go clients are
CR-CRU-247's.

### §S5 — the docs

- **README:** "seven clients" and the client list, the shared-module list brought up to date, and an eda paragraph
  like go's: its verbs, its project dir, key and interpreter order (`--python`, `EDA_CRUCIBLE_PYTHON`, `[eda]
  python`, `.venv`), the `hardware/` sub-project, its refusals and its verdicts.
- **`docs/RUNBOOK.md`:** eda in the Hermetic list, and a short eda note: the declaration, the venv, SKIP,
  `pending` against `skipped[]` (module-level skips and xfails count in `pending` but are not listed; the
  `tier-skipped` count includes xfails), and that a `PYTEST_ADDOPTS=-q` in the environment leaves skip reasons
  `null`.
- **CHANGELOG `[Unreleased]` "Stack declaration changes":** schema version 4, the `eda` stack, the new vocabulary,
  and `eda-pytest` joining the rust, arduino and maven skip sets. It also states that no board field carries
  ERC, DRC or LVS counts: the gates assert them, and a failure's message names them. The CR-242 "Added" entry's
  "still to come" sentence is updated.
- **The L1–L3 mapping** (L1 → `unit`, L1b → `module`, L2 → `integration`, L3 → `e2e`, excluded from the gate;
  `bdd` unused) is in the README's eda paragraph. L0 → `check` waits for CR-CRU-245. The DN's dated per-stack
  table and the PRD diagram are not changed (go has neither).

## Acceptance criteria

- [ ] **AC1 — installed.** `test_cr046_uv_env_gate.py` (wheel → scratch venv) and
  `test_cr090_cli_install_integration.py` (`crucible-axi install --target-dir`) cover eda: `eda-crucible.py` is laid
  down byte for byte, and `crucible-clients.json` has `clients.eda` naming it.
- [ ] **AC2 — the schema states eda.** `version` is 4; `reserved_frameworks.eda` is `["eda-pytest"]`;
  `skip_rule.readers` names eda. The rest of `stacks.eda` is proven by AC3.
- [ ] **AC3 — the client and the schema agree.** Driven by entries generated from the schema, through the new
  vocabulary:
  - eda accepts every valid entry, for both key forms and every tier, and every valid `paths` shape;
  - eda refuses a bad tier, an empty label, a missing, empty or non-list `paths`, a missing path, a file that does
    not parse, and an `[eda] python` that is not an executable file or an `[eda]` that is not a table;
  - eda skips a frameworkless entry and an entry that is not a table;
  - eda accepts an unlisted field;
  - eda skips every other stack's complete valid entry.
- [ ] **AC4 — every reader skips eda.** A complete valid `eda-pytest` entry beside each client's own entry is
  skipped, and nothing in it is refused, by `rust-crucible.py`, `arduino-crucible.py` and `mvn-crucible.py`; each
  skip set holds every other stack's reserved frameworks, eda's included.
- [ ] **AC5 — the census.** Each list in §S4 contains eda, or records its exclusion; each count pin there equals its
  value at the base plus one. The full python client suite passes.
- [ ] **AC6 — the docs follow** (reviewed): the CHANGELOG entry names schema version 4, `eda`, the new vocabulary
  and the three skip sets; README and RUNBOOK name `eda-crucible.py`, `EDA_CRUCIBLE_PROJECT_DIR`,
  `EDA_CRUCIBLE_PYTHON` and `[eda] python`; README states the L1–L3 mapping; `STATUS-CONTRACT.md` says seven.

### Reviewed, not tested

- `eda-crucible.py` imports no XML parser and never self-registers a project.
- The shared modules' source-text sweeps are not extended to eda.
- No CR id or AC label in any added line under `clients/`, `crucible_axi/` or `tests/`.
- `clients/eda-crucible.py` is mode 0644.

## Estimated size

13 points (re-scored from 8 at the gap analysis): the installer, manifest and mode (1), the schema vocabulary, the
eda entry, the three skip sets and the agreement harness (5), the census through the shared list with its
exclusions and about 35 named lists (5), and the docs (2).

## Risk

- **The census is found by grep.** A list spelled another way can be missed, so RED re-runs the grep before
  pinning anything.
- **A vocabulary change reaches Model B's writer.** A writer reading version 4 meets forms it does not know; under
  CR-CRU-238's newer-version rule it warns and writes only what it knows until it learns them. The CHANGELOG states
  each new form.
- **The shared census list drives about 25 modules,** each needing an eda fake; a module whose fake would be costly
  records an exclusion with its reason instead, and VERIFY reviews each one.

## Non-goals

- The lists that name only the five pre-Go clients (CR-CRU-247).
- The frameworks of CR-CRU-244 (`eda-gate`) and CR-CRU-249 (`eda-sim`), and the `[eda]` fields of CR-CRU-245 and
  CR-CRU-248. Each of those CRs adds its own.
- A `lint` verb, a coverage run or a unit-check stage for eda.
- A `tools` list.
- Model B's writer and skill.
- The DN's per-stack snapshot table and the PRD diagram.

## Close-out (2026-11-28)

Plan 282.

- **Gap analysis:** the baseline was CR-CRU-242's gate on the same tree (13,980/0). A read-only fact pass found that
  the spec's `stacks.eda` failed the existing schema tests and contradicted the client, and that §S4 named six
  deleted files and missed about 14 lists. The user ruled:
  - extend the schema vocabulary;
  - census through the shared list, with recorded exclusions;
  - AC1 through the existing install tests, and eda at 0644;
  - the rest as recommended.

  Points went from 8 to 13.
- **Cycle 1050 (§S2, §S3):** the agreement harness learned the new forms and generates eda entries from the
  schema; schema version 4 with `stacks.eda`; `eda-pytest` in the rust, arduino and maven skip sets.
- **Cycle 1051 (§S1):** the installer lays `eda-crucible.py` down, the manifest names `clients.eda`, and the file
  is 0644.
- **Cycle 1052 (§S4, §S5):** 51 test files count eda or record why not (no lint, coverage or unit-check yet). The
  census found two eda gaps, both fixed:
  - eda's run verbs now word `--cycle` as filing (user ruling);
  - a signal during an ingest now lets the run be filed.

  The README, RUNBOOK, status contract and CHANGELOG name the client.
- **Cycle 1053, VERIFY:** PASS, with no must-fix finding.
- **Cycle 1054, FIX (user-chosen notes):**
  - a test that `--cycle` files the run under its cycle;
  - the gate's signal wording;
  - the install comment;
  - the schema says paths may also be absolute.
- **Pre-merge gate (cycle 1054):** 14,295 passed and 0 failed in 26m16s. By suite: bun 5,181, python unit 2,995,
  python integration 6,119.
- **Noted for later:** a signal during the eda gate counts the suite as failed and goes on to the next one, rather
  than stopping the gate.
