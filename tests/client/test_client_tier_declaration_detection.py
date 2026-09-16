"""CR-CRU-111 §S6 — a DECLARED target is DETECTED and RUN (AC14), the refusal is
REACHABLE-PAST (AC14a), a refusal never names a flag its own verb rejects
(AC14b), and rust's `regression` cell runs the body it already has while `bdd`
becomes producible (AC14c).

Four acceptance criteria live here and they are the four cycle 384 owns. §S6 is
the half of §S3 that did not ship: "every client's `funcs` map is a static
literal, nothing reads a declaration, and so 18 of the 30 cells refuse
unconditionally — including cells whose target the project HAS declared". So
every test below builds a fixture project that CARRIES a real declaration at
the surface §S6 names for that stack, and then asks the client to run it:

  | client  | reads                                             | runs           |
  |---------|---------------------------------------------------|----------------|
  | bun     | a `package.json` script named for the tier        | that script    |
  | python  | a per-tier discovery declaration (start-dir/patt) | that discovery |
  | mvn     | a profile in `pom.xml` bound to the tier          | mvn under it   |
  | rust    | a profile in `.config/nextest.toml` for the tier  | nextest under it |
  | arduino | a native-host `make` target named for the tier    | that target    |

  * **AC14** — "a DECLARED target that the project HAS declared RUNS, per
    stack … Each asserts three things together, because any one alone is
    passable while broken: the declared command is what the client invoked, the
    run is ingested, and the POST body carries the VERB's tier."
  * **AC14a** — "the refusal is REACHABLE-PAST: for each stack, the same cell
    that refuses with no declaration RUNS once the declaration named in that
    refusal's `help[]` is added, and nothing else about the invocation
    changes."
  * **AC14b** — "a refusal never names a flag its own verb rejects … Asserted
    per stack by driving the instruction the help gives."
  * **AC14c** — "rust's `regression` cell runs its existing workspace-regression
    body rather than refusing, and `bdd` is producible on at least one stack via
    a declared target, which is what makes AC2's sixth value assertable."

WHICH CELL EACH STACK IS ASSERTED ON, and why it is not the same tier five
times: the cell must be one this client REFUSES today, or the AC is
unfalsifiable — a cell already wired would pass without any detection existing.
`DECLARED_CELLS` below picks one refusing cell per stack (bun/python `unit`,
mvn `bdd`, rust `module`, arduino `integration`), which is also why the five
span four different tiers: what §S3 calls a declared cell is a property of the
CELL, never of the client. `DeclaredCellCoverageTest` asserts that property
rather than trusting this paragraph.

HOW THE INVOCATION IS MEASURED: cycle 379's fake-toolchain harness, adopted
whole — every toolchain reachable from a drive is a tiny fake EXECUTABLE that
records its own `argv` and `cwd` to `$FAKE_ARGV_LOG`. "The declared command is
what the client invoked" is therefore read out of what the operating system was
actually asked to run, and the same log answers the converse (a refusal invokes
nothing). No real bun/python/mvn/cargo/make is reachable, and no request leaves
the process: the client's `_post`/`_get`/`_patch` seam is recorded, so the live
board on :3849 is never touched.

HOW AC14a AND AC14b READ THE INSTRUCTION: out of the refusal's OWN `help[]`,
never out of a constant in this file. Each fixture's `declare_from_help` parses
the emitted steps — the quoted `"test:unit": "bun test <paths>"` example, the
`--start-dir`/`--pattern` flags, the `pom.xml` / `.config/nextest.toml` /
`Makefile` artefact names, the `` `make junit-integration` `` example — and
materialises exactly that, re-tiered to the cell under drive. That is the whole
point of AC14a: "'the refusal names a surface' (AC6a) is satisfied by naming a
surface that does nothing, which is what shipped", and only an instruction that
is FOLLOWED programmatically can catch it.

HOW THE COUNT IS DERIVED, and why it is not a frozen fleet dict: `FLEET` is
globbed from `clients/*-crucible.py`, so a sixth client added to the fleet makes
`DeclaredCellCoverageTest` fail rather than pass with five green stacks. Three
of the existing tier-suite files hardcode the fleet; VERIFY flagged it, and this
file uses the derived form.

MEASURED ON `feature/CR-CRU-111` @ `5fcd309` (cycles 377-382 merged),
2026-09-08 — what is RED here and what is a PIN, stated per test, because a
suite that does not say which of its members were born green is a suite whose
colour means nothing:

  RED  every `…DeclaredTargetRunsTest` (all five stacks, AC14). No client
         reads a declaration at all: `funcs` is a static literal in all five,
         so the declared cell answers `tier-run-undeclared` — and on bun,
         python and arduino it does not even ACCEPT the flags a run needs, so
         argparse refuses first (exit 2).
  RED  every `…RefusalIsReachablePastTest` (all five stacks, AC14a). The pair
         is: refuse → add exactly what the `help[]` named → drive again. The
         second drive answers the identical refusal, which is VERIFY's
         measurement generalised from bun to the fleet: "an instruction that
         changes nothing when followed is worse than no instruction".
  RED  every `…RefusalNamesNothingItsVerbRejectsTest` (all five, AC14b), on
         one of two faces. python and arduino name FLAGS their own verb
         rejects: `python-crucible.py unit --start-dir … --pattern …` exits 2
         with `unrecognized arguments` (the AC's own cited measurement), and
         arduino's refusal names `--dir` while the `integration` verb that
         printed it has no `--dir`. bun, mvn and rust name an ARTEFACT
         (`package.json`, `pom.xml`, `.config/nextest.toml`) whose route does
         nothing.
  RED  `RustRegressionCellRunsItsWorkspaceRegressionBodyTest` (AC14c) — rust
         refuses `regression` while shipping a regression body that posts
         `tier="regression"` today: "refusing it was the client declining work
         it demonstrably does".
  RED  `BddIsProducibleThroughADeclaredTargetTest` (AC14c) — `bdd` is absent
         from every client's `funcs` map, so no invocation can put
         `"tier": "bdd"` on the wire and AC2's sixth value is unassertable
         until it can.
  PIN  `DeclaredCellCoverageTest` — the instrument, not the subject: the
         derived fleet size, the one-cell-per-client bound, and the check that
         every cell driven here is a DECLARED cell rather than one §S3's matrix
         already splits. It fails when this file stops driving a stack, which
         is how a per-stack requirement silently shrinks to one example.

ESCALATIONS recorded at the time of writing (full text in the report):

  1. python's declaration surface is the only one of the five that is not a
     project ARTEFACT: §S6 calls it "a per-tier discovery declaration
     (start-dir/pattern)" and the shipped refusal names the FLAGS
     (`--start-dir tests/<tier> --pattern 'test_*.py'`). So on python "the
     project has declared it" is stated per INVOCATION, not per project, and
     this file asserts the flags — which is also exactly what AC14b demands be
     accepted. No config format is invented here; if the ruling is that python
     must read a project FILE instead, `_PythonDeclarationCase.declare` and
     `declare_from_help` are the two places to retarget.
  2. AC14 says "the declared command is what the client invoked" and does not
     say whether bun runs the script BY NAME (`bun run test:unit`) or by its
     BODY (`bun test tests/unit`). Both are the declared command, so both are
     accepted here; a run of the bare full suite is neither.
  3. §S6's rust consequence names `_regression_ingest_run` as "the
     workspace-regression body it already has", and those are two different
     bodies in the shipped client: `_regression_ingest_run` is the per-crate
     `-p <crate>` coverage regression (it posts `tier="regression"`,
     `clients/rust-crucible.py:952`) and `_workspace_regression_run` is the
     `--workspace` one (it posts NO tier at all). This file asserts the
     OBSERVABLE both share — cargo runs a nextest regression that is not the
     `--lib` unit selection, and the ingest carries `regression` — so it holds
     whichever body GREEN wires. Which body is meant still needs a ruling.
  4. The flags a declared tier verb must ACCEPT are nowhere stated. Each drive
     here passes that client's own existing convention for a verb that runs
     tests (`--agent` everywhere, plus `--bun`, `--python`/`--reports`,
     `--maven-dir`, `--dir`) — the same set its `regression`/`unit` sibling
     already takes. A GREEN that wires the cells but attaches different flags
     fails these tests on argparse; that is a real finding either way (AC14b
     forbids a refusal naming a flag the verb rejects), but the flag set itself
     is this file's reading, not the CR's words.
  5. arduino's declared target NAME is read from its own refusal's example
     (`` `make junit-integration` `` → `junit-<tier>`). The CR names no naming
     convention for the five stacks' script/profile/target names; every fixture
     here takes the name from the client's own printed instruction, which is
     the only source that cannot drift from what the client will look for.

HARNESS: `tests/client/test_client_tier_run_modality.py` (cycle 379), which is
itself `tests/client/test_client_tier_stamping.py`'s `_ClientDriveCase` (cycle
378) plus the fake-toolchain argv log. Both are ADOPTED, not re-invented: this
file imports the per-client fixtures and the module-level toolchain setup and
adds only what §S6 needs — a project that has DECLARED something.

Invocation:
    python3 -m pytest tests/client/test_client_tier_declaration_detection.py -q
Fallback:
    python3 tests/client/test_client_tier_declaration_detection.py
"""

