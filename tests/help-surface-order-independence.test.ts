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
// THE ORDER IS FORCED, AND STILL READ OUT OF THE RUN. bun's file order is not
// the argument order — four probes across both argument orders ran the
// Chromium file first every time, and mtime-ascending is falsified. That
// reproducibility was never a guarantee, and it did not hold: the pairing
// later flipped to help-first, and the bisection put the cause in a `.py`
// client that neither named file imports and this file does not run —
// reverting that one file alone restored browser-first scheduling, reverting
// either other changed file alone did not. The runner's choice for a NAMED
// PAIR is therefore sensitive to repository state with nothing to do with the
// pairing, so a guard that merely reads the order and hopes spends its life
// either red for a cause no one can act on, or — the day it flips back —
// green while starving nothing.
//
// SO THE CHILD IS HANDED ONE FILE. It is written beside the report it will
// produce, DERIVED from the two constants below, and it `require`s the browser
// file and then the help file inside two `describe`s named after them. Module
// evaluation is ordered and `require` is synchronous, so the last browser test
// is followed by the first help test in ONE process with nothing between them:
// the precondition this guard needs, held by construction instead of by the
// runner's scheduling. The order is STILL an output — the groups appear in the
// report in the order they executed, and it is asserted, because a wrapper
// that stopped forcing what it claims (a group that collected nothing, a
// require the runner reordered) must fail here rather than pass vacuously. If
// the browser group did not run first, this guard has starved nothing and
// fails saying so.
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
//
// IT PINS THAT RUNNER'S JUNIT FORMAT TOO, deliberately and loudly. The order
// regex below depends on the reporter's INDENTATION (the child runs ONE file,
// so two leading spaces is that file and FOUR is a required group — six and
// deeper are the describe blocks inside the file that group required), the
// duration regex on its ATTRIBUTE ORDER (`name` … `classname` … `time`), and
// the attribution on `classname` carrying the enclosing describes innermost
// first, so the group's label — the required file — is its LAST segment. None
// can fail quietly: a format change empties `filesRun` and reddens the order
// assertion, or drops the case names and reddens `helpTestRan`, or drops
// `time` and reddens the budget with a NaN. So if this guard goes red in those
// shapes at once, suspect the reporter's format before suspecting a starved
// run.
//
// WHAT IT DOES NOT PIN IS THE ESCAPING DEPTH, and that line is drawn from two
// measured reports rather than from one runner's habit. The two runners disagree
// about `classname` alone: 1.3.14 joins already-escaped describe names with the
// literal text " &gt; " and escapes that whole string AGAIN when it writes the
// attribute (`… &amp;gt; tests/…`), while 1.4.2 — the Rust rewrite, whose own
// suite asserts it "escapes the classname attribute exactly once" — joins RAW
// names with " > " and escapes once (`… &gt; tests/…`). Separator, order and
// the `name` attribute's single escaping are identical underneath. So the
// attribution below decodes the attribute and splits on that shared separator
// instead of hand-matching one runner's escaping, which is the whole of
// CR-CRU-136: the same run that passed locally reported `helpTestRan: false` on
// CI, with order, counts and failures all correct.
//
// HOW THAT DIVERGENCE REACHED CI AT ALL, and what closed it: `setup-bun@v2` was
// UNPINNED in .github/workflows/release.yml, so CI silently ran whatever bun was
// latest while these budgets were measured against 1.3.14 — every duration below
// was therefore unpinned on the one machine that gates the release. CR-CRU-136
// pins all four `setup-bun` steps to the version this suite is measured against
// (1.4.2, adopted locally in the same change so the two agree), which is why the
// paragraph above can call the escaping depth DELIBERATELY unpinned: the decode
// makes it not matter, and the pin makes a runner change a deliberate commit that
// re-runs these budgets rather than a silent drift.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../scripts/test-targets";

/** The pairing, in the order the child is made to run it. The wrapper that
 *  forces that order is GENERATED from these two constants, so the files it
 *  requires cannot drift from the files this guard names — and the order the
 *  run actually produced is still an OUTPUT, asserted below. */
const BROWSER_FILE = join("tests", "roadmap-visual-grammar.test.ts");
const HELP_FILE = join("tests", "project-namespace-tripwire.test.ts");

