// CR-CRU-007 C5b — shared E2E harness logic, lifted unchanged from the
// pre-conversion tests/e2e/shell.e2e.ts / tests/e2e/timeline.e2e.ts
// (superseded by the Gherkin features + step definitions in this
// directory — see docs/changes/CR-CRU-007-timeline-drill-in.md's
// "E2E house style" AC). Every Given/When/Then step below delegates to
// these functions instead of re-implementing seeding/ingest logic inline.
import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * CR-CRU-052 §S3 — the ONE definition of "the ephemeral e2e port". The root
 * `playwright.config.ts` imports this constant instead of holding its own
 * copy, so the port the suite actually binds and the port `seedProject`'s
 * guard demands can never drift apart. The dependency runs config → harness
 * (never the reverse): the harness is the thing that must be safe when it is
 * copied somewhere else, so it cannot depend on a config it may not be
 * running under.
 */
export const E2E_PORT = 39_877;

/**
 * CR-CRU-052 §S2 — every key `seedProject` created, tracked against the
 * `APIRequestContext` INSTANCE that created it. Playwright hands each test its
 * own `request` fixture instance, so per-instance tracking isolates tests from
 * each other with no extra bookkeeping, and a `WeakMap` lets a finished test's
 * bookkeeping be collected with its fixture.
 */
const seededProjectKeys = new WeakMap<APIRequestContext, string[]>();

/**
 * CR-CRU-052 §S3 — refuse to create anything unless the target is the
 * ephemeral e2e server. Asserted POSITIVELY (the target's port must BE
 * `E2E_PORT`) rather than by blacklisting any known-live address: a blacklist
 * would still permit the same mistake against a server it had never heard of,
 * which is precisely how the residue in this CR's Context table was created.
 *
 * This is pure config introspection — `test.info().project.use.baseURL`, no
 * network round trip — so a mis-pointed call is rejected BEFORE any connection
 * is attempted and a live server never even sees it.
 */
function assertEphemeralTarget(action: string): void {
  const info = test.info();
  const baseURL = info.project.use.baseURL;
  let actualPort: string | undefined;
  if (baseURL !== undefined) {
    try {
      actualPort = new URL(baseURL).port;
    } catch {
      actualPort = undefined;
    }
  }
  if (actualPort === String(E2E_PORT)) return;
  const found = baseURL === undefined ? "no baseURL at all" : `baseURL "${baseURL}"`;
  throw new Error(
    `CR-CRU-052 §S3 — refusing to ${action}: this target is NOT the ephemeral e2e server. ` +
      `Expected a baseURL on the ephemeral e2e port ${E2E_PORT} ` +
      `(as booted by playwright.config.ts, e.g. "http://localhost:${E2E_PORT}"), but Playwright ` +
      `project "${info.project.name}" is configured with ${found}` +
      (actualPort !== undefined && actualPort !== "" ? ` (port ${actualPort})` : "") +
      `. This harness creates REAL projects that persist in whatever database it is pointed at, ` +
      `so it may only run against the throwaway server the e2e config starts. ` +
      `If you copied this helper into an ad-hoc script or repointed the suite at a shared or live ` +
      `server: stop, and instead create the project yourself with POST /api/v2/projects and remove ` +
      `it yourself with POST /api/v2/projects/<key>/archive then ` +
      `DELETE /api/v2/projects/<key> {"userApproved": true}.`,
  );
}

// CR-CRU-008 §S4 — modernized off the retired v1 shim's POST /api/projects/add
// (snake_case sut_root) to the v2 route (camelCase sutRoot); the key is still
// caller-generated so seeded fixtures keep a stable, known project key.
//
// CR-CRU-052 §S3/§S2 — guarded (ephemeral target only, checked before the POST)
// and self-cleaning (every key created is registered for `teardownSeededProjects`).
export async function seedProject(request: APIRequestContext, name: string): Promise<string> {
  assertEphemeralTarget(`seed project "${name}"`);
  const key = crypto.randomUUID();
  const res = await request.post("/api/v2/projects", {
    data: { key, name, sutRoot: "/tmp/e2e" },
  });
  expect(res.ok()).toBe(true);
  const tracked = seededProjectKeys.get(request);
  if (tracked === undefined) {
    seededProjectKeys.set(request, [key]);
  } else {
    tracked.push(key);
  }
  return key;
}

