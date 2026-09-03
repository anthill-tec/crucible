# CR-CRU-103 — the roadmap's type scale and chrome follow the design

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 102 — that CR restores the design's annotation grammar and re-measures the spine
  budget; this one changes the geometry the budget is measured against, so they must land in order
- **Status**: PENDING (0.2.0) — filed 2026-09-03
- **Found by**: the user, comparing a screenshot of the live shipped-release view against the
  approved design. **Ruling: the design is the authority.**

## Problem

The approved design (`.lavish/crucible-workflow-flowchart.html`, approved 2026-08-28) specifies a
deliberate **micro type scale** for the roadmap — monospace at 9–11.5px for structural labels, with
one 22px headline — plus **card and pill chrome** on its containers. The shipped surface renders
much of it in the app's default sans 15px with no chrome.

Measured in the user's own Chrome, 2026-09-03. Design values are the artifact's own CSS, cited by
line:

| element | design | live | divergence |
| --- | --- | --- | --- |
| delivered summary card (`:82`) | border `1.5px`, radius `9px`, bg `--bg-2`, `min-width:210px` | border `0`, radius `0`, transparent, sprawls **673px** | **card absent** |
| `.delivered .big` (`:83`) | mono **22px** | **11px** | no headline |
| `.delivered .cue` (`:84`) | **sans** 10.5px | **mono** | wrong family |
| wave header `h4` (`:72`) | **mono 10.5px**, uppercase, ls `.3px` | **sans 15px** | wrong family + 43% larger |
| CR row `.cr` (`:76`) | **mono 11px** | **sans 15px** | wrong family + 36% larger |
| status pill `.st` (`:100`) | mono 10.5px, border `1px`, radius `999px`, pad `1px 7px` | mono 10px, border `0`, radius `0`, pad `0` | **pill chrome absent** |
| terminal `.term` (`:34`) | **52×52** circle, border `2px`, mono 10.5px | **56×22** lozenge, border `1px`, 10px | wrong shape |
| wave box `.wave` (`:70`) | border `1.5px` | border `1px` | thinner |
| `.more` (`:120`) | mono 9.5px, centered | mono 9.5px | **matches** |
| roll-up | mono 9.5px | mono 9.5px | **matches** |

### Why the missing card is a layout defect, not a styling nit

`.delivered`'s `min-width:210px` and border are what make it a **container**. Without them the
delivered text sprawls to 673px and pushes the release diamond to the far right of the surface —
the large empty gap visible in the user's screenshot is not a spacing bug, it is a missing box.

### Why the type scale is information design, not theming

The design makes the delivered summary a **22px mono headline** (`60 CRs`) above a small sans cue
carrying the wave span, ship date and packages. Live renders headline and cue at the same 11px mono,
so the CR count, wave span, ship date and two package names read as one undifferentiated run. The
hierarchy the design encodes — one number you read at a glance, detail beneath — is gone.

The same applies to the wave header and CR rows: at mono 10.5/11px they read as structural labels
against the prose around them; at sans 15px they read as body copy, which is why the zone looks like
a list rather than a diagram.

### Why no test caught any of it

CR-CRU-096's AC27 compares the artifact to the render **structurally only** — panel count, the
horizontal axis, the 7-piece spine, `/^\d+ merged/`. It asserts no font, size, border, radius or
`min-width`. The entire typographic and chrome layer was unasserted, so it drifted silently while
every gate stayed green.

## Scope

### §S1 — the design's type scale is applied to the roadmap's own components

The delivered summary, wave header, CR row, status pill and terminals take the families, sizes and
letter-spacing the design specifies. Values come from the artifact, not from taste.

### §S2 — the design's container chrome is restored

`.delivered` becomes a card again (border, radius, background, `min-width`), the status pill regains
its border and radius, the wave box takes its `1.5px` border, and the terminals become 52×52
circles.

### §S3 — AC27 gains a typography and geometry dimension

The comparison that let this drift is widened: measured in real Chromium, the roadmap's components
match the artifact's specified family class (mono vs sans), size, border width, radius and
`min-width`, within a stated tolerance for device-pixel rounding. Structural comparison stays.

## Acceptance criteria

- **AC1** — The delivered summary renders as a card: border `1.5px`, radius `9px`, background
  `--bg-2`, `min-width` at least `210px`. Measured on the rendered element.
- **AC2** — Its headline renders at mono **22px** and its cue at **sans** 10.5px, and the two are
  provably different sizes in the same render — so a single flat run fails.
- **AC3** — With the card restored, the release diamond is no longer pushed to the surface's far
  edge: the gap between the delivered card and the gate is at most the design's connector width.
  This is the layout defect the user reported, asserted as geometry.
- **AC4** — The wave header renders mono at the design's size, uppercase with its letter-spacing;
  the CR row renders mono at the design's size. Both assert the family CLASS (monospace) rather than
  a specific font name, so the app's mono token may differ from the artifact's.
- **AC5** — The status pill renders with a border and a pill radius, not as bare text.
- **AC6** — Terminals render as circles at the design's diameter, not lozenges.
- **AC7** — AC27's comparison covers family class, size, border width, radius and `min-width` for
  every component §S1 and §S2 name, and FAILS when any one is changed away from the artifact.
  Proven by mutating one value in a scratch fixture, not by assertion alone.
- **AC8** — CR-CRU-102's spine budget assertion is re-measured under this CR's geometry (52×52
  terminals change the arithmetic) and still holds at the design's `~600px`.
- **AC9** — Zone 1 and zone 3 markup outside the components named here is byte-identical, as
  CR-CRU-096 AC26 required for its own scope.

## Non-goals

- **App-wide body typography.** The design's `body{font:14px/1.55 ui-sans-serif}` (`:16-17`) styles
  the mockup DOCUMENT, not the product shell; the app's `Inter 15px` is its own token system and is
  left alone. Only the roadmap components the design actually depicts are in scope. **If the intent
  was the whole shell, this Non-goal is the line to overrule.**
- **Colour.** Every colour token already matches; CR-CRU-096's greyscale and colour suites pass.
- **Changing any layout the design does not specify.** Where the artifact is silent, nothing
  changes — and the silence is reported rather than filled.
