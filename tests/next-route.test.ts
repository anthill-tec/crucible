// CR-CRU-098 C1 RED — `GET /api/v2/projects/<key>/next` publishes the WHOLE
// pointer answer, help[] included (§S2).
//
// Spec: docs/changes/CR-CRU-098-the-plan-pointer-has-no-publisher.md §S2, AC2/AC3/AC4/AC6/AC7
// Classification: docs/changes/CR-CRU-098-test-classification.md
//
// Complements tests/next-resolver.test.ts (the PURE function, unit tier): this
// file is the WIRING — the route reads `store.listQueue`/`declaredTracks` (the
// same helpers `handleQueueGet` already uses, src/v2.ts:2091-2100) and the
// project's declared tracks, calls the pure resolver, and publishes its answer
// verbatim, `help[]`/`warnings[]` included, matching AC7's "validated like
// every other v2 route" — modelled on `handleQueueGet`'s own UUID/unknown-project
// refusal shape (src/v2.ts:2092-2096), never invented independently.
//
// RED expectation: no `next` route is registered, so every request below hits
// the router's fallback and every assertion on the (future) NEXT/DRAINED/
// refusal SHAPE fails — the missing route, not a broken harness.
//
// AC13 — every fixture is synthetic (`CR-NEXTPTR-*`, registered in
// tests/project-namespace-tripwire.test.ts's SYNTHETIC_NAMESPACES).
import { describe, test, expect, afterEach } from "bun:test";
import { startServer, type ServerHandle } from "../src/server.ts";
import { SCHEMA_VERSION } from "../src/store.ts";

interface AnyBody {
  ok: boolean;
  error?: string;
  decision?: string;
  cr?: string;
  seq?: number;
  release?: string;
  wave?: string;
  track?: string;
  reason?: string;
  trigger?: Record<string, unknown>;
  needs?: string[];
  tracks?: string[];
  totalCount?: number;
  help?: string[];
  warnings?: Array<{ code: string; detail?: string }>;
  [key: string]: unknown;
}

