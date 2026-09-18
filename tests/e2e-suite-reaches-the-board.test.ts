// CR-CRU-015 C1 (RED) — the BDD-driven e2e suite reaches the board, with its
// scenarios intact.
//
// Spec: docs/changes/CR-CRU-015-bdd-harness.md
//   §S1 the e2e suite is BDD-driven, files as `e2e`, and reaches the board at
//       all — no rename, no `test:bdd`, no tier change; the ingest carries
//       SCENARIO-LEVEL detail rather than a pass/fail total
//   §S2 the `"playwright"` codec that already parses the Gherkin gets a
//       CALLER — the harness posts the RAW playwright JSON report with
//       `codec: "playwright"` to POST /api/v2/runs, and the SERVER decodes it.
//       `POST /api/v2/runs/parsed` is REFUSED for this suite: a client-side
//       parse flattens the Gherkin before the server ever sees it and stores
//       `codec: "parsed"`.
//
// §S3 (the BDD UI section) and §S4 (the queue row) are LATER cycles and are
// not touched here.
//
// ── GROUND TRUTH, MEASURED ON THIS BRANCH (2026-09-18) ────────────────────
//
// A real drive of the shipped client — `bun-crucible.py e2e --agent <id>
// --project-dir <scratch> --package-dir <repo>` against an ephemeral board —
// completed in 66s and DID ingest. What it stored is the defect:
//
//   codec = "parsed"          (the CLIENT parsed; §S2 requires "playwright")
//   tier  = "e2e"             (correct, and §S1 says it must stay that way)
//   summary = {total: 46, passed: 45, failed: 1}
//   tree  = 16 nodes, one per generated SPEC FILE, e.g.
//           "tests/e2e/features/roadmap.feature.spec.js"
//           children = ONE leaf per scenario, named "<Feature> › <Scenario>"
//
// So the run reaches the board already (CR-CRU-133 wired the declared target's
// report mechanism) — what never reaches it is the SPECIFICATION. Every leaf
// is a whole scenario collapsed to a verdict; not one `Given`/`When`/`Then`
// survives, because the JUnit the client parses has no notion of a step.
//
// The same run's report, decoded by the codec this CR points at (measured by
// feeding a real `--reporter=json` report through `src/codecs/playwright.ts`):
//
//   tree  = one node PER SCENARIO, named "<Feature title> › <Scenario title>"
//   children = one leaf PER GHERKIN STEP, in step order, `name` being the
//              literal step line ("Given …", "When …", "And …", "Then …")
//   a failing step carries its own `failure.message`, and the steps AFTER it
//   are absent (Playwright halts the `test.step()` chain at the first error).
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
// ── WHY EACH ASSERTION FAILS TODAY ───────────────────────────────────────
//
//   1  (§S1 declaration guard) BORN GREEN, deliberately — a regression rail,
//      the shape tests/ci-toolchain-provisioning.test.ts documents for its own
//      assertions 5 and 6. `test:e2e` is declared, is the BDD harness, and has
//      no renamed twin TODAY; the criterion is that it cannot silently stop
//      being so, and contorting a rename guard into failing would pin nothing.
//   2  (§S1 ingested, scenario-addressed) FAILS: the stored tree holds 16
//      spec-FILE nodes, so no node is named "<Feature> › <Scenario>".
//   3  (§S1 scenario-level detail) FAILS: `summary.total` equals the scenario
//      count exactly — the event IS a per-scenario tally, with no step below
//      any node.
//   4  (§S2 codec) FAILS: the stored `codec` is "parsed", and the ingest was
//      POSTed to /api/v2/runs/parsed rather than /api/v2/runs.
//   5  (§S2 Gherkin structure) FAILS: a scenario's node holds no step leaves
//      at all, so the ordered step text cannot be compared.
//   6  (§S2 failure on the failing STEP) FAILS: the deliberately broken step
//      has no leaf of its own; the message lands on the whole scenario.
//
// `tests/playwright-codec.test.ts` is deliberately NOT touched by any of this
// (§S2's last criterion): this CR adds a caller, it does not rewrite the
// parser, and the codec's own unit coverage stays exactly as it is.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { declareClientBoard } from "./helpers/client-board.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CLIENT = join(REPO_ROOT, "clients", "bun-crucible.py");
const FEATURES_DIR = join(REPO_ROOT, "tests", "e2e", "features");
const STEPS_DIR = join(REPO_ROOT, "tests", "e2e", "steps");
const AGENT = "e2e-suite-ingest-fixture";

/** The declared target this suite is collected under — §S1's whole point is
 *  that this string does not move. */
const E2E_TARGET = "test:e2e";

/** The codec §S2 rules the server must decode this suite's report with, and
 *  the two that would mean it did not: the client's own pre-parse
 *  (`runs/parsed`) and the flattening JUnit default. */
const REQUIRED_CODEC = "playwright";
const FLATTENING_CODECS = ["junit", "parsed"];

/** The route §S2 rules the ingest must take, and the one it must not. */
const SERVER_DECODE_ROUTE = "/api/v2/runs";
const CLIENT_PARSE_ROUTE = "/api/v2/runs/parsed";

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

interface StoredLeaf {
  name: string;
  status: string;
  duration_ms?: number;
  failure?: { message?: string; trace?: string; type?: string };
}

interface StoredSuite {
  name: string;
  status: string;
  children?: StoredLeaf[];
}

