// The run detail's failure jump (`[data-testid="failure-jump"]`, one of the
// header controls `RunDetailBody` builds in public/app.js) counts the
// failures the walk has NOT yet opened, and walks them from the first.
//
// Drives the REAL production public/app.js shell inside a happy-dom window —
// the same harness as tests/integration/density.test.ts / tests/integration/drill-in.test.ts: real
// VanJS/VanX vendor bundles, real public/app-logic.mjs, real public/app.js;
// `fetch` is scripted and answers the suites-first wire (`?depth=suites`
// carries per-suite counts only, `?suite=<name>` carries that suite's
// leaves).
//
// Contract pinned here:
//   - before any press, a run with N failures reads "▸ N more failures"
//     ("▸ 1 more failure" for one) and no failure box is open;
//   - each press opens the NEXT failure in walk order (failing suites in tree
//     order, their failing leaves in order), starting from the FIRST, and the
//     count drops by one; exactly one failure box is open after each press;
//   - from the press that opens the last unopened failure on, the label
//     names the open failure's place in walk order, "▸ failure k of N", and
//     further presses keep cycling, wrapping from the last to the first;
//   - N is the run's failed count before the first press, and the number of
//     failing leaves the walk holds once it has loaded the failing suites;
//   - opening a failure by clicking its row moves neither the label nor the
//     walk's cursor.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { settleDom } from "../helpers/dom-settle";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

interface LeafFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  duration_ms: number;
  failure?: { message: string };
}
interface SuiteFixture {
  name: string;
  status: "pass" | "fail" | "pending";
  children: LeafFixture[];
}
interface Summary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
}

let cacheBust = 0;
let fetchLog: string[] = [];

function suiteCounts(children: LeafFixture[]): { passed: number; failed: number; pending: number } {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const leaf of children) {
    if (leaf.status === "pass") counts.passed += 1;
    else if (leaf.status === "fail") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

/** Mounts the app cold at `/run/<eventId>` with one test run whose summary and
 *  tree are given; the fetch stub answers the suites-first wire. */
async function mountRun(eventId: string, summary: Summary, tree: SuiteFixture[]): Promise<void> {
  const now = Date.now();
  const projectKey = `proj-${eventId}`;
  const head = {
    id: eventId,
    projectKey,
    agentId: "jump-agent",
    kind: "test" as const,
    tier: "unit",
    codec: "junit",
    timestamp: now,
    summary,
  };
  const brief = {
    id: eventId,
    projectKey,
    agentId: "jump-agent",
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp: now,
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    pending: summary.pending,
    duration_ms: summary.duration_ms,
    hasCoverage: false,
  };

  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost/run/${eventId}` });
  document.body.innerHTML = '<div id="app"></div>';
  fetchLog = [];

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    fetchLog.push(url);
    let body: unknown;
    const eventMatch = /\/api\/v2\/events\/([^/?]+)/.exec(url);
    const isListEndpoint = url.includes("/api/v2/events?") || url.endsWith("/api/v2/events");
    if (eventMatch !== null && !isListEndpoint) {
      const id = decodeURIComponent(eventMatch[1]!);
      if (id !== eventId) throw new Error(`failure-jump.test.ts: no fixture for event ${id} (url ${url})`);
      const parsed = new URL(url, "http://localhost");
      const suiteParam = parsed.searchParams.get("suite");
      const depthParam = parsed.searchParams.get("depth");
      if (suiteParam !== null) {
        const match = tree.find((n) => n.name === suiteParam);
        body = { ok: true, event: { ...head, tree: match !== undefined ? [match] : [] } };
      } else if (depthParam === "suites") {
        const suites = tree.map((n) => ({ name: n.name, status: n.status, counts: suiteCounts(n.children) }));
        body = { ok: true, event: { ...head, tree: suites } };
      } else {
        body = { ok: true, event: { ...head, tree } };
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
      throw new Error(`failure-jump.test.ts: unexpected fetch url ${url}`);
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);
  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?failure-jump=${cacheBust}`);
  (0, eval)(APP_JS_SRC);
  await settle();
}

