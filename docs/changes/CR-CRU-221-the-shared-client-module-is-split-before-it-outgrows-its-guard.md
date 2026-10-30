# CR-CRU-221 — the shared client module is split before it outgrows its guard

**Type** refactor · **Points** 8 (to be re-scored at its gap analysis) · **Wave** 8 (0.4.0) · **Depends on**
CR-CRU-218 · **Status** PENDING — filed 2026-10-30 (user ruling at CR-CRU-206's spec pre-review, F9: split
`clients/_crucible_axi.py` in its own CR, ahead of CR-CRU-220)

## Problem

`clients/_crucible_axi.py`, the module all five clients load, closed CR-CRU-218 at 9,997 lines.
`tests/citations-cite-by-symbol.test.ts` reads any bare number of five digits or more as a port, never a line,
and a self-test fails the day an in-scope file reaches 10,000 lines (`BARE_LINE_IMPLAUSIBLE_THRESHOLD`). The
module has one line left. CR-CRU-220 adds `junit_case_sources` to it (about 25–30 lines, user ruling: the
reader is shared), and every later shared helper would cross the guard too.

## Design (user ruling 2026-10-30)

- The module is split, rather than the guard's threshold raised (which would let bare five-digit ports fire as
  line citations) or the reader kept in the arduino client.
- Behaviour does not change: every client verb, envelope and exit reads as before.

To be decided at this CR's gap analysis, and put to the user as design forks:

- which cohesive block, or blocks, leave the module, and how much headroom the split leaves;
- how the clients reach the moved code: a second module loaded by path, as `_axi()` loads this one, or
  this module loading it and re-exporting it, so no client changes;
- what follows the new file: the installer's wheel (`test_crucible_axi_wheel_packaging.py`), the fleet
  inventory and route censuses that read `_crucible_axi.py` by name (`SHARED_INGEST` detection among them),
  `PROSE_CITATIONS`, and every `path:line` and by-symbol citation into the moved code.

## Steps

Written at its gap analysis.

## Acceptance criteria

Written at its gap analysis, and at least:

- [ ] **AC1 — headroom.** Every in-scope file stays under the 10,000-line guard, with the shared modules leaving
      room for CR-CRU-220's reader.
- [ ] **AC2 — nothing else changes.** The full gate (bun and python suites) passes with no test's assertion
      edited beyond what reads the moved code's location.

## Non-goals

- Raising `BARE_LINE_IMPLAUSIBLE_THRESHOLD`.
- Any behaviour change in a client.
