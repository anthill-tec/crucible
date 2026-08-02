"""CR-CRU-058 C3 RED -- contracts for the 20 envelope-less verbs the §S0
detector reports TODAY (re-measured at the top of this cycle, not copied
from the CR's §S0b table, which is one cycle stale after C2's shared-module
fix): rust 9, mvn 8, and `pre-merge-gate` bare in bun/python/arduino (1
each). C2 already closed the two SHARED-MODULE gaps (`milestone`, the
`open_plans` bare trio) in `test_shared_module_envelope_gaps.py`; this file
covers everything left -- the toolchain-local verbs each client owns.

    rust (9): clippy, workspace-clippy, docker-up, docker-down,
              docker-e2e-gate, regression-ingest, workspace-regression,
              smoke-test, pre-merge-gate
    mvn (8):  compile, docker-up, docker-down, e2e, module, regression,
              unit, pre-merge-gate
    bun/python/arduino (1 each): pre-merge-gate

Every test here DRIVES the real CLI as a genuine subprocess (never an
in-process mock, never a grep) -- reusing `test_client_fleet_envelope_
census.py`'s own machinery verbatim, per the dispatch brief: `enumerate_
verbs`, `build_argv`, `drive_verb`, `classify_envelope`, `_make_project_dir`,
`_build_fake_bin_dir`, `_load_toon_module`, `CLIENT_FILES` are all imported
from that module, not reimplemented. `_FAKE_TOOLS` is imported too, so this
file's own fake-tool-on-PATH overrides (below) start from the exact same
proven-working bodies and replace only the ONE tool whose exit behaviour a
given test needs to control.

Mode 1 (new failing contracts). Every assertion below fails today because
the census already proved it: none of these 20 verbs puts a decodable
`axi:` envelope on stdout at all -- `classify_envelope` reads every one of
them as bare. No production code is touched by this file.

WHY A CUSTOM "FAIL" BIN DIR (§S2 state-derived help[], bullet 3): this
harness (like the detector's own) always points `CRUCIBLE_URL` at an
unreachable loopback address -- by design, per the census's own stated
philosophy, the live :3849 dashboard is NEVER touched by a test. That means
a genuinely server-CONFIRMED "passing" ingest is unattainable inside this
harness; what IS attainable, and is exactly what §S2's rule is about, is
two REAL local states that reach different points in the SAME verb's own
pipeline before ever touching the network:

  - rust `pre-merge-gate` / mvn `pre-merge-gate` / bun `pre-merge-gate` /
    python `pre-merge-gate` / arduino `pre-merge-gate`: each is a fail-fast
    gate (clippy / docker-up / tsc / py_compile / arduino-cli compile) THEN
    the expensive regression run. A failing fail-fast step aborts the gate
    immediately -- a state that never reaches the regression run at all,
    which is a different, poorer-outcome state than "the fail-fast step
    passed and the gate proceeded" -- and CR-CRU-048's rule says these two
    states must carry different help[] text.
  - rust `workspace-regression`: has no fail-fast step of its own, but DOES
    have its own disk-guard hard-abort (`_disk_guard`, ahead of any cargo
    invocation) gated by `--min-free-g` -- an impossibly high floor
    deterministically hard-aborts before touching cargo or the network at
    all, versus a trivially low floor which lets the run proceed normally.
    Two real, deterministic, network-independent states.

These are documented interpretations of "passing vs failing", not
inventions of new behaviour: §S1's Non-goals section is explicit that this
CR changes output STRUCTURE only, never what a verb does, so the states
driven here are the client's own EXISTING branches, not new ones."""

import os
import shutil
import stat
import tempfile
import unittest
from pathlib import Path

from tests.client.test_client_fleet_envelope_census import (
    CLIENT_FILES,
    _FAKE_TOOLS,
    _build_fake_bin_dir,
    _load_toon_module,
    _make_project_dir,
    build_argv,
    classify_envelope,
    drive_verb,
    enumerate_verbs,
)

# ── §S2 fail-fast toolchain overrides ───────────────────────────────────────
#
# Each replaces exactly ONE tool from the census's own `_FAKE_TOOLS` set (the
# rest of the bin dir is byte-identical to the detector's proven-working
# default), so only the ONE step under test genuinely fails while every
# other stubbed tool behaves exactly as it does for the "passing" run.

