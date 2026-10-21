// `scripts/release.sh finish X.Y.Z` refuses a release whose notes are not
// committed and dated — before it writes anything.
//
// The notes are the version's `## [X.Y.Z] - YYYY-MM-DD` section of
// CHANGELOG.md, written on the release branch before `finish` (RELEASING.md
// step 3). The tag and the workflow's `create-release` both see the notes AS
// COMMITTED, so `finish` reads `CHANGELOG.md` at HEAD (`git show
// HEAD:CHANGELOG.md`) through the one extractor (`scripts/release-notes.sh`,
// beside `release.sh`), and refuses — through `error()`, to stderr, exit 1 —
// when the heading the extractor reads is not `## [X.Y.Z] - YYYY-MM-DD` or the
// extractor finds no notes. The refusal runs right after the identity guard
// (`guard_agent_identity`) and BEFORE the manifest alignment
// (`align_manifest_version`), on release/* and hotfix/* alike and under
// --dry-run too, so a refused finish commits nothing, merges nothing and tags
// nothing.
//
// TECHNIQUE — real scratch git repos under `mktemp -d`, as
// tests/release-driver.test.ts builds them. Each repo has `master`, then the
// release (or hotfix) branch cut from it, with a STALE package.json (9.9.8) so
// the manifest alignment WOULD make a commit if it ran: "no new commit" is a
// real observation, not a vacuous one.
//
// SAFETY: a recording `git-flow` stub is first on PATH (the real one lives in
// /usr/bin, outside git's exec-path, so the stub wins), so even a finish that
// is NOT refused never runs a real git-flow finish; the scratch repos have no
// remote, so no push can leave the machine. Nothing touches this repository.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

/** The version every finish below is asked for. */
const VERSION = "9.9.9";
/** The manifest version each world starts at — stale, so alignment would commit. */
const STALE_VERSION = "9.9.8";
/** The ceremony identity, supplied unless a test is about its absence. */
const CEREMONY_AGENT = "release-notes-guard-test";

const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "release-notes-guard-test",
  GIT_AUTHOR_EMAIL: "release-notes-guard-test@example.com",
  GIT_COMMITTER_NAME: "release-notes-guard-test",
  GIT_COMMITTER_EMAIL: "release-notes-guard-test@example.com",
};

/** The two ways every refusal case is run: a real finish, and a dry run —
 *  `--dry-run` is a true preflight, so the notes guard refuses under it too. */
const MODES: ReadonlyArray<readonly [string, string[]]> = [
  ["a real finish", []],
  ["a --dry-run finish", ["--dry-run"]],
];

// ---------------------------------------------------------------------------
// Changelog fixtures
// ---------------------------------------------------------------------------

const EARLIER_SECTION = `## [${STALE_VERSION}] - 2026-09-01\n\n### Fixed\n\n- An earlier release.\n`;
const DATED_SECTION = `## [${VERSION}] - 2026-10-21\n\n### Fixed\n\n- The release being finished.\n`;

/** A changelog that has notes, but none for the version being finished. */
const CHANGELOG_WITHOUT_SECTION = `# Changelog\n\n${EARLIER_SECTION}`;
/** The same changelog with the version's dated notes added on top. */
const CHANGELOG_WITH_DATED_SECTION = `# Changelog\n\n${DATED_SECTION}\n${EARLIER_SECTION}`;

/** A size well past a pipe's buffer (64 KB on Linux): a reader that stops
 *  early leaves a writer of this much text blocked, then broken (SIGPIPE). */
const LARGE_BYTES = 512 * 1024;
/** Just past one pipe buffer, a notes section bigger than the buffer. */
const OVER_ONE_PIPE_BUFFER = 96 * 1024;

/** Older dated sections (0.x.y, never 9.9.9) totalling at least `minBytes`. */
function olderSections(minBytes: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = 1; size < minBytes; i++) {
    const part =
      `## [0.${Math.floor(i / 100)}.${i % 100}] - 2020-01-01\n\n### Fixed\n\n` +
      `- Older release ${i}: a long-past fix, kept for the history of the project.\n\n`;
    parts.push(part);
    size += part.length;
  }
  return parts.join("");
}

/** Notes lines (no headings) totalling at least `minBytes`. */
function manyNotes(minBytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 1; size < minBytes; i++) {
    const line = `- Change ${i} of the release being finished, described at some length.\n`;
    lines.push(line);
    size += line.length;
  }
  return lines.join("");
}

