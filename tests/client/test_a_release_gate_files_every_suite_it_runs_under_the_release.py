"""CR-CRU-164 §S1 (restored at C2 GREEN, 82245e8) — a release's gate is filed
under the release WHOLE, and every tier verb of every client can be filed
under one.

Two additions §S1 now names that the C2 RED files did not cover:

1. `--release` on rust's TIER verbs (the six registrar cells: `unit`,
   `module`, `integration`, `e2e`, `bdd`, `regression`) and on arduino's
   DECLARED-tier verbs (`module`, `integration`, `e2e`, `bdd` — its `unit` and
   `regression` are already covered by
   `test_verification_runs_declare_their_release.py`). Asserted on each verb's
   own `--help`, the same census idiom that file uses.

2. `pre-merge-gate --release X` passes the release on to EVERY suite it runs,
   the other stacks' declared suites included. bun is the one client whose
   gate DISPATCHES a declared suite to a sibling client (`run_gate_suites`'
   dispatch branch, through `_dispatch_gate_suite` → the shared
   `sibling_client_argv`); the other four pass `dispatch=None` because their
   declarations carry a NAME and no command, so they can name no other stack.
   The drive below is the REAL `bun-crucible.py pre-merge-gate` against a stub
   board, through CR-CRU-112's gate fixture (adopted whole and by name, the
   idiom `test_gate_suite_outcome_reporting.py` uses): a project declaring a
   bun suite and a python-owned suite. With `--release`, the dispatched
   python command must carry `--release <it>` and the python client's own run
   must reach the board under it; without `--release`, neither may.

Invocation:
    python3 -m unittest tests.client.test_a_release_gate_files_every_suite_it_runs_under_the_release -v
"""

import importlib.util
import re
import subprocess
import sys
import unittest
from pathlib import Path

TESTS_CLIENT_DIR = Path(__file__).resolve().parent
CLIENTS = TESTS_CLIENT_DIR.parents[1] / "clients"
GATE_HARNESS_PATH = TESTS_CLIENT_DIR / "test_gate_multi_suite_coverage.py"

RELEASE = "0.4.0"
RUN_START = "/api/v2/runs/start"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# CR-CRU-112's gate harness, adopted whole. Only NON-test names are taken:
# importing one of its TestCases would run that cycle's suite a second time.
_GATE = _load_module(GATE_HARNESS_PATH, "cr164_c2_gate_harness")
PYTHON_SUITE = _GATE.PYTHON_SUITE
TEST_INGEST_ENDPOINTS = _GATE.TEST_INGEST_ENDPOINTS


def setUpModule():
    _GATE.setUpModule()


def tearDownModule():
    _GATE.tearDownModule()


# ── 1. the added verbs document --release ───────────────────────────────────

ADDED_HELP_VERBS = (
    [("rust-crucible.py", v) for v in
     ("unit", "module", "integration", "e2e", "bdd", "regression")]
    + [("arduino-crucible.py", v) for v in
       ("module", "integration", "e2e", "bdd")]
)


class TierVerbsDeclareTheirReleaseTest(unittest.TestCase):
    """Every verb §S1 restored lists `--release` in its own `--help`."""

    def test_rust_tier_verbs_and_arduino_declared_tier_verbs_list_release(self):
        for client, verb in ADDED_HELP_VERBS:
            with self.subTest(client=client, verb=verb):
                result = subprocess.run(
                    [sys.executable, str(CLIENTS / client), verb, "--help"],
                    capture_output=True, text=True, timeout=20)
                self.assertEqual(
                    result.returncode, 0,
                    f"{client} {verb} --help must exit 0; "
                    f"stdout={result.stdout!r} stderr={result.stderr!r}")
                self.assertIn(
                    "--release", result.stdout,
                    f"{client} {verb} --help must list --release (§S1); "
                    f"got stdout={result.stdout!r}")


# ── 2. the gate passes the release to the suite it dispatches ──────────────

class GateReleaseReachesTheDispatchedSuiteTest(_GATE._GateFixtureCase):
    """`pre-merge-gate --release` → the dispatched python suite's command
    carries `--release <it>`, and that suite's run reaches the board under
    it; without `--release`, nothing carries one."""

    def dispatched_argv_line(self, drive):
        """The gate's own stderr line naming the command it dispatched the
        python-owned suite to (`run_gate_suites`' dispatch narration)."""
        pattern = re.compile(
            rf"dispatching `{re.escape(PYTHON_SUITE)}` to (?P<argv>[^\n]*)")
        match = pattern.search(drive.err)
        self.assertIsNotNone(
            match,
            f"the gate must dispatch `{PYTHON_SUITE}` to its sibling client; "
            f"exit={drive.code!r} stderr={drive.err[-3000:]!r}")
        return match.group("argv")

    def python_run_bodies(self, drive):
        """Every run-start and ingest body the dispatched python client sent."""
        return [payload for path, payload in drive.calls
                if (path == RUN_START and payload.get("stack") == "python")
                or (path in TEST_INGEST_ENDPOINTS
                    and "tests/client" in repr(payload.get("tree")))]

    def test_a_release_gate_dispatches_its_sibling_suite_under_the_release(self):
        drive = self.drive_gate(extra=["--release", RELEASE])
        argv = self.dispatched_argv_line(drive)
        self.assertRegex(
            argv, rf"(^|\s)--release {re.escape(RELEASE)}(\s|$)",
            f"the dispatched sibling command must carry `--release {RELEASE}`; "
            f"got {argv!r}")
        ingests = self.ingests(drive)
        self.assertGreaterEqual(
            len(ingests), 2,
            f"the gate's whole-suite run AND the dispatched suite must both "
            f"ingest; got {len(ingests)} ingest(s), stderr={drive.err[-3000:]!r}")
        for body in ingests:
            self.assertEqual(
                body.get("release"), RELEASE,
                f"every suite a release gate runs is filed under the release; "
                f"an ingest carried release={body.get('release')!r}: {body!r}")

    def test_a_gate_without_release_dispatches_no_release(self):
        drive = self.drive_gate()
        argv = self.dispatched_argv_line(drive)
        self.assertNotIn(
            "--release", argv,
            f"a gate given no --release must dispatch none; got {argv!r}")
        for path, body in drive.calls:
            self.assertNotIn(
                "release", body or {},
                f"no request may carry `release` when the gate was given none; "
                f"path={path!r} body={body!r}")


if __name__ == "__main__":
    unittest.main()
