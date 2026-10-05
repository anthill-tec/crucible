"""`gate_from_axi` (`clients/_crucible_axi.py`) keeps each step's findings
count from the no-mistakes snapshot on the posted gate step.

Ground truth, measured directly from `clients/_crucible_axi.py` before this
file: `gate_from_axi` builds each step as
`{"name": s.get("step"), "status": map_axi_step_status(st)}` — the decoded
row's own `findings` cell (always present in the real tool's
`steps[N]{step,status,findings,duration_ms}` TOON header, already read by
`s.get("findings")` nowhere in this function) is simply never carried onto
the posted step. Every client (`python-crucible.py`, `bun-crucible.py`,
`mvn-crucible.py`, `rust-crucible.py`, `arduino-crucible.py`) reaches this
SAME function for BOTH `gate-run` (via `stream_axi_ladder`'s interim post and
`drive_axi_run`'s final seal) and `gate-respond` (via `drive_axi_run`'s final
seal only — `cmd_gate_respond` never calls `stream_axi_ladder` for an interim
post of its own, it drives the SAME shared runner `gate-run` uses), so a step
reaching the board today never carries its findings count, whichever client
or verb posted it.

RED-agent decisions, documented rather than guessed:
  - EXPLICIT zero is kept, never dropped. `steps[n]{...}` legitimately
    reports a step that found nothing; a truthy-style guard
    (`if s.get("findings"): ...`) would silently drop that fact, the same
    class of bug already removed from step statuses elsewhere in this same
    mapper. Pinned directly: an explicit 0 cell must still reach the board as
    `findings: 0`, not an absent key.
  - An ABSENT findings column (a header that never named `findings` at all —
    the same "tabular header omits a field" shape the sibling step-status
    suite already proves the TOON reader really produces) carries no
    `findings` key on the posted step — never a fabricated 0. This mirrors
    the project-wide "optional field, present only when the source reported
    it" rule every other optional gate/step/decision field in this codebase
    follows (`gate.outcome`, `gate.push`, `decision.step`, …).
  - All FIVE clients are proven end-to-end (not just the shared function in
    isolation): each one's OWN `cmd_gate_run` and `cmd_gate_respond` is
    driven through a fake `no-mistakes` on PATH, and the gate actually
    POSTed to `/api/v2/gates` is inspected — proof that the shared fix
    really reaches the board through every client's own wrapper, not just
    through a function nobody's CLI calls.

Invocation:
    python3 -m pytest tests/client/test_the_gate_step_carries_the_no_mistakes_findings_count.py -q
Fallback:
    python3 tests/client/test_the_gate_step_carries_the_no_mistakes_findings_count.py
"""

import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

GATES_PATH = "/api/v2/gates"
GATE_DECISIONS_PATH = "/api/v2/gate-decisions"

CLIENT_SCRIPTS = {
    "python": CLIENTS_DIR / "python-crucible.py",
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}

INTENT = "carry the findings count onto the ladder"


def _load_module(path, name):
    """Load a client module by file path — the fleet harness idiom every
    sibling test in this directory uses."""
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AXI = _load_module(AXI_MODULE_PATH, "axi_under_test_step_findings")


# ═════════════════════════════════════════════════════════════════════════
# PART 1 — the mapper itself, at the ladder level (mirrors the sibling
# step-status suite's own convention: pin the defect where it actually
# reaches the board, through `gate_from_axi`, not just a pure-function
# unit).
# ═════════════════════════════════════════════════════════════════════════


class _LadderTestBase(unittest.TestCase):
    def ladder(self, snapshot, final=False):
        decoded = _AXI._decode_axi_snapshot(snapshot)
        self.assertIsInstance(
            decoded, dict,
            "harness: the fixture must decode through the client's own TOON "
            "reader before anything can be asserted about the ladder it "
            "produces; got " + repr(decoded))
        gate, nsteps = _AXI.gate_from_axi(decoded, INTENT, final=final)
        return gate, nsteps

    def step(self, gate, name):
        rows = [s for s in gate["steps"] if s["name"] == name]
        self.assertEqual(
            len(rows), 1,
            "harness: exactly one " + repr(name) + " row on the ladder; got "
            + repr(gate["steps"]))
        return rows[0]


