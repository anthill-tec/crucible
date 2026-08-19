// CR-CRU-021 §S4 — Group headers carry aggregates, never agent-id rows
// (user-locked 2026-07-16).
//
// Spec verbatim: "The CR-group header renders NO per-agent rows of any
// kind — participating agents appear as an aggregate pill (`N agents`) on
// the header; per-agent identity + runtime detail renders only behind the
// group's expansion (alongside the cycle rows)."
//
// AC verbatim: "a closed CR group's header contains an `N agents`
// aggregate pill and ZERO elements carrying an agentId; expanding the
// group reveals the per-agent runtime rows (fleet-registered semantics
// unchanged); the three historical causes are regression-pinned
// (fabricated-0ms fixture, lingering-online-agent fixture, linked-run
// fixture — none may surface an agent-id row at header level)."
//
// Placement decision (escalation-checked against the two contracts this
// touches): the F13 mock's collapsed history row form
// (`▸ [<track> › ]<cr> · <n> cycles ✓ · merged <sha>`, pinned byte-exact by
// tests/f13-fidelity.test.ts) shows NO pill — the mock predates §S4 and
// never draws one on a collapsed row. §S4 says the pill sits "on the
// header", and CR-020 §S1.2 established that the header row (the toggle
// line itself: cr name, track badge, rollup, merge pill) is the ONE
// element that stays visually identical collapsed or expanded. Reconciled
// per the dispatch brief: the pill belongs to the group's header REGION
// but renders only once the group is EXPANDED — i.e. it toggles on/off
// alongside the cycle rows via the SAME `cr-group-toggle` click, never
// altering the collapsed row's byte-exact text. This keeps f13-fidelity's
// collapsed-row assertions (which use `toContain`, not equality, and never
// pass fleet-registered agents matching a participating run's agentId in
// its own fixtures) unaffected.
//
// Singular/plural decision: no counter-evidence found for `1 agent`
// (singular) in the F13 mock or spec text beyond the plural `N agents`
// wording (crucible-v2-design.html:675, "group headers carry an N agents
// aggregate only"). Using singular `1 agent` for exactly one
// fleet-registered participant per the dispatch brief's default.
//
// New testid/attribute contract this file introduces for GREEN (does not
// exist yet — mirrors the existing `cr-group-toggle`/`cr-rollup`/
// `cr-merge-commit` precedent of reusing the header region rather than
// inventing new DOM structure):
//   - `[data-testid="cr-agents-pill"]` — the aggregate `N agents` /
//     `1 agent` pill, a header-region sibling that renders ONLY while the
//     group is expanded (`lensOpen(key)` true) AND the fleet-registered
//     participant count is > 0. Absent (not `0 agents`) when the count is
//     zero, and absent entirely while collapsed.
//
// KNOWN CONFLICT WITH AN EXISTING TEST (flagged, not silently patched):
// tests/workflow-lens.test.ts ("the rollup summary is `<done>/<total>
// cycles`, and a participating agent's live runtime renders under the
// group") asserts `[data-testid="cr-agent-runtime"]` is present WITHOUT
// ever clicking the group's toggle — i.e. it pins the OLD CR-011 §S2
// always-visible-at-header-level behavior that §S4 explicitly retires
// ("CR-011's information survives, one level down"). That test will start
// failing once GREEN lands §S4 and needs a SANCTIONED RE-TARGET (require
// `groupToggle.click()` before asserting `cr-agent-runtime`), matching the
// pattern already used elsewhere in this CR (see the "SANCTIONED
// RE-TARGET" comments in tests/workflow-history-refinements.test.ts). Out
// of scope for this dispatch (new-file-only); reported for the
// orchestrator/GREEN to action.
//
// Drives the REAL production public/app.js shell inside a happy-dom
// window — same harness pattern as tests/workflow-history-refinements.
// test.ts / tests/agent-runtime-pane.test.ts.
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

