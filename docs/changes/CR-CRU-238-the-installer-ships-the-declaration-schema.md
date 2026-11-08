# CR-CRU-238 — the installer ships the declaration schema

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-225, CR-CRU-233,
CR-CRU-203, CR-CRU-237 · **Status** PENDING — filed 2026-11-08 at Model B's request (Sandesh 1547)
with the user's rulings of 2026-11-08; made exact at gap analysis 2026-11-08 (user rulings
2026-11-08) · Pre-review: due — 8 points and user rulings

## Problem

Every project declares how its tests run, in its own Crucible declaration: bun in `package.json`
`crucible.targets`, the other stacks in `crucible.toml` `[targets.<key>]`. Model B's scaffold
(CR-MDB-099: `init`, `migrate`, `agents`) will write that declaration for a project.

- The declaration's vocabulary exists only inside each client: the bun client's `crucible.targets`
  checks, the rust client's `[targets.<profile>]` table, and the arduino and maven tables of
  CR-CRU-203 and CR-CRU-237.
- Nothing outside the clients can read it. A second writer would have to copy it, and the copies
  would drift.
- Model B's ruling (DN-multi-harness-deploy-model §D29 amendment, 2026-11-08): Crucible's clients read
  the declaration, so Crucible defines it, and ships it as a machine-readable file both writers read.

## Scope

- **§S1 — the schema file.** The installer ships `crucible-declaration.schema.json` beside the
  clients, as a fleet file, and lists it in `crucible-clients.json`.
- **§S2 — one source.** The clients' declaration checks and the schema cannot disagree. Chosen by
  cost at gap analysis: a test pins every client's accepted vocabulary to the schema, and the clients
  keep their own constants. Having the clients read the schema would make every verb depend on one
  more file at start, and bun's cross-field rules would stay in code anyway.
- **§S4 — one skip rule.** An entry under a client's key that names another stack's framework is
  skipped, not refused, by every client. Rust adopts the rule arduino and maven already follow, and
  every client's skip set includes the reserved `go-test`.
- **§S3 — the contract with writers.** The schema states the versioning rule a writer follows.

## Design (user rulings 2026-11-08)

- **Format:** JSON, readable with any runtime's standard library. The file is a plain descriptor,
  not a JSON Schema dialect, and says so; the ruled filename stays. `version` is an integer,
  starting at 1.
- **Shape:** a top-level `version`, and a `stacks` map. Each stack names:
  - where its declaration lives (file and table or key);
  - how an entry's key is formed (bun: the `test:<tier>` script; rust: the nextest profile; arduino:
    the native dir relative to the project dir, joined by `/` to the make target; maven: the tier);
  - each field, its allowed values, its default, whether it is required, and the refused fields;
  - its stack table, where it has one: `[bun] package_dir` and `[python] runner` (`unittest` by
    default, or `pytest`; a flag overrides it; a file that does not parse declares nothing);
  - bun's `"test": true` marker (JSON `true` only, on one entry at most).
- **Field descriptors:** `values` is either a list or `board-listed: codecs.<kind>` for an open
  codec name (`stream.codec`, `console`), which the client checks against the board's health at run
  time. Cross-field rules are stated as `requires` and `excludes`: for bun, exactly one of `stream`
  and `junit`; `console` only on a `junit` entry; `bun-console` only with `bun-test`; `coverage` only
  `lcov`, on a `junit: "flag"` `bun-test` entry; `stream.path` only `env:CRUCIBLE_STREAM`.
- **Skip rule:** the schema states §S4, and that `[targets.<key>]` is one flat namespace: a key holds
  one stack's entry, and the other stacks skip it.
  - The reserved frameworks per stack: `bun-test`, `vitest`, `playwright`, `playwright-bdd` (bun);
    `nextest` (rust); `pytest`, `unittest` (python); `surefire` (maven); `arduino-native`; `go-test`.
- **A newer schema than the writer knows:** the writer writes the stacks and fields it knows, and
  warns, naming the schema version. It never removes a field it does not know. A newer Crucible never
  blocks a writer.
- **Release notes:** every change to the schema bumps `version` and is listed under "Stack
  declaration changes".

## Acceptance criteria

- [ ] **AC1 — the installer ships and lists the schema.** An install lays down
  `crucible-declaration.schema.json` beside the clients, and `crucible-clients.json` lists it as
  `declaration_schema: {path, version}`, the version read from the shipped file. An upgrade
  overwrites it. Like every fleet file, an uninstall leaves it (uninstall has no fleet stage).
  - The closed pins that move: `EXPECTED_MANIFEST_KEYS` (`tests/client/manifest_contract.py`) and
    `EXPECTED_FLEET_FILES` in `test_cr090_fleet_stage.py` and `test_cr090_cli_install_integration.py`.
- [ ] **AC2 — the schema states every stack's declaration as the clients accept it.** For every stack
  whose client reads a declaration (bun, rust, arduino, maven and python): location, key form,
  fields, allowed values, defaults, required fields, cross-field rules, refused fields, its stack
  table and the reserved frameworks.
- [ ] **AC3 — the clients and the schema agree.** A test drives every client's declaration check
  with entries generated from the schema: every allowed value is accepted, every refused field and
  wrong value is refused, every cross-field rule holds, and every other stack's reserved framework
  (`go-test` included) is skipped. The test drives each client's own check, without a board.
- [ ] **AC4 — the versioning rule is written down.** The schema and the CHANGELOG state the writer
  rule: write known stacks and fields, warn on a newer version, never remove an unknown field.
- [ ] **AC5 — the docs follow.** CHANGELOG `[Unreleased]` "Stack declaration changes" names the
  schema file, its path, its version and the rust skip rule. README and RUNBOOK name the manifest's
  `declaration_schema` key.

## Non-goals

- Model B's writer itself (CR-MDB-099), and how any project adopts the declaration.
- An interactive installer step that writes a project's declaration. That is a later CR, if wanted.
- Removing the fleet on uninstall: a separate CR, for every fleet file at once.
- `[client]`, `[limits]` and `[gate]`: they configure the client and the gate, not how a stack's
  tests run.
- Namespacing `[targets.<key>]` per stack.
