# CR-CRU-149 — citation rewrites (AC8)

Every in-scope `path:line` citation into a source file, rewritten to cite by symbol (§S4). Each
row names the citing file, the cite as it stood, the cite as it now reads, and the construct the
new cite names. A construct was identified by what the citing sentence claims, checked against the
cited file at the commit that introduced the cite where the line had drifted. Where the cited file
was a v1 script that no longer exists (`~/.claude/scripts/*-crucible.py`), the new cite names the
v1 construct and/or its successor in `clients/`.

## C2 — shipped code and design notes

| citing file | old cite | new cite | construct |
|---|---|---|---|
| `clients/_crucible_axi.py` | `src/hints.ts:358` | `roadmapHints` and `waveHints` (`src/hints.ts`) — `roadmapHints`' `unproposedRelease` entry | `roadmapHints` constant; the `release-propose --label` step is its `unproposedRelease` entry |
| `clients/_crucible_axi.py` | `src/server.ts:357` | the `limitDisclosures` loop in `src/server.ts`, under `import.meta.main` | the boot banner's `for (const disclosure of limitDisclosures())` loop in the `import.meta.main` block |
| `clients/arduino-crucible.py` | `mvn-crucible.py:641` | `_parse_junit` in `clients/mvn-crucible.py` | `_parse_junit` — its `<skipped>` → `pending` branch |
| `clients/bun-crucible.py` | `mvn-crucible.py:641` | `_parse_junit` in `clients/mvn-crucible.py` | `_parse_junit` — its `<skipped>` → `pending` branch |
| `clients/python-crucible.py` | `mvn-crucible.py:641` | `_parse_junit` in `clients/mvn-crucible.py` | `_parse_junit` — its `<skipped>` → `pending` branch |
| `clients/rust-crucible.py` | `mvn-crucible.py:641` | `_parse_junit` in `clients/mvn-crucible.py` | `_parse_junit` — its `<skipped>` → `pending` branch |
| `crucible_axi/install.py` | `src/limits.ts:158-159` | `serverConfigPath` (`src/limits.ts`) | `serverConfigPath` — `join(dirname(resolveStore(opts).path), "crucible.toml")` |
| `crucible_axi/install.py` | `src/server.ts:39-79` | `resolveStore` (`src/server.ts`) | `resolveStore` |
| `docs/research/DN-client-fleet-inventory.md` | `mvn-crucible.py:641` | `_parse_junit` in `clients/mvn-crucible.py` | `_parse_junit` — its `<skipped>` → `pending` branch |
| `docs/research/DN-crucible-api-reconstruction.md` | `arduino-crucible.py:21` (reading note) | the base-URL constant of the v1 `arduino-crucible.py`, succeeded by `_base_url` in `clients/arduino-crucible.py` | v1 module-level base-URL constant (`CRUCIBLE` in the first in-repo port, `fccbfd1`); successor `_base_url`. The note gains one sentence saying the evidence cites were rewritten |
| `docs/research/DN-crucible-api-reconstruction.md` | `arduino-crucible.py:21` (§1 table) | the v1 `arduino-crucible.py` base-URL constant (successor: `_base_url` in `clients/arduino-crucible.py`) | as above |
| `docs/research/DN-crucible-api-reconstruction.md` | `arduino-crucible.py:80` | `_ensure_project` in `clients/arduino-crucible.py` | `_ensure_project` — the project self-registration POST |
| `docs/research/DN-crucible-api-reconstruction.md` | `arduino-crucible.py:133` | `_run_native_tests_body` in `clients/arduino-crucible.py` | `_run_native_tests_body` — the run payload's `name` (successor of v1 `cmd_unit`'s payload) |
| `docs/research/DN-crucible-api-reconstruction.md` | `bun-crucible.py:294` | `_ingest_parsed` in `clients/bun-crucible.py` | `_ingest_parsed` — prints `resp['error']` |
| `docs/research/DN-crucible-api-reconstruction.md` | `mvn-crucible.py:218` | the v1 `mvn-crucible.py`'s `cmd_register` comment, now in `cmd_register` in `clients/_crucible_axi.py` | `cmd_register` — the "displayName MUST go inside `identity`" comment |
| `docs/research/DN-crucible-api-reconstruction.md` | `mvn-crucible.py:353-365` | `_ingest_junit_dir` in `clients/mvn-crucible.py` | `_ingest_junit_dir` — the raw junit ingest |
| `docs/research/DN-crucible-api-reconstruction.md` | `python-crucible.py:268` | the v1 `python-crucible.py`'s parsed-ingest path, later `_ingest_parsed_dir`; successor `_parse_junit_dir` in `clients/python-crucible.py` | `_parse_junit_dir` — per-method leaf names (successor of `_ingest_parsed_dir`, where the quoted comment sat in the first port) |
| `docs/research/DN-crucible-api-reconstruction.md` | `rust-crucible.py:360-369` | the v1 `rust-crucible.py`'s `cmd_register` | v1 `cmd_register` — the top-level `displayName` payload (the current client no longer sends it) |
| `docs/research/DN-crucible-api-reconstruction.md` | `rust-crucible.py:371,422` | `_ingest_rustc_stderr` in `clients/rust-crucible.py` etc. | `_ingest_rustc_stderr` — `return 0 if resp.get("ok") else 1` |
| `docs/research/DN-crucible-api-reconstruction.md` | `rust-crucible.py:401-443` | `_ingest_junit_axi` in `clients/rust-crucible.py` | `_ingest_junit_axi` — successor of v1 `_ingest_junit`, the raw junit ingest |
| `docs/research/DN-crucible-api-reconstruction.md` | `rust-crucible.py:417-421` | `_ingest_junit_axi` in `clients/rust-crucible.py` | `_ingest_junit_axi` — prints `passed`/`failed`/`total` |
| `docs/research/DN-crucible-responsive-model.md` | `pane-scroll.steps.ts:156-165` | the step "the workspace Runs pane's content child carries the 660px min-width floor" in `tests/e2e/steps/pane-scroll.steps.ts` | that step definition |
| `docs/research/DN-crucible-responsive-model.md` | `public/app.js:2453-2487` | `RAIL_STORAGE_KEY` in `public/app.js`, read in the body of `main` | the `RAIL_STORAGE_KEY` read/write block in `main` |
| `docs/research/DN-crucible-responsive-model.md` | `styles.css:903-905` | the `:root.app-density-*` rules in `public/styles.css` | `:root.app-density-comfortable` / `-compact` / `-ultra` |
| `docs/research/DN-crucible-wave-track-release.md` | `_crucible_axi.py:4801`, `:1315` | the `0 < nsteps < 9` guard in `cmd_gate_run` in `clients/_crucible_axi.py` (since replaced by `axi_snapshot_in_flight`), fed the step count `gate_from_axi` returns | `cmd_gate_run`'s interim-POST guard; `gate_from_axi`'s `return gate, len(steps)` (identified at `06c6e65`) |
| `docs/research/DN-crucible-wave-track-release.md` | `clients/_crucible_axi.py:1821` | the client's `resolve_next`, then in `clients/_crucible_axi.py`, moved to `resolveNext` in `src/next.ts` | `resolve_next` (gone from the client); successor `resolveNext` |
| `docs/research/DN-crucible-wave-track-release.md` | `clients/_crucible_axi.py:4647` | `post_gate` (`clients/_crucible_axi.py`) | `post_gate` |
| `docs/research/DN-crucible-wave-track-release.md` | `src/store.ts:2013-2016` | the doc of `recordGateEvent` in `src/store.ts` | `recordGateEvent` — its `version` doc comment (identified at `06c6e65`) |
| `docs/research/DN-crucible-wave-track-release.md` | `src/types.ts:407` | the `wave` field of `QueueEntry` in `src/types.ts` | `QueueEntry.wave` |
| `docs/research/DN-release-process.md` | `pyproject.toml:7,32` | `dynamic` in `pyproject.toml`, plus its `[tool.hatch.version]` table | `dynamic = ["version"]` and `[tool.hatch.version]` `source = "vcs"` |
| `docs/research/DN-testing-tiers-in-crucible-projects.md` | `mvn-crucible.py:867` | `_run_surefire_tier` in `clients/mvn-crucible.py` | `_run_surefire_tier` — its "tier map" comment |
| `public/app-logic.mjs` | `public/styles.css:1416` | the `.app-flow-node.completed_untracked` rule in `public/styles.css` | `.app-flow-node.completed_untracked` and the comment above it |
| `public/app-logic.mjs` | `src/store.ts:3388` | the loop in `waveScopeRefusal` (src/store.ts) | `waveScopeRefusal` — its `if (row.wave === "") continue;` skip; the dated re-pin history (carrying `CR-CRU-118`) is kept |
| `public/app-logic.mjs` | `src/store.ts:411` | `waveNumber` (`src/store.ts`) | `waveNumber` |
| `public/app-logic.mjs` | `src/v2.ts:2053` | `proposalBrief` in `src/v2.ts` | `proposalBrief` — its `waves` join |
| `public/app.js` | `src/v2.ts:771-773` | the `projectKey` guard in `handleProjectPatch` (src/v2.ts) | `handleProjectPatch` — the `projectKey is immutable` 400 |
| `src/store.ts` | `public/app-logic.mjs:479` | `numericLabelCompare` in `public/app-logic.mjs` | `numericLabelCompare` — its leading-digit read |
| `src/store.ts` | `scripts/release.sh:733`, `:405` | `emit_release_milestone` in `scripts/release.sh`; `release_ship_date` (the bare `:405` dropped) | `emit_release_milestone` — its `--released-at` guard (it now refuses a dateless ship, noted in the prose) |
| `src/v2.ts` | `src/types.ts:65-69` | the `role` doc on `Agent` in `src/types.ts` | `Agent.role` |

## C3 — the tests

Rewritten by five parallel agents over disjoint files, then a sixth for the citations in test
titles and thrown error messages. Where one sentence carried several cites, they share a row.
Not listed: stack-trace positions (`path:line:column`), scratch `tmp/` fixture paths, and
verbatim quotes of spec records, which the guard (`tests/citations-cite-by-symbol.test.ts`)
excludes by rule or by named exemption.

