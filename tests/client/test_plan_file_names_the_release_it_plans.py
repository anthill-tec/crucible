"""CR-CRU-121 §S2 (fleet half) — `plan-file` gains `--release`, in ALL FIVE
clients, and the client count itself is asserted.

The route half lives in `tests/plans.test.ts`: a `plan-file` carrying a
`release` performs the same queue write `cr-plan` performs, atomically with
the plan file. This file is the SURFACE half — an orchestrator on any stack
must be able to declare that release when it opens the cycle plan, which is
the whole failure CR-CRU-121 was born from (CR-CRU-120 ran a full RED phase
off a plan whose CR was on no roadmap at all).

What is asserted, and why in these three shapes:

1. **The printed help, per client, as a real subprocess.** Five separate
   facts, any one of which can be forgotten silently. The already-declared
   `--cr` is the non-vacuity anchor: a `--help` drive that failed to run at
   all would report the NEW flag missing for a harness reason and would look
   identical to the defect under test.
2. **The ONE declaration site, read from the AST.** The criterion is "added
   at the ONE shared registrar call site — not five independent edits", so a
   client that hand-rolls `pf.add_argument("--release", …)` in its own
   `plan-file` block FAILS even when its printed help is perfect.
3. **The wire, and then the whole round trip against a real board.** A flag
   that parses and never reaches the POST body registers nothing; a POST body
   the server accepts still proves nothing until the QUEUE is read back.

RED, measured against the fleet today (2026-09-12): no client declares
`--release` on `plan-file` — `argparse` answers `unrecognized arguments:
--release` and exits 2 — and `cmd_plan_file` builds its payload with no
`release` key at all (`clients/_crucible_axi.py:2760`). The pass-side class
below pins what the addition must NOT disturb, and passes today.

ESCALATION (recorded, not guessed — see this file's report):

  E1. §S2 says the flag is "added via the ONE shared registrar line in
      `clients/_crucible_axi.py` (the same architecture CR-CRU-118 §S5 used)".
      `plan-file` HAS no shared registrar: all five clients hand-roll their
      own `pf = sub.add_parser("plan-file", …)` block plus its flags
      (arduino:1271, bun:2188, mvn:2176, python:1555, rust:2795). So the
      criterion cannot be met by adding a line to something that exists — a
      shared declaration site for `plan-file`'s arguments has to be CREATED
      first. `SharedRegistrarDeclaresTheReleaseFlagTest` therefore asserts the
      PROPERTY the criterion names (one shared declaration, reached by every
      client, zero per-client declarations) rather than a line number in a
      registrar that does not exist. The size estimate ("S") does not account
      for that refactor.

  E2. §S2's end-to-end criterion says the registration is confirmed "via a
      follow-up `queue` call". The `queue` verb's row projection
      (`_crucible_axi.build_queue_rows`) emits `cr`/`wave`/`status`/`planId`
      ONLY — it drops `release`, so no `queue` envelope can state which
      release a CR was registered into. The end-to-end below therefore takes
      the registration FACT from the client's own `queue` envelope (the row,
      its wave, its derived status and its plan link) and the RELEASE from the
      board's own `GET …/queue` in the same test. Adding `release` to
      `build_queue_rows` is a production-client change §S2 does not authorise,
      so it is escalated rather than assumed.

Invocation:
    python3 -m unittest tests.client.test_plan_file_names_the_release_it_plans
"""

import ast
import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_MODULE = CLIENTS_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}
CLIENTS = tuple(CLIENT_FILES)

# The criterion asserts the flag PER CLIENT *and* asserts the count of clients
# it drove: a loop over a collection is satisfied by a collection of one, and a
# fleet-wide claim proven on one client is the exact defect this prevents.
EXPECTED_CLIENT_COUNT = 5

VERB = "plan-file"
RELEASE_FLAG = "--release"
# A flag every client declares on `plan-file` TODAY — the non-vacuity anchor.
ANCHOR_FLAG = "--cr"

PLANS_PATH_SUFFIX = "/plans"

