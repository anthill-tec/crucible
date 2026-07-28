# Crucible — CR Queue

Single source of truth for implementation scheduling. Pick the next `PENDING` row by
phase + dependency order. Conventions: `~/.claude/memory/cr-prd-dn-conventions.md`.

**Design contract:** [../research/PRD-crucible-v2.md](../research/PRD-crucible-v2.md)
**Evidence base:** [../research/DN-crucible-api-reconstruction.md](../research/DN-crucible-api-reconstruction.md)
**Target release:** 0.1.0

| CR | Title | Type | Status | Depends on | Wave |
|---|---|---|---|---|---|
| [CR-CRU-001](CR-CRU-001-domain-core-storage.md) | Domain core + SQLite storage | feature | COMPLETED (2026-07-15) | — | 1 |
| [CR-CRU-002](CR-CRU-002-codec-layer.md) | Codec translation layer | feature | COMPLETED (2026-07-15) | 001 | 1 |
| [CR-CRU-003](CR-CRU-003-v1-shim.md) | v1 shim + contract tests | feature | COMPLETED (2026-07-15) | 001, 002 | 1 |
| [CR-CRU-004](CR-CRU-004-v2-api.md) | Clean v2 API + SSE | feature | COMPLETED (2026-07-15) | 003 | 2 |
| [CR-CRU-005](CR-CRU-005-axi-toon.md) | AXI layer: TOON subset + hints | feature | COMPLETED (2026-07-15) | 004 | 2 |
| [CR-CRU-006](CR-CRU-006-spa-shell.md) | Dashboard shell + navigation | feature | COMPLETED (2026-07-15) | 004 | 3 |
| [CR-CRU-007](CR-CRU-007-timeline-drill-in.md) | Timeline + density drill-in | feature | COMPLETED (2026-07-16) | 006 | 3 |
| [CR-CRU-008](CR-CRU-008-cli-fleet-upgrade.md) | crucible-axi CLI + fleet upgrade + plan verbs | feature | COMPLETED | 005, 007, 011 | 4 (after 011) |
| [CR-CRU-009](CR-CRU-009-release-0.1.0.md) | Release 0.1.0 skill bundle | feature | COMPLETED (2026-07-23 — merged 9eb0bec; staged distro-agnostic installer + skill bundle + release CI. The release CEREMONY itself is a separate human-gated phase, NOT started) | 007, 008, 011, 012, 013, 016 | 4 |
| [CR-CRU-010](CR-CRU-010-codec-path-interface-hardening.md) | Codec parsePath + shim hardening | maintenance | COMPLETED (2026-07-15) | 006 | 3 (after 006, before 007) |
| [CR-CRU-016](CR-CRU-016-inpane-drill-in.md) | In-pane drill-in (replaces slide-over) | feature | COMPLETED (2026-07-16) | 007 | 4 (first after 007) |
| [CR-CRU-019](CR-CRU-019-patch-workflow-tweaks.md) | Patch: workflow-review tweak accumulator | patch | COMPLETED (2026-07-16) | 011 | 4 (after 011) |
| [CR-CRU-011](CR-CRU-011-workflow-lens.md) | Cycle plans + workflow lens + agent runtimes | feature | COMPLETED (2026-07-16) | 007 | 4 (after 016) |
| [CR-CRU-020](CR-CRU-020-patch-workflow-history-refinements.md) | Patch: workflow history view refinements | patch | COMPLETED (2026-07-16) | 011, 019 | 4 (after 019) |
| [CR-CRU-021](CR-CRU-021-patch-workflow-primary-tab.md) | Patch: Workflow as the primary workspace tab | patch | COMPLETED | 020 | 4 (after 020) |
| [CR-CRU-023](CR-CRU-023-patch-pane-min-width-scroll.md) | Patch: gate-review defects — pane scroll floor · vitals trend chart · timer restart semantics | patch | COMPLETED | 021 | 4 |
| [CR-CRU-012](CR-CRU-012-projects-manager.md) | Projects manager: add + edit + archive | feature | COMPLETED | 004, 007 | 4 (before 009) |
| [CR-CRU-013](CR-CRU-013-gate-events.md) | Workflow events: gates (no-mistakes) + milestones | feature | COMPLETED (merged c7660b1) | 008, 011 | 4 |
| [CR-CRU-031](CR-CRU-031-wave-classification-fix.md) | Wave-classification fix: server wave-backfill + plan-file --wave + CR-021 correction | patch | COMPLETED | 011, 013 | 4 (right after 013) |
| [CR-CRU-030](CR-CRU-030-fleet-toon-axi-compliance.md) | Fleet TOON-AXI conversion + full AXI-CLI compliance + mandatory classification context (all 5 clients, shared module) | patch | COMPLETED (2026-07-21 — merge-gate exception: 34 CR-008 TS tests deferred to 036) | 013 | 4 (before 009) |
| [CR-CRU-036](CR-CRU-036-patch-client-axi-transition-fixes.md) | Patch: client TOON-AXI transition fixes — §S9 server-active-cycle (remove WORKFLOW_CYCLE_ID, warn+withhold) + CR-008 TS test retarget + fleet coverage-uniformity | patch | COMPLETED (2026-07-22 — merged 949a2f4; gate 996/0, cov 85.8%/91.1%) | 030 | 4 |
| [CR-CRU-037](CR-CRU-037-patch-workflow-card-correctness.md) | Patch: workflow-card correctness — parallel-agent liveness dimming + plan-file no-title warning + null-title CR fallback | patch | COMPLETED (2026-07-22 — merged 3c7a7a4; gate 1001/0, cov 89.3%/87.9%) | 011, 008 | 4 |
| [CR-CRU-038](CR-CRU-038-patch-run-detail-controls.md) | Patch: run-detail drill-in controls — minimized error tree (failing-suite headers only) + working per-test-preferred raw-output toggle (hidden when empty) + failure-jump/raw controls relocated to header beside density chip + storyboard sync + §S2b server-side raw-output CAPTURE (junit system-out/err → RunEvent.raw + all 5 clients send captured output) | patch | COMPLETED (2026-07-22 — merged c41c4c0; gate 1016/0 + e2e 33/0) | 016, 034 | 4 |
| [CR-CRU-035](CR-CRU-035-ambient-context-session-hooks.md) | Ambient-context read-path contract (AXI principle 7) — RE-SCOPED: Crucible ships the hook-safe/AXI-compliant `status` verb + versioned STATUS-CONTRACT.md only; hooks/skills owned by Model-B (msg 1334) | feature | COMPLETED (2026-07-22 — merged bad69f0) | 030 | 4 |
| [CR-CRU-024](CR-CRU-024-patch-cycle-activation-guards.md) | Patch: cycle activation guards · sanctioned mid-plan mutation (insert/edit, active locked) · AXI invalid-action responses | patch | COMPLETED | 011 | 4 |
| [CR-CRU-025](CR-CRU-025-cycle-run-boundary-navigation.md) | Cycle ↔ run-boundary navigation (bidirectional, locate blink) | feature | COMPLETED | 011, 012 | 4 |
| [CR-CRU-026](CR-CRU-026-patch-workspace-plan-scoping.md) | Patch: workspace plan scoping — remove hidden navigation state, marker parity (P0) | patch | COMPLETED | 011, 021 | 4 |
| [CR-CRU-027](CR-CRU-027-patch-coverage-trend-fidelity.md) | Patch: coverage-trend mock fidelity — F8 sparkline geometry (P1, after 026) | patch | COMPLETED | 023 | 4 |
| [CR-CRU-033](CR-CRU-033-coverage-by-day-series.md) | Date-keyed coverage-by-day series (CR-028 data prerequisite) — fold re-key + merge rollups & live events | feature | COMPLETED | 023, 032 | 4 |
| [CR-CRU-028](CR-CRU-028-patch-coverage-trend-semantics.md) | Coverage trend: auto-coarsening health hierarchy (DN-locked) | feature | COMPLETED | 033, 027 | 4 |
| [CR-CRU-029](CR-CRU-029-patch-dual-axis-scroll-visibility.md) | Patch: dual-axis scroll always operable in narrow viewports | patch | COMPLETED | 023 | 4 |
| [CR-CRU-034](CR-CRU-034-patch-drilldown-dual-axis-scroll.md) | Patch: run-detail drill-down inherits CR-029 dual-axis operability (multi-failure vertical scroll trap + dead space) | patch | COMPLETED | 029, 007, 016, 023 | 4 |
| [CR-CRU-032](CR-CRU-032-runs-boundary-anchor-fetch.md) | Patch: Runs-window governance + project-settings integrity — retention governs the display limit (kills hardcoded 50), anchor-fetch beyond-window (025 b), settings-form labels + run-deletion toggle F12 sync | patch | COMPLETED | 025, 012, 008 | 4 |
| [CR-CRU-039](CR-CRU-039-python-regression-discovery.md) | Patch: python-client `regression` discovers 0 tests (silent gate gap) — tests packages + definitive `no-tests-discovered` AXI error | patch | COMPLETED (2026-07-23 — merged f13a5d0; Python gate 0 → 376 tests) | 036 | 4 |
| [CR-CRU-040](CR-CRU-040-python-coverage-tooling.md) | Patch: python-client coverage tooling — `coverage` dev dep + `--cov-source` default `crucible_axi,clients` (was nonexistent `app`) | patch | COMPLETED (2026-07-23 — merged 5b516e2; regression 382/382 with real coverage 72.8% ln / 79.7% fn) | 039 | 4 |
| [CR-CRU-041](CR-CRU-041-release-mechanism.md) | Release mechanism (Sandesh-shaped): publishable `@anthill-tec/crucible-server` pkg + `release.yml` chain repair (push-master → Release → publish) + branch-gated `scripts/release.sh` with pre-tag manifest & tag-prefix guards + `RELEASING.md` + `vX.Y.Z` tags + composite lockstep pin | feature | COMPLETED (2026-07-28 — merged 3ac8d6e; plan 46 all 5 cycles; gate py 392/392 + bun 1081/1082, the 1 being CR-045's inherited defect) | 009 | 4 |
| [CR-CRU-042](CR-CRU-042-exit-skills-ownership.md) | Patch: Crucible exits skills — remove the `[skills]` install stage (`STAGE_ORDER` → server, manifest), retire `SKILLS_CLI_SOURCE`, freeze `clients/skills/`; CR-009 §S3 + §S4-skills VOID (Model B took full skills ownership, Sandesh 1337) | patch | PENDING (0.1.0 blocker) | 009, 035 | 4 |
| [CR-CRU-043](CR-CRU-043-installed-db-path.md) | Patch: installed server misplaces its DB (CWD-relative default) — `CRUCIBLE_DB` override + XDG user-data default + adopt-existing-`data/crucible.db` rule (dog-food continuity, no migration) | patch | PENDING (0.1.0 blocker) | 009 | 4 |
| [CR-CRU-044](CR-CRU-044-phase-as-first-class-data.md) | Patch: agent phase must be declared data, not an agentId naming convention — server REQUIRES the `phase` enum and classifies on it; `--phase` sent by all 5 clients (was discarded); UI reads stored phase, `phaseRole(agentId)` demoted to a history fallback | patch | PENDING | 030, 036 | 4 |
| [CR-CRU-045](CR-CRU-045-coverage-shadow-regression.md) | Patch: the `coverage/` shadow test over-specifies its contract — it plants `coverage/__init__.py` (a REGULAR pkg) while CR-036 specified a bare dir and bun's real lcov output has no `__init__.py`; re-point the test to the real shape | patch | PENDING | 036, 040 | 4 |
| [CR-CRU-014](CR-CRU-014-execution-roadmap.md) | Execution roadmap: queue + Wave/CR table | feature | PENDING (0.2.0 · track-1) | 011, 013 | 5 (0.2.0) |
| [CR-CRU-015](CR-CRU-015-bdd-harness.md) | BDD harness: Playwright runner + codec + tab | feature | PENDING (0.2.0 · track-2) | 004, 007 | 5 (0.2.0) |
| [CR-CRU-017](CR-CRU-017-run-lifecycle.md) | Run lifecycle: start/end + Aborted state | feature | PENDING (0.2.0 · track-3 cand.) | 008, 011 | 5 (0.2.0) |
| [CR-CRU-018](CR-CRU-018-responsive-mobile.md) | Responsive: mobile + tablet media | feature | PENDING (0.2.0) | 016 | 5/6 (0.2.0) |
| [CR-CRU-022](CR-CRU-022-roadmap-analytics.md) | Roadmap analytics: velocity + burndown + forecast | feature | PENDING (0.2.0) | 011, 014 | 5/6 (0.2.0) |

## Notes
- 2026-07-14 — Project kickoff: PRD + evidence DN landed. Kickoff design review (lavish)
  locked six decisions: A+B hybrid dashboard (Mission Control home + project workspace
  drill-in); TOON on agent-facing reads first; REST AXI + `crucible-axi` npx CLI; hybrid
  UI stack (VanJS/VanX + Tailwind 4 browser runtime + DaisyUI 5, forge as custom theme);
  clean v2 API at `/api/v2/*` with a thin v1 shim on legacy `/api/*` + client-fleet
  upgrade (shim retires post-migration). Plus: codec translation layer (canonical
  RunSchema, failure detail preserved), ingest-as-implicit-heartbeat, configurable
  liveness thresholds, tombstoned agents, server self-health, BDD harness (later wave).
  Persistence: bun:sqlite (skill-bundle portability); retention rollup.
- 2026-07-14 (later) — Q4 RE-DECIDED during storyboard review: **CR wave first** — no
  pre-built walking skeleton; implementation starts with specs + RED/GREEN/VERIFY
  dispatch per the orchestration flow.
- 2026-07-14 (storyboard close) — Design phase COMPLETE: navigation model approved;
  density verdicts (ideas 1–5, 7 in 0.1.0; filter bar post-0.1.0); run context
  {git, wave, orchestrator} all-optional/graceful; retention 100 + wave rollups; TOON
  subset pinned; BDD harness approved for a later wave. Spike code deleted from tree
  (vendor libs kept). **Queue filed (9 CRs, 4 waves) — specs only; Wave 1 dispatch
  awaits user go.** Post-0.1.0 backlog (not yet filed): filter bar, BDD harness +
  playwright/vitest/tap codecs, shim retirement, coverage-trend deep views.
- 2026-07-15 — Wave 1 executing. CR-CRU-001 shipped (VERIFY CONFIRMED, 12/12 ACs,
  49 tests, 100% fn / 97.6% ln coverage). Scope move at CR-CRU-002 gap-analysis:
  minimal `POST /api/ingest` + `POST /api/ingest/compile` routes move from CR-CRU-003
  into CR-CRU-002 (the codecs' production seam); CR-CRU-003 hardens them to the full
  DN quirk contract + remaining endpoints + contract tests. Deferred register:
  removeAgent no-op change-event (RESOLVED in 003); CLI-bootstrap smoke test (→ 009);
  dataPath-bypasses-registry (→ BDD wave codec interface); per-branch 400 assertions;
  dedicated v1→v2 cross-surface regression test.
- 2026-07-15 (Wave 2 close) — CR-CRU-004 + CR-CRU-005 shipped; 219 tests. WAVE-3-OPEN
  DECISION POINT (user-directed): reshape `eventBrief` (hoist summary scalars) so
  TOON's uniform-table form applies to events[] — measured ratio currently 105% of
  JSON for nested shape (DN-crucible-toon-subset §Measured token-ratio); decide
  together with the SPA's consumption of the same payload in CR-CRU-006/007.
- 2026-07-15 (design iteration, post CR-010) — board micro design iteration APPROVED
  (final round): agents render nested under their project everywhere (⌁ glyph, heat
  tint; tombstones too); workspace Agents tab dropped; home top bar simplified (logo +
  slogan + filter-by pulldown + health — no project chips); Projects-pane rows drill
  down to the workspace (never filter); `← projects` breadcrumb workspace-only. PRD
  §4.11 + nav model synced; the whole set folds into CR-CRU-007 (spec §S5, re-baselined
  same day). Process rule recorded: micro design iterations run between CRs on develop,
  no active feature flow.
- 2026-07-15 (design iteration rounds 8–11) — drill-in mode: tier-contextual default
  (regression/e2e → Density; focused cycle tiers → Detail) + manual override per tier
  group, never test-count; compile drill-ins carry no mode switch; compile reporting
  agent-agnostic. Terminology locked: RED→GREEN pair = Cycle, CR groups cycles, Wave
  groups CRs; marker labeled via additive `context.cycle` (fleet sends in CR-008).
  Round-11: workflow lens USER-SCHEDULED INTO v0.1.0 → CR-CRU-011 filed (Wave 4,
  before 009; 009 now depends on 011). Backwards audit of the agent API found the
  lifecycle gap (unregister hard-deletes firstSeen/lastSeen → runtime lost) — closed
  by CR-011 §S1 lifecycle events.
- 2026-07-15 (during CR-007 execution) — §S2 markers re-baselined to STREAK-based
  pairing (live view showed marker proliferation; declared plans supersede the
  heuristic in CR-011 — orchestrator todo-complete IS the boundary). Storyboard
  100%-compliance locked as the acceptance bar (fidelity batch running in C5).
  USER-APPROVED: post-0.1.0 this project shifts to the MULTI-TRACK model —
  0.2.0 = Wave 5 running CR-014 (track-1) ∥ CR-015 (track-2, BDD harness, filed
  with full ACs incl. the multi-track dog-food AC); CR-011's commit-boundary
  query added (closed plans expose mergeCommit + run-commit range).
- 2026-07-15 (design iteration rounds 25–31, close) — roles-vs-tool correction
  (`WORKFLOW_*` env vars; `CRUCIBLE_*` = tool config only); role hierarchy
  (Mainline Orchestrator → Orchestrator → RED/GREEN/VERIFY/FIX, authority follows
  scope); Model B in one sentence (actions by actors with roles); product
  definition locked (Crucible = the tracking system for the Model-B workflow);
  roadmap navigation resolved (/p/<key>/roadmap slide-over); nav map finalized.
  The whole ontology is consolidated in
  [DN-model-b-language.md](../research/DN-model-b-language.md) (user-directed,
  round 31 — "document so we don't lose context").
- 2026-07-15 (design iteration rounds 23–24) — milestones folded into CR-013
  (renamed "Workflow events: gates + milestones"): gap-analysis / design-review /
  stage-flip entries on the PROJECT WORKSPACE timeline only (home stays a
  cross-project run feed; compact gate entry is the exception). Execution roadmap
  (Wave→CR table, derived statuses PENDING/IN_PROGRESS/COMPLETED) user-scheduled
  to 0.2.0 → CR-CRU-014 filed now with the schema + a BINDING forward-compat
  contract on 0.1.0 (plans.cr = verbatim stable join key; queue table additive).
  Storyboard gained F13 (Workflow tab) + F14 (roadmap, 0.2.0-badged); F8/F11 tab
  rows show the Workflow tab.
- 2026-07-15 (design iteration rounds 16–22) — cycle kinds (verify/fix identical
  rules); tracks = numbered lanes, CR always within a track (plan `track`, auto from
  `WORKFLOW_ROLE`); containment hierarchy locked (Project → mainline
  [vidushi] → spawns track orchestrators; orchestrator = special agent); wave =
  sync boundary, no dedicated track UI, wave state inferred; no-mistakes runs at
  wave boundaries ingested as `gate` events → CR-CRU-013 filed (boundary card,
  gate drill-in, Workflow-tab no-mistakes pane, gate-report verb, `gated` wave
  state); CR-011 §S3 restructured to a dedicated Workflow tab (live per-CR todo
  view + gate pane, history lens below). Order: 007 → 011 → 008 → 012 → 013 → 009.
- 2026-07-15 (design iteration rounds 14–15) — CR-012 gained §S1b archive/unarchive
  (user: in 0.1.0). Cycle-plan API user-locked: orchestrator FILES the cycle plan
  (todo list) → server-assigned numeric cycle ids → agents attach `context.cycleId`;
  a cycle's span completes when the ORCHESTRATOR confirms the GREEN (`done`); the CR
  closes on feature MERGE (`closed` + commit); plan verbs encoded in the python/fleet
  clients (CR-008). Plan API folded into CR-011 (renamed "Cycle plans + workflow
  lens"; lens is plan-first, inferred fallback; planless projects unchanged).
  REORDERED: 011 before 008 → execution order 007 → 011 → 008 → 012 → 009.
- 2026-07-15 (design iteration round 13) — project activity rule locked: active while
  ≥1 live agent; inactive after the system-wide configurable timeout
  (`CRUCIBLE_PROJECT_INACTIVE_MS`, default 1 h) from last activity; v2 projects
  listing gains additive `active`+`lastActivity` (CR-007 §S5). Missing surface filed:
  CR-CRU-012 Projects manager (⚙ manage chip → /manage slide-over; add + edit
  name/type/sutRoot/liveness overrides/retention; key immutable; additive
  `PATCH /api/v2/projects/<key>`) — Wave 4 before 009; 009 depends on it. Storyboard
  gained frame F12.
- 2026-07-15 (post-merge review) — no-mistakes hardening landed on develop after the
  CR-CRU-006 merge: ingest parse/`dataPath` failures now return 400 `{ok:false, error}`
  on BOTH surfaces (v1 `/api/ingest` + v2 `/api/v2/runs`, shared `parseRunBody` core —
  never a plain-text 500); server binds loopback `127.0.0.1` by default (`CRUCIBLE_HOST`
  / `hostname` opt override); SPA guards against duplicate `EventSource` connections;
  retention fold+delete is one transaction; `Store.hasAgent` backs the v2 `changed`
  flags. CR-CRU-010's Context re-baselined (the `parseJunitPath` special-case now lives
  in `parseRunBody`, not `src/server.ts`/`src/v2.ts`).
- 2026-07-21 — CR-CRU-034 filed (P1 regression, Wave 4, before 030). Eyes-on the
  dog-food run detail (`crucible_drilldown.jpg`) surfaced a CR-CRU-029 regression:
  the run-detail drill-down kept its CR-CRU-007 §S4 item 4 inner `.app-tree-scroll`
  (`max-height:60vh`) while CR-029 made `pane-scroll` flex-fill the viewport — so a
  run with ≥2 failures traps the vertical scroll in a cramped inner box, leaves
  ~290px dead space below the footer, and (on shorter viewports) hides the footer.
  034 unifies the run-detail body onto CR-029's one-bounded-scroller-owns-both-axes
  model while PRESERVING CR-029's horizontal contract (user directive: the vertical
  fix must match the narrow-viewport horizontal requirement).
- 2026-07-21 (later) — CR-CRU-034 gap analysis (verdict SPEC_UPDATE_NEEDED): corrected
  provenance (the virtualized `tree-scroll`+60vh is CR-007 §S4 item 4, not CR-028 §S4.4;
  the footer-jump focus-model is CR-016 §S2, not CR-028 §S2) → Depends-on now 029/007/016/023;
  §S1 mechanism pinned (pane-scroll owns both axes, virtualization re-sources off pane-scroll);
  added a ≥2-failing-suites AC. Confirmed the fix completes CR-029 §S1's own mechanism (a) and
  scroll-restore already targets pane-scroll (§S2 stays green). Retarget contained to
  `density.test.ts` §S4 item 4 (no e2e coupling). Ready for feature branch + RED.
- 2026-07-21 (merge) — CR-CRU-034 shipped on develop (merge 8c2bdc0): pane-scroll is the
  run-detail body's sole bounded dual-axis scroller (60vh `.app-tree-scroll` trap retired;
  CR-007 §S4 virtualization re-sourced off pane-scroll via `handlePaneScroll` + per-suite
  offset windowing; covers home RunDetail + WorkspaceRunDetail); CR-029 horizontal contract
  preserved. VERIFY APPROVE; 979/979 unit · e2e 40/40 · lines 85.8% · tsc 0; cycles 81-82.
  Follow-up (VERIFY suggestion, non-blocking, NOT filed as a CR): `handlePaneScroll` runs an
  un-debounced `querySelectorAll('[data-testid="tree-scroll"]')` per scroll tick — harmless at
  realistic suite counts; revisit only if a run ever auto-expands dozens of failing suites.
