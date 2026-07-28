# CR-CRU-043 — Patch: installed server misplaces its database (CWD-relative default)

**Status:** PENDING
**Type:** patch (runtime correctness)
**Priority:** P1 — a published 0.1.0 server writes its data to whatever directory it was launched from
**Depends on:** CR-CRU-009 (the `bin/crucible-server.mjs` shim + the installable package)
**Labels:** patch, server, persistence, packaging, 0.1.0-blocker
**Phase:** Wave 4 (0.1.0 blocker)
**Design reference:** PRD §2 "Persistence" — embedded SQLite chosen as *"decisive for the
skill-bundle deployment target (client scripts + server + skill, installable on any machine
with Bun): the DB ships inside the runtime"*. Found by the CR-CRU-041 gap-analysis
(2026-07-28) as DRIFT-1.

## Context
`src/server.ts:147` defaults the store to a **relative** path:

```
const dbPath = opts?.dbPath ?? "data/crucible.db";
```

and `src/server.ts:217` — the `import.meta.main` production entry that
`bin/crucible-server.mjs` execs — calls `startServer()` with no options, so the installed
server always takes that default. A relative path resolves against the **process CWD**.

While Crucible only ever ran from its own repo root this was invisible. Once published,
`npx -y @anthill-tec/crucible-server` (or the `crucible-server` bin the RUNBOOK documents)
creates `./data/crucible.db` in whatever directory the user happened to be in. Launch it
from somewhere else and the dashboard is empty — the run history looks lost, though it is
merely in another folder. `docs/RUNBOOK.md:40` documents this CWD-relative behaviour, so
docs and code agree with each other and both diverge from the PRD's portable-bundle intent.

Two supporting observations from the gap-analysis:
- **Asymmetry inside the same file.** `PUBLIC_DIR` (`src/server.ts:92`) resolves
  package-relative via `import.meta.url`; only the DB is CWD-relative.
- **Missing knob.** `CRUCIBLE_PORT` (`:168`) and `CRUCIBLE_HOST` (`:171`) are
  env-configurable; the DB path has no equivalent, so a user cannot even work around it.

The package-directory is NOT a valid target either: `npx` resolves into an ephemeral cache,
so data written beside the package would vanish on a cache clear.

## Scope

### §S1 — `CRUCIBLE_DB` environment override
Add a `CRUCIBLE_DB` env var giving the store path, at parity with `CRUCIBLE_PORT` /
`CRUCIBLE_HOST`. An explicit `opts.dbPath` still wins over it (tests pass `:memory:`).

### §S2 — A CWD-independent default for the installed case
When no explicit path and no `CRUCIBLE_DB` are given, default to the user data directory —
`$XDG_DATA_HOME/crucible/crucible.db`, falling back to `~/.local/share/crucible/crucible.db`
when `XDG_DATA_HOME` is unset. Stable across invocations regardless of CWD, persistent
across `npx` cache clears, and needs no privileges. Directory creation keeps the existing
`mkdirSync(..., { recursive: true })` behaviour.

**This mirrors Sandesh exactly** — `sandesh/sandesh_db.py:119-126` resolves
`data_home() = $XDG_DATA_HOME or ~/.local/share` and stores
`<data_home>/sandesh/sandesh.db`, described in its own header as *"the ONE global DB, WAL —
all projects"*. Live on this machine at `~/.local/share/sandesh/sandesh.db`. Crucible has the
same architecture — a single machine-wide instance whose dashboard serves many projects at
once (Crucible v2, Model B, dbg, Probe, Sandesh) — so the database is **machine-scoped, not
project-scoped**, and a CWD-relative default was conceptually wrong, not merely inconvenient.
Note the store is three files under WAL (`.db`, `.db-shm`, `.db-wal`), which independently
rules out the `npx` package directory (an ephemeral cache).

### §S3 — Repo-development continuity (no migration, no data loss)
The resolution order is, first match wins:

1. explicit `opts.dbPath`
2. `CRUCIBLE_DB`
3. **an already-existing `./data/crucible.db`** relative to CWD
4. the §S2 user-data-directory default

Rule 3 preserves the live dog-food instance exactly as-is: running from the repo root finds
the existing file and keeps using it, so the accumulated run history is untouched and no
migration step is required. It only ever *adopts* a database that already exists — it never
creates one CWD-relative, which is what causes the scattering.

### §S4 — RUNBOOK
Update `docs/RUNBOOK.md` §"Database path" to state the resolution order, document
`CRUCIBLE_DB` in the environment table alongside `CRUCIBLE_PORT`/`CRUCIBLE_HOST`, and
replace the "relative to the working directory" sentence (`:40`), which will no longer be
true for an installed server. Also refresh the corrupt-db example path (`:56`) for
consistency — the recovery behaviour itself is unchanged and location-independent (it renames
to `<path>.corrupt-<epoch>` and reopens at the original path).

### §S5 — PRD §2 storage paragraph (design surface — user-approved 2026-07-28)
`docs/research/PRD-crucible-v2.md:68` currently names the literal path: *"embedded SQLite via
Bun's built-in `bun:sqlite` (WAL mode, `data/crucible.db`)"*. That was a deliberate original
decision (`CR-CRU-001` §"Store backed by `bun:sqlite`, WAL mode, db path `data/crucible.db`"),
so this CR is a **design change**, not only a defect fix — the PRD must move with the code
rather than be left contradicting it. Replace the bare path with the §S3 resolution order,
preserving the surrounding rationale (embedded SQLite, no DB server, portable-bundle intent),
which is unaffected. Edit approved by the user as a cross-CR design surface.

## Acceptance criteria
- [ ] With `CRUCIBLE_DB=<tmp>/x.db` set and no explicit opts, the server opens exactly that
      path — asserted.
- [ ] Started from a scratch directory containing **no** `data/crucible.db`, with
      `XDG_DATA_HOME=<tmp>`, the server opens `<tmp>/crucible/crucible.db` and creates
      **no** `data/` directory in the CWD — asserted (this is the defect's regression test).
- [ ] Started from a directory that **does** contain `data/crucible.db`, the server opens
      that existing file and does not touch the user-data directory — asserted (dog-food
      continuity).
- [ ] Precedence holds: explicit `opts.dbPath` beats `CRUCIBLE_DB` beats an existing
      `./data/crucible.db` beats the default — asserted across the chain.
- [ ] `opts.dbPath = ":memory:"` still bypasses all directory creation (existing test
      behaviour preserved; the whole suite uses it).
- [ ] `docs/RUNBOOK.md` documents the resolution order and lists `CRUCIBLE_DB` in the env
      table; the "relative to the working directory" sentence is gone.
- [ ] `docs/research/PRD-crucible-v2.md` §2 no longer names a bare `data/crucible.db` as the
      store location — it states the resolution order (§S5).
- [ ] Full bun suite green; the live dog-food server, restarted from the repo root, still
      shows its existing run history.

## Non-goals
- Migrating or relocating any existing database — rule 3 makes migration unnecessary.
- Multi-instance / multi-user data separation, or a configurable data *directory* beyond the
  single `CRUCIBLE_DB` file path.
- The corrupt-db recovery flow (already specified and working — it operates on whatever path
  resolution yields).
- Release mechanics (CR-CRU-041) and the release ceremony (CR-CRU-009 §S6).

## Risk
- The live dog-food instance is the highest-value database in the project. §S3 rule 3 is
  what protects it; that rule needs its own test (AC 3) and must not be weakened to
  "always use the default".
- Any test that relies on the implicit `"data/crucible.db"` default rather than passing
  `:memory:` would change behaviour — the suite must be swept for such cases as part of RED.