/** The refusal's own words, present only when the notes guard refused. */
const NOTES_REFUSAL = "no committed, dated release notes";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runGit(args: string[], cwd: string): RunResult {
  const res = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: { ...process.env, ...GIT_IDENTITY_ENV } });
  return { stdout: res.stdout.toString(), stderr: res.stderr.toString(), exitCode: res.exitCode };
}

function git(args: string[], cwd: string): string {
  const res = runGit(args, cwd);
  if (res.exitCode !== 0) throw new Error(`scratch setup: git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function packageJsonText(version: string): string {
  return `{\n  "name": "demo-pkg",\n  "private": true,\n  "version": "${version}"\n}\n`;
}

/** Everything a refused finish must leave exactly as it found it. */
interface Snapshot {
  branch: string;
  head: string;
  master: string;
  tags: string;
  porcelain: string;
  packageJson: string;
}

interface World {
  dir: string;
  branch: string;
  snapshot(): Snapshot;
  /** Every argv the `git-flow` stub received, one per line. */
  flowCalls(): string[];
  /** `script` runs another copy of release.sh (default: this repository's). */
  finish(extraArgs: string[], opts?: { agent?: string | null; script?: string }): RunResult;
}

interface WorldSpec {
  /** release/9.9.9 unless stated. */
  branch?: string;
  /** The CHANGELOG.md committed on the branch; `null` commits none at all. */
  committedChangelog: string | null;
}

describe("finish refuses a release whose notes are not committed and dated", () => {
  const scratch: string[] = [];

  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeWorld(spec: WorldSpec): World {
    const root = mkdtempSync(join(tmpdir(), "release-notes-guard-"));
    scratch.push(root);
    const dir = join(root, "repo");
    const bin = join(root, "bin");
    const flowLog = join(root, "git-flow.log");
    mkdirSync(dir);
    mkdirSync(bin);
    writeFileSync(flowLog, "");
    // A recording git-flow: `git flow …` resolves here before /usr/bin/git-flow.
    writeFileSync(join(bin, "git-flow"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${flowLog}"\nexit 0\n`);
    chmodSync(join(bin, "git-flow"), 0o755);

    const branch = spec.branch ?? `release/${VERSION}`;
    git(["init", "-q"], dir);
    git(["symbolic-ref", "HEAD", "refs/heads/master"], dir);
    writeFileSync(join(dir, "package.json"), packageJsonText(STALE_VERSION));
    if (spec.committedChangelog !== null) writeFileSync(join(dir, "CHANGELOG.md"), spec.committedChangelog);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "initial"], dir);
    git(["checkout", "-q", "-b", branch], dir);
    // The tag-prefix guard is satisfied, so nothing but the notes is in question.
    git(["config", "gitflow.prefix.versiontag", ""], dir);

    const pathDirs = [bin, ...(process.env.PATH ?? "").split(":").filter((d) => d.length > 0)];

    return {
      dir,
      branch,
      snapshot(): Snapshot {
        return {
          branch: git(["rev-parse", "--abbrev-ref", "HEAD"], dir).trim(),
          head: git(["rev-parse", "HEAD"], dir).trim(),
          master: git(["rev-parse", "refs/heads/master"], dir).trim(),
          tags: git(["tag", "--list"], dir),
          porcelain: git(["status", "--porcelain"], dir),
          packageJson: readFileSync(join(dir, "package.json"), "utf8"),
        };
      },
      flowCalls(): string[] {
        return readFileSync(flowLog, "utf8")
          .split("\n")
          .filter((l) => l.length > 0);
      },
      finish(extraArgs, opts = {}): RunResult {
        const agent = opts.agent === undefined ? CEREMONY_AGENT : opts.agent;
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...GIT_IDENTITY_ENV,
          PATH: pathDirs.join(":"),
          CRUCIBLE_AGENT: agent ?? undefined,
        };
        if (agent === null) delete env.CRUCIBLE_AGENT;
        const script = opts.script ?? RELEASE_SH;
        const res = Bun.spawnSync({ cmd: [script, "finish", VERSION, ...extraArgs], cwd: dir, env });
        return { stdout: res.stdout.toString(), stderr: res.stderr.toString(), exitCode: res.exitCode };
      },
    };
  }

  /** The notes refusal, and everything it must NOT have done. */
  function expectNotesRefusal(world: World, before: Snapshot, res: RunResult): void {
    // Refused through error(): exit 1, on stderr, naming the file, the heading
    // it expected and the runbook step that writes it.
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("ERROR:");
    expect(res.stderr).toContain("CHANGELOG.md");
    expect(res.stderr).toContain(`## [${VERSION}] - `);
    expect(res.stderr).toContain("RELEASING.md");
    // No plan was printed — not even under --dry-run.
    expect(res.stdout).not.toContain("git flow");
    expect(res.stdout).not.toContain("git push");
    // Nothing was written: no alignment commit (the stale manifest is still
    // stale), nothing swept from the index, no merge, no tag, no git-flow run.
    expect(world.snapshot()).toEqual(before);
    expect(world.flowCalls()).toEqual([]);
  }

  // -- no section at all ----------------------------------------------------

  test.each(MODES)("%s on release/9.9.9 refuses when the committed CHANGELOG.md has no section for 9.9.9", (_mode, args) => {
    const world = makeWorld({ committedChangelog: CHANGELOG_WITHOUT_SECTION });
    const before = world.snapshot();
    expect(before.tags).toBe("");
    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
    expect(world.snapshot().packageJson).toBe(packageJsonText(STALE_VERSION));
  });

  test.each(MODES)("%s on hotfix/9.9.9 refuses when the committed CHANGELOG.md has no section for 9.9.9", (_mode, args) => {
    const world = makeWorld({ branch: `hotfix/${VERSION}`, committedChangelog: CHANGELOG_WITHOUT_SECTION });
    const before = world.snapshot();
    expect(before.branch).toBe(`hotfix/${VERSION}`);
    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
  });

  test.each(MODES)("%s refuses when the release branch has no CHANGELOG.md at all", (_mode, args) => {
    const world = makeWorld({ committedChangelog: null });
    const before = world.snapshot();
    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
  });

  // -- the heading must carry a date ----------------------------------------

  test.each(MODES)("%s refuses an undated `## [9.9.9]` heading even though its section has notes", (_mode, args) => {
    const world = makeWorld({
      committedChangelog: `# Changelog\n\n## [${VERSION}]\n\n### Fixed\n\n- The release being finished.\n\n${EARLIER_SECTION}`,
    });
    const before = world.snapshot();
    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
  });

  test.each(MODES)("%s refuses a heading whose date is not YYYY-MM-DD (`## [9.9.9] - soon`)", (_mode, args) => {
    const world = makeWorld({
      committedChangelog: `# Changelog\n\n## [${VERSION}] - soon\n\n### Fixed\n\n- The release being finished.\n\n${EARLIER_SECTION}`,
    });
    const before = world.snapshot();
    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
  });

  test.each(MODES)(
    "%s checks the date on the FIRST `## [9.9.9]` heading — the one the extractor reads — so a dated duplicate further down does not rescue an undated one",
    (_mode, args) => {
      const world = makeWorld({
        committedChangelog:
          `# Changelog\n\n## [${VERSION}]\n\n- Undated notes, read first.\n\n` +
          `## [${VERSION}] - 2026-10-21\n\n- Dated notes, never read.\n\n${EARLIER_SECTION}`,
      });
      const before = world.snapshot();
      const res = world.finish(args);
      expectNotesRefusal(world, before, res);
    },
  );

  // -- a dated heading needs notes under it ---------------------------------

  test.each(MODES)("%s refuses a dated `## [9.9.9]` heading whose section is empty", (_mode, args) => {
    const world = makeWorld({
      committedChangelog: `# Changelog\n\n## [${VERSION}] - 2026-10-21\n${EARLIER_SECTION}`,
    });
    const before = world.snapshot();
    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
  });

  test.each(MODES)("%s refuses a dated `## [9.9.9]` heading whose section is only whitespace", (_mode, args) => {
    const world = makeWorld({
      committedChangelog: `# Changelog\n\n## [${VERSION}] - 2026-10-21\n   \n\t\n\n${EARLIER_SECTION}`,
    });
    const before = world.snapshot();
    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
  });

  test.each(MODES)("%s refuses a dated `## [9.9.9]` heading whose section holds only link references", (_mode, args) => {
    const world = makeWorld({
      committedChangelog:
        `# Changelog\n\n## [${VERSION}] - 2026-10-21\n\n` +
        `[${VERSION}]: https://example.com/compare/${STALE_VERSION}...${VERSION}\n` +
        `[${STALE_VERSION}]: https://example.com/releases/${STALE_VERSION}\n\n${EARLIER_SECTION}`,
    });
    const before = world.snapshot();
    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
  });

  // -- only COMMITTED notes count -------------------------------------------

  test.each(MODES)(
    "%s refuses dated notes that are only STAGED, and does not sweep the staged CHANGELOG.md into any commit",
    (_mode, args) => {
      const world = makeWorld({ committedChangelog: CHANGELOG_WITHOUT_SECTION });
      writeFileSync(join(world.dir, "CHANGELOG.md"), CHANGELOG_WITH_DATED_SECTION);
      git(["add", "CHANGELOG.md"], world.dir);
      const before = world.snapshot();
      expect(before.porcelain).toBe("M  CHANGELOG.md\n");

      const res = world.finish(args);
      expectNotesRefusal(world, before, res);
      // Still staged, still absent from HEAD: nothing committed it.
      expect(git(["diff", "--cached", "--name-only"], world.dir)).toBe("CHANGELOG.md\n");
      expect(git(["show", "HEAD:CHANGELOG.md"], world.dir)).toBe(CHANGELOG_WITHOUT_SECTION);
    },
  );

  test.each(MODES)("%s refuses dated notes that exist only in an UNTRACKED CHANGELOG.md", (_mode, args) => {
    const world = makeWorld({ committedChangelog: null });
    writeFileSync(join(world.dir, "CHANGELOG.md"), CHANGELOG_WITH_DATED_SECTION);
    const before = world.snapshot();
    expect(before.porcelain).toBe("?? CHANGELOG.md\n");

    const res = world.finish(args);
    expectNotesRefusal(world, before, res);
    // Still untracked: nothing added it.
    expect(runGit(["ls-files", "--error-unmatch", "CHANGELOG.md"], world.dir).exitCode).not.toBe(0);
  });

  // -- order: identity first, then notes ------------------------------------

  test.each(MODES)(
    "%s with NEITHER an identity NOR notes gets the identity refusal, not the notes one — and the same world, given an identity, then gets the notes refusal",
    (_mode, args) => {
      const world = makeWorld({ committedChangelog: CHANGELOG_WITHOUT_SECTION });
      const before = world.snapshot();

      // Identity runs first: its own refusal, and no word of the notes.
      const anonymous = world.finish(args, { agent: null });
      expect(anonymous.exitCode).toBe(1);
      expect(anonymous.stderr).toContain("no Crucible identity");
      expect(anonymous.stderr).toContain("CRUCIBLE_AGENT");
      expect(anonymous.stderr).not.toContain("RELEASING.md");
      expect(anonymous.stderr).not.toContain(`## [${VERSION}] - `);
      expect(world.snapshot()).toEqual(before);

      // Contrast: this world really does fail the notes guard, so the refusal
      // above is the identity guard winning the ORDER, not a world that would
      // pass the notes check anyway.
      const identified = world.finish(args);
      expectNotesRefusal(world, before, identified);
      expect(identified.stderr).not.toContain("no Crucible identity");
    },
  );

  // -- a changelog larger than a pipe buffer is read whole --------------------

  describe("a committed CHANGELOG.md larger than a pipe buffer", () => {
    /** An accepted dry run: exit 0, the plan printed, only the alignment committed. */
    function expectAcceptedDryRun(world: World, before: Snapshot, changelog: string, res: RunResult): void {
      expect({ exitCode: res.exitCode, refused: res.stderr.includes(NOTES_REFUSAL) }).toEqual({
        exitCode: 0,
        refused: false,
      });
      expect(res.stdout).toContain(`git flow release finish -m "Release ${VERSION}" ${VERSION}`);
      expect(res.stdout).toContain("git push origin master develop --tags");
      // The dry run executed no git-flow finish.
      expect(world.flowCalls()).toEqual([]);
      // The one real write a dry run makes: the manifest aligned and committed
      // on top of the starting HEAD; the committed notes are untouched.
      const pkg = JSON.parse(readFileSync(join(world.dir, "package.json"), "utf8")) as { version: string };
      expect(pkg.version).toBe(VERSION);
      expect(git(["rev-parse", "HEAD~1"], world.dir).trim()).toBe(before.head);
      expect(git(["show", "HEAD:CHANGELOG.md"], world.dir)).toBe(changelog);
      expect(world.snapshot().tags).toBe("");
    }

    test("a --dry-run finish accepts dated notes for 9.9.9 at the top of a changelog with over 256 KB of older sections below, and prints its plan", () => {
      const changelog = `# Changelog\n\n${DATED_SECTION}\n${olderSections(LARGE_BYTES)}`;
      expect(changelog.length).toBeGreaterThan(256 * 1024);
      const world = makeWorld({ committedChangelog: changelog });
      const before = world.snapshot();

      const res = world.finish(["--dry-run"]);
      expectAcceptedDryRun(world, before, changelog, res);
    });

    test("a --dry-run finish accepts a dated 9.9.9 section that itself holds over 64 KB of notes, followed by older sections, and prints its plan", () => {
      const notes = manyNotes(OVER_ONE_PIPE_BUFFER);
      expect(notes.length).toBeGreaterThan(64 * 1024);
      const changelog =
        `# Changelog\n\n## [${VERSION}] - 2026-10-21\n\n### Fixed\n\n${notes}\n` + olderSections(LARGE_BYTES);
      const world = makeWorld({ committedChangelog: changelog });
      const before = world.snapshot();

      const res = world.finish(["--dry-run"]);
      expectAcceptedDryRun(world, before, changelog, res);
    });

    test.each(MODES)(
      "%s with a large committed CHANGELOG.md that has no 9.9.9 section gets the usual notes refusal",
      (_mode, args) => {
        const changelog = `# Changelog\n\n${olderSections(LARGE_BYTES)}`;
        const world = makeWorld({ committedChangelog: changelog });
        const before = world.snapshot();

        const res = world.finish(args);
        expectNotesRefusal(world, before, res);
        expect(res.stderr).toContain(NOTES_REFUSAL);
      },
    );

    test.each(MODES)(
      "%s refuses an undated `## [9.9.9]` heading at the top of a large changelog with the usual notes refusal, not a silent death",
      (_mode, args) => {
        const changelog =
          `# Changelog\n\n## [${VERSION}]\n\n### Fixed\n\n- The release being finished.\n\n` + olderSections(LARGE_BYTES);
        const world = makeWorld({ committedChangelog: changelog });
        const before = world.snapshot();

        const res = world.finish(args);
        expectNotesRefusal(world, before, res);
        expect(res.stderr).toContain(NOTES_REFUSAL);
      },
    );
  });

  // -- the extractor beside release.sh is missing -----------------------------

  describe("a release.sh whose notes extractor is missing", () => {
    /** A copy of release.sh alone in a scratch `scripts/` dir, no release-notes.sh beside it. */
    function loneReleaseScript(): string {
      const root = mkdtempSync(join(tmpdir(), "release-notes-guard-lone-"));
      scratch.push(root);
      mkdirSync(join(root, "scripts"));
      const script = join(root, "scripts", "release.sh");
      writeFileSync(script, readFileSync(RELEASE_SH));
      chmodSync(script, 0o755);
      return script;
    }

    test.each(MODES)(
      "%s with valid committed notes says the extractor release-notes.sh is missing, not that the notes are missing, and commits nothing",
      (_mode, args) => {
        const world = makeWorld({ committedChangelog: CHANGELOG_WITH_DATED_SECTION });
        const before = world.snapshot();
        const script = loneReleaseScript();

        const res = world.finish(args, { script });
        // Scratch paths redacted, so no failure message prints the temp dir.
        const stderr = res.stderr.replaceAll(tmpdir(), "<tmp>");
        expect(res.exitCode).toBe(1);
        expect(stderr).toContain("release-notes.sh");
        expect(stderr).toMatch(/missing|not found/i);
        expect(stderr).not.toContain(NOTES_REFUSAL);
        // Refused before anything: no plan, no alignment commit, no git-flow run.
        expect(res.stdout).not.toContain("git flow");
        expect(res.stdout).not.toContain("git push");
        expect(world.snapshot()).toEqual(before);
        expect(world.flowCalls()).toEqual([]);

        // Contrast: these notes ARE valid, the real release.sh, with its
        // extractor beside it, accepts them, so the refusal above is about the
        // missing extractor alone.
        const withExtractor = world.finish(["--dry-run"]);
        expect(withExtractor.exitCode).toBe(0);
        expect(withExtractor.stderr).not.toContain(NOTES_REFUSAL);
      },
    );
  });
});
