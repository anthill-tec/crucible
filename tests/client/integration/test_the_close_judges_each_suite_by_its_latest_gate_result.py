"""`cr-close` judges a CR suite by suite: each suite's latest gate result
counts, so a failing suite re-run green by a scoped gate closes the CR without
overriding the gate.

The verdict, read from the CR's `pre-merge-gate` milestones in time order:

  * the BASE is the latest full gate. A milestone with no `scope` and no
    `suites` (the shape posted before gates recorded their suites) is a full
    gate; one with `suites` and no `scope` is never a base;
  * a base with no `suites`, or whose outcome is `fail` while none of its
    entries is, is judged by its own outcome;
  * otherwise, for each suite of the base, the latest result for that suite
    from any gate at or after the base counts; a scoped gate's entry for a
    target the base never ran is ignored. A gate after the base whose outcome
    is `fail` with no `suites` (stopped at its step 0, or escaped) makes the
    verdict red unless a later gate ran past its step 0;
  * green when every counted result passes; a scoped gate with no full gate
    before it never counts;
  * a refusal names the suites still red, and its help names
    `pre-merge-gate --suites <those suites>` — or a full gate when one of them
    is no longer declared;
  * `--accept-failing-gate`'s help and its unused-reason warning speak of the
    gate result, not of "the last pre-merge-gate".

Every case drives the REAL client's `cr-close` as an OS subprocess against a
recording board (`RecordingBoard`), steered only by the project's own
`crucible.toml` `[client] url` (`drive_verb`). The board answers in the
server's shapes: the CR's open plan (its cycle done), and the CR's gate
history as `GET …/milestones?type=pre-merge-gate` lists it — newest first,
each record a minted `evt-<ms>-<seq>` id and a strictly later millisecond
timestamp (`milestone_record`) — so the client's own oldest-first re-sort is
exercised. What the close did (the plan PATCH, the `cr-merged` post) is read
off the board's request log. The board's half — how milestones are listed
(newest first, stamped, a same-ms tie and a sequence past two digits) and a
gate's scope and suites read back unchanged — is held in bun by
`milestone-routes-order-and-refuse-as-clients-read-them.test.ts` and
`gate-milestone-scope-and-suites.test.ts`; a plan closed with a merge commit
carrying it by `closed-plans-read-carries-merge-and-title-verbatim.test.ts`.

`cr-close`'s verdict is one shared function (`gate_close_verdict`,
clients/_crucible_axi.py), but the call path is proved per client: the
"re-run green closes" and the "a different suite's re-run is refused" cases
run through each of the five clients; the remaining cases run through bun,
whose fixture declares two gated suites (`test:unit`, `test:client`).

Today `cr-close` reads only the CR's latest milestone's outcome. Cases that
hold today are marked GREEN-GUARD in their docstrings; every other case fails
today for the missing per-suite verdict (a refusal that closes, a close that
refuses, or a refusal that does not name the red suites).

Invocation:
    python3 clients/python-crucible.py test --tests \
        tests.client.integration.test_the_close_judges_each_suite_by_its_latest_gate_result
"""

import re
import shutil
import time
import unittest

from tests.client.a_scoped_gate_refuses_what_it_cannot_run_helpers import (
    TARGETS,
    _declare,
    _named,
)
from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
    enumerate_verbs,
)
from tests.client.live_run_harness import (
    MILESTONE_POSTED_STATUS,
    PLANS_ANSWER,
    RecordingBoard,
    milestone_posted,
)