import importlib.util
import json
import os
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENTS_DIR = REPO_ROOT / "clients"
MODALITY_PATH = Path(__file__).resolve().parent / "test_client_tier_run_modality.py"


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Cycle 379's harness, adopted whole. Only NON-test names are taken: importing
# one of its TestCases would run that cycle's suite a second time under this
# module. Its module fixture (the fake toolchains on PATH) is adopted BY NAME,
# so this file's toolchains are built and torn down by the same code that
# built cycle 379's.
_MODALITY = _load_module(MODALITY_PATH, "cr111_c8_modality_harness")

setUpModule = _MODALITY.setUpModule
tearDownModule = _MODALITY.tearDownModule

_ModalityCase = _MODALITY._ModalityCase
_BunModalityCase = _MODALITY._BunModalityCase
_PythonModalityCase = _MODALITY._PythonModalityCase
_MvnModalityCase = _MODALITY._MvnModalityCase
_RustModalityCase = _MODALITY._RustModalityCase
_ArduinoModalityCase = _MODALITY._ArduinoModalityCase
_fake = _MODALITY._fake

# The harness's own probe agent id, taken rather than re-spelled: the drive's
# `ingest_payloads` reads the POST bodies that carry THIS id, so a second
# constant here would silently make every ingest assertion measure nothing.
AGENT = _MODALITY.AGENT
TIER_VOCABULARY = _MODALITY.TIER_VOCABULARY
TIER_RUN_UNDECLARED_CODE = _MODALITY.TIER_RUN_UNDECLARED_CODE
TEST_INGEST_ENDPOINTS = _MODALITY.TEST_INGEST_ENDPOINTS
_JUNIT_SUITE_ONE_PASS = _MODALITY._JUNIT_SUITE_ONE_PASS
_JUNIT_SUITES_ONE_PASS = _MODALITY._JUNIT_SUITES_ONE_PASS


# ── the fleet, DERIVED ─────────────────────────────────────────────
#
# AC14 asks for "five assertions and the count asserted", and a frozen five is
# the census defect VERIFY flagged in three sibling files: a sixth client would
# join the fleet and this suite would keep passing while never driving it. The
# fleet is what `clients/` contains.
_CLIENT_SUFFIX = "-crucible.py"
CLIENT_FILES = tuple(sorted(p.name for p in CLIENTS_DIR.glob("*" + _CLIENT_SUFFIX)))
FLEET = tuple(name[: -len(_CLIENT_SUFFIX)] for name in CLIENT_FILES)

# §S6's table, transcribed ONCE: the cell each stack is asserted on. Every one
# of them REFUSES today, which is what makes AC14 falsifiable — a cell the
# client already runs would pass with no detection mechanism in existence.
DECLARED_CELLS = {
    "bun": "unit",
    "python": "unit",
    "mvn": "bdd",
    "rust": "module",
    "arduino": "integration",
}

# What counts as a project ARTEFACT named in a refusal (AC14b's second face).
# Derived from the text rather than listed per stack: a refusal that names a
# file is instructing a route that must work.
_ARTEFACT_RE = re.compile(r"[A-Za-z0-9_./-]*\.(?:json|xml|toml)|Makefile")
# A long flag named anywhere in the refusal's own steps (AC14b's first face).
_FLAG_RE = re.compile(r"(?<![\w-])--[a-z][a-z0-9-]*")
# `--flag value` as the refusal spells it, so a driven instruction uses the
# refusal's OWN example value rather than one this file invented.
_FLAG_VALUE_RE = re.compile(
    r"(--[a-z][a-z0-9-]*)[= ]+('[^']*'|\"[^\"]*\"|[^\s`)\"']+)")


