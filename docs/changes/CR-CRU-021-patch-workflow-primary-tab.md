# CR-CRU-021 — Patch: Workflow as the primary workspace tab

**Status:** PENDING
**Type:** patch
**Priority:** P3
**Depends on:** CR-CRU-020
**Labels:** patch, ui, workspace, tabs
**Phase:** Wave 4 (after 020)
**Design reference:** user direction at the CR-020 gate review 2026-07-16 ("the Workflow should be the primary view in the project specific workspace followed by runs")

## Context
The workspace opens on Runs today. With plans/lens live, the Workflow view is
the project's primary narrative; Runs becomes the second tab.

## Scope

### §S1 Tab order + default
`L.workspaceTabs` order becomes `Workflow · Runs · Coverage · Compile · BDD`;
the workspace's default active tab on entry (badge click, cold `/p/<key>`
load) becomes `Workflow`. The one-rule, tabs-hide, and back-chip naming are
order-agnostic and unchanged; cold `/p/<key>/run/<id>` detail loads keep
their existing behavior (close lands on the pane that hosted the detail —
now Workflow by default for tab-less cold loads).

### §S2 Storyboard sync (user input at filing)
F8 redrawn (done 2026-07-16, leads this CR): tabs `Workflow · Runs · …` with
Workflow active, the landing body showing the Workflow view (active plan +
compact history), and the timeline elements annotated as living on the Runs
tab. Further user inputs to this patch accumulate here before execution.

### §S3 Active-cycle timer (user input 2026-07-16)
Cycle rows carry a live timer: an ACTIVE cycle shows a ticking elapsed time
anchored to its `activatedAt` (server-stamped since CR-011 C4), visibly
updating while it runs; on transition to `done` (or any terminal state) the
timer stops and the row shows the sealed duration (`doneAt − activatedAt`).
Applies to the Workflow active section and history cycle rows alike (history
shows sealed durations). Cycles predating the timestamp migration (no
`activatedAt`) show no timer, never a fabricated value.

### §S4 Group headers carry aggregates, never agent-id rows (user-locked 2026-07-16)
The CR-group header renders NO per-agent rows of any kind — participating
agents appear as an aggregate pill (`N agents`) on the header; per-agent
identity + runtime detail renders only behind the group's expansion
(alongside the cycle rows). Root cause class closed structurally: three
distinct causes (fabricated 0ms rows, lingering gate-agent ghosts, the
original run leak) all manifested as agent-id rows at group level reading as
run entries. CR-011's "participating agents + runtimes" information survives,
one level down.

### §S5 Gate runs bracket their lifecycle (client, formalized by CR-008)
`bun-crucible.py test`/`regression` with `--agent` REGISTERS the agent before
the run and UNREGISTERS it after the final ingest — gate/close-out agents
never linger as online ghosts, and their runtimes seal honestly on the
lifecycle event (CR-CRU-020-CLOSE lingered 38 minutes as `online` — the
gremlin of 2026-07-16). Orchestrator procedure until this lands: unregister
gate agents manually at close-out.

## Acceptance criteria
- [ ] `L.workspaceTabs` returns names exactly `["Workflow","Runs","Coverage","Compile","BDD"]` (both project types; existing enable/disable semantics untouched); tab-list assertions across suites re-targeted under this CR's sanction.
- [ ] Entering a workspace (badge click AND cold `/p/<key>` load) renders the Workflow pane active (`Workflow` tab `on`, `workflow-active` present); selecting Runs still works and the one-rule/tabs-hide behaviors are unchanged (spot re-run of the CR-016/020 binding tests).
- [ ] Cold `/p/<key>/run/<id>`: the detail renders in-pane; closing it lands on the WORKFLOW pane with its tab `on` (the new default), chip text `← workflow`.
- [ ] §S4: a closed CR group's header contains an `N agents` aggregate pill and ZERO elements carrying an agentId; expanding the group reveals the per-agent runtime rows (fleet-registered semantics unchanged); the three historical causes are regression-pinned (fabricated-0ms fixture, lingering-online-agent fixture, linked-run fixture — none may surface an agent-id row at header level).
- [ ] §S5: `bun-crucible.py regression --agent X` against a live server leaves NO agent row in the fleet after exit (register→ingest→unregister bracketed; asserted via the Python client contract harness + a lifecycle-event pair check); `test --agent X` identical; omitted `--agent` unchanged.
- [ ] §S3 timer: an active cycle row renders `data-testid="cycle-timer"` whose text advances across two samples with an injected clock (ticking, anchored to `activatedAt`); PATCHing the cycle `done` seals it — the timer text equals the formatted `doneAt − activatedAt` and no longer advances; a done history cycle row shows the same sealed duration; a cycle with no `activatedAt` renders NO `cycle-timer` element.

## Estimated size
XS.

## Non-goals
Any lens/active-view content changes; home surface changes.
