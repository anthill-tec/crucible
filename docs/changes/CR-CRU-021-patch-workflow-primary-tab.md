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
load) becomes `Workflow`. (CR-CRU-014 adds a sixth `Roadmap` tab in 0.2.0 —
user-locked 2026-07-16; that re-target is sanctioned there, not here.) The one-rule, tabs-hide, and back-chip naming are
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

### §S6 F13 look-and-feel EXACT fidelity (user-ordered 2026-07-16: "I like this look. Implement EXACTLY the same in UI")
The Workflow tab's entry formatting matches the F13 mock VERBATIM (the mock
is the contract; the shipped UI drifted). The exact formats:
1. Active section header: `Active workflow — <cr> · <track> · wave <n>`
   (track segment omitted when absent — solo model), in the ember section
   header treatment.
2. Cycle rows: `<glyph> cycle <n> · "<label>" · <status>` — the label QUOTED,
   glyph colored per status (✓ pass-green / ▶ ember / ○ faint / ⊘ / ✗), the
   ACTIVE row bold. Status narration where data allows: done cycles read
   `done — GREEN confirmed` (+ ` by <orchestrator>` when the plan carries an
   orchestrator identity — additive plan field, optional); verify-kind done
   reads `done — report accepted`.
3. The ACTIVE cycle's open span renders its linked runs INLINE on one row:
   `🧪 <agent> <ratio> · 🧪 <agent> <ratio> · awaiting orchestrator confirm`
   (ratio colored pass/fail; the annotation dims).
4. Pending verify cycles carry the small `verify` kind badge inline (mock
   form), not a separate treatment.
5. History header: `History — Wave <n> · lanes: <chips> · <state>` — wave +
   lane chips + boundary state INLINE in the header line (not separate rows).
6. History rows: `▸ [<track> › ]<cr> · <n> cycles ✓ · merged <sha>` — inline
   text form (dim), not pill-chips; expanded form keeps the CR-020 toggle
   contract.
7. GLYPH-ONLY coloring: status color applies to the GLYPH alone (✓/▶/○/⊘/✗);
   row text stays default ink (the live UI wrongly colors whole rows).
8. Collapsed cycle rows carry a run-count hint: `▸ N runs`.
9. Merge wording exactly `merged <sha>` (no `@`).
10. The pane renders NO extra `WORKFLOW — <project>` rail-title above the
    active header (the mock's header structure is the whole top).
RULED (a) — user-locked 2026-07-16: "Mock wins on active cycle, the toggle
contract narrows to History." The ACTIVE cycle's open span renders its
linked runs ALWAYS inline (no toggle to reveal them); CR-020 §S2.3's
expand/collapse toggle applies to HISTORY cycle rows only (annotated there);
run drill-down parity is unchanged (any run entry, active or history, swaps
to the detail). CR-020's active-cycle toggle assertions re-target under
THIS CR's sanction at its RED.
Colors/typography: the mock's exact classes translate to the app's
equivalents (mono 10.5px-scale lines, dim annotations, ember accents) —
side-by-side comparison against the F13 frame is the review gate. Run-entry
icons follow the CR-007 mask-icon system (the mock's 🧪 emoji predates it —
mock to be touched up at execution).

## Acceptance criteria
- [ ] `L.workspaceTabs` returns names exactly `["Workflow","Runs","Coverage","Compile","BDD"]` (both project types; existing enable/disable semantics untouched); tab-list assertions across suites re-targeted under this CR's sanction.
- [ ] Entering a workspace (badge click AND cold `/p/<key>` load) renders the Workflow pane active (`Workflow` tab `on`, `workflow-active` present); selecting Runs still works and the one-rule/tabs-hide behaviors are unchanged (spot re-run of the CR-016/020 binding tests).
- [ ] Cold `/p/<key>/run/<id>`: the detail renders in-pane; closing it lands on the WORKFLOW pane with its tab `on` (the new default), chip text `← workflow`.
- [ ] §S6: with a plan fixture matching the F13 mock (cr, track-1, wave 1, three cycles — done red-green with label "checkpoint persistence", active with two linked runs fail 2/5 + pass 5/5, pending verify), the Workflow active section renders the EXACT strings: header `Active workflow — CR-NAI-042 · track-1 · wave 1`; rows `✓ cycle 1 · "checkpoint persistence" · done — GREEN confirmed`, `▶ cycle 2 · "compile fallback" · ACTIVE` (bold, ember) with the inline span row `🧪 CR-NAI-042-RED 2/5 · 🧪 CR-NAI-042-GREEN 5/5 · awaiting orchestrator confirm`, `○ cycle 3 · "verify sweep" [verify] · pending`; the history header renders `History — Wave 1 · lanes: track-1 ✓ · track-2 1/2 · awaiting review` inline and a collapsed row `▸ track-1 › CR-NAI-041 · 3 cycles ✓ · merged e41d2aa` (glyph/color classes asserted alongside the strings).
- [ ] §S4: a closed CR group's header contains an `N agents` aggregate pill and ZERO elements carrying an agentId; expanding the group reveals the per-agent runtime rows (fleet-registered semantics unchanged); the three historical causes are regression-pinned (fabricated-0ms fixture, lingering-online-agent fixture, linked-run fixture — none may surface an agent-id row at header level).
- [ ] §S5: `bun-crucible.py regression --agent X` against a live server leaves NO agent row in the fleet after exit (register→ingest→unregister bracketed; asserted via the Python client contract harness + a lifecycle-event pair check); `test --agent X` identical; omitted `--agent` unchanged.
- [ ] §S3 timer: an active cycle row renders `data-testid="cycle-timer"` whose text advances across two samples with an injected clock (ticking, anchored to `activatedAt`); PATCHing the cycle `done` seals it — the timer text equals the formatted `doneAt − activatedAt` and no longer advances; a done history cycle row shows the same sealed duration; a cycle with no `activatedAt` renders NO `cycle-timer` element.

## Estimated size
XS.

## Non-goals
Any lens/active-view content changes; home surface changes.
