// The run view's body is not rebuilt by a feature fold or by the raw output:
// each BDD feature is its own binding (folding or unfolding one replaces only
// that feature's nodes), and the raw output is its own binding (showing it
// rebuilds no suite, and a suite loaded while it shows rebuilds no other).
//
// Spec: docs/changes/CR-CRU-158-a-runs-detail-stays-responsive-while-agents-run.md
//       §S2 ("A loaded suite renders without rebuilding the others", G4 —
//       the body rebuilds as a whole).
//
// Method (the suite-load identity tests' method): tag every rendered element
// before the change, then assert every element outside the changed part is
// the exact same node object, still attached to the document, afterwards.
// Same happy-dom harness: real public/app.js, real public/app-logic.mjs, real
// VanJS/VanX vendor bundles; `fetch` is scripted.
import { describe, test, expect, afterEach } from "bun:test";
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

interface Leaf {
  name: string;
  status: "pass" | "fail";
  duration_ms: number;
}
interface Suite {
  name: string;
  status: "pass" | "fail";
  children: Leaf[];
}
interface Detail {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test";
  tier: string;
  codec?: string;
  timestamp: number;
  raw?: string;
  tree: Suite[];
}

let cacheBust = 0;

const passedOf = (children: Leaf[]): number => children.filter((l) => l.status === "pass").length;

async function mountAtRun(detail: Detail): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/run/${detail.id}` });
  document.body.innerHTML = '<div id="app"></div>';
  const all = detail.tree.flatMap((s) => s.children);
  const brief = {
    id: detail.id,
    projectKey: detail.projectKey,
    agentId: detail.agentId,
    kind: "test",
    tier: detail.tier,
    codec: detail.codec,
    timestamp: detail.timestamp,
    total: all.length,
    passed: passedOf(all),
    failed: all.length - passedOf(all),
    pending: 0,
    duration_ms: 500,
    hasCoverage: false,
  };

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    if (eventMatch !== null) {
      const parsed = new URL(url, "http://localhost");
      const suite = parsed.searchParams.get("suite");
      if (suite !== null) {
        const match = detail.tree.find((n) => n.name === suite);
        body = { ok: true, event: { ...detail, tree: match !== undefined ? [match] : [] } };
      } else {
        const tree = detail.tree.map((n) => ({
          name: n.name,
          status: n.status,
          counts: { passed: passedOf(n.children), failed: n.children.length - passedOf(n.children), pending: 0 },
        }));
        body = { ok: true, event: { ...detail, tree } };
      }
    } else if (url.includes("/api/v2/projects")) {
      body = { ok: true, projects: [] };
    } else if (url.includes("/api/v2/agents")) {
      body = { ok: true, agents: [] };
    } else if (url.includes("/api/v2/events")) {
      body = { ok: true, events: [brief] };
    } else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else {
      throw new Error(`run-detail-feature-fold-and-raw-dom-identity: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?featureFoldRawIdentity=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settle();
}

async function settle(ticks = 6): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function overlay(): Element {
  const el = document.querySelector('[data-testid="run-overlay"]');
  if (el === null) throw new Error("the run view did not open");
  return el;
}

/** Every element matched by `selector`, the SAME node objects (not clones). */
function nodes(selector: string): Element[] {
  return Array.from(overlay().querySelectorAll(selector));
}

function suiteRow(key: string): Element | null {
  return overlay().querySelector(`[data-testid="suite-row"][data-suite-key="${CSS.escape(key)}"]`);
}

function featureGroup(title: string): Element | null {
  return overlay().querySelector(`[data-testid="feature-group"][data-feature-name="${CSS.escape(title)}"]`);
}

/** Asserts each node kept its identity: still attached, and still the node
 *  its selector resolves to. */
function expectKept(before: Element[], what: string): void {
  expect(before.length, `no ${what} to check`).toBeGreaterThan(0);
  for (const el of before) {
    expect(el.isConnected, `${what} "${el.getAttribute("data-suite-key") ?? el.getAttribute("data-feature-name") ?? (el as HTMLElement).title ?? ""}" was rebuilt`).toBe(true);
  }
}

function plainRun(id: string, raw: string): Detail {
  const tree: Suite[] = [];
  for (let s = 1; s <= 5; s++) {
    const name = `Suite-${s}`;
    tree.push({
      name,
      status: "pass",
      children: [1, 2, 3].map((l) => ({ name: `${name}-leaf-${l}`, status: "pass" as const, duration_ms: 2 })),
    });
  }
  return {
    id,
    projectKey: "proj-raw-identity",
    agentId: "raw-identity-agent",
    kind: "test",
    tier: "e2e",
    timestamp: Date.now(),
    raw,
    tree,
  };
}

/** Three all-passing features of three scenarios each: the first unfolds on
 *  open (and reads its first scenarios), the other two stay folded. */
function specRun(id: string): Detail {
  const tree: Suite[] = [];
  for (const feature of ["Alpha", "Beta", "Gamma"]) {
    for (let s = 1; s <= 3; s++) {
      tree.push({
        name: `${feature} › Scenario ${s}`,
        status: "pass",
        children: [1, 2].map((l) => ({ name: `step-${l}`, status: "pass" as const, duration_ms: 2 })),
      });
    }
  }
  return {
    id,
    projectKey: "proj-fold-identity",
    agentId: "fold-identity-agent",
    kind: "test",
    tier: "e2e",
    codec: "playwright",
    timestamp: Date.now(),
    tree,
  };
}

