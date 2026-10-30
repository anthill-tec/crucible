"""The board's refusal of a settled run's abort is the one the clients key on.

When an ingest's connection drops before its answer arrives, the client
aborts the run it opened; a board that already filed the run refuses that
abort with a 409 (`resolveRunClose`, src/v2.ts), and the client recognises
that refusal by its wording (`_SETTLED_ABORT_REFUSAL`, clients/_crucible_run.py)
to say the board may hold the run (`run-may-be-filed`). The pattern is prose
matched across a process boundary: if the board's sentence changes, nothing
breaks loudly; the warning silently degrades to `run-left-open`.

So this module asks a REAL board for that refusal, never a scripted copy of
it: a scratch board (`tests/client/real_board.py`: `bun run src/server.ts` on
an OS-assigned free port over a `mkdtemp` store, never a live board) opens a
run, files it through `POST /api/v2/runs`, and is then asked to abort it.
The answer goes through the clients' own transport (`http_request`, reached
through a client's `_axi()`), so the error text compared is the text
`abort_run` sees.

The board has TWO ways to refuse the abort of a settled run: the run-close
check every ingest shares (`resolveRunClose`, src/v2.ts: the run "is already
<state>"), and the abort's own (`handleRunAbort`, src/v2.ts: the run "settled
before it could be aborted"), which a board that files the run while the
connection drops answers when the abort races the ingest's settlement. A
scratch board cannot be made to lose that race on demand, so the second
wording is read from the board's source: every `fail(409, `...`)` template in
those two functions is rendered with a sample run id, wrapped as the board's
`fail` answers it and prefixed as `http_request` reports an HTTP error, and
the client's pattern must match each. The extraction is anchored: the first
wording, rendered the same way, must equal the live board's own refusal byte
for byte, so a rendering that drifts from what the board sends fails there.

Invocation:
    python3 clients/python-crucible.py test \
        --tests tests.client.test_the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end
"""

import json
import re
import shutil
import unittest

from tests.client.live_run_harness import load_client
from tests.client.real_board import REPO_ROOT, RealBoard

AGENT = "settled-abort-refusal-reporter"
STACK = "python"
ABORT_REASON = "the ingest's connection was lost before the board answered"
HTTP_409 = "HTTP 409: "

# One passing case: enough for the board to file the run, and so settle it.
_JUNIT = ('<?xml version="1.0" encoding="UTF-8"?>\n'
          '<testsuite name="settled_probe.SettledProbeCase" tests="1" '
          'errors="0" failures="0" skipped="0">'
          '<testcase classname="settled_probe.SettledProbeCase" '
          'name="test_the_run_is_filed" time="0.001"></testcase>'
          '</testsuite>\n')

_BOARD = None

# ── the board's settled-run refusals, read from its own source ─────────────

V2_SOURCE = REPO_ROOT / "src" / "v2.ts"
STORE_SOURCE = REPO_ROOT / "src" / "store.ts"
# The functions on the abort route that refuse a run no longer open.
ABORT_REFUSERS = ("resolveRunClose", "handleRunAbort")
SAMPLE_RUN_ID = "run-0f9e8d7c-sample"

# `fail(409, `...`)`, the call split across lines or not; the templates on
# this route hold no backtick of their own.
_FAIL_409 = re.compile(r"\bfail\(\s*409\s*,\s*`([^`]*)`")
_PLACEHOLDER = re.compile(r"\$\{([^}]*)\}")


def _function_body(source, name):
    """The text of the top-level `function <name>(` in `source`, from its
    signature to the brace that closes it at column 0 (the formatter's layout
    for a top-level function)."""
    start = re.search(rf"^(?:export )?(?:async )?function {name}\(", source, re.M)
    if start is None:
        raise AssertionError(f"src/v2.ts defines no top-level function {name}")
    end = source.find("\n}\n", start.start())
    if end < 0:
        raise AssertionError(f"{name} in src/v2.ts has no closing brace at column 0")
    return source[start.start():end + 2]


def _settled_states():
    """Every state a run can be in other than `open`, as `RunState`
    (src/store.ts) declares them."""
    found = re.search(r"\bexport type RunState\s*=\s*([^;]+);",
                      STORE_SOURCE.read_text(encoding="utf-8"))
    if found is None:
        raise AssertionError("src/store.ts declares no `RunState` type")
    return [state for state in re.findall(r'"([^"]+)"', found.group(1))
            if state != "open"]


