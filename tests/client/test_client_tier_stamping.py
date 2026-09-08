"""CR-CRU-111 §S2 — a run stops claiming a tier it did not earn (AC3), and no
COMPILE ingest carries a test tier (AC13a).

Two acceptance criteria live here, and they are the two cycle 378 owns. Both
are asserted the way the CR asks for them: **on the POST body the client
actually sends**, driven through the client's own real argparse verb, with the
client's single HTTP transport seam (`_post`) recorded. Nothing here greps a
client for a `tier=` literal in order to decide what went on the wire — the
one scan in this file (the census) exists to answer a DIFFERENT question,
named below.

  * **AC3** — "a verb with no stated tier sends NO `tier` key: asserted on the
    POST body (the key is absent, not `"unit"`) at EACH of the … unearned call
    sites §S2 enumerates … The count of corrected sites is itself asserted …
    `auto-ingest` is asserted explicitly: it runs no tests, so it may state no
    tier at all."
  * **AC13a** — "no COMPILE ingest carries a test tier, asserted fleet-wide on
    the POST body to `/api/v2/runs/compile` … asserted for every client that
    has a compile path rather than for arduino alone."

HOW THE COUNT IS DERIVED, and why it is not a frozen list: `_tier_literal_sites`
parses each client with `ast` and returns every call passing a STRING-LITERAL
`tier=` keyword, attributed to its innermost enclosing function. A site is
EARNED when the enclosing function's own name contains the tier as a word
(`cmd_regression`/`_regression_run` → `regression`, `cmd_e2e` → `e2e`) — §S2's
rule, "a tier a verb states where `regression` or `e2e` IS the verb's own name
is EARNED and stays". Everything else is UNEARNED, and the assertion is that
the derived count of unearned sites is ZERO. That is what makes "the client
stopped claiming unit" unsatisfiable by editing one line in one client: fixing
one site leaves eleven, and the failure message names every survivor.

MEASURED ON `feature/CR-CRU-111` @ `c6dc208` (cycle 377 merged), 2026-09-08 —
what is RED here and what is a PIN, stated per test, because a suite that does
not say which of its members were born green is a suite whose colour means
nothing:

  RED  `{Bun,Mvn,Python,Rust}UnearnedTierTest` — all TWELVE methods. The
         census finds twelve unearned literal sites today: bun `cmd_test`
         (:1065 `/runs/start`, :1089 `/runs/parsed`), bun `cmd_auto_ingest`
         (:1252, `e2e`), mvn `cmd_test` (:1270 `/runs`, :1276 `/runs/parsed`),
         mvn `cmd_auto_ingest` (:1339 `/runs`, :1346 `/runs/parsed`
         `regression`), python `cmd_test` (:686 `/runs/parsed`, :696
         `/runs/compile`), python `cmd_auto_ingest` (:854), rust `cmd_test`
         (:1085) and rust `cmd_auto_ingest` (:793).
  RED  `UnearnedTierLiteralCensusTest.
         test_no_client_stamps_a_tier_its_own_verb_did_not_earn` — the derived
         count is 12, not 0.
  RED  `CompileIngestCarriesNoTestTierTest.
         test_python_test_ingests_a_collection_failure_as_compile_with_no_tier`
         (`python-crucible.py:696`, `tier="unit"`) and
         `..._python_regression_ingests_a_collection_failure_as_compile_with_no_tier`
         (`python-crucible.py:799`, `tier="regression"` — see ESCALATION 2).
  PIN  `CompileIngestCarriesNoTestTierTest` — the other five clients' compile
         paths (bun `test`-with-no-XML, bun `check`, mvn `check`, rust `check`,
         arduino `compile`) pass today and must STAY passing: AC13a's rule is
         fleet-wide, and arduino's clean compile path is the one the CR names
         as already correct.
  PIN  `{Bun,Python,Mvn}EarnedTierTest` — all six. These are the
         CONVERSE bound demanded by §S2's "a tier a verb states where
         `regression` or `e2e` IS the verb's own name is EARNED and stays": a
         patch that strips every tier everywhere makes this class fail. They
         pass today.
  PIN  `UnearnedTierLiteralCensusTest.
         test_the_scanner_reports_an_unearned_stamp_when_it_is_shown_one` —
         the instrument's own bound. Without it, "zero unearned sites" could
         be an `ast` walk that matched nothing.
  PIN  `UnearnedTierLiteralCensusTest.
         test_every_unearned_site_the_scan_finds_is_driven_on_the_wire` and
         `CompileIngestCarriesNoTestTierTest.
         test_every_client_with_a_compile_endpoint_is_driven_by_this_class` —
         the two COVERAGE bounds, derived by scanning the five client files:
         they fail if this suite misses a site the scan can see, which is the
         way a per-call-site AC silently shrinks.

HARNESS, and where it comes from: the fleet's dominant client-test idiom —
`tests/client/test_bun_crucible_toon_envelope.py` and
`tests/client/test_bun_crucible_lifecycle.py`. Load the hyphenated client by
file path with `importlib`, dispatch through the REAL argparse via
`module.main()` with `sys.argv` patched (so nothing here guesses a Namespace
`dest`), and patch the module's ONE HTTP transport seam, `_post`, recording
every `(path, payload)` — the live board on :3849 is never touched, and
`payload` IS the wire body the AC asks about. External toolchains are tiny
fake executables (the same file's `--bun` technique, widened to the fleet the
way `test_client_fleet_envelope_census.py` does it): `--bun`/`--python` take
an explicit path, maven runs the `mvnw` wrapper laid down in the fixture,
arduino's `ARDUINO_CLI` module constant is patched, and only `cargo`/`docker`
need a PATH-prepended scratch bin. No real bun/mvn/cargo/arduino-cli is
reachable from any drive in this file.

Why not the subprocess-drive harness of `test_client_fleet_envelope_census.py`
(the other candidate): a genuine subprocess cannot have its `_post` recorded,
so the POST BODY — the exact thing AC3 and AC13a assert on — would have to be
read back from a stub HTTP server, which is a second mechanism for a question
the in-process seam already answers exactly. The census's fake-toolchain
idiom is adopted; its transport is not.

ESCALATIONS recorded at the time of writing (see the report for the full text):

  1. AC3's own prose says "EACH of the eight unearned call sites" and then
     enumerates TEN, while §S2's census table carries TWELVE unearned rows
     (AC3's enumeration omits mvn `cmd_auto_ingest`'s `tier="regression"`
     site, :1346, which §S2's table marks unearned and whose reason —
     auto-ingest ran no tests — is the strongest of the four). This file
     asserts the DERIVED set, so the disagreement between the AC's "eight",
     its own list of ten and the table's twelve cannot be inherited: the count
     is measured, and every measured site is driven.
  2. AC13a names ONE offender, `python-crucible.py:696`. There is a SECOND:
     `python-crucible.py:799`, `_regression_run`'s no-XML fallback, ingests to
     `/api/v2/runs/compile` with `tier="regression"`. It is EARNED under AC3
     (the enclosing verb IS `regression`) and forbidden under AC13a (a compile
     event is not a test tier) — the two ACs meet on that one line, and AC13a
     wins there by its own words ("no COMPILE ingest carries a test tier").
     Asserted here as RED; if the ruling is otherwise, this test is the one to
     retarget.
  3. §S2's table and this file's own census disagree with the CR's Surfaces
     paragraph about WHICH endpoint bun's two `cmd_test` sites reach: :1065 is
     `_start_run` → `POST /api/v2/runs/start`, :1089 is `_ingest_parsed` →
     `POST /api/v2/runs/parsed`. Both are asserted separately, because a fix
     applied to the ingest alone leaves the OPENED run stamped `unit`.

Invocation:
    python3 -m pytest tests/client/test_client_tier_stamping.py -q
Fallback:
    python3 tests/client/test_client_tier_stamping.py
"""

