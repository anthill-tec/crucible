# CR-CRU-007 — Run timeline + density-adaptive drill-in

**Status:** IN_PROGRESS (2026-07-15 — GO after the 31-round design iteration; branch feature/CR-CRU-007)
**Type:** feature
**Priority:** P1
**Depends on:** CR-CRU-006
**Labels:** ui, timeline, drill-in, density
**Phase:** Wave 3
**Design reference:** PRD §4.11 (drill-in density — the 0.1.0 set); storyboard F3–F7, F4½ (approved verdicts), §nav interaction table; **design iteration approved 2026-07-15** (agents nesting + ⌁ glyph, header simplification + filter pulldown, pane-row drill-down, Agents tab drop — storyboard F2/F7/F8/F9/F10 + decision ledger)

## Context
The heart of the dashboard: run cards on the timeline, RED→GREEN transition markers,
and the single density-adaptive drill-in (density ideas 1–5 + 7; the filter bar is
post-0.1.0). Re-baselined 2026-07-15 after the board design iteration (micro
design iteration, per process rule): this CR also absorbs the approved shell
revisions (§S5) — agents nested under projects everywhere, simplified header with
filter-by pulldown, drill-down pane navigation, workspace Agents tab removed.

## Scope

### §S1 Run cards
Timeline (home: cross-project; workspace Runs tab: scoped) renders newest-first
event cards: kind icon (🧪 test / 🛠 compile), agentId, tier + codec badges, context
badges when present (branch@shortcommit, wave, orchestrator — omitted when absent),
relative time, duration, ratio pill. Pill palette follows the UNIVERSAL status
palette (user-corrected 2026-07-15 against the live render — the original amber
compile pill predated the palette rule): `N/N` green / `F ✗ of N` red / compile
`E errors` **red when E>0, pass-green `0 errors` when clean** — a successful
run of ANY kind is green, a failed one red; amber stays reserved for pending.
Compile cards preview the first 2 diagnostics inline.
Click affordance (user-added during execution): clickable run cards show the
POINTER cursor + a hover affordance (forge conventions) so the drill-down spot
is discoverable. In 0.1.0 every stored event is a completed run, so all cards
are clickable; the disabled-until-run-completes rule binds CR-CRU-017's
running cards (an open run's card is NOT clickable until it resolves).
Phase-role icon tinting (user-added during execution): the card's kind icon is
tinted by the agent's PHASE ROLE derived from the agentId — RED → red, GREEN →
green, VERIFY → purple, FIX → yellow (suffix `-RED|-GREEN|-FIX` or a
`verify`/`-VERIFY` name segment, case-insensitive; roleless agents keep the
neutral tint). A pure `L.phaseRole(agentId)` helper backs it.
Server delta (additive, shim untouched): v2 `eventBrief` gains optional `context`
passthrough (`{git:{branch,commit}, wave, orchestrator, cycle}` verbatim when
stored — `cycle?: string` is a new optional `RunContext` field, round 10) and
compile counts (`errors`, `warnings`) — today the brief carries neither, so cards
cannot render context badges or compile previews from the list payload.

### §S2 RED→GREEN transition markers (= Cycles)
Terminology (user-locked 2026-07-15, round 10): a RED→GREEN pair is a **Cycle** —
one step in a CR's execution; CR groups cycles, Wave groups CRs.
Pairing rule (STREAK-BASED — user-revised during execution: the live view showed
marker proliferation when agents ingest many runs per cycle): same `projectKey` +
same agent stem (agentId with a trailing `-RED|-GREEN|-FIX` suffix stripped,
case-insensitive), runs timestamp-ordered — ONE marker per maximal failing
STREAK closed by its first subsequent passing run within 24 h (the marker's RED
counts come from the streak's FIRST failing run; intermediate failing runs are
absorbed into the same cycle, never paired separately; pass-after-pass never
creates a marker). Interim heuristic only: once CR-CRU-011's declared plans
exist, the orchestrator's cycle-done (todo-complete) IS the boundary and the
timeline suppresses inferred markers for `cycleId`-linked runs. Marker row
above the pair:
`RED f/t ➜ GREEN t/t · Cycle: <label> · <stem> · <tier> · closed in <duration>`
where `<label>` is `context.cycle` (an OPTIONAL additive string on `RunContext`,
carrying the orchestrator todo's description) from the GREEN run when present,
else the label segment is omitted and the stem alone identifies the cycle.
Marker click opens the GREEN run's drill-in. (Fleet clients start SENDING
`context.cycle` in CR-CRU-008; the full Wave → CR → Cycle workflow lens is
post-0.1.0 register.)

### §S3 Drill-in slide-over (codec-aware)
Opens from any run card / marker / coverage point; route suffix `/run/<eventId>`.
Test body — **F4 anatomy is the contract (user-corrected against the live
render):** header `Run detail · <shortEventId>`; the tree renders as flat mono
TREE LINES (▾/▸ suite headers with inline per-status counts like `3 ✗ 2 ✓`,
COLORED per status — ✗ counts red, ✓ counts green, ⏭ amber, exactly as the
F4 mock renders them;
leaf lines with ✓/✗/⏭ glyph + name + duration; PASSING leaves render green or
bright — never a faint grey that reads as inactive, user-corrected) — NOT
bordered card boxes, and NO edge/outline highlight on any tree row (the red
row-border seen live was never in the storyboard; status is conveyed by text
color alone — the ONLY boxed element in the tree is the failure box itself);
**failing suites auto-expand in BOTH modes** (their leaves fetched immediately;
passing suites stay collapsed rows); a failed leaf shows its `failure.message`
+ `trace` INLINE beneath it (mono, red-accent box, `at file:line` last). The
failure box NEVER renders empty (user defect report 2026-07-15: bun's JUnit
reporter emits bare `<failure type="AssertionError"/>` — no message attribute,
no text — so the box rendered as an empty red band): when `message` is absent
the box renders the failure `type` as its message line plus a dim note
`no failure detail captured by the reporter`; a failure with neither message
nor type renders `test failed` + the same note; the trace block renders only
when a trace exists. Footer
row: `▸ N more failures · toggle raw output` (jumps to the next failure; raw
toggle reveals the stored raw output). Density (broad tiers) adds the F4½
header: status chips `✗ failures N · ⏭ pending N · ✓ passed N` above the
heat-strip. Compile body (user defect report 2026-07-15: a clean tsc drill-in rendered a
fully EMPTY pane): a status line ALWAYS renders first —
`<format> · N errors · M warnings`, pass-green when `errorCount` is 0, fail-red
otherwise — then diagnostics grouped by file (`file:line:col — message`,
level-colored) when present, else the empty-state line
`clean compile — no diagnostics`; the raw-output toggle renders only when a
non-empty `raw` is stored.

### §S4 Density set (release 0.1.0 — approved F4½ verdicts; mode-switch revision 2026-07-15)
0. **Purely tier-contextual — NO mode switch exists (final user correction:
   the mode badge is removed everywhere):** the presentation is decided
   entirely by the run's tier. Broad tiers (`regression`, `e2e` — full
   regression sweeps) RENDER Density; focused agent-driven tiers
   (unit/module/integration) RENDER Detail; compile events render the
   diagnostics body. There is no `drillin-mode` element anywhere, no toggle,
   no mode persistence — Density is simply HOW a regression drill-in looks.
   No test-count auto-decision anywhere. `Detail` = the suite tree. `Density`
   applies ideas 1–3 below. Ideas 4–5 (virtualization, progressive payload)
   are always-on; idea 6 (comfortable/compact/ultra toggle) is independent and
   remains the only user-facing control.