GATE_TYPE = "pre-merge-gate"
CLOSE_VERB = "cr-close"
ACCEPT_FLAG = "--accept-failing-gate"
UNUSED_REASON_CODE = "accept-failing-gate-unused"
CLIENT_KEYS = ("bun", "python", "rust", "mvn", "arduino", "go")
#: The clients whose surface enumerates no suite declaration at all: a red
#: suite is never undeclared on them, and they cannot run a scoped gate.
NO_SUITE_CLIENTS = ("python",)
#: go's two gated suites on a module that declares the `integration` and
#: `bdd` tiers by build tag: the untagged run, and one declared tier.
GO_GATED = ("untagged", "integration")
#: The tier files the go fixture's module declares its tiers with, beside
#: the census module's one untagged test.
_GO_TIER_FILES = {
    "integ_test.go": ("//go:build integration\n\npackage probe\n\nimport \"testing\"\n\n"
                      "func TestIntegProbe(t *testing.T) {}\n"),
    "bdd_test.go": ("//go:build bdd\n\npackage probe\n\nimport \"testing\"\n\n"
                    "func TestBddProbe(t *testing.T) {}\n"),
}

#: A target no fixture declares, for the "no longer declared" help.
RETIRED_TARGET = "test:retired"

#: A `--suites` invocation in a help line: the flag and the targets it names
#: (comma-separated). A placeholder (`<targets>`) or a bare mention ("without
#: --suites") names no target and does not match.
_SUITES_INVOCATION = re.compile(
    r"--suites[ =]`?([^\s,`'\"()<>]+(?:,[^\s,`'\"()<>]+)*)")

def entry(target, outcome):
    """One suite entry as a gate posts it. A failing entry's failing test is
    named WITHOUT the target, so a refusal that names the target names the
    suite, not merely the failing test the milestone carried."""
    if outcome == "pass":
        return {"target": target, "outcome": "pass", "passed": 4, "failed": 0}
    return {"target": target, "outcome": "fail", "passed": 3, "failed": 1,
            "failingTests": ["GateFixture > known_failure_behaviour"]}


def full(*entries):
    return {"scope": "full", "suites": list(entries)}


def scoped(*entries):
    return {"scope": "scoped", "suites": list(entries)}


def scoped_stopped_at_step_zero():
    """A scoped gate that failed before it composed any suite: `fail`, no
    `suites`."""
    return {"scope": "scoped", "outcome": "fail", "passed": 0, "failed": 0}


def pre_suites_gate(outcome):
    """A gate milestone posted before gates recorded their suites: no `scope`,
    no `suites`."""
    gate = {"outcome": outcome, "passed": 5 if outcome == "pass" else 4,
            "failed": 0 if outcome == "pass" else 1}
    if outcome == "fail":
        gate["failingTests"] = ["GateFixture > known_failure_behaviour"]
    return gate


def suites_without_scope(*entries):
    return {"suites": list(entries)}


