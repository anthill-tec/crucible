"""CR-CRU-139 §S2 / C2 -- a client's target board is declared in its own
`crucible.toml`, and the environment no longer decides.

── The criterion, and why it is driven against MORE THAN ONE LIVE BOARD ──

"A checkout whose project-dir `crucible.toml` names a board has every one of
the five clients post THERE, for every verb, with nothing exported -- proven by
running verbs against two live boards and reading which one recorded each run."

The two-board shape is the whole assertion. A single board cannot tell
`resolved correctly` from `defaulted correctly`: a client that ignored the file
entirely and fell through to `http://localhost:3849` would look identical to
one that read it, on any fixture whose board happened to be the default. So
every drive in this file is watched by a board that is LIVE, reachable and
NAMED BY NOBODY -- and the load-bearing half of each assertion is that the
undeclared board recorded nothing at all.

The same shape answers the chain (criterion 2) without a single socket pointed
at the shipped default. Three boards, one per layer of the CR-CRU-138 §S1
chain, each a live recorder:

    <project dir>/crucible.toml      -> board PROJECT
    <install dir>/crucible.toml      -> board INSTALL
    <install>/clients/crucible.toml  -> board SHIPPED   (the package data)

The fleet is copied into a scratch install root for that, which is the idiom
`test_an_installed_deployment_resolves_its_configuration.py` already uses: an
installed client derives its install dir from its OWN module location
(`<install>/clients/_crucible_axi.py`), so a fleet copied outside the checkout
has a controllable install layer. Rewriting the SHIPPED layer's declaration in
that copy is what lets the third leg be proven by a recorded request instead of
by a probe of port 3849 -- which this project's own production instance owns,
and which no test may touch.

── Why the exports here are not a contradiction ─────────────────────

No suite steers a client through the four retired variables; this file
exports them on purpose. Criterion 3 is `$CRUCIBLE_URL` and
`$CRUCIBLE_BASE` are dead: exported to junk, nothing changes -- and the only
way to assert what a process READ is to export it and watch the outcome not
follow. A grep proves nothing about behaviour. Both directions are driven:

  * the file names a LIVE board and the environment names junk -> the run is
    recorded on the file's board;
  * the file names an UNREACHABLE board and the environment names a LIVE one ->
    the client degrades exactly as CR-CRU-131 requires, and the live board
    records nothing. This is the offline-degradation contract RE-SUBJECTED onto
    the file, not weakened: a client still formats its output with no board
    reachable, and the reachable board it was told about through a retired
    channel is not consulted.

── What each class asserts ─────────────────────────────────────

`AProjectDeclaresTheBoardEveryClientPostsToTest`  -- criterion 1.
`TheChainIsProjectThenInstallThenShippedTest`     -- criterion 2.
`TheRetiredUrlVariablesAreDeadTest`               -- criterion 3.
`TheOfflineDegradationContractIsSteeredByTheFileTest` -- criterion 4's
    preserved contract, re-subjected.
`TheOrchestratorsOwnBoardStaysOperatorStateTest`  -- criterion 5 as CORRECTED
    (the checkout's own file stays UNTRACKED operator state). A regression
    guard, labelled as one: it passes today and nothing has to be built for it.
    See that class for why the criterion inverted.

── HOW THIS FAILS IF THE CODE DOES NOTHING ──────────────────────────

Every client binds its base URL at IMPORT from the environment, with the
shipped default as a literal in the module (each client's own `CRUCIBLE_URL`
constant, since replaced by `_base_url` in `clients/bun-crucible.py`, with
arduino spelling it `CRUCIBLE` and honouring `CRUCIBLE_BASE` as a second
choice). `clients/crucible.toml` has no `[client]` table at all, and nothing
reads one. So today:

  * criterion 1 fails because NO board records anything -- with the retired
    variables scrubbed, all five clients resolve `http://localhost:3849`, which
    no fixture here is listening on (deliberately: that address belongs to the
    production instance);
  * criterion 2 fails on all three legs for the same reason;
  * criterion 3's junk-export case fails because the junk URL is exactly what
    the client obeys;
  * the offline case fails INVERTED -- the live board the environment names
    records the run, which is the accident §S2 exists to remove;
  * criterion 5 does NOT fail, and is not made to: it is a preservation clause
    (`.gitignore:10` must keep the checkout's own board file out of the repo),
    so it is labelled a regression guard rather than dressed as RED.

The ONE symbol this file pins by name is `resolve_base_url()` in
`clients/_crucible_axi.py`. §S2 requires the five module constants to collapse
into the shared module, and §S1b requires the value to stay readable and
overridable from that one place (it is what
`test_cr054_http_core_lift.py` reads back and what
`test_gate_multi_suite_coverage.py` needs in order to stop patching a constant
that will not exist). The name is the sibling of the `resolve_limit()` the same
module already exports for the same job.

── Safety, and the INTERLOCK the RED state requires ──────────────────

Every board binds port 0 and is asked what it got, so no port is ever assumed
free. Every board and every temp root is torn down in the fixture's own
`finally`, including on the failure paths -- an orphaned recorder holding a port
is the one failure mode a suite of this shape can leave behind. Nothing is
written inside the checkout.

That leaves one hazard, and it is handled rather than accepted. A drive whose
resolution is broken lands on `http://localhost:3849` -- this machine's
PRODUCTION board -- and `register`/`unregister` are writes. So every drive, and
every chain leg, is gated by an INTERLOCK: the fixture first asks the shared
module, in process and over no socket, which board it would resolve for that
project directory, and spawns the subprocess ONLY if the answer is the board
that drive is meant to reach. A gated drive is recorded as BLOCKED with the
reason, and every assertion that depends on it fails naming that reason -- so a
broken resolution is loud, and no packet is ever addressed to 3849 on the way
there.

EVERY family is gated, including the two that export a retired variable. In the
RED state those two were steered by the export, so the interlock looked like a
check with nothing to catch -- but the RED state is over, and what decides now
is `resolve_base_url()` for all four alike. A regression in that one function
would send the `junk_env` family's `register` -- a WRITE verb, creating an
agent -- to the shipped `http://localhost:3849`, which on this machine is the
PRODUCTION board, and the export the family is named for would not stop it,
because nothing reads it. The check is in process and over no socket, so
gating all four costs one function call per drive and removes the last path by
which this suite can address 3849.

Invocation:
    python3 -m unittest tests.client.integration.test_a_clients_board_is_its_projects_configuration -v
What CI runs (and what must list these ids):
    python3 -m unittest discover -s tests/client -t .
"""