1. **Failures float, green folds** (Density mode) — all-pass suites collapse to one
   counted row; failing suites auto-expand; runs with 0 failures open with suites
   collapsed.
2. **Heat-strip minimap** (Density mode) — one cell per test (fail red / pending
   amber / pass dimmed green), any run size — no count threshold; clicking a cell
   scrolls to and expands that test.
3. **Failure digest** (Density mode) — leaves within a suite sharing an identical
   `failure.message` group into one row + "+N identical" expander.
4. **Virtualized tree** — only visible rows in the DOM; 10 000-leaf run keeps
   < 200 tree row nodes mounted.
5. **Progressive payload** — drill-in fetches `?depth=suites` first, then
   `?suite=<name>` on expand (CR-CRU-004 §S4).
6. **Density toggle** — comfortable / compact / ultra (persisted in
   localStorage). Scope (user defect report: switching produced no visible
   change on home): the mode VISIBLY affects spacing GLOBALLY — timeline run
   cards + marker rows (home and workspace), drill-in tree rows, and Project
   pane rows all tighten padding/margins per mode (comfortable = current,
   compact ≈ −35%, ultra ≈ −60%, forge conventions); the difference must be
   plainly visible at a glance on the home timeline.

### §S5 Shell revisions — board design iteration, final form (round 6, 2026-07-15)
1. **Home = title bar + projects row + collective timeline (round 7).** Title bar
   renders logo + slogan one-liner + the Health Pill only. Below it, the
   **projects row**: a second-row header pane in a **flow (wrapping) layout**
   holding one badge per registered project, ordered **most-recently-active
   first, inactive last**. Activity rule (user-locked round 13): a project is
   **`active` while it has ≥1 live (online/stale) agent**; with none left it
   turns **`inactive` once `now − lastActivity` exceeds the system-wide
   configurable project-inactive timeout** (`CRUCIBLE_PROJECT_INACTIVE_MS`,
   default 3 600 000 ms; `lastActivity` = max of the project's last event
   timestamp and its agents' last-seen) — no flapping the instant agents
   tombstone. Server delta (additive): the v2 projects listing carries
   `active: boolean` + `lastActivity` per project, server-computed with that
   config. Badge display state is binary — `active` / `inactive` — and badges
   follow the canonical format everywhere: **name + type badge**. The row also
   carries the **⚙ manage chip** (opens the CR-CRU-012 manager; chip renders in
   this CR, the surface lands in 012).
   **Clicking a badge navigates to `/p/<key>`** (drill-down, never filter). The
   home body is the **collective all-projects timeline** (newest-first, each
   project contributing up to its retention limit); the **filter pulldown
   (default `All projects`) sits in the timeline pane's own header** and filters
   only the timeline, in place (route stays `/`). **No Projects pane and no
   agent rows render on home.** Slogan placeholder: "where agentic TDD forges
   green".
2. **Workspace Project pane (agents nested, workspace-only).** The workspace's
   right rail is the **Project pane**: the project card (name + type badge, agent
   rollup, coverage meters) with the project's agents (live + tombstoned,
   `L.livenessGlyph` semantics kept) as indented `⌁`-marked (heat-amber) sub-rows
   beneath it, then the Vitals cards (coverage trend, cycle health). This pane
   exists ONLY inside the workspace. `Agents` is removed from `L.workspaceTabs`
   (both project types). Agent sub-row click filters the visible timeline to that
   agent (in place).
