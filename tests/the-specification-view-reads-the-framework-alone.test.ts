// The specification view is decided by the run's framework alone: a test run
// of framework `playwright-bdd` opens as feature → scenario → step, whatever
// codec filed it, and a run of any other framework (or none) opens as the
// plain test tree, a run still recorded under codec `playwright` included.
//
// What this file proves:
//   - the run-detail view, mounted against a real board, draws a run the v25
//     migration moved off the retired codec (codec `playwright`, framework
//     `playwright-bdd`) as its feature, its scenarios and their steps, and a
//     codec-`playwright` run that states no framework as the plain tree;
//   - the BDD index (`bddIndexRows`, public/app-logic.mjs) lists by the
//     framework alone, and neither it nor `isSpecRun` (public/app.js) reads
//     the run's codec;
//   - the codec-shape symbols are gone: `isScenarioShape` and `BDD_SEP` from
//     public/app.js, `featureOf` and `FEATURE_SEPARATOR` from src/;
//   - a stored suite's `feature` is its whole name for a `playwright-bdd` run
//     and NULL for every other run, a junit suite named `A › B` included,
//     each run filed through the board's own write path;
//   - the heat strip of a scenario-shape run: a loaded scenario's cell, a red
//     synthetic cell and a green synthetic cell each blink a scenario row —
//     the red one the suite's first failing scenario, the green one its first
//     scenario.
//
// HARNESS — a real board (`startServer` through `bootOn`, port 0) and the
// production shell mounted against it in happy-dom (tests/helpers/served-app.ts).
// A run is filed through the stream routes, the junit route, or the store's own
// `recordTestEvent` where the shape it needs can no longer be posted (a run
// recorded under codec `playwright`). The migrated run is a v24 store file
// walked back the way the migration's own tests walk one back, reopened by the
// board, which migrates it.
//
// SAFETY: every server binds port 0, on ":memory:" or on a file under a fresh
// OS tmpdir removed after each test.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";
import type { ServerHandle } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { SuiteNode } from "../src/types.ts";
import {
  bddProject,
  failingStep,
  featureOf,
  heatCellsOf,
  interceptScrollIntoView,
  overlay,
  passingStep,
  scenarioRow,
  scenarioRowsOf,
  streamBddRun,
  waitUntil,
  type BddScenario,
} from "./helpers/playwright-bdd-run.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  getJson,
  openRun,
  postJson,
  readyProject,
  sendBatch,
} from "./helpers/run-stream-harness.ts";
import { mountServedApp, restoreRealFetch, settleServedApp } from "./helpers/served-app.ts";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCATE_BLINK = "app-locate-blink";
const AGENT = "spec-view-framework-runner";

const handles: ServerHandle[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  await restoreRealFetch();
  while (handles.length > 0) handles.pop()?.stop();
  while (scratchDirs.length > 0) fs.rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
});

function boot(dbPath = ":memory:"): ServerHandle {
  const handle = bootOn(dbPath);
  handles.push(handle);
  return handle;
}

function dbOf(store: Store): Database {
  return (store as unknown as { db: Database }).db;
}

// ── the codec's shape: a suite per scenario named "<feature> › <scenario>",
// its steps stored as the suite's cases ───────────────────────────────────

/** A codec run of two scenarios of one feature in one browser: one passing with two steps, one failing at its second of three. */
const CODEC_SHAPE_TREE: SuiteNode[] = [
  {
    name: "Checkout › Pay by card",
    status: "pass",
    browser: "chromium",
    children: [
      { name: "Given a cart", status: "pass", duration_ms: 3 },
      { name: "When I pay by card", status: "pass", duration_ms: 4 },
    ],
  },
  {
    name: "Checkout › Pay by voucher",
    status: "fail",
    browser: "chromium",
    children: [
      { name: "Given a voucher", status: "pass", duration_ms: 2 },
      {
        name: "When I redeem it",
        status: "fail",
        duration_ms: 6,
        failure: { message: "voucher expired", type: "AssertionError", trace: "at redeem (step 2)" },
      },
      { name: "Then I see the receipt", status: "pending", duration_ms: 0 },
    ],
  },
];
/** What the codec counted for it: over its five steps. */
const CODEC_SHAPE_SUMMARY = { total: 5, passed: 3, failed: 1, pending: 1, duration_ms: 20 };