def _named_flags(blob):
    return sorted(set(_FLAG_RE.findall(blob)))


def _named_artefacts(blob):
    return sorted({m.group(0).strip("`") for m in _ARTEFACT_RE.finditer(blob)
                   if m.group(0).strip("`")})


def _flag_values_from_help(blob):
    """`{flag: example value}` as the refusal itself spells them. A token that
    is another flag, a parenthetical or an em-dash continuation is not a value:
    those flags fall back to the fixture's own default."""
    values = {}
    for match in _FLAG_VALUE_RE.finditer(blob):
        value = match.group(2).strip("'\"")
        if not value or value.startswith(("-", "(", "\u2014")):
            continue
        values.setdefault(match.group(1), value)
    return values


def _retier(text, tier):
    """The refusal's example, re-pointed at the cell under drive: `<tier>` and
    any tier NAME the example happens to use become this tier. So a help whose
    example reads `"test:unit"` declares `test:bdd` when the cell is `bdd`, and
    the instruction is FOLLOWED rather than transcribed."""
    out = text.replace("<tier>", tier)
    for name in sorted(TIER_VOCABULARY, key=len, reverse=True):
        out = re.sub(rf"(?<![A-Za-z]){re.escape(name)}(?![A-Za-z])", tier, out)
    return out


def _contains(argv, sequence):
    seq = list(sequence)
    return any(argv[i:i + len(seq)] == seq
               for i in range(len(argv) - len(seq) + 1))


POM_WITH_TIER_PROFILE = """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>crucible.probe</groupId>
  <artifactId>tier-probe</artifactId>
  <version>1.0.0</version>
  <profiles>
    <profile>
      <id>__PROFILE__</id>
      <build>
        <plugins>
          <plugin>
            <artifactId>maven-surefire-plugin</artifactId>
            <configuration>
              <includes>
                <include>**/*Probe.java</include>
              </includes>
            </configuration>
          </plugin>
        </plugins>
      </build>
    </profile>
  </profiles>
</project>
"""

CARGO_TOML = """[package]
name = "tier_probe"
version = "0.1.0"
edition = "2021"
"""

# The `ci` sibling every real cargo project has, carrying junit of its own:
# §S6/AC14a's measured trap. A profile does NOT inherit a sibling's junit
# configuration (only `default`'s), so a fixture whose declaration stops at
# `[profile.<tier>]` would run and produce no report — which is what makes the
# junit sub-table below part of the declaration rather than decoration.
NEXTEST_TOML = """[profile.default]
retries = 0

[profile.ci]
retries = 0

[profile.ci.junit]
path = "junit.xml"

[profile.__PROFILE__]
retries = 0
fail-fast = false

[profile.__PROFILE__.junit]
path = "junit.xml"
"""

# A backtick-quoted fragment of the refusal that is TOML: a table header, or a
# `key = value`. Used to build a declaration out of the printed instruction and
# nothing else — see `_RustDeclarationCase.declare_from_help`.
_TOML_FRAGMENT_RE = re.compile(r"`([^`]+)`")
_TOML_LINE_RE = re.compile(r"^(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_-]*\s*=\s*\S.*)$")


# ── the shared body: declare, drive, and read what actually ran ────────────


