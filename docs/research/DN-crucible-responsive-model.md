# DN — Responsive model (phone · tablet · desktop)

- **Status**: **APPROVED** (user, 2026-09-23) for decisions 1–8. The **per-surface section** below
  is PROPOSED and awaits a second approval.
  Micro-feature design note for the responsive behaviour of every Crucible surface.
- **Governing model**: `PRD-crucible-v2.md` (surfaces + density), `DN-crucible-roadmap-view.md`
  (roadmap visual contract, whose invariants this note inherits rather than restates).
- **Visual source**: storyboard mobile frames in `.lavish/crucible-v2-design.html`.
- **Why this DN exists**: CR-CRU-018's gap analysis (2026-09-23) measured the PRD as carrying
  **zero** occurrences of `responsive`, `mobile`, `phone` or `breakpoint`, and no DN covered the
  medium. The CR proposed a whole breakpoint system with no design authority behind it. This note
  is that authority. `.lavish/` is **gitignored**, so — exactly as the roadmap DN records — the
  storyboard cannot be read from a worktree or a clean checkout: where the artifact is present it
  is the richer visual reference and the two must agree; **where it is absent, this note governs.**
- **Implemented by**: CR-CRU-018. Supersedes the interim floor shipped by CR-CRU-023 §S1 *in scope
  only* — see decision 5, which keeps that floor alive rather than deleting it.

## The decisions

| # | Decision | Status |
| --- | --- | --- |
| **1** | **Three bands, named by what they are, not by device.** `phone ≤ 640px`, `tablet 641–1024px`, `desktop ≥ 1025px`. 1024 is not arbitrary: CR-CRU-023 §S1 already declares **1024×640 the minimum supported screen**, so the desktop band begins exactly where that guarantee ends and the existing desktop contract is left untouched. | approved |
| **2** | **One layout axis changes per band, never a redesign.** Phone: single column. Tablet: content keeps its column, the Project pane stacks beneath it. Desktop: today's `[content \| pane]` grid, pixel-unchanged. No surface gets a bespoke phone design; a band changes *arrangement*, not vocabulary. | approved |
| **3** | **Viewport collapse is EPHEMERAL and never writes the user's preference.** CR-CRU-093's rail flag is a persisted *user choice* (`localStorage`, `RAIL_STORAGE_KEY`, `public/app.js:2453-2487`). A narrow viewport collapses the pane **without touching that key**, so a phone visit cannot decide how the rail looks on the user's desktop. Returning to the desktop band restores the stored choice, whatever the phone did. One collapse mechanism, two independent triggers. | approved |
| **4** | **A touch target's floor outranks density.** Interactive rows/chips/cards measure **≥44px** in at least one dimension on touch media, *at every density*. Density stays the user's global control (`--row-pad`: comfortable 6px / compact 3px / ultra 1px, `styles.css:903-905`) and keeps working on a phone — it simply cannot shrink an interactive target below the floor. **Phones therefore do NOT default to compact:** compact exists to shrink rows, so defaulting to it while demanding 44px targets is self-defeating. The phone default is **comfortable**. | approved |
| **5** | **The 660px pane floor is SCOPED, not removed.** `.app-pane-content > * { min-width: 660px }` remains in force for `≥1025px` and is lifted below it, where content reflows to the band instead. It is load-bearing for at least eight consumers — `viewport-dual-axis-scroll.feature` (a scenario asserting it is *unchanged*), `viewport-pane-scroll-floor.feature`, `drilldown-dual-axis-scroll.feature`, `pane-scroll.steps.ts:156-165`, `roadmap-visual-grammar.test.ts` (`PANE_CHILD_FLOOR = 660`, AC11) and the badge-shape suites in `boundary-to-cycle-navigation` / `cycle-run-navigation`. Deleting it would red every one of them for no design gain. | approved |
| **6** | **No page-level horizontal scroll, at any band.** `scrollWidth ≤ innerWidth` on the document at every routed surface. Wide content — trees, diagnostics, raw output, the roadmap strip — scrolls **inside its own container**, which is the dual-axis contract CR-CRU-029 already shipped. Container scroll is the mechanism; page scroll is the defect. | approved |
| **7** | **The roadmap strip's paging rule is band-independent.** `DN-crucible-roadmap-view.md`'s invariant already states whole containers only: a narrower viewport shows **fewer** gates and a higher `◀ N earlier` count, **never a partial one**. This note adds nothing to it and may not weaken it. | inherited |
| **8** | **Nothing new is drawn.** Shape, colour and motion keep their meanings from the roadmap DN — shape says what a thing is, colour says where it stands, motion means live, and no element relies on colour alone. A band may relocate or stack an element; it may not invent a visual channel. | inherited |

