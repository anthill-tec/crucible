# Crucible — CR Queue

Single source of truth for implementation scheduling. Pick the next `PENDING` row by
phase + dependency order. Conventions: `~/.claude/memory/cr-prd-dn-conventions.md`.

**Design contract:** [../research/PRD-crucible-v2.md](../research/PRD-crucible-v2.md)
**Evidence base:** [../research/DN-crucible-api-reconstruction.md](../research/DN-crucible-api-reconstruction.md)

| CR | Title | Type | Status | Depends on | Notes |
|---|---|---|---|---|---|
| — | — | — | — | — | Queue opens at wave-open after kickoff review. |

## Notes
- 2026-07-14 — Project kickoff: PRD + evidence DN landed; walking skeleton (compatible
  API core + minimal dashboard) built on `develop` as the baseline the first CR wave
  hardens. CR decomposition is proposed to the user at wave-open, not pre-written here.
