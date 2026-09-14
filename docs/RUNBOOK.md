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
When the board runs on another machine, that file lives on THAT machine — these
three limits cannot be set from a project checkout. The distribution's own
copy, `src/crucible.toml`, is package data replaced wholesale on upgrade and is
**not** the file you edit.

| Limit | Description | Recommended | Min | Max |
|---|---|---|---|---|
| `run_abandon_ms` | Milliseconds an OPEN run may live before the sweep settles it as `abandoned`. Raise it when a legitimate suite runs longer than the deadline; lower it to clear ghost runs off the board sooner. | `1800000` (30 minutes) | `60000` (1 minute) | `86400000` (24 hours) |
| `project_inactive_ms` | Milliseconds of silence after which a project with no live agent reads INACTIVE on the board's project list. Raise it to keep occasional projects visible; lower it to retire finished ones from the default view sooner. | `3600000` (1 hour) | `300000` (5 minutes) | `2592000000` (30 days) |
| `retention` | Events kept per project for projects that declare no `retention` of their own. NOTE the documented exception: with NO crucible.toml at all there is NO cap and the boot banner names the uncapped projects — this number applies only once the table exists. | `5000` | `10` | `1000000` |

### The project's limits — in the project directory

A client reads the `crucible.toml` in the **project directory** it is working
in, beside the `.env` the clients already read, and it reads it on every call.
These three bound what a client PRINTS, so they belong to the machine reading
the output. On a fleet whose board is on a different machine, widening a
display width over there changes nothing — edit the file in your own project
directory. The distribution's own copy, `clients/crucible.toml`, is package
data; the installer also lays an operator-editable copy down at the target
directory.

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

`CRUCIBLE_DB`, `CRUCIBLE_PORT` and `CRUCIBLE_PROJECT_KEY` are untouched and
still read — they answer *where am I* and *who am I*, and must work before any
configuration file can be found. See "Environment variables" below.

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
#    "store":{"path":"…","rule":"…","schemaVersion":5,"migration":null},
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
[crucible] store /path/to/crucible.db (rule: cwd-data, schema v5)
[crucible] migrated store schema v0 -> v5 (pre-upgrade backup: /path/to/crucible.db.pre-upgrade-1787213052079)
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

## Environment variables (port / bind / database)

The server is **loopback-only by default** — the API is unauthenticated and
`dataPath` ingest reads server-side files, so it binds to `127.0.0.1` unless you
explicitly opt into wider exposure. Three environment variables configure the listener and
the store:

| Env var | Default | Meaning |
|---------|---------|---------|
| `CRUCIBLE_PORT` | `3849` | TCP port the server listens on |
| `CRUCIBLE_HOST` | `127.0.0.1` | Bind address (loopback default) |
| `CRUCIBLE_DB` | *(see "Database path")* | SQLite database file to open; overrides both the adopt-an-existing-`./data/crucible.db` rule and the `$XDG_DATA_HOME` / `~/.local/share` default |

```sh
# custom port, still loopback
CRUCIBLE_PORT=4000 crucible-axi serve

# expose beyond loopback (do this only behind a trusted network / proxy —
# the API is unauthenticated)
CRUCIBLE_HOST=0.0.0.0 CRUCIBLE_PORT=3849 crucible-axi serve

# the same two knobs as per-run flags
crucible-axi serve --host 127.0.0.1 --port 4000
```

Keep the default `127.0.0.1` bind unless you have a specific, secured reason to
widen it.
