"""CR-CRU-058 C1 (§S0) -- THE DETECTOR, built BEFORE any fix (gap-analysis
ruling, 2026-08-02).

Why this file exists, verbatim from the CR's own words: "'which verbs emit
an envelope' cannot be answered by grep. Three separate source-pattern
sweeps gave three wrong answers -- the first flagged all 21 bun verbs as
bare (including `status`, which demonstrably emits); a corrected run
mis-scored `arduino cmd_compile` as bare (it emits via `_compile_gate`);
and delegation chains run 2-4 hops deep (`cmd_unit -> _run_surefire_tier ->
_smart_ingest -> _ingest_parsed`) with the emitter sometimes at the end and
sometimes absent." So this module does NOT grep. It:

  1. ENUMERATES every verb of all five clients from their REAL argparse --
     never a hand-written list (`enumerate_verbs` below): it loads each
     client module fresh, monkeypatches `argparse.ArgumentParser.parse_args`
     to CAPTURE the fully-built top-level parser the instant `main()` calls
     it (confirmed by reading all five `main()` bodies: each calls
     `p.parse_args()` exactly ONCE, with no argv, right before dispatch),
     and aborts BEFORE any subcommand ever runs. The captured parser's
     `_SubParsersAction.choices` IS the verb list -- argparse's own ground
     truth, immune to a stale hand-list going stale the moment a verb is
     added (the exact failure mode this CR exists to prevent).

  2. DRIVES every enumerated verb for real: a genuine `subprocess.run` of
     `python3 <client>-crucible.py <verb> <minimal-real-argv>` (never an
     in-process `module.main()` call) -- so delegation depth, `_ops()`/
     `_axi()` indirection, and stdout/stderr routing are all exercised
     exactly as a real caller would see them. `build_argv` fills every
     REQUIRED option (read off the same real argparse actions) with a
     deterministic dummy value, always supplies `--agent` (reaching the
     verb's real ingest logic rather than only its read-only/no-op path),
     and never forces a boolean flag on -- the closest-to-normal-operation
     invocation.

  3. STUBS every external toolchain the fleet shells out to (`cargo`,
     `docker`, `mvn`, `bun`, `arduino-cli`, `make`, `no-mistakes`) with tiny
     fake executables on a PATH-prepended scratch bin dir, following the
     exact fake-tool-on-PATH idiom already used by
     `test_rust_crucible_axi.py` / `test_mvn_crucible_axi.py` (chmod +x
     scripts, PATH-prepended, restored after). Each fake tool writes a
     minimal valid JUnit/lcov artifact at the conventional path its real
     counterpart would have used (so the ingest/parse/envelope code path is
     genuinely reached, not merely the process-spawn), and none of them
     touches a real cargo/docker/mvn/bun/arduino-cli install even if one
     happens to be present on this machine. `CRUCIBLE_URL` is pointed at
     `http://127.0.0.1:1` (nothing listens there) for every drive -- the
     live :3849 dashboard is NEVER touched, and the fleet's own
     `http_request` already turns a connection refusal into a structured
     `{"ok": False, "error": ...}` (verified by reading it), so an
     unreachable server is a REALISTIC failure path, not a skip.

  4. CLASSIFIES: decode stdout as TOON; "emits an envelope" means the
     decoded dict has a top-level `axi` key that is itself a dict carrying
     `verb` and `ok` -- the fleet's own established envelope shape, not a
     bare "some text decoded" check.

RED-vs-analysis note (precedent: `test_cr054_fleet_inventory.py`'s own
module docstring, same repo, same kind of cycle): this is an S0
MEASURING-INSTRUMENT cycle -- no production code changes. Every test below
is expected to PASS TODAY: the primary deliverable is a TRUTHFUL CENSUS
("report, do not assert a target yet" -- the CR's own §S0 wording), plus a
handful of assertions on facts already independently confirmed by reading
the actual function bodies (cited in each test's docstring) so the census
is falsifiable rather than a static snapshot nobody re-checks. Cycle 2's
§S1 fix list is scoped from THIS file's own numbers, not the CR Context
section's original hand-traced guess of "nine rust verbs".
"""

import argparse
import importlib.util
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
TOON_PATH = CLIENTS_DIR / "toon.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
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
_SUREFIRE_JUNIT_ONE_PASS = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="DetectorProbeTest" tests="1" failures="0" errors="0">'
    '<testcase classname="DetectorProbeTest" name="probe" time="0.001"/>'
    '</testsuite>'
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

_FAKE_CARGO_BODY = r'''#!/usr/bin/env python3
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
'''

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
for kind in ("surefire-reports", "failsafe-reports"):
    d = os.path.join("target", kind)
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

