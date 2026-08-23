"""CR-CRU-084 §S1/§S3/§S4 -- a release milestone carries the PACKAGES it
delivered, through the fleet's SHARED client module.

Spec: docs/changes/CR-CRU-084-release-records-its-packages.md
  §S1  the release milestone gains a `packages` entry: for each artifact, its
       registry, name and version.
  §S3  a release recorded with NONE reads back as an EXPLICIT empty
       `packages`, distinguishable from a pre-CR-084 release which omits the
       field entirely (AC4).
  §S4  the backfill reuses the CR-081 `--repair-provenance` path, inheriting
       CR-086's write rule extended to this field.

WHAT THIS FILE COVERS, and what it deliberately does not. The five clients
duplicate the `milestone` SUBPARSER but share `cmd_milestone` and
`post_milestone` (`clients/_crucible_axi.py:1729` and `:2003`). The per-client
half -- "--packages exists, identically, on all five" -- is a FLEET PARITY
question and lives with the fleet's other flag-surface contracts in
`tests/client/test_cr054_verb_surface_lift.py`
(`MilestonePackagesFlagFleetParityTest`). THIS file is the shared half: the
two functions every client routes through, tested directly, once.

THE ARGUMENT FORMAT (the decision the GREEN phase implements):

    --packages "pypi:crucible-axi:0.4.0,npm:@anthill-tec/crucible-server:0.4.0"

ONE flag carrying a delimited string, exactly as `--crs` does -- entries split
on `,`, an entry's three fields split on `:`. Chosen because (a) it matches the
fleet's existing style for a computed multi-value provenance field, which is
what `emit_release_milestone`'s `provenance+=(--crs "$crs")` shape already
builds, and (b) it round-trips the REAL coordinates losslessly:
`@anthill-tec/crucible-server` contains `@` and `/`, both ordinary characters
here, while neither a package name nor a SemVer version may contain `:` or `,`.

The parse happens in the SHARED module, not in five subparsers: a `type=`
callable or a per-client parse would be the same five-copy drift CR-CRU-075
exists to fix. So `cmd_milestone` receives the raw string argparse produced and
hands `post_milestone` the structured list -- the identical division of labour
`release_crs(getattr(args, "crs", None), ...)` already uses.

RED expectation (measured 2026-08-23, against the C1 GREEN tree):
  * `post_milestone` (clients/_crucible_axi.py:2003-2005) takes no `packages`
    parameter at all, so every call below raises TypeError.
  * `cmd_milestone` (`:1757-1767`) reads `released_at`/`crs`/`repair_provenance`
    off `args` and nothing else -- `grep -c packages clients/_crucible_axi.py`
    is 0 -- so a `--packages` value on `args` is silently discarded and never
    reaches the wire.
Both are the missing contract, not a broken harness. Measured baseline: 8 of
the 9 tests below fail (5 TypeError on the absent `packages` parameter, 3 on
`None` where a parsed list, an empty list, or a reached wire was required),
while `test_a_repair_with_nothing_at_all_to_write_is_still_refused` PASSES --
the CR-CRU-086 behaviour this addition must NOT cost, proving the harness
drives the real `cmd_milestone` code path rather than a stub.

Invocation:
    python3 -m unittest tests.client.test_cr084_release_packages -v
"""

import argparse
import importlib.util
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
        "crucible_axi_under_test_cr084", AXI_MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AXI = _load_axi()

VERSION = "0.4.0"
COMMIT = "abc1234def5678abc1234def5678abc1234def56"

PYPI_PACKAGE = "crucible-axi"
NPM_PACKAGE = "@anthill-tec/crucible-server"

#: The `--packages` string the ceremony hands the client for `VERSION`.
PACKAGES_FLAG = f"pypi:{PYPI_PACKAGE}:{VERSION},npm:{NPM_PACKAGE}:{VERSION}"

#: …and the structured form it must become, in declaration order.
PACKAGES = [
    {"registry": "pypi", "name": PYPI_PACKAGE, "version": VERSION},
    {"registry": "npm", "name": NPM_PACKAGE, "version": VERSION},
]


