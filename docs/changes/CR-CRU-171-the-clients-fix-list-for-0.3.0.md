# CR-CRU-171 — the client's fix list for 0.3.0

**Type** fix · **Points** unscored (set at gap analysis) · **Wave** 7 (0.3.0) · **Depends on** none ·
**Status** PENDING — filed 2026-10-07; held LAST in wave 7 while the user adds issues (user ruling 2026-10-07)

## Problem

A collection of client defects in 0.3.0's own features, found while they shipped. The user is adding
more issues before this CR is analysed; each becomes a step and an AC at gap analysis.

### 1 — an unfiled declared-tier run is refused by the board

**Observed 2026-10-07 (CR-CRU-170 C3 GREEN, cycle 597):** `python3 clients/bun-crucible.py e2e -- --grep
"burndown"`, with no `--agent`, ran 7 scenarios and all 7 passed, but the client still POSTed the
board-decoded report (`crucible.rawReport.test:e2e`) to `/api/v2/runs`. The board refused it (HTTP 409,
"a registered caller is required — this request carried no agentId"), so a passing unfiled run ended
`ok: false` with exit 1. bun `test` without `--agent` does not ingest and exits with the runner's code;
the declared-tier path (`cmd_regression`'s `script` branch) does not follow it. CR-CRU-170 §S3 made
unfiled filtered e2e runs the natural way to work, so this now bites every agent that uses it.

### 2 — …

(to be added by the user)

## Steps

To be written at gap analysis, one per issue.

## Acceptance criteria

To be written at gap analysis, one or more per issue.