3. **Three levels, consistent ← back chip.** Level 1 home → level 2 workspace
   (`← projects`) → level 3 run drill-in (`← timeline`). The `←` back chip renders
   at every level ≥ 2 and behaves exactly like Esc / scrim / browser back. The
   navigation FLOW (user-approved diagram) is unchanged from CR-006.
5. **Workspace tab bodies — 0.1.0 final set (user defect report 2026-07-15:
   the Coverage tab showed no data despite a stored coverage run — the CR-006
   placeholder `<tab> lands in CR-CRU-007` was still the only body behind
   every non-Runs tab).** `Coverage` renders the latest-green-coverage panel:
   pane heading, a lines meter row (`lines <covered>/<total> · <percent>%`),
   a functions row (`functions <covered>/<total> · <percent>%`), and a
   `view run` control opening `latestCoverageEventId`'s drill-in (same wiring
   as the §nav coverage-meter click); the no-coverage gating/disabled state is
   unchanged. `Compile` renders the F5 COMPILE PANEL: the workspace timeline
   filtered to `kind === "compile"` events, identical card anatomy, with
   empty-state `no compile events yet`. `BDD` keeps a placeholder body whose
   text names the REAL landing CR (`CR-CRU-015`, 0.2.0) and notes BDD run
   results already stream into the Runs timeline — the string
   `lands in CR-CRU-007` must not render anywhere.
6. **Health pill fidelity (user note 2026-07-15, post-approval addendum).** The
   pill is the SAME server-liveness badge on home AND workspace top bars: green
   dot + `server healthy · live` (or `· up <uptime>`), red dot +
   `server unreachable · retrying…`. It never shows version/event counts, and the
   workspace top bar carries the pill instead of an agent-count chip.

