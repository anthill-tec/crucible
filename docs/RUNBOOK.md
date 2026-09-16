# Crucible Server — Runbook

Operating guide for the Crucible server (`src/server.ts`).

The server is a **Bun** program — Bun is its runtime, and `crucible-axi install`
guarantees it (detecting Bun, or bootstrapping it and verifying `bun --version`,
failing the install outright if it cannot). There is no node launcher.

## Start

```sh
# the provisioned server, in the foreground (Ctrl-C stops it)
crucible-axi serve

# or directly from a checkout
bun run src/server.ts
# or
bun run start
```

`crucible-axi serve` runs the server the `crucible-axi install` [server] stage
provisioned, launched by ABSOLUTE path (`$BUN_INSTALL/bin/crucible-server`, or
the version-pinned package through the resolved absolute Bun when that bin is
missing) — never a bare token, so it also works under a minimal `PATH`. It
blocks for the life of the run and exits with the server's own exit code. If
neither the provisioned bin nor a usable Bun can be resolved it prints the
remedy to stderr and exits 1 rather than half-starting.

On boot the server logs its listen URL, e.g.:

```
[crucible] listening on http://localhost:3849
```

## Stop

The server installs graceful signal handlers. Send `SIGINT` (Ctrl-C) or
`SIGTERM` to stop it — on either signal it **checkpoints every active cycle's
timer across all plans/projects** before exiting, so an orderly shutdown never
loses in-flight epoch state:

```sh
# Ctrl-C in the foreground, or:
kill -TERM <pid>
```

Only a hard power cut (no signal) falls back to the read-cadence tolerance; a
clean `stop` is always preferred.

## Database path

Crucible is a single machine-wide server serving every project, so its SQLite
database is machine-scoped, not project-scoped. The path is resolved on boot in
this order — **first match wins**:

1. an **explicit** path passed to `startServer` (`opts.dbPath`); the test suite
   passes `:memory:` here for an ephemeral, non-persistent store;
2. the **`CRUCIBLE_DB`** environment variable, when set — an absolute or
   relative file path to use verbatim;
3. an **already-existing `./data/crucible.db`** under the process working
   directory — *adopted only, never created*. This is the compatibility rule
   that keeps an existing repo-local database working with no migration step;
   if no such file is present, nothing is created there and resolution falls
   through;
4. **`$XDG_DATA_HOME/crucible/crucible.db`**, falling back to
   **`~/.local/share/crucible/crucible.db`** when `XDG_DATA_HOME` is unset.

The parent directory of the resolved path is created automatically on boot
(`mkdirSync(..., { recursive: true })`), except for `:memory:`.

## Corrupt database recovery

Boot must never fail because of a bad db file. **One deliberate exception**
(CR-CRU-071): a store from a NEWER Crucible is refused rather than
quarantined — see Schema versions and migration. Quarantining a readable,
newer database would rename live data aside and boot empty, so that case
exits non-zero and touches nothing. On start the server opens the
store defensively (`Store.open`): it opens the db and forces a trivial probe
query (`PRAGMA schema_version`) to surface a corruption error that `bun:sqlite`
might otherwise defer past open.

If that probe throws — a truncated, malformed, or otherwise unreadable SQLite
file — the server does **not** crash. It:

1. renames the bad file aside to **`<path>.corrupt-<epoch>`** (e.g.
   `~/.local/share/crucible/crucible.db.corrupt-1737600000000`, where `<epoch>` is the
   `Date.now()` millisecond timestamp), preserving it for later inspection;
2. logs a `[crucible] CORRUPT DATABASE …` line to stderr naming both paths and
   the underlying error; and
3. opens a **fresh, empty** db at the original path and continues booting.

Recovery is therefore automatic — the service comes up clean. Historical data
in the moved-aside `*.corrupt-*` file is not auto-recovered; keep or forensically
inspect it as needed, then delete it once you no longer need it.

## Limits

