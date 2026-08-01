// CR-CRU-044 C3 RED -- §S3 `--phase` hardening on the SIXTH register caller,
// `cli/crucible-axi.ts` (found live during C1 GREEN; not in this CR's
// original Context, called out explicitly in §S3's corrected 2026-07-28
// table at docs/changes/CR-CRU-044-phase-as-first-class-data.md:119-120).
//
// Spec (§S3): "`--phase` becomes required and enum-constrained uniformly...
// A missing `--phase` fails argument parsing with the accepted values
// listed," matching the five Python clients. This CLI is a thin manual
// argv-flag parser (`parseArgs` in cli/crucible-axi.ts) with NO argparse —
// today `commandAgentVerb`'s register branch (`cli/crucible-axi.ts:200-203`)
// silently defaults phase to `"report"` when `--phase` is omitted and never
// validates the value client-side; the ONLY validation today happens
// server-side (§S1, already landed in C1) via a REAL network round-trip
// (POST /api/v2/agents/register gets a 400 back for an invalid phase).
//
// RED phase, confirmed LIVE against a real ephemeral startServer():
//   - missing --phase: exits 0 today (client fills in "report", server
//     accepts it) -- code must become non-zero once --phase is required.
//   - --phase banana: ALREADY exits non-zero today (the server's existing
//     §S1 validation 400s and postJson surfaces it) -- so a bare
//     "non-zero exit + enum listed" assertion would be VACUOUSLY PASSING,
//     not a new test. The genuinely new §S3 contract for THIS client is
//     CLIENT-SIDE rejection: no network round-trip at all for an
//     out-of-enum value. Confirmed live: today the POST DOES fire (a
//     capturingFetch sees the call) before the server's 400 comes back --
//     this test's "no request was ever sent" assertion fails against
//     today's implementation, which is real RED.
//
// Uses a REAL ephemeral startServer({ port: 0, dbPath: ":memory:" }) --
// never the live :3849 dashboard -- mirroring tests/cli-axi.test.ts's own
// convention (this file intentionally does not import from that sibling;
// small helpers are duplicated verbatim per that file's own documented
// convention of copying the module-loading/mocking pattern rather than
// sharing test-only helpers across files).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

const CLI_MODULE_PATH = "../cli/crucible-axi.ts";

interface RunCliOpts {
  argv: string[];
  baseUrl: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  stdin?: { text(): Promise<string> };
  fetchImpl?: typeof fetch;
}

type RunCliFn = (opts: RunCliOpts) => Promise<number>;

async function loadCli(): Promise<{ runCli: RunCliFn }> {
  return import(CLI_MODULE_PATH) as Promise<{ runCli: RunCliFn }>;
}

interface CapturedCall {
  url: string;
  method: string;
}

function capturingFetch(): { calls: CapturedCall[]; fetchImpl: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    return fetch(input as RequestInfo, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function captureStream(): { write(chunk: string): void; text: string } {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
    },
  };
}

async function createProject(baseUrl: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v2/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json()) as { project: { key: string } };
  return body.project.key;
}

const PHASE_ENUM = ["RED", "GREEN", "FIX", "VERIFY", "ORCHESTRATOR", "report"];

describe("crucible-axi CLI §S3 — --phase hardening on the sixth register caller (CR-CRU-044 C3)", () => {
  let handle: ReturnType<typeof startServer> | undefined;
  const scratchDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  test("omitting --phase now fails (non-zero, enum listed) but a valid --phase still round-trips", async () => {
    const { runCli } = await loadCli();
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-phase-required-project");
    const { calls, fetchImpl } = capturingFetch();

    // Missing --phase: today this exits 0 (client defaults to "report").
    // Would ALSO pass against a no-op stub that never validates anything --
    // fails today for the RIGHT reason (no requiredness enforced yet).
    const missingCode = await runCli({
      argv: ["register", "--project-key", key, "--agent", "cli-phase-missing"],
      baseUrl,
      cwd: scratchDir("cli-phase-missing-"),
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl,
    });
    const stderrMissing = captureStream();
    const rerunOut = captureStream();
    const missingCode2 = await runCli({
      argv: ["register", "--project-key", key, "--agent", "cli-phase-missing-2"],
      baseUrl,
      cwd: scratchDir("cli-phase-missing2-"),
      stdout: rerunOut,
      stderr: stderrMissing,
      fetchImpl,
    });
    expect(missingCode).not.toBe(0);
    expect(missingCode2).not.toBe(0);
    for (const value of PHASE_ENUM) {
      expect(stderrMissing.text).toContain(value);
    }
    expect(
      calls.some((c) => c.method === "POST" && c.url.includes("/api/v2/agents/register")),
    ).toBe(false);

    // A VALID --phase must still work end-to-end (the C1 wire behaviour must
    // not regress) and round-trip the EXACT declared phase via the agents API.
    // CR-CRU-056 C2 final sweep: this test's subject is the --phase FLAG's
    // presence/validation round-trip, not the GREEN TDD phase's cycle-binding
    // requirement (§S2, out of scope for this file) — "report" registers
    // unbound so the assertion stays exactly as strong without an incidental
    // plan/cycle fixture.
    const { calls: validCalls, fetchImpl: validFetch } = capturingFetch();
    const validCode = await runCli({
      argv: ["register", "--project-key", key, "--agent", "cli-phase-valid", "--phase", "report"],
      baseUrl,
      cwd: scratchDir("cli-phase-valid-"),
      stdout: captureStream(),
      stderr: captureStream(),
      fetchImpl: validFetch,
    });
    expect(validCode).toBe(0);
    expect(
      validCalls.some((c) => c.method === "POST" && c.url.includes("/api/v2/agents/register")),
    ).toBe(true);

    const listRes = await fetch(`${baseUrl}/api/v2/agents?project=${key}`);
    const listBody = (await listRes.json()) as { agents: Array<{ agentId: string; phase?: string }> };
    const agent = listBody.agents.find((a) => a.agentId === "cli-phase-valid");
    expect(agent).toBeDefined();
    expect(agent!.phase).toBe("report");
  });

  test("an out-of-enum --phase is rejected CLIENT-SIDE — no network round-trip at all", async () => {
    const { runCli } = await loadCli();
    handle = startServer({ port: 0, dbPath: ":memory:" });
    const baseUrl = `http://localhost:${handle.server.port}`;
    const key = await createProject(baseUrl, "cli-phase-enum-project");
    const { calls, fetchImpl } = capturingFetch();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["register", "--project-key", key, "--agent", "cli-phase-banana", "--phase", "banana"],
      baseUrl,
      cwd: scratchDir("cli-phase-banana-"),
      stdout: captureStream(),
      stderr,
      fetchImpl,
    });

    expect(code).not.toBe(0);
    for (const value of PHASE_ENUM) {
      expect(stderr.text).toContain(value);
    }
    // The genuinely NEW §S3 contract for this client: reject BEFORE making
    // any HTTP call, matching the argparse-level rejection the five Python
    // clients already do. Today the POST fires and only the SERVER's
    // existing §S1 validation catches it -- this assertion fails against
    // that current behaviour.
    expect(
      calls.some((c) => c.method === "POST" && c.url.includes("/api/v2/agents/register")),
    ).toBe(false);
  });
});
