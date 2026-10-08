# CR-CRU-176 — a running gate is a live run, and a cycle's change sits beneath it

**Type** fix · **Points** 8 (split from CR-CRU-173 at its gap analysis, 2026-10-08, user ruling) ·
**Wave** 7 (0.3.0) · **Depends on** CR-CRU-172 · **Status** PENDING — filed 2026-10-08

## Problem

Two defects in what CR-CRU-172 shipped, both from the user's screenshot of Now on 2026-10-08: a
gate from a finished run kept showing in Now as `in flight`, and a cycle's recorded change (CR-CRU-165)
crowded the cycle's title off its own line. Both were first written into CR-CRU-173 (§S0, §S0b); its
gap analysis sized the whole at ~21 points, beyond the board's 13 cap, and the user split them out
here (8), ahead of CR-CRU-173 (13), which reads the same gates.

## Design (approved — implement to it)

- §S1: storyboard **F21** (the gate view Now shows) and **F22** (Now's states), unchanged; the held
  state adds `awaiting your decision` naming the step to F21's banner.
- §S2: storyboard **F23** ("A cycle's recorded change sits beneath it, never beside it", APPROVED
  2026-10-08).

The storyboard is local (`.lavish/crucible-v2-design.html`, gitignored); every RED, GREEN and VERIFY
agent reads it and matches it. Where this spec and a frame disagree, the frame wins and the
disagreement is raised with the orchestrator.

## Steps

### §S1 — a gate is running only while the run that posts it is alive

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
posting agent's liveness vs. the run's own heartbeat) and the AC; it comes before CR-CRU-173,
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

### §S2 — a cycle's change record never crowds its title

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

## Acceptance criteria

- [ ] **AC1 — a run is driven or held, or it is not running.** `gate-run`/`gate-respond` in each of
      the five clients post every snapshot under the run identity (`<caller>·gate`), heartbeat it
      while driving and remove it on every exit (seal, held, refused, interrupt), leaving the
      caller's own registration intact — asserted per client against a recording board. On the
      page: newest gate in flight + identity online → running; + a step `awaiting_approval` with
      the identity gone → running, `awaiting your decision`; + identity stale and not held → not
      running (Now `Nothing running → Roadmap`, landing on the Roadmap) — asserted with fixed
      fixtures.
- [ ] **AC2 — F23.** A cycle with a recorded change (or a skipped one) renders the record as its
      own line beneath the cycle line in Now and in History; the cycle line's label, kind badge,
      timer and `→ Runs` are unchanged and the label is not truncated by the record — asserted on
      the page and, at 1280×800 and 390×844, in a real browser.

## Gap analysis (2026-10-08, done as CR-CRU-173's; split here)

Baseline: develop `49d3625`, bun 3255/0, e2e 97/0, python 2324/0 (22:25–22:42). Findings carried
from CR-CRU-173's analysis: DRIFT-1 (snapshots post under the orchestrator's always-live id → the run
identity), DRIFT-2 (a held run has no live process but is in progress → the held state), DRIFT-7
(§S2 had no frame → F23, approved). Consumed: `gated_run` (owned identity, heartbeat, removal on
every exit), `drive_axi_run`/`stream_axi_ladder`, `runningGate` + `landingTab` (CR-CRU-172), the
agents slice's liveness on the page, `cycleChangeRecord` + `changeRecordText` (CR-CRU-165).

### Tests this CR knowingly re-pins (approved in advance; each keeps its meaning)

- **Gate snapshots post under the run identity:** client tests asserting a posted gate's `agentId`
  equals the caller's id read `<caller>·gate`; the caller's own registration is asserted unchanged.
- **The change record moves beneath the cycle line** (F23): `tests/workflow-recorded-change-visibility.test.ts`
  and any test reading the record as part of the cycle line's text — the record's text is unchanged.
- **Running needs a live or held run:** CR-CRU-172 tests whose in-flight fixture gate has no live
  posting identity and expects Now to show it gain the identity (or a held step) in the fixture.
Anything outside these: stop and ask.

### Cycles

1. a gate is running only while its run is driven or held for a decision (§S1, AC1)
2. a cycle's recorded change sits beneath it, never beside it (§S2, AC2)
3. verify

## VERIFY follow-up (2026-10-08, user ruling: fix both)

VERIFY (cycle 633) approved AC1 and AC2 with two should-fixes, both fixed in cycle 634:
1. **F23's pull-up.** F23 draws the record 2 px up under its cycle line (`margin: -2px 0 4px …`);
   GREEN shipped 0 because the e2e "record is below the line" check failed by 1 px. The frame wins:
   the record takes F23's `-2px`, and the check (approved test edit) allows that 2 px tuck while still
   failing a record that sits BESIDE the line (same row) or overlaps it by more.
2. **One identity per run.** Two concurrent gate drives by the same caller shared `<caller>·gate`;
   the first to finish removed it under the other. Each drive now opens its OWN identity,
   `<caller>·gate·<run>` (`<run>` = the no-mistakes run id's first 8 characters, from the first
   snapshot, before that snapshot is posted), so one run's exit never touches another's. A drive
   that gets no run id (refused before any snapshot) opens none. AC1's wording reads
   `<caller>·gate·<run>` wherever it says `<caller>·gate`; asserted additionally by a test with two
   concurrent drives by one caller, where the first's exit leaves the second's identity online.
