"""A rust tier verb runs the tests its kind names.

The rust client's `unit` and `integration` verbs select their tests with a
nextest kind filter when the project declares no profile for the tier, run a
declared `[profile.<tier>]` when it does, resolve the profile an undeclared tier
runs under (an explicit `--profile`, else a declared `ci`, else nextest's own
`default`), refuse a kind-filter selection that lists no test, and leave `e2e`
to a declaration. `test`, `regression` and the gate keep today's argv.

Every test drives the real `clients/rust-crucible.py` as a subprocess, from a
scratch cargo project it owns, against a loopback `RecordingBoard` the project
declares in its own `crucible.toml`. A fake `cargo` first on `PATH` answers as
cargo-nextest does (`tests/client/fake_nextest.py`) with
`FAKE_NEXTEST_KINDS=1`: its list marks a test whose binary kind the call's `-E`
does not select as a mismatch, and its run runs only the selected tests. The
fake records every call's argv, so each test asserts what nextest was handed;
the board records every request, so each test asserts what was filed.

Each project's `.config/nextest.toml` is written by the test that needs it, in
its own scratch directory; `NEXTEST_PROFILE` is set only in the environment of
the one subprocess that tests it.

TIER: integration (a client subprocess, a fake `cargo` subprocess, a loopback
HTTP board).

Invocation:
    .venv/bin/python clients/python-crucible.py test \
        --tests tests.client.integration.test_a_rust_tier_verb_runs_the_tests_its_kind_names
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path

from tests.client.fake_nextest import read_calls
from tests.client.live_run_harness import (
    CLIENTS,
    RecordingBoard,
    load_toon,
    new_scratch,
    scrubbed_env,
)

TOON = load_toon()
RUST_CLIENT = CLIENTS / "rust-crucible.py"
TIMEOUT = 120
PROJECT_KEY = "rust-tier-kinds-key"

START = "/api/v2/runs/start"
RUNS = "/api/v2/runs"
COMPILE = "/api/v2/runs/compile"

# The kind filters the spec states, each one argv element.
UNIT_KINDS = "kind(lib) | kind(bin) | kind(proc-macro)"
INTEGRATION_KINDS = "kind(test)"
TIER_SELECTION_EMPTY = "tier-selection-empty"
TIER_RUN_UNDECLARED = "tier-run-undeclared"
E2E_RUNS_TODAY = "tier verbs this client runs today: integration, regression, unit"

# The tests a crate holds, one per binary kind: `(name, status, kind, crate,
# binary)`.
LIB = ("adds", "ok", "lib", "kinds", "kinds")
BIN = ("tool_starts", "ok", "bin", "kinds", "tool")
PROC_MACRO = ("derives", "ok", "proc-macro", "kinds_derive", "kinds_derive")
TEST = ("integration_adds", "ok", "test", "kinds", "it")
IGNORED_TEST = ("slow_integration", "ignored", "test", "kinds", "it")
EVERY_KIND = (LIB, BIN, PROC_MACRO, TEST)
NO_TEST_KIND = (LIB, BIN, PROC_MACRO)
ONLY_TEST_KIND = (TEST,)

_SCRUBBED = ("CRUCIBLE_AGENT_ID", "CRUCIBLE_PROJECT_KEY", "CRUCIBLE_URL",
             "RUST_CRUCIBLE_PROJECT_DIR", "RUST_CRUCIBLE_COMPOSE_FILE",
             "CARGO_TARGET_DIR", "NEXTEST_EXPERIMENTAL_LIBTEST_JSON",
             "NEXTEST_PROFILE", "LLVM_PROFILE_FILE", "CARGO_LLVM_COV",
             "RUSTC_WRAPPER", "FAKE_NEXTEST_CASES", "FAKE_LIST_COMPILE_ERROR",
             "FAKE_RUN_EXIT", "FAKE_NEXTEST_FIXTURE", "FAKE_STREAM_SILENT")

# A fake `cargo`: a streamed run's calls are answered by `fake_nextest`
# (the version, the list, `llvm-cov`, the stream) over FAKE_KIND_CASES, kind
# predicates honoured. `check`, `clean`, `cache` and `clippy` succeed silently.
# A plain `nextest run` (no stream asked for) prints nextest's human summary
# and exits 0, or 4 when no selected test is left. Every call is recorded in
# FAKE_CARGO_CALLS.
_FAKE_CARGO = r'''
import json
import os
import sys

sys.path.insert(0, ''' + repr(str(Path(__file__).resolve().parents[1])) + r''')
import fake_nextest

args = sys.argv[1:]
cases = [fake_nextest.case(name, status, crate=crate, binary=binary, kind=kind)
         for name, status, kind, crate, binary
         in json.loads(os.environ.get("FAKE_KIND_CASES") or "[]")]
code = fake_nextest.preliminary(args, cases)
if code is not None:
    sys.exit(code)
fake_nextest.record_call(args)
if not args or args[0] in ("check", "clean", "cache", "clippy"):
    sys.exit(0)
code = fake_nextest.streamed_run(args, cases)
if code is not None:
    sys.exit(code)
if args[:2] == ["nextest", "run"]:
    selected = [c for c in cases if fake_nextest.kind_selected(c, args)]
    sys.stderr.write(f"    Starting {len(selected)} tests across 1 binary\n")
    sys.exit(0 if selected else 4)
sys.exit(0)
'''

_FAKE_DOCKER = "import sys\nsys.exit(0)\n"


def _write_script(path, body):
    Path(path).write_text("#!" + sys.executable + "\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IRUSR)


def _envelope(stdout):
    try:
        decoded = TOON.decode(stdout or "")
    except ValueError:
        return None
    axi = decoded.get("axi") if isinstance(decoded, dict) else None
    return axi if isinstance(axi, dict) else None


def _codes(value):
    """Every value of a `code` key anywhere in an envelope."""
    found = []
    if isinstance(value, dict):
        for key, inner in value.items():
            if key == "code" and isinstance(inner, str):
                found.append(inner)
            else:
                found.extend(_codes(inner))
    elif isinstance(value, list):
        for inner in value:
            found.extend(_codes(inner))
    return found


def _said(axi):
    """What an envelope says, past the verb it names and its context."""
    return json.dumps({k: v for k, v in (axi or {}).items()
                       if k not in ("verb", "context")})


def _values(argv, flag):
    return [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == flag]


class _RustKindsProject(unittest.TestCase):
    """A scratch cargo project, the fake `cargo` and `docker` first on PATH,
    filing to its own `RecordingBoard`."""

    maxDiff = 4000

    def setUp(self):
        self.project = new_scratch("rust-tier-kinds-")
        self.bin_dir = new_scratch("rust-tier-kinds-bin-")
        self.board = RecordingBoard()
        self.addCleanup(self.board.close)
        self.addCleanup(shutil.rmtree, self.project, True)
        self.addCleanup(shutil.rmtree, self.bin_dir, True)
        Path(self.project, ".env").write_text(f"CRUCIBLE_PROJECT_KEY={PROJECT_KEY}\n")
        self.targets = ""
        self.write_crucible_toml()
        _write_script(os.path.join(self.bin_dir, "cargo"), _FAKE_CARGO)
        _write_script(os.path.join(self.bin_dir, "docker"), _FAKE_DOCKER)
        self.cases = EVERY_KIND

    # ── the project's files ────────────────────────────────────────────────

    def write_crucible_toml(self, targets=""):
        Path(self.project, "crucible.toml").write_text(
            f"[client]\nurl = {json.dumps(self.board.url)}\n\n{targets}")

    @property
    def nextest_config(self):
        return Path(self.project, ".config", "nextest.toml")

    def declare_profiles(self, *profiles):
        """A `.config/nextest.toml` declaring each named profile."""
        self.nextest_config.parent.mkdir(parents=True, exist_ok=True)
        self.nextest_config.write_text("".join(
            f'[profile.{name}]\ndefault-filter = "all()"\n\n' for name in profiles))

    def write_unparseable_config(self):
        self.nextest_config.parent.mkdir(parents=True, exist_ok=True)
        self.nextest_config.write_text("[profile.ci\ndefault-filter = \n")

    # ── the drive ──────────────────────────────────────────────────────────

    def drive(self, verb, *extra, agent=None, **env_extra):
        env = scrubbed_env(self.bin_dir)
        for key in _SCRUBBED:
            env.pop(key, None)
        env.update({"FAKE_CARGO_CALLS": os.path.join(self.bin_dir, "cargo-calls.jsonl"),
                    "FAKE_NEXTEST_KINDS": "1",
                    "FAKE_KIND_CASES": json.dumps([list(c) for c in self.cases])})
        env.update({k: str(v) for k, v in env_extra.items()})
        argv = [verb, "--project-dir", self.project]
        if agent:
            argv += ["--agent", agent]
        argv += list(extra)
        return subprocess.run([sys.executable, str(RUST_CLIENT), *argv],
                              cwd=self.project, env=env, capture_output=True,
                              text=True, timeout=TIMEOUT, check=False)

    @staticmethod
    def where(result):
        return (f"exit={result.returncode} stdout={result.stdout[-1500:]!r} "
                f"stderr={result.stderr[-2500:]!r}")

    def cargo_calls(self, *head):
        calls = read_calls(os.path.join(self.bin_dir, "cargo-calls.jsonl"))
        return [c["argv"] for c in calls if c["argv"][:len(head)] == list(head)]

    def posts_to(self, path):
        return [body for p, body in self.board.posts() if p == path]

    def envelope_of(self, result):
        axi = _envelope(result.stdout)
        self.assertIsNotNone(axi, f"stdout is one TOON envelope; {self.where(result)}")
        return axi or {}

    # ── what nextest was handed ────────────────────────────────────────────

    def selections(self, result):
        """The argv of every `nextest list` and `nextest run` the drive made,
        after asserting it made at least one run."""
        runs = self.cargo_calls("nextest", "run")
        self.assertTrue(runs, f"nextest ran; {self.where(result)}")
        return self.cargo_calls("nextest", "list") + runs

    def assertKindFilter(self, result, kinds, profile):
        """Every list and run nextest was handed carries exactly one `-E`,
        whose element is `kinds`, exactly one `-P`, whose value is `profile`,
        and no `--lib` or `--tests`."""
        for argv in self.selections(result):
            self.assertEqual(_values(argv, "-P"), [profile], f"argv={argv!r}")
            self.assertNotIn("--profile", argv, f"argv={argv!r}")
            self.assertEqual(argv.count("-E"), 1,
                             f"one `-E` element, never a second that widens the "
                             f"run; argv={argv!r}")
            self.assertEqual(_values(argv, "-E"), [kinds], f"argv={argv!r}")
            self.assertNotIn("--lib", argv, f"no cargo target flag; argv={argv!r}")
            self.assertNotIn("--tests", argv, f"no cargo target flag; argv={argv!r}")

    def assertDeclaredProfile(self, result, profile, filter_expr=None):
        """Every list and run carries `-P <profile>` and no kind filter: `-E`
        only for the user's own `--filter`."""
        for argv in self.selections(result):
            self.assertEqual(_values(argv, "-P"), [profile], f"argv={argv!r}")
            self.assertEqual(_values(argv, "-E"), [] if filter_expr is None else [filter_expr],
                             f"a declared profile is the selection; argv={argv!r}")
            self.assertNotIn("--lib", argv, f"argv={argv!r}")
            self.assertNotIn("--tests", argv, f"argv={argv!r}")
            self.assertFalse(any("kind(" in arg for arg in argv), f"argv={argv!r}")

    # ── what the board was sent ────────────────────────────────────────────

    def assertFiledUnder(self, result, tier):
        """One run opened and one closed, both under `tier`."""
        starts = self.posts_to(START)
        self.assertEqual([s.get("tier") for s in starts], [tier],
                         f"one run opened under {tier}; {self.where(result)}")
        closes = self.posts_to(RUNS)
        self.assertEqual([c.get("tier") for c in closes], [tier],
                         f"one run closed under {tier}; {self.where(result)}")

    def assertNothingFiled(self, result):
        self.assertEqual(self.posts_to(START), [],
                         f"no POST {START}; {self.where(result)}")
        self.assertEqual(self.posts_to(COMPILE), [],
                         f"no compile failure filed; {self.where(result)}")
        self.assertEqual(self.posts_to(RUNS), [],
                         f"no run filed; {self.where(result)}")

    def assertRefusedBeforeAnythingRan(self, result, *named):
        """An `ok: false` envelope naming each of `named`, a non-zero exit, no
        cargo call at all and nothing filed."""
        axi = self.envelope_of(result)
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertNotEqual(result.returncode, 0, self.where(result))
        for text in named:
            self.assertIn(text, _said(axi),
                          f"the refusal names {text!r}; envelope={axi!r}")
        self.assertEqual(self.cargo_calls(), [],
                         f"refused before nextest starts; {self.where(result)}")
        self.assertNothingFiled(result)
        return axi


