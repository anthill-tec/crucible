"""Unit tests for hermetic runs: config parsing, tripwire endpoint
union, isolated environment scrubbing, availability preflight refusals, uniform
`--hermetic` CLI surface across all six clients, gate sibling dispatch, Maven
`--with-docker --hermetic` refusal, and fleet registration / script retirement.

Pure unit tier: zero real subprocesses, zero sockets, zero sleeps.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.unit.test_hermetic_runs
"""

# pi-lens-ignore: I001 — pi-lens ruff has no target-version, filing stdlib `tomllib` as third-party
import argparse  # noqa: I001
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import typing
import unittest
from pathlib import Path
from unittest import mock

from crucible_axi import install as crucible_install
from tests.client import CLIENT_SOURCE_DIR
from tests.client.live_run_harness import load_client, load_toon

REPO_ROOT = Path(__file__).resolve().parents[3]
TOON = load_toon()

CLIENT_SCRIPTS = (
    "python-crucible.py",
    "bun-crucible.py",
    "rust-crucible.py",
    "mvn-crucible.py",
    "arduino-crucible.py",
    "go-crucible.py",
)

HERMETIC_VERBS = (
    "unit",
    "module",
    "integration",
    "e2e",
    "regression",
    "bdd",
    "test",
    "pre-merge-gate",
)

XDG_VARS = (
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
)

OPERATOR_REGISTRY_VARS = (
    "CRUCIBLE_PROJECT_KEY",
    "CRUCIBLE_PROJECT_NAME",
    "WORKFLOW_ORCHESTRATOR",
    "SANDESH_PROJECT",
    "SANDESH_ADDRESS",
    "PROJECT_TOKEN",
    "PROJECT_STACKS",
    "KNOWLEDGE_CATEGORY",
)

STANDARD_TOOLCHAIN_VARS = (
    "PLAYWRIGHT_BROWSERS_PATH",
    "RUSTUP_HOME",
    "CARGO_HOME",
    "ARDUINO_DIRECTORIES_DATA",
    "GOROOT",
    "GOPATH",
    "GOMODCACHE",
    "GOCACHE",
)


class _CapturedParser(Exception):
    """Sentinel raised inside a mocked `ArgumentParser.parse_args` to return
    the real client parser without running any verb handler."""

    def __init__(self, parser):
        self.parser = parser
        super().__init__("captured parser")


def _capture_client_parser(script_name):
    """Load `clients/<script_name>` and capture its real root ArgumentParser
    without invoking any subcommand or spawning any process."""
    client = load_client(script_name)

    def _intercept(self, *_args, **_kwargs):
        raise _CapturedParser(self)

    with (
        mock.patch.object(sys, "argv", [script_name, "test"]),
        mock.patch.object(argparse.ArgumentParser, "parse_args", _intercept),
    ):
        try:
            client.main()
        except _CapturedParser as captured:
            return captured.parser
    raise AssertionError(f"{script_name}.main() never called ArgumentParser.parse_args")


def _normalize_endpoint(endpoint):
    """Normalize either a `(host, port)` tuple or a `'host:port'` / `'[::1]:port'`
    string into `(host, int_port)`."""
    if isinstance(endpoint, tuple) and len(endpoint) == 2:
        host, port = endpoint
        return str(host), int(port)
    if isinstance(endpoint, str):
        if endpoint.startswith("[") and "]:" in endpoint:
            host, port_s = endpoint[1:].rsplit("]:", 1)
            return host, int(port_s)
        if ":" in endpoint:
            host, port_s = endpoint.rsplit(":", 1)
            return host, int(port_s)
    raise AssertionError(f"unexpected endpoint representation: {endpoint!r}")


class _HermeticTestCase(unittest.TestCase):
    """Shared base class to load `_crucible_axi.py` and fetch required hermetic
    exports with clear RED failure messages when not yet implemented."""

    def _axi(self) -> typing.Any:
        return load_client("_crucible_axi.py")

    def _require_export(self, axi: typing.Any, name: str) -> typing.Any:
        value = getattr(axi, name, None)
        if value is None:
            self.fail(
                f"clients/_crucible_axi.py must load and re-export `{name}` from "
                f"`clients/_crucible_hermetic.py`"
            )
        return value


