"""CR-CRU-111 §S5 — the AXI envelope states the tier of the run it just
ingested (AC7).

One acceptance criterion lives here, and it is the one cycle 381 owns:

  * **AC7** — "the AXI envelope carries the ingested tier on every exit path:
    success, a failing suite, zero-discovery, and the compile-tier fallback.
    Four assertions, one per path."

§S5 says WHY, and the why is what these assertions are shaped around: "the AXI
envelope names the tier of the run it just ingested, so an orchestrator reading
the envelope knows what was covered without inspecting the board. Every exit
path states it."

WHAT IS ASSERTED, AND WHY IT IS NOT ASSERTED AS A STRING MATCH. Every assertion
in this file reads the envelope's STRUCTURED field and compares it against the
POST bodies the same drive actually sent. Nothing here scrapes stdout prose,
and nothing here freezes an expected tier per test: the expectation is DERIVED
from the wire (`_expected_statement`), so an envelope that names a tier the run
did not ingest fails, and an envelope that stays silent about one it DID ingest
fails too. That derivation is the whole point — AC7 is a claim about
agreement between two channels, and only a comparison can test agreement.

─────────────────────────────────────────────────────────────────────────────
THE FIELD AND ITS VOCABULARY — RULED HERE, see ESCALATION 1.

AC7 says the envelope "carries the ingested tier" and does not say under which
key or with which value. Cycle 377's AC4 and cycle 380's warning code set the
precedent for settling such a name in RED rather than leaving it to GREEN, so
an AC fails on a defect and not on a naming disagreement. Ruled:

  * the key is a TOP-LEVEL envelope field, `tier`, beside `verb`/`ok`/`run`.
    Not `run.tier`: two of AC7's four exit paths (zero-discovery, the compile
    fallback) carry NO `run` block at all, and inventing an empty one to hang
    a tier off would make the envelope claim a run happened;
  * its value is drawn from a CLOSED vocabulary — the six `Tier` values plus
    exactly three sentinels, each forced by a distinction this CR has already
    drawn elsewhere:

      `<one of the six>`  a TEST run was ingested under that tier;
      `"unstated"`        a test run was ingested and the client stated NO
                          tier, so the server's own documented default applies
                          (§S2/AC3 — after cycle 378 this is what `test` and
                          `auto-ingest` do, and the envelope must say so
                          rather than invent one or print a bare null);
      `"compile"`         the exit ingested a COMPILE event, which is not a
                          test tier at all (AC13a, cycle 378);
      `"none"`            nothing was ingested on this exit at all
                          (zero-discovery, and §S1's tier-run-undeclared
                          refusal).

  * it is NEVER absent, NEVER `None`/`null`, and NEVER the string `"None"`.

The three sentinels are asserted to live in `clients/_crucible_axi.py` beside
`TIER_MEANINGS` and `TIER_RUN_UNDECLARED_CODE`, for rule 15's reason: "the
envelope states the tier" is satisfiable by one client on one path, and a
per-client copy of the vocabulary is what AC10 forbids in the first place.

─────────────────────────────────────────────────────────────────────────────
THE PER-CLIENT PATH MATRIX, DERIVED BY READING THE CLIENTS (not by assuming
AC7's four paths exist five times). Measured on `feature/CR-CRU-111`@`dd03561`,
2026-09-08. `TIER_VERB_DRIVEN` and `COMPILE_EXIT_VERB` below are this table in
code, and every drive in this file is built from them:

  client   tier verb driven   success / failing suite   zero-discovery
  bun      regression         `_emit_ingest_axi`        junit with 0 testcases
                                                        → ingested, total 0
  python   regression         `_emit_ingest_axi`        its OWN branch: "Ran 0
                                                        tests", no XML →
                                                        `no-tests-discovered`,
                                                        NOTHING ingested
  mvn      unit               `_emit_tier_run_axi`      surefire report with
                                                        tests="0" → ingested
  rust     unit               `_emit_ingest_axi`        junit with 0 testcases
                                                        → ingested
  arduino  unit               `_emit_ingest_summary_axi` TEST-*.xml tests="0"
                                                        → ingested

  client   compile ingest, and whether it is a FALLBACK from the tier verb
  bun      NOT from `regression` — that verb's no-JUnit exit ingests NOTHING
           (`bun-crucible.py:1219`, "no JUnit XML, nothing to ingest"). bun's
           compile fallback lives on the untiered `test` verb (`:1131`), so
           this file drives THAT, and asserts it states `compile`.
  python   YES — `_regression_run`'s no-XML branch ingests the capture to
           /api/v2/runs/compile (`python-crucible.py:824`).
  mvn      YES — `_run_surefire_tier` → `_compile_fallback` →
           `_emit_compile_fallback_axi` (which already carries `stage:
           "compile"`; the ruled `tier` field is its machine-readable twin).
  rust     YES — `cmd_test`'s no-junit branch runs `cargo check` and ingests
           rustc stderr (`rust-crucible.py:1136`).
  arduino  NO compile fallback from a test run AT ALL: no reports → an
           `ok:false` no-report envelope and no ingest (`:538`). arduino's
           compile ingest is a first-class verb (`compile`/`check`, the
           arduino-cli target build), so this file drives THAT — AC13a's rule
           is fleet-wide and the envelope must state `compile` there too.

So the (client × path) matrix is 5 × 4 = 20 and every cell is driven; two of
the twenty (bun, arduino) are driven on a verb OTHER than that client's tier
verb, and each of those two says so in its own docstring. The 5 is SCANNED
(`clients/*-crucible.py` calling `add_tier_verbs`) and the 4 is READ OUT OF
AC7's own text — neither number is frozen in this file.

─────────────────────────────────────────────────────────────────────────────
WHAT IS RED HERE AND WHAT IS A PIN, stated per test, because a suite that does
not say which of its members were born green is a suite whose colour means
nothing. MEASURED on `feature/CR-CRU-111`@`dd03561` (cycles 377-380 merged):

  RED  every `{Bun,Python,Mvn,Rust,Arduino}IngestedTierEnvelopeTest` method —
         all TWENTY. No client emits a `tier` field on ANY envelope today
         (`emit_axi`'s result_fields are `run`/`help`/`error`/`stage` and no
         more), so every exit path is silent about what it covered.
         The `..._compile_fallback_...` quarter of them carries AC13a's rule
         onto the envelope too: a compile ingest states `compile`, never one
         of the six.
  RED  `{Bun,Python,Mvn,Rust,Arduino}TierLessEnvelopeTest` — all five, both
         subtests each (`test` and `auto-ingest`), TEN drives. The subtle
         half: after cycle 378 a bare `test`/`auto-ingest` sends no tier, and
         "no tier" must be SAID (`"unstated"`), never guessed, never null.
  RED  `FleetOneDefinitionTest.test_the_shared_module_names_the_envelope_tier_
         vocabulary` — all three subtests. Rule 15's "one definition" bound.
  PIN  `{...}RefusalClaimsNothingTest` — all five. §S1's refusal runs nothing
         and ingests nothing, so it must not report an ingested tier. NOT one
         of AC7's four paths, so it is excluded from the matrix count AND
         asserted more weakly on purpose (`assertClaimsNothingWasIngested`
         reads the field only if it is there): requiring the field on an exit
         AC7 does not enumerate would be asserting past the AC. It passes
         today because nothing states a tier anywhere; its job starts at GREEN.
  PIN  `{Bun,Arduino}IngestedTierEnvelopeTest.test_the_no_report_exit_claims_
         nothing_was_ingested` — the two clients whose tier verb has a
         no-report exit that ingests nothing. Same bound, same reason, same
         trivial pass today.
  PIN  `ExitPathCoverageTest` (three methods), `Ac7PathCountTest` (two) and
         the two fleet-reach instruments in
         `TierLessEnvelopeIsHonestTest`/`TierRunUndeclaredClaimsNothingTest`.
         They fail when this file stops driving a (client, path) cell, when a
         client stops being probed, or when the four paths this file names
         stop matching AC7's own words.

HARNESS: cycle 379's `tests/client/test_client_tier_run_modality.py`, adopted
whole exactly as cycle 380 adopted it — which is in turn cycle 378's
`_ClientDriveCase` (client loaded by path, real argparse via `main()`,
`_post`/`_get`/`_patch` recorded, fake toolchains that log their argv). No
fourth mechanism, no real bun/mvn/cargo/make/arduino-cli, and no request
leaves this process. The ONE addition is a fake python runner that honours
`FAKE_PY_OUTPUT`, so python's own zero-discovery branch ("Ran 0 tests" with no
traceback) can be reached at all — cycle 379's copy prints a fixed collection
failure and can only ever reach the compile branch.

ESCALATIONS recorded at the time of writing (see the report for the full text):

  1. AC7 names neither the FIELD nor what it says on a TIER-LESS run, and the
     second gap is load-bearing: after cycle 378 `test` and `auto-ingest` send
     no tier at all and `src/store.ts` applies `?? "unit"` server-side. An
     envelope that echoed the server's default would re-introduce exactly the
     unearned claim §S2 removed, one channel over. This file rules `tier:
     "unstated"` — a positive statement that the client asserted nothing —
     over the two alternatives (omit the key; echo `unit`), because an ABSENT
     key is indistinguishable from an old client and an echoed `unit` is the
     defect. Recommended, not decided: if it is ruled otherwise, the value is
     `ENVELOPE_TIER_UNSTATED` in one place here and one in the shared module.
  2. AC7 says "four assertions, one per path" — SINGULAR, and rule 15's whole
     lesson from this CR is that such a phrasing is satisfied once and
     shipped. Read literally, four assertions total would leave four of the
     five clients unasserted. This file reads it as four per client (twenty),
     on the same reasoning AC1/AC3/AC6 apply explicitly, and asserts BOTH
     counts. If four-in-total is really meant, this file over-asserts — which
     is the safe direction.
  3. Not every client HAS all four paths in the shape AC7 describes, and two
     do not: bun's tier verb ingests nothing on a no-report exit, and arduino
     has no compile fallback from a test run at all. Rather than declare those
     cells absent, this file drives each client's REAL compile-ingest exit
     (bun `test`, arduino `compile`) and says so per test. If AC7 is meant to
     be scoped to tier verbs only, those two drives are the ones to move.
  4. "Zero-discovery" is a distinct code branch in exactly ONE client
     (`python-crucible.py:_is_zero_discovery`). In the other four the runner
     finding no tests produces a report containing no testcases, which flows
     through the ordinary ingest path with `total: 0`. Both are driven here as
     zero-discovery because both are the outcome AC7 names, but they are not
     the same mechanism, and only python's ingests NOTHING — so only python's
     zero-discovery envelope says `"none"`. The derived expectation absorbs
     the difference; a frozen one could not.

Invocation:
    python3 -m pytest tests/client/test_client_tier_run_envelope.py -q
Fallback:
    python3 tests/client/test_client_tier_run_envelope.py
"""

