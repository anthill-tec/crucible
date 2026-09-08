"""CR-CRU-112 §S1/§S2/§S3 — the gate covers every DECLARED suite.

Four acceptance criteria live here and they are the four cycle 388 owns. AC2,
AC3 and AC4 are cycle 389's; AC7's reverted-fix reproduction is cycle 390's.

  * **AC1** — 'with two GATE-COVERED suites declared (this repo: the bun suite
    and `tests/client` under python), a single gate invocation runs BOTH and
    its envelope names both, with the per-suite pass/fail counts attributed to
    the suite that produced them. Asserted alongside the negative: the
    declared-but-not-gate-covered target (`test:e2e`) is NOT run by the gate
    and is named as excluded rather than absent.'
  * **AC5** — 'each suite's runs are ingested by its own stack's client …: the
    python suite's run carries the python stack and the bun suite's run carries
    the bun stack, from one gate invocation.'
  * **AC6** — '`bunfig.toml` still carries no `pathIgnorePatterns` and
    `tests/suite-integrity.test.ts` passes unchanged; the count of discovery
    exclusions the repo declares is still zero, asserted by that file's own
    `discoveryExclusions` over the real config.'
  * **AC8** — 'caller existence: a grep at VERIFY time returns ≥1 non-test
    caller of the multi-suite gate path, and the standing python gate step is
    invoked from the gate itself rather than only from documentation.'

MEASURED ON `feature/CR-CRU-112` @ `0c78928` (branched from `develop`),
2026-09-08 — what is RED here and what is a PIN, stated per test, because a
suite that does not say which of its members were born green is a suite whose
colour means nothing:

  RED  `GateRunsEveryDeclaredSuiteTest` (AC1, both methods). `bun-crucible.py`'s
         `cmd_pre_merge_gate` is `check` then `cmd_regression`, and that
         regression is ONE `bun test` over the whole bun suite. The fixture's
         python-owned target is never read, never run and never named; the
         `test:e2e` target is never named either, so a reader cannot tell a
         decision from an oversight — which is the face of 'covers every
         declared suite' that a quiet omission satisfies.
  RED  `EachSuiteIngestsThroughItsOwnStacksClientTest` (AC5, both methods).
         Two independent faces, because a stack FIELD is passable while broken:
         (i) `clients/python-crucible.py` sends NO `stack` key on any ingest
         body at all today (`clients/bun-crucible.py:937` is the fleet's only
         `stack` statement), so no run in this repo has ever carried the python
         stack; (ii) nothing invokes the python client from the gate, proven
         not by a field but by the ancestry of the process that actually ran
         the python suite.
  RED  `MultiSuiteGateHasACallerTest` (AC8, both methods). No gate path in the
         fleet reaches CR-CRU-111's declaration seam, and no gate path names a
         sibling client: `scripts/run-test-target.ts` already runs the union
         (`bun test` then `python3 -m unittest discover -s tests/client`) in a
         place the gate does not look, and nothing is ingested for it.
  PIN  `NoSuiteIsGainedByHidingFilesTest` (AC6, §S3). It passes today and must
         keep passing: this CR widens what the gate RUNS and may not narrow
         what a runner COLLECTS. Driven through `tests/suite-integrity.test.ts`
         itself — its own `discoveryExclusions` over the real `bunfig.toml` —
         rather than through a python re-implementation of that decision,
         because AC6 names that function as the instrument.

THE FIXTURE PROJECT, and why it is shaped the way it is. One throwaway project
per test declaring THREE targets at this repo's own declaration surface — the
`package.json` script table, which is where CR-CRU-111 §S6 put bun's declared
tier targets and where this repo's `test:unit` / `test:client` / `test:e2e`
already live:

  `test:unit`    a bun-owned suite (`bun test tests/unit`), 2 passing tests;
  `test:client`  a python-owned suite whose script body invokes
                 `clients/python-crucible.py regression --start-dir
                 tests/client`, 1 passing test;
  `test:e2e`     declared and OUTSIDE the gate (`bunx bddgen && bunx playwright
                 test`) — §S1's 'declared OUT with that question cited'.

The two counts DIFFER (2 and 1) on purpose: 'attributed to the suite that
produced them' is unfalsifiable when both suites report the same numbers.

HOW THE MEASUREMENT IS MADE, and the one place this file extends the harness
it adopts. `tests/client/test_client_tier_stamping.py`'s `_ClientDriveCase`
(client loaded by path, real argparse via `main()`) and
`tests/client/test_client_tier_run_modality.py`'s fake-toolchain argv log are
adopted whole, by name. What could NOT be adopted is those files' transport:
they patch the client's in-process `_post` seam, and a suite DISPATCHED to a
sibling client is a subprocess by construction, whose POST bodies an
in-process patch cannot see — the stamping harness says as much when it
explains why it needed no stub server. So the transport here is a stub board
on 127.0.0.1 (`_StubBoard`), which records the POST bodies of the gate AND of
every process it spawns; the module constant `CRUCIBLE_URL` and the
environment both point at it, so the live board on :3849 is never touched.
Everything else — the fake toolchains, the argv log, the project fixture, the
environment hygiene — is the adopted harness.

HOW THE DISPATCH IS WITNESSED, and why not by the `stack` field: a gate where
the bun client learned `unittest` and stamped the result `python` would satisfy
every field assertion. The fixture's own python test records its process
ANCESTRY (`/proc/<pid>`), so 'the python suite was run by invoking
`python-crucible.py`' is read off the process tree the operating system
actually built. The witness demands the fixture's own tmpdir in that ancestor's
command line, because THIS suite is itself usually run by a
`python-crucible.py` process and an unqualified match would pass on the
harness's own parent.

HOW AC8's COUNTS ARE DERIVED, never frozen: `_gate_reachable` parses each
client plus `clients/_crucible_axi.py` with `ast` and walks the call graph from
`cmd_pre_merge_gate`, collecting the IDENTIFIERS and STRING LITERALS the gate
can reach — with DOCSTRINGS excluded from the literals. Both narrowings are
measured, not defensive: half the fleet's prose says DECLARED in a comment, and
four of the five gate paths carry a docstring naming a `*-crucible.py` file, so
a scan that read prose reported both a declaration seam no gate calls and a
dispatch no client performs.

ESCALATIONS recorded at the time of writing (full text in the report):

  1. WHERE A DECLARED TARGET NAMES ITS STACK is not stated, and on this stack
     it cannot be stated without either reading the script BODY or inventing a
     format. §S1 rules the declaration is CR-CRU-111's 'extended by ONE field'
     and simultaneously forbids 'a second format'; CR-CRU-111's bun surface
     (`_read_declared_script`) reads the script TABLE and deliberately never
     parses a body ('what is run is the declaration and never a body this
     client re-parsed'). This fixture therefore declares the python-owned suite
     as a script whose BODY invokes `python-crucible.py` — the only spelling
     that invents nothing — and asserts the OBSERVABLE (both suites ran, each
     ingested under its own stack, the python one by the python client) rather
     than any parse. A ruling that the stack is declared some other way
     retargets `write_fixture_project` and nothing else in this file.
  2. WHERE `test:e2e` IS DECLARED OUT has the same gap: §S1 says 'a declared
     target states whether the GATE covers it', and there is nowhere in a
     `package.json` script table to state it. This file asserts only that the
     gate NAMES the excluded target as excluded and does not run it — which
     holds whether GREEN carries the flag per target or rules gate-coverage a
     property of the `e2e` TIER in the shared module (the reading that invents
     no format, since `TIER_MEANINGS` already lives there).
  3. AC5 says 'asserted on the board ROWS'. Nothing here reads a board row: the
     rows are made of the POST bodies, and the wire is what the sibling tier
     suites assert on. If the ruling is that a live board must be read,
     `_StubBoard` is the seam to retarget.
  4. THE ENVELOPE'S SHAPE for a multi-suite gate is unstated — AC1 requires the
     suites 'named' with counts 'attributed', and names no key. The assertions
     here are therefore structural, not literal: a node of the envelope that
     NAMES the suite must carry that suite's own counts. Any key naming
     satisfies them; a single flat total for both suites does not.
  5. THE PROCESS-ANCESTRY WITNESS reads `/proc`, so it is Linux-only. Every
     client test in this suite already assumes a POSIX toolchain, and the
     alternative (trusting the `stack` field) is the assertion AC5 warns
     against.

TIER: `integration` by the DN's definition — this file opens a TCP listener,
spawns processes and drives a real client end to end. It is reported under the
python `tests/client` suite, the declared target this repo runs as part of its
regression.

Invocation:
    python3 clients/python-crucible.py test --tests tests.client.test_gate_multi_suite_coverage --agent <id>
Fallback:
    python3 -m unittest tests.client.test_gate_multi_suite_coverage
"""