class HermeticContractAndConfigTest(_HermeticTestCase):
    """S2 / AC5 — constants, `add_hermetic_arg`, shipped `default_board_port`,
    and `[hermetic]` parsing & refusal."""

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="hermetic-config-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.project_dir = self.scratch / "project"
        self.install_dir = self.scratch / "install"
        self.project_dir.mkdir()
        self.install_dir.mkdir()

    def _write_toml(self, directory, content):
        path = directory / "crucible.toml"
        path.write_text(content, encoding="utf-8")
        return path

    def test_shipped_crucible_toml_declares_default_board_port_3849(self):
        shipped = CLIENT_SOURCE_DIR / "crucible.toml"
        data = tomllib.loads(shipped.read_text(encoding="utf-8"))
        hermetic = data.get("hermetic")
        if not isinstance(hermetic, dict):
            self.fail("clients/crucible.toml must declare a [hermetic] table")
        port = hermetic.get("default_board_port")
        self.assertIsNot(type(port), bool, "default_board_port must be an int, not bool")
        self.assertEqual(port, 3849)

    def test_public_constants_and_add_hermetic_arg(self):
        axi = self._axi()
        self.assertEqual(self._require_export(axi, "HERMETIC_TABLE"), "hermetic")
        self.assertEqual(self._require_export(axi, "HERMETIC_FLAG"), "--hermetic")
        add_hermetic_arg = self._require_export(axi, "add_hermetic_arg")
        parser = argparse.ArgumentParser(prog="probe")
        add_hermetic_arg(parser)
        self.assertIs(parser.parse_args([]).hermetic, False)
        self.assertIs(parser.parse_args(["--hermetic"]).hermetic, True)

    def test_resolve_hermetic_config_valid_project_table(self):
        axi = self._axi()
        resolve = self._require_export(axi, "resolve_hermetic_config")
        self._write_toml(
            self.install_dir,
            "[hermetic]\ndefault_board_port = 3849\n",
        )
        self._write_toml(
            self.project_dir,
            '[hermetic]\n'
            'tripwires = [5432, "127.0.0.1:6379", "[::1]:6380"]\n'
            'allow_env = ["CUSTOM_CACHE", "EXTRA_TOOL_DIR"]\n',
        )
        cfg = resolve(project_dir=str(self.project_dir), install_dir=str(self.install_dir))
        self.assertEqual(cfg["tripwires"], [5432, "127.0.0.1:6379", "[::1]:6380"])
        self.assertEqual(cfg["allow_env"], ["CUSTOM_CACHE", "EXTRA_TOOL_DIR"])
        self.assertEqual(cfg["default_board_port"], 3849)

    def test_resolve_hermetic_config_project_precedence_and_install_fallback(self):
        axi = self._axi()
        resolve = self._require_export(axi, "resolve_hermetic_config")
        self._write_toml(
            self.install_dir,
            '[hermetic]\n'
            'default_board_port = 3849\n'
            'tripwires = [9001]\n'
            'allow_env = ["FROM_INSTALL"]\n',
        )
        # No project crucible.toml -> falls back to install crucible.toml.
        fallback = resolve(project_dir=str(self.project_dir), install_dir=str(self.install_dir))
        self.assertEqual(fallback["tripwires"], [9001])
        self.assertEqual(fallback["allow_env"], ["FROM_INSTALL"])
        self.assertEqual(fallback["default_board_port"], 3849)

        # Project crucible.toml declares its own [hermetic] -> project wins.
        self._write_toml(
            self.project_dir,
            '[hermetic]\n'
            'tripwires = [5432]\n'
            'allow_env = ["FROM_PROJECT"]\n',
        )
        project_cfg = resolve(
            project_dir=str(self.project_dir), install_dir=str(self.install_dir)
        )
        self.assertEqual(project_cfg["tripwires"], [5432])
        self.assertEqual(project_cfg["allow_env"], ["FROM_PROJECT"])
        self.assertEqual(project_cfg["default_board_port"], 3849)

    def test_resolve_hermetic_config_defaults_from_shipped_data_when_dirs_omit_table(self):
        axi = self._axi()
        resolve = self._require_export(axi, "resolve_hermetic_config")
        cfg = resolve(project_dir=str(self.project_dir), install_dir=str(self.install_dir))
        self.assertEqual(cfg["tripwires"], [])
        self.assertEqual(cfg["allow_env"], [])
        self.assertEqual(cfg["default_board_port"], 3849)

    def test_resolve_hermetic_config_refuses_malformed_declarations_naming_file_and_field(self):
        axi = self._axi()
        resolve = self._require_export(axi, "resolve_hermetic_config")
        refused_cls = self._require_export(axi, "HermeticRefused")
        self._write_toml(self.install_dir, "[hermetic]\ndefault_board_port = 3849\n")

        bad_cases = [
            ("tripwires_not_list", 'tripwires = "5432"\n', "tripwires"),
            ("tripwires_port_zero", "tripwires = [0]\n", "tripwires"),
            ("tripwires_port_overflow", "tripwires = [70000]\n", "tripwires"),
            ("tripwires_bool_port", "tripwires = [true]\n", "tripwires"),
            ("tripwires_bad_string", 'tripwires = ["not-a-host-port"]\n', "tripwires"),
            ("tripwires_string_port_overflow", 'tripwires = ["127.0.0.1:70000"]\n', "tripwires"),
            ("allow_env_not_list", 'allow_env = "CUSTOM_CACHE"\n', "allow_env"),
            ("allow_env_empty_entry", 'allow_env = [""]\n', "allow_env"),
            ("allow_env_non_string", "allow_env = [123]\n", "allow_env"),
            ("default_board_port_zero", "default_board_port = 0\n", "default_board_port"),
            ("default_board_port_overflow", "default_board_port = 70000\n", "default_board_port"),
            ("default_board_port_bool", "default_board_port = true\n", "default_board_port"),
        ]
        for label, body, expected_field in bad_cases:
            with self.subTest(case=label):
                toml_path = self._write_toml(self.project_dir, f"[hermetic]\n{body}")
                with self.assertRaises(refused_cls) as ctx:
                    resolve(
                        project_dir=str(self.project_dir),
                        install_dir=str(self.install_dir),
                    )
                exc = ctx.exception
                detail = getattr(exc, "detail", str(exc))
                self.assertIn("crucible.toml", detail)
                self.assertIn(expected_field, detail)
                self.assertTrue(
                    str(toml_path) in detail or toml_path.name in detail,
                    f"refusal detail must name {toml_path}: {detail!r}",
                )
                self.assertTrue(getattr(exc, "code", None), "HermeticRefused must set .code")
                self.assertIsInstance(getattr(exc, "help", None), list)
                self.assertGreater(len(exc.help), 0)


