# Crucible `status` envelope contract

**Version: 3.0.0**

This is the stable, versioned contract for the `status` (alias `plans`) read verb
emitted by every `*-crucible.py` client in this directory. It is committed WITH the
clients so it ships and versions alongside the code that Model-B's generated
session-start hook invokes (CR-CRU-035 §S2). A hook pins this VERSION so it always
knows the shape it renders.

`status` is a read-only, hook-safe board query: it never mutates state, never hangs,
and never exits non-zero — so a session-start hook can surface the board (AXI
principle 7, "ambient context") before the agent acts. It shows the **work in
flight**: the project's open plans, read with the single request
`GET …/plans?status=open`. It is not a history of the project — `queue` (with
`cr-plan --full`) is the read for every CR and plan, and `status` has no flag for it.

The envelope is a TOON-AXI document (AXI manifesto, https://axi.md) with a single
top-level `axi` object. The principles each field/behavior satisfies are named inline
below.

## Envelope shape

```
axi:
  verb: status
  ok: <bool>
  tier: <string>
  plans[]{cr,wave,status,activeCycleId}
  lastClosedCr: <string|null>
  count: <int>
  filed: <int|null>
  help[]
  context: { projectKey, agentId?, cycleId?, wave?, cr?, track? }
  warnings[]{code,detail}
```

### Top-level envelope fields

| Field       | Meaning | AXI principle |
|-------------|---------|---------------|
| `ok`        | `true` for every successful or DEGRADED read (a definitive data-state). `status` never returns `ok:false` — an unreachable server is a data-state, not a command error. | 5 (definitive states) |
| `tier`      | The tier of the run this exit ingested; `status` ingests nothing, so it reads `none`. Present on every envelope the fleet emits. | 5 |
| `context`   | The resolved run context: `projectKey`, plus optional `agentId`, `cycleId`, `wave`, `cr`, `track`. | 1 (TOON envelope) |
| `warnings`  | Structured `{code,detail}` entries on STDOUT (never stderr) — e.g. the `status-unavailable` degrade signal. Empty `[]` on a clean read. | 6 (structured, on stdout) |
| `plans`     | The work in flight: one uniform row per open plan (see row schema), in the order the server publishes them. Empty `[]` when no plan is open, or in the unavailable degrade. | 1, 2 (minimal schema) |
| `lastClosedCr` | The `cr` of the plan with the latest `closedAt` (the last CR to close), or `null` when none has closed — never a fabricated guess. Aborted plans have no `closedAt` and never count. Published by the server over all of the project's plans; `null` in the unavailable degrade. | 5 |
| `count`     | The number of `plans[]` rows — the open plans (unaffected by the `--fields` column projection); `0` on an empty or unavailable board. | 5 |
| `filed`     | The number of plans the project has ever filed, whatever their status (open, closed or aborted). Published by the server over all of the project's plans; `null` in the unavailable degrade, where the number is unknown, not zero. | 5 |
| `help`      | A block of CONCRETE next-step command templates for the terminal state reached (see Terminal states). | 9 (next-steps) |

`lastClosedCr` and `filed` are project facts the SERVER publishes on every
`GET …/plans` response, computed over all of the project's plans whatever `status`,
`cr` or `track` filter the request carried. `status` passes both through unchanged;
no client filters rows or recomputes either value.

### `plans[]` row schema (the §S6 base row)

The minimal default projection is `cr,wave,status,activeCycleId` (AXI principle 2 —
minimal schema; `--fields` ADDS columns such as `activeCycleLabel`, `mergeCommit`,
never replaces the base). Rows are uniform (same scalar-only key set) so the list
round-trips as a TOON table.

| Row field        | Meaning |
|------------------|---------|
| `cr`             | The plan's CR id. |
| `wave`           | The plan's wave. |
| `status`         | The plan lifecycle status — always `open`, because `status` reads only the open plans. |
| `activeCycleId`  | The id of the plan's single `status:"active"` cycle (the active cycle), or `null` when none is active. |

The single active cycle is the `status:"active"` cycle carried by the plan. Its
identity is flattened onto the row as the active-cycle id column (`activeCycleId`)
and, in the extended projection, the active-cycle **label** column
(`activeCycleLabel` — the human-readable name), because a TOON table cell cannot hold
a nested dict.

## Terminal states (all exit 0)

`status` has THREE definitive reachable states (AXI principle 5 — never an ambiguous
blank), all `ok:true`, `warnings:[]`, exit 0, told apart by `count` and `filed`:

| State | `plans` | `count` | `filed` | `lastClosedCr` | `help[]` |
|---|---|---|---|---|---|
| **Work in flight** | the open plans | > 0 | > 0 | as published | `cycle-activate <id>` |
| **None open** | `[]` | 0 | > 0 | as published (`null` on an aborted-only board) | `next`, then `plan-file --cr <cr> --cycle <label>` |
| **Never filed** | `[]` | 0 | 0 | `null` | `plan-file --cr <cr> --cycle <label>` |

1. **Work in flight** — at least one plan is open: its rows are `plans[]`.
2. **None open** — plans have been filed, but none is open (every one closed or
   aborted). The `help[]` points at `next` to find the next CR, then `plan-file`.
3. **Never filed** — a REACHABLE server holding no plan at all. The `help[]` points
   at `plan-file` to file the first plan.

`filed` — not `lastClosedCr` — is the signal that separates "none open" from
"never filed": a board whose only plans were aborted has `lastClosedCr: null`
(nothing ever closed) yet `filed > 0`, so it is "none open". Neither empty state
carries a `status-unavailable` warning — each is a definitive empty state, not an
outage.

A fourth exit path, **Unavailable (tolerant degrade)**, is reached when the plans
read fails (server unreachable / non-ok). See below.

## Tolerant-degrade shape (`status-unavailable`)

When the plans fetch fails, `status` does NOT error out. It emits a DEFINITIVE
unavailable data-state and exits 0, so a session-start hook can render "board
unavailable" and continue, never fail (CR-CRU-035 §S1):

- `ok: true` — a definitive DATA-state (AXI principle 5), never a command failure.
- `warnings[]` carries a structured `{code:"status-unavailable", detail:"…"}` entry
  (AXI principle 6 — structured, on stdout). Its presence is the signal that
  distinguishes this state from the reachable "none open" and "never filed" empty
  states.
- `plans: []`, `lastClosedCr: null`, `count: 0`, `filed: null` — an EMPTY board,
  never fabricated or stale rows. `filed` is `null`, not `0`: the board could not be
  read, so the number of plans is unknown.
- `help[]` carries a CONCRETE next-step naming the Crucible server (e.g. "check the
  Crucible server is running / reachable at <base>") — AXI principle 9.
- exit code `0`. No traceback, no hang: the underlying fetch is bounded by a short
  `timeout=` (never the default unbounded socket wait).

A hook that receives `ok:true` together with a `status-unavailable` warning renders
"board unavailable" and moves on — it never fails on it.

## `--format {toon,json}` — JSON for programs

`status` and its alias `plans` accept `--format {toon,json}` in all five clients.

- `--format toon` is the default, and is the TOON-AXI envelope documented above.
- `--format json` writes the SAME envelope as ONE JSON object on stdout: every key the
  `axi` object carries (`verb`, `ok`, `tier`, `plans`, `lastClosedCr`, `count`,
  `filed`, `help`, `context`, `warnings`) with the same values, unwrapped — there is
  no `axi` key.
- This holds on every exit path: the three reachable states and the unavailable
  degrade, whose signal a program reads as the `warnings[].code` value
  `status-unavailable`. Exit codes and the stderr line are the same in both formats.
- Any other value is refused by argument parsing.
- The no-argument dashboard does not take the flag; it always writes TOON.

A work-in-flight read with `--format json`:

```json
{
  "verb": "status",
  "ok": true,
  "tier": "none",
  "plans": [
    {"cr": "CR-ABC-012", "wave": "3", "status": "open", "activeCycleId": 42}
  ],
  "lastClosedCr": "CR-ABC-011",
  "count": 1,
  "filed": 12,
  "help": ["cycle-activate <id>"],
  "context": {"projectKey": "00000000-0000-7000-8000-000000000000"},
  "warnings": []
}
```

## Agent identity and role (CR-CRU-044 §S4, renamed by CR-CRU-059 §S0)

The `context.agentId` this envelope reports — and the `--agent` value every client's
`register` verb takes — is a **free-form identifier**. It carries no structure the
system reads: it is a label for humans and for joining rows together, nothing more.

The **`--role` flag declares the agent's role**, and that stored declaration is what
classifies the agent everywhere (the dashboard's agent rail, the role filters, the
run attribution). The role is never inferred from the agentId's shape.

- `--role` is **required** on `register` across all five `*-crucible.py` clients — the
  whole fleet, since CR-CRU-132 retired the orphaned sixth surface — and is constrained
  to the enumeration
  `RED | GREEN | FIX | VERIFY | ORCHESTRATOR | report`. Omitting it, or passing a value
  outside the enumeration, fails argument parsing with a non-zero exit and the accepted
  values listed — no registration is sent.
- Use `--role report` for a registration that is not exercising a TDD role.
- RED/GREEN/VERIFY/FIX are **roles** (what the agent is doing), not phases (the scope
  it acts in). CR-CRU-059 §S0 renamed the field fleet-wide as a CLEAN BREAK: there is
  no legacy alias and no dual-key handling on the wire.
- Naming conventions such as `<agent-type>-<project>` or
  `CR-<PROJ>-NNN-<cycle>-<ROLE>` remain useful as **habits for readability only**. They
  are not load-bearing: an agentId ending in `-GREEN` registered with `--role RED`
  classifies as **RED**, because the declaration beats the label.

## The identity source is an enumeration (CR-CRU-059 §S1)

Alongside `--agent` and `--role`, a registration may declare WHERE the agent's identity
came from, via the optional **`--source`** flag (sent on the wire as
`identity.source`). It is constrained — client-side by argparse and server-side at the
route boundary — to exactly four members:

`claude-md | package-json | git-repo | manual`

- A `source` **outside that enumeration is refused by the server** with HTTP `409`,
  `ok:false`, and a `help[]` naming both the received value and the accepted set.
  **Nothing is stored** — no agent row is created by a rejected registration, and a
  rejected heartbeat never overwrites the previously stored value. The refusal covers
  unknown strings, the empty string, and non-string types alike.
- An **absent** `source` stays legal: the field is **optional** and this contract does
  NOT require it. Clients omit it on some paths, and omitting it is always preferable
  to inventing a value.
- `--source` defaults to `claude-md` across the fleet. `displayName` and `repoPath`,
  the sibling `identity` fields, are free-form and unaffected by this enumeration.

## The agent identity is declared, never fabricated (CR-CRU-044 §S5)

An agent identity is **declared with `--agent` or the verb FAILS**. There is no
fallback and no default anywhere in the fleet.

- The gate/milestone verbs (`gate-run`, `gate-report`, `milestone`, and `cr-close`,
  which seals a `cr-merged` milestone) hard-stop when no `--agent` is given: `ok:false`,
  a non-zero exit, and an `agent-identity-required` warning naming `--agent` as how to
  supply it. **Nothing is posted** from that path, so no phantom can reach the agent rail.
- **`$WORKFLOW_ROLE` does not supply an identity.** It carries the track lane
  (`mainline` | `track-n`) and is reported as `context.track`; an agent named after a
  lane is the same category error as one named after the script's filename.
- The resolution lives once, in `clients/_crucible_axi.py` (`require_agent_id`), and
  every client delegates to it — the per-client `_agent_id()` helpers are thin wrappers,
  not independent copies.

## The cycle binding is declared at registration (CR-CRU-056 §S1/§S2)

Attachment to a cycle is a **registration binding**, declared with `--cycle` on
`register`, never resolved by a client at ingest time. The server validates the binding
when the registration is made, and STAMPS that cycle onto every run the bound agent
ingests.

- A TDD-role registration — `--role` one of `RED | GREEN | FIX | VERIFY` — **requires
  `--cycle <id>`, bound to an ACTIVE cycle of an open plan**. Registering such a role
  with no binding is refused: `ok:false`, HTTP `409`, and a `help[]` naming `--cycle` as
  how to supply it. No agent row is created.
- `--role ORCHESTRATOR` and `--role report` **may register unbound** — they do not
  execute a cycle, so they carry no cycle binding and their ingests are not stamped.
- An INVALID binding is refused with a `409` whose message names the ACTUAL state —
  an unknown cycle id, a cycle still `pending`, a cycle already `done`, or a cycle whose
  plan is closed. The state is read from the server, never guessed by the client.
- A bound agent's ingests are **server-stamped to its registered cycle**, even when
  another plan's cycle is simultaneously active. The client sends no resolved cycle of
  its own; an explicit per-ingest `context.cycleId` remains available for the unbound
  roles.

## Bounded fetch

`status`'s one read, `GET …/plans?status=open`, is bounded by a short `timeout=` on
the underlying `urlopen` call across all five clients, so an unreachable or slow
server fails fast and `status` returns promptly regardless of server state — it can
never hang a session-start hook.

## Versioning

This contract is versioned so Model-B's generated hook can pin what it renders. Bump
the VERSION above on any change to the envelope shape, the row schema, the terminal
states, or the tolerant-degrade shape. Additive `--fields` columns do not change the
base contract and do not require a version bump.

- **3.0.0 (CR-CRU-150)** — a BREAKING change to the rows a consumer gets: `plans[]`
  is now the open plans only (the work in flight, read with `GET …/plans?status=open`),
  no longer every plan the project has filed, and `count` counts those rows. Added:
  the top-level `filed` (every plan ever filed, whatever its status; `null` in the
  unavailable degrade), a `help[]` per state (work in flight / none open / never
  filed, told apart by `filed`), and `--format {toon,json}`. `queue` (with
  `cr-plan --full`) is the read for every CR and plan.

- **2.0.0 (CR-CRU-059)** — a MAJOR bump, because §S0's classification-flag rename to
  `--role` is a CLEAN BREAK with no alias: a hook pinned to 1.x that shells the retired
  1.x flag on `register` no longer parses. The additive §S1 `--source` enumeration
  section rode along in the same release.
- **1.1.0 (CR-CRU-056)** — additive: documented the registration cycle binding.
