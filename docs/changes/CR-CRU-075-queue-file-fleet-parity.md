# CR-CRU-075 — queue-file fleet parity + AXI verb-surface census enforcement

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 014, 091
- **Status**: PENDING (0.2.0) — moved into 0.2.0 by user direction 2026-08-28 — re-sequenced 2026-08-28 behind CR-091: parity is done once, on the final verb surface

## Problem

CR-CRU-014 §S2 shipped the `queue-file` verb — the client action that registers
a project's CR backlog and thereby drives the Roadmap tab — on
`clients/python-crucible.py` only. Every other orchestrator/workflow verb is
fleet-wide:

```
plan-file · milestone · cycle-activate · cr-close   → all 5 clients
queue-file                                          → python only
```

`queue-file` is a **design-phase, recurring** verb. The Roadmap (CR queue) is
registered up front, before any workflow starts, and is re-registered on any
backlog change — a NEW CR added, or an EXISTING CR refactored/re-scoped (its
title, wave, or depends-on changing). This release is the example: CR-068…075
were all added mid-wave as gap analyses surfaced needs. Each run is a
full-replace (CR-014's POST is full-replace; CR-022 §S2 archives the prior
snapshot for scope-change history). Because it runs at design time and on every
revision — potentially from any stack's orchestrator, before a single test has
run — it must be present on every client, not just python.

The five stack clients (arduino, bun, mvn, python, rust) all import the shared
`clients/_crucible_axi.py`, which already contains the AXI-compliant
`cmd_queue_file` + `parse_queue_table`. Only python-crucible.py wired the
subparser, so the shared logic is fleet-available but the verb surface is not.

This is an **AXI conformance gap** (axi.md principle 6 — structured errors): an
orchestrator on the rust/java/arduino/bun stack that runs `<client> queue-file`
gets argparse's raw `error: invalid choice: 'queue-file'` / `SystemExit(2)` — a
bare crash, not a TOON-AXI envelope. The verb should be uniformly present and
every invocation should return a structured envelope.

The reason it slipped past the guardrail: the fleet verb-surface census
(`tests/client/test_cr054_fleet_inventory.py`, the frozen `THE_42` set) predates
`queue-file`, so nothing enforces parity for verbs added after CR-054.

## Scope

### §S1 Fleet parity
Expose `queue-file` on all five `*-crucible.py` clients — a thin wrapper
delegating to the shared `_crucible_axi.cmd_queue_file` plus the argparse
subparser, byte-mirroring how `plan-file` is wired in each client. No change to
the shared parser or to the endpoint. Every client's `queue-file` returns a
TOON-AXI envelope on success AND on every failure path (malformed row,
unreadable file), exactly as python-crucible.py already does.

### §S2 Census enforcement
Extend the fleet inventory so verb parity is enforced going forward, not frozen
at the CR-054 snapshot: add `cmd_queue_file` to the fleet function set
(`THE_42` → the new count) in `tests/client/test_cr054_fleet_inventory.py`, and
to any verb-surface/census assertion that enumerates the shared workflow verbs.
A future fleet verb missing from a client must fail this census.

### §S3 Intimate Model B
Post a Sandesh note to Model B that `queue-file` is now a fleet-wide client verb
(the standing client-change contract: any verb/flag/envelope/endpoint that ships
is announced on the thread).

## Acceptance criteria

**AC1 — `queue-file` is on every client.** Each of arduino/bun/mvn/python/rust
`-crucible.py` exposes `queue-file`; invoking it parses the queue table and
POSTs to `/api/v2/projects/<key>/queue`, returning a TOON-AXI envelope. Asserted
per client, not just python.

**AC2 — failure is structured on every client.** A malformed row or unreadable
source through any client's `queue-file` exits non-zero with a TOON-AXI
`{ok:false, error}` envelope and a `help[]`, never a raw argparse/stacktrace
crash (axi.md principle 6).

**AC3 — the census enforces parity.** `test_cr054_fleet_inventory` (and the
verb-surface census) include `cmd_queue_file`; removing `queue-file` from any one
client fails the census. The frozen count is updated with a comment explaining
the new member.

**AC4 — behaviour unchanged.** The shared `cmd_queue_file` / `parse_queue_table`
and the `/queue` endpoint are untouched; CR-014's `queue-file` tests still pass
byte-unchanged. This is additive wiring, not a re-implementation.

**AC5 — Model B intimated.** A Sandesh message records the new fleet verb.

## Non-goals
- No change to the queue API, the parser, or the Roadmap UI.
- No new verbs; this is parity for the one CR-014 shipped.
- Queue-revision history / snapshots (CR-022 §S2 owns that); this CR only makes
  the registration verb uniform across the fleet.

## Notes
- Raised 2026-08-20: the maintainer asked whether the client scripts were
  updated to match the Roadmap creation, and whether the fleet uses the AXI
  standard. It does — the gap is purely that `queue-file`'s subparser was wired
  on one client, and the post-CR-054 census never enforced parity.
- Roadmap lifecycle (maintainer, same day): the Roadmap is created at project
  design time before the workflow starts, and updated whenever a NEW CR is added
  or an EXISTING CR is refactored/re-scoped — each a full-replace `queue-file`
  run. `queue-file` is therefore an up-front AND recurring any-stack orchestrator
  action, which is why fleet parity is a correctness requirement, not a nicety.
