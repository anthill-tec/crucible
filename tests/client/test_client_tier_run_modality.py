"""CR-CRU-111 §S3 — a tier runs through its OWN stack's split where that split
exists (AC6), a cell with no declaration REFUSES and never falls back (AC6a),
rust's higher tiers stop reporting as `unit` (AC12), and arduino's tier claim
agrees with the tier it sends (AC13).

Four acceptance criteria live here, and they are the four cycle 379 owns. §S3's
rule is ONE sentence and this file is its per-CELL cross-examination: "a tier
runs through its stack's own split WHERE THAT SPLIT EXISTS; where it does not,
that tier requires a project declaration, and an absent declaration is a
refusal naming what to declare". So every assertion below is made against
(client, TIER) — never against a client — because a per-client answer specifies
at most twelve of the thirty cells and hands the other eighteen to GREEN.

  * **AC6** — "each TOOLCHAIN-SPLIT cell of §S3's matrix runs through that
    stack's own split … The invocation the client builds is the stack's own,
    and the ingested run carries the verb's tier. Every split cell is asserted
    and the cell count is itself asserted."
  * **AC6a** — "every DECLARED cell refuses when the declaration is absent:
    `ok:false`, exit 1, and `help[]` naming exactly what to declare (the
    `package.json` script, the start-dir). It may never fall back to running
    the whole suite … Asserted NOT to fire on a split cell."
  * **AC12** — "`smoke-test` and `docker-e2e-gate` carry the tier the DN's
    mapping gives them, and a run driven under a nextest profile … carries
    that profile's tier rather than the `unit` both call sites hardcode
    today."
  * **AC13** — "the POST body carries the tier, and the printed help's claim
    matches what is sent."

HOW THE INVOCATION IS MEASURED, and why it is not a monkeypatched
`subprocess.run`: every toolchain this file drives is a tiny fake EXECUTABLE
that RECORDS its own `argv` and `cwd` to `$FAKE_ARGV_LOG` before exiting. The
record is therefore what the operating system was actually asked to run —
which is what AC6 means by "the invocation the client builds is the stack's
own" — and the same log answers AC6a's negative ("it may never fall back to
running the whole suite") by being EMPTY on a refusal. No real
mvn/cargo/make/bun/arduino-cli is reachable from any drive in this file, and
no request leaves the process: the client's `_post`/`_get`/`_patch` seam is
recorded, so the live board on :3849 is never touched.

HOW THE CELL COUNT IS DERIVED, and why it is not a frozen number:
`TOOLCHAIN_SPLIT_CELLS` transcribes §S3's table ONCE, and every count in this
file is computed from it — the number of split cells, the clients they span,
and the set of cells this suite drives (each AC6 method carries a `cell`
attribute, collected by introspection and compared against the matrix). AC6's
own words are "the cell count is itself asserted — 'the client runs the tier'
is satisfiable by one client, and that is the defect this AC exists to
prevent", so a suite that quietly shrank to maven alone fails
`SplitCellCoverageTest` rather than passing with four green cells.

MEASURED ON `feature/CR-CRU-111` @ `5c14fc8` (cycles 377 and 378 merged),
2026-09-08 — what is RED here and what is a PIN, stated per test, because a
suite that does not say which of its members were born green is a suite whose
colour means nothing:

  RED  `MvnSplitCellsTest.test_the_integration_cell_runs_mavens_failsafe_...` —
         maven's `integration` cell is a SPLIT cell (failsafe /
         `integration-test` is a distinction maven's own lifecycle already
         makes) and the client refuses it as undeclared, so no maven runs at
         all.
  RED  `RustSplitCellsTest` — all THREE methods. `rust-crucible.py` hands
         `add_tier_verbs` an EMPTY mapping (`clients/rust-crucible.py:2647`),
         so `unit`, `integration` and `e2e` all refuse, and cargo's `--lib` /
         `--test <t>` / profile selection — the split §S3 names — is reachable
         only through the untiered `test` verb.
  RED  `MvnSplitCellsDoNotRefuseTest` and `RustSplitCellsDoNotRefuseTest` —
         AC6a's negative bound. Four of the eight split cells answer with the
         `tier-run-undeclared` refusal today, which is the defect AC6a's "a
         refusal demanding a declaration from cargo's `--lib` would be the
         defect" names in advance.
  RED  `BunDeclaredCellsTest.test_the_refusal_names_bun_s_own_declaration`,
         `PythonDeclaredCellsTest.test_the_refusal_names_python_s_own_...`,
         and the same assertion for mvn `bdd` / rust `module` — the part
         cycle 377 did NOT settle. 377's `tier_run_undeclared_help` refuses
         correctly but STACK-AGNOSTICALLY ("declare this stack's <tier>
         target"), so a bun caller is never told the declaration is a
         `package.json` script and a python caller is never told it is a
         start-dir. AC6a asks for `help[]` "naming exactly what to declare".
  RED  `RustHigherTiersStopReportingAsUnitTest` — all THREE. `_smoke_test`
         builds its `/api/v2/runs` payload with no `tier` key at all, so
         `smoke-test`, its `-P e2e` drive and `docker-e2e-gate` all land on
         `src/store.ts:1911`'s `tier: meta?.tier ?? "unit"` — the board
         records rust's docker e2e gate as a unit run.
  RED  `ArduinoTierClaimMatchesTheWireTest.
         test_every_arduino_verb_that_sends_a_tier_names_it_in_its_own_help` —
         `arduino test` ingests as `unit` (`_run_native_tests(args, "test",
         "unit", False)`) while its printed help names no tier at all. See
         ESCALATION 4: this is the LIVE remainder of the defect AC13
         describes, not the one AC13 quotes.
  PIN  `MvnSplitCellsTest` `unit`/`module`/`e2e` — maven is §S3's reference
         implementation and already runs surefire, `-pl <m> -am` and the
         failsafe lifecycle under the right tier. They are the bound that
         stops the AC6 fix from levelling the MECHANISM as it levels the
         vocabulary (§S3: "levelling the vocabulary must not level the
         mechanism").
  PIN  `ArduinoSplitCellTest` and `ArduinoSplitCellDoesNotRefuseTest` —
         `arduino unit` already runs the native-host `make junit` build in the
         native dir and ingests under `unit`.
  PIN  `ArduinoTierClaimMatchesTheWireTest.test_the_native_host_run_...`,
         `..._the_native_regression_run_...` and
         `..._the_target_build_stays_a_compile_ingest_with_no_test_tier` —
         AC13(i) and cycle 378's AC13a rule, held here. See ESCALATION 3: the
         CR's Context paragraph for AC13 is measurably wrong — this client has
         stamped its native runs since before this CR was cut.
  PIN  the refusal CONTRACT halves of `BunDeclaredCellsTest` /
         `PythonDeclaredCellsTest` / `MvnBddIsADeclaredCellTest` /
         `RustModuleIsADeclaredCellTest` (`ok:false`, exit 1, a non-empty
         `help[]`, no toolchain invoked and no run POSTed) — cycle 377's
         `TierRunUndeclared` hard stop already answers these, and they are the
         bound that stops the AC6a fix from turning a refusal into a fallback.
  PIN  `BunDeclaredCellsTest.test_regression_is_the_one_cell_bun_declares...`
         and its python twin — the converse bound: a patch that made every
         undeclared cell refuse by refusing WHOLESALE passes every refusal
         assertion above and fails these two.
  PIN  `SplitCellCoverageTest` — the derived count and the coverage bound.

HARNESS: cycle 378's `tests/client/test_client_tier_stamping.py`, ADOPTED
rather than re-invented — its `_ClientDriveCase` (importlib-load the
hyphenated client by path, dispatch through the REAL argparse via `main()`
with `sys.argv` patched, record the `_post` seam) is imported and subclassed
here. What this file adds is the one thing that harness has no need of: fake
toolchains that RECORD their argv, because §S3 is a claim about the
invocation and not only about the POST body. The TOON decode of the refusal
envelope follows `tests/client/test_arduino_crucible_axi.py`.

The one further addition is `drive_with_real_std`, used by the AC12 gate
drives alone: `rust-crucible.py`'s smoke body hands its nextest child the
client's own stream (`subprocess.run(..., stdout=sys.stderr)`), and an
`io.StringIO` has no `fileno()`, so the inherited drive would raise before the
run happened. Every drive in this file also passes
`assertVerbAcceptedTheInvocation` where it matters, so an argparse usage error
can never stand in for a measurement — that is how the AC6a negative probes
would otherwise pass vacuously on a verb that rejects `--agent`.

MEASURED TOTALS at the time of writing: 30 test methods, 24 failing (9 whole
methods and 15 sub-cells), 21 passing plus 16 passing sub-cells. Every failure
is one of the REDs listed above.

ESCALATIONS recorded at the time of writing (see the report for the full text):

  1. AC6a says the declared cells are "all six tiers in bun and python (where
     every cell is declared)", and AC5 says every pre-existing tier-named verb
     "keeps its behaviour" — naming bun `regression` :2010 and python
     `regression` :1373. In a fixture project that declares NOTHING, the
     strict reading of AC6a makes those two verbs refuse, which fails AC5 and
     cycle 378's `{Bun,Python}EarnedTierTest`. This file rules the collision
     the only way that leaves both satisfiable — `regression` is "every tier
     the project declares, run as one suite" (`TIER_MEANINGS`), so the whole
     suite is that tier's OWN target and never the fallback AC6a forbids —
     and asserts the other five cells per client. A different ruling changes
     `_DECLARED_CELLS_WITH_NO_TARGET`, and nothing else in this file.
  2. AC6a names the declaration mechanism for TWO stacks ("the `package.json`
     script, the start-dir") and for neither of the split stacks' declared
     cells, though it demands the same refusal from mvn `bdd` and rust
     `module`. This file asserts those two against the DN's own row for that
     stack (maven's "lifecycle + profiles", cargo's "target selection" /
     nextest profiles) — see `DECLARATION_TOKENS`. If the ruling names a
     different surface, those two assertions are the ones to retarget; the
     bun/python ones are the AC's own words.
  3. AC13's Context is measurably WRONG about the client it describes, and the
     DN's row it came from with it. "Today this client stamps nothing at all"
     and "`:1067` reads 'tier unit (§S3)' … while the code sends no `tier` at
     all" are both false: `_run_native_tests_body` has posted `"tier": tier`
     since before this CR was cut (`develop`:576, unchanged), and cycle 377
     replaced those two help strings with the shared registrar's. The census
     that produced "arduino — none, no tier literal anywhere" scanned `tier=`
     KEYWORD literals only, and arduino states its tiers POSITIONALLY
     (`_run_native_tests(args, "unit", "unit", False)`) and as a DICT KEY
     (`"tier": "unit"`). AC13(i) is therefore a PIN here, not a RED.
  4. The SAME blind spot hides two unearned stamps AC3 (cycle 378, closed)
     could not see: `arduino cmd_test` sends `unit` for a verb whose name is
     not a tier, and `arduino cmd_auto_ingest` (`clients/arduino-crucible.py`
     :729) hardcodes `"tier": "unit"` in its payload dict — for a verb that
     runs no tests at all, which is exactly the case AC3 calls "the worse
     case". Neither is asserted as an AC3 site here (cycle 379 is
     AC6/AC6a/AC12/AC13); the `test` one surfaces through AC13's help-vs-wire
     biconditional because that is the face AC13 owns. `auto-ingest` is
     reported and left alone, and it also collides with AC13's "EVERY test
     ingest" — AC3's explicit auto-ingest clause must win there or the two ACs
     contradict.
  5. AC12 says the two gate verbs "carry the tier the DN's mapping gives
     them", and the DN gives them NONE: its rust row points at "`smoke-test` /
     `docker-e2e-gate` above" and there is no such section above it (checked
     line by line). Only the profile clue survives — "nextest profiles
     (`-P ci`, `-P e2e`) carve a docker-infra tier". So this file asserts
     `e2e` for the two `-P e2e` drives (the profile's own name, the verb's own
     name, and a run that brings a compose stack up all agree), and for the
     default `-P ci` smoke run asserts only the bound AC12 itself states — a
     tier is present, it is from the vocabulary, and it is NOT `unit` —
     because a workspace-wide nextest run over cargo's `tests/` integration
     targets cannot be a run that takes no dependency. The exact value for
     `-P ci` needs a ruling.
  6. §S3 gives arduino `unit` "(+ `integration` where the native build
     separates it)", and the shipped client has no way to tell: its native
     dir is one `--dir` flag (default `tests/native`, with `tests/native-mock`
     named in the help "for the ArduinoFake L2 tier"). Two directories under
     one flag is not a split the client can read, so arduino `integration` is
     NOT asserted as a split cell here — it is left out of
     `TOOLCHAIN_SPLIT_CELLS` and needs a ruling. If it is ruled IN, this file
     asserts it by adding one tuple entry.
  7. §S3 gives rust `unit` → `--lib`, and `--lib` appears NOWHERE in
     `rust-crucible.py` today (`--test`, `--tests` and `--all-targets` do).
     The selector is real in cargo/nextest; it is the CLIENT that has no way
     to reach it. Asserted as RED on that basis.

Invocation:
    python3 -m pytest tests/client/test_client_tier_run_modality.py -q
Fallback:
    python3 tests/client/test_client_tier_run_modality.py
"""