Every bound Crucible enforces is **configuration** — a `[limits.<name>]` table
in a `crucible.toml`, read at the point of use — never a constant compiled into
a source file. The limits are split across **two files**, because a limit is
owned by the process that **enforces** it. The server resolves its own store
and may be installed anywhere, while a client resolves a project directory and
then posts over HTTP. Neither process reads the other's file, and editing one
never changes the other.

Every limit's table carries four fields of documentation — `description`,
`recommended`, `min` and `max` — and, only where you set one, your own `value`.
The two tables below are that documentation, reproduced from the shipped files
themselves.

### The server's limits — beside the server's own database

The server reads the `crucible.toml` in the directory of the database it
resolved on boot (see "Database path" above). With the store at
`~/.local/share/crucible/crucible.db` the file is
`~/.local/share/crucible/crucible.toml`, and `GET /api/health` names the store
this process opened, which is how you confirm the directory before editing.

**You do not have to create it.** When the installer provisions the server on
this machine it lays that operator-editable file down for you, and the
`[manifest]` row of the install output names the path it wrote — or, when no
server is provisioned here, states that it wrote nothing and why. An operator
who reads the install output therefore knows which file to edit without
guessing.

When the board runs on another machine, that file lives on THAT machine — these
three limits cannot be set from a project checkout, and an install here writes
nothing for a board over there. The distribution's own copy,
`src/crucible.toml`, is package data replaced wholesale on upgrade and is
**not** the file you edit.


| Limit | Description | Recommended | Min | Max |
|---|---|---|---|---|
| `run_abandon_ms` | Milliseconds an OPEN run may live before the sweep settles it as `abandoned`. Raise it when a legitimate suite runs longer than the deadline; lower it to clear ghost runs off the board sooner. | `1800000` (30 minutes) | `60000` (1 minute) | `86400000` (24 hours) |
| `project_inactive_ms` | Milliseconds of silence after which a project with no live agent reads INACTIVE on the board's project list. Raise it to keep occasional projects visible; lower it to retire finished ones from the default view sooner. | `3600000` (1 hour) | `300000` (5 minutes) | `2592000000` (30 days) |
| `retention` | Events kept per project for projects that declare no `retention` of their own. NOTE the documented exception: with NO crucible.toml at all there is NO cap and the boot banner names the uncapped projects — this number applies only once the table exists. | `5000` | `10` | `1000000` |

### The project's limits — in the project directory

A client reads its configuration on every call, from the **first readable file**
of an ordered chain. These three bound what a client PRINTS, so they belong to
the machine reading the output: on a fleet whose board is on a different
machine, widening a display width over there changes nothing.

1. **`<project directory>/crucible.toml`** — beside the `.env` the clients
   already read. FIRST, and it OVERRIDES everything below it. This is where you
   set a limit for one project.
2. **`<install dir>/crucible.toml`** — the operator-editable file the installer
   lays down (`~/.crucible/crucible.toml` by default). Set a limit here to move
   it for every project on this machine that does not override it. A client
   finds this path from its OWN location, not from the directory you happen to
   be standing in.
3. **`<install dir>/clients/crucible.toml`** — the distribution's own shipped
   declarations, laid down beside the client code as package data and replaced
   wholesale on upgrade. The last resort, and **not** a file you edit.

So with both a project file and an installed file present, the **project
directory's file decides**. There is no working-directory fallback: running a
client from an unrelated directory resolves the same configuration as running it
from anywhere else. When nothing readable is found, the client warns and names
every path it tried, in this order, then runs every limit at the value the build
recommends.


| Limit | Description | Recommended | Min | Max |
|---|---|---|---|---|
| `truncate_field_chars` | Visible characters of a long text field before the envelope cuts it and appends a size hint naming the true length; `--full` defeats it per call. | `200` | `20` | `4000` |
| `error_detail_chars` | Maximum characters of the warning detail reported for a run that produced NO report, so a starved runner's output cannot flood the envelope carrying its cause. | `500` | `100` | `20000` |
| `roadmap_list_rows` | Rows of a roadmap list emitted before it is truncated; `totalCount` always reports the TRUE total and `--full` emits the list whole. | `20` | `5` | `500` |

