// CR-CRU-164 §S1 — a release's verification runs are filed under the
// release: declared-release refusal, cycle-or-release refusal, and native
// stamping of `release` onto a run's event AND its open run row.
// docs/changes/CR-CRU-164-a-releases-verification-runs-are-filed-under-it.md
//
// SERVER ONLY (cycle 600, C1): POST /api/v2/runs/start, POST /api/v2/runs,
// POST /api/v2/runs/parsed, POST /api/v2/runs/compile and
// POST /api/v2/runs/<id>/abort. The five CLIENTS' own `--release` flag (C2)
// and the roadmap-band chip (C3) are NOT this suite's concern.
//
// RED. Measured on this build: none of the five routes reads `release` off
// the request body at all (`runMeta` / `resolveIngestAttach` in src/v2.ts
// have no notion of it — an unknown JSON field is simply dropped by
// `readBody`'s pass-through cast), and neither `events` nor `runs` carries
// the column (see the schema block appended to tests/store-migration.test.ts
// for the migration proof). Every assertion below fails for exactly that
// reason — a release silently ignored or a column that does not exist —
// never a typo.
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "crucible-cr164-"));
}

// 1-case junit, passing — the stamping tests only care that an event lands.
const JUNIT_1CASE = [
  '<testsuite name="Suite1" tests="1">',
  '<testcase name="t1" time="0.005"/>',
  "</testsuite>",
].join("\n");

// rustc fixture per the codebase's own precedent (tests/run-lifecycle.test.ts).
const RUSTC_ERRORS = ["error[E0308]: mismatched types", " --> src/lib.rs:1:1", ""].join("\n");

function parsedBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
    tree: [
      { name: "s", status: "pass", children: [{ name: "t", status: "pass", duration_ms: 5 }] },
    ],
    ...overrides,
  };
}

