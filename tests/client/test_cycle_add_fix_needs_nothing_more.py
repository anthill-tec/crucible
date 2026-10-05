"""CR-CRU-165 C2 -- `cycle-add`'s client half: a `fix` append needs nothing
more, every other append (and an INSERT via `--before`) is guarded, and the
envelope names the plan's real cr instead of `None` (AC1 client half, AC7/N1).

Server contract read directly from the code (mocked at the `_get`/`_post`
seam, never a spawned server -- `test_bun_crucible_cycle_add.py`'s
established harness, looped across all five clients):

- `store.appendCycle` (src/store.ts): `change === undefined && (before !==
  undefined || cycle.kind !== "fix")` is the ONLY branch that refuses an
  unrecorded write -- a bare `kind: "fix"` append (no `before`) carries no
  guard at all; `--before` or any other `kind` needs the record.
- `handleCycleAppend` (src/v2.ts) reads `before` and, when a record is
  required, `{reason, cause, specRef}` off the SAME POST body
  (`parseChangeRecord`), and echoes `warnings: [PROCESS_FAILURE_WARNING]`
  when the append carried one.
- N1 (this CR's §S4): `cycle-add --plan 166 --kind fix` printed `cr=None` on
  2026-10-03 although cycle 552 belongs to plan 166 -- `cr_label` in
  `cmd_cycle_add` (`clients/_crucible_axi.py`) comes from
  `resolve_named_plan_or_emit`, which returns `(plan_id, None)` for `--plan`
  ALONE (no `--cr` to contradict-check against). G4's remedy: "the plan
  record already carries its CR; the envelope reads it from there."

RED, measured against the fleet today (2026-10-03): `--before` is declared by
NO client (`add_cycle_add_target_args`, `clients/_crucible_axi.py`, wires only
`--plan`/`--kind` -- confirmed by reading it) -- `argparse` answers
`unrecognized arguments: --before ...` and exits 2 for that half. The
non-fix-kind guard does not exist at all: today `--kind verify` with NO
reason/cause/specRef posts successfully, so the refusal half of each combined
test below is what currently fails (the `fix`-needs-nothing-more half already
holds and is folded in as a regression pin, never asserted standalone -- a
standalone "fix needs nothing" test would pass against today's CODE
unchanged and prove nothing new).

Harnesses reused, never re-invented: `_load_module_by_path`/`_run_main`/
`CLIENT_FILES`/`CLIENTS`/`ENV_KEYS` from
`test_plan_file_names_the_release_it_plans.py`.

Invocation:
    python3 -m unittest tests.client.test_cycle_add_fix_needs_nothing_more
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

VERB = "cycle-add"
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

AGENT = "cycle-add-orchestrator-under-test"


def _plan(plan_id, cr, cycles, status="open"):
    return {"planId": plan_id, "cr": cr, "status": status, "cycles": cycles}


def _cycle(cycle_id, status="pending", kind="red-green", label="a cycle"):
    return {"id": cycle_id, "status": status, "kind": kind, "label": label}


class _CycleAddTestBase(unittest.TestCase):

    def setUp(self):
        self.assertEqual(
            len(CLIENTS), 5,
            "fixture sanity: five-client parity needs exactly five clients")
        self.tmpdir = tempfile.mkdtemp(prefix="cycle-add-fix-only-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write("CRUCIBLE_PROJECT_KEY=cycle-add-fix-only-key\n"
                     "CRUCIBLE_PROJECT_NAME=cycle-add-fix-only-project\n")
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
            CLIENT_FILES[client], f"cycle_add_fix_only_under_test_{client}")

    def _decode(self, module, stdout_text):
        decoded = module._toon().decode(stdout_text)
        self.assertIn(
            "axi", decoded,
            f"stdout must decode as a TOON-AXI envelope; got "
            f"stdout={stdout_text!r} decoded={decoded!r}")
        return decoded["axi"]


# ═══════════════════════════════════════════════════════════════════════════
# AC1 (client half) -- a bare `fix` append needs nothing more; any other kind
# is guarded
# ═══════════════════════════════════════════════════════════════════════════


class CycleAddGuardsEveryChangeButAFixAppendTest(_CycleAddTestBase):

    def test_fix_posts_with_nothing_more_while_verify_is_refused_locally(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [_plan("plan-70", "owner-project", [])]}

                def fake_post(path, payload):
                    return {"ok": True, "changed": True, "id": 7001,
                            "label": payload.get("label"),
                            "kind": payload.get("kind", "red-green"),
                            "status": "pending"}

                fix_post_calls = []
                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(
                        module, "_post",
                        side_effect=lambda p, b, _c=fix_post_calls, _f=fake_post:
                        (_c.append((p, b)), _f(p, b))[1]):
                    fix_code, fix_out, fix_err = _run_main(module, [
                        VERB, "the fix", "--plan", "plan-70",
                        "--kind", "fix",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])

                self.assertEqual(
                    fix_code, 0,
                    f"[{client}] a bare `--kind fix` append must need "
                    f"nothing more; stdout={fix_out!r} stderr={fix_err!r}")
                self.assertEqual(
                    len(fix_post_calls), 1, f"[{client}] got {fix_post_calls!r}")
                fix_payload = fix_post_calls[0][1]
                self.assertNotIn(
                    "reason", fix_payload,
                    f"[{client}] a fix append carries NO change record; got "
                    f"payload={fix_payload!r}")

                verify_post_calls = []
                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(
                        module, "_post",
                        side_effect=lambda p, b, _c=verify_post_calls:
                        (_c.append((p, b)), {"ok": True})[1]):
                    verify_code, verify_out, verify_err = _run_main(module, [
                        VERB, "the verify", "--plan", "plan-70",
                        "--kind", "verify",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])

                self.assertNotEqual(
                    verify_code, 0,
                    f"[{client}] a `--kind verify` append WITHOUT "
                    f"reason/cause/specRef must be refused LOCALLY, not "
                    f"posted; stdout={verify_out!r} stderr={verify_err!r}")
                self.assertEqual(
                    verify_post_calls, [],
                    f"[{client}] NO POST when the record is incomplete for "
                    f"a non-fix append; got {verify_post_calls!r}")
                axi = self._decode(module, verify_out)
                self.assertIs(axi.get("ok"), False, f"[{client}] got {axi!r}")

    def test_a_non_fix_kind_posts_the_three_fields_and_relays_the_warning(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [_plan("plan-70", "owner-project", [])]}
                post_calls = []

                def fake_post(path, payload, _calls=post_calls):
                    _calls.append((path, payload))
                    return {"ok": True, "changed": True, "id": 7002,
                            "label": payload.get("label"), "kind": "verify",
                            "status": "pending",
                            "warnings": [PROCESS_FAILURE_WARNING]}

                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(module, "_post", side_effect=fake_post):
                    code, out, err = _run_main(module, [
                        VERB, "the verify", "--plan", "plan-70",
                        "--kind", "verify",
                        REASON_FLAG, "a spec change added a verify pass",
                        CAUSE_FLAG, "gap-analysis",
                        SPEC_REF_FLAG, "design note §7",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])

                self.assertEqual(code, 0, f"[{client}] stdout={out!r} stderr={err!r}")
                self.assertEqual(len(post_calls), 1, f"[{client}] got {post_calls!r}")
                payload = post_calls[0][1]
                self.assertEqual(
                    payload.get("reason"), "a spec change added a verify pass",
                    f"[{client}] got {payload!r}")
                self.assertEqual(
                    payload.get("cause"), "gap-analysis",
                    f"[{client}] got {payload!r}")
                self.assertEqual(
                    payload.get("specRef"), "design note §7",
                    f"[{client}] got {payload!r}")
                axi = self._decode(module, out)
                self.assertIn(
                    PROCESS_FAILURE_WARNING, axi.get("warnings") or [],
                    f"[{client}] got {axi!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC1 (client half) -- `--before <cycleId>` is a new, guarded insert
# ═══════════════════════════════════════════════════════════════════════════


class CycleAddBeforeIsAGuardedInsertTest(_CycleAddTestBase):

    def test_before_without_the_record_is_refused_and_posts_nothing(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [_plan("plan-70", "owner-project", [_cycle(500)])]}
                post_calls = []
                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(
                        module, "_post",
                        side_effect=lambda p, b, _c=post_calls:
                        (_c.append((p, b)), {"ok": True})[1]):
                    code, out, err = _run_main(module, [
                        VERB, "inserted ahead", "--plan", "plan-70",
                        "--before", "500",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])
                self.assertNotEqual(code, 0, f"[{client}] stdout={out!r} stderr={err!r}")
                self.assertEqual(post_calls, [], f"[{client}] got {post_calls!r}")
                axi = self._decode(module, out)
                self.assertIs(axi.get("ok"), False, f"[{client}] got {axi!r}")

    def test_before_with_the_record_posts_before_and_the_three_fields(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [_plan("plan-70", "owner-project", [_cycle(500)])]}
                post_calls = []

                def fake_post(path, payload, _calls=post_calls):
                    _calls.append((path, payload))
                    return {"ok": True, "changed": True, "id": 7003,
                            "label": payload.get("label"), "kind": "red-green",
                            "status": "pending",
                            "warnings": [PROCESS_FAILURE_WARNING]}

                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(module, "_post", side_effect=fake_post):
                    code, out, err = _run_main(module, [
                        VERB, "inserted ahead", "--plan", "plan-70",
                        "--before", "500",
                        REASON_FLAG, "a spec revision needs a cycle ahead of 500",
                        CAUSE_FLAG, "spec-design",
                        SPEC_REF_FLAG, "design note §9",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])
                self.assertEqual(code, 0, f"[{client}] stdout={out!r} stderr={err!r}")
                self.assertEqual(len(post_calls), 1, f"[{client}] got {post_calls!r}")
                payload = post_calls[0][1]
                self.assertEqual(payload.get("before"), 500, f"[{client}] got {payload!r}")
                self.assertEqual(
                    payload.get("reason"),
                    "a spec revision needs a cycle ahead of 500",
                    f"[{client}] got {payload!r}")
                self.assertEqual(
                    payload.get("cause"), "spec-design", f"[{client}] got {payload!r}")
                self.assertEqual(
                    payload.get("specRef"), "design note §9", f"[{client}] got {payload!r}")
                axi = self._decode(module, out)
                self.assertIn(
                    PROCESS_FAILURE_WARNING, axi.get("warnings") or [],
                    f"[{client}] got {axi!r}")


# ═══════════════════════════════════════════════════════════════════════════
# AC7/N1 -- the envelope names the plan's real cr, not None, for `--plan`
# alone
# ═══════════════════════════════════════════════════════════════════════════


class CycleAddNamesThePlansCrWhenPlanAloneIsGivenTest(_CycleAddTestBase):
    """N1 -- measured 2026-10-03: `cycle-add --plan 166 --kind fix` printed
    `cr=None` although cycle 552 belongs to plan 166. `resolve_named_plan_or_
    emit` (`clients/_crucible_axi.py`) returns `(plan_id, None)` for `--plan`
    ALONE; G4's remedy reads the cr from the plan record instead."""

    def test_plan_alone_names_the_real_cr_not_none(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                module = self._load(client)
                plans = {"ok": True, "plans": [
                    _plan("plan-166", "the-plans-owning-project",
                         [_cycle(5520, status="done", kind="verify")]),
                ]}

                def fake_post(path, payload):
                    return {"ok": True, "changed": True, "id": 5521,
                            "label": payload.get("label"), "kind": "fix",
                            "status": "pending"}

                with mock.patch.object(module, "_get", return_value=plans), \
                     mock.patch.object(module, "_post", side_effect=fake_post):
                    code, out, err = _run_main(module, [
                        VERB, "the fix", "--plan", "plan-166", "--kind", "fix",
                        "--agent", AGENT, "--project-dir", self.tmpdir,
                    ])

                self.assertEqual(code, 0, f"[{client}] stdout={out!r} stderr={err!r}")
                axi = self._decode(module, out)
                self.assertEqual(
                    (axi.get("context") or {}).get("cr"),
                    "the-plans-owning-project",
                    f"[{client}] N1 -- the envelope must name the PLAN's "
                    f"real cr, not None, when --plan is used alone; got "
                    f"context={axi.get('context')!r}")


if __name__ == "__main__":
    unittest.main()
