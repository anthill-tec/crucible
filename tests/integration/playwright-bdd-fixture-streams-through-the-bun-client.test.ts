// The playwright-bdd fixture project streams its run to the board through the
// bun client: each scenario a test under its feature and browser, with its
// Gherkin steps.
//
// A scratch copy of `tests/fixtures/playwright-bdd-project` (its
// `node_modules` a directory of links to this repo's installed packages)
// declares its `test:bdd` script in `crucible.targets` as a `playwright-bdd`
// target streamed in `crucible-events` through `env:CRUCIBLE_STREAM`. The bun
// client's `bdd` verb runs it against a real in-process board (`startServer`,
// port 0, ":memory:") reached through a capturing proxy, so the ROUTES the run
// took are observable. The fixture's own JUnit report is written, through the
// variable its config reads (`FIXTURE_JUNIT_PATH`), into the run's reports dir.
//
// What the drive's one stored run shows:
//   - it is closed by its stream: opened at /api/v2/runs/start, streamed to
//     /api/v2/runs/<id>/stream, closed at /api/v2/runs, never posted to
//     /api/v2/runs/parsed; codec `crucible-events`, framework `playwright-bdd`,
//     and nothing incomplete;
//   - its scenario count equals the same run's JUnit `tests`, its pending count
//     the JUnit `skipped` (the failed dependency project's dependents, swept
//     `pending` at `onEnd`);
//   - each scenario sits under its feature and browser: the stored
//     (suite, scenario, browser) multiset is the one the feature files and the
//     fixture's projects declare;
//   - each scenario's steps equal, by name, status and order, the steps its
//     `.feature` file declares as they run;
//   - nothing is written to the package's `test-reports/`, nor to this repo's
//     Playwright report paths.
//
// THE STEPS AS THEY RUN, READ OFF THE `.feature` FILES. A scenario that runs
// runs its feature's Background steps first (the stream carries them first,
// P4), then its own, each passing until the first step whose definition
// throws on every attempt (`FAILING_STEPS`, the fixture's steps/steps.ts):
// that step fails and no later step runs, so none is reported. The scenario
// that fails on its first attempt only is reported from its last attempt, the
// retry, where every step passes. A scenario whose Before hook fails
// (`@before-hook-fails`) runs no step, nor does a scenario whose project never
// runs (`NEVER_RUN_TAGS`).
//
// The fixture's `setup` project fails on purpose and `after-setup` depends on
// it, so its two scenarios never run.
import { afterAll, describe, expect, test } from "bun:test";
import { clientScript } from "../helpers/test-install.ts";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server.ts";
import type { ServerHandle } from "../../src/server.ts";
import { declareClientBoard } from "../helpers/client-board.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const CLIENT = clientScript("bun-crucible.py");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "playwright-bdd-project");
const REPO_NODE_MODULES = join(REPO_ROOT, "node_modules");
const AGENT = "playwright-bdd-fixture-drive";

const BDD_SCRIPT = "test:bdd";
const FRAMEWORK = "playwright-bdd";
const STREAM_CODEC = "crucible-events";
const TARGET_ENTRY = { framework: FRAMEWORK, stream: { codec: STREAM_CODEC, path: "env:CRUCIBLE_STREAM" } };

const START_ROUTE = "/api/v2/runs/start";
const STREAM_ROUTE = /^\/api\/v2\/runs\/[^/]+\/stream$/;
const CLOSE_ROUTE = "/api/v2/runs";
const CLIENT_PARSE_ROUTE = "/api/v2/runs/parsed";

const SEP = " › ";

/** The fixture's projects by the feature tag each one's `grep` selects —
 *  the `projects` of tests/fixtures/playwright-bdd-project/playwright.config.ts. */
const PROJECTS_BY_TAG: Record<string, string[]> = {
  "@main": ["alpha", "beta"],
  "@setup-fails": ["setup"],
  "@waits-on-setup": ["after-setup"],
};

/** This repo's own Playwright JUnit report paths, which the drive must leave alone. */
const REPO_REPORTS = ["playwright-junit.xml"].map((name) => join(REPO_ROOT, "test-reports", name));

/** Variables an ambient shell or an enclosing run could carry into the drive. */
const SCRUBBED = [
  "PLAYWRIGHT_JUNIT_OUTPUT_NAME",
  "PLAYWRIGHT_JSON_OUTPUT_NAME",
  "PLAYWRIGHT_BDD_CONFIGS",
  "PW_TEST_CONNECT_WS_ENDPOINT",
  "PW_TEST_CONNECT_EXPOSE_NETWORK",
  "TEST_WORKER_INDEX",
  "FIXTURE_JUNIT_PATH",
  "FIXTURE_JSON_PATH",
];

