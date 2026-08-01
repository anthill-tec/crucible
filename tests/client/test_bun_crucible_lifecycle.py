"""CR-CRU-021 §S5 (cycle 16) — CLIENT contract: `bun-crucible.py test`/`regression`
with `--agent` REGISTERS the agent before the run and UNREGISTERS it after the
final ingest, so gate/close-out agents never linger as online ghosts.

§S5 verbatim: "`bun-crucible.py test`/`regression` with `--agent` REGISTERS the
agent before the run and UNREGISTERS it after the final ingest — gate/close-out
agents never linger as online ghosts, and their runtimes seal honestly on the
lifecycle event."

AC verbatim: "`bun-crucible.py regression --agent X` against a live server
leaves NO agent row in the fleet after exit (register→ingest→unregister
bracketed; asserted via the Python client contract harness + a lifecycle-event
pair check); `test --agent X` identical; omitted `--agent` unchanged."

CR-CRU-030 C1 retarget note: the ORIGINAL cycle-16 RED pinned a literal
THREE-call bracket (`_post("/api/agents/heartbeat")` → ingest →
`_post("/api/agents/remove")`). Endpoint literals were corrected then: the
register/unregister verbs live at `/api/v2/agents/register|unregister` (not
the retired `/api/agents/heartbeat|remove` shim), and ingest lives at
`/api/v2/runs/parsed` (not `/api/ingest/*`).

CR-CRU-056 (C5) retarget note — the SECOND redesign of this same bracket, and
the reason the pins below moved again:

  * The interim "v2 model" this file was retargeted to in CR-CRU-030 C1 — "a
    gated run needs NO explicit register: the run's ingest IS the registration
    (implicit heartbeat)" — is GONE. CR-CRU-056 §S3b retired implicit agent
    creation outright: an ingest from an id with no live registered row is
    refused (409) and stores nothing. A gated run must therefore DECLARE its
    identity, so the bracket opens with a phase-OPTIONAL heartbeat
    (`/api/v2/agents/heartbeat`, never `/register`: the gated verbs take no
    `--phase`, and CR-CRU-044 §S1(a) makes the heartbeat the one touch that
    cannot blank a pre-registered caller's declared phase).
  * The closing half is no longer UNCONDITIONAL. CR-CRU-056 §S1 stores the
    agent's cycle binding ON the agent row, so silently deleting a row the
    CALLER registered destroys that caller's binding — and the next gated run
    under the same identity ingests unattached. Observed live on :3849
    (2026-08-01): `vidushi` registered bound to cycle 152; a
    `python-crucible.py regression --agent vidushi` stamped 152 and then ran
    its cleanup; the immediately following `bun-crucible.py regression --agent
    vidushi` landed with NO cycle. The anti-ghost PURPOSE (CR-CRU-021 §S5) is
    preserved exactly — only its REACH is corrected: the bracket removes an
    identity it CREATED and never one that pre-existed.
  * Ownership is not guessed. The server's register/heartbeat response already
    carries `changed: true` iff that call created the row (`src/v2.ts`
    handleAgentTouch: `changed: !existed`), and `_patched_post` below models
    that faithfully with a real in-memory agent registry — a fake that always
    answered `{"ok": True}` could not tell the two cases apart, and would let
    either behaviour pass.

Technique: loads bun-crucible.py by file path via importlib (its filename has
a hyphen), REPO_ROOT-relative to `clients/bun-crucible.py` (the in-repo
SOURCE OF TRUTH, CR-CRU-008 Risk section — we test and fix the scripts we
OWN, not the deployed `~/.claude/scripts` mirror), same convention as the
sibling test_bun_crucible_gates.py / test_bun_crucible_toon_envelope.py
harnesses. This file additionally patches the module's single HTTP
transport seam, `_post(path, payload)` (bun-crucible.py's only function that
touches urllib), recording every `(path, payload)` call in order. This is
strictly more deterministic than hitting the live server on :3849 (no
network flakiness, no fleet state to clean up) and needs no new pattern
invented beyond what the module already exposes as a seam.

`bun test` itself is never actually invoked: `--bun` is pointed at a tiny
fake executable (written per-test to a tempdir, `chmod +x`, real shebang) that
ignores its arguments except `--reporter-outfile=<path>`, to which it copies
a fixture JUnit XML body from the `FAKE_BUN_JUNIT_CONTENT` env var and exits
with `FAKE_BUN_EXIT_CODE`. This drives the REAL `cmd_test`/`cmd_regression`
code paths (arg resolution, wipe, subprocess invocation, JUnit parse, ingest)
end to end without requiring bun or a bun package on this machine.

No live-server variant is included: the existing Python client harness in
this repo has never made a live-server call (test_bun_crucible_context.py is
pure-function only), so there is no established live-server pattern here to
extend, and the dispatch instructions say the request-sequence pins suffice
in that case. The request-sequence + payload-shape pins below are the full
RED coverage for §S5.

Invocation (matches test_bun_crucible_context.py's documented convention):
    python3 -m pytest tests/client/ -q          (run from the repo root)
Fallback:
    python3 tests/client/test_bun_crucible_lifecycle.py
"""