### Changing a limit

Add a `value = …` line to that limit's table in the file that owns it. Nothing
needs restarting — both sides re-read their file at the point of use, so an
edit takes effect on the next call and on the next sweep.

```toml
[limits.roadmap_list_rows]
# the four documented fields, exactly as shipped — left alone
value = 40
```

**Never edit `description`, `recommended`, `min` or `max`.** Those four are
documentation — the record of what we ship and stand behind — and overwriting
`recommended` in place destroys, in the very file you are reading, the means of
telling our number from yours after the next upgrade. Your `value` sits beside
them, and the range beside it is the range that is enforced.

**A refused value is not clamped.** A `value` outside the `[min, max]` declared
beside it is refused at resolution and disclosed — naming the limit, your
value, the range it crossed and the recommendation — and the limit runs at its
`recommended` until the file is corrected:

```
[crucible] WARNING: /srv/crucible/crucible.toml sets `run_abandon_ms` to 30000, outside the range [60000, 86400000] declared beside it — the value is REFUSED, not clamped, so `run_abandon_ms` runs at its recommended 1800000 until the file is corrected.
```

An absent or unparseable file is not an error either. Every limit then runs at
its `recommended`, and the server says so at boot, naming the file it could not
read.

**Two of the floors are not round numbers.** `project_inactive_ms` may not go
beneath the agent tombstone horizon the board already keeps (`DEFAULT_LIVENESS`,
`300000` ms) — a shorter window would report a project inactive while its own
agents still read live, a verdict the board cannot honour. `error_detail_chars`
may not go beneath the length of the warning prefix it bounds, because that
prefix is composed first and is never truncated, so `100` is the floor that
leaves the prefix intact with room for a fragment of the cause.

### `--full`

`--full` defeats the two display widths for one invocation — a call carrying it
prints a `truncate_field_chars` field whole and emits every row a
`roadmap_list_rows` list would otherwise have cut. A truncated list reports the
true total in `totalCount` either way. `--full` never reaches
`error_detail_chars`, which is composed at warning time and takes no `full`
argument at all.

### Retired environment variables

Three environment variables once overrode limits from the environment. They are
gone — nothing reads them, and exporting one changes nothing:

- `$CRUCIBLE_DEFAULT_RETENTION` is RETIRED and no longer read; declare a
  `[limits.retention]` table in the server's file instead.
- `$CRUCIBLE_RUN_ABANDON_MS` is RETIRED and no longer read; set a `value` in
  the `[limits.run_abandon_ms]` table instead.
- `$CRUCIBLE_PROJECT_INACTIVE_MS` is RETIRED and no longer read; set a `value`
  in the `[limits.project_inactive_ms]` table instead.

Four more carried the **connection** — the server's listener and the clients'
board. They are gone for the same reason and one sharper: a limit left to its
default behaves as documented, whereas a forgotten connection export fails
*silently*, landing a run on the default board, which on a machine carrying a
production instance is the production board:

- `$CRUCIBLE_PORT` is RETIRED and no longer read; declare `port` in the
  `[server]` table of the server's own file instead.
- `$CRUCIBLE_HOST` is RETIRED and no longer read; declare `host` in that same
  `[server]` table instead.
- `$CRUCIBLE_URL` is RETIRED and no longer read; declare `url` in the
  `[client]` table of the project's own `crucible.toml` instead.
- `$CRUCIBLE_BASE` is RETIRED and no longer read; it was the second spelling
  of the same board and it is replaced by the same `[client] url`.

`CRUCIBLE_DB` and `CRUCIBLE_PROJECT_KEY` are untouched and still read — they
answer *where am I* and *who am I*, and must be answerable **before** any
configuration file can be found, because finding the file is what they decide.
See "Environment variables" below.

## Retention

Retention is the only limit with **two layers**, and the only one a project can
set for itself.

**What it governs.** Retention caps a project's disposable events — `test`,
`compile` and `lifecycle` — and nothing else. A `gate` and a `milestone` are
RECORDS rather than telemetry, each living in a table of its own that retention
cannot reach, so no cap ever evicts one.