_FAIL_CARGO_CLIPPY_BODY = r'''#!/usr/bin/env python3
import sys
argv = sys.argv[1:]
if "clippy" in argv:
    sys.stderr.write(
        "error: unused variable: `x`\n"
        "error: could not compile workspace due to previous error\n"
    )
    sys.exit(101)
sys.exit(0)
'''

_FAIL_DOCKER_UP_BODY = r'''#!/usr/bin/env python3
import sys
argv = sys.argv[1:]
if "up" in argv:
    sys.stderr.write("Error response from daemon: pull access denied\n")
    sys.exit(1)
sys.exit(0)
'''

_FAIL_BUN_TSC_BODY = r'''#!/usr/bin/env python3
import sys
argv = sys.argv[1:]
if argv[:1] == ["x"]:
    sys.stderr.write(
        "src/index.ts(3,5): error TS2322: Type 'string' is not "
        "assignable to type 'number'.\n"
    )
    sys.exit(2)
sys.exit(0)
'''

_FAIL_ARDUINO_CLI_BODY = r'''#!/usr/bin/env python3
import sys
sys.stderr.write("error: expected ';' before '}' token\n")
sys.exit(1)
'''


def _build_bin_dir_with_override(tool_name, body):
    """Same fake-tool-on-PATH idiom as the detector's own `_build_fake_bin_
    dir` (chmod +x scripts, PATH-prepended, restored by the caller), with
    exactly one tool's body swapped for a genuinely-failing variant."""
    bin_dir = Path(tempfile.mkdtemp(prefix="cr058-c3-fail-bin-"))
    tools = dict(_FAKE_TOOLS)
    tools[tool_name] = body
    for name, tool_body in tools.items():
        path = bin_dir / name
        path.write_text(tool_body)
        st = os.stat(path)
        os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return bin_dir


def _python_project_dir_with_syntax_error():
    """A python project fixture identical to `_make_project_dir("python")`
    plus one syntactically-broken file under `app/` -- `cmd_check`'s
    default `paths=["app", "tests"]` walk will find and py_compile it for
    real (python itself is never stubbed), giving a genuine, deterministic
    compile failure independent of the network."""
    project_dir = _make_project_dir("python")
    app_dir = project_dir / "app"
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "broken.py").write_text("def broken(:\n    pass\n")
    return project_dir


def _drive_with_bin_dir(client_key, verb_name, bin_dir_factory,
                        project_dir_factory=None, extra_argv=None):
    """Enumerate `client_key`'s real argparse, build the closest-to-normal
    argv for `verb_name`, optionally append `extra_argv`, and drive it as a
    genuine subprocess with `bin_dir_factory()`'s fake toolchain on PATH
    (never the detector's own default unless the caller passes it) against
    an unreachable `CRUCIBLE_URL`. Returns `(emits, axi, result)`."""
    fake_bin_dir = bin_dir_factory()
    try:
        toon_module = _load_toon_module()
        project_dir = (project_dir_factory or (lambda: _make_project_dir(client_key)))()
        try:
            script_path = CLIENT_FILES[client_key]
            verbs = enumerate_verbs(client_key, script_path)
            assert verb_name in verbs, (
                f"{client_key}: verb {verb_name!r} not found in its real "
                f"argparse -- {sorted(verbs)!r}")
            argv = build_argv(verb_name, verbs[verb_name], project_dir)
            if extra_argv:
                argv = argv + list(extra_argv)
            result = drive_verb(script_path, argv, project_dir, fake_bin_dir)
            emits, axi = classify_envelope(result.stdout, toon_module)
            return emits, axi, result
        finally:
            shutil.rmtree(project_dir, ignore_errors=True)
    finally:
        shutil.rmtree(fake_bin_dir, ignore_errors=True)


