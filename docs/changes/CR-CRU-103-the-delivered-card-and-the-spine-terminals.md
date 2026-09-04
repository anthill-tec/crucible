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

**Three divergences were thought to survive that correction. Gap analysis 2026-09-04 measured them
and TWO do** — the delivered card and the terminals. The third (the wave border) was the same
measurement error in miniature: correct in the stylesheet, rounded by the browser. See §S3.

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

### §S3 — RETRACTED 2026-09-04 by gap analysis: the wave border already follows the design

This section claimed the wave box's border was `1px` against the design's `1.5px`. **Measured, both
sides:**

- `public/styles.css`'s `.app-flow-wave` rule already declares `border: 1.5px solid var(--line)` —
  byte-for-byte the design's `.wave` weight. There is nothing to change.
- Driving the live board in real Chromium at 1130px, `getComputedStyle` on the rendered wave box
  reports `borderTopWidth: 1px`. Chromium ROUNDS a sub-pixel border to whole device pixels at
  DPR 1, so `1.5px` declared is `1px` reported. The "live 1px" reading was that rounding, not a
  divergence.

So the premise was wrong AND the criterion it produced was unperformable: no change to the
stylesheet can make a DPR-1 render report `1.5px`, because the declaration is already correct and
the rounding is the browser's. Asserting it would require rendering at `deviceScaleFactor: 2`
purely to observe a value the stylesheet already states — machinery to watch a browser round.

Retracted in place rather than deleted: this is the third CR running whose defect was in a spec I
authored, and the pattern (a measurement taken through the wrong lens, then frozen as a criterion)
is the finding.

## Scope

**TWO** items — §S1's delivered card and §S2's terminals — plus §S4's widening of AC27, and nothing
else. §S3 is RETRACTED (the wave border already follows the design; see above), so the "three real
divergences" this CR was filed with are two. The design's type scale is already implemented (see the
Correction) and is not touched.

### §S4 — AC27 gains the geometry and chrome dimension it lacked

CR-CRU-096's AC27 compares the artifact to the render **structurally only** — panel count, the
horizontal axis, the 7-piece spine, `/^\d+ merged/`. It asserts no border width, radius,
`min-width` or box aspect, which is why a missing card and a non-square terminal both passed. The
comparison is widened to cover exactly those properties for the components the artifact depicts.

## Acceptance criteria

- **AC1** — The delivered summary renders as a CARD, measured on the rendered element: a visible
  border of the design's `1.5px` weight, corner radius `9px`, and a background elevated distinctly
  from the pane behind it. Asserted on computed/measured values through the app's own token, never a
  hex literal — and satisfied by any implementation reaching those measurements, not only by a
  `border` property.
- **AC1a** — Its laid-out width is BOUNDED: at least the design's `210px` floor, and no wider than
  its own content needs. **Added 2026-09-04 by gap analysis** — AC1 originally asked only for "no
  narrower than 210px", which the DEFECT already satisfies: the broken card measures **673px**, so a
  floor alone is passed by the very sprawl this CR exists to fix. The design contains it with
  `flex:0 0 auto` beside its `min-width`; the requirement here is the bound, not that mechanism.
- **AC2** — Its headline renders at mono **22px** and its cue at the design's 10.5px in the app's
  **sans** token; the two are provably different sizes and different family CLASSES in one render,
  so a flat mono run fails. Family is asserted as monospace-vs-sans, never a font name.
- **AC3** — With the card restored, the release gate is no longer DISPLACED: the shipped spine
  measures at or below the design's own shipped panel, both sides' flow gaps subtracted so the
  comparison is like-for-like, and the connector between card and gate is the design's width.
  Geometry, not CSS. **CORRECTED 2026-09-04, ratifying C1:** the original wording asked only that
  "the gap between the card and the gate is at most the design's connector width", which is TRUE of
  the BROKEN render too — `.app-roadmap-flow` packs from flex-start, so an uncontained card never
  opened a gap beside the gate, it PUSHED the gate right. That criterion could not fail. C1
  implemented both clauses and reported the defect; this is the wording catching up.
- **AC3a** — AC1/AC1a/AC2/AC3 are measured on a FIXTURE carrying a SHIPPED focus, not on the live
  board. **Added 2026-09-04 by gap analysis:** driving the live board in Chromium, no
  `.app-flow-delivered` element exists at all — the focused release is the 0.2.0 PROPOSAL, which
  draws no delivered summary. The live board may CORROBORATE and must skip with a named reason when
  it cannot, exactly as CR-CRU-102's AC4 does. CR-CRU-096's `AC29` governs: a criterion that only
  holds while our own board has a given focus is not a criterion.
- **AC4** — Terminals render **square** at the design's `52px` with its `2px` border, so the
  existing `999px` radius yields a circle. Asserted on the measured box, not the declared rule.