_FAKE_TOOLS = {
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


def drive_verb(script_path, argv, project_dir, fake_bin_dir, timeout=20):
    """A genuine subprocess dispatch of the real client script -- never an
    in-process `module.main()` call for this half (that idiom is reserved
    for enumeration, which must never let a command actually run)."""
    env = os.environ.copy()
    env["CRUCIBLE_URL"] = _UNREACHABLE_CRUCIBLE_URL
    env["CRUCIBLE_BASE"] = _UNREACHABLE_CRUCIBLE_URL  # arduino's 2nd-choice var
    env["ARDUINO_CLI"] = str(fake_bin_dir / "arduino-cli")
    env["PATH"] = str(fake_bin_dir) + os.pathsep + env.get("PATH", "")
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


_CENSUS_CACHE = None


def _get_census():
    """Drive EVERY enumerated verb of ALL FIVE clients exactly once, cached
    at module scope for the process lifetime of this test run so the ~10
    test methods below share one census instead of each re-driving ~140
    subprocesses.

    `per_verb[verb_name]` is the decoded `axi` dict when the verb emits an
    envelope, or `None` when it does not -- CR-CRU-058 C2 widened this from
    a bare bool so cycle-2 tests can assert the SPECIFIC envelope content
    (e.g. `ok is False`), not just "something got enveloped". This is
    truthy-compatible with every existing bool-style check in this file
    (`if per_verb[v]`, `not per_verb[v]`, `.get(v)`): a non-empty axi dict
    (it always carries at least `verb`/`ok`) is truthy exactly where `True`
    was, and `None` is falsy exactly where `False` was."""
    global _CENSUS_CACHE
    if _CENSUS_CACHE is not None:
        return _CENSUS_CACHE
    fake_bin_dir = _build_fake_bin_dir()
    toon_module = _load_toon_module()
    census = {}
    try:
        for client_key, script_path in CLIENT_FILES.items():
            project_dir = _make_project_dir(client_key)
            try:
                verbs = enumerate_verbs(client_key, script_path)
                per_verb = {}
                for verb_name, subparser in verbs.items():
                    argv = build_argv(verb_name, subparser, project_dir)
                    result = drive_verb(script_path, argv, project_dir, fake_bin_dir)
                    emits, axi = classify_envelope(result.stdout, toon_module)
                    per_verb[verb_name] = axi if emits else None
                census[client_key] = per_verb
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _CENSUS_CACHE = census
    return census


class EnvelopeDetectorNonVacuityTest(unittest.TestCase):
    """§S0 requirement 4's non-vacuity proof: the detector must find a REAL
    envelope for verbs it is guaranteed to see one from. If either test
    below failed, EVERY "no envelope" verdict in `EnvelopeCensusTest` would
    be worthless -- a broken decoder / argv builder / subprocess-dispatch
    wiring reads as universal bare-ness indistinguishable from real drift."""

    @classmethod
    def setUpClass(cls):
        cls.census = _get_census()

    def test_status_emits_a_real_envelope_in_all_five_clients(self):
        """`status` is the CR's OWN named known-good baseline (§S0: "the
        first flagged all 21 bun verbs as bare, including `status`, which
        demonstrably emits")."""
        offenders = {c: v.get("status") for c, v in self.census.items()
                     if not v.get("status")}
        self.assertEqual(
            offenders, {},
            f"'status' must show enveloped in every client -- the CR's own "
            f"named non-vacuity baseline; a miss here means the DETECTOR "
            f"is broken, not the fleet: {offenders!r}")

    def test_register_emits_a_real_envelope_in_all_five_clients_even_when_refused(self):
        """A second, independent non-vacuity signal, through a FAILURE path
        this time: `register`'s shared implementation emits the §S1
        envelope even on a connection refusal (already proven per-client by
        the sibling `test_*_crucible_axi.py::*Test::test_register_409_refusal
        _envelope_surfaced_faithfully` suites) -- confirms the detector
        reads a real envelope through an `ok:false` path too, not only a
        lucky success path."""
        offenders = {c: v.get("register") for c, v in self.census.items()
                     if not v.get("register")}
        self.assertEqual(offenders, {})


class EnvelopeCensusTest(unittest.TestCase):
    """§S0's primary deliverable: drive every real verb of all five clients
    and assert only facts already independently confirmed by reading the
    actual function bodies (cited per test) -- a TRUTHFUL CENSUS, not a
    wall of red (§S0 requirement 4: "assert only what is already true")."""

    @classmethod
    def setUpClass(cls):
        cls.census = _get_census()

    def test_census_covers_all_five_clients_with_at_least_one_verb_each(self):
        self.assertEqual(
            set(self.census), set(CLIENT_FILES),
            "the census must cover exactly the fleet's five clients")
        empty = {c: v for c, v in self.census.items() if not v}
        self.assertEqual(
            empty, {},
            f"every client must expose at least one enumerated verb (an "
            f"empty entry means enumeration broke for that client, not "
            f"that it legitimately has zero verbs): {empty!r}")

    def test_rust_nine_verbs_confirmed_enveloped(self):
        """CR-CRU-058 §S3 re-point (this is the RED-cycle predecessor
        test's inversion, not a new finding -- C1/C2's
        `test_rust_nine_verbs_confirmed_envelope_less` pinned the nine
        rust verbs the CR's Context table (hand-traced) named as bare:
        `cmd_regression_ingest`/`_regression_ingest_run`,
        `_workspace_regression_run` (via `cmd_workspace_regression`),
        `cmd_pre_merge_gate`, `cmd_clippy`, `cmd_workspace_clippy` (via
        `_clippy_workspace_gate`), `cmd_smoke_test`, `cmd_docker_up`,
        `cmd_docker_down` and `cmd_docker_e2e_gate`. C3 GREEN-a gave every
        one of them a shared-emitter `_emit_axi` call (confirmed by
        reading each body: none end in a bare `print(...)` any more).
        Never silently -- this re-point asserts the fix, and additionally
        that rust's fleet-wide bare count is now exactly zero, so a future
        regression that re-bares even ONE of these nine is caught even if
        it happens to leave the other eight enveloped."""
        expected_now_enveloped = {
            "regression-ingest", "workspace-regression", "pre-merge-gate",
            "clippy", "workspace-clippy", "smoke-test", "docker-up",
            "docker-down", "docker-e2e-gate",
        }
        rust = self.census["rust"]
        missing_from_enumeration = expected_now_enveloped - set(rust)
        self.assertEqual(
            missing_from_enumeration, set(),
            f"the CR's nine named rust verbs must all still exist in "
            f"rust's argparse: missing {missing_from_enumeration!r}")
        still_bare = {v for v in expected_now_enveloped if not rust.get(v)}
        self.assertEqual(
            still_bare, set(),
            f"the CR's nine rust verbs must all show ENVELOPED (a "
            f"decodable 'axi:' with the right verb) after C3 GREEN-a's "
            f"shared-emitter fix -- any verb here means it regressed back "
            f"to bare: {still_bare!r}")
        for verb in expected_now_enveloped:
            axi = rust.get(verb)
            self.assertEqual(
                axi.get("verb"), verb,
                f"rust's {verb!r} envelope must carry verb={verb!r}, got "
                f"{axi.get('verb')!r}")
        fleet_bare = {v for v, ok in rust.items() if not ok}
        self.assertEqual(
            fleet_bare, set(),
            f"rust's fleet-wide envelope census must now be zero bare "
            f"(CR-CRU-058 C3 GREEN-a: rust census 9 -> 0): {fleet_bare!r}")

    def test_rust_check_and_clippy_both_confirmed_enveloped(self):
        """CR-CRU-058 §S3 re-point (inversion of C1/C2's
        `test_rust_check_confirmed_enveloped_unlike_its_clippy_sibling`,
        which pinned an asymmetry: `cmd_check` already called
        `_emit_axi` while `cmd_clippy` was a plain `print(...)` with no
        emitter at all). C3 GREEN-a closed that gap -- `cmd_clippy` now
        also ends in a real `_emit_axi("clippy", ok, ...)` call (confirmed
        by reading its body). The asymmetry this test used to document is
        gone; re-pointed to assert BOTH verbs emit, never silently
        loosened back to only checking one side."""
        check_axi = self.census["rust"].get("check")
        clippy_axi = self.census["rust"].get("clippy")
        self.assertTrue(
            check_axi,
            "rust's 'check' verb calls _emit_axi directly and must show "
            "enveloped")
        self.assertEqual(check_axi.get("verb"), "check")
        self.assertTrue(
            clippy_axi,
            "rust's 'clippy' verb now also calls _emit_axi (C3 GREEN-a) "
            "and must show enveloped, not envelope-less")
        self.assertEqual(clippy_axi.get("verb"), "clippy")

    def test_mvn_unit_module_compile_e2e_confirmed_enveloped(self):
        """CR-CRU-058 §S1 re-point (this is the RED-cycle predecessor test's
        inversion, not a new finding -- C1/C2's
        `test_mvn_unit_module_compile_e2e_confirmed_envelope_less` pinned the
        defect the gap-analysis found, and which the CR's own retracted
        non-goal had put in scope: "mvn cmd_unit/cmd_module reaching a
        print-only _ingest_parsed with no emitter in the chain". The full
        delegation chain `cmd_unit`/`cmd_module` -> `_run_surefire_tier` ->
        `_smart_ingest` -> `_ingest_junit_dir`/`_ingest_parsed` reached no
        `_emit_axi` at any hop, and `cmd_compile`/`cmd_e2e` were two MORE,
        undocumented instances of the identical gap (bare
        `_ingest_compile(...)` / `_ingest_parsed(...)`+`_compile_fallback(...)`
        prints).

        C3 GREEN-b closed all four: each now reaches a real shared-emitter
        `_emit_axi` call. This is a PERMANENT GUARD, never a skip -- it
        asserts the specific envelope content (a decoded `axi` carrying the
        right `verb`) so a future regression that re-bares even ONE of the
        four is caught even if the other three stay enveloped, plus mvn's
        fleet-wide bare count being exactly zero."""
        mvn = self.census["mvn"]
        expected_now_enveloped = ("unit", "module", "compile", "e2e")
        missing_from_enumeration = {v for v in expected_now_enveloped
                                    if v not in mvn}
        self.assertEqual(
            missing_from_enumeration, set(),
            f"the four named mvn verbs must all still exist in mvn's "
            f"argparse: missing {missing_from_enumeration!r}")
        still_bare = {v for v in expected_now_enveloped if not mvn.get(v)}
        self.assertEqual(
            still_bare, set(),
            f"mvn's unit/module/compile/e2e must all show ENVELOPED (a "
            f"decodable 'axi:' with the right verb) after C3 GREEN-b's "
            f"shared-emitter fix -- any verb here means it regressed back "
            f"to a plain-print ingest helper with no _emit_axi: "
            f"{still_bare!r}")
        for verb in expected_now_enveloped:
            axi = mvn[verb]
            self.assertEqual(
                axi.get("verb"), verb,
                f"mvn's {verb!r} envelope must carry verb={verb!r}, got "
                f"{axi.get('verb')!r}")
        fleet_bare = {v for v, ok in mvn.items() if not ok}
        self.assertEqual(
            fleet_bare, set(),
            f"mvn's fleet-wide envelope census must now be zero bare "
            f"(CR-CRU-058 C3 GREEN-b): {fleet_bare!r}")

    def test_mvn_test_and_auto_ingest_confirmed_cleanly_enveloped(self):
        """The asymmetry that makes the finding above interesting: mvn's
        `test`/`auto-ingest` verbs call `_emit_ingest_axi_resp`/
        `_emit_ingest_summary_axi` DIRECTLY (confirmed by reading
        `cmd_test`/`cmd_auto_ingest`), which DO call `_emit_axi`, AND
        (unlike `regression`, see the dedicated stdout-purity test below)
        neither prints anything unguarded to stdout first -- both show a
        clean, single-document envelope. Same toolchain family as
        unit/module, different envelope outcome; only a dynamic drive
        (never grep) tells the two apart."""
        mvn = self.census["mvn"]
        missing = {v for v in ("test", "auto-ingest") if not mvn.get(v)}
        self.assertEqual(
            missing, set(),
            f"mvn's test/auto-ingest must show cleanly enveloped: {missing!r}")

    def test_mvn_regression_stdout_is_now_one_clean_envelope_with_no_prose(self):
        """CR-CRU-058 §S3 re-point (this is the RED-cycle predecessor test's
        inversion, not a new finding -- C1/C2's
        `test_mvn_regression_reaches_the_emitter_but_stdout_purity_is_violated`
        pinned a THIRD, subtler category the census's strict single-document
        decode surfaced: mvn's `_regression_run` DID reach
        `_emit_ingest_summary_axi`, but `print(f"[regression] running: ...")`
        and `print(f"[regression] mvn exit=...")` had no `file=sys.stderr`
        (unlike `cmd_test`'s/`cmd_check`'s equivalent prints two lines below
        each), so the stream was prose-then-envelope -- not "stdout parses as
        a TOON envelope alone", §S3's exact AC wording.

        C3 GREEN-b's fleet-wide stdout-purity sweep moved that prose to
        stderr. This is a PERMANENT GUARD, never a skip: it asserts BOTH
        surfaces, so the fix cannot regress AND cannot be "achieved" by
        deleting the operator-facing prose outright -- stdout must decode as
        exactly one `verb: regression` envelope with no `[regression] ...`
        line anywhere in it, and the human lines must still be present, on
        stderr."""
        result = self._drive_mvn_regression_raw()
        toon_module = _load_toon_module()
        emits, axi = classify_envelope(result.stdout, toon_module)
        self.assertTrue(
            emits,
            f"mvn's regression stdout must now decode as ONE clean TOON "
            f"envelope (§S3's AC: 'stdout parses as a TOON envelope alone'); "
            f"raw stdout was: {result.stdout!r}")
        self.assertEqual(
            axi.get("verb"), "regression",
            f"that single document must be regression's own envelope, got "
            f"verb={axi.get('verb')!r}")
        self.assertNotIn(
            "[regression]", result.stdout,
            f"no '[regression] ...' human line may reach stdout any more "
            f"(the exact pollution §S3 forbids); raw stdout was: "
            f"{result.stdout!r}")
        self.assertTrue(
            self.census["mvn"].get("regression"),
            "the strict single-document census must now read regression as "
            "compliant -- nothing precedes the envelope on stdout")
        self.assertIn(
            "[regression] running:", result.stderr,
            "the prose must have MOVED to stderr, not been deleted -- the "
            "operator-facing 'running: mvn ...' line is still required, on "
            "the human channel")

    def _drive_mvn_regression_raw(self):
        fake_bin_dir = _build_fake_bin_dir()
        try:
            project_dir = _make_project_dir("mvn")
            try:
                script_path = CLIENT_FILES["mvn"]
                verbs = enumerate_verbs("mvn", script_path)
                argv = build_argv("regression", verbs["regression"], project_dir)
                return drive_verb(script_path, argv, project_dir, fake_bin_dir)
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
        finally:
            shutil.rmtree(fake_bin_dir, ignore_errors=True)

    def test_known_shared_verbs_confirmed_enveloped_fleet_wide(self):
        """CR-CRU-054's THE_42 SHARED set delegates straight to
        `_crucible_axi` (verified by that CR's own drift guard, which
        confirms every one of these is a thin `_axi()....`/`.http_request(`
        delegator in every client) -- each must show enveloped everywhere.

        CR-CRU-058 C2 GREEN closed the two gaps this test used to carve
        `milestone`/`cycle-activate`/`cycle-done`/`cr-close` out for: the
        shared `cmd_milestone` now emits unconditionally (see
        `test_milestone_confirmed_enveloped_fleet_wide`, below), and the
        shared `open_plans` now emits an `ok=False` envelope on a
        plans-GET failure instead of a bare `sys.exit` (see
        `test_cycle_transition_and_cr_close_confirmed_ok_false_envelope_on_plans_get_failure`,
        below). All four fold back into this positive guard's own list
        rather than staying excluded from it; the two dedicated tests
        additionally assert the SPECIFIC envelope content (verb/ok) those
        fixes produce, on top of the bare "it's enveloped" check made
        here."""
        shared_verbs = [
            "register", "unregister", "status", "plans", "gate-run",
            "gate-report", "plan-file", "cycle-add", "checkpoint", "stop",
            "abort", "milestone", "cycle-activate", "cycle-done", "cr-close",
        ]
        offenders = {}
        for client, per_verb in self.census.items():
            missing = [v for v in shared_verbs if v in per_verb and not per_verb[v]]
            if missing:
                offenders[client] = missing
        self.assertEqual(
            offenders, {},
            f"every THE_42-SHARED verb must show enveloped in every client "
            f"that defines it: {offenders!r}")

    def test_milestone_confirmed_enveloped_fleet_wide(self):
        """CR-CRU-058 C2 GREEN fix (this is the RED-cycle predecessor test's
        inversion, not a new finding -- C1's `test_milestone_confirmed_envelope_less_fleet_wide`
        pinned the defect; this asserts the fix). `_crucible_axi.cmd_milestone`
        -- THE_42's SHARED implementation ALL FIVE clients delegate to --
        now calls `ops.emit(...)` unconditionally (confirmed by reading its
        body: the interactive `print(..., file=sys.stderr)` line is kept as
        an ADDITION, not a replacement, and an `axi:` envelope now follows
        it on stdout on every outcome, success or failure). Every client
        must show a real envelope for `milestone`: a decoded dict carrying
        `verb == "milestone"` and an `ok` field -- never merely "some text
        decoded", the same strict shape `classify_envelope` already
        enforces for the rest of the fleet."""
        offenders = {}
        for client, per_verb in self.census.items():
            axi = per_verb.get("milestone")
            if not axi or axi.get("verb") != "milestone" or "ok" not in axi:
                offenders[client] = axi
        self.assertEqual(
            offenders, {},
            f"milestone must show a real TOON-AXI envelope (verb='milestone', "
            f"an 'ok' field present) in EVERY client after CR-CRU-058 C2's "
            f"fix to the shared cmd_milestone: {offenders!r}")

    def test_cycle_transition_and_cr_close_confirmed_ok_false_envelope_on_plans_get_failure(self):
        """CR-CRU-058 C2 GREEN fix (inversion of C1's
        `test_cycle_transition_and_cr_close_confirmed_bare_on_plans_get_failure`,
        which pinned the defect this asserts is now closed).
        `_crucible_axi.open_plans` no longer does a bare
        `sys.exit(f"[crucible] ERROR: could not list plans: {{...}}")` on a
        plans-GET failure -- confirmed by reading it, it now emits through
        the caller's `emit_fn` with `ok=False`, matching the sibling
        `resolve_plan_or_emit` helper (used by cycle-add/checkpoint/abort)
        that already did this correctly. `cycle-activate`/`cycle-done` (via
        the shared `cycle_transition`) and `cr-close` (via `cmd_cr_close`)
        all resolve their target plan through this SAME shared
        `open_plans`, so this must hold fleet-wide: driven under the
        census's unreachable CRUCIBLE_URL (a genuine plans-GET failure),
        each of the three verbs must decode as a TOON envelope carrying
        `ok is False` -- not merely "enveloped", the specific outcome value
        the fix produces."""
        affected = ("cycle-activate", "cycle-done", "cr-close")
        offenders = {}
        for client, per_verb in self.census.items():
            for verb in affected:
                axi = per_verb.get(verb)
                if not axi or axi.get("ok") is not False:
                    offenders.setdefault(client, []).append((verb, axi))
        self.assertEqual(
            offenders, {},
            f"cycle-activate/cycle-done/cr-close must show an enveloped "
            f"ok=False result under a plans-GET failure in every client "
            f"(the gap CR-CRU-058 C2 closed in the shared open_plans): "
            f"{offenders!r}")

    def test_fleet_wide_envelope_less_count_and_full_table(self):
        """The primary deliverable (§S0 requirement 4): PRINT the complete
        per-client verb -> envelope table and the fleet-wide envelope-less
        count, so the next cycle's §S1 fix list is scoped from these real
        numbers rather than the CR's original hand-traced guess of "nine
        rust verbs". Asserts only that the census measured something --
        every other assertion in this class already covers correctness;
        this test's job is to REPORT."""
        total_verbs = 0
        total_bare = 0
        lines = ["", "=" * 72,
                 "CR-CRU-058 §S0 -- fleet-wide TOON-AXI envelope census",
                 "=" * 72]
        for client in sorted(self.census):
            per_verb = self.census[client]
            bare = sorted(v for v, ok in per_verb.items() if not ok)
            total_verbs += len(per_verb)
            total_bare += len(bare)
            lines.append(f"\n{client} ({len(per_verb)} verbs, "
                         f"{len(bare)} envelope-less):")
            for verb in sorted(per_verb):
                mark = "envelope" if per_verb[verb] else "BARE"
                lines.append(f"  {verb:<20s} {mark}")
        lines.append(f"\nFLEET TOTAL: {total_verbs} verbs measured, "
                     f"{total_bare} envelope-less")
        lines.append("=" * 72)
        print("\n".join(lines))
        self.assertGreater(
            total_verbs, 0, "the census must have measured at least one verb")


class UnmeasurableVerbClassificationTest(unittest.TestCase):
    """§S0 requirement 5: where a verb legitimately cannot produce an
    envelope, classify it explicitly rather than silently counting it as a
    failure. The fleet has exactly two structural reasons a verb COULD be
    legitimately unmeasurable: (a) it replaces the process image
    (`os.exec*`) so control never returns to print anything further, or
    (b) it is a bare `--help`/`-h` (argparse's own built-in auto-exit,
    never a registered subcommand). Both are swept and confirmed absent
    below -- FINDING: zero verbs in the current fleet require this
    carve-out; every verb `enumerate_verbs` finds is measurable by
    `drive_verb`."""

    def test_no_client_source_calls_os_exec(self):
        offenders = {c: True for c, p in CLIENT_FILES.items()
                     if "os.exec" in p.read_text()}
        self.assertEqual(
            offenders, {},
            f"a verb that os.exec's into another process replaces this "
            f"process image and could never print an envelope afterward -- "
            f"none exist today, so none needed the unmeasurable carve-out: "
            f"{offenders!r}")

    def test_help_is_never_enumerated_as_a_verb(self):
        census = _get_census()
        offenders = {c: [v for v in per_verb if v in ("help", "-h", "--help")]
                     for c, per_verb in census.items()}
        offenders = {c: v for c, v in offenders.items() if v}
        self.assertEqual(
            offenders, {},
            f"--help/-h must never appear as an enumerated verb (argparse's "
            f"own auto-exit is not a registered subcommand): {offenders!r}")


# ── CR-CRU-058 §S4 -- the guard's own proof-of-capability ──────────────────
#
# AC (verbatim): "The §S4 guard fails when a verb is added without an
# envelope -- proven by adding one temporarily." A guard nobody has watched
# fail is a guard nobody knows works -- the entire lesson of this CR: three
# separate grep sweeps gave three wrong answers, and only DRIVING the code
# found the truth. The two classes below apply that same skepticism to the
# detector itself, rather than trusting "the fleet census currently reads
# zero" as proof the machinery works.
#
# `SyntheticSourceEnvelopeDetectorProofTest` builds a client-shaped module
# the detector has never seen. `RealClientCopyEnvelopeDetectorProofTest`
# mirrors CR-CRU-054 §S3's own on-scratch-disk proof
# (`DriftGuardCatchesReintroducedDuplicateOnScratchFilesTest`, in the sibling
# `test_cr054_drift_guard.py`): copy a REAL client into a tmpdir and append a
# genuinely bare verb, never touching `clients/` itself. Both drive the EXACT
# SAME `enumerate_verbs`/`build_argv`/`drive_verb`/`classify_envelope`
# machinery `_get_census()` uses above -- proving the machinery detects a
# bare verb, not merely that today's fleet happens to be clean. These tests
# are expected to PASS on arrival: the capability they assert already
# exists; that is correct for a proof-of-capability cycle.
#
# These two classes are kept in THIS file, not a sibling, because -- unlike
# CR-054 §S3's split (a classification-DATA fixture vs. its own enforcement
# mechanism) -- the thing under proof here IS this file's own machinery
# (`enumerate_verbs`, `build_argv`, `drive_verb`, `classify_envelope`,
# `CLIENT_FILES`, `_build_fake_bin_dir`, `_make_project_dir`). Reusing those
# functions directly, rather than re-loading them by path into a second
# module, keeps the proof and the thing it proves from ever silently
# drifting apart.

_SYNTHETIC_CLIENT_SOURCE = r'''#!/usr/bin/env python3
"""A client-shaped module the detector has never seen -- built ONLY for
CR-CRU-058 SS4's proof-of-capability, never imported by anything else."""

import argparse
import importlib.util
import sys
from pathlib import Path


def _toon():
    """Loads the REAL toon.py copied alongside this script (never a
    hand-rolled TOON string) so the emitted envelope is genuinely
    round-trippable, exactly like a real client's own bootstrap loader."""
    toon_path = Path(__file__).resolve().parent / "toon.py"
    spec = importlib.util.spec_from_file_location("synthetic_toon_under_proof", toon_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(prog="synthetic-crucible")
    sub = parser.add_subparsers(dest="verb")

    bare = sub.add_parser("bare-verb")
    bare.add_argument("--agent")

    enveloped = sub.add_parser("enveloped-verb")
    enveloped.add_argument("--agent")

    args = parser.parse_args()

    if args.verb == "bare-verb":
        # Exactly the shape a careless toolchain-verb addition takes: a
        # human-readable line, no axi: block, no emitter call anywhere.
        print("synthetic: bare-verb ran fine, nothing structured here")
        sys.exit(0)
    elif args.verb == "enveloped-verb":
        axi = {"verb": "enveloped-verb", "ok": True, "context": {}, "warnings": []}
        sys.stdout.write(_toon().encode({"axi": axi}) + "\n")
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
'''

_SCRATCH_BARE_VERB_FUNCTION_SOURCE = '''
def cmd_cr058_scratch_bare_verb(args):
    """A genuinely bare verb, appended ONLY to a scratch tmpdir copy of a
    real client for CR-CRU-058 S4's proof-of-capability -- prints prose, no
    axi: block, no _emit_axi call anywhere in its body. Exactly the shape a
    careless toolchain-verb addition would take."""
    print("cr058-scratch: bare verb ran fine, nothing structured here")
    return 0

'''


class SyntheticSourceEnvelopeDetectorProofTest(unittest.TestCase):
    """§S4 AC, first half: the SAME machinery `_get_census()` drives above,
    pointed at a client-shaped module the detector has never seen -- proves
    the DETECTOR's capability, not merely today's fleet snapshot."""

    @classmethod
    def setUpClass(cls):
        cls.tmp_dir = Path(tempfile.mkdtemp(prefix="cr058-s4-synthetic-"))
        cls.script_path = cls.tmp_dir / "synthetic-crucible.py"
        cls.script_path.write_text(_SYNTHETIC_CLIENT_SOURCE)
        shutil.copy(TOON_PATH, cls.tmp_dir / "toon.py")
        cls.toon_module = _load_toon_module()
        cls.fake_bin_dir = _build_fake_bin_dir()
        cls.project_dir = Path(tempfile.mkdtemp(prefix="cr058-s4-synthetic-project-"))
        cls.verbs = enumerate_verbs("synthetic", cls.script_path)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp_dir, ignore_errors=True)
        shutil.rmtree(cls.fake_bin_dir, ignore_errors=True)
        shutil.rmtree(cls.project_dir, ignore_errors=True)

    def test_enumeration_finds_both_synthetic_verbs_from_its_own_real_argparse(self):
        self.assertEqual(
            set(self.verbs), {"bare-verb", "enveloped-verb"},
            f"enumerate_verbs must read the synthetic module's OWN argparse "
            f"choices, not a hardcoded list: got {sorted(self.verbs)!r}")

    def test_synthetic_bare_verb_is_flagged_envelope_less_by_the_real_detector(self):
        argv = build_argv("bare-verb", self.verbs["bare-verb"], self.project_dir)
        result = drive_verb(self.script_path, argv, self.project_dir, self.fake_bin_dir)
        emits, axi = classify_envelope(result.stdout, self.toon_module)
        self.assertFalse(
            emits,
            f"the synthetic bare-verb prints prose only, no axi: block -- "
            f"the detector must classify it envelope-less, proving the "
            f"machinery detects a bare verb rather than merely reporting "
            f"today's fleet as clean; raw stdout was {result.stdout!r}, "
            f"exit code {result.returncode}, stderr {result.stderr!r}")
        self.assertIsNone(axi)

    def test_synthetic_enveloped_verb_is_not_flagged_positive_control(self):
        """Requirement 3's positive control, in this same file: a verb that
        genuinely emits (through the REAL toon encoder, not a hand-rolled
        string) must NOT be flagged -- otherwise a detector that flagged
        everything would also have passed the test above."""
        argv = build_argv("enveloped-verb", self.verbs["enveloped-verb"], self.project_dir)
        result = drive_verb(self.script_path, argv, self.project_dir, self.fake_bin_dir)
        emits, axi = classify_envelope(result.stdout, self.toon_module)
        self.assertTrue(
            emits,
            f"the synthetic enveloped-verb emits a real axi: block through "
            f"the real toon encoder -- it must NOT be flagged envelope-less; "
            f"raw stdout was {result.stdout!r}")
        self.assertEqual(axi.get("verb"), "enveloped-verb")
        self.assertIs(axi.get("ok"), True)


