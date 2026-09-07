"""CR-CRU-017 §S4 (cycle 227 / C3) — CLIENT contract: the bun client WRAPS a
real run in the run lifecycle.

Contract pinned VERBATIM from docs/changes/CR-CRU-017-run-lifecycle.md §S4:

    "The upgraded scripts wrap execution automatically: `run-start` before
    spawning the tool, end-with-runId on ingest, `run-abort --reason` on
    timeout/signal (trap SIGINT/SIGTERM); `--no-lifecycle` opt-out preserves
    single-shot behavior."

and its acceptance-criteria line:

    "Client: the wrapped script emits start->end around a real run
    (runtime_ms > duration_ms asserted); killing the tool mid-run produces an
    aborted event with the signal reason; `--no-lifecycle` produces a
    single-shot event."

SCOPE NOTE — why the signal path posts NOTHING here. The abort ROUTE
(`POST /api/v2/runs/<id>/abort`) is §S2 and does NOT exist yet; §S1 (already
on this branch) ships the server-side auto-abort instead: an open run is
settled with reason `agent died` the moment its agent tombstones, and with
reason `abandoned` once it is older than `CRUCIBLE_RUN_ABANDON_MS`. So this
cycle's client obligation on SIGINT/SIGTERM is exactly three things — stop
cleanly, invent NO abort call, and SAY in the envelope that the open run was
left to the server's own auto-abort — which is what the signal tests below
pin. A client-side `/abort` POST appearing here would be a FAILURE, not an
improvement: it would be a fabricated route.

RED phase (confirmed by reading clients/bun-crucible.py at HEAD of
feature/CR-CRU-017-run-lifecycle): the client has no lifecycle bracket at all.
`cmd_test`/`cmd_regression` spawn the runner and POST one single-shot ingest;
there is no `/api/v2/runs/start` call, no `runId` on the ingest body, no
`--no-lifecycle` flag (argparse rejects it outright), no 404 degradation
warning and no SIGINT/SIGTERM trap (a SIGTERM mid-run kills the process dead,
leaving an open run and no envelope at all).

Server/HTTP isolation, per project convention (see the sibling
test_bun_crucible_lifecycle.py / test_bun_crucible_auto_attach.py harnesses):
the LIVE Crucible server on :3849 is NEVER touched. Every HTTP call goes
through the module's own `_post`/`_get` seam, mocked here by an in-process
fake server that models the §S1 run lifecycle (start issues a runId and
stamps `startedAt`; an ingest carrying that runId closes it and computes
`runtime_ms = endedAt - startedAt`). Nothing binds a port and nothing is
ingested anywhere.

WALL-CLOCK FIXTURE — how `runtime_ms > duration_ms` is made PROVABLE rather
than flaky: the fake `bun` executable sleeps `FAKE_BUN_SLEEP_MS` (250 ms)
before it writes its JUnit report, and that report declares a single testcase
with `time="0.001"` — a tool-reported `duration_ms` of exactly 1. The wrapped
span therefore contains a ~250 ms sleep that the tool's own number cannot
possibly account for, so the assertion is `runtime_ms >= 250 > duration_ms ==
1` with a ~249 ms margin, not a race on scheduler noise.
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "clients" / "bun-crucible.py"

# One testcase, `time="0.001"` -> the tool-reported duration_ms is exactly 1.
PASS_JUNIT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="lifecycle.test.ts" tests="1" failures="0">
<testcase name="passes" file="src/lifecycle.test.ts" time="0.001"></testcase>
</testsuite>
</testsuites>
"""

TOOL_DURATION_MS = 1
FAKE_BUN_SLEEP_MS = 250

