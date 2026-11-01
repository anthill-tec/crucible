// This repo's `playwright.config.ts` adds the shipped Crucible reporter from
// `CRUCIBLE_REPORTERS`, and only when that variable is set. Its kept `junit`
// and `json` reporters still take their files from
// `PLAYWRIGHT_JUNIT_OUTPUT_NAME` and `PLAYWRIGHT_JSON_OUTPUT_NAME`.
//
// The config is read as Playwright reads it: imported, in a FRESH child
// process per environment. Its reporter list is fixed at import time, so one
// process cannot show both branches.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const REPORTERS_VAR = "CRUCIBLE_REPORTERS";
const JUNIT_VAR = "PLAYWRIGHT_JUNIT_OUTPUT_NAME";
const JSON_VAR = "PLAYWRIGHT_JSON_OUTPUT_NAME";
const REPORTER_FILE = "playwright-crucible.ts";
const REPORTERS_DIR = join(REPO_ROOT, "clients", "reporters");
const HANDED_JUNIT = "/tmp/a-run-reports-dir/junit.xml";
const HANDED_JSON = "/tmp/a-run-reports-dir/playwright.json";
const LOAD_BUDGET_MS = 60_000;

type ReporterEntry = [string, Record<string, unknown>?];

/** The config's `reporter` list, imported under `env` in a fresh child. */
async function reportersUnder(env: Record<string, string | undefined>): Promise<ReporterEntry[]> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of [REPORTERS_VAR, JUNIT_VAR, JSON_VAR, "CRUCIBLE_STREAM"]) delete childEnv[key];
  Object.assign(childEnv, env);
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      "const cfg = (await import('./playwright.config.ts')).default;" +
        "process.stdout.write(JSON.stringify(cfg.reporter));",
    ],
    { cwd: REPO_ROOT, env: childEnv, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, `importing playwright.config.ts exited ${String(code)}: ${stderr}`).toBe(0);
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
    "with CRUCIBLE_REPORTERS set it adds <CRUCIBLE_REPORTERS>/playwright-crucible.ts once, beside the kept junit and json reporters, and without it adds nothing",
    async () => {
      const handed = await reportersUnder({
        [REPORTERS_VAR]: REPORTERS_DIR,
        [JUNIT_VAR]: HANDED_JUNIT,
        [JSON_VAR]: HANDED_JSON,
      });
      expect(crucibleEntries(handed, REPORTERS_DIR)).toHaveLength(1);
      expect(namesOf(handed)).toContain("junit");
      expect(namesOf(handed)).toContain("json");

      const bare = await reportersUnder({ [JUNIT_VAR]: HANDED_JUNIT, [JSON_VAR]: HANDED_JSON });
      expect(namesOf(bare).filter((name) => name.includes(REPORTER_FILE))).toEqual([]);
      expect(namesOf(bare)).toEqual(
        namesOf(handed).filter((name) => resolve(name) !== resolve(REPORTERS_DIR, REPORTER_FILE)),
      );
    },
    LOAD_BUDGET_MS,
  );

  test(
    "the kept junit and json reporters still write where PLAYWRIGHT_JUNIT_OUTPUT_NAME and PLAYWRIGHT_JSON_OUTPUT_NAME name, with the Crucible reporter added",
    async () => {
      const handed = await reportersUnder({
        [REPORTERS_VAR]: REPORTERS_DIR,
        [JUNIT_VAR]: HANDED_JUNIT,
        [JSON_VAR]: HANDED_JSON,
      });
      expect(crucibleEntries(handed, REPORTERS_DIR)).toHaveLength(1);
      const junit = handed.filter(([name]) => name === "junit");
      const json = handed.filter(([name]) => name === "json");
      expect(junit.map(([, options]) => options?.["outputFile"])).toEqual([HANDED_JUNIT]);
      expect(json.map(([, options]) => options?.["outputFile"])).toEqual([HANDED_JSON]);
    },
    LOAD_BUDGET_MS,
  );
});
