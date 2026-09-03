// CR-CRU-047 C2 + CR-CRU-101 — the suite-integrity guard: §S1 (no
// permanently-excluded test directory) + §S2 (collected count surfaced in the
// regression envelope).
//
// WHAT THIS FILE GUARANTEES, in the order the blocks appear:
//   1. THE PRIMARY GUARANTEE — `bunfig.toml` carries no `pathIgnorePatterns`
//      exclusion, so no `.test.ts` file under `tests/` can be permanently
//      hidden from the runner, and on-disk/run parity therefore holds BY
//      CONSTRUCTION under any invocation. It reads CONFIGURATION, so it
//      cannot decay with use. Its decision is `discoveryExclusions`, a pure
//      function of TOML text.
//   2. §S2's regression envelope — the client reports the number of FILES it
//      collected, asserted against a real fixture project driven through the
//      real `regression` verb. The fixture has TWO test files, deliberately
//      never one: a stub hardcoding "1", or echoing the test `total` instead
//      of counting FILES, would slip past a 1-file fixture where
//      files == tests == 1.
//   3. THE PRIMARY GUARANTEE IS LOAD-BEARING — a `.test.ts` file sitting
//      behind a `pathIgnorePatterns` entry is MISSED by a REAL bun run and
//      REPORTED by the guard; remove the entry and both observations flip.
//      Observed in a scratch fixture, never predicted.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO.
//
// IT DOES NOT SPAWN A FULL `bun test` OVER THIS REPO. An earlier draft did,
// to assert on-disk/run parity directly — sound, but ~5.5 minutes for this
// repo's ~1000-test suite, so every RED/GREEN run would cost ~11 minutes
// instead of ~5.5. CR-CRU-047 deleted it: block 1 replaces it structurally,
// and block 3 buys the same signal over a two-file fixture at fixture cost.
// There is no third option — bun 1.3.14 has no discovery-listing and no
// dry-run flag, so "enumerate what the runner would collect" over a tree
// means actually running it.
//
// IT DOES NOT READ `test-reports/junit.xml`. CR-CRU-101 DELETED a fourth
// block that corroborated block 1 by comparing the on-disk `.test.ts` set
// against the distinct file set in the artifact left behind by whatever ran
// last, on the premise — stated only in its own skip message, never
// enforced — that the artifact came from a FULL run. Any scoped run
// overwrote the artifact with a subset, and the next run containing the check
// then failed, reporting how the PREVIOUS command was invoked rather than
// anything about the tree; since this repo's dispatch discipline requires
// every sub-agent to run only the suites it touched, the check was detecting
// compliance. And it could never even conclude inside a client run (measured
// 2026-09-04): `_wipe` deletes the artifact before the run and bun flushes
// its JUnit report only at process EXIT, so at collection time there was
// nothing to read and the check always skipped. ~900 lines of scope stamp,
// artifact binding and mtime arithmetic existed to make trustworthy a check
// that never fired. It was a contract asserted over mutable local state —
// the family CR-CRU-100 names — and it is closed by subtraction: with no
// prior-run artifact read at all, no run can fail because of how the previous
// command was invoked. The primary guarantee needs no run history.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "clients", "bun-crucible.py");

// Every `.test.ts` file under `dir`, recursively. Used on the scratch fixture
// tree in block 3 — never on this repo's own `tests/` — to establish what was
// on disk for the run that block observes.
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

// The distinct files a JUnit report's `<testcase file="…">` attributes name —
// what a run says it actually collected, in the run's own words. Read off the
// fixture's OWN report in block 3.
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

