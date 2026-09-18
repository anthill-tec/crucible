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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// CR-CRU-139 §S1/§S1b — the LISTENER is declared in the server's own file, not
// exported at it: `$CRUCIBLE_PORT` is retired and no longer read, so a child
// left to the environment would fall through to the shipped default and bind
// :3849 — the port a production install occupies. The server finds this file
// by the same rule it finds its database (`serverConfigPath()` ->
// `dirname(CRUCIBLE_DB)/crucible.toml`), so it is written beside SCRATCH_DB
// and the suite's port stays OWNED by the harness (`E2E_PORT`), declared here
// exactly once.
mkdirSync(path.dirname(SCRATCH_DB), { recursive: true });
writeFileSync(
  path.join(path.dirname(SCRATCH_DB), "crucible.toml"),
  `[server]\nhost = "127.0.0.1"\nport = ${String(PORT)}\n`,
);

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
  //
  // CR-CRU-133 §S2 — `package.json`'s `crucible.reportPath` DECLARES that this
  // target takes its report path from PLAYWRIGHT_JUNIT_OUTPUT_NAME, and
  // playwright's junit reporter prefers an explicit `outputFile` OVER that
  // variable — so a hardcoded path here would make the declaration a lie and
  // the client could never move the file this suite writes. The default is
  // kept for a bare `bun run test:e2e`, which is unaffected.
  //
  // CR-CRU-015 §S2 — and the RAW report the SERVER decodes. The JUnit XML has
  // no notion of a `test.step`, so every Gherkin step this suite executes is
  // already gone by the time that file is written; playwright's own JSON
  // report keeps them, and `src/codecs/playwright.ts` (registered as the
  // `"playwright"` codec) turns them back into the feature → scenario → step
  // tree. `package.json`'s `crucible.rawReport` DECLARES that this target
  // takes that report's path from PLAYWRIGHT_JSON_OUTPUT_NAME, so the path is
  // read from the environment for exactly the reason the junit reporter above
  // reads one: playwright's json reporter prefers an explicit `outputFile`
  // OVER the variable, and a hardcoded path here would make the declaration a
  // lie. The default keeps a bare `bun run test:e2e` writing beside the XML.
  reporter: [
    ["list"],
    [
      "junit",
      {
        outputFile:
          process.env.PLAYWRIGHT_JUNIT_OUTPUT_NAME ?? "test-reports/junit.xml",
      },
    ],
    [
      "json",
      {
        outputFile:
          process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? "test-reports/playwright.json",
      },
    ],
  ],
  use: {
    baseURL: process.env.CRUCIBLE_E2E_BASE_URL ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  // ORDERING. One scenario in this suite — shell-storyboard.feature's F1,
  // "fresh forge — empty state" — asserts a database NOTHING has seeded, and
  // every scenario shares one webServer and one DB for the whole run. Its
  // `Given a fresh, empty Crucible database` is a NO-OP step (see
  // tests/e2e/steps/navigation.steps.ts): the emptiness is provided by running
  // FIRST, not by truncating anything, so the precondition is an ordering
  // constraint and there is exactly one of it.
  //
  // playwright-bdd's file resolver (tinyglobby) always returns files in
  // alphabetical order regardless of the order passed to `features` (verified:
  // reordering the `features` array above had no effect), and F1's file sorts
  // well down that list — so the constraint is enforced at the Playwright
  // PROJECT level, where "project dependencies" are documented to complete a
  // dependency project before any dependent starts.
  //
  // CR-CRU-016 C4 / CR-CRU-025 C4 / CR-CRU-034 C1 / CR-CRU-017 §S3 each hit
  // this constraint when adding a feature that sorts BEFORE shell-storyboard,
  // and each answered it the same way: pin THAT feature into its own project
  // that `dependencies` on `chromium`, so it runs after the whole main body.
  //
  // CR-CRU-015 §S2 — that edge is WIDER than the constraint, and the width is
  // not free. Playwright skips every dependent project when its dependency
  // project holds ANY failing test (`hasFailedDeps` in the runner's phase
  // loop, measured here: one failing scenario in `chromium` left "14 did not
  // run"). Since this CR makes the suite's own report the board's evidence,
  // those 14 scenarios land as nodes with no steps and no verdict — a reader
  // cannot tell a skipped specification from an empty one. So the DEPENDENCY
  // is narrowed to the constraint that actually exists: F1 is TAGGED
  // `@empty-db` in its own feature file and is the whole of the dependency
  // project, and every other project depends on THAT. A failure anywhere in
  // the main body now skips nothing, because nothing depends on it.
  //
  // The four stay their own projects, declared AFTER `chromium` and running
  // after it: measured, moving them into `chromium` (where file order puts
  // them first) reds CR-CRU-034 §S1, which needs the DB state the main body
  // leaves behind. They share a phase with `chromium` (same dependency
  // depth), and a phase runs its projects in declaration order on the single
  // declared worker — which is exactly the relative order the four have
  // always had among themselves.
  projects: [
    {
      name: "chromium-empty-db",
      use: { ...devices["Desktop Chrome"] },
      grep: /@empty-db/,
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      grepInvert: /@empty-db/,
      testIgnore:
        /(drill-in|cycle-run-navigation|drilldown-dual-axis-scroll|run-lifecycle)\.feature\.spec\.js$/,
      dependencies: ["chromium-empty-db"],
    },
    {
      name: "chromium-drill-in",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /drill-in\.feature\.spec\.js$/,
      dependencies: ["chromium-empty-db"],
    },
    {
      name: "chromium-cycle-run-navigation",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /cycle-run-navigation\.feature\.spec\.js$/,
      dependencies: ["chromium-empty-db"],
    },
    {
      name: "chromium-drilldown-dual-axis-scroll",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /drilldown-dual-axis-scroll\.feature\.spec\.js$/,
      dependencies: ["chromium-empty-db"],
    },
    {
      name: "chromium-run-lifecycle",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /run-lifecycle\.feature\.spec\.js$/,
      dependencies: ["chromium-empty-db"],
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
    env: { CRUCIBLE_DB: SCRATCH_DB },
    port: PORT,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