# The label under test, and one no normaliser can leave alone by accident: a
# pre-release suffix must arrive on the wire byte-for-byte.
RELEASE_LABEL = "0.2.0"
VERBATIM_LABEL = "9.9.9-rc.1"

# CR-CRU-118 §S4 — a proposal declares the date it aims at. Nothing here is
# ABOUT that date; the end-to-end needs a live proposal to exist at all.
FIXTURE_TARGET_AT = 1_788_220_800  # 2026-09-01T00:00:00Z

# The env keys the fleet's `context` block reads. Cleared in every drive so an
# ambient orchestrator session can never colour an envelope asserted on here.
ENV_KEYS = ("WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID",
            "WORKFLOW_CYCLE", "CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY")

# Nothing listens on port 1 without root — the fleet's help-drive idiom. A
# `--help` never reaches the wire, but a drive that somehow did must refuse
# instantly rather than touch a live board.
_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"


def _load_module_by_path(path, module_name):
    """Load a hyphen-named client (or the shared module) by file path — the
    fleet harness idiom. A missing file raises rather than skipping."""
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main(module, argv):
    """Drive the REAL argparse dispatch of a client's `main()` with `sys.argv`
    patched → (exit code, stdout, stderr). Only SystemExit is caught, so an
    argparse refusal arrives as a normal non-zero exit while any OTHER
    exception still surfaces as an ERROR rather than being swallowed."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", ["client.py"] + list(argv)):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as e:
                code = 0 if e.code is None else (e.code if isinstance(e.code, int) else 1)
    return code, stdout.getvalue(), stderr.getvalue()


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the printed surface, in every client that ships the verb
# ═══════════════════════════════════════════════════════════════════════════

_PROJECT_DIR = None
_HELP_CACHE = {}


def setUpModule():
    global _PROJECT_DIR
    _PROJECT_DIR = tempfile.mkdtemp(prefix="plan-file-release-surface-")
    (Path(_PROJECT_DIR) / ".env").write_text(
        "CRUCIBLE_PROJECT_KEY=plan-file-release-surface-key\n"
        "CRUCIBLE_PROJECT_NAME=plan-file-release-surface-project\n")


def tearDownModule():
    if _PROJECT_DIR:
        shutil.rmtree(_PROJECT_DIR, ignore_errors=True)


def _drive_plan_file_help(client):
    """A genuine subprocess dispatch of a real client script's own
    `plan-file --help`, cached per client for this process."""
    if client not in _HELP_CACHE:
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        env["CRUCIBLE_URL"] = _UNREACHABLE_CRUCIBLE_URL
        env["CRUCIBLE_BASE"] = _UNREACHABLE_CRUCIBLE_URL
        _HELP_CACHE[client] = subprocess.run(
            [sys.executable, str(CLIENT_FILES[client]), VERB, "--help"],
            cwd=_PROJECT_DIR, env=env, capture_output=True, text=True,
            timeout=60)
    return _HELP_CACHE[client]


def _release_help_block(help_stdout):
    """The `--release` entry of a printed options section, with its
    continuation lines, whitespace-normalised — the WORDING five clients must
    share when one site declares the flag."""
    lines = help_stdout.splitlines()
    for index, line in enumerate(lines):
        if line.strip().startswith(RELEASE_FLAG):
            block = [line.strip()]
            for following in lines[index + 1:]:
                if not following.strip() or following.strip().startswith("-"):
                    break
                block.append(following.strip())
            return " ".join(" ".join(block).split())
    return ""


class PlanFileDeclaresTheReleaseFlagInEveryClientTest(unittest.TestCase):
    """§S2/AC1 — every client's `plan-file` LISTS `--release`, proven by driving
    that client's own printed help as a real subprocess."""

    def setUp(self):
        self.surfaces = {client: _drive_plan_file_help(client) for client in CLIENTS}
        # Non-vacuity FIRST — `--cr` is declared TODAY by every client, so its
        # presence proves the help was really printed and read.
        unprinted = {c: (r.returncode, r.stderr.strip()[:200])
                     for c, r in self.surfaces.items() if ANCHOR_FLAG not in r.stdout}
        self.assertEqual(
            unprinted, {},
            f"every client must print its own `{VERB} --help` carrying the "
            f"already-declared {ANCHOR_FLAG}; these did not: {unprinted!r}")

    def test_every_client_prints_the_release_flag_in_its_plan_file_help(self):
        missing = sorted(c for c, r in self.surfaces.items()
                         if RELEASE_FLAG not in r.stdout)
        self.assertEqual(
            missing, [],
            f"an orchestrator on ANY stack must be able to name the release it "
            f"is opening a cycle plan for — a plan filed for a cr that sits on "
            f"no roadmap is the failure this flag exists to prevent; `{VERB}` "
            f"declares no {RELEASE_FLAG} in: {missing!r}")

        self.assertEqual(
            len(self.surfaces), EXPECTED_CLIENT_COUNT,
            f"the count of clients driven is itself asserted: drove "
            f"{sorted(self.surfaces)!r}")

    def test_the_release_flag_reads_identically_in_all_five_printed_helps(self):
        """§S2/AC1's DRY half, measured on the SURFACE: one declaration site
        cannot word itself five ways. Five independent edits drift — and the
        drift is exactly what makes a fleet flag feel unreliable."""
        wordings = {c: _release_help_block(r.stdout) for c, r in self.surfaces.items()}
        self.assertEqual(
            len(set(wordings.values())), 1,
            f"`{VERB} {RELEASE_FLAG}` must read identically in every client — "
            f"it is ONE declaration; got {wordings!r}")
        self.assertNotEqual(
            set(wordings.values()), {""},
            f"the flag must actually be PRINTED, not identically absent: an "
            f"empty block in all five is the RED state, not agreement; got "
            f"{wordings!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the ONE declaration site, read from the AST
# ═══════════════════════════════════════════════════════════════════════════
#
# The readers are deliberately tiny and local: they answer "which variable is
# this client's plan-file subparser, what flags does the client declare ON it,
# and what does it hand that variable to?" — read from the parsed tree, so a
# flag named in a docstring or a help string can never be mistaken for a
# declaration.


def _plan_file_parser_names(path):
    """The variable name(s) a client binds its `plan-file` subparser to."""
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Assign):
            continue
        call = node.value
        if (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr == "add_parser" and call.args
                and isinstance(call.args[0], ast.Constant)
                and call.args[0].value == VERB):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
    return names