class _DeclarationProbe:
    """§S6's three-part measurement, once. A per-stack fixture supplies four
    facts — the toolchain the invocation is read off, the argv a run of a
    declared cell takes, how §S6's declaration is written, and how the SAME
    declaration is derived from the refusal's own `help[]` — and every assertion
    below is shared, so no stack can be asserted more weakly than another."""

    TOOL = ""

    # ── the facts a per-stack fixture supplies ─────────────────────────

    def refuse_argv(self, tier):
        """The MINIMUM this client's tier verb accepts today — so a refusal is
        read as a refusal and never as an argparse usage error."""
        raise NotImplementedError

    def run_argv(self, tier, extra=()):
        """The argv a run of a DECLARED cell takes on this stack (ESCALATION
        4)."""
        raise NotImplementedError

    def declare(self, tier):
        """Write §S6's declaration for `tier` into the fixture project; return
        any extra argv the declaration itself is stated in."""
        raise NotImplementedError

    def declare_from_help(self, steps, tier):
        """The same declaration, DERIVED from the refusal's own `help[]`."""
        raise NotImplementedError

    def declaration_text(self):
        """What was declared, for the failure message."""
        raise NotImplementedError

    def expected_invocations(self, tier):
        """Argv subsequences, ANY of which is the declared command."""
        raise NotImplementedError

    def flag_value_default(self, flag, tier):
        """A value for a flag the refusal names without an example of one."""
        return tier

    # ── the three assertions AC14 makes TOGETHER ───────────────────────

    def assertReachedTheVerb(self, drive, cell, declaration, ac="AC14", tier=None):
        """The non-vacuity bound every drive here needs: argparse's own usage
        refusal (exit 2) means the verb never ran, so anything asserted after it
        measured the CLI surface and not the declaration.

        When it fires, the SAME declared project is driven once more with only
        the flags this verb does accept, and what it answers is carried in the
        message — so the failure states §S6's own measurement (the declaration
        is present and the client still refuses) and not merely a missing
        flag."""
        if not (drive.code == 2 or "unrecognized arguments" in drive.err
                or "invalid choice" in drive.err):
            return
        still = ""
        if tier is not None:
            probe = self.drive(self.refuse_argv(tier))
            line = next((l for l in probe.err.splitlines()
                         if TIER_RUN_UNDECLARED_CODE in l), "")
            if line:
                still = (f" Driven with only the flags this verb DOES accept, "
                         f"and with the declaration in place, the same cell "
                         f"answers {line.strip()!r} — which is §S6's own "
                         f"measurement: an instruction that changes nothing "
                         f"when followed.")
        self.fail(
            f"{ac} — {cell}: this project HAS declared the tier's target "
            f"({declaration}), and the verb refused the invocation before any "
            f"of it was read (exit={drive.code}). A tier verb that cannot even "
            f"ACCEPT the flags a run of it needs is registered as a refusal, "
            f"never as a run: {drive.err[-400:]!r}{still}")

    def assertDidNotRefuseAsUndeclared(self, drive, cell, declaration):
        self.assertFalse(
            self.refused_for_no_declaration(drive),
            f"AC14 — {cell}: the project declared this tier's target "
            f"({declaration}) at the surface §S6 names for this stack, and the "
            f"client still answered {TIER_RUN_UNDECLARED_CODE}. §S6: '18 of the "
            f"30 cells refuse unconditionally — including cells whose target "
            f"the project HAS declared'. stderr={drive.err[-600:]!r}")

    def assertRanTheDeclaredCommand(self, drive, cell, tier, declaration):
        runs = self.invocations(self.TOOL)
        self.assertTrue(
            runs,
            f"AC14 — {cell}: the declared command must be what the client "
            f"INVOKED ({declaration}), and {self.TOOL} was not invoked once. "
            f"invocations={self.invocations()!r} exit={drive.code} "
            f"stdout={drive.out[-1000:]!r} stderr={drive.err[-1000:]!r}")
        wanted = self.expected_invocations(tier)
        for run in runs:
            for sequence in wanted:
                if _contains(run["argv"], list(sequence)):
                    return runs
        self.fail(
            f"AC14 — {cell}: the client ran {self.TOOL}, but not the DECLARED "
            f"target ({declaration}): none of {[list(s) for s in wanted]!r} "
            f"appears in {[r['argv'] for r in runs]!r}. Running something else "
            f"under this tier's name is the same dishonesty as refusing it, "
            f"pointed the other way.")

    def assertIngestedVerbTier(self, drive, tier, cell):
        payloads = self.ingest_payloads(drive)
        self.assertTrue(
            payloads,
            f"AC14 — {cell}: a detected declaration must produce an INGESTED "
            f"run; nothing reached the board, so this drive measured no tier "
            f"at all. posted={[p for p, _ in drive.calls]!r} "
            f"exit={drive.code} stderr={drive.err[-1000:]!r}")
        for payload in payloads:
            self.assertEqual(
                payload.get("tier"), tier,
                f"AC14 — {cell}: 'the tier that run reports is the verb's own' "
                f"(§S6), so a run driven by the DECLARED target still rides "
                f"under the verb that asked for it; the POST body carried "
                f"tier={payload.get('tier')!r}, expected {tier!r}.")

    def assertDeclaredCellRan(self, drive, cell, tier, declaration):
        """AC14's three-in-one: the declared command was invoked, the run was
        ingested, and the ingest carries the VERB's tier. Asserted together
        because 'any one alone is passable while broken'."""
        self.assertReachedTheVerb(drive, cell, declaration, tier=tier)
        self.assertDidNotRefuseAsUndeclared(drive, cell, declaration)
        self.assertRanTheDeclaredCommand(drive, cell, tier, declaration)
        self.assertIngestedVerbTier(drive, tier, cell)

    # ── the three shapes the four ACs are driven in ────────────────────

    def refusal_steps(self, tier):
        """The `help[]` this cell's refusal prints, with the refusal itself
        asserted first: a cell that does NOT refuse cannot be the cell AC14a
        and AC14b are about."""
        drive = self.drive(self.refuse_argv(tier))
        self.assertTrue(
            self.refused_for_no_declaration(drive),
            f"{self.CLIENT}/{tier}: this cell is asserted BECAUSE it refuses "
            f"with nothing declared — that is what makes AC14/AC14a "
            f"falsifiable. It did not refuse: exit={drive.code} "
            f"stdout={drive.out[-600:]!r}")
        steps = [str(s) for s in (self.envelope(drive).get("help") or [])]
        self.assertTrue(
            steps,
            f"{self.CLIENT}/{tier}: the refusal carries no help[] at all, so "
            f"there is no instruction to follow (AC6a).")
        self.assertEqual(
            self.invocations(), [],
            f"{self.CLIENT}/{tier}: a refusal runs nothing; it invoked "
            f"{self.invocations()!r}")
        return steps

    def assertDeclaredTargetRuns(self, tier):
        """AC14 — §S6's declaration, written as that table names it."""
        extra = self.declare(tier)
        drive = self.drive(self.run_argv(tier, extra))
        self.assertDeclaredCellRan(drive, f"{self.CLIENT}/{tier}", tier,
                                   self.declaration_text())

    def assertRefusalIsReachablePast(self, tier):
        """AC14a — the PAIR on one cell: refuse, add exactly what the refusal's
        own `help[]` said to add, change nothing else, run."""
        cell = f"{self.CLIENT}/{tier}"
        steps = self.refusal_steps(tier)
        extra = self.declare_from_help(steps, tier)
        drive = self.drive(self.run_argv(tier, extra))
        self.assertFalse(
            self.refused_for_no_declaration(drive),
            f"AC14a — {cell}: the refusal instructed '{steps[0]}', that "
            f"instruction was followed exactly ({self.declaration_text()}) and "
            f"nothing else about the invocation changed — and the client "
            f"answered the IDENTICAL refusal. §S6: 'an instruction that changes "
            f"nothing when followed is worse than no instruction'. "
            f"stderr={drive.err[-600:]!r}")
        self.assertDeclaredCellRan(drive, cell, tier, self.declaration_text())

    def assertRefusalNamesNothingItsVerbRejects(self, tier):
        """AC14b — drive the instruction the help gives: a named flag must be
        ACCEPTED by the verb that named it, and a named artefact must have a
        route that works."""
        cell = f"{self.CLIENT}/{tier}"
        steps = self.refusal_steps(tier)
        blob = " ".join(steps)
        flags = _named_flags(blob)
        artefacts = _named_artefacts(blob)
        self.assertTrue(
            flags or artefacts,
            f"AC14b — {cell}: the refusal names neither a flag nor a project "
            f"artefact, so it instructs nothing a caller can act on: "
            f"{steps!r}")

        if flags:
            with self.subTest(instruction="flags", flags=flags):
                examples = _flag_values_from_help(blob)
                argv = list(self.refuse_argv(tier))
                for flag in flags:
                    value = (_retier(examples[flag], tier) if flag in examples
                             else self.flag_value_default(flag, tier))
                    argv += [flag, value]
                drive = self.drive(argv)
                rejected = (drive.code == 2
                            or "unrecognized arguments" in drive.err
                            or "invalid choice" in drive.err)
                self.assertFalse(
                    rejected,
                    f"AC14b — {cell}: the refusal instructs {flags!r}, and the "
                    f"very verb that printed it REJECTS them "
                    f"(exit={drive.code}). A refusal naming a flag its own verb "
                    f"does not accept cannot be followed at all: "
                    f"{drive.err[-600:]!r}")

        if artefacts:
            with self.subTest(instruction="artefact", artefacts=artefacts):
                extra = self.declare_from_help(steps, tier)
                drive = self.drive(self.run_argv(tier, extra))
                # The non-vacuity bound this branch cannot do without: an
                # argparse usage error carries no refusal code, so without it a
                # verb that rejects the invocation outright would pass the
                # assertion below while never having read the artefact at all.
                self.assertReachedTheVerb(drive, cell, self.declaration_text(),
                                          ac="AC14b", tier=tier)
                self.assertFalse(
                    self.refused_for_no_declaration(drive),
                    f"AC14b — {cell}: the refusal instructs the caller to "
                    f"declare in {artefacts!r}, the artefact was written "
                    f"exactly as instructed ({self.declaration_text()}), and "
                    f"the route does nothing — the client never reads it and "
                    f"repeats the refusal: {drive.err[-600:]!r}")


