# scripts/hermetic

This directory holds the unit-tier recording and verdict tools. The hermetic wrapper and its
tripwire are no longer here.

## Where the wrapper went

`run.sh` and `tripwire.py` were retired. The same wrapper now ships with every Crucible client
install as `clients/_crucible_hermetic.py` and `clients/_crucible_tripwire.py`. It runs a command
hermetically: in an isolated network namespace with no route, every capability dropped, an empty
`HOME`, and a tripwire listening on the board ports. A client run does the same thing through
`--hermetic` (see `docs/RUNBOOK.md`). Run the wrapper from the repository root. No step inside it
may need the network. Do installs, cache provisioning and browser installs before you call it.

What stays here: `unit-check.sh`, `unit-verdict.py`, `tagging_runner.py` and `hooks/`. These are
used by the pre-merge gate's `[unit-check]` stage and by CI's unit steps.

## `python3 clients/_crucible_hermetic.py --log-dir <dir> [--port <p>…] [--endpoint <h:p>…] [--allow-env <VAR>…] -- <command…>`

The options:

- `--port <p>` guards `127.0.0.1:<p>` and `[::1]:<p>`.
- `--endpoint` guards one socket, given as `127.0.0.1:6379` or `[::1]:6380`.
- With neither option, the wrapper guards the ports a client run would guard: the board port in the
  `crucible.toml` `[client] url`, the shipped `default_board_port` 3849, and any `[hermetic] tripwires`.
- `--allow-env` passes one more variable through.

CI guards both board ports: `--port 3849 --port 3850`.

1. It checks that it runs on Linux and that `unshare`, `setpriv` and `ip` are on `PATH`. It builds
   the environment (below) and re-executes itself inside `unshare --map-current-user --keep-caps -n`.
2. Inside the namespace it brings `lo` up. It then re-executes itself under
   `setpriv --ambient-caps -all --inh-caps -all --bounding-set -all --no-new-privs`.
3. It prints the preamble that the command's own process sees: `ip -o addr`, `ip route`,
   `ip -6 route`, `id`, the `CapEff` and `CapBnd` lines of `/proc/self/status`, then `HOME` and
   `DOCKER_HOST`.
4. It starts `_crucible_tripwire.py`, with `PYTHONPATH`, `HERMETIC_EVENTS` and `HERMETIC_TEST`
   removed and `python3 -I`. The tripwire's output goes to `<log-dir>/tripwire.log`, and its hits
   also go to `<log-dir>/leaks.json`. The wrapper waits up to 10 s for the banner and requires it to
   name every guarded socket.
5. It runs the command and forwards SIGTERM and SIGINT to it. Then it checks that the tripwire is
   still alive, stops it with SIGTERM (the tripwire drains any in-flight handler) and gives the
   verdict.

### Environment

