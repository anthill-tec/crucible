// A `playwright-bdd` run opens as a SPECIFICATION — feature → scenario → step —
// from the shape the board stores for it: one suite per feature and browser,
// one test per scenario, and the scenario's Gherkin steps in `TestLeaf.steps`.
//
// HARNESS — a real board (`startServer`, port 0, ":memory:") holding stored
// runs, and the production shell mounted against it in happy-dom
// (tests/helpers/served-app.ts): the new-shape run is streamed in
// `crucible-events` and closed over HTTP exactly as the bun client streams a
// `playwright-bdd` target; the old-shape run is ingested through the
// `playwright` codec from a real Playwright JSON report. Every read the view
// makes is answered by that server, so the view draws what the store serves.
//
// What this file pins (the loading the design states):
//   - the run detail's first read is `?depth=suites`, and its features are
//     listed from those suites — the suite's own name IS the feature, never
//     split at ` › ` (a nested describe's suite keeps its whole name);
//   - opening a feature reads `?suite=<feature>&browser=<b>` — one read per
//     browser the feature ran under — and shows its scenarios with their steps;
//   - failing features open first, then the first SPEC_FIRST_OPEN (2)
//     features; every other feature stays folded and unread until opened;
//   - a feature run in two projects shows ONCE, as one feature, with each
//     scenario row naming its browser;
//   - a scenario that failed with no failing step (a Before hook) shows its
//     failure on the scenario row;
//   - a run the `playwright` codec stored still opens exactly as before.
//
// INTERFACE CHOICES (the design names no testids for the new shape; this file
// keeps the ones the old shape's view already draws, so both shapes read the
// same to a user and to every existing test):
//   - a feature is `[data-testid="feature-group"]` with `data-feature-name`
//     set to the suite's name, its fold glyph in `[data-testid="feature-toggle"]`
//     (▾ open / ▸ folded), and its heading `[data-testid="feature-heading"]`
//     toggling it; its `data-feature-passed` / `data-feature-failed` count its
//     scenarios across every browser;
//   - a scenario is a `[data-testid="suite-row"]` inside its feature, its text
//     naming the scenario and its browser; its steps are the
//     `[data-testid="leaf-row"]`s of the same group (the row's parent), in step
//     order, a step's status on its row's class — every scenario of an open
//     feature shows its steps, since the feature's read answers them all;
//   - a scenario's own failure with no failing step is a
//     `[data-testid="failure-box"]` in the scenario's group and outside every
//     step row;
//   - the first-open rule over features: every failing feature opens (in report
//     order), then the first SPEC_FIRST_OPEN features in that failures-first
//     order; the bounds below hold under either reading of "then" (the first two
//     of all features, or the first two after the failing ones).
//
// SAFETY: every server binds port 0 on ":memory:".
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import {
  bootOn,
  closeStream,
  eventLine,
  openRun,
  postJson,
  register,
  sendBatch,
} from "./helpers/run-stream-harness.ts";
import { mountServedApp, restoreRealFetch, servedFetchLog, settleServedApp } from "./helpers/served-app.ts";

const handles: ServerHandle[] = [];

afterEach(async () => {
  await restoreRealFetch();
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "spec-view-runner";

async function frontendProject(handle: ServerHandle, name: string): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name, type: "frontend", sutRoot: `/tmp/${name}` });
  await register(handle, key, AGENT);
  return key;
}

// ── The new shape: a streamed playwright-bdd run ───────────────────────────

interface StepFields {
  name: string;
  status: "pass" | "fail";
  duration_ms: number;
  failure?: { message: string; trace?: string };
}

const pass = (name: string): StepFields => ({ name, status: "pass", duration_ms: 5 });

interface ScenarioFields {
  feature: string;
  browser: string;
  name: string;
  status: "pass" | "fail";
  steps: StepFields[];
  failure?: { message: string; trace?: string };
}

