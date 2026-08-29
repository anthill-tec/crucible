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

`.lavish/crucible-workflow-flowchart.html` is the **approved** design (approved 2026-08-28).
CR-078 shipped zone 2 against it. The two do not match — in layout, in content, and in what the
wave claims about its own state.

Reproduce both:

- **Design**: open the artifact; §1's `div.flow` after the `zone 2 · flowchart` caption for the
  ACTIVE release, and §2's for a SHIPPED one.
- **Live**: `GET /p/<key>/roadmap`, selector `[data-zone="2"]`.

| | approved design | live implementation | § |
| --- | --- | --- | --- |
| CR arrangement | full-width rows, one CR per row | chips wrapped 7-per-row | S5 |
| membership shown | merged rolled up; scheduled top only | **all 28**, merged included | S5 |
| flow axis | horizontal `Start → wave → gate → End`, connectors | vertical stack, no connectors | S6 |
| wave header | `WAVE 5 · ACTIVE` + right-aligned count | `Wave 5` — no marker, no count | S1, S2 |
| wave roll-up | `21 merged ✓ awaiting the tag` | absent | S3 |
| per-CR annotation | right-aligned `next` / `deps 078` | none — only `✓ merged` / `pending` | S4 |
| shipped release | delivered summary, horizontal | delivered summary, **vertical** | S7 |

### §S1 — "active" means the wrong thing

`public/app.js:2795`:

```js
"data-active": box.entries.some((entry) => entry.status === "IN_PROGRESS") ? "true" : "false",
```

A wave reads active **only while some CR is mid-run**. The design draws `WAVE 5 · ACTIVE` on a
wave with 18 of 20 merged, nothing running — so "active" means **this wave belongs to the focused,
in-flight release**, which is also how §7's chrome table uses it (*"Wave container | drawn when |
the focused release is the active one"*). Live, with 21 merged and 7 pending in the in-flight
0.2.0, the wave publishes `data-active="false"`. Verified:

```
data-testid=roadmap-wave  data-wave=5  data-cr-count=28  data-active=false
```

AC22 conflated two ideas. This CR separates them: *the wave of the active release* (border +
label marker) versus *a CR that is actually running* (ember + motion). CR-078 **AC24's reservation
of motion for IN_PROGRESS is correct and stays.**

### §S2 — the count is computed, published, and never drawn

`data-cr-count` is on the element (`public/app.js:2789`) and correct. Nothing renders it; the label
is `Wave ${box.wave}` and nothing else (`:2800`). Under §S5 the header becomes the **only** place
the wave's true size is stated, so this stops being cosmetic.

### §S3 — the merged roll-up is absent

The design states the merged CRs as one line — `21 merged ✓ awaiting the tag` — a count plus the
release's gate state. Neither part exists. `resolveGateDate` (`public/app-logic.mjs:82-88`, CR-078
C1b) already computes the gate `kind`/`state` the phrase needs, so only the count is new.

**The roll-up is wave chrome, not a CR row.** Shape encodes KIND and a rectangle means exactly one
CR (§5), so an aggregate must not wear the CR rectangle. It renders as a line inside the wave
header block, unbordered.

### §S4 — the annotation slot, inline

The design's row carries the id left and an annotation right — `next`, or `deps 078`. Live nodes
carry only `✓ merged` / `pending`. Because §S5 restores the full-width row, the slot exists again
and the annotation goes in it. **No tooltip** — an earlier draft put `deps` in a hover tooltip
because a 140px chip had no room; that needed `aria-describedby`, focus parity, and a guarantee it
never swallowed the chip's existing click-to-drill (CR-078 C4 `data-drill-source`). The row removes
the need for all three, and the information is visible rather than hidden behind a hover.

Slot contents:

- `next` on the CR that is next to be worked.
- `deps <ids>` on a pending CR with dependencies — the row fits the real list (`CR-CRU-075`
  declares three).

