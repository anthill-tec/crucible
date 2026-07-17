// CR-CRU-012 §S1 — PATCH /api/v2/projects/<key> (additive), cycle 25. RED phase.
//
// Spec (verbatim, §S1): "Editable fields: name, type (backend|frontend),
// sutRoot, per-project liveness overrides {t1_ms, t2_ms, t3_ms}, retention
// (max runs). Unknown fields → 400 naming the field; invalid type → 400
// naming type; projectKey is immutable — a body attempting to change it →
// 400 naming projectKey. Successful PATCH emits the projects SSE change
// event. Shim untouched (no v1 equivalent)."
//
// The three §S1 ACs pinned here (verbatim from the AC list):
// - "PATCH /api/v2/projects/<key> {name:"NAI-2"} → 200; GET /api/v2/projects
//   shows name:"NAI-2"; an SSE projects change event was emitted (assert via
//   stream capture)."
// - "PATCH with {type:"desktop"} → 400 with error naming type; with
//   {projectKey:"other"} → 400 naming projectKey; with an unknown field
//   {foo:1} → 400 naming foo; stored project unchanged after each."
// - "PATCH with {liveness:{t1_ms:120000}} → subsequent liveness computation
//   for that project uses T1=120 s (agent silent 90 s reads online, not
//   stale); other projects keep defaults."
//
// ── Gap-analysis findings (stated, not guessed) ─────────────────────────
//
// 1. LIVENESS SHAPE: the store's internal Project#liveness is
//    Partial<LivenessConfig> = Partial<{staleAfterMs, tombstoneAfterMs,
//    pruneAfterMs}> (src/types.ts) — camelCase *Ms fields, NOT t1_ms/t2_ms/
//    t3_ms. Store#livenessConfig(projectKey) merges DEFAULT_LIVENESS
//    {staleAfterMs:60_000, tombstoneAfterMs:300_000, pruneAfterMs:3_600_000}
//    over the stored partial (tests/liveness.test.ts pins this exactly).
//    T1/T2/T3 in the spec text map 1:1 to staleAfterMs/tombstoneAfterMs/
//    pruneAfterMs (T1 is the online→stale threshold, matching the AC's
//    "silent 90s reads online, not stale" against a T1=120s override).
//    GREEN must translate the wire body {liveness:{t1_ms,t2_ms,t3_ms}} into
//    that internal shape and MERGE it (not replace) with any existing
//    override, so a t1_ms-only patch leaves t2_ms/t3_ms at their DEFAULTS
//    (not blown away) — pinned below by asserting the tombstone boundary
//    (T2=300s default) still holds after a t1_ms-only PATCH.
//
// 2. sutRoot WIRE FIELD: handleProjectCreate (src/v2.ts, POST /api/v2/projects)
//    reads `body.sutRoot` (camelCase) — NOT `sut_root`. PATCH is pinned to
//    the SAME camelCase wire field for consistency with the existing create
//    contract.
//
// 3. ARCHIVED-PROJECT GATE: requireProject (src/v2.ts) already 404s an
//    archived project with `help: hints.archivedProject` for every
//    project-scoped agent/run route. The manager's archived view only
//    offers "unarchive" as an action (§S2) — there is no archived-project
//    edit-in-place surface. For consistency with requireProject's existing
//    contract (and so the manager's only path to editing an archived
//    project is unarchive-then-edit), PATCH on an archived project is
//    pinned to 404 with the SAME archived hint — NOT 200 (silent edit of a
//    project the rest of the system already treats as invisible).
//
// 4. EMPTY BODY: this codebase's write endpoints uniformly answer
//    "nothing changed" with 200 {ok:true, changed:false} rather than 400
//    (duplicate POST /api/v2/projects → changed:false, repeat
//    archive/unarchive → changed:false — see tests/project-archive.test.ts's
//    idempotency block, and the file header of src/v2.ts: "Every write res
//    carries changed: true|false"). An empty PATCH body {} names no field
//    to reject and changes nothing, so it is pinned to the SAME
//    convention: 200 {ok:true, changed:false}, NOT 400.
//
// 5. RETENTION TAKES EFFECT ON NEXT INGEST (not retroactively): Store's
//    enforceRetention (src/store.ts ~863) is invoked ONLY from
//    recordTestEvent, reading `getProject(key)?.retention` fresh each call.
//    A PATCH that lowers retention does not itself prune existing rows —
//    the cap applies starting with the NEXT ingested event. Pinned below
//    using the same retention-forcing technique as
//    tests/events.test.ts's "Store — per-project retention override (§S4)".
//
// Drives the REAL production server (startServer), same harness pattern as
// tests/project-archive.test.ts (SSE capture via SseReader).
import { describe, test, expect, afterEach } from "bun:test";
import { setSystemTime } from "bun:test";
import { startServer } from "../src/server.ts";

