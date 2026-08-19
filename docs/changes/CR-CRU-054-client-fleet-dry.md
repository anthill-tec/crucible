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

### Re-measured on `develop` at 2026-08-02 (gap-analysis — the 07-28 figures below are superseded)

| | 2026-07-28 | 2026-08-02 | |
|---|---|---|---|
| functions defined in **all five** clients | 44 | **42** | five deleted by CR-056, three NEW ones added |
| total client lines | 9,355 | **9,831** | **+476 — the fleet GREW** |
| shared `_crucible_axi.py` | 19 fns | 657 lines | grew, but the duplication grew faster |

**The multiplier is not theoretical — it operated during this very session.** CR-CRU-056 deleted
five of the duplicated functions (`_ingest_context`, `_emit_ingest_withhold`,
`_resolve_ingest_cycle`, `_register_cycle_guard`, `_plans_response` — the retired resolver flow)
and then its own C5 fix round introduced **three new five-way duplicates**
(`_open_gate_identity`, `_close_gate_identity`, `_add_gate_cycle_arg`). Net: the client fleet is
476 lines LARGER after a CR whose headline was a deletion. Every fleet-wide change, including the
ones fixing the consequences of duplication, adds more of it.

### The 42, as they stand today
`_abbrev_home _add_gate_cycle_arg _agent_id _axi _axi_context _close_gate_identity cmd_abort
cmd_auto_ingest cmd_check cmd_checkpoint cmd_cr_close cmd_cycle_activate cmd_cycle_add
cmd_cycle_done cmd_dashboard cmd_gate_report cmd_gate_run cmd_milestone cmd_plan_file
cmd_pre_merge_gate cmd_register cmd_status cmd_stop cmd_test cmd_unregister _cycle_transition
_emit_axi _get main _open_gate_identity _open_plans _patch _plans_path _post _post_gate
_post_milestone _project_key _remove_agent_silent _request _resolve_plan_or_emit _run_context
_toon`

### Original context (2026-07-28)
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

### §S1b — SHARED splits in two: ALREADY-DELEGATED vs NEEDS-LIFT (refinement, C3 RED 2026-08-02)
The "42 functions defined in all five clients" headline counts NAMES, not duplicated LOGIC. C3's
RED pass read all five bodies of its nine candidates and found `_axi_context`, `_emit_axi` and
`_agent_id` are **already thin delegators** — the logic has lived in `_crucible_axi.py` since
CR-030/CR-044 §S5, and the local `def` survives only because tests patch it and internal call
sites use the unqualified name. That is the TARGET state, not the problem state.

So SHARED must be read as two sub-categories:
- **ALREADY-DELEGATED** — name present five times, logic shared once. Nothing to do; a
  "single locus" test for these is born green and is not a valid RED.
- **NEEDS-LIFT** — logic genuinely duplicated five times. The real work.

This does not invalidate C1's classification (SHARED is correct for all three); it means the
inventory measures consistency, not remaining work. Each lift cycle establishes its own slice's
sub-category by reading the bodies, and the §S3 drift guard reconciles the DN at the end. The
CR's line-count AC is the honest measure of remaining work — the name count is not.

### §S2b — The DRIFTED eight lift to their CORRECT version (ruling 2026-08-02, after C1's inventory)
C1's classification found a category the original spec did not anticipate: **8 of the 42 have
bodies that should be identical but are not**, and several are latent DEFECTS rather than style
divergence (full verdicts in `docs/research/DN-client-fleet-inventory.md`):

| Function | Correct version | What the others get wrong |
|---|---|---|
| `_request` | **arduino** | the other four raise an uncaught `JSONDecodeError` on an empty response body |
| `cmd_register` / `cmd_unregister` | **arduino** | argparse `required=True` bypasses the fleet's own AXI hard-stop envelope, emitting a bare usage error instead of a structured refusal |
| `cmd_milestone` | **the four** | bun writes its legacy line to stdout — the envelope-purity class CR-046 hit in rust |
| `cmd_plan_file` | **mvn/arduino** | bun never carries `context.cr`; rust/python only on the success path |
| `_remove_agent_silent` / `_close_gate_identity` | **neither** | bun lacks the exception guard; the other four have it but discard the result and report "removed" even on silent failure — the lift must take BOTH the guard and honest reporting |
| `_open_gate_identity` + `cmd_register` | **`claude-md`** — see ruling | `source` split `openclaw` vs `claude-md`; **`openclaw` is not a valid value** |

