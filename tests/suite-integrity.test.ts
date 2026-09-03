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
// bunfig.toml judges a fixture's — and the fixture at the END of this file
// then proves, against a real bun run, that what it reports is what actually
// hides a test file.
//
// BOTH dimensions the two assertions cover are reported, because they are
// not the same claim: the KEY's presence at all (the primary one — an
// exclusion can hide a file under tests/ without the literal text `tests/`
// appearing anywhere, measured, see the §S2 block), and whether the array
// names the tests/ tree.

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
// in the §S2 fixture) so it must be inert here too. A `#` inside a string
// is not a comment; a basic/literal string cannot span a line, so the quote
// state resets at every newline. Every byte that is not a comment is kept
// where it was, newlines included.
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
// is deliberately UNANCHORED and demands `= [`, which is the union of the
// two regexes this replaces — so it reports everything either of them did,
// and over-reporting is the loud direction (a spelling that excludes nothing
// is reported, which fails a guard; the reverse would hide a real
// exclusion).
export function discoveryExclusions(bunfigToml: string): DiscoveryExclusion[] {
  const config = stripTomlComments(bunfigToml);
  const found: DiscoveryExclusion[] = [];
  const re = /pathIgnorePatterns\s*=\s*(\[[^\]]*\])/g;
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
// SCOPE IS NOT SUFFICIENT — the second half, measured 2026-09-03 on this
// branch. A proven-full artifact plus one newly created test file failed with
// `neverRan: [that file]`: the artifact was simply OLDER than the file, which
// is the standing configuration during TDD since every RED phase adds one. In
// scope terms that is byte-identical to the case the check MUST fail on (a
// full run that skipped an existing file), so the deciding fact is TIME: the
// artifact's own mtime — bun flushes `junit.xml` at process exit, so it marks
// when the run ENDED — against each on-disk file's. Newer than the artifact:
// impossible to have been in that run, excluded and NAMED. Older and absent:
// invisible coverage, a failure. In the artifact but gone from disk: deleted
// since, named, not fatal. And if the exclusion empties the comparison
// entirely, the check SKIPS rather than ticking green over an empty set —
// the same vacuity refusal, one layer down.
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

// A test file with the mtime the filesystem reports for it. The pair, not the
// path alone, is what the comparison below needs: see the TIME note under
// `parityInputs`.
export interface TimedFile {
  rel: string;
  mtimeMs: number;
}

export interface ParityGap {
  // Older than the artifact yet absent from it: the file existed while that
  // full run happened and was not run. INVISIBLE COVERAGE — the fatal one.
  neverRan: string[];
  // In the run, absent from disk: DELETED since the run. Reported, never
  // fatal — a deletion time is unrecoverable, and a junit artifact cannot
  // name a file that never existed.
  ranButAbsent: string[];
  // Newer than the artifact: could not have been in that run at all, so it is
  // excluded from the comparison and named here instead of failed on.
  excludedNewer: string[];
  // How many on-disk files actually entered the comparison. A COUNT, not a
  // list, so a failure diff never prints a 145-element array.
  comparedCount: number;
  // Nothing left to compare. Must SKIP, never pass.
  vacuous: boolean;
  reason: string;
}

