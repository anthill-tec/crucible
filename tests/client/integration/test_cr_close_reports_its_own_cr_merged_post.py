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

Every step — `cr-close` and the remedy — is the REAL python client
(`clients/python-crucible.py`) as an OS subprocess, against a fake board
(`RecordingBoard`, one per test) that answers as the real one does for the
scenario: the CR's one open plan, its last cycle done; its `pre-merge-gate`
history (a full gate, `pass` or `fail`, minted as the store mints milestones);
the close PATCH; and the `cr-merged` post — refused 409 with the server's own
stale-binding wording (`bound cycle <id> is in closed plan <CR> — ingest
refused, run NOT stored`, src/v2.ts) for a poster still bound, or recorded
(201, a minted event id) once it is not. What the client sent is read off the
request log.

That the board really refuses a post from an agent still bound to the done
cycle of a closed plan, stores no marker then, and records exactly one marker
carrying the commit once the poster is unregistered and registered again
unbound, is the server's half, held in bun by
`tests/integration/milestone-routes-order-and-refuse-as-clients-read-them
.test.ts`; that a close stores the merge commit (and an accepted failing
gate's reason) by `plan-close-guard.test.ts` and
`closed-plans-read-carries-merge-and-title-verbatim.test.ts`.

The "board does not answer" case puts `real_board.RecordingProxy` in front of
the fake: it forwards every request unchanged until the board has answered
the PATCH that closes the plan, then stops LISTENING, so the client's very next
request (the `cr-merged` post) meets a refused connection — the board is gone
for exactly that one request.

Fixture CR labels are synthetic and lowercase (`merge-post-<case>`).

The remedy's `help[]` entries are matched with each value slot accepting
either the concrete value (agent id, CR, commit) or a `<placeholder>`, since
the remedy's wording may fill them or name them; `register` must carry no
`--cycle` either way.
"""

import re
import shlex
import shutil
import unittest
import uuid

from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    classify_envelope,
    drive_verb,
)
from tests.client.live_run_harness import (
    MILESTONE_POSTED_STATUS,
    MILESTONES_ANSWER,
    RecordingBoard,
    milestone_posted,
)
from tests.client.real_board import RecordingProxy
from tests.client.the_gate_records_its_outcome_and_a_red_gate_stops_the_close_helpers import (
    _git_commit_fixture,
)

PYTHON_CLIENT = CLIENT_FILES["python"]

NOT_RECORDED_CODE = "cr-merged-not-recorded"
ACCEPT_REASON = "known flaky fixture accepted for the merge-post scenario"
MILESTONES_PATH = "/api/v2/milestones"

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


class CrCloseReportsItsOwnCrMergedPostTest(unittest.TestCase):
    """Every test builds its own fake board, project, plan and project
    directory, so no test reads state another one wrote."""

    @classmethod
    def setUpClass(cls):
        cls.toon = _load_toon_module()
        cls.bin_dir = _build_fake_bin_dir()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.bin_dir, ignore_errors=True)

    def setUp(self):
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.base = self.board.url

    # ── board + client helpers ──────────────────────────────────────────────

    def _drive(self, scenario, argv, board=None, timeout=120):
        """One REAL python client invocation from the scenario's project dir."""
        argv = list(argv) + ["--project-dir", str(scenario["project_dir"])]
        return drive_verb(PYTHON_CLIENT, argv, scenario["project_dir"], self.bin_dir,
                          timeout=timeout, board=board or self.base)

    def _closes(self, scenario):
        """Every close the client sent: a PATCH of the plan itself."""
        plan_path = f"/api/v2/projects/{scenario['key']}/plans/{scenario['plan_id']}"
        return [b for p, b in self.board.posts() if p == plan_path]

    def _cr_merged_posts(self, scenario):
        """Every `cr-merged` milestone the client posted for the CR."""
        return [b for p, b in self.board.posts()
                if p == MILESTONES_PATH and isinstance(b, dict)
                and b.get("type") == "cr-merged" and b.get("label") == scenario["cr"]]

    def _scenario(self, case, gate_outcome="pass", orchestrator_runs_the_gate=True):
        """A project with one open plan whose only (hence last) cycle is done,
        and a full `pre-merge-gate` result for its CR, as the board holds them
        after a real `pre-merge-gate --cycle` run and a real `cycle-done`.

        With `orchestrator_runs_the_gate`, the gate ran under the orchestrator's
        own id, which the gate's heartbeat left bound to the done cycle, so the
        board refuses its `cr-merged` post as a stale binding. Otherwise a
        separate gate agent ran it and the orchestrator stays unbound."""
        cr = f"merge-post-{case}"
        key = str(uuid.uuid4())
        project_dir = _make_project_dir("python")
        self.addCleanup(shutil.rmtree, project_dir, True)
        (project_dir / ".env").write_text(f"CRUCIBLE_PROJECT_KEY={key}\n")
        sha = _git_commit_fixture(project_dir)
        orchestrator = f"merge-post-{case}-orchestrator"
        gate_agent = orchestrator if orchestrator_runs_the_gate else f"merge-post-{case}-gate"
        plan_id, cycle_id = 7, 70
        scenario = {"cr": cr, "key": key, "project_dir": project_dir, "sha": sha,
                    "agent": orchestrator, "plan_id": plan_id, "cycle_id": cycle_id,
                    "bound": orchestrator_runs_the_gate}

        self.board.answer(
            "GET", f"/api/v2/projects/{key}/plans",
            {"ok": True, "plans": [
                {"planId": plan_id, "projectKey": key, "cr": cr, "status": "open",
                 "cycles": [{"id": cycle_id, "label": "solo", "kind": "red-green",
                             "status": "done"}]}],
             "lastClosedCr": None, "filed": 1}, prefix=True)
        counts = ({"passed": 2, "failed": 0} if gate_outcome == "pass"
                  else {"passed": 1, "failed": 1})
        gate = self.board.milestone_record(
            key, gate_agent, "pre-merge-gate", cr, outcome=gate_outcome,
            commit=sha, context={"cycleId": cycle_id, "cr": cr}, **counts)
        self.board.answer(
            "GET", f"/api/v2/projects/{key}/milestones?type=pre-merge-gate",
            dict(MILESTONES_ANSWER, milestones=[gate], totalCount=1))
        self._answer_the_marker_posts(scenario)
        return scenario

    def _answer_the_marker_posts(self, scenario):
        """The board's answer to a `cr-merged` post: a bound poster's first
        post is refused as a stale binding; every other post is recorded."""
        self.board.answer("POST", MILESTONES_PATH,
                          milestone_posted(self.board.mint_event_id()),
                          status=MILESTONE_POSTED_STATUS)
        if scenario["bound"]:
            self.board.answer(
                "POST", MILESTONES_PATH,
                {"ok": False,
                 "error": (f"bound cycle {scenario['cycle_id']} is in closed plan "
                           f"{scenario['cr']} — ingest refused, run NOT stored"),
                 "help": [f"unregister --agent {scenario['agent']}"]},
                status=409, times=1)

    def _cr_close(self, scenario, extra=(), board=None):
        result = self._drive(scenario, ["cr-close", "--agent", scenario["agent"],
                                        "--commit", scenario["sha"],
                                        "--cr", scenario["cr"], *extra],
                             board=board, timeout=60)
        _emits, axi = classify_envelope(result.stdout, self.toon)
        return result, axi or {}

    # ── shared assertions ───────────────────────────────────────────────────

    def _assert_closed_with_the_commit(self, scenario, reason=None):
        closes = self._closes(scenario)
        self.assertEqual(len(closes), 1, f"the plan is closed once; got {closes!r}")
        close = closes[0] or {}
        self.assertEqual(close.get("status"), "closed",
                         f"the close itself is sent; got {close!r}")
        self.assertEqual((close.get("merge") or {}).get("commit"), scenario["sha"],
                         f"the close carries the merge commit; got {close!r}")
        if reason is not None:
            self.assertEqual(
                (close.get("merge") or {}).get("acceptedFailingGateReason"), reason,
                f"the close carries the accepted gate's reason; got {close!r}")

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

        self._assert_closed_with_the_commit(scenario)
        self.assertEqual(len(self._cr_merged_posts(scenario)), 1,
                         "the marker is posted once, refused, and not retried")
        self._assert_reported_unrecorded(scenario, result, axi,
                                         self._stale_binding_error(scenario))

    def test_running_the_reported_remedy_records_the_cr_merged_milestone(self):
        scenario = self._scenario("remedy")
        result, axi = self._cr_close(scenario)
        self.assertEqual(len(self._cr_merged_posts(scenario)), 1,
                         "precondition: the refused post was the only one")

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

        before = len(self.board.posts())
        for argv in commands:
            step = self._drive(scenario, argv)
            self.assertEqual(step.returncode, 0,
                             f"remedy step {argv!r} failed: {step.stdout!r} {step.stderr!r}")

        remedy = self.board.posts()[before:]
        registered = [b for p, b in remedy if p == "/api/v2/agents/register"]
        self.assertTrue(
            registered and all(b.get("agentId") == scenario["agent"]
                               and b.get("role") == "ORCHESTRATOR"
                               and "cycleId" not in b for b in registered),
            f"the remedy re-registers the agent unbound, as ORCHESTRATOR; got {registered!r}")
        merged = self._cr_merged_posts(scenario)
        self.assertEqual(len(merged), 2,
                         f"the remedy posts the marker exactly once more; got {merged!r}")
        self.assertEqual(merged[-1].get("commit"), scenario["sha"],
                         f"the marker carries the merge commit; got {merged[-1]!r}")
        self.assertLess(
            [p for p, _ in remedy].index("/api/v2/agents/register"),
            [p for p, _ in remedy].index(MILESTONES_PATH),
            "the marker is posted after the unbound re-registration")

    def test_cr_close_over_an_accepted_failing_gate_reports_the_refused_post_the_same_way(self):
        scenario = self._scenario("accepted", gate_outcome="fail")
        result, axi = self._cr_close(scenario, extra=["--accept-failing-gate", ACCEPT_REASON])

        self._assert_closed_with_the_commit(scenario, reason=ACCEPT_REASON)
        merged = self._cr_merged_posts(scenario)
        self.assertEqual(len(merged), 1,
                         "the marker is posted once, refused, and not retried")
        self.assertEqual(merged[0].get("acceptedFailingGateReason"), ACCEPT_REASON,
                         f"the marker carries the accepted gate's reason; got {merged!r}")
        self._assert_reported_unrecorded(scenario, result, axi,
                                         self._stale_binding_error(scenario))

    # ── the board does not answer the post ──────────────────────────────────

    def test_a_cr_merged_post_the_board_does_not_answer_is_reported_the_same_way(self):
        scenario = self._scenario("unanswered", orchestrator_runs_the_gate=False)
        plan_path = f"/api/v2/projects/{scenario['key']}/plans/{scenario['plan_id']}"
        proxy = RecordingProxy(self.base)

        def stop_after_the_close(method, path, status):
            if method == "PATCH" and path == plan_path and status == 200:
                proxy.stop_listening()

        proxy.after = stop_after_the_close
        try:
            result, axi = self._cr_close(scenario, board=proxy.url)
        finally:
            proxy.close()

        relayed = proxy.requests
        self.assertIn(("PATCH", plan_path), relayed,
                      f"fixture: the close PATCH must have reached the board; "
                      f"relayed={relayed!r}")
        self.assertFalse(
            any(m == "POST" and p.startswith(MILESTONES_PATH) for m, p in relayed),
            "fixture: the proxy must never have relayed the milestone post")
        self._assert_closed_with_the_commit(scenario)
        self.assertEqual(self._cr_merged_posts(scenario), [],
                         "no board answered the post, so none reached it")
        self._assert_reported_unrecorded(scenario, result, axi, ("connection failed",))

    # ── a clean binding posts the marker, as today ─────────────────────────

    def test_cr_close_after_a_clean_re_registration_is_ok_and_records_the_marker(self):
        scenario = self._scenario("clean", orchestrator_runs_the_gate=False)
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
        self._assert_closed_with_the_commit(scenario)
        merged = self._cr_merged_posts(scenario)
        self.assertEqual(len(merged), 1,
                         f"a clean close posts exactly one cr-merged marker; got {merged!r}")
        self.assertEqual(merged[0].get("commit"), scenario["sha"],
                         f"the marker carries the merge commit; got {merged[0]!r}")


if __name__ == "__main__":
    unittest.main()
