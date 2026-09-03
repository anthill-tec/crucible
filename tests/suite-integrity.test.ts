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
//
// CR-CRU-101 §S1 — IT STATES ITS OWN PRECONDITION.
//
// THE DEFECT THIS REPLACES, MEASURED (2026-09-03): this check compared the
// on-disk `tests/**/*.test.ts` set with the distinct file set in
// `test-reports/junit.xml` left behind by WHATEVER RAN LAST, on the premise —
// stated only in its own skip message — that the artifact came from a FULL
// run. Nothing enforced it. The artifact held ONE distinct file
// (`tests/boot-safety.test.ts`) against 144 on-disk files, and
// `bun test tests/suite-integrity.test.ts` reported 3 pass / 1 fail:
// "Expected - 143 / Received + 0". No code defect existed. The previous
// command had simply been narrower than the tree — which is what this repo's
// dispatch discipline REQUIRES of every sub-agent ("run ONLY the suites you
// touch"). The assertion was detecting compliance, not invisible coverage.
//
// WHERE THE PROOF COMES FROM, and why nowhere else will do: bun's JUnit output
// records test counts, not a file total and not how the runner was invoked, so
// the only artifact-INTERNAL proxy for "this run was full" is "its file set
// equals the on-disk set" — the conclusion itself. A precondition identical to
// its conclusion can never fail, and a check that can never fail detects
// nothing. The scope is known exactly once, at the PRODUCER:
// `clients/bun-crucible.py`'s `_bun_test_cmd` receives `targets` (empty =
// whole-suite) at the moment it builds the invocation, having just `_wipe`d the
// previous artifact. It stamps that scope beside the artifact
// (`test-reports/junit-scope.json`), and this check reads the stamp as its
// precondition — asserting it BEFORE the parity conclusion, and SKIPPING with
// the reason named when it does not hold.
//
// `bunfig.toml` carries no `[test]` section, so a bare `bun test` writes
// NOTHING to `test-reports/`: artifact and stamp are only ever written
// together by the client and only ever removed together by `_wipe`, so a stamp
// is never stale with respect to the artifact beside it.
//
// This stays a CORROBORATION. §S1's `bunfig` assertion above is the primary
// guarantee precisely because it reads CONFIGURATION rather than run history,
// so it holds under any invocation.

const REPORTS_DIR = path.join(REPO_ROOT, "test-reports");

// The producing client's stamp: its filename and the two scope values it
// writes. Pinned here because the SKIP path is failure-free — a client-side
// rename would retire this corroboration permanently and SILENTLY, the one
// direction no test reports. The values are proven behaviourally below (the
// real client is spawned twice); the filename is additionally pinned against
// the client's own source, so a rename fails HERE.
const SCOPE_RECORD = "junit-scope.json";
const FULL_SCOPE = "full";
const SCOPED_SCOPE = "scoped";

export interface FullRunProof {
  provenFull: boolean;
  // Non-empty whenever `provenFull` is false: `test.skipIf` prints no reason
  // of its own (bun 1.3.14), so the caller emits this at COLLECTION time the
  // way the missing-artifact case has always been reported.
  reason: string;
}

