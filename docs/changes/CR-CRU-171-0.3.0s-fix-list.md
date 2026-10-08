# CR-CRU-171 — 0.3.0's fix list: the clients

**Type** fix · **Points** 5 (re-scored at gap analysis 2026-10-08, when the page issues moved to CR-CRU-174; was 13 provisional) · **Wave** 7 (0.3.0) · **Depends on** none ·
**Status** PENDING — filed 2026-10-07; amended and split at gap analysis 2026-10-08 (user-approved): the page issues are CR-CRU-174

## Problem

Two client defects in 0.3.0's own features. The list closed at gap analysis on 2026-10-08, when the
user split it: issues 2 and 4–8 (the page and the board) are CR-CRU-174. The issue numbers are kept as filed.

### 1 — an unfiled declared-tier run is refused by the board

**Observed 2026-10-07 (CR-CRU-170 C3 GREEN, cycle 597):** `python3 clients/bun-crucible.py e2e -- --grep
"burndown"`, with no `--agent`, ran 7 scenarios and all 7 passed, but the client still POSTed the
board-decoded report (`crucible.rawReport.test:e2e`) to `/api/v2/runs`. The board refused it (HTTP 409,
"a registered caller is required — this request carried no agentId"), so a passing unfiled run ended
`ok: false` with exit 1. bun `test` without `--agent` does not ingest and exits with the runner's code;
the declared-tier path (`cmd_regression`'s `script` branch) does not follow it. CR-CRU-170 §S3 made
unfiled filtered e2e runs the natural way to work, so this now bites every agent that uses it.

### 3 — nine run-opening verbs take no `--cycle`

**Measured 2026-10-07 (CR-CRU-164 C2 RED, cycle 601):** python `test`, mvn `test`, `unit`, `module`,
`integration` and `e2e`, and rust `test`, `smoke-test`, `workspace-regression` and `pre-merge-gate`
open and file a run but accept no `--cycle`; every other client's run-opening verbs do (the shared
`add_gate_cycle_arg`). An agent of those stacks can only bind by `register --cycle` beforehand, so the
five clients do not bind a run the same way. **User ruling 2026-10-07:** into this CR — each of the
nine gains `--cycle` through the shared helper, with the same semantics as everywhere else.

**Not here:** issues 2, 4, 5, 6, 7 and 8 — CR-CRU-174. The release history — CR-CRU-172 and CR-CRU-173.

## Steps

### §S1 — an unfiled run files nothing (issue 1)

A suite verb that **may** run without `--agent` (bun `test` and its declared-tier verbs; python,
mvn, rust and arduino `test` and their tier verbs) runs the suite and files nothing — no run start,
no ingest, no abort — and exits with the runner's own code, exactly as bun `test` does today.
Measured 2026-10-08 (cycle 608 RED): bun's declared-tier verbs are the only offenders — they run
`cmd_regression`'s body, which ingests regardless; the other clients' optional-agent verbs already
file nothing.

The evidence verbs keep `--agent` **required** (user ruling 2026-10-08): bun, python and mvn
`regression` and `pre-merge-gate`, and rust `regression`, `workspace-regression`, `smoke-test`,
`regression-ingest` and `pre-merge-gate` exist to file evidence, and a gate that runs without a
record defeats the gate. Without `--agent` they are refused before anything runs or posts, as
today.

### §S2 — nine verbs take `--cycle` (issue 3)

python `test`; mvn `test`, `unit`, `module`, `integration`, `e2e`; rust `test`, `smoke-test`,
`workspace-regression`, `pre-merge-gate` gain `--cycle` through the shared `add_gate_cycle_arg`,
with exactly the semantics it has on every other verb (bind for the run; refused as elsewhere; a
release run per CR-CRU-164 still refuses a cycle).

## Acceptance criteria

- [x] For each client's optional-agent suite verbs, a run without `--agent` posts nothing to the
      board and exits with the runner's code — asserted per client with the subprocess harness, bun's
      declared-tier verbs included (flag and raw-report targets); each required-agent evidence verb
      named in §S1, run without `--agent`, is refused before the runner starts and posts nothing —
      asserted per client.
- [x] Each of the nine verbs in §S2 accepts `--cycle` and binds the run exactly as the other verbs
      do, and its `--help` lists it — asserted per client.
