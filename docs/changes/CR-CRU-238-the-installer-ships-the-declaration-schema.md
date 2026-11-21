# CR-CRU-238 — the installer ships the declaration schema

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-225, CR-CRU-233,
CR-CRU-203, CR-CRU-237 · **Status** DONE — merged 2026-11-08 (`c6e9c821`) · Pre-review: ran — 8 points and user rulings (findings F1–F11, all folded)

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
- **§S3 — the contract with writers.** The schema states the versioning rule a writer follows.
- **§S4 — one skip rule for `[targets]`.** The three clients that read `crucible.toml`
  `[targets.<key>]` (rust, arduino, maven) skip an entry that names another stack's framework, and
  refuse nothing in it. The skip is decided on `framework` before any other field is checked.
  - Rust adopts the rule arduino and maven already follow.
  - Every skip set includes the reserved `go-test`.
  - Bun's `crucible.targets` lives in `package.json`, which no other stack shares, so bun keeps
    refusing a non-bun framework there. Python reads no `[targets]` entry.

## Design (user rulings 2026-11-08)

- **Format:** JSON, readable with any runtime's standard library. The file is a plain descriptor,
  not a JSON Schema dialect, and says so; the ruled filename stays. `version` is an integer,
  starting at 1.
- **Shape:** a top-level `version`, and a `stacks` map. Each stack names:
  - where its declaration lives (file and table or key);
  - how an entry's key is formed:
    - bun: any name in `scripts`. A non-`bun-test` entry must be a `test:<tier>` script present in
      `scripts` (the gate's rule), and the script marked `"test": true` must be present with a body;
    - rust: the nextest profile;
    - arduino: the native dir relative to the project dir (default `tests/native`), joined by `/` to
      the make target;
    - maven: the tier;
  - each field: its allowed values, its default, whether it is required, and the refused fields;
  - whether an entry is **open** (an unlisted field is accepted and ignored) or closed. Every entry
    is open today, which is what lets a writer keep a field it does not know;
  - its stack table, where it has one: `[bun] package_dir` and `[python] runner` (`unittest` by
    default, or `pytest`; a flag overrides it);
  - bun's `"test": true` marker (JSON `true` only, on one entry at most), and the package-level keys
    bun refuses (`crucible.reportPath`, `crucible.rawReport`, `crucible.testScript`);
  - its shape and parse rules (below).
- **Field descriptors:** `values` takes one of four forms:
  - a list;
  - a `pattern`, e.g. bun's `junit`: `flag` or `env:<VAR>`;
  - `board-listed: codecs.<kind>` for an open codec name (`stream.codec`, `console`), checked against
    the board's health at run time;
  - a run-time `path` check, e.g. `[bun] package_dir`: a directory holding `package.json`.

  Cross-field rules are stated as `requires` and `excludes`. For bun: exactly one of `stream` and
  `junit`; `console` only on a `junit` entry; `bun-console` only with `bun-test`; `coverage` only
  `lcov`, on a `junit: "flag"` `bun-test` entry; `stream.path` only `env:CRUCIBLE_STREAM`.
- **Shape and parse rules, per stack:**
  - a `targets` that is not a table: undeclared, for every stack;
  - an entry that is not a table: refused by rust, arduino and maven, and by bun's entry check; bun's
    `"test"` marker scan passes over it;
  - a `crucible.toml` that does not parse: refused by rust, arduino and maven; declares nothing for
    `[bun] package_dir` and `[python] runner`.
- **Skip rule:** the schema states §S4, and that `[targets.<key>]` is one flat namespace: a key holds
  one stack's entry, and the other `[targets]` stacks skip it.
  - A writer always writes `framework`, even where a reader has a default. An entry with no
    `framework` is rust's (rust reads it as `nextest`), so arduino and maven refuse it.
  - The reserved frameworks per stack: `bun-test`, `vitest`, `playwright`, `playwright-bdd` (bun);
    `nextest` (rust); `pytest`, `unittest` (python); `surefire` (maven); `arduino-native`; `go-test`.
- **A newer schema than the writer knows:** the writer writes the stacks and fields it knows, and
  warns, naming the schema version. It never removes a field it does not know. A newer Crucible never
  blocks a writer.
- **No schema:** an older install's `crucible-clients.json` has no `declaration_schema` key, and an
  install may have lost the file. The writer then writes nothing it cannot check, warns, and is not
  blocked. Model B's own fallback is a Non-goal.
- **Release notes:** every change to the schema bumps `version` and is listed under "Stack
  declaration changes".

## Acceptance criteria

- [x] **AC1 — the installer ships and lists the schema.**
  - An install lays down `crucible-declaration.schema.json` beside the clients. An upgrade overwrites
    it. Like every fleet file, an uninstall leaves it (uninstall has no fleet stage).
  - `crucible-clients.json` lists it as `declaration_schema: {path, version}`. The version is read
    from the packaged source copy (the one `[fleet]` copies), so `build_manifest` needs no
    installed fleet.
  - A packaged schema that is missing, is not JSON, or has no integer `version` fails the stage
    fail-fast, naming the path.
  - The closed pins that move: `EXPECTED_MANIFEST_KEYS` (`tests/client/manifest_contract.py`) and
    `EXPECTED_FLEET_FILES` in `test_cr090_fleet_stage.py` and `test_cr090_cli_install_integration.py`.
- [x] **AC2 — the schema states every stack's declaration as the clients accept it.** For bun, rust,
  arduino, maven and python: location, key form, fields, allowed values (all four forms), defaults,
  required fields, open or closed entries, cross-field rules, refused fields (entry and package
  level), its stack table, the shape and parse rules, and the reserved frameworks.
- [x] **AC3 — the clients and the schema agree.** A test drives every client's declaration check
  with entries generated from the schema:
  - every allowed value is accepted (a sample value for a pattern), and every refused field and
    wrong value is refused;
  - every cross-field rule holds;
  - an unlisted field is accepted;
  - every shape and parse rule holds;
  - for rust, arduino and maven, each other stack's **complete valid entry** (every reserved
    framework, `go-test` included) is skipped; a frameworkless entry is refused by arduino and maven;
  - bun refuses a non-bun framework; bun's key rules hold.

  The test needs no board. Its seams: a temporary project dir holding `crucible.toml` or
  `package.json`; python's `_resolve_runner` with `probe=False` (the probe checks the interpreter,
  not the declaration); the board-listed codecs through bun's `_target_board_refusal` with a stub
  health that lists, and one that omits, a sample codec.
