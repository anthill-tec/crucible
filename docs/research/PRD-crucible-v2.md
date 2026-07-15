# PRD — Crucible v2: Agentic-TDD Test Dashboard

**Author:** Antony John
**Co-author:** claude (orchestrator — crucible)
**Date:** 2026-07-14
**Status:** DRAFT — kickoff design contract
**Design inputs:** [DN-crucible-api-reconstruction.md](DN-crucible-api-reconstruction.md)

## 1 Why

Crucible is the test-observability hub of the agentic-TDD platform (MDX: CodeForge,
Crucible, Velocity). Every RED/GREEN/VERIFY/FIX agent across every stack (Rust, Java/
Quarkus, Python, Bun/TS, VS Code ext, Arduino) registers with Crucible, heartbeats its
progress, and ingests every test cycle it runs — including compile failures, because in
TDD "the test doesn't compile yet" is itself a reportable RED state. Orchestrators and
the human watch one dashboard to see which agents are live, what they're running, and
whether the RED→GREEN transition actually happened.

Crucible v1 (Bun/TypeScript backend, VanJS/VanX UI, port 3849) was lost to an accidental
folder deletion. The client fleet survived intact. v2 rebuilds the server and dashboard
around two commitments:

1. **Wire compatibility** — every surviving client works unmodified, day one.
2. **A more usable UI** — v1's dashboard grew organically; v2 designs it deliberately.

## 2 System context

```
 rust-crucible.py ─┐
 mvn-crucible.py  ─┤   JSON/HTTP :3849            ┌─ Dashboard SPA (VanJS + VanX)
 python-crucible.py├──▶  Crucible server (Bun/TS) ─┤   served from /, live via SSE
 bun-crucible.py  ─┤   /api/*                     └─ REST consumers (orchestrators,
 arduino-crucible ─┘                                   status-report skill, curl)
 + crucible-report-* skills, heartbeat.sh
```

- Single-user, localhost developer tool. No auth, no TLS, no multi-tenant (non-goals §7).
  The server binds loopback (`127.0.0.1`) by default; `CRUCIBLE_HOST` opts into wider
  exposure (the API is unauthenticated and `dataPath` ingest reads server-side files).
- Server: Bun + TypeScript, zero runtime framework (Bun.serve router). Tests: `bun test`
  (this project eats its own dog food: it ingests its own runs via `bun-crucible.py`).
- **API strategy (decided 2026-07-14, kickoff review):** the primary contract is a
  **clean v2 API at `/api/v2/*`** designed with the reconstructed v1 API as reference
  (not as a frozen byte-contract). A **thin v1 shim** answers the original `/api/*`
  paths (translating onto the v2 core) so the legacy fleet keeps reporting during
  migration; the `*-crucible.py` scripts and `crucible-report-*` skills are upgraded
  to v2 + AXI idioms, and the shim retires once the fleet is migrated. A gh-axi-style
  **`crucible-axi` npx CLI** wraps the v2 API for agents.
- **UI stack (decided 2026-07-14):** hybrid — **VanJS 1.5 + VanX 0.6** drive the
  reactive DOM; **Tailwind 4 browser runtime + DaisyUI 5** supply styling/components
  (all vendored, no CDN/build step — the same environment lavish-axi uses, verified
  from its source via opensrc). The forge palette ships as a custom DaisyUI theme.
  Single page, served by the same process. Dashboard backbone: **A + B hybrid** —
  Mission Control home (project rail + cross-project timeline + agent rail) with
  per-project workspace drill-in (tabs: Runs / Coverage / Compile / BDD — Agents tab
  dropped 2026-07-15: agents nest under their project everywhere, §4.11);
  every run card opens a drill-in showing the suite→test tree and, for failures,
  the assertion message + stack trace.
- **TOON (decided 2026-07-14):** agent-facing reads first (`GET /api/v2` orientation,
  events, status, agents) via `?fmt=toon` / `Accept`; JSON default everywhere.
