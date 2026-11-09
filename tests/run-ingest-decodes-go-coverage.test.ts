// `POST /api/v2/runs` takes a Go run's coverage as `{codec: "go-coverprofile",
// data: [one profile per module]}`: the profiles are summed as one coverage
// total of statements on the `lines` axis, stored with no functions axis and
// no branches axis, answered in the run block and read back through the run
// detail and the events list. A types-only module's profile (a `mode:` line,
// no block) adds 0 of 0 and keeps the other module's figure; an undecodable
// profile drops the coverage with the `coverage-dropped` warning as the other
// coverage codecs do; a failing run's coverage is discarded. The close of a
// streamed run takes the same block. Health lists `go-coverprofile` among the
// coverage codecs.
//
// The profiles are real captures (`tests/fixtures/go-coverprofile/`, Go
// 1.27.3); every expected figure is the independent oracle's
// (`tests/helpers/go-coverprofile-oracle.ts`) or Go's own `cover -func` total.
// Driven through the real production HTTP surface (`startServer`, in-memory
// store).
import { describe, test, expect, afterEach } from "bun:test";
import type { ServerHandle } from "../src/server.ts";
import { coverFuncTotal, goCoverFixture, profileFigure } from "./helpers/go-coverprofile-oracle.ts";
import {
  bootOn,
  eventLine,
  getJson,
  openRun,
  postJson,
  readyProject,
  sendBatch,
  STREAM_CODEC,
  storedEvent,
  utf8,
  type Answer,
} from "./helpers/run-stream-harness.ts";

const handles: ServerHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.stop();
});

function boot(): ServerHandle {
  const handle = bootOn();
  handles.push(handle);
  return handle;
}

const SHOP_PLAIN = goCoverFixture("shop-plain.coverprofile");
const SHOP_COVERPKG = goCoverFixture("shop-coverpkg.coverprofile");
const CONTRACTS_TYPES_ONLY = goCoverFixture("contracts-types-only.coverprofile");
const LEDGER = goCoverFixture("ledger.coverprofile");

interface Axis {
  total: number;
  covered: number;
  percent: number;
}

/** 2 passed. */
const PASSING_REPORT = [
  '<testsuite name="Green" tests="2">',
  '<testcase name="g1" time="0.01"/>',
  '<testcase name="g2" time="0.02"/>',
  "</testsuite>",
].join("\n");

/** 1 passed, 1 failed. */
const FAILING_REPORT = [
  '<testsuite name="Red" tests="2">',
  '<testcase name="r1" time="0.01"/>',
  '<testcase name="r2" time="0.02"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

async function ingest(
  handle: ServerHandle,
  key: string,
  agentId: string,
  coverage: unknown,
  report = PASSING_REPORT,
): Promise<Answer> {
  return postJson(handle, "/api/v2/runs", {
    projectKey: key,
    agentId,
    codec: "junit",
    data: report,
    coverage,
  });
}

function runCoverage(res: Answer): Record<string, unknown> | undefined {
  expect(typeof res.body.run).toBe("object");
  return (res.body.run as Record<string, unknown>).coverage as Record<string, unknown> | undefined;
}

interface Brief {
  id: string;
  hasCoverage: boolean;
  coverageLines?: number;
}

async function briefs(handle: ServerHandle, key: string): Promise<Brief[]> {
  const body = await getJson(handle, `/api/v2/events?project=${key}`);
  return body.events as Brief[];
}

describe("POST /api/v2/runs — go-coverprofile coverage on a green run", () => {
  test("two module profiles, one of them types and constants only, are stored as one lines total with no functions axis", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["go-two-modules"]);
    const res = await ingest(handle, key, "go-two-modules", {
      codec: "go-coverprofile",
      data: [SHOP_PLAIN, CONTRACTS_TYPES_ONLY],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const shop = profileFigure(SHOP_PLAIN);
    const contracts = profileFigure(CONTRACTS_TYPES_ONLY);
    expect(contracts).toEqual({ blocks: 0, listed: 0, total: 0, covered: 0 });
    const expected: { lines: Axis } = {
      lines: {
        total: shop.total + contracts.total,
        covered: shop.covered + contracts.covered,
        percent: coverFuncTotal(goCoverFixture("shop-plain.cover-func.txt")),
      },
    };
    expect(expected.lines).toEqual({ total: 18, covered: 4, percent: 22.2 });

    const answered = runCoverage(res);
    expect(answered).toEqual(expected);
    expect(Object.keys(answered ?? {}).sort()).toEqual(["lines"]);

    const event = await storedEvent(handle, res.body.event);
    expect(event.coverage).toEqual(expected);
    expect(Object.keys((event.coverage as object | undefined) ?? {}).sort()).toEqual(["lines"]);
    // A clean decode warns of nothing.
    expect(res.body.warnings).toBeUndefined();
  });

  test("two module profiles with statements sum their covered and all statements", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["go-summed"]);
    const res = await ingest(handle, key, "go-summed", {
      codec: "go-coverprofile",
      data: [SHOP_COVERPKG, LEDGER],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const shop = profileFigure(SHOP_COVERPKG);
    const ledger = profileFigure(LEDGER);
    // 8 of 18 (each repeated -coverpkg block once) plus 12 of 16: 20 / 34 = 58.82…
    expect([shop.total + ledger.total, shop.covered + ledger.covered]).toEqual([34, 20]);
    const expected = { lines: { total: 34, covered: 20, percent: 58.8 } };
    expect(runCoverage(res)).toEqual(expected);
    const event = await storedEvent(handle, res.body.event);
    expect(event.coverage).toEqual(expected);
    // Neither module alone.
    expect((event.coverage as { lines: Axis }).lines.total).not.toBe(18);
    expect((event.coverage as { lines: Axis }).lines.total).not.toBe(16);
  });

  test("the events list flags the run as carrying coverage, its lines percent beside it", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["go-brief"]);
    const res = await ingest(handle, key, "go-brief", { codec: "go-coverprofile", data: [LEDGER] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = await briefs(handle, key);
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(res.body.event as string);
    expect(list[0]!.hasCoverage).toBe(true);
    expect(list[0]!.coverageLines).toBe(75);
  });

  test("one profile given as a single text, not a list, is decoded the same", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["go-single"]);
    const res = await ingest(handle, key, "go-single", { codec: "go-coverprofile", data: SHOP_COVERPKG });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(runCoverage(res)).toEqual({
      lines: { total: 18, covered: 8, percent: coverFuncTotal(goCoverFixture("shop-coverpkg.cover-func.txt")) },
    });
  });
});