## Acceptance criteria
- [ ] A `context`-bearing event's card shows `branch@abc1234` + wave badge; a context-less event's card shows neither (no placeholder text).
- [ ] Ingesting fail(2/5) then pass(5/5) for agents `CR-X-1-RED` / `CR-X-1-GREEN` renders exactly one marker row whose text matches `RED 2/5 ➜ GREEN 5/5` and includes a duration; pass-then-pass renders none. With `context.cycle: "checkpoint persistence"` on the GREEN run the marker additionally contains `Cycle: "checkpoint persistence"`; without it, no `Cycle:` segment renders.
- [ ] Clicking a 🛠 card opens the drill-in with a diagnostics list grouped by file and a working raw-output toggle; clicking a 🧪 card shows the suite tree.
- [ ] Purely tier-contextual: NO `drillin-mode` element exists anywhere (DOM + grep assertion); a `unit`/`module`/`integration` drill-in renders the Detail tree; a `regression`- or `e2e`-tier drill-in renders Density (chips row + heat-strip + folds); a compile drill-in renders the diagnostics body; no code path selects presentation from test count and no mode persistence key exists.
- [ ] F4 anatomy: the test drill-in renders tree LINES (suite header with inline `F ✗ P ✓` counts; leaf lines with status glyph + name + duration — no card-box borders per row); a failing suite's leaves are auto-expanded on open in Detail mode (passing suites collapsed); the failed leaf's failure box (message + trace + `at file:line`) renders inline beneath it without a click; the footer renders `▸ N more failures · toggle raw output`, the jump advances to the next failure, and the raw toggle reveals the stored raw output; Density adds the status-chips row (`✗ … ⏭ … ✓ …`) above the heat-strip.
- [ ] In Density mode, drill-in of a run with 0 failures opens with every suite collapsed to `name + ✓count` rows; a run with failures opens with ONLY failing suites expanded.
- [ ] With Density mode ON, a 60-test fixture renders a heat-strip with 60 cells and clicking the first red cell expands that test's failure box (assert `failure.message` text visible); in Detail mode the same fixture renders no heat-strip.
- [ ] In Density mode, 4 leaves with identical `failure.message` render as 1 row + an expander labeled `+3 identical`.
- [ ] A 10 000-leaf synthetic run: mounted tree-row DOM nodes < 200 (virtualization) and the initial drill-in network payload contains no leaf entries (suites-first paging) — in BOTH modes.
- [ ] Density toggle cycles 3 modes and survives reload (localStorage).
- [ ] The drill-in URL `/p/<key>/run/<id>` opened cold (fresh load) renders the same drill-in.
- [ ] Failure-box degradation (user defect 2026-07-15): a failing leaf whose `failure` is exactly `{type:"AssertionError"}` renders a failure box whose visible text contains `AssertionError` AND `no failure detail captured by the reporter` — the box's text content is never empty; a failing leaf with NO failure object (or one with neither message nor type) renders `test failed` + the same note; no `.app-failure-trace` node renders when `trace` is absent.
- [ ] Compile drill-in status line (user defect 2026-07-15): a compile event with `errorCount:0, warningCount:0, diagnostics:[]` renders `data-testid="compile-status"` with text `tsc · 0 errors · 0 warnings` carrying the pass-green class, followed by the empty-state `clean compile — no diagnostics`; the same event with 2 error diagnostics renders the status line fail-red with the diagnostics list; the raw-output toggle is ABSENT when `raw` is empty/absent and present when non-empty.
- [ ] Compile card pill palette (user defect 2026-07-15): a compile card with `errors:0` renders its `0 errors` pill with the SAME pass-green class as an `N/N` test pill; with `errors:3` the `3 errors` pill carries the fail-red class; no amber compile pill exists anywhere (class-level assertion).
- [ ] §S5 Coverage tab (user defect 2026-07-15): with `latestGreenCoverage {lines:{covered:1736,total:1849,percent:93.9}, functions:{covered:199,total:208,percent:95.7}}` and a `latestCoverageEventId`, selecting the Coverage tab renders `data-testid="coverage-panel"` containing `93.9%`, `1736/1849`, `95.7%`, and `199/208`, plus a `data-testid="coverage-view-run"` control whose click opens the drill-in route `/p/<key>/run/<latestCoverageEventId>`; the string `lands in CR-CRU-007` renders on NO tab.
- [ ] §S5 Compile tab (F5 COMPILE PANEL): with a fixture of 2 test + 2 compile events, selecting the Compile tab renders exactly the 2 compile-kind cards (same card anatomy/testids as Runs); with 0 compile events it renders `no compile events yet`; the BDD tab body text contains `CR-CRU-015` and not `CR-CRU-007`.
- [ ] Integration: coverage meter click on a project card opens the drill-in of the event whose id equals the project's latest-green-coverage event (wired per §nav table).
- [ ] §S5: workspace Project pane — on `/p/<key>` for a project with 2 online agents + 1 tombstoned, `data-testid="project-pane"` renders the project card (name + type badge + coverage meter) followed by exactly 3 `⌁`-marked agent sub-rows, with the Vitals cards beneath; the home page (`/`) renders 0 agent rows anywhere.
- [ ] §S5: `L.workspaceTabs({type:"backend"})` returns exactly `["Runs","Coverage","Compile","BDD"(disabled)]` and `L.workspaceTabs({type:"frontend"})` the same with BDD enabled — no `Agents` entry in either.
- [ ] §S5: home renders a `data-testid="projects-row"` (second header row) with one `data-testid="project-badge"` per registered project, each containing the project name AND a type badge (canonical format); clicking a badge changes the route to `/p/<key>`; the title bar itself contains no project badges. A `data-testid="filter-pulldown"` control inside the timeline pane header defaults to `All projects`; selecting a project in it filters the home timeline in place (`location.pathname` stays `/`, timeline shows only that project's cards).
- [ ] §S5: projects-row ordering + state — with `CRUCIBLE_PROJECT_INACTIVE_MS=3600000`: project A (1 online agent, seen 5 s ago) and project C (no live agents, last event 10 min ago — within the timeout) are `active`; project B (no live agents, last activity 2 h ago — timeout elapsed) is `inactive`; badge order is A, C, B and the v2 projects listing carries matching `active`/`lastActivity` fields.
- [ ] §S5: with two projects ingesting runs, the home timeline interleaves both projects' cards newest-first (collective feed); clicking an agent sub-row in the workspace does NOT change the route and filters the visible timeline to that agent's runs.
- [ ] §S5: the drill-in header renders a `← timeline` control whose click closes the overlay with the exact same route/scroll restore as Escape; the workspace header's `← projects` control navigates to `/`.
- [ ] §S5: `data-testid="workspace-header"` (with the `← projects` control) exists on `/p/<key>` and does not exist on `/`.
- [ ] §S5: `data-testid="health-pill"` renders on BOTH `/` and `/p/<key>`; its text matches `/^server healthy · (live|up .+)$/` when the backend is up and equals `server unreachable · retrying…` when down (no version or event-count text in either state); the workspace top bar contains no agent-count chip.
- [ ] E2E house style (user-directed during execution): the E2E layer is expressed as **proper BDD** — Gherkin `.feature` files (Given/When/Then scenarios, one feature per storyboard frame group) bound to Playwright via `playwright-bdd` (devDep + `bddgen` wired into `test:e2e`); the existing `shell.e2e.ts`/`timeline.e2e.ts` suites are converted in this CR and every future CR writes E2E as features. The storyboard frames become literal Gherkin scenarios.
- [ ] BDD results reporting (user-directed, in 0.1.0): the **playwright codec is pulled forward from CR-CRU-015 §S2** — registry entry `playwright` (CR-010 `Codec` interface, registry-only resolution) parsing the BDD run report into a **feature → scenario → step** RunSchema tree; the converted E2E suite's runs are ingested through it (`tier:"e2e"`, codec `playwright`), so BDD run cards carry the `playwright` codec badge and their drill-in shows the feature → scenario → step tree with Given/When/Then step names. (Server-side BDD *execution* — F11 — remains CR-CRU-015 in 0.2.0; that CR now reuses this codec.)
- [ ] E2E (storyboard as contract, PRD §5): Playwright suite (BDD features per the AC above, generated specs equivalent to `tests/e2e/timeline.e2e.ts`) extends the CR-CRU-006 harness with frame-mapped scenarios — F2 (project registration lights its projects-row badge live over SSE, active-first ordering), F3 (ingest via API → red card appears live with tier+codec badges), F4/F4½ (drill-in shows failing test's assertion message; switching to Density mode renders the 60-test heat-strip), F5 (compile ingest renders a 🛠 card, never "0/N tests"), F6 (fail-then-pass same agent stem → transition marker text `RED 2/5 ➜ GREEN 5/5`), F7 (green regression updates the Project-pane coverage meter), F8 (badge click lands on the workspace: no Agents tab, right Project pane with ⌁ agents, `← projects` breadcrumb present). All pass headless against the real server; results ingested with `tier: "e2e"`.

## Estimated size
L (grew with §S5 fold-in — plan an extra shell-revision cycle before the drill-in cycles).

## Risk
Virtualization + VanX interplay is the hardest UI piece — spike inside RED if
needed, but the AC thresholds are the gate.

## Non-goals
Filter bar (post-0.1.0), BDD tab content, coverage-trend deep view beyond vitals.
