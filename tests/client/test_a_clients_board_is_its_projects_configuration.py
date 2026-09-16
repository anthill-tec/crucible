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
`test_an_installed_deployment_resolves_its_configuration.py` and
`test_no_suite_resolves_the_checkout_configuration.py` already use: an
installed client derives its install dir from its OWN module location
(`<install>/clients/_crucible_axi.py`), so a fleet copied outside the checkout
has a controllable install layer. Rewriting the SHIPPED layer's declaration in
that copy is what lets the third leg be proven by a recorded request instead of
by a probe of port 3849 -- which this project's own production instance owns,
and which no test may touch.

── Why the exports here are not a contradiction ─────────────────────

`tests/client/test_no_test_steers_a_client_by_a_retired_variable.py` forbids
any suite from steering through the four retired variables, and allow-lists
this file with a stated reason. Criterion 3 is `$CRUCIBLE_URL` and
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
shipped default as a literal in the module (`clients/bun-crucible.py:91`,
rust:87, mvn:93, python:86, and arduino:71 spelling it `CRUCIBLE` and honouring
`CRUCIBLE_BASE` as a second choice). `clients/crucible.toml` has no `[client]`
table at all, and nothing reads one. So today:

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

That leaves one hazard which is created BY the RED state itself, and it is
handled rather than accepted. A drive that exports nothing today resolves
`http://localhost:3849` from the module constant -- this machine's PRODUCTION
board -- and `register`/`unregister` are writes. So the two families that
export nothing, and every chain leg, are gated by an INTERLOCK: the fixture
first asks the shared module, in process and over no socket, which board it
would resolve for that project directory, and spawns the subprocess ONLY if the
answer is the board this fixture is listening on. A gated drive is recorded as
BLOCKED with the reason, and every assertion that depends on it fails naming
that reason -- so the criterion is still red today, and no packet is ever
addressed to 3849 on the way there.

The two families that DO export a retired variable need no interlock: today the
export is what the client obeys, and both name an address this fixture owns.

Invocation:
    python3 -m unittest tests.client.test_a_clients_board_is_its_projects_configuration -v
What CI runs (and what must list these ids):
    python3 -m unittest discover -s tests/client -t .
"""

import ast
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (
    BOARD_RESOLVER,
    SHIPPED_DEFAULT_BOARD,
    CLIENT_FILES,
    BoardInterlockCase,
    _build_fake_bin_dir,
    _load_module,
    _load_toon_module,
    _make_project_dir,
    classify_envelope,
    declare_board,
    declared_board,
    would_resolve,
)
from tests.client.test_no_test_steers_a_client_by_a_retired_variable import (
    RETIRED_VARIABLES,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
CONFIG_NAME = "crucible.toml"

#: Nothing listens on port 1 without root, so a loopback call refuses instantly
#: rather than hanging (the census's own choice, same address).
UNREACHABLE_BOARD = "http://127.0.0.1:1"

AGENT = "cr139-c2-board-probe"

#: The verbs each drive family exercises. Chosen to cover both directions
#: across the shared transport rather than to enumerate the surface: a POST
#: write (`register`), its teardown (`unregister`), and the two read verbs that
#: GET a different collection each (`status` -> plans, `queue` -> the CR queue).
#: A base URL that resolved for one and not the other would be a per-verb
#: binding, which is exactly what §S2 forbids.
VERBS = ("register", "unregister", "status", "queue")


class _RecordingBoard:
    """A live board that ANSWERS like Crucible and records every request.

    Not a mock and not an unreachable port: the question each assertion asks is
    WHICH of several reachable boards a run landed on, and only a server that
    would have accepted the call can report that it never got one. Bound on
    port 0, so two or three of these coexist without assuming anything about
    the machine.
    """

    def __init__(self, label):
        self.label = label
        self.requests = []
        self._lock = threading.Lock()
        board = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def _record(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw.decode() or "null")
                except ValueError:
                    body = None
                with board._lock:
                    board.requests.append((self.command, self.path, body))

            def _answer(self):
                encoded = json.dumps(_answer_for(self.path)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                self._record()
                self._answer()

            do_POST = do_GET
            do_PATCH = do_GET
            do_PUT = do_GET
            do_DELETE = do_GET

            def log_message(self, *args):
                pass

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                                                      _Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever,
                                        daemon=True)
        self._thread.start()

    def mark(self):
        """The current request count -- the cursor a drive's slice starts at."""
        with self._lock:
            return len(self.requests)

    def since(self, mark):
        with self._lock:
            return list(self.requests[mark:])

    def close(self):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


