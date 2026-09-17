// CR-CRU-137 §S1 (C1 RED) — the suite's default per-test budget is the suite's
// OWN figure, chosen here, not inherited from whatever bun ships.
//
// Spec: docs/changes/CR-CRU-137-pipeline-defaults-are-chosen-not-inherited.md
//   §S1 — the default per-test timeout becomes 30000 ms, carried by all THREE
//         invocation paths: `clients/bun-crucible.py`'s `_bun_test_cmd` (the
//         local gate), `.github/workflows/release.yml`'s `test-bun` step (CI,
//         which does not shell through the client), and
//         `scripts/run-test-target.ts` (the declared tier targets, which the
//         client's `unit`/`integration` verbs reach by running the project's
//         declared script by name). Because the three cannot be one physical
//         constant, the value is DERIVED, not retyped: the client declares it,
//         the tier runner reads that declaration at run time, and a test
//         asserts each site's figure equals the client's — so changing one
//         alone reddens the suite.
//
// Measured defect this closes: two tests failed CI on wall clock alone against
// bun's own 5000 ms default (6245 ms and 5148 ms, on trees whose suites were
// green). `bunfig.toml`'s `[test] timeout` is silently ignored by bun; the CLI
// flag is the only honoured channel, which is why both invocation paths must
// name it.
//
// RED-PHASE STATE on this branch (measured 2026-09-17), assertion by assertion:
//
//   * `_bun_test_cmd` (clients/bun-crucible.py:500) builds
//     `[bun, test, …targets, --reporter=junit, --reporter-outfile=…]` and the
//     module declares NO integer constant at all — so the two "client emits
//     --timeout 30000" tests and the "declared exactly once" test FAIL.
//   * release.yml's `Bun suite` step (:146) runs bare `bun test` — the
//     workflow test FAILS.
//   * The derived-equality test FAILS from both ends at once, which is the
//     point of it: it never retypes 30000.
//
// The last two tests are REGRESSION RAILS, green the day they are written and
// deliberately not contorted into failing: bun's per-test annotation override
// (§S1's load-bearing measured premise — raising the default must not clobber
// an explicit per-test budget) and cr009's `NPM_PACK_TIMEOUT_MS = 60_000`,
// which §S1 requires to survive this CR untouched.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const CLIENT_REL = join("clients", "bun-crucible.py");
const RELEASE_WORKFLOW_REL = join(".github", "workflows", "release.yml");
const CR009_TEST_REL = join("tests", "cr009-release-bundle.test.ts");

// The figure §S1 chooses, spelled here ONCE so the two "it is 30000" contract
// tests can name it. The equality test below deliberately does NOT use it — it
// reads both files and compares them to each other.
const REQUIRED_DEFAULT_TIMEOUT_MS = 30000;

// ── release.yml as data (same shape as tests/cr009-release-bundle.test.ts's
//    and tests/ci-toolchain-provisioning.test.ts's readReleaseWorkflow()) ────

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
};

type WorkflowJob = {
  "runs-on"?: string;
  steps?: WorkflowStep[];
};

type ReleaseWorkflow = {
  jobs?: Record<string, WorkflowJob>;
};

function readReleaseWorkflow(): { raw: string; parsed: ReleaseWorkflow } {
  const raw = readFileSync(join(REPO_ROOT, RELEASE_WORKFLOW_REL), "utf8");
  const parsed = Bun.YAML.parse(raw) as ReleaseWorkflow;
  return { raw, parsed };
}

function stepsOf(parsed: ReleaseWorkflow, jobName: string): WorkflowStep[] {
  const job = parsed.jobs?.[jobName];
  expect(job, `release.yml declares no '${jobName}' job`).toBeDefined();
  const steps = job?.steps;
  expect(Array.isArray(steps), `job '${jobName}' declares no steps: array`).toBe(true);
  return steps as WorkflowStep[];
}

/** Every `run:` body in `test-bun` that invokes the bun test runner — the
 *  whole set, so a SECOND `bun test` step added without the flag is caught
 *  rather than hidden behind the first one. `bunx playwright install` and
 *  `bun install` are not test invocations and do not match. */
