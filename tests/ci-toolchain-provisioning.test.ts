// CR-CRU-063 C1 (RED) — CI runs the gates but provisions no toolchain.
//
// Spec: docs/changes/CR-CRU-063-ci-provisions-the-toolchain.md
//   §S1 `uv` on both test jobs (`test-bun`, `test-python`) — and deliberately
//       NOT on `test-e2e`
//   §S2 the Python job installs the toolchain the suites declare: the project's
//       `dev` extra (consumed from pyproject.toml, never restated in YAML) plus
//       `build`
//   §S4 a guard so the provisioning cannot silently regress — asserted against
//       the PARSED job graph, extending the existing `Bun.YAML.parse`
//       workflow-as-data pattern of `tests/cr009-release-bundle.test.ts`
//       (see its `readReleaseWorkflow()` helper), not a second CI-testing
//       mechanism
//   ACs 7, 8, 9
//
// This is the C1 RED phase. `.github/workflows/release.yml` on this branch
// provisions NOTHING beyond a language runtime, so every §S1/§S2 assertion
// below is expected to FAIL right now, precisely as follows:
//
//   * `test-bun` steps are exactly: `actions/checkout@v4`,
//     `oven-sh/setup-bun@v2`, `bun install --frozen-lockfile`, `bun test`.
//     There is no uv provisioning step at all → assertion 1 fails. This is the
//     measured defect: CI run 31677479804 produced 102 bun failures of which
//     **98** were `error: Executable not found in $PATH: "uv"`, because
//     `tests/clients-bun-crucible.test.ts:83` spawns the client fleet as
//     `["uv", "run", SCRIPT_PATH, …]` (PEP 723, CR-CRU-046 §S3) and
//     `oven-sh/setup-bun` provides bun, not uv.
//
//   * `test-python` steps are exactly: `actions/checkout@v4`,
//     `actions/setup-python@v5`, and a bare
//     `python3 -m unittest discover -s tests/client -t .`. There is no uv step
//     (→ assertion 2 fails; `tests/client/test_cr046_uv_env_gate.py`'s
//     `setUpClass` raises ``RuntimeError: `uv` is not on PATH … Remedy:
//     install uv.``), no dependency-install step at all (→ assertion 3 fails;
//     `test_cr040_coverage_tooling.py:172` needs the gate venv's python to run
//     `-m coverage`, and `pyproject.toml:27` already declares
//     `dev = ["coverage>=7"]`), and no `build` install (→ assertion 4 fails;
//     `tests/client/test_crucible_axi_wheel_packaging.py:121` raises
//     ``RuntimeError: no interpreter on this machine can `import build```).
//
//   * Assertions 5 (AC9 — no `if:` on a test job, CR-CRU-062 §S0) and 6
//     (§S1 — `test-e2e` must NOT grow a uv step "for symmetry") are BORN GREEN
//     against today's file: it carries no job-level `if:` on the four
//     unconditional jobs and no uv anywhere. They are regression rails, not
//     RED-phase drivers, and are deliberately not contorted into failing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_WORKFLOW_REL = join(".github", "workflows", "release.yml");

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  "runs-on"?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
};

type ReleaseWorkflow = {
  jobs?: Record<string, WorkflowJob>;
};

// Same shape as tests/cr009-release-bundle.test.ts's readReleaseWorkflow():
// read the file once, hand back both the raw text (for the AC8 negative
// duplication check) and the parsed job graph (for every positive assertion).
function readReleaseWorkflow(): { raw: string; parsed: ReleaseWorkflow } {
  const raw = readFileSync(join(REPO_ROOT, RELEASE_WORKFLOW_REL), "utf8");
  const parsed = Bun.YAML.parse(raw) as ReleaseWorkflow;
  return { raw, parsed };
}

function stepsOf(parsed: ReleaseWorkflow, jobName: string): WorkflowStep[] {
  const job = parsed.jobs?.[jobName];
  expect(job, `release.yml declares no '${jobName}' job`).toBeDefined();
  const steps = job?.steps;
  expect(Array.isArray(steps), `job '${jobName}' declares no steps: array`).toBe(true);
  return steps as WorkflowStep[];
}

function describeStep(step: WorkflowStep): string {
  if (step.uses) return `uses: ${step.uses}`;
  const run = (step.run ?? "").trim().split("\n")[0] ?? "";
  return `run: ${run}`;
}

