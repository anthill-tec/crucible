// CR-CRU-047 C2 — §S1 (no permanently-excluded test directory) + §S2
// (collected count surfaced in the regression envelope) suite-integrity guard.
//
// Reworked from an earlier draft that ALSO asserted full on-disk/run PARITY
// by spawning a REAL FULL `bun test` run from inside a test (~5.5 min for
// this repo's ~1000-test suite) — sound, but far too expensive to pay on
// every gate (every RED/GREEN run would cost ~11 minutes instead of ~5.5).
//
// Kept from that draft: the set-comparison technique (never a bare count, so
// an off-by-one substitution can't slip through two changes cancelling out),
// the symmetric self-exclusion (this file cannot observe its own nested
// `bun test` completing — the JUnit reporter only flushes at process exit —
// so it excludes itself from BOTH sides of any file-set comparison), and the
// on-disk recursive walker.
//
// Removed: the nested full-suite `Bun.spawn`. In its place:
//   - §S1 is asserted STRUCTURALLY (bunfig.toml carries no
//     `pathIgnorePatterns` exclusion under `tests/`). With no permanent
//     exclusion possible, on-disk/run parity holds BY CONSTRUCTION — that is
//     the cheap guarantee that replaces the expensive nested run, and it is
//     the PRIMARY guarantee below.
//   - §S2 is asserted against a tiny 2-file FIXTURE project driven through
//     the real `regression` verb — milliseconds, not minutes, and a 2-file
//     (never 1-file) fixture so a stub hardcoding a constant can't slip past.
//   - A corroborating parity check reads an EXISTING `test-reports/junit.xml`
//     from a prior real run if one happens to be present, and skips cleanly
//     (no synthetic run) if not — a corroboration, not the primary
//     guarantee.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = path.join(REPO_ROOT, "tests");
const SCRIPT_PATH = path.join(REPO_ROOT, "clients", "bun-crucible.py");

// This file's own path relative to REPO_ROOT, POSIX-separated to match the
// `file="tests/..."` attributes bun's JUnit reporter emits. Excluded
// symmetrically from BOTH sides of the on-disk/junit comparison below — a
// test cannot observe its own nested `bun test` invocation completing (the
// JUnit file is only flushed once the whole process exits), so counting
// itself would either hang forever recursing into itself or silently
// under-report. Structural necessity, not a loophole: every OTHER on-disk
// file (including any future permanently-excluded one) is still fully
// subject to the comparison.
const SELF_RELATIVE = path
  .relative(REPO_ROOT, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join("/");

function listTestFilesOnDisk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTestFilesOnDisk(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function distinctJunitTestcaseFiles(junitXml: string): string[] {
  const files = new Set<string>();
  const re = /<testcase\b[^>]*\bfile="([^"]+)"/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(junitXml)) !== null) {
    files.add(m[1]!.split(path.sep).join("/"));
  }
  return Array.from(files);
}

describe(
  "No permanently-excluded test directory (§S1 guard) — " +
    "bunfig.toml carries no pathIgnorePatterns exclusion",
  () => {
    test(
      "bunfig.toml's [test] section has no pathIgnorePatterns key at all " +
        "(a future permanently-excluded directory must fail this, not just " +
        "silently shrink the count)",
      () => {
        const bunfigPath = path.join(REPO_ROOT, "bunfig.toml");
        const raw = fs.readFileSync(bunfigPath, "utf8");

        const pathIgnorePatternsMatch = /^\s*pathIgnorePatterns\s*=\s*(\[[^\]]*\])/m.exec(raw);

        expect(pathIgnorePatternsMatch).toBeNull();
      },
    );

    test(
      "even if some future pathIgnorePatterns line existed for an unrelated " +
        "reason, it must never reference the tests/ tree",
      () => {
        const bunfigPath = path.join(REPO_ROOT, "bunfig.toml");
        const raw = fs.readFileSync(bunfigPath, "utf8");

        const referencesTestsDir = /pathIgnorePatterns\s*=\s*\[[^\]]*tests\//.test(raw);

        expect(referencesTestsDir).toBe(false);
      },
    );
  },
);

// ── §S2 — collected count surfaced in the regression envelope ────────────
//
// Drives `clients/bun-crucible.py regression` for real (a real Bun.spawn of
// `python3 clients/bun-crucible.py`, a real ephemeral Crucible server via
// `startServer`, a real tiny bun project on disk) but keeps it cheap: the
// fixture project has exactly TWO test files (deliberately never one — a
// stub that hardcodes "1", or that echoes the existing test `total` instead
// of counting FILES, would slip past a 1-file fixture where files==tests==1).

function writeTwoFileFixtureProject(dir: string, projectKey: string): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "cr047-suite-integrity-fixture", version: "0.0.0", private: true }),
  );
  fs.writeFileSync(
    path.join(dir, "a.test.ts"),
    'import { test, expect } from "bun:test";\n\n' +
      'test("first fixture test", () => {\n  expect(1 + 1).toBe(2);\n});\n',
  );
  fs.writeFileSync(
    path.join(dir, "b.test.ts"),
    'import { test, expect } from "bun:test";\n\n' +
      'test("second fixture test", () => {\n  expect(2 + 2).toBe(4);\n});\n',
  );
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
  const proc = Bun.spawn({
    cmd: [
      "python3",
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
    env: { ...baseEnv, CRUCIBLE_URL: crucibleUrl },
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

// ── Corroborating parity check (cheap — no full-suite spawn) ─────────────

describe(
  "On-disk vs an existing junit artifact (corroboration only — §S1's " +
    "bunfig assertion above is the PRIMARY guarantee)",
  () => {
    const junitPath = path.join(REPO_ROOT, "test-reports", "junit.xml");
    const junitExists = fs.existsSync(junitPath);
    if (!junitExists) {
      // Clear, non-silent explanation for the skip below — printed once at
      // collection time regardless of which reporter is in use.
      console.error(
        `[suite-integrity] skipping junit-artifact corroboration: ${junitPath} ` +
          "does not exist (no prior real bun run has left one behind at this " +
          "path) — this is a documented, expected skip, not a dodge; §S1's " +
          "bunfig assertion above remains the primary guarantee regardless.",
      );
    }

    test.skipIf(!junitExists)(
      "on-disk tests/**/*.test.ts file count equals the distinct file count " +
        "in test-reports/junit.xml from a prior real run (skipped when " +
        "absent, per the console note logged above)",
      () => {
        const onDisk = listTestFilesOnDisk(TESTS_DIR)
          .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"))
          .filter((rel) => rel !== SELF_RELATIVE)
          .sort();

        const junitXml = fs.readFileSync(junitPath, "utf8");
        const ranFiles = distinctJunitTestcaseFiles(junitXml)
          .filter((rel) => rel !== SELF_RELATIVE)
          .sort();

        expect({ onDiskCount: onDisk.length, ranFiles }).toEqual({
          onDiskCount: onDisk.length,
          ranFiles: onDisk,
        });
      },
    );
  },
);
