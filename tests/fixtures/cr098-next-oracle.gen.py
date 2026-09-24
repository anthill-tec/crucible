"""CR-CRU-098 C3 — the frozen `next` oracle's generator.

WHY THIS EXISTS. AC10 deletes the client-side resolver (`resolve_next`,
`_next_start_help`, `_hold_help`, `_drained_help`) from
`clients/_crucible_axi.py`. AC5 and AC9 are both claims of the form "the same
as TODAY's code produced", and once today's code is gone the only honest
record of what it produced is a frozen one. This script is that record's ONE
source (the C3 ruling on the `_route_response` escalation, option (c)
widened): it loads the PRE-DELETION client straight out of git — never the
working tree, so it stays reproducible after the deletion — runs today's
functions over every fixture the two oracle-consuming test files use, and
writes `tests/fixtures/cr098-next-oracle.json`.

CONSUMERS:
  * tests/client/test_cr098_next_verb_reads_the_route.py — `_route_response`
    serves the frozen `resolver` answer for its board (AC9: the client, given
    those fields, prints today's envelope, line and exit code).
  * tests/next-resolver.test.ts — `pythonHelp` reads the frozen `help`
    answers (AC5), and one assertion holds the server's `resolveNext` equal
    to EVERY frozen `resolver` answer (the server matches the old resolver).

WHICH FIXTURES:
  * `resolver` — (a) every board the python route test drives, RECORDED by
    running that test module with its `_frozen_resolver` seam swapped for the
    old `resolve_next` (so no board can be missed or retyped), plus (b) the
    AC5 boards tests/next-resolver.test.ts builds (mirrored below as
    `TS_AC5_BOARDS`).
  * `help` — exactly the requests `pythonHelp` makes in
    tests/next-resolver.test.ts's AC5 group; each HOLD trigger is the one the
    old resolver produces for the mirrored HOLD board.

REGENERATE (from the repo root):
    python3 tests/fixtures/cr098-next-oracle.gen.py
The output is deterministic; a regeneration that changes the JSON means the
old client source or a fixture changed, and that is a finding, not noise.
"""

import contextlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_COMMIT = "21c7330"
SOURCE_PATH = "clients/_crucible_axi.py"
ROUTE_TEST_PATH = REPO_ROOT / "tests" / "client" / "test_cr098_next_verb_reads_the_route.py"
OUT_PATH = REPO_ROOT / "tests" / "fixtures" / "cr098-next-oracle.json"


def _git(*args):
    return subprocess.run(["git", *args], cwd=REPO_ROOT, check=True,
                          capture_output=True, text=True).stdout


