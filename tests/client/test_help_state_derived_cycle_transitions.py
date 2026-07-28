"""CR-CRU-048 C2 RED -- §S1 state-derived `help[]` after `cycle-done` /
`cycle-activate`, asserted fleet-wide (§S3) across all five clients.

Defect (docs/changes/CR-CRU-048-state-derived-help-and-close-guard.md §S1,
Defect 1): `_cycle_transition` in EVERY client (`bun-crucible.py`,
`python-crucible.py`, `rust-crucible.py`, `mvn-crucible.py`,
`arduino-crucible.py` -- confirmed by reading all five directly; each one
carries its OWN copy of the identical hardcoded ternary, there is no shared
implementation in `_crucible_axi.py` for this) builds its `help[]`
next-step hint as:

    help_steps = (["cycle-done <id>", "status"] if status == "active"
                  else ["cr-close --commit <sha>", "status"])

So after `cycle-done` the hint ALWAYS says `cr-close --commit <sha>`, even
when the owning plan (`target`, already fetched via `_open_plans` -- no new
fetch needed) has further PENDING cycles. This is what walked the
orchestrator toward closing CR-CRU-042 with its VERIFY cycle unrun (see the
CR's Context section for the live incident).

Scope: §S1 (derive the hint from `target["cycles"]`) + §S3 (fleet-wide,
asserted PER CLIENT -- a fix in `bun-crucible.py` alone is not the
contract). §S2 (the server-side close-guard message) is OUT of scope here.

Three behaviours pinned, each run against all five clients:
  1. `cycle-done` on a plan with a later PENDING cycle -> help[] names
     `cycle-activate <that cycle's CONCRETE id>` (the plan already tells us
     which cycle is next -- no placeholder needed) and must NOT offer
     `cr-close`.
  2. `cycle-done` closing the LAST cycle of a MULTI-cycle plan (the other
     cycle already `done`) -> help[] names `cr-close --commit <sha>` and
     must NOT offer `cycle-activate`. Paired with (1), this proves the hint
     is genuinely conditional, not merely reworded (CR AC, verbatim).
  3. `cycle-activate` is UNCHANGED -- help[] keeps naming the literal
     `cycle-done <id>` placeholder template. This is a PIN: GREEN must not
     regress it while rewriting `cycle-done`'s ternary.

Seam chosen: drive each client's REAL `main()` argparse dispatch (the actual
`cmd_cycle_done` / `cmd_cycle_activate` -> `_cycle_transition` path),
mocking only the HTTP transport seam (`_get`/`_patch`) -- the same
module-loading + mocking convention as every sibling
`test_<client>_crucible_axi.py` file. This is the honest per-client seam:
each client carries its OWN copy of `_cycle_transition` today (verified by
grep across `clients/*.py` -- no shared helper exists for this logic), so
mocking one function would not prove the fleet-wide contract. A shared
test-method MIXIN (one body, subclassed once per client with only
SCRIPT_PATH/MODULE_NAME/SCRIPT_FILENAME differing) avoids five hand-copied
test bodies while still exercising each client's real code path
independently -- if GREEN's fix lands in only one client's copy, that
client's subclass goes green while the other four stay RED.

RED phase: every client's `_cycle_transition` today returns the STATIC
ternary regardless of `target["cycles"]` contents, so scenario (1) fails
its exact-help-list assertion on all five clients (the fleet-wide §S3 AC is
unmet until every client is fixed). Scenarios (2) and (3) may already PASS
today -- the static ternary happens to agree with the correct answer in the
last-cycle and cycle-activate cases -- kept as pins so GREEN cannot regress
them while rewriting the ternary.

Invocation:
    python3 -m pytest tests/client/test_help_state_derived_cycle_transitions.py -q
Fallback:
    python3 tests/client/test_help_state_derived_cycle_transitions.py
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


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, script_filename, argv):
    """Invoke module.main() with sys.argv patched. Returns (code, stdout,
    stderr). Only SystemExit is caught -- any OTHER exception propagates so
    unittest reports it as an ERROR (still a valid RED signal)."""
    full_argv = [script_filename] + argv
    stdout, stderr = io.StringIO(), io.StringIO()
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


def _open_plans_response(plans):
    return {"ok": True, "plans": plans}


class _StateDerivedHelpBehaviorMixin:
    """Shared test bodies for CR-CRU-048 §S1/§S3. Concrete subclasses below
    set SCRIPT_PATH / MODULE_NAME / SCRIPT_FILENAME only -- NOT a
    unittest.TestCase itself, so it is never collected standalone."""

    SCRIPT_PATH = None
    MODULE_NAME = None
    SCRIPT_FILENAME = None
    PROJECT_KEY = "test-key-help-state-derived"
    # Only arduino-crucible.py requires CRUCIBLE_PROJECT_NAME in `.env` (it
    # exits before reaching cycle-transition logic without it -- confirmed by
    # running it directly). Written unconditionally; harmless for the other
    # four clients, which ignore the key.
    PROJECT_NAME = "fixture-help-state-derived"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        if not self.SCRIPT_PATH.exists():
            raise unittest.SkipTest(f"{self.SCRIPT_PATH} not found")
        self.module = _load_module(self.SCRIPT_PATH, self.MODULE_NAME)
        self.toon = _load_module(CLIENTS_DIR / "toon.py", f"{self.MODULE_NAME}_toon")
        self.tmpdir = tempfile.mkdtemp(prefix="help-state-derived-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
            f.write(f"CRUCIBLE_PROJECT_NAME={self.PROJECT_NAME}\n")
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

    def _decode_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON envelope with a top-level "
                      f"'axi' key; got stdout={stdout_text!r}")
        return decoded["axi"]

    def _run(self, argv, get_return=None, patch_return=None):
        patch_return = patch_return if patch_return is not None else {"ok": True}
        with mock.patch.object(self.module, "_get", return_value=get_return,
                                create=True) as get_mock, \
             mock.patch.object(self.module, "_patch", return_value=patch_return,
                                create=True) as patch_mock:
            code, out, err = _run_main(self.module, self.SCRIPT_FILENAME, argv)
        return code, out, err, get_mock, patch_mock

    # -- Scenario 1: cycle-done, a later cycle is still pending -------------

    def test_cycle_done_with_later_pending_cycle_offers_cycle_activate_not_cr_close(self):
        plans = _open_plans_response([
            {"planId": "plan-open-1", "cr": "CR-STATE-1", "status": "open",
             "cycles": [
                 {"id": 210, "label": "C1 impl", "kind": "red-green", "status": "active"},
                 {"id": 211, "label": "C2 VERIFY", "kind": "verify", "status": "pending"},
             ]},
        ])
        code, out, err, _get_mock, patch_mock = self._run(
            ["cycle-done", "210", "--project-dir", self.tmpdir],
            get_return=plans,
        )
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        patch_mock.assert_called_once()
        patch_path, patch_payload = patch_mock.call_args[0]
        self.assertTrue(patch_path.endswith("/plans/plan-open-1/cycles/210"),
                         f"PATCH must target the resolved plan's cycle route; got {patch_path!r}")
        self.assertEqual(patch_payload, {"status": "done"})

        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-done")
        self.assertIs(axi.get("ok"), True)
        help_list = axi.get("help") or []
        self.assertEqual(
            help_list, ["cycle-activate 211", "status"],
            f"§S1: cycle-done with a later PENDING cycle (211) must name "
            f"`cycle-activate 211`, not the static `cr-close` hint; "
            f"got help={help_list!r}"
        )
        self.assertNotIn(
            "cr-close --commit <sha>", help_list,
            f"§S1: a plan with a pending cycle remaining must NOT offer "
            f"cr-close; got help={help_list!r}"
        )

    # -- Scenario 2: cycle-done closes the LAST cycle of a multi-cycle plan -

    def test_cycle_done_closing_last_cycle_of_multi_cycle_plan_offers_cr_close(self):
        plans = _open_plans_response([
            {"planId": "plan-open-2", "cr": "CR-STATE-2", "status": "open",
             "cycles": [
                 {"id": 220, "label": "C1 impl", "kind": "red-green", "status": "done"},
                 {"id": 221, "label": "C2 VERIFY", "kind": "verify", "status": "active"},
             ]},
        ])
        code, out, err, _get_mock, patch_mock = self._run(
            ["cycle-done", "221", "--project-dir", self.tmpdir],
            get_return=plans,
        )
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")
        patch_mock.assert_called_once()
        patch_path, patch_payload = patch_mock.call_args[0]
        self.assertTrue(patch_path.endswith("/plans/plan-open-2/cycles/221"),
                         f"PATCH must target the resolved plan's cycle route; got {patch_path!r}")
        self.assertEqual(patch_payload, {"status": "done"})

        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-done")
        self.assertIs(axi.get("ok"), True)
        help_list = axi.get("help") or []
        self.assertEqual(
            help_list, ["cr-close --commit <sha>", "status"],
            f"§S1: cycle-done closing the LAST cycle (no cycle remains "
            f"pending/active) must name `cr-close --commit <sha>`; "
            f"got help={help_list!r}. (May already pass today -- the static "
            f"ternary happens to agree in this case; kept as a pin.)"
        )
        self.assertFalse(
            any(h.startswith("cycle-activate") for h in help_list),
            f"§S1: with no pending cycle left, help[] must NOT offer "
            f"cycle-activate; got help={help_list!r}"
        )

    # -- Scenario 3 (pin): cycle-activate unchanged --------------------------

    def test_cycle_activate_still_offers_cycle_done_placeholder_template(self):
        plans = _open_plans_response([
            {"planId": "plan-open-3", "cr": "CR-STATE-3", "status": "open",
             "cycles": [
                 {"id": 230, "label": "C1 impl", "kind": "red-green", "status": "pending"},
             ]},
        ])
        code, out, err, _get_mock, _patch_mock = self._run(
            ["cycle-activate", "230", "--project-dir", self.tmpdir],
            get_return=plans,
        )
        self.assertEqual(code, 0, f"stdout={out!r} stderr={err!r}")

        axi = self._decode_axi(out)
        self.assertEqual(axi.get("verb"), "cycle-activate")
        self.assertIs(axi.get("ok"), True)
        help_list = axi.get("help") or []
        self.assertEqual(
            help_list, ["cycle-done <id>", "status"],
            f"§S1 PIN: cycle-activate's help[] must remain the literal "
            f"`cycle-done <id>` placeholder template -- unchanged behaviour "
            f"GREEN must not regress while rewriting cycle-done's ternary; "
            f"got help={help_list!r}"
        )


# ── Concrete per-client subclasses (§S3 -- asserted per client) ─────────────


class BunCrucibleStateDerivedHelpTest(_StateDerivedHelpBehaviorMixin, unittest.TestCase):
    SCRIPT_PATH = CLIENTS_DIR / "bun-crucible.py"
    MODULE_NAME = "bun_crucible_under_test_help_state"
    SCRIPT_FILENAME = "bun-crucible.py"


class PythonCrucibleStateDerivedHelpTest(_StateDerivedHelpBehaviorMixin, unittest.TestCase):
    SCRIPT_PATH = CLIENTS_DIR / "python-crucible.py"
    MODULE_NAME = "python_crucible_under_test_help_state"
    SCRIPT_FILENAME = "python-crucible.py"


class RustCrucibleStateDerivedHelpTest(_StateDerivedHelpBehaviorMixin, unittest.TestCase):
    SCRIPT_PATH = CLIENTS_DIR / "rust-crucible.py"
    MODULE_NAME = "rust_crucible_under_test_help_state"
    SCRIPT_FILENAME = "rust-crucible.py"


class MvnCrucibleStateDerivedHelpTest(_StateDerivedHelpBehaviorMixin, unittest.TestCase):
    SCRIPT_PATH = CLIENTS_DIR / "mvn-crucible.py"
    MODULE_NAME = "mvn_crucible_under_test_help_state"
    SCRIPT_FILENAME = "mvn-crucible.py"


class ArduinoCrucibleStateDerivedHelpTest(_StateDerivedHelpBehaviorMixin, unittest.TestCase):
    SCRIPT_PATH = CLIENTS_DIR / "arduino-crucible.py"
    MODULE_NAME = "arduino_crucible_under_test_help_state"
    SCRIPT_FILENAME = "arduino-crucible.py"


if __name__ == "__main__":
    unittest.main()