import ast
import contextlib
import http.server
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
AXI_PATH = CLIENTS_DIR / "_crucible_axi.py"
TESTS_CLIENT_DIR = Path(__file__).resolve().parent
MODALITY_PATH = TESTS_CLIENT_DIR / "test_client_tier_run_modality.py"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Cycles 378/379's harness, adopted whole. Only NON-test names are taken:
# importing one of its TestCases would run that cycle's suite a second time
# under this module.
_MODALITY = _load_module(MODALITY_PATH, "cr112_c1_modality_harness")
_TOON = _MODALITY._TOON

_ModalityCase = _MODALITY._ModalityCase
_Drive = _MODALITY._Drive
_fake = _MODALITY._fake
TEST_INGEST_ENDPOINTS = _MODALITY.TEST_INGEST_ENDPOINTS

AGENT = "CR-CRU-112-C1-gate-probe"

# The fixture's three declared targets, in the `package.json` script table
# CR-CRU-111 §S6 made bun's declaration surface — the three names this repo
# itself declares.
BUN_SUITE = "test:unit"
PYTHON_SUITE = "test:client"
EXCLUDED_SUITE = "test:e2e"

# The stacks the two gate-covered suites belong to. `stack` is the server's own
# {tier, stack, context} field (`src/v2.ts:713`), and bun is the only value the
# fleet sends today (`clients/bun-crucible.py:937`).
BUN_STACK = "bun"
PYTHON_STACK = "python"

