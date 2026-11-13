# CR-CRU-230 — a project registers itself on the board

**Status:** PENDING — filed 2026-11-04 (Model B CReq, Sandesh 1517; accepted by user ruling the same day); gap
analysis ran 2026-11-13 · Pre-review: ran — another project's surface (Model B's `init --register` consumes the
verb), user rulings at design, 8 points (9 findings folded; two by user ruling)
**Type:** feature
**Points:** 8 (5 at filing)
**Wave:** 8 (0.4.0)
**Depends on:** —
**Labels:** clients, shared-module, prd
**Design reference:** CR-CRU-154 (`project-meta`, the metadata map, and an empty key failing as a missing one);
CR-CRU-187 (a verb's own shared module, loaded by path); CR-CRU-221 (the core's line guard); PRD-crucible-v2
(projects are registered by an explicit act)

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
- **F3, metadata:** after the create, the client registers `--agent` as ORCHESTRATOR on the key, then sends one
  metadata PATCH. Both routes exist today.
  - An agent already on that project under another role, or bound to a cycle, is refused, and nothing changes
    (pre-review ruling).
  - The verb never unregisters; the row ages out like any registration.
- **F4, placement:** a new shared module, `clients/_crucible_project.py`, holds a project's own verbs. `project-meta`
  moves into it out of the core, and `project-create` is added beside it.
- **The root is explicit:** `project-create` requires `--project-dir`, on every client (pre-review ruling). It never
  walks up to a git top level, so a sub-project or worktree never writes its parent's `.env`.
- **The PRD changes.** Its invariant "Clients never register projects" was written against implicit
  self-registration (arduino's retired bootstrap, which created a project on meeting an unknown key). `project-create`
  is an explicit act, run on purpose, and is the only client path to the creation route. The invariant is restated
  that way (§S6). `project-create` is also the one verb exempt from CR-CRU-154's "an empty key fails as a missing one
  before any request".
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
- **Every list or fixture that names the shared modules gains it.** The core loads its siblings at import, so a
  scratch copy of `clients/` without the new module fails to import. These change:
  - **The installer and packaging:**
    - the installer's `FLEET_FILES` (`crucible_axi/install.py`);
    - `EXPECTED_CLIENT_PAYLOAD` (`test_crucible_axi_wheel_packaging`);
    - the fleet lists of `test_cr090_fleet_stage` and `test_cr090_cli_install_integration`.
  - **The scratch-copy fixtures:**
    - `test_client_fleet_envelope_census` (`cls.tmp_dir`);
    - `test_a_clients_board_is_its_projects_configuration` (its copy loop);
    - `test_no_suite_resolves_the_checkout_configuration` (`_SCRATCH_FLEET`);
    - `test_client_limits_resolve_from_configuration`.
  - **The shared-module lists:**
    - `SHARED_MODULE_NAMES` (`test_cr054_drift_guard`);
    - `SHARED_MODULES` (`test_a_runs_ingest_helpers_live_once_in_the_shared_module`, and
      `test_the_run_pipeline_lives_in_its_own_shared_module`, whose ruff check then covers the new module);
    - `SHARED_MODULES` of the bun census (§S6).
  - **The line budgets:** `SHARED_MODULE_LINE_BUDGETS` in the arduino, mvn and rust sends-its-runners-reports
    tests. The core's budget is re-recorded.
  - **The README's** shared-module list.
- **One `.env` reader and writer** live in the module, and `project-create` on all six clients uses them (§S3).
  They never exit on a missing key.

### §S2 — the verb

```text
<stack>-crucible.py project-create --project-dir <root> --name <display name> --token <token> --agent <id>
    [--acronym <ACRO>] [--type backend|frontend] [--set KEY=VALUE ...] [--write-env]
```

- **On all six clients** (bun, python, mvn, rust, arduino, go): each adds the parser and a `cmd_project_create`
  that delegates to the shared implementation.
  - The client resolves no project dir of its own for this verb. It passes `--project-dir`, made absolute,
    straight through. Arduino's `_project_dir`, which exits on a missing `.env`, is never called.
  - Its dispatch passes no project-key function to `run_verb`, so a hard stop or an escaped `OSError`/`ValueError`
    gives an envelope whose context is empty, never a bare `sys.exit`.
- **`--set`** uses `parse_meta_set`.
- **The help line:** "Create this project on the board, or find it, by its token; print its key (`--write-env`
  writes it to .env)."
- **The key:** `PROJECT_KEY_NAMESPACE` is a fixed UUID constant in the module, and
  `project_key_for_token(token)` returns `str(uuid.uuid5(PROJECT_KEY_NAMESPACE, token))`. It is pure, and the same
  token always gives the same key.
- **No empty key is ever sent.** The verb never reads the key through `ops.project_key` or `ops.context`, since both
  exit on a keyless `.env`. It builds its context from the key it ends with, and every request it makes carries a
  non-empty UUID key.

