# CR-CRU-154 — a project carries its own metadata

**Type** feature · **Points** 8 · **Wave** 7 (0.3.0), before CR-CRU-149 (user ruling 2026-09-26) ·
**Depends on** CR-CRU-091, CR-CRU-130, CR-CRU-150 · **Status** PENDING — filed 2026-09-26

## Problem

**Requested by Model B (Sandesh #1399, 2026-09-26).** Model B is making project settings
schema-driven (their PRD D3.1, CR-MDB-043): `modelb-axi init` generates each project's `.env` from a
schema of rules, and the values belong to the project. They want a project's registry values
mirrored on the board, so that any session or harness can read a project's identity from Crucible
rather than from a checkout. The project's own `.env` stays authoritative; the board holds a copy.

Crucible's project record (`GET /api/v2/projects`) carries `key`, `name`, `type`, `sutRoot` and the
configured fields (`liveness`, `retention`, `allowRunDeletion`, `milestoneTypes`). There is no
free-form place for a project's own facts, and no single-project read.

Model B's keys (#1401): `PROJECT_NAME`, `PROJECT_TOKEN` (the project's lower-case slug, from which
CR and agent ids derive: an identifier, not a credential), `PROJECT_ACRONYM`, `ORCHESTRATOR_LABEL`,
`SANDESH_PROJECT`, `PROJECT_STACKS`, `REPO_OWNER`; fewer than 20, the longest a comma-separated stack
list. `CRUCIBLE_PROJECT_KEY` stays local only: it is how the project is found.

**User rulings 2026-09-26:** Crucible owns it, in 0.3.0, before CR-CRU-149. Writes go to their own
route and are **orchestrator only, enforced by the server**; reads are open and the project record
carries the map. The map holds **non-secret facts only**, stated in the contract, with no server
refusal (a key-name rule would refuse Model B's own `PROJECT_TOKEN`; value heuristics are
guesswork). **Keys are environment-variable names** and there are **no numeric caps**. The board
does **not** show or edit it. Model B's preferences (#1401) are adopted: merge per key, `--unset`
removes, last write wins, no history.

## Scope

### §S1 — the store keeps a project's metadata

A project's metadata is a flat map of string keys to string values, kept in its own table, created
in the base schema pass the way CR-CRU-130 created `project_milestone_types`, so it costs no
migration step and no schema version. Deleting a project deletes its metadata in the same
transaction as the rest of its rows.

### §S2 — one route writes it, and only an orchestrator may

`PATCH /api/v2/projects/<key>/metadata` takes `{agentId, set?: {K: V, …}, unset?: [K, …]}`:

- The caller must be a registered agent whose role is `ORCHESTRATOR` (`requireOrchestrator`); both
  refusals return before anything is written.
- `set` writes each named key (last write wins); `unset` removes each named key; a key absent from
  both is untouched. Removing a key that is not there is a no-op.
- Refused with `400` and a `help[]`, writing nothing: a body with neither a non-empty `set` nor a
  non-empty `unset`; a key that is not an environment-variable name (`^[A-Z][A-Z0-9_]*$`); a `set`
  value that is not a string; a key in both `set` and `unset`; the key `CRUCIBLE_PROJECT_KEY`
  (identity stays local).
- The answer is `{ok: true, metadata: <the whole map after the write>, changed: <bool>}`. A change
  notifies the board's `projects` stream, as every project write does.

### §S3 — reads are open

`GET /api/v2/projects/<key>/metadata` answers `{ok: true, metadata: <map>}` (`{}` when none), with
the usual unknown-project refusal. Every project record the server publishes (the project list, the
orientation read) carries `metadata` when the project has any, and omits the key when it has none,
as `milestoneTypes` does.

### §S4 — the client verb `project-meta`

In all five clients, through one shared implementation:

- `project-meta` reads (one `GET …/metadata`, no `--agent`).
- `project-meta --set K=V [--set K=V …] [--unset K …] --agent <id>` writes: each `--set` splits on
  the FIRST `=`, so a value may contain `=` and commas; a malformed `--set` is refused by argument
  parsing, before any request.
- The envelope's `metadata` is the map the server returned; writes also carry `changed`. A refused
  or failed request is `ok:false` with the server's `help[]`, and a non-zero exit.
- `--format {toon,json}` as CR-CRU-150 §S8 defines it: `json` is the same object as one JSON
  object, for programs such as `init --register`.
