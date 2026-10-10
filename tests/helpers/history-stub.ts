// CR-CRU-173 §S1 re-pin helper (approved in advance — spec's "Tests this CR
// knowingly re-pins" list: "History's top level becomes releases: tests
// that read History's first rows as wave headers … or count wave groups at
// the top level — they read the same wave groups one level down, inside
// their release").
//
// GREEN's page (§S1) wraps History in a fetch to the new
// `GET /api/v2/projects/<key>/history` read (cycle 636, server-GREEN) and
// nests every wave it renders one level under a release row instead of at
// History's own top level. Every PRE-EXISTING fixture that mounts the real
// app and opens the Workflow tab therefore needs an answer for that new
// fetch, or GREEN's own `fetch()` call rejects against an unmapped URL (the
// mountApp harnesses across this repo `throw` on one) — this file is the ONE
// shared answer so each pre-existing test file adds a single fetch branch
// rather than re-deriving the shape per file.
//
// What it builds: ONE synthetic release wrapping EVERY wave label the
// test's `plans` fixture carries (`plan.wave ?? ""`, the exact default
// `public/app-logic.mjs`'s `workflowLens` already uses), with that wave's
// EXACT plan-declared CR ids — so GREEN's per-release wave/CR filtering
// (CR-CRU-173 §S2's `HistoryWaveWire.crs`) reproduces precisely the CR
// groups these fixtures already assert, just nested one level deeper. The
// release is ALONE in the `releases` array, so it IS "the open release"
// (RED's own default-open rule for CR-CRU-173 §S1, documented in
// tests/workflow-history-release-tree.test.ts) and starts expanded — none
// of these pre-existing fixtures relied on a folded top level, so nothing
// they already assert moves except its nesting depth.
//
// FORMER KNOWN GAP, RESOLVED at cycle 637 (user ruling 2026-10-09): a
// fixture with NO plans at all — the "inferred fallback" wave/CR tree
// `workflowLens` builds purely from events' `context.wave` — had no plan,
// queue or release record to hang a release row off at all. The ruling
// places a runs-only inferred wave by its FIRST RUN's time, so that one
// fixture (tests/workflow-lens.test.ts's "§S3 history lens — inferred
// fallback (no plan)" describe block) now supplies its own explicit
// `history` stub directly to `mountApp` instead of calling this function
// (which stays plan-driven, unchanged, for every other fixture).
export interface HistoryStubPlan {
  cr: string;
  wave?: string;
}

export interface HistoryStubResponse {
  ok: true;
  releases: Array<{
    labels: string[];
    state: "shipped" | "in progress" | "ship not recorded";
    crCount: number;
    waves: Array<{ wave: string; crs: string[] }>;
    workflows: Array<{ label: string; gateRuns: unknown[]; verificationRuns: number }>;
  }>;
}

export function singleReleaseHistoryStub(
  plans: HistoryStubPlan[],
  label = "0.0.0-test",
): HistoryStubResponse {
  const waveMap = new Map<string, string[]>();
  for (const plan of plans) {
    const wave = plan.wave ?? "";
    const list = waveMap.get(wave) ?? [];
    list.push(plan.cr);
    waveMap.set(wave, list);
  }
  if (waveMap.size === 0) return { ok: true, releases: [] };
  return {
    ok: true,
    releases: [
      {
        labels: [label],
        state: "in progress",
        crCount: new Set(plans.map((p) => p.cr)).size,
        waves: [...waveMap.entries()].map(([wave, crs]) => ({ wave, crs: [...new Set(crs)] })),
        workflows: [{ label, gateRuns: [], verificationRuns: 0 }],
      },
    ],
  };
}
