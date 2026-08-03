// CR-CRU-052 §S2/§S3 RED — see ephemeral.playwright.config.ts for why this
// lives as a standalone Playwright spec rather than a bun:test file or a
// BDD feature.
//
// Why NOT bun:test: harness.ts's seedProject/registerAgent/etc. are ONLY
// ever consumed from tests/e2e/steps/*.steps.ts (verified: no bun:test file
// in this repo imports tests/e2e/steps/harness.ts — grepped). This CR's
// invented §S3 design (below) makes seedProject depend on
// `test.info().project.use.baseURL`, a Playwright-test-only API that throws
// when called outside a live test run — so seedProject becomes
// UNCALLABLE from bun:test the moment §S3 ships, exactly as it always was
// in practice. A real, running Playwright test is therefore the only
// honest way to exercise any of these contracts, not a shortcut.
//
// Contract shapes this file invents for GREEN (documented, not dictated —
// mirrors tests/project-teardown.test.ts's precedent of pinning an
// RED-authored shape in comments so GREEN has one target to match):
//
//   - harness.ts exports `export const E2E_PORT = 39_877;` — single source
//     of truth for "the ephemeral e2e port". playwright.config.ts (also
//     GREEN-owned) is expected to import it too, replacing its local
//     `const PORT = 39_877`, so the two never drift apart.
//
//   - seedProject tracks every key it creates against the REQUEST INSTANCE
//     it was called with (e.g. `WeakMap<APIRequestContext, string[]>`), and
//     harness.ts exports a companion
//     `teardownSeededProjects(request: APIRequestContext): Promise<void>`
//     that walks THAT instance's tracked keys and, for each, archives then
//     deletes it via §S1's own guarded route — POST `.../archive`, then
//     DELETE `...` with body `{userApproved: true}` — never a raw SQL/store
//     call (§S2 AC 3, contract 3 below). Scoping the registry per REQUEST
//     INSTANCE rather than one global list matters: Playwright hands every
//     test (and its attached hooks) a fresh `request` fixture instance, so
//     per-instance tracking naturally isolates concurrent/sequential tests
//     from each other with no extra bookkeeping.
//
//   - seedProject asserts its target is ephemeral via
//     `test.info().project.use.baseURL`'s port === String(E2E_PORT), NOT a
//     network round trip. A RED-phase smoke probe (this cycle) found
//     `APIResponse.url()` returns only the request PATHNAME (never the
//     origin/port) when called from bun's OWN `bun test` runner against
//     `request.newContext()`. It is unclear whether that specific quirk
//     also reproduces from inside a real `bunx playwright test` worker
//     (those run under Node's ESM loader, a different process than `bun
//     test` — confirmed separately this cycle, since a direct `bun:sqlite`
//     import fails there with "Received protocol 'bun:'"), so this design
//     does not rely on either way. `test.info().project.use.baseURL` was
//     verified DIRECTLY inside a real `bunx playwright test` run this
//     cycle and is pure config introspection, no response parsing — a
//     strictly more robust source of truth regardless. It is also better
//     for the CR's Risk section on its own merits: it can reject BEFORE any
//     network attempt (proven in non-ephemeral.spec.ts, the sibling file
//     for §S3 contract 4), so a mis-pointed call never even reaches a live
//     server.
//
// The server itself is booted by this file's config via a REAL BUN
// SUBPROCESS (Playwright's `webServer` stanza) — see
// ephemeral.playwright.config.ts — not imported directly here, for the
// same bun:sqlite-under-Node reason.
import { test, expect, type APIRequestContext } from "@playwright/test";
import { seedProject, teardownSeededProjects, E2E_PORT } from "../steps/harness.ts";

/** GET /api/v2/projects?archived=true and check whether `key` is present —
 * `archived=true` so a project that was merely archived (not yet deleted)
 * still counts as "exists", making the assertion honest about DELETION
 * specifically, not just disappearance from the default non-archived view. */
async function projectExists(request: APIRequestContext, key: string): Promise<boolean> {
  const res = await request.get("/api/v2/projects?archived=true");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ok: true; projects: Array<{ key: string }> };
  return body.projects.some((p) => p.key === key);
}

test.describe("§S2 contract 1 — every project seedProject creates is deleted by end of run", () => {
  test("two projects seeded in one run are BOTH gone after teardownSeededProjects(request)", async ({
    request,
  }) => {
    const keyA = await seedProject(request, "teardown-contract1-a");
    const keyB = await seedProject(request, "teardown-contract1-b");

    // Positive precondition: both genuinely exist before teardown, or the
    // "gone afterward" assertion below would be vacuous.
    expect(await projectExists(request, keyA)).toBe(true);
    expect(await projectExists(request, keyB)).toBe(true);

    await teardownSeededProjects(request);

    expect(await projectExists(request, keyA)).toBe(false);
    expect(await projectExists(request, keyB)).toBe(false);
  });
});