import ast
import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

from tests.client.integration.test_client_fleet_envelope_census import BoardInterlockCase
from tests.client.client_fleet_envelope_census_helpers import (
    BOARD_RESOLVER,
    CLIENT_FILES,
    _build_fake_bin_dir,
    _load_module,
    _load_toon_module,
    _make_project_dir,
    classify_envelope,
    declare_board,
    would_resolve,
)
from tests.client import CLIENT_SOURCE_DIR
from tests.client.a_clients_board_is_its_projects_configuration_helpers import (
    _argv_for,
    AXI_MODULE_PATH,
    CLIENTS_DIR,
    CONFIG_NAME,
    drive,
    _RecordingBoard,
    _scratch_fleet,
    _summarise,
    UNREACHABLE_BOARD,
)

REPO_ROOT = Path(__file__).resolve().parents[3]

#: The table §S2 adds to the fleet's shipped declarations, its one key, and the
#: table family whose DOCUMENTED shape the new one is held to.
CLIENT_TABLE = "client"
URL_KEY = "url"
LIMITS_TABLE = "limits"


def _tables(path):
    """The parsed TOML document at `path` -- stdlib `tomllib`, so what is
    asserted about a shipped file is a fact about the FILE."""
    with open(path, "rb") as handle:
        return tomllib.load(handle)


