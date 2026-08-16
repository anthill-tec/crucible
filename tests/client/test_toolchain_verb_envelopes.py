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
        (confirmed by reading it) -- same run: block shape.

        CR-CRU-064 §S6 -- driven with an explicit `--min-free-g 1`, matching
        its `workspace-regression`/`pre-merge-gate` siblings, so this test's
        pass no longer depends on how much free disk THIS box happens to
        have. Undriven, it inherits `rust-crucible.py:2180`'s 80 GB default
        floor (guard at `:1331`/`cmd_docker_e2e_gate`'s `cmd_smoke_test`
        wrapper at `:1327`) and failed on CI run 31677479804 with
        `disk-guard-abort`; it passed here only because this box measures
        486 GB free (measured, not assumed) -- an ambient pass a naive 'it
        passes' assertion could not tell apart from a real one, which is
        why the argv and the absent warning code are pinned explicitly
        below rather than trusted implicitly."""
        emits, axi, result = self._drive("docker-e2e-gate",
                                         extra_argv=["--min-free-g", "1"])
        self._assert_full_envelope("rust", "docker-e2e-gate", emits, axi, result,
                                   required_fields=("run",))
        self.assertIn(
            "--min-free-g", result.args,
            f"rust/docker-e2e-gate: §S6 -- the drive must pin the disk-guard "
            f"floor explicitly rather than inherit the 80 GB default; got "
            f"argv={result.args!r}")
        min_free_g_idx = result.args.index("--min-free-g")
        self.assertEqual(
            result.args[min_free_g_idx + 1], "1",
            f"rust/docker-e2e-gate: §S6 -- --min-free-g must be pinned to "
            f"1, matching workspace-regression/pre-merge-gate; got "
            f"argv={result.args!r}")
        warning_codes = {w.get("code") for w in (axi.get("warnings") or [])
                         if isinstance(w, dict)}
        self.assertNotIn(
            "disk-guard-abort", warning_codes,
            f"rust/docker-e2e-gate: AC8 -- an explicit low --min-free-g "
            f"floor must not trip the disk guard; got "
            f"warnings={axi.get('warnings')!r}")

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


# ── CR-CRU-064 C2 RED -- the seven no-report fallbacks must emit ────────────
#
# CR-CRU-064 §S2-§S4. The seven branches below are the fleet's LAST bare
# exits: a run whose toolchain cannot produce a report today returns an exit
# code with COMPLETELY EMPTY stdout (measured on this branch before writing
# these tests -- every drive below printed 0 bytes to stdout), so the agent
# consuming that stdout gets nothing it can parse. Two of them are the
# `pre-merge-gate` regression body (python `_regression_run`, bun
# `cmd_regression`), i.e. the silence happens at a MERGE DECISION point.
#
# HOW EACH SITE IS STARVED (real runners, never a hand-built envelope, never
# an in-process call -- the CR's own Risk section forbids both):
#
#   python (3 sites): `--python starved-python`, a chmod +x shim placed in
#     the SAME fake bin dir the census already builds, which re-execs the
#     real interpreter with `-S -E`. site-packages is then not on sys.path at
#     all, so `python -m xmlrunner` (and `-m coverage`, which the GATE wraps
#     it in) die with the genuine `No module named ...` message and write no
#     `TEST-*.xml`. `-S` -- not `-s` -- is deliberate: it starves the module
#     wherever it is installed (user site OR system site), so the fixture is
#     deterministic on a dev box AND on a CI runner that pip-installed
#     `unittest-xml-reporting` system-wide. `auto-ingest` needs no shim at
#     all: it runs no toolchain, and the census's project fixture has no
#     reports dir, which IS its no-report state.
#   bun (2 sites): a `bun` override that exits 3 -- NOT 1 -- for a `bun test`
#     invocation while still succeeding for `bun x tsc --noEmit`, so the
#     gate's fail-fast check passes and the regression step is genuinely
#     reached. The 3 is the point: the process exit stays 1, so a detail that
#     names the RUNNER's code cannot be faked by echoing the return value.
#   arduino (2 sites): a `make` override that exits 2 writing no
#     `reports/TEST-*.xml` (same runner-vs-process code discrimination), and
#     `auto-ingest` against the fixture's empty reports dir.
#
# Both fake-runner bodies write their whole output to STDERR ending on the
# cause line, so the "last non-empty line of the capture" is the cause under
# either concatenation order a call site might use.
#
# MEASURED PRE-CR EXIT CODES (AC5's guard -- an envelope that flips a
# non-zero exit to 0 makes a starved gate look GREEN): all ten drives below
# exit 1 today. python's sites return `result.returncode or 1` and the
# starved interpreter's module-not-found exit IS 1; bun `cmd_regression` and
# both arduino `sys.exit(<message>)` sites are hard-coded 1; bun `cmd_test`
# returns its compile ingest's result, which is 1 against this harness's
# deliberately unreachable server.

_STARVED_PYTHON_NAME = "starved-python"

_STARVED_PYTHON_BODY = r'''#!/usr/bin/env python3
import os
import sys

# A REAL interpreter that genuinely cannot produce a JUnit report: `-S`
# drops site-packages from sys.path entirely and `-E` drops PYTHONPATH, so
# `-m xmlrunner` / `-m coverage` raise the interpreter's own
# "No module named ..." and exit non-zero. No fake xmlrunner package, no
# stubbed subprocess -- the starved first-run state CR-CRU-063 measured.
os.execv(sys.executable, [sys.executable, "-S", "-E"] + sys.argv[1:])
'''

_FAIL_BUN_NO_JUNIT_BODY = r'''#!/usr/bin/env python3
import sys
argv = sys.argv[1:]
if argv[:1] == ["test"]:
    # Collection dies before the JUnit reporter writes anything -- the real
    # shape of a starved bun run. Exit 3, so a `detail` naming the RUNNER's
    # code cannot be satisfied by the process's own exit (1).
    sys.stderr.write("error: Cannot find module 'node:nonexistent' from "
                     "'/detector/pkg/index.test.ts'\n")
    sys.exit(3)
# `bun x tsc --noEmit` and every other invocation still succeeds, so
# pre-merge-gate's fail-fast check passes and the regression step is reached.
sys.exit(0)
'''

_FAIL_MAKE_NO_REPORTS_BODY = r'''#!/usr/bin/env python3
import sys
# `make junit` dies in the compiler: no reports/TEST-*.xml is written. Both
# lines go to stderr, cause LAST, so the capture's last non-empty line is the
# cause under either stdout/stderr concatenation order. Exit 2 vs the site's
# own exit 1: same runner-vs-process discrimination as the bun body.
sys.stderr.write(
    "g++ -std=c++17 -o build/suite tests/native/suite.cpp\n"
    "tests/native/suite.cpp:7:10: fatal error: unity.h: No such file or "
    "directory\n")
sys.exit(2)
'''

# `_resolve_python` (read directly) returns `--python`'s value VERBATIM and
# the client then execs it, so a bare name resolves off PATH -- the same
# fake-tool-on-PATH idiom as every other fixture in this file.
_STARVED_PYTHON_ARGV = ("--python", _STARVED_PYTHON_NAME)

_EMPTY_START_DIR = "no_tests_here"

NO_REPORT_WARNING_CODE = "no-test-reports"
ZERO_DISCOVERY_WARNING_CODE = "no-tests-discovered"


def _starved_python_bin_dir():
    """The census's proven bin dir plus the starved interpreter. `_FAKE_TOOLS`
    holds no `python` entry, so this ADDS a tool rather than replacing one --
    every other stubbed tool stays byte-identical."""
    return _build_bin_dir_with_override(_STARVED_PYTHON_NAME, _STARVED_PYTHON_BODY)


def _fail_bun_bin_dir():
    return _build_bin_dir_with_override("bun", _FAIL_BUN_NO_JUNIT_BODY)


def _fail_make_bin_dir():
    return _build_bin_dir_with_override("make", _FAIL_MAKE_NO_REPORTS_BODY)


def _python_project_dir_with_empty_start_dir():
    """The census's python fixture plus an EMPTY package-less dir, so a
    HEALTHY interpreter's `xmlrunner discover -s <dir>` collects zero tests
    ("Ran 0 tests", no traceback) -- `_is_zero_discovery`'s own definition of
    an honest empty discovery, driven with the real xmlrunner, never the
    starved shim (AC7 needs the OTHER branch)."""
    project_dir = _make_project_dir("python")
    (project_dir / _EMPTY_START_DIR).mkdir()
    return project_dir


_NO_REPORT_SITE_DRIVES = {
    # §S2 -- python's three sites.
    "python/test": lambda: _drive_with_bin_dir(
        "python", "test", _starved_python_bin_dir,
        extra_argv=_STARVED_PYTHON_ARGV),
    "python/regression": lambda: _drive_with_bin_dir(
        "python", "regression", _starved_python_bin_dir,
        extra_argv=_STARVED_PYTHON_ARGV),
    "python/pre-merge-gate": lambda: _drive_with_bin_dir(
        "python", "pre-merge-gate", _starved_python_bin_dir,
        extra_argv=_STARVED_PYTHON_ARGV),
    "python/auto-ingest": lambda: _drive_with_bin_dir(
        "python", "auto-ingest", _build_fake_bin_dir),
    # §S3 -- bun's two sites.
    "bun/test": lambda: _drive_with_bin_dir("bun", "test", _fail_bun_bin_dir),
    "bun/regression": lambda: _drive_with_bin_dir(
        "bun", "regression", _fail_bun_bin_dir),
    "bun/pre-merge-gate": lambda: _drive_with_bin_dir(
        "bun", "pre-merge-gate", _fail_bun_bin_dir),
    # §S4 -- arduino's two sites.
    "arduino/test": lambda: _drive_with_bin_dir(
        "arduino", "test", _fail_make_bin_dir),
    "arduino/pre-merge-gate": lambda: _drive_with_bin_dir(
        "arduino", "pre-merge-gate", _fail_make_bin_dir),
    "arduino/auto-ingest": lambda: _drive_with_bin_dir(
        "arduino", "auto-ingest", _build_fake_bin_dir),
    # AC7's other branch -- a HEALTHY runner that collects zero tests.
    "python/zero-discovery": lambda: _drive_with_bin_dir(
        "python", "regression", _build_fake_bin_dir,
        project_dir_factory=_python_project_dir_with_empty_start_dir,
        extra_argv=("--start-dir", _EMPTY_START_DIR)),
}

_STARVED_DRIVE_CACHE = {}


def _starved_drive(site_key):
    """One real subprocess drive per SITE, cached at module scope for this
    process (the census's own `_get_census` idiom): the several independent
    property assertions per site share one drive instead of re-spawning the
    client for each."""
    if site_key not in _STARVED_DRIVE_CACHE:
        _STARVED_DRIVE_CACHE[site_key] = _NO_REPORT_SITE_DRIVES[site_key]()
    return _STARVED_DRIVE_CACHE[site_key]


class _NoReportSiteContractMixin(_EnvelopeContractMixin):
    """One §S2-§S4 site's contract, asserted property by property so a
    partial GREEN is visible: the envelope itself (AC4), stdout purity and
    the pinned pre-CR exit code (AC5), `help[]`'s terminal `"status"` (AC1),
    and the single `no-test-reports` warning whose detail names the RUNNER's
    exit code (AC2/AC4)."""

    SITE = None            # `_NO_REPORT_SITE_DRIVES` key
    CLIENT = None
    VERB = None
    ARTIFACT = None        # the stack's own wording, per §S1's `artifact` arg
    RUNNER_EXIT = None     # the code the RUNNER exited with
    MEASURED_EXIT = 1      # today's process exit, measured before this RED

    @classmethod
    def setUpClass(cls):
        cls.emits, cls.axi, cls.result = _starved_drive(cls.SITE)

    def _envelope(self):
        self.assertTrue(
            self.emits,
            f"{self.CLIENT}/{self.VERB} ({self.SITE}): AC4 -- a run that "
            f"produced no {self.ARTIFACT} must put exactly ONE decodable "
            f"axi: document on stdout; got stdout={self.result.stdout!r}")
        return self.axi

    def _detail(self):
        axi = self._envelope()
        warnings = axi.get("warnings") or []
        matches = [w for w in warnings
                   if isinstance(w, dict) and w.get("code") == NO_REPORT_WARNING_CODE]
        self.assertEqual(
            len(matches), 1,
            f"{self.CLIENT}/{self.VERB}: AC4 -- exactly ONE "
            f"{NO_REPORT_WARNING_CODE!r} warning, got warnings={warnings!r}")
        return matches[0].get("detail") or ""

    def test_stdout_is_exactly_one_no_report_envelope(self):
        axi = self._envelope()
        self._assert_full_envelope(self.CLIENT, self.VERB, self.emits, axi,
                                   self.result)
        heads = [line for line in self.result.stdout.splitlines()
                 if line.startswith("axi:")]
        self.assertEqual(
            len(heads), 1,
            f"{self.CLIENT}/{self.VERB}: §S3/AC5 -- stdout must carry ONE "
            f"document, not {len(heads)}; got {self.result.stdout!r}")
        self.assertIs(
            axi.get("ok"), False,
            f"{self.CLIENT}/{self.VERB}: AC4 -- a run that produced no "
            f"{self.ARTIFACT} is ok:false, got ok={axi.get('ok')!r}")

    def test_help_last_step_is_status(self):
        axi = self._envelope()
        help_steps = axi.get("help") or []
        self.assertEqual(
            help_steps[-1] if help_steps else None, "status",
            f"{self.CLIENT}/{self.VERB}: AC1 -- help[]'s final element is "
            f"'status', as every help[] in the fleet is; got {help_steps!r}")

    def test_exactly_one_no_test_reports_warning_naming_the_artifact(self):
        detail = self._detail()
        self.assertIn(
            self.ARTIFACT, detail,
            f"{self.CLIENT}/{self.VERB}: AC2 -- the detail names this "
            f"stack's own artifact wording {self.ARTIFACT!r}; got {detail!r}")
        self.assertIn(
            self.VERB, detail,
            f"{self.CLIENT}/{self.VERB}: AC2 -- the detail names the verb; "
            f"got {detail!r}")

    def test_detail_names_the_runner_exit_code(self):
        detail = self._detail()
        self.assertRegex(
            detail, rf"\b{self.RUNNER_EXIT}\b",
            f"{self.CLIENT}/{self.VERB}: AC2 -- the detail names the "
            f"RUNNER's exit code ({self.RUNNER_EXIT}), which is the only "
            f"code the consumer can act on; got {detail!r}")

    def test_gains_the_envelope_without_changing_the_exit_code(self):
        # AC4+AC5 as ONE contract, deliberately: on its own the exit-code
        # assertion is a NO-CHANGE pin (it holds today by construction and
        # could never be RED), so it is asserted alongside the envelope it
        # must not cost. After GREEN this test still fails if the emit path
        # flips a non-zero exit to 0.
        self._envelope()
        self.assertEqual(
            self.result.returncode, self.MEASURED_EXIT,
            f"{self.CLIENT}/{self.VERB}: AC5 -- the exit code must stay "
            f"byte-identical to the pre-CR behaviour ({self.MEASURED_EXIT}, "
            f"measured on this branch); an envelope that flips a non-zero "
            f"exit to 0 makes a starved gate look GREEN")


class _CapturedCauseMixin:
    """§S2/§S3/§S4 sites that HAVE a runner capture (python
    `cmd_test`/`_regression_run`: `result.stdout`; bun: `result.stdout`;
    arduino `_run_native_tests_body`: `run.stdout`/`run.stderr`) -- AC2's
    cause line must survive into the detail rather than being dropped on the
    floor as it is today."""

    CAUSE_FRAGMENT = None

    def test_detail_carries_the_captured_cause_line(self):
        detail = self._detail()
        self.assertIn(
            self.CAUSE_FRAGMENT, detail,
            f"{self.CLIENT}/{self.VERB}: AC2 -- the runner's own cause line "
            f"({self.CAUSE_FRAGMENT!r}) is captured at this site and must "
            f"reach the consumer through the detail; got {detail!r}")


class _BlankCaptureMixin:
    """Sites with NO runner at all (`auto-ingest` in python and arduino:
    they ingest a pre-existing reports dir and shell out to nothing), so
    AC2's cause half is unattainable BY CONSTRUCTION. The contract there is
    the helper's blank-capture form: a non-empty, exit-code-naming detail
    (`/api/v2/runs/compile` 400s on an empty string) that invents no cause
    line it never had."""

    def test_detail_uses_the_blank_capture_form(self):
        detail = self._detail()
        self.assertTrue(
            detail.strip(),
            f"{self.CLIENT}/{self.VERB}: AC2 -- a capture-less site still "
            f"needs a NON-EMPTY detail; got {detail!r}")
        self.assertNotIn(
            "last output line", detail,
            f"{self.CLIENT}/{self.VERB}: AC2 -- this site captures no runner "
            f"output (it runs no runner), so the detail must take the "
            f"blank-capture form and fabricate no cause line; got "
            f"{detail!r}")


# ── §S2 -- python's three sites ─────────────────────────────────────────────


class PythonTestNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                     _CapturedCauseMixin, unittest.TestCase):
    """§S2 site 1 -- `cmd_test`'s no-XML branch (`_ingest_compile(...,
    tier="unit")` then `return result.returncode or 1`): the compile ingest
    stays, the envelope is what is missing."""

    SITE = "python/test"
    CLIENT = "python"
    VERB = "test"
    ARTIFACT = "TEST-*.xml"
    RUNNER_EXIT = 1
    MEASURED_EXIT = 1
    CAUSE_FRAGMENT = "No module named xmlrunner"


class PythonRegressionNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                           _CapturedCauseMixin,
                                           unittest.TestCase):
    """§S2 site 2 -- `_regression_run`'s non-zero-discovery no-XML branch,
    driven under its plain `regression` verb."""

    SITE = "python/regression"
    CLIENT = "python"
    VERB = "regression"
    ARTIFACT = "TEST-*.xml"
    RUNNER_EXIT = 1
    MEASURED_EXIT = 1
    CAUSE_FRAGMENT = "No module named xmlrunner"


class PythonPreMergeGateNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                             _CapturedCauseMixin,
                                             unittest.TestCase):
    """§S2 site 2 again, reached as the GATE's regression step (AC6). The
    cause names `coverage`, not `xmlrunner`, because the gate wraps the
    runner in `coverage run` and the starved interpreter has neither -- the
    coverage module is the first import that fails, and it is the genuine
    measured cause line at this site."""

    SITE = "python/pre-merge-gate"
    CLIENT = "python"
    VERB = "pre-merge-gate"
    ARTIFACT = "TEST-*.xml"
    RUNNER_EXIT = 1
    MEASURED_EXIT = 1
    CAUSE_FRAGMENT = "No module named coverage"


class PythonAutoIngestNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                           _BlankCaptureMixin,
                                           unittest.TestCase):
    """§S2 site 3 -- `cmd_auto_ingest`'s `no TEST-*.xml in <dir> — nothing to
    ingest` stderr line + bare `return 1`."""

    SITE = "python/auto-ingest"
    CLIENT = "python"
    VERB = "auto-ingest"
    ARTIFACT = "TEST-*.xml"
    RUNNER_EXIT = 1
    MEASURED_EXIT = 1


# ── §S3 -- bun's two sites ──────────────────────────────────────────────────


class BunTestNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                  _CapturedCauseMixin, unittest.TestCase):
    """§S3 site 1 -- `cmd_test`'s no-XML branch. Its synthetic `TS0000`
    compile ingest keeps its behaviour; the envelope is additive. The exit
    code is that ingest's result -- 1 against this harness's unreachable
    server -- and AC5 pins it."""

    SITE = "bun/test"
    CLIENT = "bun"
    VERB = "test"
    ARTIFACT = "junit.xml"
    RUNNER_EXIT = 3
    MEASURED_EXIT = 1
    CAUSE_FRAGMENT = "Cannot find module 'node:nonexistent'"


class BunRegressionNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                        _CapturedCauseMixin,
                                        unittest.TestCase):
    """§S3 site 2 -- `cmd_regression`'s `no JUnit XML produced — nothing to
    ingest` stderr line + bare `return 1`, driven under its plain
    `regression` verb. The capture (`result.stdout`) exists here TODAY and is
    simply thrown away."""

    SITE = "bun/regression"
    CLIENT = "bun"
    VERB = "regression"
    ARTIFACT = "junit.xml"
    RUNNER_EXIT = 3
    MEASURED_EXIT = 1
    CAUSE_FRAGMENT = "Cannot find module 'node:nonexistent'"


class BunPreMergeGateNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                          _CapturedCauseMixin,
                                          unittest.TestCase):
    """§S3 site 2 reached as the GATE's regression step (AC6) -- the fake bun
    lets `bun x tsc --noEmit` pass, so the gate genuinely proceeds past its
    fail-fast step into the starved regression."""

    SITE = "bun/pre-merge-gate"
    CLIENT = "bun"
    VERB = "pre-merge-gate"
    ARTIFACT = "junit.xml"
    RUNNER_EXIT = 3
    MEASURED_EXIT = 1
    CAUSE_FRAGMENT = "Cannot find module 'node:nonexistent'"


# ── §S4 -- arduino's two `sys.exit(<message>)` sites ───────────────────────


class ArduinoNativeTestsNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                             _CapturedCauseMixin,
                                             unittest.TestCase):
    """§S4 site 1 -- `_run_native_tests_body`'s `sys.exit("[crucible] no
    JUnit (reports/TEST-*.xml) under <dir>")`. `sys.exit(<message>)` writes
    to stderr and exits 1; the replacement emits and RETURNS 1 through
    dispatch, so stderr and the exit code are preserved. The `make junit`
    capture (`capture_output=True`) exists here, so AC2's cause applies."""

    SITE = "arduino/test"
    CLIENT = "arduino"
    VERB = "test"
    ARTIFACT = "TEST-*.xml"
    RUNNER_EXIT = 2
    MEASURED_EXIT = 1
    CAUSE_FRAGMENT = "unity.h: No such file or directory"


class ArduinoPreMergeGateNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                              _CapturedCauseMixin,
                                              unittest.TestCase):
    """§S4 site 1 reached through the gate -- `_run_native_tests_body` is the
    shared workhorse behind arduino's test AND regression verbs, so §S4
    requires its envelope to carry the CALLER's verb."""

    SITE = "arduino/pre-merge-gate"
    CLIENT = "arduino"
    VERB = "pre-merge-gate"
    ARTIFACT = "TEST-*.xml"
    RUNNER_EXIT = 2
    MEASURED_EXIT = 1
    CAUSE_FRAGMENT = "unity.h: No such file or directory"


