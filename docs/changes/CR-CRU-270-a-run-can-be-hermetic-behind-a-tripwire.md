# CR-CRU-270 — a run can be hermetic, behind a tripwire

**Status:** PENDING · filed 2026-11-21 (user ruling 2026-11-15: the leak-census tripwire becomes a standing guard —
Crucible's own CI got it in 0.4.0, CR-CRU-263, and a 0.5.0 CR offers it to every project as a client feature; promised
to Model B for 0.5.0 in Sandesh #1621) · revised 2026-11-26 after gap analysis and user rulings Q1–Q4.
**Type:** feature
**Points:** 8
**Wave:** 9 (0.5.0)
**Depends on:** CR-CRU-267, CR-CRU-268, CR-CRU-269, CR-CRU-274
**Labels:** client, server, isolation, tiers
**Design reference:** CR-CRU-263 (`scripts/hermetic/run.sh`, `tripwire.py`); CR-CRU-274 (gate `[unit-check]` stage and
Ruling Q4); `src/v2.ts:fileRunnerExit` (server-side synthetic failing suite); `clients/_crucible_lint.py` (declared
`crucible.toml` table validation and gate stage).

## Problem

A project's tests can depend on the operator's machine without anyone noticing: the running board, `~/.m2`,
`~/.crucible`, `XDG_*`, operator `.env` variables in the shell, a toolchain cache, Docker, or the network. The tests
pass at the desk and fail elsewhere, or quietly write to a live service.

In 0.4.0 Crucible found and removed these leaks from its own suites and put its CI behind a Linux network namespace and
board-port tripwire (`scripts/hermetic/run.sh` + `tripwire.py`, CR-CRU-263). No other project can do the same: the
machinery is a repo-local shell script, not a client feature, and a tripwire hit never reaches the board as a leak
record on the run.

## Behaviour

### S1 — `--hermetic` across every client's run verbs and `pre-merge-gate`

Every stack client (`python`, `bun`, `rust`, `mvn`, `arduino`, `go`) accepts `--hermetic` on:

- all six tier verbs (`unit`, `module`, `integration`, `e2e`, `regression`, `bdd`), via the shared `add_tier_verbs`
  registrar;
- `test`;
- `pre-merge-gate`.

(Ingest-only or explicit-Docker verbs outside that set — `rust-crucible.py` `regression-ingest` and `docker-e2e-gate` —
are unchanged. On Maven, `--with-docker` together with `--hermetic` is contradictory and refused before starting Docker
or any runner.)

**Isolation model (Ruling Q1 — in-place, matching CI):**

The **client** stays outside the namespace so it can talk to the live Crucible board (`runs/start`, live stream relay,
`runs/ingest`). Only the **test runner** (and the tripwire) executes inside the isolated environment, in the project's
working tree:

- a new unprivileged Linux user + network namespace (`unshare --map-current-user --keep-caps -n`), with only `lo` up
  (no external route) and every Linux capability dropped (`setpriv --ambient-caps -all --inh-caps -all --bounding-set
  -all --no-new-privs`);
- `HOME` pointed at a fresh empty directory inside the run's scratch directory;
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` unset;
- operator registry variables unset (`CRUCIBLE_PROJECT_KEY`, `CRUCIBLE_PROJECT_NAME`, `WORKFLOW_ORCHESTRATOR`,
  `SANDESH_PROJECT`, `SANDESH_ADDRESS`, `PROJECT_TOKEN`, `PROJECT_STACKS`, `KNOWLEDGE_CATEGORY`);
- `DOCKER_HOST=unix:///nonexistent`;
- the toolchain variables set to `scripts/hermetic/run.sh`'s defaults whenever they are unset, before `HOME` is
  redirected (Ruling SF-2). The client path and the standalone CLI share one helper for this:
  - `PLAYWRIGHT_BROWSERS_PATH`, `RUSTUP_HOME`, `CARGO_HOME` and `ARDUINO_DIRECTORIES_DATA` point at the original
    home's stores;
  - `GOROOT` comes from `go env` when `go` is on `PATH`;
  - `GOPATH`, `GOMODCACHE` and `GOCACHE` sit under the working tree's `.cache/test-suite`.

  A value already set is kept. Any extra variable names declared in `[hermetic] allow_env` in `crucible.toml` are
  passed through.

**Gate behaviour (`pre-merge-gate --hermetic`, CR-CRU-274 Ruling Q4):**

- `check` and `[lint]` run outside the namespace (static analysis).
- `[unit-check]` runs **inside** the namespace + tripwire. A tripwire hit during `[unit-check]` aborts the gate at
  `stage: unit-check` with `ok: false`, carrying the hits in the gate's envelope and warning `unit-check-gate-abort`,
  and no regression suite runs.
- Each dispatched test suite — the owning client's own suites and any sibling stack client invoked via
  `sibling_client_argv` — receives `--hermetic`, so each child client stays outside the namespace (reachable to the
  board) and runs its own runner inside its own namespace + tripwire, filing its own per-run leak records.

### S2 — Tripwires and `[hermetic]` configuration

Inside the namespace, `_crucible_tripwire.py` listens before the runner starts, prints its listening banner once every
endpoint is bound, answers every incoming TCP connection with `HTTP/1.1 503 Service Unavailable`, logs the hit, and
drains all in-flight handlers on `SIGTERM` before the verdict is read.

**Default tripwire ports (Ruling Q3 — union):**

For a client run, the default tripwire endpoints are the deduplicated union of:

1. the port of the project's resolved `[client] url` (e.g. `3850` on a dev board);
2. the port of the install's `[client] url`, when present;
3. the shipped default board port declared in package data (`clients/crucible.toml`, `[hermetic] default_board_port =
   3849`);
4. any extra endpoints declared in the project's `crucible.toml` under `[hermetic] tripwires`.

Bare integer ports bind both `127.0.0.1:<port>` and `[::1]:<port>` inside the namespace. Explicit `"host:port"` (or
`"[ipv6]:port"`) strings bind that socket.

**Optional `[hermetic]` table in `crucible.toml`:**

```toml
[hermetic]
tripwires = [5432, "127.0.0.1:6379"]   # optional list of ints (1..65535) or "host:port" strings
allow_env = ["MY_TOOLCHAIN_CACHE"]     # optional list of non-empty env-var names to pass through
```

- Read from the project's `crucible.toml` (falling back to the install's, same precedence walk as `[lint]`), validated
  before anything runs.