# The fake `bun`. Three fixture knobs beyond the sibling harnesses' two:
#   FAKE_BUN_SLEEP_MS   sleep this long BEFORE writing the report, so the
#                       wrapped wall-clock span provably exceeds the report's
#                       own `time=` figure;
#   FAKE_BUN_SIGNAL     send this signal to the PARENT (the client process)
#                       mid-run and then hang, modelling a real Ctrl-C / kill
#                       arriving while the tool is still running. No report is
#                       written on this path -- an interrupted run has none;
#   FAKE_BUN_SPAWN_STAMP  a path this process writes `time.time()` into the
#                       instant it starts, so a test can prove the run-start
#                       POST happened BEFORE the tool was spawned.
FAKE_BUN_SCRIPT_TEMPLATE = """#!{python}
import os
import signal
import sys
import time

stamp = os.environ.get("FAKE_BUN_SPAWN_STAMP")
if stamp:
    with open(stamp, "w") as f:
        f.write(repr(time.time()))

# Real runner output — captured by `_run_logged` and carried onto the ingest
# as `raw`, so the single-shot key-set pin below reflects a realistic body.
sys.stdout.write("running lifecycle.test.ts\\n")
sys.stdout.flush()

sig = os.environ.get("FAKE_BUN_SIGNAL")
if sig:
    os.kill(os.getppid(), getattr(signal, sig))
    # The parent must act on the signal; it kills this child as it unwinds.
    time.sleep(30)
    sys.exit(1)

sleep_ms = int(os.environ.get("FAKE_BUN_SLEEP_MS", "0"))
if sleep_ms:
    time.sleep(sleep_ms / 1000.0)

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
    """Load clients/bun-crucible.py by file path (its filename has a hyphen).
    The in-repo SOURCE OF TRUTH, never the deployed ~/.claude/scripts mirror —
    same technique as every sibling client harness in this directory."""
    if not SCRIPT_PATH.exists():
        raise unittest.SkipTest(f"bun-crucible.py not found at {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location(
        "bun_crucible_under_test_cr017", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke module.main() with sys.argv patched. Returns (code, out, err).
    Only SystemExit is caught — any other exception propagates so unittest
    reports it as an ERROR (still a valid RED signal)."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["bun-crucible.py"] + argv):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                if e.code is None:
                    code = 0
                elif isinstance(e.code, int):
                    code = e.code
                else:
                    code = 1
    return code, stdout.getvalue(), stderr.getvalue()


class _FakeCrucible:
    """An in-process stand-in for the §S1 run-lifecycle server. Models exactly
    the three things this CR's client contract depends on: run-start issues a
    runId and remembers `startedAt`; an ingest carrying that runId CLOSES the
    run and computes `runtime_ms = endedAt - startedAt`; an ingest without one
    is the unchanged single-shot store. `start_status` lets a test model an
    OLDER server whose /runs/start route does not exist (the `_crucible_axi`
    HTTP layer renders a 404 as `{ok: False, error: "HTTP 404: ..."}`)."""

    def __init__(self, start_response=None):
        self.calls = []                 # [(path, payload)] in wire order
        self.start_wall = None          # time.time() when /runs/start ran
        self.runs = {}                  # runId -> startedAt (epoch ms)
        self.events = []                # the CLOSED runs, as the store sees them
        self._start_response = start_response
        self._next_run = 0

    def post(self, path, payload):
        self.calls.append((path, json.loads(json.dumps(payload))))
        if path in ("/api/v2/agents/heartbeat", "/api/v2/agents/register",
                    "/api/v2/agents/unregister"):
            return {"ok": True, "changed": True}
        if path == "/api/v2/runs/start":
            if self._start_response is not None:
                return dict(self._start_response)
            self._next_run += 1
            run_id = f"run-cr017-{self._next_run}"
            self.start_wall = time.time()
            self.runs[run_id] = int(self.start_wall * 1000)
            return {"ok": True, "changed": True, "runId": run_id,
                    "startedAt": self.runs[run_id]}
        if path in ("/api/v2/runs/parsed", "/api/v2/runs", "/api/v2/runs/compile"):
            event = {"path": path, "payload": payload}
            run_id = payload.get("runId")
            if run_id is not None:
                if run_id not in self.runs:
                    return {"ok": False, "error": f"unknown runId: {run_id}"}
                started_at = self.runs.pop(run_id)
                event["startedAt"] = started_at
                event["runtime_ms"] = int(time.time() * 1000) - started_at
            self.events.append(event)
            return {"ok": True}
        return {"ok": False, "error": f"unhandled POST {path}"}

    # -- read helpers -------------------------------------------------------

    def paths(self):
        return [p for p, _ in self.calls]

    def payload_for(self, path):
        for p, payload in self.calls:
            if p == path:
                return payload
        return None

    def index_of(self, path):
        for i, (p, _) in enumerate(self.calls):
            if p == path:
                return i
        return None


class _UntrappedSignal(Exception):
    """Raised by the test's OWN outer handler when the client failed to trap a
    signal itself. Without this guard an untrapped SIGTERM would kill the whole
    unittest process (destroying the run rather than reporting a failure), so
    the RED signal is turned into an ordinary, legible assertion failure."""


class _BaseCr017ClientTest(unittest.TestCase):
    PROJECT_KEY = "test-key-cr017-lifecycle"
    AGENT = "cr017-clients-fixture"
    ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE",
                "FAKE_BUN_JUNIT_CONTENT", "FAKE_BUN_EXIT_CODE",
                "FAKE_BUN_SLEEP_MS", "FAKE_BUN_SIGNAL", "FAKE_BUN_SPAWN_STAMP",
                "BUN_CRUCIBLE_NO_LIFECYCLE")

    def setUp(self):
        self.module = _load_bun_crucible_module()
        self.toon = self.module._toon()
        self.tmpdir = tempfile.mkdtemp(prefix="bun-crucible-cr017-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as f:
            f.write(f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
        self._saved_env = {k: os.environ.get(k) for k in self.ENV_KEYS}
        for k in self.ENV_KEYS:
            os.environ.pop(k, None)
        self.fake_bun = os.path.join(self.tmpdir, "fake_bun.py")
        with open(self.fake_bun, "w") as f:
            f.write(FAKE_BUN_SCRIPT_TEMPLATE.format(python=sys.executable))
        os.chmod(self.fake_bun, 0o755)
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = PASS_JUNIT_XML
        os.environ["FAKE_BUN_EXIT_CODE"] = "0"

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # -- drivers ------------------------------------------------------------

    def _run_test_verb(self, server, extra_argv=()):
        """Drive the REAL CLI dispatch (argparse -> cmd_test) against `server`.
        `_get` is mocked to a tolerant failure so nothing reaches :3849."""
        argv = ["test", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
                "--agent", self.AGENT] + list(extra_argv)
        with mock.patch.object(self.module, "_post", side_effect=server.post), \
             mock.patch.object(self.module, "_get", create=True,
                               return_value={"ok": False, "error": "mocked"}):
            return _run_main(self.module, argv)

    def _run_regression_verb(self, server, extra_argv=()):
        argv = ["regression", "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
                "--agent", self.AGENT] + list(extra_argv)
        with mock.patch.object(self.module, "_post", side_effect=server.post), \
             mock.patch.object(self.module, "_get", create=True,
                               return_value={"ok": False, "error": "mocked"}):
            return _run_main(self.module, argv)

    # -- assertions ---------------------------------------------------------

    def _decode_axi(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIn("axi", decoded,
                      f"stdout must decode to a TOON envelope with a top-level "
                      f"'axi' key; got stdout={stdout_text!r}")
        return decoded["axi"]

    def _assert_toon_axi_shaped(self, stdout_text, verb, where):
        """The §S1 envelope invariants every path must keep: exactly one TOON
        document on stdout, carrying verb / ok / context.projectKey and a
        warnings[] of {code, detail} dicts."""
        axi = self._decode_axi(stdout_text)
        self.assertEqual(axi.get("verb"), verb,
                         f"{where}: the envelope must speak under the invoked "
                         f"verb; got {axi.get('verb')!r}")
        self.assertIsInstance(axi.get("ok"), bool,
                              f"{where}: `ok` must be a bool; got {axi.get('ok')!r}")
        context = axi.get("context")
        self.assertIsInstance(context, dict, f"{where}: context must be an object")
        self.assertEqual(context.get("projectKey"), self.PROJECT_KEY,
                         f"{where}: the envelope context must carry the project key")
        warnings = axi.get("warnings")
        self.assertIsInstance(warnings, list,
                              f"{where}: warnings must be a list; got {warnings!r}")
        for w in warnings:
            self.assertIsInstance(w, dict, f"{where}: each warning is an object")
            self.assertIn("code", w, f"{where}: each warning names a code")
            self.assertIn("detail", w, f"{where}: each warning carries a detail")
        return axi

    def _warning_codes(self, axi):
        return [w.get("code") for w in axi.get("warnings") or []]

    def _warning_text(self, axi):
        return " ".join(f"{w.get('code')} {w.get('detail')}"
                        for w in axi.get("warnings") or [])


class WrappedRunOpensTheRunBeforeSpawningTheToolTest(_BaseCr017ClientTest):
    """§S4 pin 1 — `run-start` BEFORE spawning the tool, end-with-runId on the
    ingest. Both halves are asserted: the WIRE ORDER of the two POSTs, and the
    wall-clock proof that the start landed before the tool process even began
    (the fake bun stamps its own start time on disk)."""

    def test_run_start_precedes_the_spawn_and_the_ingest_carries_its_run_id(self):
        stamp = os.path.join(self.tmpdir, "spawn-stamp")
        os.environ["FAKE_BUN_SPAWN_STAMP"] = stamp
        server = _FakeCrucible()

        code, out, _err = self._run_test_verb(server)

        self.assertEqual(code, 0, f"a green wrapped run exits 0; stdout={out!r}")
        start_idx = server.index_of("/api/v2/runs/start")
        ingest_idx = server.index_of("/api/v2/runs/parsed")
        self.assertIsNotNone(
            start_idx,
            f"a wrapped run must POST /api/v2/runs/start; got paths={server.paths()}")
        self.assertIsNotNone(
            ingest_idx,
            f"the wrapped run must still ingest; got paths={server.paths()}")
        self.assertLess(
            start_idx, ingest_idx,
            f"the run must be OPENED before it is closed; paths={server.paths()}")

        self.assertTrue(os.path.exists(stamp), "the fake bun must have spawned")
        with open(stamp) as f:
            spawned_at = float(f.read())
        self.assertIsNotNone(server.start_wall, "the fake server must have opened a run")
        self.assertLessEqual(
            server.start_wall, spawned_at,
            "the run-start POST must land BEFORE the tool process starts — that "
            "is the whole point of the lifecycle (queue + spawn time is inside "
            "the measured span)")

        start_payload = server.payload_for("/api/v2/runs/start")
        self.assertEqual(start_payload.get("projectKey"), self.PROJECT_KEY)
        self.assertEqual(start_payload.get("agentId"), self.AGENT)

        run_id = server.events[0]["payload"].get("runId")
        self.assertEqual(
            run_id, "run-cr017-1",
            f"the ingest body must carry the runId the server issued; got "
            f"payload keys={sorted(server.events[0]['payload'])!r}")
        self.assertEqual(server.runs, {},
                         "ingesting with the runId must CLOSE the open run")

    def test_regression_verb_wraps_its_run_identically(self):
        server = _FakeCrucible()

        code, out, _err = self._run_regression_verb(server)

        self.assertEqual(code, 0, f"stdout={out!r}")
        self.assertIn("/api/v2/runs/start", server.paths(),
                      f"`regression` wraps its run too; paths={server.paths()}")
        self.assertEqual(server.payload_for("/api/v2/runs/parsed").get("runId"),
                         "run-cr017-1")


class WrappedRunRuntimeExceedsToolDurationTest(_BaseCr017ClientTest):
    """§S4 AC — "runtime_ms > duration_ms asserted". The fixture makes it
    provable rather than lucky: the tool sleeps 250 ms and then reports a
    1 ms testcase, so the server-computed wall-clock span must exceed the
    tool's own figure by ~249 ms."""

    def test_server_computed_runtime_ms_exceeds_the_tool_reported_duration_ms(self):
        os.environ["FAKE_BUN_SLEEP_MS"] = str(FAKE_BUN_SLEEP_MS)
        server = _FakeCrucible()

        code, out, _err = self._run_test_verb(server)

        self.assertEqual(code, 0, f"stdout={out!r}")
        self.assertEqual(len(server.events), 1, "exactly one run event is stored")
        event = server.events[0]
        self.assertIn(
            "runtime_ms", event,
            f"the ingest must have CLOSED an open run (no runId reached the "
            f"server, so nothing computed a runtime); payload keys="
            f"{sorted(event['payload'])!r}")
        duration_ms = event["payload"]["summary"]["duration_ms"]
        self.assertEqual(duration_ms, TOOL_DURATION_MS,
                         "fixture guard: the tool reports exactly 1 ms")
        self.assertGreaterEqual(
            event["runtime_ms"], FAKE_BUN_SLEEP_MS,
            f"the wrapped span must contain the tool's {FAKE_BUN_SLEEP_MS} ms "
            f"sleep; got runtime_ms={event['runtime_ms']}")
        self.assertGreater(
            event["runtime_ms"], duration_ms,
            f"runtime_ms ({event['runtime_ms']}) must exceed the tool-reported "
            f"duration_ms ({duration_ms}) — the lifecycle exists to measure the "
            f"time the tool's own number cannot see")


