"""CR-CRU-111 §S4 — a `unit` run that spends its time WAITING says so (AC6b).

One acceptance criterion lives here, and it is the one cycle 380 owns:

  * **AC6b** — "a `unit` run whose wall time exceeds its CPU time by the stated
    factor carries a structured warning naming both figures and the factor,
    with `ok` unchanged — the run is reported, not refused. Asserted twice:
    once on a deliberately sleeping fixture (warning present) and once on a
    CPU-bound fixture (warning absent), so the check cannot pass by always
    warning."

§S4 states the factor AND the mechanism, so neither is chosen here:

  * the FACTOR is **wall >= 2x CPU**, and it WARNS — "it does not refuse:
    classification is the project's decision, so the client reports the
    contradiction rather than vetoing it";
  * the MECHANISM is child CPU from `resource.getrusage(RUSAGE_CHILDREN)`
    deltas taken around the existing `subprocess.run` call — stdlib, and used
    nowhere in `clients/` today.

WHY THE FIXTURES ARE SHAPED THE WAY THEY ARE. §S4's discrimination is measured,
not argued: "a sleeping child reads 38.4x, a CPU-bound child reads 1.00x, and
this repo's own `test:unit` target reads 1.09x". This file reproduces both ends
of that measurement with the SAME fake-toolchain mechanism cycle 379 already
uses — every toolchain on PATH is a tiny recording executable — plus one
addition, a burn preamble that either SLEEPS (wall without CPU) or SPINS (wall
that IS CPU) for `BURN_SECONDS`. The sleep is 0.3 s: the subject of the
measurement, never a way to make the suite slow. MEASURED on this machine at
the time of writing, and the numbers this file's own failure messages report:

    sleeping child   mvn 24.5x   rust 25.0x   arduino 23.8x   (1 child each)
    CPU-bound child  mvn  1.02x  rust  1.02x  arduino  1.02x  (1 child each)

so 2x sits an order of magnitude below the sleeping end and 2% above the
CPU-bound end, exactly as §S4's anchors predict.

WHY THE ASSERTION IS ON THE ENVELOPE AND NOT ON STDOUT TEXT: `emit_axi` writes
`warnings[]{code,detail}` as the machine channel, and every structured warning
this fleet already shapes — `gate_step_abort_warning`, `no_report_warning`,
`preflight_cycle_warnings` — is a `{code, detail}` pair on that list. AC6b's
warning is one more member of that family, so this file reads it the way the
fleet's other suites read theirs and invents no second envelope key.

WHAT THE WARNING MUST CONTAIN, ruled here so GREEN is not guessing:

  * `code` — `unit-run-wall-exceeds-cpu`, exposed from the shared module as
    `UNIT_RUN_WALL_EXCEEDS_CPU_CODE` the way `TIER_RUN_UNDECLARED_CODE` is.
    The NAME is fixed here on cycle 377's own precedent (AC4 fixed
    `add_tier_verbs` "not left to GREEN" so the AC would "fail on a defect
    rather than on a naming disagreement"). A structured warning is identified
    by its code; a consumer cannot match on prose.
  * `detail` — the WALL figure, the CPU figure, the factor, the tier, and
    enough identification to say which client emitted it. The exact SENTENCE
    is GREEN's to word well: this file asserts the FIGURES are present and
    CORRECT (each checked against what this test measured around the same
    drive, in seconds or milliseconds), never a wording.

WHAT IS RED HERE AND WHAT IS A PIN, stated per test, because a suite that does
not say which of its members were born green is a suite whose colour means
nothing. MEASURED on `feature/CR-CRU-111` @ `f16daf5` (cycles 377, 378 and 379
merged), 2026-09-08:

  RED  `{Mvn,Rust,Arduino}UnitRunThatWaitsTest.test_a_unit_run_that_waits_
         carries_the_wall_vs_cpu_warning` — no client measures CPU at all
         (`resource` is imported by no file in `clients/`), so a `unit` run
         that slept 24x longer than it computed is reported as an ordinary
         unit run with `warnings: []`.
  RED  `FleetReachTest.test_the_shared_module_names_the_wall_vs_cpu_warning`
         and `FleetWarningIsOneDefinitionTest.test_every_client_whose_unit_
         cell_runs_warns_when_it_waits` — rule 15: "the client warns" is
         satisfiable by ONE client, and this check belongs in
         `clients/_crucible_axi.py` where `add_tier_verbs` already is.
  PIN  `{...}UnitRunThatWaitsTest.test_a_cpu_bound_unit_run_carries_no_such_
         warning` — all five, and the fleet-wide twin. These pass TODAY for
         the trivial reason that nothing warns at all, and they only become
         meaningful after GREEN, when they are the whole bound between a check
         and a rubber stamp. AC6b requires them anyway and says why: "asserted
         twice ... so the check cannot pass by always warning."
  PIN  `{Bun,Python}UnitRunThatWaitsTest` — both halves. `bun-crucible.py` and
         `python-crucible.py` wire only `regression` into `add_tier_verbs`, so
         their `unit` cell is a DECLARED cell with no declaration and answers
         cycle 377's `tier-run-undeclared` hard stop: nothing runs, so there
         is no wall and no CPU to compare. The probe is written for all five
         clients and ARMS ITSELF the moment either cell becomes runnable —
         `assertUnitRunThatWaitsWarns` reads the refusal at run time and
         refuses to accept it from a client §S3 gives a `unit` SPLIT cell. See
         ESCALATION 2.
  PIN  `FleetReachTest.test_every_client_registering_tier_verbs_is_probed_
         here` — the derived census. The client set is SCANNED (`clients/
         *-crucible.py` filtered to those that call `add_tier_verbs`), never
         frozen, so a sixth client cannot join the fleet without joining this
         file.
  PIN  `AttributionBoundTest` — one child per `unit` drive, which is what
         makes `RUSAGE_CHILDREN` attributable at all. See ESCALATION 1: it is
         a bound on the ruled mechanism, and it is already false one verb
         over.

HARNESS: cycle 379's `tests/client/test_client_tier_run_modality.py`, ADOPTED
whole rather than re-invented — its `_ModalityCase` (cycle 378's client drive
plus the fake-toolchain argv log) and its five per-client fixtures are imported
and subclassed. The only addition is the burn preamble spliced into that file's
OWN `_RECORD` template, so the toolchains here are the same executables cycle
379 drives, told to spend their time one way or the other. No real
mvn/cargo/make/bun/arduino-cli is reachable and no request leaves the process.

ESCALATIONS recorded at the time of writing (see the report for the full text):

  1. `RUSAGE_CHILDREN` is a per-PROCESS cumulative counter, not a per-child
     one, so a delta taken around one `subprocess.run` is attributable to that
     child ONLY while the verb spawns exactly one. Every `unit` verb in the
     fleet does today (measured: mvn 1, rust 1, arduino 1) and AC6b is scoped
     to `unit`, so the ruled mechanism is sound where this CR applies it. It
     is already false one verb over: `mvn e2e` spawns TWO (`docker` then
     `mvnw`) and the delta covers both — measured 0.844 s wall / 0.036 s CPU
     across the pair. If the check is ever widened past `unit`, the delta must
     be taken around each `subprocess.run` separately, never around the verb.
     `AttributionBoundTest` holds the bound this CR relies on.
  2. AC6b's fleet reach is BOUNDED BY AC6a. "The client warns" must be true of
     every client with a `unit` verb (rule 15), and all five have one since
     cycle 377 — but bun's and python's REFUSE, because §S3 makes their `unit`
     a declared cell and neither project declares a target. So AC6b can be
     asserted behaviourally in three clients today, and the other two assert
     the only fact they can carry (nothing ran, so nothing is warned about)
     until their cell is declared. This is a real gap in coverage, not a
     wording choice, and it closes by itself: the probe derives which clients
     ran at run time.
  3. §S4 says "wall exceeds CPU by 2x or more" and gives 1.09x for a real unit
     suite. Where a CPU-bound run reads slightly ABOVE 1.0x, the boundary
     itself (exactly 2.00x) is unspecified as inclusive or exclusive. This
     file asserts nothing at the boundary — both fixtures sit an order of
     magnitude away from it — so either reading passes. A boundary test needs
     a ruling before it can be written.

Invocation:
    python3 -m pytest tests/client/test_client_unit_tier_wall_vs_cpu.py -q
Fallback:
    python3 tests/client/test_client_unit_tier_wall_vs_cpu.py
"""

