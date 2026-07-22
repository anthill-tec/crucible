# Crucible Server — Runbook

Operating guide for the bun/node Crucible server (`src/server.ts`).

## Start

```sh
# via the published npx-runnable launcher
crucible-server

# or directly from a checkout
bun run src/server.ts
# or
bun run start
```

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

The server persists to a SQLite file at **`data/crucible.db`** (relative to the
working directory) by default. The parent directory is created automatically on
boot (`mkdirSync(..., { recursive: true })`). Use `:memory:` for an ephemeral,
non-persistent store (tests only).

## Corrupt database recovery

Boot must never fail because of a bad db file. On start the server opens the
store defensively (`Store.open`): it opens the db and forces a trivial probe
query (`PRAGMA schema_version`) to surface a corruption error that `bun:sqlite`
might otherwise defer past open.

If that probe throws — a truncated, malformed, or otherwise unreadable SQLite
file — the server does **not** crash. It:

1. renames the bad file aside to **`<path>.corrupt-<epoch>`** (e.g.
   `data/crucible.db.corrupt-1737600000000`, where `<epoch>` is the
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
# → {"ok":true,"status":"healthy","version":"…","uptime_s":…,"counts":{…}}
```

`GET /api/health` and `GET /api/v2/health` return the same payload (version,
uptime, and counts of projects/agents/events). Poll it after start to confirm
the server is up.

## Port / bind configuration

The server is **loopback-only by default** — the API is unauthenticated and
`dataPath` ingest reads server-side files, so it binds to `127.0.0.1` unless you
explicitly opt into wider exposure. Two environment variables control the
listener:

| Env var | Default | Meaning |
|---------|---------|---------|
| `CRUCIBLE_PORT` | `3849` | TCP port the server listens on |
| `CRUCIBLE_HOST` | `127.0.0.1` | Bind address (loopback default) |

```sh
# custom port, still loopback
CRUCIBLE_PORT=4000 crucible-server

# expose beyond loopback (do this only behind a trusted network / proxy —
# the API is unauthenticated)
CRUCIBLE_HOST=0.0.0.0 CRUCIBLE_PORT=3849 crucible-server
```

Keep the default `127.0.0.1` bind unless you have a specific, secured reason to
widen it.
