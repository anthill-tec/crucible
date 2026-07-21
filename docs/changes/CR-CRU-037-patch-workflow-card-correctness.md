# CR-CRU-037 — Patch: workflow-card correctness (parallel-agent liveness dimming + plan-title guard/fallback)

**Status:** PENDING
**Type:** patch
**Priority:** P2 (board-correctness defects surfaced during CR-036 execution)
**Depends on:** CR-CRU-011 (workflow/agent card rendering), CR-CRU-008 (plan-file client verb)
**Labels:** patch, workflow, agents, ui, client, dx
**Phase:** Wave 4 (0.1.0)

## Context
Surfaced 2026-07-21 while running two **parallel** RED agents against the same
active cycle (a valid, first-class Crucible pattern). Three related defects:

1. **Parallel-agent liveness dimming is wrong.** The PROJECT card de-highlighted
   one of two concurrently-registered, running agents. A registered agent that has
   NOT unregistered must stay highlighted; only an agent that has **died without
   unregistering** should be dimmed — and only that agent's own entry, never a
   sibling. (Observed: `-ts` highlighted "seen just now" while `-py`, equally
   valid, showed "died 6m ago / 0ms" and was dimmed. The `0ms`/orphan artifact
   was a *reporting* problem, but the dimming rule itself must not punish a live
   parallel agent.)

2. **`plan-file` does not warn when no title is given.** A plan filed without a
   title is silently untitled; the board then has nothing to show (see defect 3).
   The client should WARN — exactly like the §S3 `no-wave` guard — so the
   orchestrator notices before filing an untitled workflow.

3. **Null-title board fallback shows the ORCHESTRATOR name.** When a plan's title
   is null the workflow card renders the `orchestrator` field (e.g. `vidushi-CRU`)
   as the title. The orchestrator is not the workflow's name; the fallback must be
   the **CR** (always present), never the orchestrator.

## Scope

### §S1 Agent-card liveness dimming — highlight the living, dim only the dead
The PROJECT/agent card must derive an agent's highlighted-vs-dimmed state ONLY
from liveness, per-agent and independent of siblings:
- **Registered AND alive** (heartbeating / within the agent-inactive window, not
  unregistered) → **highlighted**, whether or not it has reported a run yet, and
  whether or not other agents are concurrently registered. Parallel agents are all
  first-class — none is demoted for being one of several.
- **Died without unregistering** (past the agent-inactive window with no
  unregister) → **dimmed**, that entry ONLY.
- **Unregistered cleanly** → per existing lifecycle rendering (not dimmed-as-dead).
A "0 runs reported yet" state is NOT death — an agent that has registered but not
yet ingested a run stays highlighted while alive. Fix the classification wherever
it lives (server liveness/`online` computation and/or `public/app.js` agent-card
dim class); the `1/N agents online` count must reflect the same rule.

### §S2 `plan-file` no-title warning (client — all five clients / shared module)
`plan-file` invoked without a resolvable title (`--title` unset) emits a
`no-title` warning — envelope `warnings[]` `{code:"no-title", detail:"…"}` + a
stderr line naming the CR — mirroring the §S3 `no-wave` guard. The plan still
files (title is optional), but the orchestrator is told, so an untitled workflow
is a deliberate choice, not an accident. Lands in `_crucible_axi.py` + all five
clients' `plan-file` path.

### §S3 Null-title board fallback → the CR
Where the workflow/plan card resolves its display title, the fallback order is
`title` → **`cr`** → (last resort) a neutral placeholder. The `orchestrator`
field is NEVER used as the title. Applies to the workflow card + any list/roadmap
row that titles a plan.

## Acceptance criteria
- [ ] Two agents registered concurrently against one project, both alive → BOTH
      render highlighted; the `agents online` count == 2.
- [ ] An agent that dies without unregistering (crosses the inactive window) → its
      entry dims; a concurrently-alive sibling stays highlighted.
- [ ] A registered agent that has reported zero runs but is alive → highlighted
      (not dimmed as dead).
- [ ] `plan-file` with no `--title` → `warnings[]` carries `no-title` (+ stderr
      naming the CR); with `--title` → no warning; asserted for all five clients.
- [ ] A plan with `title=null` renders the CR as the workflow-card title (never
      the orchestrator); a titled plan renders its title.

## Notes
- The orphaned RED runs that made this visible came from agents reporting through
  the stale `~/.claude/scripts/` mirror instead of the in-repo `clients/`; that is
  an operational fix (agents use `clients/` during client development; the
  installer populates `~/.claude/scripts` later — CR-009), not part of this CR.
