"""The plain helpers of `test_client_fleet_envelope_census.py`, lifted out of
that test module so a suite importing them does not import a test module
(CR-CRU-261).

Holds no `TestCase` and no test: the fleet's client scripts, the fake external
toolchains, the throwaway project fixture, the argparse verb enumeration and
argv builder, the board declaration and its interlock (`would_resolve`,
`declare_and_require_board`), the subprocess drive and the envelope
classifier. `BoardInterlockCase` is a `TestCase` and stays in the census
module.
"""

import argparse
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

from tests.client import (
    CLIENT_SOURCE_DIR,
    TEST_INSTALL_CLIENTS,
)
from tests.client.fake_nextest import private_fake_prelude

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = TEST_INSTALL_CLIENTS
TOON_PATH = CLIENTS_DIR / "toon.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
    "go": CLIENTS_DIR / "go-crucible.py",
}

# An unreachable local address (nothing listens on port 1 without root) --
# every HTTP call across the fleet refuses instantly (loopback ECONNREFUSED,
# no hang), and `_crucible_axi.http_request` (read directly) already turns
# that into a structured `{"ok": False, "error": ...}` rather than raising.
# The live :3849 dashboard is never touched by this file.
_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"

_JUNIT_ONE_PASS = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuites><testsuite name="detector" tests="1" failures="0" errors="0">'
    '<testcase classname="detector" name="probe" time="0.001"/>'
    '</testsuite></testsuites>'
)


_PROBE_UNITTEST_BODY = (
    "import unittest\n\n\n"
    "class DetectorProbeTest(unittest.TestCase):\n"
    "    def test_probe_passes(self):\n"
    "        self.assertEqual(1, 1)\n"
)


# ── fake external toolchains (§S0 requirement 3) ────────────────────────────
#
# Each is a real, chmod +x script (never a subprocess.run mock -- these run
# as a genuine CHILD of the real subprocess we drive) that writes a minimal
# valid artifact at the conventional path its real counterpart would have
# used, then exits 0. None of them shells out to a real toolchain even if
# one happens to be installed on this machine.

# A streamed rust run's calls (the version, the list, the `libtest-json-plus`
# stream of the one passing `detector` test, `llvm-cov show-env` and `llvm-cov
# report` writing the same lcov) are answered first, by
# `tests/client/fake_nextest.py`; every other call falls through unchanged.
_FAKE_CARGO_BODY = ("#!/usr/bin/env python3\n"
                    "import os as _nx_os\n"
                    "_nx_os.environ.setdefault('FAKE_LCOV', 'SF:detector.src\\nDA:1,1\\n"
                    "LF:1\\nLH:1\\nFNF:0\\nFNH:0\\nend_of_record\\n')\n"
                    + private_fake_prelude(
                        "[fake_nextest.case('probe', crate='detector', binary='detector')]")
                    + r'''
import os
import sys

argv = sys.argv[1:]
JUNIT = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuites><testsuite name="detector" tests="1" failures="0" errors="0">'
    '<testcase classname="detector" name="probe" time="0.001"/>'
    '</testsuite></testsuites>'
)
LCOV = "SF:detector.src\nDA:1,1\nLF:1\nLH:1\nFNF:0\nFNH:0\nend_of_record\n"

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

_FAKE_DOCKER_BODY = r'''#!/usr/bin/env python3
import sys
sys.exit(0)
'''

_FAKE_MVN_BODY = r'''#!/usr/bin/env python3
import os
import sys

JUNIT = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="DetectorProbeTest" tests="1" failures="0" errors="0">'
    '<testcase classname="DetectorProbeTest" name="probe" time="0.001"/>'
    '</testsuite>'
)
for kind in ("surefire", "failsafe"):
    # Like the real plugins: `-D<kind>.reportsDirectory` wins over the default.
    prefix = "-D" + kind + ".reportsDirectory="
    d = next((a[len(prefix):] for a in sys.argv[1:] if a.startswith(prefix)),
             os.path.join("target", kind + "-reports"))
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "TEST-DetectorProbeTest.xml"), "w") as f:
        f.write(JUNIT)
sys.exit(0)
'''

_FAKE_BUN_BODY = r'''#!/usr/bin/env python3
import os
import sys

