"""A run's ingest helpers live once, in the shared modules.

The shared modules (`clients/_crucible_axi.py`, the core every client loads,
and `clients/_crucible_run.py`, the run pipeline the core loads and
re-exports) hold the three pieces every client that reaches the shared ingest
needs, once:

  * `filed_run(resp)` (PURE) — the answer's `run` block, `{}` when the run was
    not filed;
  * `COVERAGE_NOT_MEASURED_CODE = "coverage-not-measured"`;
  * `coverage_not_measured_warning(where)` — the warning a `--coverage` run
    carries when it left no coverage report to send.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.unit.test_a_runs_ingest_helpers_live_once_in_the_shared_module
"""

import unittest

from tests.client.live_run_harness import load_client


class TheSharedModuleDefinesTheIngestHelpersOnceTest(unittest.TestCase):
    """Each shared helper does what both clients' copies did."""

    def setUp(self):
        self.axi = load_client("_crucible_axi.py")

    def test_the_coverage_not_measured_code_is_its_warning_code(self):
        self.assertEqual(self.axi.COVERAGE_NOT_MEASURED_CODE, "coverage-not-measured")

    def test_the_coverage_not_measured_warning_names_where_and_says_no_coverage_was_sent(self):
        self.assertEqual(
            self.axi.coverage_not_measured_warning("the runner wrote no lcov.info"),
            {"code": "coverage-not-measured",
             "detail": ("--coverage was requested, and the runner wrote no "
                        "lcov.info: no coverage report was sent, so this run "
                        "is filed with no coverage")})

    def test_the_warning_carries_its_where_and_nothing_else_varies(self):
        first = self.axi.coverage_not_measured_warning("alpha")
        second = self.axi.coverage_not_measured_warning("beta")
        self.assertEqual(sorted(first), ["code", "detail"])
        self.assertEqual(first["detail"].replace("alpha", "beta"), second["detail"])
        self.assertNotIn("alpha", second["detail"])

    def test_filed_run_is_the_answers_run_block(self):
        block = {"passed": 3, "failed": 1, "pending": 1, "total": 5, "files": 2}
        self.assertEqual(self.axi.filed_run({"ok": True, "event": "e", "run": block}),
                         block)

    def test_filed_run_is_empty_when_the_run_was_not_filed(self):
        for case, resp in (("refused", {"ok": False, "error": "nothing was sent"}),
                           ("run not a block", {"ok": True, "run": ["3", "1"]}),
                           ("run null", {"ok": True, "run": None}),
                           ("no answer", None),
                           ("answer not a dict", "HTTP 500")):
            with self.subTest(case=case):
                self.assertEqual(self.axi.filed_run(resp), {})


if __name__ == "__main__":
    unittest.main()
