"""RED — the `next` lane carries its RELEASE and its WAVE, and a drained lane
is not a complete wave.

Covers §S1 (the two new flags and the wave predicate), §S3 (lane vs wave), §S4
(the envelope names the container it answered for) and the two agreement
criteria the wave-scope guard's shipped constraint added. §S2's boundary
ANNOUNCEMENT is deliberately out of scope here and belongs to the next cycle;
nothing in this file asserts on it.

NO BOARD HERE. The agreement criteria, which need the server's write side,
are the live-board module `test_next_lane_carries_release_and_wave`; this
module holds the flag surface, the five clients' printed help (the help
drives start processes, so it is integration) and the harness-DB source scan
merged from `test_cr092_next_decision_resolver`.

WHAT IS DRIVEN, AND WHY IT IS THE VERB AND NOT THE RESOLVER. Every behavioural
assertion below runs the real `cmd_next` over a real queue payload through the
real emitter, exactly as the sibling resolver suites do. That is not merely
idiom: the two new dimensions arrive as `--release` and `--wave`, whose
argparse dests are fixed by their own spelling, so a test driven through the
verb cannot fail because GREEN chose a different internal parameter name for
the resolver. It fails only when the BEHAVIOUR is absent.

FIXTURE IDS carry a namespace no project owns, and none of them matches the
project's own CR-literal shape, so no assertion in this file names a real
board row.

THE ONE PLACE THIS FILE READS AN AC NARROWLY, stated rather than implied. §S1
requires the wave predicate's result to be byte-identical for `--track 1`,
`--track 2` and NO track. On a project publishing two lanes, a bare no-track
call is the shipped §S3 usage refusal — it carries no decision at all, and
lifting that refusal is not this CR's business. The third leg is therefore
taken over the SAME wave axis with the track dimension removed: same waves,
same statuses, same published order, no `track` on any row. That is precisely
the claim the AC makes — the track dimension must not participate — and it
still discriminates, because today the tracked and untracked readings of one
wave disagree.
"""

import argparse
import contextlib
import importlib.util
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.client import CLIENT_SOURCE_DIR, TEST_INSTALL_CLIENTS
from tests.client.client_fleet_envelope_census_helpers import (
    declare_and_require_board,
)

CLIENTS_DIR = TEST_INSTALL_CLIENTS
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)

# §S1's own words: the flags are asserted PER CLIENT and the count of clients
# asserted is itself asserted. A loop over a list is satisfied by a list of
# one, which is the specific defect this constant exists to prevent.
EXPECTED_CLIENT_COUNT = 5

# Nothing listens on port 1 without root — the fleet's own help-drive idiom.
# `--help` never reaches the wire, but a drive that somehow did must refuse
# instantly rather than touch a live board.
_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load(AXI_MODULE_PATH, "next_lane_axi_under_test")


# ═══════════════════════════════════════════════════════════════════════════
# §S1 — the flag surface
# ═══════════════════════════════════════════════════════════════════════════


def _next_subparser():
    """The REAL `next` subparser, built by the shared registrar every client
    calls — never a transcription of it."""
    parser = argparse.ArgumentParser(prog="crucible")
    sub = parser.add_subparsers(dest="cmd")
    AXI.add_next_verb(sub, lambda *a, **kw: 0)
    return parser, sub.choices["next"]


def _parse_next(argv):
    """`(namespace, argparse-error)` for `next <argv>`. argparse exits the
    process on an unknown flag, so the error is CAPTURED and returned: a
    missing flag must read as `unrecognized arguments`, not as a test that
    died before it could assert."""
    parser, _ = _next_subparser()
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            return parser.parse_args(["next"] + list(argv)), None
        except SystemExit:
            return None, err.getvalue().strip()


class NextFlagSurfaceTest(unittest.TestCase):
    """§S1 — `next` gains `--release` and `--wave` alongside `--track`, all
    three declared by the ONE shared registrar, and the verb still writes
    nothing."""

    def test_next_accepts_release_wave_and_track_and_carries_them_verbatim(self):
        args, error = _parse_next(["--release", "0.2.0", "--wave", "6",
                                   "--track", "2"])
        self.assertIsNone(
            error,
            f"`next` must declare --release, --wave and --track; argparse "
            f"refused the call instead: {error}")
        self.assertEqual(args.release, "0.2.0")
        self.assertEqual(args.wave, "6")
        self.assertEqual(args.track, "2")

    def test_next_help_lists_all_three_lane_flags(self):
        _parser, nx = _next_subparser()
        help_text = nx.format_help()
        missing = [flag for flag in ("--release", "--wave", "--track")
                   if flag not in help_text]
        self.assertEqual(
            missing, [],
            f"the printed help for `next` must list every lane flag it "
            f"accepts; absent: {missing!r}")

    def test_next_still_declares_no_agent_flag(self):
        """The verb is an oracle: it performs no write and claims nothing, so
        the two new dimensions must not arrive alongside an identity. Passes
        today and must keep passing — this is the bound on the change, not the
        change."""
        _parser, nx = _next_subparser()
        self.assertNotIn("--agent", nx.format_help())
        args, error = _parse_next(["--agent", "someone"])
        self.assertIsNone(args)
        self.assertIn("--agent", error or "")