_TWO_STEP_HEAD = (
    'run:\n'
    '  id: "run-findings-ladder-1"\n'
    '  branch: findings-count-ladder\n'
    '  status: {status}\n'
    '  head: abcd1234\n'
    '  findings: 5\n'
)

_INTERIM_SNAPSHOT = (
    _TWO_STEP_HEAD.format(status="running")
    + '  steps[3]{step,status,findings,duration_ms}:\n'
    + '    review,completed,3,500\n'
    + '    test,running,2,300\n'
    + '    lint,pending,0,0\n'
)

_SEALED_SNAPSHOT = (
    _TWO_STEP_HEAD.format(status="completed")
    + '  steps[3]{step,status,findings,duration_ms}:\n'
    + '    review,completed,3,500\n'
    + '    test,completed,2,300\n'
    + '    lint,completed,0,100\n'
    + 'outcome: passed\n'
)

# No `findings` column in the tabular header at all — the shape the TOON
# reader really produces for a header that never named the field (same
# "header omits a column" fixture style the sibling step-status suite
# proves against `status`).
_NO_FINDINGS_COLUMN_SNAPSHOT = (
    _TWO_STEP_HEAD.format(status="completed")
    + '  steps[2]{step,status,duration_ms}:\n'
    + '    review,completed,500\n'
    + '    test,completed,300\n'
    + 'outcome: passed\n'
)


class GateFromAxiCarriesStepFindingsCountTest(_LadderTestBase):
    def test_an_interim_ladder_carries_each_steps_own_findings_count(self):
        gate, nsteps = self.ladder(_INTERIM_SNAPSHOT, final=False)
        self.assertEqual(nsteps, 3)
        self.assertEqual(self.step(gate, "review").get("findings"), 3)
        self.assertEqual(self.step(gate, "test").get("findings"), 2)

    def test_a_sealed_ladder_carries_each_steps_own_findings_count(self):
        gate, nsteps = self.ladder(_SEALED_SNAPSHOT, final=True)
        self.assertEqual(nsteps, 3)
        self.assertEqual(self.step(gate, "review").get("findings"), 3)
        self.assertEqual(self.step(gate, "test").get("findings"), 2)

    def test_an_explicit_zero_findings_cell_is_kept_not_dropped(self):
        """A truthy-style guard (`if s.get("findings")`) would silently turn
        a reported zero into an absent key — the same defect class
        already removed from step statuses elsewhere in this same mapper.
        `lint` reported ZERO findings; the posted step must say so, not omit
        the field."""
        gate, _ = self.ladder(_SEALED_SNAPSHOT, final=True)
        lint = self.step(gate, "lint")
        self.assertIn(
            "findings", lint,
            "an explicit 0 is a REPORTED fact ('nothing was found at this "
            "step'), not the absence of one — got " + repr(lint))
        self.assertEqual(lint.get("findings"), 0)

    def test_a_header_with_no_findings_column_posts_no_findings_key_at_all(self):
        """The RED-agent choice documented in the module docstring: absence
        in, absence out — never a fabricated 0."""
        gate, nsteps = self.ladder(_NO_FINDINGS_COLUMN_SNAPSHOT, final=True)
        self.assertEqual(nsteps, 2)
        for s in gate["steps"]:
            self.assertNotIn(
                "findings", s,
                "the snapshot's tabular header named no `findings` column "
                "at all, so no count may be invented for any row; got "
                + repr(s))

    def test_the_eight_untouched_fields_of_a_ladder_step_are_unaffected(self):
        """Bound: carrying `findings` may not disturb `name`/`status`."""
        gate, _ = self.ladder(_SEALED_SNAPSHOT, final=True)
        self.assertEqual(
            [(s["name"], s["status"]) for s in gate["steps"]],
            [("review", "passed"), ("test", "passed"), ("lint", "passed")])


