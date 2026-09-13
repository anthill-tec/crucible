"""CR-CRU-129 §S3 — the ONE client read this CR changes: `cr_merged_crs`.

What is broken today, measured by reading `clients/_crucible_axi.py`:

    QUEUE_EVENTS_LIMIT = 5000                              (:1674)
    ...
    events = ops.get(f"/api/v2/events?project={key}"
                     f"&limit={QUEUE_EVENTS_LIMIT}")       (:1738)
    merged = cr_merged_crs(events.get("events"))

    def cr_merged_crs(events):                             (:1692)
        return sorted({e.get("label") for e in events or []
                       if e.get("kind") == "milestone"
                       and e.get("type") == "cr-merged" and e.get("label")})

That is a SCAN, not a query: the newest 5,000 events of every kind are pulled
over the wire and filtered here. The window counts ALL events, and on the
board that prompted this CR 1,957 of 2,013 rows were telemetry — so a
`cr-merged` marker falls off the end silently, and the release ceremony's
provenance shrinks with no error anywhere. §S3's ruling is that
`QUEUE_EVENTS_LIMIT` is **DELETED, not raised**: a bounded window over
unbounded content cannot be fixed by choosing a larger bound.

What this file asserts:

  * the queue read ASKS for `cr-merged` records BY TYPE, and sends no event
    window with the request;
  * the ids it publishes come from that query's rows — including rows that
    carry no `kind` field, because a type-scoped collection has no reason to
    restate the kind and a client that insists on one silently answers `[]`;
  * `QUEUE_EVENTS_LIMIT` is GONE, and no replacement scan depth has been
    introduced on this read path — asserted BY CONSTRUCTION over the source,
    so a depth re-added later fails here rather than being discovered by the
    next lost release;
  * the fleet's tolerant-degrade contract survives the change: an unreachable
    milestone read is still a structured warning on an `ok:true` envelope, not
    an error, because a release is PUBLISHED before it is reported.

The route SHAPE is the server's to choose (see
tests/milestone-records-are-queryable-by-type.test.ts, which states the
proposed spelling and why GREEN may overrule it). Nothing here pins a path:
the assertions are that the request NAMES the type and carries NO window, both
of which hold whatever the collection ends up being called.

Fixture cr ids are drawn from the REGISTERED synthetic namespaces the
project-namespace tripwire allows (`CR-SHIPPED-*`) — never a real board id.

Invocation:
    python3 -m pytest tests/client/test_queue_reads_merged_crs_by_type.py -q
"""

import ast
import contextlib
import importlib.util
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
TOON_PATH = CLIENTS_DIR / "toon.py"
# The queue verb's implementation is SHARED (CR-CRU-054): one function, five
# delegating clients. It is therefore driven through ONE client end-to-end —
# the fleet's presence/parity census lives in test_cr054_fleet_inventory.py and
# is not restated here.
CLIENT_PATH = CLIENTS_DIR / "python-crucible.py"

PROJECT_KEY = "cr129-queue-key"
QUEUE_PATH = f"/api/v2/projects/{PROJECT_KEY}/queue"

# The deleted constant, named so the deletion is checkable.
DELETED_CONSTANT = "QUEUE_EVENTS_LIMIT"

# The two source-level limits CR-CRU-129's Non-goals explicitly leave in place
# ("recorded as a candidate CR rather than absorbed here"). Named here so the
# construction guard below refuses a NEW depth without flagging the two the CR
# deliberately did not touch.
LIMITS_THIS_CR_LEAVES_ALONE = frozenset({"TRUNCATE_LIMIT", "ROADMAP_LIST_LIMIT"})

# An integer this large on a read path is a DEPTH, not an index, a column count
# or a status code. It is a detection threshold for the construction guard, not
# a cap under test, and no assertion in this file treats it as a bound on any
# answer.
SCAN_DEPTH_FLOOR = 100

