"""The board's settled-run refusals of an abort, read from its own source.

Not a test module: it holds no `TestCase`. Shared by the live-board module
`test_the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end`
(which anchors the rendering on the real board's refusal, byte for byte) and
its board-free sibling
`test_the_board_refuses_a_settled_runs_abort_as_the_clients_expect_end_to_end_without_a_board`
(which matches every rendered wording against the client's pattern).

Every `fail(409, `...`)` template in the abort route's refusers
(`resolveRunClose`, `handleRunAbort`, src/v2.ts) is rendered with a sample run
id, wrapped as the board's `fail` answers it and prefixed as `http_request`
reports an HTTP error.
"""

import json
import re

from tests.client.live_run_harness import REPO_ROOT

HTTP_409 = "HTTP 409: "

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
