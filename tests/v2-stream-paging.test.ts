// CR-CRU-004 §S3 (SSE `GET /api/stream`) + §S4 (progressive event detail via
// `GET /api/v2/events/:id?depth=suites|?suite=<name>`) — RED phase.
// Drives the REAL production server (startServer) — /api/stream does not
// exist yet (falls through server.ts's `unknown route` catch-all) and
// handleEventGet in src/v2.ts does not yet look at ?depth=/?suite= (RED
// phase), so these fail until GREEN wires them.
//
// SSE reads use fetch() + a raw ReadableStreamDefaultReader<Uint8Array> +
// TextDecoder, buffered into blank-line-terminated SSE frames, each bounded
// by an explicit deadline (see SseReader/nextFrameMatching below) so a
// missing or stalled stream fails the assertion instead of hanging the run.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { RunSummary, SuiteNode } from "../src/types.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

interface RunsPostResponse extends OkResponse {
  changed: boolean;
  event: string;
  verdict: string;
}

interface EventGetResponse extends OkResponse {
  event: {
    id: string;
    tree?: unknown;
    [key: string]: unknown;
  };
}

// ── SSE frame reading helpers ───────────────────────────────────────────

interface ParsedFrame {
  raw: string;
  isComment: boolean;
  // SSE payload shape varies per frame type ("hello" | "events" | "agents" | "projects").
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

/**
 * Buffers a byte stream into blank-line-terminated SSE frames. Every read is
 * bounded by an absolute deadline (ms since epoch) so a stalled or missing
 * stream fails the assertion instead of hanging the test run.
 */
class SseReader {
  private buf = "";
  private readonly decoder = new TextDecoder();

  // Untyped on purpose — bun-types and node:stream/web both declare a global
  // `ReadableStreamDefaultReader` and `res.body!.getReader()` resolves to
  // whichever one doesn't structurally match the other's Bun-specific
  // `readMany` member; `any` sidesteps that lib-ambiguity in this test helper.
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

/** Deadline-polls `predicate` instead of a fixed sleep, for async server-side
 *  effects (e.g. unsubscribe-on-disconnect) whose exact timing isn't fixed. */
async function pollUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await Bun.sleep(intervalMs);
  }
}

// 2-case, all-pass junit fixture — used to trigger a v1-route ingest.
const JUNIT_ALLPASS = [
  '<testsuite name="Suite1" tests="2">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  "</testsuite>",
].join("\n");

// 3-suite tree w/ one failing leaf (failure.message) — §S4 progressive paging fixture.
const THREE_SUITE_TREE: SuiteNode[] = [
  {
    name: "SuiteA",
    status: "pass",
    children: [
      { name: "a1", status: "pass", duration_ms: 10 },
      { name: "a2", status: "pass", duration_ms: 10 },
    ],
  },
  {
    name: "SuiteB",
    status: "fail",
    children: [
      { name: "b1", status: "pass", duration_ms: 10 },
      {
        name: "b2",
        status: "fail",
        duration_ms: 15,
        failure: { message: "boom-b2" },
      },
    ],
  },
  {
    name: "SuiteC",
    status: "pass",
    children: [{ name: "c1", status: "pass", duration_ms: 5 }],
  },
];

const THREE_SUITE_SUMMARY: RunSummary = {
  total: 5,
  passed: 4,
  failed: 1,
  pending: 0,
  duration_ms: 50,
};