function bunTestInvocations(parsed: ReleaseWorkflow): Array<{ label: string; run: string }> {
  return stepsOf(parsed, "test-bun")
    .filter(
      (step) => typeof step.run === "string" && /(?:^|\s|&&|\|\|)bun\s+test(?:\s|$)/.test(step.run),
    )
    .map((step) => ({ label: step.name ?? "(unnamed step)", run: step.run as string }));
}

/** The value(s) a `--timeout` flag carries in a token list, accepting either
 *  spelling bun honours (`--timeout 30000` / `--timeout=30000`). A list rather
 *  than a single value so "declared exactly once" is assertable. */
function timeoutFlagValues(tokens: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "--timeout") {
      values.push(tokens[i + 1] ?? "");
      i += 1;
    } else if (token.startsWith("--timeout=")) {
      values.push(token.slice("--timeout=".length));
    }
  }
  return values;
}

// ── the client's command builder, DRIVEN (not read as text) ────────────────
//
// `_bun_test_cmd` is the contract under test, so the probe CALLS it — once for
// a targeted file list and once for the whole suite (`targets=None`), the two
// shapes §S1 names — and hands back both commands plus the module's integer
// constants, so "declared as a single named constant" is judged against the
// module namespace rather than against source text. Loaded by file path via
// importlib because the filename is hyphenated — the same technique
// tests/client/test_bun_crucible_gates.py uses.

const PROBE_TARGET_FILE = "tests/example-target.test.ts";
const PROBE_JUNIT_PATH = "/tmp/cr137-probe-junit.xml";

const CLIENT_PROBE = `
import importlib.util, json, sys

spec = importlib.util.spec_from_file_location("bun_crucible_timeout_probe", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

targeted = module._bun_test_cmd("bun", [${JSON.stringify(PROBE_TARGET_FILE)}], ${JSON.stringify(PROBE_JUNIT_PATH)}, False, None)
suite = module._bun_test_cmd("bun", None, ${JSON.stringify(PROBE_JUNIT_PATH)}, False, None)
constants = {
    name: value
    for name, value in vars(module).items()
    if name.isupper() and isinstance(value, int) and not isinstance(value, bool)
}
print(json.dumps({"targeted": targeted, "suite": suite, "constants": constants}))
`;

interface ClientProbe {
  targeted: string[];
  suite: string[];
  constants: Record<string, number>;
}

let cachedProbe: ClientProbe | undefined;

