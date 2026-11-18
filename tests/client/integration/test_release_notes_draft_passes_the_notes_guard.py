"""A `release-notes --format markdown` draft is a section `finish` accepts.

The draft for an UNSHIPPED release — the one a human writes at release step 3,
before `finish` records the ship — is taken from a real, throwaway board
through `python-crucible.py` and committed as the newest section of a
`CHANGELOG.md` in a scratch git repository on `release/9.9.9`, as
`tests/integration/release-notes-guard.test.ts` builds its worlds:

- the extractor, `scripts/release-notes.sh 9.9.9`, prints the section back
  (everything under its heading) and exits 0;
- `scripts/release.sh finish 9.9.9 --dry-run` gets past its notes guard — the
  dated-heading check included — and prints its plan. A recording `git-flow`
  stub is first on PATH and the scratch repo has no remote, so nothing can
  leave the machine; a dry run returns before anything is reported to a board.
"""

import os
import stat
import subprocess
import unittest
from pathlib import Path

from tests.client import release_notes_board as rn

LABEL = "9.9.9"
STALE_VERSION = "9.9.8"
CR = "GUARDED-CHANGE"
TITLE = "A change the notes guard reads"
NOTES_REFUSAL = "no committed, dated release notes"
GIT_IDENTITY = {
    "GIT_AUTHOR_NAME": "release-notes-draft-test",
    "GIT_AUTHOR_EMAIL": "release-notes-draft-test@example.com",
    "GIT_COMMITTER_NAME": "release-notes-draft-test",
    "GIT_COMMITTER_EMAIL": "release-notes-draft-test@example.com",
}

_BOARD = None
_PROJECT = None


def setUpModule():
    global _BOARD, _PROJECT
    _BOARD = rn.start_board("release-notes-guard")
    if _BOARD is None:
        raise unittest.SkipTest(
            "the unshipped release is a property of the REAL store: without "
            "`bun` there is no board to hold it")
    try:
        project = rn.SeededProject(_BOARD, "release-notes-guard")
        project.propose(LABEL)
        project.declare(CR, "as queued", LABEL)
        project.declare("GUARDED-PENDING", "still pending", LABEL)
        project.land(CR, TITLE)
        row = project.history_row(LABEL) or {}
        if row.get("state") != "in progress":
            raise RuntimeError(f"fixture: {LABEL} must be unshipped: {row!r}")
        _PROJECT = project
    except BaseException:
        rn.close_quietly(_BOARD)
        raise


def tearDownModule():
    rn.close_quietly(_BOARD)


class ReleaseNotesDraftPassesTheNotesGuardTest(unittest.TestCase):

    def setUp(self):
        self.root = Path(rn.scratch_dir("release-notes-draft-guard-"))
        self.addCleanup(rn.remove_dir, str(self.root))

    def draft(self):
        assert _PROJECT is not None
        run = rn.run_client("python", _PROJECT.project_dir, "--release", LABEL,
                            "--format", "markdown")
        self.assertEqual(run.returncode, 0,
                         f"the draft is drawn from the board (today the verb "
                         f"does not exist)\n{rn.describe(run)}")
        self.assertTrue(run.stdout.startswith(f"## [{LABEL}] - "),
                        f"the draft opens with the release's heading; got "
                        f"{run.stdout!r}")
        return run.stdout

    def git(self, repo, *argv):
        done = subprocess.run(["git", *argv], cwd=repo, capture_output=True,
                              text=True, timeout=60, check=False,
                              env={**os.environ, **GIT_IDENTITY})
        if done.returncode != 0:
            raise RuntimeError(f"scratch setup: git {' '.join(argv)} failed: "
                               f"{done.stderr}")
        return done.stdout

    def world(self, changelog):
        """A scratch repo on release/9.9.9 whose committed CHANGELOG.md is
        `changelog`, and a PATH whose first entry is a recording git-flow."""
        repo = self.root / "repo"
        bin_dir = self.root / "bin"
        repo.mkdir()
        bin_dir.mkdir()
        flow_log = self.root / "git-flow.log"
        flow_log.write_text("")
        stub = bin_dir / "git-flow"
        stub.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"{flow_log}\"\n"
                        f"exit 0\n")
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
        self.git(repo, "init", "-q")
        self.git(repo, "symbolic-ref", "HEAD", "refs/heads/master")
        (repo / "package.json").write_text(
            '{\n  "name": "demo-pkg",\n  "private": true,\n'
            f'  "version": "{STALE_VERSION}"\n}}\n')
        (repo / "CHANGELOG.md").write_text(changelog)
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-q", "-m", "initial")
        self.git(repo, "checkout", "-q", "-b", f"release/{LABEL}")
        self.git(repo, "config", "gitflow.prefix.versiontag", "")
        path = os.pathsep.join([str(bin_dir), os.environ.get("PATH", "")])
        return repo, path, flow_log

    def test_the_extractor_prints_the_drafted_section_back(self):
        section = self.draft()
        repo, path, _ = self.world("# Changelog\n\n" + section)
        done = subprocess.run(
            [str(rn.REPO_ROOT / "scripts" / "release-notes.sh"), LABEL,
             "CHANGELOG.md"], cwd=repo, capture_output=True, text=True,
            timeout=60, check=False, env={**os.environ, "PATH": path})
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stdout, section.split("\n", 1)[1],
                         "the extractor prints everything under the heading")
        self.assertIn(f"- {TITLE} ({CR})", done.stdout.splitlines())

    def test_a_dry_run_finish_accepts_the_drafted_section(self):
        section = self.draft()
        repo, path, flow_log = self.world("# Changelog\n\n" + section)
        done = subprocess.run(
            [str(rn.REPO_ROOT / "scripts" / "release.sh"), "finish", LABEL,
             "--dry-run"], cwd=repo, capture_output=True, text=True, timeout=120,
            check=False,
            env={**os.environ, **GIT_IDENTITY, "PATH": path,
                 "CRUCIBLE_AGENT": "release-notes-draft-test"})
        self.assertNotIn(NOTES_REFUSAL, done.stderr,
                         "the notes guard accepts the drafted heading")
        self.assertEqual(done.returncode, 0,
                         f"stdout={done.stdout!r} stderr={done.stderr!r}")
        self.assertIn(f'git flow release finish -m "Release {LABEL}" {LABEL}',
                      done.stdout)
        self.assertEqual(flow_log.read_text(), "",
                         "a dry run executes no git-flow finish")


if __name__ == "__main__":
    unittest.main()
