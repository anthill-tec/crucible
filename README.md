# Crucible

Crucible is the test-reporting and orchestration backbone for the Model-B
workflow. It is two cooperating stacks behind one product:

- a **bun/node server** (`src/server.ts`) that ingests test runs, tracks agents,
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
curl -fsSL https://crucible.dev/install.sh | sh
```

The bootstrap ensures **`uv`** (Astral's single static binary, which brings its
own Python) is present, then installs the primary orchestrator:

```sh
uv tool install crucible-axi
crucible-axi install
```

`crucible-axi install` self-provisions the bun/node server (bootstrapping Bun
via its own curl-installer if absent) and installs the multi-harness skill set,
reporting a TOON-AXI envelope with each stage's installed path. `uvx
crucible-axi …` is the on-demand form.

Once installed, start the server and check health:

```sh
crucible-server                 # loopback default; see docs/RUNBOOK.md
curl -fsSL http://127.0.0.1:3849/api/health
```

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
- `clients/skills/` — the Vercel-Skills-compatible skill set (`crucible-register`,
  `crucible-report-{bun,java,python,rust,vscode,arduino}`, `agent-protocol`).

## Version

`0.1.0` (set on the release branch per the git-flow release ceremony).
