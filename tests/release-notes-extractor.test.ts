// The release-notes extractor, `scripts/release-notes.sh X.Y.Z [FILE]`, and
// the release workflow's `create-release` step reading its notes through it.
//
// The extractor prints one version's CHANGELOG.md section by the rule the
// workflow has always used: from the first line that begins `## [X.Y.Z]`
// (exclusive) up to the next line that begins `## [`, skipping link-reference
// lines (`^\[[^]]+\]: `), with carriage returns ignored. Exit 0 when what it
// printed holds a non-whitespace character, 1 when it does not (no heading,
// empty / whitespace-only / link-references-only section, no such file), 2 on
// a usage error (no version, or arguments beyond `X.Y.Z [FILE]`). FILE `-` is
// standard input; no FILE is `CHANGELOG.md` in the current directory.
//
// The workflow half EXECUTES the real `run:` body of the step that creates the
// GitHub Release (the same approach tests/cr009-release-bundle.test.ts takes
// with the publish-npm body): under `bash -e`, in a scratch git repo whose
// HEAD carries the version tag, holding a copy of the repo's extractor and a
// fixture CHANGELOG.md, with a stub `gh` first on PATH that records every call
// and copies the `--notes-file` it is handed. Only PATH and HOME are passed to
// the body; no test prints an environment value.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const EXTRACTOR_REL = join("scripts", "release-notes.sh");
const EXTRACTOR = join(REPO_ROOT, EXTRACTOR_REL);
const RELEASE_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "release.yml");

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** The minimal environment a child needs: PATH and HOME, nothing else. */
function minimalEnv(extraPathDir?: string): Record<string, string> {
  const basePath = process.env.PATH ?? "/usr/bin:/bin";
  const env: Record<string, string> = {
    PATH: extraPathDir ? `${extraPathDir}:${basePath}` : basePath,
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

// ---------------------------------------------------------------------------
// Fixture changelogs
// ---------------------------------------------------------------------------

const KEEP_A_CHANGELOG = [
  "# Changelog",
  "",
  "All notable changes to this project are documented in this file.",
  "",
  "## [Unreleased]",
  "",
  "## [1.2.0] - 2026-03-01",
  "",
  "### Added",
  "- The second thing.",
  "",
  "## [1.1.0] - 2026-02-01",
  "",
  "### Fixed",
  "- A bug in [the parser] that dropped rows.",
  "  A continuation line.",
  "[1.1.0-note]: https://example.invalid/an-inline-link-reference",
  "### [Sub-heading] stays, it is not a release heading",
  "[not a reference] because no colon-space follows the bracket",
  "",
  "## [1.0.0] - 2026-01-01",
  "",
  "- First release.",
  "",
  "[1.2.0]: https://example.invalid/compare/1.1.0...1.2.0",
  "[1.1.0]: https://example.invalid/compare/1.0.0...1.1.0",
  "[1.0.0]: https://example.invalid/releases/1.0.0",
  "",
].join("\n");

/** 1.2.0 — a section followed by another release's heading. */
const BODY_1_2_0 = "\n### Added\n- The second thing.\n\n";

/** 1.1.0 — a body with an inline link reference skipped and look-alikes kept. */
const BODY_1_1_0 = [
  "",
  "### Fixed",
  "- A bug in [the parser] that dropped rows.",
  "  A continuation line.",
  "### [Sub-heading] stays, it is not a release heading",
  "[not a reference] because no colon-space follows the bracket",
  "",
  "",
].join("\n");

/** 1.0.0 — the last section, running into the link references. */
const BODY_1_0_0 = "\n- First release.\n\n";

function crlf(text: string): string {
  return text.replace(/\n/g, "\r\n");
}

// ---------------------------------------------------------------------------
// Running the extractor
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runExtractor(
  args: string[],
  opts: { cwd?: string; stdin?: string } = {},
): RunResult {
  if (!existsSync(EXTRACTOR)) {
    throw new Error("scripts/release-notes.sh does not exist in the repository");
  }
  const res = Bun.spawnSync({
    cmd: [EXTRACTOR, ...args],
    cwd: opts.cwd ?? scratchDir("release-notes-cwd-"),
    env: minimalEnv(),
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
    exitCode: res.exitCode,
  };
}

/** Writes `content` as a changelog file in a fresh scratch dir; returns its path. */
function fixtureChangelog(content: string, name = "CHANGELOG.md"): string {
  const dir = scratchDir("release-notes-fixture-");
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

function expectNoNotes(res: RunResult): void {
  expect(res.exitCode).toBe(1);
  expect(res.stdout).not.toMatch(/\S/);
}

describe("release-notes extractor prints one version's changelog section", () => {
  test("prints exactly the body of a section followed by another release, and exits 0", () => {
    const res = runExtractor(["1.2.0", fixtureChangelog(KEEP_A_CHANGELOG)]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(BODY_1_2_0);
    expect(res.stdout).not.toContain("## [1.2.0]");
    expect(res.stdout).not.toContain("## [1.1.0]");
    expect(res.stdout).not.toContain("### Fixed");
  });

  test("skips link-reference lines inside a section but keeps bracketed look-alikes and sub-headings", () => {
    const res = runExtractor(["1.1.0", fixtureChangelog(KEEP_A_CHANGELOG)]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(BODY_1_1_0);
    expect(res.stdout).not.toContain("[1.1.0-note]: ");
    expect(res.stdout).not.toContain("First release");
  });

  test("prints the last section up to the link references without printing them, and exits 0", () => {
    const res = runExtractor(["1.0.0", fixtureChangelog(KEEP_A_CHANGELOG)]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(BODY_1_0_0);
    expect(res.stdout).not.toContain("https://example.invalid");
  });

  test("reads a CRLF changelog as LF: the same body, with no carriage return in the output", () => {
    const res = runExtractor(["1.1.0", fixtureChangelog(crlf(KEEP_A_CHANGELOG))]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(BODY_1_1_0);
    expect(res.stdout).not.toContain("\r");
  });

  test("reads a CRLF changelog's last section without its link references or carriage returns", () => {
    const res = runExtractor(["1.0.0", fixtureChangelog(crlf(KEEP_A_CHANGELOG))]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(BODY_1_0_0);
    expect(res.stdout).not.toContain("\r");
  });

  test("reads standard input when FILE is '-', not the CHANGELOG.md in the current directory", () => {
    const cwd = scratchDir("release-notes-stdin-cwd-");
    writeFileSync(
      join(cwd, "CHANGELOG.md"),
      "## [1.2.0] - 2026-03-01\n\n- A decoy body from the cwd file.\n",
    );
    const res = runExtractor(["1.2.0", "-"], { cwd, stdin: KEEP_A_CHANGELOG });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(BODY_1_2_0);
    expect(res.stdout).not.toContain("decoy");
  });

  test("reads CHANGELOG.md in the current directory when no FILE is given", () => {
    const cwd = scratchDir("release-notes-default-cwd-");
    writeFileSync(join(cwd, "CHANGELOG.md"), KEEP_A_CHANGELOG);
    const res = runExtractor(["1.1.0"], { cwd });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(BODY_1_1_0);
  });

  test("with no FILE and no CHANGELOG.md in the current directory, prints nothing and exits 1", () => {
    const cwd = scratchDir("release-notes-empty-cwd-");
    expectNoNotes(runExtractor(["1.1.0"], { cwd }));
  });
});

describe("release-notes extractor finds no notes", () => {
  test("no heading for the version: prints nothing and exits 1", () => {
    expectNoNotes(runExtractor(["3.0.0", fixtureChangelog(KEEP_A_CHANGELOG)]));
  });

  test("an empty section: prints nothing and exits 1", () => {
    const file = fixtureChangelog(
      "# Changelog\n\n## [2.0.0] - 2026-04-01\n## [1.0.0] - 2026-01-01\n\n- First release.\n",
    );
    expectNoNotes(runExtractor(["2.0.0", file]));
  });

  test("a whitespace-only section: prints no non-whitespace character and exits 1", () => {
    const file = fixtureChangelog(
      "# Changelog\n\n## [2.0.0] - 2026-04-01\n\n   \n\t\n\n## [1.0.0] - 2026-01-01\n\n- First release.\n",
    );
    expectNoNotes(runExtractor(["2.0.0", file]));
  });

  test("a CRLF whitespace-only section: prints no non-whitespace character and exits 1", () => {
    const file = fixtureChangelog(
      crlf("# Changelog\n\n## [2.0.0] - 2026-04-01\n\n  \n\n## [1.0.0] - 2026-01-01\n\n- First release.\n"),
    );
    expectNoNotes(runExtractor(["2.0.0", file]));
  });

  test("a section holding only link references: prints nothing and exits 1", () => {
    const file = fixtureChangelog(
      [
        "# Changelog",
        "",
        "## [2.0.0] - 2026-04-01",
        "[2.0.0]: https://example.invalid/compare/1.0.0...2.0.0",
        "[1.0.0]: https://example.invalid/releases/1.0.0",
        "",
      ].join("\n"),
    );
    expectNoNotes(runExtractor(["2.0.0", file]));
  });

  test("a FILE that does not exist: prints nothing and exits 1", () => {
    const dir = scratchDir("release-notes-missing-");
    expectNoNotes(runExtractor(["1.0.0", join(dir, "NO-SUCH-CHANGELOG.md")]));
  });

  test("a 9.9.90 heading is not the 9.9.9 section: prints nothing and exits 1", () => {
    const file = fixtureChangelog(
      "# Changelog\n\n## [9.9.90] - 2026-05-01\n\n- Notes for nine-nine-ninety.\n",
    );
    const res = runExtractor(["9.9.9", file]);
    expectNoNotes(res);
    expect(res.stdout).not.toContain("nine-nine-ninety");
  });
});

describe("release-notes extractor usage errors", () => {
  test("no version argument: exits 2 with a usage message", () => {
    const res = runExtractor([]);
    expect(res.exitCode).toBe(2);
    expect(`${res.stdout}${res.stderr}`).toMatch(/\S/);
  });

  test("arguments beyond 'X.Y.Z [FILE]': exits 2 and extracts nothing", () => {
    const file = fixtureChangelog(KEEP_A_CHANGELOG);
    const res = runExtractor(["1.1.0", file, "extra"]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).not.toContain("### Fixed");
    expect(`${res.stdout}${res.stderr}`).toMatch(/\S/);
  });
});

describe("release-notes extractor is committed executable", () => {
  test("scripts/release-notes.sh is in the index with mode 100755", () => {
    const res = Bun.spawnSync({
      cmd: ["git", "ls-files", "-s", "--", EXTRACTOR_REL],
      cwd: REPO_ROOT,
      env: minimalEnv(),
    });
    expect(res.exitCode).toBe(0);
    const entry = res.stdout.toString().trim();
    expect(entry.split(/\s+/)[0]).toBe("100755");
    expect(entry.endsWith(`\t${EXTRACTOR_REL}`) || entry.endsWith(` ${EXTRACTOR_REL}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The workflow's create-release step reads its notes through the extractor
// ---------------------------------------------------------------------------

type WorkflowStep = { name?: string; run?: string; env?: Record<string, string> };
type WorkflowJob = { steps?: WorkflowStep[] };
type Workflow = { jobs?: Record<string, WorkflowJob> };

/** The `run:` body of create-release's step that creates the GitHub Release. */
function createReleaseRunBody(): string {
  const parsed = Bun.YAML.parse(readFileSync(RELEASE_WORKFLOW, "utf8")) as Workflow;
  const steps = parsed.jobs?.["create-release"]?.steps ?? [];
  const bodies = steps.flatMap((s) =>
    typeof s.run === "string" && s.run.includes("gh release create") ? [s.run] : [],
  );
  expect(bodies.length).toBe(1);
  return bodies[0] as string;
}

/** The body's shell lines with comment-only lines removed. */
function codeLines(body: string): string[] {
  return body.split("\n").filter((line) => !/^\s*#/.test(line));
}

const STEP_TAG = "9.9.9";
const FIELD_SEP = "\x1f";

interface StepRun {
  exitCode: number;
  stdout: string;
  ghCalls: string[][];
  /** The content of every `--notes-file` gh was handed, read at call time. */
  notesFiles: string[];
  workDir: string;
}

/**
 * Executes the create-release step's real body under `bash -e`, as GitHub
 * Actions runs a `run:` step with no `shell:`. The work dir is a git repo
 * whose HEAD carries the version tag (so the body's own `git tag --points-at
 * HEAD` sets TAG), holding a copy of the repo's extractor when it exists and
 * the given CHANGELOG.md. A stub `gh` first on PATH records each call (one
 * line per call, fields separated by \x1f), copies the file passed with
 * `--notes-file`, and reports no existing release for `gh release view`.
 */
function runCreateReleaseStep(changelog: string): StepRun {
  const body = createReleaseRunBody();
  const workDir = scratchDir("create-release-work-");
  const stubDir = scratchDir("create-release-stub-");
  const callLog = join(stubDir, "gh-calls.log");
  const notesDir = join(stubDir, "notes");
  mkdirSync(notesDir);

  if (existsSync(EXTRACTOR)) {
    mkdirSync(join(workDir, "scripts"));
    copyFileSync(EXTRACTOR, join(workDir, EXTRACTOR_REL));
    chmodSync(join(workDir, EXTRACTOR_REL), 0o755);
  }
  writeFileSync(join(workDir, "CHANGELOG.md"), changelog);

  const gitEnv = {
    ...minimalEnv(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[]): void => {
    const res = Bun.spawnSync({
      cmd: [
        "git",
        "-c", "user.name=create-release-test",
        "-c", "user.email=create-release-test@example.invalid",
        "-c", "commit.gpgsign=false",
        "-c", "tag.gpgsign=false",
        ...args,
      ],
      cwd: workDir,
      env: gitEnv,
    });
    if (res.exitCode !== 0) {
      throw new Error(`scratch git ${args[0]} failed: ${res.stderr.toString()}`);
    }
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "release fixture"]);
  git(["tag", STEP_TAG]);

  const ghStub = [
    "#!/usr/bin/env bash",
    `{ printf '%s${"\\x1f"}' "$@"; printf '\\n'; } >> '${callLog}'`,
    "prev=''",
    "for arg in \"$@\"; do",
    "  if [ \"$prev\" = '--notes-file' ]; then",
    `    n=$(ls '${notesDir}' | wc -l)`,
    `    cp "$arg" '${notesDir}'/"notes-$n"`,
    "  fi",
    "  prev=\"$arg\"",
    "done",
    "if [ \"$1\" = 'release' ] && [ \"$2\" = 'view' ]; then",
    "  echo 'release not found' >&2",
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(stubDir, "gh"), ghStub);
  chmodSync(join(stubDir, "gh"), 0o755);

  const scriptFile = join(stubDir, "step.sh");
  writeFileSync(scriptFile, body);
  const res = Bun.spawnSync({
    cmd: ["bash", "-e", scriptFile],
    cwd: workDir,
    env: minimalEnv(stubDir),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const ghCalls = existsSync(callLog)
    ? readFileSync(callLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.split(FIELD_SEP).slice(0, -1))
    : [];
  const notesFiles = Array.from({ length: ghCalls.length }, (_, i) => join(notesDir, `notes-${i}`))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, "utf8"));

  return {
    exitCode: res.exitCode,
    stdout: res.stdout.toString(),
    ghCalls,
    notesFiles,
    workDir,
  };
}

function releaseCreateCalls(run: StepRun): string[][] {
  return run.ghCalls.filter((c) => c[0] === "release" && c[1] === "create");
}

const STEP_CHANGELOG_WITH_SECTION = crlf(
  [
    "# Changelog",
    "",
    "## [9.9.9] - 2026-06-01",
    "",
    "### Fixed",
    "- The release carries its own notes.",
    "[9.9.9-ref]: https://example.invalid/an-inline-link-reference",
    "",
    "## [9.9.8] - 2026-05-01",
    "",
    "- The previous release.",
    "",
    "[9.9.9]: https://example.invalid/compare/9.9.8...9.9.9",
    "",
  ].join("\n"),
);

const STEP_EXPECTED_NOTES = "\n### Fixed\n- The release carries its own notes.\n\n";

const STEP_CHANGELOG_WITHOUT_SECTION = [
  "# Changelog",
  "",
  "## [9.9.90] - 2026-06-01",
  "",
  "- A different release whose heading only starts like 9.9.9.",
  "",
  "## [9.9.8] - 2026-05-01",
  "",
  "- The previous release.",
  "",
].join("\n");

describe("create-release takes its notes from the extractor", () => {
  test("the release step calls scripts/release-notes.sh \"$TAG\" inside an if, and carries no section awk", () => {
    const body = createReleaseRunBody();
    const code = codeLines(body);
    expect(
      code.some((line) => /^\s*(if|elif)\b.*scripts\/release-notes\.sh "\$TAG"/.test(line)),
    ).toBe(true);
    expect(code.filter((line) => /\bawk\b/.test(line))).toEqual([]);
  });

  test("executed with the section present, it creates the release from a notes file holding exactly the extractor's output", () => {
    const run = runCreateReleaseStep(STEP_CHANGELOG_WITH_SECTION);
    expect(run.exitCode).toBe(0);

    const creates = releaseCreateCalls(run);
    expect(creates.length).toBe(1);
    const create = creates[0] as string[];
    expect(create.slice(0, 6)).toEqual([
      "release",
      "create",
      STEP_TAG,
      "--title",
      STEP_TAG,
      "--notes-file",
    ]);
    expect(create.length).toBe(7);
    expect(create).not.toContain("--generate-notes");
    expect(run.stdout).not.toContain("::warning::");

    expect(run.notesFiles.length).toBe(1);
    const notes = run.notesFiles[0] as string;
    expect(notes).not.toContain("\r");
    expect(notes).toBe(STEP_EXPECTED_NOTES);

    const extracted = runExtractor([STEP_TAG, join(run.workDir, "CHANGELOG.md")]);
    expect(extracted.exitCode).toBe(0);
    expect(notes).toBe(extracted.stdout);
  });

  test("executed with the section missing, it still exits 0, falls back to generated notes and warns naming the section", () => {
    expect(existsSync(EXTRACTOR)).toBe(true);
    const run = runCreateReleaseStep(STEP_CHANGELOG_WITHOUT_SECTION);
    expect(run.exitCode).toBe(0);

    const creates = releaseCreateCalls(run);
    expect(creates).toEqual([
      ["release", "create", STEP_TAG, "--title", STEP_TAG, "--generate-notes"],
    ]);
    expect(run.notesFiles).toEqual([]);

    const warnings = run.stdout.split("\n").filter((line) => line.startsWith("::warning::"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(`[${STEP_TAG}]`);
    expect(warnings[0]).toContain("CHANGELOG.md");
  });
});