function scenarioLine(s: ScenarioFields, index: number): string {
  return eventLine({
    event: "test-end",
    id: `scenario-${index}-${s.browser}`,
    name: s.name,
    suite: s.feature,
    file: `features/${s.feature.toLowerCase().replace(/[^a-z]+/g, "-")}.feature`,
    browser: s.browser,
    status: s.status,
    duration_ms: 20,
    steps: s.steps,
    ...(s.failure !== undefined ? { failure: s.failure } : {}),
  });
}

function streamOf(scenarios: ScenarioFields[]): string {
  const failed = scenarios.filter((s) => s.status === "fail").length;
  return (
    eventLine({ event: "run-start", total: scenarios.length }) +
    scenarios.map(scenarioLine).join("") +
    eventLine({
      event: "run-end",
      total: scenarios.length,
      passed: scenarios.length - failed,
      failed,
      pending: 0,
      duration_ms: 20 * scenarios.length,
    })
  );
}

/** Opens, streams and closes a playwright-bdd run over HTTP; answers the event it stored. */
async function streamBddRun(handle: ServerHandle, key: string, scenarios: ScenarioFields[]): Promise<string> {
  const runId = await openRun(handle, key, AGENT, { tier: "e2e", stack: "bun", framework: "playwright-bdd" });
  const batch = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: streamOf(scenarios) });
  expect(batch.status, JSON.stringify(batch.body)).toBe(200);
  const closed = await closeStream(handle, key, AGENT, runId);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  expect(typeof closed.body.event).toBe("string");
  return closed.body.event as string;
}

const SETTINGS = "Account › Settings";
const RECEIPT_MISSING = "receipt missing";
const BEFORE_HOOK_FAILURE = "Before hook failed: seed data missing";

const CARD_STEPS = ["Given a cart holding one book", "When I pay by card", "Then I see a receipt"];
const REVIEW_STEPS = ["Given a book I bought", "When I write a review", "Then it shows under the book"];
const SETTINGS_STEPS = ["Given I am signed in", "When I change my password", "Then I can sign in with it"];

/** Five features in report order: three green ones, then Checkout (run in two
 *  projects, failing at a step in firefox), then Search (failing in its Before
 *  hook, no step ran). Failures-first, Checkout and Search lead. */
function mixedRun(): ScenarioFields[] {
  return [
    { feature: SETTINGS, browser: "chromium", name: "Change my password", status: "pass", steps: SETTINGS_STEPS.map(pass) },
    {
      feature: "Wishlist",
      browser: "chromium",
      name: "Save a book for later",
      status: "pass",
      steps: ["Given a book page", "When I save it", "Then it is on my wishlist"].map(pass),
    },
    { feature: "Reviews", browser: "chromium", name: "Write a review", status: "pass", steps: REVIEW_STEPS.map(pass) },
    { feature: "Checkout", browser: "chromium", name: "Pay by card", status: "pass", steps: CARD_STEPS.map(pass) },
    {
      feature: "Checkout",
      browser: "firefox",
      name: "Pay by card",
      status: "fail",
      steps: [
        pass(CARD_STEPS[0]!),
        pass(CARD_STEPS[1]!),
        { name: CARD_STEPS[2]!, status: "fail", duration_ms: 5, failure: { message: RECEIPT_MISSING } },
      ],
      failure: { message: RECEIPT_MISSING },
    },
    {
      feature: "Checkout",
      browser: "chromium",
      name: "Pay by voucher",
      status: "pass",
      steps: ["Given a voucher worth ten", "When I redeem it"].map(pass),
    },
    {
      feature: "Search",
      browser: "chromium",
      name: "Find a book by title",
      status: "fail",
      steps: [],
      failure: { message: BEFORE_HOOK_FAILURE, trace: `Error: ${BEFORE_HOOK_FAILURE}\n    at hooks.ts:4:9` },
    },
  ];
}

/** Four all-green features, one scenario each: only the first-open rule decides what opens. */
function allGreenRun(): ScenarioFields[] {
  return [
    { feature: SETTINGS, browser: "chromium", name: "Change my password", status: "pass", steps: SETTINGS_STEPS.map(pass) },
    { feature: "Wishlist", browser: "chromium", name: "Save a book for later", status: "pass", steps: ["Given a book page", "Then it is on my wishlist"].map(pass) },
    { feature: "Reviews", browser: "chromium", name: "Write a review", status: "pass", steps: REVIEW_STEPS.map(pass) },
    { feature: "Gifts", browser: "chromium", name: "Wrap a gift", status: "pass", steps: ["Given a cart", "Then it is wrapped"].map(pass) },
  ];
}

