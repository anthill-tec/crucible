# CR-CRU-035 — Ambient-context session hooks (AXI principle 7) — coordinated Crucible↔Model-B

**Status:** PENDING — **coordinated Crucible↔Model-B.** Crucible builds the core python
scripts (the client `setup` command + the board-state surfacing / interface contract);
once those land, Crucible **intimates Model-B** (via Sandesh — `Mainline - ModelB`,
project key `019f7eb8-8cad-7000-9838-854eca8e7c20`), which owns the session-hook
**templates + generation** (a Model-B harness responsibility). Some responsibilities may
be shared; the exact division is negotiated at the handoff.
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-030 (the fleet AXI client interface — the `status`/§S6 read verb + §S14 content-first that the hook surfaces)
**Labels:** feature, axi, ambient-context, session-hooks, dx, cross-project, model-b-coordination
**Phase:** Wave 4 (0.1.0)
**Design reference:** AXI manifesto principle 7 "Ambient context" (https://axi.md —
"Install into the agent's session hooks or plugin system from an explicit setup command
so that every conversation starts with relevant state already visible — before the agent
takes any action") + user direction 2026-07-21 (split from CR-CRU-030 at gap analysis:
hook install/generation touches the Model-B orchestration harness, so it is a coordinated
effort, not a solo Crucible build).

## Context
AXI principle 7 is the strongest anti-context-loss lever: rather than an orchestrator
having to REMEMBER to read the board, the board state (queue, active cycle, wave,
last-run CR) is surfaced into the agent's session automatically at session start, before
any action. CR-CRU-030 delivers the *write-path* context guards (§S3/§S9) and the
*read-path* verbs (§S6 `status`, §S14 content-first) that make the interface
self-explanatory; this CR closes the loop with the *ambient* path — the state is visible
without the orchestrator asking.

Principle 7 is split from CR-030 because installing into the agent's session hooks is not
a pure-CLI concern: it touches the orchestration harness, whose session-hook mechanics
are a **Model-B** responsibility. So this CR defines the CRUCIBLE core (the `setup`
command + the interface contract the hook consumes) and hands the hook TEMPLATES +
GENERATION to Model-B, coordinated over Sandesh.

## Scope

### §S1 Client `setup` command (Crucible core)
Add a `setup` verb to the shared client (`_crucible_axi.py`, CR-030 §S1) that installs
the ambient-context session hook for the project. `setup` registers a session-start hook
which runs the `status` read verb (CR-030 §S6) and surfaces the board — queue, the single
`status:"active"` cycle, wave, and `lastRunCr` — into the agent's session context BEFORE
the agent takes any action. `setup` returns the §S1 TOON-AXI envelope (install result +
the installed path, `~`-abbreviated) and is IDEMPOTENT (re-running converges, never
double-installs).

### §S2 Interface contract for Model-B (the coordination seam)
Define + document the contract at the Crucible↔Model-B seam: WHAT `setup` invokes and
WHAT the installed hook calls — the `status` envelope shape (CR-030 §S6) is the stable
payload the hook renders at session start. Crucible owns this contract + the `status`
verb; **Model-B owns the hook TEMPLATE format + its generation** (how the hook file is
authored/generated for the Model-B harness). Crucible intimates Model-B once §S1 lands.

### §S3 Coordination protocol
Crucible builds §S1 → **intimates Model-B via Sandesh** (`Mainline - ModelB`) that the
core scripts are ready → Model-B builds §S2's template + generation on its side. The
division of any shared responsibilities is negotiated at that handoff. (Cross-project
Sandesh sending may require the one-time per-project admin grant — flag to the human if
the send is blocked.)

## Acceptance criteria
- [ ] §S1: `setup` installs the session-start ambient-context hook, returns a `toon.py`-decodable envelope carrying `ok` + the installed path (`~`-abbreviated); re-running is idempotent (no duplicate install, `ok:true`).
- [ ] §S1: the installed hook, at session start, surfaces the CR-030 §S6 `status` board (queue with `cr`/`wave`/`status`, the active cycle id/label, `lastRunCr`) into the session BEFORE any agent action.
- [ ] §S2: the Crucible↔Model-B interface contract is documented (what `setup` invokes; the `status` envelope the hook consumes) — Model-B owns the template format + generation; Crucible owns `setup` + `status`.
- [ ] §S3: on §S1 completion, Model-B is intimated via Sandesh with the ready core + the interface contract; the coordination handoff is recorded.

## Estimated size
M (Crucible core: `setup` + the interface contract) + coordinated Model-B work (external
— hook templates + generation, tracked as a Model-B Wave-4 dependency).

## Risk / open questions
- Cross-project coordination dependency: Model-B must build the hook templates +
  generation; the shared-responsibility split is settled at the handoff, not pre-decided
  here.
- Sandesh cross-project sending may need the per-project admin grant (CLI-only, human
  action) — surface to the user if the intimation send is blocked.
- The session-hook mechanism is harness-specific (Model-B); the Crucible core must keep
  the `status` payload harness-agnostic so the contract holds across harnesses.

## Non-goals
The AXI-CLI conventions (those are CR-CRU-030 §S10–§S15); the client verb interface +
the `status` verb itself (CR-CRU-030); Model-B's harness internals and its hook-template
implementation (owned by Model-B).