test.describe("§S2 contract 3 — teardown goes through §S1's guarded route, never raw SQL", () => {
  test("teardownSeededProjects archives THEN DELETEs with userApproved:true — exact calls, exact args", async ({
    request,
  }) => {
    const key = await seedProject(request, "teardown-contract3");

    // Manual monkey-patch spy on the REAL request instance (bun:test's
    // spyOn is unavailable here — this is a Playwright test file, not
    // bun:test): still calls through to the real implementation, so the
    // network traffic + resulting DB state are genuine, not simulated.
    const postCalls: Array<{ url: string; options: unknown }> = [];
    const deleteCalls: Array<{ url: string; options: unknown }> = [];
    const originalPost = request.post.bind(request);
    const originalDelete = request.delete.bind(request);
    (request as unknown as { post: typeof request.post }).post = (async (
      url: string,
      options?: Parameters<typeof originalPost>[1],
    ) => {
      postCalls.push({ url, options });
      return originalPost(url, options);
    }) as typeof request.post;
    (request as unknown as { delete: typeof request.delete }).delete = (async (
      url: string,
      options?: Parameters<typeof originalDelete>[1],
    ) => {
      deleteCalls.push({ url, options });
      return originalDelete(url, options);
    }) as typeof request.delete;

    try {
      await teardownSeededProjects(request);
    } finally {
      (request as unknown as { post: typeof request.post }).post = originalPost;
      (request as unknown as { delete: typeof request.delete }).delete = originalDelete;
    }

    // POSITIVE — the exact §S1 route sequence, exact args.
    const archiveCall = postCalls.find((c) => c.url === `/api/v2/projects/${key}/archive`);
    expect(archiveCall).toBeDefined();

    const deleteCall = deleteCalls.find((c) => c.url === `/api/v2/projects/${key}`);
    expect(deleteCall).toBeDefined();
    expect((deleteCall!.options as { data?: unknown } | undefined)?.data).toEqual({
      userApproved: true,
    });

    // NEGATIVE / bound — exactly one archive + one delete call for this
    // key, never zero (a silent no-op teardown) and never more than one
    // (e.g. an accidental double-delete retry).
    expect(postCalls.filter((c) => c.url === `/api/v2/projects/${key}/archive`).length).toBe(1);
    expect(deleteCalls.filter((c) => c.url === `/api/v2/projects/${key}`).length).toBe(1);

    // Real observable effect tied to the mock verification above — the
    // spy having "seen" the calls proves nothing on its own if the real
    // route rejected them; the project must actually be gone.
    expect(await projectExists(request, key)).toBe(false);
  });
});

test.describe("§S3 contract 5 — seedProject against the ephemeral target still works", () => {
  test("seeding against the real e2e port succeeds and the project is genuinely created", async ({
    request,
  }) => {
    const key = await seedProject(request, "ephemeral-guard-happy-path");
    expect(key).toMatch(/^[0-9a-f-]{36}$/i);

    const res = await request.get("/api/v2/projects?archived=true");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as {
      ok: true;
      projects: Array<{ key: string; name: string }>;
    };
    const created = body.projects.find((p) => p.key === key);
    expect(created).toBeDefined();
    expect(created?.name).toBe("ephemeral-guard-happy-path");
  });
});

test.describe("§S2 contract 2 — teardown runs even when a scenario FAILS", () => {
  let failedScenarioKey: string | undefined;

  // The REAL mechanism under test: hooking teardownSeededProjects into a
  // Playwright afterEach. Playwright GUARANTEES afterEach hooks run
  // regardless of the test body's outcome (pass, fail, or timeout — a RED
  // phase smoke probe this cycle confirmed this exact behavior against
  // this repo's bun+playwright-core combination). This is the framework
  // property §S2 depends on, and it cannot be honestly proven with a
  // bun:test try/finally, which would only prove OUR test code's own
  // finally block ran — not that hooking teardown into Playwright's real
  // lifecycle survives a genuine scenario failure.
  test.afterEach(async ({ request }) => {
    await teardownSeededProjects(request);
  });

  test("a scenario that seeds a project and then deliberately FAILS", async ({ request }) => {
    failedScenarioKey = await seedProject(request, "teardown-contract2-failure-fixture");
    expect(await projectExists(request, failedScenarioKey)).toBe(true);

    // Deliberate failure — the "scenario FAILS" half of the AC. This test
    // is EXPECTED to be reported red; the next test proves teardown still
    // ran despite it.
    expect(1, "CR-CRU-052 RED fixture — deliberately failing scenario").toBe(2);
  });

  test("the FAILED scenario's seeded project is gone afterward — proves afterEach teardown survived the failure", async ({
    request,
  }) => {
    expect(failedScenarioKey, "previous test must have run and captured a key").toBeDefined();
    expect(await projectExists(request, failedScenarioKey!)).toBe(false);
  });
});