// THE CONCLUSION, likewise pure — the artifact's mtime and the on-disk mtimes
// arrive as ARGUMENTS, so every shape can be planted and nothing is read from
// the filesystem in here. Both directions are reported (never a bare count),
// so two errors cancelling out cannot pass, and each verdict NAMES its files
// instead of printing two 145-element lists.
export function junitParityGap(
  onDisk: TimedFile[],
  ranFiles: string[],
  artifactMtimeMs: number,
): ParityGap {
  const ran = new Set(ranFiles);
  const disk = new Set(onDisk.map((f) => f.rel));

  // Strictly newer only: the artifact is flushed at the run's END, so a file
  // whose mtime EQUALS it could still have been collected — and the safe
  // direction for an ambiguous timestamp is to compare it, not excuse it.
  const excludedNewer: string[] = [];
  const compared: string[] = [];
  for (const file of onDisk) {
    (file.mtimeMs > artifactMtimeMs ? excludedNewer : compared).push(file.rel);
  }

  // An empty comparison set proves nothing: `git checkout` rewrites every
  // mtime to now, which would excuse the entire tree at once. Passing on that
  // is exactly the vacuity §S1 rejected when it refused to infer fullness
  // from the artifact itself, so it SKIPS with the reason instead.
  const vacuous = compared.length === 0;
  return {
    neverRan: compared.filter((rel) => !ran.has(rel)).sort(),
    ranButAbsent: ranFiles.filter((rel) => !disk.has(rel)).sort(),
    excludedNewer: excludedNewer.sort(),
    comparedCount: compared.length,
    vacuous,
    reason: vacuous
      ? `the comparison set is EMPTY: all ${onDisk.length} on-disk ` +
        "tests/**/*.test.ts file(s) are NEWER than the artifact, so none of " +
        "them could have been in the run that produced it (a `git checkout` " +
        "rewriting every mtime does this). An empty comparison proves " +
        "nothing and must not pass"
      : "",
  };
}

// ── CR-CRU-101 §S1 FIX — the inputs the comparison needs, gathered ONCE ──
//
// Scope alone cannot separate two byte-identical configurations:
//   * a full artifact that omits an EXISTING file — invisible coverage, must
//     fail (AC6);
//   * a full artifact that predates a NEWLY ADDED file — history, must not
//     fail (AC1).
// The distinguishing fact is TIME, and it is not in the artifact's file set:
// it is the artifact's own mtime against each on-disk file's. Gathered here,
// where the filesystem is read, and handed to the comparator as INPUTS so the
// comparator stays pure and every shape can be planted.

export interface ParityInputs {
  // `junit.xml`'s mtime: bun flushes it at process exit, so it is the moment
  // the run ENDED — every file that run could have collected is older.
  artifactMtimeMs: number;
  onDisk: TimedFile[];
  ranFiles: string[];
}

function parityInputs(root: string, testsDir: string, reportsDir: string): ParityInputs {
  const junitPath = path.join(reportsDir, "junit.xml");
  return {
    artifactMtimeMs: fs.statSync(junitPath).mtimeMs,
    onDisk: listTestFilesOnDisk(testsDir)
      .map((full) => ({
        rel: path.relative(root, full).split(path.sep).join("/"),
        mtimeMs: fs.statSync(full).mtimeMs,
      }))
      .filter((f) => f.rel !== SELF_RELATIVE),
    ranFiles: distinctJunitTestcaseFiles(fs.readFileSync(junitPath, "utf8")).filter(
      (r) => r !== SELF_RELATIVE,
    ),
  };
}