class RealClientCopyEnvelopeDetectorProofTest(unittest.TestCase):
    """§S4 AC, second half: mirrors CR-CRU-054 §S3's own on-disk proof
    (`DriftGuardCatchesReintroducedDuplicateOnScratchFilesTest`) -- copy a
    REAL client (python) plus its two sibling shared modules into a scratch
    tmpdir, append a genuinely bare verb to its argparse + dispatch, and
    drive it through the SAME detector machinery. `clients/` itself is never
    touched -- confirmed below."""

    @classmethod
    def setUpClass(cls):
        cls.original_python_source = CLIENT_FILES["python"].read_text()
        assert cls.original_python_source.count("def main():") == 1, (
            "python-crucible.py's main() shape changed -- update this "
            "proof's insertion point")
        assert "    args = p.parse_args()" in cls.original_python_source, (
            "python-crucible.py's dispatch shape changed -- update this "
            "proof's insertion point")

        cls.tmp_dir = Path(tempfile.mkdtemp(prefix="cr058-s4-real-copy-"))
        shutil.copy(CLIENTS_DIR / "_crucible_axi.py", cls.tmp_dir / "_crucible_axi.py")
        shutil.copy(TOON_PATH, cls.tmp_dir / "toon.py")

        # The bare verb's function definition must sit BEFORE `def main():`
        # in the file: the real client's trailing `if __name__ == "__main__":
        # main()` guard fires during a genuine subprocess drive (unlike
        # enumeration's in-process module load, which calls module.main()
        # explicitly AFTER exec_module already ran top-to-bottom), so the
        # function must already be bound by the time main() references it
        # in set_defaults(func=...).
        patched = cls.original_python_source.replace(
            "def main():",
            _SCRATCH_BARE_VERB_FUNCTION_SOURCE + "\ndef main():",
            1,
        )
        wiring = (
            '    scratch = sub.add_parser("cr058-scratch-bare-verb",\n'
            '                             help="CR-CRU-058 S4 proof-only bare verb")\n'
            '    scratch.add_argument("--agent")\n'
            '    scratch.set_defaults(func=cmd_cr058_scratch_bare_verb)\n\n'
        )
        patched = patched.replace(
            "    args = p.parse_args()", wiring + "    args = p.parse_args()", 1)

        cls.scratch_script = cls.tmp_dir / "scratch-python-crucible.py"
        cls.scratch_script.write_text(patched)

        cls.fake_bin_dir = _build_fake_bin_dir()
        cls.project_dir = _make_project_dir("python")
        cls.toon_module = _load_toon_module()
        cls.pristine_verbs = enumerate_verbs("python", CLIENT_FILES["python"])
        cls.scratch_verbs = enumerate_verbs("scratch-python", cls.scratch_script)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp_dir, ignore_errors=True)
        shutil.rmtree(cls.fake_bin_dir, ignore_errors=True)
        shutil.rmtree(cls.project_dir, ignore_errors=True)

    def test_real_clients_directory_was_never_modified(self):
        self.assertNotIn(
            "cr058-scratch-bare-verb", CLIENT_FILES["python"].read_text(),
            "this proof must never mutate clients/python-crucible.py itself")
        self.assertEqual(
            CLIENT_FILES["python"].read_text(), self.original_python_source,
            "clients/python-crucible.py must be byte-identical before and "
            "after this proof -- only the scratch tmpdir copy is patched")

    def test_enumeration_grows_by_exactly_the_one_appended_verb_with_no_hand_list_to_update(self):
        """Requirement 4: guard the ENUMERATION step too. If `enumerate_verbs`
        read from a hand-maintained list of known verb names instead of the
        real argparse `_SubParsersAction.choices`, `cr058-scratch-bare-verb`
        would have silently gone unmeasured here -- exactly the failure mode
        this whole detector exists to prevent (the CR's own history: three
        grep sweeps gave three wrong answers by reasoning about verbs from
        memory/text, never argparse's own ground truth). A future engineer
        who adds a real verb and never touches this test file still gets it
        measured, because enumeration re-reads the parser fresh every run --
        there is no list here to have forgotten to update."""
        added = set(self.scratch_verbs) - set(self.pristine_verbs)
        removed = set(self.pristine_verbs) - set(self.scratch_verbs)
        self.assertEqual(
            added, {"cr058-scratch-bare-verb"},
            f"the scratch copy's enumerated verbs must be exactly the "
            f"pristine client's verbs plus the one appended verb: "
            f"pristine={sorted(self.pristine_verbs)!r} "
            f"scratch={sorted(self.scratch_verbs)!r}")
        self.assertEqual(
            removed, set(),
            "appending a verb must never make an existing verb vanish from "
            "enumeration")

    def test_appended_bare_verb_is_flagged_envelope_less_on_a_real_client_copy(self):
        argv = build_argv(
            "cr058-scratch-bare-verb", self.scratch_verbs["cr058-scratch-bare-verb"],
            self.project_dir)
        result = drive_verb(self.scratch_script, argv, self.project_dir, self.fake_bin_dir)
        emits, axi = classify_envelope(result.stdout, self.toon_module)
        self.assertFalse(
            emits,
            f"a genuinely bare verb appended to a REAL client copy must be "
            f"flagged envelope-less by the same detector machinery the "
            f"fleet-wide census uses above -- the AC's exact proof ('the "
            f"guard fails when a verb is added without an envelope'); raw "
            f"stdout was {result.stdout!r}, stderr {result.stderr!r}, exit "
            f"code {result.returncode}")
        self.assertIsNone(axi)

    def test_preexisting_status_verb_on_the_same_scratch_copy_is_still_correctly_enveloped(self):
        """Requirement 3's positive control, on REAL (not synthetic) source
        this time: the scratch copy's own pre-existing `status` verb --
        untouched by the append -- must still show enveloped, proving
        detection discriminates on a real client body in both directions,
        not merely alarmist."""
        argv = build_argv("status", self.scratch_verbs["status"], self.project_dir)
        result = drive_verb(self.scratch_script, argv, self.project_dir, self.fake_bin_dir)
        emits, axi = classify_envelope(result.stdout, self.toon_module)
        self.assertTrue(
            emits,
            f"the scratch copy's pre-existing 'status' verb must still show "
            f"enveloped after appending an unrelated bare verb elsewhere in "
            f"the file; raw stdout was {result.stdout!r}")
        self.assertEqual(axi.get("verb"), "status")


