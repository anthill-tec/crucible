"""RED -- the installer: `crucible_axi.cli.main` applies NO
conversion at all to an escaping `OSError`/`ValueError`, for either of its
two different contracts.

  * `cmd_install`/`cmd_uninstall` call `install.run_install`/
    `install.run_uninstall` with no enclosing `try`/`except` at all (read
    directly: the `while True: ok, stages, warnings = install.run_install(...)`
    loop in `cmd_install`, and the single call in `cmd_uninstall`) -- an
    `OSError` there (`crucible_axi/install.py` makes 13 unguarded
    throwing calls) reaches neither the `axi.emit_axi(...)` call
    later in the same function nor any handler in `main`, so it prints a
    Python traceback and `crucible-axi install`/`uninstall` never puts an
    envelope on stdout at all.
  * `cmd_serve` ALREADY guards its first two failure sites
    (`install.server_launch_argv()` -> `except RuntimeError`,
    `install.write_listener_settings(...)` -> `except OSError`) with the
    exact `print(f"crucible-axi serve: {exc}", file=sys.stderr); return 1`
    shape -- but its THIRD call, `subprocess.run(argv, env=env)` (the one
    that actually STARTS the server binary), carries no such guard at all
    (read directly: it sits between the two guarded calls and the
    `KeyboardInterrupt` catch, with nothing of its own). An `OSError`
    starting that binary (e.g. it was removed, or is not executable) prints
    a traceback today instead of the SAME error-line-and-exit-1 shape its
    two sibling call sites already use.

Reuses `tests/client/test_cr066_serve_and_target_dir.py`'s own established
harness verbatim (`_import_fresh`, `_run_cli`) -- the fresh-import-graph
loader that keeps `crucible_axi.cli`'s `from crucible_axi import install`
binding to the SAME module object a `mock.patch.object(install, ...)`
targets -- and `test_client_fleet_envelope_census.py`'s `_load_toon_module`/
`classify_envelope` for decoding the TOON envelope `install`/`uninstall`
emit through the identical shared `clients/_crucible_axi.py::emit_axi` the
client fleet uses.

No CR-shaped literal anywhere."""

import shutil
import tempfile
import unittest
from unittest import mock

from tests.client.test_client_fleet_envelope_census import (
    _load_toon_module,
    classify_envelope,
)
from tests.client.test_cr066_serve_and_target_dir import (
    _import_fresh,
    _run_cli,
)


class InstallUninstallEscapingFailureBecomesEnvelopeTest(unittest.TestCase):

    def setUp(self):
        self.target_dir = tempfile.mkdtemp(prefix="cli-escaping-failure-")

    def tearDown(self):
        shutil.rmtree(self.target_dir, ignore_errors=True)

    def test_install_oserror_becomes_ok_false_envelope_no_traceback(self):
        install_mod, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        with mock.patch.object(
                install_mod, "run_install",
                side_effect=OSError("disk full laying down the [server] stage")):
            code, out, err = _run_cli(
                cli, ["install", "--target-dir", self.target_dir])

        self.assertNotIn(
            "Traceback (most recent call last)", err,
            f"an OSError escaped `crucible-axi install` as a Python "
            f"traceback instead of the ok:false envelope -- stderr={err!r}")
        emits, axi = classify_envelope(out, toon)
        self.assertTrue(
            emits, f"install stdout did not decode as a TOON axi envelope "
            f"at all -- {out!r}")
        assert axi is not None
        self.assertFalse(axi["ok"])
        self.assertNotEqual(code, 0)
        self.assertIn("OSError", repr(axi))
        self.assertIn("disk full laying down the [server] stage", repr(axi))

    def test_uninstall_valueerror_becomes_ok_false_envelope_no_traceback(self):
        install_mod, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        toon = _load_toon_module()
        with mock.patch.object(
                install_mod, "run_uninstall",
                side_effect=ValueError("malformed manifest while uninstalling")):
            code, out, err = _run_cli(
                cli, ["uninstall", "--target-dir", self.target_dir])

        self.assertNotIn(
            "Traceback (most recent call last)", err,
            f"a ValueError escaped `crucible-axi uninstall` as a Python "
            f"traceback instead of the ok:false envelope -- stderr={err!r}")
        emits, axi = classify_envelope(out, toon)
        self.assertTrue(
            emits, f"uninstall stdout did not decode as a TOON axi envelope "
            f"at all -- {out!r}")
        assert axi is not None
        self.assertFalse(axi["ok"])
        self.assertNotEqual(code, 0)
        self.assertIn("ValueError", repr(axi))
        self.assertIn("malformed manifest while uninstalling", repr(axi))


class ServeOSErrorStartingTheServerBinaryTest(unittest.TestCase):
    """`cmd_serve`'s THIRD, unguarded failure site: the actual
    `subprocess.run(argv, env=env)` launch call, as opposed to the two
    sibling sites (`server_launch_argv`/`write_listener_settings`) that
    already carry the `print(...); return 1` shape the launch call must
    share."""

    def test_oserror_starting_the_server_binary_prints_error_line_exit_1_no_envelope(self):
        install_mod, cli = _import_fresh("crucible_axi.install", "crucible_axi.cli")
        with mock.patch.object(
                install_mod, "server_launch_argv",
                return_value=["/nonexistent/crucible-server-bin"]), \
                mock.patch(
                    "subprocess.run",
                    side_effect=OSError(
                        "[Errno 2] No such file or directory: "
                        "'/nonexistent/crucible-server-bin'")):
            code, out, err = _run_cli(cli, ["serve"])

        self.assertEqual(
            code, 1,
            f"an OSError starting the server binary must exit 1, like "
            f"`cmd_serve`'s two sibling guarded sites -- code={code} "
            f"stderr={err!r}")
        self.assertNotIn(
            "Traceback (most recent call last)", err,
            f"an OSError starting the server binary escaped as a Python "
            f"traceback instead of the error line -- stderr={err!r}")
        self.assertEqual(
            out.strip(), "",
            f"`serve` emits NO envelope at all (stdout belongs to the "
            f"server) -- stdout={out!r}")
        self.assertIn(
            "crucible-axi serve:", err,
            f"the error line must carry the same 'crucible-axi serve: ' "
            f"prefix its two sibling guarded sites already use -- "
            f"stderr={err!r}")
        self.assertIn(
            "No such file or directory", err,
            f"the error line must name the OSError's own message -- "
            f"stderr={err!r}")


if __name__ == "__main__":
    unittest.main()
