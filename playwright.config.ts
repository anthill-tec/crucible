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
  // Single logical suite (3 features / 15 scenarios), run serially: F1
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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
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
