"""CR-CRU-061 §S5 (cycle 187) -- `gate-run` must be able to skip PR-based
`no-mistakes` pipeline steps.

Why (verbatim from the CR): `no-mistakes`'s pipeline is `rebase -> review ->
test -> document -> lint -> ci`; the `ci` step is PR-based (`ci_timeout:
"168h"` bounds how long it babysits an open PR). This project has no PRs
(git-flow, direct merges), so `ci` would block for up to a week. `no-mistakes
axi run` already supports `--skip <steps>` and stops at its CI-ready point --
exactly the gate this project wants -- but `gate-run` exposes only `--intent`,
`--agent`, `--project-dir`: there is no `--skip` passthrough.

GROUND TRUTH (measured, re-derived from `clients/_crucible_axi.py` as of this
cycle): `gate-run`'s body is ONE shared locus, not five -- CR-CRU-054 lifted
it to `_crucible_axi.cmd_gate_run` (~:1653), which builds
`[nm, "axi", "run", "--intent", intent]` (~:1673) and every one of the five
clients (`arduino`, `bun`, `mvn`, `python`, `rust`) delegates to it via a
thin `return _axi().cmd_gate_run(...)` wrapper (confirmed by reading all
five `cmd_gate_run` functions). Each client's OWN `argparse` subparser for
`gate-run` (`gr = sub.add_parser("gate-run", ...)`) currently defines only
`--intent`/`--agent`/`--project-dir` -- there is no `--skip` on ANY of the
five parsers, and the shared `cmd_gate_run`'s `subprocess.Popen` argv never
mentions `--skip`.

RED phase: every test below fails against TODAY's tree, for the reason
stated in its own docstring/comment -- either argparse rejects `--skip`
outright (`unrecognized arguments`, exit 2) or the constructed `axi run`
argv simply never contains `--skip` at all, because neither the per-client
argparse surface nor the shared `cmd_gate_run` builder knows about it yet.

FOUR CONTRACTS, THREE TEST CLASSES:
  1. `--skip <steps>` is ACCEPTED by every client's own argparse (not
     rejected as unknown), and documented in that client's `gate-run --help`
     -- `GateRunSkipArgparseAcceptedAcrossFleetTest` (all 5 clients, since
     each client owns its OWN argparse subparser -- CR-054 did not lift
     argparse wiring, only the verb BODY).
  2. The value is passed through UNCHANGED to the `no-mistakes axi run`
     argv (pure passthrough -- no hardcoding/validating/rewriting which
     steps are skipped), proven end-to-end through one real client's CLI
     dispatch (`bun-crucible.py`) -- `GateRunSkipEndToEndPassthroughTest`.
  3. Omitting `--skip` produces NO `--skip` token in the argv (no leaked
     default) -- same class as #2, same harness.
  4. The passthrough logic exists ONCE, in the shared `_crucible_axi.py`
     module, not duplicated per client -- proven by calling
     `_crucible_axi.cmd_gate_run` DIRECTLY, with no client module involved
     at all, and observing the SAME passthrough/omission behaviour from
     THAT single call site -- `GateRunSkipSharedLocusDirectCallTest`. This
     is a stronger locus proof than a source-text grep: if a future edit
     re-implemented `--skip` handling independently inside one client's own
     `cmd_gate_run` wrapper (bypassing the shared function), this test would
     keep failing even though the fleet-wide end-to-end test above might
     start passing for that one client -- exactly the re-fragmentation this
     CR's own words warn against ("Do not patch five copies").

HOW `no-mistakes` IS STUBBED (per dispatch instruction -- never invoke the
real one): a tiny fake executable is written to a scratch bin dir and
PATH-prepended, following the EXACT idiom already established by the sibling
`test_bun_crucible_gates.py` (`_FAKE_NO_MISTAKES_BODY`, `GATE_RUN_FAKE_STATE`/
`GATE_RUN_FAKE_ARGV_FILE` env-var handshake) and its lighter-weight sibling
`test_bun_crucible_gate_axi.py` (a single immediate FINAL snapshot, no
interim ladder -- this file's assertions are about the PROXIED ARGV and the
CLI surface, not the interim-poll/throttling mechanics those two files
already cover exhaustively). This file reuses that same lightweight fake and
adds one thing neither sibling needed: an argv-capture file so each test can
inspect exactly what `["no-mistakes", "axi", "run", ...]` argv the client
constructed.

Module-loading convention: REPO_ROOT-relative `clients/*.py`, loaded by file
path (hyphenated filenames), same idiom as every sibling harness in this
directory (`test_bun_crucible_gates.py`, `test_cr054_drift_guard.py`, ...).

Invocation:
    python3 -m pytest tests/client/test_cr061_gate_run_skip_passthrough.py -q
Fallback:
    python3 tests/client/test_cr061_gate_run_skip_passthrough.py
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


def _load_module_by_path(path, cache_key):
    """Load a module by file path -- the fleet's own bootstrap-loader idiom
    (`_axi()`/`_toon()`), and the same idiom every sibling harness in this
    directory already uses to load a hyphenated `clients/*.py` file."""
    if not path.exists():
        raise unittest.SkipTest(f"{path} not found")
    spec = importlib.util.spec_from_file_location(cache_key, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client_module(name):
    return _load_module_by_path(CLIENT_FILES[name], f"cr061_gate_run_skip_{name}_under_test")


def _load_axi_module():
    return _load_module_by_path(AXI_MODULE_PATH, "cr061_gate_run_skip_axi_under_test")


def _run_main(module, argv):
    """Invoke `module.main()` with `sys.argv` patched. Only `SystemExit` is
    caught -- any OTHER exception propagates as a genuine unittest ERROR,
    itself a valid (if noisier) RED signal. Same idiom as every sibling gate
    harness in this directory."""
    prog = str(CLIENT_FILES.get("bun", "client"))
    full_argv = [prog] + argv
    stdout = io.StringIO()
    stderr = io.StringIO()
    with mock.patch.object(sys, "argv", full_argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
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


def _assert_flag_not_rejected(testcase, stderr, flag_repr):
    """A bare 'exit code != 0' would ALSO pass while `--skip` isn't wired up
    at all (argparse rejects it with exit 2) -- pin the FAILURE MODE
    specifically: argparse must not call this an unrecognized/invalid
    argument."""
    testcase.assertNotIn(
        "unrecognized arguments", stderr,
        f"--skip must be a recognized argparse flag, not rejected as unknown "
        f"({flag_repr}): {stderr!r}")
    testcase.assertNotIn(
        "invalid choice", stderr,
        f"gate-run itself must remain a registered subcommand while --skip "
        f"is exercised ({flag_repr}): {stderr!r}")


# ---------------------------------------------------------------------------
# A minimal fake `no-mistakes`: a SINGLE immediate resolved final snapshot
# (no interim ladder, no sleep -- the interim-poll/throttling mechanics are
# already covered exhaustively by the sibling gate-run harnesses), PLUS an
# argv-capture file so a test can inspect exactly what argv `axi run` was
# invoked with. Same body shape as
# `test_bun_crucible_gate_axi.py::_FAKE_NO_MISTAKES_BODY`, extended with the
# `GATE_RUN_FAKE_ARGV_FILE` handshake already established by
# `test_bun_crucible_gates.py`.
# ---------------------------------------------------------------------------

_RELAY_MARKER = "cr061-skip-passthrough-relay-marker"

_FINAL_SNAPSHOT = (
    'run:\n'
    '  id: "gate-run-skip-test-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,10\n'
    'outcome: passed\n'
)

_FAKE_NO_MISTAKES_BODY = f'''
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
    sys.stdout.write({_FINAL_SNAPSHOT!r})
    sys.exit(0)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''


class _FakeNoMistakesOnPathMixin:
    """Installs the fake `no-mistakes` above on a scratch PATH-prepended bin
    dir, and points `GATE_RUN_FAKE_ARGV_FILE` at a tmp file each test can
    read back the captured `axi run` argv from. Never touches a real
    `no-mistakes` install even if one happens to be on this machine's PATH
    (the scratch dir is prepended, so the fake always wins)."""

    def _install_fake_no_mistakes(self):
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="cr061-fake-no-mistakes-bin-")
        fake_path = os.path.join(self.fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        st = os.stat(fake_path)
        os.chmod(fake_path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

        self.argv_capture_dir = tempfile.mkdtemp(prefix="cr061-argv-capture-")
        self.argv_file = os.path.join(self.argv_capture_dir, "argv.json")
        os.environ["GATE_RUN_FAKE_ARGV_FILE"] = self.argv_file

    def _teardown_fake_no_mistakes(self):
        os.environ["PATH"] = self._saved_path
        os.environ.pop("GATE_RUN_FAKE_ARGV_FILE", None)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        shutil.rmtree(self.argv_capture_dir, ignore_errors=True)

    def _captured_argv(self):
        self.assertTrue(os.path.exists(self.argv_file),
                         "the fake no-mistakes was never invoked -- `axi run` argv was not captured")
        with open(self.argv_file) as f:
            return json.load(f)


# ---------------------------------------------------------------------------
# Contract 1 -- `--skip` accepted by EVERY client's own argparse, documented
# in `gate-run --help`.
# ---------------------------------------------------------------------------


class GateRunSkipArgparseAcceptedAcrossFleetTest(_FakeNoMistakesOnPathMixin, unittest.TestCase):
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self._install_fake_no_mistakes()
        self.tmpdir = tempfile.mkdtemp(prefix="cr061-gate-run-skip-fleet-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write("CRUCIBLE_PROJECT_KEY=test-key-cr061-skip\n")
            # arduino's _load_env additionally requires CRUCIBLE_PROJECT_NAME;
            # harmless extra key for the other four clients.
            f.write("CRUCIBLE_PROJECT_NAME=cr061-skip-fleet-test\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        self._teardown_fake_no_mistakes()

    def test_skip_flag_is_accepted_by_every_clients_own_argparse(self):
        """Each of the five clients owns its OWN `gate-run` argparse
        subparser (CR-054 lifted the verb BODY, not the argparse wiring) --
        so this must be proven per-client, not once. `--project-dir` is
        supplied to actually reach dispatch (past the fake no-mistakes),
        so a failure here is unambiguously about `--skip` itself, not a
        missing prerequisite flag."""
        offenders = {}
        for name in CLIENT_FILES:
            module = _load_client_module(name)
            argv = ["gate-run", "--intent", "release gate", "--skip", "ci,pr",
                    "--agent", "test-agent", "--project-dir", self.tmpdir]
            calls = []

            def fake_post(path, payload, _calls=calls):
                _calls.append((path, copy.deepcopy(payload)))
                return {"ok": True}

            patch_targets = [n for n in ("_post",) if hasattr(module, n)]
            with contextlib.ExitStack() as stack:
                for n in patch_targets:
                    stack.enter_context(mock.patch.object(module, n, side_effect=fake_post))
                _code, _out, err = _run_main(module, argv)
            if "unrecognized arguments" in err or "invalid choice" in err:
                offenders[name] = err
        self.assertEqual(
            offenders, {},
            f"--skip must be accepted by EVERY client's gate-run argparse; "
            f"the following clients still reject it as unknown: {offenders}")

    def test_skip_flag_is_documented_in_every_clients_gate_run_help(self):
        offenders = []
        for name in CLIENT_FILES:
            module = _load_client_module(name)
            code, out, err = _run_main(module, ["gate-run", "--help"])
            help_text = out + err
            if "--skip" not in help_text:
                offenders.append(name)
        self.assertEqual(
            offenders, [],
            f"`gate-run --help` must document --skip on every client; "
            f"missing on: {offenders}")


# ---------------------------------------------------------------------------
# Contracts 2 + 3 -- end-to-end (through a real client's CLI dispatch): the
# value is passed through UNCHANGED, and omitting --skip leaks no default.
# ---------------------------------------------------------------------------


class GateRunSkipEndToEndPassthroughTest(_FakeNoMistakesOnPathMixin, unittest.TestCase):
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self._install_fake_no_mistakes()
        self.module = _load_client_module("bun")
        self.tmpdir = tempfile.mkdtemp(prefix="cr061-gate-run-skip-e2e-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write("CRUCIBLE_PROJECT_KEY=test-key-cr061-skip-e2e\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        self._teardown_fake_no_mistakes()

    def _fake_post(self, calls):
        def _post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return {"ok": True}
        return _post

    def test_skip_value_passed_through_unchanged_and_omission_leaks_no_default(self):
        """Both halves of the SAME passthrough invariant, in ONE test, on
        purpose (mirrors this directory's own established pattern, e.g.
        `test_bun_crucible_gates.py::CrCloseCrMergedMilestoneHookTest`): a
        test that checked ONLY the omission case would pass vacuously today
        (nothing produces a --skip token yet, --skip isn't even a
        recognized flag) and would prove nothing. Running the POSITIVE case
        first in the same test means this can only pass once BOTH the
        pass-through and the no-leaked-default behaviour are real.

        Positive half uses a deliberately UNUSUAL value -- internal spaces
        after the commas, an unrecognized step name -- so it must survive
        byte-for-byte into the `axi run` argv (CR's own words: 'the client
        must NOT hardcode, validate, or rewrite which steps are skipped');
        if the client normalized/stripped/validated it, this exact string
        would NOT come back unchanged."""
        skip_value = "ci, pr, totally-made-up-step"
        calls = []
        argv_with_skip = ["gate-run", "--intent", "release gate", "--skip", skip_value,
                           "--agent", "test-agent", "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_post", side_effect=self._fake_post(calls)):
            code, _out, err = _run_main(self.module, argv_with_skip)

        _assert_flag_not_rejected(self, err, repr(skip_value))
        self.assertEqual(code, 0, f"gate-run with --skip must succeed against the fake "
                                   f"no-mistakes; stderr={err!r}")
        proxied_argv_with_skip = self._captured_argv()
        self.assertIn(
            "--skip", proxied_argv_with_skip,
            f"the constructed `axi run` argv must contain --skip, got {proxied_argv_with_skip}")
        skip_index = proxied_argv_with_skip.index("--skip")
        self.assertEqual(
            proxied_argv_with_skip[skip_index + 1], skip_value,
            f"the value immediately following --skip must be the EXACT string "
            f"given, byte-for-byte -- no trimming/splitting/reformatting -- "
            f"got argv={proxied_argv_with_skip}")

        # -- negative half, same test: proves the omission case is a real
        # guard, not merely an unwired flag never reached above. --
        os.remove(self.argv_file)
        calls_without_skip = []
        argv_without_skip = ["gate-run", "--intent", "release gate",
                              "--agent", "test-agent", "--project-dir", self.tmpdir]
        with mock.patch.object(self.module, "_post",
                                side_effect=self._fake_post(calls_without_skip)):
            code2, _out2, err2 = _run_main(self.module, argv_without_skip)

        self.assertEqual(code2, 0, f"a plain gate-run (no --skip) must still succeed against "
                                    f"the fake no-mistakes; stderr={err2!r}")
        proxied_argv_without_skip = self._captured_argv()
        self.assertNotIn(
            "--skip", proxied_argv_without_skip,
            f"omitting --skip must not leak a default --skip token into the "
            f"`axi run` argv, got {proxied_argv_without_skip}")


# ---------------------------------------------------------------------------
# Contract 4 -- the passthrough exists ONCE, in the shared module. Proven by
# calling `_crucible_axi.cmd_gate_run` DIRECTLY, bypassing every client.
# ---------------------------------------------------------------------------


class _FakeOps:
    """The minimal duck-typed subset of `_crucible_axi.ClientOps` that
    `cmd_gate_run` actually touches (confirmed by reading the function body:
    `ops.agent_id`, `ops.post_gate`, `ops.emit`, `ops.context`) -- built here
    directly rather than via any client's `_ops()`, since the whole point of
    this test class is to prove the passthrough works with NO client
    involved at all."""

    def __init__(self):
        self.post_gate_calls = []
        self.emit_calls = []

    def agent_id(self, _args):
        return "cr061-direct-call-test-agent"

    def post_gate(self, project_dir, agent_id, gate, context):
        self.post_gate_calls.append(
            {"project_dir": project_dir, "agent_id": agent_id,
             "gate": copy.deepcopy(gate), "context": context})
        return {"ok": True}

    def emit(self, verb, ok, fields, context, warnings, legacy):
        self.emit_calls.append(
            {"verb": verb, "ok": ok, "fields": fields, "context": context,
             "warnings": warnings, "legacy": legacy})

    def context(self, project_dir, agent_id=None):
        return {"projectDir": project_dir, "agentId": agent_id}


class _DirectArgs:
    """A bare argparse.Namespace stand-in carrying only what `cmd_gate_run`
    reads off `args` (confirmed by reading the function: `args.intent`,
    `ops.agent_id(args)` -- and, once GREEN exists, `args.skip`)."""

    def __init__(self, intent, skip=None, agent="direct-call-agent"):
        self.intent = intent
        self.skip = skip
        self.agent = agent


class GateRunSkipSharedLocusDirectCallTest(_FakeNoMistakesOnPathMixin, unittest.TestCase):
    """Calls `_crucible_axi.cmd_gate_run` directly -- no client module in the
    call chain at all. This is the strongest available proof that the
    `--skip` passthrough lives in the ONE shared locus the CR's own gap
    analysis requires (`clients/_crucible_axi.py:~1654`), not duplicated or
    re-implemented inside any individual client's wrapper: if a future edit
    added `--skip` handling only inside (say) `bun-crucible.py`'s own
    `cmd_gate_run` function instead of here, this test would keep failing
    even though `GateRunSkipEndToEndPassthroughTest` above might start
    passing for bun alone."""

    def setUp(self):
        self._install_fake_no_mistakes()
        self.axi = _load_axi_module()
        self.tmpdir = tempfile.mkdtemp(prefix="cr061-gate-run-skip-direct-")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        self._teardown_fake_no_mistakes()

    def _no_mistakes_path(self):
        return shutil.which("no-mistakes")

    def test_shared_cmd_gate_run_passes_skip_through_and_omission_leaks_no_default(self):
        """Both halves in ONE test, same reasoning as the end-to-end sibling
        test above: an omission-only check would pass vacuously today (the
        shared function doesn't touch `args.skip` at all yet), proving
        nothing. Calling `cmd_gate_run` directly -- no client module
        involved -- is the strongest available proof that this passthrough
        lives in the ONE shared locus the CR requires, not re-implemented
        per client."""
        skip_value = "test,document,lint,ci"
        ops = _FakeOps()
        args_with_skip = _DirectArgs(intent="cycle 187 release gate", skip=skip_value)

        result = self.axi.cmd_gate_run(
            args_with_skip, self.tmpdir, self._no_mistakes_path(), ops)

        self.assertEqual(result, 0, "the direct shared-module call must succeed "
                                     "against the fake no-mistakes")
        proxied_argv_with_skip = self._captured_argv()
        self.assertIn(
            "--skip", proxied_argv_with_skip,
            f"_crucible_axi.cmd_gate_run itself must build --skip into the "
            f"axi run argv when args.skip is set, got {proxied_argv_with_skip}")
        skip_index = proxied_argv_with_skip.index("--skip")
        self.assertEqual(
            proxied_argv_with_skip[skip_index + 1], skip_value,
            f"the shared function must pass the EXACT value through, got "
            f"argv={proxied_argv_with_skip}")
        self.assertEqual(
            len(ops.post_gate_calls), 1,
            f"the shared call must still seal exactly one final gate, got "
            f"{ops.post_gate_calls}")

        # -- negative half, same test: proves the omission case is a real
        # guard, not merely an unreached code path above. --
        os.remove(self.argv_file)
        ops2 = _FakeOps()
        args_without_skip = _DirectArgs(intent="cycle 187 release gate", skip=None)

        result2 = self.axi.cmd_gate_run(
            args_without_skip, self.tmpdir, self._no_mistakes_path(), ops2)

        self.assertEqual(result2, 0)
        proxied_argv_without_skip = self._captured_argv()
        self.assertNotIn(
            "--skip", proxied_argv_without_skip,
            f"_crucible_axi.cmd_gate_run must not leak a --skip token when "
            f"args.skip is unset, got {proxied_argv_without_skip}")


if __name__ == "__main__":
    unittest.main()
