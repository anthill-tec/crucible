// Health (`/api/health`, `/api/v2/health`) carries
// `codecs: {test: [...], coverage: [...]}` — the names this board decodes —
// so a client can tell a board that predates server-side decoding before it
// sends. This board decodes `junit` and `playwright` test reports and `jacoco`
// and `lcov` coverage. Driven through the real production HTTP surface
// (`startServer`, in-memory store).
import { describe, test, expect, afterEach } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";

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

const CODECS = { test: ["junit", "playwright"], coverage: ["jacoco", "lcov"] };

describe("health names the codecs the board decodes", () => {
  test("GET /api/health carries codecs {test: [junit, playwright], coverage: [jacoco, lcov]}", async () => {
    const body = await health("/api/health");
    expect(body.ok).toBe(true);
    expect(body.codecs).toEqual(CODECS);
  });

  test("GET /api/v2/health carries the same codecs", async () => {
    const body = await health("/api/v2/health");
    expect(body.ok).toBe(true);
    expect(body.codecs).toEqual(CODECS);
  });

  test("the codec lists hold exactly these names — no compile format, no parsed pseudo-codec", async () => {
    const body = await health("/api/v2/health");
    const codecs = body.codecs as { test?: string[]; coverage?: string[] } | undefined;
    expect(codecs?.test?.length).toBe(2);
    expect(codecs?.coverage?.length).toBe(2);
    expect(codecs?.test ?? []).not.toContain("parsed");
    expect(codecs?.coverage ?? []).not.toContain("junit");
  });
});
