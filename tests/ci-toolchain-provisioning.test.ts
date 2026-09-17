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
  /** A job-level `uses:` — a reusable workflow. §S5's enumeration grades
   *  these alongside step-level ones, so a job that calls out to another
   *  workflow cannot slip past the pin guard. */
  uses?: string;
  "runs-on"?: string;
  needs?: string | string[];
  env?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

type ReleaseWorkflow = {
  env?: Record<string, unknown>;
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

function isCheckout(step: WorkflowStep): boolean {
  return typeof step.uses === "string" && /^actions\/checkout(?:@|$)/.test(step.uses.trim());
}

// `with:` inputs reach an action as strings, so `0` and `"0"` are one input.
function checksOutFullHistory(step: WorkflowStep): boolean {
  return isCheckout(step) && String(step.with?.["fetch-depth"]) === "0";
}

// `playwright install [--with-deps] <browser…>` — the browser must be named
// among the arguments; `playwright install-deps` installs no browser at all.
function installsPlaywrightBrowser(step: WorkflowStep, browser: string): boolean {
  const run = step.run;
  if (typeof run !== "string") return false;
  const browserRe = new RegExp(`(?:^|\\s)${browser}(?:$|\\s)`);
  return [...run.matchAll(/\bplaywright\s+install(?=\s|$)([^\n]*)/g)].some((m) =>
    browserRe.test(m[1] ?? ""),
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

describe("0.2.0 release (CR-CRU-112 §S1 / CR-CRU-096 AC26) — test-bun owns the toolchain and history of every tier it collects", () => {
  test("test-bun installs the Chromium browser — `bun test` collects the Chromium integration tier (run 34303803078)", () => {
    const { parsed } = readReleaseWorkflow();
    const steps = stepsOf(parsed, "test-bun");

    const provisioning = steps.filter((step) => installsPlaywrightBrowser(step, "chromium"));
    expect(
      provisioning.length,
      "release.yml job 'test-bun' has no step installing the Chromium browser " +
        "(expected a `playwright install … chromium` `run:`, the same command " +
        "test-e2e uses). `bun test` collects the WHOLE suite, Chromium " +
        "integration tier included; without a browser every test in that tier " +
        "dies with `launch: Executable doesn't exist at …/ms-playwright/" +
        "chromium_headless_shell-…` and CR-CRU-110's order-independence guard " +
        "fails with them (run 34303803078). The job that RUNS a tier owns that " +
        "tier's toolchain.\n" +
        `test-bun steps:\n${stepInventory(steps)}`,
    ).toBeGreaterThan(0);
  });

  test("test-bun checks out full history — a pinned pre-CR baseline is read with `git show` (run 34304398429)", () => {
    const { parsed } = readReleaseWorkflow();
    const steps = stepsOf(parsed, "test-bun");

    const checkouts = steps.filter(isCheckout);
    expect(
      checkouts.length,
      `release.yml job 'test-bun' has no actions/checkout step.\ntest-bun steps:\n${stepInventory(steps)}`,
    ).toBeGreaterThan(0);

    const shallow = checkouts.filter((step) => !checksOutFullHistory(step)).map(describeStep);
    expect(
      shallow,
      "release.yml job 'test-bun' checks out at actions/checkout's default " +
        "fetch-depth of 1. tests/roadmap-visual-grammar.test.ts reads a PINNED " +
        "pre-CR baseline with `git show <commit>:public/app-logic.mjs`; on a " +
        "shallow clone that object is absent, the read throws, and every " +
        "baseline assertion fails (run 34304398429). Expected `with: " +
        "fetch-depth: 0` on the checkout.\n" +
        `test-bun steps:\n${stepInventory(steps)}`,
    ).toEqual([]);
  });
});

// ── CR-CRU-137 §S2 — one bun version, declared once and guarded ────────────
//
// Spec: docs/changes/CR-CRU-137-pipeline-defaults-are-chosen-not-inherited.md
//   §S2 "The bun version is declared in exactly ONE place … the requirement is
//        one declaration and a guard, not a particular file."
//
// WHICH FILE HOLDS THE DECLARATION IS DELIBERATELY NOT ASSERTED. §S2 adopts
// CR-CRU-087 §S1's `packageManager` only if it survives this repo's real npm
// usage — `pack-server`'s `npm pack`, `dry-run-npm`'s `npm publish --dry-run`,
// `publish-npm`'s `npm publish --provenance` — settled by RUNNING those
// commands, not by reading npm's documentation; if it degrades any of them the
// single declaration stays in the workflow and the four sites consolidate into
// one reference instead. This repository has already measured that interaction
// once and reverted on it: tests/clients-bun-crucible.test.ts records that "a
// `packageManager` field routes npm through corepack, 958ms → 13082ms on the
// npm-pack test". So the assertions below are written on the INVARIANT — how
// many places WRITE DOWN a version, and whether every consumer resolves an
// EXACT one — and are silent on which file wins. Both candidate shapes satisfy
// them unchanged, which is the point: a guard must not pre-decide a question
// its own CR says is settled by running commands.
//
// Measured on this branch at RED time:
//   * release.yml carries FOUR literal `bun-version: "1.4.2"` entries (:121
//     test-bun, :201 test-e2e, :384 publish-npm, :444 dry-run-npm) — four
//     sites, so the site-count assertion FAILS with 4 where 1 is required.
//   * package.json declares no `packageManager`. Its `engines.bun` (`>=1.2`)
//     is the compatibility FLOOR that CR-CRU-087's own gap analysis (D2)
//     separated from the build version, so it is NOT counted as a site — a
//     floor doubling as the pin is how CI came to track the newest release.
//   * docs/changes/CR-CRU-087-ci-bun-is-unpinned.md:6 reads
//     `- **Status**: PENDING` while the queue records it COMPLETED (0.2.0),
//     and its §S1 names no delivering CR — both record assertions FAIL.
//   * The pinned-resolution guard is BORN GREEN against today's four literal
//     pins, exactly as assertions 5 and 6 at the head of this file are. It is
//     the rail the consolidation has to survive: whichever shape lands — a
//     `packageManager` the steps inherit, or one workflow `env:` key the steps
//     reference — a step that stops resolving an exact version fails it, and a
//     FIFTH step is covered with no edit here because the step list is read off
//     the parsed workflow rather than written down.

const PACKAGE_JSON_REL = "package.json";
const CR087_REL = join("docs", "changes", "CR-CRU-087-ci-bun-is-unpinned.md");

/** The status §S2's fourth criterion requires, verbatim. */
const CR087_STATUS = "COMPLETED (shipped 2026-08-27 on master)";

type PackageJson = {
  packageManager?: string;
  engines?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, PACKAGE_JSON_REL), "utf8")) as PackageJson;
}