# ── CR-CRU-064 §S5 -- the STARVED variant of the seven no-report sites ─────
#
# Extends THIS file's own `drive_verb`/`classify_envelope` pair (never a new
# harness) to cover the starved variant of the seven sites CR-CRU-064 §S2-§S4
# fixed, so a future client cannot add a bare no-report branch without this
# same argparse-driven census machinery catching it -- not only the sibling
# `tests/client/test_toolchain_verb_envelopes.py` suite's own dedicated
# fixtures (which this mirrors: the starved-tool bodies below are the exact
# same starving technique -- a real interpreter/runner that genuinely cannot
# produce a report, never a hand-built envelope, never an in-process call,
# per the CR's own Risk section).

_STARVED_PYTHON_NAME = "starved-python"

_STARVED_PYTHON_BODY = r'''#!/usr/bin/env python3
import os
import sys

# A REAL interpreter that genuinely cannot produce a JUnit report: `-S`
# drops site-packages from sys.path entirely and `-E` drops PYTHONPATH, so
# `-m xmlrunner` / `-m coverage` raise the interpreter's own "No module
# named ..." and exit non-zero. No fake xmlrunner package, no stubbed
# subprocess.
os.execv(sys.executable, [sys.executable, "-S", "-E"] + sys.argv[1:])
'''

