// CR-CRU-013 §S4b (milestone-entry, workspace-only) + §S4c (⚑ merge-marker
// break row) + home/workspace scoping — C2 RED tests.
//
// Spec: docs/changes/CR-CRU-013-gate-events.md §S4b/§S4c (+ Implementation
// Notes). §S1's sibling server foundation (C1) is LIVE — milestone events are
// stored `kind:"milestone"`, `type` one of gap-analysis/design-review/
// stage-flip/custom/cr-merged, with `label`/`context`/`commit` (cr-merged
// only) round-tripping verbatim (tests/gate-milestone-server.test.ts already
// pins the server side).
//
// Current code facts (verified against public/app.js on this branch):
//   - runFeed() (app.js ~L749) only knows 4 timelineRows kinds — a milestone
//     event (kind "milestone") falls through `else rows.push(EventCard(...))`
//     and renders as an ordinary run card, on BOTH home and workspace (no
//     surface distinction exists anywhere — Implementation Notes: "the
//     home-vs-workspace surface branch is NET-NEW").
//   - TimelineFeed (home) and WorkspaceRunsFeed (workspace) both call
//     `runFeed(visibleEvents())` with no `surface` argument.
// So every pin below is expected to FAIL against current production.
//
// RED-agent-defined contract notes (documented as ESCALATIONs in the RED
// hand-off report, not silently invented):
//   - the §S4c template `⚑ <CR-id> merged · <n> cycles · <branch>@<shortsha>`
//     names a `<branch>` field that DOES NOT EXIST anywhere in the §S4c POST
//     shape (`{type:"cr-merged", label, context:{cr,wave,track}, commit}` —
//     no branch key, and AC141 itself only pins `⚑ CR-NAI-042 merged · … abc1234`
//     with an explicit "…" gap for the untested middle). This file therefore
//     pins only what the data model actually supports: the CR id, the
//     `commit`-derived shortcommit, and (via CR-CRU-011 plan linkage, which
//     the spec's own §S4c prose names as the intended join — "the marker
//     links plans.cr") the cycles count from a plan sharing the same `cr`.
//     No literal branch-name value is asserted.
//   - testids milestone-cr-badge / merge-marker-compact / gate-card-compact
//     (sibling file) are this RED agent's own naming (the spec pins
//     "milestone-entry" and "merge-marker" only) — GREEN should match them.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"),
  "utf8",
);
const VAN_X_SRC = readFileSync(
  path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"),
  "utf8",
);
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

interface MilestoneEventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "milestone";
  type: string;
  label?: string;
  commit?: string;
  timestamp: number;
  context?: { cr?: string; wave?: string | number; track?: string };
}

