# CR-CRU-075 — queue-file fleet parity + AXI verb-surface census enforcement

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 014, 091, 092, 095
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/changes/CR-CRU-091-roadmap-registration-is-declared.md` §S10 — the P1–P10 table mapping each AXI principle to the fleet mechanism that satisfies it. Structured errors on stdout (principle 6) are defined in `CR-CRU-030` §S13.

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

Expose `queue-file` on all five `*-crucible.py` clients: a thin per-client
delegator to the shared `_crucible_axi.cmd_queue_file`, registered through a
shared registrar `add_queue_file_verb` in `clients/_crucible_axi.py` — the shape
every verb added since CR-091 uses (`add_roadmap_verbs`, `add_next_verb`,
`add_cr_depends_verb`), and the shape the sibling census sections already
enforce with "no client hand-rolls the subparser".

`clients/python-crucible.py` hand-rolls its `queue-file` subparser today. It
migrates to the shared registrar, so all five register identically and no client
is the exception. The shared `cmd_queue_file` / `parse_queue_table` bodies and
the `/queue` endpoint are untouched.

Every client's `queue-file` returns a TOON-AXI envelope on success AND on every
failure path (malformed row, unreadable file), as python does today.

### §S2 Census enforcement — parity that stays enforced without a frozen count

Two harnesses enforce two different things:

| Harness | Enforces |
|---|---|
| `tests/client/test_cr054_fleet_inventory.py` | verb/function **presence** across all five clients |
| `tests/client/test_client_fleet_envelope_census.py` | **envelope** conformance — CR-058's detector, that every verb in every client emits a real TOON-AXI envelope |

`queue_file` joins the inventory as its OWN frozen set —
`CR075_QUEUE_FILE_VERB_FUNCTIONS` / `CR075_QUEUE_FILE_VERBS` — checked by the
same `_defined_in_every_client` / duplicate-definition / shared-registrar /
no-hand-rolled-subparser machinery, and asserted disjoint from every earlier
set. This is the shape CR-091 §S3, CR-092 §S6 and CR-106 §S1 each used, and it
is what those three sections' comments prescribe.

`THE_42` and its four-category partition are NOT touched. Those categories are
CR-054's measured per-name drift verdicts, evidenced in
`docs/research/DN-client-fleet-inventory.md`; classifying a new delegator into
them would assert a measurement nobody made. The count stays CR-054's own.

**The gap this CR actually closes.** A per-CR set still requires someone to add
it, so the post-CR-054 hole — a new fleet verb nobody freezes — stays open. This
CR closes it by DERIVATION instead of by a bigger number: every verb name a
shared registrar in `clients/_crucible_axi.py` registers MUST be wired in all
five clients. The check reads the registrars, so a verb added tomorrow is
enforced the day it lands, with no frozen set to update and no count in any
identifier that can go stale. The four per-CR sets remain as the per-verb
evidence; the derived check is the standing guardrail.

**The census enforces the whole standard, not just presence.** The AXI surface
each verb must satisfy is defined ONCE, in CR-CRU-091 §S10 — this CR does not
restate it, so the two documents cannot drift. A verb present in the inventory
but emitting prose, JSON, or errors on stderr fails the envelope census; a verb
whose `--help` omits it fails P10. Conformance is the standing fleet requirement,
which is why enforcement lives in a census rather than in each verb's own tests.

### §S3 Intimate Model B
Post a Sandesh note to Model B that `queue-file` is now a fleet-wide client verb
(the standing client-change contract: any verb/flag/envelope/endpoint that ships
is announced on the thread).

## Acceptance criteria

**AC1 — `queue-file` is on every client, through the shared registrar.** Each of
arduino/bun/mvn/python/rust `-crucible.py` defines `cmd_queue_file` delegating to
`_crucible_axi.cmd_queue_file`, and registers the `queue-file` verb via
`add_queue_file_verb` — asserted per client, five for five, with the delegator
each client wires named. No client hand-rolls the subparser, python included.
Invoking it parses the queue table, POSTs to `/api/v2/projects/<key>/queue` and
returns a TOON-AXI envelope, asserted per client.

**AC2 — failure is structured on every client.** A malformed row or unreadable
source through any client's `queue-file` exits non-zero with a TOON-AXI
`{ok:false, error}` envelope and a `help[]`, never a raw argparse/stacktrace
crash (AXI principle 6, `CR-CRU-030` §S13). Asserted per client, on both failure
paths.

**AC3 — `queue_file` is frozen in its own set, like every verb since CR-091.**
`tests/client/test_cr054_fleet_inventory.py` gains
`CR075_QUEUE_FILE_VERB_FUNCTIONS = {"cmd_queue_file"}` and
`CR075_QUEUE_FILE_VERBS = ("queue-file",)`, asserted: defined in all five
clients, defined at most once per client, registered by the shared
`add_queue_file_verb` in all five, no client hand-rolling the subparser, and
DISJOINT from `THE_42`, `CR091_ROADMAP_VERB_FUNCTIONS`,
`CR092_NEXT_VERB_FUNCTIONS` and `CR106_DEPENDS_VERB_FUNCTIONS`. Removing
`queue-file` from any ONE client fails this. `THE_42`, its count assertion and
its four-category partition are unchanged — a diff touching them fails this AC.

**AC4 — a fleet verb nobody freezes is still caught.** A derived assertion:
every verb name registered by a shared registrar in `clients/_crucible_axi.py`
is wired in all five clients. The registrar set is READ from the shared module,
not listed in the test, so a verb added after this CR is enforced without
editing any frozen set. Proven by injection, not by construction: with the
registrars as they stand the check passes, and it FAILS when a verb is removed
from one client's registration — including a verb this CR never names.

**AC5 — envelope conformance is separately asserted.** A verb present in the
inventory but emitting prose, JSON, or errors on stderr fails
`tests/client/test_client_fleet_envelope_census.py`; `queue-file` is covered
there for all five clients, on success and on both failure paths. Presence and
conformance are distinct assertions, because a wired subparser that emits prose
is still a conformance failure.

**AC6 — no re-implementation.** `parse_queue_table` is unchanged; so is the
`/queue` endpoint and the POST body `cmd_queue_file` sends; so is its exit-code
behaviour. CR-014's `queue-file` tests (`tests/client/test_queue_file_verb.py`,
7 tests) pass byte-unchanged with that file untouched. This is wiring plus a
registrar, not a rewrite.

The ONE exception, and its reason: `cmd_queue_file`'s two failure paths emit
`{"error": msg}` with no `help[]`, so AC2 is unsatisfiable without adding one —
`ops.emit`'s fifth positional is `warnings`, and the success path already carries
its help inside `result_fields`. AC2 governs: structured errors with an
actionable `help[]` are what this CR exists to enforce. Each of the two gets the
help for ITS failure — the unreadable-source path names the path it tried and
that `--from-file` overrides it; the malformed-row path points at the row it
names. A generic array shared by both, or an echo of the success path's, fails
AC2.

**AC7 — Model B intimated.** A Sandesh message records the new fleet verb.
NOT TEST-VERIFIABLE, and said so deliberately: it is a standing cross-project
obligation (the `intimate-modelb-on-client-changes` contract), recorded as an AC
so close-out does not forget it, not a criterion a suite can assert.

## Risk

Adding a delegator, a registrar call and their comments to four clients moves
the repo-wide `PROSE_CITATIONS.clients` head figure in
`tests/project-namespace-tripwire.test.ts` (672 at this CR's baseline). Re-record
it ONCE, by measurement, as a close-out step — not per cycle. `src` and `public`
are untouched, so their figures must not move.

Guarded `path:line` citations into the client files: exactly one —
`_next_start_help` → `clients/python-crucible.py:1422-1436`, in `test_cr092`'s
`NextBlockCitationsTest`. §S1 migrates python's `queue-file` subparser, which
sits BELOW that block, so it should survive; verify rather than assume, and
re-pin it in this CR if it moves.

Adding a verb to four clients enlarges the envelope census and adds `--help`
drives to CR-CRU-097 §S2/AC2's printed-help test, which CR-CRU-108 §S4 records
as starving when a Chromium suite precedes it in one bun process. Expect the
merge gate to need a re-run; that is the known order-dependence, not this CR.

## Non-goals
- No change to the queue API, the parser, or the Roadmap UI.
- No new verbs; this is parity for the one CR-014 shipped.
- Queue-revision history / snapshots (CR-022 §S2 owns that); this CR only makes
  the registration verb uniform across the fleet.
- No change to `THE_42`, its count, or its four measured drift categories.
- No collapse of the per-CR frozen sets into one count.

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