interface StoredEvent {
  id: string;
  kind?: string;
  tier?: string;
  codec?: string;
  summary?: { total: number; passed: number; failed: number; pending?: number };
  tree?: StoredSuite[];
}

interface Drive {
  /** Every non-lifecycle event the drive filed. */
  events: StoredEvent[];
  /** The POST paths the client actually hit, in order. */
  posts: string[];
  /** The scenarios the suite declared for THIS drive, temporary one included. */
  declared: DeclaredScenario[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

let handle: ServerHandle | undefined;
let proxy: { url: string; posts: string[]; stop(): void } | undefined;
let driven: Promise<Drive> | undefined;

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
      join(scratch, "test-reports"),
    ],
    scratch,
  );

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

function nodeNamed(event: StoredEvent, name: string): StoredSuite | undefined {
  return (event.tree ?? []).find((node) => node.name === name);
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
});

describe("CR-CRU-015 §S1 — the BDD suite's declaration cannot be renamed or retiered", () => {
  test("the BDD suite is declared as `test:e2e`, with no renamed twin and no second target", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      crucible?: { reportPath?: Record<string, string> };
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

    // CR-CRU-133's declaration rides the same manifest: the report mechanism
    // is declared FOR this target, and for no target the script table does
    // not declare.
    const reportPath = manifest.crucible?.reportPath ?? {};
    expect(Object.keys(reportPath)).toContain(E2E_TARGET);
    expect(Object.keys(reportPath).filter((target) => scripts[target] === undefined)).toEqual([]);
  });
});

describe("CR-CRU-015 §S1/§S2 — a real client drive of the e2e suite lands the Gherkin on the board", () => {
  test(
    "the drive files ONE run, under tier `e2e`, addressed by scenario rather than by spec file",
    async () => {
      const run = await drive();
      const event = ingested(run);

      // §S1 — no rename of the TIER either: the run this target files is e2e.
      expect(event.tier).toBe("e2e");

      // The stored tree is addressed the way a specification is read: one node
      // per SCENARIO, named "<Feature> › <Scenario>". Today it is one node per
      // generated spec FILE, so every name below is missing.
      const names = (event.tree ?? []).map((node) => node.name);
      const missing = run.declared.filter((scenario) => !names.includes(scenario.node));
      expect(missing.map((scenario) => scenario.node)).toEqual([]);

      // NEGATIVE/bound — and NOTHING else is a node. A tree that also carried
      // the spec files, or a second copy of each scenario, would pass the
      // containment check above while being a different shape.
      expect(names.length).toBe(run.declared.length);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "the ingest carries scenario-level detail — every scenario holds its own steps, not a single verdict",
    async () => {
      const run = await drive();
      const event = ingested(run);

      // Every scenario node holds leaves, and there are as many of them as the
      // scenario declares steps (bar the steps Playwright never reached — a
      // broken step halts the chain, which is why this is a bound and not an
      // equality).
      const childless = (event.tree ?? []).filter((node) => (node.children ?? []).length === 0);
      expect(childless.map((node) => node.name)).toEqual([]);

      // POSITIVE, with the specific number: the run's own total counts STEPS.
      // The suite declares far more steps than scenarios, so an event whose
      // total is the scenario count is a tally of verdicts and nothing more —
      // which is exactly what 46 testcases through JUnit produce today.
      const declaredSteps = run.declared.reduce((sum, scenario) => sum + scenario.steps.length, 0);
      expect(declaredSteps).toBeGreaterThan(run.declared.length);
      expect(event.summary?.total).not.toBe(run.declared.length);
      expect(event.summary?.total).toBeGreaterThan(run.declared.length);
      expect(event.summary?.total).toBeLessThanOrEqual(declaredSteps);
    },
    DRIVE_BUDGET_MS,
  );

  test(
    "the run is decoded by the `playwright` codec ON THE SERVER — never junit, never a client-side parse",
    async () => {
      const run = await drive();
      const event = ingested(run);

      // §S2 — the stored provenance. `junit` would have flattened the steps
      // into counts; `parsed` means the client decided the shape and the
      // server recorded a tree no codec vouches for.
      expect(FLATTENING_CODECS).not.toContain(event.codec);
      expect(event.codec).toBe(REQUIRED_CODEC);

      // …and the ROUTE that provenance can only come from. Read off the
      // proxy, so this is the request the client really made.
      expect(run.posts).toContain(SERVER_DECODE_ROUTE);
      expect(run.posts).not.toContain(CLIENT_PARSE_ROUTE);
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
        const node = nodeNamed(event, scenario.node);
        if (node === undefined) {
          wrong.push(`${scenario.node}: no node`);
          continue;
        }
        const leaves = (node.children ?? []).map((leaf) => leaf.name);
        const expected = scenario.steps.slice(0, leaves.length);
        if (JSON.stringify(leaves) !== JSON.stringify(expected)) {
          wrong.push(`${scenario.node}: ${JSON.stringify(leaves)} != ${JSON.stringify(expected)}`);
          continue;
        }
        if (node.status === "pass" && leaves.length !== scenario.steps.length) {
          wrong.push(
            `${scenario.node}: passed with ${leaves.length} of ${scenario.steps.length} steps`,
          );
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
      const node = nodeNamed(event, broken!.node);
      expect(node).toBeDefined();
      expect(node!.status).toBe("fail");

      const leaves = node!.children ?? [];
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
});
