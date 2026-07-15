// CR-CRU-007 C5b — shared BDD "world": a per-scenario mutable bag that
// Given/When/Then steps use to pass state (seeded project keys, ingested
// event ids, spawned child processes, …) to later steps in the SAME
// scenario. Each generated Playwright test gets its own fresh `world`
// (Playwright fixtures are test-scoped), so state never leaks across
// scenarios even though workers:1/fullyParallel:false makes them run
// sequentially.
import { test as base, createBdd } from "playwright-bdd";
import type { ChildProcess } from "node:child_process";

export interface World {
  projectKey?: string;
  olderProjectKey?: string;
  eventId?: string;
  standalone?: { baseUrl: string; child: ChildProcess };
  [key: string]: unknown;
}

export const test = base.extend<{ world: World }>({
  // eslint-disable-next-line no-empty-pattern
  world: async ({}, use) => {
    await use({});
  },
});

export const { Given, When, Then, Step } = createBdd(test);
