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

1. **Parallel-agent liveness — the `agents online` COUNT disagrees with the
   highlight rule.** The PROJECT card read a low online count while both agents
   were valid, and one (`-py`) showed "died 6m ago / 0ms" dimmed. Root cause of the
   *dimming*: `-py` genuinely crossed the tombstone window because its runs
   **orphaned** through the stale `~/.claude/scripts/` mirror (its `lastSeen` never
   updated) — an out-of-scope reporting problem (see Notes), NOT the dim rule
   punishing parallels. The per-agent dim rule is in fact correct (a `tombstoned`
   agent dims, that entry only; `online`/`stale` stay highlighted, siblings never
   read). The real in-scope defect is the **`agentsOnline` count**: it counts only
   `liveness === "online"` while the highlight boundary is `tombstoned`, so a
   still-highlighted `stale` agent is not counted — the count disagrees with what
   is highlighted.

2. **`plan-file` does not warn when no title is given.** A plan filed without a
   title is silently untitled; the board then has nothing to show (see defect 3).
   The client should WARN — exactly like the §S3 `no-wave` guard — so the
   orchestrator notices before filing an untitled workflow.

3. **Null-title board fallback shows the ORCHESTRATOR name.** When a plan's title
   is null the workflow card renders the `orchestrator` field (e.g. `vidushi-CRU`)
   as the title. The orchestrator is not the workflow's name; the fallback must be
   the **CR** (always present), never the orchestrator.

## Scope

### §S1 Agent-card liveness — the count reflects the highlighted (non-tombstoned) set
The per-agent dim rule is already correct and MUST be preserved (locked by
regression tests): an agent's highlighted-vs-dimmed state derives ONLY from its own
liveness (`store.livenessOf` on that agent's `lastSeen` silence), independent of
siblings — `online`/`stale` → **highlighted**, `tombstoned` → **dimmed** (that
entry ONLY), regardless of run count or how many agents are concurrently
registered. Parallel agents are all first-class; a "0 runs yet" agent that is alive
stays highlighted; an unregistered-cleanly agent renders per existing lifecycle
(not dimmed-as-dead).

The in-scope fix is the **`agentsOnline` count**: today it counts only
`liveness === "online"` (`src/v2.ts` project summary) while the highlight/dim
boundary is `tombstoned`, so a `stale` (still-highlighted) agent is not counted.
Change the count to the **highlighted set = every non-tombstoned agent**
(`online` + `stale`), so `N agents online` ≡ the number of highlighted agent rows.
(Pruned agents are already removed from the list, so they never count.)

### §S2 `plan-file` no-title warning (client — all five clients / shared module)
`plan-file` invoked without a resolvable title (`--title` unset) emits a
`no-title` warning — envelope `warnings[]` `{code:"no-title", detail:"…"}` + a
stderr line naming the CR — mirroring the §S3 `no-wave` guard. The plan still
files (title is optional), but the orchestrator is told, so an untitled workflow
is a deliberate choice, not an accident. Lands in `_crucible_axi.py` + all five
clients' `plan-file` path.

### §S3 Untitled plan renders as its CR — no orchestrator suffix
On the workflow CR-root card (`public/app.js` — currently
`plan.cr` `· <title>?` `— <orchestrator>?`) and any list/roadmap row that titles a
plan: the CR is always the primary identity (already rendered). The
` — <orchestrator>` suffix renders **only when the plan carries a real title**; on
an **untitled** plan (`title` null/undefined) the card renders **just the CR** (with
its cycles), with NO orchestrator suffix — so an untitled workflow reads as its CR,
never as the orchestrator's name. The `orchestrator` field is never the title nor
the sole descriptor of an untitled plan.

## Acceptance criteria
- [ ] Two agents registered concurrently against one project, both alive
      (online/stale) → BOTH render highlighted; the agents-online count == 2.
- [ ] An agent that dies without unregistering (crosses the tombstone window) → its
      entry dims (that entry ONLY); a concurrently-alive sibling stays highlighted.
- [ ] A registered agent that has reported zero runs but is alive → highlighted.
- [ ] The agents-online count == the number of non-tombstoned (highlighted) agent
      rows — a `stale` (highlighted-but-quiet) agent IS counted; only `tombstoned`
      agents are excluded.
- [ ] `plan-file` with no `--title` → `warnings[]` carries `no-title` (+ stderr
      naming the CR); with `--title` → no warning; asserted for all five clients.
- [ ] A plan with `title` null/undefined renders as its CR alone (no
      ` — orchestrator` suffix); a titled plan renders `CR · <title> — <orchestrator>`
      (the orchestrator suffix appears ONLY with a title).

## Notes
- The orphaned RED runs that made this visible came from agents reporting through
  the stale `~/.claude/scripts/` mirror instead of the in-repo `clients/`; that is
  an operational fix (agents use `clients/` during client development; the
  installer populates `~/.claude/scripts` later — CR-009), not part of this CR.
