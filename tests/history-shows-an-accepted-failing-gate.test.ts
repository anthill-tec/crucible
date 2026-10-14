// The History page shows, on a CR's row, that the CR closed over a red
// pre-merge gate and why — read from the `/history` read's
// `acceptedFailingGates` (src/v2.ts `handleProjectHistory`). A CR that closed
// over a green gate carries no such line.
//
// Page half only, over the real public/app.js in happy-dom with fetch mocked
// (the harness tests/workflow-history-release-tree.test.ts drives History
// with); the server half is pinned where the read is.
import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "./helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

const KEY = "hist-accepted-red-gate";
const RED_CR = "HIST-ARG-701";
const GREEN_CR = "HIST-ARG-702";
const REASON = "the failing case is a known flake, fixed by the next CR";

interface AcceptedFailingGateWire {
  cr: string;
  planId: number;
  commit: string;
  reason: string;
  closedAt?: number;
}

let cacheBust = 0;

async function mountHistory(accepted: AcceptedFailingGateWire[] | undefined): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/p/${KEY}` });
  document.body.innerHTML = '<div id="app"></div>';
  const now = Date.now();
  const plans = [RED_CR, GREEN_CR].map((cr, i) => ({
    planId: 70 + i,
    cr,
    projectKey: KEY,
    status: "closed",
    wave: "7",
    cycles: [{ id: 700 + i, label: "c1", status: "done" }],
    merge: { commit: `abc000${i}` },
  }));
  const history = [
    {
      labels: ["0.7.0"],
      state: "in progress",
      crCount: 2,
      waves: [{ wave: "7", crs: [RED_CR, GREEN_CR] }],
      workflows: [{ label: "0.7.0", gateRuns: [], verificationRuns: 0 }],
    },
  ];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (/\/api\/v2\/projects\/[^/]+\/history/.test(url)) {
      body = { ok: true, releases: history, ...(accepted !== undefined ? { acceptedFailingGates: accepted } : {}) };
    } else if (/\/api\/v2\/projects\/[^/]+\/plans/.test(url)) {
      body = { ok: true, plans };
    } else if (url.includes("/api/v2/projects")) {
      body = {
        ok: true,
        projects: [
          { key: KEY, name: "Accepted red gate", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
        ],
      };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`history-shows-an-accepted-failing-gate.test.ts: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?historyAcceptedFailingGate=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settleDom({ ticks: 8 });

  const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="workspace-tab"]')).find(
    (el) => (el.textContent ?? "").trim() === "Workflow",
  );
  expect(tab).toBeDefined();
  tab!.click();
  await settleDom({ ticks: 8 });
  if (document.querySelector(`[data-testid="cr-group"][data-cr="${RED_CR}"]`) === null) {
    document.querySelector<HTMLElement>('[data-testid="wave-group"][data-wave="7"] [data-testid="wave-header"]')!.click();
    await settleDom({ ticks: 8 });
  }
}

function crRow(cr: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-testid="history-release"] [data-testid="cr-group"][data-cr="${cr}"]`,
  );
  expect(row).not.toBeNull();
  return row!;
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

describe("History shows a CR that closed over an accepted failing gate", () => {
  test("the CR's row names the red gate and the reason it was accepted; a CR closed over a green gate shows none", async () => {
    await mountHistory([{ cr: RED_CR, planId: 70, commit: "abc0000", reason: REASON, closedAt: 1_760_000_000 }]);

    const marker = crRow(RED_CR).querySelector('[data-testid="cr-accepted-failing-gate"]');
    expect(marker).not.toBeNull();
    const text = (marker!.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("red gate");
    expect(text).toContain(REASON);
    expect(crRow(GREEN_CR).querySelector('[data-testid="cr-accepted-failing-gate"]')).toBeNull();
  });

  test("a history read with no acceptedFailingGates shows the line on no row", async () => {
    await mountHistory(undefined);
    for (const cr of [RED_CR, GREEN_CR]) {
      expect(crRow(cr).querySelector('[data-testid="cr-accepted-failing-gate"]')).toBeNull();
    }
  });
});