import contextlib
import copy
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
HARNESS_PATH = Path(__file__).resolve().parent / "test_client_tier_stamping.py"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
TOON_PATH = CLIENTS_DIR / "toon.py"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Cycle 378's harness, adopted whole. Only NON-test names are taken: importing
# one of its TestCases would run that cycle's suite a second time under this
# module.
_HARNESS = _load_module(HARNESS_PATH, "cr111_c3_tier_stamping_harness")
_AXI = _load_module(AXI_MODULE_PATH, "cr111_c3_axi")
_TOON = _load_module(TOON_PATH, "cr111_c3_toon")

_ClientDriveCase = _HARNESS._ClientDriveCase
_Drive = _HARNESS._Drive
_OK_RESPONSE = _HARNESS._OK_RESPONSE
_JUNIT_SUITES_ONE_PASS = _HARNESS._JUNIT_SUITES_ONE_PASS
_JUNIT_SUITE_ONE_PASS = _HARNESS._JUNIT_SUITE_ONE_PASS
PARSED = _HARNESS.PARSED
RUNS = _HARNESS.RUNS
RUN_START = _HARNESS.RUN_START
COMPILE = _HARNESS.COMPILE

# The endpoints a TEST run's tier can ride. `COMPILE` is deliberately absent:
# a compile ingest carries no test tier at all (AC13a, cycle 378).
TEST_INGEST_ENDPOINTS = (RUN_START, RUNS, PARSED)

# The six, from the ONE client-side mirror (AC10 forbids a second copy).
TIER_VOCABULARY = frozenset(_AXI.TIER_MEANINGS)
# 377's refusal code, taken from the shared module rather than spelled again.
TIER_RUN_UNDECLARED_CODE = _AXI.TIER_RUN_UNDECLARED_CODE

AGENT = "CR-CRU-111-C3-modality-probe"


# ── §S3's matrix, transcribed ONCE ─────────────────────────────────────────
#
# The TOOLCHAIN-SPLIT cells of §S3's table: "the split the toolchain already
# makes" and "tiers it covers", per client. Every count in this file is DERIVED
# from this mapping; nothing below repeats a number.
#
#   mvn      surefire (`*Test`) · surefire scoped to a reactor module
#            (`-pl <m> -am`) · failsafe / `integration-test`
#   rust     cargo target selection — `--lib` · `--test <t>` · nextest
#            profiles (`-P ci`, `-P e2e`)
#   arduino  the native host `g++`/`make` build
#
# arduino's "(+ `integration` where the native build separates it)" is NOT
# here — see ESCALATION 6.
TOOLCHAIN_SPLIT_CELLS = {
    "mvn": ("unit", "module", "integration", "e2e"),
    "rust": ("unit", "integration", "e2e"),
    "arduino": ("unit",),
}

# The two clients whose toolchain makes NO tier split, so §S3 says every cell
# is declared.
NO_SPLIT_CLIENTS = ("bun", "python")

