// CR-CRU-126 §S3 — a plans GET that exceeds the fleet's 10s read bound is a
// LEGIBLE failure, not a traceback.
//
// `clients/python-crucible.py`'s `_get(path, timeout=10)` bounds the read path
// (CR-CRU-035 §S1). `urllib` reports a read-phase timeout as a bare
// `TimeoutError`, which is NOT a `urllib.error.URLError` — so the shared
// transport's `except URLError` never sees it, `run_verb` (which converts only
// three typed hard stops) never sees it either, and the verb dies with an
// unhandled traceback and no envelope. That is how every cycle transition failed
// in the 2026-09-12 session, forcing direct route PATCHes.
//
// The bound itself is NOT being tuned (§S3, user ruling: fix the performance,
// not the symptom) — so each test also pins the WAIT: the client must still have
// waited its 10 seconds before reporting, which is what makes "the timeout value
// is unchanged" an assertion rather than a promise.
//
// The stall server is GET-stalling by construction, so no real board is touched
// and nothing is written anywhere.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLIENT = join(import.meta.dir, "..", "clients", "python-crucible.py");

/** The client's own hook-safe read bound (`_get(path, timeout=10)`). */
const clientReadTimeoutMs = 10_000;

/** Slack around the bound: enough for interpreter start-up, far short of 2x. */
const waitSlackMs = 5_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

let stopStall: (() => void) | undefined;
const scratchDirs: string[] = [];

afterEach(() => {
  stopStall?.();
  stopStall = undefined;
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A board that ACCEPTS the connection and then never answers — the slow-board
 * shape this CR is about, and the one that produces a read-phase `TimeoutError`
 * rather than a connect-phase `URLError`. Every in-flight handler is released on
 * teardown so no timer outlives the test.
 */
function startStalledBoard(): string {
  const held: Array<() => void> = [];
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  stopStall = () => {
    for (const release of held.splice(0)) release();
    server.stop(true);
  };
  return `http://localhost:${server.port}`;
}

/** A project dir carrying only the `.env` the client resolves its key from. */
function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cru126-timeout-"));
  scratchDirs.push(dir);
  writeFileSync(join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${crypto.randomUUID()}\n`);
  return dir;
}

async function runVerb(args: string[], crucibleUrl: string, cwd: string): Promise<RunResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("WORKFLOW_")) delete env[name];
  }
  const started = Date.now();
  const proc = Bun.spawn({
    cmd: ["uv", "run", CLIENT, ...args],
    cwd,
    env: { ...env, CRUCIBLE_URL: crucibleUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr, elapsedMs: Date.now() - started };
}

function assertTimeoutEnvelope(verb: string, result: RunResult): void {
  // The fleet's standard refusal shape — the same one `resolve_plan_or_emit`
  // already produces for an unreadable plan board, on stdout, under this verb.
  expect(result.stdout).toContain(`verb: ${verb}`);
  expect(result.stdout).toContain("ok: false");
  // ...NAMING the condition: a reader of the envelope alone learns the board
  // did not answer in time, not merely that something went wrong.
  expect(result.stdout).toMatch(/tim(ed )?out|timeout/i);
  // A refusal exits non-zero, so a scripted caller stops.
  expect(result.code).not.toBe(0);
  // And nothing leaks the interpreter's own stack on either stream.
  expect(result.stdout).not.toContain("Traceback (most recent call last)");
  expect(result.stderr).not.toContain("Traceback (most recent call last)");
  // The VALUE is unchanged (§S3: legibility, not tuning): the client really
  // waited its 10s bound before reporting.
  expect(result.elapsedMs).toBeGreaterThanOrEqual(clientReadTimeoutMs - 1_000);
  expect(result.elapsedMs).toBeLessThan(clientReadTimeoutMs + waitSlackMs);
}

describe("a plans GET that times out is reported as an envelope (CR-CRU-126 §S3)", () => {
  test("cycle-activate against a board that never answers emits the ok:false envelope naming the timeout, exits non-zero, and prints no traceback", async () => {
    const board = startStalledBoard();
    const dir = projectDir();

    const result = await runVerb(
      ["cycle-activate", "4321", "--agent", "CR-CRU-126-FIXTURE", "--project-dir", dir],
      board,
      dir,
    );

    assertTimeoutEnvelope("cycle-activate", result);
  }, 60_000);

  test("cycle-done against a board that never answers emits the ok:false envelope naming the timeout, exits non-zero, and prints no traceback", async () => {
    const board = startStalledBoard();
    const dir = projectDir();

    const result = await runVerb(
      ["cycle-done", "4321", "--agent", "CR-CRU-126-FIXTURE", "--project-dir", dir],
      board,
      dir,
    );

    assertTimeoutEnvelope("cycle-done", result);
  }, 60_000);
});
