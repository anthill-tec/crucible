# DN — Crucible TOON Subset (RETIRED — pointer document)

**Author:** Antony John
**Co-author:** crucible orchestrator
**Status:** RETIRED by CR-CRU-046 (2026-08-01) — kept in place because CR-005, CR-030 and the storyboard reference it

## Current contract

Crucible speaks TOON per the OFFICIAL spec — toonformat.dev / the toon-format
GitHub org (github.com/toon-format). The spec, not this document, is the wire
contract. Two pinned implementations:

- **Server (TypeScript):** `@toon-format/toon` `^4.1.0` (the first-party
  reference implementation), pinned in `package.json`.
- **Clients (Python):** `clients/toon.py` — our spec-conformant port, validated
  against the official library by the CR-CRU-046 §S4 round-trip oracle
  (`tests/toon-conformance.test.ts` + `tests/client/test_cr046_official_toon_roundtrip.py`).

## Historical note

This document originally (2026-07-15) defined a private 4-construct TOON subset
as the fleet's wire format: at the time both producer and consumers were our own
fleet, no third-party TOON tooling existed, and a hand-pinned subset was the
cheapest way to bank the token-economy win (measured 47.1% of JSON bytes on the
flattened `events[]` brief after CR-CRU-006 §S0). The DN carried an explicit
revisit trigger for the arrival of third-party TOON tooling; that trigger fired
(official implementations now exist in 8 languages), and CR-CRU-046 retired the
subset on 2026-08-01 in favour of the official spec on both stacks.

## Revisit pin (§S2)

Adopt PyPI `toon-format` the day upstream ships a working release — as of
2026-08-01 the published 0.1.0 is a NotImplementedError stub. The §S4
round-trip gate above is the ready-made acceptance test for that swap.