/** The test whose completion IS the contract. Pinned by name so that a run
 *  which merely reports no failures — because the test stopped existing —
 *  cannot satisfy this guard. */
const HELP_TEST_NAME =
  "every verb's --help and every client's root help, driven for real, print no CR namespace literal";

// TWO BUDGETS WITH DIFFERENT JOBS — a DETECTOR and a BACKSTOP — both derived
// from measured runs rather than guessed, because one whole-invocation number
// is a weak signal on its own: it is the sum of Chromium's cost, this machine's
// load and the collection loop, so any bound tight enough to catch the stall is
// also tight enough to flake on a busy machine — which would reintroduce the
// very disease this guard cures.
//
// THE DETECTOR is the help test's OWN duration, read out of the child's JUnit
// report. It measures the thing this CR is about, and it is immune to how long
// Chromium's share of the run took or to load on anything else in the pairing.
// Healthy it is 11.65-12.25s (all 168 surfaces, collected synchronously);
// starved it is 180.00s, its cap, every time. 60s is ~4.9x healthy (60 / 12.25)
// and 3x below starved. It is NOT a copy of the help test's own 180s cap: that
// cap is the ceiling a starved run reaches, this is the ceiling an honest one
// stays under.
const HELP_TEST_BUDGET_MS = 60_000;
// THE BACKSTOP bounds the whole invocation. Its ONLY job is catching a hang
// somewhere ELSE in the pairing — one the outcome assertion cannot see, and
// which would otherwise surface only when the child is killed mute at its 280s
// net. It is therefore held FAR out, because a backstop that competes with the
// detector is worse than no backstop: at the 150s this line used to carry it
// sat ~3.1x above a healthy 48.43s pairing while the detector sits ~4.9x above
// a healthy 12.25s help test, so a uniform machine slowdown reddened THIS line
// first, at ~3.1x, with the help test still at ~38s and honestly passing — the
// guard would have gone red naming the invocation instead of the starved test,
// exactly the flake mode the paragraph above exists to avoid. 180s puts that
// crossing at ~3.7x (180 / 48.43), by which point the help test is at ~45s and
// closing on its own bound, and it stays clear of the starved signature
// (202.72s and 210.89s reproduced) and under the child's 280s net. The
// starvation itself is not a uniform slowdown — the help test pins at 180s
// while the rest of the pairing is unchanged — and the detector is asserted
// FIRST, so it is the line that names the starved test.
const PAIRED_RUN_BUDGET_MS = 180_000;
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

      // THE WRAPPER, written from the constants above. It sits beside the
      // report and outside the checkout, so no discovery but this run's will
      // ever collect it and the repo gains no second copy of the pairing. The
      // child's cwd is still the repo, so `bunfig.toml` (and its store
      // preload) applies exactly as it does to a normal run, and each
      // `require` resolves from the required file's own directory — an
      // absolute path in, a module that sees its own `import.meta.dir` out.
      const pairedFile = join(reportDir, "paired-run.test.ts");
      writeFileSync(
        pairedFile,
        `import { describe } from "bun:test";\n` +
          [BROWSER_FILE, HELP_FILE]
            .map(
              (file) =>
                `describe(${JSON.stringify(file)}, () => {\n  require(${JSON.stringify(join(REPO_ROOT, file))});\n});\n`,
            )
            .join(""),
      );

      const startedAt = Bun.nanoseconds();
      const child = Bun.spawnSync({
        cmd: ["bun", "test", "--reporter=junit", "--reporter-outfile", reportPath, pairedFile],
        cwd: REPO_ROOT,
        env: { ...process.env },
        timeout: CHILD_HARD_CAP_MS,
        stdout: "pipe",
        stderr: "pipe",
      });
      const elapsedMs = Math.round((Bun.nanoseconds() - startedAt) / 1e6);
      const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
      rmSync(reportDir, { recursive: true, force: true });

      // The two required groups, in the order the child RAN them: a describe
      // runs where it was declared, so document order is execution order. The
      // child collected ONE file, so two leading spaces is the wrapper and
      // FOUR is a group the wrapper named — six and deeper are the describe
      // blocks inside the file that group required.
      const filesRun = [...report.matchAll(/^ {4}<testsuite name="([^"]+)"[^>]*tests="(\d+)"/gm)].map(
        ([, file, tests]) => ({ file, tests: Number(tests) }),
      );
      // WHICH FILE A CASE CAME FROM is read off `classname`, not off `file`:
      // every case in this run belongs to the wrapper's path, while classname
      // carries the enclosing describes innermost first, so its LAST segment
      // is the group's label — the required file itself.
      //
      // IT IS DECODED, NOT PATTERN-MATCHED. One pass peels exactly one layer of
      // XML escaping — `&amp;` LAST, so a double-escaped ampersand loses one
      // layer per pass instead of two — and `classname` is decoded to a FIXPOINT
      // because its escaping DEPTH is the one thing about this format the two
      // runners disagree on (see the header): 1.3.14 needs two passes, 1.4.2
      // one. Underneath, both join on the same literal " > ", so that is what
      // the file label is split out on, and the segment this reads is a
      // repo-relative path holding no entity, so an extra pass cannot corrupt
      // it. The NAME attribute is escaped exactly ONCE by both runners and gets
      // exactly one pass, so a test name that really does contain `&amp;`
      // survives being read.
      const decodeXmlOnce = (value: string) =>
        value
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&quot;", '"')
          .replaceAll("&apos;", "'")
          .replaceAll("&amp;", "&");
      const decodeXml = (value: string) => {
        let decoded = value;
        let next = decodeXmlOnce(decoded);
        while (next !== decoded) {
          decoded = next;
          next = decodeXmlOnce(decoded);
        }
        return decoded;
      };
      const caseKey = (name: string, classname: string) =>
        `${decodeXml(classname).split(" > ").at(-1)?.trim() ?? ""} › ${decodeXmlOnce(name)}`;
      const casesRun = [...report.matchAll(/<testcase name="([^"]*)" classname="([^"]*)"/g)].map(
        ([, name, classname]) => caseKey(name, classname),
      );
      const failed = [
        ...report.matchAll(/<testcase name="([^"]*)" classname="([^"]*)"[^>]*>\s*<failure type="([^"]*)"/g),
      ].map(([, name, classname, type]) => `${caseKey(name, classname)} [${type}]`);

      // THE SHARP SIGNAL, read out of the child's own report: bun's junit
      // reporter emits `time` in SECONDS on each testcase, so this is the help
      // test's duration as the run that ran it measured it — not a subtraction
      // from the wall clock, and not affected by Chromium's half of the run.
      // NaN when the testcase is absent, which fails the budget below rather
      // than passing vacuously.
      const helpTestMs = Math.round(
        Number(
          [...report.matchAll(/<testcase name="([^"]*)" classname="([^"]*)" time="([^"]*)"/g)].find(
            ([, name, classname]) => caseKey(name, classname) === `${HELP_FILE} › ${HELP_TEST_NAME}`,
          )?.[3] ?? "NaN",
        ) * 1000,
      );

      console.error(
        `[help-surface-order] child bun test: exit=${child.exitCode} signal=${child.signalCode ?? "none"} ` +
          `elapsed=${elapsedMs}ms budget=${PAIRED_RUN_BUDGET_MS}ms ` +
          `helpTest=${helpTestMs}ms budget=${HELP_TEST_BUDGET_MS}ms ` +
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
      // nothing, so it fails here rather than passing vacuously. The wrapper
      // forces this; the assertion is what catches a wrapper that stopped
      // forcing it.
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
      // a green this CR accepts. Floors, against 91 and 21 as measured — the
      // group counts a required file yields, which is what a collection that
      // quietly emptied would drop.
      expect(filesRun[0]?.tests).toBeGreaterThanOrEqual(80);
      expect(filesRun[1]?.tests).toBeGreaterThanOrEqual(21);

      // AND IT COMPLETED ON ITS MERITS, not eventually. The starved run is
      // green-but-late for nobody: it ends at 202.72s BECAUSE the help test
      // gave up, so these two lines are the ones that turn "slower than it can
      // honestly be" into a failure even if the counts ever come back clean.
      // The help test's own duration is asserted FIRST because it is the sharp
      // one: it names the starved test rather than the slow invocation.
      expect(helpTestMs).toBeLessThanOrEqual(HELP_TEST_BUDGET_MS);
      expect(elapsedMs).toBeLessThanOrEqual(PAIRED_RUN_BUDGET_MS);
    },
    GUARD_TIMEOUT_MS,
  );
});
