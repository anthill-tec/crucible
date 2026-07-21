// CR-CRU-006 §S6 — E2E harness seed. Playwright (headless chromium only)
// driving the REAL served SPA against a REAL server instance.
//
// DB isolation without touching src/: `startServer()` (src/server.ts) resolves
// its default dbPath ("data/crucible.db") relative to `process.cwd()`, so
// pointing the webServer's `cwd` at a throwaway scratch directory gives every
// E2E run a fresh, empty database — no CRUCIBLE_DB env var exists to do this
// more directly (verified by reading src/server.ts: only CRUCIBLE_PORT is
// read from env; dbPath only comes from StartServerOpts, which the CLI boot
// path (`if (import.meta.main)`) never passes).
import { defineConfig, devices } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "server.ts");
const PORT = 39_877;
const SCRATCH_CWD = mkdtempSync(path.join(tmpdir(), "crucible-e2e-"));

// CR-CRU-007 C5b — E2E house style: the E2E layer is proper BDD (Gherkin
// `.feature` files bound to Playwright via playwright-bdd). `bddgen`
// (wired into the `test:e2e` script — see package.json) generates real
// Playwright spec files from these features + step definitions into
// `.features-gen/`; `testDir` below points AT that generated output, not
// at the `.feature` files themselves.
const testDir = defineBddConfig({
  features: "tests/e2e/features/*.feature",
  steps: "tests/e2e/steps/*.ts",
});

export default defineConfig({
  testDir,
  // Single logical suite (4 features / 19 scenarios), run serially: F1
  // asserts a truly empty DB and MUST observe it before F2/F9/layout
  // scenarios seed projects/agents into the same shared webServer instance.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  // "junit" additionally feeds the Crucible auto-ingest path
  // (`bun-crucible.py auto-ingest`), which reads test-reports/junit.xml.
  reporter: [["list"], ["junit", { outputFile: "test-reports/junit.xml" }]],
  use: {
    baseURL: process.env.CRUCIBLE_E2E_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  // CR-CRU-016 C4 — `drill-in.feature` sorts alphabetically before
  // `shell-storyboard.feature` ("d" < "s"), but shell-storyboard.feature's
  // FIRST scenario (F1) asserts a truly empty DB — a precondition that MUST
  // hold before ANY scenario in the shared webServer/DB seeds a project.
  // playwright-bdd's file resolver (tinyglobby) always returns results in
  // alphabetical order regardless of pattern order passed to `features`
  // (verified: reordering the `features` array above had no effect), so
  // ordering must be enforced at the Playwright project level instead:
  // Playwright's documented "project dependencies" guarantee a dependency
  // project completes before its dependent starts, independent of file
  // discovery order. `chromium` covers everything except drill-in.feature;
  // `chromium-drill-in` depends on it and runs strictly after.
  //
  // CR-CRU-025 C4 — `cycle-run-navigation.feature` sorts alphabetically
  // BEFORE drill-in.feature too ("cycle" < "drill" < "shell"), which would
  // break the SAME F1 precondition. Same fix, its own dependent project
  // (`chromium-cycle-run-navigation`) — it and `chromium-drill-in` have no
  // ordering requirement relative to EACH OTHER (each seeds its own
  // namespaced fixtures), only relative to `chromium`.
  //
  // CR-CRU-034 C1 RED — `drilldown-dual-axis-scroll.feature` sorts
  // alphabetically right after drill-in.feature ("drill-in" < "drilldown",
  // the hyphen sorts before any letter) — still BEFORE shell-storyboard's
  // F1 precondition. Same fix again, its own dependent project
  // (`chromium-drilldown-dual-axis-scroll`); no ordering requirement
  // relative to `chromium-drill-in` / `chromium-cycle-run-navigation`
  // (own namespaced "DDA …" fixtures), only relative to `chromium`.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore:
        /(drill-in|cycle-run-navigation|drilldown-dual-axis-scroll)\.feature\.spec\.js$/,
    },
    {
      name: "chromium-drill-in",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /drill-in\.feature\.spec\.js$/,
      dependencies: ["chromium"],
    },
    {
      name: "chromium-cycle-run-navigation",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /cycle-run-navigation\.feature\.spec\.js$/,
      dependencies: ["chromium"],
    },
    {
      name: "chromium-drilldown-dual-axis-scroll",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /drilldown-dual-axis-scroll\.feature\.spec\.js$/,
      dependencies: ["chromium"],
    },
  ],
  webServer: {
    command: `bun run ${SERVER_ENTRY}`,
    cwd: SCRATCH_CWD,
    env: { CRUCIBLE_PORT: String(PORT) },
    port: PORT,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
