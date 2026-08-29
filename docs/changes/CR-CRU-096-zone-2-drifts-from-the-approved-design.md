# CR-CRU-096 — zone 2 drifts from the approved flowchart design

- **Type**: patch
- **Wave**: 5 (0.2.0) — zone 2 is a 0.2.0 surface delivered by CR-078; the drift should be closed
  inside the release that introduced it, not carried past the tag. Release membership is the
  user's call.
- **Depends on**: 078
- **Status**: PENDING (0.2.0) — filed 2026-08-29
- **Found by**: the user, comparing the running board against the approved design artifact. Found
  by RENDERING both, which is the only way it was ever going to be found — see Notes.

## Problem

`.lavish/crucible-workflow-flowchart.html` §1 is the **approved** design (approved 2026-08-28) and
its zone-2 panel is captioned *"zone 2 · flowchart — only the active release gets wave detail"*.
CR-078 shipped zone 2. The two do not match, in layout and in content.

Reproduce both:

- **Design**: open `.lavish/crucible-workflow-flowchart.html`, §1, the `div.flow` following the
  `zone 2 · flowchart — only the active release` caption.
- **Live**: `GET /p/<key>/roadmap`, selector `[data-zone="2"]`.

| | approved design | live implementation |
| --- | --- | --- |
| flow axis | **horizontal**: `Start →` wave `→` gate `→ End`, with connectors | **vertical** stack, no connectors |
| wave header | `WAVE 5 · ACTIVE` + right-aligned count `20` | `Wave 5` — no marker, no count |
| wave summary | a row: `18 merged ✓ awaiting the tag` | absent |
| CR arrangement | full-width rows **stacked vertically** inside the wave | small chips **wrapped 7-per-row** |
| per-CR annotation | right-aligned `▸ next` / `deps 078` | none — only `✓ merged` / `pending` |
| wave border | ember, because the wave is ACTIVE | inactive colour (see §S1) |

### §S1 — "active" means the wrong thing, and that suppresses the chrome

`public/app.js:2795`:

```js
"data-active": box.entries.some((entry) => entry.status === "IN_PROGRESS") ? "true" : "false",
```

So a wave reads active **only while some CR is mid-run**. The design's `WAVE 5 · ACTIVE` is drawn
on a wave with 18 of 20 merged, 078 next and *nothing* in progress — so in the design "active"
means **this wave belongs to the focused, in-flight release**, which is also how §7's chrome table
uses it (*"Wave container | drawn when | the focused release is the active one"*).

Live, with 21 merged and 6 pending in the in-flight 0.2.0, the wave publishes
`data-active="false"`. Verified on the running board:

```
data-testid=roadmap-wave  data-wave=5  data-cr-count=27  data-active=false
```

This is the root cause of the *border* half of the drift, and it is a genuine semantic
disagreement rather than a missing feature.

`AC24`'s reservation of **motion** for an IN_PROGRESS CR is correct and stays. This CR separates
the two ideas that AC22 conflated: *the wave of the active release* (a border and a label marker)
versus *a CR that is actually running* (motion, ember, `▸`).

### §S2 — the count is computed, published, and never drawn

`data-cr-count="27"` is on the element (`public/app.js:2789`) and correct. The design draws it
right-aligned in the wave header. Nothing renders it, so the value round-trips into the DOM and
dies there. The wave label is `Wave ${box.wave}` and nothing else (`public/app.js:2800`).

### §S3 — the wave summary row is absent

The design draws one row inside the wave, before the CRs: `18 merged ✓ awaiting the tag` — a
merged roll-up plus the release's gate state. Neither part exists in zone 2. `resolveGateDate`
(`public/app-logic.mjs:82-88`, from CR-078 C1b) already computes the gate `kind`/`state` this
phrase needs, so the data is available and only the roll-up is new.

### §S4 — per-CR right-hand annotation is absent

The design's CR row carries an id on the left and an annotation on the right:

- `▸ next` on the CR that is next to be worked
- `deps 078` on a pending CR that has dependencies

Live nodes carry only `✓ merged` / `pending`. Note the design mock shows `▸ next` on CR-CRU-078
because that was the next CR when it was drawn; the drift is that **no** node ever receives the
marker, not that 078 specifically should.

`▸` is §5's IN_PROGRESS glyph, so §S4 must not overload it: the marker identifies the next
actionable CR, and motion remains reserved for a CR that is genuinely running (AC24).

### §S5 — the flow axis and its connectors