import importlib.util
import os
import re
import resource
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
MODALITY_PATH = Path(__file__).resolve().parent / "test_client_tier_run_modality.py"
AXI_MODULE_PATH = CLIENTS_DIR / "_crucible_axi.py"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Cycle 379's harness, adopted whole. Only NON-test names are taken: importing
# one of its TestCases would run that cycle's suite a second time under this
# module.
_MODALITY = _load_module(MODALITY_PATH, "cr111_c4_tier_modality_harness")
_AXI = _load_module(AXI_MODULE_PATH, "cr111_c4_axi")

AGENT = _MODALITY.AGENT
TIER_RUN_UNDECLARED_CODE = _MODALITY.TIER_RUN_UNDECLARED_CODE

# §S4's stated factor. Read from the CR, not chosen: "wall exceeds CPU by 2x or
# more".
STATED_FACTOR = 2.0

# The tier §S4 scopes the check to. AC6b is about `unit` and no other cell — a
# warning on `e2e` would be reporting the dependency that tier is DEFINED by.
SCOPED_TIER = "unit"

# Long enough that the ratio clears 2x by an order of magnitude (measured 24x),
# short enough that the whole file costs ~4 s. The sleep is the SUBJECT of the
# measurement, never a way to make the suite slow.
BURN_SECONDS = 0.3