// THE PRECONDITION, as a function of a reports directory alone, so the tests
// below can plant every input shape instead of mutating the real one.
export function fullRunProof(reportsDir: string): FullRunProof {
  const junitPath = path.join(reportsDir, "junit.xml");
  const recordPath = path.join(reportsDir, SCOPE_RECORD);

  if (!fs.existsSync(junitPath)) {
    return {
      provenFull: false,
      reason:
        `${junitPath} does not exist — no prior client run has left an ` +
        "artifact at this path (a bare `bun test` writes none)",
    };
  }
  if (!fs.existsSync(recordPath)) {
    return {
      provenFull: false,
      reason:
        `${junitPath} has no ${SCOPE_RECORD} beside it, so the scope of the ` +
        "run that produced it is unknown — it may cover one file or the whole " +
        "tree, and only the producing client could have said which",
    };
  }

  let scope: unknown;
  let targets: unknown;
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      scope?: unknown;
      targets?: unknown;
    };
    scope = parsed.scope;
    targets = parsed.targets;
  } catch {
    return {
      provenFull: false,
      reason:
        `${recordPath} (the ${SCOPE_RECORD} beside ${junitPath}) is not ` +
        "readable JSON, so the artifact's scope cannot be established",
    };
  }

  if (scope === FULL_SCOPE) return { provenFull: true, reason: "" };

  const named = Array.isArray(targets) ? targets.map(String) : [];
  return {
    provenFull: false,
    reason:
      `${SCOPE_RECORD} records scope=${JSON.stringify(scope)}` +
      (named.length > 0 ? ` (targets: ${named.join(", ")})` : "") +
      `, so ${junitPath} describes how the previous command was invoked, not ` +
      "what the tree contains",
  };
}

export interface ParityGap {
  // On disk, absent from the run: INVISIBLE COVERAGE, the thing worth catching.
  neverRan: string[];
  // In the run, absent from disk: a file deleted since, or a stale artifact.
  ranButAbsent: string[];
}

// THE CONCLUSION, likewise pure. Both directions are reported (never a bare
// count), so two errors cancelling out cannot pass, and the failure NAMES the
// files instead of printing two 145-element lists.
export function junitParityGap(onDisk: string[], ranFiles: string[]): ParityGap {
  const ran = new Set(ranFiles);
  const disk = new Set(onDisk);
  return {
    neverRan: onDisk.filter((rel) => !ran.has(rel)).sort(),
    ranButAbsent: ranFiles.filter((rel) => !disk.has(rel)).sort(),
  };
}

describe(
  "On-disk vs an existing junit artifact (corroboration only — §S1's " +
    "bunfig assertion above is the PRIMARY guarantee)",
  () => {
    const junitPath = path.join(REPORTS_DIR, "junit.xml");
    const proof = fullRunProof(REPORTS_DIR);
    if (!proof.provenFull) {
      // Clear, non-silent explanation for the skip below — printed once at
      // collection time regardless of which reporter is in use, because
      // `test.skipIf` prints no reason of its own.
      console.error(
        `[suite-integrity] skipping junit-artifact corroboration: ${proof.reason} ` +
          "— this is a documented, expected skip, not a dodge; §S1's bunfig " +
          "assertion above remains the primary guarantee regardless.",
      );
    }

    test.skipIf(!proof.provenFull)(
      "given an artifact PROVEN to come from a whole-suite client run, every " +
        "on-disk tests/**/*.test.ts file appears in it and it names no file " +
        "that is not on disk (skipped, with the reason logged above, whenever " +
        "that precondition cannot be established)",
      () => {
        // The PRECONDITION, asserted before the conclusion (AC5) — re-read
        // here rather than trusted from collection time, so an artifact
        // replaced mid-run cannot license a comparison against itself.
        const recheck = fullRunProof(REPORTS_DIR);
        expect(recheck).toEqual({ provenFull: true, reason: "" });

        const onDisk = listTestFilesOnDisk(TESTS_DIR)
          .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"))
          .filter((rel) => rel !== SELF_RELATIVE)
          .sort();

        const junitXml = fs.readFileSync(junitPath, "utf8");
        const ranFiles = distinctJunitTestcaseFiles(junitXml)
          .filter((rel) => rel !== SELF_RELATIVE)
          .sort();

        expect(junitParityGap(onDisk, ranFiles)).toEqual({
          neverRan: [],
          ranButAbsent: [],
        });
      },
    );
  },
);

// ── CR-CRU-101 §S1 — the precondition's own tests ────────────────────────
//
// Planted inputs, never the real `test-reports/`: the shapes that matter here
// (no stamp, a scoped stamp, a corrupt stamp) are exactly the states this
// check must not fail on, and planting them is the only way to assert that
// without waiting for one to occur. The two REAL client spawns then prove the
// cross-stack half — that the stamp this reads is the stamp the client writes.

function plantReportsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr101-scope-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

// A minimal artifact in bun's own shape — enough for `distinctJunitTestcaseFiles`.
function junitFor(files: string[]): string {
  const cases = files
    .map((f) => `<testcase name="t" classname="c" file="${f}" time="0"/>`)
    .join("");
  return `<?xml version="1.0"?><testsuites>${cases}</testsuites>`;
}

// Drives the REAL producing client (`clients/bun-crucible.py test`) against a
// throwaway 2-file bun project. No `--agent`, so no server, no ingest and no
// registration — this exercises exactly the artifact-production path.
async function runClientTest(
  dir: string,
  targets: string[],
): Promise<{ code: number; stderr: string }> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
  }
  const proc = Bun.spawn({
    cmd: [
      "uv",
      "run",
      SCRIPT_PATH,
      "test",
      "--project-dir",
      dir,
      "--package-dir",
      dir,
      ...(targets.length > 0 ? ["--tests", ...targets] : []),
    ],
    cwd: dir,
    env: baseEnv as Record<string, string>,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

describe(
  "CR-CRU-101 §S1 — the junit corroboration asserts its precondition before " +
    "its conclusion",
  () => {
    test(
      "an artifact with no scope record beside it is NOT proven full, and the " +
        "reason names the missing record rather than failing on the tree",
      () => {
        const dir = plantReportsDir({ "junit.xml": junitFor(["tests/a.test.ts"]) });
        try {
          const proof = fullRunProof(dir);

          expect(proof.provenFull).toBe(false);
          expect(proof.reason).toContain(SCOPE_RECORD);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test(
      "a record that says the run was SCOPED is not proof of fullness, and " +
        "the reason names the scope the artifact actually had (AC2)",
      () => {
        const dir = plantReportsDir({
          "junit.xml": junitFor(["tests/boot-safety.test.ts"]),
          [SCOPE_RECORD]: JSON.stringify({
            scope: SCOPED_SCOPE,
            artifact: "junit.xml",
            targets: ["tests/boot-safety.test.ts"],
          }),
        });
        try {
          const proof = fullRunProof(dir);

          expect(proof.provenFull).toBe(false);
          expect(proof.reason).toContain(SCOPED_SCOPE);
          expect(proof.reason).toContain("tests/boot-safety.test.ts");
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test(
      "a record that says the run was FULL is proof, so the conclusion is " +
        "reached rather than skipped (AC6 — the check still concludes)",
      () => {
        const dir = plantReportsDir({
          "junit.xml": junitFor(["tests/a.test.ts", "tests/b.test.ts"]),
          [SCOPE_RECORD]: JSON.stringify({
            scope: FULL_SCOPE,
            artifact: "junit.xml",
            targets: [],
          }),
        });
        try {
          expect(fullRunProof(dir).provenFull).toBe(true);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test(
      "an unreadable or unrecognised record is not proof and never throws — " +
        "a corrupt local artifact must skip, not crash the suite",
      () => {
        const truncated = plantReportsDir({
          "junit.xml": junitFor(["tests/a.test.ts"]),
          [SCOPE_RECORD]: "{ scope: ",
        });
        const alien = plantReportsDir({
          "junit.xml": junitFor(["tests/a.test.ts"]),
          [SCOPE_RECORD]: JSON.stringify({ scope: "partial" }),
        });
        try {
          expect(fullRunProof(truncated).provenFull).toBe(false);
          expect(fullRunProof(truncated).reason).toContain(SCOPE_RECORD);
          expect(fullRunProof(alien).provenFull).toBe(false);
          expect(fullRunProof(alien).reason).toContain("partial");
        } finally {
          fs.rmSync(truncated, { recursive: true, force: true });
          fs.rmSync(alien, { recursive: true, force: true });
        }
      },
    );

    test(
      "a missing artifact keeps its documented skip, and the reason still " +
        "names the artifact (today's only skip case is preserved)",
      () => {
        const dir = plantReportsDir({});
        try {
          const proof = fullRunProof(dir);

          expect(proof.provenFull).toBe(false);
          expect(proof.reason).toContain("junit.xml");
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test(
      "THE CHECK DID NOT BECOME UNFAILABLE: a proven-FULL artifact that omits " +
        "an on-disk .test.ts file still yields a gap naming that file (AC5/AC6)",
      () => {
        const onDisk = ["tests/a.test.ts", "tests/invisible.test.ts", "tests/b.test.ts"];
        const ran = ["tests/a.test.ts", "tests/b.test.ts"];

        expect(junitParityGap(onDisk, ran)).toEqual({
          neverRan: ["tests/invisible.test.ts"],
          ranButAbsent: [],
        });
      },
    );

    test(
      "the conclusion is a SET comparison in both directions — a file the run " +
        "reports that is no longer on disk is reported too, so two errors " +
        "cancelling out cannot pass",
      () => {
        expect(
          junitParityGap(["tests/a.test.ts", "tests/added.test.ts"], [
            "tests/a.test.ts",
            "tests/deleted.test.ts",
          ]),
        ).toEqual({
          neverRan: ["tests/added.test.ts"],
          ranButAbsent: ["tests/deleted.test.ts"],
        });

        expect(junitParityGap(["tests/a.test.ts"], ["tests/a.test.ts"])).toEqual({
          neverRan: [],
          ranButAbsent: [],
        });
      },
    );

    test(
      "THE SEQUENCE THAT PRODUCES THE BUG, end to end: a real SCOPED client " +
        "run stamps its artifact `scoped` (naming its targets), and the " +
        "corroboration refuses that artifact instead of failing on it (AC1)",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr101-scoped-run-"));
        try {
          writeTwoFileFixtureProject(dir, "cr101-scope-fixture");

          const run = await runClientTest(dir, ["a.test.ts"]);
          expect(run.code).toBe(0);

          const reportsDir = path.join(dir, "test-reports");
          const record = JSON.parse(
            fs.readFileSync(path.join(reportsDir, SCOPE_RECORD), "utf8"),
          ) as { scope: string; targets: string[] };

          expect(record.scope).toBe(SCOPED_SCOPE);
          expect(record.targets).toEqual(["a.test.ts"]);

          const proof = fullRunProof(reportsDir);
          expect(proof.provenFull).toBe(false);
          expect(proof.reason).toContain(SCOPED_SCOPE);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test(
      "and the other half of the sequence: a real WHOLE-SUITE client run " +
        "stamps its artifact `full`, so the corroboration CONCLUDES",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr101-full-run-"));
        try {
          writeTwoFileFixtureProject(dir, "cr101-scope-fixture");

          const run = await runClientTest(dir, []);
          expect(run.code).toBe(0);

          const reportsDir = path.join(dir, "test-reports");
          const record = JSON.parse(
            fs.readFileSync(path.join(reportsDir, SCOPE_RECORD), "utf8"),
          ) as { scope: string; targets: string[] };

          expect(record.scope).toBe(FULL_SCOPE);
          expect(record.targets).toEqual([]);
          expect(fullRunProof(reportsDir).provenFull).toBe(true);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test(
      "the producing client declares the SAME record filename this check " +
        "reads — a client-side rename must fail here, never silently retire " +
        "the corroboration through its failure-free skip path",
      () => {
        const clientSource = fs.readFileSync(SCRIPT_PATH, "utf8");

        expect(
          new RegExp(`^DEFAULT_SCOPE\\s*=\\s*["']${SCOPE_RECORD.replace(".", "\\.")}["']`, "m")
            .test(clientSource),
        ).toBe(true);
      },
    );
  },
);
