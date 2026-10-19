"""`cr-close` reports its own `cr-merged` post.

`cr-close` closes a plan (PATCH) and then posts the `cr-merged` milestone
itself. The board can refuse that post — the classic case is an orchestrator
whose `pre-merge-gate --cycle` bound it to the plan's last cycle, which it then
marked done without re-registering: the post is refused as a stale binding —
or it can fail to answer at all. Either way the CR is closed but its marker is
not on the board, and the one envelope the command prints must say so:
`ok: false`, exit 1, a `cr-merged-not-recorded` warning whose detail names the
CR as closed, the missing marker and the board's own error, and a `help[]`
whose three steps are the remedy (unregister, re-register unbound as
ORCHESTRATOR, post the marker with `milestone`). A post that succeeds leaves
the envelope as it is today.

Driven against a REAL, ephemeral `bun run src/server.ts` board on a free port
with a throwaway `mkdtemp` store (never :3850/:3849), the idiom
`test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close.py` uses.
Every step of the scenario — register, the binding `pre-merge-gate --cycle`,
`cycle-done`, `cr-close` and the remedy — is the REAL python client
(`clients/python-crucible.py`) as an OS subprocess; only the plan filing and
its cycle activation are seeded over the board's HTTP API.

The "board does not answer" case puts a small relaying double in front of the
real board: it forwards every request unchanged until the board has answered
the PATCH that closes the plan, then stops LISTENING before it relays that
answer, so the client's very next request (the `cr-merged` post) meets a
refused connection — the board is gone for exactly that one request.

Fixture CR labels are synthetic and lowercase (`merge-post-<case>`).

The remedy's `help[]` entries are matched with each value slot accepting
either the concrete value (agent id, CR, commit) or a `<placeholder>`, since
the remedy's wording may fill them or name them; `register` must carry no
`--cycle` either way.
"""