# RULED HERE (see the module docstring): the warning's code, and the shared
# module constant GREEN must expose it as. `getattr` rather than a hard
# reference so this module still IMPORTS before GREEN lands — an import error
# would take the PINs down with the REDs and hide which is which.
WALL_VS_CPU_CODE_CONST = "UNIT_RUN_WALL_EXCEEDS_CPU_CODE"
WALL_VS_CPU_CODE = getattr(_AXI, WALL_VS_CPU_CODE_CONST,
                           "unit-run-wall-exceeds-cpu")

# What counts as naming the client the warning came from. The client's own stem
# always does; so does the toolchain that stem drives, because that is how a
# reader of the board names the same stack.
_TOOLCHAIN_ALIASES = {
    "mvn": ("maven", "surefire"),
    "rust": ("cargo", "nextest"),
    "arduino": ("make",),
    "bun": (),
    "python": ("unittest",),
}


def _tier_verb_clients():
    """The fleet, SCANNED: every `clients/*-crucible.py` that registers the six
    tier verbs through the shared registrar. Derived rather than frozen, so a
    sixth client cannot join the fleet without joining this file — which is the
    whole of rule 15's complaint that "the client warns" is satisfiable by
    one."""
    found = {}
    for path in sorted(CLIENTS_DIR.glob("*-crucible.py")):
        if "add_tier_verbs(" in path.read_text():
            found[path.name.split("-crucible.py")[0]] = path
    return found


def _clients_with_a_unit_split_cell():
    """The clients §S3's matrix gives a `unit` SPLIT cell — mvn, rust, arduino —
    read out of cycle 379's transcription of that table rather than restated.
    These are the clients whose `unit` verb MUST run, so this file cannot pass
    by every client refusing."""
    return frozenset(
        client for client, tiers in _MODALITY.TOOLCHAIN_SPLIT_CELLS.items()
        if SCOPED_TIER in tiers)


# ── the burn preamble, spliced into cycle 379's own recording template ──────
#
# `sleep` spends WALL and no CPU; `spin` spends wall that IS CPU. Both are read
# from the environment, so one set of fake toolchains serves both halves of
# AC6b and the two halves cannot drift apart into two mechanisms.
_BURN = """
_burn_mode = os.environ.get("FAKE_BURN_MODE", "")
_burn_secs = float(os.environ.get("FAKE_BURN_SECONDS", "0") or 0)
if _burn_secs > 0 and _burn_mode == "sleep":
    import time as _burn_time
    _burn_time.sleep(_burn_secs)
elif _burn_secs > 0 and _burn_mode == "spin":
    import time as _burn_time
    _burn_end = _burn_time.monotonic() + _burn_secs
    _burn_x = 0
    while _burn_time.monotonic() < _burn_end:
        _burn_x = (_burn_x * 1103515245 + 12345) % 2147483647
"""

_BIN_DIR = None
_SAVED_PATH = None
_SAVED_MODALITY_BIN = None


