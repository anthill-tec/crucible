"""The shared hermetic modules ship with the client fleet: a sandboxed
`crucible-axi install` lays `_crucible_hermetic.py` and `_crucible_tripwire.py`
down beside the other shared modules, and every installed client's `unit --help`
loads from the install and exposes `--hermetic`.

The install is the real `cli.main(["install", "--target-dir", <scratch>,
"--no-service"])` in the sandbox `test_cr090_cli_install_integration` uses:
`$HOME`, `$XDG_DATA_HOME`, `$BUN_INSTALL` and `$CRUCIBLE_DB` pinned under a
scratch home, and the `[server]` and `[unit]` stages stubbed, so no service is
installed, nothing is provisioned and no port is probed. The operator's real
home is never the one the install runs in.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> --tests \
        tests.client.integration.test_the_hermetic_modules_ship_with_the_fleet
"""

import os
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client import CLIENT_SOURCE_DIR
from tests.client.unit.test_cr090_cli_install_integration import _CliInstallCase

HERMETIC_MODULES = ("_crucible_hermetic.py", "_crucible_tripwire.py")
REAL_HOME = os.path.expanduser("~")
CLIENT_SCRIPTS = (
    "python-crucible.py",
    "bun-crucible.py",
    "rust-crucible.py",
    "mvn-crucible.py",
    "arduino-crucible.py",
    "go-crucible.py",
    "eda-crucible.py",
)


class TheHermeticModulesAreLaidDownWithTheFleetTest(_CliInstallCase):

    def install_in_the_sandbox(self):
        self.assertNotEqual(
            os.path.realpath(os.environ["HOME"]),
            os.path.realpath(REAL_HOME),
            "the install must run in the sandbox home, never the operator's",
        )
        code, stdout = self.run_cli_install("--no-service")
        self.assertCliOk(code, stdout, " --no-service")
        return stdout

    def test_a_sandboxed_install_lays_both_hermetic_modules_down_byte_identical(self):
        stdout = self.install_in_the_sandbox()
        for module in HERMETIC_MODULES:
            with self.subTest(module=module):
                source = CLIENT_SOURCE_DIR / module
                self.assertTrue(
                    source.is_file(),
                    f"source hermetic module {module} does not exist at {source}",
                )
                landed = Path(self.clients_dir()) / module
                self.assertTrue(
                    landed.is_file(),
                    f"the install laid no {module} down at {landed}; "
                    f"envelope:\n{stdout}",
                )
                self.assertEqual(
                    landed.read_bytes(),
                    source.read_bytes(),
                    f"the installed {module} must be byte-identical to the checkout's",
                )

    def test_every_installed_clients_unit_help_loads_from_the_install_and_exposes_hermetic(self):
        self.install_in_the_sandbox()
        for script in CLIENT_SCRIPTS:
            with self.subTest(client=script):
                path = Path(self.clients_dir()) / script
                result = subprocess.run(
                    [sys.executable, str(path), "unit", "--help"],
                    cwd=self.home,
                    env=dict(os.environ),
                    capture_output=True,
                    text=True,
                    timeout=60,
                    check=False,
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    f"{script} unit --help from the install; stdout="
                    f"{result.stdout[-800:]!r} stderr={result.stderr[-1500:]!r}",
                )
                self.assertIn("--hermetic", result.stdout, f"{script}: {result.stdout!r}")


if __name__ == "__main__":
    unittest.main()