// ── The old shape: a run the playwright codec stores ──────────────────────

function projectTest(status: string, steps: Array<{ title: string; duration: number; error?: { message: string; stack: string } }>) {
  return {
    timeout: 30000,
    annotations: [],
    expectedStatus: "passed",
    projectId: "chromium",
    projectName: "chromium",
    results: [
      {
        workerIndex: 0,
        parallelIndex: 0,
        status,
        duration: steps.reduce((sum, s) => sum + s.duration, 0),
        retry: 0,
        steps,
        startTime: "2026-11-01T00:00:00.000Z",
        annotations: [],
        attachments: [],
      },
    ],
    status: status === "passed" ? "expected" : "unexpected",
  };
}

const SHELF_FAILURE = "expected the book on the shelf, found none";
const LIBRARY_FILE = "tests/e2e/features/library.feature.spec.js";

/** A real Playwright JSON report: feature Library, a passing and a failing scenario. */
function libraryReport() {
  const spec = (title: string, ok: boolean, test: ReturnType<typeof projectTest>, line: number) => ({
    title,
    ok,
    tags: [],
    tests: [test],
    id: `spec-${line}`,
    file: LIBRARY_FILE,
    line,
    column: 3,
  });
  return {
    config: { version: "1.61.1" },
    suites: [
      {
        title: LIBRARY_FILE,
        file: LIBRARY_FILE,
        column: 0,
        line: 0,
        specs: [],
        suites: [
          {
            title: "Library",
            file: LIBRARY_FILE,
            line: 3,
            column: 6,
            specs: [
              spec("Borrow a book", true, projectTest("passed", [{ title: "Given a library card", duration: 2 }, { title: "When I borrow a book", duration: 2 }]), 6),
              spec(
                "Return a book",
                false,
                projectTest("failed", [
                  { title: "Given a borrowed book", duration: 2 },
                  { title: "Then the book is back on the shelf", duration: 1, error: { message: SHELF_FAILURE, stack: `Error: ${SHELF_FAILURE}\n    at library.spec.ts:9:3` } },
                ]),
                12,
              ),
            ],
          },
        ],
      },
    ],
    errors: [],
    stats: { startTime: "2026-11-01T00:00:00.000Z", duration: 7, expected: 1, skipped: 0, unexpected: 1, flaky: 0 },
  };
}

async function ingestPlaywrightReport(handle: ServerHandle, key: string): Promise<string> {
  const res = await postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId: AGENT,
    codec: "playwright",
    data: JSON.stringify(libraryReport()),
    tier: "e2e",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.event as string;
}

// ── View reading ──────────────────────────────────────────────────────────

function overlay(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-testid="run-overlay"]');
  if (el === null) throw new Error('no [data-testid="run-overlay"] mounted');
  return el;
}

function featureGroups(): HTMLElement[] {
  return Array.from(overlay().querySelectorAll<HTMLElement>('[data-testid="feature-group"]'));
}

function featureNames(): string[] {
  return featureGroups().map((g) => g.getAttribute("data-feature-name") ?? "");
}

function featureOf(title: string): HTMLElement {
  const found = featureGroups().find((g) => g.getAttribute("data-feature-name") === title);
  if (found === undefined) throw new Error(`no feature-group named "${title}"; features present: ${JSON.stringify(featureNames())}`);
  return found;
}

function scenarioRowsOf(title: string): HTMLElement[] {
  return Array.from(featureOf(title).querySelectorAll<HTMLElement>('[data-testid="suite-row"]'));
}

function featureOpen(title: string): boolean {
  const group = featureOf(title);
  return group.querySelector('[data-testid="feature-toggle"]')?.textContent?.trim() === "▾" && scenarioRowsOf(title).length > 0;
}

