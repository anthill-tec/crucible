# CR-CRU-151 — a run says which stack produced it, and the board keeps it

**Type** fix · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-112 · **Status** PENDING — filed 2026-09-24

## Problem

**Found by the codec audit the user asked for (2026-09-24):** each stack Crucible supports has its
own runner and reporting strategy, and the server is meant to know which one a run came from. PRD
§4.4: *"Every event is stamped with `stack` + `codec` (+ tool version) so the UI renders stack-aware
views (§4.11)."*

**Measured 2026-09-24, over the HTTP API only (`GET /api/v2/events?project=…`, then
`GET /api/v2/events/<id>`):**

| Board | Project | Test/compile events read | Carrying `stack` |
|---|---|---|---|
| dev `:3850` | Crucible v2 (frontend) | 312 | **0** |
| dev `:3850` | Sandesh (backend) | 18 | **0** |
| prod `:3849` | Model B (backend) | 240 | **0** |

Yet the clients send it: `bun-crucible.py` puts `"stack": _STACK` on `POST /api/v2/runs/start`, and
`python-crucible.py` puts it on the parsed ingest (CR-CRU-112 AC5: *"the run says which STACK
produced it"*). The server reads it (`runMeta` in `src/v2.ts`), the `events` and `runs` tables both
have a `stack` column, and the event shape declares `stack?: string`. **Somewhere between the
request and the read it is lost.** The audit did not pin where, and this CR's gap analysis must
measure it: a run started with a stack but ingested without one, a write that drops it, or a read
projection that omits it. It is also unmeasured whether the rust, maven and arduino clients send it
at all.

**Why it matters:** without the stack, nothing downstream can be stack-aware, whether that is
rendering, per-stack codec routing (CR-CRU-152) or a filer asking "which of my stacks is red".

## Scope

### §S1 — every client states its stack on every ingest

All five clients (`bun`, `python`, `mvn`, `rust`, `arduino`) send their stack on every ingest route
they use: `/runs/start`, `/runs`, `/runs/parsed`, `/runs/compile`. It goes through the one shared
path in `clients/_crucible_axi.py` where the verb is shared.

### §S2 — the board keeps it and returns it

A stack sent with a run reaches the stored event and comes back on the event read (list and
detail). A run opened with `/runs/start` and ingested later carries the stack its start declared.
Absent means absent: an event that was never told its stack has none, and nothing defaults one.

## Acceptance criteria

- [ ] For EACH of the five clients and EACH ingest route it uses, an ingested event read back through
      `GET /api/v2/events/<id>` carries that client's stack. The caller count is the assertion.
- [ ] A run whose stack was declared only on `/runs/start` still carries it on the finished event.
- [ ] An event ingested with no stack reads back with no `stack` key: never null-filled, never
      defaulted.
- [ ] The gap analysis records where the stack was being lost, with the measurement, before RED.

## Non-goals

- Backfilling stack onto stored events. Nothing recorded it, and inventing it would be a guess.
- Stack-aware rendering. That needs the stack first; it is its own concern.
