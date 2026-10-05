"""CR-CRU-165 C2 -- `cycle-skip <cycleId> --reason --cause --spec-ref`, a NEW
verb in all five clients (AC2, AC5).

Server contract, read directly from the code this verb must drive (no server
is spawned here -- `_get`/`_patch` are mocked at the module seam, the fleet's
established harness idiom, exactly `test_bun_crucible_cycle_add.py`'s
`_post_recorder` style generalised across all five clients):

- `handleCycleTransition` (src/v2.ts) reads `{status: "skipped", reason,
  cause, specRef, agentId}` off `PATCH .../plans/<planId>/cycles/<cycleId>`;
  `requirePlanChange` -> `parseChangeRecord` is the gate (orchestrator caller,
  then a complete record) and `CHANGE_CAUSES` the two legal `cause` values
  (`spec-design` | `gap-analysis`).
- A guarded write's response carries `warnings: [PROCESS_FAILURE_WARNING]`
  (src/v2.ts) -- the one process-failure line every recorded plan change and
  every abort sends, quoted here VERBATIM so this suite proves the client
  RELAYS it rather than inventing its own wording.

RED, measured against the fleet today (2026-10-03): no client declares a
`cycle-skip` subcommand at all (`argparse` answers `invalid choice:
'cycle-skip'` and exits 2 -- the SAME "real RED, not a typo" shape
`test_bun_crucible_cycle_add.py` documented for `cycle-add` before CR-CRU-030
C1 landed it). Every assertion below states the CORRECT end state a GREEN
implementation must reach; today's failure is the verb's total absence, which
these mocks cannot paper over -- `_patch`/`_get` are never reached, so any
assertion that depends on them fails cleanly (through `_decode`'s own
"stdout must decode as a TOON-AXI envelope" gate when stdout is empty, never
a silent pass).

Harnesses reused, never re-invented: `_load_module_by_path`/`_run_main`/
`CLIENT_FILES`/`CLIENTS` from `test_plan_file_names_the_release_it_plans.py`
(CR-CRU-121 §S2's fleet-census idiom).

ESCALATION (recorded, not guessed):

  E1. The spec says `help[]` "says the verb is exceptional" without quoting
      exact wording. The server's own framing (`planChangeHints.
      notOrchestrator`, src/hints.ts) literally uses the word "exceptional",
      so `CycleSkipHelpMarksTheVerbExceptionalTest` checks for that substring
      (case-insensitive) in the success envelope's `help[]`, rather than a
      bare non-empty check -- the narrowest POSITIVE reading of the AC that
      does not invent a full sentence GREEN has not written yet.

Invocation:
    python3 -m unittest tests.client.test_cycle_skip_is_guarded_and_recorded
"""

import os
import shutil
import tempfile
import unittest
from unittest import mock

from tests.client.test_plan_file_names_the_release_it_plans import (
    CLIENT_FILES,
    CLIENTS,
    ENV_KEYS,
    _load_module_by_path,
    _run_main,
)

VERB = "cycle-skip"
REASON_FLAG = "--reason"
CAUSE_FLAG = "--cause"
SPEC_REF_FLAG = "--spec-ref"

# src/v2.ts PROCESS_FAILURE_WARNING -- the exact text every recorded plan
# change and every abort carries. The client must RELAY it verbatim (never
# reword it), so this is the fixture value `_patch`/`_post` mocks return AND
# the exact value asserted back out of the envelope.
PROCESS_FAILURE_WARNING = {
    "code": "process-failure",
    "message": (
        "this change to a filed plan records a process failure: a spec "
        "that changes mid-implementation shows that the spec's design or "
        "its gap analysis fell short — it is counted for the retrospective"
    ),
}

AGENT = "cycle-skip-orchestrator-under-test"


def _plan(plan_id, cycles, status="open"):
    return {"planId": plan_id, "cr": "skip-guard-project", "status": status,
            "cycles": cycles}


def _cycle(cycle_id, status="pending", kind="red-green",
          label="work the spec moved past"):
    return {"id": cycle_id, "status": status, "kind": kind, "label": label}


class _CycleSkipTestBase(unittest.TestCase):
    """A FRESH copy of ONE client module per test, with the fleet's
    tmp-project-dir + env-isolation idiom (`test_bun_crucible_cycle_add.py`'s
    `_BaseCycleAddTest.setUp`, generalised to the five-client loop AC5's
    "in all five clients" needs)."""

    def setUp(self):
        self.assertEqual(
            len(CLIENTS), 5,
            "fixture sanity: five-client parity needs exactly five clients")
        self.tmpdir = tempfile.mkdtemp(prefix="cycle-skip-guard-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write("CRUCIBLE_PROJECT_KEY=cycle-skip-guard-key\n"
                     "CRUCIBLE_PROJECT_NAME=cycle-skip-guard-project\n")
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _load(self, client):
        return _load_module_by_path(
            CLIENT_FILES[client], f"cycle_skip_under_test_{client}")

    def _decode(self, module, stdout_text):
        decoded = module._toon().decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"stdout must decode as a TOON-AXI envelope; got "
            f"stdout={stdout_text!r} decoded={decoded!r}")
        return decoded["axi"]


