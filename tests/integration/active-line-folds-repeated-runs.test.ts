// The active cycle's line (`open-span` → `linked-run-row`) folds consecutive
// repeated settled runs into ONE chip: `<agent> <passed>/<total> ×<n> <time>`
// (or `<agent> aborted ×<n> <time>`), the chip being the LATEST run of the
// sequence — its run id, its click — with the count on `data-run-count`.
// `<time>` is the board's clock formatter's answer for the latest run against
// the render-time `Date.now()`: UTC `HH:MM` on the same UTC day, else
// `YYYY-MM-DD HH:MM`. A run that repeats nothing renders exactly as before
// (no `×`, no time, no `data-run-count`), running entries are never folded,
// and the line never carries an "ago" stamp.
//
// The line lives inside public/app.js's closure (`OpenSpan` → `InlineRunEntry`
// / `InlineRunningEntry`), and reaches the fold (`foldRepeatedRuns`,
// public/app-logic.mjs) through the `window.CrucibleLogic` bridge, so it is
// pinned here through the real SPA mounted under happy-dom with a stubbed
// fetch — the mount pattern tests/integration/active-cycle-line-counts-only-test-runs.test.ts
// uses. The wall clock is pinned with bun's `setSystemTime` and reset after
// every test. Expected clock strings are written out literally from the
// fixtures' `Date.UTC(...)` timestamps, never derived from the formatter.
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "../helpers/dom-settle";
import { singleReleaseHistoryStub } from "../helpers/history-stub";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
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

/** The pinned wall clock: 2026-11-27 15:30:00 UTC. */
const PINNED_NOW = Date.UTC(2026, 10, 27, 15, 30, 0);

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
  kind: "test";
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
/** Every run id whose detail the app read during the current test. */
let detailReads: string[] = [];

async function mountApp(opts: MountOpts): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${opts.key}` });
  document.body.innerHTML = '<div id="app"></div>';
  detailReads = [];
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
    const detailMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    if (/\/api\/v2\/projects\/[^/]+\/history/.test(url)) {
      body = singleReleaseHistoryStub(opts.plans);
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (detailMatch !== null) {
      const id = decodeURIComponent(detailMatch[1]!);
      detailReads.push(id);
      const run = opts.events.find((e) => e.id === id);
      if (run === undefined) {
        throw new Error(`active-line-folds-repeated-runs mountApp: no run fixture for detail id ${id}`);
      }
      body = {
        ok: true,
        event: {
          id: run.id,
          projectKey: run.projectKey,
          agentId: run.agentId,
          kind: run.kind,
          tier: run.tier,
          codec: "junit",
          timestamp: run.timestamp,
          ...(run.status !== undefined ? { status: run.status } : {}),
          summary: {
            total: run.total,
            passed: run.passed,
            failed: run.failed,
            pending: run.pending,
            duration_ms: run.duration_ms,
          },
          tree: [],
        },
      };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events, openRuns: opts.openRuns ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`active-line-folds-repeated-runs mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?activeLineFolds=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settleDom({ ticks: 8 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  setSystemTime();
});

const norm = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();

/** A settled test run: 14 passed of 14 unless overridden. */
function run(
  overrides: Partial<BriefFixture> & Pick<BriefFixture, "id" | "projectKey" | "agentId" | "timestamp">,
): BriefFixture {
  return {
    kind: "test",
    tier: "unit",
    total: 14,
    passed: 14,
    failed: 0,
    pending: 0,
    duration_ms: 40,
    hasCoverage: false,
    ...overrides,
  };
}