**Enforcement.** On ingest, when a project's disposable-event count exceeds its
cap, the oldest of them (ordered by timestamp, then insertion order) are pruned
back to the cap, transactionally, so a crash can never leave an event both
folded and re-foldable. A `test` or `compile` event folds into its daily
test-run rollup *before* deletion, so what it contributed to that day's totals
survives pruning, while a `lifecycle` event contributes nothing to a rollup and
is simply pruned. Rollups and active-cycle state are untouched.

**Precedence.** A project's own `retention` overrides the `[limits.retention]`
value in the server's file, and it does so for that project alone. Set it with
a PATCH on the project:

```sh
curl -fsSL -X PATCH http://127.0.0.1:3849/api/v2/projects/<key> \
  -H 'content-type: application/json' -d '{"retention": 5000}'
```

`0` is a declared cap of zero, not an absent one, and still wins over the
file's value. Clearing a project's own cap by sending `null` makes that project
fall back to the `[limits.retention]` value in the file rather than to zero.

**With nothing configured anywhere, there is no cap at all.** When the server's
file declares no `[limits.retention]` table — or is absent, or does not
parse — and a project declares no `retention` of its own, nothing is evicted.
The server discloses that at boot rather than growing quietly, naming the
uncapped projects:

```
[crucible] WARNING: event retention is UNBOUNDED for 2 project(s) (alpha, beta) — neither a per-project `retention` nor a `[limits.retention]` table in /srv/crucible/crucible.toml resolves a cap, so compile, lifecycle, test events are never evicted and the store grows without limit. Declare `[limits.retention]` in /srv/crucible/crucible.toml to bound every project, or configure `retention` on each project named above.
```

Once that table exists its value is the cap for every project that declares
none, which is what the `retention` row above means by the number applying only
once the table exists.

## Health

```sh
curl -fsSL http://127.0.0.1:3849/api/health
# → {"ok":true,"status":"healthy","version":"…","uptime_s":…,
#    "store":{"path":"…","rule":"…","schemaVersion":13,"migration":null},
#    "counts":{…}}
```

`GET /api/health` and `GET /api/v2/health` return the same payload (version,
uptime, counts of projects/agents/events, and the resolved `store`). Poll it
after start to confirm the server is up.

`store` names the database this process actually opened and **which rule chose
it** — `explicit`, `CRUCIBLE_DB`, `cwd-data`, or `user-data` (CR-CRU-068). The
same line is logged at startup beside the listen banner. Because rule
`cwd-data` is CWD-relative, the same binary opens different stores depending on
where it was launched: check this field first whenever data looks missing, and
compare it across instances before assuming anything was lost.

## Schema versions and migration

The store carries its schema version in `PRAGMA user_version`, and the server
reports it as `store.schemaVersion` on both health routes and at startup:

```
[crucible] store /path/to/crucible.db (rule: cwd-data, schema v13)
[crucible] migrated store schema v0 -> v13 (pre-upgrade backup: /path/to/crucible.db.pre-upgrade-1787213052079)
```

- **Migration is automatic and transactional.** Each step's schema change and
  its version stamp share one transaction, so a store is never left at a version
  whose structure is absent. A store already at the current version migrates
  nothing and reports `migration: null`.
- **A backup is written before the first mutating write**, WAL-safely, as
  `<path>.pre-upgrade-<epoch>` — the same sibling convention as
  `<path>.corrupt-<epoch>`. It holds the pre-migration state; keep it until the
  upgrade looks right, then delete it. `:memory:` stores are exempt.
- **A store from a NEWER Crucible is refused, not quarantined.** The server exits
  non-zero naming both versions and the remedy, and touches nothing — no rename,
  no fresh db, no writes. This is the one deliberate exception to the boot-safety
  rule below: quarantining a readable, newer database would rename your live data
  aside and start empty. Fix it by upgrading Crucible, or by restoring a backup.
- **An UNREADABLE store still quarantines and boots** exactly as before (see
  Corrupt database recovery) — that path is unchanged.