_FAIL_BUN_NO_JUNIT_BODY = r'''#!/usr/bin/env python3
import sys
argv = sys.argv[1:]
if argv[:1] == ["test"]:
    # Collection dies before the JUnit reporter writes anything -- the real
    # shape of a starved bun run. Exit 3, so a `detail` naming the RUNNER's
    # code cannot be satisfied by the process's own exit (1).
    sys.stderr.write("error: Cannot find module 'node:nonexistent' from "
                     "'/detector/pkg/index.test.ts'\n")
    sys.exit(3)
sys.exit(0)
'''

_FAIL_MAKE_NO_REPORTS_BODY = r'''#!/usr/bin/env python3
import sys
# `make junit` dies in the compiler: no reports/TEST-*.xml is written.
sys.stderr.write(
    "g++ -std=c++17 -o build/suite tests/native/suite.cpp\n"
    "tests/native/suite.cpp:7:10: fatal error: unity.h: No such file or "
    "directory\n")
sys.exit(2)
'''

NO_REPORT_WARNING_CODE = "no-test-reports"


def _build_bin_dir_with_override(tool_name, body):
    """Same fake-tool-on-PATH idiom as `_build_fake_bin_dir` above, with
    exactly one tool's body swapped for `body` -- the rest of the bin dir
    (or, for a name absent from `_FAKE_TOOLS` such as the starved python
    shim, every tool `_FAKE_TOOLS` already knows PLUS this one addition)
    stays byte-identical to the census's own proven-working default."""
    bin_dir = Path(tempfile.mkdtemp(prefix="cr064-census-starved-bin-"))
    for name, default_body in _FAKE_TOOLS.items():
        text = body if name == tool_name else default_body
        path = bin_dir / name
        path.write_text(text)
        st = os.stat(path)
        os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    if tool_name not in _FAKE_TOOLS:
        path = bin_dir / tool_name
        path.write_text(body)
        st = os.stat(path)
        os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return bin_dir