import importlib.util
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
MODALITY_PATH = Path(__file__).resolve().parent / "test_client_tier_run_modality.py"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"
CR_PATH = (REPO_ROOT / "docs" / "changes"
           / "CR-CRU-111-the-client-can-say-which-tier-it-ran.md")


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Cycle 379's harness, adopted whole (cycle 380's precedent). Only NON-test
# names are taken: importing one of its TestCases would run that cycle's suite
# a second time under this module.
_MODALITY = _load_module(MODALITY_PATH, "cr111_c5_tier_modality_harness")
_AXI = _load_module(AXI_MODULE_PATH, "cr111_c5_axi")

AGENT = _MODALITY.AGENT
PARSED = _MODALITY.PARSED
RUNS = _MODALITY.RUNS
RUN_START = _MODALITY.RUN_START
COMPILE = _MODALITY.COMPILE
TIER_RUN_UNDECLARED_CODE = _MODALITY.TIER_RUN_UNDECLARED_CODE

# The six, from the ONE client-side mirror (AC10 forbids a second copy).
TIER_VOCABULARY = frozenset(_AXI.TIER_MEANINGS)

# The endpoints that INGEST a test run. `RUN_START` is deliberately NOT one:
# it OPENS a run before any test has finished, so a drive that opened a run and
# then ingested a compile failure (bun `test` with no JUnit) has ingested no
# test run at all. Conflating the two would let that exit claim `"unstated"`
# where the honest answer is `"compile"`.
INGEST_ENDPOINTS = (RUNS, PARSED)

# ── the ruled field and its closed vocabulary (ESCALATION 1) ───────────────
#
# `getattr` with a default rather than a hard reference, cycle 380's idiom: an
# AttributeError at import time would take the PINs down with the REDs and hide
# which is which.
ENVELOPE_TIER_FIELD = "tier"
UNSTATED_CONST = "ENVELOPE_TIER_UNSTATED"
COMPILE_CONST = "ENVELOPE_TIER_COMPILE"
NOTHING_CONST = "ENVELOPE_TIER_NONE"
UNSTATED = getattr(_AXI, UNSTATED_CONST, "unstated")
COMPILE_STATEMENT = getattr(_AXI, COMPILE_CONST, "compile")
NOTHING_INGESTED = getattr(_AXI, NOTHING_CONST, "none")
SENTINELS = (UNSTATED, COMPILE_STATEMENT, NOTHING_INGESTED)

# ── AC7's four exit paths, READ OUT OF AC7 (ESCALATION 2) ──────────────────
#
# Each entry is `(label, the token AC7 itself uses for that path)`. The tokens
# are asserted to appear in AC7's own text, so this file's notion of "the four
# paths" cannot drift from the CR's.
EXIT_PATHS = (
    ("success", "success"),
    ("failing-suite", "a failing suite"),
    ("zero-discovery", "zero-discovery"),
    ("compile-fallback", "the compile-tier fallback"),
)
EXIT_PATH_LABELS = tuple(label for label, _token in EXIT_PATHS)

_NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}


def _ac7_text():
    """AC7's own paragraph, out of the CR. Read rather than restated, so the
    path set and the count below are the SPEC's and not this file's."""
    text = CR_PATH.read_text()
    start = text.index("- **AC7**")
    end = text.index("- **AC8**", start)
    return text[start:end]


def _ac7_stated_assertion_count():
    """The count AC7 states in words ("Four assertions, one per path"), as an
    int. Derived, so a CR that grew a fifth path fails this file rather than
    being silently under-asserted."""
    match = re.search(r"\b(" + "|".join(_NUMBER_WORDS) + r")\s+assertions\b",
                      _ac7_text(), re.IGNORECASE)
    assert match is not None, f"AC7 states no assertion count: {_ac7_text()!r}"
    return _NUMBER_WORDS[match.group(1).lower()]


