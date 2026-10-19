"""Every `--cycle` help line describes its own verb.

A verb's `--cycle` means one of two things. A GATED verb opens the run's
identity itself and binds that identity to the cycle (the shared module's
`GATE_CYCLE_HELP` says so). A FILING verb opens no identity: the cycle rides
on the result it files, and the agent's registration is untouched (the shared
module's `FILING_CYCLE_HELP`). A verb whose help carries the other verb
kind's wording tells its reader something the run does not do.

THE POPULATION is read off each client's real argparse (`enumerate_verbs`),
never a hand-kept list: every verb whose subparser declares `--cycle`, except
`register` (whose `--cycle` binds a registration, not a run) and `plan-file`
(whose `--cycle` is a cycle LABEL).

THE ORACLE is behaviour. Each verb is driven as a real subprocess, with
`--agent` and `--cycle`, against its own `RecordingBoard`
(`tests/client/live_run_harness.py`) with every external toolchain stubbed on
PATH (the census fakes of `test_client_fleet_envelope_census.py`). The verb
opened a gated identity iff the board recorded a POST to the gated-run
identity route (`GatedRunIdentity.PATH`) whose body names the driven agent
and carries `cycleId` equal to the driven `--cycle`. That body is built only
by `GatedRunIdentity.open_payload` with the caller's cycle: the narration
ticks (`narration_poster`) and the gate's milestone identity post the same
route with NO `cycleId`, so they never count.

Each verb is driven twice, once with a green toolchain and once with a red
one (every compile, typecheck and lint step fails, and python gets a module
that does not compile):
  * a gate opens its identity only once its first step passes, so the green
    drive is the one that reaches a gated bracket;
  * a `check` that passes files nothing, so the red drive is the one that
    reaches the board for a filing verb.
A verb opened a gated identity if EITHER drive recorded it. A verb whose two
drives posted nothing at all carrying the cycle was never measured; the
census names it rather than scoring it as filing.

Invocation:
    python3 clients/python-crucible.py test --tests \
        tests.client.test_every_cycle_help_line_describes_its_own_verb
"""

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.live_run_harness import RecordingBoard, scrubbed_env
from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_module,
    _make_project_dir,
    build_argv,
    declare_and_require_board,
    enumerate_verbs,
)
from tests.client.test_every_verb_that_files_a_run_is_refused_while_a_cycle_is_active import (
    _build_recording_bin_dir,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED_MODULE = REPO_ROOT / "clients" / "_crucible_axi.py"

AGENT = "cycle-help-census-agent"
CYCLE = 7

# The two verbs whose `--cycle` is not a run's.
NOT_A_RUNS_CYCLE = ("register", "plan-file")

TIERS = ("unit", "module", "integration", "e2e", "bdd")
SEEDED_REPORTS = "seeded-reports"

_JUNIT_ONE_GREEN = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<testsuite name="Probe" tests="1" failures="0" errors="0">'
    '<testcase classname="Probe" name="probe" time="0.001"/>'
    '</testsuite>'
)

GATED = "gated"
FILING = "filing"


def _shared():
    return _load_module(SHARED_MODULE, "cycle_help_census_shared_module")


def _cycle_action(subparser):
    for action in subparser._actions:
        if "--cycle" in action.option_strings:
            return action
    return None


def _runs_cycle_verbs(client_key):
    """`{verb: subparser}` for every verb of the client that takes a run's
    `--cycle`, read off the client's own argparse."""
    verbs = enumerate_verbs(client_key, CLIENT_FILES[client_key])
    return {verb: sub for verb, sub in verbs.items()
            if verb not in NOT_A_RUNS_CYCLE and _cycle_action(sub) is not None}