The design lays zone 2 out horizontally — `Start` stadium, wave container, release gate, `End`
stadium — joined by connectors, matching zone 1's spine. Live renders the same four elements
stacked vertically with no connectors. §5's shape grammar (*"Stadium — terminal. One Start, one
End"*) is satisfied; the **axis and the connectors** are not.

### Non-goals

- **Changing the shape/colour grammar.** §5 is satisfied today: nodes are `id + terse status`,
  never a title; the proposal gate is a dashed diamond; shipped gates are solid amber.
- **Re-litigating AC24.** Motion stays reserved for IN_PROGRESS.
- **Zone 1 and zone 3.** Both match the design; this CR is zone 2 only.

## Open question — the wave's layout at 27 CRs

**This needs a decision before §S5 can be implemented, and the design does not answer it.**

The design mock stacks CRs as full-width rows and shows two of them. Wave 5 really holds 27. A
27-row vertical stack is roughly 1000px tall, which is why the implementation almost certainly
chose a wrapped chip grid in the first place — that choice is defensible, it is simply not what the
approved artifact shows.

§14 solved unbounded growth for the **release strip** (paging, measured against the live 1130px
surface) and explicitly did not address the wave interior. So this is a real gap in the approved
design, not an implementation liberty.

Candidate resolutions, for the user to choose:

1. **Keep the wrapped chip grid** and amend the design artifact to match — cheapest, loses the
   right-hand annotation slot that §S4 needs.
2. **Full-width stacked rows with paging**, reusing §14's measured window mechanism inside the wave
   — matches the design and keeps §S4's annotation slot, at the cost of a second paged surface.
3. **Full-width rows for actionable CRs only** (pending/next/in-progress), merged CRs collapsed to
   a chip strip — the annotation slot exists exactly where it carries information, and the 21
   merged rows stop consuming vertical space.

Recommendation: **3**. It follows the design's own principle that only the active release earns
detail, applied one level down — only the CRs that still need attention earn a full row.

Acceptance criteria are deliberately **not** written for §S5 until this is decided; §S1–§S4 are
independent of the outcome and are specified above.

## Acceptance criteria

- **AC1** — A wave belonging to the focused in-flight release publishes `data-active="true"` with
  no CR IN_PROGRESS. A wave in a shipped or unfocused release publishes `false`.
- **AC2** — The wave header renders the `· active` marker exactly when `data-active="true"`.
- **AC3** — The wave header renders its CR count, and the rendered count equals the published
  `data-cr-count`. Fixture: a 27-entry wave renders `27`.
- **AC4** — Motion is still reserved for IN_PROGRESS: an active wave with no running CR renders no
  animation (AC24 regression).
- **AC5** — The wave renders a summary row with the merged roll-up (`N merged`) and the release's
  gate state phrase, sourced from `resolveGateDate`'s `state`.
- **AC6** — The roll-up counts only `COMPLETED` entries in that wave; a wave with 21 merged of 27
  renders `21 merged`, not `27` and not the project total.
- **AC7** — The next actionable CR receives a `next` annotation; every other node receives none.
  With six pending CRs, exactly one is marked.
- **AC8** — A pending CR with dependencies renders a `deps <ids>` annotation naming them; a pending
  CR with none renders no annotation.
- **AC9** — `▸`/motion is not reused for the `next` marker (AC4's separation, asserted from the
  rendered markup).
- **AC10** — Zone 1 and zone 3 markup is byte-identical before and after this CR.
- **AC11** — Visual: zone 2 rendered in real Chromium against the live board matches the design
  artifact's zone-2 panel on header content, summary row presence, and annotation slots.

## Notes

**This drift was invisible to every check I ran.** The gates are green (bun 1811/0, python 1272/0),
CR-078's own VERIFY phase asserted shape, colour, motion and zone order in real Chromium
(`tests/roadmap-visual-grammar.test.ts`, 1546 lines), and my own dogfood pass on 2026-08-29 read
zone 2's DOM and confirmed 078's `seq`-verbatim contract. None of it compared the result to the
**approved design**, because every one of those checks tested the implementation against *the
spec*, and the spec is what drifted from the artifact.

I also read the design artifact's zone-2 **text** during this session and concluded the content
gaps only. Text extraction cannot see layout: it flattened `Start → wave → gate → End` and a
vertical stack into the same token sequence. The layout drift was found only once both were
RENDERED and put side by side.

Lesson for the deferred register: an approved visual design is verified by rendering it next to the
implementation. Reading its markup or its text is not verification.
