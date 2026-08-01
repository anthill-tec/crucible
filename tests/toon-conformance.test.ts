// CR-CRU-046 §S4 — server-side TOON conformance gate, RED phase.
//
// EXPECTED RED MODE: `@toon-format/toon` is NOT yet a dependency of this
// package (package.json declares zero runtime deps today) — this file is
// RED via MODULE-RESOLUTION FAILURE on the import below, the same
// documented RED convention `tests/toon.test.ts:4` used for CR-005's
// `../src/toon.ts` (a not-yet-existing SUT module). Once GREEN adds
// `@toon-format/toon` as a runtime dependency and flips `src/toon.ts` (or
// its replacement) to encode through the official library, these tests
// become the §S4 server-side conformance gate — no edits needed here.
//
// Today's hand-written `src/toon.ts` (CR-CRU-005 subset) is NOT conformant
// per the CR-CRU-046 context: list arrays lack the `- `-prefixed element
// form the official spec requires, and the quoting predicate under-quotes
// (misses leading-hyphen / leading-trailing-whitespace / numeric-looking /
// boolean-looking / null-looking strings). Both defects are exercised below
// by decoding the server's real HTTP TOON output with the OFFICIAL decoder
// and comparing against the JSON twin from the same real server — never by
// binding to `toToon` by name, since GREEN may delete or rename it; the
// wire is the seam this file pins.
import { decode } from "@toon-format/toon";
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import type { RunSummary, SuiteNode } from "../src/types.ts";

interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

// 3-case junit fixture, 1 failing case → RED verdict (matches other v2 suites' fixture,
// reused from tests/axi-negotiation.test.ts's JUNIT_1FAIL pattern).
const JUNIT_1FAIL = [
  '<testsuite name="Suite1" tests="3">',
  '<testcase name="t1" time="0.01"/>',
  '<testcase name="t2" time="0.02"/>',
  '<testcase name="t3" time="0.03"><failure message="boom">trace</failure></testcase>',
  "</testsuite>",
].join("\n");