def _flags_declared_directly_on(path, parser_names):
    """Every flag a file declares by calling `<parser>.add_argument("--x", …)`
    on one of `parser_names` — the client's OWN declarations."""
    flags = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_argument"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in parser_names
                and node.args and isinstance(node.args[0], ast.Constant)):
            flags.add(node.args[0].value)
    return flags


def _called_function_names(node):
    """The callee names reachable from `node`, in either spelling a client
    uses: a bare `helper(...)` or the shared module's `_axi().helper(...)`."""
    names = set()
    for inner in ast.walk(node):
        if not isinstance(inner, ast.Call):
            continue
        if isinstance(inner.func, ast.Name):
            names.add(inner.func.id)
        elif isinstance(inner.func, ast.Attribute):
            names.add(inner.func.attr)
    return names


def _functions_handed_the_parser(path, parser_names):
    """The names of every function a file calls WITH its plan-file subparser as
    an argument — the argument-registration seam (`_add_project_dir_arg(pf)`),
    plus, one hop on, whatever those client-local helpers themselves call. One
    hop is what the fleet's own delegator idiom needs: a client helper whose
    body is `return _axi().add_x(...)`."""
    tree = ast.parse(path.read_text())
    direct = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        handed = any(isinstance(a, ast.Name) and a.id in parser_names for a in node.args)
        handed = handed or any(
            isinstance(kw.value, ast.Name) and kw.value.id in parser_names
            for kw in node.keywords)
        if not handed:
            continue
        if isinstance(node.func, ast.Name):
            direct.add(node.func.id)
        elif isinstance(node.func, ast.Attribute):
            direct.add(node.func.attr)
    reachable = set(direct)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in direct:
            reachable |= _called_function_names(node)
    return reachable