// ── the feature files, read as the expectation ───────────────────────────

/** The fixture's step definitions that throw on every attempt (its steps/steps.ts). */
const FAILING_STEPS = new Set(["When a step fails on purpose", "Given the setup fails"]);

/** The scenario tag whose Before hook throws, so the scenario runs no step. */
const BEFORE_HOOK_FAILS = "@before-hook-fails";

/** Feature tags whose project depends on the failing `setup` project, so never runs. */
const NEVER_RUN_TAGS = new Set(["@waits-on-setup"]);

interface DeclaredScenario {
  /** The describe chain it sits under (`Feature › Rule`). */
  suite: string;
  name: string;
  tags: string[];
  /** Its own step lines, verbatim and in order. */
  steps: string[];
}

interface DeclaredFeature {
  file: string;
  tag: string;
  title: string;
  background: string[];
  scenarios: DeclaredScenario[];
}

const STEP_LINE = /^(Given|When|Then|And|But)\s+\S/;

function parseFeature(file: string): DeclaredFeature {
  const feature: DeclaredFeature = { file, tag: "", title: "", background: [], scenarios: [] };
  let rule: string | undefined;
  let inBackground = false;
  let current: DeclaredScenario | undefined;
  let pendingTags: string[] = [];
  for (const raw of readFileSync(join(FIXTURE, "features", file), "utf8").split("\n")) {
    const line = raw.trim();
    if (feature.title === "" && line.startsWith("@")) feature.tag = line.split(/\s+/)[0] ?? "";
    else if (line.startsWith("@")) pendingTags = line.split(/\s+/);
    else if (line.startsWith("Feature:")) feature.title = line.slice("Feature:".length).trim();
    else if (line.startsWith("Background:")) inBackground = true;
    else if (line.startsWith("Rule:")) {
      rule = line.slice("Rule:".length).trim();
      inBackground = false;
      current = undefined;
    } else if (line.startsWith("Scenario:")) {
      inBackground = false;
      const suite = rule === undefined ? feature.title : `${feature.title}${SEP}${rule}`;
      current = { suite, name: line.slice("Scenario:".length).trim(), tags: pendingTags, steps: [] };
      pendingTags = [];
      feature.scenarios.push(current);
    } else if (STEP_LINE.test(line)) {
      if (inBackground) feature.background.push(line);
      else current?.steps.push(line);
    }
  }
  return feature;
}

/** The steps a declared scenario reports, by name and status, as it runs (see the header). */
function stepsAsTheyRun(feature: DeclaredFeature, scenario: DeclaredScenario): StoredStep[] {
  if (NEVER_RUN_TAGS.has(feature.tag) || scenario.tags.includes(BEFORE_HOOK_FAILS)) return [];
  const ran: StoredStep[] = [];
  for (const name of [...feature.background, ...scenario.steps]) {
    if (FAILING_STEPS.has(name)) {
      ran.push({ name, status: "fail" });
      break;
    }
    ran.push({ name, status: "pass" });
  }
  return ran;
}

function declaredFeatures(): DeclaredFeature[] {
  return readdirSync(join(FIXTURE, "features"))
    .filter((name) => name.endsWith(".feature"))
    .sort((a, b) => a.localeCompare(b))
    .map(parseFeature);
}

// ── the drive ────────────────────────────────────────────────────────────

interface StoredStep {
  name: string;
  status: string;
}

interface StoredTest {
  name: string;
  status: string;
  steps?: StoredStep[];
}

interface StoredSuite {
  name: string;
  browser?: string;
  children?: StoredTest[];
}

interface StoredEvent {
  id: string;
  kind?: string;
  tier?: string;
  framework?: string;
  codec?: string;
  incomplete?: string;
  summary?: { total: number; passed: number; failed: number; pending?: number };
  tree?: StoredSuite[];
}

interface Drive {
  events: StoredEvent[];
  posts: string[];
  junitXml: string;
  packageReportsAfter: boolean;
  repoReportsBefore: Array<number | null>;
  repoReportsAfter: Array<number | null>;
  exitCode: number;
  stdout: string;
  stderr: string;
}

