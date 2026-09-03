# CR-CRU-102 — dependency annotations return to the design's bare form

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: none — the annotation is a rendering of data already published
- **Status**: PENDING (0.2.0) — filed 2026-09-03
- **Found by**: the user, reviewing the approved design against the shipped board after CR-CRU-097

## Problem

The approved design (`.lavish/crucible-workflow-flowchart.html`, approved 2026-08-28) writes a
dependency annotation as a **bare number**. Zone 2, lines 195-198:

```
CR-CRU-096   deps 078
CR-CRU-079   deps 078
CR-CRU-093   deps 006
```

and zone 3's row grammar, line 235, states it in words: *"CR id + brief title + **bare
depends-on** + status + cycle overlay"*.

The shipped board renders the **full published id** in both zones, verified live 2026-09-03:

| surface | design | shipped |
| --- | --- | --- |
| zone 2 annotation | `deps 078` | `deps CR-CRU-078` |
| zone 2, four deps | `deps 014, 091, 092, 095` | `deps CR-CRU-014, CR-CRU-091, CR-CRU-092, CR-CRU-095` |
| zone 3 depends-on cell | `001` | `CR-CRU-001` |

### This is an orchestrator-authored divergence, not a drift

CR-CRU-096's `AC13a` required "the full published CR id" and pinned it byte-exactly in tests. That
AC was **not in CR-096 as filed**; it was written during implementation in answer to a RED agent's
question, without the design being consulted. The design had already answered.

### It broke the design's load-bearing measurement, and a second invented AC papered over that

The approved design's whole argument for a **horizontal** spine is a measurement, lines 183-184:

> One CR per row, merged collapsed to the summary and only the scheduled top shown puts the box at
> **~300px** and the budget at **~600px**: the spine fits comfortably … A multi-wave ACTIVE release
> is therefore the case that widens this zone, and **the spine budget must be read per wave box**.

Measured in the user's own browser on 2026-09-03, the live wave box is **452.7px** — 50% over the
design's figure — because `CR-CRU-075` carries four dependencies and each renders as a full id. Two
such boxes exceeded the 991px surface, and the response at the time was to write **`AC19d`**, a new
"boxes WRAP onto a further line" degradation, into CR-096's spec.

That inverted the design twice over: the design had already ruled how multi-wave is handled (per
wave box, each ~300px, so they fit), and the widening it was ruled against was itself caused by an
invented AC. Restoring the bare form removes the cause, so the fallback has nothing to fall back
from.

## Scope

### §S1 — the annotation renders the bare dependency number, both zones

Zone 2's `deps` annotation and zone 3's depends-on cell render the dependency's bare number, as the
design writes it. The underlying data is untouched: `dependsOn` continues to carry full ids on the
wire, and every consumer that reads them — deep links, the dependency-order warning, drill-through —
continues to read full ids. This is a rendering change only.

### §S2 — `AC19d` is retired

CR-CRU-096 `AC19d` (wrap-as-degradation) and its Chromium test are removed, and the §S6 note that
motivated them is corrected to record why: the widening was self-inflicted. AC19c stays — the boxes
lie ALONG the axis — and keeps its fit guard, which is the assertion that actually protects the
design's premise.

The design's own rule is restored as the governing one: **the spine budget is read per wave box**.

## Acceptance criteria

- **AC1** — Zone 2's annotation renders `deps 078`, not `deps CR-CRU-078`; a multi-dependency row
  renders `deps 014, 091, 092, 095`. Asserted on the rendered DOM.
- **AC2** — Zone 3's depends-on cell renders the bare number.
- **AC3** — `dependsOn` on the wire is unchanged, and every non-rendering consumer still reads full
  ids: deep-link/drill-through targeting, and the dependency-order warning naming offending pairs.
  Proven by exercising those paths, not by inspecting the payload alone.
- **AC4** — Measured in real Chromium at the design's 1130px surface: the wave box for the live
  board's widest real row (four dependencies) is at or below the design's **~300px**, and the spine
  at or below its **~600px** budget. The design's measurement becomes a test rather than a claim.
- **AC5** — `AC19d` and its wrap test are gone, and no test asserts wrapping as intended
  behaviour. AC19c and its fit guard survive unchanged.
- **AC6** — CR-CRU-096's `AC13a` byte-exact annotation assertions are updated to the bare form, and
  the AC13a text is corrected in place with a note that the full-id form contradicted the approved
  design. The synthetic fixtures CR-CRU-097 moved them onto are kept.

## Open question — NOT ruled here

With bare deps the box returns to roughly the design's ~300px, so two or three wave boxes fit the
991px surface the Project rail leaves. The design states the budget is read per wave box but does
not say what happens when a release spans **more waves than the surface can hold**. `AC19d` was an
answer invented without asking; it is being removed rather than replaced.

This CR therefore leaves the question open and does not implement any fallback. If a release ever
spans that many waves, the behaviour is the user's to decide.

## Non-goals

- **Changing `dependsOn` on the wire.** Full ids stay in the data; only the rendering changes.
- **Re-deriving or re-ordering anything.** The dependency-order warning keeps its current
  semantics; this CR touches presentation only.
- **Editing CR-CRU-096's shipped history.** AC13a's text is corrected and AC19d retired because
  this CR says so; the merge and its record stand.