class TripwireEndpointUnionTest(_HermeticTestCase):
    """S2 / AC5 / Ruling Q3 — deduplicated union of project board port, install
    board port, shipped default_board_port, and `[hermetic] tripwires`."""

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="hermetic-endpoints-"))
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.project_dir = self.scratch / "project"
        self.install_dir = self.scratch / "install"
        self.project_dir.mkdir()
        self.install_dir.mkdir()

    def test_union_of_project_install_shipped_and_extra_tripwires_is_deduplicated(self):
        axi = self._axi()
        resolve_endpoints = self._require_export(axi, "resolve_tripwire_endpoints")
        (self.install_dir / "crucible.toml").write_text(
            '[client]\nurl = "http://127.0.0.1:3849"\n'
            "[hermetic]\ndefault_board_port = 3849\n",
            encoding="utf-8",
        )
        (self.project_dir / "crucible.toml").write_text(
            '[client]\nurl = "http://127.0.0.1:3850"\n'
            '[hermetic]\ntripwires = [5432, 3850, "127.0.0.1:6379"]\n',
            encoding="utf-8",
        )
        raw = resolve_endpoints(
            project_dir=str(self.project_dir), install_dir=str(self.install_dir)
        )
        normalized = [_normalize_endpoint(ep) for ep in raw]
        self.assertEqual(
            len(normalized),
            len(set(normalized)),
            f"endpoints must be deduplicated, got: {raw!r}",
        )
        expected = {
            ("127.0.0.1", 3849),
            ("::1", 3849),
            ("127.0.0.1", 3850),
            ("::1", 3850),
            ("127.0.0.1", 5432),
            ("::1", 5432),
            ("127.0.0.1", 6379),
        }
        self.assertEqual(set(normalized), expected)
        self.assertNotIn(("::1", 6379), set(normalized))

    def test_distinct_install_board_port_is_included_in_union(self):
        axi = self._axi()
        resolve_endpoints = self._require_export(axi, "resolve_tripwire_endpoints")
        (self.install_dir / "crucible.toml").write_text(
            '[client]\nurl = "http://127.0.0.1:3851"\n'
            "[hermetic]\ndefault_board_port = 3849\n",
            encoding="utf-8",
        )
        (self.project_dir / "crucible.toml").write_text(
            '[client]\nurl = "http://127.0.0.1:3850"\n',
            encoding="utf-8",
        )
        raw = resolve_endpoints(
            project_dir=str(self.project_dir), install_dir=str(self.install_dir)
        )
        normalized = {_normalize_endpoint(ep) for ep in raw}
        self.assertEqual(
            normalized,
            {
                ("127.0.0.1", 3849),
                ("::1", 3849),
                ("127.0.0.1", 3850),
                ("::1", 3850),
                ("127.0.0.1", 3851),
                ("::1", 3851),
            },
        )

    def test_shipped_default_board_port_included_when_no_client_url_declared(self):
        axi = self._axi()
        resolve_endpoints = self._require_export(axi, "resolve_tripwire_endpoints")
        raw = resolve_endpoints(
            project_dir=str(self.project_dir), install_dir=str(self.install_dir)
        )
        normalized = {_normalize_endpoint(ep) for ep in raw}
        self.assertEqual(normalized, {("127.0.0.1", 3849), ("::1", 3849)})

    def test_ipv6_bracketed_tripwire_binds_only_that_socket(self):
        axi = self._axi()
        resolve_endpoints = self._require_export(axi, "resolve_tripwire_endpoints")
        (self.project_dir / "crucible.toml").write_text(
            '[hermetic]\ntripwires = ["[::1]:6380"]\n',
            encoding="utf-8",
        )
        raw = resolve_endpoints(
            project_dir=str(self.project_dir), install_dir=str(self.install_dir)
        )
        normalized = {_normalize_endpoint(ep) for ep in raw}
        self.assertIn(("::1", 6380), normalized)
        self.assertNotIn(("127.0.0.1", 6380), normalized)