class PostMilestoneCarriesPackagesTest(unittest.TestCase):
    """§S1/§S3 -- `post_milestone` is the fleet's ONE payload builder. It must
    put `packages` on the wire when given, OMIT the key entirely when not, and
    send an EXPLICIT empty list when one is given -- the same three-state
    distinction `crs` already makes, because AC4 gives the empty state its own
    meaning ("this release delivered nothing")."""

    def _post(self, **kwargs):
        calls = []

        def post_fn(path, payload):
            calls.append((path, payload))
            return {"ok": True}

        AXI.post_milestone("pk", "A1", "release", post_fn,
                           label=VERSION, commit=COMMIT, **kwargs)
        self.assertEqual(len(calls), 1)
        path, payload = calls[0]
        self.assertEqual(path, "/api/v2/milestones")
        return payload

    def test_packages_reaches_the_payload_verbatim(self):
        payload = self._post(packages=PACKAGES)
        self.assertEqual(
            payload.get("packages"), PACKAGES,
            "post_milestone must carry `packages` onto the wire unchanged -- "
            "one entry per artifact, each naming registry/name/version, in "
            "the order the ceremony declared them (§S1/AC1)")
        # It rides ALONGSIDE the rest of the payload, never in place of it.
        self.assertEqual(payload.get("type"), "release")
        self.assertEqual(payload.get("label"), VERSION)
        self.assertEqual(payload.get("commit"), COMMIT)

    def test_packages_is_omitted_entirely_when_not_supplied(self):
        """The pre-CR-084 shape: a caller that says nothing about packages
        must produce a payload with NO `packages` key -- never `null`, and
        never the empty list AC4 makes mean something else."""
        payload = self._post()
        self.assertNotIn(
            "packages", payload,
            "a milestone posted without packages must omit the key entirely "
            "(AC4: absent and empty are different facts on the wire)")
        payload_explicit_none = self._post(packages=None)
        self.assertNotIn(
            "packages", payload_explicit_none,
            "packages=None is 'said nothing', identical to not passing it -- "
            "exactly how `crs=None` already behaves")

    def test_an_explicit_empty_list_is_sent_as_an_empty_list(self):
        """§S3/AC4 -- "delivered nothing" is a recordable fact, so an empty
        declaration must survive the builder rather than being dropped by a
        falsy check. This is the precise trap `crs` already avoids with
        `if crs is not None` instead of `if crs`."""
        payload = self._post(packages=[])
        self.assertIn(
            "packages", payload,
            "packages=[] must SEND the key -- a truthiness test here would "
            "silently turn 'this release delivered nothing' into 'this "
            "ceremony said nothing', which is the distinction AC4 rests on")
        self.assertEqual(payload["packages"], [])

    def test_packages_composes_with_the_provenance_crs_already_carries(self):
        """AC5 -- adding packages must not disturb CR-CRU-080's two fields or
        CR-CRU-081's opt-in switch: one post carries all four."""
        payload = self._post(packages=PACKAGES, crs=["CR-CRU-041"],
                             released_at=1750000000, repair_provenance=True)
        self.assertEqual(payload.get("packages"), PACKAGES)
        self.assertEqual(payload.get("crs"), ["CR-CRU-041"])
        self.assertEqual(payload.get("releasedAt"), 1750000000)
        self.assertEqual(payload.get("repairProvenance"), True)


class _RecordingOps:
    """A `ClientOps` whose `post_milestone` records what the shared verb hands
    it. Built from the real class so a signature change to `ClientOps` breaks
    here loudly instead of being silently absorbed by a duck-typed stub."""

    def __init__(self, queue_crs=()):
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
        # `release_crs` intersects the ceremony's scan against.
        return {"ok": True, "entries": [{"cr": cr} for cr in self._queue_crs]}

    def _emit(self, verb, ok, data, context, warnings, legacy):
        self.emits.append((verb, ok, data, warnings))

    def _post_milestone(self, project_dir, agent_id, mtype, **kwargs):
        self.milestone_calls.append(kwargs)
        return {"ok": True}


def _args(**overrides):
    """The Namespace argparse produces for `milestone --type release …`.
    `packages` carries the RAW string, because parsing it is the shared
    module's job (five subparsers must not each own a parser)."""
    values = {"type": "release", "label": VERSION, "commit": COMMIT,
              "cr": None, "agent": "release-ceremony-1",
              "released_at": None, "crs": None, "repair_provenance": False,
              "packages": None}
    values.update(overrides)
    return argparse.Namespace(**values)


