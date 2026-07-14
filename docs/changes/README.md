# Crucible — CR Queue

Single source of truth for implementation scheduling. Pick the next `PENDING` row by
phase + dependency order. Conventions: `~/.claude/memory/cr-prd-dn-conventions.md`.

**Design contract:** [../research/PRD-crucible-v2.md](../research/PRD-crucible-v2.md)
**Evidence base:** [../research/DN-crucible-api-reconstruction.md](../research/DN-crucible-api-reconstruction.md)

| CR | Title | Type | Status | Depends on | Notes |
|---|---|---|---|---|---|
| — | — | — | — | — | Queue opens at wave-open after kickoff review. |

## Notes
- 2026-07-14 — Project kickoff: PRD + evidence DN landed. Kickoff design review (lavish)
  locked six decisions: A+B hybrid dashboard (Mission Control home + project workspace
  drill-in); TOON on agent-facing reads first; REST AXI + `crucible-axi` npx CLI; walking
  skeleton on `develop` before the CR queue opens; hybrid UI stack (VanJS/VanX + Tailwind 4
  browser runtime + DaisyUI 5, forge as custom theme); clean v2 API at `/api/v2/*` with a
  thin v1 shim on legacy `/api/*` paths + client-fleet upgrade. Plus: codec translation
  layer (canonical RunSchema, failure detail preserved), ingest-as-implicit-heartbeat,
  configurable liveness thresholds, tombstoned agents, server self-health, BDD harness
  (later wave). CR decomposition is proposed at wave-open after the skeleton lands.
