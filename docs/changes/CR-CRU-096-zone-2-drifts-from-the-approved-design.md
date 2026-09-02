# CR-CRU-096 — zone 2 drifts from the approved flowchart design

- **Type**: patch
- **Wave**: 5 (0.2.0) — zone 2 is a 0.2.0 surface delivered by CR-078; the drift should be closed
  inside the release that introduced it, not carried past the tag. Release membership is the
  user's call.
- **Depends on**: 078, 095 — 095 makes the published queue order canonical across containers (`listQueue` gains release→wave→seq). Zone 2 renders one box per wave of the focused release and its rows come from that published order, so the ordering contract is settled BEFORE the renderer is specified against it. Within-wave order is unchanged by 095 (its AC3), so AC10's wave-5 fixture is unaffected; the edge exists for the multi-wave and cross-container assertions.
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

`public/app.js:2797`:

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

`data-cr-count` is on the element (`public/app.js:2791`) and correct. Nothing renders it; the label
is `Wave ${box.wave}` and nothing else (`:2802`). Under §S5 the header becomes the **only** place
the wave's true size is stated, so this stops being cosmetic.

### §S3 — the merged roll-up is absent

The design states the merged CRs as one line — `21 merged ✓ awaiting the tag` — a count plus the
release's gate state. Neither part exists. `resolveGateDate` (`public/app-logic.mjs:80-88`, CR-078
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

- `next` on the **first actionable row in the published order** — where actionable is
  `status === "PENDING"` with no `lifecycle` disposition, the same predicate the fleet clients
  already apply (`clients/_crucible_axi.py:1301`). It is a **projection of published fields**, not
  the plan pointer.

  **It is deliberately NOT the plan pointer, and this is a narrowing decided 2026-09-02.** The
  scheduling decision is AUTHORED by Mainline with the user (wave, release, `seq`, deps) and
  `next` is the pointer that reads it out for the executing orchestrator — single-track that is
  Mainline itself, multi-track it is each track's own. That pointer (`resolve_next`, `clients/_crucible_axi.py:1473`, with `_next_trigger:1392`
  and `_next_answer:1450`) is **client-side Python and has no server publisher** — `decision`
  appears zero times in `src/v2.ts` and `src/store.ts`, and `refetchRoadmap` fetches only
  queue/releases/release-proposals. Rendering the pointer here would mean reimplementing
  NEXT/HOLD/DRAINED in JS: a second oracle in a second language, which is exactly what CR-091
  AC18 outlawed for `seq` and what CR-095 §S1 spent five cycles deleting from the client.

  The two answers demonstrably differ: on 2026-09-02 the CLI answered
  `HOLD CR-CRU-096, trigger: in-flight CR-CRU-095` while the first actionable row was 096 — the
  CLI said wait, this marker says next-in-line. So the marker means **"first in line"**, never
  "start this now", and **zone 2 does not represent HOLD or DRAINED at all**. Publishing that pointer
  server-side, so a surface can READ it instead of recomputing it, is CR-CRU-098.
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

**The DN's "only where informative" rule is superseded here, explicitly.**
`docs/research/DN-crucible-roadmap-view.md:21` draws a wave "only where informative (more than one
track, or more than one wave in a release)" — which would draw NO box for a one-wave, one-track
release, the exact shape of 0.2.0. The approved artifact (2026-08-28, later authority) draws
`WAVE 5 · ACTIVE` with a count, a roll-up and rows for precisely that case, because in an
in-flight release the box carries the work, not the wave arithmetic. CR-078 applied the DN's rule
to zone 3 (its AC12: a `wave` column only when the release spans more than one wave) and left zone
2 unconditional; that split is now deliberate and recorded, not an oversight. Zone 3 keeps the DN
rule; zone 2 always draws the focused release's waves.

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
- **The zone-2 badge's level of DETAIL, and the node rectangle's own treatment.** C2 FIX reported
  both as silences: the node badge repeats `lifecycleBadge`'s full text (*"superseded by CR-X"*,
  *"void · abandoned — <reason>"*) which sits between §S5's "zone 3 is the detail surface" and §5's
  "nodes are id + terse status with no title"; and `.app-flow-node[data-lifecycle]` has no rule, so
  a VOID member draws a normal PENDING rectangle with a struck badge inside it. **Both are
  PRE-EXISTING behaviour, unchanged by this CR** — §S8's audit read the live surface and judged it
  compliant, so neither is drift against the approved design and neither is 096's to change. AC9b
  restores exactly what was there. If the detail level is wrong it needs its own CR arguing it.