import ast
import contextlib
import copy
import importlib.util
import io
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
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"

CLIENT_FILES = {
    "bun": CLIENTS_DIR / "bun-crucible.py",
    "rust": CLIENTS_DIR / "rust-crucible.py",
    "mvn": CLIENTS_DIR / "mvn-crucible.py",
    "python": CLIENTS_DIR / "python-crucible.py",
    "arduino": CLIENTS_DIR / "arduino-crucible.py",
}

# The ingest endpoints this file reads bodies from — the fleet's own spellings.
PARSED = "/api/v2/runs/parsed"
RUNS = "/api/v2/runs"
RUN_START = "/api/v2/runs/start"
COMPILE = "/api/v2/runs/compile"

AGENT = "CR-CRU-111-C2-tier-probe"

# Nothing listens on port 1 without root — the fleet's own idiom. `_post`/`_get`
# are patched in every drive, so no request can leave this process; the env var
# is the belt to that brace, and the live :3849 board is never touched.
_UNREACHABLE_CRUCIBLE_URL = "http://127.0.0.1:1"


def _test_tier_vocabulary():
    """The six `Tier` values, taken from the ONE client-side mirror CR-CRU-111
    §S1/AC10 put in `clients/_crucible_axi.py` (cycle 377, merged). Deliberately
    not a seventh copy in this file: AC10 forbids a second mirror, and a suite
    that hardcoded the six would keep asserting the old vocabulary after the
    server grew a value."""
    module = _load_module(AXI_MODULE_PATH, "cr111_axi_for_tier_stamping")
    return frozenset(module.TIER_MEANINGS)


# ── the census: which literal tiers does each client hand its ingest calls ──


def _tier_literal_sites(source, filename="<client>"):
    """Every call in `source` passing a STRING-LITERAL `tier=` keyword, as
    `(function, lineno, tier)` triples attributed to the INNERMOST enclosing
    function.

    A `tier=` fed by a VARIABLE (mvn's `_run_surefire_tier(..., tier=label)`,
    where the verb's own name supplies the value) is deliberately not a site:
    the defect §S2 names is a literal the client asserts about a run it cannot
    classify, never the act of passing a tier the caller stated."""
    sites = []

    def walk(node, function):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                walk(child, child.name)
                continue
            if isinstance(child, ast.Call):
                for kw in child.keywords:
                    if (kw.arg == "tier"
                            and isinstance(kw.value, ast.Constant)
                            and isinstance(kw.value.value, str)):
                        sites.append((function, kw.value.lineno, kw.value.value))
            walk(child, function)

    walk(ast.parse(source, filename=filename), "<module>")
    return sites


def _is_earned(function, tier):
    """§S2's rule: "a tier a verb states where `regression` or `e2e` IS the
    verb's own name is EARNED and stays". The enclosing function's name is
    split into words, so `cmd_regression`, `_regression_run` and `cmd_e2e`
    earn theirs and `cmd_test`/`cmd_auto_ingest` earn nothing."""
    return tier in [w for w in re.split(r"[^a-z0-9]+", function.lower()) if w]


def _census():
    """`{client: [(function, lineno, tier), ...]}` for every literal tier site
    in the five clients, and the unearned subset of the same shape."""
    earned, unearned = {}, {}
    for client, path in CLIENT_FILES.items():
        sites = _tier_literal_sites(path.read_text(), filename=str(path))
        earned[client] = [s for s in sites if _is_earned(s[0], s[2])]
        unearned[client] = [s for s in sites if not _is_earned(s[0], s[2])]
    return earned, unearned


def _flat(census):
    return [(client,) + site for client, sites in census.items() for site in sites]