class ArduinoAutoIngestNoReportEnvelopeTest(_NoReportSiteContractMixin,
                                            _BlankCaptureMixin,
                                            unittest.TestCase):
    """§S4 site 2 -- `cmd_auto_ingest`'s `sys.exit("[crucible] no JUnit
    (TEST-*.xml) under <dir> — nothing to ingest")`. No runner, so the
    blank-capture form is the contract."""

    SITE = "arduino/auto-ingest"
    CLIENT = "arduino"
    VERB = "auto-ingest"
    ARTIFACT = "TEST-*.xml"
    RUNNER_EXIT = 1
    MEASURED_EXIT = 1


# ── AC6 -- a starved GATE must speak as the gate, never as `regression` ────


class PreMergeGateNoReportCarriesTheGateVerbTest(unittest.TestCase):
    """AC6, byline-named because it is the CR's headline concern: the verb an
    orchestrator reads to decide a merge is exactly the verb that goes silent
    when the toolchain is missing. `verb` is threaded into these regression
    bodies (CR-CRU-058 §S1) precisely so the document carries the GATE's
    name, and the no-report branch must honour that thread rather than
    falling back to the literal `"regression"`."""

    def _assert_gate_verb(self, client_key, site_key):
        emits, axi, result = _starved_drive(site_key)
        self.assertTrue(
            emits,
            f"{client_key}: AC6 -- a pre-merge-gate whose regression step "
            f"produced no report must still emit a document; got "
            f"stdout={result.stdout!r}")
        self.assertEqual(
            axi.get("verb"), "pre-merge-gate",
            f"{client_key}: AC6 -- the starved gate's document must carry "
            f"verb 'pre-merge-gate', NEVER the inner 'regression'; got "
            f"{axi.get('verb')!r}")

    def test_python_starved_pre_merge_gate_emits_under_the_gate_verb(self):
        self._assert_gate_verb("python", "python/pre-merge-gate")

    def test_bun_starved_pre_merge_gate_emits_under_the_gate_verb(self):
        self._assert_gate_verb("bun", "bun/pre-merge-gate")

    def test_arduino_starved_pre_merge_gate_emits_under_the_gate_verb(self):
        # §S4's explicit requirement for the shared `_run_native_tests_body`.
        self._assert_gate_verb("arduino", "arduino/pre-merge-gate")