- **A failed migration fails loudly**: the step's transaction rolls back, the
  version stays where it was, the error names the backup, and the server does not
  begin serving on a half-migrated store.
- **An upgrade restarts the service.** When `crucible-axi install` re-provisions
  the server to a new version and a systemd `--user` unit is active, the unit is
  restarted so the running daemon is the new code — never a new binary behind an
  old process. A re-run at the same version restarts nothing, so live SSE
  subscribers are only dropped by a real version change.

## Upgrading

```sh
curl -fsSL https://raw.githubusercontent.com/anthill-tec/crucible/master/install.sh | sh
```

The install one-liner is also the upgrade path (CR-CRU-072). It advances an
existing install and then re-runs the staged install, so the CLI and the
provisioned server move in lockstep; on an already-current machine it reports
`already current` and does no work.

- **`uv tool upgrade crucible-axi` alone is not enough by hand.** It resolves
  within the constraint the tool was installed under, so a tool installed as
  `crucible-axi==X` reports nothing-to-upgrade forever. The installer uses
  `uv tool install --upgrade`, which ignores that pin. Measured against uv
  0.11.8.
- The server half follows because the `server` stage counts as converged only
  when the installed server is exactly the new release's pinned version.
- A systemd `--user` unit is refreshed by the same run, so the daemon is the new
  version rather than a new binary behind an old process.

### Upgrading TO 0.2.1 — re-run the install, do not stop at the package

0.2.1 fixes an install that resolved no operator configuration at all, and part
of that fix is a file the **install** lays down: the distribution's own
declarations at `<install dir>/clients/crucible.toml`, plus the server's
operator-editable file beside its database. Upgrading only the package —
`uv tool upgrade` or `pip install -U crucible-axi` — moves the code and lays
down **neither**, because the `[fleet]` and `[manifest]` stages are what write
them.

So on a machine carrying a 0.2.0 install, run the install one-liner above (or
`crucible-axi install`) after upgrading. Until you do:

- a client still resolves configuration from the operator file at
  `<install dir>/crucible.toml` rather than from the shipped declarations, which
  is the aliasing 0.2.1 removes; and
- if that operator file was ever purged, every client verb fails with
  `RuntimeError: no shipped limit defaults found at …` rather than degrading to
  the recommended values. Re-running the install repairs it.

Nothing is lost by re-running: an operator-EDITED `crucible.toml` survives, and
the stages report `converged` when there is nothing to do.

## Run as a service (systemd `--user`)

`crucible-axi install` provisions `~/.config/systemd/user/crucible-server.service`
on any machine with systemd and a user D-Bus session, then `enable --now`s it.

```sh
systemctl --user status crucible-server
systemctl --user restart crucible-server
systemctl --user stop crucible-server      # clean: Result=success, never failed
journalctl --user -u crucible-server -f
```

Facts worth knowing when it misbehaves:

- **`--user` only.** No root, no `sudo`, nothing under `/etc/systemd/system` —
  the same user scope as `bun add -g`.
- **`ExecStart` is absolute** (the argv `serve` uses), and the unit sets
  `PATH=<resolved bun dir>:/usr/local/bin:/usr/bin:/bin`. That PATH is load
  bearing: the published `crucible-server` bin is a shim that spawns `bun`
  itself, and a unit inherits no shell PATH. Without it the service dies
  `status=127` (`spawn bun ENOENT`) in a `Restart=on-failure` loop.
- **Only the `CRUCIBLE_*` vars that were set at install time are forwarded**, so
  change the port or store by re-running `crucible-axi install` with the new
  values (it rewrites the unit only when the text actually changes).
- **`systemctl --user stop` is a clean stop**, not a failure: the server
  checkpoints active cycles on SIGTERM and exits, and the unit reports
  `Result=success`.
- **Opt out** with `crucible-axi install --no-service` or
  `CRUCIBLE_NO_SERVICE=1`. With no systemd or no user bus the stage reports
  skipped-with-reason and the install still exits 0.
