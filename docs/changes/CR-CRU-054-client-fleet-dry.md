# CR-CRU-054 — The client fleet is 44 functions copy-pasted five times

**Status:** PENDING
**Type:** maintenance (structural — deduplication)
**Priority:** P1 — not a defect in itself; it is the multiplier that has made every recent client CR cost 5× and miss sites
**Depends on:** CR-CRU-030 (created `clients/_crucible_axi.py`, the shared module this CR finishes the job of)
**Labels:** maintenance, client-fleet, dry, refactor, axi-compliance
**Phase:** Wave 4
**Design reference:** CR-CRU-030 §S1 introduced `clients/_crucible_axi.py` as the fleet's shared
module — *"the 5 clients don't currently share code; user decision"*. Filed 2026-07-28 after the
user asked, during CR-CRU-044 C4, *"Havent you heard about DRY?"*

## Context
Measured on `develop` at 2026-07-28:

| | |
|---|---|
| functions defined in **all five** clients | **44** |
| functions defined in **four or more** | 50 |
| functions in the shared `_crucible_axi.py` | 19 |
| names present in BOTH a client and the shared module | **1** (`_toon`) |
| total client lines | 9,355 (`bun` 2042, `rust` 2461, `mvn` 1941, `python` 1612, `arduino` 1299) |

The shared module exists but the fleet is barely consolidated. The 44 include the entire HTTP
layer and most of the verb surface: `_post`, `_get`, `_patch`, `_request`, `_project_key`,
`_run_context`, `_ingest_context`, `_emit_axi`, `_emit_ingest_withhold`, `_resolve_plan_or_emit`,
`_resolve_ingest_cycle`, `_register_cycle_guard`, `_remove_agent_silent`, `_post_gate`,
`_post_milestone`, `_open_plans`, `_plans_path`, `_plans_response`, `_cycle_transition`, `_toon`,
`main`, `cmd_status`, `cmd_test`, `cmd_stop`, `cmd_unregister`, …

**This is the multiplier behind the recent CR history, not an aesthetic complaint.** Every
client-touching change costs 5× and gets five chances to miss a site:

- **CR-CRU-050** — one JUnit parse bug, fixed in 5 places (rust had **two** sites; the second was
  the pre-merge-gate path a partial fix would have left blind).
- **CR-CRU-044 §S3** — one `--phase` flag, hardened in 5 places. The five had **drifted apart**:
  bun/rust/mvn enum-constrained, python free-text, arduino neither constrained nor required.
- **CR-CRU-044 §S5** — one `_agent_id()` fallback, deleted from 5 places. `grep -c "def _agent_id"`
  → 5 copies, **0 in the shared module**.
- **CR-CRU-051** — one `files` envelope key, to be added to 4 clients.
- **CR-CRU-049** — mvn's narrator unaudited for a defect class already fixed in bun's copy.

Drift is the real cost. `mvn-crucible.py:641` classified `<skipped/>` correctly for months while the
other four counted skips as passes; nothing could detect the divergence because there was no single
definition to diverge *from*.

## Scope

### §S1 — Inventory and classify the 44
Produce the list and mark each: **SHARED** (identical semantics, lifts as-is), **PARAMETERISED**
(same shape, per-client constants such as the tool name or report path — lifts with an argument),
or **GENUINELY PER-CLIENT** (real runner differences: `_parse_junit` shapes, coverage collectors,
toolchain invocation). **The classification is the deliverable of this section** — do not begin
moving code before it exists and is recorded. A function assumed SHARED that is quietly
PARAMETERISED is how a fleet-wide regression gets introduced.

### §S2 — Lift the SHARED and PARAMETERISED sets into `_crucible_axi.py`
Clients delegate; no client keeps a private copy of a lifted function.

**Binding constraint — the shared module must stay stdlib-only.** `clients/*-crucible.py` are
vendored into consumer repos and load `_crucible_axi.py` **by file path**; a third-party import
would break every consumer. Follow the delegation pattern the clients already use for the module's
existing 19 functions.

### §S3 — A drift guard
Add a test asserting no function name is defined in more than one client unless it is on an
explicit, justified per-client allow-list (the §S1 GENUINELY-PER-CLIENT set). Without this the
fleet re-diverges the first time someone copies a helper, and the whole exercise is undone by
attrition.

### §S4 — Behaviour is unchanged
This is a refactor. Every existing client test must pass **unmodified**. Any test needing a change
to accommodate the move is evidence the move changed behaviour — stop and reassess rather than
editing the test.

## Acceptance criteria
- [ ] The §S1 inventory exists, with all 44 classified and per-client differences named.
- [ ] Every SHARED/PARAMETERISED function is defined ONCE, in `_crucible_axi.py`; no client retains
      a private copy — asserted by the §S3 guard.
- [ ] `_crucible_axi.py` remains stdlib-only — asserted (no third-party import).
- [ ] The §S3 drift guard fails when a duplicate is reintroduced — proven by adding one temporarily.
- [ ] **Every pre-existing client test passes UNMODIFIED.** Not one assertion changed.
- [ ] Total client line count materially reduced; before/after recorded.
- [ ] Full bun regression green AND full Python regression green (client change → both gates, per
      CR-CRU-045 §S3).

## Non-goals
- Merging the five clients into one. They are separate deliberately: each is vendored standalone
  into a repo of its own stack.
- Changing any client's CLI surface, verbs, flags or output.
- `toon.py` — CR-CRU-046 replaces it with the official library; leave it alone here.
- The genuinely per-client logic (`_parse_junit` shapes, coverage collectors, toolchain calls).

## Risk
- **This is the highest-blast-radius refactor in the project**: it touches all five vendored clients
  at once, and they are the tools every other project's gate depends on. §S4's unmodified-tests
  rule is the safety line.
- A PARAMETERISED function misread as SHARED introduces a silent fleet-wide regression. §S1's
  classification exists to prevent it; do not skip to §S2.
- Sequence AFTER the in-flight client CRs (CR-CRU-044, then 049/051) — landing this mid-flight would
  conflict with every one of them. Equally, the longer it waits the more 5× fixes accrue.
- `clients/*-crucible.py` are COPIED into consumer repos. Confirm how vendored copies resolve
  `_crucible_axi.py` before changing what it exports, or consumers break on their next sync.