def setUpModule():
    global _BIN_DIR, _SAVED_PATH, _SAVED_MODALITY_BIN
    _BIN_DIR = tempfile.mkdtemp(prefix="cr111-wallcpu-bin-")
    tools = list(_MODALITY._PATH_TOOLS.items()) + list(_MODALITY._NAMED_TOOLS.items())
    for name, tail in tools:
        path = Path(_BIN_DIR) / name
        body = (_MODALITY._RECORD
                .replace("__PYTHON__", sys.executable)
                .replace("__TOOL__", name))
        path.write_text(body + _BURN + tail)
        path.chmod(0o755)
    _SAVED_PATH = os.environ.get("PATH", "")
    os.environ["PATH"] = _BIN_DIR + os.pathsep + _SAVED_PATH
    # The imported fixtures reach their named tools through the harness's own
    # `_fake()`, which reads that module's `_BIN_DIR`. Point it at the burning
    # copies for the life of this module, and put it back afterwards.
    _SAVED_MODALITY_BIN = _MODALITY._BIN_DIR
    _MODALITY._BIN_DIR = _BIN_DIR


def tearDownModule():
    _MODALITY._BIN_DIR = _SAVED_MODALITY_BIN
    if _SAVED_PATH is not None:
        os.environ["PATH"] = _SAVED_PATH
    if _BIN_DIR:
        shutil.rmtree(_BIN_DIR, ignore_errors=True)


# ── reading the figures back out of a warning ──────────────────────────────

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


