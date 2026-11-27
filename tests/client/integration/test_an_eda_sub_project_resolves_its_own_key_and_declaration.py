"""An eda run's project dir is the eda sub-project, and its key and its
declaration are that dir's own.

The project dir is, in this order: `--project-dir` > `$EDA_CRUCIBLE_PROJECT_DIR`
> the git repo of the working directory > the working directory. The key is
`CRUCIBLE_PROJECT_KEY` in `<project-dir>/.env` only -- never a parent's -- and
a missing key is refused the fleet's way, naming `<project-dir>/.env`, before
anything is posted. The declaration is `<project-dir>/crucible.toml`.

The fixture's `hardware/` sub-project carries its own `crucible.toml` and no
`.env`. Which dir the client resolved is read from what it refuses: each
winning candidate holds no key, so the refusal names ITS `.env`, while every
losing candidate holds a key (a client that chose a loser would not refuse
for a key at all).

Every test drives the REAL client as an OS subprocess, handed a recording
interpreter that imports pytest, against a `RecordingBoard`.

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_an_eda_sub_project_resolves_its_own_key_and_declaration
"""

import os
import shutil
import subprocess
import unittest

from tests.client.eda_project_harness import (
    DECLARATION_REFUSED_CODE,
    FIXTURE,
    FRAMEWORK,
    PROJECT_DIR_VAR,
    TIER_RUN_UNDECLARED_CODE,
    EdaProject,
    RecordingInterpreter,
    diagnostics,
    envelope,
    said,
    scratch,
)


class _SubProject(unittest.TestCase):

    maxDiff = 4000

    @classmethod
    def setUpClass(cls):
        root = scratch(cls, "eda-sub-project-python-")
        cls.python = RecordingInterpreter(os.path.join(root, "bin", "eda-python"))

    def setUp(self):
        if os.path.exists(self.python.log):
            os.remove(self.python.log)

    def assert_key_refused(self, project, result, env_path, why, not_named=()):
        """Refused for a missing key, naming `env_path`, before any post."""
        where = f"{why}; {diagnostics(result)}"
        self.assertNotEqual(result.returncode, 0, f"the run is refused; {where}")
        output = result.stdout + result.stderr
        self.assertIn("CRUCIBLE_PROJECT_KEY", output, where)
        self.assertIn(env_path, output, f"the refusal names {env_path}; {where}")
        for other in not_named:
            self.assertNotIn(other, output, f"the refusal does not name {other}; {where}")
        self.assertEqual(project.posts(), [], f"nothing is posted; {where}")
        self.assertEqual(self.python.pytest_calls(), [], f"no pytest runs; {where}")


class TheHardwareSubProjectIsItsOwnProjectTest(_SubProject):

    def setUp(self):
        super().setUp()
        # The ROOT copy holds a key; the sub-project names the same board.
        self.project = EdaProject(self, key=True)
        self.hardware = self.project.path("hardware")
        self.project.point_at_board(self.hardware)

    def test_a_sub_project_with_no_key_is_refused_naming_its_own_env_even_beside_a_keyed_parent(self):
        result = self.project.drive("unit", project_dir=self.hardware,
                                    python=self.python.path)
        self.assert_key_refused(
            self.project, result, os.path.join(self.hardware, ".env"),
            "hardware/.env is absent, the parent's .env holds a key",
            not_named=(os.path.join(self.project.dir, ".env"),))

    def test_a_sub_project_with_a_key_reads_its_own_crucible_toml(self):
        self.project.write_key(self.hardware)
        hardware_toml = os.path.join(self.hardware, "crucible.toml")
        self.project.declare(f'[targets."unit/ghost"]\nframework = "{FRAMEWORK}"\n'
                             'paths = ["tests/ghost"]\n', project_dir=self.hardware)
        result = self.project.drive("unit", project_dir=self.hardware,
                                    python=self.python.path)
        where = diagnostics(result)
        self.assertNotEqual(result.returncode, 0, where)
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        self.assertIs((axi or {}).get("ok"), False, where)
        words = said(axi)
        self.assertIn(DECLARATION_REFUSED_CODE, result.stderr, where)
        for name in ('[targets."unit/ghost"]', "paths", hardware_toml):
            self.assertIn(name, words, f"the refusal names {name!r}; {where}")
        self.assertNotIn(self.project.toml, words.replace(hardware_toml, ""),
                         f"the root's crucible.toml is not the one read; {where}")
        self.assertEqual(self.project.run_route_posts(), [], f"no run is opened; {where}")

    def test_a_sub_project_does_not_inherit_its_parents_entries(self):
        self.project.write_key(self.hardware)
        # The ROOT declares a module entry; the sub-project declares none.
        self.project.declare(f'[targets."module"]\nframework = "{FRAMEWORK}"\n'
                             'paths = ["tests/unit"]\n')
        result = self.project.drive("module", project_dir=self.hardware,
                                    python=self.python.path)
        where = diagnostics(result)
        self.assertNotEqual(result.returncode, 0, where)
        axi = envelope(result.stdout)
        self.assertIsNotNone(axi, f"one TOON envelope on stdout; {where}")
        self.assertIs((axi or {}).get("ok"), False, where)
        self.assertIn("no module target is declared", str((axi or {}).get("error")), where)
        self.assertIn(TIER_RUN_UNDECLARED_CODE, result.stderr, where)
        self.assertEqual(self.project.run_route_posts(), [], f"no run is opened; {where}")
        self.assertEqual(self.python.pytest_calls(), [], f"no pytest runs; {where}")