class NoLifecycleOptOutIsSingleShotTest(_BaseCr017ClientTest):
    """§S4 — "`--no-lifecycle` opt-out preserves single-shot behavior". Not
    merely "no runId": NO start call at all, and an ingest body whose key set
    is exactly the pre-CR one."""

    # The pre-CR single-shot `/api/v2/runs/parsed` body for a gated `test` run
    # with no coverage: projectKey, agentId, summary, tree, tier, raw. (`context`
    # is omitted when no WORKFLOW_* env is set — `_run_context()` returns None.)
    SINGLE_SHOT_KEYS = {"projectKey", "agentId", "summary", "tree", "tier", "raw"}

    def test_no_lifecycle_flag_makes_no_start_call_and_sends_no_run_id(self):
        server = _FakeCrucible()

        code, out, _err = self._run_test_verb(server, ["--no-lifecycle"])

        self.assertEqual(code, 0, f"stdout={out!r}")
        self.assertNotIn(
            "/api/v2/runs/start", server.paths(),
            f"--no-lifecycle must make NO run-start call at all; "
            f"paths={server.paths()}")
        payload = server.payload_for("/api/v2/runs/parsed")
        self.assertIsNotNone(payload, "the single-shot ingest must still happen")
        self.assertNotIn(
            "runId", payload,
            f"the single-shot body must carry no runId; got keys={sorted(payload)!r}")
        self.assertEqual(
            set(payload), self.SINGLE_SHOT_KEYS,
            f"--no-lifecycle must be BYTE-IDENTICAL to today's single-shot "
            f"ingest — no added and no dropped field; got keys={sorted(payload)!r}")
        self.assertEqual(server.events[0].get("runtime_ms"), None,
                         "a single-shot event carries no lifecycle fields")

    def test_env_opt_out_is_the_flags_twin(self):
        os.environ["BUN_CRUCIBLE_NO_LIFECYCLE"] = "1"
        server = _FakeCrucible()

        code, out, _err = self._run_test_verb(server)

        self.assertEqual(code, 0, f"stdout={out!r}")
        self.assertNotIn(
            "/api/v2/runs/start", server.paths(),
            f"$BUN_CRUCIBLE_NO_LIFECYCLE=1 opts out exactly like the flag; "
            f"paths={server.paths()}")
        self.assertNotIn("runId", server.payload_for("/api/v2/runs/parsed"))

    def test_regression_honours_the_opt_out_too(self):
        server = _FakeCrucible()

        code, out, _err = self._run_regression_verb(server, ["--no-lifecycle"])

        self.assertEqual(code, 0, f"stdout={out!r}")
        self.assertNotIn("/api/v2/runs/start", server.paths())
        self.assertNotIn("runId", server.payload_for("/api/v2/runs/parsed"))