# The counts each suite produces. They DIFFER so that 'attributed to the suite
# that produced them' is falsifiable.
BUN_SUITE_PASSED = 2
PYTHON_SUITE_PASSED = 1

# The interpreter the dispatched python suite runs under: the project venv,
# which is where `xmlrunner` lives (a bare `python3` would give the child a
# phantom ModuleNotFoundError that is a fixture bug, not a finding).
_VENV_PYTHON = REPO_ROOT / ".venv" / "bin" / "python"
CHILD_PYTHON = str(_VENV_PYTHON if _VENV_PYTHON.exists() else Path(sys.executable))

_WITNESS_ENV = "CR112_GATE_PROBE_WITNESS"

_BUN_SUITE_JUNIT = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" failures="0">
  <testsuite name="tests/unit/probe.test.ts" tests="2" failures="0">
    <testcase name="the declared bun suite runs" classname="probe"
              file="tests/unit/probe.test.ts" time="0.001"/>
    <testcase name="the declared bun suite runs its second case" classname="probe"
              file="tests/unit/probe.test.ts" time="0.001"/>
  </testsuite>
</testsuites>
"""

_BUN_PROBE_TEST_TS = """import { expect, test } from "bun:test";

test("the declared bun suite runs", () => {
  expect(1).toBe(1);
});

