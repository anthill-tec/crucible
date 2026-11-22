// The TestPyPI rehearsal's version check, run as the runner runs it.
//
// `publish-testpypi` in the release workflow carries one step named
// "Version sanity — reject PEP 440 local segment ('+')". It reads the `dist/`
// file names the job downloaded and derives one version from them:
//
//   - a wheel named `crucible_axi-*.whl` carries the text after
//     `crucible_axi-` up to the next `-`; any other wheel name yields the
//     empty version;
//   - an sdist named `crucible_axi-*.tar.gz` carries the text between
//     `crucible_axi-` and `.tar.gz`; any other sdist name yields the empty
//     version.
//
// Its checks run in order, each failure an `::error::` line and exit 1:
//   1. the wheel count and the sdist count are each one — each wrong count is
//      reported, naming the count and the files found, before the step exits;
//   2. neither version is empty — an empty one names its file;
//   3. the two versions agree — a mismatch names both;
//   4. the agreed version holds no `+` — the existing message, word for word.
// On success it prints `derived version: <v>`.
//
// This file EXECUTES the step's real `run:` body (the approach
// tests/integration/release-notes-extractor.test.ts takes with create-release):
// the body is written to a file and run under `bash -e`, as GitHub Actions
// runs a `run:` step with no `shell:`, in a scratch directory whose `dist/`
// holds the planted empty files. Only PATH and HOME reach the body; HOME is a
// scratch directory of the test's own. Stubs named `python`, `python3`, `pip`
// and `pip3` sit first on PATH and exit 0 doing nothing, so a step that names
// python never reaches the host's interpreter, installs nothing and opens no
// network connection. Every spawn is bounded and killed at its bound; each
// test removes its scratch directories.

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");

const JOB = "publish-testpypi";
const VERSION_STEP_NAME = "Version sanity — reject PEP 440 local segment ('+')";

/** The bound on one run of the step; it is killed (SIGKILL) at the bound. */
const STEP_TIMEOUT_MS = 10_000;
/** The bound on one test: the step's bound plus the scratch setup. */
const TEST_TIMEOUT_MS = 20_000;

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

type WorkflowStep = { name?: string; uses?: string; run?: string };
type WorkflowJob = { steps?: WorkflowStep[] };
type Workflow = { jobs?: Record<string, WorkflowJob> };

/** The `run:` body of publish-testpypi's version step, found by its name. */
function versionStepRunBody(): string {
  const parsed = Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, "utf8")) as Workflow;
  const steps = parsed.jobs?.[JOB]?.steps ?? [];
  const bodies = steps.flatMap((s) => (s.name === VERSION_STEP_NAME && typeof s.run === "string" ? [s.run] : []));
  expect(bodies.length, `release.yml job '${JOB}' must carry exactly one run step named "${VERSION_STEP_NAME}"`).toBe(1);
  return bodies[0] as string;
}

interface StepRun {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Every stdout line that begins `::error::`, in order. */
  errors: string[];
}

/**
 * Runs the version step's real body under `bash -e` in a scratch work
 * directory whose `dist/` holds one empty file per given name. The env is
 * PATH (the stub directory first) and a scratch HOME, nothing else.
 */
