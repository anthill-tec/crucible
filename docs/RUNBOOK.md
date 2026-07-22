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
