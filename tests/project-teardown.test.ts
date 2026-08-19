// CR-CRU-052 §S1 — `DELETE /api/v2/projects/<key>` with a double-gated
// cascade. Drives the REAL production server (startServer) — the route does
// NOT exist yet in src/v2.ts (RED phase): every DELETE to
// /api/v2/projects/<key> currently falls through handleV2's dispatch table
// to server.ts's generic 404 JSON catch-all (`unknown route: DELETE ...`),
// so every test below fails on a genuine status/shape mismatch, never a
// compile error.
//
// Guard mirrored from handleEventDelete (src/v2.ts:1747-1772, CR-CRU-032):
//   1. the project must be ARCHIVED (archived_at IS NOT NULL) → else 403
//   2. body.userApproved !== true → else 409
// Both gates must leave the project and every cascaded row untouched.
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
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

// §S1 AC — "Return the deleted counts so a caller can assert the cascade
// rather than assume it." The CR does not pin exact field names; this is the
// RED agent's chosen shape (camelCase `planCycles` for the `plan_cycles`
// table, matching the wire convention elsewhere — e.g. plan filing returns
// `cycles`, never `plan_cycles`). GREEN must match this exactly or the tests
// below (which assert on `body.deleted.*`) stay red.
interface ProjectDeleteResponse extends OkResponse {
  changed: boolean;
  deleted: {
    events: number;
    agents: number;
    plans: number;
    planCycles: number;
    rollups: number;
  };
}

const JUNIT_ONE_CASE = [
  '<testsuite name="Suite" tests="1">',
  '<testcase name="t1" time="0.01"/>',
  "</testsuite>",
].join("\n");

interface TableCounts {
  project: number;
  events: number;
  agents: number;
  plans: number;
  planCycles: number;
  rollups: number;
}

