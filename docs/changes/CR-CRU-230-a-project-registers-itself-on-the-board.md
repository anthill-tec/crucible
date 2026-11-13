# CR-CRU-230 — a project registers itself on the board

**Status:** PENDING — filed 2026-11-04 (Model B CReq, Sandesh 1517; accepted by user ruling the same day); gap
analysis ran 2026-11-13 · Pre-review: due — another project's surface (Model B's `init --register` consumes the
verb), user rulings at design, 8 points
**Type:** feature
**Points:** 8 (5 at filing)
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** clients, shared-module, prd
**Design reference:** CR-CRU-154 (`project-meta` and the metadata map); CR-CRU-187 (a verb's own shared module,
loaded by path); CR-CRU-221 (the core's line guard); PRD-crucible-v2 (projects are registered by an explicit act)

## Problem

- **No client verb creates a project.** Every verb works inside a project whose `CRUCIBLE_PROJECT_KEY` is already in
  `.env`, and exits "CRUCIBLE_PROJECT_KEY not found" without one. `register` registers an agent, not a project.
- **The board can already do it.** `POST /api/v2/projects {name, key?, type?, sutRoot?}` creates a project and
  needs no authority; the board's "+ Add project" form posts to it. It is idempotent only on a given `key`. Without
  a key the board mints one, so a second post of the same name makes a second project.
- **Model B waits on it.** `modelb-axi init --register` refuses ("live registration is not implemented in scaffold
  v1") until a client verb exists. A new project's key is made by hand; SoL-Pi's was.
- **The shared core has no room for it.** `clients/_crucible_axi.py` stands at its line guard's limit, so the verb
  cannot be added to it.

## Design (user rulings 2026-11-13)

- **F1, identity:** the key is derived from the project's token. The client posts
  `uuid5(PROJECT_KEY_NAMESPACE, token)` as `key`, so the board's existing key idempotence returns the same project
  on every re-run, with no board change. A key already in `<root>/.env` that the board knows is returned without
  posting, which covers projects made by hand.
- **F2, authority:** creating stays open, as the board's add form is. `--agent` is required, as for every mutating
  verb, and is the identity that seeds the metadata.
- **F3, metadata:** after the create, the client registers `--agent` as ORCHESTRATOR on the new key, then sends one
  metadata PATCH. Both routes exist today.
- **F4, placement:** a new shared module, `clients/_crucible_project.py`, holds a project's own verbs. `project-meta`
  moves into it out of the core, and `project-create` is added beside it.
- **The PRD changes.** Its invariant "Clients never register projects" was written against implicit
  self-registration (arduino's retired bootstrap, which created a project on meeting an unknown key). `project-create`
  is an explicit act, run on purpose, and is the only client path to the creation route. The invariant is restated
  that way (§S6).
- **No `src/` change.**

## Steps

### §S1 — the module and the move

- **The new module:** `clients/_crucible_project.py` is loaded by path and re-exported by the core, as
  `_crucible_release.py` is. It binds `_core` the same way and imports only the standard library.
- **What moves out of the core into it:** the `project-meta` section — `PROJECT_META_VERB`,
  `project_metadata_path`, `parse_meta_set`, `add_project_meta_args`, `project_meta_refusal_fields` and
  `cmd_project_meta` — with its behaviour unchanged.
- **The clients are unchanged for `project-meta`:** they keep calling `_axi().cmd_project_meta` and
  `_axi().add_project_meta_args`.
- **The fleet lists name the module:** the installer's `FLEET_FILES`, the README's shared-module list, the
  `SHARED_MODULES` of the bun census (§S6) and `SHARED_MODULE_LINE_BUDGETS` in the arduino, mvn and rust
  sends-its-runners-reports tests. The core's budget is re-recorded.

### §S2 — the verb

```text
<stack>-crucible.py project-create --name <display name> --token <token> --agent <id>
    [--acronym <ACRO>] [--type backend|frontend] [--set KEY=VALUE ...] [--write-env] [--project-dir <root>]
```

- **On all six clients** (bun, python, mvn, rust, arduino, go): each adds the parser and a `cmd_project_create`
  that delegates to the shared implementation, as `cmd_project_meta` does.
- **`--set`** uses `parse_meta_set`.
- **The help line:** "Create this project on the board, or find it, by its token; print its key (`--write-env`
  writes it to .env)."
- **The key:** `PROJECT_KEY_NAMESPACE` is a fixed UUID constant in the module, and
  `project_key_for_token(token)` returns `str(uuid.uuid5(PROJECT_KEY_NAMESPACE, token))`. It is pure, and the same
  token always gives the same key.
- **The verb never reads the key through `ops.project_key` or `ops.context`,** since both exit on a keyless
  `.env`. It builds its context from the key it ends with.

**Order:**

1. **Refuse before any request.** Each refusal is `ok: false` with exit 1, and posts nothing:
   - `--agent` is missing: the fleet's identity hard stop;
   - `--name` is empty;
   - `--token` does not match `^[a-z0-9][a-z0-9-]*$`;
   - `--acronym`, when given, does not match `^[A-Z][A-Z0-9]*$`.
2. **Read `<root>/.env`.** If `CRUCIBLE_PROJECT_KEY` holds a non-empty value, `GET …/projects/<that key>/metadata`:
   - **known:** that is the project. Step 3 is skipped, and `created: false`, `source: env`;
   - **unknown (404):** refuse with `project-key-unknown`. The detail names the key and the board, and says the
     verb never replaces a key already set. Nothing is posted.
3. **Create.** `POST /api/v2/projects` with `{key: project_key_for_token(token), name, type, sutRoot: <root, absolute>}`.
   - `created` is the board's `changed`, and `source: token`.
   - A refused or unreachable post is `ok: false`, carrying the board's error and help, or the reachability step.
4. **Register.** `register` as ORCHESTRATOR on the key: the same payload as the `register` verb, with this key in
   `projectKey`.
5. **Seed the metadata.** One `PATCH …/metadata` with `set = {PROJECT_TOKEN: token, PROJECT_ACRONYM: acronym (when
   given), …each --set}`.
   - A `--set` of `PROJECT_TOKEN` or `PROJECT_ACRONYM` that differs from the flag's value is refused in step 1.
6. **`--write-env`** (§S3).

**A failure after step 3:** a refused or failed register or PATCH is `ok: false` with exit 1. The envelope still
carries `projectKey` and `created`, and step 6 still runs, so a re-run completes the seed.

**The envelope:**

- **Fields:** `verb: project-create`, `projectKey`, `created`, `source` (`token` or `env`), `name`, `metadata` (the
  board's map after the PATCH), `envWritten` (`written`, `already-set`, `not-asked`), and
  `help: ["register --agent <id> --role ORCHESTRATOR", "project-meta"]`.
- **The stderr line:**
  `project-create: ok=<b> key=<key> created=<b>`.

### §S3 — `--write-env`

- **Where the line goes:**
  - The line `CRUCIBLE_PROJECT_KEY=<key>` replaces an existing line whose value is empty, or is appended when
    there is no such line.
  - A missing `.env` is created holding that one line.
- **Everything else is kept byte for byte:** other lines, comments, order, and the file's trailing newline.
- **A key already set** is never written. `envWritten: already-set` applies when it equals the result; step 2
  refuses when the board does not know it.
- **Without `--write-env`,** nothing is written and `envWritten: not-asked`.

### §S4 — the core stays under its guard

- The core loses the `project-meta` section and gains one load line. It ends at least 80 lines under
  `CORE_LINE_LIMIT`.
- The headroom test (`test_the_run_pipeline_lives_in_its_own_shared_module`) passes unchanged.

### §S5 — the fleet surfaces

- `HELP_STEPS` gains `project-create`.
- The verb is classified in `test_every_verb_that_runs_a_test_runner_is_classified` as a verb that runs no test
  runner.
- The cycle and help fleet tests that enumerate verbs gain it.

### §S6 — the PRD and docs

- **PRD-crucible-v2, the invariant**, restated: "A project is registered by an explicit act: the board's '+ Add
  project' form, `POST /api/v2/projects`, or a client's `project-create` verb. No other client verb creates a
  project, and none does so on meeting an unknown key. Every client, arduino included, reads only
  `CRUCIBLE_PROJECT_KEY` from that `.env`."
- **DN-client-fleet-inventory:** the `_project_key` row's "Clients never register projects" sentence names
  `project-create` as the one explicit verb.
- **`tests/clients-never-self-register-a-project.test.ts`:**
  - It lists the new module.
  - Its census becomes: the bare creation route is named only in `clients/_crucible_project.py`, and only inside
    `project-create`'s implementation. No client script and no other shared module names it.
  - The arduino checks stay unchanged.
- **The CHANGELOG `[Unreleased]`**, under `### Added`: the verb, its idempotence by token, `--write-env` and the
  seeding.
- **The README:** the verb in the client verb list.

## Acceptance criteria

- [ ] **AC1 — it creates the project and returns its key.** Against a board that does not know the token,
  `project-create --name N --token t --agent a` posts exactly one `POST /api/v2/projects` with
  `{key: project_key_for_token("t"), name: "N", type: "backend", sutRoot: <root>}`. It exits 0, and the envelope
  carries `projectKey` equal to that key, `created: true` and `source: token`. `--type frontend` posts
  `type: "frontend"`.
- [ ] **AC2 — idempotent by token.** A second run with the same token, whatever its `--name`, answers the same
  `projectKey` with `created: false`. Both runs together created one project on the board. `project_key_for_token`
  is pure: equal tokens give equal keys, different tokens different keys, and the value is a valid UUID.
- [ ] **AC3 — a key already in `.env` is used, never replaced.** With a non-empty `CRUCIBLE_PROJECT_KEY` that the
  board knows, the verb posts no create, and answers that key with `created: false` and `source: env`, even when it
  differs from the token's key. With one the board does not know, it exits 1 with `project-key-unknown`, naming the
  key; it posts nothing and leaves `.env` byte-identical.
- [ ] **AC4 — `--write-env`.** For each case the file afterwards is as §S3 states and every other byte is
  unchanged:
  - an empty `CRUCIBLE_PROJECT_KEY=` line between other lines;
  - no such line;
  - no `.env` at all;
  - a key already set (`already-set`, file unchanged).

  Without `--write-env`, `.env` is never written.
- [ ] **AC5 — the metadata is seeded in the same call.** After the create, the verb registers `--agent` with role
  ORCHESTRATOR on the new key, then sends one PATCH whose `set` holds `PROJECT_TOKEN`, `PROJECT_ACRONYM` (only
  with `--acronym`) and each `--set` pair. The envelope's `metadata` is the board's map. On the existing-project
  path the same register and PATCH run.
- [ ] **AC6 — errors are envelopes.** Each of these exits 1 with `ok: false`, an `error` and a `help`, and never a
  traceback:
  - an unreachable board, posting nothing further;
  - a refused create, carrying the board's error;
  - a refused register or PATCH after a create, still carrying `projectKey` and still honouring `--write-env`.

  Each refusal of §S2 step 1 posts nothing: no `--agent`, an empty `--name`, a bad `--token`, a bad `--acronym`,
  and a conflicting `--set PROJECT_TOKEN=`.
- [ ] **AC7 — open, as the board's form.** The create post carries no agent, and a board with no agent registered
  anywhere accepts it. No `src/` file changes in this CR.
- [ ] **AC8 — every client has it.** Each of the six clients parses `project-create` with the flags of §S2 and the
  help line, and delegates to the shared implementation, as each does `project-meta`. One end-to-end run per
  client against a test board gives the same envelope fields.
- [ ] **AC9 — the module and the move.** `clients/_crucible_project.py` exists, is loaded and re-exported by the
  core, and defines the `project-meta` names of §S1 and `project-create`'s. The core defines none of them. The
  `project-meta` tests pass unchanged. The core is at least 80 lines under `CORE_LINE_LIMIT`.
  - The new module is in `FLEET_FILES`, and an install ships it.
  - It is in the README's shared-module list and in `SHARED_MODULE_LINE_BUDGETS`.
- [ ] **AC10 — the census and the PRD.** `tests/clients-never-self-register-a-project.test.ts` passes with the new
  module listed. The bare creation route appears only in `clients/_crucible_project.py`. The PRD and the DN state
  §S6's text, and no doc outside `docs/changes/` still says that clients never register projects without naming
  `project-create`.
- [ ] **AC11 — docs and hygiene.** The CHANGELOG and README entries of §S6 are present. `HELP_STEPS` and the
  fleet verb tests name the verb. The code and tests add no CR id literal, `§` or AC number.

## Non-goals

- Model B's `init --register` itself: a Model B CR, once this ships.
- Archiving, deleting or renaming a project; the existing routes do that.
- A token stored on the board, or matching on name (declined at the gap analysis).
- Adopting a project made by hand whose `.env` key is empty: running the verb there creates the token's project.
  The board's form, or writing the key into `.env` first, stays the way to adopt one.