class _EnvelopeContractMixin:
    """Shared per-verb assertions -- every envelope-less verb this CR
    touches must satisfy ALL of these once fixed: a real §S1 envelope
    (verb/ok/help/context/warnings), and §S3 stdout purity (the TOON
    document is the ENTIRE stdout, no `[...]` human line ahead of it)."""

    def _assert_full_envelope(self, client_key, verb_name, emits, axi, result,
                              required_fields=()):
        self.assertTrue(
            emits,
            f"{client_key}/{verb_name}: must produce a single decodable "
            f"axi: envelope on stdout; got stdout={result.stdout!r} "
            f"stderr={result.stderr!r}")
        self.assertTrue(
            result.stdout.lstrip().startswith("axi:"),
            f"{client_key}/{verb_name}: §S3 -- stdout must carry the TOON "
            f"envelope ALONE, no human `[...]`-style line ahead of it; got "
            f"prefix={result.stdout.strip()[:120]!r}")
        self.assertEqual(
            axi.get("verb"), verb_name,
            f"{client_key}/{verb_name}: envelope verb must match the "
            f"invoked verb")
        self.assertIn(
            "ok", axi,
            f"{client_key}/{verb_name}: envelope must carry an 'ok' field")
        self.assertTrue(
            axi.get("help"),
            f"{client_key}/{verb_name}: envelope must carry a non-empty "
            f"help[] next-step hint, got {axi.get('help')!r}")
        self.assertIsNotNone(
            axi.get("context"),
            f"{client_key}/{verb_name}: envelope must carry a context block")
        self.assertIn(
            "warnings", axi,
            f"{client_key}/{verb_name}: envelope must carry a warnings[] "
            f"field (may be empty)")
        for field in required_fields:
            self.assertIn(
                field, axi,
                f"{client_key}/{verb_name}: envelope must carry the "
                f"verb-specific result field {field!r} per §S1; got "
                f"keys={sorted(axi)!r}")


# ── rust's 8 toolchain-local verbs (pre-merge-gate gets its own class) ─────


class RustEnvelopeLessVerbContractTest(_EnvelopeContractMixin, unittest.TestCase):
    """§S1 -- every rust toolchain verb the census (re-measured this cycle)
    still reports bare must gain the shared envelope. Confirmed bare today
    by reading each function body: `cmd_clippy`/`_clippy_workspace_gate`/
    `cmd_docker_up`/`cmd_docker_down`/`cmd_docker_e2e_gate`/
    `_regression_ingest_run`/`cmd_workspace_regression`/`cmd_smoke_test`
    each end in a plain `print(...)`, never an `_emit_axi` call -- and
    (§S3) most of those prints go to STDOUT with no `file=sys.stderr`
    (`cmd_clippy`'s `print(f"[crucible] cargo clippy exit=...")`,
    `_clippy_workspace_gate`'s `print(f"[crucible:clippy-gate] running: ...")`,
    `_regression_ingest_run`'s `print(f"[crucible] cleaned: ...")` /
    `print(f"[crucible] llvm-cov nextest exit=...")`, `cmd_smoke_test`'s
    `print(f"[smoke-test] ...")` lines, `cmd_docker_up`/`down`'s
    `print(f"[docker] ...")` lines -- confirmed by reading every one)."""

    def _drive(self, verb_name, extra_argv=None):
        return _drive_with_bin_dir("rust", verb_name, _build_fake_bin_dir,
                                   extra_argv=extra_argv)

    def test_clippy_emits_envelope_with_error_count(self):
        """§S1: 'clippy carries errors/warnings'. Asserts the unambiguous
        `errors` count only -- `emit_axi` unconditionally overwrites
        `axi["warnings"]` with the STRUCTURED warnings LIST (read directly:
        `axi.update(result_fields); axi["warnings"] = warnings`), so a
        result field literally named `warnings` would collide with and be
        clobbered by that list; the exact key GREEN picks for the lint
        WARNING count is left open rather than guessed here."""
        emits, axi, result = self._drive("clippy")
        self._assert_full_envelope("rust", "clippy", emits, axi, result,
                                   required_fields=("errors",))

    def test_workspace_clippy_emits_envelope_with_error_count(self):
        emits, axi, result = self._drive("workspace-clippy")
        self._assert_full_envelope("rust", "workspace-clippy", emits, axi, result,
                                   required_fields=("errors",))

    def test_docker_up_emits_envelope_with_action_and_outcome(self):
        """§S1: 'docker verbs carry the compose action and its outcome'."""
        emits, axi, result = self._drive("docker-up")
        self._assert_full_envelope("rust", "docker-up", emits, axi, result,
                                   required_fields=("action", "exit"))
        self.assertEqual(axi.get("action"), "up",
                         "rust/docker-up: action field must name the compose action")

    def test_docker_down_emits_envelope_with_action_and_outcome(self):
        emits, axi, result = self._drive("docker-down")
        self._assert_full_envelope("rust", "docker-down", emits, axi, result,
                                   required_fields=("action", "exit"))
        self.assertEqual(axi.get("action"), "down",
                         "rust/docker-down: action field must name the compose action")

    def test_docker_e2e_gate_emits_envelope_with_run_block(self):
        """`cmd_docker_e2e_gate` is a thin wrapper over `cmd_smoke_test`
        (confirmed by reading it) -- same run: block shape."""
        emits, axi, result = self._drive("docker-e2e-gate")
        self._assert_full_envelope("rust", "docker-e2e-gate", emits, axi, result,
                                   required_fields=("run",))

    def test_regression_ingest_emits_envelope_with_exact_run_counts_and_files(self):
        """§S1: 'the two regression verbs carry their run: block (passed/
        failed/pending/total/files)'. The fixture's pre-seeded
        `target/nextest/ci/junit.xml` (`_JUNIT_ONE_PASS`, one passing
        testcase `classname="detector"`) is what the fake cargo tool ALSO
        (re)writes for a `nextest` invocation -- so the exact counts are
        deterministic, not a >=1 guess: passed=1, failed=0, pending=0,
        total=1, files=1 (one distinct classname)."""
        emits, axi, result = self._drive("regression-ingest")
        self._assert_full_envelope("rust", "regression-ingest", emits, axi, result,
                                   required_fields=("run",))
        run = axi.get("run", {})
        self.assertEqual(run.get("passed"), 1, f"run={run!r}")
        self.assertEqual(run.get("failed"), 0, f"run={run!r}")
        self.assertEqual(run.get("pending"), 0, f"run={run!r}")
        self.assertEqual(run.get("total"), 1, f"run={run!r}")
        self.assertEqual(run.get("files"), 1, f"run={run!r}")

    def test_workspace_regression_emits_envelope_with_exact_run_counts_and_files(self):
        emits, axi, result = self._drive("workspace-regression",
                                         extra_argv=["--min-free-g", "1"])
        self._assert_full_envelope("rust", "workspace-regression", emits, axi, result,
                                   required_fields=("run",))
        run = axi.get("run", {})
        self.assertEqual(run.get("passed"), 1, f"run={run!r}")
        self.assertEqual(run.get("failed"), 0, f"run={run!r}")
        self.assertEqual(run.get("pending"), 0, f"run={run!r}")
        self.assertEqual(run.get("total"), 1, f"run={run!r}")
        self.assertEqual(run.get("files"), 1, f"run={run!r}")

    def test_smoke_test_emits_envelope_with_run_block(self):
        """§S1 names only the two regression verbs for `files`; smoke-test's
        own run: block is asserted for passed/failed/pending/total only."""
        emits, axi, result = self._drive("smoke-test")
        self._assert_full_envelope("rust", "smoke-test", emits, axi, result,
                                   required_fields=("run",))
        run = axi.get("run", {})
        self.assertEqual(run.get("passed"), 1, f"run={run!r}")
        self.assertEqual(run.get("failed"), 0, f"run={run!r}")