# ── per-stack fixtures: §S6's five declaration surfaces ──────────────────


class _BunDeclarationCase(_BunModalityCase, _DeclarationProbe):
    """§S6, bun — 'reads: a `package.json` script named for the tier; runs: that
    script'."""

    TOOL = "fake-bun"

    def setUp(self):
        super().setUp()
        self.script = None
        self.command = None

    def refuse_argv(self, tier):
        return [tier, "--project-dir", self.tmpdir]

    def run_argv(self, tier, extra=()):
        return [tier, "--project-dir", self.tmpdir, "--agent", AGENT,
                "--bun", _fake("fake-bun")] + list(extra)

    def _write_suite(self, tier):
        directory = Path(self.tmpdir, "tests", tier)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{tier}.test.ts").write_text(
            'import { expect, test } from "bun:test";\n'
            'test("probe", () => { expect(1).toBe(1); });\n')
        os.environ["FAKE_BUN_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_PASS
        return f"tests/{tier}"

    def _write_package_json(self, script, command):
        self.script, self.command = script, command
        (Path(self.tmpdir) / "package.json").write_text(
            json.dumps({"name": "tier-probe", "private": True,
                        "scripts": {script: command}}, indent=2) + "\n")

    def declare(self, tier):
        paths = self._write_suite(tier)
        self._write_package_json(f"test:{tier}", f"bun test {paths}")
        return []

    def declare_from_help(self, steps, tier):
        blob = " ".join(steps)
        self.assertIn(
            "package.json", blob,
            f"AC14a — bun/{tier}: §S6 says bun reads a `package.json` script, "
            f"and the refusal names no such file: {steps!r}")
        example = re.search(r'"([A-Za-z0-9_.:-]+)"\s*:\s*"([^"]+)"', blob)
        self.assertIsNotNone(
            example,
            f"AC14a — bun/{tier}: the refusal must name the SCRIPT to declare "
            f"concretely enough to write it; it gives no '\"name\": \"body\"' "
            f"example: {steps!r}")
        paths = self._write_suite(tier)
        self._write_package_json(
            _retier(example.group(1), tier),
            _retier(example.group(2), tier).replace("<paths>", paths))
        return []

    def declaration_text(self):
        return f'`package.json` script "{self.script}": "{self.command}"'

    def expected_invocations(self, tier):
        # ESCALATION 2 — by NAME or by BODY; both are the declared command, and
        # a bare full-suite `bun test` is neither.
        return (["run", self.script], ["test", f"tests/{tier}"])


class _PythonDeclarationCase(_PythonModalityCase, _DeclarationProbe):
    """§S6, python — 'reads: a per-tier discovery declaration (start-dir/
    pattern); runs: that discovery' (ESCALATION 1)."""

    TOOL = "fake-python-runner"

    def setUp(self):
        super().setUp()
        self.start_dir = None
        self.pattern = None

    def refuse_argv(self, tier):
        return [tier, "--project-dir", self.tmpdir]

    def run_argv(self, tier, extra=()):
        return [tier, "--project-dir", self.tmpdir, "--agent", AGENT,
                "--python", _fake("fake-python-runner"),
                "--reports", "reports"] + list(extra)

    def _write_suite(self, start_dir):
        directory = Path(self.tmpdir, *start_dir.split("/"))
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "test_probe.py").write_text(
            "import unittest\n\n\n"
            "class TierProbeTest(unittest.TestCase):\n"
            "    def test_probe(self):\n"
            "        self.assertTrue(True)\n")
        os.environ["FAKE_PY_JUNIT_CONTENT"] = _JUNIT_SUITE_ONE_PASS

    def _declare(self, start_dir, pattern):
        self.start_dir, self.pattern = start_dir, pattern
        self._write_suite(start_dir)
        return ["--start-dir", start_dir, "--pattern", pattern]

    def declare(self, tier):
        return self._declare(f"tests/{tier}", "test_*.py")

    def declare_from_help(self, steps, tier):
        blob = " ".join(steps)
        values = _flag_values_from_help(blob)
        for flag in ("--start-dir", "--pattern"):
            self.assertIn(
                flag, values,
                f"AC14a — python/{tier}: §S6 says python reads a per-tier "
                f"discovery declaration, and the refusal gives no '{flag} "
                f"<value>' to follow: {steps!r}")
        return self._declare(_retier(values["--start-dir"], tier),
                             _retier(values["--pattern"], tier))

    def declaration_text(self):
        return (f"discovery declaration --start-dir {self.start_dir} "
                f"--pattern {self.pattern}")

    def expected_invocations(self, tier):
        return (["-s", self.start_dir],)

    def flag_value_default(self, flag, tier):
        return {"--start-dir": f"tests/{tier}",
                "--pattern": "test_*.py"}.get(flag, tier)


class _MvnDeclarationCase(_MvnModalityCase, _DeclarationProbe):
    """§S6, mvn — 'reads: a profile in `pom.xml` bound to the tier; runs: maven
    under that profile'."""

    TOOL = "fake-mvnw"

    def setUp(self):
        super().setUp()
        self.profile = None

    def refuse_argv(self, tier):
        return [tier, "--project-dir", self.tmpdir, "--maven-dir", self.tmpdir]

    def run_argv(self, tier, extra=()):
        return self.mvn_argv(tier, extra)

    def _declare(self, profile):
        self.profile = profile
        (Path(self.tmpdir) / "pom.xml").write_text(
            POM_WITH_TIER_PROFILE.replace("__PROFILE__", profile))
        # Either half of maven's report surface satisfies the ingest: which one
        # a declared profile binds is the PROJECT's decision, never this test's.
        self.write_reports()
        self.write_reports(kind="failsafe", name="TEST-ProbeIT.xml")
        return []

    def declare(self, tier):
        return self._declare(tier)

    def declare_from_help(self, steps, tier):
        blob = " ".join(steps)
        self.assertIn(
            "pom.xml", blob,
            f"AC14a — mvn/{tier}: §S6 says mvn reads a profile in `pom.xml`, "
            f"and the refusal names no such file: {steps!r}")
        return self._declare(tier)

    def declaration_text(self):
        return f"`pom.xml` profile <id>{self.profile}</id>"

    def expected_invocations(self, tier):
        return ([f"-P{tier}"], ["-P", tier], ["--activate-profiles", tier])


