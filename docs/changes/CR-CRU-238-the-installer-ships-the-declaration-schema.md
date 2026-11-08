# CR-CRU-238 — the installer ships the declaration schema

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-225, CR-CRU-233,
CR-CRU-203, CR-CRU-237 · **Status** PENDING — filed 2026-11-08 at Model B's request (Sandesh 1547)
with the user's rulings of 2026-11-08 · A gap analysis is due when the CR is picked up.

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
  clients and lists it in `crucible-clients.json`, as it lists each client.
- **§S2 — one source.** The clients' declaration checks and the schema cannot disagree: either the
  clients read the schema, or a test pins every client's accepted vocabulary to it. The gap analysis
  chooses, by cost.
- **§S3 — the contract with writers.** The schema states the versioning rule a writer follows.

## Design (user rulings 2026-11-08)

- **Format:** JSON, readable with any runtime's standard library.
- **Shape:** a top-level `version`, and a `stacks` map. Each stack names:
  - where its declaration lives (file and table or key);
  - how an entry's key is formed (bun: the `test:<tier>` script; rust: the nextest profile; arduino:
    the native dir relative to the project dir, joined by `/` to the make target; maven: the tier);
  - each field, its allowed values, its default, and the refused fields.
  - The reserved frameworks per stack: `bun-test`, `vitest`, `playwright`, `playwright-bdd` (bun);
    `nextest` (rust); `pytest`, `unittest` (python); `surefire` (maven); `arduino-native`; `go-test`.
- **A newer schema than the writer knows:** the writer writes the stacks and fields it knows, and
  warns, naming the schema version. It never removes a field it does not know. A newer Crucible never
  blocks a writer.
- **Release notes:** every change to the schema bumps `version` and is listed under "Stack
  declaration changes".

## Acceptance criteria

- [ ] **AC1 — the installer ships and lists the schema.** An install lays down
  `crucible-declaration.schema.json` beside the clients, and `crucible-clients.json` lists its path
  and version. An upgrade overwrites it; an uninstall removes it.
- [ ] **AC2 — the schema states every stack's declaration as the clients accept it.** For every stack
  whose client reads a declaration (bun, rust, arduino, maven, and python if it reads one): location, key form, fields, allowed values, defaults and refused fields.
- [ ] **AC3 — the clients and the schema agree.** A test drives every client's declaration check
  with entries generated from the schema: every allowed value is accepted, every refused field and
  wrong value is refused, and another stack's entry is skipped as the client does today.
- [ ] **AC4 — the versioning rule is written down.** The schema and the CHANGELOG state the writer
  rule: write known stacks and fields, warn on a newer version, never remove an unknown field.
- [ ] **AC5 — the docs follow.** CHANGELOG `[Unreleased]` "Stack declaration changes" names the
  schema file, its path and its version.

## Non-goals

- Model B's writer itself (CR-MDB-099), and how any project adopts the declaration.
- An interactive installer step that writes a project's declaration. That is a later CR, if wanted.
