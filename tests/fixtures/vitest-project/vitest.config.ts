// A Vitest project the bun client's tests drive from a scratch copy.
//
// Vitest takes none of `bun test`'s report flags, so the JUnit path arrives the
// way the project's `crucible.reportPath` declares it: in FIXTURE_JUNIT_PATH.
// `include` names only this fixture's own `*.vitest.ts` files, which no
// `bun test` discovery pattern collects. Caches stay inside the project root
// (the scratch copy), never in a shared `node_modules`.
//
// The Crucible reporter is added from CRUCIBLE_REPORTERS, the directory the
// client hands the runner, and only when it is set: with no client the config
// runs unchanged and names no machine path.
import { defineConfig } from "vitest/config";

const junitPath = process.env["FIXTURE_JUNIT_PATH"];
const crucibleReporters = process.env["CRUCIBLE_REPORTERS"];
const baseReporters = junitPath ? ["default", "junit"] : ["default"];

export default defineConfig({
  cacheDir: ".vite-cache",
  test: {
    include: ["**/*.vitest.ts"],
    fsModuleCache: false,
    reporters: crucibleReporters
      ? [...baseReporters, `${crucibleReporters}/vitest-crucible.ts`]
      : baseReporters,
    ...(junitPath ? { outputFile: { junit: junitPath } } : {}),
  },
});
