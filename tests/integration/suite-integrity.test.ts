// The bun client's `regression` verb reports how many test FILES it
// collected, beside the test counts, in its run envelope.
import { describe, expect, test } from "bun:test";
import { clientScript } from "../helpers/test-install.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../../src/server.ts";
import { declareClientBoard } from "../helpers/client-board.ts";

const SCRIPT_PATH = clientScript("bun-crucible.py");

// ── §S2 — collected count surfaced in the regression envelope ────────────
//
// Drives `clients/bun-crucible.py regression` for real (a real Bun.spawn of
// `python3 clients/bun-crucible.py`, a real ephemeral Crucible server via
// `startServer`, a real tiny bun project on disk) but keeps it cheap: the
// fixture project has exactly TWO test files (deliberately never one — a
// stub that hardcodes "1", or that echoes the existing test `total` instead
// of counting FILES, would slip past a 1-file fixture where files==tests==1).

// The fixture PRIMITIVES: "a bun project bun will collect tests from".
function writeFixturePackage(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "cr047-suite-integrity-fixture", version: "0.0.0", private: true }),
  );
}

// One fixture test file at `rel` (POSIX-separated, parent directories
// created): the smallest unit bun collects and stamps into its report.
function writeFixtureTest(dir: string, rel: string, title: string): void {
  const full = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    'import { test, expect } from "bun:test";\n\n' +
      `test("${title}", () => {\n  expect(1 + 1).toBe(2);\n});\n`,
  );
}

function writeTwoFileFixtureProject(dir: string, projectKey: string): void {
  writeFixturePackage(dir);
  writeFixtureTest(dir, "a.test.ts", "first fixture test");
  writeFixtureTest(dir, "b.test.ts", "second fixture test");
  fs.writeFileSync(path.join(dir, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
}

async function runRegression(
  dir: string,
  crucibleUrl: string,
  agent: string,
): Promise<{ code: number; stdout: string }> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
  }
  // CR-CRU-139 §S2 — the board is DECLARED in the project dir this drive
  // resolves, never exported; the interlock refuses a spawn that would reach
  // any other board.
  declareClientBoard(crucibleUrl, dir);
  const proc = Bun.spawn({
    cmd: [
      "uv",
      "run",
      SCRIPT_PATH,
      "regression",
      "--agent",
      agent,
      "--project-dir",
      dir,
      "--package-dir",
      dir,
    ],
    cwd: dir,
    env: { ...baseEnv },
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

describe("Collected count surfaced in the regression envelope (§S2)", () => {
  test(
    "`regression --agent` against a 2-file fixture project prints a files " +
      "count of exactly 2 in the run envelope on stdout, alongside the " +
      "existing total/passed/failed test counts (today's unpatched client " +
      "prints no files field at all — that is the RED)",
    async () => {
      const handle = startServer({ port: 0, dbPath: ":memory:" });
      try {
        const baseUrl = `http://localhost:${handle.server.port}`;
        const res = await fetch(`${baseUrl}/api/v2/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "cr047-c2-s2-fixture" }),
        });
        const body = (await res.json()) as { project: { key: string } };
        const projectKey = body.project.key;

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr047-suite-integrity-s2-"));
        try {
          writeTwoFileFixtureProject(dir, projectKey);

          const result = await runRegression(dir, baseUrl, "cr047-c2-s2-fixture-agent");

          const runBlockMatch = /(?:^|\n) {2}run:\n((?: {4}[^\n]*\n)*)/.exec(result.stdout);
          expect(runBlockMatch).not.toBeNull();
          const runBlock = runBlockMatch ? runBlockMatch[1]! : "";

          // The run block must still carry the EXISTING test-count fields —
          // this CR must not regress the totals ingest already relies on.
          expect(/^ {4}total:\s*2\s*$/m.test(runBlock)).toBe(true);
          expect(/^ {4}passed:\s*2\s*$/m.test(runBlock)).toBe(true);
          expect(/^ {4}failed:\s*0\s*$/m.test(runBlock)).toBe(true);

          const filesMatch = /^ {4}files:\s*(\d+)\s*$/m.exec(runBlock);
          expect(filesMatch).not.toBeNull();
          expect(Number(filesMatch?.[1])).toBe(2);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } finally {
        handle.stop();
      }
    },
  );
});