/** An EXACT version — `1.4.2`, or a prerelease like `1.4.2-canary.20260101`.
 *  `1.4`, `^1.4`, `>=1.2`, `latest` and `canary` are ranges or aliases, and
 *  setup-bun resolves every one of them to whatever is newest on the day the
 *  job runs. That is the defect CR-CRU-136 measured, not a style preference. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** `${{ env.BUN_VERSION }}` → `env.BUN_VERSION`. */
const WORKFLOW_EXPRESSION = /^\$\{\{\s*([^}]+?)\s*\}\}$/;

/** packageManager's `<name>@<version>` form; corepack's optional `+<hash>`
 *  integrity suffix is tolerated and is not part of the version. */
const PACKAGE_MANAGER_BUN = /^bun@([^+\s]+)(?:\+\S+)?$/;

function isSetupBun(step: WorkflowStep): boolean {
  return typeof step.uses === "string" && /^oven-sh\/setup-bun(?:@|$)/.test(step.uses.trim());
}

type SetupBunStep = { job: string; index: number; step: WorkflowStep };

/** Every `setup-bun` step in the workflow, ENUMERATED FROM THE PARSED JOB
 *  GRAPH. A step added to a new job is guarded on the day it is written. */
function setupBunSteps(parsed: ReleaseWorkflow): SetupBunStep[] {
  const found: SetupBunStep[] = [];
  for (const [job, spec] of Object.entries(parsed.jobs ?? {})) {
    (spec.steps ?? []).forEach((step, index) => {
      if (isSetupBun(step)) found.push({ job, index, step });
    });
  }
  return found;
}