| Variable | Value |
|---|---|
| `HOME` | `<log-dir>/home`, recreated empty on every run |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | unset, so they fall under the empty `HOME` |
| `CRUCIBLE_PROJECT_KEY`, `CRUCIBLE_PROJECT_NAME`, `WORKFLOW_ORCHESTRATOR`, `SANDESH_PROJECT`, `SANDESH_ADDRESS`, `PROJECT_TOKEN`, `PROJECT_STACKS`, `KNOWLEDGE_CATEGORY` | unset: the operator's registry variables, the set the suites drop |
| `PLAYWRIGHT_BROWSERS_PATH` | kept if set, else `<original HOME>/.cache/ms-playwright` |
| `RUSTUP_HOME` | kept if set, else `<original HOME>/.rustup` |
| `CARGO_HOME` | kept if set, else `<original HOME>/.cargo` |
| `ARDUINO_DIRECTORIES_DATA` (arduino-cli's data directory) | kept if set, else `<original HOME>/.arduino15` |
| `GOROOT` | kept if set, else `go env GOROOT` when `go` is on `PATH` |
| `GOPATH`, `GOMODCACHE`, `GOCACHE` | the suite's caches: `.cache/test-suite/go`, `go-mod`, `go-build` |
| `DOCKER_HOST` | `unix:///nonexistent` |

The suite's own `.cache/test-suite/` lives in the repository, so the `HOME` redirection leaves it in
place. Every other variable is inherited unchanged.

A client's `--hermetic` run scrubs the same variables, but it only KEEPS a toolchain variable that is
already set. It also passes through the names in the project's `[hermetic] allow_env`.

### Exit codes

| Code | Meaning |
|---|---|
| the command's own | no tripwire hit and the setup held |
| 90 | usage: bad arguments, or the log dir cannot be created |
| 91 | setup: not Linux, or a required command (`unshare`, `setpriv`, `ip`, or `go env`) is missing |
| 92 | setup: the kernel refused the unprivileged user and network namespace |
| 93 | setup: `lo` could not be brought up, or `setpriv` could not drop the capabilities |
| 94 | setup: the tripwire's banner was not seen, or did not name every guarded socket |
| 95 | setup: the tripwire died during the run, or did not drain cleanly |
| 99 | HIT: something connected to a board port; the tripwire log is printed |

Codes 90–95 report a broken setup. They are never a verdict on the command.

The command's own status passes through unchanged, so a command that itself exits 90–95 or 99
reads as one of the codes above. The wrapper does not remap it; its log tells the two apart. A
status that is the command's own follows `hermetic: VERDICT clean — no tripwire hit; the command's
status is <status>`, a setup failure prints `hermetic: SETUP FAILURE (exit <code>)` (a usage error
prints `usage:`), and a hit prints `hermetic: VERDICT HIT`. `bun test` and unittest exit 0 or 1;
wrap a command that can exit 90 or above only where its log, not its code, is read.

## `clients/_crucible_tripwire.py`

The wrapper starts it inside the namespace only, as `python3 -I _crucible_tripwire.py --endpoint
<h:p>… [--leaks-json <file>] [--current-test-file <file>]`. It prints `tripwire listening <sockets>`
once every requested socket is bound. Each connection is logged at `accept()`:

    HIT <time> port=<port> peer=<addr> pid=<pid> cwd=<cwd> cmd=<cmdline> [test=<test id>]
        | <first request line>

It finds the peer process through `/proc`; `?` means it found none. It finds the running test in the
peer's `CRUCIBLE_CURRENT_TEST` or `PYTEST_CURRENT_TEST`. Failing those, it reads the current-test
file that `clients/subtest_runner.py` writes. Each connection is answered `503` and closed. On
SIGTERM the tripwire stops accepting, waits for every in-flight handler, writes the leak records
and exits 0. It exits 1 if a socket cannot bind, and 3 if a listening socket fails during the run.

## `hooks/sitecustomize.py`, `hooks/bun-preload.ts`, `tagging_runner.py` (unit-tier recording)

The hooks record each dependency a test takes and never fail a call. They append to
`$HERMETIC_EVENTS`, which must be an absolute path. Each event is one line:
`<charge>\t<event>\t<detail>\t<where>`.

- `hooks/sitecustomize.py` is loaded through `PYTHONPATH=scripts/hermetic/hooks`. It records
  `spawn`, `connect`, `bind`, and `wait`. A `wait` is a sleep above 0, or a timed condition wait,
  join, queue get, select or asyncio sleep. With `$HERMETIC_WATCH` set, it also records
  `open-watched`. It creates the log when it loads.
- `hooks/bun-preload.ts` is loaded with `bun test --preload ./scripts/hermetic/hooks/bun-preload.ts`.
  It records `spawn`, `serve`, `connect` (including WebSocket), `fetch`, and `wait`: any timer or
  sleep above 0 ms, and any interval. Each event is charged to the test file on the stack, and the
  preload records the top frame outside itself, `node_modules` and Bun's own internal frames (a
  `node:`, `bun:` or `internal:` module, or native code). Its first line is
  `-\tpreload\tloaded`. That line proves the preload ran and is not counted as a dependency.
- `tagging_runner.py <start-dir>` discovers `<start-dir>` with `-t .`. It sets
  `HERMETIC_TEST=<file>::<test id>` for each test, which every child process inherits. Its exit code
  is unittest's.

## `unit-verdict.py <event-log>…`

Any `spawn`, `connect`, `bind`, `serve`, `fetch` or `wait` event fails the verdict. Each event is
printed under its test file. An uncharged event is printed with its recorded frame. The preload's
own line is excluded.

| Exit | Meaning |
|---|---|
| 0 | no dependency event |
| 1 | at least one dependency event |
| 2 | a log is missing or unreadable, because the hooks did not run |

## `unit-check.sh [bun|python]...` (the unit tiers, recorded and judged)

It runs each named unit tier with its hooks recording, then `unit-verdict.py` over every log it wrote.
With no argument it runs both, bun then python. It runs from the repository root whatever the caller's
directory, and keeps its logs in a fresh `mktemp -d` that it removes on exit.

- **bun:** `HERMETIC_EVENTS=<dir>/bun-unit.tsv bun test --timeout 30000 --preload
  ./scripts/hermetic/hooks/bun-preload.ts ./tests/unit`
- **python:** `PYTHONPATH=<repo>/scripts/hermetic/hooks HERMETIC_EVENTS=<dir>/py-unit.tsv
  .venv/bin/python scripts/hermetic/tagging_runner.py tests/client/unit`

Every named tier runs even when an earlier one failed, so one run reports everything. It exits 1 when
any tier failed or the verdict failed, 2 on an unknown tier name, and 0 otherwise.

CI's `test-bun` and `test-python` jobs run it inside the wrapper, one tier each:
`python3 clients/_crucible_hermetic.py --log-dir "$RUNNER_TEMP/hermetic/bun-unit" --port 3849
--port 3850 -- scripts/hermetic/unit-check.sh bun`.
Crucible's own `crucible.toml` declares it as the pre-merge gate's unit-check stage
(`[unit-check]` / `command = ["scripts/hermetic/unit-check.sh"]`, see `docs/RUNBOOK.md`).

## Example (a unit tier)

    python3 clients/_crucible_hermetic.py --log-dir "$PWD/hermetic-logs/py-unit" \
        --port 3849 --port 3850 -- \
        env PYTHONPATH="$PWD/scripts/hermetic/hooks" \
            HERMETIC_EVENTS="$PWD/hermetic-logs/py-unit/events.tsv" \
        .venv/bin/python scripts/hermetic/tagging_runner.py tests/client/unit
    python3 scripts/hermetic/unit-verdict.py hermetic-logs/py-unit/events.tsv