# The sites THIS suite drives on the wire, as
# `(client, function, tier, endpoint)`. This is the suite's own coverage
# statement, and it is the only hand-written tuple set in the file: it is
# COMPARED AGAINST the derived census (see
# `test_every_unearned_site_the_scan_finds_is_driven_on_the_wire`), never
# substituted for it. Two of bun's, two of mvn's and two of python's collapse
# to the same `(client, function, tier)` triple and are told apart by the
# ENDPOINT, because a fix applied to one endpoint leaves the other stamped.
SITES_DRIVEN_ON_THE_WIRE = frozenset({
    ("bun", "cmd_test", "unit", RUN_START),
    ("bun", "cmd_test", "unit", PARSED),
    ("bun", "cmd_auto_ingest", "e2e", PARSED),
    ("mvn", "cmd_test", "unit", RUNS),
    ("mvn", "cmd_test", "unit", PARSED),
    ("mvn", "cmd_auto_ingest", "unit", RUNS),
    ("mvn", "cmd_auto_ingest", "regression", PARSED),
    ("python", "cmd_test", "unit", PARSED),
    ("python", "cmd_test", "unit", COMPILE),
    ("python", "cmd_auto_ingest", "unit", PARSED),
    ("rust", "cmd_test", "unit", RUNS),
    ("rust", "cmd_auto_ingest", "unit", RUNS),
})


# ── fixtures: junit payloads and fake toolchains ───────────────────────────

_JUNIT_SUITES_ONE_PASS = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuites><testsuite name="tier.probe" tests="1" failures="0" errors="0">'
    '<testcase classname="tier.probe" name="probe" time="0.001"/>'
    '</testsuite></testsuites>'
)
_JUNIT_SUITE_ONE_PASS = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuite name="TierProbeTest" tests="1" failures="0" errors="0">'
    '<testcase classname="TierProbeTest" name="probe" time="0.001"/>'
    '</testsuite>'
)

# `bun`: writes FAKE_BUN_JUNIT_CONTENT to --reporter-outfile= (empty content =
# the no-XML collection failure), and answers `bun x tsc --noEmit` as a failing
# typecheck so the `check` gate's compile ingest is reached.
_FAKE_BUN = """#!{python}
import os
import sys

argv = sys.argv[1:]
if argv[:1] == ["x"]:
    sys.stderr.write("src/probe.ts(1,1): error TS2322: fake type error\\n")
    sys.exit(2)
outfile = None
for a in argv:
    if a.startswith("--reporter-outfile="):
        outfile = a.split("=", 1)[1]
content = os.environ.get("FAKE_BUN_JUNIT_CONTENT", "")
if outfile and content:
    d = os.path.dirname(outfile)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(outfile, "w") as f:
        f.write(content)
sys.stdout.write(os.environ.get("FAKE_BUN_OUTPUT", ""))
sys.exit(int(os.environ.get("FAKE_BUN_EXIT_CODE", "0")))
"""

# The interpreter `python-crucible.py --python` runs: stands in for
# `python -m xmlrunner ... -o <reports>`. With FAKE_PY_JUNIT_CONTENT it writes
# one TEST-*.xml there; without it, it prints a traceback and exits non-zero —
# the genuine collection/import failure that routes to the compile ingest.
_FAKE_PY_RUNNER = """#!{python}
import os
import sys

argv = sys.argv[1:]
reports = None
if "-o" in argv:
    reports = argv[argv.index("-o") + 1]
content = os.environ.get("FAKE_PY_JUNIT_CONTENT", "")
if content and reports:
    os.makedirs(reports, exist_ok=True)
    with open(os.path.join(reports, "TEST-tier.probe.xml"), "w") as f:
        f.write(content)
    sys.exit(int(os.environ.get("FAKE_PY_EXIT_CODE", "0")))
sys.stdout.write(os.environ.get(
    "FAKE_PY_OUTPUT",
    "Traceback (most recent call last):\\n"
    "  File \\"tests/probe.py\\", line 1, in <module>\\n"
    "ModuleNotFoundError: No module named 'not_yet_written'\\n"))
sys.exit(int(os.environ.get("FAKE_PY_EXIT_CODE", "1")))
"""

# `mvnw`, laid into the maven dir the fixture builds; the reports are written by
# the fixture, never by this wrapper, so a drive measures the ingest and not a
# fake build. Exits FAKE_MVN_EXIT_CODE with javac-shaped output.
_FAKE_MVNW = """#!{python}
import os
import sys

code = int(os.environ.get("FAKE_MVN_EXIT_CODE", "0"))
if code:
    sys.stdout.write("[ERROR] /src/main/java/Probe.java:[1,1] cannot find symbol\\n")
sys.exit(code)
"""

_FAKE_CARGO = """#!{python}
import os
import sys

code = int(os.environ.get("FAKE_CARGO_EXIT_CODE", "0"))
if code:
    sys.stderr.write("error[E0425]: cannot find value `probe` in this scope\\n")
sys.exit(code)
"""

# mvn's `e2e` runs an informational `docker ps` before the build; a fake keeps
# a real docker daemon out of the drive.
_FAKE_DOCKER = """#!{python}
import sys

sys.exit(0)
"""

_FAKE_ARDUINO_CLI = """#!{python}
import sys

sys.stdout.write("probe.ino:1:1: error: 'setup' was not declared in this scope\\n")
sys.exit(1)
"""

# Only these two are looked up on PATH by the clients under drive; every other
# fake is addressed by an explicit path or a patched module constant, so this
# file prepends as little to PATH as it can.
_PATH_TOOLS = {"cargo": _FAKE_CARGO, "docker": _FAKE_DOCKER}
_NAMED_TOOLS = {
    "fake-bun": _FAKE_BUN,
    "fake-python-runner": _FAKE_PY_RUNNER,
    "fake-mvnw": _FAKE_MVNW,
    "fake-arduino-cli": _FAKE_ARDUINO_CLI,
}

_BIN_DIR = None
_SAVED_PATH = None


def setUpModule():
    global _BIN_DIR, _SAVED_PATH
    _BIN_DIR = tempfile.mkdtemp(prefix="cr111-tier-bin-")
    for name, body in list(_PATH_TOOLS.items()) + list(_NAMED_TOOLS.items()):
        path = Path(_BIN_DIR) / name
        path.write_text(body.replace("{python}", sys.executable))
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