# ── AC7 -- zero discovery and no report stay distinguishable ───────────────


class ZeroDiscoveryVsNoReportWarningCodeTest(unittest.TestCase):
    """AC7 -- `python-crucible.py`'s already-compliant `no-tests-discovered`
    branch is NOT touched by §S2, and the two conditions must stay
    distinguishable by `warnings[].code` ALONE: an empty discovery is a
    definitive configuration error (fix `--start-dir`/`--pattern`), while a
    no-report run is a starved toolchain (read the runner's output). Both
    halves are asserted in ONE test because the contract is the CONTRAST --
    the codes on their own must be enough to tell the two apart."""

    def _codes(self, site_key, label):
        emits, axi, result = _starved_drive(site_key)
        self.assertTrue(
            emits,
            f"AC7 ({label}): needs a decodable envelope to compare warning "
            f"codes at all; got stdout={result.stdout!r} "
            f"stderr={result.stderr[-400:]!r}")
        return {w.get("code") for w in (axi.get("warnings") or [])
                if isinstance(w, dict)}

    def test_zero_discovery_and_no_report_differ_by_warning_code_alone(self):
        zero_codes = self._codes("python/zero-discovery", "zero discovery")
        no_report_codes = self._codes("python/regression", "no report")
        self.assertIn(
            ZERO_DISCOVERY_WARNING_CODE, zero_codes,
            f"AC7 -- the untouched zero-discovery branch must keep its OWN "
            f"code; got {zero_codes!r}")
        self.assertIn(
            NO_REPORT_WARNING_CODE, no_report_codes,
            f"AC7 -- a starved run must carry {NO_REPORT_WARNING_CODE!r}; "
            f"got {no_report_codes!r}")
        self.assertEqual(
            zero_codes & no_report_codes, set(),
            f"AC7 -- the two conditions must share NO warning code, or a "
            f"consumer cannot tell a misconfigured discovery from a starved "
            f"toolchain: zero={zero_codes!r} no_report={no_report_codes!r}")