def load_old_client():
    """Today's (pre-deletion) shared client module, from git, loaded from a
    scratch copy through the ordinary import machinery. Only its pure
    resolver and help builders are called, and none of them reads a
    module-relative path, so the scratch location changes nothing they
    return."""
    source = _git("show", f"{SOURCE_COMMIT}:{SOURCE_PATH}")
    scratch = Path(tempfile.mkdtemp(prefix="cr098-oracle-")) / "_crucible_axi.py"
    scratch.write_text(source, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("cr098_oracle_old_axi", scratch)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _plain(value):
    """JSON round-trip: tuples become lists, so a recorded board compares by
    content with the board a consumer rebuilds."""
    return json.loads(json.dumps(value))


def _canonical(value):
    return json.dumps(value, sort_keys=True)


def _published_tracks(entries):
    """`declaredTracks` (src/store.ts) — sorted, distinct, non-blank, trimmed."""
    return sorted({(e.get("track") or "").strip() for e in entries
                   if (e.get("track") or "").strip()})


class Recorder:
    def __init__(self, old):
        self.old = old
        self.cases = {}

    def resolve(self, entries, tracks, scope):
        entries, tracks, scope = _plain(entries), _plain(tracks), _plain(scope)
        ok, code, fields, warnings = self.old.resolve_next(
            entries, track=scope.get("track"), tracks=tracks,
            release=scope.get("release"), wave=scope.get("wave"))
        key = _canonical({"entries": entries, "tracks": tracks, "scope": scope})
        self.cases.setdefault(key, {
            "entries": entries, "tracks": tracks, "scope": scope,
            "result": _plain({"ok": ok, "code": code, "fields": fields,
                              "warnings": warnings}),
        })
        return ok, code, _plain(fields), _plain(warnings)


def record_route_test_boards(recorder):
    """Run the python route test with its oracle seam pointed at the OLD
    resolver, recording every board it asks about. Pass/fail of that run is
    irrelevant here (before C3's production change its AC8 halves are red by
    design); only the boards it drives are collected."""
    spec = importlib.util.spec_from_file_location("cr098_oracle_route_test", ROUTE_TEST_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    vars(module)["_frozen_resolver"] = recorder.resolve
    suite = unittest.defaultTestLoader.loadTestsFromModule(module)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)


# ── tests/next-resolver.test.ts's AC5 boards, mirrored ─────────────────────
# `entry()` and the lifecycle helpers exactly as that file spells them.

def entry(cr, seq, **overrides):
    row = {"cr": cr, "wave": "5", "dependsOn": [], "status": "PENDING", "seq": seq}
    row.update(overrides)
    return row


def void_lc(reason="not happening"):
    return {"state": "VOID", "reason": reason, "at": 0}


def superseded_lc(by):
    return {"state": "SUPERSEDED", "by": by, "at": 0}


TS_HOLD_BOARDS = {
    "in-flight": ([entry("CR-NEXTPTR-RUN", 10, status="IN_PROGRESS"),
                   entry("CR-NEXTPTR-WAIT", 20)], {}),
    "dependency": ([entry("CR-NEXTPTR-DEP", 10, track="track-2"),
                    entry("CR-NEXTPTR-TARGET", 20, track="track-1",
                          dependsOn=["CR-NEXTPTR-DEP"])], {"track": "track-1"}),
    "unknown-dependency": ([entry("CR-NEXTPTR-TARGET", 10,
                                  dependsOn=["CR-NEXTPTR-GHOST"])], {}),
    "dead-dependency": ([entry("CR-NEXTPTR-DEAD", 10, lifecycle=void_lc()),
                         entry("CR-NEXTPTR-TARGET", 20,
                               dependsOn=["CR-NEXTPTR-DEAD"])], {}),
}

TS_CORPSE_LANE = [entry("CR-NEXTPTR-DEAD1", 10, lifecycle=void_lc()),
                  entry("CR-NEXTPTR-DEAD2", 20,
                        lifecycle=superseded_lc("CR-NEXTPTR-NEW"))]

TS_AC5_BOARDS = (
    ([entry("CR-NEXTPTR-100", 10, wave="7")], {}),
    ([{"cr": "CR-NEXTPTR-100", "wave": "", "dependsOn": [], "status": "PENDING",
       "seq": 10}], {}),
    *TS_HOLD_BOARDS.values(),
    ([], {}),
    ([entry("CR-NEXTPTR-A", 10, track="track-1")], {"track": "9"}),
    (TS_CORPSE_LANE, {}),
)


def help_requests(old):
    """Exactly the `pythonHelp` requests tests/next-resolver.test.ts makes."""
    requests = [
        {"fn": "start", "entry": {"cr": "CR-NEXTPTR-100", "wave": "7"}},
        {"fn": "start", "entry": {"cr": "CR-NEXTPTR-100", "wave": None}},
    ]
    for entries, scope in TS_HOLD_BOARDS.values():
        _ok, _code, fields, _warnings = old.resolve_next(
            entries, track=scope.get("track"), tracks=_published_tracks(entries))
        requests.append({"fn": "hold", "trigger": fields["trigger"]})
    requests += [
        {"fn": "drained", "reason": "no-roadmap", "lane": []},
        {"fn": "drained", "reason": "awaiting-assignment", "lane": []},
        {"fn": "drained", "reason": "wave-complete", "lane": [
            {"cr": e["cr"], "lifecycle": {k: v for k, v in
                                          (("state", e["lifecycle"]["state"]),
                                           ("by", e["lifecycle"].get("by")))
                                          if v is not None}}
            for e in TS_CORPSE_LANE]},
    ]
    return [_plain(r) for r in requests]


def run_help(old, request):
    fn = request["fn"]
    if fn == "start":
        return old._next_start_help(request["entry"])
    if fn == "hold":
        return old._hold_help(request["trigger"])
    if fn == "drained":
        return old._drained_help(request["reason"], request["lane"], request.get("nextWave"))
    raise SystemExit(f"unknown fn {fn!r}")


def main():
    old = load_old_client()
    recorder = Recorder(old)
    record_route_test_boards(recorder)
    for entries, scope in TS_AC5_BOARDS:
        recorder.resolve(entries, _published_tracks(entries), scope)
    oracle = {
        "source": {"commit": _git("rev-parse", SOURCE_COMMIT).strip(),
                   "path": SOURCE_PATH},
        "regenerate": "python3 tests/fixtures/cr098-next-oracle.gen.py",
        "resolver": [recorder.cases[key] for key in sorted(recorder.cases)],
        "help": [{"request": r, "help": _plain(run_help(old, r))}
                 for r in help_requests(old)],
    }
    OUT_PATH.write_text(json.dumps(oracle, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8")
    print(f"wrote {OUT_PATH.relative_to(REPO_ROOT)}: "
          f"{len(oracle['resolver'])} resolver cases, {len(oracle['help'])} help cases "
          f"(source {oracle['source']['commit'][:7]}:{SOURCE_PATH})")


if __name__ == "__main__":
    main()
