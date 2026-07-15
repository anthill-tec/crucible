// CR-CRU-007 C5b — shared E2E harness logic, lifted unchanged from the
// pre-conversion tests/e2e/shell.e2e.ts / tests/e2e/timeline.e2e.ts
// (superseded by the Gherkin features + step definitions in this
// directory — see docs/changes/CR-CRU-007-timeline-drill-in.md's
// "E2E house style" AC). Every Given/When/Then step below delegates to
// these functions instead of re-implementing seeding/ingest logic inline.
import { type APIRequestContext, expect } from "@playwright/test";

export async function seedProject(request: APIRequestContext, name: string): Promise<string> {
  const key = crypto.randomUUID();
  const res = await request.post("/api/projects/add", {
    data: { key, name, sut_root: "/tmp/e2e" },
  });
  expect(res.ok()).toBe(true);
  return key;
}

export async function registerAgent(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  message: string,
): Promise<void> {
  const res = await request.post("/api/v2/agents/register", {
    data: { projectKey, agentId, message, status: "online" },
  });
  expect(res.ok()).toBe(true);
}

/** Poll a standalone server's /api/health until it answers ok, or throw. */
export async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // connection refused while the server boots — keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error(`server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface RunSummaryInput {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
}

export interface RunIngestResponse {
  event: string;
}

export async function ingestJunit(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  xml: string,
  tier?: string,
): Promise<RunIngestResponse> {
  const res = await request.post("/api/v2/runs", {
    data: {
      projectKey,
      agentId,
      codec: "junit",
      data: xml,
      ...(tier !== undefined ? { tier } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as RunIngestResponse;
}

export async function ingestParsed(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  summary: RunSummaryInput,
  opts?: { coverage?: unknown; tier?: string },
): Promise<RunIngestResponse> {
  const status = summary.failed > 0 ? "fail" : "pass";
  const res = await request.post("/api/v2/runs/parsed", {
    data: {
      projectKey,
      agentId,
      summary,
      tree: [{ name: "s", status, children: [{ name: "t1", status, duration_ms: 5 }] }],
      ...(opts?.coverage !== undefined ? { coverage: opts.coverage } : {}),
      ...(opts?.tier !== undefined ? { tier: opts.tier } : {}),
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as RunIngestResponse;
}

export interface CompileIngestResponse {
  event: string;
  errors: number;
  warnings: number;
}

export async function ingestCompile(
  request: APIRequestContext,
  projectKey: string,
  agentId: string,
  errors: string,
  format = "rustc",
): Promise<CompileIngestResponse> {
  const res = await request.post("/api/v2/runs/compile", {
    data: { projectKey, agentId, errors, format },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as CompileIngestResponse;
}

// 3-case junit: 2 pass + 1 fail w/ message="boom" (mirrors the fixture
// already used in tests/v2-runs-events.test.ts / tests/ingest-routes.test.ts).
export const JUNIT_3CASE_1FAIL = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

/** 60-case single-suite junit fixture, `failCount` failing with a shared message. */
export function junit60(failCount = 3): string {
  const cases: string[] = [];
  for (let i = 1; i <= 60; i++) {
    if (i <= failCount) {
      cases.push(
        `<testcase name="t${i}" time="0.01"><failure message="boom-60">trace-${i}</failure></testcase>`,
      );
    } else {
      cases.push(`<testcase name="t${i}" time="0.01"/>`);
    }
  }
  return [`<testsuite name="Suite60" tests="60">`, ...cases, "</testsuite>"].join("\n");
}

// rustc fixture per CR §S2 AC4: 1 error[E0308] block + 1 plain warning block
// (same fixture shape as tests/v2-runs-events.test.ts / ingest-routes.test.ts).
export const RUSTC_ERRORS = [
  "error[E0308]: mismatched types",
  " --> src/lib.rs:12:5",
  "warning: unused import",
  " --> src/a.rs:1:1",
].join("\n");
