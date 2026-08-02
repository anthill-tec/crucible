"""CR-CRU-058 C2 -- RED contracts for the two SHARED-MODULE envelope gaps the
§S0 census found, where a single fix in `clients/_crucible_axi.py` reaches all
five clients at once (the CR-054 consolidation dividend, per the CR's §S0b):

  1. `milestone` never calls any emitter (`cmd_milestone` in `_crucible_axi.py`
     ends in a bare `print(..., file=sys.stderr)`, confirmed by reading its
     body) -- driving `milestone` on every client today produces NOTHING
     decodable on stdout, so `classify_envelope` reads False for all five.
     This file pins the CORRECT target behaviour: a decodable `axi:` envelope
     with `verb: "milestone"`, an `ok` field, a non-empty `help[]`, and a
     `context` -- one test per client (5).

  2. `open_plans()` (used by `cycle-activate` / `cycle-done` / `cr-close`)
     does a bare `sys.exit(...)` when the `/plans` GET fails, while its
     sibling `resolve_plan_or_emit()` (used by `cycle-add` / `checkpoint` /
     `abort`) correctly emits an ok:false envelope on the IDENTICAL failure
     (both read directly in `_crucible_axi.py`: `open_plans` at line ~277,
     `resolve_plan_or_emit` at line ~290). This file pins the CORRECT target
     behaviour for the bare trio -- a structured ok:false envelope naming the
     fetch failure, with a non-empty `help[]` -- one test per (client, verb)
     pair (5 clients x 3 verbs = 15), AND pins the siblings' EXISTING correct
     behaviour under the identical failure as a regression guard (5 clients x
     3 verbs = 15 more), so a fix that touches the shared helper cannot
     accidentally regress cycle-add/checkpoint/abort to the bare path while
     fixing cycle-activate/cycle-done/cr-close.

Every test here DRIVES the real CLI as a subprocess against an unreachable
`CRUCIBLE_URL` (nothing listens on `http://127.0.0.1:1`) -- never a static
grep, never an in-process mock of the emitter. This is Mode 1 (new failing
contracts): the milestone and bare-trio tests below MUST fail today, because
the shared implementation genuinely has no emitter call on those paths.

Reuses `test_client_fleet_envelope_census.py`'s own driving machinery
verbatim (per the dispatch brief: "import or mirror them rather than
reinventing") -- `enumerate_verbs`, `build_argv`, `drive_verb`,
`classify_envelope`, `_make_project_dir`, `_build_fake_bin_dir`,
`_load_toon_module`, `CLIENT_FILES`, `_UNREACHABLE_CRUCIBLE_URL` are all
imported from that module, not reimplemented."""

import shutil
import unittest

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
    enumerate_verbs,
)


def _drive_one(client_key, verb_name):
    """Enumerate `client_key`'s real argparse, build the closest-to-normal
    argv for `verb_name` (every REQUIRED option filled, `--agent` always
    supplied), and drive it as a genuine subprocess against the unreachable
    `CRUCIBLE_URL` -- exactly the detector's own per-verb drive, reused here
    for a single named verb instead of the full fleet sweep. Returns the
    `(emits, axi)` tuple `classify_envelope` produces."""
    fake_bin_dir = _build_fake_bin_dir()
    try:
        toon_module = _load_toon_module()
        project_dir = _make_project_dir(client_key)
        try:
            script_path = CLIENT_FILES[client_key]
            verbs = enumerate_verbs(client_key, script_path)
            assert verb_name in verbs, (
                f"{client_key}: verb {verb_name!r} not found in its real "
                f"argparse -- {sorted(verbs)!r}")
            argv = build_argv(verb_name, verbs[verb_name], project_dir)
            result = drive_verb(script_path, argv, project_dir, fake_bin_dir)
            return classify_envelope(result.stdout, toon_module) + (result,)
        finally:
            shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)


