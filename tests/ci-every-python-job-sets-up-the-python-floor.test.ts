// Every CI job that runs python sets up python 3.14, the declared floor.
//
// The release workflow has four jobs that run python: `build` (python -m
// build), `test-python` (the client suite), `test-bun` (the bun suite spawns
// the python client fleet) and `publish-testpypi` (python -m build for its
// version check). A job with no `actions/setup-python` step runs on whatever
// python the runner image ships, and a setup naming `3.x` floats with the
// newest release, so neither is tied to the floor.
//
// Each of the four must carry exactly one `actions/setup-python` step whose
// `python-version` input is the string "3.14" (quoted: an unquoted YAML
// version is a float, and `3.10` would read as `3.1`), placed before the
// first step that runs python. No setup-python step anywhere in the workflow
// names another version.
//
// Read through `Bun.YAML.parse`, as the other workflow tests in this suite
// read it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");

const THE_FLOOR = "3.14";
const JOBS_THAT_RUN_PYTHON = ["build", "test-python", "test-bun", "publish-testpypi"] as const;

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = { steps?: WorkflowStep[] };

type ReleaseWorkflow = { jobs?: Record<string, WorkflowJob> };

function readWorkflow(): ReleaseWorkflow {
  return Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, "utf8")) as ReleaseWorkflow;
}

function stepsOf(workflow: ReleaseWorkflow, job: string): WorkflowStep[] {
  const steps = workflow.jobs?.[job]?.steps;
  expect(Array.isArray(steps), `release.yml job '${job}' declares no steps`).toBe(true);
  return steps as WorkflowStep[];
}

function isSetupPython(step: WorkflowStep): boolean {
  return typeof step.uses === "string" && /^actions\/setup-python(?:@|$)/.test(step.uses.trim());
}

// A step that runs python: a python/pip invocation, a `python -m` module, or
// the bun suite, which spawns the python client fleet through `uv run`.
function runsPython(step: WorkflowStep): boolean {
  const run = step.run;
  if (typeof run !== "string") return false;
  return /(?:^|[\s;&|(])(?:python3?(?:\.\d+)?|pip3?)\s/m.test(run) || /\bbun\s+test\b/.test(run);
}

function describeStep(step: WorkflowStep, index: number): string {
  if (step.uses) return `[${index}] uses: ${step.uses} with ${JSON.stringify(step.with ?? {})}`;
  return `[${index}] run: ${(step.run ?? "").trim().split("\n")[0]}`;
}

describe("the step predicates read a workflow as the jobs run it", () => {
  test("a python, pip or bun-suite run step runs python; a bun install does not", () => {
    expect(runsPython({ run: "python -m pip install --upgrade build twine" })).toBe(true);
    expect(runsPython({ run: "python3 -m unittest discover -s tests/client -t ." })).toBe(true);
    expect(runsPython({ run: "bun test --timeout 30000" })).toBe(true);
    expect(runsPython({ run: "bun install --frozen-lockfile" })).toBe(false);
    expect(runsPython({ run: "bunx playwright install --with-deps chromium webkit" })).toBe(false);
    expect(runsPython({ uses: "actions/setup-python@v6" })).toBe(false);
  });

  test("only an actions/setup-python step is a python setup", () => {
    expect(isSetupPython({ uses: "actions/setup-python@v6" })).toBe(true);
    expect(isSetupPython({ uses: "astral-sh/setup-uv@v7" })).toBe(false);
    expect(isSetupPython({ run: "python -m pip install build" })).toBe(false);
  });
});

describe("every CI job that runs python sets up python 3.14", () => {
  for (const job of JOBS_THAT_RUN_PYTHON) {
    test(`${job} runs python, so it carries exactly one setup-python step naming "${THE_FLOOR}"`, () => {
      const steps = stepsOf(readWorkflow(), job);
      const inventory = steps.map(describeStep).join("\n  ");

      expect(steps.some(runsPython), `job '${job}' runs no python step:\n  ${inventory}`).toBe(true);

      const setups = steps.filter(isSetupPython);
      expect(setups.length, `job '${job}' must carry exactly one actions/setup-python step:\n  ${inventory}`).toBe(1);
      expect(setups[0]?.with?.["python-version"], `job '${job}' setup-python python-version:\n  ${inventory}`).toBe(
        THE_FLOOR,
      );
    });

    test(`${job} sets up python before its first step that runs python`, () => {
      const steps = stepsOf(readWorkflow(), job);
      const inventory = steps.map(describeStep).join("\n  ");
      const setupAt = steps.findIndex(isSetupPython);
      const firstPythonAt = steps.findIndex(runsPython);

      expect(setupAt, `job '${job}' has no actions/setup-python step:\n  ${inventory}`).toBeGreaterThanOrEqual(0);
      expect(firstPythonAt).toBeGreaterThanOrEqual(0);
      expect(setupAt, `job '${job}' must set up python before step [${firstPythonAt}]:\n  ${inventory}`).toBeLessThan(
        firstPythonAt,
      );
    });
  }

  test(`no setup-python step anywhere in the workflow names a version other than "${THE_FLOOR}"`, () => {
    const workflow = readWorkflow();
    const offenders: string[] = [];
    for (const [job, body] of Object.entries(workflow.jobs ?? {})) {
      for (const step of body.steps ?? []) {
        if (isSetupPython(step) && step.with?.["python-version"] !== THE_FLOOR) {
          offenders.push(`${job}: python-version ${JSON.stringify(step.with?.["python-version"])}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
