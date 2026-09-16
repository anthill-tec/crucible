# CR-CRU-139 — a connection is configuration too

**Type** feature · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-131, CR-CRU-138 · **Status** PENDING

## Problem

`crucible.toml` is this project's configuration file, and the *connection* — which port the server
listens on, which board a client posts to — is still not in it. It lives only in the environment:

| Knob | Today | Read at |
|---|---|---|
| server port | `$CRUCIBLE_PORT`, default `3849` | `src/server.ts:249` |
| server bind | `$CRUCIBLE_HOST`, default `127.0.0.1` | `src/server.ts:252` |
| client target | `$CRUCIBLE_URL`, default `http://localhost:3849` | each client, e.g. `clients/bun-crucible.py:91` (arduino also honours legacy `$CRUCIBLE_BASE`) |

CR-CRU-131 already made this move for the six limits and RETIRED their three environment variables
(`$CRUCIBLE_DEFAULT_RETENTION`, `$CRUCIBLE_RUN_ABANDON_MS`, `$CRUCIBLE_PROJECT_INACTIVE_MS`) — the
RUNBOOK's "Retired environment variables" section is the precedent. It left the connection knobs
behind on a stated argument: they *"answer where am I and who am I, and must work before any
configuration file can be found."*

**That argument holds for `CRUCIBLE_DB` and `CRUCIBLE_PROJECT_KEY`. It does not hold for the port,
the bind address, or the client's URL.** Neither side needs them to FIND its configuration:

- the server resolves its store first and reads `crucible.toml` from that directory
  (`src/limits.ts:158-159` — `dirname(resolveStore().path)`), so the port is discovered *after* the
  file is already in hand;
- a client resolves its file from the bound project dir, then the install dir
  (`clients/_crucible_axi.py`, the CR-CRU-138 §S1 chain) — a path that never involves the URL.

So three settings sit in the environment for a reason that was only ever true of a fourth.

**What it costs, concretely.** A development board on a second port beside the installed production
one is an ordinary need, and today it is only expressible as an export:

```sh
CRUCIBLE_PORT=3850 bun run src/server.ts
CRUCIBLE_URL=http://localhost:3850 python3 clients/bun-crucible.py status
```

`CRUCIBLE_URL` is bound at import from `os.environ` and is **not** read from the project `.env` (the
clients read that file, but only for `CRUCIBLE_PROJECT_KEY`). So the dev port cannot be declared as
a per-project fact: it must be exported into every shell and every sub-agent dispatch, and the
failure mode of forgetting is silent and severe — **an agent reports its runs into the PRODUCTION
board**, with no error, because `http://localhost:3849` is a working default.

That is the same class of defect as CR-CRU-138: a real, load-bearing value that no file owns.

## The role of this CR: the setting is made NON-PROGRAMMATICALLY

This is the point, and it is not "move three values for tidiness". **An operator must be able to
decide which port the server listens on and which board a client posts to by EDITING A FILE** —
the commented `crucible.toml` already laid down beside each side — and by nothing else:

- **not** by exporting an environment variable into every shell, every terminal tab, every
  sub-agent dispatch and every CI step, where the only record of the decision is a shell history;
- **not** by editing source — today the client's target is a module constant
  (`CRUCIBLE_URL = os.environ.get("CRUCIBLE_URL", "http://localhost:3849")`), so "point this
  checkout at another board" reads as a code change to a shipped file;
- **not** by inventing a launcher wrapper that supplies the env for you, which is the same secret
  kept in a second place.

A configuration file is the artifact an operator OWNS, can read back, can diff, and can hand to
someone else. That is what `crucible.toml` is for, and CR-CRU-131 already settled the principle for
the six limits — this CR finishes the job for the connection.

### The scenario this must satisfy (user, 2026-09-16)

**Two Crucible instances on one machine.** The Crucible and Model B projects dog-food the
DEVELOPMENT instance; every other project on the workstation uses the PRODUCTION one. The
production instance is installed and managed separately — not this repo's concern.

The separation on the data axis already works and needs nothing: a server booted from this repo
adopts `<repo>/data/crucible.db` (the `cwd-data` rule — measured here, schema 13), while an
installed production server creates its own store under `~/.local/share/crucible/`. **Only the port
and the client's target are unresolved**, and today both are only expressible as exports.

So the acceptance bar is behavioural, not structural: with the two files edited and NOTHING
exported, a verb run from this checkout reaches the development board, and the same verb run from
another project reaches production. A reader must be able to answer "which board does this project
talk to?" by opening one file.

## Scope

### §S1 The server's listener is declared in its own `crucible.toml`

