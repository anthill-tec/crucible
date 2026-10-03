"""CR-CRU-163 — a project declares which gate steps it never runs.

Spec: `docs/changes/CR-CRU-163-a-project-declares-the-gate-steps-it-never-runs.md`.
G5 is approved: Crucible validates only the declaration's SHAPE (a list of
non-empty strings, no entry containing a comma); step NAMES are never
validated by Crucible (no-mistakes owns that vocabulary and its own refusal
is relayed, unchanged, per CR-CRU-061 §S5).

GROUND TRUTH (measured against today's tree, `clients/_crucible_axi.py`):
`cmd_gate_run` builds `run_argv = [nm, "axi", "run", "--intent", intent]` and
appends `["--skip", skip]` ONLY when `args.skip is not None` (CR-CRU-061 §S5's
pure flag passthrough) — it never reads any `crucible.toml` for a `[gate]`
table, `gate_run_result_fields` has exactly five keys (`outcome`,
`rawOutcome`, `release`, `postedGate`, `inFlight` — no `skip`/`skipSource`),
and there is no shape-refusal path at all: a malformed `[gate] skip`
declaration is never read and so is silently ignored today, letting
`no-mistakes` launch regardless. Every test below fails against TODAY's tree
for exactly one of those reasons, named in its own docstring.

AC -> TEST CLASS map:
  AC1 (declared default, project/install precedence)
      -> `DeclaredGateSkipFromConfigFileTest`
  AC2 (explicit --skip replaces the declared list; `--skip ""` skips nothing)
      -> `ExplicitSkipFlagReplacesDeclaredListTest`
  AC3 (nothing declared, no flag -> no --skip token)
      -> `NothingDeclaredNoFlagTest` (folded into AC4's envelope assertion so
         it cannot pass vacuously against today's already-correct argv
         behaviour — see that class's docstring)
  AC4 (envelope `skip`/`skipSource` on both sealed and unsealed exit)
      -> `GateRunSkipEnvelopeFieldsTest`, plus the `NothingDeclaredNoFlagTest`
         "none" state above
  AC5 (malformed declaration refused before no-mistakes launches, naming the
       file; a well-formed but unknown name passes through unvalidated)
      -> `MalformedGateSkipDeclarationRefusedTest`
  AC6 (parity across all five clients' gate-run)
      -> `GateRunDeclaredSkipFleetParityTest`

HOW `no-mistakes` IS STUBBED: identical idiom to the sibling
`test_cr061_gate_run_skip_passthrough.py` — a tiny fake executable on a
scratch PATH-prepended bin dir, with an argv-capture file
(`GATE_RUN_FAKE_ARGV_FILE`) so a test can inspect exactly what
`["no-mistakes", "axi", "run", ...]` argv was built. Extended here with a
`kind` ("sealed" / "unsealed") so a test can choose which of the two
`cmd_gate_run` exits it drives, per AC4's "both exits" requirement.

ISOLATION FROM THIS REPO'S OWN `crucible.toml`: `_crucible_axi._INSTALL_DIR`
(derived from the module's own file location — `clients/_crucible_axi.py`'s
parent is this checkout's ROOT, which carries this developer's own untracked
`crucible.toml`) is PATCHED in every test that reaches `_read_project_config`,
to an isolated scratch directory this suite controls. No test ever reads or
depends on this checkout's own `crucible.toml`, and no test ever invokes a
real `no-mistakes`.

Invocation:
    python3 -m pytest tests/client/test_gate_run_declared_skip_defaults.py -q
Fallback:
    python3 tests/client/test_gate_run_declared_skip_defaults.py
"""

import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}

_SEQ = [0]


def _unique(prefix):
    _SEQ[0] += 1
    return f"{prefix}-{_SEQ[0]}"


def _load_module_by_path(path, cache_key):
    if not path.exists():
        raise unittest.SkipTest(f"{path} not found")
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module(name):
    return _load_module_by_path(
        CLIENT_FILES[name], _unique(f"cr163-gate-skip-{name}-under-test"))


