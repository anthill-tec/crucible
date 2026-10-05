# CR-CRU-162 — a gate decision is recorded, not lost in the tool's logs

**Type** feature · **Points** 8 (planning game 2026-10-03; confirmed at gap analysis 2026-10-05) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-10-01

## Problem

**Request from Sandesh (#1412, 2026-10-01, during its 0.4.0 release validation).** `gate-run` drives
`no-mistakes axi run` and records the gate's interim and final events (`cmd_gate_run` in
`clients/_crucible_axi.py`). But a gate's **decisions** are taken with `no-mistakes axi respond`
(approve; fix with selected finding ids; `--add-finding`; `--instructions`; skip), which the agent calls
directly, so Crucible never sees them. In Sandesh's release one respond call silently selected 19
findings, and the trail of which findings were fixed, declined or decided by the user exists only in
no-mistakes' own logs.

**Measured 2026-10-01:** no client has a respond verb; `gate-run` proxies `axi run` only.

## Gap analysis (2026-10-05)

**Baseline, measured 2026-10-05 13:14–13:15 on develop `d442aeb`:** the gate card, in-flight
round trip, gate/milestone server, gate timeline, Workflow gate widget and gate retirement bun
suites, **47/0**; the gate-run AXI, gates, ladder streaming, no-false-seal, declared-skip and
skip-passthrough python suites, **75/0** (both filed project-scoped under `vidushi`).

- **G1 — `respond` is a run driver, like `run`.** no-mistakes v1.84.0's `axi respond` sends the
  decision, then blocks until the next gate, CI-ready point or outcome (`--wait`, default 8m), and
  prints a snapshot. So `gate-respond` is `gate-run` with a different argv: the same ladder stream
  (`stream_axi_ladder`), the same seal-or-held exit (`gate_from_axi`, `unsealed_run_report`) and
  the same envelope. The shared runner inside `cmd_gate_run` is factored out once and both verbs
  use it; nothing is copied.
- **G2 — `respond`'s real flags.** `--action approve|fix|skip` (required), `--findings <id,…>`,
  `--add-finding <JSON finding object>` (ONE JSON object, not free text, and not repeatable),
  `--instructions`, `--reason` (an exception reason kept with a Test approval), `--step` (default:
  the step awaiting approval), `--wait`, and `--yes` (auto-resolve later gates). §S1 is corrected:
  `--add-finding` takes one JSON object; `--reason` and `--step` pass through and are recorded.
- **G3 — `--yes` would hide decisions.** It lets no-mistakes resolve later gates itself, so
  those decisions would never reach Crucible, which is what this CR exists to prevent.
  `gate-respond` does not offer `--yes`.
- **G4 — a decision is not a gate snapshot, and it must outlive one.** `POST /api/v2/gates`
  (`handleGates`) requires `outcome` and `steps`, and interim gates are not retention-protected,
  so riding a decision on an interim snapshot would lose it. A decision is its own record: the
  no-mistakes run id, step, action, the finding ids selected, the added finding, instructions,
  reason, agent, cycle binding and time. It needs a new table (a declared migration to schema v15)
  and a route beside `/gates`, with the same registered-caller and cycle-stamping rules.
- **G5 — the run id ties them together.** Today a gate event does not carry the no-mistakes run id,
  although every `axi` snapshot has `run.id`. Gate events gain `runId`, and the gate read returns
  its run's decisions, so the drill-in has nothing to join.
- **G6 — when a decision counts as made.** A `respond` refused by no-mistakes (an error envelope,
  or a non-zero exit with no snapshot) records nothing (AC5). A respond accepted, whose wait then
  elapses, still records its decision: an elapsed wait is not a failed run.
- **G7 — the drill-in is F8½ plus decision rows.** The decisions list sits beneath the step
  ladder, in order, in both places `gateBodyContent` renders (the gate drill-in and the
  Workflow-tab gate widget). There is no storyboard frame for it: **frame F21 is drawn for the
  user's approval before RED.**
- **Cost.** 8 points, unchanged: the shared runner, the verb in five clients, the decision record
  (table, migration, route, read), the drill-in rows, and the frame.

## Scope

### §S1 — `gate-respond`

Every client gains `gate-respond --agent <id> --action approve|fix|skip [--findings <id,…>]
[--add-finding <JSON finding object>] [--instructions <text>] [--reason <text>] [--step <step>]
[--wait <duration>]` (no `--yes`, G3). It proxies `no-mistakes axi respond` with exactly
those arguments, records the decision on the board as its own record keyed by the no-mistakes run id (G4, G5:
the step, the action, the finding ids it selected, the added finding, the instructions, the reason,
the agent, the cycle and the time), and drives the run as `gate-run` does through the one shared
runner (G1), so its interim and final gate events keep flowing. Gate events carry the run id.

### §S2 — the gate's drill-in shows the decisions

The gate drill-in (F8½) and the Workflow-tab gate widget list the run's recorded decisions, in
order, beneath the step rows, as drawn in frame F21 (to be approved before RED).

## Acceptance criteria

- [ ] `gate-respond` passes its arguments to `axi respond` unchanged, asserted on the argv.
- [ ] Each call records one gate-decision event carrying the action and the exact finding ids selected.
- [ ] After a respond, the client re-attaches and the run's later interim and final events are recorded.
- [ ] The gate drill-in lists the decisions, in a real browser.
- [ ] A failed `axi respond` is reported, and no decision event is recorded for it.
- [ ] **AC6** — gate events carry the no-mistakes run id, and the gate read returns that run's
      decisions; the store migration (v15) adds the decision table and back-fills nothing.
- [ ] **AC7** — `gate-respond` behaves the same in all five clients, offers no `--yes`, and shares
      one runner with `gate-run` (no copied loop).

## Cycles

C1 server: the decision record (table, v15 migration, route, read), `runId` on gate events (AC2
server half, AC6). RED + GREEN.
C2 clients: the shared runner, `gate-respond` in five clients (AC1, AC2, AC3, AC5, AC7). RED + GREEN.
C3 board: the decision rows in the drill-in and widget, per F21 (AC4). RED + GREEN.
C4 VERIFY.
