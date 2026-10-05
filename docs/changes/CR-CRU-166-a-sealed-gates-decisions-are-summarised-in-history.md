# CR-CRU-166 — a sealed gate's decisions are summarised in history

**Type** feature · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-162 · **Status** PENDING — filed 2026-10-05

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

Visual contract: storyboard F21 panel d (approved 2026-10-05).

## Acceptance criteria

- [ ] A sealed gate with recorded decisions shows the summary line on its timeline card and on its
      History wave row, with the same text, counted from its decision records.
- [ ] A gate with no recorded decisions, and an in-flight gate, show no summary line.
- [ ] A click on the line opens that gate's drill-in.
- [ ] The behaviour matches storyboard F21 panel d.

Points are set at gap analysis.