describe("SSE + progressive event paging (CR-CRU-004 §S3+§S4)", () => {
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

  async function seedThreeSuiteEvent(projectKey: string): Promise<string> {
    const res = await postJson("/api/v2/runs/parsed", {
      projectKey,
      agentId: "paging-agent",
      summary: THREE_SUITE_SUMMARY,
      tree: THREE_SUITE_TREE,
    });
    const body = (await res.json()) as RunsPostResponse;
    return body.event;
  }

  // ---------------------------------------------------------------------
  // §S3 SSE — GET /api/stream
  // ---------------------------------------------------------------------
  describe("GET /api/stream", () => {
    test("first frame within 1s is data: {type:'hello', version:<string>}", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await fetch(`http://localhost:${handle.server.port}/api/stream`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

      const reader = res.body!.getReader();
      const sse = new SseReader(reader);
      const frame = await nextFrameMatching(sse, () => true, 1000);

      expect(frame.isComment).toBe(false);
      expect(frame.data).toBeDefined();
      expect(frame.data.type).toBe("hello");
      expect(typeof frame.data.version).toBe("string");

      await reader.cancel();
    });

    test("an ingest via a v1 route (/api/ingest) produces a {type:'events', projectKey} frame within 1s", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("stream-events");

      const res = await fetch(`http://localhost:${handle.server.port}/api/stream`);
      const reader = res.body!.getReader();
      const sse = new SseReader(reader);
      // Consume the hello frame first so we don't accidentally match on it.
      await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

      const ingestRes = await postJson("/api/ingest", {
        projectKey: key,
        agentId: "v1-ingest-agent",
        format: "junit",
        data: JUNIT_ALLPASS,
      });
      expect(ingestRes.status).toBe(200);

      const eventsFrame = await nextFrameMatching(
        sse,
        (f) => !f.isComment && f.data?.type === "events",
        1000,
      );
      expect(eventsFrame.data.type).toBe("events");
      expect(eventsFrame.data.projectKey).toBe(key);

      await reader.cancel();
    });

    test("a heartbeat (POST /api/v2/agents/heartbeat) produces a {type:'agents', ...} frame", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("stream-agents");

      const res = await fetch(`http://localhost:${handle.server.port}/api/stream`);
      const reader = res.body!.getReader();
      const sse = new SseReader(reader);
      await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

      const hbRes = await postJson("/api/v2/agents/heartbeat", {
        projectKey: key,
        agentId: "hb-agent",
      });
      expect(hbRes.status).toBe(200);

      const agentsFrame = await nextFrameMatching(
        sse,
        (f) => !f.isComment && f.data?.type === "agents",
        1000,
      );
      expect(agentsFrame.data.type).toBe("agents");
      expect(agentsFrame.data.projectKey).toBe(key);

      await reader.cancel();
    });

    test(
      "a comment keep-alive line (starting ':') arrives within 17s of silence",
      async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });

        const res = await fetch(`http://localhost:${handle.server.port}/api/stream`);
        const reader = res.body!.getReader();
        const sse = new SseReader(reader);
        await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

        // No ingest/heartbeat activity here — wait purely for the periodic keep-alive.
        const keepAlive = await nextFrameMatching(sse, (f) => f.isComment, 17000);
        expect(keepAlive.isComment).toBe(true);
        expect(keepAlive.raw.startsWith(":")).toBe(true);

        await reader.cancel();
      },
      20000,
    );

    test("disconnect (AbortController.abort()) unsubscribes: store.listenerCount() returns to its pre-connection value; a subsequent ingest does not throw server-side", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("stream-unsub");
      const baseline = handle.store.listenerCount();

      // Bun 1.3.14's fetch does not propagate reader.cancel() to the server
      // socket (oven-sh/bun#5039 — confirmed via GREEN's control probes: raw
      // TCP end() and AbortController.abort() both fire the server-side abort
      // hook in ~12-100ms, reader.cancel() never does). Disconnect via an
      // AbortController signal instead — that's what src/server.ts's
      // `req.signal.addEventListener("abort", ...)` actually observes.
      const controller = new AbortController();
      const res = await fetch(`http://localhost:${handle.server.port}/api/stream`, {
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const sse = new SseReader(reader);
      await nextFrameMatching(sse, (f) => !f.isComment && f.data?.type === "hello", 1000);

      // Establishing the connection must have registered exactly one listener.
      expect(handle.store.listenerCount()).toBe(baseline + 1);

      controller.abort();
      // Best-effort local cleanup alongside the abort signal under test —
      // the reader may already be errored/closed once the signal fires.
      await reader.cancel().catch(() => {});

      // The abort → server-side unsubscribe hop is async; deadline-poll
      // (bounded ≤1s) rather than assuming a fixed settle time.
      await pollUntil(() => handle!.store.listenerCount() === baseline, 1000);
      expect(handle.store.listenerCount()).toBe(baseline);

      // A subsequent ingest must not throw server-side (no dangling/broken listener).
      const ingestRes = await postJson("/api/ingest", {
        projectKey: key,
        agentId: "post-disconnect-agent",
        format: "junit",
        data: JUNIT_ALLPASS,
      });
      expect(ingestRes.status).toBe(200);
      const ingestBody = (await ingestRes.json()) as OkResponse;
      expect(ingestBody.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // §S4 GET /api/v2/events/:id?depth=suites | ?suite=<name>
  // ---------------------------------------------------------------------
  describe("GET /api/v2/events/:id — progressive detail", () => {
    test("?depth=suites → tree nodes reduced to {name, status, counts:{passed,failed,pending}}, no children key", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("paging-depth");
      const id = await seedThreeSuiteEvent(key);

      const res = await getJson(`/api/v2/events/${id}?depth=suites`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as EventGetResponse;
      expect(body.ok).toBe(true);
      const tree = body.event.tree as Array<Record<string, unknown>>;
      expect(Array.isArray(tree)).toBe(true);
      expect(tree.length).toBe(3);
      for (const node of tree) {
        expect(typeof node.name).toBe("string");
        expect(typeof node.status).toBe("string");
        expect("children" in node).toBe(false);
        const counts = node.counts as { passed: number; failed: number; pending: number };
        expect(typeof counts.passed).toBe("number");
        expect(typeof counts.failed).toBe("number");
        expect(typeof counts.pending).toBe("number");
      }
      const suiteB = tree.find((n) => n.name === "SuiteB")!;
      expect(suiteB.counts).toEqual({ passed: 1, failed: 1, pending: 0 });
      const suiteA = tree.find((n) => n.name === "SuiteA")!;
      expect(suiteA.counts).toEqual({ passed: 2, failed: 0, pending: 0 });
      const suiteC = tree.find((n) => n.name === "SuiteC")!;
      expect(suiteC.counts).toEqual({ passed: 1, failed: 0, pending: 0 });
    });

    test("?suite=SuiteB → that suite's full leaves, including failure.message on the failing one", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("paging-suite");
      const id = await seedThreeSuiteEvent(key);

      const res = await getJson(`/api/v2/events/${id}?suite=SuiteB`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as EventGetResponse;
      expect(body.ok).toBe(true);
      const tree = body.event.tree as Array<{ name: string; children?: unknown[] }>;
      expect(Array.isArray(tree)).toBe(true);
      // Scoped to just the requested suite (not the full 3-suite tree).
      expect(tree.map((n) => n.name)).toEqual(["SuiteB"]);
      const suiteB = tree[0]!;
      const children = suiteB.children as Array<{
        name: string;
        status: string;
        failure?: { message: string };
      }>;
      expect(children.length).toBe(2);
      const b2 = children.find((c) => c.name === "b2")!;
      expect(b2.status).toBe("fail");
      expect(b2.failure?.message).toBe("boom-b2");
      const b1 = children.find((c) => c.name === "b1")!;
      expect(b1.status).toBe("pass");
    });

    test("?suite=<unknown> → 404", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("paging-suite-404");
      const id = await seedThreeSuiteEvent(key);

      const res = await getJson(`/api/v2/events/${id}?suite=NoSuchSuite`);

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
    });

    test("no params (default) → unchanged full tree (regression guard)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("paging-default");
      const id = await seedThreeSuiteEvent(key);

      const res = await getJson(`/api/v2/events/${id}`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as EventGetResponse;
      expect(body.ok).toBe(true);
      expect(body.event.tree).toEqual(THREE_SUITE_TREE);
    });
  });
});