- [x] **AC4 — the versioning rule is written down.** The schema and the CHANGELOG state the writer
  rule: write known stacks and fields, warn on a newer version, never remove an unknown field, and
  write nothing it cannot check when there is no schema.
- [x] **AC5 — the docs follow.** CHANGELOG `[Unreleased]` "Stack declaration changes" names:
  - the schema file, its path and its version;
  - rust's new skip;
  - `go-test` joining the arduino and maven skip sets (an entry those clients refuse today is
    skipped).

  README and RUNBOOK name the manifest's `declaration_schema` key.

**Done 2026-11-08.** Merged `c6e9c821` (plan 242: U1 889, U2 890, VERIFY 891 APPROVE, FIX 892 for VERIFY's four suggestions). The schema ships at version 1 beside the clients and the manifest lists it as `declaration_schema`; an agreement test drives all five clients' checks from it; rust skips another stack's `[targets]` entry before any field check; `go-test` joins every skip set. Pre-merge gate 11957 passed / 0 failed.

## Non-goals

- Model B's writer itself (CR-MDB-099), how any project adopts the declaration, and Model B's
  fallback when no schema is installed.
- An interactive installer step that writes a project's declaration. That is a later CR, if wanted.
- Removing the fleet on uninstall: a separate CR, for every fleet file at once.
- `[client]`, `[limits]` and `[gate]`: they configure the client and the gate, not how a stack's
  tests run.
- Namespacing `[targets.<key>]` per stack.
- Bun skipping other stacks' frameworks, and arduino and maven skipping a frameworkless entry.