/**
 * CR-CRU-052 §S2 — delete every project `seedProject` created through THIS
 * `request` instance, via CR-CRU-052 §S1's own guarded route: POST
 * `…/archive` (the 403 state gate), then DELETE with `{userApproved: true}`
 * (the 409 approval gate). Never a raw SQL/store call — the harness must
 * exercise the same supported primitive an operator has, or it would be
 * testing a path nobody else can take.
 *
 * Idempotent and safe to call when nothing was seeded: the registry is cleared
 * before the deletes run, so a second call is a no-op rather than a
 * double-delete, and a key someone already removed (404) counts as done.
 * Every key is attempted even if an earlier one fails, so one bad key cannot
 * leak the rest; failures are then reported together.
 */
export async function teardownSeededProjects(request: APIRequestContext): Promise<void> {
  const keys = seededProjectKeys.get(request);
  seededProjectKeys.delete(request);
  if (keys === undefined || keys.length === 0) return;
  const failures: string[] = [];
  for (const key of keys) {
    try {
      const archived = await request.post(`/api/v2/projects/${key}/archive`);
      if (!archived.ok() && archived.status() !== 404) {
        failures.push(`archive ${key} → ${archived.status()} ${await archived.text()}`);
        continue;
      }
      const deleted = await request.delete(`/api/v2/projects/${key}`, {
        data: { userApproved: true },
      });
      if (!deleted.ok() && deleted.status() !== 404) {
        failures.push(`delete ${key} → ${deleted.status()} ${await deleted.text()}`);
      }
    } catch (error) {
      failures.push(`delete ${key} → ${String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `CR-CRU-052 §S2 — teardown failed to remove ${failures.length} seeded project(s); ` +
        `they are LEAKED in the target database: ${failures.join("; ")}`,
    );
  }
}

export async function registerAgent(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  message: string,
): Promise<void> {
  const res = await request.post("/api/v2/agents/register", {
    data: { projectKey, agentId, message, status: "online", role: "report" },
  });
  expect(res.ok()).toBe(true);
}

/**
 * CR-CRU-060 §S2 — the identity `filePlan` (and any other harness helper that
 * needs a caller but is handed none) registers for itself. A single fixed id,
 * not a generated one, so a scenario's board shows ONE harness agent however
 * many plans it files.
 */
export const HARNESS_AGENT_ID = "e2e-harness";

/**
 * CR-CRU-060 §S3/§S4 — the ensure-registered guarantee, at the HELPER
 * boundary. Every helper that hits a `requireRegisteredCaller` route
 * (CR-CRU-056) calls this with the id it is about to send, so the id is a live
 * registered agent by the time the real request goes out — whether the caller
 * registered it (`seeding.steps.ts:24`), generated it and registered nothing
 * (`cycle-run-navigation.steps.ts`'s `crb-filler-*`), or supplied no id at all
 * (`filePlan`).
 *
 * Safe to call UNCONDITIONALLY: registration is idempotent by construction —
 * `handleAgentTouch` (`src/v2.ts:499`) branches on `hasAgent` and merely skips
 * the lifecycle-event journal on a repeat, so a re-register of a live id is a
 * no-op touch, never a duplicate row and never a 409.
 *
 * Deliberately delegates to `registerAgent` rather than posting its own
 * registration: ONE registration idiom, and `registerAgent` already sends
 * `role: "report"` — the non-TDD role that carries no cycle binding, so an e2e
 * fixture can never attach itself to a real plan cycle.
 */
async function ensureRegistered(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
): Promise<void> {
  await registerAgent(
    request,
    projectKey,
    agentId,
    "CR-CRU-060 — e2e harness ensure-registered caller",
  );
}

/** Poll a standalone server's /api/health until it answers ok, or throw. */
export async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // connection refused while the server boots — keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(`server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface RunSummaryInput {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
}

export interface RunIngestResponse {
  event: string;
}

export async function ingestJunit(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  xml: string,
  tier?: string,
): Promise<RunIngestResponse> {
  // CR-CRU-060 §S3/§S4 — the id arrives from the caller; guarantee it here.
  await ensureRegistered(request, projectKey, agentId);
  const res = await request.post("/api/v2/runs", {
    data: {
      projectKey,
      agentId,
      codec: "junit",
      data: xml,
      ...(tier !== undefined ? { tier } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as RunIngestResponse;
}

export async function ingestParsed(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  summary: RunSummaryInput,
  opts?: { coverage?: unknown; tier?: string; context?: unknown },
): Promise<RunIngestResponse> {
  // CR-CRU-060 §S3/§S4 — the id arrives from the caller; guarantee it here.
  await ensureRegistered(request, projectKey, agentId);
  const status = summary.failed > 0 ? "fail" : "pass";
  const res = await request.post("/api/v2/runs/parsed", {
    data: {
      projectKey,
      agentId,
      summary,
      tree: [{ name: "s", status, children: [{ name: "t1", status, duration_ms: 5 }] }],
      ...(opts?.coverage !== undefined ? { coverage: opts.coverage } : {}),
      ...(opts?.tier !== undefined ? { tier: opts.tier } : {}),
      ...(opts?.context !== undefined ? { context: opts.context } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as RunIngestResponse;
}

// CR-CRU-011 §S0/§S0b — cycle-plan API helpers (RED phase, C5 BDD layer).
// Mirrors the ingest helpers above: raw request calls, `expect(res.ok())`
// gate, JSON body returned to the caller's step for world-state stashing.
export interface PlanCycleFixture {
  id: number;
  label: string;
  kind: string;
  status: string;
}

export interface PlanFileResponse {
  planId: number;
  cr: string;
  status: string;
  wave?: string;
  cycles: PlanCycleFixture[];
}

/**
 * POST …/plans — file a plan with one cycle per label, `kind` defaulted.
 * CR-CRU-013 C6 — `wave` is an additive optional 5th arg (existing callers
 * unaffected) so the AC150 e2e round trip can pin a plan to the wave its
 * gate event will later target (§S6 `gated` wave-state qualification keys
 * off `context.wave` matching a closed plan's declared `wave`).
 */
export async function filePlan(
  request: APIRequestContext,
  projectKey: string,
  cr: string,
  cycleLabels: string[],
  wave?: string,
): Promise<PlanFileResponse> {
  // CR-CRU-060 §S2 — `filePlan` is handed no id by ANY of its call sites
  // (gates.steps.ts:22, wave-backfill.steps.ts:21, workflow.steps.ts:19), so
  // it registers one for itself rather than growing a new required argument.
  await ensureRegistered(request, projectKey, HARNESS_AGENT_ID);
  const res = await request.post(`/api/v2/projects/${projectKey}/plans`, {
    data: {
      cr,
      agentId: HARNESS_AGENT_ID,
      cycles: cycleLabels.map((label) => ({ label })),
      ...(wave !== undefined ? { wave } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as PlanFileResponse;
}

/** PATCH …/plans/<planId>/cycles/<cycleId> — a §S0 status transition. */
export async function transitionCycle(
  request: APIRequestContext,
  projectKey: string,
  planId: number,
  cycleId: number,
  status: string,
): Promise<void> {
  // CR-CRU-060 §S2/§S4 — same shape as `filePlan`: a workflow verb behind
  // `requireRegisteredCaller` that no call site hands an id to.
  await ensureRegistered(request, projectKey, HARNESS_AGENT_ID);
  const res = await request.patch(
    `/api/v2/projects/${projectKey}/plans/${planId}/cycles/${cycleId}`,
    { data: { status, agentId: HARNESS_AGENT_ID } },
  );
  expect(res.ok()).toBe(true);
}

/** PATCH …/plans/<planId> {status:"closed", merge} — the CR close. */
export async function closePlan(
  request: APIRequestContext,
  projectKey: string,
  planId: number,
  mergeCommit: string,
): Promise<void> {
  // CR-CRU-060 §S2/§S4 — as `filePlan`/`transitionCycle`.
  await ensureRegistered(request, projectKey, HARNESS_AGENT_ID);
  const res = await request.patch(`/api/v2/projects/${projectKey}/plans/${planId}`, {
    data: { status: "closed", merge: { commit: mergeCommit }, agentId: HARNESS_AGENT_ID },
  });
  expect(res.ok()).toBe(true);
}

/**
 * PATCH …/plans/<planId> {wave} (NO status) — CR-CRU-031 §S1's one-field
 * wave backfill. Allowed on OPEN and CLOSED plans alike (unlike the
 * orchestrator backfill, which 400s a closed plan). Returns the raw
 * `{ok, changed, plan}` envelope so callers can assert `plan.wave` directly.
 */
export async function backfillPlanWave(
  request: APIRequestContext,
  projectKey: string,
  planId: number,
  wave: string,
): Promise<{ ok: boolean; changed: boolean; plan: { wave?: string } }> {
  // CR-CRU-060 §S2/§S4 — as `filePlan`/`transitionCycle`.
  await ensureRegistered(request, projectKey, HARNESS_AGENT_ID);
  const res = await request.patch(`/api/v2/projects/${projectKey}/plans/${planId}`, {
    data: { wave, agentId: HARNESS_AGENT_ID },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { ok: boolean; changed: boolean; plan: { wave?: string } };
}

export interface CompileIngestResponse {
  event: string;
  errors: number;
  warnings: number;
}

export async function ingestCompile(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  errors: string,
  format = "rustc",
): Promise<CompileIngestResponse> {
  // CR-CRU-060 §S3/§S4 — the id arrives from the caller; guarantee it here.
  await ensureRegistered(request, projectKey, agentId);
  const res = await request.post("/api/v2/runs/compile", {
    data: { projectKey, agentId, errors, format },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as CompileIngestResponse;
}

// 3-case junit: 2 pass + 1 fail w/ message="boom" (mirrors the fixture
// already used in tests/v2-runs-events.test.ts; the v1 `ingest-routes.test.ts`
// that first carried it was deleted by CR-CRU-008's C7 v1-retirement sweep).
export const JUNIT_3CASE_1FAIL = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

/** 60-case single-suite junit fixture, `failCount` failing with a shared message. */
export function junit60(failCount = 3): string {
  const cases: string[] = [];
  for (let i = 1; i <= 60; i++) {
    if (i <= failCount) {
      cases.push(
        `<testcase name="t${i}" time="0.01"><failure message="boom-60">trace-${i}</failure></testcase>`,
      );
    } else {
      cases.push(`<testcase name="t${i}" time="0.01"/>`);
    }
  }
  return [`<testsuite name="Suite60" tests="60">`, ...cases, "</testsuite>"].join("\n");
}

// rustc fixture per CR §S2 AC4: 1 error[E0308] block + 1 plain warning block
// (same fixture shape as tests/v2-runs-events.test.ts; the v1
// `ingest-routes.test.ts` it also came from was deleted by CR-CRU-008's C7
// v1-retirement sweep).
export const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

// ── CR-CRU-013 §S1/§S4b — gate/milestone event POST helpers (C6 BDD layer,
// AC150 e2e round trip). Verbatim field names from the CR spec's §S1/§S4b
// shape, matching the fixture already round-tripped server-side by
// tests/gate-milestone-server.test.ts's `defaultGate`/`gateBody` helpers:
// {projectKey, agentId, context?{wave, track?}, gate:{intent, outcome,
// steps:[{name, status, findings?, fixRounds?}], fixes?, push?, pr?}}.
export interface GateStepFixture {
  name: string;
  status: string;
  findings?: { total: number; autoFix: number; askUser: number; fixed: number };
  fixRounds?: number;
}

export interface GatePayload {
  intent: string;
  outcome: "checks-passed" | "passed" | "failed" | "cancelled";
  steps: GateStepFixture[];
  fixes?: Array<{ id: string; file: string; description: string }>;
  push?: { commit: string; remote: string };
  pr?: string;
}

export interface EventPostResponse {
  event: string;
}

/** POST /api/v2/gates — §S1 gate event ingest. */
export async function postGate(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  gate: GatePayload,
  context?: Record<string, unknown>,
): Promise<EventPostResponse> {
  // CR-CRU-060 §S3/§S4 — the id arrives from the caller; guarantee it here.
  await ensureRegistered(request, projectKey, agentId);
  const res = await request.post("/api/v2/gates", {
    data: {
      projectKey,
      agentId,
      gate,
      ...(context !== undefined ? { context } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as EventPostResponse;
}

/** POST /api/v2/milestones — §S4b/§S4c milestone event ingest. */
export async function postMilestone(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  type: string,
  opts?: { label?: string; context?: Record<string, unknown>; commit?: string },
): Promise<EventPostResponse> {
  // CR-CRU-060 §S3/§S4 — the id arrives from the caller; guarantee it here.
  await ensureRegistered(request, projectKey, agentId);
  const res = await request.post("/api/v2/milestones", {
    data: {
      projectKey,
      agentId,
      type,
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
      ...(opts?.context !== undefined ? { context: opts.context } : {}),
      ...(opts?.commit !== undefined ? { commit: opts.commit } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as EventPostResponse;
}
