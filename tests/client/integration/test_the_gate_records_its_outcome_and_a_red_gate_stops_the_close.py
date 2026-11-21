"""RED — the gate-measures-the-code change's §S2, the SECOND of its two
cycles ("the gate milestone and the close"): the first paragraph read for this
cycle is "Each `pre-merge-gate`
ends by posting one milestone…" through "A red gate stops the close" — the
four acceptance criteria "The gate records its outcome", "A red gate refuses
the close", "An accepted failure is recorded" and "A green gate closes as
today". The sibling run-attribution paragraph ("An unattributed run is
refused") is the OTHER §S2 cycle (already landed —
`tests/client/integration/test_an_unattributed_run_is_refused_while_a_cycle_is_active.py`)
and is out of this file's scope.

Driven against a fake board (`RecordingBoard`, CR-CRU-262): one per
`pre-merge-gate` drive and one per `cr-close` drive, each answering in the
server's shapes. Each of the clients' `pre-merge-gate`/`cr-close` is driven as
a genuine OS subprocess, argv built from each client's OWN real argparse
(`test_client_fleet_envelope_census.py`'s `enumerate_verbs`/`build_argv`),
toolchains stubbed by small fake executables (cargo/mvn/bun/go) or by writing
the native JUnit the fixture itself produces (arduino) or by real Python test
files (python — `py_compile` + `xmlrunner` need no stub at all).

What each fake board holds, as the server would hold it:

  * a gate's board: health stating `milestones.gate` (`src/server.ts`), the
    project's plans so far (each one cycle, `done`), every ingest answered
    `ok` with a minted event id and the counts the server decodes from the
    fixture's suite (one passing test; or one passing and one failing), the
    event read of each run serving its tree, and a recorded milestone
    answered 201 with a minted id;
  * a close's board: the project's four plans, and the CR's gate history —
    the very `pre-merge-gate` milestones this client's gates POSTED, listed
    as the store lists them (`milestone_record`, newest first).

So the chain gate → close is still the client's own: the close judges the
milestone its gate sent. What the server does with what it is sent — the
counts and tree it decodes from a report, the milestone it stores and lists,
the plan it closes, the reason it keeps and the History it serves — is the
server's half, held in bun:

  * `v2-runs-events.test.ts` "junit data w/ 1 failing case → 200 {ok:true,
    changed:true, event:'evt-…', verdict starting 'RED'}" and "GET
    /api/v2/events/:id → {ok:true, event} full detail (tree present)";
  * `gate-milestone-scope-and-suites.test.ts` "a full gate's scope and two
    suite entries read back unchanged through the milestone read, beside
    today's verdict" (outcome, passed, failed, failingTests);
    `evidence-route-is-discoverable.test.ts` "§S3 — a milestone filed by a
    cycle-BOUND agent with NO explicit context is returned by the read its own
    reply advertises" (the cycle on the record);
  * `a-close-over-an-accepted-failing-gate-keeps-its-reason.test.ts` "stores
    the reason as given, and the plans read serves it back under
    merge.acceptedFailingGateReason beside the commit", "a cr-merged marker
    posted with the reason reads back carrying it exactly; one posted without
    carries no reason key" and "lists each close over an accepted failing gate
    with its cr, planId, commit, reason and closedAt, oldest close first,
    leaving out every other plan".

What this file keeps is the client's half: what each client SENT (the
report naming the failing test, the one milestone and its fields, the plan
PATCH and its merge, the one `cr-merged`) read off the request log, and what
it PRINTED and exited with.

RED phase — TODAY, none of this exists:
  * `pre-merge-gate` never posts a `pre-merge-gate` milestone at all (grepped:
    no client calls `post_milestone(..., "pre-merge-gate", ...)` anywhere), so
    every milestone-presence assertion below starts from an EMPTY list.
  * the milestone type `pre-merge-gate` is neither SEEDED nor RESERVED
    (`src/store.ts` — `SEEDED_MILESTONE_TYPES`/`RESERVED_MILESTONE_TYPES`), so
    even a manual POST of one is refused 400 today.
  * `cr-close` (`cmd_cr_close`, `clients/_crucible_axi.py`) never reads a gate
    result at all — it closes an OPEN plan unconditionally — so every
    refusal case below instead SUCCEEDS today (closes the plan), and
    `--accept-failing-gate` is not a recognised flag on any of the five
    clients' argparse at all (an unrecognised-argument exit, not an AXI
    envelope).

ESCALATION — the change's own spec prose names WHAT a `pre-merge-gate`
milestone carries ("the CR, the outcome, the counts, the failing tests, the
head commit") but never the wire shape: no spec document pins field names for
a fact that does not exist in the schema yet (`recordMilestoneEvent`'s `meta`
is a closed set:
label/commit/context/releasedAt/crs/packages/targetAt/deliveredAt/
repairProvenance — none of "outcome"/"passed"/"failed"/"failingTests"). This
file commits to ONE concrete, defensible contract so the acceptance criteria
are assertable rather than vacuous, and states it here for the GREEN agent
(and the orchestrator, who should confirm or correct it before GREEN lands):

  pre-merge-gate milestone (POST /api/v2/milestones, type="pre-merge-gate"):
    label          = the CR the gated cycle's plan belongs to (the existing
                     field — the same one `cr-merged` already uses for a CR
                     id, same precedent)
    commit         = the repo's HEAD commit sha at gate time (the existing
                     `commit` field — same precedent)
    context.cycleId = the `--cycle <id>` the gate ran under (the existing
                     context-attach seam every ingest already uses)
    outcome        = the literal string "pass" or "fail" (NEW)
    passed, failed = the suite's counts, matching `RunSummary`'s own
                     `passed`/`failed` naming (`src/types.ts`) (NEW)
    failingTests   = array of failing test identifiers, PRESENT only when
                     `failed > 0` (never an empty array on a pass) (NEW)

  `cr-close`'s refusal/acceptance is asserted on what it SENT (the plan
  PATCH and its `merge`, read off the request log), exit code, `ok`, and on
  substrings of its own printed output (stdout TOON envelope + stderr legacy
  line combined) for the "naming the run, its failed count and the failing
  tests" / "a help entry naming pre-merge-gate" requirements — deliberately
  NOT pinned to an exact new JSON field there, since the CLI's "naming" is
  itself prose, not a wire contract.

  `cr-close --accept-failing-gate "<reason>"`: the plan PATCH's `merge`
  object carries the reason under `acceptedFailingGateReason` (extending the
  existing `merge: {commit}` shape — NEW key), and the `cr-merged` milestone
  carries it under the same key name (NEW). The History serving it
  (`acceptedFailingGates`) is the server's half, cited above.

No CR-shaped literal is used anywhere (fixture CRs are lowercase,
`gate-fixture-<client>-<case>`, which cannot match `CR-[A-Z]+-[0-9]+`).

Invocation:
    python3 -m unittest tests.client.integration.test_the_gate_records_its_outcome_and_a_red_gate_stops_the_close -v
"""

