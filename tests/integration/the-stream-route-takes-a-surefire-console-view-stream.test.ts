// `surefire-console` is a VIEW codec: held in `viewCodecs` only, never a
// report codec or a record stream codec, and taken by
// `POST /api/v2/runs/<runId>/stream` as an open run's view stream, whose live
// state `GET /api/v2/runs/<runId>/live` reads back.
//
// The route is driven with a real `forkCount=2` capture from surefire 3.5.4
// (tests/fixtures/surefire-console/3.5.4/forks.txt), cut mid-line, over real
// HTTP: the first batch ends inside the line after `Running forks.AlphaTest`,
// when DeltaTest and GammaTest have closed and BetaTest and AlphaTest are both
// open; the second batch is the rest.
//
// SAFETY: every server binds port 0; every store is ":memory:".
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { codecs, isRecordStreamCodec, viewCodecs } from "../../src/codecs/index.ts";
import type { ServerHandle } from "../../src/server.ts";
import { base, bootOn, openRun, readyProject, sendBatch, utf8, type Answer } from "../helpers/run-stream-harness.ts";

const VIEW_CODEC = "surefire-console";
const AF = "org.opentest4j.AssertionFailedError: ";
const FORKS = readFileSync(`${import.meta.dir}/../fixtures/surefire-console/3.5.4/forks.txt`, "utf8");

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

interface Subject {
  handle: ServerHandle;
  key: string;
  agentId: string;
  runId: string;
}

async function subject(): Promise<Subject> {
  const handle = boot();
  const agentId = "maven-relay";
  const key = await readyProject(handle, [agentId], "surefire-console-view");
  const runId = await openRun(handle, key, agentId, { stack: "maven", tier: "unit" });
  return { handle, key, agentId, runId };
}

function batch(s: Subject, from: number, data: string): Promise<Answer> {
  return sendBatch(s.handle, s.runId, { projectKey: s.key, agentId: s.agentId, from, data, codec: VIEW_CODEC });
}

async function liveOf(s: Subject): Promise<Record<string, unknown>> {
  const res = await fetch(`${base(s.handle)}/api/v2/runs/${s.runId}/live`);
  expect(res.status, "the open run holds a live state").toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function failuresOf(body: Record<string, unknown>): Array<{ suite: unknown; name: unknown; message: unknown }> {
  const failures = (body.failures ?? []) as Array<Record<string, unknown>>;
  return failures.map((f) => ({ suite: f.suite, name: f.name, message: f.message }));
}

/** A few characters into the line after `Running forks.AlphaTest`: a cut mid-line. */
const CUT = FORKS.indexOf("\n", FORKS.indexOf("Running forks.AlphaTest")) + 6;

// ═══════════════════════════════════════════════════════════════════════════

describe("surefire-console is a view codec, held in the view registry only", () => {
  test("viewCodecs holds surefire-console, stating its name and a fill method and no parse; no report registry or record stream holds it", () => {
    const codec = viewCodecs.get(VIEW_CODEC);
    expect(codec?.name).toBe(VIEW_CODEC);
    expect(typeof codec?.fill).toBe("function");
    expect(codec).not.toHaveProperty("parse");
    expect(codecs.has(VIEW_CODEC)).toBe(false);
    expect(isRecordStreamCodec(VIEW_CODEC)).toBe(false);
  });
});

describe("the stream route takes a surefire-console view stream into the open run's live state", () => {
  test("two batches cut mid-line, each answered 200 with the bytes held; the live read shows the closed classes and the open fork, then the whole run, and no event is stored", async () => {
    const s = await subject();
    const before = s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).length;
    const head = FORKS.slice(0, CUT);
    const tail = FORKS.slice(CUT);

    const first = await batch(s, 0, head);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.held).toBe(utf8(head));
    const midway = await liveOf(s);
    expect(midway.state).toBe("open");
    expect(midway.live).toEqual({ completed: 4, passed: 2, failed: 2, pending: 0, currentFile: "forks.AlphaTest" });
    expect(failuresOf(midway)).toEqual([
      { suite: "forks.GammaTest", name: "fails", message: `${AF}Gamma failed` },
      { suite: "forks.DeltaTest", name: "fails", message: `${AF}Delta failed` },
    ]);

    const second = await batch(s, utf8(head), tail);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.held).toBe(utf8(FORKS));
    const done = await liveOf(s);
    expect(done.state).toBe("open");
    expect(done.live).toMatchObject({ completed: 8, passed: 4, failed: 4, pending: 0 });
    expect(failuresOf(done)).toEqual([
      { suite: "forks.GammaTest", name: "fails", message: `${AF}Gamma failed` },
      { suite: "forks.DeltaTest", name: "fails", message: `${AF}Delta failed` },
      { suite: "forks.AlphaTest", name: "fails", message: `${AF}Alpha failed` },
      { suite: "forks.BetaTest", name: "fails", message: `${AF}Beta failed` },
    ]);
    expect(s.handle.store.listEvents(s.key, Number.MAX_SAFE_INTEGER).length).toBe(before);
    expect(s.handle.store.getRun(s.runId)?.state).toBe("open");
  });
});
