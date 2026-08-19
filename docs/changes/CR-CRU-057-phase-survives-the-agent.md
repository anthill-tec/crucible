# CR-CRU-057 — Patch: phase must survive the agent — persist it on events, delete the name fallback

**Status:** PENDING
**Type:** patch (server persistence + UI classification)
**Priority:** P1 — completion of CR-CRU-044's contract; without it most of the board still classifies by name
**Depends on:** CR-CRU-044 (phase as required registration data), CR-CRU-011 (lifecycle events)
**Labels:** patch, server, ui, phase, board-integrity
**Phase:** Wave 4
**Design reference:** user ruling 2026-08-01 — CR-CRU-044 as shipped is HALF the contract; backfill
decision (one-time, labeled) user-decided same day.

## Context
CR-CRU-044 made `phase` a required, enum-constrained registration field — but stored it ONLY on
the live `agents` row, and `unregister` deletes that row. No run or lifecycle event carries the
phase. So the moment an agent finishes — the state most of the board is in, most of the time —
classification falls back to `phaseRole(agentId)` NAME parsing: the exact dependency CR-044 was
ordered to kill still does the work for every completed agent.

Exposed live 2026-08-01: `CR-CRU-046-C1-bun-RED-baseline` (an unauthorized stray id) rendered
unclassified in workflow history because its suffix does not parse — proving history
classification is still name-driven end to end.

## Scope

### §S1 — Persist phase at write time
Run ingest and every lifecycle event stamp the registering agent's STORED phase onto the event
row. Schema migration adds `events.phase` (nullable TEXT, enum-checked at write) and
`events.phase_inferred` (INTEGER 0/1) via the CR-CRU-044 `PRAGMA table_info` + `ALTER TABLE`
pattern.

🚨 **RIDE THE EXISTING SEAM (gap-analysis 2026-08-02 — this spec predates CR-CRU-056).**
CR-CRU-056 built exactly the stamping machinery this CR needs: `resolveIngestAttach`
(`src/v2.ts`) already fetches the posting agent's row (`store.getAgent(projectKey, agentId)`)
on EVERY ingest and stamps server-derived data onto the stored event, and CR-056 §S3b
guarantees that row EXISTS (an unregistered ingest is refused, so `agent.phase` is always
available at stamp time — the "what if the agent is gone" case is now impossible by
construction). Extend that ONE seam to carry the phase alongside the cycle; do NOT build a
parallel lookup. Likewise the response echo: CR-056's `attachEcho` is the established
read-back-the-stored-event pattern — extend it rather than adding a second echo path.

### §S2 — Classification reads stored phase only
Workflow card, history lens, timeline — every agent classification for historical/unregistered
agents reads `events.phase`. Live agents keep reading `agents.phase` (CR-044). No render path
receives the agent id as a classification input.

### §S3 — DELETE `phaseRole(agentId)`
The function and every caller are removed. A sweep test grep-asserts its absence so it cannot
return as a "fallback".

**Enumerated surface (gap-analysis 2026-08-02 — unfiltered sweep of `src/ public/ cli/ tests/`):**

| File | What is there | Action |
|---|---|---|
| `public/app-logic.mjs` | the `phaseRole` definition | delete |
| `public/app-logic.d.mts:304` | its type declaration (+ the CR-044 §S2 comment at `:306`) | delete |
| `public/app.js:692-695` | **no direct call** — CR-CRU-044 already re-pointed every call site to `L.agentRole({...})`; only the fallback comment remains | correct the comment; `agentRole` loses its fallback BRANCH |
| `tests/phase-role.test.ts` (~124 lines) | the whole file pins the CR-CRU-007 §S1 naming contract — suffix matching, case-insensitivity, the `verify`-substring rules, negative cases | **retire the file** (its subject ceases to exist) |
| `tests/agent-role.test.ts` | ~15 references: the precedence contract (stored phase beats id), and several tests whose SUBJECT is the fallback (`:109`, `:117`, `:122`, `:303`, `:319`) | re-point: precedence tests survive (stored phase is now the ONLY source); fallback tests retire or become "absent phase → unclassified" |

**Correction to this spec's own framing:** "the function and every caller are removed — server
and `public/` UI" overstated it. `phaseRole` is a CLIENT-side (`public/`) helper only — it never
existed server-side, and CR-044 already removed its direct callers. The real work is the two
`public/` files plus the test retirement/re-pointing above.

### §S4 — One-time LABELED backfill (user-decided)
A migration backfills `events.phase` for pre-existing rows WHERE the agent-id suffix parses to a
valid phase enum member, setting `phase_inferred = 1`. Unparseable ids stay NULL and render
unclassified — no guessing at render time, ever. The backfill executes exactly once at migration;
after it, name parsing exists nowhere in the codebase. The UI renders inferred classifications
visibly distinct (muted `inferred` marker) so backfilled history is never mistaken for declared
data.

## Acceptance criteria
- [ ] `events` schema carries `phase` + `phase_inferred`; a new run ingest and a new lifecycle
      event both stamp the agent's stored phase with `phase_inferred = 0` — asserted.
- [ ] An agent registered RED, then unregistered, still classifies RED in workflow history from
      stored data — asserted (and the `-baseline` failure mode: a stored GREEN phase on an id
      ending `-baseline` classifies GREEN, id ignored).
- [ ] `grep -rn "phaseRole" src/ public/ cli/` finds nothing — sweep-asserted (tests may keep
      retirement-assertion references only, in the CR-CRU-056 `BANNED_NAMES` style).
- [ ] The phase is stamped through CR-CRU-056's EXISTING `resolveIngestAttach` seam, not a
      parallel agent lookup — asserted by the absence of a second `getAgent` call on the ingest
      path (§S1).
- [ ] The ingest response echoes the stamped phase alongside the stamped cycle, via the
      established `attachEcho` read-back (so an agent sees how its own run was classified).
- [ ] Backfill on a fixture DB: parseable-suffix rows gain `phase` + `phase_inferred = 1`;
      unparseable rows stay NULL and render unclassified; running the migration twice is a no-op
      — asserted.
- [ ] The UI distinguishes inferred from declared phase (marker present on backfilled rows only)
      — asserted.
- [ ] Full bun regression green (server + UI change; Python gate additionally if any client file
      is touched, per CR-CRU-045 §S3 — none is expected).

## Non-goals
- Registration-time cycle binding and auto-attach removal — CR-CRU-056.
- Any client-fleet change.

## Risk
- Migration runs against the live dog-food DB — same additive `ALTER TABLE` pattern CR-044
  proved; the backfill is additive and idempotent (asserted by AC).
- The one-time backfill deliberately parses names ONCE, at migration, labeled — the ACs pin that
  no render-time or write-time path ever does.