# (client, verb) -> how to starve that specific site, so no report is ever
# produced. Exactly the CR's Context table: python 3, bun 2, arduino 2.
_SEVEN_SITE_STARVED_SPECS = {
    ("python", "test"): dict(
        bin_dir_factory=lambda: _build_bin_dir_with_override(
            _STARVED_PYTHON_NAME, _STARVED_PYTHON_BODY),
        extra_argv=["--python", _STARVED_PYTHON_NAME],
    ),
    ("python", "regression"): dict(
        bin_dir_factory=lambda: _build_bin_dir_with_override(
            _STARVED_PYTHON_NAME, _STARVED_PYTHON_BODY),
        extra_argv=["--python", _STARVED_PYTHON_NAME],
    ),
    ("python", "auto-ingest"): dict(
        bin_dir_factory=_build_fake_bin_dir,
        extra_argv=[],
    ),
    ("bun", "test"): dict(
        bin_dir_factory=lambda: _build_bin_dir_with_override(
            "bun", _FAIL_BUN_NO_JUNIT_BODY),
        extra_argv=[],
    ),
    ("bun", "regression"): dict(
        bin_dir_factory=lambda: _build_bin_dir_with_override(
            "bun", _FAIL_BUN_NO_JUNIT_BODY),
        extra_argv=[],
    ),
    ("arduino", "test"): dict(
        bin_dir_factory=lambda: _build_bin_dir_with_override(
            "make", _FAIL_MAKE_NO_REPORTS_BODY),
        extra_argv=[],
    ),
    ("arduino", "auto-ingest"): dict(
        bin_dir_factory=_build_fake_bin_dir,
        extra_argv=[],
    ),
}


def _drive_starved_site(client_key, verb_name, bin_dir_factory, extra_argv):
    """One real subprocess drive of the site, through the SAME `enumerate_
    verbs`/`build_argv`/`drive_verb`/`classify_envelope` machinery
    `_get_census()` uses -- never a second harness."""
    fake_bin_dir = bin_dir_factory()
    try:
        toon_module = _load_toon_module()
        project_dir = _make_project_dir(client_key)
        try:
            script_path = CLIENT_FILES[client_key]
            verbs = enumerate_verbs(client_key, script_path)
            argv = build_argv(verb_name, verbs[verb_name], project_dir) + list(extra_argv)
            result = drive_verb(script_path, argv, project_dir, fake_bin_dir)
            emits, axi = classify_envelope(result.stdout, toon_module)
            return emits, axi, result
        finally:
            shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)


_STARVED_SEVEN_CACHE = {}