# ── an undeclared tier runs its stack's own kind split ─────────────────────


class AnUndeclaredTierRunsItsKindFilterTest(_RustKindsProject):
    """On a crate that declares `[profile.ci]` and no tier profile, `unit`
    selects the lib, bin and proc-macro kinds and `integration` the test kind,
    each as one `-E` element under `-P ci`, with no cargo target flag."""

    def setUp(self):
        super().setUp()
        self.declare_profiles("ci")

    def test_unit_hands_nextest_the_lib_bin_and_proc_macro_kinds_under_ci(self):
        result = self.drive("unit", agent="rust-kinds-unit")
        self.assertKindFilter(result, UNIT_KINDS, "ci")
        self.assertEqual(result.returncode, 0, self.where(result))

    def test_unit_runs_its_bin_and_proc_macro_tests_and_never_the_test_kind(self):
        result = self.drive("unit", agent="rust-kinds-unit-held")
        self.assertFiledUnder(result, "unit")
        held = self.board.held_stream(self.board.run_ids_opened()[0])
        for name in ("adds", "tool_starts", "derives"):
            self.assertIn(f"${name}", held, f"the {name} test ran; held={held!r}")
        self.assertNotIn("$integration_adds", held,
                         f"a test-kind test is never a unit; held={held!r}")

    def test_integration_hands_nextest_the_test_kind_under_ci(self):
        result = self.drive("integration", agent="rust-kinds-integration")
        self.assertKindFilter(result, INTEGRATION_KINDS, "ci")
        self.assertEqual(result.returncode, 0, self.where(result))

    def test_integration_runs_only_the_test_kind_and_is_filed_under_integration(self):
        result = self.drive("integration", agent="rust-kinds-integration-filed")
        self.assertFiledUnder(result, "integration")
        held = self.board.held_stream(self.board.run_ids_opened()[0])
        self.assertIn("$integration_adds", held, f"held={held!r}")
        for name in ("adds", "tool_starts", "derives"):
            self.assertNotIn(f"${name}", held,
                             f"an in-crate {name} test is never filed as integration; "
                             f"held={held!r}")

    def test_a_filter_narrows_the_unit_kinds_in_the_one_element(self):
        result = self.drive("unit", "--filter", "test(adds)",
                            agent="rust-kinds-unit-filter")
        self.assertKindFilter(
            result, "(kind(lib) | kind(bin) | kind(proc-macro)) & (test(adds))", "ci")

    def test_a_filter_narrows_the_integration_kind_in_the_one_element(self):
        result = self.drive("integration", "--filter", "test(adds)",
                            agent="rust-kinds-integration-filter")
        self.assertKindFilter(result, "(kind(test)) & (test(adds))", "ci")

    def test_integration_test_it_passes_the_target_and_the_kind_filter(self):
        result = self.drive("integration", "--test", "it",
                            agent="rust-kinds-integration-test-it")
        self.assertKindFilter(result, INTEGRATION_KINDS, "ci")
        for argv in self.selections(result):
            self.assertEqual(_values(argv, "--test"), ["it"], f"argv={argv!r}")

    def test_unit_without_an_agent_hands_nextest_the_same_kind_filter(self):
        result = self.drive("unit")
        runs = self.cargo_calls("nextest", "run")
        self.assertEqual(len(runs), 1, self.where(result))
        self.assertKindFilter(result, UNIT_KINDS, "ci")
        self.assertNothingFiled(result)

    def test_integration_without_an_agent_hands_nextest_the_same_kind_filter(self):
        result = self.drive("integration")
        self.assertEqual(len(self.cargo_calls("nextest", "run")), 1, self.where(result))
        self.assertKindFilter(result, INTEGRATION_KINDS, "ci")

    def test_an_agent_run_lists_the_crate_once(self):
        """The selection is listed once: the list the empty check reads is
        the list the run posts."""
        result = self.drive("unit", agent="rust-kinds-unit-listed-once")
        self.assertEqual(len(self.cargo_calls("nextest", "list")), 1, self.where(result))


