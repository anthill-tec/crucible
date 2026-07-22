# CR-CRU-035 — Ambient-context read-path contract (AXI principle 7) — coordinated Crucible↔Model-B

**Status:** PENDING — **RE-SCOPED 2026-07-22 after Model-B coordination (Sandesh msg
1333→1334).** Crucible ships NO hook installer and NO client `setup` command. Crucible's
side of AXI principle 7 is the **read-path contract only**: a stable, versioned `status`
envelope + tolerant/bounded behavior so Model-B's generated session hook can surface the
board safely at session start.
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-030 (the fleet AXI client interface + the §S6 `status` read verb this hardens)
**Labels:** feature, axi, ambient-context, read-path, contract, dx, cross-project, model-b-coordination
**Phase:** Wave 4 (0.1.0)
**Design reference:** AXI manifesto principle 7 "Ambient context" (https://axi.md — every
conversation starts with relevant state already visible, before the agent acts) + user
direction 2026-07-21/22 + Model-B coordination reply (Sandesh msg 1334, 2026-07-22).

## Context
AXI principle 7 surfaces board state (queue, active cycle, wave, last-run CR) into the
agent's session at start, before any action — the strongest anti-context-loss lever.
Delivering it end-to-end spans two projects, and the **ownership boundary is now settled**:

- **Crucible owns** the server + the client-side scripts, and MAY install its own tooling
  via the AXI model (the client installer — CR-CRU-009). It does **NOT** build hooks.
- **Model-B owns** hook creation + per-project DEPLOY **and skill generation** per project
  stack/needs. Its scaffold (CR-MDB-013, shipped) already emits a per-project hooks seam;
  CR-MDB-015 (Model-B's next CR) compiles a neutral hook schema to per-harness wiring and
  deploys it via Model-B's universal installer.

So the session hook that runs `status` at session start is **entirely Model-B's** to
generate + deploy. Crucible's ONLY responsibility for principle 7 is to make its
**read-path** something a hook can safely depend on: a stable, versioned `status` contract
that returns fast and never blocks a session start. This CR delivers exactly that — no
`setup` command, no hook writing.

## Scope

### §S1 `status` is hook-safe: TOLERANT + BOUNDED (all 5 clients)
The `status` read verb (CR-030 §S6) must be safe to invoke from a session-start hook —
it can never hang, error out, or block the session on board state. Today `cmd_status`
already degrades on **no open plan** (exit 0, `ok:true`, empty envelope) — that is kept.
The gap is the **server-unreachable / plans-fetch-failure** path, which currently emits
`ok:false` and **exits non-zero** (e.g. `python-crucible.py cmd_status` `return 1`). Fix
it fleet-wide:
- **Server unreachable / plans fetch fails →** emit a well-formed envelope with `ok:true`
  and a `warnings[]` entry `{code:"status-unavailable", detail:"…"}` (+ a stderr line),
  empty `plans[]` and `lastRunCr:null`, and **exit 0**. Never non-zero, never a raw
  traceback, never a hang.
- **Bounded:** the plans fetch uses a short connect/read timeout (never the default
  unbounded socket wait) so an unreachable/slow server fails fast; `status` returns
  promptly regardless of server state.
- Applies to all five clients' `status` path (`_crucible_axi.py` shared resolvers +
  each client's `cmd_status`); the tolerant behavior is uniform across the fleet.

### §S2 Stable, versioned `status` envelope contract (docs committed with the clients)
Document the `status` output contract that Model-B's generated hook consumes, committed
alongside the clients so it versions with them:
- The envelope carries `ok`, `context`, `warnings[]`, and the board payload: `plans[]`
  rows (`cr`, `wave`, `status`, `activeCycleId`), the single `status:"active"` cycle
  (id + label), and top-level `lastRunCr`.
- Assign the contract a **version** so Model-B can pin what its hook renders; note the
  tolerant-degrade shape (§S1) as part of the contract (a hook that gets `ok:true` +
  `warnings[]` `status-unavailable` renders "board unavailable", never fails).
- The doc lives with the clients (`clients/` — e.g. the report-skill docs / a
  `STATUS-CONTRACT.md`), so it ships and versions with the code Model-B invokes.

## Acceptance criteria
- [ ] §S1: with the server UNREACHABLE (or the plans fetch failing), every client's
      `status` emits `ok:true` + `warnings[]` `status-unavailable`, empty `plans[]` +
      `lastRunCr:null`, and exits 0 — asserted per client. No traceback, no non-zero exit.
- [ ] §S1: `status` with NO open plan still exits 0 with `ok:true` + empty board
      (existing behavior preserved).
- [ ] §S1: the plans fetch is bounded by a short timeout (asserted — a slow/unreachable
      endpoint returns promptly, never hangs).
- [ ] §S2: the versioned `status` envelope contract is documented + committed with the
      clients (envelope shape, the board fields, the version, and the tolerant-degrade
      shape).
- [ ] Crucible ships NO `setup`/hook-install command and NO hook file (the re-scope holds
      — grep confirms no session-hook-writing code in `clients/`).

## Coordination
- Division CONFIRMED with Model-B (msg 1334): Model-B owns hook creation/deploy + skill
  generation (CR-MDB-013 scaffold seam + CR-MDB-015 templates/generation + installer);
  Crucible = read-path contract only.
- Client DISCOVERY (a stable machine-readable client location for Model-B's installer to
  capture at pre-flight) is deferred to the **Crucible installer, CR-CRU-009** — NOT this
  CR. Note it on CR-009.
- On CR-035 merge: intimate Model-B (msg thread 1333/1334) that the stable, versioned
  `status` contract has landed, so CR-MDB-015 can pin it. (User-gated send.)

## Non-goals
- Any `setup` command, hook installation, hook templates/generation, or skill generation
  — those are **Model-B's** (CR-MDB-015).
- The Crucible client installer + the client-discovery manifest — those are **CR-CRU-009**.
- New `status` fields or a redesign of the §S6 verb — only tolerance/bounding + the
  contract doc; the field set is CR-030 §S6's.
