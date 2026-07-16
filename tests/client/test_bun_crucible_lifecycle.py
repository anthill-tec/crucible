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

RED phase: as of this writing `cmd_test` (bun-crucible.py:~382) and
`cmd_regression` (bun-crucible.py:~420) never call `_post("/api/agents/heartbeat"
, ...)` or `_post("/api/agents/remove", ...)` at all — the ONLY `_post` call
either makes is the ingest. Every "with --agent" test below therefore fails on
the register/unregister call-count assertions (0 calls found, not 1) — a real
behavioral RED, not a missing-symbol RED.

Technique: this repo's only existing Python client harness
(test_bun_crucible_context.py) loads bun-crucible.py by file path via
importlib (its filename has a hyphen) and exercises a pure helper directly —
it does not fake the Crucible server, because the function it targets
(`_run_context`) never calls `_post`. This file extends that SAME
module-loading technique but additionally patches the module's single HTTP
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

SCRIPT_PATH = Path.home() / ".claude" / "scripts" / "bun-crucible.py"

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
    cannot be `import`ed as a normal module name. Same technique as
    test_bun_crucible_context.py."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test_lifecycle", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GateRunLifecycleBracketTest(unittest.TestCase):
    """CR-CRU-021 §S5 — register→ingest→unregister bracket for `test`/`regression`
    with `--agent`, asserted via the ONLY HTTP seam bun-crucible.py has: `_post`."""

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
        # lifecycle-bracket pins, so keep it deterministically unset (as the
        # sibling harness does) rather than let ambient env leak in.
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

    # -- shape assertions, per cmd_register/cmd_unregister's existing verb shape --

    def _assert_register_payload(self, payload, agent):
        self.assertEqual(payload.get("agentId"), agent)
        self.assertEqual(payload.get("projectKey"), "test-key-123")
        self.assertEqual(payload.get("status"), "online")
        self.assertIsInstance(payload.get("message"), str)
        self.assertGreater(len(payload.get("message") or ""), 0)
        identity = payload.get("identity")
        self.assertIsInstance(identity, dict)
        self.assertEqual(identity.get("displayName"), agent)
        self.assertEqual(identity.get("repoPath"), self.project_dir)
        self.assertIn("source", identity)

    def _assert_unregister_payload(self, payload, agent):
        self.assertEqual(payload.get("agentId"), agent)
        self.assertEqual(payload.get("projectKey"), "test-key-123")
        # negative: an unregister call must NOT carry register-only fields
        self.assertNotIn("status", payload)
        self.assertNotIn("identity", payload)

    def _patched_post(self, calls, raise_on_ingest=False):
        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            if raise_on_ingest and path.startswith("/api/ingest/"):
                raise RuntimeError("simulated ingest network failure")
            return {"ok": True}
        return fake_post

    # ---- Pin 1: `test --agent X` brackets register -> ingest -> unregister ----

    def test_test_command_with_agent_registers_before_ingest_and_unregisters_after(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-021-C16-test-agent"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            rc = self.module.cmd_test(self._test_args(agent))

        self.assertEqual(rc, 0)
        paths = [c[0] for c in calls]
        register_idx = [i for i, p in enumerate(paths) if p == "/api/agents/heartbeat"]
        unregister_idx = [i for i, p in enumerate(paths) if p == "/api/agents/remove"]
        ingest_idx = [i for i, p in enumerate(paths) if p.startswith("/api/ingest/")]

        self.assertEqual(len(register_idx), 1,
                          f"expected exactly ONE register call, got paths={paths}")
        self.assertEqual(len(unregister_idx), 1,
                          f"expected exactly ONE unregister call, got paths={paths}")
        self.assertEqual(len(ingest_idx), 1,
                          f"expected exactly ONE ingest call, got paths={paths}")

        self.assertEqual(register_idx[0], 0, "register must be the FIRST call made")
        self.assertEqual(unregister_idx[0], len(calls) - 1,
                          "unregister must be the LAST call made")
        self.assertLess(register_idx[0], ingest_idx[0], "register must precede the ingest")
        self.assertGreater(unregister_idx[0], ingest_idx[0], "unregister must follow the ingest")

        self._assert_register_payload(calls[register_idx[0]][1], agent)
        self._assert_unregister_payload(calls[unregister_idx[0]][1], agent)

        ingest_payload = calls[ingest_idx[0]][1]
        self.assertEqual(ingest_payload.get("summary", {}).get("passed"), 1)
        self.assertEqual(ingest_payload.get("summary", {}).get("failed"), 0)

    # ---- Pin 2: `regression --agent X` — identical bracket ----

    def test_regression_command_with_agent_registers_before_ingest_and_unregisters_after(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"
        agent = "CR-CRU-021-C16-regression-agent"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            rc = self.module.cmd_regression(self._regression_args(agent))

        self.assertEqual(rc, 0)
        paths = [c[0] for c in calls]
        register_idx = [i for i, p in enumerate(paths) if p == "/api/agents/heartbeat"]
        unregister_idx = [i for i, p in enumerate(paths) if p == "/api/agents/remove"]
        ingest_idx = [i for i, p in enumerate(paths) if p.startswith("/api/ingest/")]

        self.assertEqual(len(register_idx), 1,
                          f"expected exactly ONE register call, got paths={paths}")
        self.assertEqual(len(unregister_idx), 1,
                          f"expected exactly ONE unregister call, got paths={paths}")
        self.assertEqual(len(ingest_idx), 1,
                          f"expected exactly ONE ingest call, got paths={paths}")

        self.assertEqual(register_idx[0], 0, "register must be the FIRST call made")
        self.assertEqual(unregister_idx[0], len(calls) - 1,
                          "unregister must be the LAST call made")
        self.assertLess(register_idx[0], ingest_idx[0], "register must precede the ingest")
        self.assertGreater(unregister_idx[0], ingest_idx[0], "unregister must follow the ingest")

        self._assert_register_payload(calls[register_idx[0]][1], agent)
        self._assert_unregister_payload(calls[unregister_idx[0]][1], agent)

        ingest_payload = calls[ingest_idx[0]][1]
        self.assertEqual(ingest_payload.get("tier"), "regression")
        self.assertEqual(ingest_payload.get("summary", {}).get("passed"), 1)
        self.assertEqual(ingest_payload.get("summary", {}).get("failed"), 0)

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

    def test_test_command_failing_run_still_registers_and_unregisters(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = FAIL_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "1"
        agent = "CR-CRU-021-C16-test-agent-fail"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            self.module.cmd_test(self._test_args(agent))

        paths = [c[0] for c in calls]
        self.assertIn("/api/agents/heartbeat", paths,
                       "a failing test run must still REGISTER")
        self.assertIn("/api/agents/remove", paths,
                       "a failing test run must still UNREGISTER (unconditional bracket)")
        self.assertEqual(paths[0], "/api/agents/heartbeat")
        self.assertEqual(paths[-1], "/api/agents/remove")

        ingest_payload = next(p for path, p in calls if path.startswith("/api/ingest/"))
        self.assertEqual(ingest_payload.get("summary", {}).get("failed"), 1)
        self.assertEqual(ingest_payload.get("summary", {}).get("passed"), 0)

    def test_regression_command_failing_run_still_registers_and_unregisters(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = FAIL_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "1"
        agent = "CR-CRU-021-C16-regression-agent-fail"
        calls = []
        with mock.patch.object(self.module, "_post", side_effect=self._patched_post(calls)):
            self.module.cmd_regression(self._regression_args(agent))

        paths = [c[0] for c in calls]
        self.assertIn("/api/agents/heartbeat", paths,
                       "a failing regression run must still REGISTER")
        self.assertIn("/api/agents/remove", paths,
                       "a failing regression run must still UNREGISTER (unconditional bracket)")
        self.assertEqual(paths[0], "/api/agents/heartbeat")
        self.assertEqual(paths[-1], "/api/agents/remove")

        ingest_payload = next(p for path, p in calls if path.startswith("/api/ingest/"))
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
        self.assertIn("/api/agents/heartbeat", paths,
                       "register must fire before the ingest that later raises")
        self.assertIn("/api/agents/remove", paths,
                       "unregister must STILL fire despite the ingest exception "
                       "(the bracket is a try/finally, not a try/except-success-only)")
        self.assertEqual(paths[-1], "/api/agents/remove",
                          "unregister must be the LAST call even after an exception mid-run")


if __name__ == "__main__":
    unittest.main()