- `crucible-axi uninstall` removes the unit **first**, before de-provisioning the
  server — otherwise systemd would be left restarting a deleted binary.

## Teardown (uninstall)

```sh
crucible-axi uninstall          # program only — store and config survive
uv tool uninstall crucible-axi  # LAST: a running tool cannot remove itself
# or both in one step:
curl -fsSL https://raw.githubusercontent.com/anthill-tec/crucible/master/install.sh | sh -s -- --uninstall
```

A plain uninstall reverses **program artifacts only** — the user-scoped server
package and its `crucible-server` symlink (`bun remove -g`, using the same
absolute Bun the install resolved). Stage order is `server`, `config`, `store`:
destructive last, so a failing step can never leave data gone and the program
installed.

Kept by default, and named with their paths in the envelope:

- the **store** — `$XDG_DATA_HOME/crucible`, else `~/.local/share/crucible`
- the **config** — `<target-dir>/crucible-clients.json` (default `~/.crucible`)
- **Bun** — the install only guarantees it, it does not own it, so it is never
  removed

Add `--purge` to destroy the store and config. Nothing else does: a
non-interactive run always retains (automation cannot silently lose a
database), and an interactive one asks once — naming both paths and the store's
size — and keeps them on empty input, EOF, or Ctrl-C. Absent artifacts converge
with no subprocess, so re-running is indistinguishable from running once.

## Running the install suites without touching this machine

The python suites under `tests/client/` drive the **real** installer: it writes
files, and two of its stages would otherwise run `bun add -g` and
`systemctl --user enable --now`. The suite that exercises the whole install-then-
resolve path is
`tests/client/test_an_installed_deployment_resolves_its_configuration.py`.

They are safe to run directly, and safer still under `bwrap` — the script below
passes `--dev-bind / /`, `--tmpfs "$HOME"`, a read-only re-exposure of bun,
`--tmpfs /run/user/<uid>`, `--unshare-user`, `--unshare-pid` and
`--unshare-net`, so an escaped write lands on memory and nothing reaches a
board, PyPI or npm:

```sh
scripts/sandboxed-install-tests.sh              # the install-touching suites
```

Run directly, each suite pins `$HOME`, `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME` and
`$BUN_INSTALL` into a temporary root, stubs those two stages, and asserts
afterwards that this machine's real `~/.crucible`, `~/.local/share/crucible` and
`~/.config/systemd/user` did not move. That is what CI runs:

```sh
python3 -m unittest discover -s tests/client -t .
```

Those two layers protect you from code that plays by the rules. A hardcoded
path, an `expanduser` evaluated before the environment is patched, or a
subprocess handed a stale environment would escape them — which is what the
kernel-level sandbox above is for. Its other invocations:

```sh
scripts/sandboxed-install-tests.sh              # the install-touching suites
scripts/sandboxed-install-tests.sh -k pattern   # your own narrowing
scripts/sandboxed-install-tests.sh -k ''        # the whole directory
```

**The bare command is narrow on purpose.** `--unshare-net` is part of the
isolation, and several suites under `tests/client/` legitimately reach the
network (`python -m build --wheel` resolves pypi.org; the uv, cargo and docker
gates reach their own registries). Wrapping the whole directory therefore
reports dozens of failures that say nothing about the code, so with no arguments
the script targets the install-touching suites — which is what the sandbox
exists for. `-k ''` widens to everything, and those network-dependent suites
will fail when you do.

The script is the documented command; read it for the exact invocation. Each
part of its isolation carries its own guarantee:

- `--dev-bind / /` keeps the toolchain (`python3`, `uv`) reachable.
- `--tmpfs "$HOME"` shadows your real home, so a write that ignored every
  environment variable lands on memory and evaporates.
- bun lives under `$HOME/.bun`, which that tmpfs hides, so it is re-exposed
  OUTSIDE `$HOME` with `--ro-bind` and `--setenv BUN_INSTALL`: suites resolve
  the binary, and no run can write into your real bun prefix.
- `--bind` on the checkout keeps it writable, because the suites read the repo's
  own files and the runner writes caches.