class OlderServerDegradesToSingleShotTest(_BaseCr017ClientTest):
    """§S1's "graceful degradation is sacred", applied at the CLIENT: a server
    that predates /runs/start answers 404, and that must cost the caller
    nothing but a warning naming the fallback."""

    NOT_FOUND = {"ok": False,
                 "error": "HTTP 404: not found: POST /api/v2/runs/start"}

    def test_404_on_run_start_still_ingests_single_shot_and_warns(self):
        server = _FakeCrucible(start_response=self.NOT_FOUND)

        code, out, err = self._run_test_verb(server)

        self.assertEqual(
            code, 0,
            f"an older server must not break the client — the run still "
            f"ingests and the verb still succeeds; stdout={out!r} stderr={err!r}")
        self.assertIn("/api/v2/runs/start", server.paths(),
                      "the client tries the lifecycle before degrading")
        payload = server.payload_for("/api/v2/runs/parsed")
        self.assertIsNotNone(payload, "the run must STILL be ingested")
        self.assertNotIn(
            "runId", payload,
            f"a failed start must not fabricate a runId; keys={sorted(payload)!r}")

        axi = self._assert_toon_axi_shaped(out, "test", "404 degradation")
        self.assertIs(axi.get("ok"), True,
                      "degradation is not failure — the evidence landed")
        text = self._warning_text(axi)
        self.assertTrue(
            axi.get("warnings"),
            f"the fallback must be NAMED in the envelope, never silent; "
            f"axi={axi!r}")
        self.assertIn(
            "single-shot", text,
            f"the warning must name the fallback it took; warnings={text!r}")
        self.assertIn(
            "404", text,
            f"the warning must name the condition that caused it; "
            f"warnings={text!r}")

    def test_degraded_run_start_failure_is_not_treated_as_an_ingest_failure(self):
        server = _FakeCrucible(start_response=self.NOT_FOUND)

        _code, out, _err = self._run_regression_verb(server)

        axi = self._assert_toon_axi_shaped(out, "regression", "404 degradation")
        self.assertIs(axi.get("ok"), True)
        self.assertNotIn(
            "error", axi,
            f"the ingest itself succeeded — a start-route 404 must not surface "
            f"as the run's error; axi={axi!r}")


