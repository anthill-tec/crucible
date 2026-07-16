// CR-CRU-021 §S1 — Workflow becomes the primary workspace tab: L.workspaceTabs
// order flips to Workflow-first (`Workflow · Runs · Coverage · Compile ·
// BDD`), and the workspace's default active tab on entry (badge click AND
// cold `/p/<key>` load) becomes "Workflow" instead of "Runs". The one-rule,
// tabs-hide, and back-chip naming stay order-agnostic; cold
// `/p/<key>/run/<id>` detail loads keep their existing "close lands on the
// pane that hosted the detail" behavior — now Workflow by default for
// tab-less cold loads.
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// same harness pattern as tests/inpane-drill-in.test.ts: real VanJS/VanX
// vendor bundles, real public/app-logic.mjs, real public/app.js; `fetch` is
// scripted.
//
// RED phase: expected to fail against the CURRENT code —
// public/app-logic.mjs:64 TAB_NAMES is ["Runs","Workflow",...] (Runs first);
// public/app.js:27/68 default `workspaceTab` to "Runs".
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceTabs } from "../public/app-logic.mjs";

interface TabShape {
  name: string;
  disabled: boolean;
  hint?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// AC1 (pure) — L.workspaceTabs returns names exactly
// ["Workflow","Runs","Coverage","Compile","BDD"] for both project types;
// existing enable/disable semantics untouched.
// ─────────────────────────────────────────────────────────────────────────

describe("§S1 AC1 — L.workspaceTabs order flips to Workflow-first (both project types)", () => {
  test("backend project: exact order [Workflow, Runs, Coverage, Compile, BDD]", () => {
    const tabs = workspaceTabs({ type: "backend" });
    expect(tabs.map((t: TabShape) => t.name)).toEqual([
      "Workflow",
      "Runs",
      "Coverage",
      "Compile",
      "BDD",
    ]);
  });

  test("frontend project: exact same order (Workflow-first is order-agnostic to project type)", () => {
    const tabs = workspaceTabs({ type: "frontend" });
    expect(tabs.map((t: TabShape) => t.name)).toEqual([
      "Workflow",
      "Runs",
      "Coverage",
      "Compile",
      "BDD",
    ]);
  });

  test("existing enable/disable semantics untouched: Workflow/Runs/Compile never gated, Coverage gates on latestCoverageEventId, BDD gates on project type", () => {
    const backendNoCoverage = workspaceTabs({ type: "backend" });
    expect(backendNoCoverage.find((t: TabShape) => t.name === "Workflow")?.disabled).toBe(false);
    expect(backendNoCoverage.find((t: TabShape) => t.name === "Runs")?.disabled).toBe(false);
    expect(backendNoCoverage.find((t: TabShape) => t.name === "Compile")?.disabled).toBe(false);
    expect(backendNoCoverage.find((t: TabShape) => t.name === "Coverage")?.disabled).toBe(true);
    expect(backendNoCoverage.find((t: TabShape) => t.name === "Coverage")?.hint).toBe(
      "coverage lands with the first green regression",
    );
    expect(backendNoCoverage.find((t: TabShape) => t.name === "BDD")?.disabled).toBe(true);

    const backendWithCoverage = workspaceTabs({
      type: "backend",
      latestCoverageEventId: "evt-cov-primary-1",
    });
    expect(backendWithCoverage.find((t: TabShape) => t.name === "Coverage")?.disabled).toBe(false);

    const frontendNoCoverage = workspaceTabs({ type: "frontend" });
    expect(frontendNoCoverage.find((t: TabShape) => t.name === "BDD")?.disabled).toBe(false);
    expect(frontendNoCoverage.find((t: TabShape) => t.name === "Coverage")?.disabled).toBe(true);

    // bound: Workflow carries no disabled/hint semantics of its own beyond
    // the plain {name, disabled: false} shape (unlike Coverage/BDD).
    expect(backendNoCoverage.find((t: TabShape) => t.name === "Workflow")).toEqual({
      name: "Workflow",
      disabled: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Rendering harness (same pattern as tests/inpane-drill-in.test.ts)
// ─────────────────────────────────────────────────────────────────────────

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

interface EventDetailFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  summary?: { total: number; passed: number; failed: number; pending: number; duration_ms: number };
  tree?: Array<{
    name: string;
    status: "pass" | "fail" | "pending";
    children: Array<{ name: string; status: "pass" | "fail" | "pending"; duration_ms: number }>;
  }>;
}

interface EventBriefFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
  latestGreenCoverage?: unknown;
  latestCoverageEventId?: string;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
  events?: EventBriefFixture[];
  eventDetails?: Record<string, EventDetailFixture>;
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

/** Same mountApp harness pattern as tests/inpane-drill-in.test.ts. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      const detail = opts.eventDetails?.[id];
      if (detail === undefined) {
        throw new Error(`workflow-primary-tab.test.ts mountApp: no eventDetails fixture for id ${id} (url ${url})`);
      }
      body = { ok: true, event: detail };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects ?? [] };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events ?? [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`workflow-primary-tab.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?workflowPrimaryTab=${cacheBust}`);

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

function findByText(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll(selector)).find((el) =>
    (el.textContent ?? "").trim() === text,
  ) as HTMLElement | undefined;
}

function tabButton(name: string): HTMLElement | undefined {
  return findByText(document, '[data-testid="workspace-tab"]', name);
}

function unitFixture(eventId: string, projectKey: string, now: number) {
  const detail: EventDetailFixture = {
    id: eventId,
    projectKey,
    agentId: "wf-primary-agent",
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    summary: { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 500 },
    tree: [
      {
        name: "SuiteOnly",
        status: "fail",
        children: [
          { name: "passLeaf", status: "pass", duration_ms: 5 },
          { name: "failLeaf", status: "fail", duration_ms: 6 },
        ],
      },
    ],
  };
  const brief: EventBriefFixture = {
    id: eventId,
    projectKey,
    agentId: "wf-primary-agent",
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    total: 2,
    passed: 1,
    failed: 1,
    pending: 0,
    duration_ms: 500,
    hasCoverage: false,
  };
  return { detail, brief };
}

// ─────────────────────────────────────────────────────────────────────────
// AC2 — Entering a workspace (badge click AND cold /p/<key> load) renders
// the Workflow pane active (Workflow tab `on`, `workflow-active` present);
// selecting Runs still works and the one-rule/tabs-hide behaviors are
// unchanged.
// ─────────────────────────────────────────────────────────────────────────

describe("§S1 AC2 — entering a workspace defaults to the Workflow pane", () => {
  test("badge click from home renders the Workflow pane active: Workflow tab 'on', workflow-active present, Runs pane absent", async () => {
    const key = "wf-primary-badge-1";
    await mountApp({
      pathname: "/",
      projects: [project({ key, name: "Badge Entry Project" })],
    });

    const badge = document.querySelector('[data-testid="project-badge"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    badge!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    const workflowTab = tabButton("Workflow");
    expect(workflowTab).toBeDefined();
    expect(workflowTab!.classList.contains("on")).toBe(true);
    const runsTab = tabButton("Runs");
    expect(runsTab).toBeDefined();
    expect(runsTab!.classList.contains("on")).toBe(false);

    expect(document.querySelector('[data-testid="workflow-active"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workspace-runs"]')).toBeNull();
  });

  test("cold /p/<key> load renders the Workflow pane active: Workflow tab 'on', workflow-active present, Runs pane absent", async () => {
    const key = "wf-primary-cold-1";
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Cold Load Project" })],
    });

    const workflowTab = tabButton("Workflow");
    expect(workflowTab).toBeDefined();
    expect(workflowTab!.classList.contains("on")).toBe(true);
    expect(document.querySelector('[data-testid="workflow-active"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workspace-runs"]')).toBeNull();
  });

  test("selecting Runs still works: clicking the Runs tab swaps the pane and marks Runs 'on', Workflow 'off'", async () => {
    const key = "wf-primary-select-runs-1";
    const now = Date.now();
    const fx = unitFixture("evt-wf-primary-select-1", key, now);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "Select Runs Project" })],
      events: [fx.brief],
    });

    const runsTab = tabButton("Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    await settle();

    expect(runsTab!.classList.contains("on")).toBe(true);
    const workflowTab = tabButton("Workflow");
    expect(workflowTab!.classList.contains("on")).toBe(false);
    expect(document.querySelector('[data-testid="workspace-runs"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workflow-active"]')).toBeNull();
  });

  test("ONE RULE unchanged under the new default: opening then closing an in-pane detail preserves the active tab (Runs stays selected, not reset to Workflow)", async () => {
    const key = "wf-primary-onerule-1";
    const now = Date.now();
    const fx = unitFixture("evt-wf-primary-onerule-1", key, now);
    await mountApp({
      pathname: `/p/${key}`,
      projects: [project({ key, name: "One Rule Project" })],
      events: [fx.brief],
      eventDetails: { [fx.detail.id]: fx.detail },
    });

    // Select Runs explicitly (the one-rule preserves WHICHEVER tab was
    // active, not always Workflow) — the SAME-SURFACE navigation from
    // opening/closing a detail must not force it back to the Workflow
    // default.
    const runsTab = tabButton("Runs")!;
    runsTab.click();
    await settle();
    expect(runsTab.classList.contains("on")).toBe(true);

    const card = document.querySelector('[data-testid="event-card"]') as HTMLElement;
    expect(card).not.toBeNull();
    card.click();
    await settle();
    expect(location.pathname).toBe(`/p/${key}/run/${fx.detail.id}`);

    // tabs-hide — the tabs row is parked while the detail is open.
    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    expect(document.querySelector('[data-testid="workspace-tabs-parked"]')).not.toBeNull();

    const backChip = findByText(document, "button, a", "← runs");
    expect(backChip).toBeDefined();
    backChip!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    expect(document.querySelector('[data-testid="workspace-tabs"]')).not.toBeNull();
    const runsTabAfter = tabButton("Runs")!;
    expect(runsTabAfter.classList.contains("on")).toBe(true);
    const workflowTabAfter = tabButton("Workflow")!;
    expect(workflowTabAfter.classList.contains("on")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC3 — Cold /p/<key>/run/<id>: the detail renders in-pane; closing it
// lands on the WORKFLOW pane with its tab `on` (the new default), chip
// text `← workflow`.
// ─────────────────────────────────────────────────────────────────────────

describe("§S1 AC3 — cold /p/<key>/run/<id> load closes back to the Workflow pane (the new default)", () => {
  test("cold-loading the run route renders the detail in-pane with tabs parked and chip '← workflow'", async () => {
    const key = "wf-primary-cold-run-1";
    const now = Date.now();
    const fx = unitFixture("evt-wf-primary-cold-run-1", key, now);
    await mountApp({
      pathname: `/p/${key}/run/${fx.detail.id}`,
      projects: [project({ key, name: "Cold Run Project" })],
      events: [fx.brief],
      eventDetails: { [fx.detail.id]: fx.detail },
    });

    expect(document.querySelector('[data-testid="workspace-tabs"]')).toBeNull();
    const backChip = findByText(document, "button, a", "← workflow");
    expect(backChip).toBeDefined();
    expect((backChip!.textContent ?? "").trim()).toBe("← workflow");
  });

  test("closing the cold-loaded run detail lands on the WORKFLOW pane: Workflow tab 'on', workflow-active present, Runs pane absent", async () => {
    const key = "wf-primary-cold-run-2";
    const now = Date.now();
    const fx = unitFixture("evt-wf-primary-cold-run-2", key, now);
    await mountApp({
      pathname: `/p/${key}/run/${fx.detail.id}`,
      projects: [project({ key, name: "Cold Run Close Project" })],
      events: [fx.brief],
      eventDetails: { [fx.detail.id]: fx.detail },
    });

    const backChip = findByText(document, "button, a", "← workflow");
    expect(backChip).toBeDefined();
    backChip!.click();
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    expect(document.querySelector('[data-testid="workspace-tabs"]')).not.toBeNull();
    const workflowTab = tabButton("Workflow");
    expect(workflowTab).toBeDefined();
    expect(workflowTab!.classList.contains("on")).toBe(true);
    expect(document.querySelector('[data-testid="workflow-active"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workspace-runs"]')).toBeNull();
  });

  test("closing via Escape from the cold-loaded run route also lands on the Workflow pane", async () => {
    const key = "wf-primary-cold-run-esc-1";
    const now = Date.now();
    const fx = unitFixture("evt-wf-primary-cold-run-esc-1", key, now);
    await mountApp({
      pathname: `/p/${key}/run/${fx.detail.id}`,
      projects: [project({ key, name: "Cold Run Escape Project" })],
      events: [fx.brief],
      eventDetails: { [fx.detail.id]: fx.detail },
    });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();

    expect(location.pathname).toBe(`/p/${key}`);
    const workflowTab = tabButton("Workflow");
    expect(workflowTab).toBeDefined();
    expect(workflowTab!.classList.contains("on")).toBe(true);
    expect(document.querySelector('[data-testid="workflow-active"]')).not.toBeNull();
  });
});