class _WallVsCpuProbe:
    """AC6b's two halves, shared: one drive of this client's `unit` verb with
    its toolchain told to spend its time one way or the other, measured from
    the OUTSIDE with the same `RUSAGE_CHILDREN` mechanism §S4 rules for the
    inside — so the figures the warning claims are checked against figures this
    test took around the same drive, and not against the spec's anchors."""

    _BURN_ENV = ("FAKE_BURN_MODE", "FAKE_BURN_SECONDS")

    def setUp(self):
        super().setUp()
        self._saved_burn = {k: os.environ.get(k) for k in self._BURN_ENV}
        for key in self._BURN_ENV:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._saved_burn.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        super().tearDown()

    # ── the drive ──────────────────────────────────────────────────────────

    def unit_argv(self):
        """This client's own minimal `unit` invocation. Overridden per client."""
        raise NotImplementedError

    def write_unit_fixture(self):
        """The report file this client's `unit` run ingests, if it has one."""

    def drive_unit(self, mode):
        """Drive `unit` with the toolchain burning `mode`, and return the drive
        plus the wall and child-CPU this test measured around it."""
        self.write_unit_fixture()
        os.environ["FAKE_BURN_MODE"] = mode
        os.environ["FAKE_BURN_SECONDS"] = str(BURN_SECONDS)
        before = resource.getrusage(resource.RUSAGE_CHILDREN)
        started = time.monotonic()
        drive = self.drive(self.unit_argv())
        wall = time.monotonic() - started
        after = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu = ((after.ru_utime - before.ru_utime)
               + (after.ru_stime - before.ru_stime))
        return drive, wall, cpu

    # ── reading the envelope ───────────────────────────────────────────────

    def wall_vs_cpu_warnings(self, drive):
        axi = self.envelope(drive)
        return [w for w in (axi.get("warnings") or [])
                if isinstance(w, dict) and w.get("code") == WALL_VS_CPU_CODE]

    def assertRunWasReportedNotRefused(self, drive, where):
        """§S4: "It does not refuse ... the client reports the contradiction
        rather than vetoing it." A check that turned a passing unit run red
        would be a worse defect than the one it detects, so `ok` and the exit
        code are asserted alongside the warning and never instead of it."""
        axi = self.envelope(drive)
        self.assertIs(
            axi.get("ok"), True,
            f"AC6b — {where}: the wall-vs-CPU check WARNS and never refuses, "
            f"so a run whose tests all passed must still answer ok:true; "
            f"envelope={axi!r}")
        self.assertEqual(
            drive.code, 0,
            f"AC6b — {where}: `ok` unchanged means the exit code is unchanged "
            f"too — a caller that gates on the exit status must not see a "
            f"green suite turn red because the client suspects its tier. "
            f"exit={drive.code} stderr={drive.err[-600:]!r}")

    # ── the figures ────────────────────────────────────────────────────────

    def assertNamesBothFiguresAndTheFactor(self, detail, wall, cpu, ratio,
                                           where):
        """AC6b — "naming both figures and the factor", read out of the detail
        as THREE DISTINCT numbers, each in the range this test measured around
        the same drive.

        Distinct occurrences, and ONE unit scale for the whole warning, because
        both looser readings admit a warning that names one figure twice: a
        detail reading "waited 0.325s, over the 2x factor" would otherwise pass
        a CPU check by reinterpreting `2` as 2 milliseconds, and "wall 0.325s
        vs cpu 0.325s" would pass one by reinterpreting the wall figure as
        microseconds. A run is described by three numbers or it is not
        described.

        The FACTOR is never scaled: it is a ratio, and a ratio has no unit."""
        occurrences = [(m.group(), float(m.group()))
                       for m in _NUMBER_RE.finditer(detail or "")]

        def in_wall(value):
            return BURN_SECONDS * 0.75 <= value <= wall * 1.5

        def in_cpu(value):
            return 0.0 <= value <= max(cpu * 1.5, 0.001)

        def in_factor(value):
            return (abs(value - STATED_FACTOR) < 1e-9
                    or ratio * 0.5 <= value <= ratio * 1.5)

        for scale, unit in ((1.0, "seconds"), (0.001, "milliseconds")):
            walls = {i for i, (_t, v) in enumerate(occurrences)
                     if in_wall(v * scale)}
            cpus = {i for i, (_t, v) in enumerate(occurrences)
                    if in_cpu(v * scale)}
            factors = {i for i, (_t, v) in enumerate(occurrences)
                       if in_factor(v)}
            if any(len({w, c, f}) == 3
                   for w in walls for c in cpus for f in factors):
                return unit
        self.fail(
            f"AC6b — {where}: the warning must NAME both figures and the "
            f"factor, as three distinct numbers under one unit scale. This "
            f"test measured {wall:.3f}s of wall time and {cpu:.3f}s of "
            f"RUSAGE_CHILDREN CPU around the same drive ({ratio:.1f}x, and "
            f"§S4's stated factor is {STATED_FACTOR:g}x), so the detail must "
            f"carry a wall figure in "
            f"[{BURN_SECONDS * 0.75:.4f}, {wall * 1.5:.4f}], a CPU figure in "
            f"[0, {max(cpu * 1.5, 0.001):.4f}] and the factor — seconds or "
            f"milliseconds, its wording is GREEN's to choose. "
            f"detail={detail!r} numbers={[t for t, _v in occurrences]!r}")

    def assertWarnsThatItWaited(self, drive, wall, cpu, where):
        matches = self.wall_vs_cpu_warnings(drive)
        axi = self.envelope(drive)
        ratio = wall / cpu if cpu > 0 else float("inf")
        self.assertEqual(
            len(matches), 1,
            f"AC6b — {where}: this `unit` run spent {wall:.3f}s of wall time "
            f"against {cpu:.3f}s of child CPU ({ratio:.1f}x, the stated "
            f"factor is {STATED_FACTOR:g}x), so it must carry EXACTLY ONE "
            f"`{WALL_VS_CPU_CODE}` warning — 'without it the tier definitions "
            f"are prose'. It carries {len(matches)}; "
            f"warnings={axi.get('warnings')!r}")
        detail = str(matches[0].get("detail") or "")
        lowered = detail.lower()

        # "naming both figures and the factor" — all three, as distinct
        # numbers, each checked against what this test measured around the
        # same drive rather than against §S4's anchors.
        self.assertNamesBothFiguresAndTheFactor(detail, wall, cpu, ratio, where)

        # "enough identification that a reader knows which tier and which
        # client it came from" — an orchestrator reads warnings off a board,
        # away from the terminal that produced them.
        self.assertIn(
            SCOPED_TIER, lowered,
            f"AC6b — {where}: §S4 scopes this check to the `{SCOPED_TIER}` "
            f"tier, and a warning that does not say which tier it doubts "
            f"cannot be acted on. detail={detail!r}")
        tokens = (self.CLIENT,) + _TOOLCHAIN_ALIASES[self.CLIENT]
        self.assertTrue(
            any(token in lowered for token in tokens),
            f"AC6b — {where}: the warning must identify the client it came "
            f"from (one of {list(tokens)!r}) — five clients emit this same "
            f"code, and a board row that cannot say which stack waited is not "
            f"actionable. detail={detail!r}")

    def assertNoWallVsCpuWarning(self, drive, wall, cpu, where):
        matches = self.wall_vs_cpu_warnings(drive)
        ratio = wall / cpu if cpu > 0 else float("inf")
        self.assertEqual(
            matches, [],
            f"AC6b — {where}: this `unit` run spent {wall:.3f}s of wall time "
            f"against {cpu:.3f}s of child CPU ({ratio:.2f}x), which is BELOW "
            f"the stated {STATED_FACTOR:g}x — a run that computes for its "
            f"whole wall clock is the honest unit run this check exists to "
            f"leave alone (§S4 measures a real unit suite at 1.09x). It "
            f"warned anyway: {matches!r}")

    # ── the two halves, shared so every client asserts the same thing ──────

    def assertUnitRunThatWaitsWarns(self):
        where = f"{self.CLIENT}/{SCOPED_TIER}"
        drive, wall, cpu = self.drive_unit("sleep")
        self.assertVerbAcceptedTheInvocation(drive, where)
        if self.refused_for_no_declaration(drive):
            # ESCALATION 2 — a declared cell with no declaration never runs, so
            # there is no wall and no CPU to compare. That is only acceptable
            # from a client §S3 does NOT give a `unit` split cell; from mvn,
            # rust or arduino it would mean cycle 379 regressed and this test
            # measured nothing.
            self.assertNotIn(
                self.CLIENT, _clients_with_a_unit_split_cell(),
                f"AC6b — {where}: §S3 gives this client a `{SCOPED_TIER}` "
                f"SPLIT cell, so its unit verb must RUN; it answered "
                f"{TIER_RUN_UNDECLARED_CODE} instead, so no wall/CPU "
                f"comparison was possible. stderr={drive.err[-500:]!r}")
            self.assertEqual(
                self.wall_vs_cpu_warnings(drive), [],
                f"AC6b — {where}: this cell REFUSED, so nothing ran and there "
                f"is nothing to warn about; a wall-vs-CPU warning on a run "
                f"that never happened is a fabricated measurement")
            return
        self.assertRunWasReportedNotRefused(drive, where)
        self.assertWarnsThatItWaited(drive, wall, cpu, where)

    def assertCpuBoundUnitRunDoesNotWarn(self):
        where = f"{self.CLIENT}/{SCOPED_TIER} (cpu-bound)"
        drive, wall, cpu = self.drive_unit("spin")
        self.assertVerbAcceptedTheInvocation(drive, where)
        self.assertNoWallVsCpuWarning(drive, wall, cpu, where)
        if self.refused_for_no_declaration(drive):
            return
        self.assertRunWasReportedNotRefused(drive, where)

    # ── AC6b's two tests, written ONCE and inherited by every client ───────
    #
    # They live on this PLAIN mixin rather than on a shared `TestCase` base so
    # that unittest cannot collect them without a client: an abstract base
    # carrying test methods would run twice with `CLIENT = ""` and error, which
    # is a harness artefact masquerading as a finding.

    def test_a_unit_run_that_waits_carries_the_wall_vs_cpu_warning(self):
        self.assertUnitRunThatWaitsWarns()

    def test_a_cpu_bound_unit_run_carries_no_such_warning(self):
        self.assertCpuBoundUnitRunDoesNotWarn()


