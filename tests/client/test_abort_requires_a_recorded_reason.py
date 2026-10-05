"""CR-CRU-165 C2 -- `abort` requires a recorded reason, cause and spec
reference, in all five clients (AC11 client half).

Server contract read directly from `handlePlanAbort` (src/v2.ts): the
approval gate (`userApproved: true`) runs FIRST, then `parseChangeRecord`
reads `{reason, cause, specRef}` off the SAME POST body
(`"an abort is a recorded failure of the spec or of its gap analysis and
needs reason, cause and specRef"`), and a successful abort echoes
`warnings: [PROCESS_FAILURE_WARNING]` -- the identical warning every
guarded plan change carries (src/v2.ts), relayed here verbatim.

RED, measured against the fleet today (2026-10-03): `cmd_abort`
(`clients/_crucible_axi.py`) posts `{userApproved, agentId}` only -- no
`--reason`/`--cause`/`--spec-ref` flag exists on `abort` in ANY client
(confirmed by reading the abort subparser in each of the five), so every
guarded-record assertion below fails against the CURRENT code: an abort with
none of the three fields posts successfully today (the only guard is
`--user-approved`), which is precisely the gap AC11 closes.

Harnesses reused, never re-invented: `_load_module_by_path`/`_run_main`/
`CLIENT_FILES`/`CLIENTS`/`ENV_KEYS` from
`test_plan_file_names_the_release_it_plans.py`.

Invocation:
    python3 -m unittest tests.client.test_abort_requires_a_recorded_reason
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

VERB = "abort"
REASON_FLAG = "--reason"
CAUSE_FLAG = "--cause"
SPEC_REF_FLAG = "--spec-ref"

# src/v2.ts PROCESS_FAILURE_WARNING -- relayed verbatim, never reworded.
PROCESS_FAILURE_WARNING = {
    "code": "process-failure",
    "message": (
        "this change to a filed plan records a process failure: a spec "
        "that changes mid-implementation shows that the spec's design or "
        "its gap analysis fell short — it is counted for the retrospective"
    ),
}

AGENT = "abort-orchestrator-under-test"


def _plan(plan_id, cr="owner-project", status="open"):
    return {"planId": plan_id, "cr": cr, "status": status, "cycles": []}


class _AbortTestBase(unittest.TestCase):

    def setUp(self):
        self.assertEqual(
            len(CLIENTS), 5,
            "fixture sanity: five-client parity needs exactly five clients")
        self.tmpdir = tempfile.mkdtemp(prefix="abort-guard-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write("CRUCIBLE_PROJECT_KEY=abort-guard-key\n"
                     "CRUCIBLE_PROJECT_NAME=abort-guard-project\n")
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
            CLIENT_FILES[client], f"abort_guard_under_test_{client}")

    def _decode(self, module, stdout_text):
        decoded = module._toon().decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"stdout must decode as a TOON-AXI envelope; got "
            f"stdout={stdout_text!r} decoded={decoded!r}")
        return decoded["axi"]


# ═══════════════════════════════════════════════════════════════════════════
# AC11 (client half) -- missing a field refuses, without POSTing
# ═══════════════════════════════════════════════════════════════════════════


_MISSING_FIELD_CASES = (
    ("missing reason",
     (CAUSE_FLAG, "spec-design", SPEC_REF_FLAG, "design note §2")),
    ("missing cause",
     (REASON_FLAG, "the plan no longer fits the spec",
      SPEC_REF_FLAG, "design note §2")),
    ("missing spec-ref",
     (REASON_FLAG, "the plan no longer fits the spec",
      CAUSE_FLAG, "spec-design")),
)


class AbortRequiresTheRecordInEveryClientTest(_AbortTestBase):

    def test_missing_reason_cause_or_spec_ref_is_refused_without_posting(self):
        for name, extra in _MISSING_FIELD_CASES:
            for client in CLIENTS:
                with self.subTest(client=client, case=name):
                    module = self._load(client)
                    plans = {"ok": True, "plans": [_plan("plan-80")]}
                    post_calls = []
                    with mock.patch.object(module, "_get", return_value=plans), \
                         mock.patch.object(
                            module, "_post",
                            side_effect=lambda p, b, _c=post_calls:
                            (_c.append((p, b)), {"ok": True})[1]):
                        code, out, err = _run_main(module, [
                            VERB, "--user-approved", *extra,
                            "--agent", AGENT, "--project-dir", self.tmpdir,
                        ])
                    self.assertNotEqual(
                        code, 0,
                        f"[{client}/{name}] an abort missing a required "
                        f"field must be refused; stdout={out!r} "
                        f"stderr={err!r}")
                    self.assertEqual(
                        post_calls, [],
                        f"[{client}/{name}] NO abort POST when the record "
                        f"is incomplete; got {post_calls!r}")
                    axi = self._decode(module, out)
                    self.assertIs(
                        axi.get("ok"), False, f"[{client}/{name}] got {axi!r}")

    def test_the_three_fields_ride_the_abort_body_and_the_warning_relays(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [_plan("plan-80")]}
                post_calls = []

                def fake_post(path, payload, _calls=post_calls):
                    _calls.append((path, payload))
                    return {"ok": True, "changed": True,
                            "plan": {"planId": "plan-80", "status": "aborted"},
                            "warnings": [PROCESS_FAILURE_WARNING]}

                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(module, "_post", side_effect=fake_post):
                    code, out, err = _run_main(module, [
                        VERB, "--user-approved",
                        REASON_FLAG, "the plan no longer fits the revised spec",
                        CAUSE_FLAG, "spec-design",
                        SPEC_REF_FLAG, "design note §2",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])

                self.assertEqual(code, 0, f"[{client}] stdout={out!r} stderr={err!r}")
                self.assertEqual(len(post_calls), 1, f"[{client}] got {post_calls!r}")
                payload = post_calls[0][1]
                self.assertIs(
                    payload.get("userApproved"), True, f"[{client}] got {payload!r}")
                self.assertEqual(
                    payload.get("reason"),
                    "the plan no longer fits the revised spec",
                    f"[{client}] got {payload!r}")
                self.assertEqual(
                    payload.get("cause"), "spec-design", f"[{client}] got {payload!r}")
                self.assertEqual(
                    payload.get("specRef"), "design note §2", f"[{client}] got {payload!r}")
                axi = self._decode(module, out)
                self.assertIs(axi.get("ok"), True, f"[{client}] got {axi!r}")
                self.assertIn(
                    PROCESS_FAILURE_WARNING, axi.get("warnings") or [],
                    f"[{client}] AC11 -- the envelope carries the server's "
                    f"process-failure warning VERBATIM; got {axi!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC11 (client half) -- a complete record the server still refuses relays
# ═══════════════════════════════════════════════════════════════════════════


class AbortRelaysTheServersRefusalTest(_AbortTestBase):

    def test_the_servers_refusal_surfaces_verbatim(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [_plan("plan-80")]}
                server_error = (
                    "invalid cause: \"scope-creep\" (expected spec-design | "
                    "gap-analysis)")
                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(
                        module, "_post",
                        return_value={"ok": False, "error": server_error}):
                    code, out, err = _run_main(module, [
                        VERB, "--user-approved",
                        REASON_FLAG, "the plan no longer fits the revised spec",
                        CAUSE_FLAG, "spec-design",
                        SPEC_REF_FLAG, "design note §2",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])
                self.assertNotEqual(
                    code, 0, f"[{client}] got stdout={out!r} stderr={err!r}")
                axi = self._decode(module, out)
                self.assertIs(axi.get("ok"), False, f"[{client}] got {axi!r}")


if __name__ == "__main__":
    unittest.main()