describe("CR-CRU-098 §S2 — GET /api/v2/projects/<key>/next", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function boot(): ServerHandle {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    return handle;
  }

  async function send(method: string, path: string): Promise<{ status: number; body: AnyBody }> {
    const res = await fetch(`http://localhost:${handle!.server.port}${path}`, { method });
    return { status: res.status, body: (await res.json()) as AnyBody };
  }

  async function get(path: string): Promise<{ status: number; body: AnyBody }> {
    return send("GET", path);
  }

  async function seed(name: string): Promise<string> {
    const created = await fetch(`http://localhost:${handle!.server.port}/api/v2/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = (await created.json()) as { project: { key: string } };
    return body.project.key;
  }

  function seedRows(key: string, rows: Array<Record<string, unknown>>): void {
    handle!.store.replaceQueue(
      key,
      rows.map((row) => ({
        cr: String(row.cr),
        wave: String(row.wave),
        dependsOn: Array.isArray(row.dependsOn) ? row.dependsOn.map(String) : [],
        ...(typeof row.seq === "number" ? { seq: row.seq } : {}),
        ...(typeof row.release === "string" ? { release: row.release } : {}),
        ...(typeof row.track === "string" ? { track: row.track } : {}),
      })),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AC7 — an unknown or malformed project key is refused like every other
  // v2 route (handleQueueGet's own shape: 400 non-UUID, 404 unknown UUID)
  // ═══════════════════════════════════════════════════════════════════════

  test("AC7 — a non-UUID project key is refused 400 'projectKey must be a UUID'", async () => {
    boot();
    const { status, body } = await get("/api/v2/projects/not-a-uuid/next");
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("projectKey must be a UUID");
    expect(Array.isArray(body.help)).toBe(true);
  });

  test("AC7 — a well-formed but unregistered UUID project key is refused 404 'unknown project: <key>'", async () => {
    boot();
    const fakeKey = "00000000-0000-4000-8000-000000000000";
    const { status, body } = await get(`/api/v2/projects/${fakeKey}/next`);
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error).toBe(`unknown project: ${fakeKey}`);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC4 — the route publishes the whole answer, per decision
  // ═══════════════════════════════════════════════════════════════════════

  test("AC4 — NEXT publishes decision, cr, seq, wave, help[] and an empty warnings[]", async () => {
    boot();
    const key = await seed("cru098-next-route-next");
    seedRows(key, [
      { cr: "CR-NEXTPTR-100", wave: "5", seq: 10 },
      { cr: "CR-NEXTPTR-101", wave: "5", seq: 20 },
    ]);

    const { status, body } = await get(`/api/v2/projects/${key}/next`);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.decision).toBe("NEXT");
    expect(body.cr).toBe("CR-NEXTPTR-100");
    expect(body.seq).toBe(10);
    expect(body.wave).toBe("5");
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.help as string[]).length).toBeGreaterThan(0);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toEqual([]);
  });

  test("AC4 — DRAINED (no-roadmap) on an empty queue publishes decision/reason/help[], never a cr key", async () => {
    boot();
    const key = await seed("cru098-next-route-drained");

    const { status, body } = await get(`/api/v2/projects/${key}/next`);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.decision).toBe("DRAINED");
    expect(body.reason).toBe("no-roadmap");
    expect(body).not.toHaveProperty("cr");
    expect(Array.isArray(body.help)).toBe(true);
  });

  test("AC4/AC5 — HOLD publishes a structured trigger and a help[] deriving the unblocking move", async () => {
    boot();
    const key = await seed("cru098-next-route-hold");
    seedRows(key, [
      { cr: "CR-NEXTPTR-GHOST-DEP", wave: "5", seq: 10, dependsOn: ["CR-NEXTPTR-GHOST"] },
    ]);

    const { status, body } = await get(`/api/v2/projects/${key}/next`);

    expect(status).toBe(200);
    expect(body.decision).toBe("HOLD");
    expect(body.cr).toBe("CR-NEXTPTR-GHOST-DEP");
    expect(body.trigger).toEqual({ kind: "unknown-dependency", cr: "CR-NEXTPTR-GHOST" });
    expect(Array.isArray(body.help)).toBe(true);
    expect((body.warnings ?? []).map((w) => w.code)).toContain("unknown-dependency");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC6 — track/release/wave scope exactly as the client flags do today
  // ═══════════════════════════════════════════════════════════════════════

  test("AC6 — no --track with two live lanes refuses 400 with needs/tracks/totalCount/help, never a decision", async () => {
    boot();
    const key = await seed("cru098-next-route-multitrack");
    seedRows(key, [
      { cr: "CR-NEXTPTR-100", wave: "5", seq: 10, track: "track-1" },
      { cr: "CR-NEXTPTR-200", wave: "5", seq: 20, track: "track-2" },
    ]);

    const { status, body } = await get(`/api/v2/projects/${key}/next`);

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.needs).toEqual(["track"]);
    expect(body.tracks).toEqual(["track-1", "track-2"]);
    expect(body.totalCount).toBe(2);
    expect(Array.isArray(body.help)).toBe(true);
    expect(body.decision).toBeUndefined();
  });

  test("AC6 — ?track=2 resolves the canonical lane (the same rule wave-sequence's write path accepts)", async () => {
    boot();
    const key = await seed("cru098-next-route-track-flag");
    seedRows(key, [
      { cr: "CR-NEXTPTR-100", wave: "5", seq: 10, track: "track-1" },
      { cr: "CR-NEXTPTR-200", wave: "5", seq: 20, track: "track-2" },
    ]);

    const { status, body } = await get(`/api/v2/projects/${key}/next?track=2`);

    expect(status).toBe(200);
    expect(body.decision).toBe("NEXT");
    expect(body.cr).toBe("CR-NEXTPTR-200");
    expect(body.track).toBe("track-2");
  });

  test("AC6 — ?release and ?wave scope VERBATIM: '6' and '06' are two different waves, never coerced", async () => {
    boot();
    const key = await seed("cru098-next-route-wave-verbatim");
    seedRows(key, [
      { cr: "CR-NEXTPTR-PADDED", wave: "06", seq: 10 },
      { cr: "CR-NEXTPTR-BARE", wave: "6", seq: 20 },
    ]);

    const padded = await get(`/api/v2/projects/${key}/next?wave=06`);
    expect(padded.body.decision).toBe("NEXT");
    expect(padded.body.cr).toBe("CR-NEXTPTR-PADDED");

    const bare = await get(`/api/v2/projects/${key}/next?wave=6`);
    expect(bare.body.decision).toBe("NEXT");
    expect(bare.body.cr).toBe("CR-NEXTPTR-BARE");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AC3 — derived and read-only: no schema change, no cached answer
  // ═══════════════════════════════════════════════════════════════════════

  test("AC3 — SCHEMA_VERSION is unchanged (13) — the route adds no column, no migration", () => {
    expect(SCHEMA_VERSION).toBe(13);
  });

  test("AC3 — two reads of an unchanged board are byte-for-byte identical", async () => {
    boot();
    const key = await seed("cru098-next-route-idempotent");
    seedRows(key, [{ cr: "CR-NEXTPTR-100", wave: "5", seq: 10 }]);

    const first = await get(`/api/v2/projects/${key}/next`);
    expect(first.status).toBe(200);
    expect(first.body.decision).toBe("NEXT");
    const second = await get(`/api/v2/projects/${key}/next`);

    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
  });

  test("AC3 — a read AFTER a queue write reflects it — nothing is cached from the first read", async () => {
    boot();
    const key = await seed("cru098-next-route-write-reflected");
    seedRows(key, [{ cr: "CR-NEXTPTR-100", wave: "5", seq: 10 }]);

    const before = await get(`/api/v2/projects/${key}/next`);
    expect(before.body.cr).toBe("CR-NEXTPTR-100");

    seedRows(key, [
      { cr: "CR-NEXTPTR-100", wave: "5", seq: 10 },
      { cr: "CR-NEXTPTR-099", wave: "5", seq: 5 },
    ]);
    const after = await get(`/api/v2/projects/${key}/next`);
    expect(after.body.cr).toBe("CR-NEXTPTR-099");
    expect(after.body.cr).not.toBe(before.body.cr);
  });
});
