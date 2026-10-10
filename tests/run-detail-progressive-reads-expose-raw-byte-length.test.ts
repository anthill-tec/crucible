// `GET /api/v2/events/:id?depth=suites` and `?suite=<name>` carry `rawBytes`
// — the run's raw output's length in BYTES (not UTF-16 code units) — when the
// run has raw output, and carry no `rawBytes` key at all when it has none.
// Neither progressive read carries `raw` itself; only the full read
// (`GET /api/v2/events/:id`, no query) does, unchanged. RED: `rawBytes` does
// not exist anywhere in the store or the v2 handler today, so the first
// assertion in each test below (`event.rawBytes` on the run WITH raw output)
// finds `undefined` where the AC demands an exact byte count, and the whole
// test fails there.
//
// The fixture's raw output deliberately mixes multi-byte UTF-8 characters
// (café, 日本語, an emoji) with plain ASCII so its byte length and its JS
// string ("char") length provably DIFFER — a byte count that happened to
// equal `.length` would not prove the implementation counts bytes rather than
// code units.
import { afterEach, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import type { ServerHandle } from "../src/server.ts";
import type { SuiteNode } from "../src/types.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}
interface RunsParsedResponse extends OkResponse {
  event: string;
}
interface EventGetResponse extends OkResponse {
  event: { id: string; tree?: unknown; raw?: unknown; rawBytes?: unknown; [key: string]: unknown };
}

let handle: ServerHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

async function postJson(p: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function getJson(p: string): Promise<Response> {
  return fetch(`http://localhost:${handle!.server.port}${p}`);
}
async function createProject(name: string): Promise<string> {
  const res = await postJson("/api/v2/projects", { name });
  const body = (await res.json()) as OkResponse & { project: { key: string } };
  return body.project.key;
}
async function registerAgent(projectKey: string, agentId: string): Promise<void> {
  const res = await postJson("/api/v2/agents/register", { projectKey, agentId, role: "ORCHESTRATOR" });
  expect(res.status).toBe(200);
}

// Deliberately: café (1 multi-byte char), an emoji (4 bytes, 2 UTF-16 code
// units) and a CJK run (3 bytes each) — `.length` (UTF-16 code units) and the
// true UTF-8 byte length are DIFFERENT numbers for this string.
const MULTI_BYTE_RAW_OUTPUT = "$ bun test\ncafé passed ☕ 日本語 raw tail\n3 pass\n";

async function seedRun(
  projectKey: string,
  agentId: string,
  opts: { raw?: string },
): Promise<string> {
  const tree: SuiteNode[] = [
    { name: "OnlySuite", status: "pass", children: [{ name: "c1", status: "pass", duration_ms: 1 }] },
  ];
  const res = await postJson("/api/v2/runs/parsed", {
    projectKey,
    agentId,
    summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
    tree,
    ...(opts.raw !== undefined ? { raw: opts.raw } : {}),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as RunsParsedResponse;
  return body.event;
}

describe("progressive run-detail reads carry rawBytes, never raw", () => {
  test("?depth=suites: rawBytes equals the UTF-8 byte length for a run with raw output, is absent for a run without, and raw itself never appears (full read keeps raw, unaffected)", async () => {
    const expectedBytes = Buffer.byteLength(MULTI_BYTE_RAW_OUTPUT, "utf-8");
    // Sanity on the fixture itself: a byte count equal to `.length` would not
    // distinguish "counts bytes" from "counts UTF-16 code units".
    expect(expectedBytes).not.toBe(MULTI_BYTE_RAW_OUTPUT.length);

    handle = startServer({ port: 0, dbPath: ":memory:" });
    const projectKey = await createProject("raw-bytes-suites");
    await registerAgent(projectKey, "raw-bytes-agent");

    const withRawId = await seedRun(projectKey, "raw-bytes-agent", { raw: MULTI_BYTE_RAW_OUTPUT });
    const withoutRawId = await seedRun(projectKey, "raw-bytes-agent", {});

    const present = (await (await getJson(`/api/v2/events/${withRawId}?depth=suites`)).json()) as EventGetResponse;
    // The new behaviour this CR adds — fails today (rawBytes is undefined).
    expect(present.event.rawBytes).toBe(expectedBytes);
    expect("raw" in present.event).toBe(false);

    const absent = (await (await getJson(`/api/v2/events/${withoutRawId}?depth=suites`)).json()) as EventGetResponse;
    // Negative/bound: a run with NO raw output must carry no rawBytes key at
    // all — never a fabricated 0 — so a reader can tell "no raw" from "empty
    // raw" the same way the existing `raw` key already distinguishes it.
    expect("rawBytes" in absent.event).toBe(false);
    expect("raw" in absent.event).toBe(false);

    // Regression pin: the full read is untouched by this CR — still carries
    // raw verbatim, never rawBytes.
    const full = (await (await getJson(`/api/v2/events/${withRawId}`)).json()) as EventGetResponse;
    expect(full.event.raw).toBe(MULTI_BYTE_RAW_OUTPUT);
    expect("rawBytes" in full.event).toBe(false);
  });

  test("?suite=: rawBytes equals the UTF-8 byte length for a run with raw output, is absent for a run without, and raw itself never appears", async () => {
    const expectedBytes = Buffer.byteLength(MULTI_BYTE_RAW_OUTPUT, "utf-8");

    handle = startServer({ port: 0, dbPath: ":memory:" });
    const projectKey = await createProject("raw-bytes-suite");
    await registerAgent(projectKey, "raw-bytes-agent");

    const withRawId = await seedRun(projectKey, "raw-bytes-agent", { raw: MULTI_BYTE_RAW_OUTPUT });
    const withoutRawId = await seedRun(projectKey, "raw-bytes-agent", {});

    const present = (await (await getJson(`/api/v2/events/${withRawId}?suite=OnlySuite`)).json()) as EventGetResponse;
    // The new behaviour this CR adds — fails today (rawBytes is undefined).
    expect(present.event.rawBytes).toBe(expectedBytes);
    expect("raw" in present.event).toBe(false);

    const absent = (await (await getJson(`/api/v2/events/${withoutRawId}?suite=OnlySuite`)).json()) as EventGetResponse;
    expect("rawBytes" in absent.event).toBe(false);
    expect("raw" in absent.event).toBe(false);
  });
});