- `--tmpfs /run/user/<uid>` removes the session bus, so a stray
  `systemctl --user` fails loudly instead of touching your real session.
- `--unshare-user` and `--unshare-pid` drop privileges and stray processes;
  `--unshare-net` means nothing can reach a board, PyPI or npm.
- It sets **no** `CRUCIBLE_*` variables: the suites own their own stubbing, and
  a sandbox that overrode them would make a suite fail for a reason unrelated to
  the code.

It needs `bubblewrap` (`bwrap`) and refuses to run unsandboxed if it is absent,
rather than handing you a false assurance. It is deliberately **not** part of
CI: `bwrap` is not guaranteed on a runner, and a runner's `$HOME` dies with the
container anyway — the value of this script is protecting a real workstation.

## Environment variables, and the connection that is no longer one

The server is **loopback-only by default** — the API is unauthenticated and
`dataPath` ingest reads server-side files, so it binds to `127.0.0.1` unless you
deliberately widen it.

Two environment variables remain, and neither of them configures the
connection. They are the two questions that have to be answered *before* a
configuration file can be found at all, which is exactly why they could not
become lines in one:

| Env var | Default | Meaning |
|---------|---------|---------|
| `CRUCIBLE_DB` | *(see "Database path")* | SQLite database the server opens; overrides both the adopt-an-existing-`./data/crucible.db` rule and the `$XDG_DATA_HOME` / `~/.local/share` default. It is also how the server locates its own `crucible.toml`, which sits beside that database |
| `CRUCIBLE_PROJECT_KEY` | *(the project's `.env`)* | The project a client reports its runs under — identity, read from the same project `.env` the clients already read, before any project directory's file is consulted |

### The listener — `[server]`, in the server's own file

The listener is declared in the `crucible.toml` beside the server's database —
the same file its limits live in, found by the same rule that finds the
database. Copy this table into it:

```toml
[server]
host = "127.0.0.1"
port = 3849
```

Those are the shipped defaults, so a server with no file of its own binds
exactly where it always did. Keep `host` at `127.0.0.1` unless you have a
specific, secured reason to widen it: `0.0.0.0` hands an unauthenticated
file-reading API to the network.

`crucible-axi serve --host <addr> --port <n>` **writes** `host` and `port`
into that `[server]` table and then boots the server, printing the file it
wrote and each value it put there — the setting is typed on the command line
rather than exported, and it is not a per-run twin of anything. The choice
therefore survives the shell, and the next plain `crucible-axi serve` honours
it. An explicit `startServer({ port, hostname })` argument — the in-process
test seam — is the only thing that outranks the file.

```sh
# move the listener: writes host + port into the server's crucible.toml,
# names the file and the values on stdout, then boots
crucible-axi serve --host 127.0.0.1 --port 3850

# and afterwards the declaration is the setting — nothing to re-type
crucible-axi serve
```

### The board — `[client]`, in the project's own file

Where the clients post is the project's own setting, declared in the
`crucible.toml` of the project directory they run in, beside the `.env` they
already read:

```toml
[client]
url = "http://localhost:3849"
```

That is the shipped default too. The value is re-read at the point of use, so
an edit takes effect on the next verb with nothing restarted and nothing
exported — and a verb that resolves a board other than the shipped one names
it as `context.board` in its own envelope, so a run that landed somewhere
unexpected is legible in the output of the command that sent it.

### A development board beside a production one

This is the case the two declarations exist for, and it is a pair of file
edits. In the development server's own `crucible.toml`, beside its own
database:

```toml
[server]
host = "127.0.0.1"
port = 3850
```

…and in the `crucible.toml` of every project whose runs belong on that board:

```toml
[client]
url = "http://127.0.0.1:3850"
```

Nothing else changes: the production install keeps its own file, its own
database and its own port, and no shell has to remember anything. Pick the
second port from the range `[server] port_range_min` / `port_range_max`
declare — the installer probes that same range by binding each candidate, so a
port outside it is one no install would ever have chosen.
