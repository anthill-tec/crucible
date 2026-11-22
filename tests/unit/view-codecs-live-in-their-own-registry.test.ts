// View codecs live in a registry of their own, beside the report codecs
// (CR-CRU-201 §S1, AC1). A view codec fills an open run's live state from its
// held stream and is never the run's record.
//
// What is held here:
//  - the registry: `viewCodecs` (src/codecs/index.ts) holds `bun-console`, a
//    view codec stating its name and one method, `fill`, and no `parse`; the
//    report registry `codecs` does not hold it;
//  - health: `codecs.view` names `bun-console`; `codecs.test` and
//    `codecs.coverage` are what they were, and no other list is added;
//  - the refusals: `bun-console`, which the stream route takes as a view
//    stream, is unknown to every report route — sent as a body report, a raw
//    report (`dataPath`), or as a close's codec, it is a 400 naming it as an
//    unknown codec, nothing stored and the run left open.
//
// INTERFACE CHOICES (the spec leaves them open; named here for the ruling):
//  - the registry is exported as `viewCodecs: Map<string, ViewCodec>` from
//    src/codecs/index.ts, keyed by the codec's name;
//  - a `ViewCodec` is `{ name: string; fill(...): ... }` — see
//    tests/integration/the-bun-console-codec-reads-bun-console-into-the-live-state.test.ts
//    for the `fill` signature;
//  - health's list is `codecs.view`, sorted, as `codecs.test` is.
//
// The registry is read through the module namespace, so a missing export
// fails each test on its own assertion rather than failing the file's import.
//
// SAFETY: every board is in process (no socket) on ":memory:".
import { describe, test, expect, afterEach } from "bun:test";
import * as codecIndex from "../../src/codecs/index.ts";
import { codecs } from "../../src/codecs/index.ts";
import type { BoardHandle } from "../../src/server.ts";
import {
  bootInProcess,
  getJson,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  utf8,
  type Answer,
} from "../helpers/run-stream-harness.ts";
import { PLAIN_RUN } from "../fixtures/bun-console-live-captures.ts";

const handles: BoardHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): BoardHandle {
  const handle = bootInProcess();
  handles.push(handle);
  return handle;
}

/** The view codec this CR registers. */
const VIEW_CODEC = "bun-console";

/** A view codec as the registry holds it (the chosen interface). */
interface ViewCodecShape {
  name?: unknown;
  fill?: unknown;
  parse?: unknown;
}

/** `viewCodecs` off the module namespace — undefined while it is not exported. */
function viewCodecs(): Map<string, ViewCodecShape> | undefined {
  return (codecIndex as unknown as { viewCodecs?: Map<string, ViewCodecShape> }).viewCodecs;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("bun-console is a view codec, held in the view registry and not in the report registry", () => {
  test("viewCodecs holds exactly bun-console then surefire-console, bun-console a codec stating its name and a fill method and no parse", () => {
    const registry = viewCodecs();
    expect(registry instanceof Map, "src/codecs/index.ts exports a viewCodecs Map").toBe(true);
    expect([...(registry?.keys() ?? [])]).toEqual([VIEW_CODEC, "surefire-console"]);
    const codec = registry?.get(VIEW_CODEC);
    expect(codec?.name).toBe(VIEW_CODEC);
    expect(typeof codec?.fill).toBe("function");
    expect(codec).not.toHaveProperty("parse");
  });

  test("the report registry does not hold bun-console, and holds exactly junit, crucible-events, go-test and nextest", () => {
    expect(viewCodecs()?.has(VIEW_CODEC)).toBe(true);
    expect(codecs.has(VIEW_CODEC)).toBe(false);
    expect([...codecs.keys()].sort()).toEqual(["crucible-events", "go-test", "junit", "nextest"]);
  });
});

describe("health lists the view codecs under codecs.view", () => {
  for (const route of ["/api/health", "/api/v2/health"]) {
    test(`GET ${route} carries codecs {test, coverage} as before, view: [bun-console, surefire-console] and stream: [crucible-events, go-test, nextest], and no other list`, async () => {
      const body = await getJson(boot(), route);
      expect(body.ok).toBe(true);
      expect(body.codecs).toEqual({
        test: ["crucible-events", "go-test", "junit", "nextest"],
        coverage: ["go-coverprofile", "jacoco", "lcov"],
        view: ["bun-console", "surefire-console"],
        stream: ["crucible-events", "go-test", "nextest"],
      });
    });
  }
});

// ── The refusals ────────────────────────────────────────────────────────────

const AGENT = "view-refused";

interface Subject {
  handle: BoardHandle;
  key: string;
  runId: string;
}

/** An open run that holds a bun-console view stream: the route takes it first, so a refusal below is about the report routes. */
async function viewStreamingRun(): Promise<Subject> {
  const handle = boot();
  const key = await readyProject(handle, [AGENT], "view-refusals");
  const runId = await openRun(handle, key, AGENT, { stack: "bun", tier: "unit" });
  const head = PLAIN_RUN.slice(0, PLAIN_RUN.indexOf("(skip)"));
  const res = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, from: 0, data: head, codec: VIEW_CODEC });
  expect(res.status, `the view stream batch: ${JSON.stringify(res.body)}`).toBe(200);
  expect(res.body.held).toBe(utf8(head));
  return { handle, key, runId };
}

function eventIds(s: Subject): string[] {
  return s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).map((e) => e.id);
}

/** A 400 naming bun-console as an unknown codec, nothing stored, the run still open. */
function expectUnknownCodec(s: Subject, res: Answer, before: string[]): void {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body.ok).toBe(false);
  expect(String(res.body.error)).toContain(`unknown codec: ${VIEW_CODEC}`);
  expect(eventIds(s)).toEqual(before);
  expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
}

describe("bun-console, taken by the stream route as a view stream, is unknown to every report route", () => {
  test("sent as a body report (`data`) on POST /api/v2/runs: a 400 naming it an unknown codec, nothing stored", async () => {
    const s = await viewStreamingRun();
    const before = eventIds(s);
    const res = await postJson(s.handle, "/api/v2/runs", {
      projectKey: s.key,
      agentId: AGENT,
      codec: VIEW_CODEC,
      data: PLAIN_RUN,
    });
    expectUnknownCodec(s, res, before);
  });

  test("sent as a raw report (`dataPath`) on POST /api/v2/runs: a 400 naming it an unknown codec, nothing stored", async () => {
    const s = await viewStreamingRun();
    const before = eventIds(s);
    const res = await postJson(s.handle, "/api/v2/runs", {
      projectKey: s.key,
      agentId: AGENT,
      codec: VIEW_CODEC,
      dataPath: "/tmp/no-such-bun-console.log",
    });
    expectUnknownCodec(s, res, before);
  });

  test("named as the close's codec for the run holding its view stream: a 400 naming it an unknown codec, the run left open", async () => {
    const s = await viewStreamingRun();
    const before = eventIds(s);
    const res = await postJson(s.handle, "/api/v2/runs", {
      projectKey: s.key,
      agentId: AGENT,
      runId: s.runId,
      codec: VIEW_CODEC,
    });
    expectUnknownCodec(s, res, before);
    // The view stream is still held: the live state was not touched by the refusal.
    expect(s.handle.store.runLive(s.runId)?.completed).toBe(2);
  });
});
