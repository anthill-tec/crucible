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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "server.ts");
const PORT = 39_877;
const SCRATCH_CWD = mkdtempSync(path.join(tmpdir(), "crucible-e2e-"));

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  // Single spec file, run serially: F1 asserts a truly empty DB and MUST
  // observe it before F2/F9/layout tests seed projects/agents into the same
  // shared webServer instance.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
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
