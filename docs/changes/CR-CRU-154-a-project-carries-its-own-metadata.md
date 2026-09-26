# CR-CRU-154 — a project carries its own metadata

**Type** feature · **Wave** 7 (0.3.0), before CR-CRU-149 (user ruling 2026-09-26) · **Depends on**
— · **Status** PENDING — filed 2026-09-26

## Problem

**Requested by Model B (Sandesh #1399, 2026-09-26).** Model B is making project settings
schema-driven (their PRD D3.1, CR-MDB-043): `modelb-axi init` generates each project's `.env` from a
schema of rules, and the values belong to the project. They want a project's registry values
mirrored on the board, so that any session or harness can read a project's identity from Crucible
rather than from a checkout. The project's own `.env` stays authoritative; the board holds a copy.

Crucible's project record (`GET /api/v2/projects`) carries `key`, `name`, `type`, `sutRoot`,
`liveness` and `retention`, and `PATCH …/projects/<key>` edits those fields one validated field at a
time. There is no free-form place for a project's own facts.

Model B's example keys: `PROJECT_NAME`, `PROJECT_TOKEN`, `PROJECT_ACRONYM`, `ORCHESTRATOR_LABEL`,
`SANDESH_PROJECT`, `PROJECT_STACKS`, `REPO_OWNER`. `CRUCIBLE_PROJECT_KEY` stays local only: it is how
the project is found. Last write wins; no history. Model B will fit their `init --register` to
whatever shape ships.

**User ruling 2026-09-26:** Crucible owns it, in 0.3.0, before CR-CRU-149.

## Scope (provisional — settled at gap analysis)

### §S1 — a project holds a flat metadata map

A project record carries `metadata`: a flat map of string keys to string values, which Crucible
stores and returns and never interprets. It is written and read through the project routes
(`PATCH`/`GET …/projects/<key>`, and the project list), last write wins.

### §S2 — a client verb pair writes and reads it

`project-meta --set K=V …` writes (orchestrator only) and `project-meta` reads, in all five clients
through one shared implementation, as the usual AXI envelope, with `--format json` for programs
(the §S8 rule of CR-CRU-150: a program such as `init` gets JSON).

### §S3 — the board is readable by anything that reaches it

The board has no authentication. Whatever is mirrored there is readable by every client of the
board, so the contract states that the map holds non-secret facts only.

## Design questions for the gap analysis (to the user)

1. **Secrets.** Model B's list includes `PROJECT_TOKEN`; what it holds is asked of Model B (reply to
   #1399). Does the server refuse secret-shaped keys, or does the contract only say "non-secret"?
2. **Shape.** A `metadata` field on the project record through the existing `PATCH`, or its own
   sub-resource (`…/projects/<key>/metadata`)?
3. **Write semantics.** Does `--set` merge per key or replace the map, and how is a key removed?
4. **Who may write.** Is "orchestrator only" enforced by the server (the registered caller's role)
   or only by the client?
5. **Bounds.** Limits on key count, key length and value length (a bounded surface: the board shows
   projects).

## Acceptance criteria

Written at gap analysis, once the questions above are ruled.

## Model B

Model B runs released clients only, so this reaches them with the 0.3.0 release, and they are told
in its notes. Their `init --register` fits whatever ships.