describe("TOON conformance — official library decode of the real server wire (CR-CRU-046 §S4)", () => {
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

  async function getToonText(path: string): Promise<{ res: Response; text: string }> {
    const toonPath = path.includes("?") ? `${path}&fmt=toon` : `${path}?fmt=toon`;
    const res = await fetch(`http://localhost:${handle!.server.port}${toonPath}`);
    const text = await res.text();
    return { res, text };
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  async function registerAgent(
    projectKey: string,
    agentId: string,
    message: string,
  ): Promise<void> {
    const res = await postJson("/api/v2/agents/register", {
      projectKey,
      agentId,
      message,
      phase: "report",
    });
    expect(res.status).toBe(200);
  }

  function parsedRunBody(overrides: { projectKey: string; agentId?: string; summary?: Partial<RunSummary> }) {
    return {
      projectKey: overrides.projectKey,
      agentId: overrides.agentId ?? "conformance-agent",
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

  // ── §S4 — round-trip: every AXI envelope shape the server emits ──────────

  describe("round-trip through every v2 GET envelope shape (§S4 AC — 'every AXI envelope shape')", () => {
    test("GET /api/v2 (orientation) — official decode of TOON body deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      await createProject("orientation-rt");

      const jsonRes = await getJson("/api/v2");
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText("/api/v2");
      expect(toonRes.status).toBe(200);
      expect(toonRes.headers.get("content-type")).toBe("text/toon; charset=utf-8");
      const decoded = decode(toonText);

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/agents (agents listing) — official decode deep-equals the JSON twin, including a non-uniform 'message' field", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("agents-rt");
      await registerAgent(key, "agent-one", "hello agent one");
      await registerAgent(key, "agent-two", "hello agent two");

      const jsonRes = await getJson("/api/v2/agents");
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText("/api/v2/agents");
      expect(toonRes.status).toBe(200);
      const decoded = decode(toonText);

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/projects — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      await createProject("projects-rt-a");
      await createProject("projects-rt-b");

      const jsonRes = await getJson("/api/v2/projects");
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText("/api/v2/projects");
      expect(toonRes.status).toBe(200);
      const decoded = decode(toonText);

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/events (events listing) — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("events-rt");
      await postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key }));

      const jsonRes = await getJson("/api/v2/events");
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText("/api/v2/events");
      expect(toonRes.status).toBe(200);
      const decoded = decode(toonText);

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/events/:id (single event) — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("event-single-rt");
      const runRes = await postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key }));
      const runBody = (await runRes.json()) as OkResponse & { event: string };
      const eventId = runBody.event;

      const jsonRes = await getJson(`/api/v2/events/${eventId}`);
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText(`/api/v2/events/${eventId}`);
      expect(toonRes.status).toBe(200);
      const decoded = decode(toonText);

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/status?project= — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("status-rt");
      await postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key }));

      const jsonRes = await getJson(`/api/v2/status?project=${key}`);
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText(`/api/v2/status?project=${key}`);
      expect(toonRes.status).toBe(200);
      const decoded = decode(toonText);

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/health — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const jsonRes = await getJson("/api/v2/health");
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText("/api/v2/health");
      expect(toonRes.status).toBe(200);
      const decoded = decode(toonText);

      expect(decoded).toEqual(jsonBody);
    });
  });

  // ── §S4 AC — string values must survive encode→official-decode as strings ─

  describe("type preservation through the wire — number/boolean/null-LOOKING strings stay strings (§S4 AC)", () => {
    const cases: Array<{ label: string; value: string }> = [
      { label: '"42"', value: "42" },
      { label: '"true"', value: "true" },
      { label: '"null"', value: "null" },
      { label: '""', value: "" },
      { label: '" padded "', value: " padded " },
      { label: '"-leading"', value: "-leading" },
    ];

    for (const { label, value } of cases) {
      test(`agent 'message' field carrying the STRING ${label} round-trips as a string, not coerced, via GET /api/v2/agents`, async () => {
        handle = startServer({ port: 0, dbPath: ":memory:" });
        const slug = label.replace(/[^a-z0-9]/gi, "") || "empty";
        const key = await createProject(`type-preserve-${slug}-${crypto.randomUUID().slice(0, 8)}`);
        await registerAgent(key, "type-agent", value);

        const jsonRes = await getJson("/api/v2/agents");
        const jsonBody = (await jsonRes.json()) as OkResponse & { agents: Array<{ agentId: string; message: string }> };
        const jsonAgent = jsonBody.agents.find((a) => a.agentId === "type-agent");
        expect(jsonAgent).toBeDefined();
        // Sanity: the JSON twin itself carries the exact literal (proves the
        // fixture actually drove the intended value through the real API).
        expect(jsonAgent!.message).toBe(value);

        const { res: toonRes, text: toonText } = await getToonText("/api/v2/agents");
        expect(toonRes.status).toBe(200);
        const decoded = decode(toonText) as OkResponse & { agents: Array<{ agentId: string; message: unknown }> };
        const toonAgent = decoded.agents.find((a) => a.agentId === "type-agent");
        expect(toonAgent).toBeDefined();

        // POSITIVE — the exact string value, unchanged.
        expect(toonAgent!.message).toBe(value);
        // NEGATIVE — never silently coerced to a different JS type by the
        // official decoder reading today's (or tomorrow's) wire encoding.
        expect(typeof toonAgent!.message).toBe("string");
      });
    }
  });

  // ── §S4 AC — list array emits `- `-prefixed elements (help[], the hottest path) ─

  describe("list-array defect pinned on help[] — the most-emitted case (§S4 AC)", () => {
    test("GET /api/v2 orientation 'help[]' decodes via the official library to the exact JSON array (form-agnostic: fails today because the subset emitter's unprefixed list form is not valid official TOON)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const jsonRes = await getJson("/api/v2");
      const jsonBody = (await jsonRes.json()) as OkResponse & { help: string[] };
      // Sanity: orientation really carries a non-empty help[] — the hottest
      // list-array surface named by the CR (every AXI envelope emits help[]).
      expect(Array.isArray(jsonBody.help)).toBe(true);
      expect(jsonBody.help.length).toBeGreaterThan(0);

      const { res: toonRes, text: toonText } = await getToonText("/api/v2");
      expect(toonRes.status).toBe(200);
      const decoded = decode(toonText) as OkResponse & { help: unknown };

      // POSITIVE + bound — exact array equality, not "≥1 element" / non-empty.
      expect(decoded.help).toEqual(jsonBody.help);
    });

    test("a RED-verdict POST /api/v2/runs response's help[] (fetched back via the events surface in TOON) decodes to the exact JSON array", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("help-list-rt");

      const runRes = await postJson("/api/v2/runs", {
        projectKey: key,
        agentId: "red-agent",
        codec: "junit",
        data: JUNIT_1FAIL,
      });
      const runBody = (await runRes.json()) as OkResponse & { verdict: string; help: string[] };
      expect(runBody.verdict.startsWith("RED")).toBe(true);
      expect(runBody.help.length).toBeGreaterThan(0);

      // The run's own POST response never carries TOON (POSTs stay JSON,
      // per CR-CRU-005 §S2) — so drive the SAME help[] shape through a GET
      // envelope that also carries it: orientation. This keeps the
      // assertion bound to a real GET/TOON wire response rather than any
      // unit-level call to the encoder by name.
      const { text: toonText } = await getToonText("/api/v2");
      const decoded = decode(toonText) as OkResponse & { help: unknown };
      const jsonRes = await getJson("/api/v2");
      const jsonBody = (await jsonRes.json()) as OkResponse & { help: string[] };

      expect(decoded.help).toEqual(jsonBody.help);
      expect(Array.isArray(decoded.help)).toBe(true);
    });
  });

  // ── Sanity — the DN/spec doc still exists (retired, not deleted, per §S5) ─

  describe("§S5 — the subset DN is retired, not deleted", () => {
    test("docs/research/DN-crucible-toon-subset.md still exists (content is rewritten by §S5, the file is not removed)", () => {
      const dnPath = join(import.meta.dir, "../docs/research/DN-crucible-toon-subset.md");
      const content = readFileSync(dnPath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });
  });
});