- **Re-litigating AC24.** Motion stays reserved for IN_PROGRESS.
- **Zone 1 and zone 3.** Both match the design; this CR is zone 2 only.
- **A tooltip, a pager, or a scroll container.** All three rejected above.
- **Making a shipped release plannable, or auto-proposing one.** Out of scope.
- **Rendering the plan pointer.** `next`/HOLD/DRAINED need a server publisher; that is
  CR-CRU-098. Zone 2 shows position in the published order only.

## Acceptance criteria

- **AC1** — A wave in the focused in-flight release publishes `data-active="true"` with no CR
  IN_PROGRESS; a wave in a shipped or unfocused release publishes `false`.
- **AC2** — The wave header renders the `· active` marker exactly when `data-active="true"`, as a
  word and a border, never motion.
- **AC3** — The header renders the **whole-membership** count of ITS OWN wave, equal to the
  wave element's `data-cr-count` (`public/app.js:2791`, `box.entries.length`) and unaffected by
  the trim. Fixture: a **two-wave** release, waves holding 28 and 3, showing 5 rows each, renders
  `28` and `3` — never the release view's `crCount` (`:2892`), which for a shipped tag is the
  ledger's `crs.length` and a different fact (AC21). A single-wave fixture cannot tell the two
  apart and does not satisfy this AC.
- **AC4** — Motion stays reserved for IN_PROGRESS: an active wave with no running CR renders no
  animation (AC24 regression).
- **AC5** — The wave renders the roll-up: `N merged` plus the phrase stating that the merged work
  is **not yet tagged**.
- **AC5a** — The roll-up is **ABSENT** when the wave has zero merged members. *Ruled 2026-09-02
  (C3 RED found AC5 had no absent clause while AC16 has one).* Symmetry with `+N more`: there is
  nothing to roll up, and the release gate already states its own state on the diamond. A
  `0 merged` line would be chrome reporting the absence of content.