# ESCALATION 1 — the cells those two clients ship no target for. `regression`
# is excluded because the whole suite IS that tier's target, never a fallback.
_DECLARED_CELLS_WITH_NO_TARGET = tuple(sorted(TIER_VOCABULARY - {"regression"}))

# What a refusal must name, per stack. bun's and python's are AC6a's own words;
# mvn's and rust's are derived from the DN's row for that stack (ESCALATION 2).
# Any ONE token satisfies the assertion — this pins the SURFACE, not a wording.
DECLARATION_TOKENS = {
    "bun": ("package.json",),
    "python": ("start-dir",),
    "mvn": ("pom.xml", "maven", "mvn", "profile"),
    "rust": ("cargo", "nextest"),
}


def _split_cells():
    """§S3's split cells as `(client, tier)` pairs — the derived set every count
    in this file is computed from."""
    return frozenset((client, tier)
                     for client, tiers in TOOLCHAIN_SPLIT_CELLS.items()
                     for tier in tiers)


# ── fake toolchains that RECORD what they were asked to run ────────────────

_RECORD = """#!__PYTHON__
import json
import os
import sys

_log = os.environ.get("FAKE_ARGV_LOG")
if _log:
    with open(_log, "a") as _f:
        _f.write(json.dumps({"tool": "__TOOL__", "argv": sys.argv[1:],
                             "cwd": os.getcwd()}) + "\\n")
"""

# §S6/AC14a — a FAITHFUL fake nextest, and the faithfulness is the point. Real
# nextest writes a JUnit report only where the project's own
# `.config/nextest.toml` configures one for the profile it ran
# (`[profile.<p>.junit] path`, or the `[profile.default.junit]` every profile
# inherits — a `ci` sibling's junit reaches nothing). A fake that wrote a report
# unconditionally would supply the half an incomplete declaration instruction
# omitted, and the fixture would then COMPLETE the instruction under test: a
# declared cell would pass here while refusing to produce anything on a real
# toolchain, which is exactly the finding this behaviour exists to make
# unmaskable. Nothing is written unless a config asks for it AND the run's
# output content is supplied, so every drive with no `.config/nextest.toml` is
# unaffected.
_CARGO_TAIL = """
import tomllib

_argv = sys.argv[1:]
if "nextest" in _argv:
    _profile = "default"
    for _flag in ("-P", "--profile"):
        if _flag in _argv and _argv.index(_flag) + 1 < len(_argv):
            _profile = _argv[_argv.index(_flag) + 1]
    try:
        with open(os.path.join(os.getcwd(), ".config", "nextest.toml"), "rb") as _f:
            _profiles = (tomllib.load(_f) or {}).get("profile") or {}
    except (OSError, tomllib.TOMLDecodeError):
        _profiles = {}
    _junit = (_profiles.get(_profile) or {}).get("junit")
    if not isinstance(_junit, dict):
        _junit = (_profiles.get("default") or {}).get("junit") or {}
    _content = os.environ.get("FAKE_CARGO_JUNIT_CONTENT", "")
    if _junit.get("path") and _content:
        _out = os.path.join(os.getcwd(), "target", "nextest", _profile,
                            _junit["path"])
        os.makedirs(os.path.dirname(_out), exist_ok=True)
        with open(_out, "w") as _f:
            _f.write(_content)
sys.exit(int(os.environ.get("FAKE_CARGO_EXIT_CODE", "0")))
"""

_MAKE_TAIL = """
sys.exit(int(os.environ.get("FAKE_MAKE_EXIT_CODE", "0")))
"""

_MVNW_TAIL = """
code = int(os.environ.get("FAKE_MVN_EXIT_CODE", "0"))
if code:
    sys.stdout.write("[ERROR] /src/main/java/Probe.java:[1,1] cannot find symbol\\n")
sys.exit(code)
"""

_DOCKER_TAIL = """
sys.exit(0)
"""

_ARDUINO_CLI_TAIL = """
sys.stdout.write("probe.ino:1:1: error: 'setup' was not declared in this scope\\n")
sys.exit(1)
"""

_BUN_TAIL = """
outfile = None
for a in sys.argv[1:]:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]
content = os.environ.get("FAKE_BUN_JUNIT_CONTENT", "")
if outfile and content:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
        f.write(content)
sys.exit(int(os.environ.get("FAKE_BUN_EXIT_CODE", "0")))
"""

_PY_RUNNER_TAIL = """
argv = sys.argv[1:]
reports = argv[argv.index("-o") + 1] if "-o" in argv else None
content = os.environ.get("FAKE_PY_JUNIT_CONTENT", "")
if content and reports:
    os.makedirs(reports, exist_ok=True)
    with open(os.path.join(reports, "TEST-tier.probe.xml"), "w") as f:
        f.write(content)
    sys.exit(int(os.environ.get("FAKE_PY_EXIT_CODE", "0")))
sys.stdout.write("ModuleNotFoundError: No module named 'not_yet_written'\\n")
sys.exit(int(os.environ.get("FAKE_PY_EXIT_CODE", "1")))
"""

# Looked up on PATH by the clients under drive.
_PATH_TOOLS = {"cargo": _CARGO_TAIL, "make": _MAKE_TAIL, "docker": _DOCKER_TAIL}
# Addressed by an explicit path or a patched module constant.
_NAMED_TOOLS = {
    "fake-mvnw": _MVNW_TAIL,
    "fake-bun": _BUN_TAIL,
    "fake-python-runner": _PY_RUNNER_TAIL,
    "fake-arduino-cli": _ARDUINO_CLI_TAIL,
}

_BIN_DIR = None
_SAVED_PATH = None


def setUpModule():
    global _BIN_DIR, _SAVED_PATH
    _BIN_DIR = tempfile.mkdtemp(prefix="cr111-modality-bin-")
    for name, tail in list(_PATH_TOOLS.items()) + list(_NAMED_TOOLS.items()):
        path = Path(_BIN_DIR) / name
        body = _RECORD.replace("__PYTHON__", sys.executable).replace("__TOOL__", name)
        path.write_text(body + tail)
        path.chmod(0o755)
    _SAVED_PATH = os.environ.get("PATH", "")
    os.environ["PATH"] = _BIN_DIR + os.pathsep + _SAVED_PATH


def tearDownModule():
    if _SAVED_PATH is not None:
        os.environ["PATH"] = _SAVED_PATH
    if _BIN_DIR:
        shutil.rmtree(_BIN_DIR, ignore_errors=True)


def _fake(name):
    return str(Path(_BIN_DIR) / name)


# ── the case base: cycle 378's drive, plus the argv log ────────────────────

_MY_ENV_KEYS = ("FAKE_ARGV_LOG", "FAKE_MAKE_EXIT_CODE", "FAKE_PY_EXIT_CODE",
                "FAKE_CARGO_JUNIT_CONTENT")