# ── a declared tier profile wins ───────────────────────────────────────────


class ADeclaredTierProfileWinsTest(_RustKindsProject):
    """A crate that declares `[profile.<tier>]` runs `-P <tier>` with no kind
    filter, and an explicit `--profile` against that declaration is refused."""

    def test_a_declared_unit_profile_runs_minus_p_unit_with_no_kind_filter(self):
        self.declare_profiles("ci", "unit")
        result = self.drive("unit", agent="rust-declared-unit")
        self.assertDeclaredProfile(result, "unit")
        self.assertFiledUnder(result, "unit")

    def test_a_declared_integration_profile_runs_minus_p_integration_with_no_kind_filter(self):
        self.declare_profiles("ci", "integration")
        result = self.drive("integration", agent="rust-declared-integration")
        self.assertDeclaredProfile(result, "integration")
        self.assertFiledUnder(result, "integration")

    def test_a_filter_under_a_declared_profile_is_passed_alone(self):
        self.declare_profiles("unit")
        result = self.drive("unit", "--filter", "test(adds)",
                            agent="rust-declared-unit-filter")
        self.assertDeclaredProfile(result, "unit", filter_expr="test(adds)")

    def test_a_declared_unit_profile_runs_without_an_agent(self):
        self.declare_profiles("unit")
        result = self.drive("unit")
        self.assertDeclaredProfile(result, "unit")

    def test_an_explicit_profile_against_a_declared_unit_is_refused_with_an_agent(self):
        self.declare_profiles("ci", "unit", "p")
        result = self.drive("unit", "--profile", "p", agent="rust-declared-unit-profile")
        self.assertRefusedBeforeAnythingRan(result, "[profile.unit]")

    def test_an_explicit_profile_against_a_declared_unit_is_refused_without_an_agent(self):
        self.declare_profiles("ci", "unit", "p")
        result = self.drive("unit", "--profile", "p")
        self.assertRefusedBeforeAnythingRan(result, "[profile.unit]")

    def test_an_explicit_profile_against_a_declared_integration_is_refused(self):
        self.declare_profiles("integration", "p")
        result = self.drive("integration", "--profile", "p",
                            agent="rust-declared-integration-profile")
        self.assertRefusedBeforeAnythingRan(result, "[profile.integration]")


