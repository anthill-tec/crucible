// CR-CRU-013 §S1 (gate events) + §S4b/§S4c (milestone events incl. cr-merged)
// — C1 server-foundation RED tests.
//
// Gap analysis (Implementation Notes, docs/changes/CR-CRU-013-gate-events.md,
// 2026-07-18) found three blockers that make gate/milestone a NEW event-kind
// family, not an extension of an existing one:
//   - RunEvent.kind (src/types.ts ~L110) is a closed 3-value union
//     "test"|"compile"|"lifecycle" — Store.toEvent (src/store.ts ~L895)
//     collapses any other kind to "test".
//   - There is no generic payload column — `compile` is the only free-JSON
//     blob field.
//   - Rollup exclusion is the single `row.kind !== "lifecycle"` check
//     (src/store.ts ~L967) — C1 must invert this to a rollup-ELIGIBLE set
//     {test, compile} so gate/milestone (like lifecycle) are excluded.
//
// This file drives the REAL production server (startServer) — POST
// /api/v2/gates and POST /api/v2/milestones do not exist in src/v2.ts yet,
// so every request below 404s through the catch-all until GREEN wires the
// widened kind union + payload column + rollup-eligible set + the two
// routes.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface OkResponse {
  ok: true;
  changed?: boolean;
  event?: string;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: string[];
  [key: string]: unknown;
}

interface EventBrief {
  id: string;
  projectKey: string;
  agentId: string;
  kind: string;
  codec?: string;
  // §S1/§S4b — gate/milestone `context` carries fields (track, cr) outside
  // the test/compile-event RunContext shape, so keep this generic here.
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

interface EventsListResponse extends OkResponse {
  events: EventBrief[];
}

// ── SSE frame reading (same technique as tests/project-patch.test.ts /
// tests/project-archive.test.ts — kept untyped per their bun-types vs
// node:stream/web ReadableStreamDefaultReader note). ─────────────────────
interface ParsedFrame {
  raw: string;
  isComment: boolean;
  data?: any;
}

function parseFrame(raw: string): ParsedFrame {
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length > 0 && lines.every((l) => l.startsWith(":"))) {
    return { raw, isComment: true };
  }
  const dataLine = lines.find((l) => l.startsWith("data:"));
  if (dataLine !== undefined) {
    const jsonStr = dataLine.slice("data:".length).trim();
    try {
      return { raw, isComment: false, data: JSON.parse(jsonStr) };
    } catch {
      return { raw, isComment: false };
    }
  }
  return { raw, isComment: false };
}

class SseReader {
  private buf = "";
  private readonly decoder = new TextDecoder();
  constructor(private readonly reader: any) {}

  async nextFrame(deadline: number): Promise<string> {
    for (;;) {
      const idx = this.buf.indexOf("\n\n");
      if (idx !== -1) {
        const frame = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        return frame;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("SSE read deadline exceeded waiting for a full frame");
      }
      const result = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SSE read timed out")), remaining),
        ),
      ]);
      if (result.done) {
        throw new Error("SSE stream closed unexpectedly before a frame completed");
      }
      this.buf += this.decoder.decode(result.value, { stream: true });
    }
  }
}

async function nextFrameMatching(
  sse: SseReader,
  predicate: (frame: ParsedFrame) => boolean,
  timeoutMs: number,
): Promise<ParsedFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await sse.nextFrame(deadline);
    const parsed = parseFrame(raw);
    if (predicate(parsed)) {
      return parsed;
    }
  }
}