/**
 * A board on a store the v25 migration has just opened: a v24 file holding one
 * run the retired codec filed (codec `playwright`, no framework, the codec's
 * shape), reopened by the board. Answers the board, the project and the run.
 */
function migratedBoard(): { handle: ServerHandle; key: string; eventId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-spec-view-framework-"));
  scratchDirs.push(dir);
  const dbPath = path.join(dir, "crucible.db");

  const store = Store.open(dbPath);
  const key = crypto.randomUUID();
  store.addProject({ key, name: "migrated-spec-view", type: "frontend", sutRoot: "/tmp/migrated-spec-view" });
  const eventId = store.recordTestEvent(
    key,
    AGENT,
    { summary: CODEC_SHAPE_SUMMARY, tree: CODEC_SHAPE_TREE },
    { tier: "e2e", stack: "bun", codec: "playwright" },
  ).id;
  dbOf(store).close();

  const raw = new Database(dbPath);
  try {
    raw.exec("PRAGMA journal_mode = DELETE;");
    raw.exec("PRAGMA user_version = 24");
  } finally {
    raw.close();
  }
  return { handle: boot(dbPath), key, eventId };
}

function featureGroups(): HTMLElement[] {
  return Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="feature-group"]'));
}

/** The step rows (`leaf-row`s) drawn inside a feature group. */
function stepRowsOf(feature: string): string[] {
  return Array.from(featureOf(feature).querySelectorAll<HTMLElement>('[data-testid="leaf-row"]')).map((r) =>
    (r.textContent ?? "").trim(),
  );
}

describe("the run-detail view opens a run as a specification by its framework alone", () => {
  test("a run the migration moved off the playwright codec opens as feature, scenarios and steps", async () => {
    const { handle, key, eventId } = migratedBoard();

    // PRECONDITION — the board serves the migrated run: still codec
    // `playwright`, now framework `playwright-bdd`, one suite per feature.
    const served = (await getJson(handle, `/api/v2/events/${eventId}?depth=suites`)).event as Record<string, unknown>;
    expect(served.codec).toBe("playwright");
    expect(served.framework).toBe("playwright-bdd");
    expect((served.tree as Array<{ name: string }>).map((s) => s.name)).toEqual(["Checkout"]);

    await mountServedApp(handle, `/p/${key}/run/${eventId}`);

    // POSITIVE — one feature, named by the suite, holding both scenarios.
    expect(featureGroups().map((g) => g.getAttribute("data-feature-name"))).toEqual(["Checkout"]);
    const card = scenarioRow("Checkout", "Pay by card");
    const voucher = scenarioRow("Checkout", "Pay by voucher");
    // Each scenario row is a leaf-keyed row of the feature's suite.
    expect(card.getAttribute("data-leaf-key")).toBe(`${card.getAttribute("data-suite-key")}::Pay by card`);
    expect(voucher.getAttribute("data-leaf-key")).toBe(`${voucher.getAttribute("data-suite-key")}::Pay by voucher`);
    // BOUND — exactly the two scenarios, never a row per step.
    expect(scenarioRowsOf("Checkout").length).toBe(2);
    // The steps are drawn under their scenarios, all five of them.
    const steps = stepRowsOf("Checkout");
    expect(steps.length).toBe(5);
    for (const step of ["Given a cart", "When I pay by card", "Given a voucher", "When I redeem it", "Then I see the receipt"]) {
      expect(steps.filter((s) => s.includes(step)).length, `step row "${step}"`).toBe(1);
    }
    // The spec view's byline is drawn.
    expect(overlay().querySelector('[data-testid="run-byline"]')).not.toBeNull();
  });

  test("a test run recorded under codec playwright that states no framework opens as the plain test tree", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "codec-no-framework");
    const eventId = handle.store.recordTestEvent(
      key,
      AGENT,
      {
        summary: CODEC_SHAPE_SUMMARY,
        tree: CODEC_SHAPE_TREE.map((s) => ({ ...s, browser: undefined })) as SuiteNode[],
      },
      { tier: "e2e", stack: "bun", codec: "playwright" },
    ).id;

    await mountServedApp(handle, `/p/${key}/run/${eventId}`);

    // NEGATIVE — no feature group and no spec byline: it is no specification.
    expect(featureGroups().length).toBe(0);
    expect(overlay().querySelector('[data-testid="run-byline"]')).toBeNull();
    // POSITIVE — each stored suite is drawn as a plain suite row, under its
    // whole name, in stored order.
    const suiteKeys = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).map((r) =>
      r.getAttribute("data-suite-key"),
    );
    expect(suiteKeys).toEqual(["Checkout › Pay by card", "Checkout › Pay by voucher"]);
  });

  test("a streamed run of framework vitest opens as the plain test tree", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "vitest-plain-tree");
    const runId = await openRun(handle, key, AGENT, { tier: "e2e", stack: "bun", framework: "vitest" });
    const text =
      eventLine({ event: "run-start", total: 1 }) +
      eventLine({ event: "test-end", id: "adds", name: "adds", suite: "Arithmetic › integers", file: "math.test.ts", status: "pass", duration_ms: 1 }) +
      eventLine({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 });
    expect((await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text })).status).toBe(200);
    const closed = await closeStream(handle, key, AGENT, runId);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    await mountServedApp(handle, `/p/${key}/run/${closed.body.event as string}`);

    expect(featureGroups().length).toBe(0);
    expect(overlay().querySelector('[data-testid="run-byline"]')).toBeNull();
    const suiteKeys = Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).map((r) =>
      r.getAttribute("data-suite-key"),
    );
    expect(suiteKeys).toEqual(["Arithmetic › integers"]);
  });
});

