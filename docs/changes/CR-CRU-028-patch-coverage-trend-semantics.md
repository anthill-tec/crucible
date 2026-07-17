# CR-CRU-028 — Patch: coverage-trend semantics — level-colored bars + series granularity

**Status:** PENDING
**Type:** patch
**Priority:** P2
**Depends on:** CR-CRU-027 (sparkline geometry), CR-CRU-023 (trend series)
**Labels:** patch, ui, vitals
**Phase:** Wave 4 — slot proposed after CR-CRU-008 (user to confirm; both
open questions below must be ruled before RED)
**Design reference:** user board ruling 2026-07-17 on the F8 trend bars:
"these bars should show green because they are showing high coverage. The
orange-yellow-green gradient can also use to benefit here!"; granularity
investigation same day (chat): the 2-bar mystery traced to rollup-bucket
sourcing.

## Context
Two semantic gaps remain after CR-027 fixed the geometry:
1. **Color carries no meaning:** bars use history-dim/latest-bright ember
   only; a 94.4% bar and a 60% bar look identical. The F8 mock now shows
   the ruled form: bar color encodes the coverage LEVEL on the
   orange→yellow→green ramp.
2. **Series granularity is bucket-coarse:** `coverageTrend` derives from
   rollup buckets (`context.wave` ?? UTC day, store.ts foldIntoRollup),
   whose `last_coverage` updates only as events age past the 100-run
   retention. A day of many coverage runs = ONE bar, valued at what has
   aged out — measured live 2026-07-17: two bars [94.4, 93.1] while five+
   coverage runs sat un-represented inside the retention window.

## Scope

### §S1 Level-colored bars (RULED)
Each bar's color derives from ITS point's value on the established
orange→yellow→green ramp. Storyboard F8 contract (synced 2026-07-17):
orange (--ember) below 65, yellow (#eab308) 65-80, green (--pass) ≥80 —
EXACT thresholds are a gap-analysis decision (candidates: align with any
existing coverage-health thresholds in the codebase; else adopt the mock's
65/80). The latest-bar emphasis (bright vs dim history) composes WITH the
level color (opacity, not hue). CR-027's geometry pins are untouched.

### §S2 Per-run series granularity (OPEN — awaiting user ruling)
Recommendation presented 2026-07-17 (option 2): the series becomes one
point per coverage-bearing green regression — RETAINED events contribute
live per-run points; rollup buckets remain the durable fallback for pruned
history (prefix). The CR-027 last-16 window then shows a true run-by-run
recent trend. Alternative (option 1): keep bucket granularity (one bar per
day/wave). DO NOT start RED until the user rules; if option 1 is chosen,
§S2 reduces to a spec note and this CR ships §S1 alone.

## Acceptance criteria
- [ ] §S1: with a series spanning the ramp (e.g. 55, 70, 92), each bar carries the level class/color for its own value (exact thresholds per gap analysis, pinned as constants); the latest bar keeps its emphasis treatment composed with its level color; a monotone high series renders all-green bars (the user's screenshot case).
- [ ] §S1: CR-027 geometry pins unchanged (9px/26px/left-aligned/last-16).
- [ ] §S2 (if ruled per-run): a project with N ≤ 16 coverage-bearing green regressions inside retention renders N bars (one per run, chronological); with runs aged out, the pruned prefix degrades to bucket values (durable series never shrinks below the rollup history); caption stays window-consistent.
- [ ] Eyes-parity: Chrome-measured against the synced F8 mock before verify.

## Estimated size
XS (§S1 alone) / S (with §S2).

## Non-goals
Charting-library adoption (CR-022); changing the coverage METER's ember
gradient (separate element, already mock-faithful).