type ServerHandle = ReturnType<typeof startServer>;

interface OkResponse {
  ok: true;
  changed?: boolean;
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
  type: string;
  sutRoot: string;
  retention?: number;
  liveness?: Record<string, number>;
  [key: string]: unknown;
}

interface ProjectsListResponse extends OkResponse {
  projects: ProjectBrief[];
}

interface EventsListResponse extends OkResponse {
  events: { id: string; [key: string]: unknown }[];
}

interface AgentBrief {
  agentId: string;
  projectKey: string;
  liveness: "online" | "stale" | "tombstoned";
  [key: string]: unknown;
}

interface AgentsListResponse extends OkResponse {
  agents: AgentBrief[];
}

// ── SSE frame reading helpers (same technique as tests/project-archive.test.ts) ──

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

  // Untyped on purpose, mirroring tests/project-archive.test.ts's SseReader
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

describe("PATCH /api/v2/projects/<key> (CR-CRU-012 §S1, cycle 25)", () => {
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    setSystemTime(); // reset the injected clock so it never leaks to other files
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

  async function getJson(path: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`);
  }

  async function createProject(
    name: string,
    extra?: { type?: string; sutRoot?: string },
  ): Promise<string> {
    const res = await postJson("/api/v2/projects", { name, ...(extra ?? {}) });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  function patchPath(key: string): string {
    return `/api/v2/projects/${key}`;
  }

  async function findProject(key: string): Promise<ProjectBrief | undefined> {
    const list = (await (await getJson("/api/v2/projects")).json()) as ProjectsListResponse;
    return list.projects.find((p) => p.key === key);
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
    const body = (await res.json()) as OkResponse & { event: string };
    return body.event;
  }

  describe("AC1 — name PATCH → 200; GET reflects it; SSE projects change event fires", () => {
    test(
      'PATCH {name:"NAI-2"} → 200; GET /api/v2/projects shows name:"NAI-2"; ' +
        "a {type:'projects', projectKey} SSE frame was emitted",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject("original-name");

        const res = await fetch(`http://localhost:${handle.server.port}/api/stream`);
        const reader = res.body!.getReader();
        const sse = new SseReader(reader);
        await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

        const patchRes = await patchJson(patchPath(key), { name: "NAI-2" });
        expect(patchRes.status).toBe(200);
        const patchBody = (await patchRes.json()) as OkResponse;
        expect(patchBody.ok).toBe(true);
        expect(patchBody.changed).toBe(true);

        const project = await findProject(key);
        expect(project?.name).toBe("NAI-2");

        const projectsFrame = await nextFrameMatching(
          sse,
          (f) => !f.isComment && f.data?.type === "projects" && f.data?.projectKey === key,
          1000,
        );
        expect(projectsFrame.data.type).toBe("projects");
        expect(projectsFrame.data.projectKey).toBe(key);

        await reader.cancel();
      },
    );

    test("PATCH {type:\"frontend\"} on a backend project → 200; GET reflects the new type (editable-field happy path)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("type-flip", { type: "backend" });

      const before = await findProject(key);
      expect(before?.type).toBe("backend");

      const patchRes = await patchJson(patchPath(key), { type: "frontend" });
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as OkResponse;
      expect(patchBody.changed).toBe(true);

      const after = await findProject(key);
      expect(after?.type).toBe("frontend");
    });

    test("PATCH {sutRoot:\"/new/sut/root\"} → 200; GET reflects the camelCase sutRoot field (matches POST's existing wire contract)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("sutroot-patch", { sutRoot: "/orig/root" });

      const before = await findProject(key);
      expect(before?.sutRoot).toBe("/orig/root");

      const patchRes = await patchJson(patchPath(key), { sutRoot: "/new/sut/root" });
      expect(patchRes.status).toBe(200);

      const after = await findProject(key);
      expect(after?.sutRoot).toBe("/new/sut/root");
    });
  });

  describe("AC2 — invalid type / immutable projectKey / unknown field → 400 naming the field; stored project unchanged", () => {
    test('PATCH {type:"desktop"} → 400 naming type; project unchanged', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("ac2-type", { type: "backend", sutRoot: "/orig" });

      const res = await patchJson(patchPath(key), { type: "desktop" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.toLowerCase()).toContain("type");

      const project = await findProject(key);
      expect(project?.type).toBe("backend");
      expect(project?.name).toBe("ac2-type");
      expect(project?.sutRoot).toBe("/orig");
    });

    test('PATCH {projectKey:"other"} → 400 naming projectKey (the key is immutable); project unchanged', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("ac2-projectkey", { type: "backend", sutRoot: "/orig" });

      const res = await patchJson(patchPath(key), { projectKey: "other" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.toLowerCase()).toContain("projectkey");

      const project = await findProject(key);
      expect(project?.key).toBe(key);
      expect(project?.name).toBe("ac2-projectkey");
      expect(project?.type).toBe("backend");
      expect(project?.sutRoot).toBe("/orig");
    });

    test('PATCH {foo:1} → 400 naming foo (unknown field); project unchanged', async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("ac2-unknown", { type: "backend", sutRoot: "/orig" });

      const res = await patchJson(patchPath(key), { foo: 1 });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.toLowerCase()).toContain("foo");

      const project = await findProject(key);
      expect(project?.name).toBe("ac2-unknown");
      expect(project?.type).toBe("backend");
      expect(project?.sutRoot).toBe("/orig");
    });

    test("an unknown field alongside otherwise-valid fields still 400s naming that field (no partial apply)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("ac2-partial-mix", { type: "backend", sutRoot: "/orig" });

      const res = await patchJson(patchPath(key), { name: "should-not-apply", bogus: true });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrResponse;
      expect(body.error.toLowerCase()).toContain("bogus");

      // The valid `name` field in the SAME body must not have been applied
      // either — an unknown field rejects the whole PATCH, not just itself.
      const project = await findProject(key);
      expect(project?.name).toBe("ac2-partial-mix");
    });
  });

  describe("AC3 — liveness override {t1_ms} changes T1 for that project only; t2/t3 stay default", () => {
    test(
      "PATCH {liveness:{t1_ms:120000}} → agent silent 90s reads online (not stale) on the " +
        "patched project; an untouched sibling project's agent at the same silence reads stale (default T1=60s)",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const T0 = 1_700_000_000_000;
        setSystemTime(T0);

        const overriddenKey = await createProject("liveness-override");
        const defaultKey = await createProject("liveness-default");

        const patchRes = await patchJson(patchPath(overriddenKey), {
          liveness: { t1_ms: 120_000 },
        });
        expect(patchRes.status).toBe(200);
        const patchBody = (await patchRes.json()) as OkResponse;
        expect(patchBody.changed).toBe(true);

        await postJson("/api/v2/agents/register", { projectKey: overriddenKey, agentId: "a1" });
        await postJson("/api/v2/agents/register", { projectKey: defaultKey, agentId: "b1" });

        setSystemTime(T0 + 90_000); // 90s of silence

        const overriddenAgents = (await (
          await getJson(`/api/v2/agents?project=${overriddenKey}`)
        ).json()) as AgentsListResponse;
        expect(overriddenAgents.agents.find((a) => a.agentId === "a1")?.liveness).toBe("online");

        const defaultAgents = (await (
          await getJson(`/api/v2/agents?project=${defaultKey}`)
        ).json()) as AgentsListResponse;
        expect(defaultAgents.agents.find((a) => a.agentId === "b1")?.liveness).toBe("stale");
      },
    );

    test(
      "a t1_ms-only PATCH leaves t2_ms/t3_ms at their DEFAULTS (partial-override merge, not replace): " +
        "at 200s silence — past the overridden T1=120s but under the default T2=300s — the agent " +
        "reads stale, NOT tombstoned (a bug that copies t1_ms into tombstoneAfterMs too would " +
        "incorrectly read tombstoned here)",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const T0 = 1_700_000_000_000;
        setSystemTime(T0);

        const key = await createProject("liveness-partial-merge");
        const patchRes = await patchJson(patchPath(key), { liveness: { t1_ms: 120_000 } });
        expect(patchRes.status).toBe(200);
        await postJson("/api/v2/agents/register", { projectKey: key, agentId: "a1" });

        setSystemTime(T0 + 200_000); // past overridden T1 (120s), under default T2 (300s)

        const agents = (await (
          await getJson(`/api/v2/agents?project=${key}`)
        ).json()) as AgentsListResponse;
        expect(agents.agents.find((a) => a.agentId === "a1")?.liveness).toBe("stale");
      },
    );
  });

  describe("retention PATCH takes effect starting with the next ingest (not retroactively)", () => {
    test(
      "PATCH {retention:2} does not prune existing rows immediately; the NEXT ingest enforces the " +
        "lower cap, leaving only the 2 newest events",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const key = await createProject("retention-patch");

        const e1 = await ingestEvent(key, "a1");
        const e2 = await ingestEvent(key, "a1");
        const e3 = await ingestEvent(key, "a1");

        const beforePatch = (await (
          await getJson(`/api/v2/events?project=${key}`)
        ).json()) as EventsListResponse;
        expect(beforePatch.events.length).toBe(3);

        const patchRes = await patchJson(patchPath(key), { retention: 2 });
        expect(patchRes.status).toBe(200);

        // No retroactive pruning from the PATCH itself.
        const rightAfterPatch = (await (
          await getJson(`/api/v2/events?project=${key}`)
        ).json()) as EventsListResponse;
        expect(rightAfterPatch.events.length).toBe(3);

        // The next ingest enforces the new cap of 2.
        const e4 = await ingestEvent(key, "a1");

        const afterNextIngest = (await (
          await getJson(`/api/v2/events?project=${key}`)
        ).json()) as EventsListResponse;
        expect(afterNextIngest.events.length).toBe(2);
        // Newest-first listing: the 2 survivors are the two most recently ingested.
        expect(afterNextIngest.events.map((e) => e.id).sort()).toEqual([e3, e4].sort());
        expect(afterNextIngest.events.map((e) => e.id)).not.toContain(e1);
        expect(afterNextIngest.events.map((e) => e.id)).not.toContain(e2);
      },
    );
  });

  describe("PATCH on an archived project → 404 with the archived hint (consistent with requireProject's existing gate)", () => {
    test("PATCH {name:...} against an archived project → 404, help[] mentions archived; stored project unchanged", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("archived-patch-target", { type: "backend", sutRoot: "/orig" });

      const archiveRes = await postJson(`/api/v2/projects/${key}/archive`, {});
      expect(archiveRes.status).toBe(200);

      const res = await patchJson(patchPath(key), { name: "should-not-apply" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(Array.isArray(body.help)).toBe(true);
      expect(body.help!.some((h) => /archiv/i.test(h))).toBe(true);

      // Still archived, and the name in the archived-only listing is unchanged.
      const archivedList = (await (
        await getJson("/api/v2/projects?archived=true")
      ).json()) as ProjectsListResponse;
      const project = archivedList.projects.find((p) => p.key === key);
      expect(project).toBeDefined();
      expect(project!.name).toBe("archived-patch-target");
    });
  });

  describe("PATCH on an unknown key → 404", () => {
    test("PATCH against a well-formed but non-existent UUID key → 404", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const bogusKey = crypto.randomUUID();

      const res = await patchJson(patchPath(bogusKey), { name: "x" });
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/unknown project/i);
    });
  });

  describe("empty body PATCH → 200 {ok:true, changed:false} no-op (design choice — matches the codebase's changed:boolean convention)", () => {
    test("PATCH {} → 200, changed:false, project completely unchanged", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("empty-patch", { type: "backend", sutRoot: "/orig" });

      const res = await patchJson(patchPath(key), {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
      expect(body.changed).toBe(false);

      const project = await findProject(key);
      expect(project?.name).toBe("empty-patch");
      expect(project?.type).toBe("backend");
      expect(project?.sutRoot).toBe("/orig");
    });
  });

  describe("shim untouched (no v1 equivalent)", () => {
    test("PATCH /api/ingest/projects/<key> (v1 path shape) is not a route — 404, not a v1 project-edit success", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("shim-untouched");

      const res = await fetch(`http://localhost:${handle.server.port}/api/ingest/projects/${key}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "shim-should-not-edit" }),
      });
      expect(res.status).toBe(404);

      const project = await findProject(key);
      expect(project?.name).toBe("shim-untouched");
    });
  });
});
