# CR-CRU-059 — The registration identity contract: rename `phase` → `role` fleet-wide, and validate `identity.source`

**Status:** PENDING
**Type:** patch (naming correction + server input validation)
**Priority:** P1 — the API contradicts the project's own ontology, and a documented enum is unenforced
**Depends on:** CR-CRU-044 (introduced the field), CR-CRU-054 (found the source drift), CR-CRU-056 (registration is now the binding act), CR-CRU-057 (put the field on events)
**Labels:** patch, server, client-fleet, naming, validation, identity, ontology
**Phase:** Wave 4

> **Two changes, one surface.** Both land on `handleAgentTouch`, `src/types.ts`, the five clients'
> `register` verb and the agents/events schema — doing them separately would mean two migrations,
> two fleet edits and two Model-B intimations over the same code. Folded on user direction
> 2026-08-02.
**Design reference:** CR-CRU-044 §S1 — the identical field-shaped problem, solved. `phase` is validated
against `AGENT_PHASES` at the route boundary and refused with a 409 + state-derived `help[]`.
`identity.source` sits in the same object, on the same route, and never received the same treatment.

## Context
Every client documents the enum in its own CLI:

```
--source {claude-md,package-json,git-repo,manual}
```

argparse enforces it, so a human cannot type an invalid value. But the server accepts anything —
`src/v2.ts:485` is the entire handling:

```ts
if (typeof body.identity === "object" && body.identity !== null) {
  opts.identity = body.identity as AgentIdentity;
}
```

That is a type ASSERTION, not a check, and `AgentIdentity.source` is typed `string?`
(`src/types.ts:29-33`) — any string at all. So `openclaw`, `banana`, `""` or a 10 KB blob all
store cleanly.

**This was not hypothetical.** CR-CRU-054's inventory found rust, mvn and arduino building the
register payload directly (bypassing their own argparse) with a hardcoded `source: "openclaw"` at
five sites — a value outside their own documented enum. It had been shipping undetected because
nothing downstream objects. CR-054 fixed the client half; the server half is this CR.

**The contrast is the argument.** The line immediately below the identity passthrough validates
`phase` against its enum and 409s on a miss, because CR-CRU-044 made it so. Two fields, same
object, same route, same kind of contract — one enforced, one free text.

## Context B — `phase` contradicts the project's own ontology (user-raised 2026-08-02)

`docs/research/DN-model-b-language.md` §1 is the locked actor ontology (round 25/31,
user-directed). Its table's column header is **Role**, and the row reads:

| Role | Scope |
|---|---|
| **RED / GREEN / VERIFY / FIX** | one **phase** of one cycle |

So in the ontology: **role** is what an agent IS; **phase** is merely the SCOPE it acts in — one
phase of one cycle. RED/GREEN/VERIFY/FIX are **roles**.

CR-CRU-044 then named the CLI flag `--phase`, the enum `AGENT_PHASES`, and the stored column
`phase` — taking the **scope** word for the field that carries the **role**. CR-CRU-007 had
already compounded both in `phaseRole(agentId)` (since deleted by CR-057). Meanwhile the UI got
it right all along: `public/app-logic.mjs` exposes **`agentRole()`**, and `wave` remains cleanly
separate (it groups CRs; it is the wave-boundary synchronisation concept, unrelated to either).

**The ontology is the contract; the API must move to it, not the reverse.** The user raised this
directly: *"I had used the term role for agents… I've never used [phase]."* They are right on the
record — the DN says Role.

## Scope

### §S0 — Rename `phase` → `role` across the whole surface
Measured surface (2026-08-02): `--phase` in all five clients (1 site each) + the shared module;
`AGENT_PHASES`/`AgentPhase` in `src/types.ts` (4), `src/v2.ts` (8), `src/store.ts` (10); the
`agents.phase` column; and `events.phase` + `events.phase_inferred` (added by CR-057 today).