describe(
  "On-disk vs an existing junit artifact (corroboration only — §S1's " +
    "bunfig assertion above is the PRIMARY guarantee)",
  () => {
    const proof = fullRunProof(REPORTS_DIR);
    // The comparison's own precondition, evaluated at COLLECTION time because
    // that is the only moment `test.skipIf` can be told: bun offers no
    // in-body skip, so a verdict of "nothing left to compare" has to be
    // reached here or not at all.
    const collected = proof.provenFull
      ? parityInputs(REPO_ROOT, TESTS_DIR, REPORTS_DIR)
      : null;
    const plan =
      collected === null
        ? null
        : junitParityGap(collected.onDisk, collected.ranFiles, collected.artifactMtimeMs);
    const blocked = plan === null || plan.vacuous;
    if (blocked) {
      // Clear, non-silent explanation for the skip below — printed once at
      // collection time regardless of which reporter is in use, because
      // `test.skipIf` prints no reason of its own.
      console.error(
        "[suite-integrity] skipping junit-artifact corroboration: " +
          `${plan === null ? proof.reason : plan.reason} — this is a ` +
          "documented, expected skip, not a dodge; §S1's bunfig assertion " +
          "above remains the primary guarantee regardless.",
      );
    }

    test.skipIf(blocked)(
      "given an artifact PROVEN to come from a whole-suite client run, every " +
        "on-disk tests/**/*.test.ts file OLDER than that artifact appears in " +
        "it (skipped, with the reason logged above, whenever that " +
        "precondition cannot be established or nothing is left to compare)",
      () => {
        // The PRECONDITION, asserted before the conclusion (AC5) — re-read
        // here rather than trusted from collection time, so an artifact
        // replaced mid-run cannot license a comparison against itself.
        expect(fullRunProof(REPORTS_DIR)).toEqual({ provenFull: true, reason: "" });

        const inputs = parityInputs(REPO_ROOT, TESTS_DIR, REPORTS_DIR);
        const gap = junitParityGap(inputs.onDisk, inputs.ranFiles, inputs.artifactMtimeMs);

        // Both non-fatal verdicts are NAMED in the output even on success —
        // silence about them is how a shrinking comparison would hide.
        if (gap.excludedNewer.length > 0) {
          console.error(
            "[suite-integrity] excluded from the comparison as NEWER than " +
              `${path.join(REPORTS_DIR, "junit.xml")} (created or modified after that ` +
              `run, so they could not have been in it): ${gap.excludedNewer.join(", ")}`,
          );
        }
        if (gap.ranButAbsent.length > 0) {
          console.error(
            "[suite-integrity] named by the artifact but no longer on disk " +
              `(deleted since that run): ${gap.ranButAbsent.join(", ")}`,
          );
        }

        // Vacuity is a SKIP verdict, and a skip can only be declared at
        // collection time — so if it flipped true since then, fail loudly
        // rather than tick green over an empty comparison set.
        expect(gap.vacuous).toBe(false);
        expect(gap.comparedCount).toBeGreaterThan(0);

        // The only fatal direction: a file that existed while that full run
        // happened and did not run in it.
        expect(gap.neverRan).toEqual([]);
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

    // The three parity shapes C1 pinned, now carrying the mtimes the
    // comparator takes as inputs. Every file here PREDATES the artifact, so
    // each shape's verdict is unchanged by the time dimension: these are the
    // cases where a file's absence from a full run is real, not historical.
    const ARTIFACT_MS = 1_700_000_000_000;
    const BEFORE_MS = ARTIFACT_MS - 60_000;

    test(
      "THE CHECK DID NOT BECOME UNFAILABLE: a proven-FULL artifact that omits " +
        "an on-disk .test.ts file OLDER than it still yields a gap naming " +
        "that file (AC5/AC6)",
      () => {
        const onDisk = ["tests/a.test.ts", "tests/invisible.test.ts", "tests/b.test.ts"].map(
          (rel) => ({ rel, mtimeMs: BEFORE_MS }),
        );
        const ran = ["tests/a.test.ts", "tests/b.test.ts"];

        expect(junitParityGap(onDisk, ran, ARTIFACT_MS)).toEqual({
          neverRan: ["tests/invisible.test.ts"],
          ranButAbsent: [],
          excludedNewer: [],
          comparedCount: 3,
          vacuous: false,
          reason: "",
        });
      },
    );

    test(
      "the conclusion is a SET comparison in both directions — a file the run " +
        "reports that is no longer on disk is reported too, so two errors " +
        "cancelling out cannot pass",
      () => {
        expect(
          junitParityGap(
            [
              { rel: "tests/a.test.ts", mtimeMs: BEFORE_MS },
              // Predates the artifact, absent from it: skipped, not new.
              { rel: "tests/skipped.test.ts", mtimeMs: BEFORE_MS },
            ],
            ["tests/a.test.ts", "tests/deleted.test.ts"],
            ARTIFACT_MS,
          ),
        ).toEqual({
          neverRan: ["tests/skipped.test.ts"],
          ranButAbsent: ["tests/deleted.test.ts"],
          excludedNewer: [],
          comparedCount: 2,
          vacuous: false,
          reason: "",
        });

        expect(
          junitParityGap(
            [{ rel: "tests/a.test.ts", mtimeMs: BEFORE_MS }],
            ["tests/a.test.ts"],
            ARTIFACT_MS,
          ),
        ).toEqual({
          neverRan: [],
          ranButAbsent: [],
          excludedNewer: [],
          comparedCount: 1,
          vacuous: false,
          reason: "",
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

// ── CR-CRU-101 §S1 FIX — the TIME dimension's own tests ──────────────────
//
// THE DEFECT THIS FIXES, MEASURED ON THIS BRANCH (2026-09-03): with a
// `test-reports/junit.xml` naming all 145 on-disk `.test.ts` files and a
// `{"scope":"full"}` stamp beside it, creating ONE new test file and running
// `bun test tests/suite-integrity.test.ts` reported 1 fail —
// `neverRan: ["tests/zz-…-scratch.test.ts"]`. No code defect existed: the
// proven-full artifact simply PREDATED the file. That is AC1 verbatim
// ("never fails because a PREVIOUS run's artifact described a different set
// of files"), and it is the standing configuration during TDD, since every
// RED phase adds a test file.
//
// It is also byte-identical, in SCOPE terms, to the step-D proof of AC6 (a
// proven-full artifact minus `tests/store.test.ts` must FAIL). Same file
// sets, opposite required verdicts — so scope cannot decide it and TIME must:
// a file NEWER than the artifact could not have been in that run; a file
// OLDER than it and absent from it was skipped while it existed.
//
// Mtimes are planted with `fs.utimesSync`, never slept for.

// Seconds — `fs.utimesSync` takes seconds, `fs.Stats.mtimeMs` reports ms.
function plantMtime(target: string, epochSeconds: number): void {
  fs.utimesSync(target, epochSeconds, epochSeconds);
}

describe(
  "CR-CRU-101 §S1 FIX — the corroboration weighs the artifact's AGE, so a " +
    "newly added file is not mistaken for invisible coverage",
  () => {
    // One fixed instant, so every case below is deterministic.
    const ARTIFACT_MS = 1_700_000_000_000;
    const OLDER_MS = ARTIFACT_MS - 60_000;
    const NEWER_MS = ARTIFACT_MS + 60_000;

    test(
      "CASE 1 — a file NEWER than the artifact and absent from it could not " +
        "have been in that run: it is EXCLUDED from the comparison and NAMED, " +
        "never failed on (AC1, the measured defect)",
      () => {
        const gap = junitParityGap(
          [
            { rel: "tests/a.test.ts", mtimeMs: OLDER_MS },
            { rel: "tests/zz-scratch.test.ts", mtimeMs: NEWER_MS },
          ],
          ["tests/a.test.ts"],
          ARTIFACT_MS,
        );

        expect(gap.neverRan).toEqual([]);
        expect(gap.excludedNewer).toEqual(["tests/zz-scratch.test.ts"]);
        expect(gap.vacuous).toBe(false);
        expect(gap.comparedCount).toBe(1);
      },
    );

    test(
      "CASE 2 — a file OLDER than the artifact and absent from it existed " +
        "while that full run happened, so it is INVISIBLE COVERAGE: still a " +
        "gap, still named (AC6, C1's step-D proof, preserved)",
      () => {
        const gap = junitParityGap(
          [
            { rel: "tests/a.test.ts", mtimeMs: OLDER_MS },
            { rel: "tests/store.test.ts", mtimeMs: OLDER_MS },
          ],
          ["tests/a.test.ts"],
          ARTIFACT_MS,
        );

        expect(gap.neverRan).toEqual(["tests/store.test.ts"]);
        expect(gap.excludedNewer).toEqual([]);
        expect(gap.vacuous).toBe(false);
      },
    );

    test(
      "CASE 3 — an artifact naming a file no longer on disk records a " +
        "DELETION since the run: named, not failed on (a deletion time is " +
        "unrecoverable, and a junit artifact cannot name a file that never " +
        "existed)",
      () => {
        const gap = junitParityGap(
          [{ rel: "tests/a.test.ts", mtimeMs: OLDER_MS }],
          ["tests/a.test.ts", "tests/deleted.test.ts"],
          ARTIFACT_MS,
        );

        expect(gap.neverRan).toEqual([]);
        expect(gap.ranButAbsent).toEqual(["tests/deleted.test.ts"]);
        expect(gap.vacuous).toBe(false);
      },
    );

    test(
      "ANTI-VACUITY — when case 1 excludes EVERY on-disk file (a `git " +
        "checkout` resetting every mtime does exactly this) the comparison " +
        "set is EMPTY, and an empty comparison must SKIP with the reason, " +
        "never pass: a green tick over an empty set is the vacuity §S1 " +
        "refused, one layer down",
      () => {
        const gap = junitParityGap(
          [
            { rel: "tests/a.test.ts", mtimeMs: NEWER_MS },
            { rel: "tests/b.test.ts", mtimeMs: NEWER_MS },
          ],
          [],
          ARTIFACT_MS,
        );

        expect(gap.vacuous).toBe(true);
        expect(gap.comparedCount).toBe(0);
        expect(gap.neverRan).toEqual([]);
        expect(gap.reason).toContain("2");
        expect(gap.reason.toLowerCase()).toContain("empty");
      },
    );

    test(
      "THE ORCHESTRATOR'S REPRODUCTION, END TO END on a fixture tree: a full " +
        "artifact with a full stamp, then a test file created AFTERWARDS — " +
        "the precondition still holds, the conclusion is still reached, and " +
        "it does NOT fail; the new file is named as excluded-because-newer",
      () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr101-fix-e2e-"));
        try {
          const testsDir = path.join(root, "tests");
          const reportsDir = path.join(root, "test-reports");
          fs.mkdirSync(testsDir);
          fs.mkdirSync(reportsDir);

          const ranAt = Math.floor(ARTIFACT_MS / 1000);
          for (const name of ["a.test.ts", "b.test.ts"]) {
            const file = path.join(testsDir, name);
            fs.writeFileSync(file, "// existed before the run\n");
            plantMtime(file, ranAt - 60);
          }

          // A FULL run over exactly those files, stamped `full` by the client.
          fs.writeFileSync(
            path.join(reportsDir, "junit.xml"),
            junitFor(["tests/a.test.ts", "tests/b.test.ts"]),
          );
          fs.writeFileSync(
            path.join(reportsDir, SCOPE_RECORD),
            JSON.stringify({ scope: FULL_SCOPE, artifact: "junit.xml", targets: [] }),
          );
          plantMtime(path.join(reportsDir, "junit.xml"), ranAt);

          // ...and then a RED phase adds a test file, as every RED phase does.
          const added = path.join(testsDir, "zz-cr101-scratch.test.ts");
          fs.writeFileSync(added, "// added after that run\n");
          plantMtime(added, ranAt + 60);

          expect(fullRunProof(reportsDir).provenFull).toBe(true);

          const inputs = parityInputs(root, testsDir, reportsDir);
          const gap = junitParityGap(inputs.onDisk, inputs.ranFiles, inputs.artifactMtimeMs);

          expect(gap.neverRan).toEqual([]);
          expect(gap.ranButAbsent).toEqual([]);
          expect(gap.excludedNewer).toEqual(["tests/zz-cr101-scratch.test.ts"]);
          expect(gap.vacuous).toBe(false);
          expect(gap.comparedCount).toBe(2);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    );
  },
);

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
// decision is a pure function of TOML TEXT (`discoveryExclusions`, beside
// the two assertions it serves), so the fixture's config reaches exactly the
// decision the real one reaches.
//   * bun's real behaviour — a REAL client run (`clients/bun-crucible.py
//     test` with NO targets, so the runner's own discovery decides what to
//     collect), read back on TWO independent channels: the file set named
//     by the run's OWN junit report, and the FILE COUNT bun states in its
//     own console summary line (`Ran 2 tests across 2 files.`). Different
//     producers, different text, and they are required to AGREE — a
//     disagreement is the only shape in which this fixture could lie, so it
//     is a named failure rather than a silent preference for one channel.
//     Never predicted, never assumed.
//   * the guard's reaction — `discoveryExclusions` over that same fixture
//     bunfig, required to REPORT the exclusion on both dimensions the two
//     existing assertions cover.
// Removing the exclusion flips every observation: bun collects both files,
// counts two of them, and the guard reports nothing.
//
// WHY THE COUNT AND NOT THE FILE NAMES, on the console channel: the client
// always runs bun with `--reporter=junit --reporter-outfile=…`, and under
// that reporter bun prints ONLY the summary — no per-file header is emitted
// in any case, ever (measured, bun 1.3.14, 2026-09-04). A console assertion
// naming a file is therefore not flaky but UNSATISFIABLE under the very
// invocation this fixture uses. The summary's file count is the statement
// bun does make, it is independent of the junit report, and it flips
// exactly with the exclusion.
//
// WHY A FIXTURE AND NOT THIS TREE: bun 1.3.14 has no discovery-listing and
// no dry-run flag, so "enumerate what the runner would collect" over this
// repo means actually RUNNING it — the ~5.5-minute nested full-suite
// `Bun.spawn` CR-CRU-047 deleted and this file's header explains at length.
// The fixture buys the same signal at ~70 ms per run (measured 2026-09-04).
//
// A MEASURED ASYMMETRY, kept because it is WHY there are two assertions and
// not one. Not every `pathIgnorePatterns` spelling excludes anything.
// Measured against bun 1.3.14 over this fixture: `["tests/hidden/"]` and
// `["hidden"]` hide NOTHING (both files still run), while
// `["tests/hidden/*"]`, `["**/hidden/*"]` and `["**/hidden/**"]` each hide
// the file. The last of those hides a file UNDER tests/ with the literal
// text `tests/` appearing NOWHERE in the config — so the second assertion
// ("never references the tests/ tree") cannot see it and the first ("no
// pathIgnorePatterns key AT ALL") is the one that fires. That is why the
// first is the primary one, and the third test below is that exact case.

const FIXTURE_VISIBLE = "tests/visible.test.ts";
const FIXTURE_HIDDEN = "tests/hidden/ignored.test.ts";

// The fixture's configurations — identical `[test]` sections differing only
// in the one line whose presence is the entire claim.
const FIXTURE_EXCLUDES_TESTS_DIR = '[test]\npathIgnorePatterns = ["tests/hidden/*"]\n';
const FIXTURE_EXCLUDES_BY_GLOB = '[test]\npathIgnorePatterns = ["**/hidden/**"]\n';
const FIXTURE_EXCLUDES_NOTHING = "[test]\n";
const FIXTURE_EXCLUSION_COMMENTED = '[test]\n# pathIgnorePatterns = ["tests/hidden/*"]\n';

// The prose shape the REAL bunfig.toml takes today: five comment lines, one
// of which names the key verbatim. Planted rather than read, because a claim
// about the real file's COMMENT TEXT would be a contract over mutable state —
// the very defect family this CR is about.
const BUNFIG_PROSE_WARNING =
  "# Do not reintroduce `[test] pathIgnorePatterns` for the tests/ tree: a\n" +
  "# permanently-excluded directory makes the suite size unreconcilable.\n";

// A fixture project with TWO test files — one directly under `tests/`, one a
// directory deeper, which is the only structure an exclusion can
// discriminate between — and `bunfig` as its own bunfig.toml.
function writeExclusionFixtureProject(dir: string, bunfig: string): void {
  writeFixturePackage(dir);
  writeFixtureTest(dir, FIXTURE_VISIBLE, "visible fixture test");
  writeFixtureTest(dir, FIXTURE_HIDDEN, "hidden fixture test");
  fs.writeFileSync(path.join(dir, "bunfig.toml"), bunfig);
}

export interface FixtureRunObservation {
  // Every `.test.ts` under the fixture's tests/ tree, whatever ran.
  onDisk: string[];
  // CHANNEL ONE — the distinct files the run's own junit report names.
  ranFiles: string[];
  // CHANNEL TWO — the file count bun states in its own console summary,
  // parsed from the run's captured output. `null` means the run said
  // nothing countable, which is never the same claim as zero.
  collectedFiles: number | null;
}

// Runs the REAL producing client over the fixture with no targets, so bun's
// own discovery decides, and reports what the run itself said it ran — on
// both channels.
async function observeFixtureRun(dir: string): Promise<FixtureRunObservation> {
  const run = await runClientTest(dir, []);
  expect(run.code).toBe(0);
  const junit = fs.readFileSync(path.join(dir, "test-reports", "junit.xml"), "utf8");
  return {
    onDisk: listTestFilesOnDisk(path.join(dir, "tests"))
      .map((full) => path.relative(dir, full).split(path.sep).join("/"))
      .sort(),
    ranFiles: distinctJunitTestcaseFiles(junit).sort(),
    collectedFiles: collectedFileCount(run.stderr),
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
    // NAMED in the output even on success, the way the corroboration above
    // names its non-fatal verdicts: these facts side by side ARE the
    // evidence that the guard is load-bearing, and evidence nobody can read
    // is evidence nobody can check.
    console.error(
      `[suite-integrity §S2] ${slug}: on disk ${observed.onDisk.join(", ")} | ` +
        `bun collected ${observed.ranFiles.join(", ")} | bun counted ` +
        `${observed.collectedFiles === null ? "unknown" : observed.collectedFiles} file(s) | ` +
        `guard reported ${JSON.stringify(discoveryExclusions(bunfig))}`,
    );
    // THE TWO CHANNELS MUST AGREE, in every case, before any case-specific
    // claim is believed. Junit report and console summary are produced by
    // different code over different text; a fixture that lied — a stale
    // artifact read back, a run that never happened — would have to make
    // both lie the same way, and a disagreement is a failure in its own
    // right rather than a choice between witnesses.
    expect({ channel: "bun's summary file count", files: observed.collectedFiles }).toEqual({
      channel: "bun's summary file count",
      files: observed.ranFiles.length,
    });
    body(observed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The console channel's PARSER, exercised on planted text as well as on the
// real runs below, because the fixture cases can only ever show it the two
// shapes their own exclusion produces.
const PLANTED_ONE_FILE =
  "[crucible] running: bun test --reporter=junit --reporter-outfile=/tmp/x/junit.xml  (cwd=/tmp/x)\n" +
  "bun test v1.3.14 (0d9b296a)\n\n 1 pass\n 0 fail\n 1 expect() calls\n" +
  "Ran 1 test across 1 file. [9.00ms]\n[crucible] bun test exit=0\n";
const PLANTED_TWO_FILES =
  "[crucible] running: bun test --reporter=junit --reporter-outfile=/tmp/x/junit.xml  (cwd=/tmp/x)\n" +
  "bun test v1.3.14 (0d9b296a)\n\n 2 pass\n 0 fail\n 2 expect() calls\n" +
  "Ran 2 tests across 2 files. [10.00ms]\n[crucible] bun test exit=0\n";

describe("CR-CRU-101 §S2 — bun's summary file count, read off planted console text", () => {
  test(
    "the singular and plural spellings of the summary line are the SAME " +
      "count channel — bun writes `1 test across 1 file` and `2 tests " +
      "across 2 files`, and a parser that only knew one of them would read " +
      "the other as no answer at all",
    () => {
      expect(collectedFileCount(PLANTED_ONE_FILE)).toBe(1);
      expect(collectedFileCount(PLANTED_TWO_FILES)).toBe(2);
    },
  );

  test(
    "console text with NO summary line at all is UNKNOWN, never zero: a " +
      "missing count that read as 0 would make a fixture whose exclusion " +
      "hid EVERYTHING look exactly like a correctly-counted empty run",
    () => {
      expect(collectedFileCount("[crucible] running: bun test\n[crucible] bun test exit=1\n")).toBe(
        null,
      );
      expect(collectedFileCount("")).toBe(null);
    },
  );

  test(
    "the count read is the FILE count and not the test count — the two " +
      "differ in every run that matters, and a parser reaching for the " +
      "first number on the line would return the wrong one",
    () => {
      expect(collectedFileCount("Ran 7 tests across 3 files. [12.00ms]\n")).toBe(3);
    },
  );
});

describe(
  "CR-CRU-101 §S2 — a test file the runner's discovery does not reach is " +
    "MISSED by a real run and REPORTED by the guard, both observed in a " +
    "scratch fixture (AC3/AC4)",
  () => {
    test(
      "a pathIgnorePatterns entry naming the fixture's tests/hidden/ really " +
        "does hide that file from a real bun run — the run's own junit " +
        "report names only the visible file and its own summary counts one " +
        "file — and the guard REPORTS that entry on both of its dimensions",
      async () => {
        await inExclusionFixture("excluded", FIXTURE_EXCLUDES_TESTS_DIR, (observed) => {
          // HALF ONE — bun's behaviour, read out of the run's own output on
          // both channels (already required to agree with each other).
          expect(observed.onDisk).toEqual([FIXTURE_HIDDEN, FIXTURE_VISIBLE]);
          expect(observed.ranFiles).toEqual([FIXTURE_VISIBLE]);
          expect(observed.collectedFiles).toBe(1);

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
      "removing that one line flips EVERY observation: the same fixture's " +
        "run collects both files, counts two of them, and the guard reports " +
        "nothing — so the green verdict the two assertions above reach on " +
        "the real bunfig.toml is a verdict, not a tautology",
      async () => {
        await inExclusionFixture("no-exclusion", FIXTURE_EXCLUDES_NOTHING, (observed) => {
          expect(observed.onDisk).toEqual([FIXTURE_HIDDEN, FIXTURE_VISIBLE]);
          expect(observed.ranFiles).toEqual([FIXTURE_HIDDEN, FIXTURE_VISIBLE]);
          expect(observed.collectedFiles).toBe(2);

          expect(discoveryExclusions(FIXTURE_EXCLUDES_NOTHING)).toEqual([]);
        });
      },
    );

    test(
      "the spelling that hides a tests/ file WITHOUT naming tests/ " +
        "(`**/hidden/**`, measured) is invisible to the second assertion and " +
        "caught by the FIRST — which is why the primary guard is `no " +
        "pathIgnorePatterns key at all`",
      async () => {
        await inExclusionFixture("glob", FIXTURE_EXCLUDES_BY_GLOB, (observed) => {
          expect(observed.ranFiles).toEqual([FIXTURE_VISIBLE]);
          expect(observed.collectedFiles).toBe(1);

          const reported = discoveryExclusions(FIXTURE_EXCLUDES_BY_GLOB);
          expect(reported).toEqual([
            {
              arrayText: '["**/hidden/**"]',
              patterns: ["**/hidden/**"],
              referencesTestsDir: false,
            },
          ]);
          // The two verdicts the assertions at the top of this file reach,
          // applied to this config instead of the repo's: the first FIRES on
          // it, the second cannot see it.
          expect(reported).not.toEqual([]);
          expect(reported.filter((e) => e.referencesTestsDir)).toEqual([]);
        });
      },
    );

    test(
      "the guard reads CONFIGURATION, not prose: a commented-out exclusion " +
        "hides nothing from a real run — observed — and is reported by " +
        "neither dimension, as is the warning-comment shape the real " +
        "bunfig.toml is made of",
      async () => {
        await inExclusionFixture("commented", FIXTURE_EXCLUSION_COMMENTED, (observed) => {
          expect(observed.ranFiles).toEqual([FIXTURE_HIDDEN, FIXTURE_VISIBLE]);
          expect(observed.collectedFiles).toBe(2);

          expect(discoveryExclusions(FIXTURE_EXCLUSION_COMMENTED)).toEqual([]);
          expect(discoveryExclusions(BUNFIG_PROSE_WARNING)).toEqual([]);
          // ...and the same line, uncommented, IS reported — so the
          // stripping above is a discrimination, not a blind spot.
          expect(discoveryExclusions(FIXTURE_EXCLUDES_TESTS_DIR)).toHaveLength(1);
        });
      },
    );
  },
);
