"""The helpers of `test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active.py` that other modules import,
moved out of that test module so no module imports a test module for a
helper (CR-CRU-262). Holds no `TestCase` and no test.
"""

import json as _json
import sys
import tempfile
from pathlib import Path

from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _FAKE_TOOLS,
    enumerate_verbs,
    seed_eda_run,
)


TIERS = ("unit", "module", "integration", "e2e", "bdd")

# Every verb, fleet-wide, that files a run or a compile/lint result. A client
# covers the ones its own argparse registers.
FILING_VERBS = (("test", "regression") + TIERS
                + ("check", "compile", "auto-ingest", "pre-merge-gate",
                   "smoke-test", "docker-e2e-gate", "clippy", "workspace-clippy",
                   "workspace-regression", "regression-ingest", "lint"))

INVOCATION_LOG = "invocations.log"

# Inserted after the fake `cargo`'s shebang, before its log line: the rust
# client reads `cargo nextest --version` before anything else runs, and that
# read builds and runs nothing, so it is answered (as nextest 0.9.130 answers
# it, `tests/client/fake_nextest.py`) and not logged as an invocation.
_CARGO_VERSION_SNIPPET = (
    "import sys as _vs\n"
    "if _vs.argv[1:3] in (['nextest', '--version'], ['nextest', '-V']):\n"
    f"    _vs.path.insert(0, {str(Path(__file__).resolve().parents[0])!r})\n"
    "    import fake_nextest as _vf\n"
    "    _vs.exit(_vf.preliminary(_vs.argv[1:], []))\n"
)

# Inserted after each fake tool's shebang: one line per invocation, in the
# tool's own bin directory, so a drive can be asked whether anything ran.
_LOG_SNIPPET = (
    "import os as _o, sys as _s\n"
    "with open(_o.path.join(_o.path.dirname(_o.path.abspath(__file__)), "
    f"{INVOCATION_LOG!r}), 'a') as _f:\n"
    "    _f.write(_o.path.basename(_s.argv[0]) + ' ' + ' '.join(_s.argv[1:]) + '\\n')\n"
)

# Each compile, typecheck and lint step FAILS with its tool's own error shape;
# every other invocation keeps the stock fake's behaviour.
_FAIL_SNIPPETS = {
    "cargo": (
        "if 'clippy' in _s.argv[1:] or _s.argv[1:2] == ['check']:\n"
        "    _s.stderr.write('error[E0425]: cannot find value `undeclared` in this scope\\n'\n"
        "                    ' --> src/lib.rs:1:1\\n')\n"
        "    _s.exit(101)\n"),
    "bun": (
        "if _s.argv[1:3] == ['x', 'tsc']:\n"
        "    _s.stdout.write(\"src/probe.ts(1,1): error TS2304: Cannot find name 'undeclared'.\\n\")\n"
        "    _s.exit(2)\n"),
    "mvn": (
        "if 'test-compile' in _s.argv[1:]:\n"
        "    _s.stdout.write('[ERROR] /src/main/java/Probe.java:[1,1] cannot find symbol\\n')\n"
        "    _s.exit(1)\n"),
    "arduino-cli": (
        "if 'compile' in _s.argv[1:]:\n"
        "    _s.stdout.write(\"probe.ino:1:1: error: 'undeclared' was not declared in this scope\\n\")\n"
        "    _s.exit(1)\n"),
}

_PYTHON_WRAPPER = "python-recorded"

_JUNIT_ONE_GREEN = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="Probe" tests="1" failures="0" errors="0">'
    '<testcase classname="Probe" name="probe" time="0.001"/>'
    '</testsuite>'
)

SEEDED_REPORTS = "seeded-reports"


def _build_recording_bin_dir():
    """The stock fakes, each recording its invocations, with every compile,
    typecheck and lint step failing — plus a recorded python that runs the
    real interpreter, for the python client."""
    bin_dir = Path(tempfile.mkdtemp(prefix="every-verb-refused-bin-"))
    for name, body in _FAKE_TOOLS.items():
        shebang, rest = body.split("\n", 1)
        path = bin_dir / name
        path.write_text(shebang + "\n"
                        + (_CARGO_VERSION_SNIPPET if name == "cargo" else "")
                        + _LOG_SNIPPET + _FAIL_SNIPPETS.get(name, "") + rest)
        path.chmod(0o755)
    wrapper = bin_dir / _PYTHON_WRAPPER
    wrapper.write_text(
        "#!/usr/bin/env python3\n" + _LOG_SNIPPET
        + f"_o.execv({sys.executable!r}, [{sys.executable!r}] + _s.argv[1:])\n")
    wrapper.chmod(0o755)
    return bin_dir


def _invocations(bin_dir):
    log = Path(bin_dir) / INVOCATION_LOG
    return log.read_text().splitlines() if log.exists() else []


def _seed(client_key, verb, project_dir):
    """What a drive needs beyond the census's project: a declared target for a
    tier verb, a report for an ingest-only verb, a source that does not
    compile for python's py_compile step. Returns the extra argv."""
    d = Path(project_dir)
    extra = []
    if client_key == "python":
        (d / "app").mkdir(exist_ok=True)
        (d / "app" / "broken.py").write_text("def broken(:\n")
        if verb in TIERS:
            extra += ["--start-dir", "tests"]
    if verb in TIERS:
        if client_key == "bun":
            (d / "package.json").write_text(_json.dumps(
                {"name": "probe", "scripts": {f"test:{verb}": "bun test"}}))
        elif client_key == "mvn":
            (d / "pom.xml").write_text(
                f"<project><profiles><profile><id>{verb}</id></profile>"
                f"</profiles></project>")
        elif client_key == "rust":
            (d / ".config").mkdir(exist_ok=True)
            (d / ".config" / "nextest.toml").write_text(
                f'[profile.{verb}]\n\n[profile.{verb}.junit]\npath = "junit.xml"\n')
        elif client_key == "arduino":
            (d / "tests" / "native" / "Makefile").write_text(f"junit-{verb}:\n\t@true\n")
        elif client_key == "go":
            # go declares a tier by build tag: a `_test.go` file under
            # `//go:build <tier>` that declares a test.
            (d / f"{verb}_probe_test.go").write_text(
                f'//go:build {verb}\n\npackage probe\n\nimport "testing"\n\n'
                f'func Test_{verb}_tier_probe(t *testing.T) {{}}\n')
    if client_key == "eda":
        extra += seed_eda_run(d, verb)
    if verb == "auto-ingest" and client_key in ("python", "bun", "arduino", "eda"):
        reports = d / SEEDED_REPORTS
        reports.mkdir(exist_ok=True)
        name = "junit.xml" if client_key == "bun" else "TEST-Probe.xml"
        (reports / name).write_text(_JUNIT_ONE_GREEN)
        extra += ["--reports", str(reports)]
    return extra


def _filing_verbs(client_key):
    verbs = enumerate_verbs(client_key, CLIENT_FILES[client_key])
    return {v: verbs[v] for v in FILING_VERBS if v in verbs}