def _table_prose(text, table):
    """The `#` prose INSIDE `[table]`: every comment line between its own
    header and the next header of any depth, markers stripped and joined.

    That is what an operator who has scrolled to a table reads before they
    reach its keys, which is the thing being judged -- not the file's word
    count and not a count of `#` characters.
    """
    inside, prose = False, []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            inside = stripped == "[%s]" % (table,)
            continue
        if inside and stripped.startswith("#"):
            prose.append(stripped.lstrip("#").strip())
    return " ".join(prose)


VERBS = ("register", "unregister", "status", "queue")


_BOARD_DRIVES = None


def _board_drives():
    """Every drive the first, third and fourth criteria need, against one pair
    of live boards, cached at module scope the way the census caches its own.

    Four families:

    `declared`  -- the project file names board A; nothing is exported. Five
                   clients x four verbs.
    `control`   -- the project file names board B instead. The SAME machinery,
                   pointed the other way, so a green verdict above is the
                   resolution's doing rather than a board that records nothing
                   whatever happens.
    `junk_env`  -- the project file names board A while `$CRUCIBLE_URL` and
                   `$CRUCIBLE_BASE` are exported to junk.
    `offline`   -- the project file names an UNREACHABLE board while the
                   retired pair names LIVE board B.
    """
    global _BOARD_DRIVES
    if _BOARD_DRIVES is not None:
        return _BOARD_DRIVES
    fake_bin_dir = _build_fake_bin_dir()
    declared_to = _RecordingBoard("declared")
    undeclared = _RecordingBoard("undeclared")
    families = {"declared": {}, "control": {}, "junk_env": {}, "offline": {}}
    try:
        for client, script_path in CLIENT_FILES.items():
            project_dir = _make_project_dir(client)
            config = Path(project_dir) / CONFIG_NAME
            try:
                cases = (
                    [("declared", verb, declared_to.url, None)
                     for verb in VERBS]
                    + [("control", "register", undeclared.url, None),
                       ("junk_env", "register", declared_to.url,
                        {"CRUCIBLE_URL": UNREACHABLE_BOARD,
                         "CRUCIBLE_BASE": UNREACHABLE_BOARD}),
                       ("offline", "status", UNREACHABLE_BOARD,
                        {"CRUCIBLE_URL": undeclared.url,
                         "CRUCIBLE_BASE": undeclared.url})]
                )
                for family, verb, board_url, extra_env in cases:
                    declare_board(config, board_url)
                    record = {"result": None, "exported": {},
                              "declared_board": board_url, "blocked": None,
                              "on_declared": [], "on_undeclared": []}
                    families[family][(client, verb)] = record
                    ok, reason = would_resolve(
                        AXI_MODULE_PATH, project_dir, board_url)
                    if not ok:
                        record["blocked"] = reason
                        continue
                    first, second = declared_to.mark(), undeclared.mark()
                    result, exported = drive(
                        script_path, _argv_for(verb, project_dir),
                        project_dir, fake_bin_dir, extra_env=extra_env)
                    record.update({
                        "result": result,
                        "exported": exported,
                        "on_declared": declared_to.since(first),
                        "on_undeclared": undeclared.since(second),
                    })
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        declared_to.close()
        undeclared.close()
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _BOARD_DRIVES = {"boards": (declared_to.url, undeclared.url),
                     "families": families}
    return _BOARD_DRIVES


_CHAIN_DRIVES = None


