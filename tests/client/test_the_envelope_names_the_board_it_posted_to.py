"""§S4 -- a verb that resolved a NON-DEFAULT board says so in its envelope.

Spec: docs/changes/CR-CRU-139-a-connection-is-configuration-too.md §S4.

The silent failure this CR exists to remove is an agent reporting into the
wrong board. C2 removed the channel that caused it -- the board is
`[client] url` in the project's own `crucible.toml` now, not an export nobody
remembers -- but removing a cause is not the same as making the effect
VISIBLE. A run that lands somewhere unexpected is still discovered later, on
the wrong dashboard, by whoever goes looking. So the envelope names the target:
a misdirected run is legible in its own output, at the moment it happens.

Two halves, and the second is the one that keeps the first honest:

  NAMED when the resolved board is not the distribution's own declaration --
  `context.board`, beside `projectKey`.

  ABSENT when it IS that declaration. `axi_context` omits absent keys rather
  than emitting empty ones, and a key present on every exit says nothing: an
  operator scanning output for "which board?" would have to read the value on
  every line to find the one line that differs. The signal is the exception,
  so it is emitted only as one.

"Not the default" is decided against `shipped_board()` -- the `[client] url`
the distribution's own package data declares -- rather than against a literal.
That is the same bytes the resolver falls back to, and the same bytes a reader
meets in the file they edit, so the document and the behaviour cannot disagree.

── Tiers ──────────────────────────────────────────────────────────────────

The first class is UNIT: `axi_context()` called in process, no socket bound
and no request made. The second is INTEGRATION: real client scripts dispatched
as subprocesses against live recording boards.

── Safety ─────────────────────────────────────────────────────────────────

No test here contacts the shipped default. That matters on this machine
specifically: the shipped declaration is the address a PRODUCTION install
listens on, and the "board is the shipped default" half would otherwise have
to post at it to prove anything. Instead the integration class stands up a
SCRATCH FLEET -- the five clients plus the shared module and its package data,
copied into a temp root -- and declares one of its OWN recording boards as that
fleet's shipped value. The distribution's default is then a port this fixture
owns, the omission is proven through the REAL resolution path, and nothing is
addressed to a port this suite does not listen on.

Every board is bound on port 0 and closed in `finally`; every temp tree is
removed in `finally`; every drive passes the shared INTERLOCK, which asks the
module the subprocess will load which board it WOULD resolve and refuses to
spawn unless it is the one this fixture is listening on. Nothing is written
inside the checkout.

Invocation:
    python3 -m unittest tests.client.test_the_envelope_names_the_board_it_posted_to -v
What CI runs (and what must list these ids):
    python3 -m unittest discover -s tests/client -t .
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    BoardInterlockCase,
    _build_fake_bin_dir,
    _load_module,
    _load_toon_module,
    _make_project_dir,
    declare_board,
    would_resolve,
)
from tests.client.test_a_clients_board_is_its_projects_configuration import (
    AXI_MODULE_PATH,
    CONFIG_NAME,
    UNREACHABLE_BOARD,
    _RecordingBoard,
    _argv_for,
    _scratch_fleet,
    _summarise,
    drive,
)

#: The envelope key this criterion is about. Spelled ONCE so the unit class and
#: the integration class cannot drift into asserting two different names.
BOARD_KEY = "board"

#: The read verb every client carries, and the closest thing to normal
#: operation that writes nothing to a board: it GETs the plans collection. The
#: envelope is what is under test, not the verb, and a read verb keeps the
#: fixture's recording boards free of writes it would then have to reason about.
VERB = "status"


def _blank_workflow_env():
    """`axi_context` reads WORKFLOW_WAVE and WORKFLOW_ROLE. The orchestrator's
    own session exports both, so a context asserted without blanking them would
    pass or fail by whoever launched the suite."""
    return mock.patch.dict(os.environ, {"WORKFLOW_WAVE": "", "WORKFLOW_ROLE": ""})


class TheContextNamesANonDefaultBoardTest(unittest.TestCase):
    """UNIT -- the shared builder, in process, over no socket.

    `axi_context` is the ONE place the fleet's envelope context is built
    (clients/_crucible_axi.py), and each client reaches it through a thin
    delegator, so a property proven here is a property of all five.
    """

    def setUp(self):
        self.axi = _load_module(AXI_MODULE_PATH, "envelope_board_unit")
        self.project_dir = Path(tempfile.mkdtemp(prefix="envelope-board-"))
        self.config = self.project_dir / CONFIG_NAME

    def tearDown(self):
        self.axi.bind_project_dir(None)
        shutil.rmtree(self.project_dir, ignore_errors=True)

    def _context(self, declared):
        declare_board(self.config, declared)
        self.axi.bind_project_dir(str(self.project_dir))
        self.assertEqual(
            self.axi.resolve_base_url(), declared,
            "fixture precondition: the resolver must answer the board this "
            "test declared, or the context under test is about a different "
            "board than the one asserted")
        with _blank_workflow_env():
            return self.axi.axi_context("probe-project-key", agent_id="probe-agent")

    def test_a_board_that_is_not_the_shipped_declaration_is_named_in_the_context(self):
        # Unreachable on purpose: building a context makes no request, so a
        # board that could not answer one proves the naming is resolution and
        # not an echo of something a server said.
        self.assertNotEqual(UNREACHABLE_BOARD, self.axi.shipped_board())
        context = self._context(UNREACHABLE_BOARD)

        self.assertIn(
            BOARD_KEY, context,
            f"the context names no board: {context!r}. A verb resolving a "
            f"board other than the distribution's own declaration "
            f"({self.axi.shipped_board()}) must say which one, or a run that "
            f"landed somewhere unexpected is legible only on the board that "
            f"recorded it")
        self.assertEqual(UNREACHABLE_BOARD, context[BOARD_KEY])
        # Beside `projectKey`, not instead of it -- the context's existing
        # contents are untouched by the addition.
        self.assertEqual("probe-project-key", context["projectKey"])
        self.assertEqual("probe-agent", context["agentId"])

    def test_the_shipped_declaration_itself_is_omitted_rather_than_named(self):
        shipped = self.axi.shipped_board()
        context = self._context(shipped)

        self.assertNotIn(
            BOARD_KEY, context,
            f"the context names {context.get(BOARD_KEY)!r}, which IS the "
            f"distribution's own declaration. A key emitted on every exit "
            f"carries no signal: the whole value of naming the target is that "
            f"an unexpected one stands out, so the default is omitted the way "
            f"every other absent key in this context is")
        self.assertEqual("probe-project-key", context["projectKey"])

    def test_the_named_board_follows_the_project_the_verb_was_given(self):
        # Point of use, never bound at import: a second project in one process
        # gets its own answer. This is the property the deleted module
        # constants could not have, and the envelope must inherit it or it
        # would name the first project's board for the second project's run.
        first = self._context(UNREACHABLE_BOARD)
        self.assertEqual(UNREACHABLE_BOARD, first.get(BOARD_KEY))

        second_dir = Path(tempfile.mkdtemp(prefix="envelope-board-second-"))
        try:
            other = "http://127.0.0.1:2"
            declare_board(second_dir / CONFIG_NAME, other)
            self.axi.bind_project_dir(str(second_dir))
            with _blank_workflow_env():
                context = self.axi.axi_context("probe-project-key")
            self.assertEqual(other, context[BOARD_KEY])
        finally:
            shutil.rmtree(second_dir, ignore_errors=True)


_FLEET_DRIVES = None


def _fleet_drives():
    """One drive per client per case, against a scratch fleet whose SHIPPED
    declaration is a board this fixture owns.

    Two cases:

    `declared` -- the project names a board that is not the fleet's shipped
                  value. The envelope must name it.
    `default`  -- the project names exactly the fleet's shipped value. The
                  envelope must omit it, and the run must still land there,
                  so the omission is "this is the default" rather than "the
                  board was never resolved".

    Built once and cached at module scope, the way the census and the C2 board
    suite build theirs: ten subprocess dispatches are the cost of the evidence,
    not of each assertion.
    """
    global _FLEET_DRIVES
    if _FLEET_DRIVES is not None:
        return _FLEET_DRIVES
    fake_bin_dir = _build_fake_bin_dir()
    root = Path(tempfile.mkdtemp(prefix="envelope-board-fleet-"))
    shipped_to = _RecordingBoard("shipped")
    declared_to = _RecordingBoard("declared")
    cases = {"declared": {}, "default": {}}
    try:
        scripts, shipped_config, install_config = _scratch_fleet(root)
        # The scratch fleet's package data declares a port THIS fixture is
        # listening on, so "the shipped default" is reachable and provable
        # without a packet addressed to the production install.
        declare_board(shipped_config, shipped_to.url)
        shutil.copyfile(shipped_config, install_config)
        axi_path = Path(shipped_config).parent / "_crucible_axi.py"
        for client, script_path in scripts.items():
            project_dir = _make_project_dir(client)
            config = Path(project_dir) / CONFIG_NAME
            try:
                for case, board in (("declared", declared_to.url),
                                    ("default", shipped_to.url)):
                    declare_board(config, board)
                    record = {"result": None, "blocked": None, "board": board,
                              "on_board": []}
                    cases[case][client] = record
                    ok, reason = would_resolve(axi_path, project_dir, board)
                    if not ok:
                        record["blocked"] = reason
                        continue
                    target = (declared_to if case == "declared" else shipped_to)
                    mark = target.mark()
                    result, _ = drive(script_path, _argv_for(VERB, project_dir),
                                      project_dir, fake_bin_dir)
                    record["result"] = result
                    record["on_board"] = target.since(mark)
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        declared_to.close()
        shipped_to.close()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _FLEET_DRIVES = {"cases": cases, "shipped": shipped_to.url,
                     "declared": declared_to.url}
    return _FLEET_DRIVES


class EveryClientsEnvelopeNamesTheBoardItPostedToTest(BoardInterlockCase):
    """INTEGRATION -- the real client scripts, dispatched as subprocesses
    against live boards.

    The unit class proves the builder. This one proves the WIRING: a builder
    that names the board is worth nothing if the clients reach their envelope
    by some other path, and the census has already found verbs that did.
    """

    @classmethod
    def setUpClass(cls):
        cls.drives = _fleet_drives()
        cls.toon = _load_toon_module()

    def _envelope(self, client, record):
        result = self.driven(f"{client} `{VERB}`", record)
        decoded = self.toon.decode(result["result"].stdout)
        self.assertIsInstance(
            decoded, dict,
            f"{client} `{VERB}` emitted no decodable envelope: "
            f"{_summarise(result['result'])}")
        self.assertIn("axi", decoded)
        context = decoded["axi"].get("context")
        self.assertIsInstance(
            context, dict,
            f"{client} `{VERB}` emitted an envelope with no context block: "
            f"{decoded['axi']!r}")
        return context

    def test_every_client_names_its_declared_board_and_that_board_recorded_the_run(self):
        drives = self.drives["cases"]["declared"]
        self.assertEqual(sorted(drives), sorted(CLIENT_FILES))
        for client, record in drives.items():
            with self.subTest(client=client):
                context = self._envelope(client, record)
                self.assertEqual(
                    self.drives["declared"], context.get(BOARD_KEY),
                    f"{client} `{VERB}` posted to "
                    f"{self.drives['declared']} and its envelope says "
                    f"{context.get(BOARD_KEY)!r}. An envelope that names a "
                    f"board other than the one it reached is worse than one "
                    f"that names none")
                # The naming is about a run that HAPPENED: the board this
                # envelope names is the board that has the request.
                self.assertNotEqual(
                    [], record["on_board"],
                    f"{client} `{VERB}` named a board that received nothing -- "
                    f"the envelope would be reporting a resolution rather than "
                    f"a destination: {_summarise(record['result'])}")

    def test_no_client_names_the_board_when_it_is_the_fleets_own_declaration(self):
        drives = self.drives["cases"]["default"]
        self.assertEqual(sorted(drives), sorted(CLIENT_FILES))
        for client, record in drives.items():
            with self.subTest(client=client):
                context = self._envelope(client, record)
                self.assertNotIn(
                    BOARD_KEY, context,
                    f"{client} `{VERB}` resolved the fleet's own shipped "
                    f"declaration and still named it. A key on every exit is "
                    f"noise an operator has to read past to find the one exit "
                    f"that went somewhere else")
                # …and the omission is not silence about a failure: the run
                # really did land on that board.
                self.assertNotEqual(
                    [], record["on_board"],
                    f"{client} `{VERB}` omitted the board AND reached none -- "
                    f"the omission would then mean 'nothing resolved', not "
                    f"'this is the default': {_summarise(record['result'])}")
                # The envelope is otherwise intact, so the omission is of one
                # key rather than of the context.
                self.assertIn("projectKey", context)


if __name__ == "__main__":
    unittest.main()
