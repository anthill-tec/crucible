# DN — Responsive model (phone · tablet · desktop)

- **Status**: **APPROVED** (user, 2026-09-23) for decisions 1–8, and **INITIAL APPROVAL** (user,
  2026-09-23) for the per-surface decisions 9–12 below — given against storyboard frames F15b–F15e,
  so a later refinement of those frames may refine these rows.
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
| **3** | **Viewport collapse is EPHEMERAL and never writes the user's preference.** CR-CRU-093's rail flag is a persisted *user choice* (`localStorage`, `RAIL_STORAGE_KEY` in `public/app.js`, read in the body of `main`). A narrow viewport collapses the pane **without touching that key**, so a phone visit cannot decide how the rail looks on the user's desktop. Returning to the desktop band restores the stored choice, whatever the phone did. One collapse mechanism, two independent triggers. | approved |
| **4** | **A touch target's floor outranks density.** Interactive rows/chips/cards measure **≥44px** in at least one dimension on touch media, *at every density*. Density stays the user's global control (`--row-pad`: comfortable 6px / compact 3px / ultra 1px, the `:root.app-density-*` rules in `public/styles.css`) and keeps working on a phone — it simply cannot shrink an interactive target below the floor. **Phones therefore do NOT default to compact:** compact exists to shrink rows, so defaulting to it while demanding 44px targets is self-defeating. The phone default is **comfortable**. | approved |
| **5** | **The 660px pane floor is SCOPED, not removed.** `.app-pane-content > * { min-width: 660px }` remains in force for `≥1025px` and is lifted below it, where content reflows to the band instead. It is load-bearing for at least eight consumers — `viewport-dual-axis-scroll.feature` (a scenario asserting it is *unchanged*), `viewport-pane-scroll-floor.feature`, `drilldown-dual-axis-scroll.feature`, the step "the workspace Runs pane's content child carries the 660px min-width floor" in `tests/e2e/steps/pane-scroll.steps.ts`, `roadmap-visual-grammar.test.ts` (`PANE_CHILD_FLOOR = 660`, AC11) and the badge-shape suites in `boundary-to-cycle-navigation` / `cycle-run-navigation`. Deleting it would red every one of them for no design gain. **AMENDED 2026-09-23 — the rule stands, its stated PURPOSE was wrong.** CR-CRU-018's RED phase measured `.app-pane-content`'s clientWidth across the desktop band against the live server: 1025→**688px**, 1050→706, 1200→815, 1280→872. With the grid at `minmax(0,2.6fr) minmax(260px,1fr)`, the pane is ALREADY wider than 660px at the narrowest legal desktop width, so the floor can never bind by container-narrowing anywhere in its own band. It is therefore a **guarantee about content** (a pane child never renders narrower than 660px), NOT the mechanism that forces horizontal overflow. Consequence for tests: overflow-mechanism scenarios must force overflow with **wide content** (an unbreakable long id or label), never by narrowing the viewport; the floor's literal presence stays separately asserted at 1280px. `.app-cycle-text` is exempt from content-forcing — it carries `white-space:nowrap; text-overflow:ellipsis` and can never overflow however long the label. | approved, premise corrected |
| **6** | **No page-level horizontal scroll, at any band.** `scrollWidth ≤ innerWidth` on the document at every routed surface. Wide content — trees, diagnostics, raw output, the roadmap strip — scrolls **inside its own container**, which is the dual-axis contract CR-CRU-029 already shipped. Container scroll is the mechanism; page scroll is the defect. | approved |
| **7** | **The roadmap strip's paging rule is band-independent.** `DN-crucible-roadmap-view.md`'s invariant already states whole containers only: a narrower viewport shows **fewer** gates and a higher `◀ N earlier` count, **never a partial one**. This note adds nothing to it and may not weaken it. | inherited |
| **8** | **Nothing new is drawn.** Shape, colour and motion keep their meanings from the roadmap DN — shape says what a thing is, colour says where it stands, motion means live, and no element relies on colour alone. A band may relocate or stack an element; it may not invent a visual channel. | inherited |

## Per-surface behaviour — INITIAL APPROVAL (user, 2026-09-23)

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
| **13** | **Both mobile ecosystems are tested, on their own ENGINES** (user ruling 2026-09-23) | A phone profile on Chromium proves geometry, not the platform: `devices["iPhone 15"]` under Chromium is still Blink. So the phone band is covered by **two engines** — `chromium-mobile` (Pixel 7, Blink) and **`webkit-iphone` (iPhone profile on WebKit)** — because the areas §S3 lives in (scroll containment, `100vh`, `-webkit-fill-available`, flex/grid edge cases) are exactly where the engines differ. This requires WebKit provisioning in **both** CI jobs, which today install `chromium` only. **WebKit runs in CI, NOT on this workstation** (measured 2026-09-23): Playwright ships its WebKit build for Debian/Ubuntu only, and this host is Arch/CachyOS — the install asks for `libicu74` + `libflite1` against a system carrying ICU 78.3, and `install-deps` needs root. The CI runners are Ubuntu and provision it cleanly. **Locally it runs through the Docker Playwright Server** (see the section below) — one command, `bun run webkit:docker`. Plain `test:e2e` is **endpoint-gated** (user ruling 2026-09-24): `webkit-iphone` stays declared but collects nothing unless a WebKit endpoint exists — natively in CI, or via the docker launcher — so a local run never reds on an engine it cannot reach. |