# ── the profile an undeclared tier runs under ──────────────────────────────


class TheUndeclaredTiersProfileChainTest(_RustKindsProject):
    """An explicit `--profile p` (declared, or a nextest built-in), else a
    declared `ci`, else nextest's `default`, passed explicitly; an undeclared
    `p` and an unparseable config are refused before nextest starts."""

    def test_a_declared_ci_profile_is_the_default(self):
        self.declare_profiles("ci")
        result = self.drive("unit", agent="rust-chain-ci")
        self.assertKindFilter(result, UNIT_KINDS, "ci")

    def test_no_ci_profile_runs_minus_p_default_even_with_nextest_profile_set(self):
        self.declare_profiles("p")
        result = self.drive("unit", agent="rust-chain-default", NEXTEST_PROFILE="p")
        self.assertKindFilter(result, UNIT_KINDS, "default")

    def test_no_config_file_runs_minus_p_default_even_with_nextest_profile_set(self):
        result = self.drive("integration", agent="rust-chain-no-config",
                            NEXTEST_PROFILE="ci")
        self.assertKindFilter(result, INTEGRATION_KINDS, "default")

    def test_no_ci_profile_runs_minus_p_default_without_an_agent(self):
        result = self.drive("unit", NEXTEST_PROFILE="ci")
        self.assertKindFilter(result, UNIT_KINDS, "default")

    def test_an_explicit_declared_profile_runs_and_keeps_the_kind_filter(self):
        self.declare_profiles("ci", "p")
        result = self.drive("unit", "--profile", "p", agent="rust-chain-explicit")
        self.assertKindFilter(result, UNIT_KINDS, "p")

    def test_an_explicit_default_profile_runs_with_no_config_file(self):
        result = self.drive("integration", "--profile", "default",
                            agent="rust-chain-builtin")
        self.assertKindFilter(result, INTEGRATION_KINDS, "default")

    def test_an_explicit_default_profile_runs_with_no_config_file_without_an_agent(self):
        result = self.drive("unit", "--profile", "default")
        self.assertKindFilter(result, UNIT_KINDS, "default")

    def test_an_explicit_default_miri_profile_is_a_built_in(self):
        result = self.drive("unit", "--profile", "default-miri",
                            agent="rust-chain-builtin-miri")
        self.assertKindFilter(result, UNIT_KINDS, "default-miri")

    def test_an_undeclared_explicit_profile_is_refused_with_an_agent(self):
        self.declare_profiles("ci")
        result = self.drive("unit", "--profile", "p", agent="rust-chain-undeclared")
        self.assertRefusedBeforeAnythingRan(result, "[profile.p]")

    def test_an_undeclared_explicit_profile_is_refused_without_an_agent(self):
        self.declare_profiles("ci")
        result = self.drive("integration", "--profile", "p")
        self.assertRefusedBeforeAnythingRan(result, "[profile.p]")

    def test_an_unparseable_config_is_refused_naming_the_file(self):
        self.write_unparseable_config()
        result = self.drive("unit", agent="rust-chain-unparseable")
        self.assertRefusedBeforeAnythingRan(result, ".config/nextest.toml")

    def test_an_unparseable_config_is_refused_without_an_agent(self):
        self.write_unparseable_config()
        result = self.drive("integration")
        self.assertRefusedBeforeAnythingRan(result, ".config/nextest.toml")

    def test_a_config_that_is_not_utf8_is_refused_naming_the_file(self):
        self.nextest_config.parent.mkdir(parents=True, exist_ok=True)
        self.nextest_config.write_bytes(b'[profile.ci]\ndefault-filter = "\xff"\n')
        result = self.drive("unit", agent="rust-chain-not-utf8")
        self.assertRefusedBeforeAnythingRan(result, ".config/nextest.toml")

    def test_a_profile_key_that_is_not_a_table_is_refused_naming_the_table(self):
        """Valid TOML that nextest itself rejects: refused before anything
        runs, so it is never filed as a compile failure."""
        self.nextest_config.parent.mkdir(parents=True, exist_ok=True)
        self.nextest_config.write_text('profile = "x"\n')
        result = self.drive("integration", agent="rust-chain-profile-not-a-table")
        self.assertRefusedBeforeAnythingRan(result, ".config/nextest.toml", "[profile]")

    def test_a_targets_entry_is_still_checked_when_the_chain_picks_ci(self):
        """Passes today, when `ci` is the parser's default: the guard that the
        chain hands `_targets_refusal` the profile it resolved."""
        self.declare_profiles("ci")
        self.write_crucible_toml(
            '[targets.ci]\nstream = { codec = "nextest", path = "target/run.jsonl" }\n')
        result = self.drive("unit", agent="rust-chain-targets-ci")
        axi = self.envelope_of(result)
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertIn("[targets.ci]", _said(axi), self.where(result))
        self.assertEqual(self.cargo_calls("nextest", "run"), [], self.where(result))
        self.assertNothingFiled(result)

    def test_a_targets_entry_is_checked_for_the_default_the_chain_picks(self):
        self.write_crucible_toml(
            '[targets.default]\nstream = { codec = "nextest", path = "target/run.jsonl" }\n')
        result = self.drive("unit", agent="rust-chain-targets-default")
        axi = self.envelope_of(result)
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertIn("[targets.default]", _said(axi), self.where(result))
        self.assertEqual(self.cargo_calls("nextest", "run"), [], self.where(result))
        self.assertNothingFiled(result)


