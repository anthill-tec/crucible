"""A client with no board declared still runs every verb that needs no board.

With no `[client] url` in the project's `crucible.toml` or the install's, a
verb that sends nothing never resolves a board, so it works exactly as it did
before: `test`, `lint` and `pre-merge-gate` without `--agent`, and `--help`.
Each exits as its work decides, with ONE envelope that names no `board`, and
no traceback. A board resolved eagerly -- when the client builds its ops, in
the gated run's closing bracket, or in the gate's outcome tail -- would refuse
or crash these runs after their work is done.

── Tier ──────────────────────────────────────────────────────────────────────

PROCESS. The criterion is about a real run of the real client, so each verb is
one subprocess of a real client -- python for `test`, `lint` and `--help`;
arduino for `pre-merge-gate`, the client whose gate runs without `--agent`
(python's requires one) -- run from a SCRATCH FLEET: a copy of
`clients/` under a temp root, whose shipped `crucible.toml` keeps its limits
but declares no `[client]` table, and whose install dir (the temp root) holds
no `crucible.toml` at all. The client takes that temp root as its install dir,
so the operator's root `crucible.toml` is never read. Before any spawn the
scratch fleet's own shared module is asked, in process, which board it would
resolve for the project; a drive is made only when it resolves none, so no
drive can reach any board. The project is a temp dir holding one passing
unittest module and a `[lint]` declared as this interpreter printing a line;
the arduino gate runs the fleet census's fake `arduino-cli` and `make`, first
on a scratch PATH. Four processes in all, built once for the module.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (
    _CLIENT_TABLE,
    _build_fake_bin_dir,
    _load_module,
    _load_toon_module,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
CONFIG_NAME = "crucible.toml"
PROJECT_KEY = "8d6b1e3c-2f4a-4b7e-9c11-0a2b3c4d5e70"

LINT_TABLE = (f'[lint]\ncommand = ["{sys.executable}", "-c", '
              f'"print(\'no-board lint: nothing found\')"]\nname = "no-board-lint"\n')

PROBE_TEST = (
    "import unittest\n\n\n"
    "class ProbeTest(unittest.TestCase):\n"
    "    def test_probe(self):\n"
    "        self.assertTrue(True)\n")

#: Environment a drive must not inherit from the session that launched it.
SCRUBBED_ENV = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
                "WORKFLOW_CYCLE", "CRUCIBLE_URL", "CRUCIBLE_BASE",
                "PY_CRUCIBLE_PYTHON", "AGENT_ID", "CRUCIBLE_STREAM")

#: The drives, by name: the client script and the argv after it; every drive
#: but `--help` has the project dir appended.
DRIVES = {
    "test": ("python-crucible.py", ["test", "--tests", "tests.test_probe"]),
    "lint": ("python-crucible.py", ["lint"]),
    "pre-merge-gate": ("arduino-crucible.py", ["pre-merge-gate"]),
    "--help": ("python-crucible.py", ["--help"]),
}


def _scratch_fleet(root):
    """`clients/` copied under `root`, its shipped `crucible.toml` stripped of
    any `[client]` table. `root` is then the fleet's install dir, and it holds
    no `crucible.toml`."""
    clients = Path(root) / "clients"
    shutil.copytree(CLIENTS_DIR, clients, ignore=shutil.ignore_patterns("__pycache__"))
    shipped = clients / CONFIG_NAME
    shipped.write_text(_CLIENT_TABLE.sub("", shipped.read_text(encoding="utf-8")),
                       encoding="utf-8")
    assert not (Path(root) / CONFIG_NAME).exists()
    return clients


def _project(root):
    project = Path(root) / "project"
    (project / "tests" / "native").mkdir(parents=True)
    (project / ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n"
                                   "CRUCIBLE_PROJECT_NAME=no-board-fixture\n",
                                   encoding="utf-8")
    (project / CONFIG_NAME).write_text(LINT_TABLE, encoding="utf-8")
    (project / "tests" / "__init__.py").write_text("")
    (project / "tests" / "test_probe.py").write_text(PROBE_TEST)
    return project


def _resolves_none(clients, project):
    """None when the scratch fleet's shared module resolves NO board for
    `project`, asked in process; else the reason no drive may be made."""
    axi = _load_module(clients / "_crucible_axi.py", f"no_board_interlock_{id(clients)}")
    axi.bind_project_dir(str(project))
    try:
        resolved = axi.resolve_base_url()
    except Exception:  # noqa: BLE001 -- resolving nothing is the precondition
        return None
    finally:
        axi.bind_project_dir(None)
    return f"the scratch fleet resolves {resolved!r}, so a drive could reach it"


_RESULTS = None


def _drives():
    global _RESULTS
    if _RESULTS is not None:
        return _RESULTS
    root = Path(tempfile.mkdtemp(prefix="no-board-fleet-"))
    fake_bin_dir = _build_fake_bin_dir()
    results = {"blocked": None, "runs": {}}
    try:
        clients = _scratch_fleet(root)
        project = _project(root)
        results["blocked"] = _resolves_none(clients, project)
        if results["blocked"] is None:
            env = {k: v for k, v in os.environ.items() if k not in SCRUBBED_ENV}
            env["GIT_CEILING_DIRECTORIES"] = str(root)
            env["ARDUINO_CLI"] = str(fake_bin_dir / "arduino-cli")
            env["PATH"] = str(fake_bin_dir) + os.pathsep + env.get("PATH", "")
            for name, (script, argv) in DRIVES.items():
                tail = [] if name == "--help" else ["--project-dir", str(project)]
                results["runs"][name] = subprocess.run(
                    [sys.executable, str(clients / script), *argv, *tail],
                    cwd=str(project), env=env, capture_output=True, text=True,
                    timeout=300, check=False)
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _RESULTS = results
    return results


class AVerbThatSendsNothingRunsWithNoBoardDeclaredTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.results = _drives()
        cls.toon = _load_toon_module()

    def run_of(self, name):
        if self.results["blocked"]:
            self.fail(f"`{name}` was not driven: {self.results['blocked']}")
        return self.results["runs"][name]

    def summary(self, result):
        return (f"exit={result.returncode} stdout={result.stdout[-1500:]!r} "
                f"stderr={result.stderr[-1500:]!r}")

    def assert_one_clean_envelope(self, name, verb):
        result = self.run_of(name)
        self.assertNotIn("Traceback", result.stderr, self.summary(result))
        self.assertEqual(result.returncode, 0, self.summary(result))
        self.assertEqual(
            sum(1 for line in result.stdout.splitlines() if line == "axi:"), 1,
            f"exactly one envelope: {self.summary(result)}")
        axi = self.toon.decode(result.stdout)["axi"]
        self.assertEqual(axi.get("verb"), verb)
        self.assertIs(axi.get("ok"), True, self.summary(result))
        context = axi.get("context")
        self.assertIsInstance(context, dict, self.summary(result))
        self.assertEqual(context.get("projectKey"), PROJECT_KEY)
        self.assertNotIn("board", context,
                         f"with no board declared the envelope names none: {context!r}")
        return axi

    def assert_runs_as_today(self, name):
        """A verb that, without `--agent`, answers by its exit code alone:
        the exit the work decides (0 here), no traceback, and at most one
        envelope, which names no `board` if there is one. No request can be
        sent: the drive is made only when the fleet resolves no board."""
        result = self.run_of(name)
        self.assertNotIn("Traceback", result.stderr, self.summary(result))
        self.assertEqual(result.returncode, 0, self.summary(result))
        envelopes = sum(1 for line in result.stdout.splitlines() if line == "axi:")
        self.assertLessEqual(envelopes, 1, f"at most one envelope: {self.summary(result)}")
        if envelopes:
            context = self.toon.decode(result.stdout)["axi"].get("context") or {}
            self.assertNotIn("board", context,
                             f"with no board declared the envelope names none: {context!r}")

    def test_test_without_an_agent_runs_the_suite_and_emits_one_envelope_with_no_board(self):
        """Fails today: the closing bracket builds the ops, which resolve the
        shipped address, and the scratch fleet's shipped data names none."""
        self.assert_runs_as_today("test")

    def test_lint_without_an_agent_runs_the_declared_linter_with_no_board(self):
        """Fails today: `lint` builds the ops, resolving a board, before it
        runs the linter."""
        axi = self.assert_one_clean_envelope("lint", "lint")
        self.assertEqual(axi.get("exit"), 0, f"the declared linter ran clean: {axi!r}")

    def test_pre_merge_gate_without_an_agent_runs_and_ends_in_one_envelope_with_no_board(self):
        """Fails today: the gate's outcome tail builds the ops after the
        suite ran, outside the conversion, and the run ends in a traceback."""
        self.assert_runs_as_today("pre-merge-gate")

    def test_help_prints_usage_with_no_board_declared(self):
        """A pin: help resolves no board."""
        result = self.run_of("--help")
        self.assertEqual(result.returncode, 0, self.summary(result))
        self.assertIn("usage:", result.stdout)
        self.assertNotIn("Traceback", result.stderr, self.summary(result))


if __name__ == "__main__":
    unittest.main()