class _ModalityCase(_ClientDriveCase):
    """Cycle 378's `_ClientDriveCase` (client loaded by path, real argparse via
    `main()`, `_post`/`_get`/`_patch` recorded) with ONE addition: every fake
    toolchain on PATH appends its `argv`/`cwd` to this test's own log, so a
    drive can be asked what the operating system was actually told to run."""

    PROJECT_KEY = "cr111-tier-modality-key"

    def setUp(self):
        super().setUp()
        self._my_saved = {k: os.environ.get(k) for k in _MY_ENV_KEYS}
        for key in _MY_ENV_KEYS:
            os.environ.pop(key, None)
        self.argv_log = os.path.join(self.tmpdir, "toolchain-argv.jsonl")
        os.environ["FAKE_ARGV_LOG"] = self.argv_log

    def tearDown(self):
        for key, value in self._my_saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        super().tearDown()

    def drive_with_real_std(self, argv, response=None):
        """The same drive, with REAL file descriptors for stdout/stderr.

        `rust-crucible.py`'s gate verbs hand the nextest child the client's own
        stream (`subprocess.run(..., stdout=sys.stderr)`), and an `io.StringIO`
        has no `fileno()`, so the inherited harness drive raises
        `UnsupportedOperation` before the run happens — a harness artefact that
        would masquerade as a finding. Identical `_post` recording; the streams
        are files this fixture reads back."""
        calls = []

        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return copy.deepcopy(response if response is not None else _OK_RESPONSE)

        out_path = os.path.join(self.tmpdir, "drive-stdout.txt")
        err_path = os.path.join(self.tmpdir, "drive-stderr.txt")
        with open(out_path, "w") as out, open(err_path, "w") as err:
            with mock.patch.object(self.module, "_post", side_effect=fake_post,
                                   create=True), \
                    mock.patch.object(self.module, "_get", return_value=None,
                                      create=True), \
                    mock.patch.object(self.module, "_patch",
                                      return_value={"ok": True}, create=True), \
                    mock.patch.object(sys, "argv",
                                      [f"{self.CLIENT}-crucible.py"] + list(argv)), \
                    contextlib.redirect_stdout(out), \
                    contextlib.redirect_stderr(err):
                try:
                    self.module.main()
                    code = 0
                except SystemExit as exc:
                    code = (exc.code if isinstance(exc.code, int)
                            else (0 if exc.code is None else 1))
        return _Drive(code, Path(out_path).read_text(),
                      Path(err_path).read_text(), calls)

    # ── what the toolchain was asked to run ────────────────────────────────

    def assertVerbAcceptedTheInvocation(self, drive, cell):
        """The non-vacuity bound every drive in this file needs: argparse's own
        usage refusal (exit 2) means the verb never ran, so any assertion made
        after it measured the CLI surface and not the tier."""
        argparse_refusal = drive.code == 2 or "unrecognized arguments" in drive.err \
            or "invalid choice" in drive.err
        self.assertFalse(
            argparse_refusal,
            f"{cell}: argparse refused this invocation (exit={drive.code}), so "
            f"nothing about the tier was measured: {drive.err[-500:]!r}")

    def invocations(self, tool=None):
        if not os.path.exists(self.argv_log):
            return []
        records = [json.loads(line) for line in
                   Path(self.argv_log).read_text().splitlines() if line.strip()]
        return [r for r in records if tool is None or r["tool"] == tool]

    def assertToolchainRan(self, drive, tool, cell):
        runs = self.invocations(tool)
        if drive.code == 2 or "unrecognized arguments" in drive.err:
            why = ("the verb does not even ACCEPT the flags a run of this tier "
                   "needs — it is registered as an undeclared-tier refusal, "
                   "not as a run of this stack's own split")
        elif self.refused_for_no_declaration(drive):
            why = (f"the verb answered {TIER_RUN_UNDECLARED_CODE}: this cell's "
                   f"toolchain already MAKES the split, so there is nothing "
                   f"for the project to declare")
        else:
            why = "the drive reached neither the toolchain nor a refusal"
        self.assertTrue(
            runs,
            f"AC6 — {cell}: this cell is a TOOLCHAIN-SPLIT cell of §S3's "
            f"matrix, so it must run through {tool}'s own split; the drive "
            f"invoked {tool} not once — {why}. "
            f"invocations={self.invocations()!r} exit={drive.code} "
            f"stdout={drive.out[-1200:]!r} stderr={drive.err[-1200:]!r}")
        return runs

    def assertSelects(self, runs, sequence, cell, why):
        """`sequence` appears, in order and adjacent, in SOME invocation's argv —
        the stack's own selector, spelled the way that stack spells it."""
        seq = list(sequence)
        for run in runs:
            argv = run["argv"]
            for i in range(len(argv) - len(seq) + 1):
                if argv[i:i + len(seq)] == seq:
                    return run
        self.fail(
            f"AC6 — {cell}: {why}. No invocation carried {seq!r}; "
            f"the client ran {[r['argv'] for r in runs]!r}")

    def assertDoesNotSelect(self, runs, token, cell, why):
        for run in runs:
            self.assertNotIn(
                token, run["argv"],
                f"AC6 — {cell}: {why}; the invocation carried {token!r}: "
                f"{run['argv']!r}")

    # ── what the ingest said the run was ───────────────────────────────────

    def ingest_payloads(self, drive):
        """Every TEST ingest body this run's own agent id rode out on, whichever
        of the fleet's three ingest endpoints carried it. Endpoint-agnostic on
        purpose: which endpoint a tier verb reaches is that client's own
        business (mvn's junit-dir path vs its parsed path), and pinning one
        would assert plumbing instead of the tier."""
        return [payload for path, payload in drive.calls
                if path in TEST_INGEST_ENDPOINTS
                and payload.get("agentId") == AGENT]

    def assertIngestedTier(self, drive, expected, cell):
        payloads = self.ingest_payloads(drive)
        self.assertTrue(
            payloads,
            f"AC6 — {cell}: the run was never ingested, so this test measured "
            f"no tier at all. posted={[p for p, _ in drive.calls]!r} "
            f"exit={drive.code} stderr={drive.err[-1200:]!r}")
        for payload in payloads:
            self.assertEqual(
                payload.get("tier"), expected,
                f"AC6 — {cell}: the verb ran its stack's own split, so the "
                f"ingested run must carry that verb's tier; the POST body "
                f"carried tier={payload.get('tier')!r}, expected {expected!r}.")

    # ── refusals ───────────────────────────────────────────────────────────

    def envelope(self, drive):
        decoded = _TOON.decode(drive.out)
        self.assertIn(
            "axi", decoded,
            f"stdout must decode to a TOON envelope; got {drive.out[:600]!r}")
        return decoded["axi"]

    def refused_for_no_declaration(self, drive):
        """True when this drive answered with §S1's tier-run-undeclared hard
        stop — read off the client's OWN emitted code, not a guessed wording."""
        return TIER_RUN_UNDECLARED_CODE in drive.err

    def assertRefusesWithoutFallingBack(self, drive, cell):
        """AC6a's contract, minus the naming: `ok:false`, exit 1, a `help[]`,
        and — the half that makes it a refusal rather than a warning — NO
        toolchain invoked and NO run POSTed."""
        axi = self.envelope(drive)
        self.assertIs(
            axi.get("ok"), False,
            f"AC6a — {cell}: a cell whose declaration is absent must answer "
            f"ok:false; envelope={axi!r}")
        self.assertEqual(
            drive.code, 1,
            f"AC6a — {cell}: the refusal exits 1; exit={drive.code} "
            f"stderr={drive.err[-800:]!r}")
        self.assertTrue(
            axi.get("help"),
            f"AC6a — {cell}: the refusal carries a help[] naming what to "
            f"declare; envelope={axi!r}")
        self.assertEqual(
            self.invocations(), [],
            f"AC6a — {cell}: a cell with no declared target may never fall "
            f"back to running the whole suite, so NO toolchain may be "
            f"invoked; it ran {self.invocations()!r}")
        posted = [path for path, _payload in drive.calls
                  if path in TEST_INGEST_ENDPOINTS]
        self.assertEqual(
            posted, [],
            f"AC6a — {cell}: nothing ran, so nothing may be ingested; the "
            f"drive POSTed {posted!r}")

    def assertHelpNamesTheDeclaration(self, drive, client, cell):
        axi = self.envelope(drive)
        steps = [str(s) for s in (axi.get("help") or [])]
        blob = " ".join(steps).lower()
        tokens = DECLARATION_TOKENS[client]
        self.assertTrue(
            any(token in blob for token in tokens),
            f"AC6a — {cell}: the refusal must carry `help[]` naming EXACTLY "
            f"what to declare on THIS stack (one of {list(tokens)!r}); it "
            f"names none of them: {steps!r}. A refusal that says 'declare "
            f"this stack's target' tells a caller the tier is unwired, not "
            f"where to wire it — and the same sentence is printed by all five "
            f"clients, so it cannot be naming any one stack's mechanism.")


# ── per-client fixtures ────────────────────────────────────────────────────