// ── The §S1 guard's DECISION, as a pure function of the config text ──────
//
// CR-CRU-101 §S2/AC3. Both assertions below used to read
// REPO_ROOT/bunfig.toml inline and decide with a regex in their own bodies,
// which made the decision unaskable about any other config — so the guard's
// SENSITIVITY could never be shown, and a guard nobody can show to be
// sensitive is indistinguishable from one that is merely green. Extracted
// here in the shape this repo already uses for exactly this (a pure checker
// plus planted sources: tests/queue-accepted-field-guard.test.ts,
// tests/helpers/source-scan.ts), so the same decision that judges the real
// bunfig.toml judges a fixture's — and the fixture in block 3 then proves,
// against a real bun run, that what it reports is what actually hides a test
// file.
//
// BOTH dimensions the two assertions cover are reported, because they are not
// the same claim: the KEY's presence at all, and whether the array names the
// tests/ tree. The first is the PRIMARY one, and a measurement says why —
// against bun 1.3.14 over block 3's fixture (2026-09-04), `["**/hidden/**"]`
// hides a file UNDER tests/ with the literal text `tests/` appearing NOWHERE
// in the config, so the second dimension cannot see it and only the first
// fires. (Not every spelling excludes anything, measured the same way:
// `["tests/hidden/"]` and `["hidden"]` hide nothing, while
// `["tests/hidden/*"]`, `["**/hidden/*"]` and `["**/hidden/**"]` each hide
// the file.)

export interface DiscoveryExclusion {
  // The array exactly as written, so a failure names the config text.
  arrayText: string;
  // Its entries, unquoted — TOML's basic and literal string forms alike.
  patterns: string[];
  // Whether the array text names the tests/ tree.
  referencesTestsDir: boolean;
}

// TOML comments removed, so PROSE cannot decide: the real bunfig.toml is
// five comment lines, one of which names `pathIgnorePatterns` verbatim to
// warn against it, and a commented-out assignment is inert to bun (observed
// against the real runner over block 3's fixture) so it must be inert here
// too. A `#` inside a string is not a comment; a basic/literal string cannot
// span a line, so the quote state resets at every newline. Every byte that is
// not a comment is kept where it was, newlines included.
function stripTomlComments(toml: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < toml.length; i += 1) {
    const ch = toml[i]!;
    if (quote !== null) {
      out += ch;
      if (ch === "\\" && quote === '"') {
        out += toml[i + 1] ?? "";
        i += 1;
      } else if (ch === quote || ch === "\n") {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === "#") {
      while (i < toml.length && toml[i] !== "\n") i += 1;
      out += "\n";
    } else {
      out += ch;
    }
  }
  return out;
}

