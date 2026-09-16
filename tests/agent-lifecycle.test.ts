// CR-CRU-011 §S1 — agent lifecycle events (server, additive) + §S2 — agent
// runtime computation (server-computed field). Closes the round-11 backwards-
// audit gap: register/unregister previously left NO trace once
// Store.removeAgent hard-deleted the agents row (firstSeen/lastSeen
// destroyed at exactly the moment the runtime becomes final — see CR-CRU-011
// Context). This CR appends `kind:"lifecycle"` events to the project's event
// log on register/unregister, and computes a `runtime_ms` field per the
// user-specified rule: unregistered -> unregistered_ts - firstSeen; still
// live -> now - firstSeen (ticking); tombstoned/pruned -> last run
// timestamp - firstSeen (sealed).
//
// Drives the REAL production server (startServer) + real HTTP, same harness
// pattern as tests/plans.test.ts. (History: this line also cited
// tests/shim-projects-agents.test.ts — archived by CR-CRU-008's shim-
// retirement sweep, then deleted outright with tests/archive by CR-CRU-047.
// tests/plans.test.ts is the surviving exemplar of that harness pattern.)
// Timestamp fixtures use the SAME raw-db backdating technique as
// tests/v2-projects-activity.test.ts (Store has no timestamp-override lever
// in its public API — confirmed against src/store.ts) purely to seed
// deterministic state; every assertion goes through the real HTTP endpoint
// or a documented public Store method (listRollups/countEvents/hasAgent).
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { Store } from "../src/store.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface LifecycleEventBrief {
  id: string;
  projectKey: string;
  agentId: string;
  kind: string;
  action?: string;
  timestamp: number;
  firstSeen?: number;
  [key: string]: unknown;
}

interface EventsListResponse {
  ok: true;
  events: LifecycleEventBrief[];
}

interface AgentBrief {
  agentId: string;
  projectKey: string;
  liveness: string;
  runtime_ms?: number;
  [key: string]: unknown;
}

interface AgentsListResponse {
  ok: true;
  agents: AgentBrief[];
}

interface StatusResponse {
  ok: true;
  status: {
    hasData: boolean;
    lastTest: { id: string; kind: string; [key: string]: unknown } | null;
    lastCompile: unknown;
  };
}

interface QueryHandle {
  run(...args: unknown[]): void;
}
interface RawDb {
  query(sql: string): QueryHandle;
}

/** Backdate an agent's first_seen/last_seen columns directly (see file header). */
function setAgentTimestamps(
  store: Store,
  projectKey: string,
  agentId: string,
  opts: { firstSeen?: number; lastSeen?: number },
): void {
  const raw = (store as unknown as { db: RawDb }).db;
  if (opts.firstSeen !== undefined) {
    raw
      .query(`UPDATE agents SET first_seen = ? WHERE project_key = ? AND agent_id = ?`)
      .run(opts.firstSeen, projectKey, agentId);
  }
  if (opts.lastSeen !== undefined) {
    raw
      .query(`UPDATE agents SET last_seen = ? WHERE project_key = ? AND agent_id = ?`)
      .run(opts.lastSeen, projectKey, agentId);
  }
}

/** Backdate an event's timestamp column directly (see file header). */
function setEventTimestamp(store: Store, eventId: string, ts: number): void {
  (store as unknown as { db: RawDb }).db
    .query(`UPDATE events SET timestamp = ? WHERE id = ?`)
    .run(ts, eventId);
}