// ── the BDD index ─────────────────────────────────────────────────────────

interface IndexRow {
  id: string;
}

// `bddIndexRows` is exported by public/app-logic.mjs but not declared in its
// .d.mts; the cast states the shape this file reads.
const { bddIndexRows } = AppLogic as unknown as { bddIndexRows: (events: unknown[]) => IndexRow[] };

function brief(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    projectKey: "proj-bdd-index-framework-alone",
    agentId: "index-runner",
    kind: "test",
    total: 2,
    passed: 2,
    failed: 0,
    pending: 0,
    duration_ms: 10,
    hasCoverage: false,
    ...fields,
  };
}

describe("the BDD index lists a run by its framework alone", () => {
  test("a migrated run and a streamed playwright-bdd run are listed; a codec-playwright run that states no framework is not", () => {
    const rows = bddIndexRows([
      brief({ id: "evt-migrated", codec: "playwright", framework: "playwright-bdd", timestamp: 2_000 }),
      brief({ id: "evt-codec-no-framework", codec: "playwright", timestamp: 4_000 }),
      brief({ id: "evt-streamed", codec: "crucible-events", framework: "playwright-bdd", timestamp: 3_000 }),
      brief({ id: "evt-codec-junit-framework", codec: "playwright", framework: "bun-test", timestamp: 5_000 }),
    ]);
    // POSITIVE — newest first, the two playwright-bdd runs alone.
    expect(rows.map((r) => r.id)).toEqual(["evt-streamed", "evt-migrated"]);
  });
});

// ── the codec's symbols and readings are gone ─────────────────────────────

/** `src` with its comments removed, so a symbol named only in prose is not counted. */
function codeOf(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(rel));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