def _load_axi_module():
    return _load_module_by_path(
        AXI_MODULE_PATH, _unique("cr163-gate-skip-axi-under-test"))


def _run_main(module, argv):
    prog = str(CLIENT_FILES.get("bun", "client"))
    full_argv = [prog] + argv
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", full_argv), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            module.main()
            code = 0
        except SystemExit as e:
            if e.code is None:
                code = 0
            elif isinstance(e.code, int):
                code = e.code
            else:
                code = 1
    return code, stdout.getvalue(), stderr.getvalue()


def _write_gate_toml(directory, body):
    """Write a `crucible.toml` at `directory` with `body` (a `[gate]` table
    fragment, verbatim) and return its path."""
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "crucible.toml")
    with open(path, "w") as f:
        f.write(body)
    return path


# ---------------------------------------------------------------------------
# Fake `no-mistakes`: two snapshot KINDS (sealed / unsealed), so a test can
# drive AC4's "both exits" requirement, plus the argv-capture handshake the
# cr061 sibling established.
# ---------------------------------------------------------------------------

_SEALED_SNAPSHOT = (
    'run:\n'
    '  id: "gate-run-cr163-sealed"\n'
    '  branch: cr163-sealed-marker\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,10\n'
    'outcome: passed\n'
)

#: No top-level `outcome:` key and no failed step, so `sealed_outcome`
#: resolves None -- `cmd_gate_run` takes the UNSEALED branch ("the run is
#: still in flight").
_UNSEALED_SNAPSHOT = (
    'run:\n'
    '  id: "gate-run-cr163-unsealed"\n'
    '  branch: cr163-unsealed-marker\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,10\n'
)

