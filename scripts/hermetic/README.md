# scripts/hermetic

These scripts run a test suite hermetically: in an isolated network namespace with no route, every
capability dropped, an empty `HOME`, and a tripwire listening on the board ports. Run each one from
the repository root. No step inside the wrapper may need the network. Do installs, cache provisioning
and browser installs before you call it.

## `run.sh <log-dir> -- <command…>` (the wrapper)

1. It checks that `unshare`, `setpriv`, `ip` and `python3` are on `PATH`. It builds the environment
   (below) and re-executes itself inside `unshare --map-current-user --keep-caps -n`.
2. Inside the namespace it brings `lo` up. It then re-executes itself under
   `setpriv --ambient-caps -all --inh-caps -all --bounding-set -all --no-new-privs`.
3. It prints the preamble that the command's own shell sees: `ip -o addr`, `ip route`,
   `ip -6 route`, `id`, the `CapEff` and `CapBnd` lines of `/proc/self/status`, then `HOME` and
   `DOCKER_HOST`.
4. It starts `tripwire.py`, with `PYTHONPATH`, `HERMETIC_EVENTS` and `HERMETIC_TEST` removed and
   `python3 -I`. The tripwire's output goes to `<log-dir>/tripwire.log`. The wrapper waits up to
   10 s for the banner and requires it to name all four sockets.
5. It runs the command. Then it checks that the tripwire is still alive, stops it with SIGTERM (the
   tripwire drains any in-flight handler) and gives the verdict.

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

### Exit codes

| Code | Meaning |
|---|---|
| the command's own | no tripwire hit and the setup held |
| 90 | usage: bad arguments, or the log dir cannot be created |
| 91 | setup: a required command (`unshare`, `setpriv`, `ip`, `python3`, or `go env`) is missing |
| 92 | setup: the kernel refused the unprivileged user and network namespace |
| 93 | setup: `lo` could not be brought up, or `setpriv` could not drop the capabilities |
| 94 | setup: the tripwire's banner was not seen, or did not name all four sockets |
| 95 | setup: the tripwire died during the run, or did not drain cleanly |
| 99 | HIT: something connected to a board port; the tripwire log is printed |

Codes 90–95 report a broken setup. They are never a verdict on the command.

The command's own status passes through unchanged, so a command that itself exits 90–95 or 99
reads as one of the codes above. The wrapper does not remap it; its log tells the two apart. A
status that is the command's own follows `hermetic: VERDICT clean — no tripwire hit; the command's
status is <status>`, a setup failure prints `hermetic: SETUP FAILURE (exit <code>)` (a usage error
prints `usage:`), and a hit prints `hermetic: VERDICT HIT`. `bun test` and unittest exit 0 or 1;
wrap a command that can exit 90 or above only where its log, not its code, is read.

## `tripwire.py`

Run it as `python3 -I tripwire.py`, inside the namespace only. It listens on `127.0.0.1` and `::1`,
ports 3849 and 3850, and prints `tripwire listening <four sockets>` once all four sockets are bound.
Each connection is logged at `accept()`:

    HIT <time> port=<port> peer=<addr> pid=<pid> cwd=<cwd> cmd=<cmdline>
        | <first request line>

It finds the peer process through `/proc`; `?` means it found none. Each connection is answered
`503` and closed. On SIGTERM the tripwire stops accepting, waits for every in-flight handler and
exits 0. It exits 1 if a socket cannot bind, and 3 if a listening socket fails during the run.

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
  preload records the top frame outside itself and `node_modules`. Its first line is
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

## Example (a unit tier)

    scripts/hermetic/run.sh "$PWD/hermetic-logs/py-unit" -- \
        env PYTHONPATH="$PWD/scripts/hermetic/hooks" \
            HERMETIC_EVENTS="$PWD/hermetic-logs/py-unit/events.tsv" \
        .venv/bin/python scripts/hermetic/tagging_runner.py tests/client/unit
    python3 scripts/hermetic/unit-verdict.py hermetic-logs/py-unit/events.tsv