function clickHeading(title: string): void {
  const heading = featureGroup(title)?.querySelector('[data-testid="feature-heading"]') as HTMLElement | null;
  expect(heading, `feature "${title}" has no heading`).not.toBeNull();
  heading!.click();
}

describe("the raw output is its own binding", () => {
  test("showing the raw output rebuilds no suite row, heat cell or the body itself", async () => {
    await mountAtRun(plainRun("evt-raw-open-identity", "RAW RUN OUTPUT"));
    const body = nodes(".app-drillin-tree");
    const rows = nodes('[data-testid="suite-row"]');
    const cells = nodes('[data-testid="heat-cell"]');
    expect(rows.length).toBe(5);
    expect(overlay().querySelector('[data-testid="raw-output"]')).toBeNull();

    const toggle = document.querySelector('[data-testid="raw-toggle"]') as HTMLElement | null;
    expect(toggle, "the run's raw output has no toggle").not.toBeNull();
    toggle!.click();
    await settle();

    expect(overlay().querySelector('[data-testid="raw-output"]')?.textContent).toBe("RAW RUN OUTPUT");
    expectKept(body, "the run-detail body");
    expectKept(rows, "suite row");
    expectKept(cells, "heat cell");
    for (const row of rows) expect(suiteRow(row.getAttribute("data-suite-key")!)).toBe(row);
  });

  test("a suite loaded while the raw output shows rebuilds no other suite's row and keeps the raw output", async () => {
    await mountAtRun(plainRun("evt-raw-shown-load-identity", "RAW RUN OUTPUT"));
    (document.querySelector('[data-testid="raw-toggle"]') as HTMLElement).click();
    await settle();
    expect(overlay().querySelector('[data-testid="raw-output"]')).not.toBeNull();

    const body = nodes(".app-drillin-tree");
    const others = nodes('[data-testid="suite-row"]').filter((el) => el.getAttribute("data-suite-key") !== "Suite-3");
    expect(others.length).toBe(4);
    (suiteRow("Suite-3") as HTMLElement).click();
    await settle();

    expect(suiteRow("Suite-3")?.querySelector('[data-testid="tree-toggle"]')?.textContent).toBe("▾");
    expectKept(body, "the run-detail body");
    expectKept(others, "suite row");
    for (const row of others) expect(suiteRow(row.getAttribute("data-suite-key")!)).toBe(row);
    expect(overlay().querySelector('[data-testid="raw-output"]')?.textContent).toBe("RAW RUN OUTPUT");
  });
});

describe("each BDD feature is its own binding", () => {
  test("unfolding one feature replaces only that feature's nodes: the other features, their scenario rows, the heat cells and the body are kept", async () => {
    await mountAtRun(specRun("evt-unfold-identity"));
    expect(featureGroup("Alpha")?.querySelectorAll('[data-testid="suite-row"]').length).toBe(3);
    expect(featureGroup("Beta")?.querySelectorAll('[data-testid="suite-row"]').length).toBe(0);

    const body = nodes(".app-drillin-tree");
    const alpha = [featureGroup("Alpha")!];
    const gamma = [featureGroup("Gamma")!];
    const alphaRows = Array.from(alpha[0]!.querySelectorAll('[data-testid="suite-row"]'));
    const cells = nodes('[data-testid="heat-cell"]');
    expect(cells.length).toBe(18);

    clickHeading("Beta");
    await settle();

    // The change itself: Beta unfolded.
    expect(featureGroup("Beta")?.querySelectorAll('[data-testid="suite-row"]').length).toBe(3);
    expectKept(body, "the run-detail body");
    expectKept(alpha, "feature group");
    expectKept(gamma, "feature group");
    expectKept(alphaRows, "suite row");
    expectKept(cells, "heat cell");
    expect(featureGroup("Alpha")).toBe(alpha[0]!);
    expect(featureGroup("Gamma")).toBe(gamma[0]!);
    for (const row of alphaRows) expect(suiteRow(row.getAttribute("data-suite-key")!)).toBe(row);
  });

  test("folding one feature replaces only that feature's nodes: the other features and the body are kept", async () => {
    await mountAtRun(specRun("evt-fold-identity"));
    clickHeading("Beta");
    await settle();
    const body = nodes(".app-drillin-tree");
    const beta = [featureGroup("Beta")!];
    const gamma = [featureGroup("Gamma")!];
    const betaRows = Array.from(beta[0]!.querySelectorAll('[data-testid="suite-row"]'));
    expect(betaRows.length).toBe(3);
    const cells = nodes('[data-testid="heat-cell"]');

    clickHeading("Alpha");
    await settle();

    // The change itself: Alpha folded.
    expect(featureGroup("Alpha")?.querySelectorAll('[data-testid="suite-row"]').length).toBe(0);
    expectKept(body, "the run-detail body");
    expectKept(beta, "feature group");
    expectKept(gamma, "feature group");
    expectKept(betaRows, "suite row");
    expectKept(cells, "heat cell");
    expect(featureGroup("Beta")).toBe(beta[0]!);
  });
});