- The verb's `--help` says the map is readable by anything that reaches the board and must hold
  non-secret facts only.

### §S5 — an empty project key is a missing one (Model B #1402; user ruling 2026-09-26)

`modelb-axi init` now scaffolds `CRUCIBLE_PROJECT_KEY=` empty until the project is registered.
Four clients (python, bun, rust, mvn) checked only that the key was present, so an empty key
reached the board as `/api/v2/projects//plans` and `status` degraded to "board unavailable". In
all five clients an empty or whitespace-only key fails exactly as a missing one does: the same
error, the same non-zero exit, before any request. The project's `.env` is authoritative: the
arduino client stops falling back to the shell's `CRUCIBLE_PROJECT_KEY` when `.env`'s is empty or
absent, as the other four never did.

### §S6 — a metadata refusal names its own verb (VERIFY, cycle 536)

A non-orchestrator's metadata write is refused with an error and `help[]` that name the metadata
write and `project-meta`, not "roadmap registration" and the roadmap verbs, which the shared
orchestrator check used to say for every route it guards. The roadmap routes' own refusals are
unchanged.

## Acceptance criteria

- [x] **AC1 (§S1)** — Metadata written for a project survives a server restart on the same store, and
  deleting the project removes it (a re-created project with the same name starts with none). A
  store created by the previous build opens unchanged, with the same schema version.
- [x] **AC2 (§S2)** — An `ORCHESTRATOR` caller's `PATCH …/metadata` with `set` then `unset` leaves
  exactly the expected map, keys it did not name untouched; an identical write answers
  `changed: false`.
- [x] **AC3 (§S2)** — Refused, with nothing written: an unregistered caller (`409`), a registered caller
  of any other role and one with no role (`409`), and each `400` case listed in §S2, one test each.
- [x] **AC4 (§S3)** — `GET …/metadata` answers the map (`{}` for a project with none, the unknown-project
  refusal for a bad key); `GET /api/v2/projects` carries `metadata` on a project that has some and
  no `metadata` key on one that has none.
- [x] **AC5 (§S4)** — In EACH of the five clients: `project-meta` issues exactly one `GET …/metadata`
  and reports the map; `project-meta --set A=x=1,2 --set B=y --unset C --agent <id>` issues exactly
  one `PATCH …/metadata` with `set: {A: "x=1,2", B: "y"}` and `unset: ["C"]`; a malformed `--set` is
  refused before any request; a server refusal is `ok:false` with its `help[]` and a non-zero exit.
- [x] **AC6 (§S4)** — `--format json` writes the same object as one JSON object, for a read and a write,
  in each of the five clients.
- [x] **AC7 (§S4)** — Each client's `project-meta --help` states that the map is readable by anything
  that reaches the board and holds non-secret facts only, and its `--agent` help says the flag is
  required for a write (`--set`/`--unset`) and never claims it is required for every call.
- [x] **AC8 (wiring)** — End to end against a real, ephemeral board: a registered orchestrator writes
  through the real `python-crucible.py project-meta` subprocess, a second `project-meta` read (TOON
  and `--format json`) returns the map, and `GET /api/v2/projects` carries it. A `report`-role
  caller's write is refused. No stubbed transport.
- [x] **AC9 (§S5)** — In EACH of the five clients, a `.env` holding `CRUCIBLE_PROJECT_KEY=` empty, and one
  holding only whitespace, fail with the same error text and exit code as a `.env` without the key,
  and no request is made. The arduino client with an empty `.env` key and
  `CRUCIBLE_PROJECT_KEY` set in its environment still fails the same way.
- [x] **AC10 (§S6)** — A `report`-role and a role-less caller's `PATCH …/metadata` answers `409` with an
  error naming the metadata write and a `help[]` naming `project-meta`, and neither mentions
  roadmap registration; a roadmap route's refusal of the same caller is byte-identical to today's.

## Non-goals

- **Board UI.** The board neither shows nor edits metadata.
- **History.** Last write wins; nothing is journaled.
- **Interpreting keys.** Crucible stores and returns them; nothing reads one.
- **Secret detection.** The contract says non-secret; the server does not guess.
- **Numeric caps.** None until a real need appears; then they are configuration (CR-CRU-131).

## Model B

Model B runs released clients only, so this reaches them with the 0.3.0 release, and they are told
in its notes. Their `init --register` writes only the keys their schema declares, so merge per key
never clobbers anything else (#1401).
