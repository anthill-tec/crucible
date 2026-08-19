# Crucible

Crucible is the test-reporting and orchestration backbone for the Model-B
workflow. It is two cooperating stacks behind one product:

- a **Bun server** (`src/server.ts`) that ingests test runs, tracks agents,
  cycles and events, and streams live changes over SSE; and
- a **Python client fleet** (`crucible-axi` — `_crucible_axi.py` plus the
  per-stack `{bun,python,rust,mvn,arduino}-crucible.py` scripts) that runs a
  stack's tests AND ingests the results to the server under an agent id.

RED/GREEN/VERIFY agents report every run through the stack client; the server
gives orchestrators a live picture of the fleet, the cycle plan, and coverage.

## Quick start

One-line, distro-agnostic bootstrap — the only prerequisites are `curl` + `sh`
(no `apt`/`dnf`/`pacman`, no pre-existing system Python or Node):

```sh
curl -fsSL https://raw.githubusercontent.com/anthill-tec/crucible/master/install.sh | sh
```

The bootstrap ensures **`uv`** (Astral's single static binary, which brings its
own Python) is present, then installs the primary orchestrator and provisions
the server:

```sh
uv tool install crucible-axi
crucible-axi install
```

`crucible-axi install` provisions and then **exits** — it never starts anything.
It guarantees **Bun** (the server's runtime: detected on `PATH`, otherwise
bootstrapped from <https://bun.sh>, re-resolved under `$BUN_INSTALL/bin` and
verified by running `bun --version`; if Bun still cannot be resolved the install
fails outright with that remedy), provisions the server user-scoped via
`bun add -g @anthill-tec/crucible-server@<pinned>` — Bun's global prefix lives
under `$HOME`, so there is no system-permission problem — then creates its
target directory (`--target-dir`, default `~/.crucible`) and writes the client
discovery **manifest** into it. Those two stages, `server` and `manifest`, are
the whole install. It reports a TOON-AXI envelope naming each stage's installed
path plus the absolute Bun it resolved. A second run at the same version is a
no-op; re-running after an upgrade re-provisions the server, because the
`server` stage counts as converged only when the installed server is exactly
the pinned version. `--force` re-runs every stage regardless.
`uvx crucible-axi …` is the on-demand form.

Rather not pipe a remote script into a shell? Install Bun yourself first and
pass `--no-bun-bootstrap` (or set `CRUCIBLE_NO_BUN_BOOTSTRAP=1`): an absent Bun
then fails immediately with the remedy instead of fetching an installer.

Running the server is a separate, explicit step. Start it in the foreground and
check its health:

```sh
crucible-axi serve              # loopback default; see docs/RUNBOOK.md
curl -fsSL http://127.0.0.1:3849/api/health
```

`crucible-axi serve` execs the provisioned server by absolute path, honours
`CRUCIBLE_HOST` / `CRUCIBLE_PORT` (overridable per run with `--host` /
`--port`), and passes the server's exit code straight through so a shell — or a
process supervisor — sees the real failure.

## Development

Working on the Python client? Install the dev extras into your `.venv` so the
Python coverage gate (`python-crucible.py regression --coverage`) has
`coverage.py` available:

```sh
pip install -e '.[dev]'
```

## Documentation

- [docs/RUNBOOK.md](docs/RUNBOOK.md) — operating the server (start/stop, db
  path, health, port/bind config).
- `clients/` — the per-stack reporting clients
  (`{bun,python,rust,mvn,arduino}-crucible.py`) plus the shared TOON-AXI
  envelope module every one of them emits through.
- `clients/STATUS-CONTRACT.md` — the status/dashboard payload contract the
  orchestrators read.

## Version

`0.1.2` (set on the release branch per the git-flow release ceremony).