interface EventFixture {
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
  duration_ms?: number;
  hasCoverage?: boolean;
  context?: { cycleId?: number; wave?: string; cycle?: string };
}

interface CycleFixture {
  id: number;
  label: string;
  kind?: string;
  status: "pending" | "active" | "done" | "skipped" | "failed";
}

interface PlanFixture {
  planId: number | string;
  cr: string;
  projectKey: string;
  status: "open" | "closed";
  wave?: string;
  track?: string;
  cycles: CycleFixture[];
  merge?: { commit: string };
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

interface AgentFixture {
  agentId: string;
  projectKey: string;
  status?: "online" | "busy";
  liveness: "online" | "stale" | "tombstoned";
  lastSeen: number;
  message?: string;
  identity?: { displayName?: string };
  runtime_ms?: number;
}

interface MountOpts {
  pathname?: string;
  projects: ProjectFixture[];
  events: EventFixture[];
  plans: PlanFixture[];
  agents: AgentFixture[];
}

let cacheBust = 0;

async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: opts.agents };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`aggregate-headers.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?aggregateHeaders=${cacheBust}`);

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

function runEvent(
  overrides: Partial<EventFixture> & Pick<EventFixture, "id" | "projectKey" | "agentId" | "timestamp">,
): EventFixture {
  return {
    kind: "test",
    tier: "unit",
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    hasCoverage: false,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentFixture> & { agentId: string; projectKey: string }): AgentFixture {
  return {
    liveness: "online",
    lastSeen: Date.now(),
    runtime_ms: 1_000,
    ...overrides,
  };
}

async function openWorkflowTab(): Promise<void> {
  const tab = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
  ).find((t) => (t.textContent ?? "").trim() === "Workflow");
  expect(tab).toBeDefined();
  tab!.click();
  await settle();
}

function history(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="workflow-history"]');
  expect(el).not.toBeNull();
  return el!;
}

function crGroupToggle(crGroup: HTMLElement): HTMLElement {
  const toggle = crGroup.querySelector<HTMLElement>('[data-testid="cr-group-toggle"]');
  expect(toggle).not.toBeNull();
  return toggle!;
}

function agentIdsOf(runtimeRows: NodeListOf<Element>): string[] {
  return Array.from(runtimeRows).map((r) =>
    (r.querySelector(".app-agent-id")?.textContent ?? "").trim(),
  );
}

