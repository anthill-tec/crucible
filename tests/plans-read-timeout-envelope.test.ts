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
// That wait is measured BOARD-SIDE — from the instant the stalled board
// receives the request to the instant the client exits — so `uv`/interpreter
// bootstrap cannot pad it into passing, and the stalled board holds the
// connection open indefinitely (`idleTimeout: 0`) so the client's own bound is
// the only clock the assertion can be reading.
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

/** Upper slack around the bound: generous, but far short of 2x. */
const waitSlackMs = 5_000;

/** Lower slack. A client whose timer merely drifts loses milliseconds; a
 *  client that stopped waiting its bound loses whole seconds. */
const waitToleranceMs = 1_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** spawn -> exit, INCLUDING `uv`/interpreter bootstrap. Diagnostic only:
   *  bootstrap can only INFLATE it, so it can never be the wait pin. */
  elapsedMs: number;
  /** `Date.now()` at process exit, paired with the board's first-request
   *  stamp to measure the client's OWN read phase. */
  exitedAtMs: number;
}

/** The stalled board, plus what it OBSERVED. A failing test is entitled to
 *  know whether the client ever reached the board at all: no request means a
 *  CONNECT-phase failure, which is a different defect from the read-phase
 *  timeout this file is about. */
interface StalledBoard {
  url: string;
  requestCount: number;
  /** `Date.now()` when the board received the client's FIRST request — the
   *  instant its read phase begins. `undefined` = nothing ever arrived. */
  firstRequestAtMs?: number;
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
function startStalledBoard(): StalledBoard {
  const held: Array<() => void> = [];
  const board: StalledBoard = { url: "", requestCount: 0 };
  const server = Bun.serve({
    port: 0,
    // The board must outlast the client's bound, or the test races its own
    // fixture. `Bun.serve`'s DEFAULT `idleTimeout` is 10 SECONDS — the very
    // value the client waits — so by default the board aborts the held request
    // at the same instant the client is deciding to time out, and which clock
    // wins is decided by load. MEASURED, full-suite run 2026-09-12: the board
    // won at readPhaseMs=8452, closed the socket, and the client died of
    // `http.client.RemoteDisconnected` — an unhandled NON-timeout error with
    // EMPTY stdout, i.e. a failure of the fixture wearing the costume of the
    // defect under test. Disabling the board's timer leaves the client's own
    // bound as the only clock in the test, which is the thing being pinned.
    idleTimeout: 0,
    async fetch() {
      board.requestCount += 1;
      board.firstRequestAtMs ??= Date.now();
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
  board.url = `http://localhost:${server.port}`;
  return board;
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
  const exitedAtMs = Date.now();
  return { code, stdout, stderr, elapsedMs: exitedAtMs - started, exitedAtMs };
}

/** One stream, bounded, but never silently emptied — an "(empty)" that says so
 *  is itself the diagnosis (it is exactly what a killed connection produces). */
function stream(label: string, text: string): string {
  const limit = 1_500;
  const body = text.length === 0
    ? "(empty)"
    : text.length <= limit
      ? text
      : `${text.slice(0, limit / 2)}\n…[${text.length - limit} chars elided]…\n${text.slice(-limit / 2)}`;
  return `--- ${label} (${text.length} chars) ---\n${body}`;
}

/**
 * What the run ACTUALLY did, attached to every assertion below. bun's JUnit
 * reporter writes a bare `<failure/>`, so an assertion that does not say what
 * it saw is undiagnosable from the ingested report — which is precisely how
 * the 2026-09-12 full-suite failures of this file cost a whole session.
 */
function diagnose(verb: string, result: RunResult, board: StalledBoard): string {
  const waited = readPhaseMs(result, board);
  return [
    `[${verb}] code=${result.code}`
    + ` elapsedMs=${result.elapsedMs} (spawn→exit, includes uv/interpreter bootstrap)`
    + ` readPhaseMs=${waited ?? "n/a"} (board received request→exit)`
    + ` boardRequests=${board.requestCount}`,
    stream("stdout", result.stdout),
    stream("stderr", result.stderr),
  ].join("\n");
}

/** The client's OWN wait: board-side request arrival → process exit. Excludes
 *  `uv`/interpreter bootstrap, which `elapsedMs` cannot, so this — and only
 *  this — can honestly pin "the client waited its bound". */
function readPhaseMs(result: RunResult, board: StalledBoard): number | undefined {
  if (board.firstRequestAtMs === undefined) return undefined;
  return result.exitedAtMs - board.firstRequestAtMs;
}

function assertTimeoutEnvelope(verb: string, result: RunResult, board: StalledBoard): void {
  const diag = diagnose(verb, result, board);
  // The fleet's standard refusal shape — the same one `resolve_plan_or_emit`
  // already produces for an unreadable plan board, on stdout, under this verb.
  expect(result.stdout, `${diag}\n\nexpected the ${verb} AXI envelope on stdout`).toContain(`verb: ${verb}`);
  expect(result.stdout, `${diag}\n\nexpected the envelope to REFUSE (ok: false)`).toContain("ok: false");
  // ...NAMING the condition: a reader of the envelope alone learns the board
  // did not answer in time, not merely that something went wrong.
  expect(result.stdout, `${diag}\n\nexpected the envelope to NAME the timeout`).toMatch(/tim(ed )?out|timeout/i);
  // A refusal exits non-zero, so a scripted caller stops.
  expect(result.code, `${diag}\n\nexpected a non-zero exit so a scripted caller stops`).not.toBe(0);
  // And nothing leaks the interpreter's own stack on either stream.
  expect(result.stdout, `${diag}\n\nstdout leaked an interpreter traceback`).not.toContain("Traceback (most recent call last)");
  expect(result.stderr, `${diag}\n\nstderr leaked an interpreter traceback`).not.toContain("Traceback (most recent call last)");
  // The read phase is the only honest clock for the wait pin, and its absence
  // is itself a distinct, named defect: a client that never reached the board
  // failed in the CONNECT phase and never exercised the read bound at all.
  expect(board.requestCount, `${diag}\n\nthe stalled board never received a request — this run failed in the CONNECT phase and never exercised the read bound under test`).toBeGreaterThan(0);
  const waited = readPhaseMs(result, board)!;
  // The VALUE is unchanged (§S3: legibility, not tuning): the client really
  // waited its 10s bound before reporting.
  expect(waited, `${diag}\n\nthe client stopped waiting ${clientReadTimeoutMs - waitToleranceMs}ms into its ${clientReadTimeoutMs}ms read bound — the bound this CR refuses to tune was not actually served`).toBeGreaterThanOrEqual(clientReadTimeoutMs - waitToleranceMs);
  expect(waited, `${diag}\n\nthe client waited well past its ${clientReadTimeoutMs}ms read bound — the bound is not being honoured`).toBeLessThan(clientReadTimeoutMs + waitSlackMs);
}

describe("a plans GET that times out is reported as an envelope (CR-CRU-126 §S3)", () => {
  test("cycle-activate against a board that never answers emits the ok:false envelope naming the timeout, exits non-zero, and prints no traceback", async () => {
    const board = startStalledBoard();
    const dir = projectDir();

    const result = await runVerb(
      ["cycle-activate", "4321", "--agent", "CR-CRU-126-FIXTURE", "--project-dir", dir],
      board.url,
      dir,
    );

    assertTimeoutEnvelope("cycle-activate", result, board);
  }, 60_000);

  test("cycle-done against a board that never answers emits the ok:false envelope naming the timeout, exits non-zero, and prints no traceback", async () => {
    const board = startStalledBoard();
    const dir = projectDir();

    const result = await runVerb(
      ["cycle-done", "4321", "--agent", "CR-CRU-126-FIXTURE", "--project-dir", dir],
      board.url,
      dir,
    );

    assertTimeoutEnvelope("cycle-done", result, board);
  }, 60_000);
});
