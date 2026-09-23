# CR-CRU-018 — Responsive Crucible: mobile + tablet media support

**Status:** COMPLETED (0.3.0)
**Type:** feature
**Priority:** P3
**Depends on:** CR-CRU-015 (its BDD section renders this CR's viewport evidence; see the note below), CR-CRU-016 (final pane/drill-in geometry must exist first), CR-CRU-093 (the pane-collapse mechanism this reuses)
**Labels:** ui, responsive, mobile
**Phase:** Wave 7 (0.3.0)
**Design authority:** `docs/research/DN-crucible-responsive-model.md` (bands, collapse
persistence, touch-vs-density precedence, the 660px floor's scope) + storyboard frames
**F15** (phone) and **F15a** (tablet). Where the DN and this CR disagree, the DN governs.

> **NOTE FROM CR-CRU-015 (2026-09-18), so this CR's RED phase does not rediscover it.** The e2e
> suite's ordering constraint changed: `shell-storyboard.feature`'s F1 empty-DB precondition is now
> selected by an `@empty-db` TAG into its own `chromium-empty-db` project, and every other project
> depends on that one — nothing depends on the main body, so a body failure skips nothing. A mobile
> viewport project added here that re-runs the whole suite body **MUST carry
> `grepInvert: /@empty-db/`**, or it runs the ordering precondition a second time — which both reds
> `tests/e2e-suite-dependency-graph.test.ts`'s invariant (the precondition must run exactly once)
> and seeds the "empty" database ahead of that second run. One line; free if known up front.

## Context
**Interim floor already shipped by CR-CRU-023 (0.1.0 patch):** panes carry a
min-width + `overflow-x:auto` scroll floor for sub-1024×640 viewports; this
CR's responsive guidelines SUPERSEDE that floor with real breakpoints.

Crucible's layout is desktop-only: fixed multi-column grids (timeline +
Project pane), a wide projects row, hover-dependent affordances. On a phone
the dashboard is unusable. The density system (comfortable/compact/ultra) is
already global; this CR makes the LAYOUT adapt to the medium.

## Scope

### §S1 Breakpoint system
Forge-token breakpoints (**phone ≤640px · tablet 641–1024px · desktop ≥1025px**, DN
decision 1) applied
throughout: the projects row wraps/scrolls gracefully; home timeline goes
single-column full-width; the workspace's [content | Project pane] stacks
(pane collapses to an expandable summary strip under the tabs — this **reuses
CR-CRU-093's collapse mechanism**, viewport-driven here
rather than user-driven; two independent collapse implementations on one region
is a defect — and the viewport trigger is **EPHEMERAL: it MUST NOT write
`RAIL_STORAGE_KEY`**, the user's own persisted choice at `public/app.js:2453-2487`, so a
phone visit never re-styles the desktop; DN decision 3); the in-pane drill-in (CR-016) fills the viewport with the ← back
chip prominent; /manage and /roadmap slide-overs become full-screen sheets on
phones. The roadmap release strip pages by whole containers at every breakpoint
(CR-CRU-078): a narrower viewport shows **fewer** gates and a higher hidden
count, never a partial one.

**Per-surface behaviour (DN decisions 9–12, storyboard F15b–F15e).** The band changes
arrangement, never content — no surface drops a tab, a route or a control, and summarising data
away to fit is not an option:

- **The project band RELOCATES, never hides** (DN 9). Desktop: today's right rail. Tablet: stacked
  beneath the content, full width. Phone: a **foot strip** carrying project name, live-agent count
  and health dot, expanding to a sheet on tap with the backdrop dismissing it. It is the only
  surface that answers *whose work is this*, and a hidden region cannot satisfy this CR's own rule
  that a collapsed region still states what it holds.
- **Roadmap** (DN 10): the strip keeps leading and pages by whole gates; the flowchart **scrolls
  inside its container** and is not re-laid-out for portrait; the release-scoped table becomes a
  **stacked card list carrying the same columns** (id, status, wave, dependencies) — a six-column
  table cannot honour §S3 at 640px.
- **Workflow** (DN 11): cycle rows go full-width and **the row becomes the toggle**. This is the
  SAME hit area **CR-CRU-146** fixes. **Whichever CR lands first owns the implementation; the other
  asserts it.** Building it twice is the defect — the same rule §S1 already states for the pane's
  collapse. Nested affordances (the `→ Runs` badge) keep their own ≥44px target and
  `stopPropagation`.
- **Runs · Coverage · Compile · BDD** (DN 12): run cards stack keeping agent · tier · codec · time;
  the drill-in fills the viewport with `←` visible and its virtualization unchanged; coverage
  **enlarges its heat cells on touch media rather than showing fewer files**; compile diagnostics
  and raw output scroll inside their container.

### §S2 Touch affordances

Hover-only affordances get touch equivalents: tap targets ≥44px on
interactive rows/chips; the cursor-affordance rule translates to visible
pressed/active states; heat-strip cells enlarge on touch media. **The 44px floor
outranks density at every setting, and the phone default density is COMFORTABLE, not
compact** (DN decision 4): compact exists to shrink rows (`--row-pad` 6px → 3px,
`public/styles.css:903-905`), so defaulting to it while demanding 44px targets is
self-defeating. Density stays global, user-controlled and persisted; the band sets only its
default, and no density may shrink an interactive target below the floor on touch media.

### §S3 No horizontal overflow — ever

At every breakpoint, no page-level horizontal scroll; wide content (trees,
diagnostics, raw output) scrolls inside its own container.

**The CR-CRU-023 660px pane floor is SCOPED, never deleted** (DN decision 5).
`.app-pane-content > * { min-width: 660px }` stays in force at ≥1025px and is lifted below
it, where content reflows to the band. It is load-bearing for these ENUMERATED consumers,
which RED must re-point deliberately rather than discover:
`tests/e2e/features/viewport-dual-axis-scroll.feature` (§S2 scenario asserts the floor is
*unchanged*), `tests/e2e/features/viewport-pane-scroll-floor.feature`,
`tests/e2e/features/drilldown-dual-axis-scroll.feature`,
`tests/e2e/steps/pane-scroll.steps.ts:156-165` (`expect(minWidth).toBe("660px")`),
`tests/roadmap-visual-grammar.test.ts` (`PANE_CHILD_FLOOR = 660`, AC11), and the badge-shape
suites in `tests/boundary-to-cycle-navigation.test.ts` and `tests/cycle-run-navigation.test.ts`.

## Acceptance criteria

- [ ] BDD E2E with mobile viewport projects (Playwright devices "Pixel 7" or equivalent + a tablet profile) running a **dedicated `@mobile`-tagged feature**, not a second pass of the whole suite body: home renders single-column, no page-level horizontal scroll (scrollWidth ≤ innerWidth asserted on every routed surface + open drill-in). The mobile project carries `grepInvert: /@empty-db/` per the note above. Re-running the entire body at a second viewport would roughly double a suite measured at 9m27s for one invariant; the tagged feature buys the same protection.
- [ ] **The phone band runs on BOTH engines** (DN decision 13, user ruling 2026-09-23): `chromium-mobile` (Pixel 7, Blink) AND `webkit-iphone` (an iPhone profile on **WebKit**). A phone profile under Chromium proves geometry, not the platform — and §S3's subject matter (scroll containment, `100vh`, `-webkit-fill-available`, flex and grid edge cases) is exactly where the engines diverge. The phone ACs below are asserted under both; where a result differs by engine, this CR states which behaviour is the contract rather than asserting whichever happens to pass.
- [ ] **WebKit runs in BOTH places**: CI provisions it natively (both jobs' `bunx playwright install --with-deps` steps gain `webkit`), and LOCALLY it runs through the Docker Playwright Server in one command (`bun run webkit:docker`), pinned to the image matching `@playwright/test` and reaching the host's loopback-bound e2e server through Playwright's own `PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback>` tunnel — no bind widening, no re-addressed base URLs, no host firewall change. Plain `test:e2e` is endpoint-gated: `webkit-iphone` stays declared but collects nothing without a WebKit endpoint, so a local run never reds on an engine it cannot reach. Asserted on the config, so a future edit cannot quietly delete the project.
- [ ] Workspace on phone: tabs row wraps/scrolls in its own container; Project pane renders as the collapsed summary strip and expands on tap; the in-pane detail fills the viewport with the ← chip visible without scrolling.
- [ ] Touch targets: every interactive chip/row/card measures ≥44px in either dimension on the phone profile (sampled assertions on badges, tabs, cards, back chips), **and the floor holds at compact and ultra density too** — asserted, since density is the mechanism most likely to breach it.
- [ ] Density defaults to **comfortable** on phone media (overrideable by the toggle; persisted as usual, and the toggle still reaches compact/ultra).
- [ ] A narrow viewport's pane collapse leaves `RAIL_STORAGE_KEY` untouched: asserted by collapsing at phone width and reading the key, then restoring desktop width and finding the user's stored choice intact.
- [ ] The 660px floor still applies at ≥1025px — `pane-scroll.steps.ts`'s existing assertion passes unmodified — and is absent below the phone band.
- [ ] The project band is reachable at every band and never absent: on phone it renders as a foot strip stating project name, live-agent count and health, and expands to a sheet on tap; on tablet it renders stacked beneath the content. Asserted on presence and on the strip's stated content, so "collapsed" can never degrade into "gone".
- [ ] Roadmap on phone: the release strip still renders only whole gates with the remainder as the hidden-count tag, and the release-scoped table renders as cards carrying id, status, wave and dependencies — the same columns as the desktop table, asserted field-by-field so nothing is dropped to fit.
- [ ] The Workflow cycle row's hit area is implemented ONCE: if CR-CRU-146 has landed, this CR asserts its behaviour and adds no second handler; if it has not, this CR implements it and CR-CRU-146 becomes the assertion. Either way a test proves a single handler owns the row.
- [ ] Compile diagnostics and raw output scroll inside their own container at phone width with the page unscrolled, and the coverage heat strip's cells measure LARGER on the phone profile than on desktop while rendering the same file count.
- [ ] Desktop is pixel-unchanged at ≥1280px (the existing desktop BDD scenarios re-run green with zero modifications).

## Estimated size
M.

## Risk

Storyboard mocks are desktop-form — mobile mocks (a design micro-iteration on
the board) precede RED, per the storyboard-100%-compliance rule. **Discharged 2026-09-23:**
frames **F15** (phone) and **F15a** (tablet) drawn in `.lavish/crucible-v2-design.html`, and the
four suites that READ that artifact re-run green afterwards (67/67 — `storyboard-fidelity`,
`aggregate-headers`, `cycle-timers`, `workflow-history-refinements`). A tracked design artifact is
code: any later edit to those frames re-runs those four.

## Non-goals

Native apps; PWA/offline; push notifications; portrait-specific redesigns of
the graph views (they scroll).

## Implementation Notes

Recorded at close-out so nobody credits this CR with work it did not do, and so the next CR does not
rediscover what this one measured.

- **Three criteria were already met before this CR, and their tests are regression rails, not proof
  of new behaviour.** Each was settled by replaying RED's production files (`9efb9ed`) and running
  the scenario, and each passed there:
  - *Phone density defaults to comfortable* — `app.js`'s density default was already `comfortable`
    at every band; this CR changed nothing there. The real work in that scenario is the 44px floor.
  - *The workspace tabs row does not force page scroll* — at RED the row already spanned 388 of a
    412px Pixel 7 viewport (94%): it is a direct child of `.app-main`, not of the squeezed content
    column, and already wrapped via the pre-existing `.app-top { flex-wrap: wrap }`. The only change
    is the tab height, 22px → 44px, which is the touch floor's work and asserted separately.
  - *Compile diagnostics scroll inside their container* — satisfied by CR-CRU-016 §S1's page frame
    and CR-CRU-029 §S1's pane scroll box.
- **Two tests were vacuous as first written and were strengthened**: phone and tablet AC1. `body`
  and `.app-main` hide overflow, so `scrollWidth <= innerWidth` could not fail; at RED the phone
  content column had been squeezed to 116px. They now also assert the content region is visible at a
  usable width, and were proven to fail at RED.
- **CR-CRU-146's hit area is implemented here** (DN decision 11): one handler on the cycle row's line,
  reached by the label, status glyph, `▸ N runs` hint and empty space, with the `→ Runs` badge
  still stopping propagation. CR-CRU-146 can become assertion-only, with ONE gap: its AC1 asks for
  clicks "at several x-offsets", and the covering test runs in happy-dom, which has no layout or
  hit-testing — a pixel-aimed click needs a Playwright step, which CR-CRU-146 should own.
- **WebKit runs through a tunnel, not a re-addressed host.** The `hostmachine` design first specified
  was broken regardless of the firewall (the host-side `request` fixture inherits `use.baseURL`, and
  `hostmachine` does not resolve on the host). Playwright's own `PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback>`
  replaced it; the phone feature passed 9/9 on real WebKit on this workstation. See the DN's
  "WebKit provisioning" section.
- **The 660px floor's stated purpose was wrong; the rule stood.** Measured: the pane is already 688px
  at 1025px, so the floor cannot bind by narrowing anywhere in its own band. Overflow tests now force
  it with wide content, never a narrow viewport (DN decision 5, amended).