class MilestoneEmitsEnvelopeAcrossFleetTest(unittest.TestCase):
    """§S0b: "`milestone` never calls any emitter ... one fix now covers all
    five clients". `cmd_milestone` (read directly in `_crucible_axi.py`) ends
    in `print(f"milestone: ok={ok} ...", file=sys.stderr)` and returns a bare
    int -- no `_emit_axi`/`ops.emit` call on ANY outcome. Today, driving
    `milestone` puts NOTHING on stdout, so `classify_envelope` reads False;
    these five tests pin the envelope `milestone` must carry once the shared
    fix lands: decodable, `verb=="milestone"`, an `ok` field, non-empty
    `help[]`, and a `context`."""

    def _assert_milestone_envelope(self, client_key):
        emits, axi, result = _drive_one(client_key, "milestone")
        self.assertTrue(
            emits,
            f"{client_key}: milestone must produce a decodable axi: "
            f"envelope on stdout; got stdout={result.stdout!r} "
            f"stderr={result.stderr!r}")
        self.assertEqual(axi.get("verb"), "milestone",
                         f"{client_key}: envelope verb must be 'milestone'")
        self.assertIn("ok", axi,
                      f"{client_key}: envelope must carry an 'ok' field")
        self.assertTrue(
            axi.get("help"),
            f"{client_key}: envelope must carry a non-empty help[] "
            f"next-step hint, got {axi.get('help')!r}")
        self.assertIsNotNone(
            axi.get("context"),
            f"{client_key}: envelope must carry a context block")

    def test_milestone_emits_envelope_in_rust(self):
        self._assert_milestone_envelope("rust")

    def test_milestone_emits_envelope_in_mvn(self):
        self._assert_milestone_envelope("mvn")

    def test_milestone_emits_envelope_in_bun(self):
        self._assert_milestone_envelope("bun")

    def test_milestone_emits_envelope_in_python(self):
        self._assert_milestone_envelope("python")

    def test_milestone_emits_envelope_in_arduino(self):
        self._assert_milestone_envelope("arduino")