class _CloseJudgesSuiteBySuite(unittest.TestCase):
    """The project and declared project directory for ONE client; each test
    has its own board holding its own plan (one per CR) and that CR's gate
    history, and drives the client's `cr-close` for it."""

    CLIENT = ""
    #: go only: whether the project's module declares the `integration` and
    #: `bdd` tiers (a go project that declares no tier declares no suite).
    GO_DECLARES_TIERS = True
    #: Keeps two classes of one client on projects of their own.
    PROJECT_SUFFIX = ""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.toon = _load_toon_module()
        name = f"close-by-suite-{cls.CLIENT}{cls.PROJECT_SUFFIX}"
        cls.key = f"{name}-key"
        cls.orchestrator = f"{name}-orchestrator"
        cls.project_dir = _make_project_dir(cls.CLIENT)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={cls.key}\n"]
        if cls.CLIENT == "arduino":
            env_lines.append("CRUCIBLE_PROJECT_NAME=close-by-suite\n")
        (cls.project_dir / ".env").write_text("".join(env_lines))
        if cls.CLIENT == "go":
            # go declares a tier by build tag, read off the real `go list`.
            if cls.GO_DECLARES_TIERS:
                for name, text in _GO_TIER_FILES.items():
                    (cls.project_dir / name).write_text(text)
        elif cls.CLIENT not in NO_SUITE_CLIENTS:
            # python's surface enumerates no declaration at all.
            _declare(cls.CLIENT, cls.project_dir)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(getattr(cls, "project_dir", ""), ignore_errors=True)
        super().tearDownClass()

    @property
    def gated(self):
        """The fixture's two declared gated targets (python: two names it
        cannot declare)."""
        return TARGETS[self.CLIENT]["gated"]

    # ── the board: plan, gate history, reads ────────────────────────────────

    def _plan(self, cr):
        """This test's board, holding one open plan for `cr` whose one cycle
        is done, so the close meets no non-terminal cycle."""
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.board.answer("POST", "/api/v2/milestones",
                          milestone_posted(self.board.mint_event_id()),
                          status=MILESTONE_POSTED_STATUS)
        plan_id, cycle_id = 1, 701
        self.board.answer(
            "GET", f"/api/v2/projects/{self.key}/plans",
            {**PLANS_ANSWER, "filed": 1, "plans": [
                {"planId": plan_id, "projectKey": self.key, "cr": cr,
                 "status": "open", "orchestrator": self.orchestrator,
                 "cycles": [{"id": cycle_id, "label": "solo",
                             "kind": "red-green", "status": "done"}]}]},
            prefix=True)
        return plan_id, cycle_id

    def _milestones(self, mtype, cr):
        """Every `mtype` milestone labelled `cr` the client posted."""
        return [b for p, b in self.board.posts()
                if p == "/api/v2/milestones" and isinstance(b, dict)
                and b.get("type") == mtype and b.get("label") == cr]

    def _post_gate(self, cr, cycle_id, index, gate):
        """One `pre-merge-gate` milestone as a gate posts it. A gate given
        with `suites` and no explicit outcome takes its verdict and counts
        from its entries."""
        body = {"projectKey": self.key, "agentId": self.orchestrator,
                "type": GATE_TYPE, "label": cr,
                "commit": f"c0ffee{index:034x}",
                "context": {"cr": cr, "cycleId": cycle_id}}
        suites = gate.get("suites")
        if "outcome" not in gate and suites:
            failing = [t for e in suites for t in e.get("failingTests", [])]
            body.update({
                "outcome": "fail" if any(e["outcome"] == "fail" for e in suites)
                else "pass",
                "passed": sum(e.get("passed", 0) for e in suites),
                "failed": sum(e.get("failed", 0) for e in suites)})
            if failing:
                body["failingTests"] = failing
        body.update(gate)
        return body

    def _history(self, cr, *gates):
        """This test's board, holding `cr`'s plan and its gate history —
        given oldest first, each a second after the last — listed as the
        server lists it: newest first, each record stamped and minted
        (`milestone_record`). Returns the plan id."""
        plan_id, cycle_id = self._plan(cr)
        start = int(time.time() * 1000)
        records = []
        for index, gate in enumerate(gates):
            body = self._post_gate(cr, cycle_id, index, gate)
            fields = {k: v for k, v in body.items()
                      if k not in ("projectKey", "agentId", "type", "label")}
            records.append(self.board.milestone_record(
                self.key, self.orchestrator, GATE_TYPE, cr,
                at_ms=start + 1000 * index, **fields))
        stamps = [int(r["timestamp"]) for r in records]
        self.assertEqual(stamps, sorted(set(stamps)),
                         f"fixture: {cr}'s gates carry strictly increasing "
                         f"timestamps in posting order; got {stamps!r}")
        self.board.answer(
            "GET", f"/api/v2/projects/{self.key}/milestones?type={GATE_TYPE}",
            {"ok": True, "milestones": list(reversed(records)),
             "totalCount": len(records)})
        return plan_id

    def _plan_record(self, plan_id):
        """The plan as the close left it: `closed`, with the merge it sent,
        when the client PATCHed it closed; `open` otherwise."""
        plan_path = f"/api/v2/projects/{self.key}/plans/{plan_id}"
        writes = [b for p, b in self.board.posts() if p == plan_path]
        patched = [b for p, b in self.board.patches() if p == plan_path]
        self.assertEqual(writes, patched,
                         f"{self.CLIENT}: the plan is closed with a PATCH, never a "
                         f"POST; every write to it: {writes!r}, of them PATCHes: "
                         f"{patched!r}")
        closes = [b for b in patched
                  if isinstance(b, dict) and b.get("status") == "closed"]
        self.assertLessEqual(len(closes), 1,
                             f"the plan is closed at most once; got {closes!r}")
        if not closes:
            return {"planId": plan_id, "status": "open"}
        return {"planId": plan_id, "status": "closed",
                "merge": closes[0].get("merge")}

    # ── the close ───────────────────────────────────────────────────────────

    def _close(self, cr, commit, extra_argv=()):
        agent = f"{cr}-closer"
        script = CLIENT_FILES[self.CLIENT]
        verbs = enumerate_verbs(self.CLIENT, script)
        argv = (build_argv(CLOSE_VERB, verbs[CLOSE_VERB], self.project_dir)
                + ["--agent", agent, "--commit", commit, "--cr", cr]
                + list(extra_argv))
        bin_dir = _build_fake_bin_dir()
        self.addCleanup(shutil.rmtree, bin_dir, True)
        result = drive_verb(script, argv, self.project_dir, bin_dir,
                            timeout=60, board=self.board.url)
        _emits, axi = classify_envelope(result.stdout, self.toon)
        return result, axi or {}

    @staticmethod
    def _transcript(result):
        return (f"exit={result.returncode} "
                f"stdout={(result.stdout or '')[:1500]!r} "
                f"stderr={(result.stderr or '')[-1500:]!r}")

    def assertClosed(self, cr, plan_id, commit, result, axi):
        """Closed as a green gate closes: exit 0, `ok:true`, the plan closed at
        the commit with NO accepted-failing-gate reason, and one `cr-merged`
        milestone that carries none either."""
        self.assertEqual(
            (result.returncode, axi.get("verb"), axi.get("ok")),
            (0, CLOSE_VERB, True),
            f"{self.CLIENT}: {cr} closes on its gate result; "
            f"{self._transcript(result)}")
        plan = self._plan_record(plan_id)
        self.assertEqual(plan.get("status"), "closed", f"plan={plan!r}")
        merge = plan.get("merge") or {}
        self.assertEqual(merge.get("commit"), commit, f"plan={plan!r}")
        self.assertNotIn("acceptedFailingGateReason", merge,
                         f"{self.CLIENT}: a close on a green verdict records no "
                         f"accepted-failing-gate reason; plan={plan!r}")
        self.assertNotIn("acceptedFailingGateReason", axi,
                         f"{self.CLIENT}: axi={axi!r}")
        merged = self._milestones("cr-merged", cr)
        self.assertEqual(len(merged), 1,
                         f"{self.CLIENT}: exactly one cr-merged; got {merged!r}")
        self.assertNotIn("acceptedFailingGateReason", merged[0],
                         f"{self.CLIENT}: cr-merged={merged[0]!r}")

    def assertRefused(self, cr, plan_id, result, axi):
        """Refused: non-zero exit, one `ok:false` cr-close envelope with an
        error and help, the plan still open, no cr-merged. Returns
        `(error, help)`."""
        self.assertEqual(
            (axi.get("verb"), axi.get("ok")), (CLOSE_VERB, False),
            f"{self.CLIENT}: {cr} is refused on its gate result; "
            f"{self._transcript(result)}")
        self.assertNotEqual(result.returncode, 0, self._transcript(result))
        plan = self._plan_record(plan_id)
        self.assertEqual(plan.get("status"), "open",
                         f"{self.CLIENT}: a refused close closes nothing; "
                         f"plan={plan!r}")
        self.assertEqual(self._milestones("cr-merged", cr), [],
                         f"{self.CLIENT}: a refused close posts no cr-merged")
        error = axi.get("error")
        self.assertIsInstance(error, str, f"axi={axi!r}")
        help_ = axi.get("help")
        self.assertIsInstance(help_, list, f"axi={axi!r}")
        return error, [str(h) for h in help_]

    def assertNamesRedSuites(self, error, red):
        for target in red:
            self.assertTrue(_named(error, target),
                            f"{self.CLIENT}: the refusal names the suite still "
                            f"red, {target!r}; error={error!r}")

    @staticmethod
    def _scoped_reruns(help_):
        """The target set of every `pre-merge-gate … --suites <targets>` line
        in the help."""
        reruns = []
        for line in help_:
            if GATE_TYPE not in line:
                continue
            for match in _SUITES_INVOCATION.finditer(line):
                reruns.append(frozenset(match.group(1).split(",")))
        return reruns

    def assertHelpRerunsExactly(self, help_, red):
        self.assertIn(
            frozenset(red), self._scoped_reruns(help_),
            f"{self.CLIENT}: the help names `pre-merge-gate --suites "
            f"{','.join(red)}` — the suites still red, and only them; "
            f"help={help_!r}")

    def assertHelpNamesAFullGate(self, help_):
        self.assertEqual(
            self._scoped_reruns(help_), [],
            f"{self.CLIENT}: a red suite is no longer declared, so the help "
            f"offers no scoped re-run; help={help_!r}")
        self.assertTrue(
            any(GATE_TYPE in line and re.search(r"\bfull\b", line)
                for line in help_),
            f"{self.CLIENT}: the help names a FULL pre-merge-gate; "
            f"help={help_!r}")