# ── the harness ────────────────────────────────────────────────────────────

_LOAD_COUNT = {}


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_client(client):
    """Load a hyphenated client script by file path (it cannot be `import`ed),
    fresh per test under a unique module name — the sibling harnesses' idiom,
    pointed at the REPO copy, which is the source of truth."""
    path = CLIENT_FILES[client]
    if not path.exists():
        raise unittest.SkipTest(f"{path} not found")
    _LOAD_COUNT[client] = _LOAD_COUNT.get(client, 0) + 1
    return _load_module(path, f"cr111_tier_{client}_{_LOAD_COUNT[client]}")


def _run_main(module, client, argv):
    """`module.main()` with `sys.argv` patched — real argparse dispatch, so no
    Namespace `dest` is ever guessed. Returns `(code, stdout, stderr)`; only
    SystemExit is caught, any other exception propagates as a test ERROR."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, "argv", [f"{client}-crucible.py"] + list(argv)):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                module.main()
                code = 0
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    return code, stdout.getvalue(), stderr.getvalue()


class _Drive:
    """Every `(path, payload)` the drive handed the client's `_post` seam."""

    def __init__(self, code, out, err, calls):
        self.code, self.out, self.err, self.calls = code, out, err, calls

    def payloads(self, endpoint):
        return [payload for path, payload in self.calls if path == endpoint]

    def paths(self):
        return [path for path, _payload in self.calls]


_ENV_KEYS = (
    "WORKFLOW_WAVE", "WORKFLOW_ROLE", "WORKFLOW_CYCLE_ID", "WORKFLOW_CYCLE",
    "AGENT_ID", "CRUCIBLE_URL", "CRUCIBLE_BASE",
    "FAKE_BUN_JUNIT_CONTENT", "FAKE_BUN_EXIT_CODE", "FAKE_BUN_OUTPUT",
    "FAKE_PY_JUNIT_CONTENT", "FAKE_PY_EXIT_CODE", "FAKE_PY_OUTPUT",
    "FAKE_MVN_EXIT_CODE", "FAKE_CARGO_EXIT_CODE",
    "BUN_CRUCIBLE_PROJECT_DIR", "BUN_CRUCIBLE_PACKAGE_DIR",
    "BUN_CRUCIBLE_NO_LIFECYCLE",
    "PY_CRUCIBLE_PROJECT_DIR", "PY_CRUCIBLE_PYTHON",
    "MVN_CRUCIBLE_PROJECT_DIR", "MVN_CRUCIBLE_MAVEN_DIR",
    "RUST_CRUCIBLE_PROJECT_DIR", "ARDUINO_CRUCIBLE_PROJECT_DIR",
    "ARDUINO_CLI", "ARDUINO_FQBN",
)

# A server answer rich enough for BOTH ingest shapes: `/runs/parsed` callers
# read `ok`, `/runs` (junit codec) callers read `run.failed`. A bare
# `{"ok": True}` would send the junit-dir verbs down their failure branch and
# the drive would stop measuring what it came to measure.
_OK_RESPONSE = {"ok": True,
                "run": {"passed": 1, "failed": 0, "pending": 0, "total": 1}}


