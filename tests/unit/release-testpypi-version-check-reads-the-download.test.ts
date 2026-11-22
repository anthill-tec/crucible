// The TestPyPI rehearsal's version check reads the version of the files it
// uploads.
//
// `publish-testpypi` in the release workflow carries one step named
// "Version sanity — reject PEP 440 local segment ('+')". TestPyPI rejects a
// PEP 440 local version, so the step exists to fail early and clearly on one.
// It can only check what the job uploads if it reads the `dist/` files the
// job downloaded from `build`: so it runs after the `actions/download-artifact`
// step and before the `pypa/gh-action-pypi-publish` step, and it never
// rebuilds them.
//
// The step is plain shell, and no failure in it is hidden: its code lines
// (comment lines dropped) hold no `|| true`, no redirect to `/dev/null`, no
// `python` or `pip` token, and no `${{ … }}` expression, so it can be run
// verbatim. Python no longer runs in the job, and no step reads the
// repository: the job carries no `actions/setup-python` step and no
// `actions/checkout` step.
//
// Read through `Bun.YAML.parse`, as the other workflow tests in this suite
// read it. Every test finds the step by its name, exactly once.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");

const JOB = "publish-testpypi";
const VERSION_STEP_NAME = "Version sanity — reject PEP 440 local segment ('+')";

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

function describeStep(step: WorkflowStep, index: number): string {
  if (step.uses) return `[${index}] uses: ${step.uses}`;
  return `[${index}] ${step.name ? `name: ${step.name}` : `run: ${(step.run ?? "").trim().split("\n")[0]}`}`;
}

function usesAction(step: WorkflowStep, action: string): boolean {
  if (typeof step.uses !== "string") return false;
  const uses = step.uses.trim();
  return uses === action || uses.startsWith(`${action}@`);
}

/** The job's steps, and the index of the one version step found by its name. */
function locateVersionStep(): { steps: WorkflowStep[]; at: number; inventory: string } {
  const steps = stepsOf(readWorkflow(), JOB);
  const inventory = steps.map(describeStep).join("\n  ");
  const matches = steps.flatMap((step, index) => (step.name === VERSION_STEP_NAME ? [index] : []));
  expect(
    matches.length,
    `release.yml job '${JOB}' must carry exactly one step named "${VERSION_STEP_NAME}":\n  ${inventory}`,
  ).toBe(1);
  const at = matches[0] as number;
  expect(typeof steps[at]?.run, `the version step must be a \`run\` step:\n  ${inventory}`).toBe("string");
  return { steps, at, inventory };
}

/** The body's shell lines with comment-only lines removed. */
function codeLines(body: string): string[] {
  return body.split("\n").filter((line) => !/^\s*#/.test(line));
}

// What a code line of the version step must never hold, each with its reason.
const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: "`|| true` (hides a failure)", pattern: /\|\|\s*true\b/ },
  { label: "`/dev/null` (hides output)", pattern: /\/dev\/null/ },
  {
    label: "a `python` or `pip` token (the step is plain shell)",
    pattern: /(?<![A-Za-z0-9_-])(?:python|pip)[0-9.]*(?![A-Za-z0-9_-])/,
  },
  { label: "a `${{` expression (the step must run verbatim)", pattern: /\$\{\{/ },
];

describe("the TestPyPI version check reads the version of the files the job downloaded", () => {
  test("the version step runs after the actions/download-artifact step and before the pypa/gh-action-pypi-publish step", () => {
    const { steps, at, inventory } = locateVersionStep();
    const downloadAt = steps.findIndex((step) => usesAction(step, "actions/download-artifact"));
    const publishAt = steps.findIndex((step) => usesAction(step, "pypa/gh-action-pypi-publish"));

    expect(downloadAt, `job '${JOB}' has no actions/download-artifact step:\n  ${inventory}`).toBeGreaterThanOrEqual(0);
    expect(publishAt, `job '${JOB}' has no pypa/gh-action-pypi-publish step:\n  ${inventory}`).toBeGreaterThanOrEqual(0);
    expect(
      at,
      `the version step [${at}] must come after the download step [${downloadAt}], so it reads the files the job uploads:\n  ${inventory}`,
    ).toBeGreaterThan(downloadAt);
    expect(
      at,
      `the version step [${at}] must come before the publish step [${publishAt}]:\n  ${inventory}`,
    ).toBeLessThan(publishAt);
  });

  test("the version step's code lines hold no `|| true`, no `/dev/null`, no python or pip token and no `${{` expression", () => {
    const { steps, at } = locateVersionStep();
    const lines = codeLines(steps[at]?.run as string);
    const offenders: string[] = [];
    for (const line of lines) {
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(line)) offenders.push(`${label}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the publish-testpypi job carries no actions/setup-python step: python no longer runs in it", () => {
    const { steps, inventory } = locateVersionStep();
    const setups = steps.flatMap((step, index) => (usesAction(step, "actions/setup-python") ? [index] : []));
    expect(setups, `job '${JOB}' still sets up python:\n  ${inventory}`).toEqual([]);
  });

  test("the publish-testpypi job carries no actions/checkout step: no step reads the repository", () => {
    const { steps, inventory } = locateVersionStep();
    const checkouts = steps.flatMap((step, index) => (usesAction(step, "actions/checkout") ? [index] : []));
    expect(checkouts, `job '${JOB}' still checks out the repository:\n  ${inventory}`).toEqual([]);
  });
});