- **Persistence (decided 2026-07-14): embedded SQLite via Bun's built-in
  `bun:sqlite`** (WAL mode, `data/crucible.db`) — no DB server (§7 holds), zero deps,
  transactional crash-safety, and real queries (per-project timelines, coverage
  trends, agent history) that a rewrite-the-file JSON snapshot cannot do. Decisive
  for the **skill-bundle deployment target** (client scripts + server + skill,
  installable on any machine with Bun): the DB ships inside the runtime; the user's
  existing MongoDB is NOT a dependency (a portable bundle cannot assume a running
  mongod, and a single-user localhost dashboard gains nothing from it). The Store
  sits behind a storage interface — a mongo driver stays possible if Crucible ever
  goes hosted/multi-user. The walking skeleton may boot on a JSON snapshot
  (`data/state.json`) behind the same interface; the SQLite swap is a contained
  early CR.

## 3 Domain model

### 3.1 Project
| Field | Type | Notes |
|---|---|---|
| `key` | UUID string | primary id; clients keep it in the SUT's `.env` as `CRUCIBLE_PROJECT_KEY` |
| `name` | string | display name |
| `type` | `"backend"` \| `"frontend"` | v2 (default `backend`). Backend = TDD only (unit/module/e2e/regression tiers). Frontend adds the BDD axis (Playwright/Vitest) later. |
| `sutRoot` | string | absolute path of the SUT repo (wire field: `sut_root`) |
| `createdAt` | epoch ms | |

### 3.2 Agent
Keyed by (`projectKey`, `agentId`). Fields: `agentId`, `projectKey`, `status`
(`online|busy`), `message` (current progress), `identity` (`displayName`, `source`,
`repoPath` — set once, preserved across heartbeats), `firstSeen`, `lastSeen`.

**Liveness state machine** (computed from `lastSeen` at read time):
`online` (< T1) → `stale` (T1–T2) → `tombstoned` (T2–T3) → pruned (> T3).
Thresholds T1/T2/T3 are configurable — server-wide defaults 60 s / 300 s / 1 h
(the v1 values from the agent-protocol skill), overridable per project.
**Every authenticated agent API call is an implicit heartbeat** (kickoff-review
decision 2026-07-14): ingesting a run, querying status — anything carrying an
`agentId` bumps `lastSeen`. An agent actively posting runs never needs a dedicated
ping; explicit heartbeats exist to fill silent stretches and to update `status`/
`message`. Explicit `/api/agents/remove` (clean unregister) deletes immediately.
An agent that fails to unregister is NOT silently dropped: it is shown
**tombstoned** (greyed, last message + time-of-death preserved) so a crashed agent
stays diagnosable, then pruned. Any activity at any point resurrects it.

### 3.3 Run event
One ingest call = one immutable event on the project's timeline.

