// CR-CRU-007 C5b — project/agent seeding + run-ingest steps. Every step
// delegates to tests/e2e/steps/harness.ts (lifted unchanged from the
// pre-conversion .e2e.ts files) so the ACTUAL request bodies/fixtures are
// identical to what the superseded suite sent.
import { Step } from "./world.ts";
import {
  seedProject,
  registerAgent,
  ingestJunit,
  ingestParsed,
  ingestCompile,
  JUNIT_3CASE_1FAIL,
  junit60,
  RUSTC_ERRORS,
} from "./harness.ts";

Step("a project named {string} is registered", async ({ request, world }, name: string) => {
  world.projectKey = await seedProject(request, name);
});

Step(
  "an online agent {string} with message {string} is registered on that project",
  async ({ request, world }, agentId: string, message: string) => {
    await registerAgent(request, world.projectKey as string, agentId, message);
  },
);

Step(
  "an older project named {string} is registered with an online agent {string} \\(message {string}\\)",
  async ({ request, world }, name: string, agentId: string, message: string) => {
    world.olderProjectKey = await seedProject(request, name);
    await registerAgent(request, world.olderProjectKey as string, agentId, message);
  },
);

Step(
  "a project named {string} is registered with an online agent {string} \\(message {string}\\)",
  async ({ request, world }, name: string, agentId: string, message: string) => {
    world.projectKey = await seedProject(request, name);
    await registerAgent(request, world.projectKey, agentId, message);
  },
);

Step(
  "a passing 1-test run is ingested for agent {string} on that project",
  async ({ request, world }, agentId: string) => {
    const res = await ingestParsed(request, world.projectKey as string, agentId, {
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      duration_ms: 5,
    });
    world.eventId = res.event;
  },
);

Step(
  "a failing 3-case junit run \\(1 failing\\) is ingested for agent {string} at tier {string}",
  async ({ request, world }, agentId: string, tier: string) => {
    const res = await ingestJunit(request, world.projectKey as string, agentId, JUNIT_3CASE_1FAIL, tier);
    world.eventId = res.event;
  },
);

Step(
  "a 60-test junit run with {int} failures is ingested for agent {string} at tier {string}",
  async ({ request, world }, failCount: number, agentId: string, tier: string) => {
    const res = await ingestJunit(
      request,
      world.projectKey as string,
      agentId,
      junit60(failCount),
      tier,
    );
    world.eventId = res.event;
  },
);

Step(
  "a rustc compile error report is ingested for agent {string}",
  async ({ request, world }, agentId: string) => {
    const res = await ingestCompile(request, world.projectKey as string, agentId, RUSTC_ERRORS, "rustc");
    world.eventId = res.event;
  },
);

Step("a fail\\(2\\/5\\) run is ingested for agent {string}", async ({ request, world }, agentId: string) => {
  const res = await ingestParsed(request, world.projectKey as string, agentId, {
    total: 5,
    passed: 3,
    failed: 2,
    pending: 0,
    duration_ms: 40,
  });
  world.eventId = res.event;
});

Step("a pass\\(5\\/5\\) run is ingested for agent {string}", async ({ request, world }, agentId: string) => {
  const res = await ingestParsed(request, world.projectKey as string, agentId, {
    total: 5,
    passed: 5,
    failed: 0,
    pending: 0,
    duration_ms: 60,
  });
  world.eventId = res.event;
});

function coverageFor(percent: number): { lines: { total: number; covered: number; percent: number } } {
  return { lines: { total: 10, covered: Math.round((10 * percent) / 100), percent } };
}

Step(
  "a green regression run with {int}% coverage is ingested for agent {string}",
  async ({ request, world }, percent: number, agentId: string) => {
    await ingestParsed(
      request,
      world.projectKey as string,
      agentId,
      { total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 500 },
      { tier: "regression", coverage: coverageFor(percent) },
    );
  },
);

Step(
  "a second green regression run with {int}% coverage is ingested for agent {string}",
  async ({ request, world }, percent: number, agentId: string) => {
    await ingestParsed(
      request,
      world.projectKey as string,
      agentId,
      { total: 10, passed: 10, failed: 0, pending: 0, duration_ms: 500 },
      { tier: "regression", coverage: coverageFor(percent) },
    );
  },
);
