# CR-CRU-007 — Run timeline + density-adaptive drill-in

**Status:** PENDING
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
relative time, duration, ratio pill (`N/N` green / `F ✗ of N` red / `E errors`
amber). Compile cards preview the first 2 diagnostics inline.
Server delta (additive, shim untouched): v2 `eventBrief` gains optional `context`
passthrough (`{git:{branch,commit}, wave, orchestrator}` verbatim when stored) and
compile counts (`errors`, `warnings`) — today the brief carries neither, so cards
cannot render context badges or compile previews from the list payload.

### §S2 RED→GREEN transition markers
Pairing rule: same `projectKey` + same agent stem (agentId with a trailing
`-RED|-GREEN|-FIX` suffix stripped, case-insensitive) — when a failing test run is
followed by a passing test run within 24 h, render the marker row above the pair:
`RED f/t ➜ GREEN t/t · <stem> · cycle <duration>`. Marker click opens the GREEN
run's drill-in.

### §S3 Drill-in slide-over (codec-aware)
Opens from any run card / marker / coverage point; route suffix `/run/<eventId>`.
Test body: suite→test tree; failed leaf expands to `failure.message` + `trace`
(mono, red-accent box). Compile body: diagnostics grouped by file
(`file:line:col — message`, level-colored) + raw-output toggle.

### §S4 Density set (release 0.1.0 — approved F4½ verdicts)
1. **Failures float, green folds** — all-pass suites collapse to one counted row;
   failing suites auto-expand; runs with 0 failures open with suites collapsed.
2. **Heat-strip minimap** — one cell per test (fail red / pending amber / pass
   dimmed green), rendered for runs with > 50 tests; clicking a cell scrolls to and
   expands that test.
3. **Failure digest** — leaves within a suite sharing an identical
   `failure.message` group into one row + "+N identical" expander.
4. **Virtualized tree** — only visible rows in the DOM; 10 000-leaf run keeps
   < 200 tree row nodes mounted.
5. **Progressive payload** — drill-in fetches `?depth=suites` first, then
   `?suite=<name>` on expand (CR-CRU-004 §S4).
6. **Density toggle** — comfortable / compact / ultra (persisted in localStorage).

### §S5 Shell revisions — board design iteration, final form (round 6, 2026-07-15)
1. **Home = title bar + projects row + collective timeline (round 7).** Title bar
   renders logo + slogan one-liner + the Health Pill only. Below it, the
   **projects row**: a second-row header pane in a **flow (wrapping) layout**
   holding one badge per registered project, ordered **most-recently-active
   first, inactive last** (activity = max of the project's last event timestamp
   and its agents' last-seen; a project with zero live [online/stale] agents is
   `inactive`). Badge display state is binary — `active` / `inactive` — and
   badges follow the canonical format everywhere: **name + type badge**.
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
4. **Health pill fidelity (user note 2026-07-15, post-approval addendum).** The
   pill is the SAME server-liveness badge on home AND workspace top bars: green
   dot + `server healthy · live` (or `· up <uptime>`), red dot +
   `server unreachable · retrying…`. It never shows version/event counts, and the
   workspace top bar carries the pill instead of an agent-count chip.