interface CycleFixture {
  id: number;
  label: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

interface PlanFixture {
  planId: number | string;
  projectKey?: string;
  cr: string;
  status: "open" | "closed";
  cycles: CycleFixture[];
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: MilestoneEventFixture[];
  plans?: PlanFixture[];
}

let cacheBust = 0;

function project(overrides: Partial<ProjectFixture> & { key: string }): ProjectFixture {
  const now = Date.now();
  return {
    name: overrides.key,
    type: "backend",
    agentsOnline: 0,
    agentsTotal: 0,
    active: true,
    lastActivity: now,
    ...overrides,
  };
}

function milestoneEvent(
  overrides: Partial<MilestoneEventFixture> & {
    id: string;
    projectKey: string;
    type: string;
    timestamp: number;
  },
): MilestoneEventFixture {
  return {
    agentId: "orchestrator-1",
    kind: "milestone",
    ...overrides,
  };
}

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  const plans = opts.plans ?? [];

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const scopedPlanMatch = /\/api\/v2\/projects\/([^/?]+)\/plans(?:\?|$)/.exec(url);
    if (scopedPlanMatch !== null) {
      body = { ok: true, plans };
    } else if (/\/api\/v2\/plans(?:\?|$)/.test(url)) {
      body = { ok: true, plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`milestone-merge-rows.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?milestoneMergeRows=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

async function openRunsTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Runs");
  if (tab === undefined) throw new Error('"Runs" workspace-tab not found');
  tab.click();
  await settle();
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ── §S4b — milestone-entry (workspace, slim row) ────────────────────────────

describe("§S4b milestone-entry — slim workspace row (◇ glyph + type + label + CR badge + relative time)", () => {
  test("a gap-analysis milestone with context.cr renders one milestone-entry: ◇ glyph, type, label, a CR badge, and a relative-time string", async () => {
    const key = "milestone-entry-1";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Milestone Entry" })],
      events: [
        milestoneEvent({
          id: "evt-milestone-1",
          projectKey: key,
          type: "gap-analysis",
          label: "CR-NAI-043 gap-analysis",
          timestamp: now - 5_000,
          context: { cr: "CR-NAI-043", wave: "2" },
        }),
      ],
    });
    await openRunsTab();

    const entries = document.querySelectorAll<HTMLElement>('[data-testid="milestone-entry"]');
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    const text = textOf(entry);

    expect(text).toContain("◇");
    expect(text).toContain("gap-analysis");
    expect(text).toContain("CR-NAI-043 gap-analysis");
    expect(text).toMatch(/ago|just now/);

    const crBadge = entry.querySelector<HTMLElement>('[data-testid="milestone-cr-badge"]');
    expect(crBadge).not.toBeNull();
    expect(textOf(crBadge)).toContain("CR-NAI-043");
  });

  test("a milestone with NO context.cr renders milestone-entry but no CR badge", async () => {
    const key = "milestone-entry-no-cr";
    const now = Date.now();

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Milestone No CR" })],
      events: [
        milestoneEvent({
          id: "evt-milestone-no-cr",
          projectKey: key,
          type: "stage-flip",
          label: "wave 3 → wave 4",
          timestamp: now,
        }),
      ],
    });
    await openRunsTab();

    const entries = document.querySelectorAll<HTMLElement>('[data-testid="milestone-entry"]');
    expect(entries.length).toBe(1);
    expect(entries[0]!.querySelector('[data-testid="milestone-cr-badge"]')).toBeNull();
  });
});

// ── §S4b — home/workspace scoping: milestones are WORKSPACE-ONLY ───────────

describe("§S4b home/workspace scoping — milestones render on workspace only; home shows zero", () => {
  test("the SAME milestone fixture renders 1 milestone-entry on the workspace Runs tab and 0 on home", async () => {
    const key = "milestone-scoping-1";
    const now = Date.now();
    const events = [
      milestoneEvent({
        id: "evt-milestone-scoped",
        projectKey: key,
        type: "design-review",
        label: "F8 design review",
        timestamp: now,
        context: { cr: "CR-NAI-050" },
      }),
    ];
    const projects = [project({ key, name: "Milestone Scoping" })];

    await mountApp({ pathname: `/p/${key}`, projects, events });
    await openRunsTab();
    expect(document.querySelectorAll('[data-testid="milestone-entry"]').length).toBe(1);

    await mountApp({ pathname: "/", projects, events });
    expect(document.querySelectorAll('[data-testid="milestone-entry"]').length).toBe(0);
  });
});

// ── §S4c — ⚑ merge-marker (workspace full break row) ────────────────────────

describe("§S4c merge-marker — full-width break row (same structural weight as the RED→GREEN transition marker)", () => {
  test("a cr-merged milestone renders one full-width merge-marker whose text starts with '⚑ CR-NAI-042 merged', contains the 7-char shortcommit, and never leaks the full commit sha", async () => {
    const key = "merge-marker-1";
    const now = Date.now();
    const fullCommit = "abc1234567890def";

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Merge Marker" })],
      events: [
        milestoneEvent({
          id: "evt-merge-1",
          projectKey: key,
          type: "cr-merged",
          label: "CR-NAI-042",
          commit: fullCommit,
          timestamp: now,
          context: { cr: "CR-NAI-042", wave: 1 },
        }),
      ],
    });
    await openRunsTab();

    const markers = document.querySelectorAll<HTMLElement>('[data-testid="merge-marker"]');
    expect(markers.length).toBe(1);
    const marker = markers[0]!;
    const text = textOf(marker);

    // Same structural weight as the RED→GREEN transition marker.
    expect(marker.className).toContain("app-transition-marker");
    expect(text).toMatch(/^⚑ CR-NAI-042 merged/);
    expect(text).toContain("abc1234");
    expect(text).not.toContain(fullCommit);
  });

  test("with a plan sharing the same cr (CR-CRU-011 plans.cr linkage), the marker's cycles count reflects that plan's cycles.length", async () => {
    const key = "merge-marker-cycles";
    const now = Date.now();
    const plan: PlanFixture = {
      planId: 1,
      projectKey: key,
      cr: "CR-NAI-042",
      status: "closed",
      cycles: [
        { id: 1, label: "c1", status: "done" },
        { id: 2, label: "c2", status: "done" },
        { id: 3, label: "c3", status: "done" },
      ],
    };

    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Merge Marker Cycles" })],
      events: [
        milestoneEvent({
          id: "evt-merge-cycles-1",
          projectKey: key,
          type: "cr-merged",
          label: "CR-NAI-042",
          commit: "abc1234",
          timestamp: now,
          context: { cr: "CR-NAI-042", wave: 1 },
        }),
      ],
      plans: [plan],
    });
    await openRunsTab();

    const marker = document.querySelector<HTMLElement>('[data-testid="merge-marker"]');
    expect(marker).not.toBeNull();
    expect(textOf(marker)).toContain("3 cycles");
  });
});

// ── §S4c — home/workspace scoping: full on workspace, compact on home ──────

describe("home vs workspace — cr-merged markers render COMPACT on home, full on workspace", () => {
  test("the SAME cr-merged fixture renders full merge-marker on workspace and a distinct compact merge-marker-compact (no full merge-marker) on home", async () => {
    const key = "merge-home-compact";
    const now = Date.now();
    const events = [
      milestoneEvent({
        id: "evt-merge-home-1",
        projectKey: key,
        type: "cr-merged",
        label: "CR-NAI-042",
        commit: "abc1234",
        timestamp: now,
        context: { cr: "CR-NAI-042", wave: 1 },
      }),
    ];
    const projects = [project({ key, name: "Merge Home Compact" })];

    await mountApp({ pathname: `/p/${key}`, projects, events });
    await openRunsTab();
    expect(document.querySelectorAll('[data-testid="merge-marker"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="merge-marker-compact"]').length).toBe(0);

    await mountApp({ pathname: "/", projects, events });
    expect(document.querySelectorAll('[data-testid="merge-marker"]').length).toBe(0);
    const compact = document.querySelectorAll<HTMLElement>('[data-testid="merge-marker-compact"]');
    expect(compact.length).toBe(1);
    expect(textOf(compact[0]!)).toContain("CR-NAI-042");
    expect(textOf(compact[0]!)).toContain("abc1234");
  });
});