def _abort_outcome(abort_body):
    """The outcome `handleRunAbort` hands `resolveRunClose`: its refusals'
    closing words."""
    found = re.search(r'\bresolveRunClose\([^;]*?,\s*"([^"]*)"\s*\)', abort_body)
    if found is None:
        raise AssertionError("handleRunAbort no longer passes resolveRunClose an outcome")
    return found.group(1)


def _render(template, values):
    """`template` with each `${...}` replaced from `values`; an expression the
    test has no value for is a loud failure, never a guess."""
    if "\\" in template:
        raise AssertionError(f"the template carries an escape to decode: {template!r}")

    def value(match):
        expression = match.group(1).strip()
        if expression not in values:
            raise AssertionError(
                f"the board's refusal interpolates `{expression}`, which this "
                f"test cannot render: {template!r}")
        return values[expression]

    return _PLACEHOLDER.sub(value, template)


def as_transport_error(message):
    """`message` as the client's transport reports the board's 409: `fail`'s
    `{ok: false, error}` body as the board serialises it, after `HTTP 409: `."""
    body = json.dumps({"ok": False, "error": message}, ensure_ascii=False,
                      separators=(",", ":"))
    return HTTP_409 + body


def settled_run_refusal_templates():
    """`{function: [template, ...]}`: each `fail(409, ...)` template the abort
    route's refusers hold."""
    source = V2_SOURCE.read_text(encoding="utf-8")
    return {name: _FAIL_409.findall(_function_body(source, name))
            for name in ABORT_REFUSERS}


def rendered_settled_run_refusals(run_id=SAMPLE_RUN_ID):
    """`[(label, transport error)]`: every settled-run refusal the board can
    give an abort of `run_id`, a wording that names the run's state rendered
    once per settled state."""
    source = V2_SOURCE.read_text(encoding="utf-8")
    outcome = _abort_outcome(_function_body(source, "handleRunAbort"))
    refusals = []
    for name, templates in settled_run_refusal_templates().items():
        for template in templates:
            states = (_settled_states() if "${run.state}" in template
                      else [None])
            for state in states:
                message = _render(template, {"runId": run_id,
                                             "run.state": state,
                                             "outcome": outcome})
                label = name if state is None else f"{name}, run {state}"
                refusals.append((label, as_transport_error(message)))
    return refusals


def setUpModule():
    global _BOARD
    bun = shutil.which("bun")
    if bun is None:
        # Not a skip: this module is the only guard on the board's wording,
        # and a guard that quietly stands down guards nothing.
        raise RuntimeError(
            "the refusal is read from a REAL board, and without `bun` there "
            "is none to boot")
    _BOARD = RealBoard(bun, "settled-abort-refusal")


def tearDownModule():
    global _BOARD
    if _BOARD is not None:
        _BOARD.close()
        _BOARD = None


