// THE PRINTED-HELP SURFACES ARE COLLECTED ON THEIR MERITS, WHATEVER RAN
// BEFORE THEM.
//
// tests/project-namespace-tripwire.test.ts drives every client verb's `--help`
// for real — 168 surfaces across five clients — and inspects each for a
// project-namespace literal. Standalone that costs 3.22s against its own 180s
// cap. Run IMMEDIATELY AFTER the Chromium geometry suite in the SAME bun
// invocation, it reaches that cap instead: 110 pass / 1 fail in 202.72s,
// reproduced 4/4 (measured 2026-09-08). A gate that answers differently
// depending on what preceded it cannot gate, and the pairing below is the
// shape agents actually type — a targeted run of two files.
//
// THE MECHANISM, bisected and recorded before this guard was written. After a
// file has driven Chromium through playwright in the same bun process, ONE
// child of a concurrently spawned batch has its stderr pipe torn down without
// its reader promise settling and without the child being reaped: the child is
// a zombie (`State: Z`, ppid = the bun test process), bun holds no fd for it
// at all (536 open fds, of which 0 pipes), so `new Response(proc.stderr).text()`
// can never resolve. It does not complete late — 20s, 90s, 150s and 180s caps
// were all reached and no natural completion was ever observed. The defect is
// the runner's bookkeeping, not this repo's test; what this repo owns is the
// contract this file asserts.
//
// WHY A CHILD INVOCATION, which is the only shape that can observe it. The
// condition lives in ONE bun process's state and only when the browser file is
// the IMMEDIATELY PRECEDING file: in a full-suite run the same two files sit
// ten files apart in one process and both pass, the help test in 3.2s. So no
// in-process assertion can reach it, and the guard drives the pairing as a
// child `bun test` and asserts that child's own report.
//
// THE ORDER IS READ OUT OF THE RUN, NEVER ASSUMED. bun's file order is not the
// argument order — four probes across both argument orders ran the Chromium
// file first every time, and mtime-ascending is falsified — so a guard that
// took the argument order for the run order would quietly stop proving
// anything the day the runner's scheduling changed. If the browser file did
// not run first, this guard has starved nothing and fails saying so.
//
// IT SPAWNS SYNCHRONOUSLY, DELIBERATELY. This file is INTEGRATION and may
// itself run after the Chromium suite inside one invocation — precisely the
// state that breaks the asynchronous pipe read above. `Bun.spawnSync` is the
// shape measured immune to it (all 168 surfaces, first work after the browser
// file, 12.00s), so the guard cannot be taken out by the defect it exists to
// detect.
//
// PINNED TO bun 1.3.14 (0d9b296a). Every duration below was measured against
// that runner and the budget is a claim about its scheduling, so a runner
// upgrade re-opens this question deliberately rather than silently.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../scripts/test-targets";

/** The pairing, in the argument order the reproduction uses. Which of the two
 *  bun actually runs first is an OUTPUT of the run, asserted below. */
const BROWSER_FILE = join("tests", "roadmap-visual-grammar.test.ts");
const HELP_FILE = join("tests", "project-namespace-tripwire.test.ts");

/** The test whose completion IS the contract. Pinned by name so that a run
 *  which merely reports no failures — because the test stopped existing —
 *  cannot satisfy this guard. */
const HELP_TEST_NAME =
  "every verb's --help and every client's root help, driven for real, print no CR namespace literal";

// THE BUDGET, DERIVED FROM THE STARVED RUN RATHER THAN GUESSED. This guard's
// own first run took 218.27s, of which the help test's cap is 180.00s — so
// EVERYTHING ELSE in the pairing (Chromium's 90 tests, the help file's other
// 20, two process starts) costs 38.27s. Add the 12.00s that collecting all 168
// surfaces costs when it is not starved and a healthy pairing is ~50s. 90s is
// ~1.8x above that and ~2.4x below the starved run — wide enough that ordinary
// load cannot trip it, tight enough that the stall cannot pass itself off as
// slowness. It is NOT a copy of the help test's own 180s cap: that cap bounds
// one test's collection loop, this bounds the whole paired invocation.
const PAIRED_RUN_BUDGET_MS = 90_000;
// The net under the child, held clear of the 218.27s a starved run takes to end
// ITSELF (the CR's first reproduction was 202.72s, so this varies by ~8%), so a
// starved child still writes the report that names WHY it was slow instead of
// being killed mute.
const CHILD_HARD_CAP_MS = 280_000;
// This test's own cap: the child's net plus room to read and parse its report.
const GUARD_TIMEOUT_MS = 340_000;