# ═════════════════════════════════════════════════════════════════════════
# PART 2 — end-to-end, through EACH of the five clients' own `cmd_gate_run`
# / `cmd_gate_respond`, proving the fix really reaches the board via every
# client's own wrapper (parity), for BOTH verbs.
# ═════════════════════════════════════════════════════════════════════════

_FAKE_NO_MISTAKES_BODY = '''
import os
import sys

argv = sys.argv[1:]
if len(argv) >= 2 and argv[0] == "axi" and argv[1] in ("run", "respond", "status"):
    stdout_path = os.environ.get("GATE_FINDINGS_FAKE_STDOUT_FILE")
    exit_path = os.environ.get("GATE_FINDINGS_FAKE_EXIT_FILE")
    text = ""
    if stdout_path and os.path.exists(stdout_path):
        with open(stdout_path) as f:
            text = f.read()
    code = 0
    if exit_path and os.path.exists(exit_path):
        with open(exit_path) as f:
            code = int(f.read().strip() or "0")
    if text:
        sys.stdout.write(text)
    sys.exit(code)
else:
    sys.stderr.write("fake no-mistakes: unsupported invocation: " + repr(argv) + "\\n")
    sys.exit(1)
'''

# The snapshot EVERY client's fake `no-mistakes` answers with: two steps,
# two DIFFERENT findings counts, so a parity bug that posted the same number
# twice (or the right count on the wrong step) is caught.
_PARITY_SNAPSHOT = (
    'run:\n'
    '  id: "run-findings-parity-1"\n'
    '  branch: findings-count-parity\n'
    '  status: completed\n'
    '  head: abc9999\n'
    '  findings: 5\n'
    '  steps[2]{step,status,findings,duration_ms}:\n'
    '    review,completed,3,200\n'
    '    test,completed,2,150\n'
    'outcome: passed\n'
)


def _fake_post(calls, gate_event_id="evt-findings-parity", decision_id="dec-findings-parity"):
    def _post(path, payload):
        calls.append((path, payload))
        if path == GATES_PATH:
            return {"ok": True, "changed": True, "event": gate_event_id}
        if path == GATE_DECISIONS_PATH:
            return {"ok": True, "changed": True, "decision": decision_id}
        return {"ok": True}
    return _post