class _MvnModalityCase(_ModalityCase):
    CLIENT = "mvn"
    MODULE = "probe-module"

    def setUp(self):
        super().setUp()
        wrapper = Path(self.tmpdir) / "mvnw"
        wrapper.write_text(Path(_fake("fake-mvnw")).read_text())
        wrapper.chmod(0o755)

    def mvn_argv(self, verb, extra=()):
        return [verb, "--agent", AGENT, "--project-dir", self.tmpdir,
                "--maven-dir", self.tmpdir] + list(extra)

    def write_reports(self, kind="surefire", module=None, name="TEST-Probe.xml"):
        parts = [self.tmpdir] + ([module] if module else []) + ["target", f"{kind}-reports"]
        directory = Path(*parts)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / name).write_text(_JUNIT_SUITE_ONE_PASS)
        return str(directory)


class _RustModalityCase(_ModalityCase):
    CLIENT = "rust"
    CRATE = "probe_crate"

    def rust_argv(self, verb, extra=()):
        return [verb, "--agent", AGENT, "--project-dir", self.tmpdir] + list(extra)

    def write_nextest_junit(self, profile="ci"):
        directory = Path(self.tmpdir, "target", "nextest", profile)
        directory.mkdir(parents=True, exist_ok=True)
        junit = directory / "junit.xml"
        junit.write_text(_JUNIT_SUITES_ONE_PASS)
        return str(junit)


class _ArduinoModalityCase(_ModalityCase):
    CLIENT = "arduino"
    NATIVE_DIR = "tests/native"

    def arduino_argv(self, verb, extra=()):
        return [verb, "--agent", AGENT, "--project-dir", self.tmpdir] + list(extra)

    def native_dir(self):
        return os.path.join(self.tmpdir, *self.NATIVE_DIR.split("/"))

    def write_native_reports(self):
        reports = Path(self.native_dir(), "reports")
        reports.mkdir(parents=True, exist_ok=True)
        (reports / "TEST-probe.xml").write_text(_JUNIT_SUITE_ONE_PASS)
        return str(reports)


class _BunModalityCase(_ModalityCase):
    CLIENT = "bun"

    def bun_argv(self, verb, extra=(), with_bun=True):
        argv = [verb, "--project-dir", self.tmpdir]
        if with_bun:
            argv += ["--agent", AGENT, "--package-dir", self.tmpdir,
                     "--reports", "reports", "--bun", _fake("fake-bun")]
        return argv + list(extra)


class _PythonModalityCase(_ModalityCase):
    CLIENT = "python"

    def py_argv(self, verb, extra=()):
        return [verb, "--project-dir", self.tmpdir] + list(extra)


# ── AC6: every toolchain-split cell runs through that stack's own split ────


class MvnSplitCellsTest(_MvnModalityCase):
    """AC6, maven's four split cells — "maven's surefire / `-pl <m> -am` /
    failsafe lifecycle". Maven is §S3's reference implementation, so three of
    these four are PINS and their job is to stop the mechanism being levelled
    while the vocabulary is (§S3: "levelling the vocabulary must not level the
    mechanism")."""

    def test_the_unit_cell_runs_surefire_unscoped(self):
        """PIN — `mvn clean test` IS maven's surefire selection, and an
        unscoped one: a `unit` run that carried `-pl` would be running the
        MODULE cell's split and reporting it as `unit`."""
        cell = "mvn/unit"
        self.write_reports()
        drive = self.drive(self.mvn_argv("unit"))
        runs = self.assertToolchainRan(drive, "fake-mvnw", cell)
        self.assertSelects(runs, ["clean", "test"], cell,
                           "surefire is selected by maven's `test` lifecycle phase")
        self.assertDoesNotSelect(runs, "-pl", cell,
                                 "the unit cell is maven's UNSCOPED surefire "
                                 "run; `-pl` is the module cell's split")
        self.assertIngestedTier(drive, "unit", cell)

    def test_the_module_cell_runs_surefire_scoped_to_a_reactor_module(self):
        """PIN — §S3: "surefire scoped to a reactor module (`-pl <m> -am`)", and
        the CR's own note that this is not a name collision: the shipped help
        already reads "MODULE tier: mvn clean test [-pl <module> -am]"."""
        cell = "mvn/module"
        self.write_reports(module=self.MODULE)
        drive = self.drive(self.mvn_argv(
            "module", ["--module", self.MODULE, "--also-make"]))
        runs = self.assertToolchainRan(drive, "fake-mvnw", cell)
        self.assertSelects(runs, ["-pl", self.MODULE], cell,
                           "the module cell IS maven's reactor scoping")
        self.assertSelects(runs, ["-am"], cell,
                           "`--also-make` must reach maven as `-am`, the "
                           "second half of the scoping §S3 names")
        self.assertIngestedTier(drive, "module", cell)

    def test_the_integration_cell_runs_mavens_failsafe_lifecycle(self):
        """RED — maven's lifecycle already separates failsafe (`*IT`) from
        surefire, so §S3 puts `integration` in the SPLIT column: asking this
        project to declare an integration target "would invent a second
        description of a distinction its build system already makes". Today
        the cell is unwired and answers 377's undeclared refusal, so no maven
        runs at all."""
        cell = "mvn/integration"
        self.write_reports(kind="failsafe", name="TEST-ProbeIT.xml")
        drive = self.drive(self.mvn_argv("integration"))
        runs = self.assertToolchainRan(drive, "fake-mvnw", cell)
        selected = [a for run in runs for a in run["argv"]]
        self.assertTrue(
            any("integration-test" in a or a == "verify" or
                a.startswith("failsafe:") for a in selected),
            f"AC6 — {cell}: the integration cell runs maven's failsafe half "
            f"(`integration-test` / `failsafe:*` / the `verify` phase that "
            f"binds it); the client ran {[r['argv'] for r in runs]!r}")
        self.assertIngestedTier(drive, "integration", cell)

    def test_the_e2e_cell_runs_the_failsafe_it_path(self):
        """PIN — `cmd_e2e`'s existing failsafe path: `mvn clean verify` (the
        phase failsafe binds to), ingesting the failsafe reports under
        `e2e`."""
        cell = "mvn/e2e"
        self.write_reports(kind="failsafe", name="TEST-ProbeIT.xml")
        drive = self.drive(self.mvn_argv("e2e"))
        runs = self.assertToolchainRan(drive, "fake-mvnw", cell)
        self.assertSelects(runs, ["clean", "verify"], cell,
                           "failsafe's IT run is bound to maven's `verify` phase")
        self.assertIngestedTier(drive, "e2e", cell)


MvnSplitCellsTest.test_the_unit_cell_runs_surefire_unscoped.cell = ("mvn", "unit")
MvnSplitCellsTest.test_the_module_cell_runs_surefire_scoped_to_a_reactor_module.cell = (
    "mvn", "module")
MvnSplitCellsTest.test_the_integration_cell_runs_mavens_failsafe_lifecycle.cell = (
    "mvn", "integration")
MvnSplitCellsTest.test_the_e2e_cell_runs_the_failsafe_it_path.cell = ("mvn", "e2e")


class RustSplitCellsTest(_RustModalityCase):
    """AC6, cargo's three split cells — "cargo target selection — `--lib` ·
    `--test <t>` · nextest profiles".

    RED — all three. `rust-crucible.py` hands the shared registrar an EMPTY
    mapping, so every tier verb in this client is a refusal and cargo's own
    selection is reachable only through the untiered `test` verb."""

    def test_the_unit_cell_selects_cargos_lib_target(self):
        """RED — §S3 maps rust's `unit` onto cargo's in-crate `--lib` target
        (ESCALATION 7: the selector is real in cargo/nextest and absent from
        this client). A `unit` run over the whole crate would include the
        `tests/` integration targets, which is precisely the tier confusion
        the split exists to prevent."""
        cell = "rust/unit"
        self.write_nextest_junit()
        drive = self.drive(self.rust_argv("unit", ["--crate", self.CRATE]))
        runs = self.assertToolchainRan(drive, "cargo", cell)
        self.assertSelects(runs, ["--lib"], cell,
                           "cargo's own unit selection is `--lib`")
        self.assertIngestedTier(drive, "unit", cell)

    def test_the_integration_cell_selects_a_cargo_test_target(self):
        """RED — §S3 maps `integration` onto cargo's `tests/` targets, selected
        by `--test <t>`. The flag exists on the untiered `test` verb today; no
        tier verb reaches it."""
        cell = "rust/integration"
        self.write_nextest_junit()
        drive = self.drive(self.rust_argv(
            "integration", ["--crate", self.CRATE, "--test", "probe_it"]))
        runs = self.assertToolchainRan(drive, "cargo", cell)
        self.assertSelects(runs, ["--test", "probe_it"], cell,
                           "cargo selects an integration target by name")
        self.assertIngestedTier(drive, "integration", cell)

    def test_the_e2e_cell_selects_its_nextest_profile(self):
        """RED — §S3 maps `e2e` onto the nextest PROFILE (`-P e2e`, the
        docker-infra tier `.config/nextest.toml` carves out)."""
        cell = "rust/e2e"
        self.write_nextest_junit(profile="e2e")
        drive = self.drive(self.rust_argv(
            "e2e", ["--crate", self.CRATE, "--profile", "e2e"]))
        runs = self.assertToolchainRan(drive, "cargo", cell)
        self.assertSelects(runs, ["-P", "e2e"], cell,
                           "nextest selects the e2e tier by profile")
        self.assertIngestedTier(drive, "e2e", cell)