# ── an empty kind-filter selection refuses ─────────────────────────────────


class AnEmptyKindSelectionRefusesTest(_RustKindsProject):
    """A kind-filter selection whose list names no matching test, and no test
    that is only ignored, is refused with `tier-selection-empty` before any
    run is opened."""

    def setUp(self):
        super().setUp()
        self.declare_profiles("ci")

    def assertSelectionEmpty(self, result, *named):
        axi = self.envelope_of(result)
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertNotEqual(result.returncode, 0, self.where(result))
        self.assertIn(TIER_SELECTION_EMPTY, _codes(axi),
                      f"the refusal's code; envelope={axi!r}")
        for text in named:
            self.assertIn(text, _said(axi), f"the refusal names {text!r}; envelope={axi!r}")
        self.assertEqual(self.cargo_calls("nextest", "run"), [],
                         f"no run follows; {self.where(result)}")
        self.assertEqual(len(self.cargo_calls("nextest", "list")), 1,
                         f"one list, with the run's selection; {self.where(result)}")
        self.assertNothingFiled(result)
        return axi

    def test_integration_on_a_crate_with_no_test_kind_refuses(self):
        self.cases = NO_TEST_KIND
        result = self.drive("integration", agent="rust-empty-integration")
        self.assertSelectionEmpty(result, "integration", INTEGRATION_KINDS,
                                  "[profile.integration]")

    def test_integration_on_a_crate_with_no_test_kind_refuses_without_an_agent(self):
        self.cases = NO_TEST_KIND
        result = self.drive("integration")
        self.assertSelectionEmpty(result, "integration", INTEGRATION_KINDS,
                                  "[profile.integration]")

    def test_a_refusal_under_a_filter_names_the_filter(self):
        self.cases = NO_TEST_KIND
        result = self.drive("integration", "--filter", "test(adds)",
                            agent="rust-empty-integration-filter")
        self.assertSelectionEmpty(result, "integration", INTEGRATION_KINDS,
                                  "test(adds)", "[profile.integration]")

    def test_unit_on_a_crate_with_only_the_test_kind_refuses(self):
        self.cases = ONLY_TEST_KIND
        result = self.drive("unit", agent="rust-empty-unit")
        self.assertSelectionEmpty(result, "unit", UNIT_KINDS, "[profile.unit]")

    def test_a_tier_whose_only_tests_are_ignored_is_not_empty(self):
        """Passes today: the guard that an ignored test counts as a test."""
        self.cases = (LIB, IGNORED_TEST)
        result = self.drive("integration", agent="rust-empty-ignored")
        self.assertNotIn(TIER_SELECTION_EMPTY, _codes(_envelope(result.stdout)),
                         self.where(result))
        self.assertEqual(len(self.cargo_calls("nextest", "run")), 1, self.where(result))
        self.assertFiledUnder(result, "integration")

    def test_a_list_that_does_not_build_still_files_its_compile_failure(self):
        """Passes today: a list that exits non-zero is never an empty
        selection, so the crate's build failure is filed as before."""
        self.cases = NO_TEST_KIND
        result = self.drive("integration", agent="rust-empty-no-build",
                            FAKE_LIST_COMPILE_ERROR="1")
        compiles = self.posts_to(COMPILE)
        self.assertEqual(len(compiles), 1, self.where(result))
        self.assertIn("cannot find value", (compiles[0] or {}).get("errors", ""),
                      f"compiles={compiles!r}")
        self.assertEqual(self.posts_to(RUNS), [], self.where(result))
        self.assertEqual(self.cargo_calls("nextest", "run"), [], self.where(result))
        self.assertNotIn(TIER_SELECTION_EMPTY, _codes(_envelope(result.stdout)),
                         self.where(result))
        self.assertNotEqual(result.returncode, 0, self.where(result))


