# CR-CRU-173 — History is told by release

**Type** feature · **Points** 13 (re-scored 8 → 21 at gap analysis, then split 2026-10-08 by user ruling: §S0/§S0b → CR-CRU-176 (8), §S1/§S2 stay here (13)) · **Wave** 7 (0.3.0) ·
**Depends on** CR-CRU-176, CR-CRU-172, CR-CRU-164, CR-CRU-166 · **Status** PENDING — filed 2026-10-08 (user ruling:
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
it names; one that named none belongs to the release of the wave it gated; one that names
neither belongs to the first release that shipped at or after it, else the lowest unshipped
release (user ruling 2026-10-08: 0.2.0's 09-09 gate names neither). A wave whose CRs went to
more than one release (this board's past: wave 7 → 0.2.2 and 0.3.0; wave 6 → 0.2.0 and 0.2.1;
wave 5 → 0.2.0 and 0.1.3) appears under each of its releases with that release's CRs only.

**Settled at gap analysis (from the board's data and F22, which wins):**
- **Which releases.** Every release record of the project that has history — shipped, or holding a
  merged CR, a plan or a gate. A release with none of these (today 0.4.0) is future work, not
  history, and is not listed (F22 lists none).
- **A release's CRs.** A shipped release's record names its CRs (`crs`, CR-CRU-080 provenance) and
  that list wins: 0.2.0's 70 include 3 wave-4 CRs and CR-CRU-090, which the queue files under 0.1.3
  (it then appears under both, honestly). An unshipped release takes its CRs from the queue's
  `release` (0.3.0's 35+). CRs with neither (waves 1–4 before releases were declared) follow the
  record that names them (0.1.0's 60).
- **One row per release** (user ruling 2026-10-08, at cycle 636). The same-day merge first drawn
  in F22 (`release 0.1.2 · 0.1.1 · 0.1.0`) cannot be stated as a rule — 0.2.0 and 0.2.1 also shipped
  the same day and F22 drew them apart — so every release is its own row, latest first; F22 is
  amended.
- **Gate runs.** Snapshots group by their no-mistakes `runId` (CR-CRU-172 §S0 posts it). Older
  snapshots carry none: a run is then the snapshots up to and including the next seal (a gate not
  in flight). A run's outcome is its seal's; its stop step the first step not `passed`/`skipped`;
  its fix rounds the times a step entered `fixing`; its duration first snapshot → seal. On this
  board 0.2.0 has three: 09-09 (passed, no ladder), 09-16 05:57 (cancelled at review), 09-16
  05:58–07:10 (passed, one document fix round, pushed 4cda68f).
- **Retired gates are history.** Every 0.2.0 gate is retired (stamped at its ship, or by the v20
  migration), and the events read leaves retired gates out — so the history read is a NEW read
  (`GET /api/v2/projects/<key>/history`), the one place retired gates are returned, answering the
  release rows with their workflow (gate runs, verification run count, packages) and their waves'
  CR ids; the page joins those ids to the plans it already holds for the CR and cycle rows.
- **Tag** is `v<label>` with the record's commit, shown when the release shipped.

## Acceptance criteria

(AC wording below is the gap-analysed set, 2026-10-08.)

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

## Gap analysis (2026-10-08)

**Baseline** (develop `49d3625`, 22:25–22:42, unfiled): bun 3255/0, e2e 97/0 scenarios, python
2324/0 — the first all-green baseline since CR-CRU-172 fixed the test leaks.

| # | Dim | Finding | Fix | Blocking |
|---|---|---|---|---|
| DRIFT-1 | 3 | "Posting agent live" is always true: snapshots post under the orchestrator's id | → CR-CRU-176 §S1 | — |
| DRIFT-2 | 1 | A run held `awaiting_approval` has no live process but is a release task in progress | → CR-CRU-176 §S1 | — |
| DRIFT-3 | 3 | Every 0.2.0 gate is retired; the events read omits retired gates, so History cannot see them | §S2 a new history read | Yes |
| DRIFT-4 | 3 | Pre-0.3.0 gates carry no run id; "grouped by no-mistakes run" is undefined for them | §S2 seal-bounded runs | Yes |
| DRIFT-5 | 1 | A release's CRs: record `crs` (70 for 0.2.0) vs queue `release` (66) disagree; waves 1–4 have no queue release | §S2 record wins when shipped | No |
| DRIFT-6 | 1 | F22 merges same-day releases into one row and omits 0.4.0; the spec said neither | §S2 rules from F22 | No |
| DRIFT-7 | 2 | §S0b had no frame | F23 drawn and approved → CR-CRU-176 §S2 | — |
| DRIFT-8 | 7 | Cost: §S0 (client + page), §S0b, a new server read, the release tree, re-pins → 8 is short; 21 exceeds the board's scale (max 13) | split: CR-CRU-176 (8) + this (13), user ruling | — |

**Bounded surface:** a release row's text (state, tag, commit, CR count, target and delta) is
fixed-shape; the waves and gate runs it opens to are lists in History's own scroll (CR-CRU-172).
Same-day merging bounds the row count for burst releases.

**Dimension 4 (consumed):** `workflowLens`'s wave → CR → cycle grouping (now nested under a
release), `LensCrGroup`/`LensCycleRow`, F21's `gateBodyContent` + decisions summary (CR-CRU-166) for a
gate run's drill-in, CR-CRU-164's `?release=` Runs filter for verification, `gated_run` for the run
identity, `listReleases`, `listGateDecisionsForRuns`. **Removed:** none.

### Tests this CR knowingly re-pins (approved in advance; each keeps its meaning)

- **History's top level becomes releases:** tests that read History's first rows as wave headers
  (`History — Wave <n> · …`) or count wave groups at the top level — they read the same wave groups
  one level down, inside their release (e.g. `workflow-history-*`, `aggregate-headers`,
  `wave-single-active`, `workflow-lens`, the e2e wave/history steps). The wave header's own text and
  the CR/cycle rows beneath it are unchanged.
Anything outside these: stop and ask.

### Cycles

1. the board answers a project's history by release (§S2)
2. History is told by release (§S1)
3. verify
