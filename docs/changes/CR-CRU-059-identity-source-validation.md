# CR-CRU-059 — The server does not validate `identity.source`; the clients' documented enum is unenforced

**Status:** PENDING
**Type:** patch (server input validation)
**Priority:** P2 — no wrong data is on the board today, but the contract is unenforced and drifted undetected for months
**Depends on:** CR-CRU-044 (established the validate-at-the-route-boundary pattern for `phase`), CR-CRU-054 (found the drift)
**Labels:** patch, server, validation, identity, axi-compliance
**Phase:** Wave 4
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

## Scope

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
- **A validating server can refuse a client that a previous version accepted.** The fleet is
  already compliant (CR-054), but any consumer running an OLD vendored client copy — Model-B's
  bundle, for instance — could start getting 409s on registration. That makes this a
  MODEL-B-INTIMATION item before it merges, not after: they must refresh their bundle first.