def _chain_drives():
    """One `register` drive per client per LAYER of the CR-CRU-138 §S1 chain,
    each layer declaring a different live board.

    The legs are driven in precedence order against ONE scratch install, and
    each leg REMOVES the layer above it -- which is the chain's own rule seen
    from the outside: the install dir is what a project with no file of its own
    falls through to. The chain has two layers: with neither declaring a board
    the client refuses (`resolve_base_url`, clients/_crucible_board.py).
    """
    global _CHAIN_DRIVES
    if _CHAIN_DRIVES is not None:
        return _CHAIN_DRIVES
    fake_bin_dir = _build_fake_bin_dir()
    root = Path(tempfile.mkdtemp(prefix="cr139-c2-install-"))
    boards = {layer: _RecordingBoard(layer)
              for layer in ("project", "install")}
    legs = {}
    try:
        scripts, _shipped_config, install_config = _scratch_fleet(root)
        shutil.copyfile(CLIENTS_DIR / CONFIG_NAME, install_config)
        declare_board(install_config, boards["install"].url)
        for client, script_path in scripts.items():
            project_dir = _make_project_dir(client)
            config = Path(project_dir) / CONFIG_NAME
            try:
                declare_board(config, boards["project"].url)
                legs[(client, "project")] = _one_leg(
                    script_path, project_dir, fake_bin_dir, boards, "project")
                # The project declares nothing at all -> the install's file.
                config.unlink()
                legs[(client, "install")] = _one_leg(
                    script_path, project_dir, fake_bin_dir, boards, "install")
            finally:
                shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        for board in boards.values():
            board.close()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(fake_bin_dir, ignore_errors=True)
    _CHAIN_DRIVES = {
        "legs": legs,
        "urls": {layer: board.url for layer, board in boards.items()},
    }
    return _CHAIN_DRIVES


def _one_leg(script_path, project_dir, fake_bin_dir, boards, layer):
    """One chain leg, behind the interlock. The module consulted is the SCRATCH
    fleet's own copy -- the one the subprocess will load -- because the layers
    under test are derived from that module's location, and the checkout's copy
    would answer for the checkout's install dir instead."""
    record = {"result": None, "exported": {}, "blocked": None,
              "recorded": {name: [] for name in boards}}
    axi_path = Path(script_path).parent / "_crucible_axi.py"
    ok, reason = would_resolve(axi_path, project_dir, boards[layer].url)
    if not ok:
        record["blocked"] = reason
        return record
    marks = {name: board.mark() for name, board in boards.items()}
    result, exported = drive(script_path, _argv_for("register", project_dir),
                             project_dir, fake_bin_dir)
    record.update({"result": result, "exported": exported,
                   "recorded": {name: board.since(marks[name])
                                for name, board in boards.items()}})
    return record


