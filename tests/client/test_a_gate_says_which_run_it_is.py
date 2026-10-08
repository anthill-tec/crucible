"""CR-CRU-172 §S0, AC1 — the shared builder `gate_from_axi`
(`clients/_crucible_axi.py`) stamps every gate it builds with the run that
produced it.

Ground truth, measured directly from `gate_from_axi` before this slice: it
reads `run = decoded.get("run") or {}` ONLY to read `run.get("steps")` and
`run.get("head")` (for the sealing `push.commit`); it never reads `run.id` or
`run.branch`, and it never writes a `run` key onto the gate object it
returns (confirmed by reading the function directly — the returned dict has
only `intent`, `outcome`, `steps`, `inFlight` and `push`). So on the real
board no gate names the run that produced it, no recorded decision can ever
be joined to the gate it answers, and F21's `run <id> · branch <b> · head
<h>` line has no data to read (CR-CRU-172 Gap analysis, DRIFT-1).

What this file pins, directly against `gate_from_axi` — no subprocess, no
client, no board:

  * an interim gate (`final=False`) and a sealing gate (`final=True`) BOTH
    carry `gate.run` — the snapshot's own `run.id`, `run.branch`, `run.head`,
    taken verbatim and never invented;
  * a snapshot whose `run` names only an id posts a gate whose `run` object
    carries ONLY that id — `branch`/`head` are OMITTED, never emitted as an
    invented value or an explicit null;
  * a gate's `run` key tracks whether the SNAPSHOT named one: present (with
    whatever subset of id/branch/head the snapshot gave) when it did, absent
    entirely when the decoded snapshot carries no `run` object at all. Both
    halves live in ONE test so neither can pass by a stub that always omits
    `run` (today's behaviour) or one that always invents it.

RED phase: every assertion that `gate.get("run")` holds data fails today,
because `gate_from_axi` never writes that key under any input — a real
behavioural failure, not a missing-symbol accident.

Invocation:
    python3 -m pytest tests/client/test_a_gate_says_which_run_it_is.py -q
Fallback:
    python3 tests/client/test_a_gate_says_which_run_it_is.py
"""

import importlib.util
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AXI_MODULE_PATH = REPO_ROOT / "clients" / "_crucible_axi.py"

INTENT = "pin the run identity on every gate"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_AXI = _load_module(AXI_MODULE_PATH, "axi_under_test_for_gate_run_identity")


def _decoded_with_run(run_fields, steps, outcome=None):
    run = dict(run_fields)
    run["steps"] = steps
    decoded = {"run": run}
    if outcome is not None:
        decoded["outcome"] = outcome
    return decoded


class AnInterimGateCarriesTheRunsIdentityTest(unittest.TestCase):
    """§S0 — the in-flight half: `final=False`."""

    def test_an_interim_gate_carries_the_snapshots_run_id_branch_and_head(self):
        decoded = _decoded_with_run(
            {"id": "run-ident-1", "branch": "feature/run-ident", "head": "feed001"},
            [{"step": "intent", "status": "completed", "findings": 0},
             {"step": "review", "status": "running", "findings": 0}],
        )
        gate, step_count = _AXI.gate_from_axi(decoded, INTENT, final=False)

        self.assertEqual(
            gate.get("run"), {"id": "run-ident-1", "branch": "feature/run-ident",
                              "head": "feed001"},
            "an interim gate must carry gate.run with the snapshot's own "
            "run.id, run.branch and run.head, verbatim: so CR-CRU-172's F21 "
            "run line and the server's runId lift have data to read even "
            "while the run is still going; got gate=" + repr(gate))
        self.assertEqual(
            step_count, 2,
            "the step ladder gate_from_axi already built must be unaffected "
            "by adding the run identity; got " + repr(gate.get("steps")))