def _seed(client_key, verb, project_dir, red):
    """What a drive needs beyond the census's project: a declared target for a
    tier verb, a report for an ingest-only verb, and, on the red drive only,
    a python module that does not compile. Returns the extra argv."""
    d = Path(project_dir)
    extra = []
    if client_key == "python" and red:
        (d / "app").mkdir(exist_ok=True)
        (d / "app" / "broken.py").write_text("def broken(:\n")
    if verb in TIERS:
        if client_key == "python":
            extra += ["--start-dir", "tests"]
        elif client_key == "bun":
            (d / "package.json").write_text(json.dumps(
                {"name": "probe", "scripts": {f"test:{verb}": "bun test"}}))
        elif client_key == "mvn":
            (d / "pom.xml").write_text(
                f"<project><profiles><profile><id>{verb}</id></profile>"
                f"</profiles></project>")
        elif client_key == "rust":
            (d / ".config").mkdir(exist_ok=True)
            (d / ".config" / "nextest.toml").write_text(
                f'[profile.{verb}]\n\n[profile.{verb}.junit]\npath = "junit.xml"\n')
        elif client_key == "arduino":
            (d / "tests" / "native" / "Makefile").write_text(
                f"junit-{verb}:\n\t@true\n")
    if verb == "auto-ingest" and client_key in ("python", "bun", "arduino"):
        reports = d / SEEDED_REPORTS
        reports.mkdir(exist_ok=True)
        name = "junit.xml" if client_key == "bun" else "TEST-Probe.xml"
        (reports / name).write_text(_JUNIT_ONE_GREEN)
        extra += ["--reports", str(reports)]
    return extra


def _carries_cycle(body):
    if not isinstance(body, dict):
        return False
    context = body.get("context")
    return (body.get("cycleId") == CYCLE
            or (isinstance(context, dict) and context.get("cycleId") == CYCLE))


def _drive_once(client_key, verb, subparser, red, identity_path):
    """One real drive of `verb` with `--agent AGENT --cycle CYCLE` against a
    fresh recording board. Returns `(opened, reached, transcript)`."""
    board = RecordingBoard()
    bin_dir = _build_recording_bin_dir() if red else _build_fake_bin_dir()
    project_dir = _make_project_dir(client_key)
    try:
        extra = _seed(client_key, verb, project_dir, red)
        census = build_argv(verb, subparser, project_dir)[1:]
        positionals = sum(1 for a in subparser._actions if not a.option_strings)
        if positionals:
            census = census[:len(census) - positionals]
        census[census.index("--agent") + 1] = AGENT
        argv = [verb] + extra + ["--cycle", str(CYCLE)] + census
        declare_and_require_board(project_dir, board.url, CLIENT_FILES[client_key].name)
        env = scrubbed_env(path_prefix=str(bin_dir))
        for name in ("CRUCIBLE_URL", "CRUCIBLE_BASE"):
            env.pop(name, None)
        env["ARDUINO_CLI"] = str(Path(bin_dir) / "arduino-cli")
        result = subprocess.run(
            [sys.executable, str(CLIENT_FILES[client_key])] + argv,
            cwd=str(project_dir), env=env, capture_output=True, text=True,
            timeout=120)
        posts = board.posts()
        opened = any(
            path == identity_path and isinstance(body, dict)
            and body.get("agentId") == AGENT and body.get("cycleId") == CYCLE
            for path, body in posts)
        reached = any(_carries_cycle(body) for _path, body in posts)
        transcript = (f"[{'red' if red else 'green'} drive] exit="
                      f"{result.returncode} posts={[p for p, _ in posts]} "
                      f"stderr={result.stderr.strip()[-600:]!r}")
        return opened, reached, transcript
    finally:
        board.close()
        shutil.rmtree(bin_dir, ignore_errors=True)
        shutil.rmtree(project_dir, ignore_errors=True)


def _measure(client_key, verb, subparser, identity_path):
    drives = [_drive_once(client_key, verb, subparser, red, identity_path)
              for red in (False, True)]
    return {
        "opened": any(opened for opened, _r, _t in drives),
        "reached": any(reached for _o, reached, _t in drives),
        "transcript": " | ".join(t for _o, _r, t in drives),
    }


_CENSUS = None