_FAKE_NO_MISTAKES_BODY_TEMPLATE = '''
import json
import os
import sys

argv = sys.argv[1:]

if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "status"):
    if argv[1] == "run":
        argv_file = os.environ.get("GATE_RUN_FAKE_ARGV_FILE")
        if argv_file:
            with open(argv_file, "w") as f:
                json.dump(argv, f)
    sys.stdout.write({snapshot!r})
    sys.exit(0)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''


class _FakeNoMistakesOnPathMixin:
    """Installs a fake `no-mistakes` (never the real one) on a scratch
    PATH-prepended bin dir, and points `GATE_RUN_FAKE_ARGV_FILE` at a tmp
    file each test can read the captured `axi run` argv back from. Same
    idiom as `test_cr061_gate_run_skip_passthrough.py`, extended with a
    `kind` choosing which of the two `cmd_gate_run` exits the snapshot
    drives."""

    def _install_fake_no_mistakes(self, kind="sealed"):
        snapshot = _SEALED_SNAPSHOT if kind == "sealed" else _UNSEALED_SNAPSHOT
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="cr163-fake-no-mistakes-bin-")
        fake_path = os.path.join(self.fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY_TEMPLATE.format(snapshot=snapshot))
        st = os.stat(fake_path)
        os.chmod(fake_path, st.st_mode | stat.S_IEXEC)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

        self.argv_capture_dir = tempfile.mkdtemp(prefix="cr163-argv-capture-")
        self.argv_file = os.path.join(self.argv_capture_dir, "argv.json")
        os.environ["GATE_RUN_FAKE_ARGV_FILE"] = self.argv_file

    def _teardown_fake_no_mistakes(self):
        os.environ["PATH"] = self._saved_path
        os.environ.pop("GATE_RUN_FAKE_ARGV_FILE", None)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        shutil.rmtree(self.argv_capture_dir, ignore_errors=True)

    def _no_mistakes_was_launched(self):
        return os.path.exists(self.argv_file)

    def _captured_argv(self):
        if not os.path.exists(self.argv_file):
            raise AssertionError(
                "the fake no-mistakes was never invoked -- `axi run` "
                "argv was not captured")
        with open(self.argv_file) as f:
            return json.load(f)


class _FakeOps:
    """The minimal duck-typed subset of `_crucible_axi.ClientOps` that
    `cmd_gate_run` actually touches -- identical shape to the cr061
    sibling's own `_FakeOps`."""

    def __init__(self):
        self.post_gate_calls = []
        self.emit_calls = []

    def agent_id(self, _args):
        return "cr163-direct-call-test-agent"

    def post_gate(self, project_dir, agent_id, gate, context, release=None):
        self.post_gate_calls.append(
            {"project_dir": project_dir, "agent_id": agent_id,
             "gate": copy.deepcopy(gate), "context": context,
             "release": release})
        return {"ok": True}

    def emit(self, verb, ok, fields, context, warnings, legacy):
        self.emit_calls.append(
            {"verb": verb, "ok": ok, "fields": copy.deepcopy(fields),
             "context": context, "warnings": warnings, "legacy": legacy})

    def context(self, project_dir, agent_id=None):
        return {"projectDir": project_dir, "agentId": agent_id}


class _DirectArgs:
    """A bare stand-in carrying only what `cmd_gate_run` reads off `args`:
    `args.intent`, `args.skip` and (via `ops.agent_id(args)`) `args.agent`."""

    def __init__(self, intent, skip=None, agent="direct-call-agent"):
        self.intent = intent
        self.skip = skip
        self.agent = agent


class _DirectGateRunCase(_FakeNoMistakesOnPathMixin, unittest.TestCase):
    """Shared fixture for every test that calls `_crucible_axi.cmd_gate_run`
    directly, with the project/install `crucible.toml` chain ISOLATED from
    this checkout's own (`_INSTALL_DIR` patched to a scratch directory this
    suite owns)."""

    def setUp(self):
        self.axi = _load_axi_module()
        self.project_dir = tempfile.mkdtemp(prefix="cr163-project-")
        self.install_dir = tempfile.mkdtemp(prefix="cr163-install-")
        self._install_dir_patch = mock.patch.object(
            self.axi, "_INSTALL_DIR", self.install_dir)
        self._install_dir_patch.start()

    def tearDown(self):
        self._install_dir_patch.stop()
        shutil.rmtree(self.project_dir, ignore_errors=True)
        shutil.rmtree(self.install_dir, ignore_errors=True)
        if hasattr(self, "fake_bin_dir"):
            self._teardown_fake_no_mistakes()

    def _no_mistakes_path(self):
        return shutil.which("no-mistakes")

    def _call(self, skip=None, intent="cr163 gate"):
        self.axi.bind_project_dir(self.project_dir)
        ops = _FakeOps()
        args = _DirectArgs(intent=intent, skip=skip)
        result = self.axi.cmd_gate_run(
            args, self.project_dir, self._no_mistakes_path(), ops)
        return result, ops


# ---------------------------------------------------------------------------
# AC1 -- a declared default: the project's file, the install's file when the
# project declares nothing, and project-wins-over-install.
# ---------------------------------------------------------------------------


class DeclaredGateSkipFromConfigFileTest(_DirectGateRunCase):
    """Today `cmd_gate_run` never reads any `crucible.toml` for a `[gate]`
    table at all -- `run_argv` gains `--skip` ONLY from `args.skip`. Every
    test below has `args.skip` UNSET (None), so today's tree produces NO
    `--skip` token in any of them: each fails because the declared value
    the AC requires is simply never read, not merely formatted differently."""

    def setUp(self):
        super().setUp()
        self._install_fake_no_mistakes(kind="sealed")

    def test_project_file_declares_skip_list_is_passed_to_axi_run(self):
        """AC1, first clause: `[gate] skip = ["pr", "ci"]` in the PROJECT's
        own file, no `--skip` on the call -> `--skip pr,ci` on the `axi run`
        argv (the CR's own literal example)."""
        _write_gate_toml(self.project_dir, '[gate]\nskip = ["pr", "ci"]\n')

        result, _ops = self._call(skip=None)

        self.assertEqual(result, 0, "a declared, well-formed skip list must "
                                     "still reach and succeed against the fake no-mistakes")
        argv = self._captured_argv()
        self.assertIn("--skip", argv,
                      f"a project-declared skip list must produce a --skip "
                      f"token on the axi run argv, got {argv}")
        idx = argv.index("--skip")
        self.assertEqual(argv[idx + 1], "pr,ci",
                         f"the declared list must join as the CR's own literal "
                         f"example 'pr,ci' (comma, no spaces), got {argv!r}")

    def test_install_file_declares_skip_when_project_file_absent(self):
        """AC1, second clause: the PROJECT directory carries NO crucible.toml
        at all (so the project->install walk proceeds past it), and the
        INSTALL's file declares the same list -> the same `--skip pr,ci`."""
        # Deliberately no crucible.toml written at self.project_dir.
        _write_gate_toml(self.install_dir, '[gate]\nskip = ["pr", "ci"]\n')

        result, _ops = self._call(skip=None)

        self.assertEqual(result, 0)
        argv = self._captured_argv()
        self.assertIn("--skip", argv,
                      f"an install-only declared skip list must still reach "
                      f"the axi run argv when the project declares nothing "
                      f"(and has no file at all), got {argv}")
        idx = argv.index("--skip")
        self.assertEqual(argv[idx + 1], "pr,ci")

    def test_project_file_wins_over_install_file(self):
        """AC1, third clause: BOTH files declare a (different) list -> the
        PROJECT's wins outright, not merged with the install's."""
        _write_gate_toml(self.project_dir, '[gate]\nskip = ["lint"]\n')
        _write_gate_toml(self.install_dir, '[gate]\nskip = ["pr", "ci"]\n')

        result, _ops = self._call(skip=None)

        self.assertEqual(result, 0)
        argv = self._captured_argv()
        self.assertIn(
            "--skip", argv,
            f"the project's own declaration must win outright over the "
            f"install's, got {argv}")
        idx = argv.index("--skip")
        self.assertNotIn(
            "pr", argv[idx + 1].split(","),
            f"the install's declared steps must not leak into a project-"
            f"declared argv, got {argv!r}")


# ---------------------------------------------------------------------------
# AC2 -- an explicit --skip replaces the declared list; --skip "" skips
# nothing.
# ---------------------------------------------------------------------------


class ExplicitSkipFlagReplacesDeclaredListTest(_DirectGateRunCase):
    def setUp(self):
        super().setUp()
        self._install_fake_no_mistakes(kind="sealed")
        _write_gate_toml(self.project_dir, '[gate]\nskip = ["pr", "ci"]\n')

    def test_explicit_skip_flag_replaces_the_declared_list(self):
        """An explicit `--skip lint` on the call must REPLACE the project's
        declared `pr,ci`, not merge or append to it.

        The argv half of this (today's existing CR-061 passthrough already
        makes an explicit flag win on the argv, regardless of whether
        declared-reading exists at all) would PASS VACUOUSLY on its own --
        it proves nothing about the 'replaces the declared list' half of
        AC2, only about the pre-existing flag passthrough. So this test
        additionally asserts the envelope's `skip`/`skipSource` read the
        FLAG's value (`['lint']` / `'flag'`), never the declared one -- a
        field pair that does not exist on today's tree at all, which is
        what makes this fail for the right reason today."""
        result, ops = self._call(skip="lint")

        self.assertEqual(result, 0)
        argv = self._captured_argv()
        idx = argv.index("--skip")
        self.assertEqual(
            argv[idx + 1], "lint",
            f"an explicit --skip must replace the declared list outright, "
            f"got {argv!r}")

        self.assertEqual(len(ops.emit_calls), 1)
        fields = ops.emit_calls[0]["fields"]
        self.assertEqual(
            fields.get("skip"), ["lint"],
            f"the envelope must report the FLAG's steps, not the declared "
            f"ones, got {fields.get('skip')!r}")
        self.assertEqual(
            fields.get("skipSource"), "flag",
            f"the envelope must report skipSource == 'flag' when an "
            f"explicit --skip replaced a declared list, got "
            f"{fields.get('skipSource')!r}")

    def test_explicit_empty_skip_flag_skips_nothing_despite_declaration(self):
        """`--skip ""` is an EXPLICIT choice to skip nothing, overriding the
        project's declared `pr,ci` -- the argv must carry NO `--skip` token
        at all (G4). Today's `cmd_gate_run` appends `["--skip", ""]`
        unconditionally whenever `args.skip is not None` (it only guards
        against `None`, not against the empty string), so this fails today
        because the argv DOES carry a (empty-valued) --skip token."""
        result, _ops = self._call(skip="")

        self.assertEqual(result, 0)
        argv = self._captured_argv()
        self.assertNotIn(
            "--skip", argv,
            f"--skip \"\" must omit the --skip token entirely (skip nothing), "
            f"got {argv}")


# ---------------------------------------------------------------------------
# AC3 + the "none" state of AC4 -- nothing declared, no flag: no --skip
# token, and the envelope's skip/skipSource both read "none".
# ---------------------------------------------------------------------------


class NothingDeclaredNoFlagTest(_DirectGateRunCase):
    """AC3's argv-only half ("no --skip token") is ALREADY true of today's
    tree with nothing declared and no flag -- a test that checked only that
    half would pass vacuously, proving nothing changed. Folded into ONE test
    with the AC4 "none" envelope assertion, which TODAY's tree cannot
    satisfy at all: `gate_run_result_fields` has no `skip`/`skipSource` keys,
    so `fields.get("skip")` is None, not the literal "none" string G6
    requires."""

    def setUp(self):
        super().setUp()
        self._install_fake_no_mistakes(kind="sealed")
        # Neither file declares anything -- the install dir is left EMPTY
        # (no crucible.toml at all), and the project dir likewise.

    def test_no_declaration_and_no_flag_omits_skip_token_and_reports_none(self):
        result, ops = self._call(skip=None)

        self.assertEqual(result, 0)
        argv = self._captured_argv()
        self.assertNotIn(
            "--skip", argv,
            f"nothing declared and no flag must carry no --skip token "
            f"(today's behaviour, unchanged), got {argv}")

        self.assertEqual(len(ops.emit_calls), 1,
                         "cmd_gate_run must emit exactly one envelope for a "
                         "sealed exit")
        fields = ops.emit_calls[0]["fields"]
        self.assertIn("skip", fields,
                      f"the envelope must carry a 'skip' field even when "
                      f"nothing is skipped, got keys {sorted(fields)}")
        self.assertIn("skipSource", fields,
                      f"the envelope must carry a 'skipSource' field even "
                      f"when nothing is skipped, got keys {sorted(fields)}")
        self.assertEqual(
            fields["skip"], "none",
            f"with nothing declared and no flag, 'skip' must read the "
            f"literal 'none', got {fields['skip']!r}")
        self.assertEqual(
            fields["skipSource"], "none",
            f"with nothing declared and no flag, 'skipSource' must read the "
            f"literal 'none', got {fields['skipSource']!r}")


# ---------------------------------------------------------------------------
# AC4 -- the envelope carries skip/skipSource on BOTH the sealed and the
# unsealed exit, for both a declared value and an explicit flag value.
# ---------------------------------------------------------------------------


class GateRunSkipEnvelopeFieldsTest(_DirectGateRunCase):
    """`gate_run_result_fields` has exactly five keys today (`outcome`,
    `rawOutcome`, `release`, `postedGate`, `inFlight`). Every assertion
    below that checks for 'skip'/'skipSource' in the emitted fields fails
    against today's tree with a `KeyError`-shaped failure (the key is simply
    absent), on BOTH the sealed and unsealed exit paths -- proving the field
    is missing from the exit's own construction, not merely from one of the
    two call sites."""

    def setUp(self):
        super().setUp()

    def tearDown(self):
        super().tearDown()

    def _emitted_fields(self, kind, skip, declared_toml=None):
        self._install_fake_no_mistakes(kind=kind)
        try:
            if declared_toml is not None:
                _write_gate_toml(self.project_dir, declared_toml)
            result, ops = self._call(skip=skip)
            self.assertEqual(len(ops.emit_calls), 1,
                             f"cmd_gate_run must emit exactly one envelope "
                             f"for a {kind} exit")
            return result, ops.emit_calls[0]
        finally:
            self._teardown_fake_no_mistakes()
            del self.fake_bin_dir

    def test_declared_skip_fields_present_on_sealed_exit(self):
        result, call = self._emitted_fields(
            "sealed", skip=None, declared_toml='[gate]\nskip = ["pr", "ci"]\n')

        self.assertEqual(result, 0, "a declared skip list must still seal "
                                     "successfully against the fake no-mistakes")
        self.assertTrue(call["ok"], f"a passing sealed run must emit ok=True, "
                                    f"got {call!r}")
        fields = call["fields"]
        self.assertEqual(
            fields.get("skip"), ["pr", "ci"],
            f"the sealed exit's envelope must carry the declared list "
            f"verbatim as 'skip', got {fields.get('skip')!r}")
        source = fields.get("skipSource")
        self.assertIsInstance(source, str,
                              f"skipSource must be a string, got {source!r}")
        self.assertTrue(
            source.startswith("declared"),
            f"skipSource must name 'declared' when the value came from a "
            f"config file, got {source!r}")
        expected_path = os.path.join(self.project_dir, "crucible.toml")
        self.assertIn(
            expected_path, source,
            f"skipSource must name the FILE the declaration was read from "
            f"(G6: 'declared with the file's path'), got {source!r}")

    def test_declared_skip_fields_present_on_unsealed_exit(self):
        result, call = self._emitted_fields(
            "unsealed", skip=None, declared_toml='[gate]\nskip = ["pr", "ci"]\n')

        self.assertEqual(result, 1, "a run that reaches no terminus must "
                                     "exit 1 (unsealed)")
        self.assertFalse(call["ok"], f"an unsealed exit must emit ok=False, "
                                     f"got {call!r}")
        fields = call["fields"]
        self.assertEqual(fields.get("skip"), ["pr", "ci"],
                         f"the UNSEALED exit's envelope must ALSO carry the "
                         f"declared list, got {fields.get('skip')!r}")
        source = fields.get("skipSource")
        self.assertIsInstance(source, str)
        self.assertTrue(source.startswith("declared"))
        expected_path = os.path.join(self.project_dir, "crucible.toml")
        self.assertIn(expected_path, source)

    def test_flag_skip_fields_present_on_sealed_exit(self):
        result, call = self._emitted_fields("sealed", skip="lint,test")

        self.assertEqual(result, 0)
        fields = call["fields"]
        self.assertEqual(
            fields.get("skip"), ["lint", "test"],
            f"an explicit --skip must report its OWN steps as 'skip', got "
            f"{fields.get('skip')!r}")
        self.assertEqual(
            fields.get("skipSource"), "flag",
            f"an explicit --skip must report skipSource == 'flag' exactly, "
            f"got {fields.get('skipSource')!r}")

    def test_flag_skip_fields_present_on_unsealed_exit(self):
        result, call = self._emitted_fields("unsealed", skip="lint,test")

        self.assertEqual(result, 1)
        fields = call["fields"]
        self.assertEqual(fields.get("skip"), ["lint", "test"],
                         f"the UNSEALED exit must ALSO report the explicit "
                         f"--skip steps, got {fields.get('skip')!r}")
        self.assertEqual(fields.get("skipSource"), "flag")


# ---------------------------------------------------------------------------
# AC5 -- a malformed declaration is refused before no-mistakes launches,
# naming the file; a well-formed but UNKNOWN step name is not validated and
# passes through unchanged (G5).
# ---------------------------------------------------------------------------


class MalformedGateSkipDeclarationRefusedTest(_DirectGateRunCase):
    """None of these cases exist today: `cmd_gate_run` never reads `[gate]`
    at all, so a malformed declaration is silently ignored and no-mistakes
    launches anyway -- every refusal assertion below (nonzero exit,
    no-mistakes never launched, the file named) fails today because the
    refusal simply never happens."""

    def setUp(self):
        super().setUp()
        self._install_fake_no_mistakes(kind="sealed")

    def _assert_refused_before_launch(self, toml_body):
        path = _write_gate_toml(self.project_dir, toml_body)
        result, ops = self._call(skip=None)

        self.assertNotEqual(
            result, 0,
            f"a malformed [gate] skip declaration must be REFUSED (nonzero "
            f"exit), got {result} for body {toml_body!r}")
        self.assertFalse(
            self._no_mistakes_was_launched(),
            f"no-mistakes must never be launched once the declaration is "
            f"refused, for body {toml_body!r}")
        self.assertEqual(
            ops.post_gate_calls, [],
            f"a refused declaration must post no gate at all, for body "
            f"{toml_body!r}")
        self.assertEqual(len(ops.emit_calls), 1,
                         f"a refused declaration must still emit exactly one "
                         f"ok=False envelope, for body {toml_body!r}")
        emitted = ops.emit_calls[0]
        self.assertFalse(emitted["ok"], f"a refusal must emit ok=False, got "
                                        f"{emitted!r}")
        named = json.dumps(emitted)
        self.assertIn(
            path, named,
            f"the refusal must NAME the offending file ({path}) somewhere "
            f"in the emitted envelope (fields or legacy line), got {emitted!r}")
        return emitted

    def test_declaration_that_is_a_string_not_a_list_is_refused(self):
        self._assert_refused_before_launch('[gate]\nskip = "pr,ci"\n')

    def test_declaration_entry_containing_a_comma_is_refused(self):
        self._assert_refused_before_launch('[gate]\nskip = ["pr,ci"]\n')

    def test_declaration_entry_that_is_an_empty_string_is_refused(self):
        self._assert_refused_before_launch('[gate]\nskip = ["pr", ""]\n')

    def test_declaration_with_a_non_string_entry_is_refused(self):
        self._assert_refused_before_launch('[gate]\nskip = [1, 2]\n')

    def test_well_formed_unknown_step_name_passes_through_unvalidated(self):
        """G5: Crucible validates only SHAPE. A well-formed list carrying a
        step name no version of no-mistakes has ever shipped must NOT be
        refused -- it reaches the `axi run` argv byte-for-byte, same as an
        explicit --skip would (CR-CRU-061 §S5). This fails today for the
        opposite reason from the refusal tests above: not because a refusal
        is missing, but because the declared-list READING itself does not
        exist yet, so NO --skip token reaches the argv at all."""
        _write_gate_toml(
            self.project_dir,
            '[gate]\nskip = ["totally-made-up-step", "ci"]\n')

        result, ops = self._call(skip=None)

        self.assertEqual(
            result, 0,
            f"a well-formed declaration naming an UNKNOWN step must not be "
            f"refused by Crucible -- it must reach and succeed against the "
            f"fake no-mistakes, got exit {result}")
        self.assertTrue(
            self._no_mistakes_was_launched(),
            "a well-formed (even if unrecognised) declaration must still "
            "launch no-mistakes")
        argv = self._captured_argv()
        self.assertIn(
            "--skip", argv,
            f"the unrecognised name must still produce a --skip token (G5: "
            f"Crucible validates shape only, never names), got {argv}")
        idx = argv.index("--skip")
        self.assertEqual(
            argv[idx + 1], "totally-made-up-step,ci",
            f"the unrecognised name must survive UNCHANGED -- no "
            f"normalising, no dropping -- got {argv!r}")
        self.assertEqual(len(ops.post_gate_calls), 1,
                         "an accepted (unvalidated) declaration must still "
                         "seal a gate")


# ---------------------------------------------------------------------------
# AC6 -- parity across all five clients' gate-run: a project-declared skip
# list reaches the axi run argv identically for bun/rust/mvn/python/arduino.
# ---------------------------------------------------------------------------


class GateRunDeclaredSkipFleetParityTest(_FakeNoMistakesOnPathMixin, unittest.TestCase):
    """CR-CRU-163's own gap analysis (G3) requires the declared-skip change
    to be made ONCE in the shared `cmd_gate_run`, so every one of the five
    clients' OWN `gate-run` CLI dispatch must show the SAME `--skip pr,ci`
    on the axi run argv for the SAME project-declared `crucible.toml`, with
    NO `--skip` flag on the command line. Today this fails identically for
    all five, for the same reason as `DeclaredGateSkipFromConfigFileTest`:
    nothing reads `[gate]` at all, so none of the five ever produces a
    --skip token here."""

    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self._install_fake_no_mistakes(kind="sealed")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self._teardown_fake_no_mistakes()

    def test_project_declared_skip_reaches_axi_run_argv_identically_across_fleet(self):
        offenders = {}
        for name in CLIENT_FILES:
            module = _load_client_module(name)
            project_dir = tempfile.mkdtemp(prefix=f"cr163-fleet-{name}-")
            install_dir = tempfile.mkdtemp(prefix=f"cr163-fleet-install-{name}-")
            try:
                with open(os.path.join(project_dir, ".env"), "w") as f:
                    f.write("CRUCIBLE_PROJECT_KEY=test-key-cr163-fleet\n")
                    f.write("CRUCIBLE_PROJECT_NAME=cr163-fleet-test\n")
                _write_gate_toml(project_dir, '[gate]\nskip = ["pr", "ci"]\n')

                axi_submodule = module._axi()
                calls = []

                def fake_post(path, payload, _calls=calls):
                    _calls.append((path, copy.deepcopy(payload)))
                    return {"ok": True}

                os.remove(self.argv_file) if os.path.exists(self.argv_file) else None

                with mock.patch.object(axi_submodule, "_INSTALL_DIR", install_dir):
                    patch_targets = [n for n in ("_post",) if hasattr(module, n)]
                    with contextlib.ExitStack() as stack:
                        for n in patch_targets:
                            stack.enter_context(
                                mock.patch.object(module, n, side_effect=fake_post))
                        argv = ["gate-run", "--intent", "cr163 fleet parity",
                                "--agent", "test-agent", "--project-dir", project_dir]
                        code, _out, err = _run_main(module, argv)

                if not os.path.exists(self.argv_file):
                    offenders[name] = f"no-mistakes never invoked; code={code} stderr={err!r}"
                    continue
                proxied_argv = self._captured_argv()
                if "--skip" not in proxied_argv:
                    offenders[name] = f"no --skip token on argv: {proxied_argv}"
                    continue
                idx = proxied_argv.index("--skip")
                value = proxied_argv[idx + 1]
                if value != "pr,ci":
                    offenders[name] = f"--skip value was {value!r}, expected 'pr,ci'"
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
                shutil.rmtree(install_dir, ignore_errors=True)

        self.assertEqual(
            offenders, {},
            f"a project-declared [gate] skip must reach the axi run argv as "
            f"'--skip pr,ci' identically across every client's own gate-run "
            f"CLI dispatch; offenders: {offenders}")


if __name__ == "__main__":
    unittest.main()
