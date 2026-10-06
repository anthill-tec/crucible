# CR-CRU-170 — a run nothing will file is closed at once, and the e2e verb runs only what it is asked

**Type** fix · **Points** 5 (provisional, 2026-10-07; set at gap analysis) · **Wave** 7 (0.3.0) · **Depends on** none ·
**Status** PENDING — filed 2026-10-07

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

A client may abort a run it opened and has not filed, giving a reason. The run is settled `aborted`
with that reason at once, exactly as the server's own auto-abort settles it (`agent died`,
`abandoned`), and the timeline shows it as an aborted run with the reason. Only the agent that
opened the run may abort it; a run already filed or already aborted is refused, and nothing changes.

### §S2 — every client closes a run it can no longer file

When a suite verb's runner exits without the report the client would ingest (or the verb is
interrupted), every stack client (bun, python, mvn, rust, arduino) aborts the run it opened, with
a reason naming what happened (e.g. `runner exited 1 and wrote no report`), and its envelope reports
the run as aborted, not left open. The `run-left-open` warning remains only for a run the client
could not abort (the board unreachable).

### §S3 — the e2e verb runs only the features it is asked

`bun-crucible.py e2e` accepts the feature files (or a name filter) to run, passes them to the
declared target, and files only what ran, as a run of the e2e tier like any other. Without them it
runs the whole suite, as today.

## Acceptance criteria

- [ ] A run opened and then aborted by its own agent is settled `aborted` with the given reason at
      once, and shows so on the timeline; an abort by another agent, or of a filed or already
      aborted run, is refused and changes nothing, asserted on the server.
- [ ] For each stack client, a suite verb whose runner exits without a report leaves no open run on
      the board: the run is aborted with the reason, and the envelope says so, asserted against a
      real server.
- [ ] `e2e` with named features runs only those features and files exactly their results; without
      them it runs and files the whole suite, asserted with a real Playwright run.