import argparse
import copy
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

PASS_JUNIT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="lifecycle.test.ts" tests="1" failures="0">
<testcase name="passes" time="0.001"></testcase>
</testsuite>
</testsuites>
"""

FAIL_JUNIT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="lifecycle.test.ts" tests="1" failures="1">
<testcase name="fails" time="0.001"><failure message="boom">boom trace</failure></testcase>
</testsuite>
</testsuites>
"""

# A tiny fake `bun` executable. Ignores all args except `--reporter-outfile=`,
# to which it copies FAKE_BUN_JUNIT_CONTENT verbatim, then exits with
# FAKE_BUN_EXIT_CODE. Real subprocess.run() invokes this via its shebang —
# no actual bun binary or package.json is needed anywhere on this machine.
FAKE_BUN_SCRIPT_TEMPLATE = """#!{python}
import os
import sys

outfile = None
for a in sys.argv[1:]:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]

content = os.environ.get("FAKE_BUN_JUNIT_CONTENT", "")
if outfile and content:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
        f.write(content)

sys.exit(int(os.environ.get("FAKE_BUN_EXIT_CODE", "0")))
"""


def _load_bun_crucible_module():
    """Load bun-crucible.py by file path — its filename has a hyphen, so it
    cannot be `import`ed as a normal module name. REPO_ROOT-relative load of
    `clients/bun-crucible.py` (the in-repo SOURCE OF TRUTH, CR-CRU-008 Risk
    section) — we test and fix the scripts we OWN, not the deployed
    `~/.claude/scripts` mirror. Same technique as the sibling
    test_bun_crucible_gates.py / test_bun_crucible_toon_envelope.py harnesses."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_lifecycle", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GateRunLifecycleBracketTest(unittest.TestCase):
    """CR-CRU-021 §S5 + CR-CRU-056 (C5) — the gated-run lifecycle bracket for
    `test`/`regression` with `--agent`: opening heartbeat → ingest → silent
    unregister OF WHAT THIS RUN CREATED (see the module docstring's retarget
    notes), asserted via the ONLY HTTP seam bun-crucible.py has: `_post`."""

    ENV_KEYS = ("WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
                "FAKE_BUN_JUNIT_CONTENT", "FAKE_BUN_EXIT_CODE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-lifecycle-")
        self.project_dir = self.tmpdir
        with open(os.path.join(self.project_dir, ".env"), "w") as f:
            f.write("CRUCIBLE_PROJECT_KEY=test-key-123\n")

        self.fake_bun = os.path.join(self.tmpdir, "fake_bun.py")
        with open(self.fake_bun, "w") as f:
            f.write(FAKE_BUN_SCRIPT_TEMPLATE.format(python=sys.executable))
        os.chmod(self.fake_bun, 0o755)

        # WORKFLOW_CYCLE_ID/WORKFLOW_CYCLE feed _run_context(), which rides
        # the ingest payload's `context` field — unrelated to this CR's
        # lifecycle-bracket pins, so start deterministically unset (no
        # ambient env leak) same as the sibling harness.
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)
        # CR-CRU-036 §S1 — an --agent ingest resolves a cycle to attach to
        # BEFORE the POST, warning + withholding (no ingest, no bracket) when
        # the server DEFINITIVELY reports an open plan with no active cycle.
        # This class's tmpdir `.env` project key is not a real UUID, so the
        # auto-resolution GET would 400 server-side -- exactly the §S1
        # TOLERANT case (a plans-fetch failure is not proof of "no active
        # cycle"), so the ingest proceeds. `WORKFLOW_CYCLE_ID` no longer
        # exists to short-circuit this lookup, so `_get` is mocked here
        # (module-wide for this bracket-only test class) to return that
        # tolerant failure deterministically, never touching the live server.
        self._get_patcher = mock.patch.object(
            self.module, "_get",
            return_value={"ok": False,
                          "error": "connection failed: mock (non-UUID project key)"})
        self._get_patcher.start()

    def tearDown(self):
        self._get_patcher.stop()
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # -- Namespace builders (mirrors argparse's `test`/`regression` subparsers) --

    def _test_args(self, agent, cycle=None):
        return argparse.Namespace(
            tests=None,
            agent=agent,
            cycle=cycle,
            reports=None,
            bun=self.fake_bun,
            package_dir=self.project_dir,
            project_dir=self.project_dir,
            log=None,
        )

    def _regression_args(self, agent, cycle=None):
        return argparse.Namespace(
            agent=agent,
            cycle=cycle,
            coverage=False,
            reports=None,
            bun=self.fake_bun,
            package_dir=self.project_dir,
            project_dir=self.project_dir,
            log=None,
        )

    # -- shape assertions, per the real v2 ingest/_remove_agent_silent verb shape --

    def _assert_unregister_payload(self, payload, agent):
        self.assertEqual(payload.get("agentId"), agent)
        self.assertEqual(payload.get("projectKey"), "test-key-123")
        # the gated-run cleanup is the SILENT v2 unregister (CR-CRU-008 §S4):
        # no lifecycle event journaled, unlike a plain `unregister` verb call.
        self.assertIs(payload.get("silent"), True)
        # negative: the silent unregister must NOT carry register-only fields
        self.assertNotIn("status", payload)
        self.assertNotIn("identity", payload)

    # `registry` is the fake server's agent table. CR-CRU-056 (C5): the
    # ownership decision the bracket now makes is driven ENTIRELY by the
    # server's `changed` flag (`changed: !existed`, src/v2.ts
    # handleAgentTouch), so the fake must model row existence — a stub that
    # always answered `{"ok": True}` would make "removed the caller's row" and
    # "removed its own row" indistinguishable, and pass either way.
    def _patched_post(self, calls, raise_on_ingest=False, registry=None):
        rows = set() if registry is None else registry

        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            if raise_on_ingest and path.startswith("/api/v2/runs/"):
                raise RuntimeError("simulated ingest network failure")
            agent_id = payload.get("agentId")
            if path in ("/api/v2/agents/heartbeat", "/api/v2/agents/register"):
                created = agent_id not in rows
                rows.add(agent_id)
                return {"ok": True, "changed": created}
            if path == "/api/v2/agents/unregister":
                existed = agent_id in rows
                rows.discard(agent_id)
                return {"ok": True, "changed": existed}
            return {"ok": True}
        return fake_post

    def _assert_open_heartbeat_payload(self, payload, agent, cycle=None):
        """The bracket's OPENING call: the phase-optional heartbeat that
        declares the run's identity."""
        self.assertEqual(payload.get("agentId"), agent)
        self.assertEqual(payload.get("projectKey"), "test-key-123")
        # CR-CRU-044 §S1(a) — a gated verb declares no phase, so the opening
        # touch must NOT carry one: re-declaring would blank the phase a
        # pre-registered caller registered with.
        self.assertNotIn("phase", payload)
        if cycle is None:
            # §S1 touch-never-blanks: an absent key leaves a stored binding
            # untouched. A fabricated null/0 would be a client-side resolution.
            self.assertNotIn("cycleId", payload)
        else:
            self.assertEqual(payload.get("cycleId"), cycle)

    # ---- Pin 1: `test --agent X` brackets open-heartbeat -> ingest -> unregister ----

    def test_test_command_with_agent_opens_identity_then_ingests_then_unregisters(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-021-C16-test-agent"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            rc = self.module.cmd_test(self._test_args(agent))

        self.assertEqual(rc, 0)
        paths = [c[0] for c in calls]
        ingest_idx = [i for i, p in enumerate(paths) if p.startswith("/api/v2/runs/")]
        unregister_idx = [i for i, p in enumerate(paths) if p == "/api/v2/agents/unregister"]

        self.assertEqual(len(ingest_idx), 1,
                          f"expected exactly ONE ingest call, got paths={paths}")
        self.assertEqual(len(unregister_idx), 1,
                          f"expected exactly ONE unregister call, got paths={paths}")
        # CR-CRU-044 §S1(a) — the bracket's identity call is the phase-OPTIONAL
        # heartbeat, never the phase-declaring /register verb.
        self.assertNotIn("/api/v2/agents/register", paths,
                          "the gated bracket must open on the phase-OPTIONAL "
                          "heartbeat, never /api/v2/agents/register (a gated "
                          "verb declares no --phase and must not blank one)")

        self.assertEqual(paths[0], "/api/v2/agents/heartbeat",
                          "the opening identity heartbeat must be the FIRST "
                          "call — CR-CRU-056 §S3b refuses an ingest from an "
                          "id with no live registered row")
        self.assertEqual(ingest_idx[0], 1, "the ingest follows the opening heartbeat")
        self.assertEqual(unregister_idx[0], len(calls) - 1,
                          "unregister must be the LAST call made")

        self._assert_open_heartbeat_payload(calls[0][1], agent)
        ingest_payload = calls[ingest_idx[0]][1]
        self.assertEqual(ingest_payload.get("agentId"), agent)
        self.assertEqual(ingest_payload.get("summary", {}).get("passed"), 1)
        self.assertEqual(ingest_payload.get("summary", {}).get("failed"), 0)

        self._assert_unregister_payload(calls[unregister_idx[0]][1], agent)

    # ---- Pin 2: `regression --agent X` — identical bracket ----

    def test_regression_command_with_agent_opens_identity_then_ingests_then_unregisters(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-021-C16-regression-agent"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            rc = self.module.cmd_regression(self._regression_args(agent))

        self.assertEqual(rc, 0)
        paths = [c[0] for c in calls]
        ingest_idx = [i for i, p in enumerate(paths) if p.startswith("/api/v2/runs/")]
        unregister_idx = [i for i, p in enumerate(paths) if p == "/api/v2/agents/unregister"]

        self.assertEqual(len(ingest_idx), 1,
                          f"expected exactly ONE ingest call, got paths={paths}")
        self.assertEqual(len(unregister_idx), 1,
                          f"expected exactly ONE unregister call, got paths={paths}")
        self.assertNotIn("/api/v2/agents/register", paths,
                          "the gated bracket must open on the phase-OPTIONAL "
                          "heartbeat, never /api/v2/agents/register")

        self.assertEqual(paths[0], "/api/v2/agents/heartbeat",
                          "the opening identity heartbeat must be the FIRST call")
        self.assertEqual(ingest_idx[0], 1, "the ingest follows the opening heartbeat")
        self.assertEqual(unregister_idx[0], len(calls) - 1,
                          "unregister must be the LAST call made")

        self._assert_open_heartbeat_payload(calls[0][1], agent)
        ingest_payload = calls[ingest_idx[0]][1]
        self.assertEqual(ingest_payload.get("agentId"), agent)
        self.assertEqual(ingest_payload.get("tier"), "regression")
        self.assertEqual(ingest_payload.get("summary", {}).get("passed"), 1)
        self.assertEqual(ingest_payload.get("summary", {}).get("failed"), 0)

        self._assert_unregister_payload(calls[unregister_idx[0]][1], agent)

    # ---- Pin 3: `test` WITHOUT --agent — unchanged (no register/unregister at all) ----

    def test_test_command_without_agent_makes_no_register_or_unregister_calls(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            rc = self.module.cmd_test(self._test_args(agent=None))

        self.assertEqual(rc, 0)
        self.assertEqual(calls, [],
                          f"omitted --agent must make ZERO Crucible HTTP calls "
                          f"(no register, no ingest, no unregister); got {calls}")

    # ---- Pin 4: a FAILING run still unregisters (try/finally, unconditional on outcome) ----

    def test_test_command_failing_run_still_ingests_and_unregisters(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = FAIL_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "1"
        agent = "CR-CRU-021-C16-test-agent-fail"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            self.module.cmd_test(self._test_args(agent))

        paths = [c[0] for c in calls]
        self.assertTrue(any(p.startswith("/api/v2/runs/") for p in paths),
                         f"a failing test run must still INGEST, got paths={paths}")
        self.assertIn("/api/v2/agents/unregister", paths,
                       "a failing test run must still tear down the identity it "
                       "created (the bracket is outcome-independent)")
        self.assertEqual(paths[0], "/api/v2/agents/heartbeat",
                         "the opening identity heartbeat must be the FIRST call")
        self.assertEqual(paths[-1], "/api/v2/agents/unregister")

        ingest_payload = next(p for path, p in calls if path.startswith("/api/v2/runs/"))
        self.assertEqual(ingest_payload.get("summary", {}).get("failed"), 1)
        self.assertEqual(ingest_payload.get("summary", {}).get("passed"), 0)

    def test_regression_command_failing_run_still_ingests_and_unregisters(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = FAIL_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "1"
        agent = "CR-CRU-021-C16-regression-agent-fail"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            self.module.cmd_regression(self._regression_args(agent))

        paths = [c[0] for c in calls]
        self.assertTrue(any(p.startswith("/api/v2/runs/") for p in paths),
                         f"a failing regression run must still INGEST, got paths={paths}")
        self.assertIn("/api/v2/agents/unregister", paths,
                       "a failing regression run must still tear down the identity "
                       "it created (the bracket is outcome-independent)")
        self.assertEqual(paths[0], "/api/v2/agents/heartbeat",
                         "the opening identity heartbeat must be the FIRST call")
        self.assertEqual(paths[-1], "/api/v2/agents/unregister")

        ingest_payload = next(p for path, p in calls if path.startswith("/api/v2/runs/"))
        self.assertEqual(ingest_payload.get("summary", {}).get("failed"), 1)

    # ---- Bonus: an exception mid-ingest must not skip the unregister (real try/finally) ----

    def test_ingest_exception_does_not_skip_unregister(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-021-C16-test-agent-exc"
        calls = []
        with mock.patch.object(self.module, "_post",
                                side_effect=self._patched_post(calls, raise_on_ingest=True)):
            with self.assertRaises(RuntimeError):
                self.module.cmd_test(self._test_args(agent))

        paths = [c[0] for c in calls]
        self.assertTrue(any(p.startswith("/api/v2/runs/") for p in paths),
                         "the ingest must fire before it raises")
        self.assertIn("/api/v2/agents/unregister", paths,
                       "unregister must STILL fire despite the ingest exception "
                       "(the bracket is a try/finally, not a try/except-success-only)")
        self.assertEqual(paths[-1], "/api/v2/agents/unregister",
                          "unregister must be the LAST call even after an exception mid-run")

    # ── CR-CRU-056 (C5) — the bracket owns only what it CREATED ─────────────
    #
    # Live failure these pin (:3849, 2026-08-01): `vidushi` registered
    # `--phase ORCHESTRATOR --cycle 152`; `python-crucible.py regression
    # --agent vidushi` ingested stamped 152 and then ran its cleanup; the
    # immediately following `bun-crucible.py regression --agent vidushi`
    # ingested with NO cycle — the binding died with the row the cleanup
    # deleted. That is the very failure mode CR-CRU-056 exists to prevent,
    # reintroduced by the CR's own new surface.

    def test_pre_registered_caller_survives_a_gated_run_with_its_binding_intact(self):
        """(a) The caller registered BEFORE the run; the bracket must leave
        that registration — and therefore its cycle binding — standing."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-056-C5-pre-registered"
        registry = {agent}          # the caller's own `register --cycle 152` row
        calls = []
        with mock.patch.object(self.module, "_post",
                                side_effect=self._patched_post(calls, registry=registry)):
            rc = self.module.cmd_test(self._test_args(agent))

        self.assertEqual(rc, 0)
        paths = [c[0] for c in calls]
        self.assertNotIn(
            "/api/v2/agents/unregister", paths,
            "a gated run must NOT remove an identity it did not create — "
            "CR-CRU-056 §S1 stores the cycle binding ON the agent row, so "
            f"deleting it destroys the caller's binding. paths={paths}")
        self.assertIn(agent, registry,
                       "the caller's registration must survive the gated run")
        # The opening heartbeat must not have re-declared a phase either
        # (CR-CRU-044 §S1(a)) — that would blank the caller's ORCHESTRATOR.
        self._assert_open_heartbeat_payload(calls[0][1], agent)

    def test_two_consecutive_gated_runs_under_one_registration_both_ingest(self):
        """(a, continued) The LIVE scenario: two gated runs back to back under
        ONE pre-existing registration. Before the fix the first run's cleanup
        deleted the row, so the second run's evidence landed off the cycle."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-056-C5-consecutive"
        registry = {agent}
        calls = []
        fake_post = self._patched_post(calls, registry=registry)
        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            self.assertEqual(self.module.cmd_regression(self._regression_args(agent)), 0)
            self.assertIn(agent, registry,
                           "the registration must still exist between the two runs")
            first_run_calls = len(calls)
            self.assertEqual(self.module.cmd_test(self._test_args(agent)), 0)

        second_run_paths = [p for p, _ in calls[first_run_calls:]]
        self.assertTrue(
            any(p.startswith("/api/v2/runs/") for p in second_run_paths),
            f"the SECOND consecutive gated run must still ingest under the "
            f"caller's live registration, got paths={second_run_paths}")
        self.assertNotIn("/api/v2/agents/unregister", [p for p, _ in calls],
                          "neither run may remove the caller's registration")
        self.assertIn(agent, registry)

    def test_run_created_identity_is_still_silently_removed(self):
        """(b) The CR-CRU-021 §S5 anti-ghost purpose, PRESERVED: an identity
        this run brought into being is still torn down, silently."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-056-C5-run-created"
        registry = set()            # nobody registered this id beforehand
        calls = []
        with mock.patch.object(self.module, "_post",
                                side_effect=self._patched_post(calls, registry=registry)):
            rc = self.module.cmd_test(self._test_args(agent))

        self.assertEqual(rc, 0)
        paths = [c[0] for c in calls]
        self.assertEqual(paths[-1], "/api/v2/agents/unregister",
                          f"a run-created identity must still be removed LAST, "
                          f"got paths={paths}")
        self._assert_unregister_payload(calls[-1][1], agent)
        self.assertNotIn(agent, registry,
                          "no online ghost may linger on the agent rail")

    def test_gate_cycle_flag_binds_a_run_created_registration(self):
        """(c) `--cycle` passthrough: the register-inside-the-run case binds
        via the opening heartbeat, so the run's evidence attaches without a
        separate `register` call."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-056-C5-cycle-passthrough"
        calls = []
        with mock.patch.object(self.module, "_post",
                                side_effect=self._patched_post(calls, registry=set())):
            rc = self.module.cmd_test(self._test_args(agent, cycle=152))

        self.assertEqual(rc, 0)
        self.assertEqual(calls[0][0], "/api/v2/agents/heartbeat")
        self._assert_open_heartbeat_payload(calls[0][1], agent, cycle=152)
        # §S3 — the CLIENT still resolves nothing: the ingest carries no
        # cycle of its own; the server stamps it from the binding.
        ingest_payload = next(p for path, p in calls if path.startswith("/api/v2/runs/"))
        self.assertNotIn("cycleId", ingest_payload.get("context", {}),
                          "the client must send NO resolved cycle on the ingest "
                          "— attachment is server-stamped from the binding (§S3)")

    def test_gated_run_without_cycle_flag_sends_no_cycle_key_at_all(self):
        """§S3 guard on the new flag: absent `--cycle` must OMIT `cycleId`,
        never send a null/0 — an absent key is what preserves a pre-registered
        caller's binding (the server's touch-never-blanks contract)."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-056-C5-no-cycle-flag"
        calls = []
        with mock.patch.object(self.module, "_post",
                                side_effect=self._patched_post(calls, registry={agent})):
            self.module.cmd_test(self._test_args(agent))

        self.assertNotIn("cycleId", calls[0][1],
                          f"no --cycle must mean NO cycleId key on the opening "
                          f"heartbeat, got {calls[0][1]}")


if __name__ == "__main__":
    unittest.main()