class CmdMilestoneForwardsPackagesTest(unittest.TestCase):
    """§S1 -- the shared verb is where `--packages` is parsed and handed on.
    `cmd_milestone` must turn the raw flag string into the structured list and
    forward it to `post_milestone` UNCHANGED, exactly as it already does for
    `--crs` via `release_crs`."""

    def test_the_raw_flag_string_is_parsed_and_forwarded(self):
        rec = _RecordingOps()
        rc = AXI.cmd_milestone(_args(packages=PACKAGES_FLAG), "/fake/dir", rec.ops)
        self.assertEqual(rc, 0)
        self.assertEqual(len(rec.milestone_calls), 1)
        self.assertEqual(
            rec.milestone_calls[0].get("packages"), PACKAGES,
            "cmd_milestone must parse `--packages` into one dict per artifact "
            "and hand post_milestone the result unchanged -- the same "
            "division of labour release_crs(args.crs, …) already uses")

    def test_the_format_round_trips_the_real_coordinates_losslessly(self):
        """The npm artifact is SCOPED: `@anthill-tec/crucible-server` carries
        an `@` and a `/`. Neither is a delimiter here, and no field may hold a
        `:` or a `,`, so the split can never straddle a field -- which is the
        whole reason this format was chosen over a `,`-only or `/`-delimited
        one."""
        rec = _RecordingOps()
        AXI.cmd_milestone(_args(packages=PACKAGES_FLAG), "/fake/dir", rec.ops)
        parsed = rec.milestone_calls[0].get("packages")
        self.assertEqual(
            [p["name"] for p in parsed], [PYPI_PACKAGE, NPM_PACKAGE])
        self.assertEqual([p["registry"] for p in parsed], ["pypi", "npm"])
        self.assertEqual([p["version"] for p in parsed], [VERSION, VERSION])
        # …and rebuilding the flag from the parse yields the original string.
        self.assertEqual(
            ",".join(f"{p['registry']}:{p['name']}:{p['version']}" for p in parsed),
            PACKAGES_FLAG)

    def test_absent_flag_forwards_nothing_and_empty_flag_forwards_empty(self):
        """AC4's two states, reached through the verb: no `--packages` means
        the key never leaves the client; `--packages ""` means an explicit
        empty declaration travels."""
        absent = _RecordingOps()
        AXI.cmd_milestone(_args(), "/fake/dir", absent.ops)
        self.assertIsNone(
            absent.milestone_calls[0].get("packages"),
            "no --packages must forward nothing (None), so post_milestone "
            "omits the key -- the pre-CR-084 shape")

        empty = _RecordingOps()
        AXI.cmd_milestone(_args(packages=""), "/fake/dir", empty.ops)
        self.assertEqual(
            empty.milestone_calls[0].get("packages"), [],
            "--packages \"\" must forward an EXPLICIT empty list: a release "
            "that declared no artifact is a recordable fact (§S3/AC4), not "
            "an absent field")

    def test_a_packages_only_repair_still_reaches_the_wire(self):
        """§S4 + CR-CRU-086, on the CLIENT side of the per-field rule.

        `cmd_milestone` refuses a repair whose `crs` derivation is empty
        (`clients/_crucible_axi.py:1761-1762`) and posts NOTHING. C1 made the
        server's guard PER FIELD -- `repairReleaseProvenance(held, releasedAt,
        crs, packages)` applies a non-empty `packages` while leaving a stored
        `crs` alone (proven at the wire in tests/release-provenance.test.ts,
        "arm (b) -- THE PER-FIELD CLAIM"). A whole-post client refusal is
        therefore now STRICTER than the server it guards, and would make a
        packages-only correction unreachable through every client: the one
        write §S4's backfill needs would be dropped before the wire.

        So the refusal must narrow to what it was always about: a repair with
        NOTHING to write. A repair carrying real packages has something to
        write, and travels."""
        rec = _RecordingOps(queue_crs=[])  # queue knows nothing -> empty crs
        rc = AXI.cmd_milestone(
            _args(packages=PACKAGES_FLAG, crs="CR-CRU-041",
                  repair_provenance=True),
            "/fake/dir", rec.ops)
        self.assertEqual(
            len(rec.milestone_calls), 1,
            "a --repair-provenance post carrying a NON-EMPTY packages must "
            "reach the wire even when the crs derivation came back empty -- "
            "the server applies the two fields independently, so refusing "
            "the whole post drops a correction it could have made")
        self.assertEqual(rec.milestone_calls[0].get("packages"), PACKAGES)
        self.assertEqual(
            rec.milestone_calls[0].get("crs"), [],
            "the empty crs still travels as empty -- the server's own "
            "per-field guard is what declines to write it over a stored set")
        self.assertNotEqual(
            rc, AXI.EXIT_REPAIR_REFUSED,
            "this post was not refused: something was written")

    def test_a_repair_with_nothing_at_all_to_write_is_still_refused(self):
        """The other half of the same rule, so the narrowing above cannot be
        read as "the CR-086 refusal is gone". A repair whose crs derivation is
        empty AND which declares no packages has nothing to correct, and must
        still be refused with nothing posted -- the exact path that wiped
        0.1.0's 58 CRs."""
        rec = _RecordingOps(queue_crs=[])
        rc = AXI.cmd_milestone(
            _args(crs="CR-CRU-041", repair_provenance=True), "/fake/dir", rec.ops)
        self.assertEqual(
            rec.milestone_calls, [],
            "a repair with an empty crs and no packages must post NOTHING "
            "(CR-CRU-086 §S1/§S2)")
        self.assertEqual(rc, AXI.EXIT_REPAIR_REFUSED)


if __name__ == "__main__":
    unittest.main()