RustSplitCellsTest.test_the_unit_cell_selects_cargos_lib_target.cell = ("rust", "unit")
RustSplitCellsTest.test_the_integration_cell_selects_a_cargo_test_target.cell = (
    "rust", "integration")
RustSplitCellsTest.test_the_e2e_cell_selects_its_nextest_profile.cell = ("rust", "e2e")


class ArduinoSplitCellTest(_ArduinoModalityCase):
    """AC6, arduino's one split cell — "the native host `g++`/`make` build".

    PIN — `arduino unit` already runs `make junit` IN the native dir and
    ingests under `unit`. It is the bound that keeps the native-host build
    distinguishable from the `arduino-cli` target build, which is the whole
    reason §S3 calls arduino's three builds a split."""

    def test_the_unit_cell_runs_the_native_host_build(self):
        cell = "arduino/unit"
        self.write_native_reports()
        drive = self.drive(self.arduino_argv("unit", ["--dir", self.NATIVE_DIR]))
        runs = self.assertToolchainRan(drive, "make", cell)
        self.assertSelects(runs, ["junit"], cell,
                           "the native host build is driven by `make junit`")
        self.assertEqual(
            [os.path.realpath(r["cwd"]) for r in runs],
            [os.path.realpath(self.native_dir())],
            f"AC6 — {cell}: the native-host build runs IN the native dir "
            f"(`--dir`), which is what makes it a different build from the "
            f"`arduino-cli` target compile")
        self.assertEqual(
            self.invocations("fake-arduino-cli"), [],
            f"AC6 — {cell}: the unit cell is the NATIVE host build; reaching "
            f"arduino-cli would be the target build wearing the unit tier")
        self.assertIngestedTier(drive, "unit", cell)


ArduinoSplitCellTest.test_the_unit_cell_runs_the_native_host_build.cell = (
    "arduino", "unit")


class SplitCellCoverageTest(unittest.TestCase):
    """AC6's count, DERIVED: "Every split cell is asserted and the cell count is
    itself asserted — 'the client runs the tier' is satisfiable by one client,
    and that is the defect this AC exists to prevent."

    PIN — the instrument, not the subject. It fails when this file stops
    driving a cell §S3 names, which is exactly how a per-cell requirement
    shrinks to a per-client one unnoticed."""

    def _driven_cells(self):
        driven = {}
        for case in (MvnSplitCellsTest, RustSplitCellsTest, ArduinoSplitCellTest):
            for name in dir(case):
                if not name.startswith("test_"):
                    continue
                cell = getattr(getattr(case, name), "cell", None)
                if cell is not None:
                    driven.setdefault(cell, []).append(f"{case.__name__}.{name}")
        return driven

    def test_every_split_cell_of_the_matrix_is_driven_by_this_file(self):
        driven = self._driven_cells()
        self.assertEqual(
            set(driven), _split_cells(),
            f"AC6 is per CELL: §S3's split cells are "
            f"{sorted(_split_cells())!r} and this file drives "
            f"{sorted(driven)!r}. Every cell whose toolchain already makes the "
            f"split must be asserted against that split.")

    def test_the_asserted_cell_count_spans_more_than_one_client(self):
        cells = _split_cells()
        clients = {client for client, _tier in cells}
        self.assertEqual(
            len(cells), sum(len(t) for t in TOOLCHAIN_SPLIT_CELLS.values()),
            "the cell count is derived from §S3's matrix, never frozen")
        self.assertEqual(
            clients, set(TOOLCHAIN_SPLIT_CELLS),
            f"every client whose toolchain splits tiers must contribute cells; "
            f"got {sorted(clients)!r}")
        self.assertGreater(
            len(clients), 1,
            "AC6's named defect: 'the client runs the tier' is satisfiable by "
            "ONE client, so a matrix that collapsed to one client would make "
            "this AC unfalsifiable")


# ── AC6a: a declared cell with no declaration REFUSES ──────────────────────


class _SplitCellRefusalProbe:
    """AC6a's negative bound, shared body: "Asserted NOT to fire on a split
    cell: a refusal demanding a declaration from cargo's `--lib` would be the
    defect." The cell list comes from §S3's matrix, so these classes cannot
    drift from `SplitCellCoverageTest`."""

    def assertNoSplitCellRefuses(self, client, build_argv):
        for tier in TOOLCHAIN_SPLIT_CELLS[client]:
            with self.subTest(cell=f"{client}/{tier}"):
                drive = self.drive(build_argv(tier))
                # The argv is deliberately the MINIMUM every tier verb of this
                # client accepts, so this probe reads the refusal itself and
                # never an argparse usage error standing in for one.
                self.assertVerbAcceptedTheInvocation(drive, f"{client}/{tier}")
                self.assertFalse(
                    self.refused_for_no_declaration(drive),
                    f"AC6a — {client}/{tier}: this cell's toolchain ALREADY "
                    f"makes the split (§S3), so demanding a project "
                    f"declaration for it 'would invent a second description of "
                    f"a distinction its build system already makes'. The verb "
                    f"answered {TIER_RUN_UNDECLARED_CODE}: {drive.err[-500:]!r}")


class MvnSplitCellsDoNotRefuseTest(_MvnModalityCase, _SplitCellRefusalProbe):
    """RED — maven's `integration` cell refuses today; the other three do not."""

    def test_no_maven_split_cell_demands_a_declaration(self):
        self.write_reports()
        self.write_reports(kind="failsafe", name="TEST-ProbeIT.xml")
        self.assertNoSplitCellRefuses(
            "mvn", lambda tier: [tier, "--project-dir", self.tmpdir,
                                 "--maven-dir", self.tmpdir])


class RustSplitCellsDoNotRefuseTest(_RustModalityCase, _SplitCellRefusalProbe):
    """RED — all three of cargo's split cells refuse today."""

    def test_no_cargo_split_cell_demands_a_declaration(self):
        self.write_nextest_junit()
        self.assertNoSplitCellRefuses(
            "rust", lambda tier: [tier, "--project-dir", self.tmpdir])


class ArduinoSplitCellDoesNotRefuseTest(_ArduinoModalityCase, _SplitCellRefusalProbe):
    """PIN — arduino's native-host `unit` cell is wired and does not refuse."""

    def test_no_arduino_split_cell_demands_a_declaration(self):
        self.write_native_reports()
        self.assertNoSplitCellRefuses(
            "arduino", lambda tier: [tier, "--project-dir", self.tmpdir])