**`next` is a scheduling fact, not a state.** §5 reserves `▸` and ember for IN_PROGRESS ("the only
thing that ever moves"), so the marker is plain bold text on a row that keeps its PENDING styling.
Reusing the glyph or the colour would make a queued CR read as a running one.

### §S5 — one CR per row; merged rolled up; only the scheduled top shown

**User decisions, 2026-08-29.** The row arrangement is the design's own; the wrapped chip grid is
the drift. The trim is new, and it is what the artifact left open (§14 solved unbounded growth for
the release **strip** and explicitly not the wave interior).

Zone 2 answers one question — **what is being worked, and what is next.** It is not an inventory,
because zone 3's table already holds the detailed list. Therefore:

1. **Merged CRs collapse into §S3's roll-up.** They get no rows.
2. **The rows are the top of the scheduled queue** — the actionable CRs in authored `seq` order,
   five by default.
3. **An ACTIVE CR is always shown**, even when it falls outside those five, because an orchestrator
   may activate out of authored order. This is a guarantee, not a coincidence.
4. **A static `+N more — see the table below` pointer** when scheduled CRs remain unshown. It is a
   POINTER, not a control.

**No paging machinery, and no scroll container.** Not `◀ earlier` (nothing to the left is hidden —
it is summarised), not a pager for the remainder (the table is the detail surface), and not a
scroller. The artifact rules on scrolling for this surface, in the user's own correction of an
earlier proposal of mine: *"Paging, not scrolling"*; *"NO scroll container: a partially drawn
container is a defect"*; *"With paging, that bug cannot exist. Fewer moving parts and a stronger
guarantee."* Three reasons carry over to the wave: one overflow idiom per surface; no scroller
nested inside the pane scroller whose `scrollTop` CR-078 C4 already captures and restores
(`public/app.js:100-120`, `:1311-1333`); and every state stays screenshot-reachable for the visual
suite.

**Scope of the zone.** Zone 2 draws **every wave of the focused release** — one box per wave, not
one box. Crucible shows a single Wave 5 box only because 0.2.0 spans exactly one wave; 0.1.0
spanned waves 1–4. A multi-wave active release is the case that widens this zone, so §S6's budget
is per wave box.

### §S6 — the flow axis and its connectors

The design lays zone 2 out horizontally — `Start` stadium, wave, release gate, `End` stadium —
joined by connectors, matching zone 1's spine. Live stacks those four vertically with no
connectors. Measured, because the arrangement decision governs whether horizontal is possible:

| | live today (28 chips) | §S5 rows, trimmed | design's own |
| --- | --- | --- | --- |
| wave box | 1082 × 150 | **300 × 228** | 216 × 122 |
| horizontal budget¹ | 1378px | **596px** | 512px |
| available surface | 1130px | 1130px | 1100px |
| fits horizontally | **no**, over by 248px | **yes** | yes |

¹ `Start + arrow + wave + arrow + gate + arrow + End`, measured from the live board and from the
artifact's own `div.flow` children.

The vertical axis is a **consequence** of the uncapped grid, not an independent choice — so **§S6
depends on §S5 and must be implemented after it**, or the layout overflows.

### §S7 — the SHIPPED release path

For a shipped release, zone 2 must match §2: a **delivered summary, not a wave reconstruction**.

Verified live by focusing 0.1.0 — and it is largely right already: **0 wave boxes, 0 CR nodes**,
with `60 CRs`, `waves 1, 2, 3, 4`, `shipped 2026-08-19`, and both packages. Three deltas:

1. **Axis** — vertical with no connectors, the same §S6 defect. Fixing §S6 must fix both paths.
2. **Wave list** — enumerates `waves 1, 2, 3, 4`; the design compresses a contiguous run to
   `waves 1–4`.
3. **Gate label** — the diamond omits the `shipped` word the design shows inside it.

Live also carries package **versions** the design did not show. That is extra truth, not drift, and
is **kept**.

### §S8 — shape and colour grammar, everywhere

§5 defines two independent channels — **shape is the kind of thing, colour is its state** — plus
two invariants: *colour never encodes anything shape already says*, and *no element relies on
colour alone; status is also written as text, so the view survives a colour-blind reader and a
greyscale screenshot.*

Audited across the live surface: `COMPLETED_UNTRACKED` is the same green at lower luminance and
dims via **opacity** so it survives greyscale (`public/styles.css:1326-1333`); `in_progress` is
ember + motion reusing `app-run-pulse` rather than a third motion vocabulary (`:1338-1343`);
unfocused gates dim via `.app-strip-gate.on` opacity; the proposal gate is a dashed diamond; nodes
are id + terse status with **no title**, because the title is the table's column. Live introduces
no stray `▸`.

So this section adds no new colours or shapes. It constrains what §S1–§S5 introduce:

- the `next` marker is text, never `▸` and never ember (§S4);
- the roll-up is not a CR rectangle (§S3);
- the `+N more` pointer is not a node and must not read as one (§S5);
- the active-wave marker is a border and a label word, never motion (§S1).

### Non-goals

- **New shapes or colours.** §S8 constrains; it does not extend.
- **Re-litigating AC24.** Motion stays reserved for IN_PROGRESS.
- **Zone 1 and zone 3.** Both match the design; this CR is zone 2 only.
- **A tooltip, a pager, or a scroll container.** All three rejected above.
- **Making a shipped release plannable, or auto-proposing one.** Out of scope.

## Acceptance criteria

- **AC1** — A wave in the focused in-flight release publishes `data-active="true"` with no CR
  IN_PROGRESS; a wave in a shipped or unfocused release publishes `false`.
- **AC2** — The wave header renders the `· active` marker exactly when `data-active="true"`, as a
  word and a border, never motion.
- **AC3** — The header renders the **whole-membership** count, equal to `data-cr-count` and
  unaffected by the trim. Fixture: a 28-entry wave showing 5 rows renders `28`.
- **AC4** — Motion stays reserved for IN_PROGRESS: an active wave with no running CR renders no
  animation (AC24 regression).
- **AC5** — The wave renders the roll-up: `N merged` plus the gate state phrase from
  `resolveGateDate`'s `state`.
- **AC6** — The roll-up counts only `COMPLETED` entries in that wave, over the **whole** wave:
  21 of 28 renders `21 merged`, never `1 merged` and never the project total.
- **AC7** — The roll-up is **not** a CR rectangle: it carries no CR-node class and no
  `data-cr`, so it cannot be selected or drilled.
- **AC8** — Each shown CR renders as one full-width row: id left, status and annotation right. No
  wrapped chip grid remains.
- **AC9** — Merged CRs render **no rows**; the wave's rows are actionable CRs only.
- **AC10** — The rows are the top of the scheduled queue in authored `seq` order, five by default.
  Fixture: the live wave-5 order yields `095, 096, 079, 085, 093`.
- **AC11** — An IN_PROGRESS CR is present even when outside the top five. Fixture: activate the
  last scheduled CR — it still renders, with ember and motion.
- **AC12** — The next actionable CR renders a `next` annotation as **text**, on a row that keeps
  PENDING styling. It uses neither `▸` nor ember (§S8), and exactly one row is marked.
- **AC13** — A pending row with dependencies renders `deps <ids>` naming **all** of them; fixture:
  `CR-CRU-075` names three. No deps → no annotation.
- **AC14** — No tooltip and no `title` attribute is introduced on a wave row.
- **AC15** — A row's click still drills through (CR-078 C4 `data-drill-source` regression).
- **AC16** — `+N more` renders when scheduled CRs remain unshown, states the true remainder, and is
  absent when none remain. It carries no click handler.
- **AC17** — No scroll container inside the wave: computed `overflow` stays visible/unset, and the
  wave's height grows with the rows shown, not with membership.
- **AC18** — No `data-window-*` attribute and no `◀ earlier` / `later ▶` tag appears in zone 2.
- **AC19** — Zone 2 renders one box **per wave** of the focused release; a two-wave release renders
  two.
- **AC20** — With §S5 landed, zone 2 lays out horizontally — `Start`, wave, gate, `End` with
  connectors — and the rendered width does not exceed the measured surface (1130px at 1600px
  viewport).
- **AC21** — The SHIPPED path renders the delivered summary with **0 wave boxes and 0 CR nodes**,
  the CR count, the ship date, and every package with its version.
- **AC22** — The shipped path compresses a contiguous wave run: waves 1,2,3,4 render `waves 1–4`;
  a non-contiguous set renders the list.
- **AC23** — The shipped gate renders the `shipped` label inside the diamond.
- **AC24** — The shipped path uses the same horizontal axis as AC20.
- **AC25** — Greyscale invariant: every row and summary states its status in **text**; the zone
  renders meaningfully with colour removed.
- **AC26** — Zone 1 and zone 3 markup is byte-identical before and after this CR.
- **AC27** — Visual: zone 2 rendered in real Chromium against the live board matches the artifact's
  zone-2 panels — active and shipped — on axis, header, roll-up, row arrangement and markers.

## Notes

**This drift was invisible to every check I ran.** Gates are green (bun 1811/0, python 1272/0),
CR-078's VERIFY asserted shape, colour, motion and zone order in real Chromium
(`tests/roadmap-visual-grammar.test.ts`, 1546 lines), and my dogfood pass read zone 2's DOM and
confirmed the `seq`-verbatim contract. None of it compared the result to the **approved design**,
because every check tested the implementation against *the spec* — and the spec is what drifted.

**Reading the artifact's text is not reading the artifact.** I first extracted zone 2's text and
concluded content gaps only. Text flattens `Start → wave → gate → End` and a vertical stack into
the same token sequence. The layout drift appeared only when both were RENDERED side by side.

**Measurement reversed one of my own conclusions.** Having measured the uncapped grid at 1082px I
told the user the chip grid *forced* the vertical axis, so the implementation was not at fault on
§S6. The trim invalidated that: at 300px the budget is 596px and the spine fits. A geometric
impossibility is only established against the *final* content decision.

**And the grammar audit caught two violations in my own design panels**, not the code: I drew the
PENDING next-CR with ember and `▸` — using a state channel for a scheduling fact — and let the
merged roll-up wear the CR rectangle, so an aggregate read as a node. The second was inherited from
the original approved artifact; the instruction to enforce the grammar *everywhere* is what
surfaced it. Both are fixed in the artifact and pinned by AC7 and AC12.

**The artifact defeats shell grep.** `LC_ALL=C grep -a` on
`.lavish/crucible-workflow-flowchart.html` returns empty for strings it demonstrably contains
(`zone 2`, `scroll`, `paging`). Recover its text by reading the bytes in Python or by querying the
rendered DOM — same class of trap as `public/app-logic.mjs`'s NUL bytes, already in the deferred
register. A negative grep against this file means nothing.