**Order.** Each refusal is `ok: false` with exit 1.

1. **Refuse before any request.** None of these posts anything:
   - `--agent` is missing: the fleet's identity hard stop, `agent-identity-required`;
   - `--project-dir` is missing (argparse usage, exit 2), or is not a directory;
   - `--name` is empty;
   - `--token` does not match `^[a-z0-9][a-z0-9-]*$`;
   - `--acronym`, when given, does not match `^[A-Z][A-Z0-9]*$`;
   - a `--set` key does not match `^[A-Z][A-Z0-9_]*$`, or is `CRUCIBLE_PROJECT_KEY`;
   - a `--set` of `PROJECT_TOKEN` or `PROJECT_ACRONYM` differs from the flag's value;
   - `.env` holds a `CRUCIBLE_PROJECT_KEY` value (§S3) that is not a UUID: `project-key-malformed`, naming the
     value. A quoted value is one of these.
2. **A key in `.env`.** If `.env` holds a UUID key, `GET …/projects/<that key>/metadata`:
   - **200:** that is the project, unless its metadata holds a `PROJECT_TOKEN` other than `--token`: then refuse with
     `project-token-mismatch`, naming both tokens, before anything is registered, patched or written (user ruling at
     VERIFY). Otherwise step 3 is skipped, and the result is `created: false`, `source: env`;
   - **404 "unknown project":** refuse with `project-key-unknown`. The detail names the key and the board, and says
     the verb never replaces a key already set;
   - **404 "project is archived":** refuse with `project-key-archived`, carrying the board's help.

   Nothing is posted on any of these refusals.
3. **Create.** First `GET /api/v2/projects?archived=true`. If the token's key is among the archived projects, refuse
   with `project-archived`, carrying the un-archive step; nothing is posted or written. Otherwise
   `POST /api/v2/projects` with `{key: project_key_for_token(token), name, type, sutRoot: <root>}`.
   - `created` is the board's `changed`, and `source: token`.
   - A refused or unreachable post is `ok: false`, carrying the board's error and help, or the reachability step.
4. **Register.**
   - `GET /api/v2/agents?project=<key>`. If `--agent` is already there with a role other than ORCHESTRATOR, with no
     role (a historical row; the detail says "with no role"), or with a cycle binding, refuse with `agent-role-conflict`, naming its role and cycle. Nothing is registered, patched or
     written.
   - Otherwise, `POST /api/v2/agents/register` with the module's own payload: `{agentId, projectKey: <key>,
     status: "online", message: "Registering the project", role: "ORCHESTRATOR",
     identity: {displayName: <agentId>, source: "claude-md", repoPath: <root>}}`.
5. **Seed the metadata.** One `PATCH …/metadata` with `set = {PROJECT_TOKEN: token, PROJECT_ACRONYM: acronym (when
   given), …each --set}`.
6. **`--write-env`** (§S3).

**A failure after step 3** (a refused or failed register or PATCH, or an unreachable board) is `ok: false` with
exit 1. The envelope still carries `projectKey` and `created`, and step 6 still runs, so a re-run completes the seed.
The refusals in steps 2–4 run before anything is written, so they never write `.env`. A failure *in* step 2 or 3 (an
unreachable board, or a refused archived read or create) stops there: no register, no PATCH, and `.env` is not
written, since no key has been confirmed.

**Refusal codes.** Each refusal's envelope carries the detail as `error` and one warning whose `code` is the
refusal's code (`project-key-unknown`, `agent-role-conflict`, …) with the same detail. Every step-1 refusal of the
verb's own arguments (the root, the name, the token, the acronym, a `--set`) has the code `argument-refused`. A request
the board refused or never answered carries the board's error and help, with no code of its own.
`project-key-unknown`'s detail names the key and the board.

**The envelope:**

- **Fields:** `verb: project-create`, `projectKey`, `created`, `source` (`token` or `env`), `name` (the board's
  stored name from the create reply; `null` on the `env` path, which reads no project), `metadata` (the board's map
  after the PATCH), `envWritten` (`written`, `already-set` or `not-asked`), and
  `help: ["register --agent <id> --role ORCHESTRATOR", "project-meta"]`.
- **The stderr line:** `project-create: ok=<b> key=<key> created=<b>`.

### §S3 — the `.env` reader and writer

**Reading:**

- The file is split into lines on `\n`. A trailing `\r` is not part of a line's text.
- A key line is one the clients' own readers take as the key: its stripped text does not start with `#`, and the
  text before its first `=`, stripped, is `CRUCIBLE_PROJECT_KEY`. So `export CRUCIBLE_PROJECT_KEY=…` and a
  commented line are not key lines.