def _get_starved_seven_site(client_key, verb_name):
    """Cached at module scope for this process, mirroring `_get_census()`'s
    own sharing idiom -- the several independent assertions below drive each
    site once, not once per assertion."""
    key = (client_key, verb_name)
    if key not in _STARVED_SEVEN_CACHE:
        spec = _SEVEN_SITE_STARVED_SPECS[key]
        _STARVED_SEVEN_CACHE[key] = _drive_starved_site(
            client_key, verb_name, spec["bin_dir_factory"], spec["extra_argv"])
    return _STARVED_SEVEN_CACHE[key]


class SevenNoReportSitesStarvedCensusTest(unittest.TestCase):
    """CR-CRU-064 §S5 -- the seven no-report sites §S2-§S4 fixed must show
    ENVELOPED (never bare) when genuinely starved, through THIS file's own
    census machinery -- so a future client that reintroduces a bare
    no-report branch (or a future regression in an existing one) is caught
    here, by the same argparse-driven detector that already guards the
    fleet's happy-path verbs, not only by the sibling fixture-heavy suite."""

    def test_all_seven_no_report_sites_show_enveloped_when_starved(self):
        offenders = {}
        for client, verb in _SEVEN_SITE_STARVED_SPECS:
            emits, axi, result = _get_starved_seven_site(client, verb)
            if not emits:
                offenders[(client, verb)] = result.stdout
        self.assertEqual(
            offenders, {},
            f"every one of the CR's seven no-report sites must show a "
            f"decodable axi: envelope when genuinely starved -- a future "
            f"re-bare of any one of them must fail HERE: {offenders!r}")

    def test_all_seven_no_report_sites_carry_the_no_test_reports_warning_code(self):
        offenders = {}
        for client, verb in _SEVEN_SITE_STARVED_SPECS:
            emits, axi, result = _get_starved_seven_site(client, verb)
            if not emits:
                offenders[(client, verb)] = None
                continue
            codes = {w.get("code") for w in (axi.get("warnings") or [])
                     if isinstance(w, dict)}
            if NO_REPORT_WARNING_CODE not in codes:
                offenders[(client, verb)] = sorted(codes)
        self.assertEqual(
            offenders, {},
            f"every starved no-report site must carry the "
            f"{NO_REPORT_WARNING_CODE!r} warning code specifically -- a "
            f"future client that emits SOME envelope but drops the "
            f"specific warning code must still fail HERE: {offenders!r}")


# ── CR-CRU-091 §S10 / AC19 -- the 25 (verb x client) roadmap pairs ─────────
#
# AC19 is explicit that conformance is asserted by EXTENDING the two existing
# harnesses, never by a parallel checker: verb PRESENCE in the sibling
# `test_cr054_fleet_inventory.py`, and ENVELOPE CONFORMANCE here, through
# THIS file's own `enumerate_verbs`/`build_argv`/`drive_verb`/
# `classify_envelope` machinery -- the same four functions `_get_census()`
# drives, so a roadmap verb cannot be conformant by a different standard than
# the rest of the fleet.
#
# The drives below run under the census's own unreachable CRUCIBLE_URL, which
# is the point: four of the five verbs therefore exercise a real TRANSPORT
# failure (exit 1) and `cr-plan` -- whose `--release`/`--wave` are deliberately
# NOT argparse-required, because §S6 makes the client ASK for them -- exercises
# the USAGE refusal (exit 2) with nothing POSTed. Both are envelope-bearing
# states, so "no server" is a fair census rather than a skipped one.

CR091_ROADMAP_VERBS = (
    "release-propose", "cr-plan", "wave-sequence", "cr-supersede", "cr-void",
)

# §S6/P6 -- the exit each verb owes under an unreachable server: `cr-plan`
# never reaches the wire (the client resolves the undeclared fields itself and
# refuses with the fleet's USAGE code), the other four do and fail transport.
CR091_EXPECTED_EXIT = {
    "release-propose": 1,
    "cr-plan": 2,
    "wave-sequence": 1,
    "cr-supersede": 1,
    "cr-void": 1,
}

CR091_ROADMAP_ROLE = "ORCHESTRATOR"

_ROADMAP_DRIVE_CACHE = None


def _get_roadmap_drives():
    """Drive all 25 (verb x client) roadmap pairs once, keeping the RAW
    `CompletedProcess` -- the census cache above keeps only the decoded `axi`,
    and AC19 asserts on the exit code and on stdout PURITY as well as on the
    envelope. Cached at module scope exactly like `_get_census()`."""
    global _ROADMAP_DRIVE_CACHE
    if _ROADMAP_DRIVE_CACHE is not None:
        return _ROADMAP_DRIVE_CACHE
    fake_bin_dir = _build_fake_bin_dir()
    toon_module = _load_toon_module()
    drives = {}
    try:
        for client_key, script_path in CLIENT_FILES.items():
            project_dir = _make_project_dir(client_key)
            try:
                verbs = enumerate_verbs(client_key, script_path)
                for verb in CR091_ROADMAP_VERBS:
                    subparser = verbs.get(verb)
                    if subparser is None:
                        drives[(client_key, verb)] = None
                        continue
                    argv = build_argv(verb, subparser, project_dir)
                    result = drive_verb(script_path, argv, project_dir,
                                        fake_bin_dir)
                    _emits, axi = classify_envelope(result.stdout, toon_module)
                    options = {opt for action in subparser._actions
                               for opt in action.option_strings}
                    drives[(client_key, verb)] = {
                        "result": result, "axi": axi, "options": options,
                        "argv": argv,
                    }
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _ROADMAP_DRIVE_CACHE = drives
    return drives


_ROADMAP_HELP_CACHE = None


def _get_roadmap_help_drives():
    """P10 -- `<client> <verb> --help` for all 25 pairs, as real subprocesses.
    A `--help` that exits non-zero or omits its own verb name is a broken
    agent-facing surface however correct the write path is."""
    global _ROADMAP_HELP_CACHE
    if _ROADMAP_HELP_CACHE is not None:
        return _ROADMAP_HELP_CACHE
    fake_bin_dir = _build_fake_bin_dir()
    helps = {}
    try:
        for client_key, script_path in CLIENT_FILES.items():
            project_dir = _make_project_dir(client_key)
            try:
                for verb in CR091_ROADMAP_VERBS:
                    helps[(client_key, verb)] = drive_verb(
                        script_path, [verb, "--help"], project_dir,
                        fake_bin_dir)
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _ROADMAP_HELP_CACHE = helps
    return helps