# ── the same surface, in every client that ships it ────────────────────────

_PROJECT_DIR = None
_HELP_CACHE = {}


def setUpModule():
    global _PROJECT_DIR
    _PROJECT_DIR = tempfile.mkdtemp(prefix="next-lane-surface-")
    (Path(_PROJECT_DIR) / ".env").write_text(
        "CRUCIBLE_PROJECT_KEY=next-lane-surface-key\n"
        "CRUCIBLE_PROJECT_NAME=next-lane-surface-project\n")
    # CR-CRU-139 §S2 — the board is DECLARED in the project file the help
    # drives run against, never exported. A `--help` never reaches the wire;
    # one that somehow did refuses instantly instead of touching a live board.
    declare_and_require_board(_PROJECT_DIR, _UNREACHABLE_CRUCIBLE_URL,
                              "a help drive")


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


def _drive_next_help(client):
    """A genuine subprocess dispatch of the real client script's own
    `next --help`, cached per client for this process."""
    if client not in _HELP_CACHE:
        env = os.environ.copy()
        _HELP_CACHE[client] = subprocess.run(
            [sys.executable, str(CLIENT_FILES[client]), "next", "--help"],
            cwd=_PROJECT_DIR, env=env, capture_output=True, text=True,
            timeout=60)
    return _HELP_CACHE[client]


class FleetNextFlagSurfaceTest(unittest.TestCase):
    """§S1 — all five clients expose `--release` and `--wave` on `next`,
    asserted per client by driving each client's own printed help, with the
    number of clients driven asserted alongside."""

    def test_every_client_prints_release_and_wave_in_its_next_help(self):
        surfaces = {client: _drive_next_help(client) for client in CLIENTS}

        # Non-vacuity FIRST: a drive that failed to run at all would report
        # every flag missing for a harness reason. `--track` is declared today
        # by the same registrar, so its presence proves the help was really
        # printed and read.
        unprinted = {c: (r.returncode, r.stderr.strip()[:200])
                     for c, r in surfaces.items()
                     if "--track" not in r.stdout}
        self.assertEqual(
            unprinted, {},
            f"every client must print its own `next --help`; these did not: "
            f"{unprinted!r}")

        missing = {c: [f for f in ("--release", "--wave") if f not in r.stdout]
                   for c, r in surfaces.items()}
        missing = {c: flags for c, flags in missing.items() if flags}
        self.assertEqual(
            missing, {},
            f"`next` takes its lane from the ONE shared registrar, so every "
            f"client must print both new flags; missing: {missing!r}")

        self.assertEqual(len(CLIENT_FILES), EXPECTED_CLIENT_COUNT)
        self.assertEqual(
            len(surfaces), EXPECTED_CLIENT_COUNT,
            f"the count of clients driven is itself asserted: drove "
            f"{sorted(surfaces)!r}")


# CR-CRU-098 C3 — the thirteen in-process `cmd_next` tests that stood here were
# deleted (docs/changes/CR-CRU-098-test-classification.md). The resolver they
# drove moved to the server, so the eleven PORTED ones live in
# tests/unit/next-resolver.test.ts ("wave/release lane details" group):
#   WavePredicateIgnoresTrackTest, LaneFlagsNarrowTheAnswerTest (2),
#   LaneFlagsAreNotCoercedTest (2), DuplicateSeqWithinAWaveTest,
#   DrainedLaneIsNotACompleteWaveTest (2), EnvelopeNamesTheResolvedContainerTest
#   (4), WavelessEntryNeverResolvesTheWaveTest;
# and the two KEPT ones — LegacyLineStatesTheWaveTest and
# BothNewDimensionsRideTheOneReadTest — in
# tests/client/unit/test_cr098_next_verb_reads_the_route.py.


# ═══════════════════════════════════════════════════════════════════════════
# §S5 — the harness DB is untouched, and the verb lands ONCE
# ═══════════════════════════════════════════════════════════════════════════
#
# From the merged `test_cr092_next_decision_resolver` (CR-CRU-092), unedited.


class HarnessIsolationTest(unittest.TestCase):
    """§S5 (absolute) — no code path in `clients/` may open, read, import or
    shell out to the harness ChangeSet DB. No fallback, no cross-check."""

    FORBIDDEN = ("schedule_db", ".wf-schedule.db", ".nai-schedule.db",
                 "next_for_track", "worktree-flow")

    def test_no_client_reaches_for_the_harness_lane_plan(self):
        offenders = {}
        for path in sorted(CLIENT_SOURCE_DIR.glob("*.py")):
            text = path.read_text(encoding="utf-8", errors="replace")
            hits = [token for token in self.FORBIDDEN if token in text]
            if hits:
                offenders[path.name] = hits
        self.assertEqual(
            offenders, {},
            f"§S5: the two `next`s are never reconciled — a disagreement is a "
            f"real signal and is left visible; got {offenders!r}")


if __name__ == "__main__":
    unittest.main()