# ── CR-CRU-064 C3 RED -- mvn's no-report detail must carry the captured ────
# ── build-output cause, not just the verb/artifact/exit-code prefix ────────
#
# CR-CRU-064's Implementation notes (C1) measured this per site: rust's
# `regression-ingest` already threads a real captured cause through (full
# detail); rust's `smoke-test`/`workspace-regression` inherit their child's
# stderr (nothing captured, by design); but mvn's `_emit_compile_fallback_
# axi` (mvn-crucible.py:894) calls `no_report_warning(verb, "surefire
# reports", rc, "")` -- read directly at mvn-crucible.py:911 -- with a
# HARD-CODED empty `output` string, even though `_compile_fallback`
# (mvn-crucible.py:812) captures the real `mvn clean test-compile` build log
# via `subprocess.run(..., capture_output=True)` one frame down and returns
# ONLY `rc` to its caller. AC2 is explicit this is a gap, not parity: "AC2
# is not considered met at the mvn site until [the capture is threaded out
# of `_compile_fallback`]". C3 threads that capture out; this pins the end
# state.

_FAIL_MVN_COMPILE_BODY = r'''#!/usr/bin/env python3
import sys
argv = sys.argv[1:]
if "test-compile" in argv:
    # The compile fallback's OWN invocation (`mvn clean test-compile`,
    # captured by `_compile_fallback` via `capture_output=True`). This is
    # the genuine cause CR-CRU-064's C1 measurement found trapped one frame
    # down -- it must reach the emitted `detail`, not just get ingested and
    # discarded.
    sys.stdout.write(
        "[ERROR] COMPILATION ERROR : \n"
        "[ERROR] DetectorProbeTest.java:[7,10] cannot find symbol\n"
        "[ERROR]   symbol:   class MissingHelper\n"
    )
    sys.exit(1)
# `mvn clean test` -- writes NO surefire reports at all, the no-report
# state that triggers the compile fallback.
sys.exit(1)
'''