class SignalLeavesTheRunToTheServerAutoAbortTest(_BaseCr017ClientTest):
    """§S4 — "trap SIGINT/SIGTERM". The abort ROUTE is §S2 and does not exist
    yet, so the client's obligation is to stop cleanly, POST no abort, and SAY
    that the open run is left to the server's own auto-abort sweep."""

    def _run_with_signal(self, signame, server):
        """Drive a run that is interrupted by `signame` mid-tool. An OUTER
        handler is installed first purely as a test-harness guard: if the
        client fails to trap the signal itself, an untrapped SIGTERM would
        kill this whole unittest process, so it is converted into an ordinary
        failure instead."""
        os.environ["FAKE_BUN_SIGNAL"] = signame
        signum = getattr(signal, signame)

        def _outer(_signum, _frame):
            raise _UntrappedSignal(signame)

        previous = signal.signal(signum, _outer)
        try:
            try:
                return self._run_test_verb(server)
            except _UntrappedSignal:
                self.fail(
                    f"{signame} reached the TEST's guard handler — the client "
                    f"never trapped it. A wrapped run must trap SIGINT/SIGTERM "
                    f"so it can report the open run it is abandoning instead of "
                    f"dying silently.")
            except KeyboardInterrupt:
                self.fail(
                    f"{signame} escaped as a bare KeyboardInterrupt — the "
                    f"client must trap it and emit an envelope naming the "
                    f"abandoned run.")
        finally:
            signal.signal(signum, previous)
            os.environ.pop("FAKE_BUN_SIGNAL", None)

    def _assert_abandoned(self, signame, code, out, server):
        paths = server.paths()
        self.assertIn("/api/v2/runs/start", paths,
                      f"the interrupted run must have been OPENED; paths={paths}")
        self.assertEqual(
            [p for p in paths if "abort" in p], [],
            f"the client must invent NO abort call — POST /api/v2/runs/<id>/abort "
            f"is CR-CRU-017 §S2 and does not exist yet; paths={paths}")
        self.assertEqual(
            [p for p in paths if p.startswith("/api/v2/runs/")
             and p != "/api/v2/runs/start"], [],
            f"an interrupted run has no result to ingest; paths={paths}")
        self.assertEqual(
            code, 128 + getattr(signal, signame),
            f"a signalled run exits with the conventional 128+signum; "
            f"stdout={out!r}")

        axi = self._assert_toon_axi_shaped(out, "test", f"{signame} path")
        self.assertIs(axi.get("ok"), False,
                      "an abandoned run did not succeed")
        text = self._warning_text(axi)
        self.assertTrue(axi.get("warnings"),
                        f"the abandoned run must be NAMED; axi={axi!r}")
        self.assertIn(
            "auto-abort", text,
            f"the warning must say the run is left to the SERVER's auto-abort "
            f"(the client posts nothing); warnings={text!r}")
        self.assertIn(
            "abandoned", text,
            f"the warning must say the run was abandoned rather than lost; "
            f"warnings={text!r}")
        self.assertIn(
            signame, text,
            f"the warning must name the signal that interrupted the run; "
            f"warnings={text!r}")

    def test_sigint_mid_run_leaves_the_open_run_to_the_server(self):
        server = _FakeCrucible()
        code, out, _err = self._run_with_signal("SIGINT", server)
        self._assert_abandoned("SIGINT", code, out, server)

    def test_sigterm_mid_run_leaves_the_open_run_to_the_server(self):
        server = _FakeCrucible()
        code, out, _err = self._run_with_signal("SIGTERM", server)
        self._assert_abandoned("SIGTERM", code, out, server)

    def test_a_signalled_run_still_tears_down_its_own_agent_identity(self):
        """The tombstone is what ARMS the server's `agent died` auto-abort, so
        the bracket's closing unregister must still fire on the signal path."""
        server = _FakeCrucible()
        self._run_with_signal("SIGTERM", server)
        self.assertEqual(
            server.paths()[-1], "/api/v2/agents/unregister",
            f"the gated identity must still be torn down last; "
            f"paths={server.paths()}")


class EveryLifecyclePathStaysToonAxiShapedTest(_BaseCr017ClientTest):
    """§S1's envelope contract is unconditional: whichever branch a wrapped run
    takes, stdout is exactly one decodable TOON-AXI document."""

    def test_wrapped_no_lifecycle_degraded_and_signalled_paths_all_emit_one_envelope(self):
        scenarios = []

        server = _FakeCrucible()
        _code, out, _err = self._run_test_verb(server)
        scenarios.append(("wrapped", out))

        server = _FakeCrucible()
        _code, out, _err = self._run_test_verb(server, ["--no-lifecycle"])
        scenarios.append(("no-lifecycle", out))

        server = _FakeCrucible(
            start_response={"ok": False, "error": "HTTP 404: not found"})
        _code, out, _err = self._run_test_verb(server)
        scenarios.append(("degraded", out))

        signalled = SignalLeavesTheRunToTheServerAutoAbortTest(
            "test_sigterm_mid_run_leaves_the_open_run_to_the_server")
        signalled.setUp()
        try:
            server = _FakeCrucible()
            _code, out, _err = signalled._run_with_signal("SIGTERM", server)
            scenarios.append(("signalled", out))
        finally:
            signalled.tearDown()

        for name, stdout_text in scenarios:
            with self.subTest(path=name):
                self.assertEqual(
                    len([ln for ln in stdout_text.splitlines() if ln.strip()
                         and not ln.startswith((" ", "\t", "-"))
                         and ln.split(":")[0] == "axi"]),
                    1,
                    f"{name}: stdout must carry exactly ONE `axi:` document; "
                    f"got {stdout_text!r}")
                self._assert_toon_axi_shaped(stdout_text, "test", name)