def _shared_functions_declaring(flag):
    """The top-level functions of the SHARED module whose body declares `flag`
    through an `add_argument(...)` call."""
    tree = ast.parse(AXI_MODULE.read_text())
    declaring = set()
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for inner in ast.walk(node):
            if (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute)
                    and inner.func.attr == "add_argument" and inner.args
                    and isinstance(inner.args[0], ast.Constant)
                    and inner.args[0].value == flag):
                declaring.add(node.name)
    return declaring


class SharedRegistrarDeclaresTheReleaseFlagTest(unittest.TestCase):
    """§S2/AC1 — "added at the ONE shared registrar call site, not five
    independent edits", as a property of the parsed source.

    See ESCALATION E1 in this module's docstring: `plan-file` has no shared
    registrar today, so the criterion is asserted as the PROPERTY it names —
    zero per-client declarations of the flag, and every client's plan-file
    subparser handed to a shared declaration site."""

    def setUp(self):
        self.parsers = {c: _plan_file_parser_names(p) for c, p in CLIENT_FILES.items()}
        unfound = sorted(c for c, names in self.parsers.items() if not names)
        self.assertEqual(
            unfound, [],
            f"fixture sanity: every client registers a `{VERB}` subparser and "
            f"binds it to a name; could not find one in: {unfound!r}")

    def test_no_client_declares_the_release_flag_in_its_own_plan_file_block(self):
        offenders = {}
        for client, path in CLIENT_FILES.items():
            flags = _flags_declared_directly_on(path, self.parsers[client])
            # Fixture sanity in the same read: the anchor IS declared per
            # client today, so an empty set would mean the reader missed the
            # block rather than that the client is clean.
            self.assertIn(
                ANCHOR_FLAG, flags,
                f"fixture sanity: {path.name} declares {ANCHOR_FLAG} on its "
                f"own `{VERB}` parser; the AST reader found {sorted(flags)!r}")
            if RELEASE_FLAG in flags:
                offenders[client] = sorted(flags)
        self.assertEqual(
            offenders, {},
            f"{RELEASE_FLAG} must be declared ONCE, in a shared site — a "
            f"client that hand-rolls it in its own `{VERB}` block is one of "
            f"the five independent edits §S2 forbids; offenders: {offenders!r}")

    def test_every_client_hands_its_plan_file_parser_to_the_shared_declaration(self):
        declaring = _shared_functions_declaring(RELEASE_FLAG)
        unreached = {}
        for client, path in CLIENT_FILES.items():
            handed = _functions_handed_the_parser(path, self.parsers[client])
            if not (handed & declaring):
                unreached[client] = sorted(handed)
        self.assertEqual(
            unreached, {},
            f"every client must reach {RELEASE_FLAG} by handing its `{VERB}` "
            f"subparser to a function DEFINED IN {AXI_MODULE.name} that "
            f"declares the flag (directly, or through one client-local "
            f"delegator — the fleet's own `_add_*_arg` idiom). Shared "
            f"functions declaring it today: {sorted(declaring)!r}; clients "
            f"that reach none of them: {unreached!r}")


# ═══════════════════════════════════════════════════════════════════════════
# §S2 — the wire: the declared release reaches the POST body
# ═══════════════════════════════════════════════════════════════════════════
#
# Recorded at the TRANSPORT seam (`_post`), never at the shared verb: the
# payload is composed inside `cmd_plan_file`, so a recorder above it would
# assert on the client's arguments rather than on the bytes the server gets.