class AProjectDeclaresTheBoardEveryClientPostsToTest(BoardInterlockCase):
    """Criterion 1 -- the project's file decides, for every client and every
    verb, with nothing exported.
    """

    @classmethod
    def setUpClass(cls):
        cls.drives = _board_drives()
        cls.families = cls.drives["families"]

    def test_the_fleet_is_five_clients_and_every_verb_of_every_one_was_driven(self):
        """The census's own rule: a per-client claim is only as wide as the list
        it iterates. A client quietly dropped from `CLIENT_FILES` would leave
        every assertion below passing over four stacks."""
        self.assertEqual(
            len(CLIENT_FILES), 7,
            f"the fleet is SEVEN clients; got {sorted(CLIENT_FILES)!r}")
        missing = [f"{client}:{verb}" for client in CLIENT_FILES
                   for verb in VERBS
                   if (client, verb) not in self.families["declared"]]
        self.assertEqual(
            missing, [],
            f"every client owes a real drive of every verb: {missing!r}")

    def test_every_client_and_every_verb_reaches_the_board_the_project_declares(self):
        """RED today: with the retired variables scrubbed, every client resolves
        `http://localhost:3849` from its own module constant and the declared
        board records nothing."""
        for (client, verb), record in sorted(self.families["declared"].items()):
            with self.subTest(client=client, verb=verb):
                self.driven(f"{client}-crucible.py {verb}", record)
                self.assertNotEqual(
                    record["on_declared"], [],
                    f"{client}-crucible.py {verb} must reach the board its "
                    f"project's crucible.toml declares "
                    f"({record['declared_board']}), with nothing exported — "
                    f"that board recorded no request at all. "
                    f"{_summarise(record['result'])}")

    def test_no_verb_of_any_client_touches_the_board_nobody_declared(self):
        """The half a single-board fixture cannot assert. The second board is
        live and reachable throughout; a client that had resolved anything other
        than the declaration -- including by accident -- is caught here rather
        than on somebody's dashboard."""
        for (client, verb), record in sorted(self.families["declared"].items()):
            with self.subTest(client=client, verb=verb):
                self.driven(f"{client}-crucible.py {verb}", record)
                self.assertEqual(
                    record["on_undeclared"], [],
                    f"{client}-crucible.py {verb} declared "
                    f"{record['declared_board']} and reached a DIFFERENT live "
                    f"board: {record['on_undeclared']!r}")

    def test_the_undeclared_board_does_record_when_it_is_the_one_declared(self):
        """The control. Same boards, same machinery, the declaration pointed the
        other way -- so the silence asserted above is discrimination rather than
        a recorder that never worked."""
        for (client, verb), record in sorted(self.families["control"].items()):
            with self.subTest(client=client, verb=verb):
                self.driven(f"{client}-crucible.py {verb}", record)
                self.assertNotEqual(
                    record["on_undeclared"], [],
                    f"{client}-crucible.py {verb} declared the SECOND board "
                    f"({record['declared_board']}) and it recorded nothing — "
                    f"the two-board discrimination is not measuring anything. "
                    f"{_summarise(record['result'])}")
                self.assertEqual(
                    record["on_declared"], [],
                    f"{client}-crucible.py {verb} reached the board it did "
                    f"NOT declare")

    def test_not_one_of_those_drives_exported_a_retired_variable(self):
        """"With nothing exported" is part of the criterion, so it is asserted
        about the environment the drives really ran in rather than asserted in
        prose. The junk-export families below are deliberately excluded: their
        subject IS the export."""
        for (client, verb), record in sorted(self.families["declared"].items()):
            with self.subTest(client=client, verb=verb):
                self.driven(f"{client}-crucible.py {verb}", record)
                self.assertEqual(
                    record["exported"], {},
                    f"the {client}:{verb} drive inherited a retired variable "
                    f"from the ambient session: {record['exported']!r}")


class TheChainIsProjectThenInstallThenShippedTest(BoardInterlockCase):
    """Criterion 2 -- project dir beats install dir, by the chain CR-CRU-138
    §S1 already built, proven one live board per layer. There is no shipped
    layer: with neither declaring a board the client refuses.
    """

    @classmethod
    def setUpClass(cls):
        cls.chain = _chain_drives()

    def test_each_layer_of_the_chain_is_a_different_live_board(self):
        urls = self.chain["urls"]
        self.assertEqual(
            len(set(urls.values())), 2,
            f"the two layers must be distinguishable boards: {urls!r}")

    def test_the_projects_own_declaration_wins_over_the_install_and_the_shipped(self):
        for client in sorted(CLIENT_FILES):
            with self.subTest(client=client):
                self._assert_leg(client, "project")

    def test_an_unconfigured_project_falls_through_to_the_installs_declaration(self):
        """The layer CR-CRU-138 §S1 added, and the only configuration an
        operator who is not standing inside a project has."""
        for client in sorted(CLIENT_FILES):
            with self.subTest(client=client):
                self._assert_leg(client, "install")

    def _assert_leg(self, client, layer):
        record = self.driven(f"{client}-crucible.py register [{layer} layer]",
                             self.chain["legs"][(client, layer)])
        recorded = record["recorded"]
        self.assertNotEqual(
            recorded[layer], [],
            f"{client}-crucible.py register must resolve the {layer} layer's "
            f"board ({self.chain['urls'][layer]}); it recorded nothing. "
            f"{_summarise(record['result'])}")
        others = {other: rows for other, rows in recorded.items()
                  if other != layer and rows}
        self.assertEqual(
            others, {},
            f"{client}-crucible.py register resolved the {layer} layer but "
            f"also reached another layer's board: {others!r}")


