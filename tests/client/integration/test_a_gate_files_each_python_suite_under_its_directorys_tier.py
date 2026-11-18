"""A gate files each python suite it dispatches under the tier its start
directory names.

A project declares its python tiers by directory: `test:client-unit` runs
`python3 -m unittest discover -s tests/client/unit -t .` and
`test:client-integration` the same over `tests/client/integration`. One
`bun-crucible.py pre-merge-gate` invocation dispatches each of them to the
python client, and each dispatched run is filed under ITS tier: the board
receives two python runs, one opened with tier `unit` and holding the unit
probe's test, one opened with tier `integration` and holding the integration
probe's two tests. The gate's envelope carries one `suites[]` row per target,
each with the counts its own run produced.

TIER: `integration`. The drive is the real gate end to end: the adopted
multi-suite gate fixture (`test_gate_multi_suite_coverage.py`'s
`_GateFixtureCase`: a throwaway project, the real `bun-crucible.py
pre-merge-gate`, a fake bun on PATH) reporting to this test's own stub board
on an ephemeral 127.0.0.1 port; the python client runs in its own process.
No dev board, no operator file: the board is declared in the fixture
project's own `crucible.toml`.

Invocation:
    .venv/bin/python clients/python-crucible.py test --agent <id> \
        --tests tests.client.integration.test_a_gate_files_each_python_suite_under_its_directorys_tier
"""

import importlib.util
import json
import unittest
from pathlib import Path

# Imported so the suite's isolation in tests/client/__init__.py applies even when a run
# imports this module top-level (the gate's discovery without -t).
import tests.client  # noqa: F401

TESTS_CLIENT_DIR = Path(__file__).resolve().parents[1]
GATE_HARNESS_PATH = TESTS_CLIENT_DIR / "integration" / "test_gate_multi_suite_coverage.py"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The multi-suite gate harness, adopted whole. Only NON-test names are taken:
# importing one of its TestCases would run that suite a second time.
_GATE = _load_module(GATE_HARNESS_PATH, "python_tier_gate_dispatch_harness")
_text = _GATE._text

BUN_SUITE = _GATE.BUN_SUITE
UNIT_SUITE = "test:client-unit"
INTEGRATION_SUITE = "test:client-integration"
PYTHON_STACK = _GATE.PYTHON_STACK

# Each tier directory's probe module and the tests it holds. The two counts
# differ, so a count attributed to the wrong suite fails.
_UNIT_PROBE = '''import unittest


class UnitTierProbeTest(unittest.TestCase):

    def test_the_unit_tier_probe_passes(self):
        self.assertEqual(1 + 1, 2)
'''
_INTEGRATION_PROBE = '''import unittest


class IntegrationTierProbeTest(unittest.TestCase):

    def test_the_integration_tier_probe_passes(self):
        self.assertEqual(2 + 2, 4)

    def test_the_integration_tier_probe_passes_its_second_case(self):
        self.assertEqual(3 + 3, 6)
'''

# tier -> (target, start directory, probe file, probe source, its test names)
TIER_SUITES = {
    "unit": (UNIT_SUITE, "tests/client/unit", "test_unit_tier_probe.py",
             _UNIT_PROBE, {"test_the_unit_tier_probe_passes"}),
    "integration": (INTEGRATION_SUITE, "tests/client/integration",
                    "test_integration_tier_probe.py", _INTEGRATION_PROBE,
                    {"test_the_integration_tier_probe_passes",
                     "test_the_integration_tier_probe_passes_its_second_case"}),
}


def setUpModule():
    _GATE.setUpModule()


def tearDownModule():
    _GATE.tearDownModule()


class GateFilesEachPythonSuiteUnderItsDirectorysTierTest(_GATE._GateFixtureCase):
    """One gate over a project declaring `test:client-unit` and
    `test:client-integration` by directory: two python runs, filed `unit` and
    `integration`, each with its own `suites[]` row and counts."""

    def write_fixture_project(self):
        root = Path(self.tmpdir)
        _GATE.declare_board(root / "crucible.toml", self.board.url)

        bun_tests = root / "tests" / "unit"
        bun_tests.mkdir(parents=True, exist_ok=True)
        (bun_tests / "probe.test.ts").write_text(_GATE._BUN_PROBE_TEST_TS)

        scripts = {BUN_SUITE: "bun test tests/unit"}
        for target, start_dir, probe, source, _names in TIER_SUITES.values():
            directory = root / start_dir
            directory.mkdir(parents=True, exist_ok=True)
            (directory / probe).write_text(source)
            scripts[target] = f"python3 -m unittest discover -s {start_dir} -t ."

        (root / "package.json").write_text(json.dumps({
            "name": "gate-python-tier-probe",
            "private": True,
            "scripts": scripts,
        }, indent=2) + "\n")

    def _python_run_starts(self, drive):
        return [payload for path, payload in drive.calls
                if path == _GATE._MODALITY.RUN_START
                and payload.get("stack") == PYTHON_STACK]

    def _held_test_names(self, run_id):
        held = [json.loads(line) for line in
                self.board.held_stream(run_id).splitlines() if line.strip()]
        return {event.get("name") for event in held
                if event.get("event") == "test-end" and event.get("status") == "pass"}

    def test_one_gate_files_each_python_tier_suite_under_its_own_tier(self):
        drive = self.drive_gate()
        envelope = self.gate_envelope(drive)

        self.assertEqual(
            drive.code, 0,
            f"the gate over two passing python tier suites passes; "
            f"envelope={_text(envelope)} stderr={drive.err[-3000:]!r}")

        # One suites[] row per declared python target, with its own counts.
        rows = {row.get("suite"): row for row in envelope.get("suites") or []
                if isinstance(row, dict)}
        for _tier, (target, _start, _probe, _source, names) in TIER_SUITES.items():
            with self.subTest(suite=target):
                self.assertIn(
                    target, rows,
                    f"the gate's suites[] names `{target}`; "
                    f"suites={_text(envelope.get('suites'))}")
                row = rows.get(target) or {}
                self.assertEqual(
                    (row.get("stack"), int(str(row.get("passed"))),
                     int(str(row.get("failed", 0)))),
                    (PYTHON_STACK, len(names), 0),
                    f"`{target}` is a python suite carrying the counts its own "
                    f"run produced; row={_text(row)}")

        # The board receives exactly two python runs, one per tier.
        starts = self._python_run_starts(drive)
        self.assertEqual(
            sorted(start.get("tier") for start in starts),
            sorted(TIER_SUITES),
            f"the board receives two python runs, opened under tier `unit` and "
            f"tier `integration`; python run starts={_text(starts)}")

        # Each tier's run holds that tier directory's tests and no other's.
        # The stub board answers the python starts with `run-stub-1`, `-2`, ...
        # in the order they arrive.
        filed = {start.get("tier"): self._held_test_names(f"run-stub-{index}")
                 for index, start in enumerate(starts, start=1)}
        self.assertEqual(
            filed,
            {tier: names for tier, (_t, _s, _p, _src, names) in TIER_SUITES.items()},
            f"each tier's run holds its own directory's tests; "
            f"filed={filed!r} starts={_text(starts)}")


if __name__ == "__main__":
    unittest.main()