class _PlanFileWireTestBase(unittest.TestCase):

    PROJECT_KEY = "plan-file-release-wire-key"
    AGENT = "plan-file-release-wire-agent"
    CR = "CR-121-WIRE"

    def setUp(self):
        self.module = _load_module_by_path(
            CLIENT_FILES["python"], "plan_file_release_client_under_test")
        self.tmpdir = tempfile.mkdtemp(prefix="plan-file-release-wire-")
        (Path(self.tmpdir) / ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n")
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

    def drive(self, *extra):
        """One client dispatch with the transport recorded → (code, stdout,
        stderr, the payloads that reached the plans route)."""
        posted = []

        def fake_post(path, payload):
            posted.append((path, copy.deepcopy(payload)))
            return {"ok": True, "planId": 1, "cr": self.CR,
                    "status": "open", "cycles": [{"label": "red-green", "id": 7}]}

        argv = [VERB, "--cr", self.CR, "--title", "the wire under test",
                "--cycle", "red-green", "--wave", "6", "--agent", self.AGENT,
                "--project-dir", self.tmpdir] + list(extra)
        with mock.patch.object(self.module, "_post", side_effect=fake_post):
            code, out, err = _run_main(self.module, argv)
        return code, out, err, [p for path, p in posted
                                if path.endswith(PLANS_PATH_SUFFIX)]

    def the_one_plan_file_payload(self, *extra):
        """Drive and return the SINGLE payload that reached the plans route.
        The count is asserted, not assumed: a verb that refused its flags posts
        nothing, and a body read off an empty list would fail as an IndexError
        naming neither the verb nor its refusal."""
        code, _out, err, payloads = self.drive(*extra)
        self.assertEqual(
            len(payloads), 1,
            f"exactly ONE plan-file POST must reach the plans route for "
            f"{extra!r}; got {len(payloads)} (exit={code}, "
            f"stderr={err.strip()[:400]!r})")
        return payloads[0]


class PlanFileCarriesTheDeclaredReleaseTest(_PlanFileWireTestBase):

    def test_the_declared_release_rides_the_plan_file_body_as_its_own_field(self):
        payload = self.the_one_plan_file_payload(RELEASE_FLAG, RELEASE_LABEL)

        self.assertEqual(
            payload.get("release"), RELEASE_LABEL,
            f"the release must ride as the body's own top-level `release` — "
            f"the field the route reads to perform cr-plan's queue write; got "
            f"{payload!r}")
        # BOUND — the flag ADDS a field; it re-homes none of the existing ones.
        self.assertEqual(
            (payload.get("cr"), payload.get("title"), payload.get("wave"),
             payload.get("agentId"), payload.get("cycles")),
            (self.CR, "the wire under test", "6", self.AGENT,
             [{"label": "red-green"}]),
            f"every field plan-file already sends must arrive unchanged beside "
            f"the new one; got {payload!r}")

    def test_a_label_the_client_cannot_recognise_is_sent_verbatim(self):
        payload = self.the_one_plan_file_payload(RELEASE_FLAG, VERBATIM_LABEL)

        self.assertEqual(
            payload.get("release"), VERBATIM_LABEL,
            f"the label travels VERBATIM — the client never normalises a "
            f"pre-release suffix, strips a prefix, or otherwise rewrites what "
            f"the caller declared (§S9 puts no business rule in a client); got "
            f"{payload.get('release')!r}")


class TodaysPlanFileBodySurvivesTest(_PlanFileWireTestBase):
    """The measurement behind the word "additive": every test here passes
    BEFORE the flag exists and must pass after it."""

    def test_without_a_release_the_body_carries_no_release_key_at_all(self):
        payload = self.the_one_plan_file_payload()

        self.assertNotIn(
            "release", payload,
            f"a plan filed without a release makes no roadmap claim: the key "
            f"is ABSENT, never null and never empty — the route branches on "
            f"its presence, and a fabricated value would register the CR into "
            f"a release nobody declared; got {payload!r}")

    def test_the_body_plan_file_sends_today_is_unchanged(self):
        payload = self.the_one_plan_file_payload()

        self.assertEqual(
            payload,
            {"cr": self.CR, "agentId": self.AGENT,
             "cycles": [{"label": "red-green"}], "title": "the wire under test",
             "wave": "6", "orchestrator": self.AGENT},
            f"the release-less body is composed exactly as it is today — the "
            f"backward-compatibility constraint this change makes explicit: a "
            f"client that names no release must send the body it always sent; "
            f"got {payload!r}")


# ═══════════════════════════════════════════════════════════════════════════
# END TO END — a client files a plan, and the board shows the CR registered
# ═══════════════════════════════════════════════════════════════════════════
#
# A server built from this repo's own source, on a free port with a mkdtemp DB
# — never the live instance, never the shared project. The sibling suites'
# idiom (`test_gate_names_the_release_it_gates.py`), taken rather than
# re-invented.


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _http(base, path, payload=None, method=None):
    """One JSON call against the scratch server. A non-2xx still carries the
    server's structured body, which IS the assertion subject for a refusal."""
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        base + path, data=data, method=method or ("POST" if data else "GET"),
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())