def _tier_verb_clients():
    """The fleet, SCANNED: every `clients/*-crucible.py` that registers the six
    tier verbs through the shared registrar. Derived rather than frozen, so a
    sixth client cannot join the fleet without joining this file."""
    found = {}
    for path in sorted(CLIENTS_DIR.glob("*-crucible.py")):
        if "add_tier_verbs(" in path.read_text():
            found[path.name.split("-crucible.py")[0]] = path
    return found


# The tier VERB this file drives per client, and the verb that owns each
# client's compile ingest — both derived by reading the clients (see the
# matrix in the module docstring), recorded here so every drive below is built
# from one statement of the fact.
TIER_VERB_DRIVEN = {"bun": "regression", "python": "regression",
                    "mvn": "unit", "rust": "unit", "arduino": "unit"}
COMPILE_EXIT_VERB = {"bun": "test", "python": "regression", "mvn": "unit",
                     "rust": "unit", "arduino": "compile"}


# ── fixtures: junit payloads for the three RUN outcomes ────────────────────
#
# Two shapes, because the fleet's parsers differ: `<testsuites>` (bun's
# reporter, nextest) and a bare `<testsuite>` (xmlrunner, surefire, the native
# g++ harness). Cycle 378's one-pass fixtures are reused unchanged; the fail
# and zero shapes are their twins.
_JUNIT_SUITES_ONE_PASS = _MODALITY._JUNIT_SUITES_ONE_PASS
_JUNIT_SUITE_ONE_PASS = _MODALITY._JUNIT_SUITE_ONE_PASS

_JUNIT_SUITES_ONE_FAIL = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuites><testsuite name="tier.probe" tests="1" failures="1" errors="0">'
    '<testcase classname="tier.probe" name="probe" time="0.001">'
    '<failure message="probe failed">expected 1 to be 2</failure>'
    '</testcase></testsuite></testsuites>'
)
_JUNIT_SUITE_ONE_FAIL = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuite name="TierProbeTest" tests="1" failures="1" errors="0">'
    '<testcase classname="TierProbeTest" name="probe" time="0.001">'
    '<failure message="probe failed">expected 1 to be 2</failure>'
    '</testcase></testsuite>'
)
_JUNIT_SUITES_ZERO = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuites><testsuite name="tier.probe" tests="0" failures="0" errors="0">'
    '</testsuite></testsuites>'
)
_JUNIT_SUITE_ZERO = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<testsuite name="TierProbeTest" tests="0" failures="0" errors="0">'
    '</testsuite>'
)

# What python's runner prints when discovery matched nothing: "Ran 0 tests" and
# NO traceback — the exact pair `_is_zero_discovery` distinguishes an honest
# empty discovery from a collection failure by.
_PY_ZERO_DISCOVERY_OUTPUT = "\n----------------------------------------------------------------------\nRan 0 tests in 0.000s\n\nOK\n"

# The server answer for a run whose suite FAILED. rust's envelope reads its
# counts from the RESPONSE (`_emit_ingest_axi` in `rust-crucible.py`), not from
# a client-side parse, so a failing rust run needs the server to say so — this
# is the honest transcription of what the junit written above would parse to.
_FAILED_RESPONSE = {"ok": True,
                    "run": {"passed": 0, "failed": 1, "pending": 0, "total": 1}}
_EMPTY_RESPONSE = {"ok": True,
                   "run": {"passed": 0, "failed": 0, "pending": 0, "total": 0}}


# ── the one toolchain addition: a python runner that can be told what to say ─
#
# Cycle 379's `_PY_RUNNER_TAIL` prints a fixed collection failure when no junit
# content is set, so its no-XML drive can only ever reach the COMPILE branch.
# Python's zero-discovery branch needs the other capture, so the tail is
# re-spliced here to read `FAKE_PY_OUTPUT` (cycle 378's own spelling — the
# variable is already in the harness's env-reset list). Everything else in the
# bin dir is cycle 379's, byte for byte.
_PY_RUNNER_TAIL = """
argv = sys.argv[1:]
reports = argv[argv.index("-o") + 1] if "-o" in argv else None
content = os.environ.get("FAKE_PY_JUNIT_CONTENT", "")
if content and reports:
    os.makedirs(reports, exist_ok=True)
    with open(os.path.join(reports, "TEST-tier.probe.xml"), "w") as f:
        f.write(content)
    sys.exit(int(os.environ.get("FAKE_PY_EXIT_CODE", "0")))
sys.stdout.write(os.environ.get(
    "FAKE_PY_OUTPUT",
    "ModuleNotFoundError: No module named 'not_yet_written'\\n"))
sys.exit(int(os.environ.get("FAKE_PY_EXIT_CODE", "1")))
"""

_BIN_DIR = None
_SAVED_PATH = None
_SAVED_MODALITY_BIN = None


def setUpModule():
    global _BIN_DIR, _SAVED_PATH, _SAVED_MODALITY_BIN
    _BIN_DIR = tempfile.mkdtemp(prefix="cr111-envelope-bin-")
    tools = dict(_MODALITY._PATH_TOOLS)
    tools.update(_MODALITY._NAMED_TOOLS)
    tools["fake-python-runner"] = _PY_RUNNER_TAIL
    for name, tail in tools.items():
        path = Path(_BIN_DIR) / name
        body = (_MODALITY._RECORD
                .replace("__PYTHON__", sys.executable)
                .replace("__TOOL__", name))
        path.write_text(body + tail)
        path.chmod(0o755)
    _SAVED_PATH = os.environ.get("PATH", "")
    os.environ["PATH"] = _BIN_DIR + os.pathsep + _SAVED_PATH
    # The imported fixtures reach their named tools through the harness's own
    # `_fake()`, which reads THAT module's `_BIN_DIR`. Point it here for the
    # life of this module, and put it back afterwards.
    _SAVED_MODALITY_BIN = _MODALITY._BIN_DIR
    _MODALITY._BIN_DIR = _BIN_DIR


def tearDownModule():
    _MODALITY._BIN_DIR = _SAVED_MODALITY_BIN
    if _SAVED_PATH is not None:
        os.environ["PATH"] = _SAVED_PATH
    if _BIN_DIR:
        shutil.rmtree(_BIN_DIR, ignore_errors=True)


def _fake(name):
    return str(Path(_BIN_DIR) / name)


# ── the assertion every test in this file is built from ────────────────────