class IsolatedEnvScrubbingTest(_HermeticTestCase):
    """S1 / AC2 / AC5 — `build_isolated_env` scrubs operator vars, redirects
    HOME, neutralises DOCKER_HOST, preserves toolchain vars & allow_env, and
    sets `CRUCIBLE_CURRENT_TEST_FILE`."""

    def test_build_isolated_env_scrubs_xdg_and_registry_and_preserves_allow_and_toolchains(self):
        axi = self._axi()
        build_env = self._require_export(axi, "build_isolated_env")
        base_env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": "/home/operator",
            "DOCKER_HOST": "unix:///var/run/docker.sock",
            "CUSTOM_CACHE": "/opt/my-cache",
        }
        for key in XDG_VARS:
            base_env[key] = f"/home/operator/.{key.lower()}"
        for key in OPERATOR_REGISTRY_VARS:
            base_env[key] = f"secret-{key}"
        for key in STANDARD_TOOLCHAIN_VARS:
            base_env[key] = f"/toolchain/{key.lower()}"
        snapshot = dict(base_env)

        iso_home = "/var/empty/isolated-home"
        cur_test = "/var/empty/current-test.txt"
        result = build_env(
            base_env,
            iso_home,
            allow_env=("CUSTOM_CACHE", "ABSENT_ALLOWED_VAR"),
            current_test_file=cur_test,
        )

        self.assertEqual(base_env, snapshot, "build_isolated_env must not mutate caller env")
        self.assertEqual(result["HOME"], iso_home)
        self.assertEqual(result["DOCKER_HOST"], "unix:///nonexistent")
        self.assertEqual(result["CRUCIBLE_CURRENT_TEST_FILE"], cur_test)
        for key in XDG_VARS:
            self.assertNotIn(key, result, f"{key} must be scrubbed")
        for key in OPERATOR_REGISTRY_VARS:
            self.assertNotIn(key, result, f"{key} must be scrubbed")
        for key in STANDARD_TOOLCHAIN_VARS:
            self.assertEqual(
                result.get(key),
                f"/toolchain/{key.lower()}",
                f"standard toolchain var {key} must be preserved",
            )
        self.assertEqual(result.get("CUSTOM_CACHE"), "/opt/my-cache")
        self.assertNotIn("ABSENT_ALLOWED_VAR", result)

    def test_build_isolated_env_omits_current_test_file_when_none(self):
        axi = self._axi()
        build_env = self._require_export(axi, "build_isolated_env")
        base_env = {
            "PATH": "/usr/bin:/bin",
            "HOME": "/home/operator",
            "CRUCIBLE_CURRENT_TEST_FILE": "/stale/file.txt",
        }
        result = build_env(base_env, "/var/empty/isolated-home")
        self.assertNotIn("CRUCIBLE_CURRENT_TEST_FILE", result)