argv = sys.argv[1:]
JUNIT = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuites><testsuite name="detector" tests="1" failures="0" errors="0">'
    '<testcase classname="detector" name="probe" time="0.001"/>'
    '</testsuite></testsuites>'
)
LCOV = "SF:detector.src\nDA:1,1\nLF:1\nLH:1\nFNF:0\nFNH:0\nend_of_record\n"

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

_FAKE_ARDUINO_CLI_BODY = r'''#!/usr/bin/env python3
import sys
sys.exit(0)
'''

_FAKE_MAKE_BODY = r'''#!/usr/bin/env python3
import os
import sys

argv = sys.argv[1:]
JUNIT = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="DetectorProbe" tests="1" failures="0" errors="0">'
    '<testcase classname="DetectorProbe" name="probe" time="0.001"/>'
    '</testsuite>'
)
if "junit" in argv:
    os.makedirs("reports", exist_ok=True)
    with open(os.path.join("reports", "TEST-DetectorProbe.xml"), "w") as f:
        f.write(JUNIT)
sys.exit(0)
'''

# Mirrors test_rust_crucible_axi.py's `_FAKE_NO_MISTAKES_BODY` idiom exactly
# (proven-working TOON shape), simplified to one-shot (no progressive interim
# ladder -- this detector only needs the FINAL sealed snapshot to confirm
# gate-run's envelope, not the interim-post throttling CR-CRU-013 §S8 already
# covers elsewhere).
_FAKE_NO_MISTAKES_BODY = r'''#!/usr/bin/env python3
import sys

SNAPSHOT = (
    'run:\n'
    '  id: "gate-detector-001"\n'
    '  branch: detector-relay-marker\n'
    '  status: completed\n'
    '  head: 90abcde\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,10\n'
    'outcome: passed\n'
)

argv = sys.argv[1:]
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "status"):
    sys.stdout.write(SNAPSHOT)
    sys.exit(0)
sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\n")
sys.exit(1)
'''

# The go toolchain as the go client asks it: `go env GOVERSION` answers a Go
# above the client's floor, `go list` names the module's test files as the
# real one does (so a module whose test files carry no build tag declares no
# tier), `go test -list <re> -json ./...` lists one test
# per package, and `go test -json ./...` runs them, each test passing (or,
# with `OUTCOME = "fail"`, the second failing); `FAKE_TOTAL=<n>` in the
# environment makes it `n` tests in `go test -json`'s own event
# stream, which the board's `go-test` codec decodes. Every package is the
# module path of the `go.mod` in the working directory, so a run made in two
# modules names two packages.
_FAKE_GO_TEMPLATE = r'''#!/usr/bin/env python3
import json
import os
import sys

OUTCOME = "@OUTCOME@"
argv = sys.argv[1:]
if argv[:2] == ["env", "GOVERSION"]:
    print("go1.27.3")
    sys.exit(0)
if argv[:1] == ["version"]:
    print("go version go1.27.3 linux/amd64")
    sys.exit(0)
if argv[:1] == ["list"]:
    # `go list [-tags <t>] -json=... ./...`, as the real one answers it for a
    # one-package module: its `_test.go` files, each kept or dropped by its
    # `//go:build` line under the tags. The gate and `regression` read a
    # project's declared tiers this way, so a module whose test files carry
    # no tag declares none.
    tags = []
    if "-tags" in argv[:-1]:
        tags = [t for t in argv[argv.index("-tags") + 1].split(",") if t]
    module = "example.com/probe"
    try:
        with open("go.mod") as handle:
            for line in handle:
                if line.startswith("module "):
                    module = line.split()[1]
                    break
    except OSError:
        pass
    files = []
    for name in sorted(os.listdir(".")):
        if not name.endswith("_test.go"):
            continue
        with open(name) as handle:
            first = handle.readline().strip()
        if first.startswith("//go:build "):
            expr = first[len("//go:build "):].strip()
            if (expr.lstrip("!") in tags) == expr.startswith("!"):
                continue
        files.append(name)
    package = {"Dir": os.getcwd(), "ImportPath": module}
    if files:
        package["TestGoFiles"] = files
    sys.stdout.write(json.dumps(package, indent="\t") + "\n")
    sys.exit(0)
if argv[:1] == ["vet"]:
    # `go vet ./...`, the go client's default lint, finding nothing.
    sys.exit(0)
if argv[:1] != ["test"]:
    sys.stderr.write("fake go: unsupported invocation: " + repr(argv) + "\n")
    sys.exit(2)
module = "example.com/probe"
try:
    with open("go.mod") as handle:
        for line in handle:
            if line.startswith("module "):
                module = line.split()[1]
                break
except OSError:
    pass
TESTS = ["Test_alpha_behaviour_passes", "Test_gate_fixture_known_failure"]
if os.environ.get("FAKE_TOTAL"):
    TESTS = ["Test_case_%d" % index for index in range(int(os.environ["FAKE_TOTAL"]))]


def emit(**event):
    sys.stdout.write(json.dumps({"Package": module, **event}) + "\n")


if "-list" in argv:
    for name in TESTS:
        emit(Action="output", Output=name + "\n")
    emit(Action="output", Output="ok  \t" + module + "\t0.001s\n")
    emit(Action="pass")
    sys.exit(0)
failed = False
emit(Action="start")
for index, name in enumerate(TESTS):
    fails = OUTCOME == "fail" and index == 1
    failed = failed or fails
    emit(Action="run", Test=name)
    emit(Action="output", Test=name, Output="=== RUN   " + name + "\n")
    if fails:
        emit(Action="output", Test=name,
             Output="    probe_test.go:9: gate_fixture_known_failure\n")
    word = "FAIL" if fails else "PASS"
    emit(Action="output", Test=name,
         Output="--- " + word + ": " + name + " (0.00s)\n")
    emit(Action="fail" if fails else "pass", Test=name, Elapsed=0)
emit(Action="output", Output=("FAIL\n" if failed else "PASS\n"))
emit(Action="fail" if failed else "pass", Elapsed=0)
sys.exit(1 if failed else 0)
'''


