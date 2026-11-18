// The board takes a nextest stream as a record stream codec — on a real
// server (`startServer`, port 0, ":memory:"):
//  - a batch naming the `nextest` codec is accepted on an open run (200), the
//    bytes held answered as for any stream;
//  - health lists `nextest` under `codecs.test` and `codecs.stream`, on both
//    health routes;
//  - a run whose first batch fixed `nextest` refuses a `crucible-events`
//    batch (400), and holds nothing more, as any stream refuses a second codec.
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../../src/server.ts";
import {
  NEXTEST_CODEC,
  suiteStarted,
  testName,
  testOk,
  testStarted,
} from "../helpers/nextest-harness.ts";
import {
  bootOn,
  eventLine,
  getJson,
  openRun,
  readyProject,
  sendBatch,
  utf8,
} from "../helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const AGENT = "nextest-streamer";

const NAME = testName("nxpass", "nxpass", "tests::adds");
const FIRST = suiteStarted("nxpass", "nxpass", "lib", 1) + testStarted(NAME);
const SECOND = testOk(NAME, 0.002878942);

describe("a stream batch under the nextest codec is accepted on an open run", () => {
  test("the first batch naming nextest is a 200 answering the bytes held; the next one appends", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const runId = await openRun(handle, key, AGENT, { stack: "rust", tier: "unit" });

    const first = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, codec: NEXTEST_CODEC, from: 0, data: FIRST });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual({ ok: true, runId, held: utf8(FIRST) });

    const second = await sendBatch(handle, runId, {
      projectKey: key,
      agentId: AGENT,
      codec: NEXTEST_CODEC,
      from: utf8(FIRST),
      data: SECOND,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toEqual({ ok: true, runId, held: utf8(FIRST + SECOND) });
    expect(handle.store.getRun(runId)?.state).toBe("open");
  });

  test("a run whose first batch fixed nextest refuses a crucible-events batch with a 400, holding nothing more", async () => {
    const handle = boot();
    const key = await readyProject(handle, [AGENT]);
    const runId = await openRun(handle, key, AGENT, { stack: "rust", tier: "unit" });
    const first = await sendBatch(handle, runId, { projectKey: key, agentId: AGENT, codec: NEXTEST_CODEC, from: 0, data: FIRST });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const other = await sendBatch(handle, runId, {
      projectKey: key,
      agentId: AGENT,
      codec: "crucible-events",
      from: utf8(FIRST),
      data: eventLine({ event: "run-start", total: 1 }),
    });
    expect(other.status, JSON.stringify(other.body)).toBe(400);
    expect(other.body.error as string).toContain("nextest");

    // Nothing was appended: the nextest stream goes on from the same offset.
    const next = await sendBatch(handle, runId, {
      projectKey: key,
      agentId: AGENT,
      codec: NEXTEST_CODEC,
      from: utf8(FIRST),
      data: SECOND,
    });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.held).toBe(utf8(FIRST + SECOND));
  });
});

describe("health lists nextest as a test codec and a record stream codec", () => {
  for (const route of ["/api/health", "/api/v2/health"]) {
    test(`GET ${route} lists nextest in codecs.test and codecs.stream, beside crucible-events and go-test, and not as a view codec`, async () => {
      const body = await getJson(boot(), route);
      const codecs = body.codecs as Record<string, string[] | undefined>;
      expect(codecs.test).toEqual(["crucible-events", "go-test", "junit", "nextest"]);
      expect(codecs.stream).toEqual(["crucible-events", "go-test", "nextest"]);
      expect(codecs.view ?? []).not.toContain("nextest");
      expect(codecs.coverage ?? []).not.toContain("nextest");
    });
  }
});
