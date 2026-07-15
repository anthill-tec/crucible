// CR-CRU-010 §S1 — Path-capable Codec interface: `Codec` gains optional
// `parsePath?(path: string): Promise<RunSchema>`; the `junit` registry entry
// registers `parseJunitPath`. Both ingest routes resolve `dataPath` THROUGH
// the registry entry — `parseRunBody` (src/codecs/index.ts) calls
// `codec.parsePath` instead of special-casing `parseJunitPath`. A codec
// without `parsePath` given a `dataPath` request → 400 naming the codec.
//
// RED phase: `codecs.get("junit")!.parsePath` does not exist yet (Codec only
// has `parse` today) and `parseRunBody` still calls `parseJunitPath` directly
// regardless of which codec was resolved — every test below is expected to
// FAIL until GREEN implements §S1. Accesses to the not-yet-existing
// `parsePath` field go through an `unknown`-cast helper so this file stays
// tsc-clean both before and after GREEN (the Codec interface itself is
// production code and is not touched here).
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";
import { codecs } from "../src/codecs/index.ts";
import type { Codec } from "../src/codecs/index.ts";
import type { RunSchema } from "../src/types.ts";

/** Runtime-only view of a codec's optional parsePath — avoids depending on
 * the Codec interface already declaring `parsePath` (that's GREEN's job),
 * so this file type-checks cleanly in both RED and GREEN. */
function parsePathOf(codec: Codec | undefined): ((path: string) => Promise<RunSchema>) | undefined {
  return (codec as unknown as { parsePath?: (path: string) => Promise<RunSchema> } | undefined)
    ?.parsePath;
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "codec-parsepath-"));
}

const JUNIT_2CASE_ALLPASS = [
  '<testsuite name="SuiteA" tests="2">',
  '<testcase name="a1" time="0.1"/>',
  '<testcase name="a2" time="0.1"/>',
  "</testsuite>",
].join("\n");

/** Extract a top-level function's full `{ ... }` body via brace counting —
 * robust to whatever internal shape GREEN gives parseRunBody. */
function extractFunctionBody(source: string, signatureStart: string): string {
  const sigIndex = source.indexOf(signatureStart);
  if (sigIndex === -1) {
    throw new Error(`signature not found in source: ${signatureStart}`);
  }
  const braceStart = source.indexOf("{", sigIndex);
  if (braceStart === -1) {
    throw new Error(`no opening brace found after signature: ${signatureStart}`);
  }
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces while extracting function: ${signatureStart}`);
}

describe("Codec.parsePath interface — CR-CRU-010 §S1", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  let tmpDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs = [];
    codecs.delete("stub-nopath");
  });

  function seedProjectV1(): string {
    const key = crypto.randomUUID();
    handle!.store.addProject({ key, name: "p", type: "backend", sutRoot: "/tmp" });
    return key;
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createProjectV2(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as { ok: true; project: { key: string } };
    return body.project.key;
  }

  test("codecs.get('junit')!.parsePath is a function", () => {
    const junitCodec = codecs.get("junit");
    expect(junitCodec).toBeDefined();
    expect(typeof parsePathOf(junitCodec)).toBe("function");
  });

  test("junit codec's parsePath(dir) resolves the same RunSchema as parsing the file directly (delegate check)", async () => {
    const dir = freshDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, "TEST-a.xml"), JUNIT_2CASE_ALLPASS);

    const junitCodec = codecs.get("junit");
    expect(junitCodec).toBeDefined();
    const parsePathFn = parsePathOf(junitCodec);
    expect(typeof parsePathFn).toBe("function");

    const run = await parsePathFn!(dir);
    expect(run.summary).toEqual({ total: 2, passed: 2, failed: 0, pending: 0, duration_ms: 20 });
  });

  test("registry-only resolution: server.ts/v2.ts never reference parseJunitPath; parseRunBody's body contains no parseJunitPath call; index.ts's only non-import occurrence is the junit registry entry's parsePath registration", () => {
    const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const v2Src = readFileSync(new URL("../src/v2.ts", import.meta.url), "utf8");
    expect(serverSrc).not.toContain("parseJunitPath");
    expect(v2Src).not.toContain("parseJunitPath");

    const codecsSrc = readFileSync(new URL("../src/codecs/index.ts", import.meta.url), "utf8");

    const parseRunBodyBody = extractFunctionBody(codecsSrc, "export async function parseRunBody");
    expect(parseRunBodyBody).not.toContain("parseJunitPath");

    // Excluding import lines, exactly one line in the file should still
    // mention parseJunitPath — the registry entry's parsePath registration.
    const nonImportOccurrences = codecsSrc
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("import") && line.includes("parseJunitPath"));
    expect(nonImportOccurrences.length).toBe(1);

    // That surviving occurrence lives inside the codecs Map literal, and the
    // literal now carries a parsePath key (not just parse).
    const mapStart = codecsSrc.indexOf("export const codecs");
    expect(mapStart).toBeGreaterThanOrEqual(0);
    const mapEnd = codecsSrc.indexOf("]);", mapStart);
    expect(mapEnd).toBeGreaterThan(mapStart);
    const mapLiteral = codecsSrc.slice(mapStart, mapEnd);
    expect(mapLiteral).toContain("parseJunitPath");
    expect(mapLiteral).toContain("parsePath");
  });

  test("400: dataPath request through a codec without parsePath names the codec (v1 POST /api/ingest)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const pk = seedProjectV1();
    const dir = freshDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, "TEST-a.xml"), JUNIT_2CASE_ALLPASS);

    codecs.set("stub-nopath", { parse: (data: string) => JSON.parse(data) as RunSchema });

    const res = await postJson("/api/ingest", {
      projectKey: pk,
      format: "stub-nopath",
      dataPath: dir,
      agentId: "a1",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("stub-nopath");
  });

  test("400: dataPath request through a codec without parsePath names the codec (v2 POST /api/v2/runs)", async () => {
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const key = await createProjectV2("parsepath-stub-v2");
    const dir = freshDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, "TEST-a.xml"), JUNIT_2CASE_ALLPASS);

    codecs.set("stub-nopath", { parse: (data: string) => JSON.parse(data) as RunSchema });

    const res = await postJson("/api/v2/runs", {
      projectKey: key,
      codec: "stub-nopath",
      dataPath: dir,
      agentId: "a1",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("stub-nopath");
  });
});