# ── e2e is a declared cell ─────────────────────────────────────────────────


class E2eIsADeclaredCellTest(_RustKindsProject):
    """`e2e` runs `-P e2e` only when `[profile.e2e]` is declared, refuses
    with the shared `tier-run-undeclared` otherwise, and takes no
    `--profile`."""

    def assertUndeclared(self, result):
        axi = self.envelope_of(result)
        self.assertIs(axi.get("ok"), False, self.where(result))
        self.assertEqual(result.returncode, 1, self.where(result))
        self.assertIn(TIER_RUN_UNDECLARED, result.stderr, self.where(result))
        help_lines = [str(line) for line in axi.get("help") or []]
        self.assertTrue(any("[profile.e2e]" in line for line in help_lines),
                        f"the help names [profile.e2e]; help={help_lines!r}")
        self.assertIn(E2E_RUNS_TODAY, help_lines, f"help={help_lines!r}")
        self.assertEqual(self.cargo_calls(), [], self.where(result))
        self.assertNothingFiled(result)

    def test_an_undeclared_e2e_answers_tier_run_undeclared(self):
        self.declare_profiles("ci")
        self.assertUndeclared(self.drive("e2e", agent="rust-e2e-undeclared"))

    def test_an_undeclared_e2e_answers_tier_run_undeclared_without_an_agent(self):
        self.assertUndeclared(self.drive("e2e"))

    def test_a_declared_e2e_runs_minus_p_e2e(self):
        """Passes today: the guard that a declared `e2e` keeps running."""
        self.declare_profiles("ci", "e2e")
        result = self.drive("e2e", agent="rust-e2e-declared")
        self.assertDeclaredProfile(result, "e2e")
        self.assertFiledUnder(result, "e2e")

    def test_e2e_takes_no_profile_flag(self):
        self.declare_profiles("e2e")
        result = self.drive("e2e", "--profile", "e2e", agent="rust-e2e-profile")
        self.assertEqual(result.returncode, 2, self.where(result))
        self.assertIn("--profile", result.stderr, self.where(result))
        self.assertEqual(self.cargo_calls(), [], self.where(result))
        self.assertNothingFiled(result)


