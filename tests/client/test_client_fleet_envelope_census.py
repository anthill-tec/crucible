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
    subprocesses."""
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
                    emits, _axi = classify_envelope(result.stdout, toon_module)
                    per_verb[verb_name] = emits
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

    def test_rust_nine_verbs_confirmed_envelope_less(self):
        """The CR's Context table (hand-traced) named nine rust verbs as
        bare. Independently confirmed here by READING each function body:
        `cmd_regression_ingest`/`_regression_ingest_run`,
        `_workspace_regression_run` (via `cmd_workspace_regression`),
        `cmd_pre_merge_gate`, `cmd_clippy`, `cmd_workspace_clippy` (via
        `_clippy_workspace_gate`), `cmd_smoke_test`, `cmd_docker_up`,
        `cmd_docker_down` and `cmd_docker_e2e_gate` (a thin wrapper over
        `cmd_smoke_test`) each end in a plain `print(...)`, never an
        `_emit_axi`/`_axi().emit` call -- this asserts the DYNAMIC census
        agrees with that static reading."""
        expected_bare = {
            "regression-ingest", "workspace-regression", "pre-merge-gate",
            "clippy", "workspace-clippy", "smoke-test", "docker-up",
            "docker-down", "docker-e2e-gate",
        }
        rust = self.census["rust"]
        missing_from_enumeration = expected_bare - set(rust)
        self.assertEqual(
            missing_from_enumeration, set(),
            f"the CR's nine named rust verbs must all still exist in "
            f"rust's argparse: missing {missing_from_enumeration!r}")
        still_enveloped = {v for v in expected_bare if rust.get(v)}
        self.assertEqual(
            still_enveloped, set(),
            f"the CR's nine rust verbs must all still be measured as "
            f"envelope-less today (this cycle only measures, it does not "
            f"fix) -- any verb here would mean it already got an envelope "
            f"since the CR was filed: {still_enveloped!r}")

    def test_rust_check_confirmed_enveloped_unlike_its_clippy_sibling(self):
        """The CR's own Context section named only `clippy`, not `check`,
        as bare -- confirmed by reading `cmd_check`'s body (ends in a real
        `_emit_axi("check", ok, ...)` call) versus `cmd_clippy`'s (plain
        `print(...)` only, no emitter at all). The census must agree with
        that asymmetry, or the detector's positive/negative discrimination
        itself is broken."""
        self.assertTrue(
            self.census["rust"].get("check"),
            "rust's 'check' verb calls _emit_axi directly and must show "
            "enveloped")
        self.assertFalse(
            self.census["rust"].get("clippy"),
            "rust's 'clippy' verb has no _emit_axi call anywhere in its "
            "body and must show envelope-less")

    def test_mvn_unit_module_compile_e2e_confirmed_envelope_less(self):
        """Gap-analysis finding (CR's own retracted non-goal: "mvn cmd_unit/
        cmd_module reaching a print-only _ingest_parsed with no emitter in
        the chain"). Confirmed by reading the full delegation chain:
        `cmd_unit`/`cmd_module` -> `_run_surefire_tier` -> `_smart_ingest` ->
        `_ingest_junit_dir`/`_ingest_parsed`, NONE of which ever call
        `_emit_axi`, and `_run_surefire_tier` itself never calls it either.
        `cmd_compile` and `cmd_e2e` are two MORE, undocumented instances of
        the identical gap (neither has an `_emit_axi` call anywhere in its
        body -- `cmd_compile` ends in a bare `_ingest_compile(...)` print,
        `cmd_e2e` in a bare `_ingest_parsed(...)`/`_compile_fallback(...)`)
        -- new to this detector's run, in scope per the CR's own retracted
        non-goal ("Whatever it finds in the other four is IN SCOPE for this
        CR")."""
        mvn = self.census["mvn"]
        still_enveloped = {v for v in ("unit", "module", "compile", "e2e")
                           if mvn.get(v)}
        self.assertEqual(
            still_enveloped, set(),
            f"mvn's unit/module/compile/e2e verbs must show envelope-less "
            f"-- each reaches only a plain-print ingest helper, never "
            f"_emit_axi: {still_enveloped!r}")

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

    def test_mvn_regression_reaches_the_emitter_but_stdout_purity_is_violated(self):
        """A THIRD, more subtle category the census's strict single-document
        decode surfaces: mvn's `_regression_run` DOES call
        `_emit_ingest_summary_axi` (confirmed by reading its body) -- but
        `print(f"[regression] running: {{...}}")` and
        `print(f"[regression] mvn exit={{...}}")` (mvn-crucible.py, both with
        no `file=sys.stderr`, unlike `cmd_test`'s/`cmd_check`'s equivalent
        prints two lines below each) write to STDOUT first, so the overall
        stream is prose-then-envelope, not "a TOON envelope alone" (§S3's
        exact AC wording). The strict `classify_envelope` above correctly
        reads this as `False` (a caller trying to decode the WHOLE stdout as
        one document gets a parse failure) -- this test confirms that
        reading precisely: an `axi:` block genuinely IS present in the raw
        stream (so this is §S3 stdout-pollution, not an S1 missing-emitter
        gap like unit/module/compile/e2e above), it just cannot be decoded
        as the clean single document the AC requires."""
        result = self._drive_mvn_regression_raw()
        self.assertIn(
            "axi:\n  verb: regression", result.stdout,
            "mvn's regression verb must still contain a real axi: block "
            "in its raw stdout -- confirming the emitter WAS reached")
        self.assertFalse(
            self.census["mvn"].get("regression"),
            "the strict single-document census must still read regression "
            "as non-compliant: prose precedes the envelope on stdout")
        self.assertTrue(
            result.stdout.split("axi:", 1)[0].strip().startswith("[regression] running:"),
            "the polluting line must be mvn's own unguarded "
            "'[regression] running: ...' print (no file=sys.stderr), "
            "landing on stdout BEFORE the envelope")

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
        delegator in every client) -- each must show enveloped everywhere,
        EXCEPT the four excluded below, which the two dedicated tests that
        follow this one document precisely (a "SHARED" classification
        covers byte-identical LOGIC, not "always emits an envelope under
        every failure precondition" -- this census is what discovered the
        difference between the two)."""
        # milestone: see test_milestone_confirmed_envelope_less_fleet_wide.
        # cycle-activate/cycle-done/cr-close: see
        # test_cycle_transition_and_cr_close_confirmed_bare_on_plans_get_failure.
        shared_verbs = [
            "register", "unregister", "status", "plans", "gate-run",
            "gate-report", "plan-file", "cycle-add", "checkpoint", "stop",
            "abort",
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

    def test_milestone_confirmed_envelope_less_fleet_wide(self):
        """A NEW finding this cycle's dynamic drive surfaced (not in the
        CR's Context table, which only hand-traced rust): `_crucible_axi.
        cmd_milestone` -- THE_42's SHARED implementation ALL FIVE clients
        delegate to -- never calls `_emit_axi`/`ops.emit` at all. Confirmed
        by reading its full body: it POSTs the milestone, then
        `print(f"milestone: ok={{ok}} type={{args.type}}...", file=sys.stderr)`
        and returns a bare int -- no envelope on ANY outcome, success or
        failure. A hand-list would need to KNOW to check this; the dynamic
        census caught it because `milestone` is enumerated and driven like
        every other verb."""
        offenders = {c: v.get("milestone") for c, v in self.census.items()
                     if v.get("milestone")}
        self.assertEqual(
            offenders, {},
            f"milestone must show envelope-less in EVERY client (no client "
            f"may have somehow grown its own envelope call around the "
            f"shared no-op): {offenders!r}")

    def test_cycle_transition_and_cr_close_confirmed_bare_on_plans_get_failure(self):
        """A SECOND new finding: `cycle-activate`/`cycle-done` (via the
        shared `cycle_transition`) and `cr-close` (via `cmd_cr_close`) both
        call `ops.open_plans(project_dir)` FIRST to resolve the target plan
        -- and `_crucible_axi.open_plans` (confirmed by reading it) does
        `sys.exit(f"[crucible] ERROR: could not list plans: {{...}}")` on a
        GET failure: a bare process exit with NO envelope, unlike the
        sibling `resolve_plan_or_emit` helper (used by cycle-add/checkpoint/
        abort, confirmed via the same read) which correctly calls
        `emit_fn(verb, False, ...)` on the identical GET-failure precondition.
        Every OTHER failure mode inside cycle_transition/cmd_cr_close (cycle
        not found, ambiguous open plans, a failed PATCH) DOES emit correctly
        -- this is specifically the "the plans GET itself failed" precondition,
        which is exactly the one `drive_verb`'s unreachable CRUCIBLE_URL
        exercises for every verb in this census. Static reading alone would
        need to separately trace `open_plans` vs `resolve_plan_or_emit` and
        notice they diverge; the dynamic drive surfaces it directly."""
        affected = ("cycle-activate", "cycle-done", "cr-close")
        offenders = {}
        for client, per_verb in self.census.items():
            still_enveloped = [v for v in affected if per_verb.get(v)]
            if still_enveloped:
                offenders[client] = still_enveloped
        self.assertEqual(
            offenders, {},
            f"cycle-activate/cycle-done/cr-close must show envelope-less "
            f"under a plans-GET failure in every client: {offenders!r}")

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


if __name__ == "__main__":
    unittest.main()