# ── mvn's 7 toolchain-local verbs (pre-merge-gate gets its own class) ──────


class MvnEnvelopeLessVerbContractTest(_EnvelopeContractMixin, unittest.TestCase):
    """§S1 -- mvn's own toolchain-local gaps. `unit`/`module`/`compile`/`e2e`
    each reach only a plain-print ingest helper (`_run_surefire_tier` /
    `_ingest_compile`), never `_emit_axi`, confirmed by reading every one;
    `docker-up`/`docker-down` mirror rust's docker verbs exactly (same
    plain `print(f"[docker] ...")` shape); `regression` DOES reach
    `_emit_ingest_summary_axi` but is stdout-polluted (§S3, its own test
    below)."""

    def _drive(self, verb_name, extra_argv=None):
        return _drive_with_bin_dir("mvn", verb_name, _build_fake_bin_dir,
                                   extra_argv=extra_argv)

    def test_compile_emits_envelope_without_raw_build_output_on_stdout(self):
        """§S3 -- the STRONGEST purity violation in scope: `cmd_compile`
        does `sys.stdout.write(output)` (the raw captured mvn stdout+stderr,
        confirmed by reading it) BEFORE any future envelope would be
        written -- not just an errant `[compile] ...` line, the entire
        captured build log. The fake mvn tool used here writes zero
        stdout/stderr, so today's stdout is empty; once GREEN adds the
        envelope, this raw dump must move to stderr for the purity check
        below to hold."""
        emits, axi, result = self._drive("compile")
        self._assert_full_envelope("mvn", "compile", emits, axi, result)

    def test_docker_up_emits_envelope_with_action_and_outcome(self):
        emits, axi, result = self._drive("docker-up")
        self._assert_full_envelope("mvn", "docker-up", emits, axi, result,
                                   required_fields=("action", "exit"))
        self.assertEqual(axi.get("action"), "up")

    def test_docker_down_emits_envelope_with_action_and_outcome(self):
        emits, axi, result = self._drive("docker-down")
        self._assert_full_envelope("mvn", "docker-down", emits, axi, result,
                                   required_fields=("action", "exit"))
        self.assertEqual(axi.get("action"), "down")

    def test_e2e_emits_envelope_with_run_block(self):
        emits, axi, result = self._drive("e2e")
        self._assert_full_envelope("mvn", "e2e", emits, axi, result,
                                   required_fields=("run",))

    def test_module_emits_envelope_with_run_block(self):
        emits, axi, result = self._drive("module")
        self._assert_full_envelope("mvn", "module", emits, axi, result,
                                   required_fields=("run",))

    def test_unit_emits_envelope_with_run_block(self):
        emits, axi, result = self._drive("unit")
        self._assert_full_envelope("mvn", "unit", emits, axi, result,
                                   required_fields=("run",))

    def test_regression_emits_envelope_with_no_prose_line_preceding_it(self):
        """§S0b's own named finding, now asserted as the FIX target: mvn's
        `_regression_run` already calls `_emit_ingest_summary_axi` (reaches
        the emitter), but `print(f"[regression] running: {{...}}")` (no
        `file=sys.stderr`, confirmed by reading it) writes to stdout FIRST,
        so today's stdout is prose-then-envelope, never a clean single
        document. `classify_envelope`/`_assert_full_envelope`'s strict
        single-document decode must succeed once that print moves to
        stderr -- it fails today exactly because it doesn't."""
        emits, axi, result = self._drive("regression")
        self._assert_full_envelope("mvn", "regression", emits, axi, result,
                                   required_fields=("run",))
        self.assertNotIn(
            "[regression] running:", result.stdout,
            "mvn/regression: the unguarded '[regression] running: ...' "
            "print must no longer land on stdout")