function probeClient(): ClientProbe {
  if (cachedProbe !== undefined) return cachedProbe;
  const child = Bun.spawnSync({
    cmd: ["python3", "-c", CLIENT_PROBE, join(REPO_ROOT, CLIENT_REL)],
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.toString();
  const stderr = child.stderr.toString();
  expect(
    child.exitCode,
    `driving ${CLIENT_REL}'s _bun_test_cmd failed (exit ${String(child.exitCode)}):\n${stderr}`,
  ).toBe(0);
  cachedProbe = JSON.parse(stdout) as ClientProbe;
  return cachedProbe;
}

/** The default per-test budget the CLIENT declares, read off the command it
 *  actually builds — the figure CI must match. Never a literal in this file. */
function clientDeclaredTimeoutMs(): number {
  const suite = probeClient().suite;
  const values = timeoutFlagValues(suite);
  expect(
    values.length,
    `${CLIENT_REL}'s _bun_test_cmd built a whole-suite command carrying ${String(values.length)} ` +
      `--timeout flags; §S1 requires exactly one: ${suite.join(" ")}`,
  ).toBe(1);
  const timeoutMs = Number(values[0]);
  expect(
    Number.isInteger(timeoutMs),
    `${CLIENT_REL} emits --timeout ${String(values[0])}, which is not an integer ms figure`,
  ).toBe(true);
  return timeoutMs;
}

/** The default per-test budget the WORKFLOW declares, read off the `test-bun`
 *  step's shell command. */
function workflowDeclaredTimeoutMs(): number {
  const { parsed } = readReleaseWorkflow();
  const invocations = bunTestInvocations(parsed);
  expect(invocations.length, "release.yml's test-bun job runs no `bun test` step").toBe(1);
  const invocation = invocations[0] as { label: string; run: string };
  const values = timeoutFlagValues(invocation.run.trim().split(/\s+/));
  expect(
    values.length,
    `release.yml's '${invocation.label}' step carries ${String(values.length)} --timeout flags; ` +
      `§S1 requires exactly one: ${invocation.run.trim()}`,
  ).toBe(1);
  const timeoutMs = Number(values[0]);
  expect(
    Number.isInteger(timeoutMs),
    `release.yml declares --timeout ${String(values[0])}, which is not an integer ms figure`,
  ).toBe(true);
  return timeoutMs;
}

describe("§S1 the local gate's own invocations carry the project's default per-test budget", () => {
  test("_bun_test_cmd emits --timeout 30000 in a TARGETED invocation, alongside the targets and the report flags", () => {
    const { targeted } = probeClient();

    // POSITIVE — the specific figure, exactly once.
    expect(timeoutFlagValues(targeted)).toEqual([String(REQUIRED_DEFAULT_TIMEOUT_MS)]);

    // NEGATIVE/bound — the budget is an ADDITION to the command, not a
    // replacement: the targets and CR-CRU-133 §S2's report contract must
    // survive it, or the gate would stop reporting while looking green here.
    expect(targeted.slice(0, 2)).toEqual(["bun", "test"]);
    expect(targeted).toContain(PROBE_TARGET_FILE);
    expect(targeted).toContain("--reporter=junit");
    expect(targeted).toContain(`--reporter-outfile=${PROBE_JUNIT_PATH}`);
  });

  test("_bun_test_cmd emits --timeout 30000 in a WHOLE-SUITE invocation too, with no stray path argument", () => {
    const { suite } = probeClient();

    expect(timeoutFlagValues(suite)).toEqual([String(REQUIRED_DEFAULT_TIMEOUT_MS)]);

    expect(suite.slice(0, 2)).toEqual(["bun", "test"]);
    expect(suite).toContain("--reporter=junit");
    // NEGATIVE — a whole-suite run collects everything: no target may leak in
    // (a filter argument here would silently narrow the regression gate).
    expect(suite).not.toContain(PROBE_TARGET_FILE);
  });

  test("the budget is declared ONCE, as a single named integer constant holding 30000", () => {
    const { constants } = probeClient();
    const budgetConstants = Object.entries(constants).filter(([name]) => /TIMEOUT|BUDGET/.test(name));

    // POSITIVE — exactly one named declaration, holding the chosen figure.
    expect(
      budgetConstants.map(([name]) => name),
      `${CLIENT_REL} must declare the default per-test budget as ONE named constant; ` +
        `found ${JSON.stringify(budgetConstants)}`,
    ).toHaveLength(1);
    expect((budgetConstants[0] as [string, number])[1]).toBe(REQUIRED_DEFAULT_TIMEOUT_MS);

    // …and the command builder SELECTS that constant rather than retyping the
    // number: change the constant alone and the emitted flag must move with it.
    expect(clientDeclaredTimeoutMs()).toBe((budgetConstants[0] as [string, number])[1]);
  });
});

describe("§S1 CI runs the suite on the same budget, and the two figures cannot drift apart", () => {
  test("release.yml's test-bun `Bun suite` step runs `bun test --timeout 30000`", () => {
    const { parsed } = readReleaseWorkflow();
    const invocations = bunTestInvocations(parsed);

    // POSITIVE — the job runs the suite, and that one invocation carries the
    // figure. Bound at exactly one: a second, unflagged `bun test` step added
    // later fails here instead of quietly running on bun's default.
    expect(invocations.map((i) => i.label)).toEqual(["Bun suite"]);
    expect(timeoutFlagValues((invocations[0] as { run: string }).run.trim().split(/\s+/))).toEqual([
      String(REQUIRED_DEFAULT_TIMEOUT_MS),
    ]);
  });

  test("the workflow's --timeout EQUALS the figure the client declares — derived from both files, retyped from neither", () => {
    // Neither side of this comparison is a literal: one is driven out of
    // _bun_test_cmd, the other parsed out of release.yml. Changing either file
    // alone reddens this test, which is the whole mechanism §S1 asks for (the
    // two paths cannot share one physical constant — CI does not shell through
    // the client).
    const fromClient = clientDeclaredTimeoutMs();
    const fromWorkflow = workflowDeclaredTimeoutMs();

    expect(
      fromWorkflow,
      `release.yml runs the suite at ${String(fromWorkflow)} ms/test while ${CLIENT_REL} declares ` +
        `${String(fromClient)} ms/test — the local gate and CI would disagree about what a timeout means`,
    ).toBe(fromClient);
  });
});

// ── the THIRD invocation path: the project's declared tier targets ─────────
//
// `bun-crucible.py`'s `unit`/`integration` verbs build no `bun test` command of
// their own: §S6 ruling 2 has them run the project's DECLARED script BY NAME
// (`bun run test:<tier>`), and that script — `scripts/run-test-target.ts` —
// spawns its own `bun test`. So a THIRD site carries the figure; it is also the
// one a developer reaches by typing `bun run test:unit`.
//
// It is DRIVEN, not read as text: the script is executed with a stub `bun` (and
// a stub `python3`, so the regression target cannot launch the real client
// suite) at the head of PATH, and the assertion reads the argv really spawned.

const STUB_ARG_INDENT = "  ";

/** Runs `scripts/run-test-target.ts <target>` against stub executables and
 *  returns the argv of every `bun` it spawned, argv[0] dropped. */
function bunArgvSpawnedBy(target: string): string[][] {
  const dir = mkdtempSync(join(tmpdir(), "cr137-tier-target-"));
  try {
    const log = join(dir, "argv.log");
    for (const name of ["bun", "python3"]) {
      writeFileSync(
        join(dir, name),
        `#!/bin/sh\n{ echo "${name}"; for arg in "$@"; do echo "${STUB_ARG_INDENT}$arg"; done; } >> "${log}"\nexit 0\n`,
        { mode: 0o755 },
      );
    }
    const child = Bun.spawnSync({
      cmd: [process.execPath, join(REPO_ROOT, "scripts", "run-test-target.ts"), target],
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(
      child.exitCode,
      `run-test-target.ts ${target} exited ${String(child.exitCode)} under stub executables:\n` +
        child.stderr.toString(),
    ).toBe(0);

    const commands: string[][] = [];
    for (const line of existsSync(log) ? readFileSync(log, "utf8").split("\n") : []) {
      if (line === "") continue;
      if (line.startsWith(STUB_ARG_INDENT)) {
        (commands[commands.length - 1] as string[]).push(line.slice(STUB_ARG_INDENT.length));
      } else {
        commands.push([line]);
      }
    }
    return commands.filter((argv) => argv[0] === "bun").map((argv) => argv.slice(1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cachedTargetCommands = new Map<string, string[]>();

/** The single `bun test` command a declared tier target spawns. */
function bunTestCommandOf(target: string): string[] {
  const cached = cachedTargetCommands.get(target);
  if (cached !== undefined) return cached;
  const spawned = bunArgvSpawnedBy(target);
  const testCommands = spawned.filter((argv) => argv[0] === "test");
  expect(
    testCommands.length,
    `bun run test:${target} spawned ${String(testCommands.length)} \`bun test\` commands; ` +
      `§S1 expects exactly one: ${JSON.stringify(spawned)}`,
  ).toBe(1);
  const argv = testCommands[0] as string[];
  cachedTargetCommands.set(target, argv);
  return argv;
}

/** The default per-test budget a declared tier target declares, read off the
 *  command it actually spawns. Never a literal in this file. */
function targetDeclaredTimeoutMs(target: string): number {
  const argv = bunTestCommandOf(target);
  const values = timeoutFlagValues(argv);
  expect(
    values.length,
    `bun run test:${target}'s own \`bun test\` carries ${String(values.length)} --timeout flags; ` +
      `§S1 requires exactly one: bun ${argv.join(" ")}`,
  ).toBe(1);
  const timeoutMs = Number(values[0]);
  expect(
    Number.isInteger(timeoutMs),
    `bun run test:${target} declares --timeout ${String(values[0])}, which is not an integer ms figure`,
  ).toBe(true);
  return timeoutMs;
}

describe("§S1 the declared tier targets run on the same budget as the gate", () => {
  test("`test:unit`'s own `bun test` runs on the figure the client declares — derived from both, retyped in neither", () => {
    const fromTarget = targetDeclaredTimeoutMs("unit");
    const fromClient = clientDeclaredTimeoutMs();

    expect(
      fromTarget,
      `scripts/run-test-target.ts runs the unit target at ${String(fromTarget)} ms/test while ` +
        `${CLIENT_REL} declares ${String(fromClient)} ms/test — the client's \`unit\` verb REACHES ` +
        `this path (\`bun run test:unit\`), so a tier run would silently use a different budget`,
    ).toBe(fromClient);

    // NEGATIVE/bound — the budget is an ADDITION: the target still names the
    // files it selected, or it would be green here while running nothing.
    expect(
      bunTestCommandOf("unit").some((arg) => arg.endsWith(".test.ts")),
      "the unit target spawned `bun test` with no test file arguments",
    ).toBe(true);
  });

  test("`test:regression`'s whole-suite `bun test` carries it too, with no path argument", () => {
    const fromTarget = targetDeclaredTimeoutMs("regression");
    const fromClient = clientDeclaredTimeoutMs();

    expect(
      fromTarget,
      `scripts/run-test-target.ts runs the regression target at ${String(fromTarget)} ms/test while ` +
        `${CLIENT_REL} declares ${String(fromClient)} ms/test`,
    ).toBe(fromClient);

    // NEGATIVE — regression collects the WHOLE suite in one invocation: a path
    // argument here would silently narrow it.
    expect(bunTestCommandOf("regression").filter((arg) => arg.endsWith(".test.ts"))).toEqual([]);
  });
});

// ── the measured premise: a per-test annotation still wins ─────────────────

// The child's CLI default, set BELOW the annotation on purpose: the annotated
// test is only proof of an override if the default it overrides would have
// killed it.
const CHILD_CLI_DEFAULT_MS = 1000;
const FIXTURE_ANNOTATION_MS = 8000;
// Longer than the CLI default, comfortably shorter than the annotation.
const FIXTURE_SLEEP_MS = 2500;
const CHILD_HARD_CAP_MS = 60_000;
// This test's own budget: a real child `bun test` (~4 s of deliberate sleeping
// plus bun's startup), held well clear so the guard never dies on its own clock.
const OVERRIDE_GUARD_TIMEOUT_MS = 120_000;

interface JunitCase {
  name: string;
  timeSeconds: number;
  failed: boolean;
}

function parseJunitCases(xml: string): JunitCase[] {
  const cases: JunitCase[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = match[1] ?? "";
    const body = match[3] ?? "";
    const name = /name="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const time = /time="([^"]*)"/.exec(attrs)?.[1] ?? "";
    cases.push({ name, timeSeconds: Number(time), failed: /<(?:failure|error)\b/.test(body) });
  }
  return cases;
}

describe("§S1 raising the DEFAULT does not clobber a test's own declared budget", () => {
  test(
    "a test annotated above the CLI default passes on its own budget while an unannotated sibling is cut short by that default",
    () => {
      // The fixture sits outside the checkout so no discovery but this child's
      // ever collects it — it contains a deliberately failing test, and a
      // stray copy inside tests/ would poison the real suite. The child's cwd
      // is still the repo, so bunfig.toml (and its store preload) applies
      // exactly as it does to a normal run.
      const fixtureDir = mkdtempSync(join(tmpdir(), "cr137-timeout-override-"));
      const fixtureFile = join(fixtureDir, "annotation-override.test.ts");
      const reportPath = join(fixtureDir, "annotation-override.junit.xml");
      const annotatedName = "annotated above the CLI default";
      const inheritedName = "inherits the CLI default";
      writeFileSync(
        fixtureFile,
        `import { expect, test } from "bun:test";\n` +
          `test(${JSON.stringify(annotatedName)}, async () => {\n` +
          `  await Bun.sleep(${String(FIXTURE_SLEEP_MS)});\n` +
          `  expect(1 + 1).toBe(2);\n` +
          `}, ${String(FIXTURE_ANNOTATION_MS)});\n` +
          `test(${JSON.stringify(inheritedName)}, async () => {\n` +
          `  await Bun.sleep(${String(FIXTURE_SLEEP_MS)});\n` +
          `  expect(1 + 1).toBe(2);\n` +
          `});\n`,
      );

      const child = Bun.spawnSync({
        cmd: [
          "bun",
          "test",
          "--timeout",
          String(CHILD_CLI_DEFAULT_MS),
          "--reporter=junit",
          "--reporter-outfile",
          reportPath,
          fixtureFile,
        ],
        cwd: REPO_ROOT,
        env: { ...process.env },
        timeout: CHILD_HARD_CAP_MS,
        stdout: "pipe",
        stderr: "pipe",
      });
      const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
      const stderr = child.stderr.toString();
      rmSync(fixtureDir, { recursive: true, force: true });

      // The child must have RUN both tests — an empty report would make every
      // assertion below vacuous.
      const cases = parseJunitCases(report);
      expect(
        cases.map((c) => c.name).sort(),
        `child bun test wrote no usable report (exit ${String(child.exitCode)}):\n${stderr}`,
      ).toEqual([annotatedName, inheritedName].sort());

      const annotated = cases.find((c) => c.name === annotatedName) as JunitCase;
      const inherited = cases.find((c) => c.name === inheritedName) as JunitCase;

      // POSITIVE — the annotation wins: the 8000 ms test passes under a
      // 1000 ms CLI default, and its recorded time proves it really slept the
      // full 2500 ms rather than being skipped or short-circuited.
      expect(annotated.failed).toBe(false);
      expect(annotated.timeSeconds).toBeGreaterThanOrEqual(FIXTURE_SLEEP_MS / 1000 - 0.1);
      expect(annotated.timeSeconds).toBeLessThan(FIXTURE_ANNOTATION_MS / 1000);

      // NEGATIVE CONTROL — the CLI default was genuinely in force: the
      // identical, unannotated sibling died on it. Without this, the pass
      // above would prove nothing (a runner ignoring --timeout entirely would
      // look the same).
      expect(inherited.failed).toBe(true);
      expect(inherited.timeSeconds).toBeLessThan(FIXTURE_SLEEP_MS / 1000);
    },
    OVERRIDE_GUARD_TIMEOUT_MS,
  );
});

// ── cr009's npm pack tests, DERIVED from that file rather than counted ─────
//
// The set of tests carrying the 60 s budget is whatever cr009 currently spends
// on `npm pack`. CR-CRU-137 §S3 legitimately added a THIRD one (the LICENSE
// tarball test), so a literal count was never the contract — re-pinning it
// would only defer the same breakage to the next CR that packs. What must not
// change is the invariant: ONE declaration, above the suite default, and every
// test that really spawns npm pack still receives it.

/** A `test(...)` call sliced out of a source file: its name, its body, and the
 *  identifier passed as bun's optional per-test timeout argument (undefined
 *  when the test declares no budget of its own). */
interface SlicedTest {
  name: string;
  body: string;
  timeoutArg: string | undefined;
}

const TEST_DECL = /^(\s*)test\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`)/;

/** Slices every `test(...)` block out of `source`. The closing line is matched
 *  at the declaration's OWN indentation, so a test nested inside a loop is cut
 *  as accurately as a top-level one, and the trailer is read across lines
 *  because bun's timeout argument is often formatted onto its own line. */
function sliceTests(source: string): SlicedTest[] {
  const lines = source.split("\n");
  const sliced: SlicedTest[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const decl = TEST_DECL.exec(lines[i] as string);
    if (decl === null) continue;
    const indent = decl[1] as string;

    const closer = new RegExp(`^${indent}\\}`);
    let end = i + 1;
    while (end < lines.length && !closer.test(lines[end] as string)) end += 1;
    if (end >= lines.length) continue;

    // The call closes either on the `}` line (`}, NPM_PACK_TIMEOUT_MS);`) or a
    // few lines below it (`},` / `SOME_TIMEOUT_MS,` / `);`).
    let callEnd = end;
    while (callEnd < lines.length && !/\)\s*;?\s*$/.test(lines[callEnd] as string)) callEnd += 1;
    const trailer = lines.slice(end, Math.min(callEnd, lines.length - 1) + 1).join("\n");

    sliced.push({
      name: (decl[2] ?? decl[3] ?? decl[4]) as string,
      body: lines.slice(i, end + 1).join("\n"),
      timeoutArg: /\}\s*,\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/.exec(trailer)?.[1],
    });
    i = end;
  }

  return sliced;
}

describe("§S1 the suite's existing explicit budgets survive the new default", () => {
  test("cr009-release-bundle still declares NPM_PACK_TIMEOUT_MS = 60_000 exactly once, and every npm pack test it runs still carries it", () => {
    const source = readFileSync(join(REPO_ROOT, CR009_TEST_REL), "utf8");

    const declarations = [...source.matchAll(/const NPM_PACK_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/g)];
    expect(
      declarations,
      `${CR009_TEST_REL} must declare NPM_PACK_TIMEOUT_MS exactly once`,
    ).toHaveLength(1);
    const declaredMs = Number(
      ((declarations[0] as RegExpMatchArray)[1] as string).replace(/_/g, ""),
    );

    // THE POINT OF THE RAIL — the budget remains ABOVE the project default §S1
    // chooses, which is why §S1 leaves it alone: npm pack's cold start is a
    // per-test fact, not the suite's floor. Compared against the REQUIRED
    // figure rather than against whatever the client currently emits, so this
    // rail stays a statement about cr009's budget and does not go red merely
    // because §S1 has not landed yet.
    expect(
      declaredMs,
      `${CR009_TEST_REL}'s npm pack budget must stay above the suite default`,
    ).toBeGreaterThan(REQUIRED_DEFAULT_TIMEOUT_MS);
    // …and it is still the measured 60 s figure cr009 chose.
    expect(declaredMs).toBe(60_000);

    // EVERY npm pack test still CARRIES it — a declaration nothing passes is a
    // budget that is not in force. The set is read off cr009's own source: the
    // tests whose body calls its `npmPackDryRun*` helper, i.e. the ones that
    // really spawn npm. (cr009's §S5 workflow test shells out a runner script
    // that merely CONTAINS `npm pack`; it is deliberately not in this set,
    // which is why the helper — not the string "npm pack" — defines it.)
    const packTests = sliceTests(source).filter((t) => /\bnpmPackDryRun[A-Za-z]*\(/.test(t.body));
    expect(
      packTests.length,
      `${CR009_TEST_REL} must still run at least one npm pack test, else this rail is vacuous`,
    ).toBeGreaterThan(0);

    expect(
      packTests
        .filter((t) => t.timeoutArg !== "NPM_PACK_TIMEOUT_MS")
        .map((t) => `${t.name} [budget: ${t.timeoutArg ?? "none"}]`),
      `${CR009_TEST_REL}: every test that spawns npm pack must carry NPM_PACK_TIMEOUT_MS`,
    ).toEqual([]);

    // Cross-check the derivation against the raw text, so a slicer that quietly
    // stopped recognising tests cannot make the check above pass by finding
    // nothing: the budget is handed out exactly as many times as there are npm
    // pack tests — no more (it is on a test that does not pack) and no fewer.
    const rawUses = [...source.matchAll(/\}\s*,\s*NPM_PACK_TIMEOUT_MS\s*,?\s*\)/g)];
    expect(
      rawUses.length,
      `${CR009_TEST_REL} passes NPM_PACK_TIMEOUT_MS ${rawUses.length}× but runs ${packTests.length} npm pack test(s)`,
    ).toBe(packTests.length);
  });
});
