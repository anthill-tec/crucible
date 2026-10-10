# CR-CRU-170 — a run nothing will file is closed at once, and the e2e verb runs only what it is asked

**Type** fix · **Points** 8 (set at gap analysis, 2026-10-07) · **Wave** 7 (0.3.0) · **Depends on** none ·
**Status** PENDING — filed 2026-10-07; amended at gap analysis 2026-10-07 (user-approved)

## Problem

**Observed 2026-10-06 (CR-CRU-160 C2 RED, cycle 588):** the board showed three of one agent's runs
"running" at once. The agent had invoked `bun-crucible.py e2e` three times in 77 s:

| Started (UTC) | Ended | What happened |
|---|---|---|
| 21:43:27 | 21:43:28 | the runner exited 1 before writing a report (a step-generation error) |
| 21:43:55 | 21:43:57 | the same |
| 21:44:46 | 21:46:32 | the real run, filed: 898 total, 894 passed, 4 failed |

Each invocation opened a run (`POST /api/v2/runs/start`) before the runner started. The first two
never wrote a report, and the client left their runs open on purpose, saying so in its
`run-left-open` warning: *"The client posts no abort: the server settles it with its own auto-abort —
reason `agent died` as soon as this agent tombstones, else `abandoned` once the run is older than the
`run_abandon_ms` limit."* So two runs that had already ended showed as running beside the real one,
and turned into two 0-test "aborted (agent died)" cards when the agent unregistered at 21:47:30.

The client knows, the moment the runner exits without a report, that nothing will ever be filed for
the run it opened. There is no route for it to say so (`run_left_open_warning`: "a client-side abort
endpoint is CR-CRU-017 §S2 and is not built").

**Also:** the `e2e` verb runs the whole declared `test:e2e` script (about 900 steps, 1.5–2 minutes).
An agent that adds three scenarios must run and file the whole suite to file a RED or GREEN run of
them, so every attempt costs a full run, and every fast failure leaves a run open.

## Steps

### §S1 — the server accepts a client's abort of its own open run

The route is the one CR-CRU-017 §S2 designed and never built: `POST /api/v2/runs/<runId>/abort`
`{projectKey, agentId, reason}`. The run is settled `aborted` with that reason at once, by the same
store path the server's own auto-abort uses (`Store.abortRun`): one transaction writes the run row
and its `status: "aborted"` event, so the timeline and the live stream show it exactly as they show
an `agent died` or `abandoned` run. Refused, with nothing changed: an unregistered caller, an
unknown run, a run another agent opened, a run already filed (409) or already aborted (409), and an
empty reason.

### §S2 — every client closes a run it can no longer file

A suite verb that opened a run (`POST /api/v2/runs/start`) and then reaches an exit that files
nothing aborts that run through §S1, with a reason naming what happened, and its envelope reports
the run as aborted, not left open. The exits, per client:

| Exit | Where |
|---|---|
| the runner wrote no report | bun's declared-tier / `regression` / `pre-merge-gate` body (`cmd_regression`); python `regression`; rust `regression-ingest`, `smoke-test`, `workspace-regression`; arduino's native body |
| SIGINT / SIGTERM mid-run | every run-opening verb of all five clients, through the shared `emit_run_abandoned` |
| the board refused the ingest that carried the `runId` | every ingest of all five clients that carries a `runId` |

An exit that already files the runner's own words (a compile event carrying the `runId`, as bun
`test`, python's tier verbs, rust `test` and mvn's tier verbs do) files something and is unchanged.
The `run-left-open` warning remains only for a run the client could not abort (the board
unreachable, or the abort refused), and still names the server's own settlement. The two tests that
pin "the client posts no abort" (`test_every_opened_run_is_closed_or_disclosed.py`,
`test_open_run_warning_names_the_limit.py`) assert the behaviour this CR replaces; they are re-pinned
in their own commit.

### §S3 — the e2e verb runs only the features it is asked

Everything after `--` on a bun declared-tier verb is passed to the declared target verbatim
(`bun run test:e2e -- <args>`); bun forwards it to the script's last command, so the client learns
nothing about Playwright (measured 2026-10-07: `bun run test:e2e --list --grep burndown` listed 7
tests in 4 files). `bun-crucible.py e2e --agent A --cycle N -- tests/e2e/features/<name>.feature`
or `-- --grep "<title>"` runs only those, and files only what ran, as a run of the e2e tier like any
other. Without `--` it runs the whole suite, as today.

## Acceptance criteria

- [x] A run opened and then aborted by its own agent through `POST /api/v2/runs/<runId>/abort` is
      settled `aborted` with the given reason at once, stored as one `status: "aborted"` event and
      shown on the timeline as an auto-aborted run is; an abort by another agent or an unregistered
      caller, of an unknown, filed or already aborted run, or with an empty reason, is refused and
      changes nothing, asserted on the server.
- [x] For each exit in §S2's table, in each client it names, the client posts exactly one abort
      for the run it opened, carrying a reason that names the exit, and its envelope reports the
      run aborted with no `run-left-open` warning; when the abort itself fails, the envelope
      carries the `run-left-open` warning instead. Asserted per client and per exit with the
      five-client subprocess harness (`tests/client/live_run_harness.py`), and once end to end
      against a real server: a bun declared target that exits without a report leaves the run
      `aborted` with its reason on the board.
- [x] `e2e … -- <args>` passes exactly `<args>` to the declared target and files exactly the
      results its report holds; without `--` the target receives no extra argument. Asserted with
      a fixture target shaped `a && b` that records its argv and writes a Playwright-shaped report;
      a real filtered Playwright run is checked at VERIFY.