- 2026-07-21 (CR-030 gap analysis + AXI expansion) — verdict SPEC_UPDATE_NEEDED (no
  blocker, no prerequisite CR — server routes for §S4/§S6/§S7 exist). Corrected framing:
  the net-new verbs (§S4 cycle-add, §S6 status/plans, §S7 checkpoint/stop/abort, §S8
  prefer-gate-run warning, §S9 auto-attach) + the AXI-CLI conventions are ABSENT even in
  the bun "reference" — built in a NEW shared module `clients/_crucible_axi.py` (the 5
  clients don't currently share code; user decision), bun reference first, then the other
  four; bun's own gaps fixed here too (user directive). Checked the fleet against the AXI
  manifesto (https://axi.md, 10 principles) — added §S10–§S15 for principles 2,3,4,5,6,8,9
  (minimal schemas/--fields, truncation/--full, aggregates+empty-states, structured
  errors on stdout+exit codes, content-first no-arg dashboard, help[] next-steps). Size
  re-estimated M–L → L. Principle 7 (ambient-context session hooks) SPLIT to CR-CRU-035,
  a coordinated Crucible↔Model-B effort: Crucible builds core python scripts (`setup` +
  interface contract) → intimates Model-B → Model-B owns hook templates + generation
  (shared responsibilities negotiated at handoff).
- 2026-07-23 (WAVE 4 CLOSE — every 0.1.0 CR is COMPLETED) — CR-CRU-009 shipped the
  release machinery (curl→uv→`crucible-axi install` staged installer, 8 skills conformed +
  new arduino skill, `crucible-server` bin shim, RUNBOOK, consolidated
  `.github/workflows/release.yml` with PyPI OIDC + Test-PyPI dry-run + npm provenance).
  Its close-out gate then exposed TWO silent Python-gate defects, filed and shipped as
  patches the same day: **CR-CRU-039** — `regression` discovered 0 tests (all tests live
  under `tests/client/`, which was not a package, so `discover -s tests` never recursed);
  a zero-discovery run was misreported as a "compile" ingest. Fixed by making the suite
  discoverable + emitting a definitive `no-tests-discovered` AXI error instead of a false
  green. **CR-CRU-040** — even once running, coverage was unobtainable: `coverage.py` was
  not a declared/installed dev dependency and `--cov-source` defaulted to a nonexistent
  `app` package. Fixed by declaring the `dev` extra and defaulting the source to
  `crucible_axi,clients` (both `regression` and `pre-merge-gate`); the obsolete
  `PYTHONSAFEPATH=1` guard was dropped since it leaked into grandchild test subprocesses.
  Net: the Python close-out gate went from silently running NOTHING to 382 tests with
  real coverage-on-green.
  **The 0.1.0 RELEASE CEREMONY is NOT started** — it is a distinct, human-gated phase
  (CR-009 §S6: release branch → no-mistakes gate + QC → version 0.1.0 → tag → CI publish,
  Test PyPI first; also requires open-sourcing the repo + publish credentials). It must
  never be inferred from a CR completing; it needs its own explicit go.

- 2026-07-28 (CR-CRU-045 §S3 — **cross-stack gate rule for the client fleet**) — a change to
  `clients/*-crucible.py` requires **BOTH** the Python gate and the bun gate before close-out.
  Those clients are Python programs whose observable contract is asserted by **bun** tests
  (`tests/clients-*.test.ts` drive them as subprocesses against a real server), so a
  single-stack gate is not sufficient evidence for a client change. CR-CRU-040 gated on Python
  only (382/0) and left `tests/clients-python-arduino-crucible.test.ts` red; that went
  unnoticed until the CR-CRU-041 C1 orchestrator gate several CRs later. The same lineage had
  already produced CR-039 (regression discovered 0 tests) and CR-040 (coverage unobtainable) —
  each caught by the NEXT CR's gate rather than its own. Run both gates.