function runVersionStep(distFiles: string[]): StepRun {
  const body = versionStepRunBody();
  const workDir = scratchDir("testpypi-version-work-");
  const stubDir = scratchDir("testpypi-version-stub-");
  const homeDir = scratchDir("testpypi-version-home-");

  mkdirSync(join(workDir, "dist"));
  for (const name of distFiles) writeFileSync(join(workDir, "dist", name), "");

  for (const tool of ["python", "python3", "pip", "pip3"]) {
    writeFileSync(join(stubDir, tool), "#!/bin/sh\nexit 0\n");
    chmodSync(join(stubDir, tool), 0o755);
  }

  const scriptFile = join(stubDir, "step.sh");
  writeFileSync(scriptFile, body);
  const basePath = process.env.PATH ?? "/usr/bin:/bin";
  const res = Bun.spawnSync({
    cmd: ["bash", "-e", scriptFile],
    cwd: workDir,
    env: { PATH: `${stubDir}:${basePath}`, HOME: homeDir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });

  const stdout = res.stdout.toString();
  return {
    exitCode: res.exitCode,
    timedOut: res.exitedDueToTimeout === true,
    stdout,
    stderr: res.stderr.toString(),
    errors: stdout.split("\n").filter((line) => line.startsWith("::error::")),
  };
}

function transcript(run: StepRun): string {
  return `exit ${String(run.exitCode)}\n--- stdout ---\n${run.stdout}--- stderr ---\n${run.stderr}`;
}

/** The step failed: it finished inside its bound with a non-zero exit. */
function expectFailed(run: StepRun): void {
  expect(run.timedOut, `the step hit its ${String(STEP_TIMEOUT_MS)} ms bound:\n${transcript(run)}`).toBe(false);
  expect(run.exitCode, `the step must fail:\n${transcript(run)}`).not.toBe(0);
}

/** Exactly one `::error::` line, returned. */
function theOneError(run: StepRun): string {
  expect(run.errors.length, `the step must print exactly one ::error:: line:\n${transcript(run)}`).toBe(1);
  return run.errors[0] as string;
}

/** The line names the count `n` as a number of its own (not inside a version). */
function namesCount(line: string, n: number): boolean {
  return new RegExp(`(?<![\\w.])${String(n)}(?![\\w.])`).test(line);
}

const namesWheels = (line: string): boolean => /wheel|\.whl/i.test(line);
const namesSdists = (line: string): boolean => /sdist|\.tar\.gz/i.test(line);

const WHEEL = "crucible_axi-0.5.0.dev3-py3-none-any.whl";
const SDIST = "crucible_axi-0.5.0.dev3.tar.gz";

describe("the TestPyPI version check derives one version from the downloaded dist/ files", () => {
  test(
    "normal: one wheel and one sdist at 0.5.0.dev3 pass and print `derived version: 0.5.0.dev3`",
    () => {
      const run = runVersionStep([WHEEL, SDIST]);
      expect(run.timedOut, transcript(run)).toBe(false);
      expect(run.exitCode, `the step must pass:\n${transcript(run)}`).toBe(0);
      expect(run.errors, transcript(run)).toEqual([]);
      expect(run.stdout.split("\n"), transcript(run)).toContain("derived version: 0.5.0.dev3");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "empty: no wheel and no sdist (the 0.4.0 state) fail, reporting both counts, one ::error:: line each",
    () => {
      const run = runVersionStep([]);
      expectFailed(run);
      expect(run.errors.length, `both counts must be reported, one ::error:: line each:\n${transcript(run)}`).toBe(2);
      const wheelAt = run.errors.findIndex((line) => namesWheels(line) && namesCount(line, 0));
      const sdistAt = run.errors.findIndex((line, i) => i !== wheelAt && namesSdists(line) && namesCount(line, 0));
      expect(wheelAt, `no ::error:: line names the wheel count 0:\n${transcript(run)}`).toBeGreaterThanOrEqual(0);
      expect(sdistAt, `no other ::error:: line names the sdist count 0:\n${transcript(run)}`).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "no wheel: the sdist alone fails on the wheel count, naming the count 0",
    () => {
      const run = runVersionStep([SDIST]);
      expectFailed(run);
      const line = theOneError(run);
      expect(namesWheels(line), `the ::error:: line must name the wheels: ${line}`).toBe(true);
      expect(namesCount(line, 0), `the ::error:: line must name the count 0: ${line}`).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "two wheels: two crucible_axi wheels and one sdist fail on the wheel count, naming the count 2 and both wheels",
    () => {
      const second = "crucible_axi-0.5.0.dev4-py3-none-any.whl";
      const run = runVersionStep([WHEEL, second, SDIST]);
      expectFailed(run);
      const line = theOneError(run);
      expect(namesCount(line, 2), `the ::error:: line must name the count 2: ${line}`).toBe(true);
      expect(line).toContain(WHEEL);
      expect(line).toContain(second);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "no sdist: the wheel alone fails on the sdist count, naming the count 0",
    () => {
      const run = runVersionStep([WHEEL]);
      expectFailed(run);
      const line = theOneError(run);
      expect(namesSdists(line), `the ::error:: line must name the sdists: ${line}`).toBe(true);
      expect(namesCount(line, 0), `the ::error:: line must name the count 0: ${line}`).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "two sdists: one wheel and two crucible_axi sdists fail on the sdist count, naming the count 2 and both sdists",
    () => {
      const second = "crucible_axi-0.5.0.dev4.tar.gz";
      const run = runVersionStep([WHEEL, SDIST, second]);
      expectFailed(run);
      const line = theOneError(run);
      expect(namesCount(line, 2), `the ::error:: line must name the count 2: ${line}`).toBe(true);
      expect(line).toContain(SDIST);
      expect(line).toContain(second);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "foreign sdist: the wheel and other-0.5.0.dev3.tar.gz fail on the empty version, naming that file",
    () => {
      const foreign = "other-0.5.0.dev3.tar.gz";
      const run = runVersionStep([WHEEL, foreign]);
      expectFailed(run);
      const line = theOneError(run);
      expect(line).toContain(foreign);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "mismatch: a 0.5.0.dev3 wheel and a 0.5.0.dev4 sdist fail because the versions differ, naming both",
    () => {
      const run = runVersionStep([WHEEL, "crucible_axi-0.5.0.dev4.tar.gz"]);
      expectFailed(run);
      const line = theOneError(run);
      expect(line).toContain("0.5.0.dev3");
      expect(line).toContain("0.5.0.dev4");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "local: a wheel and an sdist both at 0.5.0+g1 fail with the existing '+' message, word for word",
    () => {
      const run = runVersionStep(["crucible_axi-0.5.0+g1-py3-none-any.whl", "crucible_axi-0.5.0+g1.tar.gz"]);
      expectFailed(run);
      expect(theOneError(run)).toBe(
        "::error::version '0.5.0+g1' contains a '+' local segment — TestPyPI rejects PEP 440 local versions",
      );
    },
    TEST_TIMEOUT_MS,
  );
});
