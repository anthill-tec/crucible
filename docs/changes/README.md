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
| [CR-CRU-007](CR-CRU-007-timeline-drill-in.md) | Timeline + density drill-in | feature | PENDING | 006 | 3 |
| [CR-CRU-008](CR-CRU-008-cli-fleet-upgrade.md) | crucible-axi CLI + fleet upgrade | feature | PENDING | 005, 007 | 4 |
| [CR-CRU-009](CR-CRU-009-release-0.1.0.md) | Release 0.1.0 skill bundle | feature | PENDING | 007, 008, 011, 012 | 4 |
| [CR-CRU-010](CR-CRU-010-codec-path-interface-hardening.md) | Codec parsePath + shim hardening | maintenance | COMPLETED (2026-07-15) | 006 | 3 (after 006, before 007) |
| [CR-CRU-011](CR-CRU-011-workflow-lens.md) | Workflow lens: Wave→CR→Cycle + agent runtimes | feature | PENDING | 007, 008 | 4 (before 009) |
| [CR-CRU-012](CR-CRU-012-projects-manager.md) | Projects manager: add + edit | feature | PENDING | 004, 007 | 4 (before 009) |

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