describe("the printed-help surfaces are collected on their merits, whatever ran before them", () => {
  test(
    "paired behind the browser suite in one bun invocation, the help surfaces still complete green and within budget",
    () => {
      const reportDir = mkdtempSync(join(tmpdir(), "help-surface-order-"));
      const reportPath = join(reportDir, "paired-run.junit.xml");

      const startedAt = Bun.nanoseconds();
      const child = Bun.spawnSync({
        cmd: ["bun", "test", "--reporter=junit", "--reporter-outfile", reportPath, BROWSER_FILE, HELP_FILE],
        cwd: REPO_ROOT,
        env: { ...process.env },
        timeout: CHILD_HARD_CAP_MS,
        stdout: "pipe",
        stderr: "pipe",
      });
      const elapsedMs = Math.round((Bun.nanoseconds() - startedAt) / 1e6);
      const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
      rmSync(reportDir, { recursive: true, force: true });

      // The file-level suites, in the order bun RAN them: bun runs one file at
      // a time in a process, so document order is execution order. Two leading
      // spaces is the file level — four and deeper are the describe blocks
      // inside it.
      const filesRun = [...report.matchAll(/^ {2}<testsuite name="([^"]+)"[^>]*tests="(\d+)"/gm)].map(
        ([, file, tests]) => ({ file, tests: Number(tests) }),
      );
      const casesRun = [...report.matchAll(/<testcase name="([^"]*)"[^>]*file="([^"]*)"/g)].map(
        ([, name, file]) => `${file} › ${name.replaceAll("&apos;", "'")}`,
      );
      const failed = [
        ...report.matchAll(/<testcase name="([^"]*)"[^>]*file="([^"]*)"[^>]*>\s*<failure type="([^"]*)"/g),
      ].map(([, name, file, type]) => `${file} › ${name.replaceAll("&apos;", "'")} [${type}]`);

      console.error(
        `[help-surface-order] child bun test: exit=${child.exitCode} signal=${child.signalCode ?? "none"} ` +
          `elapsed=${elapsedMs}ms budget=${PAIRED_RUN_BUDGET_MS}ms ` +
          `order=${filesRun.map((f) => `${f.file}(${f.tests})`).join(" then ")} failed=${failed.length}`,
      );
      if (child.exitCode !== 0) {
        console.error(child.stderr.toString().trimEnd().split("\n").slice(-12).join("\n"));
      }

      // THE CHILD ENDED ITSELF. A run killed at the net leaves no report, and
      // every assertion below would then be arguing from an empty string.
      expect({ signal: child.signalCode ?? "none", reportWritten: report.length > 0 }).toEqual({
        signal: "none",
        reportWritten: true,
      });

      // THE ORDER THE RUN ACTUALLY PRODUCED. Both files ran, and the browser
      // file ran FIRST — without that this pairing starves nothing and proves
      // nothing, so it fails here rather than passing vacuously.
      expect(filesRun.map((f) => f.file)).toEqual([BROWSER_FILE, HELP_FILE]);

      // THE OUTCOME, on the child's reported counts and not on its exit code
      // alone: the help test RAN, and nothing in the pairing failed.
      expect({
        exitCode: child.exitCode,
        failed,
        helpTestRan: casesRun.includes(`${HELP_FILE} › ${HELP_TEST_NAME}`),
      }).toEqual({ exitCode: 0, failed: [], helpTestRan: true });

      // NON-VACUITY. A pairing that silently stopped collecting — an empty
      // suite, a mis-parsed verb list, a file that reported one test — is not
      // a green this CR accepts. Floors, against 90 and 21 as measured.
      expect(filesRun[0]?.tests).toBeGreaterThanOrEqual(80);
      expect(filesRun[1]?.tests).toBeGreaterThanOrEqual(21);

      // AND IT COMPLETED ON ITS MERITS, not eventually. The starved run is
      // green-but-late for nobody: it ends at 202.72s BECAUSE the help test
      // gave up, so this line is the one that turns "slower than it can
      // honestly be" into a failure even if the counts ever come back clean.
      expect(elapsedMs).toBeLessThanOrEqual(PAIRED_RUN_BUDGET_MS);
    },
    GUARD_TIMEOUT_MS,
  );
});
