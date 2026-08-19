// CR-CRU-060 RED (cycle 183) — the e2e harness (tests/e2e/steps/harness.ts)
// predates CR-CRU-056's requireRegisteredCaller hard stop. Re-derived this
// cycle against a real, isolated ephemeral server (§S1 inventory, measured
// three times via `bunx playwright test`, byte-for-byte identical each
// time): 19 failed / 11 passed / 10 blocked (dependent Playwright projects
// never ran because their `chromium` dependency failed). Every one of the
// 19 is an HTTP 409 from `requireRegisteredCaller` — zero UI/layout/timeline
// assertions fail — split exactly 10 `filePlan` + 5 `ingestParsed` +
// 3 `ingestJunit` + 1 `ingestCompile`, matching this CR's own Context
// measurement precisely. See
// docs/changes/CR-CRU-060-e2e-harness-identity-drift.md.
//
// Why this file, not a Playwright e2e scenario or the
// tests/e2e/teardown-contracts/ standalone-Playwright-config pattern:
// harness.ts's filePlan / registerAgent / ingestParsed / ingestJunit /
// ingestCompile are plain APIRequestContext-driven HTTP calls — none of
// them touch `test.info()` / `assertEphemeralTarget` (only seedProject /
// teardownSeededProjects do, per CR-CRU-052 §S3's own header comment), so
// they need no live Playwright `test()` wrapper to be callable. Verified
// this cycle: `@playwright/test`'s `request.newContext()` factory works
// standalone inside a plain `bun:test` process (no browser, no `test()`
// block) against a REAL in-process server booted via
// `startServer({port: 0, dbPath: ":memory:"})` — genuine HTTP, genuine
// identity gate, zero DB-leak risk (in-memory, this process only, never
// `~/.local/share/crucible/crucible.db` — the exact leak CR-CRU-052 closed
// and this CR must not reopen). This is lighter than a second full
// Playwright webServer-subprocess config and it drives the EXACT exported
// functions GREEN will modify, which is what makes it an honest RED bed for
// this CR's specific contract (harness identity, not UI behaviour).
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { request, type APIRequestContext } from "@playwright/test";
import { startServer } from "../src/server.ts";
import {
  filePlan,
  ingestCompile,
  ingestJunit,
  ingestParsed,
  JUNIT_3CASE_1FAIL,
  registerAgent,
  RUSTC_ERRORS,
} from "./e2e/steps/harness.ts";

const REPO_ROOT = join(import.meta.dir, "..");

let handle: ReturnType<typeof startServer> | undefined;
let ctx: APIRequestContext | undefined;

afterEach(async () => {
  await ctx?.dispose();
  handle?.stop();
  ctx = undefined;
  handle = undefined;
});

/**
 * Boots a REAL, in-process, in-memory server (`:memory:` — never touches
 * disk, never the persistent user-level DB) and a Playwright
 * `APIRequestContext` pointed at it: the same request-shaped object
 * harness.ts's helpers are typed to accept. Seeds one project directly
 * through the real `Store` (bypassing HTTP for the seed itself, matching
 * `tests/agent-cycle-binding.test.ts`'s own precedent for this exact
 * server-level test shape) so every test below starts from a real,
 * queryable project.
 */
async function boot(): Promise<{ projectKey: string }> {
  handle = startServer({ port: 0, dbPath: ":memory:" });
  ctx = await request.newContext({ baseURL: `http://127.0.0.1:${handle.server.port}` });
  const key = crypto.randomUUID();
  handle.store.addProject({
    key,
    name: "e2e-harness-identity",
    type: "backend",
    sutRoot: "/tmp/e2e",
  });
  return { projectKey: key };
}

function req(): APIRequestContext {
  if (ctx === undefined) throw new Error("boot() was not called before req()");
  return ctx;
}

/** The live set of agentIds registered against a project, via the real
 * GET /api/v2/agents surface — never a raw store read — so a passing
 * assertion proves the SAME thing an operator's own query would show. */
async function agentIdsFor(projectKey: string): Promise<string[]> {
  const res = await req().get(`/api/v2/agents?project=${projectKey}`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ok: true; agents: Array<{ agentId: string }> };
  return body.agents.map((a) => a.agentId);
}

