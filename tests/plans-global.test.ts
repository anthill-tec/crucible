// CR-CRU-026 C2 — §S3.2 gap-analysis decision: a single additive
// `GET /api/v2/plans` — ALL non-archived projects' plans, same item shape as
// the project-scoped list (each item already carries `projectKey`,
// src/store.ts:1306 `toPlan()`), `?fmt=toon` parity, no pagination.
//
// Spec: docs/changes/CR-CRU-026-patch-workspace-plan-scoping.md §S3.2 —
//   "a single additive `GET /api/v2/plans`** — all NON-ARCHIVED projects'
//   plans, same item shape as the scoped list (items already carry
//   `projectKey`), `?fmt=toon` + hints parity, no pagination (plan volumes
//   are small)."
//
// Current code facts (verified against src/v2.ts on this branch):
//   - handleV2() (src/v2.ts ~L996) has NO branch matching
//     `pathname === "/api/v2/plans"` at all — only
//     `/api/v2/projects/<key>/plans` (project-scoped, handlePlansList,
//     src/v2.ts:711) exists. Any request to the bare `/api/v2/plans` path
//     falls through handleV2() -> null -> the server's `/api/` catch-all
//     (src/server.ts:531): `err(404, "unknown route: <method> <path>")`.
//   - store.listProjects() (src/store.ts:431) already excludes archived
//     projects by default (`archived = false` param) — the exclusion this
//     CR needs is a straight consequence of iterating that list, not new
//     store logic.
//   - reply() (src/v2.ts:133) is the shared TOON/JSON negotiation gate every
//     v2 GET route already uses — the SAME "?fmt=toon -> text/toon;
//     charset=utf-8, first line 'ok: true'" convention pinned for sibling
//     routes in tests/axi-negotiation.test.ts.
// So every pin below FAILS against current production: the route does not
// exist yet, so every GET returns the generic 404 route-not-found shape
// instead of {ok:true, plans:[...]}.
//
// Drives the REAL production server (startServer), same harness pattern as
// tests/plans.test.ts / tests/project-archive.test.ts.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

interface CyclePayload {
  id: number;
  label: string;
  kind: string;
  status: string;
  [key: string]: unknown;
}

interface PlanRecord {
  planId: number | string;
  projectKey: string;
  cr: string;
  status: string;
  cycles: CyclePayload[];
  [key: string]: unknown;
}

interface PlanFileResponse extends PlanRecord {}

interface PlansListResponse extends OkResponse {
  plans: PlanRecord[];
}