import shutil
import time
import unittest

from tests.client.client_fleet_envelope_census_helpers import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
    enumerate_verbs,
    fake_go_body,
)
from tests.client.live_run_harness import (
    MILESTONE_POSTED_STATUS,
    PLANS_ANSWER,
    RecordingBoard,
    milestone_posted,
)
from tests.client.the_gate_records_its_outcome_and_a_red_gate_stops_the_close_helpers import (
    _PY_TEST_FAIL,
    _PY_TEST_PASS,
    _SILENT_MAKE_BODY,
    FAILING_TEST_MARKER,
    PASSING_TEST_NAME,
    _fail_bin_dir_for,
    _failing_tests_sent,
    _git_commit_fixture,
    _overwrite_fake_tool,
    _write_native_fixture,
)

CLIENT_KEYS = ("bun", "python", "rust", "mvn", "arduino", "go")

GATE_TYPE = "pre-merge-gate"
MILESTONES_PATH = "/api/v2/milestones"
#: The run ingest routes, and the compile one (`RUN_INGEST_PATHS`,
#: `COMPILE_INGEST_PATH`, clients/_crucible_axi.py).
RUN_INGEST_PATHS = ("/api/v2/runs", "/api/v2/runs/parsed")
COMPILE_INGEST_PATH = "/api/v2/runs/compile"
#: How many ingests of one route a gate's board answers with an id of its own.
IDS_PER_ROUTE = 8
#: The gate drives: the case, and the outcome of the suite it runs.
GATE_CASES = (("pass", "pass"), ("fail", "fail"), ("accept", "fail"))
#: The counts the server decodes from each fixture's suite: the passing one
#: runs one passing test; the failing one, that test and one failing beside it.
BOARD_COUNTS = {"pass": {"total": 1, "passed": 1, "failed": 0},
                "fail": {"total": 2, "passed": 1, "failed": 1}}
