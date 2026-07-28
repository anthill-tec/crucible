// CR-CRU-012 §S1b — Archive / unarchive (additive), cycle 26. RED phase.
//
// Spec (verbatim, §S1b): "POST /api/v2/projects/<key>/archive and
// .../unarchive (additive). Archiving sets `archivedAt` — the project and
// ALL its records stay stored but are excluded from every internal query:
// projects listing (default), events, agents, rollups, SSE change payloads.
// Agent API calls against an archived project → 404 with an `archived` hint
// in `help[]` (registration does NOT resurrect; unarchive is explicit).
// `GET /api/v2/projects?archived=true` lists archived projects
// (manager-only view). Unarchive restores full visibility — records were
// never deleted."
//
// The three §S1b ACs pinned here (verbatim from the AC list, SERVER-observable
// parts only — the manager-UI archive action + badge-removal-without-reload
// half of the third AC belongs to cycle 28):
// - "POST /api/v2/projects/<key>/archive → 200; afterwards GET
//   /api/v2/projects omits the project, GET /api/v2/events?project=<key> and
//   the agents listing return 404/empty per contract, and project rollups
//   exclude it; GET /api/v2/projects?archived=true includes it;
//   .../unarchive restores it to every listing with all prior events intact
//   (count equality asserted before/after)."
// - "an agent register/runs call against an archived project → 404 whose
//   help[] mentions the archived state; the call does NOT unarchive it."
//
// Neither GET /api/v2/events nor GET /api/v2/agents validates project
// EXISTENCE today (see src/v2.ts handleEventsList/handleAgentsList — both
// just filter store.listEvents(project)/store.listAgents(project), which
// return [] for any key with no matching rows). So "404/empty per contract"
// resolves to EMPTY for these two list endpoints (200 {ok:true, events:[]}
// / {ok:true, agents:[]}) — the 404 half of that AC clause is the
// register/runs behavior pinned in the second AC (those DO call
// requireProject, src/v2.ts ~161).
//
// Drives the REAL production server (startServer), same harness pattern as
// tests/plans.test.ts / tests/v2-stream-paging.test.ts (SSE capture).
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  help?: string[];
  [key: string]: unknown;
}

interface ProjectBrief {
  key: string;
  name: string;
  [key: string]: unknown;
}

interface ProjectsListResponse extends OkResponse {
  projects: ProjectBrief[];
}

interface EventBrief {
  id: string;
  [key: string]: unknown;
}

interface EventsListResponse extends OkResponse {
  events: EventBrief[];
}

interface AgentBrief {
  agentId: string;
  projectKey: string;
  [key: string]: unknown;
}

interface AgentsListResponse extends OkResponse {
  agents: AgentBrief[];
}

interface RunsPostResponse extends OkResponse {
  event: string;
}

// ── SSE frame reading helpers (same technique as tests/v2-stream-paging.test.ts) ──

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

  // Untyped on purpose, mirroring tests/v2-stream-paging.test.ts's SseReader
  // (bun-types vs node:stream/web ReadableStreamDefaultReader ambiguity).
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

/** Asserts NO frame matching `predicate` arrives within `timeoutMs` — used to
 *  pin the "SSE change payloads exclude archived projects" requirement: a
 *  blocked (404'd) call against an archived project must never fire a store
 *  change, so no matching frame should ever surface on the stream. */
async function assertNoFrameMatching(
  sse: SseReader,
  predicate: (frame: ParsedFrame) => boolean,
  timeoutMs: number,
): Promise<void> {
  await expect(nextFrameMatching(sse, predicate, timeoutMs)).rejects.toThrow();
}