class _RustDeclarationCase(_RustModalityCase, _DeclarationProbe):
    """§S6, rust — 'reads: a profile in `.config/nextest.toml` named for the
    tier; runs: nextest under that profile'."""

    TOOL = "cargo"

    def setUp(self):
        super().setUp()
        self.profile = None
        self.declared_toml = None
        (Path(self.tmpdir) / "Cargo.toml").write_text(CARGO_TOML)

    def refuse_argv(self, tier):
        return [tier, "--project-dir", self.tmpdir]

    def run_argv(self, tier, extra=()):
        return self.rust_argv(tier, extra)

    def _declare(self, profile, toml_text):
        """Write `toml_text` as this project's `.config/nextest.toml` and NOTHING
        else — no report is planted here.

        The fixture's fake cargo is nextest's own rule: it writes a report only
        where the config it was handed asks for one, under the profile it ran.
        So whether this cell can be ingested at all is decided by the
        DECLARATION under test, which is the property a fixture that
        hand-wrote `target/nextest/<profile>/junit.xml` destroyed — it supplied
        the half the instruction omitted and reported success."""
        self.profile = profile
        self.declared_toml = toml_text
        config = Path(self.tmpdir, ".config")
        config.mkdir(parents=True, exist_ok=True)
        (config / "nextest.toml").write_text(toml_text)
        # The RUN's output, exactly as bun's and python's fakes take theirs —
        # what a passing suite prints, never where it is written to.
        os.environ["FAKE_CARGO_JUNIT_CONTENT"] = _JUNIT_SUITES_ONE_PASS
        return []

    def declare(self, tier):
        return self._declare(tier, NEXTEST_TOML.replace("__PROFILE__", tier))

    def declare_from_help(self, steps, tier):
        """AC14a's own property, restored: the declaration is BUILT OUT OF the
        printed instruction — every backtick-quoted TOML fragment the refusal
        gave, in the order it gave them, and not one line this file supplies.

        An instruction that names only `[profile.<tier>]` therefore produces a
        config with only `[profile.<tier>]`, nextest writes no report for it,
        and the cell cannot be ingested — which is how this test FAILS when the
        printed instruction is insufficient rather than passing on a fixture's
        good manners."""
        blob = " ".join(steps)
        self.assertIn(
            "nextest.toml", blob,
            f"AC14a — rust/{tier}: §S6 says rust reads a profile in "
            f"`.config/nextest.toml`, and the refusal names no such file: "
            f"{steps!r}")
        lines = [f for f in _TOML_FRAGMENT_RE.findall(blob)
                 if _TOML_LINE_RE.match(f.strip())]
        self.assertTrue(
            lines,
            f"AC14a — rust/{tier}: the refusal names `.config/nextest.toml` "
            f"but prints no TOML to put in it, so there is nothing to follow "
            f"— the caller is left to guess the declaration: {steps!r}")
        return self._declare(tier, "\n".join(lines) + "\n")

    def declaration_text(self):
        return (f"`.config/nextest.toml` = "
                f"{self.declared_toml!r} (profile {self.profile})")

    def expected_invocations(self, tier):
        return (["-P", tier], ["--profile", tier])


class _ArduinoDeclarationCase(_ArduinoModalityCase, _DeclarationProbe):
    """§S6, arduino — 'reads: a native-host `make` target named for the tier;
    runs: that target'."""

    TOOL = "make"

    def setUp(self):
        super().setUp()
        self.target = None

    def refuse_argv(self, tier):
        return [tier, "--project-dir", self.tmpdir]

    def run_argv(self, tier, extra=()):
        return self.arduino_argv(tier, ["--dir", self.NATIVE_DIR] + list(extra))

    def _declare(self, target):
        self.target = target
        directory = Path(self.native_dir())
        directory.mkdir(parents=True, exist_ok=True)
        # `junit` is the wired UNIT target this client already runs; the
        # declared one sits beside it, so a run that reached `make` but ran the
        # unit target fails `expected_invocations` instead of passing.
        (directory / "Makefile").write_text(
            "junit:\n\t@echo native unit\n\n"
            f"{target}:\n\t@echo native {target}\n")
        self.write_native_reports()
        return []

    def declare(self, tier):
        return self._declare(f"junit-{tier}")

    def declare_from_help(self, steps, tier):
        blob = " ".join(steps)
        self.assertIn(
            "Makefile", blob,
            f"AC14a — arduino/{tier}: §S6 says arduino reads a native-host "
            f"`make` target, and the refusal names no Makefile: {steps!r}")
        example = re.search(r"make\s+([A-Za-z0-9_.:-]+)", blob)
        self.assertIsNotNone(
            example,
            f"AC14a — arduino/{tier}: the refusal must name the TARGET to "
            f"declare concretely enough to write it; it gives no 'make "
            f"<target>' example: {steps!r}")
        return self._declare(_retier(example.group(1), tier))

    def declaration_text(self):
        return f"native-host Makefile target `{self.target}`"

    def expected_invocations(self, tier):
        return ([self.target],)

    def flag_value_default(self, flag, tier):
        return self.NATIVE_DIR if flag == "--dir" else tier


# ── AC14: a target the project HAS declared RUNS, per stack ───────────────


class BunDeclaredTargetRunsTest(_BunDeclarationCase):
    """AC14, bun — RED. VERIFY's own measurement, made an assertion: 'with
    "test:unit": "bun test tests/unit" present in `package.json`,
    `bun-crucible.py unit` still answers ok:false — declare this stack's unit
    target … then re-run'."""

    def test_a_declared_package_json_script_is_detected_and_run(self):
        self.assertDeclaredTargetRuns(DECLARED_CELLS["bun"])


