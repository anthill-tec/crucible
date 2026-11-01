// Health (`/api/health`, `/api/v2/health`) lists the record stream codecs
// under `codecs.stream` (CR-CRU-225 §S1, AC1; P5): the report codecs that
// decode a run's held stream at its close (`isRecordStreamCodec`) — today
// `crucible-events` — so a client can check a declared `stream` codec before
// the run opens. `codecs.test`, `codecs.coverage` and `codecs.view` are
// unchanged: `crucible-events` stays a test codec too.
//
// Driven through the real production HTTP surface (`startServer`, in-memory
// store), and through `codecNames`, the one site both health routes read.
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import { codecNames, codecs, isRecordStreamCodec } from "../src/codecs/index.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

async function health(route: string): Promise<Record<string, unknown>> {
  const handle = startServer({ port: 0, dbPath: ":memory:" });
  handles.push(handle);
  const res = await fetch(`http://127.0.0.1:${handle.server.port}${route}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

const CODECS = {
  test: ["crucible-events", "junit", "playwright"],
  coverage: ["jacoco", "lcov"],
  view: ["bun-console"],
  stream: ["crucible-events"],
};

describe("health lists the record stream codecs under codecs.stream", () => {
  for (const route of ["/api/health", "/api/v2/health"]) {
    test(`GET ${route} carries codecs.stream [crucible-events] beside test, coverage and view as before`, async () => {
      const body = await health(route);
      expect(body.ok).toBe(true);
      expect(body.codecs).toEqual(CODECS);
    });
  }

  test("codecs.stream holds exactly the record stream codecs — no report-only codec, no view codec", async () => {
    const body = await health("/api/v2/health");
    const listed = body.codecs as Record<string, string[] | undefined>;
    expect(listed.stream).toEqual(["crucible-events"]);
    expect(listed.stream ?? []).not.toContain("junit");
    expect(listed.stream ?? []).not.toContain("playwright");
    expect(listed.stream ?? []).not.toContain("bun-console");
    expect(listed.test).toContain("crucible-events");
  });

  test("codecNames().stream is the report codecs isRecordStreamCodec accepts, sorted", () => {
    const expected = [...codecs.keys()].filter((name) => isRecordStreamCodec(name)).sort((a, b) => a.localeCompare(b));
    expect(expected).toEqual(["crucible-events"]);
    const names = codecNames() as Record<string, string[] | undefined>;
    expect(names.stream).toEqual(expected);
  });
});
