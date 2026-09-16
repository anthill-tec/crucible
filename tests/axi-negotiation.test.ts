// CR-CRU-005 §S3 — the help[] hints module — plus the integration guard
// that every v2 response routes through ONE shared response gate.
// Drives the REAL production server (startServer).
//
// THIS FILE WAS "§S2 (content negotiation) + §S3 (help[] hints module) + §S4
// (TOON truncation with pointer)". CR-CRU-132 §S2 deleted the §S2 and §S4
// halves — the six negotiation tests and the one truncation test — because
// the behaviour they pinned no longer exists.
//
// THE SUPERSEDED CLAIMS, named rather than silently dropped:
//
//   - CR-CRU-005 §S2 — "a v2 GET carrying `?fmt=toon`, or an `Accept` header
//     containing `toon`, is answered `text/toon; charset=utf-8`; the same URL
//     without it answers JSON; a POST stays JSON either way." SUPERSEDED BY
//     CR-CRU-132 §S1, which deletes the server's TOON rendering outright.
//     There is no negotiation left to pin, and a test re-pinned to "it now
//     answers JSON" would assert the absence of a feature rather than a
//     requirement. The contract that REPLACES it — a `?fmt=toon` GET is
//     INERT, answered in JSON, never refused — is pinned in
//     tests/v2-json-only-responses.test.ts.
//
//   - CR-CRU-005 §S4 — "a TOON body over 64 KB is shrunk by halving its
//     largest top-level array, stamped `truncated: true` beside a
//     `GET …?fmt=json` pointer at the untruncated variant." SUPERSEDED BY
//     the same deletion: the halving loop lived inside the TOON branch and
//     goes with it. JSON has never truncated, which CR-CRU-132 records as an
//     accepted, stated loss of a mitigation no caller was using.
//
// WHAT SURVIVES is everything that was never about the encoding: the five
// §S3 help[] hints tests — the AXI next-step hints the WHOLE API emits, on
// reads and writes alike — and the zero-`Response.json(` guard, which is MORE
// valuable after the deletion, not less: with one branch gone from `reply()`,
// the shared gate is the only thing keeping every response on one path.
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
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

describe("AXI help[] hints and the shared response gate (CR-CRU-005 §S3)", () => {
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

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as OkResponse & { project: { key: string } };
    return body.project.key;
  }

  // CR-CRU-056 §S2b fixture-repair (C3): /api/v2/runs and /api/v2/runs/parsed
  // now refuse an unregistered agentId (409) — each ingest-under fixture
  // agentId must be live registered first.
  async function registerAgent(key: string, agentId: string): Promise<void> {
    const res = await postJson("/api/v2/agents/register", { projectKey: key, agentId, role: "ORCHESTRATOR" });
    expect(res.status).toBe(200);
  }

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
        role: "report",
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
      await registerAgent(key, "red-agent");

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
        role: "report",
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse & { help?: string[] };
      expect(isNonEmptyStringArray(body.help)).toBe(true);
      expect((body.help as string[]).join(" ")).toContain("POST /api/v2/projects");
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