`src/crucible.toml` gains a `[server]` table carrying `port` and `host`, documented in the same
commented style as the limits, and `startServer` resolves them through the existing
point-of-use read rather than from `process.env`.

Precedence, matching CR-CRU-131's shape for limits: an explicit `opts` argument (a test's own
choice) wins, then the file, then the shipped default. `$CRUCIBLE_PORT` and `$CRUCIBLE_HOST` are
**retired** exactly as the three limit variables were — they stop being read, and the RUNBOOK's
"Retired environment variables" section gains them with the same "declare it in the table instead"
wording. A retired variable that silently still works is worse than either state.

### §S2 A client's target board is declared in its own `crucible.toml`

`clients/crucible.toml` gains a `[client]` table carrying `url`, resolved through the CR-CRU-138
§S1 chain — project dir first and overriding, then the install dir, then the shipped default. That
is what makes a dev board a per-PROJECT fact: a checkout pointed at `http://localhost:3850` keeps
pointing there for every verb and every sub-agent, with nothing to export and nothing to forget.

The base URL stops being a per-client module constant bound at import. All five clients resolve it
from the one shared place (`_crucible_axi.py`), which is the CR-CRU-133 §S2 "spelled in ONE place"
pattern; the four `CRUCIBLE_URL` constants and arduino's `CRUCIBLE`/`CRUCIBLE_BASE` pair collapse
into it.

`$CRUCIBLE_URL` is **retired** with the others. A single mechanism, or the one that is easiest to
forget wins by accident.

### §S3 `CRUCIBLE_DB` and `CRUCIBLE_PROJECT_KEY` stay in the environment, and the file says why

These two genuinely precede configuration discovery: the store path is how the server FINDS its
file, and the project key is identity, read from the project `.env` the clients already load. They
stay environment-resolved, and both shipped `crucible.toml` files state that explicitly — so a
reader who finds `[server] port` in the file does not conclude the store belongs there too, and a
later CR does not "finish the job" by moving a value that cannot move.

### §S4 One rule, so a second board cannot be reached by accident

A client that resolves a URL from configuration must SAY which board it is talking to when that
board is not the shipped default — in the envelope `context`, beside `projectKey`. The silent
failure this CR exists to remove is an agent reporting into the wrong board; the defence is that
the envelope names the target, so a misdirected run is visible in its own output rather than
discovered later on the wrong dashboard.

## Acceptance criteria

- [ ] `src/crucible.toml` declares `[server]` with `port` and `host`, each with the description /
      default commentary the limits tables carry.
- [ ] A server booted with a `[server] port` set listens on THAT port, proven by a real request to
      it; with no file present it listens on the shipped default.
- [ ] An explicit `startServer({ port })` still wins over the file — the test seam is unchanged.
- [ ] `$CRUCIBLE_PORT` and `$CRUCIBLE_HOST` are no longer read: a server booted with both exported
      to junk values still listens per its file/default. Asserted by an actual boot, not by grep.
- [ ] `clients/crucible.toml` declares `[client] url`.
- [ ] With a project-dir `crucible.toml` naming a second board, every one of the five clients posts
      THERE — asserted by running a verb against a second server on a different port and reading
      which one recorded the run.
- [ ] Project dir beats install dir beats shipped default for `url`, by the same chain CR-CRU-138
      §S1 built (one test, both files present, different values).
- [ ] `$CRUCIBLE_URL` and `$CRUCIBLE_BASE` are no longer read; a junk export changes nothing.
- [ ] No client module holds its own base-URL constant: the value resolves from `_crucible_axi.py`
      alone, and a grep for `CRUCIBLE_URL =` across `clients/` returns nothing.
- [ ] `CRUCIBLE_DB` and `CRUCIBLE_PROJECT_KEY` still work exactly as today, and both shipped tomls
      state why they are not in the file.
- [ ] A verb whose resolved URL is not the shipped default names that URL in its envelope `context`.
- [ ] `docs/RUNBOOK.md`: the three newly retired variables join "Retired environment variables"
      with the same wording; the "Environment variables (port / bind / database)" section is
      corrected to the two that remain; and the dev-beside-production setup is documented as a
      `[client] url` / `[server] port` pair rather than an export.
- [ ] `tests/docs-runbook-documents-every-limit.test.ts` still passes, and the new figures are
      derived from the shipped tomls rather than retyped (CR-CRU-134's rule).

## Non-goals

- Moving `CRUCIBLE_DB` or `CRUCIBLE_PROJECT_KEY` into the file (§S3 — they precede discovery).
- Merging the client and server tomls. Still disjoint by design, still two packages (CR-CRU-131
  §S1c).
- Authentication or multi-board routing. One declared target per project, not a board registry.
