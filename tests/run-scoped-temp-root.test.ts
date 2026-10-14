// A test run must leave the temp directory tree exactly as it found it. Two
// independent guarantees are asserted here:
//
//   1. Each of a representative set of suites — the ones measured to leave
//      directories behind — removes what it creates, by itself, with no help
//      from any shared backstop. (the "per-file" tests below)
//   2. A SWEEP across that same representative set, run under the ordinary
//      preload with nothing disabled, leaves the temp root exactly as it
//      started. (the single "guard" test below)
//
// ── How "the system temp root" is stood in for, safely ────────────────────
//
// None of this touches the host's real temp directory. Every check below
// creates its OWN empty directory first and hands it to the child process as
// `TMPDIR` — Node's (and Bun's) `os.tmpdir()`, and Python's
// `tempfile.gettempdir()`, both resolve relative to that env var on every
// call, not merely at process start. So "the system temp root", from the
// child's point of view, IS the directory this file made for it — and this
// file deletes that directory itself, in a `finally`, regardless of outcome.
//
// ── The switch a run-scoped backstop must expose ───────────────────────────
//
// The per-file checks must prove a suite cleans up ON ITS OWN, not that a
// shared backstop quietly swept up after it — a backstop that deletes
// everything under its own per-run root would make every one of these checks
// pass even if the suite itself leaked, which proves nothing about the suite.
// So every per-file check below sets `CRUCIBLE_TEST_TMPROOT_DISABLE=1` in the
// child's environment: the one switch a run-scoped backstop (wired through
// the test preload) is required to read and obey, skipping its own
// directory entirely when set. The sweep test, by contrast, leaves the
// switch UNSET — it is the one place in this file that exercises the
// backstop itself.
//
// ── "a passing AND a failing run" ──────────────────────────────────────────
//
// For a `bun test` target, a failing run is forced with `--timeout=1`: every
// test's own body still runs its (synchronous) directory-creation step
// before the 1ms budget expires, so the directory still gets made, but every
// test then times out and the process exits non-zero — a real failing run,
// not a skipped one. Measured directly against every suite below: the exit
// code moves from 0 to 1 and the leaked-directory count is UNCHANGED, so the
// forced-fail variant is a faithful stand-in for a suite failing on its own.
// For the two config-module targets there is no `test()`/`describe()` inside
// to force a verdict on (loading either one is a bare side effect with no
// pass/fail of its own), so each gets one check, not two — documented at its
// own test, not guessed.
//
// ── Suites this file does NOT drive directly, and why ──────────────────────
//
// Three of the sources named alongside this file's targets are reachable
// only through a REAL browser or a real end-to-end harness run (tens of
// seconds, a live server, a generated Playwright suite) — not through a
// targeted `bun test <file>`, which is what keeps every check in this file
// fast and deterministic. They are flagged rather than silently skipped:
//   - a visual-regression suite that launches a real Chromium instance for
//     part of its coverage;
//   - the suite that drives one full real end-to-end run of the shipped
//     client against a generated 16-feature Playwright suite (documented at
//     ~70s per invocation, in that suite's own header);
//   - a Playwright BDD step file whose scratch directory is only created
//     when a generated scenario actually invokes the step, which needs the
//     full `bddgen` + Playwright pipeline to reach at all.
// A fourth leak source named only as "one bare tmp.*" directory has no file
// identified for it and so cannot be targeted here either.
import { describe, test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The switch a run-scoped backstop must read to skip its own directory —
 *  see the file header. Not yet read by anything; that is this file's RED. */
const BACKSTOP_DISABLE_ENV = "CRUCIBLE_TEST_TMPROOT_DISABLE";

function freshScratchRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function scratchEntries(root: string): string[] {
  return existsSync(root) ? readdirSync(root) : [];
}

interface ChildRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `bun test <relFile>` as a real OS child, cwd-rooted at this repo (so
 *  bunfig.toml's preload applies exactly as it does for a normal run), with
 *  `TMPDIR` pointed at `scratchRoot`. */
function runBunTestChild(
  relFile: string,
  scratchRoot: string,
  opts: { forceFail?: boolean; disableBackstop?: boolean } = {},
): ChildRun {
  const args = ["test", `./${relFile}`];
  if (opts.forceFail) args.push("--timeout=1");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TMPDIR: scratchRoot };
  if (opts.disableBackstop) env[BACKSTOP_DISABLE_ENV] = "1";
  const result = Bun.spawnSync({
    cmd: ["bun", ...args],
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The suites measured to leak a directory, runnable deterministically via a
 *  targeted `bun test <file>` — see the file header for what is excluded and
 *  why. */
const TRACTABLE_BUN_SUITES = [
  "tests/queue-registration.test.ts",
  "tests/db-path-resolution.test.ts",
  "tests/releases.test.ts",
  "tests/checkpoint-stop.test.ts",
  "tests/cycle-epochs.test.ts",
  "tests/boot-safety.test.ts",
  "tests/plan-abort.test.ts",
  "playwright.config.ts",
  "tests/e2e/teardown-contracts/ephemeral.playwright.config.ts",
] as const;

describe("run-scoped temp root — a sweep across today's leaking suites, with nothing disabled", () => {
  test("every representative suite, run under the ordinary preload, leaves the temp root exactly as it started", () => {
    const scratchRoot = freshScratchRoot("guard-sweep-");
    try {
      const leaks: Array<{ file: string; newEntries: string[] }> = [];
      for (const relFile of TRACTABLE_BUN_SUITES) {
        const before = new Set(scratchEntries(scratchRoot));
        runBunTestChild(relFile, scratchRoot);
        const newEntries = scratchEntries(scratchRoot).filter((e) => !before.has(e));
        if (newEntries.length > 0) leaks.push({ file: relFile, newEntries });
      }
      expect(leaks).toEqual([]);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("run-scoped temp root — each suite cleans up on its own, backstop disabled", () => {
  for (const relFile of TRACTABLE_BUN_SUITES) {
    const isConfigModule = relFile.endsWith(".config.ts");

    if (isConfigModule) {
      test(`${relFile} leaves no new entry in its temp root after being loaded (backstop disabled)`, () => {
        const scratchRoot = freshScratchRoot("per-file-root-");
        try {
          const run = runBunTestChild(relFile, scratchRoot, { disableBackstop: true });
          const leftover = scratchEntries(scratchRoot);
          expect({ exitCode: run.exitCode, leftover }).toEqual({ exitCode: 0, leftover: [] });
        } finally {
          rmSync(scratchRoot, { recursive: true, force: true });
        }
      });
      continue;
    }

    test(`${relFile} leaves no new entry in its temp root after a passing run (backstop disabled)`, () => {
      const scratchRoot = freshScratchRoot("per-file-root-");
      try {
        const run = runBunTestChild(relFile, scratchRoot, { disableBackstop: true });
        const leftover = scratchEntries(scratchRoot);
        expect({ exitCode: run.exitCode, leftover }).toEqual({ exitCode: 0, leftover: [] });
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true });
      }
    });

    test(`${relFile} leaves no new entry in its temp root after a failing run (backstop disabled)`, () => {
      const scratchRoot = freshScratchRoot("per-file-root-");
      try {
        const run = runBunTestChild(relFile, scratchRoot, { forceFail: true, disableBackstop: true });
        const leftover = scratchEntries(scratchRoot);
        expect({ exitNonZero: (run.exitCode ?? 0) !== 0, leftover }).toEqual({
          exitNonZero: true,
          leftover: [],
        });
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true });
      }
    });
  }
});

describe("run-scoped temp root — a spawned python scratch helper cleans up on its own, backstop disabled", () => {
  /** `tests/client/live_run_harness.py`'s `new_scratch()` — called from a
   *  throwaway python process so this check never depends on any CALLER's
   *  own cleanup (several existing python suites already wrap their own
   *  `new_scratch()` call in their own teardown; this isolates the helper's
   *  OWN behaviour from that). */
  function runPythonScratchChild(scratchRoot: string, opts: { forceFail?: boolean } = {}): ChildRun {
    const body = opts.forceFail
      ? [
          "import sys; sys.path.insert(0, '.')",
          "from tests.client.live_run_harness import new_scratch",
          "d = new_scratch('live-run-harness-probe-')",
          "print('CREATED:' + d)",
          "raise RuntimeError('induced failure')",
        ].join("\n")
      : [
          "import sys; sys.path.insert(0, '.')",
          "from tests.client.live_run_harness import new_scratch",
          "d = new_scratch('live-run-harness-probe-')",
          "print('CREATED:' + d)",
        ].join("\n");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TMPDIR: scratchRoot,
      [BACKSTOP_DISABLE_ENV]: "1",
    };
    const result = Bun.spawnSync({
      cmd: ["python3", "-c", body],
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test("new_scratch() leaves no new entry in its temp root after the process exits cleanly", () => {
    const scratchRoot = freshScratchRoot("py-scratch-root-");
    try {
      const run = runPythonScratchChild(scratchRoot);
      const created = /CREATED:(\S+)/.exec(run.stdout)?.[1];
      const leftover = scratchEntries(scratchRoot);
      expect({ exitCode: run.exitCode, createdSomething: Boolean(created), leftover }).toEqual({
        exitCode: 0,
        createdSomething: true,
        leftover: [],
      });
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  test("new_scratch() leaves no new entry in its temp root after the process exits on an uncaught error", () => {
    const scratchRoot = freshScratchRoot("py-scratch-root-");
    try {
      const run = runPythonScratchChild(scratchRoot, { forceFail: true });
      const created = /CREATED:(\S+)/.exec(run.stdout)?.[1];
      const leftover = scratchEntries(scratchRoot);
      expect({
        exitNonZero: (run.exitCode ?? 0) !== 0,
        createdSomething: Boolean(created),
        leftover,
      }).toEqual({ exitNonZero: true, createdSomething: true, leftover: [] });
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});

describe("run-scoped temp root — the per-run directory itself", () => {
  /** Writes a throwaway probe test module OUTSIDE this repo (so it is never
   *  collected by a normal `bun test`), runs it as a `bun test <abspath>`
   *  child cwd-rooted at this repo (so the preload still applies), and has
   *  it print both Bun's `os.tmpdir()` and a spawned python process's
   *  `tempfile.gettempdir()` — a grandchild of THIS test, inheriting
   *  whatever `TMPDIR` the preload leaves in the child's own environment. */
  function runProbe(scratchRoot: string, opts: { shouldFail: boolean }): {
    run: ChildRun;
    bunTmpdir: string | undefined;
    pyTmpdir: string | undefined;
  } {
    const probeDir = mkdtempSync(path.join(tmpdir(), "probe-src-"));
    try {
      const probeFile = path.join(probeDir, "probe.test.ts");
      const assertion = opts.shouldFail ? "expect(true).toBe(false);" : "expect(true).toBe(true);";
      writeFileSync(
        probeFile,
        [
          'import { test, expect } from "bun:test";',
          'import * as os from "node:os";',
          'test("probe", () => {',
          '  console.log("BUN_TMPDIR=" + os.tmpdir());',
          "  const py = Bun.spawnSync({",
          '    cmd: ["python3", "-c", "import tempfile; print(\\"PY_TMPDIR=\\" + tempfile.gettempdir())"],',
          "    env: process.env,",
          "  });",
          "  process.stdout.write(py.stdout);",
          `  ${assertion}`,
          "});",
          "",
        ].join("\n"),
      );
      const env: Record<string, string> = { ...(process.env as Record<string, string>), TMPDIR: scratchRoot };
      const result = Bun.spawnSync({
        cmd: ["bun", "test", probeFile],
        cwd: REPO_ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const run: ChildRun = {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
      const bunTmpdir = /BUN_TMPDIR=(\S+)/.exec(run.stdout)?.[1];
      const pyTmpdir = /PY_TMPDIR=(\S+)/.exec(run.stdout)?.[1];
      return { run, bunTmpdir, pyTmpdir };
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }

  test("on a passing run: Bun's and a spawned python process's temp directory agree, nest under the configured root, and are gone once the run exits", () => {
    const scratchRoot = freshScratchRoot("per-run-root-");
    try {
      const { run, bunTmpdir, pyTmpdir } = runProbe(scratchRoot, { shouldFail: false });
      expect(run.exitCode).toBe(0);
      expect(bunTmpdir).toBeDefined();
      expect(pyTmpdir).toBeDefined();
      // Same directory, for both languages' processes.
      expect(pyTmpdir).toBe(bunTmpdir);
      // Nested UNDER the configured root — never the root itself, and never
      // equal to it (a bare pass-through would fail this, not merely the
      // next check).
      expect(path.dirname(bunTmpdir!)).toBe(scratchRoot);
      expect(bunTmpdir).not.toBe(scratchRoot);
      // Gone once the run that owned it has exited.
      expect(existsSync(bunTmpdir!)).toBe(false);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  test("on a failing run: the per-run directory is still gone once the run exits", () => {
    const scratchRoot = freshScratchRoot("per-run-root-");
    try {
      const { run, bunTmpdir, pyTmpdir } = runProbe(scratchRoot, { shouldFail: true });
      expect(run.exitCode).not.toBe(0);
      expect(bunTmpdir).toBeDefined();
      expect(pyTmpdir).toBe(bunTmpdir);
      expect(path.dirname(bunTmpdir!)).toBe(scratchRoot);
      expect(bunTmpdir).not.toBe(scratchRoot);
      expect(existsSync(bunTmpdir!)).toBe(false);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