describe("archive / unarchive (CR-CRU-012 §S1b, cycle 26)", () => {
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

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  function archivePath(key: string): string {
    return `/api/v2/projects/${key}/archive`;
  }

  function unarchivePath(key: string): string {
    return `/api/v2/projects/${key}/unarchive`;
  }

  function parsedRunBody(agentId = "seed-agent") {
    return {
      agentId,
      summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
      tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 5 }] }],
    };
  }

  async function ingestEvent(projectKey: string, agentId = "seed-agent"): Promise<string> {
    const res = await postJson("/api/v2/runs/parsed", { projectKey, ...parsedRunBody(agentId) });
    const body = (await res.json()) as RunsPostResponse;
    return body.event;
  }

  async function bodyText(res: Response): Promise<string> {
    return JSON.stringify(await res.json());
  }

  // ── AC1 — archive/unarchive exclusion sweep + count equality ────────────
  describe("POST .../archive → exclusion sweep; .../unarchive → full restoration (AC1)", () => {
    test(
      "archive → 200, omitted from default projects list, events/agents excluded (empty); " +
        "?archived=true includes it; unarchive → restored everywhere with prior events intact (count equality)",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject("archive-sweep");

        // Seed activity BEFORE archiving: 3 events + 1 registered agent.
        const seededIds = [
          await ingestEvent(key, "agent-a"),
          await ingestEvent(key, "agent-a"),
          await ingestEvent(key, "agent-a"),
        ].sort();
        const regRes = await postJson("/api/v2/agents/register", {
          projectKey: key,
          agentId: "agent-a",
          // CR-CRU-044 §S1 — register now declares a phase.
          phase: "report",
        });
        expect(regRes.status).toBe(200);

        // Baseline BEFORE archiving.
        const eventsBefore = (await (
          await getJson(`/api/v2/events?project=${key}`)
        ).json()) as EventsListResponse;
        expect(eventsBefore.events.map((e) => e.id).sort()).toEqual(seededIds);

        const agentsBefore = (await (
          await getJson(`/api/v2/agents?project=${key}`)
        ).json()) as AgentsListResponse;
        expect(agentsBefore.agents.some((a) => a.agentId === "agent-a")).toBe(true);

        // ── archive ──
        const archiveRes = await postJson(archivePath(key), {});
        expect(archiveRes.status).toBe(200);
        const archiveBody = (await archiveRes.json()) as OkResponse;
        expect(archiveBody.ok).toBe(true);

        // Default projects listing omits it.
        const defaultList = (await (
          await getJson("/api/v2/projects")
        ).json()) as ProjectsListResponse;
        expect(defaultList.projects.some((p) => p.key === key)).toBe(false);

        // Events + agents listings for this project are empty while archived
        // (neither handler 404s on an unknown/excluded project — both just
        // filter to zero rows, per existing contract).
        const eventsWhileArchived = (await (
          await getJson(`/api/v2/events?project=${key}`)
        ).json()) as EventsListResponse;
        expect(eventsWhileArchived.events.length).toBe(0);

        const agentsWhileArchived = (await (
          await getJson(`/api/v2/agents?project=${key}`)
        ).json()) as AgentsListResponse;
        expect(agentsWhileArchived.agents.length).toBe(0);

        // Manager-only archived view includes it.
        const archivedList = (await (
          await getJson("/api/v2/projects?archived=true")
        ).json()) as ProjectsListResponse;
        expect(archivedList.projects.some((p) => p.key === key)).toBe(true);

        // ── unarchive ──
        const unarchiveRes = await postJson(unarchivePath(key), {});
        expect(unarchiveRes.status).toBe(200);
        const unarchiveBody = (await unarchiveRes.json()) as OkResponse;
        expect(unarchiveBody.ok).toBe(true);

        // Restored to the default listing.
        const defaultAfter = (await (
          await getJson("/api/v2/projects")
        ).json()) as ProjectsListResponse;
        expect(defaultAfter.projects.some((p) => p.key === key)).toBe(true);

        // Events restored — count equality + identical ids (never deleted).
        const eventsAfter = (await (
          await getJson(`/api/v2/events?project=${key}`)
        ).json()) as EventsListResponse;
        expect(eventsAfter.events.length).toBe(seededIds.length);
        expect(eventsAfter.events.map((e) => e.id).sort()).toEqual(seededIds);

        // Agents restored.
        const agentsAfter = (await (
          await getJson(`/api/v2/agents?project=${key}`)
        ).json()) as AgentsListResponse;
        expect(agentsAfter.agents.some((a) => a.agentId === "agent-a")).toBe(true);
      },
    );

    test("archived project's rollup is absent from GET /api/v2/projects (folded into the omission, not a separate surface)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("archive-rollup");
      await ingestEvent(key);

      const beforeArchive = (await (
        await getJson("/api/v2/projects")
      ).json()) as ProjectsListResponse;
      const before = beforeArchive.projects.find((p) => p.key === key);
      expect(before).toBeDefined();
      expect(before!.lastEvent).not.toBeNull(); // sanity: rollup was populated pre-archive

      await postJson(archivePath(key), {});

      const afterArchive = (await (
        await getJson("/api/v2/projects")
      ).json()) as ProjectsListResponse;
      expect(afterArchive.projects.some((p) => p.key === key)).toBe(false);
    });
  });

  // ── AC2 — agent API 404 with archived hint; no resurrection ─────────────
  describe("agent API calls against an archived project → 404 with an archived hint (AC2)", () => {
    test("POST /api/v2/agents/register against an archived project → 404, help[] mentions archived, and does NOT unarchive it", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("archived-register");
      await postJson(archivePath(key), {});

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "late-agent",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect(body.help!.some((h) => /archiv/i.test(h))).toBe(true);

      // Registration must NOT resurrect — still absent from the default
      // listing, still present in the archived-only listing.
      const defaultList = (await (
        await getJson("/api/v2/projects")
      ).json()) as ProjectsListResponse;
      expect(defaultList.projects.some((p) => p.key === key)).toBe(false);

      const archivedList = (await (
        await getJson("/api/v2/projects?archived=true")
      ).json()) as ProjectsListResponse;
      expect(archivedList.projects.some((p) => p.key === key)).toBe(true);

      // The rejected register call must not have created the agent either.
      const agents = (await (
        await getJson(`/api/v2/agents?project=${key}`)
      ).json()) as AgentsListResponse;
      expect(agents.agents.some((a) => a.agentId === "late-agent")).toBe(false);
    });

    test("POST /api/v2/runs/parsed against an archived project → 404, help[] mentions archived, and does NOT unarchive it", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("archived-runs");
      await postJson(archivePath(key), {});

      const res = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        ...parsedRunBody("late-runner"),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect(body.help!.some((h) => /archiv/i.test(h))).toBe(true);

      // Still archived afterwards (the ingest attempt did not resurrect it).
      const archivedList = (await (
        await getJson("/api/v2/projects?archived=true")
      ).json()) as ProjectsListResponse;
      expect(archivedList.projects.some((p) => p.key === key)).toBe(true);

      // No event was recorded for the rejected ingest.
      await postJson(unarchivePath(key), {});
      const events = (await (
        await getJson(`/api/v2/events?project=${key}`)
      ).json()) as EventsListResponse;
      expect(events.events.length).toBe(0);
    });
  });

  // ── SSE change payloads exclude archived-project activity ───────────────
  describe("SSE change payloads (§S1b spec pin — /api/stream)", () => {
    test("archiving a project fires a {type:'projects', projectKey} SSE frame (drives the manager's live badge removal)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("sse-archive-frame");

      const res = await fetch(`http://localhost:${handle.server.port}/api/stream`);
      const reader = res.body!.getReader();
      const sse = new SseReader(reader);
      await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

      const archiveRes = await postJson(archivePath(key), {});
      expect(archiveRes.status).toBe(200);

      const projectsFrame = await nextFrameMatching(
        sse,
        (f) => !f.isComment && f.data?.type === "projects" && f.data?.projectKey === key,
        1000,
      );
      expect(projectsFrame.data.type).toBe("projects");
      expect(projectsFrame.data.projectKey).toBe(key);

      await reader.cancel();
    });

    test("a blocked (404'd) ingest attempt against an archived project fires NO 'events' SSE frame for it within 300ms", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("sse-archived-blocked");
      await postJson(archivePath(key), {});

      const res = await fetch(`http://localhost:${handle.server.port}/api/stream`);
      const reader = res.body!.getReader();
      const sse = new SseReader(reader);
      await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

      const ingestRes = await postJson("/api/v2/runs/parsed", {
        projectKey: key,
        ...parsedRunBody("blocked-agent"),
      });
      expect(ingestRes.status).toBe(404); // rejected before any store mutation

      await assertNoFrameMatching(
        sse,
        (f) => !f.isComment && f.data?.type === "events" && f.data?.projectKey === key,
        300,
      );

      await reader.cancel();
    });
  });

  // ── v1 shim routes against an archived project ───────────────────────────
  // ESCALATION note (not a guess): the v1 shim's error shape (src/server.ts
  // `err()`) NEVER carries `help[]` — even its own unknown-project 404
  // (`validateProjectKey`) is a bare `{ok:false, error}`. Since the CR text
  // says the exclusion applies to "every internal query" and the shim routes
  // through the SAME store/requireProject-equivalent (`validateProjectKey`,
  // src/server.ts ~80), the safest non-inventive pin is: the shim 404s
  // exactly like it already does for an unknown project (no help[] added),
  // mirroring the shim's existing convention rather than importing v2's
  // help[] shape into a surface that has never had one. Flagging for the
  // orchestrator to confirm whether GREEN should also thread help[] through
  // the shim (a scope decision, not a RED-agent one).
  describe("v1 shim routes against an archived project (§S1b spec pin)", () => {
    test("POST /api/ingest/parsed against an archived project → 404 {ok:false, error} (shim's existing bare-error shape, no help[])", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("shim-archived");
      await postJson(archivePath(key), {});

      const res = await postJson("/api/ingest/parsed", {
        projectKey: key,
        agentId: "shim-agent",
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 5 },
        tree: [{ name: "s", status: "pass", children: [{ name: "t1", status: "pass", duration_ms: 5 }] }],
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");

      // The rejected shim ingest must not have resurrected the project.
      const archivedList = (await (
        await getJson("/api/v2/projects?archived=true")
      ).json()) as ProjectsListResponse;
      expect(archivedList.projects.some((p) => p.key === key)).toBe(true);
    });
  });

  // ── Idempotency convention ────────────────────────────────────────────────
  // Design choice (stated, not invented): this codebase's existing mutating
  // v2 endpoints are idempotent, not 400-on-repeat — duplicate
  // POST /api/v2/projects {key} → 200 {ok:true, changed:false}
  // (handleProjectCreate, src/v2.ts ~192), a repeat agent register →
  // 200 {ok:true, changed:false} (handleAgentTouch), and a repeat agent
  // unregister → 200 {ok:true, changed:false} (handleAgentUnregister). Every
  // v2 write response carries `changed:true|false` (file header, src/v2.ts:3).
  // Archive/unarchive are pinned to the SAME convention for consistency:
  // re-archiving an already-archived project, and un-archiving an
  // already-unarchived (never-archived) project, are each a 200 with
  // changed:false — NOT a 400.
  describe("archive/unarchive idempotency (design choice — matches the codebase's changed:boolean convention)", () => {
    test("archiving an already-archived project → 200 {ok:true, changed:false}, no-op", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("idempotent-archive");

      const first = await postJson(archivePath(key), {});
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as OkResponse;
      expect(firstBody.changed).toBe(true);

      const second = await postJson(archivePath(key), {});
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as OkResponse;
      expect(secondBody.ok).toBe(true);
      expect(secondBody.changed).toBe(false);
    });

    test("unarchiving a project that was never archived → 200 {ok:true, changed:false}, no-op", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("idempotent-unarchive");

      const res = await postJson(unarchivePath(key), {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(false);

      // Still visible in the default listing throughout (never touched archived state).
      const defaultList = (await (
        await getJson("/api/v2/projects")
      ).json()) as ProjectsListResponse;
      expect(defaultList.projects.some((p) => p.key === key)).toBe(true);
    });

    test("archive → unarchive → unarchive again is idempotent (second unarchive → changed:false)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("idempotent-round-trip");

      await postJson(archivePath(key), {});
      const firstUnarchive = await postJson(unarchivePath(key), {});
      expect(firstUnarchive.status).toBe(200);
      const firstBody = (await firstUnarchive.json()) as OkResponse;
      expect(firstBody.changed).toBe(true);

      const secondUnarchive = await postJson(unarchivePath(key), {});
      expect(secondUnarchive.status).toBe(200);
      const secondBody = (await secondUnarchive.json()) as OkResponse;
      expect(secondBody.changed).toBe(false);
    });
  });

  // ── Bad projectKey handling (mirrors requireProject's existing contract) ──
  describe("archive/unarchive against a non-existent project", () => {
    test("POST .../archive for an unknown (but well-formed UUID) key → 404", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const bogusKey = crypto.randomUUID();

      const res = await postJson(archivePath(bogusKey), {});
      expect(res.status).toBe(404);
      const text = await bodyText(res);
      expect(text).toMatch(/unknown project/i);
    });

    test("POST .../unarchive for an unknown (but well-formed UUID) key → 404", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const bogusKey = crypto.randomUUID();

      const res = await postJson(unarchivePath(bogusKey), {});
      expect(res.status).toBe(404);
      const text = await bodyText(res);
      expect(text).toMatch(/unknown project/i);
    });
  });
});