function stepInventory(steps: WorkflowStep[]): string {
  return steps.map((s, i) => `  [${i}] ${describeStep(s)}`).join("\n");
}

// Every form of "install a package" a workflow step plausibly uses; capture
// group 1 is the argument tail, so a target token is looked for among the
// packages rather than anywhere in the script.
const INSTALL_COMMAND =
  /(?:uv\s+(?:pip\s+)?(?:install|add|sync)|(?:python3?(?:\.\d+)?\s+-m\s+)?(?:uv\s+pip\s+install|pip3?\s+install)|pipx\s+install)([^\n]*)/g;

function installsToken(run: string, token: string): boolean {
  const tokenRe = new RegExp(`(?:^|[\\s'"=\\[])${token}(?:$|[\\s'"\\]<>=!~,;])`);
  return [...run.matchAll(INSTALL_COMMAND)].some((m) => tokenRe.test(m[1] ?? ""));
}

// §S1 acceptance: EITHER the maintained action (preferred: cached + pinned) OR
// an explicit uv install command in a `run:` step.
function provisionsUv(step: WorkflowStep): boolean {
  if (typeof step.uses === "string" && /^astral-sh\/setup-uv(?:@|$)/.test(step.uses.trim())) {
    return true;
  }
  const run = step.run;
  if (typeof run !== "string") return false;
  if (installsToken(run, "uv")) return true;
  // hand-rolled installer forms (accepted by the guard, discouraged by §S1)
  if (/astral\.sh\/uv\/install\.sh/.test(run)) return true;
  if (/\b(?:brew|snap|apt-get|cargo)\s+install\b[^\n]*\buv\b/.test(run)) return true;
  return false;
}

// §S2/AC8: the extra is the declaration. A step qualifies only if it installs
// the project WITH its `dev` extra — `.[dev]`, `.[dev,…]`, `crucible-axi[dev]`.
function installsDevExtra(step: WorkflowStep): boolean {
  const run = step.run;
  if (typeof run !== "string") return false;
  return [...run.matchAll(INSTALL_COMMAND)].some((m) =>
    /\[[^\]\n]*\bdev\b[^\]\n]*\]/.test(m[1] ?? ""),
  );
}

describe("CR-CRU-063 §S1 — uv is provisioned on the jobs that drive the client fleet", () => {
  test("test-bun provisions uv — guards the 98 `Executable not found in $PATH: \"uv\"` failures (run 31677479804)", () => {
    const { parsed } = readReleaseWorkflow();
    const steps = stepsOf(parsed, "test-bun");

    const provisioning = steps.filter(provisionsUv);
    expect(
      provisioning.length,
      "release.yml job 'test-bun' has no uv provisioning step (expected an " +
        "`astral-sh/setup-uv` `uses:` or an explicit uv install `run:`). " +
        "tests/clients-bun-crucible.test.ts:83 spawns the client fleet as " +
        '["uv", "run", SCRIPT_PATH, …]; without uv on PATH the suite emits ' +
        '`error: Executable not found in $PATH: "uv"` 98 times.\n' +
        `test-bun steps:\n${stepInventory(steps)}`,
    ).toBeGreaterThan(0);
  });

  test("test-python provisions uv — guards test_cr046_uv_env_gate.py setUpClass `RuntimeError: `uv` is not on PATH`", () => {
    const { parsed } = readReleaseWorkflow();
    const steps = stepsOf(parsed, "test-python");

    const provisioning = steps.filter(provisionsUv);
    expect(
      provisioning.length,
      "release.yml job 'test-python' has no uv provisioning step (expected an " +
        "`astral-sh/setup-uv` `uses:` or an explicit uv install `run:`). " +
        "tests/client/test_cr046_uv_env_gate.py's setUpClass raises " +
        "``RuntimeError: `uv` is not on PATH; the §S3 environment gate cannot " +
        "be verified without it… Remedy: install uv.`` — an aborted class is " +
        "counted as one error, which is why CI discovered 673 rather than 683.\n" +
        `test-python steps:\n${stepInventory(steps)}`,
    ).toBeGreaterThan(0);
  });

  test("test-e2e does NOT provision uv — §S1: it passed, it drives the UI not the client fleet, no steps for symmetry", () => {
    const { parsed } = readReleaseWorkflow();
    const steps = stepsOf(parsed, "test-e2e");

    const provisioning = steps.filter(provisionsUv).map(describeStep);
    expect(
      provisioning,
      "release.yml job 'test-e2e' grew a uv provisioning step. §S1 is explicit: " +
        "test-e2e passed on run 31677479804 and drives the Playwright/BDD UI " +
        "suite, not the client fleet — every added step is another thing that " +
        "can fail on release day.",
    ).toEqual([]);
  });
});

