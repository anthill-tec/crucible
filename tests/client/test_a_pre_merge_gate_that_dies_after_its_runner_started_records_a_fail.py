"""RED -- the second half of the escaping-failure change: `run_verb`'s
`pre-merge-gate` milestone bracket (`clients/_crucible_axi.py::run_verb`,
the `if (getattr(args, "cmd", None) == GATE_VERB ...` tail) only reaches
`record_gate_outcome` when `func(args)` RETURNS -- every `except` clause
above it (today: the six typed hard stops) `return`s directly, skipping that
tail entirely. So a gate whose verb body raises `OSError`/`ValueError`
AFTER its runner has genuinely started (the fail-fast step passed, or was
skipped, and the expensive regression run began) records NO milestone at
all today, and (per the companion file,
`test_an_escaping_os_or_value_error_becomes_an_envelope.py`) ALSO prints an
uncaught traceback instead of the `ok:false` envelope.

SCOPE NOTE for the orchestrator: all five clients' `main()` dispatch
`pre-merge-gate` through this exact call --
`_axi().run_verb(args.func, args, ..., ops_fn=_ops, project_dir_fn=...)` --
confirmed identical (grepped directly, cited per client below). `run_verb`
and `record_gate_outcome` are therefore the ONE shared mechanism backing all
five, with no per-client divergence in this path (unlike, say,
`cmd_pre_merge_gate`'s own per-client fail-fast step). This file drives that
shared mechanism DIRECTLY -- through the real `python-crucible.py` module's
own real `_ops()`/`_project_key()` (never a hand-built duck-typed stub for
those two), with a stub verb body standing in for "a pre-merge-gate body
that raises after its runner started" -- rather than re-running a full,
five-times-over toolchain-stubbed end-to-end drive per client (the full
real-board drive this change's RED budget could not also absorb; see this
file's own report for the explicit scope-down). `run_verb` is never
REPLACED -- it is the function under test, called for real, with a REAL
`ClientOps` (`python-crucible.py::_ops()`) whose own `_post`/`_get` are
patched to RECORD instead of reach the network -- never a fake `run_verb`.

  arduino-crucible.py:1755  sys.exit(_axi().run_verb(
  bun-crucible.py:2829      sys.exit(_axi().run_verb(
  mvn-crucible.py:2808      sys.exit(_axi().run_verb(
  python-crucible.py:2078   sys.exit(_axi().run_verb(
  rust-crucible.py:3532     sys.exit(_axi().run_verb(

The "hard stop before the runner started still records none" half of this
behaviour ALREADY holds, unchanged (every typed-hard-stop `except` clause
in `run_verb` already `return`s before the milestone tail, and
`test_an_unattributed_run_is_refused_while_a_cycle_is_active.py` already
drives a pre-merge-gate hard-stop refusal end to end) -- not re-asserted
here as a new RED test, since a test that already passes today proves
nothing new (RED rule).

No CR-shaped literal anywhere (the fixture project key/agent id below are
plain lowercase words)."""

import argparse
import shutil
import unittest
from unittest import mock

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _load_module,
    _make_project_dir,
)

PYTHON_CLIENT = CLIENT_FILES["python"]


class _RecordingPost:
    """Stands in for the real `_post`: records every call and answers a
    generic `{"ok": True}` for every path, so `record_gate_outcome`'s own
    identity-open/milestone/unregister POSTs all succeed locally -- no
    socket, :3849/:3850 never touched."""

    def __init__(self):
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, payload))
        return {"ok": True}


class _RecordingGet:
    """Stands in for `_get`: `record_gate_outcome` reaches this only through
    `_cycle_cr` (`ops.get(plans_path(...))`), which tolerates any answer that
    is not `ok`."""

    def __init__(self):
        self.calls = []

    def __call__(self, path, timeout=10):
        self.calls.append(path)
        return {"ok": False}


def _milestone_posts(recording_post):
    return [payload for path, payload in recording_post.calls
            if path == "/api/v2/milestones"]


class GateDiedAfterItsRunnerStartedRecordsAFailTest(unittest.TestCase):
    """Drives the REAL, shared `run_verb` + `record_gate_outcome`
    (`clients/_crucible_axi.py`) through the REAL `python-crucible.py`
    module's own `_ops()`/`_project_key()`, with the verb body itself a
    stand-in for "the regression run genuinely started, then the gate's own
    body raised" (fail-fast and the real toolchain spawn are the per-client
    HALF of the gate this file is explicitly not re-driving; see the module
    docstring's scope note)."""

    def setUp(self):
        self.project_dir = _make_project_dir("python")
        self.module = _load_module(
            PYTHON_CLIENT, f"gate_dies_after_start_{self._testMethodName}")
        self.recording_post = _RecordingPost()
        self.recording_get = _RecordingGet()
        self._post_patcher = mock.patch.object(
            self.module, "_post", self.recording_post)
        self._get_patcher = mock.patch.object(
            self.module, "_get", self.recording_get)
        self._post_patcher.start()
        self._get_patcher.start()

    def tearDown(self):
        self._post_patcher.stop()
        self._get_patcher.stop()
        shutil.rmtree(self.project_dir, ignore_errors=True)

    def _args(self):
        return argparse.Namespace(
            cmd="pre-merge-gate", agent="gate-fixture-agent",
            cycle=4242, project_dir=str(self.project_dir))

    def _run_verb(self, func):
        axi = self.module._axi()
        args = self._args()
        return axi.run_verb(
            func, args,
            project_key_fn=lambda a: self.module._project_key(str(self.project_dir)),
            ops_fn=self.module._ops,
            project_dir_fn=lambda a: str(self.project_dir))

    def test_oserror_after_the_runner_started_still_posts_a_fail_milestone(self):
        def _body_that_dies_after_its_runner_started(_args):
            # Simulates the fail-fast step having passed (or been skipped)
            # and the expensive regression run having genuinely begun, then
            # an OSError escaping while moving/reading its report -- the
            # exact defect class: an I/O failure escaping the gate's body.
            raise OSError("no space left on device while moving the merged report")

        code = self._run_verb(_body_that_dies_after_its_runner_started)

        self.assertIsInstance(
            code, int,
            "run_verb did not return an exit code at all -- the OSError "
            "most likely propagated out of run_verb uncaught")
        self.assertNotEqual(code, 0)
        milestones = _milestone_posts(self.recording_post)
        self.assertEqual(
            len(milestones), 1,
            f"expected exactly ONE pre-merge-gate milestone POST, got "
            f"{len(milestones)}: {self.recording_post.calls!r}")
        milestone = milestones[0]
        self.assertEqual(milestone.get("type"), "pre-merge-gate")
        self.assertEqual(
            milestone.get("outcome"), "fail",
            f"a gate that died after its runner started must record "
            f"outcome=fail, got {milestone!r}")

    def test_valueerror_after_the_runner_started_still_posts_a_fail_milestone(self):
        def _body_that_dies_after_its_runner_started(_args):
            raise ValueError("could not parse the report's pass/fail counts")

        code = self._run_verb(_body_that_dies_after_its_runner_started)

        self.assertIsInstance(code, int)
        self.assertNotEqual(code, 0)
        milestones = _milestone_posts(self.recording_post)
        self.assertEqual(
            len(milestones), 1,
            f"expected exactly ONE pre-merge-gate milestone POST, got "
            f"{len(milestones)}: {self.recording_post.calls!r}")
        self.assertEqual(milestones[0].get("outcome"), "fail")


if __name__ == "__main__":
    unittest.main()
