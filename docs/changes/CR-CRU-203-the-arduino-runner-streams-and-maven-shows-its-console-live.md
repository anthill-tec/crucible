# CR-CRU-203 — the arduino runner streams its tests, and maven shows its console live

**Type** feature · **Points** 5 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-200 · **Status**
PENDING — filed 2026-10-20 (user rulings 2026-10-20; design in `DN-crucible-live-test-progress.md`)

## Problem

The arduino stack's native host harness is Crucible's own and writes JUnit at exit; maven's surefire
has no structured stream, and its live progress is a per-class count from its console.

## Scope

- **§S1 — the arduino harness emits the Crucible shape.** The native harness writes the stream file;
  the client relays it; a streamed arduino run is recorded from its stream.
- **§S2 — maven's console reaches the open run.** A board codec decodes surefire's console result
  lines for the live view; the JUnit reports stay maven's record.

## Acceptance criteria

To be made exact at gap analysis. These hold under any design:

- [ ] An arduino run's tests reach the open run one by one, and its stored result equals the JUnit
      report's for the same run.
- [ ] A maven run's completed classes and failures show on the open run while it runs; its stored
      result is unchanged.

## Non-goals

- A JUnit Platform listener for maven (a structured maven stream).