test("the declared bun suite runs its second case", () => {
  expect(2).toBe(2);
});
"""

# The python-owned suite's ONE test, and the dispatch witness: it records the
# ancestry of the process that ran it, so AC5's 'through its OWN stack's
# client' is read off the process tree rather than off a field the wrong client
# could have written. Single-quoted throughout so the fixture source carries no
# quoting hazard.
_PYTHON_PROBE_TEST = '''import json
import os
import unittest
from pathlib import Path


def _ancestry(limit=10):
    # This process and its ancestors as (pid, command line) — the operating
    # system's own record of WHO ran this suite.
    chain, pid = [], os.getpid()
    for _ in range(limit):
        try:
            raw = Path('/proc/%d/cmdline' % pid).read_bytes()
            status = Path('/proc/%d/status' % pid).read_text()
        except OSError:
            break
        cmdline = raw.decode('utf-8', 'replace').replace(chr(0), ' ').strip()
        chain.append({'pid': pid, 'cmdline': cmdline})
        parent = 0
        for line in status.splitlines():
            if line.startswith('PPid:'):
                parent = int(line.split()[1])
                break
        if parent <= 1:
            break
        pid = parent
    return chain


class DeclaredPythonSuiteTest(unittest.TestCase):
    # The fixture project's python-owned suite: one passing test that records
    # who ran it.

    def test_the_declared_python_suite_runs_and_records_its_runner(self):
        witness = os.environ.get('CR112_GATE_PROBE_WITNESS')
        if witness:
            Path(witness).write_text(json.dumps(_ancestry(), indent=1))
        self.assertEqual(1 + 1, 2)
'''

# A FAITHFUL fake bun, and the faithfulness is the point (cycle 379's fake
# nextest records the same reasoning). A real `bun run <script> [args]`
# executes the script's OWN command line with the extra arguments appended —
# which is how CR-CRU-111's `_bun_run_script_cmd` gets `--reporter-outfile` to
# the runner. A fake that only recorded its argv would make a suite dispatched
# THROUGH its declared script invisible, and the fixture would then decide the
# finding. `bun` inside a script body resolves to this same fake, because the
# harness deliberately leaves no real bun reachable.
_BUN_SUITE_TAIL = '''
import shlex
import subprocess

argv = sys.argv[1:]


def _write_junit():
    outfile = None
    for arg in argv:
        if arg.startswith('--reporter-outfile='):
            outfile = arg.split('=', 1)[1]
    content = os.environ.get('FAKE_BUN_JUNIT_CONTENT', '')
    if outfile and content:
        directory = os.path.dirname(outfile)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(outfile, 'w') as handle:
            handle.write(content)


if argv[:1] == ['run'] and len(argv) > 1:
    try:
        with open(os.path.join(os.getcwd(), 'package.json')) as handle:
            scripts = (json.load(handle) or {}).get('scripts') or {}
    except OSError:
        scripts = {}
    body = scripts.get(argv[1])
    if body is None:
        sys.stderr.write('error: Script not found %s' % argv[1])
        sys.exit(1)
    command = ' '.join([body] + [shlex.quote(a) for a in argv[2:]])
    if command.startswith('bun '):
        command = shlex.quote(sys.argv[0]) + command[3:]
    sys.exit(subprocess.run(command, shell=True, cwd=os.getcwd()).returncode)

_write_junit()
sys.exit(int(os.environ.get('FAKE_BUN_EXIT_CODE', '0')))
'''

FAKE_BUN = "fake-bun-suite"


def setUpModule():
    """The adopted module fixture (cycle 379's fake toolchains on PATH), plus
    the one fake this file adds beside them, built by the same code."""
    _MODALITY.setUpModule()
    path = Path(_MODALITY._BIN_DIR) / FAKE_BUN
    path.write_text(_MODALITY._RECORD.replace("__PYTHON__", sys.executable)
                    .replace("__TOOL__", FAKE_BUN) + _BUN_SUITE_TAIL)
    path.chmod(0o755)


def tearDownModule():
    _MODALITY.tearDownModule()


# ── the transport: one board every process in the drive reports to ─────────

_BOARD_OK = {"ok": True, "changed": True,
             "run": {"total": 1, "passed": 1, "failed": 0, "pending": 0}}


class _StubBoard:
    """Every request the gate — or anything it spawns — makes, recorded as
    (method, path, body).

    A stub SERVER rather than the sibling suites' in-process `_post` patch for
    one reason: a suite dispatched to its own stack's client runs in a
    subprocess, and a patched attribute in this process cannot see what that
    subprocess sent. Bound to 127.0.0.1 on an ephemeral port, so the live board
    is never touched and no port is assumed free."""

    def __init__(self):
        self.requests = []
        self._lock = threading.Lock()
        board = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _record(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw) if raw else {}
                except ValueError:
                    payload = {"_raw": raw.decode("utf-8", "replace")}
                with board._lock:
                    board.requests.append((self.command, self.path, payload))

            def _answer(self):
                body = json.dumps(_BOARD_OK).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                self._record()
                self._answer()

            do_POST = do_GET
            do_PATCH = do_GET
            do_DELETE = do_GET

            def log_message(self, *args):
                return

        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        daemon=True)
        self._thread.start()

    @property
    def url(self):
        host, port = self._server.server_address[:2]
        return "http://%s:%d" % (host, port)

    def posts(self):
        with self._lock:
            return [(path, payload) for method, path, payload in self.requests
                    if method == "POST"]

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


# ── reading the envelope without freezing its shape (ESCALATION 4) ─────────


def _nodes(value):
    """Every mapping in a decoded envelope, parents before children."""
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _nodes(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _nodes(item)


def _text(value):
    return json.dumps(value, default=str, sort_keys=True)


_COUNT_KEY_RE = re.compile(r"pass|fail|total|pending", re.IGNORECASE)


def _counts(node):
    """The numeric pass/fail-ish fields of one mapping, keyed lowercase."""
    found = {}
    for key, value in node.items():
        if not _COUNT_KEY_RE.search(str(key)):
            continue
        try:
            found[str(key).lower()] = int(str(value))
        except (TypeError, ValueError):
            continue
    return found


def _attributed_counts(envelope, suite):
    """The counts carried by the DEEPEST node of the envelope that names
    `suite` — 'attributed to the suite that produced them'. None when no node
    names the suite at all, and {} when one names it and carries no counts of
    its own (a suite listed under a single flat total)."""
    named = None
    for node in _nodes(envelope):
        if suite not in _text(node):
            continue
        named = named if named is not None else {}
        counts = _counts(node)
        if counts:
            named = counts
    return named


def _naming_node_text(envelope, suite):
    """The text of the deepest node naming `suite`, for the exclusion read."""
    deepest = None
    for node in _nodes(envelope):
        if suite in _text(node):
            deepest = node
    return _text(deepest) if deepest is not None else ""


# ── the fixture project + the gate drive ──────────────────────────────────


class _GateFixtureCase(_ModalityCase):
    """One throwaway project per test, declaring three targets, driven through
    the REAL `bun-crucible.py pre-merge-gate` verb, with every process in the
    drive reporting to this test's own stub board."""

    CLIENT = "bun"
    PROJECT_KEY = "cr112-gate-multi-suite-key"

    def setUp(self):
        super().setUp()
        self.board = _StubBoard()
        self.addCleanup(self.board.stop)
        self.witness_path = os.path.join(self.tmpdir, "python-suite-witness.json")
        self._saved_witness = os.environ.get(_WITNESS_ENV)
        self.addCleanup(self._restore_witness_env)
        os.environ[_WITNESS_ENV] = self.witness_path
        os.environ["CRUCIBLE_URL"] = self.board.url
        os.environ["CRUCIBLE_BASE"] = self.board.url
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _BUN_SUITE_JUNIT
        self.write_fixture_project()

    def _restore_witness_env(self):
        if self._saved_witness is None:
            os.environ.pop(_WITNESS_ENV, None)
        else:
            os.environ[_WITNESS_ENV] = self._saved_witness

    # ── the declaration (ESCALATION 1) ────────────────────────────────────

    def python_suite_command(self):
        """The python-owned target's script body: this repo's own python client,
        pointed at the fixture's `tests/client`. The stack is stated the only
        way a `package.json` script can state it — by naming the client that
        owns it."""
        return ("%s %s regression --start-dir tests/client --pattern 'test_*.py' "
                "--agent %s --project-dir %s --reports reports --python %s"
                % (CHILD_PYTHON, CLIENTS_DIR / "python-crucible.py", AGENT,
                   self.tmpdir, CHILD_PYTHON))

    def write_fixture_project(self):
        bun_tests = Path(self.tmpdir, "tests", "unit")
        bun_tests.mkdir(parents=True, exist_ok=True)
        (bun_tests / "probe.test.ts").write_text(_BUN_PROBE_TEST_TS)

        python_tests = Path(self.tmpdir, "tests", "client")
        python_tests.mkdir(parents=True, exist_ok=True)
        (python_tests / "test_probe.py").write_text(_PYTHON_PROBE_TEST)

        (Path(self.tmpdir) / "package.json").write_text(json.dumps({
            "name": "gate-multi-suite-probe",
            "private": True,
            "scripts": {
                BUN_SUITE: "bun test tests/unit",
                PYTHON_SUITE: self.python_suite_command(),
                EXCLUDED_SUITE: "bunx bddgen && bunx playwright test",
            },
        }, indent=2) + "\n")

    # ── the drive ─────────────────────────────────────────────────────────

    def drive_gate(self, extra=()):
        """ONE `pre-merge-gate` invocation, with REAL file descriptors for
        stdout/stderr (the adopted `drive_with_real_std`, minus its `_post`
        patch: the transport is the stub board, so a dispatched sibling
        client's POSTs are recorded beside the gate's own).

        `--skip-check` bypasses the tsc step: the gate's fail-fast check is
        CR-CRU-058's contract and not this CR's subject, and no fixture project
        typechecks."""
        argv = ["pre-merge-gate", "--agent", AGENT,
                "--project-dir", self.tmpdir, "--package-dir", self.tmpdir,
                "--bun", _fake(FAKE_BUN), "--reports", "reports",
                "--skip-check"] + list(extra)
        out_path = os.path.join(self.tmpdir, "gate-stdout.txt")
        err_path = os.path.join(self.tmpdir, "gate-stderr.txt")
        with open(out_path, "w") as out, open(err_path, "w") as err:
            with mock.patch.object(self.module, "CRUCIBLE_URL", self.board.url), \
                    mock.patch.object(sys, "argv", ["bun-crucible.py"] + argv), \
                    contextlib.redirect_stdout(out), \
                    contextlib.redirect_stderr(err):
                try:
                    self.module.main()
                    code = 0
                except SystemExit as exc:
                    code = (exc.code if isinstance(exc.code, int)
                            else (0 if exc.code is None else 1))
        return _Drive(code, Path(out_path).read_text(),
                      Path(err_path).read_text(), self.board.posts())

    # ── what the drive is asked ───────────────────────────────────────────

    def gate_envelope(self, drive):
        """The GATE's own AXI envelope, taken as the LAST decodable document on
        stdout: a dispatched sibling client emits an envelope of its own, and
        the gate's is the one that closes the run."""
        starts = [m.start() for m in re.finditer(r"(?m)^axi:", drive.out)]
        for start in reversed(starts or [0]):
            try:
                decoded = _TOON.decode(drive.out[start:])
            except Exception:  # a partial document is simply not the one
                continue
            axi = decoded.get("axi") if isinstance(decoded, dict) else None
            if isinstance(axi, dict) and axi.get("verb") == "pre-merge-gate":
                return axi
        self.fail("the gate emitted no `pre-merge-gate` AXI envelope on stdout "
                  "at all — exit=%r stdout=%r stderr=%r"
                  % (drive.code, drive.out[-2000:], drive.err[-2000:]))

    def ingests(self, drive):
        """Every TEST-run ingest body this ONE gate invocation put on the wire,
        whichever of the fleet's ingest endpoints carried it and whichever
        process sent it."""
        return [payload for path, payload in drive.calls
                if path in TEST_INGEST_ENDPOINTS]

    def witness(self):
        """The ancestry the fixture's python test recorded, or None when that
        suite never ran at all."""
        if not os.path.exists(self.witness_path):
            return None
        return json.loads(Path(self.witness_path).read_text())


class GateRunsEveryDeclaredSuiteTest(_GateFixtureCase):
    """AC1 — RED (both). 'A single gate invocation runs BOTH and its envelope
    names both, with the per-suite pass/fail counts attributed to the suite
    that produced them', and its negative.

    `bun-crucible.py`'s gate is `check` then one whole-suite `bun test`, so the
    fixture's python-owned target is neither read nor run nor named."""

    def test_one_gate_invocation_names_both_gate_covered_suites_with_their_own_counts(self):
        drive = self.drive_gate()
        envelope = self.gate_envelope(drive)
        for suite, passed in ((BUN_SUITE, BUN_SUITE_PASSED),
                              (PYTHON_SUITE, PYTHON_SUITE_PASSED)):
            with self.subTest(suite=suite):
                counts = _attributed_counts(envelope, suite)
                self.assertIsNotNone(
                    counts,
                    "AC1 — the gate's envelope does not name the declared "
                    "gate-covered suite %r at all, so a reader cannot tell "
                    "whether it ran: 'a gate that ran a subset reports as a "
                    "gate that ran a subset'. envelope=%s"
                    % (suite, _text(envelope)))
                self.assertTrue(
                    counts,
                    "AC1 — %r is named but carries no counts of its own; the "
                    "counts must be attributed to the suite that produced "
                    "them, not pooled into one total. envelope=%s"
                    % (suite, _text(envelope)))
                self.assertEqual(
                    counts.get("passed"), passed,
                    "AC1 — %r is named with the wrong counts: this suite "
                    "produced %d passing test(s) and the envelope attributes "
                    "%r to it. The two suites' counts differ on purpose, so a "
                    "shared total fails here." % (suite, passed, counts))
                self.assertEqual(
                    counts.get("failed", 0), 0,
                    "AC1 — %r produced no failures and the envelope attributes "
                    "%r to it." % (suite, counts))

    def test_the_declared_target_the_gate_does_not_cover_is_named_as_excluded(self):
        """AC1's negative — 'the declared-but-not-gate-covered target
        (`test:e2e`) is NOT run by the gate and is named as excluded rather
        than absent, so covers-every-declared-suite cannot be satisfied by a
        declaration that quietly omits one'. The not-run half holds today; the
        NAMING half is the RED, and it is the half that stops a silent omission
        passing for a decision (ESCALATION 2)."""
        drive = self.drive_gate()
        envelope = self.gate_envelope(drive)
        ran = [record for record in self.invocations()
               if any("playwright" in arg or "bddgen" in arg
                      or arg == EXCLUDED_SUITE for arg in record["argv"])]
        self.assertEqual(
            ran, [],
            "AC1 — the gate RAN the declared target it does not cover (%s); "
            "e2e ownership is DN open question 5 and this CR's non-goals defer "
            "it. invocations=%r" % (EXCLUDED_SUITE, ran))
        named = _naming_node_text(envelope, EXCLUDED_SUITE)
        self.assertTrue(
            named,
            "AC1 — the gate's envelope never mentions %r. An omission by "
            "silence leaves the next reader unable to tell a decision from an "
            "oversight, which is exactly how covers-every-declared-suite is "
            "satisfied by a quiet omission. envelope=%s"
            % (EXCLUDED_SUITE, _text(envelope)))
        self.assertRegex(
            named, r"(?i)exclud",
            "AC1 — %r is mentioned but not named as EXCLUDED: the envelope "
            "must state that the gate does not cover it, not merely list it. "
            "node=%s" % (EXCLUDED_SUITE, named))


class EachSuiteIngestsThroughItsOwnStacksClientTest(_GateFixtureCase):
    """AC5 — RED (both). 'Each suite's runs are ingested by its own stack's
    client … the python suite's run carries the python stack and the bun
    suite's run carries the bun stack, from one gate invocation.'

    Two methods, because the FIELD and the DISPATCH are independently
    breakable: a bun client that learned `unittest` and wrote the python stack
    on the body would pass the first and fail the second, and that client is
    what §S1 forbids by construction."""

    def test_one_gate_invocation_ingests_each_suite_under_its_own_stack(self):
        drive = self.drive_gate()
        ingests = self.ingests(drive)
        stacks = [payload.get("stack") for payload in ingests]
        self.assertIn(
            BUN_STACK, stacks,
            "AC5 — no run from this gate invocation carries the bun stack. "
            "ingests=%s" % _text(ingests))
        self.assertIn(
            PYTHON_STACK, stacks,
            "AC5 — no run from this gate invocation carries the python stack: "
            "the declared python suite is either never run or ingested as "
            "something else. `clients/python-crucible.py` sends no `stack` key "
            "at all today, so nothing this repo ingests has ever been "
            "attributable to the python suite. stacks=%r ingests=%s"
            % (stacks, _text(ingests)))
        python_runs = [p for p in ingests if p.get("stack") == PYTHON_STACK]
        self.assertEqual(
            len(python_runs), 1,
            "AC5 — exactly one run of this gate belongs to the python suite; "
            "%d carry that stack. ingests=%s"
            % (len(python_runs), _text(ingests)))

    def test_the_python_suite_is_run_by_invoking_the_python_client(self):
        """AC5's dispatch half, and §S1's 'no client learns another language's
        tests' — read off the process tree, never off the `stack` field a
        mislabelling client could have written."""
        drive = self.drive_gate()
        witness = self.witness()
        self.assertIsNotNone(
            witness,
            "AC5 — the declared python suite never ran at all: the gate left "
            "no witness at %s. exit=%r invocations=%s"
            % (self.witness_path, drive.code, _text(self.invocations())))
        dispatched = [entry for entry in witness
                      if "python-crucible.py" in entry["cmdline"]
                      and self.tmpdir in entry["cmdline"]]
        self.assertTrue(
            dispatched,
            "AC5 — the python suite ran, but no ancestor of it is a "
            "`python-crucible.py` invocation over this fixture: the suite was "
            "NOT dispatched to its own stack's client, which is the only thing "
            "that makes its run ingestable as a python run. ancestry=%s"
            % _text(witness))


# ── AC8 — the multi-suite gate path, derived by scanning ──────────────────

_CLIENT_SUFFIX = "-crucible.py"
FLEET = tuple(sorted(p.name[: -len(_CLIENT_SUFFIX)]
                     for p in CLIENTS_DIR.glob("*" + _CLIENT_SUFFIX)))

GATE_ENTRY = "cmd_pre_merge_gate"

# CR-CRU-111's SHIPPED declaration seam (`clients/_crucible_axi.py`, cycle
# 382). §S1 rules this CR's declaration is that one 'extended by ONE field', so
# a gate that composes over the declared suites reaches these names; a gate
# that runs one runner's discovery does not. Symbols, never prose: half the
# fleet's comments say DECLARED.
DECLARATION_SEAM = ("DeclaredTierSurface", "declared_target_name",
                    "declared_tier_run", "declared_tier_surface_line",
                    "_TIER_DECLARATION_SURFACE")

# A sibling client, however a dispatch spells it: the literal file name, or the
# suffix an f-string built from a stack would carry.
SIBLING_CLIENT_RE = re.compile(r"-crucible\.py")

# Where the standing python gate step lives today, to be NAMED in the failure
# rather than assumed: the union already exists in `scripts/run-test-target.ts`
# and in the docs, both of them places the gate does not look.
PYTHON_SUITE_STEP_RE = re.compile(
    r"unittest[^\n]{0,40}discover|python-crucible\.py|python3 -m unittest")


def _functions(tree):
    return {node.name: node for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}


def _called(node):
    names = set()
    for child in ast.walk(node):
        if not isinstance(child, ast.Call):
            continue
        func = child.func
        name = (func.attr if isinstance(func, ast.Attribute)
                else getattr(func, "id", None))
        if name:
            names.add(name)
    return names


def _module_constants(tree):
    """`{name: [string literals in its value]}` for every module-level
    assignment — the shape a dispatch table takes when it is not spelled inline
    in the function that reads it."""
    constants = {}
    for node in tree.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        names = [t.id for t in targets if isinstance(t, ast.Name)]
        if not names or node.value is None:
            continue
        found = [child.value for child in ast.walk(node.value)
                 if isinstance(child, ast.Constant) and isinstance(child.value, str)]
        for name in names:
            constants.setdefault(name, []).extend(found)
    return constants


def _docstrings(node):
    """The id() of every Constant in `node` that is a DOCSTRING — prose, not
    code. Measured need: four of the five clients' gate paths carry a docstring
    naming a `*-crucible.py` file, so a scan that read prose reported a
    dispatch none of them performs."""
    marked = set()
    for child in ast.walk(node):
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef,
                                  ast.ClassDef, ast.Module)):
            continue
        body = getattr(child, "body", None) or []
        first = body[0] if body else None
        if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            marked.add(id(first.value))
    return marked