def _answer_for(path):
    """A body plausible enough that no client crashes before it has finished
    the call. The assertions are about WHICH board was called, so the shapes are
    the minimum each read verb needs to reach its own envelope."""
    if path.endswith("/queue"):
        return {"ok": True, "entries": [], "tracks": []}
    if path.endswith("/plans"):
        return {"ok": True, "plans": []}
    if path.rstrip("/").endswith("/agents"):
        return {"ok": True, "agents": []}
    return {"ok": True, "changed": True,
            "run": {"total": 1, "passed": 1, "failed": 0, "pending": 0}}


def drive(script_path, argv, project_dir, fake_bin_dir, extra_env=None):
    """One genuine subprocess drive of a real client, with the four retired
    variables REMOVED from the inherited environment.

    The census's own `drive_verb` cannot be reused here: it EXPORTS
    `CRUCIBLE_URL`/`CRUCIBLE_BASE` to point every drive at an unreachable
    board, which is precisely the channel under test. Scrubbing rather than
    overwriting is what makes "with nothing exported" a fact about the drive
    instead of a claim in a docstring -- an ambient value in the orchestrator's
    own session would otherwise decide the outcome of this suite.
    """
    env = os.environ.copy()
    for name in RETIRED_VARIABLES:
        env.pop(name, None)
    env["ARDUINO_CLI"] = str(Path(fake_bin_dir) / "arduino-cli")
    env["PATH"] = str(fake_bin_dir) + os.pathsep + env.get("PATH", "")
    env["WORKFLOW_ROLE"] = ""
    env["WORKFLOW_WAVE"] = ""
    if extra_env:
        env.update(extra_env)
    result = subprocess.run(
        [sys.executable, str(script_path)] + list(argv),
        cwd=str(project_dir), env=env, capture_output=True, text=True,
        timeout=60)
    exported = {name: env[name] for name in RETIRED_VARIABLES if name in env}
    return result, exported


def _argv_for(verb, project_dir):
    """The closest-to-normal-operation argv for `verb`: the project dir, plus
    every flag the fleet's own argparse makes REQUIRED (`--agent` on the write
    verbs, and `--role` on `register`). A missing required flag is refused by
    argparse before any verb function runs, which would make every board in
    this file correctly record nothing for a reason that has nothing to do with
    the criterion."""
    argv = [verb, "--project-dir", str(project_dir)]
    if verb in ("register", "unregister"):
        argv += ["--agent", AGENT]
    if verb == "register":
        argv += ["--role", "RED"]
    return argv


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
                    if extra_env is None:
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


def _scratch_fleet(root):
    """The five clients plus the two modules and the package data they read,
    copied into `<root>/clients/` so `<root>` becomes the INSTALL dir the
    running module derives from its own location.

    A module copied without its declarations can resolve nothing at all, which
    is why the shipped `crucible.toml` travels with it -- the same fleet list
    `test_no_suite_resolves_the_checkout_configuration.py` copies.
    """
    clients = Path(root) / "clients"
    clients.mkdir(parents=True)
    for name in ("_crucible_axi.py", "toon.py", CONFIG_NAME):
        shutil.copyfile(CLIENTS_DIR / name, clients / name)
    scripts = {}
    for client, script_path in CLIENT_FILES.items():
        target = clients / script_path.name
        shutil.copyfile(script_path, target)
        scripts[client] = target
    return scripts, clients / CONFIG_NAME, Path(root) / CONFIG_NAME


_CHAIN_DRIVES = None