class TheBoardRefusesASettledRunsAbortAsTheClientsExpectTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if _BOARD is None:
            raise AssertionError("the module's real board was never booted")
        cls.board = _BOARD
        reg = cls.board.http("/api/v2/agents/register",
                             {"projectKey": cls.board.key, "agentId": AGENT,
                              "role": "report"})
        assert reg.get("ok"), f"agent registration failed: {reg!r}"
        cls.core = load_client("python-crucible.py")._axi()

    # ── the board, through the clients' own transport ───────────────────────

    def post(self, path, payload):
        return self.core.http_request(self.board.base, "POST", path, payload)

    def open_run(self):
        started = self.post(self.core.RUN_START_PATH,
                            {"projectKey": self.board.key, "agentId": AGENT,
                             "stack": STACK})
        self.assertTrue(started.get("ok"), f"the run did not open: {started!r}")
        run_id = started.get("runId")
        self.assertIsInstance(run_id, str)
        return run_id

    def settled_run(self):
        """A run the board opened and then filed: settled, as a run is when
        its ingest reached the board and only the answer was lost."""
        run_id = self.open_run()
        filed = self.post("/api/v2/runs",
                          {"projectKey": self.board.key, "agentId": AGENT,
                           "stack": STACK, "codec": "junit", "data": [_JUNIT],
                           "runId": run_id})
        self.assertTrue(filed.get("ok"), f"the run was not filed: {filed!r}")
        self.assertEqual((filed.get("run") or {}).get("passed"), 1,
                         f"the board filed the one passing case: {filed!r}")
        return run_id

    def abort(self, run_id):
        return self.post(self.core.run_abort_path(run_id),
                         {"projectKey": self.board.key, "agentId": AGENT,
                          "reason": ABORT_REASON})

    # ── the refusal ─────────────────────────────────────────────────────────

    def test_the_boards_refusal_of_a_settled_runs_abort_matches_the_clients_pattern(self):
        run_id = self.settled_run()
        refused = self.abort(run_id)
        self.assertIs(refused.get("ok"), False,
                      f"the board refuses the abort of a filed run: {refused!r}")
        error = refused.get("error")
        self.assertIsInstance(error, str)
        self.assertTrue(error.startswith(HTTP_409),
                        f"a settled run's abort is refused 409: {error!r}")
        self.assertIn(f"run {run_id}", error)
        self.assertIsNotNone(
            self.core._SETTLED_ABORT_REFUSAL.search(error),
            f"the client's settled-abort pattern "
            f"{self.core._SETTLED_ABORT_REFUSAL.pattern!r} no longer matches "
            f"the board's refusal {error!r}, so a run the board may hold "
            f"would be reported left open")

    def test_a_lost_answer_whose_abort_finds_the_run_filed_says_the_board_may_hold_it(self):
        run_id = self.settled_run()
        warning = self.core.abort_run(self.post, self.board.key, AGENT, run_id,
                                      ABORT_REASON, answer_lost=True)
        self.assertEqual(warning.get("code"), self.core.RUN_MAY_BE_FILED_CODE,
                         f"the real board's refusal reads as a run it may "
                         f"hold: {warning!r}")
        self.assertNotEqual(warning.get("code"), self.core.RUN_LEFT_OPEN_CODE)
        self.assertIn(f"`run {run_id}`", warning.get("detail") or "")

    # ── what the pattern must not take for it ───────────────────────────────

    def test_the_settled_run_refusal_rendered_from_source_is_the_live_boards_byte_for_byte(self):
        run_id = self.settled_run()
        refused = self.abort(run_id)
        rendered = dict(rendered_settled_run_refusals(run_id))
        self.assertEqual(refused.get("error"),
                         rendered.get("resolveRunClose, run ended"),
                         "the refusal rendered from src/v2.ts is the one the "
                         "board sends for a filed run's abort")

    def test_the_boards_refusal_of_a_never_opened_runs_abort_does_not_match(self):
        refused = self.abort("run-never-opened")
        error = refused.get("error")
        self.assertIs(refused.get("ok"), False, f"{refused!r}")
        self.assertIsInstance(error, str)
        self.assertTrue(error.startswith("HTTP 400: "),
                        f"an unknown run's abort is refused 400: {error!r}")
        self.assertIsNone(self.core._SETTLED_ABORT_REFUSAL.search(error),
                          f"an unknown run is not a settled one: {error!r}")

    def test_the_abort_of_a_run_still_open_is_taken_not_refused(self):
        run_id = self.open_run()
        taken = self.abort(run_id)
        self.assertTrue(taken.get("ok"), f"an open run's abort is taken: {taken!r}")
        self.assertEqual(taken.get("status"), "aborted")
        self.assertEqual(taken.get("runId"), run_id)


class EverySettledRunRefusalOfAnAbortIsRecognisedTest(unittest.TestCase):
    """Each wording the board can refuse a settled run's abort with, read
    from its source, is one the client's pattern recognises."""

    @classmethod
    def setUpClass(cls):
        cls.core = load_client("python-crucible.py")._axi()

    def test_each_abort_refuser_holds_exactly_one_settled_run_refusal(self):
        counts = {name: len(templates)
                  for name, templates in settled_run_refusal_templates().items()}
        self.assertEqual(counts, {"resolveRunClose": 1, "handleRunAbort": 1},
                         "a 409 added to or removed from the abort route must "
                         "be classified here as a settled-run refusal or not")

    def test_each_settled_run_refusal_the_board_can_give_an_abort_matches_the_clients_pattern(self):
        refusals = rendered_settled_run_refusals()
        self.assertEqual([label for label, _ in refusals],
                         [f"resolveRunClose, run {state}" for state in _settled_states()]
                         + ["handleRunAbort"],
                         f"each refusal, once per state it names: {refusals!r}")
        for label, error in refusals:
            with self.subTest(refusal=label):
                self.assertIn(f"run {SAMPLE_RUN_ID}", error)
                self.assertIsNotNone(
                    self.core._SETTLED_ABORT_REFUSAL.search(error),
                    f"the client's settled-abort pattern "
                    f"{self.core._SETTLED_ABORT_REFUSAL.pattern!r} does not "
                    f"match the board's refusal {error!r}, so a run the board "
                    f"may hold would be reported left open")


if __name__ == "__main__":
    unittest.main()
