// The BDD-driven e2e suite reaches the board through its event stream, with
// every scenario's steps intact.
//
// `package.json`'s `crucible.targets` declares `test:e2e` as a
// `playwright-bdd` target streamed in `crucible-events` through
// `env:CRUCIBLE_STREAM`, and in neither `crucible.reportPath` nor
// `crucible.rawReport`. The bun client opens a run, hands the runner the
// stream file and the shipped reporters, relays the stream to the open run and
// closes the run by it. Playwright's kept `junit` and `json` reports are
// written to the run's own reports dir, never to `<repo>/test-reports`.
//
// What the drive's one stored run shows:
//   - tier `e2e`, framework `playwright-bdd`, codec `crucible-events`: opened
//     at /api/v2/runs/start, streamed to /api/v2/runs/<id>/stream, closed at
//     /api/v2/runs, and never posted to /api/v2/runs/parsed;
//   - one suite per feature per browser, named by its `Feature:` title and
//     carrying its browser;
//   - a test count equal to the same run's JUnit `tests`;
//   - each scenario's steps equal, by name, status and order, what the
//     `playwright` codec (`parsePlaywright`, src/codecs/playwright.ts) decodes
//     from the same run's JSON report, matched by (suite, name, browser);
//   - a broken step's own failure message on that step, and the step after it
//     absent (Playwright halts the `test.step()` chain at the first error);
//   - `<repo>/test-reports/junit.xml` and `playwright.json` untouched.
//
// ── HOW THIS FILE DRIVES IT, AND WHY IN THIS SHAPE ────────────────────────
//
// ONE real invocation, shared. The suite costs ~70s of real browser time, so
// `drive()` runs it exactly once, lazily, and every assertion below reads the
// SAME stored event. The board is a real in-process server on an ephemeral
// port with an in-memory store; the client reaches it through a CAPTURING
// PROXY (the `tests/clients-bun-crucible.test.ts` pattern) so the ROUTE the
// ingest took is observable — that is what separates "the server decoded it"
// from "the client decoded it and the server believed the client".
//
// `--package-dir <repo>` with `--project-dir <scratch>` is the seam that makes
// this honest: the REAL 16-feature suite in this checkout is what runs, while
// the project key and the board come from a throwaway directory, so a drive
// files nothing against the real board.
//
// THE DELIBERATELY FAILING SCENARIO IS TEMPORARY, BY CONSTRUCTION. §S2's last
// criterion needs a step that actually breaks, and the 16 real features are
// meant to be green — a checked-in failing scenario would red `test:e2e` for
// good and could never be made to pass. So this file WRITES one feature and
// one step file into `tests/e2e/features/` and `tests/e2e/steps/` for the
// duration of its own drive and DELETES them in `afterAll`. They are named to
// sort LAST, so `shell-storyboard.feature`'s F1 "truly empty DB" precondition
// is untouched (see playwright.config.ts's project-dependencies comment), and
// their steps touch no `page`, no server and no database — the scenario is a
// broken assertion and nothing else.
//
// EVERY EXPECTATION IS DERIVED FROM THE `.feature` SOURCES, never written down
// here: the scenario names and the ordered step text are parsed off disk at
// run time. CR-CRU-018 will add mobile scenarios to this same suite (§S4), and
// a guard that hardcoded today's 46 would fail the day it lands for a reason
// that has nothing to do with this CR.
//
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlaywright } from "../src/codecs/playwright.ts";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { declareClientBoard } from "./helpers/client-board.ts";
import { webkitEngineAvailable } from "./e2e/steps/webkit-docker-preflight.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CLIENT = join(REPO_ROOT, "clients", "bun-crucible.py");
const FEATURES_DIR = join(REPO_ROOT, "tests", "e2e", "features");
const STEPS_DIR = join(REPO_ROOT, "tests", "e2e", "steps");
/** The phone feature `chromium-mobile` and `webkit-iphone` BOTH collect
 *  (their testMatch is identical, asserted by
 *  tests/webkit-iphone-engine-coverage.test.ts). */
