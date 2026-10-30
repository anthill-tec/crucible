# CR-CRU-221 — the shared client module is split, its run emitter is shared, and a reset board is answered

**Type** refactor · **Points** 8 (to be re-scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-218 · **Status** PENDING — filed 2026-10-30 (user ruling at CR-CRU-206's spec pre-review, F9: split
`clients/_crucible_axi.py` in its own CR, ahead of CR-CRU-220); widened 2026-10-30 (user ruling at CR-CRU-206's
VERIFY: its F1, a connection reset at the ingest, and its F2, the run emitter written three times, join this CR).
The file keeps its first slug.

## Problem

1. **The module has outgrown its guard.** `clients/_crucible_axi.py`, the module all five clients load, closed
   CR-CRU-218 at 9,997 lines. `tests/citations-cite-by-symbol.test.ts` reads any bare number of five digits or
   more as a port, never a line, and a self-test fails the day an in-scope file reaches 10,000 lines
   (`BARE_LINE_IMPLAUSIBLE_THRESHOLD`). The module has one line left. CR-CRU-220 adds `junit_case_sources` to it
   (about 25–30 lines, user ruling: the reader is shared), and every later shared helper would cross the guard
   too.
2. **The run emitter is written three times** (CR-CRU-206 VERIFY F2). The envelope emitter that reads the board's
   ingest answer — the `run:` block from `filed_run`, the answer's `warnings[]` joined, no figures for a run not
   filed — is maven's `_emit_run_axi` and python's and bun's `_emit_ingest_axi`, one copy per client. The rust and
   arduino moves (CR-CRU-219, CR-CRU-220) would add two more. Lifting it was blocked by the line budget.
3. **A connection reset escapes the ingest** (CR-CRU-206 VERIFY F1, present before CR-CRU-206, in every client).
   The shared transport, `http_request`, catches `HTTPError`, `URLError` and `TimeoutError` only. A board that
   resets the connection after taking the request raises `RemoteDisconnected` or `ConnectionResetError` out of
   it: the verb ends `verb-failed` with no `run:` block and no `ingest:` line, and a gate's suite carries no
   `gate-suite-unreported`. The exit is 1, so nothing reads as green, but the envelope does not say what
   happened.

## Design (user rulings 2026-10-30)

- The module is split, rather than the guard's threshold raised (which would let bare five-digit ports fire as
  line citations) or the reader kept in the arduino client.
- The run emitter is lifted once into the shared code, and the clients that have one call it.
- A connection reset at any request is answered as the transport's other failures are: an `ok: false` answer
  naming the board and the error, so the ingest reports it, the verb carries no figures, and a gate names the
  suite unreported.
- Apart from the reset, behaviour does not change: every client verb, envelope and exit reads as before.

To be decided at this CR's gap analysis, and put to the user as design forks:

- which cohesive block, or blocks, leave the module, and how much headroom the split leaves;
- how the clients reach the moved code: a second module loaded by path, as `_axi()` loads this one, or
  this module loading it and re-exporting it, so no client changes;
- what follows the new file: the installer's wheel (`test_crucible_axi_wheel_packaging.py`), the fleet
  inventory and route censuses that read `_crucible_axi.py` by name (`SHARED_INGEST` detection among them),
  `PROSE_CITATIONS`, and every `path:line` and by-symbol citation into the moved code;
- which other connection errors (`http.client.HTTPException` as a whole, `OSError`) the transport answers.

## Steps

Written at its gap analysis.

## Acceptance criteria

Written at its gap analysis, and at least:

- [ ] **AC1 — headroom.** Every in-scope file stays under the 10,000-line guard, with the shared modules leaving
      room for CR-CRU-220's reader.
- [ ] **AC2 — one emitter.** The bun, python and maven clients reach one shared run emitter, and none keeps its
      own.
- [ ] **AC3 — a reset is answered.** A board that resets the connection at the ingest POST gives the verb an
      `ok: false` answer naming the board: one `ingest:` line, no figures, exit 1, and a gate's suite named
      `gate-suite-unreported`, in each of the five clients.
- [ ] **AC4 — nothing else changes.** The full gate (bun and python suites) passes with no test's assertion
      edited beyond what reads the moved code's location.

## Non-goals

- Raising `BARE_LINE_IMPLAUSIBLE_THRESHOLD`.
- Any behaviour change in a client beyond the reset's answer.
