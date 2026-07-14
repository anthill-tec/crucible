// CR-CRU-003 §S1/§S2 — shim ingest/events routes:
// POST /api/ingest/parsed, POST /api/ingest/clear, GET /api/ingest/status,
// GET /api/events, POST /api/events/delete, POST /api/events/clear.
// All extend the REAL production server (startServer) — not a hand-wired store.
// DN §3.5, §3.7, §3.8 — byte contract.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { Coverage, RunSummary } from "../src/types.ts";

interface OkParsedResponse {
  ok: true;
  summary: RunSummary;
}

interface OkClearResponse {
  ok: true;
  cleared: number;
}

interface OkStatusResponse {
  ok: true;
  status: {
    hasData: boolean;
    lastTest: { id: string } | null;
    lastCompile: { id: string } | null;
  };
}

interface OkEventsResponse {
  ok: true;
  events: Array<{ id: string; projectKey: string }>;
}

interface ErrResponse {
  ok: false;
  error: string;
}

const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");

describe("shim ingest/events routes — §S1/§S2", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function seedProject(): string {
    const key = crypto.randomUUID();
    handle!.store.addProject({ key, name: "p", type: "backend", sutRoot: "/tmp" });
    return key;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  function parsedBody(overrides?: {
    summary?: Partial<RunSummary>;
    coverage?: Coverage;
    name?: string;
    agentId?: string;
    projectKey?: string;
  }) {
    return {
      projectKey: overrides?.projectKey,
      agentId: overrides?.agentId ?? "a1",
      summary: {
        total: 5,
        passed: 5,
        failed: 0,
        pending: 0,
        duration_ms: 100,
        ...overrides?.summary,
      },
      tree: [
        {
          name: "s",
          status: "pass",
          children: [
            { name: "t1", status: "pass", duration_ms: 50 },
            { name: "t2", status: "pass", duration_ms: 50 },
          ],
        },
      ],
      ...(overrides?.coverage !== undefined ? { coverage: overrides.coverage } : {}),
      ...(overrides?.name !== undefined ? { name: overrides.name } : {}),
    };
  }

  // ── §3.5 POST /api/ingest/parsed ──────────────────────────────────────
  describe("POST /api/ingest/parsed", () => {
    test("summary+tree+coverage (failed:0) → 200 {ok:true, summary}; stored event kind=test codec=parsed with coverage present", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      const coverage: Coverage = { lines: { total: 10, covered: 9, percent: 90 } };

      const res = await postJson(
        "/api/ingest/parsed",
        parsedBody({ projectKey: pk, coverage }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkParsedResponse;
      expect(body.ok).toBe(true);
      expect(body.summary).toEqual({
        total: 5,
        passed: 5,
        failed: 0,
        pending: 0,
        duration_ms: 100,
      });

      const newest = handle.store.listEvents(pk)[0];
      expect(newest).toBeDefined();
      expect(newest!.kind).toBe("test");
      expect(newest!.codec).toBe("parsed");
      expect(newest!.coverage).toEqual(coverage);
    });

    test("summary.failed:2 with coverage present → coverage DISCARDED on the stored event", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      const coverage: Coverage = { lines: { total: 10, covered: 9, percent: 90 } };

      const res = await postJson(
        "/api/ingest/parsed",
        parsedBody({
          projectKey: pk,
          summary: { total: 5, passed: 3, failed: 2, pending: 0, duration_ms: 100 },
          coverage,
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkParsedResponse;
      expect(body.ok).toBe(true);

      const newest = handle.store.listEvents(pk)[0];
      expect(newest).toBeDefined();
      expect(newest!.coverage === null || newest!.coverage === undefined).toBe(true);
    });

    test("optional name field is stored verbatim on the event", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await postJson(
        "/api/ingest/parsed",
        parsedBody({ projectKey: pk, name: "smoke-run" }),
      );

      expect(res.status).toBe(200);
      const newest = handle.store.listEvents(pk)[0];
      expect(newest?.name).toBe("smoke-run");
    });
  });

  // ── §3.7 POST /api/ingest/clear ───────────────────────────────────────
  describe("POST /api/ingest/clear", () => {
    test("clears only the target project's events; returns count; other projects untouched", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk1 = seedProject();
      const pk2 = seedProject();

      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk1 }));
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk1 }));
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk2 }));

      const res = await postJson("/api/ingest/clear", { projectKey: pk1 });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkClearResponse;
      expect(body.ok).toBe(true);
      expect(body.cleared).toBe(2);

      expect(handle.store.listEvents(pk1).length).toBe(0);
      expect(handle.store.listEvents(pk2).length).toBe(1);
    });

    test("non-UUID projectKey → 400 {ok:false, error}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/ingest/clear", { projectKey: "not-a-uuid" });

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
    });
  });

  // ── §3.7 GET /api/ingest/status ───────────────────────────────────────
  describe("GET /api/ingest/status", () => {
    test("fresh project → hasData:false, lastTest:null, lastCompile:null", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      const res = await getJson(`/api/ingest/status?projectKey=${pk}`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkStatusResponse;
      expect(body.ok).toBe(true);
      expect(body.status.hasData).toBe(false);
      expect(body.status.lastTest).toBeNull();
      expect(body.status.lastCompile).toBeNull();
    });

    test("after a test ingest, lastTest is non-null and carries that event's id; hasData flips true", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      const recorded = handle.store.listEvents(pk)[0];
      expect(recorded).toBeDefined();

      const res = await getJson(`/api/ingest/status?projectKey=${pk}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkStatusResponse;
      expect(body.ok).toBe(true);
      expect(body.status.hasData).toBe(true);
      expect(body.status.lastTest).not.toBeNull();
      expect(body.status.lastTest?.id).toBe(recorded!.id);
    });

    test("after a compile ingest, lastCompile is non-null and carries that event's id", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      await postJson("/api/ingest/compile", {
        projectKey: pk,
        agentId: "a1",
        errors: RUSTC_ERRORS,
        format: "rustc",
      });
      const recorded = handle.store.listEvents(pk)[0];
      expect(recorded).toBeDefined();
      expect(recorded!.kind).toBe("compile");

      const res = await getJson(`/api/ingest/status?projectKey=${pk}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkStatusResponse;
      expect(body.ok).toBe(true);
      expect(body.status.lastCompile).not.toBeNull();
      expect(body.status.lastCompile?.id).toBe(recorded!.id);
    });

    test("missing projectKey query param → 400 {ok:false, error}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/ingest/status");

      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
    });
  });

  // ── §3.8 GET /api/events ──────────────────────────────────────────────
  describe("GET /api/events", () => {
    test("newest-first ordering with default limit 50 (3 inserted, no limit → all 3, newest first)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      Bun.sleepSync(2);
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      Bun.sleepSync(2);
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));

      const expected = handle.store.listEvents(pk, 1000).map((e) => e.id);
      expect(expected.length).toBe(3);

      const res = await getJson(`/api/events?projectKey=${pk}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkEventsResponse;
      expect(body.ok).toBe(true);
      expect(body.events.map((e) => e.id)).toEqual(expected);
    });

    test("limit=2 with 3 inserted → returns exactly the 2 newest", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();

      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      Bun.sleepSync(2);
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      Bun.sleepSync(2);
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));

      const newest2 = handle.store.listEvents(pk, 2).map((e) => e.id);

      const res = await getJson(`/api/events?projectKey=${pk}&limit=2`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkEventsResponse;
      expect(body.ok).toBe(true);
      expect(body.events.length).toBe(2);
      expect(body.events.map((e) => e.id)).toEqual(newest2);
    });

    test("no projectKey → spans all projects", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk1 = seedProject();
      const pk2 = seedProject();

      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk1 }));
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk2 }));

      const res = await getJson("/api/events");
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkEventsResponse;
      expect(body.ok).toBe(true);
      const keys = body.events.map((e) => e.projectKey);
      expect(keys).toContain(pk1);
      expect(keys).toContain(pk2);
    });
  });

  // ── §3.8 POST /api/events/delete ──────────────────────────────────────
  describe("POST /api/events/delete", () => {
    test("correct projectKey → {ok:true}; event is gone", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      const eventId = handle.store.listEvents(pk)[0]!.id;

      const res = await postJson("/api/events/delete", { eventId, projectKey: pk });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: true };
      expect(body.ok).toBe(true);
      expect(handle.store.getEvent(eventId)).toBeNull();
    });

    test("wrong projectKey → {ok:false}; event still present", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      const otherPk = seedProject();
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      const eventId = handle.store.listEvents(pk)[0]!.id;

      const res = await postJson("/api/events/delete", { eventId, projectKey: otherPk });

      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
      expect(handle.store.getEvent(eventId)).not.toBeNull();
    });
  });

  // ── §3.8 POST /api/events/clear ───────────────────────────────────────
  describe("POST /api/events/clear", () => {
    test("clears all events for the project and returns the count", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const pk = seedProject();
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));
      await postJson("/api/ingest/parsed", parsedBody({ projectKey: pk }));

      const res = await postJson("/api/events/clear", { projectKey: pk });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkClearResponse;
      expect(body.ok).toBe(true);
      expect(body.cleared).toBe(3);
      expect(handle.store.listEvents(pk).length).toBe(0);
    });
  });
});