class TheRetiredUrlVariablesAreDeadTest(BoardInterlockCase):
    """Criterion 3 -- `$CRUCIBLE_URL` and `$CRUCIBLE_BASE` are dead, and no
    client holds its own base-URL constant.
    """

    @classmethod
    def setUpClass(cls):
        cls.families = _board_drives()["families"]

    def test_a_junk_url_and_base_export_changes_nothing_for_any_client(self):
        """Asserted by an actual drive, never by a grep: only the outcome can
        say what a process READ. Arduino is the case that would survive a
        careless GREEN — it honours `CRUCIBLE_URL` and then `CRUCIBLE_BASE`, so
        both are exported to junk here."""
        for (client, verb), record in sorted(self.families["junk_env"].items()):
            with self.subTest(client=client, verb=verb):
                self.assertEqual(
                    sorted(record["exported"]),
                    ["CRUCIBLE_BASE", "CRUCIBLE_URL"],
                    "the drive must really have exported both retired names")
                self.assertNotEqual(
                    record["on_declared"], [],
                    f"{client}-crucible.py {verb} must still reach the board "
                    f"its project declares ({record['declared_board']}) with "
                    f"$CRUCIBLE_URL and $CRUCIBLE_BASE exported to "
                    f"{UNREACHABLE_BOARD}. {_summarise(record['result'])}")

    def test_no_client_module_holds_its_own_base_url_constant(self):
        """§S2 — the four `CRUCIBLE_URL` constants and arduino's
        `CRUCIBLE`/`CRUCIBLE_BASE` pair collapse into the shared module. A
        constant bound at import is a setting no edit an operator ever makes can
        reach, which is CR-CRU-131 §S1's argument applied to the connection."""
        offenders = {}
        for client, script_path in sorted(CLIENT_FILES.items()):
            tree = ast.parse(script_path.read_text(encoding="utf-8"),
                             filename=str(script_path))
            for node in tree.body:
                if not isinstance(node, ast.Assign):
                    continue
                for target in node.targets:
                    if (isinstance(target, ast.Name)
                            and target.id in ("CRUCIBLE_URL", "CRUCIBLE",
                                              "CRUCIBLE_BASE")):
                        offenders[f"{client}:{target.id}"] = node.lineno
        self.assertEqual(
            offenders, {},
            f"these module-level base-URL constants must be gone, replaced by "
            f"`_crucible_axi.{BOARD_RESOLVER}()` at the point of use: "
            f"{offenders!r}")

    def test_nothing_in_the_fleet_reads_either_retired_variable(self):
        """The constants could be deleted while the read survived inside a
        function, which would leave the variable alive and the criterion
        unmet. Asserted across the five clients AND the shared module, over
        every `os.environ` read shape."""
        retired = ("CRUCIBLE_URL", "CRUCIBLE_BASE")
        offenders = {}
        for path in sorted(list(CLIENT_FILES.values()) + [CLIENT_SOURCE_DIR / "_crucible_axi.py"]):
            tree = ast.parse(path.read_text(encoding="utf-8"),
                             filename=str(path))
            for node in ast.walk(tree):
                name = None
                if (isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Attribute)
                        and node.func.attr in ("get", "getenv") and node.args):
                    name = node.args[0]
                elif (isinstance(node, ast.Subscript)
                        and isinstance(node.value, ast.Attribute)
                        and node.value.attr == "environ"):
                    name = node.slice
                if (isinstance(name, ast.Constant)
                        and name.value in retired):
                    offenders[f"{path.name}:{node.lineno}"] = name.value
        self.assertEqual(
            offenders, {},
            f"the retired pair is not read anywhere in the fleet any more; "
            f"these sites still read one: {offenders!r}")

    def test_the_shared_module_resolves_the_board_in_one_place(self):
        """§S2/§S1b — one resolver, in the module all five clients already
        share, reading the chain at the POINT OF USE. It is what replaces the
        five constants, and what the two suites that read and patched them are
        re-subjected onto."""
        axi = _load_axi_module()
        resolver = getattr(axi, BOARD_RESOLVER, None)
        self.assertTrue(
            callable(resolver),
            f"clients/_crucible_axi.py must export a callable "
            f"`{BOARD_RESOLVER}()` — the one place the fleet's board is "
            f"spelled (§S2)")
        root = Path(tempfile.mkdtemp(prefix="cr139-c2-resolver-"))
        self.addCleanup(shutil.rmtree, root, True)
        self.addCleanup(axi.bind_project_dir, None)
        shutil.copyfile(CLIENTS_DIR / CONFIG_NAME, root / CONFIG_NAME)
        declare_board(root / CONFIG_NAME, "http://127.0.0.1:38501")
        axi.bind_project_dir(str(root))
        self.assertEqual(
            resolver(), "http://127.0.0.1:38501",
            f"`{BOARD_RESOLVER}()` must answer the `[client] url` the bound "
            f"project directory declares, read at the point of use")


