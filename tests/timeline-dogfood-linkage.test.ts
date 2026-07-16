// CR-CRU-019 §P1 AC-3 — dog-food proof: runs ingested through the v1 shim
// (`POST /api/ingest/parsed`) carrying `context.cycleId` render as ONE
// declared span containing ALL THREE runs, with ZERO inferred (heuristic)
// transition markers — the exact screenshot scenario the CR-CRU-019 patch
// fixes (a full-suite gate run landing outside the cycle that produced it).
//
// Drives the REAL production server (src/server.ts startServer) for BOTH
// the plan/cycle routes AND the v1 parsed-ingest path, round-trips through
// the REAL GET /api/v2/events + GET /api/v2/projects/<key>/plans routes
// (exactly what the client fetches), then feeds those REAL payloads into
// the same happy-dom rendering harness tests/timeline-plan-integration.test.ts
// established for the CR-CRU-011 §S0b declared-span machinery.
//
// RED phase: expected to fail. src/server.ts's handleIngestParsed (v1 shim)
// does not read `body.context` at all today (CR-CRU-019 §P1 AC-1, pinned in
// tests/shim-ingest-events.test.ts) — so none of the three ingested runs
// carry `context.cycleId` once round-tripped through GET /api/v2/events;
// the client never links them to the active cycle, and the §S0b machinery
// (already GREEN from CR-CRU-011) falls back to either the CR-CRU-007
// heuristic marker or nothing declared at all — never the single declared
// open-span this AC requires.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";

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

interface MountOpts {
  pathname: string;
  projects: unknown[];
  events: unknown[];
  plans: unknown[];
}

let cacheBust = 0;

/** Same harness pattern as tests/timeline-plan-integration.test.ts — only
 * `fetch` is scripted; VanJS/VanX/app.js/app-logic are the REAL bundles. */
async function mountApp(opts: MountOpts): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${opts.pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans: opts.plans };
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: opts.projects };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: opts.events };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`timeline-dogfood-linkage.test.ts mountApp: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?timelineDogfoodLinkage=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const FIXED_TREE = [
  {
    name: "s",
    status: "pass",
    children: [
      { name: "t1", status: "pass", duration_ms: 50 },
      { name: "t2", status: "pass", duration_ms: 50 },
    ],
  },
];

describe("dog-food proof — v1 shim ingest linked to a declared cycle (CR-CRU-019 §P1 AC-3)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(async () => {
    handle?.stop();
    handle = undefined;
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  });

  async function postJson(reqPath: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${reqPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(reqPath: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${reqPath}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(reqPath: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${reqPath}`);
  }

  test("RED(2/5) + targeted-GREEN(24/24) + full-suite gate(559/559), each ingested via /api/ingest/parsed with context.cycleId, render as ONE declared open-span containing all three real runs and ZERO inferred transition markers", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const pk = crypto.randomUUID();
    handle.store.addProject({
      key: pk,
      name: "Dogfood Linkage",
      type: "backend",
      sutRoot: "/tmp/dogfood-linkage",
    });

    // 1. File a plan with one cycle, then activate it — real v2 plan routes.
    const planRes = await postJson(`/api/v2/projects/${pk}/plans`, {
      cr: "CR-DOGFOOD-1",
      cycles: [{ label: "c1 checkpoint", kind: "red-green" }],
    });
    expect(planRes.status).toBe(201);
    const planBody = (await planRes.json()) as {
      ok: true;
      planId: number | string;
      cycles: Array<{ id: number; label: string; status: string }>;
    };
    const cycleId = planBody.cycles[0]!.id;

    const activateRes = await patchJson(
      `/api/v2/projects/${pk}/plans/${planBody.planId}/cycles/${cycleId}`,
      { status: "active" },
    );
    expect(activateRes.status).toBe(200);

    // 2. Ingest three runs THROUGH THE v1 PARSED PATH, each carrying
    // context.cycleId linking it to the active cycle above — this is the
    // exact dog-food scenario: RED, a targeted GREEN, and a later full-suite
    // gate run, all declared members of the same cycle.
    const redRes = await postJson("/api/ingest/parsed", {
      projectKey: pk,
      agentId: "dogfood-RED",
      summary: { total: 5, passed: 3, failed: 2, pending: 0, duration_ms: 1000 },
      tree: FIXED_TREE,
      context: { cycleId },
    });
    expect(redRes.status).toBe(200);

    const greenRes = await postJson("/api/ingest/parsed", {
      projectKey: pk,
      agentId: "dogfood-GREEN",
      summary: { total: 24, passed: 24, failed: 0, pending: 0, duration_ms: 1500 },
      tree: FIXED_TREE,
      context: { cycleId },
    });
    expect(greenRes.status).toBe(200);

    const gateRes = await postJson("/api/ingest/parsed", {
      projectKey: pk,
      agentId: "dogfood-GATE",
      summary: { total: 559, passed: 559, failed: 0, pending: 0, duration_ms: 9000 },
      tree: FIXED_TREE,
      context: { cycleId },
    });
    expect(gateRes.status).toBe(200);

    // 3. Round-trip through the REAL v2 events + plans routes — exactly
    // what the client actually fetches (query param is `project`, per
    // src/v2.ts handleEventsList).
    const eventsRes = await getJson(`/api/v2/events?project=${pk}`);
    expect(eventsRes.status).toBe(200);
    const eventsBody = (await eventsRes.json()) as {
      ok: true;
      events: Array<{ id: string; context?: { cycleId?: number } }>;
    };
    expect(eventsBody.events.length).toBe(3);

    const plansRes = await getJson(`/api/v2/projects/${pk}/plans`);
    expect(plansRes.status).toBe(200);
    const plansBody = (await plansRes.json()) as { ok: true; plans: unknown[] };

    // 4. Mount the REAL client shell against these real, round-tripped
    // payloads (not hand-built fixtures) — the actual dog-food assertion.
    await mountApp({
      pathname: `/p/${pk}`,
      projects: [
        {
          key: pk,
          name: "Dogfood Linkage",
          type: "backend",
          agentsOnline: 0,
          agentsTotal: 0,
          active: true,
          lastActivity: Date.now(),
        },
      ],
      events: eventsBody.events,
      plans: plansBody.plans,
    });

    // SANCTIONED RE-TARGET (CR-CRU-021 §S1): a cold `/p/<key>` load now
    // defaults to the Workflow pane, not Runs (workspace default flips) —
    // this test's SUBJECT is the Runs timeline's declared-span dog-food
    // proof, so it now selects the Runs tab EXPLICITLY after mount instead
    // of relying on Runs being the cold-load default. Was: no tab click,
    // relied on cold load already showing the Runs pane's timeline.
    const runsTab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]'),
    ).find((t) => (t.textContent ?? "").trim() === "Runs");
    expect(runsTab).toBeDefined();
    runsTab!.click();
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Zero inferred (heuristic) markers — declared linkage is the boundary
    // authority once context.cycleId round-trips onto the stored events.
    expect(document.querySelectorAll('[data-testid="transition-marker"]').length).toBe(0);

    // Exactly one declared open-span (the cycle is still ACTIVE), carrying
    // the cycle's label.
    const spans = document.querySelectorAll('[data-testid="cycle-span-open"]');
    expect(spans.length).toBe(1);
    expect(spans[0]!.textContent ?? "").toContain("c1 checkpoint");

    // All three REAL ingested runs (their server-assigned ids) render as
    // event cards under the timeline.
    for (const ev of eventsBody.events) {
      expect(
        document.querySelector(`[data-testid="event-card"][data-run-id="${ev.id}"]`),
      ).not.toBeNull();
    }
  });
});