# ── CR-CRU-094 §S3 — a missing attribution is announced BEFORE the run ──────
#
# §S3 verbatim (re-timed 2026-09-07 by user ruling): the warning is
# "pre-flight -- emitted when the run starts, while `--cycle` can still be
# supplied", because "there is no run-level cycle backfill verb" and "a
# post-hoc warning on a 9-minute gate names no remedy anyone will take; the
# same warning before the suite starts does."
#
# And its two load-bearing constraints, verbatim:
#   "Best-effort, never blocking. A failed or slow lookup produces NO warning
#    and NEVER prevents the run."
#   "Both channels. The line prints to stderr at start ... AND the same
#    {code, detail} entry rides the final envelope's warnings[]."
#
# The mechanism §S3 fixes is already on the wire: `GET /api/v2/agents?project=
# <key>` projects `boundCycleId` (ABSENT when unbound), so pre-flight is
# "`--cycle` supplied -> nothing to warn about; else read the binding; absent
# -> warn". No new endpoint.
#
# RED, and the exact reason: `cmd_test`/`cmd_regression` in
# clients/bun-crucible.py issue NO read at all before spawning the runner --
# the only pre-run call is `_open_gate_identity`'s register/heartbeat POST --
# and no `no-cycle` warning exists anywhere in the client or in
# `_crucible_axi.py` (whose warning family today is `no-wave`, `no-title`,
# `no-test-reports`, `prefer-gate-run`). Every assertion below that requires
# either the binding read or the warning therefore fails today.
#
# WHY THIS FILE: the pre-flight contract is an ORDERING claim about a wrapped
# run -- "before the suite's own output, not after the ingest" -- and this
# harness is the one that can prove ordering rather than assert it by proxy:
# `FAKE_BUN_SPAWN_STAMP` already makes the fake runner record the instant it
# starts, so "pre-flight" is asserted against the real spawn time. Reusing it
# is the whole reason these tests live beside CR-CRU-017's rather than in a
# parallel harness.


# The warning's code, derived from the family it joins: `no_wave_warning` ->
# "no-wave", `no_title_warning` -> "no-title", so a missing cycle attribution
# -> "no-cycle". (Deliberately NOT the retired "no-cycle-id" of CR-CRU-030
# §S3, whose client-side active-cycle resolver CR-CRU-056 §S3 deleted.)
MISSING_CYCLE_CODE = "no-cycle"


class _Cr094PreflightBase(_BaseCr017ClientTest):
    """Adds one thing to the CR-CRU-017 harness: a `_get` seam that can ANSWER
    the binding read (`GET /api/v2/agents?project=<key>`) and records every
    path, the wall-clock instant it was asked and the TIMEOUT it was asked
    with, so "did the client read the binding", "did it read it before the
    suite started" and "did it read it under the pre-flight bound rather than
    the 10s hook-safe default" are all decidable."""

    AGENT = "preflight-attribution-fixture"

    def _agents_ok(self, bound_cycle_id=None):
        """The real `handleAgentsList` shape: `boundCycleId` is ABSENT for an
        unbound agent, never null and never 0 (Store.toAgent's convention)."""
        agent = {"agentId": self.AGENT, "projectKey": self.PROJECT_KEY,
                 "liveness": "online", "role": "ORCHESTRATOR"}
        if bound_cycle_id is not None:
            agent["boundCycleId"] = bound_cycle_id
        return lambda _path: {"ok": True, "agents": [agent]}

    def _drive(self, server, verb, get_side_effect, extra_argv=()):
        """Run the REAL CLI dispatch for `verb` against `server`, with `_get`
        answered by `get_side_effect`. Returns (code, stdout, stderr, gets)
        where `gets` is [(path, wall_clock_seconds, timeout)] in call order --
        the timeout is recorded because the bound the read is issued under is
        part of "best-effort, never blocking", not an implementation detail."""
        gets = []

        def _get(path, timeout=10):
            gets.append((path, time.time(), timeout))
            return get_side_effect(path)

        argv = [verb, "--bun", self.fake_bun, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports",
                "--agent", self.AGENT] + list(extra_argv)
        with mock.patch.object(self.module, "_post", side_effect=server.post), \
             mock.patch.object(self.module, "_get", create=True, side_effect=_get):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, gets

    def _binding_reads(self, gets):
        return [path for path, _at, _timeout in gets
                if path.startswith("/api/v2/agents")]

    def _binding_read_timeouts(self, gets):
        return [timeout for path, _at, timeout in gets
                if path.startswith("/api/v2/agents")]

    def _missing_cycle_warnings(self, axi):
        return [w for w in (axi.get("warnings") or [])
                if w.get("code") == MISSING_CYCLE_CODE]