# ── pre-merge-gate: its own explicit, loudly-named class in all 5 clients ──


class PreMergeGateEnvelopeContractTest(_EnvelopeContractMixin, unittest.TestCase):
    """§S1/§S0b's headline concern, byline-named per the dispatch brief:
    `pre-merge-gate` is bare in ALL FIVE clients -- the orchestrator's own
    merge-decision path emits no envelope anywhere today. One test per
    client, by name, never folded into a loop."""

    def test_pre_merge_gate_emits_envelope_in_rust(self):
        emits, axi, result = _drive_with_bin_dir(
            "rust", "pre-merge-gate", _build_fake_bin_dir,
            extra_argv=["--min-free-g", "1"])
        self._assert_full_envelope("rust", "pre-merge-gate", emits, axi, result)

    def test_pre_merge_gate_emits_envelope_in_mvn(self):
        emits, axi, result = _drive_with_bin_dir(
            "mvn", "pre-merge-gate", _build_fake_bin_dir)
        self._assert_full_envelope("mvn", "pre-merge-gate", emits, axi, result)

    def test_pre_merge_gate_emits_envelope_in_bun(self):
        emits, axi, result = _drive_with_bin_dir(
            "bun", "pre-merge-gate", _build_fake_bin_dir)
        self._assert_full_envelope("bun", "pre-merge-gate", emits, axi, result)

    def test_pre_merge_gate_emits_envelope_in_python(self):
        emits, axi, result = _drive_with_bin_dir(
            "python", "pre-merge-gate", _build_fake_bin_dir)
        self._assert_full_envelope("python", "pre-merge-gate", emits, axi, result)

    def test_pre_merge_gate_emits_envelope_in_arduino(self):
        emits, axi, result = _drive_with_bin_dir(
            "arduino", "pre-merge-gate", _build_fake_bin_dir)
        self._assert_full_envelope("arduino", "pre-merge-gate", emits, axi, result)


# ── §S2 -- help[] must be STATE-DERIVED for the gate verbs ─────────────────