function featureFolded(title: string): boolean {
  const group = featureOf(title);
  return group.querySelector('[data-testid="feature-toggle"]')?.textContent?.trim() === "▸" && scenarioRowsOf(title).length === 0;
}

/** The scenario row of `name` in `feature` — naming `browser` when one is given (the
 *  design requires the browser on the rows of a feature run in several projects;
 *  a single-project feature's rows are found by name alone, and must be unique). */
function scenarioRow(feature: string, name: string, browser?: string): HTMLElement {
  const rows = scenarioRowsOf(feature);
  const matching = rows.filter(
    (r) => (r.textContent ?? "").includes(name) && (browser === undefined || (r.textContent ?? "").includes(browser)),
  );
  if (matching.length !== 1) {
    throw new Error(
      `expected one scenario row "${name}"${browser !== undefined ? ` naming ${browser}` : ""} in feature "${feature}", found ${matching.length}; rows: ${JSON.stringify(rows.map((r) => (r.textContent ?? "").trim()))}`,
    );
  }
  return matching[0]!;
}

function stepRowsOf(row: HTMLElement): HTMLElement[] {
  return Array.from(row.parentElement?.querySelectorAll<HTMLElement>('[data-testid="leaf-row"]') ?? []);
}

/** The run detail reads of `eventId`, each as its query parameters. */
function detailReads(eventId: string): URLSearchParams[] {
  const prefix = `/api/v2/events/${encodeURIComponent(eventId)}`;
  return servedFetchLog
    .filter((u) => u === prefix || u.startsWith(`${prefix}?`))
    .map((u) => new URL(u, "http://localhost").searchParams);
}

/** Every `?suite=` read of `eventId`, as "<suite>|<browser>" ("<suite>|" when no browser was named). */
function suiteReads(eventId: string): string[] {
  return detailReads(eventId)
    .filter((q) => q.has("suite"))
    .map((q) => `${q.get("suite")}|${q.get("browser") ?? ""}`);
}

async function openRunDetail(handle: ServerHandle, key: string, eventId: string): Promise<void> {
  await mountServedApp(handle, `/p/${key}/run/${eventId}`);
}

// ── The specification ─────────────────────────────────────────────────────

describe("a playwright-bdd run opens as a specification", () => {
  test("its detail draws the spec view — the byline and one feature group per stored feature — never the plain suite tree", async () => {
    const handle = boot();
    const key = await frontendProject(handle, "spec-view-opens");
    const eventId = await streamBddRun(handle, key, mixedRun());

    await openRunDetail(handle, key, eventId);

    expect(overlay().querySelector('[data-testid="run-byline"]')?.textContent ?? "").toContain(AGENT);
    expect(featureGroups().length).toBe(5);
    // NEGATIVE — no plain-tree suite row stands outside a feature group.
    const loose = Array.from(overlay().querySelectorAll('[data-testid="suite-row"]')).filter(
      (r) => r.closest('[data-testid="feature-group"]') === null,
    );
    expect(loose.length).toBe(0);
  });
});

