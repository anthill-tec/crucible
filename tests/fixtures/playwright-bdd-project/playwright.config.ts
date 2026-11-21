// A playwright-bdd project the Playwright reporter's tests drive from a scratch
// copy. Its steps never touch `page`, so no browser is launched.
//
// Four projects:
//   - `alpha` and `beta` both run the `@main` feature, so one scenario is
//     reported once per project;
//   - `setup` runs a feature whose one scenario fails;
//   - `after-setup` depends on `setup`, so its scenarios never run.
// Every test is retried once (`retries: 1`): the scenario that fails on its
// first attempt only passes on its retry.
//
// The Crucible reporter is added from CRUCIBLE_REPORTERS, the directory the
// client hands the runner, and only when it is set: with no client the config
// runs unchanged and names no machine path. Playwright's own JUnit report is
// written only to the path FIXTURE_JUNIT_PATH names.
import { defineConfig, type ReporterDescription } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

const crucibleReporters = process.env["CRUCIBLE_REPORTERS"];
const junitPath = process.env["FIXTURE_JUNIT_PATH"];

const reporters: ReporterDescription[] = [["list"]];
if (junitPath) reporters.push(["junit", { outputFile: junitPath }]);
if (crucibleReporters) reporters.push([`${crucibleReporters}/playwright-crucible.ts`]);

const testDir = defineBddConfig({
  features: "features/*.feature",
  steps: "steps/*.ts",
});

export default defineConfig({
  testDir,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: reporters,
  projects: [
    { name: "setup", grep: /@setup-fails/ },
    { name: "alpha", grep: /@main/ },
    { name: "beta", grep: /@main/ },
    { name: "after-setup", grep: /@waits-on-setup/, dependencies: ["setup"] },
  ],
});