class _EveryClientClosesSuiteBySuite(_CloseJudgesSuiteBySuite):
    """The close's two defining cases, through ONE client's `cr-close`."""

    def test_a_red_full_gate_whose_failing_suite_is_rerun_green_closes_without_an_accepted_reason(self):
        """GREEN-GUARD today: the latest milestone is the green re-run, which
        today's latest-outcome read also closes on."""
        red, other = self.gated
        cr = f"close-rerun-green-{self.CLIENT}"
        plan_id = self._history(
            cr,
            full(entry(red, "fail"), entry(other, "pass")),
            scoped(entry(red, "pass")))
        result, axi = self._close(cr, "feedc0de0010")
        self.assertClosed(cr, plan_id, "feedc0de0010", result, axi)

    def test_a_green_rerun_of_a_different_suite_is_refused_naming_the_suite_still_red(self):
        red, other = self.gated
        cr = f"close-rerun-other-{self.CLIENT}"
        plan_id = self._history(
            cr,
            full(entry(red, "fail"), entry(other, "pass")),
            scoped(entry(other, "pass")))
        result, axi = self._close(cr, "feedc0de0011")
        error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertNamesRedSuites(error, [red])
        if self.CLIENT in NO_SUITE_CLIENTS:
            # python and go declare no suites, so the red one is not declared here.
            self.assertHelpNamesAFullGate(help_)
        else:
            self.assertHelpRerunsExactly(help_, [red])


