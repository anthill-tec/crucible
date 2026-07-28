"""CR-CRU-044 C4 RED -- §S5 the agent identity hard stop, `clients/bun-crucible.py`.

Found live 2026-07-28: `_agent_id()` (bun-crucible.py, currently near line 1545)
fabricates an agent identity for the fleet gate/milestone verbs when no
`--agent` is given:

    explicit = getattr(args, "agent", None)
    if explicit:
        return explicit
    return os.environ.get("WORKFLOW_ROLE") or "bun-crucible"

This planted a phantom `bun-crucible` row on the LIVE dashboard's agent rail
(§S5) -- confirmed to REGENERATE continuously, not just historical residue.
User directive: the agent identity must be DEFINED or the verb FAILS. There
is no fallback, no default, and no fabricated value -- not even a
`$WORKFLOW_ROLE`-derived one, because `WORKFLOW_ROLE` carries the TRACK LANE
(`mainline` | `track-n`), not an agent identity (PRD-crucible-v2.md:291,
DN-model-b-language.md:53, `clients/_crucible_axi.py:71-73`/`:373-375` both
read it into `ctx["track"]`, never an id). Registering `mainline` or
`track-2` as an agent would be the exact same category error as
`bun-crucible`, merely tidier-looking -- explicitly NOT an acceptable fix.

RED phase: `_agent_id()` today returns the fallback string for `gate-report`,
`gate-run`, and `milestone` when `--agent` is omitted (WORKFLOW_ROLE unset or
set) -- every hard-stop assertion below fails against that current behaviour
(exit 0 instead of non-zero, a gate/milestone IS posted instead of nothing).

Module-loading + HTTP-mocking convention copied verbatim from the sibling
`test_bun_crucible_gates.py` harness (REPO_ROOT-relative load, real argparse
dispatch via `module.main()`, mocking `_post` so :3849 is never touched).

Invocation:
    python3 -m pytest tests/client/test_bun_crucible_agent_identity_required.py -q
Fallback:
    python3 tests/client/test_bun_crucible_agent_identity_required.py
"""

import contextlib
import copy
import importlib.util
import io
import os
import re
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"
CLIENTS_DIR = REPO_ROOT / "clients"