const PHONE_FEATURE_FILE = join(FEATURES_DIR, "mobile-viewport-responsive.feature");
const AGENT = "e2e-suite-ingest-fixture";

/** The declared target this suite is collected under — §S1's whole point is
 *  that this string does not move. */
const E2E_TARGET = "test:e2e";

/** The framework the target runs under, and the codec its stream is in. */
const E2E_FRAMEWORK = "playwright-bdd";
const STREAM_CODEC = "crucible-events";

/** The target's one declaration: its `crucible.targets` entry. */
const E2E_TARGET_ENTRY = {
  framework: E2E_FRAMEWORK,
  stream: { codec: STREAM_CODEC, path: "env:CRUCIBLE_STREAM" },
};

/** The routes a streamed run takes (open, stream, close), and the one it must
 *  not: the client's own pre-parse. */
const START_ROUTE = "/api/v2/runs/start";
const STREAM_ROUTE = /^\/api\/v2\/runs\/[^/]+\/stream$/;
const CLOSE_ROUTE = "/api/v2/runs";
const CLIENT_PARSE_ROUTE = "/api/v2/runs/parsed";

/** The package's own report paths, the defaults `playwright.config.ts` writes
 *  to when no path is handed in. The drive must leave both untouched. */
const REPO_REPORTS = [
  join(REPO_ROOT, "test-reports", "junit.xml"),
  join(REPO_ROOT, "test-reports", "playwright.json"),
];

// ── the temporary deliberately-failing specification ─────────────────────
//
// Written before the drive, deleted after it. `zzz-` so it sorts last among
// the features and cannot disturb the empty-DB precondition the real suite's
// ordering is built around.

const RED_FEATURE_FILE = join(FEATURES_DIR, "zzz-deliberate-broken-step.feature");
const RED_STEPS_FILE = join(STEPS_DIR, "zzz-deliberate-broken-step.steps.ts");

/** The message the broken step throws. It must survive, verbatim, all the way
 *  to the stored event's own leaf — that is the criterion. */
const BROKEN_STEP_MESSAGE = "the specification broke at this step, and this is why";

const RED_FEATURE_SOURCE = `Feature: CR-CRU-015 a deliberately broken specification
  TEMPORARY. Written by tests/e2e-suite-reaches-the-board.test.ts for the
  duration of one drive and deleted immediately after. Never commit it.

  Scenario: a broken step reports the message it failed with
    Given the deliberately broken specification is prepared
    When the deliberately broken specification is executed
    And the step before the break still passes
    Then the broken step reports the message it failed with
    And the step after the break never runs
`;

const RED_STEPS_SOURCE = `// TEMPORARY — written and deleted by tests/e2e-suite-reaches-the-board.test.ts.
import { createBdd } from "playwright-bdd";

const { Given, When, Then } = createBdd();

Given("the deliberately broken specification is prepared", async () => {});
When("the deliberately broken specification is executed", async () => {});
Then("the step before the break still passes", async () => {});
Then("the broken step reports the message it failed with", async () => {
  throw new Error(${JSON.stringify(BROKEN_STEP_MESSAGE)});
});
Then("the step after the break never runs", async () => {});
`;

// ── the Gherkin on disk, read as the expectation ─────────────────────────

interface DeclaredScenario {
  /** The `Feature:` title the scenario lives under. */
  feature: string;
  /** The `Scenario:` title. */
  scenario: string;
  /** Its step lines, verbatim and in order — `Given …`, `And …`, `Then …`.
   *  playwright-bdd carries the keyword through into the step title, so this
   *  is the exact leaf name the codec produces. */
  steps: string[];
  /** `<feature> › <scenario>` — the name `src/codecs/playwright.ts` builds. */
  node: string;
}

const STEP_LINE = /^(Given|When|Then|And|But)\s+\S/;

/** One `.feature` file's scenarios. The suite declares no `Background` and no
 *  `Scenario Outline` (measured), so a scenario is its `Scenario:` line plus
 *  every step line under it; `#` comments and the feature's free-form
 *  description are not steps. */