describe("POST /api/v2/gates + /api/v2/milestones — server foundation (CR-CRU-013 C1)", () => {
  let handle: ServerHandle | undefined;

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

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function patchJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    // CR-CRU-056 §S2b fixture-repair (C3): /api/v2/gates and
    // /api/v2/milestones now refuse an unregistered agentId (409) —
    // "orchestrator-1" is the default agentId gateBody/milestoneBody use
    // across this file, so register it live for every project up front
    // (harmless for the field-validation tests, which use their own
    // distinct "a1"/unregistered ids and 400 on their own bad fields
    // before any registered-caller check is reached).
    await registerAgent(body.project.key, "orchestrator-1");
    return body.project.key;
  }

  async function registerAgent(key: string, agentId: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, phase: "ORCHESTRATOR" });
    expect(res.status).toBe(200);
  }

  async function listEvents(key: string): Promise<EventBrief[]> {
    const res = await getJson(`/api/v2/events?project=${key}`);
    const body = (await res.json()) as EventsListResponse;
    return body.events;
  }

  // §S1 — the full gate shape from the CR spec, verbatim field names:
  // {projectKey, agentId, context?{wave, track?}, gate:{intent, outcome,
  // steps:[{name,status,findings?{total,autoFix,askUser,fixed}, fixRounds?}],
  // fixes?, push?{commit,remote}, pr?}}.
  function defaultGate(overrides: Record<string, unknown> = {}) {
    return {
      intent: "wave 3 no-mistakes gate",
      outcome: "passed",
      steps: [
        { name: "intent", status: "passed" },
        {
          name: "review",
          status: "passed",
          findings: { total: 2, autoFix: 1, askUser: 0, fixed: 2 },
        },
        { name: "test", status: "passed" },
        { name: "push", status: "passed", fixRounds: 0 },
      ],
      fixes: [{ id: "f1", file: "src/a.ts", description: "removed unused import" }],
      push: { commit: "abc1234", remote: "origin/main" },
      pr: "https://github.com/x/y/pull/1",
      ...overrides,
    };
  }

  function gateBody(
    projectKey: string,
    gateOverrides: Record<string, unknown> = {},
    topOverrides: Record<string, unknown> = {},
  ) {
    return {
      projectKey,
      agentId: "orchestrator-1",
      context: { wave: "3", track: "A" },
      gate: defaultGate(gateOverrides),
      ...topOverrides,
    };
  }

  // §S4b — the milestone shape: {projectKey, agentId, type, label?,
  // context?{cr, wave, track}}.
  function milestoneBody(projectKey: string, overrides: Record<string, unknown> = {}) {
    return {
      projectKey,
      agentId: "orchestrator-1",
      type: "gap-analysis",
      label: "CR-NAI-043 gap-analysis",
      context: { cr: "CR-NAI-043", wave: "2" },
      ...overrides,
    };
  }

  // Every write route in this codebase carries `event: "evt-…"` on success
  // (§S5 changed:true|false convention) — narrow the optional wire field
  // once so downstream `.toBe()` comparisons aren't `string | undefined`.
  function eventIdOf(res: OkResponse): string {
    expect(typeof res.event).toBe("string");
    return res.event as string;
  }

  async function seedTestEvent(key: string, agentId: string): Promise<string> {
    await registerAgent(key, agentId);
    const res = await postJson("/api/v2/runs/parsed", {
      projectKey: key,
      agentId,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
      tree: [
        { name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 5 }] },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResponse;
    return body.event as string;
  }

  // ── §S1 — full gate payload round trip ───────────────────────────────
  describe("§S1 POST /api/v2/gates — full payload round trip", () => {
    test(
      "full gate shape → 201; GET /api/v2/events shows kind:'gate', codec:'no-mistakes', " +
        "and the FULL gate object (intent/outcome/steps/fixes/push/pr) round-tripping verbatim",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject("gate-roundtrip");
        const body = gateBody(key);

        const res = await postJson("/api/v2/gates", body);
        expect(res.status).toBe(201);
        const resBody = (await res.json()) as OkResponse;
        expect(resBody.ok).toBe(true);
        expect(resBody.changed).toBe(true);
        expect(resBody.event).toMatch(/^evt-/);

        const events = await listEvents(key);
        const stored = events.find((e) => e.kind === "gate");
        expect(stored).toBeDefined();
        expect(stored!.id).toBe(eventIdOf(resBody));
        expect(stored!.agentId).toBe("orchestrator-1");
        expect(stored!.codec).toBe("no-mistakes");
        expect(stored!.context).toEqual({ wave: "3", track: "A" });
        // Pins the kind-union widen + toEvent passthrough + the new payload
        // column: the ENTIRE submitted gate object survives intact.
        expect(stored!.gate).toEqual(body.gate);
      },
    );

    test("a step name outside the no-mistakes ladder is preserved verbatim (forward-tolerant)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("gate-forward-tolerant");
      const body = gateBody(key, {
        intent: "custom vendor pipeline",
        outcome: "passed",
        steps: [{ name: "vendor-scan", status: "passed" }],
        fixes: undefined,
        push: undefined,
        pr: undefined,
      });
      // Strip the undefined-valued keys so they aren't sent as explicit nulls.
      const gate = Object.fromEntries(
        Object.entries(body.gate).filter(([, v]) => v !== undefined),
      );

      const res = await postJson("/api/v2/gates", { ...body, gate });
      expect(res.status).toBe(201);

      const events = await listEvents(key);
      const stored = events.find((e) => e.kind === "gate");
      expect(stored).toBeDefined();
      expect((stored!.gate as { steps: Array<{ name: string; status: string }> }).steps).toEqual([
        { name: "vendor-scan", status: "passed" },
      ]);
    });
  });

  // ── §S1 — field + enum validation ────────────────────────────────────
  describe("§S1 POST /api/v2/gates — field + enum validation", () => {
    test("missing gate.intent → 400 naming intent", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("gate-missing-intent");
      const gate = defaultGate() as Record<string, unknown>;
      delete gate.intent;

      const res = await postJson("/api/v2/gates", {
        projectKey: key,
        agentId: "a1",
        gate,
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.ok).toBe(false);
      expect(err.error.toLowerCase()).toContain("intent");
    });

    test("missing gate.outcome → 400 naming outcome", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("gate-missing-outcome");
      const gate = defaultGate() as Record<string, unknown>;
      delete gate.outcome;

      const res = await postJson("/api/v2/gates", {
        projectKey: key,
        agentId: "a1",
        gate,
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.error.toLowerCase()).toContain("outcome");
    });

    test("missing gate.steps → 400 naming steps", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("gate-missing-steps");
      const gate = defaultGate() as Record<string, unknown>;
      delete gate.steps;

      const res = await postJson("/api/v2/gates", {
        projectKey: key,
        agentId: "a1",
        gate,
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.error.toLowerCase()).toContain("steps");
    });

    test("gate.outcome not in {checks-passed, passed, failed, cancelled} → 400 naming outcome", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("gate-bad-outcome");

      const res = await postJson("/api/v2/gates", gateBody(key, { outcome: "sorta-passed" }));
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.ok).toBe(false);
      expect(err.error.toLowerCase()).toContain("outcome");
    });

    test("each valid outcome value ({checks-passed, passed, failed, cancelled}) is accepted → 201", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("gate-outcomes");
      for (const outcome of ["checks-passed", "passed", "failed", "cancelled"]) {
        const res = await postJson("/api/v2/gates", gateBody(key, { outcome }));
        expect(res.status).toBe(201);
      }
    });

    test("unknown projectKey → 404", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/gates", gateBody(crypto.randomUUID()));
      expect(res.status).toBe(404);
      const err = (await res.json()) as ErrResponse;
      expect(err.ok).toBe(false);
    });
  });

  // ── §S1 — rollup exclusion ───────────────────────────────────────────
  describe("§S1 gate ingestion does not change test-run rollup counts", () => {
    test(
      "retention forces a fold: a folded GATE event (oldest, evicted first) leaves rollups " +
        "unchanged; a subsequently-folded TEST event DOES create a rollup row — proving the " +
        "exclusion is kind-specific, not a broken fold pipeline",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject("gate-rollup-exclusion");

        const patchRes = await patchJson(`/api/v2/projects/${key}`, { retention: 1 });
        expect(patchRes.status).toBe(200);

        // 1. Seed the gate first — it will be the OLDEST row.
        const gateRes = await postJson("/api/v2/gates", gateBody(key));
        expect(gateRes.status).toBe(201);
        // Count is 1 == cap: no overflow, nothing folded yet.
        expect(handle.store.listRollups(key)).toEqual([]);

        // 2. Ingest one test event: count becomes 2, overflow 1 → the OLDEST
        // row (the gate) is evicted+folded. Rollup-eligible kinds are
        // {test, compile} (Implementation Notes) — gate must NOT fold in.
        const e1Id = await seedTestEvent(key, "seed-1");

        expect(handle.store.listRollups(key)).toEqual([]);
        expect(handle.store.countEvents(key)).toBe(1);
        expect(handle.store.listEvents(key, 10).map((e) => e.id)).toEqual([e1Id]);

        // 3. Ingest a SECOND test event: the step-2 survivor (a "test" kind)
        // is now oldest and gets evicted+folded — THIS one must create a
        // rollup row, confirming the fold mechanism itself still works.
        await seedTestEvent(key, "seed-2");

        const rollups = handle.store.listRollups(key);
        expect(rollups.length).toBe(1);
        expect(rollups[0]!.runs).toBe(1);
        expect(rollups[0]!.passed).toBe(1);
      },
    );
  });

  // ── §S1 — SSE emission ───────────────────────────────────────────────
  describe("§S1 gate ingest emits an SSE events frame", () => {
    test("POST /api/v2/gates triggers a {type:'events', projectKey} SSE frame (stream capture)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("gate-sse");

      const streamRes = await fetch(`http://localhost:${handle.server.port}/api/stream`);
      const reader = streamRes.body!.getReader();
      const sse = new SseReader(reader);
      await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

      const gateRes = await postJson("/api/v2/gates", gateBody(key));
      expect(gateRes.status).toBe(201);

      const eventsFrame = await nextFrameMatching(
        sse,
        (f) => !f.isComment && f.data?.type === "events" && f.data?.projectKey === key,
        1000,
      );
      expect(eventsFrame.data.type).toBe("events");
      expect(eventsFrame.data.projectKey).toBe(key);

      await reader.cancel();
    });
  });

  // ── §S4b — milestone type round trip + unknown-type 400 ──────────────
  describe("§S4b POST /api/v2/milestones — type round trip + unknown-type 400", () => {
    test(
      "type:'gap-analysis' → 201; GET /api/v2/events shows kind:'milestone', " +
        "type/label/context round-tripping",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject("milestone-roundtrip");
        const body = milestoneBody(key);

        const res = await postJson("/api/v2/milestones", body);
        expect(res.status).toBe(201);
        const resBody = (await res.json()) as OkResponse;
        expect(resBody.ok).toBe(true);
        expect(resBody.changed).toBe(true);
        expect(resBody.event).toMatch(/^evt-/);

        const events = await listEvents(key);
        const stored = events.find((e) => e.kind === "milestone");
        expect(stored).toBeDefined();
        expect(stored!.id).toBe(eventIdOf(resBody));
        expect(stored!.agentId).toBe("orchestrator-1");
        expect(stored!.type).toBe("gap-analysis");
        expect(stored!.label).toBe("CR-NAI-043 gap-analysis");
        expect(stored!.context).toEqual({ cr: "CR-NAI-043", wave: "2" });
      },
    );

    test("each additional valid type ({design-review, stage-flip, custom}) is accepted → 201", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("milestone-valid-types");
      for (const type of ["design-review", "stage-flip", "custom"]) {
        const res = await postJson("/api/v2/milestones", milestoneBody(key, { type }));
        expect(res.status).toBe(201);
      }
    });

    test("type:'deploy' (unknown) → 400 naming type", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("milestone-bad-type");

      const res = await postJson("/api/v2/milestones", milestoneBody(key, { type: "deploy" }));
      expect(res.status).toBe(400);
      const err = (await res.json()) as ErrResponse;
      expect(err.ok).toBe(false);
      expect(err.error.toLowerCase()).toContain("type");
    });

    test("unknown projectKey → 404", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/milestones", milestoneBody(crypto.randomUUID()));
      expect(res.status).toBe(404);
      const err = (await res.json()) as ErrResponse;
      expect(err.ok).toBe(false);
    });
  });

  // ── §S4c — cr-merged marker ───────────────────────────────────────────
  describe("§S4c cr-merged milestone marker", () => {
    test(
      "POST /api/v2/milestones {type:'cr-merged', label:'CR-NAI-042', commit:'abc1234', " +
        "context:{cr:'CR-NAI-042', wave:1}} → 201; stored as a milestone with commit + label " +
        "round-tripping verbatim; 'cr-merged' joins the §S4b valid-type set",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject("cr-merged-marker");
        const body = {
          projectKey: key,
          agentId: "cr-close-verb",
          type: "cr-merged",
          label: "CR-NAI-042",
          commit: "abc1234",
          context: { cr: "CR-NAI-042", wave: 1 },
        };
        await registerAgent(key, "cr-close-verb");

        const res = await postJson("/api/v2/milestones", body);
        expect(res.status).toBe(201);
        const resBody = (await res.json()) as OkResponse;
        expect(resBody.ok).toBe(true);
        expect(resBody.event).toMatch(/^evt-/);

        const events = await listEvents(key);
        const stored = events.find((e) => e.kind === "milestone" && e.type === "cr-merged");
        expect(stored).toBeDefined();
        expect(stored!.id).toBe(eventIdOf(resBody));
        expect(stored!.label).toBe("CR-NAI-042");
        expect(stored!.commit).toBe("abc1234");
        expect(stored!.context).toEqual({ cr: "CR-NAI-042", wave: 1 });
      },
    );
  });

  // ── §S4b/§S4c — milestone rollup exclusion (same technique as gates) ──
  describe("§S4b milestones excluded from test-run rollups (same technique as gates)", () => {
    test(
      "retention forces a fold: a folded MILESTONE event (oldest, evicted first) leaves " +
        "rollups unchanged; a subsequently-folded TEST event DOES create a rollup row",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject("milestone-rollup-exclusion");

        const patchRes = await patchJson(`/api/v2/projects/${key}`, { retention: 1 });
        expect(patchRes.status).toBe(200);

        const milestoneRes = await postJson("/api/v2/milestones", milestoneBody(key));
        expect(milestoneRes.status).toBe(201);
        expect(handle.store.listRollups(key)).toEqual([]);

        const e1Id = await seedTestEvent(key, "seed-1");

        expect(handle.store.listRollups(key)).toEqual([]);
        expect(handle.store.countEvents(key)).toBe(1);
        expect(handle.store.listEvents(key, 10).map((e) => e.id)).toEqual([e1Id]);

        await seedTestEvent(key, "seed-2");

        const rollups = handle.store.listRollups(key);
        expect(rollups.length).toBe(1);
        expect(rollups[0]!.runs).toBe(1);
        expect(rollups[0]!.passed).toBe(1);
      },
    );
  });
});
