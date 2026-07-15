// CR-CRU-007 §S5 AC4 — the v2 projects listing (GET /api/v2/projects) gains
// server-computed `active: boolean` + `lastActivity: number` per project,
// driven by CRUCIBLE_PROJECT_INACTIVE_MS (default 3_600_000ms). Activity
// rule (user-locked round 13): active while >=1 live (online/stale) agent;
// with none left, inactive once now-lastActivity EXCEEDS the timeout.
// lastActivity = max(project's last event timestamp, agents' last-seen).
//
// Drives the REAL production entry (startServer + real HTTP GET), never a
// hand-wired store read — the ONLY deviation from a pure black-box HTTP test
// is fixture seeding: Store#touchAgent/recordTestEvent always stamp
// Date.now() internally (no timestamp-override lever anywhere in the public
// Store API, confirmed against src/store.ts), so backdating agent
// last_seen / event timestamp columns is the only way to get deterministic
// "N ago" fixtures without literally sleeping for 2 hours. That reaches past
// Store's `private readonly db` field (TypeScript `private` is compile-time
// only, not a JS runtime boundary) purely to set up state — every assertion
// below still goes through the real HTTP endpoint.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { Store } from "../src/store.ts";

interface ProjectWithActivity {
  key: string;
  name: string;
  active: boolean;
  lastActivity: number;
}

interface QueryHandle {
  run(...args: unknown[]): void;
}
interface RawDb {
  query(sql: string): QueryHandle;
}

/** Backdate an agent's last_seen column directly (see file header). */
function backdateAgentLastSeen(store: Store, projectKey: string, agentId: string, msAgo: number): void {
  const ts = Date.now() - msAgo;
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE agents SET last_seen = ? WHERE project_key = ? AND agent_id = ?`)
    .run(ts, projectKey, agentId);
}

/** Backdate an event's timestamp column directly (see file header). */
function backdateEventTimestamp(store: Store, eventId: string, msAgo: number): void {
  const ts = Date.now() - msAgo;
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE events SET timestamp = ? WHERE id = ?`)
    .run(ts, eventId);
}