function activePlan(key: string, planId: number, cycleId: number): PlanFixture {
  return {
    planId,
    cr: `CR-FOLD-${planId}`,
    projectKey: key,
    status: "open",
    wave: "1",
    cycles: [{ id: cycleId, label: "fold line", status: "active" }],
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

/** The ACTIVE cycle's open span (the inline line), asserted present. */
function activeLine(cycleId: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-testid="workflow-active"] [data-testid="cycle-row"][data-cycle-id="${cycleId}"]`,
  );
  expect(row).not.toBeNull();
  expect(row!.getAttribute("data-status")).toBe("active");
  const span = row!.querySelector<HTMLElement>('[data-testid="open-span"]');
  expect(span).not.toBeNull();
  return span!;
}

function chips(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-testid="linked-run-row"]'));
}

function chipIds(root: ParentNode): string[] {
  return chips(root).map((el) => el.getAttribute("data-run-id") ?? "");
}

function expectNoVerdictColour(chip: HTMLElement): void {
  for (const verdict of ["app-ratio-pass", "app-ratio-fail"]) {
    expect(chip.classList.contains(verdict)).toBe(false);
    expect(chip.querySelector(`.${verdict}`)).toBeNull();
  }
}

describe("the active cycle's line folds back-to-back repeated runs into one chip", () => {
  test("three equal passing runs by one agent on the pinned day render one chip reading '<agent> 14/14 ×3 HH:MM' carrying the latest run's id and a run count of 3", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-three-same-day";
    const cycleId = 9201;
    const events = [
      run({ id: "evt-fold-a1", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 27, 14, 5, 0), context: { cycleId } }),
      run({ id: "evt-fold-a2", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 27, 14, 20, 0), context: { cycleId } }),
      run({ id: "evt-fold-a3", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 27, 14, 47, 0), context: { cycleId } }),
    ];
    await mountApp({ key, events, plans: [activePlan(key, 921, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    expect(chipIds(line)).toEqual(["evt-fold-a3"]);
    const chip = chips(line)[0]!;
    expect(norm(chip.textContent)).toBe("fold-verify 14/14 ×3 14:47");
    expect(chip.getAttribute("data-run-count")).toBe("3");
    expect(norm(line.textContent)).toBe("fold-verify 14/14 ×3 14:47 · awaiting orchestrator confirm");
    // A clock time is not an age: the line carries no "ago" stamp.
    expect(norm(line.textContent)).not.toContain("ago");
    // The folded chip keeps the latest run's verdict colour.
    expect(chip.querySelector(".app-ratio-pass")).not.toBeNull();
    expect(chip.querySelector(".app-ratio-fail")).toBeNull();
  });

  test("clicking a folded chip opens the latest run's detail, never an earlier run's", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-three-click";
    const cycleId = 9202;
    const events = [
      run({ id: "evt-fold-c1", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 27, 14, 5, 0), context: { cycleId } }),
      run({ id: "evt-fold-c2", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 27, 14, 20, 0), context: { cycleId } }),
      run({ id: "evt-fold-c3", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 27, 14, 47, 0), context: { cycleId } }),
    ];
    await mountApp({ key, events, plans: [activePlan(key, 922, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    const folded = chips(line);
    expect(folded.length).toBe(1);
    expect(folded[0]!.getAttribute("data-run-count")).toBe("3");
    folded[0]!.click();
    await settleDom({ ticks: 8 });

    expect(location.pathname).toBe(`/p/${key}/run/evt-fold-c3`);
    expect(document.querySelector('[data-testid="run-overlay"]')).not.toBeNull();
    expect(detailReads).toContain("evt-fold-c3");
    expect(detailReads).not.toContain("evt-fold-c1");
    expect(detailReads).not.toContain("evt-fold-c2");
  });

  test("a folded chip whose latest run is from an earlier UTC day than the clock reads its time as 'YYYY-MM-DD HH:MM'", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-three-other-day";
    const cycleId = 9203;
    const events = [
      run({ id: "evt-fold-d1", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 25, 9, 3, 0), context: { cycleId } }),
      run({ id: "evt-fold-d2", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 25, 9, 10, 0), context: { cycleId } }),
      run({ id: "evt-fold-d3", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 25, 9, 12, 0), context: { cycleId } }),
    ];
    await mountApp({ key, events, plans: [activePlan(key, 923, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    expect(chipIds(line)).toEqual(["evt-fold-d3"]);
    const chip = chips(line)[0]!;
    expect(norm(chip.textContent)).toBe("fold-verify 14/14 ×3 2026-11-25 09:12");
    expect(chip.getAttribute("data-run-count")).toBe("3");
    expect(norm(line.textContent)).not.toContain("ago");
  });

  test("two equal settled runs followed by a running run render one ×2 chip and then the running entry, unfolded, after it", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-then-running";
    const cycleId = 9204;
    const events = [
      run({ id: "evt-fold-r1", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 27, 15, 0, 0), context: { cycleId } }),
      run({ id: "evt-fold-r2", projectKey: key, agentId: "fold-verify", timestamp: Date.UTC(2026, 10, 27, 15, 9, 0), context: { cycleId } }),
    ];
    const openRuns: OpenRunFixture[] = [
      {
        runId: "run-fold-live",
        projectKey: key,
        agentId: "fold-verify",
        startedAt: Date.UTC(2026, 10, 27, 15, 29, 0),
        tier: "unit",
        context: { cycleId },
      },
    ];
    await mountApp({ key, events, openRuns, plans: [activePlan(key, 924, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    expect(chipIds(line)).toEqual(["evt-fold-r2"]);
    const chip = chips(line)[0]!;
    expect(norm(chip.textContent)).toBe("fold-verify 14/14 ×2 15:09");
    expect(chip.getAttribute("data-run-count")).toBe("2");

    const running = Array.from(
      line.querySelectorAll<HTMLElement>('[data-testid="open-span-running-entry"]'),
    );
    expect(running.length).toBe(1);
    expect(running[0]!.getAttribute("data-run-id")).toBe("run-fold-live");
    // The running entry is never folded: no count, no ×.
    expect(running[0]!.hasAttribute("data-run-count")).toBe(false);
    expect(running[0]!.textContent ?? "").not.toContain("×");
    // It comes after the folded chip in document order.
    expect(chip.compareDocumentPosition(running[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(norm(line.textContent)).not.toContain("ago");
  });

  test("two back-to-back aborted runs by one agent with different figures render one uncoloured chip reading '<agent> aborted ×2 HH:MM'", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-aborted";
    const cycleId = 9205;
    const events = [
      run({ id: "evt-fold-x1", projectKey: key, agentId: "fold-aborter", status: "aborted", total: 0, passed: 0, failed: 0, timestamp: Date.UTC(2026, 10, 27, 13, 2, 0), context: { cycleId } }),
      run({ id: "evt-fold-x2", projectKey: key, agentId: "fold-aborter", status: "aborted", total: 9, passed: 7, failed: 2, timestamp: Date.UTC(2026, 10, 27, 13, 41, 0), context: { cycleId } }),
    ];
    await mountApp({ key, events, plans: [activePlan(key, 925, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    expect(chipIds(line)).toEqual(["evt-fold-x2"]);
    const chip = chips(line)[0]!;
    expect(norm(chip.textContent)).toBe("fold-aborter aborted ×2 13:41");
    expect(chip.getAttribute("data-run-count")).toBe("2");
    expect(chip.textContent ?? "").not.toContain("/");
    // `aborted` is uncoloured exactly as an aborted chip is today: it sits in
    // the meta class, and no verdict colour appears on or inside the chip.
    const meta = Array.from(chip.querySelectorAll<HTMLElement>(".app-card-meta")).filter((el) =>
      norm(el.textContent).startsWith("aborted"),
    );
    expect(meta.length).toBe(1);
    expectNoVerdictColour(chip);
    expect(norm(line.textContent)).not.toContain("ago");
  });
});

describe("the active cycle's line leaves runs that repeat nothing as they are", () => {
  test("a single run renders as '<agent> 14/14' with no ×, no clock time and no data-run-count attribute", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-single";
    const cycleId = 9206;
    const events = [
      run({ id: "evt-fold-s1", projectKey: key, agentId: "fold-solo", timestamp: Date.UTC(2026, 10, 27, 14, 47, 0), context: { cycleId } }),
    ];
    await mountApp({ key, events, plans: [activePlan(key, 926, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    expect(chipIds(line)).toEqual(["evt-fold-s1"]);
    const chip = chips(line)[0]!;
    expect(norm(chip.textContent)).toBe("fold-solo 14/14");
    expect(chip.hasAttribute("data-run-count")).toBe(false);
    expect(chip.textContent ?? "").not.toContain("×");
    expect(chip.textContent ?? "").not.toContain("14:47");
    expect(norm(line.textContent)).toBe("fold-solo 14/14 · awaiting orchestrator confirm");
  });

  test("a mixed line folds only the back-to-back repeat: 'A 14/14 ×2 HH:MM · B 14/14', in chronological order, the lone chip carrying no count", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-mixed";
    const cycleId = 9207;
    const events = [
      run({ id: "evt-fold-m1", projectKey: key, agentId: "fold-alpha", timestamp: Date.UTC(2026, 10, 27, 10, 0, 0), context: { cycleId } }),
      run({ id: "evt-fold-m2", projectKey: key, agentId: "fold-alpha", timestamp: Date.UTC(2026, 10, 27, 10, 15, 0), context: { cycleId } }),
      run({ id: "evt-fold-m3", projectKey: key, agentId: "fold-beta", timestamp: Date.UTC(2026, 10, 27, 10, 30, 0), context: { cycleId } }),
    ];
    // Served out of time order: the line still reads chronologically.
    await mountApp({ key, events: [events[2]!, events[0]!, events[1]!], plans: [activePlan(key, 927, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    expect(chipIds(line)).toEqual(["evt-fold-m2", "evt-fold-m3"]);
    const [folded, lone] = chips(line) as [HTMLElement, HTMLElement];
    expect(norm(folded.textContent)).toBe("fold-alpha 14/14 ×2 10:15");
    expect(folded.getAttribute("data-run-count")).toBe("2");
    expect(norm(lone.textContent)).toBe("fold-beta 14/14");
    expect(lone.hasAttribute("data-run-count")).toBe(false);
    expect(lone.textContent ?? "").not.toContain("×");
    expect(lone.textContent ?? "").not.toContain("10:30");
    expect(norm(line.textContent)).toBe(
      "fold-alpha 14/14 ×2 10:15 · fold-beta 14/14 · awaiting orchestrator confirm",
    );
    expect(norm(line.textContent)).not.toContain("ago");
  });

  test("an aborted run followed by a finished run by the same agent with equal figures stays two chips, neither counted", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-aborted-then-finished";
    const cycleId = 9208;
    const events = [
      run({ id: "evt-fold-af1", projectKey: key, agentId: "fold-mixer", status: "aborted", timestamp: Date.UTC(2026, 10, 27, 11, 0, 0), context: { cycleId } }),
      run({ id: "evt-fold-af2", projectKey: key, agentId: "fold-mixer", timestamp: Date.UTC(2026, 10, 27, 11, 20, 0), context: { cycleId } }),
    ];
    await mountApp({ key, events, plans: [activePlan(key, 928, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    expect(chipIds(line)).toEqual(["evt-fold-af1", "evt-fold-af2"]);
    const [aborted, finished] = chips(line) as [HTMLElement, HTMLElement];
    expect(norm(aborted.textContent)).toBe("fold-mixer aborted");
    expect(norm(finished.textContent)).toBe("fold-mixer 14/14");
    expect(aborted.hasAttribute("data-run-count")).toBe(false);
    expect(finished.hasAttribute("data-run-count")).toBe(false);
    expect(norm(line.textContent)).toBe(
      "fold-mixer aborted · fold-mixer 14/14 · awaiting orchestrator confirm",
    );
  });

  test("a finished 0/0 run followed by an aborted 0/0 run by the same agent stays two chips, neither counted", async () => {
    setSystemTime(PINNED_NOW);
    const key = "fold-finished-then-aborted";
    const cycleId = 9209;
    const events = [
      run({ id: "evt-fold-fa1", projectKey: key, agentId: "fold-mixer", total: 0, passed: 0, failed: 0, timestamp: Date.UTC(2026, 10, 27, 12, 0, 0), context: { cycleId } }),
      run({ id: "evt-fold-fa2", projectKey: key, agentId: "fold-mixer", status: "aborted", total: 0, passed: 0, failed: 0, timestamp: Date.UTC(2026, 10, 27, 12, 20, 0), context: { cycleId } }),
    ];
    await mountApp({ key, events, plans: [activePlan(key, 929, cycleId)] });
    await clickTab("Workflow");

    const line = activeLine(cycleId);
    expect(chipIds(line)).toEqual(["evt-fold-fa1", "evt-fold-fa2"]);
    const [finished, aborted] = chips(line) as [HTMLElement, HTMLElement];
    expect(norm(finished.textContent)).toBe("fold-mixer 0/0");
    expect(norm(aborted.textContent)).toBe("fold-mixer aborted");
    expect(finished.hasAttribute("data-run-count")).toBe(false);
    expect(aborted.hasAttribute("data-run-count")).toBe(false);
    expect(norm(line.textContent)).toBe(
      "fold-mixer 0/0 · fold-mixer aborted · awaiting orchestrator confirm",
    );
  });
});
