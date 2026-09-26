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