**Ruling:** each lifts to its correct version — the defects are fixed BY the consolidation, not
filed separately (a defect found by a CR's own analysis belongs to that CR). Where no version is
correct, the lift takes the correct COMBINATION.

**The `source` question, ruled 2026-08-02 (it was not a "pick one"):** the clients' own
documented enum is `--source {claude-md, package-json, git-repo, manual}`. `openclaw` is
**outside it** — rust/mvn/arduino hardcode `"openclaw"` at five sites
(`arduino:357`, `mvn:359,478,539`, `rust:508`), sending an undocumented value that only survives
because the server does not validate the field. So this is a defect, not a naming preference.
**All five clients send `claude-md`** (the enum's member, bun/python's existing default, and the
only value present in the live DB), and the `--source` flag is available uniformly — bun/python's
pattern wins over the hardcode.

**Deferred, NOT absorbed:** the server accepts any `identity.source` string without validating it
against the enum. That is a server-side input-validation gap, a different stack and contract from
this client-refactor CR; folding it in would turn a DRY refactor into a server CR. Recorded in the
queue Notes with evidence for scheduling.

### §S3b — Backlog the guard revealed but does NOT assert on (C5, 2026-08-02)
The §S3 guard's blocking assertion covers **THE_42 only**. A full-fleet sweep found roughly **25
further duplicated names outside the inventory** — docker-compose helpers shared by rust/mvn,
`_parse_junit`/`cmd_compile` shared by mvn/arduino, `_read_env`, `_run_logged` and others. The DN
never classified these, so guarding them would mean inventing per-client verdicts nobody has
reviewed — the scope absorption this CR's own Risk section warns against.

Recorded as backlog, deliberately un-asserted. A future CR inventories and lifts them; the guard's
analyser already handles arbitrary sources, so widening its scope later is a one-line change once
the classification exists.

### §S4 — Behaviour is unchanged, with ONE bounded carve-out
This is a refactor. For the **27 SHARED + 1 PARAMETERISED** functions, every existing client test
must pass **unmodified** — a test needing a change is evidence the move changed behaviour; stop
and reassess rather than editing the test.

**Carve-out, §S2b only:** the 8 DRIFTED functions change behaviour for the clients that were
wrong — that is the point. For those, and ONLY those:
- each correction gets a NEW test pinning the corrected behaviour, per affected client;
- an existing test that pinned the DEFECTIVE behaviour is re-pointed with an inline note naming
  this section and the C1 verdict — never silently;
- the correction is listed in the cycle's report, so the diff is auditable against this table.
A behaviour change outside these 8 is a defect in the lift, not a carve-out.

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
  **RESOLVED 2026-08-02 (gap-analysis): taken BEFORE 049/051.** The stated reason for the ordering
  was mid-flight conflict; neither 049 nor 051 has started (no branch, no plan, nothing in the
  tree), so there is nothing to conflict with. CR-044 landed. The accrual argument now dominates —
  056/057 alone added 476 lines and three new five-way duplicates.

### Possible scope absorption of CR-049 and CR-051 (gap-analysis finding — DO NOT act on unilaterally)
Measured today, both queued client CRs may be substantially absorbed by this one:
- **CR-CRU-051** (propagate the `files` envelope count to the other four clients): `"files"`
  currently appears in **bun only**. If the run-envelope builder lifts as SHARED/PARAMETERISED,
  the other four inherit the key by construction rather than by four hand-edits.
- **CR-CRU-049** (audit mvn narration for the CR-047 defect class): narration exists in **four**
  clients (bun, mvn, python, arduino — not rust). If the narrator lifts, mvn inherits bun's
  hardened, CR-047/055-corrected implementation instead of being audited separately.

Neither CR is closed or narrowed by this finding. Re-run each one's own gap-analysis AFTER this
CR merges and re-scope then, with the user deciding what (if anything) remains. Recording the
observation here so the re-scope is deliberate rather than a surprise.
- `clients/*-crucible.py` are COPIED into consumer repos. Confirm how vendored copies resolve
  `_crucible_axi.py` before changing what it exports, or consumers break on their next sync.