describe("§S4 — CR-group headers carry an aggregate pill, never per-agent rows", () => {
  test(
    "a closed CR group's collapsed header carries ZERO agentId-bearing elements and no pill; expanding the same header (the group's own toggle) renders the `2 agents` aggregate pill plus the two per-agent runtime rows; collapsing again hides both",
    async () => {
      const key = "agg-collapse-expand-1";
      const now = Date.now();
      const runAlpha = runEvent({
        id: "evt-agg-1a",
        projectKey: key,
        agentId: "agent-alpha",
        timestamp: now,
        context: { cycleId: 9001 },
      });
      const runBeta = runEvent({
        id: "evt-agg-1b",
        projectKey: key,
        agentId: "agent-beta",
        timestamp: now + 10,
        context: { cycleId: 9002 },
      });
      const plan: PlanFixture = {
        planId: 9001,
        cr: "CR-AGG-1",
        projectKey: "agg-collapse-expand-1",
        status: "closed",
        wave: "1",
        merge: { commit: "agg1commit" },
        cycles: [
          { id: 9001, label: "c1", status: "done" },
          { id: 9002, label: "c2", status: "done" },
        ],
      };

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Agg Project 1" })],
        events: [runAlpha, runBeta],
        plans: [plan],
        agents: [
          agent({ agentId: "agent-alpha", projectKey: key, runtime_ms: 5_000 }),
          agent({ agentId: "agent-beta", projectKey: key, runtime_ms: 8_000 }),
        ],
      });
      await openWorkflowTab();

      const crGroup = history().querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-AGG-1"]',
      );
      expect(crGroup).not.toBeNull();

      // Collapsed by default (§S1.2, unchanged).
      expect(crGroup!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(0);

      // AC — zero elements carrying an agentId anywhere in the collapsed header.
      expect(crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]').length).toBe(0);
      expect(crGroup!.querySelectorAll(".app-agent-id").length).toBe(0);
      expect(crGroup!.textContent ?? "").not.toContain("agent-alpha");
      expect(crGroup!.textContent ?? "").not.toContain("agent-beta");

      // Pill placement decision — absent while collapsed.
      expect(crGroup!.querySelector('[data-testid="cr-agents-pill"]')).toBeNull();

      const toggle = crGroupToggle(crGroup!);
      toggle.click();
      await settle();

      const pill = crGroup!.querySelector('[data-testid="cr-agents-pill"]');
      expect(pill).not.toBeNull();
      expect((pill!.textContent ?? "").trim()).toBe("2 agents");

      const runtimeRows = crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]');
      expect(runtimeRows.length).toBe(2);
      expect(agentIdsOf(runtimeRows).sort()).toEqual(["agent-alpha", "agent-beta"]);

      // Collapsing again hides both the pill and the per-agent rows.
      toggle.click();
      await settle();
      expect(crGroup!.querySelector('[data-testid="cr-agents-pill"]')).toBeNull();
      expect(crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]').length).toBe(0);
    },
  );

  test(
    "exactly one fleet-registered participating agent renders the SINGULAR `1 agent` pill text once the header is expanded",
    async () => {
      const key = "agg-singular-1";
      const now = Date.now();
      const runSolo = runEvent({
        id: "evt-agg-solo",
        projectKey: key,
        agentId: "agent-solo",
        timestamp: now,
        context: { cycleId: 9101 },
      });
      const plan: PlanFixture = {
        planId: 9002,
        cr: "CR-AGG-2",
        projectKey: "agg-singular-1",
        status: "closed",
        wave: "1",
        merge: { commit: "agg2commit" },
        cycles: [{ id: 9101, label: "c1", status: "done" }],
      };

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Agg Project 2" })],
        events: [runSolo],
        plans: [plan],
        agents: [agent({ agentId: "agent-solo", projectKey: key, runtime_ms: 3_000 })],
      });
      await openWorkflowTab();

      const crGroup = history().querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-AGG-2"]',
      );
      expect(crGroup).not.toBeNull();

      crGroupToggle(crGroup!).click();
      await settle();

      const pill = crGroup!.querySelector('[data-testid="cr-agents-pill"]');
      expect(pill).not.toBeNull();
      expect((pill!.textContent ?? "").trim()).toBe("1 agent");
      expect((pill!.textContent ?? "").trim()).not.toBe("1 agents");
    },
  );

  test(
    "a CR group with cycles carrying NO linked runs at all (zero participating agents) renders NO pill — not `0 agents` — even once its header is expanded",
    async () => {
      const key = "agg-zero-1";
      const plan: PlanFixture = {
        planId: 9003,
        cr: "CR-AGG-3",
        projectKey: "agg-zero-1",
        status: "closed",
        wave: "1",
        merge: { commit: "agg3commit" },
        cycles: [{ id: 9201, label: "c1", status: "done" }],
      };

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Agg Project 3" })],
        events: [],
        plans: [plan],
        agents: [],
      });
      await openWorkflowTab();

      const crGroup = history().querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-AGG-3"]',
      );
      expect(crGroup).not.toBeNull();

      crGroupToggle(crGroup!).click();
      await settle();

      expect(crGroup!.querySelector('[data-testid="cr-agents-pill"]')).toBeNull();
      expect(crGroup!.textContent ?? "").not.toContain("0 agents");
      expect(crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]').length).toBe(0);
    },
  );
});