describe("CR-CRU-011 C2 — §S1 agent lifecycle events + §S2 agent runtime rule", () => {
  let handle: ReturnType<typeof startServer> | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
  });

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function seedProject(store: Store, opts?: { retention?: number }): string {
    const key = crypto.randomUUID();
    store.addProject({
      key,
      name: "P",
      type: "backend",
      sutRoot: "/tmp/p",
      ...(opts?.retention !== undefined ? { retention: opts.retention } : {}),
    });
    return key;
  }

  // ── §S1 — lifecycle events on register/unregister ────────────────────────

  describe("§S1 lifecycle events", () => {
    test(
      "POST /api/v2/agents/register then unregister appends TWO lifecycle events " +
        "(kind:'lifecycle', action:'registered'|'unregistered', agentId, timestamp) " +
        "visible via GET /api/v2/events?project=; the unregistered event carries " +
        "firstSeen and runtime_ms = unregistered.timestamp - firstSeen exactly",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const agentId = "agent-lifecycle-1";

        const regRes = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });
        expect(regRes.status).toBe(200);
        const regBody = (await regRes.json()) as OkResponse;
        expect(regBody.ok).toBe(true);

        // Pin firstSeen to a known offset (123456ms before "now") so the
        // runtime formula is checkable within a tight, deterministic bound
        // without a mockable clock.
        const knownFirstSeen = Date.now() - 123_456;
        setAgentTimestamps(store, key, agentId, { firstSeen: knownFirstSeen });

        const beforeUnregister = Date.now();
        const unregRes = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
        const afterUnregister = Date.now();
        expect(unregRes.status).toBe(200);
        const unregBody = (await unregRes.json()) as OkResponse;
        expect(unregBody.ok).toBe(true);
        expect(unregBody.changed).toBe(true);

        const eventsRes = await fetch(`${base()}/api/v2/events?project=${key}`);
        expect(eventsRes.status).toBe(200);
        const eventsBody = (await eventsRes.json()) as EventsListResponse;
        expect(eventsBody.ok).toBe(true);

        const lifecycleEvents = eventsBody.events.filter((e) => e.kind === "lifecycle");
        expect(lifecycleEvents.length).toBe(2);

        const registered = lifecycleEvents.find((e) => e.action === "registered");
        const unregistered = lifecycleEvents.find((e) => e.action === "unregistered");
        expect(registered).toBeDefined();
        expect(unregistered).toBeDefined();
        expect(registered!.agentId).toBe(agentId);
        expect(unregistered!.agentId).toBe(agentId);
        expect(typeof registered!.timestamp).toBe("number");
        expect(typeof unregistered!.timestamp).toBe("number");

        // The unregistered event snapshots firstSeen so runtime survives the
        // agents-row deletion (the round-11 audit's gap).
        expect(unregistered!.firstSeen).toBe(knownFirstSeen);
        // timestamp is the real unregister-call time, not stale/zero.
        expect(unregistered!.timestamp).toBeGreaterThanOrEqual(beforeUnregister);
        expect(unregistered!.timestamp).toBeLessThanOrEqual(afterUnregister);

        const runtimeMs = unregistered!.timestamp - unregistered!.firstSeen!;
        // Exact formula check within a tight tolerance for real test-run
        // wall-clock slack (register->backdate->unregister round trip).
        expect(runtimeMs).toBeGreaterThanOrEqual(123_456);
        expect(runtimeMs).toBeLessThan(123_456 + 3_000);
      },
    );

    test("removeAgent still physically deletes the agents row on unregister (regression pin)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "agent-lifecycle-2";

      await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });
      expect(store.hasAgent(key, agentId)).toBe(true);

      await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
      expect(store.hasAgent(key, agentId)).toBe(false);
    });

    test("a repeat unregister on an already-gone agent -> changed:false (idempotent, unchanged from pre-CR-011 shape)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "agent-lifecycle-3";

      await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });
      await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
      const second = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
      const body = (await second.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(false);
    });

    test("a heartbeat on an EXISTING agent does not append a second 'registered' lifecycle event", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "agent-lifecycle-4";

      await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });
      // Second touch (heartbeat semantics) on the SAME agent — must not
      // fire a second "registered" lifecycle event.
      await postJson("/api/v2/agents/heartbeat", { projectKey: key, agentId });
      await postJson("/api/v2/agents/heartbeat", { projectKey: key, agentId });

      const eventsRes = await fetch(`${base()}/api/v2/events?project=${key}`);
      const eventsBody = (await eventsRes.json()) as EventsListResponse;
      const registeredEvents = eventsBody.events.filter(
        (e) => e.kind === "lifecycle" && e.action === "registered",
      );
      expect(registeredEvents.length).toBe(1);
    });
  });

  // ── Rollup isolation — lifecycle events never alter test-run rollups ─────

  describe("rollup isolation", () => {
    test(
      "lifecycle events flow through retention like any event (count toward the " +
        "per-project retention cap) but are EXCLUDED from folded rollup counts " +
        "(runs/passed/failed) when evicted",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store, { retention: 1 });

        // One real test run (a pass) — will be evicted+folded by the NEXT
        // insertion once the cap (1) is exceeded.
        store.recordTestEvent(
          key,
          "agent-real",
          { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 }, tree: [] },
          { tier: "unit" },
        );
        expect(store.countEvents(key)).toBe(1);

        // Register -> a "registered" lifecycle event is inserted, pushing
        // the raw-event count to 2 (cap 1) -> the real test run gets
        // evicted+folded into the rollup (runs:1, passed:1, failed:0).
        const agentId = "agent-rollup-1";
        await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });
        expect(store.countEvents(key)).toBe(1);

        let rollups = store.listRollups(key);
        let totalRuns = rollups.reduce((sum, r) => sum + r.runs, 0);
        let totalPassed = rollups.reduce((sum, r) => sum + r.passed, 0);
        let totalFailed = rollups.reduce((sum, r) => sum + r.failed, 0);
        expect(totalRuns).toBe(1);
        expect(totalPassed).toBe(1);
        expect(totalFailed).toBe(0);

        // Unregister -> a second lifecycle event is inserted, pushing count
        // to 2 again -> the "registered" lifecycle event (the current
        // oldest raw event) gets evicted next. If lifecycle events were
        // (incorrectly) folded as runs, totalRuns would jump to 2 here.
        await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
        // Retention cap (1) still respected — lifecycle events are not
        // silently exempted from eviction.
        expect(store.countEvents(key)).toBe(1);

        rollups = store.listRollups(key);
        totalRuns = rollups.reduce((sum, r) => sum + r.runs, 0);
        totalPassed = rollups.reduce((sum, r) => sum + r.passed, 0);
        totalFailed = rollups.reduce((sum, r) => sum + r.failed, 0);
        // UNCHANGED — the evicted "registered" lifecycle event contributed
        // NOTHING to the rollup (test-run rollups stay pure).
        expect(totalRuns).toBe(1);
        expect(totalPassed).toBe(1);
        expect(totalFailed).toBe(0);
      },
    );

    test("the brief/status paths (GET /api/v2/status lastTest) are unaffected by newer lifecycle events", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);

      const run = store.recordTestEvent(
        key,
        "agent-real",
        { summary: { total: 3, passed: 3, failed: 0, pending: 0, duration_ms: 12 }, tree: [] },
        { tier: "unit" },
      );

      // Register+unregister AFTER the real run — chronologically newer, so
      // a naive "most recent event" read would pick a lifecycle event up.
      const agentId = "agent-rollup-3";
      await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });
      await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });

      const statusRes = await fetch(`${base()}/api/v2/status?project=${key}`);
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as StatusResponse;
      expect(statusBody.status.lastTest).not.toBeNull();
      expect(statusBody.status.lastTest!.id).toBe(run.id);
      expect(statusBody.status.lastTest!.kind).toBe("test");
    });
  });

  // ── §S2 — runtime computation rule ────────────────────────────────────────

  describe("§S2 runtime rule (GET /api/v2/agents runtime_ms)", () => {
    test("still-live agent: runtime_ms = now - firstSeen, ticking (monotonically increasing across two samples)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const store = handle.store;
      const key = seedProject(store);
      const agentId = "agent-live-1";

      await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });
      const firstSeen = Date.now() - 10_000;
      setAgentTimestamps(store, key, agentId, { firstSeen, lastSeen: Date.now() });

      const res1 = await fetch(`${base()}/api/v2/agents?project=${key}`);
      const body1 = (await res1.json()) as AgentsListResponse;
      const agent1 = body1.agents.find((a) => a.agentId === agentId);
      expect(agent1).toBeDefined();
      expect(agent1!.liveness).toBe("online");
      expect(typeof agent1!.runtime_ms).toBe("number");
      // ~10s, generous slack for real wall-clock test overhead.
      expect(agent1!.runtime_ms).toBeGreaterThanOrEqual(10_000);
      expect(agent1!.runtime_ms).toBeLessThan(15_000);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const res2 = await fetch(`${base()}/api/v2/agents?project=${key}`);
      const body2 = (await res2.json()) as AgentsListResponse;
      const agent2 = body2.agents.find((a) => a.agentId === agentId);
      expect(agent2).toBeDefined();
      // Ticking — the second sample must be strictly greater ("now" moved).
      expect(agent2!.runtime_ms!).toBeGreaterThan(agent1!.runtime_ms!);
    });

    test(
      "tombstoned agent (no explicit unregister): runtime_ms = lastRunTimestamp - firstSeen, sealed " +
        "(AC fixture: register at t0, runs at t0+10s and t0+60s -> runtime exactly 60s)",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const agentId = "agent-tombstoned-1";

        await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "report" });

        const t0 = Date.now() - 500_000;
        const run1 = store.recordTestEvent(
          key,
          agentId,
          { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 4 }, tree: [] },
          { tier: "unit" },
        );
        const run2 = store.recordTestEvent(
          key,
          agentId,
          { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 4 }, tree: [] },
          { tier: "unit" },
        );
        setEventTimestamp(store, run1.id, t0 + 10_000);
        setEventTimestamp(store, run2.id, t0 + 60_000);
        // firstSeen = t0; last_seen pushed silent enough to be TOMBSTONED
        // under DEFAULT_LIVENESS (>=300_000ms silence, <3_600_000ms) —
        // matches the AC fixture's "prune" (aged-out, no explicit
        // unregister) case: the agent row is still queryable at this point
        // (liveness "tombstoned"), only physically deleted once it crosses
        // pruneAfterMs — a state listAgents excludes entirely, so this is
        // the only observable point the AC's runtime value can be asserted.
        setAgentTimestamps(store, key, agentId, { firstSeen: t0, lastSeen: t0 + 60_000 });

        const res = await fetch(`${base()}/api/v2/agents?project=${key}`);
        const body = (await res.json()) as AgentsListResponse;
        const agent = body.agents.find((a) => a.agentId === agentId);
        expect(agent).toBeDefined();
        expect(agent!.liveness).toBe("tombstoned");
        // Exactly 60s — last RUN's timestamp minus firstSeen, not "now".
        expect(agent!.runtime_ms).toBe(60_000);

        // Sealed — a second read some real time later must be IDENTICAL
        // (never "now - firstSeen" for a non-live agent).
        await new Promise((resolve) => setTimeout(resolve, 300));
        const res2 = await fetch(`${base()}/api/v2/agents?project=${key}`);
        const body2 = (await res2.json()) as AgentsListResponse;
        const agent2 = body2.agents.find((a) => a.agentId === agentId);
        expect(agent2!.runtime_ms).toBe(60_000);
      },
    );
  });

  // ── CR-CRU-094 §S2 — participation survives the agent (AC4) ──────────────
  //
  // §S2 verbatim: "A `lifecycle` event records the cycle the agent was bound
  // to, so the register/unregister pair is a complete record of *who worked
  // which cycle in which role* — recoverable after the agent row is gone, and
  // recoverable for an agent that produced no runs at all."
  //
  // RED, and the exact reason: `Store.recordLifecycleEvent(projectKey,
  // agentId, action, firstSeen?, role?)` takes NO cycle argument, and the
  // event it builds carries neither `context` nor `cycleId`, so `insertEvent`
  // (which derives `events.cycle_id` from `event.context?.cycleId`) writes
  // NULL and §S1's top-level `cycleId` projection is absent. Both routes that
  // destroy the agents row already hold the binding at the moment they fire —
  // the unregister route reads the row (firstSeen/role) BEFORE deleting it
  // under CR-CRU-057's captured-before-deletion contract, and the register
  // route validated the binding one statement earlier — so the gap is the
  // recording, not the availability.
  //
  // Asserted with ZERO runs on purpose: a run-derived answer (the §S1
  // `events.cycle_id` column on an ingested run) would mask exactly the case
  // this AC closes — an agent that registered, did its work, and ingested
  // nothing.

  describe("CR-CRU-094 §S2 — the lifecycle record names the cycle (AC4)", () => {
    const FIXTURE_ORCH = "lifecycle-cycle-fixture-orch";

    async function patchJson(path: string, body: unknown): Promise<Response> {
      return fetch(`${base()}${path}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    /** Files a one-cycle plan through the real plans API and activates it, so
     * a `--cycle` binding validates (an ACTIVE cycle of an OPEN plan). Same
     * HTTP-only fixture shape as tests/agent-cycle-binding.test.ts. */
    async function fileAndActivate(key: string): Promise<number> {
      const reg = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: FIXTURE_ORCH,
        role: "ORCHESTRATOR",
      });
      expect(reg.status).toBe(200);
      const filed = await postJson(`/api/v2/projects/${key}/plans`, {
        agentId: FIXTURE_ORCH,
        cr: "CR-AUTH",
        cycles: [{ label: "solo" }],
      });
      expect(filed.status).toBe(201);
      const plan = (await filed.json()) as { planId: number; cycles: { id: number }[] };
      const cycleId = plan.cycles[0]!.id;
      const activated = await patchJson(
        `/api/v2/projects/${key}/plans/${plan.planId}/cycles/${cycleId}`,
        { agentId: FIXTURE_ORCH, status: "active" },
      );
      expect(activated.status).toBe(200);
      return cycleId;
    }

    /** The PROJECTION side — the lifecycle events GET /api/v2/events serves
     * for one agent, oldest-first so `action` order is deterministic. */
    async function lifecycleBriefsFor(
      key: string,
      agentId: string,
    ): Promise<LifecycleEventBrief[]> {
      const res = await fetch(`${base()}/api/v2/events?project=${key}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as EventsListResponse;
      return body.events
        .filter((e) => e.kind === "lifecycle" && e.agentId === agentId)
        // Chronological; register/unregister can land in the SAME millisecond
        // in-memory, so the action name breaks the tie deterministically
        // ("registered" always precedes "unregistered", which is also the only
        // causally possible order).
        .sort(
          (a, b) =>
            a.timestamp - b.timestamp ||
            String(a.action).localeCompare(String(b.action)),
        );
    }

    /** The STORED side — the same events read back off the store, so a
     * projection that fabricated the field could not pass alone. */
    function storedLifecycleFor(store: Store, key: string, agentId: string) {
      return store
        .listEvents(key)
        .filter((e) => e.kind === "lifecycle" && e.agentId === agentId);
    }

    test(
      "register bound to cycle N, ingest NOTHING, unregister: BOTH lifecycle events " +
        "still name the agent, its role and cycle N after the agents row is gone",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const cycleId = await fileAndActivate(key);
        const agentId = "participation-unregistered";

        const reg = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "RED",
          cycleId,
        });
        expect(reg.status).toBe(200);

        const unreg = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
        expect(unreg.status).toBe(200);

        // The row is GONE and NOTHING was ingested — the lifecycle events are
        // the entire surviving record.
        expect(store.hasAgent(key, agentId)).toBe(false);
        expect(
          store.listEvents(key).filter((e) => e.agentId === agentId && e.kind !== "lifecycle"),
        ).toEqual([]);

        const briefs = await lifecycleBriefsFor(key, agentId);
        expect(briefs.map((e) => e.action)).toEqual(["registered", "unregistered"]);
        const [registered, unregistered] = briefs as [LifecycleEventBrief, LifecycleEventBrief];

        // WHO, in which ROLE — already true today (CR-CRU-057), pinned here
        // because the AC is the whole triple, not the cycle alone.
        expect(registered.role).toBe("RED");
        expect(unregistered.role).toBe("RED");

        // WHICH CYCLE — the new half. §S1's top-level `cycleId` key, the same
        // vocabulary an ingested run's brief already speaks.
        expect(registered.cycleId).toBe(cycleId);
        expect(unregistered.cycleId).toBe(cycleId);

        // The STORED event carries it too, so the answer survives a restart
        // rather than being computed by the read route.
        const stored = storedLifecycleFor(store, key, agentId);
        expect(stored).toHaveLength(2);
        expect(stored.map((e) => e.cycleId)).toEqual([cycleId, cycleId]);
      },
    );

    test(
      "the REGISTER-side event carries the cycle on its own: it is readable before any " +
        "unregister happens, so an agent still at work is already attributable",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const cycleId = await fileAndActivate(key);
        const agentId = "participation-still-live";

        const reg = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "GREEN",
          cycleId,
        });
        expect(reg.status).toBe(200);
        expect(store.hasAgent(key, agentId)).toBe(true);

        const briefs = await lifecycleBriefsFor(key, agentId);
        expect(briefs.map((e) => e.action)).toEqual(["registered"]);
        expect(briefs[0]!.role).toBe("GREEN");
        expect(briefs[0]!.cycleId).toBe(cycleId);
      },
    );

    test(
      "prune by silence: the row is destroyed with NO unregister, and the surviving " +
        "'registered' event still names the role and cycle N",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const cycleId = await fileAndActivate(key);
        const agentId = "participation-pruned";

        const reg = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "ORCHESTRATOR",
          cycleId,
        });
        expect(reg.status).toBe(200);

        // §S2's SECOND destruction route, driven with the mechanism the suite
        // already owns (raw last_seen backdating — see the file header): push
        // silence past DEFAULT_LIVENESS.pruneAfterMs (3_600_000ms) so
        // `Store.livenessOf` reads "pruned" and `listAgents` lazily deletes
        // the row. No new machinery, no clock injection, no config patch.
        setAgentTimestamps(store, key, agentId, { lastSeen: Date.now() - 4_000_000 });

        const listRes = await fetch(`${base()}/api/v2/agents?project=${key}`);
        expect(listRes.status).toBe(200);
        const listBody = (await listRes.json()) as AgentsListResponse;
        expect(listBody.agents.map((a) => a.agentId)).not.toContain(agentId);
        expect(store.hasAgent(key, agentId)).toBe(false);

        // Nothing journalled the death — exactly ONE lifecycle event exists,
        // and it has to answer the whole question by itself.
        const briefs = await lifecycleBriefsFor(key, agentId);
        expect(briefs.map((e) => e.action)).toEqual(["registered"]);
        expect(briefs[0]!.role).toBe("ORCHESTRATOR");
        expect(briefs[0]!.cycleId).toBe(cycleId);

        const stored = storedLifecycleFor(store, key, agentId);
        expect(stored).toHaveLength(1);
        expect(stored[0]!.cycleId).toBe(cycleId);
      },
    );

    test(
      "an UNBOUND registration (ORCHESTRATOR, no cycleId) leaves lifecycle events with " +
        "NO cycleId key at all — absent, never 0 and never null",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const store = handle.store;
        const key = seedProject(store);
        const agentId = "participation-unbound";

        const reg = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId,
          role: "ORCHESTRATOR",
        });
        expect(reg.status).toBe(200);
        const unreg = await postJson("/api/v2/agents/unregister", { projectKey: key, agentId });
        expect(unreg.status).toBe(200);

        const briefs = await lifecycleBriefsFor(key, agentId);
        expect(briefs.map((e) => e.action)).toEqual(["registered", "unregistered"]);
        for (const brief of briefs) {
          expect(brief.role).toBe("ORCHESTRATOR");
          // ABSENT — the additive convention §S1 states for `cycleId`. A
          // hardcoded 0/null would satisfy every positive assertion above.
          expect("cycleId" in brief).toBe(false);
        }

        const stored = storedLifecycleFor(store, key, agentId);
        expect(stored).toHaveLength(2);
        expect(stored.map((e) => e.cycleId)).toEqual([undefined, undefined]);
      },
    );
  });
});