def fake_go_body(outcome="pass"):
    """The fake `go` whose run passes every test (`pass`) or fails one
    (`fail`)."""
    return _FAKE_GO_TEMPLATE.replace("@OUTCOME@", outcome)


_FAKE_GO_BODY = fake_go_body("pass")

# A go module the census drives: its `go.mod` and one test file, so a go
# client verb that resolves a module finds it at the project dir.
GO_PROBE_MODULE = "example.com/probe"


def write_go_module(directory, module=GO_PROBE_MODULE):
    """Lay a minimal go module down at `directory`."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "go.mod").write_text(f"module {module}\n\ngo 1.24\n")
    (directory / "probe_test.go").write_text(
        "package probe\n\nimport \"testing\"\n\n"
        "func Test_alpha_behaviour_passes(t *testing.T) {}\n")


_FAKE_TOOLS = {
    "go": _FAKE_GO_BODY,
    "cargo": _FAKE_CARGO_BODY,
    "docker": _FAKE_DOCKER_BODY,
    "mvn": _FAKE_MVN_BODY,
    "bun": _FAKE_BUN_BODY,
    "arduino-cli": _FAKE_ARDUINO_CLI_BODY,
    "make": _FAKE_MAKE_BODY,
    "no-mistakes": _FAKE_NO_MISTAKES_BODY,
}


def _build_fake_bin_dir():
    bin_dir = Path(tempfile.mkdtemp(prefix="cr058-detector-bin-"))
    for name, body in _FAKE_TOOLS.items():
        path = bin_dir / name
        path.write_text(body)
        st = os.stat(path)
        os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return bin_dir


def install_project_limits(project_dir):
    """CR-CRU-131 §S1b — lay the project's `crucible.toml` down beside its
    `.env`, which is what the installer does and therefore what a REAL project
    directory holds.

    Without it a fixture is an UNCONFIGURED project, and every envelope driven
    out of it correctly carries the client's `limit-configuration` disclosure
    naming the file it could not read (`emit_axi`, clients/_crucible_axi.py).
    That disclosure is a property of the fixture, not of the verb under test,
    so the fixture is made real rather than the finding filtered out — a filter
    would also hide a disclosure a verb genuinely started emitting.

    The SHIPPED declarations are copied verbatim: no `value` anywhere, so every
    limit resolves to its `recommended` exactly as it does for an operator who
    has installed and not yet edited.

    The shipped file declares no board, so the project declares its OWN: the
    unreachable loopback board. Without it a client would fall through to the
    install's file -- in a checkout, the operator's own root `crucible.toml`.
    """
    shutil.copyfile(CLIENT_SOURCE_DIR / "crucible.toml",
                    Path(project_dir) / "crucible.toml")
    return declare_board(Path(project_dir) / "crucible.toml", _UNREACHABLE_CRUCIBLE_URL)


def declare_census_lint(config_path):
    """Declare the census project's `[lint]`: a linter that is this
    interpreter printing one clean line, named by an absolute path so no PATH
    the drive is given can change what runs. Every client's `lint` then runs
    and files something with its cycle, and no real linter is ever run."""
    path = Path(config_path)
    command = [sys.executable, "-c", "print('census lint: nothing found')"]
    path.write_text(
        path.read_text(encoding="utf-8").rstrip("\n")
        + f"\n\n[lint]\ncommand = {json.dumps(command)}\nname = \"census-lint\"\n",
        encoding="utf-8")
    return path


def _make_project_dir(client_key):
    """A throwaway project fixture: `.env` with CRUCIBLE_PROJECT_KEY (+
    CRUCIBLE_PROJECT_NAME for arduino, which reads it), plus whatever each
    client's OWN verb-registration ORDER requires pre-seeded so an
    order-of-drive artefact never masquerades as an envelope finding.

    Only rust needs this: its argparse registers `auto-ingest` BEFORE
    `test`/`regression-ingest` (confirmed by reading `main()`'s add_parser
    call order), so a fresh project dir would make `auto-ingest` measure
    its "no junit yet" branch, not its "junit present" branch, purely
    because of registration order -- not a real behavioural difference from
    the other four clients (whose `auto-ingest` is registered AFTER their
    junit-producing verbs, so this dir's initial emptiness is already the
    fair, closest-to-normal state for them)."""
    d = Path(tempfile.mkdtemp(prefix=f"cr058-detector-{client_key}-"))
    env_lines = [f"CRUCIBLE_PROJECT_KEY=detector-{client_key}-key\n"]
    if client_key == "arduino":
        env_lines.append("CRUCIBLE_PROJECT_NAME=detector-project\n")
    (d / ".env").write_text("".join(env_lines))
    install_project_limits(d)
    declare_census_lint(d / "crucible.toml")
    if client_key == "python":
        tests_dir = d / "tests"
        tests_dir.mkdir()
        (tests_dir / "__init__.py").write_text("")
        (tests_dir / "test_probe.py").write_text(_PROBE_UNITTEST_BODY)
    if client_key == "rust":
        junit_dir = d / "target" / "nextest" / "ci"
        junit_dir.mkdir(parents=True)
        (junit_dir / "junit.xml").write_text(_JUNIT_ONE_PASS)
    if client_key == "arduino":
        # `_run_native_tests_body` passes `cwd=native_dir` to `subprocess.run`
        # (default native_dir = "<project-dir>/tests/native") -- an ABSENT
        # cwd raises FileNotFoundError before the fake `make` ever runs, a
        # fixture gap, not a real client finding. The dir must exist even
        # though the fake `make` writes its own reports/ subdir on demand.
        (d / "tests" / "native").mkdir(parents=True)
    if client_key == "go":
        # The go client resolves its module from the working directory (the
        # nearest go.mod at or above it); its gate finds every go.mod under
        # the project dir. One module at the project dir serves both.
        write_go_module(d)
    return d


def _load_module(path, cache_key):
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_toon_module():
    return _load_module(TOON_PATH, "cr058_toon_under_test")


class _ParserCaptured(Exception):
    """Raised from the patched `parse_args` the instant it is called, so
    `main()` never reaches subcommand dispatch. Carries the fully-built
    top-level parser (every `add_parser`/`add_argument` call has already
    run by this point -- only the FINAL `p.parse_args()` call is
    intercepted)."""

    def __init__(self, parser):
        super().__init__("parser captured before dispatch")
        self.parser = parser


def enumerate_verbs(client_key, script_path):
    """§S0 -- enumerate verbs from the client's REAL argparse, never a
    hand-written list. Confirmed by reading all five `main()` bodies: each
    builds its parser, then calls `p.parse_args()` (no argv -- reads
    `sys.argv`) exactly ONCE, immediately followed by dispatch. Patching
    `argparse.ArgumentParser.parse_args` at the CLASS level intercepts that
    one call regardless of which client module is loaded, and raising
    immediately means no subcommand body ever executes during enumeration.
    Returns `{verb_name: subparser}` (aliases, e.g. `status`/`plans`, are
    two distinct dict entries -- each is independently argparse-registered
    and independently driven below)."""
    module = _load_module(script_path, f"cr058_enum_{client_key}")

    def _capture(self, *_a, **_kw):
        raise _ParserCaptured(self)

    with mock.patch.object(argparse.ArgumentParser, "parse_args", _capture):
        with mock.patch.object(sys, "argv", [script_path.name]):
            try:
                module.main()
            except _ParserCaptured as captured:
                parser = captured.parser
            else:
                raise AssertionError(
                    f"{client_key}: main() returned without ever calling "
                    f"parse_args() -- enumeration is broken, not the fleet")

    sub_actions = [a for a in parser._actions
                   if isinstance(a, argparse._SubParsersAction)]
    assert len(sub_actions) == 1, (
        f"{client_key}: expected exactly one subparsers action on the "
        f"top-level parser, found {len(sub_actions)}")
    return dict(sub_actions[0].choices)


_DEST_DEFAULTS = {
    "agent": "detector-probe-agent",
    "cr": "CR-CRU-058-DETECTOR",
    "cycles": "a",
    "crate": "detector_crate",
    "crates": "detector_crate",
    "commit": "deadbeef0000",
    "intent": "detector-intent",
    "outcome": "passed",
    "type": "custom",
    "label": "detector-cycle",
    "cycle_id": "1",
    "target": "2026-09-01",
}


def _dummy_value_for(action):
    """A deterministic, harmless value for a required argparse action --
    enum-constrained actions get their first declared choice, int-typed
    actions get "1", everything else falls back to a per-dest table (built
    from reading every subparser's own `--help` text) or a generic
    `detector-<dest>` placeholder."""
    if action.choices:
        return str(list(action.choices)[0])
    if action.type is int:
        return "1"
    return _DEST_DEFAULTS.get(action.dest, f"detector-{action.dest}")


_BOOLEAN_ACTION_TYPES = (argparse._StoreTrueAction, argparse._StoreFalseAction)


def build_argv(verb_name, subparser, project_dir):
    """The closest-to-normal-operation argv for `verb_name`: every REQUIRED
    option filled (plus `--agent` even where the CLI itself does not
    argparse-require it, per CR-CRU-054 §S2b's runtime hard stop -- omitting
    it would only ever exercise the identity hard-stop path, never the
    verb's OWN logic), `--project-dir` pointed at the fixture, and every
    positional in its declared order. Boolean flags are NEVER forced on --
    left at their argparse default, which is the normal/unadorned
    invocation of the verb."""
    argv = [verb_name]
    positionals = []
    for action in subparser._actions:
        if isinstance(action, argparse._HelpAction):
            continue
        if not action.option_strings:
            positionals.append(_dummy_value_for(action))
            continue
        if isinstance(action, _BOOLEAN_ACTION_TYPES):
            continue
        flag = action.option_strings[0]
        if action.dest == "project_dir":
            argv += [flag, str(project_dir)]
            continue
        if action.dest == "agent" or action.required:
            argv += [flag, _dummy_value_for(action)]
    argv += positionals
    return argv


# ════════════════════════════════════════════════════════════════════════════
# CR-CRU-139 §S2 -- the BOARD a fixture points a client at, and the INTERLOCK
# that keeps a drive off the production board.
# ════════════════════════════════════════════════════════════════════════════
#
# A client's target board stopped being an environment variable and became
# `[client] url` in the project's own `crucible.toml`, resolved through the
# CR-CRU-138 §S1 chain by the ONE shared resolver named below. These helpers
# are the FIXTURE side of that, lifted into the module the client suites
# already import their fixtures from rather than re-spelled per suite.
#
# THE INTERLOCK IS A SAFETY DEVICE, NOT CEREMONY -- read this before removing
# it. A suite that used to aim `$CRUCIBLE_URL` at its own stub board and simply
# drops the export does not fail: it silently stops steering, and the drive
# resolves whatever board the INSTALL declares -- for a client run out of this
# checkout, the operator's own root `crucible.toml` -- or, with none declared
# anywhere, refuses. On the two-instance workstation this CR serves the
# install's board is a live one, and the verbs these suites drive (`register`,
# `unregister`, a gate seal) are WRITES -- so the failure mode is not a red
# test, it is somebody else's board carrying this suite's rows. The server
# side met the same hazard and discovered it by BINDING the port. `would_resolve` cannot: it asks
# the shared module IN PROCESS, over no socket, which board it WOULD resolve
# for a given project directory, and a fixture that spawns only when the answer
# is its own board can never address a packet anywhere else.

#: The shared module's ONE name for this resolution -- the sibling of the
#: `resolve_limit()` it already exports. Held here so that no suite spells it a
#: second way, which is how one resolver becomes two.
BOARD_RESOLVER = "resolve_base_url"


#: The `[client]` table from its header LINE to the next real TOML table-header
#: LINE (`[name]`, `[dotted.name]` or `[[name]]` alone on its line, an end-of-line
#: comment allowed), or to the end of the file. NOT to the first literal `[`:
#: comments and array values carry brackets (`# [gate]`, `skip = ["pr"]`), and a
#: strip that stopped at one would leave the table's tail behind -- or, with a
#: commented table after `[client]`, declare that table a second time.
_TABLE_HEADER_LINE = r"^[ \t]*\[\[?[ \t]*[A-Za-z0-9_.\-]+[ \t]*\]\]?[ \t]*(?:#[^\n]*)?$"
_CLIENT_TABLE = re.compile(
    r"(?ms)^[ \t]*\[[ \t]*client[ \t]*\][ \t]*(?:#[^\n]*)?$"
    r".*?(?=" + _TABLE_HEADER_LINE + r"|\Z)")


def declare_board(config_path, url):
    """Declare `url` as the `[client]` board in the `crucible.toml` at
    `config_path`, REPLACING any table already there.

    Replace rather than append, deliberately: the shipped `clients/crucible.toml`
    carries a `[client]` table of its own, and a fixture that appended a second
    one to a COPY of that file would make its own configuration unparsable
    (`Cannot declare ... twice`). Correct before and after that table lands,
    which is the only kind of writer a migrating suite can use.
    """
    path = Path(config_path)
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    text = _CLIENT_TABLE.sub("", text).rstrip("\n")
    path.write_text(f'{text}\n\n[client]\nurl = "{url}"\n', encoding="utf-8")
    return path


def would_resolve(axi_path, project_dir, expected):
    """The INTERLOCK: `(ok, reason)` for "is it safe to spawn a client in
    `project_dir`, and would it resolve the board this fixture is listening
    on?"

    Asked of the SAME shared module the drive will load -- pass the scratch
    fleet's copy when driving one, since the install and package-data layers
    are derived from that module's own location -- bound to the same project
    directory, in process and over no socket. `ok` is False, with a reason a
    failure message can print, for every case that would post somewhere else
    or refuse: no resolver at all, a resolver that raises (no board declared),
    or one that answers another board than the declared one.
    """
    module = _load_module(axi_path, "census_board_interlock")
    resolver = getattr(module, BOARD_RESOLVER, None)
    if not callable(resolver):
        return False, (f"{Path(axi_path).parent.name}/_crucible_axi.py exports "
                       f"no callable `{BOARD_RESOLVER}()`, so the fleet does "
                       f"not resolve its board from configuration")
    module.bind_project_dir(str(project_dir))
    try:
        actual = resolver()
    except Exception as exc:  # a resolver that raises is not one to drive
        return False, f"`{BOARD_RESOLVER}()` raised {exc!r}"
    finally:
        module.bind_project_dir(None)
    if actual != expected:
        return False, (f"`{BOARD_RESOLVER}()` answers {actual!r} for this "
                       f"project directory, not the declared {expected!r}")
    return True, None


def declare_and_require_board(project_dir, board, label="a client"):
    """Declare `board` in `project_dir`'s own `crucible.toml` and REFUSE unless
    the shared module really resolves it -- the two halves a migrated fixture
    always needs together, so no suite can do the first and forget the second.

    Raises rather than returning a verdict, because its callers are fixtures
    rather than assertions: a drive that was never made records nothing on any
    board, so a silent refusal is indistinguishable from a passing test, while
    an exception names the reason wherever it happens. `BoardInterlockCase`
    below is the same interlock for the shape that RECORDS a refusal instead
    (the criteria suite, whose drives are built once and asserted later).
    """
    if Path(project_dir).resolve() == REPO_ROOT:
        raise RuntimeError(
            f"refusing to declare a board at {REPO_ROOT}: that file is the "
            f"OPERATOR's own connection, and a fixture that wrote it would "
            f"both destroy their setting and make every later drive in this "
            f"checkout resolve a fixture's board "
            f"(test_no_suite_resolves_the_checkout_configuration.py).")
    declare_board(Path(project_dir) / "crucible.toml", board)
    resolves, reason = would_resolve(CLIENTS_DIR / "_crucible_axi.py",
                                     project_dir, board)
    if not resolves:
        raise RuntimeError(
            f"refusing to drive {label}: {reason}. A drive that does not "
            f"resolve its own declared board lands on whatever board the "
            f"install declares instead -- for a client run out of this "
            f"checkout, the operator's own -- or refuses.")
    return board


def drive_verb(script_path, argv, project_dir, fake_bin_dir, timeout=20,
               extra_env=None, board=_UNREACHABLE_CRUCIBLE_URL):
    """A genuine subprocess dispatch of the real client script -- never an
    in-process `module.main()` call for this half (that idiom is reserved
    for enumeration, which must never let a command actually run).

    `board` (CR-CRU-139 §S2) is DECLARED in the drive's own project directory
    rather than exported: the fleet's target is `[client] url` in the project's
    `crucible.toml` now, and the environment channel this fixture used to aim
    is retired. The declaration is written into the temp project root every
    drive owns, and the INTERLOCK below refuses to spawn unless the shared
    module really resolves it -- a drive that merely stopped steering would
    otherwise land on the install's board, which for a client run out of this
    checkout is the operator's own.

    `extra_env` (CR-CRU-092 §S6) overrides the drive's environment. The default
    unreachable board can only ever exercise a verb's READ-FAILURE path, which
    is a fair census for a write verb but cannot measure a READ verb's
    live-data principles (P2/P4/P5/P8 all need an answer to narrow, count,
    drain or return). `next`'s section below points the same `drive_verb` at a
    local queue STUB with `board=`, and leaves the default unreachable one in
    place for its own failed-read drive -- so both halves of AC13's exit-code
    rule are measured by one machinery."""
    declare_and_require_board(project_dir, board, Path(script_path).name)
    env = os.environ.copy()
    for name in ("CRUCIBLE_URL", "CRUCIBLE_BASE"):
        # Retired (CR-CRU-139 §S2), and POPPED rather than aimed: an ambient
        # value in the operator's own session must not reach a drive whose
        # board is now a file.
        env.pop(name, None)
    env["ARDUINO_CLI"] = str(fake_bin_dir / "arduino-cli")
    env["PATH"] = str(fake_bin_dir) + os.pathsep + env.get("PATH", "")
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, str(script_path)] + argv,
        cwd=str(project_dir), env=env, capture_output=True, text=True,
        timeout=timeout,
    )


def classify_envelope(stdout_text, toon_module):
    """True iff `stdout_text` decodes as TOON to a dict carrying a top-level
    `axi` object that itself carries `verb` and `ok` -- the fleet's own
    established §S1 envelope shape (never a bare "something decoded"
    check, which would also pass for an unrelated TOON table)."""
    text = (stdout_text or "").strip()
    if not text:
        return False, None
    try:
        decoded = toon_module.decode(text)
    except Exception:
        return False, None
    if not isinstance(decoded, dict) or "axi" not in decoded:
        return False, None
    axi = decoded["axi"]
    if not isinstance(axi, dict) or "verb" not in axi or "ok" not in axi:
        return False, None
    return True, axi


# The queue table, in the `docs/changes/README.md` shape `parse_queue_table`
# reads. The ids belong to NO project: this fixture drives a genuine POST, and
# a real board's CR ids in it would be a claim about that board's queue. The
# parser is namespace-agnostic by construction (it normalises a bare `001` to
# THIS row's own prefix), which is exactly what the second row exercises.
_QUEUE_TABLE_HEADER = ("| CR | Title | Wave | Depends on |\n"
                       "|---|---|---|---|\n")

_QUEUE_TABLE_ROWS = (
    "| [QF-CENSUS-001](./QF-CENSUS-001.md) | first queued item | 5 | — |\n"
    "| [QF-CENSUS-002](./QF-CENSUS-002.md) | second queued item | 6 | 001 |\n"
)