# ── the five clients, each probed on its own `unit` verb ───────────────────


class MvnUnitRunThatWaitsTest(_WallVsCpuProbe, _MODALITY._MvnModalityCase):
    """RED (positive half) — `./mvnw clean test -B` under a toolchain that
    sleeps reads 24.5x on this machine and is reported as an ordinary unit run.
    PIN (negative half) — the CPU-bound drive reads 1.02x and warns nothing,
    today because nothing warns at all."""

    def unit_argv(self):
        return self.mvn_argv(SCOPED_TIER)

    def write_unit_fixture(self):
        self.write_reports()


class RustUnitRunThatWaitsTest(_WallVsCpuProbe, _MODALITY._RustModalityCase):
    """RED (positive half) — `cargo nextest run -p <c> --lib -P ci` under a
    sleeping toolchain reads 25.0x. PIN (negative half), as above."""

    def unit_argv(self):
        return self.rust_argv(SCOPED_TIER, ["--crate", self.CRATE])

    def write_unit_fixture(self):
        self.write_nextest_junit()


class ArduinoUnitRunThatWaitsTest(_WallVsCpuProbe, _MODALITY._ArduinoModalityCase):
    """RED (positive half) — `make junit` in the native dir under a sleeping
    toolchain reads 23.8x. PIN (negative half), as above."""

    def unit_argv(self):
        return self.arduino_argv(SCOPED_TIER, ["--dir", self.NATIVE_DIR])

    def write_unit_fixture(self):
        self.write_native_reports()


