"""CR-CRU-129 §S4 -- the client half of "a replay may not quietly shrink what
it replaces": a server that REFUSED a release write because the derivation
would have LOST provenance is not a failed write, and must not be tallied as
one.

Spec: docs/changes/CR-CRU-129-a-release-is-a-record-not-an-event.md §S4
  AC: a replay that would write FEWER crs than the stored record is refused,
      names the release and the missing ids, and writes nothing.

WHY THE CLIENT HAS A HALF AT ALL. The refusal is the SERVER's decision (it is
the only actor that can see the stored record), but the ceremony reads the
refusal through this client's exit status, and bash has exactly three buckets
for a tag: recorded, REFUSED (nothing written) and failed
(`cmd_backfill_releases`, scripts/release.sh). `EXIT_REPAIR_REFUSED` already
exists for the CR-CRU-086 repair refusal and `release.sh` already maps it to
the REFUSED bucket, so the vocabulary is not invented here -- it is EXTENDED to
the replay path, which is the one that ran on 2026-09-13 and reported
`4/4 recorded` over a release that came back with 51 of its 60 CRs.

WHAT SHAPE THE CLIENT KEYS ON. The server's refusal carries the same
`shrink` object a successful repair already carries (`{before, after,
removed}`, src/store.ts `ProvenanceShrink`, surfaced by the route beside `ok`)
-- one vocabulary for one finding. So: NOT ok AND a `shrink` present is a
refusal that wrote nothing; NOT ok with no `shrink` stays an ordinary failure.
That distinction is asserted in both directions below, because a client that
mapped every failure to the refusal bucket would hide real failures from the
tally just as thoroughly.

RED expectation, measured 2026-09-13 against e9f8c01: `cmd_milestone`
(clients/_crucible_axi.py) ends `return 0 if ok else 1` and reads the shrink as
`resp.get("shrink") if ok else None` -- so a refusal's shrink is DISCARDED, the
exit status is 1, and the ceremony prints `NOT recorded` plus a `recover with:`
line for a release that needs no recovery. The first test below therefore fails
on the exit status and on an empty stderr; the three that follow pin behaviour
that must SURVIVE the change (a successful repair's shrink report, an ordinary
failure's status, an ordinary success) and pass today, so the change can never
be implemented as "refuse everything".

No network, no server, no database: `cmd_milestone` is driven directly with a
scripted `ClientOps`, the sibling idiom in this directory.

Invocation:
    python3 -m unittest tests.client.test_release_replay_refuses_to_shrink -v
"""

import argparse
import contextlib
import importlib.util
import io
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"