def _identifiers_and_literals(node):
    docstrings = _docstrings(node)
    identifiers, literals = set(), []
    for child in ast.walk(node):
        if isinstance(child, ast.Name):
            identifiers.add(child.id)
        elif isinstance(child, ast.Attribute):
            identifiers.add(child.attr)
        elif (isinstance(child, ast.Constant) and isinstance(child.value, str)
                and id(child) not in docstrings):
            literals.append(child.value)
    return identifiers, literals


def _gate_reachable(client):
    """The identifiers and string literals `cmd_pre_merge_gate` can reach in
    `client` and in the shared module, walked as a call graph.

    DOCSTRINGS ARE EXCLUDED from `literals`, and that is a measurement rather
    than a precaution: four of the five gate paths carry a docstring that names
    a `*-crucible.py` file, so reading prose reported a sibling-client dispatch
    that no client performs."""
    trees = [ast.parse(path.read_text(encoding="utf-8"))
             for path in (CLIENTS_DIR / (client + _CLIENT_SUFFIX), AXI_PATH)]
    tables = [_functions(tree) for tree in trees]
    constants = {}
    for tree in trees:
        constants.update(_module_constants(tree))
    identifiers, literals, seen, queue = set(), [], set(), [GATE_ENTRY]
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        for table in tables:
            node = table.get(name)
            if node is None:
                continue
            found_ids, found_literals = _identifiers_and_literals(node)
            identifiers |= found_ids
            literals += found_literals
            queue.extend(_called(node))
    # A dispatch table is a module-level constant referenced by name, so its
    # strings belong to the gate path that reads it: `{"python":
    # "python-crucible.py"}` beside the function is the same statement as the
    # literal inside it.
    for name in identifiers & set(constants):
        literals += constants[name]
    return identifiers, literals


