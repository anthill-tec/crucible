# CR-CRU-075 — queue-file fleet parity + AXI verb-surface census enforcement

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 014, 091, 092, 095
- **Status**: PENDING (0.2.0) — moved into 0.2.0 by user direction 2026-08-28 — re-sequenced 2026-08-28 behind CR-091 **and CR-092**: parity and the census are done once, on the final verb surface, and 092's `next` is part of that surface — extended 2026-08-29 to CR-095 for the SAME reason: 095 changes that surface again (it widens the `defaulted-seq` warning `queue-file` itself emits, and changes what `next` answers), so porting to four clients ahead of it would mean reworking all five

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

### §S2 Census enforcement — on the FINAL verb surface, all six new verbs

Two harnesses enforce two different things, and this CR is where both stop being
frozen at the CR-054 snapshot:

| Harness | Enforces |
|---|---|
| `tests/client/test_cr054_fleet_inventory.py` | verb/function **presence** — the frozen `THE_42` set, hard-asserted to contain exactly 42 names (`:128-130`) |
| `tests/client/test_client_fleet_envelope_census.py` | **envelope** conformance — CR-058's detector, that every verb in every client emits a real TOON-AXI envelope |

This release adds **six new verbs** and promotes a seventh existing one, so the
frozen set gains **seven names** and the count moves once, here:

- `queue_file` — not a new verb, but new to the FLEET set: it exists today on
  python only, and this CR's §S1 is what makes it fleet-wide and therefore
  countable. This is why the set gains seven while only six verbs are new.
- `release_propose`, `cr_plan`, `wave_sequence`, `cr_supersede`, `cr_void` — CR-CRU-091 §S3.
- `next` — CR-CRU-092.

`THE_42` becomes **`THE_49`** — **42 + 7**, renamed rather than silently
re-pointed so the name never lies about its own count again, with a comment
naming each new member and its CR. The classification partition (`:123-163`) is
extended so every new name lands in a category — an unclassified name fails the
partition assertion, which is the guardrail working.

**What CR-CRU-091 C3 already built for this, and what it deliberately did not.**
091 did NOT touch `THE_42`: its count is CR-054's own measurement and is
load-bearing for that file's partition arithmetic (four category counts summing
to 42), so moving it there would have claimed this CR's number early and split
one renumbering across two CRs. Instead C3 added two SEPARATE frozen sets —
`CR091_ROADMAP_VERB_FUNCTIONS` and `CR091_ROADMAP_VERBS` (five names each) —
checked by the same `_defined_in_every_client` / duplicate-definition machinery
and asserted **disjoint** from `THE_42`, so neither fixture can absorb the other.
This CR collapses all three sets into the one re-frozen `THE_49`; the disjointness
assertion is what proves the collapse loses nothing.

**Why this CR waits for both.** A census frozen before `next` exists would either
break the moment CR-092 lands or force 092 to edit the same frozen count — two
CRs writing one number is a merge conflict and defeats "enforced going forward".
Sequencing behind 091 and 092 is what makes the count correct once.
A future fleet verb missing from a client must fail this census.

**The census enforces the whole standard, not just presence.** The AXI surface each
verb must satisfy is defined ONCE, in CR-CRU-091 §S10 (the P1–P10 table mapping every
principle to the fleet mechanism that satisfies it) — this CR does not restate it, so the
two documents cannot drift. A verb present in the inventory but emitting prose, JSON, or
errors on stderr fails the envelope census; a verb whose `--help` omits it fails P10.
Conformance is the standing fleet requirement (2026-07-21), which is why enforcement lives
in a census rather than in each verb's own tests.

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

**AC3 — the census enforces parity on all six new verbs.** `THE_49` in
`tests/client/test_cr054_fleet_inventory.py` contains `cmd_queue_file` plus
CR-091's five (`release_propose`, `cr_plan`, `wave_sequence`, `cr_supersede`,
`cr_void`) and CR-092's `next`; the count assertion reads 49 and the
classification partition still covers every name. Removing **any** of the six
from **any** one client fails the inventory census, and a verb whose envelope is
absent or malformed fails `tests/client/test_client_fleet_envelope_census.py` —
presence and conformance are separately asserted, because a wired subparser that
emits prose is still a conformance failure. The count carries a comment naming
each new member and its CR.

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