class _EnvelopeTierProbe:
    """AC7's assertion, once: the envelope's tier statement is READ from the
    structured field and COMPARED against what this same drive put on the wire.

    Deriving the expectation rather than freezing it is what makes the check a
    test of AGREEMENT: a client that hardcoded `tier: "unit"` on every envelope
    would pass a frozen expectation on one path and fail here on four."""

    def _ingested_test_bodies(self, drive):
        return [payload for path, payload in drive.calls
                if path in INGEST_ENDPOINTS and payload.get("agentId") == AGENT]

    def _ingested_compile_bodies(self, drive):
        return [payload for path, payload in drive.calls if path == COMPILE]

    def _expected_statement(self, drive, where):
        """What the envelope MUST say, derived from the POSTs this drive made.

        The four cases are the closed vocabulary's four, in the only order that
        is sound: a TEST ingest decides the answer whether or not a compile
        event also rode out, because a run that was ingested as a test run IS
        what the orchestrator is asking about."""
        tests = self._ingested_test_bodies(drive)
        if tests:
            stated = sorted({p["tier"] for p in tests if p.get("tier") is not None})
            self.assertLessEqual(
                len(stated), 1,
                f"{where}: this drive ingested the same run under more than one "
                f"tier ({stated!r}), so there is no single ingested tier for an "
                f"envelope to state. Bodies: {tests!r}")
            return stated[0] if stated else UNSTATED
        if self._ingested_compile_bodies(drive):
            return COMPILE_STATEMENT
        return NOTHING_INGESTED

    def statement(self, drive, where):
        """The envelope's tier statement, with the three ways of not making one
        rejected before the value is compared."""
        axi = self.envelope(drive)
        self.assertIn(
            ENVELOPE_TIER_FIELD, axi,
            f"AC7 — {where}: §S5 requires the envelope to name the tier of the "
            f"run it just ingested on EVERY exit path, so an orchestrator "
            f"'knows what was covered without inspecting the board'. This "
            f"envelope carries no {ENVELOPE_TIER_FIELD!r} field at all: "
            f"{axi!r}")
        stated = axi[ENVELOPE_TIER_FIELD]
        self.assertIsNotNone(
            stated,
            f"AC7 — {where}: a null tier is not a statement. A run that stated "
            f"no tier says so with {UNSTATED!r}; a run that ingested nothing "
            f"says {NOTHING_INGESTED!r}. envelope={axi!r}")
        self.assertNotIn(
            str(stated), ("None", "null", ""),
            f"AC7 — {where}: the envelope surfaced an empty tier ({stated!r}) "
            f"where it must carry a value from the closed vocabulary "
            f"{sorted(TIER_VOCABULARY) + sorted(SENTINELS)!r}. envelope={axi!r}")
        self.assertIn(
            stated, set(TIER_VOCABULARY) | set(SENTINELS),
            f"AC7 — {where}: {stated!r} is not one of the six Tier values and "
            f"not one of the three sentinels "
            f"{sorted(SENTINELS)!r}; a consumer cannot match on an open "
            f"vocabulary. envelope={axi!r}")
        return stated

    def assertEnvelopeStatesIngestedTier(self, drive, where):
        expected = self._expected_statement(drive, where)
        stated = self.statement(drive, where)
        self.assertEqual(
            stated, expected,
            f"AC7 — {where}: the envelope says the run was ingested as "
            f"{stated!r}, but the POST bodies this drive actually sent say "
            f"{expected!r}. test ingests="
            f"{[p.get('tier') for p in self._ingested_test_bodies(drive)]!r} "
            f"compile ingests={len(self._ingested_compile_bodies(drive))} "
            f"endpoints={[p for p, _ in drive.calls]!r}")
        return stated

    # ── non-vacuity: each drive really reached the path it claims ──────────

    def run_block(self, drive):
        return self.envelope(drive).get("run") or {}

    def assertReachedSuccess(self, drive, where):
        run = self.run_block(drive)
        self.assertEqual(
            (run.get("total"), run.get("failed")), (1, 0),
            f"{where}: this drive was meant to reach the SUCCESS exit — one "
            f"passing test, ingested. envelope={self.envelope(drive)!r} "
            f"exit={drive.code} stderr={drive.err[-800:]!r}")

    def assertReachedFailingSuite(self, drive, where):
        run = self.run_block(drive)
        self.assertEqual(
            run.get("failed"), 1,
            f"{where}: this drive was meant to reach the FAILING-SUITE exit — "
            f"the tests ran, one failed, and the run was still ingested, which "
            f"is exactly when an orchestrator most needs to know what was "
            f"covered. envelope={self.envelope(drive)!r} exit={drive.code} "
            f"stderr={drive.err[-800:]!r}")
        self.assertTrue(
            self._ingested_test_bodies(drive),
            f"{where}: a failing suite is still an INGESTED run; this drive "
            f"posted {[p for p, _ in drive.calls]!r}")

    def assertReachedZeroDiscovery(self, drive, where):
        run = self.run_block(drive)
        warnings = {w.get("code") for w in (self.envelope(drive).get("warnings") or [])
                    if isinstance(w, dict)}
        found_nothing = (run.get("total") == 0
                         or "no-tests-discovered" in warnings)
        self.assertTrue(
            found_nothing,
            f"{where}: this drive was meant to reach the ZERO-DISCOVERY exit — "
            f"the runner found no tests. envelope={self.envelope(drive)!r} "
            f"exit={drive.code} stderr={drive.err[-800:]!r}")

    def assertReachedCompileIngest(self, drive, where):
        self.assertTrue(
            self._ingested_compile_bodies(drive),
            f"{where}: this drive was meant to reach the COMPILE exit — no "
            f"report produced, the captured output ingested to {COMPILE}. It "
            f"posted {[p for p, _ in drive.calls]!r}; exit={drive.code} "
            f"stderr={drive.err[-1200:]!r}")

    def assertStatesCompileAndNotATestTier(self, drive, where):
        """AC13a's rule, carried onto the envelope: "a build is not a test
        tier, and conflating them would put a compile in the test record"."""
        stated = self.statement(drive, where)
        self.assertNotIn(
            stated, TIER_VOCABULARY,
            f"AC13a/AC7 — {where}: this exit ingested a COMPILE event, so the "
            f"envelope must never name a TEST tier; it says {stated!r}. "
            f"(test tiers: {sorted(TIER_VOCABULARY)!r})")
        self.assertEqual(
            stated, COMPILE_STATEMENT,
            f"AC7 — {where}: the compile-tier fallback states the COMPILE "
            f"nature of what it ingested ({COMPILE_STATEMENT!r}); it says "
            f"{stated!r}")

    def assertClaimsNothingWasIngested(self, drive, where):
        """The NEGATIVE bound for an exit that ingested nothing — and it is
        deliberately weaker than `assertEnvelopeStatesIngestedTier`.

        AC7 enumerates FOUR paths and this is not one of them, so requiring the
        new field here would be asserting past the AC. What IS required is the
        half AC7 exists to protect: an exit that ran nothing and posted nothing
        may never name a tier, because a verb that did no work reading on the
        board like a verb that ran is the defect this whole CR removes — and
        moving it from the wire to the envelope would not be removing it. If
        the field IS present it must make the honest statement."""
        posted = [p for p, _ in drive.calls
                  if p in INGEST_ENDPOINTS or p == COMPILE]
        self.assertEqual(
            posted, [],
            f"{where}: this exit is meant to ingest NOTHING, so the premise of "
            f"this assertion is gone if it posted {posted!r}")
        axi = self.envelope(drive)
        if ENVELOPE_TIER_FIELD not in axi:
            return
        stated = axi[ENVELOPE_TIER_FIELD]
        self.assertNotIn(
            stated, TIER_VOCABULARY,
            f"AC7 — {where}: this exit ran nothing and ingested nothing, so it "
            f"may not report an ingested tier; it claims {stated!r}. A verb "
            f"that did no work reporting coverage is the defect this CR "
            f"exists to remove, one channel over.")
        self.assertEqual(
            stated, NOTHING_INGESTED,
            f"AC7 — {where}: nothing was ingested, and the honest statement of "
            f"that is {NOTHING_INGESTED!r}; it says {stated!r}")