class Cr091RoadmapVerbAxiConformanceTest(unittest.TestCase):
    """CR-CRU-091 AC19 -- all five verbs, AXI-conformant, in all five clients.

    "A verb emitting JSON, or printing prose, or routing its error to stderr
    fails this AC even when its write is correct"."""

    @classmethod
    def setUpClass(cls):
        cls.drives = _get_roadmap_drives()
        cls.helps = _get_roadmap_help_drives()
        cls.census = _get_census()

    def _pairs(self):
        for client_key in CLIENT_FILES:
            for verb in CR091_ROADMAP_VERBS:
                yield client_key, verb

    def test_all_25_pairs_are_registered_and_enumerable(self):
        missing = [f"{c}:{v}" for c, v in self._pairs()
                   if self.drives.get((c, v)) is None]
        self.assertEqual(
            missing, [],
            f"AC13 -- every roadmap verb must be a real argparse subcommand in "
            f"every client (5 x 5 = 25 pairs), never the 1 client `queue-file` "
            f"reaches: {missing!r}")

    def test_every_pair_emits_a_toon_envelope_carrying_verb_ok_context_warnings(self):
        """P1/P7 -- the fleet's own envelope shape, decoded by the SAME
        `classify_envelope` the rest of the census uses."""
        offenders = {}
        for client_key, verb in self._pairs():
            drive = self.drives.get((client_key, verb))
            axi = (drive or {}).get("axi")
            if not axi:
                offenders[f"{client_key}:{verb}"] = "no envelope"
                continue
            for field in ("verb", "ok", "context", "warnings"):
                if field not in axi:
                    offenders[f"{client_key}:{verb}"] = f"missing {field!r}"
            if axi.get("verb") != verb:
                offenders[f"{client_key}:{verb}"] = (
                    f"envelope names verb={axi.get('verb')!r}")
        self.assertEqual(
            offenders, {},
            f"every roadmap verb must write a TOON-AXI envelope on STDOUT "
            f"carrying verb/ok/context/warnings (P1/P7): {offenders!r}")

    def test_the_fleet_census_also_reads_every_roadmap_verb_as_enveloped(self):
        """Belt and braces: the roadmap verbs must also pass the file's
        PRIMARY census (the one whose per-client bare counts the rust/mvn
        guards above assert are zero), not only this section's own drives."""
        offenders = {}
        for client_key, verb in self._pairs():
            per_verb = self.census.get(client_key, {})
            if verb not in per_verb:
                offenders[f"{client_key}:{verb}"] = "not enumerated"
            elif not per_verb[verb]:
                offenders[f"{client_key}:{verb}"] = "BARE"
        self.assertEqual(
            offenders, {},
            f"the roadmap verbs must be enveloped in the fleet-wide census "
            f"too: {offenders!r}")

    def test_every_envelope_carries_the_convergence_verdict(self):
        """§S7 -- "every verb's envelope carries `converged: true|false`"."""
        offenders = {}
        for client_key, verb in self._pairs():
            axi = (self.drives.get((client_key, verb)) or {}).get("axi") or {}
            if not isinstance(axi.get("converged"), bool):
                offenders[f"{client_key}:{verb}"] = axi.get("converged")
        self.assertEqual(
            offenders, {},
            f"§S7 -- `converged` rides EVERY roadmap envelope, including a "
            f"call that never landed: {offenders!r}")

    def test_every_list_bearing_envelope_carries_total_count(self):
        """P4 -- the pre-computed aggregate. Every roadmap envelope reports
        how many records it is answering with, so a caller never counts rows
        to learn the size of the answer."""
        offenders = {}
        for client_key, verb in self._pairs():
            axi = (self.drives.get((client_key, verb)) or {}).get("axi") or {}
            if not isinstance(axi.get("totalCount"), int):
                offenders[f"{client_key}:{verb}"] = axi.get("totalCount")
        self.assertEqual(
            offenders, {},
            f"P4 -- `totalCount` rides every roadmap envelope: {offenders!r}")

    def test_every_failure_envelope_carries_a_state_derived_help_and_the_role(self):
        """P9 + AC16 -- a refusal names a concrete next call, and names the
        role roadmap registration requires. Under an unreachable server every
        one of the 25 drives is a failure, so this is measured, not asserted
        into a vacuum."""
        offenders = {}
        for client_key, verb in self._pairs():
            axi = (self.drives.get((client_key, verb)) or {}).get("axi") or {}
            if axi.get("ok") is not False:
                offenders[f"{client_key}:{verb}"] = f"ok={axi.get('ok')!r}"
                continue
            if not axi.get("help"):
                offenders[f"{client_key}:{verb}"] = "no help[]"
            elif axi.get("requiredRole") != CR091_ROADMAP_ROLE:
                offenders[f"{client_key}:{verb}"] = (
                    f"requiredRole={axi.get('requiredRole')!r}")
        self.assertEqual(
            offenders, {},
            f"P9/AC16 -- a roadmap refusal carries a state-derived help[] and "
            f"names {CR091_ROADMAP_ROLE} as the required role: {offenders!r}")

    def test_a_usage_refusal_exits_two_and_a_transport_failure_exits_one(self):
        """P6 -- "exit `2` for a usage failure or `1` for a transport
        failure". `cr-plan` is the usage case here: §S6 makes the client
        resolve the undeclared `--release`/`--wave` BEFORE posting."""
        offenders = {}
        for client_key, verb in self._pairs():
            drive = self.drives.get((client_key, verb)) or {}
            result = drive.get("result")
            expected = CR091_EXPECTED_EXIT[verb]
            if result is None or result.returncode != expected:
                offenders[f"{client_key}:{verb}"] = (
                    f"exit {getattr(result, 'returncode', None)}, "
                    f"expected {expected}")
        self.assertEqual(
            offenders, {},
            f"P6 -- the roadmap verbs' exit codes: {offenders!r}")

    def test_no_roadmap_verb_routes_its_error_to_stderr_as_bare_prose(self):
        """P6/P1 -- "a refusal writes its structured error to STDOUT ... never
        bare prose on stderr". stdout must decode as exactly ONE envelope
        document, with nothing printed before it."""
        toon_module = _load_toon_module()
        offenders = {}
        for client_key, verb in self._pairs():
            result = (self.drives.get((client_key, verb)) or {}).get("result")
            if result is None:
                offenders[f"{client_key}:{verb}"] = "not driven"
                continue
            emits, _axi = classify_envelope(result.stdout, toon_module)
            if not emits:
                offenders[f"{client_key}:{verb}"] = f"stdout={result.stdout!r}"
            elif not result.stdout.lstrip().startswith("axi:"):
                offenders[f"{client_key}:{verb}"] = (
                    f"prose precedes the envelope: {result.stdout!r}")
        self.assertEqual(
            offenders, {},
            f"stdout is the machine channel and carries the envelope ALONE: "
            f"{offenders!r}")

    def test_every_pair_offers_fields_and_full(self):
        """P2/P3 -- the minimal-schema selector and the truncation defeat are
        part of the verb surface in every client, never a python-only
        courtesy."""
        offenders = {}
        for client_key, verb in self._pairs():
            options = (self.drives.get((client_key, verb)) or {}).get("options") or set()
            absent = [flag for flag in ("--fields", "--full")
                      if flag not in options]
            if absent:
                offenders[f"{client_key}:{verb}"] = absent
        self.assertEqual(
            offenders, {},
            f"P2/P3 -- every roadmap verb offers `--fields` and `--full` in "
            f"every client: {offenders!r}")

    def test_help_exits_zero_and_names_its_verb_for_all_25_pairs(self):
        """P10 -- consistent `--help`, driven as a real subprocess."""
        offenders = {}
        for client_key, verb in self._pairs():
            result = self.helps.get((client_key, verb))
            if result is None or result.returncode != 0:
                offenders[f"{client_key}:{verb}"] = (
                    f"exit {getattr(result, 'returncode', None)}")
            elif verb not in result.stdout:
                offenders[f"{client_key}:{verb}"] = "help omits its own verb"
        self.assertEqual(
            offenders, {},
            f"P10 -- `<client> {'{verb}'} --help` must exit 0 and list the "
            f"verb for all 25 pairs: {offenders!r}")

    def test_cr_plan_asks_rather_than_guessing_and_posts_nothing(self):
        """§S6/AC11 through the census's own machinery: with `--release` and
        `--wave` undeclared the envelope is the ASK -- `needs`, a candidate
        `releases[]` and pre-filled `help[]` -- in every client alike."""
        offenders = {}
        for client_key in CLIENT_FILES:
            axi = (self.drives.get((client_key, "cr-plan")) or {}).get("axi") or {}
            if axi.get("needs") != ["release", "wave"]:
                offenders[client_key] = f"needs={axi.get('needs')!r}"
            elif "releases" not in axi:
                offenders[client_key] = "no releases[] candidate list"
            elif not any(step.startswith("release-propose --label")
                         for step in axi.get("help") or []):
                offenders[client_key] = f"help={axi.get('help')!r}"
        self.assertEqual(
            offenders, {},
            f"§S6 -- the asking is the SHARED module's, so all five clients "
            f"must ask identically: {offenders!r}")


if __name__ == "__main__":
    unittest.main()