describe("POST /api/v2/runs — go-coverprofile coverage that cannot be kept", () => {
  test("a profile with no mode: line drops the coverage, stores the run and warns coverage-dropped naming the codec", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["go-undecodable"]);
    const noMode = LEDGER.split("\n").slice(1).join("\n");
    const res = await ingest(handle, key, "go-undecodable", {
      codec: "go-coverprofile",
      data: [SHOP_PLAIN, noMode],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(runCoverage(res)).toBeUndefined();
    const warnings = res.body.warnings as Array<{ code: string; detail: string }>;
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.code).toBe("coverage-dropped");
    expect(warnings[0]!.detail).toContain("go-coverprofile");
    const event = await storedEvent(handle, res.body.event);
    expect(event.summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(event.coverage).toBeUndefined();
  });

  test("a failing run's go coverage is discarded and the run stored without it", async () => {
    const handle = boot();
    const key = await readyProject(handle, ["go-red"]);
    const res = await ingest(handle, key, "go-red", { codec: "go-coverprofile", data: [LEDGER] }, FAILING_REPORT);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(runCoverage(res)).toBeUndefined();
    const event = await storedEvent(handle, res.body.event);
    expect(event.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(event.coverage).toBeUndefined();
  });
});

describe("the close of a streamed run takes go-coverprofile coverage", () => {
  const L_START = eventLine({ event: "run-start", total: 2 });
  const passing = (id: string, name: string): string =>
    eventLine({ event: "test-end", id, name, suite: "shop", file: "price_test.go", status: "pass", duration_ms: 2 });
  const L_END = eventLine({ event: "run-end", total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 4 });
  const GREEN_STREAM = L_START + passing("t1", "TestDiscount") + passing("t2", "TestValue") + L_END;

  test("a green stream closed with two module profiles stores their summed lines total and no functions axis", async () => {
    const handle = boot();
    const agentId = "go-closer";
    const key = await readyProject(handle, [agentId]);
    const runId = await openRun(handle, key, agentId, { stack: "go", tier: "unit" });
    const batch = await sendBatch(handle, runId, { projectKey: key, agentId, from: 0, data: GREEN_STREAM });
    expect(batch.status, JSON.stringify(batch.body)).toBe(200);
    expect(batch.body.held).toBe(utf8(GREEN_STREAM));

    const res = await postJson(handle, "/api/v2/runs", {
      projectKey: key,
      agentId,
      runId,
      codec: STREAM_CODEC,
      coverage: { codec: "go-coverprofile", data: [SHOP_COVERPKG, CONTRACTS_TYPES_ONLY] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const expected = { lines: { total: 18, covered: 8, percent: 44.4 } };
    expect(runCoverage(res)).toEqual(expected);
    const event = await storedEvent(handle, res.body.event);
    expect(event.coverage).toEqual(expected);
    expect(Object.keys((event.coverage as object | undefined) ?? {}).sort()).toEqual(["lines"]);
  });
});

describe("health lists go-coverprofile among the coverage codecs", () => {
  for (const route of ["/api/health", "/api/v2/health"]) {
    test(`GET ${route} names go-coverprofile in codecs.coverage, beside jacoco and lcov`, async () => {
      const body = await getJson(boot(), route);
      expect(body.ok).toBe(true);
      const codecs = body.codecs as { coverage?: string[]; test?: string[] };
      expect(codecs.coverage).toEqual(["go-coverprofile", "jacoco", "lcov"]);
      // A coverage codec, not a test codec.
      expect(codecs.test ?? []).not.toContain("go-coverprofile");
    });
  }
});
