"""RED — CR-CRU-092 C1: the `next` decision resolver, in the shared module.

Spec: docs/changes/CR-CRU-092-next-validates-the-sequence.md
Model of record: docs/research/DN-crucible-wave-track-release.md
                 §"Reading the lane during execution"

WHAT THIS FILE COVERS. C1 lands the VERB and its resolver ONCE, in
`clients/_crucible_axi.py` (the CR-CRU-054 DRY rule). The five per-client
`sub.add_parser("next", …)` registrations and the AXI census extension are C2,
so nothing here drives a client's `main()`; every test below drives the shared
resolver and the shared `cmd_next` directly — the same division
`tests/client/test_cr084_release_packages.py` draws for `cmd_milestone`.

Covered: AC1–AC10, AC13, AC14, AC16, AC17, AC18. Deliberately NOT covered here:
AC11's grep half is included (it is one assertion and §S5 calls it absolute),
but AC12 (five-client `--help`) and AC15 (the two existing fleet harnesses) are
C2's, and `--fields` (P2) rides with AC15 rather than being invented here.

THE API THIS RED PINS, and why each piece exists:

    canonical_track(value) -> "track-<n>" | None
        §S3/AC18. `next` performs no write, so no server round-trip exists to
        normalise its `--track`. Without this the fleet would answer `2`
        differently on the read path (`next`) and the write path
        (`wave-sequence`), which is the exact inconsistency the fleet standard
        exists to prevent. Mirrors `normalizeTrack` (src/store.ts:362-365).

    queue_tracks(queue) -> [str]
        §S3, as CR-CRU-108 §S2 leaves it: the tracks the queue READ published
        (`declaredTracks`, src/store.ts:393), NOT a set the client derives.
        `len > 1` is still the whole definition of "multi-track", and the
        values are still echoed as stored rather than re-spelled — the rule
        simply has one home now, on the server that owns the normalisation.

    resolve_next(entries, track=None, tracks=[str]) -> (ok, code, fields, warnings)
        The pure resolver: one queue read in, one decision out. A tuple, like
        the module's existing `resolve_single_plan`. `code` is the process exit
        code so the three DECISIONS (all answers) can share `0` while the §S3
        refusal carries `2` from the same function.

    cmd_next(args, project_dir, ops) -> int
        The I/O half: one GET, `ops.emit`, the exit code. Read-only, so it
        takes no `--agent` and never touches `ops.agent_id` (AC10).

AC18's cross-implementation half is BEHAVIOURAL, not a source-text guard.
`TrackCanonicalisationAgreesWithTheServerTest` boots a scratch server (free
port, `mkdtemp` DB — never the live instance, never the shared project), drives
each accepted spelling through the real `wave-sequence` write path, reads the
stored value back off `GET …/queue` and compares it with `canonical_track`. An
earlier draft asserted on `normalizeTrack`'s SOURCE TEXT; that was replaced,
because a source guard breaks on a harmless refactor and still passes if the
regex is right but the logic around it changed. Requires `bun`, and says so
rather than skipping quietly into a green tick.

RED expectation (measured 2026-08-28 against the C1 pre-implementation tree):
`clients/_crucible_axi.py` defines none of the four names — a `\bnext\b` scan
of the fleet returns only prose and one `next()` builtin (spec §S1) — so every
test that reaches the SUT fails with AttributeError. That is the missing
contract, not a broken harness. The tests that DO pass in RED are the fixture
guards (`_status_only_pick`, `_status_only_dep_kind` and the §S5 grep): they
assert facts about the FIXTURES and the tree, and their passing is what proves
the AC16/AC17 fixtures genuinely discriminate rather than being tautologies.

Invocation:
    python3 -m pytest tests/client/test_cr092_next_decision_resolver.py -q
"""


import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"