#: The suite name of the tree the board serves for a fixture's run.
FIXTURE_SUITE = "gate-fixture"


# The passing fake `go`, cut to its first (passing) test.
_ONE_PASSING_GO_BODY = fake_go_body("pass").replace(
    'TESTS = ["Test_alpha_behaviour_passes", "Test_gate_fixture_known_failure"]',
    'TESTS = ["Test_alpha_behaviour_passes"]')
_STOCK_PASSING_GO_BODY = fake_go_body("pass")
assert _STOCK_PASSING_GO_BODY != _ONE_PASSING_GO_BODY, "the fake go's test list moved"


def _run_event(project_key, event_id, outcome):
    """A filed run as the event read serves it (`GET /api/v2/events/<id>`):
    its counts and the tree the board decoded, a failing fixture's second
    test failing."""
    counts = BOARD_COUNTS[outcome]
    leaves = [{"name": PASSING_TEST_NAME, "status": "pass"}]
    if outcome == "fail":
        leaves.append({"name": FAILING_TEST_MARKER, "status": "fail"})
    return {"ok": True, "event": {
        "id": event_id, "projectKey": project_key, "kind": "test",
        "summary": dict(counts),
        "tree": [{"name": FIXTURE_SUITE, "children": leaves}]}}


def _gate_board(project_key, plans, outcome):
    """A gate drive's board: health stating `milestones.gate`, the project's
    plans so far, each ingest answered with a fresh minted event id (a run
    ingest with the fixture's counts), each run's event read serving its
    tree, and a recorded milestone answered 201. Returns the board and the
    event ids it answers run ingests with."""
    board = RecordingBoard()
    run_event_ids = []
    health = board.default_health()
    health["milestones"] = {"gate": ["scope", "suites"]}
    board.script_health(health)
    board.answer("POST", MILESTONES_PATH, milestone_posted(board.mint_event_id()),
                 status=MILESTONE_POSTED_STATUS)
    board.answer("GET", f"/api/v2/projects/{project_key}/plans",
                 {**PLANS_ANSWER, "plans": plans, "filed": len(plans)}, prefix=True)
    for path in RUN_INGEST_PATHS + (COMPILE_INGEST_PATH,):
        ids = [board.mint_event_id() for _ in range(IDS_PER_ROUTE)]
        # The newest answer set is given first: set them last-to-first.
        for event_id in reversed(ids):
            body = {"ok": True, "changed": True, "event": event_id}
            if path in RUN_INGEST_PATHS:
                body["run"] = dict(BOARD_COUNTS[outcome])
                board.answer("GET", f"/api/v2/events/{event_id}",
                             _run_event(project_key, event_id, outcome))
                run_event_ids.append(event_id)
            board.answer("POST", path, body, times=1)
    return board, run_event_ids


def _milestones_sent(posts, mtype, cr_label):
    """Every `mtype` milestone labelled `cr_label` among `posts`, as sent."""
    return [b for p, b in posts
            if p == MILESTONES_PATH and isinstance(b, dict)
            and b.get("type") == mtype and b.get("label") == cr_label]


def _run_bodies_sent(posts):
    """Everything a drive sent on the run routes: each start, stream batch,
    test list and ingest."""
    return [b for p, b in posts if p.startswith("/api/v2/runs")]


