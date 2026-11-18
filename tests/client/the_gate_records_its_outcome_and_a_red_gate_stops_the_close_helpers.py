"""The helpers of `test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json
import os
import stat
import subprocess
import time
import urllib.request
from pathlib import Path

from tests.client.client_fleet_envelope_census_helpers import _build_fake_bin_dir, fake_go_body
from tests.client.fake_nextest import private_fake_prelude


# The one failing test identifier every client's FAIL fixture carries, so a
# milestone's `failingTests` can be checked for a REAL, specific value rather
# than "the list is non-empty".
FAILING_TEST_MARKER = "gate_fixture_known_failure"

PASSING_TEST_NAME = "alpha_behaviour_passes"

_JUNIT_PASS_ONE = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuites><testsuite name="gate-fixture" tests="1" failures="0" errors="0">'
    f'<testcase classname="gate_fixture" name="{PASSING_TEST_NAME}" time="0.001"/>'
    '</testsuite></testsuites>'
)

_JUNIT_FAIL_ONE_OF_TWO = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuites><testsuite name="gate-fixture" tests="2" failures="1" errors="0">'
    f'<testcase classname="gate_fixture" name="{PASSING_TEST_NAME}" time="0.001"/>'
    f'<testcase classname="gate_fixture" name="{FAILING_TEST_MARKER}" time="0.001">'
    '<failure message="assertion violated: expected 2 got 3">AssertionError</failure>'
    '</testcase></testsuite></testsuites>'
)

_SUREFIRE_PASS_ONE = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="GateFixtureTest" tests="1" failures="0" errors="0">'
    f'<testcase classname="GateFixtureTest" name="{PASSING_TEST_NAME}" time="0.001"/>'
    '</testsuite>'
)

_SUREFIRE_FAIL_ONE_OF_TWO = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="GateFixtureTest" tests="2" failures="1" errors="0">'
    f'<testcase classname="GateFixtureTest" name="{PASSING_TEST_NAME}" time="0.001"/>'
    f'<testcase classname="GateFixtureTest" name="{FAILING_TEST_MARKER}" time="0.001">'
    '<failure message="assertion violated: expected 2 got 3">AssertionError</failure>'
    '</testcase></testsuite>'
)

_LCOV_ONE = "SF:detector.src\nDA:1,1\nLF:1\nLH:1\nFNF:0\nFNH:0\nend_of_record\n"

_FAIL_BUN_BODY = f'''#!/usr/bin/env python3
import os
import sys

argv = sys.argv[1:]
JUNIT = {_JUNIT_FAIL_ONE_OF_TWO!r}
LCOV = {_LCOV_ONE!r}

if argv and argv[0] == "test":
    outfile = None
    coverage_dir = None
    for tok in argv:
        if tok.startswith("--reporter-outfile="):
            outfile = tok.split("=", 1)[1]
        elif tok.startswith("--coverage-dir="):
            coverage_dir = tok.split("=", 1)[1]
    if outfile:
        parent = os.path.dirname(outfile)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(outfile, "w") as f:
            f.write(JUNIT)
    if coverage_dir:
        os.makedirs(coverage_dir, exist_ok=True)
        with open(os.path.join(coverage_dir, "lcov.info"), "w") as f:
            f.write(LCOV)
sys.exit(0)
'''

# The failing `cargo` answers a streamed rust run's calls (the version, the
# list, `llvm-cov show-env` and `llvm-cov report` writing the same lcov, and
# the `libtest-json-plus` stream) by `tests/client/fake_nextest.py`, its
# stream holding the same two tests as its JUnit report, the second failing.
_FAIL_CARGO_BODY = ("#!/usr/bin/env python3\n"
                    "import os as _nx_os\n"
                    f"_nx_os.environ['FAKE_LCOV'] = {_LCOV_ONE!r}\n"
                    + private_fake_prelude(
                        f"[fake_nextest.case({PASSING_TEST_NAME!r}, crate='gate-fixture', "
                        f"binary='gate_fixture'), fake_nextest.case({FAILING_TEST_MARKER!r}, "
                        f"'failed', crate='gate-fixture', binary='gate_fixture', "
                        f"message='assertion violated: expected 2 got 3')]")
                    + f'''
import os
import sys

argv = sys.argv[1:]
JUNIT = {_JUNIT_FAIL_ONE_OF_TWO!r}
LCOV = {_LCOV_ONE!r}

if "nextest" in argv:
    profile = "ci"
    if "-P" in argv:
        profile = argv[argv.index("-P") + 1]
    junit_dir = os.path.join("target", "nextest", profile)
    os.makedirs(junit_dir, exist_ok=True)
    with open(os.path.join(junit_dir, "junit.xml"), "w") as f:
        f.write(JUNIT)
    if "--lcov" in argv:
        out_path = "target/lcov.info"
        if "--output-path" in argv:
            out_path = argv[argv.index("--output-path") + 1]
        parent = os.path.dirname(out_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(out_path, "w") as f:
            f.write(LCOV)
sys.exit(0)
''')

_FAIL_MVN_BODY = f'''#!/usr/bin/env python3
import os
import sys

JUNIT = {_SUREFIRE_FAIL_ONE_OF_TWO!r}
for kind in ("surefire", "failsafe"):
    prefix = "-D" + kind + ".reportsDirectory="
    d = next((a[len(prefix):] for a in sys.argv[1:] if a.startswith(prefix)),
             os.path.join("target", kind + "-reports"))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "TEST-GateFixtureTest.xml"), "w") as f:
        f.write(JUNIT)
sys.exit(0)
'''

_PY_TEST_PASS = (
    "import unittest\n\n\n"
    "class GateFixtureTest(unittest.TestCase):\n"
    f"    def test_{PASSING_TEST_NAME}(self):\n"
    "        self.assertEqual(1, 1)\n"
)

_PY_TEST_FAIL = (
    "import unittest\n\n\n"
    "class GateFixtureTest(unittest.TestCase):\n"
    f"    def test_{PASSING_TEST_NAME}(self):\n"
    "        self.assertEqual(1, 1)\n\n"
    f"    def test_{FAILING_TEST_MARKER}(self):\n"
    "        self.assertEqual(2, 3)\n"
)

# arduino's fake `make`: exits 0 and writes NO report. The census module's
# stock fake `make` writes its own passing `TEST-DetectorProbe.xml` on every
# `make junit`, which the arduino client sends beside the fixture's own report,
# so it is replaced in BOTH arduino bin dirs: the only report the gate reads is
# the one `_write_native_fixture` wrote.
_SILENT_MAKE_BODY = "#!/usr/bin/env python3\nimport sys\n\nsys.exit(0)\n"


def _overwrite_fake_tool(bin_dir, name, body):
    path = Path(bin_dir) / name
    path.write_text(body)
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return path


def _fail_bin_dir_for(client_key):
    """A copy of the census module's standard PASSING fake-tool dir, with the
    ONE tool that produces this client's suite result overwritten to report a
    failure. `arduino`'s native suite result comes from a JUnit file THIS test
    writes directly into the project fixture (`_write_native_fixture`), never
    from `make`/`arduino-cli`, so its `make` is silenced instead
    (`_SILENT_MAKE_BODY`)."""
    bin_dir = _build_fake_bin_dir()
    if client_key == "arduino":
        _overwrite_fake_tool(bin_dir, "make", _SILENT_MAKE_BODY)
    if client_key == "bun":
        _overwrite_fake_tool(bin_dir, "bun", _FAIL_BUN_BODY)
    elif client_key == "rust":
        _overwrite_fake_tool(bin_dir, "cargo", _FAIL_CARGO_BODY)
    elif client_key == "mvn":
        _overwrite_fake_tool(bin_dir, "mvn", _FAIL_MVN_BODY)
    elif client_key == "go":
        _overwrite_fake_tool(bin_dir, "go", fake_go_body("fail"))
    return bin_dir


def _git_commit_fixture(project_dir):
    """`git init` + one commit over the whole fixture tree, so the project
    directory has a real, independently-verifiable HEAD commit for the
    milestone's `commit` field to be checked against — a fresh `tempfile`
    tree is NOT a git repo by default, and the CR's own "head commit" wording
    demands one that is."""
    def run(*args):
        return subprocess.run(
            ["git", *args], cwd=str(project_dir), capture_output=True, text=True,
            env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1"}, check=True)

    run("init", "-q", "-b", "main")
    run("config", "user.email", "gate-fixture@example.invalid")
    run("config", "user.name", "Gate Fixture")
    run("add", "-A")
    run("commit", "-q", "--no-gpg-sign", "-m", "gate fixture baseline")
    return run("rev-parse", "HEAD").stdout.strip()


def _write_native_fixture(project_dir, outcome):
    """arduino's own suite-result seam: a pre-written `tests/native/reports/
    TEST-*.xml` (+ a minimal lcov), exactly the idiom
    `clients-python-arduino-crucible.test.ts`'s pre-merge-gate fixtures use —
    the fake `make`/`arduino-cli` on PATH never produce the result
    themselves, they only need to exit 0."""
    reports_dir = Path(project_dir) / "tests" / "native" / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    body = _JUNIT_PASS_ONE if outcome == "pass" else _JUNIT_FAIL_ONE_OF_TWO
    (reports_dir / "TEST-GateFixtureNative.xml").write_text(body)
    coverage_dir = Path(project_dir) / "tests" / "native" / "coverage"
    coverage_dir.mkdir(parents=True, exist_ok=True)
    (coverage_dir / "lcov.info").write_text(_LCOV_ONE)


def _free_port():
    import socket

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _declare_listener(store_dir, port, host="127.0.0.1"):
    Path(store_dir, "crucible.toml").write_text(
        f'[server]\nhost = "{host}"\nport = {port}\n', encoding="utf-8")


def _call(base, path, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data, method=method or ("POST" if data is not None else "GET"),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _await_server(base, proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"scratch server exited early with {proc.returncode}")
        try:
            with urllib.request.urlopen(base + "/api/v2/health", timeout=2):  # noqa: S310
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"scratch server never became reachable at {base}")