def _repo_files_naming_the_python_step():
    """Where the standing python gate step is written down today, split into
    documentation and code — the evidence for 'rather than only from
    documentation'."""
    docs, code = [], []
    candidates = [REPO_ROOT / "CLAUDE.md", REPO_ROOT / "package.json"]
    for root, pattern in ((REPO_ROOT / "docs", "*.md"),
                          (REPO_ROOT / "scripts", "*.ts"),
                          (REPO_ROOT / "scripts", "*.sh")):
        if root.is_dir():
            candidates += sorted(root.rglob(pattern))
    for path in candidates:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if not PYTHON_SUITE_STEP_RE.search(text):
            continue
        rel = str(path.relative_to(REPO_ROOT))
        (docs if path.suffix == ".md" else code).append(rel)
    return docs, code


class MultiSuiteGateHasACallerTest(unittest.TestCase):
    """AC8 — RED (both). 'Caller existence: a grep at VERIFY time returns ≥1
    non-test caller of the multi-suite gate path, and the standing python gate
    step is invoked from the gate itself rather than only from documentation.'

    Both halves are DERIVED by walking each client's gate call graph, so the AC
    cannot be satisfied by a composition that exists and is called by nothing —
    the failure mode a frozen list of callers would hide."""

    def test_at_least_one_gate_reaches_the_declaration_the_suites_come_from(self):
        """The caller half. A multi-suite gate composes over the project's
        DECLARED targets (§S1: 'regression is the union of the declared targets
        … computed from the declaration rather than from a second list'), so
        its path reaches CR-CRU-111's declaration seam. The callers are the
        clients' own `cmd_pre_merge_gate` — non-test by construction, since
        nothing under `tests/` is scanned here."""
        reaching = {}
        for client in FLEET:
            identifiers, _literals = _gate_reachable(client)
            hit = sorted(set(DECLARATION_SEAM) & identifiers)
            if hit:
                reaching[client] = hit
        self.assertTrue(
            reaching,
            "AC8 — no client's `%s` can reach the declaration seam (%s), so "
            "there is no multi-suite gate path for a caller to have. Every "
            "gate in the fleet (%s) is `check` then its own single-runner "
            "regression, which is why a suite that runner cannot see is not "
            "gated." % (GATE_ENTRY, ", ".join(DECLARATION_SEAM),
                        ", ".join(FLEET)))

    def test_the_python_gate_step_is_invoked_from_the_gate_not_only_documented(self):
        """The second half. A gate that dispatches a suite to its own stack's
        client names that client somewhere its own path can reach; today the
        step exists only where the gate does not look."""
        dispatching = {}
        for client in FLEET:
            _identifiers, literals = _gate_reachable(client)
            hit = sorted({lit for lit in literals if SIBLING_CLIENT_RE.search(lit)})
            if hit:
                dispatching[client] = hit
        if dispatching:
            return
        docs, code = _repo_files_naming_the_python_step()
        self.fail(
            "AC8 — no client's `%s` path names a sibling crucible client, so "
            "no gate invokes the standing python gate step. It is written down "
            "in code the gate never reaches (%s) and in documentation (%s): "
            "`scripts/run-test-target.ts`'s `test:regression` already runs "
            "`bun test` and then `python3 -m unittest discover -s "
            "tests/client`, but it invokes python DIRECTLY, so nothing is "
            "ingested for the python suite and the gate never consults it."
            % (GATE_ENTRY, ", ".join(code) or "nowhere",
               ", ".join(docs) or "nowhere"))