class TheGateRecordsItsOutcomeAndARedGateStopsTheCloseTest(unittest.TestCase):
    """One project PER CLIENT, each carrying four independent plans (`pass`,
    `fail`, `none`, `accept`); each gate drive and each close drive has a
    fake board of its own, so no test method reads what another one did —
    every assertion below is reachable regardless of which subset of this
    file's tests is run."""

    @classmethod
    def setUpClass(cls):
        cls._scratch_dirs = []
        try:
            cls.toon = _load_toon_module()
            cls.fixtures = {}
            for client_key in CLIENT_KEYS:
                cls.fixtures[client_key] = cls._build_client_fixture(client_key)
        except BaseException:
            cls._cleanup_scratch()
            raise

    @classmethod
    def _cleanup_scratch(cls):
        for d in cls._scratch_dirs:
            shutil.rmtree(d, ignore_errors=True)
        cls._scratch_dirs = []

    @classmethod
    def tearDownClass(cls):
        cls._cleanup_scratch()

    # ── per-client fixture construction ─────────────────────────────────────

    @classmethod
    def _project_dir(cls, client_key, project_key, label):
        d = _make_project_dir(client_key)
        cls._scratch_dirs.append(d)
        env_lines = [f"CRUCIBLE_PROJECT_KEY={project_key}\n"]
        if client_key == "arduino":
            env_lines.append(f"CRUCIBLE_PROJECT_NAME=gate-fixture-{label}\n")
        (d / ".env").write_text("".join(env_lines))
        if client_key == "python":
            (d / "tests" / "test_probe.py").unlink(missing_ok=True)
        return d

    @staticmethod
    def _plan(fixture, cr_label):
        """File one plan whose one cycle is already `done` — `cr-close`
        refuses ANY plan carrying a non-terminal cycle (an already-established,
        unrelated guard), unconditionally of gate state, so every fixture plan
        here must already be past that guard before this file's OWN
        gate-close assertions can be exercised cleanly."""
        plans = fixture["plans"]
        plan_id = len(plans) + 1
        cycle_id = 700 + plan_id
        plans.append({"planId": plan_id, "projectKey": fixture["key"], "cr": cr_label,
                      "status": "open", "orchestrator": fixture["orchestrator"],
                      "cycles": [{"id": cycle_id, "label": "solo",
                                  "kind": "red-green", "status": "done"}]})
        return plan_id, cycle_id

    @classmethod
    def _drive_pre_merge_gate(cls, client_key, project_dir, agent_id, cycle_id,
                              bin_dir, board_url, extra_argv=()):
        script_path = CLIENT_FILES[client_key]
        verbs = enumerate_verbs(client_key, script_path)
        argv = build_argv("pre-merge-gate", verbs["pre-merge-gate"], project_dir)
        argv = argv + ["--agent", agent_id, "--cycle", str(cycle_id)] + list(extra_argv)
        result = drive_verb(script_path, argv, project_dir, bin_dir, timeout=120,
                            board=board_url)
        emits, axi = classify_envelope(result.stdout, cls.toon)
        return result, emits, axi or {}

    @classmethod
    def _build_client_fixture(cls, client_key):
        """One project for this client, carrying four plans (`pass`/`fail`/
        `none`/`accept`) and the driven `pre-merge-gate` result for each of
        the three that ran one (`none` never runs a gate at all — AC "A CR
        with no recorded pre-merge-gate result"), with what each gate sent."""
        key = f"gate-milestone-{client_key}-key"
        fixture = {"key": key, "orchestrator": f"gate-fixture-{client_key}-orchestrator",
                   "plans": [], "cases": {}}

        pass_bin = _build_fake_bin_dir()
        if client_key == "arduino":
            _overwrite_fake_tool(pass_bin, "make", _SILENT_MAKE_BODY)
        if client_key == "go":
            # The passing fixture runs ONE passing test, as every other
            # client's does (orchestrator-approved re-seed fix).
            _overwrite_fake_tool(pass_bin, "go", _ONE_PASSING_GO_BODY)
        cls._scratch_dirs.append(pass_bin)
        fail_bin = _fail_bin_dir_for(client_key)
        cls._scratch_dirs.append(fail_bin)
        extra = ["--skip-clippy", "--min-free-g", "1"] if client_key == "rust" else []

        for case, outcome in GATE_CASES:
            cr_label = f"gate-fixture-{client_key}-{case}"
            plan_id, cycle_id = cls._plan(fixture, cr_label)
            project_dir = cls._project_dir(client_key, key, f"{client_key}-{case}")
            if client_key == "python":
                (project_dir / "tests" / "test_gate_fixture.py").write_text(
                    _PY_TEST_PASS if outcome == "pass" else _PY_TEST_FAIL)
            if client_key == "arduino":
                _write_native_fixture(project_dir, outcome)
            head_sha = _git_commit_fixture(project_dir)
            bin_dir = pass_bin if outcome == "pass" else fail_bin
            agent_id = f"gate-fixture-{client_key}-{case}-agent"
            board, run_event_ids = _gate_board(key, fixture["plans"], outcome)
            try:
                result, emits, axi = cls._drive_pre_merge_gate(
                    client_key, project_dir, agent_id, cycle_id, bin_dir,
                    board.url, extra)
            finally:
                board.close()
            fixture["cases"][case] = {
                "cr": cr_label, "plan_id": plan_id, "cycle_id": cycle_id,
                "project_dir": project_dir, "head_sha": head_sha,
                "outcome": outcome, "result": result, "emits": emits, "axi": axi,
                "posts": board.posts(),
                "reads": [p for _t, m, p, _b in board.events if m == "GET"],
                "run_event_ids": run_event_ids,
            }
        # The fourth plan: filed, but NO pre-merge-gate ever ran against it.
        none_cr = f"gate-fixture-{client_key}-none"
        none_plan_id, none_cycle_id = cls._plan(fixture, none_cr)
        fixture["cases"]["none"] = {
            "cr": none_cr, "plan_id": none_plan_id, "cycle_id": none_cycle_id,
        }
        return fixture

    # ── read helpers ─────────────────────────────────────────────────────────

    def _gate_posts(self, client_key):
        """Every request this client's three gate drives sent, in drive order."""
        cases = self.fixtures[client_key]["cases"]
        return [post for case, _outcome in GATE_CASES for post in cases[case]["posts"]]

    def _gate_milestones_for_cr(self, client_key, cr_label):
        """Every `pre-merge-gate` milestone labelled `cr_label` this client's
        gates sent, across all three of its drives."""
        return _milestones_sent(self._gate_posts(client_key), GATE_TYPE, cr_label)

    def _close_board(self, client_key):
        """A close drive's board: the project's four plans, and the
        `pre-merge-gate` milestones this client's gates sent, as the store
        lists them — stamped a second apart in the order they were sent,
        newest first."""
        fixture = self.fixtures[client_key]
        board = RecordingBoard()
        self.addCleanup(board.close)
        board.answer("POST", MILESTONES_PATH, milestone_posted(board.mint_event_id()),
                     status=MILESTONE_POSTED_STATUS)
        board.answer("GET", f"/api/v2/projects/{fixture['key']}/plans",
                     {**PLANS_ANSWER, "plans": fixture["plans"],
                      "filed": len(fixture["plans"])}, prefix=True)
        start = int(time.time() * 1000)
        sent = [b for p, b in self._gate_posts(client_key)
                if p == MILESTONES_PATH and isinstance(b, dict)
                and b.get("type") == GATE_TYPE]
        records = []
        for index, body in enumerate(sent):
            fields = {k: v for k, v in body.items()
                      if k not in ("projectKey", "agentId", "type", "label")}
            records.append(board.milestone_record(
                fixture["key"], body.get("agentId"), GATE_TYPE, body.get("label"),
                at_ms=start + 1000 * index, **fields))
        board.answer("GET", f"/api/v2/projects/{fixture['key']}/milestones?type={GATE_TYPE}",
                     {"ok": True, "milestones": list(reversed(records)),
                      "totalCount": len(records)})
        return board

    def _plan_record(self, board, project_key, plan_id):
        """The plan as the close left it: `closed`, with the merge it sent,
        when the client PATCHed it closed; `open` otherwise."""
        plan_path = f"/api/v2/projects/{project_key}/plans/{plan_id}"
        writes = [b for p, b in board.posts() if p == plan_path]
        patched = [b for p, b in board.patches() if p == plan_path]
        self.assertEqual(writes, patched,
                         f"the plan is closed with a PATCH, never a POST; every "
                         f"write to it: {writes!r}, of them PATCHes: {patched!r}")
        closes = [b for b in patched
                  if isinstance(b, dict) and b.get("status") == "closed"]
        self.assertLessEqual(len(closes), 1,
                             f"the plan is closed at most once; got {closes!r}")
        if not closes:
            return {"planId": plan_id, "status": "open"}
        return {"planId": plan_id, "status": "closed", "merge": closes[0].get("merge")}

    def _drive_cr_close(self, client_key, project_dir, agent_id, cr_label,
                        commit="deadbeef0001", extra_argv=()):
        board = self._close_board(client_key)
        script_path = CLIENT_FILES[client_key]
        verbs = enumerate_verbs(client_key, script_path)
        argv = build_argv("cr-close", verbs["cr-close"], project_dir)
        argv = argv + ["--agent", agent_id, "--commit", commit, "--cr", cr_label] + list(extra_argv)
        bin_dir = _build_fake_bin_dir()
        self.addCleanup(shutil.rmtree, bin_dir, True)
        result = drive_verb(script_path, argv, project_dir, bin_dir,
                            timeout=60, board=board.url)
        emits, axi = classify_envelope(result.stdout, self.toon)
        combined_text = (result.stdout or "") + "\n" + (result.stderr or "")
        return result, emits, (axi or {}), combined_text, board

    # ── AC "The gate records its outcome" — a PASSING run ───────────────────

    def test_pre_merge_gate_posts_exactly_one_milestone_on_a_passing_run_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["pass"]
                self.assertEqual(
                    case["result"].returncode, 0,
                    f"{client_key}: a PASSING fake suite must leave pre-merge-gate "
                    f"itself exiting 0; stdout={case['result'].stdout.strip()[:800]!r} "
                    f"stderr={case['result'].stderr.strip()[-2000:]!r}")
                self.assertEqual(
                    _failing_tests_sent(_run_bodies_sent(case["posts"])), [],
                    f"{client_key}: the passing gate's suite reports no failing "
                    f"test in what it sent; posts={case['posts']!r}")
                records = self._gate_milestones_for_cr(client_key, case["cr"])
                self.assertEqual(
                    len(records), 1,
                    f"{client_key}: a passing pre-merge-gate --cycle "
                    f"{case['cycle_id']} must post EXACTLY ONE pre-merge-gate "
                    f"milestone for {case['cr']!r}; got {len(records)}: {records!r}")
                record = records[0]
                self.assertEqual(
                    (record.get("context") or {}).get("cycleId"), case["cycle_id"],
                    f"{client_key}: the milestone must be filed under the cycle the "
                    f"gate ran under ({case['cycle_id']}); got {record!r}")
                self.assertEqual(
                    record.get("label"), case["cr"],
                    f"{client_key}: the milestone must carry the CR the gated "
                    f"cycle's plan belongs to ({case['cr']!r}); got {record!r}")
                self.assertEqual(
                    record.get("commit"), case["head_sha"],
                    f"{client_key}: the milestone must carry the repo's HEAD "
                    f"commit at gate time ({case['head_sha']!r}); got {record!r}")
                self.assertEqual(
                    record.get("outcome"), "pass",
                    f"{client_key}: a passing gate's milestone outcome must be "
                    f"'pass'; got {record!r}")
                self.assertEqual(
                    record.get("passed"), 1,
                    f"{client_key}: the passing fixture ran exactly one passing "
                    f"test; got passed={record.get('passed')!r} in {record!r}")
                self.assertEqual(
                    record.get("failed"), 0,
                    f"{client_key}: a passing gate's milestone must carry "
                    f"failed=0; got {record!r}")
                self.assertNotIn(
                    "failingTests", record,
                    f"{client_key}: a passing gate's milestone must carry NO "
                    f"failingTests key at all (nothing failed); got {record!r}")

    # ── AC "The gate records its outcome" — a FAILING run ───────────────────

    def test_pre_merge_gate_posts_exactly_one_milestone_on_a_failing_run_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["fail"]
                sent_failing = _failing_tests_sent(_run_bodies_sent(case["posts"]))
                self.assertTrue(
                    any(FAILING_TEST_MARKER in name for name in sent_failing),
                    f"{client_key}: the failing gate's suite sent the REAL failing "
                    f"test ({FAILING_TEST_MARKER!r}) as failing; sent "
                    f"failing={sent_failing!r}")
                records = self._gate_milestones_for_cr(client_key, case["cr"])
                self.assertEqual(
                    len(records), 1,
                    f"{client_key}: a failing pre-merge-gate --cycle "
                    f"{case['cycle_id']} must STILL post EXACTLY ONE "
                    f"pre-merge-gate milestone for {case['cr']!r} ('it posts it "
                    f"on a failing gate too'); got {len(records)}: {records!r}")
                record = records[0]
                self.assertEqual(
                    (record.get("context") or {}).get("cycleId"), case["cycle_id"],
                    f"{client_key}: got {record!r}")
                self.assertEqual(
                    record.get("label"), case["cr"],
                    f"{client_key}: got {record!r}")
                self.assertEqual(
                    record.get("commit"), case["head_sha"],
                    f"{client_key}: got {record!r}")
                self.assertEqual(
                    record.get("outcome"), "fail",
                    f"{client_key}: a failing gate's milestone outcome must be "
                    f"'fail'; got {record!r}")
                self.assertEqual(
                    record.get("passed"), 1,
                    f"{client_key}: the failing fixture ran one passing test "
                    f"beside the failing one; got {record!r}")
                self.assertEqual(
                    record.get("failed"), 1,
                    f"{client_key}: the failing fixture ran exactly one failing "
                    f"test; got {record!r}")
                read_back = [p for p in case["reads"]
                             if p.split("?")[0] in {f"/api/v2/events/{i}"
                                                    for i in case["run_event_ids"]}]
                self.assertTrue(
                    read_back,
                    f"{client_key}: the gate names its failing tests from the "
                    f"board's read of a run it filed (GET /api/v2/events/<id> "
                    f"of an id its ingest was answered with); reads={case['reads']!r}")
                failing_tests = record.get("failingTests")
                self.assertIsInstance(
                    failing_tests, list,
                    f"{client_key}: a failing gate's milestone must carry a "
                    f"failingTests LIST; got {record!r}")
                self.assertTrue(
                    any(FAILING_TEST_MARKER in str(t) for t in failing_tests or []),
                    f"{client_key}: failingTests must name the REAL failing "
                    f"test ({FAILING_TEST_MARKER!r}), not a placeholder; got "
                    f"failingTests={failing_tests!r}")

    # ── AC "A red gate refuses the close" — last gate FAILED ────────────────

    def test_cr_close_refuses_when_the_last_gate_failed_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["fail"]
                key = self.fixtures[client_key]["key"]
                result, emits, axi, text, board = self._drive_cr_close(
                    client_key, case["project_dir"],
                    f"gate-fixture-{client_key}-fail-close-agent", case["cr"])
                self.assertNotEqual(
                    result.returncode, 0,
                    f"{client_key}: cr-close on a CR whose last pre-merge-gate "
                    f"FAILED must exit non-zero; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                plan = self._plan_record(board, key, case["plan_id"])
                self.assertEqual(
                    plan.get("status"), "open",
                    f"{client_key}: a refused cr-close must close NOTHING — "
                    f"the plan must still be 'open'; got plan={plan!r}")
                self.assertIn(
                    "1", text,
                    f"{client_key}: the refusal must name the failed count "
                    f"(1); got combined output={text[:2000]!r}")
                self.assertIn(
                    FAILING_TEST_MARKER, text,
                    f"{client_key}: the refusal must name the failing test; "
                    f"got combined output={text[:2000]!r}")

    # ── AC "A red gate refuses the close" — NO gate result at all ───────────

    def test_cr_close_refuses_when_no_gate_result_exists_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                none_case = self.fixtures[client_key]["cases"]["none"]
                pass_case = self.fixtures[client_key]["cases"]["pass"]
                key = self.fixtures[client_key]["key"]
                records = self._gate_milestones_for_cr(client_key, none_case["cr"])
                self.assertEqual(
                    records, [],
                    f"{client_key}: fixture sanity — {none_case['cr']!r} must "
                    f"carry NO pre-merge-gate milestone at all; got {records!r}")
                # Reuse the PASSING case's own project directory as the driving
                # client's cwd — this plan's close is about `none_case`'s CR,
                # resolved by `--cr`, and needs no toolchain of its own.
                result, emits, axi, text, board = self._drive_cr_close(
                    client_key, pass_case["project_dir"],
                    f"gate-fixture-{client_key}-none-close-agent", none_case["cr"])
                self.assertNotEqual(
                    result.returncode, 0,
                    f"{client_key}: cr-close on a CR with NO recorded "
                    f"pre-merge-gate result must exit non-zero; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                plan = self._plan_record(board, key, none_case["plan_id"])
                self.assertEqual(
                    plan.get("status"), "open",
                    f"{client_key}: closes nothing; got plan={plan!r}")
                self.assertTrue(
                    emits, f"{client_key}: the refusal must still decode as "
                    f"one TOON axi: envelope; got stdout={result.stdout!r}")
                help_text = " ".join(str(h) for h in (axi.get("help") or []))
                self.assertIn(
                    "pre-merge-gate", help_text,
                    f"{client_key}: the refusal's help[] must name "
                    f"pre-merge-gate; got help={axi.get('help')!r}")

    # ── AC "A green gate closes as today" (GUARD — expected to pass today) ──

    def test_cr_close_closes_normally_when_the_last_gate_passed_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["pass"]
                key = self.fixtures[client_key]["key"]
                commit = "c105ed00d001"
                result, emits, axi, text, board = self._drive_cr_close(
                    client_key, case["project_dir"],
                    f"gate-fixture-{client_key}-pass-close-agent", case["cr"],
                    commit=commit)
                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key}: cr-close on a CR whose last pre-merge-gate "
                    f"PASSED must close exactly as it does today; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                plan = self._plan_record(board, key, case["plan_id"])
                self.assertEqual(
                    plan.get("status"), "closed",
                    f"{client_key}: got plan={plan!r}")
                self.assertEqual(
                    (plan.get("merge") or {}).get("commit"), commit,
                    f"{client_key}: got plan={plan!r}")
                merged = _milestones_sent(board.posts(), "cr-merged", case["cr"])
                self.assertEqual(
                    len(merged), 1,
                    f"{client_key}: a successful close still posts exactly one "
                    f"cr-merged milestone; got {merged!r}")

    # ── AC "An accepted failure is recorded" ────────────────────────────────

    def test_cr_close_accept_failing_gate_records_the_reason_for_every_client(self):
        for client_key in CLIENT_KEYS:
            with self.subTest(client=client_key):
                case = self.fixtures[client_key]["cases"]["accept"]
                key = self.fixtures[client_key]["key"]
                reason = f"accepted-known-flake-{client_key}-gate-fixture"
                commit = "accceeed0002"
                result, emits, axi, text, board = self._drive_cr_close(
                    client_key, case["project_dir"],
                    f"gate-fixture-{client_key}-accept-close-agent", case["cr"],
                    commit=commit, extra_argv=["--accept-failing-gate", reason])
                self.assertEqual(
                    result.returncode, 0,
                    f"{client_key}: cr-close --accept-failing-gate on a CR "
                    f"whose last gate FAILED must still close it; "
                    f"stdout={result.stdout.strip()[:800]!r} "
                    f"stderr={result.stderr.strip()[-2000:]!r}")
                plan = self._plan_record(board, key, case["plan_id"])
                self.assertEqual(
                    plan.get("status"), "closed",
                    f"{client_key}: got plan={plan!r}")
                self.assertEqual(
                    plan.get("merge"),
                    {"commit": commit, "acceptedFailingGateReason": reason},
                    f"{client_key}: the plan's merge record must carry the "
                    f"commit and the EXACT reason the caller gave; got plan={plan!r}")
                merged = _milestones_sent(board.posts(), "cr-merged", case["cr"])
                self.assertEqual(
                    len(merged), 1,
                    f"{client_key}: got {merged!r}")
                self.assertEqual(
                    merged[0].get("acceptedFailingGateReason"), reason,
                    f"{client_key}: the cr-merged milestone must carry the "
                    f"same reason; got {merged[0]!r}")
                # The History serving the reason (`acceptedFailingGates`) is the
                # server's half: `a-close-over-an-accepted-failing-gate-keeps-
                # its-reason.test.ts` "lists each close over an accepted failing
                # gate with its cr, planId, commit, reason and closedAt, …",
                # over the plan PATCH and its merge asserted above.


if __name__ == "__main__":
    unittest.main()