class OpenPlansBareTrioCorrectBehaviourTest(unittest.TestCase):
    """§S0b's "sibling asymmetry": `cycle-activate` / `cycle-done` (via the
    shared `cycle_transition`) and `cr-close` (via `cmd_cr_close`) call
    `ops.open_plans(project_dir)`, which delegates to `_crucible_axi.
    open_plans` -- confirmed by reading it: `sys.exit(f"[crucible] ERROR: "
    f"could not list plans: {{...}}")` on a GET failure, a bare process exit
    with NOTHING on stdout. Under this file's unreachable `CRUCIBLE_URL` that
    GET always fails, so today all three read as envelope-less.

    Pins the CORRECT target behaviour: an `ok:false` envelope naming the
    fetch failure, with a non-empty `help[]` giving a concrete next action --
    one test per (client, verb), 5 clients x 3 verbs = 15."""

    _AFFECTED_VERBS = ("cycle-activate", "cycle-done", "cr-close")

    def _assert_emits_ok_false_naming_fetch_failure(self, client_key, verb_name):
        emits, axi, result = _drive_one(client_key, verb_name)
        self.assertTrue(
            emits,
            f"{client_key}/{verb_name}: must produce a decodable axi: "
            f"envelope on stdout when the plans GET fails, instead of a bare "
            f"sys.exit with nothing on stdout; got stdout={result.stdout!r} "
            f"stderr={result.stderr!r}")
        self.assertEqual(
            axi.get("verb"), verb_name,
            f"{client_key}/{verb_name}: envelope verb must match the "
            f"invoked verb")
        self.assertEqual(
            axi.get("ok"), False,
            f"{client_key}/{verb_name}: envelope must report ok:false -- "
            f"the plans GET genuinely failed")
        self.assertTrue(
            axi.get("help"),
            f"{client_key}/{verb_name}: envelope must carry a non-empty "
            f"help[] naming a concrete next action, got {axi.get('help')!r}")

    # -- cycle-activate --------------------------------------------------
    def test_cycle_activate_emits_ok_false_on_plans_fetch_failure_in_rust(self):
        self._assert_emits_ok_false_naming_fetch_failure("rust", "cycle-activate")

    def test_cycle_activate_emits_ok_false_on_plans_fetch_failure_in_mvn(self):
        self._assert_emits_ok_false_naming_fetch_failure("mvn", "cycle-activate")

    def test_cycle_activate_emits_ok_false_on_plans_fetch_failure_in_bun(self):
        self._assert_emits_ok_false_naming_fetch_failure("bun", "cycle-activate")

    def test_cycle_activate_emits_ok_false_on_plans_fetch_failure_in_python(self):
        self._assert_emits_ok_false_naming_fetch_failure("python", "cycle-activate")

    def test_cycle_activate_emits_ok_false_on_plans_fetch_failure_in_arduino(self):
        self._assert_emits_ok_false_naming_fetch_failure("arduino", "cycle-activate")

    # -- cycle-done --------------------------------------------------------
    def test_cycle_done_emits_ok_false_on_plans_fetch_failure_in_rust(self):
        self._assert_emits_ok_false_naming_fetch_failure("rust", "cycle-done")

    def test_cycle_done_emits_ok_false_on_plans_fetch_failure_in_mvn(self):
        self._assert_emits_ok_false_naming_fetch_failure("mvn", "cycle-done")

    def test_cycle_done_emits_ok_false_on_plans_fetch_failure_in_bun(self):
        self._assert_emits_ok_false_naming_fetch_failure("bun", "cycle-done")

    def test_cycle_done_emits_ok_false_on_plans_fetch_failure_in_python(self):
        self._assert_emits_ok_false_naming_fetch_failure("python", "cycle-done")

    def test_cycle_done_emits_ok_false_on_plans_fetch_failure_in_arduino(self):
        self._assert_emits_ok_false_naming_fetch_failure("arduino", "cycle-done")

    # -- cr-close ------------------------------------------------------------
    def test_cr_close_emits_ok_false_on_plans_fetch_failure_in_rust(self):
        self._assert_emits_ok_false_naming_fetch_failure("rust", "cr-close")

    def test_cr_close_emits_ok_false_on_plans_fetch_failure_in_mvn(self):
        self._assert_emits_ok_false_naming_fetch_failure("mvn", "cr-close")

    def test_cr_close_emits_ok_false_on_plans_fetch_failure_in_bun(self):
        self._assert_emits_ok_false_naming_fetch_failure("bun", "cr-close")

    def test_cr_close_emits_ok_false_on_plans_fetch_failure_in_python(self):
        self._assert_emits_ok_false_naming_fetch_failure("python", "cr-close")

    def test_cr_close_emits_ok_false_on_plans_fetch_failure_in_arduino(self):
        self._assert_emits_ok_false_naming_fetch_failure("arduino", "cr-close")


