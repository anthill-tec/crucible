// CR-CRU-007 C5b — shared BDD "world": a per-scenario mutable bag that
// Given/When/Then steps use to pass state (seeded project keys, ingested
// event ids, spawned child processes, …) to later steps in the SAME
// scenario. Each generated Playwright test gets its own fresh `world`
// (Playwright fixtures are test-scoped), so state never leaks across
// scenarios even though workers:1/fullyParallel:false makes them run
// sequentially.
import { test as base, createBdd } from "playwright-bdd";
import type { ChildProcess } from "node:child_process";
import { teardownSeededProjects } from "./harness.ts";

export interface World {
  projectKey?: string;
  olderProjectKey?: string;
  eventId?: string;
  standalone?: { baseUrl: string; child: ChildProcess };
  [key: string]: unknown;
}

export const test = base.extend<{ world: World; seededProjectTeardown: void }>({
  // eslint-disable-next-line no-empty-pattern
  world: async ({}, use) => {
    await use({});
  },
  // CR-CRU-052 §S2 — THE wiring point for the whole BDD suite. Every generated
  // spec (and therefore every scenario in tests/e2e/features/*.feature) runs on
  // this `test` object, so an `auto` fixture here tears down each scenario's
  // seeded projects without a single step file having to remember to. Fixture
  // teardown (the code after `use()`) is the same Playwright guarantee an
  // `afterEach` gives — it runs whether the scenario passed, failed or timed
  // out — which is exactly the failure path §S2 says matters most, and it is
  // preferred over a module-level `test.afterEach()` here because a hook
  // registered from an imported module attaches only to whichever spec file
  // happened to load it first, whereas a fixture applies to every test
  // uniformly. `request` is the same instance the steps seed with, so the
  // per-instance registry in harness.ts resolves to exactly this scenario's
  // keys; declaring the dependency also guarantees `request` outlives this
  // teardown (fixtures tear down in reverse dependency order).
  seededProjectTeardown: [
    async ({ request }, use) => {
      await use();
      await teardownSeededProjects(request);
    },
    { auto: true },
  ],
});

export const { Given, When, Then, Step } = createBdd(test);