class PythonDeclaredTargetRunsTest(_PythonDeclarationCase):
    """AC14, python — RED. The declared discovery is exactly the one the refusal
    instructs, and the verb rejects the flags it is stated in
    (ESCALATION 1)."""

    def test_a_declared_discovery_start_dir_is_detected_and_run(self):
        self.assertDeclaredTargetRuns(DECLARED_CELLS["python"])


class MvnDeclaredTargetRunsTest(_MvnDeclarationCase):
    """AC14, mvn — RED. `bdd` is maven's one declared cell (its lifecycle says
    nothing about BDD), so a `pom.xml` profile bound to it is the whole of §S6's
    maven row."""

    def test_a_declared_pom_profile_is_detected_and_run(self):
        self.assertDeclaredTargetRuns(DECLARED_CELLS["mvn"])


class RustDeclaredTargetRunsTest(_RustDeclarationCase):
    """AC14, rust — RED. Cargo describes no MODULE boundary, so `module` is
    rust's declared cell and `.config/nextest.toml` is where §S6 says the
    project states it."""

    def test_a_declared_nextest_profile_is_detected_and_run(self):
        self.assertDeclaredTargetRuns(DECLARED_CELLS["rust"])


class ArduinoDeclaredTargetRunsTest(_ArduinoDeclarationCase):
    """AC14, arduino — RED. §S3 ruled arduino's `integration` a DECLARED cell
    ('two directories behind one flag is not a distinction the client can
    READ'), so the native-host Makefile is where the project states it."""

    def test_a_declared_native_make_target_is_detected_and_run(self):
        self.assertDeclaredTargetRuns(DECLARED_CELLS["arduino"])


BunDeclaredTargetRunsTest.test_a_declared_package_json_script_is_detected_and_run.cell = (
    "bun", DECLARED_CELLS["bun"])
PythonDeclaredTargetRunsTest.test_a_declared_discovery_start_dir_is_detected_and_run.cell = (
    "python", DECLARED_CELLS["python"])
MvnDeclaredTargetRunsTest.test_a_declared_pom_profile_is_detected_and_run.cell = (
    "mvn", DECLARED_CELLS["mvn"])
RustDeclaredTargetRunsTest.test_a_declared_nextest_profile_is_detected_and_run.cell = (
    "rust", DECLARED_CELLS["rust"])
ArduinoDeclaredTargetRunsTest.test_a_declared_native_make_target_is_detected_and_run.cell = (
    "arduino", DECLARED_CELLS["arduino"])

_AC14_CASES = (BunDeclaredTargetRunsTest, PythonDeclaredTargetRunsTest,
               MvnDeclaredTargetRunsTest, RustDeclaredTargetRunsTest,
               ArduinoDeclaredTargetRunsTest)


class DeclaredCellCoverageTest(unittest.TestCase):
    """AC14's count — 'Five assertions and the count asserted' — DERIVED from
    `clients/*-crucible.py` rather than from a frozen fleet dict.

    PIN — the instrument, not the subject. It fails when a client joins the
    fleet undriven, when this file stops driving one, or when a cell driven
    above stops being a DECLARED cell — which is how a per-stack requirement
    shrinks to one example unnoticed."""

    def _driven_cells(self):
        driven = {}
        for case in _AC14_CASES:
            for name in dir(case):
                if not name.startswith("test_"):
                    continue
                cell = getattr(getattr(case, name), "cell", None)
                if cell is not None:
                    driven.setdefault(cell, []).append(f"{case.__name__}.{name}")
        return driven

    def test_every_client_in_the_fleet_has_its_declared_target_asserted(self):
        driven = {client for client, _tier in self._driven_cells()}
        self.assertEqual(
            driven, set(FLEET),
            f"AC14 is per STACK: the fleet is {sorted(FLEET)!r} (globbed from "
            f"clients/*{_CLIENT_SUFFIX}) and this file asserts a declared "
            f"target on {sorted(driven)!r}. A stack whose declaration surface "
            f"is never driven is a stack where §S6 is unasserted.")

    def test_the_asserted_count_is_the_fleets_own_size(self):
        cells = self._driven_cells()
        self.assertEqual(
            len(FLEET), len(CLIENT_FILES),
            "the fleet size is derived from the client files themselves, "
            "never frozen")
        self.assertEqual(
            len(cells), len(FLEET),
            f"AC14 asks for one declared-target assertion per client and the "
            f"fleet has {len(FLEET)}; this file drives {sorted(cells)!r}")
        self.assertGreater(
            len(FLEET), 1,
            "a fleet of one would make AC14's per-stack requirement "
            "unfalsifiable")

    def test_each_asserted_cell_is_one_its_client_declares_rather_than_splits(self):
        """The bound that keeps AC14 falsifiable: every cell driven above is one
        §S3 leaves to a project DECLARATION, never one the toolchain already
        splits — a split cell runs today and would pass with no detection
        mechanism in existence."""
        split = _MODALITY.TOOLCHAIN_SPLIT_CELLS
        for client, tier in sorted(self._driven_cells()):
            with self.subTest(cell=f"{client}/{tier}"):
                self.assertNotIn(
                    tier, split.get(client, ()),
                    f"AC14 — {client}/{tier}: this cell is a TOOLCHAIN-SPLIT "
                    f"cell of §S3's matrix, so it runs today and asserting it "
                    f"here would prove nothing about §S6's detection.")


# ── AC14a: the refusal is REACHABLE-PAST ──────────────────────────────


class BunRefusalIsReachablePastTest(_BunDeclarationCase):
    """AC14a, bun — RED. The pair on one cell: refuse, add the `package.json`
    script the refusal's own help[] names, change nothing else, run."""

    def test_declaring_what_the_refusal_asked_for_makes_the_cell_run(self):
        self.assertRefusalIsReachablePast(DECLARED_CELLS["bun"])


class PythonRefusalIsReachablePastTest(_PythonDeclarationCase):
    """AC14a, python — RED. The instruction is read out of the help and driven,
    so the assertion cannot drift from what the client actually printed."""

    def test_declaring_what_the_refusal_asked_for_makes_the_cell_run(self):
        self.assertRefusalIsReachablePast(DECLARED_CELLS["python"])


class MvnRefusalIsReachablePastTest(_MvnDeclarationCase):
    """AC14a, mvn — RED."""

    def test_declaring_what_the_refusal_asked_for_makes_the_cell_run(self):
        self.assertRefusalIsReachablePast(DECLARED_CELLS["mvn"])