class ResolvePlanOrEmitSiblingsRegressionGuardTest(unittest.TestCase):
    """Regression guard (dispatch brief: "pin the siblings' existing correct
    behaviour ... so a fix cannot accidentally regress them"). `cycle-add` /
    `checkpoint` / `abort` go through `ops.resolve_plan`, a thin delegator to
    `_crucible_axi.resolve_plan_or_emit` (confirmed by reading
    `clients/rust-crucible.py:1563` and its `_axi().resolve_plan_or_emit(...)`
    call, the same shape in all five clients) -- which ALREADY emits an
    ok:false envelope naming the fetch failure on the identical plans-GET
    failure this file drives against. These 15 tests (5 clients x 3 verbs)
    are expected to PASS today (the siblings are not broken); their job is to
    fail loudly if a §S1 fix to `open_plans` ever regresses this already-
    correct sibling path -- the exact drift class CR-CRU-054 existed to end."""

    _SIBLING_VERBS = ("cycle-add", "checkpoint", "abort")

    def _assert_sibling_already_emits_ok_false(self, client_key, verb_name):
        emits, axi, result = _drive_one(client_key, verb_name)
        self.assertTrue(
            emits,
            f"{client_key}/{verb_name}: regression -- this sibling verb "
            f"must ALREADY emit a decodable axi: envelope on a plans-GET "
            f"failure via resolve_plan_or_emit; got "
            f"stdout={result.stdout!r} stderr={result.stderr!r}")
        self.assertEqual(
            axi.get("verb"), verb_name,
            f"{client_key}/{verb_name}: regression -- envelope verb must "
            f"match the invoked verb")
        self.assertEqual(
            axi.get("ok"), False,
            f"{client_key}/{verb_name}: regression -- envelope must report "
            f"ok:false on the failed plans GET")
        self.assertTrue(
            axi.get("help"),
            f"{client_key}/{verb_name}: regression -- envelope must still "
            f"carry a non-empty help[], got {axi.get('help')!r}")

    # -- cycle-add -------------------------------------------------------
    def test_cycle_add_still_emits_ok_false_on_plans_fetch_failure_in_rust(self):
        self._assert_sibling_already_emits_ok_false("rust", "cycle-add")

    def test_cycle_add_still_emits_ok_false_on_plans_fetch_failure_in_mvn(self):
        self._assert_sibling_already_emits_ok_false("mvn", "cycle-add")

    def test_cycle_add_still_emits_ok_false_on_plans_fetch_failure_in_bun(self):
        self._assert_sibling_already_emits_ok_false("bun", "cycle-add")

    def test_cycle_add_still_emits_ok_false_on_plans_fetch_failure_in_python(self):
        self._assert_sibling_already_emits_ok_false("python", "cycle-add")

    def test_cycle_add_still_emits_ok_false_on_plans_fetch_failure_in_arduino(self):
        self._assert_sibling_already_emits_ok_false("arduino", "cycle-add")

    # -- checkpoint ------------------------------------------------------
    def test_checkpoint_still_emits_ok_false_on_plans_fetch_failure_in_rust(self):
        self._assert_sibling_already_emits_ok_false("rust", "checkpoint")

    def test_checkpoint_still_emits_ok_false_on_plans_fetch_failure_in_mvn(self):
        self._assert_sibling_already_emits_ok_false("mvn", "checkpoint")

    def test_checkpoint_still_emits_ok_false_on_plans_fetch_failure_in_bun(self):
        self._assert_sibling_already_emits_ok_false("bun", "checkpoint")

    def test_checkpoint_still_emits_ok_false_on_plans_fetch_failure_in_python(self):
        self._assert_sibling_already_emits_ok_false("python", "checkpoint")

    def test_checkpoint_still_emits_ok_false_on_plans_fetch_failure_in_arduino(self):
        self._assert_sibling_already_emits_ok_false("arduino", "checkpoint")

    # -- abort -------------------------------------------------------------
    def test_abort_still_emits_ok_false_on_plans_fetch_failure_in_rust(self):
        self._assert_sibling_already_emits_ok_false("rust", "abort")

    def test_abort_still_emits_ok_false_on_plans_fetch_failure_in_mvn(self):
        self._assert_sibling_already_emits_ok_false("mvn", "abort")

    def test_abort_still_emits_ok_false_on_plans_fetch_failure_in_bun(self):
        self._assert_sibling_already_emits_ok_false("bun", "abort")

    def test_abort_still_emits_ok_false_on_plans_fetch_failure_in_python(self):
        self._assert_sibling_already_emits_ok_false("python", "abort")

    def test_abort_still_emits_ok_false_on_plans_fetch_failure_in_arduino(self):
        self._assert_sibling_already_emits_ok_false("arduino", "abort")


if __name__ == "__main__":
    unittest.main()