class BunDeclaredCellsTest(_BunModalityCase):
    """AC6a — bun's toolchain makes NO tier split, so every cell is declared and
    an absent declaration is a refusal naming the `package.json` script.

    PIN for the contract half (377's hard stop already answers it); RED for the
    naming half — the part 377 did not settle."""

    def test_every_undeclared_cell_refuses_and_never_falls_back(self):
        """PIN — `ok:false`, exit 1, a help[], and neither bun nor an ingest
        reached. The last two are the half that makes it a refusal: AC6a's "it
        may never fall back to running the whole suite"."""
        for tier in _DECLARED_CELLS_WITH_NO_TARGET:
            with self.subTest(cell=f"bun/{tier}"):
                drive = self.drive(self.bun_argv(tier, with_bun=False))
                self.assertRefusesWithoutFallingBack(drive, f"bun/{tier}")

    def test_the_refusal_names_bun_s_own_declaration(self):
        """RED — AC6a asks for `help[]` "naming exactly what to declare (the
        `package.json` script …)". 377's shared refusal is stack-AGNOSTIC: the
        identical sentence is printed by all five clients, so it cannot be
        naming bun's mechanism."""
        for tier in _DECLARED_CELLS_WITH_NO_TARGET:
            with self.subTest(cell=f"bun/{tier}"):
                drive = self.drive(self.bun_argv(tier, with_bun=False))
                self.assertHelpNamesTheDeclaration(drive, "bun", f"bun/{tier}")

    def test_regression_is_the_one_cell_bun_declares_and_it_runs(self):
        """PIN, and ESCALATION 1's converse bound — `regression` is "every tier
        the project declares, run as one suite", so the full-suite `bun test`
        IS that tier's own target and never the fallback AC6a forbids. A patch
        that satisfied the refusals above by refusing WHOLESALE fails here."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_PASS
        drive = self.drive(self.bun_argv("regression"))
        self.assertFalse(
            self.refused_for_no_declaration(drive),
            f"AC5/§S2 — bun `regression` ships its own full-suite target and "
            f"must keep running it; it refused: {drive.err[-500:]!r}")
        runs = self.assertToolchainRan(drive, "fake-bun", "bun/regression")
        self.assertSelects(runs, ["test"], "bun/regression",
                           "the declared regression target is the full-suite "
                           "`bun test`")


class PythonDeclaredCellsTest(_PythonModalityCase):
    """AC6a — `unittest` discovery has no tier notion, so every cell is declared
    and an absent declaration is a refusal naming the start-dir."""

    def test_every_undeclared_cell_refuses_and_never_falls_back(self):
        """PIN — the contract half."""
        for tier in _DECLARED_CELLS_WITH_NO_TARGET:
            with self.subTest(cell=f"python/{tier}"):
                drive = self.drive(self.py_argv(tier))
                self.assertRefusesWithoutFallingBack(drive, f"python/{tier}")

    def test_the_refusal_names_python_s_own_declaration(self):
        """RED — AC6a's own words again: "naming exactly what to declare (… the
        start-dir)"."""
        for tier in _DECLARED_CELLS_WITH_NO_TARGET:
            with self.subTest(cell=f"python/{tier}"):
                drive = self.drive(self.py_argv(tier))
                self.assertHelpNamesTheDeclaration(drive, "python",
                                                   f"python/{tier}")

    def test_regression_is_the_one_cell_python_declares_and_it_runs(self):
        """PIN — ESCALATION 1's converse bound for python, and the proof that
        the declared target is what actually reaches the runner: the discovery
        declaration (`-s <start-dir> -p <pattern>`) rides the invocation."""
        os.environ["FAKE_PY_JUNIT_CONTENT"] = _JUNIT_SUITE_ONE_PASS
        drive = self.drive(self.py_argv(
            "regression", ["--agent", AGENT, "--python", _fake("fake-python-runner"),
                           "--start-dir", "tests", "--pattern", "test_*.py",
                           "--reports", "reports"]))
        self.assertFalse(
            self.refused_for_no_declaration(drive),
            f"AC5/§S2 — python `regression` ships its own full-suite target "
            f"and must keep running it; it refused: {drive.err[-500:]!r}")
        runs = self.assertToolchainRan(drive, "fake-python-runner",
                                       "python/regression")
        self.assertSelects(runs, ["-s", "tests"], "python/regression",
                           "the declaration python's stack takes is the "
                           "discovery start-dir")


class MvnBddIsADeclaredCellTest(_MvnModalityCase):
    """AC6a's per-CELL proof on a SPLIT stack: "AND for the declared cells of
    the split stacks — `bdd` in maven … so the rule is proven to be per-cell
    rather than per-client". Maven's lifecycle says nothing about BDD, so the
    cell is declared even though four of maven's six are not."""

    def test_the_bdd_cell_refuses_and_never_falls_back(self):
        """PIN — the contract half."""
        self.write_reports()
        drive = self.drive(["bdd", "--project-dir", self.tmpdir,
                            "--maven-dir", self.tmpdir])
        self.assertRefusesWithoutFallingBack(drive, "mvn/bdd")

    def test_the_bdd_refusal_names_mavens_own_declaration(self):
        """RED — see ESCALATION 2: AC6a names bun's and python's mechanisms and
        not maven's, so this asserts the DN's row for the stack (maven's
        lifecycle and profiles). What it forbids either way is the
        stack-agnostic sentence all five clients share."""
        drive = self.drive(["bdd", "--project-dir", self.tmpdir,
                            "--maven-dir", self.tmpdir])
        self.assertHelpNamesTheDeclaration(drive, "mvn", "mvn/bdd")


class RustModuleIsADeclaredCellTest(_RustModalityCase):
    """AC6a's other per-CELL proof on a split stack: "`module` in cargo". Cargo
    splits `--lib` from `tests/`, but nothing in cargo describes a MODULE
    boundary, so that cell is declared while `unit`/`integration`/`e2e` are
    not."""

    def test_the_module_cell_refuses_and_never_falls_back(self):
        """PIN — the contract half."""
        self.write_nextest_junit()
        drive = self.drive(["module", "--project-dir", self.tmpdir])
        self.assertRefusesWithoutFallingBack(drive, "rust/module")

    def test_the_module_refusal_names_cargos_own_declaration(self):
        """RED — ESCALATION 2 again, for cargo."""
        drive = self.drive(["module", "--project-dir", self.tmpdir])
        self.assertHelpNamesTheDeclaration(drive, "rust", "rust/module")


# ── AC12: rust's higher tiers stop reporting as `unit` ─────────────────────


