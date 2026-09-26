// dead-code-is-gone.test.ts — RED bed for the dead-code census (§S1-§S3,
// AC2-AC6). Each test reads a named file's real source (or asks the real
// compiler / real git) and asserts a DEFINITION is gone, matching the
// definition form itself (a `def name(`, `export function name(`, a
// module/class constant assignment) rather than a bare mention, so a comment
// or docstring naming the retired symbol can never make a test pass or fail
// for the wrong reason. §S1's kept seam (item 3) is pinned the other way:
// still defined.
//
// Item 7 (17 compiler-reported unused locals/imports/types across 16 test
// files) is asserted via a real `tsc --noUnusedLocals --noUnusedParameters`
// run rather than 17 bespoke declaration-form regexes: the 17 diagnostics
// span plain consts, destructured bindings, function parameters, a `catch`
// binding and imported types, and matching each syntax shape by hand is the
// fragile path the spec itself calls out. Scoping the real compiler's own
// diagnostics to the 17 (file, symbol) pairs is the robust one — it is
// exactly the signal GREEN has to silence, with no guessing about form.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readSource(relPath)) as Record<string, unknown>;
}

describe("§S1 production code nothing calls (AC2)", () => {
  test("_fleet_context has no definition left in clients/bun-crucible.py", () => {
    const src = readSource("clients/bun-crucible.py");
    expect(src).not.toMatch(/^def _fleet_context\(/m);
  });

  test("_disk_precheck has no definition left in clients/rust-crucible.py", () => {
    const src = readSource("clients/rust-crucible.py");
    expect(src).not.toMatch(/^def _disk_precheck\(/m);
  });
});

describe("§S1 item 3 stays (AC3 pin)", () => {
  test("project_config_path is still defined in the shared client module", () => {
    const src = readSource("clients/_crucible_axi.py");
    expect(src).toMatch(/^def project_config_path\(/m);
  });
});

describe("§S2 test code nothing calls (AC2)", () => {
  test("backdateEvent and backdateAgent have no definition left in the server-limits fixture", () => {
    const src = readSource("tests/helpers/server-limits-fixture.ts");
    expect(src).not.toContain("export function backdateEvent(");
    expect(src).not.toContain("export function backdateAgent(");
  });

  test("waitForDom has no definition left in the dom-settle helper", () => {
    const src = readSource("tests/helpers/dom-settle.ts");
    expect(src).not.toContain("export async function waitForDom(");
  });

  const noActiveCyclePlansFiles = [
    "tests/client/test_python_crucible_axi.py",
    "tests/client/test_rust_crucible_axi.py",
    "tests/client/test_mvn_crucible_axi.py",
    "tests/client/test_arduino_crucible_axi.py",
    "tests/client/test_bun_crucible_toon_envelope.py",
  ];
  for (const relPath of noActiveCyclePlansFiles) {
    test(`_no_active_cycle_plans has no definition left in ${relPath}`, () => {
      const src = readSource(relPath);
      expect(src).not.toMatch(/^\s*def _no_active_cycle_plans\(/m);
    });
  }

  const noOpenPlansAtAllFiles = [
    "tests/client/test_python_crucible_axi.py",
    "tests/client/test_rust_crucible_axi.py",
    "tests/client/test_mvn_crucible_axi.py",
    "tests/client/test_arduino_crucible_axi.py",
  ];
  for (const relPath of noOpenPlansAtAllFiles) {
    test(`_no_open_plans_at_all has no definition left in ${relPath}`, () => {
      const src = readSource(relPath);
      expect(src).not.toMatch(/^\s*def _no_open_plans_at_all\(/m);
    });
  }

  test("NO_SPLIT_CLIENTS has no definition left in test_client_tier_run_modality.py", () => {
    const src = readSource("tests/client/test_client_tier_run_modality.py");
    expect(src).not.toMatch(/^NO_SPLIT_CLIENTS\s*=/m);
  });

  test("CLIENT_NAMES has no definition left in test_cr046_pep723_metadata.py", () => {
    const src = readSource("tests/client/test_cr046_pep723_metadata.py");
    expect(src).not.toMatch(/^CLIENT_NAMES\s*=/m);
  });

  test("SUCCESS_CALLS has no definition left in test_cr091_roadmap_verbs.py", () => {
    const src = readSource("tests/client/test_cr091_roadmap_verbs.py");
    expect(src).not.toMatch(/^\s*SUCCESS_CALLS\s*=/m);
  });

  test("other_stored is no longer assigned in test_cr092_next_decision_resolver.py", () => {
    const src = readSource("tests/client/test_cr092_next_decision_resolver.py");
    expect(src).not.toMatch(/cls\.other_stored\s*=/);
  });
});

describe("§S2 item 7 — the 17 tsc --noUnusedLocals diagnostics (AC2)", () => {
  test("none of the 17 branch-cut unused-local/import/type diagnostics remain", () => {
    // The exact (file, symbol) pairs `tsc --noEmit -p tsconfig.json
    // --noUnusedLocals --noUnusedParameters` reports today, minus the two
    // `reply` parameters in src/v2.ts (kept on purpose, out of AC2's scope).
    const targets: ReadonlyArray<{ file: string; name: string }> = [
      { file: "tests/coverage-trend-drilldown.test.ts", name: "rollupOnlyDay" },
      { file: "tests/cr009-release-bundle.test.ts", name: "lower" },
      { file: "tests/cross-surface-400s.test.ts", name: "JUNIT_3CASE_1FAIL" },
      { file: "tests/density.test.ts", name: "tier" },
      { file: "tests/e2e-harness-agent-identity.test.ts", name: "REPO_ROOT" },
      { file: "tests/e2e/teardown-contracts/ephemeral.contract.ts", name: "E2E_PORT" },
      { file: "tests/ingest-cycle-validation.test.ts", name: "PlansListResponse" },
      { file: "tests/liveness.test.ts", name: "DEFAULT_LIVENESS" },
      { file: "tests/manager-archive.test.ts", name: "manager" },
      { file: "tests/plans-global.test.ts", name: "planAOpen" },
      { file: "tests/registered-caller-auth.test.ts", name: "planId" },
      { file: "tests/registered-caller-auth.test.ts", name: "h" },
      { file: "tests/roadmap-registration-store.test.ts", name: "RunEvent" },
      { file: "tests/server-limits-are-configuration.test.ts", name: "clearEnv" },
      { file: "tests/server-limits-are-configuration.test.ts", name: "setEnv" },
      { file: "tests/undelivered-release-is-the-plannable-target.test.ts", name: "server" },
      { file: "tests/workflow-lens.test.ts", name: "now" },
    ];
    expect(targets.length).toBe(17);

    const proc = Bun.spawnSync({
      cmd: ["bun", "x", "tsc", "--noEmit", "-p", "tsconfig.json", "--noUnusedLocals", "--noUnusedParameters"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${proc.stdout.toString("utf8")}\n${proc.stderr.toString("utf8")}`;
    const lines = output.split("\n");

    const stillPresent = targets.filter(({ file, name }) =>
      lines.some((line) => line.startsWith(`${file}(`) && line.includes(`'${name}' is declared`)),
    );

    expect(stillPresent).toEqual([]);
  }, 60_000);
});

describe("§S3 repository leftovers (AC4-AC6)", () => {
  test("crucible.db at the repo root is untracked", () => {
    const proc = Bun.spawnSync({
      cmd: ["git", "ls-files", "--error-unmatch", "crucible.db"],
      cwd: REPO_ROOT,
    });
    expect(proc.exitCode).not.toBe(0);
  });

  test("crucible.db at the repo root is gitignored", () => {
    const proc = Bun.spawnSync({
      cmd: ["git", "check-ignore", "crucible.db"],
      cwd: REPO_ROOT,
    });
    expect(proc.exitCode).toBe(0);
  });

  test("@cucumber/gherkin and happy-dom are gone from package.json's dependency maps", () => {
    const pkg = readJson("package.json");
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;

    expect(Object.hasOwn(devDeps, "@cucumber/gherkin")).toBe(false);
    expect(Object.hasOwn(devDeps, "happy-dom")).toBe(false);
    expect(Object.hasOwn(deps, "@cucumber/gherkin")).toBe(false);
    expect(Object.hasOwn(deps, "happy-dom")).toBe(false);
  });

  test("playwright is declared in package.json or no longer imported directly under tests/ or src/", () => {
    const pkg = readJson("package.json");
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    const declared = Object.hasOwn(deps, "playwright") || Object.hasOwn(devDeps, "playwright");

    const proc = Bun.spawnSync({
      cmd: ["git", "grep", "-l", "-E", String.raw`from ["']playwright["']`, "--", "tests", "src"],
      cwd: REPO_ROOT,
    });
    const importedDirectly = proc.exitCode === 0;

    expect(declared || !importedDirectly).toBe(true);
  });
});
