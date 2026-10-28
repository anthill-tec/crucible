// The active cycle's line (`open-span` → `linked-run-row`) and the Runs tab's
// collapsed cue (`accordion-collapsed-cue`) count only TEST runs — a cycle's
// milestones, gates and compile results are never drawn or counted as runs,
// and an aborted run's chip says `aborted` instead of a ratio it never had.
//
// The rule lives inside public/app.js's closure (`linkedRunsFor`, feeding
// `OpenSpan` → `InlineRunEntry` and the declared marker's cue), so it is pinned
// here through the real SPA mounted under happy-dom, the mount pattern
// tests/f13-fidelity.test.ts and tests/run-timeline-accordion.test.ts use.
// The fixtures are the event BRIEFS the board's events read serves
// (`eventBrief`, src/v2.ts): every brief carries numeric run counts, 0 for an
// event that is not a test run, which is exactly what drew `0/0` chips.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";
import { singleReleaseHistoryStub } from "./helpers/history-stub";

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

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

interface PlanFixture {
  planId: number;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  cycles: CycleFixture[];
}

/** One event brief as the events read serves it. */
interface BriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile" | "milestone" | "gate";
  tier: string;
  timestamp: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
  hasCoverage: boolean;
  context?: { cycleId?: number };
  status?: string;
  errors?: number;
  warnings?: number;
  type?: string;
  label?: string;
}

interface OpenRunFixture {
  runId: string;
  projectKey: string;
  agentId: string;
  startedAt: number;
  tier: string;
  context?: { cycleId?: number };
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active: boolean;
  lastActivity: number;
}