class UnboundRunIsWarnedOnBothChannelsTest(_Cr094PreflightBase):
    """AC5 direction 1 — no binding, no `--cycle`, no explicit context: the
    warning rides BOTH channels and the run still lands. Stderr alone is
    invisible to a scripted reader; `warnings[]` alone defeats the ruling."""

    def test_the_envelope_carries_the_missing_cycle_warning_and_the_run_still_ingests(self):
        server = _FakeCrucible()

        code, out, _err, gets = self._drive(server, "test", self._agents_ok())

        # The binding was actually READ -- the warning is a fact about the
        # server's registration state, not about a local flag being unset.
        self.assertTrue(
            self._binding_reads(gets),
            f"pre-flight must read the binding via GET /api/v2/agents; the "
            f"client issued no such GET (paths={[p for p, _, _ in gets]!r})")

        axi = self._assert_toon_axi_shaped(out, "test", "unbound pre-flight")
        found = self._missing_cycle_warnings(axi)
        self.assertEqual(
            len(found), 1,
            f"exactly ONE `{MISSING_CYCLE_CODE}` warning must ride the final "
            f"envelope; got codes={self._warning_codes(axi)!r}")

        # WARN-AND-WRITE (CR-CRU-091 §S5's severity ladder): the write is not
        # the problem, the silence is.
        self.assertIs(axi.get("ok"), True,
                      f"the ingest still succeeds; axi={axi!r}")
        self.assertEqual(code, 0, f"a green run still exits 0; stdout={out!r}")
        self.assertIsNotNone(
            server.payload_for("/api/v2/runs/parsed"),
            f"the run must still be STORED, not refused; paths={server.paths()}")

    def test_the_warning_line_prints_on_stderr_and_before_the_ingest_line(self):
        server = _FakeCrucible()

        _code, _out, err, _gets = self._drive(server, "test", self._agents_ok())

        at = err.find(MISSING_CYCLE_CODE)
        self.assertNotEqual(
            at, -1,
            f"the pre-flight line must print on STDERR (the channel "
            f"`gate_identity_skipped_line` already uses to tell an operator "
            f"why something did not happen); stderr={err!r}")
        ingest_at = err.find("ingest: ok=")
        self.assertNotEqual(
            ingest_at, -1,
            f"the run's own stderr line must still be there; stderr={err!r}")
        self.assertLess(
            at, ingest_at,
            f"the warning is PRE-flight -- it must precede the ingest line, "
            f"not follow it; stderr={err!r}")

    def test_the_warning_is_emitted_before_the_runner_process_is_spawned(self):
        """The ruling's whole point: it fires "while `--cycle` can still be
        supplied", i.e. before the suite burns its minutes. Proven against the
        runner's OWN recorded start instant, not against stream interleaving."""
        stamp = os.path.join(self.tmpdir, "spawn-stamp")
        os.environ["FAKE_BUN_SPAWN_STAMP"] = stamp
        server = _FakeCrucible()

        _code, _out, _err, gets = self._drive(server, "test", self._agents_ok())

        reads = [at for path, at, _timeout in gets
                 if path.startswith("/api/v2/agents")]
        self.assertTrue(
            reads,
            f"pre-flight must read the binding at all; "
            f"paths={[p for p, _, _ in gets]!r}")
        self.assertTrue(os.path.exists(stamp), "the fake bun must have spawned")
        with open(stamp) as f:
            spawned_at = float(f.read())
        self.assertLessEqual(
            reads[0], spawned_at,
            "the binding read must land BEFORE the runner starts -- a warning "
            "computed after the suite is already running names a remedy that "
            "can no longer be applied to this run")

    def test_the_detail_names_the_missing_attribution_and_how_to_supply_it(self):
        server = _FakeCrucible()

        _code, out, _err, _gets = self._drive(server, "test", self._agents_ok())

        axi = self._decode_axi(out)
        found = self._missing_cycle_warnings(axi)
        self.assertEqual(len(found), 1,
                         f"codes={self._warning_codes(axi)!r}")
        detail = found[0].get("detail") or ""
        # The voice of `no_wave_warning`/`no_title_warning`: name the omission,
        # then name the lever that fixes it.
        self.assertIn(
            "cycle", detail.lower(),
            f"the detail must name the attribution that is missing; got {detail!r}")
        self.assertIn(
            "--cycle", detail,
            f"the detail must name the flag that supplies it -- there is no "
            f"run-level backfill verb, so the remedy only exists BEFORE the "
            f"run; got {detail!r}")


class BoundCallerIsNotWarnedTest(_Cr094PreflightBase):
    """AC5 direction 2 -- the assertion that forces pre-flight to READ the
    binding. This caller registered `--cycle N` in an earlier process and
    passes NO flag now, so a flag-derived implementation would warn here (and
    would pass AC6, which is exactly why AC5 states both directions)."""

    def test_a_bound_caller_passing_no_flag_reads_its_binding_and_is_not_warned(self):
        server = _FakeCrucible()

        code, out, err, gets = self._drive(server, "test", self._agents_ok(bound_cycle_id=412))

        self.assertTrue(
            self._binding_reads(gets),
            f"the client must ASK the board whether it is bound -- inferring "
            f"'unbound' from a missing local --cycle flag is the failure mode "
            f"this test exists to catch; paths={[p for p, _, _ in gets]!r}")
        axi = self._assert_toon_axi_shaped(out, "test", "bound pre-flight")
        self.assertEqual(
            self._missing_cycle_warnings(axi), [],
            f"a BOUND caller has nothing missing; got warnings={axi.get('warnings')!r}")
        self.assertNotIn(
            MISSING_CYCLE_CODE, err,
            f"...and nothing is printed on stderr either; stderr={err!r}")
        self.assertEqual(code, 0, f"stdout={out!r}")