# ═══════════════════════════════════════════════════════════════════════════
# CR-CRU-098 C3 — this file's resolver tests moved with the resolver
# ═══════════════════════════════════════════════════════════════════════════
#
# The docstring above describes the CR-CRU-092 suite as it stood. CR-CRU-098
# moved the decision resolver to the server (src/next.ts, `GET …/next`) and
# deleted it from the client (AC10), so every test here that reached it was
# classified (docs/changes/CR-CRU-098-test-classification.md) and deleted, with
# the fixtures and the `cmd_next` harness only those tests used. A comment
# stands where each class stood, naming where it went. Only
# `HarnessIsolationTest` never reached the resolver, and it is kept unedited.

# CanonicalTrackTest (3) — PORTED: tests/next-resolver.test.ts, "every spelling
# 091 accepts resolves the same lane" (the standalone `canonical_track` is gone,
# so its spellings are asserted on the resolver's own surface).

# TrackCanonicalisationAgreesWithTheServerTest (5) — RETIRED under CR-CRU-098
# §S4: it pinned the client's mirror of the server's track rule
# (`canonical_track` vs `normalizeTrack`). With the resolver on the server there
# is one side and no mirror, so there is nothing left to agree.

# TrackScopingTest (9) — PORTED: tests/next-resolver.test.ts, "multi-track
# refusal never picks a lane" and "every spelling 091 accepts ...".

# NextDecisionTest (7) — PORTED: tests/next-resolver.test.ts, "NEXT names the cr
# and its published seq, verbatim".

# HoldDecisionTest (18) — PORTED: tests/next-resolver.test.ts, "HOLD's four
# trigger kinds".

# DrainedDecisionTest (11) — PORTED: tests/next-resolver.test.ts, "DRAINED's
# three reasons".

# NextVerbEnvelopeTest (15) — KEPT (adapted to AC8/AC9):
# tests/client/test_cr098_next_verb_reads_the_route.py.

# LaneOrderTest (2) — PORTED: tests/next-resolver.test.ts, "resolveNext consumes
# the PUBLISHED order, never re-sorts by seq value".


# ═══════════════════════════════════════════════════════════════════════════
# §S5 — the harness DB is untouched, and the verb lands ONCE
# ═══════════════════════════════════════════════════════════════════════════


class HarnessIsolationTest(unittest.TestCase):
    """§S5 (absolute) — no code path in `clients/` may open, read, import or
    shell out to the harness ChangeSet DB. No fallback, no cross-check."""

    FORBIDDEN = ("schedule_db", ".wf-schedule.db", ".nai-schedule.db",
                 "next_for_track", "worktree-flow")

    def test_no_client_reaches_for_the_harness_lane_plan(self):
        offenders = {}
        for path in sorted(CLIENTS_DIR.glob("*.py")):
            text = path.read_text(encoding="utf-8", errors="replace")
            hits = [token for token in self.FORBIDDEN if token in text]
            if hits:
                offenders[path.name] = hits
        self.assertEqual(
            offenders, {},
            f"§S5: the two `next`s are never reconciled — a disagreement is a "
            f"real signal and is left visible; got {offenders!r}")


# ResolverLandsOnceTest (2) — KEPT (rewritten for AC10/AC11):
# tests/client/test_cr098_resolver_lands_on_the_server.py.

# NextBlockCitationsTest (2) — RETIRED under CR-CRU-098 §S4: it checked the
# `path:line` citations inside the client's `next` block. That block is now the
# verb and its presentation only; the line citations into the client resolver
# it guarded are gone with the resolver.

# PublishedTrackFactTest (9) and PublishedTrackFactIsWiredTest (1) — RETIRED
# under CR-CRU-098 §S4: they held the client to READING the queue's published
# track fact and refusing a read that omitted it (`queue_tracks`,
# `QueueTrackFactUnpublished`). On the server the resolver reads the declared
# tracks directly, so an unpublished track fact cannot arise.


if __name__ == "__main__":
    unittest.main()
