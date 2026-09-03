# CR-CRU-103 — the delivered summary card and the spine's terminals follow the design

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 102 — that CR re-measures the spine budget, and this one changes the terminal
  geometry the budget is measured against, so they land in order
- **Status**: PENDING (0.2.0) — filed 2026-09-03, **scope corrected the same day**
- **Found by**: the user, comparing a screenshot of the live shipped-release view against the
  approved design. **Ruling: the design is the authority.** Second ruling: assert the font FAMILY
  CLASS, never a font name — Crucible already has its own `--mono`/`--sans` tokens.

## Correction — this CR was filed with a wrong divergence table

The first version of this spec claimed the roadmap's whole type scale had collapsed to sans 15px:
the wave header, the CR rows, the status pills. **That was wrong, and it was wrong because I
measured the flex WRAPPERS instead of the styled leaves.** A wrapper inherits the shell's
`--sans 15px`; the leaf inside it carries the mono rule.

Re-measured on the correct elements, the type scale **already follows the design**:

| element | design | live | |
| --- | --- | --- | --- |
| CR row (`.cr`, `:76`) | mono 11px | `.app-flow-node-cr` mono **11px** | matches |
| wave header (`.wave h4`, `:72`) | mono 10.5px uppercase | `.app-flow-wave-label` mono 10px uppercase | matches |
| row annotation (`.cr .t`, `:81`) | 10px | `.app-flow-node-status` 10px / `-annotation` 9.5px | matches |
| roll-up (`.wsum`) | mono 9.5px | `.app-flow-wave-rollup` mono 9.5px | matches |
| pointer (`.more`, `:120`) | mono 9.5px centred | `.app-flow-wave-more` mono 9.5px centred | matches |
| status pill (`.st`, `:100`) | mono 10.5px, border 1px, radius 999px | `.app-roadmap-status` mono 10px, border 1px, radius 999px | matches |
| zone 3 cells (`td.mono`, `:97`) | mono 11.5px | `.app-roadmap-cr` mono **11.5px** | matches |

`public/styles.css` applies `var(--mono)` at over sixty sites, and the app's `--bg`/`--bg-1`/`--bg-2`
tokens are byte-identical to the artifact's (`#0e1013` / `#15181d` / `#1c2027`). The design's type
system was implemented; my measurement method was the defect.

**Three real divergences survive that correction.** They are this CR's whole scope.

## Problem

### §S1 — the delivered summary has no card

Design `:82-84`:

```css
.delivered      { border:1.5px solid var(--line); border-radius:9px;
                  background:var(--bg-2); padding:10px 13px; min-width:210px }
.delivered .big { font-family:var(--mono); font-size:22px; line-height:1.15 }
.delivered .cue { font-size:10.5px; color:var(--ink-dim) }   /* NOT mono — inherits sans */
```

Measured live on a shipped focus (0.1.0): `.app-flow-delivered` renders with **border `0`, radius
`0`, transparent background and no `min-width`**, sprawling to **673px**; its `60 CRs` renders at
**11px** rather than 22px, and the whole caption renders mono, so the cue is mono too.

Two consequences, and the first is a layout defect rather than a styling one:

- **`min-width:210px` and the border are what make it a container.** Without them the caption
  sprawls and pushes the release diamond to the far right of the surface. The large empty gap in
  the user's screenshot is not a spacing bug — it is an absent box.
- **The hierarchy is gone.** The design reads as one number you take at a glance (`60 CRs`, 22px
  mono) above a small sans cue carrying the wave span, ship date and packages. At a flat 11px mono
  the count, the span, the date and two package names are one undifferentiated run.

### §S2 — the terminals are lozenges, not circles

Design `:34-35`: `.term` is `52×52`, `border-radius:999px`, `border:2px solid #4a5160`, mono
10.5px — a **circle**. Live: `.app-flow-terminal` is **56×22** with `border:1px` and 10px — a
lozenge. The radius is already `999px`, so the shape is wrong only because the box is not square.

### §S3 — the wave box border is thinner than specified

Design `:70`: `.wave` carries `border:1.5px solid var(--line)`. Live: `1px`. Minor, and stated
because the design states it.

## Scope

The three items above, and nothing else. The design's type scale is already implemented (see the
Correction) and is not touched.

### §S4 — AC27 gains the geometry and chrome dimension it lacked

CR-CRU-096's AC27 compares the artifact to the render **structurally only** — panel count, the
horizontal axis, the 7-piece spine, `/^\d+ merged/`. It asserts no border width, radius,
`min-width` or box aspect, which is why a missing card and a non-square terminal both passed. The
comparison is widened to cover exactly those properties for the components the artifact depicts.

## Acceptance criteria

- **AC1** — The delivered summary renders as a card: border `1.5px`, radius `9px`, an elevated
  background distinct from the pane behind it, and `min-width` at least `210px`. Asserted through
  the app's own token, never a hex literal.
- **AC2** — Its headline renders at mono **22px** and its cue at the design's 10.5px in the app's
  **sans** token; the two are provably different sizes and different family CLASSES in one render,
  so a flat mono run fails. Family is asserted as monospace-vs-sans, never a font name.
- **AC3** — With the card restored, the gap between the delivered card and the release gate is at
  most the design's connector width — the layout defect the user reported, asserted as geometry
  rather than as CSS.
- **AC4** — Terminals render **square** at the design's `52px` with its `2px` border, so the
  existing `999px` radius yields a circle. Asserted on the measured box, not the declared rule.
- **AC5** — The wave box border is `1.5px`.
- **AC6** — AC27's comparison covers border width, radius, `min-width` and box aspect for the
  components the artifact depicts, and FAILS when any one is moved away from the artifact. Proven
  by mutating one value in a scratch fixture, not by assertion alone.
- **AC7** — CR-CRU-102's spine budget assertion is re-measured under the `52×52` terminals and
  still holds at the design's `~600px`.
- **AC8** — Zone 1 and zone 3 markup is byte-identical, as CR-CRU-096 AC26 required for its scope.
- **AC9** — The type-scale properties listed in the Correction are asserted as **unchanged**, so a
  future cycle cannot "fix" a scale that already matches. This is the guard my own wrong
  measurement would have needed.

## Non-goals

- **The roadmap's type scale.** Already correct; re-measured and tabulated above.
- **App-wide body typography.** The design's `body{14px ui-sans-serif}` (`:16-17`) styles the mockup
  DOCUMENT, not the product shell; the app's `Inter 15px` is its own token system. **If the whole
  shell was intended, this is the line to overrule.**
- **Colour.** Every colour token already matches, and the app's `--bg*` values are byte-identical to
  the artifact's.
- **Font names.** Per the user's ruling, criteria assert family class against the app's existing
  `--mono` / `--sans` tokens.