class BunUnitRunThatWaitsTest(_WallVsCpuProbe, _MODALITY._BunModalityCase):
    """PIN, both halves — ESCALATION 2. `bun test` splits no tiers, so bun's
    `unit` is a declared cell with no declaration and answers cycle 377's hard
    stop: nothing runs, so nothing is measured. The probe arms itself the
    moment that cell becomes runnable."""

    def unit_argv(self):
        return self.bun_argv(SCOPED_TIER, with_bun=False)


class PythonUnitRunThatWaitsTest(_WallVsCpuProbe, _MODALITY._PythonModalityCase):
    """PIN, both halves — ESCALATION 2, python's half. `unittest` discovery has
    no tier notion, so this cell refuses until the project declares a
    start-dir."""

    def unit_argv(self):
        return self.py_argv(SCOPED_TIER)


_PROBED_CLIENTS = {
    "mvn": MvnUnitRunThatWaitsTest,
    "rust": RustUnitRunThatWaitsTest,
    "arduino": ArduinoUnitRunThatWaitsTest,
    "bun": BunUnitRunThatWaitsTest,
    "python": PythonUnitRunThatWaitsTest,
}


# ── rule 15: the check is the FLEET's, not one client's ────────────────────


class FleetReachTest(unittest.TestCase):
    """"The client warns" is satisfiable by ONE client. §S4 puts the check
    where `add_tier_verbs` already is — `clients/_crucible_axi.py` — so the
    reach is asserted three ways: every client that registers tier verbs is
    probed here (census, DERIVED), the shared module NAMES the warning, and
    every warning the fleet actually emits carries that one shared code."""

    def test_every_client_registering_tier_verbs_is_probed_here(self):
        """PIN — the census, scanned rather than frozen. A sixth client cannot
        join the fleet without joining this file."""
        fleet = _tier_verb_clients()
        self.assertEqual(
            set(fleet), set(_PROBED_CLIENTS),
            f"AC6b reaches EVERY client with a `{SCOPED_TIER}` verb: the "
            f"clients registering tier verbs are {sorted(fleet)!r} and this "
            f"file probes {sorted(_PROBED_CLIENTS)!r}")
        self.assertGreater(
            len(fleet), 1,
            "a fleet-wide check asserted in one client is the defect rule 15 "
            "names; the scan found a single client")
        self.assertTrue(
            _clients_with_a_unit_split_cell() <= set(fleet),
            f"§S3 gives {sorted(_clients_with_a_unit_split_cell())!r} a "
            f"`{SCOPED_TIER}` split cell, so each must be in the tier-verb "
            f"fleet; the scan found {sorted(fleet)!r}")

    def test_the_shared_module_names_the_wall_vs_cpu_warning(self):
        """RED — the warning's code lives in `clients/_crucible_axi.py` beside
        `TIER_RUN_UNDECLARED_CODE`, so five clients cannot spell it five ways.
        The NAME is ruled in this file's docstring on cycle 377's precedent."""
        self.assertTrue(
            hasattr(_AXI, WALL_VS_CPU_CODE_CONST),
            f"§S4's check belongs in the SHARED module: "
            f"`clients/_crucible_axi.py` must expose "
            f"`{WALL_VS_CPU_CODE_CONST}` the way it already exposes "
            f"`TIER_RUN_UNDECLARED_CODE`, so no client carries its own copy "
            f"of the code a consumer matches on")
        self.assertEqual(
            getattr(_AXI, WALL_VS_CPU_CODE_CONST, None), WALL_VS_CPU_CODE,
            f"the code is `{WALL_VS_CPU_CODE}` — ruled here rather than left "
            f"to GREEN, so this AC fails on a defect and never on a naming "
            f"disagreement (AC4's own precedent for `add_tier_verbs`)")