class TheOfflineDegradationContractIsSteeredByTheFileTest(BoardInterlockCase):
    """Criterion 4's preserved contract, re-subjected: a client still formats
    its output with no board reachable (CR-CRU-131), and the board it is
    UNREACHABLE against is the one its file names — not one a retired variable
    named.
    """

    @classmethod
    def setUpClass(cls):
        cls.families = _board_drives()["families"]
        cls.toon = _load_toon_module()

    def test_every_client_still_emits_its_envelope_with_no_board_reachable(self):
        """The contract as CR-CRU-131 left it: an unreachable board degrades the
        verb, it does not break the client's output. Preserved here on the new
        mechanism rather than on the export."""
        for (client, verb), record in sorted(self.families["offline"].items()):
            with self.subTest(client=client, verb=verb):
                emitted, axi = classify_envelope(record["result"].stdout,
                                                 self.toon)
                self.assertTrue(
                    emitted,
                    f"{client}-crucible.py {verb} must still emit a decodable "
                    f"AXI envelope when its declared board is unreachable. "
                    f"{_summarise(record['result'])}")
                self.assertEqual(axi["verb"], verb)

    def test_the_live_board_a_retired_variable_named_is_never_consulted(self):
        """RED today, and INVERTED: the environment names a live board, so the
        run currently succeeds against it. That is the accident §S2 removes — an
        agent reporting into a board its project never named."""
        for (client, verb), record in sorted(self.families["offline"].items()):
            with self.subTest(client=client, verb=verb):
                self.assertEqual(
                    record["on_undeclared"], [],
                    f"{client}-crucible.py {verb} declared the unreachable "
                    f"{UNREACHABLE_BOARD} in its project file, and reached the "
                    f"LIVE board named only by $CRUCIBLE_URL/$CRUCIBLE_BASE: "
                    f"{record['on_undeclared']!r}")