**What none of them may do:** drop a tab, drop a route, drop a control, or summarise data away to fit
the band. If information is worth hiding on a phone, that is a question about the desktop design,
not a licence to diverge.

**Precedence between decisions 9 and 12 (ruled 2026-09-24, found by C3 GREEN).** On a phone an open
drill-in fills the viewport, which covers the project band's foot strip. That is not a violation of
"never hides": the drill-in is a transient FOCUS state with `←` always visible, and the band returns
the moment it is dismissed. Decision 9 governs the navigable surface; decision 12 governs a focus
layer above it. What would violate decision 9 is any surface where the band is absent with no single
action that restores it.

### WebKit provisioning — the two paths (decision 13's mechanics)

Playwright does not support Arch: issue #8100 was closed in Dec 2024 and folded into the container
approach, because supporting a distro means COMPILING browsers for it — the prebuilt WebKit is
dynamically linked against Debian's library versions. So the engine runs two ways, and neither is
"install it locally":

| Where | How | Notes |
| --- | --- | --- |
| **CI — the gate** | Native: add WebKit to the existing `bunx playwright install --with-deps` steps in **both** jobs | Runners are Ubuntu, which Playwright supports directly. This is where the Safari signal protects a merge, so it runs on every push — never opt-in. |
| **Locally — reproduction only** | **Playwright Server in Docker** (Playwright's own answer for unsupported distros): run `mcr.microsoft.com/playwright:v<version>-noble` with `run-server`, then point the suite at it via `PW_TEST_CONNECT_WS_ENDPOINT` | Opt-in. Its purpose is reproducing a CI WebKit failure, not gating local work. Docker 29.8.1 is present on this workstation. |

Two mechanics that are defects if missed, both stated here so nobody rediscovers them:

- **The image version must match `@playwright/test` EXACTLY** (today `^1.61.1` — so `v1.61.1-noble`).
  Playwright's docs are explicit that a mismatch leaves it unable to locate browser executables.
- **The container's `localhost` is not the host's — solved by TUNNELLING, not by re-addressing.**
  The e2e suite binds its OWN ephemeral `webServer` on `E2E_PORT` = **39877** (`tests/e2e/steps/harness.ts`),
  deliberately NOT the supervised dev board on `:3850`, and it stays bound to **`127.0.0.1` in every mode**.
  The launcher sets Playwright's own **`PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback>`** beside the endpoint,
  which tunnels the container browser's loopback traffic back through the client connection (documented
  `BrowserType.connect` `exposeNetwork`; recommended for exactly this setup in microsoft/playwright#31440).
  Every base URL stays `localhost:39877` for every engine.
- **Readiness is an HTTP 200, not a TCP connect.** Docker's port proxy accepts connections the moment the
  container starts, then RESETS them until `run-server` is listening (~2s measured). A launcher that treats
  a successful connect as ready dies with a WebSocket `ECONNRESET` on its first real run.

**RETIRED 2026-09-24 — the `hostmachine` design this section first specified.** It re-addressed every base
URL to `hostmachine` via `--add-host=hostmachine:host-gateway`, which needed the e2e server bound beyond
loopback AND a host firewall rule — and it was broken regardless: Playwright's host-side `request`
fixture inherits `use.baseURL`, and `hostmachine` does not resolve on the host, so every seeding call would
have failed. Found by C4 GREEN; the firewall had been hiding it. The tunnel needs none of that, and was
verified end to end on this workstation: the phone feature passed **9/9 on real WebKit** via
`bun run webkit:docker` (`66fbbf3`).

**Explicitly REJECTED: the AUR route.** The AUR `playwright` maintainer's own note calls WebKit on
Arch "not guaranteed": it needs `flite-voices-extra` (Arch's `flite` omits six voice modules the
Debian build links), **`icu74`** because "system ICU 78 is not sufficient" — which is exactly the
failure measured here — and a manual `libxml2.so.2 -> libxml2.so.16` symlink that "may need
re-pointing after upgrades". Making the ability to run tests depend on AUR packages and hand-made
symlinks surviving system upgrades is a worse defect than the coverage gap it closes.

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