# The functions that make up the queue read path.
QUEUE_READ_FUNCTIONS = ("cr_merged_crs", "cmd_queue")

ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_PROJECT_NAME")


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Invoke `module.main()` with sys.argv patched -> (code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    code = 0
    with mock.patch.object(sys, "argv", ["client"] + argv), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            module.main()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, out.getvalue(), err.getvalue()


def _queue_response(*crs):
    return {"ok": True,
            "entries": [{"cr": cr, "wave": "6", "status": "PENDING",
                         "planId": None} for cr in crs],
            "totalCount": len(crs)}


def _merged_record(label, with_kind=True):
    """One row as a TYPE-SCOPED milestone collection serves it.

    `with_kind=False` is the shape that matters: a collection addressed by type
    has already answered "which kind" in the request, so a consumer that still
    demands a `kind` field on every row reads an empty set from a perfectly
    good answer. That is the exact failure mode this CR exists to remove, in
    miniature.
    """
    row = {"id": f"evt-1700000000000-{abs(hash(label)) % 1000}",
           "type": "cr-merged", "label": label, "timestamp": 1789000000000}
    if with_kind:
        row["kind"] = "milestone"
    return row


def _milestones_response(*records):
    return {"ok": True, "milestones": list(records),
            "totalCount": len(records)}


class _QueueReadHarness(unittest.TestCase):
    """Drives the real `queue` verb in-process with a recording `_get`, the
    fleet's established stub idiom (tests/client/test_cr091_roadmap_verbs.py).
    No live server and no live board are touched."""

    def setUp(self):
        self.module = _load_module(CLIENT_PATH, "cr129_queue_client_under_test")
        self.toon = _load_module(TOON_PATH, "cr129_queue_toon_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="cr129-queue-")
        with open(os.path.join(self.tmpdir, ".env"), "w") as fh:
            fh.write(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
            fh.write("CRUCIBLE_PROJECT_NAME=cr129-queue-project\n")
        self._saved_env = {k: os.environ.get(k) for k in ENV_KEYS}
        for k in ENV_KEYS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def drive(self, queue_response=None, milestones_response=None):
        """Run `queue` -> (code, axi envelope, the recorded GET paths)."""
        queue_response = (queue_response if queue_response is not None
                          else _queue_response("CR-SHIPPED-9"))
        milestones_response = (milestones_response if milestones_response is not None
                               else _milestones_response())
        paths = []

        def fake_get(path, *args, **kwargs):
            paths.append(path)
            return queue_response if path.startswith(QUEUE_PATH) else milestones_response

        with mock.patch.object(self.module, "_get", side_effect=fake_get,
                               create=True) as get_mock, \
                mock.patch.object(self.module, "_post", return_value={"ok": True},
                                  create=True), \
                mock.patch.object(self.module, "_patch", return_value=None,
                                  create=True):
            code, out, err = _run_main(
                self.module, ["queue", "--project-dir", self.tmpdir])
        self.stdout_text, self.stderr_text = out, err
        self.get_mock = get_mock
        return code, self.decode(out), paths

    def decode(self, stdout_text):
        decoded = self.toon.decode(stdout_text)
        self.assertIsInstance(
            decoded, dict,
            f"stdout must decode as a TOON document; got {stdout_text!r}")
        self.assertIn(
            "axi", decoded,
            f"stdout must carry the fleet's TOON-AXI envelope; "
            f"got {stdout_text!r}")
        return decoded["axi"]

    def milestone_request(self, paths):
        """The ONE request that is not the registered-CR-queue read.

        Asserted to exist rather than defaulted to None: "the query actually
        reached the surface" is the premise every other assertion rests on, and
        a read that issued no second request at all must fail here and not
        further down against a coincidentally-empty expectation.
        """
        others = [p for p in paths if not p.startswith(QUEUE_PATH)]
        self.assertEqual(
            len(others), 1,
            f"the queue verb must issue exactly ONE read for the cr-merged "
            f"records beside the registered-CR-queue read; issued {others!r} "
            f"(all paths: {paths!r})")
        return others[0]


class QueueAsksForMergedRecordsByType(_QueueReadHarness):
    """§S3/AC2 — "`cr_merged_crs` QUERIES milestones by type instead of
    scanning newest-N events"."""

    def test_the_queue_verb_asks_for_the_cr_merged_records_by_type(self):
        _code, _axi, paths = self.drive(
            milestones_response=_milestones_response(_merged_record("CR-SHIPPED-3")))

        request = self.milestone_request(paths)

        self.assertIn(
            "cr-merged", request,
            f"the read must NAME the record type it wants — a request that "
            f"does not say `cr-merged` is a scan the client filters "
            f"afterwards, which is the defect §S3 removes; got {request!r}")
        self.assertIn(
            PROJECT_KEY, request,
            f"the read must be scoped to this project; got {request!r}")

    def test_the_queue_verb_sends_no_event_window_with_any_request_it_makes(self):
        _code, _axi, paths = self.drive(
            milestones_response=_milestones_response(_merged_record("CR-SHIPPED-3")))

        windowed = [p for p in paths if "limit" in p]

        self.assertEqual(
            windowed, [],
            f"§S3: the constant is DELETED, not raised — no request on the "
            f"queue read path may carry an event window, because a bounded "
            f"window over unbounded content cannot be fixed by choosing a "
            f"larger bound; got {windowed!r}")

    def test_the_published_cr_merged_ids_are_the_ones_that_query_returned(self):
        _code, axi, paths = self.drive(
            milestones_response=_milestones_response(
                _merged_record("CR-SHIPPED-4"),
                _merged_record("CR-SHIPPED-1"),
                _merged_record("CR-SHIPPED-2")))

        # The premise: the query really was issued. Without this line an
        # implementation that asked nothing and published [] could satisfy an
        # empty expectation.
        self.milestone_request(paths)

        self.assertEqual(
            axi.get("crMerged"), ["CR-SHIPPED-1", "CR-SHIPPED-2", "CR-SHIPPED-4"],
            f"the verb must publish the sorted cr ids the query answered "
            f"with; got {axi.get('crMerged')!r}")

    def test_a_type_scoped_row_needs_no_kind_field_to_be_counted(self):
        """A collection addressed BY TYPE has already answered "which kind" in
        the request. A client that still requires `kind == "milestone"` on
        every row turns a complete answer into an empty one — silently, which
        is the whole failure class this CR is about."""
        _code, axi, paths = self.drive(
            milestones_response=_milestones_response(
                _merged_record("CR-SHIPPED-3", with_kind=False),
                _merged_record("CR-SHIPPED-4", with_kind=False)))

        self.milestone_request(paths)

        self.assertEqual(
            axi.get("crMerged"), ["CR-SHIPPED-3", "CR-SHIPPED-4"],
            f"a record the type-scoped surface returned must count even when "
            f"the row restates no `kind`; got {axi.get('crMerged')!r}")

    def test_an_unreachable_milestone_read_still_answers_with_a_structured_warning(self):
        """The fleet's tolerant-degrade contract, unchanged by this CR: a
        release is PUBLISHED before it is reported and must never fail on its
        own provenance. A failed read is a WARNING on an ok:true envelope, and
        an empty `crMerged` that is NOT distinguished from a real empty set is
        exactly the silent loss this CR removes."""
        code, axi, _paths = self.drive(
            milestones_response={"ok": False, "error": "connection refused"})

        self.assertEqual(code, 0, f"a read verb must not fail; got exit {code}")
        self.assertIs(axi.get("ok"), True)
        self.assertEqual(axi.get("crMerged"), [])
        codes = [w.get("code") for w in (axi.get("warnings") or [])]
        self.assertIn(
            "milestones-unavailable", codes,
            f"an unavailable milestone source must be NAMED in a structured "
            f"warning, never reported as 'this project has merged nothing'; "
            f"got warnings={axi.get('warnings')!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S3/AC2 — the DELETION, asserted by construction
# ═══════════════════════════════════════════════════════════════════════════


def _module_level_int_constants(tree):
    """Every module-level `NAME = <int literal>` in the shared module."""
    constants = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not isinstance(node.value, ast.Constant):
            continue
        value = node.value.value
        if isinstance(value, bool) or not isinstance(value, int):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                constants[target.id] = value
    return constants


def _function_named(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


class NoScanDepthSurvivesOnTheQueueReadPath(unittest.TestCase):
    """§S3/AC2 — "`QUEUE_EVENTS_LIMIT` is DELETED, not raised, and no
    replacement scan depth is introduced".

    Asserted over the SOURCE rather than over one call, because the claim is
    about what may exist, not about what one fixture happened to exercise: a
    depth re-added by a later author must fail HERE, on the day it is written.
    """

    @classmethod
    def setUpClass(cls):
        cls.source = AXI_MODULE_PATH.read_text()
        cls.tree = ast.parse(cls.source)
        cls.constants = _module_level_int_constants(cls.tree)

    def test_queue_events_limit_is_gone_from_the_shared_module(self):
        self.assertNotIn(
            DELETED_CONSTANT, self.constants,
            f"§S3: `{DELETED_CONSTANT}` is DELETED, not raised — it is still "
            f"declared with value {self.constants.get(DELETED_CONSTANT)!r}")
        self.assertNotIn(
            DELETED_CONSTANT, self.source,
            f"§S3: `{DELETED_CONSTANT}` must not survive anywhere in "
            f"{AXI_MODULE_PATH.name} — not as a constant, not as a reference, "
            f"and not as an alias under a new name")

    def test_the_shared_module_still_defines_the_queue_read_path_this_guard_is_about(self):
        """Non-vacuity for the guard below: a renamed or deleted function would
        make an AST scan of it pass over nothing at all."""
        for name in QUEUE_READ_FUNCTIONS:
            self.assertIsNotNone(
                _function_named(self.tree, name),
                f"{AXI_MODULE_PATH.name} must still define `{name}` — the "
                f"scan-depth guard below is scoped to it, and a rename would "
                f"silently empty that scope")

    def test_no_replacement_scan_depth_reaches_the_queue_read_path(self):
        offenders = []
        for name in QUEUE_READ_FUNCTIONS:
            node = _function_named(self.tree, name)
            if node is None:
                continue
            for inner in ast.walk(node):
                if (isinstance(inner, ast.Constant)
                        and not isinstance(inner.value, bool)
                        and isinstance(inner.value, int)
                        and inner.value >= SCAN_DEPTH_FLOOR):
                    offenders.append(f"{name}: inline literal {inner.value}")
                elif isinstance(inner, ast.Name):
                    held = self.constants.get(inner.id)
                    if (held is not None
                            and held >= SCAN_DEPTH_FLOOR
                            and inner.id not in LIMITS_THIS_CR_LEAVES_ALONE):
                        offenders.append(f"{name}: reads {inner.id} = {held}")

        self.assertEqual(
            offenders, [],
            f"§S3: once milestones are records the read is a query by type, "
            f"so there is no window to size and no new limit to declare — "
            f"raising the bound is the same defect with a bigger number; "
            f"found {offenders!r}")


if __name__ == "__main__":
    unittest.main()
