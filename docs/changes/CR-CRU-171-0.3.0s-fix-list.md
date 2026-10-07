# CR-CRU-171 — 0.3.0's fix list

**Type** fix · **Points** 5 (provisional, 2026-10-07: issue 2 added; re-scored at gap analysis) · **Wave** 7 (0.3.0) · **Depends on** none ·
**Status** PENDING — filed 2026-10-07; held LAST in wave 7 while the user adds issues (user ruling 2026-10-07)

## Problem

A collection of defects in 0.3.0's own features, found while they shipped (renamed from "the client's
fix list" on 2026-10-07, when issue 2 made it more than the clients'). The user is adding
more issues before this CR is analysed; each becomes a step and an AC at gap analysis.

### 1 — an unfiled declared-tier run is refused by the board

**Observed 2026-10-07 (CR-CRU-170 C3 GREEN, cycle 597):** `python3 clients/bun-crucible.py e2e -- --grep
"burndown"`, with no `--agent`, ran 7 scenarios and all 7 passed, but the client still POSTed the
board-decoded report (`crucible.rawReport.test:e2e`) to `/api/v2/runs`. The board refused it (HTTP 409,
"a registered caller is required — this request carried no agentId"), so a passing unfiled run ended
`ok: false` with exit 1. bun `test` without `--agent` does not ingest and exits with the runner's code;
the declared-tier path (`cmd_regression`'s `script` branch) does not follow it. CR-CRU-170 §S3 made
unfiled filtered e2e runs the natural way to work, so this now bites every agent that uses it.

### 2 — the release band's total is the points committed at the start, not the release's total

**Observed 2026-10-07:** the release band read `0.3.0 · 13 of 39 pts left`. The 13 is right; the 39 is
the burndown's `committedPoints` — the points in the release at its start (2026-09-09: CR-CRU-015,
018, 022 and 098). 27 of the release's 31 CRs entered after that, so the release's live total was
**217** (204 merged + 13 pending; 8 more voided), and "of 39" beside 204 merged reads as nonsense.
Points and the declaration journal only arrived mid-release (CR-CRU-022, 2026-09-24), which makes the
start-committed figure smaller still.

**User ruling 2026-10-07:** the band shows the remaining points of the release's **total**, and the
total stays current: it changes with replanning — a voided or superseded CR lowers it, a CR added
to the release raises it, a re-point moves it — so it is always the points of the release's live
CRs (merged + pending). DN-crucible-analytics §10 is amended to match at gap analysis.

### 3 — …

(more to be added by the user)

## Steps

To be written at gap analysis, one per issue.

## Acceptance criteria

To be written at gap analysis, one or more per issue.
