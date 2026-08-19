// CR-CRU-006 §S6 — E2E harness seed. Playwright (headless chromium only)
// driving the REAL served SPA against a REAL server instance.
//
// CR-CRU-052 §S5/§S5b — DB isolation, asserted POSITIVELY.
//
// This comment previously claimed "no CRUCIBLE_DB env var exists to do this
// more directly". That was true when written, and CR-CRU-043 made it false:
// `resolveDbPath()` (src/server.ts) now resolves, first match wins,
//   1. an explicit `StartServerOpts.dbPath` (never passed on the CLI boot path),
//   2. `CRUCIBLE_DB`,
//   3. an ALREADY-EXISTING `<cwd>/data/crucible.db`,
//   4. `<XDG_DATA_HOME or <HOME>/.local/share>/crucible/crucible.db`.
//
// Relying on the scratch `cwd` alone therefore stopped isolating anything: a
// throwaway cwd is precisely what guarantees rule 3 misses, so every default
// E2E run since CR-CRU-043 fell through to rule 4 and wrote to the PERSISTENT,
// user-level `~/.local/share/crucible/crucible.db`. Measured 2026-08-03: that
// file held 79 projects / 259 events, all `/tmp/e2e` fixtures accumulated
// across runs — and F1 ("fresh forge — empty state") cannot pass against them.
//
// So isolation is now declared EXPLICITLY, via `webServer.env.CRUCIBLE_DB`
// (see the `webServer` stanza below) — rule 2, which outranks both the cwd
// probe and the user-level fallback, so no cwd, HOME or XDG_DATA_HOME value
// can route this suite at a real database. The scratch `cwd` is KEPT and the
// scratch DB lives inside it, so rules 2 and 3 name the same file and agree
// rather than diverge. `tests/e2e/teardown-contracts/crucible-db-isolation.test.ts`
// feeds this config's real `webServer.env` through the real `resolveDbPath`
// and asserts the result is neither the user-level nor the XDG path.
import { defineConfig, devices } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// CR-CRU-052 §S3 — the port is OWNED by the harness (E2E_PORT) and imported
// here rather than declared locally, so the port this config binds and the port
// `seedProject`'s ephemeral guard demands cannot drift apart. Direction is
// deliberate: config depends on harness, never the reverse.
import { E2E_PORT as PORT } from "./tests/e2e/steps/harness.ts";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "server.ts");
const SCRATCH_CWD = mkdtempSync(path.join(tmpdir(), "crucible-e2e-"));
// CR-CRU-052 §S5 — the per-run database, named explicitly rather than left to
// be resolved. A real FILE (not `:memory:`) deliberately: the webServer is a
// separate long-lived process, so either would survive across requests within a
// run, but a file additionally (a) exercises the same on-disk/WAL store path
// production uses — `Store`'s constructor skips `PRAGMA journal_mode = WAL` for
// `:memory:`, so an in-memory E2E DB would test a configuration no deployment
// runs — and (b) leaves an inspectable post-mortem artifact next to Playwright's
// retained traces when a scenario fails. It sits under SCRATCH_CWD, so it is
// exactly the path rule 3 would have adopted, and `startServer()` creates the
// `data/` parent itself (`mkdirSync(path.dirname(dbPath), {recursive: true})`).
const SCRATCH_DB = path.join(SCRATCH_CWD, "data", "crucible.db");

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
    // CR-CRU-052 §S5 — Playwright spawns this command with
    // `{...process.env, ...env}` (verified in playwright/lib/plugins/
    // webServerPlugin.js), so CRUCIBLE_DB here OVERRIDES any ambient
    // CRUCIBLE_DB the developer's shell happens to export: the suite cannot
    // be pointed at a real database by accident, only by editing this line.
    env: { CRUCIBLE_PORT: String(PORT), CRUCIBLE_DB: SCRATCH_DB },
    port: PORT,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
