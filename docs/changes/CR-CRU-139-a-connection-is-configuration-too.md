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

### §S1a The INSTALLER writes the connection, so nothing needs an environment

**User ruling 2026-09-16, and it removes the last excuse for the environment layer:** the installer
already lays `crucible.toml` down (CR-CRU-138 §S2 beside the database, §S4 beside the fleet), so it
is the thing that SETS these values — an operator does not hand-edit a fresh install, and no
process needs `Environment=CRUCIBLE_PORT=` to be told where to listen.

So `crucible-axi install` accepts the connection settings and WRITES them into the files it lays
down: the listener into the server's `[server]` table, the board URL into the fleet's
`[client]` table. An install on a machine that already carries a production instance is
therefore configured at install time, in the file, once — which is exactly the two-instance
scenario above.

**The installer DISCOVERS the port; it does not ask a human to pick one (user ruling
2026-09-16).** The shipped `[server]` table declares a RANGE this project is willing to occupy —
the same `description`/`min`/`max` shape the limits already use, so the range is documented where
it is set. At install time the installer PROBES that range on the machine it is running on, takes
the first port it can actually BIND, and writes that concrete port into the file it lays down. The
client file's `[client] url` is written from the same resolved value, so the two halves of one
install cannot disagree.

Three properties this must have, each a way the naive version fails:

- **Probe by BINDING, not by connecting.** A refused connection proves only that nothing is
  listening *right now*; binding proves the port is available to us, and closing the probe socket
  immediately before the server claims it is the standard accept-then-release window. A probe that
  merely fails to connect will happily hand out a port another service has reserved.
- **Idempotent across re-installs.** A re-install must KEEP the port already written — an install
  that renumbers a running instance breaks every client whose file names the old one, and breaks
  the systemd unit's health. Re-probe only when the configured port is unavailable AND not held by
  our own server.
- **Exhaustion is an error, never a silent fallback.** If no port in the declared range can be
  bound, the install FAILS naming the range and what it found, rather than drifting outside the
  range or falling back to the shipped default. A silent fallback is how two instances end up on
  one port.

This is what makes the two-instance story require no coordination: production installs and takes a
port; this repo's development instance installs and takes the next free one; neither knows about
the other, and both record what they took.

**`_unit_environment()` stops forwarding `CRUCIBLE_PORT`/`CRUCIBLE_HOST`** (`crucible_axi/install.py:863-879`).
The unit needed them only because the server had no file to read; with §S1 it does, and the
forwarding becomes a second place the same datum can be set — the defect, not the feature. The
unit keeps forwarding nothing but `PATH`, and `CRUCIBLE_DB` per §S3.

### §S1b A test overrides in-process or with its own file — never through the environment

Tests are not production, and they do not need an environment layer to redirect a client: today
~89 call sites across `tests/` inject `CRUCIBLE_URL` to point a client at an ephemeral-port
server, and every one of those fixtures ALREADY owns a temp root and writes files into it.

Two mechanisms replace it, both stronger than an export:

- **In-process** — `startServer({ port })` already wins over everything (`src/server.ts:249`), and
  stays the server-side seam. A test naming its own port is explicit, local and unambiguous.
- **Its own config file** — a client test writes a `crucible.toml` carrying `[client] url` into the
  temp project (or install) root its fixture already creates, and the CR-CRU-138 §S1 chain resolves
  it. This has a property the export never had: the test exercises the REAL resolution path, so it
  proves the mechanism operators use rather than a bypass only tests can reach.

Migrating those call sites is the bulk of this CR's work and is deliberate: it is the difference
between configuration that is tested and configuration that is merely shipped.

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

**§S1a — the installer sets it, so an operator never has to**

- [ ] `crucible-axi install` accepts the connection settings and WRITES them into the files it lays
      down: the listener into the server file's `[server]` table, the board URL into the fleet's
      `[client]` table. Asserted by running a real install into a temp target and reading the
      resulting files, not by reading the installer's own output.
