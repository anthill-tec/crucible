# CR-CRU-185 — a run under a key no project holds is refused, by every client

**Type** fix (patch CR) · **Points** 3 (confirmed at gap analysis, 2026-10-14) · **Wave** 8 (0.4.0) ·
**Depends on** — · **Status** PENDING — filed 2026-10-13 (user ruling: a patch CR in the current
wave and release)

## Problem

Reported by Model B (Sandesh #1447, 2026-10-13). A Model B agent ran `arduino-crucible.py` once with a
deliberately invented `.env` (`CRUCIBLE_PROJECT_KEY=00000000-0000-0000-0000-000000000000`,
`CRUCIBLE_PROJECT_NAME=c4fix-sandbox-does-not-exist`), expecting a refusal. The production board
instead created a project under that key and accepted run `run-b84b3338-…` (1/1 passed). The project
and its two events were removed by hand the same day.

The board refuses an unknown key on every run and agent write (`404 unknown project`, with a `help[]`
naming how to list and register projects). The arduino client is the one that creates the project.
Before `register` (its `pre_register` hook) and before its native-test, compile and `auto-ingest`
runs, it posts `POST /api/v2/projects {key, name, sutRoot}` with whatever its `.env` says
(`_ensure_project`). The board creates any well-formed key posted there. So under the arduino client,
a mistyped or invented key silently becomes a new project, while under the other four clients the
same `.env` is refused.

This self-registration is inherited from v1, whose clients relied on the 400-on-duplicate answer of
`projects/add`. No other client does it. A project is registered by an explicit act: the board's
"+ Add project" form, or `POST /api/v2/projects`, which issues the key the `.env` then carries.

The refusal the other four clients print today buries the board's `help[]` inside the `error` string
and offers its own unrelated `help` (`register` → `test --agent <agentId>`). The operator is not told
how to register a project, or which `.env` holds the key.

## Steps

### §S1 — the arduino client never creates a project

`arduino-crucible.py` stops posting to `POST /api/v2/projects`: `_ensure_project`, the
`_ensure_project_registered` pre-register hook and every call to them are removed. The client sends
its `.env`'s key as the other four clients do, so an unregistered key meets the board's existing
refusal.

`CRUCIBLE_PROJECT_NAME` is no longer required (user ruling, 2026-10-14). Like the other four clients,
the arduino client reads only `CRUCIBLE_PROJECT_KEY`. A `.env` that still carries the name keeps
working, and the line is ignored.

### §S2 — an unknown-project refusal says how to register

When the board refuses any client write with `unknown project: <key>`, the client's envelope:

- carries `error` containing `unknown project: <key>`;
- carries the board's own `help[]` in place of the verb's usual next steps;
- carries a warning naming the `.env` path the key was read from.

The exit is non-zero. No client works out or registers a key itself.

### §S3 — the documents stop promising self-registration

The PRD's transition-shim line that names "idempotent self-registration", and the client-fleet DN's
`_project_key` row that describes arduino's `_ensure_project`, say instead that clients never
register projects and that a project is registered by an explicit act.

## Acceptance criteria

- [ ] **No project is created.** For EACH of the five clients, against a live in-process board, with
      a scratch project whose `.env` names a key the board does not hold:
      - `register` and the client's `test` verb each exit non-zero;
      - each envelope's `error` contains `unknown project: <key>`, its `help[]` is the board's (it
        names `GET /api/v2/projects`), and a warning names the `.env` path;
      - afterwards, `GET /api/v2/projects` lists exactly the projects it listed before, and no run
        or agent row exists under that key.
- [ ] **A registered key still works, and posts no project.** For the arduino client, against a
      board where the key is registered first, `register`, `test`, the compile run and
      `auto-ingest` each succeed as today, and the board receives no `POST /api/v2/projects`
      (a capturing proxy). The existing test that pins arduino's self-registration is replaced
      by this one.
- [ ] **The name is optional.** The arduino client, given a `.env` with `CRUCIBLE_PROJECT_KEY` and no
      `CRUCIBLE_PROJECT_NAME`, runs `register` and `test` against a registered key and succeeds.
- [ ] **No caller left.** `_ensure_project`, `_ensure_project_registered` and the shared
      `pre_register` hook's arduino use are gone from `clients/`. No client posts to
      `POST /api/v2/projects` (asserted over the source of all five clients and the shared module).
- [ ] **Docs.** The PRD and the client-fleet DN no longer describe client self-registration.
- [ ] **No new CR literals.** No CR-shaped literal is added under `clients/` or `src/`. If deleting
      the self-registration code lowers the `clients` count, the citation tripwire's `head` pin is
      re-recorded once, to the measured figure, in the same commit.

## How it is worked

On a feature branch: RED (the unknown-key and registered-key cases above, failing today for
arduino and for the refusal envelope), GREEN in the arduino client and the shared refusal path,
then verify.