def _census():
    """`{(client, verb): {"help", "opened", "reached", "transcript"}}` for the
    whole fleet, measured once per test process."""
    global _CENSUS
    if _CENSUS is not None:
        return _CENSUS
    shared = _shared()
    identity_path = shared.GatedRunIdentity.PATH
    wording = {shared.GATE_CYCLE_HELP: GATED, shared.FILING_CYCLE_HELP: FILING}
    cases = {}
    for client_key in sorted(CLIENT_FILES):
        for verb, subparser in sorted(_runs_cycle_verbs(client_key).items()):
            cases[(client_key, verb)] = subparser
    census = {}
    for key, subparser in cases.items():
        # Serially: the rust gates share workspace state (their regression
        # step reclaims `target/`), and two concurrent drives of them
        # disturb each other's run.
        action = _cycle_action(subparser)
        help_text = action.help if action is not None else None
        row = _measure(key[0], key[1], subparser, identity_path)
        row["help"] = wording.get(help_text, f"neither wording: {help_text!r}")
        census[key] = row
    _CENSUS = census
    return census


def _expected(row):
    return GATED if row["opened"] else FILING


class CycleHelpMatchesTheVerbTest(unittest.TestCase):
    """For each client, every verb that takes a run's `--cycle` carries the
    gated wording iff driving it posts the gated-run identity, and the filing
    wording otherwise."""

    @classmethod
    def setUpClass(cls):
        cls.census = _census()

    def test_the_census_reaches_every_client(self):
        """Non-vacuity: every client contributes verbs, and the oracle finds
        both kinds in each, so neither half of the rule is scored on nothing."""
        for client_key in sorted(CLIENT_FILES):
            with self.subTest(client=client_key):
                rows = {verb: row for (c, verb), row in self.census.items()
                        if c == client_key}
                kinds = sorted({_expected(row) for row in rows.values()})
                self.assertEqual(
                    kinds, [FILING, GATED],
                    f"{client_key}: the census must observe at least one verb "
                    f"opening a gated identity and one filing without it; "
                    f"measured {sorted((v, _expected(r)) for v, r in rows.items())}")

    def test_every_driven_verb_reached_the_board_with_its_cycle(self):
        """A drive that posted nothing carrying the cycle measured nothing:
        scoring it FILING would hide a gated verb that never reached its
        bracket."""
        unmeasured = {f"{c} {v}": row["transcript"]
                      for (c, v), row in sorted(self.census.items())
                      if not row["reached"]}
        self.assertEqual(
            unmeasured, {},
            f"every verb taking a run's --cycle must post something carrying "
            f"cycle {CYCLE} under at least one of its two drives; unmeasured: "
            f"{unmeasured}")

    def test_each_cycle_help_carries_the_wording_its_verb_earns(self):
        """The census: help wording against observed behaviour, every client,
        every verb. A mismatch names the verb, its wording and what the drive
        showed."""
        mismatches = {}
        for (client_key, verb), row in sorted(self.census.items()):
            if not row["reached"]:
                continue  # reported by the reachability test, never scored here
            expected = _expected(row)
            if row["help"] != expected:
                observed = ("posts the gated-run identity" if row["opened"]
                            else "posts no gated-run identity")
                mismatches[f"{client_key} {verb}"] = (
                    f"help is {row['help']}, but driving it {observed}, so its "
                    f"--cycle help must be the {expected} wording")
        self.assertEqual(
            mismatches, {},
            f"every --cycle help line must describe its own verb; "
            f"mismatches: {mismatches}")

    def test_docker_e2e_gate_carries_the_filing_wording(self):
        """rust `docker-e2e-gate` opens no gated identity; its `--cycle` help
        is the filing wording `check` and `compile` carry, and its drive
        posts no gated-run identity."""
        row = self.census.get(("rust", "docker-e2e-gate"))
        if row is None:
            self.fail("rust docker-e2e-gate must take a run's --cycle and be driven")
        self.assertTrue(row["reached"], row["transcript"])
        self.assertFalse(
            row["opened"],
            f"rust docker-e2e-gate must open no gated identity; "
            f"{row['transcript']}")
        self.assertEqual(
            row["help"], FILING,
            "rust docker-e2e-gate's --cycle help must be the shared filing "
            "wording (FILING_CYCLE_HELP), not the gated one")


if __name__ == "__main__":
    unittest.main()