describe("CR-CRU-063 §S2 — the Python job installs the toolchain its suites declare", () => {
  test("test-python installs the project's `dev` extra, not a restated package list — guards test_cr040_coverage_tooling.py `-m coverage`", () => {
    const { parsed } = readReleaseWorkflow();
    const steps = stepsOf(parsed, "test-python");

    const installers = steps.filter(installsDevExtra);
    expect(
      installers.length,
      "release.yml job 'test-python' has no step installing the project's " +
        "`dev` optional-dependency group (expected an install whose args carry " +
        "the extra, e.g. `.[dev]`). tests/client/test_cr040_coverage_tooling.py:172 " +
        "requires the gate venv's python to execute `-m coverage`, and " +
        "pyproject.toml:27 already declares `dev = [\"coverage>=7\"]` — §S2/AC8: " +
        "consume that group, never restate its contents in YAML.\n" +
        `test-python steps:\n${stepInventory(steps)}`,
    ).toBeGreaterThan(0);
  });

  test("AC8 — the dev package list is declared in exactly one place: release.yml never names `coverage` as a package", () => {
    const { raw } = readReleaseWorkflow();

    // NEGATIVE duplication check (the positive contract above is on the parsed
    // graph, per AC7). A version constraint or a bare coverage install in YAML
    // is a second declaration of pyproject.toml:27 and the two will drift.
    expect(
      raw.includes("coverage>="),
      "release.yml contains the version constraint `coverage>=` — that duplicates " +
        "pyproject.toml's `dev = [\"coverage>=7\"]`. AC8: exactly one declaration.",
    ).toBe(false);
    expect(
      /(?:pip3?|python3?(?:\.\d+)?\s+-m\s+pip|uv\s+pip)\s+install\b[^\n]*\bcoverage\b/.test(raw),
      "release.yml installs `coverage` as a literal package name — install the " +
        "project's `dev` extra instead so pyproject.toml stays the single " +
        "declaration (AC8).",
    ).toBe(false);
  });

  test("test-python installs `build` — guards test_crucible_axi_wheel_packaging.py setUpClass `no interpreter on this machine can `import build``", () => {
    const { parsed } = readReleaseWorkflow();
    const steps = stepsOf(parsed, "test-python");

    const installers = steps.filter(
      (step) => typeof step.run === "string" && installsToken(step.run, "build"),
    );
    expect(
      installers.length,
      "release.yml job 'test-python' has no step installing `build`. " +
        "tests/client/test_crucible_axi_wheel_packaging.py:121 raises " +
        "``RuntimeError: no interpreter on this machine can `import build`… " +
        "Remedy: `python3 -m pip install --upgrade build``` — the same package " +
        "the `build` job already installs; that asymmetry is the bug (§S2).\n" +
        `test-python steps:\n${stepInventory(steps)}`,
    ).toBeGreaterThan(0);
  });
});

describe("CR-CRU-063 AC9 / CR-CRU-062 §S0 — no test job is event-scoped", () => {
  test("test-bun, test-python, test-e2e and pack-server carry no job-level `if:` — an absent job makes a `needs:` publish skip and publish nothing", () => {
    const { parsed } = readReleaseWorkflow();
    const unconditional = ["test-bun", "test-python", "test-e2e", "pack-server"];

    const gated: string[] = [];
    for (const name of unconditional) {
      const job = parsed.jobs?.[name];
      expect(job, `release.yml declares no '${name}' job`).toBeDefined();
      if (typeof job?.if === "string") gated.push(`${name}: if: ${job.if}`);
    }

    expect(
      gated,
      "a test/pack job gained a job-level `if:`. CR-CRU-062 §S0: the publishes " +
        "fire on the `release` event while create-release fires on a push to " +
        "master — DIFFERENT workflow runs. `needs:` only orders jobs WITHIN one " +
        "run, so an event-scoped test job does not exist in the release run, and " +
        "a publish that `needs:` a SKIPPED job is itself skipped — the release " +
        "silently publishes nothing.",
    ).toEqual([]);
  });
});