class TheOrchestratorsOwnBoardStaysOperatorStateTest(unittest.TestCase):
    """Criterion 5, AS CORRECTED (user ruling 2026-09-17) — this checkout's own
    `crucible.toml` names the development board as UNTRACKED OPERATOR STATE,
    and `.gitignore` keeps it that way.

    ── Why the criterion inverted, and why that mattered ───────────────

    It first read "this checkout carries a COMMITTED `crucible.toml` naming the
    development board". Committing it would point every imperfectly isolated
    client suite in this repo at the author's LIVE development board: agents'
    test runs would post into it, which is C1's orphaned-3849 defect one port
    over. CR-CRU-138 had already decided that file is operator state
    (`.gitignore:10`) and decided correctly — an operator's port choice is not
    a repo artefact — so the criterion was corrected rather than the ignore
    rule deleted.

    ── This is a REGRESSION GUARD, and it passes today ──────────────────

    Nothing has to be built for it, and it is not dressed as a RED test. It
    exists because the reversed version of it was written down as a criterion
    once, and the next reader of §S2 who decides to "finish the job" by
    committing the file should meet an assertion rather than a live board full
    of somebody else's test rows.

    ── What is deliberately NOT asserted here ────────────────────────

    The behavioural half — "the orchestrator's own verbs reach that board with
    nothing exported" — is not re-asserted, because it is already driven. For
    a client run in this checkout the checkout root IS both the project dir and
    the install dir (`_INSTALL_DIR` is the running module's own parent), so it
    is exactly the project-dir and install-dir legs of
    `TheChainIsProjectThenInstallThenShippedTest`, which drive all five clients
    against a live board per layer. A copy here would pin one behaviour twice
    and grow the criterion count without growing the coverage.
    """

    def setUp(self):
        self.config = REPO_ROOT / CONFIG_NAME

    def _git(self, *args):
        return subprocess.run(["git"] + list(args), cwd=str(REPO_ROOT),
                              capture_output=True, text=True, timeout=30)

    def test_the_checkout_root_board_file_is_untracked_and_stays_ignored(self):
        """Both halves, because either alone is satisfiable by the wrong state:
        a file can be untracked merely because nobody added it yet, and an
        ignore rule can sit over a file that was force-added long ago."""
        tracked = self._git("ls-files", "--error-unmatch", CONFIG_NAME)
        self.assertNotEqual(
            tracked.returncode, 0,
            f"{CONFIG_NAME} at the checkout root is TRACKED. It is an "
            f"operator's own connection, not a repo artefact: committing a "
            f"board here points every suite that is not perfectly isolated at "
            f"the development instance, and agents' test runs land on a live "
            f"board (the ignore rule's own reason, and C1's 3849 orphan one "
            f"port over)")
        ignored = self._git("check-ignore", "-v", CONFIG_NAME)
        self.assertEqual(
            ignored.returncode, 0,
            f"{CONFIG_NAME} at the checkout root is no longer covered by an "
            f"ignore rule, so the next `git add -A` commits whichever board "
            f"this workstation happens to point at")

    def test_the_ignore_rule_is_anchored_so_the_shipped_declaration_still_ships(self):
        """The rule has to be `/crucible.toml`, anchored at the root. An
        unanchored `crucible.toml` would also ignore
        `clients/crucible.toml` — the PACKAGE DATA carrying the shipped
        `[client]` declaration and every limit, which §S1c requires to travel
        inside the distribution. That is the same class of accident as the
        commit this guard forbids, in the opposite direction: a client whose
        own data file never shipped can resolve nothing at all."""
        rules = [line.strip() for line
                 in (REPO_ROOT / ".gitignore").read_text(
                     encoding="utf-8").splitlines()]
        self.assertIn(
            f"/{CONFIG_NAME}", rules,
            f"`.gitignore` must ignore the checkout-root operator file by an "
            f"ANCHORED rule (`/{CONFIG_NAME}`); rules are {rules!r}")
        shipped = self._git("ls-files", "--error-unmatch",
                            f"clients/{CONFIG_NAME}")
        self.assertEqual(
            shipped.returncode, 0,
            f"clients/{CONFIG_NAME} is the distribution's own package data and "
            f"MUST stay tracked; git says {shipped.stderr.strip()!r}")


def _load_axi_module():
    """The CHECKOUT's own shared module, loaded by path -- the fleet's own
    `_axi()` idiom. Fresh per call: the bound project dir is a module global,
    and a cached copy would let one test's binding decide another's answer."""
    return _load_module(AXI_MODULE_PATH, "cr139_c2_axi_under_test")