describe("§S2 — filePlan declares a registered caller (CR-CRU-060)", () => {
  test("filePlan resolves with no route rejecting it for identity, called with NO prior caller registration", async () => {
    const { projectKey } = await boot();

    // The EXACT shape workflow.steps.ts already calls filePlan with today
    // (harness.ts:243-259 / workflow.steps.ts:19): no agentId argument at
    // all, no prior registerAgent call by the caller. TODAY this rejects
    // with a 409 "a registered caller is required — this request carried
    // no agentId" inside filePlan's own `expect(res.ok()).toBe(true)`
    // (harness.ts:257), so the promise below REJECTS instead of resolving.
    const plan = await filePlan(req(), projectKey, "CR-DRIFT-1", ["c1 red-green"]);

    // POSITIVE — the exact server-computed shape for a fresh plan.
    expect(plan.cr).toBe("CR-DRIFT-1");
    expect(plan.status).toBe("open");
    expect(plan.cycles).toHaveLength(1);
    expect(plan.cycles[0]!.label).toBe("c1 red-green");
    // NEGATIVE / bound — an omitted `kind` defaults to exactly
    // "red-green" (src/v2.ts's parseCycleInput), never anything else and
    // never a second, unrequested cycle.
    expect(plan.cycles[0]!.kind).toBe("red-green");
  });
});

describe("§S3 — ingest calls carry a REGISTERED id even when the caller supplies an unregistered one (CR-CRU-060)", () => {
  test("ingestParsed succeeds for a generated crb-filler-* id nothing registered — the cycle-run-navigation.steps.ts shape", async () => {
    const { projectKey } = await boot();
    const unregisteredId = "crb-filler-0";

    // NEGATIVE precondition — genuinely unregistered before the call, or
    // the "still succeeds" assertion below would be vacuous.
    expect(await agentIdsFor(projectKey)).not.toContain(unregisteredId);

    // TODAY this rejects 409 "agent crb-filler-0 is not registered with
    // this project — refused" inside ingestParsed's own
    // `expect(res.ok()).toBe(true)` (harness.ts:214).
    const result = await ingestParsed(req(), projectKey, unregisteredId, {
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      duration_ms: 5,
    });

    expect(typeof result.event).toBe("string");
    expect(result.event.length).toBeGreaterThan(0);
    // POSITIVE observable effect tied to the ingest above: the id is now a
    // genuinely registered agent on this project — proves the guarantee
    // actually ran server-side, not merely that some bypass let the POST
    // through.
    expect(await agentIdsFor(projectKey)).toContain(unregisteredId);
  });

  test("ingestJunit succeeds for a caller-supplied unregistered id", async () => {
    const { projectKey } = await boot();
    const unregisteredId = "crb-filler-junit-0";
    expect(await agentIdsFor(projectKey)).not.toContain(unregisteredId);

    const result = await ingestJunit(req(), projectKey, unregisteredId, JUNIT_3CASE_1FAIL, "unit");

    expect(typeof result.event).toBe("string");
    expect(await agentIdsFor(projectKey)).toContain(unregisteredId);
  });

  test("ingestCompile succeeds for a caller-supplied unregistered id", async () => {
    const { projectKey } = await boot();
    const unregisteredId = "crb-filler-compile-0";
    expect(await agentIdsFor(projectKey)).not.toContain(unregisteredId);

    const result = await ingestCompile(req(), projectKey, unregisteredId, RUSTC_ERRORS, "rustc");

    // POSITIVE — the exact RUSTC_ERRORS fixture shape (1 error[E0308] block
    // + 1 plain warning block, per harness.ts's own fixture comment).
    expect(result.errors).toBe(1);
    expect(result.warnings).toBe(1);
    expect(await agentIdsFor(projectKey)).toContain(unregisteredId);
  });
});

