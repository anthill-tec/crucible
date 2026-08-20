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


if __name__ == "__main__":
    unittest.main()