class HermeticAvailabilityCheckTest(_HermeticTestCase):
    """S4 / AC3 — `check_hermetic_available` refuses non-Linux platforms,
    missing tools, and kernel userns restrictions with actionable help."""

    def test_refuses_non_linux_platform_without_probing_tools_or_kernel(self):
        axi = self._axi()
        check = self._require_export(axi, "check_hermetic_available")
        refused_cls = self._require_export(axi, "HermeticRefused")
        with (
            mock.patch.object(sys, "platform", "darwin"),
            mock.patch("shutil.which") as mock_which,
            mock.patch("subprocess.run") as mock_run,
            self.assertRaises(refused_cls) as ctx,
        ):
            check()
        exc = ctx.exception
        detail = getattr(exc, "detail", str(exc))
        self.assertIn("linux", detail.lower())
        self.assertTrue(getattr(exc, "code", None))
        self.assertIsInstance(getattr(exc, "help", None), list)
        self.assertGreater(len(exc.help), 0)
        mock_which.assert_not_called()
        mock_run.assert_not_called()

    def test_refuses_each_missing_required_tool_without_running_probe(self):
        axi = self._axi()
        check = self._require_export(axi, "check_hermetic_available")
        refused_cls = self._require_export(axi, "HermeticRefused")
        for missing in ("unshare", "setpriv", "ip"):
            with self.subTest(missing_tool=missing):
                with (
                    mock.patch.object(sys, "platform", "linux"),
                    mock.patch(
                        "shutil.which",
                        side_effect=lambda tool, m=missing: None if tool == m else f"/usr/bin/{tool}",
                    ),
                    mock.patch("subprocess.run") as mock_run,
                    self.assertRaises(refused_cls) as ctx,
                ):
                    check()
                exc = ctx.exception
                detail = getattr(exc, "detail", str(exc))
                self.assertIn(missing, detail)
                self.assertIsInstance(getattr(exc, "help", None), list)
                self.assertGreater(len(exc.help), 0)
                mock_run.assert_not_called()

    def test_refuses_kernel_userns_failure_with_apparmor_sysctl_hint(self):
        axi = self._axi()
        check = self._require_export(axi, "check_hermetic_available")
        refused_cls = self._require_export(axi, "HermeticRefused")
        failed = subprocess.CompletedProcess(
            args=["unshare", "--map-current-user", "--keep-caps", "-n", "true"],
            returncode=1,
            stdout="",
            stderr="unshare: unshare failed: Operation not permitted\n",
        )
        with (
            mock.patch.object(sys, "platform", "linux"),
            mock.patch("shutil.which", side_effect=lambda tool: f"/usr/bin/{tool}"),
            mock.patch("subprocess.run", return_value=failed) as mock_run,
            self.assertRaises(refused_cls) as ctx,
        ):
            check()
        exc = ctx.exception
        mock_run.assert_called_once()
        probe_argv = mock_run.call_args.args[0]
        self.assertIn("unshare", os.path.basename(probe_argv[0]))
        self.assertIn("--map-current-user", probe_argv)
        self.assertIn("--keep-caps", probe_argv)
        self.assertIn("-n", probe_argv)
        self.assertIn("true", probe_argv)
        help_joined = "\n".join(getattr(exc, "help", []) or [])
        self.assertIn("kernel.apparmor_restrict_unprivileged_userns=0", help_joined)
        detail = getattr(exc, "detail", str(exc))
        self.assertIn("Operation not permitted", detail)

    def test_succeeds_on_linux_when_tools_and_userns_probe_pass(self):
        axi = self._axi()
        check = self._require_export(axi, "check_hermetic_available")
        passed = subprocess.CompletedProcess(
            args=["unshare", "--map-current-user", "--keep-caps", "-n", "true"],
            returncode=0,
            stdout="",
            stderr="",
        )
        with (
            mock.patch.object(sys, "platform", "linux"),
            mock.patch("shutil.which", side_effect=lambda tool: f"/usr/bin/{tool}"),
            mock.patch("subprocess.run", return_value=passed) as mock_run,
        ):
            check()
        mock_run.assert_called_once()