/** `${{ env.X }}` resolves job-level `env:` first, then workflow-level. */
function envValue(parsed: ReleaseWorkflow, job: string, name: string): string | undefined {
  const value = parsed.jobs?.[job]?.env?.[name] ?? parsed.env?.[name];
  return value === undefined ? undefined : String(value);
}

type Resolution = {
  /** WHERE the version text is written down — undefined when nothing in the
   *  repository pins it and setup-bun is left to pick for itself. */
  site?: string;
  /** WHAT the step ends up installing, as far as the repository can say. */
  version?: string;
  detail: string;
};

/** setup-bun's documented resolution order with no `bun-version` given:
 *  `packageManager`, then `engines.bun`, then the newest release. */
function resolveSetupBun(
  parsed: ReleaseWorkflow,
  pkg: PackageJson,
  entry: SetupBunStep,
): Resolution {
  const declared = pkg.packageManager?.trim() ?? "";
  const inherited = PACKAGE_MANAGER_BUN.exec(declared);
  const raw = entry.step.with?.["bun-version"];

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    if (inherited) {
      return {
        site: `${PACKAGE_JSON_REL} packageManager`,
        version: inherited[1],
        detail: `no bun-version — inherits ${PACKAGE_JSON_REL}'s packageManager '${declared}'`,
      };
    }
    return {
      detail:
        "no bun-version and no package.json packageManager — setup-bun falls " +
        `through engines.bun (${pkg.engines?.bun ?? "absent"}, a floor that matches every ` +
        "release) to whatever bun is newest when the job runs",
    };
  }

  const value = String(raw).trim();
  const expression = WORKFLOW_EXPRESSION.exec(value);
  if (!expression) {
    return {
      site: `${RELEASE_WORKFLOW_REL} job '${entry.job}' step [${entry.index}] bun-version`,
      version: value,
      detail: `literal bun-version '${value}'`,
    };
  }

  const reference = expression[1] ?? "";
  const envName = /^env\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(reference)?.[1];
  if (envName === undefined) {
    return {
      detail:
        `bun-version is '${value}' — an expression whose value is not declared in ` +
        "this repository, so what CI installs cannot be read here at all",
    };
  }
  const resolved = envValue(parsed, entry.job, envName);
  if (resolved === undefined) {
    return {
      detail: `bun-version references \${{ ${reference} }}, but neither job '${entry.job}' nor the workflow declares env.${envName}`,
    };
  }
  return {
    site: `${RELEASE_WORKFLOW_REL} env.${envName}`,
    version: resolved.trim(),
    detail: `\${{ ${reference} }} → env.${envName} = '${resolved.trim()}'`,
  };
}

/** Every place in the repository that WRITES DOWN a bun version, deduplicated.
 *  A step that references an `env:` key, or that inherits `packageManager`, is
 *  a CONSUMER of a site and not a site itself — which is exactly what lets
 *  either shape §S2 leaves open satisfy "declared once". */
