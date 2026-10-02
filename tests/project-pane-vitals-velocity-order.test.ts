// CR-CRU-156 §S1/AC1 — the Project pane orders Vitals before Velocity, with
// the agent rows ahead of both.
//
// Spec: docs/changes/CR-CRU-156-the-velocity-card-sits-below-vitals.md.
// Visual contract: storyboard frame F18 §1 (.lavish/crucible-v2-design.html).
//
// RED phase: expected to FAIL against the CURRENT public/app.js, where
// ProjectPane renders, top to bottom: the Project card, VelocityCard(), the
// agent rows, then VitalsRail() — Velocity sits ABOVE the agents and Vitals,
// not below them. This file drives the REAL production entry point
// (public/app.js's actual boot sequence + the real vendored VanJS/VanX
// bundles + the real public/app-logic.mjs) inside a happy-dom window,
// following the same mounting pattern as tests/shell-final-form.test.ts and
// tests/cr022-analytics-ui.test.ts. Only `fetch` is scripted.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

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

const PROJECT_KEY = "proj-vitals-velocity-order-1";

// AC1's own velocity fixture — needs real `weeks`/`sampleWeeks` shape so
// `VelocityCard` actually renders `project-velocity` (an empty/null read
// renders nothing, which would fail this test for the WRONG reason).
const VELOCITY_BODY = {
  ok: true,
  pointsPerWeek: 12,
  weeks: [
    { week: "2026-W40", points: 10 },
    { week: "2026-W41", points: 14 },
  ],
  sampleWeeks: 2,
  flow: { execMsPerCycle: 1_000_000, gateMsPerCycle: 500_000, sampleCycles: 4 },
};

let cacheBust = 0;

async function mountApp(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${PROJECT_KEY}` });
  document.body.innerHTML = '<div id="app"></div>';

  const now = Date.now();
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    const okResponse = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as Response;
    if (/\/analytics\/velocity/.test(url)) return okResponse(VELOCITY_BODY);
    if (url.includes("/api/v2/projects")) {
      return okResponse({
        ok: true,
        projects: [
          {
            key: PROJECT_KEY,
            name: "Order Project",
            type: "backend",
            agentsOnline: 1,
            agentsTotal: 1,
            active: true,
            lastActivity: now,
          },
        ],
      });
    }
    if (url.includes("/api/v2/agents")) {
      return okResponse({
        ok: true,
        agents: [
          {
            agentId: "order-a1",
            projectKey: PROJECT_KEY,
            status: "online",
            liveness: "online",
            lastSeen: now,
          },
        ],
      });
    }
    if (url.includes("/api/v2/events")) return okResponse({ ok: true, events: [] });
    if (url.includes("/api/v2/health")) {
      return okResponse({ ok: true, version: "2.0.0-test", counts: { events: 0 } });
    }
    // Every other read this boot triggers (queue/releases/release-proposals/
    // burndown/forecast/plans) is individually try/caught in production and
    // degrades to its last-known (empty) value — deliberately left
    // unhandled here, matching tests/shell-final-form.test.ts's mountApp.
    throw new Error(
      `project-pane-vitals-velocity-order.test.ts mountApp: unexpected fetch url ${url}`,
    );
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?projectPaneVitalsVelocityOrder=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settleDom({ ticks: 10 });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

describe("CR-CRU-156 §S1/AC1 — Project pane: agent rows, then Vitals, then Velocity", () => {
  test("vitals-rail precedes project-velocity, and the agent rows precede both, in document order", async () => {
    await mountApp();

    const pane = document.querySelector('[data-testid="project-pane"]');
    expect(pane).not.toBeNull();

    const agentRows = pane!.querySelectorAll('[data-testid="agent-row"]');
    expect(agentRows.length).toBe(1);
    const lastAgentRow = agentRows[agentRows.length - 1]!;

    const vitals = pane!.querySelector('[data-testid="vitals-rail"]');
    expect(vitals).not.toBeNull();

    const velocity = pane!.querySelector('[data-testid="project-velocity"]');
    expect(velocity).not.toBeNull();

    const precedes = (a: Element, b: Element): boolean =>
      // eslint-disable-next-line no-bitwise
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    // Agent rows precede BOTH vitals-rail and project-velocity.
    expect(precedes(lastAgentRow, vitals!)).toBe(true);
    expect(precedes(lastAgentRow, velocity!)).toBe(true);
    // vitals-rail precedes project-velocity.
    expect(precedes(vitals!, velocity!)).toBe(true);
  });
});
