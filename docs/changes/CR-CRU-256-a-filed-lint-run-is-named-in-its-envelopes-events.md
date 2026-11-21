# CR-CRU-256 — a filed lint run is named in its envelope's events

**Status:** COMPLETED — merged 2026-11-14 · filed 2026-11-14 (user ruling: a patch CR in the current wave, found at CR-CRU-254's merge)
**Type:** fix
**Points:** 1
**Wave:** 8 (0.4.0)
**Depends on:** CR-CRU-254 (merged)
**Labels:** clients, shared-module
**Design reference:** the envelope contract "every envelope names the events it filed" (`axi_object`'s `events`,
`filed_run_events`); CR-CRU-254 (the `lint` verb; the gate's lint stage already carries its event into `events`)

## Problem

`lint --agent A` posts its run to `/api/v2/runs/compile` and names the board's event in its envelope's `event`
field, but its `events` list stays `[]`. Measured at CR-CRU-254's merge on this checkout:

- `event: evt-1794635752026-56`;
- `events: []`.

`events` is filled from `filed_run_events()`, which records only the run-ingest routes (`/api/v2/runs`,
`/api/v2/runs/parsed`), so a compile-route post never reaches it. The gate's lint stage already works around this
(it carries the lint event into the gate's `events`), so the same lint run is named in a gate's envelope but not in
the `lint` verb's own. A reader that collects what an invocation filed from `events` misses every lint run.

## Design

- **The `lint` verb's envelope names its filed event in `events`.** When the board files the lint run, `events`
  is `[<that event>]`; when nothing was filed (no `--agent`, a refusal, the board unreachable, nothing declared),
  `events` stays `[]`.
- **One place.** The fix lives in the shared lint module, so all six clients change together. The core is not
  touched, and `filed_run_events()` keeps its meaning (run ingests only).
- **Nothing else moves.** `event`, the gate's lint stage, `check` and every other verb answer as today.

## Steps

### §S1 — the lint verb's events

`cmd_lint` (`clients/_crucible_lint.py`) answers `events: [<event>]` when its post was filed, and `[]` otherwise.

## Acceptance criteria

- [x] **AC1 — a filed lint run is named.** In each of the six clients, `lint --agent A` against a board double that
  files the post answers `events` equal to `[<the board's event id>]`, the same id as `event`.
- [x] **AC2 — nothing filed, nothing named.** `lint` with no `--agent`, with nothing declared, with a refused post
  (400) and with the board unreachable answers `events: []`.
- [x] **AC3 — nothing else moves.** The gate's lint stage still names its lint event once in the gate's `events`;
  `check`'s envelope is unchanged; the core's line count is unchanged.

## Non-goals

- Naming compile-route posts of other verbs (`check`, a test verb's compile fallback) in `events`.
- Changing `filed_run_events()`.