class RustHigherTiersStopReportingAsUnitTest(_RustModalityCase):
    """AC12 — "asserted on the POST body per verb: `smoke-test` and
    `docker-e2e-gate` carry the tier the DN's mapping gives them, and a run
    driven under a nextest profile … carries that profile's tier rather than
    the `unit` both call sites hardcode today".

    RED — all three. `_smoke_test` builds its `/api/v2/runs` payload with no
    `tier` key at all, so `smoke-test`, its `-P e2e` drive and
    `docker-e2e-gate` all land on `src/store.ts:1911`'s
    `tier: meta?.tier ?? "unit"` and the board records rust's docker e2e gate
    as a unit run. See ESCALATION 5 for what the DN does and does not say about
    the mapping."""

    def gate_drive(self, argv, profile):
        """Drive a gate verb with its ENVIRONMENT stubbed and its RUN intact:
        docker and the disk guard are the machine this test runs on, never the
        behaviour under test. `cargo` is still the recording fake, and the
        junit the gate ingests is the fixture's."""
        self.write_nextest_junit(profile=profile)
        with mock.patch.object(self.module, "_docker_up", return_value=0), \
                mock.patch.object(self.module, "_docker_down", return_value=0), \
                mock.patch.object(self.module, "_disk_guard", return_value=True):
            drive = self.drive_with_real_std(argv)
        self.assertVerbAcceptedTheInvocation(drive, f"rust gate {argv[0]}")
        return drive

    def assertGateTier(self, drive, verb, expected):
        payloads = self.ingest_payloads(drive)
        self.assertTrue(
            payloads,
            f"AC12 — rust `{verb}`: the gate ingested nothing, so this test "
            f"measured no tier. posted={[p for p, _ in drive.calls]!r} "
            f"exit={drive.code} stderr={drive.err[-1500:]!r}")
        for payload in payloads:
            self.assertEqual(
                payload.get("tier"), expected,
                f"AC12 — rust `{verb}`: this run is not a unit run, and a "
                f"tier-less body lands on the server's ?? unit default "
                f"(`src/store.ts:1911`), so the board reports it as one. POST "
                f"body carried tier={payload.get('tier')!r}, expected "
                f"{expected!r}.")

    def test_the_docker_e2e_gate_reports_the_tier_it_actually_ran(self):
        """RED — this verb brings a compose stack UP and runs the `-P e2e`
        docker-infra profile against it: a live service is the dependency
        `integration`/`e2e` name, and `unit` is defined as taking none."""
        drive = self.gate_drive(
            ["docker-e2e-gate", "--agent", AGENT, "--project-dir", self.tmpdir],
            profile="e2e")
        self.assertGateTier(drive, "docker-e2e-gate", "e2e")

    def test_a_smoke_run_under_the_e2e_profile_carries_that_profiles_tier(self):
        """RED — AC12's third clause: the PROFILE is the caller's own tier
        statement, and `smoke-test --profile e2e` is the same run the gate
        makes."""
        drive = self.gate_drive(
            ["smoke-test", "--agent", AGENT, "--project-dir", self.tmpdir,
             "--profile", "e2e"],
            profile="e2e")
        self.assertGateTier(drive, "smoke-test --profile e2e", "e2e")

    def test_the_default_smoke_run_is_not_reported_as_a_unit_run(self):
        """RED — the default `-P ci` smoke run is `cargo nextest run
        --workspace`: every crate's `tests/` integration targets included. Its
        exact tier needs a ruling (ESCALATION 5), so this asserts only what
        AC12 itself states — a tier is stated, it is one of the six, and it is
        NOT `unit`."""
        drive = self.gate_drive(
            ["smoke-test", "--agent", AGENT, "--project-dir", self.tmpdir],
            profile="ci")
        payloads = self.ingest_payloads(drive)
        self.assertTrue(
            payloads,
            f"AC12 — rust `smoke-test`: nothing was ingested. "
            f"posted={[p for p, _ in drive.calls]!r} exit={drive.code} "
            f"stderr={drive.err[-1500:]!r}")
        for payload in payloads:
            stated = payload.get("tier")
            self.assertIn(
                stated, TIER_VOCABULARY,
                f"AC12 — rust `smoke-test`: the run must STATE its tier from "
                f"the six ({sorted(TIER_VOCABULARY)!r}); it stated "
                f"{stated!r}, which the server turns into `unit` by default.")
            self.assertNotEqual(
                stated, "unit",
                "AC12 — rust `smoke-test`: a workspace-wide nextest run "
                "covers cargo's `tests/` integration targets, so it cannot be "
                "a run that takes no dependency beyond the code under test.")


# ── AC13: arduino's tier claim agrees with the tier it sends ───────────────

_TIER_CLAIM_RE = re.compile(
    r"\b(?:tier\s+(unit|module|integration|e2e|regression|bdd)\b"
    r"|(unit|module|integration|e2e|regression|bdd)\s+tier\b)",
    re.IGNORECASE)


def _help_blocks(root_help):
    """`{verb: help text}` parsed out of a client's OWN printed root help —
    argparse lists each subcommand at a fixed indent with its wrapped help
    beside it. AC13 is a claim about the PRINTED help, so it is read from the
    print and never from `add_parser(help=...)` in the source."""
    blocks, current = {}, None
    for line in root_help.splitlines():
        entry = re.match(r"^ {2,6}(\S+)\s{2,}(.*)$", line)
        if entry and not entry.group(1).startswith("-"):
            current = entry.group(1)
            blocks[current] = entry.group(2).strip()
            continue
        continuation = re.match(r"^ {8,}(\S.*)$", line)
        if continuation and current:
            blocks[current] += " " + continuation.group(1).strip()
            continue
        if line.strip() == "":
            continue
        current = None
    return blocks


def _claimed_tier(help_text):
    match = _TIER_CLAIM_RE.search(help_text or "")
    if not match:
        return None
    return (match.group(1) or match.group(2)).lower()


class ArduinoTierClaimMatchesTheWireTest(_ArduinoModalityCase):
    """AC13 — "the POST body carries the tier, and the printed help's claim
    matches what is sent".

    See ESCALATION 3: the CR's Context for this AC is measurably wrong. This
    client HAS stamped its native runs since before the CR was cut, and cycle
    377 replaced the two help strings AC13 quotes. What survives is the same
    defect on another verb and in the other direction — `arduino test` ingests
    as `unit` while its printed help names no tier at all — so the assertion is
    the BICONDITIONAL: a verb that sends a tier names it, and a verb that names
    one sends it. Either repair satisfies it; only the present silence does
    not."""

    def wire_tier(self, verb, extra=()):
        self.write_native_reports()
        drive = self.drive(self.arduino_argv(
            verb, list(extra) + ["--dir", self.NATIVE_DIR]))
        payloads = self.ingest_payloads(drive)
        self.assertTrue(
            payloads,
            f"AC13 — arduino `{verb}`: nothing was ingested, so this test "
            f"measured no tier. posted={[p for p, _ in drive.calls]!r} "
            f"exit={drive.code} stderr={drive.err[-1200:]!r}")
        return payloads[0].get("tier")

    def test_the_native_host_run_carries_its_own_tier(self):
        """PIN (ESCALATION 3) — AC13(i): "the native-host run carries its own
        tier", so no run relies on `src/store.ts`'s `?? unit` default."""
        self.assertEqual(self.wire_tier("unit"), "unit",
                         "AC13 — the native-host unit run states its own tier")

    def test_the_native_regression_run_carries_its_own_tier(self):
        """PIN — the half where the server default would CHANGE the record: a
        tier-less full-suite run is stored as `unit`."""
        self.assertEqual(
            self.wire_tier("regression"), "regression",
            "AC13 — a full native suite recorded as `unit` is the exact "
            "mislabelling the CR's Context describes")

    def test_every_arduino_verb_that_sends_a_tier_names_it_in_its_own_help(self):
        """RED — AC13(ii). `arduino test` runs the native host build and ingests
        it as `unit`, while its printed help says only "run native host tests
        (make junit) -> /api/v2/runs/parsed". A caller reading this client's
        own surface cannot predict the board's tier column, which is the defect
        AC13 names — the CR's quoted line numbers just no longer hold it."""
        _code, root_help, _err = _HARNESS._run_main(self.module, "arduino",
                                                    ["--help"])
        blocks = _help_blocks(root_help)
        self.assertIn(
            "unit", blocks,
            f"the root help must list the tier verbs; parsed {sorted(blocks)!r}")
        for verb in ("unit", "regression", "test"):
            with self.subTest(verb=verb):
                claimed = _claimed_tier(blocks.get(verb, ""))
                sent = self.wire_tier(verb)
                self.assertEqual(
                    claimed, sent,
                    f"AC13 — arduino `{verb}`: the printed help claims tier "
                    f"{claimed!r} and the POST body sends {sent!r}. The help "
                    f"and the board must say the same thing; help text was "
                    f"{blocks.get(verb, '')!r}")

    def test_the_target_build_stays_a_compile_ingest_with_no_test_tier(self):
        """PIN — AC13's own boundary, held: "the `arduino-cli` target build
        continues to post to `/api/v2/runs/compile` as a COMPILE ingest — a
        build is not a test tier". Asserted here as well as in cycle 378's file
        because AC13 makes this client stamp its TEST ingests, and the way that
        overshoots is by reaching the build."""
        with mock.patch.object(self.module, "ARDUINO_CLI",
                               _fake("fake-arduino-cli")):
            drive = self.drive(self.arduino_argv("compile"))
        compile_bodies = [payload for path, payload in drive.calls
                          if path == COMPILE]
        self.assertTrue(
            compile_bodies,
            f"AC13 — arduino `compile`: no compile ingest was recorded. "
            f"posted={[p for p, _ in drive.calls]!r} "
            f"stderr={drive.err[-1200:]!r}")
        for payload in compile_bodies:
            self.assertIsNone(
                payload.get("tier"),
                f"AC13/AC13a — the target build is a COMPILE event, never a "
                f"test tier; the body carried {payload.get('tier')!r}")
        self.assertEqual(
            self.ingest_payloads(drive), [],
            "AC13 — a target build must not also post a TEST run: the two "
            "builds are what §S3 calls arduino's split")


if __name__ == "__main__":
    unittest.main()
