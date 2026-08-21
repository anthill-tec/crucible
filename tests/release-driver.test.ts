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
  // CR-CRU-080 §S2 — a ceremony identity must be AVAILABLE, or `finish`
  // refuses at preflight (the identity guard joins guard_manifest_version and
  // guard_tag_prefix, which already fire under --dry-run). These tests are
  // about the branch/manifest/tag-prefix guards, so the identity is supplied
  // and never the variable under test; tests/release-reporting.test.ts owns
  // the absent-identity refusal.
  CRUCIBLE_AGENT: "release-sh-test",
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

  // CR-CRU-061 §S7 (SUPERSEDES the prior "finish refuses on a stale
  // manifest" contract) — user decision 2026-08-04, option (b): `finish
  // X.Y.Z` now ALIGNS package.json to X.Y.Z itself (committing it) BEFORE
  // running guard_manifest_version, so the guard becomes an invariant the
  // script maintains rather than a wall the operator hits. A bare
  // `finish X.Y.Z` with NO prior `set-version` must now SUCCEED from a
  // stale manifest — the opposite of the superseded assertion below.
  //
  // The alignment write/commit is proven to happen for REAL even under
  // --dry-run (unlike `set-version --dry-run`'s pure preview): only the
  // terminal `git flow ... finish` / `git push` are gated behind --dry-run
  // here. This is the only way §S7's "committed BEFORE the git-flow
  // finish, or it would not be on the merge" AC is testable at all inside
  // this file's absolute rule that no test may ever run a real git-flow
  // finish or push — so a real (but always-local, never-pushed) commit
  // inside a throwaway scratch repo is the intended, safe proof.
  test("finish 9.9.9 aligns a STALE package.json to 9.9.9 itself, with no prior set-version, and proceeds past the preflight", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "0.0.1"); // package.json still 0.0.1, no set-version was run
    track(dir);
    setVersionTagPrefix(dir, ""); // tag-prefix guard satisfied so only the manifest-alignment path is under test
    const beforeSha = headSha(dir);

    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);

    expect(res.exitCode).toBe(0);
    // The manifest itself ends up at X.Y.Z — a REAL filesystem write.
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("9.9.9");
    // `finish` proceeded past BOTH preflight guards to describe the
    // git-flow-finish plan (proving guard_manifest_version did not refuse).
    expect(res.combined).toContain("git flow release finish");
    expect(res.combined).toContain("git push origin master develop --tags");
    // Nothing was actually executed: still on the release branch, no merge.
    const branches = runGit(["branch", "--list"], dir).stdout;
    expect(branches).toContain("release/9.9.9");
    // The alignment commit happened (a real commit, distinct from the
    // starting HEAD) — see the ordering test below for the stronger proof.
    expect(headSha(dir)).not.toBe(beforeSha);
  });

  test("finish's manifest-alignment commit is real (clean tree, single commit touching only package.json) — it precedes the git-flow finish, not merely printed alongside it", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "0.0.1"); // stale
    track(dir);
    setVersionTagPrefix(dir, "");
    const beforeSha = headSha(dir);

    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);
    expect(res.exitCode).toBe(0);

    // A NEW commit was created (not just a dirty working tree) — if the
    // alignment only rewrote the file without committing, it would not be
    // included when `git flow finish` later merges the release branch.
    const afterSha = headSha(dir);
    expect(afterSha).not.toBe(beforeSha);
    expect(changedFilesInHeadCommit(dir)).toEqual(["package.json"]);
    // The working tree is already clean — the alignment is fully committed
    // and sitting on HEAD of the release branch BEFORE the (unexecuted,
    // merely printed) `git flow release finish` plan is reported.
    expect(runGit(["status", "--porcelain"], dir).stdout.trim()).toBe("");
  });

  test("finish is idempotent: a SECOND finish call against an already-aligned manifest makes no further commit and does not fail", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "0.0.1"); // stale
    track(dir);
    setVersionTagPrefix(dir, "");

    const first = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);
    expect(first.exitCode).toBe(0);
    const shaAfterFirst = headSha(dir);
    const pkgAfterFirst = readFileSync(join(dir, "package.json"), "utf8");

    // Second call: manifest is now ALREADY at 9.9.9 — the common case for
    // anyone who runs `set-version` from habit. Must succeed with no
    // spurious commit and no failure.
    const second = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);
    expect(second.exitCode).toBe(0);
    expect(headSha(dir)).toBe(shaAfterFirst); // no new commit
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(pkgAfterFirst); // byte-identical, no rewrite churn
    expect(second.combined).toContain("git flow release finish");
  });

  test("guard_manifest_version is kept, not deleted: it still refuses when package.json has NO version key to align, even though a normal stale manifest now succeeds", () => {
    // Contrast case A: a NORMAL stale manifest (has a version key, just the
    // wrong value) — this now succeeds via alignment (CR-CRU-061 §S7).
    const { dir: alignable } = initCommittedScratchRepo("release/9.9.9", "0.0.1");
    track(alignable);
    setVersionTagPrefix(alignable, "");
    const resAlignable = runRelease(alignable, ["finish", "9.9.9", "--dry-run"]);
    expect(resAlignable.exitCode).toBe(0);

    // Contrast case B: package.json has NO "version" key at all — there is
    // nothing for the alignment step to substitute, so it genuinely CANNOT
    // be aligned. guard_manifest_version must still be reachable and still
    // fatal in this genuine failure mode.
    const unalignable = track(initEmptyScratchRepo("release/9.9.9"));
    writeFileSync(join(unalignable, "package.json"), '{\n    "name": "demo-pkg",\n    "private": true\n}');
    git(["add", "-A"], unalignable);
    git(["commit", "-q", "-m", "initial"], unalignable);
    setVersionTagPrefix(unalignable, "");

    const resUnalignable = runRelease(unalignable, ["finish", "9.9.9", "--dry-run"]);
    expect(resUnalignable.exitCode).not.toBe(0);
    expect(resUnalignable.combined).not.toContain("git flow");
    expect(resUnalignable.combined).not.toContain("git push");

    // The guard function itself is still present in the script source —
    // "not deleted".
    const raw = readFileSync(RELEASE_SH, "utf8");
    expect(raw).toContain("guard_manifest_version()");
  });

  // CR-CRU-061 §S1/§S6 (SUPERSEDES the block below's prior 'v'-required
  // contract) — the user reaffirmed bare SemVer categorically on 2026-08-03.
  // guard_tag_prefix() now asserts gitflow.prefix.versiontag is EMPTY, not
  // "v". MEASURED: git-flow treats UNSET and SET-TO-EMPTY differently — an
  // unset key makes `git flow feature start` die outright ("Fatal: Version
  // tag not set"), while a key explicitly set to "" works and cuts bare
  // tags. So the guard must accept set-and-empty and REJECT unset — a naive
  // `!= "v"` (or even `!= ""`-via-`git config --get \|\| true`, which cannot
  // tell unset from set-empty) check would wrongly pass the unset state.
  // These two guard tests together pin BOTH directions of that distinction;
  // the two "BOTH guards satisfied" tests below pin the accept-when-empty
  // side.
  test("finish 9.9.9 refuses (non-zero) when gitflow.prefix.versiontag is UNSET, naming the fix (including the empty quotes), even under --dry-run, and prints NO git-flow/push line", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "9.9.9"); // manifest guard satisfied
    track(dir);
    // gitflow.prefix.versiontag intentionally left unset (the state that
    // breaks git-flow itself, per CR-CRU-061's measured ground truth).
    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.combined).toContain("gitflow.prefix.versiontag");
    // POSITIVE — exact fix command, including the empty quotes (a bare
    // `git config gitflow.prefix.versiontag` with no argument would UNSET
    // it again, recreating the bug).
    expect(res.combined).toContain('git config gitflow.prefix.versiontag ""');
    // NEGATIVE — the superseded 'v'-prefixed fix command must not survive.
    expect(res.combined).not.toContain("git config gitflow.prefix.versiontag v");
    expect(res.combined).not.toContain("git flow release");
    expect(res.combined).not.toContain("git push");
  });

  test("finish 9.9.9 refuses (non-zero) when gitflow.prefix.versiontag is WRONG (set to the historical non-empty 'v'), naming the fix, even under --dry-run", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "9.9.9"); // manifest guard satisfied
    track(dir);
    setVersionTagPrefix(dir, "v"); // the OLD (CR-041 §S5) contract's value — must now be REJECTED, not accepted
    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);
    expect(res.exitCode).not.toBe(0);
    expect(res.combined).toContain("gitflow.prefix.versiontag");
    expect(res.combined).toContain('git config gitflow.prefix.versiontag ""');
    expect(res.combined).not.toContain("git flow release");
    expect(res.combined).not.toContain("git push");
  });

  test("finish 9.9.9 with BOTH guards satisfied on release/* --dry-run exits 0 and prints the git-flow-release-finish + push plan without executing", () => {
    const { dir } = initCommittedScratchRepo("release/9.9.9", "9.9.9");
    track(dir);
    setVersionTagPrefix(dir, ""); // CR-CRU-061 §S1: set-and-empty is the valid state
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
    setVersionTagPrefix(dir, ""); // CR-CRU-061 §S1: set-and-empty is the valid state
    const beforeSha = headSha(dir);

    const res = runRelease(dir, ["finish", "9.9.9", "--dry-run"]);

    expect(res.exitCode).toBe(0);
    expect(res.combined).toContain("git flow hotfix finish");
    expect(res.combined).toContain("git push origin master develop --tags");
    expect(headSha(dir)).toBe(beforeSha);
  });

  // CR-CRU-061 §S1 — sweep: no dead `#v` strip or `v`-prefix guard literal
  // survives in scripts/release.sh (ground truth: cmd_status's
  // `version="${version#v}"` and guard_tag_prefix's `!= "v"` / "expected 'v'"
  // error text are both now stale under the bare-SemVer contract).
  test("scripts/release.sh contains no dead #v strip and no v-prefix guard literal", () => {
    const raw = readFileSync(RELEASE_SH, "utf8");
    // POSITIVE — the guard now names the empty-string fix explicitly.
    expect(raw).toContain('gitflow.prefix.versiontag ""');
    // NEGATIVE — the dead `${...#v}` strip (cmd_status) must be gone.
    expect(raw).not.toMatch(/\$\{[a-zA-Z_]+#v\}/);
    // NEGATIVE — the old hardcoded 'v' guard/message text must be gone.
    expect(raw).not.toContain('!= "v"');
    expect(raw).not.toContain("expected 'v'");
  });
});