# ── per-client drives ──────────────────────────────────────────────────────


class BunIngestedTierEnvelopeTest(_EnvelopeTierProbe, _MODALITY._BunModalityCase):
    """AC7 in bun. The tier verb driven is `regression` — bun's ONE wired cell
    (`bun test` splits no tiers, so §S3 makes the other five declared).

    RED — `bun-crucible.py` emits no tier on any envelope.

    THE COMPILE ROW IS DRIVEN ON `test`, NOT ON THE TIER VERB, and the reason
    is a real asymmetry in this client: `cmd_regression`'s no-JUnit exit
    ingests NOTHING ("no JUnit XML, nothing to ingest"), while `cmd_test`'s
    runs the synthetic-TS0000 compile ingest AC7 calls the compile-tier
    fallback. See ESCALATION 3."""

    def bun_tier_argv(self):
        return self.bun_argv(TIER_VERB_DRIVEN["bun"])

    def test_a_successful_tiered_run_states_the_tier_it_ingested(self):
        where = "bun regression / success"
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_PASS
        drive = self.drive(self.bun_tier_argv())
        self.assertVerbAcceptedTheInvocation(drive, where)
        self.assertReachedSuccess(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_failing_suite_still_states_the_tier_it_ingested(self):
        where = "bun regression / failing suite"
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_FAIL
        os.environ["FAKE_BUN_EXIT_CODE"] = "1"
        drive = self.drive(self.bun_tier_argv())
        self.assertReachedFailingSuite(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_zero_discovery_run_states_what_it_ingested(self):
        where = "bun regression / zero-discovery"
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ZERO
        drive = self.drive(self.bun_tier_argv())
        self.assertReachedZeroDiscovery(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_the_compile_fallback_states_compile_and_not_a_test_tier(self):
        where = "bun test / compile fallback"
        drive = self.drive(self.bun_argv(COMPILE_EXIT_VERB["bun"]))
        self.assertReachedCompileIngest(drive, where)
        self.assertStatesCompileAndNotATestTier(drive, where)

    def test_the_no_report_exit_claims_nothing_was_ingested(self):
        """PIN — NOT one of AC7's four, and not counted as one. bun's tier verb
        has an exit its siblings do not: the runner produced no JUnit and this
        client ingests nothing at all there. It must not report coverage it
        never obtained."""
        where = "bun regression / no report, nothing ingested"
        drive = self.drive(self.bun_tier_argv())
        self.assertClaimsNothingWasIngested(drive, where)


class PythonIngestedTierEnvelopeTest(_EnvelopeTierProbe,
                                     _MODALITY._PythonModalityCase):
    """AC7 in python. The tier verb driven is `regression` — python's ONE wired
    cell (`unittest` discovery splits no tiers).

    RED — `python-crucible.py` emits no tier on any envelope.

    This is the one client with a REAL zero-discovery branch
    (`_is_zero_discovery`): "Ran 0 tests" with no traceback answers
    `no-tests-discovered` and ingests NOTHING, so its zero-discovery envelope
    is the only one in the fleet whose honest statement is "none"."""

    def py_tier_argv(self, verb=None, extra=()):
        return self.py_argv(verb or TIER_VERB_DRIVEN["python"],
                            ["--agent", AGENT, "--reports", "reports",
                             "--python", _fake("fake-python-runner"),
                             "--start-dir", "tests",
                             "--pattern", "test_*.py"] + list(extra))

    def test_a_successful_tiered_run_states_the_tier_it_ingested(self):
        where = "python regression / success"
        os.environ["FAKE_PY_JUNIT_CONTENT"] = _JUNIT_SUITE_ONE_PASS
        drive = self.drive(self.py_tier_argv())
        self.assertVerbAcceptedTheInvocation(drive, where)
        self.assertReachedSuccess(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_failing_suite_still_states_the_tier_it_ingested(self):
        where = "python regression / failing suite"
        os.environ["FAKE_PY_JUNIT_CONTENT"] = _JUNIT_SUITE_ONE_FAIL
        os.environ["FAKE_PY_EXIT_CODE"] = "1"
        drive = self.drive(self.py_tier_argv())
        self.assertReachedFailingSuite(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_zero_discovery_run_states_what_it_ingested(self):
        where = "python regression / zero-discovery"
        os.environ["FAKE_PY_OUTPUT"] = _PY_ZERO_DISCOVERY_OUTPUT
        os.environ["FAKE_PY_EXIT_CODE"] = "0"
        drive = self.drive(self.py_tier_argv())
        self.assertReachedZeroDiscovery(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_the_compile_fallback_states_compile_and_not_a_test_tier(self):
        where = "python regression / compile fallback"
        drive = self.drive(self.py_tier_argv(COMPILE_EXIT_VERB["python"]))
        self.assertReachedCompileIngest(drive, where)
        self.assertStatesCompileAndNotATestTier(drive, where)


class MvnIngestedTierEnvelopeTest(_EnvelopeTierProbe, _MODALITY._MvnModalityCase):
    """AC7 in maven. The tier verb driven is `unit` — maven's own surefire
    split, §S3's reference cell.

    RED — `mvn-crucible.py` emits no tier on any envelope. Its compile
    fallback ALREADY carries `stage: "compile"`, which is the shape the ruled
    `tier` field joins rather than replaces: `stage` says which half of the
    verb answered, the tier says what reached the board."""

    def write_zero_report(self):
        directory = Path(self.tmpdir, "target", "surefire-reports")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "TEST-Probe.xml").write_text(_JUNIT_SUITE_ZERO)
        return str(directory)

    def write_failing_report(self):
        directory = Path(self.tmpdir, "target", "surefire-reports")
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "TEST-Probe.xml").write_text(_JUNIT_SUITE_ONE_FAIL)
        return str(directory)

    def test_a_successful_tiered_run_states_the_tier_it_ingested(self):
        where = "mvn unit / success"
        self.write_reports()
        drive = self.drive(self.mvn_argv(TIER_VERB_DRIVEN["mvn"]))
        self.assertVerbAcceptedTheInvocation(drive, where)
        self.assertReachedSuccess(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_failing_suite_still_states_the_tier_it_ingested(self):
        where = "mvn unit / failing suite"
        self.write_failing_report()
        os.environ["FAKE_MVN_EXIT_CODE"] = "1"
        drive = self.drive(self.mvn_argv(TIER_VERB_DRIVEN["mvn"]))
        self.assertReachedFailingSuite(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_zero_discovery_run_states_what_it_ingested(self):
        where = "mvn unit / zero-discovery"
        self.write_zero_report()
        drive = self.drive(self.mvn_argv(TIER_VERB_DRIVEN["mvn"]))
        self.assertReachedZeroDiscovery(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_the_compile_fallback_states_compile_and_not_a_test_tier(self):
        where = "mvn unit / compile fallback"
        os.environ["FAKE_MVN_EXIT_CODE"] = "1"
        drive = self.drive(self.mvn_argv(COMPILE_EXIT_VERB["mvn"]))
        self.assertReachedCompileIngest(drive, where)
        self.assertStatesCompileAndNotATestTier(drive, where)


class RustIngestedTierEnvelopeTest(_EnvelopeTierProbe, _MODALITY._RustModalityCase):
    """AC7 in cargo. The tier verb driven is `unit` — cargo's own `--lib`
    target (cycle 379's §S3 wiring).

    RED — `rust-crucible.py` emits no tier on any envelope. This client's
    envelope counts come from the SERVER response rather than a client-side
    parse, so the failing and empty drives supply the response the junit they
    wrote would parse to; the tier statement itself is still read off the
    envelope and compared against the POST body."""

    def write_junit(self, content, profile="ci"):
        directory = Path(self.tmpdir, "target", "nextest", profile)
        directory.mkdir(parents=True, exist_ok=True)
        junit = directory / "junit.xml"
        junit.write_text(content)
        return str(junit)

    def test_a_successful_tiered_run_states_the_tier_it_ingested(self):
        where = "rust unit / success"
        self.write_junit(_JUNIT_SUITES_ONE_PASS)
        drive = self.drive(self.rust_argv(TIER_VERB_DRIVEN["rust"]))
        self.assertVerbAcceptedTheInvocation(drive, where)
        self.assertReachedSuccess(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_failing_suite_still_states_the_tier_it_ingested(self):
        where = "rust unit / failing suite"
        self.write_junit(_JUNIT_SUITES_ONE_FAIL)
        os.environ["FAKE_CARGO_EXIT_CODE"] = "100"
        drive = self.drive(self.rust_argv(TIER_VERB_DRIVEN["rust"]),
                           response=_FAILED_RESPONSE)
        self.assertReachedFailingSuite(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_zero_discovery_run_states_what_it_ingested(self):
        where = "rust unit / zero-discovery"
        self.write_junit(_JUNIT_SUITES_ZERO)
        drive = self.drive(self.rust_argv(TIER_VERB_DRIVEN["rust"]),
                           response=_EMPTY_RESPONSE)
        self.assertReachedZeroDiscovery(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_the_compile_fallback_states_compile_and_not_a_test_tier(self):
        where = "rust unit / compile fallback"
        os.environ["FAKE_CARGO_EXIT_CODE"] = "101"
        drive = self.drive(self.rust_argv(COMPILE_EXIT_VERB["rust"]))
        self.assertReachedCompileIngest(drive, where)
        self.assertStatesCompileAndNotATestTier(drive, where)


class ArduinoIngestedTierEnvelopeTest(_EnvelopeTierProbe,
                                      _MODALITY._ArduinoModalityCase):
    """AC7 in arduino. The tier verb driven is `unit` — the native host
    `make junit` build, arduino's one split cell.

    RED — `arduino-crucible.py` emits no tier on any envelope.

    THE COMPILE ROW IS DRIVEN ON `compile`, NOT ON THE TIER VERB, and this
    client has no compile FALLBACK at all: a native run that produces no
    reports emits an `ok:false` no-report envelope and ingests nothing
    (`arduino-crucible.py:538`). Its compile ingest is a first-class verb — the
    `arduino-cli` target build — and AC13a's rule is fleet-wide, so that is
    where the compile statement is asserted. See ESCALATION 3."""

    def write_native(self, content, name="TEST-probe.xml"):
        reports = Path(self.native_dir(), "reports")
        reports.mkdir(parents=True, exist_ok=True)
        (reports / name).write_text(content)
        return str(reports)

    def unit_argv(self):
        return self.arduino_argv(TIER_VERB_DRIVEN["arduino"],
                                 ["--dir", self.NATIVE_DIR])

    def test_a_successful_tiered_run_states_the_tier_it_ingested(self):
        where = "arduino unit / success"
        self.write_native(_JUNIT_SUITE_ONE_PASS)
        drive = self.drive(self.unit_argv())
        self.assertVerbAcceptedTheInvocation(drive, where)
        self.assertReachedSuccess(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_failing_suite_still_states_the_tier_it_ingested(self):
        where = "arduino unit / failing suite"
        self.write_native(_JUNIT_SUITE_ONE_FAIL)
        os.environ["FAKE_MAKE_EXIT_CODE"] = "2"
        drive = self.drive(self.unit_argv())
        self.assertReachedFailingSuite(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_a_zero_discovery_run_states_what_it_ingested(self):
        where = "arduino unit / zero-discovery"
        self.write_native(_JUNIT_SUITE_ZERO)
        drive = self.drive(self.unit_argv())
        self.assertReachedZeroDiscovery(drive, where)
        self.assertEnvelopeStatesIngestedTier(drive, where)

    def test_the_compile_fallback_states_compile_and_not_a_test_tier(self):
        where = "arduino compile / compile ingest"
        with mock.patch.object(self.module, "ARDUINO_CLI",
                               _fake("fake-arduino-cli")):
            drive = self.drive(self.arduino_argv(COMPILE_EXIT_VERB["arduino"]))
        self.assertReachedCompileIngest(drive, where)
        self.assertStatesCompileAndNotATestTier(drive, where)

    def test_the_no_report_exit_claims_nothing_was_ingested(self):
        """PIN — NOT one of AC7's four, and not counted as one. arduino's tier
        verb produced no reports, so it ingested nothing; it must not report
        coverage it never obtained."""
        where = "arduino unit / no report, nothing ingested"
        os.makedirs(self.native_dir(), exist_ok=True)
        drive = self.drive(self.unit_argv())
        self.assertClaimsNothingWasIngested(drive, where)


_EXIT_PATH_CASES = (BunIngestedTierEnvelopeTest, PythonIngestedTierEnvelopeTest,
                    MvnIngestedTierEnvelopeTest, RustIngestedTierEnvelopeTest,
                    ArduinoIngestedTierEnvelopeTest)

# Every (client, path) cell this file drives, attached to the method that
# drives it — the same `.cell` idiom cycle 379 uses, so `ExitPathCoverageTest`
# derives its coverage instead of restating it.
for _case, _client in zip(_EXIT_PATH_CASES,
                          ("bun", "python", "mvn", "rust", "arduino")):
    _case.test_a_successful_tiered_run_states_the_tier_it_ingested.exit_path = (
        _client, "success")
    _case.test_a_failing_suite_still_states_the_tier_it_ingested.exit_path = (
        _client, "failing-suite")
    _case.test_a_zero_discovery_run_states_what_it_ingested.exit_path = (
        _client, "zero-discovery")
    _case.test_the_compile_fallback_states_compile_and_not_a_test_tier.exit_path = (
        _client, "compile-fallback")
# The loop variables are DELETED rather than left bound: a module-level name
# still holding a TestCase subclass is collected a second time under that name
# (measured — pytest reports the whole class again as `_case`), which
# double-counts every drive above and makes the suite's own totals lie.
del _case, _client


# ── the honest tier-less envelope (ESCALATION 1) ───────────────────────────


class _TierLessProbe(_EnvelopeTierProbe):
    """§S2/AC3's consequence, carried onto the envelope: after cycle 378 a bare
    `test` and an `auto-ingest` send NO tier, and `src/store.ts` applies its own
    `?? "unit"` default. The envelope must state that the client asserted
    nothing — not echo the server's default, not print a null, not omit the
    field. "What changes is WHO asserts" (the CR's Risk section); an envelope
    that re-asserted `unit` here would put the removed claim straight back."""

    def tier_less_drives(self):
        """`{label: (argv, fixture_fn)}` for this client's two tier-less
        ingesting verbs."""
        raise NotImplementedError

    def assertTierLessEnvelopeIsHonest(self):
        for label, (argv, fixture) in self.tier_less_drives().items():
            with self.subTest(drive=label):
                fixture()
                drive = self.drive(argv)
                where = f"{self.CLIENT} {label} / tier-less"
                bodies = self._ingested_test_bodies(drive)
                self.assertTrue(
                    bodies,
                    f"{where}: the drive ingested no test run, so there is no "
                    f"tier-less ingest to read. posted="
                    f"{[p for p, _ in drive.calls]!r} exit={drive.code} "
                    f"stderr={drive.err[-800:]!r}")
                self.assertEqual(
                    [b.get("tier") for b in bodies], [None] * len(bodies),
                    f"{where}: AC3 makes this verb send no tier; if it sends "
                    f"one this probe is measuring the wrong thing. "
                    f"bodies={bodies!r}")
                stated = self.statement(drive, where)
                self.assertNotIn(
                    stated, TIER_VOCABULARY,
                    f"AC7/AC3 — {where}: the client sent NO tier on this "
                    f"ingest, so the envelope may not name one of the six "
                    f"({stated!r}). Echoing the server's own `?? \"unit\"` "
                    f"default would restore, on the envelope, exactly the "
                    f"unearned claim §S2 removed from the wire.")
                self.assertEqual(
                    stated, UNSTATED,
                    f"AC7 — {where}: a run ingested with no stated tier says "
                    f"so with {UNSTATED!r} (ESCALATION 1); it says {stated!r}")


class TierLessEnvelopeIsHonestTest(unittest.TestCase):
    """The coverage bound for the tier-less rule: it is asserted in every
    client of the fleet, derived, never in one."""

    def test_every_client_in_the_fleet_is_probed_for_the_tier_less_envelope(self):
        """PIN — the instrument. Rule 15: "the envelope is honest about a
        tier-less run" is satisfiable by one client."""
        probed = {case.CLIENT for case in _TIER_LESS_CASES}
        self.assertEqual(
            probed, set(_tier_verb_clients()),
            f"every client registering tier verbs must be probed for the "
            f"tier-less envelope; scanned {sorted(_tier_verb_clients())!r}, "
            f"probed {sorted(probed)!r}")


class BunTierLessEnvelopeTest(_TierLessProbe, _MODALITY._BunModalityCase):
    """RED — bun states nothing at all on either envelope."""

    def write_junit(self):
        reports_dir = self.module._reports_dir(self.tmpdir, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        Path(self.module._junit_path(reports_dir)).write_text(
            _JUNIT_SUITES_ONE_PASS)

    def tier_less_drives(self):
        def via_runner():
            os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_PASS

        return {
            "test": (self.bun_argv("test"), via_runner),
            "auto-ingest": (["auto-ingest", "--agent", AGENT,
                             "--project-dir", self.tmpdir,
                             "--package-dir", self.tmpdir,
                             "--reports", "reports"], self.write_junit),
        }

    def test_a_tier_less_run_states_no_tier_it_did_not_send(self):
        self.assertTierLessEnvelopeIsHonest()


class PythonTierLessEnvelopeTest(_TierLessProbe, _MODALITY._PythonModalityCase):
    """RED — python states nothing at all on either envelope."""

    def write_reports(self):
        reports_dir = self.module._reports_dir(self.tmpdir, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        Path(reports_dir, "TEST-tier.probe.xml").write_text(_JUNIT_SUITE_ONE_PASS)

    def tier_less_drives(self):
        def via_runner():
            os.environ["FAKE_PY_JUNIT_CONTENT"] = _JUNIT_SUITE_ONE_PASS

        base = ["--agent", AGENT, "--project-dir", self.tmpdir,
                "--reports", "reports"]
        return {
            "test": (["test"] + base + ["--tests", "tests.probe",
                                        "--python", _fake("fake-python-runner")],
                     via_runner),
            "auto-ingest": (["auto-ingest"] + base, self.write_reports),
        }

    def test_a_tier_less_run_states_no_tier_it_did_not_send(self):
        self.assertTierLessEnvelopeIsHonest()


class MvnTierLessEnvelopeTest(_TierLessProbe, _MODALITY._MvnModalityCase):
    """RED — maven states nothing at all on either envelope."""

    def tier_less_drives(self):
        return {
            "test": (self.mvn_argv("test"), self.write_reports),
            "auto-ingest": (self.mvn_argv("auto-ingest"), self.write_reports),
        }

    def test_a_tier_less_run_states_no_tier_it_did_not_send(self):
        self.assertTierLessEnvelopeIsHonest()


class RustTierLessEnvelopeTest(_TierLessProbe, _MODALITY._RustModalityCase):
    """RED — cargo states nothing at all on either envelope."""

    def tier_less_drives(self):
        # `--crate` is REQUIRED on this client's two untiered verbs and
        # optional on its tier verbs (cycle 379: "a tier verb never fails on
        # argparse where cargo itself would have run"), so the tier-less
        # drives carry it and the tiered ones above do not.
        crate = ["--crate", self.CRATE]
        return {
            "test": (self.rust_argv("test", crate), self.write_nextest_junit),
            "auto-ingest": (self.rust_argv("auto-ingest", crate),
                            self.write_nextest_junit),
        }

    def test_a_tier_less_run_states_no_tier_it_did_not_send(self):
        self.assertTierLessEnvelopeIsHonest()


class ArduinoTierLessEnvelopeTest(_TierLessProbe, _MODALITY._ArduinoModalityCase):
    """RED — arduino states nothing at all on either envelope. Note the CR's own
    correction (AC13): every run this client RUNS already carries its tier on
    the WIRE; what is missing is the envelope saying so, and — on `test` and
    `auto-ingest`, after cycle 378 — saying honestly that it carries none."""

    def tier_less_drives(self):
        return {
            "test": (self.arduino_argv("test", ["--dir", self.NATIVE_DIR]),
                     self.write_native_reports),
            "auto-ingest": (self.arduino_argv("auto-ingest",
                                              ["--dir", self.NATIVE_DIR]),
                            self.write_native_reports),
        }

    def test_a_tier_less_run_states_no_tier_it_did_not_send(self):
        self.assertTierLessEnvelopeIsHonest()


_TIER_LESS_CASES = (BunTierLessEnvelopeTest, PythonTierLessEnvelopeTest,
                    MvnTierLessEnvelopeTest, RustTierLessEnvelopeTest,
                    ArduinoTierLessEnvelopeTest)


# ── §S1's refusal ingested nothing, so it claims nothing ───────────────────


class TierRunUndeclaredClaimsNothingTest(unittest.TestCase):
    """Cycle 379's `tier-run-undeclared` refusal runs nothing and ingests
    nothing. It is NOT one of AC7's four paths and is excluded from the matrix
    count — but the field AC7 adds must not appear on it naming a tier, or a
    verb that refused would read on the board like a verb that ran.

    PIN — passes today because nothing states a tier anywhere. Its job starts
    at GREEN."""

    def test_every_client_with_an_undeclared_cell_is_probed_here(self):
        """PIN — the instrument, derived: every client that registers tier verbs
        has at least one cell §S3 leaves declared, and each must be probed."""
        probed = {case.CLIENT for case in _REFUSAL_CASES}
        self.assertEqual(
            probed, set(_tier_verb_clients()),
            f"scanned {sorted(_tier_verb_clients())!r}, probed "
            f"{sorted(probed)!r}")


class _RefusalProbe(_EnvelopeTierProbe):

    UNDECLARED_CELL = "bdd"

    def refusal_argv(self):
        raise NotImplementedError

    def test_a_refused_tier_reports_no_ingested_tier(self):
        drive = self.drive(self.refusal_argv())
        where = f"{self.CLIENT} {self.UNDECLARED_CELL} / tier-run-undeclared"
        self.assertTrue(
            self.refused_for_no_declaration(drive),
            f"{where}: this probe needs the §S1 refusal; the drive did not "
            f"answer {TIER_RUN_UNDECLARED_CODE}. exit={drive.code} "
            f"stderr={drive.err[-800:]!r}")
        self.assertClaimsNothingWasIngested(drive, where)


class BunRefusalClaimsNothingTest(_RefusalProbe, _MODALITY._BunModalityCase):
    def refusal_argv(self):
        return self.bun_argv(self.UNDECLARED_CELL, with_bun=False)


class PythonRefusalClaimsNothingTest(_RefusalProbe, _MODALITY._PythonModalityCase):
    def refusal_argv(self):
        return self.py_argv(self.UNDECLARED_CELL)


class MvnRefusalClaimsNothingTest(_RefusalProbe, _MODALITY._MvnModalityCase):
    def refusal_argv(self):
        return [self.UNDECLARED_CELL, "--project-dir", self.tmpdir,
                "--maven-dir", self.tmpdir]


class RustRefusalClaimsNothingTest(_RefusalProbe, _MODALITY._RustModalityCase):
    UNDECLARED_CELL = "module"

    def refusal_argv(self):
        return [self.UNDECLARED_CELL, "--project-dir", self.tmpdir]


class ArduinoRefusalClaimsNothingTest(_RefusalProbe, _MODALITY._ArduinoModalityCase):
    def refusal_argv(self):
        return [self.UNDECLARED_CELL, "--project-dir", self.tmpdir]


_REFUSAL_CASES = (BunRefusalClaimsNothingTest, PythonRefusalClaimsNothingTest,
                  MvnRefusalClaimsNothingTest, RustRefusalClaimsNothingTest,
                  ArduinoRefusalClaimsNothingTest)


# ── the counts, DERIVED ────────────────────────────────────────────────────


class ExitPathCoverageTest(unittest.TestCase):
    """AC7's counts, both of them, derived — never frozen.

    Rule 15's lesson from this CR, applied twice over: AC7 is written as "the
    envelope" and "four assertions", and both phrasings are satisfiable once
    and shippable. The client count is SCANNED out of `clients/`, the path
    count is READ OUT OF AC7's own text, and the product is compared against
    the cells this file actually drives.

    PIN — the instrument, not the subject."""

    def _driven(self):
        driven = {}
        for case in _EXIT_PATH_CASES:
            for name in dir(case):
                if not name.startswith("test_"):
                    continue
                cell = getattr(getattr(case, name), "exit_path", None)
                if cell is not None:
                    driven.setdefault(cell, []).append(f"{case.__name__}.{name}")
        return driven

    def test_every_client_and_every_exit_path_is_driven_by_this_file(self):
        clients = set(_tier_verb_clients())
        expected = {(client, path) for client in clients
                    for path in EXIT_PATH_LABELS}
        driven = set(self._driven())
        self.assertEqual(
            driven, expected,
            f"AC7 is per EXIT PATH and — rule 15 — per CLIENT. The fleet "
            f"scanned from clients/ is {sorted(clients)!r} and AC7's paths are "
            f"{list(EXIT_PATH_LABELS)!r}, so {len(expected)} cells must be "
            f"driven; this file drives {len(driven)}. "
            f"missing={sorted(expected - driven)!r} "
            f"extra={sorted(driven - expected)!r}")

    def test_no_exit_path_cell_is_driven_twice_over(self):
        """A cell claimed by two methods would let the coverage set look full 
        while another cell went missing — the count must be a partition."""
        duplicated = {cell: names for cell, names in self._driven().items()
                      if len(names) > 1}
        self.assertEqual(
            duplicated, {},
            f"each (client, exit path) cell is driven exactly once: "
            f"{duplicated!r}")

    def test_the_asserted_cell_count_spans_the_whole_fleet(self):
        driven = set(self._driven())
        clients = {client for client, _path in driven}
        paths = {path for _client, path in driven}
        self.assertEqual(
            len(driven), len(clients) * len(paths),
            f"the matrix must be complete: {len(clients)} clients x "
            f"{len(paths)} paths != {len(driven)} cells driven")
        self.assertGreater(
            len(clients), 1,
            "AC7 collapsed to one client would be unfalsifiable — the defect "
            "rule 15 exists to catch")
        self.assertGreater(
            len(paths), 1,
            "AC7 collapsed to one exit path would be the 'happy path only' "
            "defect §S5 names by listing four")


class Ac7PathCountTest(unittest.TestCase):
    """The four paths this file names are AC7's four, read out of the CR.

    PIN — the instrument. It fails if the CR grows or renames a path, which is
    the only way this file's notion of "every exit path" could go stale."""

    def test_every_path_this_file_drives_is_named_by_ac7(self):
        text = _ac7_text()
        for label, token in EXIT_PATHS:
            self.assertIn(
                token, text,
                f"this file drives an exit path ({label!r}) AC7 does not name "
                f"({token!r}): {text!r}")

    def test_the_path_count_is_the_one_ac7_states(self):
        self.assertEqual(
            len(EXIT_PATHS), _ac7_stated_assertion_count(),
            f"AC7 states {_ac7_stated_assertion_count()} assertions, one per "
            f"path; this file names {len(EXIT_PATHS)}: "
            f"{list(EXIT_PATH_LABELS)!r}")


class FleetOneDefinitionTest(unittest.TestCase):
    """Rule 15's "one definition" bound, the same one cycle 380 put on the
    wall-vs-CPU warning code: the envelope's tier vocabulary lives in
    `clients/_crucible_axi.py` beside `TIER_MEANINGS` and
    `TIER_RUN_UNDECLARED_CODE`, not five times over.

    RED — none of the three constants exists today."""

    def test_the_shared_module_names_the_envelope_tier_vocabulary(self):
        for const, expected in ((UNSTATED_CONST, "unstated"),
                                (COMPILE_CONST, "compile"),
                                (NOTHING_CONST, "none")):
            with self.subTest(constant=const):
                self.assertTrue(
                    hasattr(_AXI, const),
                    f"AC7 — `clients/_crucible_axi.py` must expose {const!r}: "
                    f"the envelope's tier statement is a CLOSED vocabulary and "
                    f"a consumer matches on its values, so five clients "
                    f"spelling their own sentinel is the second mirror AC10 "
                    f"forbids. (AC4's precedent: the name is fixed in the spec "
                    f"so the AC fails on a defect, not on a disagreement.)")
                self.assertEqual(
                    getattr(_AXI, const), expected,
                    f"{const} must be {expected!r}")


if __name__ == "__main__":
    unittest.main()