let handle: ServerHandle | undefined;
let proxy: { url: string; posts: string[]; stop(): void } | undefined;
let scratchDir: string | undefined;
let driven: Promise<Drive> | undefined;

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
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("WORKFLOW_") || (key.startsWith("CRUCIBLE_") && !(key in extraEnv))) delete env[key];
  }
  for (const key of SCRUBBED) if (!(key in extraEnv)) delete env[key];
  const proc = Bun.spawn({ cmd: ["uv", "run", CLIENT, ...args], cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** A `node_modules` directory of links to this repo's installed packages. */
function linkNodeModules(project: string): void {
  const target = join(project, "node_modules");
  mkdirSync(target);
  for (const name of readdirSync(REPO_NODE_MODULES)) {
    if (name.startsWith(".") && name !== ".bin") continue;
    symlinkSync(join(REPO_NODE_MODULES, name), join(target, name));
  }
}

function declareStreamTarget(project: string): void {
  const path = join(project, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  manifest.crucible = { targets: { [BDD_SCRIPT]: TARGET_ENTRY } };
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

function mtimes(paths: string[]): Array<number | null> {
  return paths.map((path) => (existsSync(path) ? statSync(path).mtimeMs : null));
}

function readReport(path: string, run: { code: number; stdout: string; stderr: string }): string {
  if (!existsSync(path)) {
    throw new Error(
      `the fixture wrote no report at ${path}; client exit=${run.code} ` +
        `stdout tail=${run.stdout.slice(-1500)} stderr tail=${run.stderr.slice(-1500)}`,
    );
  }
  return readFileSync(path, "utf8");
}

async function runTheFixtureThroughTheClient(): Promise<Drive> {
  handle = startServer({ port: 0, dbPath: ":memory:" });
  const board = `http://127.0.0.1:${handle.server.port}`;
  proxy = startCapturingProxy(board);
  const projectKey = crypto.randomUUID();
  handle.store.addProject({ key: projectKey, name: "playwright-bdd-fixture", type: "frontend", sutRoot: FIXTURE });

  const scratch = mkdtempSync(join(tmpdir(), "playwright-bdd-fixture-drive-"));
  scratchDir = scratch;
  const project = join(scratch, "project");
  cpSync(FIXTURE, project, { recursive: true });
  linkNodeModules(project);
  declareStreamTarget(project);
  writeFileSync(join(scratch, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
  declareClientBoard(proxy.url, scratch);

  const registered = await spawnClient(
    ["register", "--agent", AGENT, "--role", "report", "--project-dir", scratch],
    scratch,
  );
  if (registered.code !== 0) {
    throw new Error(`the drive agent could not register (exit ${registered.code}); ${registered.stdout} ${registered.stderr}`);
  }

  const reportsDir = join(scratch, "run-reports");
  const junitPath = join(reportsDir, "fixture-junit.xml");
  const repoReportsBefore = mtimes(REPO_REPORTS);
  const run = await spawnClient(
    ["bdd", "--agent", AGENT, "--project-dir", scratch, "--package-dir", project, "--reports", reportsDir],
    scratch,
    { FIXTURE_JUNIT_PATH: junitPath },
  );
  const repoReportsAfter = mtimes(REPO_REPORTS);

  const res = await fetch(`${board}/api/v2/events?project=${projectKey}`);
  const body = (await res.json()) as { events: StoredEvent[] };
  const events: StoredEvent[] = [];
  for (const event of body.events.filter((e) => e.kind !== "lifecycle")) {
    const full = (await (await fetch(`${board}/api/v2/events/${event.id}`)).json()) as { event: StoredEvent };
    events.push(full.event);
  }
  return {
    events,
    posts: proxy.posts,
    junitXml: readReport(junitPath, run),
    packageReportsAfter: existsSync(join(project, "test-reports")),
    repoReportsBefore,
    repoReportsAfter,
    exitCode: run.code,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

function drive(): Promise<Drive> {
  driven ??= runTheFixtureThroughTheClient();
  return driven;
}

function ingested(run: Drive): StoredEvent {
  const [event, ...rest] = run.events;
  if (event === undefined) {
    throw new Error(
      `the fixture drive filed NO run; client exit=${run.exitCode}; ` +
        `stdout tail=${run.stdout.slice(-1500)}; stderr tail=${run.stderr.slice(-1500)}`,
    );
  }
  if (rest.length > 0) throw new Error(`one drive filed ${run.events.length} runs`);
  return event;
}

interface PlacedTest {
  suite: string;
  browser: string;
  test: StoredTest;
}

function placedTests(event: StoredEvent): PlacedTest[] {
  return (event.tree ?? []).flatMap((suite) =>
    (suite.children ?? []).map((t) => ({ suite: suite.name, browser: suite.browser ?? "", test: t })),
  );
}

function junitCount(xml: string, attribute: "tests" | "skipped"): number {
  const root = new RegExp(`<testsuites\\b[^>]*\\b${attribute}="(\\d+)"`).exec(xml);
  if (root === null) throw new Error(`the JUnit report states no root ${attribute}: ${xml.slice(0, 400)}`);
  return Number(root[1]);
}

function nameAndStatus(entries: StoredStep[]): StoredStep[] {
  return entries.map(({ name, status }) => ({ name, status }));
}

const DRIVE_BUDGET_MS = 300_000;

afterAll(() => {
  proxy?.stop();
  handle?.stop();
  proxy = undefined;
  handle = undefined;
  if (scratchDir !== undefined) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = undefined;
});

describe("the playwright-bdd fixture streams its run through the bun client", () => {
  test(
    "the run is closed by its stream: opened, streamed and closed, never client-parsed, as one `playwright-bdd` run with nothing incomplete",
    async () => {
      const run = await drive();
      const event = ingested(run);

      expect(event.framework).toBe(FRAMEWORK);
      expect(event.codec).toBe(STREAM_CODEC);
      expect(event.tier).toBe("bdd");
      expect(event.incomplete).toBeUndefined();
      expect(run.posts).toContain(START_ROUTE);
      expect(run.posts.filter((path) => STREAM_ROUTE.test(path)).length).toBeGreaterThan(0);
      expect(run.posts).toContain(CLOSE_ROUTE);
      expect(run.posts).not.toContain(CLIENT_PARSE_ROUTE);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "the run counts scenarios as the same run's JUnit report does, the never-run dependents as pending",
    async () => {
      const run = await drive();
      const event = ingested(run);

      expect(event.summary?.total).toBe(junitCount(run.junitXml, "tests"));
      expect(event.summary?.pending).toBe(junitCount(run.junitXml, "skipped"));
      // BOUND — the tree holds exactly as many tests as the summary counts.
      expect(placedTests(event).length).toBe(event.summary?.total ?? -1);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "each scenario sits under its feature and browser, as the feature files and the fixture's projects declare",
    async () => {
      const run = await drive();
      const event = ingested(run);

      const expected: string[] = [];
      for (const feature of declaredFeatures()) {
        for (const browser of PROJECTS_BY_TAG[feature.tag] ?? []) {
          for (const scenario of feature.scenarios) expected.push(`${browser}|${scenario.suite}|${scenario.name}`);
        }
      }
      const stored = placedTests(event).map((p) => `${p.browser}|${p.suite}|${p.test.name}`);
      expect(stored.length).toBe(expected.length);
      expect(new Set(stored)).toEqual(new Set(expected));
      // Each pair appears once: no scenario is stored twice under one browser.
      expect(new Set(stored).size).toBe(stored.length);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "each scenario's steps equal, by name, status and order, the steps its feature file declares as they run",
    async () => {
      const run = await drive();
      const event = ingested(run);
      const expectedOf = new Map<string, StoredStep[]>();
      for (const feature of declaredFeatures()) {
        for (const scenario of feature.scenarios) {
          expectedOf.set(`${scenario.suite}${SEP}${scenario.name}`, stepsAsTheyRun(feature, scenario));
        }
      }

      const wrong: string[] = [];
      for (const placed of placedTests(event)) {
        const expected = expectedOf.get(`${placed.suite}${SEP}${placed.test.name}`);
        if (expected === undefined) {
          wrong.push(`${placed.browser}: ${placed.suite} › ${placed.test.name}: declared by no feature file`);
          continue;
        }
        const stored = nameAndStatus(placed.test.steps ?? []);
        if (JSON.stringify(stored) !== JSON.stringify(expected)) {
          wrong.push(`${placed.browser}: ${placed.suite} › ${placed.test.name}: ${JSON.stringify(stored)} != ${JSON.stringify(expected)}`);
        }
      }
      expect(wrong).toEqual([]);
      // BOUND — the comparison covered steps, a failing step among them, not only empty scenarios.
      expect(placedTests(event).some((p) => (p.test.steps ?? []).length > 1)).toBe(true);
      expect(placedTests(event).some((p) => (p.test.steps ?? []).some((step) => step.status === "fail"))).toBe(true);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "the drive writes nothing to the package's test-reports, nor to this repo's Playwright report paths",
    async () => {
      const run = await drive();
      ingested(run);
      expect(run.packageReportsAfter).toBe(false);
      expect(run.repoReportsAfter).toEqual(run.repoReportsBefore);
    },
    DRIVE_BUDGET_MS,
  );
});