describe("DELETE /api/v2/projects/<key> — cascade teardown (CR-CRU-052 §S1)", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function deleteJson(path: string, body?: Record<string, unknown>): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  async function registerOrchestrator(key: string, agentId: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role: "ORCHESTRATOR",
    });
    expect(res.status).toBe(200);
  }

  async function archiveProject(key: string): Promise<void> {
    const res = await postJson(`/api/v2/projects/${key}/archive`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResponse;
    expect(body.ok).toBe(true);
  }

  /** Raw per-table row counts for `key` — the store exposes no generic count
   * API, so this reaches the private `db` the same way the existing fleet of
   * tests does (e.g. tests/agent-role-rename.test.ts:628, event-role-backfill
   * .test.ts:107): `(store as unknown as { db: Database }).db`. */
  function countRows(key: string): TableCounts {
    const db = (handle!.store as unknown as { db: Database }).db;
    const one = (table: string): number =>
      db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_key = ?`)
        .get(key)!.n;
    return {
      project: db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM projects WHERE key = ?`)
        .get(key)!.n,
      events: one("events"),
      agents: one("agents"),
      plans: one("plans"),
      planCycles: one("plan_cycles"),
      rollups: one("rollups"),
    };
  }

  /**
   * Seeds a project with a REAL row in every cascade-target table:
   *  - agents: registerOrchestrator (a live agents row for this project).
   *  - plans + plan_cycles: POST .../plans files one plan with one cycle —
   *    one insert into each table (mirrors agent-role-rename.test.ts's
   *    fileAndActivate fixture).
   *  - events + rollups: retention is PATCHed to 1, then two junit runs are
   *    posted. The second ingest's retention enforcement (store.ts:1334
   *    enforceRetention, called synchronously from insertEvent) genuinely
   *    folds the FIRST event into a rollups row and deletes it — a real
   *    production code path, not a fabricated row — leaving exactly one live
   *    event (the second) and one rollups row.
   * Returns the key with every table non-empty, so the cascade assertions
   * below are never vacuous.
   */
  async function seedFullCascadeProject(name: string, agentId: string): Promise<string> {
    const key = await createProject(name);
    await registerOrchestrator(key, agentId);

    const retentionRes = await patchJson(`/api/v2/projects/${key}`, { retention: 1 });
    expect(retentionRes.status).toBe(200);

    for (let i = 0; i < 2; i++) {
      const runRes = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId,
        codec: "junit",
        data: JUNIT_ONE_CASE,
      });
      expect(runRes.status).toBe(200);
    }

    const planRes = await postJson(`/api/v2/projects/${key}/plans`, {
      cr: `CR-CRU-052-cascade-fixture-${name}`,
      cycles: [{ label: "solo" }],
      agentId,
    });
    expect(planRes.status).toBe(201);

    return key;
  }

  function expectFullCascadeSeed(counts: TableCounts): void {
    expect(counts.project).toBe(1);
    expect(counts.events).toBe(1);
    expect(counts.agents).toBe(1);
    expect(counts.plans).toBe(1);
    expect(counts.planCycles).toBe(1);
    expect(counts.rollups).toBe(1);
  }

  test("cascade completeness — deletes the project row AND every row in events/agents/plans/plan_cycles/rollups, and the response pins the exact deleted counts", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await seedFullCascadeProject("cascade-complete", "cascade-agent");
    await archiveProject(key);

    const before = countRows(key);
    expectFullCascadeSeed(before);

    const res = await deleteJson(`/api/v2/projects/${key}`, { userApproved: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectDeleteResponse;
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.deleted).toEqual({
      events: before.events,
      agents: before.agents,
      plans: before.plans,
      planCycles: before.planCycles,
      rollups: before.rollups,
    });

    const after = countRows(key);
    expect(after).toEqual({ project: 0, events: 0, agents: 0, plans: 0, planCycles: 0, rollups: 0 });
  });

  test("happy path — archived project + userApproved:true succeeds even with zero dependent rows (empty-cascade case)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProject("cascade-empty");
    await archiveProject(key);

    const res = await deleteJson(`/api/v2/projects/${key}`, { userApproved: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectDeleteResponse;
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.deleted).toEqual({ events: 0, agents: 0, plans: 0, planCycles: 0, rollups: 0 });
    expect(countRows(key).project).toBe(0);
  });

  test("Gate 1 — deleting a NON-archived project is refused with 403, and the project plus every dependent row survives", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await seedFullCascadeProject("cascade-gate1", "gate1-agent");
    // Deliberately NOT archived.
    const before = countRows(key);
    expectFullCascadeSeed(before);

    const res = await deleteJson(`/api/v2/projects/${key}`, { userApproved: true });

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);

    expect(countRows(key)).toEqual(before);
  });

  test("Gate 2 — deleting an archived project WITHOUT userApproved:true is refused with 409, and the project plus every dependent row survives", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await seedFullCascadeProject("cascade-gate2", "gate2-agent");
    await archiveProject(key);
    const before = countRows(key);
    expectFullCascadeSeed(before);

    // No userApproved at all.
    const res = await deleteJson(`/api/v2/projects/${key}`, {});

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);

    expect(countRows(key)).toEqual(before);
  });

  // Status choice for a missing key: 404, matching BOTH established
  // precedents — handleProjectArchive's existence check (`unknown project:
  // ${key}` → 404, src/v2.ts:1457-1458) and handleEventDelete's 404-on-miss
  // idiom (src/v2.ts:1767-1769). Existence must be checked BEFORE the
  // archived-gate/approval-gate ordering (mirroring handleProjectArchive,
  // which also can't route an archived-only lookup through requireProject —
  // requireProject 404s archived projects, which would make the guarded
  // delete unreachable), so a nonexistent key can never reach 403/409; it is
  // a definitive 404, never a silent success.
  test("nonexistent key → 404 {ok:false}, never a silent success", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const missingKey = crypto.randomUUID();

    const res = await deleteJson(`/api/v2/projects/${missingKey}`, { userApproved: true });

    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrResponse;
    expect(body.ok).toBe(false);
    // Specific message, not just "some 404" — the generic catch-all 404s
    // EVERY unrouted request with "unknown route: ...", so a bare status
    // check would pass vacuously before the route even exists. This mirrors
    // handleProjectArchive's exact existence-check wording (src/v2.ts:1458).
    expect(body.error).toContain("unknown project");
  });

  // Atomicity — honest scope: this forces a REAL thrown exception from a
  // real SQL call on the real store (not a mocked route, not a trivial
  // assertion), by intercepting the underlying bun:sqlite `Database.query`
  // the same way the existing fleet reaches the private `db` field. The
  // FIRST cascade DELETE against one of the five dependent tables is let
  // through for real (so a real partial mutation happens inside whatever
  // transaction GREEN opens); the SECOND such DELETE is made to throw. If
  // the cascade is wrapped in one `db.transaction`, bun:sqlite rolls the
  // whole callback back on that throw, so EVERY row — including the one the
  // first, allowed-through DELETE actually removed — must still be present
  // afterward.
  //
  // Honest limit: this assumes GREEN issues one parameterized
  // `DELETE FROM <table> WHERE project_key = ?` per dependent table — the
  // established style for every other cascade-shaped operation in store.ts
  // (clearEvents, deleteEvent, enforceRetention's fold+delete). It does NOT
  // prove atomicity for an implementation that deletes via a single joined
  // statement touching all five tables at once (a shape nothing in this
  // codebase currently uses) — that residual gap is not testable from here
  // without dictating GREEN's SQL, so it is named rather than silently
  // assumed away.
  test("atomicity — a thrown mid-cascade failure leaves NOTHING partially removed (real forced failure, real transaction rollback)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await seedFullCascadeProject("cascade-atomic", "atomic-agent");
    await archiveProject(key);
    const before = countRows(key);
    expectFullCascadeSeed(before);

    const rawDb = (handle.store as unknown as { db: Database }).db;
    const originalQuery = rawDb.query.bind(rawDb) as (
      sql: string,
      ...rest: unknown[]
    ) => ReturnType<Database["query"]>;
    const DEPENDENT_DELETE_RE = /^\s*DELETE\s+FROM\s+(events|agents|plans|plan_cycles|rollups)\b/i;
    let dependentDeleteHits = 0;
    const querySpy = spyOn(rawDb, "query").mockImplementation(
      ((sql: string, ...rest: unknown[]) => {
        if (typeof sql === "string" && DEPENDENT_DELETE_RE.test(sql)) {
          dependentDeleteHits++;
          if (dependentDeleteHits === 2) {
            const boom = (): never => {
              throw new Error("CR-CRU-052 RED — simulated mid-cascade failure");
            };
            return { run: boom, get: boom, all: boom } as unknown as ReturnType<Database["query"]>;
          }
        }
        return originalQuery(sql, ...rest);
      }) as typeof rawDb.query,
    );

    let res: Response;
    try {
      res = await deleteJson(`/api/v2/projects/${key}`, { userApproved: true });
    } finally {
      querySpy.mockRestore();
    }

    // The forced-failure mechanism must have actually engaged — otherwise a
    // request that never reaches the cascade at all (e.g. a 404 from a
    // not-yet-existing route) would pass this test VACUOUSLY, having proven
    // nothing about atomicity. This is what makes the test fail for the
    // right reason pre-GREEN and a real reason post-GREEN.
    expect(dependentDeleteHits).toBeGreaterThanOrEqual(2);

    // Bound assertion: the delete must NOT have reported success.
    expect(res.status).not.toBe(200);

    const after = countRows(key);
    expect(after).toEqual(before);
  });

  test("isolation — deleting project A leaves project B's rows (events/agents/plans/plan_cycles/rollups) completely intact", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const keyA = await seedFullCascadeProject("cascade-isolation-a", "isolation-agent-a");
    const keyB = await seedFullCascadeProject("cascade-isolation-b", "isolation-agent-b");
    await archiveProject(keyA);

    const beforeB = countRows(keyB);
    expectFullCascadeSeed(beforeB);

    const res = await deleteJson(`/api/v2/projects/${keyA}`, { userApproved: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectDeleteResponse;
    expect(body.ok).toBe(true);

    expect(countRows(keyA)).toEqual({
      project: 0,
      events: 0,
      agents: 0,
      plans: 0,
      planCycles: 0,
      rollups: 0,
    });
    // Project B — untouched, exact same counts as before A's delete (this is
    // the assertion that would catch a cascade keyed off the wrong column,
    // e.g. deleting by rowid or omitting a `WHERE project_key = ?` clause).
    expect(countRows(keyB)).toEqual(beforeB);
  });
});