describe("a playwright-bdd run loads feature by feature", () => {
  test("the first read is ?depth=suites, the full read is never made, and the features listed are the stored suites' whole names", async () => {
    const handle = boot();
    const key = await frontendProject(handle, "spec-view-first-read");
    const eventId = await streamBddRun(handle, key, mixedRun());

    await openRunDetail(handle, key, eventId);

    const reads = detailReads(eventId);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0]!.get("depth")).toBe("suites");
    // NEGATIVE — no read of the whole run (no query at all).
    expect(reads.filter((q) => [...q.keys()].length === 0).length).toBe(0);

    // POSITIVE — one feature per stored suite name, failing features first in
    // report order, then the green ones in report order; the nested describe's
    // suite keeps its whole name, never split at ` › `.
    expect(featureNames()).toEqual(["Checkout", "Search", SETTINGS, "Wishlist", "Reviews"]);
    expect(featureNames()).not.toContain("Account");
  });

  test("failing features open first and are read per browser with ?suite=<feature>&browser=<b>, while a later green feature stays folded and unread", async () => {
    const handle = boot();
    const key = await frontendProject(handle, "spec-view-failing-first");
    const eventId = await streamBddRun(handle, key, mixedRun());

    await openRunDetail(handle, key, eventId);

    expect(featureOpen("Checkout")).toBe(true);
    expect(featureOpen("Search")).toBe(true);
    const reads = suiteReads(eventId);
    expect(reads).toContain("Checkout|chromium");
    expect(reads).toContain("Checkout|firefox");
    expect(reads).toContain("Search|chromium");
    // NEGATIVE — every read names a feature and its browser, never a scenario
    // and never a feature without its browser.
    for (const read of reads) {
      const [suite, browser] = read.split("|");
      expect([SETTINGS, "Wishlist", "Reviews", "Checkout", "Search"]).toContain(suite!);
      expect(["chromium", "firefox"]).toContain(browser!);
    }
    // BOUND — the last green feature is past every first-open reading: folded, unread.
    expect(featureFolded("Reviews")).toBe(true);
    expect(reads.filter((r) => r.startsWith("Reviews|")).length).toBe(0);
  });

  test("with no failing feature, the first SPEC_FIRST_OPEN features open and are read, and the rest stay folded and unread", async () => {
    const handle = boot();
    const key = await frontendProject(handle, "spec-view-first-open");
    const eventId = await streamBddRun(handle, key, allGreenRun());

    await openRunDetail(handle, key, eventId);

    expect(featureNames()).toEqual([SETTINGS, "Wishlist", "Reviews", "Gifts"]);
    expect(featureOpen(SETTINGS)).toBe(true);
    expect(featureOpen("Wishlist")).toBe(true);
    expect(featureFolded("Reviews")).toBe(true);
    expect(featureFolded("Gifts")).toBe(true);
    // BOUND — exactly the two opened features were read, each once.
    expect([...suiteReads(eventId)].sort()).toEqual([`${SETTINGS}|chromium`, "Wishlist|chromium"].sort());
  });

  test("opening a folded feature reads ?suite=<feature>&browser=<b> once and shows its scenarios with their steps in order", async () => {
    const handle = boot();
    const key = await frontendProject(handle, "spec-view-open-feature");
    const eventId = await streamBddRun(handle, key, mixedRun());
    await openRunDetail(handle, key, eventId);
    expect(featureFolded("Reviews")).toBe(true);
    const readsBefore = suiteReads(eventId).length;

    featureOf("Reviews").querySelector<HTMLElement>('[data-testid="feature-heading"]')!.click();
    await settleServedApp();

    const newReads = suiteReads(eventId).slice(readsBefore);
    expect(newReads).toEqual(["Reviews|chromium"]);
    expect(featureOpen("Reviews")).toBe(true);
    expect(scenarioRowsOf("Reviews").length).toBe(1);
    const steps = stepRowsOf(scenarioRow("Reviews", "Write a review"));
    expect(steps.length).toBe(3);
    REVIEW_STEPS.forEach((name, i) => expect(steps[i]!.textContent ?? "").toContain(name));
  });
});

describe("a feature run in two projects", () => {
  test("shows once, as one feature, its scenario rows each naming their browser, its counts over both browsers", async () => {
    const handle = boot();
    const key = await frontendProject(handle, "spec-view-two-projects");
    const eventId = await streamBddRun(handle, key, mixedRun());

    await openRunDetail(handle, key, eventId);

    expect(featureNames().filter((n) => n === "Checkout").length).toBe(1);
    const checkout = featureOf("Checkout");
    expect(checkout.getAttribute("data-feature-passed")).toBe("2");
    expect(checkout.getAttribute("data-feature-failed")).toBe("1");

    const rows = scenarioRowsOf("Checkout");
    expect(rows.length).toBe(3);
    const chromiumCard = scenarioRow("Checkout", "Pay by card", "chromium");
    const firefoxCard = scenarioRow("Checkout", "Pay by card", "firefox");
    const voucher = scenarioRow("Checkout", "Pay by voucher", "chromium");
    expect(new Set([chromiumCard, firefoxCard, voucher]).size).toBe(3);
    // NEGATIVE — the chromium row of "Pay by card" names no other browser.
    expect(chromiumCard.textContent ?? "").not.toContain("firefox");

    // Each browser's scenario shows its OWN steps: firefox's last step failed
    // and carries its message; chromium's passed.
    const firefoxSteps = stepRowsOf(firefoxCard);
    expect(firefoxSteps.length).toBe(3);
    CARD_STEPS.forEach((name, i) => expect(firefoxSteps[i]!.textContent ?? "").toContain(name));
    expect(firefoxSteps[2]!.classList.contains("fail")).toBe(true);
    expect(firefoxCard.parentElement?.querySelector('[data-testid="failure-box"]')?.textContent ?? "").toContain(RECEIPT_MISSING);
    const chromiumSteps = stepRowsOf(chromiumCard);
    expect(chromiumSteps.length).toBe(3);
    expect(chromiumSteps.some((s) => s.classList.contains("fail"))).toBe(false);
  });
});