describe("the codec-shape symbols do not exist", () => {
  test("public/app.js names neither isScenarioShape nor BDD_SEP", () => {
    const code = codeOf(readRepo("public/app.js"));
    const named = ["isScenarioShape", "BDD_SEP"].filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(code));
    expect(named).toEqual([]);
  });

  test("no file under src/ names featureOf or FEATURE_SEPARATOR", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder("src")) {
      const code = codeOf(readRepo(file));
      for (const symbol of ["featureOf", "FEATURE_SEPARATOR"]) {
        if (new RegExp(`\\b${symbol}\\b`).test(code)) offenders.push(`${file}: ${symbol}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("isSpecRun decides by the framework playwright-bdd and reads no codec", () => {
    const code = codeOf(readRepo("public/app.js"));
    const match = /(?:const|let|function)\s+isSpecRun\b[\s\S]*?(?:;\s*\n|\n\s*}\s*\n)/.exec(code);
    expect(match, "public/app.js defines isSpecRun").not.toBeNull();
    const definition = match?.[0] ?? "";
    expect(definition).toContain('"playwright-bdd"');
    expect(definition).not.toMatch(/\bcodec\b/);
  });

  test("bddIndexRows reads no codec", () => {
    const code = codeOf(readRepo("public/app-logic.mjs"));
    const match = /export function bddIndexRows\([\s\S]*?\n}\n/.exec(code);
    expect(match, "public/app-logic.mjs defines bddIndexRows").not.toBeNull();
    expect(match?.[0] ?? "").not.toMatch(/\bcodec\b/);
  });
});

// ── a stored suite's `feature` at ingest ──────────────────────────────────

interface FeatureRow {
  name: string;
  feature: string | null;
}

function featuresOf(handle: ServerHandle, eventId: string): FeatureRow[] {
  return dbOf(handle.store)
    .query<FeatureRow, [string]>("SELECT name, feature FROM run_suites WHERE event_id = ? ORDER BY position")
    .all(eventId);
}

async function streamed(handle: ServerHandle, key: string, framework: string, text: string): Promise<string> {
  const runId = await openRun(handle, key, AGENT, { tier: "e2e", stack: "bun", framework });
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: text });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const closed = await closeStream(handle, key, AGENT, runId);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  return closed.body.event as string;
}

describe("a stored suite's feature is its name for a playwright-bdd run and NULL for any other", () => {
  test("a junit suite named A › B is stored with feature NULL", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "junit-feature-null");
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<testsuites tests="2" failures="1"><testsuite name="A › B" tests="2" failures="1">' +
      '<testcase name="adds" classname="A › B" time="0.005"/>' +
      '<testcase name="subtracts" classname="A › B" time="0.002"><failure message="2 - 1 is not 0" type="AssertionError"/></testcase>' +
      "</testsuite></testsuites>\n";
    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId: AGENT,
      codec: "junit",
      data: xml,
      tier: "unit",
      stack: "bun",
      framework: "bun-test",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(featuresOf(handle, res.body.event as string)).toEqual([{ name: "A › B", feature: null }]);
  });

  test("a streamed suite of framework vitest named Arithmetic › integers is stored with feature NULL", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT], "vitest-feature-null");
    const eventId = await streamed(
      handle,
      key,
      "vitest",
      eventLine({ event: "run-start", total: 1 }) +
        eventLine({ event: "test-end", id: "adds", name: "adds", suite: "Arithmetic › integers", file: "math.test.ts", status: "pass", duration_ms: 1 }) +
        eventLine({ event: "run-end", total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 }),
    );

    expect(featuresOf(handle, eventId)).toEqual([{ name: "Arithmetic › integers", feature: null }]);
  });

  test("a run recorded under codec playwright that states no framework stores each suite with feature NULL", () => {
    const handle = boot();
    const key = crypto.randomUUID();
    handle.store.addProject({ key, name: "codec-feature-null", type: "frontend", sutRoot: "/tmp/codec-feature-null" });
    const eventId = handle.store.recordTestEvent(
      key,
      AGENT,
      { summary: CODEC_SHAPE_SUMMARY, tree: CODEC_SHAPE_TREE },
      { tier: "e2e", stack: "bun", codec: "playwright" },
    ).id;

    expect(featuresOf(handle, eventId)).toEqual([
      { name: "Checkout › Pay by card", feature: null },
      { name: "Checkout › Pay by voucher", feature: null },
    ]);
  });

  test("a playwright-bdd feature whose name holds the separator is stored with its whole name as its feature", async () => {
    const handle = boot();
    const key = await bddProject(handle, "bdd-feature-whole-name");
    const eventId = await streamBddRun(
      handle,
      key,
      [
        { feature: "Checkout › Payments", browser: "chromium", name: "Pay by card", status: "pass", steps: [passingStep("Given a cart")] },
        { feature: "Search", browser: "chromium", name: "Find a book", status: "pass", steps: [passingStep("Given the catalogue")] },
      ],
      "e2e",
    );

    expect(featuresOf(handle, eventId)).toEqual([
      { name: "Checkout › Payments", feature: "Checkout › Payments" },
      { name: "Search", feature: "Search" },
    ]);
  });
});

// ── the heat strip of a scenario-shape run ────────────────────────────────

/** Three all-green features of two scenarios each: the first two open on mount, the third stays folded and unread. */
function threeGreenFeatures(): BddScenario[] {
  const scenario = (feature: string, name: string): BddScenario => ({
    feature,
    browser: "chromium",
    name,
    status: "pass",
    steps: [passingStep(`Given ${name.toLowerCase()} begins`), passingStep(`Then ${name.toLowerCase()} ends`)],
  });
  return [
    scenario("Alpha", "Alpha opens the catalogue"),
    scenario("Alpha", "Alpha closes the catalogue"),
    scenario("Beta", "Beta weighs the parcel"),
    scenario("Beta", "Beta labels the parcel"),
    scenario("Gamma", "Gamma lists the shelves"),
    scenario("Gamma", "Gamma sorts the shelves"),
  ];
}

/** A green feature, then a failing one whose first scenario passes and next two fail. */
function failingSecondFeature(): BddScenario[] {
  return [
    { feature: "Alpha", browser: "chromium", name: "Alpha opens the catalogue", status: "pass", steps: [passingStep("Given a catalogue")] },
    { feature: "Beta", browser: "chromium", name: "Beta settles the bill", status: "pass", steps: [passingStep("Given a bill")] },
    {
      feature: "Beta",
      browser: "chromium",
      name: "Beta refunds the card",
      status: "fail",
      steps: [passingStep("Given a paid order"), failingStep("When I refund it", "refund refused")],
      failure: { message: "refund refused" },
    },
    {
      feature: "Beta",
      browser: "chromium",
      name: "Beta voids the order",
      status: "fail",
      steps: [failingStep("Given an open order", "order locked")],
      failure: { message: "order locked" },
    },
  ];
}

/** The synthetic heat cells of the not-yet-loaded suite of `feature`, of `status`: titled by the suite alone. */
function syntheticCellsOf(feature: string, status: "fail" | "pass"): HTMLElement[] {
  return Array.from(overlay().querySelectorAll<HTMLElement>(`[data-testid="heat-cell"].app-heat-${status}`)).filter(
    (cell) => {
      const title = cell.getAttribute("title") ?? "";
      return title.startsWith(feature) && !title.includes(" › ");
    },
  );
}

/** The scenario row, or null while it is not mounted. */
function rowOrNull(feature: string, name: string): HTMLElement | null {
  try {
    return scenarioRow(feature, name);
  } catch {
    return null;
  }
}

function blinking(): HTMLElement[] {
  return Array.from(overlay().querySelectorAll<HTMLElement>(`.${LOCATE_BLINK}`));
}

describe("the heat strip of a scenario-shape run locates a scenario row", () => {
  test("a loaded scenario's passing heat cell blinks that scenario's row and scrolls to it", async () => {
    const handle = boot();
    const key = await bddProject(handle, "scenario-cell-reveal");
    const eventId = await streamBddRun(handle, key, threeGreenFeatures(), "e2e");
    await mountServedApp(handle, `/p/${key}/run/${eventId}`);

    const cells = heatCellsOf("Alpha closes the catalogue", "pass");
    expect(cells.length).toBe(1);
    const scroll = interceptScrollIntoView();
    try {
      cells[0]?.click();
      await settleServedApp();
      const row = (): HTMLElement | null => rowOrNull("Alpha", "Alpha closes the catalogue");
      await waitUntil(() => row()?.classList.contains(LOCATE_BLINK) === true);

      expect(row()?.classList.contains(LOCATE_BLINK)).toBe(true);
      expect(scroll.calls).toContain(row() as HTMLElement);
      // BOUND — that one row alone is located.
      expect(blinking()).toEqual([row() as HTMLElement]);
    } finally {
      scroll.restore();
    }
  });

  test("a green synthetic cell of a folded feature not yet loaded unfolds it, loads it and blinks its first scenario's row", async () => {
    const handle = boot();
    const key = await bddProject(handle, "green-synthetic-reveal");
    const eventId = await streamBddRun(handle, key, threeGreenFeatures(), "e2e");
    await mountServedApp(handle, `/p/${key}/run/${eventId}`);

    // PRECONDITION — Gamma is folded and unread: its two cells are synthetic.
    expect(scenarioRowsOf("Gamma").length).toBe(0);
    const cells = syntheticCellsOf("Gamma", "pass");
    expect(cells.length).toBe(2);

    const scroll = interceptScrollIntoView();
    try {
      cells[1]?.click();
      await settleServedApp();
      const first = (): HTMLElement | null => rowOrNull("Gamma", "Gamma lists the shelves");
      await waitUntil(() => first()?.classList.contains(LOCATE_BLINK) === true);

      // POSITIVE — the feature opened onto its scenarios, and its first
      // scenario's row is the one located, blinking and scrolled to.
      expect(scenarioRowsOf("Gamma").length).toBe(2);
      expect(first()?.classList.contains(LOCATE_BLINK)).toBe(true);
      expect(scroll.calls).toContain(first() as HTMLElement);
      // NEGATIVE — its second scenario is not located; BOUND — nothing else is.
      expect(rowOrNull("Gamma", "Gamma sorts the shelves")?.classList.contains(LOCATE_BLINK)).toBe(false);
      expect(blinking()).toEqual([first() as HTMLElement]);
    } finally {
      scroll.restore();
    }
  });

  test("a red synthetic cell of a suite still loading blinks its first failing scenario's row", async () => {
    const handle = boot();
    const key = await bddProject(handle, "red-synthetic-reveal");
    const eventId = await streamBddRun(handle, key, failingSecondFeature(), "e2e");

    // Mount on the project, then hold the first read of Beta's suite, so its
    // cells are still synthetic when the run detail opens.
    await mountServedApp(handle, `/p/${key}`);
    const served = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldOnce = false;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String((input as { url?: unknown }).url ?? input);
      if (!heldOnce && url.includes("?suite=Beta")) {
        heldOnce = true;
        await held;
      }
      return served(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;

    const scroll = interceptScrollIntoView();
    try {
      history.pushState(null, "", `/p/${key}/run/${eventId}`);
      window.dispatchEvent(new Event("popstate"));
      await settleServedApp();

      // PRECONDITION — Beta's read is held: its two failing cells are synthetic.
      expect(heldOnce).toBe(true);
      const cells = syntheticCellsOf("Beta", "fail");
      expect(cells.length).toBe(2);

      cells[1]?.click();
      await settleServedApp();
      const refund = (): HTMLElement | null => rowOrNull("Beta", "Beta refunds the card");
      await waitUntil(() => refund()?.classList.contains(LOCATE_BLINK) === true);

      // POSITIVE — the first failing scenario, in the suite's order.
      expect(refund()?.classList.contains(LOCATE_BLINK)).toBe(true);
      expect(scroll.calls).toContain(refund() as HTMLElement);
      // NEGATIVE — neither the other failing scenario nor the passing one.
      expect(rowOrNull("Beta", "Beta voids the order")?.classList.contains(LOCATE_BLINK)).toBe(false);
      expect(rowOrNull("Beta", "Beta settles the bill")?.classList.contains(LOCATE_BLINK)).toBe(false);
      expect(blinking()).toEqual([refund() as HTMLElement]);
    } finally {
      release();
      scroll.restore();
    }
  });
});
