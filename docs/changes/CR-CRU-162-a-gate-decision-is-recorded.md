# CR-CRU-162 — a gate decision is recorded, not lost in the tool's logs

**Type** feature · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-10-01

## Problem

**Request from Sandesh (#1412, 2026-10-01, during its 0.4.0 release validation).** `gate-run` drives
`no-mistakes axi run` and records the gate's interim and final events (`cmd_gate_run` in
`clients/_crucible_axi.py`). But a gate's **decisions** are taken with `no-mistakes axi respond`
(approve; fix with selected finding ids; `--add-finding`; `--instructions`; skip), which the agent calls
directly, so Crucible never sees them. In Sandesh's release one respond call silently selected 19
findings, and the trail of which findings were fixed, declined or decided by the user exists only in
no-mistakes' own logs.

**Measured 2026-10-01:** no client has a respond verb; `gate-run` proxies `axi run` only.

## Scope

### §S1 — `gate-respond`

Every client gains `gate-respond --agent <id> --action approve|fix|skip [--findings <id,…>]
[--add-finding <text>]… [--instructions <text>]`. It proxies `no-mistakes axi respond` with exactly
those arguments, records the decision as a gate event on the board (the action, the finding ids it
selected, any added findings and the instructions, the agent and the time), then re-attaches to the
run as `gate-run` does, so its interim and final events keep flowing.

### §S2 — the gate's drill-in shows the decisions

The gate drill-in (F8½) lists each recorded decision in order beneath the step rows.

## Acceptance criteria

- [ ] `gate-respond` passes its arguments to `axi respond` unchanged, asserted on the argv.
- [ ] Each call records one gate-decision event carrying the action and the exact finding ids selected.
- [ ] After a respond, the client re-attaches and the run's later interim and final events are recorded.
- [ ] The gate drill-in lists the decisions, in a real browser.
- [ ] A failed `axi respond` is reported, and no decision event is recorded for it.