class RustRefusalIsReachablePastTest(_RustDeclarationCase):
    """AC14a, rust — RED."""

    def test_declaring_what_the_refusal_asked_for_makes_the_cell_run(self):
        self.assertRefusalIsReachablePast(DECLARED_CELLS["rust"])


class ArduinoRefusalIsReachablePastTest(_ArduinoDeclarationCase):
    """AC14a, arduino — RED."""

    def test_declaring_what_the_refusal_asked_for_makes_the_cell_run(self):
        self.assertRefusalIsReachablePast(DECLARED_CELLS["arduino"])


# ── AC14b: a refusal never names a flag its own verb rejects ──────────────


class BunRefusalNamesNothingItsVerbRejectsTest(_BunDeclarationCase):
    """AC14b, bun — RED on the ARTEFACT face: the refusal names `package.json`
    and the route that reads it does not exist."""

    def test_the_instruction_the_refusal_gives_can_be_driven(self):
        self.assertRefusalNamesNothingItsVerbRejects(DECLARED_CELLS["bun"])


class PythonRefusalNamesNothingItsVerbRejectsTest(_PythonDeclarationCase):
    """AC14b, python — RED on the FLAG face, and this is the AC's own cited
    measurement: '`python-crucible.py unit --start-dir … --pattern …` exits 2
    with `unrecognized arguments` while the refusal instructs exactly that'."""

    def test_the_instruction_the_refusal_gives_can_be_driven(self):
        self.assertRefusalNamesNothingItsVerbRejects(DECLARED_CELLS["python"])


class MvnRefusalNamesNothingItsVerbRejectsTest(_MvnDeclarationCase):
    """AC14b, mvn — RED on the ARTEFACT face (`pom.xml`)."""

    def test_the_instruction_the_refusal_gives_can_be_driven(self):
        self.assertRefusalNamesNothingItsVerbRejects(DECLARED_CELLS["mvn"])


class RustRefusalNamesNothingItsVerbRejectsTest(_RustDeclarationCase):
    """AC14b, rust — RED on the ARTEFACT face (`.config/nextest.toml`)."""

    def test_the_instruction_the_refusal_gives_can_be_driven(self):
        self.assertRefusalNamesNothingItsVerbRejects(DECLARED_CELLS["rust"])


class ArduinoRefusalNamesNothingItsVerbRejectsTest(_ArduinoDeclarationCase):
    """AC14b, arduino — RED on BOTH faces: the refusal names `--dir`, a flag the
    `integration` verb that printed it does not accept, AND a Makefile target
    whose route does not exist."""

    def test_the_instruction_the_refusal_gives_can_be_driven(self):
        self.assertRefusalNamesNothingItsVerbRejects(DECLARED_CELLS["arduino"])


# ── AC14c: rust's regression cell, and a producible `bdd` ────────────────


class RustRegressionCellRunsItsWorkspaceRegressionBodyTest(_RustDeclarationCase):
    """AC14c — RED. 'rust's `regression` cell runs its existing
    workspace-regression body rather than refusing': the client ships that body
    and already posts `tier="regression"` from it, so refusing the cell is 'the
    client declining work it demonstrably does'.

    NOTHING is declared here, deliberately: §S6 makes this a CONSEQUENCE of the
    detection work and not a cell the project must declare — the target exists
    in the client already. See ESCALATION 3 for which of the two shipped
    regression bodies §S6 means; this test asserts only what both share."""

    def test_the_regression_cell_runs_the_regression_this_client_already_has(self):
        cell = "rust/regression"
        self.write_nextest_junit(profile="ci")
        self.write_nextest_junit(profile="regression")
        # The workspace body hands its child the client's own stream, which an
        # io.StringIO cannot back — cycle 379's real-fd drive, same recording.
        drive = self.drive_with_real_std(self.rust_argv("regression"))
        self.assertReachedTheVerb(drive, cell, "the client's own regression body",
                                  ac="AC14c", tier="regression")
        self.assertFalse(
            self.refused_for_no_declaration(drive),
            f"AC14c — {cell}: this client SHIPS a regression that posts "
            f"tier='regression' today, so the `regression` verb has something "
            f"to run and refusing it is the client declining work it "
            f"demonstrably does: {drive.err[-600:]!r}")
        runs = self.invocations("cargo")
        self.assertTrue(
            runs,
            f"AC14c — {cell}: cargo was not invoked once, so no regression "
            f"ran. invocations={self.invocations()!r} exit={drive.code} "
            f"stderr={drive.err[-800:]!r}")
        self.assertTrue(
            any("nextest" in run["argv"] for run in runs),
            f"AC14c — {cell}: the regression this client has is a nextest run; "
            f"it ran {[r['argv'] for r in runs]!r}")
        for run in runs:
            self.assertNotIn(
                "--lib", run["argv"],
                f"AC14c — {cell}: `--lib` is cargo's UNIT selection; a "
                f"regression that ran it would be the unit cell wearing the "
                f"regression tier: {run['argv']!r}")
        self.assertIngestedVerbTier(drive, "regression", cell)


class BddIsProducibleThroughADeclaredTargetTest(_BunDeclarationCase):
    """AC14c — RED. '`bdd` is producible on at least one stack via a declared
    target, which is what makes AC2's sixth value assertable.'

    bun is that stack here (`MvnDeclaredTargetRunsTest` drives the same tier on
    maven's own surface, so the sixth value is reachable on two). VERIFY's
    finding is what this asserts against: 'only five of the six values could be
    observed on the wire, because `bdd` is absent from every client's `funcs`
    map — so no invocation could produce "tier": "bdd"'. AC2's six-value
    assertion itself is cycle 385's, not this one's."""

    def test_a_declared_bdd_target_puts_the_sixth_tier_on_the_wire(self):
        cell = "bun/bdd"
        self.assertIn(
            "bdd", TIER_VOCABULARY,
            "`bdd` is one of the six the fleet's own mirror declares")
        extra = self.declare("bdd")
        drive = self.drive(self.run_argv("bdd", extra))
        self.assertDeclaredCellRan(drive, cell, "bdd", self.declaration_text())
        tiers = {payload.get("tier") for payload in self.ingest_payloads(drive)}
        self.assertEqual(
            tiers, {"bdd"},
            f"AC14c — {cell}: the sixth `Tier` value must be PRODUCIBLE on the "
            f"wire through a declared target, or AC2's six-value assertion has "
            f"nothing to observe; this run put "
            f"{sorted(t for t in tiers if t)!r} on the wire.")


if __name__ == "__main__":
    unittest.main()