class BunClosesSuiteBySuiteTest(_EveryClientClosesSuiteBySuite):
    CLIENT = "bun"


class PythonClosesSuiteBySuiteTest(_EveryClientClosesSuiteBySuite):
    CLIENT = "python"

    def test_the_full_gate_help_says_this_client_cannot_run_a_scoped_gate(self):
        """python enumerates no declaration, so the red suite is not
        undeclared: the help gives the real cause \u2014 this client cannot run
        a scoped gate \u2014 and names a full gate."""
        red, other = self.gated
        cr = "close-python-cannot-scope"
        plan_id = self._history(
            cr,
            full(entry(red, "fail"), entry(other, "pass")),
            scoped(entry(other, "pass")))
        result, axi = self._close(cr, "feedc0de0012")
        _error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertHelpNamesAFullGate(help_)
        self.assertTrue(
            any(GATE_TYPE in line and re.search(r"\bfull\b", line)
                and re.search(r"cannot run a scoped gate", line)
                for line in help_),
            f"python: the full-gate help says this client cannot run a "
            f"scoped gate; help={help_!r}")
        self.assertFalse(
            any(re.search(r"no longer declared", line) for line in help_),
            f"python: the red suite was never undeclared, so the help does "
            f"not say it is; help={help_!r}")