class PreflightIsBestEffortTest(_Cr094PreflightBase):
    """AC5's second constraint, verbatim: "A failed or slow lookup produces NO
    warning and NEVER prevents the run." A test suite must not become
    unrunnable because attribution could not be computed."""

    def test_an_unreachable_board_produces_no_warning_and_the_run_still_ingests(self):
        server = _FakeCrucible()

        code, out, err, gets = self._drive(
            server, "test",
            lambda _path: {"ok": False, "error": "HTTP 000: connection refused"})

        self.assertTrue(
            self._binding_reads(gets),
            f"the lookup must be ATTEMPTED (best-effort, not skipped); "
            f"paths={[p for p, _, _ in gets]!r}")
        axi = self._assert_toon_axi_shaped(out, "test", "unreachable board")
        self.assertEqual(
            self._missing_cycle_warnings(axi), [],
            f"an UNANSWERED lookup is not evidence of a missing binding -- "
            f"warning here would cry wolf; got warnings={axi.get('warnings')!r}")
        self.assertNotIn(MISSING_CYCLE_CODE, err, f"stderr={err!r}")
        self.assertIs(axi.get("ok"), True, f"axi={axi!r}")
        self.assertEqual(code, 0, f"stdout={out!r}")
        self.assertIsNotNone(
            server.payload_for("/api/v2/runs/parsed"),
            f"the run must still be stored; paths={server.paths()}")

    def test_the_binding_read_is_issued_under_the_short_preflight_bound(self):
        """`Never blocking` is a claim about the BOUND, not just about the
        exception handling: the client's own `_get` defaults to the 10s
        hook-safe read timeout, so an implementation that simply forgot to
        pass the pre-flight bound would pass every other test here and still
        cost every run up to 10s of dead wait against a degraded board. The
        expected value is READ from the module that owns it, so retuning the
        constant retunes this assertion with it."""
        server = _FakeCrucible()

        _code, _out, _err, gets = self._drive(server, "test", self._agents_ok())

        expected = self.module._axi().PREFLIGHT_TIMEOUT_S
        self.assertEqual(
            self._binding_read_timeouts(gets), [expected],
            f"the binding read must be issued with the pre-flight bound "
            f"({expected}s), not the inherited hook-safe default; "
            f"gets={gets!r}")

    def test_a_binding_lookup_that_raises_never_prevents_the_run(self):
        def _boom(_path):
            raise TimeoutError("binding lookup timed out")

        server = _FakeCrucible()

        code, out, _err, _gets = self._drive(server, "test", _boom)

        self.assertEqual(
            code, 0,
            f"a raising pre-flight must be swallowed -- attribution is"
            f" best-effort and NEVER blocking; stdout={out!r}")
        axi = self._assert_toon_axi_shaped(out, "test", "raising lookup")
        self.assertIs(axi.get("ok"), True, f"axi={axi!r}")
        self.assertEqual(self._missing_cycle_warnings(axi), [],
                         f"got warnings={axi.get('warnings')!r}")
        self.assertIsNotNone(
            server.payload_for("/api/v2/runs/parsed"),
            f"the run must still be stored; paths={server.paths()}")


class OrchestratorGateIsAttributableTest(_Cr094PreflightBase):
    """AC6 -- the case that prompted the CR, as a test rather than a
    convention. `regression --agent <orc> --cycle <id>` binds the run to that
    cycle (the binding is what the server stamps the run's `events.cycle_id`
    from -- the column itself is asserted server-side by
    tests/v2-runs-events.test.ts's "AC1" case, which reads it straight out of
    the store FILE); the SAME command with no `--cycle` gets AC5's warning."""

    def test_regression_with_a_cycle_binds_the_run_and_raises_no_missing_cycle_warning(self):
        server = _FakeCrucible()

        code, out, err, _gets = self._drive(
            server, "regression", self._agents_ok(bound_cycle_id=359),
            extra_argv=["--cycle", "359"])

        self.assertEqual(code, 0, f"stdout={out!r}")
        # A gated verb opens its identity on the ROLE-OPTIONAL heartbeat route
        # (never /register — CR-CRU-056's `GatedRunIdentity.PATH`).
        opened = server.payload_for("/api/v2/agents/heartbeat")
        self.assertIsNotNone(
            opened,
            f"a gated regression opens its identity first; paths={server.paths()}")
        self.assertEqual(
            opened.get("cycleId"), 359,
            f"`--cycle 359` must BIND the gate's identity -- that binding is "
            f"the only thing the server can stamp the run's cycle from; got "
            f"opening payload={opened!r}")

        axi = self._assert_toon_axi_shaped(out, "regression", "bound gate")
        self.assertEqual(
            self._missing_cycle_warnings(axi), [],
            f"`--cycle` was supplied -- there is nothing to warn about; got "
            f"warnings={axi.get('warnings')!r}")
        self.assertNotIn(MISSING_CYCLE_CODE, err, f"stderr={err!r}")
        self.assertIsNotNone(server.payload_for("/api/v2/runs/parsed"))

    def test_regression_without_a_cycle_gets_the_preflight_warning_on_both_channels(self):
        server = _FakeCrucible()

        code, out, err, gets = self._drive(server, "regression", self._agents_ok())

        self.assertTrue(
            self._binding_reads(gets),
            f"paths={[p for p, _, _ in gets]!r}")
        axi = self._assert_toon_axi_shaped(out, "regression", "unbound gate")
        self.assertEqual(
            len(self._missing_cycle_warnings(axi)), 1,
            f"the orchestrator's own gate, run with no --cycle, is exactly the "
            f"unattributable run this CR was filed for; got "
            f"codes={self._warning_codes(axi)!r}")
        self.assertIn(MISSING_CYCLE_CODE, err, f"stderr={err!r}")
        # Still warn-and-write: the gate is not blocked.
        self.assertIs(axi.get("ok"), True, f"axi={axi!r}")
        self.assertEqual(code, 0, f"stdout={out!r}")


if __name__ == "__main__":
    unittest.main()