class _ClientDriveCase(unittest.TestCase):
    """One throwaway project dir per test, and the client's ONE HTTP seam
    recorded. `_get`/`_patch` are patched too: the §S3 pre-flight reads the
    board before every ingesting verb, and an unpatched read would reach the
    live :3849 server."""

    CLIENT = ""
    PROJECT_KEY = "cr111-tier-stamping-key"

    def setUp(self):
        self.module = _load_client(self.CLIENT)
        self.tmpdir = tempfile.mkdtemp(prefix=f"cr111-tier-{self.CLIENT}-")
        (Path(self.tmpdir) / ".env").write_text(
            f"CRUCIBLE_PROJECT_KEY={self.PROJECT_KEY}\n"
            f"CRUCIBLE_PROJECT_NAME=cr111-tier-stamping-project\n")
        self._saved_env = {k: os.environ.get(k) for k in _ENV_KEYS}
        for key in _ENV_KEYS:
            os.environ.pop(key, None)
        os.environ["CRUCIBLE_URL"] = _UNREACHABLE_CRUCIBLE_URL
        os.environ["CRUCIBLE_BASE"] = _UNREACHABLE_CRUCIBLE_URL

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def drive(self, argv, response=None):
        calls = []

        def fake_post(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            return copy.deepcopy(response if response is not None else _OK_RESPONSE)

        with mock.patch.object(self.module, "_post", side_effect=fake_post, create=True), \
                mock.patch.object(self.module, "_get", return_value=None, create=True), \
                mock.patch.object(self.module, "_patch", return_value={"ok": True},
                                  create=True):
            code, out, err = _run_main(self.module, self.CLIENT, argv)
        return _Drive(code, out, err, calls)

    # ── the two assertions every test in this file is built from ───────────

    def _ingest_payload(self, drive, endpoint, site):
        payloads = drive.payloads(endpoint)
        self.assertTrue(
            payloads,
            f"{site}: the drive recorded no POST to {endpoint} at all, so this "
            f"test measured nothing. paths={drive.paths()!r} "
            f"exit={drive.code} stderr={drive.err[-2000:]!r}")
        payload = payloads[0]
        # The bound on "we read the right POST": the ingest body carries this
        # run's own agent id, so a `tier`-free lifecycle call can never be
        # mistaken for a tier-free ingest.
        self.assertEqual(
            payload.get("agentId"), AGENT,
            f"{site}: the first POST to {endpoint} is not this run's ingest "
            f"body: {payload!r}")
        return payload

    def assertNoStatedTier(self, drive, endpoint, site):
        payload = self._ingest_payload(drive, endpoint, site)
        self.assertNotIn(
            "tier", payload,
            f"AC3 — {site}: the caller stated no tier, so the POST body to "
            f"{endpoint} must carry NO `tier` key and let the server's own "
            f"default apply; it carries tier={payload.get('tier')!r}. "
            f"A tier this verb cannot know from a file path is a fact the "
            f"client is asserting, not measuring.")

    def assertStatedTier(self, drive, endpoint, expected, site):
        payload = self._ingest_payload(drive, endpoint, site)
        self.assertEqual(
            payload.get("tier"), expected,
            f"§S2's converse — {site}: this verb's own NAME is the tier, so the "
            f"tier is EARNED and must survive; POST body to {endpoint} carried "
            f"tier={payload.get('tier')!r}, expected {expected!r}.")


# ── per-client fixtures ────────────────────────────────────────────────────


class _BunCase(_ClientDriveCase):
    CLIENT = "bun"

    def bun_argv(self, verb, extra=(), with_bun=True):
        """`--bun` is a flag of the verbs that RUN bun (`test`, `regression`,
        `check`); `auto-ingest` runs nothing and does not accept it, which is
        the whole reason it cannot know a tier."""
        argv = [verb, "--agent", AGENT, "--project-dir", self.tmpdir,
                "--package-dir", self.tmpdir, "--reports", "reports"]
        if with_bun:
            argv += ["--bun", _fake("fake-bun")]
        return argv + list(extra)

    def write_bun_junit(self):
        """Lay the report where `auto-ingest` looks for it, using the client's
        own path helpers rather than a guessed layout."""
        reports_dir = self.module._reports_dir(self.tmpdir, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        junit_path = self.module._junit_path(reports_dir)
        Path(junit_path).write_text(_JUNIT_SUITES_ONE_PASS)
        return junit_path


class _PythonCase(_ClientDriveCase):
    CLIENT = "python"

    def py_argv(self, verb, extra=()):
        return [verb, "--agent", AGENT, "--project-dir", self.tmpdir,
                "--reports", "reports"] + list(extra)

    def write_py_reports(self):
        reports_dir = self.module._reports_dir(self.tmpdir, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        Path(reports_dir, "TEST-tier.probe.xml").write_text(_JUNIT_SUITE_ONE_PASS)
        return reports_dir


class _MvnCase(_ClientDriveCase):
    CLIENT = "mvn"

    def setUp(self):
        super().setUp()
        wrapper = Path(self.tmpdir) / "mvnw"
        wrapper.write_text(_FAKE_MVNW.replace("{python}", sys.executable))
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


class _RustCase(_ClientDriveCase):
    CLIENT = "rust"

    def rust_argv(self, verb, extra=()):
        return [verb, "--crate", "probe_crate", "--agent", AGENT,
                "--project-dir", self.tmpdir] + list(extra)

    def write_nextest_junit(self, profile="ci"):
        directory = Path(self.tmpdir, "target", "nextest", profile)
        directory.mkdir(parents=True, exist_ok=True)
        junit = directory / "junit.xml"
        junit.write_text(_JUNIT_SUITES_ONE_PASS)
        return str(junit)


class _ArduinoCase(_ClientDriveCase):
    CLIENT = "arduino"


# ── AC3, on the wire: the twelve unearned sites ────────────────────────────


class BunUnearnedTierTest(_BunCase):
    """AC3 — "a verb with no stated tier sends NO `tier` key: asserted on the
    POST body (the key is absent, not `"unit"`) at EACH of the … unearned call
    sites". This class and the three after it hold one method per site the
    census finds — twelve in all — because §S2 makes this "a requirement per
    call site, per client … `the client stops claiming `unit`` is satisfied by
    editing one line in one client". Each client's drives sit in its own class
    so each uses its own stack's fixture.

    RED — `bun-crucible.py` `cmd_test` :1065/:1089 and `cmd_auto_ingest`
    :1252."""

    def test_bun_test_opens_the_run_without_claiming_a_tier(self):
        """AC3, bun `cmd_test` :1065 — `_start_run` OPENS the run with
        `tier="unit"` before `bun test` has run a single test. The run row is
        stamped at the moment the client knows least about it."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_PASS
        drive = self.drive(self.bun_argv("test"))
        self.assertNoStatedTier(drive, RUN_START, "bun cmd_test -> POST /runs/start")

    def test_bun_test_ingests_the_run_without_claiming_a_tier(self):
        """AC3, bun `cmd_test` :1089 — the CR's own example: "a targeted run of
        a real browser suite is recorded on the board as a unit run"."""
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_PASS
        drive = self.drive(self.bun_argv("test"))
        self.assertNoStatedTier(drive, PARSED, "bun cmd_test -> POST /runs/parsed")

    def test_bun_auto_ingest_ran_no_tests_so_it_claims_no_tier(self):
        """AC3's explicit auto-ingest clause, bun :1252 — this verb "runs no
        tests at all, it ingests report files it merely found, so it cannot
        know the tier by construction", yet bun asserts `e2e` over whatever
        report was lying in the reports dir."""
        self.write_bun_junit()
        drive = self.drive(self.bun_argv("auto-ingest", with_bun=False))
        self.assertNoStatedTier(drive, PARSED,
                                "bun cmd_auto_ingest -> POST /runs/parsed")


class MvnUnearnedTierTest(_MvnCase):
    """RED — `mvn-crucible.py` `cmd_test` :1270/:1276 and `cmd_auto_ingest`
    :1339/:1346."""

    def test_mvn_test_single_report_dir_claims_no_tier(self):
        """AC3, mvn `cmd_test` :1270 — the fast junit-dir path
        (`POST /api/v2/runs`, server-side codec)."""
        self.write_reports()
        drive = self.drive(self.mvn_argv("test"))
        self.assertNoStatedTier(drive, RUNS, "mvn cmd_test -> POST /runs")

    def test_mvn_test_many_report_dirs_claims_no_tier(self):
        """AC3, mvn `cmd_test` :1276 — the multi-module reactor path
        (client-parsed, `POST /api/v2/runs/parsed`). A second call site of the
        same verb: fixing one leaves the other stamping `unit`."""
        self.write_reports()
        self.write_reports(module="probe-module", name="TEST-ProbeTwo.xml")
        drive = self.drive(self.mvn_argv("test"))
        self.assertNoStatedTier(drive, PARSED, "mvn cmd_test -> POST /runs/parsed")

    def test_mvn_auto_ingest_single_report_dir_claims_no_tier(self):
        """AC3's auto-ingest clause, mvn :1339 — no maven ran; the reports were
        merely discovered."""
        self.write_reports()
        drive = self.drive(self.mvn_argv("auto-ingest"))
        self.assertNoStatedTier(drive, RUNS, "mvn cmd_auto_ingest -> POST /runs")

    def test_mvn_auto_ingest_coverage_path_claims_no_tier(self):
        """AC3's auto-ingest clause, mvn :1346 — the site AC3's OWN enumeration
        omits (ESCALATION 1) though §S2's census table marks it unearned. It is
        the worst of the four: `auto-ingest` ran nothing and calls the result a
        full `regression`."""
        self.write_reports()
        drive = self.drive(self.mvn_argv("auto-ingest", ["--coverage"]))
        self.assertNoStatedTier(drive, PARSED,
                                "mvn cmd_auto_ingest --coverage -> POST /runs/parsed")


class PythonUnearnedTierTest(_PythonCase):
    """RED — `python-crucible.py` `cmd_test` :686/:696 and `cmd_auto_ingest`
    :854."""

    def test_python_test_ingests_the_run_without_claiming_a_tier(self):
        """AC3, python `cmd_test` :686 — `--tests tests.whatever` says nothing
        about the dependency that target takes."""
        os.environ["FAKE_PY_JUNIT_CONTENT"] = _JUNIT_SUITE_ONE_PASS
        drive = self.drive(self.py_argv(
            "test", ["--tests", "tests.probe", "--python", _fake("fake-python-runner")]))
        self.assertNoStatedTier(drive, PARSED, "python cmd_test -> POST /runs/parsed")

    def test_python_test_collection_failure_claims_no_tier(self):
        """AC3, python `cmd_test` :696 — the no-XML fallback stamps `unit` on a
        COMPILE ingest. It is an AC3 site AND AC13a's named offender; the
        AC13a face of the same line is asserted separately below."""
        drive = self.drive(self.py_argv(
            "test", ["--tests", "tests.probe", "--python", _fake("fake-python-runner")]))
        self.assertNoStatedTier(drive, COMPILE, "python cmd_test -> POST /runs/compile")

    def test_python_auto_ingest_ran_no_tests_so_it_claims_no_tier(self):
        """AC3's auto-ingest clause, python :854."""
        self.write_py_reports()
        drive = self.drive(self.py_argv("auto-ingest"))
        self.assertNoStatedTier(drive, PARSED,
                                "python cmd_auto_ingest -> POST /runs/parsed")


class RustUnearnedTierTest(_RustCase):
    """RED — `rust-crucible.py` `cmd_test` :1085 and `cmd_auto_ingest` :793,
    the client's ONLY two tier statements."""

    def test_rust_test_ingests_the_nextest_run_without_claiming_a_tier(self):
        """AC3, rust `cmd_test` :1085 — the profile (`-P ci`, `-P e2e`) is the
        caller's own tier statement and the client overwrites it with `unit`.
        (AC12 rules on what the profile SHOULD carry; that is cycle 381's.)"""
        self.write_nextest_junit()
        drive = self.drive(self.rust_argv("test"))
        self.assertNoStatedTier(drive, RUNS, "rust cmd_test -> POST /runs")

    def test_rust_auto_ingest_ran_no_tests_so_it_claims_no_tier(self):
        """AC3's auto-ingest clause, rust :793 — a junit left in
        `target/nextest/<profile>/` by ANY earlier run is ingested as `unit`."""
        self.write_nextest_junit()
        drive = self.drive(self.rust_argv("auto-ingest"))
        self.assertNoStatedTier(drive, RUNS, "rust cmd_auto_ingest -> POST /runs")


# ── the converse: an EARNED tier survives ──────────────────────────────────


class BunEarnedTierTest(_BunCase):
    """§S2 — "a tier a verb states where `regression` or `e2e` IS the verb's
    own name is EARNED and stays", and AC5 — every pre-existing verb whose
    name is already a tier keeps its behaviour.

    PIN, not RED: this class and the two after it pass today. They are the
    bound that stops the AC3 fix from overshooting — a patch that strips every
    `tier=` in `clients/` satisfies every assertion above and fails every
    assertion here.

    PIN — bun `regression` :1175/:1219."""

    def test_bun_regression_opens_and_ingests_the_run_as_regression(self):
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_PASS
        drive = self.drive(self.bun_argv("regression"))
        self.assertStatedTier(drive, RUN_START, "regression",
                              "bun regression -> POST /runs/start")
        self.assertStatedTier(drive, PARSED, "regression",
                              "bun regression -> POST /runs/parsed")


class PythonEarnedTierTest(_PythonCase):
    """PIN — python `_regression_run` :817."""

    def test_python_regression_ingests_the_run_as_regression(self):
        os.environ["FAKE_PY_JUNIT_CONTENT"] = _JUNIT_SUITE_ONE_PASS
        drive = self.drive(self.py_argv(
            "regression", ["--python", _fake("fake-python-runner"),
                           "--start-dir", "tests", "--pattern", "test_*.py"]))
        self.assertStatedTier(drive, PARSED, "regression",
                              "python regression -> POST /runs/parsed")


class MvnEarnedTierTest(_MvnCase):
    """PIN — mvn's four tier verbs: `unit`/`module` (via `_run_surefire_tier`'s
    `tier=label`, where the verb's own name IS the value), `e2e` :1097 and
    `regression` :1226."""

    def test_mvn_unit_verb_still_ingests_as_unit(self):
        self.write_reports()
        drive = self.drive(self.mvn_argv("unit"))
        self.assertStatedTier(drive, RUNS, "unit", "mvn unit -> POST /runs")

    def test_mvn_module_verb_still_ingests_as_module(self):
        self.write_reports()
        drive = self.drive(self.mvn_argv("module"))
        self.assertStatedTier(drive, RUNS, "module", "mvn module -> POST /runs")

    def test_mvn_e2e_verb_still_ingests_as_e2e(self):
        self.write_reports(kind="failsafe", name="TEST-ProbeIT.xml")
        drive = self.drive(self.mvn_argv("e2e"))
        self.assertStatedTier(drive, PARSED, "e2e", "mvn e2e -> POST /runs/parsed")

    def test_mvn_regression_verb_still_ingests_as_regression(self):
        self.write_reports()
        drive = self.drive(self.mvn_argv("regression"))
        self.assertStatedTier(drive, PARSED, "regression",
                              "mvn regression -> POST /runs/parsed")


# ── AC13a: a compile ingest is not a test tier ─────────────────────────────


class CompileIngestCarriesNoTestTierTest(unittest.TestCase):
    """AC13a — "no COMPILE ingest carries a test tier, asserted fleet-wide on
    the POST body to `/api/v2/runs/compile`". The class-level test below is the
    COVERAGE bound; the per-client drives live in the classes after it."""

    def test_every_client_with_a_compile_endpoint_is_driven_by_this_class(self):
        """PIN — the fleet-wide bound, derived. Every client whose source POSTs
        to `/api/v2/runs/compile` must be driven by a compile assertion in this
        file; AC13a is "asserted for every client that has a compile path
        rather than for arduino alone", and a client added later must not
        silently escape it."""
        with_compile = {client for client, path in CLIENT_FILES.items()
                        if f'"{COMPILE}"' in path.read_text()}
        self.assertEqual(
            with_compile, set(_COMPILE_PATHS_DRIVEN),
            f"AC13a is fleet-wide: clients POSTing to {COMPILE} are "
            f"{sorted(with_compile)!r}, but this file drives "
            f"{sorted(_COMPILE_PATHS_DRIVEN)!r}.")


# The clients whose compile path this file drives — compared against the
# DERIVED set above, never substituted for it.
_COMPILE_PATHS_DRIVEN = ("bun", "rust", "mvn", "python", "arduino")


class _CompileTierAssertion:
    """The one assertion every AC13a drive makes: the compile body carries no
    value from the TEST-tier vocabulary, under any key."""

    def assertCompileCarriesNoTestTier(self, drive, site):
        payloads = drive.payloads(COMPILE)
        self.assertTrue(
            payloads,
            f"{site}: no POST to {COMPILE} was recorded, so this test measured "
            f"nothing. paths={drive.paths()!r} exit={drive.code} "
            f"stderr={drive.err[-2000:]!r}")
        tiers = _test_tier_vocabulary()
        for payload in payloads:
            stated = payload.get("tier")
            self.assertIsNone(
                stated,
                f"AC13a — {site}: a COMPILE ingest is a build event, never a "
                f"test tier, so the body POSTed to {COMPILE} must carry no "
                f"`tier`; it carried {stated!r}. "
                f"(test tiers: {sorted(tiers)!r})")
            self.assertFalse(
                tiers & {v for v in payload.values() if isinstance(v, str)},
                f"AC13a — {site}: the compile body smuggles a test-tier value "
                f"under another key: {payload!r}")


class PythonCompileTierTest(_PythonCase, _CompileTierAssertion):
    """RED (both) — `python-crucible.py` is the only client that hands a tier
    to its compile ingest at all."""

    def test_python_test_ingests_a_collection_failure_as_compile_with_no_tier(self):
        """AC13a's named offender, `python-crucible.py:696`: "a collection/syntax
        failure with no XML is ingested as a compile event stamped
        `tier="unit"`, so a build failure is recorded on the board as a unit
        test tier"."""
        drive = self.drive(self.py_argv(
            "test", ["--tests", "tests.probe", "--python", _fake("fake-python-runner")]))
        self.assertCompileCarriesNoTestTier(drive, "python cmd_test (no XML)")

    def test_python_regression_ingests_a_collection_failure_as_compile_with_no_tier(self):
        """The SECOND offender, unnamed by AC13a — `python-crucible.py:799`
        (ESCALATION 2). `_regression_run`'s no-XML fallback ingests the capture
        to `/api/v2/runs/compile` with `tier="regression"`. AC3 calls that tier
        earned (the verb IS `regression`); AC13a forbids a test tier on a
        compile event whatever the verb is called. Asserted under AC13a's
        rule."""
        drive = self.drive(self.py_argv(
            "regression", ["--python", _fake("fake-python-runner"),
                           "--start-dir", "tests", "--pattern", "test_*.py"]))
        self.assertCompileCarriesNoTestTier(drive, "python _regression_run (no XML)")

    def test_python_check_ingests_a_syntax_failure_as_compile_with_no_tier(self):
        """PIN — `python-crucible.py`'s py_compile gate is already clean and
        must stay clean."""
        Path(self.tmpdir, "broken.py").write_text("def broken(:\n")
        drive = self.drive(["check", "--agent", AGENT, "--project-dir", self.tmpdir,
                            "--paths", "broken.py", "--python", sys.executable])
        self.assertCompileCarriesNoTestTier(drive, "python cmd_check")


class BunCompileTierTest(_BunCase, _CompileTierAssertion):
    """PIN (both) — bun's compile ingests carry no tier today and must not
    grow one while §S2's fix moves tiers around."""

    def test_bun_test_ingests_a_collection_failure_as_compile_with_no_tier(self):
        drive = self.drive(self.bun_argv("test"))
        self.assertCompileCarriesNoTestTier(drive, "bun cmd_test (no XML)")

    def test_bun_check_ingests_type_errors_as_compile_with_no_tier(self):
        drive = self.drive(["check", "--agent", AGENT, "--bun", _fake("fake-bun"),
                            "--project-dir", self.tmpdir, "--package-dir", self.tmpdir])
        self.assertCompileCarriesNoTestTier(drive, "bun cmd_check (tsc)")


class MvnCompileTierTest(_MvnCase, _CompileTierAssertion):
    """PIN — maven's build-output ingest carries no tier today."""

    def test_mvn_check_ingests_build_output_as_compile_with_no_tier(self):
        os.environ["FAKE_MVN_EXIT_CODE"] = "1"
        drive = self.drive(self.mvn_argv("check"))
        self.assertCompileCarriesNoTestTier(drive, "mvn cmd_check")


class RustCompileTierTest(_RustCase, _CompileTierAssertion):
    """PIN — rustc stderr is ingested with no tier today."""

    def test_rust_check_ingests_rustc_errors_as_compile_with_no_tier(self):
        os.environ["FAKE_CARGO_EXIT_CODE"] = "101"
        drive = self.drive(self.rust_argv("check"))
        self.assertCompileCarriesNoTestTier(drive, "rust cmd_check")


class ArduinoCompileTierTest(_ArduinoCase, _CompileTierAssertion):
    """PIN — arduino's compile path is the one AC13a names as ALREADY correct
    (`arduino-crucible.py:366 _ingest_compile` takes no tier). AC13 (cycle 381)
    will make this client stamp its TEST runs; this test is the guard that the
    stamping stops at the test ingest and never reaches the build."""

    def test_arduino_compile_ingests_build_output_with_no_tier(self):
        with mock.patch.object(self.module, "ARDUINO_CLI", _fake("fake-arduino-cli")):
            drive = self.drive(["compile", "--agent", AGENT,
                                "--project-dir", self.tmpdir])
        self.assertCompileCarriesNoTestTier(drive, "arduino cmd_compile")


# ── the derived census ─────────────────────────────────────────────────────


class UnearnedTierLiteralCensusTest(unittest.TestCase):
    """AC3's count, DERIVED: "The count of corrected sites is itself asserted,
    and a `tier="..."` literal surviving anywhere outside a verb whose own NAME
    is that tier fails this AC."

    This class is the reason the AC cannot be satisfied one line at a time: it
    scans all five clients and requires the derived count of unearned literal
    sites to be ZERO. Fixing bun alone leaves nine; fixing every `cmd_test` and
    forgetting `auto-ingest` leaves five."""

    def test_no_client_stamps_a_tier_its_own_verb_did_not_earn(self):
        """RED — the derived count is 12 on `feature/CR-CRU-111`@`c6dc208`."""
        _earned, unearned = _census()
        sites = _flat(unearned)
        rendered = "; ".join(
            f"{client} {function}:{lineno} tier={tier!r}"
            for client, function, lineno, tier in sorted(sites))
        offending_clients = sorted(c for c, s in unearned.items() if s)
        self.assertEqual(
            len(sites), 0,
            f"AC3 — {len(sites)} call site(s) across {len(offending_clients)} "
            f"client(s) {offending_clients!r} still stamp a tier their own verb "
            f"did not earn. A verb that ran no tests, or ran whatever a path "
            f"pointed at, cannot know the tier; absent a stated tier the run "
            f"carries none and the server's own default applies. Survivors: "
            f"{rendered}")

    def test_the_scanner_reports_an_unearned_stamp_when_it_is_shown_one(self):
        """PIN — the instrument's own bound, and the non-vacuity proof for the
        test above: "zero unearned sites" must be a measurement, not an `ast`
        walk that matched nothing or a classifier that calls everything
        earned."""
        probe = (
            "def cmd_test(args):\n"
            "    _ingest_parsed(tier=\"unit\")\n"
            "def cmd_regression(args):\n"
            "    _ingest_parsed(tier=\"regression\")\n"
            "def cmd_stated(args):\n"
            "    _ingest_parsed(tier=args.tier)\n"
        )
        sites = _tier_literal_sites(probe, filename="<probe>")
        self.assertEqual(
            sites, [("cmd_test", 2, "unit"), ("cmd_regression", 4, "regression")],
            "the scanner must see both literal sites, attribute each to its "
            "enclosing function, and ignore a tier passed as a VARIABLE (the "
            "shape a caller-stated tier takes)")
        self.assertEqual(
            [s for s in sites if not _is_earned(s[0], s[2])],
            [("cmd_test", 2, "unit")],
            "exactly the site whose enclosing verb does not name the tier is "
            "unearned — a classifier that flagged `cmd_regression` too would "
            "make the fix impossible to pass")

    def test_every_unearned_site_the_scan_finds_is_driven_on_the_wire(self):
        """PIN today — the COVERAGE bound between the derived census and this
        suite's own drives. AC3 requires an assertion per call site; this fails
        if the scan can see a site no test above drives, which is exactly how a
        per-call-site requirement shrinks unnoticed."""
        _earned, unearned = _census()
        scanned = {(client, function, tier)
                   for client, function, _lineno, tier in _flat(unearned)}
        driven = {(client, function, tier)
                  for client, function, tier, _endpoint in SITES_DRIVEN_ON_THE_WIRE}
        self.assertEqual(
            scanned - driven, set(),
            f"the census finds unearned tier stamps this file never drives on "
            f"the wire: {sorted(scanned - driven)!r}. Every site AC3 names must "
            f"be asserted on the POST body, not only in the source scan.")

    def test_the_earned_sites_the_scan_finds_are_the_verbs_that_name_them(self):
        """PIN — the census's other half, stated so the earned set is visible
        rather than implied: every literal tier that SURVIVES the fix lives in
        a function whose own name is that tier."""
        earned, _unearned = _census()
        for client, function, lineno, tier in _flat(earned):
            self.assertIn(
                tier, function.lower(),
                f"{client} {function}:{lineno} was classified earned but its "
                f"name does not carry {tier!r}")


if __name__ == "__main__":
    unittest.main()