class PreMergeGateStateDerivedHelpTest(unittest.TestCase):
    """CR-CRU-048's rule, pinned per the CR's own AC: 'a failing and a
    passing run of the same verb produce DIFFERENT next-step text'. Applied
    to `pre-merge-gate` in all five clients (the CR's named headline verb)
    plus rust's sibling gate verb `workspace-regression` (the Risk section's
    other named 'live gate path') -- six pairs total. See the module
    docstring for why each pair's two states are chosen the way they are
    (a real local fail-fast/disk-guard branch, never a network-outcome coin
    flip -- this harness never reaches a live server by design)."""

    def _assert_help_differs(self, client_key, verb_name, fail_drive, pass_drive):
        fail_emits, fail_axi, fail_result = fail_drive()
        pass_emits, pass_axi, pass_result = pass_drive()
        self.assertTrue(
            fail_emits,
            f"{client_key}/{verb_name} (failing run): must produce a "
            f"decodable axi: envelope; got stdout={fail_result.stdout!r} "
            f"stderr={fail_result.stderr!r}")
        self.assertTrue(
            pass_emits,
            f"{client_key}/{verb_name} (passing run): must produce a "
            f"decodable axi: envelope; got stdout={pass_result.stdout!r} "
            f"stderr={pass_result.stderr!r}")
        fail_help = fail_axi.get("help")
        pass_help = pass_axi.get("help")
        self.assertTrue(fail_help, f"{client_key}/{verb_name}: failing run's help[] must be non-empty")
        self.assertTrue(pass_help, f"{client_key}/{verb_name}: passing run's help[] must be non-empty")
        self.assertNotEqual(
            fail_help, pass_help,
            f"{client_key}/{verb_name}: help[] must be STATE-DERIVED (§S2) "
            f"-- a failing and a passing run produced the SAME canned "
            f"next-step text: {fail_help!r}")

    def test_rust_pre_merge_gate_help_differs_between_clippy_failure_and_pass(self):
        self._assert_help_differs(
            "rust", "pre-merge-gate",
            fail_drive=lambda: _drive_with_bin_dir(
                "rust", "pre-merge-gate",
                lambda: _build_bin_dir_with_override("cargo", _FAIL_CARGO_CLIPPY_BODY),
                extra_argv=["--min-free-g", "1"]),
            pass_drive=lambda: _drive_with_bin_dir(
                "rust", "pre-merge-gate", _build_fake_bin_dir,
                extra_argv=["--min-free-g", "1"]))

    def test_rust_workspace_regression_help_differs_between_disk_guard_abort_and_normal_run(self):
        self._assert_help_differs(
            "rust", "workspace-regression",
            fail_drive=lambda: _drive_with_bin_dir(
                "rust", "workspace-regression", _build_fake_bin_dir,
                extra_argv=["--min-free-g", "999999999"]),
            pass_drive=lambda: _drive_with_bin_dir(
                "rust", "workspace-regression", _build_fake_bin_dir,
                extra_argv=["--min-free-g", "1"]))

    def test_mvn_pre_merge_gate_help_differs_between_docker_up_failure_and_pass(self):
        self._assert_help_differs(
            "mvn", "pre-merge-gate",
            fail_drive=lambda: _drive_with_bin_dir(
                "mvn", "pre-merge-gate",
                lambda: _build_bin_dir_with_override("docker", _FAIL_DOCKER_UP_BODY)),
            pass_drive=lambda: _drive_with_bin_dir(
                "mvn", "pre-merge-gate", _build_fake_bin_dir))

    def test_bun_pre_merge_gate_help_differs_between_tsc_failure_and_pass(self):
        self._assert_help_differs(
            "bun", "pre-merge-gate",
            fail_drive=lambda: _drive_with_bin_dir(
                "bun", "pre-merge-gate",
                lambda: _build_bin_dir_with_override("bun", _FAIL_BUN_TSC_BODY)),
            pass_drive=lambda: _drive_with_bin_dir(
                "bun", "pre-merge-gate", _build_fake_bin_dir))

    def test_python_pre_merge_gate_help_differs_between_py_compile_failure_and_pass(self):
        self._assert_help_differs(
            "python", "pre-merge-gate",
            fail_drive=lambda: _drive_with_bin_dir(
                "python", "pre-merge-gate", _build_fake_bin_dir,
                project_dir_factory=_python_project_dir_with_syntax_error),
            pass_drive=lambda: _drive_with_bin_dir(
                "python", "pre-merge-gate", _build_fake_bin_dir))

    def test_arduino_pre_merge_gate_help_differs_between_compile_failure_and_pass(self):
        self._assert_help_differs(
            "arduino", "pre-merge-gate",
            fail_drive=lambda: _drive_with_bin_dir(
                "arduino", "pre-merge-gate",
                lambda: _build_bin_dir_with_override("arduino-cli", _FAIL_ARDUINO_CLI_BODY)),
            pass_drive=lambda: _drive_with_bin_dir(
                "arduino", "pre-merge-gate", _build_fake_bin_dir))


if __name__ == "__main__":
    unittest.main()