def _fail_mvn_compile_bin_dir():
    return _build_bin_dir_with_override("mvn", _FAIL_MVN_COMPILE_BODY)


class MvnCompileFallbackDetailCarriesCapturedCauseTest(unittest.TestCase):
    """CR-CRU-064 C1/C3 -- the one no-report site among the CR's measured
    sites where AC2 is NOT yet met. Driven as a genuine subprocess against a
    real starved `mvn` on PATH (never a hand-built envelope, never an
    in-process call -- the CR's own Risk section forbids both): the fake
    `mvn` writes no surefire reports for `mvn clean test` (triggering the
    compile fallback), then on the fallback's own `mvn clean test-compile`
    invocation writes a recognisable compile-error message and exits 1."""

    CAUSE_FRAGMENT = "cannot find symbol"

    def test_detail_carries_the_captured_build_output_not_just_the_prefix(self):
        emits, axi, result = _drive_with_bin_dir(
            "mvn", "unit", _fail_mvn_compile_bin_dir)
        self.assertTrue(
            emits,
            f"mvn/unit: must produce a decodable axi: envelope; got "
            f"stdout={result.stdout!r} stderr={result.stderr!r}")
        warnings = axi.get("warnings") or []
        matches = [w for w in warnings
                   if isinstance(w, dict) and w.get("code") == NO_REPORT_WARNING_CODE]
        self.assertEqual(
            len(matches), 1,
            f"mvn/unit: exactly ONE {NO_REPORT_WARNING_CODE!r} warning, "
            f"got warnings={warnings!r}")
        detail = matches[0].get("detail") or ""
        self.assertIn(
            self.CAUSE_FRAGMENT, detail,
            f"mvn/unit: AC2 -- the compile fallback's own captured build "
            f"output must reach the detail, not just the verb/artifact/"
            f"exit-code prefix; got detail={detail!r}")


if __name__ == "__main__":
    unittest.main()
