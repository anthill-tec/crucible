"""End-to-end integration tests for hermetic runs: real Linux user +
network namespace, real `_crucible_tripwire.py`, real `python-crucible.py` /
`bun-crucible.py` subprocesses, and a real throwaway `RealBoard` (`bun run
src/server.ts` on an OS-assigned free port over a `mkdtemp` store).

Covers AC1 (Python unittest + Bun leak detection & red board record with
`leaks` and failing `tripwire` suite), AC2 (clean hermetic run enforcing empty
`HOME`, scrubbed `XDG_*` and operator registry vars, `DOCKER_HOST`, `allow_env`,
and no external network route), AC4 (`pre-merge-gate --hermetic` running
`[lint]` outside and `[unit-check]` inside the namespace, aborting at
`stage: unit-check` before regression on a tripwire hit), and AC8 (standalone
`clients/_crucible_hermetic.py` CLI clean exit 0, preserved non-zero exit, and
deliberate trip exit 99 with `HIT ... port=3849` in `tripwire.log`).

Every scratch leak probe checks `DOCKER_HOST == "unix:///nonexistent"` before
connecting to `127.0.0.1:3849`, so it can ONLY connect inside an isolated
namespace and never touches the host's operator board.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.integration.test_hermetic_runs_end_to_end
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from tests.client import CLIENT_SOURCE_DIR, client_script
from tests.client.live_run_harness import load_toon, scrubbed_env
from tests.client.real_board import RealBoard

TOON = load_toon()
HERMETIC_CLI = CLIENT_SOURCE_DIR / "_crucible_hermetic.py"
PYTHON_CLIENT = client_script("python-crucible.py")
BUN_CLIENT = client_script("bun-crucible.py")

RUN_TIMEOUT = 120
HIT_3849_RE = re.compile(r"^HIT\s+.*\bport=3849\b", re.MULTILINE)

_BOARD: RealBoard | None = None


def setUpModule():
    global _BOARD
    if sys.platform != "linux":
        raise AssertionError("hermetic-run integration tests require Linux namespaces")
    bun = shutil.which("bun")
    if bun is None:
        raise AssertionError("these integration tests require `bun` to boot RealBoard")
    _BOARD = RealBoard(bun, "hermetic-runs-e2e")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


def _parse_envelope(stdout: str, stderr: str) -> dict:
    text = (stdout or "").strip()
    if not text:
        raise AssertionError(f"expected TOON envelope on stdout; stderr={stderr!r}")
    parsed = TOON.decode(text)
    if isinstance(parsed, dict) and isinstance(parsed.get("axi"), dict):
        return parsed["axi"]
    if isinstance(parsed, dict):
        return parsed
    raise AssertionError(f"unexpected TOON payload: {parsed!r}")


def _find_suite(tree: list, name: str) -> dict | None:
    for node in tree or []:
        if isinstance(node, dict) and node.get("name") == name:
            return node
    return None


def _register_agent(board: RealBoard, agent_id: str) -> None:
    resp = board.http(
        "/api/v2/agents/register",
        {"projectKey": board.key, "agentId": agent_id, "role": "ORCHESTRATOR"},
    )
    if not resp.get("ok"):
        raise AssertionError(f"failed to register {agent_id} on RealBoard: {resp!r}")


def _client_env(outer_home: Path, **extra: str) -> dict[str, str]:
    env = scrubbed_env(
        None,
        HOME=str(outer_home),
        PY_CRUCIBLE_PYTHON=sys.executable,
        PYTHONDONTWRITEBYTECODE="1",
        **extra,
    )
    for key in (
        "CRUCIBLE_STREAM",
        "CRUCIBLE_CURRENT_TEST",
        "CRUCIBLE_CURRENT_TEST_FILE",
        "HERMETIC_EVENTS",
        "HERMETIC_TEST",
        "PYTHONPATH",
        "WORKFLOW_CYCLE_ID",
        "WORKFLOW_CYCLE",
        "WORKFLOW_ROLE",
        "WORKFLOW_WAVE",
    ):
        env.pop(key, None)
    return env


class StandaloneHermeticCliTest(unittest.TestCase):
    """S5 / AC8 — standalone board-free `clients/_crucible_hermetic.py` CLI."""

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="hermetic-standalone-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)

    def _require_cli(self):
        self.assertTrue(
            HERMETIC_CLI.is_file(),
            f"standalone hermetic CLI missing at {HERMETIC_CLI}",
        )

    def test_clean_command_exits_zero_and_writes_clean_tripwire_log(self):
        self._require_cli()
        log_dir = self.scratch / "logs-clean"
        helper = self.scratch / "clean_helper.py"
        helper.write_text(
            textwrap.dedent("""\
                import os
                import sys

                log_dir = os.path.realpath(sys.argv[1])
                home = os.path.realpath(os.environ.get("HOME", ""))
                assert os.environ.get("DOCKER_HOST") == "unix:///nonexistent", os.environ.get("DOCKER_HOST")
                assert home.startswith(log_dir), f"HOME {home!r} not under {log_dir!r}"
                print("HERMETIC_CLEAN_OK")
                """),
            encoding="utf-8",
        )
        result = subprocess.run(
            [
                sys.executable,
                str(HERMETIC_CLI),
                "--log-dir",
                str(log_dir),
                "--port",
                "3849",
                "--",
                sys.executable,
                str(helper),
                str(log_dir),
            ],
            cwd=str(self.scratch),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"clean standalone run must exit 0; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        self.assertIn("HERMETIC_CLEAN_OK", result.stdout)
        tripwire_log = log_dir / "tripwire.log"
        self.assertTrue(tripwire_log.is_file(), f"missing {tripwire_log}")
        log_text = tripwire_log.read_text(encoding="utf-8")
        self.assertIn("tripwire listening ", log_text)
        self.assertIsNone(
            HIT_3849_RE.search(log_text),
            f"clean run must record zero HIT lines: {log_text!r}",
        )

    def test_deliberate_trip_to_port_3849_exits_99_and_logs_hit(self):
        self._require_cli()
        log_dir = self.scratch / "logs-trip"
        probe = self.scratch / "trip_probe.py"
        probe.write_text(
            textwrap.dedent("""\
                import os
                import urllib.error
                import urllib.request

                assert os.environ.get("DOCKER_HOST") == "unix:///nonexistent", (
                    "refusing to probe port 3849 outside hermetic isolation"
                )
                try:
                    urllib.request.urlopen("http://127.0.0.1:3849/hermetic-trip-probe", timeout=5)
                except urllib.error.HTTPError as exc:
                    assert exc.code == 503, f"expected 503 from tripwire, got {exc.code}"
                else:
                    raise AssertionError("tripwire must answer 503, not 200")
                """),
            encoding="utf-8",
        )
        result = subprocess.run(
            [
                sys.executable,
                str(HERMETIC_CLI),
                "--log-dir",
                str(log_dir),
                "--port",
                "3849",
                "--",
                sys.executable,
                str(probe),
            ],
            cwd=str(self.scratch),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            99,
            f"deliberate trip must exit 99; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        tripwire_log = log_dir / "tripwire.log"
        self.assertTrue(tripwire_log.is_file(), f"missing {tripwire_log}")
        log_text = tripwire_log.read_text(encoding="utf-8")
        self.assertRegex(log_text, HIT_3849_RE)
        self.assertIn("/hermetic-trip-probe", log_text)

    def test_clean_nonzero_command_preserves_its_exit_code(self):
        self._require_cli()
        log_dir = self.scratch / "logs-exit7"
        helper = self.scratch / "exit7.py"
        helper.write_text("import sys\nsys.exit(7)\n", encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(HERMETIC_CLI),
                "--log-dir",
                str(log_dir),
                "--port",
                "3849",
                "--",
                sys.executable,
                str(helper),
            ],
            cwd=str(self.scratch),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            7,
            f"clean failing command must preserve exit 7; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        log_text = (log_dir / "tripwire.log").read_text(encoding="utf-8")
        self.assertIsNone(HIT_3849_RE.search(log_text))


class PythonHermeticEndToEndTest(unittest.TestCase):
    """AC1 (Python) and AC2 — real `python-crucible.py unit --hermetic` against
    a real scratch `RealBoard`."""

    def setUp(self):
        if _BOARD is None:
            self.fail("RealBoard was not booted in setUpModule")
        self.board = _BOARD
        self.scratch = Path(tempfile.mkdtemp(prefix="py-hermetic-e2e-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.outer_home = self.scratch / "outer-home"
        self.outer_home.mkdir()
        (self.outer_home / "operator-sentinel.txt").write_text("do-not-see", encoding="utf-8")

    def test_python_unit_hermetic_detects_leak_and_files_red_run_with_test_name(self):
        project = self.scratch / "py-leak-project"
        (project / "tests" / "unit").mkdir(parents=True)
        (project / "tests" / "__init__.py").write_text("", encoding="utf-8")
        (project / "tests" / "unit" / "__init__.py").write_text("", encoding="utf-8")
        (project / "tests" / "unit" / "test_leak.py").write_text(
            textwrap.dedent("""\
                import os
                import unittest
                import urllib.error
                import urllib.request


                class LeakTest(unittest.TestCase):
                    def test_connects_to_default_board(self):
                        self.assertEqual(
                            os.environ.get("DOCKER_HOST"),
                            "unix:///nonexistent",
                            "refusing to probe port 3849 outside hermetic isolation",
                        )
                        try:
                            urllib.request.urlopen(
                                "http://127.0.0.1:3849/api/v2/health", timeout=5
                            )
                        except urllib.error.HTTPError as exc:
                            # Swallow the tripwire's 503 so unittest itself passes:
                            # only the tripwire hit must turn this run red.
                            self.assertEqual(exc.code, 503)
                """),
            encoding="utf-8",
        )
        self.board.install(str(project))
        agent_id = "py-hermetic-leak-agent"
        _register_agent(self.board, agent_id)
        reports_dir = self.scratch / "py-leak-reports"

        result = subprocess.run(
            [
                sys.executable,
                str(PYTHON_CLIENT),
                "unit",
                "--hermetic",
                "--start-dir",
                "tests/unit",
                "--agent",
                agent_id,
                "--project-dir",
                str(project),
                "--reports",
                str(reports_dir),
            ],
            cwd=str(project),
            env=_client_env(self.outer_home),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertNotEqual(
            result.returncode,
            0,
            f"leaking hermetic run must exit non-zero; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        env = _parse_envelope(result.stdout, result.stderr)
        self.assertIs(env.get("ok"), False, f"envelope={env!r}")
        env_leaks = env.get("leaks")
        self.assertIsInstance(env_leaks, list, f"envelope must carry leaks[]: {env!r}")
        assert isinstance(env_leaks, list)
        self.assertTrue(
            any(isinstance(item, dict) and item.get("port") == 3849 for item in env_leaks),
            f"envelope leaks must name port 3849: {env_leaks!r}",
        )

        events = self.board.test_events(agent_id)
        self.assertEqual(len(events), 1, f"expected 1 filed test event, got {events!r}")
        stored = self.board.event(events[0]["id"])
        summary = stored.get("summary") or {}
        self.assertGreaterEqual(summary.get("failed", 0), 1, f"stored run must be red: {stored!r}")

        leaks = stored.get("leaks") or []
        self.assertGreaterEqual(len(leaks), 1, f"stored event must carry leaks: {stored!r}")
        matched = [item for item in leaks if item.get("port") == 3849]
        self.assertGreaterEqual(len(matched), 1, f"expected port=3849 leak: {leaks!r}")
        self.assertIn(
            "test_connects_to_default_board",
            str(matched[0].get("test", "")),
            f"python unittest leak must attribute exact test name: {matched!r}",
        )

        tripwire_suite = _find_suite(stored.get("tree") or [], "tripwire")
        self.assertIsNotNone(
            tripwire_suite,
            f"stored run tree must contain a failing `tripwire` suite: {stored.get('tree')!r}",
        )
        assert tripwire_suite is not None
        self.assertEqual(tripwire_suite.get("status"), "fail")
        children = tripwire_suite.get("children") or []
        self.assertGreaterEqual(len(children), 1)
        self.assertTrue(
            any(
                "3849" in str(child.get("name", ""))
                and "test_connects_to_default_board" in str(child.get("name", ""))
                for child in children
            ),
            f"tripwire suite children must name endpoint and test: {children!r}",
        )

    def test_python_unit_hermetic_clean_run_files_green_and_enforces_isolation(self):
        project = self.scratch / "py-clean-project"
        (project / "tests" / "unit").mkdir(parents=True)
        (project / "tests" / "__init__.py").write_text("", encoding="utf-8")
        (project / "tests" / "unit" / "__init__.py").write_text("", encoding="utf-8")
        (project / "tests" / "unit" / "test_clean.py").write_text(
            textwrap.dedent(f"""\
                import os
                import socket
                import unittest
                from pathlib import Path

                OUTER_HOME = {str(self.outer_home)!r}


                class CleanIsolationTest(unittest.TestCase):
                    def test_environment_and_network_are_isolated(self):
                        home = Path(os.environ["HOME"])
                        self.assertNotEqual(os.path.realpath(home), os.path.realpath(OUTER_HOME))
                        self.assertFalse((home / "operator-sentinel.txt").exists())
                        self.assertEqual(os.environ.get("DOCKER_HOST"), "unix:///nonexistent")
                        for forbidden in (
                            "XDG_CONFIG_HOME",
                            "XDG_DATA_HOME",
                            "XDG_CACHE_HOME",
                            "XDG_STATE_HOME",
                            "CRUCIBLE_PROJECT_KEY",
                            "CRUCIBLE_PROJECT_NAME",
                            "WORKFLOW_ORCHESTRATOR",
                            "SANDESH_PROJECT",
                            "SANDESH_ADDRESS",
                            "PROJECT_TOKEN",
                            "PROJECT_STACKS",
                            "KNOWLEDGE_CATEGORY",
                        ):
                            self.assertNotIn(forbidden, os.environ, f"{{forbidden}} leaked into runner")
                        self.assertEqual(os.environ.get("CUSTOM_ALLOWED_CACHE"), "allowed-val-123")
                        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                            sock.settimeout(2.0)
                            with self.assertRaises(OSError):
                                sock.connect(("192.0.2.1", 80))
                """),
            encoding="utf-8",
        )
        self.board.install(str(project))
        # The project file already carries the shipped `[hermetic]` table, so
        # `allow_env` goes inside it: a second `[hermetic]` header is invalid TOML.
        project_toml = project / "crucible.toml"
        toml_text, replaced = re.subn(
            r"(?m)^\[hermetic\][ \t]*$",
            '[hermetic]\nallow_env = ["CUSTOM_ALLOWED_CACHE"]',
            project_toml.read_text(encoding="utf-8"),
            count=1,
        )
        if replaced != 1:
            raise AssertionError("fixture broken: the project file carries no [hermetic] table")
        project_toml.write_text(toml_text, encoding="utf-8")

        agent_id = "py-hermetic-clean-agent"
        _register_agent(self.board, agent_id)
        reports_dir = self.scratch / "py-clean-reports"

        result = subprocess.run(
            [
                sys.executable,
                str(PYTHON_CLIENT),
                "unit",
                "--hermetic",
                "--start-dir",
                "tests/unit",
                "--agent",
                agent_id,
                "--project-dir",
                str(project),
                "--reports",
                str(reports_dir),
            ],
            cwd=str(project),
            env=_client_env(
                self.outer_home,
                XDG_CONFIG_HOME=str(self.outer_home / "xdg-cfg"),
                XDG_DATA_HOME=str(self.outer_home / "xdg-data"),
                CRUCIBLE_PROJECT_KEY="canary-outer-key",
                SANDESH_ADDRESS="canary-sandesh",
                CUSTOM_ALLOWED_CACHE="allowed-val-123",
            ),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"clean hermetic run must exit 0; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        env = _parse_envelope(result.stdout, result.stderr)
        self.assertIs(env.get("ok"), True, f"envelope={env!r}")
        self.assertIsNone(env.get("leaks"), f"clean run must emit no leaks: {env!r}")

        events = self.board.test_events(agent_id)
        self.assertEqual(len(events), 1, f"expected 1 filed test event, got {events!r}")
        stored = self.board.event(events[0]["id"])
        summary = stored.get("summary") or {}
        self.assertEqual(summary.get("failed"), 0, f"clean run must be green: {stored!r}")
        self.assertGreaterEqual(summary.get("passed", 0), 1)
        self.assertIsNone(stored.get("leaks"), f"clean run must store no leaks: {stored!r}")
        self.assertIsNone(_find_suite(stored.get("tree") or [], "tripwire"))

    def test_python_unit_hermetic_files_leak_from_a_module_that_crashes_at_import(self):
        project = self.scratch / "py-import-leak-project"
        (project / "tests" / "unit").mkdir(parents=True)
        (project / "tests" / "__init__.py").write_text("", encoding="utf-8")
        (project / "tests" / "unit" / "__init__.py").write_text("", encoding="utf-8")
        (project / "tests" / "unit" / "test_import_leak.py").write_text(
            textwrap.dedent("""\
                import os
                import unittest
                import urllib.error
                import urllib.request

                assert os.environ.get("DOCKER_HOST") == "unix:///nonexistent", (
                    "refusing to probe port 3849 outside hermetic isolation"
                )
                try:
                    urllib.request.urlopen("http://127.0.0.1:3849/api/v2/health", timeout=5)
                except urllib.error.HTTPError:
                    pass
                # The runner dies here, before any test runs or is reported.
                os._exit(3)


                class NeverRunsTest(unittest.TestCase):
                    def test_never_runs(self):
                        self.fail("the module crashed at import")
                """),
            encoding="utf-8",
        )
        self.board.install(str(project))
        agent_id = "py-hermetic-import-leak-agent"
        _register_agent(self.board, agent_id)
        reports_dir = self.scratch / "py-import-leak-reports"

        result = subprocess.run(
            [
                sys.executable,
                str(PYTHON_CLIENT),
                "unit",
                "--hermetic",
                "--start-dir",
                "tests/unit",
                "--agent",
                agent_id,
                "--project-dir",
                str(project),
                "--reports",
                str(reports_dir),
            ],
            cwd=str(project),
            env=_client_env(self.outer_home),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertNotEqual(
            result.returncode,
            0,
            f"a crashed leaking run must exit non-zero; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        env = _parse_envelope(result.stdout, result.stderr)
        self.assertIs(env.get("ok"), False, f"envelope={env!r}")

        events = self.board.test_events(agent_id)
        self.assertEqual(len(events), 1, f"expected 1 filed test event, got {events!r}")
        stored = self.board.event(events[0]["id"])
        summary = stored.get("summary") or {}
        self.assertGreaterEqual(summary.get("failed", 0), 1, f"stored run must be red: {stored!r}")
        leaks = stored.get("leaks") or []
        self.assertTrue(
            any(item.get("port") == 3849 for item in leaks),
            f"stored event must carry a leak naming port 3849: {stored!r}",
        )
        tripwire_suite = _find_suite(stored.get("tree") or [], "tripwire")
        self.assertIsNotNone(tripwire_suite, f"missing tripwire suite: {stored.get('tree')!r}")
        assert tripwire_suite is not None
        self.assertEqual(tripwire_suite.get("status"), "fail")


class BunHermeticEndToEndTest(unittest.TestCase):
    """AC1 (Bun) and AC2 — real `bun-crucible.py unit --hermetic` against a real
    scratch `RealBoard`."""

    def setUp(self):
        if _BOARD is None:
            self.fail("RealBoard was not booted in setUpModule")
        self.board = _BOARD
        self.scratch = Path(tempfile.mkdtemp(prefix="bun-hermetic-e2e-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.outer_home = self.scratch / "outer-home"
        self.outer_home.mkdir()

    def _make_bun_project(self, name: str, test_source: str) -> Path:
        project = self.scratch / name
        (project / "tests" / "unit").mkdir(parents=True)
        (project / "package.json").write_text(
            json.dumps(
                {
                    "name": name,
                    "private": True,
                    "scripts": {"test:unit": "bun test tests/unit"},
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        (project / "tests" / "unit" / "probe.test.ts").write_text(
            test_source, encoding="utf-8"
        )
        self.board.install(str(project))
        return project

    def test_bun_unit_hermetic_detects_leak_and_files_red_run(self):
        project = self._make_bun_project(
            "bun-leak-project",
            textwrap.dedent("""\
                import { expect, test } from "bun:test";

                test("bun test leaks to default board port", async () => {
                  expect(process.env.DOCKER_HOST).toBe("unix:///nonexistent");
                  const res = await fetch("http://127.0.0.1:3849/api/v2/health");
                  expect(res.status).toBe(503);
                });
                """),
        )
        agent_id = "bun-hermetic-leak-agent"
        _register_agent(self.board, agent_id)
        reports_dir = self.scratch / "bun-leak-reports"

        result = subprocess.run(
            [
                sys.executable,
                str(BUN_CLIENT),
                "unit",
                "--hermetic",
                "--agent",
                agent_id,
                "--project-dir",
                str(project),
                "--reports",
                str(reports_dir),
            ],
            cwd=str(project),
            env=_client_env(self.outer_home),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertNotEqual(
            result.returncode,
            0,
            f"leaking bun hermetic run must exit non-zero; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        env = _parse_envelope(result.stdout, result.stderr)
        self.assertIs(env.get("ok"), False, f"envelope={env!r}")

        events = self.board.test_events(agent_id)
        self.assertEqual(len(events), 1, f"expected 1 filed bun test event, got {events!r}")
        stored = self.board.event(events[0]["id"])
        summary = stored.get("summary") or {}
        self.assertGreaterEqual(summary.get("failed", 0), 1, f"stored bun run must be red: {stored!r}")

        leaks = stored.get("leaks") or []
        matched = [item for item in leaks if item.get("port") == 3849]
        self.assertGreaterEqual(len(matched), 1, f"expected port=3849 leak: {leaks!r}")
        self.assertTrue(
            str(matched[0].get("cmd", "")).strip(),
            f"bun leak must record non-empty cmd: {matched!r}",
        )
        tripwire_suite = _find_suite(stored.get("tree") or [], "tripwire")
        self.assertIsNotNone(tripwire_suite, f"missing tripwire suite: {stored.get('tree')!r}")
        assert tripwire_suite is not None
        self.assertEqual(tripwire_suite.get("status"), "fail")

    def test_bun_unit_hermetic_clean_run_files_green(self):
        project = self._make_bun_project(
            "bun-clean-project",
            textwrap.dedent(f"""\
                import {{ expect, test }} from "bun:test";

                test("clean isolated bun test", () => {{
                  expect(process.env.DOCKER_HOST).toBe("unix:///nonexistent");
                  expect(process.env.HOME).not.toBe({str(self.outer_home)!r});
                  expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
                  expect(process.env.CRUCIBLE_PROJECT_KEY).toBeUndefined();
                  expect(1 + 1).toBe(2);
                }});
                """),
        )
        agent_id = "bun-hermetic-clean-agent"
        _register_agent(self.board, agent_id)
        reports_dir = self.scratch / "bun-clean-reports"

        result = subprocess.run(
            [
                sys.executable,
                str(BUN_CLIENT),
                "unit",
                "--hermetic",
                "--agent",
                agent_id,
                "--project-dir",
                str(project),
                "--reports",
                str(reports_dir),
            ],
            cwd=str(project),
            env=_client_env(
                self.outer_home,
                XDG_CONFIG_HOME=str(self.outer_home / "xdg"),
                CRUCIBLE_PROJECT_KEY="canary-outer-bun",
            ),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"clean bun hermetic run must exit 0; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        env = _parse_envelope(result.stdout, result.stderr)
        self.assertIs(env.get("ok"), True, f"envelope={env!r}")

        events = self.board.test_events(agent_id)
        self.assertEqual(len(events), 1, f"expected 1 filed bun test event, got {events!r}")
        stored = self.board.event(events[0]["id"])
        summary = stored.get("summary") or {}
        self.assertEqual(summary.get("failed"), 0, f"clean bun run must be green: {stored!r}")
        self.assertGreaterEqual(summary.get("passed", 0), 1)
        self.assertIsNone(stored.get("leaks"))
        self.assertIsNone(_find_suite(stored.get("tree") or [], "tripwire"))

    def test_bun_unit_hermetic_files_leak_when_the_runner_dies_before_any_report(self):
        project = self._make_bun_project(
            "bun-import-leak-project",
            textwrap.dedent("""\
                import { test } from "bun:test";

                if (process.env.DOCKER_HOST !== "unix:///nonexistent") {
                  throw new Error("refusing to probe port 3849 outside hermetic isolation");
                }
                await fetch("http://127.0.0.1:3849/api/v2/health").catch(() => undefined);
                // The runner dies here, before any test runs or any report is written.
                process.exit(3);

                test("never runs", () => {});
                """),
        )
        agent_id = "bun-hermetic-import-leak-agent"
        _register_agent(self.board, agent_id)
        reports_dir = self.scratch / "bun-import-leak-reports"

        result = subprocess.run(
            [
                sys.executable,
                str(BUN_CLIENT),
                "unit",
                "--hermetic",
                "--agent",
                agent_id,
                "--project-dir",
                str(project),
                "--reports",
                str(reports_dir),
            ],
            cwd=str(project),
            env=_client_env(self.outer_home),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertNotEqual(
            result.returncode,
            0,
            f"a crashed leaking bun run must exit non-zero; stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        env = _parse_envelope(result.stdout, result.stderr)
        self.assertIs(env.get("ok"), False, f"envelope={env!r}")

        events = self.board.test_events(agent_id)
        self.assertEqual(len(events), 1, f"expected 1 filed bun test event, got {events!r}")
        stored = self.board.event(events[0]["id"])
        summary = stored.get("summary") or {}
        self.assertGreaterEqual(summary.get("failed", 0), 1, f"stored bun run must be red: {stored!r}")
        leaks = stored.get("leaks") or []
        self.assertTrue(
            any(item.get("port") == 3849 for item in leaks),
            f"stored event must carry a leak naming port 3849: {stored!r}",
        )
        tripwire_suite = _find_suite(stored.get("tree") or [], "tripwire")
        self.assertIsNotNone(tripwire_suite, f"missing tripwire suite: {stored.get('tree')!r}")
        assert tripwire_suite is not None
        self.assertEqual(tripwire_suite.get("status"), "fail")


class PreMergeGateHermeticUnitCheckTest(unittest.TestCase):
    """AC4 — `pre-merge-gate --hermetic` runs `[lint]` outside the namespace
    and `[unit-check]` inside the namespace + tripwire, aborting at
    `stage: unit-check` before regression when `[unit-check]` hits a tripwire."""

    def setUp(self):
        if _BOARD is None:
            self.fail("RealBoard was not booted in setUpModule")
        self.board = _BOARD
        self.scratch = Path(tempfile.mkdtemp(prefix="gate-hermetic-e2e-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.outer_home = self.scratch / "outer-home"
        self.outer_home.mkdir()

    def test_pre_merge_gate_hermetic_aborts_at_unit_check_on_tripwire_hit_before_regression(self):
        project = self.scratch / "gate-project"
        (project / "tests").mkdir(parents=True)
        (project / "tests" / "__init__.py").write_text("", encoding="utf-8")

        lint_marker = self.scratch / "lint-witness.json"
        regression_marker = self.scratch / "regression-ran.txt"

        lint_script = self.scratch / "lint_probe.py"
        lint_script.write_text(
            textwrap.dedent(f"""\
                import json
                import os
                from pathlib import Path

                Path({str(lint_marker)!r}).write_text(
                    json.dumps({{"home": os.environ.get("HOME"), "docker_host": os.environ.get("DOCKER_HOST")}}),
                    encoding="utf-8",
                )
                """),
            encoding="utf-8",
        )

        unit_check_script = self.scratch / "unit_check_leak.py"
        unit_check_script.write_text(
            textwrap.dedent("""\
                import os
                import urllib.error
                import urllib.request

                assert os.environ.get("DOCKER_HOST") == "unix:///nonexistent", (
                    "[unit-check] under pre-merge-gate --hermetic must run inside the namespace"
                )
                try:
                    urllib.request.urlopen("http://127.0.0.1:3849/unit-check-leak-probe", timeout=5)
                except urllib.error.HTTPError as exc:
                    assert exc.code == 503, f"expected 503, got {exc.code}"
                """),
            encoding="utf-8",
        )

        (project / "tests" / "test_canary.py").write_text(
            textwrap.dedent(f"""\
                import unittest
                from pathlib import Path


                class RegressionCanaryTest(unittest.TestCase):
                    def test_should_never_execute(self):
                        Path({str(regression_marker)!r}).write_text("RAN", encoding="utf-8")
                """),
            encoding="utf-8",
        )

        self.board.install(str(project))
        with open(project / "crucible.toml", "a", encoding="utf-8") as fh:
            fh.write(
                "\n[lint]\n"
                f"command = [{json.dumps(sys.executable)}, {json.dumps(str(lint_script))}]\n"
                'name = "probe-lint"\n'
                "\n[unit-check]\n"
                f"command = [{json.dumps(sys.executable)}, {json.dumps(str(unit_check_script))}]\n"
                'name = "probe-unit-check"\n'
            )

        agent_id = "gate-hermetic-unit-check-agent"
        _register_agent(self.board, agent_id)
        reports_dir = self.scratch / "gate-reports"

        result = subprocess.run(
            [
                sys.executable,
                str(PYTHON_CLIENT),
                "pre-merge-gate",
                "--hermetic",
                "--agent",
                agent_id,
                "--project-dir",
                str(project),
                "--reports",
                str(reports_dir),
            ],
            cwd=str(project),
            env=_client_env(self.outer_home),
            capture_output=True,
            text=True,
            timeout=RUN_TIMEOUT,
            check=False,
        )
        self.assertNotEqual(
            result.returncode,
            0,
            f"gate must abort non-zero on unit-check tripwire hit; "
            f"stdout={result.stdout!r} stderr={result.stderr!r}",
        )
        env = _parse_envelope(result.stdout, result.stderr)
        self.assertIs(env.get("ok"), False, f"envelope={env!r}")
        self.assertEqual(env.get("stage"), "unit-check", f"envelope={env!r}")

        warnings = env.get("warnings") or []
        self.assertTrue(
            any(
                isinstance(w, dict) and w.get("code") == "unit-check-gate-abort"
                for w in warnings
            ),
            f"expected unit-check-gate-abort warning: {warnings!r}",
        )
        leaks = env.get("leaks")
        self.assertIsInstance(leaks, list, f"gate abort envelope must carry leaks: {env!r}")
        assert isinstance(leaks, list)
        self.assertTrue(
            any(isinstance(item, dict) and item.get("port") == 3849 for item in leaks),
            f"gate abort leaks must name port 3849: {leaks!r}",
        )

        # `[lint]` ran OUTSIDE the namespace.
        self.assertTrue(lint_marker.is_file(), "lint stage should have run before unit-check")
        lint_seen = json.loads(lint_marker.read_text(encoding="utf-8"))
        self.assertEqual(
            os.path.realpath(lint_seen["home"]),
            os.path.realpath(self.outer_home),
            f"[lint] must run outside namespace (same HOME): {lint_seen!r}",
        )
        self.assertNotEqual(
            lint_seen.get("docker_host"),
            "unix:///nonexistent",
            f"[lint] must run outside namespace: {lint_seen!r}",
        )

        # Regression NEVER ran and filed no test event.
        self.assertFalse(
            regression_marker.exists(),
            "regression suite must NEVER run after a unit-check tripwire abort",
        )
        self.assertEqual(
            self.board.test_events(agent_id),
            [],
            "aborted gate must file no regression test run on the board",
        )


if __name__ == "__main__":
    unittest.main()