class ClientHermeticCliAndGateSurfaceTest(_HermeticTestCase):
    """S1 / AC4 — `--hermetic` flag across all 6 clients × 8 verbs, gate
    `sibling_client_argv` propagation, and Maven `--with-docker --hermetic`
    refusal before Docker starts."""

    def test_all_six_clients_accept_hermetic_on_all_six_tiers_test_and_pre_merge_gate(self):
        for script in CLIENT_SCRIPTS:
            parser = _capture_client_parser(script)
            for verb in HERMETIC_VERBS:
                with self.subTest(client=script, verb=verb):
                    base_argv = [verb]
                    if verb in ("pre-merge-gate", "regression"):
                        base_argv += ["--agent", "probe-agent"]
                    if script == "rust-crucible.py" and verb == "test":
                        base_argv += ["--crate", "probe-crate"]
                    ns_default = parser.parse_args(base_argv)
                    self.assertIs(
                        getattr(ns_default, "hermetic", None),
                        False,
                        f"{script} {verb} must default args.hermetic to False",
                    )
                    err = io.StringIO()
                    try:
                        with contextlib.redirect_stderr(err):
                            ns_hermetic = parser.parse_args([*base_argv, "--hermetic"])
                    except SystemExit as exc:
                        self.fail(
                            f"{script} {verb} rejected --hermetic (exit={exc.code}): "
                            f"{err.getvalue().strip()}"
                        )
                    self.assertIs(
                        getattr(ns_hermetic, "hermetic", None),
                        True,
                        f"{script} {verb} --hermetic must parse args.hermetic to True",
                    )

    def test_sibling_client_argv_propagates_hermetic_only_when_requested(self):
        axi = self._axi()
        # Translated python command
        argv_on = axi.sibling_client_argv(
            "python",
            "python3 -m unittest discover -s tests/unit",
            agent="gate-1",
            hermetic=True,
        )
        self.assertIsNotNone(argv_on)
        self.assertIn("--hermetic", argv_on)

        argv_off = axi.sibling_client_argv(
            "python",
            "python3 -m unittest discover -s tests/unit",
            agent="gate-1",
            hermetic=False,
        )
        self.assertIsNotNone(argv_off)
        self.assertNotIn("--hermetic", argv_off)

        argv_default = axi.sibling_client_argv(
            "python",
            "python3 -m unittest discover -s tests/unit",
            agent="gate-1",
        )
        self.assertIsNotNone(argv_default)
        self.assertNotIn("--hermetic", argv_default)

        # Direct client command (e.g. bun sibling suite)
        bun_on = axi.sibling_client_argv(
            "bun",
            "bun-crucible.py unit",
            agent="gate-1",
            hermetic=True,
        )
        self.assertIsNotNone(bun_on)
        self.assertIn("--hermetic", bun_on)

    def test_mvn_e2e_refuses_with_docker_and_hermetic_before_starting_docker(self):
        scratch = Path(tempfile.mkdtemp(prefix="mvn-docker-hermetic-"))
        self.addCleanup(shutil.rmtree, scratch, ignore_errors=True)
        (scratch / "pom.xml").write_text(
            "<project><profiles><profile><id>e2e</id></profile></profiles></project>\n",
            encoding="utf-8",
        )
        (scratch / ".env").write_text(
            "CRUCIBLE_PROJECT_KEY=mvn-hermetic-test-key\n", encoding="utf-8"
        )
        (scratch / "crucible.toml").write_text(
            '[client]\nurl = "http://127.0.0.1:1"\n', encoding="utf-8"
        )

        mvn = load_client("mvn-crucible.py")
        stdout = io.StringIO()
        stderr = io.StringIO()
        argv = [
            "mvn-crucible.py",
            "e2e",
            "--with-docker",
            "--hermetic",
            "--agent",
            "mvn-agent",
            "--project-dir",
            str(scratch),
        ]
        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(mvn, "_docker_up") as mock_docker_up,
            mock.patch.object(mvn, "_docker_clean_check") as mock_clean,
            mock.patch("subprocess.run") as mock_run,
            mock.patch("urllib.request.urlopen") as mock_urlopen,
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
            self.assertRaises(SystemExit) as exit_ctx,
        ):
            mvn.main()

        self.assertNotEqual(exit_ctx.exception.code, 0)
        mock_docker_up.assert_not_called()
        mock_clean.assert_not_called()
        mock_run.assert_not_called()
        mock_urlopen.assert_not_called()

        out_text = stdout.getvalue().strip()
        self.assertTrue(
            out_text,
            f"expected ok:false TOON envelope on stdout; stderr={stderr.getvalue()!r}",
        )
        parsed = TOON.decode(out_text)
        axi_env = parsed.get("axi", parsed)
        self.assertIs(axi_env.get("ok"), False, f"envelope={parsed!r}")
        error_text = str(axi_env.get("error", "")).lower()
        self.assertIn("docker", error_text)
        self.assertIn("hermetic", error_text)
        self.assertTrue(axi_env.get("help"), f"refusal must carry help[]: {parsed!r}")