describe("GET /api/v2/projects — §S5 AC4 activity rule (active + lastActivity)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const originalTimeoutEnv = process.env.CRUCIBLE_PROJECT_INACTIVE_MS;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    if (originalTimeoutEnv === undefined) delete process.env.CRUCIBLE_PROJECT_INACTIVE_MS;
    else process.env.CRUCIBLE_PROJECT_INACTIVE_MS = originalTimeoutEnv;
  });

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  test(
    "project A (1 online agent, seen 5s ago) and C (no live agents, 10min-old activity) are active; " +
      "project B (no live agents, 2h-old activity, timeout exceeded) is inactive; badge order A, C, B",
    async () => {
      process.env.CRUCIBLE_PROJECT_INACTIVE_MS = "3600000";
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;

      const keyA = crypto.randomUUID();
      const keyB = crypto.randomUUID();
      const keyC = crypto.randomUUID();
      store.addProject({ key: keyA, name: "Project A", type: "backend", sutRoot: "/tmp/a" });
      store.addProject({ key: keyB, name: "Project B", type: "backend", sutRoot: "/tmp/b" });
      store.addProject({ key: keyC, name: "Project C", type: "backend", sutRoot: "/tmp/c" });

      // A: 1 online agent, last seen 5s ago (well under the 60s stale threshold).
      store.touchAgent(keyA, "agent-a", { message: "hi" });
      backdateAgentLastSeen(store, keyA, "agent-a", 5_000);

      // B: no live agents; last activity 2h ago (exceeds the 1h timeout).
      // recordTestEvent implicitly heartbeats an agent row too (§S3) — back-
      // date that ghost agent alongside the event so it reads as "no live
      // agents" (>300s silence tombstones/prunes it under DEFAULT_LIVENESS),
      // matching the scenario's literal "no live agents" premise.
      const evB = store.recordTestEvent(
        keyB,
        "agent-b-ghost",
        { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 }, tree: [] },
        { tier: "unit" },
      );
      backdateEventTimestamp(store, evB.id, 7_200_000);
      backdateAgentLastSeen(store, keyB, "agent-b-ghost", 7_200_000);

      // C: no live agents; last activity 10min ago (within the 1h timeout).
      const evC = store.recordTestEvent(
        keyC,
        "agent-c-ghost",
        { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 }, tree: [] },
        { tier: "unit" },
      );
      backdateEventTimestamp(store, evC.id, 600_000);
      backdateAgentLastSeen(store, keyC, "agent-c-ghost", 600_000);

      const res = await fetch(`${base()}/api/v2/projects`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; projects: ProjectWithActivity[] };
      expect(body.ok).toBe(true);

      const byKey = (k: string): ProjectWithActivity | undefined =>
        body.projects.find((p) => p.key === k);

      expect(byKey(keyA)?.active).toBe(true);
      expect(byKey(keyC)?.active).toBe(true);
      expect(byKey(keyB)?.active).toBe(false);

      const now = Date.now();
      // lastActivity fields present and reflecting the backdated fixtures
      // (generous slack for real wall-clock drift during the test itself).
      expect(now - byKey(keyA)!.lastActivity).toBeGreaterThanOrEqual(5_000);
      expect(now - byKey(keyA)!.lastActivity).toBeLessThan(15_000);
      expect(now - byKey(keyC)!.lastActivity).toBeGreaterThanOrEqual(600_000);
      expect(now - byKey(keyC)!.lastActivity).toBeLessThan(620_000);
      expect(now - byKey(keyB)!.lastActivity).toBeGreaterThanOrEqual(7_200_000);
      expect(now - byKey(keyB)!.lastActivity).toBeLessThan(7_220_000);

      // §S5.1 ordering — most-recently-active first, inactive last.
      const order = body.projects.map((p) => p.key);
      expect(order).toEqual([keyA, keyC, keyB]);
    },
  );

  test("boundary: now - lastActivity exactly AT the configured timeout is still active (only EXCEEDING flips it)", async () => {
    process.env.CRUCIBLE_PROJECT_INACTIVE_MS = "3600000";
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store = handle.store;

    const key = crypto.randomUUID();
    store.addProject({ key, name: "Boundary Project", type: "backend", sutRoot: "/tmp/x" });
    const ev = store.recordTestEvent(
      key,
      "agent-boundary-ghost",
      { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 }, tree: [] },
      { tier: "unit" },
    );
    backdateEventTimestamp(store, ev.id, 3_600_000);
    backdateAgentLastSeen(store, key, "agent-boundary-ghost", 3_600_000);

    const res = await fetch(`${base()}/api/v2/projects`);
    const body = (await res.json()) as { ok: boolean; projects: ProjectWithActivity[] };
    const project = body.projects.find((p) => p.key === key);

    expect(project?.active).toBe(true);
  });

  test("respects a custom CRUCIBLE_PROJECT_INACTIVE_MS (not just the 3_600_000 default)", async () => {
    // A short 5s timeout: a project whose last activity is 10s old must read
    // inactive under this override, even though it would be active under the
    // 1h default used by every other test in this file.
    process.env.CRUCIBLE_PROJECT_INACTIVE_MS = "5000";
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const store = handle.store;

    const key = crypto.randomUUID();
    store.addProject({ key, name: "Short Timeout Project", type: "backend", sutRoot: "/tmp/y" });
    const ev = store.recordTestEvent(
      key,
      "agent-short-ghost",
      { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 }, tree: [] },
      { tier: "unit" },
    );
    backdateEventTimestamp(store, ev.id, 10_000);
    backdateAgentLastSeen(store, key, "agent-short-ghost", 10_000);

    const res = await fetch(`${base()}/api/v2/projects`);
    const body = (await res.json()) as { ok: boolean; projects: ProjectWithActivity[] };
    const project = body.projects.find((p) => p.key === key);

    expect(project?.active).toBe(false);
  });
});