describe("a scenario that failed with no failing step", () => {
  test("a Before-hook failure shows its message on the scenario row, with no step marked failed", async () => {
    const handle = boot();
    const key = await frontendProject(handle, "spec-view-before-hook");
    const eventId = await streamBddRun(handle, key, mixedRun());

    await openRunDetail(handle, key, eventId);

    expect(featureOpen("Search")).toBe(true);
    // Density shows a failure box once its failure is focused (the one-box
    // focus model): focus the scenario by clicking its row.
    scenarioRow("Search", "Find a book by title").click();
    await settleServedApp();
    const row = scenarioRow("Search", "Find a book by title");
    const group = row.parentElement!;
    const boxes = Array.from(group.querySelectorAll<HTMLElement>('[data-testid="failure-box"]'));
    expect(boxes.length).toBe(1);
    expect(boxes[0]!.textContent ?? "").toContain(BEFORE_HOOK_FAILURE);
    // On the scenario, not inside any step row.
    expect(boxes[0]!.closest('[data-testid="leaf-row"]')).toBeNull();
    expect(stepRowsOf(row).some((s) => s.classList.contains("fail"))).toBe(false);
  });
});

describe("a run the playwright codec stored still opens as before", () => {
  test("side by side on one board: the old run splits its scenario suites into features and reads scenarios, the new run reads features", async () => {
    const handle = boot();
    const key = await frontendProject(handle, "spec-view-both-shapes");
    const oldId = await ingestPlaywrightReport(handle, key);
    const newId = await streamBddRun(handle, key, mixedRun());

    // The old shape, exactly as today: one feature split off "Library › …",
    // its failing scenario read by its own suite name and opened at its steps.
    await openRunDetail(handle, key, oldId);
    expect(detailReads(oldId)[0]!.get("depth")).toBe("suites");
    expect(featureNames()).toEqual(["Library"]);
    expect(featureOpen("Library")).toBe(true);
    expect(suiteReads(oldId)).toContain("Library › Return a book|chromium");
    const returnRow = Array.from(featureOf("Library").querySelectorAll<HTMLElement>('[data-testid="suite-row"]')).find((r) =>
      (r.textContent ?? "").includes("Library › Return a book"),
    );
    expect(returnRow).toBeDefined();
    const returnSteps = stepRowsOf(returnRow!);
    expect(returnSteps.map((s) => (s.textContent ?? "").includes("Then the book is back on the shelf"))).toContain(true);
    expect(returnRow!.parentElement?.querySelector('[data-testid="failure-box"]')?.textContent ?? "").toContain(SHELF_FAILURE);

    // The new shape on the same board: features are the stored suites, read by feature and browser.
    await openRunDetail(handle, key, newId);
    expect(detailReads(newId)[0]!.get("depth")).toBe("suites");
    expect(featureNames()).toEqual(["Checkout", "Search", SETTINGS, "Wishlist", "Reviews"]);
    expect(suiteReads(newId)).toContain("Checkout|firefox");
    expect(stepRowsOf(scenarioRow("Checkout", "Pay by card", "firefox")).length).toBe(3);
  });
});