def _load_axi():
    """Load `clients/_crucible_axi.py` by path -- the fleet's own `_axi()`
    loader idiom, and the convention every sibling test in this directory
    uses for a hyphen-named or path-loaded client module."""
    spec = importlib.util.spec_from_file_location(
        "crucible_axi_under_test_replay_shrink", AXI_MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load_axi()

#: The release whose replay came back smaller -- this project's first release,
#: spelled as a version rather than as a CR id.
VERSION = "0.1.0"
COMMIT = "abc1234def5678abc1234def5678abc1234def56"

#: The 2026-09-13 shape at its measured scale: the record held sixty CR ids and
#: the rebuild could still place fifty-one of them, because the `cr-merged`
#: records for the other nine had been evicted in the same retention sweep.
#: Synthetic ids, at the real scale, so "a strict subset" cannot be mistaken for
#: a two-row fixture artefact.
STORED_CRS = tuple(f"CR-SHIPPED-{n}" for n in range(1, 61))
REBUILT_CRS = STORED_CRS[:51]
LOST_CRS = STORED_CRS[51:]


class _ScriptedOps:
    """A `ClientOps` whose `post_milestone` answers with a scripted response and
    records what it was handed. Built from the real class, so a signature change
    to `ClientOps` breaks here loudly instead of being absorbed by a duck-typed
    stub."""

    def __init__(self, response, queue_crs=()):
        self.response = response
        self.milestone_calls = []
        self.emits = []
        self.ops = AXI.ClientOps(
            get=self._get,
            post=lambda path, payload: {"ok": True},
            patch=lambda path, payload: {"ok": True},
            emit=self._emit,
            context=lambda project_dir, **kw: {},
            agent_id=lambda args: "release-ceremony-1",
            project_key=lambda project_dir: "pk",
            plans_path=lambda project_dir: "/api/v2/projects/pk/plans",
            open_plans=lambda project_dir: [],
            resolve_plan=lambda *a, **kw: None,
            post_gate=lambda *a, **kw: {"ok": True},
            post_milestone=self._post_milestone,
            base_url="http://localhost:0")
        self._queue_crs = list(queue_crs)

    def _get(self, path):
        # The only GET the milestone verb makes: the registered CR queue that
        # `release_crs` intersects the ceremony's tag-range scan against.
        return {"ok": True, "entries": [{"cr": cr} for cr in self._queue_crs]}

    def _emit(self, verb, ok, data, context, warnings, legacy):
        self.emits.append((verb, ok, data, warnings))

    def _post_milestone(self, project_dir, agent_id, mtype, **kwargs):
        self.milestone_calls.append(kwargs)
        return self.response


def _args(**overrides):
    """The Namespace argparse produces for `milestone --type release …`. A
    REPLAY by default: `repair_provenance` is False, which is the path the
    ceremony's backfill takes and the path that shrank 0.1.0."""
    values = {"type": "release", "label": VERSION, "commit": COMMIT,
              "cr": None, "agent": "release-ceremony-1",
              "released_at": 1752148800, "crs": ",".join(REBUILT_CRS),
              "repair_provenance": False, "packages": None}
    values.update(overrides)
    return argparse.Namespace(**values)


def _refusal(removed=LOST_CRS):
    """The server's refusal as §S4 specifies it: not ok, carrying the same
    `shrink` object a reported repair carries, and an `error` that NAMES the
    release and the ids that would have been lost."""
    return {"ok": False,
            "error": (f"release {VERSION} replay refused: it would drop "
                      f"{len(removed)} recorded CR(s) — "
                      + ", ".join(removed)),
            "shrink": {"before": len(STORED_CRS),
                       "after": len(STORED_CRS) - len(removed),
                       "removed": list(removed)}}


class ReplayRefusalIsNotAFailedWriteTest(unittest.TestCase):
    """§S4 -- the refusal travels to the ceremony as a REFUSAL: its own exit
    status, the release named, and the lost ids named."""

    def test_a_refused_replay_exits_refused_and_names_the_release_and_lost_ids(self):
        """The whole client contract in one test, because the three parts are
        one fact: the ceremony must be able to tally the tag as REFUSED
        (nothing written) rather than recorded or failed, and an operator must
        be able to read WHICH release and WHICH ids from the run's own output.

        How this fails if the code does nothing: `cmd_milestone` returns 1 for
        any not-ok response and discards the shrink, so the assertion below
        sees 1 (release.sh's `failed` bucket, which prints a `recover with:`
        line inviting the operator to re-run the lossy write) and a stderr
        carrying no id at all."""
        rec = _ScriptedOps(_refusal(), queue_crs=STORED_CRS)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = AXI.cmd_milestone(_args(), "/fake/dir", rec.ops)
        said = err.getvalue()

        self.assertEqual(
            rc, AXI.EXIT_REPAIR_REFUSED,
            "a write the server REFUSED wrote nothing and failed at nothing: "
            "the ceremony's REFUSED bucket is the only truthful tally, and "
            f"this run reported {rc} instead. Said: {said!r}")
        self.assertIn(
            "REFUSED", said,
            "the refusal must be STATED on the interactive channel -- silence "
            "beside a bare exit status is how the lossy replay passed for a "
            "success")
        self.assertIn(
            VERSION, said, "…and it must NAME the release it refused")
        missing = [cr for cr in LOST_CRS if cr not in said]
        self.assertEqual(
            missing, [],
            "every id the replay would have dropped must be named, so the "
            f"loss is readable rather than merely counted; unnamed: {missing!r}")
        self.assertIn(
            str(len(STORED_CRS)), said,
            "the count BEFORE belongs in the report -- a reader cannot weigh a "
            "loss without the set it came out of")
        self.assertIn(str(len(REBUILT_CRS)), said, "…and the count AFTER")

    def test_a_refused_replay_is_reported_to_a_machine_caller_as_written_nothing(self):
        """The envelope half: an orchestrator reading the structured output must
        see the refusal too, in the shape the repair refusal already uses
        (`refused` true, `recorded` false, one warning carrying the detail).

        How this fails if the code does nothing: `cmd_milestone`'s emit has no
        notion of a refusal -- it emits `ok=False` with no `refused` key and an
        EMPTY warnings list, so a machine caller sees a failed post and not a
        release left deliberately untouched."""
        rec = _ScriptedOps(_refusal(), queue_crs=STORED_CRS)
        with contextlib.redirect_stderr(io.StringIO()):
            AXI.cmd_milestone(_args(), "/fake/dir", rec.ops)

        self.assertEqual(len(rec.emits), 1, "one verb, one envelope")
        (_verb, _ok, data, warnings) = rec.emits[0]
        self.assertIs(
            data.get("refused"), True,
            f"the envelope must say the write was refused; got {data!r}")
        self.assertIs(
            data.get("recorded"), False,
            "…and that nothing was recorded, so a caller cannot count it")
        details = [w.get("detail", "") for w in (warnings or [])]
        self.assertTrue(
            details,
            "a refusal with no structured warning is invisible to every "
            "non-interactive caller")
        joined = "\n".join(details)
        self.assertIn(VERSION, joined, "the warning names the release")
        self.assertIn(
            LOST_CRS[0], joined,
            "…and the ids it refused to drop, so the machine channel is not "
            "poorer than the human one")

    def test_an_ordinary_failure_is_still_a_failure_and_never_the_refused_bucket(self):
        """The negative bound, and the reason the client keys on the `shrink`
        object rather than on "not ok": an unreachable server, a rejected
        identity or a malformed body must keep landing in the ceremony's FAILED
        bucket, which is the one that prints the recovery command. A client that
        mapped every not-ok answer to REFUSED would silence real failures.

        Passes today (0/1 is the current mapping) and must keep passing."""
        rec = _ScriptedOps({"ok": False, "error": "connection refused"},
                           queue_crs=STORED_CRS)
        with contextlib.redirect_stderr(io.StringIO()):
            rc = AXI.cmd_milestone(_args(), "/fake/dir", rec.ops)
        self.assertEqual(
            rc, 1,
            "a failure that wrote nothing BECAUSE it failed is not a refusal: "
            "only a server decision carrying what it declined to drop is")

    def test_a_reported_shrink_on_an_accepted_repair_still_succeeds_and_still_says_what_it_dropped(self):
        """The other path, which §S4 deliberately does NOT change: an opt-in
        `--repair-provenance` correction that legitimately shrinks a stored set
        is APPLIED and REPORTED (the 58-to-51 case, where the dropped ids have
        no landing record at any source). The operator asked for a correction
        there; a replay asked for nothing, which is why only the replay is
        refused.

        Passes today, and pins the behaviour the new refusal branch must not
        swallow -- if it did, the ceremony's own repair path would start
        reporting REFUSED for writes it actually made."""
        accepted = {"ok": True, "changed": True, "event": "evt-1",
                    "shrink": {"before": len(STORED_CRS),
                               "after": len(REBUILT_CRS),
                               "removed": list(LOST_CRS)}}
        rec = _ScriptedOps(accepted, queue_crs=STORED_CRS)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = AXI.cmd_milestone(
                _args(repair_provenance=True), "/fake/dir", rec.ops)
        said = err.getvalue()
        self.assertEqual(
            rc, 0, "an applied correction is a recorded write")
        self.assertIn("SHRANK", said, "…and it is never silent")
        self.assertIn(LOST_CRS[-1], said, "…naming what it dropped")
        self.assertNotIn(
            "REFUSED", said,
            "a write that HAPPENED must not be reported as refused")


if __name__ == "__main__":
    unittest.main()