- **AC5b** — The phrase is `awaiting the tag` for **every** proposed gate state — `absent`,
  `dated` and `unusable` alike. *Ruled 2026-09-02 (C3 RED found only the `absent` wording was ever
  specified).* Within zone 2 the focused release is always in flight, because a SHIPPED focus
  renders zero wave boxes (AC21) — so merged work in a wave is, in every case, merged but not yet
  tagged, and that is the whole fact the phrase states. Three different strings would invent
  distinctions that do not exist. The gate's date and state detail stays on the gate
  (`resolveGateDate`'s answer, rendered once) — the roll-up MUST NOT render a date, which would be
  the second date renderer CR-078 AC30 forbids.
- **AC5c** — The roll-up renders as a **SIBLING** of the header `h4`, inside the wave box, after
  the header and before every row. *Corrected 2026-09-02:* §S3 said "inside the wave header
  block", but the approved artifact renders `.wsum` as a sibling of `<h4>` — and a `div` inside an
  `h4` is invalid HTML, so the artifact's placement is the correct reading of "header block".
- **AC5d** — The `✓` the artifact shows (`21 merged ✓ · awaiting the tag`) is rendered, to match
  the approved design. It is decoration, not the channel: AC25's greyscale invariant is satisfied
  by the WORD `merged`, so nothing depends on the glyph.
- **AC6** — The roll-up counts **merged** entries in that wave, over the **whole** wave,
  independently of the trim: a synthetic wave of 28 with 22 merged renders `22 merged`, never
  `1 merged` (the shown rows) and never the project total.
- **AC6a** — **Merged means `COMPLETED` OR `COMPLETED_UNTRACKED`**, for both the roll-up count and
  the row exclusion. *Ruled 2026-09-02 after C2 RED asked.* They are the same fact at two
  luminances — `public/styles.css:1337` says so in the code: "COMPLETED_UNTRACKED is the SAME
  green, DIMMED — one hue at two luminances". An earlier draft of AC6 said "only `COMPLETED`",
  which would have made an untracked-merged member vanish from the count AND from the rows: counted
  nowhere, drawn nowhere. The roll-up and the trim MUST agree on this set or a member disappears
  from the surface entirely.
- **AC7** — The roll-up is **not** a CR rectangle: it carries no CR-node class and no
  `data-cr`, so it cannot be selected or drilled.
- **AC8** — Each shown CR renders as one full-width row: id left, status and annotation right. No
  wrapped chip grid remains.
- **AC9** — Merged CRs (AC6a) render **no rows**. The wave's rows are **actionable ∪
  IN_PROGRESS**. *Ruled 2026-09-02 after C2 RED found the contradiction:* AC9 first read "actionable
  CRs only" while AC12 defines actionable as PENDING-with-no-lifecycle — which EXCLUDES
  IN_PROGRESS, the very thing AC11 requires to be shown. Read literally the two ACs could not both
  hold. Rows are the union; "actionable only" was never meant to exclude running work, since zone 2
  exists to show what is being worked.
- **AC9a** — A `PENDING` row carrying a `lifecycle` disposition (VOID/SUPERSEDED) is not work and
  renders **no row in a TRIMMED wave**. *Ruled 2026-09-02.* No information is lost: zone 3's table
  carries the disposition (`public/app.js:2496` `data-lifecycle`, `:2535`
  `roadmap-lifecycle-badge`, and CR-078 AC27's lifecycle column), which is §S5's argument that
  zone 3 is the detail surface.
- **AC9b** — The zone-2 node's own lifecycle badge **STAYS**, and renders wherever a node renders.
  *This CORRECTS AC9a as first written, 2026-09-02.* AC9a claimed the badge "becomes unreachable
  and is REMOVED"; that premise was **false**, and C2 GREEN proved it with two live paths:
  1. the `wave: null` `app-flow-loose` group renders `box.entries` UNTRIMMED — which AC18a
     explicitly requires (`public/app.js:2785`);
  2. AC9's union is on STATUS, so an `IN_PROGRESS` member is drawn regardless of its `lifecycle`
     (`public/app-logic.mjs:1210-1238`).
  On both paths the removal left the disposition published as the `data-lifecycle` ATTRIBUTE with
  no rendered TEXT — which violates §S8's own invariant that *no element relies on colour alone;
  status is also written as text, so the view survives a colour-blind reader and a greyscale
  screenshot*. So the badge is restored. AC9a's row-exclusion stands; only its removal clause is
  withdrawn.
- **AC9c** — A CR that is `IN_PROGRESS` **and** carries a disposition renders as a row and keeps
  its badge. *Ruled 2026-09-02 (C2 GREEN reported the silence).* Running work is what zone 2
  exists to show, and its disposition is exactly the thing a reader needs to see beside it. It is
  not counted in `+N more`, which counts actionable only.
- **AC9e** — A dispositioned member the wave draws no row for is still counted in the header's
  whole membership. *Confirmed 2026-09-02:* AC3 says whole membership and means it — the count is
  `box.entries.length` and the trim never touches it. Only `+N more` excludes them, because that
  counts actionable work.
- **AC9d** — The consumer list in AC9a is **not** exhaustive and must not be read as a budget.
  *Recorded 2026-09-02:* the trim itself (AC9/AC9a/AC10 — a wave box no longer draws merged or
  dispositioned members) invalidated **28** assertions across `roadmap-release-focus`,
  `roadmap-visual-grammar` and `roadmap-selection-durability`, not the five AC9a named. Every one
  must be RE-POINTED at the surface that now carries the fact, never deleted or skipped; a trim
  may not retire an assertion as a side effect.
- **AC10** — The rows are the top of the scheduled queue in the order the server PUBLISHED
  (CR-095 §S1, consumed verbatim — no client re-sort), five by default. Fixture: a synthetic wave
  authored `CR-Q-1 … CR-Q-9` with `CR-Q-1` and `CR-Q-2` COMPLETED yields rows
  `CR-Q-3, CR-Q-4, CR-Q-5, CR-Q-6, CR-Q-7`.
- **AC11** — An IN_PROGRESS CR is present even when outside the top five. Fixture: activate the
  last scheduled CR — it still renders, with ember and motion.
- **AC11a** — Such a CR **EXTENDS** the list; it never DISPLACES a scheduled row. *Ruled
  2026-09-02 after C2 RED asked (§S5.2 "five by default" vs §S5.3 "always shown"; neither AC said
  which).* Displacing would hide a scheduled CR to show a running one and would break the
  pointer's arithmetic, which is `actionable total − actionable rows shown`; extending keeps the
  published order strictly intact with no client-side re-ordering (CR-091 AC18). The list is
  bounded in practice because a track runs one CR at a time, so the extras are at most the track
  count — well inside §S6's measured budget.
- **AC12** — The **first actionable row in the published order** renders a `next` annotation as
  **text**, on a row that keeps PENDING styling. It uses neither `▸` nor ember (§S8), and exactly
  one row is marked. Actionable is `PENDING` with no `lifecycle`; the marker is derived from the
  published payload ALONE.
- **AC12a** — The marker is **not** the plan pointer and no NEXT/HOLD/DRAINED logic is
  introduced in `public/`: no dependency walk, no in-flight trigger, no release gating. Fixture: a
  wave whose first actionable row has an unsatisfied dependency still marks that row `next`,
  because the marker states position in the published order and nothing else. Zone 2 renders no
  HOLD and no DRAINED state (CR-CRU-098 owns the published reading).
- **AC12b** — **Exactly one row in the whole ZONE is marked**, not one per wave box. *Ruled
  2026-09-02 (C3 RED found AC12's "exactly one" ambiguous against AC19's one-box-per-wave).* "What
  to take up next" is a single fact about the focused release; two markers would ask the reader
  which `next` is meant. So the marker goes on the first actionable row **among the rows the zone
  actually draws**, in the published order across every wave — which means `nextCr` is a
  VIEW-level fact, not a per-box one, and a wave box may render no marker at all.
- **AC12c** — The `wave: null` loose group renders `deps` like any other row, and is **eligible**
  for the single `next` marker. *Ruled 2026-09-02.* Arrangement is grammar and applies everywhere
  (AC18a's own reasoning); and excluding the group would leave a release whose only actionable work
  is unwaved with no marker anywhere, which is the one case the marker exists for.

- **AC13** — A pending row with dependencies renders `deps <ids>` naming **all** of them; fixture:
  a row declaring **four** deps names four, and the row's annotation slot holds them at the §S6
  width budget (four is the widest real case observed, so the budget is measured against four, not
  three). No deps → no annotation.
- **AC13b** — `deps` renders on a **`PENDING`** row only. *Confirmed 2026-09-02 (C3 GREEN took
  AC13's literal wording and asked).* A running row's dependencies are not decision-relevant — the
  work has already started — and a merged row's are history; zone 3's table carries the full
  dependency data for every row either way. AC13's "a pending row with dependencies" is therefore
  the rule and not an accident of phrasing.
- **AC13a** — `deps` names the **full published CR id**, never an abbreviated tail. *Ruled
  2026-09-02 (C3 RED raised it against AC29).* The approved artifact draws `deps 091, 092` with
  this project's `CR-CRU-` prefix stripped — an abbreviation that only works for a project whose
  ids share a prefix the product cannot know. Stripping it would be exactly the project-dependence
  AC29 forbids, and a synthetic `CR-A` has no numeric tail to strip.

- **AC14** — No tooltip and no `title` attribute is introduced on a wave row.
- **AC15** — A row's click still drills through (CR-078 C4 `data-drill-source` regression).
- **AC16** — `+N more` renders when scheduled CRs remain unshown, states the true remainder, and is
  absent when none remain. It carries no click handler.
- **AC17** — No scroll container inside the wave: computed `overflow` stays visible/unset, and the
  wave's height grows with the rows shown, not with membership.
- **AC18** — No `data-window-*` attribute and no `◀ earlier` / `N later` tag appears **within
  `[data-zone="2"]`**. The scoping is load-bearing and was confirmed by C2 RED: zone 1's strip
  legitimately publishes `data-window-size`/`data-window-offset`/`data-hidden-earlier`
  (`public/app.js:3116-3118`) and renders its own paging tags (`:3055`), which AC26 freezes. The
  `▶` glyph itself cannot be forbidden — it is IN_PROGRESS's own status mark, `▶ in progress`
  (`public/app-logic.mjs:1015`); only `◀` and the words *earlier*/*later* are.
- **AC18a** — The `wave: null` group (members declaring no wave, `public/app.js:2786`
  `app-flow-loose`) takes the **row arrangement** of AC8 but **not** the trim. *Ruled 2026-09-02:*
  it renders no header, so it has nowhere to state whole membership and no anchor for a `+N more`
  pointer — trimming it would hide rows with nothing declaring how many. Arrangement is grammar
  and applies everywhere; the trim needs a count to stay honest.
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
- **AC28** — The row keeps the node's IDENTITY attributes through the chip→row rewrite:
  `data-testid="roadmap-node"`, `data-cr` and `data-status` survive on every rendered row. Six
  consumers depend on them — `tests/roadmap-visual-grammar.test.ts`,
  `tests/roadmap-release-focus.test.ts`, `tests/roadmap-selection-durability.test.ts`,
  `public/styles.css`, and the e2e pair `tests/e2e/steps/roadmap-graph.steps.ts:84,96,102` driving
  `tests/e2e/features/roadmap-graph.feature:41-46` (wave 5 holds 1 node, PENDING → IN_PROGRESS,
  click drills). AC15 covers the drill only; this covers the selectors.
- **AC29** — **No AC fixture names a real CR of the project running Crucible.** Every fixture in
  this CR is synthetic (`CR-Q-n`, `CR-A`, `CR-W1-A`, the convention already used by
  `tests/queue-canonical-order.test.ts`'s siblings and `roadmap-graph.feature`'s `CR-RG-200`).
  Crucible is project-INDEPENDENT: its acceptance criteria state what the product guarantees for
  ANY board, so a criterion that only holds while our own backlog has a given shape is not a
  criterion. The live board may CORROBORATE a fixture (AC27 renders against it); it may never BE
  one.
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