class ASealingGateCarriesTheRunsIdentityTest(unittest.TestCase):
    """§S0 — the sealing half: `final=True`."""

    def test_a_sealing_gate_carries_the_snapshots_run_id_branch_and_head(self):
        decoded = _decoded_with_run(
            {"id": "run-ident-2", "branch": "feature/run-ident-seal", "head": "sea1ed2"},
            [{"step": "intent", "status": "completed", "findings": 0}],
            outcome="passed",
        )
        gate, _ = _AXI.gate_from_axi(decoded, INTENT, final=True)

        self.assertEqual(
            gate.get("run"), {"id": "run-ident-2", "branch": "feature/run-ident-seal",
                              "head": "sea1ed2"},
            "a sealing gate must ALSO carry gate.run with the snapshot's own "
            "run.id, run.branch and run.head — a recorded decision for the "
            "run only JOINS its gate if the seal names the run it sealed; "
            "got gate=" + repr(gate))
        self.assertEqual(
            gate.get("push"), {"commit": "sea1ed2"},
            "pre-existing behaviour must be undisturbed: a seal with a head "
            "still carries gate.push.commit beside the new gate.run; got "
            + repr(gate))


class ARunMissingBranchAndHeadOmitsThoseKeysTest(unittest.TestCase):
    """§S0 — 'each key omitted when the snapshot lacks it, never invented'."""

    def test_a_run_naming_only_an_id_posts_a_gate_run_with_only_that_id(self):
        decoded = _decoded_with_run(
            {"id": "run-ident-3"},
            [{"step": "intent", "status": "completed", "findings": 0}],
        )
        gate, _ = _AXI.gate_from_axi(decoded, INTENT, final=False)

        self.assertEqual(
            gate.get("run"), {"id": "run-ident-3"},
            "a snapshot naming only run.id must post a gate.run carrying "
            "ONLY that id — branch and head must be OMITTED KEYS, not "
            "invented empty strings and not explicit nulls; got gate.run="
            + repr(gate.get("run")))
        self.assertNotIn(
            "branch", gate.get("run", {}),
            "branch must be an OMITTED key, never present with a made-up "
            "value; got gate.run=" + repr(gate.get("run")))
        self.assertNotIn(
            "head", gate.get("run", {}),
            "head must be an OMITTED key, never present with a made-up "
            "value; got gate.run=" + repr(gate.get("run")))
        self.assertNotIn(
            None, gate.get("run", {}).values(),
            "never an explicit null in place of an omitted key; got "
            "gate.run=" + repr(gate.get("run")))


class TheRunKeyTracksWhetherTheSnapshotNamedOneTest(unittest.TestCase):
    """§S0 — 'a snapshot with no run at all gives a gate with no run key'.

    Both halves live in ONE test: a stub that always omits `run` (today's
    real behaviour) fails the first assertion below, and a stub that always
    INVENTS a `run` object fails the second — so neither shape of a
    not-yet-built feature can pass this test."""

    def test_run_key_presence_on_the_gate_tracks_whether_the_snapshot_named_a_run(self):
        named = _decoded_with_run(
            {"id": "run-ident-4", "branch": "feature/run-ident-4", "head": "ab1200f"},
            [{"step": "intent", "status": "completed", "findings": 0}],
        )
        gate_named, _ = _AXI.gate_from_axi(named, INTENT, final=False)
        self.assertEqual(
            gate_named.get("run"),
            {"id": "run-ident-4", "branch": "feature/run-ident-4", "head": "ab1200f"},
            "premise for the contrast below: a snapshot that DOES name a run "
            "must produce a gate carrying it; got " + repr(gate_named))

        unnamed = {"outcome": "passed"}
        gate_unnamed, _ = _AXI.gate_from_axi(unnamed, INTENT, final=True)
        self.assertNotIn(
            "run", gate_unnamed,
            "a decoded snapshot with NO `run` object at all must post a gate "
            "with NO `run` key — never an empty dict, never invented data; "
            "got gate=" + repr(gate_unnamed))


if __name__ == "__main__":
    unittest.main()