class TheProjectDirIsResolvedInOrderTest(_SubProject):
    """Each candidate dir is a full copy of the fixture naming the board; the
    winner holds no key, every loser holds one."""

    def setUp(self):
        super().setUp()
        self.project = EdaProject(self, key=False)
        self.root = scratch(self, "eda-project-dirs-")

    def candidate(self, name, key):
        path = os.path.join(self.root, name)
        shutil.copytree(FIXTURE, path)
        self.project.point_at_board(path)
        if key:
            self.project.write_key(path)
        return path

    def git_repo(self, path):
        done = subprocess.run(["git", "init", "-q", path], capture_output=True,
                              text=True, timeout=60, check=False,
                              env=self.project.env())
        self.assertEqual(done.returncode, 0, f"git init: {done.stderr!r}")

    def test_the_flag_wins_over_the_environment_variable(self):
        flagged = self.candidate("flagged", key=False)
        from_env = self.candidate("from-env", key=True)
        result = self.project.drive(
            "unit", project_dir=flagged, python=self.python.path,
            env=self.project.env(**{PROJECT_DIR_VAR: from_env}))
        self.assert_key_refused(self.project, result, os.path.join(flagged, ".env"),
                                "--project-dir beside EDA_CRUCIBLE_PROJECT_DIR")

    def test_the_environment_variable_wins_over_the_working_directorys_git_repo(self):
        from_env = self.candidate("from-env", key=False)
        repo = self.candidate("repo", key=True)
        self.git_repo(repo)
        result = self.project.drive(
            "unit", project_dir=False, python=self.python.path,
            cwd=os.path.join(repo, "tests", "unit"),
            env=self.project.env(**{PROJECT_DIR_VAR: from_env}))
        self.assert_key_refused(self.project, result, os.path.join(from_env, ".env"),
                                "EDA_CRUCIBLE_PROJECT_DIR, standing inside a git repo")

    def test_the_working_directorys_git_repo_wins_over_the_working_directory(self):
        repo = self.candidate("repo", key=False)
        self.git_repo(repo)
        cwd = os.path.join(repo, "tests", "unit")
        self.project.write_key(cwd)
        result = self.project.drive("unit", project_dir=False, python=self.python.path,
                                    cwd=cwd)
        self.assert_key_refused(self.project, result, os.path.join(repo, ".env"),
                                "no flag or variable, standing in a git repo's subdir",
                                not_named=(os.path.join(cwd, ".env"),))

    def test_the_working_directory_is_the_project_dir_outside_any_git_repo(self):
        plain = self.candidate("plain", key=False)
        env = self.project.env(GIT_CEILING_DIRECTORIES=self.root)
        result = self.project.drive("unit", project_dir=False, python=self.python.path,
                                    cwd=plain, env=env)
        self.assert_key_refused(self.project, result, os.path.join(plain, ".env"),
                                "no flag, no variable, no git repo")


if __name__ == "__main__":
    unittest.main()