class GoClosesSuiteBySuiteTest(_EveryClientClosesSuiteBySuite):
    """A go module that declares the `integration` and `bdd` tiers by build
    tag: its gate's suites are `untagged` and each declared tier, so a red
    one is re-run by a gate scoped to it."""

    CLIENT = "go"

    @property
    def gated(self):
        return GO_GATED

    def test_a_red_declared_tier_is_rerun_by_a_gate_scoped_to_it(self):
        cr = "close-go-rerun-tier"
        plan_id = self._history(
            cr,
            full(entry("untagged", "pass"), entry("integration", "fail"),
                 entry("bdd", "pass")),
            scoped(entry("bdd", "pass")))
        result, axi = self._close(cr, "feedc0de0013")
        error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertNamesRedSuites(error, ["integration"])
        self.assertHelpRerunsExactly(help_, ["integration"])


class GoProjectThatDeclaresNoTierClosesSuiteBySuiteTest(_CloseJudgesSuiteBySuite):
    """A go module that declares no tier declares no suite: every `--suites`
    is refused on it, so a red suite's refusal offers a full gate only."""

    CLIENT = "go"
    GO_DECLARES_TIERS = False
    PROJECT_SUFFIX = "-no-tier"

    def test_the_refusal_offers_a_full_gate_and_no_scoped_rerun(self):
        cr = "close-go-no-tier"
        plan_id = self._history(
            cr,
            full(entry("untagged", "fail"), entry("other", "pass")),
            scoped(entry("other", "pass")))
        result, axi = self._close(cr, "feedc0de0014")
        error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertNamesRedSuites(error, ["untagged"])
        self.assertHelpNamesAFullGate(help_)


class RustClosesSuiteBySuiteTest(_EveryClientClosesSuiteBySuite):
    CLIENT = "rust"


class MvnClosesSuiteBySuiteTest(_EveryClientClosesSuiteBySuite):
    CLIENT = "mvn"


class ArduinoClosesSuiteBySuiteTest(_EveryClientClosesSuiteBySuite):
    CLIENT = "arduino"