- A malformed `[hermetic]` table (`tripwires` not a list of valid ports/`host:port`, `allow_env` not a list of
  non-empty strings, or `default_board_port` outside `1..65535`) is refused before any runner or namespace starts,
  naming the file and field.

### S3 — Tripwire hits reach the board as leak records and turn the run red

**Hit capture and test attribution:**

- On `accept()`, `_crucible_tripwire.py` records: `endpoint` (e.g. `"127.0.0.1:3849"`), `port` (int), `peer`, `pid`,
  `cwd`, `cmd`, `request` (first HTTP line, if any), and `test` (optional).
- Test attribution: the tripwire inspects `/proc/<pid>/environ` for `CRUCIBLE_CURRENT_TEST` and `PYTEST_CURRENT_TEST`
  (stripping pytest's `" (call)"` / `" (setup)"` suffix when present). `clients/subtest_runner.py` sets
  `CRUCIBLE_CURRENT_TEST` in `startTest` and clears it in `stopTest`, and writes the current test's id to a
  current-test file that the tripwire reads as a fallback. `/proc/<pid>/environ` shows only a process's environment
  at exec, so a variable a runner sets in-process is not visible there. This gives exact test attribution for Python
  `unittest` runs through the fleet's runner (Ruling SF-3). A pytest run is not named by test: pytest sets
  `PYTEST_CURRENT_TEST` in-process, so the tripwire cannot read it. The python client drives unittest only, so pytest
  is already a known client gap. Runners that expose neither leave `test` absent and fall back to `cmd` + `pid`.

**Wire and board storage (Ruling Q2 — server `leaks[]` + failing `tripwire` suite):**

- On `POST /api/v2/runs`, the client sends `leaks: LeakRecord[]` whenever the hermetic run recorded one or more hits
  (omitted when zero hits). Each `LeakRecord` has `{ endpoint: string, port: number, test?: string, pid?: string,
  cmd?: string, request?: string }`.
- Server validation (`src/v2.ts`): a malformed `leaks` field (not an array, or an item missing a non-empty string
  `endpoint` or positive integer `port`) is refused with HTTP 400 before anything is stored.
- In `handleRuns` → `fileRun` (`src/v2.ts`), applied uniformly to both non-streamed AND streamed runs right beside
  `fileRunnerExit`:
  1. The validated `leaks` array is stored on the event payload (`events.payload.leaks` — no SQLite schema migration).
  2. When `leaks.length > 0`, `fileTripwireLeaks` appends a failing suite named `"tripwire"` to `run.tree`, with one
     failing case per hit (named `<endpoint>` or `<endpoint> — <test>` when `test` is present, with a failure message
     naming the endpoint, test or command, and request line), and increments `summary.total` and `summary.failed` by
     `leaks.length`.
  3. Because `summary.failed > 0`, the run's verdict is red, coverage is discarded, `hints.afterRed` fires, the
     existing Runs UI shows every hit in the run tree without a bespoke UI panel, and the client's TOON envelope
     carries `leaks` and exits non-zero.
  4. When a run produces no test report AND has tripwire hits (for instance a runner crashed on the tripwire's 503),
     the hits are still filed so the leak is never lost.

### S4 — Platform and privilege check (Linux-only, explicit refusal)

Before starting any runner or opening a run on the board, the hermetic preflight checks:

1. `sys.platform == "linux"`;
2. `unshare`, `setpriv`, and `ip` are on `PATH`;
3. `unshare --map-current-user --keep-caps -n true` succeeds.

If any check fails, the client refuses immediately with an `ok: false` TOON envelope (`error` naming the exact cause —
non-Linux platform, missing tool, or kernel/AppArmor refusal with `kernel.apparmor_restrict_unprivileged_userns=0` hint
when relevant — and actionable `help[]`), exits non-zero, spawns no test runner, and opens/files nothing on the board.
`--hermetic` is never silently ignored.

### S5 — Shared engine shipped in `crucible-axi`; retire `scripts/hermetic/run.sh` and `tripwire.py` (Ruling Q4)

- The hermetic engine (`clients/_crucible_hermetic.py`) and tripwire (`clients/_crucible_tripwire.py`) live once in
  `clients/`, stdlib-only, registered in `crucible_axi/install.py:FLEET_FILES`, loaded by `clients/_crucible_axi.py`,
  and packaged into the `crucible-axi` wheel.
- `_crucible_hermetic.py` also exposes a standalone board-free CLI entry (`python3 clients/_crucible_hermetic.py
  --log-dir <dir> [--port <p> ...] -- <cmd...>`) preserving the exit-code contract (`90–95` setup failure, `99`
  tripwire hit, else the command's own exit code) and writing `tripwire.log`.
- `scripts/hermetic/run.sh` and `scripts/hermetic/tripwire.py` are deleted.
- `.github/workflows/release.yml` moves all five `scripts/hermetic/run.sh` calls (`test-bun` unit, integration,
  deliberate trip; `test-python` unit, integration) onto `clients/_crucible_hermetic.py`, keeping CI completely
  board-free (preserving CR-CRU-259's no-board refusal).
- `scripts/hermetic/unit-check.sh`, `unit-verdict.py`, `tagging_runner.py`, and `scripts/hermetic/hooks/` stay where
  they are (used by CR-CRU-274's `[unit-check]` stage and CI's unit steps).

## Acceptance criteria

- **AC1 — Leak detection end to end.** A scratch project whose Python test connects to the default operator port
  (`3849`), run through `python-crucible.py unit --hermetic` against a test-only `RealBoard`, files a **red** run on
  the board whose stored event carries `leaks` naming port `3849` and the offending test name (`test`), and whose run
  tree includes the failing `tripwire` suite. The client exits non-zero and leaves the real operator board untouched.
  The same end-to-end leak detection is also proven for a streamed Bun run (`bun-crucible.py unit --hermetic`) against
  a test-only `RealBoard` (reporting the port and `cmd`).
- **AC2 — Clean hermetic run.** The same scratch project's clean tests, run with `--hermetic` against a test-only
  `RealBoard`, file **green** with no `leaks`, empty `HOME` inside the runner, `XDG_*` and operator registry variables
  unset, `DOCKER_HOST=unix:///nonexistent`, and no external network route, leaving the operator's `HOME`, caches, and
  board untouched.
- **AC3 — Explicit refusal when unavailable.** On a non-Linux platform, when `unshare`/`setpriv`/`ip` is missing, or
  when the kernel refuses an unprivileged network namespace, `--hermetic` is refused with an `ok: false` envelope
  naming the exact cause and fix; nothing runs and nothing is opened or filed on the board.
- **AC4 — Uniform switch across all six clients and the gate.** All six clients (`python`, `bun`, `rust`, `mvn`,
  `arduino`, `go`) accept `--hermetic` on all six tier verbs, `test`, and `pre-merge-gate`, with the same name and
  help contract. On Maven, `--with-docker --hermetic` is refused before starting Docker. Under
  `pre-merge-gate --hermetic`, `[unit-check]` runs inside the namespace (a tripwire hit aborts at `stage: unit-check`
  before regression), `check` and `[lint]` run outside, and sibling suites dispatched via `sibling_client_argv` receive
  `--hermetic`.
- **AC5 — Default tripwire ports and `[hermetic]` config.** Default tripwire ports equal the deduplicated union of the
  project's resolved `[client] url` port, the install's `[client] url` port (if any), the shipped `default_board_port`
  (`3849`), and `[hermetic] tripwires`. `[hermetic] allow_env` passes declared env vars through. Malformed `[hermetic]`
  declarations are refused naming the file and field before anything runs.
- **AC6 — Server `leaks` contract (non-streamed and streamed).** `POST /api/v2/runs` validates `leaks`, rejects
  malformed payloads with HTTP 400 (storing nothing), stores `events.payload.leaks`, appends the failing `tripwire`
  suite with updated `summary.total` and `summary.failed` for both JUnit and streamed runs, discards coverage on a
  leak-red run, and surfaces `leaks` on `GET /api/v2/events/:id` (run detail).
- **AC7 — Packaging and fleet census.** `_crucible_hermetic.py` and `_crucible_tripwire.py` are in
  `crucible_axi/install.py:FLEET_FILES`, loaded by `_crucible_axi.py`, shipped in the `crucible-axi` wheel, and copied
  by a sandboxed install. All fleet-census tests pass.
- **AC8 — Shared CLI replaces `scripts/hermetic/run.sh` and `tripwire.py`.** `scripts/hermetic/run.sh` and
  `scripts/hermetic/tripwire.py` are deleted; `clients/_crucible_hermetic.py` standalone CLI exits `99` on a deliberate
  trip with `HIT ... port=3849` in its `tripwire.log`, and `0` on a clean command. `.github/workflows/release.yml`
  invokes `clients/_crucible_hermetic.py` in all five places (reviewed, not tested; proven by the first green CI run
  after merge).
- **AC9 — Documentation (reviewed, not tested).** `docs/RUNBOOK.md`, `scripts/hermetic/README.md`, `clients/crucible.toml`,
  and `CHANGELOG.md`'s `## [Unreleased]` document `--hermetic`, `[hermetic]`, the default tripwire ports, leak records,
  and the Linux-only platform limit.

## Test plan

| Surface | Tier | Coverage |
| --- | --- | --- |
| Server `fileTripwireLeaks`, `leaks` validation, streamed & non-streamed `POST /api/v2/runs` + `GET /api/v2/events/:id` (via `createBoard`, in-process) | bun unit | AC6 |
| Client hermetic unit tests: `[hermetic]` parsing & refusal, default port union resolution, env scrubbing & `allow_env`, preflight refusals (non-Linux, missing tool, kernel failure), CLI flag presence on all 6 clients + Maven `--with-docker --hermetic` refusal, `sibling_client_argv` propagation | python unit | AC3, AC4, AC5 |
| Real Linux namespace + tripwire integration: standalone `_crucible_hermetic.py` clean & deliberate trip (`exit 99`), Python `unittest --hermetic` leak (with exact test name) + clean run against `RealBoard`, Bun `unit --hermetic` leak + clean run against `RealBoard`, `pre-merge-gate --hermetic` `[unit-check]` tripwire abort | python integration | AC1, AC2, AC4, AC8 |
| Fleet shipping & install census (`FLEET_FILES`, wheel contents, sandboxed install) | python unit & integration | AC7 |
| `.github/workflows/release.yml`, `docs/RUNBOOK.md`, `scripts/hermetic/README.md`, `CHANGELOG.md` | reviewed, not tested | AC8, AC9 |

## Non-goals

- macOS and Windows isolation.
- Clean git-archive copies of `HEAD` or automatic dependency provisioning inside the namespace (Ruling Q1).
- A bespoke leak panel or filter in `public/app.js` — the existing Runs view renders the failing `tripwire` suite
  (Ruling Q2).
- Retiring `scripts/hermetic/unit-check.sh`, `unit-verdict.py`, `tagging_runner.py`, or `scripts/hermetic/hooks/`
  (needed by CR-CRU-274; Ruling Q4).
- Model B's workflow templates calling `--hermetic`. Crucible sends Model B a Sandesh request for `workflows-src/` once
  this spec is locked (#1621).

## Rulings (2026-11-26)

From the gap analysis and the user's answers:

- **Q1 (S1 — workspace isolation):** In-place in the working tree with isolated `HOME`, `XDG_*` and operator env vars
  unset, `DOCKER_HOST=unix:///nonexistent`, unprivileged user+network namespace (`lo` only, all caps dropped), and
  tripwire — matching how CI runs today.
- **Q2 (S3 — leak records):** Client sends `leaks[]` on `POST /api/v2/runs`; server stores `events.payload.leaks` (no
  DB migration) and appends a failing `tripwire` suite (`fileTripwireLeaks`, same pattern as `fileRunnerExit`), turning
  the run red, discarding coverage, and showing hits in the existing Runs UI. Stays 8 points.
- **Q3 (S2 — default tripwire ports):** Deduplicated union of project resolved `[client] url` port + install `[client]
  url` port + shipped `default_board_port` (`3849`) + `[hermetic] tripwires`.
- **Q4 (S5 — retiring `scripts/hermetic/` & CI):** One shared stdlib engine in `clients/` (`_crucible_hermetic.py` +
  `_crucible_tripwire.py`) used by both `--hermetic` on every client and directly by CI (`release.yml`) without a
  board; delete `scripts/hermetic/run.sh` and `tripwire.py`; keep `scripts/hermetic/unit-check.sh` and its hooks.

### Rulings after VERIFY (2026-11-27, cycle 1033)

- **SF-2 (S1 — toolchain defaults):** a client `--hermetic` run applies the same toolchain defaults as the standalone
  CLI (`run.sh`'s), through one shared helper. Without them a stock install's rust, go, arduino and bun-e2e runs
  could not find their toolchains once `HOME` was redirected.
- **SF-3 (S3 — pytest attribution):** the spec is corrected rather than extended. Exact test names cover unittest
  runs through the fleet's runner; a pytest hit falls back to `cmd` + `pid`.
