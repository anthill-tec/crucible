// This repo's `playwright.config.ts` adds the shipped Crucible reporter from
// `CRUCIBLE_REPORTERS`, and only when that variable is set. Its kept `junit`
// reporter still takes its file from `PLAYWRIGHT_JUNIT_OUTPUT_NAME`.
// Playwright's JSON report is retired: neither this config nor the fixture
// project's (tests/fixtures/playwright-bdd-project) configures a `json`
// reporter, whatever path variable the environment carries.
//
// The config is read as Playwright reads it: imported, in a FRESH child
// process per environment. Its reporter list is fixed at import time, so one
// process cannot show both branches.
import { describe, expect, test } from "bun:test";
import { TEST_INSTALL_CLIENTS } from "./helpers/test-install.ts";
import { join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const REPORTERS_VAR = "CRUCIBLE_REPORTERS";
const JUNIT_VAR = "PLAYWRIGHT_JUNIT_OUTPUT_NAME";
const JSON_VAR = "PLAYWRIGHT_JSON_OUTPUT_NAME";
const REPORTER_FILE = "playwright-crucible.ts";
// A reporter Playwright LOADS is reached through the test install (CR-CRU-260).
const REPORTERS_DIR = join(TEST_INSTALL_CLIENTS, "reporters");
const FIXTURE_PROJECT = join(REPO_ROOT, "tests", "fixtures", "playwright-bdd-project");
const FIXTURE_JUNIT_VAR = "FIXTURE_JUNIT_PATH";
const FIXTURE_JSON_VAR = "FIXTURE_JSON_PATH";
const HANDED_JUNIT = "/tmp/a-run-reports-dir/junit.xml";
const HANDED_JSON = "/tmp/a-run-reports-dir/playwright.json";
const LOAD_BUDGET_MS = 60_000;

type ReporterEntry = [string, Record<string, unknown>?];

/** The `reporter` list of the `playwright.config.ts` in `cwd` (this repo's by
 *  default), imported under `env` in a fresh child. */
async function reportersUnder(
  env: Record<string, string | undefined>,
  cwd: string = REPO_ROOT,
): Promise<ReporterEntry[]> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of [REPORTERS_VAR, JUNIT_VAR, JSON_VAR, FIXTURE_JUNIT_VAR, FIXTURE_JSON_VAR, "CRUCIBLE_STREAM"]) {
    delete childEnv[key];
  }
  Object.assign(childEnv, env);
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      "const cfg = (await import('./playwright.config.ts')).default;" +
        "process.stdout.write(JSON.stringify(cfg.reporter));",
    ],
    { cwd, env: childEnv, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, `importing ${cwd}/playwright.config.ts exited ${String(code)}: ${stderr}`).toBe(0);
  return JSON.parse(stdout) as ReporterEntry[];
}

function crucibleEntries(reporters: ReporterEntry[], dir: string): ReporterEntry[] {
  const wanted = resolve(dir, REPORTER_FILE);
  return reporters.filter(([name]) => name.endsWith(REPORTER_FILE) && resolve(name) === wanted);
}

function namesOf(reporters: ReporterEntry[]): string[] {
  return reporters.map(([name]) => name);
}

describe("playwright.config.ts adds the Crucible reporter only when it is handed one", () => {
  test(
    "with CRUCIBLE_REPORTERS set it adds <CRUCIBLE_REPORTERS>/playwright-crucible.ts once, beside the kept junit reporter, and without it adds nothing",
    async () => {
      const handed = await reportersUnder({
        [REPORTERS_VAR]: REPORTERS_DIR,
        [JUNIT_VAR]: HANDED_JUNIT,
        [JSON_VAR]: HANDED_JSON,
      });
      expect(crucibleEntries(handed, REPORTERS_DIR)).toHaveLength(1);
      expect(namesOf(handed)).toContain("junit");

      const bare = await reportersUnder({ [JUNIT_VAR]: HANDED_JUNIT, [JSON_VAR]: HANDED_JSON });
      expect(namesOf(bare).filter((name) => name.includes(REPORTER_FILE))).toEqual([]);
      expect(namesOf(bare)).toEqual(
        namesOf(handed).filter((name) => resolve(name) !== resolve(REPORTERS_DIR, REPORTER_FILE)),
      );
    },
    LOAD_BUDGET_MS,
  );

  test(
    "the kept junit reporter still writes where PLAYWRIGHT_JUNIT_OUTPUT_NAME names, with the Crucible reporter added, and no json reporter is configured even with PLAYWRIGHT_JSON_OUTPUT_NAME set",
    async () => {
      const handed = await reportersUnder({
        [REPORTERS_VAR]: REPORTERS_DIR,
        [JUNIT_VAR]: HANDED_JUNIT,
        [JSON_VAR]: HANDED_JSON,
      });
      expect(crucibleEntries(handed, REPORTERS_DIR)).toHaveLength(1);
      const junit = handed.filter(([name]) => name === "junit");
      expect(junit.map(([, options]) => options?.["outputFile"])).toEqual([HANDED_JUNIT]);
      expect(namesOf(handed)).not.toContain("json");
      expect(handed.filter(([, options]) => options?.["outputFile"] === HANDED_JSON)).toEqual([]);

      const bare = await reportersUnder({});
      expect(namesOf(bare)).not.toContain("json");
    },
    LOAD_BUDGET_MS,
  );
});

describe("the playwright-bdd fixture project's config configures no json reporter", () => {
  test(
    "with FIXTURE_JUNIT_PATH, FIXTURE_JSON_PATH and CRUCIBLE_REPORTERS all set it keeps the junit reporter at FIXTURE_JUNIT_PATH and adds the Crucible reporter, and no json reporter",
    async () => {
      const handed = await reportersUnder(
        {
          [REPORTERS_VAR]: REPORTERS_DIR,
          [FIXTURE_JUNIT_VAR]: HANDED_JUNIT,
          [FIXTURE_JSON_VAR]: HANDED_JSON,
        },
        FIXTURE_PROJECT,
      );
      expect(crucibleEntries(handed, REPORTERS_DIR)).toHaveLength(1);
      const junit = handed.filter(([name]) => name === "junit");
      expect(junit.map(([, options]) => options?.["outputFile"])).toEqual([HANDED_JUNIT]);
      expect(namesOf(handed)).not.toContain("json");
      expect(handed.filter(([, options]) => options?.["outputFile"] === HANDED_JSON)).toEqual([]);
    },
    LOAD_BUDGET_MS,
  );
});
