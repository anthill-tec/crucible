// The release workflow's build job checks the artifacts it built strictly.
//
// `python -m build` writes the sdist and the wheel into dist/, and
// `twine check` reads their metadata. Without `--strict`, twine only warns
// on a metadata problem (a missing long description, an unknown content
// type) and the build goes green; with it, the same warning fails the job
// before anything is uploaded. So the build job must run
// `twine check --strict dist/*`, and must run it after `python -m build`,
// or it checks nothing that build produced.
//
// The job's commands are read the way the runner executes them: step by
// step, and within a step's `run` block line by line, so a build and a check
// sharing one block are ordered by their lines. Shell comments are not
// commands, a `\` continuation joins its lines, and `&&`, `||` and `;` split a
// line into its commands. A `twine check` without `--strict` does not count.
//
// Read through `Bun.YAML.parse`, as the other workflow tests in this suite
// read it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
};

type WorkflowJob = { steps?: WorkflowStep[] };

type ReleaseWorkflow = { jobs?: Record<string, WorkflowJob> };

// One shell command in the job, with where it sits: the step's index, the
// 1-based line of the step's `run` block it starts on, and its order among
// the commands on that line.
type Command = {
  step: number;
  stepName: string;
  line: number;
  segment: number;
  argv: string[];
};

function readWorkflow(): ReleaseWorkflow {
  return Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, "utf8")) as ReleaseWorkflow;
}

function stepsOf(workflow: ReleaseWorkflow, job: string): WorkflowStep[] {
  const steps = workflow.jobs?.[job]?.steps;
  expect(Array.isArray(steps), `release.yml job '${job}' declares no steps`).toBe(true);
  return steps as WorkflowStep[];
}

function unquote(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, "$2");
}

// Every command a job's steps run, in the order the runner reaches them.
function commandsOf(steps: WorkflowStep[]): Command[] {
  const commands: Command[] = [];
  steps.forEach((step, stepIndex) => {
    if (typeof step.run !== "string") return;
    const stepName = step.name ?? `(unnamed step ${stepIndex})`;
    const rawLines = step.run.split("\n");
    let pending = "";
    let pendingStart = 0;
    rawLines.forEach((rawLine, lineIndex) => {
      if (pending === "") pendingStart = lineIndex + 1;
      const continued = /\\\s*$/.test(rawLine);
      pending += `${continued ? rawLine.replace(/\\\s*$/, "") : rawLine} `;
      if (continued && lineIndex < rawLines.length - 1) return;
      const logical = pending;
      pending = "";
      logical.split(/&&|\|\||;/).forEach((part, segment) => {
        const tokens: string[] = [];
        for (const token of part.trim().split(/\s+/)) {
          if (token === "") continue;
          if (token.startsWith("#")) break;
          tokens.push(unquote(token));
        }
        if (tokens.length > 0) {
          commands.push({ step: stepIndex, stepName, line: pendingStart, segment, argv: tokens });
        }
      });
    });
  });
  return commands;
}

function isPython(token: string | undefined): boolean {
  if (token === undefined) return false;
  const base = token.split("/").pop() ?? "";
  return /^python(?:3(?:\.\d+)?)?$/.test(base);
}

// `python -m build`, wherever it sits in the command (after a `timeout`,
// say). `python -m pip install build` is not a build.
function runsBuild(command: Command): boolean {
  const argv = command.argv;
  return argv.some((token, i) => isPython(token) && argv[i + 1] === "-m" && argv[i + 2] === "build");
}

// The arguments after `twine check` (or `python -m twine check`), or null
// when the command is not a twine check.
function twineCheckArgs(command: Command): string[] | null {
  const argv = command.argv;
  for (let i = 0; i < argv.length - 1; i++) {
    const isTwine = argv[i] === "twine" || (argv[i] === "-m" && isPython(argv[i - 1]) && argv[i + 1] === "twine");
    if (!isTwine) continue;
    const checkAt = argv[i] === "twine" ? i + 1 : i + 2;
    if (argv[checkAt] === "check") return argv.slice(checkAt + 1);
  }
  return null;
}

function comesBefore(a: Command, b: Command): boolean {
  if (a.step !== b.step) return a.step < b.step;
  if (a.line !== b.line) return a.line < b.line;
  return a.segment < b.segment;
}

function where(command: Command): string {
  return `step [${command.step}] '${command.stepName}' line ${command.line}: ${command.argv.join(" ")}`;
}

function describeCheck(command: Command, args: string[], builds: Command[]): string {
  const strictness = args.includes("--strict") ? "with --strict" : "WITHOUT --strict";
  const placed = builds.some((build) => comesBefore(build, command)) ? "after the build" : "NOT after any build";
  return `twine check ${strictness}, ${placed}, at ${where(command)}`;
}

// What the job runs, for the failure message: every build and every check.
function inventory(builds: Command[], checks: { command: Command; args: string[] }[]): string[] {
  const found: string[] = [];
  if (builds.length === 0) found.push("no `python -m build` command");
  for (const build of builds) found.push(`python -m build at ${where(build)}`);
  if (checks.length === 0) found.push("no `twine check` command");
  for (const { command, args } of checks) found.push(describeCheck(command, args, builds));
  return found;
}

describe("the release workflow's build job checks the artifacts it built strictly", () => {
  test("the build job runs `twine check --strict dist/*` after `python -m build`, so a metadata warning fails the build", () => {
    const commands = commandsOf(stepsOf(readWorkflow(), "build"));
    const builds = commands.filter(runsBuild);
    const checks = commands
      .map((command) => ({ command, args: twineCheckArgs(command) }))
      .filter((found): found is { command: Command; args: string[] } => found.args !== null);

    const strictChecksAfterBuild = checks.filter(
      ({ command, args }) =>
        args.includes("--strict") &&
        args.includes("dist/*") &&
        builds.some((build) => comesBefore(build, command)),
    );

    const found = inventory(builds, checks);

    expect(
      strictChecksAfterBuild.length,
      "release.yml's build job must run exactly one `twine check --strict dist/*` after `python -m build`; " +
        `found:\n  ${found.join("\n  ")}`,
    ).toBe(1);
  });
});