- A key line's value is the text after the first `=`, stripped of whitespace.
- With several such lines, the last one counts, as the clients' readers do.
- An empty value, or no such line, means no key. Quotes are not removed.

**Writing (`--write-env`):**

- **Where the line goes:**
  - The line `CRUCIBLE_PROJECT_KEY=<key>` replaces the last such line when its value is empty.
  - Otherwise it is appended when there is no such line.
  - A missing `.env` is created holding that one line and a `\n`.
- **Line endings:**
  - A replaced line keeps its own line ending.
  - An appended line uses the file's first line ending (`\r\n` or `\n`).
  - If the file does not end in a line ending, the file's first line ending is added before the appended line.
  - A file with no line ending at all uses `\n`.
  - A replaced key line is replaced whole, leading whitespace included.
- **Everything else is kept byte for byte:** other lines, comments, order, and the line endings.
- **A key already set** is never written: `envWritten: already-set`. Step 2 has already answered or refused it.
- **Without `--write-env`,** nothing is written and `envWritten: not-asked`.

### §S4 — the core stays under its guard

- The core loses the `project-meta` section and gains one load line. It ends at least 80 lines under
  `CORE_LINE_LIMIT`.
- The headroom test (`test_the_run_pipeline_lives_in_its_own_shared_module`) passes unchanged.

### §S5 — the fleet surfaces

- **`HELP_STEPS`** gains `project-create`.
- **`SHARED_CENSUS`** in `test_every_verb_that_runs_a_test_runner_is_classified` gains `project-create`, classified
  `_ROADMAP` (not ingesting), as `project-meta` is.
- **`test_client_fleet_envelope_census`** drives every verb from the parser. Its fixture board answers:
  - `POST /api/v2/projects`;
  - `GET /api/v2/projects?archived=true`;
  - `GET /api/v2/agents`;
  - the register;
  - `PATCH …/metadata`.

  The census passes `--project-dir` with a scratch dir for `project-create`.

### §S6 — the PRD, docs and census

- **PRD-crucible-v2.** The bullet beginning "`POST /api/projects/add` with an existing key → HTTP 400." keeps that
  opening, and its sentences after it read:

  > A project is registered by an explicit act: the board's "+ Add project" form, `POST /api/v2/projects`, or a
  > client's `project-create` verb. A client never registers a project on meeting an unknown key, and
  > `project-create` is the one client verb that creates one. Every client, arduino included, reads only
  > `CRUCIBLE_PROJECT_KEY` from the project's `.env`, and only `project-create --write-env` writes it.
- **DN-client-fleet-inventory.** In the `_project_key` row, "Clients never register projects" becomes: "A client
  never registers a project on meeting an unknown key; `project-create` is the one explicit verb that does."
- **`tests/client-fleet-docs-no-self-registration-wording.test.ts`** keeps its slices, which still match
  `client…never…regist…project`. It also requires each slice to name `project-create`.
- **`tests/clients-never-self-register-a-project.test.ts`:**
  - `CLIENT_SCRIPTS` gains `go-crucible.py`, and `SHARED_MODULES` gains the new module.
  - The census becomes: the bare creation route is named only in `clients/_crucible_project.py`, and only inside
    `project-create`'s implementation. No client script and no other shared module names it.
  - The arduino checks stay unchanged.
- **CR-CRU-154's carve-out:** `test_an_empty_project_key_is_a_missing_one` keeps driving `status`, unchanged.
  `project-create` is the stated exception, covered by AC9.
- **The CHANGELOG `[Unreleased]`**, under `### Added`: the verb, its idempotence by token, `--write-env`, the
  seeding and the explicit `--project-dir`.
- **The README:** names the verb where it describes the client fleet (it has no verb list).

## Acceptance criteria

- [ ] **AC1 — it creates the project and returns its key.** Against a board that does not know the token,
  `project-create --project-dir R --name N --token t --agent a` posts exactly one `POST /api/v2/projects` with
  `{key: project_key_for_token("t"), name: "N", type: "backend", sutRoot: <R absolute>}`. It exits 0, and the
  envelope carries `projectKey` equal to that key, `created: true` and `source: token`. `--type frontend` posts
  `type: "frontend"`.
- [ ] **AC2 — idempotent by token.** A second run with the same token, whatever its `--name`, answers the same
  `projectKey` with `created: false`. Both runs together created one project on the board. `project_key_for_token`
  is pure: equal tokens give equal keys, different tokens different keys, and the value is a valid UUID.
