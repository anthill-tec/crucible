"""CR-CRU-111 §S2 — a run stops claiming a tier it did not earn (AC3), and no
COMPILE ingest carries a test tier (AC13a).

AC15 joined them at cycle 385 — the guard's own instrument, widened to every
spelling a tier can be stated in, with the widening PROVEN against planted
fixtures rather than asserted (see "AC15, at cycle 385" below).

Three acceptance criteria live here; the first two are cycle 378's. Both
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

AC15, at cycle 385 — "the AC3 census guard sees EVERY spelling a tier can be
stated in: keyword, positional, dict key and subscript … a planted unearned
stamp in EACH of the four spellings must make the guard fail". What VERIFY
measured: `_tier_literal_sites` matched `kw.arg == "tier"` and nothing else, so
`arduino-crucible.py` contributed ZERO rows to a census whose own table names
it in five cells — the client where AC3's two hardest sites lived — and a
re-introduced positional or dict-key stamp passed the guard green. §S2 had
already written the diagnosis down ("a census is only as wide as its
instrument") and the guard enforcing it repeated the mistake anyway.

  RED  `CensusInstrumentSeesEverySpellingTest` — the positional, dict-key and
         subscript proofs. Against the keyword-only instrument the guard they
         require to FAIL passes instead; only the keyword proof can pass. The
         narrow instrument is KEPT in this file, as
         `_keyword_only_tier_literal_sites`, and
         `test_the_keyword_only_instrument_is_blind_to_three_of_the_four_spellings`
         runs it over the same four planted clients — so the widening is
         demonstrated, not claimed.
  PIN  `ArduinoUnearnedTierTest`, `ArduinoEarnedTierTest`,
         `RustEarnedTierTest` — five tier statements driven on the wire for
         the first time, in the two spellings the old instrument could not
         see. They pass today; what was missing was any test at all.
         `test_arduino_pre_merge_gate_inherits_the_tier_of_the_run_it_drives`
         is §S6's gate ruling on the wire, and the reason
         `GATE_TIER_RULINGS` may exist without becoming an unexamined
         exemption.
  PIN  `test_every_site_the_widening_revealed_is_driven_on_the_wire` — the
         coverage bound the narrow instrument made unstatable, derived by
         running BOTH instruments over the five clients and requiring every
         newly visible site to be asserted on a POST body here.

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


# AC15's four spellings, named once and used as the instrument's own
# vocabulary — "keyword (`tier="unit"`), positional (`_run_native_tests(args,
# "test", "unit", …)`), dict key (`"tier": "unit"`) and subscript
# (`payload["tier"] = …`, which rust now uses)".
KEYWORD, POSITIONAL, DICT_KEY, SUBSCRIPT = (
    "keyword", "positional", "dict-key", "subscript")
SPELLINGS = (KEYWORD, POSITIONAL, DICT_KEY, SUBSCRIPT)


def _tier_parameter_positions(tree):
    """`{callee name: index of its `tier` parameter}` for every function DEFINED
    in this module.

    This is what makes the POSITIONAL spelling readable without guessing. A
    scanner that treated any string literal equal to a tier value as a tier
    statement would read `sub.add_parser("unit", ...)` — every verb
    registration in the fleet — as a stamp. Resolving the literal to the
    PARAMETER it fills is exact, and a client is one file, so the run helper a
    verb hands its tier to is always defined beside it."""
    positions = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names = [a.arg for a in node.args.posonlyargs + node.args.args]
            if "tier" in names:
                positions[node.name] = names.index("tier")
    return positions


def _callee_name(call):
    func = call.func
    return func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)


def _tier_literal_sites(source, filename="<client>"):
    """Every STRING-LITERAL tier this source STATES, as
    `(function, lineno, tier, spelling)` attributed to the INNERMOST enclosing
    function — in all FOUR spellings AC15 enumerates.

    AC15, and why the widening is the AC rather than a refactor: cycle 378's
    instrument matched `kw.arg == "tier"` and nothing else, so
    `arduino-crucible.py` — which states its tiers positionally and as a dict
    key — read as a client that stamps nothing anywhere while in fact stamping
    on every path, and its two unearned sites were invisible to the very census
    meant to find them. §S2: "a census is only as wide as its instrument". The
    narrow instrument is kept below, under
    `_keyword_only_tier_literal_sites`, for one purpose: to be shown failing.

    A tier fed by a VARIABLE (mvn's `_run_surefire_tier(..., tier=label)`,
    where the verb's own name supplies the value) is deliberately not a site in
    ANY spelling: the defect §S2 names is a literal the client asserts about a
    run it cannot classify, never the act of passing a tier the caller
    stated."""
    tree = ast.parse(source, filename=filename)
    positions = _tier_parameter_positions(tree)
    sites = []

    def literal(node):
        return isinstance(node, ast.Constant) and isinstance(node.value, str)

    def walk(node, function):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                walk(child, child.name)
                continue
            if isinstance(child, ast.Call):
                for kw in child.keywords:
                    if kw.arg == "tier" and literal(kw.value):
                        sites.append((function, kw.value.lineno,
                                      kw.value.value, KEYWORD))
                index = positions.get(_callee_name(child))
                if index is not None and index < len(child.args):
                    arg = child.args[index]
                    if literal(arg):
                        sites.append((function, arg.lineno, arg.value, POSITIONAL))
            elif isinstance(child, ast.Dict):
                for key, value in zip(child.keys, child.values):
                    if (isinstance(key, ast.Constant) and key.value == "tier"
                            and literal(value)):
                        sites.append((function, value.lineno, value.value,
                                      DICT_KEY))
            elif isinstance(child, (ast.Assign, ast.AnnAssign)):
                targets = (child.targets if isinstance(child, ast.Assign)
                           else [child.target])
                for target in targets:
                    if (isinstance(target, ast.Subscript)
                            and isinstance(target.slice, ast.Constant)
                            and target.slice.value == "tier"
                            and child.value is not None
                            and literal(child.value)):
                        sites.append((function, child.value.lineno,
                                      child.value.value, SUBSCRIPT))
            walk(child, function)

    walk(tree, "<module>")
    return sites


def _keyword_only_tier_literal_sites(source, filename="<client>"):
    """Cycle 378's instrument, transcribed from this file's own history and kept
    for ONE purpose: to be shown failing.

    AC15 claims the widening was necessary. A widened scanner standing alone
    asserts that; the narrow one beside it, run over the same planted
    fixtures, PROVES it — three of the four spellings walk straight past it.

    One mechanical change from the original, and no behavioural one: each site
    carries the `keyword` spelling tag, so both instruments feed the SAME
    guard and the demonstration cannot be dismissed as a shape mismatch. What
    it MATCHES is untouched — `kw.arg == "tier"`, and nothing else."""
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
                        sites.append((function, kw.value.lineno,
                                      kw.value.value, KEYWORD))
            walk(child, function)

    walk(ast.parse(source, filename=filename), "<module>")
    return sites


# §S6's gate ruling, transcribed: "a gate verb inherits the tier of the run it
# drives — `arduino cmd_pre_merge_gate` states `regression` because it runs the
# full native regression suite. Classification is by the tier PASSED to the
# run, never by the enclosing function's name."
#
# It is written down as a RULING because no property of the source can derive
# it: a gate driving the whole regression suite and a `cmd_test` stamping
# `unit` on whatever a path pointed at do the SAME thing to the AST — hand a
# literal to a run helper. The tempting derivation ("earned when a verb NAMED
# for the tier hands the same helper the same tier") is exactly the one that
# would let `cmd_test`'s `unit` back in, because `cmd_unit` calls that helper
# too. So: one entry per ruled site, and
# `test_every_gate_ruling_names_a_site_the_census_still_finds` fails on a
# stale entry — an allow-list nobody re-measures is the census defect again,
# wearing the opposite sign.
GATE_TIER_RULINGS = frozenset({
    ("arduino", "cmd_pre_merge_gate", "regression"),
})


def _is_earned(client, function, tier):
    """§S2's rule: "a tier a verb states where `regression` or `e2e` IS the
    verb's own name is EARNED and stays" — the enclosing function's name is
    split into words, so `cmd_regression`, `_regression_run` and `cmd_e2e` earn
    theirs and `cmd_test`/`cmd_auto_ingest` earn nothing — plus §S6's gate
    ruling above, which is the one case where the enclosing name is NOT the
    question."""
    words = [w for w in re.split(r"[^a-z0-9]+", function.lower()) if w]
    return tier in words or (client, function, tier) in GATE_TIER_RULINGS


def _census_of_sources(sources, scan=_tier_literal_sites):
    """`{client: [(function, lineno, tier, spelling), ...]}` and its unearned
    subset, over sources handed in rather than read off disk.

    Taking the SOURCES and the INSTRUMENT as arguments is what lets AC15's
    planted fixtures and the narrow instrument go through the identical
    classifier the fleet does: a proof that ran a different code path would
    prove nothing about the guard."""
    earned, unearned = {}, {}
    for client, source in sources.items():
        sites = scan(source, filename=f"<{client}>")
        earned[client] = [s for s in sites if _is_earned(client, s[0], s[2])]
        unearned[client] = [s for s in sites if not _is_earned(client, s[0], s[2])]
    return earned, unearned


def _census(scan=_tier_literal_sites):
    """The same census over the five clients as they stand on disk."""
    return _census_of_sources(
        {client: path.read_text() for client, path in CLIENT_FILES.items()},
        scan=scan)


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
    # AC15/AC13(ii) — arduino's two, added at cycle 385. They belong in this
    # set by AC3's own rule and were absent for exactly one reason: the
    # keyword-only instrument could not SEE them, so nothing ever required
    # them to be driven. `cmd_test` stated `unit` POSITIONALLY and
    # `cmd_auto_ingest` stated it as a DICT KEY — "the two arduino sites above
    # ARE AC3 sites and were invisible to cycle 378".
    ("arduino", "cmd_test", "unit", PARSED),
    ("arduino", "cmd_auto_ingest", "unit", PARSED),
})


# The EARNED sites this file drives on the wire, same shape. Its counterpart
# above is compared against the unearned census; this one exists because the
# widened instrument made three arduino sites visible for the first time —
# including the one §S6's gate ruling earns — and a tier the census now calls
# EARNED has to be earned on the WIRE too, not merely in the scan.
EARNED_SITES_DRIVEN_ON_THE_WIRE = frozenset({
    ("arduino", "cmd_unit", "unit", PARSED),
    ("arduino", "cmd_regression", "regression", PARSED),
    ("arduino", "cmd_pre_merge_gate", "regression", PARSED),
    ("rust", "_workspace_regression_run", "regression", PARSED),
    ("rust", "_regression_ingest_run", "regression", PARSED),
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

# arduino's native-host runs shell out to `make -C <native dir> <target>`; the
# reports are written by the fixture, never by this wrapper, so a drive
# measures the ingest and not a fake build. Added at cycle 385 with arduino's
# own tier sites, which the keyword-only census could not see.
_FAKE_MAKE = """#!{python}
import os
import sys

sys.exit(int(os.environ.get("FAKE_MAKE_EXIT_CODE", "0")))
"""

# Only these are looked up on PATH by the clients under drive; every other
# fake is addressed by an explicit path or a patched module constant, so this
# file prepends as little to PATH as it can.
_PATH_TOOLS = {"cargo": _FAKE_CARGO, "docker": _FAKE_DOCKER, "make": _FAKE_MAKE}
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
    "FAKE_MVN_EXIT_CODE", "FAKE_CARGO_EXIT_CODE", "FAKE_MAKE_EXIT_CODE",
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

    def drive_with_real_std(self, argv, response=None):
        """The same drive, with REAL file descriptors for stdout/stderr.

        `rust-crucible.py`'s workspace-regression body hands the nextest child
        the client's own stream (`subprocess.run(..., stdout=sys.stderr)`), and
        an `io.StringIO` has no `fileno()`, so the ordinary drive raises
        `UnsupportedOperation` before the run happens — a harness artefact that
        would masquerade as a finding. Identical `_post` recording; the streams
        are files this fixture reads back. Adopted from the sibling
        `test_client_tier_run_modality.py`, which met the same wall, rather
        than invented a second time."""
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

    def rust_argv(self, verb, extra=(), crate=True):
        """`--crate` is a flag of the per-crate verbs; the workspace-wide tier
        verb (`regression`) does not take it and argparse exits 2 on it, which
        would look like a finding and be a fixture bug."""
        argv = [verb] + (["--crate", "probe_crate"] if crate else [])
        return argv + ["--agent", AGENT, "--project-dir", self.tmpdir] + list(extra)

    def write_nextest_junit(self, profile="ci"):
        directory = Path(self.tmpdir, "target", "nextest", profile)
        directory.mkdir(parents=True, exist_ok=True)
        junit = directory / "junit.xml"
        junit.write_text(_JUNIT_SUITES_ONE_PASS)
        return str(junit)


class _ArduinoCase(_ClientDriveCase):
    CLIENT = "arduino"
    NATIVE_DIR = "tests/native"

    def arduino_argv(self, verb, extra=()):
        return [verb, "--agent", AGENT, "--project-dir", self.tmpdir] + list(extra)

    def write_native_reports(self):
        """The `TEST-*.xml` a native-host run leaves under `<native>/reports`.
        `make` is faked on PATH, so the reports come from here: a drive of this
        client measures what it INGESTS, never a real g++ build."""
        reports = Path(self.tmpdir, *self.NATIVE_DIR.split("/"), "reports")
        reports.mkdir(parents=True, exist_ok=True)
        (reports / "TEST-probe.xml").write_text(_JUNIT_SUITE_ONE_PASS)
        return str(reports)


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


class ArduinoUnearnedTierTest(_ArduinoCase):
    """PIN (both) — arduino's two AC3 sites, driven on the wire for the FIRST
    time at cycle 385.

    They are pins rather than reds because cycle 380 corrected the client; what
    was missing was any test at all. Neither site appeared in cycle 378's
    census, and not because anyone omitted them: `cmd_test` stated `unit`
    POSITIONALLY (`_run_native_tests(args, "test", "unit", False)`) and
    `cmd_auto_ingest` stated it as a DICT KEY (`"tier": "unit"`), and a
    keyword-only instrument sees neither. So the whole client — the one where
    AC3's two hardest sites lived — contributed zero rows to the guard, and a
    re-introduced stamp in either spelling would pass it green."""

    def test_arduino_test_ingests_the_native_run_without_claiming_a_tier(self):
        """AC3, arduino `cmd_test` — the POSITIONAL spelling. This verb ran the
        native host build over whatever `--dir` pointed at, which says nothing
        about the dependency those tests take."""
        self.write_native_reports()
        drive = self.drive(self.arduino_argv("test"))
        self.assertNoStatedTier(drive, PARSED,
                                "arduino cmd_test -> POST /runs/parsed")

    def test_arduino_auto_ingest_ran_no_tests_so_it_claims_no_tier(self):
        """AC3's auto-ingest clause, arduino — the DICT-KEY spelling, and the
        CR's own named worse case: the verb invokes no toolchain at all, it
        ingests `TEST-*.xml` files it merely FOUND."""
        self.write_native_reports()
        drive = self.drive(self.arduino_argv("auto-ingest"))
        self.assertNoStatedTier(drive, PARSED,
                                "arduino cmd_auto_ingest -> POST /runs/parsed")


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


class ArduinoEarnedTierTest(_ArduinoCase):
    """PIN (all three) — the converse for the client the narrow census excluded
    entirely, and the wire half of §S6's gate ruling.

    AC13(i) already reads these as pins in principle ("every run arduino
    actually runs carries its own tier on the POST body"); what cycle 385 adds
    is that the census can now SEE them, so a patch stripping them would fail
    here as well as in the scan."""

    def test_arduino_unit_ingests_the_native_run_under_its_own_tier(self):
        """§S2's converse, arduino `cmd_unit` — the POSITIONAL spelling of an
        EARNED tier: the verb's own name is the tier it states."""
        self.write_native_reports()
        drive = self.drive(self.arduino_argv("unit"))
        self.assertStatedTier(drive, PARSED, "unit",
                              "arduino unit -> POST /runs/parsed")

    def test_arduino_regression_ingests_the_full_native_suite_as_regression(self):
        """§S2's converse, arduino `cmd_regression`, driven with `--coverage` —
        AC5's own example of a flag the migration had to keep."""
        self.write_native_reports()
        drive = self.drive(self.arduino_argv("regression", ["--coverage"]))
        self.assertStatedTier(drive, PARSED, "regression",
                              "arduino regression --coverage -> POST /runs/parsed")

    def test_arduino_pre_merge_gate_inherits_the_tier_of_the_run_it_drives(self):
        """§S6's gate ruling, on the WIRE — "a gate verb inherits the tier of
        the run it drives … Classification is by the tier PASSED to the run,
        never by the enclosing function's name".

        This is the site the widened instrument would otherwise turn red for a
        behaviourally correct client, and the reason `GATE_TIER_RULINGS`
        exists. Driving it is what stops that ruling from being an unexamined
        exemption: the gate must actually put `regression` on the wire to keep
        it. `--skip-check` bypasses the arduino-cli compile step, so this
        measures the regression the gate drives and not the build ahead of
        it."""
        self.write_native_reports()
        drive = self.drive(self.arduino_argv("pre-merge-gate", ["--skip-check"]))
        self.assertStatedTier(drive, PARSED, "regression",
                              "arduino pre-merge-gate -> POST /runs/parsed")


class RustEarnedTierTest(_RustCase):
    """PIN (both) — rust's two regression bodies, the fleet's only instances of
    the SUBSCRIPT spelling (`payload["tier"] = "regression"`), driven on the
    wire for the first time at cycle 385.

    Same reason as arduino's: the keyword-only census could not see either
    site, so nothing required them to be driven, and §S6's ruling 3 — "the
    workspace body stops being the one path where a `regression` run says
    nothing" — could regress silently in the one spelling the old guard was
    blind to. Both use `drive_with_real_std`: the workspace body hands the
    nextest child a real file descriptor."""

    def test_rust_regression_ingests_the_workspace_run_as_regression(self):
        """§S2's converse, rust `_workspace_regression_run` — the tier verb's
        own body."""
        self.write_nextest_junit()
        drive = self.drive_with_real_std(self.rust_argv("regression", (), crate=False))
        self.assertStatedTier(drive, PARSED, "regression",
                              "rust regression -> POST /runs/parsed")

    def test_rust_regression_ingest_carries_the_per_crate_regression_tier(self):
        """§S2's converse, rust `_regression_ingest_run` — the per-crate body,
        which has posted `tier="regression"` since before this CR was cut."""
        self.write_nextest_junit()
        drive = self.drive_with_real_std(self.rust_argv("regression-ingest"))
        self.assertStatedTier(drive, PARSED, "regression",
                              "rust regression-ingest -> POST /runs/parsed")


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


class _UnearnedStampGuard:
    """The guard AC3 is enforced by, as ONE method on a mixin.

    A mixin rather than a test body, and shared rather than copied, for the
    reason AC15 exists: the planted proofs must be shown making THIS guard
    fail. A proof aimed at a re-implementation proves nothing about the guard
    the fleet is actually held to."""

    def assertNoUnearnedStamps(self, unearned):
        sites = _flat(unearned)
        rendered = "; ".join(
            f"{client} {function}:{lineno} tier={tier!r} ({spelling})"
            for client, function, lineno, tier, spelling in sorted(sites))
        offending_clients = sorted(c for c, s in unearned.items() if s)
        self.assertEqual(
            len(sites), 0,
            f"AC3 — {len(sites)} call site(s) across {len(offending_clients)} "
            f"client(s) {offending_clients!r} still stamp a tier their own verb "
            f"did not earn. A verb that ran no tests, or ran whatever a path "
            f"pointed at, cannot know the tier; absent a stated tier the run "
            f"carries none and the server's own default applies. Survivors: "
            f"{rendered}")


class UnearnedTierLiteralCensusTest(_UnearnedStampGuard, unittest.TestCase):
    """AC3's count, DERIVED: "The count of corrected sites is itself asserted,
    and a `tier="..."` literal surviving anywhere outside a verb whose own NAME
    is that tier fails this AC."

    This class is the reason the AC cannot be satisfied one line at a time: it
    scans all five clients and requires the derived count of unearned literal
    sites to be ZERO. Fixing bun alone leaves nine; fixing every `cmd_test` and
    forgetting `auto-ingest` leaves five."""

    def test_no_client_stamps_a_tier_its_own_verb_did_not_earn(self):
        """PIN as of cycle 385, and a WIDER pin than it was: the derived count
        was 12 at cycle 378 with a keyword-only instrument, is 0 now, and is 0
        under an instrument that reads three spellings the old one could not.
        The count did not move; what the count MEANS did."""
        _earned, unearned = _census()
        self.assertNoUnearnedStamps(unearned)

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
            sites, [("cmd_test", 2, "unit", KEYWORD),
                    ("cmd_regression", 4, "regression", KEYWORD)],
            "the scanner must see both literal sites, attribute each to its "
            "enclosing function, and ignore a tier passed as a VARIABLE (the "
            "shape a caller-stated tier takes)")
        self.assertEqual(
            [s for s in sites if not _is_earned("probe", s[0], s[2])],
            [("cmd_test", 2, "unit", KEYWORD)],
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
                   for client, function, _lineno, tier, _spelling in _flat(unearned)}
        driven = {(client, function, tier)
                  for client, function, tier, _endpoint in SITES_DRIVEN_ON_THE_WIRE}
        self.assertEqual(
            scanned - driven, set(),
            f"the census finds unearned tier stamps this file never drives on "
            f"the wire: {sorted(scanned - driven)!r}. Every site AC3 names must "
            f"be asserted on the POST body, not only in the source scan.")

    def test_the_earned_sites_the_scan_finds_are_the_verbs_that_name_them(self):
        """PIN — the census's other half, stated so the earned set is visible
        rather than implied: every literal tier that SURVIVES lives in a
        function whose own name is that tier, or in one §S6's gate ruling names
        explicitly."""
        earned, _unearned = _census()
        for client, function, lineno, tier, spelling in _flat(earned):
            if (client, function, tier) in GATE_TIER_RULINGS:
                continue
            self.assertIn(
                tier, function.lower(),
                f"{client} {function}:{lineno} ({spelling}) was classified "
                f"earned but its name does not carry {tier!r}, and no gate "
                f"ruling names it")

    def test_every_site_the_widening_revealed_is_driven_on_the_wire(self):
        """AC15's coverage half, DERIVED by running both instruments over the
        same five clients: every site the widened scan can see and the
        keyword-only one could not must be asserted on the POST body here.

        This is the bound the narrow instrument made unstatable. arduino
        contributed ZERO rows to cycle 378's census, so nothing required its
        sites to be driven at all — and rust's two subscript sites were in the
        same position. A guard that can SEE a site but never drives it has
        moved the blindness rather than removed it."""
        revealed = _sites_the_widening_revealed()
        driven = {(client, function, tier) for client, function, tier, _endpoint
                  in SITES_DRIVEN_ON_THE_WIRE | EARNED_SITES_DRIVEN_ON_THE_WIRE}
        self.assertTrue(
            revealed,
            "the widening revealed no site at all, so this bound is vacuous "
            "and AC15's premise — that the keyword-only instrument was blind "
            "to real sites in the shipped fleet — is no longer measurable here")
        self.assertEqual(
            revealed - driven, set(),
            f"the widened census sees tier statements this file never drives "
            f"on the wire: {sorted(revealed - driven)!r}. These are exactly "
            f"the sites cycle 378 could not see; making them visible without "
            f"driving them leaves the same gap one layer up.")

    def test_every_gate_ruling_names_a_site_the_census_still_finds(self):
        """PIN — the staleness bound on the one hand-written exemption in this
        file. `GATE_TIER_RULINGS` is a ruling, not a derivation, so its failure
        mode is a rule outliving the code it was written for: an entry naming a
        site the census no longer finds is an allow-list nobody re-measures,
        which is the census defect again with the opposite sign."""
        earned, _unearned = _census()
        found = {(client, function, tier)
                 for client, function, _lineno, tier, _spelling in _flat(earned)}
        self.assertEqual(
            GATE_TIER_RULINGS - found, frozenset(),
            f"gate ruling(s) {sorted(GATE_TIER_RULINGS - found)!r} name a site "
            f"the census does not find. A ruling that exempts nothing must be "
            f"deleted, not kept: it can only ever exempt something new by "
            f"accident.")


# ── AC15: the instrument's own blindness, planted and proven ───────────────


# The helpers a planted client hands its tier to. `tier` is a real PARAMETER
# here, exactly as `arduino-crucible.py`'s `_run_native_tests(args, verb, tier,
# want_coverage)` declares it, because that is what the positional spelling is
# resolved against.
_PLANTED_PROLOGUE = (
    "def _ingest_parsed(payload=None, tier=None):\n"
    "    return payload\n"
    "def _run_native_tests(args, verb, tier, want_coverage):\n"
    "    return tier\n"
)

# One planted client per spelling: an UNEARNED stamp (a verb whose name is not
# the tier) and an EARNED control (a verb whose name is), both written in the
# SAME spelling. The control is what stops a proof from passing because the
# instrument flags everything.
_PLANTED_BODIES = {
    KEYWORD: (
        "def cmd_test(args):\n"
        "    return _ingest_parsed(tier=\"unit\")\n"
        "def cmd_regression(args):\n"
        "    return _ingest_parsed(tier=\"regression\")\n"
    ),
    POSITIONAL: (
        "def cmd_test(args):\n"
        "    return _run_native_tests(args, \"test\", \"unit\", False)\n"
        "def cmd_regression(args):\n"
        "    return _run_native_tests(args, \"regression\", \"regression\", True)\n"
    ),
    DICT_KEY: (
        "def cmd_auto_ingest(args):\n"
        "    payload = {\"projectKey\": \"k\", \"tier\": \"unit\"}\n"
        "    return _ingest_parsed(payload)\n"
        "def cmd_e2e(args):\n"
        "    return _ingest_parsed({\"projectKey\": \"k\", \"tier\": \"e2e\"})\n"
    ),
    SUBSCRIPT: (
        "def cmd_test(args):\n"
        "    payload = {}\n"
        "    payload[\"tier\"] = \"unit\"\n"
        "    return _ingest_parsed(payload)\n"
        "def cmd_regression(args):\n"
        "    payload = {}\n"
        "    payload[\"tier\"] = \"regression\"\n"
        "    return _ingest_parsed(payload)\n"
    ),
}

# `(unearned function, tier)` and `(earned function, tier)` per planted client.
_PLANTED_EXPECTATIONS = {
    KEYWORD: (("cmd_test", "unit"), ("cmd_regression", "regression")),
    POSITIONAL: (("cmd_test", "unit"), ("cmd_regression", "regression")),
    DICT_KEY: (("cmd_auto_ingest", "unit"), ("cmd_e2e", "e2e")),
    SUBSCRIPT: (("cmd_test", "unit"), ("cmd_regression", "regression")),
}


def _planted(spelling):
    return _PLANTED_PROLOGUE + _PLANTED_BODIES[spelling]


def _sites_the_widening_revealed():
    """`{(client, function, tier)}` the widened instrument sees in the shipped
    fleet and cycle 378's keyword-only one cannot — measured by running both
    over the same five files, never listed by hand."""
    wide_earned, wide_unearned = _census()
    narrow_earned, narrow_unearned = _census(scan=_keyword_only_tier_literal_sites)
    narrow = {(client, function, tier)
              for client, function, _lineno, tier, _spelling
              in _flat(narrow_earned) + _flat(narrow_unearned)}
    return {(client, function, tier)
            for client, function, _lineno, tier, _spelling
            in _flat(wide_earned) + _flat(wide_unearned)} - narrow


class CensusInstrumentSeesEverySpellingTest(_UnearnedStampGuard, unittest.TestCase):
    """AC15 — "the AC3 census guard sees EVERY spelling a tier can be stated
    in … The instrument's own blindness is asserted against: a planted unearned
    stamp in EACH of the four spellings must make the guard fail."

    RED at cycle 385 for three of the four: against the keyword-only
    instrument this class's positional, dict-key and subscript proofs cannot
    pass, because the guard they require to FAIL passes instead — which is the
    same act of faith the narrow scan was, and the reason arduino contributed
    zero rows to a census that named it in five of its own table cells.

    It shares `_UnearnedStampGuard` with the census class above, so the guard
    these proofs make fail is the identical method the fleet is held to."""

    def test_the_planted_fixtures_cover_every_spelling_the_instrument_declares(self):
        """The count bound, so a FIFTH spelling taught to the instrument
        without a planted proof fails here rather than shipping unproven."""
        self.assertEqual(
            set(_PLANTED_BODIES), set(SPELLINGS),
            "every spelling the instrument claims to read must have a planted "
            "unearned stamp proving it does")
        self.assertEqual(set(_PLANTED_EXPECTATIONS), set(SPELLINGS))

    def test_the_instrument_reads_an_unearned_stamp_in_each_of_the_four_spellings(self):
        for spelling in SPELLINGS:
            with self.subTest(spelling=spelling):
                (bad_fn, bad_tier), (good_fn, good_tier) = _PLANTED_EXPECTATIONS[spelling]
                sites = _tier_literal_sites(_planted(spelling),
                                            filename=f"<{spelling}>")
                read = {(fn, tier, spelt) for fn, _lineno, tier, spelt in sites}
                self.assertIn(
                    (bad_fn, bad_tier, spelling), read,
                    f"AC15 — the instrument must read the {spelling} spelling: "
                    f"a tier stated as {spelling} is a tier stated. It saw "
                    f"{sorted(read)!r}")
                self.assertIn(
                    (good_fn, good_tier, spelling), read,
                    f"AC15 — the {spelling} EARNED control must be read too; "
                    f"an instrument that saw only the unearned one would be "
                    f"matching the verb name, not the spelling")
                self.assertFalse(
                    _is_earned("planted", bad_fn, bad_tier),
                    f"AC15 — {bad_fn} does not name {bad_tier!r} and no gate "
                    f"ruling covers it, so the stamp is unearned")
                self.assertTrue(
                    _is_earned("planted", good_fn, good_tier),
                    f"AC15 — {good_fn} IS {good_tier!r}, so its stamp is "
                    f"earned and must survive")

    def test_a_planted_unearned_stamp_makes_the_guard_fail_in_each_spelling(self):
        """AC15's own words, executed: "a planted unearned stamp in EACH of the
        four spellings must make the guard fail". The guard called here is the
        one `test_no_client_stamps_a_tier_its_own_verb_did_not_earn` calls."""
        for spelling in SPELLINGS:
            with self.subTest(spelling=spelling):
                (bad_fn, bad_tier), _good = _PLANTED_EXPECTATIONS[spelling]
                _earned, unearned = _census_of_sources(
                    {"planted": _planted(spelling)})
                with self.assertRaises(self.failureException) as caught:
                    self.assertNoUnearnedStamps(unearned)
                message = str(caught.exception)
                self.assertIn(
                    bad_fn, message,
                    f"AC15 — the guard must NAME the {spelling} survivor it "
                    f"caught; a failure that does not say where it is sends "
                    f"the reader back to the scan: {message!r}")
                self.assertIn(repr(bad_tier), message)
                self.assertIn(spelling, message)

    def test_the_keyword_only_instrument_is_blind_to_three_of_the_four_spellings(self):
        """The demonstration AC15 asks for, and the reason the narrow scanner
        is kept in this file: the SAME four planted clients, read by cycle
        378's instrument, produce a guard that PASSES on three of them.

        This is not a hypothetical — it is what happened to
        `arduino-crucible.py`, which stamped a tier on every path while the
        census recorded it as stamping none."""
        blind = []
        for spelling in SPELLINGS:
            _earned, unearned = _census_of_sources(
                {"planted": _planted(spelling)},
                scan=_keyword_only_tier_literal_sites)
            try:
                self.assertNoUnearnedStamps(unearned)
            except self.failureException:
                continue
            blind.append(spelling)
        self.assertEqual(
            sorted(blind), sorted(set(SPELLINGS) - {KEYWORD}),
            f"the keyword-only instrument must be blind to exactly the three "
            f"spellings that are not `tier=`, and see the keyword one — that "
            f"asymmetry IS the defect AC15 corrects. It was blind to "
            f"{sorted(blind)!r}.")


if __name__ == "__main__":
    unittest.main()