- **AC5** — RETRACTED 2026-09-04, with §S3. The wave border already declares the design's `1.5px`;
  a DPR-1 render reports `1px` because Chromium rounds sub-pixel borders. There is no divergence to
  close and no honest way to assert one at DPR 1.
- **AC6** — AC27's comparison covers border width, radius, `min-width` and box aspect for the
  components the artifact depicts, and FAILS when any one is moved away from the artifact. Proven
  by mutating one value in a scratch fixture, not by assertion alone.
- **AC7** — **AMENDED 2026-09-04 by user ruling** — a deliberate exception to the frozen-spec rule,
  taken because CR-CRU-103 is the CR that changes this geometry and the alternative was leaving
  `develop` red on a known-unsound assertion. CR-CRU-102's spine budget is re-measured under the
  `52×52` terminals, and its two halves are separated:
  - the SYNTHETIC board keeps asserting the design's `~600px` strictly — that is the criterion;
  - the LIVE board REPORTS its measured figure and asserts only the data-independent invariant that
    the spine FITS the surface. It no longer asserts `~600px`.

  Why: `~600px` is the design's figure for a SPECIFIC composition, while the live spine is whatever
  the drawn rows happen to make it. Measured: it SKIPPED at CR-CRU-102's merge (the four-dep row sat
  outside the drawn top), then closing that CR shifted the drawn rows, the assertion went live, and
  it failed at **621.1px** — drifting to **625.1px** within the hour as CR-CRU-104 was filed and
  CR-CRU-103 went IN_PROGRESS. This CR's terminal shrink takes 8px off it, reaching ~613px, so
  implementing CR-CRU-103 correctly could never have fixed it. Asserting a fixed-composition figure
  against data we do not control is the CR-CRU-096 `AC29` decay CR-CRU-102's own comment predicted,
  arriving in under a day.
- **AC8** — Zone 1 and zone 3 markup is byte-identical, as CR-CRU-096 AC26 required for its scope.
- **AC9** — The type-scale properties listed in the Correction are asserted as **unchanged**, so a
  future cycle cannot "fix" a scale that already matches. This is the guard my own wrong measurement
  would have needed. *Cost checked 2026-09-04: the suite today carries ZERO `fontSize`/`fontFamily`
  assertions, so this is new coverage rather than duplication, and its marginal cost is near zero
  because AC1/AC1a/AC2/AC4 are extending the same measurement harness anyway.*

## Knock-ons recorded 2026-09-04, ratifying C1

- **AC4 supersedes CR-CRU-078 `AC21`'s aspect clause for zone 2.** `AC21`'s `expectStadium` asserts
  "longer than it is tall", which a `52×52` circle cannot satisfy. Per the standing ruling that the
  design is the authority, zone 2's terminal takes an `expectCircle` (the same fully-round-ends
  clause, square box instead of longer-than-tall) and its test is renamed. Zone 1's
  `.app-strip-terminal` is a different rule, keeps its lozenge and keeps `expectStadium`. Recorded
  because a shipped CR's criterion changed meaning for one surface, and that must not be
  discoverable only from a diff.
- **§S1's `673px` is a LIVE-board figure.** On the design-content fixture the same defect measures
  `682.8px`. Same defect class, same magnitude — read the number as the live board's.
- **The `~600px` budget is the PROPOSED path's.** The design's own SHIPPED panel measures `689.3px`
  in the same engine (a `393.3px` delivered card plus a `120px` gate column). C1 read that off the
  artifact rather than inventing a constant, and subtracted each side's own flow gaps (the artifact
  declares `gap:0`, the app `8px`) so the comparison is like-for-like.

## Non-goals

- **The roadmap's type scale.** Already correct; re-measured and tabulated above.
- **App-wide body typography.** The design's `body{14px ui-sans-serif}` (`:16-17`) styles the mockup
  DOCUMENT, not the product shell; the app's `Inter 15px` is its own token system. **If the whole
  shell was intended, this is the line to overrule.**
- **Colour.** Every colour token already matches, and the app's `--bg*` values are byte-identical to
  the artifact's.
- **Font names.** Per the user's ruling, criteria assert family class against the app's existing
  `--mono` / `--sans` tokens.
- **The terminal's remaining chrome.** The artifact's `.term` also declares `background: var(--bg-2)`
  and mono `10.5px`, and its border colour is the literal `#4a5160` — no token of this app. AC4
  asserts square / `52px` / `2px` only. Colour is already a non-goal and a hex literal is forbidden,
  so the border stays `var(--line)`, the app keeps its `600 10px` uppercase word, and no fill was
  added. **If the design's fill and 10.5px are wanted, they need their own AC.**
- **The cue's separator as markup.** The design writes one cue line (`waves 1–4 · shipped
  2026-08-19`); the app publishes the wave span and the ship date as separate elements, the date
  being `resolveGateDate`'s own answer. C1 drew the join in CSS, suppressed when that answer is
  empty so no dangling separator punctuates a fact the release lacks. No markup was added, and none
  is required by an AC.
