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

Boot must never fail because of a bad db file. On start the server opens the
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

## Retention

Raw events are capped **per project** to bound db growth. The default cap is
**`DEFAULT_RETENTION = 100`** events per project. Override it per project by
setting the project's **`retention`** value (the `projects.retention` column);
when set, it replaces the default for that project (`retention ?? 100`).

Enforcement runs on ingest: when a project's raw-event count exceeds its cap,
the **oldest** events (ordered by timestamp, then insertion order) are pruned
down to the cap. Pruning is transactional so a crash can never leave an event
both folded and re-foldable:

- **`test`** and **`compile`** events are folded into their daily test-run
  rollup *before* deletion, so their aggregate contribution survives pruning.
- all other kinds (`lifecycle`, `gate`, `milestone`, …) flow through retention
  but contribute nothing to rollups — they are simply pruned.

Rollups and any active-cycle state are unaffected by retention pruning; only raw
per-project events are capped.

## Health

```sh
curl -fsSL http://127.0.0.1:3849/api/health
# → {"ok":true,"status":"healthy","version":"…","uptime_s":…,
#    "store":{"path":"…","rule":"…"},"counts":{…}}
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
