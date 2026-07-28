// CR-CRU-041 C3 — §S3 `scripts/release.sh` branch-gated release driver +
// the `release.sh` half of §S5 (tag-prefix preflight guard).
//
// Spec: docs/changes/CR-CRU-041-release-mechanism.md §S3 + §S5 + Acceptance
// criteria (the `release.sh`-related bullets).
//
// RED phase: `scripts/` does not exist at all yet on this branch (confirmed
// via `ctx_tree` / `ls` — no `scripts/` directory). `scripts/release.sh` is
// invoked by an ABSOLUTE path via `Bun.spawnSync`, so every test below fails
// either on the leading existence assertion or with an ENOENT thrown by
// `Bun.spawnSync` (ephemeral run for a non-existent executable) until GREEN
// creates the script.
//
// Safety: NO test ever runs `git flow ... finish`, `git push`, or
// `gh workflow run` for real, and NO test touches this repository. Every
// git-flow/subprocess-executing path is exercised exclusively via `--dry-run`
// against disposable scratch repos created under `mktemp -d` (absolute
// paths), which is also how the guard-ordering ACs are proven (the guards
// must fire, and refuse, even under `--dry-run` — that is the whole point of
// `--dry-run` being a TRUE preflight, not just an execution skip).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  combined: string;
}

const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "release-sh-test",
  GIT_AUTHOR_EMAIL: "release-sh-test@example.com",
  GIT_COMMITTER_NAME: "release-sh-test",
  GIT_COMMITTER_EMAIL: "release-sh-test@example.com",
};

function runGit(args: string[], cwd: string): RunResult {
  const res = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, ...GIT_IDENTITY_ENV },
  });
  const stdout = res.stdout.toString();
  const stderr = res.stderr.toString();
  return { stdout, stderr, exitCode: res.exitCode, combined: `${stdout}\n${stderr}` };
}

function git(args: string[], cwd: string): void {
  const res = runGit(args, cwd);
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
}

/** Invokes `scripts/release.sh` via its ABSOLUTE path against a scratch repo. */
function runRelease(cwd: string, args: string[]): RunResult {
  const res = Bun.spawnSync({
    cmd: [RELEASE_SH, ...args],
    cwd,
    env: { ...process.env, ...GIT_IDENTITY_ENV },
  });
  const stdout = res.stdout.toString();
  const stderr = res.stderr.toString();
  return { stdout, stderr, exitCode: res.exitCode, combined: `${stdout}\n${stderr}` };
}

/** Initializes a throwaway git repo at `dir` on a KNOWN branch name, with no commits yet. */
function initEmptyScratchRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "release-sh-test-"));
  git(["init", "-q"], dir);
  // Set the branch name BEFORE any commit (works pre-2.28, unlike `git init -b`).
  git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir);
  return dir;
}

// Deliberately irregular formatting (4-space indent, `version` in the
// MIDDLE of the object, no trailing newline) so a naive
// JSON.parse()+JSON.stringify() GREEN implementation is caught: it would
// reorder/reformat this and fail the exact-string assertions below.
function packageJsonText(version: string): string {
  return (
    "{\n" +
    '    "name": "demo-pkg",\n' +
    '    "private": true,\n' +
    `    "version": "${version}",\n` +
    '    "description": "scratch package for release.sh tests"\n' +
    "}"
  );
}

const PYPROJECT_TOML_TEXT = ['[project]', 'name = "demo-pkg"', 'dynamic = ["version"]', ''].join("\n");

/** Initializes a scratch repo with a committed package.json (+ pyproject.toml) at `version`. */
function initCommittedScratchRepo(branch: string, version: string): { dir: string; originalPackageJson: string } {
  const dir = initEmptyScratchRepo(branch);
  const originalPackageJson = packageJsonText(version);
  writeFileSync(join(dir, "package.json"), originalPackageJson);
  writeFileSync(join(dir, "pyproject.toml"), PYPROJECT_TOML_TEXT);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "initial"], dir);
  return { dir, originalPackageJson };
}

function setVersionTagPrefix(dir: string, value: string): void {
  git(["config", "gitflow.prefix.versiontag", value], dir);
}