async function settle(ticks = 12): Promise<void> {
  await settleDom({ ticks });
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

function overlay(): Element {
  const el = document.querySelector('[data-testid="run-overlay"]');
  expect(el).not.toBeNull();
  return el!;
}

/** Every rendered copy of the jump (the visible band and the overlay's
 *  compat head share one body state) — they must all read the same. */
function jumpLabels(): string[] {
  return [...new Set(Array.from(document.querySelectorAll('[data-testid="failure-jump"]')).map((el) => (el.textContent ?? "").trim()))];
}

async function pressJump(): Promise<void> {
  const jump = document.querySelector('[data-testid="failure-jump"]') as HTMLElement | null;
  expect(jump).not.toBeNull();
  jump!.click();
  await settle();
}

/** The leaf keys whose failure box is open, in DOM order. */
function openBoxKeys(): Array<string | null> {
  return Array.from(overlay().querySelectorAll('[data-testid="failure-box"]')).map(
    (box) => box.previousElementSibling?.getAttribute("data-leaf-key") ?? null,
  );
}

const fail = (name: string): LeafFixture => ({ name, status: "fail", duration_ms: 5, failure: { message: `boom ${name}` } });
const pass = (name: string): LeafFixture => ({ name, status: "pass", duration_ms: 5 });

/** Three failing leaves across two failing suites, an all-pass suite between
 *  them: walk order is SuiteAlpha::f1, SuiteAlpha::f2, SuiteGamma::f3. */
const THREE_FAILURE_TREE: SuiteFixture[] = [
  { name: "SuiteAlpha", status: "fail", children: [fail("f1"), pass("okA"), fail("f2")] },
  { name: "SuiteBeta", status: "pass", children: [pass("okB")] },
  { name: "SuiteGamma", status: "fail", children: [fail("f3")] },
];
const THREE_FAILURE_SUMMARY: Summary = { total: 5, passed: 2, failed: 3, pending: 0, duration_ms: 25 };
const F1 = "SuiteAlpha::f1";
const F2 = "SuiteAlpha::f2";
const F3 = "SuiteGamma::f3";

const ONE_FAILURE_TREE: SuiteFixture[] = [{ name: "SuiteSolo", status: "fail", children: [pass("okS"), fail("only")] }];
const ONE_FAILURE_SUMMARY: Summary = { total: 2, passed: 1, failed: 1, pending: 0, duration_ms: 10 };

describe("failure jump — the label before any press counts every failure", () => {
  test("a run with three failures reads '▸ 3 more failures' and opens with no failure box and no suite fetched", async () => {
    await mountRun("evt-jump-three-before", THREE_FAILURE_SUMMARY, THREE_FAILURE_TREE);
    expect(jumpLabels()).toEqual(["▸ 3 more failures"]);
    expect(openBoxKeys()).toEqual([]);
    expect(fetchLog.some((u) => u.includes("suite="))).toBe(false);
  });

  test("a run with one failure reads the singular '▸ 1 more failure' and opens with no failure box", async () => {
    await mountRun("evt-jump-one-before", ONE_FAILURE_SUMMARY, ONE_FAILURE_TREE);
    expect(jumpLabels()).toEqual(["▸ 1 more failure"]);
    expect(openBoxKeys()).toEqual([]);
  });
});

describe("failure jump — each press opens the next failure from the first and the count drops", () => {
  test("the first two presses open f1 then f2, reading '▸ 2 more failures' then '▸ 1 more failure', one box open each time", async () => {
    await mountRun("evt-jump-three-walk", THREE_FAILURE_SUMMARY, THREE_FAILURE_TREE);

    await pressJump();
    // The first press loads the failing suites (never the all-pass one).
    expect(fetchLog.some((u) => u.includes("suite=SuiteAlpha"))).toBe(true);
    expect(fetchLog.some((u) => u.includes("suite=SuiteGamma"))).toBe(true);
    expect(fetchLog.some((u) => u.includes("suite=SuiteBeta"))).toBe(false);
    expect(openBoxKeys()).toEqual([F1]);
    expect(jumpLabels()).toEqual(["▸ 2 more failures"]);

    await pressJump();
    expect(openBoxKeys()).toEqual([F2]);
    expect(jumpLabels()).toEqual(["▸ 1 more failure"]);
  });
});

describe("failure jump — once every failure is opened the walk keeps cycling and names its place", () => {
  test("presses three to five open f3, f1, f2 and read 'failure 3 of 3', 'failure 1 of 3', 'failure 2 of 3'", async () => {
    await mountRun("evt-jump-three-cycle", THREE_FAILURE_SUMMARY, THREE_FAILURE_TREE);
    await pressJump();
    await pressJump();

    await pressJump();
    expect(openBoxKeys()).toEqual([F3]);
    expect(jumpLabels()).toEqual(["▸ failure 3 of 3"]);

    await pressJump();
    expect(openBoxKeys()).toEqual([F1]);
    expect(jumpLabels()).toEqual(["▸ failure 1 of 3"]);

    await pressJump();
    expect(openBoxKeys()).toEqual([F2]);
    expect(jumpLabels()).toEqual(["▸ failure 2 of 3"]);
  });

  test("a one-failure run's first press opens its box and reads '▸ failure 1 of 1'; a second press keeps both", async () => {
    await mountRun("evt-jump-one-cycle", ONE_FAILURE_SUMMARY, ONE_FAILURE_TREE);

    await pressJump();
    expect(openBoxKeys()).toEqual(["SuiteSolo::only"]);
    expect(jumpLabels()).toEqual(["▸ failure 1 of 1"]);

    await pressJump();
    expect(openBoxKeys()).toEqual(["SuiteSolo::only"]);
    expect(jumpLabels()).toEqual(["▸ failure 1 of 1"]);
  });
});

describe("failure jump — N is the failed count until the walk has loaded, then the walk's own leaves", () => {
  test("a run whose failed count (3) exceeds its tree's failing leaves (2) reads '3 more failures', then '1 more failure', then 'failure 2 of 2'", async () => {
    const tree: SuiteFixture[] = [
      { name: "SuiteShort", status: "fail", children: [fail("s1"), pass("okShort")] },
      { name: "SuiteShortToo", status: "fail", children: [fail("s2")] },
    ];
    const summary: Summary = { total: 4, passed: 1, failed: 3, pending: 0, duration_ms: 20 };
    await mountRun("evt-jump-count-mismatch", summary, tree);
    expect(jumpLabels()).toEqual(["▸ 3 more failures"]);

    await pressJump();
    expect(openBoxKeys()).toEqual(["SuiteShort::s1"]);
    expect(jumpLabels()).toEqual(["▸ 1 more failure"]);

    await pressJump();
    expect(openBoxKeys()).toEqual(["SuiteShortToo::s2"]);
    expect(jumpLabels()).toEqual(["▸ failure 2 of 2"]);
  });
});

describe("failure jump — opening a failure by clicking its row moves neither the label nor the walk", () => {
  test("after the first press, clicking f3's row opens f3 but leaves '▸ 2 more failures'; the next press opens f2, the one after f1", async () => {
    await mountRun("evt-jump-row-click", THREE_FAILURE_SUMMARY, THREE_FAILURE_TREE);
    await pressJump();
    expect(openBoxKeys()).toEqual([F1]);
    expect(jumpLabels()).toEqual(["▸ 2 more failures"]);

    const f3Row = overlay().querySelector(`[data-leaf-key="${F3}"]`) as HTMLElement | null;
    expect(f3Row).not.toBeNull();
    f3Row!.click();
    await settle();
    // The row click opened f3 (the one-box focus model) ...
    expect(openBoxKeys()).toEqual([F3]);
    // ... and the label still speaks for the jump alone.
    expect(jumpLabels()).toEqual(["▸ 2 more failures"]);

    await pressJump();
    expect(openBoxKeys()).toEqual([F2]);
    expect(jumpLabels()).toEqual(["▸ 1 more failure"]);
  });
});