## Acceptance criteria
- [ ] A `context`-bearing event's card shows `branch@abc1234` + wave badge; a context-less event's card shows neither (no placeholder text).
- [ ] Ingesting fail(2/5) then pass(5/5) for agents `CR-X-1-RED` / `CR-X-1-GREEN` renders exactly one marker row whose text matches `RED 2/5 ➜ GREEN 5/5` and includes a duration; pass-then-pass renders none.
- [ ] Clicking a 🛠 card opens the drill-in with a diagnostics list grouped by file and a working raw-output toggle; clicking a 🧪 card shows the suite tree.
- [ ] Drill-in of a run with 0 failures opens with every suite collapsed to `name + ✓count` rows; a run with failures opens with ONLY failing suites expanded.
- [ ] A 60-test fixture renders a heat-strip with 60 cells; clicking the first red cell expands that test's failure box (assert `failure.message` text visible).
- [ ] 4 leaves with identical `failure.message` render as 1 row + an expander labeled `+3 identical`.
- [ ] A 10 000-leaf synthetic run: mounted tree-row DOM nodes < 200 (virtualization) and the initial drill-in network payload contains no leaf entries (suites-first paging).
- [ ] Density toggle cycles 3 modes and survives reload (localStorage).
- [ ] The drill-in URL `/p/<key>/run/<id>` opened cold (fresh load) renders the same drill-in.
- [ ] Integration: coverage meter click on a project card opens the drill-in of the event whose id equals the project's latest-green-coverage event (wired per §nav table).
- [ ] §S5: workspace Project pane — on `/p/<key>` for a project with 2 online agents + 1 tombstoned, `data-testid="project-pane"` renders the project card (name + type badge + coverage meter) followed by exactly 3 `⌁`-marked agent sub-rows, with the Vitals cards beneath; the home page (`/`) renders 0 agent rows anywhere.
- [ ] §S5: `L.workspaceTabs({type:"backend"})` returns exactly `["Runs","Coverage","Compile","BDD"(disabled)]` and `L.workspaceTabs({type:"frontend"})` the same with BDD enabled — no `Agents` entry in either.
- [ ] §S5: home renders a `data-testid="projects-row"` (second header row) with one `data-testid="project-badge"` per registered project, each containing the project name AND a type badge (canonical format); clicking a badge changes the route to `/p/<key>`; the title bar itself contains no project badges. A `data-testid="filter-pulldown"` control inside the timeline pane header defaults to `All projects`; selecting a project in it filters the home timeline in place (`location.pathname` stays `/`, timeline shows only that project's cards).
- [ ] §S5: projects-row ordering + state — given project A (agent seen 5 s ago), project B (last event 10 min ago, no live agents), project C (last event 1 min ago, 1 online agent): badge order is A, C, B; A and C carry the `active` state class, B carries `inactive` (0 live agents ⇒ inactive, sorted after actives).
- [ ] §S5: with two projects ingesting runs, the home timeline interleaves both projects' cards newest-first (collective feed); clicking an agent sub-row in the workspace does NOT change the route and filters the visible timeline to that agent's runs.
- [ ] §S5: the drill-in header renders a `← timeline` control whose click closes the overlay with the exact same route/scroll restore as Escape; the workspace header's `← projects` control navigates to `/`.
- [ ] §S5: `data-testid="workspace-header"` (with the `← projects` control) exists on `/p/<key>` and does not exist on `/`.
- [ ] §S5: `data-testid="health-pill"` renders on BOTH `/` and `/p/<key>`; its text matches `/^server healthy · (live|up .+)$/` when the backend is up and equals `server unreachable · retrying…` when down (no version or event-count text in either state); the workspace top bar contains no agent-count chip.
- [ ] E2E (storyboard as contract, PRD §5): Playwright suite `tests/e2e/timeline.e2e.ts` extends the CR-CRU-006 harness with frame-mapped scenarios — F2 (project registration lights its projects-row badge live over SSE, active-first ordering), F3 (ingest via API → red card appears live with tier+codec badges), F4/F4½ (drill-in shows failing test's assertion message; 60-test run renders the heat-strip), F5 (compile ingest renders a 🛠 card, never "0/N tests"), F6 (fail-then-pass same agent stem → transition marker text `RED 2/5 ➜ GREEN 5/5`), F7 (green regression updates the Project-pane coverage meter), F8 (badge click lands on the workspace: no Agents tab, right Project pane with ⌁ agents, `← projects` breadcrumb present). All pass headless against the real server; results ingested with `tier: "e2e"`.

## Estimated size
L (grew with §S5 fold-in — plan an extra shell-revision cycle before the drill-in cycles).

## Risk
Virtualization + VanX interplay is the hardest UI piece — spike inside RED if
needed, but the AC thresholds are the gate.

## Non-goals
Filter bar (post-0.1.0), BDD tab content, coverage-trend deep view beyond vitals.