- CLI: `--phase` → `--role`; enum values (`RED|GREEN|FIX|VERIFY|ORCHESTRATOR|report`) unchanged.
- Wire: the register/heartbeat body field `phase` → `role`.
- Server: `AGENT_PHASES` → `AGENT_ROLES`, `AgentPhase` → `AgentRole`, all validation/error text.
- Storage: `agents.phase` → `agents.role`; `events.phase`/`events.phase_inferred` →
  `events.role`/`events.role_inferred`, via the established `PRAGMA table_info` + `ALTER TABLE`
  migration pattern. 🚨 **Migrate the live dog-food data** — re-measured 2026-08-02: **299 of 338
  events carry a classification** (CR-057 backfilled 283; today's runs added declared ones). That
  data must survive the rename, not be dropped and re-derived.
- UI: `PhaseRole` → `AgentRole`; `agentRole()` already correct, keep it.
- Error/help text: every message naming "phase" says "role" (CR-048 state-derived help included).

**Compatibility ruling — USER-DECIDED 2026-08-02: CLEAN BREAK, and the MERGE IS HELD.** The server
accepts `role` only; no `phase` alias, no dual-key handling, no deprecation path. Consequently:

🚧 **MERGE GATE — LIFTED 2026-08-02 by the bundling strategy change.** The gate assumed Model-B
VENDORS our client scripts, so a wire rename would break their copy. Under the user's new model
that premise is gone: **Crucible bundles the server AND the clients together** as one matched,
locally-deployable artifact (the CR-CRU-041 composite-lockstep machinery becomes the primary
delivery model), and **Model-B owns only the SKILLS** that reference Crucible's capabilities.
A rename that moves both halves of our own bundle in lockstep is internally consistent and breaks
nothing they hold.

What Model-B still needs is the CAPABILITY change — `--phase` becomes `--role` in the verb surface
their skills document — and that rides the **single per-release intimation**, sent once all of this
release's CRs are complete. It is a release-gate item, NOT a merge-gate item.

The clean-break ruling itself stands: server accepts `role` only, no alias, no dual-key handling.

### §S1 — Validate `identity.source` at the route boundary
Introduce `IDENTITY_SOURCES = ["claude-md", "package-json", "git-repo", "manual"] as const` in
`src/types.ts` (mirroring `AGENT_PHASES`), narrow `AgentIdentity.source` to that union, and
validate in `handleAgentTouch` alongside the existing phase check: a `source` outside the enum →
409, `ok:false`, state-derived `help[]` naming the value received and the valid set. An ABSENT
`source` stays legal (it is optional today and clients omit it on some paths) — this CR rejects
wrong values, it does not make the field required.

### §S2 — Decide the historical rows (measure, do not assume)
`SELECT DISTINCT source FROM agents` on the live dog-food DB currently returns only `claude-md`,
so a backfill is probably unnecessary — but MEASURE it at gap-analysis rather than trusting this
sentence, and state the finding. If any non-enum value exists, the options are a labelled
one-time normalisation (the CR-CRU-057 precedent) or leaving history untouched with the
validation applying to new writes only. User decides if the case arises.

### §S3 — Fleet + guard
The clients already send only enum members (CR-054 §S2b). Add the server-side counterpart to
CR-054's `IdentitySourceEnumGuardTest`: a test asserting the server REFUSES a non-enum source, so
the enforcement cannot silently regress. Confirm no client path can now produce a 409 in normal
operation — a validation that breaks the fleet is a defect, not a fix.

## Acceptance criteria
- [ ] `grep -rn "phase" clients/ src/ public/ cli/` finds no agent-role usage — only genuine
      TDD-cycle-scope prose where the ontology's own word applies — sweep-asserted.
- [ ] `register --role RED` works on all five clients; `--phase` is gone from every `--help`.
- [ ] The wire field is `role`; the server validates it against `AGENT_ROLES` with the CR-044
      semantics intact (required for TDD roles, enum-constrained, never blanked by heartbeat).
- [ ] Storage migrated: `agents.role`, `events.role`, `events.role_inferred` — and **CR-057's
      backfilled classification survives the migration** (assert the live-shaped fixture's counts
      before and after are identical; on the dog-food DB, 299 of 338 classified events).
- [ ] **RELEASE-gate (not merge-gate)**: the `--phase` → `--role` capability change is on the
      single per-release Model-B intimation list, sent once this release's CRs are complete.
- [ ] The UI classifies from the renamed field; `agentRole()` unchanged.
- [ ] `POST /api/v2/agents/register` with `identity.source` outside the enum → 409, `ok:false`,
      non-empty `help[]` naming the received value and the valid set; nothing stored — asserted
      per invalid case (unknown string, empty string, non-string type).
- [ ] An ABSENT `source` still registers successfully — asserted (this CR does not make it
      required).
- [ ] Every valid enum member registers successfully — asserted per member.
- [ ] `AgentIdentity.source` is typed to the enum union, not `string` — the type no longer lies.
- [ ] The §S2 measurement is recorded (what the live DB actually contains) and any migration
      decision is the user's, stated in Implementation Notes.
- [ ] All five clients still register successfully against the validating server — asserted by
      driving each (the CR-058 detector's harness does this already; reuse it).
- [ ] Full bun regression green; Python gate too if any client file is touched (CR-CRU-045 §S3).

## Non-goals
- Making `identity.source` required, or changing `displayName`/`repoPath` handling.
- Validating any other free-text field on the identity object — if the sweep finds more, file them
  rather than absorbing them here.

## Risk
- 🚨 **The rename is a BREAKING wire change on the fleet's most-used verb.** An un-refreshed
  client copy sending `phase` is refused by a strict server. The compatibility ruling (§S0) exists
  precisely so the user could have chosen alias-for-one-release instead; the clean break was
  chosen.
- **The migration carries CR-057's backfilled history.** 283 of 338 live events gained a
  classification yesterday; a rename that recreates the column instead of migrating it silently
  discards that. The AC asserts the counts survive.
- **A validating server can refuse a client that a previous version accepted.** The fleet is
  already compliant (CR-054); the exposure is a consumer running an OLD vendored copy. Under the
  standing delivery model this is contained: server and client ship as one uv-installed,
  version-locked pair, so no consumer holds a client older than the server it talks to. It is a
  RELEASE-intimation item for Model-B (skills reference `--role`/`--source`), delivered once after
  the release's CRs complete — **not a merge gate**.

## Implementation Notes
- **Delivered surface: 76 files, +2560/−1180** against the spec's "~60 files" estimate. The delta
  is the two new test files (`agent-identity-source-validation.test.ts`, `agent-role-rename.test.ts`)
  plus doc updates (queue README, this spec) that the measured-surface sweep never counted. Scope
  discipline held — every file maps to §S0 or §S1.
- **§S0 found a SIXTH register surface**: `cli/crucible-axi.ts` (`PHASE_ENUM`, wire key `phase`)
  alongside the five `clients/*-crucible.py`. The measured surface was taken from the Python fleet
  only; the TypeScript CLI was invisible to it.
- **The migration preserves, it does not recreate** — `ALTER TABLE … RENAME COLUMN` (SQLite 3.25+)
  under a `PRAGMA table_info` guard, so it is idempotent by construction. Verified independently by
  VERIFY on two isolated copies of the live dog-food DB: 339 events / 301 classified before and
  after, legacy `phase`/`phase_inferred` gone from both tables, second open a clean no-op.
- **`STATUS-CONTRACT.md` took a MAJOR bump (1.1.0 → 2.0.0)**, not a minor. Rationale: a consumer
  pinned to 1.x that shells the retired `--phase` flag now breaks, which is a breaking change to
  the contract's consumers — unlike CR-056's purely additive binding section.
- **§S2 measurement, user-decided:** `SELECT DISTINCT source FROM agents` on the live DB returned
  only `claude-md`, so no backfill was needed and none was written.
- **Nine `phase` survivors, all audited and correct**: four in `src/store.ts` (the RENAME migration
  must name the legacy column literally), four in narration/comment prose using `phase` in the
  DN's own cycle-SCOPE sense ("one phase of one cycle"), one explanatory contrast line in
  `STATUS-CONTRACT.md`. Zero surviving uses of `phase` as the agent's role field.