function parseFeatureFile(path: string): DeclaredScenario[] {
  const scenarios: DeclaredScenario[] = [];
  let feature = "";
  let current: DeclaredScenario | undefined;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    if (line.startsWith("Feature:")) {
      feature = line.slice("Feature:".length).trim();
      current = undefined;
      continue;
    }
    if (line.startsWith("Scenario:")) {
      const scenario = line.slice("Scenario:".length).trim();
      current = { feature, scenario, steps: [], node: `${feature} › ${scenario}` };
      scenarios.push(current);
      continue;
    }
    if (current !== undefined && STEP_LINE.test(line)) current.steps.push(line);
  }
  return scenarios;
}

/** Every scenario the suite declares RIGHT NOW, read off the `.feature` files
 *  the config's own glob collects. Derived, so CR-CRU-018's mobile scenarios
 *  join it without an edit here. */
function declaredScenarios(): DeclaredScenario[] {
  return readdirSync(FEATURES_DIR)
    .filter((name) => name.endsWith(".feature"))
    .sort()
    .flatMap((name) => parseFeatureFile(join(FEATURES_DIR, name)));
}

// ── the drive ────────────────────────────────────────────────────────────

interface StoredStep {
  name: string;
  status: string;
  duration_ms?: number;
  failure?: { message?: string; trace?: string; type?: string };
}

interface StoredTest {
  name: string;
  status: string;
  duration_ms?: number;
  failure?: { message?: string; trace?: string; type?: string };
  steps?: StoredStep[];
}

interface StoredSuite {
  name: string;
  status: string;
  browser?: string;
  children?: StoredTest[];
}

interface StoredEvent {
  id: string;
  kind?: string;
  tier?: string;
  framework?: string;
  codec?: string;
  summary?: { total: number; passed: number; failed: number; pending?: number };
  tree?: StoredSuite[];
}

/** Whether a package report exists, and when it was last written. */
interface ReportSnapshot {
  path: string;
  exists: boolean;
  mtimeMs?: number;
}

