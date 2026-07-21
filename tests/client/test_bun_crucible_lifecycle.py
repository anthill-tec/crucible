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
`_post("/api/agents/remove")`). The `--agent` gated-run bracket has since been
redesigned into the documented "v2 model" (see `_remove_agent_silent`'s
docstring in bun-crucible.py verbatim: "Under v2, a gated run needs NO
explicit register: the run's ingest IS the registration (implicit heartbeat —
creates the agent row with NO lifecycle event)."): there is NO separate
`/api/v2/agents/register` POST for a gated `test`/`regression` run — the
ingest call (`/api/v2/runs/parsed`) implicitly registers, and the bracket's
closing half is a SILENT v2 unregister (`/api/v2/agents/unregister` with
`{"silent": true}`, CR-CRU-008 §S4). The pins below are retargeted to that
real two-call (ingest-implicitly-registers → silent-unregister) bracket, plus
the CR-CRU-030 §S9 cycle-resolution precondition that now gates every
`--agent` ingest (see `setUp`). Endpoint literals are also corrected: the
register/unregister verbs live at `/api/v2/agents/register|unregister` (not
the retired `/api/agents/heartbeat|remove` shim), and ingest lives at
`/api/v2/runs/parsed` (not `/api/ingest/*`).

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
    """CR-CRU-021 §S5 — ingest(implicit-register)→silent-unregister bracket for
    `test`/`regression` with `--agent` (the real v2 model — see the module
    docstring's CR-CRU-030 C1 retarget note), asserted via the ONLY HTTP seam
    bun-crucible.py has: `_post`."""

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
        # CR-CRU-030 §S9 — an --agent ingest now resolves a cycle to attach
        # to BEFORE the POST, hard-erroring (no ingest, no bracket) when none
        # can be resolved. This class's tmpdir `.env` project key is not a
        # real UUID, so the auto-resolution GET would 400 server-side; an
        # explicit WORKFLOW_CYCLE_ID override is authoritative and skips that
        # lookup entirely (`_get` stays unmocked — untouched by this CR's
        # bracket pins either way).
        os.environ["WORKFLOW_CYCLE_ID"] = "16"

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # -- Namespace builders (mirrors argparse's `test`/`regression` subparsers) --

    def _test_args(self, agent):
        return argparse.Namespace(
            tests=None,
            agent=agent,
            reports=None,
            bun=self.fake_bun,
            package_dir=self.project_dir,
            project_dir=self.project_dir,
            log=None,
        )

    def _regression_args(self, agent):
        return argparse.Namespace(
            agent=agent,
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

    def _patched_post(self, calls, raise_on_ingest=False):
        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            if raise_on_ingest and path.startswith("/api/v2/runs/"):
                raise RuntimeError("simulated ingest network failure")
            return {"ok": True}
        return fake_post

    # ---- Pin 1: `test --agent X` brackets ingest(implicit-register) -> unregister ----

    def test_test_command_with_agent_ingest_implicitly_registers_then_unregisters(self):
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
        self.assertNotIn("/api/v2/agents/register", paths,
                          "the v2 model has NO separate register POST — the "
                          "ingest itself implicitly registers the agent")

        self.assertEqual(ingest_idx[0], 0,
                          "the ingest (implicit register) must be the FIRST call")
        self.assertEqual(unregister_idx[0], len(calls) - 1,
                          "unregister must be the LAST call made")

        ingest_payload = calls[ingest_idx[0]][1]
        self.assertEqual(ingest_payload.get("agentId"), agent)
        self.assertEqual(ingest_payload.get("summary", {}).get("passed"), 1)
        self.assertEqual(ingest_payload.get("summary", {}).get("failed"), 0)

        self._assert_unregister_payload(calls[unregister_idx[0]][1], agent)

    # ---- Pin 2: `regression --agent X` — identical bracket ----

    def test_regression_command_with_agent_ingest_implicitly_registers_then_unregisters(self):
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
                          "the v2 model has NO separate register POST — the "
                          "ingest itself implicitly registers the agent")

        self.assertEqual(ingest_idx[0], 0,
                          "the ingest (implicit register) must be the FIRST call")
        self.assertEqual(unregister_idx[0], len(calls) - 1,
                          "unregister must be the LAST call made")

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
                         f"a failing test run must still INGEST (implicit "
                         f"register), got paths={paths}")
        self.assertIn("/api/v2/agents/unregister", paths,
                       "a failing test run must still UNREGISTER (unconditional bracket)")
        self.assertTrue(paths[0].startswith("/api/v2/runs/"),
                         "the ingest (implicit register) must be the FIRST call")
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
                         f"a failing regression run must still INGEST (implicit "
                         f"register), got paths={paths}")
        self.assertIn("/api/v2/agents/unregister", paths,
                       "a failing regression run must still UNREGISTER (unconditional bracket)")
        self.assertTrue(paths[0].startswith("/api/v2/runs/"),
                         "the ingest (implicit register) must be the FIRST call")
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
                         "the ingest (implicit register) must fire before it raises")
        self.assertIn("/api/v2/agents/unregister", paths,
                       "unregister must STILL fire despite the ingest exception "
                       "(the bracket is a try/finally, not a try/except-success-only)")
        self.assertEqual(paths[-1], "/api/v2/agents/unregister",
                          "unregister must be the LAST call even after an exception mid-run")


if __name__ == "__main__":
    unittest.main()