- [ ] A second install on the same machine, given different settings, produces a second instance
      whose files name its own port and board — the two-instance scenario, proven end to end: boot
      both, run a verb against each, and assert each run landed on the board its own file names.
- [ ] The shipped `[server]` table declares the PORT RANGE this project may occupy, documented the
      way the limits are (a sentence plus bounds), so the range is read where it is set.
- [ ] The installer PROBES that range and writes the first port it can BIND into the file it lays
      down; the fleet's `[client] url` is written from the SAME resolved value, so one install's two
      files cannot disagree. Asserted by reading both files after a real install.
- [ ] The probe binds rather than connects: with a listener occupying the first port of the range,
      the install takes the NEXT one — and with a socket bound but not listening on it, the install
      still skips it. A connect-based probe passes the first case and fails the second, so both are
      asserted.
- [ ] A RE-INSTALL keeps the port already written, even while the instance is running on it: the
      file is unchanged and no client is orphaned. Re-probing happens only when the configured port
      cannot be bound and is not held by our own server.
- [ ] Range exhaustion FAILS the install, naming the range and what it found — it never drifts
      outside the range and never falls back to the shipped default. Asserted by occupying every
      port of a narrow test range.
- [ ] Two installs on one machine, run with no knowledge of each other, land on DIFFERENT ports and
      each records its own: boot both, run a verb against each, assert each run landed on the board
      its own file names.
- [ ] An operator-EDITED connection value SURVIVES a re-install (the `_operator_config_is_untouched`
      rule, unchanged — configuration the operator changed is data, not an artifact).
- [ ] `_unit_environment()` (`crucible_axi/install.py:863-879`) no longer forwards `CRUCIBLE_PORT`
      or `CRUCIBLE_HOST`; the rendered unit carries neither, and the installed server still listens
      on its configured port — asserted by reading the rendered unit text AND by the server's own
      `/api/health`.

**§S1b — tests override in-process or with their own file, never the environment**

- [ ] No file under `tests/` sets `CRUCIBLE_URL`, `CRUCIBLE_BASE`, `CRUCIBLE_PORT` or
      `CRUCIBLE_HOST` in a child environment. The ~89 current call sites migrate to either
      `startServer({ port })` (server side) or a `crucible.toml` written into the fixture's own temp
      root (client side). A repo-wide grep is the assertion.
- [ ] At least one migrated client test proves it exercises the REAL resolution path: the temp
      `crucible.toml` it wrote is the file the client reports resolving.
- [ ] `_UNREACHABLE_CRUCIBLE_URL`-style offline-degradation tests keep working through the file, so
      the degradation contract (CR-CRU-131: a client still formats output with no board reachable)
      is unchanged.
- [ ] The two doc guards that currently REQUIRE the retired variables to be documented are updated
      to the new reality, not deleted: `tests/docs-db-path-resolution.test.ts:117-122` (the env
      table listing `CRUCIBLE_PORT`/`CRUCIBLE_HOST`) and
      `tests/cr009-release-bundle.test.ts:1435-1440` (the RUNBOOK's `CRUCIBLE_PORT=… crucible-axi
      serve` examples). Each still pins a real rule — that the RUNBOOK documents how to set the
      listener — and the rule's subject becomes the config file.
- [ ] `crucible_axi/cli.py`'s `serve` no longer composes `$CRUCIBLE_HOST`/`$CRUCIBLE_PORT` into a
      child environment (`cli.py:277`); `--host`/`--port` flags, where kept, write to or read from
      the file rather than exporting.

## Non-goals

- Moving `CRUCIBLE_DB` or `CRUCIBLE_PROJECT_KEY` into the file (§S3 — they precede discovery).
- Merging the client and server tomls. Still disjoint by design, still two packages (CR-CRU-131
  §S1c).
- Authentication or multi-board routing. One declared target per project, not a board registry.