| citing file | old cite | new cite | construct |
|---|---|---|---|
| docs/research/DN-crucible-wave-track-release.md | :1306-1310 | the final-snapshot fallback in `gate_from_axi` (`clients/_crucible_axi.py`) | gate_from_axi final=True outcome fallback |
| docs/research/DN-crucible-wave-track-release.md | :1498 | the `next` section header in `clients/_crucible_axi.py` | the next-verb section header comment (ONE read in, ONE decision out) |
| docs/research/DN-crucible-wave-track-release.md | :1523 | `DRAINED_REASONS` in `src/next.ts` | DRAINED_REASONS (moved from beside resolve_next) |
| docs/research/DN-crucible-wave-track-release.md | :1848 | — (removed) | trailing line tag on the resolve_next snippet; the surrounding prose already names resolve_next in clients/_crucible_axi.py |
| docs/research/DN-crucible-wave-track-release.md | :4811-4819 | the final `post_gate` in `cmd_gate_run` | cmd_gate_run final seal |
| public/app-logic.mjs | :3374 | the `let active` declaration | history: the miscited let active declaration in waveScopeRefusal |
| public/app-logic.mjs | :3377 | — (removed) | history of a retired line cite into waveScopeRefusal (src/store.ts), already named by symbol |
| public/app-logic.mjs | :690 | — (removed) | numericLabelCompare already named by symbol in the same sentence |
| public/app-logic.mjs | :857-861 | the declared-node literal above | workflowLens declared-node object literal |
| public/app-logic.mjs | :898-918 | the inferred-fallback loop above (in `workflowLens`) | workflowLens inferred-node loop |
| public/app-logic.mjs | :955 | the `wave.crs` filter below | workflowLens wave.crs status/liveCrs filter |
| public/app.js | :2854 | the `app-flow-loose` branch of `RoadmapFlowWave` | RoadmapFlowWave loose-group branch |
| public/styles.css | :1007/:1096/:1119 | `app-locate-blink`, `app-run-pulse`, `app-spin` | the animation keyframes family |
| public/styles.css | :1185 | `.app-strip-gate` | .app-strip-gate (the strip gate cell declaring box-sizing: border-box) |
| public/styles.css | :1185 | `.app-strip-gate` | .app-strip-gate (the strip gate cell declaring box-sizing: border-box) |
| public/styles.css | :343/:359 | — (removed) | the selectors `.app-card`/`.app-agent-row` were already named in the sentence |
| src/store.ts | :3238-3264 | `transitionCycle`'s activation refusals | transitionCycle already-active/out-of-order refusals |
| src/store.ts | :589-596 | `PlanOpError`'s `code` union | PlanOpError.code (was misnamed CycleTransitionError) |
| tests/agent-identity-source-validation.test.ts | src/types.ts:29-33 | `AgentIdentity` in src/types.ts | AgentIdentity |
| tests/agent-identity-source-validation.test.ts | src/v2.ts:453 | `handleAgentTouch` in src/v2.ts | handleAgentTouch (role-required error) |
| tests/agent-identity-source-validation.test.ts | src/v2.ts:485 | `handleAgentTouch` in src/v2.ts | handleAgentTouch |
| tests/agent-role-rename.test.ts | src/store.ts:330-379 | `createBaseTables` (src/store.ts) | createBaseTables (the CREATE TABLE statements for projects/agents/events) |
| tests/agent-role-required.test.ts | src/hints.ts:44 | `registered` in src/hints.ts | hints.registered ("only needed while idle") |
| tests/agent-role-required.test.ts | src/store.ts:263-284 | `createBaseTables` (src/store.ts) | createBaseTables (projects/agents CREATE TABLE) |
| tests/agent-role-required.test.ts | src/store.ts:358-431 | `MIGRATION_BODIES` in src/store.ts | MIGRATION_BODIES (ALTER TABLE retrofit) |
| tests/agent-role-required.test.ts | src/v2.ts:1471-1473 | `handleAgentTouch` in src/v2.ts | handleAgentTouch (shared register/heartbeat handler) |
| tests/agent-role.test.ts | :2165 | `LinkedRunRow` (public/app.js) | LinkedRunRow |
| tests/agent-role.test.ts | :2201 | `InlineRunEntry` (public/app.js) | InlineRunEntry |
| tests/agent-role.test.ts | public/app.js:709 | `EventCard` (public/app.js) | EventCard |
| tests/agent-runtime-pane.test.ts | public/app.js:153 | `startPolling` in public/app.js | startPolling (setInterval 5000) |
| tests/aggregate-headers.test.ts | crucible-v2-design.html:675 | the `F13` frame of .lavish/crucible-v2-design.html | F13 design frame (the quoted wording is no longer in the gitignored mock) |
| tests/app-logic.test.ts | :1202 | — (removed) | roadmapTableColumns already named by symbol |
| tests/app-logic.test.ts | :1482/:1487 | `laneTracks` | the wave-lane tracks in focusedReleaseView |
| tests/app-logic.test.ts | public/app-logic.mjs:1537 | `focusedReleaseView`'s return (public/app-logic.mjs) | focusedReleaseView tracks field |
| tests/ci-toolchain-provisioning.test.ts | :121 :201 :384 :444 | in the test-bun, test-e2e, publish-npm and dry-run-npm jobs | release.yml jobs carrying bun-version |
| tests/ci-toolchain-provisioning.test.ts | pyproject.toml:27 | the `dev` extra in `pyproject.toml` | [project.optional-dependencies] dev |
| tests/ci-toolchain-provisioning.test.ts | pyproject.toml:27 (comment) | pyproject.toml's `dev` extra | [project.optional-dependencies] dev |
| tests/ci-toolchain-provisioning.test.ts | pyproject.toml:27 (failure message) | pyproject.toml's `dev` extra | [project.optional-dependencies] dev |
| tests/ci-toolchain-provisioning.test.ts | test_cr040_coverage_tooling.py:172 | `test_gate_venv_python_can_execute_coverage_module` (tests/client/test_cr040_coverage_tooling.py) | the gate-venv -m coverage test |
| tests/ci-toolchain-provisioning.test.ts | tests/client/test_cr040_coverage_tooling.py:172 (failure message) | tests/client/test_cr040_coverage_tooling.py's test_gate_venv_python_can_execute_coverage_module | the gate-venv -m coverage test |
| tests/ci-toolchain-provisioning.test.ts | tests/client/test_crucible_axi_wheel_packaging.py:121 | `CrucibleAxiWheelPackagingTest.setUpClass` (tests/client/test_crucible_axi_wheel_packaging.py) | setUpClass import-build RuntimeError |
| tests/ci-toolchain-provisioning.test.ts | tests/client/test_crucible_axi_wheel_packaging.py:121 (failure message) | tests/client/test_crucible_axi_wheel_packaging.py's setUpClass | CrucibleAxiWheelPackagingTest.setUpClass |
| tests/ci-toolchain-provisioning.test.ts | tests/clients-bun-crucible.test.ts:83 | `runScript` (tests/clients-bun-crucible.test.ts) | runScript (uv run SCRIPT_PATH spawn) |
| tests/ci-toolchain-provisioning.test.ts | tests/clients-bun-crucible.test.ts:83 (failure message) | tests/clients-bun-crucible.test.ts's runScript | runScript |
| tests/client/test_a_clients_board_is_its_projects_configuration.py | clients/bun-crucible.py:91 (+ rust:87, mvn:93, python:86, arduino:71) | each client's own `CRUCIBLE_URL` constant, since replaced by `_base_url` in `clients/bun-crucible.py` | CRUCIBLE_URL module constant (deleted; successor _base_url) |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | :446 | (in the same file) | test_setting_a_value_leaves_recommended_reading_as_the_shipped_recommendation, already named |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | :887-888 (x2) | the positive control of its "a SERVER limit configured in the PROJECT's file" test | positive-control resolveLimit assertion |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | clients/_crucible_axi.py:130-136 | `_SHIPPED_DATA_CANDIDATES` (clients/_crucible_axi.py) | _SHIPPED_DATA_CANDIDATES |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | clients/_crucible_axi.py:154-158 | `project_config_path` (clients/_crucible_axi.py) | project_config_path |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | crucible_axi/install.py:1170-1186 | `_operator_config_is_untouched` rule in crucible_axi/install.py | _operator_config_is_untouched |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | install.py:212-221 | `FLEET_FILES` in crucible_axi/install.py | FLEET_FILES |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | install.py:75-77 | `UNINSTALL_STAGE_ORDER` in crucible_axi/install.py | UNINSTALL_STAGE_ORDER (no [fleet] inverse) |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | src/limits.ts:158-159 (x3; one in a failure message) | `serverConfigPath` (src/limits.ts) | serverConfigPath |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | tests/client/test_client_limits_resolve_from_configuration.py:195 | `_run_main` in tests/client/test_client_limits_resolve_from_configuration.py | _run_main |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | tests/client/test_client_limits_resolve_from_configuration.py:434 (split failure message, not flagged) | `test_a_shipped_declaration_carries_no_value_of_its_own` | test_a_shipped_declaration_carries_no_value_of_its_own |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | tests/client/test_client_limits_resolve_from_configuration.py:434 (x2) | tests/client/test_client_limits_resolve_from_configuration.py (after `test_a_shipped_declaration_carries_no_value_of_its_own`, already named) | test_a_shipped_declaration_carries_no_value_of_its_own |
| tests/client/test_an_installed_deployment_resolves_its_configuration.py | tests/server-limits-are-configuration.test.ts:848-852 (x2) | tests/server-limits-are-configuration.test.ts, its "the server's crucible.toml sits beside its database" test | the serverConfigPath test in the CR-CRU-131 §S1b describe |
| tests/client/test_arduino_crucible_agent_identity_required.py | :373-375 | `axi_context`/`fleet_context` in `clients/_crucible_axi.py` | fleet_context (WORKFLOW_ROLE → track) |
| tests/client/test_arduino_crucible_agent_identity_required.py | clients/_crucible_axi.py:71-73 | `axi_context`/`fleet_context` in `clients/_crucible_axi.py` | axi_context (WORKFLOW_ROLE → track) |
| tests/client/test_arduino_crucible_axi.py | arduino-crucible.py:868 | `cmd_gate_run` in arduino-crucible.py | cmd_gate_run |
| tests/client/test_arduino_crucible_role_flag_required.py | arduino-crucible.py:1198 | `main` (clients/arduino-crucible.py) | the `register` subparser's `--role` argument in `main` |
| tests/client/test_bun_crucible_agent_identity_required.py | :373-375 | `fleet_context` in `clients/_crucible_axi.py` | `fleet_context` — its WORKFLOW_ROLE → ctx["track"] read |
| tests/client/test_bun_crucible_agent_identity_required.py | clients/_crucible_axi.py:71-73 | `axi_context` in `clients/_crucible_axi.py` | `axi_context` — its WORKFLOW_ROLE → ctx["track"] read |
| tests/client/test_bun_crucible_gate_axi.py | bun-crucible.py:1978-1990 | `cmd_gate_report`/`cmd_gate_run` in clients/bun-crucible.py | cmd_gate_report, cmd_gate_run |
| tests/client/test_bun_crucible_role_flag_required.py | clients/bun-crucible.py:2227 (x2) | the `--role` argument in `main` (clients/bun-crucible.py) | register --role add_argument in main |
| tests/client/test_bun_crucible_toon_envelope.py | _crucible_axi.py:6207 | `_decode_axi_snapshot` in `_crucible_axi.py` | _decode_axi_snapshot |
| tests/client/test_bun_crucible_toon_envelope.py | bun-crucible.py:1783 | `_toon` in `bun-crucible.py` | _toon (lazy TOON codec loader) |
| tests/client/test_client_fleet_envelope_census.py | src/store.ts:380 | `declaredTracks` (src/store.ts) | declaredTracks |
| tests/client/test_client_limits_resolve_from_configuration.py | :516, :1045, :3563 | — (removed) | constants already named in the AssertionError message (TRUNCATE_LIMIT/NO_REPORT_DETAIL_MAX/ROADMAP_LIST_LIMIT, deleted) |
| tests/client/test_client_limits_resolve_from_configuration.py | clients/_crucible_axi.py:1045 / :1106, :1119 | NO_REPORT_DETAIL_MAX -> used by `no_report_warning` | NO_REPORT_DETAIL_MAX (deleted) / no_report_warning |
| tests/client/test_client_limits_resolve_from_configuration.py | clients/_crucible_axi.py:1106, :1119 | (clients/_crucible_axi.py) after `no_report_warning` | no_report_warning (already named) |
| tests/client/test_client_limits_resolve_from_configuration.py | clients/_crucible_axi.py:16-19 | the "Scope boundary" paragraph of the clients/_crucible_axi.py module docstring | module docstring, Scope boundary paragraph |
| tests/client/test_client_limits_resolve_from_configuration.py | clients/_crucible_axi.py:3563 / :3720 | ROADMAP_LIST_LIMIT -> used by `truncate_rows` | ROADMAP_LIST_LIMIT (deleted) / truncate_rows |
| tests/client/test_client_limits_resolve_from_configuration.py | clients/_crucible_axi.py:3722 | (clients/_crucible_axi.py) after `truncate_rows` | truncate_rows (already named) |
| tests/client/test_client_limits_resolve_from_configuration.py | clients/_crucible_axi.py:516 / :519 | TRUNCATE_LIMIT -> used by `truncate_field` | TRUNCATE_LIMIT (deleted) / truncate_field |
| tests/client/test_client_limits_resolve_from_configuration.py | clients/_crucible_axi.py:519 | (clients/_crucible_axi.py) after `truncate_field` | truncate_field (already named) |
| tests/client/test_client_limits_resolve_from_configuration.py | src/server.ts:311 | `retentionDisclosure` in src/server.ts | retentionDisclosure (CR-CRU-129 boot disclosure) |
| tests/client/test_client_limits_resolve_from_configuration.py | tests/client/test_bun_crucible_axi_conventions.py:153 | `_run_main` in tests/client/test_bun_crucible_axi_conventions.py | _run_main |
| tests/client/test_client_tier_declaration_detection.py | clients/rust-crucible.py:952 | — (removed) | payload["tier"]="regression" line inside `_regression_ingest_run`, already named in the sentence |
| tests/client/test_client_tier_run_envelope.py | :1231 | `cmd_test`'s no-XML branch | cmd_test (bun, untiered test verb compile fallback) |
| tests/client/test_client_tier_run_envelope.py | :538 | `_run_native_tests_body` in `arduino-crucible.py` | _run_native_tests_body (no-report branch) |
| tests/client/test_client_tier_run_envelope.py | arduino-crucible.py:538 | `_run_native_tests_body` in `arduino-crucible.py` | _run_native_tests_body (no-report branch) |
| tests/client/test_client_tier_run_envelope.py | bun-crucible.py:1370 | `cmd_regression` in `bun-crucible.py` | cmd_regression (no-JUnit exit) |
| tests/client/test_client_tier_run_envelope.py | python-crucible.py:824 | `_regression_run` in `python-crucible.py` | _regression_run (no-XML branch) |
| tests/client/test_client_tier_run_envelope.py | rust-crucible.py:1136 | `cmd_test` in `rust-crucible.py` | cmd_test (no-junit cargo check branch) |
| tests/client/test_client_tier_run_modality.py | :1067 | [arduino's `test` help] | arduino test verb help text (quoted AC13 context) |
| tests/client/test_client_tier_run_modality.py | :1373 | `cmd_regression` (each client) | python cmd_regression / regression verb |
| tests/client/test_client_tier_run_modality.py | :2010 | `cmd_regression` (each client) | bun cmd_regression / regression verb |
| tests/client/test_client_tier_run_modality.py | :576 | on `develop` too | — (removed) line number on develop; _run_native_tests_body already named |
| tests/client/test_client_tier_run_modality.py | :729 | — (removed) | cmd_auto_ingest already named with its file |
| tests/client/test_client_tier_run_modality.py | clients/rust-crucible.py:2647 | its call in `main` in `clients/rust-crucible.py` | main (the add_tier_verbs(sub, {}) call) |
| tests/client/test_client_tier_run_modality.py | src/store.ts:1911 | `recordTestEvent` in `src/store.ts` | recordTestEvent (tier: meta?.tier ?? "unit") |
| tests/client/test_client_tier_run_modality.py | src/store.ts:1911 | `recordTestEvent` in `src/store.ts` | recordTestEvent (tier: meta?.tier ?? "unit") |
| tests/client/test_client_tier_run_modality.py | src/store.ts:1911 | `recordTestEvent` in `src/store.ts` | recordTestEvent (assertion failure message) |
| tests/client/test_client_tier_stamping.py | :1065 (test_bun_test_opens_the_run_without_claiming_a_tier) | bun `cmd_test` | bun-crucible.py cmd_test (_start_run) |
| tests/client/test_client_tier_stamping.py | :1065, :1089 (ESCALATION 3) | the first is `_start_run`, the second is `_ingest_parsed` | bun-crucible.py _start_run / _ingest_parsed |
| tests/client/test_client_tier_stamping.py | :1065, :1089 (header census) | bun `cmd_test` (`/runs/start`, `/runs/parsed`) | bun-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | :1065/:1089, :1252 (BunUnearnedTierTest docstring) | `cmd_test` (its `_start_run` and `_ingest_parsed` calls) and `cmd_auto_ingest` | bun-crucible.py cmd_test / cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :1085 (header census) | rust `cmd_test` | rust-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | :1085 (test_rust_test_ingests_the_nextest_run_without_claiming_a_tier) | rust `cmd_test` | rust-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | :1085, :793 (RustUnearnedTierTest docstring) | `cmd_test` and `cmd_auto_ingest` | rust-crucible.py cmd_test / cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :1089 (test_bun_test_ingests_the_run_without_claiming_a_tier) | bun `cmd_test`'s `_ingest_parsed` call | bun-crucible.py cmd_test (_ingest_parsed) |
| tests/client/test_client_tier_stamping.py | :1097 (MvnEarnedTierTest docstring) | `e2e` (`cmd_e2e`) | mvn-crucible.py cmd_e2e |
| tests/client/test_client_tier_stamping.py | :1175/:1219 (BunEarnedTierTest docstring) | bun `regression` (`cmd_regression`, both its calls) | bun-crucible.py cmd_regression |
| tests/client/test_client_tier_stamping.py | :1226 (MvnEarnedTierTest docstring) | `regression` (`_regression_run`) | mvn-crucible.py _regression_run |
| tests/client/test_client_tier_stamping.py | :1252 (header census) | bun `cmd_auto_ingest` (`e2e`) | bun-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :1252 (test_bun_auto_ingest_ran_no_tests_so_it_claims_no_tier) | bun `cmd_auto_ingest` | bun-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :1270 (test_mvn_test_single_report_dir_claims_no_tier) | mvn `cmd_test` | mvn-crucible.py cmd_test (/runs) |
| tests/client/test_client_tier_stamping.py | :1270, :1276 (header census) | mvn `cmd_test` (`/runs`, `/runs/parsed`) | mvn-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | :1270/:1276, :1339/:1346 (MvnUnearnedTierTest docstring) | `cmd_test` (its `/runs` and `/runs/parsed` calls) and `cmd_auto_ingest` (the same two) | mvn-crucible.py cmd_test / cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :1276 (test_mvn_test_many_report_dirs_claims_no_tier) | mvn `cmd_test` | mvn-crucible.py cmd_test (/runs/parsed) |
| tests/client/test_client_tier_stamping.py | :1339 (test_mvn_auto_ingest_single_report_dir_claims_no_tier) | mvn `cmd_auto_ingest`'s `/runs` call | mvn-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :1339, :1346 (header census) | mvn `cmd_auto_ingest` (`/runs`, `/runs/parsed`) | mvn-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :1346 (ESCALATION 1) | mvn `cmd_auto_ingest`'s `/runs/parsed` call | mvn-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :1346 (test_mvn_auto_ingest_coverage_path_claims_no_tier) | mvn `cmd_auto_ingest`'s `/runs/parsed` call | mvn-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :686 (test_python_test_ingests_the_run_without_claiming_a_tier) | python `cmd_test`'s `/runs/parsed` call | python-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | :686, :696 (header census) | python `cmd_test` (`/runs/parsed`, `/runs/compile`) | python-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | :686/:696, :854 (PythonUnearnedTierTest docstring) | `cmd_test` (its `/runs/parsed` and `/runs/compile` calls) and `cmd_auto_ingest` | python-crucible.py cmd_test / cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :696 (test_python_test_collection_failure_claims_no_tier) | python `cmd_test`'s `/runs/compile` call | python-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | :793 (header census) | rust `cmd_auto_ingest` | rust-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :793 (test_rust_auto_ingest_ran_no_tests_so_it_claims_no_tier) | rust `cmd_auto_ingest` | rust-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :817 (PythonEarnedTierTest docstring) | python `_regression_run` | python-crucible.py _regression_run |
| tests/client/test_client_tier_stamping.py | :854 (header census) | python `cmd_auto_ingest` | python-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | :854 (test_python_auto_ingest_ran_no_tests_so_it_claims_no_tier) | python `cmd_auto_ingest` | python-crucible.py cmd_auto_ingest |
| tests/client/test_client_tier_stamping.py | arduino-crucible.py:366 | `_ingest_compile` in `arduino-crucible.py` | arduino-crucible.py _ingest_compile |
| tests/client/test_client_tier_stamping.py | python-crucible.py:696 (ESCALATION 2) | `cmd_test` in `python-crucible.py` | python-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | python-crucible.py:696 (header RED list) | `cmd_test` in `python-crucible.py` | python-crucible.py cmd_test (no-XML compile fallback) |
| tests/client/test_client_tier_stamping.py | python-crucible.py:696 (test_python_test_ingests_a_collection_failure_as_compile_with_no_tier) | `cmd_test` in `python-crucible.py` | python-crucible.py cmd_test |
| tests/client/test_client_tier_stamping.py | python-crucible.py:799 (ESCALATION 2) | `_regression_run` in `python-crucible.py` | python-crucible.py _regression_run |
| tests/client/test_client_tier_stamping.py | python-crucible.py:799 (header RED list) | `_regression_run` in `python-crucible.py` | python-crucible.py _regression_run (no-XML fallback) |
| tests/client/test_client_tier_stamping.py | python-crucible.py:799 (test_python_regression_ingests_a_collection_failure_as_compile_with_no_tier) | `_regression_run` in `python-crucible.py` | python-crucible.py _regression_run |
| tests/client/test_client_tier_surface.py | :3368 | — (removed) | add_cr_depends_verb already named |
| tests/client/test_client_tier_surface.py | :3406 | — (removed) | add_roadmap_verbs already named |
| tests/client/test_client_tier_surface.py | :3501 | — (removed) | add_next_verb already named |
| tests/client/test_client_tier_surface.py | :3545 | — (removed) | add_queue_file_verb already named |
| tests/client/test_client_tier_surface.py | clients/_crucible_axi.py:1434 | `canonical_track` (`clients/_crucible_axi.py`) | canonical_track |
| tests/client/test_client_tier_surface.py | clients/_crucible_axi.py:621 | `HELP_STEPS` (`clients/_crucible_axi.py`) | HELP_STEPS |
| tests/client/test_client_tier_surface.py | src/store.ts:362-365 | `normalizeTrack` (`src/store.ts`) | normalizeTrack |
| tests/client/test_cr017_client_lifecycle.py | src/store.ts:1911 | `recordTestEvent` in `src/store.ts` | recordTestEvent (tier ?? "unit" default) |
| tests/client/test_cr022_points_declaration.py | _crucible_axi.py:3831-3866 | `cmd_cr_plan` (`clients/_crucible_axi.py`) | `cmd_cr_plan` |
| tests/client/test_cr022_points_declaration.py | _crucible_axi.py:4199-4214 | `add_roadmap_verbs` in `clients/_crucible_axi.py` | `add_roadmap_verbs` — its `cr-plan` subparser |
| tests/client/test_cr022_points_declaration.py | _crucible_axi.py:4204-4214 | the `cr-plan` block of `add_roadmap_verbs` in `clients/_crucible_axi.py` | `add_roadmap_verbs` — the `cr-plan` subparser's argument declarations |
| tests/client/test_cr040_coverage_tooling.py | :1440 | the pre-merge-gate subparser built in `main` | main (pre-merge-gate subparser) |
| tests/client/test_cr040_coverage_tooling.py | `coverage` (coverage.py) | the `coverage` package (coverage.py) | coverage.py is the library name, not a repo file (module docstring) |
| tests/client/test_cr040_coverage_tooling.py | `coverage` (coverage.py) | the `coverage` package (coverage.py) | coverage.py is the library name, not a repo file (CoverageDevDependencyTest docstring) |
| tests/client/test_cr040_coverage_tooling.py | python-crucible.py:1410 | `_add_regression_tier_args` in clients/python-crucible.py | _add_regression_tier_args (regression flags) |
| tests/client/test_cr046_uv_env_gate.py | crucible_axi/manifest.py:43 | `build_manifest` (crucible_axi/manifest.py) | `build_manifest` — its `clients` path map |
| tests/client/test_cr051_rust_files_count.py | :1306 | — (removed) | quoted stale spec line number; the site is named by symbol just below as SITE 2, `_workspace_regression_run` |
| tests/client/test_cr051_rust_files_count.py | clients/rust-crucible.py:321-322 | `_emit_ingest_axi` in clients/rust-crucible.py | `_emit_ingest_axi` — its hardcoded `run` dict (module docstring) |
| tests/client/test_cr051_rust_files_count.py | clients/rust-crucible.py:321-322 | `_emit_ingest_axi` in clients/rust-crucible.py | `_emit_ingest_axi` — its hardcoded `run` dict (SITE 3 section comment) |
| tests/client/test_cr051_rust_files_count.py | rust-crucible.py:762 | — (removed) | quoted stale spec line number; the site is named by symbol just below as SITE 1, `_regression_ingest_run` |
| tests/client/test_cr054_axi_context_lift.py | arduino-crucible.py:207, bun-crucible.py:861, mvn-crucible.py:265, python-crucible.py:235, rust-crucible.py:266 | the `_run_context` in each of arduino-, bun-, mvn-, python- and rust-crucible.py | _run_context (per client) |
| tests/client/test_cr054_axi_context_lift.py | arduino-crucible.py:248, bun-crucible.py:1556, mvn-crucible.py:306, python-crucible.py:388, rust-crucible.py:307 | the `_plans_path` in each of the five clients | _plans_path (per client) |
| tests/client/test_cr054_axi_context_lift.py | arduino-crucible.py:252, bun-crucible.py:1563, mvn-crucible.py:310, python-crucible.py:392, rust-crucible.py:311 | the `_open_plans` in each of the five clients | _open_plans (per client) |
| tests/client/test_cr054_axi_context_lift.py | arduino-crucible.py:845, bun-crucible.py:1650, mvn-crucible.py:1386, python-crucible.py:1047, rust-crucible.py:1712 | the `_resolve_plan_or_emit` in each of the five clients | _resolve_plan_or_emit (per client) |
| tests/client/test_cr054_drift_guard.py | :900 (/:1396/:1523) | consumed by `_regression_ingest_run`, `_smoke_test` and `_workspace_regression_run` | the three _no_junit_help call sites |
| tests/client/test_cr054_drift_guard.py | :900 (/:1396/:1523) | rust's no-junit exits | assertion failure message (f-string, not compared) |
| tests/client/test_cr054_drift_guard.py | mvn-crucible.py:894-909 | `_emit_compile_fallback_axi` (`mvn-crucible.py`) | _emit_compile_fallback_axi |
| tests/client/test_cr054_drift_guard.py | mvn-crucible.py:905 | `_emit_compile_fallback_axi` in `mvn-crucible.py` | _emit_compile_fallback_axi (inlined no-test-reports code) |
| tests/client/test_cr054_drift_guard.py | rust-crucible.py:360 | (`rust-crucible.py`, consumed by `_regression_ingest_run`, `_smoke_test` and `_workspace_regression_run`) | _no_junit_help (gone per AC3; historical subject, callers named) |
| tests/client/test_cr054_http_core_lift.py | arduino-crucible.py:143 | `_request` in arduino-crucible.py | _request (test_request_transport_call_moves_out_of_every_client_and_still_works docstring) |
| tests/client/test_cr054_http_core_lift.py | bun-crucible.py:162 | `_request` in bun-crucible.py | _request (test_request_transport_call_moves_out_of_every_client_and_still_works docstring) |
| tests/client/test_cr054_http_core_lift.py | bun-crucible.py:162 | `_request` in bun-crucible.py | _request (RequestToleratesEmptyResponseBodyDriftCorrectionTest docstring; rust ~199 / mvn ~203 approximations folded in) |
| tests/client/test_cr054_http_core_lift.py | mvn-crucible.py:203 | `_request` in mvn-crucible.py | _request (test_request_transport_call_moves_out_of_every_client_and_still_works docstring) |
| tests/client/test_cr054_http_core_lift.py | python-crucible.py:170 | `_request` in python-crucible.py | _request (test_request_transport_call_moves_out_of_every_client_and_still_works docstring) |
| tests/client/test_cr054_http_core_lift.py | python-crucible.py:170 | `_request` in python-crucible.py | _request (RequestToleratesEmptyResponseBodyDriftCorrectionTest docstring; rust ~199 / mvn ~203 approximations folded in) |
| tests/client/test_cr054_http_core_lift.py | rust-crucible.py:199 | `_request` in rust-crucible.py | _request (test_request_transport_call_moves_out_of_every_client_and_still_works docstring) |
| tests/client/test_cr054_verb_surface_lift.py | clients/_crucible_axi.py:2564 | `cmd_cycle_add` in clients/_crucible_axi.py | cmd_cycle_add (its cycle-append POST) |
| tests/client/test_cr066_serve_and_target_dir.py | cli.py:337 | `main` in `crucible_axi/cli.py` | main (_COMMANDS dispatch) |
| tests/client/test_cr066_serve_and_target_dir.py | cli.py:42 | also in `_build_parser` | _build_parser (install subparser) |
| tests/client/test_cr066_serve_and_target_dir.py | cli.py:45 | `_build_parser`'s `install` subparser | _build_parser (install --target-dir default) |
| tests/client/test_cr066_serve_and_target_dir.py | cli.py:67 | `p_serve = sub.add_parser(` in `_build_parser` | _build_parser (serve subparser) |
| tests/client/test_cr070_systemd_unit.py | cli.py:292 | `cmd_serve` in `crucible_axi/cli.py` | cmd_serve |
| tests/client/test_cr070_systemd_unit.py | install.py:132 | the comment over `SERVER_HOST_ENV_VAR` in `crucible_axi/install.py` | SERVER_HOST_ENV_VAR (serve child-env comment) |
| tests/client/test_cr070_systemd_unit.py | install.py:668 | `server_launch_argv` in `crucible_axi/install.py` | server_launch_argv |
| tests/client/test_cr084_release_packages.py | :1757-1767 | `cmd_milestone` (`clients/_crucible_axi.py`) | cmd_milestone |
| tests/client/test_cr084_release_packages.py | :2003 | `post_milestone` (both in `clients/_crucible_axi.py`) | post_milestone |
| tests/client/test_cr084_release_packages.py | clients/_crucible_axi.py:1729 | `cmd_milestone` (both in `clients/_crucible_axi.py`) | cmd_milestone |
| tests/client/test_cr084_release_packages.py | clients/_crucible_axi.py:1761-1762 | the `refuse_repair` call in `clients/_crucible_axi.py` | cmd_milestone -> refuse_repair |
| tests/client/test_cr084_release_packages.py | clients/_crucible_axi.py:1806 | the refusal guard in `cmd_milestone` in `clients/_crucible_axi.py` | cmd_milestone (repair refusal guard) |
| tests/client/test_cr084_release_packages.py | clients/_crucible_axi.py:2003-2005 | `post_milestone` (clients/_crucible_axi.py) | post_milestone (signature) |
| tests/client/test_cr084_release_packages.py | scripts/release.sh:742-744 | `cmd_backfill_releases` (`scripts/release.sh`) | cmd_backfill_releases (recorded tally) |
| tests/client/test_cr084_release_packages.py | src/store.ts:1831-1835 | `offeredNothing` early return in `repairReleaseProvenance` (`src/store.ts`) | repairReleaseProvenance (offeredNothing return) |
| tests/client/test_cr084_release_packages.py | src/store.ts:1831-1835 | `offeredNothing` inside `repairReleaseProvenance` in src/store.ts | repairReleaseProvenance (offeredNothing return) |
| tests/client/test_cr087_console_failure_attribution.py | clients/bun-crucible.py:656-676 | documented over `_FAIL_LINE` in clients/bun-crucible.py | _FAIL_LINE (wire-form comment block) |
| tests/client/test_cr087_console_failure_attribution.py | clients/bun-crucible.py:656-676 | `_FAIL_LINE` in clients/bun-crucible.py | _FAIL_LINE (wire-form comment block) |
| tests/client/test_cr088_failure_detail_names_its_leaf.py | clients/bun-crucible.py:656-676 | `_FAIL_LINE` in clients/bun-crucible.py | the result-line wire-form comment above `_FAIL_LINE` (docstring WIRE FORMS) |
| tests/client/test_cr088_failure_detail_names_its_leaf.py | clients/bun-crucible.py:656-676 | `_FAIL_LINE` in clients/bun-crucible.py | the result-line wire-form comment above `_FAIL_LINE` (`WIRE_FORMS` comment) |
| tests/client/test_cr088_failure_detail_names_its_leaf.py | clients/bun-crucible.py:702-715 | `_ECHO_CARET` in clients/bun-crucible.py | `_ECHO_TEST_DECL` / `_ECHO_CARET` (constants) |
| tests/client/test_cr088_failure_detail_names_its_leaf.py | clients/bun-crucible.py:765 | `_parse_console_failures` (clients/bun-crucible.py) | `_parse_console_failures` — its `window` local (GAP 3) |
| tests/client/test_cr088_failure_detail_names_its_leaf.py | clients/bun-crucible.py:765 | `_parse_console_failures` in clients/bun-crucible.py | `_parse_console_failures` — `window` and its declaration-match branch (ShapedDeclaration…Test) |
| tests/client/test_cr088_failure_detail_names_its_leaf.py | clients/bun-crucible.py:781-782 | `_parse_console_failures` (clients/bun-crucible.py) | `_parse_console_failures` — its two `details` writes (GAP 2) |
| tests/client/test_cr088_failure_detail_names_its_leaf.py | clients/bun-crucible.py:781-782 | `_parse_console_failures` (clients/bun-crucible.py) | `_parse_console_failures` — its two `details` writes (NestedDescribeAttributionTest) |
| tests/client/test_cr088_failure_detail_names_its_leaf.py | clients/bun-crucible.py:818-835 | `_marry_failures` in clients/bun-crucible.py | `_marry_failures` |
| tests/client/test_cr090_cli_install_integration.py | toon.py:289 | `_extract_tabular_fields` (toon.py) | _extract_tabular_fields |
| tests/client/test_cr091_roadmap_verbs.py | clients/python-crucible.py:1100-1104 | `cmd_queue_file` in `clients/python-crucible.py` | cmd_queue_file (thin delegator) |
| tests/client/test_cr092_next_decision_resolver.py | src/store.ts:362-365 | `normalizeTrack` (src/store.ts) | normalizeTrack |
| tests/client/test_cr092_next_decision_resolver.py | src/store.ts:393 | `declaredTracks` in src/store.ts | declaredTracks |
| tests/client/test_cr095_next_consumes_published_order.py | :1301-1308 | — (removed) | _lane_order deleted with the S4 boundary retirement; construct still named in prose, location dropped |
| tests/client/test_cr095_next_consumes_published_order.py | :1336 | — (removed) | LaneOrderTest deleted with the S4 boundary retirement; test still named in prose, location dropped |
| tests/client/test_cr095_next_consumes_published_order.py | clients/_crucible_axi.py:1510 | — (removed) | resolve_next deleted with the S4 boundary retirement (resolver moved server-side); construct still named in prose, location dropped |
| tests/client/test_cr095_next_consumes_published_order.py | tests/client/test_cr092_next_decision_resolver.py:1324 | — (removed) | LaneOrderTest deleted with the S4 boundary retirement; test still named in prose, location dropped |
| tests/client/test_cr097_cr_help_namespace_neutral.py | arduino-crucible.py:1079 | `main` of `arduino-crucible.py` (plan-file --cr help) | main -> plan-file --cr help |
| tests/client/test_cr097_cr_help_namespace_neutral.py | bun-crucible.py:2330 | `main` of `bun-crucible.py` (plan-file --cr help) | main -> plan-file --cr help |
| tests/client/test_cr097_cr_help_namespace_neutral.py | mvn-crucible.py:1896 | `main` of `mvn-crucible.py` (plan-file --cr help) | main -> plan-file --cr help |
| tests/client/test_cr097_cr_help_namespace_neutral.py | python-crucible.py:1352 | `main` of `python-crucible.py` (plan-file --cr help) | main -> plan-file --cr help |
| tests/client/test_cr097_cr_help_namespace_neutral.py | rust-crucible.py:2413 | `main` in `rust-crucible.py` | main -> plan-file --cr help |
| tests/client/test_cr098_next_start_template_survives_the_move.py | clients/_crucible_axi.py:2392-2402 | `_next_start_help` (in clients/_crucible_axi.py at 7f2a85c) | _next_start_help (deleted; line dropped, function already named) |
| tests/client/test_cr098_next_start_template_survives_the_move.py | src/hints.ts:503-510 | the `start` entry of `nextHints` (src/hints.ts) | nextHints.start |
| tests/client/test_cr098_next_verb_reads_the_route.py | :2392-2396 | that same `cmd_next` | cmd_next (its GET .../next) |
| tests/client/test_cr098_next_verb_reads_the_route.py | clients/_crucible_axi.py:2924-2925 | `cmd_next` in clients/_crucible_axi.py (at 7f2a85c) | cmd_next (its GET .../queue) |
| tests/client/test_cr098_next_verb_reads_the_route.py | src/v2.ts:192 | `fail` in src/v2.ts | fail |
| tests/client/test_cr098_s4_boundary_retirement_pending.py | test_cr092_next_decision_resolver.py :541-546 | `test_the_server_refuses_exactly_what_the_helper_refuses` in test_cr092_next_decision_resolver.py (the note just above it) | the deletion-note comment in TrackCanonicalisationAgreesWithTheServerTest |
| tests/client/test_cr128_flag_help_census.py | python-crucible.py:1524 | python's `auto-ingest` `--agent` | python-crucible auto-ingest --agent declaration |
| tests/client/test_cr128_flag_help_census.py | tests/project-namespace-tripwire.test.ts:504 (x2) | `PRE_CR_ASSERTION_RESIDUE` in `tests/project-namespace-tripwire.test.ts` | PRE_CR_ASSERTION_RESIDUE |
| tests/client/test_cr139_installer_writes_the_connection.py | crucible_axi/install.py:1546-1589 | `_operator_config_is_untouched` (crucible_axi/install.py) | _operator_config_is_untouched |
| tests/client/test_cr139_installer_writes_the_connection.py | install.py:1091-1114 | `_unit_environment()` (crucible_axi/install.py) | _unit_environment |
| tests/client/test_cr139_installer_writes_the_connection.py | install.py:1091-1114 | `_unit_environment()` (crucible_axi/install.py) | _unit_environment |
| tests/client/test_crucible_axi_shared.py | :360 | `_no_junit_help` (in rust-crucible.py until the C1 re-point onto `no_report_help`) | _no_junit_help (gone; successor no_report_help) |
| tests/client/test_crucible_axi_shared.py | :722-740 | `gate_step_abort_help` / `gate_step_abort_warning` (already named; line dropped) | gate_step_abort_help, gate_step_abort_warning (_crucible_axi.py) |
| tests/client/test_crucible_axi_shared.py | :894-909 | `_emit_compile_fallback_axi` in mvn-crucible.py | _emit_compile_fallback_axi |
| tests/client/test_crucible_axi_shared.py | clients/_crucible_axi.py:2107 | `cmd_status` in clients/_crucible_axi.py | cmd_status |
| tests/client/test_cycle_add_targets_the_plan_it_means.py | :2450-2451 | `cmd_cycle_add` (`clients/_crucible_axi.py`) | `cmd_cycle_add` — its POST body |
| tests/client/test_cycle_add_targets_the_plan_it_means.py | :2480-2496 | `cmd_cr_close` (`clients/_crucible_axi.py`) | `cmd_cr_close` |
| tests/client/test_cycle_add_targets_the_plan_it_means.py | :387-392 | `resolve_plan_or_emit` (`clients/_crucible_axi.py`) | `resolve_plan_or_emit` — its ambiguity branch |
| tests/client/test_cycle_add_targets_the_plan_it_means.py | clients/_crucible_axi.py:246-270 | `resolve_single_plan` (`clients/_crucible_axi.py`) | `resolve_single_plan` |
| tests/client/test_cycle_add_targets_the_plan_it_means.py | src/v2.ts:1359-1375 | `parseCycleInput` (`src/v2.ts`) | `parseCycleInput` |
| tests/client/test_cycle_add_targets_the_plan_it_means.py | src/v2.ts:1366-1369 | `parseCycleInput` in src/v2.ts | `parseCycleInput` — its omitted-kind default branch |
| tests/client/test_cycle_add_targets_the_plan_it_means.py | src/v2.ts:1370 | `CYCLE_KINDS` in src/v2.ts | `CYCLE_KINDS` — the kind set `parseCycleInput` validates against |
| tests/client/test_declared_target_report_mechanism.py | :479 | `_bun_run_script_cmd` (`clients/bun-crucible.py`) | `_bun_run_script_cmd` — its docstring |
| tests/client/test_declared_target_report_mechanism.py | clients/_crucible_axi.py:1365 | both in `clients/_crucible_axi.py` (the helpers named just before) | `no_report_help` and `no_report_warning` (the `,1384` second line number removed with it) |
| tests/client/test_gate_multi_suite_coverage.py | clients/bun-crucible.py:1033 | `_start_run` in `clients/bun-crucible.py` | `_start_run` — its `"stack": _STACK` payload key (class docstring) |
| tests/client/test_gate_multi_suite_coverage.py | clients/bun-crucible.py:1033 | `_start_run` in `clients/bun-crucible.py` | `_start_run` — its `"stack": _STACK` payload key (BUN_STACK comment) |
| tests/client/test_gate_multi_suite_coverage.py | src/v2.ts:713 | `runMeta` in `src/v2.ts` | `runMeta` — the {tier, stack, context} run meta |
| tests/client/test_gate_suite_outcome_reporting.py | _crucible_axi.py:4267 (x2) | `subprocess.run` in `run_gate_suites` (`_crucible_axi.py`) | run_gate_suites dispatch subprocess.run |
| tests/client/test_gate_suite_outcome_reporting.py | bun-crucible.py:310 (x2) | `_run_logged` in `bun-crucible.py` | _run_logged |
| tests/client/test_mvn_crucible_agent_identity_required.py | clients/_crucible_axi.py:71-73 / :373-375 | `axi_context` and `fleet_context` in `clients/_crucible_axi.py` | axi_context / fleet_context WORKFLOW_ROLE->track |
| tests/client/test_mvn_crucible_axi.py | mvn-crucible.py:1565 | `cmd_gate_run` in clients/mvn-crucible.py | `cmd_gate_run` |
| tests/client/test_mvn_crucible_role_flag_required.py | mvn-crucible.py:1744 | the `register` subparser's `--role` in `main` (mvn-crucible.py) | main (register --role argument) |
| tests/client/test_open_run_warning_names_the_limit.py | clients/bun-crucible.py:956 | module comment above `NO_LIFECYCLE_ENV` in clients/bun-crucible.py | the run-lifecycle module comment preceding NO_LIFECYCLE_ENV |
| tests/client/test_open_run_warning_names_the_limit.py | clients/bun-crucible.py:992 | `_run_left_open_warning` (clients/bun-crucible.py) | _run_left_open_warning |
| tests/client/test_plan_file_cycle_flag_help.py | clients/_crucible_axi.py:1481-1490 | `clients/_crucible_axi.py` at `a7fe101` | `_next_start_help` — removed since (its CR's AC10); the RED-phase claim is pinned to the commit it was measured at |
| tests/client/test_plan_file_cycle_flag_help.py | clients/bun-crucible.py:2179-2201 | `_CLI_DESCRIPTION` in `clients/bun-crucible.py` | the "deliberately NOT `__doc__`" comment above `_CLI_DESCRIPTION` |
| tests/client/test_plan_file_cycle_flag_help.py | clients/bun-crucible.py:2336 | `main` (`clients/bun-crucible.py`) | the `plan-file` subparser's `--cycles` argument in `main` |
| tests/client/test_plan_file_cycle_flag_help.py | clients/bun-crucible.py:34 | `clients/bun-crucible.py`'s own module docstring | the module docstring's verb table (`plan-file` row) |
| tests/client/test_plan_file_declares_each_cycle_kind.py | :1551 | — (removed) | handleCycleAppend already named |
| tests/client/test_plan_file_declares_each_cycle_kind.py | :1855-1856 | `nextHints` in `src/hints.ts`, its `start` builder | _next_start_help (removed from client; successor nextHints.start) |
| tests/client/test_plan_file_declares_each_cycle_kind.py | clients/_crucible_axi.py:1241-1242 | `CYCLE_FLAG_TEMPLATE` (`clients/_crucible_axi.py`) | CYCLE_FLAG_TEMPLATE |
| tests/client/test_plan_file_declares_each_cycle_kind.py | src/v2.ts:1337 | `CYCLE_KINDS` (src/v2.ts) | CYCLE_KINDS |
| tests/client/test_plan_file_declares_each_cycle_kind.py | src/v2.ts:1359 | (`src/v2.ts`, …) after `parseCycleInput` | parseCycleInput (already named) |
| tests/client/test_plan_file_declares_each_cycle_kind.py | src/v2.ts:1368-1369 | `parseCycleInput` in `src/v2.ts` | parseCycleInput (omitted-kind default) |
| tests/client/test_plan_file_declares_each_cycle_kind.py | src/v2.ts:1368-1369 | `parseCycleInput` in src/v2.ts | parseCycleInput (assertion failure message) |
| tests/client/test_plan_file_declares_each_cycle_kind.py | test_bun_crucible_axi_conventions.py:508 | in `test_bun_crucible_axi_conventions.py` | test_plan_file_help_suggests_the_cycle_activate_placeholder_template (already named in the sentence) |
| tests/client/test_plan_file_names_the_release_it_plans.py | clients/_crucible_axi.py:2760 | `cmd_plan_file` in `clients/_crucible_axi.py` | cmd_plan_file payload |
| tests/client/test_python_crucible_agent_identity_required.py | :373-375 | `fleet_context` in `clients/_crucible_axi.py` | fleet_context (WORKFLOW_ROLE -> track) |
| tests/client/test_python_crucible_agent_identity_required.py | clients/_crucible_axi.py:71-73 | `axi_context` (in `clients/_crucible_axi.py`) | axi_context (WORKFLOW_ROLE -> track) |
| tests/client/test_python_crucible_axi.py | python-crucible.py:1188 | `cmd_gate_run` in python-crucible.py | cmd_gate_run |
| tests/client/test_python_crucible_axi.py | python-crucible.py:279-287 | `_run_logged` (python-crucible.py) | _run_logged |
| tests/client/test_python_crucible_role_flag_required.py | python-crucible.py:1413 | the `register` subparser's `--role` in `main` (`python-crucible.py`) | main (register subparser --role argument) |
| tests/client/test_queue_reads_merged_crs_by_type.py | :1674 | (module-level constant) | QUEUE_EVENTS_LIMIT (since deleted by this CR; snippet annotation) |
| tests/client/test_queue_reads_merged_crs_by_type.py | :1692 | — (removed) | annotation on the `def cr_merged_crs` line itself; the snippet names the construct |
| tests/client/test_queue_reads_merged_crs_by_type.py | :1738 | (in `cmd_queue`) | cmd_queue (events fetch) |
| tests/client/test_queue_rows_carry_title_and_lifecycle.py | clients/_crucible_axi.py:2168 | `build_queue_rows` (clients/_crucible_axi.py) | `build_queue_rows` |
| tests/client/test_queue_rows_carry_title_and_lifecycle.py | clients/_crucible_axi.py:2168-2176 | `build_queue_rows` in `clients/_crucible_axi.py` | `build_queue_rows` — its per-row dict |
| tests/client/test_rust_crucible_agent_identity_required.py | clients/_crucible_axi.py:71-73 / :373-375 | `axi_context` and `fleet_context` in `clients/_crucible_axi.py` | axi_context / fleet_context WORKFLOW_ROLE->track |
| tests/client/test_rust_crucible_axi.py | rust-crucible.py:1905 | `cmd_gate_run` in rust-crucible.py | cmd_gate_run |
| tests/client/test_rust_crucible_role_flag_required.py | rust-crucible.py:2058 | `main` (clients/rust-crucible.py) | the `register` subparser's `--role` argument in `main` |
| tests/client/test_shared_module_envelope_gaps.py | clients/rust-crucible.py:1563 | `_resolve_plan_or_emit` in clients/rust-crucible.py | _resolve_plan_or_emit |
| tests/client/test_shipped_limits_ship_as_package_data.py | clients/_crucible_axi.py:120 | `_SHIPPED_LIMITS` (in clients/_crucible_axi.py, since retired for the package data `shipped_limits` reads) | _SHIPPED_LIMITS gone; successor shipped_limits |
| tests/client/test_toolchain_verb_envelopes.py | :1327 | `cmd_docker_e2e_gate` wraps `_smoke_test` | cmd_docker_e2e_gate |
| tests/client/test_toolchain_verb_envelopes.py | :1331 | the `_disk_guard` call in `_smoke_test` | _smoke_test (_disk_guard call) |
| tests/client/test_toolchain_verb_envelopes.py | clients/_crucible_axi.py:746 | `_last_non_empty_line` (clients/_crucible_axi.py) | _last_non_empty_line |
| tests/client/test_toolchain_verb_envelopes.py | clients/_crucible_axi.py:801-804 | the no-cause branch of `no_report_warning` in clients/_crucible_axi.py | no_report_warning (no-cause branch) |
| tests/client/test_toolchain_verb_envelopes.py | mvn-crucible.py:812 | `_compile_fallback` in mvn-crucible.py | _compile_fallback |
| tests/client/test_toolchain_verb_envelopes.py | mvn-crucible.py:894 | `_emit_compile_fallback_axi` in mvn-crucible.py | _emit_compile_fallback_axi |
| tests/client/test_toolchain_verb_envelopes.py | mvn-crucible.py:911 | read directly in that function's body | _emit_compile_fallback_axi (no_report_warning call) |
| tests/client/test_toolchain_verb_envelopes.py | rust-crucible.py:2180 | `main` in `rust-crucible.py` (docker-e2e-gate `--min-free-g` default) | main -> docker-e2e-gate --min-free-g default=80 |
| tests/clients-bun-crucible.test.ts | bun-crucible.py:907-913 | `_ingest_parsed` in bun-crucible.py | _ingest_parsed ingest: stderr print |
| tests/clients-bun-crucible.test.ts | clients/bun-crucible.py:137 | `_resolve_bun` in clients/bun-crucible.py | _resolve_bun |
| tests/clients-bun-crucible.test.ts | clients/bun-crucible.py:577 | `_parse_junit_file` (clients/bun-crucible.py) | _parse_junit_file |
| tests/clients-bun-crucible.test.ts | mvn-crucible.py:641 | `_parse_junit` in `mvn-crucible.py` | _parse_junit <skipped> branch |
| tests/clients-narration.test.ts | :1316 | `cmd_regression` in clients/bun-crucible.py | cmd_regression (env.pop of quieting vars) |
| tests/clients-narration.test.ts | clients/bun-crucible.py:1177 | `cmd_test` in clients/bun-crucible.py | cmd_test (env.pop of quieting vars) |
| tests/clients-narration.test.ts | clients/bun-crucible.py:1177 | `cmd_test` (clients/bun-crucible.py) | cmd_test agent-quieting env.pop |
| tests/clients-narration.test.ts | clients/bun-crucible.py:1316 | `cmd_regression` (clients/bun-crucible.py) | cmd_regression agent-quieting env.pop |
| tests/clients-narration.test.ts | v2.ts:1059 | `handleV2` (src/v2.ts) | handleV2 (register/heartbeat route dispatch) |
| tests/clients-narration.test.ts | v2.ts:296 | `handleAgentTouch` (src/v2.ts) | handleAgentTouch |
| tests/clients-narration.test.ts | v2.ts:306-323 | `handleAgentTouch` in src/v2.ts | handleAgentTouch (existed / recordLifecycleEvent) |
| tests/clients-narration.test.ts | v2.ts:891 | `eventBrief` (src/v2.ts) | eventBrief |
| tests/clients-narration.test.ts | v2.ts:931 | `handleEventsList` (src/v2.ts) | handleEventsList |
| tests/clients-python-arduino-crucible.test.ts | arduino-crucible.py:300-314 | `_emit_ingest_summary_axi` (arduino-crucible.py) | _emit_ingest_summary_axi |
| tests/clients-python-arduino-crucible.test.ts | arduino-crucible.py:335-357 | `_parse_junit` (arduino-crucible.py) | _parse_junit |
| tests/clients-python-arduino-crucible.test.ts | arduino-crucible.py:514 | `_run_native_tests_body` / `cmd_auto_ingest` (arduino-crucible.py) | _run_native_tests_body (2 prints), cmd_auto_ingest (1 print) |
| tests/clients-python-arduino-crucible.test.ts | arduino-crucible.py:514 | `_run_native_tests_body` in clients/arduino-crucible.py | _run_native_tests_body no-ingest report line |
| tests/clients-python-arduino-crucible.test.ts | arduino-crucible.py:537 | `_run_native_tests_body` (arduino-crucible.py) | _run_native_tests_body (--agent ingest path stderr line) |
| tests/clients-python-arduino-crucible.test.ts | arduino-crucible.py:537 | `_run_native_tests_body` in clients/arduino-crucible.py | _run_native_tests_body ingest report line |
| tests/clients-python-arduino-crucible.test.ts | arduino-crucible.py:638 | `cmd_auto_ingest` in clients/arduino-crucible.py | cmd_auto_ingest stderr line |
| tests/clients-python-arduino-crucible.test.ts | clients/arduino-crucible.py:571-609 | `cmd_auto_ingest` in clients/arduino-crucible.py | cmd_auto_ingest |
| tests/clients-python-arduino-crucible.test.ts | clients/python-crucible.py:583 | `_collect_coverage` in clients/python-crucible.py | _collect_coverage |
| tests/clients-python-arduino-crucible.test.ts | crucible.py:578-583 | `_ingest_parsed` ... (python-crucible.py) | _ingest_parsed (its stderr print) |
| tests/clients-python-arduino-crucible.test.ts | mvn-crucible.py:641 | `_parse_junit` in mvn-crucible.py | _parse_junit (mvn skipped branch) |
| tests/clients-python-arduino-crucible.test.ts | python-crucible.py:389-404 | `_emit_ingest_axi` (python-crucible.py) | _emit_ingest_axi |
| tests/clients-python-arduino-crucible.test.ts | python-crucible.py:484-520 | `_parse_junit_dir` (python-crucible.py) | _parse_junit_dir |
| tests/clients-python-arduino-crucible.test.ts | src/v2.ts:473 | `handleRunsCompile` in src/v2.ts | handleRunsCompile (empty-errors 400) |
| tests/clients-rust-mvn-crucible.test.ts | mvn-crucible.py:361-374 | `_emit_ingest_axi_resp` in mvn-crucible.py | _emit_ingest_axi_resp |
| tests/clients-rust-mvn-crucible.test.ts | mvn-crucible.py:377-392 | `_emit_ingest_summary_axi` in mvn-crucible.py | _emit_ingest_summary_axi |
| tests/clients-rust-mvn-crucible.test.ts | mvn-crucible.py:641 | `_parse_junit` (mvn-crucible.py) | _parse_junit |
| tests/clients-rust-mvn-crucible.test.ts | mvn-crucible.py:641 | `_parse_junit` (mvn-crucible.py) | _parse_junit (comment) |
| tests/clients-rust-mvn-crucible.test.ts | mvn-crucible.py:641 | `_parse_junit` in clients/mvn-crucible.py | _parse_junit |
| tests/clients-rust-mvn-crucible.test.ts | mvn-crucible.py:720-722 | printed by `_ingest_junit_dir` | _ingest_junit_dir (ingest junit stderr print) |
| tests/clients-rust-mvn-crucible.test.ts | mvn-crucible.py:720-722 | `_ingest_junit_dir` in mvn-crucible.py | _ingest_junit_dir (comment) |
| tests/clients-rust-mvn-crucible.test.ts | rust-crucible.py:1246-1307 | `_workspace_regression_run` (rust-crucible.py) | _workspace_regression_run |
| tests/clients-rust-mvn-crucible.test.ts | rust-crucible.py:362-377 | `_emit_ingest_axi` in rust-crucible.py | _emit_ingest_axi |
| tests/clients-rust-mvn-crucible.test.ts | rust-crucible.py:700-763 | `_regression_ingest_run` (rust-crucible.py) | _regression_ingest_run |
| tests/clients-rust-mvn-crucible.test.ts | rust-crucible.py:836-858 | `_ingest_junit_axi` in rust-crucible.py | _ingest_junit_axi |
| tests/clients-rust-mvn-crucible.test.ts | rust-crucible.py:852-855 | printed by `_ingest_junit_axi` itself | _ingest_junit_axi (ingest junit stderr print) |
| tests/clients-rust-mvn-crucible.test.ts | src/codecs/junit.ts:195-215 | `parseJunitPath` in src/codecs/junit.ts | parseJunitPath |
| tests/clients-rust-mvn-crucible.test.ts | v2.ts:378 | `runMeta()` (src/v2.ts) | runMeta |
| tests/coverage-click.test.ts | public/app.js:282-292 | `ProjectBadge` in public/app.js | ProjectBadge |
| tests/coverage-click.test.ts | public/app.js:600-613 | `CoverageMeter` in public/app.js | CoverageMeter |
| tests/coverage-trend-drilldown.test.ts | public/app.js:640 | `openDrillin` in public/app.js | openDrillin |
| tests/coverage-trend-geometry.test.ts | public/styles.css:321, :328 | — (removed) | the selectors .app-trend-bars/.app-trend-bar already named in the sentence |
| tests/coverage-trend-geometry.test.ts | public/styles.css:321-334 | the `.app-trend-bars` rule in public/styles.css | .app-trend-bars / .app-trend-bar rules |
| tests/coverage-trend-geometry.test.ts | tests/drill-in.test.ts:1575 | the comment heading its "F4 anatomy" block in tests/drill-in.test.ts | comment above describe("F4 anatomy — no border/outline highlight on tree rows (styles.css)") |
| tests/cr009-release-bundle.test.ts | :158 | `resolveListener` | resolveListener |
| tests/cr009-release-bundle.test.ts | :92/:15 | `PUBLIC_DIR` / `pkg` | PUBLIC_DIR and pkg (src/server.ts) |
| tests/cr009-release-bundle.test.ts | crucible_axi/cli.py:368-375 | `cmd_serve` in `crucible_axi/cli.py` | cmd_serve (--host/--port write) |
| tests/cr009-release-bundle.test.ts | crucible_axi/cli.py:368-375 | `cmd_serve` in `crucible_axi/cli.py` | cmd_serve |
| tests/cr009-release-bundle.test.ts | crucible_axi/install.py:559 | `write_listener_settings` in `crucible_axi/install.py` | write_listener_settings |
| tests/cr009-release-bundle.test.ts | install.sh:10 | install.sh's header comment (its stage summary) | install.sh header comment |
| tests/cr009-release-bundle.test.ts | install.sh:4/:16/:18-20 | install.sh's header comment (its usage lines and its hosting-URL NOTE) | install.sh header comment |
| tests/cr009-release-bundle.test.ts | pyproject.toml:33 | `raw-options` under `[tool.hatch.version]` in pyproject.toml | [tool.hatch.version] raw-options |
| tests/cr009-release-bundle.test.ts | src/server.ts:158 | `resolveListener` in `src/server.ts` | resolveListener (retired CRUCIBLE_PORT/HOST not read) |
| tests/cr009-release-bundle.test.ts | src/server.ts:158 | `resolveListener` in `src/server.ts` | resolveListener |
| tests/cr022-analytics-ui.test.ts | :966-1013 | storyboard frame F14¾ (in .lavish/crucible-v2-design.html) | storyboard frame F14¾ |
| tests/cr022-analytics-ui.test.ts | lavish/crucible-v2-design.html:1204-1330 | storyboard frame F16 (in .lavish/crucible-v2-design.html) | storyboard frame F16 |
| tests/cr022-story-points.test.ts | src/store.ts:352-357 | `QueuePlanInput` (src/store.ts) | QueuePlanInput |
| tests/cr022-story-points.test.ts | src/store.ts:5542-5620 | `upsertQueueEntry` (src/store.ts) | Store.upsertQueueEntry |
| tests/cr022-story-points.test.ts | src/types.ts:437-462 | `QueueEntry` (src/types.ts) | QueueEntry |
| tests/cr022-story-points.test.ts | src/v2.ts:2959-3042 | `handleCrPlan` (src/v2.ts) | handleCrPlan |
| tests/cr072-installer-upgrade.test.ts | cr009-release-bundle.test.ts:209 | its test "install.sh implements the §S1 uv → crucible-axi flow" (tests/cr009-release-bundle.test.ts) | test "install.sh implements the §S1 uv → crucible-axi flow" |
| tests/cross-surface-400s.test.ts | src/v2.ts:223 | `handleAgentTouch` (src/v2.ts) | handleAgentTouch |
| tests/cross-surface-400s.test.ts | src/v2.ts:248 | `handleAgentUnregister` (src/v2.ts) | handleAgentUnregister |
| tests/cross-surface-400s.test.ts | src/v2.ts:331 | `handleRunsParsed` (src/v2.ts), its `summary` check | handleRunsParsed |
| tests/cross-surface-400s.test.ts | src/v2.ts:334 | `handleRunsParsed` (src/v2.ts), its `tree` check | handleRunsParsed |
| tests/cross-surface-400s.test.ts | src/v2.ts:369 | `handleRunsCompile` (src/v2.ts) | handleRunsCompile |
| tests/cross-surface-400s.test.ts | src/v2.ts:481 | `handleStatus` (src/v2.ts) | handleStatus |
| tests/cycle-runs-anchor-fetch.test.ts | app.js:4129 | `anchorFetchRuns` (public/app.js) | anchorFetchRuns (sets state.anchorFeedback pruned) |
| tests/cycle-runs-anchor-fetch.test.ts | public/app-logic.mjs:903 | the inferred-cycle branch of `workflowLens` in public/app-logic.mjs | workflowLens (inferred-cycle status) |
| tests/cycle-runs-anchor-fetch.test.ts | public/app-logic.mjs:930-933 | `workflowLens` (public/app-logic.mjs) | workflowLens (closed-plans-only filter) |
| tests/cycle-runs-anchor-fetch.test.ts | public/app.js:2141 | the `pruned` entry of `ANCHOR_FEEDBACK_TEXT` in public/app.js | ANCHOR_FEEDBACK_TEXT.pruned (was inline in WorkspaceRunsFeed) |
| tests/cycle-runs-anchor-fetch.test.ts | public/app.js:4365 | the `openPlans` filter in `WorkflowActive` (public/app.js) | WorkflowActive |
| tests/cycle-timers.test.ts | :2295 | `watchdogTick` in public/app.js | `watchdogTick` — the watchdog-timer interval |
| tests/cycle-timers.test.ts | lavish/crucible-v2-design.html:649 | the F13 frame of .lavish/crucible-v2-design.html | the `<!-- F13 -->` frame (Workflow tab mock) |
| tests/cycle-timers.test.ts | node_modules/bun-types/test.d.ts:98-104 | (node_modules/bun-types/test.d.ts, `jest` namespace) | the `jest` namespace's `useFakeTimers` / `advanceTimersByTime` declarations (not a by-symbol shape: node_modules is outside the guard's resolvable tree) |
| tests/cycle-timers.test.ts | public/app.js:174 | `startPolling` (public/app.js) | `startPolling` — the poll-timer `setInterval` |
| tests/cycle-timers.test.ts | public/app.js:204 | `rel` in public/app.js | `rel` — the `Date.now()` relative-time helper |
| tests/cycle-timers.test.ts | public/app.js:418 | `fmtDuration` helper (public/app.js) | `fmtDuration` |
| tests/db-path-resolution.test.ts | src/server.ts:147 | `startServer` (src/server.ts) | `startServer` — its former hardcoded dbPath default |
| tests/dead-cr-rule-parity.test.ts | public/app-logic.mjs:1297 | `roadmapActionable` (public/app-logic.mjs) | roadmapActionable |
| tests/dead-cr-rule-parity.test.ts | src/types.ts:488 | `isDeadCr` (src/types.ts) | isDeadCr |
| tests/density.test.ts | app.js:1117-1128 | in `Home` in app.js | Home pinned band |
| tests/density.test.ts | app.js:3047 | the `?depth=suites` load in `RunDetailBody` in app.js | RunDetailBody first fetch |
| tests/density.test.ts | app.js:3077 | — (removed); `autoExpandFailing`, since removed | autoExpandFailing no longer exists in public/app.js |
| tests/density.test.ts | app.js:3312-3322 | through `failingLeafKeys` | failingLeafKeys |
| tests/density.test.ts | app.js:3329 | — (removed) | jumpToNextFailure already named |
| tests/density.test.ts | app.js:3701-3703 | — (removed) | RunDetail()'s div.app-drillin-inhead already named |
| tests/density.test.ts | drill-in.test.ts:1540 | drill-in.test.ts's "suite/leaf rows are tree-line elements" test | that drill-in test |
| tests/density.test.ts | styles.css:211 | the `.app-drillin-inhead` rule in styles.css | .app-drillin-inhead rule |
| tests/docs-db-path-resolution.test.ts | src/server.ts:158 | `resolveListener` in `src/server.ts` | `resolveListener` — its docstring retiring `$CRUCIBLE_PORT`/`$CRUCIBLE_HOST` |
| tests/docs-db-path-resolution.test.ts | src/server.ts:66 | `resolveStore` in `src/server.ts` | `resolveStore` — its `env.CRUCIBLE_DB` read |
| tests/docs-registration-binding.test.ts | :278 | the "attach `context.cycleId`" clause (PRD §4.11) | PRD §4.11 Dashboard — cycle-attach clause |
| tests/docs-registration-binding.test.ts | :285 | the "clients auto-attach it" phrase (PRD §4.11) | PRD §4.11 Dashboard — track auto-attach sentence |
| tests/docs-registration-binding.test.ts | :285 | the "clients auto-attach it" phrase | PRD §4.11 Dashboard — track auto-attach sentence |
| tests/docs-registration-binding.test.ts | :358 | the plan-verb list (PRD §4.11) | PRD §4.11 Dashboard — plan-verb list (PRD:292 alongside it rewritten to the WORKFLOW_* env-var list) |
| tests/docs-retired-mirror-references.test.ts | :47 (and 'lines 46-47 of') | the mirror-sync sentence in tests/client/test_bun_crucible_gates.py's module docstring | module docstring mirror-sync sentence |
| tests/docs-retired-mirror-references.test.ts | tests/agent-lifecycle.test.ts:13 (x2) | tests/agent-lifecycle.test.ts (header comment) | file header comment |
| tests/docs-retired-mirror-references.test.ts | tests/client/test_bun_crucible_gates.py:42 | tests/client/test_bun_crucible_gates.py (module docstring) | module docstring |
| tests/docs-retired-mirror-references.test.ts | tests/client/test_bun_crucible_gates.py:48 (x2) | tests/client/test_bun_crucible_gates.py (module docstring) | module docstring |
| tests/docs-retired-mirror-references.test.ts | tests/client/test_bun_crucible_lifecycle.py:144 | tests/client/test_bun_crucible_lifecycle.py (`_load_bun_crucible_module`) | _load_bun_crucible_module docstring |
| tests/docs-retired-mirror-references.test.ts | tests/client/test_bun_crucible_lifecycle.py:54 | tests/client/test_bun_crucible_lifecycle.py (module docstring) | module docstring |
| tests/docs-retired-mirror-references.test.ts | tests/client/test_cr046_official_toon_roundtrip.py:2 (x2) | tests/client/test_cr046_official_toon_roundtrip.py (module docstring) | module docstring |
| tests/docs-retired-mirror-references.test.ts | tests/client/test_crucible_axi_shared.py:22 (x2) | tests/client/test_crucible_axi_shared.py (module docstring) | module docstring |
| tests/docs-retired-mirror-references.test.ts | tests/clients-bun-crucible.test.ts:11 (x3) | tests/clients-bun-crucible.test.ts (header comment) | file header comment |
| tests/docs-retired-mirror-references.test.ts | tests/clients-python-arduino-crucible.test.ts:13 (x2) | tests/clients-python-arduino-crucible.test.ts (header comment) | file header comment |
| tests/docs-retired-mirror-references.test.ts | tests/clients-rust-mvn-crucible.test.ts:14 | tests/clients-rust-mvn-crucible.test.ts (header comment) | file header comment |
| tests/docs-retired-mirror-references.test.ts | tests/e2e/steps/harness.ts:216 (x2) | tests/e2e/steps/harness.ts, `JUNIT_3CASE_1FAIL` | JUNIT_3CASE_1FAIL comment |
| tests/docs-retired-mirror-references.test.ts | tests/f13-fidelity.test.ts:46 (x3) | tests/f13-fidelity.test.ts (header comment) | file header comment |
| tests/docs-retired-mirror-references.test.ts | tests/plans.test.ts:6 (x2) | tests/plans.test.ts (header comment) | file header comment |
| tests/docs-retired-mirror-references.test.ts | tests/toon-conformance.test.ts:6 (x2) | tests/toon-conformance.test.ts (header comment) | file header comment |
| tests/docs-retired-mirror-references.test.ts | tests/v2-runs-events.test.ts:72 (x2) | tests/v2-runs-events.test.ts, `JUNIT_3CASE_1FAIL` | JUNIT_3CASE_1FAIL comment |
| tests/docs-runbook-documents-every-limit.test.ts | :520 | the RUNBOOK's "Environment variables (port / bind / database)" section | RUNBOOK section: CRUCIBLE_PORT table row |
| tests/docs-runbook-documents-every-limit.test.ts | :526 | the RUNBOOK's "Environment variables (port / bind / database)" section | RUNBOOK section: first sh example |
| tests/docs-runbook-documents-every-limit.test.ts | :530 | the RUNBOOK's "Environment variables (port / bind / database)" section | RUNBOOK section: second sh example |
| tests/docs-runbook-documents-every-limit.test.ts | clients/_crucible_axi.py:1388 | `no_report_warning` in clients/_crucible_axi.py | no_report_warning (error_detail_chars bound) |
| tests/docs-runbook-documents-every-limit.test.ts | clients/crucible.toml:40-41 | the "Why only the CLIENT's three limits are here" comment in `clients/crucible.toml` | clients/crucible.toml section comment |
| tests/docs-runbook-documents-every-limit.test.ts | crucible_axi/cli.py:368-375 | `cmd_serve` in `crucible_axi/cli.py` | cmd_serve (--host/--port write) |
| tests/docs-runbook-documents-every-limit.test.ts | crucible_axi/install.py:559 | `write_listener_settings` in `crucible_axi/install.py` | write_listener_settings |
| tests/docs-runbook-documents-every-limit.test.ts | src/crucible.toml:16 | the "This is NOT the file you edit" header comment of `src/crucible.toml` | src/crucible.toml section comment |
| tests/docs-runbook-documents-every-limit.test.ts | src/limits.ts:5 | the header comment of `src/limits.ts` | src/limits.ts module header comment |
| tests/docs-runbook-documents-every-limit.test.ts | src/server.ts:158 | the doc comment on `resolveListener` in `src/server.ts` | resolveListener doc comment (CRUCIBLE_PORT retired) |
| tests/docs-runbook-documents-every-limit.test.ts | src/server.ts:301 | the doc comment on `retentionDisclosure` in `src/server.ts` | retentionDisclosure doc comment |
| tests/docs-runbook-documents-every-limit.test.ts | src/server.ts:66 | `resolveStore` in src/server.ts | resolveStore (CRUCIBLE_DB read) |
| tests/docs-runbook-documents-every-limit.test.ts | src/types.ts:31 | the doc comment on `Project.retention` in `src/types.ts` | Project.retention doc comment |
| tests/docs-runbook-documents-every-limit.test.ts | tests/limits-have-no-environment-layer.test.ts:348-351 | the comment over `SHIPPED_TREES` in tests/limits-have-no-environment-layer.test.ts | SHIPPED_TREES (docs/ not scanned rationale) |
| tests/drill-in.test.ts | styles.css:1096 | `@keyframes app-run-pulse` in public/styles.css | @keyframes app-run-pulse |
| tests/e2e-harness-agent-identity.test.ts | harness.ts:134-144 | `registerAgent` in harness.ts | registerAgent |
| tests/e2e-harness-agent-identity.test.ts | harness.ts:214 | — (removed) | ingestParsed's own expect already named |
| tests/e2e-harness-agent-identity.test.ts | harness.ts:243-259 | `filePlan` in harness.ts | filePlan |
| tests/e2e-harness-agent-identity.test.ts | harness.ts:257 | — (removed) | filePlan's own expect already named |
| tests/e2e-harness-agent-identity.test.ts | seeding.steps.ts:24 | seeding.steps.ts's "an online agent ... is registered" step | that Step |
| tests/e2e-harness-agent-identity.test.ts | workflow.steps.ts:19 | workflow.steps.ts's "a cycle plan is filed for cr" step | that Step |
| tests/e2e/steps/harness.ts | gates.steps.ts:22, wave-backfill.steps.ts:21, workflow.steps.ts:19 | the Steps in gates.steps.ts, wave-backfill.steps.ts and workflow.steps.ts | filePlan call-site Steps |
| tests/e2e/steps/harness.ts | seeding.steps.ts:24 | seeding.steps.ts's "an online agent ... is registered" step | that Step |
| tests/e2e/steps/harness.ts | src/v2.ts:316 | `handleProjectCreate` in src/v2.ts | handleProjectCreate type field |
| tests/e2e/steps/harness.ts | src/v2.ts:499 | `handleAgentTouch` (`src/v2.ts`) | handleAgentTouch |
| tests/e2e/steps/mobile-viewport.steps.ts | public/app.js:2453-2487 | `RAIL_STORAGE_KEY` in public/app.js | RAIL_STORAGE_KEY |
| tests/e2e/steps/mobile-viewport.steps.ts | public/styles.css:88 | the `.app-top` rule in public/styles.css | .app-top flex-wrap rule |
| tests/e2e/steps/roadmap-graph.steps.ts | src/v2.ts:265 | `requireOrchestrator`, in src/v2.ts | requireOrchestrator |
| tests/e2e/teardown-contracts/crucible-db-isolation.test.ts | src/server.ts:25-31 | `ResolveDbPathOpts` in `src/server.ts` | ResolveDbPathOpts |
| tests/e2e/teardown-contracts/crucible-db-isolation.test.ts | src/server.ts:47-66 | (`src/server.ts`, …) after `resolveDbPath` | resolveDbPath (already named) |
| tests/e2e/teardown-contracts/ephemeral.contract.ts | src/store.ts:669-676 | `listProjects` in `src/store.ts` | Store.listProjects |
| tests/e2e/teardown-contracts/ephemeral.contract.ts | src/v2.ts:268-275 | `handleProjectsList` (`src/v2.ts`) | handleProjectsList |
| tests/event-role-backfill.test.ts | src/store.ts:1134 | `insertEvent` in src/store.ts | insertEvent (the single event write path) |
| tests/event-role-backfill.test.ts | src/store.ts:318-342 | the `events` table in `createBaseTables` (src/store.ts) | createBaseTables (events DDL) |
| tests/event-role-backfill.test.ts | src/store.ts:318-342 | the `events` table in `createBaseTables` (src/store.ts) | createBaseTables (events DDL) |
| tests/event-role-classification.test.ts | app.js:694 | `eventRole` (public/app.js) | eventRole |
| tests/event-role-classification.test.ts | public/app.js:694-698 | `eventRole` (public/app.js) | eventRole |
| tests/events-anchored.test.ts | src/v2.ts:3407-3419 | The cycleId branch of `handleEventsList` (src/v2.ts) | handleEventsList (cycleId branch) |
| tests/events-feed-after-records-moved.test.ts | app.js:1347 | `runFeed` in public/app.js | `runFeed` — its gate branch (`GateCardRow`/`GateCardCompact`) |
| tests/events-feed-after-records-moved.test.ts | app.js:1349-1350 | also in `runFeed` (public/app.js named in the same sentence) | `runFeed` — its `cr-merged` milestone branch |
| tests/events-feed-after-records-moved.test.ts | app.js:4478-4482 | `scopedGateEvents` in public/app.js | `scopedGateEvents` |
| tests/events-feed-after-records-moved.test.ts | public/app.js:1349-1350 | `runFeed` (public/app.js) | `runFeed` — its `cr-merged` milestone branch |
| tests/events-feed-after-records-moved.test.ts | public/app.js:4478-4482 | `scopedGateEvents` (public/app.js) | `scopedGateEvents` |
| tests/helpers/server-limits-fixture.ts | :298 | `shipped_board` … in `clients/_crucible_axi.py` | shipped_board |
| tests/helpers/server-limits-fixture.ts | :368 | `startServer` in `src/server.ts` | startServer (listener comment) |
| tests/helpers/server-limits-fixture.ts | :440 | `resolve_base_url` in `clients/_crucible_axi.py` | resolve_base_url |
| tests/helpers/server-limits-fixture.ts | :441 | `resolve_base_url` in `clients/_crucible_axi.py` | resolve_base_url |
| tests/helpers/server-limits-fixture.ts | clients/_crucible_axi.py:127 | the `CLIENT_TABLE` comment … in `clients/_crucible_axi.py` | the #: comment block above LIMITS_TABLE/CLIENT_TABLE |
| tests/helpers/server-limits-fixture.ts | src/server.ts:158 | `resolveListener` … in `src/server.ts` | resolveListener |
| tests/helpers/server-limits-fixture.ts | src/server.ts:65 | `resolveStore()` in src/server.ts | resolveStore (already named) |
| tests/helpers/server-limits-fixture.ts | src/server.ts:65 | `resolveStore` in src/server.ts | resolveStore |
| tests/helpers/server-limits-fixture.ts | src/store.ts:3737-3742 | (src/store.ts) after `sweepOpenRuns` | sweepOpenRuns (already named) |
| tests/helpers/server-limits-fixture.ts | src/store.ts:747 | `defaultRetention` (src/store.ts) | defaultRetention |
| tests/helpers/server-limits-fixture.ts | src/store.ts:843 | `runAbandonAfterMs` (src/store.ts) | runAbandonAfterMs |
| tests/helpers/server-limits-fixture.ts | src/v2.ts:371 | `projectInactiveMs` (src/v2.ts) | projectInactiveMs |
| tests/ingest-no-implicit-agents.test.ts | store.ts:816-817, store.ts:849-850, store.ts:903-904 | the `touchAgent` call in each of those three methods in store.ts | touchAgent calls in recordTestEvent/recordCompileEvent/recordGateEvent |
| tests/inpane-drill-in.test.ts | :1538-1540 | the `app-drillin-head` inside `RunDetail()` | RunDetail detail header |
| tests/inpane-drill-in.test.ts | :994-997 | `Workspace()` (already named; line dropped) | Workspace |
| tests/inpane-drill-in.test.ts | app.js:3436 | `FailuresFooter` (public/app.js) | FailuresFooter |
| tests/inpane-drill-in.test.ts | app.js:3436 | `FailuresFooter` (public/app.js) | FailuresFooter |
| tests/inpane-drill-in.test.ts | app.js:3500 | inside `TestBody` | TestBody raw reveal |
| tests/inpane-drill-in.test.ts | public/app.js:1283 | `jumpToNextFailure` (public/app.js) | jumpToNextFailure |
| tests/inpane-drill-in.test.ts | public/app.js:1438-1483 | both built inside that `RunOverlay()` | RunOverlay scrim + sheet |
| tests/inpane-drill-in.test.ts | public/app.js:1531-1560 | RunDetail() (already named; line dropped) | RunDetail |
| tests/inpane-drill-in.test.ts | public/app.js:28 | `state.savedScrollY`, saved in `navigate()` and read back by `restoreScroll()` | state.savedScrollY / navigate / restoreScroll (lines 28,37,45-50) |
| tests/inpane-drill-in.test.ts | public/app.js:41 | inside `navigate()` | navigate (workspaceTab reset) |
| tests/inpane-drill-in.test.ts | public/app.js:624 | in `Timeline()` and `WorkspaceRuns()` | Timeline (624), WorkspaceRuns (703-707) |
| tests/inpane-drill-in.test.ts | public/app.js:649 | `WorkspaceTabs()` (public/app.js) | WorkspaceTabs |
| tests/inpane-drill-in.test.ts | public/app.js:965 | `RunOverlay()` (already named; line dropped) | RunOverlay (since removed) |
| tests/inpane-liveness.test.ts | :574-598 | the `paneSwap` closure (public/app.js) | paneSwap |
| tests/inpane-liveness.test.ts | app.js:1531 | `RunDetail` in public/app.js | RunDetail (run-overlay container) |
| tests/inpane-liveness.test.ts | public/app.js:125-149 | `connectStream` (public/app.js) | connectStream |
| tests/inpane-liveness.test.ts | public/app.js:151-154 | `startPolling` (public/app.js) | startPolling |
| tests/inpane-liveness.test.ts | public/app.js:153 | `startPolling` in public/app.js | startPolling (5000ms interval) |
| tests/inpane-liveness.test.ts | public/app.js:1567-1595 | `surfaceKeyOf` (public/app.js) | surfaceKeyOf |
| tests/inpane-liveness.test.ts | public/app.js:96-113 | `refetch` (public/app.js) | refetch |
| tests/inpane-liveness.test.ts | tests/shell-final-form.test.ts:707 | the "shows exactly 'server unreachable · retrying…'" test in tests/shell-final-form.test.ts | shell-final-form down-state test |
| tests/limits-have-no-environment-layer.test.ts | :327 | `retentionDisclosure()` in src/server.ts | `retentionDisclosure` — its advice text |
| tests/limits-have-no-environment-layer.test.ts | :843 | `runAbandonAfterMs` in src/store.ts | `runAbandonAfterMs` (§S1b section comment) |
| tests/limits-have-no-environment-layer.test.ts | clients/arduino-crucible.py:117 | `_load_env` (clients/arduino-crucible.py) | `_load_env` — its CRUCIBLE_PROJECT_KEY read |
| tests/limits-have-no-environment-layer.test.ts | clients/bun-crucible.py:1025 | `_run_left_open_warning` (clients/bun-crucible.py) | `_run_left_open_warning` — the warning text it builds |
| tests/limits-have-no-environment-layer.test.ts | clients/bun-crucible.py:157 | `_project_key` in clients/bun-crucible.py | `_project_key` — its former `"CRUCIBLE_PROJECT_KEY" not in env` check (now a `.get`; comment says "once used") |
| tests/limits-have-no-environment-layer.test.ts | src/server.ts:158 | `resolveListener` in `src/server.ts` | the doc comment on `resolveListener` (connection-variable retirement) |
| tests/limits-have-no-environment-layer.test.ts | src/server.ts:303 | `retentionDisclosure` in src/server.ts | the doc comment on `retentionDisclosure` |
| tests/limits-have-no-environment-layer.test.ts | src/server.ts:321 | `retentionDisclosure` (src/server.ts) | `retentionDisclosure` — its null-when-any-cap-resolves return |
| tests/limits-have-no-environment-layer.test.ts | src/server.ts:325 | `retentionDisclosure()` in src/server.ts | `retentionDisclosure` — its advice text (the `:327` second line number removed with it) |
| tests/limits-have-no-environment-layer.test.ts | src/server.ts:66 | `resolveStore` (src/server.ts) | `resolveStore` — its `env.CRUCIBLE_DB` read |
| tests/limits-have-no-environment-layer.test.ts | src/store.ts:3745 | `sweepOpenRuns` in src/store.ts | `sweepOpenRuns` — its agent-died-before-deadline check |
| tests/limits-have-no-environment-layer.test.ts | src/store.ts:747 | `defaultRetention` (src/store.ts) | `defaultRetention` — its retired env read (header table) |
| tests/limits-have-no-environment-layer.test.ts | src/store.ts:747 | `defaultRetention` (named with src/store.ts) | `defaultRetention` (§S1b section comment) |
| tests/limits-have-no-environment-layer.test.ts | src/store.ts:843 | `runAbandonAfterMs` (src/store.ts) | `runAbandonAfterMs` — its retired env read (header table) |
| tests/limits-have-no-environment-layer.test.ts | src/v2.ts:371 | `projectInactiveMs` (src/v2.ts) | `projectInactiveMs` — its retired env read (header table) |
| tests/limits-have-no-environment-layer.test.ts | src/v2.ts:371 | `projectInactiveMs` in src/v2.ts | `projectInactiveMs` (§S1b section comment) |
| tests/manager-edit-params.test.ts | src/v2.ts:742-836 | `handleProjectPatch` in src/v2.ts | handleProjectPatch |
| tests/manager-edit-params.test.ts | src/v2.ts:747-749 | `LIVENESS_WIRE_KEYS` in src/v2.ts | LIVENESS_WIRE_KEYS |
| tests/manager-edit-params.test.ts | src/v2.ts:799-816 | in `handleProjectPatch` in src/v2.ts | handleProjectPatch (liveness partial merge) |
| tests/manager-settings-labels.test.ts | public/app.js:1247-1307 | `ManagerRowEdit` in public/app.js | ManagerRowEdit |
| tests/manager-settings-labels.test.ts | public/app.js:14 | the `van.tags` destructure at the top of public/app.js | van.tags destructure |
| tests/manager-settings-labels.test.ts | public/app.js:158-175 (x2) | `refetchCore` in public/app.js | refetchCore retention window |
| tests/milestone-dates-are-first-class.test.ts | src/store.ts:2677-2680 | `recordMilestoneEvent` (src/store.ts) | `recordMilestoneEvent` — its CR §S1 targetAt-only-for-proposals comment and guard |
| tests/milestone-dates-are-first-class.test.ts | src/types.ts:387-389 | `QueueLifecycle` in src/types.ts | the doc comment on `QueueLifecycle` (seconds-vs-milliseconds units note) |
| tests/milestone-dates-are-first-class.test.ts | tests/milestone-records-survive-retention.test.ts:147 | `milestoneVocabulary` in tests/milestone-records-survive-retention.test.ts | `milestoneVocabulary` |
| tests/milestone-dates-are-queryable.test.ts | src/v2.ts:1939-1971 | `handleProjectMilestones` in src/v2.ts | the doc comment on `handleProjectMilestones` (unwindowed, projection-free rationale) |
| tests/milestone-dates-are-queryable.test.ts | src/v2.ts:1950-1958 | `handleProjectMilestones` in src/v2.ts | the "THE TYPE IS A PARAMETER" paragraph of `handleProjectMilestones`'s doc comment |
| tests/milestone-records-are-queryable-by-type.test.ts | clients/_crucible_axi.py:1692 | `cr_merged_crs` (clients/_crucible_axi.py) | cr_merged_crs |
| tests/milestone-records-are-queryable-by-type.test.ts | src/v2.ts:3657, :3673, :3661 | each a `segments[1]` branch of `handleV2` in src/v2.ts | handleV2 releases/release-proposals/queue branches |
| tests/milestone-records-are-queryable-by-type.test.ts | src/v2.ts:3748 | the `/api/v2/events` branch of `handleV2` in src/v2.ts | handleV2 events route |
| tests/milestone-records-survive-retention.test.ts | :3079 | — (removed) | `LIVE_PROPOSAL` is gone; now "its sibling predicate, likewise removed" (of `enforceRetention`, named just before) |
| tests/milestone-records-survive-retention.test.ts | src/store.ts:2296 | `recordReleaseProposal` in src/store.ts | `recordReleaseProposal` |
| tests/milestone-records-survive-retention.test.ts | src/store.ts:3063 | `enforceRetention` (src/store.ts) | `enforceRetention` |
| tests/milestone-records-survive-retention.test.ts | src/store.ts:3072 | `enforceRetention` in src/store.ts | successor: `LIVE_GATE` is gone; named as a since-removed exemption predicate of `enforceRetention` |
| tests/milestone-records-survive-retention.test.ts | src/store.ts:4085-4087 | `listQueue` in src/store.ts | `listQueue` — its "consumes this verbatim" canonical-order comment |
| tests/milestone-records-survive-retention.test.ts | src/v2.ts:1165 | `acceptedMilestoneTypes` in src/store.ts | successor: `MILESTONE_TYPES` is gone from src/v2.ts; the accepted set is now `acceptedMilestoneTypes` |
| tests/milestone-records-survive-retention.test.ts | src/v2.ts:1165-1172 | `acceptedMilestoneTypes` in src/store.ts | successor: the FINDING names the since-replaced `MILESTONE_TYPES` (then in src/v2.ts) and its successor `acceptedMilestoneTypes` |
| tests/milestone-records-survive-retention.test.ts | src/v2.ts:1264-1265 | `handleMilestones` in src/v2.ts | `handleMilestones` — its `type must be one of` refusal |
| tests/milestone-type-is-definable.test.ts | :3354 | its `PATCHABLE_FIELDS` | PATCHABLE_FIELDS |
| tests/milestone-type-is-definable.test.ts | retention.test.ts:147 | `milestoneVocabulary` in `tests/milestone-records-survive-retention.test.ts` | milestoneVocabulary |
| tests/milestone-type-is-definable.test.ts | src/store.ts:35 | `ProjectPatch` in src/store.ts | ProjectPatch |
| tests/milestone-type-is-definable.test.ts | src/v2.ts:1168 | `MILESTONE_TYPES` (then a module constant in src/v2.ts) | MILESTONE_TYPES, since retired by this CR; no by-symbol cite possible |
| tests/milestone-type-is-definable.test.ts | src/v2.ts:1289 | `handleMilestones` in src/v2.ts | handleMilestones type refusal |
| tests/milestone-type-is-definable.test.ts | src/v2.ts:3383 | `handleProjectPatch` in src/v2.ts | handleProjectPatch |
| tests/milestone-type-is-definable.test.ts | test.ts:78 (tests/milestone-dates-migration.test.ts:78) | `liveStoreReplica` in `tests/milestone-dates-migration.test.ts` | liveStoreReplica |
| tests/milestone-type-is-definable.test.ts | tests/milestone-dates-are-first-class.test.ts:167 | its twin in `tests/milestone-dates-are-first-class.test.ts` | milestoneVocabulary (twin) |
| tests/milestone-type-is-definable.test.ts | tests/milestone-dates-migration.test.ts:58 | `liveStoreReplica` in `tests/milestone-dates-migration.test.ts` | liveStoreReplica |
| tests/milestone-type-is-definable.test.ts | tests/roadmap-registration-routes.test.ts:1443 (x2) | the `release-proposal` tripwire test in `tests/roadmap-registration-routes.test.ts` | the release-proposal generic-surface tripwire test |
| tests/milestone-vocabulary-has-one-source.test.ts | clients/arduino-crucible.py:1408 | `--type` help (the `milestone` verb, in `main`) | main (milestone --type) |
| tests/milestone-vocabulary-has-one-source.test.ts | clients/bun-crucible.py:2506 | `--type` help (the `milestone` verb, in `main`) | main (milestone --type) |
| tests/milestone-vocabulary-has-one-source.test.ts | clients/mvn-crucible.py:2374 | `--type` help (the `milestone` verb, in `main`) | main (milestone --type) |
| tests/milestone-vocabulary-has-one-source.test.ts | clients/python-crucible.py:1729 | `--type` help (the `milestone` verb, in `main`) | main (milestone --type) |
| tests/milestone-vocabulary-has-one-source.test.ts | clients/rust-crucible.py:3020 | `--type` help (the `milestone` verb, in `main`) | main (milestone --type) |
| tests/milestone-vocabulary-has-one-source.test.ts | src/hints.ts:104 | `hints.milestoneTypes` (src/hints.ts) | hints.milestoneTypes (since replaced by milestoneHints) |
| tests/milestone-vocabulary-has-one-source.test.ts | src/hints.ts:104 | `hints.milestoneTypes` (src/hints.ts) | hints.milestoneTypes |
| tests/milestone-vocabulary-has-one-source.test.ts | src/v2.ts:1168 | src/v2.ts `MILESTONE_TYPES` | MILESTONE_TYPES (validator, since removed) |
| tests/next-resolver.test.ts | src/hints.ts:519-525 | the `hold` entry of `nextHints` in src/hints.ts | nextHints.hold |
| tests/next-resolver.test.ts | src/next.ts:165 | `isActionable` (src/next.ts) | isActionable |
| tests/next-resolver.test.ts | src/next.ts:165 | `isActionable` (src/next.ts) | isActionable (test comment) |
| tests/next-resolver.test.ts | src/next.ts:170 | `deadLifecycleOf` (src/next.ts) | deadLifecycleOf |
| tests/next-resolver.test.ts | src/next.ts:170 | `deadLifecycleOf` (src/next.ts) | deadLifecycleOf (test comment) |
| tests/next-resolver.test.ts | src/store.ts:430 | `declaredTracks` (src/store.ts) | declaredTracks |
| tests/next-resolver.test.ts | src/types.ts:437-469 | `QueueEntry` in src/types.ts | QueueEntry |
| tests/next-resolver.test.ts | src/types.ts:488 | `isDeadCr` (src/types.ts) | isDeadCr |
| tests/next-route.test.ts | src/v2.ts:2092-2101 | `handleQueueGet` in src/v2.ts | handleQueueGet |
| tests/next-route.test.ts | src/v2.ts:2093-2097 | its opening guard (`handleQueueGet`'s UUID/unknown-project refusal) | handleQueueGet refusal guard |
| tests/pane-scroll-floor.test.ts | public/app.js:1679 | `WorkspaceRunDetail` in public/app.js | WorkspaceRunDetail |
| tests/pane-scroll-floor.test.ts | public/app.js:1727 | in `Workspace`, public/app.js | Workspace (workspace-body testid) |
| tests/pane-scroll-floor.test.ts | public/styles.css:236 | that rule in public/styles.css | .app-center > .app-pane-content selector |
| tests/pipeline-test-timeout-default.test.ts | :146 | — (removed) | release.yml Bun suite step already named |
| tests/pipeline-test-timeout-default.test.ts | clients/bun-crucible.py:500 | `_bun_test_cmd` (clients/bun-crucible.py) | _bun_test_cmd |
| tests/plan-close-guard.test.ts | src/store.ts:1528 | the refusal template string in `closePlan` in src/store.ts | Store.closePlan (non-terminal refusal) |
| tests/plan-scoping.test.ts | src/types.ts:164 | `Plan` in src/types.ts | `Plan` — its `projectKey` field |
| tests/plans-global.test.ts | src/server.ts:531 | `startServer` in src/server.ts | `startServer` — its `/api/` 404 catch-all |
| tests/plans-global.test.ts | src/store.ts:1306 | `toPlan` in src/store.ts | `toPlan` |
| tests/plans-global.test.ts | src/store.ts:431 | `listProjects` in src/store.ts | `listProjects` |
| tests/plans-global.test.ts | src/v2.ts:711 | `handlePlansList` in src/v2.ts | `handlePlansList` |
| tests/plans.test.ts | src/v2.ts:537 | `handlePlanFile` (src/v2.ts) | handlePlanFile (wave coercion) |
| tests/project-archive.test.ts | src/v2.ts ~192 (not flagged, same sentence) | (handleProjectCreate, src/v2.ts) | handleProjectCreate (already named) |
| tests/project-archive.test.ts | src/v2.ts:3 | the header comment of src/v2.ts | src/v2.ts file header comment (§S5 changed:true\|false) |
| tests/project-independence-strings.test.ts | public/app.js:2353-2354 | the BDD tab (then `BddFeed`, since replaced by `BddPanel` in public/app.js) | BddFeed (retired) -> successor BddPanel |
| tests/project-namespace-tripwire.test.ts | tests/queue-canonical-order.test.ts:138 | `spanOf` in tests/queue-canonical-order.test.ts | `spanOf` — its absent-from-the-published-order throw |
| tests/project-namespace-tripwire.test.ts | tests/roadmap-registration-store.test.ts:194 | `entryOf` in tests/roadmap-registration-store.test.ts | `entryOf` — its absent-from-the-queue-read throw |
| tests/project-teardown.test.ts | src/v2.ts:1457-1458 | (… src/v2.ts) after handleProjectArchive | handleProjectArchive existence check (already named) |
| tests/project-teardown.test.ts | src/v2.ts:1458 | (src/v2.ts) after handleProjectArchive | handleProjectArchive (already named) |
| tests/project-teardown.test.ts | src/v2.ts:1747-1772 | (src/v2.ts, …) after handleEventDelete | handleEventDelete (already named) |
| tests/project-teardown.test.ts | src/v2.ts:1767-1769 | (also src/v2.ts) after handleEventDelete | handleEventDelete 404-on-miss (already named) |
| tests/project-teardown.test.ts | store.ts:1334 | `enforceRetention` in src/store.ts | enforceRetention |
| tests/project-teardown.test.ts | test.ts:107 (event-role-backfill) | `rawRoleRow` in tests/event-role-backfill.test.ts | rawRoleRow |
| tests/project-teardown.test.ts | tests/agent-role-rename.test.ts:628 | `tableInfoColumns` in tests/agent-role-rename.test.ts | tableInfoColumns |
| tests/projects-manager.test.ts | src/types.ts:15-24 | (src/types.ts) after `Project` | Project interface (already named) |
| tests/projects-manager.test.ts | src/v2.ts:190 | (src/v2.ts) after handleProjectCreate | handleProjectCreate (already named) |
| tests/projects-manager.test.ts | src/v2.ts:764-836 | `handleProjectPatch` in src/v2.ts | handleProjectPatch |
| tests/projects-manager.test.ts | src/v2.ts:771-773 | `handleProjectPatch` in src/v2.ts | handleProjectPatch (projectKey is immutable) |
| tests/queue-canonical-order.test.ts | clients/_crucible_axi.py:1310-1319 | `isActionable` in src/next.ts | successor: client `_is_actionable` deleted (resolver moved server-side); now `isActionable` |
| tests/queue-canonical-order.test.ts | clients/_crucible_axi.py:1531 | `resolveNext` in src/next.ts | successor: client `resolve_next`'s `actionable[0]` deleted; now `resolveNext` |
| tests/queue-canonical-order.test.ts | src/store.ts:344-353 | `compareVersionLabels` (src/store.ts) | the doc comment on `compareVersionLabels` |
| tests/queue-canonical-order.test.ts | src/store.ts:3465-3470 | `listQueue` (src/store.ts) | `listQueue` — its ORDER BY |
| tests/queue-canonical-order.test.ts | src/store.ts:359 | `compareVersionLabels` (src/store.ts) | `compareVersionLabels` |
| tests/queue-canonical-order.test.ts | src/store.ts:386-392 | `WAVE_SEQ_STRIDE` in src/store.ts | the doc comment on `WAVE_SEQ_STRIDE` (shared seq-block tolerance) |
| tests/queue-canonical-order.test.ts | src/store.ts:390 | `compareVersionLabels` in src/store.ts | `compareVersionLabels` — its fewer-components-first rule |
| tests/queue-canonical-order.test.ts | src/store.ts:396-405 | `waveNumber` in src/store.ts | `waveNumber` — the leading-integer read `waveSeqBase` rests on |
| tests/queue-canonical-order.test.ts | src/v2.ts:1848-1859 | `handleQueuePost` in src/v2.ts | `handleQueuePost` — its entry-building loop (no `release`) |
| tests/queue-canonical-order.test.ts | src/v2.ts:1870 | `handleQueuePost` in src/v2.ts | `handleQueuePost` — its reply's `entries` |
| tests/queue-canonical-order.test.ts | src/v2.ts:1911-1913 | `containerLabel` in src/v2.ts | `containerLabel` |
| tests/queue-canonical-order.test.ts | src/v2.ts:1927-1932 | `compareContainers` (module-private in src/v2.ts then; lifted into src/store.ts since) | successor: `compareContainers`, since moved to and exported from src/store.ts |
| tests/queue-canonical-order.test.ts | src/v2.ts:1995-2011 | `dependencyWarnings` in src/v2.ts | `dependencyWarnings` — its `cross-wave-backwards` branch |
| tests/queue-default-into-wave-block.test.ts | :3476 | in the same method | replaceQueue (declaredSeq) |
| tests/queue-default-into-wave-block.test.ts | src/store.ts:3498 | (src/store.ts) after `replaceQueue` | replaceQueue (already named) |
| tests/queue-default-into-wave-block.test.ts | src/store.ts:3733 (/3749) | `sequenceQueueWave`/`densifyWave` in src/store.ts | sequenceQueueWave / densifyWave (base + index + 1) |
| tests/queue-default-into-wave-block.test.ts | src/store.ts:462-465 | `inWaveBlock` in src/store.ts | inWaveBlock |
| tests/queue-default-into-wave-block.test.ts | src/v2.ts:2245-2248 | `handleWaveSequence` in src/v2.ts | handleWaveSequence (WAVE_SEQ_STRIDE overflow refusal) |
| tests/queue-defaulted-seq-scope.test.ts | src/store.ts:3635-3641 | `upsertQueueEntry` (src/store.ts) | upsertQueueEntry (sibling comparison) |
| tests/queue-defaulted-seq-scope.test.ts | src/v2.ts:1896-1908 | `defaultedSeqWarnings`, since succeeded by `seqScaleWarnings` in src/v2.ts | defaultedSeqWarnings (gone; successor seqScaleWarnings) |
| tests/queue-defaulted-seq-scope.test.ts | src/v2.ts:1902-1904 | the `message` in `defaultedSeqWarnings` (since succeeded by `seqScaleWarnings` in src/v2.ts) | defaultedSeqWarnings message (gone; successor seqScaleWarnings) |
| tests/queue-file-deprecation.test.ts | :177-181 | that constant's doc comment (`INHERITED_CODE`, sibling file named in the same sentence) | the doc comment on `INHERITED_CODE` in tests/queue-release-membership-mandatory.test.ts |
| tests/queue-membership-one-rule.test.ts | `requireLiveProposal` (src/v2.ts) | `requireLiveProposal` (since absorbed into `declareMembership` in src/v2.ts) | requireLiveProposal (gone; absorbed into declareMembership by CR-CRU-104 GREEN 64e88c7) |
| tests/queue-registration.test.ts | :1840 | — (removed) | the branch-vs-develop line-drift aside existed only to explain line numbers; `handleQueueGet` is named instead |
| tests/queue-registration.test.ts | public/app-logic.mjs:1275 | `focusedReleaseView` in public/app-logic.mjs | `focusedReleaseView` — its release-membership filter |
| tests/queue-registration.test.ts | src/store.ts:2111 | `listReleases` (src/store.ts) | `listReleases` |
| tests/queue-registration.test.ts | src/store.ts:262-266 | `QueueEntryRow` in src/store.ts | `QueueEntryRow` — its NULL-when-undeclared declaration columns |
| tests/queue-registration.test.ts | src/store.ts:283-287 | `QueueEntryInput` (src/store.ts) | `QueueEntryInput` — its declaration fields |
| tests/queue-registration.test.ts | src/store.ts:3052 | `deriveQueueStatus` (named with src/store.ts) | `deriveQueueStatus` |
| tests/queue-registration.test.ts | src/store.ts:3095 | `deriveQueueStatus` (named with src/store.ts) | `deriveQueueStatus` — its plans-exist fallthrough |
| tests/queue-registration.test.ts | src/store.ts:345-348 | `normalizeTrack` in src/store.ts | `normalizeTrack` |
| tests/queue-registration.test.ts | src/store.ts:349 | `normalizeTrack` (named with src/store.ts) | `normalizeTrack` |
| tests/queue-registration.test.ts | src/store.ts:3599 | `replaceQueue` (named with src/store.ts) | `replaceQueue` — its release carry-forward |
| tests/queue-registration.test.ts | src/types.ts:310 | `QueueStatus` (src/types.ts) | `QueueStatus` |
| tests/queue-registration.test.ts | src/types.ts:360-363 | its doc comment in src/types.ts (`QueueLifecycle`, named in the same sentence) | the doc comment on `QueueLifecycle` (`at` unit) |
| tests/queue-registration.test.ts | src/types.ts:365-372 | `QueueLifecycle` (src/types.ts) | `QueueLifecycle` |
| tests/queue-registration.test.ts | src/v2.ts:1164 | `handleMilestones` (src/v2.ts) | `handleMilestones` |
| tests/queue-registration.test.ts | src/v2.ts:1480-1491 | `handlePlanClose` in src/v2.ts | `handlePlanClose` — its optional `merge` read |
| tests/queue-registration.test.ts | src/v2.ts:1480-1491 | `handlePlanClose` in src/v2.ts | `handlePlanClose` — its optional `merge` read |
| tests/queue-registration.test.ts | src/v2.ts:1833 | `handleQueueGet` (src/v2.ts) | `handleQueueGet` (the ON-DEVELOP line-drift aside removed with it) |
| tests/queue-registration.test.ts | src/v2.ts:1851-1864 | `handleQueuePost` in src/v2.ts | `handleQueuePost` — its per-field index refusals |
| tests/queue-registration.test.ts | src/v2.ts:1865-1876 | its entry loop in src/v2.ts (`handleQueuePost`, named in the same sentence) | `handleQueuePost` — its `QueueEntryInput` build |
| tests/queue-seq-finding-cause.test.ts | `defaultedSeqWarnings` (src/v2.ts) | `defaultedSeqWarnings` (since renamed `seqScaleWarnings` (src/v2.ts)) | seqScaleWarnings (renamed in 5a14cc7) |
| tests/release-before-and-after-delivery.test.ts | :405 | `release_ship_date` (the same script) | release_ship_date |
| tests/release-before-and-after-delivery.test.ts | scripts/release.sh:733 | `emit_release_milestone` in `scripts/release.sh` | emit_release_milestone (--released-at) |
| tests/release-before-and-after-delivery.test.ts | src/store.ts:2747 | `recordReleaseProposal` in src/store.ts | Store.recordReleaseProposal convergence |
| tests/release-before-and-after-delivery.test.ts | src/store.ts:3083 | `stampProposalRetired` (src/store.ts) | Store.stampProposalRetired |
| tests/release-provenance.test.ts | :457 | called from `emit_release_milestone` | emit_release_milestone (release_crs call site) |
| tests/release-provenance.test.ts | :778 | the top-level flag `case` that fills `POSITIONAL` | scripts/release.sh top-level argument loop (not a function) |
| tests/release-provenance.test.ts | clients/_crucible_axi.py:1638 | `release_crs` (clients/_crucible_axi.py) | release_crs |
| tests/release-provenance.test.ts | scripts/release.sh:391 | `emit_release_milestone` (scripts/release.sh) | emit_release_milestone |
| tests/release-provenance.test.ts | scripts/release.sh:411 | `release_crs` in `scripts/release.sh` | release_crs |
| tests/release-provenance.test.ts | scripts/release.sh:411 | `release_crs` (scripts/release.sh) | release_crs |
| tests/release-provenance.test.ts | scripts/release.sh:493 | (scripts/release.sh) after `report_unplaceable_crs` | report_unplaceable_crs (already named) |
| tests/release-provenance.test.ts | scripts/release.sh:620-644 | (scripts/release.sh) after `emit_release_milestone` | emit_release_milestone (already named) |
| tests/release-provenance.test.ts | src/store.ts:1701 | `Store.recordMilestoneEvent` (src/store.ts) | recordMilestoneEvent |
| tests/release-provenance.test.ts | src/store.ts:1712-1719 | (src/store.ts) after `Store.recordMilestoneEvent`'s `meta` | recordMilestoneEvent meta (already named) |
| tests/release-provenance.test.ts | src/store.ts:1777 | (src/store.ts) after `Store.repairReleaseProvenance` | repairReleaseProvenance (already named) |
| tests/release-provenance.test.ts | src/store.ts:1800-1805 | `repairReleaseProvenance` (src/store.ts) | repairReleaseProvenance |
| tests/release-provenance.test.ts | src/store.ts:1805 | in `repairReleaseProvenance`, src/store.ts | repairReleaseProvenance (crs-keyed early return) |
| tests/release-provenance.test.ts | src/store.ts:1994 | `Store.listReleases` (src/store.ts) | listReleases |
| tests/release-provenance.test.ts | src/store.ts:2187-2207 | `Store.payloadColumn` (src/store.ts) | payloadColumn |
| tests/release-provenance.test.ts | src/store.ts:2286-2287 | `toEvent` (src/store.ts) | toEvent |
| tests/release-provenance.test.ts | src/v2.ts:1147 | `handleMilestones` (src/v2.ts) | handleMilestones |
| tests/release-provenance.test.ts | src/v2.ts:1160-1186 | `handleMilestones` in `src/v2.ts` | handleMilestones (body-field whitelist) |
| tests/release-provenance.test.ts | src/v2.ts:1164 | (src/v2.ts) after `handleMilestones` | handleMilestones (already named) |
| tests/release-provenance.test.ts | src/v2.ts:1164-1166 | `handleMilestones` in `src/v2.ts` | handleMilestones (crs parse) |
| tests/release-provenance.test.ts | src/v2.ts:1617 | `releaseBrief` (src/v2.ts) | releaseBrief |
| tests/release-provenance.test.ts | src/v2.ts:1664-1672 | `releaseBrief` (src/v2.ts) | releaseBrief |
| tests/release-reporting-live.test.ts | scripts/release.sh:620-644 | `emit_release_milestone` (scripts/release.sh) | emit_release_milestone |
| tests/release-reporting-live.test.ts | scripts/release.sh:649-650 | (in scripts/release.sh), after `emit_release_milestone`'s own two callees | ceremony_agent + client-path callees |
| tests/release-reporting.test.ts | scripts/release.sh:342–350 | `emit_release_milestone` (scripts/release.sh) | emit_release_milestone (already named) |
| tests/release-unification-migration.test.ts | tests/queue-release-membership-mandatory.test.ts:278-308 | `liveBoardQueue` in tests/queue-release-membership-mandatory.test.ts | liveBoardQueue |
| tests/releases.test.ts | src/store.ts:1580 | Store.recordMilestoneEvent (src/store.ts) | recordMilestoneEvent (already named) |
| tests/releases.test.ts | src/v2.ts:1044 | MILESTONE_TYPES (src/v2.ts) | MILESTONE_TYPES (historical, since removed) |
| tests/retention-disposable-kinds.test.ts | :3079 | `LIVE_PROPOSAL`, local to `enforceRetention` in src/store.ts | enforceRetention (LIVE_PROPOSAL, since removed) |
| tests/retention-disposable-kinds.test.ts | src/store.ts:2955-2961 | `toEvent` in src/store.ts | Store.toEvent (kind narrowing) |
| tests/retention-disposable-kinds.test.ts | src/store.ts:3072 | `LIVE_GATE` ... local to `enforceRetention` in src/store.ts | enforceRetention (LIVE_GATE, since removed) |
| tests/retention-disposable-kinds.test.ts | src/store.ts:688 | (then a top-level constant in src/store.ts) | DEFAULT_RETENTION (since removed) |
| tests/roadmap-dead-cr-row.test.ts | public/app-logic.mjs:1269 | `roadmapTableColumns` (`public/app-logic.mjs`) | roadmapTableColumns |
| tests/roadmap-dead-cr-row.test.ts | src/types.ts:411 | `QueueLifecycle` in `src/types.ts` | QueueLifecycle.at |
| tests/roadmap-dead-cr-row.test.ts | src/types.ts:416 | `QueueLifecycle` (`src/types.ts`) | QueueLifecycle |
| tests/roadmap-first-tab.test.ts | public/app-logic.d.mts:65 | the `WorkspaceTab.name` union (public/app-logic.d.mts) | WorkspaceTab interface name union |
| tests/roadmap-first-tab.test.ts | public/app-logic.mjs:75 | `TAB_NAMES` in public/app-logic.mjs | TAB_NAMES |
| tests/roadmap-first-tab.test.ts | public/app.js:119 (, 2386, 2563) | the `state.workspaceTab = "Workflow"` assignment in `navigate`, public/app.js | navigate (landing assignment) |
| tests/roadmap-flow-axis.test.ts | public/app-logic.mjs:173 | `releaseStripFocusIndex` in public/app-logic.mjs | releaseStripFocusIndex |
| tests/roadmap-flow-axis.test.ts | public/app-logic.mjs:173 | `releaseStripFocusIndex` (public/app-logic.mjs) | releaseStripFocusIndex |
| tests/roadmap-flow-axis.test.ts | public/app.js:2953 | `RoadmapDelivered` in public/app.js | RoadmapDelivered (waves.join) |
| tests/roadmap-flow-axis.test.ts | public/app.js:3001 | `RoadmapFlowGate` in public/app.js | RoadmapFlowGate (gate diamond version) |
| tests/roadmap-flow-axis.test.ts | public/styles.css:1253-1258 | the `.app-roadmap-flow` rule in public/styles.css | .app-roadmap-flow |
| tests/roadmap-flow-axis.test.ts | src/types.ts:389-414 | `QueueEntry` (src/types.ts) | QueueEntry |
| tests/roadmap-flow-axis.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (src/v2.ts) | releaseBrief |
| tests/roadmap-flow-axis.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (src/v2.ts) | proposalBrief |
| tests/roadmap-flow-axis.test.ts | src/v2.ts:2053 | from `proposalBrief` in src/v2.ts | proposalBrief (waves field) |
| tests/roadmap-flow-axis.test.ts | tests/e2e/steps/roadmap-graph.steps.ts:84 | the "renders wave {string} holding {int} CR nodes" step in `tests/e2e/steps/roadmap-graph.steps.ts` | roadmap-graph step (wave box locator) |
| tests/roadmap-flow-axis.test.ts | tests/roadmap-wave-header.test.ts:409 | `animatingSelectors` (tests/roadmap-wave-header.test.ts) | animatingSelectors |
| tests/roadmap-gate-date.test.ts | public/app-logic.mjs:80 | `resolveGateDate` (public/app-logic.mjs) | resolveGateDate |
| tests/roadmap-gate-date.test.ts | public/app-logic.mjs:907-918 | "the ship-order read" in public/app-logic.mjs (by line span) | quoted stale citation; ship-order sorter removed by CR-CRU-078 (no successor) |
| tests/roadmap-gate-date.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (src/v2.ts) | releaseBrief |
| tests/roadmap-gate-date.test.ts | src/v2.ts:1759 | `releaseBrief` in `src/v2.ts` | releaseBrief (releasedAt spread) |
| tests/roadmap-gate-date.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (src/v2.ts) | proposalBrief |
| tests/roadmap-gate-date.test.ts | src/v2.ts:2049 | `proposalBrief` in `src/v2.ts` | proposalBrief (targetAt spread) |
| tests/roadmap-registration-routes.test.ts | :1840 | — (removed) | aside about the function moving lines between branches; depended only on the line numbers |
| tests/roadmap-registration-routes.test.ts | src/store.ts:349 | `normalizeTrack` (src/store.ts) | normalizeTrack |
| tests/roadmap-registration-routes.test.ts | src/v2.ts:1833 | `handleQueueGet` (src/v2.ts) | handleQueueGet |
| tests/roadmap-registration-routes.test.ts | src/v2.ts:221-236 | `requireRegisteredCaller` (src/v2.ts) | requireRegisteredCaller |
| tests/roadmap-registration-routes.test.ts | src/v2.ts:2268-2301 | the `/api/v2/projects/` branch of `handleV2` in src/v2.ts | handleV2 (project-scoped dispatch) |
| tests/roadmap-registration-store.test.ts | public/app-logic.mjs:859 | `seq: index` in `buildRoadmapGraph`, public/app-logic.mjs, since removed | buildRoadmapGraph (removed by b481016) |
| tests/roadmap-registration-store.test.ts | src/store.ts:1146-1156 | its table in `createBaseTables`, src/store.ts | createBaseTables (queue_entries DDL) |
| tests/roadmap-registration-store.test.ts | src/store.ts:1709 | `recordMilestoneEvent` (src/store.ts) | recordMilestoneEvent |
| tests/roadmap-registration-store.test.ts | src/store.ts:3032 | `replaceQueue` (src/store.ts) | replaceQueue |
| tests/roadmap-registration-store.test.ts | src/store.ts:3094-3104 | `listQueue` in src/store.ts | listQueue (projection) |
| tests/roadmap-registration-ui.test.ts | public/app-logic.mjs:463 | `coverageHeatSlices` (named in the sentence, public/app-logic.mjs) | `coverageHeatSlices` — its day bucketing |
| tests/roadmap-registration-ui.test.ts | public/app-logic.mjs:874 | `formatReleaseDate` in `public/app-logic.mjs` | successor: the cited `buildRoadmapGraph` ship-order comment is gone (flowchart rework); the seconds contract now lives in `formatReleaseDate`'s doc comment |
| tests/roadmap-registration-ui.test.ts | src/store.ts:2154 | `listReleases` in `src/store.ts` | `listReleases` — its releasedAt-is-seconds sort comment |
| tests/roadmap-registration-ui.test.ts | src/types.ts:218-223 | `RunEvent` in `src/types.ts` | `RunEvent` — its `releasedAt` seconds doc |
| tests/roadmap-registration-ui.test.ts | src/types.ts:397-404 | `QueueEntry` in `src/types.ts` | `QueueEntry` — its `seq` field |
| tests/roadmap-release-focus.test.ts | src/types.ts:365-372 | `QueueLifecycle` (src/types.ts) | QueueLifecycle |
| tests/roadmap-release-focus.test.ts | src/types.ts:389-414 | `QueueEntry` (src/types.ts) | QueueEntry |
| tests/roadmap-release-focus.test.ts | src/types.ts:392 | `QueueEntry`'s `wave` in `src/types.ts` | QueueEntry.wave |
| tests/roadmap-release-focus.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (src/v2.ts) | releaseBrief |
| tests/roadmap-release-focus.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (src/v2.ts) | proposalBrief |
| tests/roadmap-release-strip.test.ts | public/app.js:2554 | — (removed); `roadmapViewMode`, since retired from public/app.js | roadmapViewMode no longer exists |
| tests/roadmap-release-strip.test.ts | public/app.js:2967-2986 | `roadmapStripTeardown` (in `observeRoadmapStrip`) | observeRoadmapStrip teardown call |
| tests/roadmap-release-strip.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (src/v2.ts) | releaseBrief |
| tests/roadmap-release-strip.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (src/v2.ts) | proposalBrief |
| tests/roadmap-selection-durability.test.ts | :2811-2838 | — (removed) | the "citation repaired" aside only recorded an older wrong line number; nothing survives once lines are gone |
| tests/roadmap-selection-durability.test.ts | :2936-2937 | `roadmapFocusVersions`/`roadmapFocusRev` in public/app.js | roadmapFocusVersions / roadmapFocusRev |
| tests/roadmap-selection-durability.test.ts | public/app.js:2629 | `roadmapDrillIn` (public/app.js) | roadmapDrillIn |
| tests/roadmap-selection-durability.test.ts | public/app.js:2924-2925 | `roadmapStripOffsets`/`roadmapStripRev` and ... in public/app.js | roadmapStripOffsets / roadmapStripRev |
| tests/roadmap-selection-durability.test.ts | public/app.js:373 | `startPolling` in public/app.js | startPolling |
| tests/roadmap-selection-durability.test.ts | src/types.ts:389-414 | `QueueEntry` (`src/types.ts`) | QueueEntry |
| tests/roadmap-selection-durability.test.ts | src/types.ts:392 | the `wave` field of `QueueEntry` in `src/types.ts` | QueueEntry.wave |
| tests/roadmap-selection-durability.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (`src/v2.ts`) | releaseBrief |
| tests/roadmap-selection-durability.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (`src/v2.ts`) | proposalBrief |
| tests/roadmap-selection-durability.test.ts | tests/inpane-liveness.test.ts:387-399 | the poll-tick test driven by `waitForPollTick` in tests/inpane-liveness.test.ts | waitForPollTick + the poll-tick liveness test |
| tests/roadmap-track-lanes.test.ts | :2993-3003 | its `roadmap-wave-header` `h4` | RoadmapFlowWave header h4 |
| tests/roadmap-track-lanes.test.ts | public/app-logic.mjs:1152-1159 | `distinctLabels` in public/app-logic.mjs | distinctLabels |
| tests/roadmap-track-lanes.test.ts | public/app-logic.mjs:1176-1182 | `roadmapTableColumns` in public/app-logic.mjs | roadmapTableColumns |
| tests/roadmap-track-lanes.test.ts | public/app-logic.mjs:1457-1464 | the `nextCr` that `focusedReleaseView` in public/app-logic.mjs computes | focusedReleaseView (nextCr) |
| tests/roadmap-track-lanes.test.ts | public/app-logic.mjs:173-181 | `releaseStripFocusIndex` (public/app-logic.mjs) | releaseStripFocusIndex |
| tests/roadmap-track-lanes.test.ts | public/app.js:2495 | `RoadmapRow` in public/app.js | RoadmapRow (roadmap-lane-badge) |
| tests/roadmap-track-lanes.test.ts | public/app.js:2957-3059 | `RoadmapFlowWave` in public/app.js | RoadmapFlowWave |
| tests/roadmap-track-lanes.test.ts | public/app.js:3084-3101 | the lane-grid branch of `RoadmapFlowWave` in public/app.js | RoadmapFlowWave (box.lanes grid branch) |
| tests/roadmap-track-lanes.test.ts | src/types.ts:389-414 | `QueueEntry` (`src/types.ts`) | QueueEntry |
| tests/roadmap-track-lanes.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (`src/v2.ts`) | releaseBrief |
| tests/roadmap-track-lanes.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (`src/v2.ts`) | proposalBrief |
| tests/roadmap-track-lanes.test.ts | tests/roadmap-visual-grammar.test.ts:3688 | the test "the `next` marker renders in the annotation's own faint ink, never the ember" in tests/roadmap-visual-grammar.test.ts | that test |
| tests/roadmap-visual-grammar.test.ts | crucible-workflow-flowchart.html:175-184 | the zone-2 flow's `.wave.active` box, "Wave 5 · active", in `crucible-workflow-flowchart.html` | design mock zone-2 first wave box |
| tests/roadmap-visual-grammar.test.ts | lavish/crucible-workflow-flowchart.html:88 | the `.lanes` rule in `.lavish/crucible-workflow-flowchart.html` | .lanes (grid-template-columns: 54px 1fr) |
| tests/roadmap-visual-grammar.test.ts | src/types.ts:392 | the `wave` field of `QueueEntry` (src/types.ts) | QueueEntry.wave |
| tests/roadmap-wave-active-marker.test.ts | :3100 | `RoadmapFlowWave` (public/app.js) | `RoadmapFlowWave` — its `Wave … · active` label (header comment) |
| tests/roadmap-wave-active-marker.test.ts | public/app.js:3072 | `RoadmapFlowWave` (public/app.js) | `RoadmapFlowWave` — its `data-active` attribute |
| tests/roadmap-wave-active-marker.test.ts | public/app.js:3097-3101 | `RoadmapFlowWave` in public/app.js | `RoadmapFlowWave` — its wave header |
| tests/roadmap-wave-active-marker.test.ts | public/app.js:3100 | `RoadmapFlowWave` in public/app.js | `RoadmapFlowWave` — its `Wave … · active` label (`MARKER` doc) |
| tests/roadmap-wave-drops-dead-crs.test.ts | public/app-logic.mjs:1237 | `declaredLabel` (public/app-logic.mjs) | `declaredLabel` |
| tests/roadmap-wave-drops-dead-crs.test.ts | public/app-logic.mjs:1280 | `ROADMAP_WAVE_ROWS` in public/app-logic.mjs | `ROADMAP_WAVE_ROWS` |
| tests/roadmap-wave-drops-dead-crs.test.ts | public/app-logic.mjs:1308 | `roadmapMerged` (named with public/app-logic.mjs) | `roadmapMerged` |
| tests/roadmap-wave-drops-dead-crs.test.ts | public/app-logic.mjs:1517-1519 | `focusedReleaseView` in public/app-logic.mjs | `focusedReleaseView` — its loose-group `box.rows` copy |
| tests/roadmap-wave-drops-dead-crs.test.ts | public/app-logic.mjs:1533 | `focusedReleaseView` in public/app-logic.mjs | `focusedReleaseView` — its `box.mergedCount` roll-up |
| tests/roadmap-wave-drops-dead-crs.test.ts | public/app.js:3250 | `RoadmapTableZone` in public/app.js | `RoadmapTableZone` — its `view.members` rows |
| tests/roadmap-wave-drops-dead-crs.test.ts | public/app.js:3596-3599 | `RoadmapFlowWave` in `public/app.js` | `RoadmapFlowWave` — its `app-flow-loose` branch |
| tests/roadmap-wave-drops-dead-crs.test.ts | public/app.js:3604 | `RoadmapFlowWave` in public/app.js | `RoadmapFlowWave` — its `data-cr-count` and wave-count header (the `/3645` second line number removed with it) |
| tests/roadmap-wave-drops-dead-crs.test.ts | src/types.ts:392 | the `wave` field of `QueueEntry` in `src/types.ts` | `QueueEntry` — its `wave` field |
| tests/roadmap-wave-drops-dead-crs.test.ts | tests/roadmap-visual-grammar.test.ts:3806 | tests/roadmap-visual-grammar.test.ts (its "the same 29 members drawn UNTRIMMED…" test) | the test "the same 29 members drawn UNTRIMMED are several times taller…" — its `.app-flow-loose` query |
| tests/roadmap-wave-header.test.ts | :2791 | — (removed) | the data-cr-count attribute is already named in the sentence; the bare line added nothing |
| tests/roadmap-wave-header.test.ts | public/app.js:2797 | `RoadmapFlowWave` in public/app.js | RoadmapFlowWave (data-active) |
| tests/roadmap-wave-header.test.ts | public/app.js:2802 | (the same function) | RoadmapFlowWave (wave label) |
| tests/roadmap-wave-header.test.ts | public/app.js:2892 | as `RoadmapFlowZone` in public/app.js publishes it | RoadmapFlowZone (view.crCount) |
| tests/roadmap-wave-header.test.ts | src/types.ts:389-414 | `QueueEntry` (`src/types.ts`) | QueueEntry |
| tests/roadmap-wave-header.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (`src/v2.ts`) | releaseBrief |
| tests/roadmap-wave-header.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (`src/v2.ts`) | proposalBrief |
| tests/roadmap-wave-rollup.test.ts | clients/_crucible_axi.py:1301 | `isActionable` in `src/next.ts` (successor) | client actionability rule deleted with the S4 boundary retirement; successor isActionable |
| tests/roadmap-wave-rollup.test.ts | clients/_crucible_axi.py:1473 | `resolveNext` in `src/next.ts`, successor of the client's `resolve_next` | resolve_next deleted; successor resolveNext |
| tests/roadmap-wave-rollup.test.ts | public/app-logic.mjs:1015 | `CR_STATUS_MARK` in public/app-logic.mjs | CR_STATUS_MARK |
| tests/roadmap-wave-rollup.test.ts | public/app-logic.mjs:179 | `releaseStripFocusIndex` in public/app-logic.mjs | releaseStripFocusIndex |
| tests/roadmap-wave-rollup.test.ts | public/app-logic.mjs:43-46 | the doc comment on `formatReleaseDate` in public/app-logic.mjs | formatReleaseDate doc comment |
| tests/roadmap-wave-rollup.test.ts | public/app-logic.mjs:69-70 | the `unusable` case documented on `resolveGateDate` in public/app-logic.mjs | resolveGateDate doc comment (unusable) |
| tests/roadmap-wave-rollup.test.ts | public/app-logic.mjs:80 | `resolveGateDate` (public/app-logic.mjs) | resolveGateDate |
| tests/roadmap-wave-rollup.test.ts | public/app.js:2678 | `roadmapDrillable` is `IN_PROGRESS \|\| COMPLETED` (public/app.js) | roadmapDrillable |
| tests/roadmap-wave-rollup.test.ts | public/app.js:2678 | `roadmapDrillable` is IN_PROGRESS \|\| COMPLETED (public/app.js) | roadmapDrillable |
| tests/roadmap-wave-rollup.test.ts | public/app.js:2792-2853 | `RoadmapFlowWave` in public/app.js | RoadmapFlowWave |
| tests/roadmap-wave-rollup.test.ts | public/app.js:2910 | `RoadmapFlowGate` in `public/app.js` | RoadmapFlowGate (data-date-state) |
| tests/roadmap-wave-rollup.test.ts | public/styles.css:1323-1335 | the `.app-flow-node` rule in public/styles.css | .app-flow-node selector |
| tests/roadmap-wave-rollup.test.ts | public/styles.css:1372-1377 | the `.app-flow-node.in_progress` rule in public/styles.css | .app-flow-node.in_progress selector |
| tests/roadmap-wave-rollup.test.ts | src/types.ts:389-414 | `QueueEntry` (`src/types.ts`) | QueueEntry |
| tests/roadmap-wave-rollup.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (`src/v2.ts`) | releaseBrief |
| tests/roadmap-wave-rollup.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (`src/v2.ts`) | proposalBrief |
| tests/roadmap-wave-rollup.test.ts | tests/e2e/steps/roadmap-graph.steps.ts:84 | the "the roadmap flowchart for release {string} renders wave {string} holding {int} CR nodes within {int} seconds" step in `tests/e2e/steps/roadmap-graph.steps.ts` | that Step definition |
| tests/roadmap-wave-rollup.test.ts | tests/roadmap-wave-header.test.ts:409 | `animatingSelectors` (tests/roadmap-wave-header.test.ts) | animatingSelectors |
| tests/roadmap-wave-rows.test.ts | clients/_crucible_axi.py:1301 | `_is_actionable`, once in clients/_crucible_axi.py, now `isActionable` in src/next.ts | _is_actionable (deleted by CR-CRU-098; successor isActionable) |
| tests/roadmap-wave-rows.test.ts | public/app-logic.mjs:1015 | `CR_STATUS_MARK` in public/app-logic.mjs | CR_STATUS_MARK |
| tests/roadmap-wave-rows.test.ts | public/app-logic.mjs:1154 | `focusedReleaseView` in public/app-logic.mjs | focusedReleaseView |
| tests/roadmap-wave-rows.test.ts | public/app-logic.mjs:179 | `releaseStripFocusIndex` in public/app-logic.mjs | releaseStripFocusIndex |
| tests/roadmap-wave-rows.test.ts | public/app.js:2791 | `RoadmapFlowWave` in public/app.js | RoadmapFlowWave (data-cr-count) |
| tests/roadmap-wave-rows.test.ts | public/app.js:2819 | `RoadmapFlowWave` in public/app.js | RoadmapFlowWave (app-flow-wave-body) |
| tests/roadmap-wave-rows.test.ts | public/app.js:3055 | `RoadmapStripTag` (public/app.js) | RoadmapStripTag (◀ N earlier / N later ▶) |
| tests/roadmap-wave-rows.test.ts | public/app.js:3055 | `RoadmapStripTag` in public/app.js | RoadmapStripTag |
| tests/roadmap-wave-rows.test.ts | public/app.js:3116-3118 | `RoadmapStripZone` in public/app.js | RoadmapStripZone (window attributes) |
| tests/roadmap-wave-rows.test.ts | public/app.js:3116-3118 | `RoadmapStripZone` in public/app.js | RoadmapStripZone |
| tests/roadmap-wave-rows.test.ts | public/styles.css:1269-1276 | the `.app-flow-wave-body` rule in public/styles.css | .app-flow-wave-body (flex-wrap rule) |
| tests/roadmap-wave-rows.test.ts | public/styles.css:1269-1276 | the `.app-flow-wave-body` rule in public/styles.css | .app-flow-wave-body |
| tests/roadmap-wave-rows.test.ts | public/styles.css:1351 | the `.app-flow-node.in_progress` rule in public/styles.css | .app-flow-node.in_progress |
| tests/roadmap-wave-rows.test.ts | src/types.ts:389-414 | `QueueEntry` (src/types.ts) | QueueEntry |
| tests/roadmap-wave-rows.test.ts | src/v2.ts:1755-1763 | `releaseBrief` (src/v2.ts) | releaseBrief |
| tests/roadmap-wave-rows.test.ts | src/v2.ts:2045-2057 | `proposalBrief` (src/v2.ts) | proposalBrief |
| tests/roadmap-wave-rows.test.ts | tests/e2e/steps/roadmap-graph.steps.ts:84 | the "renders wave … holding … CR nodes", "carries status" and "I click the roadmap flowchart node" steps in `tests/e2e/steps/roadmap-graph.steps.ts` | roadmap-graph steps (lines 84,96,102) |
| tests/roadmap-wave-rows.test.ts | tests/e2e/steps/roadmap-graph.steps.ts:84 | the "renders wave … holding … CR nodes" step in `tests/e2e/steps/roadmap-graph.steps.ts` | roadmap-graph wave-box step |
| tests/roadmap-wave-rows.test.ts | tests/e2e/steps/roadmap-graph.steps.ts:84 | tests/e2e/steps/roadmap-graph.steps.ts (its three roadmap-node steps) | roadmap-graph steps (84,96,102) |
| tests/roadmap-wave-rows.test.ts | tests/roadmap-wave-header.test.ts:409 | `animatingSelectors` (tests/roadmap-wave-header.test.ts) | animatingSelectors |
| tests/run-cards.test.ts | tests/coverage-click.test.ts:244-247 | `afterEach` in tests/coverage-click.test.ts | the describe-scoped `afterEach` of the "coverage meter click wiring" describe |
| tests/run-lifecycle.test.ts | src/store.ts:631-638 | `MIGRATIONS` / `SCHEMA_VERSION` (both in src/store.ts) | MIGRATIONS, SCHEMA_VERSION |
| tests/run-lifecycle.test.ts | src/store.ts:874-898 | the `events` table in `createBaseTables`, src/store.ts | createBaseTables (events CREATE TABLE) |
| tests/run-lifecycle.test.ts | src/store.ts:874-898 | the `events` table in `createBaseTables`, src/store.ts | createBaseTables (events CREATE TABLE) |
| tests/run-lifecycle.test.ts | src/types.ts:146-191 | `RunEvent` (src/types.ts) | RunEvent |
| tests/run-lifecycle.test.ts | src/v2.ts:1908-1916 | `handleV2` (src/v2.ts) | handleV2 (/runs routes) |
| tests/run-lifecycle.test.ts | src/v2.ts:1908-1916 | `handleV2` in src/v2.ts | handleV2 route dispatch (thrown Error message) |
| tests/server-limits-are-configuration.test.ts | src/server.ts:311 | `retentionDisclosure` in src/server.ts | the doc comment on `retentionDisclosure` (boot disclosure) |
| tests/server-limits-are-configuration.test.ts | src/store.ts:744 | `defaultRetention()` in src/store.ts | `defaultRetention` |
| tests/server-limits-are-configuration.test.ts | src/store.ts:744 | `defaultRetention` (src/store.ts) | defaultRetention (thrown Error message) |
| tests/server-limits-are-configuration.test.ts | src/store.ts:834 | `DEFAULT_RUN_ABANDON_MS` (in src/store.ts, since retired) | `DEFAULT_RUN_ABANDON_MS` — retired constant, now only named in `runAbandonAfterMs`'s doc comment |
| tests/server-limits-are-configuration.test.ts | src/store.ts:834 | `runAbandonAfterMs` (src/store.ts) | runAbandonAfterMs (retired DEFAULT_RUN_ABANDON_MS; thrown Error message) |
| tests/server-limits-are-configuration.test.ts | src/store.ts:836 | `runAbandonAfterMs()` in src/store.ts | `runAbandonAfterMs` |
| tests/server-limits-are-configuration.test.ts | src/v2.ts:362 | `DEFAULT_PROJECT_INACTIVE_MS` (in src/v2.ts, since retired) | `DEFAULT_PROJECT_INACTIVE_MS` — retired constant, now only named in `projectInactiveMs`'s doc comment |
| tests/server-limits-are-configuration.test.ts | src/v2.ts:362 | `projectInactiveMs` (src/v2.ts) | projectInactiveMs (retired DEFAULT_PROJECT_INACTIVE_MS; thrown Error message) |
| tests/server-limits-are-configuration.test.ts | src/v2.ts:366 | `projectInactiveMs()` in src/v2.ts | `projectInactiveMs` |
| tests/server-listener-is-configuration.test.ts | :218 | `startServer` in src/server.ts | startServer (resolveStore call) |
| tests/server-listener-is-configuration.test.ts | :226-245 | `startServer` in src/server.ts | startServer (shared healthPayload) |
| tests/server-listener-is-configuration.test.ts | :291 | `startServer` in src/server.ts | startServer (returned handle) |
| tests/server-listener-is-configuration.test.ts | :94 | `ServerHandle` (src/server.ts) | ServerHandle.storeResolution |
| tests/server-listener-is-configuration.test.ts | src/limits.ts:158 | `serverConfigPath` (src/limits.ts) | serverConfigPath |
| tests/server-listener-is-configuration.test.ts | src/server.ts:249-252 | read by `startServer` in src/server.ts | startServer (CRUCIBLE_PORT/CRUCIBLE_HOST env reads) |
| tests/server-listener-is-configuration.test.ts | src/server.ts:39-79 | `resolveStore` in src/server.ts | resolveStore |
| tests/shim-retirement.test.ts | v2.ts:756 | `PATCHABLE_FIELDS` (src/v2.ts) | PATCHABLE_FIELDS |
| tests/shipped-limits-ship-as-package-data.test.ts | clients/_crucible_axi.py:120 | `_SHIPPED_LIMITS` (a table then in clients/_crucible_axi.py) | _SHIPPED_LIMITS (since moved to package data) |
| tests/shipped-limits-ship-as-package-data.test.ts | clients/_crucible_axi.py:121 | the three entry keys of each of those two tables | _SHIPPED_LIMITS entry keys (121/134/147) |
| tests/shipped-limits-ship-as-package-data.test.ts | clients/_crucible_axi.py:125-155 | clients/_crucible_axi.py's `_SHIPPED_LIMITS` | _SHIPPED_LIMITS numeric literals |
| tests/shipped-limits-ship-as-package-data.test.ts | src/limits.ts:90 | `SHIPPED` (a table then in src/limits.ts) | SHIPPED (since moved to package data, §S1c) |
| tests/shipped-limits-ship-as-package-data.test.ts | src/limits.ts:91 | the three entry keys of each of those two tables | SHIPPED entry keys (91/104/117) |
| tests/shipped-limits-ship-as-package-data.test.ts | src/limits.ts:96-129 | src/limits.ts's `SHIPPED` | SHIPPED numeric literals |
| tests/store-disclosure.test.ts | src/server.ts:192 | `startServer` in src/server.ts | startServer (resolveDbPath/resolveStore call site) |
| tests/store-disclosure.test.ts | src/server.ts:200 | in `startServer`, src/server.ts | startServer (healthPayload closure) |
| tests/store-migration.test.ts | src/server.ts:226 | closure in src/server.ts after `healthPayload()` | healthPayload (already named) |
| tests/store-migration.test.ts | src/store.ts:326 | `Store.open` (src/store.ts) | Store.open (already named) |
| tests/store-migration.test.ts | src/store.ts:438-574 | inside `createTables()` | createTables (ALTER TABLE retrofits; since split into createBaseTables + migrations) |
| tests/store-migration.test.ts | src/store.ts:488 (/599) | `backfillInferredEventRoles` in src/store.ts, called from `createTables()` | backfillInferredEventRoles |
| tests/storyboard-fidelity.test.ts | lavish/crucible-v2-design.html:541 | the COVERAGE TREND card in .lavish/crucible-v2-design.html | COVERAGE TREND mock card |
| tests/timeline-plan-integration.test.ts | src/types.ts:131-137 | `PlanCycle` in src/types.ts | PlanCycle |
| tests/timeline-plan-integration.test.ts | src/types.ts:162 | on `Plan` in src/types.ts | Plan.closedAt |
| tests/toon-conformance.test.ts | _crucible_axi.py:84 | `emit_axi` in `clients/_crucible_axi.py` | `emit_axi` — its TOON stdout write |
| tests/toon-conformance.test.ts | clients/_crucible_axi.py:3242-3248 | `cmd_register` in `clients/_crucible_axi.py` | `cmd_register` — its `emit("register", …)` call |
| tests/toon-conformance.test.ts | clients/bun-crucible.py:357-438 | `clients/bun-crucible.py` (`_register_agent`/`cmd_register`, named on the next line) | `_register_agent` and `cmd_register` |
| tests/undelivered-release-is-the-plannable-target.test.ts | :382 | `missingRelease`'s | missingRelease |
| tests/undelivered-release-is-the-plannable-target.test.ts | :382 | `missingRelease` | missingRelease |
| tests/undelivered-release-is-the-plannable-target.test.ts | :398 | `missingTarget` | missingTarget |
| tests/undelivered-release-is-the-plannable-target.test.ts | :403 | `unproposedRelease` | unproposedRelease |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/hints.ts:382 | src/hints.ts | missingRelease (already named) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/hints.ts:382/398/403 | three `roadmapHints` arrays (src/hints.ts) | roadmapHints missingRelease/missingTarget/unproposedRelease |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/hints.ts:382/398/403 | the `missingRelease`, `missingTarget` and `unproposedRelease` arrays of `roadmapHints` in src/hints.ts | roadmapHints release-proposals lines |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/hints.ts:398 | src/hints.ts | missingTarget (already named) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/hints.ts:403 | src/hints.ts | unproposedRelease (already named) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/hints.ts:404 | `unproposedRelease` (src/hints.ts) | roadmapHints.unproposedRelease (shipped-is-settled line) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/hints.ts:404 | `unproposedRelease` in src/hints.ts | unproposedRelease (section header) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/hints.ts:404 | `unproposedRelease` in src/hints.ts | roadmapHints.unproposedRelease settled-history line |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/store.ts:2884 | `recordReleaseProposal` (src/store.ts) | recordReleaseProposal (convergence) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/store.ts:2884 | `recordReleaseProposal` in src/store.ts | recordReleaseProposal (section header) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/store.ts:2884 | `recordReleaseProposal` in src/store.ts | Store.recordReleaseProposal convergence |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/store.ts:2905 | `recordReleaseProposal` (src/store.ts) | recordReleaseProposal (stampProposalRetired site 2) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/store.ts:2905 | `recordReleaseProposal` in src/store.ts, its `stampProposalRetired` revision branch | stampProposalRetired call in recordReleaseProposal |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/store.ts:3424/3382 | src/store.ts | listReleaseProposals/listReleases (already named) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/store.ts:3424/3382 | `listReleaseProposals` / `listReleases` in src/store.ts | Store.listReleaseProposals / Store.listReleases |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/v2.ts:2837 | `declareMembership` (src/v2.ts) | declareMembership (plannable-target gate) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/v2.ts:2837 | `declareMembership` in src/v2.ts | declareMembership plannable-target gate (consumer 1) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/v2.ts:2837 | `declareMembership` in src/v2.ts | declareMembership plannable-target gate (consumer 1, other direction) |
| tests/undelivered-release-is-the-plannable-target.test.ts | src/v2.ts:2837 + src/hints.ts:401-405 | `declareMembership` in src/v2.ts + `unproposedRelease` in src/hints.ts | declareMembership / unproposedRelease |
| tests/v2-json-only-responses.test.ts | :161 | — (removed) | the five TOON names (`wantsToon`, `truncatedToon`, `jsonVariantUrl`, `TOON_MAX_BYTES`, `toToon`) are named in the test title; the lines are gone with them |
| tests/v2-json-only-responses.test.ts | :164 | — (removed) | as above |
| tests/v2-json-only-responses.test.ts | :170 | — (removed) | as above |
| tests/v2-json-only-responses.test.ts | :181 | — (removed) | as above |
| tests/v2-json-only-responses.test.ts | :33 | — (removed) | as above |
| tests/v2-json-only-responses.test.ts | src/v2.ts:213 | `reply` in `src/v2.ts` | `reply` — its (since deleted) TOON branch |
| tests/v2-json-only-responses.test.ts | src/v2.ts:3619 | `handleEventsList`'s ANCHORED branch (in `src/v2.ts`) | `handleEventsList` — its `?cycleId=` anchored branch |
| tests/v2-json-only-responses.test.ts | src/v2.ts:3640 | the same function's other branch | `handleEventsList` — its unanchored recent-N branch |
| tests/v2-json-only-responses.test.ts | src/v2.ts:3673 | `handleEventGet` (`src/v2.ts`) | `handleEventGet` — its `?suite=<name>` arm (named by query string; file named on the handler) |
| tests/v2-json-only-responses.test.ts | src/v2.ts:3681 | `handleEventGet` (`src/v2.ts`) | `handleEventGet` — its `?depth=suites` arm (named by query string; file named on the handler) |
| tests/v2-json-only-responses.test.ts | src/v2.ts:3683 | `handleEventGet` (`src/v2.ts`) | `handleEventGet` — its plain whole-event arm (file named on the handler) |
| tests/wave-loose-box-truthful.test.ts | :3374 | — (removed) | re-pin history of the line number (the miscited `let active` range) |
| tests/wave-loose-box-truthful.test.ts | :3377 | — (removed) | re-pin history of the line number; kept only as "re-pinned twice" with its CR id |
| tests/wave-loose-box-truthful.test.ts | public/app-logic.mjs:1082 | `declaredLabel` (public/app-logic.mjs) | `declaredLabel` |
| tests/wave-loose-box-truthful.test.ts | public/app.js:3604 | `RoadmapFlowWave` in public/app.js | `RoadmapFlowWave` — its `box.entries.length` header count (the `/3645` second line number removed with it) |
| tests/wave-loose-box-truthful.test.ts | src/store.ts:3388 | `waveScopeRefusal` in src/store.ts | `waveScopeRefusal` — its `if (row.wave === "") continue;` |
| tests/wave-loose-box-truthful.test.ts | src/types.ts:389-414 | `QueueEntry` (`src/types.ts`) | `QueueEntry` |
| tests/wave-loose-box-truthful.test.ts | src/types.ts:392 | the `wave` field of `QueueEntry` in `src/types.ts` | `QueueEntry` — its `wave` field |
| tests/wave-run-compression.test.ts | src/types.ts:392 | the `wave` field of `QueueEntry` in `src/types.ts` | `QueueEntry` — its `wave` field |
| tests/wave-run-compression.test.ts | tests/roadmap-release-focus.test.ts:153 | the `Logic` cast in tests/roadmap-release-focus.test.ts | `Logic` — the module-level `AppLogic as unknown as {…}` cast |
| tests/wave-single-active.test.ts | :1375-1460 | `handlePlanFile` in src/v2.ts | handlePlanFile (ledger row) |
| tests/wave-single-active.test.ts | :2941-2951 | its dispatch in `handlePlansRoute` in src/v2.ts | handlePlansRoute (ledger row) |
| tests/wave-single-active.test.ts | :2941-2951 | `handlePlansRoute` dispatches (line dropped) | handlePlansRoute (RED snapshot) |
| tests/wave-single-active.test.ts | :3238-3264 | — (removed) | re-pin trail in the census test comment, dropped with the line numbers it recorded |
| tests/wave-single-active.test.ts | :3269-3295 | `transitionCycle`'s refusals in src/store.ts | transitionCycle (ledger row, 2026-09-09) |
| tests/wave-single-active.test.ts | :3269-3295 | — (removed) | re-pin trail in the census test comment, dropped with the line numbers it recorded |
| tests/wave-single-active.test.ts | :3280-3306 | `transitionCycle`'s refusals in src/store.ts | transitionCycle (ledger row, 2026-09-10) |
| tests/wave-single-active.test.ts | :4256-4262 | `deriveQueueStatus` in src/store.ts | deriveQueueStatus (ledger row) |
| tests/wave-single-active.test.ts | :4267-4273 | `deriveQueueStatus` in src/store.ts | deriveQueueStatus (ledger row, 2026-09-10) |
| tests/wave-single-active.test.ts | :4281-4303 | `Store.queueStatusOf` in src/store.ts | Store.queueStatusOf (ledger row, 2026-09-10) |
| tests/wave-single-active.test.ts | :4349-4355 | `deriveQueueStatus` in src/store.ts | deriveQueueStatus (ledger row, 2026-09-12) |
| tests/wave-single-active.test.ts | :4363-4385 | `Store.queueStatusOf` in src/store.ts | Store.queueStatusOf (ledger row, 2026-09-12) |
| tests/wave-single-active.test.ts | :4363-4385 | `Store.queueStatusOf` (line dropped) | Store.queueStatusOf (activeness section) |
| tests/wave-single-active.test.ts | :4372 | the in-flight rule line in `Store.queueStatusOf` | Store.queueStatusOf (plans.find open) — ledger row |
| tests/wave-single-active.test.ts | :4372 | `plans.find((plan) => plan.status === "open")` (line dropped) | Store.queueStatusOf in-flight rule (activeness section) |
| tests/wave-single-active.test.ts | src/store.ts:2218-2228 | `recordReleaseProposal` (in src/store.ts) | recordReleaseProposal |
| tests/wave-single-active.test.ts | src/store.ts:3280-3306 | `transitionCycle` (src/store.ts) | transitionCycle (refusals) — header |
| tests/wave-single-active.test.ts | src/store.ts:3280-3306 | `transitionCycle` in src/store.ts | transitionCycle (census test comment; re-pin trail removed with it) |
| tests/wave-single-active.test.ts | src/store.ts:4349-4355 | `deriveQueueStatus` (src/store.ts) | deriveQueueStatus (activeness section) |
| tests/wave-single-active.test.ts | src/store.ts:589-596 | `PlanOpError`'s `code` union (src/store.ts) | PlanOpError.code (the comment's `CycleTransitionError` never existed as an identifier; renamed to the real construct) |
| tests/wave-single-active.test.ts | src/store.ts:603 | the `WaveScopeError` block after `PlanOpError` (src/store.ts) | WaveScopeError insertion point |
| tests/wave-single-active.test.ts | src/types.ts:392 | the `wave` field of `QueueEntry` in src/types.ts | QueueEntry.wave |
| tests/wave-single-active.test.ts | src/v2.ts:1375-1460 | `handlePlanFile` (src/v2.ts) | handlePlanFile (RED snapshot) |
| tests/wave-single-active.test.ts | store.ts:3238-3264 | `transitionCycle`'s refusals in src/store.ts | transitionCycle (ledger row, 2026-09-09) |
| tests/wave-single-active.test.ts | store.ts:3269-3295 | `transitionCycle`'s refusals in src/store.ts | transitionCycle (ledger row, 2026-09-10) |
| tests/wave-single-active.test.ts | store.ts:4098-4111 | `deriveQueueStatus` in src/store.ts | deriveQueueStatus (ledger row) |
| tests/wave-single-active.test.ts | store.ts:4256-4262 | `deriveQueueStatus` in src/store.ts | deriveQueueStatus (ledger row, 2026-09-10) |
| tests/wave-single-active.test.ts | store.ts:4267-4273 | `deriveQueueStatus` in src/store.ts | deriveQueueStatus (ledger row, 2026-09-12) |
| tests/wave-single-active.test.ts | store.ts:4270-4292 | `Store.queueStatusOf` in src/store.ts | Store.queueStatusOf (ledger row, 2026-09-10) |
| tests/wave-single-active.test.ts | store.ts:4281-4303 | `Store.queueStatusOf` in src/store.ts | Store.queueStatusOf (ledger row, 2026-09-12) |
| tests/wave-single-active.test.ts | store.ts:4290 | the in-flight rule line in `Store.queueStatusOf` | Store.queueStatusOf (plans.find open) |
| tests/wave-single-active.test.ts | v2.ts:1367-1436 | `handlePlanFile` in src/v2.ts | handlePlanFile (ledger row) |
| tests/wave-single-active.test.ts | v2.ts:2918-2928 | its dispatch in `handlePlansRoute` in src/v2.ts | handlePlansRoute (ledger row) |
| tests/workflow-gate-widget.test.ts | app.js:1999 | `WorkflowActive()` (public/app.js) | WorkflowActive |
| tests/workflow-gate-widget.test.ts | app.js:2268 | `WorkflowFeed()` (public/app.js) | WorkflowFeed |
| tests/workflow-gate-widget.test.ts | tests/workflow-lens.test.ts:566 | the tests/workflow-lens.test.ts test "no dedicated wave API route exists in src/ — wave state is inferred from plans only" | that test |
| tests/workflow-history-refinements.test.ts | :4378-4382 | `crRootProps` (public/app.js) | `crRootProps` — its `workflow-cr-root` testid |
| tests/workflow-history-refinements.test.ts | :4384-4425 | `WorkflowActive` (public/app.js) | `WorkflowActive` |
| tests/workflow-history-refinements.test.ts | :4739-4751 | `WorkflowHistory` (public/app.js) | `WorkflowHistory` |
| tests/workflow-history-refinements.test.ts | public/app.js:4611-4621 | `LensCrGroup` (public/app.js) | `LensCrGroup` |
| tests/workflow-history-refinements.test.ts | src/types.ts:168 | `Plan` in src/types.ts | `Plan` — its `closedAt` field |
| tests/workflow-history-refinements.test.ts | src/types.ts:346 | `Plan` in src/types.ts | `Plan` — its `status` union (`aborted`) |
| tests/workflow-lens.test.ts | :458 | `LensCrNode.status` there | LensCrNode.status |
| tests/workflow-lens.test.ts | :898-918 | the inferred-fallback loop | workflowLens inferred-node loop |
| tests/workflow-lens.test.ts | :927 | the `declaredWaveLabels` precedent in the same function | declaredWaveLabels |
| tests/workflow-lens.test.ts | public/app-logic.d.mts:415 | `LensPlanLike` in public/app-logic.d.mts | LensPlanLike.status |
| tests/workflow-lens.test.ts | public/app-logic.mjs:687 | `agentStemRaw` in `public/app-logic.mjs` | agentStemRaw |
| tests/workflow-lens.test.ts | public/app-logic.mjs:882-918 | the inferred-fallback loop in `workflowLens` | workflowLens inferred-node loop |
| tests/workflow-lens.test.ts | public/app-logic.mjs:934 | in `public/app-logic.mjs` (`workflowLens`'s History filter) | workflowLens wave.crs History filter |
| tests/workflow-lens.test.ts | public/app-logic.mjs:938 | `wave.crs.sort` in `workflowLens` (`public/app-logic.mjs`) | workflowLens closedAt stable sort |
| tests/workflow-lens.test.ts | public/app-logic.mjs:996-998 | `visibleWaves` in `public/app-logic.mjs` | visibleWaves ghost-header filter |
| tests/workflow-lens.test.ts | src/types.ts:346 | `Plan` in src/types.ts | Plan.status |
| tests/workflow-primary-tab.test.ts | public/app.js:119 (, 2386, 2563) | the `state.workspaceTab = "Workflow"` assignment in `navigate`, public/app.js | navigate (landing assignment) |
| tests/workflow-tab.test.ts | public/app.js:153 | `startPolling` in public/app.js | startPolling (5000ms interval) |
| tests/workflow-tab.test.ts | src/v2.ts:638 | `handlePlansList` in src/v2.ts | handlePlansList |
| tests/workflow-tab.test.ts | src/v2.ts:717 | `eventBrief` in src/v2.ts | eventBrief (context passthrough) |