function headSha(dir: string): string {
  return runGit(["rev-parse", "HEAD"], dir).stdout.trim();
}

function changedFilesInHeadCommit(dir: string): string[] {
  return runGit(["show", "--name-only", "--pretty=format:", "-1", "HEAD"], dir).stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

describe("scripts/release.sh (CR-CRU-041 §S3 + §S5)", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function track(dir: string): string {
    scratchDirs.push(dir);
    return dir;
  }

  test("exists and is executable", () => {
    expect(existsSync(RELEASE_SH)).toBe(true);
    const mode = statSync(RELEASE_SH).mode;
    // owner-execute bit set
    expect((mode & 0o100) !== 0).toBe(true);
  });

  test("-h/--help exits 0 and lists all four subcommands, branch-agnostic", () => {
    const dir = track(initEmptyScratchRepo("develop"));
    const res = runRelease(dir, ["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.combined).toContain("set-version");
    expect(res.combined).toContain("checkpoint");
    expect(res.combined).toContain("finish");
    expect(res.combined).toContain("status");
  });

  test("status exits 0 and reports the current branch + tag-derived version", () => {
    const { dir } = initCommittedScratchRepo("develop", "0.0.1");
    track(dir);
    git(["tag", "v9.9.9"], dir);
    const res = runRelease(dir, ["status"]);
    expect(res.exitCode).toBe(0);
    expect(res.combined).toContain("develop");
    expect(res.combined).toContain("9.9.9");
  });

  // -- branch gating: set-version / checkpoint / finish exit 2 off release/hotfix --

  test("set-version exits 2 on develop and does NOT modify package.json", () => {
    const { dir, originalPackageJson } = initCommittedScratchRepo("develop", "0.0.1");
    track(dir);
    const beforeSha = headSha(dir);
    const res = runRelease(dir, ["set-version", "9.9.9"]);
    expect(res.exitCode).toBe(2);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(originalPackageJson);
    expect(headSha(dir)).toBe(beforeSha);
  });

  test("checkpoint exits 2 on develop (not release/* or hotfix/*)", () => {
    const { dir } = initCommittedScratchRepo("develop", "0.0.1");
    track(dir);
    const res = runRelease(dir, ["checkpoint"]);
    expect(res.exitCode).toBe(2);
  });

  test("finish exits 2 on develop (not release/* or hotfix/*)", () => {
    const { dir } = initCommittedScratchRepo("develop", "0.0.1");
    track(dir);
    const res = runRelease(dir, ["finish", "9.9.9"]);
    expect(res.exitCode).toBe(2);
  });

  // -- set-version behaviour on an allowed branch --

  test("set-version 9.9.9 on release/* sets package.json to 9.9.9, commits it format-preservingly, and leaves pyproject.toml untouched", () => {
    const { dir, originalPackageJson } = initCommittedScratchRepo("release/9.9.9", "0.0.1");
    track(dir);
    const beforeSha = headSha(dir);

    const res = runRelease(dir, ["set-version", "9.9.9"]);
    expect(res.exitCode).toBe(0);

    // Format-preserving: ONLY the version value changed, nothing reserialized.
    const expectedPackageJson = originalPackageJson.replace('"version": "0.0.1"', '"version": "9.9.9"');
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(expectedPackageJson);

    // pyproject.toml is byte-for-byte untouched (hatch-vcs owns the Python version).
    expect(readFileSync(join(dir, "pyproject.toml"), "utf8")).toBe(PYPROJECT_TOML_TEXT);

    // A commit happened, and it touched ONLY package.json.
    const afterSha = headSha(dir);
    expect(afterSha).not.toBe(beforeSha);
    expect(changedFilesInHeadCommit(dir)).toEqual(["package.json"]);
  });

  test("set-version 9.9.9 is also allowed on hotfix/*", () => {
    const { dir } = initCommittedScratchRepo("hotfix/9.9.9", "0.0.1");
    track(dir);
    const res = runRelease(dir, ["set-version", "9.9.9"]);
    expect(res.exitCode).toBe(0);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("9.9.9");
  });

  test.each(["1.2", "abc", "1.2.3.4"])(
    "set-version rejects a malformed version %p with a non-zero usage error and no side effects",
    (badVersion) => {
      const { dir, originalPackageJson } = initCommittedScratchRepo("release/x", "0.0.1");
      track(dir);
      const beforeSha = headSha(dir);
      const res = runRelease(dir, ["set-version", badVersion]);
      expect(res.exitCode).not.toBe(0);
      expect(res.combined.toLowerCase()).toContain("version");
      expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(originalPackageJson);
      expect(headSha(dir)).toBe(beforeSha);
    },
  );

  // -- checkpoint: dispatches the Test-PyPI rehearsal via `gh workflow run` --

  test("checkpoint --dry-run on release/* prints the intended `gh workflow run release.yml --ref <branch>` plan without executing it", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "0.0.1");
    track(dir);
    const res = runRelease(dir, ["checkpoint", "--dry-run"]);
    expect(res.exitCode).toBe(0);
    expect(res.combined).toContain("gh workflow run release.yml");
    expect(res.combined).toContain("--ref");
    expect(res.combined).toContain("release/9.9.9");
  });

  // -- finish: preflight guards, in order, BEFORE any git-flow/push command --

  test("finish 9.9.9 refuses (non-zero) when package.json version mismatches, naming set-version, even under --dry-run, and prints NO git-flow/push line", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "0.0.1"); // package.json still 0.0.1
    track(dir);
    setVersionTagPrefix(dir, "v"); // tag-prefix guard satisfied so ONLY the manifest guard is under test
    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.combined).toContain("set-version");
    expect(res.combined).not.toContain("git flow");
    expect(res.combined).not.toContain("git push");
  });

  test("finish 9.9.9 refuses (non-zero) when gitflow.prefix.versiontag is UNSET, naming the fix, even under --dry-run, and prints NO git-flow/push line", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "9.9.9"); // manifest guard satisfied
    track(dir);
    // gitflow.prefix.versiontag intentionally left unset.
    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.combined).toContain("gitflow.prefix.versiontag");
    expect(res.combined).toContain("git config gitflow.prefix.versiontag v");
    expect(res.combined).not.toContain("git flow release");
    expect(res.combined).not.toContain("git push");
  });

  test("finish 9.9.9 refuses (non-zero) when gitflow.prefix.versiontag is WRONG (not 'v'), naming the fix, even under --dry-run", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "9.9.9"); // manifest guard satisfied
    track(dir);
    setVersionTagPrefix(dir, "release-"); // wrong prefix, e.g. Crucible's historical bare-tag setup
    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.combined).toContain("gitflow.prefix.versiontag");
    expect(res.combined).toContain("git config gitflow.prefix.versiontag v");
    expect(res.combined).not.toContain("git flow release");
    expect(res.combined).not.toContain("git push");
  });

  test("finish 9.9.9 with BOTH guards satisfied on release/* --dry-run exits 0 and prints the git-flow-release-finish + push plan without executing", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "9.9.9");
    track(dir);
    setVersionTagPrefix(dir, "v");
    const beforeSha = headSha(dir);

    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);

    expect(res.exitCode).toBe(0);
    expect(res.combined).toContain("git flow release finish");
    expect(res.combined).toContain("-m"); // non-interactive-safe: no annotated-tag editor hang
    expect(res.combined).toContain("git push origin master develop --tags");

    // --dry-run is a TRUE preflight: nothing was actually executed.
    expect(headSha(dir)).toBe(beforeSha);
    const branches = runGit(["branch", "--list"], dir).stdout;
    expect(branches).toContain("release/9.9.9");
  });

  test("finish 9.9.9 with BOTH guards satisfied on hotfix/* --dry-run exits 0 and prints the git-flow-hotfix-finish plan without executing", () => {
    const { dir } = initCommittedScratchRepo("hotfix/9.9.9", "9.9.9");
    track(dir);
    setVersionTagPrefix(dir, "v");
    const beforeSha = headSha(dir);

    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);

    expect(res.exitCode).toBe(0);
    expect(res.combined).toContain("git flow hotfix finish");
    expect(res.combined).toContain("git push origin master develop --tags");
    expect(headSha(dir)).toBe(beforeSha);
  });
});
