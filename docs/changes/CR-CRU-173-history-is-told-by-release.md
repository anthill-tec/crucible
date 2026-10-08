# CR-CRU-173 — History is told by release

**Type** feature · **Points** 8 (provisional, 2026-10-08; set at gap analysis) · **Wave** 7 (0.3.0) ·
**Depends on** CR-CRU-172, CR-CRU-164, CR-CRU-166 · **Status** PENDING — filed 2026-10-08 (user ruling:
0.3.0, after CR-CRU-172)

## Problem

**Reported 2026-10-07 (user):** the Workflow tab's release history is "lame" — a release's gate
runs, its verification and what it shipped are nowhere to be seen, although the board holds all of
it: every gate snapshot (0.2.0's last gate alone left 12), the gate decisions (CR-CRU-162/166), the
runs filed under a release (CR-CRU-164) and the release records (commit, ship time, CRs, packages,
target). Storyboard **F22** (approved 2026-10-08) is the design; this CR is its second half. The
first — the Now and History panes — is CR-CRU-172.

**User rulings (F22 review, 2026-10-07):** a release is the **larger container** — one or more waves
lead up to it; a release's own workflow (the no-mistakes gate, verification, the ship) happens
**between waves**, when no wave and no CR is active; time order is kept at every level.

## Design (approved — implement to it)

The approved design is storyboard **F22** in `.lavish/crucible-v2-design.html` (the History pane:
release rows latest first, each opening to its release workflow — gate runs, verification, shipped —
and then its waves; cards a–c beneath it), with **F21** (the gate view and its decisions line, F21·d)
and **F8½** (the gate drill-in) as the frames it opens to. F22's rows carry this board's real data
for 0.2.0, 0.2.1, 0.2.2 and 0.1.x — the AC's dev-store checks are taken from them. The storyboard is
local to this checkout (gitignored), so every RED, GREEN and VERIFY agent reads it there and matches
it: row order and nesting, folding, the wording of each row. Where this spec and F22 disagree, F22
wins and the disagreement is raised with the orchestrator.

## Steps

### §S0 — a gate is running only while the run that posts it is alive

**Reported 2026-10-08 (user, screenshot of Now after CR-CRU-172 cycle 625).** Now showed `GATE ·
no-mistakes checks-passed · in flight` from an old run. That instance was 0.2.0's orphaned snapshots,
retired by CR-CRU-172's v20 migration; but the hole remains: a no-mistakes run that dies without
sealing leaves an in-flight snapshot as the project's newest gate, and CR-CRU-172's `runningGate`
(newest gate in flight) then shows it in Now — and lands the project on Workflow — forever.

**User ruling 2026-10-08:** liveness decides. A gate counts as running only while the agent that
posted its newest snapshot is still live under the project's liveness thresholds (the same rule the
agent cards use); once that agent is stale or gone, the gate is not running — Now drops it, and the
landing tab follows. When a CR and a genuinely running gate are both live, Now keeps showing both,
plan first (CR-CRU-172 §S2, re-confirmed 2026-10-08). Gap analysis settles the exact signal (the
posting agent's liveness vs. the run's own heartbeat) and the AC; it is this CR's first cycle,
because History reads the same gates.

### §S1 — History lists releases, each holding its workflow and then its waves

History lists the project's releases, latest first. A release row states its state (in progress /
shipped and when), tag, commit, CR count and its target and how far off. Opened, it shows:

1. **its release workflow** (on top — it came last): its **gate runs**, one row each — outcome,
   the step that stopped it, fix rounds, duration — opening to the sealed ladder and F21·d's
   decisions line, with `→ gate` opening the gate view (F8½ + F21); its **verification** (the runs
   filed under the release, CR-CRU-164, opening the Runs tab filtered to it); and **what shipped**
   (the packages its record names). A release whose workflow has not started says so.
2. **the waves that led up to it**, latest first, each opening to its CRs and their cycles exactly as
   History does today.

The open release and its open wave are expanded; every other release is one line until opened.

### §S2 — the history read

The board answers the history in this shape from what it already holds — no new record: release
records, each CR's release and wave in the queue, plan close times, gate snapshots grouped by their
no-mistakes run (a run's outcome, the step it stopped at, its fix rounds and its duration are
derived from its snapshots), gate decisions and release-stamped runs. A gate belongs to the release
it names; one that named none belongs to the release of the wave it gated. A wave whose CRs went to
more than one release (this board's past: wave 7 → 0.2.2 and 0.3.0; wave 6 → 0.2.0 and 0.2.1;
wave 5 → 0.2.0 and 0.1.3) appears under each of its releases with that release's CRs only.

## Acceptance criteria

- [ ] History lists releases latest first; a release opens to its release workflow and then its
      waves, latest first, each opening to CRs and cycles as today; the open release and its open
      wave start expanded, every other release folded — asserted on the page with fixed fixtures and
      in a real browser.
- [ ] A release's gate runs are listed one row per no-mistakes run with outcome, stop step, fix
      rounds and duration derived from its snapshots; `→ gate` opens the gate view; its
      verification line opens the Runs tab filtered to the release; its packages are listed —
      asserted on the server and on the page.
- [ ] On a copy of the dev store, 0.2.0 shows three gate runs (the passed one with one document fix
      round, pushed 4cda68f), 70 CRs, shipped 09-16, and waves 6, 5 and 4 with only 0.2.0's CRs;
      0.2.2 shows wave 7 with its 4 CRs and "ship not recorded" — asserted on the server.