// Every `pathIgnorePatterns` assignment the config actually makes. The match
// is deliberately UNANCHORED and demands `= [`, so over-reporting stays the
// loud direction: a spelling that excludes nothing is still reported, which
// fails a guard, whereas the reverse would hide a real exclusion.
//
// THE QUOTED KEY, where that reverse really happened. TOML lets a key be
// bare, basic-quoted or literal-quoted, and all three are the SAME
// assignment: bun 1.3.14 honours `pathIgnorePatterns`, `"pathIgnorePatterns"`
// and `'pathIgnorePatterns'` identically (measured over block 3's fixture —
// each hides the file). Demanding `=` IMMEDIATELY after the bare key missed
// both quoted forms, so a real exclusion was invisible to the guard. Only the
// CLOSING quote needs handling: the match is unanchored, so a leading `"` is
// simply never consumed.
//
// WHAT THIS GUARD DELIBERATELY DOES NOT COVER, so the completeness claim
// above is only about the key it names: `[test] root = "…"` also restricts
// discovery — measured over the same fixture, `root = "tests/hidden"` yields
// `Ran 1 test across 1 file.` — but it is a different key with different
// semantics (a narrowing of where bun LOOKS, not a list of what it skips) and
// is outside this CR's scope. It is named here because a reader must not read
// "every exclusion" for "every way discovery can shrink".
export function discoveryExclusions(bunfigToml: string): DiscoveryExclusion[] {
  const config = stripTomlComments(bunfigToml);
  const found: DiscoveryExclusion[] = [];
  const re = /pathIgnorePatterns["']?\s*=\s*(\[[^\]]*\])/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(config)) !== null) {
    const arrayText = m[1]!;
    found.push({
      arrayText,
      patterns: Array.from(arrayText.matchAll(/"([^"]*)"|'([^']*)'/g)).map(
        (q) => q[1] ?? q[2] ?? "",
      ),
      referencesTestsDir: /tests\//.test(arrayText),
    });
  }
  return found;
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
        const raw = fs.readFileSync(path.join(REPO_ROOT, "bunfig.toml"), "utf8");

        // Same verdict, same subject, same file — reached through the
        // extracted decision, whose sensitivity is demonstrated against a
        // real bun run in the §S2 fixture at the end of this file.
        expect(discoveryExclusions(raw)).toEqual([]);
      },
    );

    test(
      "even if some future pathIgnorePatterns line existed for an unrelated " +
        "reason, it must never reference the tests/ tree",
      () => {
        const raw = fs.readFileSync(path.join(REPO_ROOT, "bunfig.toml"), "utf8");

        expect(discoveryExclusions(raw).filter((e) => e.referencesTestsDir)).toEqual([]);
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

// The fixture PRIMITIVES. Shared by both fixture shapes in this file —
// CR-047's flat 2-file project just below and CR-CRU-101 §S2's nested one at
// the end — so "a bun project bun will collect tests from" is described
// once, not twice.
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

// ── CR-CRU-101 §S2 — the structural guard is LOAD-BEARING, demonstrated ──
//
// WHAT WAS MISSING, precisely. The two `bunfig` assertions at the TOP of this
// file are the primary guarantee of the whole suite-integrity claim: with no
// `pathIgnorePatterns` in `bunfig.toml`, on-disk/run parity holds BY
// CONSTRUCTION, under any invocation, because it reads CONFIGURATION rather
// than run history. But neither half of that reasoning was ever
// demonstrated — not that a `pathIgnorePatterns` entry really does hide a
// `.test.ts` file from bun, and not that the guard would report the entry
// that hid it. Both were asserted. A guard whose sensitivity is never shown
// is indistinguishable from a guard that is merely green (AC3), and "a file
// on disk that never ran" had never once been OBSERVED (AC4).
//
// BOTH HALVES ARE OBSERVED HERE, in a scratch fixture project carrying its
// OWN bunfig.toml. The repo's is never touched and now never could be: the
// decision is a pure function of TOML TEXT (`discoveryExclusions`, beside the
// two assertions it serves), so the fixture's config reaches exactly the
// decision the real one reaches.
//   * bun's real behaviour — a REAL client run (`clients/bun-crucible.py
//     test` with NO targets, so the runner's own discovery decides what to
//     collect), read back off the file set named by that run's OWN junit
//     report. Never predicted, never assumed.
//   * the guard's reaction — `discoveryExclusions` over that same fixture
//     bunfig, required to REPORT the exclusion on both dimensions the two
//     existing assertions cover.
// Removing the exclusion flips both observations: bun collects both files and
// the guard reports nothing.
//
// WHY A FIXTURE AND NOT THIS TREE: bun 1.3.14 has no discovery-listing and no
// dry-run flag, so "enumerate what the runner would collect" over this repo
// means actually RUNNING it — the ~5.5-minute nested full-suite `Bun.spawn`
// CR-CRU-047 deleted and this file's header explains at length. The fixture
// buys the same signal at ~70 ms of bun time per run.

const FIXTURE_VISIBLE = "tests/visible.test.ts";
const FIXTURE_HIDDEN = "tests/hidden/ignored.test.ts";

// The fixture's two configurations — identical `[test]` sections differing
// only in the one line whose presence is the entire claim.
const FIXTURE_EXCLUDES_TESTS_DIR = '[test]\npathIgnorePatterns = ["tests/hidden/*"]\n';
const FIXTURE_EXCLUDES_NOTHING = "[test]\n";

// A fixture project with TWO test files — one directly under `tests/`, one a
// directory deeper, which is the only structure an exclusion can
// discriminate between — and `bunfig` as its own bunfig.toml.
function writeExclusionFixtureProject(dir: string, bunfig: string): void {
  writeFixturePackage(dir);
  writeFixtureTest(dir, FIXTURE_VISIBLE, "visible fixture test");
  writeFixtureTest(dir, FIXTURE_HIDDEN, "hidden fixture test");
  fs.writeFileSync(path.join(dir, "bunfig.toml"), bunfig);
}

// Drives the REAL producing client (`clients/bun-crucible.py test`) against a
// throwaway bun project. No `--agent`, so no server, no ingest and no
// registration — this exercises exactly the artifact-production path.
async function runClientTest(dir: string): Promise<{ code: number; stderr: string }> {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (k.startsWith("WORKFLOW_")) delete baseEnv[k];
  }
  const proc = Bun.spawn({
    cmd: ["uv", "run", SCRIPT_PATH, "test", "--project-dir", dir, "--package-dir", dir],
    cwd: dir,
    env: baseEnv as Record<string, string>,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

interface FixtureRunObservation {
  // Every `.test.ts` under the fixture's tests/ tree, whatever ran.
  onDisk: string[];
  // The distinct files the run's OWN junit report names — what bun says it
  // collected, in bun's own words.
  ranFiles: string[];
}

// Runs the REAL producing client over the fixture with no targets, so bun's
// own discovery decides, and reports what the run itself said it ran.
async function observeFixtureRun(dir: string): Promise<FixtureRunObservation> {
  const run = await runClientTest(dir);
  if (run.code !== 0) {
    // The client's own diagnostics, or the assertion below names an exit code
    // and nothing else.
    console.error(`[suite-integrity §S2] client run exited ${run.code}:\n${run.stderr}`);
  }
  expect(run.code).toBe(0);
  const junit = fs.readFileSync(path.join(dir, "test-reports", "junit.xml"), "utf8");
  return {
    onDisk: listTestFilesOnDisk(path.join(dir, "tests"))
      .map((full) => path.relative(dir, full).split(path.sep).join("/"))
      .sort(),
    ranFiles: distinctJunitTestcaseFiles(junit).sort(),
  };
}

async function inExclusionFixture(
  slug: string,
  bunfig: string,
  body: (observed: FixtureRunObservation) => void,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cr101-s2-${slug}-`));
  try {
    writeExclusionFixtureProject(dir, bunfig);
    const observed = await observeFixtureRun(dir);
    // NAMED in the output even on success: these facts side by side ARE the
    // evidence that the guard is load-bearing, and evidence nobody can read
    // is evidence nobody can check.
    console.error(
      `[suite-integrity §S2] ${slug}: on disk ${observed.onDisk.join(", ")} | ` +
        `bun collected ${observed.ranFiles.join(", ")} | ` +
        `guard reported ${JSON.stringify(discoveryExclusions(bunfig))}`,
    );
    body(observed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe(
  "CR-CRU-101 §S2 — a test file the runner's discovery does not reach is " +
    "MISSED by a real run and REPORTED by the guard, both observed in a " +
    "scratch fixture (AC3/AC4)",
  () => {
    test(
      "a pathIgnorePatterns entry naming the fixture's tests/hidden/ really " +
        "does hide that file from a real bun run — the run's own junit " +
        "report names only the visible file — and the guard REPORTS that " +
        "entry on both of its dimensions",
      async () => {
        await inExclusionFixture("excluded", FIXTURE_EXCLUDES_TESTS_DIR, (observed) => {
          // HALF ONE — bun's behaviour, read out of the run's own report.
          expect(observed.onDisk).toEqual([FIXTURE_HIDDEN, FIXTURE_VISIBLE]);
          expect(observed.ranFiles).toEqual([FIXTURE_VISIBLE]);

          // HALF TWO — the guard, asked about the very config that hid it.
          expect(discoveryExclusions(FIXTURE_EXCLUDES_TESTS_DIR)).toEqual([
            {
              arrayText: '["tests/hidden/*"]',
              patterns: ["tests/hidden/*"],
              referencesTestsDir: true,
            },
          ]);
        });
      },
    );

    test(
      "removing that one line flips BOTH observations: the same fixture's " +
        "run collects both files and the guard reports nothing — so the " +
        "green verdict the two assertions above reach on the real " +
        "bunfig.toml is a verdict, not a tautology",
      async () => {
        await inExclusionFixture("no-exclusion", FIXTURE_EXCLUDES_NOTHING, (observed) => {
          expect(observed.onDisk).toEqual([FIXTURE_HIDDEN, FIXTURE_VISIBLE]);
          expect(observed.ranFiles).toEqual([FIXTURE_HIDDEN, FIXTURE_VISIBLE]);

          expect(discoveryExclusions(FIXTURE_EXCLUDES_NOTHING)).toEqual([]);
        });
      },
    );
  },
);