describe("§S4 regression pins — the three historical causes never surface an agent-id row at header level", () => {
  test(
    "FABRICATED-0MS regression: a cycle's linked run names an agent id with NO fleet registration — that id never renders a runtime row (collapsed or expanded) and is excluded from the pill count, which counts the one registered participant only",
    async () => {
      const key = "agg-fabricated-0ms-1";
      const now = Date.now();
      const runGhost = runEvent({
        id: "evt-agg-ghost",
        projectKey: key,
        agentId: "ghost-unregistered",
        timestamp: now,
        context: { cycleId: 9301 },
      });
      const runReal = runEvent({
        id: "evt-agg-real",
        projectKey: key,
        agentId: "real-registered",
        timestamp: now + 10,
        context: { cycleId: 9302 },
      });
      const plan: PlanFixture = {
        planId: 9004,
        cr: "CR-AGG-4",
        projectKey: "agg-fabricated-0ms-1",
        status: "closed",
        wave: "1",
        merge: { commit: "agg4commit" },
        cycles: [
          { id: 9301, label: "c1", status: "done" },
          { id: 9302, label: "c2", status: "done" },
        ],
      };

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Agg Project 4" })],
        events: [runGhost, runReal],
        plans: [plan],
        // Only "real-registered" has a fleet record — "ghost-unregistered"
        // is named in a run's agentId but never registered (the historical
        // fabricated-0ms cause: plans/runs referencing an agent id that was
        // never in the fleet).
        agents: [agent({ agentId: "real-registered", projectKey: key, runtime_ms: 2_000 })],
      });
      await openWorkflowTab();

      const crGroup = history().querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-AGG-4"]',
      );
      expect(crGroup).not.toBeNull();

      // Collapsed — no rows, no pill, no trace of either id at header level.
      expect(crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]').length).toBe(0);
      expect(crGroup!.textContent ?? "").not.toContain("ghost-unregistered");
      expect(crGroup!.textContent ?? "").not.toContain("real-registered");

      crGroupToggle(crGroup!).click();
      await settle();

      // Expanded — the pill counts ONLY the fleet-registered participant.
      const pill = crGroup!.querySelector('[data-testid="cr-agents-pill"]');
      expect(pill).not.toBeNull();
      expect((pill!.textContent ?? "").trim()).toBe("1 agent");

      const runtimeRows = crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]');
      expect(runtimeRows.length).toBe(1);
      expect(agentIdsOf(runtimeRows)).toEqual(["real-registered"]);
      expect(crGroup!.textContent ?? "").not.toContain("ghost-unregistered");
    },
  );

  test(
    "LINGERING-ONLINE-AGENT regression: a fleet-registered agent still `online` (never unregistered — a gate-agent ghost) on a CLOSED group renders no header-level row while collapsed; its runtime row is fine once the header is expanded",
    async () => {
      const key = "agg-lingering-online-1";
      const now = Date.now();
      const runGate = runEvent({
        id: "evt-agg-gate",
        projectKey: key,
        agentId: "gate-ghost-online",
        timestamp: now,
        context: { cycleId: 9401 },
      });
      const plan: PlanFixture = {
        planId: 9005,
        cr: "CR-AGG-5",
        projectKey: "agg-lingering-online-1",
        status: "closed",
        wave: "1",
        merge: { commit: "agg5commit" },
        cycles: [{ id: 9401, label: "c1", status: "done" }],
      };

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Agg Project 5" })],
        events: [runGate],
        plans: [plan],
        // Still `online` — never unregistered, exactly the CR-CRU-020-CLOSE
        // gremlin (38-minute lingering online gate agent).
        agents: [
          agent({
            agentId: "gate-ghost-online",
            projectKey: key,
            liveness: "online",
            runtime_ms: 2_280_000,
          }),
        ],
      });
      await openWorkflowTab();

      const crGroup = history().querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-AGG-5"]',
      );
      expect(crGroup).not.toBeNull();

      // Collapsed — the CR group is CLOSED; the still-online agent must not
      // leak a header-level row just because it hasn't been unregistered.
      expect(crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]').length).toBe(0);
      expect(crGroup!.textContent ?? "").not.toContain("gate-ghost-online");
      expect(crGroup!.querySelector('[data-testid="cr-agents-pill"]')).toBeNull();

      crGroupToggle(crGroup!).click();
      await settle();

      // Behind expansion, the runtime row is fine.
      const pill = crGroup!.querySelector('[data-testid="cr-agents-pill"]');
      expect(pill).not.toBeNull();
      expect((pill!.textContent ?? "").trim()).toBe("1 agent");
      const runtimeRows = crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]');
      expect(runtimeRows.length).toBe(1);
      expect(agentIdsOf(runtimeRows)).toEqual(["gate-ghost-online"]);
    },
  );

  test(
    "LINKED-RUN regression (the original run leak): a CR group whose cycles carry linked runs never renders a raw run row ([data-run-id] / linked-run-row) at the group's own header/agents level — only the aggregate pill and per-agent rows appear there, even once the group's own toggle (not any cycle's toggle) is expanded",
    async () => {
      const key = "agg-linked-run-leak-1";
      const now = Date.now();
      const runOne = runEvent({
        id: "evt-agg-leak-1",
        projectKey: key,
        agentId: "leak-agent-1",
        timestamp: now,
        context: { cycleId: 9501 },
      });
      const runTwo = runEvent({
        id: "evt-agg-leak-2",
        projectKey: key,
        agentId: "leak-agent-2",
        timestamp: now + 10,
        context: { cycleId: 9502 },
      });
      const plan: PlanFixture = {
        planId: 9006,
        cr: "CR-AGG-6",
        projectKey: "agg-linked-run-leak-1",
        status: "closed",
        wave: "1",
        merge: { commit: "agg6commit" },
        cycles: [
          { id: 9501, label: "c1", status: "done" },
          { id: 9502, label: "c2", status: "done" },
        ],
      };

      await mountApp({
        pathname: `/p/${key}`,
        projects: [project({ key, name: "Agg Project 6" })],
        events: [runOne, runTwo],
        plans: [plan],
        agents: [
          agent({ agentId: "leak-agent-1", projectKey: key, runtime_ms: 1_000 }),
          agent({ agentId: "leak-agent-2", projectKey: key, runtime_ms: 2_000 }),
        ],
      });
      await openWorkflowTab();

      const crGroup = history().querySelector<HTMLElement>(
        '[data-testid="cr-group"][data-cr="CR-AGG-6"]',
      );
      expect(crGroup).not.toBeNull();

      // Before any toggle at all — no run rows, no runtime rows, no pill.
      expect(crGroup!.querySelectorAll('[data-run-id]').length).toBe(0);
      expect(crGroup!.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);
      expect(crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]').length).toBe(0);

      // Click ONLY the group's own toggle (never a cycle's own toggle) —
      // the historical defect rendered raw run rows at group level from
      // this action alone.
      crGroupToggle(crGroup!).click();
      await settle();

      // Cycle rows appear (existing §S1.2 contract) but NO run entries leak
      // in alongside them at group level — that requires each cycle's OWN
      // toggle (§S2.1, untouched by this CR).
      expect(crGroup!.querySelectorAll('[data-testid="lens-cycle-row"]').length).toBe(2);
      expect(crGroup!.querySelectorAll('[data-run-id]').length).toBe(0);
      expect(crGroup!.querySelectorAll('[data-testid="linked-run-row"]').length).toBe(0);

      // The aggregate pill + per-agent runtime rows are exactly what DOES
      // appear at header level — never the raw run entries.
      const pill = crGroup!.querySelector('[data-testid="cr-agents-pill"]');
      expect(pill).not.toBeNull();
      expect((pill!.textContent ?? "").trim()).toBe("2 agents");
      const runtimeRows = crGroup!.querySelectorAll('[data-testid="cr-agent-runtime"]');
      expect(runtimeRows.length).toBe(2);
      expect(agentIdsOf(runtimeRows).sort()).toEqual(["leak-agent-1", "leak-agent-2"]);
    },
  );
});