# ── what stays ─────────────────────────────────────────────────────────────


class RegressionAndTheGateKeepTheirArgvTest(_RustKindsProject):
    """Passes today: the guard that `regression` and the gate's rust leg hand
    nextest today's argv (`--workspace -P ci`, no kind filter, no target
    flag), `regression` filed once under `regression`, and the gate one run
    with a `coveredBy` row per declared tier."""

    def setUp(self):
        super().setUp()
        self.declare_profiles("ci", "unit")

    def assertTodaysArgv(self, result):
        runs = self.cargo_calls("nextest", "run")
        self.assertEqual(len(runs), 1, f"one run; {self.where(result)}")
        for argv in runs:
            self.assertIn("--workspace", argv, f"argv={argv!r}")
            self.assertEqual(_values(argv, "-P"), ["ci"], f"argv={argv!r}")
            self.assertEqual(_values(argv, "-E"), [], f"argv={argv!r}")
            self.assertFalse(any("kind(" in arg for arg in argv), f"argv={argv!r}")
            self.assertNotIn("--lib", argv, f"argv={argv!r}")
            self.assertNotIn("--tests", argv, f"argv={argv!r}")

    def test_regression_hands_nextest_todays_argv_and_is_filed_under_regression(self):
        result = self.drive("regression", "--min-free-g", "0", agent="rust-stays-regression")
        self.assertTodaysArgv(result)
        self.assertFiledUnder(result, "regression")
        self.assertEqual(result.returncode, 0, self.where(result))

    def test_the_gate_is_one_run_with_a_covered_by_row_per_declared_tier(self):
        result = self.drive("pre-merge-gate", "--skip-clippy", "--min-free-g", "0",
                            "--keep-target", agent="rust-stays-gate")
        self.assertTodaysArgv(result)
        self.assertEqual([s.get("tier") for s in self.posts_to(START)], ["regression"],
                         self.where(result))
        axi = self.envelope_of(result)
        rows = [r for r in axi.get("suites") or [] if isinstance(r, dict)]
        unit_rows = [r for r in rows if r.get("suite") == "unit"]
        self.assertEqual(len(unit_rows), 1, f"suites={rows!r}")
        self.assertIsInstance(unit_rows[0].get("coveredBy"), str, f"row={unit_rows[0]!r}")
        self.assertTrue(unit_rows[0].get("coveredBy"), f"row={unit_rows[0]!r}")


if __name__ == "__main__":
    unittest.main()