describe("§S4 — the ensure-registered guarantee is idempotent (CR-CRU-060)", () => {
  test("ingestParsed twice for the SAME initially-unregistered id both succeed — no duplicate-registration failure, no duplicate agent row", async () => {
    const { projectKey } = await boot();
    const id = "crb-filler-repeat-0";

    const first = await ingestParsed(req(), projectKey, id, {
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      duration_ms: 5,
    });
    expect(typeof first.event).toBe("string");

    // The SECOND call's caller-supplied id is now ALREADY registered — the
    // first call's guarantee registered it. This is exactly the idempotence
    // shape the guarantee must tolerate: a repeat registration must not
    // become a 409, whatever mechanism ends up implementing it.
    const second = await ingestParsed(req(), projectKey, id, {
      total: 5,
      passed: 3,
      failed: 2,
      pending: 0,
      duration_ms: 40,
    });
    expect(typeof second.event).toBe("string");
    expect(second.event).not.toBe(first.event);

    // NEGATIVE / bound — idempotent means exactly ONE agent row for this
    // id, never a second row created by the repeat registration.
    const ids = await agentIdsFor(projectKey);
    expect(ids.filter((a) => a === id)).toHaveLength(1);
  });

  test("a caller that ALREADY registered (the seeding.steps.ts shape) still ingests successfully, with no duplicate agent row", async () => {
    const { projectKey } = await boot();
    const id = "agent-already-registered";

    // The seeding.steps.ts shape exactly (harness.ts:134-144 via
    // seeding.steps.ts:24): registerAgent BEFORE any ingest call.
    await registerAgent(req(), projectKey, id, "pre-registered by the caller");
    expect(await agentIdsFor(projectKey)).toContain(id);

    // This must still succeed — no "already registered" failure from
    // whatever the ensure-registered guarantee does internally when it
    // (unconditionally, per §S4) re-registers an id that is already live.
    const result = await ingestJunit(req(), projectKey, id, JUNIT_3CASE_1FAIL, "unit");
    expect(typeof result.event).toBe("string");

    const ids = await agentIdsFor(projectKey);
    expect(ids.filter((a) => a === id)).toHaveLength(1);
  });
});

describe("AC — no file under src/ is modified (CR-CRU-060 is a harness-only fix)", () => {
  test("git diff (this branch's commits + any uncommitted changes) touches no src/ path", () => {
    const mergeBaseRes = Bun.spawnSync({
      cmd: ["git", "merge-base", "develop", "HEAD"],
      cwd: REPO_ROOT,
    });
    // Falls back to comparing against HEAD (committed diff empty, only the
    // working tree matters) if `develop` is unreachable — still catches the
    // one thing this guard exists for while GREEN is in progress.
    const mergeBase = mergeBaseRes.exitCode === 0 ? mergeBaseRes.stdout.toString().trim() : "HEAD";

    const committed = Bun.spawnSync({
      cmd: ["git", "diff", "--name-only", `${mergeBase}..HEAD`],
      cwd: REPO_ROOT,
    });
    const uncommitted = Bun.spawnSync({
      cmd: ["git", "diff", "--name-only", "HEAD"],
      cwd: REPO_ROOT,
    });
    expect(committed.exitCode).toBe(0);
    expect(uncommitted.exitCode).toBe(0);

    const touched = new Set(
      [...committed.stdout.toString().split("\n"), ...uncommitted.stdout.toString().split("\n")]
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
    const srcTouched = [...touched].filter((p) => p.startsWith("src/"));

    // POSITIVE — the exact AC: no src/ path anywhere in this branch's diff.
    // This is a STANDING invariant (true today, before any GREEN code
    // exists, and required to stay true through GREEN's harness-only fix —
    // see docs/changes/CR-CRU-060-e2e-harness-identity-drift.md's Context:
    // "the fix belongs entirely in the test harness, and nothing in src/
    // should be relaxed to accommodate it"). Unlike the four tests above it
    // is not a fail-now/pass-after-GREEN contract; it is a regression guard
    // GREEN must not trip, mirroring this repo's own standing-invariant
    // precedent for a structural rule (tests/suite-integrity.test.ts's
    // bunfig.toml exclusion-key guard) and
    // tests/e2e/teardown-contracts/crucible-db-isolation.test.ts's second,
    // corroborating (not fail-now) assertion.
    expect(srcTouched).toEqual([]);
  });
});