| Field | Type | Notes |
|---|---|---|
| `id` | `evt-<epoch-ms>-<seq>` | v1 format preserved |
| `projectKey`, `agentId` | | who ran it |
| `kind` | `"test"` \| `"compile"` | strict panel routing (§4.6) |
| `timestamp` | epoch ms | |
| `summary` | `{total, passed, failed, pending, duration_ms}` | test events |
| `tree` | suite→test nodes (`name`, `status: pass|fail|pending`, `duration_ms`); failed leaves additionally carry `failure: {message, type?, trace?}` (v2 — v1 stored no failure detail; codecs preserve the tool's assertion message + stack trace for the UI run drill-in) | test events |
| `tier` | `"unit"` \| `"module"` \| `"integration"` \| `"e2e"` \| `"regression"` \| `"bdd"` | v2 — sent by upgraded clients so the UI represents them differently: unit/module/integration share tools per stack; e2e is a different approach; `bdd` only on frontend projects. Legacy default `unit`. |
| `stack` | `"rust"` \| `"java"` \| `"python"` \| `"ts"` \| `"arduino"` \| … | v2 — which stack produced the run |
| `codec` | `"junit"` \| `"nextest"` \| `"playwright"` \| `"vitest"` \| `"tap"` \| `"rustc"` \| … | v2 — which codec normalized it; drives stack-aware rendering |
| `coverage` | `{lines, functions, branches?}` each `{total, covered, percent}` | only on fully-green runs — server discards otherwise (v1 safety net) |
| `compile` | `{format, errorCount, warningCount, errors: [{file?, line?, col?, code?, message, level}], raw}` | compile events |
| `name` | string? | optional run label |
| `context` | `{git?: {branch, commit}, wave?: string, orchestrator?: "mainline" \| "track-N"}` | v2 (decided 2026-07-14) — ties runs to the exact commit and, in Model-B projects, distinguishes a track's check-run from Mainline's regression on the same timeline. **Every field optional — graceful degradation is a hard requirement**: lightweight projects send no context and the API/UI must never require or fabricate it. |

### 3.4 Ingest state
Per (`projectKey`, `type ∈ unit|bdd`): pointer to the latest test event + latest compile
event — what `/api/ingest/status` reports and `/api/ingest/clear` resets.

## 4 Functional requirements

### 4.1 v1 API surface (DECIDED 2026-07-14: reference, served by a thin shim)
The endpoint catalog in the DN is the **reference** for the clean v2 API and the
**contract for the transition shim**: the original `/api/*` paths keep answering with
v1 shapes (translated onto the v2 core) until the client fleet is migrated to
`/api/v2/*`, then the shim retires. Shim-served quirks (top-level `displayName`
ignored, 400-on-duplicate `projects/add`, `sut_root` snake_case) are NOT carried into
the v2 shapes.
All 13 endpoints, payloads, response shapes, and behavioral invariants cataloged in
[DN-crucible-api-reconstruction.md](DN-crucible-api-reconstruction.md) §2–§3 are
requirements verbatim. Highlights that are easy to get wrong:

- `projectKey` must be a valid UUID → HTTP 400 `{ok:false, error}` otherwise.
- `POST /api/projects/add` with an existing key → HTTP 400 (clients rely on this for
  idempotent self-registration).
- Heartbeat `identity` is optional and preserved when omitted; **top-level `displayName`/
  `source` are tolerated but ignored**.
- `/api/ingest` `dataPath` accepts a file OR a directory (all `TEST-*.xml` inside).
- Coverage arriving with `summary.failed > 0` is discarded server-side.
- `/api/ingest/compile` `format` is optional (`rustc|java|python|typescript`, absent ⇒
  auto-detect, fall back to raw).
- Every mutating response is `{ok:true,…}`; every error carries an actionable `error`
  string (clients print it).

### 4.2 Project registration
- `POST /api/projects/add` — v1 fields + optional `type` (§3.1); key optional in v2
  (server generates UUIDv7 and returns it) for dashboard-driven creation.
- Dashboard can create, rename, and re-type projects.
- `GET /api/projects` returns `{ok, projects:[…]}` with per-project rollups (agent count,
  last event, latest green coverage) so the dashboard renders from one call.

### 4.3 Agent lifecycle
- Heartbeat upserts the agent, bumps `lastSeen`, applies §3.2 identity semantics.
- Liveness computed per §3.2; pruning is lazy (on read) — no background timer needed.
- `GET /api/agents?projectKey=` returns computed `liveness` alongside stored fields.

### 4.4 Test ingest — codec translation layer (design revision 2026-07-14, from kickoff review)
v1's ingest was JUnit-spined; tools without JUnit output were shoehorned in awkwardly and
the BDD/Playwright runtime was never fully realized. v2 replaces "parsers" with a **codec
registry** translating each tool's native output into one **canonical RunSchema**
(summary + suite/case tree + coverage + compile diagnostics, tool-agnostic):

- Codecs at parity: `junit` (with exactly the client parsers' semantics — failure/error →
  fail, skipped → pending, `time`s → duration_ms, `testsuites` or bare `testsuite` root,
  file-or-directory `dataPath`, inline `data`), `rustc`, `javac`, `python`, `tsc`.
- New codecs: `playwright` (JSON reporter — feature → scenario → step, browser, trace
  links), `vitest`, `tap`. Adding a stack = adding a codec; no core changes.
- Every event is stamped with `stack` + `codec` (+ tool version) so the UI renders
  stack-aware views (§4.11) and BDD becomes first-class for frontend projects.
- Parsed path: accept summary/tree/coverage as-is (validate shape, don't recompute).
- Both paths record a `kind:"test"` event and return `{ok, summary}`.

### 4.5 Compile ingest
- Structured parsers per format: `rustc` (`error[EXXXX]` + `--> file:line:col`), java/
  maven (`[ERROR] /File.java:[line,col] msg`), `python` (traceback / SyntaxError),
  `typescript` (`file.ts(line,col): error TSxxxx`). Unknown/absent format → best-effort
  detect → raw fallback (never reject).
- Records a `kind:"compile"` event; response `summary.failed` = errors, `.pending` =
  warnings (v1 client convention).

### 4.6 Panel routing (invariant)
Compile events and test events are separate streams in the UI — a compile failure never
renders as "0/N tests" and an all-fail test run never renders as a compile error. (This
discipline is hammered into every skill; the server enforces it by `kind`.)

### 4.7 Events API + retention
As v1 (list newest-first/limit 50, delete-one, clear-project). Growth is bounded by a
**per-project retention policy** (revised 2026-07-14): the last **100 runs** keep full
fidelity (tree + failure detail, compressed blob storage); older runs roll up into
aggregates (pass/fail counts, duration, coverage) that feed trend views — **per wave**
when `context.wave` is present (a wave's cycle history stays reconstructable), daily
buckets otherwise; raw trees are pruned with the rollup. Per-project override remains.
Events indexed on `(projectKey, timestamp)`. One Bun process is the single writer —
matching SQLite/WAL's concurrency model by construction.

### 4.8 Live updates
`GET /api/stream` — SSE channel broadcasting `{type: "projects"|"agents"|"events", projectKey}`
change hints; the SPA refetches affected slices. Poll fallback every 5 s when SSE drops.

### 4.9 Ingest status (v2 defined shape)
`GET /api/ingest/status?projectKey&type=` →
`{ok, status: {hasData, lastTest: <event summary+id+ts>|null, lastCompile: …|null}}`.
Omitted `type` ⇒ `unit`.

### 4.10 Service health (v1 parity — the backend is monitored too)
`GET /api/health` → `{ok, status:"healthy", version, uptime_s, counts:{projects, agents,
events}}`. The SSE channel emits keep-alive frames every
15 s. The dashboard pins a server-health pill (healthy / unreachable) and visibly greys
all live data when keep-alives stop and a health probe fails — the frontend must never
present stale data as live. Orchestrators may gate wave dispatch on `/api/health`.
Pill fidelity (user-locked 2026-07-15): the pill is the same server-liveness badge on
every surface (home + workspace top bars) — green dot + `server healthy · live / up Xm`,
red dot + `server unreachable · retrying…`; it never shows version or event counts.

### 4.11 Dashboard (v2 UX)
- **Mission Control home (final form — round 7, 2026-07-15, user-locked via review
  board)** — title bar: logo + one-liner slogan + the Health Pill. Below it, the
  **projects row**: a second-row header pane, **flow (wrapping) layout** scaling to
  any project count, one badge per registered project in the canonical format
  (**name + type badge**), ordered **most-recently-active first, inactive last**;
  badge display state is binary **active / inactive** — active while the project
  has ≥1 live agent (agent inactive rules apply); inactive once the system-wide
  configurable project-inactive timeout (`CRUCIBLE_PROJECT_INACTIVE_MS`, default
  1 h) elapses after its last activity (locked round 13; v2 projects listing
  carries additive `active`+`lastActivity`). The row also carries a **⚙ manage
  chip** opening the **Projects manager** (`/manage` slide-over, CR-CRU-012):
  add project + edit name/type/sutRoot/per-project liveness overrides/retention;
  the project key is immutable (additive `PATCH /api/v2/projects/<key>`).
  Projects are **archivable** (round 14, in 0.1.0): archived projects vanish
  from the projects list and their records are excluded from every internal
  query while retained; agent calls → 404 with an archived hint (no
  auto-resurrect); explicit unarchive restores everything intact.
  **Clicking a badge drills down** to `/p/<key>` — never filters. The
  home body is the **collective all-projects timeline** (newest-first, each
  project contributing up to its retention limit) whose **filter pulldown lives in
  the timeline pane header** (default "All projects", filters only the timeline,
  in place). No Projects pane and no agent rows on home. Three levels with a
  consistent `←` back chip: home → workspace (`← projects`) → run drill-in
  (`← timeline`); the back chip behaves exactly like Esc / scrim / browser back.
- **Agents — nested under their project, workspace-only (final form — round 6,
  2026-07-15)** — agents are NEVER a flat standalone section. They render in exactly
  one place: the workspace's right-side **Project pane** — project card (name + type
  badge, agent rollup, coverage meters) with the project's live agents and tombstones
  as `⌁`-marked (heat-amber) indented sub-rows beneath it, then the Vitals cards.
  Each sub-row: liveness dot (🟢 online / 🟡 stale / ⚪ offline), display name, current
  `message`, relative last-seen. The home shows no agents — project chips carry the
  liveness dot. The workspace **Agents tab is dropped**. Agent sub-row click filters
  the visible timeline to that agent (in place). Implementation lands in CR-CRU-007.
- **Run timeline** — newest-first event cards: agent, tier, pass ratio (`34/34` green /
  `3 failed of 5` red / pending count), duration, expandable suite→test tree with per-test
  status; compile cards show error/warning counts and per-file structured errors.
- **RED→GREEN transition marker (= Cycle; terminology locked 2026-07-15)** — when
  an agent's failing run is followed by its passing run, the timeline surfaces the
  transition explicitly (the core TDD story v1 told). A RED→GREEN pair is a
  **Cycle** — one step in a CR's execution; **CR groups cycles, Wave groups CRs**.
  The marker labels the Cycle from `context.cycle` (optional additive RunContext
  string carrying the orchestrator todo's description) with the agent stem as
  identifier. Cycles are DECLARED, not only inferred (locked round 15): the
  orchestrator **files the cycle plan** (`POST /api/v2/projects/<key>/plans`,
  server-assigned numeric cycle ids), activates cycles, and closes them —
  **a cycle's span completes when the orchestrator confirms the GREEN; the CR
  closes on feature merge** (a GREEN run alone never closes anything). Agents
  attach `context.cycleId`; the timeline renders the plan inline (active cycle =
  open event span); the Wave → CR → Cycle **workflow lens** consumes the plan
  first with inferred pairing as fallback; planless projects degrade gracefully.
  Cycles are not only RED→GREEN: **VERIFY and FIX steps are cycles under
  identical rules** (optional `kind: red-green|verify|fix`; locked round 16) —
  `done` = GREEN-confirm / report-acceptance / fix-batch-green respectively.
  **Tracks (locked round 17): a CR is always executed within a track.** Model-B
  track operators register `track` with the CR's plan (clients auto-attach it
  from `WORKFLOW_ROLE`); single-orchestrator projects omit it and work
  seamlessly — the lens renders a Track level only when a wave spans >1 track.
  **Roles vs the tool (corrected round 25):** MAINLINE ORCHESTRATOR and
  ORCHESTRATOR are workflow ROLES; **Crucible is a front-end tool and tracking
  system** — never a workflow actor, never lending its name to workflow
  concepts. Workflow-state env vars are `WORKFLOW_ROLE` (mainline | track-n),
  `WORKFLOW_WAVE`, `WORKFLOW_CYCLE`, `WORKFLOW_CYCLE_ID`; the `CRUCIBLE_*`
  prefix is reserved for Crucible's own configuration.
  **Role hierarchy (locked round 27):** roles nest by scope — MAINLINE
  ORCHESTRATOR (widest: the project workflow — allocates lanes, launches waves,
  gates boundaries) → ORCHESTRATOR (track scope: one lane's CR queue) →
  **RED / GREEN / VERIFY / FIX (agentic roles at the narrowest scope: one phase
  of one cycle)**. Every level is an agent to Crucible; role determines scope
  and authority (file plans / confirm cycles / close CRs / gate waves), and the
  tool observes the hierarchy without being part of it.
  **Containment hierarchy (locked round 18):** Project → mainline orchestrator →
  (spawns) track orchestrators in multi-orchestrator Model B; single-orchestrator
  projects have mainline only (alias **vidushi**). An orchestrator is a **special
  agent** — coordinator/manager of the workflow — and is an agent in every
  respect (registration, heartbeats, runtime, tombstone); its special role is
  filing and driving the cycle plan. Both project shapes are first-class.
  **The highway model (locked round 19):** tracks are numbered lanes — Track 1,
  2, 3… (wire format `track-<n>`) — where **CRs are the vehicles**; the mainline
  allocates CRs to lanes from their depends-on graph (independent CRs run in
  parallel lanes, dependents queue). Track orchestrators enforce the workflow
  rules and verify agents deliver their work accurately within their lane.
  **Wave boundary (locked round 20):** the wave is the synchronization boundary —
  all lanes pause when their individual queues complete; the next wave launches
  after design reviews/corrections. Tracks get NO dedicated UI surface (they are
  transient lanes within a wave): the lens's conditional Track level + badges is
  their whole representation, and the wave group header carries per-lane
  completion chips plus an inferred wave state — `running` → `lanes complete ·
  awaiting review` (the boundary pause) → superseded when the next wave opens.
  No wave-control API; state is inferred from plan states + gate events.
  **Gate events + Workflow tab (locked rounds 21–22):** no-mistakes pipeline runs
  at wave boundaries are ingested as first-class `gate` events (codec
  `no-mistakes`: intent, outcome, step ladder with findings/fix rounds, fixes
  table, pushed commit/PR — a no-mistakes push is categorically distinct from an
  ordinary push, which never reaches Crucible). The timeline renders a full-width
  wave-boundary card; the drill-in mirrors the axi structure. The workspace gains
  a dedicated **Workflow tab** (Runs · Workflow · Coverage · Compile · BDD): live
  section = the open plan as a **per-CR todo view** (active cycle expanded with
  its live runs) beside the **no-mistakes gate pane**; the Wave → [Track] → CR →
  Cycle history lens below. Wave states: `running → lanes complete · awaiting
  review → gated → superseded`. (CR-CRU-011 + CR-CRU-013.)
  **Milestones (locked round 24):** gap-analysis / design-review / stage-flip
  entries are workflow events on the **project workspace timeline ONLY** — the
  home collective feed stays a cross-project run feed (a compact gate entry is
  the one exception). **Execution roadmap (locked round 24):** the Wave → CR
  sequence table with depends-on and DERIVED statuses (PENDING = no plan,
  IN_PROGRESS = open plan, COMPLETED = closed + merge) ships in **0.2.0**
  (CR-CRU-014, schema designed now — storyboard F14); binding forward-compat on
  0.1.0: `plans.cr` is the verbatim stable join key, the queue table is purely
  additive.
  All in v0.1.0: plan API + lens in CR-CRU-011, fleet plan verbs
  (plan-file / cycle-activate / cycle-done / cr-close + `WORKFLOW_CYCLE_ID`) in
  CR-CRU-008.
- **Coverage** — line/function/branch meters on green regression events; latest-green
  coverage shown at project level.
- Localhost tool aesthetics: fast, dense, dark-friendly, zero build step.

**Navigation model (decided 2026-07-14):** two routed pages + one overlay. Mission
Control home (`/`), project workspace (`/p/<key>`), and the run drill-in as a
slide-over overlay (`…/run/<eventId>` suffix) that opens over whichever surface is
active and closes back to its exact state (Esc / scrim / browser back, and the
consistent `←` back chip at every level — round 6). Top-bar project chips drill down
to the workspace; the filter-by pulldown filters the collective home timeline in
place; project cards/names also navigate; workspace agent sub-rows filter the
visible timeline to that agent; run cards open the
drill-in with a codec-aware body (suite tree for tests, per-file diagnostics for
compile); transition markers open the GREEN run with the paired RED one hop away;
coverage trend points open their producing regression run; the health pill never
navigates. All states deep-linkable; SSE keeps every surface live.

**Drill-in density (decided 2026-07-14; tier-default revision 2026-07-15 round
10):** one drill-in surface whose **default mode is contextual by tier** —
`regression`/`e2e` (broad, orchestrator-fired sweeps) open in **Density**; all
other tiers (the focused RED/GREEN/VERIFY/FIX cycle runs) open in **Detail**. The
header **Detail ↔ Density switch is the manual override**, remembered per tier
group — never decided by test count. Compile drill-ins carry no mode switch
(diagnostics-by-file is their single form). Density mode applies:
failures-float/green-folds, heat-strip minimap (1 cell = 1 test, click-to-jump,
any run size), failure digest (identical assertion messages grouped). Always-on in
both modes: virtualized tree, progressive payload paging (suite summaries first,
leaves on expand). Independent: the comfortable/compact/ultra density toggle.
Deferred post-0.1.0: the filter bar (status chips + free-text + module facet).
Compile reporting is agent-agnostic — any agent may post compile/reference
failures; RED agents are the default reporters (TDD).

### 4.12 BDD harness for frontend projects (later wave — approved 2026-07-14)
BDD-style UI testing applies only to `type:"frontend"` projects — and for those,
Crucible is not just a sink: it can **harness and execute the BDD suite on the agent's
behalf** using Playwright (agent asks `POST /api/v2/projects/{key}/bdd/run`; Crucible
runs the suite against the project's `sutRoot`, ingests the result through the
`playwright` codec, and returns the event id). This closes the v1 gap where the
BDD/Playwright runtime was never fully realized. Scoped to a post-skeleton wave.

## 5 Quality requirements
- **E2E POV (user directive 2026-07-15): the design storyboard is the E2E acceptance
  contract.** Once the server + SPA are alive (Wave 3), a browser-driven E2E suite
  (Playwright headless against the real `bun run start` instance) derives its
  scenarios from the storyboard frames — F1 empty state, F2 agent rail, F3 RED card,
  F4/F4½ drill-in + density, F5 compile card, F6 transition marker, F7 coverage,
  F8 workspace, F9 tombstone decay, F10 backend-down grey-out — asserting the
  developed UI matches the storyboarded behavior. Wave-3 UI CRs carry frame-mapped
  E2E ACs; E2E runs ingest into Crucible itself with `tier: "e2e"`.
- Full TDD via the project's own tooling: `bun test`, JUnit reporter, lcov coverage,
  ingested to Crucible itself via `bun-crucible.py` / `crucible-report-bun`.
- Server start < 1 s; ingest of a 1000-case JUnit directory < 500 ms.
- State survives restart (SQLite db reload); a corrupt db file must not prevent boot
  (rename aside, start fresh, log loudly).
- No external network at runtime; all UI assets vendored.

## 6 Rollout (re-decided 2026-07-14: CR-first, no pre-built skeleton)
Implementation proceeds through the CR queue (`docs/changes/README.md`) with
RED/GREEN/VERIFY dispatch per the orchestration flow from the first line of production
code. Wave shape is proposed at wave-open; expected coverage: v1-shim contract tests
(derived line-by-line from the DN), storage (bun:sqlite), codec layer, clean v2
API + AXI, dashboard shell, then depth (drill-in, transitions, coverage trends), then
client-fleet upgrade, then the BDD harness (§4.12). Crucible ingests its own runs
(via `bun-crucible.py` → later `crucible-axi`) as soon as ingest lands.

## 7 Non-goals (v2.0)
- Auth/multi-user/remote hosting; Crucible stays a localhost single-developer tool.
- A database server — embedded `bun:sqlite` only (§2), no external daemon.
- Historical analytics beyond the capped per-project event log (trend charts over
  retained events are in scope; unbounded history is not).
- CodeForge/Velocity integration beyond sharing the agent-protocol conventions.

## 8 Open questions
- (none — storyboard review closed all design questions 2026-07-14)

(Resolved 2026-07-14: upgraded clients send `tier` explicitly — §3.3; BDD uses the
dedicated `playwright` codec with trace links, and Crucible can harness the run —
§4.12; run `context` {git, wave, orchestrator} decided as all-optional — §3.3;
retention: 100 full-fidelity runs + wave-aware rollups — §4.7; TOON: pin the
documented Crucible subset rather than vendoring the reference serializer — both
producer and consumers are our own fleet.)
