# Crucible `status` envelope contract

**Version: 1.1.0**

This is the stable, versioned contract for the `status` (alias `plans`) read verb
emitted by every `*-crucible.py` client in this directory. It is committed WITH the
clients so it ships and versions alongside the code that Model-B's generated
session-start hook invokes (CR-CRU-035 §S2). A hook pins this VERSION so it always
knows the shape it renders.

`status` is a read-only, hook-safe board query: it never mutates state, never hangs,
and never exits non-zero — so a session-start hook can surface the board (AXI
principle 7, "ambient context") before the agent acts.

The envelope is a TOON-AXI document (AXI manifesto, https://axi.md) with a single
top-level `axi` object. The principles each field/behavior satisfies are named inline
below.

## Envelope shape

```
axi:
  verb: status
  ok: <bool>
  plans[]{cr,wave,status,activeCycleId}
  lastRunCr: <string|null>
  count: <int>
  help[]
  context: { projectKey, agentId?, cycleId?, wave?, cr?, track? }
  warnings[]{code,detail}
```

### Top-level envelope fields

| Field       | Meaning | AXI principle |
|-------------|---------|---------------|
| `ok`        | `true` for every successful or DEGRADED read (a definitive data-state). `status` never returns `ok:false` — an unreachable server is a data-state, not a command error. | 5 (definitive states) |
| `context`   | The resolved run context: `projectKey`, plus optional `agentId`, `cycleId`, `wave`, `cr`, `track`. | 1 (TOON envelope) |
| `warnings`  | Structured `{code,detail}` entries on STDOUT (never stderr) — e.g. the `status-unavailable` degrade signal. Empty `[]` on a clean read. | 6 (structured, on stdout) |
| `plans`     | The board: one uniform row per open plan (see row schema). Empty `[]` when no plan is filed, or in the unavailable degrade. | 1, 2 (minimal schema) |
| `lastRunCr` | The `cr` of the plan with the latest `closedAt` (the last CR to merge), or `null` when none has closed — never a fabricated guess. | 5 |
| `count`     | Total plans available (unaffected by the `--fields` column projection); `0` on an empty or unavailable board. | 5 |
| `help`      | A block of CONCRETE next-step command templates for the terminal state reached. | 9 (next-steps) |

### `plans[]` row schema (the §S6 base row)

The minimal default projection is `cr,wave,status,activeCycleId` (AXI principle 2 —
minimal schema; `--fields` ADDS columns such as `activeCycleLabel`, `mergeCommit`,
never replaces the base). Rows are uniform (same scalar-only key set) so the list
round-trips as a TOON table.

| Row field        | Meaning |
|------------------|---------|
| `cr`             | The plan's CR id. |
| `wave`           | The plan's wave. |
| `status`         | The plan lifecycle status (`open` / closed). |
| `activeCycleId`  | The id of the plan's single `status:"active"` cycle (the active cycle), or `null` when none is active. |

The single active cycle is the `status:"active"` cycle carried by the plan. Its
identity is flattened onto the row as the active-cycle id column (`activeCycleId`)
and, in the extended projection, the active-cycle **label** column
(`activeCycleLabel` — the human-readable name), because a TOON table cell cannot hold
a nested dict.

## Terminal states (all exit 0)

`status` has THREE definitive terminal states (AXI principle 5 — never an ambiguous
blank), each distinguished by its warnings/count, all exit 0:

1. **Board present** — `ok:true`, non-empty `plans[]`, `count>0`, `warnings:[]`.
2. **No plan filed** — a REACHABLE server with zero plans: `ok:true`, `plans:[]`,
   `count:0`, `warnings:[]`. The `help[]` points at `plan-file`. This state carries
   NO `status-unavailable` warning — it is explicitly the "0 plans" empty state, not
   an outage.
3. **Unavailable (tolerant degrade)** — the plans fetch failed (server unreachable /
   non-ok). See below.

## Tolerant-degrade shape (`status-unavailable`)

When the plans fetch fails, `status` does NOT error out. It emits a DEFINITIVE
unavailable data-state and exits 0, so a session-start hook can render "board
unavailable" and continue, never fail (CR-CRU-035 §S1):

- `ok: true` — a definitive DATA-state (AXI principle 5), never a command failure.
- `warnings[]` carries a structured `{code:"status-unavailable", detail:"…"}` entry
  (AXI principle 6 — structured, on stdout). Its presence is the signal that
  distinguishes this state from the "no plan filed" empty state.
- `plans: []`, `lastRunCr: null`, `count: 0` — an EMPTY board, never fabricated or
  stale rows.
- `help[]` carries a CONCRETE next-step naming the Crucible server (e.g. "check the
  Crucible server is running / reachable at <base>") — AXI principle 9.
- exit code `0`. No traceback, no hang: the underlying fetch is bounded by a short
  `timeout=` (never the default unbounded socket wait).

A hook that receives `ok:true` together with a `status-unavailable` warning renders
"board unavailable" and moves on — it never fails on it.

## Agent identity and phase (CR-CRU-044 §S4)

The `context.agentId` this envelope reports — and the `--agent` value every client's
`register` verb takes — is a **free-form identifier**. It carries no structure the
system reads: it is a label for humans and for joining rows together, nothing more.

The **`--phase` flag declares the agent's phase**, and that stored declaration is what
classifies the agent everywhere (the dashboard's agent rail, the phase filters, the
run attribution). Phase is never inferred from the agentId's shape.

- `--phase` is **required** on `register` across all five `*-crucible.py` clients and
  `cli/crucible-axi.ts`, and is constrained to the enumeration
  `RED | GREEN | FIX | VERIFY | ORCHESTRATOR | report`. Omitting it, or passing a value
  outside the enumeration, fails argument parsing with a non-zero exit and the accepted
  values listed — no registration is sent.
- Use `--phase report` for a registration that is not exercising a TDD phase.
- Naming conventions such as `<agent-type>-<project>` or
  `CR-<PROJ>-NNN-<cycle>-<PHASE>` remain useful as **habits for readability only**. They
  are not load-bearing: an agentId ending in `-GREEN` registered with `--phase RED`
  classifies as **RED**, because the declaration beats the label.

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

- A TDD-phase registration — `--phase` one of `RED | GREEN | FIX | VERIFY` — **requires
  `--cycle <id>`, bound to an ACTIVE cycle of an open plan**. Registering such a phase
  with no binding is refused: `ok:false`, HTTP `409`, and a `help[]` naming `--cycle` as
  how to supply it. No agent row is created.
- `--phase ORCHESTRATOR` and `--phase report` **may register unbound** — they do not
  execute a cycle, so they carry no cycle binding and their ingests are not stamped.
- An INVALID binding is refused with a `409` whose message names the ACTUAL state —
  an unknown cycle id, a cycle still `pending`, a cycle already `done`, or a cycle whose
  plan is closed. The state is read from the server, never guessed by the client.
- A bound agent's ingests are **server-stamped to its registered cycle**, even when
  another plan's cycle is simultaneously active. The client sends no resolved cycle of
  its own; an explicit per-ingest `context.cycleId` remains available for the unbound
  phases.

## Bounded fetch

The plans GET is bounded by a short `timeout=` on the underlying `urlopen` call across
all five clients, so an unreachable or slow server fails fast and `status` returns
promptly regardless of server state — it can never hang a session-start hook.

## Versioning

This contract is versioned so Model-B's generated hook can pin what it renders. Bump
the VERSION above on any change to the envelope shape, the row schema, the terminal
states, or the tolerant-degrade shape. Additive `--fields` columns do not change the
base contract and do not require a version bump.