# ── AC6/§S3 — no suite is gained by hiding files ──────────────────────────


class NoSuiteIsGainedByHidingFilesTest(unittest.TestCase):
    """AC6/§S3 — PIN, born green and required to stay green. 'Nothing in this
    CR may introduce a discovery exclusion: `bunfig.toml` carries no
    `pathIgnorePatterns` (CR-CRU-047 §S1) and `tests/suite-integrity.test.ts`
    asserts the key is absent, because a permanently-excluded directory makes
    suite size unreconcilable.'

    Driven through that file's OWN `discoveryExclusions` over the REAL config,
    which is what AC6 names as the instrument: a python re-implementation of
    the same regex would be a second decision that can disagree with the one
    the repo actually ships. The run is filtered to that guard's own describe
    block, so this PIN costs one `bun test` of two assertions and never the
    file's real-bun fixture block."""

    GUARD = "no pathIgnorePatterns exclusion"

    def test_the_repo_declares_zero_discovery_exclusions_by_its_own_guard(self):
        result = subprocess.run(
            ["bun", "test", "tests/suite-integrity.test.ts", "-t", self.GUARD],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=180)
        output = result.stdout + result.stderr
        self.assertEqual(
            result.returncode, 0,
            "AC6 — `tests/suite-integrity.test.ts`'s own `discoveryExclusions` "
            "guard does not pass over the real `bunfig.toml`: this CR widens "
            "what the gate RUNS and may not narrow what the runner COLLECTS. "
            "output=%s" % output[-3000:])
        passed = re.search(r"^\s*(\d+) pass", output, re.MULTILINE)
        failed = re.search(r"^\s*(\d+) fail", output, re.MULTILINE)
        self.assertIsNotNone(
            passed,
            "AC6 — the guard run reported no pass count, so this PIN measured "
            "nothing. output=%s" % output[-3000:])
        self.assertEqual(
            int(passed.group(1)), 2,
            "AC6 — the %r block is two assertions (the key is absent; no "
            "future entry may reference the tests/ tree) and the run collected "
            "%s. output=%s" % (self.GUARD, passed.group(1), output[-3000:]))
        self.assertEqual(
            int(failed.group(1)) if failed else 0, 0,
            "AC6 — the discovery-exclusion guard failed. output=%s"
            % output[-3000:])


if __name__ == "__main__":
    unittest.main()
