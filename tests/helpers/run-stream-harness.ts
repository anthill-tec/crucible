// The test stream an open run takes, driven over real HTTP: a project with
// registered callers, a run opened with `POST /api/v2/runs/start`, batches
// sent to `POST /api/v2/runs/<runId>/stream`, and the close through
// `POST /api/v2/runs` naming the `crucible-events` codec and sending no report.
//
// Shared by the stream suites so each one drives the route the same way: the
// codec reading, the route's answers, the record at close and the restart.
// Byte offsets are UTF-8 bytes, as the route counts them; a batch is cut from
// the stream TEXT at a character index and its `from` is the UTF-8 length of
// everything before it.
//
// Safety: every server binds port 0; a database is ":memory:" or a file under
// a fresh OS tmpdir the caller owns.
import { expect } from "bun:test";
import { startServer } from "../../src/server.ts";
import type { ServerHandle } from "../../src/server.ts";

/** The stream codec §S1 registers. */
export const STREAM_CODEC = "crucible-events";

/** The UTF-8 length of `text`, the unit every `from` and `held` is counted in. */
export function utf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** One stream line: the event as one JSON object, newline-terminated. */
export function eventLine(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields)}\n`;
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

export function base(handle: ServerHandle): string {
  return `http://127.0.0.1:${handle.server.port}`;
}

/** POST a JSON body (or a raw text body, sent as it is) and read the JSON answer. */
export async function postJson(handle: ServerHandle, route: string, body: unknown): Promise<Answer> {
  const res = await fetch(`${base(handle)}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { unparsed: text };
  }
  return { status: res.status, body: parsed };
}

export async function getJson(handle: ServerHandle, route: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(handle)}${route}`);
  expect(res.status, `GET ${route}`).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A project with each of `agentIds` registered (unbound, as an orchestrator). */
export async function readyProject(
  handle: ServerHandle,
  agentIds: readonly string[],
  name = "stream-subject",
): Promise<string> {
  const key = crypto.randomUUID();
  handle.store.addProject({ key, name, type: "backend", sutRoot: "/tmp/stream-subject" });
  for (const agentId of agentIds) await register(handle, key, agentId);
  return key;
}

export async function register(handle: ServerHandle, projectKey: string, agentId: string): Promise<void> {
  const res = await postJson(handle, "/api/v2/agents/register", {
    projectKey,
    agentId,
    role: "ORCHESTRATOR",
  });
  expect(res.status, `registering ${agentId}`).toBe(200);
}

/** Open a run with `POST /api/v2/runs/start`; answers its runId. */
export async function openRun(
  handle: ServerHandle,
  projectKey: string,
  agentId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await postJson(handle, "/api/v2/runs/start", { projectKey, agentId, ...extra });
  expect(res.status, "opening the run").toBe(202);
  expect(typeof res.body.runId).toBe("string");
  return res.body.runId as string;
}

export function streamRoute(runId: string): string {
  return `/api/v2/runs/${runId}/stream`;
}

export interface BatchFields {
  projectKey: unknown;
  agentId: unknown;
  from: unknown;
  data: unknown;
  codec?: unknown;
}

/**
 * One batch to the stream route. Every field is sent as given, so a shape
 * test can send a malformed one; `codec` defaults to `crucible-events`, and a
 * field passed as `undefined` is left out of the body.
 */
export function sendBatch(handle: ServerHandle, runId: string, fields: BatchFields): Promise<Answer> {
  const body: Record<string, unknown> = { codec: STREAM_CODEC, ...fields };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  return postJson(handle, streamRoute(runId), body);
}

/** The run's stream cut at `cuts` (character indices), as the batches a client sends. */
export function batchesOf(text: string, cuts: readonly number[]): Array<{ from: number; data: string; heldAfter: number }> {
  const points = [0, ...cuts, text.length];
  const out: Array<{ from: number; data: string; heldAfter: number }> = [];
  for (const [i, start] of points.slice(0, -1).entries()) {
    const end = points[i + 1] ?? text.length;
    out.push({ from: utf8(text.slice(0, start)), data: text.slice(start, end), heldAfter: utf8(text.slice(0, end)) });
  }
  return out;
}

/** Send every batch in order, each answered 200 `{ok: true, runId, held}` with the bytes held so far. */
export async function sendAll(
  handle: ServerHandle,
  runId: string,
  projectKey: string,
  agentId: string,
  batches: ReadonlyArray<{ from: number; data: string; heldAfter: number }>,
): Promise<void> {
  for (const [index, batch] of batches.entries()) {
    const res = await sendBatch(handle, runId, { projectKey, agentId, from: batch.from, data: batch.data });
    expect(res.status, `batch ${index} (from ${batch.from}): ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBe(runId);
    expect(res.body.held).toBe(batch.heldAfter);
  }
}

/** The close §S3 states: `POST /api/v2/runs` with the runId, the stream codec, and no report. */
export function closeStream(
  handle: ServerHandle,
  projectKey: string,
  agentId: string,
  runId: string,
): Promise<Answer> {
  return postJson(handle, "/api/v2/runs", { projectKey, agentId, runId, codec: STREAM_CODEC });
}

export interface StoredRun {
  id: string;
  summary?: Record<string, unknown>;
  tree?: unknown[];
  [key: string]: unknown;
}

/** The stored event, read through the run detail read `GET /api/v2/events/<id>`. */
export async function storedEvent(handle: ServerHandle, eventId: unknown): Promise<StoredRun> {
  expect(typeof eventId, "the ingest must answer the event it stored").toBe("string");
  const detail = await getJson(handle, `/api/v2/events/${eventId as string}`);
  return detail.event as StoredRun;
}

/** A server bound to port 0 on `dbPath` (":memory:" unless given). */
export function bootOn(dbPath = ":memory:"): ServerHandle {
  return startServer({ port: 0, dbPath });
}