class _FiveClientGateFindingsParityHarness(unittest.TestCase):
    """One fake `no-mistakes` on PATH, driven through each of the five real
    client scripts' own `main()` dispatch — never a re-implemented copy of
    the CLI, the real argparse surface every operator actually calls."""

    def setUp(self):
        self._saved_path = os.environ.get("PATH", "")
        self.fake_bin_dir = tempfile.mkdtemp(prefix="gate-findings-fake-nm-bin-")
        fake_path = os.path.join(self.fake_bin_dir, "no-mistakes")
        with open(fake_path, "w") as f:
            f.write(f"#!{sys.executable}\n")
            f.write(_FAKE_NO_MISTAKES_BODY)
        os.chmod(fake_path, 0o700)
        os.environ["PATH"] = self.fake_bin_dir + os.pathsep + self._saved_path

        self.fake_state_dir = tempfile.mkdtemp(prefix="gate-findings-fake-state-")
        self.stdout_file = os.path.join(self.fake_state_dir, "stdout.txt")
        self.exit_file = os.path.join(self.fake_state_dir, "exit.txt")
        os.environ["GATE_FINDINGS_FAKE_STDOUT_FILE"] = self.stdout_file
        os.environ["GATE_FINDINGS_FAKE_EXIT_FILE"] = self.exit_file
        with open(self.stdout_file, "w") as f:
            f.write(_PARITY_SNAPSHOT)
        with open(self.exit_file, "w") as f:
            f.write("0")

    def tearDown(self):
        os.environ["PATH"] = self._saved_path
        os.environ.pop("GATE_FINDINGS_FAKE_STDOUT_FILE", None)
        os.environ.pop("GATE_FINDINGS_FAKE_EXIT_FILE", None)
        shutil.rmtree(self.fake_bin_dir, ignore_errors=True)
        shutil.rmtree(self.fake_state_dir, ignore_errors=True)

    def _project_dir(self, client_name):
        tmpdir = tempfile.mkdtemp(prefix=f"gate-findings-{client_name}-project-")
        with open(os.path.join(tmpdir, ".env"), "w") as f:
            f.write("CRUCIBLE_PROJECT_KEY=test-key-gate-findings-parity\n")
            if client_name == "arduino":
                f.write("CRUCIBLE_PROJECT_NAME=gate-findings-parity\n")
        self.addCleanup(shutil.rmtree, tmpdir, ignore_errors=True)
        return tmpdir

    def _run_main(self, module, script_path, argv):
        full_argv = [str(script_path)] + argv
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(sys, "argv", full_argv), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
        return code, stdout.getvalue(), stderr.getvalue()

    def _last_gate_payload(self, calls):
        gate_calls = [c for c in calls if c[0] == GATES_PATH]
        self.assertGreaterEqual(
            len(gate_calls), 1,
            f"no gate was ever POSTed to {GATES_PATH}; calls={calls}")
        return gate_calls[-1][1]

    def _assert_steps_carry_the_snapshots_findings(self, payload, client_name, verb):
        gate = payload.get("gate") or {}
        steps = gate.get("steps")
        self.assertIsInstance(
            steps, list,
            f"[{client_name}/{verb}] posted gate carries no steps array at "
            f"all: {payload!r}")
        by_name = {s.get("name"): s for s in (steps or [])}
        self.assertIn("review", by_name, f"[{client_name}/{verb}] steps={steps!r}")
        self.assertIn("test", by_name, f"[{client_name}/{verb}] steps={steps!r}")
        self.assertEqual(
            by_name["review"].get("findings"), 3,
            f"[{client_name}/{verb}] review step must carry the snapshot's "
            f"own findings count (3); got {by_name['review']!r}")
        self.assertEqual(
            by_name["test"].get("findings"), 2,
            f"[{client_name}/{verb}] test step must carry the snapshot's "
            f"own findings count (2); got {by_name['test']!r}")


class GateRunCarriesStepFindingsInEveryClientTest(_FiveClientGateFindingsParityHarness):
    def test_gate_run_posts_steps_carrying_findings_in_every_client(self):
        for client_name, script_path in CLIENT_SCRIPTS.items():
            with self.subTest(client=client_name):
                tmpdir = self._project_dir(client_name)
                module = _load_module(
                    script_path, f"gate_findings_run_{client_name}_under_test")
                calls = []
                argv = ["gate-run", "--intent", INTENT, "--agent", "test-agent",
                        "--project-dir", tmpdir]
                with mock.patch.object(module, "_post", side_effect=_fake_post(calls)):
                    code, out, err = self._run_main(module, script_path, argv)
                self.assertNotIn(
                    "invalid choice", err,
                    f"[{client_name}] gate-run must be a registered "
                    f"subcommand: {err!r}")
                payload = self._last_gate_payload(calls)
                self._assert_steps_carry_the_snapshots_findings(
                    payload, client_name, "gate-run")


class GateRespondCarriesStepFindingsInEveryClientTest(_FiveClientGateFindingsParityHarness):
    def test_gate_respond_posts_its_final_seal_steps_carrying_findings_in_every_client(self):
        for client_name, script_path in CLIENT_SCRIPTS.items():
            with self.subTest(client=client_name):
                tmpdir = self._project_dir(client_name)
                module = _load_module(
                    script_path, f"gate_findings_respond_{client_name}_under_test")
                calls = []
                argv = ["gate-respond", "--action", "approve", "--agent", "test-agent",
                        "--project-dir", tmpdir]
                with mock.patch.object(module, "_post", side_effect=_fake_post(calls)):
                    code, out, err = self._run_main(module, script_path, argv)
                self.assertNotIn(
                    "invalid choice", err,
                    f"[{client_name}] gate-respond must be a registered "
                    f"subcommand: {err!r}")
                payload = self._last_gate_payload(calls)
                self._assert_steps_carry_the_snapshots_findings(
                    payload, client_name, "gate-respond")


if __name__ == "__main__":
    unittest.main()