interface Drive {
  /** Every non-lifecycle event the drive filed. */
  events: StoredEvent[];
  /** The POST paths the client actually hit, in order. */
  posts: string[];
  /** The scenarios the suite declared for THIS drive, temporary one included. */
  declared: DeclaredScenario[];
  /** The same run's kept JUnit report, read from the drive's reports dir. */
  junitXml: string;
  /** The same run's kept Playwright JSON report, read from the drive's reports dir. */
  playwrightJson: string;
  /** The package's own reports, before the drive and after it. */
  repoReportsBefore: ReportSnapshot[];
  repoReportsAfter: ReportSnapshot[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

let handle: ServerHandle | undefined;
let proxy: { url: string; posts: string[]; stop(): void } | undefined;
let driven: Promise<Drive> | undefined;
/** The drive's scratch project directory — removed by the file's own
 *  `afterAll`, whether the drive passed or failed. */
let scratchDir: string | undefined;

/** A capturing proxy in front of the board: records the POST paths the spawned
 *  client hit and relays everything verbatim. The pattern is
 *  tests/clients-bun-crucible.test.ts's `startCapturingProxy`. */
function startCapturingProxy(target: string): { url: string; posts: string[]; stop(): void } {
  const posts: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST") posts.push(url.pathname);
      const headers = new Headers(req.headers);
      headers.delete("host");
      const init: RequestInit = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();
      const upstream = await fetch(new URL(url.pathname + url.search, target), init);
      const body = await upstream.arrayBuffer();
      return new Response(body, { status: upstream.status, headers: upstream.headers });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, posts, stop: () => server.stop(true) };
}

async function spawnClient(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("WORKFLOW_")) delete env[key];
  const proc = Bun.spawn({
    cmd: ["uv", "run", CLIENT, ...args],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function snapshotRepoReports(): ReportSnapshot[] {
  return REPO_REPORTS.map((path) =>
    existsSync(path) ? { path, exists: true, mtimeMs: statSync(path).mtimeMs } : { path, exists: false },
  );
}

/** The one report with `extension` the run wrote into its reports dir. */
function keptReport(reportsDir: string, extension: string): string {
  const found = existsSync(reportsDir)
    ? readdirSync(reportsDir).filter((name) => name.endsWith(extension))
    : [];
  if (found.length !== 1) {
    throw new Error(
      `the run's reports dir ${reportsDir} holds ${found.length} ${extension} report(s), ` +
        `not one: ${JSON.stringify(found)}`,
    );
  }
  return readFileSync(join(reportsDir, found[0] as string), "utf8");
}

async function runTheSuiteThroughTheClient(): Promise<Drive> {
  writeFileSync(RED_FEATURE_FILE, RED_FEATURE_SOURCE);
  writeFileSync(RED_STEPS_FILE, RED_STEPS_SOURCE);
  const declared = declaredScenarios();

  handle = startServer({ port: 0, dbPath: ":memory:" });
  const board = `http://127.0.0.1:${handle.server.port}`;
  proxy = startCapturingProxy(board);

  const projectKey = crypto.randomUUID();
  handle.store.addProject({
    key: projectKey,
    name: "e2e-suite-reaches-the-board",
    type: "frontend",
    sutRoot: REPO_ROOT,
  });

  const scratch = mkdtempSync(join(tmpdir(), "e2e-suite-ingest-"));
  scratchDir = scratch;
  writeFileSync(join(scratch, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
  declareClientBoard(proxy.url, scratch);

  const registered = await spawnClient(
    ["register", "--agent", AGENT, "--role", "report", "--project-dir", scratch],
    scratch,
  );
  if (registered.code !== 0) {
    throw new Error(
      `the fixture agent could not register (exit ${registered.code}); ` +
        `stdout=${registered.stdout} stderr=${registered.stderr}`,
    );
  }

  // `--reports` is absolute and OUTSIDE the checkout on purpose: the client
  // wipes its reports dir before a run, and the suite that is running THIS
  // file is itself writing `<repo>/test-reports/junit.xml`. Two runs sharing
  // one report path is a race, not a test.
  const reportsDir = join(scratch, "test-reports");
  const repoReportsBefore = snapshotRepoReports();
  const run = await spawnClient(
    [
      "e2e",
      "--agent",
      AGENT,
      "--project-dir",
      scratch,
      "--package-dir",
      REPO_ROOT,
      "--reports",
      reportsDir,
    ],
    scratch,
  );
  const repoReportsAfter = snapshotRepoReports();
  const junitXml = keptReport(reportsDir, ".xml");
  const playwrightJson = keptReport(reportsDir, ".json");

  const res = await fetch(`${board}/api/v2/events?project=${projectKey}`);
  const body = (await res.json()) as { events: StoredEvent[] };
  const filed = body.events.filter((event) => event.kind !== "lifecycle");
  const events: StoredEvent[] = [];
  for (const event of filed) {
    const full = (await (await fetch(`${board}/api/v2/events/${event.id}`)).json()) as {
      event: StoredEvent;
    };
    events.push(full.event);
  }
  return {
    events,
    posts: proxy.posts,
    declared,
    junitXml,
    playwrightJson,
    repoReportsBefore,
    repoReportsAfter,
    exitCode: run.code,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

function drive(): Promise<Drive> {
  driven ??= runTheSuiteThroughTheClient();
  return driven;
}

/** The one run this drive filed. A drive that filed none is itself the §S1
 *  failure ("the suite's results never reach the board"), so the refusal names
 *  what the client said. */
function ingested(run: Drive): StoredEvent {
  const [event, ...rest] = run.events;
  if (event === undefined) {
    throw new Error(
      "the e2e drive filed NO run on the board — §S1's whole defect. " +
        `client exit=${run.exitCode}; stdout tail=${run.stdout.slice(-1200)}; ` +
        `stderr tail=${run.stderr.slice(-1200)}`,
    );
  }
  if (rest.length > 0) {
    throw new Error(`one drive filed ${run.events.length} runs: ${run.events.map((e) => e.id).join(", ")}`);
  }
  return event;
}

/** How many engines run the phone feature in THIS drive: two
 *  (chromium-mobile + webkit-iphone) whenever a WebKit engine exists for the
 *  run (CI's native install, or the Docker endpoint), else one. The SAME
 *  predicate that gates webkit-iphone in playwright.config.ts, read from the
 *  SAME environment the spawned drive inherits. */
function phoneEngineCount(): number {
  return webkitEngineAvailable({
    isCI: Boolean(process.env.CI),
    wsEndpoint: process.env.PW_TEST_CONNECT_WS_ENDPOINT,
  })
    ? 2
    : 1;
}

/** A stored test with the suite and browser it sits under. */
interface PlacedTest {
  suite: string;
  browser: string;
  test: StoredTest;
}

function placedTests(event: StoredEvent): PlacedTest[] {
  return (event.tree ?? []).flatMap((suite) =>
    (suite.children ?? []).map((test) => ({ suite: suite.name, browser: suite.browser ?? "", test })),
  );
}

/** The stored tests of one declared scenario, under every browser that ran it. */
function testsOf(event: StoredEvent, scenario: DeclaredScenario): StoredTest[] {
  return placedTests(event)
    .filter((placed) => placed.suite === scenario.feature && placed.test.name === scenario.scenario)
    .map((placed) => placed.test);
}

/** The `tests` count on the JUnit report's root element. */
function junitTests(xml: string): number {
  const root = /<testsuites\b[^>]*\btests="(\d+)"/.exec(xml);
  if (root === null) throw new Error(`the JUnit report states no root tests count: ${xml.slice(0, 400)}`);
  return Number(root[1]);
}

function nameAndStatus(entries: { name: string; status: string }[]): { name: string; status: string }[] {
  return entries.map(({ name, status }) => ({ name, status }));
}

/** The drive is one real browser suite: ~70s of Playwright plus the ingest. */
const DRIVE_BUDGET_MS = 300_000;

afterAll(() => {
  for (const path of [RED_FEATURE_FILE, RED_STEPS_FILE]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
  proxy?.stop();
  handle?.stop();
  proxy = undefined;
  handle = undefined;
  if (scratchDir !== undefined) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = undefined;
});

describe("the BDD suite's declaration cannot be renamed or retiered", () => {
  test("the BDD suite is declared as `test:e2e`, with no renamed twin and no second target", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      crucible?: {
        targets?: Record<string, unknown>;
        reportPath?: Record<string, unknown>;
        rawReport?: Record<string, unknown>;
      };
    };
    const scripts = manifest.scripts ?? {};

    // POSITIVE — the target exists AND is the BDD harness, so "declared" and
    // "declared for THIS suite" cannot come apart.
    const declared = scripts[E2E_TARGET];
    expect(declared).toBeDefined();
    expect(declared).toContain("bddgen");
    expect(declared).toContain("playwright test");

    // NEGATIVE — the rename §S1 forbids, in every spelling a later author
    // might reach for. The suite's MEANS are BDD and Playwright; its TIER is
    // e2e, and the target name states the tier.
    const renamed = Object.keys(scripts).filter((name) =>
      /^test:(bdd|gherkin|cucumber|playwright|e2e[-:].+)$/.test(name),
    );
    expect(renamed).toEqual([]);

    // The `.feature` files are what this target collects — asserted on the
    // features the suite actually declares, never on the config's SOURCE
    // TEXT: `defineBddConfig`'s glob is not exposed on the config object, so
    // reading it as a string would only pin how the glob is spelled and would
    // red on a hoisted constant with nothing broken.
    expect(declaredScenarios().length).toBeGreaterThan(0);

    // The target's record is declared in the same manifest, once: its
    // `crucible.targets` entry, and neither of the older report declarations.
    // No table entry names a script the script table does not declare.
    const targets = manifest.crucible?.targets ?? {};
    expect(targets[E2E_TARGET]).toEqual(E2E_TARGET_ENTRY);
    expect(Object.keys(manifest.crucible?.reportPath ?? {})).not.toContain(E2E_TARGET);
    expect(Object.keys(manifest.crucible?.rawReport ?? {})).not.toContain(E2E_TARGET);
    expect(Object.keys(targets).filter((target) => scripts[target] === undefined)).toEqual([]);
  });
});

describe("a real client drive of the e2e suite streams the Gherkin to the board", () => {
  test(
    "the drive files ONE `playwright-bdd` run under tier `e2e`, each scenario under its feature and browser",
    async () => {
      const run = await drive();
      const event = ingested(run);

      // No rename of the TIER either: the run this target files is e2e, and
      // it ran under the framework its table entry declares.
      expect(event.tier).toBe("e2e");
      expect(event.framework).toBe(E2E_FRAMEWORK);

      // Each stored suite is one feature under one browser: named by its
      // `Feature:` title, and carrying the browser (Playwright project) it ran
      // under.
      const features = new Set(run.declared.map((scenario) => scenario.feature));
      const suites = event.tree ?? [];
      expect(suites.length).toBeGreaterThan(0);
      expect(suites.filter((suite) => (suite.browser ?? "") === "").map((suite) => suite.name)).toEqual([]);
      expect(suites.filter((suite) => !features.has(suite.name)).map((suite) => suite.name)).toEqual([]);

      // Every declared scenario is a test under its feature.
      const names = placedTests(event).map((placed) => `${placed.suite} › ${placed.test.name}`);
      const missing = run.declared.filter((scenario) => !names.includes(scenario.node));
      expect(missing.map((scenario) => scenario.node)).toEqual([]);

      // NEGATIVE/bound — and NOTHING else is a test. A tree that also carried
      // a second copy of each scenario would pass the containment check above
      // while being a different shape.
      //
      // The ONE legitimate second copy: the phone feature runs on TWO engines
      // (chromium-mobile + webkit-iphone) whenever a WebKit engine exists for
      // the run (CI's native install, or the Docker endpoint; the SAME
      // predicate that gates webkit-iphone in playwright.config.ts), each under
      // its own browser. Asserted as the exact multiset: every declared
      // scenario once, plus one more copy of each phone scenario per extra
      // engine, and nothing else.
      const expected = new Map(run.declared.map((scenario) => [scenario.node, 1]));
      const phoneEngines = phoneEngineCount();
      for (const scenario of parseFeatureFile(PHONE_FEATURE_FILE)) {
        expected.set(scenario.node, phoneEngines);
      }
      const actual = new Map<string, number>();
      for (const name of names) actual.set(name, (actual.get(name) ?? 0) + 1);
      expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "the run counts scenarios, as the same run's JUnit report does, and every scenario holds its own steps",
    async () => {
      const run = await drive();
      const event = ingested(run);

      // The run's total counts TESTS (scenarios per browser), never steps: it
      // equals the `tests` the same run's kept JUnit report states.
      expect(event.summary?.total).toBe(junitTests(run.junitXml));

      // Every scenario holds its steps, not a single verdict.
      const stepless = placedTests(event).filter((placed) => (placed.test.steps ?? []).length === 0);
      expect(stepless.map((placed) => `${placed.browser}: ${placed.suite} › ${placed.test.name}`)).toEqual([]);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "the run is opened, streamed and closed by its `crucible-events` stream — never a client-side parse",
    async () => {
      const run = await drive();
      const event = ingested(run);

      // The stored provenance: the stream's own codec.
      expect(event.codec).toBe(STREAM_CODEC);

      // …and the ROUTES that provenance can only come from. Read off the
      // proxy, so these are the requests the client really made.
      expect(run.posts).toContain(START_ROUTE);
      expect(run.posts.filter((path) => STREAM_ROUTE.test(path)).length).toBeGreaterThan(0);
      expect(run.posts).toContain(CLOSE_ROUTE);
      expect(run.posts).not.toContain(CLIENT_PARSE_ROUTE);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "each scenario's steps equal, by name and status, what the `playwright` codec decodes from the same run's JSON report",
    async () => {
      const run = await drive();
      const event = ingested(run);
      const decoded = parsePlaywright(run.playwrightJson).tree;

      // Matched by (suite, name, browser): the codec names a node
      // "<Feature> › <Scenario>" and carries the project as its browser.
      const wrong: string[] = [];
      for (const placed of placedTests(event)) {
        const node = `${placed.suite} › ${placed.test.name}`;
        const matches = decoded.filter(
          (candidate) => candidate.name === node && candidate.browser === placed.browser,
        );
        if (matches.length !== 1) {
          wrong.push(`${placed.browser}: ${node}: ${matches.length} codec node(s)`);
          continue;
        }
        const stored = nameAndStatus(placed.test.steps ?? []);
        const expected = nameAndStatus((matches[0] as StoredSuite).children ?? []);
        if (JSON.stringify(stored) !== JSON.stringify(expected)) {
          wrong.push(`${placed.browser}: ${node}: ${JSON.stringify(stored)} != ${JSON.stringify(expected)}`);
        }
      }
      expect(wrong).toEqual([]);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "each scenario's steps reach the board IN ORDER, with the Gherkin step text as the leaf name",
    async () => {
      const run = await drive();
      const event = ingested(run);

      // Checked for EVERY scenario the suite declares, against that
      // scenario's own source. Playwright halts the step chain at the first
      // error, so the leaves are a PREFIX of the declared steps — complete
      // when the scenario passed, truncated at the break when it did not.
      const wrong: string[] = [];
      for (const scenario of run.declared) {
        const tests = testsOf(event, scenario);
        if (tests.length === 0) {
          wrong.push(`${scenario.node}: no test`);
          continue;
        }
        for (const stored of tests) {
          const leaves = (stored.steps ?? []).map((step) => step.name);
          const expected = scenario.steps.slice(0, leaves.length);
          if (JSON.stringify(leaves) !== JSON.stringify(expected)) {
            wrong.push(`${scenario.node}: ${JSON.stringify(leaves)} != ${JSON.stringify(expected)}`);
            continue;
          }
          if (stored.status === "pass" && leaves.length !== scenario.steps.length) {
            wrong.push(
              `${scenario.node}: passed with ${leaves.length} of ${scenario.steps.length} steps`,
            );
          }
        }
      }
      expect(wrong).toEqual([]);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "a broken step's own failure message reaches the board ON that step, and the steps around it stay clean",
    async () => {
      const run = await drive();
      const event = ingested(run);

      const broken = run.declared.find((scenario) => scenario.steps.some((step) => step.includes("the broken step reports the message it failed with")));
      expect(broken).toBeDefined();
      const tests = testsOf(event, broken!);
      expect(tests).toHaveLength(1);
      const stored = tests[0] as StoredTest;
      expect(stored.status).toBe("fail");

      const leaves = stored.steps ?? [];
      const brokenStep = leaves.find((leaf) =>
        leaf.name === "Then the broken step reports the message it failed with",
      );
      expect(brokenStep).toBeDefined();
      expect(brokenStep!.status).toBe("fail");
      expect(brokenStep!.failure?.message).toContain(BROKEN_STEP_MESSAGE);

      // NEGATIVE — the message is ON that step and nowhere else: the three
      // steps that passed before it carry no failure, and the step after the
      // break never ran, so it is absent rather than reported as passed.
      const failing = leaves.filter((leaf) => leaf.failure !== undefined).map((leaf) => leaf.name);
      expect(failing).toEqual(["Then the broken step reports the message it failed with"]);
      expect(leaves.map((leaf) => leaf.name)).not.toContain("And the step after the break never runs");
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "the drive writes nothing to the package's own test-reports",
    async () => {
      const run = await drive();
      ingested(run);
      expect(run.repoReportsAfter).toEqual(run.repoReportsBefore);
    },
    DRIVE_BUDGET_MS,
  );
});