## Per-surface behaviour — PROPOSED, awaiting approval

Decisions 1–8 govern the frame; these say what each SURFACE does inside it. Drawn as storyboard
frames **F15b–F15e**. The question that prompted them: *does the side project band get hidden?*
**It is never hidden** — decision 9 is the direct answer, and it leans on an invariant already in
this note: *a collapsed region still states what it holds*.

| # | Surface | Decision |
| --- | --- | --- |
| **9** | **Project band (right rail)** | **Relocates, never hides.** Desktop: today's right rail. Tablet: stacks beneath the content, full width. Phone: a **foot strip** carrying project name + live-agent count + health dot; tap expands it as a sheet over the content, tap the backdrop to close. Hiding it would remove the only surface answering *whose work is this*, and a hidden region cannot state what it holds. |
| **10** | **Roadmap** | The **release strip leads and never leaves the screen** (roadmap DN 7b) — it pages by whole containers, so a phone shows fewer gates and a higher `◀ N earlier` count. The **flowchart scrolls inside its own container** at every band (decision 6); it is not re-laid-out for portrait. The **scoped table becomes a stacked card list** on phone: one card per CR carrying id, status, wave and dependencies — the same columns, re-flowed, because a 6-column table cannot honour decision 6 at 640px. |
| **11** | **Workflow** | Cycle rows go full-width and **the row is the toggle** — which is exactly CR-CRU-146's fix, so the two CRs must not implement it twice: whichever lands first owns the hit area, the other asserts it. Nested affordances (`→ Runs`) stay separate ≥44px targets that `stopPropagation`. The active section stays above history; history stays collapsed by default. |
| **12** | **Runs · Coverage · Compile · BDD** | Run cards stack single-column, keeping agent · tier · codec · time (nothing is dropped to fit). The **drill-in fills the viewport** with `←` always visible, and its virtualization is unchanged. The coverage heat strip **enlarges its cells on touch media** rather than showing fewer. Compile diagnostics and raw output **scroll inside their container**, never the page. The BDD index lists runs newest-first with the cycle each belongs to. |

**What none of them may do:** drop a tab, drop a route, drop a control, or summarise data away to fit
the band. If information is worth hiding on a phone, that is a question about the desktop design,
not a licence to diverge.

## Deliberate exclusions

- **Native apps, PWA, offline, push.** Out of scope, as CR-CRU-018's non-goals already state.
- **Portrait-specific redesign of the graph views.** They scroll inside their container (decision
  6); they are not re-laid-out for portrait.
- **A phone-specific information architecture.** No surface gains or loses a tab, a route or a
  control because of its band. If a control is worth hiding on a phone it was worth questioning on
  a desktop.
- **Hover-only affordances as a category.** Touch equivalents are required (decision 4), but this
  note does not enumerate them per component; the storyboard mocks carry that detail.

## What a band MUST NOT change

These are the invariants an implementing agent may not trade away for a narrower screen:

- **Desktop is pixel-unchanged at ≥1280px**, asserted by the existing desktop scenarios re-running
  with zero modifications. A responsive change that edits a desktop scenario has broken this note.
- **The empty state stays the empty state.** CR-CRU-078's empty surfaces render no chrome implying
  data exists, and they name no CR id and no release version (`project-independence-strings`).
- **Density remains global and persisted** (`crucible.density.mode`); the band influences its
  *default* only, and only as decision 4 states.
- **A collapsed region still states what it holds** — the collapsed summary strip carries the same
  count/identity its expanded form would, so collapsing never hides the existence of data.
