# CR-CRU-173 — History is told by release

**Type** feature · **Points** 21 (re-scored 8 → 21 at gap analysis 2026-10-08, user ruling) · **Wave** 7 (0.3.0) ·
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

**Settled at gap analysis (user ruling 2026-10-08, "run-scoped identity").** Today every snapshot is
posted under the orchestrator's id (`vidushi`), which stays live all session, so "the posting agent
is live" would keep a dead run in Now. Instead:
- `gate-run` and `gate-respond` (`drive_axi_run`, all five clients) post the run's snapshots under a
  **run identity** of their own — the caller's id with a `·gate` suffix — opened through the existing
  owned-identity bracket (`gated_run`: created by the run, heartbeated, removed on every exit), and
  heartbeated on the poll loop's cadence (well inside the project's stale threshold) for as long as
  the verb drives the run. The caller's own registration is untouched.
- On the page, a gate is **running** when the project's newest gate is in flight AND either its
  posting identity is online (the run is being driven) or its ladder has a step `awaiting_approval`
  (no-mistakes is held for a decision — a release task in progress with no process alive). A held
  run shows in Now as F21's gate view with `awaiting your decision` naming the step, until a
  `gate-respond` or a seal moves it.
- A run that dies mid-step (crash, kill, power cut) leaves an in-flight, not-held snapshot whose
  identity goes stale: within the stale threshold Now drops it and the landing rule follows.
- One selector (`runningGate`) still decides Now and the landing tab.

### §S0b — a cycle's change record never crowds its title

**Reported 2026-10-08 (user, same screenshot).** A cycle carrying a recorded change (CR-CRU-165:
`reason · cause · spec`, e.g. a cycle added with `cycle-add --reason`) renders the record on the
cycle's OWN line (`cycleChangeRecord` inside `CycleLine`), so the label truncates to `"a sealed run
leaves no ru…"` and `"v…"` and the line's fields are pushed aside. CR-CRU-165 drew it from the spec
alone; no frame covers it.

**User ruling 2026-10-08:** the record goes on its own dim, indented line BENEATH the cycle line, and
wraps rather than truncates; the cycle line keeps its full title, kind badge, timer and `→ Runs`.
Same rule in Now's plan section and History's cycle rows (both `CycleRow` and `LensCycleRow`), and for
a skipped cycle's record. **Design: storyboard F23** ("A cycle's recorded change sits beneath it,
never beside it", APPROVED 2026-10-08) — implement to it.

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

**Settled at gap analysis (from the board's data and F22, which wins):**
- **Which releases.** Every release record of the project that has history — shipped, or holding a
  merged CR, a plan or a gate. A release with none of these (today 0.4.0) is future work, not
  history, and is not listed (F22 lists none).
- **A release's CRs.** A shipped release's record names its CRs (`crs`, CR-CRU-080 provenance) and
  that list wins: 0.2.0's 70 include 3 wave-4 CRs and CR-CRU-090, which the queue files under 0.1.3
  (it then appears under both, honestly). An unshipped release takes its CRs from the queue's
  `release` (0.3.0's 35+). CRs with neither (waves 1–4 before releases were declared) follow the
  record that names them (0.1.0's 60).
- **Releases shipped the same day share one row** (F22: `release 0.1.2 · 0.1.1 · 0.1.0 · shipped
  08-19 · 61 CRs · wave 4`), opening to each one's workflow.
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
- [ ] **§S0 — a run is driven or held, or it is not running.** `gate-run`/`gate-respond` in each of
      the five clients post every snapshot under the run identity (`<caller>·gate`), heartbeat it
      while driving and remove it on every exit (seal, held, refused, interrupt), leaving the
      caller's own registration intact — asserted per client against a recording board. On the
      page: newest gate in flight + identity online → running; + a step `awaiting_approval` with
      the identity gone → running, `awaiting your decision`; + identity stale and not held → not
      running (Now `Nothing running → Roadmap`, landing on the Roadmap) — asserted with fixed
      fixtures.
- [ ] **§S0b — F23.** A cycle with a recorded change (or a skipped one) renders the record as its
      own line beneath the cycle line in Now and in History; the cycle line's label, kind badge,
      timer and `→ Runs` are unchanged and the label is not truncated by the record — asserted on
      the page and, at 1280×800 and 390×844, in a real browser.
- [ ] On a copy of the dev store, 0.2.0 shows three gate runs (the passed one with one document fix
      round, pushed 4cda68f), 70 CRs, shipped 09-16, and waves 6, 5 and 4 with only 0.2.0's CRs;
      0.2.2 shows wave 7 with its 4 CRs and "ship not recorded" — asserted on the server.

## Gap analysis (2026-10-08)

**Baseline** (develop `49d3625`, 22:25–22:42, unfiled): bun 3255/0, e2e 97/0 scenarios, python
2324/0 — the first all-green baseline since CR-CRU-172 fixed the test leaks.

| # | Dim | Finding | Fix | Blocking |
|---|---|---|---|---|
| DRIFT-1 | 3 | "Posting agent live" is always true: snapshots post under the orchestrator's id | §S0 run identity (user ruling) | Yes |
| DRIFT-2 | 1 | A run held `awaiting_approval` has no live process but is a release task in progress | §S0 held → running | Yes |
| DRIFT-3 | 3 | Every 0.2.0 gate is retired; the events read omits retired gates, so History cannot see them | §S2 a new history read | Yes |
| DRIFT-4 | 3 | Pre-0.3.0 gates carry no run id; "grouped by no-mistakes run" is undefined for them | §S2 seal-bounded runs | Yes |
| DRIFT-5 | 1 | A release's CRs: record `crs` (70 for 0.2.0) vs queue `release` (66) disagree; waves 1–4 have no queue release | §S2 record wins when shipped | No |
| DRIFT-6 | 1 | F22 merges same-day releases into one row and omits 0.4.0; the spec said neither | §S2 rules from F22 | No |
| DRIFT-7 | 2 | §S0b had no frame | F23 drawn and approved | — |
| DRIFT-8 | 7 | Cost: §S0 (client + page), §S0b, a new server read, the release tree, re-pins → 8 is short | re-score | — |

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
- **The change record moves beneath the cycle line** (F23): `tests/workflow-recorded-change-visibility.test.ts`
  and any test reading the record as part of the cycle line's text — the record's text is unchanged.
- **Gate snapshots post under the run identity:** client tests asserting a gate's posting `agentId`
  equals the caller's id read `<caller>·gate` (the caller's registration is asserted unchanged).
Anything outside these: stop and ask.

### Cycles

1. a gate is running only while its run is driven or held for a decision (§S0)
2. a cycle's recorded change sits beneath it, never beside it (§S0b, F23)
3. the board answers a project's history by release (§S2)
4. History is told by release (§S1)
5. verify