# A distinctive marker planted in the fake `no-mistakes`'s snapshot -- proves
# gate-run reached (or did not reach) the underlying axi run at all.
_RELAY_MARKER = "agent-identity-relay-marker-xyz321"
_FINAL_SNAPSHOT = (
    'run:\n'
    '  id: "agent-identity-test-001"\n'
    f'  branch: {_RELAY_MARKER}\n'
    '  status: completed\n'
    '  head: abc1234\n'
    '  findings: 0\n'
    '  steps[1]{step,status,findings,duration_ms}:\n'
    '    intent,completed,0,10\n'
    'outcome: passed\n'
)
_FAKE_NO_MISTAKES_BODY = f'''
import sys

argv = sys.argv[1:]
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "status"):
    sys.stdout.write({_FINAL_SNAPSHOT!r})
    sys.exit(0)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''


def _load_bun_crucible_module():
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_agent_identity", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    full_argv = ["bun-crucible.py"] + argv
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


def _write_fake_no_mistakes(bin_dir):
    fake_path = os.path.join(bin_dir, "no-mistakes")
    with open(fake_path, "w") as f:
        f.write(f"#!{sys.executable}\n")
        f.write(_FAKE_NO_MISTAKES_BODY)
    st = os.stat(fake_path)
    os.chmod(fake_path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


class _BaseAgentIdentityTest(unittest.TestCase):
    PROJECT_KEY = "test-key-agent-identity"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-agent-identity-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="fake-no-mistakes-agent-identity-")
        _write_fake_no_mistakes(self.fake_bin_dir)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        os.environ["PATH"] = self._saved_path
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _post_recorder(self, calls, ok=True, error=None):
        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return {"ok": ok} if ok else {"ok": False, "error": error or "boom"}
        return fake_post

    def _gate_report_argv(self, extra=None):
        argv = ["gate-report", "--outcome", "passed", "--commit", "abc1234",
                "--steps", "review:passed,test:passed", "--project-dir", self.tmpdir]
        return argv + (extra or [])

    def _gate_run_argv(self, extra=None):
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path
        argv = ["gate-run", "--intent", "verify the identity fix", "--project-dir", self.tmpdir]
        return argv + (extra or [])

    def _milestone_argv(self, extra=None):
        argv = ["milestone", "--type", "stage-flip", "--label", "wave 4 -> gated",
                "--project-dir", self.tmpdir]
        return argv + (extra or [])


# ---------------------------------------------------------------------------
# §S5 AC1 -- hard stop when no --agent is given, per verb.
# ---------------------------------------------------------------------------


class GateMilestoneHardStopWithNoAgentTest(_BaseAgentIdentityTest):

    def test_gate_report_with_no_agent_and_no_workflow_role_hard_stops(self):
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, self._gate_report_argv())

        self.assertNotEqual(code, 0,
                             "gate-report with no --agent and no WORKFLOW_ROLE must hard-stop, "
                             f"got code=0 stdout={out!r}")
        self.assertEqual(calls, [],
                          f"a hard-stopped gate-report must post NOTHING, got {calls}")
        self.assertIn("--agent", out + err,
                      "the hard-stop error must name --agent as how to supply the identity")

    def test_gate_run_with_no_agent_and_no_workflow_role_hard_stops(self):
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, self._gate_run_argv())

        self.assertNotEqual(code, 0,
                             "gate-run with no --agent and no WORKFLOW_ROLE must hard-stop, "
                             f"got code=0 stdout={out!r}")
        self.assertEqual(calls, [],
                          f"a hard-stopped gate-run must post NOTHING, got {calls}")
        self.assertNotIn(_RELAY_MARKER, out,
                          "a hard-stopped gate-run must never even reach the no-mistakes "
                          "proxy -- the relay marker must not appear")
        self.assertIn("--agent", out + err,
                      "the hard-stop error must name --agent as how to supply the identity")

    def test_milestone_with_no_agent_and_no_workflow_role_hard_stops(self):
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, self._milestone_argv())

        self.assertNotEqual(code, 0,
                             "milestone with no --agent and no WORKFLOW_ROLE must hard-stop, "
                             f"got code=0 stdout={out!r}")
        self.assertEqual(calls, [],
                          f"a hard-stopped milestone must post NOTHING, got {calls}")
        self.assertIn("--agent", out + err,
                      "the hard-stop error must name --agent as how to supply the identity")


# ---------------------------------------------------------------------------
# §S5 gap-analysis resolution -- WORKFLOW_ROLE must NOT supply an identity.
# ---------------------------------------------------------------------------


class WorkflowRoleIsNotAnIdentityTest(_BaseAgentIdentityTest):

    def test_milestone_with_workflow_role_mainline_and_no_agent_still_hard_stops(self):
        """The orchestrator identity is `vidushi`, never `mainline` -- a
        mainline run with WORKFLOW_ROLE=mainline and no --agent must NOT
        register an agent literally named `mainline`; it must hard-stop
        exactly like the bare no-WORKFLOW_ROLE case."""
        os.environ["WORKFLOW_ROLE"] = "mainline"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, self._milestone_argv())

        self.assertNotEqual(code, 0,
                             "WORKFLOW_ROLE=mainline must NOT supply an identity -- milestone "
                             f"must still hard-stop, got code=0 stdout={out!r}")
        self.assertEqual(calls, [],
                          f"no milestone may be posted -- no agent named 'mainline' may reach "
                          f"the rail, got {calls}")

    def test_gate_report_with_workflow_role_track_n_and_no_agent_still_hard_stops(self):
        os.environ["WORKFLOW_ROLE"] = "track-2"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, self._gate_report_argv())

        self.assertNotEqual(code, 0,
                             "WORKFLOW_ROLE=track-2 must NOT supply an identity -- gate-report "
                             f"must still hard-stop, got code=0 stdout={out!r}")
        self.assertEqual(calls, [],
                          f"no gate may be posted -- no agent named 'track-2' may reach the "
                          f"rail, got {calls}")

    def test_gate_run_with_workflow_role_and_no_agent_still_hard_stops(self):
        os.environ["WORKFLOW_ROLE"] = "track-1"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, self._gate_run_argv())

        self.assertNotEqual(code, 0,
                             "WORKFLOW_ROLE=track-1 must NOT supply an identity -- gate-run "
                             f"must still hard-stop, got code=0 stdout={out!r}")
        self.assertEqual(calls, [], f"no gate may be posted, got {calls}")
        self.assertNotIn(_RELAY_MARKER, out,
                          "a hard-stopped gate-run must never reach the no-mistakes proxy")


# ---------------------------------------------------------------------------
# §S5 gap-analysis resolution -- WORKFLOW_ROLE still populates context.track
# when an explicit --agent IS supplied (guard against over-correcting).
# ---------------------------------------------------------------------------


class WorkflowRoleStillPopulatesTrackTest(_BaseAgentIdentityTest):

    def test_milestone_with_explicit_agent_and_workflow_role_still_posts_track(self):
        os.environ["WORKFLOW_ROLE"] = "track-3"
        calls = []
        argv = self._milestone_argv(["--agent", "CR-CRU-044-C4-explicit"])
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, argv)

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        ms_calls = [c for c in calls if c[0] == "/api/v2/milestones"]
        self.assertEqual(len(ms_calls), 1, f"expected exactly ONE milestone POST, got {calls}")
        payload = ms_calls[0][1]
        self.assertEqual(payload.get("context", {}).get("track"), "track-3",
                          "WORKFLOW_ROLE must still populate context.track "
                          "when --agent is explicit -- the identity fix must not "
                          f"silently break track attribution, got {payload}")

    def test_gate_report_with_explicit_agent_and_workflow_role_still_posts_track(self):
        os.environ["WORKFLOW_ROLE"] = "track-4"
        calls = []
        argv = self._gate_report_argv(["--agent", "CR-CRU-044-C4-explicit"])
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, argv)

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        gate_calls = [c for c in calls if c[0] == "/api/v2/gates"]
        self.assertEqual(len(gate_calls), 1, f"expected exactly ONE gate POST, got {calls}")
        context = gate_calls[0][1].get("context") or {}
        self.assertEqual(context.get("track"), "track-4",
                          f"WORKFLOW_ROLE must still populate context.track, got {context}")


# ---------------------------------------------------------------------------
# §S5 AC5 -- explicit --agent alone (no WORKFLOW_ROLE) is the happy path and
# must not regress.
# ---------------------------------------------------------------------------


class ExplicitAgentStillWorksTest(_BaseAgentIdentityTest):

    def test_milestone_with_explicit_agent_and_no_workflow_role_succeeds(self):
        calls = []
        argv = self._milestone_argv(["--agent", "CR-CRU-044-C4-explicit-only"])
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, argv)

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        ms_calls = [c for c in calls if c[0] == "/api/v2/milestones"]
        self.assertEqual(len(ms_calls), 1, f"expected exactly ONE milestone POST, got {calls}")

    def test_gate_run_with_explicit_agent_and_no_workflow_role_succeeds_and_relays(self):
        calls = []
        argv = self._gate_run_argv(["--agent", "CR-CRU-044-C4-explicit-only"])
        with mock.patch.object(self.module, "_post", side_effect=self._post_recorder(calls)):
            code, out, err = _run_main(self.module, argv)

        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        self.assertIn(_RELAY_MARKER, out,
                      "an explicit --agent must let gate-run proceed normally and relay "
                      "the no-mistakes axi detail")
        gate_calls = [c for c in calls if c[0] == "/api/v2/gates"]
        self.assertGreaterEqual(len(gate_calls), 1, f"expected >=1 gate POST, got {calls}")


# ---------------------------------------------------------------------------
# §S5 AC -- no filename-derived fallback survives, asserted for THIS client.
# ---------------------------------------------------------------------------


class NoFilenameFallbackSurvivesTest(unittest.TestCase):

    def test_bun_crucible_source_has_no_filename_derived_agent_fallback(self):
        source = SCRIPT_PATH.read_text()
        self.assertNotRegex(
            source, r'or "bun-crucible"',
            "clients/bun-crucible.py must not fall back to a fabricated "
            "'bun-crucible' agent identity -- §S5 hard stop, no fallback, no "
            "nicer-looking default string either")

    def test_repo_wide_grep_for_any_client_filename_fallback_finds_nothing(self):
        """Pinned verbatim from the CR's own AC: `grep -rn 'or "\\(bun\\|python\\|
        rust\\|mvn\\|arduino\\)-crucible"' clients/` must find nothing."""
        pattern = re.compile(r'or "(bun|python|rust|mvn|arduino)-crucible"')
        hits = []
        for path in sorted(CLIENTS_DIR.glob("*.py")):
            text = path.read_text()
            for lineno, line in enumerate(text.splitlines(), start=1):
                if pattern.search(line):
                    hits.append(f"{path.name}:{lineno}: {line.strip()}")
        self.assertEqual(hits, [],
                          f"no filename-derived agent fallback may survive anywhere under "
                          f"clients/, found: {hits}")


if __name__ == "__main__":
    unittest.main()