interface MountOpts {
  key: string;
  events: BriefFixture[];
  openRuns?: OpenRunFixture[];
  plans: PlanFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${opts.key}` });
  document.body.innerHTML = '<div id="app"></div>';
  const projects: ProjectFixture[] = [
    {
      key: opts.key,
      name: opts.key,
      type: "backend",
      agentsOnline: 0,
      agentsTotal: 0,
      active: true,
      lastActivity: Date.now(),
    },
  ];

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/history/.test(url)) {
      body = singleReleaseHistoryStub(opts.plans);
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events, openRuns: opts.openRuns ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`active-cycle-line-counts-only-test-runs mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?activeCycleLine=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settleDom({ ticks: 8 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

function brief(
  overrides: Partial<BriefFixture> & Pick<BriefFixture, "id" | "projectKey" | "agentId" | "kind" | "timestamp">,
): BriefFixture {
  return {
    tier: "unit",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    duration_ms: 0,
    hasCoverage: false,
    ...overrides,
  };
}

async function clickTab(name: string): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === name);
  expect(tab).toBeDefined();
  tab!.click();
  await settleDom({ ticks: 8 });
}

function activeCycleRow(cycleId: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-testid="workflow-active"] [data-testid="cycle-row"][data-cycle-id="${cycleId}"]`,
  );
  expect(row).not.toBeNull();
  expect(row!.getAttribute("data-status")).toBe("active");
  return row!;
}

function chipIds(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-testid="linked-run-row"]')).map(
    (el) => el.getAttribute("data-run-id") ?? "",
  );
}

/** A test run, a pre-merge-gate milestone, a gate and a compile result, all on one cycle. */
function mixedCycleEvents(key: string, cycleId: number, now: number): BriefFixture[] {
  return [
    brief({
      id: "evt-line-test",
      projectKey: key,
      agentId: "line-green",
      kind: "test",
      timestamp: now,
      total: 5,
      passed: 5,
      duration_ms: 60,
      context: { cycleId },
    }),
    brief({
      id: "evt-line-milestone",
      projectKey: key,
      agentId: "line-orch",
      kind: "milestone",
      type: "pre-merge-gate",
      label: "CR-LINE-UNIT",
      timestamp: now + 10,
      context: { cycleId },
    }),
    brief({
      id: "evt-line-gate",
      projectKey: key,
      agentId: "line-orch",
      kind: "gate",
      timestamp: now + 20,
      context: { cycleId },
    }),
    brief({
      id: "evt-line-compile",
      projectKey: key,
      agentId: "line-green",
      kind: "compile",
      tier: "unit",
      errors: 1,
      warnings: 1,
      timestamp: now + 30,
      context: { cycleId },
    }),
  ];
}

describe("the active cycle's line draws only test runs", () => {
  test("a cycle holding a test run, a milestone, a gate and a compile result draws exactly one chip — the test run's, reading 5/5", async () => {
    const key = "line-unit-mixed";
    const cycleId = 7101;
    await mountApp({
      key,
      events: mixedCycleEvents(key, cycleId, Date.now()),
      plans: [
        {
          planId: 71,
          cr: "CR-LINE-UNIT",
          projectKey: key,
          status: "open",
          wave: "1",
          cycles: [{ id: cycleId, label: "line mixed", status: "active" }],
        },
      ],
    });
    await clickTab("Workflow");

    const span = activeCycleRow(cycleId).querySelector<HTMLElement>('[data-testid="open-span"]');
    expect(span).not.toBeNull();
    expect(chipIds(span!)).toEqual(["evt-line-test"]);
    const chip = span!.querySelector<HTMLElement>('[data-testid="linked-run-row"]')!;
    expect(norm(chip.textContent)).toBe("line-green 5/5");
    expect(norm(span!.textContent)).toBe("line-green 5/5 · awaiting orchestrator confirm");
    // Nowhere on the page is a non-run drawn as a run chip.
    const everyChip = chipIds(document);
    expect(everyChip).not.toContain("evt-line-milestone");
    expect(everyChip).not.toContain("evt-line-gate");
    expect(everyChip).not.toContain("evt-line-compile");
  });

  test("a cycle whose only linked events are a milestone, a gate and a compile result draws no open span", async () => {
    const key = "line-unit-nonruns";
    const cycleId = 7102;
    const events = mixedCycleEvents(key, cycleId, Date.now()).filter((e) => e.kind !== "test");
    expect(events.map((e) => e.kind)).toEqual(["milestone", "gate", "compile"]);
    await mountApp({
      key,
      events,
      plans: [
        {
          planId: 72,
          cr: "CR-LINE-UNIT-2",
          projectKey: key,
          status: "open",
          wave: "1",
          cycles: [{ id: cycleId, label: "line non-runs", status: "active" }],
        },
      ],
    });
    await clickTab("Workflow");

    const row = activeCycleRow(cycleId);
    expect(row.querySelectorAll('[data-testid="open-span"]').length).toBe(0);
    expect(row.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);
    expect(norm(row.textContent)).not.toContain("0/0");
    expect(norm(row.textContent)).not.toContain("awaiting orchestrator confirm");
  });

  test("a running run beside a milestone shows only its running entry", async () => {
    const key = "line-unit-running";
    const cycleId = 7103;
    const now = Date.now();
    await mountApp({
      key,
      events: [
        brief({
          id: "evt-line-running-milestone",
          projectKey: key,
          agentId: "line-orch",
          kind: "milestone",
          type: "pre-merge-gate",
          timestamp: now - 1_000,
          context: { cycleId },
        }),
      ],
      openRuns: [
        {
          runId: "run-line-running",
          projectKey: key,
          agentId: "line-runner",
          startedAt: now - 500,
          tier: "unit",
          context: { cycleId },
        },
      ],
      plans: [
        {
          planId: 73,
          cr: "CR-LINE-UNIT-3",
          projectKey: key,
          status: "open",
          wave: "1",
          cycles: [{ id: cycleId, label: "line running", status: "active" }],
        },
      ],
    });
    await clickTab("Workflow");

    const span = activeCycleRow(cycleId).querySelector<HTMLElement>('[data-testid="open-span"]');
    expect(span).not.toBeNull();
    const running = span!.querySelectorAll<HTMLElement>('[data-testid="open-span-running-entry"]');
    expect(running.length).toBe(1);
    expect(running[0]!.getAttribute("data-run-id")).toBe("run-line-running");
    expect(chipIds(span!)).toEqual([]);
    expect(norm(span!.textContent)).not.toContain("0/0");
  });

  test("an aborted run's chip reads '<agent> aborted' with no ratio", async () => {
    const key = "line-unit-aborted";
    const cycleId = 7104;
    await mountApp({
      key,
      events: [
        brief({
          id: "evt-line-aborted",
          projectKey: key,
          agentId: "line-aborter",
          kind: "test",
          status: "aborted",
          timestamp: Date.now(),
          context: { cycleId },
        }),
      ],
      plans: [
        {
          planId: 74,
          cr: "CR-LINE-UNIT-4",
          projectKey: key,
          status: "open",
          wave: "1",
          cycles: [{ id: cycleId, label: "line aborted", status: "active" }],
        },
      ],
    });
    await clickTab("Workflow");

    const span = activeCycleRow(cycleId).querySelector<HTMLElement>('[data-testid="open-span"]');
    expect(span).not.toBeNull();
    // An aborted run is still a run: it keeps its chip.
    expect(chipIds(span!)).toEqual(["evt-line-aborted"]);
    const chip = span!.querySelector<HTMLElement>('[data-testid="linked-run-row"]')!;
    expect(norm(chip.textContent)).toBe("line-aborter aborted");
    expect(chip.textContent ?? "").not.toContain("/");
  });
});

describe("the Runs tab's collapsed cue counts only test runs", () => {
  test("collapsing a done cycle's declared marker that holds one test run, a milestone, a gate and a compile result reads '▸ 1 runs'", async () => {
    const key = "line-unit-cue";
    const cycleId = 7105;
    await mountApp({
      key,
      events: mixedCycleEvents(key, cycleId, Date.now()),
      plans: [
        {
          planId: 75,
          cr: "CR-LINE-UNIT-5",
          projectKey: key,
          status: "open",
          wave: "1",
          cycles: [{ id: cycleId, label: "line cue", status: "done" }],
        },
      ],
    });
    await clickTab("Runs");

    const markerSelector = `[data-testid="declared-marker"][data-cycle-id="${cycleId}"]`;
    const marker = document.querySelector<HTMLElement>(markerSelector);
    expect(marker).not.toBeNull();
    marker!.click();
    await settleDom({ ticks: 8 });

    // The collapse re-renders the marker, so it is read afresh.
    const collapsed = document.querySelector<HTMLElement>(markerSelector);
    expect(collapsed).not.toBeNull();
    const cue = collapsed!.querySelector<HTMLElement>('[data-testid="accordion-collapsed-cue"]');
    expect(cue).not.toBeNull();
    expect(cue!.textContent).toBe("▸ 1 runs");
  });
});
