"""CR-CRU-019 §P1 AC-2 — CLIENT contract: bun-crucible.py's env + git → run
context helper, `_run_context()`.

This is the CLIENT half of the §P1 "declared linkage last-mile" fix — the
SERVER half (v1 shim context passthrough) is pinned in
tests/shim-ingest-events.test.ts, and the dog-food integration proof (AC-3)
in tests/timeline-dogfood-linkage.test.ts. bun-crucible.py is a Python CLI
that lives OUTSIDE this bun package's `bun test` reach entirely (it is the
project-agnostic client script at ~/.claude/scripts/bun-crucible.py, shared
across every bun-based project this Crucible instance serves) — hence this
stdlib-only pytest/unittest file rather than a `.test.ts`.

Per CR-CRU-019-patch-workflow-tweaks.md §P1 item 2: `test`/`regression`
attach `context.cycleId` from WORKFLOW_CYCLE_ID, `context.cycle` from
WORKFLOW_CYCLE, and `context.git {branch, commit}` from a cheap `git
rev-parse` when inside a repo. The dispatch prompt names the refactor
target precisely: a PURE helper `_run_context()` — env + git in, a context
dict (or None) out — so this file tests exactly that function in isolation,
without invoking the CLI or any subprocess/network mocking gymnastics.

RED phase: bun-crucible.py does not define `_run_context` at all today
(confirmed: `grep -n "_run_context" ~/.claude/scripts/bun-crucible.py` finds
nothing). Every test below fails with AttributeError on
`self.module._run_context` — a missing-symbol reference, which is a valid
RED per the CR-CRU-019 RED-agent dispatch instructions.

Invocation:
    python3 -m pytest tests/client/ -q          (run from the repo root)
Fallback if pytest is unavailable on a given machine:
    python3 tests/client/test_bun_crucible_context.py
(this file's __main__ block uses plain unittest so both invocations work).
"""

import importlib.util
import os
import subprocess
import unittest
from pathlib import Path

SCRIPT_PATH = Path.home() / ".claude" / "scripts" / "bun-crucible.py"


def _load_bun_crucible_module():
    """Load bun-crucible.py by file path — its filename has a hyphen, so it
    cannot be `import`ed as a normal module name."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("bun_crucible_under_test", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _real_git_branch_and_commit():
    """The ACTUAL branch/commit of the repo this test runs in (the crucible
    project itself) — used to assert `_run_context()`'s git sub-object
    against real state, never a guessed/hardcoded value."""
    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return branch, commit


class RunContextHelperContractTest(unittest.TestCase):
    ENV_KEYS = ("WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_workflow_cycle_env_set_inside_a_repo_returns_cycleId_cycle_and_git(self):
        os.environ["WORKFLOW_CYCLE_ID"] = "3"
        os.environ["WORKFLOW_CYCLE"] = "x"

        result = self.module._run_context()

        self.assertIsInstance(result, dict)
        # cycleId must be coerced to a real int (env vars are always
        # strings) — the server-side contract types this as `number`
        # (src/types.ts RunContext.cycleId?: number), never a string "3".
        self.assertEqual(result.get("cycleId"), 3)
        self.assertIsInstance(result.get("cycleId"), int)
        self.assertEqual(result.get("cycle"), "x")

        real_branch, real_commit = _real_git_branch_and_commit()
        self.assertIn("git", result)
        self.assertIsInstance(result["git"], dict)
        self.assertEqual(result["git"].get("branch"), real_branch)
        returned_commit = result["git"].get("commit")
        self.assertIsInstance(returned_commit, str)
        self.assertGreater(len(returned_commit), 0)
        # tolerate either a short or full hash — whichever GREEN picks —
        # but it MUST be a real prefix of the real HEAD commit, not a
        # fabricated value.
        self.assertTrue(
            real_commit.startswith(returned_commit),
            f"returned commit {returned_commit!r} is not a prefix of the real HEAD {real_commit!r}",
        )

    def test_workflow_cycle_env_unset_returns_none(self):
        os.environ.pop("WORKFLOW_CYCLE_ID", None)
        os.environ.pop("WORKFLOW_CYCLE", None)

        result = self.module._run_context()

        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
