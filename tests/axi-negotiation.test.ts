// CR-CRU-005 §S2 (content negotiation) + §S3 (help[] hints module) + §S4
// (TOON truncation with pointer) — RED phase.
// Drives the REAL production server (startServer) — none of the following
// exist yet in src/v2.ts: `?fmt=toon` / `Accept: text/toon` negotiation on
// v2 GET routes, the shared `src/hints.ts` wording module, or 64KB TOON
// truncation. This file is RED via BOTH module-resolution failure (the
// `import { hints } from "../src/hints.ts"` below — src/hints.ts does not
// exist yet) AND, once hints.ts exists, behavioral failures against the
// still-unwired negotiation/truncation routes.
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { RunSummary, SuiteNode } from "../src/types.ts";
import { hints } from "../src/hints.ts";

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
  help?: string[];
}

interface EventsListResponse extends OkResponse {
  events: Array<{ id: string; [key: string]: unknown }>;
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
}

// 3-case junit fixture, 1 failing case → RED verdict (matches other v2 suites' fixture).
const JUNIT_1FAIL = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

describe("AXI negotiation, hints, truncation (CR-CRU-005 §S2+§S3+§S4)", () => {
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

  async function getWithAccept(path: string, accept: string): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      headers: { Accept: accept },
    });
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  function parsedRunBody(overrides: { projectKey: string; agentId?: string; summary?: Partial<RunSummary> }) {
    return {
      projectKey: overrides.projectKey,
      agentId: overrides.agentId ?? "negotiate-agent",
      summary: {
        total: 5,
        passed: 5,
        failed: 0,
        pending: 0,
        duration_ms: 100,
        ...overrides.summary,
      },
      tree: [
        {
          name: "s",
          status: "pass",
          children: [{ name: "t1", status: "pass", duration_ms: 50 }],
        },
      ] as SuiteNode[],
    };
  }

  function firstLine(body: string): string {
    return body.split("\n")[0] ?? "";
  }

  // ── §S2 — content negotiation ────────────────────────────────────────────

  describe("GET /api/v2/events — ?fmt=toon negotiation", () => {
    test("?fmt=toon → content-type text/toon; charset=utf-8, body's first line 'ok: true'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/v2/events?fmt=toon");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/toon; charset=utf-8");
      const body = await res.text();
      expect(firstLine(body)).toBe("ok: true");
    });

    test("same URL without fmt → JSON", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getJson("/api/v2/events");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
    });
  });

  describe("GET /api/v2/agents — Accept header negotiation", () => {
    test("Accept: text/toon → TOON body", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getWithAccept("/api/v2/agents", "text/toon");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/toon; charset=utf-8");
      const body = await res.text();
      expect(firstLine(body)).toBe("ok: true");
    });

    test("Accept header containing toon amid other media types still negotiates TOON", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await getWithAccept("/api/v2/agents", "text/html, text/toon;q=0.9, */*;q=0.1");

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/toon; charset=utf-8");
    });
  });

  describe("every v2 GET route honors negotiation", () => {
    test("?fmt=toon on every v2 GET route → text/toon + parses as TOON; without fmt → JSON", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("negotiate-all");
      const runRes = await postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key }));
      const runBody = (await runRes.json()) as RunsPostResponse;
      const eventId = runBody.event;

      const routes = [
        "/api/v2",
        "/api/v2/health",
        "/api/v2/projects",
        "/api/v2/agents",
        "/api/v2/events",
        `/api/v2/status?project=${key}`,
        `/api/v2/events/${eventId}`,
      ];

      for (const path of routes) {
        const toonPath = path.includes("?") ? `${path}&fmt=toon` : `${path}?fmt=toon`;
        const toonRes = await getJson(toonPath);
        expect(toonRes.status).toBe(200);
        expect(toonRes.headers.get("content-type")).toBe("text/toon; charset=utf-8");
        const toonBody = await toonRes.text();
        expect(firstLine(toonBody)).toBe("ok: true");

        const jsonRes = await getJson(path);
        expect(jsonRes.status).toBe(200);
        expect(jsonRes.headers.get("content-type") ?? "").toContain("application/json");
        const jsonBody = (await jsonRes.json()) as OkResponse;
        expect(jsonBody.ok).toBe(true);
      }
    });
  });

  describe("POST responses stay JSON even with ?fmt=toon", () => {
    test("POST /api/v2/agents/heartbeat?fmt=toon → still application/json, never text/toon", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("post-stays-json");
      await postJson("/api/v2/agents/register", { projectKey: key, agentId: "a1", message: "m", phase: "report" });

      const res = await fetch(`http://localhost:${handle.server.port}/api/v2/agents/heartbeat?fmt=toon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectKey: key, agentId: "a1", message: "hb", status: "busy" }),
      });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type") ?? "";
      expect(contentType).toContain("application/json");
      expect(contentType).not.toContain("text/toon");
      const body = (await res.json()) as OkResponse;
      expect(body.ok).toBe(true);
    });
  });

  // ── §S3 — help[] hints module ────────────────────────────────────────────

  describe("help[] hints module (src/hints.ts)", () => {
    test("exports registered/afterRed/unknownProject as non-empty string arrays", () => {
      expect(isNonEmptyStringArray(hints.registered)).toBe(true);
      expect(isNonEmptyStringArray(hints.afterRed)).toBe(true);
      expect(isNonEmptyStringArray(hints.unknownProject)).toBe(true);
    });

    test("the module file itself contains the wording used by the register/RED/404 hints (single source of truth)", () => {
      const source = readFileSync(join(import.meta.dir, "../src/hints.ts"), "utf-8");
      expect(source).toContain("heartbeat");
      expect(source).toContain("transition");
      expect(source).toContain("POST /api/v2/projects");
    });

    test("register response help joined text includes 'heartbeat'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("hint-register");

      const res = await postJson("/api/v2/agents/register", {
        projectKey: key,
        agentId: "a1",
        message: "m",
        phase: "report",
        identity: { displayName: "A" },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as OkResponse & { help?: string[] };
      expect(isNonEmptyStringArray(body.help)).toBe(true);
      expect((body.help as string[]).join(" ")).toContain("heartbeat");
    });

    test("a RED-verdict POST /api/v2/runs response help includes 'transition'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("hint-red-verdict");

      const res = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "red-agent",
        codec: "junit",
        data: JUNIT_1FAIL,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as RunsPostResponse;
      expect(body.verdict.startsWith("RED")).toBe(true);
      expect(isNonEmptyStringArray(body.help)).toBe(true);
      expect((body.help as string[]).join(" ")).toContain("transition");
    });

    test("a 404 unknown-project error's help names 'POST /api/v2/projects'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const res = await postJson("/api/v2/agents/register", {
        projectKey: crypto.randomUUID(),
        agentId: "a1",
        message: "m",
        phase: "report",
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse & { help?: string[] };
      expect(isNonEmptyStringArray(body.help)).toBe(true);
      expect((body.help as string[]).join(" ")).toContain("POST /api/v2/projects");
    });
  });

  // ── §S4 — truncation with pointer ────────────────────────────────────────

  describe("TOON truncation with pointer (§S4)", () => {
    test("~850 events: TOON GET truncates its largest array with 'truncated: true' + a 'fmt=json' pointer; JSON GET stays complete", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      // CR-CRU-001 §S4 pins a default per-project retention of 100 raw
      // events — a plain POST /api/v2/projects create would prune this
      // fixture down to ~18KB JSON, well under the 64KB truncation
      // threshold. Override retention via the store directly (same pattern
      // as tests/events.test.ts's "per-project retention override" test) so
      // the fixture actually exercises §S4 truncation.
      //
      // CR-CRU-046 C2 test-fix pass — the official library's compact
      // tabular form (every `eventBrief` is an all-scalar row of identical
      // shape, per src/v2.ts's `eventBrief` comment) encodes 500 of these
      // events to ~59 KB, UNDER the 64 KB truncation threshold, so
      // `truncated: true` legitimately never fired: the fixture pinned the
      // subset serializer's size profile, not the official encoder's.
      // Measured empirically against the real production `toToon` encode of
      // this exact event shape (scripts/probe, not committed): 500 → ~59 KB
      // (0.90×), 700 → ~83 KB (1.26×), 850 → ~100 KB (1.53×), scaling
      // linearly at ~118 bytes/event. 850 events puts the PRE-truncation
      // encoded body at ~1.53× the 64 KB threshold — comfortable margin
      // above 1.0× so the mechanism is proven at the real threshold, not
      // pinned to a bar lowered to just clear it.
      const key = crypto.randomUUID();
      const EVENT_COUNT = 850;
      handle.store.addProject({ key, name: "trunc-project", type: "backend", sutRoot: "/tmp", retention: EVENT_COUNT + 100 });
      for (let i = 0; i < EVENT_COUNT; i++) {
        handle.store.recordTestEvent(key, "trunc-agent", {
          summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
          tree: [],
        });
      }

      const jsonRes = await getJson(`/api/v2/events?project=${key}&limit=${EVENT_COUNT}`);
      expect(jsonRes.status).toBe(200);
      const jsonText = await jsonRes.text();
      // Sanity: the fixture is large enough that a same-content TOON body
      // would plausibly cross the 64KB truncation threshold (TOON's nested
      // per-event blocks for a non-uniform `summary` field run larger than
      // compact JSON per event, so JSON already at >60% of 64KB is a safe bar).
      expect(jsonText.length).toBeGreaterThan(64 * 1024 * 0.6);
      const jsonBody = JSON.parse(jsonText) as EventsListResponse;
      expect(jsonBody.ok).toBe(true);
      expect(jsonBody.events.length).toBe(EVENT_COUNT);

      const toonRes = await getJson(`/api/v2/events?project=${key}&limit=${EVENT_COUNT}&fmt=toon`);
      expect(toonRes.status).toBe(200);
      expect(toonRes.headers.get("content-type")).toBe("text/toon; charset=utf-8");
      const toonText = await toonRes.text();
      expect(toonText.length).toBeLessThanOrEqual(64 * 1024);
      const lines = toonText.split("\n");
      expect(lines).toContain("truncated: true");
      expect(lines.some((line) => line.includes("fmt=json"))).toBe(true);
    });
  });

  // ── Integration AC — every GET routes through a shared reply(), not raw Response.json( ──

  describe("integration — no direct Response.json( in src/v2.ts", () => {
    test("src/v2.ts contains zero occurrences of Response.json( (all responses route through a shared reply helper)", () => {
      const source = readFileSync(join(import.meta.dir, "../src/v2.ts"), "utf-8");
      const matches = source.match(/Response\.json\(/g) ?? [];
      expect(matches.length).toBe(0);
    });
  });
});