class FleetWarningIsOneDefinitionTest(unittest.TestCase):
    """Every client whose `unit` cell RUNS must warn, and with the SAME code.
    Driving all of them in one test is what makes the answer a fleet fact: a
    patch that taught maven to measure and left cargo alone passes every
    per-client positive test but one, and fails this."""

    def _drive_every_client(self, mode):
        outcomes = {}
        for client, case_class in sorted(_PROBED_CLIENTS.items()):
            case = case_class(
                "test_a_unit_run_that_waits_carries_the_wall_vs_cpu_warning")
            case.setUp()
            try:
                drive, wall, cpu = case.drive_unit(mode)
                axi = case.envelope(drive)
                outcomes[client] = {
                    "refused": case.refused_for_no_declaration(drive),
                    "codes": sorted({w.get("code")
                                     for w in (axi.get("warnings") or [])
                                     if isinstance(w, dict)}),
                    "matched": len(case.wall_vs_cpu_warnings(drive)),
                    "wall": wall,
                    "cpu": cpu,
                }
            finally:
                case.tearDown()
        return outcomes

    def test_every_client_whose_unit_cell_runs_warns_when_it_waits(self):
        """RED — no client measures CPU at all today, so all three runnable
        cells report a sleeping suite as an ordinary unit run."""
        outcomes = self._drive_every_client("sleep")
        ran = {c: o for c, o in outcomes.items() if not o["refused"]}
        self.assertTrue(
            _clients_with_a_unit_split_cell() <= set(ran),
            f"this test may not pass because every client refused: §S3 gives "
            f"{sorted(_clients_with_a_unit_split_cell())!r} a runnable "
            f"`{SCOPED_TIER}` cell and only {sorted(ran)!r} ran. "
            f"outcomes={outcomes!r}")
        silent = {c: (round(o["wall"], 3), round(o["cpu"], 3), o["codes"])
                  for c, o in ran.items() if o["matched"] != 1}
        self.assertEqual(
            silent, {},
            f"AC6b is a FLEET requirement — the check belongs in the shared "
            f"module and is reached from every client that runs a "
            f"`{SCOPED_TIER}` tier. These clients ran a sleeping unit suite "
            f"and reported it as an ordinary unit run "
            f"(wall, cpu, warning codes): {silent!r}")

    def test_no_cpu_bound_unit_run_in_the_fleet_warns(self):
        """PIN — the fleet-wide negative. Passes today because nothing warns;
        after GREEN it is the bound that stops a check from becoming a rubber
        stamp applied to every unit run in five clients at once."""
        outcomes = self._drive_every_client("spin")
        noisy = {c: (round(o["wall"], 3), round(o["cpu"], 3))
                 for c, o in outcomes.items() if o["matched"]}
        self.assertEqual(
            noisy, {},
            f"a unit run that spends its whole wall clock computing is the "
            f"honest case (§S4 measures a real unit suite at 1.09x); these "
            f"clients warned about it anyway (wall, cpu): {noisy!r}")


# ── the bound the ruled mechanism rests on ─────────────────────────────────


class AttributionBoundTest(unittest.TestCase):
    """PIN — ESCALATION 1. `RUSAGE_CHILDREN` is a per-PROCESS cumulative
    counter, so a delta taken around one `subprocess.run` is attributable to
    THAT child only while the verb spawns exactly one. Every `unit` verb does
    today; `mvn e2e` already does not (docker, then mvnw). This test holds the
    bound AC6b's mechanism rests on, so a `unit` verb that grew a second child
    fails here rather than silently reporting the pair's CPU as the suite's."""

    def test_every_runnable_unit_verb_spawns_exactly_one_child(self):
        offenders = {}
        probed = 0
        for client, case_class in sorted(_PROBED_CLIENTS.items()):
            case = case_class("test_a_cpu_bound_unit_run_carries_no_such_warning")
            case.setUp()
            try:
                drive, _wall, _cpu = case.drive_unit("spin")
                if case.refused_for_no_declaration(drive):
                    continue
                probed += 1
                children = [r["tool"] for r in case.invocations()]
                if len(children) != 1:
                    offenders[client] = children
            finally:
                case.tearDown()
        self.assertEqual(
            offenders, {},
            f"§S4 rules the mechanism as `RUSAGE_CHILDREN` deltas 'taken "
            f"around the existing subprocess.run call'. That delta is "
            f"attributable to the test run only while the verb spawns ONE "
            f"child; these spawn more, so their CPU figure would sum "
            f"processes the suite did not run: {offenders!r}")
        self.assertEqual(
            probed, len(_clients_with_a_unit_split_cell()),
            f"the bound is only held over the cells that actually ran; "
            f"§S3 gives {sorted(_clients_with_a_unit_split_cell())!r} a "
            f"runnable `{SCOPED_TIER}` cell and {probed} ran")


if __name__ == "__main__":
    unittest.main()