def _await_server(base, proc, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early with {proc.returncode}")
        try:
            with urllib.request.urlopen(base + "/api/v2/health", timeout=2):
                return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"server never became reachable at {base}")


class PlanFileRegistersTheCrOnTheBoardTest(unittest.TestCase):
    """§S2's end-to-end criterion — the python client drives `plan-file` with a
    release against a REAL board, and the CR comes back REGISTERED.

    The registration is read back through the client's own `queue` verb (the
    criterion's "follow-up queue call") and the release through the board's own
    `GET …/queue` in the same test — see ESCALATION E2: the `queue` envelope's
    row projection drops `release`, so no client call can state it today.

    The unregistered sibling in the same test is what proves the row came from
    the DECLARED release and not from filing a plan at all."""

    ORCHESTRATOR = "plan-file-release-e2e-orchestrator"
    WITH_RELEASE = "CR-121-E2E-DECLARED"
    WITHOUT_RELEASE = "CR-121-E2E-SILENT"
    WAVE = "6"
    TITLE = "filing a plan registers its release"

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.mkdtemp(prefix="plan-file-release-e2e-")
        cls._proc = None
        bun = shutil.which("bun")
        if bun is None:
            raise unittest.SkipTest(
                "the queue write is a property of the real store: without "
                "`bun` there is no server to hold it. A missing toolchain, "
                "not a passing assertion.")
        port = _free_port()
        cls.base = f"http://127.0.0.1:{port}"
        cls._proc = subprocess.Popen(
            [bun, "run", "src/server.ts"], cwd=str(REPO_ROOT),
            env={**os.environ, "CRUCIBLE_PORT": str(port),
                 "CRUCIBLE_HOST": "127.0.0.1",
                 "CRUCIBLE_DB": os.path.join(cls._tmpdir, "crucible.db")},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _await_server(cls.base, cls._proc)

        project = _http(cls.base, "/api/v2/projects", {"name": "plan-file-release-e2e"})
        cls.key = project["project"]["key"]
        registered = _http(cls.base, "/api/v2/agents/register",
                           {"projectKey": cls.key, "agentId": cls.ORCHESTRATOR,
                            "role": "ORCHESTRATOR"})
        assert registered.get("ok"), f"orchestrator registration failed: {registered!r}"
        proposed = _http(cls.base, f"/api/v2/projects/{cls.key}/release-proposals",
                         {"agentId": cls.ORCHESTRATOR, "label": RELEASE_LABEL,
                          "targetAt": FIXTURE_TARGET_AT})
        assert proposed.get("ok"), f"release proposal failed: {proposed!r}"

        cls.project_dir = os.path.join(cls._tmpdir, "project")
        os.makedirs(cls.project_dir)
        Path(cls.project_dir, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={cls.key}\n")
        cls.toon = _load_module_by_path(CLIENTS_DIR / "toon.py",
                                        "plan_file_release_e2e_toon")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "_proc", None) is not None:
            cls._proc.terminate()
            try:
                cls._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                cls._proc.kill()
        shutil.rmtree(cls._tmpdir, ignore_errors=True)

    def _client(self, *argv):
        env = {k: v for k, v in os.environ.items() if k not in ENV_KEYS}
        env["CRUCIBLE_URL"] = self.base
        return subprocess.run(
            [sys.executable, str(CLIENT_FILES["python"])] + list(argv),
            cwd=str(REPO_ROOT), env=env, capture_output=True, text=True,
            timeout=120)

    def _file_plan(self, cr, *extra):
        return self._client(
            VERB, "--cr", cr, "--title", self.TITLE, "--wave", self.WAVE,
            "--cycle", "red-green", "--agent", self.ORCHESTRATOR,
            "--project-dir", self.project_dir, *extra)

    def _queue_rows_through_the_client(self):
        run = self._client("queue", "--project-dir", self.project_dir)
        self.assertEqual(
            run.returncode, 0,
            f"the follow-up `queue` read must succeed; exit={run.returncode} "
            f"stdout={run.stdout.strip()[:400]!r} stderr={run.stderr.strip()[:400]!r}")
        decoded = self.toon.decode(run.stdout)
        self.assertIn(
            "axi", decoded,
            f"`queue` must answer with a TOON-AXI envelope; got "
            f"stdout={run.stdout!r}")
        return {row.get("cr"): row for row in decoded["axi"].get("queue") or []}

    def _board_entries(self):
        body = _http(self.base, f"/api/v2/projects/{self.key}/queue")
        return {entry.get("cr"): entry for entry in body.get("entries") or []}

    def test_a_plan_filed_with_a_release_shows_the_cr_registered_on_the_board(self):
        declared = self._file_plan(self.WITH_RELEASE, RELEASE_FLAG, RELEASE_LABEL)
        self.assertEqual(
            declared.returncode, 0,
            f"the client must file a plan declaring release {RELEASE_LABEL!r}; "
            f"exit={declared.returncode} stdout={declared.stdout.strip()[:600]!r} "
            f"stderr={declared.stderr.strip()[:600]!r}")

        # The sibling that declares NO release — the control that proves the
        # registration below came from the DECLARATION and not from filing.
        silent = self._file_plan(self.WITHOUT_RELEASE)
        self.assertEqual(
            silent.returncode, 0,
            f"a release-less plan-file must still succeed (the backward-"
            f"compatibility constraint); exit={silent.returncode} "
            f"stderr={silent.stderr.strip()[:600]!r}")

        rows = self._queue_rows_through_the_client()
        self.assertIn(
            self.WITH_RELEASE, rows,
            f"the follow-up `queue` call must show the CR the plan declared a "
            f"release for — invisible here is invisible on every roadmap "
            f"surface, which is the whole defect; got {rows!r}")
        self.assertNotIn(
            self.WITHOUT_RELEASE, rows,
            f"a plan that declared NO release registers nothing: a row here "
            f"would mean the route registers on every file, not on the "
            f"declaration; got {rows!r}")

        registered = rows[self.WITH_RELEASE]
        self.assertEqual(
            (registered.get("wave"), registered.get("status")),
            (self.WAVE, "IN_PROGRESS"),
            f"the registered row carries the wave the caller declared and the "
            f"in-flight status its open plan confers; got {registered!r}")
        self.assertIsNotNone(
            registered.get("planId"),
            f"the row is linked to the plan the SAME call filed — a "
            f"registration that points at no plan is a second write that "
            f"merely looks like this one; got {registered!r}")

        # ESCALATION E2 — the release itself, from the board's own read: the
        # client's `queue` row projection does not carry it.
        entries = self._board_entries()
        self.assertEqual(
            (entries.get(self.WITH_RELEASE) or {}).get("release"), RELEASE_LABEL,
            f"the CR must be registered INTO the release the caller declared, "
            f"verbatim; got {entries!r}")
        self.assertEqual(
            (entries.get(self.WITH_RELEASE) or {}).get("title"), self.TITLE,
            f"the title the plan was filed with is the title the roadmap "
            f"shows; got {entries!r}")
        self.assertNotIn(
            self.WITHOUT_RELEASE, entries,
            f"the board agrees with the client read: the release-less plan "
            f"registered nothing; got {entries!r}")


if __name__ == "__main__":
    unittest.main()