import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, cast

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    classify_envelope,
    drive_verb,
)
from tests.client.test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close import (
    _PY_TEST_FAIL,
    _PY_TEST_PASS,
    _await_server,
    _call,
    _declare_listener,
    _free_port,
    _git_commit_fixture,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_CLIENT = CLIENT_FILES["python"]

NOT_RECORDED_CODE = "cr-merged-not-recorded"
ACCEPT_REASON = "known flaky fixture accepted for the merge-post scenario"

# A value slot in a remedy step: the concrete value, or a `<placeholder>`.
_PLACEHOLDER = r"<[^<>\s]+>"


def _slot(value):
    return rf"(?:{re.escape(value)}|{_PLACEHOLDER})"


def _remedy_patterns(agent, cr, sha):
    """The three remedy steps, in order, as regexes over a `help[]` entry."""
    return (
        ("unregister",
         re.compile(rf"(?<![\w-])unregister --agent {_slot(agent)}")),
        ("register",
         re.compile(rf"(?<![\w-])register --agent {_slot(agent)} --role ORCHESTRATOR\b")),
        ("milestone",
         re.compile(rf"(?<![\w-])milestone --type cr-merged --cr {_slot(cr)} "
                    rf"--label {_slot(cr)} --commit {_slot(sha)} --agent {_slot(agent)}")),
    )


def _envelope_count(stdout_text):
    return len(re.findall(r"(?m)^axi:", stdout_text or ""))


class _BoardThatStopsAnsweringAfterTheClose:
    """A relaying double in front of the real board. Every request is
    forwarded verbatim (method, path, body) and the board's answer relayed
    back — until the board has answered a plan PATCH that closes the plan.
    At that moment the double closes its listening socket BEFORE relaying the
    answer, so nothing is listening when the client makes its next request:
    that request is refused at connect, exactly as against a board that is
    not running. The requests it relayed are recorded in `relayed`."""

    def __init__(self, upstream):
        self.upstream = upstream
        self.relayed = []
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(16)
        self.port = self.listener.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.stopped = False
        double = self

        class _Relay(BaseHTTPRequestHandler):
            def log_message(self, format, *args):  # noqa: A002 — the base signature
                return

            def _relay(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else None
                double.relayed.append((self.command, self.path, body))
                # pi-lens-ignore: S310 — the upstream is this suite's own scratch board
                request = urllib.request.Request(  # noqa: S310
                    double.upstream + self.path, data=body, method=self.command,
                    headers={"content-type": "application/json"})
                try:
                    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
                        status, payload = response.status, response.read()
                except urllib.error.HTTPError as exc:
                    status, payload = exc.code, exc.read()
                if (self.command == "PATCH" and "/plans/" in self.path
                        and "/cycles/" not in self.path and status == 200
                        and body and json.loads(body).get("status") == "closed"):
                    double.stop_listening()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = _relay

        self._handler = _Relay
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def stop_listening(self):
        if not self.stopped:
            self.stopped = True
            self.listener.close()

    def _serve(self):
        while True:
            try:
                conn, address = self.listener.accept()
            except OSError:
                return
            try:
                self._handler(conn, address, cast(Any, self))
            except OSError:
                pass
            finally:
                conn.close()

    def close(self):
        self.stop_listening()
        self._thread.join(timeout=10)


class CrCloseReportsItsOwnCrMergedPostTest(unittest.TestCase):
    """One shared scratch board; every test builds its own project, plan and
    project directory, so no test reads state another one wrote."""

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="cr-merged-post-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "a real cr-close round trip needs a real board to close the "
                "plan and refuse the post: without `bun` there is no board.")
        port = _free_port()
        assert port not in (3850, 3849), f"the OS handed back a reserved port {port}"
        cls.base = f"http://127.0.0.1:{port}"
        _declare_listener(cls._tmpdir, port)
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ, "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            _await_server(cls.base, cls._proc)
            cls.toon = _load_toon_module()
            cls.bin_dir = _build_fake_bin_dir()
        except BaseException:
            cls._stop_server()
            shutil.rmtree(cls._tmpdir, ignore_errors=True)
            raise

    @classmethod
    def tearDownClass(cls):
        cls._stop_server()
        shutil.rmtree(getattr(cls, "bin_dir", ""), ignore_errors=True)
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    @classmethod
    def _stop_server(cls):
        proc = cls._proc
        if proc is None:
            return
        cls._proc = None
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    def setUp(self):
        self._scratch = []

    def tearDown(self):
        for d in self._scratch:
            shutil.rmtree(d, ignore_errors=True)

    # ── board + client helpers ──────────────────────────────────────────────

    def _http(self, path, payload=None, method=None):
        return _call(self.base, path, payload, method)

    def _drive(self, scenario, argv, board=None, timeout=120):
        """One REAL python client invocation from the scenario's project dir."""
        argv = list(argv) + ["--project-dir", str(scenario["project_dir"])]
        return drive_verb(PYTHON_CLIENT, argv, scenario["project_dir"], self.bin_dir,
                          timeout=timeout, board=board or self.base)

    def _plan(self, key, plan_id):
        read = self._http(f"/api/v2/projects/{key}/plans")
        self.assertTrue(read.get("ok"), f"plans read failed: {read!r}")
        for plan in read.get("plans") or []:
            if plan.get("planId") == plan_id:
                return plan
        raise AssertionError(f"plan {plan_id} not found in {read!r}")

    def _cr_merged(self, key, cr):
        read = self._http(f"/api/v2/projects/{key}/milestones?type=cr-merged")
        self.assertTrue(read.get("ok"), f"milestones read failed: {read!r}")
        return [m for m in read.get("milestones") or [] if m.get("label") == cr]

    def _scenario(self, case, gate_outcome="pass", orchestrator_runs_the_gate=True):
        """A project with one plan whose only (hence last) cycle is active, a
        REAL `pre-merge-gate --cycle` run over it and a REAL `cycle-done`.

        With `orchestrator_runs_the_gate`, the gate runs under the orchestrator's
        own (pre-registered, unbound) id — the heartbeat binds it to the cycle
        and, since the gate did not create the registration, leaves it bound.
        Otherwise a separate gate agent runs it, which the gate creates and
        removes, and the orchestrator stays unbound."""
        cr = f"merge-post-{case}"
        project = self._http("/api/v2/projects", {"name": f"merge-post-{case}"})
        self.assertTrue(project.get("ok"), f"project creation failed: {project!r}")
        key = project["project"]["key"]

        project_dir = _make_project_dir("python")
        self._scratch.append(project_dir)
        (project_dir / ".env").write_text(f"CRUCIBLE_PROJECT_KEY={key}\n")
        (project_dir / "tests" / "test_probe.py").unlink(missing_ok=True)
        (project_dir / "tests" / "test_merge_post_fixture.py").write_text(
            _PY_TEST_PASS if gate_outcome == "pass" else _PY_TEST_FAIL)
        sha = _git_commit_fixture(project_dir)

        orchestrator = f"merge-post-{case}-orchestrator"
        scenario = {"cr": cr, "key": key, "project_dir": project_dir, "sha": sha,
                    "agent": orchestrator}
        reg = self._drive(scenario, ["register", "--agent", orchestrator,
                                     "--role", "ORCHESTRATOR"])
        self.assertEqual(reg.returncode, 0,
                         f"orchestrator register failed: {reg.stdout!r} {reg.stderr!r}")

        filed = self._http(f"/api/v2/projects/{key}/plans",
                           {"cr": cr, "cycles": [{"label": "solo"}],
                            "agentId": orchestrator})
        self.assertTrue(filed.get("ok"), f"plan filing failed: {filed!r}")
        plan_id, cycle_id = filed["planId"], filed["cycles"][0]["id"]
        active = self._http(
            f"/api/v2/projects/{key}/plans/{plan_id}/cycles/{cycle_id}",
            {"status": "active", "agentId": orchestrator}, method="PATCH")
        self.assertTrue(active.get("ok"), f"cycle activation failed: {active!r}")
        scenario.update(plan_id=plan_id, cycle_id=cycle_id)

        gate_agent = orchestrator if orchestrator_runs_the_gate else f"merge-post-{case}-gate"
        gate = self._drive(scenario, ["pre-merge-gate", "--agent", gate_agent,
                                      "--cycle", str(cycle_id)], timeout=300)
        gates = self._http(f"/api/v2/projects/{key}/milestones?type=pre-merge-gate")
        mine = [m for m in gates.get("milestones") or [] if m.get("label") == cr]
        self.assertEqual(
            [m.get("outcome") for m in mine], [gate_outcome],
            f"fixture: the gate must record exactly one {gate_outcome!r} result for "
            f"{cr}; got {mine!r}; gate stdout={gate.stdout[-1500:]!r} "
            f"stderr={gate.stderr[-1500:]!r}")

        done = self._drive(scenario, ["cycle-done", str(cycle_id), "--agent", orchestrator])
        self.assertEqual(done.returncode, 0,
                         f"cycle-done failed: {done.stdout!r} {done.stderr!r}")
        return scenario

    def _cr_close(self, scenario, extra=(), board=None):
        result = self._drive(scenario, ["cr-close", "--agent", scenario["agent"],
                                        "--commit", scenario["sha"],
                                        "--cr", scenario["cr"], *extra],
                             board=board, timeout=60)
        _emits, axi = classify_envelope(result.stdout, self.toon)
        return result, axi or {}

    # ── shared assertions ───────────────────────────────────────────────────

    def _assert_reported_unrecorded(self, scenario, result, axi, board_error_fragments):
        out = f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}"
        self.assertEqual(
            _envelope_count(result.stdout), 1,
            f"cr-close must print exactly ONE envelope; {out}")
        self.assertIs(
            axi.get("ok"), False,
            f"a close whose cr-merged post failed must read ok: false; {out}")
        self.assertEqual(
            result.returncode, 1,
            f"a close whose cr-merged post failed must exit 1; {out}")

        warnings = [w for w in axi.get("warnings") or []
                    if isinstance(w, dict) and w.get("code") == NOT_RECORDED_CODE]
        self.assertEqual(
            len(warnings), 1,
            f"exactly one {NOT_RECORDED_CODE!r} warning expected; "
            f"got warnings={axi.get('warnings')!r}")
        detail = str(warnings[0].get("detail") or "")
        self.assertIn(scenario["cr"], detail,
                      f"the detail must name the CR; got {detail!r}")
        self.assertIn("closed", detail,
                      f"the detail must say the CR is closed; got {detail!r}")
        self.assertIn("cr-merged", detail,
                      f"the detail must say its cr-merged marker is missing; got {detail!r}")
        for fragment in board_error_fragments:
            self.assertIn(fragment, detail,
                          f"the detail must carry the board's error ({fragment!r}); "
                          f"got {detail!r}")

        help_steps = [str(h) for h in axi.get("help") or []]
        self.assertEqual(
            len(help_steps), 3,
            f"help[] must be the three-step remedy; got {help_steps!r}")
        patterns = _remedy_patterns(scenario["agent"], scenario["cr"], scenario["sha"])
        for index, (verb, pattern) in enumerate(patterns):
            self.assertRegex(
                help_steps[index], pattern,
                f"help[{index}] must be the {verb!r} remedy step; got {help_steps!r}")
        self.assertNotIn(
            "--cycle", help_steps[1],
            f"the remedy's re-register must be UNBOUND (no --cycle); got {help_steps[1]!r}")

    def _stale_binding_error(self, scenario):
        # The board's own refusal of a post from an agent still bound to the
        # (now done) cycle of a closed plan.
        return (f"bound cycle {scenario['cycle_id']} is", "ingest refused")

    # ── a stale binding refuses the post ────────────────────────────────────

    def test_cr_close_with_a_stale_gate_binding_closes_the_plan_and_reports_the_refused_post(self):
        scenario = self._scenario("stale")
        result, axi = self._cr_close(scenario)

        plan = self._plan(scenario["key"], scenario["plan_id"])
        self.assertEqual(plan.get("status"), "closed",
                         f"the close itself succeeds; got plan={plan!r}")
        self.assertEqual((plan.get("merge") or {}).get("commit"), scenario["sha"],
                         f"the plan's merge record carries the commit; got {plan!r}")
        self.assertEqual(self._cr_merged(scenario["key"], scenario["cr"]), [],
                         "the board refused the post, so no cr-merged marker exists")
        self._assert_reported_unrecorded(scenario, result, axi,
                                         self._stale_binding_error(scenario))

    def test_running_the_reported_remedy_records_the_cr_merged_milestone(self):
        scenario = self._scenario("remedy")
        result, axi = self._cr_close(scenario)
        self.assertEqual(self._cr_merged(scenario["key"], scenario["cr"]), [],
                         "precondition: the refused post recorded no marker")

        help_steps = [str(h) for h in axi.get("help") or []]
        values = {"--agent": scenario["agent"], "--cr": scenario["cr"],
                  "--label": scenario["cr"], "--commit": scenario["sha"]}
        patterns = _remedy_patterns(scenario["agent"], scenario["cr"], scenario["sha"])
        commands = []
        for verb, pattern in patterns:
            match = next((pattern.search(h) for h in help_steps if pattern.search(h)), None)
            if match is None:
                self.fail(f"help[] must carry the {verb!r} remedy step; got {help_steps!r} "
                          f"(cr-close stdout={result.stdout!r})")
            tokens = shlex.split(match.group(0))
            commands.append([values[tokens[i - 1]] if re.fullmatch(_PLACEHOLDER, tok) else tok
                             for i, tok in enumerate(tokens)])

        for argv in commands:
            step = self._drive(scenario, argv)
            self.assertEqual(step.returncode, 0,
                             f"remedy step {argv!r} failed: {step.stdout!r} {step.stderr!r}")

        merged = self._cr_merged(scenario["key"], scenario["cr"])
        self.assertEqual(len(merged), 1,
                         f"the remedy records exactly one cr-merged marker; got {merged!r}")
        self.assertEqual(merged[0].get("commit"), scenario["sha"],
                         f"the marker carries the merge commit; got {merged[0]!r}")

    def test_cr_close_over_an_accepted_failing_gate_reports_the_refused_post_the_same_way(self):
        scenario = self._scenario("accepted", gate_outcome="fail")
        result, axi = self._cr_close(scenario, extra=["--accept-failing-gate", ACCEPT_REASON])

        plan = self._plan(scenario["key"], scenario["plan_id"])
        self.assertEqual(plan.get("status"), "closed",
                         f"the accepted close itself succeeds; got plan={plan!r}")
        self.assertEqual(
            (plan.get("merge") or {}).get("acceptedFailingGateReason"), ACCEPT_REASON,
            f"the plan's merge record keeps the reason; got {plan!r}")
        self.assertEqual(self._cr_merged(scenario["key"], scenario["cr"]), [],
                         "the board refused the post, so no cr-merged marker exists")
        self._assert_reported_unrecorded(scenario, result, axi,
                                         self._stale_binding_error(scenario))

    # ── the board does not answer the post ──────────────────────────────────

    def test_a_cr_merged_post_the_board_does_not_answer_is_reported_the_same_way(self):
        scenario = self._scenario("unanswered", orchestrator_runs_the_gate=False)
        double = _BoardThatStopsAnsweringAfterTheClose(self.base)
        try:
            result, axi = self._cr_close(scenario, board=double.url)
        finally:
            double.close()

        self.assertTrue(double.stopped,
                        f"fixture: the close PATCH must have reached the board; "
                        f"relayed={[(m, p) for m, p, _ in double.relayed]!r}")
        self.assertFalse(
            any(m == "POST" and p.startswith("/api/v2/milestones")
                for m, p, _ in double.relayed),
            "fixture: the double must never have relayed the milestone post")
        plan = self._plan(scenario["key"], scenario["plan_id"])
        self.assertEqual(plan.get("status"), "closed",
                         f"the close itself succeeds; got plan={plan!r}")
        self.assertEqual(self._cr_merged(scenario["key"], scenario["cr"]), [],
                         "no board answered the post, so no cr-merged marker exists")
        self._assert_reported_unrecorded(scenario, result, axi, ("connection failed",))

    # ── a clean binding posts the marker, as today ─────────────────────────

    def test_cr_close_after_a_clean_re_registration_is_ok_and_records_the_marker(self):
        scenario = self._scenario("clean")
        for argv in (["unregister", "--agent", scenario["agent"]],
                     ["register", "--agent", scenario["agent"], "--role", "ORCHESTRATOR"]):
            step = self._drive(scenario, argv)
            self.assertEqual(step.returncode, 0,
                             f"{argv!r} failed: {step.stdout!r} {step.stderr!r}")

        result, axi = self._cr_close(scenario)
        out = f"stdout={result.stdout!r} stderr={result.stderr[-1500:]!r}"
        self.assertEqual(_envelope_count(result.stdout), 1,
                         f"cr-close prints exactly ONE envelope; {out}")
        self.assertIs(axi.get("ok"), True, f"a clean close reads ok: true; {out}")
        self.assertEqual(result.returncode, 0, f"a clean close exits 0; {out}")
        self.assertEqual(axi.get("warnings"), [],
                         f"a clean close carries no warnings; {out}")
        merged = self._cr_merged(scenario["key"], scenario["cr"])
        self.assertEqual(len(merged), 1,
                         f"a clean close records exactly one cr-merged marker; got {merged!r}")
        self.assertEqual(merged[0].get("commit"), scenario["sha"],
                         f"the marker carries the merge commit; got {merged[0]!r}")


if __name__ == "__main__":
    unittest.main()