# ═══════════════════════════════════════════════════════════════════════════
# AC2 -- the guarded write: three fields ride the PATCH body, every client
# ═══════════════════════════════════════════════════════════════════════════


class CycleSkipPostsTheThreeFieldsInEveryClientTest(_CycleSkipTestBase):

    def test_the_three_fields_ride_the_patch_body_in_every_client(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [_plan("plan-501", [_cycle(9001)])]}
                patch_calls = []

                def fake_patch(path, payload, _calls=patch_calls):
                    _calls.append((path, payload))
                    return {"ok": True, "changed": True,
                            "cycle": _cycle(9001, status="skipped"),
                            "warnings": [PROCESS_FAILURE_WARNING]}

                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(module, "_patch", side_effect=fake_patch):
                    code, out, err = _run_main(module, [
                        VERB, "9001",
                        REASON_FLAG, "the mid-cycle spec revision made this obsolete",
                        CAUSE_FLAG, "spec-design",
                        SPEC_REF_FLAG, "design note §4",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])

                self.assertEqual(
                    code, 0,
                    f"[{client}] a guarded skip with all three fields must "
                    f"succeed; stdout={out!r} stderr={err!r}")
                self.assertEqual(
                    len(patch_calls), 1,
                    f"[{client}] exactly ONE PATCH; got {patch_calls!r}")
                path, payload = patch_calls[0]
                self.assertTrue(
                    path.endswith("/plans/plan-501/cycles/9001"),
                    f"[{client}] the skip targets the cycle's owning plan; "
                    f"got path={path!r}")
                self.assertEqual(
                    payload.get("status"), "skipped",
                    f"[{client}] got payload={payload!r}")
                self.assertEqual(
                    payload.get("reason"),
                    "the mid-cycle spec revision made this obsolete",
                    f"[{client}] the reason rides the body verbatim; got "
                    f"payload={payload!r}")
                self.assertEqual(
                    payload.get("cause"), "spec-design",
                    f"[{client}] got payload={payload!r}")
                self.assertEqual(
                    payload.get("specRef"), "design note §4",
                    f"[{client}] got payload={payload!r}")
                axi = self._decode(module, out)
                self.assertIs(axi.get("ok"), True, f"[{client}] got {axi!r}")
                self.assertIn(
                    PROCESS_FAILURE_WARNING, axi.get("warnings") or [],
                    f"[{client}] AC5 -- the envelope carries the server's "
                    f"process-failure warning VERBATIM; got {axi!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC5 -- local refusal BEFORE any HTTP, for a missing field or a bad cause
# ═══════════════════════════════════════════════════════════════════════════


_MISSING_FIELD_CASES = (
    ("missing reason",
     (CAUSE_FLAG, "spec-design", SPEC_REF_FLAG, "design note §4")),
    ("missing cause",
     (REASON_FLAG, "a spec change made this cycle obsolete",
      SPEC_REF_FLAG, "design note §4")),
    ("missing spec-ref",
     (REASON_FLAG, "a spec change made this cycle obsolete",
      CAUSE_FLAG, "spec-design")),
)


class CycleSkipRefusesLocallyWithoutAnyHttpCallTest(_CycleSkipTestBase):
    """AC5 -- "refuses locally (before any HTTP) when one is missing" --
    pinned on the TRANSPORT seam: neither `_get` nor `_patch` may fire, the
    same ordering `parseChangeRecord` (src/v2.ts) gives the server ("nothing
    is read for the write before it passes")."""

    def test_each_missing_field_is_refused_before_any_http_call(self):
        for name, extra in _MISSING_FIELD_CASES:
            for client in CLIENTS:
                with self.subTest(client=client, case=name):
                    module = self._load(client)
                    get_calls, patch_calls = [], []
                    with mock.patch.object(
                            module, "_get",
                            side_effect=lambda *a, _c=get_calls, **k:
                            (_c.append(a), {"ok": True, "plans": []})[1]), \
                         mock.patch.object(
                            module, "_patch",
                            side_effect=lambda *a, _c=patch_calls, **k:
                            (_c.append(a), {"ok": True})[1]):
                        code, out, err = _run_main(module, [
                            VERB, "9001", *extra,
                            "--agent", AGENT, "--project-dir", self.tmpdir,
                        ])
                    self.assertNotEqual(
                        code, 0,
                        f"[{client}/{name}] a skip missing a required field "
                        f"must be refused; stdout={out!r} stderr={err!r}")
                    self.assertEqual(
                        patch_calls, [],
                        f"[{client}/{name}] NO PATCH when the record is "
                        f"incomplete; got {patch_calls!r}")
                    self.assertEqual(
                        get_calls, [],
                        f"[{client}/{name}] the refusal is LOCAL -- no plan "
                        f"GET either; got {get_calls!r}")
                    axi = self._decode(module, out)
                    self.assertIs(
                        axi.get("ok"), False, f"[{client}/{name}] got {axi!r}")


class CycleSkipRefusesLocallyForAnInvalidCauseTest(_CycleSkipTestBase):
    """AC5 -- "or cause is invalid" -- a `cause` outside `CHANGE_CAUSES`
    (src/v2.ts: `spec-design` | `gap-analysis`) is refused BEFORE any HTTP,
    never relayed as the server's 400."""

    def test_an_unrecognised_cause_is_refused_before_any_http_call(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                get_calls, patch_calls = [], []
                with mock.patch.object(
                        module, "_get",
                        side_effect=lambda *a, _c=get_calls, **k:
                        (_c.append(a), {"ok": True, "plans": []})[1]), \
                     mock.patch.object(
                        module, "_patch",
                        side_effect=lambda *a, _c=patch_calls, **k:
                        (_c.append(a), {"ok": True})[1]):
                    code, out, err = _run_main(module, [
                        VERB, "9001",
                        REASON_FLAG, "a spec change made this cycle obsolete",
                        CAUSE_FLAG, "scope-creep",
                        SPEC_REF_FLAG, "design note §4",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])
                self.assertNotEqual(
                    code, 0, f"[{client}] got stdout={out!r} stderr={err!r}")
                self.assertEqual(get_calls, [], f"[{client}] got {get_calls!r}")
                self.assertEqual(patch_calls, [], f"[{client}] got {patch_calls!r}")
                axi = self._decode(module, out)
                self.assertIs(axi.get("ok"), False, f"[{client}] got {axi!r}")
                self.assertIn(
                    "spec-design", (out + err),
                    f"[{client}] the refusal names the two legal causes "
                    f"(CHANGE_CAUSES, src/v2.ts); got stdout={out!r} "
                    f"stderr={err!r}")
                self.assertIn(
                    "gap-analysis", (out + err),
                    f"[{client}] got stdout={out!r} stderr={err!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC5 -- a COMPLETE record the server still refuses surfaces verbatim
# ═══════════════════════════════════════════════════════════════════════════


class CycleSkipRelaysTheServersRefusalTest(_CycleSkipTestBase):

    def test_the_servers_refusal_surfaces_verbatim(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [
                    _plan("plan-501", [_cycle(9001, status="active")])]}
                server_error = (
                    "skipping cycle 9001 changes filed plan plan-501: the "
                    "cycle is not pending")
                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(
                        module, "_patch",
                        return_value={"ok": False, "error": server_error}):
                    code, out, err = _run_main(module, [
                        VERB, "9001",
                        REASON_FLAG, "a spec change made this cycle obsolete",
                        CAUSE_FLAG, "gap-analysis",
                        SPEC_REF_FLAG, "design note §4",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])
                self.assertNotEqual(
                    code, 0, f"[{client}] got stdout={out!r} stderr={err!r}")
                axi = self._decode(module, out)
                self.assertIs(axi.get("ok"), False, f"[{client}] got {axi!r}")
                self.assertIn(
                    server_error, (out + err),
                    f"[{client}] the server's own refusal must reach the "
                    f"caller, never a client-invented message; got "
                    f"stdout={out!r} stderr={err!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC5 -- `help[]` marks the verb as exceptional
# ═══════════════════════════════════════════════════════════════════════════


class CycleSkipHelpMarksTheVerbExceptionalTest(_CycleSkipTestBase):

    def test_the_success_envelope_help_names_the_verb_exceptional(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [_plan("plan-501", [_cycle(9001)])]}
                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(
                        module, "_patch",
                        return_value={"ok": True, "changed": True,
                                      "cycle": _cycle(9001, status="skipped"),
                                      "warnings": [PROCESS_FAILURE_WARNING]}):
                    code, out, err = _run_main(module, [
                        VERB, "9001",
                        REASON_FLAG, "a spec change made this cycle obsolete",
                        CAUSE_FLAG, "gap-analysis",
                        SPEC_REF_FLAG, "design note §4",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])
                self.assertEqual(code, 0, f"[{client}] got stdout={out!r} stderr={err!r}")
                axi = self._decode(module, out)
                help_steps = axi.get("help") or []
                self.assertTrue(
                    any("exceptional" in str(step).lower() for step in help_steps),
                    f"[{client}] cycle-skip's help[] must mark the verb as "
                    f"exceptional (§S2); got help={help_steps!r}")


if __name__ == "__main__":
    unittest.main()