- [ ] **AC3 — a key already in `.env` is used, never replaced.** With a UUID `CRUCIBLE_PROJECT_KEY` the board knows,
  the verb posts no create, and answers that key with `created: false` and `source: env`, even when it differs from
  the token's key.
  - These are refused, each naming the key, posting nothing and leaving `.env` byte-identical:
    - one the board does not know (`project-key-unknown`);
    - one whose project is archived (`project-key-archived`, with the board's help);
    - a value that is not a UUID, quoted or not (`project-key-malformed`);
    - one whose project's stored `PROJECT_TOKEN` differs from `--token` (`project-token-mismatch`, naming both;
      no register and no PATCH). A project with no stored token, or the same one, proceeds.
  - The token's key held by an archived project is refused (`project-archived`), with no create posted and nothing
    written.
- [ ] **AC4 — `.env` is read and written as §S3 states.** For each case the file afterwards is as §S3 states and
  every other byte is unchanged:
  - an empty `CRUCIBLE_PROJECT_KEY=` line between other lines;
  - no such line;
  - no `.env` at all, on every client, arduino included;
  - a CRLF file;
  - a file with no final newline;
  - two empty key lines;
  - a key already set (`already-set`, file unchanged).

  Without `--write-env`, `.env` is never written.
- [ ] **AC5 — the metadata is seeded in the same call.** After the create, the verb registers `--agent` with role
  ORCHESTRATOR on the key, with §S2's payload. It then sends one PATCH whose `set` holds `PROJECT_TOKEN`,
  `PROJECT_ACRONYM` (only with `--acronym`) and each `--set` pair. The envelope's `metadata` is the board's map.
  - On the existing-project path, the same register and PATCH run when `--agent` is absent from the project, or is
    an unbound ORCHESTRATOR there.
  - If it is there under another role, with no role (a historical row), or bound to a cycle, the verb exits 1 with
    `agent-role-conflict`. Its row is
    unchanged, no PATCH is sent and `.env` is not written.
  - The verb sends no unregister.
- [ ] **AC6 — errors are envelopes.** Each of these exits non-zero with `ok: false`, an `error` and a `help`, and
  never a bare exit or a traceback:
  - no `--agent`, on a `.env` with no key and with no `.env` at all: the fleet's own `agent-identity-required`
    hard-stop envelope, unchanged (its exit code and shape are the fleet's), with an empty context;
  - an unreachable board, posting nothing further;
  - a refused create, carrying the board's error;
  - a refused register or PATCH after a create, still carrying `projectKey` and still honouring `--write-env`;
  - an `OSError` from `--write-env`, which is the fleet's escaped-failure envelope with an empty context.

  Each refusal of §S2 step 1 posts nothing. That covers:
  - no `--agent`;
  - a `--project-dir` that is not a directory;
  - an empty `--name`;
  - a bad `--token` or `--acronym`;
  - a lowercase `--set` key;
  - `--set CRUCIBLE_PROJECT_KEY=x`;
  - a conflicting `--set PROJECT_TOKEN=`.

  Without `--project-dir`, argparse refuses with exit 2.
- [ ] **AC7 — open, as the board's form.** The create post carries no agent, and a board with no agent registered
  anywhere accepts it. No `src/` file changes in this CR.
- [ ] **AC8 — every client has it.** Each of the six clients parses `project-create` with the flags of §S2 and the
  help line, and delegates to the shared implementation. One end-to-end run per client against a test board gives
  the same envelope fields.
- [ ] **AC9 — no empty key is sent.** On every path of AC1–AC6, no request `project-create` makes carries an empty
  or non-UUID project key, in its path or its body.
- [ ] **AC10 — the module and the move.**
  - `clients/_crucible_project.py` exists, is loaded and re-exported by the core, and defines the `project-meta`
    names of §S1 and `project-create`'s. The core defines none of them.
  - The module imports only the standard library, and the shared modules' ruff check covers it.
  - The `project-meta` tests pass unchanged. The core is at least 80 lines under `CORE_LINE_LIMIT`.
  - Every list and fixture §S1 names includes the module, and an install ships it.
- [ ] **AC11 — the census and the PRD.**
  - `tests/clients-never-self-register-a-project.test.ts` passes with go and the new module listed. The bare
    creation route appears only in `clients/_crucible_project.py`.
  - The PRD and the DN state §S6's text.
  - `tests/client-fleet-docs-no-self-registration-wording.test.ts` passes and finds `project-create` in both slices.
- [ ] **AC12 — docs and hygiene.**
  - The CHANGELOG and README entries of §S6 are present.
  - `HELP_STEPS`, `SHARED_CENSUS` and the envelope census include the verb.
  - The code and tests add no CR id literal, `§` or AC number.

## Non-goals

- Model B's `init --register` itself: a Model B CR, once this ships.
- Archiving, deleting or renaming a project; the existing routes do that. Un-archiving is the board's.
- A token stored on the board, or matching on name (declined at the gap analysis).
- Adopting a project made by hand whose `.env` key is empty: running the verb there creates the token's project.
  The board's form, or writing the key into `.env` first, stays the way to adopt one.
- Changing how the other verbs read `.env` (quotes, CRLF, arduino's stripping).
