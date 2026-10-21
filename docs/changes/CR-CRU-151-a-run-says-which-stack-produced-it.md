# CR-CRU-151 — a run says which stack produced it, and the board keeps it

**Type** fix · **Points** 5 (scored at gap analysis 2026-10-21) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-112 · **Status** PENDING — filed 2026-09-24

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

Yet the clients send it, the server reads it (`runMeta` in `src/v2.ts`), the `events` and `runs`
tables both have a `stack` column, and the event shape declares `stack?: string`.

**Where it is lost — measured at gap analysis (2026-10-21).** Re-read on the dev board: the 15 most
recent test events of this project (bun and python clients) carry no `stack`, on list or detail. Then
on a scratch in-memory server, through the real routes:

| Case | Event detail | Events list |
|---|---|---|
| `/runs/start` with `stack: bun`, closed by `/runs/parsed` without one | **absent** | absent |
| single-shot `/runs/parsed` with `stack: python` | `python` | **absent** |
| `/runs/parsed` with no stack | absent | absent |
| `/runs/compile` with `stack: rust` | `rust` | **absent** |
| `/runs/start` with `stack: mvn`, closed by `/runs/parsed` with `stack: mvn` | `mvn` | **absent** |

Three losses:

1. **The close drops the start's stack.** A run's start stores its stack on the `runs` row, but the
   ingest that closes the run (`resolveRunClose`) carries only the lifecycle onto the event; the event's
   stack comes from the ingest body alone.
2. **The clients state it only on the start.** All five clients send `stack` on `/runs/start` (the
   shared `open_run`) and on no ingest — except python, which adds it to the ingest only when no start
   was accepted ("exactly once", CR-CRU-112 AC5). So every run that opened a start loses its stack,
   and the other clients' single-shot ingests (no start, or a refused one; `auto-ingest`; a compile
   ingest without a run) never state it.
3. **The list read never returns it.** The events list (`eventBrief`) has no `stack` key, even for
   an event that stored one.

**Why it matters:** without the stack, nothing downstream can be stack-aware, whether that is
rendering, per-stack codec routing (CR-CRU-152) or a filer asking "which of my stacks is red".

## Design (settled with the user, 2026-10-21)

- Every ingest states its stack, through the shared ingest path; the start still states it too.
- The board carries a start's stack onto the event that closes the run.
- A run cannot change stack: a closing ingest whose stack differs from its start's is refused.
- The stack comes back on both reads, list and detail.

## Scope

### §S1 — every client states its stack on every ingest

The shared ingest path (`post_ingest` in `clients/_crucible_axi.py`) takes the client's stack and puts
it on every ingest body it sends (`/runs`, `/runs/parsed`, `/runs/compile`), whether or not a start
was accepted; every caller in the five clients (`bun`, `python`, `mvn`, `rust`, `arduino`) passes its
own. `/runs/start` keeps stating it through `open_run`. Python's "only when no start" rule is
retired.

### §S2 — the board keeps it and returns it

A stack sent with an ingest reaches the stored event. An ingest that closes a run and states no stack
takes the stack its start declared. A closing ingest whose stack differs from its start's is refused
(400) before anything is stored, naming both, and the run stays open. Every event read returns the
stored stack — the list (`GET /api/v2/events?project=…`, and its cycle-anchored form) and the detail
(`GET /api/v2/events/<id>`). Absent means absent: an event that was never told its stack has no
`stack` key, never null, never defaulted.

## Acceptance criteria

- [ ] **Every caller.** Every call of the shared ingest path in each of the five clients passes the
      client's own stack, and the path puts it on the body; a census over the clients' sources pins
      the caller count, so a new caller without a stack fails it.
- [ ] **Every client, every route.** For EACH of the five clients and EACH ingest route it uses, an
      ingested event read back through `GET /api/v2/events/<id>` and through the events list carries
      that client's stack.
- [ ] **The start's stack survives the close.** A run started with a stack and closed by an ingest
      (on each of `/runs`, `/runs/parsed`, `/runs/compile`) that states none carries the start's stack
      on its event, on both reads.
- [ ] **No change of stack.** A closing ingest stating a different stack from its start's is refused
      with 400 naming both; nothing is stored, and the run is still open. The same stack on both is
      accepted.
- [ ] **Absent means absent.** An event ingested with no stack and no started stack reads back with
      no `stack` key on either read: never null-filled, never defaulted.
- [ ] **The record.** The gap analysis records where the stack was being lost, with the measurement,
      before RED (above).

## Non-goals

- Backfilling stack onto stored events. Nothing recorded it, and inventing it would be a guess.
- Stack-aware rendering. That needs the stack first; it is its own concern.
- Validating the stack's value against a list of known stacks.
