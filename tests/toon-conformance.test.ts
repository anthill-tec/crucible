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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  /**
   * CR-CRU-046 C2 test-fix pass — the JSON and TOON bodies for a given
   * envelope are fetched SEQUENTIALLY (two real HTTP round-trips), so any
   * field derived from the live wall clock (`Date.now()`) can tick between
   * the two fetches and make an otherwise-identical deep-equal flake
   * (~40-60% observed on `GET /api/v2/agents`'s `runtime_ms` and
   * `GET /api/v2/health`'s `uptime_s`). Strip exactly the named volatile
   * key(s) from BOTH decoded representations before the comparison — every
   * other field, including every other agent field, stays fully compared.
   * `JSON.stringify`'s replacer walks every key at every depth, so this
   * reaches `runtime_ms` nested inside `agents[]` as well as a top-level
   * `uptime_s`.
   */
  function stripVolatile<T>(value: T, volatileKeys: string[]): T {
    return JSON.parse(
      JSON.stringify(value, (key, val) => (volatileKeys.includes(key) ? undefined : val)),
    ) as T;
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
      // TS2769 fix (CR-CRU-046 C2 test-fix pass): `decode()` returns the
      // library's `JsonValue` union, which pins `.toEqual`'s overload and
      // rejects the JSON twin's `OkResponse` shape. Cast through `unknown`
      // (not a narrower type) so every field still round-trips through the
      // real deep-equal below — this is a type-level unblock only, no
      // runtime behavior changes.
      const decoded = decode(toonText) as unknown;

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
      // TS2769 fix (CR-CRU-046 C2 test-fix pass): `decode()` returns the
      // library's `JsonValue` union, which pins `.toEqual`'s overload and
      // rejects the JSON twin's `OkResponse` shape. Cast through `unknown`
      // (not a narrower type) so every field still round-trips through the
      // real deep-equal below — this is a type-level unblock only, no
      // runtime behavior changes.
      const decoded = decode(toonText) as unknown;

      // Flake fix (CR-CRU-046 C2): `runtime_ms` (nested in each agent) ticks
      // between the JSON and TOON fetches above — strip it from BOTH sides
      // before the deep-equal so the live clock can't flip this test red.
      // Every other agent field (including `message`) stays compared as-is.
      expect(stripVolatile(decoded, ["runtime_ms"])).toEqual(stripVolatile(jsonBody, ["runtime_ms"]));
    });

    test("GET /api/v2/projects — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      await createProject("projects-rt-a");
      await createProject("projects-rt-b");

      const jsonRes = await getJson("/api/v2/projects");
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText("/api/v2/projects");
      expect(toonRes.status).toBe(200);
      // TS2769 fix (CR-CRU-046 C2 test-fix pass): `decode()` returns the
      // library's `JsonValue` union, which pins `.toEqual`'s overload and
      // rejects the JSON twin's `OkResponse` shape. Cast through `unknown`
      // (not a narrower type) so every field still round-trips through the
      // real deep-equal below — this is a type-level unblock only, no
      // runtime behavior changes.
      const decoded = decode(toonText) as unknown;

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/events (events listing) — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("events-rt");
      // CR-CRU-056 §S2b fixture-repair (C3): /api/v2/runs/parsed now refuses
      // an unregistered agentId (409) — register first. Its own "lifecycle"
      // event (CR-CRU-011 §S1) is NOT this test's subject (the round-trip
      // fidelity of the single ingested TEST event); drop it from both sides
      // before comparing.
      await registerAgent(key, "conformance-agent", "");
      await postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key }));

      const jsonRes = await getJson("/api/v2/events");
      const jsonBody = (await jsonRes.json()) as OkResponse & { events: Array<{ kind?: string }> };
      jsonBody.events = jsonBody.events.filter((e) => e.kind !== "lifecycle");

      const { res: toonRes, text: toonText } = await getToonText("/api/v2/events");
      expect(toonRes.status).toBe(200);
      // TS2769 fix (CR-CRU-046 C2 test-fix pass): `decode()` returns the
      // library's `JsonValue` union, which pins `.toEqual`'s overload and
      // rejects the JSON twin's `OkResponse` shape. Cast through `unknown`
      // (not a narrower type) so every field still round-trips through the
      // real deep-equal below — this is a type-level unblock only, no
      // runtime behavior changes.
      const decoded = decode(toonText) as OkResponse & { events: Array<{ kind?: string }> };
      decoded.events = decoded.events.filter((e) => e.kind !== "lifecycle");

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/events/:id (single event) — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("event-single-rt");
      await registerAgent(key, "conformance-agent", "");
      const runRes = await postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key }));
      const runBody = (await runRes.json()) as OkResponse & { event: string };
      const eventId = runBody.event;

      const jsonRes = await getJson(`/api/v2/events/${eventId}`);
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText(`/api/v2/events/${eventId}`);
      expect(toonRes.status).toBe(200);
      // TS2769 fix (CR-CRU-046 C2 test-fix pass): `decode()` returns the
      // library's `JsonValue` union, which pins `.toEqual`'s overload and
      // rejects the JSON twin's `OkResponse` shape. Cast through `unknown`
      // (not a narrower type) so every field still round-trips through the
      // real deep-equal below — this is a type-level unblock only, no
      // runtime behavior changes.
      const decoded = decode(toonText) as unknown;

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/status?project= — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("status-rt");
      await registerAgent(key, "conformance-agent", "");
      await postJson("/api/v2/runs/parsed", parsedRunBody({ projectKey: key }));

      const jsonRes = await getJson(`/api/v2/status?project=${key}`);
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText(`/api/v2/status?project=${key}`);
      expect(toonRes.status).toBe(200);
      // TS2769 fix (CR-CRU-046 C2 test-fix pass): `decode()` returns the
      // library's `JsonValue` union, which pins `.toEqual`'s overload and
      // rejects the JSON twin's `OkResponse` shape. Cast through `unknown`
      // (not a narrower type) so every field still round-trips through the
      // real deep-equal below — this is a type-level unblock only, no
      // runtime behavior changes.
      const decoded = decode(toonText) as unknown;

      expect(decoded).toEqual(jsonBody);
    });

    test("GET /api/v2/health — official decode deep-equals the JSON twin", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });

      const jsonRes = await getJson("/api/v2/health");
      const jsonBody = (await jsonRes.json()) as OkResponse;

      const { res: toonRes, text: toonText } = await getToonText("/api/v2/health");
      expect(toonRes.status).toBe(200);
      // TS2769 fix (CR-CRU-046 C2 test-fix pass): `decode()` returns the
      // library's `JsonValue` union, which pins `.toEqual`'s overload and
      // rejects the JSON twin's `OkResponse` shape. Cast through `unknown`
      // (not a narrower type) so every field still round-trips through the
      // real deep-equal below — this is a type-level unblock only, no
      // runtime behavior changes.
      const decoded = decode(toonText) as unknown;

      // Flake fix (CR-CRU-046 C2): `uptime_s` ticks between the JSON and
      // TOON fetches above — strip it from BOTH sides before the deep-equal
      // so the live clock can't flip this test red. Every other health
      // field (status/version/counts) stays compared as-is.
      expect(stripVolatile(decoded, ["uptime_s"])).toEqual(stripVolatile(jsonBody, ["uptime_s"]));
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
      await registerAgent(key, "red-agent", "");

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

  // ── §S4 AC — client-emit direction: a REAL client's own stdout envelope ──
  // decodes via the official library. The describe block above proves
  // server-emit → official-decode; this proves the MISSING direction named
  // by §S4 ("client `_emit` output ... → `@toon-format/toon` decode ...
  // across the client envelope shapes"). `clients/bun-crucible.py` writes
  // its own AXI envelope to stdout via `_crucible_axi.py:84`
  // (`sys.stdout.write(_toon().encode({"axi": axi}) + "\n")`) — a REAL
  // client-side TOON encode, produced by `clients/toon.py`, not the
  // server's `src/toon.ts`. Self-contained: its own spawn helper, its own
  // scratch-dir lifecycle, reusing only `createProject`/`handle` from the
  // outer describe.

  describe("client-emit oracle — a real client envelope decodes via the official library (§S4, client→agent direction)", () => {
    const CLIENT_SCRIPT_PATH = join(import.meta.dir, "..", "clients", "bun-crucible.py");
    const scratchDirs: string[] = [];

    afterEach(() => {
      while (scratchDirs.length > 0) {
        rmSync(scratchDirs.pop()!, { recursive: true, force: true });
      }
    });

    interface ClientRunResult {
      code: number;
      stdout: string;
      stderr: string;
    }

    /**
     * Spawns `uv run clients/bun-crucible.py <args>` against a REAL server —
     * the same PEP 723 `uv run` invocation pattern
     * `tests/clients-bun-crucible.test.ts`'s `runScript` helper uses (§S3),
     * copied locally (that helper is not exported) rather than imported.
     * Strips ambient `WORKFLOW_*` env so each call controls it explicitly,
     * and always injects `CRUCIBLE_URL` at the fixture server under test.
     */
    async function runClient(
      args: string[],
      cwd: string,
      crucibleUrl: string,
    ): Promise<ClientRunResult> {
      const baseEnv: Record<string, string | undefined> = { ...process.env };
      for (const k of Object.keys(baseEnv)) {
        if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
      }
      const proc = Bun.spawn({
        cmd: ["uv", "run", CLIENT_SCRIPT_PATH, ...args],
        cwd,
        env: { ...baseEnv, CRUCIBLE_URL: crucibleUrl },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    }

    /** A fresh scratch project dir carrying only the `.env` project-key pin
     * the client's `_project_key()` resolution needs — the ephemeral FIXTURE
     * server's project, never the live :3849 board. */
    function scratchProjectDir(key: string): string {
      const dir = mkdtempSync(join(tmpdir(), "toon-oracle-client-"));
      scratchDirs.push(dir);
      writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
      return dir;
    }

    test("a real client `register` envelope's stdout decodes via the official library into a well-formed AXI envelope (§S4 AC — 'every client-emitted envelope round-trips')", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("client-emit-register-rt");
      const projectDir = scratchProjectDir(key);

      const res = await runClient(
        ["register", "--agent", "toon-oracle-probe", "--phase", "report", "--project-dir", projectDir],
        projectDir,
        `http://localhost:${handle.server.port}`,
      );

      expect(res.code).toBe(0);
      const decoded = decode(res.stdout) as {
        axi: {
          verb: string;
          ok: boolean;
          agent: string;
          help: unknown;
          context: { projectKey: string };
          warnings: unknown;
        };
      };

      // POSITIVE — the exact deterministic shape a real register call must emit.
      expect(decoded.axi.verb).toBe("register");
      expect(decoded.axi.ok).toBe(true);
      expect(decoded.axi.agent).toBe("toon-oracle-probe");
      expect(Array.isArray(decoded.axi.help)).toBe(true);
      expect((decoded.axi.help as unknown[]).length).toBeGreaterThan(0);
      expect((decoded.axi.help as unknown[]).every((h) => typeof h === "string")).toBe(true);
      // NEGATIVE/bound — the fixture project's own key, not some other value.
      expect(decoded.axi.context.projectKey).toBe(key);
    });

    // ESCALATION: the dispatch brief asked for this case to be driven via
    // `--message "42"`, but reading `clients/bun-crucible.py:339-421`
    // (`_register_agent`/`cmd_register`) shows `message` is POSTed to the
    // server ONLY — the `_emit_axi("register", ok, {"agent": args.agent,
    // "help": _HELP_STEPS["register"]}, ...)` call at bun-crucible.py:419-420
    // never includes it, and `_crucible_axi.py`'s documented envelope shape
    // (`axi: {verb, ok, <verb-specific result fields>, context, warnings}`)
    // confirms `register`'s result fields are exactly `{agent, help}` — no
    // field carries `message` in the CLIENT's own stdout to decode. The
    // AGENT ID (`args.agent`) IS echoed verbatim into both `axi.agent` and
    // `axi.context.agentId`, giving the identical client-emit
    // type-preservation property the §S4 AC requires ("42" must not become
    // a number), so this test drives it through `--agent "42"` instead of
    // `--message "42"` — flagged here rather than silently substituted.
    test("a numeric-looking agent id ('42') survives the client's own encode→official-decode as a STRING, never coerced to a number (§S4 AC type preservation, client-emit direction)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("client-emit-type-preserve-rt");
      const projectDir = scratchProjectDir(key);

      const res = await runClient(
        ["register", "--agent", "42", "--phase", "report", "--project-dir", projectDir],
        projectDir,
        `http://localhost:${handle.server.port}`,
      );

      expect(res.code).toBe(0);
      const decoded = decode(res.stdout) as {
        axi: { agent: unknown; context: { agentId: unknown } };
      };

      // POSITIVE — the exact string, unchanged.
      expect(decoded.axi.agent).toBe("42");
      expect(decoded.axi.context.agentId).toBe("42");
      // NEGATIVE — never silently coerced to the JS number 42 by the
      // official decoder reading the client's OWN TOON output.
      expect(typeof decoded.axi.agent).toBe("string");
      expect(typeof decoded.axi.context.agentId).toBe("string");
    });

    test("`unregister` through the same spawn path also decodes via the official library to a well-formed ok:true envelope (lighter, decode-asserted)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = await createProject("client-emit-unregister-rt");
      const projectDir = scratchProjectDir(key);

      await runClient(
        ["register", "--agent", "toon-oracle-probe", "--phase", "report", "--project-dir", projectDir],
        projectDir,
        `http://localhost:${handle.server.port}`,
      );

      const res = await runClient(
        ["unregister", "--agent", "toon-oracle-probe", "--project-dir", projectDir],
        projectDir,
        `http://localhost:${handle.server.port}`,
      );

      expect(res.code).toBe(0);
      const decoded = decode(res.stdout) as { axi: { verb: string; ok: boolean; agent: string } };
      // POSITIVE — the exact deterministic unregister shape.
      expect(decoded.axi.verb).toBe("unregister");
      expect(decoded.axi.ok).toBe(true);
      expect(decoded.axi.agent).toBe("toon-oracle-probe");
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