class TheSuiteBySuiteVerdictTest(_CloseJudgesSuiteBySuite):
    """The rest of the verdict's rule, through bun's `cr-close` (the verdict is
    the one shared function every client calls)."""

    CLIENT = "bun"

    def setUp(self):
        super().setUp()
        self.a, self.b = self.gated

    # ── no base ─────────────────────────────────────────────────────────────

    def test_a_green_scoped_gate_with_no_full_gate_before_it_is_refused(self):
        cr = "close-scoped-only"
        plan_id = self._history(cr, scoped(entry(self.a, "pass")))
        result, axi = self._close(cr, "feedc0de0020")
        self.assertRefused(cr, plan_id, result, axi)

    def test_a_green_gate_with_suites_and_no_scope_is_never_a_base_and_is_refused(self):
        cr = "close-suites-no-scope"
        plan_id = self._history(
            cr, suites_without_scope(entry(self.a, "pass"), entry(self.b, "pass")))
        result, axi = self._close(cr, "feedc0de0021")
        self.assertRefused(cr, plan_id, result, axi)

    # ── the base is the latest full gate ────────────────────────────────────

    def test_a_green_scoped_gate_older_than_the_latest_red_full_gate_is_refused_naming_its_red_suite(self):
        """The refusal holds today (the red full gate is latest); naming the
        red suite and offering its scoped re-run does not."""
        cr = "close-scoped-before-full"
        plan_id = self._history(
            cr,
            scoped(entry(self.a, "pass")),
            full(entry(self.a, "fail"), entry(self.b, "pass")))
        result, axi = self._close(cr, "feedc0de0022")
        error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertNamesRedSuites(error, [self.a])
        self.assertHelpRerunsExactly(help_, [self.a])

    def test_an_older_red_full_gate_rerun_green_does_not_rescue_a_newer_red_full_gate(self):
        """The refusal holds today (the newer red full gate is latest); naming
        the red suite and offering its scoped re-run does not."""
        cr = "close-two-full-gates"
        plan_id = self._history(
            cr,
            full(entry(self.a, "fail"), entry(self.b, "pass")),
            scoped(entry(self.a, "pass")),
            full(entry(self.a, "fail"), entry(self.b, "pass")))
        result, axi = self._close(cr, "feedc0de0023")
        error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertNamesRedSuites(error, [self.a])
        self.assertHelpRerunsExactly(help_, [self.a])

    # ── each suite's latest result counts ───────────────────────────────────

    def test_a_green_full_gate_followed_by_a_red_scoped_gate_of_one_suite_is_refused_naming_it(self):
        """The refusal holds today (the red scoped gate is latest); naming the
        red suite and offering its scoped re-run does not."""
        cr = "close-green-full-red-scoped"
        plan_id = self._history(
            cr,
            full(entry(self.a, "pass"), entry(self.b, "pass")),
            scoped(entry(self.a, "fail")))
        result, axi = self._close(cr, "feedc0de0024")
        error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertNamesRedSuites(error, [self.a])
        self.assertHelpRerunsExactly(help_, [self.a])

    def test_a_later_red_rerun_of_a_suite_overrides_its_earlier_green_naming_only_that_suite(self):
        """The refusal holds today (the red scoped gate is latest); naming
        only the suite still red does not."""
        cr = "close-later-red-rerun"
        plan_id = self._history(
            cr,
            full(entry(self.a, "fail"), entry(self.b, "pass")),
            scoped(entry(self.a, "pass")),
            scoped(entry(self.b, "fail")))
        result, axi = self._close(cr, "feedc0de0025")
        error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertNamesRedSuites(error, [self.b])
        self.assertHelpRerunsExactly(help_, [self.b])

    def test_two_red_suites_each_rerun_green_by_its_own_scoped_gate_close(self):
        """GREEN-GUARD today: the latest milestone is green."""
        cr = "close-two-reruns"
        plan_id = self._history(
            cr,
            full(entry(self.a, "fail"), entry(self.b, "fail")),
            scoped(entry(self.a, "pass")),
            scoped(entry(self.b, "pass")))
        result, axi = self._close(cr, "feedc0de0026")
        self.assertClosed(cr, plan_id, "feedc0de0026", result, axi)

    def test_a_scoped_entry_for_a_target_the_base_never_ran_is_ignored(self):
        cr = "close-ignores-unbased-target"
        plan_id = self._history(
            cr,
            full(entry(self.a, "fail")),
            scoped(entry(self.a, "pass")),
            scoped(entry(self.b, "fail")))
        result, axi = self._close(cr, "feedc0de0027")
        self.assertClosed(cr, plan_id, "feedc0de0027", result, axi)

    # ── a gate stopped at its step 0 ────────────────────────────────────────

    def test_a_scoped_gate_failing_at_step_zero_after_a_green_rerun_is_refused(self):
        """GREEN-GUARD today: the step-0 failure is the latest milestone."""
        cr = "close-step-zero-last"
        plan_id = self._history(
            cr,
            full(entry(self.a, "fail"), entry(self.b, "pass")),
            scoped(entry(self.a, "pass")),
            scoped_stopped_at_step_zero())
        result, axi = self._close(cr, "feedc0de0030")
        self.assertRefused(cr, plan_id, result, axi)

    def test_a_step_zero_failure_is_cleared_by_a_later_gate_that_ran_past_its_step_zero(self):
        """GREEN-GUARD today: the latest milestone is the green re-run."""
        cr = "close-step-zero-cleared"
        plan_id = self._history(
            cr,
            full(entry(self.a, "fail"), entry(self.b, "pass")),
            scoped_stopped_at_step_zero(),
            scoped(entry(self.a, "pass")))
        result, axi = self._close(cr, "feedc0de0031")
        self.assertClosed(cr, plan_id, "feedc0de0031", result, axi)

    # ── a base judged by its own outcome ────────────────────────────────────

    def test_a_red_full_gate_with_no_suites_is_refused_even_after_a_green_scoped_gate(self):
        cr = "close-pre-suites-red"
        plan_id = self._history(
            cr, pre_suites_gate("fail"), scoped(entry(self.a, "pass")))
        result, axi = self._close(cr, "feedc0de0040")
        self.assertRefused(cr, plan_id, result, axi)

    def test_a_green_full_gate_with_no_suites_closes_as_before(self):
        """GREEN-GUARD: a green gate of the pre-suites shape closes."""
        cr = "close-pre-suites-green"
        plan_id = self._history(cr, pre_suites_gate("pass"))
        result, axi = self._close(cr, "feedc0de0041")
        self.assertClosed(cr, plan_id, "feedc0de0041", result, axi)

    def test_a_failed_full_gate_with_no_failing_entry_is_judged_by_its_outcome(self):
        cr = "close-fail-without-fail-entry"
        plan_id = self._history(
            cr,
            {"scope": "full", "outcome": "fail", "passed": 8, "failed": 0,
             "suites": [entry(self.a, "pass"), entry(self.b, "pass")]},
            scoped(entry(self.a, "pass")))
        result, axi = self._close(cr, "feedc0de0042")
        self.assertRefused(cr, plan_id, result, axi)

    # ── the refusal's help ──────────────────────────────────────────────────

    def test_a_red_suite_no_longer_declared_makes_the_help_name_a_full_gate(self):
        cr = "close-undeclared-red-suite"
        plan_id = self._history(
            cr, full(entry(self.a, "fail"), entry(RETIRED_TARGET, "fail")))
        result, axi = self._close(cr, "feedc0de0050")
        error, help_ = self.assertRefused(cr, plan_id, result, axi)
        self.assertNamesRedSuites(error, [self.a, RETIRED_TARGET])
        self.assertHelpNamesAFullGate(help_)

    # ── the accept flag speaks of the gate result ───────────────────────────

    def test_an_accept_reason_over_a_green_verdict_warns_of_the_gate_result_and_is_not_recorded(self):
        cr = "close-unused-accept-reason"
        reason = "fixture-reason-over-a-green-verdict"
        plan_id = self._history(
            cr,
            full(entry(self.a, "fail"), entry(self.b, "pass")),
            scoped(entry(self.a, "pass")))
        result, axi = self._close(cr, "feedc0de0060",
                                  extra_argv=[ACCEPT_FLAG, reason])
        self.assertClosed(cr, plan_id, "feedc0de0060", result, axi)
        unused = [w for w in axi.get("warnings") or []
                  if isinstance(w, dict) and w.get("code") == UNUSED_REASON_CODE]
        self.assertEqual(len(unused), 1,
                         f"one unused-reason warning; axi={axi!r}")
        detail = str(unused[0].get("detail") or "").lower()
        self.assertNotIn("last pre-merge-gate", detail,
                         f"the warning speaks of the gate result, not the last "
                         f"pre-merge-gate; warning={unused[0]!r}")
        self.assertIn("gate result", detail,
                      f"the warning speaks of the gate result; "
                      f"warning={unused[0]!r}")


# The per-client base is a template, not a test class of its own.
del _EveryClientClosesSuiteBySuite


class TheAcceptFlagSpeaksOfTheGateResultTest(unittest.TestCase):

    def test_every_clients_accept_failing_gate_help_speaks_of_the_gate_result(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                verbs = enumerate_verbs(client_key, CLIENT_FILES[client_key])
                actions = [a for a in verbs[CLOSE_VERB]._actions
                           if ACCEPT_FLAG in a.option_strings]
                self.assertEqual(len(actions), 1,
                                 f"{client_key}: cr-close declares {ACCEPT_FLAG}")
                help_text = " ".join(str(actions[0].help or "").split()).lower()
                self.assertNotIn(
                    "last pre-merge-gate", help_text,
                    f"{client_key}: {ACCEPT_FLAG}'s help speaks of the gate "
                    f"result, not the last pre-merge-gate; help={help_text!r}")
                self.assertIn(
                    "gate result", help_text,
                    f"{client_key}: {ACCEPT_FLAG}'s help speaks of the gate "
                    f"result; help={help_text!r}")


if __name__ == "__main__":
    unittest.main()
