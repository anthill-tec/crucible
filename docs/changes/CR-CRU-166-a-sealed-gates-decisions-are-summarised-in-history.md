# CR-CRU-166 — a sealed gate's decisions are summarised in history

**Type** feature · **Points** 5 (set at gap analysis 2026-10-05) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-162 · **Status** PENDING — filed 2026-10-05

## Problem

**User note on storyboard F21, 2026-10-05.** CR-CRU-162 records each gate decision and lists them in
the gate's drill-in. Once the run finishes and the release closes, the history should carry a short
summary of those decisions without opening the drill-in. The user ruled that this summary is its
own CR, not part of CR-CRU-162.

## Scope

### §S1 — one summary line, in two places

Once a gate is sealed, its 🛡 card on the Runs timeline (F8) and its gated wave's row in the
Workflow History (F13) carry one line counted from the run's decision records (CR-CRU-162): the
number of decisions, the findings fixed (and any added), the findings declined, and the approvals
given with a reason. For example: `4 decisions · fixed 3 + 1 added · declined 16 · 1 approved with a
reason`. The same words in both places; a click opens the gate's drill-in. A gate with no recorded
decisions adds no line, and an in-flight gate shows none.

Counting (R1, R2): **fixed** = the finding ids selected by `fix` decisions (distinct), plus one
per added finding (shown as `fixed 3 + 1 added`); **declined** = the step's findings count minus
the findings selected for a fix at that step, summed over steps that were approved; **approved
with a reason** = `approve` decisions carrying a reason. The step findings count comes from the
no-mistakes snapshot, which the client now keeps on each gate step (`findings`). The timeline
card's existing `<n> findings fixed` clause reads the same **fixed** figure.

The server computes the summary (G1): each sealed gate event with a `runId` carries
`decisionSummary` in the events list, from one grouped query per read. The History wave row
summarises the wave's latest sealed gate (G4). A click opens the gate drill-in (G5).

Visual contract: storyboard F21 panel d (approved 2026-10-05).

## Gap analysis (2026-10-05)

**Baseline, measured 2026-10-05 17:35 on develop `b302dbc`:** the gate timeline, gate card
in-flight, Workflow gate widget, Workflow tab, History refinements, decision trail and decision
record bun suites, **59/0**; the gate-run AXI and gate-respond python suites, **14/0** (both filed
project-scoped under `vidushi`).

- **G1 — the lists carry no decisions.** The Runs timeline and the Workflow History are both built
  from the events list, which CR-CRU-162 kept free of decisions (only a gate's detail read has
  them). Fetching every gate's detail to draw a summary would be one request per card. The
  server computes the counts instead (the house API rule): a sealed gate event that carries a
  `runId` gains a small `decisionSummary` (counts only) in the events list, from one grouped
  query per list read.
- **G2 — "declined" cannot be counted today. Ruling needed (R1).** A decision records what was
  selected, never what was declined, and the gate's steps no longer carry their findings count:
  `gate_from_axi` keeps only each step's name and status, although no-mistakes' snapshot has a
  `findings` count per step. F21's "declined 16" is the step's findings total minus the findings
  selected for a fix. **R1 (user, 2026-10-05): the client carries each step's findings count onto
  the gate (one shared change, all five clients), and "declined" is counted.**
- **G3 — the card already claims a "fixed" figure that is always 0. Ruling needed (R2).** The
  timeline card's seal text (`gateCardText`) says `<n> findings fixed`, summing
  `steps[].findings.fixed`, which no client sends (both `gate_from_axi` and `gate-report`'s
  `--steps` post name and status only). Beside a summary saying "fixed 3", it would contradict it.
  **R2 (user, 2026-10-05): the card's "findings fixed" is counted from the decisions, so it agrees
  with the summary.**
- **G4 — which gate a wave's row summarises.** A wave can carry several sealed gates (a re-run).
  The History row summarises the wave's latest sealed gate, the same "latest wins" rule as the
  Workflow gate widget (`boundaryGate`). The wave header today says `gated`, not F21's
  `gate passed`; the summary line sits beneath that header and the header's wording is unchanged.
- **G5 — a click opens the drill-in** through the existing gate drill-in (`openDrillin`); from
  History its back chip reads `← workflow` (CR-CRU-016's one rule).
- **Cost.** 5 points (R1 and R2 as ruled): the client's step findings count, the server's
  `decisionSummary`, and the two placements plus the card's corrected clause.

## Acceptance criteria

- [x] A sealed gate with recorded decisions shows the summary line on its timeline card and on its
      History wave row, with the same text, counted from its decision records.
- [x] A gate with no recorded decisions, and an in-flight gate, show no summary line.
- [x] A click on the line opens that gate's drill-in.
- [x] The behaviour matches storyboard F21 panel d.
- [x] Each gate step posted by `gate-run` and `gate-respond` carries its findings count from the
      no-mistakes snapshot, in all five clients (R1).
- [x] The events list's sealed gate events carry `decisionSummary` with fixed, added, declined
      and approved-with-reason counts, computed in one query per list read (G1).
- [x] The timeline card's `findings fixed` clause shows the decision-derived figure (R2).

## Cycles

C1 server + client: step findings count kept by the shared client (`gate_from_axi`), and the
server's `decisionSummary` on the events list. RED + GREEN.
C2 board: the summary line on the timeline card and the History wave row, and the card's fixed
clause. RED + GREEN.
C3 VERIFY.

Points are set at gap analysis.