def _chain_drives():
    """One `register` drive per client per LAYER of the CR-CRU-138 §S1 chain,
    each layer declaring a different live board.

    The legs are driven in precedence order against ONE scratch install, and
    each leg REMOVES the layer above it -- which is the chain's own rule seen
    from the outside: the install dir is what a project with no file of its own
    falls through to, and the package data is what an install with no operator
    file falls through to (`_read_project_config`, clients/_crucible_axi.py).
    """
    global _CHAIN_DRIVES
    if _CHAIN_DRIVES is not None:
        return _CHAIN_DRIVES
    fake_bin_dir = _build_fake_bin_dir()
    root = Path(tempfile.mkdtemp(prefix="cr139-c2-install-"))
    boards = {layer: _RecordingBoard(layer)
              for layer in ("project", "install", "shipped")}
    legs = {}
    try:
        scripts, shipped_config, install_config = _scratch_fleet(root)
        declare_board(shipped_config, boards["shipped"].url)
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
        # Neither the project NOR the operator's install file exists -> the
        # distribution's own package data is the last resort.
        install_config.unlink()
        for client, script_path in scripts.items():
            project_dir = _make_project_dir(client)
            try:
                (Path(project_dir) / CONFIG_NAME).unlink()
                legs[(client, "shipped")] = _one_leg(
                    script_path, project_dir, fake_bin_dir, boards, "shipped")
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


def _summarise(result):
    """The fragment of a failed drive worth putting in an assertion message:
    the exit code and the tail of each stream. A whole client envelope in a
    failure message buries the one line that explains it."""
    return (f"exit={result.returncode} stdout={result.stdout[-600:]!r} "
            f"stderr={result.stderr[-600:]!r}")


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
            len(CLIENT_FILES), 5,
            f"the fleet is FIVE clients; got {sorted(CLIENT_FILES)!r}")
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
    """Criterion 2 -- project dir beats install dir beats shipped default, by
    the chain CR-CRU-138 §S1 already built, proven one live board per layer.
    """

    @classmethod
    def setUpClass(cls):
        cls.chain = _chain_drives()

    def test_each_layer_of_the_chain_is_a_different_live_board(self):
        urls = self.chain["urls"]
        self.assertEqual(
            len(set(urls.values())), 3,
            f"the three layers must be distinguishable boards: {urls!r}")

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

    def test_with_no_operator_file_anywhere_the_shipped_declaration_resolves(self):
        """The last resort is a DATA FILE in the distribution rather than a
        number in a resolver (CR-CRU-131 §S1c), so this leg is driven by
        rewriting the declaration in the scratch install's own package data —
        never by letting a client resolve the real shipped board, whose address
        belongs to this machine's production instance."""
        for client in sorted(CLIENT_FILES):
            with self.subTest(client=client):
                self._assert_leg(client, "shipped")

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

    def test_the_shipped_declaration_is_the_board_the_fleet_has_always_defaulted_to(self):
        """§S2 -- the shipped `[client] url` IS the historical default, so an
        install with no operator file posts exactly where it did before. A file
        assertion, on purpose: resolving the real default would mean opening a
        socket to the production board."""
        shipped = CLIENTS_DIR / CONFIG_NAME
        self.assertEqual(
            declared_board(shipped), SHIPPED_DEFAULT_BOARD,
            f"{shipped} must declare `[client] url = \"{SHIPPED_DEFAULT_BOARD}\"` "
            f"— the value every client's deleted module constant defaulted to")

    def test_the_shipped_declaration_is_documented_the_way_the_limits_are(self):
        """The file an operator EDITS has to say what the setting is for. The
        limits tables each carry their sentence; a bare `url = ...` under an
        undocumented heading is a knob nobody chose."""
        text = (CLIENTS_DIR / CONFIG_NAME).read_text(encoding="utf-8")
        table = text[text.index("[client]"):] if "[client]" in text else ""
        self.assertTrue(
            table.count("#") >= 1,
            f"the `[client]` table in {CLIENTS_DIR / CONFIG_NAME} must carry "
            f"the commented explanation the limits tables carry; got "
            f"{table[:300]!r}")


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
        for path in sorted(list(CLIENT_FILES.values()) + [AXI_MODULE_PATH]):
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

    The companion half — that no SUITE may resolve that file — is enforced by
    `test_no_suite_resolves_the_checkout_configuration.py`, which this cycle
    extends from the limits to the board.
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