describe("GET /api/v2/plans — global read, additive (CR-CRU-026 §S3.2)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  // CR-CRU-056 §S2b fixture-repair (C3): mutating v2 workflow verbs (plan-file,
  // cycle transitions, plan close) now refuse an unregistered caller (409) —
  // merge a live-registered agentId into any JSON body lacking one.
  function withFixtureAgent(body: unknown): unknown {
    if (body !== null && typeof body === "object" && !Array.isArray(body) && !("agentId" in (body as Record<string, unknown>))) {
      return { ...(body as Record<string, unknown>), agentId: "fixture-orch" };
    }
    return body;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function registerOrchestrator(key: string, agentId: string): Promise<void> {
    const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/agents/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: key, agentId, phase: "ORCHESTRATOR" }),
    });
    expect(res.status).toBe(200);
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    await registerOrchestrator(body.project.key, "fixture-orch");
    return body.project.key;
  }

  function scopedPlansPath(key: string): string {
    return `/api/v2/projects/${key}/plans`;
  }

  async function filePlan(
    key: string,
    cr: string,
    cycles: Array<{ label: string }> = [{ label: "solo" }],
  ): Promise<PlanFileResponse> {
    const res = await postJson(scopedPlansPath(key), { cr, cycles });
    expect(res.status).toBe(201);
    return (await res.json()) as PlanFileResponse;
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withFixtureAgent(body)),
    });
  }

  /** Seals every cycle (pending -> active -> done) then closes the plan —
   * store.closePlan() 400s while any cycle stays non-terminal (see
   * tests/plans.test.ts's "closing with a non-terminal cycle" pin). */
  async function closePlan(key: string, plan: PlanFileResponse): Promise<void> {
    for (const cycle of plan.cycles) {
      const toActive = await patchJson(
        `${scopedPlansPath(key)}/${plan.planId}/cycles/${cycle.id}`,
        { status: "active" },
      );
      expect(toActive.status).toBe(200);
      const toDone = await patchJson(
        `${scopedPlansPath(key)}/${plan.planId}/cycles/${cycle.id}`,
        { status: "done" },
      );
      expect(toDone.status).toBe(200);
    }
    const closeRes = await patchJson(`${scopedPlansPath(key)}/${plan.planId}`, {
      status: "closed",
      merge: { commit: "abc1234" },
    });
    expect(closeRes.status).toBe(200);
  }

  // ── empty DB ───────────────────────────────────────────────────────────

  test("an empty DB (no projects, no plans) → {ok:true, plans:[]}", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });

    const res = await getJson("/api/v2/plans");

    expect(res.status).toBe(200);
    const body = (await res.json()) as PlansListResponse;
    expect(body.ok).toBe(true);
    expect(body.plans).toEqual([]);
  });

  // ── all projects, same item shape as the scoped list ─────────────────────

  test("returns ALL projects' plans (open + closed), each item identical in shape to the project-scoped list — carrying projectKey", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const keyA = await createProject("global-plans-a");
    const keyB = await createProject("global-plans-b");

    const planAOpen = await filePlan(keyA, "CR-GLOBAL-A-OPEN");
    const planBToClose = await filePlan(keyB, "CR-GLOBAL-B-CLOSED");
    await closePlan(keyB, planBToClose);

    const globalRes = await getJson("/api/v2/plans");
    expect(globalRes.status).toBe(200);
    const globalBody = (await globalRes.json()) as PlansListResponse;
    expect(globalBody.ok).toBe(true);
    expect(globalBody.plans.length).toBe(2);

    const globalA = globalBody.plans.find((p) => p.cr === "CR-GLOBAL-A-OPEN");
    const globalB = globalBody.plans.find((p) => p.cr === "CR-GLOBAL-B-CLOSED");
    expect(globalA).toBeDefined();
    expect(globalB).toBeDefined();
    expect(globalA!.projectKey).toBe(keyA);
    expect(globalB!.projectKey).toBe(keyB);
    expect(globalB!.status).toBe("closed");

    // Shape parity: the SAME plan fetched via the scoped endpoint must be
    // byte-identical to its global-read counterpart (both derive from
    // store.toPlan() — this pins that the global route reuses that exact
    // shape rather than reshaping/dropping fields).
    const scopedARes = await getJson(scopedPlansPath(keyA));
    const scopedABody = (await scopedARes.json()) as PlansListResponse;
    const scopedA = scopedABody.plans.find((p) => p.cr === "CR-GLOBAL-A-OPEN");
    expect(scopedA).toBeDefined();
    expect(globalA).toEqual(scopedA);

    const scopedBRes = await getJson(scopedPlansPath(keyB));
    const scopedBBody = (await scopedBRes.json()) as PlansListResponse;
    const scopedB = scopedBBody.plans.find((p) => p.cr === "CR-GLOBAL-B-CLOSED");
    expect(scopedB).toBeDefined();
    expect(globalB).toEqual(scopedB);
  });

  // ── archived-project exclusion ────────────────────────────────────────────

  test("archiving a project removes its plans from the global read; unarchiving restores them", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const keyKeep = await createProject("global-plans-keep");
    const keyArchive = await createProject("global-plans-archive");

    await filePlan(keyKeep, "CR-GLOBAL-KEEP");
    await filePlan(keyArchive, "CR-GLOBAL-ARCHIVE-ME");

    const before = (await (await getJson("/api/v2/plans")).json()) as PlansListResponse;
    expect(before.plans.map((p) => p.cr).sort()).toEqual(["CR-GLOBAL-ARCHIVE-ME", "CR-GLOBAL-KEEP"]);

    const archiveRes = await postJson(`/api/v2/projects/${keyArchive}/archive`, {});
    expect(archiveRes.status).toBe(200);

    const afterArchive = (await (await getJson("/api/v2/plans")).json()) as PlansListResponse;
    expect(afterArchive.plans.map((p) => p.cr)).toEqual(["CR-GLOBAL-KEEP"]);
    expect(afterArchive.plans.some((p) => p.cr === "CR-GLOBAL-ARCHIVE-ME")).toBe(false);

    const unarchiveRes = await postJson(`/api/v2/projects/${keyArchive}/unarchive`, {});
    expect(unarchiveRes.status).toBe(200);

    const afterUnarchive = (await (await getJson("/api/v2/plans")).json()) as PlansListResponse;
    expect(afterUnarchive.plans.map((p) => p.cr).sort()).toEqual([
      "CR-GLOBAL-ARCHIVE-ME",
      "CR-GLOBAL-KEEP",
    ]);
  });

  // ── ?fmt=toon parity ──────────────────────────────────────────────────────

  test("?fmt=toon renders the TOON form with the SAME negotiation contract as sibling v2 GET routes (text/toon; charset=utf-8, first line 'ok: true')", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("global-plans-toon");
    await filePlan(key, "CR-GLOBAL-TOON-1");

    const toonRes = await getJson("/api/v2/plans?fmt=toon");
    expect(toonRes.status).toBe(200);
    expect(toonRes.headers.get("content-type")).toBe("text/toon; charset=utf-8");
    const toonBody = await toonRes.text();
    expect(toonBody.split("\n")[0]).toBe("ok: true");
    expect(toonBody).toContain("CR-GLOBAL-TOON-1");

    const jsonRes = await getJson("/api/v2/plans");
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type") ?? "").toContain("application/json");
    const jsonBody = (await jsonRes.json()) as PlansListResponse;
    expect(jsonBody.ok).toBe(true);
  });

  // ── method refusal — established sibling-route convention ────────────────

  test("POST /api/v2/plans is refused via the SAME convention every unmatched v2 route uses (404 {ok:false, error:\"unknown route: POST /api/v2/plans\"}) — GET-only", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });

    const res = await postJson("/api/v2/plans", { cr: "CR-SHOULD-NEVER-FILE" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unknown route: POST /api/v2/plans");
  });
});
