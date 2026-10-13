# CR-CRU-185 — a run under a key no project holds is refused, by every client

**Type** fix (patch CR) · **Points** 3 (set at filing, 2026-10-13) · **Wave** 8 (0.4.0) ·
**Depends on** — · **Status** PENDING — filed 2026-10-13 (user ruling: a patch CR in the current
wave and release)

## Problem

Reported by Model B (Sandesh #1447, 2026-10-13). A Model B agent ran `arduino-crucible.py` once with a
deliberately invented `.env` (`CRUCIBLE_PROJECT_KEY=00000000-0000-0000-0000-000000000000`,
`CRUCIBLE_PROJECT_NAME=c4fix-sandbox-does-not-exist`), expecting a refusal. The production board
instead created a project under that key and accepted run `run-b84b3338-…` (1/1 passed). The project
and its two events were removed by hand the same day.

The board refuses an unknown key on every run and agent write (`404 unknown project`). The arduino
client is the one that creates the project. Before its first write, and on `register`, it posts
`POST /api/v2/projects {key, name, sutRoot}` with whatever its `.env` says (`_ensure_project`,
called from `_ensure_project_registered` and three verb paths). The board creates any well-formed
key it is given there. So under the arduino client, a mistyped or invented key silently becomes a
new project. Under the other four clients, the same `.env` is refused.

This self-registration is inherited from v1, whose clients relied on the 400-on-duplicate answer of
`projects/add` (the PRD's transition-shim requirements: "idempotent self-registration"). No other client does it, and registering a
project is otherwise an explicit act: the board's project manager, or `POST /api/v2/projects`.

## Steps

### §S1 — the arduino client never creates a project

`arduino-crucible.py` stops posting to `POST /api/v2/projects`. `_ensure_project` and its callers
(the `register` pre-hook and the verb paths) are removed. The client sends its `.env`'s key as the
other four clients do, so an unregistered key meets the board's existing refusal.

`CRUCIBLE_PROJECT_NAME` stays readable in the `.env` and stays unused for registration. Whether the
client still requires it is settled at gap analysis.

### §S2 — the refusal says how to register

When any client's write is refused with `unknown project: <key>`, its envelope carries the board's
`help[]` unchanged: list the projects (`GET /api/v2/projects`) and register a new one. The client
adds a warning naming the `.env` the key came from. No client works out or registers a key itself.

### §S3 — the documents stop promising self-registration

The PRD line naming "idempotent self-registration", and the client-fleet DN's row describing
arduino's unique `_ensure_project`, say that clients never register projects. A project is
registered by an explicit act.

## Acceptance criteria

- [ ] **No project is created.** For EACH of the five clients, against a live in-process board, with
      a scratch project whose `.env` names a key the board does not hold:
      - `register` and one run verb (`test`, or the stack's equivalent) each exit non-zero;
      - each envelope carries `error` containing `unknown project: <key>` and the board's `help[]`,
        plus a warning naming the `.env` path;
      - afterwards, `GET /api/v2/projects` lists exactly the projects it listed before, and no
        run or agent row exists under that key.
- [ ] **A registered key still works.** For the arduino client, against a board where the key is
      registered first, `register` and one run verb succeed as today. The board receives no
      `POST /api/v2/projects` from the client (the board's request log, or a capturing proxy).
- [ ] **No caller left.** `_ensure_project` and every call to it are gone from `clients/`, and no
      client posts to `POST /api/v2/projects`.
- [ ] **Docs.** The PRD and the client-fleet DN no longer describe client self-registration.
- [ ] **No new CR literals.** No CR-shaped literal is added to comments under `clients/` or
      `src/`, and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED (the unknown-key cases above, failing today for arduino), GREEN in the
arduino client and the shared refusal path, then verify.