describe("CR-CRU-164 §S1 — release rides run start and every ingest route (server)", () => {
  let handle: ServerHandle | undefined;
  let dbPath = "";
  let dirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  /** A REAL server on a REAL store FILE — `:memory:` has no file a second
   *  connection can read the raw `release` column back out of. */
  function boot(): void {
    const dir = freshDir();
    dirs.push(dir);
    dbPath = join(dir, "crucible.db");
    handle = startServer({ port: 0, dbPath });
  }

  async function send(method: string, path_: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${handle!.server.port}${path_}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createProject(): Promise<string> {
    const res = await send("POST", "/api/v2/projects", { name: `cr164-${crypto.randomUUID()}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  /** `register --agent <id> --role ORCHESTRATOR [--cycle <n>]`, the real route. */
  async function register(
    key: string,
    agentId: string,
    opts: { cycleId?: number } = {},
  ): Promise<void> {
    const res = await send("POST", "/api/v2/agents/register", {
      projectKey: key,
      agentId,
      role: "ORCHESTRATOR",
      ...(opts.cycleId !== undefined ? { cycleId: opts.cycleId } : {}),
    });
    expect(res.status).toBe(200);
  }

  /** Files a one-cycle plan and ACTIVATES it — a real, bindable cycle id. */
  async function activeCycle(key: string): Promise<number> {
    await register(key, "fixture-orch-cycle");
    const filed = await send("POST", `/api/v2/projects/${key}/plans`, {
      agentId: "fixture-orch-cycle",
      cr: `CR-CR164-${crypto.randomUUID().slice(0, 8)}`,
      cycles: [{ label: "solo" }],
    });
    expect(filed.status).toBe(201);
    const plan = (await filed.json()) as { planId: number; cycles: Array<{ id: number }> };
    const cycleId = plan.cycles[0]!.id;
    const activated = await send(
      "PATCH",
      `/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`,
      { agentId: "fixture-orch-cycle", status: "active" },
    );
    expect(activated.status).toBe(200);
    return cycleId;
  }

  // ── declaring a release, each source in isolation — store-level fixture
  // setup, bypassing the route-level membership gates on PURPOSE: §S1's
  // declared-release check for a RUN must hold independently of whichever
  // route originally wrote the queue/proposal/record row. ───────────────────

  function declareViaQueuedCr(key: string, release: string): void {
    handle!.store.upsertQueueEntry(
      key,
      { cr: `CR-FX-${release}`, release, wave: "1", title: "Fixture CR" },
      "fixture-setup",
    );
  }

  function declareViaLiveProposal(key: string, release: string): void {
    handle!.store.recordReleaseProposal(key, "fixture-setup", {
      label: release,
      targetAt: Math.floor(Date.now() / 1000) + 86_400,
    });
  }

  function declareViaRecordedRelease(key: string, release: string): void {
    handle!.store.recordMilestoneEvent(key, "fixture-setup", "release", {
      label: release,
      deliveredAt: Math.floor(Date.now() / 1000),
    });
  }

  // ── raw-store observables — a second connection onto the SAME file, the
  // tests/v2-runs-events.test.ts CR-CRU-094 §S1/AC1 block's own approach ────

  function countTable(table: string): number {
    const db = new Database(dbPath);
    try {
      return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
    } finally {
      db.close();
    }
  }

  function storeCounts(): { events: number; runs: number } {
    return { events: countTable("events"), runs: countTable("runs") };
  }

  function storedEventRelease(id: string): unknown {
    const db = new Database(dbPath);
    try {
      return db
        .query<{ release: unknown }, [string]>(`SELECT release FROM events WHERE id = ?`)
        .get(id)?.release;
    } finally {
      db.close();
    }
  }

  function storedRunRelease(runId: string): unknown {
    const db = new Database(dbPath);
    try {
      return db
        .query<{ release: unknown }, [string]>(`SELECT release FROM runs WHERE run_id = ?`)
        .get(runId)?.release;
    } finally {
      db.close();
    }
  }

  function abortedEventRelease(key: string): unknown {
    const db = new Database(dbPath);
    try {
      return db
        .query<{ release: unknown }, [string]>(
          `SELECT release FROM events WHERE project_key = ? AND status = 'aborted'`,
        )
        .get(key)?.release;
    } finally {
      db.close();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Stamping — the open run row AND the closing event carry `release`
  // ═══════════════════════════════════════════════════════════════════════

  describe("Stamping — release lands on the run row and on the stored event", () => {
    test("a run started with `release` under a declared label, unbound and cycle-less, opens a run row carrying that release", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-start");
      declareViaLiveProposal(key, "4.1.0");

      const res = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-start",
        release: "4.1.0",
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as OkResponse & { runId: string };
      expect(storedRunRelease(body.runId)).toBe("4.1.0");
    });

    test("a run started AND closed by a matching ingest files `release` on BOTH the run row and the closing event", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-lifecycle");
      declareViaLiveProposal(key, "4.2.0");

      const started = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-lifecycle",
        release: "4.2.0",
      });
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };

      const closed = await send("POST", "/api/v2/runs/parsed", {
        projectKey: key,
        agentId: "orch-lifecycle",
        runId,
        release: "4.2.0",
        ...parsedBody(),
      });
      expect(closed.status).toBe(200);
      const closedBody = (await closed.json()) as OkResponse & { event: string };

      expect(storedRunRelease(runId)).toBe("4.2.0");
      expect(storedEventRelease(closedBody.event)).toBe("4.2.0");
    });

    test("a single-shot raw-junit ingest (no runId) carries `release` straight onto its event", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-junit");
      declareViaRecordedRelease(key, "4.3.0");

      const res = await send("POST", "/api/v2/runs", {
        projectKey: key,
        agentId: "orch-junit",
        codec: "junit",
        data: JUNIT_1CASE,
        release: "4.3.0",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse & { event: string };
      expect(storedEventRelease(body.event)).toBe("4.3.0");
    });

    test("a single-shot parsed ingest (no runId) carries `release` straight onto its event", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-parsed");
      declareViaRecordedRelease(key, "4.4.0");

      const res = await send("POST", "/api/v2/runs/parsed", {
        projectKey: key,
        agentId: "orch-parsed",
        release: "4.4.0",
        ...parsedBody(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse & { event: string };
      expect(storedEventRelease(body.event)).toBe("4.4.0");
    });

    test("a single-shot compile ingest (no runId) carries `release` straight onto its event", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-compile");
      declareViaQueuedCr(key, "4.5.0");

      const res = await send("POST", "/api/v2/runs/compile", {
        projectKey: key,
        agentId: "orch-compile",
        errors: RUSTC_ERRORS,
        format: "rustc",
        release: "4.5.0",
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse & { event: string };
      expect(storedEventRelease(body.event)).toBe("4.5.0");
    });

    test("a run started with `release` and then ABORTED (POST /api/v2/runs/<id>/abort) keeps that release on its abort event", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-abort");
      declareViaLiveProposal(key, "4.6.0");

      const started = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-abort",
        release: "4.6.0",
      });
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };

      const aborted = await send("POST", `/api/v2/runs/${runId}/abort`, {
        projectKey: key,
        agentId: "orch-abort",
        reason: "testing abort keeps release",
      });

      expect(aborted.status).toBe(200);
      expect(storedRunRelease(runId)).toBe("4.6.0");
      expect(abortedEventRelease(key)).toBe("4.6.0");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Declared — a release must be known to the roadmap before a run may file
  // under it: a CR planned into it, a live proposal, or a recorded release —
  // each sufficient ALONE.
  // ═══════════════════════════════════════════════════════════════════════

  describe("Declared — a release label must be known to the roadmap before a run may file under it", () => {
    test("a label declared ONLY via a queue entry's own `release` suffices — run start is accepted", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-q");
      declareViaQueuedCr(key, "5.1.0");

      const res = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-q",
        release: "5.1.0",
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as OkResponse & { runId: string };
      expect(storedRunRelease(body.runId)).toBe("5.1.0");
    });

    test("a label declared ONLY via a live release proposal suffices — run start is accepted", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-p");
      declareViaLiveProposal(key, "5.2.0");

      const res = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-p",
        release: "5.2.0",
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as OkResponse & { runId: string };
      expect(storedRunRelease(body.runId)).toBe("5.2.0");
    });

    test("a label declared ONLY via a recorded (shipped) release suffices — run start is accepted", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-r");
      declareViaRecordedRelease(key, "5.3.0");

      const res = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-r",
        release: "5.3.0",
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as OkResponse & { runId: string };
      expect(storedRunRelease(body.runId)).toBe("5.3.0");
    });

    test("an undeclared release on run start is refused (400), naming every label the project HAS declared, and stores nothing", async () => {
      boot();
      const key = await createProject();
      await register(key, "orch-undeclared");
      declareViaQueuedCr(key, "5.4.1");
      declareViaLiveProposal(key, "5.4.2");
      declareViaRecordedRelease(key, "5.4.3");
      const before = storeCounts();

      const res = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-undeclared",
        release: "5.4.9-undeclared",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      // All THREE sources feed the same declared-label set — proven by
      // naming one label from EACH source in a single refusal.
      expect(body.error).toContain("5.4.1");
      expect(body.error).toContain("5.4.2");
      expect(body.error).toContain("5.4.3");
      expect(storeCounts()).toEqual(before);
    });

    const INGEST_ROUTES: Array<{ label: string; path: string; body: Record<string, unknown> }> = [
      { label: "raw-junit", path: "/api/v2/runs", body: { codec: "junit", data: JUNIT_1CASE } },
      { label: "parsed", path: "/api/v2/runs/parsed", body: parsedBody() },
      {
        label: "compile",
        path: "/api/v2/runs/compile",
        body: { errors: RUSTC_ERRORS, format: "rustc" },
      },
    ];

    for (const route of INGEST_ROUTES) {
      test(`an undeclared release on the ${route.label} ingest route (${route.path}) is refused (400) and stores nothing`, async () => {
        boot();
        const key = await createProject();
        const agentId = `orch-${route.label}`;
        await register(key, agentId);
        declareViaLiveProposal(key, "5.5.1");
        const before = storeCounts();

        const res = await send("POST", route.path, {
          projectKey: key,
          agentId,
          release: "5.5.9-undeclared",
          ...route.body,
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as ErrResponse;
        expect(body.ok).toBe(false);
        expect(body.error).toContain("5.5.1");
        expect(storeCounts()).toEqual(before);
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Cycle OR release — a run never carries both: a cycle's runs are its CR's
  // evidence, a release's runs are its verification.
  // ═══════════════════════════════════════════════════════════════════════

  describe("Cycle OR release — a run never carries both", () => {
    test("an explicit context.cycleId alongside `release` is refused (400) on POST /api/v2/runs/start, nothing stored", async () => {
      boot();
      const key = await createProject();
      const cycleId = await activeCycle(key);
      await register(key, "orch-cyc-rel-start");
      declareViaLiveProposal(key, "6.1.0");
      const before = storeCounts();

      const res = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-cyc-rel-start",
        release: "6.1.0",
        context: { cycleId },
      });

      expect(res.status).toBe(400);
      expect(storeCounts()).toEqual(before);
    });

    test("an explicit context.cycleId alongside `release` is refused (400) on POST /api/v2/runs/compile — the route that normally skips context validation for an unbound caller entirely", async () => {
      boot();
      const key = await createProject();
      const cycleId = await activeCycle(key);
      await register(key, "orch-cyc-rel-compile");
      declareViaLiveProposal(key, "6.2.0");
      const before = storeCounts();

      const res = await send("POST", "/api/v2/runs/compile", {
        projectKey: key,
        agentId: "orch-cyc-rel-compile",
        errors: RUSTC_ERRORS,
        format: "rustc",
        release: "6.2.0",
        context: { cycleId },
      });

      expect(res.status).toBe(400);
      expect(storeCounts()).toEqual(before);
    });

    test("an agent BOUND to a cycle at registration is refused (400) declaring `release` on run start, nothing stored", async () => {
      boot();
      const key = await createProject();
      const cycleId = await activeCycle(key);
      await register(key, "orch-bound-start", { cycleId });
      declareViaLiveProposal(key, "6.3.0");
      const before = storeCounts();

      const res = await send("POST", "/api/v2/runs/start", {
        projectKey: key,
        agentId: "orch-bound-start",
        release: "6.3.0",
      });

      expect(res.status).toBe(400);
      expect(storeCounts()).toEqual(before);
    });

    test("an agent BOUND to a cycle at registration is refused (400) declaring `release` on a single-shot parsed ingest, nothing stored", async () => {
      boot();
      const key = await createProject();
      const cycleId = await activeCycle(key);
      await register(key, "orch-bound-parsed", { cycleId });
      declareViaLiveProposal(key, "6.4.0");
      const before = storeCounts();

      const res = await send("POST", "/api/v2/runs/parsed", {
        projectKey: key,
        agentId: "orch-bound-parsed",
        release: "6.4.0",
        ...parsedBody(),
      });

      expect(res.status).toBe(400);
      expect(storeCounts()).toEqual(before);
    });
  });
});