function declarationSites(parsed: ReleaseWorkflow, pkg: PackageJson): string[] {
  const sites = new Set<string>();

  const declared = pkg.packageManager?.trim() ?? "";
  if (PACKAGE_MANAGER_BUN.test(declared)) {
    sites.add(`${PACKAGE_JSON_REL} packageManager: ${declared}`);
  }
  for (const entry of setupBunSteps(parsed)) {
    const resolution = resolveSetupBun(parsed, pkg, entry);
    if (resolution.site?.startsWith(RELEASE_WORKFLOW_REL) === true) {
      sites.add(`${resolution.site} = ${String(resolution.version)}`);
    }
  }
  return [...sites].sort();
}

function readCr087(): string {
  return readFileSync(join(REPO_ROOT, CR087_REL), "utf8");
}

/** The `- **Status**: …` line every CR in docs/changes/ carries. */
function statusOf(doc: string): string | undefined {
  return /^-\s*\*\*Status\*\*:\s*(.+?)\s*$/m.exec(doc)?.[1];
}

/** One `### …` section's body, up to the next heading at the same or a higher
 *  level. */
function sectionBody(doc: string, heading: RegExp): string | undefined {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("CR-CRU-137 §S2 — one bun version, declared once and guarded", () => {
  test("the bun version is written down in exactly ONE place — four duplicated declarations are four things to drift", () => {
    const { parsed } = readReleaseWorkflow();
    const sites = declarationSites(parsed, readPackageJson());

    expect(
      sites,
      "§S2: the bun version must appear in exactly ONE location, and a grep " +
        "for the other mechanism's key must return zero. Today release.yml " +
        "repeats a literal `bun-version` in every job that needs bun, so the " +
        "pin CR-CRU-136 landed is four copies that must be edited together and " +
        "will not be — the duplication CR-CRU-087's gap analysis (D1) rejected " +
        "before it shipped. WHETHER the one place is package.json's " +
        "`packageManager` or a single workflow `env:` key the steps reference " +
        "is §S2's empirical call (npm reads packageManager too, and three jobs " +
        "here run real npm); this assertion counts SITES and takes no position " +
        "on which file wins.\n" +
        `declaration sites found (${sites.length}):\n` +
        sites.map((site) => `  ${site}`).join("\n"),
    ).toHaveLength(1);
  });

  test("every setup-bun step resolves an EXACT version — the step list is read off the parsed workflow, so a fifth step is guarded with no edit here", () => {
    const { parsed } = readReleaseWorkflow();
    const pkg = readPackageJson();
    const steps = setupBunSteps(parsed);

    expect(
      steps.length,
      "release.yml declares no oven-sh/setup-bun step at all — this guard " +
        "would then assert nothing while still reporting green.",
    ).toBeGreaterThan(0);

    const unpinned = steps
      .map((entry) => ({ entry, resolution: resolveSetupBun(parsed, pkg, entry) }))
      .filter(
        ({ resolution }) =>
          resolution.version === undefined || !EXACT_VERSION.test(resolution.version),
      )
      .map(({ entry, resolution }) => `${entry.job} step [${entry.index}]: ${resolution.detail}`);

    expect(
      unpinned,
      "§S2: every `setup-bun` step must resolve to an exact pinned version — " +
        "no floating range, no absent declaration. An unpinned step installs " +
        "whatever bun is newest on the day it runs, which is how CR-CRU-136 " +
        "flipped a format-parsing assertion and blocked every publish while " +
        "the same suite stayed green locally. Each entry below is a step whose " +
        "installed version this repository cannot state.",
    ).toEqual([]);
  });
});

describe("CR-CRU-137 §S2 — CR-CRU-087's record says what actually shipped", () => {
  test(`CR-CRU-087's Status reads '${CR087_STATUS}' — the queue already records it COMPLETED`, () => {
    const status = statusOf(readCr087());

    expect(
      status,
      "§S2: docs/changes/README.md records CR-CRU-087 COMPLETED (0.2.0) while " +
        "the CR's own spec still reads PENDING. Two records of one CR " +
        "disagreeing is how §S2 came to exist: CR-087 chose the pin, the fix " +
        "never landed in the form it specified, and neither record said so.",
    ).toBe(CR087_STATUS);
  });

  test("CR-CRU-087 §S1 records CR-CRU-137 as the CR that delivered its pin", () => {
    const body = sectionBody(readCr087(), /^###\s+§S1\b/);

    expect(body, "CR-CRU-087 has no `### §S1` section to record a delivery in").toBeDefined();
    expect(
      body ?? "",
      "§S2: CR-CRU-087 §S1 specified `packageManager` and that pin never " +
        "landed as written — CR-CRU-137 §S2 delivers it, in whichever of the " +
        "two locations the npm interaction permits. §S1 must name the " +
        "delivering CR rather than be left reading as complete on its own.",
    ).toContain("CR-CRU-137");
  });
});

// ── CR-CRU-137 §S5 — no workflow action is running on a deprecated runtime ──
//
// Spec: docs/changes/CR-CRU-137-pipeline-defaults-are-chosen-not-inherited.md
//   §S5 "GitHub deprecated Node 20 on the runners, so every action declaring
//        `using: node20` is force-run on Node 24 and each job emits a
//        deprecation annotation naming its offenders."
//   ACs "Every `uses:` pin in release.yml resolves to a ref whose own
//        `action.yml` declares a supported runtime — evidenced by reading each
//        pinned ref's `action.yml`, not by the version number looking new" and
//        "`tests/ci-toolchain-provisioning.test.ts` asserts the pinned version
//        of EVERY action the workflow uses, enumerated from the workflow
//        itself — so an action added later without a pin, or a pin silently
//        downgraded, fails the suite."
//
// THE SHAPE, AND WHY THIS ONE. The evidence the first criterion demands lives
// in a REMOTE file — each pinned ref's own `action.yml`. Fetching those at test
// time would make this suite network-dependent, and a gate that reddens when
// raw.githubusercontent.com rate-limits is a gate nobody reads; CR-CRU-063 §S1
// already refused a network fetch in the release path for the same reason. So
// the reading is done ONCE, by hand, and CHECKED IN as `ACTION_RUNTIMES`: a
// table of `action@ref` → the exact `using:` value THAT REF's own `action.yml`
// declares. Every row is reproducible in one command —
// `curl -fsSL https://raw.githubusercontent.com/<action>/<ref>/action.yml` —
// and each failure message prints the row's URL so any claim here can be
// re-measured rather than believed.
//
// THE TABLE IS EVIDENCE; `REQUIRED_PINS` IS POLICY; THE WORKFLOW IS THE
// ENUMERATION. Nothing below iterates the tables. Every assertion walks the
// `uses:` occurrences of the PARSED workflow (job-level and step-level alike,
// the same way `setupBunSteps()` above reads the job graph) and looks each one
// up, so a ninth action added tomorrow is UNRECORDED and FAILS. An unlisted
// `uses:` is a failure, never a skip — a guard that silently passes over what
// it has not measured is exactly the "guard covering only the actions listed
// today" the AC rejects.
//
// Measured 2026-09-17 by reading each ref's own `action.yml`. Three rows exist
// only to record that §S5's warning is literal — "a floating major tag is not
// evidence": `actions/upload-artifact@v5` and `actions/download-artifact@v5`
// and `@v6` are NEWER majors that STILL declare `using: node20`, so the obvious
// next major would have bought this repository nothing at all.
//
// RED expectation on this branch (measured 2026-09-17, site counts read off
// this guard's own run): six of the eight pins are node20 —
// `actions/checkout@v4` (10 sites), `actions/setup-python@v5` (2),
// `astral-sh/setup-uv@v6` (2), `actions/setup-node@v4` (3),
// `actions/upload-artifact@v4` (1) and `actions/download-artifact@v4` (2).
// `oven-sh/setup-bun@v2` is already node24 and
// `pypa/gh-action-pypi-publish@release/v1` is a composite action that runs no
// Node runtime at all; §S5 says explicitly that neither is to be touched.
// The matched-pair test is the one deliberately BORN GREEN — like assertions 5
// and 6 at the head of this file, it is a rail, red only in the half-bumped
// state it exists to forbid.

/** Runtimes GitHub no longer provides on its runners. An action declaring one
 *  is force-run on Node 24 and annotates every job that uses it — which is the
 *  annotation §S5 measured on run 35164711642, across all five jobs. */
const DEPRECATED_ACTION_RUNTIMES = new Set(["node12", "node16", "node20"]);

/** `action@ref` → the `using:` value THAT REF's own `action.yml` declares.
 *  Evidence, measured 2026-09-17, never inferred from the version number. */
const ACTION_RUNTIMES: Record<string, string> = {
  "actions/checkout@v4": "node20",
  "actions/checkout@v5": "node24",
  "actions/setup-python@v5": "node20",
  "actions/setup-python@v6": "node24",
  "actions/setup-node@v4": "node20",
  "actions/setup-node@v5": "node24",
  "astral-sh/setup-uv@v6": "node20",
  "astral-sh/setup-uv@v7": "node24",
  // "a floating major tag is not evidence" — v5 is a newer major than the v4
  // pinned today and is STILL node20.
  "actions/upload-artifact@v4": "node20",
  "actions/upload-artifact@v5": "node20",
  "actions/upload-artifact@v6": "node24",
  "actions/upload-artifact@v7.0.1": "node24",
  "actions/download-artifact@v4": "node20",
  "actions/download-artifact@v5": "node20",
  "actions/download-artifact@v6": "node20",
  "actions/download-artifact@v7": "node24",
  "actions/download-artifact@v8.0.1": "node24",
  "oven-sh/setup-bun@v2": "node24",
  // A composite action runs no Node runtime of its own, so it can never carry
  // a deprecated one — §S5: "not a Node action, never annotated".
  "pypa/gh-action-pypi-publish@release/v1": "composite",
};

/** The pin this repository REQUIRES for each action it uses — policy, not
 *  evidence. Every value must also be a recorded row above whose runtime is
 *  supported, which the enumeration test asserts before it grades anything.
 *
 *  The two artifact actions are a MATCHED PAIR (§S5): `build` uploads the
 *  `dist` artifact both publish jobs download, and the newer download major
 *  exists to understand the newer upload major's direct (unzipped) uploads, so
 *  this repository takes the newest generation of both rather than mixing the
 *  older node24 majors recorded above with them. `setup-bun` and the PyPI
 *  publisher are pinned at what §S5 says is already correct and not to move. */
const REQUIRED_PINS: Record<string, string> = {
  "actions/checkout": "v5",
  "actions/setup-python": "v6",
  "actions/setup-node": "v5",
  "astral-sh/setup-uv": "v7",
  "actions/upload-artifact": "v7.0.1",
  "actions/download-artifact": "v8.0.1",
  "oven-sh/setup-bun": "v2",
  "pypa/gh-action-pypi-publish": "release/v1",
};

type UsesSite = {
  /** Where in the workflow it is written, for the failure message. */
  where: string;
  /** The whole `uses:` value, e.g. `actions/checkout@v4`. */
  uses: string;
  /** `actions/checkout` — the part before the first `@`. */
  action: string;
  /** `v4` — undefined when the step names no ref at all, which is the
   *  "added later without a pin" case the AC names. */
  ref?: string;
};

/** Every `uses:` occurrence in the workflow, ENUMERATED FROM THE PARSED JOB
 *  GRAPH — job-level (a reusable workflow) and step-level alike. This is the
 *  enumeration the AC requires: an action added to a new job is graded on the
 *  day it is written, with no edit to this file. */
function usesSites(parsed: ReleaseWorkflow): UsesSite[] {
  const sites: UsesSite[] = [];
  const record = (where: string, raw: string): void => {
    const uses = raw.trim();
    const at = uses.indexOf("@");
    const ref = at === -1 ? "" : uses.slice(at + 1).trim();
    sites.push({
      where,
      uses,
      action: at === -1 ? uses : uses.slice(0, at),
      ref: ref === "" ? undefined : ref,
    });
  };
  for (const [job, spec] of Object.entries(parsed.jobs ?? {})) {
    if (typeof spec.uses === "string") record(`job '${job}' uses`, spec.uses);
    (spec.steps ?? []).forEach((step, index) => {
      if (typeof step.uses === "string") record(`job '${job}' step [${index}]`, step.uses);
    });
  }
  return sites;
}

/** The one command that re-measures a row of `ACTION_RUNTIMES`. */
function actionYmlUrl(site: UsesSite): string {
  return `https://raw.githubusercontent.com/${site.action}/${site.ref ?? "<no ref>"}/action.yml`;
}

/** Distinct `uses:` values, each with every site that writes it. */
function byPin(sites: UsesSite[]): Map<string, UsesSite[]> {
  const grouped = new Map<string, UsesSite[]>();
  for (const site of sites) {
    const seen = grouped.get(site.uses);
    if (seen) seen.push(site);
    else grouped.set(site.uses, [site]);
  }
  return grouped;
}

describe("CR-CRU-137 §S5 — no workflow action is running on a deprecated runtime", () => {
  test("every `uses:` in release.yml resolves to a ref whose own action.yml declares a supported runtime — an UNRECORDED action fails, it is never skipped", () => {
    const { parsed } = readReleaseWorkflow();
    const sites = usesSites(parsed);

    expect(
      sites.length,
      "release.yml declares no `uses:` at all — this guard would then assert " +
        "nothing about anything while still reporting green.",
    ).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const [uses, where] of byPin(sites)) {
      const first = where[0] as UsesSite;
      const at = `${where.length} site(s): ${where.map((s) => s.where).join(", ")}`;

      if (first.ref === undefined) {
        offenders.push(
          `${uses} — names NO ref, so there is no action.yml to read a runtime ` +
            `from and GitHub resolves whatever the default branch holds today [${at}]`,
        );
        continue;
      }

      const runtime = ACTION_RUNTIMES[uses];
      if (runtime === undefined) {
        offenders.push(
          `${uses} — UNRECORDED: no row in ACTION_RUNTIMES. Read this ref's own ` +
            `action.yml (${actionYmlUrl(first)}) and record the using: value it ` +
            `declares [${at}]`,
        );
        continue;
      }

      if (DEPRECATED_ACTION_RUNTIMES.has(runtime)) {
        offenders.push(
          `${uses} — its own action.yml declares using: ${runtime}, which GitHub ` +
            `no longer provides (${actionYmlUrl(first)}) [${at}]`,
        );
      }
    }

    expect(
      offenders,
      "§S5: every action this pipeline runs must resolve to a ref whose OWN " +
        "action.yml declares a supported runtime. A node20 action is force-run " +
        "on Node 24 and annotates the job that used it — measured on run " +
        "35164711642, all five jobs annotated. The runtime is read from the " +
        "ref's action.yml and recorded in ACTION_RUNTIMES, never inferred from " +
        "the version number looking new: actions/upload-artifact@v5 and " +
        "actions/download-artifact@{v5,v6} are newer majors that are STILL " +
        "node20. Each line below is one distinct pin this repository cannot " +
        "claim runs on a runtime GitHub still ships.",
    ).toEqual([]);
  });

  test("every action the workflow uses carries the EXACT pin this repository requires — the action list is read off the workflow, so a ninth action or a silent downgrade fails here with no edit to this test", () => {
    const { parsed } = readReleaseWorkflow();
    const sites = usesSites(parsed);

    // Policy may never require a pin the evidence does not support: a
    // REQUIRED_PINS row naming an unmeasured (or measured-deprecated) ref
    // would let the guard above be "satisfied" by a version nobody read.
    const unmeasured = Object.entries(REQUIRED_PINS)
      .map(([action, ref]) => ({ pin: `${action}@${ref}`, runtime: ACTION_RUNTIMES[`${action}@${ref}`] }))
      .filter(({ runtime }) => runtime === undefined || DEPRECATED_ACTION_RUNTIMES.has(runtime))
      .map(({ pin, runtime }) => `${pin} → ${runtime ?? "no measured row at all"}`);

    expect(
      unmeasured,
      "REQUIRED_PINS names a pin whose runtime was never measured, or was " +
        "measured as a deprecated one — the policy table must only ever point " +
        "at evidence rows that clear §S5's bar.",
    ).toEqual([]);

    const offenders = sites
      .map((site) => {
        const required = REQUIRED_PINS[site.action];
        if (required === undefined) {
          return (
            `${site.where}: ${site.uses} — the workflow uses ${site.action}, and ` +
            "this repository records no required pin for it. Measure the ref's " +
            "own action.yml, record it, and name the pin here."
          );
        }
        if (site.ref !== required) {
          return (
            `${site.where}: pinned ${site.uses}, required ${site.action}@${required} ` +
            `(recorded runtimes: pinned=${ACTION_RUNTIMES[site.uses] ?? "unmeasured"}, ` +
            `required=${ACTION_RUNTIMES[`${site.action}@${required}`] ?? "unmeasured"})`
          );
        }
        return undefined;
      })
      .filter((entry): entry is string => entry !== undefined);

    expect(
      offenders,
      "§S5: this test must assert the pinned version of EVERY action the " +
        "workflow uses, ENUMERATED FROM THE WORKFLOW — a guard covering only " +
        "the actions listed today does not satisfy the criterion. So the list " +
        "walked here is the parsed job graph, not a hand-written inventory: an " +
        "action added later without a pin has no required-pin row and fails on " +
        "the first line below, and a pin silently downgraded fails on the " +
        "second. Each entry names one site whose pin is not the one this " +
        "repository requires.",
    ).toEqual([]);
  });

  test("the two artifact actions move as a MATCHED PAIR — the dist handoff from build to both publish jobs breaks if only one of them is bumped", () => {
    const { parsed } = readReleaseWorkflow();
    const sites = usesSites(parsed);
    const uploads = sites.filter((site) => site.action === "actions/upload-artifact");
    const downloads = sites.filter((site) => site.action === "actions/download-artifact");

    expect(
      uploads.length,
      "release.yml uploads no artifact at all — the build → publish handoff " +
        "this rail guards does not exist, and the rail would pass vacuously.",
    ).toBeGreaterThan(0);
    expect(
      downloads.length,
      "release.yml downloads no artifact at all — the publish jobs would be " +
        "building their own dist, and this rail would pass vacuously.",
    ).toBeGreaterThan(0);

    const atRequired = (group: UsesSite[]): boolean =>
      group.every((site) => site.ref === REQUIRED_PINS[site.action]);
    const pinsOf = (group: UsesSite[]): string =>
      [...new Set(group.map((site) => site.uses))].join(", ");

    expect(
      atRequired(uploads),
      "§S5: `build` uploads the `dist` artifact that both publish jobs " +
        "download, and the newer download major exists specifically to " +
        "understand the newer upload major's direct (unzipped) uploads — " +
        "bumping one without the other breaks that handoff, and the newer " +
        "download major also turns artifact hash mismatches into errors by " +
        "default. Either BOTH sides sit at the pin this repository requires or " +
        "NEITHER does; a half-bumped pipeline is the state this rail exists to " +
        `forbid. upload pins: ${pinsOf(uploads)} (at required: ${atRequired(uploads)}); ` +
        `download pins: ${pinsOf(downloads)} (at required: ${atRequired(downloads)}).`,
    ).toBe(atRequired(downloads));
  });
});