class FleetRegistrationAndScriptRetirementTest(unittest.TestCase):
    """S5 / AC7 / AC8 — hermetic modules registered in FLEET_FILES, legacy
    `scripts/hermetic/run.sh` and `tripwire.py` retired, unit-check tools kept."""

    def test_fleet_files_registers_both_hermetic_modules(self):
        self.assertIn("_crucible_hermetic.py", crucible_install.FLEET_FILES)
        self.assertIn("_crucible_tripwire.py", crucible_install.FLEET_FILES)

    def test_legacy_run_sh_and_tripwire_py_are_retired_while_unit_check_stays(self):
        self.assertFalse(
            (REPO_ROOT / "scripts/hermetic/run.sh").exists(),
            "scripts/hermetic/run.sh must be retired in favor of clients/_crucible_hermetic.py",
        )
        self.assertFalse(
            (REPO_ROOT / "scripts/hermetic/tripwire.py").exists(),
            "scripts/hermetic/tripwire.py must be retired in favor of clients/_crucible_tripwire.py",
        )
        for kept in (
            "scripts/hermetic/unit-check.sh",
            "scripts/hermetic/unit-verdict.py",
            "scripts/hermetic/tagging_runner.py",
        ):
            self.assertTrue(
                (REPO_ROOT / kept).is_file(),
                f"{kept} must remain in place (Ruling Q4 / non-goal)",
            )


if __name__ == "__main__":
    unittest.main()
