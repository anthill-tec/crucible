# CR-CRU-151 — a run says which stack produced it, and the board keeps it

**Type** fix · **Points** 8 (scored 5 at gap analysis 2026-10-21; raised at its pre-review when the
start's tier joined the stack) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-112 · **Status** PENDING —
filed 2026-09-24

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
| `/runs/start` with `stack: bun`, closed by `/runs/parsed` with `stack: python` | `python` (accepted) | absent |
| `/runs/start` with `tier: integration`, closed by an ingest stating no tier | tier `unit` | — |
| an aborted run started with `stack: bun` | `bun` | **absent** |

Four losses:

1. **The close drops what the start declared.** A run's start stores its stack and tier on the
   `runs` row, but the ingest that closes the run (`resolveRunClose`) carries only the lifecycle onto
   the event; the event's stack and tier come from the ingest body alone (an absent tier is stored as
   `unit`). A closing ingest may even state a different stack, and it is stored.
2. **The clients state the stack only on the start.** All five clients send `stack` on `/runs/start`
   (the shared `open_run`) and on no ingest — except python, which adds it to the ingest only when no
   start was accepted ("exactly once", CR-CRU-112 AC5). So every run that opened a start loses its
   stack, and the other clients' single-shot ingests never state it.
3. **The brief never returns it.** `eventBrief` has no `stack` key, so every read it serves omits it:
   the events list (plain, cycle-anchored and release-anchored), `/api/v2/status`' `lastTest` and
   `lastCompile`, and each project's `lastEvent`. Only the detail read returns it.
4. **An empty stack is stored as `""`, and a non-string one is dropped silently.**

**Why it matters:** without the stack, nothing downstream can be stack-aware, whether that is
rendering, per-stack codec routing (CR-CRU-152) or a filer asking "which of my stacks is red". A run
started at one tier and stored at another misfiles it.

## Design (settled with the user, 2026-10-21)

- Every ingest states its stack, through the shared ingest path; the start still states it too.
- The board carries a start's stack and tier onto the event that closes the run.
- A run cannot change stack or tier: a closing ingest whose stack or tier differs from its start's is
  refused, and the refusal writes nothing — no event, no agent-card message.
- A stack is a non-empty string or absent.
- The stack comes back on every read the event brief serves, and on the detail read.

## Scope

### §S1 — every client states its stack on every ingest

The shared ingest path (`post_ingest` in `clients/_crucible_axi.py`) takes the client's stack as a
required keyword and puts it on every ingest body it sends (`/runs`, `/runs/parsed`, `/runs/compile`),
whether or not a start was accepted; every call site in the five clients (17 today: arduino 3, bun 3,
mvn 3, python 2, rust 6) passes its own `_STACK`. `/runs/start` keeps stating it through `open_run`.
Python's "only when no start" rule is retired. The value is the client's own stack name (`bun`,
`python`, `mvn`, `rust`, `arduino`); a gate that runs another stack's suite hands it to that stack's
client, which states its own.

### §S2 — the board keeps the stack and tier, and returns the stack

- **Shape.** On `/runs/start` and on every ingest route, a `stack` that is present must be a
  non-empty string; anything else is refused (400) before anything is stored.
- **Carried across the close.** An ingest that closes a run takes the start's stack when it states
  none, and the start's tier when it states none. A start that stated no stack takes the ingest's.
  With neither stating a tier, the event is `unit` as today.
- **No change mid-run.** A closing ingest whose stack, or tier, differs from its start's is refused
  (400) naming both values. The check sits in the run-close resolution (`resolveRunClose`), which
  already runs before any write: nothing is stored, the agent row is not touched, and the run stays
  open on the board. (A client whose ingest is refused aborts its run; that is the client's existing
  behaviour.) An abort states no stack or tier and is unaffected.
- **Returned.** `eventBrief` returns the stored `stack` when present, so every read it serves carries
  it: the events list (plain, `cycleId`- and `release`-anchored), `/api/v2/status`' `lastTest` and
  `lastCompile`, and each project's `lastEvent`. The detail read (`GET /api/v2/events/<id>`) already
  does. Absent means absent: an event never told its stack has no `stack` key, never null, never
  defaulted.

## Acceptance criteria

- [ ] **Every caller states it.** `post_ingest` refuses a call without `stack` (a required keyword)
      and puts the given stack on the body for each ingest route; a census over the five clients'
      sources finds every `post_ingest` call site and asserts each passes `stack=_STACK` (zero call
      sites without it — no pinned count).
- [ ] **Every client, every route — client side.** For each of the 13 client × route cells (arduino:
      `/runs/compile`, `/runs/parsed`; bun: `/runs/parsed`, `/runs`, `/runs/compile`; mvn: `/runs`,
      `/runs/parsed`, `/runs/compile`; python: `/runs/parsed`, `/runs/compile`; rust: `/runs/compile`,
      `/runs/parsed`, `/runs`), driven through the client with a recording `_post`, the ingest body
      carries that client's stack — with a start accepted and without one.
- [ ] **Every route, every read — server side.** For each ingest route, an event ingested with a
      stack reads it back on the detail read and on every brief-served read (the events list, its
      `cycleId` and `release` forms, `/api/v2/status`' last test or compile, the project's
      `lastEvent`); an aborted run's event carries its start's stack on the list too.
- [ ] **The start survives the close.** A run started with a stack and a tier and closed (on each of
      `/runs`, `/runs/parsed`, `/runs/compile`) by an ingest stating neither carries the start's stack
      and tier on its event; a start without a stack closed by an ingest stating one carries the
      ingest's.
- [ ] **No change mid-run.** A closing ingest whose stack, or tier, differs from its start's gets 400
      naming both, at the HTTP route: no event is stored, the agent row's message and last-seen are
      unchanged, and the run is still open. The same values on both are accepted (regression guard:
      passes today).
- [ ] **A stack is a word.** `stack: ""` and a non-string `stack` are refused with 400 on
      `/runs/start` and on each ingest route, storing nothing.
- [ ] **Absent means absent** (regression guard: passes today). An event ingested with no stack and
      no started stack has no `stack` key on any read.
- [ ] **The amended tests.** Two tests that pin the old behaviour are amended in their own commit,
      authorised by this criterion: `test_one_gate_invocation_ingests_each_suite_under_its_own_stack`
      (`tests/client/test_gate_multi_suite_coverage.py`) counts one python RUN (distinct runs, not
      bodies, since the start and the ingest now both carry the stack); `NoLifecycleOptOutIsSingleShotTest`
      (`tests/client/test_cr017_client_lifecycle.py`) requires `stack` in the single-shot body's key
      set. Nothing else in either file changes.
- [ ] **The record.** The gap analysis records where the stack was being lost, with the measurement,
      before RED (above).

## Non-goals

- Backfilling stack or tier onto stored events. Nothing recorded them; inventing them would be a
  guess.
- Stack-aware rendering. That needs the stack first; it is its own concern.
- Validating the stack's value against a list of known stacks.
- A stack on gate, milestone or lifecycle events, and the PRD's tool version. PRD §4.4's "every event"
  and its field table's `java`/`ts` values are stale: the stack is the client's own name.
